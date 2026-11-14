/**
 * IM 身份绑定的判据（src/bindings/im.ts + 迁移 0005）。
 *
 * ── 这一文件在证什么 ──────────────────────────────────────────────────
 * `im_bindings` 从 0001 建好起**读写方 0 处**（0028 §2 实测），而它带着
 * `ceo_role DEFAULT 'ceo'` + `verified DEFAULT 0` —— 一张「最小的一行就是一个 CEO」
 * 的表在等人接。本文件证的不是「我写了一个 CRUD」，是**那五条 DDL 判据真的生效**，
 * 因为整篇的设计是：**判据不依赖本模块的自觉**。
 *
 * ── 于是每一条判据都跑【两条路】（这是本文件的骨架）────────────────
 * 同一个坏形状，分别从两侧试：
 *   · **模块侧**（走 requestBinding / markVerified / rebindRole）——
 *     证明 TS 那层预检挡住了；
 *   · **DDL 侧**（手搓裸 SQL 直接 INSERT/UPDATE，**绕开整个模块**）——
 *     证明库也挡住了。
 * 只跑第一条的话，「判据落在 DDL 上」这句就是**一句注释**：模块改一行（把预检删掉、
 * 或将来有人写第二个生产者）什么都不红。只跑第二条的话，我分不清自己是在依赖库
 * 还是在依赖预检 —— 而这两件事的**修法不同**（前者要改迁移，后者要改模块）。
 * 两条路都跑，才是「两道独立的门」这句话的形状（0027 §1 同一条立场）。
 *
 * ── ⚠ 每条判据必须有一条【合法写入必须放行】的对照 ────────────────────
 * 一个**恒拦**的触发器与一个**判得对**的触发器，在只测拒绝的测试文件里
 * **完全一样**（全绿）。而恒拦的坏法比漏拦更阴：系统看起来严丝合缝，
 * 直到第一次真绑定失败，而那次的报错读起来像「表坏了」。
 * 所以下面 CASES 每一发都带 `legal`（那一条判据在**合法输入**上必须放行）
 * 与 `illegal`（在坏输入上必须拦），两半都算断言。
 * 这一维不是我想到要加的，是写 §5 那发变异时撞出来的：删掉一条触发器之后，
 * **只有 legal 那一半会红**（合法写入仍然成功），
 * 换句话说只测 legal 也抓不到「少了一条判据」。**两面都得测**。
 *
 * ── 为什么全用真库真迁移 ────────────────────────────────────────────
 * 本文件的核心断言全部是**库的行为**：触发器、唯一索引、列亲和性（`'1'` → 整数 1）、
 * `UPDATE OF col` 的触发条件。手搓一张长得像的表，这四条会同时对着一个
 * 不存在的世界成立（同 cards.test.ts 文件头那条立场）。
 *
 * ── 夹具目录带 pid（0025 §7 末条那次 63 fail 假警报的成因）──────────
 */
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { fixtureTmp } from "../fixtures/fixture-dir.js";
import { openDb } from "../../src/db/driver.js";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import {
  BINDING_COLUMNS,
  IM_BINDING_PLATFORMS,
  MARK_VERIFIED_SQL,
  REBIND_ROLE_SQL,
  REQUEST_BINDING_SQL,
  SELECT_BINDING_BY_IDENTITY_SQL,
  SELECT_BINDINGS_SQL,
  SELECT_VERIFIED_BINDING_SQL,
  listBindings,
  makeChannelActorResolver,
  markVerified,
  normalizePlatform,
  rebindRole,
  requestBinding,
  resolveBinding,
  type ResolveResult,
} from "../../src/bindings/im.js";

const HUB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * 递归列出 src 下所有 .ts 的**绝对路径**（源码守卫用）。
 *
 * 为什么不用 test/arch/harness-invariants.ts 里那份 walkFiles：它在另一个包里，
 * 从 packages/hub 的测试里 import 它会造出一个「包内测试依赖包外文件」的方向，
 * 而那个方向能不能解析取决于目录相对位置 —— 为一个 15 行的递归不值得。
 * 跳过 .tmp（本文件的夹具就在里面）。
 */
function walkSrc(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".tmp") continue;
      out.push(...walkSrc(join(dir, e.name)));
    } else if (e.name.endsWith(".ts")) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

const TMP = fixtureTmp("bindings", import.meta.url);
const IM_SRC = join(HUB, "src", "bindings", "im.ts");

/**
 * 剥注释。**两步走的正则**与 channel.test.ts 里那份同源，理由也同一条：
 * 本篇那两条源码守卫（「不 import 通道层」「不 import node:http」）扫的是**代码**，
 * 而 im.ts 的文件头**就写着那两个词**（「本模块不 import src/channels/，也不 import node:http」）
 * —— 不剥注释的话那两条守卫会**撞上自己的注释**而恒红（0019 §5 第 4 条的原地重犯）。
 *
 * ⚠ 已知漏判（与 determinism.test.ts 那份同一个形状，记在这儿而不是悄悄留着）：
 * 正则字面量里未转义的 `//` 会被当行注释起点。im.ts 里没有这一形（它连正则都不用）。
 * 下面那条「确实剥掉了东西而代码骨架还在」的自检就是这条正则失效时的兜底。
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "");
}

/** 一个不像「现在」的时刻：真时钟永远不等于它，所以「偷偷用了真时钟」会被抓到。 */
const T0 = Date.parse("2026-03-04T05:06:07.000Z");
/** 第二个时刻，用来验「重复校验不许刷新时间」。 */
const T1 = T0 + 60_000;

const ROLES = new Set(["ceo", "dev", "tech", "product", "test", "report", "assistant"]);

const opened: Array<{ close(): void }> = [];
const queues: Array<{ close(): Promise<void> }> = [];
let seq = 0;

mkdirSync(TMP, { recursive: true });

function fresh(): { db: DatabaseSync; q: WriteQueue } {
  const { db, q } = freshWithPath();
  return { db, q };
}

/** 同 fresh()，另外把库文件路径交出来（有一发需要【对同一个文件再开一个连接】）。 */
function freshWithPath(): { db: DatabaseSync; q: WriteQueue; path: string } {
  const path = join(TMP, "bd-" + ++seq + ".db");
  const db = openDb(path) as unknown as DatabaseSync;
  opened.push(db);
  migrate(db);
  {
    const wq = new WriteQueue(path);
    queues.push(wq);
    return { db, q: wq, path };
  }
}

