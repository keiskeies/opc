/**
 * 第三个真适配器：Codex SDK（2026-11，执行器七件套）。
 *
 * ── 它是什么 ──────────────────────────────────────────────────────────
 * ClaudeCliAdapter 自己 spawn CLI；QoderCliAdapter 走 query() 单发收齐；这一家
 * 走 @openai/codex-sdk 的 Thread.runStreamed() —— SDK 自管子进程，本文件【不起
 * 进程】（role-spawn-boundary 点位名单对它干净）。形状翻译两件事：
 * HarnessRequest → new Codex(...) + startThread(opts).runStreamed(prompt)，
 * ThreadEvent 流 → HarnessEvent 流。
 *
 * ── 字段凭据 ─────────────────────────────────────────────────────────
 * 装机 0.167.0 的 dist/index.d.ts 全文核过：thread.started 带 thread_id；
 * item.started/updated/completed 带 ThreadItem（command_execution 有 command，
 * mcp_tool_call 有 server/tool/arguments，file_change 有 changes[{path,kind}]，
 * agent_message 有 text，web_search 有 query，error 有 message）；
 * turn.completed 带 Usage（五个 token 计数，【没有任何金额格】）；
 * turn.failed 带 error.message；error 事件带 message。
 * 本文件不 import SDK 类型进判定路径：CodexEventLite 是消费面子集，单测按同一
 * 形状注入桩，真链路走默认装载器（与 qoder.ts / plugins/service.ts 同一立场）。
 *
 * ── 为什么这一家真流式而 qoder 单发 ──────────────────────────────────
 * runStreamed 本来就是异步事件生成器，边收边译是它的自然形状。真流式还换来一件
 * 实事：不可逆的 command_execution 在 item.started（命令开跑时）就进 gateway，
 * violation_aborted 能发生在命令跑完【之前】，而不是像只能事后收 result 的那家
 * 只来得及记账。
 *
 * ── capabilities 逐格（对着真实行为声明，一格不许抬）──────────────────
 *  · budgetHardCap=false   —— CodexOptions/ThreadOptions 里没有预算参数，
 *                            max_budget_usd>0 会被 capabilityGap 拒（外层兜底≠硬顶）。
 *  · toolApproval=false    —— SDK 的 approvalPolicy 是【CLI 自己弹问】的开关，
 *                            没有任何进程内回调把问题递进 hub；声明 true 就是谎报，
 *                            而 §12.7 第四层整节的存在理由就是这条不许谎报。
 *                            后果是诚实的：on-request 请求在装配期就被拒；
 *                            never 请求里不可逆工具以 observed_only 进审计
 *                            （gateway 的 approval_too_late 那一路）。
 *  · resume=true           —— resumeThread(id) 是真字段。
 *  · structuredOutput=false—— TurnOptions.outputSchema 存在，但契约请求只带 schema
 *                            【名字】不带本体，接不上 ⇒ 不声明。
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
  Codex as CodexSdkClass,
  ThreadEvent as CodexSdkEvent,
} from "@openai/codex-sdk";
import type { RoleRunResult } from "../../engine/claude.js";
import { redact } from "../safety.js";

/** turn.completed 的五个 token 计数（Usage 逐字同形 —— 没有金额格）。 */
export interface CodexUsageLite {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

/** ThreadItem 的消费面子集：type 之外的格按类型各取所需，除 id/type 外全可选。 */
export interface CodexItemLite {
  id: string;
  type: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  status?: string;
  changes?: Array<{ path: string; kind: string }>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  query?: string;
  message?: string;
}

/** ThreadEvent 的窄形状：type 判别，其余格按事件类型可选。 */
export interface CodexEventLite {
  type: string;
  thread_id?: string;
  usage?: CodexUsageLite;
  error?: { message: string };
  item?: CodexItemLite;
  message?: string;
}

export interface CodexThreadLite {
  readonly id: string | null;
  runStreamed(
    input: string,
    turnOptions?: Record<string, unknown>,
  ): Promise<{ events: AsyncIterable<CodexEventLite> }>;
}

export interface CodexThreadOptionsLite {
  model?: string;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
}

/** Codex 实例的消费面（真 SDK 的 startThread/resumeThread 都是同步返回）。 */
export interface CodexLikeLite {
  startThread(options?: CodexThreadOptionsLite): CodexThreadLite;
  resumeThread(
    threadId: string,
    options?: CodexThreadOptionsLite,
  ): CodexThreadLite;
}

export type CodexCtorLite = new (
  options?: Record<string, unknown>,
) => CodexLikeLite;

export interface CodexCliAdapterOptions {
  /**
   * Codex 构造器的注入点（测试桩）。缺省 = 默认装载器动态 import
   * "@openai/codex-sdk"（装载发生在第一次 execute，不在构造期 ——
   * 装配一个从不调用的适配器不该因为没装包而炸）。
   */
  readonly codexCtor?: CodexCtorLite;
  /** 透传给 Codex 构造器的装配项（codexPathOverride / apiKey / env / config…）。 */
  readonly codexOptions?: Record<string, unknown>;
  /** 自报版本兜底；SDK 事件流里没有版本格，缺省即 "unknown"（不编 CLI 版本）。 */
  readonly version?: string;
  /**
   * 模型名（round363，T6）：member_executors.config.model 的落点，转进
   * startThread/resumeThread 的 options.model（CodexThreadOptionsLite 本来就有
   * 这一格，此前没人填）。缺省不给 ⇒ SDK 用它自己的默认。
   * CLI 路径不在这里：那走 codexOptions.codexPathOverride（上面构造器透传格）。
   */
  readonly model?: string;
}

/**
 * 沙箱档位映射（HarnessRequest.sandbox → Codex 的 sandboxMode）。
 * 词表恰好逐字同形是运气，逐格钉住是纪律 —— 拼错一格 = read-only 岗位书跑在
 * danger-full-access 上，正是 gateway 档位排序想挡的形状，不能让它从适配器重新打开。
 * danger 档附带 skipGitRepoCheck：Codex CLI 默认要求工作区是 git 仓库，而 danger
 * 的语义是「不受 git 仓库边界约束」，不带上这一格危险档会被 CLI 自己的检查拒掉。
 */
export function codexSandboxModeFor(
  req: HarnessRequest,
): "read-only" | "workspace-write" | "danger-full-access" {
  if (req.sandbox === "read-only") return "read-only";
  if (req.sandbox === "workspace-write") return "workspace-write";
  return "danger-full-access";
}

/**
 * 审批策略直通：契约词汇（never/on-request）与 Codex 的 ApprovalMode 同词同义。
 * ⚠ 直通的是【参数】不是【能力】—— CLI 侧弹问递不进 hub（见 toolApproval=false），
 * on-request 在 capabilityGap 就被拒，能走到这里的实际只有 never。保留映射而不是
 * 写死 never：Codex CLI 自己消费这个参数（on-request 时它对未授权动作取拒而不是
 * 放开），语义只会更紧不会更松。
 */
export function codexApprovalModeFor(
  policy: "never" | "on-request",
): "never" | "on-request" {
  return policy;
}

/**
 * ThreadItem → 要通报进事件流的工具调用（可以 0..n 发：file_change 按【每个被改
 * 文件】一发，让 gateway 的越界检查拿到具体 path；其余类型一发）。
 *
 * 工具名【翻译进 Claude 词表】（Bash / Edit / WebSearch / mcp__srv__tool）：
 * gateway 的白名单匹配与 classifyAction 不可逆表全按那套词写（`Bash(git:*)`、
 * `rm -rf` 子串表、`mcp__` 前缀规则）。不翻译的后果不是报错而是静默失效 ——
 * "command_execution" 不在任何表里，白名单永远拦不住它（第 1 层形状）或风险档
 * 永远认不出它（第 3 层形状），而审计里它看起来是一发「被审过的」调用。
 * 翻译表在这一份函数里只有一处，能被单测逐格钉住。
 */
export function codexToolCallsFor(
  item: CodexItemLite,
): Array<{ tool: string; args: unknown }> {
  switch (item.type) {
    case "command_execution":
      // Bash 的形状与 Claude 侧一致：参数对象带 command 串，classifyAction 的
      // 不可逆子串表（rm -rf / git push --force…）吃的就是这段文本。
      return [{ tool: "Bash", args: { command: item.command ?? "" } }];
    case "mcp_tool_call":
      return [
        {
          tool:
            "mcp__" +
            (item.server ?? "unknown") +
            "__" +
            (item.tool ?? "unknown"),
          args: item.arguments ?? null,
        },
      ];
    case "file_change":
      // 每文件一发：pathArg 认 path 格 ⇒ 第 2 层越界检查拿到真目标路径；
      // 整包一发（changes 数组）会让 pathArg 取不到东西而【静默跳过】越界判定。
      return (item.changes ?? []).map((ch: { path: string; kind: string }) => ({
        tool: "Edit",
        args: { path: ch.path, kind: ch.kind },
      }));
    case "web_search":
      return [{ tool: "WebSearch", args: { query: item.query ?? "" } }];
    default:
      // agent_message / reasoning / todo_list / error 不是「一次工具调用」，
      // 不进事件流（error 的 message 由 #stream 落进失败原因，不冒充工具）。
      return [];
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** SDK 异常上能拿到的 errno 类代码（CLI 二进制起不来时 exec 层会带 code）。 */
function errCode(e: unknown): string {
  if (typeof e === "object" && e !== null && "code" in e) {
    const c: unknown = (e as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  return "";
}

/** 默认装载器：动态 import SDK 的 Codex 类，窄化成本适配器的消费面。 */
async function loadCodexCtor(): Promise<CodexCtorLite> {
  const { Codex } = await import("@openai/codex-sdk");
  // 单向窄化只在这一条缝上：真类的构造入参是 CodexOptions（本适配器当不透明
  // Record 透传），产出的 Thread 比 CodexThreadLite 更宽。单测不经过这里。
  return Codex as unknown as CodexCtorLite;
}

export class CodexCliAdapter implements HarnessAdapter {
  readonly id: HarnessId = "codex";
  readonly capabilities: HarnessCapabilities = {
    budgetHardCap: false,
    toolApproval: false,
    resume: true,
    structuredOutput: false,
  };

  readonly #o: CodexCliAdapterOptions;
  #lastRun: RoleRunResult | null = null;
  #resumeReq: HarnessRequest | null = null;
  #ctor: Promise<CodexCtorLite> | null = null;

  constructor(o: CodexCliAdapterOptions = {}) {
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

  async #ctorOnce(): Promise<CodexCtorLite> {
    if (this.#o.codexCtor !== undefined) return this.#o.codexCtor;
    this.#ctor ??= loadCodexCtor();
    return this.#ctor;
  }

  #threadOptionsFor(req: HarnessRequest): CodexThreadOptionsLite {
    const mode = codexSandboxModeFor(req);
    return {
      sandboxMode: mode,
      workingDirectory: req.workspace,
      ...(mode === "danger-full-access" ? { skipGitRepoCheck: true } : {}),
      approvalPolicy: codexApprovalModeFor(req.approvalPolicy),
      // model 有值才给（与 claude --model / qoder options.model 同一立场）。
      ...(this.#o.model !== undefined && this.#o.model !== ""
        ? { model: this.#o.model }
        : {}),
      // allowed_tools/forbidden_flags 【不】映射：ThreadOptions 里没有对应格，
      // 白名单判据在 gateway 的事件流一路（codexToolCallsFor 的翻译就是为它做的）。
    };
  }

  async *#stream(
    req: HarnessRequest,
    onApproval: ApprovalHandler,
  ): AsyncGenerator<HarnessEvent> {
    // onApproval 在 Codex 全程【一次都不会被调】：capabilities.toolApproval=false，
    // on-request 在 gateway 的 capabilityGap 就被拒，走不到这里的请求没有
    // 「执行前问人」的时刻可问。签名带它只是契约要求（见文件头的能力声明逐格）。
    void onApproval;
    const threadOpts = this.#threadOptionsFor(req);
    const resumeId = req.resumeSessionId;
    let seenAny = false;
    let sessionId: string | null = null;
    let sessionEmitted = false;
    let text = "";
    const errors: string[] = [];
    let cost: CostReport | null = null;
    const emitted = new Set<string>();

    try {
      const codex = new (await this.#ctorOnce())(this.#o.codexOptions);
      const thread =
        resumeId === undefined || resumeId === ""
          ? codex.startThread(threadOpts)
          : codex.resumeThread(resumeId, threadOpts);
      // resume 路线 thread.id 在 runStreamed 之前就有值（构造入参就是它）；
      // startThread 路线它是 null（SDK 注释：首轮开始后才填充）。先问一次 getter，
      // 有值就先发 session_started —— 事件流里的 thread.started 靠 emitted 标志去重，
      // 两条路都保证「至多一发、且是最早可得的一发」。
      const preId = thread.id;
      if (preId !== null && preId !== "") {
        sessionId = preId;
        sessionEmitted = true;
        yield { kind: "session_started", sessionId: preId };
      }
      const { events } = await thread.runStreamed(req.instruction);
      for await (const e of events) {
        seenAny = true;
        if (e.type === "thread.started") {
          if (e.thread_id !== undefined && e.thread_id !== "") {
            sessionId = e.thread_id;
            if (!sessionEmitted) {
              sessionEmitted = true;
              yield { kind: "session_started", sessionId: e.thread_id };
            }
          }
        } else if (
          e.type === "item.started" ||
          e.type === "item.updated" ||
          e.type === "item.completed"
        ) {
          const item = e.item;
          if (item !== undefined) {
            // 通报恰好一次（键=item.id）：同一次调用发两发 tool_call 会让 gateway 的
            // 判定缓存把第二发记成「拒了还照做」（proceeded_after_verdict），
            // 而真相是同一次调用被适配器重复通报。
            if (!emitted.has(item.id)) {
              emitted.add(item.id);
              for (const c of codexToolCallsFor(item)) {
                // 脱敏在适配器做（契约对 redactedArgs 的点名要求）：mcp 参数里
                // 出现 token/secret 键时整值替换；command 形状无密钥键名，
                // redact 是无害直通。
                yield {
                  kind: "tool_call",
                  tool: c.tool,
                  redactedArgs: redact(c.args),
                };
              }
            }
            if (e.type === "item.completed") {
              if (item.type === "agent_message")
                text += (item.text ?? "") + "\n";
              if (item.type === "error")
                errors.push(item.message ?? "error item");
            }
          }
        } else if (e.type === "turn.completed") {
          cost = this.#costFromUsage(e.usage);
          this.#lastRun = {
            ok: true,
            text: text.trimEnd(),
            sessionId,
            costUsd: cost.spentCents / 100,
            error: null,
            started: true,
            spawnErrno: "",
          };
          break;
        } else if (e.type === "turn.failed") {
          errors.push(e.error?.message ?? "turn.failed");
          this.#lastRun = this.#failed(text, sessionId, seenAny, "", errors);
          break;
        } else if (e.type === "error") {
          errors.push(e.message ?? "thread error");
          this.#lastRun = this.#failed(text, sessionId, seenAny, "", errors);
          break;
        }
      }
      // 流尽/中途 break 而没有任何终态可写（比如事件流被对端提前关闭）⇒ finally 兜底。
    } catch (e) {
      // 一帧没见过 ⇒ 调用从未成立（codex 二进制起不来、鉴权炸在 exec 层）⇒
      // started:false + errno 透出，交给重试白名单判（与 claude 的 spawn 失败同格）。
      // 见过帧 ⇒ 会话/钱可能真存在过 ⇒ started:true（不可自动重试）。
      this.#lastRun = this.#failed(
        text,
        sessionId,
        seenAny,
        seenAny ? "" : errCode(e),
        [errText(e), ...errors],
      );
    } finally {
      // finally 而不是 catch 的理由：gateway 观测到越权后会 break 我们的循环 ——
      // 生成器被 .return() 时既不走走 catch 也走不到末尾，只有 finally 接得住。
      // 那一次调用真起过线程（钱可能真花了），takeRun 交出 started:true 而不是 null，
      // gateway-runner 的三态映射才不会把「跑到一半被我们掐死」读成「从未开始」。
      if (this.#lastRun === null) {
        this.#lastRun = this.#failed(text, sessionId, seenAny, "", [
          "codex 事件流结束而没有 turn.completed/turn.failed",
        ]);
      }
    }

    const r = this.#lastRun;
    // sessionId 为 null ⇒【不发】session_started（编一个假 id 会装配出一条
    // 「可恢复」而指不回任何会话的审计行 —— claude.ts 同一立场）。
    if (!sessionEmitted && r.sessionId !== null) {
      yield { kind: "session_started", sessionId: r.sessionId };
    }
    yield {
      kind: "usage",
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
      // SDK 路线没有进程退出码 ⇒ null，不编 0（契约点名的形状）。
      exitCode: null,
      outcome: {
        harnessId: this.id,
        harnessVersion: this.#o.version ?? "unknown",
        // 【继承的形状】不是实测：Codex 事件流里没有模型格，这一格只能是从
        // 请求里带下来的期望值（qoder 的 init.model 有真读数，这一家没有，
        // 差别如实登记，不装作读过）。
        modelFamily: req.modelFamily ?? "unknown",
        output: r.text,
        diffHash: null,
        structured: undefined,
      },
    };
  }

  /**
   * Usage → CostReport 的【口径塌缩】：Codex 报 token 不报钱（订阅制计费，
   * Usage 五格里没有金额）。spentCents=0 的读法是「这台 harness 没有钱数」，
   * 【不是】「这次调用免费」—— 与 claude 的「没记就 0」同族登记。
   * token 两格给真读数；要按 token 折算美元是预算侧的换算层（source 改
   * "converted"）的事，不在这里偷偷发生。
   */
  #costFromUsage(usage: CodexUsageLite | undefined): CostReport {
    return {
      spentCents: 0,
      remainingCents: null,
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
      source: "harness",
    };
  }

  #failed(
    text: string,
    sessionId: string | null,
    started: boolean,
    spawnErrno: string,
    errors: readonly string[],
  ): RoleRunResult {
    const run: RoleRunResult = {
      ok: false,
      text: text.trimEnd(),
      sessionId,
      costUsd: 0,
      error:
        "codex 失败：" + (errors.length > 0 ? errors.join("；") : "无错误详情"),
      started,
      spawnErrno,
    };
    return run;
  }

