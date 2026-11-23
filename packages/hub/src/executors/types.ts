/**
 * 执行器层的地基（design-2026-11-23-群角色上层.md D4/D5，实施计划 T6）。
 *
 * ── 这一层是什么 ────────────────────────────────────────────────────
 * T5 之前 hub 里只有状态机会动（dispatch 直接调 engine/claude.ts）。T6 之后
 * 「让一个成员干活」的动的人可以是七种东西里的任何一种（三家 CLI、一个 MCP
 * 工具、一个内置插件、一个裸模型、一个真人）。上层（群聊、待办、会议）不该
 * 知道七种的差别，所以这里收成一个接口：
 *
 *   Executor.run(ExecutorRunRequest) → Promise<ExecutorRunOutcome>
 *
 * 请求与回执的形状全在 @opc/contracts/executor.ts（那是契约层的事），
 * 本文件只放 hub 侧的地基：接口本身、审计口径、ok/err 构造器。
 *
 * ── 审计口径：一次尝试 = 恰好一行 executor_run ──────────────────────
 * 每个 Executor 实现【自己】写这一行（router 不代写，见 run.ts 文件头那条推论）。
 * 为什么必须恰好一行：重试链（seq=1 失败 → seq=2）的审计要能回答
 * 「这个活儿最后是谁干的、前面几次为什么不行」—— 多写（既记 spawn 失败又记
 * CLI 失败）会把一次尝试数成两次；少写（插件层「不写审计，执行器层写」的注释
 * 说的就是这一格）会让整条重试链在 events 里不存在。
 *
 * action 复用 "tool_call" 而【不开第 11 个枚举值】：events.action 是十值
 * append-only 口径（recorder.ts:42-52 对 ApprovalTokenRedeemed /
 * RoleTurnReported 两个 kind 记过同一条理由 —— 加一个值会让所有按 action
 * 统计的报表当场少一批）。这一族行在库里的身份靠 payload.kind 认领：
 * payload.kind === "executor_run"。选 "tool_call" 沿用 RoleTurnReported 的
 * 先例：十个值里唯一语义为「执行器干了事」的那个。role-memory 的 SQL 只捞
 * approval / review_decision，所以这些行天然不进记忆。
 */
import {
  EXECUTOR_FAILURE_CODES,
  type ExecutorFailureCode,
  type ExecutorRunDone,
  type ExecutorRunError,
  type ExecutorRunOutcome,
  type ExecutorRunRequest,
} from "@opc/contracts";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import type { Writer } from "../db/write-queue.js";
import type { AuditRow } from "../events/recorder.js";
import { appendAudit } from "../events/recorder.js";

/** payload.kind 的认领值（见上面「审计口径」段）。 */
export const EXECUTOR_RUN_PAYLOAD_KIND = "executor_run";

/**
 * executor_run 审计行的 payload。列是钉死的：每格都要在
 * 「招聘页/群聊要展示什么」或「审计要能回答什么」里有一个回答，没有就不进 payload。
 */
export interface ExecutorRunPayload {
  readonly kind: "executor_run";
  readonly execution_id: string;
  readonly task_id: string;
  readonly member_id: string;
  readonly seq: number;
  readonly kind_of_executor: string;
  readonly ok: boolean;
  /** 失败码（成功时缺省 —— 不是 null：缺格与「码为 null」在回放里必须同形）。 */
  readonly code?: string;
  /** 人类可读的一句话（与回执的 message 同值，让 events 单行自解释。 */
  readonly message?: string;
  readonly summary?: string;
  readonly cost_cents?: number;
  readonly retry_next_executor?: boolean;
  readonly spawn_errno?: string;
  readonly session_id?: string;
  readonly card_id?: string;
}