afterAll(async () => {
  for (const c of opened) {
    try {
      c.close();
    } catch {
      /* 已关 */
    }
  }
  for (const q of queues) {
    try {
      await q.close();
    } catch {
      /* 已关 */
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});

/** 一行的当前形状（裸 SQL 读，绕开模块的一切加工）。 */
interface Raw {
  readonly id: string;
  readonly platform: string;
  readonly external_user_id: string;
  readonly ceo_role: string;
  readonly verified: number | null;
  readonly verified_at: number | null;
  readonly verified_by: string | null;
}
function rawRow(db: DatabaseSync, id: string): Raw | undefined {
  return db
    .prepare(
      "SELECT id, platform, external_user_id, ceo_role, verified, verified_at, verified_by " +
        "FROM im_bindings WHERE id = ?",
    )
    .get(id) as Raw | undefined;
}

/** 跑一条裸 SQL，交出「被拦下」与「那句报错」。 */
function attempt(db: DatabaseSync, sql: string): { blocked: boolean; message: string } {
  try {
    db.prepare(sql).run();
    return { blocked: false, message: "" };
  } catch (e) {
    return { blocked: true, message: String((e as Error).message) };
  }
}

/* ================================================================== *
 * DDL 判据：每条都跑【裸 SQL】，绕开整个模块
 * ================================================================== */

/**
 * 一条 DDL 判据的两半。
 * `legal` 与 `illegal` **都是断言**，理由在文件头：只测 illegal 的话，
 * 一个恒拦的触发器全绿；只测 legal 的话，删掉一条触发器也全绿。
 *
 * ⚠ `promote` 这一格是**实测撞出来的**（本文件第一版没有它，第 5 条那发红）。
 * 有的判据的坏法**只在某个状态之后才存在**：第 5 条拦的是
 * 「改**已验证**的绑定的身份」，而 seed 落下去的那一行是 verified=0，
 * 于是「UPDATE SET ceo_role='ceo'」在未验证的行上**本来就该放行**
 * （申请阶段改角色是合法的）。把它塞进 seed 之后直接跑 illegal，
 * 测的是另一件事而它自己不知道 —— 表驱动测试给每个 case 同一份前置状态，
 * 这个形状对**状态无关**的判据正好，对**状态相关**的那几条会静默降级成空判。
 * 这里它没静默（那条断言是 `blocked === true`，直接红了），
 * 但同族的坏法若写成「不抛就算过」就会静默。
 */
interface DdlCase {
  readonly name: string;
  /** 建好前置状态（一行待校验的申请）。 */
  readonly seed: string;
  /** 可选：把那一行推进到「已校验」，供**只有在那个状态下才成立**的坏法使用。 */
  readonly promote?: string;
  /** 合法写入：必须**放行**，且落库形状 = want。 */
  readonly legal: (id: string) => { readonly sql: string; readonly want: Partial<Raw> };
  /** 坏写入：必须**拦下**，且报错里带着那句人话。 */
  readonly illegal: (id: string) => { readonly sql: string; readonly hint: string };
}

const DDL_CASES: readonly DdlCase[] = [
  {
    name: "第 1 条：一个平台账号只能有一条绑定",
    seed: "INSERT INTO im_bindings (id,platform,external_user_id,ceo_role,verified,created_at) " +
      "VALUES ('s1','feishu','ext-1','dev',0,1)",
    // 合法：同平台**不同账号**指向同一角色（§11.5 三通道并存时最常见的情形）。
    legal: () => ({
      sql:
        "INSERT INTO im_bindings (id,platform,external_user_id,ceo_role,verified,created_at) " +
        "VALUES ('s1b','feishu','ext-2','dev',0,1)",
      want: { platform: "feishu", external_user_id: "ext-2", verified: 0 },
    }),
    illegal: () => ({
      sql:
        "INSERT INTO im_bindings (id,platform,external_user_id,ceo_role,verified,created_at) " +
        "VALUES ('s1c','feishu','ext-1','ceo',0,1)",
      hint: "im_bindings.platform, im_bindings.external_user_id",
    }),
  },
  {
    name: "第 2 条：平台白名单（0002 那条排除从此不再只由注释拦着）",
    seed: "INSERT INTO im_bindings (id,platform,external_user_id,ceo_role,verified,created_at) " +
      "VALUES ('s2','feishu','ext-2','dev',0,1)",
    legal: () => ({
      sql:
        "INSERT INTO im_bindings (id,platform,external_user_id,ceo_role,verified,created_at) " +
        "VALUES ('s2b','wecom','ext-2w','dev',0,1)",
      want: { platform: "wecom", verified: 0 },
    }),
    illegal: (id) => ({
      // 走 UPDATE 那一发而不是再插一行：那才是「经过一次合法写入」的路径，
      // 只拦 INSERT 的白名单在这一发上是洞。
      sql: "UPDATE im_bindings SET platform='wechat', verified=0, verified_at=NULL, " +
        "verified_by=NULL WHERE id='" + id + "'",
      hint: "只接受 feishu / wecom / qq",
    }),
  },
  {
    name: "第 3 条：一行绑定不许「出生即已验证」（DEFAULT 'ceo' 那个陷阱的门）",
    seed: "INSERT INTO im_bindings (id,platform,external_user_id,ceo_role,verified,created_at) " +
      "VALUES ('s3','feishu','ext-3','dev',0,1)",
    legal: () => ({
      sql:
        "INSERT INTO im_bindings (id,platform,external_user_id,ceo_role,verified,created_at) " +
        "VALUES ('s3b','qq','ext-3b','dev',0,1)",
      want: { verified: 0 },
    }),
    illegal: () => ({
      sql:
        "INSERT INTO im_bindings (id,platform,external_user_id,ceo_role,verified,created_at) " +
        "VALUES ('s3c','qq','ext-3c','ceo',1,1)",
      hint: "只能是 verified=0",
    }),
  },
  {
    name: "第 4 条：置 1 必须同时交出署名与时刻",
    seed: "INSERT INTO im_bindings (id,platform,external_user_id,ceo_role,verified,created_at) " +
      "VALUES ('s4','feishu','ext-4','dev',0,1)",
    legal: (id) => ({
      sql: "UPDATE im_bindings SET verified=1, verified_at=1700000000000, verified_by='ceo' " +
        "WHERE id='" + id + "'",
      want: { verified: 1, verified_by: "ceo", verified_at: 1700000000000 },
    }),
    illegal: (id) => ({
      sql: "UPDATE im_bindings SET verified=1 WHERE id='" + id + "'",
      hint: "必须同时写 verified_at 与 verified_by",
    }),
  },
  {
    name: "第 5 条：已验证的绑定不许就地换身份（探针撞出来的那条）",
    seed: "INSERT INTO im_bindings (id,platform,external_user_id,ceo_role,verified,created_at) " +
      "VALUES ('s5','feishu','ext-5','dev',0,1)",
    // ★ 这一发**必须**先校验：判据管的是「已验证」那一格。
    // 未验证的行上 `SET ceo_role='ceo'` 是**合法**的（申请阶段改角色）。
    promote:
      "UPDATE im_bindings SET verified=1, verified_at=1700000000000, verified_by='ceo' WHERE id='s5'",
    legal: (id) => ({
      sql: "UPDATE im_bindings SET verified=1, verified_at=1700000000000, verified_by='ceo' " +
        "WHERE id='" + id + "'",
      want: { verified: 1, ceo_role: "dev" },
    }),
    illegal: (id) => ({
      // 这一发是本篇最该被读走的一发：verified 一字未动、时刻没变、署名还在，
      // 而身份已经从「校验过的 dev」变成「CEO」。
      sql: "UPDATE im_bindings SET ceo_role='ceo' WHERE id='" + id + "'",
      hint: "不许就地换身份",
    }),
  },
  {
    name: "第 6 条：verified 只能是 0 或 1（不许第三态）",
    seed: "INSERT INTO im_bindings (id,platform,external_user_id,ceo_role,verified,created_at) " +
      "VALUES ('s6','feishu','ext-6','dev',0,1)",
    legal: (id) => ({
      sql: "UPDATE im_bindings SET verified=1, verified_at=1, verified_by='ceo' WHERE id='" + id + "'",
      want: { verified: 1 },
    }),
    illegal: (id) => ({
      sql: "UPDATE im_bindings SET verified=2, verified_at=1, verified_by='ceo' WHERE id='" + id + "'",
      hint: "只能是 0 或 1",
    }),
  },
  {
    name: "第 7 条：未验证的行不许留着校验署名",
    seed: "INSERT INTO im_bindings (id,platform,external_user_id,ceo_role,verified,created_at) " +
      "VALUES ('s7','feishu','ext-7','dev',0,1)",
    legal: (id) => ({
      sql: "UPDATE im_bindings SET verified=1, verified_at=1, verified_by='ceo' WHERE id='" + id + "'",
      want: { verified: 1, verified_by: "ceo" },
    }),
    illegal: () => ({
      // 只补署名、不动 verified。这一发同时验两件事：
      // ① 第 7 条本身（未验证的行不许有署名）；
      // ② 那条触发器写的是不带 `OF` 的 BEFORE UPDATE —— 若图省事写成 `OF verified`，
      //    这一发就漏了（SET 里没有 verified，那条触发器压根不会被唤起）。
      sql: "UPDATE im_bindings SET verified_at=1700000000000, verified_by='ceo' WHERE id='s7'",
      hint: "verified_at / verified_by",
    }),
  },
];

describe("DDL 判据（裸 SQL，绕开整个模块）", () => {
  for (const c of DDL_CASES) {
    describe(c.name, () => {
      it("前置：seed 落得下去", () => {
        const { db } = fresh();
        db.exec(c.seed);
        const id = /VALUES \('([^']+)'/u.exec(c.seed)?.[1] ?? "";
        expect(rawRow(db, id)?.verified).toBe(0);
      });

      it("合法写入必须【放行】，且落库形状如所料（否则恒拦的触发器全绿）", () => {
        const { db } = fresh();
        db.exec(c.seed);
        const id = /VALUES \('([^']+)'/u.exec(c.seed)?.[1] ?? "";
        const { sql, want } = c.legal(id);
        const r = attempt(db, sql);
        expect(r.message).toBe("");
        // 第 1、2、3 条的 legal 是**插新行**，前置那一行仍在 ⇒ 看目标行。
        const targetId = /VALUES \('([^']+)'/u.exec(sql)?.[1] ?? id;
        const row = rawRow(db, targetId);
        expect(row).not.toBeUndefined();
        for (const [k, v] of Object.entries(want)) {
          expect(row?.[k as keyof Raw]).toBe(v);
        }
      });

      it("坏写入必须【拦下】，且报错说得出人话", () => {
        const { db } = fresh();
        db.exec(c.seed);
        const id = /VALUES \('([^']+)'/u.exec(c.seed)?.[1] ?? "";
        // promote **只加在坏写入这一发之前**，不加在合法写入那发之前：
        // 第 5 条的 legal 本身就是那句校验（它是「第一次验证必须放行」那件事），
        // 先 promote 再 legal 会变成「重复验证」，测的就不是同一件事了。
        if (c.promote !== undefined) db.exec(c.promote);
        const { sql, hint } = c.illegal(id);
        const r = attempt(db, sql);
        expect(r.blocked).toBe(true);
        expect(r.message).toContain(hint);
      });
    });
  }

  it("第 7 条的 illegal 要【先有署名】才谈得上『留着』：分两发写", () => {
    // 上面表里第 7 条的 illegal 只覆盖了一半（那一发其实撞的是第 5 条 ——
    // 换身份在前）。这一发把真正的形状单独钉住：
    // 先**合法地**校验一次，再只把 verified 落回 0（不动署名）⇒ 必须拦。
    const { db } = fresh();
    db.exec(
      "INSERT INTO im_bindings (id,platform,external_user_id,ceo_role,verified,created_at) " +
        "VALUES ('p7','feishu','ext-p7','dev',0,1)",
    );
    expect(
      attempt(db, "UPDATE im_bindings SET verified=1, verified_at=1, verified_by='ceo' WHERE id='p7'")
        .blocked,
    ).toBe(false);
    const r = attempt(
      db,
      "UPDATE im_bindings SET verified=0, verified_at=NULL WHERE id='p7'",
    );
    expect(r.blocked).toBe(true);
    expect(r.message).toContain("verified_at / verified_by");
    // 反证：同一条语句把署名一起清掉 ⇒ 放行（判据不是恒拦）。
    expect(
      attempt(
        db,
        "UPDATE im_bindings SET verified=0, verified_at=NULL, verified_by=NULL WHERE id='p7'",
      ).message,
    ).toBe("");
    expect(rawRow(db, "p7")).toMatchObject({ verified: 0, verified_by: null });
  });

  it("INSERT 那一侧第 7 条同样生效（直接插一行『没验过但带署名』要拦）", () => {
    const { db } = fresh();
    const r = attempt(
      db,
      "INSERT INTO im_bindings (id,platform,external_user_id,ceo_role,verified,verified_at,verified_by,created_at) " +
        "VALUES ('p7i','feishu','ext-p7i','dev',0,1,'ceo',1)",
    );
    expect(r.blocked).toBe(true);
    expect(r.message).toContain("verified=0 的行不许带");
  });

  it("⭐ 列亲和性：verified='1'（字符串）被转成整数 1，第 6 条不误伤合法写入", () => {
    // 这一发**不是为了测 SQLite**，是为了让第 6 条那句「IS NOT 1 不会拦住 '1'」
    // 成为一条被验过的事实而不是我的推理（0029 §4 同一条：写进注释的实测结论
    // 必须能被重跑，否则它下一次被引用时已经没人知道它是不是想出来的）。
    const { db } = fresh();
    db.exec(
      "INSERT INTO im_bindings (id,platform,external_user_id,ceo_role,verified,created_at) " +
        "VALUES ('aff','qq','ext-aff','dev',0,1)",
    );
    expect(
      attempt(db, "UPDATE im_bindings SET verified='1', verified_at=1, verified_by='ceo' WHERE id='aff'")
        .message,
    ).toBe("");
    const t = db.prepare("SELECT typeof(verified) AS t FROM im_bindings WHERE id='aff'").get() as {
      t: string;
    };
    expect(t.t).toBe("integer");
  });

  it("`UPDATE OF col` 的触发范围是一条**判据**，两条方向相反的都要钉", () => {
    // 第 5 条写的是 `OF platform, external_user_id, ceo_role`，第 4/6 条写的是 `OF verified`，
    // 第 7 条写的是**不带 OF 的 BEFORE UPDATE**。这三种形状**不相同**，而差别是承重的：
    // 第 7 条若图省事写成 `OF verified`，「只补署名不改 verified」那一发就漏了。
    const { db } = fresh();
    db.exec(
      "INSERT INTO im_bindings (id,platform,external_user_id,ceo_role,verified,created_at) " +
        "VALUES ('tri','feishu','ext-tri','dev',0,1)",
    );
    // 只动 verified_by（不点名 verified）⇒ 第 7 条必须仍然生效。
    const r = attempt(db, "UPDATE im_bindings SET verified_by='someone' WHERE id='tri'");
    expect(r.blocked).toBe(true);
    expect(r.message).toContain("verified=0 的行不许带");
    // 而只动 created_at（与任何判据无关）⇒ 必须放行，否则第 7 条是恒拦。
    expect(attempt(db, "UPDATE im_bindings SET created_at=99 WHERE id='tri'").message).toBe("");
  });
});


