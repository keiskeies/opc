/**
 * Gateway 的装配薄层：把「岗位书授权 + 注入槽」拼成 GatewayDeps，
 * 再把 callHarness 的结果翻回 RoleRunResult 形状（2026-11 落地，O6 接线 Step A）。
 *
 * ── 这一层存在的唯一理由 ──────────────────────────────────────────────
 * gateway.ts 的 GatewayDeps 把 grantedSandbox / grantedForbidden 设为【必填】，
 * 理由写在那格注释里：缺授权档位说明调用方还没接岗位书，该在装配期炸，
 * 而不是运行期静默放行。但「从岗位书取档位」这件事本身（harnessDefaultsFor +
 * 缺省口径）如果被每个调用点各抄一遍，就会漂出 N 份「缺省时当成什么」的口径。
 * 所以集中在这一处。
 *
 * ── 三态映射（本文件的全部判据）────────────────────────────────────────
 * GatewayOutcome 不携带「进程起没起」，而 Task 6.1 的重试判据要的恰是这一族。
 * 适配器把完整 RoleRunResult 存进 takeRun()，这里按它把出口分成四格：
 *   ① gateway 拒且【适配器没跑过】（禁止项/预算/档位/越界命中）
 *      ⇒ ok:false、started:false、spawnErrno:""。
 *      ⚠ spawnErrno 给【空串】而不是编一个 errno：空串不在 SPAWN_TRANSIENT_ERRNOS
 *      上 ⇒ retryableWithoutCost 恒 false ⇒ 安全拒【永不自动重试】。重试一次安全拒
 *      没有意义（判据不会变），还会白烧一次审计。
 *   ② 进程没起（ENOENT 等）⇒ started:false + 真 errno 原样透出 —— 交给
 *      runTurnWithRetry 的白名单去判放不放行（ENOENT 确定性 ⇒ 那边会挡）。
 *   ③ 进程起了但业务错（CLI is_error / 非零退出）⇒ ok:false、started:true、
 *      errno:"" ⇒ 不可重试（起过进程就可能真花了钱）。
 *   ④ 全绿 ⇒ ok:true + text + sessionId + costUsd。
 *
 * ── runner 自己不碰库 ─────────────────────────────────────────────────
 * audit / checkBudget / settle 全部是注入槽。tracker.consume 有 inStepTx 纪律
 * （必须处在超步事务里），runner 不知道也不该知道外层事务长什么样 ——
 * 所以 settle 原样透传给 GatewayDeps.settle，落哪个事务是 Step B 调用方的事。
 */

import type { HarnessRequest, SandboxTier } from "@opc/contracts";
import { harnessDefaultsFor } from "@opc/contracts";
import type { RoleRunResult } from "../engine/claude.js";
import type { AuditRow } from "../events/recorder.js";
import type { ClaudeCliAdapterOptions } from "./adapters/claude.js";
import { ClaudeCliAdapter } from "./adapters/claude.js";
import type { GatewayDeps } from "./gateway.js";
import { callHarness } from "./gateway.js";

export interface GatewayRunnerDeps {
  /** 落审计的回调（gateway 的必填 audit 槽）。 */
  readonly audit: (row: AuditRow) => number;
  /**
   * 岗位书的 harness_defaults 原始格（charter 的 record 形状）。
   * ⚠ 【undefined = 没接岗位书】⇒ 装配期抛（gateway 注释的立场）。
   * 接了岗位书但没写 claude-code 那一格（传 {} 也行）⇒ 走缺省 read-only + 空基线。
   */
  readonly charterHarnessDefaults?: Record<string, unknown>;
  /** 显式覆盖授权档位（装配测试与「路由给了更高档位」的将来路径用；缺省读岗位书）。 */
  readonly grantedSandbox?: SandboxTier;
  /** 显式覆盖授权基线。 */
  readonly grantedForbidden?: readonly string[];
  /** 预算闸门：注入槽，runner 不碰库。 */
  readonly checkBudget?: GatewayDeps["checkBudget"];
  /** 事后消费上报：注入槽。落哪个事务由调用方决定（tracker 的 inStepTx 纪律在它那边）。 */
  readonly settle?: GatewayDeps["settle"];
  readonly now?: () => number;
}

/**
 * 把 runner deps + 本次请求拼成 GatewayDeps。
 * 单独导出是为了「装配期抛」这一发能在不跑任何进程的情况下被测到。
 */
