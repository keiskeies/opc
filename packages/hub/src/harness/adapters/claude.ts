/**
 * Harness Gateway 的第一个真适配器：Claude Code CLI（2026-11 落地，O6 接线 Step A）。
 *
 * ── 它是什么 ──────────────────────────────────────────────────────────
 * 把 contracts 的 `HarnessAdapter`（execute / resume / getCost 三方法）接到
 * 【现有的】 engine/claude.ts 的 runRole 上 —— 那一层已经在真跑角色轮，
 * 本文件不复制它的 argv 拼装、JSON 解析、超时与 spawn 失败处理，只做**形状翻译**：
 * HarnessRequest → RoleRunInput，再把 RoleRunResult → HarnessEvent 流。
 *
 * ── 本文件【不起进程】──────────────────────────────────────────────────
 * 起子进程的唯一位置仍在 engine/claude.ts（test/arch/role-spawn-boundary.ts 的
 * 点位名单判着这一点）。所以本适配器的安全边界【就是 runRole 里那两个参数】
 * （--permission-mode plan + --max-budget-usd），gateway 那四层在它之前判、
 * 但档位再高也变不出 CLI 侧没有的能力 —— 见下面 sandbox 那条注释。
 *
 * ── 与 gateway 的接缝：started / spawnErrno 的无损穿透 ─────────────────
 * GatewayOutcome 里没有「进程起没起」这一族信息（它只答「调用跑了吗」），
 * 而 Task 6.1 的重试判据（retryableWithoutCost）要的恰是这一族。
 * 所以适配器把每次 execute 的**完整 RoleRunResult** 存进 #lastRun，
 * 由 harness/gateway-runner.ts 在 callHarness 返回后 takeRun() 取走。
 * ⚠ 一个实例同一时刻只服务一次调用：并发接线时必须每调一实例（Step B 的坑，
 * 写死在这里免得变成「两个会话互相踩 lastRun」的竞态）。
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
import type { RoleRunInput, RoleRunResult } from "../../engine/claude.js";
import { runRole } from "../../engine/claude.js";

export interface ClaudeCliAdapterOptions {
  /** 桩 CLI 注入点。与 RoleRunInput.bin 是【同一个入口】，不是测试后门。 */
  readonly bin?: string;
  readonly timeoutMs?: number;
  /**
   * 角色身份（→ --append-system-prompt 的那一格）。
   *
   * ⚠ 它必须在【装配期】给而不是从请求里取：HarnessRequest 刻意没有「角色系统提示词」
   * 这一格（契约文件头：身份装配在 runtime 侧，岗位书渲染器不 import 进契约）。
   * Step B 把活路径切进 gateway 时，若不从这里补回来，runViaGateway 包装的每一轮
   * 都会以 rolePrompt:"" 起进程 —— 岗位书与「你是角色 X」整段静默消失，
   * 而症状只是「这一轮输出质量差」。adapters/claude-adapter.test.ts 的回显断言
   * 是这一格唯一的机器凭据。缺省 "" 保留「没给身份」的诚实形状，不给默认身份文本。
   */
  readonly rolePrompt?: string;
  /**
   * 自报版本。-p 的 JSON 输出里没有版本字段，而适配器【不自己起进程】去跑 --version
   * （role-spawn-boundary 的点位名单），所以只能装配期给；缺省 "unknown" 是
   * 「没装配」的可读形状，不是「版本就叫 unknown」。
   */
  readonly version?: string;
}

export class ClaudeCliAdapter implements HarnessAdapter {
  readonly id: HarnessId = "claude-code";
  /**
   * 逐格凭 claude.ts 的实际行为声明，一格都不许抬：
   *  · budgetHardCap=true     —— runRole 把 maxBudgetUsd 直给 --max-budget-usd，美元硬顶在 CLI 侧真生效。
   *  · toolApproval=false     —— headless -p 没有 canUseTool 那样的审批回调（claude.ts 文件头：SDK 本机装不上）。
   *                              策略要审批时 capabilityGap 必须拒掉这个适配器，而不是让它「看着在审批」。
   *  · resume=true            —— --resume 存在且真传（claude.test.ts 的回显断言钉着）。
   *  · structuredOutput=false —— --output-format json 是 CLI 的信封不是 schema 约束的输出，
   *                              结果里永远不给 structured 格。
   */
  readonly capabilities: HarnessCapabilities = {
    budgetHardCap: true,
    toolApproval: false,
    resume: true,
    structuredOutput: false,
  };

