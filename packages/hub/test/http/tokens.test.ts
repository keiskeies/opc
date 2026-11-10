/**
 * 一次性审批 token（src/http/tokens.ts，计划 Task 4.1 第二半，【规格】§20.3 + §11.4）。
 *
 * ── 这个文件在证什么 ────────────────────────────────────────────────
 * 一句话：**一张票只能换来一次、一张卡、一个可逆的决定。**
 * 拆成五格，每格对应一种真实故障：
 *   ① 一次：第二次兑换必须失败，而【并发两次】也只能有一次成功（条件 UPDATE）；
 *   ② 一张：A 的票不能批 B，且【不烧】那张票（点错卡不该烧掉正批的机会）；
 *   ③ 时间：过期拒、未过期放行，而「过期」与「用过」是两种修法（reason 必须不同）；
 *   ④ 可逆性：§11.4 那条硬约束，含【判不出算不可逆】那一挡（本模块最要紧的一发）；
 *   ⑤ 存的是哈希：库里查不到原文，而【备份文件】里也查不到。
 *
 * ── 为什么全用真库真迁移 ────────────────────────────────────────────
 * 与 cards.test.ts 同一条理由，而这里还多一条更硬的：
 * 本篇的核心断言里有一条是【im_tokens.approval_id 上没有外键】。
 * 那是一个关于**真 DDL** 的事实（0001 那张表没写 REFERENCES），
 * 手搓一张带 FK 的像形表会让「issue 的预检是必需的」这句话变成假的 ——
 * 而那句话正是 issueToken 里那次 SELECT 存在的全部理由。
 *
 * ── 为什么不用 mock 而用真 appendAudit ──────────────────────────────
 * redeem 会写一条审计。那条审计的【存在】是「这张票什么时候被用掉了」的唯一记录
 * （im_tokens 只有一个 used 的 0/1，没有时间列），所以它不能被 mock 掉 ——
 * mock 掉之后「留痕」这件事就只剩注释在承诺。
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_TOKEN_TTL_MS,
  BURN_TOKEN_SQL,
  hashToken,
  INSERT_TOKEN_SQL,
  issueToken,
  newApprovalToken,
  redeemToken,
  TOKEN_UNUSED,
  tokenRemainingMs,
  isIrreversibleApproval,
} from "../../src/http/tokens.js";
import { openDb } from "../../src/db/driver.js";
import { migrate } from "../../src/db/migrate.js";

const HUB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TMP = join(HUB, ".tmp", "tokens-" + process.pid);
const TOKENS_SRC = readFileSync(join(HUB, "src", "http", "tokens.ts"), "utf8");

/** 一个不像「现在」的时刻。 */
const T0 = Date.parse("2026-05-06T07:08:09.000Z");

const opened: Array<{ close(): void }> = [];
let seq = 0;

function fresh(): DatabaseSync {
  const db = openDb(join(TMP, "tk-" + ++seq + ".db")) as unknown as DatabaseSync;
  opened.push(db);
  migrate(db);
  return db;
}

function addTask(db: DatabaseSync, id: string): void {
  db
    .prepare(
      "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
        "VALUES (?, ?, 'IN_PROGRESS', 'dev', 'implement', ?, ?)",
    )
    .run(id, "token 夹具 " + id, T0, T0);
}

/**
 * 一张卡。默认是【可逆】的：type 用 budget_override，parameters 里 irreversible:false。
 * 默认值刻意选「可逆」—— 否则每一发「兑换成功」的用例都会先撞上 §11.4 那一挡，
 * 而那时候「成功」这一格根本没被执行过（0026 §7.1 那个形状）。
 */
function addApproval(
  db: DatabaseSync,
  id: string,
  over: { type?: string; parameters?: string; status?: string } = {},
): string {
  db.prepare(
    "INSERT INTO approvals (id, task_id, approval_type, summary, parameters, " +
      "timeout_behavior, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    "t-1",
    over.type ?? "budget_override",
    "要不要给这个任务追加 200 美元预算",
    over.parameters ?? '{"irreversible": false, "impact_scope": "staging"}',
    "auto_reject",
    over.status ?? "pending",
  );
  return id;
}

function issue(db: DatabaseSync, approvalId: string, over: { nowMs?: number; ttlMs?: number } = {}) {
  const raw = newApprovalToken();
  issueToken(db, {
    rawToken: raw,
    approvalId,
    nowMs: over.nowMs ?? T0,
    ...(over.ttlMs === undefined ? {} : { ttlMs: over.ttlMs }),
  });
  return raw;
}

