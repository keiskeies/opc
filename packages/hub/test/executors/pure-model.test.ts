/**
 * pure-model 执行器（T6）的行为判据。
 *
 * ⚠ 夹具走真 WriteQueue + 真迁移（同 plugins/service.test.ts 的立场）：
 * 审计落行走 writer.node → requireScopeDb，手搓假 tx 会让这条结构性消失。
 *
 * 模型侧走 ModelCaller 最小缝的桩（不装 LangChain —— 注入缝的存在理由见
 * 执行器文件头）。本文件钉四条：
 *  ① 没装模型 ⇒ model_unavailable（本执行器是该码的唯一生产者，CLI 三家
 *     不带这条判据，别处找不到）；
 *  ② 有决策块 ⇒ done，summary 来自决策块而不是正文首行（两格来源不同，
 *     拿首行冒充 summary 桩一测就穿）；
 *  ③ 无决策块 ⇒ decision_missing（同为唯一生产者），原文片段进 message；
 *  ④ callModel 抛 ⇒ executor_error 带原话。
 * 四支各自恰好一行 executor_run 审计。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ExecutorRunRequest } from "@opc/contracts";
import { executorRunRequestSchema } from "@opc/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { DECISION_MARK } from "../../src/engine/claude.js";
import {
  type ModelCaller,
  PureModelExecutor,
} from "../../src/executors/pure-model.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("executors-model", import.meta.url);
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
  const path = join(TMP, "pm-" + process.pid + "-" + ++fileSeq + ".db");
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

function req(over: { execution_id: string; seq?: number }): ExecutorRunRequest {
  return executorRunRequestSchema.parse({
    execution_id: over.execution_id,
    task_id: "t1",
    member_id: "m1",
    role_id: "dev",
    seq: over.seq ?? 1,
    kind: "pure-model",
    config: { kind: "pure-model" },
    model_tier: "management",
    instruction: "评估这份方案",
    role_prompt: "你是总监",
  });
}

describe("PureModelExecutor", () => {
  it("未装模型：model_unavailable + retry true + 审计恰一行", async () => {
    const { q, db } = await newQ();
    const ex = new PureModelExecutor({ writer: q });
    const r = await ex.run(req({ execution_id: "e-pm-none" }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("期望失败回执");
    expect(r.code).toBe("model_unavailable");
    expect(r.retry_next_executor).toBe(true);
    const rows = auditRows(db, "executor:e-pm-none:1");
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(String(rows[0]?.payload)) as Record<
      string,
      unknown
    >;
    expect(payload.code).toBe("model_unavailable");
  });

  it("带决策块：done 且 summary 来自决策块（不是正文首行）+ 参数透传 + 审计恰一行", async () => {
    const { q, db } = await newQ();
    const seen: {
      model_tier: string;
      instruction: string;
      role_prompt: string;
    }[] = [];
    const callModel: ModelCaller = async (p) => {
      seen.push(p);
      return {
        text:
          "正文首行不该当摘要\n第二段说明\n" +
          DECISION_MARK +
          '\n{"action":"pass","summary":"方案可行，放行"}',
      };
    };
    const ex = new PureModelExecutor({ writer: q, callModel });
    const r = await ex.run(req({ execution_id: "e-pm-ok" }));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("期望 done 回执");
    expect(r.summary).toBe("方案可行，放行");
    expect(r.text).toContain(DECISION_MARK);
    // 最小缝三格原样透传（档位/指令/角色提示，装配方拼提示词的原料不缺料）。
    const first = seen[0];
    if (first === undefined) throw new Error("桩模型没被调用");
    expect(first).toEqual({
      model_tier: "management",
      instruction: "评估这份方案",
      role_prompt: "你是总监",
    });
    const rows = auditRows(db, "executor:e-pm-ok:1");
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(String(rows[0]?.payload)) as Record<
      string,
      unknown
    >;
    expect(payload.summary).toBe("方案可行，放行");
  });

  it("无决策块：decision_missing + 原文片段进 message + retry true", async () => {
    const { q, db } = await newQ();
    const callModel: ModelCaller = async () => ({
      text: "我觉得\n还要再想想 没写结论",
    });
    const ex = new PureModelExecutor({ writer: q, callModel });
    const r = await ex.run(req({ execution_id: "e-pm-nod" }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("期望失败回执");
    expect(r.code).toBe("decision_missing");
    expect(r.retry_next_executor).toBe(true);
    // 「模型到底吐了什么」是这条失败唯一的现场证据：折叠空白后原话要在 message 里。
    expect(r.message).toContain("我觉得 还要再想想 没写结论");
    expect(auditRows(db, "executor:e-pm-nod:1")).toHaveLength(1);
  });

  it("callModel 抛：executor_error 带原话 + retry true + 审计恰一行", async () => {
    const { q, db } = await newQ();
    const callModel: ModelCaller = async () => {
      throw new Error("配额爆了");
    };
    const ex = new PureModelExecutor({ writer: q, callModel });
    const r = await ex.run(req({ execution_id: "e-pm-throw" }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("期望失败回执");
    expect(r.code).toBe("executor_error");
    expect(r.message).toContain("配额爆了");
    expect(r.retry_next_executor).toBe(true);
    expect(auditRows(db, "executor:e-pm-throw:1")).toHaveLength(1);
  });
});
