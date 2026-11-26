/**
 * Gateway 的装配薄层：把「岗位书授权 + 注入槽」拼成 GatewayDeps，
 * 再把适配器经 harness-runner 的四格映射翻回 RoleRunResult 形状
 * （2026-11 落地，O6 接线 Step A；四格实现 round363 起在 harness-runner.ts）。
 *
 * ── 这一层存在的唯一理由 ──────────────────────────────────────────────
 * gateway.ts 的 GatewayDeps 把 grantedSandbox / grantedForbidden 设为【必填】，
 * 理由写在那格注释里：缺授权档位说明调用方还没接岗位书，该在装配期炸，
 * 而不是运行期静默放行。但「从岗位书取档位」这件事本身（harnessDefaultsFor +
 * 缺省口径）如果被每个调用点各抄一遍，就会漂出 N 份「缺省时当成什么」的口径。
 * 所以集中在这一处。
 *
 * ── 三态映射（判据全文在这里，实现在 harness-runner.ts）──────────────────
 * GatewayOutcome 不携带「进程起没起」，而 Task 6.1 的重试判据要的恰是这一族。
 * 适配器把完整 RoleRunResult 存进 takeRun()，按它把出口分成四格：
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
 *      costUsd 由 spentCents/100 得来：预算侧全程美分（CostReport 文件头的理由），
 *      RoleRunResult 的 costUsd 是既有形状的历史口径。0.042 美元先被适配器
 *      Math.round 成 4 美分、再在这里变回 0.04 —— 半美分的精度损失是【记账口径】
 *      决定的，不是 bug；要保精度的读数请读 gateway 审计行的 spent_cents。
 * ⚠ 「适配器跑没跑过」这一族的真判据是一个构造性蕴含，不是 run===null 单条：
 *   run null 时 runRole 返回后、任何事件发出【之前】#lastRun 已写 —— spawn ENOENT
 *   那发 lastRun 已置（started:false）却被 gateway 以 no_session 拒掉。所以：
 *     A 前置层（能力/预算/禁止项/档位/越界）命中 ⇒ execute 从未被调 ⇒ run 必为 null；
 *     B execute 被调 ⇒ 第一个事件 yield 前 lastRun 已写；gateway 消费过 finished 才
 *       走到事件循环之后 ⇒ run 必非 null。
 *   于是 run 非 null 只可能发生在 execute 之后，此时 !run.started 恰是「spawn 自己
 *   抛了（ENOENT/EPERM…），进程从未存在」⇒ 与 A 同归「结构上没花过钱」。
 *   run 为 null 时 spawnErrno 只能是空串：那是【没有过 spawn 尝试】，不是「有尝试但
 *   没记下 errno」；把它编成一个 errno 会把安全拒放进重试白名单。
 * round363（T6）起这四格的【实现】搬进 harness-runner.ts 的 runHarnessViaGateway：
 * codex/qoder 两家执行器要的是同一份映射，抄第二遍就是本仓最贵那一族失效
 * （两份抄本各改一格）。本文件只剩两件事 —— 拼 GatewayDeps（上面那段缺省口径）
 * 与把 claude-cli 那一家接进工厂。这份注释仍是判据的权威文本，实现侧只指回来。
 *
 * ── runner 自己不碰库 ─────────────────────────────────────────────────
 * audit / checkBudget / settle 全部是注入槽。tracker.consume 有 inStepTx 纪律
 * （必须处在超步事务里），runner 不知道也不该知道外层事务长什么样 ——
 * 所以 settle 原样透传给 GatewayDeps.settle，落哪个事务是 Step B 调用方的事。
 */

import type { HarnessId, HarnessRequest, SandboxTier } from "@opc/contracts";
import { harnessDefaultsFor } from "@opc/contracts";
import type { RoleRunResult } from "../engine/claude.js";
import type { AuditRow } from "../events/recorder.js";
import type { ClaudeCliAdapterOptions } from "./adapters/claude.js";
import { ClaudeCliAdapter } from "./adapters/claude.js";
import type { GatewayDeps } from "./gateway.js";
import { runHarnessViaGateway } from "./harness-runner.js";

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
  /**
   * 读岗位书默认授权时取哪一家的列（缺省 "claude-code"，runtime 主循环行为逐字保持）。
   * round363（T6）起不再写死：执行器层按 kind 传 codex/qoder。写死时章程里那两列
   * 【存着而没人读】，codex 执行器拿 claude-code 的禁旗列表判 codex 命令（两家参数名
   * 不同），字节级不匹配的白名单等于没有白名单。
   */
  readonly harnessId?: HarnessId;
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
  // 缺省口径集中在这一行：岗位书没写这一家的 sandbox ⇒ read-only（最严档）。
  // 「没接岗位书」在上面已经抛了，走到这里缺格只是「声明了默认最严」。
  // 取哪一家的列由 deps.harnessId 定（缺 claude-code = runtime 主循环既有行为）。
  const entry = harnessDefaultsFor(
    deps.charterHarnessDefaults,
    deps.harnessId ?? "claude-code",
  );
  return {
    audit: deps.audit,
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

/**
 * 经 Gateway 跑一次角色调用（claude-cli 那一家）。
 * 四格映射的【判据】在本文件头（权威文本），【实现】在 harness-runner.ts 的
 * runHarnessViaGateway —— T6 起 codex/qoder 执行器共用同一份实现，这里只保留
 * claude 的装配：先 buildGatewayDeps（缺省口径 + harnessId 取列都在那里），
 * 再把适配器放进工厂（每次新实例，竞态理由在工厂注释）。
 */
export async function runViaGateway(
  adapterOptions: ClaudeCliAdapterOptions,
  req: HarnessRequest,
  deps: GatewayRunnerDeps,
): Promise<RoleRunResult> {
  return runHarnessViaGateway(
    () => new ClaudeCliAdapter(adapterOptions),
    req,
    buildGatewayDeps(deps),
  );
}
