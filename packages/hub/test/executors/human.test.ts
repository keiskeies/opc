/**
 * human 执行器（T6）的行为判据。
 *
 * ⚠ 夹具走真 WriteQueue + 真迁移（同 approvals/cards.test.ts 的立场）：
 * 去重靠 0006 的部分唯一索引（WHERE card_key IS NOT NULL AND status='pending'），
 * 手搓表测不到「部分」那一半；approvals.task_id 的 FK 也要真 tasks 行。
 *
 * 本文件钉执行器自己的四件事：
 *  ① 建卡成功 = errRun(human_pending)【而不是 done】—— done 会让状态机在
 *     「真人还没看」的时刻前进；message 带 approvalId（err 支没有 card_id 格，
 *     这是 UI 能跳转的全部依据）；库里那张卡逐格对账（type/key/timeout/recommendation）；
 *  ② 同一 execution_id 重投：撞去重键，仍 human_pending，【不产生第二张卡】；
 *  ③ duplicate 的 message 带的是【库里真卡的 id】而不是 insertCard 撞键回执里的
 *     新发 UUID（那是点不开的链接 = 伪证，执行器文件头记的事实）；
 *  ④ 两次尝试各恰好一行 executor_run 审计（同 target 两行 —— 每次尝试独立记账）。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ExecutorRunRequest } from "@opc/contracts";
import { executorRunRequestSchema } from "@opc/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { HumanExecutor } from "../../src/executors/human.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("executors-human", import.meta.url);
mkdirSync(TMP, { recursive: true });

type AnyDb = {
  prepare: (sql: string) => {
    all: (...a: unknown[]) => Record<string, unknown>[];
    get: (...a: unknown[]) => Record<string, unknown> | undefined;
    run: (...a: unknown[]) => unknown;
  };
  exec: (sql: string) => void;
};

const NOW = Date.UTC(2026, 10, 24);
const queues: WriteQueue[] = [];
let fileSeq = 0;

async function newQ(): Promise<{ q: WriteQueue; db: AnyDb }> {
  const path = join(TMP, "hm-" + process.pid + "-" + ++fileSeq + ".db");
  const q = new WriteQueue(path) as WriteQueue;
  queues.push(q);
  const db = (
    q as unknown as { writeConnection: () => AnyDb }
  ).writeConnection();
  migrate(db as never);
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at)" +
      " VALUES ('t1', '任务', 'IN_PROGRESS', 'dev', 'implement', ?, ?)",
  ).run(NOW, NOW);
  return { q, db };
}

afterAll(async () => {
  for (const q of queues) {
    try {
      await (q as unknown as { close?: () => Promise<void> | void }).close?.();
    } catch {
      /* 关掉失败不影响别的 */
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});

function auditRows(db: AnyDb, target: string): Record<string, unknown>[] {
  return db
    .prepare(
      "SELECT id, action, target, payload FROM events WHERE target = ? ORDER BY id",
    )
    .all(target) as unknown as Record<string, unknown>[];
}

function req(over: {
  execution_id: string;
  seq?: number;
  assignee_hint?: string;
}): ExecutorRunRequest {
  return executorRunRequestSchema.parse({
    execution_id: over.execution_id,
    task_id: "t1",
    member_id: "m1",
    role_id: "dev",
    seq: over.seq ?? 1,
    kind: "human",
    config: { kind: "human", assignee_hint: "老板" },
    model_tier: "execution",
    instruction: "这份合同要不要签",
    ...(over.assignee_hint === undefined
      ? {}
      : { assignee_hint: over.assignee_hint }),
  });
}

describe("HumanExecutor", () => {
  it("建卡：errRun(human_pending) 而非 done + message 带 approvalId + 库里卡逐格对账 + 审计恰一行", async () => {
    const { q, db } = await newQ();
    const ex = new HumanExecutor({ writer: q });
    const r = await ex.run(req({ execution_id: "e-h1" }));
    // 终态判据本体：等人的活儿没有产出，done 会让状态机前进 —— 必须是失败支。
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("human 不该返回 done");
    expect(r.code).toBe("human_pending");
    expect(r.retry_next_executor).toBe(true);
    // err 支没有 card_id 格 ⇒ approvalId 只能住在 message 里（UI 跳转的依据）。
    const card = db
      .prepare(
        "SELECT id, task_id, approval_type, summary, parameters, timeout_behavior," +
          " status, card_key FROM approvals WHERE task_id = 't1'",
      )
      .get() as Record<string, unknown> | undefined;
    if (card === undefined) throw new Error("库里没有卡");
    expect(r.message).toContain(String(card.id));
    expect(card.approval_type).toBe("escalation");
    expect(card.card_key).toBe("human:e-h1");
    expect(card.status).toBe("pending");
    // 真人待办永不自动批准：超时行为只能是 escalate。
    expect(card.timeout_behavior).toBe("escalate");
    expect(String(card.summary)).toContain("这份合同要不要签");
    expect(String(card.summary)).toContain("老板");
    const params = JSON.parse(String(card.parameters)) as Record<
      string,
      unknown
    >;
    expect(params.recommendation_is_not_decision).toBe(true);
    expect(params.recommendation).toBe("由真人直接处理本任务");
    expect(params.impact_scope).toBe("manual_review");
    expect(params.irreversible).toBe(false);
    expect(params.timeout_behavior).toBe("escalate");
    const rows = auditRows(db, "executor:e-h1:1");
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(String(rows[0]?.payload)) as Record<
      string,
      unknown
    >;
    expect(payload.code).toBe("human_pending");
  });

  it("同一执行重投：仍 human_pending、不产生第二张卡、message 带真卡 id、审计各一行", async () => {
    const { q, db } = await newQ();
    const ex = new HumanExecutor({ writer: q });
    const r1 = await ex.run(req({ execution_id: "e-h2" }));
    expect(r1.ok).toBe(false);
    if (r1.ok) throw new Error("第一次就该是 human_pending");
    const cards1 = db
      .prepare("SELECT id FROM approvals WHERE task_id = 't1'")
      .all();
    expect(cards1).toHaveLength(1);
    const realId = String(cards1[0]?.id);

    const r2 = await ex.run(req({ execution_id: "e-h2" }));
    expect(r2.ok).toBe(false);
    if (r2.ok) throw new Error("重复投递也该是 human_pending");
    expect(r2.code).toBe("human_pending");
    expect(r2.retry_next_executor).toBe(true);
    // 去重生效：卡片还是恰好一张。
    const cards2 = db
      .prepare("SELECT id FROM approvals WHERE task_id = 't1'")
      .all();
    expect(cards2).toHaveLength(1);
    // duplicate 支的 message 带的是【库里真卡】的 id：insertCard 撞键回执里那个
    // 是新发 UUID，写进 message 就是给 UI 一个点不开的链接。
    expect(r2.message).toContain(realId);

    // 两次尝试同 target（execution_id/seq 相同）⇒ 恰好两行：每次尝试独立记账。
    expect(auditRows(db, "executor:e-h2:1")).toHaveLength(2);
  });
});
