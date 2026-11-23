/**
 * 执行器路由器（T6）runExecutions 的行为判据。
 *
 * ⚠ 夹具走真 WriteQueue + 真迁移（同 members/service.test.ts 的立场）：
 * 路由读走 writer.node → requireScopeDb，手搓假 tx 会让这条结构性消失。
 *
 * 假执行器一律 { kind, run: vi.fn() }，run 里【故意不写审计】——
 * 文件末那两条审计判据就是拿这套假件钉「router 不代写」：
 * 假件全程不写 ⇒ events 里 executor_run 恒零行；换成故意写的那份 ⇒ 恰好各一行。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  ExecutionTarget,
  ExecutorFailureCode,
  ExecutorKind,
  ExecutorRunOutcome,
  ExecutorRunRequest,
} from "@opc/contracts";
import { afterAll, describe, expect, it, vi } from "vitest";
import { requireScopeDb } from "../../src/checkpoint/tx-scope.js";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { ExecutorRegistry } from "../../src/executors/registry.js";
import { runExecutions } from "../../src/executors/run.js";
import {
  auditExecutorRun,
  type Executor,
  errRun,
  okRun,
} from "../../src/executors/types.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("executors-run", import.meta.url);
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

/** 真库：迁移 + 一条成员 + 一条 task（events.task_id 有 FK，审计用例要真 task）。 */
async function newQ(): Promise<{ q: WriteQueue; db: AnyDb }> {
  const path = join(TMP, "ex-" + process.pid + "-" + ++fileSeq + ".db");
  const q = new WriteQueue(path) as WriteQueue;
  queues.push(q);
  const db = (
    q as unknown as { writeConnection: () => AnyDb }
  ).writeConnection();
  migrate(db as never);
  db.prepare(
    "INSERT INTO members (member_id, name, role_id, persona_json, model_tier," +
      " avatar_asset_id, avatar_seed, voice_json, tone, status, hired_at, updated_at)" +
      " VALUES ('m1', '测试员', 'dev', ?, 'execution', NULL, '', NULL, 'direct'," +
      " 'active', ?, ?)",
  ).run(
    JSON.stringify({
      style: "先读代码再下结论",
      values: ["实测"],
      honesty: "不确定就说明",
    }),
    NOW,
    NOW,
  );
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at)" +
      " VALUES ('t1', '任务', 'draft', 'dev', 'start', ?, ?)",
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

/** 往路由表插一行（configJson 原样入列 —— 坏 JSON 用例就是要坏串进去）。 */
function insertExec(
  db: AnyDb,
  seq: number,
  kind: string,
  configJson: string,
  enabled = 1,
): void {
  db.prepare(
    "INSERT INTO member_executors (member_id, seq, kind, config_json, enabled)" +
      " VALUES ('m1', ?, ?, ?, ?)",
  ).run(seq, kind, configJson, enabled);
}

/** 一份合规 target（overrides 逐用例覆盖；条件展开伺候 exactOptionalPropertyTypes）。 */
function target(over: Partial<ExecutionTarget> = {}): ExecutionTarget {
  return {
    task_id: over.task_id ?? "t1",
    member_id: over.member_id ?? "m1",
    role_id: over.role_id ?? "dev",
    model_tier: over.model_tier ?? "execution",
    instruction: over.instruction ?? "把按钮文案改掉",
    role_prompt: over.role_prompt ?? "你是开发工程师",
    max_budget_usd: over.max_budget_usd ?? 0,
    from_seq: over.from_seq ?? 1,
    ...(over.workspace === undefined ? {} : { workspace: over.workspace }),
    ...(over.timeout_ms === undefined ? {} : { timeout_ms: over.timeout_ms }),
  };
}

/** 成功回执的假执行器：run 记调用、返回 okRun，【不写审计】（判据要靠它钉零行）。 */
function okExecutor(
  kind: ExecutorKind,
): Executor & { run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async (req: ExecutorRunRequest) =>
    okRun(req, { text: "done", summary: "干完了" }),
  );
  return { kind, run };
}

