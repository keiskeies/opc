/**
 * 第二个真适配器：Qoder Agent SDK（2026-11，执行器七件套）。
 *
 * ── 它是什么 ──────────────────────────────────────────────────────────
 * ClaudeCliAdapter 是「自己 spawn CLI 再解析 stdout」；这一家走官方
 * @qoder-ai/qoder-agent-sdk 的 query() —— CLI 子进程由 SDK 自己管。
 * 所以本文件【不起进程】（没有 child_process，role-spawn-boundary 的点位
 * 名单对它同样干净：SDK 的 daemon 是它自己的子进程，不是本仓 spawn 的），
 * 只做形状翻译：HarnessRequest → query({prompt, options})，SDKMessage 流 →
 * HarnessEvent 流（真流式：init→session_started、tool_use→tool_call、
 * result→usage+finished，边收边译）。
 *
 * ── 字段凭据 ─────────────────────────────────────────────────────────
 * 装机的 1.0.59 dist/*.d.ts：system.init 带 session_id / qodercli_version / model；
 * assistant 带 message.content[]（text | tool_use{id,name,input} | thinking）；
 * result 带 subtype / is_error / result / errors / total_credits / usage
 * （input_tokens、output_tokens 恒为数，credits 可选）。本文件不 import SDK 类型进
 * 判定路径：下面的窄类型是它的【消费面子集】，单测按同一形状注入桩，真链路交给
 * 默认装载器（与 plugins/service.ts 的 mcpConnector 同一立场）。
 *
 * ── 为什么真流式而不是收齐再吐 ───────────────────────────────────────
 * tool_use 块在流里实时可见 ⇒ 逐发译成 tool_call 进 gateway。换来的是否决权的
 * 时间差：gateway 观测到越权会 .return() 我们的生成器，【还没执行的后续动作】
 * 被掐断（宁停不污，gateway 那侧注释是同一立场）；收齐再吐只能把越权记成事后账。
 * 事件流这一路与 canUseTool 回调这一路共用 gateway 的同一份判定缓存（判定恰好
 * 一次、卡片只有一张，见 gateway.ts toolVerdict），适配器两边都给是契约期望的
 * 完整形状 —— 只给回调不给人家叫「有审批没观测」，只给观测不叫「有通报没拦截」。
 *
 * ── capabilities 逐格（对着真实行为声明，一格不许抬）──────────────────
 *  · budgetHardCap=false    —— SDK 的 Options 里没有预算参数，USD 硬顶在 SDK 侧没有
 *                              对应物。带 max_budget_usd>0 的请求会被 capabilityGap
 *                              拒掉（gateway 的立场：外层兜底不是「硬顶」）。
 *  · toolApproval=true      —— canUseTool 是真审批回调（types/permissions.d.ts 的
 *                              CanUseTool），#bridgeApproval 把它桥到契约的 ApprovalHandler。
 *  · resume=true            —— options.resume 是真字段（types/options.d.ts 核过）。
 *  · structuredOutput=false —— 请求只给 schema 的【名字】不给本体，本层没有
 *                              name→schema 注册表，接不上受约束输出 ⇒ 不声明。
 */
import type {
  ApprovalHandler,
  CostReport,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessEvent,
  HarnessId,
  HarnessRequest,
} from "@opc/contracts";
import type {
  SDKMessage as QoderSdkMessage,
  Options as QoderSdkOptions,
} from "@qoder-ai/qoder-agent-sdk";
import type { RoleRunResult } from "../../engine/claude.js";
import { redact } from "../safety.js";

/** SDK 消息流里本适配器【消费得到】的那几格（1.0.59 的线形状子集）。 */
export interface QoderSdkUsageLite {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  credits?: number;
}

export interface QoderSdkMessageLite {
  type: string;
  subtype?: string;
  session_id?: string;
  qodercli_version?: string;
  model?: string;
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
    }>;
  };
  is_error?: boolean;
  result?: string;
  errors?: string[];
  total_credits?: number;
  usage?: QoderSdkUsageLite;
}

