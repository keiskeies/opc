/**
 * Harness Gateway：唯一的对外调用入口（计划 Task 5.1，规格 §12.1 / §12.5 / §12.7）。
 *
 * ── 这个模块存在的唯一理由：把「能不能调」与「怎么调」分给两个人 ──────────
 * 适配器只管**怎么调**（各家 SDK 的原生能力，§12.3 反过度抽象）；
 * Gateway 只管**能不能调**（能力声明、四层防护、预算、审计）。
 * 这条分工不是风格：如果适配器也能自己决定「这次先跑起来再说」，
 * 那么四层防护就有 N 个绕过口，而 N 会随接入第二家 harness 那天变成 2。
 *
 * ── 能力声明不符 ⇒ 拒绝，不是降级（本模块的核心判据）──────────────────
 * 计划 Task 5.1 的 Test 项原文：「`capabilities` 与实际调用不符时**报错而非静默降级**」。
 * 为什么这一条值得单独立一节，看它最可能的走法：
 * 策略要求工具审批 → 这家没有审批回调（Kimi Print 模式隐式 --afk，§12.3 明写）
 * → 适配器「那就自己跑吧」→ 一次不可逆操作在没有人的情况下被执行，
 * 而审计里那条 harness_call 看起来完全正常。
 * **静默降级的可怕不在于降级，在于事后读不出降级过。** 所以 capabilityGap()
 * 在调用**之前**判，且判据是「策略要求」× 「声明」的笛卡尔积，逐条点名。
 *
 * ── 审计：两类行，action 全用既有枚举 ───────────────────────────────
 *   · 每次调用一行 harness_call：§12.7 第四层点名的七项
 *     （harness 名 + 版本 + 脱敏参数 + session_id + 退出码 + diff 哈希 + 消耗）
 *     **一项都不许缺**，缺的那一项写 null 而不是省键 —— 回放页要能区分
 *     「SDK 路径没有退出码」与「忘了记退出码」，省键会把前者伪装成后者。
 *   · 每一次被拦一行 unauthorized_attempt（含策略命中项），与
 *     author-reviewer.ts 那份 forbidden_removal 载荷同一个 action，kind 不同。
 *
 * ── 预算（§12.5 末段）：调用前查、调用后扣，两件事分开注入 ─────────────
 * 注入的是两个函数而不是一个 BudgetTracker，原因是 tracker.consume **要求调用方
 * 已经在超步事务内**（tracker.ts 文件头明写，且实测过不在事务内直接抛）。
 * Gateway 不是图节点，它常常在事务外被调；硬拿 tracker 进来就会把
 * 「一次 harness 调用」伪装成「一个超步」。所以：
 *   · `checkBudget` —— 纯读，超限就拒（§12.5：超限则拒绝调用并触发预算暂停）；
 *   · `settle` —— 事后消费上报，由调用方决定它在哪个事务里（通常是下一个超步）。
 * 两者之间必然存在一段「已花了但库里没记」的窗口，这是**结构性的**，
 * 不是一段可以修掉的 bug；所以 `settle` 的幂等键由 Gateway 生成并回传，
 * 让调用方能安全重试（重复上报在 budget_events 的 source_event 唯一键上被吃掉）。
 */
import {
  type ApprovalHandler,
  type ApprovalPolicy,
  type CostReport,
  type ExecutionResult,
  executionResultSchema,
  type HarnessAdapter,
  type HarnessCapabilities,
  type HarnessEvent,
  type HarnessRequest,
  type HarnessOutcome,
  SANDBOX_TIERS,
  type SandboxTier,
  type ToolApprovalRequest,
} from "@opc/contracts";
import {
  type AuditRow,
} from "../events/recorder.js";
import {
  approvalBlock,
  type ApprovalVerdict,
  forbiddenFlagBlock,
  needsApproval,
  preventionFor,
  redactArgs,
  type SafetyBlockCode,
  type SafetyVerdict,
  sandboxTierBlock,
  toolWhitelistBlock,
  workspaceContainmentBlock,
} from "./safety.js";

/**
 * Gateway 拒绝时的码。与 safety 的码分开：那是「这一层拦的」，这是「整个调用没发生」。
 *
 * `duplicate_session_event` 与 `event_after_finish` 是两个不同的适配器异常，
 * 刻意不合成一个 `adapter_protocol_error`：前者说明【会话身份不确定】（恢复会接错），
 * 后者说明【结果之后还有事】（审计已经写完却在继续），两件的修法完全不同。
 * 合并成一个码就等于把「哪种坏法」这个唯一有用的信息扔掉。
 */
export const GATEWAY_REJECT_CODES = [
  "capability_gap",
  "budget_exceeded",
  "safety_blocked",
  "no_session",
  "no_result",
  "invalid_result",
  "violation_aborted",
  "duplicate_session_event",
  "event_after_finish",
] as const;
export type GatewayRejectCode = (typeof GATEWAY_REJECT_CODES)[number];

export type GatewayOutcome =
  | { ok: true; result: ExecutionResult; auditEventIds: number[]; settleIdempotencyKey: string }
  | { ok: false; code: GatewayRejectCode; reason: string; auditEventIds: number[] };

/**
 * 能力缺口。逐条给出「策略要什么 / 声明有什么」，因为报错要能指到该改哪一格。
 *
 * 为什么 `resume` 只在 `resumeSessionId` 有值时才要求：新建会话不需要恢复能力，
 * 要求它等于把 Codex 之外的一半挡在门外（§12.2 里 Qoder 用 --session-id、
 * Claude 用 --resume，Codex 是 session 机制，三家都「支持」但表达方式不同）。
 *
 * `structuredOutput` 只在**请求给了 outputSchema** 时才要求 —— 同理，
 * 不要结构化输出就不需要那项能力。
 */
