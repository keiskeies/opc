// 「某张表在 src 里没有写入方」这类句子的事实核查。判据与取材分离：判据在
// zero-producer.ts（纯函数，能在合成输入上测），这里只做取材 + 登记表 + 自检。
//
// 为什么存在、它不管什么、`historical` / `quoted` / `other` 三档各堵哪种作弊 ——
// 全写在 zero-producer.ts 的文件头。这里只记测试自己的口径：
// 每一档的"免检"都是一张通行证，所以【每档都配一发反向对照】：拿一张合成源码
// 走那条路，必须红。没有反向对照的豁免表与没有豁免不可区分（0054 / 0062 §6 同形）。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { isRuntimeFixture } from "./run-fixtures.js";
import {
  describe as describeRecon,
  findProducers,
  findZeroClaims,
  KNOWN_TABLES,
  type OtherClaim,
  type ReconResult,
  reconcile,
  type SrcFile,
  type TableClaim,
  type ZeroClaim,
} from "./zero-producer.js";

const ROOT: string = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * 登记表：src 里每一句「零写入方」式句子的对账条目。
 *
 * 三条纪律：
 *  1. anchor 用内容定位且【必须唯一指向那一处】（anchorTooBroad 会抓宽锚）；
 *  2. 一句话一个条目，多表句挂两条（本轮没有这种行了——0063 把 integrity.ts 那句
 *     改成了分表陈述，所以今天每条都只指一张表）；
 *  3. `historical` / `quoted` / `other` 三种免检各自带真判据，见 zero-producer.ts。
 *
 * 更正一句假话的正确做法 = 把它的条目从 `zero` 改成 `has`（或 `historical`/`quoted`，
 * 看它现在的形状），而不是删掉条目 —— 删了它就成了幽灵登记，同样红。
 */
