/**
 * 审批超时执行者（src/approvals/timeout.ts，O10）。
 *
 * ── 这一文件在证什么 ──────────────────────────────────────────────────
 * cards.test.ts ⑤ 留下的是一处【写下来的缺席】：timeout_at 落库、超时行为在契约里，
 * 而全仓没有任何代码扫它并行动 ——「到期之后什么都不发生」是当时的诚实答案。
 * O10 补上执行者：到期未决的卡按 timeout_behavior 三档处理：
 *   · auto_reject → status='rejected'，一条 system 审计（不是 human）；
 *   · auto_approve → status='approved'，一条 system 审计；
 *   · escalate     → 原卡保持 pending，新建一张 escalation 卡。
 * 本文件钉的是三件事：到期真的变、审计 actor 不是 human、escalate 有落点。
 *
 * ── 为什么全用真库真迁移 ────────────────────────────────────────────
 * 与 cards.test.ts 同一条：『pending 是认领 SQL 的分母』这类行为是 schema 的事，
 * 手搓表测不到 DEFAULT 'pending'、append-only 触发器与 0004 那条 partial unique index。
 *
 * ── 时钟全部注入 ─────────────────────────────────────────────────────
 * timeout_at 是「两个数相加」；到期判定 `timeout_at <= nowMs` 全靠注入时钟，
 * 用真 Date.now 就只能断言「大概过期」。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createCard, type NewCardDraft } from "../../src/approvals/cards.js";
import { runTimeoutPass } from "../../src/approvals/timeout.js";
import type { DomainEvent } from "../../src/events/bus.js";
import { openDb } from "../../src/db/driver.js";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("approvals-timeout", import.meta.url);
const T0 = Date.parse("2026-03-04T05:06:07.000Z");
const HOUR = 3_600_000;

const opened: Array<{ close(): void }> = [];
const queues: Array<{ close(): Promise<void> }> = [];
let seq = 0;

function fresh(): { path: string; db: DatabaseSync; q: WriteQueue } {
  const path = join(TMP, "timeout-" + ++seq + ".db");
  const db = openDb(path) as unknown as DatabaseSync;
  opened.push(db);
  const q = new WriteQueue(path);
  queues.push(q);
  migrate(db);
  return { path, db, q };
}

function addTask(db: DatabaseSync, id: string): void {
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
      "VALUES (?, ?, 'IN_PROGRESS', 'dev', 'implement', ?, ?)",
  ).run(id, "超时夹具 " + id, T0, T0);
}

/** 一张合契约的卡。`over` 只改 parameters 里的键（顶层形状由契约锁死）。 */
function draft(over: Record<string, unknown> = {}): NewCardDraft {
  return {
    taskId: "t-1",
    approvalType: "strategic",
    summary: "一次可逆的策略决定，等 CEO 一个时限",
    parameters: {
      impact_scope: "测试任务 t-1",
      irreversible: false,
      recommendation: "推荐：批准（推荐，非决定）",
      recommendation_is_not_decision: true,
      timeout_behavior: "auto_reject",
      ...over,
    },
    evidence_refs: ["task:t-1/evidence"],
    buttons: ["approve", "reject_with_comment", "defer_deep_review"],
  } as never;
}

/**
 * 直接落一张到期 pending 卡（timeout_at = T0 - 1ms，nowMs = T0 即到期）。
 *
 * 绕 createCard 是刻意的：超时执行者要处理的是【已经存在】的卡，
 * 不该依赖建卡路径把 timeout_at 写对。返回卡 id。
 */
function insertExpiredCard(
  db: DatabaseSync,
  parameters: Record<string, unknown> = {},
): string {
  const id = "exp-" + (++seq).toString(16) + "-" + Math.random().toString(16).slice(2, 8);
  const shape = draft(parameters);
  db.prepare(
    "INSERT INTO approvals (id, task_id, approval_type, summary, parameters, recommendation, " +
      "recommendation_source, timeout_behavior, timeout_at, status, decided_by, decided_at, " +
      "decision_note, card_key, created_at, evidence_refs) VALUES " +
      "(?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, ?, ?)",
  ).run(
    id,
    shape.taskId,
    shape.approvalType,
    shape.summary,
    JSON.stringify(shape.parameters),
    shape.parameters.recommendation,
    null,
    shape.parameters.timeout_behavior,
    T0 - 1,
    T0,
    JSON.stringify(shape.evidence_refs),
  );
  return id;
}

function eventsFor(db: DatabaseSync, target: string): Array<Record<string, unknown>> {
  return db.prepare("SELECT * FROM events WHERE target = ?").all(target) as Array<
    Record<string, unknown>
  >;
}

