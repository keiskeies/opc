/**
 * 三家 CLI 的执行器实现（design-2026-11-23-群角色上层.md D4/D6，实施计划 T6）。
 *
 * ── 一个类覆盖三家，而不是三个类 ──────────────────────────────────────
 * claude/codex/qoder 在【执行器层】的差别只有三格：适配器怎么造、gateway 取哪一列
 * 授权（harnessId）、身份提示往哪传（claude 走 --append-system-prompt 的装配槽，
 * qoder/codex 的 CLI 面没有 system prompt 槽 ⇒ 前缀进 instruction）。
 * 四格出口映射（gateway 拒 / 进程没起 / 起了但业务错 / 全绿）收在
 * harness/harness-runner.ts，三家共用那份是它存在的理由（文件头写足了）。
 * 所以这里若再拆三个类，各抄一遍出口判定，就是本仓最贵那一族失效（三份抄本）。
 *
 * ── spawn 边界 ────────────────────────────────────────────────────────
 * 本文件【不起进程】：claude 那一路的 spawn 收在 engine/claude.ts（适配器经它），
 * codex/qoder 走各自 SDK。role-spawn-boundary 守卫盯的就是这条线。
 * 同理本文件【不 import engine/runtime】：依赖方向是 executors → harness-runner
 * → gateway（harness-runner.ts 文件头那条分层纪律的下半段）。
 *
 * ── 审计 ──────────────────────────────────────────────────────────────
 * 每次尝试恰好一行 executor_run（types.ts 文件头的记账口径），外加 gateway
 * 缓冲的 harness_call / unauthorized_attempt 行 —— 全走 auditExecutorRunViaWriter
 * 同一事务，一次尝试的账要么都在要么都不在。
 * ⚠ runHarnessDetailed / buildGatewayDeps 抛出来的那一发，buf 可能是半截的
 * （gateway 拒前已写了 unauthorized_attempt 才炸的通路真实存在）—— 半截照样
 * flush：半本账比没账强。「调用发生过」是事实，「我们装配错了」也是事实，
 * 两个都要留痕；丢掉半截账等于让那次调用在审计里从未存在。
 */
import type {
  ExecutorRunOutcome,
  ExecutorRunRequest,
  HarnessId,
  HarnessRequest,
} from "@opc/contracts";
import { harnessRequestSchema } from "@opc/contracts";
import type { Writer } from "../db/write-queue.js";
import type { AuditRow } from "../events/recorder.js";
import { ClaudeCliAdapter } from "../harness/adapters/claude.js";
import { CodexCliAdapter } from "../harness/adapters/codex.js";
import { QoderCliAdapter } from "../harness/adapters/qoder.js";
import type { GatewayRunnerDeps } from "../harness/gateway-runner.js";
import { buildGatewayDeps } from "../harness/gateway-runner.js";
import type { HarnessAdapterFactory } from "../harness/harness-runner.js";
import { runHarnessDetailed } from "../harness/harness-runner.js";
import type { Executor } from "./types.js";
import {
  auditExecutorRunViaWriter,
  errRun,
  firstNonEmptyLine,
  okRun,
} from "./types.js";

/** 本执行器接的三家。CLI kind 的权威名单在 contracts 的 CLI_EXECUTOR_KINDS，这里只收窄。 */
export const CLI_EXECUTOR_KINDS_LOCAL = [
  "claude-cli",
  "codex-cli",
  "qoder-cli",
] as const;
export type CliExecutorKind = (typeof CLI_EXECUTOR_KINDS_LOCAL)[number];

/** kind → gateway 取哪一列授权 / harness_call 审计报谁家（harness 原生名）。 */
const CLI_HARNESS_ID: Record<CliExecutorKind, HarnessId> = {
  "claude-cli": "claude-code",
  "codex-cli": "codex",
  "qoder-cli": "qoder",
};

