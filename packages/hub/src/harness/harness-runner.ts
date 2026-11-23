/**
 * harness 调用核（round363，T6）：runViaGateway 的【适配器无关】那一半。
 *
 * ── 为什么拆出这一份 ─────────────────────────────────────────────────
 * 原 runViaGateway 把「新造适配器实例」写死成 `new ClaudeCliAdapter`，而三态
 * 映射（gateway 拒 / 进程没起 / 起了但业务错 / 全绿）与具体是哪家 CLI【无关】——
 * 它消费的只有 takeRun() 的 RoleRunResult。codex/qoder 两家若把四格映射再抄
 * 一遍，就是本仓最贵那一族失效（两份抄本）：以后给映射加一格（比如超时归因），
 * claude 那条改了、codex 那条没改，三家 CLI 里出现两种「失败语义」。
 * 所以：判定收在本文件，runViaGateway 与 executors/cli.ts 都调它。
 *
 * ── 分层方向（round363 定）─────────────────────────────────
 * 本文件是【下层】：只依赖 gateway.ts 与契约，不认识任何一家适配器，也不做
 * GatewayDeps 装配 —— 授权档位怎么从岗位书读出来（buildGatewayDeps 的缺省口径、
 * harnessId 取哪一家的列）留在 gateway-runner.ts，由上层在调进来之前装配完。
 * 依赖因此单向：gateway-runner / executors/cli → 本文件 → gateway。
 * 若反过来让本文件 import buildGatewayDeps，就出现 gateway-runner ⇄ harness-runner
 * 的运行期环 —— 函数声明的环在 ESM 下今天能跑，但「下层 import 上层」这一刀会让
 * 以后任何人往两边顶层各放一个非常量初值就踩到 TDZ，不值当赌。
 *
 * 四格映射的判据全文在 gateway-runner.ts 文件头（那份注释是权威），
 * 本文件一个字都不复述 —— 复述就是第三份抄本。
 */
import type { HarnessAdapter, HarnessRequest } from "@opc/contracts";
import type { RoleRunResult } from "../engine/claude.js";
import type { GatewayDeps, GatewayOutcome } from "./gateway.js";
import { callHarness } from "./gateway.js";

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
 * 三家 CLI 适配器【结构上都有】的取回缝（契约刻意不含它 —— HarnessAdapter 是
 * 契约层形状，takeRun/seedResumeRequest 是 hub 侧为三态映射与 resume 缺口加的）。
 * 结构类型：三家各自的类都满足它，不需要谁去 extends 谁；新接一家 CLI 时缺这两格
 * 直接编译不过，而不是运行期 undefined 调用。
 */
export interface HarnessAdapterWithRun extends HarnessAdapter {
  seedResumeRequest(req: HarnessRequest): void;
  takeRun(): RoleRunResult | null;
}

/**
 * 适配器构造槽：每次调用【新造一个实例】。
 * 适配器把「这一次 execute 的完整结果」存在实例里（takeRun），共享实例会让
 * 两次并发调用互相踩对方的结果 —— 实例化在这里，竞态在结构上不存在。
 */
export type HarnessAdapterFactory = () => HarnessAdapterWithRun;

/**
 * 详细出口：四格映射的结果 + gateway 的原始裁决。
 * runHarnessViaGateway 只取 run 那一格（runtime 主循环的既有形状逐字不变）；
 * 执行器层两格都要 —— 它要往回执里带 harness_result（契约 executor.ts：审计要
 * 能分清哪一层说了什么），更要【结构性地】分清「gateway 拦在门外」与「spawn 死在
 * 门内」：这两格在 RoleRunResult 里同形（都 started:false、error 都是人话），
 * 让执行器靠 spawnErrno 是否为空去猜，就是把判定交给猜（engine/claude.ts
 * started 字段文件头的同款立场：判据要由走到哪条路径结构性地知道）。
 */
export interface HarnessRunDetailed {
  readonly run: RoleRunResult;
  readonly gateway: GatewayOutcome;
}

export async function runHarnessDetailed(
  makeAdapter: HarnessAdapterFactory,
  req: HarnessRequest,
  gwDeps: GatewayDeps,
): Promise<HarnessRunDetailed> {
  const adapter = makeAdapter();
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
        "runHarnessDetailed：gateway 成功却没有 takeRun()，适配器结果存储接缝坏了",
      );
    }
    if (!run.ok) {
      // 三态里的「起了但业务错」：CLI 报 is_error/非零退出。gateway 侧那行
      // harness_call 照常落账（调用真发生了、账单真报了），这里翻成失败轮。
      return {
        run: fail(
          run.text,
          run.sessionId,
          run.costUsd,
          run.error,
          run.started,
          run.spawnErrno,
        ),
        gateway: g,
      };
    }
    return {
      run: {
        ok: true,
        text: g.result.output,
        sessionId: g.result.sessionId,
        // 美分→美元的换算点在这里（判据见 gateway-runner.ts 文件头 ④ 的注释）：
        // 预算侧全程美分，RoleRunResult 的 costUsd 是历史口径；要保精度的读数
        // 请读 gateway 审计行的 spent_cents。
        costUsd: g.result.cost.spentCents / 100,
        error: null,
        started: true,
        spawnErrno: "",
      },
      gateway: g,
    };
  }

  // 拒绝支的两种「没花过钱」同形归并（构造性蕴含全文在 gateway-runner.ts 文件头）；
  // gateway 那一格原样带回，执行器层用它分 gateway_refused / cli_spawn_failed。
  if (run === null || !run.started) {
    return {
      run: fail(
        run?.text ?? "",
        run?.sessionId ?? null,
        run?.costUsd ?? 0,
        run === null
          ? "gateway 拒绝（" + g.code + "）：" + g.reason
          : (run.error ?? "gateway 拒绝（" + g.code + "）：" + g.reason),
        false,
        run?.spawnErrno ?? "",
      ),
      gateway: g,
    };
  }
  // 进程起过、run 成功，但 gateway 仍拒（今天可达的形状：无 session_started ⇒ no_session）。
  return {
    run: fail(
      run.text,
      run.sessionId,
      run.costUsd,
      "gateway 拒绝（" + g.code + "）：" + g.reason,
      true,
      "",
    ),
    gateway: g,
  };
}

/**
 * 用任意适配器经 Gateway 跑一次调用，出口恒为 RoleRunResult 形状（四格映射）。
 * 与 runViaGateway 旧签名的两处差别：适配器由工厂给而不是内部 new；
 * 授权侧收【已装配好的 GatewayDeps】而不是 runner 的注入槽形状（见文件头分层）。
 */
export async function runHarnessViaGateway(
  makeAdapter: HarnessAdapterFactory,
  req: HarnessRequest,
  gwDeps: GatewayDeps,
): Promise<RoleRunResult> {
  return (await runHarnessDetailed(makeAdapter, req, gwDeps)).run;
}