/** 回执 → payload。ok/err 两支共用一个拼装函数：两份拼装必漂（本仓最贵那一族）。 */
export function executorRunPayload(o: ExecutorRunOutcome): ExecutorRunPayload {
  if (o.ok) {
    return {
      kind: EXECUTOR_RUN_PAYLOAD_KIND,
      execution_id: o.execution_id,
      task_id: o.task_id,
      member_id: o.member_id,
      seq: o.seq,
      kind_of_executor: o.kind,
      ok: true,
      summary: o.summary,
      ...(o.cost_cents !== undefined ? { cost_cents: o.cost_cents } : {}),
      ...(o.session_id !== undefined ? { session_id: o.session_id } : {}),
      ...(o.card_id !== undefined ? { card_id: o.card_id } : {}),
    };
  }
  return {
    kind: EXECUTOR_RUN_PAYLOAD_KIND,
    execution_id: o.execution_id,
    task_id: o.task_id,
    member_id: o.member_id,
    seq: o.seq,
    kind_of_executor: o.kind,
    ok: false,
    code: o.code,
    message: o.message,
    retry_next_executor: o.retry_next_executor,
    ...(o.cost_cents !== undefined ? { cost_cents: o.cost_cents } : {}),
    ...(o.spawn_errno !== undefined ? { spawn_errno: o.spawn_errno } : {}),
  };
}

/**
 * 落一行 executor_run 审计。执行器实现里【唯一】允许写审计的口子 ——
 * 走 appendAudit（与全仓同一插入路径：JSON 三规则、target 口径、审计序列号）。
 */
export function auditExecutorRun(
  db: Parameters<typeof appendAudit>[0],
  outcome: ExecutorRunOutcome,
  nowMs?: number,
): number {
  return appendAudit(db, {
    taskId: outcome.task_id,
    // actor 是 system 而不是成员名：一次执行尝试是【系统的派发记录】，
    // 署成员的名会让 role-memory（它筛 agent 行为的）把失败尝试也读成该成员的事迹。
    // 谁被执行了这件事在 payload.member_id 里，语义不差分毫。
    actorType: "system",
    actorId: "executors",
    action: "tool_call",
    target: "executor:" + outcome.execution_id + ":" + String(outcome.seq),
    payload: executorRunPayload(outcome),
    ...(nowMs === undefined ? {} : { createdAt: nowMs }),
  });
}

/** 一个执行器的实现（D4：七种 kind 各一份，注册在 registry.ts）。 */
export interface Executor {
  readonly kind: ExecutorRunRequest["kind"];
  /**
   * 跑一次尝试。约定（每份实现的文件头各自展开）：
   *  · 永远 resolve 成 ExecutorRunOutcome —— 不抛。抛出去的重试层只能按
   *    「未知错」处理，而本层的全部价值就是把「换人有没有意义」判准了。
   *  · 【自己落一行 executor_run 审计】（走 auditExecutorRun）。
   *  · 结构上不知道花了多少钱 ⇒ cost_cents 缺省，【不是 0】（契约层同款口径）。
   */
  run(req: ExecutorRunRequest): Promise<ExecutorRunOutcome>;
}

/** 成功回执构造器：runContext 从请求原样带（五格一字不差）。 */
export function okRun(
  req: ExecutorRunRequest,
  part: {
    text: string;
    summary: string;
    note?: string;
    cost_cents?: number;
    session_id?: string;
    card_id?: string;
    harness_result?: Record<string, unknown>;
  },
): ExecutorRunDone {
  return {
    ok: true,
    execution_id: req.execution_id,
    task_id: req.task_id,
    member_id: req.member_id,
    seq: req.seq,
    kind: req.kind,
    text: part.text,
    summary: part.summary,
    note: part.note ?? "",
    ...(part.cost_cents !== undefined ? { cost_cents: part.cost_cents } : {}),
    ...(part.session_id !== undefined ? { session_id: part.session_id } : {}),
    ...(part.card_id !== undefined ? { card_id: part.card_id } : {}),
    ...(part.harness_result !== undefined
      ? { harness_result: part.harness_result }
      : {}),
  };
}