export interface CliExecutorOptions {
  readonly writer: Writer;
  /**
   * buildGatewayDeps 的注入槽形状；charterHarnessDefaults 与显式授权至少给一侧
   * （否则装配期抛是 buildGatewayDeps 的既有纪律，透传出去就是 executor_error）。
   */
  readonly gateway: GatewayRunnerDeps;
  /**
   * 测试桩/装配覆盖：按 kind 覆盖适配器工厂与 harnessId；缺省工厂 = 按 kind 新建真适配器。
   * harnessId 覆盖影响的是 gateway deps 的授权取列（桩报的 harness_id 与岗位书列名
   * 对不上时，装配方在这里改，而不是去改岗位书迁就桩）。
   */
  readonly adapters?: Partial<
    Record<
      CliExecutorKind,
      {
        factory?: HarnessAdapterFactory;
        harnessId?: HarnessId;
      }
    >
  >;
  /**
   * 时钟注入槽：调用方没在 gateway 里给 now 时接进 gateway deps（审计时间戳的
   * 唯一落点就在 gateway 行上 —— executor_run 那行走 appendAudit 的 nowMs 缺省，
   * types.ts 的签名没开这一格，不开第 11 个口子）。
   */
  readonly now?: () => number;
}

function isCliKind(kind: ExecutorRunRequest["kind"]): kind is CliExecutorKind {
  return (CLI_EXECUTOR_KINDS_LOCAL as readonly string[]).includes(kind);
}

/** config 是判别联合，model 只有 CLI/pure-model 之外的形状里不存在 —— 收窄取值。 */
function configModel(req: ExecutorRunRequest): string | undefined {
  return "model" in req.config ? req.config.model : undefined;
}

/**
 * 诚实的机械摘要见 types.ts 的 firstNonEmptyLine（四份执行器共用一份，
 * 不在这里再抄第二份）。
 */
export class CliExecutor implements Omit<Executor, "kind"> {
  readonly #o: CliExecutorOptions;

  constructor(o: CliExecutorOptions) {
    this.#o = o;
  }

  /**
   * 跑一次尝试。约定（types.ts 的 Executor 注释）：永远 resolve、自己落审计。
   * kind 从 req 判（一个实例服务三家；注册表按 kind 路由到这里就够了）。
   * 整体 try/catch：#attempt 里已兜住装配抛，这里兜的是【兜底本身之外】的
   * 意外抛（审计缓冲被 gateway 回调搅坏之类）—— 契约说 run 永不 reject，
   * 违约的代价（路由器合成 executor_error、这一发 attempts 有 events 无）
   * 比多写一层 catch 贵。
   */
  async run(req: ExecutorRunRequest): Promise<ExecutorRunOutcome> {
    // gateway 缓冲：与 engine/runtime.ts 的 runTurn 同款 —— audit 槽是同步签名，
    // 写库要 await，同步槽 + 异步写只有缓冲这一种接法。
    const buf: AuditRow[] = [];
    let outcome: ExecutorRunOutcome;
    try {
      outcome = await this.#attempt(req, buf);
    } catch (e) {
      outcome = errRun(req, {
        code: "executor_error",
        message:
          "CLI 执行器自身抛错：" + (e instanceof Error ? e.message : String(e)),
        retry_next_executor: true,
      });
    }
    await auditExecutorRunViaWriter(
      this.#o.writer,
      outcome,
      "executors.cli.run",
      buf,
    );
    return outcome;
  }

