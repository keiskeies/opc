/**
 * 审批卡片的创建路径（src/approvals/cards.ts + 迁移 0004）。
 *
 * ── 这一文件在证什么 ──────────────────────────────────────────────────
 * 0013 §10.1 实测：src 里【零】`INSERT INTO approvals`，唯一的两处写是 UPDATE。
 * 也就是说 approvals 那整条读侧（POST /approvals/:id、countSimilarApprovals、
 * role-memory 的战略档判据）一直建在【只有夹具往里写】的表上。
 * 本文件要证的是「写这一侧现在真的存在，而且形状对」，具体拆成五格：
 *   ① 建得出：一张卡 + 一条事件，同事务，字段各归各位；
 *   ② 去重：同一个决定不会长出第二张卡，而【不同决定】不能被误合成一张；
 *   ③ 契约拦得住：少一行 / 多一个按钮 / 一个错误的 approval_type 都建不出来；
 *   ④ 下游立刻能用：两处此前恒空/恒 UNKNOWN 的读法当场拿到真值；
 *   ⑤ 一处【写下来的缺席】：timeout_at 有值而没有任何执行者。
 *
 * ── 为什么全用真库真迁移 ────────────────────────────────────────────
 * 这一篇的核心断言里有三条是【schema 的行为】而不是 JS 逻辑：
 *   · 去重靠 0004 那条 partial unique index —— 手搓表测不到「部分」那一半；
 *   · `parameters` 落库后要被下游 `JSON.parse` 读回来（0013 的检索链）；
 *   · 外键必须真的生效（`foreign_keys=ON` 是 pragmas.ts 设的）。
 * 手搓一张长得像的表，这三条会同时对着一个不存在的世界成立（同一理由见
 * patrol.test.ts 文件头）。
 *
 * ── 夹具目录带 pid ─────────────────────────────────────────────────
 * 0025 §7 末条记的那次「63 fail 假警报」的成因是固定路径夹具 +
 * `beforeAll` 整目录 rmSync ⇒ 两路全量互删。那 24 个文件的整改留给独立一篇，
 * 但【新写的文件没有理由继续制造同一个坑】：目录带 pid，删的也只有自己那几个文件。
 *
 * ── 时钟全部注入 ───────────────────────────────────────────────────
 * `timeout_at` 与 `created_at` 都是「两个数相加」。用真 Date.now 就只能断言
 * 「大于现在」，而那条断言对「加错了单位」完全无感（8 小时 vs 8 毫秒都大于现在）。
 */
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import {
  approvalRequiredEvent,
  APPROVAL_TYPES,
  createCard,
  DEFAULT_TIMEOUT_HOURS,
  draftFromEscalation,
  INSERT_CARD_SQL,
  insertCard,
  isUniqueCardKeyViolation,
  parametersFor,
  SQLITE_CONSTRAINT_UNIQUE,
  timeoutAtMs,
} from "../../src/approvals/cards.js";
import { decideEscalation, type EscalationState } from "../../src/graph/routing/escalation.js";
import { openDb } from "../../src/db/driver.js";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { countSimilarApprovals } from "../../src/policy/auto-approve.js";

const HUB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TMP = join(HUB, ".tmp", "approvals-" + process.pid);

/** 一个不像「现在」的时刻：真时钟永远不等于它，所以「用了真时钟」会被抓到。 */
const T0 = Date.parse("2026-03-04T05:06:07.000Z");
const HOUR = 3_600_000;

const opened: Array<{ close(): void }> = [];
let seq = 0;

function fresh(): { path: string; db: DatabaseSync; q: WriteQueue } {
  const path = join(TMP, "ap-" + ++seq + ".db");
  const db = openDb(path) as unknown as DatabaseSync;
  opened.push(db);
  migrate(db);
  return { path, db, q: new WriteQueue(path) };
}

function addTask(db: DatabaseSync, id: string): void {
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
      "VALUES (?, ?, 'IN_PROGRESS', 'dev', 'implement', ?, ?)",
  ).run(id, "建卡夹具 " + id, T0, T0);
}