export interface QoderCanUseToolOptionsLite {
  toolUseID: string;
}

export type QoderPermissionResultLite =
  | { behavior: "allow" }
  | { behavior: "deny"; message: string };

export type QoderCanUseToolLite = (
  toolName: string,
  input: Record<string, unknown>,
  options: QoderCanUseToolOptionsLite,
) => Promise<QoderPermissionResultLite>;

export interface QoderQueryOptionsLite {
  auth?: Record<string, unknown>;
  cwd?: string;
  resume?: string;
  allowedTools?: string[];
  permissionMode?: "default" | "plan" | "bypassPermissions";
  allowDangerouslySkipPermissions?: boolean;
  canUseTool?: QoderCanUseToolLite;
  /** SDK options.d.ts 的模型格（装配期给，见 QoderCliAdapterOptions.model）。 */
  model?: string;
  /** SDK options.d.ts 的 CLI 路径格（装配期给，见 QoderCliAdapterOptions.bin）。 */
  pathToQoderCLIExecutable?: string;
}

export type QoderQueryFnLite = (params: {
  prompt: string;
  options?: QoderQueryOptionsLite;
}) => AsyncIterable<QoderSdkMessageLite>;

export interface QoderCliAdapterOptions {
  /**
   * SDK query 的注入点（测试桩）。缺省 = 默认装载器动态 import
   * "@qoder-ai/qoder-agent-sdk" —— 装载动作在第一次 execute 里发生（不在构造期：
   * 装配一个从不调用的适配器不该因为没装包而炸）。
   */
  readonly queryFn?: QoderQueryFnLite;
  /**
   * SDK 的 auth 选项。缺省 {type:"qodercli"}（复用本机 qodercli 登录态 ——
   * 桌面单机部署的默认身份）。PAT 部署由装配方传 accessTokenFromEnv() 的返回值。
   */
  readonly auth?: Record<string, unknown>;
  /** 自报版本兜底；缺省时读 init 消息的 qodercli_version，都没有 ⇒ "unknown"。 */
  readonly version?: string;
  /**
   * 模型名（round363，T6）：member_executors.config.model 的落点，转进 SDK 的
   * options.model（options.d.ts:275）。缺省不给 ⇒ SDK 用它自己的默认。
   */
  readonly model?: string;
  /**
   * CLI 可执行文件路径（装配期注入点，与 claude 的 bin 同族）：转进 SDK 的
   * options.pathToQoderCLIExecutable（options.d.ts:282）。缺省 ⇒ SDK 自己找。
   */
  readonly bin?: string;
}

/**
 * 权限档位映射（HarnessRequest → SDK 的 permissionMode）。
 * 导出是为了映射本身能被单测逐格钉住 —— 拼错一格的症状是「该问的不问 /
 * 该放开的写不进」，两条都在审批语义上，不能靠 e2e 撞出来。
 *
 *  · on-request ⇒ "default" —— 要问就真问：未预授权的操作走 canUseTool，
 *    决策权在 hub 的审批侧（#bridgeApproval）。
 *  · never + read-only ⇒ "plan" —— 规划档默认不落地变更，与 read-only 同语义。
 *  · never + 其余 ⇒ "bypassPermissions" —— never 的契约是「没人来批、放开跑」：
 *    SDK 的 "dontAsk" 会把未预授权操作【拒掉】（与「放行」相反），"plan" 又把
 *    workspace-write 锁死，只有 bypass 对得上语义；SDK 要求与
 *    allowDangerouslySkipPermissions 并给（options.d.ts:291 的注释点名这对组合）。
 *    敢不敢给这一对由 gateway 背书：sandbox 与禁项在前置层已判过，
 *    走到这里的请求是策略上允许写的。
 */