  async #attempt(
    req: ExecutorRunRequest,
    buf: AuditRow[],
  ): Promise<ExecutorRunOutcome> {
    // ── 入参守卫 ────────────────────────────────────────────────────────
    if (!isCliKind(req.kind)) {
      // 注册表把非 CLI 的 kind 派到这里是装配 bug（契约 superRefine 保证不了路由）。
      return errRun(req, {
        code: "executor_error",
        message:
          "CliExecutor 收到非 CLI 的 kind=" +
          req.kind +
          "：路由错误，注册表该把这一格派给对应执行器。",
        retry_next_executor: false,
      });
    }
    if (req.workspace === undefined) {
      // 契约 executorRunRequestSchema 的 superRefine 本该在提交时就拦下这一发
      // （CLI kind 缺 workspace ⇒ 422）。走到这里说明有人绕过了 parse 直接构造 ——
      // 判据不靠「调用方规矩」：宁可再拦一次，也不拿 cwd=undefined 起进程
      // （node 会落回 hub 进程目录 = 仓库根，等于默认给员工开整仓读权限）。
      return errRun(req, {
        code: "executor_error",
        message:
          "kind=" +
          req.kind +
          " 的执行请求缺 workspace：契约 superRefine 本该拦住（缺省时子进程落回 " +
          "hub 自己的目录，等于默认开整仓读权限），执行器拒绝兜底。",
        retry_next_executor: false,
      });
    }

    // qoder/codex 的 CLI 面没有 system prompt 槽（适配器文件头），身份只能前缀进
    // instruction；claude 有 --append-system-prompt（装配期选项，见工厂），
    // 前缀反而会让身份在 prompt 与 system 里出现两遍。
    const instruction =
      req.kind !== "claude-cli" && req.role_prompt !== ""
        ? req.role_prompt + "\n\n" + req.instruction
        : req.instruction;

    // 请求侧策略：今天执行器层没有「按岗位书放开写权限」的通道（CLI 适配器全跑
    // plan/read-only），所以请求恒最严档 —— 与 runtime.ts 无岗位书时显式给
    // read-only + 空基线同一口径。授权侧（被比侧）仍归 gateway deps。
    const hreq: HarnessRequest = harnessRequestSchema.parse({
      task_id: req.task_id,
      role_id: req.role_id,
      instruction,
      workspace: req.workspace,
      sandbox: "read-only",
      approval_policy: "never",
      allowed_tools: [],
      forbidden_flags: [],
      requested_args: [],
      max_budget_usd: req.max_budget_usd,
      ...(req.resume_session_id !== undefined
        ? { resume_session_id: req.resume_session_id }
        : {}),
    });

    const override = this.#o.adapters?.[req.kind];
    const harnessId = override?.harnessId ?? CLI_HARNESS_ID[req.kind];
    const factory: HarnessAdapterFactory =
      override?.factory ?? (() => this.#defaultAdapter(req));

    // gateway deps 的三处覆盖都有明确方向：
    //  · audit 恒被本方法换掉（缓冲的持有者是 attempt 的闭包，外部槽接不到）；
    //  · harnessId 覆盖语义 = 调用方给了就尊重（他要读岗位书另一列），没给补 kind 默认；
    //  · now 只在调用方没给时接 options.now（时钟的权威在调用方）。
    const gw: GatewayRunnerDeps = {
      ...this.#o.gateway,
      audit: (row: AuditRow): number => {
        // 占位 id：gateway 只把它当「写过了」的回执，真 id 在 flush 那一刻才有。
        buf.push(row);
        return buf.length;
      },
      ...(this.#o.gateway.harnessId !== undefined ? {} : { harnessId }),
      ...(this.#o.gateway.now === undefined && this.#o.now !== undefined
        ? { now: this.#o.now }
        : {}),
    };

    // 类型要写上：裸 let 在 biome 是 noImplicitAnyLet，在下面 catch 提前 return
    // 之后 tsc 也推不出【已赋值】（flow 分析够不到 await 分支的每一条路）。
    let d: Awaited<ReturnType<typeof runHarnessDetailed>>;
    try {
      // buildGatewayDeps 的装配期抛（既没岗位书格也没显式授权）也归这里 catch：
      // 那是「这一发没跑成」的一种，回执与审计照走，不炸给上层重试层。
      d = await runHarnessDetailed(factory, hreq, buildGatewayDeps(gw));
    } catch (e) {
      return errRun(req, {
        code: "executor_error",
        message:
          "CLI 执行器装配/调用抛错：" +
          (e instanceof Error ? e.message : String(e)),
        // 抛的是未分类异常（executor_error 的契约注释口径：原话带进审计，不吞）。
        // retry true：成员执行器表里下一格可能是 human —— 「这一家炸了」不构成
        // 「这个活儿谁都干不了」。
        retry_next_executor: true,
      });
    }

    const g = d.gateway;
    const run = d.run;

    // ── 出口判定：全走结构判据（spawnErrno × gateway.ok × run.ok × run.started）──
    // ⚠ 判序与判据：spawn 失败（ENOENT 等）时适配器一帧不发，gateway 因
    // no_session 而拒 —— 所以【不能】拿 g.ok=false 当「拦在门外」的判据，
    // 那会把 spawn 失败误归 gateway_refused（retry 恒 false，瞬时资源型 errno
    // 失去换执行器的机会）。真判据是 spawnErrno：harness-runner 保证
    // 「前置拒 ⇒ run 为 null ⇒ spawnErrno 恒空串」，非空串只可能是 spawn 尝试过。
    if (run.started === false && run.spawnErrno !== "") {
      // 进程没起（spawn 尝试存在且失败）。
      const errno = run.spawnErrno;
      return errRun(req, {
        code: "cli_spawn_failed",
        message: run.error ?? "子进程没起来（spawn 失败）",
        // ENOENT（二进制不存在）确定性 ⇒ 重试第 N 次与第 1 次一模一样；
        // EMFILE/EAGAIN 这类资源型是瞬时的 ⇒ 换下一个执行器可能就有了。
        retry_next_executor: errno !== "ENOENT",
        spawn_errno: errno,
      });
    }
    if (g.ok === false && run.started === false) {
      // gateway 拦在门外（能力缺口/预算闸/禁止项/档位/越界；含「适配器没跑成且
      // 没留下 errno」的同形归并 —— harness-runner 同款立场：无 spawn 尝试证据
      // 时不编 errno）。换执行器【无】意义：同一份请求换谁跑都撞同一道闸
      // —— 闸判的是请求与授权，不是「谁去跑」（契约 gateway_refused 注释口径）。
      return errRun(req, {
        code: "gateway_refused",
        message: "Gateway 调用前拦截（" + g.code + "）：" + g.reason,
        retry_next_executor: false,
      });
    }
    if (g.ok === true && run.ok === false && run.started === false) {
      // 防御格：gateway 收过 finished 却报「进程从未存在」——三家今天都构造不出
      // （finished 只能在执行流里发出，走到那儿 started 必真）。保留判定而非删除：
      // 哪天接了第四家无进程 SDK 适配器，这就是它的 spawn 失败格。
      return errRun(req, {
        code: "cli_spawn_failed",
        message: run.error ?? "子进程没起来（spawn 失败）",
        // 无 errno 证据时不猜瞬时：判不了就按确定性处理（不重试）。
        retry_next_executor: false,
      });
    }
    if (run.ok === false) {
      // 起了但业务错（CLI is_error / 非零退出 / 输出不是预期形状），
      // 以及「进程起过、run 成了但 gateway 仍拒」那格。
      return errRun(req, {
        code: "cli_failed",
        message: run.error ?? "CLI 退出异常（业务错或输出不合法）",
        // retry true：这一格说「跑了但坏了」，下一格（可能是真人/另一家）有救。
        retry_next_executor: true,
        // 起过进程就可能真花了钱；costUsd 为 0 时分不出【报了零】与【没记】
        // （engine/claude.ts started 字段文件头那段），缺省不是 0。
        ...(run.costUsd > 0
          ? { cost_cents: Math.round(run.costUsd * 100) }
          : {}),
      });
    }

    // 全绿。cost 读 gateway 的整数美分原值 —— RoleRunResult.costUsd 是
    // spentCents/100 的历史口径，回乘回去会在浮点尾数上再摔一跤
    // （gateway-runner 文件头 ④：要保精度的读数请读 gateway 那一侧）。
    return okRun(req, {
      text: run.text,
      summary: firstNonEmptyLine(run.text),
      ...(g.ok ? { cost_cents: g.result.cost.spentCents } : {}),
      ...(run.sessionId !== null ? { session_id: run.sessionId } : {}),
      // 原样带回（审计要能分清哪一层说了什么 —— 契约 harness.ts 文件头）。
      ...(g.ok ? { harness_result: g.result as Record<string, unknown> } : {}),
    });
  }

  /**
   * 缺省工厂：按 kind 新建真适配器。model/bin 有值才传（undefined 键用展开省略 ——
   * 适配器那边 `?? "claude"` 之类兜底读的是【键缺失】，显式 undefined 在部分
   * 装配路径里会被当成「装配方给了一个空值」，省略是唯一没有歧义的形状）。
   */
  #defaultAdapter(req: ExecutorRunRequest) {
    const model = configModel(req);
    if (req.kind === "codex-cli") {
      return new CodexCliAdapter({
        ...(model !== undefined ? { model } : {}),
        ...(req.bin !== undefined
          ? { codexOptions: { codexPathOverride: req.bin } }
          : {}),
      });
    }
    if (req.kind === "qoder-cli") {
      return new QoderCliAdapter({
        ...(model !== undefined ? { model } : {}),
        ...(req.bin !== undefined ? { bin: req.bin } : {}),
      });
    }
    // timeout 经适配器 options（只有 claude 那一路的 runRole 有超时原语；
    // codex/qoder 的 SDK 侧超时不在本轮，缺格而不是编一个 setTimeout 包装）。
    return new ClaudeCliAdapter({
      rolePrompt: req.role_prompt,
      ...(model !== undefined ? { model } : {}),
      ...(req.bin !== undefined ? { bin: req.bin } : {}),
      ...(req.timeout_ms !== undefined ? { timeoutMs: req.timeout_ms } : {}),
    });
  }
}