/** 一张合契约的卡。改任何一格都应当在上面那五格里红一条。 */
function draft(over: Record<string, unknown> = {}) {
  return {
    taskId: "t-1",
    approvalType: "escalation",
    summary: "开发完成支付模块，覆盖率 92%，等确认是否接受 3 个 P2 上线",
    parameters: {
      impact_scope: "生产环境支付模块",
      irreversible: true,
      recommendation: "推荐：先给出可回滚的替代路径再批（推荐，非决定）",
      recommendation_is_not_decision: true,
      timeout_behavior: "auto_reject",
    },
    evidence_refs: ["task:t-1/evidence"],
    buttons: ["approve", "reject_with_comment", "defer_deep_review"],
    ...over,
  } as never;
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

describe("① 建得出：卡片与审计同事务，字段各归各位", () => {
  it("⭐ 建一张卡 ⇒ 一行 pending + 一条 approval 审计，两边指认同一张卡", async () => {
    const { db, q } = fresh();
    addTask(db, "t-1");
    const r = await createCard(q, draft(), { nowMs: T0 });
    expect(r.result.created).toBe(true);

    const card = db
      .prepare("SELECT * FROM approvals WHERE id = ?")
      .get(r.result.approvalId) as Record<string, unknown>;
    expect(card["status"]).toBe("pending");
    expect(card["task_id"]).toBe("t-1");
    expect(card["approval_type"]).toBe("escalation");
    expect(JSON.parse(String(card["parameters"]))["impact_scope"]).toBe(
      "生产环境支付模块",
    );

    const ev = db
      .prepare("SELECT * FROM events WHERE target = ?")
      .get(r.result.approvalId) as Record<string, unknown>;
    expect(ev["action"]).toBe("approval");
    expect(ev["actor_type"]).toBe("system");
    expect(ev["task_id"]).toBe("t-1");
    // seq 就是 events.id（0005 §3）：调用方拿它 publishPersisted，两个数不等就意味着
    // 广播的游标与库里的游标不可比，断线重连必然漏或重。
    expect(r.seq).toBe(Number(ev["id"]));
  });

  it("⭐ 决策侧四列必须是 NULL —— 不是「好看」，是 CLAIM_APPROVAL_SQL 的分母", async () => {
    const { db, q } = fresh();
    addTask(db, "t-1");
    const r = await createCard(q, draft(), { nowMs: T0 });
    const card = db
      .prepare("SELECT status, decided_by, decided_at, decision_note FROM approvals WHERE id = ?")
      .get(r.result.approvalId) as Record<string, unknown>;
    expect([card["status"], card["decided_by"], card["decided_at"], card["decision_note"]]).toEqual([
      "pending",
      null,
      null,
      null,
    ]);
    // 反向对照：建出来的这张卡必须【能被现有的两条认领 SQL 抢到】。
    // 「初值是 NULL」这句话本身不推进任何东西，能配上才是性质。
    const info = db
      .prepare(
        "UPDATE approvals SET status = 'approved', decided_by = 'ceo', decided_at = ?, " +
          "decision_note = '上线' WHERE id = ? AND status = 'pending'",
      )
      .run(T0 + HOUR, r.result.approvalId);
    expect(Number(info.changes)).toBe(1);
  });

  it("⭐ created_at 落的是【注入的那个时刻】，不是真时钟", async () => {
    /*
     * approvals 原本【十三列里一个创建时刻都没有】（0001）：有 decided_at、有
     * timeout_at，而「这张卡挂了多久」的那个起点从来没落过库。补这一列之后，
     * 它必须来自注入的 nowMs —— 用真 Date.now 的话这条断言只能写成「大于 0」，
     * 而那种断言对「时区/单位写错」完全无感（同一条理由见本文件头的时钟段）。
     */
    const { db, q } = fresh();
    addTask(db, "t-1");
    const r = await createCard(q, draft(), { nowMs: T0 });
    const at = db
      .prepare("SELECT created_at FROM approvals WHERE id = ?")
      .get(r.result.approvalId)["created_at"];
    expect(Number(at)).toBe(T0);
  });

  it("recommendation_source 没有出处时落 NULL，不编一个「总监层」", async () => {
    const { db, q } = fresh();
    addTask(db, "t-1");
    const noSource = await createCard(q, draft(), { nowMs: T0 });
    const withSource = await createCard(q, draft({ cardKey: "k-src" }), {
      nowMs: T0,
      recommendationSource: "tech_director",
    });
    const get = (id: string): unknown =>
      db
        .prepare("SELECT recommendation_source FROM approvals WHERE id = ?")
        .get(id)["recommendation_source"];
    expect(get(noSource.result.approvalId)).toBeNull();
    expect(get(withSource.result.approvalId)).toBe("tech_director");
  });

  it("⭐ 卡片建不出来时【一条审计都不写】（事务回滚，不是留下半套）", async () => {
    const { db, q } = fresh();
    addTask(db, "t-1");
    // 任务不存在 ⇒ 外键抛 ⇒ 那一发 node() 整体回滚。
    // 这里断言的不是「抛错」（那太容易绿），是【抛完之后库里干净】：
    // 半套状态（事件有、卡没有）是回放对不上账时唯一查不出来的那种。
    await expect(
      createCard(q, draft({ taskId: "nope" }), { nowMs: T0 }),
    ).rejects.toThrow(/FOREIGN KEY|FOREIGN KEY constraint/iu);
    expect(Number(db.prepare("SELECT COUNT(*) AS n FROM approvals").get()["n"])).toBe(0);
    expect(Number(db.prepare("SELECT COUNT(*) AS n FROM events").get()["n"])).toBe(0);
  });

  it("撞去重键 ⇒ 事件也不写（否则审计里多一次【没发生过的】「需要批准」）", async () => {
    const { db, q } = fresh();
    addTask(db, "t-1");
    const first = await createCard(q, draft({ cardKey: "gate-1" }), { nowMs: T0 });
    const second = await createCard(q, draft({ cardKey: "gate-1" }), { nowMs: T0 + HOUR });
    expect(first.result.created).toBe(true);
    expect(second.result.created).toBe(false);
    expect(second.result.skipped).toBe("duplicate");
    expect(second.event).toBeNull();
    expect(second.seq).toBeNull();
    expect(Number(db.prepare("SELECT COUNT(*) AS n FROM events").get()["n"])).toBe(1);
  });
});

describe("② 去重：同一个决定一张卡，而不同决定不能被合成一张", () => {
  it("⭐ 同一个 (task, cardKey) 只有一张【待批】卡", async () => {
    const { db, q } = fresh();
    addTask(db, "t-1");
    for (let i = 0; i < 3; i++) {
      await createCard(q, draft({ cardKey: "gate-1" }), { nowMs: T0 + i * HOUR });
    }
    expect(Number(db.prepare("SELECT COUNT(*) AS n FROM approvals").get()["n"])).toBe(1);
  });

  it("⭐ 反向对照：同任务、【不同 key】必须各建一张 —— 合并比重复贵", async () => {
    /*
     * 这一发是②的全部意义。若实现拿 task_id 或 summary 当去重键，
     * ①②前几发全都绿（它们只建一张卡），只有这里红。
     * 而「合成一张」的后果不是吵，是【吞掉一个决定且不留痕迹】：
     * §8.3 明确允许同一个任务多次升级（两次不同的不可逆动作）。
     */
    const { db, q } = fresh();
    addTask(db, "t-1");
    await createCard(q, draft({ cardKey: "gate-a", summary: "第一次" }), { nowMs: T0 });
    await createCard(q, draft({ cardKey: "gate-b", summary: "第一次" }), { nowMs: T0 });
    expect(Number(db.prepare("SELECT COUNT(*) AS n FROM approvals").get()["n"])).toBe(2);
  });

  it("不传 cardKey ⇒ 不去重（显式选择），但它不去重的是【别的】卡", async () => {
    const { db, q } = fresh();
    addTask(db, "t-1");
    await createCard(q, draft(), { nowMs: T0 });
    await createCard(q, draft(), { nowMs: T0 });
    expect(Number(db.prepare("SELECT COUNT(*) AS n FROM approvals").get()["n"])).toBe(2);
    // 反向：NULL 不去重 ≠ 唯一性整体失效。带 key 的那条路仍然被挡。
    await createCard(q, draft({ cardKey: "k" }), { nowMs: T0 });
    const dup = await createCard(q, draft({ cardKey: "k" }), { nowMs: T0 });
    expect(dup.result.skipped).toBe("duplicate");
  });

  it("⭐ 两个任务上的同名 key 互不挡（身份的作用域是【任务内】）", async () => {
    const { db, q } = fresh();
    addTask(db, "t-1");
    addTask(db, "t-2");
    const a = await createCard(q, draft({ cardKey: "round-3" }), { nowMs: T0 });
    const b = await createCard(q, draft({ taskId: "t-2", cardKey: "round-3" }), { nowMs: T0 });
    expect([a.result.created, b.result.created]).toEqual([true, true]);
  });

  it("⭐ 去重由【索引】保证而不是由注释保证：绕过 createCard 直接写也挡得住", () => {
    /*
     * 0025 §2 实测过「第二个 WriteQueue 空闲时照写」—— 也就是说「大家都走队列」
     * 是一条【约定】。这一发证的是它是【性质】：拿一条裸连接、完全绕开本模块，
     * 第二次仍然写不进去。去掉 0004 那条索引，这一发红。
     */
    const { db } = fresh();
    addTask(db, "t-1");
    const params = (id: string): unknown[] => [
      id,
      "t-1",
      "escalation",
      "s",
      "{}",
      null,
      null,
      "escalate",
      T0 + DEFAULT_TIMEOUT_HOURS * HOUR,
      "pending",
      null,
      null,
      null,
      "same-key",
      T0,
    ];
    expect(() => db.prepare(INSERT_CARD_SQL).run(...(params("c1") as never[]))).not.toThrow();
    expect(() => db.prepare(INSERT_CARD_SQL).run(...(params("c2") as never[]))).toThrow(
      /UNIQUE constraint failed/u,
    );
  });
});

describe("③ 契约拦得住：§9.2 那三条硬约束不是注释", () => {
  it("缺 evidence_refs ⇒ 抛（第三行不在，卡片点不开）", async () => {
    const { db, q } = fresh();
    addTask(db, "t-1");
    await expect(
      createCard(q, draft({ evidence_refs: [] }), { nowMs: T0 }),
    ).rejects.toThrow(/evidence_refs/u);
    expect(Number(db.prepare("SELECT COUNT(*) AS n FROM approvals").get()["n"])).toBe(0);
  });

  it("⭐ 第四个按钮 ⇒ 抛（§8.2 第 4 条「不可绕过」由 schema 的 .length(3) 落地）", async () => {
    const { db, q } = fresh();
    addTask(db, "t-1");
    await expect(
      createCard(
        q,
        draft({ buttons: ["approve", "reject_with_comment", "defer_deep_review", "approve_all"] }),
        { nowMs: T0 },
      ),
    ).rejects.toThrow(/buttons/u);
  });

  it("「推荐，非决定」标志位缺失 ⇒ 抛（漏标是让 CEO 把推荐读成结论）", async () => {
    const { db, q } = fresh();
    addTask(db, "t-1");
    const bad = draft();
    (bad.parameters as Record<string, unknown>)["recommendation_is_not_decision"] = false;
    await expect(createCard(q, bad, { nowMs: T0 })).rejects.toThrow(
      /recommendation_is_not_decision/u,
    );
  });

  it("⭐ 不在 APPROVAL_TYPES 里的类型 ⇒ 抛，而不是静静落一个错值", async () => {
    /*
     * 落一个错值的症状是【静默少一类】：role-memory 的战略档判据与
     * countSimilarApprovals 的同类口径都按 approval_type 精确匹配，
     * 拼错的类型不会报错，只会【两类统计都不出现】。
     */
    const { db, q } = fresh();
    addTask(db, "t-1");
    await expect(
      createCard(q, draft({ approvalType: "strategc" }), { nowMs: T0 }),
    ).rejects.toThrow(/approval_type 取值非法/u);
    expect(Number(db.prepare("SELECT COUNT(*) AS n FROM approvals").get()["n"])).toBe(0);
    // 反向：六个合法取值全部建得出来（少一格会在上面那发的反向对照里红）。
    for (const t of APPROVAL_TYPES) {
      const r = await createCard(q, draft({ approvalType: t, cardKey: "k-" + t }), { nowMs: T0 });
      expect(r.result.created, "类型 " + t + " 建不出来").toBe(true);
    }
  });

  it("落库前的喂参只有那四个字段（把整份 draft 喂给 .strict() 会自己拒自己）", () => {
    /*
     * 这一发钉的是我自己写错的那版：`safeParse(draft)` 会被 .strict() 以
     * 「未知键 taskId / approvalType / cardKey」整体拒绝 ⇒ 每次建卡都抛契约错。
     * 它不会在任何「测建卡」的用例里暴露成「建不出来」以外的形状，
     * 所以直接钉住「带落库列的完整 draft 是喂得进去的」这一条。
     */
    const { db } = fresh();
    addTask(db, "t-1");
    expect(() =>
      insertCard(db, draft({ cardKey: "k-strict" }) as never, { nowMs: T0 }),
    ).not.toThrow();
  });
});

describe("④ 下游立刻能用：两处此前恒空/恒 UNKNOWN 的读法拿到真值", () => {
  it("⭐ countSimilarApprovals 不再恒 0（它此前在真库上永远返回 0/0）", async () => {
    const { db, q } = fresh();
    addTask(db, "t-1");
    const a = await createCard(q, draft({ cardKey: "k1" }), { nowMs: T0 });
    const b = await createCard(q, draft({ cardKey: "k2" }), { nowMs: T0 });
    expect(countSimilarApprovals(db, { approvalType: "escalation" })).toEqual({
      approvals: 0,
      nonApprovals: 0,
    });
    db.prepare(
      "UPDATE approvals SET status = 'approved' WHERE id = ?",
    ).run(a.result.approvalId);
    db.prepare("UPDATE approvals SET status = 'rejected' WHERE id = ?").run(
      b.result.approvalId,
    );
    expect(countSimilarApprovals(db, { approvalType: "escalation" })).toEqual({
      approvals: 1,
      nonApprovals: 1,
    });
    // 反向：别的类型仍然 0 —— 否则「拿到真值」可能只是「什么都算进去」。
    expect(countSimilarApprovals(db, { approvalType: "charter" })).toEqual({
      approvals: 0,
      nonApprovals: 0,
    });
  });

  it("⭐ 事件 payload 带 kind=ApprovalRequired ⇒ role-memory 不会把它读成一次【决定】", async () => {
    /*
     * role-memory 靠 payload.kind 区分「有人被要求批准」与「有人做了决定」，
     * 而它【解不出来时保留】（失败方向是保留）。所以少带 kind 不报错 ——
     * 后果是一条「要求批准」进了角色的 few-shot 记忆，告诉模型「有人问过这件事」
     * 而不给任何结论。这一发断言的是【载荷里有那个键且取值正确】。
     */
    const { db } = fresh();
    addTask(db, "t-1");
    const r = db
      .prepare("SELECT payload FROM events LIMIT 0")
      .all() as unknown[];
    expect(r).toEqual([]);
    const e = approvalRequiredEvent("t-1", "card-1", draft() as never, "escalation");
    expect(e.kind).toBe("ApprovalRequired");
    const payload = e.payload as Record<string, unknown>;
    expect(payload["kind"]).toBe("ApprovalRequired");
    expect(payload["approval_type"]).toBe("escalation");
    expect(payload["summary"]).toBe(draft().summary);
  });

  it("升级原因落进 parameters.escalation，而不是混进给人读的那一行", async () => {
    const { db, q } = fresh();
    addTask(db, "t-1");
    const s: EscalationState = {
      taskId: "t-1",
      state: "IN_REVIEW",
      riskTier: "irreversible",
      confidence: 0.1,
      confidenceFloor: 0.4,
    };
    const r = decideEscalation(s);
    expect(r.escalate).toBe(true);
    if (r.escalate !== true) throw new Error("夹具应当命中升级");
    const created = await createCard(
      q,
      draftFromEscalation(s, r, "step-7"),
      { nowMs: T0, recommendationSource: "tech_director" },
    );
    const row = db
      .prepare("SELECT * FROM approvals WHERE id = ?")
      .get(created.result.approvalId) as Record<string, unknown>;
    const p = JSON.parse(String(row["parameters"])) as Record<string, unknown>;
    expect(p["escalation"]).toEqual({ reason: "irreversible_action", also: ["low_confidence"] });
    // summary 里【只有】人话，没有枚举名 —— 否则「按原因统计」变成中文匹配。
    expect(String(row["summary"])).not.toContain("irreversible_action");
    expect(row["recommendation"]).toBe(
      "推荐：先让开发给出可回滚的替代路径再批（推荐，非决定）",
    );
  });

  it("parametersFor 不污染契约那四个键，也不给不带 reason 的卡加空壳", () => {
    const d = draft() as never;
    const withReason = parametersFor(d, { reason: "budget_threshold", also: [] });
    expect(withReason["escalation"]).toEqual({ reason: "budget_threshold" });
    expect(parametersFor(d)["escalation"]).toBeUndefined();
    // 契约那几个键原样在（并一层不能把它们盖掉）。
    expect(withReason["impact_scope"]).toBe("生产环境支付模块");
  });
});

describe("⑤ 一处【写下来的缺席】：timeout_at 有值，而没有任何执行者", () => {
  it("⭐ 到期时刻落库了（它是将来任何超时策略的事实依据，写了不可改）", async () => {
    const { db, q } = fresh();
    addTask(db, "t-1");
    const r = await createCard(q, draft(), { nowMs: T0 });
    const at = db
      .prepare("SELECT timeout_at, timeout_behavior FROM approvals WHERE id = ?")
      .get(r.result.approvalId) as Record<string, unknown>;
    expect(Number(at["timeout_at"])).toBe(T0 + DEFAULT_TIMEOUT_HOURS * HOUR);
    expect(at["timeout_behavior"]).toBe("auto_reject");
  });

  it("⭐ 到期之后【什么都不发生】：巡检跑过、时间推过，卡片还是 pending", async () => {
    /*
     * 这一发是一个【断言缺席】，它的价值在方向：将来有人接上超时执行者时它会红，
     * 逼他先去回答 0026 §2 那三问（自动批？自动拒？只提醒？）。
     * 所以它不是「测了个空」，是把「没有执行者」这件事变成一条会过期的性质。
     *
     * 巡检这一发是【必要的排除】：只推时钟不跑巡检，红的可能只是「没人醒过」，
     * 而那与「没有超时逻辑」是两件事。跑一轮 patrolTasks 证的是
     * 「整条心跳链在到期卡片存在时照常跑完，且没碰那张卡」。
     */
    const { db, q } = fresh();
    addTask(db, "t-1");
    const r = await createCard(q, draft(), { nowMs: T0 });
    // 挂一张未决审批 ⇒ patrol 的 human_hold 分支本来就免检（那是 timeout 的活）。
    const { patrolTasks } = await import("../../src/heartbeat/patrol.js");
    const before = patrolTasks(db, { now: () => T0 + 100 * HOUR });
    expect(before.find((j) => j.id === "t-1")?.verdict).toBe("human_hold");
    const row = db
      .prepare("SELECT status, decided_by FROM approvals WHERE id = ?")
      .get(r.result.approvalId) as Record<string, unknown>;
    expect(row["status"]).toBe("pending");
    expect(row["decided_by"]).toBeNull();
  });

  it("timeoutHours 是 NaN 时抛，而不是把 timeout_at 写成 NULL", () => {
    // 「没设超时」与「超时算错了」在库里长得一模一样（NULL），这是最难读的一种脏数据。
    expect(() => timeoutAtMs(T0, Number.NaN)).toThrow(/非负有限/u);
    expect(() => timeoutAtMs(T0, -1)).toThrow(/非负有限/u);
    expect(timeoutAtMs(T0, 0)).toBe(T0);
  });

  it("约束识别只认 UNIQUE：外键冲突必须仍然抛", () => {
    expect(
      isUniqueCardKeyViolation(new Error("UNIQUE constraint failed: approvals.task_id, approvals.card_key")),
    ).toBe(true);
    expect(isUniqueCardKeyViolation(new Error("FOREIGN KEY constraint failed"))).toBe(false);
    expect(isUniqueCardKeyViolation({ errcode: SQLITE_CONSTRAINT_UNIQUE })).toBe(true);
    expect(isUniqueCardKeyViolation(new Error("no such table: approvals"))).toBe(false);
  });
});