/** 失败回执构造器。retry_next_executor 由调用点显式给 —— 那是各执行器【唯一】自己知道的事。 */
export function errRun(
  req: ExecutorRunRequest,
  part: {
    code: ExecutorFailureCode;
    message: string;
    retry_next_executor: boolean;
    cost_cents?: number;
    spawn_errno?: string;
  },
): ExecutorRunError {
  return {
    ok: false,
    execution_id: req.execution_id,
    task_id: req.task_id,
    member_id: req.member_id,
    seq: req.seq,
    kind: req.kind,
    code: part.code,
    message: part.message,
    retry_next_executor: part.retry_next_executor,
    ...(part.cost_cents !== undefined ? { cost_cents: part.cost_cents } : {}),
    ...(part.spawn_errno !== undefined
      ? { spawn_errno: part.spawn_errno }
      : {}),
  };
}

/**
 * 「落这一行审计」的装配侧收口（round363）：七份执行器都要走
 * writer.node → requireScopeDb → appendAudit 这条链，五份还要顺带 flush
 * gateway 缓冲行。每份各写一遍 = 五份必漂的排队/取连接/漏行组合，所以收在一处。
 *
 * ⚠ flush 失败【大声记日志而不重抛】—— 与 engine/runtime.ts 的 gateway 审计
 * flush 同款立场：执行结论已经在回执里，不能因为审计写不进去就把成功轮翻成
 * 抛异常（上层重试一次 = 可能再花一次钱）。但「审计缺了一行」必须比正常路径
 * 更响，所以是 console.error 而不是静默吞。
 *
 * extraRows：cli 类执行器的 gateway 缓冲行（harness_call 等），与 executor_run
 * 同一事务落 —— 一次尝试的全部账要么都在，要么都不在，不能审计里半本。
 */
export async function auditExecutorRunViaWriter(
  w: Writer,
  outcome: ExecutorRunOutcome,
  caller: string,
  extraRows: readonly AuditRow[] = [],
): Promise<void> {
  try {
    await w.node(() => {
      const db = requireScopeDb(caller);
      for (const row of extraRows) appendAudit(db, row);
      return auditExecutorRun(db, outcome);
    });
  } catch (e) {
    console.error(
      "[executors] 审计落盘失败（" +
        caller +
        " execution=" +
        outcome.execution_id +
        " seq=" +
        String(outcome.seq) +
        "）：" +
        (e instanceof Error ? e.message : String(e)),
    );
  }
}

/**
 * 「这个执行器现在能不能用」的装配期判定（registry 用）。
 * writer 供 human/builtin-plugin 这类要看库的实现在构造期自检；
 * CLI 类返回 undefined（能不能跑要到 spawn 才知道，事前判都是猜）。
 */
export type ExecutorAvailability = Writer;

/**
 * 工具入参：instruction 必填、role_prompt 非空才带。
 * 为什么只给这两格：工具看到的是「这轮干什么 + 你是谁」，成员档案、预算、
 * 路由表都不进 args —— 外部工具拿到越多内部形状，将来它的输出越没法归因。
 */
export function buildToolArgs(
  req: ExecutorRunRequest,
): Record<string, unknown> {
  const args: Record<string, unknown> = { instruction: req.instruction };
  if (req.role_prompt !== "") {
    args["role_prompt"] = req.role_prompt;
  }
  return args;
}

/**
 * 诚实的机械摘要：第一段非空行原样作 summary。
 * 契约 summary min(1)（「跑成功了但谁也不知道干了啥」必须类型上不可表达），
 * 而执行器不该替执行产物编造一句人话 —— 首行是输出自己给的，不是猜的。
 * 全空给占位句而不是空串：编一句「完成了任务」是谎。
 */
export function firstNonEmptyLine(text: string): string {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t !== "") return t;
  }
  return "（无输出摘要）";
}

/** 执行器层错误码透传判据：在枚举里原样过，判不过退 executor_error。 */
export function asExecutorFailureCode(code: string): ExecutorFailureCode {
  if ((EXECUTOR_FAILURE_CODES as readonly string[]).includes(code)) {
    return code as ExecutorFailureCode;
  }
  return "executor_error";
}