  readonly #o: ClaudeCliAdapterOptions;
  #lastRun: RoleRunResult | null = null;
  #resumeReq: HarnessRequest | null = null;

  constructor(o: ClaudeCliAdapterOptions = {}) {
    this.#o = o;
  }

  /**
   * 取走并清空「这一次 execute 的完整结果」。gateway-runner 靠它区分三态
   * （gateway 拒 / 进程没起 / 起了但业务错）；取走即清，防的是上一次调用的结果
   * 被下一次误当成本次的凭据。
   */
  takeRun(): RoleRunResult | null {
    const r = this.#lastRun;
    this.#lastRun = null;
    return r;
  }

  /**
   * 装配 resume 那一发的工作区/预算/提示词。
   * ⚠ 契约层缺口：HarnessAdapter.resume(sessionId, onApproval) 【不带 HarnessRequest】，
   * 而 CLI 的续会话仍然需要 workspace / 预算 / prompt —— 这些没处传。
   * 只能由 runner 在 callHarness 之前把本次请求种进来（gateway 自己调 resume 时
   * 只会给 sessionId）。Step B 若换 SDK，这条接缝应当随签名一起消失。
   */
  seedResumeRequest(req: HarnessRequest): void {
    this.#resumeReq = req;
  }

  async *#stream(req: HarnessRequest): AsyncGenerator<HarnessEvent> {
    const input: RoleRunInput = {
      prompt: req.instruction,
      // 身份从装配期选项取（见 ClaudeCliAdapterOptions.rolePrompt 为什么不能从请求取）。
      // 缺省 "" 仍是【没给】的诚实形状：装配方漏传时 CLI 拿到的就是空追加段，
      // 而 runtime.ts 那条路线永远显式传 —— 测试的回显断言判的就是这一条链。
      rolePrompt: this.#o.rolePrompt ?? "",
      cwd: req.workspace,
      maxBudgetUsd: req.maxBudgetUsd,
      ...(this.#o.bin !== undefined ? { bin: this.#o.bin } : {}),
      ...(this.#o.timeoutMs !== undefined
        ? { timeoutMs: this.#o.timeoutMs }
        : {}),
      ...(req.resumeSessionId !== undefined && req.resumeSessionId !== ""
        ? { resumeSessionId: req.resumeSessionId }
        : {}),
    };
    // ⚠ req.sandbox / req.requestedArgs 在这里【故意不被消费】：
    // runRole 的参数面是写死的 plan 档，CLI 路线上不存在「按档位放开写权限」的通道。
    // 提级的判定归 gateway（safety 第 2 层），但它放行只说明【策略允许】，
    // 不说明 CLI 真拿到了那一档 —— 今天这一适配器所有档位都跑在 plan 里。
    const r = await runRole(input);
    this.#lastRun = r;

    // sessionId 为 null（进程没起 / 输出坏了 / CLI 没给）⇒ 【不发】session_started。
    // 编一个假 id 会让 gateway 装配出一条「可恢复」的审计行，而那一格指不回任何会话。
    if (r.sessionId !== null) {
      yield { kind: "session_started", sessionId: r.sessionId };
    }
    yield { kind: "usage", cost: this.#costOf(r) };
    yield {
      kind: "finished",
      // 只有 ok:true 那一支的退出码是【结构性可证】的 0（claude.ts 成功分支的前提
      // 就是 raw.code === 0）。其余一律 null：RoleRunResult 不带退出码，
      // 编 0 会把「没拿到进程信息」写成「进程正常退出」。
      exitCode: r.ok ? 0 : null,
      outcome: {
        harnessId: this.id,
        harnessVersion: this.#o.version ?? "unknown",
        // 实际家族：-p 的 JSON 不回显模型，只能回落到请求的期望值；请求也没给就 "unknown"。
        // 这是【继承的形状】不是实测 —— §12.6 判独立性之前要在 Step B 补真读数。
        modelFamily: req.modelFamily ?? "unknown",
        output: r.text,
        // plan 模式不写盘 ⇒ 没有 diff。null 不是空串。
        diffHash: null,
        // capabilities.structuredOutput=false ⇒ 这一格恒 undefined。
        // 契约的 transform 输出形状要求属性【存在】，undefined 是「没给」的形状，
        // 给任何东西（含 null）都会被读成「有结构化产出且它是空的」。
        structured: undefined,
      },
    };
  }

  #costOf(r: RoleRunResult): CostReport {
    // 美分口径：Math.round(×100) 与 gateway 的 usdToCentsRound 同一个函数形状。
    // 浮点尾数（0.042*100=4.2000000000000002）由 round 吃掉。
    // ⚠ 已知坍缩：runRole 把「CLI 没报 total_cost_usd」折成 0（claude.ts 的 cost 行），
    // 适配器拿到的 0 分不出【报了零】与【没记】，而 source 只能给一个值。
    // 选 "harness" 的理由：数字的来源是 CLI 的 stdout；缺字段时的默认 0 是 runRole
    // 给的 —— 这一格失真发生在上游形状里，本层恢复不了，登记给 Step B。
    return {
      spentCents: Math.round(r.costUsd * 100),
      remainingCents: null,
      // token 两格：-p 的 JSON 信封里没有 token 字段（runRole 只取四个键），
      // 契约注释点名「未知就缺省，不要填 0」—— transform 输出要求属性存在，
      // 所以这里的 undefined 就是「没记到」，与上面 spentCents 的坍缩同族、登记 Step B。
      inputTokens: undefined,
      outputTokens: undefined,
      source: "harness",
    };
  }

  /**
   * onApproval 在这里【不被调用】：toolApproval=false 已声明「没有审批回调」，
   * 策略要审批的请求在 capabilityGap 就被拒了，走不到 execute。
   * 留着形参是为了签名一致；若哪天在这里「代为问一次」，声明就成了谎话。
   */
  execute(
    req: HarnessRequest,
    _onApproval: ApprovalHandler,
  ): AsyncIterable<HarnessEvent> {
    return this.#stream(req);
  }

  resume(
    sessionId: string,
    _onApproval: ApprovalHandler,
  ): AsyncIterable<HarnessEvent> {
    if (this.#resumeReq === null) {
      // 不编 workspace/预算：resume 的形状必须来自装配方，编出来的「能跑的默认值」
      // 会让「没接线的 resume」以合法形状跑进审计。
      throw new Error(
        "ClaudeCliAdapter.resume 之前没有 seedResumeRequest：" +
          "契约的 resume(sessionId, ...) 不带 HarnessRequest，续会话所需的工作区/预算/prompt 无处传。" +
          "装配方（gateway-runner）必须在 callHarness 之前种入本次请求。",
      );
    }
    return this.#stream({ ...this.#resumeReq, resumeSessionId: sessionId });
  }

  /**
   * 跨调用会话账【不存在】：CLI 的账单只在一次 -p 调用的 JSON 里（那次已经由 usage
   * 事件交过了）。再起一次进程去「查账」既花不起（一次查询一次钱）也起不了
   * （本文件不许自己 spawn）。所以这里【抛】而不是返回一个全零 CostReport ——
   * 全零会被读成「这次会话一分钱没花」，那是假话。
   */
  getCost(_sessionId: string): Promise<CostReport> {
    return Promise.reject(
      new Error(
        "claude-code 适配器没有跨调用会话账：消耗只在单次 -p 输出里，已随 usage 事件给出；" +
          "本适配器不为此再起进程。",
      ),
    );
  }
}
