/**
 * 执行器运行契约（design-2026-11-23-群角色上层.md D4/D5，实施计划 T6）。
 *
 * ── 这个文件存在的全部理由：一次「让成员干活」在系统里必须有名字 ────────
 * T5 之前，hub 里只有 task 状态机自己会动（dispatch 直接调 engine/claude.ts）。
 * T6 之后，动的人可以是七种东西里的任何一种（三家 CLI、一个 MCP 工具、一个内置
 * 插件、一个裸模型、一个真人）。上层（群聊、待办、会议）不应该知道这七种的差别，
 * 所以这里定下两层形状：
 *
 *   ① ExecutionTarget —— 上层给执行器路由器的【数据】（岗位 + 成员 + 档位 + 指令）。
 *      成员自带 executors 那份【不在这里】：路由表读的是库里当前生效的那份，
 *      调用方传一份进来就等于允许它拿旧快照覆盖新配置（岗位改了、执行器表也改了，
 *      但调用方手里的 MemberView 还是旧的）。
 *   ② ExecutorRun* —— 单个执行器一次尝试的【请求与回执】。回执按 kind 判别，
 *      因为「完成」与「失败」在审计里是两个事件，混成一个 result:ok 布尔会把
 *      「失败但半成功」那一族（CLI 跑完了但输出不是决策 JSON）压扁。
 *
 * 与 harness.ts 那份 ExecutionResult 的区别必须说清，否则下一个人会以为是两份抄本：
 * harness 那一份是【harness 适配器层】的原始回执（哪家 harness、什么沙箱档、
 * diff 哈希、被拦了几次）；本文件这一份是【执行器层】的裁决（这个成员这一轮
 * 到底有没有产出可推进状态机的东西）。纯模型没有 diff、真人没有 session、
 * 插件工具没有沙箱档 —— 那些格子在通用结果里必须缺省而不是填 0，
 * 于是它们只能是两个类型。claude-cli 执行器会把 harness 那份原样带回
 * （harness_result 那一格），这样审计里「哪一层说的」永远可查。
 */
import { z } from "zod";
import { MODEL_TIERS } from "./charter.js";
import {
  EXECUTOR_KINDS,
  type ExecutorKind,
  executorConfigSchema,
} from "./member.js";

/**
 * 一次执行尝试的业务标识。
 *
 * 为什么不是「task_id + seq」够了还要一个 id：重试会写多行审计（每次尝试各自一行，
 * 这是 round305 定的记账口径），没有 per-attempt id 就没法把「第 2 次尝试的 CLI 原始
 * 输出」和「第 2 次尝试的失败审计」连起来。
 */
export const executorRunRequestSchema = z
  .object({
    execution_id: z.string().min(1).max(200),
    task_id: z.string().min(1).max(200),
    member_id: z.string().min(1).max(200),
    role_id: z.string().min(1).max(200),
    /** 成员执行器表里的 seq = 第几个执行器。失败换下一个时，重试层用它取下一格。 */
    seq: z.number().int().min(1).max(99),
    kind: z.enum(EXECUTOR_KINDS),
    /** 已按 kind 判别过的执行器配置（member.ts 的 executorConfigSchema）。 */
    config: executorConfigSchema,
    model_tier: z.enum(MODEL_TIERS),
    /**
     * 这一轮的指令正文（上层拼好的自然语言，含群聊上下文/待办正文）。
     * 与 role_prompt 分开：一个是「这次干什么」，一个是「你是谁」，
     * 混成一段会让 resume 时「该重放的」与「该更新的」分不开。
     */
    instruction: z.string().min(1),
    /** 角色身份提示（岗位书那份），CLI 类执行器追加到系统提示。 */
    role_prompt: z.string().default(""),
    /** CLI 类的工作目录绝对路径；非 CLI 类忽略这一格。缺 = 不允许碰文件系统。 */
    workspace: z.string().min(1).optional(),
    /** CLI 二进制的显式覆盖（装配错 bin 响亮失败用；缺 = 按 kind 的默认命令名）。 */
    bin: z.string().min(1).max(500).optional(),
    /** 上一轮会话 id：CLI 类执行器据此决定是否 --resume。 */
    resume_session_id: z.string().min(1).optional(),
    /** 单次美元硬顶。0 = 不设上限由外层兜（与 harness 请求同一口径，不在此处判）。 */
    max_budget_usd: z.number().nonnegative().default(0),
    timeout_ms: z.number().int().positive().max(3_600_000).optional(),
    /** 真人席的收件线索（human 执行器渲染待办卡片用）。 */
    assignee_hint: z.string().trim().max(200).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    // config.kind 必须与外层 kind 同值 —— member.ts 的 memberExecutorSchema 里
    // 有同一条判据，这里【不是重复校验】：那边判的是招聘页提交的配置，
    // 这里判的是运行期真正派发给执行器的那份请求。请求可以由任何调用方构造
    // （未来的 HTTP 层、未来的重试层），而执行器只认自己 kind 的配置形状。
    // 少这一条 ⇒ 「外层 claude-cli 带着 plugin 配置」能一路走到执行器内部才炸。
    if (data.config.kind !== data.kind) {
      ctx.addIssue({
        code: "custom",
        message: `执行请求 kind=${data.kind} 与 config.kind=${data.config.kind} 不一致。`,
      });
    }
    // workspace 只对三家 CLI 有意义：缺省时 CLI 执行器拿不到工作目录，
    // 与其在 spawn 时拼一个 cwd=undefined（node 会落回 hub 进程目录 = 仓库根），
    // 不如在提交时就 422 —— 静默落回会让「这个员工能看整个仓库」成为默认行为。
    if (
      (data.kind === "claude-cli" ||
        data.kind === "codex-cli" ||
        data.kind === "qoder-cli") &&
      data.workspace === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          `kind=${data.kind} 的执行请求必须带 workspace（绝对路径）：缺省时子进程会落回 ` +
          "hub 自己的目录，等于默认给员工开了整个仓库的读权限。",
      });
    }
  });