export function capabilityGap(
  req: HarnessRequest,
  caps: HarnessCapabilities,
): string[] {
  const gaps: string[] = [];
  if (req.approvalPolicy === "on-request" && !caps.toolApproval) {
    gaps.push(
      "策略要求工具审批（approval_policy=on-request），但适配器声明 toolApproval=false",
    );
  }
  if (req.maxBudgetUsd > 0 && !caps.budgetHardCap) {
    gaps.push(
      "请求带预算硬顶 $" +
        req.maxBudgetUsd +
        "，但适配器声明 budgetHardCap=false —— 外层兜底可以做，" +
        "但那不是「硬顶」，把它当硬顶用就是拿一种保证换一种更弱的保证",
    );
  }
  if (req.resumeSessionId !== undefined && !caps.resume) {
    gaps.push("请求要恢复会话，但适配器声明 resume=false");
  }
  if (req.outputSchema !== undefined && !caps.structuredOutput) {
    gaps.push(
      "请求要结构化输出（output_schema=" +
        req.outputSchema +
        "），但适配器声明 structuredOutput=false",
    );
  }
  return gaps;
}

/**
 * §12.7 第四层那七项的审计载荷。**每一项都在类型里**，缺值的写 null。
 * 这不是形式：本仓已经有过一次「payload 缺字段是三个月后才发现（而且永远发现不了，
 * 因为没人能追问一条没写下来的理由）」的教训（policy/auto-approve.ts 文件头）。
 */
export interface HarnessCallPayload {
  readonly action: "harness_call";
  readonly task_id: string;
  readonly role_id: string;
  readonly harness_id: string;
  readonly harness_version: string;
  /** 脱敏后的参数（§12.7 第四层逐字要求「脱敏参数」）。 */
  readonly redacted_args: readonly string[];
  readonly sandbox: string;
  readonly approval_policy: string;
  readonly session_id: string | null;
  /** null = 本次调用没有进程退出码（SDK 路径）。与「没记」可区分，见文件头。 */
  readonly exit_code: number | null;
  readonly diff_hash: string | null;
  readonly spent_cents: number;
  readonly cost_source: CostReport["source"];
  readonly blocked_attempts: number;
  /**
   * 逐次审批记录（§12.7 第四层点名项「谁批准了什么」的落点）。
   *
   * 这里【同时记放行的与被拒的】，而且这是本篇里我最没把握的一条设计，理由留在下面：
   * 直觉上审计只需要记「被拦下来的越权」（那是 unauthorized_attempt 那份载荷的活），
   * 而「谁批了这一次 `git push --force`」在只记拒绝的版本里是**查不到的** ——
   * 于是「§12.7 第四层有谁批准了什么」这句话又不成立了。
   * ⚠ 但记下来之后出现了第二个问题：**没被批的那一次在 harness 里可能已经执行了**
   * （§12.7 第三层的暂停原语依赖 harness 在被问时会停下来等；SDK 路径下靠的是
   * canUseTool 那个回调。今天没有任何真实适配器接在这里，所以
   * 「审批拒绝 ⇒ 动作没发生」这句话我在离线状态**验证不了**）。
   * 所以这一格里混着两种被拒（拦住了 / 没拦住但记下了），而当前实现**分不出**它们。
   * 我选择记下来并把分不清这件事写在这里，而不是选择「不记审批以免说谎」：
   * 后者会让人以为 §12.7 那一项已实现。修法需要真实 harness 的语义（Task 5.5）。
   */
  readonly approvals: readonly {
    readonly tool: string;
    readonly approved: boolean;
    readonly decided_by: string | null;
  }[];
  /** 实际用的模型家族（独立性判定读这一格，不读请求里期望的那个）。 */
  readonly model_family: string;
  /** 成功 / 被拦 / 适配器坏了。三值，不给 boolean。 */
  readonly status: "ok" | "blocked" | "adapter_error";
  /**
   * ⚠ 这一格回答的是「那 `blocked_attempts` 个越权，我们是**挡下了**还是只**看见了**」。
   *
   * 为什么必须有它：`status: "blocked"` 读起来像「拦住了」，而那在很多情况下是假的。
   * 唯一真正的拦截点是适配器的审批回调（它动手之前问我们）；如果这台适配器
   * **声明它不会问**（`toolApproval=false`，或策略是 `never` 而它按 never 就不问），
   * 那整个调用过程里我们一次都没有否决权 —— 事件流里那些 tool_call 是**事后通报**，
   * 我们看到 `rm -rf` 的时候它已经跑完了。此时把我们记的行读成「防住了一次」，
   * 就是 §12.7 第四层最怕的那种失真：审计存在、数字对、含义是假的。
   *
   * 口径是**能推出来的那部分**，不含猜测：
   *  - `enforced` —— 这台适配器具备审批能力且策略要求它问（`approval_policy=on-request`）；
   *  - `observed_only` —— 其余全部。注意这不是「一定没拦住」，而是
   *    【我们无从知道自己有没有拦住】，而审计里「不知道」必须有一个自己的值。
   * 这一格的真正用途在 Task 5.3 的路由：一份带 forbidden_flags 且会碰不可逆工具的岗位书，
   * 不该被路由到 `observed_only` 的那一家 —— 那时这一格就是路由的硬约束输入。
   */
  readonly prevention: "enforced" | "observed_only";
}

