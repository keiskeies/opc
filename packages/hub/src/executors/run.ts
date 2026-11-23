/**
 * 执行器路由器（T6，design-2026-11-23-群角色上层.md D4/D5）。
 *
 * ── 这一层是什么 ────────────────────────────────────────────────────
 * runExecutions 收一份 ExecutionTarget（岗位 + 成员 + 档位 + 指令），
 * 读 member_executors 里【当前生效】的那份路由表，沿 seq 升序逐个子执行器试，
 * 直到第一个成功、或撞到一条 retry_next_executor=false 的失败、或试完。
 *
 * ── 路由器【不代写审计】（types.ts 文件头那条推论，这里展开）──────────
 * 审计口径是「一次尝试 = 恰好一行 executor_run，由执行器自己落」。
 * 于是合成行（配置坏 / 执行器被裁 / 执行器违约抛）没有执行器可跑，
 * 也就【没有】审计行 —— 路由器若代写，「一次尝试恰好一行」就变成
 * 「有执行器的一行、没执行器的两行」（执行器活了但抛在半路时它自己可能已写行，
 * 路由器再补一行就是双记），口径反而更不稳。要查合成行，读回执的 attempts。
 * 同理，假执行器【故意不写】审计时 events 里就是零行 —— 测试把这条钉死，
 * 防的就是「哪天有人在路由器里顺手补一句 appendAudit」的善意破坏。
 *
 * ── 路由表只读库，不 join members（刻意）─────────────────────────────
 * 成员不存在 ⇒ 这里给 0 行 ⇒ 走 executor_disabled 分支。为什么不先查
 * members 再报 member_not_found：路由表是当前生效配置的【唯一】权威
 * （契约 ExecutionTarget 注释同款立场 —— 成员档案与执行器表的一致性
 * 归 members/service 的招聘事务管，路由器不做二次验尸，两处各判一次
 * 「成员在不在」早晚漂成两个答案）。
 */
import {
  EXECUTOR_KINDS,
  type ExecutionOutcome,
  type ExecutionTarget,
  type ExecutorConfig,
  type ExecutorFailureCode,
  type ExecutorKind,
  type ExecutorRunError,
  type ExecutorRunOutcome,
  type ExecutorRunRequest,
  executionOutcomeSchema,
  executionTargetSchema,
  executorConfigSchema,
  executorRunRequestSchema,
} from "@opc/contracts";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import type { Writer } from "../db/write-queue.js";
import type { ExecutorRegistry } from "./registry.js";

export interface RunExecutionsDeps {
  readonly writer: Writer;
  readonly registry: ExecutorRegistry;
}

/** member_executors 的读行形状（node:sqlite 不做类型判别，enabled 是数字 0/1）。 */
interface RouteRow {
  readonly seq: number;
  readonly kind: string;
  readonly config_json: string;
  readonly enabled: number;
}

/** 一次尝试的业务标识：task 共享、尝试必须可区分，seq 就编在 id 里。 */
function executionIdOf(taskId: string, seq: number): string {
  // 为什么不是调用方给 execution_id：一次 runExecutions 里所有尝试共享同一个 task，
  // 调用方【没有】区分「第几次尝试」的信息 —— 它有 from_seq 但没有「现在跑到第几格」。
  // id 由路由器在循环内生成，seq 已在其中，重试链在审计里天然可串。
  return "exec:" + taskId + ":" + String(seq);
}

/**
 * 合成一条失败回执（配置坏 / 被裁 / 执行器违约抛这三处共用）。
 * 手搓对象而不走 types.ts 的 errRun：errRun 吃 ExecutorRunRequest，
 * 而合成行【没有】合法请求可吃（config 坏到构造不出请求正是它合成的原因）。
 * 五格 runContext 与 errRun 逐格同形，回放侧读不出差别。
 */
function synthError(
  target: ExecutionTarget,
  row: { seq: number; kind: ExecutorKind },
  code: ExecutorFailureCode,
  message: string,
  retry: boolean,
): ExecutorRunError {
  return {
    ok: false,
    execution_id: executionIdOf(target.task_id, row.seq),
    task_id: target.task_id,
    member_id: target.member_id,
    seq: row.seq,
    kind: row.kind,
    code,
    message,
    retry_next_executor: retry,
  };
}