/** 失败回执的假执行器（retry 由用例给）。 */
function failExecutor(
  kind: ExecutorKind,
  retry: boolean,
  code: ExecutorFailureCode = "cli_failed",
): Executor & { run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async (req: ExecutorRunRequest) =>
    errRun(req, {
      code,
      message: "干不动",
      retry_next_executor: retry,
    }),
  );
  return { kind, run };
}

/** 违约假执行器：契约说 run 永不 reject，这里偏抛 —— 钉路由器的防御性兜底。 */
function throwerExecutor(
  kind: ExecutorKind,
): Executor & { run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async () => {
    throw new Error("我违约了");
  });
  return { kind, run };
}

/** events 里的 executor_run 行数（payload.kind 认领，与 types.ts 口径一致）。 */
function executorRunRows(db: AnyDb): Record<string, unknown>[] {
  return db
    .prepare("SELECT id, payload FROM events ORDER BY id")
    .all()
    .filter((r) => {
      const p = JSON.parse(String(r.payload)) as { kind?: string };
      return p.kind === "executor_run";
    });
}

describe("runExecutions", () => {
  it("把当前成员 persona 追加到岗位提示，且不替换原岗位身份", async () => {
    const { q, db } = await newQ();
    insertExec(db, 1, "pure-model", '{"kind":"pure-model"}');
    const executor = okExecutor("pure-model");
    await runExecutions(target({ role_prompt: "你是开发工程师" }), {
      writer: q,
      registry: new ExecutorRegistry([executor]),
    });
    const request = executor.run.mock.calls[0]?.[0] as ExecutorRunRequest;
    expect(request.role_prompt).toContain("你是开发工程师");
    expect(request.role_prompt).toContain("数字同事「测试员」");
    expect(request.role_prompt).toContain("先读代码再下结论");
    expect(request.role_prompt).toContain("不得改变岗位书权限");
  });

  it("seq1 失败 retry=true → seq2 成功：attempts 2、final ok、第二次 request.seq=2", async () => {
    const { q, db } = await newQ();
    insertExec(db, 1, "pure-model", '{"kind":"pure-model"}');
    insertExec(db, 2, "human", '{"kind":"human"}');
    const f1 = failExecutor("pure-model", true);
    const f2 = okExecutor("human");
    const r = await runExecutions(target(), {
      writer: q,
      registry: new ExecutorRegistry([f1, f2]),
    });
    expect(r.ok).toBe(true);
    expect(r.attempts).toHaveLength(2);
    expect(r.attempts[0]?.ok).toBe(false);
    expect(r.final?.ok).toBe(true);
    expect(f1.run).toHaveBeenCalledTimes(1);
    expect(f2.run).toHaveBeenCalledTimes(1);
    // 第二次尝试的请求带的是第二格的 seq —— 尝试链在请求侧也可指认。
    const secondCall = f2.run.mock.calls[0]?.[0] as
      | ExecutorRunRequest
      | undefined;
    if (secondCall === undefined) throw new Error("human 假执行器没被调到");
    expect(secondCall.seq).toBe(2);
    expect(secondCall.execution_id).toBe("exec:t1:2");
  });

  it("retry=false 即停：第三行存在但不跑", async () => {
    const { q, db } = await newQ();
    insertExec(db, 1, "pure-model", '{"kind":"pure-model"}');
    insertExec(db, 2, "human", '{"kind":"human"}');
    insertExec(db, 3, "claude-cli", '{"kind":"claude-cli"}');
    const f1 = failExecutor("pure-model", false);
    const f2 = okExecutor("human");
    const f3 = okExecutor("claude-cli");
    const r = await runExecutions(target({ workspace: "D:/x" }), {
      writer: q,
      registry: new ExecutorRegistry([f1, f2, f3]),
    });
    expect(r.ok).toBe(false);
    expect(r.attempts).toHaveLength(1);
    expect(f1.run).toHaveBeenCalledTimes(1);
    expect(f2.run).not.toHaveBeenCalled();
    expect(f3.run).not.toHaveBeenCalled();
  });

  it("全部失败：ok=false、final=最后一条、attempts 全含", async () => {
    const { q, db } = await newQ();
    insertExec(db, 1, "pure-model", '{"kind":"pure-model"}');
    insertExec(db, 2, "human", '{"kind":"human"}');
    const f1 = failExecutor("pure-model", true, "cli_failed");
    const f2 = failExecutor("human", false, "human_pending");
    const r = await runExecutions(target(), {
      writer: q,
      registry: new ExecutorRegistry([f1, f2]),
    });
    expect(r.ok).toBe(false);
    expect(r.attempts).toHaveLength(2);
    expect(r.final).toEqual(r.attempts[1]);
  });

  it("from_seq=2：seq1 行存在也不跑", async () => {
    const { q, db } = await newQ();
    insertExec(db, 1, "pure-model", '{"kind":"pure-model"}');
    insertExec(db, 2, "human", '{"kind":"human"}');
    const f1 = okExecutor("pure-model");
    const f2 = okExecutor("human");
    const r = await runExecutions(target({ from_seq: 2 }), {
      writer: q,
      registry: new ExecutorRegistry([f1, f2]),
    });
    expect(r.ok).toBe(true);
    expect(r.attempts).toHaveLength(1);
    expect(f1.run).not.toHaveBeenCalled();
    expect(f2.run).toHaveBeenCalledTimes(1);
  });

  it("0 启用行：attempts 恰 1 条 executor_disabled（retry=false）", async () => {
    const { q, db } = await newQ();
    insertExec(db, 1, "pure-model", '{"kind":"pure-model"}', 0);
    const r = await runExecutions(target(), {
      writer: q,
      registry: new ExecutorRegistry([okExecutor("pure-model")]),
    });
    expect(r.ok).toBe(false);
    expect(r.attempts).toHaveLength(1);
    const only = r.attempts[0];
    if (only === undefined || only.ok !== false) {
      throw new Error("期望唯一一条合成失败行");
    }
    expect(only.code).toBe("executor_disabled");
    expect(only.retry_next_executor).toBe(false);
  });

  it("config_json 坏：合成 executor_unknown_kind（retry=true），后面好行继续", async () => {
    const { q, db } = await newQ();
    // 语法坏（JSON.parse 抛）与形状坏（safeParse 拒）各来一发，都被兜住且不炸整轮。
    // 形状坏用「判别缺必填格」的 platform-webhook（丢 plugin_id/tool_name）——
    // 注意外层 kind 与内层 kind 不一致【不算】坏：executorConfigSchema 只判形状，
    // 交叉判据在 executorRunRequestSchema，而那要 config 先过才有下一道。
    insertExec(db, 1, "pure-model", "{oops 不是 JSON");
    insertExec(db, 2, "platform-webhook", '{"kind":"platform-webhook"}');
    insertExec(db, 3, "claude-cli", '{"kind":"claude-cli"}');
    const f3 = okExecutor("claude-cli");
    const r = await runExecutions(target({ workspace: "D:/x" }), {
      writer: q,
      registry: new ExecutorRegistry([f3]),
    });
    expect(r.ok).toBe(true);
    expect(r.attempts).toHaveLength(3);
    const bad1 = r.attempts[0];
    const bad2 = r.attempts[1];
    if (
      bad1 === undefined ||
      bad1.ok !== false ||
      bad2 === undefined ||
      bad2.ok !== false
    ) {
      throw new Error("前两条应为合成失败行");
    }
    expect(bad1.code).toBe("executor_unknown_kind");
    expect(bad1.retry_next_executor).toBe(true);
    expect(bad2.code).toBe("executor_unknown_kind");
    expect(f3.run).toHaveBeenCalledTimes(1);
  });

  it("CLI 行 + target 无 workspace：executorRunRequestSchema 抛（422 式响亮）", async () => {
    const { q, db } = await newQ();
    insertExec(db, 1, "claude-cli", '{"kind":"claude-cli"}');
    const f1 = okExecutor("claude-cli");
    await expect(
      runExecutions(target(), {
        writer: q,
        registry: new ExecutorRegistry([f1]),
      }),
    ).rejects.toThrow(/workspace/);
    // 炸在请求构造，执行器根本没被调用。
    expect(f1.run).not.toHaveBeenCalled();
  });

  it("假执行器 reject：合成 executor_error 继续下一行", async () => {
    const { q, db } = await newQ();
    insertExec(db, 1, "pure-model", '{"kind":"pure-model"}');
    insertExec(db, 2, "human", '{"kind":"human"}');
    const f1 = throwerExecutor("pure-model");
    const f2 = okExecutor("human");
    const r = await runExecutions(target(), {
      writer: q,
      registry: new ExecutorRegistry([f1, f2]),
    });
    expect(r.ok).toBe(true);
    expect(r.attempts).toHaveLength(2);
    const first = r.attempts[0];
    if (first === undefined || first.ok !== false) {
      throw new Error("第一条应为违约合成行");
    }
    expect(first.code).toBe("executor_error");
    expect(first.retry_next_executor).toBe(true);
  });

  it("注册表缺 kind：合成 executor_disabled（retry=false）即停，后面的行不跑", async () => {
    const { q, db } = await newQ();
    insertExec(db, 1, "pure-model", '{"kind":"pure-model"}');
    insertExec(db, 2, "human", '{"kind":"human"}');
    const f2 = okExecutor("human");
    // 只注册 human：seq1 的 pure-model 未注册 ⇒ null ⇒ 合成 disabled、break。
    const reg = new ExecutorRegistry([f2]);
    const r = await runExecutions(target(), { writer: q, registry: reg });
    expect(r.ok).toBe(false);
    expect(r.attempts).toHaveLength(1);
    const only = r.attempts[0];
    if (only === undefined || only.ok !== false) {
      throw new Error("期望唯一一条 disabled 合成行");
    }
    expect(only.code).toBe("executor_disabled");
    expect(only.retry_next_executor).toBe(false);
    expect(f2.run).not.toHaveBeenCalled();
  });

  it("审计：假执行器不写 ⇒ events 零行（router 不代写）", async () => {
    const { q, db } = await newQ();
    insertExec(db, 1, "pure-model", '{"kind":"pure-model"}');
    insertExec(db, 2, "human", '{"kind":"human"}');
    const f1 = failExecutor("pure-model", true);
    const f2 = okExecutor("human");
    const r = await runExecutions(target(), {
      writer: q,
      registry: new ExecutorRegistry([f1, f2]),
    });
    expect(r.ok).toBe(true);
    // 两次真尝试 + 零合成行，events 里 executor_run 恒零：审计是执行器自己的事。
    expect(executorRunRows(db)).toHaveLength(0);
  });

  it("审计：执行器自己写 ⇒ 每次尝试恰好一行", async () => {
    const { q, db } = await newQ();
    insertExec(db, 1, "pure-model", '{"kind":"pure-model"}');
    insertExec(db, 2, "human", '{"kind":"human"}');
    // 故意走 auditExecutorRun 的假执行器（writer 闭包注入 —— 执行器自己排队落审计，
    // 与真实现同一条链）：一败一成两发尝试 ⇒ 恰好两行。
    const mk = (kind: ExecutorKind, fail: boolean): Executor => ({
      kind,
      run: async (req: ExecutorRunRequest): Promise<ExecutorRunOutcome> => {
        const out = fail
          ? errRun(req, {
              code: "cli_failed",
              message: "干不动",
              retry_next_executor: true,
            })
          : okRun(req, { text: "x", summary: "干完了" });
        await q.node(() => auditExecutorRun(requireScopeDb("test.faux"), out));
        return out;
      },
    });
    const r = await runExecutions(target(), {
      writer: q,
      registry: new ExecutorRegistry([
        mk("pure-model", true),
        mk("human", false),
      ]),
    });
    expect(r.ok).toBe(true);
    const rows = executorRunRows(db);
    expect(rows).toHaveLength(2);
  });
});