describe("平台白名单与归一化", () => {
  /** 每一发都是 [输入, 期望]，包含【必须放行】的那些 —— 恒拒的实现能全绿。 */
  const CASES: readonly (readonly [string, string])[] = [
    ["feishu", "feishu"],
    ["wecom", "wecom"],
    ["qq", "qq"],
    // 归一化在**校验之前**：顺序反了，「用户手滑打个空格/大写」会变成一句数据库报错。
    ["  feishu  ", "feishu"],
    ["FeiShu", "feishu"],
    ["QQ", "qq"],
    // 三种拒绝，各有 reason。
    ["", "empty"],
    ["   ", "empty"],
    ["wechat", "test_channel_or_unknown"],
    ["telegram", "test_channel_or_unknown"],
    ["fake", "test_channel"],
  ];

  for (const [input, want] of CASES) {
    it("[" + JSON.stringify(input) + "] => " + want, () => {
      const r = normalizePlatform(input);
      if (want === "feishu" || want === "wecom" || want === "qq") {
        expect(r.ok).toBe(true);
        expect(r.ok === true ? r.platform : null).toBe(want);
      } else {
        expect(r.ok).toBe(false);
        if (r.ok === false) {
          expect(
            want === "test_channel_or_unknown"
              ? r.reason === "unknown_platform"
              : r.reason === want,
          ).toBe(true);
        }
      }
    });
  }

  it("⭐ 白名单【严格小于】ChannelPlatform：fake 是测试通道，不许进这张真表", () => {
    // ChannelPlatform 有 4 个值（abstraction.ts），这张表的白名单有 3 个。
    // 这个**不相等**是本文件在守的东西之一：有人「为了两边一致」把 fake 加进来那一刻，
    // 测试夹具就能通过真表拿到真角色（一个 fake channel + 一行 verified=1 的绑定
    // = 走完整条读侧），而那正是 0028 §2 那条冒充通道换了个入口。
    // 这里不 import 通道层（那会拖进 @langchain 之外的东西并造出一个方向依赖），
    // 所以把那份「4 个值」写成字面量并**注明出处**，靠下面那条源码守卫对齐。
    const CHANNEL_PLATFORM_ARITY = 4;
    expect(IM_BINDING_PLATFORMS.length).toBe(3);
    expect(IM_BINDING_PLATFORMS.length).toBeLessThan(CHANNEL_PLATFORM_ARITY);
    expect(IM_BINDING_PLATFORMS).not.toContain("fake");
    expect(IM_BINDING_PLATFORMS).not.toContain("wechat");
    // 反向：三个合法值确实各就各位（少一个就是「那个通道的绑定全被拒」）。
    expect([...IM_BINDING_PLATFORMS].sort()).toEqual(["feishu", "qq", "wecom"]);
  });

  it("fake 的 reason 与拼写错误【不合并】：两者的修法不同", () => {
    // unknown_platform 多半是手滑；fake 出现在生产写侧只有一种成因
    // —— 有人把测试通道接到了真绑定上。合并成一个 reason 之后，
    // 第二种读起来像第一种，那条最该被看见的信号就并进噪音里（0019 §5 同族）。
    expect(normalizePlatform("fake")).toEqual({ ok: false, reason: "test_channel" });
    expect(normalizePlatform("feishu2")).toEqual({
      ok: false,
      reason: "unknown_platform",
    });
  });
});