/** kind 列过枚举判据（DDL CHECK 是第一道，这里是第二道：两份词表漂了要在此点名）。 */
function asExecutorKind(kind: string): ExecutorKind {
  if (!(EXECUTOR_KINDS as readonly string[]).includes(kind)) {
    // 走到这里只剩一种可能：迁移 CHECK 与 EXECUTOR_KINDS 漂了（0013 文件头立的案）。
    // 不合成、不跳过 —— 合成行本身要求 kind 可表达，跳过是静默丢配置。
    throw new Error(
      "executors.run：member_executors 里出现词表外的 kind=" +
        kind +
        "。DDL CHECK 与 EXECUTOR_KINDS 漂移，先修词表再谈执行。",
    );
  }
  return kind as ExecutorKind;
}

/**
 * 沿 seq 升序执行，返回带完整尝试链的回执。
 *
 * 输入自己 parse（运行期边界）：坏 target 是调用方装配 bug，zod 错直接抛 ——
 * 路由器的每个下游（SQL 参数、请求构造）都建立在字段已合规的前提上，
 * 在这里省一次 parse 等于把爆炸点推到语义最含糊的深处。
 */
export async function runExecutions(
  targetInput: ExecutionTarget,
  deps: RunExecutionsDeps,
): Promise<ExecutionOutcome> {
  const target = executionTargetSchema.parse(targetInput);
  const { writer, registry } = deps;

  // 读路由表：写连接、进写队列（与后续执行器的审计写同一串行链，读不到半提交）。
  const rows = await writer.node(
    () =>
      requireScopeDb("executors.run.route")
        .prepare(
          "SELECT seq, kind, config_json, enabled FROM member_executors " +
            "WHERE member_id = ? AND seq >= ? ORDER BY seq ASC",
        )
        .all(target.member_id, target.from_seq) as unknown as RouteRow[],
  );

  // enabled=1 才是候选：禁用行是「配置还留着但今天不上岗」，跳过而不是终止 ——
  // 与 from_seq 同族语义：两者都表达「这一格不参与本轮」，不是「路由到此为止」。
  const candidates = rows.filter((r) => r.enabled === 1);

  const attempts: ExecutorRunOutcome[] = [];

  // 候选为空（0 行、全是禁用行、或 from_seq 超界）：零尝试也得交一份
  // executionOutcomeSchema 认可的回执（attempts min(1)），所以合成一行。
  // 语义 = 「这个成员没有任何可用实现」= executor_disabled（有表没实现的同族读法）；
  // retry false —— 后面没有行可换，换谁都是这张空表。
  if (candidates.length === 0) {
    // 有行但全禁用时，合成行借第一行的 kind/seq（指认「是哪一格被禁到没得跑」）；
    // 0 行时借 from_seq 当记号、kind 填 pure-model 当【占位】—— 不指认任何实现，
    // 真实成因写在 message 里，读侧别拿占位 kind 归因。
    const head = rows[0];
    const refKind =
      head === undefined ? "pure-model" : asExecutorKind(head.kind);
    const refSeq = head === undefined ? target.from_seq : head.seq;
    const none = synthError(
      target,
      { seq: refSeq, kind: refKind },
      "executor_disabled",
      "成员 " +
        target.member_id +
        " 从 seq>=" +
        String(target.from_seq) +
        " 起没有启用的执行器，本轮无可试对象。",
      false,
    );
    attempts.push(none);
    return executionOutcomeSchema.parse({ ok: false, final: none, attempts });
  }

  let last: ExecutorRunOutcome | null = null;

  for (const row of candidates) {
    const kind = asExecutorKind(row.kind);
    const rowRef = { seq: row.seq, kind };

    // config_json 双重坏法都兜：JSON.parse 抛（语法坏）与 safeParse 拒（形状坏）。
    // retry true：坏配置【换下一个执行器】有意义（下一格可能是好的真人席），
    // 而「换谁都是这份坏配置」不成立 —— 每格配置是自己的。
    let config: ExecutorConfig;
    try {
      const parsed = executorConfigSchema.safeParse(
        JSON.parse(row.config_json),
      );
      if (!parsed.success) {
        throw new Error(parsed.error.issues[0]?.message ?? "形状不合契约");
      }
      config = parsed.data;
    } catch (e) {
      const bad = synthError(
        target,
        rowRef,
        "executor_unknown_kind",
        "seq=" +
          String(row.seq) +
          " 的 config_json 坏了（" +
          (e instanceof Error ? e.message : String(e)) +
          "），该行不经执行器直接计败。",
        true,
      );
      attempts.push(bad);
      last = bad;
      continue;
    }

    const executor = registry.get(kind);
    if (executor === null) {
      // 未注册与禁用对路由器同形（get 都给 null）；message 里把两种成因分开写，
      // 归因细则见 registry.ts 文件头（disabled 集合可指认）。
      // retry【false】：被裁掉的实现换它也没意义 —— 这不是「这一格不行」，
      // 而是「装配决定了这条路由整段不存在」，继续往下只是浪费一次尝试。
      const why = registry.disabled.has(kind)
        ? "该 kind 已被装配显式禁用（registry.disabled 可指认）"
        : "该 kind 未注册（装配表缺实现，属装配 bug）";
      const off = synthError(
        target,
        rowRef,
        "executor_disabled",
        "seq=" + String(row.seq) + " kind=" + kind + "：" + why + "。",
        false,
      );
      attempts.push(off);
      last = off;
      break;
    }

    // 请求构造：路由行出 execution 侧四格，target 透传业务侧格子。
    // assignee_hint 只从 human 配置取（契约注释：真人席渲染待办卡片的收件线索）。
    const request: ExecutorRunRequest = executorRunRequestSchema.parse({
      execution_id: executionIdOf(target.task_id, row.seq),
      task_id: target.task_id,
      member_id: target.member_id,
      role_id: target.role_id,
      seq: row.seq,
      kind,
      config,
      model_tier: target.model_tier,
      instruction: target.instruction,
      role_prompt: target.role_prompt,
      ...(target.workspace !== undefined
        ? { workspace: target.workspace }
        : {}),
      max_budget_usd: target.max_budget_usd,
      ...(target.timeout_ms !== undefined
        ? { timeout_ms: target.timeout_ms }
        : {}),
      ...(config.kind === "human" && config.assignee_hint !== undefined
        ? { assignee_hint: config.assignee_hint }
        : {}),
    });
    // parse 兜全形是刻意的最后一道装配自检：CLI kind 缺 workspace 会在这里抛
    // （superRefine 那条 422 式判据）—— 响亮优于 spawn 时静默落回 hub 自己的目录。

    let outcome: ExecutorRunOutcome;
    try {
      // 契约说 run 永不 reject；真抛了就是执行器违约。但【路由器陪葬整个任务
      // 不可接受】—— 重试链的价值恰恰是「这个不行换下一个」，一个违约实现
      // 不该让整轮派发连坐。合成 executor_error、retry true、继续。
      // （违约者多半也没走到自己落审计那步 ⇒ 这一发 attempts 有、events 无，
      // 见文件头「路由器不代写审计」段。）
      outcome = await executor.run(request);
    } catch (e) {
      outcome = synthError(
        target,
        rowRef,
        "executor_error",
        "执行器违约：run() 抛了（契约定死永不 reject）—— " +
          (e instanceof Error ? e.message : String(e)),
        true,
      );
    }

    attempts.push(outcome);
    last = outcome;
    if (outcome.ok) {
      return executionOutcomeSchema.parse({
        ok: true,
        final: outcome,
        attempts,
      });
    }
    if (!outcome.retry_next_executor) break;
    // retry true ⇒ 下一行。
  }

  // 循环耗尽（末发 retry true 但没有下一格，或 break 在 retry false）：
  // 结论 = 最后一发的失败。last 恒非 null 在这里是结构保证（candidates 非空
  // 且每轮必置），判空只为把「不可能」写成代码而不是靠 ! 断言。
  if (last === null) {
    throw new Error("executors.run：不变式破 — 候选非空却零尝试。");
  }
  return executionOutcomeSchema.parse({ ok: false, final: last, attempts });
}