const REGISTRY: readonly ZeroClaim[] = [
  // ── 现在时，主张"没有写入方"（今天核对为真）──────────────────────
  // ⚠ round358 门 4 接线后 review_gates 有了第一个写入方（turn-bundle.ts 的
  //   writeGateDecision），下面 5 条当年为真的「零写入方」声明全部过期 ⇒
  //   逐条改成各自的正确形状（historical / quoted），原话留在原地——
  //   正是这个登记表设计要的形状（更正一句假话 = 改登记，不删登记）。
  {
    kind: "table",
    file: "packages/hub/src/db/integrity.ts",
    anchor: "曾经没有任何 INSERT INTO review_gates",
    table: "review_gates",
    expects: "zero",
    historical: true,
  },
  {
    kind: "table",
    file: "packages/hub/src/db/integrity.ts",
    anchor: "那张表今天【不再是零写入方】",
    table: "review_gates",
    expects: "has",
  },
  {
    kind: "table",
    file: "packages/hub/src/engine/dispatch.ts",
    anchor: "「`review_gates` 那张表仍然零写入方」",
    table: "review_gates",
    expects: "quoted",
  },
  {
    kind: "table",
    file: "packages/hub/src/memory/role-memory.ts",
    anchor: "表曾经零写入方",
    table: "review_gates",
    expects: "zero",
    historical: true,
  },
  {
    kind: "table",
    file: "packages/hub/src/memory/role-memory.ts",
    anchor: "那张表还是零写入方",
    table: "review_gates",
    expects: "zero",
    historical: true,
  },
  // ── 历史时态：当年为真，今天已有写入方。原话留在原地（0044 §9.1 口径）──
  {
    kind: "table",
    file: "packages/hub/src/bindings/im.ts",
    anchor: "全仓读写方 0 处",
    table: "im_bindings",
    expects: "zero",
    historical: true,
  },
  {
    kind: "table",
    file: "packages/hub/src/channels/abstraction.ts",
    anchor: "全仓没有任何一条 SQL 碰过它",
    table: "im_bindings",
    expects: "zero",
    historical: true,
  },
  {
    kind: "table",
    file: "packages/hub/src/engine/runtime.ts",
    anchor: "src 里零 INSERT）变成",
    table: "harness_calls",
    expects: "zero",
    historical: true,
  },
  {
    kind: "table",
    file: "packages/hub/src/dispatch/rules.ts",
    anchor: "为什么这张表此前是「零写入方」",
    table: "cos_dispatch_rules",
    // 0025 只种了 6 条规则，配置面（本文件的 INSERT）是分发规则那一轮才补的。
    // 句子带「此前」，说的是建表到那轮之间的事实，不是今天的读数。
    expects: "zero",
    historical: true,
  },
  // ── 引用：这句话是被引用/被更正的对象，不是本文件的主张 ────────────
  {
    kind: "table",
    file: "packages/hub/src/policy/auto-approve.ts",
    anchor:
      "「① 那一行不存在（今天的真库就是这种：src 里没有任何 INSERT INTO approvals）；」",
    table: "approvals",
    expects: "quoted",
  },
  {
    kind: "table",
    file: "packages/hub/src/approvals/cards.ts",
    anchor: "「approvals 在 src 里零 INSERT」",
    table: "approvals",
    expects: "quoted",
  },
  {
    kind: "table",
    file: "packages/hub/src/db/integrity.ts",
    anchor: "「零 INSERT」是那张表",
    table: "harness_calls",
    expects: "quoted",
  },
  {
    kind: "table",
    file: "packages/hub/src/db/integrity.ts",
    anchor: "「harness_calls 在 src 里零 INSERT」",
    table: "harness_calls",
    expects: "quoted",
  },
  // ── 非表声明（说明里不许出现真实表名；条数被下面的 OTHER_COUNT 钉住）──
  {
    kind: "other",
    file: "packages/hub/src/charter/budget-sync.ts",
    anchor: "除 ADD_CONSUMED_SQL 之外零写入方",
    about: "consumed_cents 那一列的自增写入方处数（引用旧读数）",
  },
  {
    kind: "other",
    file: "packages/hub/src/harness/safety.ts",
    anchor: "在生产里零写入方。",
    about: "action 值 harness_call 的签发方（只有走 Gateway 才有）",
  },
  {
    kind: "other",
    file: "packages/hub/src/http/app.ts",
    anchor: "一个没有生产者的取值形状",
    about: "界面类型里那一档取值没有构造点",
  },
  {
    kind: "other",
    file: "packages/hub/src/http/app.ts",
    anchor: "它今天【还没有生产者】",
    about: "bindingWriter 这个可选注入点还没有生产传值方",
  },
  {
    kind: "other",
    file: "packages/hub/src/memory/role-memory.ts",
    anchor: "那一列当年零写入方",
    about: "decision_reason 那一列在 src 的 SQL 里当年没出现（0060 才接上）",
  },
  {
    kind: "other",
    file: "packages/hub/src/overview/today.ts",
    anchor: "一个没有生产者的取值形状",
    about: "今日视图里那一档取值没有构造点",
  },
  // ⚠ round281 这里还挂着第 7 条：`serve/im-channels.ts` 的横幅那句「这一半还没有生产者」，
  // 说的是发卡那一路零生产调用方，而它的注释明写「它的机器判据【今天不存在】」。
  // round283 把发卡接上了（迁移 0009 + channels/deliver.ts + pollRound 最后那一格），
  // 那句话随之被改词 ⇒ 登记成了幽灵（本守卫如约红，这正是它设计出来的样子：
  // 删句子必须同时删登记，否则没人知道那句话曾经为真）。
  // ⇒ 条目删了，下面的 OTHER_COUNT 从 7 降到 6，而这一条注释就是那次删除的凭据。
  // 现在管着「发卡有人调」的是【机器判据】：test/arch/claims-registry.ts 的 r17。
];

/**
 * 非表档的条数下限。
 *
 * `other` 是唯一没有机器判据的一档（disguised 只拦"说明里写了表名"这一种），
 * 所以它的总量必须【看得见】：新增一条不是禁止，但必须改这里，而改这里的人会
 * 读到这句话。今天实测 6 条（round283 从 7 降到 6：发卡那一路有了生产者，
 * 于是那条【没有机器判据】的人读对账少了一条，改由 r17 机器守着 ——
 * 方向是对的：从"人记得看"迁到"拆掉就红"）。写 ≥ 不写 ===：删句子不该逼这里跟着改。
 */