/** 兑换并断言成功，返回 taskId —— 省得每发都写一遍样板，【但只在成功那几发用】。 */
function okRedeem(db: DatabaseSync, raw: string, at: number = T0): string {
  const r = redeemToken(db, { rawToken: raw, nowMs: at });
  if (r.ok !== true) throw new Error("期望兑换成功，实到 " + r.reason);
  return r.taskId;
}

afterAll(() => {
  for (const o of opened) {
    try {
      o.close();
    } catch {
      /* 已关 */
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});

mkdirSync(TMP, { recursive: true });

describe("① 一次：一张票只换一次兑换", () => {
  it("⭐ 第一次成功、第二次被拒，且第二次的 reason 是 already_used 而不是 unknown", () => {
    const db = fresh();
    addTask(db, "t-1");
    const raw = issue(db, addApproval(db, "a-1"));
    expect(okRedeem(db, raw)).toBe("t-1");
    const second = redeemToken(db, { rawToken: raw, nowMs: T0 + 1000 });
    expect(second.ok).toBe(false);
    // reason 必须是 already_used。判成 unknown 也「挡住」了，而它把两种修法混成一种：
    // 「用过了 ⇒ 去看那次决定的结果」与「这不是我们发的 ⇒ 有人在试」是两件事。
    expect(second.ok === false && second.reason).toBe("already_used");
  });

  it("⭐ 连着两次兑换 ⇒ 恰好一支成功（JS 那道与 changes 检查各挡一次，【两个都在承重】）", () => {
    /*
     * 这一发的标题【被变异跑改过两次】，改的过程比结论值得留：
     * 第一版写的是「判据在 WHERE 里，不在 JS 里」，以为 SQL 那条条件 UPDATE 是唯一支点；
     * 第二版（本文件本轮之前）改成「JS 与 SQL 各挡一次」—— 【那个 SQL 是错的】，
     * 真正与 JS 那道配成双保险的是下面那句 `changes === 0` 检查。理由在下面。
     * 实测（本地变异跑，完整矩阵与两处读错见 0027 §4）：
     *   · 只删 JS 那道 `row.used !== TOKEN_UNUSED` ⇒ 【25 全绿】；
     *   · 只让 `changes === 0` 那一支不触发 ⇒ 【25 全绿】；
     *   · 【上面两道同时删】⇒ 恰好红【这一发 + 相邻那一发】（都是连续兑换）。
     * ⇒ 这两道是【真双保险】，单个变异必然存活 —— 如果当时只跑了前两次就下结论，
     *   会得到「这块没守卫」这个错判（同 0026 §8 那族：能杀掉与知道自己哪里有守卫是两件事）。
     * 而原先这里还写着「只不查 changes 等价于删掉 SQL 那道」—— 【那句撤掉】：
     * 直接把 SQL 的 `AND used = ?` 删掉会让占位符从 4 个变 3 个，`assertParamCount` 先抛，
     * 那一跑测的是参数个数而不是条件。保留占位符把条件改成恒真再跑 ⇒ 行为全绿，
     * 唯一红的是下面那条【形状】断言。也就是说 SQL 那道【从来没有被行为测试验证过】，
     * 它防的是两个进程（见那条自己的注释）。
     *
     * 为什么两次同步调用能被 JS 那道挡住：这段代码里没有 await，
     * 两次 redeem 之间不存在真交错点，第二次的 SELECT 一定看到第一次写下的 1。
     * 于是【真并发在这里根本造不出来】，SQL 那道防的是【两个进程】（Hub 之外还有谁在写这个库）。
     * 那就是这一发测不到、必须靠下面那条【源码形状】断言补上的部分：
     * 一条测行为（能跑到的那部分），一条测形状（跑不到也能挡）。
     */

    const db = fresh();
    addTask(db, "t-1");
    const raw = issue(db, addApproval(db, "a-1"));
    const first = redeemToken(db, { rawToken: raw, nowMs: T0 });
    const second = redeemToken(db, { rawToken: raw, nowMs: T0 });
    expect([first.ok, second.ok]).toEqual([true, false]);
    // 第二支必须走【JS 那道】而不是烧票那条：库里现在有两个 0→1 的候选路径，
    // 而它们的修法不同（前者是「读到了就别写」，后者是「写了发现没中」）。
    // 断言 reason 而不是只断言 ok=false，是为了【这一发红的时候能一眼看出是哪一挡失守】：
    // 只断言 ok=false 的话，M12 那种变异也能让它绿（第二支仍会被 JS 挡住，
    // 而如果哪天连 JS 那道都没了，reason 会从 already_used 变成 unknown_token —— 那一红才有信息量）。
    expect(second.ok === false && second.reason).toBe("already_used");
  });

  it("⭐ 兑换写了【一条】审计，而它是「这张票什么时候用掉的」唯一记录", () => {
    const db = fresh();
    addTask(db, "t-1");
    const raw = issue(db, addApproval(db, "a-1"));
    const r = redeemToken(db, { rawToken: raw, nowMs: T0 + 4321 });
    if (r.ok !== true) throw new Error("应成功");
    // im_tokens 没有 used_at（0001 那张表只有 token/approval_id/expires_at/used 四列），
    // 所以时刻只能落在审计里。少了这条 INSERT，「谁在什么时候烧了这张票」在库里查不到。
    const rows = db
      .prepare("SELECT * FROM events WHERE actor_id = ? ORDER BY id")
      .all("approval-token") as Record<string, unknown>[];
    expect(rows.length).toBe(1);
    expect(Number(rows[0]["created_at"])).toBe(T0 + 4321);
    expect(rows[0]["task_id"]).toBe("t-1");
    // seq 就是 events.id（0005 §3）：调用方拿它去 publish，两个数不等就是游标不可比。
    expect(r.seq).toBe(Number(rows[0]["id"]));
  });

  it("兑换【不改 approvals】：决策仍是调用方那一条写路径", () => {
    /*
     * 计划 Task 4.1 那句「不得有第二条更弱的通道」在这张表上的直接体现。
     * 若 tokens.ts 自己 UPDATE approvals，status 会变成 approved —— 而那就是第二条写路径。
     */
    const db = fresh();
    addTask(db, "t-1");
    const raw = issue(db, addApproval(db, "a-1"));
    okRedeem(db, raw);
    const row = db
      .prepare("SELECT status, decided_by FROM approvals WHERE id = ?")
      .get("a-1") as Record<string, unknown>;
    expect(row["status"]).toBe("pending");
    expect(row["decided_by"]).toBeNull();
  });

  it("⭐ 源码层面：本模块【不写 approvals】，也不写 status", () => {
    // 行为断言在上面那一发，而它只覆盖了「跑到的那条路径」。
    // 这一发扫全部源码：将来有人加一条 UPDATE approvals 就红，
    // 哪怕那条路今天没有任何用例经过（0026 §7.1 那一族的正面解法）。
    const code = TOKENS_SRC.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
    expect(code).not.toMatch(/UPDATE\s+approvals/iu);
    expect(code).not.toMatch(/INSERT\s+INTO\s+approvals/iu);
    // 反向对照：剥注释【确实剥到了东西】，否则这条扫描可能只是在比原文。
    expect(code.length).toBeLessThan(TOKENS_SRC.length - 500);
    // 它读 approvals 是可以的（要判 status 与不可逆性），所以 SELECT 必须还在 ——
    // 少了它上面那两条 not.toMatch 会因为「什么都不碰」而全绿。
    expect(code).toMatch(/FROM im_tokens t LEFT JOIN approvals/u);
  });
});

describe("② 一张：票与卡绑定", () => {
  it("⭐ 拿 A 的票去批 B ⇒ 拒，且【A 那张票没被烧掉】", () => {
    /*
     * 「不烧」是这一发的第二半，也更容易漏：
     * 如果 mismatch 也把票消耗了，「在手机上点错了卡片」会连带烧掉
     * 那张卡的【正经批准机会】—— 用户得回桌面端重签一次。
     */
    const db = fresh();
    addTask(db, "t-1");
    addApproval(db, "a-1");
    addApproval(db, "a-2");
    const raw = issue(db, "a-1");
    const r = redeemToken(db, { rawToken: raw, nowMs: T0, expectedApprovalId: "a-2" });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("approval_mismatch");
    // 反向对照：同一张票批【它自己那张】仍然成功。
    expect(okRedeem(db, raw, T0 + 1)).toBe("t-1");
  });

  it("不传 expectedApprovalId ⇒ 用票上绑的那张（回调只回传 opaque 串的那种通道）", () => {
    const db = fresh();
    addTask(db, "t-1");
    const raw = issue(db, addApproval(db, "a-1"));
    expect(okRedeem(db, raw)).toBe("t-1");
  });

  it("票指向的卡已被别人批掉 ⇒ approval_not_pending，且票【不】被烧", () => {
    const db = fresh();
    addTask(db, "t-1");
    const raw = issue(db, addApproval(db, "a-1"));
    db.prepare("UPDATE approvals SET status = 'approved' WHERE id = 'a-1'").run();
    const r = redeemToken(db, { rawToken: raw, nowMs: T0 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("approval_not_pending");
    // 没烧：库里 used 仍是 0。
    const used = db
      .prepare("SELECT used FROM im_tokens WHERE token = ?")
      .get(hashToken(raw)) as { used: number };
    expect(used.used).toBe(TOKEN_UNUSED);
  });
});

describe("③ 时间", () => {
  it("⭐ 到期之后被拒，reason 是 expired", () => {
    const db = fresh();
    addTask(db, "t-1");
    const raw = issue(db, addApproval(db, "a-1"));
    const r = redeemToken(db, { rawToken: raw, nowMs: T0 + DEFAULT_TOKEN_TTL_MS });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("expired");
  });

  it("到期前 1 毫秒仍能兑换（边界是「> now」而不是「>= now」）", () => {
    const db = fresh();
    addTask(db, "t-1");
    const raw = issue(db, addApproval(db, "a-1"));
    expect(okRedeem(db, raw, T0 + DEFAULT_TOKEN_TTL_MS - 1)).toBe("t-1");
  });

  it("⭐ 既过期又用过 ⇒ expired（修法对的那一档）", () => {
    /*
     * 两种状态同时成立时报哪一个，取决于【哪个修法是对的】，不取决于实现顺序的巧合：
     * 报 already_used 会把人支去「看那次决定的结果」，而这张票早就过期了，
     * 那张卡可能已被别的路径处理完；报 expired 的修法（重签一张）才是能走通的。
     */
    const db = fresh();
    addTask(db, "t-1");
    const raw = issue(db, addApproval(db, "a-1"), { ttlMs: 1000 });
    okRedeem(db, raw, T0);
    const r = redeemToken(db, { rawToken: raw, nowMs: T0 + 5000 });
    expect(r.ok === false && r.reason).toBe("expired");
  });

  it("剩余时间：有票给差值，没票给 null（而不是 0，那会和「刚过期」混起来）", () => {
    const db = fresh();
    addTask(db, "t-1");
    const raw = issue(db, addApproval(db, "a-1"));
    expect(tokenRemainingMs(db, raw, T0)).toBe(DEFAULT_TOKEN_TTL_MS);
    expect(tokenRemainingMs(db, newApprovalToken(), T0)).toBeNull();
    // 反方向也要钉：原文被【当成哈希】去查会查不到，所以给的是 null ——
    // 这一发证明 remaining 查的确实是哈希，不是原文。
    expect(tokenRemainingMs(db, hashToken(raw), T0)).toBeNull();
  });

  it("ttlMs 是 NaN / 0 / 负数 ⇒ 抛，而不是写一个「有效期任意」的行", () => {
    const db = fresh();
    addTask(db, "t-1");
    addApproval(db, "a-1");
    for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      expect(() =>
        issueToken(db, { rawToken: newApprovalToken(), approvalId: "a-1", nowMs: T0, ttlMs: bad }),
        String(bad),
      ).toThrow(/正有限数/u);
    }
  });
});

describe("④ §11.4 不可逆不许在远程完成", () => {
  it("type 是 irreversible_action ⇒ 拒", () => {
    const db = fresh();
    addTask(db, "t-1");
    const raw = issue(db, addApproval(db, "a-1", { type: "irreversible_action" }));
    const r = redeemToken(db, { rawToken: raw, nowMs: T0 });
    expect(r.ok === false && r.reason).toBe("irreversible_denied");
  });

  it("⭐ 一张【别的类型】的卡，只要 parameters 里 irreversible:true，同样拒", () => {
    /*
     * 这一发是「为什么判据要两条」的实证。0026 §2 那次决定
     * （一个通用 approval_type + 自由 reason 维度）直接导致【类型那一维不够用】：
     * 一张 budget_override 的卡可以是一次不可逆动作。只判 type 会放过它，
     * 而「按类型挡住不可逆操作」这句话听起来【完全成立】。
     */
    const db = fresh();
    addTask(db, "t-1");
    const raw = issue(db, addApproval(db, "a-1", { parameters: '{"irreversible": true}' }));
    const r = redeemToken(db, { rawToken: raw, nowMs: T0 });
    expect(r.ok === false && r.reason).toBe("irreversible_denied");
  });

  it("⭐ parameters 是脏 JSON ⇒ 【算不可逆】（判不出 ⇒ 多挡）", () => {
    /*
     * 本模块最要紧的一发。方向想清楚：
     * 「解析不出来」的卡片在库里和「没带标记」长得【不一样】（一个是坏字节，一个是 false），
     * 而我们没有任何别的办法知道它到底可不可逆。
     * 判成可逆的后果：一条脏 JSON 恰好让【最危险的那张卡】拿到远程批准通道，
     * 而且解析失败这件事发生在【我们的判据内部】，不在任何人的请求路径上 ⇒ 零报错。
     */
    const db = fresh();
    addTask(db, "t-1");
    const raw = issue(db, addApproval(db, "a-1", { parameters: "{不是 JSON" }));
    const r = redeemToken(db, { rawToken: raw, nowMs: T0 });
    expect(r.ok === false && r.reason).toBe("irreversible_denied");
  });

  it("四种判不出的形状全部算不可逆：脏串 / null / 空串 / 数组", () => {
    for (const p of ["{坏", null, "", "[1,2]", '"一个字符串"']) {
      expect(isIrreversibleApproval("budget_override", p), JSON.stringify(p)).toBe(true);
    }
    // 反向对照：一个明确的 false 必须放行。否则上面那五条只是「恒返回 true」。
    expect(isIrreversibleApproval("budget_override", '{"irreversible": false}')).toBe(false);
    expect(isIrreversibleApproval("escalation", '{"impact_scope":"x"}')).toBe(false);
  });

  it("⭐ 只认【真】true：字符串 \"true\" 与 1 不算（否则偏严会被取值解释抵消）", () => {
    // 这一发看着像在挑刺，它钉的是【判据的方向不能反】：
    // 上面几条把「判不出」一律算不可逆（偏严），而如果这里把 "true"/1 也算 true（偏松），
    // 两件事叠起来会得到一个【谁也说不清】的真值表。取值解释跟契约走：
    // 建卡方过的是 zod 的严格布尔（cards.ts），写不出非布尔的 irreversible。
    expect(isIrreversibleApproval("budget_override", '{"irreversible": "true"}')).toBe(false);
    expect(isIrreversibleApproval("budget_override", '{"irreversible": 1}')).toBe(false);
    expect(isIrreversibleApproval("budget_override", '{"irreversible": true}')).toBe(true);
  });

  it("timeout_behavior【不是】可逆性的判据（那是超时策略，不是可撤销性）", () => {
    // 【规格】§11.4 原文是「IM 只处理可逆的、有超时默认行为的审批」——
    // 那是【两个必要条件】，不是把后者当前者的定义。
    // 一张 auto_reject 的不可逆卡照样不可逆。这一发把这条误读钉死。
    expect(isIrreversibleApproval("irreversible_action", '{"irreversible": false}')).toBe(true);
  });
});

describe("⑤ 库里存的是哈希", () => {
  it("⭐ 用原文查不到那一行，用哈希查得到", () => {
    /*
     * 这一发是【备份可读性】的代理。真正怕的是：VACUUM INTO 出来的那个备份文件
     * 里如果躺着可用的凭据，那每个躺在 NAS / 同步盘上的备份都是一叠待使用的审批。
     * 直接扫备份文件也能测，但那要把备份链跑通（db/backup.ts），
     * 而备份的内容 = 库的内容，所以「库里没有原文」这一发就把那条性质立住了。
     */
    const db = fresh();
    addTask(db, "t-1");
    const raw = issue(db, addApproval(db, "a-1"));
    const byRaw = db.prepare("SELECT 1 AS x FROM im_tokens WHERE token = ?").get(raw);
    const byHash = db
      .prepare("SELECT 1 AS x FROM im_tokens WHERE token = ?")
      .get(hashToken(raw));
    expect(byRaw).toBeUndefined();
    expect(byHash).not.toBeUndefined();
  });

  it("⭐ 整库文件里搜不到原文（把上面那一发从『查得到/查不到』升级成『字节不在文件里』）", () => {
    const path = join(TMP, "scan-" + ++seq + ".db");
    const db = openDb(path) as unknown as DatabaseSync;
    opened.push(db);
    migrate(db);
    addTask(db, "t-1");
    addApproval(db, "a-1");
    const raw = newApprovalToken();
    issueToken(db, { rawToken: raw, approvalId: "a-1", nowMs: T0 });
    db.exec("PRAGMA wal_checkpoint(FULL)");
    // 直接扫【文件字节】：列名是 token 而存的是哈希，这正是最该被读代码的人知道的事，
    // 所以它不能只由注释保证。SQLite 可能把值存在页里任意位置，但一个 TEXT 主键
    // 一定在某个 B-tree 页里以原文字节出现 —— 哈希之后那些字节就不存在了。
    const bytes = readFileSync(path).toString("latin1");
    expect(bytes).not.toContain(raw);
    expect(bytes).toContain(hashToken(raw));
  });

  it("哈希是定长 64 位十六进制，且同一个原文两次哈希相同", () => {
    const raw = newApprovalToken();
    expect(hashToken(raw)).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashToken(raw)).toBe(hashToken(raw));
    // 反向：两个原文不同 ⇒ 哈希不同（否则「主键」是假的，第二张票会覆盖第一张）。
    expect(hashToken(newApprovalToken())).not.toBe(hashToken(raw));
  });

  it("原文长度够：32 字节的 base64url，不是 UUID", () => {
    const raw = newApprovalToken();
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    // 形状反向对照：不能长得像一个 UUID（那会被当日志里随便打的东西对待）。
    expect(raw).not.toMatch(/^[0-9a-f]{8}-/u);
  });

  it("签发指向【不存在的卡】的票 ⇒ 抛（im_tokens 上没有外键，只能在这里挡）", () => {
    const db = fresh();
    // 先把「没有外键」这件事本身钉住：如果哪天有人补上 REFERENCES，
    // issueToken 里那次预检就从「必需」变成「冗余」，而这条测试会先红，
    // 逼读的人去重新决定那次预检留不留 —— 而不是让两处判据悄悄并存。
    expect(() =>
      db
        .prepare("INSERT INTO im_tokens (token, approval_id, expires_at, used) VALUES (?,?,?,?)")
        .run("h-x", "no-such-approval", T0 + 1000, TOKEN_UNUSED),
    ).not.toThrow();
    // 于是【没有 FK 挡着】是事实，那么这一发必须靠代码挡住：
    expect(() =>
      issueToken(db, { rawToken: newApprovalToken(), approvalId: "ghost", nowMs: T0 }),
    ).toThrow(/不存在/u);
  });

  it("⭐ BURN_TOKEN_SQL 的判据在 SQL 里：WHERE 同时带 used 与 expires_at", () => {
    // 与 ① 那条配成对。这一发的分工是【重跑之后改过来的】（全部数字见 0027 §4）：
    // 原本这里写着「只删 SQL 的 used 条件 ⇒ 25 全绿 ⇒ 两个同时删才红」，
    // 那个「全绿」是把 SQL 的 `AND used = ?` 直接删掉测的 —— 占位符随之从 4 个变 3 个，
    // assertParamCount 当场抛，于是那次测的是【参数个数对不上】，不是【条件被拿掉】。
    // 诚实的变异必须保留 4 个占位符把条件变成恒真（`(? IS NULL OR 1 = 1)`）：
    // 那样跑 ⇒ 行为 24 全绿，【唯一还红的是这一发】。
    // 所以这一发不是「双保险里的第二道」，它是【这一条性质在本机唯一的守卫】——
    // 而它防的是【两个进程同时写这个库】（§5.4 单写者队列之外唯一剩下的窗口），
    // 那个场景在单进程测试里【造不出来】，只能靠钉形状。
    expect(BURN_TOKEN_SQL).toMatch(/WHERE token = \? AND used = \? AND expires_at > \?/u);
    expect(INSERT_TOKEN_SQL).toMatch(
      /INSERT INTO im_tokens \(token, approval_id, expires_at, used\) VALUES \(\?, \?, \?, \?\)/u,
    );
    // 反向：不许有人把它退回到字符串拼接（0026 §9 那条绑参的理由在这两条 SQL 上同样成立）。
    expect(BURN_TOKEN_SQL).not.toMatch(/used = \d/u);
  });
});