/* ================================================================== *
 * 判据清单：按【名字】点名每一条
 * ================================================================== */

/**
 * ⚠ 这一节是**这份清单本身**的守卫，不是任何一条判据的守卫。
 *
 * 为什么需要它：上面 DDL_CASES 那一整节靠的是「每个 case 里手写一句 SQL 去撞」。
 * 那种写法有一个盲区 —— **加了一条触发器而没人为它写 case**，全测试会绿，
 * 而那条新判据从此没人验过（它可能是恒拦的，也可能是恒放的，两种都看不出来）。
 * 反向也一样：**删掉一条触发器**，如果那个 case 恰好是靠别条触发的（本篇就有这种：
 * 第 7 条那一发第一版撞的其实是第 5 条），也可能全绿。
 *
 * 所以这里按名字点名，且**数量相等**（两个方向都拦）：
 * 少一个 ⇒ 有人删了判据；多一个 ⇒ 有人加了判据而没进清单。
 * 名字写死而不是从 sqlite_master 扫出来再比对自己 —— 后者恒真（0006 §7 那条纪律，
 * migrate.test.ts 里那份硬编码版本清单是同一个手法）。
 */
const EXPECTED_TRIGGERS = [
  "im_bindings_no_born_verified",
  "im_bindings_platform_insert",
  "im_bindings_platform_update",
  "im_bindings_rebind_resets_verified",
  "im_bindings_unverified_has_no_provenance",
  "im_bindings_unverified_has_no_provenance_upd",
  "im_bindings_verified_boolean",
  "im_bindings_verify_provenance",
];

describe("判据清单本身", () => {
  it("这张表上的触发器【就是这些，一条不多一条不少】", () => {
    const { db } = fresh();
    const names = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'im_bindings' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual([...EXPECTED_TRIGGERS].sort());
  });

  it("清单不是恒真：EXPECTED_TRIGGERS 与本文件的 CASES 覆盖的是同一批判据", () => {
    // 这一发挡的是「清单更新了而 CASES 没跟上」。数一下 CASES 的名字里
    // 出现的「第 N 条」，与触发器条数对齐（不是等价判据 —— 一条判据可能有两条触发器，
    // 平台那组就是 INSERT/UPDATE 两条 —— 所以这里只断言【下界】并说明为什么不到界）。
    const caseNames = DDL_CASES.map((c) => c.name).join("\n");
    const numbered = [...caseNames.matchAll(/第 (\d) 条/gu)].map((m) => Number(m[1]));
    const distinct = new Set(numbered);
    // 7 条编号判据全部有 case（第 6、7 条是探针撞出来的那两条，最容易漏写用例）。
    expect([...distinct].sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // 8 条触发器 ≥ 7 条判据：平台那一组是 INSERT + UPDATE 两条，署名那一组也是。
    expect(EXPECTED_TRIGGERS.length).toBeGreaterThanOrEqual(distinct.size);
  });

  it("每条触发器的 SQL 体里都有 RAISE 或唯一索引，不存在的『空触发器』不算判据", () => {
    // 一个 `BEGIN END;`（什么都不做）的触发器在 sqlite_master 里存在、在清单里对得上，
    // 而它一条都不拦 —— 这一发让「存在」与「拦得住」之间至少隔一次检查。
    const { db } = fresh();
    const rows = (
      db
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'im_bindings'",
        )
        .all() as { name: string; sql: string }[]
    );
    expect(rows).toHaveLength(EXPECTED_TRIGGERS.length);
    for (const r of rows) {
      expect(r.sql, r.name + " 没有 RAISE ⇒ 它不拦任何东西").toContain("RAISE");
    }
  });
});