export type ExecutorRunRequest = z.infer<typeof executorRunRequestSchema>;

/** 执行器层失败码。枚举是封闭的：新增一格要同时给审计与 UI 文案，不许临时塞字符串。 */
export const EXECUTOR_FAILURE_CODES = [
  /** 该 kind 在注册表里没有实现（配置里写了第八种执行器）。 */
  "executor_unknown_kind",
  /** 注册表里有实现但被装配方禁用（测试/裁剪部署用）。 */
  "executor_disabled",
  /** builtin-plugin / platform-webhook 指向的插件不存在。 */
  "plugin_not_found",
  /** 插件存在但 enabled=false（装过又停用 ≠ 可用）。 */
  "plugin_disabled",
  /** 插件存在且启用，但注册表里没有这个工具名。 */
  "plugin_tool_not_found",
  /** 调用参数过不了工具自己的 input_schema（执行前拒，不发到对端）。 */
  "plugin_tool_invalid_args",
  /** MCP endpoint 连不上 / 协议层报错 / 超时。 */
  "plugin_transport_error",
  /**
   * 工具在对端跑出了业务错（MCP 的 isError:true）或内置模块 run() 自己抛。
   * 与 transport_error 分开：那一格说「没联系上」，这一格说「联系上了、它干了、它报错了」——
   * 前者换执行器可能有效，后者多半换谁执行都是同样的错。
   */
  "plugin_tool_error",
  /**
   * 表里的 config_json.plugin_version 钉在代码侧没有的版本上。
   * 执行【拒绝】而不是静默用新代码跑旧授权（registry.ts versionPinProblem 的产品口径）。
   */
  "plugin_version_mismatch",
  /** 子进程没起来（spawn errno）。 */
  "cli_spawn_failed",
  /** 子进程起来了但非零退出 / 输出不是预期 JSON。 */
  "cli_failed",
  /**
   * Gateway 在调用【之前】拒了（能力缺口/预算闸/禁止项/沙箱档/工作区不合法）。
   * 不并入 cli_failed：那一格说的是「跑了但坏了」，这一格说的是「没跑」——
   * 重试语义相反（换执行器可能有救 vs 同一份请求换谁跑都会撞同一道闸），
   * 且审计里「拦在门外」与「死在门内」是 §12.7 要分开的两类事件。
   */
  "gateway_refused",
  /** 执行成功但没有 <<<OPC_DECISION>>> 块。 */
  "decision_missing",
  /** pure-model 档位拿不到模型（ModelRegistry 拒绝该档）。 */
  "model_unavailable",
  /** human 执行器：卡片已写入待办，这不是错误，但这一轮【没有产出】。 */
  "human_pending",
  /** 执行器自己抛的未分类异常（原话带进审计，不吞）。 */
  "executor_error",
] as const;
export type ExecutorFailureCode = (typeof EXECUTOR_FAILURE_CODES)[number];

const runContextFields = {
  execution_id: z.string().min(1).max(200),
  task_id: z.string().min(1).max(200),
  member_id: z.string().min(1).max(200),
  seq: z.number().int().min(1).max(99),
  kind: z.enum(EXECUTOR_KINDS),
};

/**
 * 一次尝试成功：执行器产出了【可判定】的东西。
 *
 * summary 必填的立场与 engine/claude.ts 的 parseDecision 同源：没有一句话交代，
 * 上层就没法把它渲染进群聊，状态机也不能推进 —— 「跑成功了但谁也不知道干了啥」
 * 必须是类型上不可表达的形状。
 */