/** 越权尝试载荷（harness 侧）。与 author-reviewer.ts 那份同 action、不同 kind。 */
export interface HarnessAttemptPayload {
  readonly action: "unauthorized_attempt";
  /**
   * 越权类型：**直接取 safety 那份码表**，不在这里再抄一遍联合类型。
   * 抄一份的话，加一层防护（比如后来的 sandbox_tier_unknown）就会只加在一边，
   * 于是审计载荷里少一个值而编译器不报 —— 那正是我在同一文件里刚写过的
   * 「两套码回答两个问题」要区分的情况吗？不是：那两套是**不同维度**（调用状态 vs 哪一层），
   * 而这里两处是**同一个维度**，同一维度有两份词表就是重复定义。
   */
  readonly kind: SafetyBlockCode;
  /**
   * 在哪一步记到的。**必填**，因为同一次越权在当前实现里可能被记两行：
   * `handler`（事前，适配器问我们要不要放行）与 `event_stream`（事后，适配器把
   * 它打算执行的那一发发给我们看）。两行的 kind 与 detail 一模一样，
   * 所以【不加这一格就无法区分】，而「一次尝试两行」看起来像两次尝试。
   * 我没有去重（去重会把 agent 真的重试两次 `rm -rf` 也压成一行，那是更糟的失真），
   * 所以按 stage 统计才是对的读法 —— 这条口径写在 guides 里而不是只在这里。
   */
  readonly stage: "pre_call" | "handler" | "event_stream";
  readonly task_id: string;
  readonly role_id: string;
  readonly harness_id: string;
  readonly detail: Record<string, unknown>;
}

export interface GatewayDeps {
  /** 落一行审计，返回 events.id。抛错必须往上冒：留痕失败不能当成功。 */
  readonly audit: (row: AuditRow) => number;
  /**
   * **这一格是必填的**，而且这是本文件里唯一一个「宁可让调用方多写一行也不肯可选」的入参。
   *
   * 它是第 2 层的**被比侧**：岗位书 / 路由表授权的沙箱档位。
   * 我第一版写的是 `sandboxTierBlock(req.sandbox, req.sandbox)` —— 同一个值和它自己比，
   * **永远 ok**，而它看起来是一条在判提级的断言。那就是本仓反复记的那一族里最坏的一种：
   * 判据在、调用在、测试也能过（没有任何用例能让它红），只有语义是空的。
   * 所以这里不给默认值（给了默认就等于把那个自比换了个写法），
   * 而是**逼调用方交出授权档位** —— 拿不到授权档位就说明调用方还没接岗位书，
   * 那时该在装配期炸，而不是在运行期静默放行。
   */
  readonly grantedSandbox: SandboxTier;
  /**
   * 岗位书声明的**基线**禁止项（不可减的那一侧）。同上：必填，
   * 因为「运行时能否缩短禁止项」这条判据只有在拿到基线时才成立。
   * 请求里那份 `forbiddenFlags` 是**本次生效**的那份（基线 + 运行时追加）。
   */
  readonly grantedForbidden: readonly string[];
  /** 调用前的预算闸门。返回 undefined = 无该作用域的预算声明（不拦）。 */
  readonly checkBudget?: (o: {
    taskId: string;
    roleId: string;
    /** 本次请求的预算上限（美分），用于「连上限都放不下」这种显然该拒的情形。 */
    wantedCents: number;
  }) => { over: boolean; spentCents: number; limitCents: number } | undefined;
  /** 事后的消费上报，由调用方决定落在哪个事务。 */
  readonly settle?: (o: {
    idempotencyKey: string;
    taskId: string;
    roleId: string;
    spentCents: number;
  }) => Promise<void> | void;
  /** 时钟注入（测试用）。 */
  readonly now?: () => number;
}

/** 幂等键：一次调用一个，重复 settle 只扣一次。 */
function settleKey(req: HarnessRequest, sessionId: string): string {
  // 不用 randomUUID：幂等键的含义是【同一个逻辑调用的重复上报】，
  // 随机值会让每一次重试都是新键，等于没有幂等。
  return "harness:" + req.taskId + ":" + req.roleId + ":" + sessionId;
}

function usdToCentsRound(usd: number): number {
  // 乘 100 之后的浮点尾数（0.07 * 100 = 7.000000000000001）在这里会被 Math.round 吃掉。
  return Math.round(usd * 100);
}

/**
 * 一次 harness 调用。
 *
 * 顺序（**就是优先级**，与 safety.ts 里那四层同序，中间插了两件只有 Gateway 能做的事）：
 *   0 能力声明   —— 不符就拒，连适配器都不碰
 *   0.5 预算闸门 —— §12.5「调用前检查…超限则拒绝调用」
 *   1 绝对禁止项 —— 基线被缩短 / 参数命中
 *   2 沙箱档位   —— 不得提级
 *   3 工作区越界 —— 写目标必须在 workspace 内
 *   4 逐次工具调用：白名单 → 不可逆 ⇒ 审批
 * 前面任何一步拒 ⇒ 已经写下的审计行**保留**（越权尝试的价值恰恰在被记下之后），
 * 返回值里把那些 events.id 交出去，让调用方能说「拦了三次才拒」。
 */