/* ================================================================== *
 * 模块侧：走 requestBinding / markVerified / rebindRole
 * ================================================================== */

describe("模块侧写路径", () => {
  it("申请 ⇒ 一行 verified=0，且【库里那一行的角色就是我传的那个】", async () => {
    const { db, q } = fresh();
    const r = await requestBinding(q, {
      platform: "feishu",
      externalUserId: "ext-a",
      role: "dev",
      nowMs: T0,
      knownRoles: ROLES,
      newId: () => "fixed-1",
    });
    expect(r).toEqual({ kind: "requested", id: "fixed-1", role: "dev" });
    // 直接看库，不看返回值（返回值是模块的说法，库是事实）。
    expect(rawRow(db, "fixed-1")).toEqual({
      id: "fixed-1",
      platform: "feishu",
      external_user_id: "ext-a",
      ceo_role: "dev",
      verified: 0,
      verified_at: null,
      verified_by: null,
    });
  });

  it("⭐ 申请路径【不接受 verified】：那一列在 SQL 里是字面量 0", async () => {
    // 这条判据的**形状**是「RequestInput 里没有 verified 这个字段」，
    // 所以最贴的断言是看那条 SQL 里 verified **对应的那一格**。
    // （只测「传了 verified 也没用」是不够的：那种测试在一个 `values: any` 的实现上
    //  也绿 —— 而那个实现下一次会被改成真的绑上去。）
    //
    // ⚠ 判据写的是**整条列/值对照**而不是「verified 之后有没有 ?」。
    // 后者我第一版就是这么写的，它**恒红**：那一串里 `verified, created_at) VALUES (?,`
    // 让「verified 后面出现过 ?」成立，而那个 ? 绑的是 created_at。
    // 一个恒红的断言与一个恒绿的断言一样没用，只是红得更像有问题（所以更容易被放宽）。
    // 把列清单与值清单**成对**钉住，才真的表达「verified 那一格是 0」。
    expect(REQUEST_BINDING_SQL).toBe(
      "INSERT INTO im_bindings (id, platform, external_user_id, ceo_role, verified, created_at) " +
        "VALUES (?, ?, ?, ?, 0, ?)",
    );
    // 反向：不许有人干脆不写那一列，让它落回 0001 那个 DEFAULT。
    // 今天 DEFAULT 恰好是 0，所以「不写」在**今天**等价 —— 而那条 DEFAULT 属于 0001，
    // 谁都能改；写下来才是判据。
    expect(REQUEST_BINDING_SQL).toContain("verified, created_at)");
  });

  it("MARK_VERIFIED_SQL 把 verified 写成字面量 1（不是绑参）", () => {
    // 同上一条同一形状的理由：如果 verified 是绑进来的，
    // 调用方就有能力传 2 / 0 / 'x' 进来，而第 6 条那条 DDL 就成了唯一防线。
    // 那一条确实兜得住（上面测过），但判据应当在**写侧就没有那个入口**。
    expect(MARK_VERIFIED_SQL).toBe(
      "UPDATE im_bindings SET verified = 1, verified_at = ?, verified_by = ? " +
        "WHERE platform = ? AND external_user_id = ? AND verified = 0",
    );
  });

  it("重复申请返回 already_bound，且【不覆盖】已有那一行", async () => {
    const { db, q } = fresh();
    await requestBinding(q, {
      platform: "feishu",
      externalUserId: "ext-b",
      role: "dev",
      nowMs: T0,
      knownRoles: ROLES,
      newId: () => "first",
    });
    const r2 = await requestBinding(q, {
      platform: "feishu",
      externalUserId: "ext-b",
      role: "ceo",
      nowMs: T1,
      knownRoles: ROLES,
      newId: () => "second",
    });
    expect(r2).toEqual({ kind: "already_bound" });
    const row = rawRow(db, "first");
    expect(row?.ceo_role).toBe("dev");
    expect(rawRow(db, "second")).toBeUndefined();
  });

  it("撞【主键】不算 already_bound：那是两句不同的话", async () => {
    // 本篇实现期抓到的一发。原判据写成「消息里有 UNIQUE constraint failed 就算已存在」，
    // 而这张表还有第二个唯一约束（id TEXT PRIMARY KEY），newId 又是可注入的。
    // 于是注入方给重一个 id ⇒ 报成「这个账号已经绑过了」——
    // 一句假话，而且在界面上完全可信（那行里**可能真有**那个账号）。
    const { q } = fresh();
    await requestBinding(q, {
      platform: "feishu",
      externalUserId: "ext-pk1",
      role: "dev",
      nowMs: T0,
      knownRoles: ROLES,
      newId: () => "same-id",
    });
    const second = requestBinding(q, {
      platform: "wecom", // 不同平台不同账号：身份那一维**没有**冲突
      externalUserId: "ext-pk2",
      role: "dev",
      nowMs: T1,
      knownRoles: ROLES,
      newId: () => "same-id", // ← 撞的是主键
    });
    // 必须抛（不是 already_bound）：把「你给的行号重复了」翻成业务判决是撒谎。
    await expect(second).rejects.toThrow(/UNIQUE constraint failed: im_bindings\.id/u);
  });

  it("校验：verified 0→1，署名与时刻落下", async () => {
    const { db, q } = fresh();
    await requestBinding(q, {
      platform: "feishu",
      externalUserId: "ext-c",
      role: "dev",
      nowMs: T0,
      knownRoles: ROLES,
      newId: () => "c1",
    });
    const r = await markVerified(q, {
      platform: "feishu",
      externalUserId: "ext-c",
      verifiedBy: "ceo",
      nowMs: T0,
    });
    expect(r).toEqual({ kind: "verified", verifiedAtMs: T0 });
    expect(rawRow(db, "c1")).toMatchObject({ verified: 1, verified_by: "ceo", verified_at: T0 });
  });

  it("⭐ 重复校验【不刷新时刻】：那次署名的时间必须是当初那一次", async () => {
    const { db, q } = fresh();
    await requestBinding(q, {
      platform: "feishu",
      externalUserId: "ext-d",
      role: "dev",
      nowMs: T0,
      knownRoles: ROLES,
      newId: () => "d1",
    });
    await markVerified(q, { platform: "feishu", externalUserId: "ext-d", verifiedBy: "ceo", nowMs: T0 });
    const again = await markVerified(q, {
      platform: "feishu",
      externalUserId: "ext-d",
      verifiedBy: "ceo",
      nowMs: T1,
    });
    expect(again).toEqual({ kind: "already_verified" });
    // 这一格是本发唯一的目的：时刻**必须还是 T0**。
    expect(rawRow(db, "d1")?.verified_at).toBe(T0);
  });

  it("校验一个【不存在】的账号：not_found，而不是『已经验过了』", async () => {
    const { q } = fresh();
    const r = await markVerified(q, {
      platform: "feishu",
      externalUserId: "nobody",
      verifiedBy: "ceo",
      nowMs: T0,
    });
    expect(r).toEqual({ kind: "not_found" });
  });

  it("改绑：换角色 + 同一条语句把 verified 与署名一起落回", async () => {
    const { db, q } = fresh();
    await requestBinding(q, {
      platform: "feishu",
      externalUserId: "ext-e",
      role: "dev",
      nowMs: T0,
      knownRoles: ROLES,
      newId: () => "e1",
    });
    await markVerified(q, { platform: "feishu", externalUserId: "ext-e", verifiedBy: "ceo", nowMs: T0 });
    const r = await rebindRole(q, {
      platform: "feishu",
      externalUserId: "ext-e",
      role: "tech",
      knownRoles: ROLES,
    });
    expect(r).toEqual({ kind: "rebound", role: "tech" });
    expect(rawRow(db, "e1")).toMatchObject({
      ceo_role: "tech",
      verified: 0,
      verified_at: null,
      verified_by: null,
    });
    // 改绑之后必须**重新**校验才算数。
    expect(resolveBinding(db, { platform: "feishu", externalUserId: "ext-e" }).kind).toBe(
      "pending_verification",
    );
  });

  it("REBIND_ROLE_SQL 一条语句做两件事（拆两条会被 DDL 拦，见 im.ts 那段更正）", () => {
    // 这一发钉的是那条 SQL 的**形状**：verified=0 与两个 NULL 必须与 ceo_role 同一条语句。
    expect(REBIND_ROLE_SQL).toMatch(/SET ceo_role = \?, verified = 0, verified_at = NULL, verified_by = NULL/u);
    // 反向对照：不许写成 `SET ceo_role = ?`（那条今天会被触发器拦下，
    // 而「靠触发器拦」与「SQL 本来就这么写」在测试里长得一样 —— 所以钉形状）。
    expect(REBIND_ROLE_SQL).not.toMatch(/SET ceo_role = \? ?WHERE/u);
  });

  it("改一个【不存在】的账号 ⇒ not_found，不静默建一行", async () => {
    const { db, q } = fresh();
    const r = await rebindRole(q, {
      platform: "feishu",
      externalUserId: "ghost",
      role: "dev",
      knownRoles: ROLES,
    });
    expect(r).toEqual({ kind: "not_found" });
    expect(listBindings(db)).toHaveLength(0);
  });

  it("knownRoles 注入过 ⇒ 陌生角色被拒（写侧两发都判）", async () => {
    const { db, q } = fresh();
    expect(
      await requestBinding(q, {
        platform: "feishu",
        externalUserId: "ext-f",
        role: "wizard",
        nowMs: T0,
        knownRoles: ROLES,
        newId: () => "f1",
      }),
    ).toEqual({ kind: "unknown_role", role: "wizard" });
    expect(listBindings(db)).toHaveLength(0);
  });

  it("不注入 knownRoles ⇒ 不判存在性（本模块只保证 verified 那一半）", async () => {
    // 这一发不是「放宽」的开关，是把文件头那句「角色集合由调用方给」钉住：
    // 省略 ⇒ 本模块**不假装**它知道哪些角色存在。
    const { q } = fresh();
    const r = await requestBinding(q, {
      platform: "feishu",
      externalUserId: "ext-g",
      role: "wizard",
      nowMs: T0,
      newId: () => "g1",
    });
    expect(r.kind).toBe("requested");
  });

  it("空白输入一律拒：role / externalUserId / verifiedBy 三个各一发", async () => {
    const { db, q } = fresh();
    const base = { platform: "feishu", nowMs: T0, knownRoles: ROLES, newId: () => "h1" };
    expect(await requestBinding(q, { ...base, externalUserId: "  ", role: "dev" })).toEqual({
      kind: "invalid_input",
      field: "external_user_id",
    });
    // 空白角色那一发是本文件认定最该拦的一发：那一列是 NOT NULL，
    // 空白完全写得进去，于是「已校验而指向一个不存在的角色」会**只有在使用时才炸**。
    expect(await requestBinding(q, { ...base, externalUserId: "ext-h", role: "   " })).toEqual({
      kind: "invalid_input",
      field: "role",
    });
    expect(listBindings(db)).toHaveLength(0);
  });

  it("nowMs 非有限数 ⇒ 抛（不静默写一个 NaN / Infinity 进时刻列）", async () => {
    const { q } = fresh();
    await expect(
      requestBinding(q, {
        platform: "feishu",
        externalUserId: "ext-i",
        role: "dev",
        nowMs: Number.NaN,
        knownRoles: ROLES,
        newId: () => "i1",
      }),
    ).rejects.toThrow(/nowMs/u);
  });
});

