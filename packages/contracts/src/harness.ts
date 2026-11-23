/**
 * Harness Gateway 的契约（计划 Task 5.1，规格 §12.1 / §12.2 / §12.7 / §12.8）。
 *
 * ── 这个文件为什么先于任何适配器存在 ────────────────────────────────
 * 规格 §12.3 的「反过度抽象原则」说得很直白：三家 SDK 能力面**不对称**
 * （Claude 有 canUseTool 与 maxBudgetUsd，Codex 强在沙箱双轴，Qoder 强在审批转交宿主），
 * 强行取交集会让每个适配器为兼容而牺牲原生能力。所以这里的形状是刻意的：
 *
 *   · 对外只有 **execute / resume / getCost** 三个方法（§12.1 原话）；
 *   · 能力差异**不进交集**，走 `capabilities` 这四个布尔 + 请求里的**可选字段**；
 *   · 于是「某家做不到 X」是一个**可判定的声明**，而不是一个适配器里的静默降级。
 *
 * 最后那一条是本模块的全部价值。§12.8 写的核心风险是「自动批准模式与门控哲学的冲突」，
 * 而它在实现层最可能的走法不是有人主动关掉审批，是**能力不符时被静默降级**：
 * 策略要求审批、适配器没有审批回调、于是照跑 —— 一句报错都没有。
 * 所以本模块配套的判定是 `capabilityGap()`（hub 侧 gateway.ts），它把不符变成**拒绝调用**。
 *
 * ── 为什么不解析 CLI 输出 ──────────────────────────────────────────
 * §12.1 定的接入方式是「进程内调用官方 SDK，不解析 CLI 输出」，三条理由里最硬的是第三条：
 * **审批转交宿主必须是回调，不是字符串匹配** —— 把安全边界建在 stdout 的格式上，
 * harness 改一行日志格式就等于把审批门拆了。因此本契约里：
 *   · 审批是 `ApprovalHandler`（一个回调），不是「从事件流里认出审批请求」；
 *   · `HarnessEvent` 里**故意没有** "unknown_line" 之类的兜底变体 ——
 *     加了它，「解析不出来」就变成一个可以合法发生的分支。
 * CLI 那一格（§12.2 表里「非交互 CLI（兜底）」）在没有 SDK 的机器上是**不可用**，
 * 不是一个退路；退路长什么样见 hub 侧 gateway.ts 的注释。
 */
import { z } from "zod";

/**
 * 一期接入的三家（§12.2）。id 逐字取计划 Task 5.1 的接口签名，
 * 而不是 npm 包名 —— 包名会随版本变（`@anthropic-ai/claude-agent-sdk` 那种带作用域的长名），
 * 而 id 要进审计事件、进岗位书，改一次的代价是全部历史回放里那一格换名。
 */