  /**
   * onApproval 全程不被调用（理由见 #stream 开头那三行）；签名保留是契约形状。
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
      // 不编 workspace/预算：理由与 claude.ts / qoder.ts 逐字同 —— 编出来的
      // 「能跑的默认值」会让「没接线的 resume」以合法形状跑进审计。
      throw new Error(
        "CodexCliAdapter.resume 之前没有 seedResumeRequest：" +
          "契约的 resume(sessionId, ...) 不带 HarnessRequest，续会话所需的工作区/预算/prompt 无处传。" +
          "装配方（gateway-runner）必须在 callHarness 之前种入本次请求。",
      );
    }
    return this.#stream(
      { ...this.#resumeReq, resumeSessionId: sessionId },
      onApproval,
    );
  }

  /** 与 claude/qoder 同款：账单只在本次 run 的 turn.completed 里，跨调用会话账不存在 ⇒ 抛。 */
  getCost(_sessionId: string): Promise<CostReport> {
    return Promise.reject(
      new Error(
        "codex 适配器没有跨调用会话账：消耗只在单次 run 的 turn.completed 里，已随 usage 事件给出。",
      ),
    );
  }
}

// 类型引用保活（与 qoder.ts 的 ShapeCheck 同款）：消费面子集必须是 SDK 类型的
// 【窄侧】—— ThreadEvent extends CodexEventLite 若不成立，说明桩形状比真形状还宽，
// 装载器的窄化就是假话。CodexSdkClass 引用保证 @openai/codex-sdk 在类型层被钉住。
export type CodexEventShapeCheck = CodexSdkEvent extends CodexEventLite
  ? true
  : { mismatch: "CodexEventLite 比 ThreadEvent 更宽，装载器窄化失效" };
export type CodexClassShapeCheck = CodexSdkClass extends CodexCtorLite
  ? true
  : { mismatch: "CodexCtorLite 比 Codex 构造器更宽" };