/* ================================================================== *
 * 读侧
 * ================================================================== */

/** 造一份「已绑好并校验」的库，返回 db。 */
async function seeded(
  o: { readonly verified?: boolean; readonly role?: string; readonly platform?: string } = {},
): Promise<{ db: DatabaseSync; q: WriteQueue }> {
  const { db, q } = fresh();
  const platform = o.platform ?? "feishu";
  const role = o.role ?? "dev";
  await requestBinding(q, {
    platform,
    externalUserId: "ext-r",
    role,
    nowMs: T0,
    newId: () => "r1",
  });
  if (o.verified !== false) {
    await markVerified(q, { platform, externalUserId: "ext-r", verifiedBy: "ceo", nowMs: T0 });
  }
  return { db, q };
}

describe("读侧", () => {
  it("已校验的绑定 ⇒ resolved，字段齐", async () => {
    const { db } = await seeded();
    const r = resolveBinding(db, { platform: "feishu", externalUserId: "ext-r" });
    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") return;
    expect(r.binding).toEqual({
      id: "r1",
      platform: "feishu",
      externalUserId: "ext-r",
      role: "dev",
      verified: true,
      createdAtMs: T0,
      verifiedAtMs: T0,
      verifiedBy: "ceo",
    });
  });

  it("⭐ 未校验的申请 ⇒ pending_verification 而【不是】resolved", async () => {
    const { db } = await seeded({ verified: false });
    expect(resolveBinding(db, { platform: "feishu", externalUserId: "ext-r" })).toEqual({
      kind: "pending_verification",
      role: "dev",
    });
  });

  it("⭐ 三种「拿不到身份」分开报：unbound / pending / rejected_platform", async () => {
    const { db } = await seeded({ verified: false });
    // ① 压根没这行
    expect(resolveBinding(db, { platform: "feishu", externalUserId: "nobody" }).kind).toBe(
      "unbound",
    );
    // ② 有行而未校验
    expect(resolveBinding(db, { platform: "feishu", externalUserId: "ext-r" }).kind).toBe(
      "pending_verification",
    );
    // ③ 平台不合法（还没到库里那一步）
    expect(resolveBinding(db, { platform: "wechat", externalUserId: "ext-r" })).toEqual({
      kind: "rejected_platform",
      reason: "unknown_platform",
    });
  });

  it("读侧【只有一个入口】：SELECT_VERIFIED_BINDING_SQL 的 WHERE 里钉着 verified = 1", () => {
    // 这一发钉的是「这里没有第二种读法」这件事：没有 includeUnverified 开关。
    // 0028 §2 把「verified=0 算不算数」这个问题交给接这张表的人，
    // 而本篇给的那份回答是**这个函数只有一个入口** —— 那条立场要能被机器看见，
    // 否则下一个人加个可选参数就算把它推翻了，而 diff 看起来无害。
    expect(SELECT_VERIFIED_BINDING_SQL).toContain("AND verified = 1");
    // 反向：模块交出的 SQL 常量里，**任何一条**都不许有一个「读未验证的行」的形状
    // （带 verified 条件而取值为 0 的除外，那条是给 promote 用的比对，不在这儿）。
    const readSqls = [SELECT_VERIFIED_BINDING_SQL, SELECT_BINDINGS_SQL];
    for (const sql of readSqls) {
      expect(sql).not.toMatch(/verified\s*=\s*0/u);
    }
  });

  it("具名列【带着 0005 补的那两列】，且三条读 SQL 共用同一段", () => {
    // 这一发不是格式检查。BINDING_COLUMNS 是三条读 SQL 共用的那一段，
    // 而 toBinding 是按**列名**取值的（`row["verified_at"]`）。
    // 如果有人在某一条里省掉 verified_at（比如「这一条不需要时间」），
    // 那条 SELECT 就不返回那一列，toBinding 拿到 undefined ⇒ asNumOrNull 给 null ⇒
    // **界面显示「校验时间：—」而库里明明有值** —— 一个静默的缺字段，
    // 读起来像「这条没记时间」，而真相是「读的人没查」。
    // 这一族在 0021 §1 有名字（`?? 0` 那一族：把缺失兑换成一个合法的假值）。
    expect(BINDING_COLUMNS).toContain("verified_at");
    expect(BINDING_COLUMNS).toContain("verified_by");
    expect(BINDING_COLUMNS).toContain("ceo_role");
    // 三条读 SQL 全部共用那一段（少一条 = 那一条走的是另一份列清单，
    // 而它**只在被调用时**才会显出差别 —— 上面那发断言查不到那种分叉）。
    for (const sql of [
      SELECT_VERIFIED_BINDING_SQL,
      SELECT_BINDING_BY_IDENTITY_SQL,
      SELECT_BINDINGS_SQL,
    ]) {
      expect(sql.startsWith("SELECT " + BINDING_COLUMNS + " FROM im_bindings")).toBe(true);
    }
    // 反向：不许有 `SELECT *`（那会让以后加的每个内部列自动变成对外形状）。
    expect(BINDING_COLUMNS).not.toMatch(/\*/u);
  });

  it("大小写归一在**读侧**同样生效：'Feishu' 查得到 feishu 那一行", async () => {
    const { db } = await seeded();
    expect(resolveBinding(db, { platform: " Feishu ", externalUserId: "ext-r" }).kind).toBe(
      "resolved",
    );
  });

  it("knownRoles 注入后，读侧也判：已校验而角色陌生 ⇒ unknown_role", async () => {
    const { db } = await seeded({ role: "wizard" });
    // 库里那一行**是** verified=1（校验发生在写入时，那时还没注入这份角色集），
    // 而读侧不许把它当成一个可用身份。方向：拒。
    expect(
      resolveBinding(db, {
        platform: "feishu",
        externalUserId: "ext-r",
        knownRoles: ROLES,
      }),
    ).toEqual({ kind: "unknown_role", role: "wizard" });
  });

  it("listBindings：已校验排前面，其余按申请先后", async () => {
    const { db, q } = fresh();
    await requestBinding(q, { platform: "feishu", externalUserId: "a", role: "dev", nowMs: T0, newId: () => "L1" });
    await requestBinding(q, { platform: "wecom", externalUserId: "b", role: "dev", nowMs: T1, newId: () => "L2" });
    await requestBinding(q, { platform: "qq", externalUserId: "c", role: "dev", nowMs: T0 + 1, newId: () => "L3" });
    await markVerified(q, { platform: "wecom", externalUserId: "b", verifiedBy: "ceo", nowMs: T1 });
    expect(listBindings(db).map((b) => [b.id, b.verified])).toEqual([
      ["L2", true],
      ["L1", false],
      ["L3", false],
    ]);
  });

  it("⭐ 脏数据只让那一行消失，不让整个列表抛（读侧面向『扫一眼』）", () => {
    // 这一发要造的是「库里有一行平台值不合法」那个状态。它在正常写路径上**造不出来**
    // （DDL 白名单拦着），而唯一的现实成因是有人**绕过写侧直接改库** ——
    // 那正是 toBinding 里那一支 null 存在的理由，所以它必须被真的执行到。
    //
    // 造法：把两条平台触发器**临时删掉**，插一行脏平台，再建回来。
    // 为什么选这个而不是「直接测 toBinding」：toBinding 不导出，而把它导出只为可测
    // 会把一个内部判据变成公共面（多一处会被误用的入口）。
    // 为什么这个造法**可信**：触发器就在被测的那套 DDL 里，删掉它就是模拟
    // 「有人不用那条路径」，不是模拟一个不存在的世界（sqlite_master 那一发随后确认建回来了）。
    const { db } = fresh();
    db.exec("DROP TRIGGER im_bindings_platform_insert");
    db.exec(
      "INSERT INTO im_bindings (id,platform,external_user_id,ceo_role,verified,created_at) " +
        "VALUES ('good','feishu','ok','dev',0,1)",
    );
    db.exec(
      "INSERT INTO im_bindings (id,platform,external_user_id,ceo_role,verified,created_at) " +
        "VALUES ('dirty','telegram','bad','dev',0,1)",
    );
    const list = listBindings(db);
    // 脏的那行**不见**而不是让整个列表抛 —— 列表面向「扫一眼还有多少申请」，
    // 为一行脏数据 500 等于因为坏的看不到其余全部（与 approvals/query.ts 同一条口径）。
    expect(list.map((b) => b.id)).toEqual(["good"]);
    // 反向对照：合法那一行确实被读出来了（否则上面那条断言在一个恒空的实现上也绿）。
    expect(list[0]?.verified).toBe(false);
    // 读侧同样拒这一行，且给的是 rejected_platform 而不是 unbound（两句不同的话）。
    expect(
      resolveBinding(db, { platform: "telegram", externalUserId: "bad" }),
    ).toEqual({ kind: "rejected_platform", reason: "unknown_platform" });
  });

  it("上面那发用的【DROP TRIGGER】不污染别的用例：每个 it 各开一个【新库文件】", () => {
    // ⚠ 隔离靠的是**路径不同**，不是「DROP 只作用于本连接」—— 触发器是 schema 级对象，
    // 写在库文件的 sqlite_master 里，同一个文件上**别的连接一样看不见它**。
    // 我第一版的注释写的正是那句错话（把「连接级」当成了隔离原因），
    // 而那份错原因如果被下一个人照抄，他会以为改回同一路径也安全。
    // 夹具的隔离真相在 fresh()：`bd-" + ++seq + ".db`，每次一个新文件。
    //
    // 这一发为什么值得存在：上面那发 DROP 掉两条触发器，如果夹具其实共用库文件，
    // 后续所有「坏写入必须拦下」的用例都会**变红**（那种红算兜底）。
    // 但「会红」不等于「我知道它为什么红」，所以这里直接钉住新库的白名单还在。
    const { db } = fresh();
    const names = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'im_bindings_platform%'",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names.sort()).toEqual([
      "im_bindings_platform_insert",
      "im_bindings_platform_update",
    ]);
    // 反向对照：同一个文件上 DROP 之后，**新开的连接**同样看不见那条触发器
    // （这一发把上面那句「不是连接级」变成被验过的事实而不是我的说法）。
    const { db: other, path } = freshWithPath();
    other.exec("DROP TRIGGER im_bindings_platform_insert");
    // 第二个连接**也要关掉**：夹具那串 opened 就是干这个的，漏一个就是
    // 每跑一次测试留一个没关的 WAL 句柄（Windows 上 rmSync 会因此失败）。
    const third = openDb(path) as unknown as DatabaseSync;
    opened.push(third);
    const after = (
      third
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'im_bindings_platform_insert'",
        )
        .all() as { name: string }[]
    );
    expect(after).toEqual([]);
  });
});