export async function callHarness(
  adapter: HarnessAdapter,
  req: HarnessRequest,
  deps: GatewayDeps,
  onApproval?: ApprovalHandler,
): Promise<GatewayOutcome> {
  const auditIds: number[] = [];
  const write = (row: AuditRow): number => {
    auditIds.push(deps.audit(row));
    return auditIds[auditIds.length - 1] as number;
  };
  const attempt = (
    kind: HarnessAttemptPayload["kind"],
    stage: HarnessAttemptPayload["stage"],
    detail: Record<string, unknown>,
  ): void => {
    const payload: HarnessAttemptPayload = {
      action: "unauthorized_attempt",
      kind,
      stage,
      task_id: req.taskId,
      role_id: req.roleId,
      harness_id: adapter.id,
      detail,
    };
    write({
      taskId: req.taskId,
      actorType: "system",
      actorId: "gateway",
      action: "unauthorized_attempt",
      // target 指被拦的那个具体对象，而不是 "gateway"：审计里「有人试过」必须
      // 能读出「试的是什么」（同 author-reviewer.ts 那条立场）。
      target: typeof detail["tool"] === "string" ? (detail["tool"] as string) : adapter.id,
      payload,
    });
  };
  const reject = (code: GatewayRejectCode, reason: string): GatewayOutcome => ({
    ok: false,
    code,
    reason,
    auditEventIds: auditIds,
  });
  /**
   * 前置四层（禁止项 / 档位）命中 ⇒ 整个调用不发生。
   *
   * 返回码统一用 `safety_blocked` 而【不是】把 safety 那个具体码透出：
   * 那两套码回答的是两个问题 —— GatewayRejectCode 答「这次调用跑了吗、为什么没跑」，
   * SafetyBlockCode 答「是哪一层拦的」。透出会把「哪一层」冒充成「调用状态」，
   * 于是按码统计调用结果的人会看到六个不同的「没跑」。
   * **具体那一层不丢**：它就在同一批审计行的 unauthorized_attempt.kind 里，
   * 而 blocked 那一路（调用跑起来了、只是某次工具调用被拦）也是同一个 kind 词表 ——
   * 两条路的分层信息在审计里同构，这是刻意的。
   */
  const blocked = (v: Extract<SafetyVerdict, { ok: false }>): GatewayOutcome => {
    attempt(v.code, "pre_call", v.detail ?? {});
    return reject("safety_blocked", v.reason);
  };
  /**
   * 逐次审批记录（进 harness_call 那一行的 approvals 格）。
   * **只在真的问过人（或因没人可问而拒）时有一项** —— 不在「不需要审批」时记一条
   * approved:true，否则这一格里混着【没人被问】与【有人批了没留名】两种，
   * 而 §12.7 第四层要读出来的恰好是后者。
   */
  const approvals: {
    tool: string;
    approved: boolean;
    decided_by: string | null;
  }[] = [];

  /**
   * 同一次工具调用的判定缓存，键是 `工具名 + 参数`。
   *
   * 它存在的理由是**同一次调用会被问两次**：适配器先通过 onApproval 问我们
   * 「这个 Bash 能不能跑」，跑之前我们答了；然后它又把同一发 tool_call 发进事件流
   * （那是它「我正在做这件事」的通报）。不缓存的话，一次 `rm -rf` 会
   * ① 让 CEO 看到两张一模一样的审批卡片，② 在 approvals 里留下两行，
   * ③ 在被拒时留下两行 unauthorized_attempt —— 而审计里那是**一次**尝试。
   * 「一次尝试两行」我在 stage 那格注释里说是为了区分事前/事后，但那是指
   * 【一次判定 + 一次观测】，不是【两次判定】。判定必须恰好一次。
   *
   * 键用 JSON 而不是只按工具名：同一个工具两次不同参数（`git status` 与 `git push --force`）
   * 必须分别判，否则第一次「批了 git 相关」会替第二次放行。
   */
  const verdictCache = new Map<string, ApprovalVerdict>();

  /** 缓存键。参数序列化失败（循环引用）时退化成工具名 + 一个不可能的后缀 ⇒ 不共享缓存（宁可多问一次）。 */
  function verdictKey(tool: string, args: unknown): string {
    try {
      return tool + " " + JSON.stringify(args ?? null);
    } catch {
      return tool + " <不可序列化#" + (verdictCache.size + 1) + ">";
    }
  }

  /**
   * 一次工具调用的完整判定（第 1 层白名单 → 第 2 层写目标 → 第 3 层不可逆审批）。
   *
   * 这个函数【被两条路调用】，而这是本节里唯一一处我不能用离线测试证明其正确的设计：
   *   · `onApproval` 回调 —— 适配器在执行**前**问我们（§12.7 第三层「暂停」的真正实现点，
   *     Claude SDK 的 canUseTool 就是这个位置）；
   *   · 事件流里的 tool_call —— 适配器把它的动作**给我们看**。
   * 两条路必须用**同一份判据**：各写一份的话，一定是一份加了某条而另一份没加，
   * 那表现为「同一个动作从回调进得来、从事件流进不来」这种没人能复现的洞
   * （§9.1 与 §12.7 两张不可逆表必须同源，是同一个理由，见 safety.ts needsApproval）。
   *
   * `ask` 区分两条路的**唯一**差别：
   *   · `ask: true`（回调那一路）⇒ 需要审批就问人，这是真正的拦截；
   *   · `ask: false`（事件流那一路）⇒ **不问人**。
   * 第二半是本文件里我认为最重要的一句话：动作已经发生了，此时问人会产生一条
   * 「CEO 批准了这次 rm -rf」的审计记录，而那次 rm -rf 在他看到卡片**之前**就跑完了 ——
   * 那条记录是真的被批过，而它表达的含义（有人事前把关过）是假的。
   * 【事后追认】与【事前批准】在 approvals 这一格里必须是两个不同的值，
   * 而我选择不写「追认」这一格、改记一条 approval_too_late：
   * 因为「谁批准了什么」这句话如果被读成「事前有人看过」，那才是 §12.7 第四层真正要防的失真。
   *
   * ⚠ 【只有 ask:true 那一路是真正的拦截】。另一路发生的时候 harness 已经动手了，
   * 我们只能记账 —— 所以那条路写出来的 unauthorized_attempt 语义是
   * **「观测到一次未授权动作」而不是「挡下了一次」**。status 里那个 blocked
   * 因此是一个偏乐观的词，我在 payload 里用 stage 把两者分开，而不是假装它们同价。
   * 真正的拦截率取决于 harness 是否在被问时停下来 —— 那要接上真实 SDK 才测得出来（Task 5.5）。
   */
  const toolVerdict = async (
    tool: string,
    args: unknown,
    stage: HarnessAttemptPayload["stage"],
  ): Promise<ApprovalVerdict> => {
    const key: string = verdictKey(tool, args);
    const cached: ApprovalVerdict | undefined = verdictCache.get(key);
    if (cached !== undefined) {
      // 判定只做一次（所以 CEO 只会看到一张卡片），但**被拒之后还在事件流里出现**
      // 是一件独立的事实，值得再记一行：那意味着【我们拒了而它照做】。
      // 两行 stage 不同、讲的是两件事，不是同一件事被记两遍；而 blocked_attempts 那个
      // 数【不因此翻倍】—— 它由 verdictCache 派生（见 finish 里那行），
      // 因为契约写的是「> 0 必须能在审计里逐条找到」，一个翻倍的人数会让这句话对不上。
      if (!cached.ok) {
        attempt(cached.code, stage, {
          ...(cached.detail ?? {}),
          proceeded_after_verdict: true,
        });
      }
      return cached;
    }
    const v: ApprovalVerdict = await decide(tool, args, stage === "handler");
    verdictCache.set(key, v);
    // 第一次判出来就是拒 ⇒ 记一行。事件流那一路的 stage 是 event_stream，
    // 它的语义是【观测到】；回调那一路是 handler，语义是【挡下】。
    if (!v.ok) {
      attempt(v.code, stage, v.detail ?? {});
      reasons.push(v.reason);
    }
    return v;
  };

  const decide = async (
    tool: string,
    args: unknown,
    ask: boolean,
  ): Promise<ApprovalVerdict> => {
    const w = toolWhitelistBlock(tool, req.allowedTools, args);
    if (!w.ok) return { ...w, decidedBy: null };
    const target: string | undefined = pathArg(args);
    if (target !== undefined) {
      const c = workspaceContainmentBlock(req.workspace, target);
      if (!c.ok) return { ...c, decidedBy: null };
    }
    if (!needsApproval({ tool, args })) return { ok: true, decidedBy: null };
    if (!ask) {
      return {
        ok: false,
        code: "approval_too_late",
        reason:
          "适配器【没有先问我们】就把一次不可逆操作发进了事件流（工具 [" +
          tool +
          "]）。这一刻动作**已经发生**，所以刻意【不问人】：事后推一张审批卡片只会留下" +
          "一条『有人批准了它』的记录，而那句话是假的（他看到时已经跑完了）。" +
          "修法在适配器：它必须走 onApproval 回调（Claude 的 canUseTool）再动手。",
        detail: { tool },
        decidedBy: null,
      };
    }
    const a: ApprovalVerdict = await approvalBlock(
      {
        tool,
        args,
        reason:
          "工具 [" +
          tool +
          "] 的参数被判定为不可逆动作（§12.7 第三层：高风险调用暂停并推到审批）。" +
          "⚠ 白名单里有这个工具不等于这次参数可以自动批：白名单说【这个工具可以用】，" +
          "这一层问的是【这一次参数能不能用】",
      },
      // 传调用方那一份**原样**（包括 undefined）：approvalBlock 是靠【handler 缺失】
      // 这个事实把它定性成 approval_handler_missing 的。换成一个「自动拒」的假 handler
      // 就把「装配漏传参数」冒充成「有人审过并拒了」—— 后者在审计里是一条正常拒绝，
      // 而前者是一个缺陷，两者必须能分开统计。
      onApproval,
    );
    // 只有真的走到「问人」这一步才记（缺回调而拒的那一次也记：approved:false + decided_by:null，
    // 与「有人批了但没留名」同值 —— 那两种在【这一格】里分不开，但在
    // unauthorized_attempt 的 code 上分得开：approval_handler_missing vs approval_denied）。
    approvals.push({ tool, approved: a.ok, decided_by: a.decidedBy });
    return a;
  };

  /**
   * 适配器拿到的那一份回调。它【不做一遍审批就返回】，而是走同一份 toolVerdict ——
   * 所以 harness 问我们「这个 Write 能不能做」时，我们连白名单与越界一起判了。
   *
   * 返回的是契约里那个窄形状 `ToolApprovalDecision`，【不是】内部 ApprovalVerdict：
   * 多带一个 `ok`/`code` 字段进适配器就是把我们内部的码变成它的输入，
   * 而各家 SDK 对回调返回值的形状是**严格**解读的（多一个键可能被拒），
   * 更重要的是那会让「拿我们的码去分支」成为可能 —— 那个分支不属于 Gateway。
   *
   * 这里取代了第一版的 `requireHandler()`：那个函数在缺回调时自己编一条
   * `approved:false` 交回适配器，于是审批记录上这是一个【看起来由 gateway 做的拒绝】，
   * 而真相是【根本没有审批者】。现在缺回调这条路把 undefined 一路传到 approvalBlock，
   * 定性成 approval_handler_missing，两条在审计里是两个不同的 code。
   */
  const adapterHandler: ApprovalHandler = async (r: ToolApprovalRequest) => {
    const v: ApprovalVerdict = await toolVerdict(r.tool, r.args, "handler");
    return v.ok
      ? { approved: true, ...(v.decidedBy === null ? {} : { decidedBy: v.decidedBy }) }
      : {
          approved: false,
          decidedBy: v.decidedBy ?? "gateway",
          note: v.reason,
        };
  };

  // ── 0. 能力声明 ─────────────────────────────────────────────────────────
  const gaps: string[] = capabilityGap(req, adapter.capabilities);
  if (gaps.length > 0) {
    // 刻意**不**写 unauthorized_attempt：这不是越权，是装配错误
    // （有人把路由指到了一家做不到的 harness）。它该红在配置页与测试里，
    // 不该在审计里冒充一次 agent 的越权尝试 —— 审计是行为记录，不是缺陷登记。
    return reject(
      "capability_gap",
      "适配器 [" +
        adapter.id +
        "] 的能力与本次策略不符，**拒绝调用而不是降级执行**：\n  - " +
        gaps.join("\n  - ") +
        "\n要么换适配器，要么把策略里这一项去掉并说清谁在外面兜它。",
    );
  }

  // ── 0.5 预算闸门 ────────────────────────────────────────────────────────
  const wanted: number = usdToCentsRound(req.maxBudgetUsd);
  if (deps.checkBudget !== undefined) {
    const b = deps.checkBudget({
      taskId: req.taskId,
      roleId: req.roleId,
      wantedCents: wanted,
    });
    if (b !== undefined && (b.over || wanted > b.limitCents)) {
      return reject(
        "budget_exceeded",
        "预算已超限，调用前就拒（§12.5：Gateway 调用前检查当前任务与角色剩余预算，" +
          "超限则拒绝调用并触发预算暂停）。已用 " +
          b.spentCents +
          " 美分 / 上限 " +
          b.limitCents +
          " 美分" +
          // 两种超法要分开说，因为该改的地方不同：已用完 ⇒ 等下个周期或加额；
          // 【上限本来就放不下】⇒ 这次请求的 max_budget_usd 写错了，等多久都不会变好。
          // 第一版只判了 b.over，于是后者在「额度还有余量」时能放行，
          // 而 wanted 那格算出来却根本没用上 —— 那种「变量算了不用」的形状在这里
          // 不是浪费，是一个看起来在判而实际没判的断言。
          (b.over
            ? "（额度已用完）"
            : "（额度尚有余量，但本次请求的上限 " +
              wanted +
              " 美分本身就超出总上限，放过去只会必然撞墙）") +
          "。",
      );
    }
  }

  // ── 1. 绝对禁止项 ───────────────────────────────────────────────────────
  // 基线 = 岗位书那份（deps 给），生效 = 本次那份（请求给）。两者必须是【不同的来源】，
  // 否则这条判据退化成自比（见 deps.grantedForbidden 那条注释）。
  const flagVerdict: SafetyVerdict = forbiddenFlagBlock({
    baseline: deps.grantedForbidden,
    effective: req.forbiddenFlags,
    args: req.requestedArgs,
  });
  if (!flagVerdict.ok) return blocked(flagVerdict);

  // ── 2. 沙箱档位 ─────────────────────────────────────────────────────────
  // granted = 岗位书/路由给的档位（deps 给），requested = 本次想用的档位（请求给）。
  // §12.5 那个缺陷修复流程要求「先 read-only 分析、再 workspace-write 修复」= 两次调用、
  // 两次档位，都在授权范围内（授权给到 workspace-write 时降档放行），所以这一层
  // 挡的是【超出授权】的那一次，而不是「用了不同档位」。
  const tierVerdict = sandboxTierBlock(deps.grantedSandbox, req.sandbox);
  if (!tierVerdict.ok) return blocked(tierVerdict);

  // ── 3. 工作区 ───────────────────────────────────────────────────────────
  // 装配期只判得了「workspace 本身是不是一个绝对路径」这种形状；
  // 逐次写目标的判定在下面的 tool_call 循环里（那时才知道目标）。
  if (!req.workspace.startsWith("/")) {
    return reject(
      "safety_blocked",
      "工作区必须是绝对路径，实到 [" +
        req.workspace +
        "]。相对路径在 Gateway 这一层无法判越界：它会随进程 cwd 变，" +
        "而同一条岗位书在两个目录下意味着两个不同的可写范围。",
    );
  }

  // ── 4. 真的开始调 ───────────────────────────────────────────────────────
  const stream: AsyncIterable<HarnessEvent> =
    req.resumeSessionId === undefined
      ? adapter.execute(req, adapterHandler)
      : adapter.resume(req.resumeSessionId, adapterHandler);

  let sessionId: string | null = null;
  let exitCode: number | null = null;
  let outcome: HarnessOutcome | null = null;
  let cost: CostReport | null = null;
  let sawFinish = false;
  const reasons: string[] = [];

  /**
   * 被拦下的工具调用数。**从 verdictCache 派生而不是单独累加**：
   * 单独累加的那个版本在同一次调用被两条路各判一次时会翻倍（回调一次 + 事件流一次），
   * 而契约里那句「blocked_attempts > 0 必须能在审计里逐条找到」就对不上了。
   * 缓存的键是「工具 + 参数」，所以这个数的口径是【多少个不同的工具调用被拦】，
   * 不是【审计行数】—— 同一个调用被拒后又出现在事件流里会有两行审计（那是另一件事：
   * 它照做了），而这里仍然算一个。**两个口径都留着**：行数在 events 表里数得出来，
   * 这一格数的是「几个不同的动作」。
   */
  const blockedAttempts = (): number => {
    let n = 0;
    for (const v of verdictCache.values()) if (!v.ok) n += 1;
    return n;
  };

  for await (const ev of stream) {
    // 「结果已定之后还有事」必须在**每个事件**上判，而不是只在第二个 finished 上判。
    // 我第一版把它写在 finished 分支里面，于是 finished 之后来一发 usage 会被【静默收下】
    // 并覆盖掉已经定下的消耗 —— 那是本仓反复记的那一族：判据在、分支在、用例也能过
    // （写用例的人只知道 finished 那条路），只有覆盖面是空的。
    if (sawFinish) {
      return finishReject("adapter_error", "event_after_finish",
        "适配器在 finished 之后又发了一发 [" + ev.kind + "]。刻意【不忽略也不采信】：" +
        "忽略等于把「结果已定之后还有事」这个适配器 bug 藏起来，" +
        "而那条 harness_call 已经写完了 —— 继续采只会让审计与真实执行不一致。");
    }
    switch (ev.kind) {
      case "session_started": {
        if (sessionId !== null) {
          // 不覆盖：第二个 session_started 意味着适配器行为异常，
          // 而「以最后一个为准」会让审计里那一格指向一个没人知道的会话。
          return finishReject("adapter_error", "duplicate_session_event",
            "适配器发了第二个 session_started（[" + sessionId + "] → [" + ev.sessionId + "]）。" +
            "刻意不取后者：一次调用只能有一个会话身份，否则恢复时不知道接哪一个。");
        }
        sessionId = ev.sessionId;
        break;
      }
      case "tool_call": {
        // 与 onApproval 那一路【同一个函数、同一份判据】，理由见 toolVerdict。
        // 这一路发生在动作之后，所以判定【不问人】—— 事后追认会留下一条
        // 『有人批准了它』的假记录。
        const v: ApprovalVerdict = await toolVerdict(ev.tool, ev.redactedArgs, "event_stream");
        if (!v.ok) {
          // ⚠ 观测到一次未授权 ⇒ **停止整次调用**（这一句是本文件里唯一一处
          // 「我们其实有否决权」的用法，所以理由写足）。
          //
          // 事件流那一路我们确实拦不住【已经发生的那一发】。但 for-await 里 return
          // 会调用异步迭代器的 return()，于是适配器侧的 finally 会跑 ——
          // 这一半是语言语义，已被 test/harness/gateway.test.ts 那条「中止真的触发适配器的清理钩子」钉住。
          // 【后面还没发生的那些动作】因此是我们能停的；而【适配器在那个 finally 里
          // 能不能真的把 harness 停下】我没验（离线拿不到任何一家 SDK），
          // 所以我刻意不断言「各家 SDK 都是 abort/cancel 形状」—— 那句话按惯例补的话
          // 就是本仓一路在防的「给一条没测过的外部事实」。修法在 Task 5.5。
          //
          // 不停的后果很具体：继续消费的话，这次调用会带着【越权动作的产物】
          // （工作区外那个文件、被推上去的那个分支）以 ok:true 返回，
          // 于是门控与审阅拿到的是一份被污染而看起来正常的产出。
          // 「结果被污染」比「这次调用失败」严重得多：失败会被重试与人工介入，
          // 污染会被当成证据继续往下游走（§14.4 红线一那条同一个方向）。
          //
          // 代价说清楚：停掉会丢掉这次调用的产出（包括合法那部分），
          // 一次任务失败对 CEO 是一次停顿。这个取舍我按「宁停不污」判，
          // 而它是本篇记进决策文档的一条 CEO 级判断，不是一行实现细节。
          return finishReject(
            "blocked",
            "violation_aborted",
            "观测到一次未授权的工具调用，整次调用被中止（工具 [" +
              ev.tool +
              "]，判据 [" +
              v.code +
              "]）。中止的理由不是【那一次调用被我们挡住了】—— 它已经发生了，我们挡不住；" +
              "中止的是【它之后还没发生的那些动作】，因为一个刚刚无视我们判据的会话不值得继续信任。" +
              "产出因此不完整：刻意【不把半截结果当成功返回】。",
          );
        }
        break;
      }
      case "usage": {
        cost = ev.cost;
        break;
      }
      case "finished": {
        // 走到这里 sawFinish 必然是 false（上面那条判据已经拦掉了第二次进入）。
        // 第二发 finished 因此也归 event_after_finish —— 不再单列一个码：
        // 两者讲的是同一件事「结果之后还有事」，而码表里多一个近义码只会让统计口径分裂。
        sawFinish = true;
        exitCode = ev.exitCode;
        outcome = ev.outcome;
        break;
      }
    }
  }

  if (!sawFinish || outcome === null) {
    return finishReject(
      "adapter_error",
      "no_result",
      "适配器没有发 finished 就结束（session=" +
        (sessionId ?? "从未建立") +
        "）。刻意【不编】一个 exitCode=null + output=\"\" 的结果：" +
        "那是一条看起来合法而真相是「根本没跑完」的审计行。",
    );
  }
  if (sessionId === null) {
    return finishReject(
      "adapter_error",
      "no_session",
      "调用结束了而没有 session_id。§12.1 把「可恢复」列为接入判据三件套之一，" +
        "没有会话身份的调用打回时只能从零重来，而审计里也永远指不回它。",
    );
  }

  const spent: number = cost?.spentCents ?? 0;
  let result: ExecutionResult;
  try {
    result = executionResultSchema.parse({
      task_id: req.taskId,
      harness_id: outcome.harnessId,
      harness_version: outcome.harnessVersion,
      model_family: outcome.modelFamily,
      session_id: sessionId,
      output: outcome.output,
      exit_code: exitCode,
      structured: outcome.structured,
      cost: {
        spent_cents: spent,
        remaining_cents: cost?.remainingCents ?? null,
        input_tokens: cost?.inputTokens,
        output_tokens: cost?.outputTokens,
        // 适配器一上来没发 usage ⇒ 这个 0 是**我们**给的默认，不是它报的。
        // 标 estimated 而不是 harness，否则审计里会出现一条「harness 报了 0 美分」的假话。
        source: cost?.source ?? "estimated",
      },
      diff_hash: outcome.diffHash,
      blocked_attempts: blockedAttempts(),
    });
  } catch (e) {
    // 装配结果本身不合法（适配器给了 null / 负数 / 多出来的键）。
    // 这一条【必须落审计】而不能让它抛出去：抛出去的话这次调用在审计里根本没出现过，
    // 而它确实跑过了 —— 这是本文件一直在防的「没留痕的执行」，只是这次是适配器造成的。
    return finishReject(
      "adapter_error",
      "invalid_result",
      "适配器给的结果不符合 executionResultSchema（" +
        (e instanceof Error ? e.message : String(e)) +
        "）。刻意【不放宽 schema 也不跳过这一格】：把不合法的结果修成合法再入库，" +
        "等于把适配器的 bug 伪装成一次正常执行。session=" +
        sessionId +
        " 还留着，可以去查那一发 finished 到底给了什么。",
    );
  }
  // 结构化输出那一项要**声明了才允许有值**（§12.3 能力差异不得被静默吞掉）：
  // 适配器声明 structuredOutput=false 而结果里塞了一份 structured，
  // 意思是它绕过了自己的声明 —— 那正是 capabilityGap 要拦的形状，只是发生在返回侧。
  if (result.structured !== undefined && !adapter.capabilities.structuredOutput) {
    return finishReject(
      "adapter_error",
      "capability_gap",
      "适配器声明 structuredOutput=false，却在结果里返回了 structured。" +
        "声明与行为不符时**不采信结果**：采信就等于告诉下一个人" +
        "「声明可以是假的」，而整层能力声明的价值全在它是真的。",
    );
  }
  const status: HarnessCallPayload["status"] =
    blockedAttempts() > 0 ? "blocked" : "ok";
  finish(status);

  const key: string = settleKey(req, sessionId);
  if (deps.settle !== undefined && spent > 0) {
    await deps.settle({
      idempotencyKey: key,
      taskId: req.taskId,
      roleId: req.roleId,
      spentCents: spent,
    });
  }
  return { ok: true, result, auditEventIds: auditIds, settleIdempotencyKey: key };

  /**
   * 落那一行 harness_call。**每个出口都要落**（成功、被拦、适配器坏了），
   * 所以它是唯一一个从循环内部与外部都能调的收尾函数。
   *
   * 它【不返回要交给调用方的那个结果】—— 第一版让它返回 `GatewayOutcome | null`，
   * 于是五个拒绝出口写成 `return finish(...)` 全都类型不过，而成功出口写成
   * `finish(status, null)` 再丢掉返回值（还得专门写一段注释解释「丢掉是对的」）。
   * 那个形状是错的信号：一个函数同时干两件事（写库 + 决定返回什么），
   * 就必须用 `null` 表达「这次不干第二件事」，而 null 恰好也是本文件里
   * 一路在防的那个值（「没记」与「记了但是空」混在一个编码里）。
   * 现在拆成 finish（只写库）与 finishReject（写库 + 给出拒绝结果）。
   */
  function finish(status: HarnessCallPayload["status"]): void {
    const payload: HarnessCallPayload = {
      action: "harness_call",
      task_id: req.taskId,
      role_id: req.roleId,
      harness_id: adapter.id,
      harness_version: outcome?.harnessVersion ?? "unknown",
      // 命令行形状的参数走 redactArgs（按 --token / --token= 两种形状脱敏），
      // 而不是 redact：redact 只认对象键名，而 harness 的参数是字符串数组 ——
      // 用错那个函数会得到一条【看起来脱过敏而实际原样入库】的密钥，
      // 而 events 是 append-only，删不掉。
      redacted_args: redactArgs(req.requestedArgs),
      sandbox: req.sandbox,
      approval_policy: req.approvalPolicy,
      session_id: sessionId,
      exit_code: exitCode,
      diff_hash: outcome?.diffHash ?? null,
      spent_cents: cost?.spentCents ?? 0,
      cost_source: cost?.source ?? "estimated",
      blocked_attempts: blockedAttempts(),
      approvals,
      model_family: outcome?.modelFamily ?? "unknown",
      status,
      // 与路由用的是同一份判据（见 safety.ts preventionFor 那段：两处各写一份 ternary
      // 会得出「审计写 enforced 而路由当初按 observed_only 判」，那种不一致最难查）。
      prevention: preventionFor(adapter.capabilities, req.approvalPolicy),
    };
    write({
      taskId: req.taskId,
      actorType: "system",
      actorId: "gateway",
      action: "harness_call",
      target: adapter.id,
      payload,
      // 状态快照：把「这次调用属于哪个档位/白名单/禁令」一起钉住。
      // 光有参数重放不出来当时的授权范围，而 §12.7 第四层要的是
      // 「回放可还原当时用的哪个模型、哪个 harness、什么参数、谁批准了什么」。
      stateSnapshot: {
        granted_sandbox: deps.grantedSandbox,
        granted_forbidden: deps.grantedForbidden,
        allowed_tools: req.allowedTools,
        forbidden_flags: req.forbiddenFlags,
        workspace: req.workspace,
        max_budget_usd: req.maxBudgetUsd,
        requested_model_family: req.modelFamily ?? null,
        reject_reasons: reasons,
      },
    });
  }

  /** 落审计 + 给出拒绝结果。所有拒绝出口都走这里，所以「拒绝必然留痕」是结构性的。 */
  function finishReject(
    status: HarnessCallPayload["status"],
    code: GatewayRejectCode,
    reason: string,
  ): GatewayOutcome {
    finish(status);
    return reject(code, reason);
  }
}

/**
 * 从工具参数里取「写目标」路径。只认两种形状：
 * `{ path: "/abs/..." }`（Claude 的 Edit/Write 就是这个形状）与
 * `{ file_path: "/abs/..." }`。取不到 ⇒ undefined（不判，交回 harness 的沙箱）。
 * 口径写死在这里而不是散在各适配器：**同一条判据有两份口径时，
 * 一定是一份认 path 而另一份认 file_path**，而那表现为「某些工具不受越界检查」。
 */
export function pathArg(args: unknown): string | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const o = args as Record<string, unknown>;
  for (const k of ["path", "file_path", "target"] as const) {
    const v: unknown = o[k];
    if (typeof v === "string" && v !== "") return v;
  }
  return undefined;
}

/** 档位排序的可读打印（配置页/报错里用；导出是为了让测试能钉住那个顺序）。 */
export const SANDBOX_ORDER: readonly string[] = SANDBOX_TIERS;