const OTHER_COUNT = 6;

/** 取材：各包 `src` 目录下的全部 .ts。跑期夹具不算源码（同 production-deps 的理由）。 */
function srcFiles(): SrcFile[] {
  const out: SrcFile[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (isRuntimeFixture(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".ts")) {
        out.push({
          path: p
            .slice(ROOT.length + 1)
            .split(sep)
            .join("/"),
          text: readFileSync(p, "utf8"),
        });
      }
    }
  };
  const base = join(ROOT, "packages");
  for (const pkg of readdirSync(base)) {
    const src = join(base, pkg, "src");
    try {
      if (statSync(src).isDirectory()) walk(src);
    } catch {
      // 包没有 src/ 目录：不是违规，跳过（dist-only 的包这一类不存在，但取材
      // 不该因为目录形状红）。取材是否退化由下面的规模自检管，不由这里。
    }
  }
  return out.sort((a: SrcFile, b: SrcFile): number =>
    a.path < b.path ? -1 : 1,
  );
}

const EMPTY: ReconResult = {
  unregistered: [],
  ghosts: [],
  stale: [],
  wrongWay: [],
  tableMismatch: [],
  historicalWithoutMarker: [],
  fakeQuote: [],
  disguised: [],
  anchorTooBroad: [],
};

describe("零写入方声明的事实核查", () => {
  it("取材通路是活的（退化自检：这一类整个消失时必须红）", () => {
    const files = srcFiles();
    // 规模：本仓 src 有 100+ 个文件。下限写 60，防"取材 glob 坏掉"而不是充当账本。
    expect(files.length).toBeGreaterThanOrEqual(60);
    // 生产者扫描必须能扫出【已知存在】的写入方 —— 阳性对照：通路坏了先在这里红，
    // 而不是把「card_deliveries 零写入方」旁边的 harness_calls 也报成零（0062 §2 同源教训）。
    const producers = findProducers(files);
    const tables = new Set(producers.map((p) => p.table));
    for (const must of [
      "harness_calls",
      "approvals",
      "im_tokens",
      "im_bindings",
    ]) {
      expect(tables.has(must), "阳性对照：写入方扫不出来 " + must).toBe(true);
    }
    // 反面对照：meetings 在 T7 已有第一个写入方（meetings/service.ts），
    // 不能再用它当「必然零写入」的例子 —— trust_scores 今天仍只有读取、没有 INSERT。
    expect(tables.has("trust_scores")).toBe(false);
    // 声明句必须扫得出【已知存在】的句子；扫出来 0 句 = 正则坏了 = 守卫恒绿。
    expect(findZeroClaims(files).length).toBeGreaterThanOrEqual(10);
  });

  it("登记表与原文对得上（七类不符全为空，报错时点名）", () => {
    const files = srcFiles();
    const sites = findZeroClaims(files);
    const producers = findProducers(files);
    const r = reconcile(sites, REGISTRY, producers);
    // 不写七个 toEqual([])：describe() 把七类拼成一句人话，缺哪类说哪类。
    expect(describeRecon(r, producers), describeRecon(r, producers)).toBe("");
    // 对账不能是"没东西可对"：两边都必须非空（判据退化自检）。
    expect(sites.length).toBeGreaterThanOrEqual(10);
    expect(REGISTRY.length).toBeGreaterThanOrEqual(10);
    // 非表档的条数下限（other 是唯一没有机器判据的一档，总量必须看得见）。
    const others = REGISTRY.filter(
      (c: ZeroClaim): boolean => c.kind === "other",
    );
    expect(others.length).toBeGreaterThanOrEqual(OTHER_COUNT);
    // 表档里不许出现 unknown 表名 —— 登记一张不存在的表等于永远对不上也不红。
    for (const c of REGISTRY) {
      if (c.kind === "table") {
        expect(KNOWN_TABLES.has(c.table), "登记表点名了未知表 " + c.table).toBe(
          true,
        );
      }
    }
  });

  it("KNOWN_TABLES 与迁移对得上（漏一张 = other 档漏一张通行证）", () => {
    const migDir = join(ROOT, "packages", "hub", "resources", "migrations");
    const sql = readdirSync(migDir)
      .filter((x: string): boolean => x.endsWith(".sql"))
      .map((x: string): string => readFileSync(join(migDir, x), "utf8"))
      .join("\n");
    const created = new Set<string>();
    const re = /CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/g;
    let m: RegExpExecArray | null = re.exec(sql);
    while (m !== null) {
      created.add(m[1] as string);
      m = re.exec(sql);
    }
    // 迁移里建过的每一张表都必须在 KNOWN_TABLES 里：漏一张，将来有人写
    // 「那张新表零写入方」就能被登记成 other 躲过对账。
    for (const t of created) {
      expect(
        KNOWN_TABLES.has(t),
        "迁移建了 " + t + " 而 KNOWN_TABLES 没有它",
      ).toBe(true);
    }
    expect(created.size).toBeGreaterThanOrEqual(18);
  });

  it("反向对照甲：新写一句没登记的「零写入方」必须红", () => {
    const fake: SrcFile[] = [
      {
        path: "x/a.ts",
        text: '// `events` 表零写入方\nconst s = "INSERT INTO tasks (a) VALUES (1)";\n',
      },
    ];
    const r = reconcile(findZeroClaims(fake), [], findProducers(fake));
    expect(r.unregistered.length).toBe(1);
    expect(describeRecon(r, findProducers(fake))).toContain("没登记");
    // 登记表空而原文有句子 ⇒ 必须红。这条防的是"登记表读成空数组"那种静默退化。
    const files = srcFiles();
    expect(
      reconcile(findZeroClaims(files), [], findProducers(files)).unregistered
        .length,
    ).toBeGreaterThan(0);
  });

  it("反向对照乙：登记 zero 而表有写入方 ⇒ stale（本轮 bug 的最小复现）", () => {
    const fake: SrcFile[] = [
      {
        path: "x/a.ts",
        text: '// `harness_calls` 零写入方\nconst s = "INSERT INTO harness_calls (a) VALUES (1)";\n',
      },
    ];
    const claim: TableClaim = {
      kind: "table",
      file: "x/a.ts",
      anchor: "零写入方",
      table: "harness_calls",
      expects: "zero",
    };
    const producers = findProducers(fake);
    const r = reconcile(findZeroClaims(fake), [claim], producers);
    expect(r.stale.length).toBe(1);
    // 同句标上 historical 而句子里没有过去标记词 ⇒ 不许静音，改红在 historicalWithoutMarker。
    const r2 = reconcile(
      findZeroClaims(fake),
      [{ ...claim, historical: true }],
      producers,
    );
    expect(r2.stale.length).toBe(0);
    expect(r2.historicalWithoutMarker.length).toBe(1);
    // 句子带上过去标记 ⇒ historical 成立（历史读数的合法形状）。
    const fake2: SrcFile[] = [
      {
        path: "x/a.ts",
        text: '// 当年量的：`harness_calls` 零写入方\nconst s = "INSERT INTO harness_calls (a) VALUES (1)";\n',
      },
    ];
    const r3 = reconcile(
      findZeroClaims(fake2),
      [{ ...claim, anchor: "`harness_calls` 零写入方", historical: true }],
      findProducers(fake2),
    );
    expect(r3.historicalWithoutMarker.length).toBe(0);
    expect(r3.stale.length).toBe(0);
  });

  it("反向对照丙：quoted 必须真在引号里（防「我只是引用」逃生口）", () => {
    const bare: SrcFile[] = [
      {
        path: "x/a.ts",
        text: '// harness_calls 零 INSERT 是旧的\nconst s = "INSERT INTO harness_calls (a) VALUES (1)";\n',
      },
    ];
    const claim: TableClaim = {
      kind: "table",
      file: "x/a.ts",
      anchor: "harness_calls 零 INSERT 是旧的",
      table: "harness_calls",
      expects: "quoted",
    };
    expect(
      reconcile(findZeroClaims(bare), [claim], findProducers(bare)).fakeQuote
        .length,
    ).toBe(1);
    const quoted: SrcFile[] = [
      {
        path: "x/a.ts",
        text: '// 原文「harness_calls 零 INSERT 是旧的」已过期\nconst s = "INSERT INTO harness_calls (a) VALUES (1)";\n',
      },
    ];
    const q2: TableClaim = {
      ...claim,
      anchor: "harness_calls 零 INSERT 是旧的",
    };
    expect(
      reconcile(findZeroClaims(quoted), [q2], findProducers(quoted)).fakeQuote
        .length,
    ).toBe(0);
  });

  it("反向对照丁：other 的说明里出现真实表名 ⇒ disguised（other 不是垃圾桶）", () => {
    const fake: SrcFile[] = [
      { path: "x/a.ts", text: "// events 表零写入方\n" },
    ];
    const claim: OtherClaim = {
      kind: "other",
      file: "x/a.ts",
      anchor: "零写入方",
      about: "events 这张表的写入方",
    };
    expect(reconcile(findZeroClaims(fake), [claim], []).disguised.length).toBe(
      1,
    );
  });

  it("反向对照戊：万能锚必须红（一句抵十句 = 假的全覆盖）", () => {
    const fake: SrcFile[] = [
      {
        path: "x/a.ts",
        text: "// `review_gates` 零写入方\n// `review_gates` 零写入方\n",
      },
    ];
    const claim: TableClaim = {
      kind: "table",
      file: "x/a.ts",
      anchor: "零写入方",
      table: "review_gates",
      expects: "zero",
    };
    const r = reconcile(findZeroClaims(fake), [claim], []);
    expect(r.anchorTooBroad.length).toBe(1);
    expect(describeRecon(r, []).length).toBeGreaterThan(0);
  });

  it("反向对照己：登记与句子指的不是同一张表 ⇒ tableMismatch", () => {
    const fake: SrcFile[] = [
      {
        path: "x/a.ts",
        text: '// `harness_calls` 零写入方\nconst s = "INSERT INTO harness_calls (a) VALUES (1)";\n',
      },
    ];
    // 指着 harness_calls 那句，把 table 写成一张真没写入方的表 —— 两个方向都不红，
    // 没有 tableMismatch 这一维这就是"拿一张干净的表给脏句子作保"的完整作案路径。
    const claim: TableClaim = {
      kind: "table",
      file: "x/a.ts",
      anchor: "零写入方",
      table: "review_gates",
      expects: "zero",
    };
    const r = reconcile(findZeroClaims(fake), [claim], findProducers(fake));
    expect(r.tableMismatch.length).toBe(1);
    expect(describeRecon(r, findProducers(fake))).toContain("不是同一张表");
  });

  it("生产者只认代码字符串，注释里的 SQL 字样不算写入方", () => {
    const fake: SrcFile[] = [
      {
        path: "x/a.ts",
        text: "// UPDATE 前记得 INSERT INTO ghosts (a) VALUES (1)\nconst s = 1;\n",
      },
    ];
    expect(findProducers(fake).length).toBe(0);
    // INSERT OR IGNORE / OR REPLACE 也得认（0063：漏了它就是守卫自己造「零写入方」假象）。
    const ors: SrcFile[] = [
      {
        path: "x/b.ts",
        text: 'const a = "INSERT OR IGNORE INTO t1 (a) VALUES (1)";\nconst b = "INSERT OR REPLACE INTO t2 (a) VALUES (1)";\n',
      },
    ];
    const got = findProducers(ors).map((p) => p.table);
    expect(got).toContain("t1");
    expect(got).toContain("t2");
  });

  it("幽灵登记：句子被删/改词，条目必须跟着改（不许留成装饰）", () => {
    // 夹具里【不能出现】任何一种声明写法 —— 上一版写成"没有零写入方字样了"，
    // 那句自己就含"零写入方"，于是它成了一处真声明并与登记配对成功，ghosts 恒 0，
    // 这一发反向对照什么都没测。判据没坏，是夹具假。
    const fake: SrcFile[] = [
      { path: "x/a.ts", text: "// 这句已被改写成别的说法\n" },
    ];
    const claim: TableClaim = {
      kind: "table",
      file: "x/a.ts",
      anchor: "零写入方",
      table: "review_gates",
      expects: "zero",
    };
    expect(reconcile(findZeroClaims(fake), [claim], []).ghosts.length).toBe(1);
  });
});
