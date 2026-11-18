/**
 * 一轮角色执行的【重试外壳】（Task 6.1 接线，round305）。
 *
 * ── 为什么单独一个文件，而不是塞进 runtime.ts ──────────────────────
 * runtime.ts 是【装配层】：它唯一的职责是把回调接到真库上，本身没有可判定的逻辑，
 * 所以它的测试只能靠真库 + 真子进程。这一格有判据（哪个失败该重试、退避多久、
 * 什么必须【不】重试），判据就必须能在【注入的假执行器】上逐条测 —— 与 dispatch.ts
 * 刻意不 import SQL 是同一条理由（判定逻辑与 IO 分层，判定才测得动）。
 *
 * ── 这一格今天到底放行了什么（先说结论，免得读成「重试接上了就稳了」）──
 * 放行条件只在 claude.ts 的 retryableWithoutCost 一处，它要【两条同时成立】：
 *   ① 子进程从未存在（started === false）⇒ 结构上不可能产生过任何账单；
 *   ② spawn 的 errno 在那张瞬时白名单上（EAGAIN / EMFILE / ENFILE / …）。
 * 本机可复现的 started:false 实测【全是】ENOENT（确定性 ⇒ 被 ② 挡掉）。
 * ⇒ 今天这条判据在真机上【一次重试都不会放行】，而这不是缺陷，是量出来的覆盖面。
 *   它换来的是另一件事：装配错 bin 之外的【资源型故障】（进程表满、FD 用完）
 *   今天会让 hub 直接崩在 spawn 上，接上之后变成「退避几次 + 几条 warn + 一条正常失败轮」。
 * 那一族在真机上会不会自愈【仍未验】（白名单里没有一个真样本），登记在
 * .workbuddy/AUDIT-LEDGER.txt round305 段。
 *
 * ── 为什么重试【不记进】harness_calls / budget_events ────────────────
 * 由 ① 保证：进程从未存在 ⇒ 没有钱、没有会话、没有「发生过一次外部调用」这个事实。
 * 给一次没发生过的调用写一行执行日志，等于在 §12.7 第 4 层里制造一条【不存在的调用】
 * —— 而那一层存在的意义正是「每一行都对得上一次真调用」。
 * 所以这一格对 dispatch 完全透明：它看到的仍旧是【一个 outcome】，
 * 一次记账、一条 state_change、一行 harness_calls，与接线前逐字同形。
 * ⚠ 这条透明性【只对 ① 成立】。将来若把重试扩到「起过进程而失败」那一族
 *   （超时、CLI 业务错），每一次尝试都可能真花了钱，那时必须【先】改成
 *   「每次尝试各自记一次账」再扩判据 —— 顺序不能反，理由在台账 round305 §⑤。
 *
 * ── 为什么 escalate 只发 warn 而不发卡片 ────────────────────────────
 * Task 6.1 的出口标准是「绝不静默停滞」。这一格的诚实读数只有一条 warn：
 * 升级到卡片要的是 escalation.ts，而那个文件【不存在】（GaveUp 没有任何通往
 * 卡片的路径；patrol.ts 只调 onWarning，那也是一条日志）。在这里假装发卡，
 * 是把「没人看见」换成「看见了一条假话」。
 * 「任务停着」这件事在审计里本来就有痕迹（dispatch 的失败轮写一条 RoleTurnReported），
 * 这一格补的是「为什么停」里的那一段：试过、每次都没起来、退避过。
 */
import { withRetry } from "../heartbeat/retry.js";
import type { RoleRunInput, RoleRunResult } from "./claude.js";
import { retryableWithoutCost } from "./claude.js";

export interface TurnRetryHooks {
  /** 重试之间的等待。生产给真 setTimeout；测试注入 recorder（理由见 runtime.ts）。 */
  readonly sleep: (ms: number) => Promise<void>;
  /** 每次【重试前】的告警出口。 */
  readonly onRetryWarn: (message: string) => void;
}

/**
 * 抛给 withRetry 的那一种「这一次没起来」。
 *
 * 为什么必须【抛】而不是返回：withRetry 的第 3 条硬规矩是「fn 正常返回就立刻返回，
 * 不看返回的内容好不好」（retry.ts 的规则 3）。把可重试失败包成正常返回
 * = 重试永不介入，那一整条判据就成了装饰。
 *
 * 为什么【带着 result 抛】：放弃时 withRetry 只把 lastError 交回来，而调用方要还给
 * dispatch 的是一个和今天【逐字同形】的失败 outcome。不带 result，就只能在这里现编
 * 一句 error 文案 —— 那是把 claude.ts 里「按分支说不同的话」那套判据抄第二份（两份必漂）。
 */
class TurnSpawnMissed extends Error {
  readonly errno: string;
  readonly result: RoleRunResult;
  constructor(result: RoleRunResult) {
    super("子进程未启动（errno=" + result.spawnErrno + "）");
    this.name = "TurnSpawnMissed";
    this.errno = result.spawnErrno;
    this.result = result;
  }
}