export const executorRunDoneSchema = z
  .object({
    ...runContextFields,
    ok: z.literal(true),
    text: z.string(),
    summary: z.string().min(1),
    note: z.string().default(""),
    /** 执行器自报成本（美分）。缺 = 该执行器结构上不知道花了多少（不是 0）。 */
    cost_cents: z.number().int().nonnegative().optional(),
    /** CLI 类返回的会话 id，供下一轮 resume；其他类缺省。 */
    session_id: z.string().min(1).optional(),
    /**
     * 人类执行器留下的待办卡片 id。done + 卡片 同时成立的形状今天不存在
     * （human 的语义是「这一轮没有人格产出」），但契约先留名字格而不是等用到再改 union。
     */
    card_id: z.string().min(1).optional(),
    /** claude-cli 路径把 harness 层原始回执带上（审计要能分清哪一层说了什么）。 */
    harness_result: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ExecutorRunDone = z.infer<typeof executorRunDoneSchema>;

export const executorRunErrorSchema = z
  .object({
    ...runContextFields,
    ok: z.literal(false),
    code: z.enum(EXECUTOR_FAILURE_CODES),
    /** 人类可读的一句话（招聘页/群聊直接展示，不是堆栈）。 */
    message: z.string().min(1),
    /**
     * 换【下一个执行器】重试有意义吗。
     *
     * 这一格【只在这一层】判定，因为只有执行器自己分得清「这个执行器不行」与
     * 「这个活儿不行」：CLI 没装 ⇒ 换下一个执行器（可能就该派给真人）；
     * instruction 为空 ⇒ 换谁都不行。重试层（T7 的 dispatch 接线）读这一格，
     * 不许自己按 code 猜 —— code 会加，语义会变，判定收在一处。
     */
    retry_next_executor: z.boolean(),
    cost_cents: z.number().int().nonnegative().optional(),
    /** 子进程没起来时的 errno 名（其余情况缺省，不是空串：空串要调用方去 trim 才知道是「无」）。 */
    spawn_errno: z.string().min(1).optional(),
  })
  .strict();
export type ExecutorRunError = z.infer<typeof executorRunErrorSchema>;

/**
 * 判别联合。kind 用 "ok" 而不是 "result"：与 hub 各处（GatewayOutcome、
 * 各 service 结果）同一方言，读代码的人不用换脑子。
 */
export const executorRunOutcomeSchema = z.discriminatedUnion("ok", [
  executorRunDoneSchema,
  executorRunErrorSchema,
]);
export type ExecutorRunOutcome = z.infer<typeof executorRunOutcomeSchema>;

/**
 * 执行器路由器的输入（①）。
 *
 * 刻意【不含】executors：路由表读库。上层传一份执行器清单进来看似方便（少一次查询），
 * 实际后果是招聘页改了执行器而群聊还拿着旧 MemberView —— 换人失败与配置变更
 * 在同一次故障里不可分。宁可让调用方多读一次成员。
 */
export const executionTargetSchema = z
  .object({
    task_id: z.string().min(1).max(200),
    member_id: z.string().min(1).max(200),
    role_id: z.string().min(1).max(200),
    model_tier: z.enum(MODEL_TIERS),
    instruction: z.string().min(1),
    role_prompt: z.string().default(""),
    workspace: z.string().min(1).optional(),
    max_budget_usd: z.number().nonnegative().default(0),
    timeout_ms: z.number().int().positive().max(3_600_000).optional(),
    /** 从第几个 seq 开始试（重试层用：上一发失败后从 seq+1 继续）。 */
    from_seq: z.number().int().min(1).max(99).default(1),
  })
  .strict();
export type ExecutionTarget = z.infer<typeof executionTargetSchema>;

/**
 * 路由器的回执：沿着 seq 升序试到第一个成功（或试完）。
 *
 * attempts 必含【每一次】尝试 —— 包括失败的。理由与 harness_call 审计同一句话：
 * 「换人」是用户要能看见的决策（「为什么这个活儿最后是真人干的」），
 * 只回最后一个成功的那发，等于把决策链剪成看起来一步到位。
 */
export const executionOutcomeSchema = z
  .object({
    ok: z.boolean(),
    /** 成功 = 最后成功的那发；全失败 = 最后一发的失败。没有「空 attempts 但 ok=true」。 */
    final: executorRunOutcomeSchema.optional(),
    attempts: z.array(executorRunOutcomeSchema).min(1),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.ok && data.final?.ok !== true) {
      ctx.addIssue({
        code: "custom",
        message: "ok=true 必须带一个 ok=true 的 final：成功不能没有证据。",
      });
    }
    if (!data.ok && data.final?.ok !== false) {
      ctx.addIssue({
        code: "custom",
        message: "ok=false 必须带一个 ok=false 的 final（失败原因要能指认）。",
      });
    }
  });
export type ExecutionOutcome = z.infer<typeof executionOutcomeSchema>;

/**
 * 该执行器要不要工作目录 —— 判定收在契约层，执行器与请求校验共用一份。
 * 两处各写一遍「哪三种是 CLI」是本仓最贵那一族失效（两份抄本）；
 * 加第四家 CLI 时改这里一处，superRefine 与执行器同时跟上。
 */
export const CLI_EXECUTOR_KINDS: readonly ExecutorKind[] = Object.freeze([
  "claude-cli",
  "codex-cli",
  "qoder-cli",
]);