export const HARNESS_IDS = ["claude-code", "codex", "qoder"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

/**
 * 二期/按需接入（§12.3）。单独一个常量而不是合进 HARNESS_IDS：
 * 合进去就等于宣布它们已接入（`capabilities` 得给值，而我没验过任何一家），
 * 而 §12.3 明确写着 Kimi「无审批回调」「Print 模式隐式启用 --afk」、
 * DeepSeek 是 developer preview「不可承担有交付时限的任务」。
 * 这一层的用途只有一个：**路由表**（§12.4）里「实验性/低风险 → Kimi Code」那一行
 * 需要一个能写的值，以及路由必须知道它带的限制。
 */
export const EXPERIMENTAL_HARNESS_IDS = ["kimi-code"] as const;
export type ExperimentalHarnessId = (typeof EXPERIMENTAL_HARNESS_IDS)[number];

/**
 * 沙箱档位（§12.2 的 Codex 双轴之一，逐字取它给的值）。
 *
 * 排序**有意义**：档位是按「能造成多大破坏」升序排的，
 * safety.ts 那条「沙箱档位不得提级」的判据直接比下标。
 * ⚠ 别把它当字母序或当集合用 —— 一旦有人排成 `danger` 在前，那条判据就反了。
 */
export const SANDBOX_TIERS = [
  "read-only",
  "workspace-write",
  "danger",
] as const;
export type SandboxTier = (typeof SANDBOX_TIERS)[number];

/** 审批策略（§12.2 Codex 双轴的另一轴）。 */
export const APPROVAL_POLICIES = ["never", "on-request"] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

/**
 * 能力声明的四个布尔，逐字取计划 Task 5.1 的接口。
 *
 * 为什么是布尔而不是位图/枚举：这四件事各自对应一条**独立**的策略要求
 * （预算硬顶 / 工具审批 / 会话恢复 / 结构化输出），任何一条缺失时的处置都不同。
 * 揉成一个「能力等级」就没法表达「有审批但没有预算硬顶」这种真实组合 ——
 * 而 Claude SDK 恰好就是这种组合（有 canUseTool 与 maxBudgetUsd，但预算是 USD 硬顶而
 * 非按 token 精确封顶），见 adapters 里那份声明。
 */
export const harnessCapabilitiesSchema = z
  .object({
    budgetHardCap: z.boolean(),
    toolApproval: z.boolean(),
    resume: z.boolean(),
    structuredOutput: z.boolean(),
  })
  .strict();
export type HarnessCapabilities = z.infer<typeof harnessCapabilitiesSchema>;

/**
 * 审批回调。形状是「请求 + 决定」，不是「工具名 + 布尔」：
 * §12.7 第三层要求升级到 CEO 的判据里包含**不可逆操作**，
 * 而决定不可逆性需要的是这次调用的参数（同一个 Bash 工具，`git status` 与 `rm -rf` 不同级）。
 * 只给工具名就等于把不可逆判断压进审批者看不见的地方。
 */
export interface ToolApprovalRequest {
  readonly tool: string;
  readonly args: unknown;
  /**
   * 这一次调用为什么要审批（人类可读）。审批卡片要显示它，
   * 而「为什么」这句话**不能由适配器编**：它来自策略层（safety.ts）命中的那一条判据。
   */
  readonly reason: string;
}

export interface ToolApprovalDecision {
  readonly approved: boolean;
  /** 谁批的（进审计；§12.7 第四层要「谁批准了什么」）。 */
  readonly decidedBy?: string;
  readonly note?: string;
}

export type ApprovalHandler = (
  req: ToolApprovalRequest,
) => Promise<ToolApprovalDecision> | ToolApprovalDecision;

/**
 * 一次调用的策略。snake_case 入参 + transform 出 camelCase，与 charter.ts 同一套约定
 * （岗位书 YAML 里写的就是 snake_case，这里若换风格，两处要对一张翻译表）。
 */
const harnessRequestInput = z
  .object({
    task_id: z.string().min(1),
    role_id: z.string().min(1),
    instruction: z.string().min(1),
    /** 工作区绝对路径。适配器只能在它里面动，越界由 safety.ts 拦。 */
    workspace: z.string().min(1),
    sandbox: z.enum(SANDBOX_TIERS),
    approval_policy: z.enum(APPROVAL_POLICIES),
    /** 岗位书 tool_permissions 里的白名单（§12.7 第一层）。 */
    allowed_tools: z.array(z.string().min(1)),
    /**
     * **本次生效**的绝对禁止项（绝对禁止项，§4.1.3 + §20.2）。
     *
     * 装配责任在调用方：岗位书那份是基线，运行时只能往里**加**。
     * Gateway 会拿它和岗位书基线比，少一条就拒（safety.ts 的
     * `forbidden_flag / removed_flags`）。之所以让调用方装配而不是 Gateway 自己 union：
     * Gateway 自己 union 会让「少一条」在结构上不可能发生，于是那条判据变成死代码 ——
     * 而它恰恰是要防「装配侧写错」的那一道，只有拿到别人装配的结果才判得了。
     */
    forbidden_flags: z.array(z.string().min(1)),
    /**
     * 这次调用**想传给 harness 的参数**（含 agent 自己要求的开关）。
     * 与 forbidden_flags 分开是必须的：一边是禁令清单，一边是实际参数，
     * 合成一个字段就变成「自己声明自己没违反」。
     */
    requested_args: z.array(z.string()),
    /** USD。适配器不支持硬顶时，这一格由外层兜（见 capabilities.budgetHardCap）。 */
    max_budget_usd: z.number().nonnegative(),
    /**
     * 期望的模型家族（§5.9 / §12.6 第 3 条：对抗性审查必须换家族）。
     * 缺 = 不约束。**注意这一格只表达「期望」**：真正判同源的是门控那两份
     * violatesNoSelfReview / sameFamilyReviewBlock，它们读的是**结果里实际用的家族**。
     */
    model_family: z.string().min(1).optional(),
    /** 需要结构化输出时给它 schema 的名字（不是 schema 本体；见 structuredOutput 那条注释）。 */
    output_schema: z.string().min(1).optional(),
    /** 恢复用。有值 ⇒ 走 resume 语义，适配器必须声明 resume 能力。 */
    resume_session_id: z.string().min(1).optional(),
  })
  .strict();

export const harnessRequestSchema = harnessRequestInput.transform((r) => ({
  taskId: r.task_id,
  roleId: r.role_id,
  instruction: r.instruction,
  workspace: r.workspace,
  sandbox: r.sandbox,
  approvalPolicy: r.approval_policy,
  allowedTools: r.allowed_tools,
  forbiddenFlags: r.forbidden_flags,
  requestedArgs: r.requested_args,
  maxBudgetUsd: r.max_budget_usd,
  modelFamily: r.model_family,
  outputSchema: r.output_schema,
  resumeSessionId: r.resume_session_id,
}));
export type HarnessRequest = z.infer<typeof harnessRequestSchema>;
export type HarnessRequestInput = z.input<typeof harnessRequestInput>;

/**
 * 消耗报告（§12.1 的 `CostReport`）。
 *
 * 单位是**美分**而不是美元：全仓预算侧都是美分（`budget/tracker.ts` 的 `assertCents`，
 * `budget-sync.ts` 的 `usdToCents`），在这里用美元就会在某一处出现一次浮点乘法，
 * 而「差一分钱」在预算护栏上是能被观测到的差异。
 *
 * 入 snake / 出 camel，与本文件其余 schema 同一套 transform。
 * （第一份版本这里**漏了 transform**，只有 snake_case 的裸 schema，而 hub 侧 gateway
 * 一路按 camelCase 读 `cost.spentCents` —— 两边只可能对一边，而只有 `tsc` 报得出来，
 * 跑起来一切正常，因为读一个不存在的属性给的是 undefined，而 undefined 在这里
 * 会被 `?? 0` 吃掉，得到一条「这次调用花了 0 美分」的假话。）
 */
const costReportInput = z
  .object({
    spent_cents: z.number().int().nonnegative(),
    /** 适配器自己说没用完预算时的余量；缺 = 未知（**不当 0**，见下面那句）。 */
    remaining_cents: z.number().int().nullable().optional(),
    /** 会话内 token 数；未知就缺省，不要填 0（0 会被读成「一分钱没花」）。 */
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    /**
     * 数字是谁给的（§14.4 红线二的同款问题）：harness 自己报 / 外层按单价折算 / 事后估算。
     * 「估算」这一档必须存在，否则诚实的适配器只能要么不填、要么把估算伪装成实测。
     */
    source: z.enum(["harness", "converted", "estimated"]),
  })
  .strict();

export const costReportSchema = costReportInput.transform((c) => ({
  spentCents: c.spent_cents,
  remainingCents: c.remaining_cents ?? null,
  inputTokens: c.input_tokens,
  outputTokens: c.output_tokens,
  source: c.source,
}));
export type CostReport = z.infer<typeof costReportSchema>;
export type CostReportInput = z.input<typeof costReportInput>;

/**
 * 一次调用的结果（§12.1 那句「统一包含：最终输出、session_id、退出码、结构化证据、消耗报告」）。
 *
 * ⚠ `exit_code` 是**可选**的这一件事值得说明：SDK 路径下没有进程退出码
 * （§12.1 定的就是进程内调用 SDK），所以「退出码」在原生路径上根本不存在。
 * §12.7 第四层要求审计里有退出码 —— 那一格在 SDK 路径上必须写成 null 而不是编一个 0，
 * 否则「0」会被读成「进程正常退出」，而实际发生的事是「没有进程」。
 */
const executionResultInput = z
  .object({
    task_id: z.string().min(1),
    harness_id: z.string().min(1),
    /** 适配器自报版本。审计要它（§12.7 第四层），回放里「当时用的是哪个版本」只有这里有。 */
    harness_version: z.string().min(1),
    /** 实际用的模型家族（**不是**请求里那个「期望」）。§12.6 判定独立性读这一格。 */
    model_family: z.string().min(1),
    session_id: z.string().min(1),
    output: z.string(),
    exit_code: z.number().int().nullable().optional(),
    /** 结构化证据。仅当适配器声明 structuredOutput 时允许有值（gateway 判这条）。 */
    structured: z.unknown().optional(),
    cost: costReportSchema,
    /** 产出的 diff 的 sha256（§12.7 第四层点名要 diff 哈希）。无产出 = null，不是空串。 */
    diff_hash: z.string().nullable(),
    /** 被拦下来的不可逆/禁止操作次数。> 0 必须能在审计里逐条找到。 */
    blocked_attempts: z.number().int().nonnegative(),
  })
  .strict();

export const executionResultSchema = executionResultInput.transform((r) => ({
  taskId: r.task_id,
  harnessId: r.harness_id,
  harnessVersion: r.harness_version,
  modelFamily: r.model_family,
  sessionId: r.session_id,
  output: r.output,
  exitCode: r.exit_code,
  structured: r.structured,
  // costReportSchema 自己已经 transform 成 camelCase 了，这里【直接透传】。
  // 第一版在这里又映射了一次 snake_case，而那一版 costReportSchema 还没有 transform，
  // 两边只能对一边 —— 这次是 tsc 报出来的（见上面那段注释说的同一类错）。
  cost: r.cost,
  diffHash: r.diff_hash,
  blockedAttempts: r.blocked_attempts,
}));
export type ExecutionResult = z.infer<typeof executionResultSchema>;

/**
 * 事件流的形状。四个变体，**没有兜底变体**（文件头那条：加了兜底就等于允许解析不出来）。
 *
 * 为什么还需要事件流而不是一个 Promise：§12.7 第三层要的是
 * 「开发后台跑，高风险工具调用**暂停**并推到审批队列」——
 * 暂停发生在调用**过程中**，一个 Promise 只能给结果，给不了中途的暂停点。
 *
 * ⚠ 计划 Task 5.1 那份接口签名写的是 `execute(...) → AsyncIterable<HarnessEvent>`，
 * 而规格 §12.1 写的是 `execute(task_spec, workspace, policy) → ExecutionResult`。
 * 两者不矛盾但**不能同时是一个返回类型**，所以取计划那个（更弱的那个），
 * 由 **Gateway 负责把事件流装配成 ExecutionResult**。理由：
 *   · 装配要写审计（§12.7 第四层那七项），而审计不该由每个适配器各写一份；
 *   · 「blocked 了几次」这个数只有 Gateway 知道（那是 Gateway 拦下来的次数），
 *     让适配器报等于让它自报自己被打回了多少次。
 * 代价是 `finished` 那一发必须把**只有适配器知道**的那几项带出来
 * （版本 / 实际家族 / 输出 / diff 哈希），于是契约里多一个 `HarnessOutcome`。
 * 这比「让 execute 直接返回 ExecutionResult」多了两个类型，但少了适配器与 Gateway
 * 对同一份结果的两次拼装 —— 后者才是会漂的那种重复。
 */
export const HARNESS_EVENT_KINDS = [
  "session_started",
  "tool_call",
  "usage",
  "finished",
] as const;
export type HarnessEventKind = (typeof HARNESS_EVENT_KINDS)[number];

/**
 * 只有适配器知道的那几项。`executionResultSchema` 的其余字段由 Gateway 填
 * （taskId 来自请求、blockedAttempts 来自 Gateway 自己的计数、sessionId 来自 session_started）。
 */
const harnessOutcomeInput = z
  .object({
    harness_id: z.string().min(1),
    harness_version: z.string().min(1),
    /** **实际**用的模型家族，不是请求里期望的那个。 */
    model_family: z.string().min(1),
    output: z.string(),
    /** diff 的 sha256（§12.7 第四层点名）。无产出 = null，不是空串。 */
    diff_hash: z.string().nullable(),
    structured: z.unknown().optional(),
  })
  .strict();

export const harnessOutcomeSchema = harnessOutcomeInput.transform((o) => ({
  harnessId: o.harness_id,
  harnessVersion: o.harness_version,
  modelFamily: o.model_family,
  output: o.output,
  diffHash: o.diff_hash,
  structured: o.structured,
}));
export type HarnessOutcome = z.infer<typeof harnessOutcomeSchema>;

export type HarnessEvent =
  | { kind: "session_started"; sessionId: string }
  | {
      kind: "tool_call";
      tool: string;
      /** 已经过脱敏的参数（§12.7 第四层「脱敏参数」）。脱敏在适配器里做，不在审计里做。 */
      redactedArgs: unknown;
    }
  | { kind: "usage"; cost: CostReport }
  /**
   * 必须是**最后**一发，且只发一次。缺它 ⇒ Gateway 报 `no_result` 而不是编一个结果
   * （编的话就是「exitCode: null + output: ""」这样一条看起来正常的记录，
   * 而真相是适配器根本没跑完 —— 这正是本仓那一族「把没发生的事写成合法值」的形状）。
   */
  | { kind: "finished"; exitCode: number | null; outcome: HarnessOutcome };

/**
 * 适配器接口。对外只有三个方法（§12.1 反过度抽象）。
 *
 * `capabilities` 是**只读声明**而不是方法：它必须在任何一次调用**之前**就能被读到，
 * 因为 gateway 要用它决定「这个请求能不能发」（capabilityGap）。
 * 做成方法会引入一个「先调用才知道不支持」的顺序，而那正是静默降级的入口。
 */
export interface HarnessAdapter {
  readonly id: HarnessId;
  readonly capabilities: HarnessCapabilities;
  execute(
    req: HarnessRequest,
    onApproval: ApprovalHandler,
  ): AsyncIterable<HarnessEvent>;
  resume(
    sessionId: string,
    onApproval: ApprovalHandler,
  ): AsyncIterable<HarnessEvent>;
  getCost(sessionId: string): Promise<CostReport>;
}

/**
 * 岗位书 `harness_defaults` 的**解读**（§4.1.3 那份 YAML）。
 *
 * 为什么单独一个 schema 而不把 harness_defaults 在 charterSchema 里收紧：
 * charter.ts 给它的类型是 `record(string, record(string, unknown))`，那是**有意的松**——
 * 它是各家原生参数的容器（Claude 那格是 allowed_tools/forbidden_flags，
 * Codex 那格是 sandbox/approval_policy/forbidden_flags，键集本来就不一样），
 * 收紧成一份交集就违反了 §12.3 那条反过度抽象。
 *
 * 但松不等于没有判据。这里的口径是：
 *  · **已知的键必须合法**（sandbox 只能是那三档、forbidden_flags 必须是字符串数组）；
 *  · **未知的键不报错**（各家原生参数会一直加，报错等于把升级路堵死）；
 *  · 已知键的值不合法 ⇒ **抛错而不是忽略**。忽略一个写错的
 *    `sandbox: "workspace"` 会得到一个「以为在 read-only 而实际没约束」的适配器，
 *    那比加载失败严重得多（charter.ts 文件头对 strict 说的同一句话，在这里的对应版）。
 */
export const harnessDefaultEntrySchema = z
  .object({
    sandbox: z.enum(SANDBOX_TIERS).optional(),
    approval_policy: z.enum(APPROVAL_POLICIES).optional(),
    allowed_tools: z.array(z.string().min(1)).optional(),
    forbidden_flags: z.array(z.string().min(1)).optional(),
  })
  .passthrough();
export type HarnessDefaultEntry = z.infer<typeof harnessDefaultEntrySchema>;

/**
 * 岗位书里点名的那两家 harness 的参数形状（§4.1.3 的 claude_code / codex 两格）。
 *
 * id 的**别名**在这里处理而不是在适配器里：岗位书 YAML 写 `claude_code`（下划线，
 * 与 §4.1.3 逐字一致），而 `HarnessId` 是 `claude-code`（连字符，计划 Task 5.1 的签名）。
 * 两个写法都是合法的出处，所以做一张显式表并在这里报名 ——
 * 若靠 `id.replace("_","-")` 蒙过去，那么将来任何一处键名漂移都会
 * **静默丢掉那一格岗位书参数**（读不到就当没写）。
 */
export const HARNESS_ID_ALIASES: Readonly<Record<string, HarnessId>> = {
  "claude-code": "claude-code",
  claude_code: "claude-code",
  codex: "codex",
  qoder: "qoder",
};

/**
 * 把 `unrecognizedHarnessKeys` + `shadowedHarnessKeys` 的读数拼成【一句】能照着改的话。
 *
 * ⚠ 这一句【只有一份】，被两处用：charterSchema 的 superRefine（写入期 ⇒ 422）
 * 与 `harnessDefaultsFor`（读取期 ⇒ 抛）。在两处各写一遍同一个解释，就是本仓最贵
 * 那一族失效（两份抄本）：改了其中一处，另一处的报错会开始说一套做一套。
 *
 * @returns 没有问题 ⇒ `null`（不是空串 —— 调用方要能一眼分清「没问题」与「有问题但消息是空」）。
 */
export function harnessDefaultsKeyProblem(
  raw: Record<string, unknown> | undefined,
): string | null {
  const unknown = unrecognizedHarnessKeys(raw);
  const shadowed = shadowedHarnessKeys(raw);
  if (unknown.length === 0 && shadowed.length === 0) return null;
  const parts: string[] = [];
  if (unknown.length > 0) {
    parts.push(
      "【没有任何读取方】的键 [" +
        unknown.join(", ") +
        "]：读取侧只认 HARNESS_ID_ALIASES 里那些名字，认不出的键会被【整个跳过】",
    );
  }
  if (shadowed.length > 0) {
    parts.push(
      "同一家写了【两种写法】，其中一格【永远读不到】：" + shadowed.join("；"),
    );
  }
  return (
    "harness_defaults 配了【读不到】的格 —— " +
    parts.join(" ｜ ") +
    "。两种情形的失效方向【不一样】，而这正是要拦的理由：sandbox 那一格读不到 ⇒ " +
    "落回 read-only（比要求的严，无害）；forbidden_flags 那一格读不到 ⇒ " +
    "落回 []（【岗位书写了的禁令一条都不生效，且全绿】）。合法键：" +
    Object.keys(HARNESS_ID_ALIASES).join(" / ") +
    "。修法二选一：① 每家只留【一个】上表里的键名（下划线与连字符都合法，留一个）；" +
    "② 删掉那一格。"
  );
}

/** 取某角色岗位书里针对某个 harness 的默认参数。未声明 ⇒ undefined（不是空对象）。
 *
 * ⚠⚠ 【键级】判据在读取期也跑一遍（harnessDefaultsKeyProblem），这不是重复校验：
 * 写入期那一遍（charterSchema）只挡【从那一刻之后】的写入，而本模块的读取侧
 * 读的是【库里已经存着的那份】—— charter/store.ts 的 readCharterConfig 明写着
 * 「不重解析」，并把代价写在它自己文件头：「schema 后来收紧了」会让历史版本
 * 读回来是 Charter 类型而实际缺字段。本仓【没有迁移器】，所以「今天加一条写入期
 * 判据」对昨天存下的那份岗位书一个字都改不动 —— 而这一格失效方向是【开】
 * （forbidden_flags 落回 []）。⇒ 读取期这一遍是那条历史数据的唯一兜底。
 * 抛而不是忽略：与下面「值写坏 ⇒ 抛」完全同一个立场，键与值在失效方向上是一件事。
 */
export function harnessDefaultsFor(
  raw: Record<string, unknown> | undefined,
  id: HarnessId,
): HarnessDefaultEntry | undefined {
  if (raw === undefined) return undefined;
  const keyProblem = harnessDefaultsKeyProblem(raw);
  if (keyProblem !== null) {
    throw new Error(
      "岗位书 harness_defaults 读不出【该用哪一格】：" +
        keyProblem +
        "。刻意【不静默跳过】：跳过 = 这一格不存在，而它的缺省是" +
        "forbidden_flags: []（禁令消失而全绿）。这一版多半是在键级判据生效之前" +
        "存进库的 —— 修法是新存一版岗位书，不是把判据放宽。",
    );
  }
  // 反查：先按原键试，再按别名表里指向同一 id 的那些键试。
  const keys: string[] = Object.keys(HARNESS_ID_ALIASES).filter(
    (k: string): boolean => HARNESS_ID_ALIASES[k] === id,
  );
  for (const k of keys) {
    const hit: unknown = raw[k];
    if (hit === undefined) continue;
    // 不用 zod.ZodResult 标这个类型：zod 4 的命名空间里没导出它（第一次写就撞上，
    // 而它不在任何能离线跑的绿色路径上，只有 tsc 报得出来）。让 TS 自己推。
    const parsed = harnessDefaultEntrySchema.safeParse(hit);
    if (!parsed.success) {
      const first: string | undefined = parsed.error.issues[0]?.message;
      throw new Error(
        "岗位书 harness_defaults." +
          k +
          " 不合法（" +
          (first ?? "形状不符") +
          "）。刻意【不忽略】这一格：忽略一个写错的 sandbox / forbidden_flags，" +
          "得到的适配器会带着【看起来配了而实际没有】的参数跑起来。",
      );
    }
    return parsed.data;
  }
  return undefined;
}

/**
 * 列出 `harness_defaults` 里【没有任何读取方会读到】的键。
 *
 * ── 这一发补的是 harnessDefaultsFor 自己的失效面 ──────────────────────
 * 上面那个函数对【认得的键】里写坏的条目是【抛】的（注释写明「刻意不忽略」），
 * 而对【认不出的键】是 `return undefined` —— 同一份配置里两种失效方向。后者今天
 * 有真实代价，且两个方向不一样：`sandbox` 认不出 ⇒ 落回 read-only（比想要的严，
 * 失败方向是【关】）；`forbidden_flags` 认不出 ⇒ 落回 `[]`（【失败方向是开】——
 * 岗位书写了禁令而那条禁令一条都不生效，且全绿）。实测复算见
 * `.workbuddy/probe331-harness-key.probe.mts`。
 *
 * ── 合法键集【派生自 HARNESS_ID_ALIASES】，不是第二份名单 ──────────────
 * 判「哪些键有人读」若另抄一份键名清单，就是一段话写两处（本仓最贵的那一族失效）。
 * 读取侧解析说明符用的就是这张别名表 ⇒ 可写集 == 可读集 是【结构上】成立的：
 * 将来接第四家时只需往别名表加一行，本判据自动跟上；从别名表删一家，
 * 它的键也自动变成「没人读」而被拒。
 *
 * ⚠ 用 Object.hasOwn 而不是 `HARNESS_ID_ALIASES[k] === undefined`：后者对
 * `toString` / `constructor` 这类**原型链上的名字**取到的是继承来的函数，
 * 于是会把一个【根本没人读】的键判成合法 —— 恰好是这条判据要抓的形状。
 * 别名表是对象字面量（原型是 Object.prototype），这个洞是真的，不是假设。
 *
 * ⚠⚠ 本函数判的是「这个键名在不在别名表里」，**不是**「今天有没有一条生产路线
 * 会去读它」，而这两件事现在【不等价】：表里 `codex` / `qoder` 两格今天没有任何
 * 生产调用方 —— `runViaGateway` 直接 new `ClaudeCliAdapter`，读取侧三处
 * （runtime.ts / gateway-runner.ts 的 buildGatewayDeps）都硬编码 "claude-code"，
 * 而会按 id 取格的路由 `routeTask`（routing.ts，它接 `charterCeiling`）
 * 【零生产调用方】（那个文件自己的横幅就写着「今天一行都不执行」）。
 * ⇒ 一份只写 `{codex: {...}}` 的岗位书在这里是【合法而当下无人读】，实测读数见
 * `.workbuddy/probe331b-harness-shadow.probe.mts` 第 3 格（REJECT 之外那一格：
 * 键合法、schema 放行、读回 undefined）。
 * 这**不是**漏判，是口径边界，写清楚免得下一个人把它当 bug 顺手收紧：
 * 键名合法性与「哪家已接适配器」是两件事（`HARNESS_IDS` 里 qoder 也还没适配器，
 * 见 adapters 目录）。收紧成「只许 claude-code」会把接第二家的路堵死，而那正是
 * 这一格存在的理由。真正要盯的是**另一侧**：接 codex 适配器时，读取点必须换成
 * 按 id 取格（`harnessDefaultsFor(raw, plan.harnessId)`），否则新接的那家
 * 读的还是 claude-code 那一格 —— 那才是这份配置下一个会静默错的地方。
 *
 * @returns 没人读的键名（保持原顺序）；`raw === undefined` ⇒ `[]`（没配 ≠ 配错）。
 */
export function unrecognizedHarnessKeys(
  raw: Record<string, unknown> | undefined,
): string[] {
  if (raw === undefined) return [];
  return Object.keys(raw).filter(
    (k: string): boolean => !Object.hasOwn(HARNESS_ID_ALIASES, k),
  );
}

/**
 * 列出同一家的【两种写法同时出现】时会被【静默丢掉】的那些键名。
 *
 * ── 为什么这是上一条判据的同一族，而不是另一件事 ──────────────────────
 * `harnessDefaultsFor` 按别名表的**声明顺序**逐个试键，命中即 return。所以
 * 一份同时写了 `claude-code` 与 `claude_code` 的岗位书里，后写那一格
 * 【永远读不到】，且不报错、不写审计 —— 与「键名拼错 ⇒ 那格消失」是同一个失效，
 * 差别只在这里连「认不出」这个线索都没有：两个键名都是合法的。
 * 后果仍分两个方向（同上一条）：sandbox 那一格被盖掉 ⇒ 落回更严的档（无害方向）；
 * forbidden_flags 那一格被盖掉 ⇒ 岗位书写的禁令少一条，且全绿。
 *
 * ⚠ 判的是【同一家两种写法】，不是【多家各写一格】——
 * `{ claude_code: {...}, codex: {...} }` 是合法的（两家都在跑的可能路上），
 * 只有解析到【同一个 id】的多个键同时有值才是「一格配了两次」。
 *
 * @returns 会被丢掉的那些键名（每家保留别名表里排最前的那个为胜者，报其余）；
 *          `raw === undefined` ⇒ `[]`。
 */
export function shadowedHarnessKeys(
  raw: Record<string, unknown> | undefined,
): string[] {
  if (raw === undefined) return [];
  const seen: Map<string, string> = new Map();
  const out: string[] = [];
  // 遍历的是【别名表的顺序】而不是 raw 的键序：胜者必须由别名表定，不能由
  // CEO 在 YAML 里写的先后定 —— 否则「哪一份生效」随编辑顺序漂。
  for (const [key, id] of Object.entries(HARNESS_ID_ALIASES)) {
    if (!Object.hasOwn(raw, key)) continue;
    const winner = seen.get(id);
    if (winner === undefined) seen.set(id, key);
    else out.push(key + "（与 " + winner + " 同指 " + id + "，这一格读不到）");
  }
  return out;
}