/** 一次尝试的两种结局。分开建模是因为它们【后果相反】，见 runTurnWithRetry 的分支。 */
type Attempt =
  | { readonly kind: "ran"; readonly result: RoleRunResult }
  /**
   * 执行器自己 reject 了（不是「起了进程而失败」，是【连结果都没有】）。
   *
   * 为什么这一支【不重试】、而且【原样抛回】：
   * 实测本机 `bin` 指着一个普通文件时，node 从 spawn() 【同步】抛 EFTYPE，
   * 被 Promise 构造器吞成 rejection（claude.ts 的 RoleRunResult.spawnErrno 记着这一型）。
   * 那是【装配错 bin】—— 一个确定性 bug，重试第 4 次与第 1 次一模一样。
   * 把它放进重试会得到：白等 1+2+4 秒 + 四条 warn + 一条看起来像「角色跑失败了」的
   * 正常失败轮，而今天的形状是【响亮崩溃】。把一个装配期 bug 降级成一条运行期噪声，
   * 症状从「hub 起不来」变成「任务一直失败」—— 那是更难查的方向。
   * 所以这一支保持 rejection 语义不变（本轮不改它，只登记）。
   */
  | { readonly kind: "rejected"; readonly error: unknown };

/**
 * 跑一轮，只在【结构上零花费】的失败上重试。
 *
 * ⚠ 这条接线的支点：传进 withRetry 的 kind 是 "harness_crash"（可重试类），
 * 它【不决定要不要重试】—— 走到抛出的每一条都已经被 retryableWithoutCost 判过了。
 * kind 在这里只喂 withRetry 自己的额度表与退避表。
 * 一旦有人把下面那句判据换成 `!r.ok`，每次失败都会被重试 4 次而 kind 不会拦
 * （它以为外面判过了）。turn-retry.test.ts 里那发「花了钱的失败 ⇒ 一次都不重试」
 * 是这条注释唯一的机器凭据，别当冗余用例删。
 *
 * 返回值永远是【最后一次尝试的那个 result】，含 4 次全失败。
 * 于是 dispatch 看不出「重试过」的任何形状差异 —— 见文件头那段透明性。
 */
export async function runTurnWithRetry(
  run: (i: RoleRunInput) => Promise<RoleRunResult>,
  i: RoleRunInput,
  h: TurnRetryHooks,
): Promise<RoleRunResult> {
  const outcome = await withRetry<Attempt>(
    async () => {
      let r: RoleRunResult;
      try {
        r = await run(i);
      } catch (e) {
        return { kind: "rejected", error: e };
      }
      if (retryableWithoutCost(r)) throw new TurnSpawnMissed(r);
      return { kind: "ran", result: r };
    },
    {
      kind: "harness_crash",
      sleep: h.sleep,
      onRetry: (d) => {
        // 只打【坐标】：第几次、errno、退避多久。
        // 不打 prompt、不打 stderr —— 这一条会进日志，而日志也是一处日志
        // （与 O11「错误字符串里不许出现请求体」同一条口径）。
        const errno = d.error instanceof TurnSpawnMissed ? d.error.errno : "";
        h.onRetryWarn(
          "角色轮重试 " +
            d.retryNo +
            "：子进程未启动（errno=" +
            errno +
            "），退避 " +
            d.delayMs +
            "ms",
        );
      },
    },
  );
  // fn 正常返回（含 rejected 那一支）时 withRetry 立刻返回 ok:true，不看内容。
  if (outcome.ok) {
    const attempt: Attempt = outcome.value;
    if (attempt.kind === "rejected") {
      // 保持今天的形状：响亮崩溃。这里【不】包成失败轮，理由见 Attempt 的 rejected 注释。
      throw attempt.error;
    }
    return attempt.result;
  }
  // 额度用尽（4 次全没起来）：把最后那一次的 result 原样交回去，让它走
  // dispatch 原有的失败轮路径。这里【不】抛 —— 抛会把「退避过 3 次的资源型故障」
  // 变成 hub 崩在 advance 上，而今天那条路至少会留下一条失败轮。
  const last: unknown = outcome.gaveUp.lastError;
  if (last instanceof TurnSpawnMissed) return last.result;
  // 唯一非 TurnSpawnMissed 的 ok:false 来自 withRetry 那条【按构造不可达】的分支
  // （循环上界与 decideRetry 被改得不一致时才会走到）。那时【抛】而不是编一个
  // 失败 outcome：那种场合真话是「重试器自己的两个数不一致」，
  // 而一条看起来正常的失败轮会把它伪装成「角色跑失败了」。
  throw new Error("重试外壳在非预期的格子里放弃：" + outcome.gaveUp.reason);
}