export function qoderPermissionModeFor(
  req: HarnessRequest,
): "default" | "plan" | "bypassPermissions" {
  if (req.approvalPolicy === "on-request") return "default";
  if (req.sandbox === "read-only") return "plan";
  return "bypassPermissions";
}

/**
 * 模型名 → 模型家族（§12.6 判对抗性审查独立性读的是【实际家族】）。
 * 认不出 ⇒ "unknown"（下游据此保守处理），不猜。
 */
export function qoderModelFamilyOf(model: string | undefined): string {
  const m = (model ?? "").toLowerCase();
  if (m.includes("claude")) return "claude";
  if (m.includes("gpt") || m.includes("codex") || /^o[134]/.test(m)) {
    return "gpt";
  }
  if (m.includes("qwen")) return "qwen";
  return "unknown";
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** SDK 异常上能拿到的 errno 类代码（daemon/进程起不来时 SDK 会带 code）。 */
function errCode(e: unknown): string {
  if (typeof e === "object" && e !== null && "code" in e) {
    const c: unknown = (e as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  return "";
}

/** 默认装载器：动态 import SDK 的 query()，窄化成本适配器的消费面。 */
async function* qoderDefaultQuery(params: {
  prompt: string;
  options?: QoderQueryOptionsLite;
}): AsyncGenerator<QoderSdkMessageLite> {
  const { query } = await import("@qoder-ai/qoder-agent-sdk");
  // 两处窄化只发生在这一条缝上：auth 在本适配器是「装配方给什么传什么」的
  // 不透明对象（Lite 的 Record 与 SDK 的 AuthOptions 联合互不可比），
  // 消息流从 SDKMessage 收窄到消费面子集。单测不经过这里（走 queryFn 桩）。
  const messages = query({
    prompt: params.prompt,
    options: (params.options ?? {}) as unknown as QoderSdkOptions,
  });
  for await (const msg of messages) {
    yield msg as QoderSdkMessageLite;
  }
}

export class QoderCliAdapter implements HarnessAdapter {
  readonly id: HarnessId = "qoder";
  readonly capabilities: HarnessCapabilities = {
    budgetHardCap: false,
    toolApproval: true,
    resume: true,
    structuredOutput: false,
  };

  readonly #o: QoderCliAdapterOptions;
  #lastRun: RoleRunResult | null = null;
  #resumeReq: HarnessRequest | null = null;
  #versionFromInit: string | null = null;
  #familyFromInit = "unknown";

  constructor(o: QoderCliAdapterOptions = {}) {
    this.#o = o;
  }

  /** 与 ClaudeCliAdapter.takeRun 同形：取走即清，三态映射的凭据不能连拿两次。 */
  takeRun(): RoleRunResult | null {
    const r = this.#lastRun;
    this.#lastRun = null;
    return r;
  }

  /** 契约缺口同款（resume(sessionId,...) 不带 HarnessRequest）：装配方先种本次请求。 */
  seedResumeRequest(req: HarnessRequest): void {
    this.#resumeReq = req;
  }

  #queryFn(): QoderQueryFnLite {
    return this.#o.queryFn ?? qoderDefaultQuery;
  }

  /**
   * canUseTool ↔ ApprovalHandler 的桥。三个刻意的形状：
   *  · args 传【redact(input)】而不是 input：事件流那一发（tool_call）带的也是
   *    redact(input)，gateway 的判定缓存按 `工具名+参数 JSON` 键控 —— 两路同一份
   *    脱敏后形状，同一次调用才【判一次、一张卡片】（gateway.ts verdictKey 那段
   *    写的正是两路形状漂移的后果）。path/command 这些判定要读的键不在
   *    SECRET_KEY 名单里，越界与不可逆判定不受脱敏影响。
   *  · reason 带 toolUseID：审批卡片要能指回 SDK 那一次挂起的调用。
   *  · deny 的 message 原样回到 SDK（模型可见），所以写「谁拒的」而不是空话 ——
   *    模型据此才知道该换路而不是重试。
   */
  #bridgeApproval(onApproval: ApprovalHandler): QoderCanUseToolLite {
    return async (toolName, input, options) => {
      const d = await onApproval({
        tool: toolName,
        args: redact(input),
        reason: "qoder 工具权限确认（toolUseID=" + options.toolUseID + "）",
      });
      return d.approved
        ? { behavior: "allow" }
        : {
            behavior: "deny",
            message:
              "hub 审批侧拒绝（decidedBy=" +
              (d.decidedBy ?? "unknown") +
              "）" +
              (d.note === undefined || d.note === "" ? "" : "：" + d.note),
          };
    };
  }

  #optionsFor(
    req: HarnessRequest,
    onApproval: ApprovalHandler,
  ): QoderQueryOptionsLite {
    const mode = qoderPermissionModeFor(req);
    return {
      auth: this.#o.auth ?? { type: "qodercli" },
      cwd: req.workspace,
      // allowedTools 只在【不问人】的档位给：default（on-request）档里它是
      // 「预授权名单」—— 命中的工具 SDK 直接放行、【不走 canUseTool】。若照传，
      // gateway 第 3 层（Bash(rm -rf) 逐参数不可逆判定）就永远等不到那一问，
      // prevention 的 enforced 声明当场变谎话。不传 ⇒ 每一发工具调用都经
      // canUseTool 进 gateway，第 1 层白名单判的是【同一份】req.allowedTools，
      // 判定语义不丢、只是从「SDK 预授权」换成「我们逐发判」—— 后者才是装配意图。
      ...(mode === "default" ? {} : { allowedTools: [...req.allowedTools] }),
      // forbiddenFlags【不映射】到 SDK：SDK 的 disallowedTools 要的是【工具名】，
      // 而 forbiddenFlags 是 CLI 开关串（"--dangerously-skip-permissions"），
      // 传进去永远匹配不到任何工具 —— 留着就是一处「看起来接了线」的装饰。
      // 它的真正执法点在 gateway：requestedArgs 命中禁项 ⇒ safety_blocked。
      permissionMode: mode,
      // SDK 判据：bypassPermissions 必须与这一格并给，缺对时 SDK 自己拒跑。
      ...(mode === "bypassPermissions"
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      ...(req.approvalPolicy === "on-request"
        ? { canUseTool: this.#bridgeApproval(onApproval) }
        : {}),
      ...(req.resumeSessionId !== undefined && req.resumeSessionId !== ""
        ? { resume: req.resumeSessionId }
        : {}),
      // model/bin 有值才给（与 claude 的 --model 同一立场：不替 SDK 编默认值，
      // 也不传空串——空串会让 SDK 拿着一个不存在的模型名去报错）。
      ...(this.#o.model !== undefined && this.#o.model !== ""
        ? { model: this.#o.model }
        : {}),
      ...(this.#o.bin !== undefined && this.#o.bin !== ""
        ? { pathToQoderCLIExecutable: this.#o.bin }
        : {}),
    };
  }

  async *#stream(
    req: HarnessRequest,
    onApproval: ApprovalHandler,
  ): AsyncGenerator<HarnessEvent> {
    // 家族先落「期望」：没读到 init 的 model 之前，这是【继承的形状】不是实测
    // （claude 适配器同款登记）；init 一到就被真读数覆盖。
    this.#familyFromInit = req.modelFamily ?? "unknown";
    let seenAny = false;
    let sessionId: string | null = null;
    let sessionEmitted = false;
    let assistantText = "";
    let cost: CostReport | null = null;
    const emitted = new Set<string>();
    try {
      for await (const m of this.#queryFn()({
        prompt: req.instruction,
        options: this.#optionsFor(req, onApproval),
      })) {
        seenAny = true;
        if (m.type === "system" && m.subtype === "init") {
          sessionId = m.session_id ?? null;
          this.#versionFromInit = m.qodercli_version ?? null;
          const fam = qoderModelFamilyOf(m.model);
          this.#familyFromInit =
            fam !== "unknown" ? fam : (req.modelFamily ?? "unknown");
          if (sessionId !== null && !sessionEmitted) {
            sessionEmitted = true;
            yield { kind: "session_started", sessionId };
          }
        } else if (m.type === "assistant") {
          for (const block of m.message?.content ?? []) {
            if (block.type === "text") {
              assistantText += block.text ?? "";
            } else if (block.type === "tool_use") {
              // 键=tool_use 的 id：同一块的重复通报会让 gateway 的判定缓存把
              // 第二发记成「拒了还照做」（proceeded_after_verdict），而真相是
              // 一次调用被适配器发了两遍。
              const key = block.id ?? block.name + ":" + assistantText.length;
              if (!emitted.has(key)) {
                emitted.add(key);
                // 脱敏在适配器做（契约对 redactedArgs 的点名要求）。Qoder 的工具名
                // 本来就是 Claude 词表（Read/Edit/Bash…），无需翻译 —— 这是它和
                // codex（command_execution 那套自有词表）的唯一词表差别。
                yield {
                  kind: "tool_call",
                  tool: block.name ?? "unknown",
                  redactedArgs: redact(block.input ?? null),
                };
              }
            }
          }
        } else if (m.type === "result") {
          // result 是权威末发：session_id 在 init 缺席时从这里兜底。
          if (sessionId === null) sessionId = m.session_id ?? null;
          cost = {
            // Credits→美分的【口径塌缩】：SDK 报的是 Credits（1.0.59 的
            // total_credits / usage.credits；旧版 CLI 两格都缺 ⇒ 0）。
            // 与 claude 的「没记就 0」同族登记：预算侧要真数只改这一处换算。
            spentCents: Math.round(
              (m.total_credits ?? m.usage?.credits ?? 0) * 100,
            ),
            remainingCents: null,
            inputTokens: m.usage?.input_tokens,
            outputTokens: m.usage?.output_tokens,
            source: "harness",
          };
          const win = m.subtype === "success" && m.is_error !== true;
          this.#lastRun = {
            ok: win,
            text: win ? (m.result ?? assistantText) : assistantText,
            sessionId,
            costUsd: cost.spentCents / 100,
            error: win
              ? null
              : "qoder result 失败（" +
                (m.subtype ?? "is_error") +
                "）：" +
                (m.errors?.join("；") ?? "is_error=true"),
            // 走到 result ⇒ 会话真存在过（钱可能真花了）⇒ started:true。
            started: true,
            spawnErrno: "",
          };
          break;
        }
      }
    } catch (e) {
      // 一帧没见过 ⇒ 调用从未成立（daemon/CLI 起不来之类）⇒ started:false +
      // errno 透出，交给重试白名单判（与 claude 的 spawn 失败同格）。
      // 见过帧 ⇒ 会话/钱可能真存在过 ⇒ started:true（不可自动重试）。
      this.#lastRun = {
        ok: false,
        text: assistantText,
        sessionId,
        costUsd: 0,
        error: errText(e),
        started: seenAny,
        spawnErrno: seenAny ? "" : errCode(e),
      };
    } finally {
      // finally 而不是 catch 的理由与 codex.ts 逐字同：gateway 观测到越权后
      // .return() 我们的生成器，那既不走 catch 也走不到末尾，只有 finally 接得住；
      // 「跑到一半被我们掐死」必须以 started:true 进三态映射，不能读成「从未开始」。
      if (this.#lastRun === null) {
        this.#lastRun = {
          ok: false,
          text: assistantText,
          sessionId,
          costUsd: 0,
          error: "qoder 消息流结束而没有 result 事件",
          started: seenAny,
          spawnErrno: "",
        };
      }
    }

    const r = this.#lastRun;
    // init 没带 session_id 而 result 兜到了 ⇒ 补发（契约上 session_started
    // 必须在 usage 之前）。两处都没给 ⇒【不发】：编一个假 id 会装配出一条
    // 「可恢复」而指不回任何会话的审计行（claude.ts 同一立场）。
    if (!sessionEmitted && r.sessionId !== null) {
      yield { kind: "session_started", sessionId: r.sessionId };
    }
    yield {
      kind: "usage",
      // result 读到过 ⇒ 权威账单（含 token 两格）；没读到 ⇒ 兜底造一条
      // spentCents=r.costUsd 的（失败支 costUsd 恒 0 ⇒ 「没记到」的形状），
      // token 缺省 undefined 而不是 0（契约点名的假话形状）。
      cost:
        cost ??
        ({
          spentCents: Math.round(r.costUsd * 100),
          remainingCents: null,
          inputTokens: undefined,
          outputTokens: undefined,
          source: "harness",
        } as CostReport),
    };
    yield {
      kind: "finished",
      // SDK 路线没有进程退出码（契约 CostReport 文件头点名的同款）⇒ null，不编 0。
      exitCode: null,
      outcome: {
        harnessId: this.id,
        harnessVersion: this.#o.version ?? this.#versionFromInit ?? "unknown",
        modelFamily: this.#familyFromInit,
        output: r.text,
        // 本层没有 diff 读数器（写盘与否不由本层观测）⇒ null 恒给，不是空串。
        diffHash: null,
        // capabilities.structuredOutput=false ⇒ 恒 undefined（给 null 都会被
        // 读成「有结构化输出且它是空的」）。
        structured: undefined,
      },
    };
  }

  /**
   * onApproval 在 approval_policy=never 时【不被调用】：那时 canUseTool 压根没
   * 装进 options（#optionsFor），SDK 侧由 permissionMode 单向决定放行/拒；
   * on-request 时它是唯一的放行通道（#bridgeApproval）。
   * ⚠ never 档里 tool_call 事件【照发】—— 那是 observed_only 的观测来源
   * （gateway 的 prevention 一格靠它，claude 那家连这个都没有是 CLI 形状所限，
   * 这一家流里有就【不该省】）。
   */
  execute(
    req: HarnessRequest,
    onApproval: ApprovalHandler,
  ): AsyncIterable<HarnessEvent> {
    return this.#stream(req, onApproval);
  }

  resume(
    sessionId: string,
    onApproval: ApprovalHandler,
  ): AsyncIterable<HarnessEvent> {
    if (this.#resumeReq === null) {
      // 不编 workspace/预算：理由与 claude.ts 逐字同 —— 编出来的「能跑的默认值」
      // 会让「没接线的 resume」以合法形状跑进审计。
      throw new Error(
        "QoderCliAdapter.resume 之前没有 seedResumeRequest：" +
          "契约的 resume(sessionId, ...) 不带 HarnessRequest，续会话所需的工作区/预算/prompt 无处传。" +
          "装配方（gateway-runner）必须在 callHarness 之前种入本次请求。",
      );
    }
    return this.#stream(
      { ...this.#resumeReq, resumeSessionId: sessionId },
      onApproval,
    );
  }

  /** 与 claude 同款：账单只在本次 query 的 result 里，跨调用会话账不存在 ⇒ 抛。 */
  getCost(_sessionId: string): Promise<CostReport> {
    return Promise.reject(
      new Error(
        "qoder 适配器没有跨调用会话账：消耗只在单次 query 的 result 里，已随 usage 事件给出。",
      ),
    );
  }
}

// 类型引用保活：SDKMessage 只在窄化说明里出现，编译期检查消费面子集与真类型的
// 赋值方向（SDKMessage → Lite 必须成立，注释里那句「窄化只发生在一条缝上」靠它兜底）。
export type QoderSdkMessageShapeCheck =
  QoderSdkMessage extends QoderSdkMessageLite
    ? true
    : { mismatch: "QoderSdkMessageLite 比 SDKMessage 更宽，装载器窄化失效" };