export function buildGatewayDeps(deps: GatewayRunnerDeps): GatewayDeps {
  const explicit =
    deps.grantedSandbox !== undefined || deps.grantedForbidden !== undefined;
  if (deps.charterHarnessDefaults === undefined && !explicit) {
    // gateway 的 audit 格注释：拿不到授权档位 ⇒ 调用方还没接岗位书 ⇒ 装配期炸，
    // 不是运行期静默放行。这里连「一个都不传也算装配完成」都不放行。
    throw new Error(
      "buildGatewayDeps：既没给 charterHarnessDefaults 也没显式授权档位。" +
        "grantedSandbox/grantedForbidden 是 Gateway 的被比侧，缺它们就等于" +
        "第 1/2 层在拿请求和【自己】比（gateway.ts 注释点名的自比失效）。",
    );
  }
  const entry = harnessDefaultsFor(deps.charterHarnessDefaults, "claude-code");
  return {
    audit: deps.audit,
    // 缺省口径集中在这一行：岗位书没写 claude_code.sandbox ⇒ read-only（最严档）。
    // 「没接岗位书」在上面已经抛了，走到这里缺格只是「声明了默认最严」。
    grantedSandbox: deps.grantedSandbox ?? entry?.sandbox ?? "read-only",
    // 缺省空基线：基线为空只是「岗位书没点名禁令」，「运行时不许缩短」仍由
    // forbiddenFlagBlock 对【本次请求】的 forbidden_flags 成立。
    grantedForbidden: deps.grantedForbidden ?? entry?.forbidden_flags ?? [],
    ...(deps.checkBudget !== undefined
      ? { checkBudget: deps.checkBudget }
      : {}),
    ...(deps.settle !== undefined ? { settle: deps.settle } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  };
}

function fail(
  text: string,
  sessionId: string | null,
  costUsd: number,
  error: string | null,
  started: boolean,
  spawnErrno: string,
): RoleRunResult {
  return { ok: false, text, sessionId, costUsd, error, started, spawnErrno };
}

/**
 * 经 Gateway 跑一次角色调用。每次调用【新造一个适配器实例】：
 * 适配器要把「这一次 execute 的完整结果」带出来（takeRun），共享实例会让
 * 两次并发调用互相踩对方的结果 —— 实例化在这里，竞态就在结构上不存在。
 */
export async function runViaGateway(
  adapterOptions: ClaudeCliAdapterOptions,
  req: HarnessRequest,
  deps: GatewayRunnerDeps,
): Promise<RoleRunResult> {
  const gwDeps = buildGatewayDeps(deps);
  const adapter = new ClaudeCliAdapter(adapterOptions);
  if (req.resumeSessionId !== undefined && req.resumeSessionId !== "") {
    adapter.seedResumeRequest(req);
  }
  const g = await callHarness(adapter, req, gwDeps);
  const run = adapter.takeRun();

  if (g.ok) {
    if (run === null) {
      // gateway ok:true 必然消费过 finished，而 finished 只能在 execute 的流里发出，
      // 那时 #lastRun 已写 —— 走到这里说明适配器的存储被绕过（结构性不该发生）。
      // 抛，不编一个 ok 结果：那会把「存储接缝坏了」伪装成「角色跑成功了」。
      throw new Error(
        "runViaGateway：gateway 成功却没有 takeRun()，适配器结果存储接缝坏了",
      );
    }
    if (!run.ok) {
      // 三态里的「起了但业务错」：CLI 报 is_error/非零退出。gateway 侧那行
      // harness_call 照常落账（调用真发生了、账单真报了），这里翻成失败轮。
      return fail(
        run.text,
        run.sessionId,
        run.costUsd,
        run.error,
        run.started,
        run.spawnErrno,
      );
    }
    return {
      ok: true,
      text: g.result.output,
      sessionId: g.result.sessionId,
      // 美分→美元的【唯一】换算点（本行）：预算侧全程美分（CostReport 文件头的理由），
      // RoleRunResult 的 costUsd 是既有形状的历史口径。0.042 美元会先被适配器
      // Math.round 成 4 美分再在这里变回 0.04 —— 半美分的精度损失是【记账口径】
      // 决定的，不是这里的 bug；要保精度的读数请读 gateway 审计行的 spent_cents。
      costUsd: g.result.cost.spentCents / 100,
      error: null,
      started: true,
      spawnErrno: "",
    };
  }

  // gateway 拒绝。先分清「拒绝发生时适配器跑没跑过」—— 这决定 started 的真值。
  // ⚠ run === null 【单独】不足证「没跑」：#lastRun 在 runRole 返回后、任何事件
  // 发出【之前】写入 —— spawn ENOENT 那发 lastRun 已置（started:false）却被 gateway
  // 以 no_session 拒掉。真判据是一个构造性蕴含：
  //   ① 前置层（能力/预算/禁止项/档位/越界）命中 ⇒ execute 从未被调 ⇒ run 必为 null；
  //   ② execute 被调 ⇒ 第一个事件 yield 前 lastRun 已写；gateway 消费过 finished 才
  //      走到事件循环之后 ⇒ run 必非 null。
  // 所以 run 非 null 只可能发生在 execute 之后，此时 !run.started 恰是
  // 「spawn 自己抛了（ENOENT/EPERM…），进程从未存在」⇒ 与 ① 同归「结构上没花过钱」。
  if (run === null || !run.started) {
    // 进程从未存在（gateway 拒于进程之前，或 spawn 直接失败）。
    // spawnErrno：没跑过 ⇒ 空串（【没有过 spawn 尝试】，retryableWithoutCost 恒 false，
    // 安全拒永不自动重试）；跑过而没起 ⇒ 真 errno 透出，交给重试白名单判。
    return fail(
      run?.text ?? "",
      run?.sessionId ?? null,
      run?.costUsd ?? 0,
      run === null
        ? "gateway 拒绝（" + g.code + "）：" + g.reason
        : (run.error ?? "gateway 拒绝（" + g.code + "）：" + g.reason),
      false,
      run?.spawnErrno ?? "",
    );
  }
  // 进程起过、run 成功，但 gateway 仍拒（今天可达的形状：无 session_started ⇒ no_session）。
  return fail(
    run.text,
    run.sessionId,
    run.costUsd,
    "gateway 拒绝（" + g.code + "）：" + g.reason,
    true,
    "",
  );
}