/* ================================================================== *
 * 通道层那个注入点
 * ================================================================== */

describe("makeChannelActorResolver（0028 那个 actorFor 注入点）", () => {
  const actor = { senderId: "ext-r", channelId: "ch-1" };

  it("已校验 + 通道登记过 ⇒ 交回那两个字段（不携带角色）", async () => {
    const { db } = await seeded();
    const f = makeChannelActorResolver(db, {
      platformOfChannel: () => "feishu",
    });
    expect(f(actor)).toEqual({ senderId: "ext-r", channelId: "ch-1" });
  });

  it("未校验 ⇒ null（默认拒绝）", async () => {
    const { db } = await seeded({ verified: false });
    const f = makeChannelActorResolver(db, { platformOfChannel: () => "feishu" });
    expect(f(actor)).toBeNull();
  });

  it("⭐ 通道没登记平台 ⇒ null，而【不是】拿某个默认平台去查", async () => {
    // 文件头写的那条：一个 runtime 可以注册多条通道。
    // 「问不到就猜一个平台」的坏法是：A 平台的 senderId 去 B 平台的表里查，
    // 两个平台外部 id 撞车时，**A 的人拿到 B 那个人的角色**，而全测试绿。
    const { db } = await seeded();
    const asked: string[] = [];
    const f = makeChannelActorResolver(db, {
      platformOfChannel: (id) => {
        asked.push(id);
        return null;
      },
    });
    expect(f(actor)).toBeNull();
    // 且**一次库读都没发生**（未授权的成本应为零，与通道层那条「鉴权在任何库读之前」同一条顺序）。
    expect(asked).toEqual(["ch-1"]);
  });

  it("平台映射错位 ⇒ 查不到 ⇒ null（不跨平台认领）", async () => {
    const { db } = await seeded({ platform: "feishu" });
    // 这个通道其实是企微，而绑定记在飞书上 ⇒ 必须认不出。
    const f = makeChannelActorResolver(db, { platformOfChannel: () => "wecom" });
    expect(f(actor)).toBeNull();
  });

  it("onResolve 拿到判决（观测点，不是判据）", async () => {
    const { db } = await seeded({ verified: false });
    const seen: ResolveResult[] = [];
    const f = makeChannelActorResolver(db, {
      platformOfChannel: () => "feishu",
      onResolve: (_s, r) => seen.push(r),
    });
    f(actor);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("pending_verification");
  });

  it("⭐ resolver 【不 import 通道层】，也不把角色塞进 ChannelActor", () => {
    // 0028 那条测试钉的是「actorFor 只拿到消息里那两个字段、运行时不自己造身份」。
    // 本篇若把 role 塞进返回的 ChannelActor，就得**扩那个类型**，
    // 而扩了之后通道层就必须在某处信任它 —— 一次跨层的隐式信任。
    // 这条用源码形状钉（行为层上面那发已经钉了「返回的就是那两个字段」）。
    const src = readFileSync(IM_SRC, "utf8");
    const code = stripComments(src);
    // 先自检「剥注释这一步确实剥掉了东西」—— 正则写坏（比如整篇被剥成空串，
    // 或者压根没剥）时，下面两条 not.toMatch 会**恒绿**，而它们是本篇的源码守卫。
    // 这条元断言的形状来自 determinism.test.ts ④ 与 0019 §5 第 4 条（同一次坑的两次记账）。
    expect(code.length).toBeLessThan(src.length - 500);
    expect(code.length).toBeGreaterThan(1000);
    // 骨架还在：剥完仍然看得见那几条 SQL 常量（否则「没匹配到」只是因为没代码了）。
    expect(code).toContain("im_bindings");
    expect(code).not.toMatch(/from "\.\.\/channels\//u);
    expect(code).not.toMatch(/node:http/u);
    // 注释里**确实**有那两个词 —— 这一发就是「为什么必须先剥注释」的证据：
    // 不剥的话上面两条会撞上文件头那句「本模块不 import src/channels/」而恒红。
    expect(src).toMatch(/不 import\*?\*?\s+src\/channels/u);
    expect(src).toMatch(/node:http/u);
    // 返回类型里只有那两个键（多一个 role 就算越界）。
    expect(code).toMatch(
      /\{\s*senderId:\s*actor\.senderId,\s*channelId:\s*actor\.channelId\s*\}/u,
    );
  });
});

/* ================================================================== *
 * 两条方向相反的源码守卫：这张表不许在别处被写
 * ================================================================== */

describe("源码层", () => {
  it("写 im_bindings 的 SQL【只住在本模块】：别处不许出现写语句形状", () => {
    // 这一族判据的全部价值在于「 verified 那一半是真的」，而它的前提是
    // **只有一个写入口**。第二个写入口不需要import 本模块 —— 一句裸 SQL 就够，
    // 而那一句会绕开 TS 侧全部预检（DDL 那几条还在，所以不是权限洞，
    // 但会是「绕开了所有被测试过的那条路」）。
    // 扫的是 src 而**不含**本模块自己；测试夹具走的是裸 SQL，那是本篇的 DDL 用例
    // 有意为之（它们验的就是 DDL），所以扫 src 不扫 test。
    const files = walkSrc(join(HUB, "src"));
    const offenders: string[] = [];
    for (const f of files) {
      if (f.endsWith(join("bindings", "im.ts"))) continue;
      const code = stripComments(readFileSync(f, "utf8"));
      if (/\bim_bindings\b/u.test(code)) offenders.push(f.slice(HUB.length + 1));
    }
    expect(offenders.join(", ")).toBe("");
  });

  it("反向对照：扫描通路【真的读到了东西】（否则上面那条恒绿）", () => {
    const files = walkSrc(join(HUB, "src"));
    expect(files.length).toBeGreaterThan(50);
    // 而且本模块自己确实**命中**那个关键词（不然就是正则/通路坏了，
    // 而「零命中」在两种相反的世界里都成立：没有别处写它 / 什么都没扫到）。
    const self = stripComments(readFileSync(IM_SRC, "utf8"));
    expect(self).toMatch(/\bim_bindings\b/u);
  });
});