afterAll(async () => {
  for (const o of opened) {
    try {
      o.close();
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

mkdirSync(TMP, { recursive: true });

describe("① auto_reject 到期：卡片真的被打回，actor 是 system 不是 human", () => {
  it("⭐ 到期卡 status 变 rejected，审计 actor 是 timeout-executor（system）", async () => {
    const { db, q } = fresh();
    addTask(db, "t-1");
    const id = insertExpiredCard(db, { timeout_behavior: "auto_reject" });

    const published: Array<{ e: DomainEvent; seq: number }> = [];
    const out = await runTimeoutPass(q, db, T0, (e, s) => published.push({ e, seq: s }));

    expect(out.handled).toBe(1);
    expect(out.byBehavior["auto_reject"]).toBe(1);
    expect(out.skippedInvalid).toBe(0);

    const row = db
      .prepare("SELECT status, decided_by, decided_at FROM approvals WHERE id = ?")
      .get(id) as Record<string, unknown>;
    expect(["rejected", "timeout-executor"]).toEqual([row["status"], row["decided_by"]]);

    const ev = eventsFor(db, id);
    expect(ev).toHaveLength(1);
    expect(ev[0]?.["action"]).toBe("approval");
    expect(ev[0]?.["actor_type"]).toBe("system");
    // O10 验收第 3 条：机器决定不许署人的名（0026 §2）。
    expect(ev[0]?.["actor_type"]).not.toBe("human");

    expect(published).toHaveLength(1);
    expect(published[0]?.e.kind).toBe("ApprovalDecided");
    // seq 就是 events.id：publish 的游标与库里的游标对齐（0005 §3）。
    expect(published[0]?.seq).toBe(Number(ev[0]?.["id"]));
  });

  it("未到期（timeout_at 在未来）⇒ 不动，status 仍 pending，零事件", async () => {
    const { db, q } = fresh();
    addTask(db, "t-1");
    const shape = draft({ timeout_behavior: "auto_reject" });
    const id = "future-" + (++seq).toString(16);
    db.prepare(
      "INSERT INTO approvals (id, task_id, approval_type, summary, parameters, recommendation, " +
        "recommendation_source, timeout_behavior, timeout_at, status, created_at, evidence_refs) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
    ).run(
      id, shape.taskId, shape.approvalType, shape.summary,
      JSON.stringify(shape.parameters), shape.parameters.recommendation,
      null, shape.parameters.timeout_behavior, T0 + HOUR, T0,
      JSON.stringify(shape.evidence_refs),
    );

    const out = await runTimeoutPass(q, db, T0);
    expect(out.handled).toBe(0);

    const row = db
      .prepare("SELECT status FROM approvals WHERE id = ?")
      .get(id) as Record<string, unknown>;
    expect(row["status"]).toBe("pending");
    expect(eventsFor(db, id)).toHaveLength(0);
  });

  it("已决定的卡不重复处理：status=approved 的卡即使到期也不动", async () => {
    const { db, q } = fresh();
    addTask(db, "t-1");
    const id = insertExpiredCard(db, { timeout_behavior: "auto_reject" });
    // CEO 刚好在超时器前决定（并发竞态的另一半）。
    db.prepare(
      "UPDATE approvals SET status='approved', decided_by='ceo', decided_at=? WHERE id=?",
    ).run(T0 - 10, id);

    const out = await runTimeoutPass(q, db, T0);
    expect(out.handled).toBe(0);
    const row = db
      .prepare("SELECT status, decided_by FROM approvals WHERE id = ?")
      .get(id) as Record<string, unknown>;
    expect(row["status"]).toBe("approved");
    expect(row["decided_by"]).toBe("ceo");
  });
});

describe("② auto_approve 到期：自动通过，但不可逆+auto_approve 建卡被拒", () => {
  it("⭐ 可逆卡 auto_approve 到期 ⇒ 通过，actor system", async () => {
    const { db, q } = fresh();
    addTask(db, "t-1");
    const id = insertExpiredCard(db, {
      timeout_behavior: "auto_approve",
      irreversible: false,
    });

    const out = await runTimeoutPass(q, db, T0);
    expect(out.handled).toBe(1);
    expect(out.byBehavior["auto_approve"]).toBe(1);

    const row = db
      .prepare("SELECT status, decided_by FROM approvals WHERE id = ?")
      .get(id) as Record<string, unknown>;
    expect(row["status"]).toBe("approved");
    expect(row["decided_by"]).toBe("timeout-executor");
  });

  it("⭐ 不可逆 + auto_approve 建卡被拒（O10 动作 2 拒建判据）", async () => {
    const { db, q } = fresh();
    addTask(db, "t-1");
    await expect(
      createCard(q, {
        taskId: "t-1",
        approvalType: "irreversible_action",
        summary: "一次不可逆的动作",
        parameters: {
          impact_scope: "生产环境",
          irreversible: true,
          recommendation: "推荐：批准（推荐，非决定）",
          recommendation_is_not_decision: true,
          timeout_behavior: "auto_approve",
        },
        evidence_refs: ["task:t-1/evidence"],
        buttons: ["approve", "reject_with_comment", "defer_deep_review"],
      } as NewCardDraft, { nowMs: T0 }),
    ).rejects.toThrow(/auto_approve/u);
    // 库里没有留下任何行（拒建发生在 INSERT 之前）。
    expect(db.prepare("SELECT COUNT(*) AS c FROM approvals").get()).toEqual({ c: 0 });
  });
});

describe("③ escalate 到期：原卡不动，新建一张 escalation 卡", () => {
  it("⭐ 到期 escalate 卡 ⇒ 原卡仍 pending，新卡 approval_type=escalation", async () => {
    const { db, q } = fresh();
    addTask(db, "t-1");
    const id = insertExpiredCard(db, { timeout_behavior: "escalate" });

    const published: Array<{ e: DomainEvent; seq: number }> = [];
    const out = await runTimeoutPass(q, db, T0, (e, s) => published.push({ e, seq: s }));
    expect(out.handled).toBe(1);
    expect(out.byBehavior["escalate"]).toBe(1);

    // 原卡保持 pending
    const orig = db
      .prepare("SELECT status, decided_by FROM approvals WHERE id = ?")
      .get(id) as Record<string, unknown>;
    expect(orig["status"]).toBe("pending");
    expect(orig["decided_by"]).toBeNull();

    // 新卡是 escalation 类型，且带 card_key 去重身份
    const esc = db
      .prepare(
        "SELECT * FROM approvals WHERE id != ? AND approval_type = 'escalation'",
      )
      .get(id) as Record<string, unknown> | undefined;
    expect(esc).toBeDefined();
    expect(esc?.["task_id"]).toBe("t-1");
    expect(String(esc?.["card_key"])).toBe("timeout-escalate:" + id);

    // 事件是 ApprovalRequired（不是 ApprovalDecided）——机器说「有一张新卡等着批」
    expect(published).toHaveLength(1);
    expect(published[0]?.e.kind).toBe("ApprovalRequired");
    // 升级卡的审计 actor 也是 system（机器提出，不是人的决定）。
    const escEvents = eventsFor(db, String(esc?.["id"]));
    expect(escEvents[0]?.["actor_type"]).toBe("system");
  });

  it("同一张到期卡只建一张升级卡（card_key 去重）：第二趟不重复建", async () => {
    const { db, q } = fresh();
    addTask(db, "t-1");
    const id = insertExpiredCard(db, { timeout_behavior: "escalate" });

    const first = await runTimeoutPass(q, db, T0);
    expect(first.byBehavior["escalate"]).toBe(1);

    const second = await runTimeoutPass(q, db, T0);
    // 原卡仍到期 pending ⇒ 仍会被扫到，但去重键挡住，这一趟什么都没写。
    expect(second.handled).toBe(0);

    const count = db
      .prepare("SELECT COUNT(*) AS c FROM approvals WHERE card_key = ?")
      .get("timeout-escalate:" + id) as Record<string, unknown>;
    expect(count["c"]).toBe(1);
  });

  it("任务不存在 ⇒ 不升级不动，也不发事件（那是没法升，不是升级器的错）", async () => {
    const { db, q } = fresh();
    // approvals.task_id 外键关着时，「指向不存在任务」的旁路行根本插不进去 ——
    // 要造的恰恰是【绕过了那条约束】的脏行（FK 只在 connections 级开着，
    // 旁路连接可以关掉它再插）。这就是 applyEscalate 里 `taskRow === undefined`
    // 那道防线在等的输入。
    db.exec("PRAGMA foreign_keys = OFF");
    const id = insertExpiredCard(db, { timeout_behavior: "escalate" });
    db.exec("PRAGMA foreign_keys = ON");
    void id;

    const published: unknown[] = [];
    const out = await runTimeoutPass(q, db, T0, (e) => published.push(e));
    expect(out.handled).toBe(0);
    expect(out.skippedInvalid).toBe(0);
    expect(published).toHaveLength(0);
  });
});

describe("④ 行为取值非法（旁路数据）：数进 skippedInvalid，不假装什么都没发生", () => {
  it("改了契约的超时行为值 ⇒ 数出来、不处理、不发事件", async () => {
    const { db, q } = fresh();
    addTask(db, "t-1");
    const id = insertExpiredCard(db, { timeout_behavior: "auto_reject" });
    // 直接改库：把 timeout_behavior 改成契约外的值（旁路插入才能到这一步）。
    db.prepare("UPDATE approvals SET timeout_behavior = 'explode' WHERE id = ?").run(id);

    const published: unknown[] = [];
    const out = await runTimeoutPass(q, db, T0, (e) => published.push(e));
    expect(out.handled).toBe(0);
    expect(out.skippedInvalid).toBe(1);
    expect(published).toHaveLength(0);
    // 卡的 status 没被乱动。
    const row = db
      .prepare("SELECT status FROM approvals WHERE id = ?")
      .get(id) as Record<string, unknown>;
    expect(row["status"]).toBe("pending");
  });
});
