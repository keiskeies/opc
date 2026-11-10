/**
 * 节点失败的重试策略（Task 6.1 的另一半，规格 §23.1 Phase 6）。
 *
 * ── 为什么和 patrol 住同一个目录 ────────────────────────────────────
 * Task 6.1 的标题是「错误处理与重试」，出口标准只有一句：
 * **绝不静默停滞**。两半各管一种停滞：
 *   · retry.ts   —— 跑【失败】了：还活着，但要决定要不要再跑一次
 *   · patrol.ts  —— 没失败也【不动】了：进程好好的，任务却停在那儿
 * 合成一个目录是因为它们要给出同一个答案：要么推进，要么把人叫来，
 * 不允许「返回一个没人看的 undefined」这种第三种结局。
 *
 * ── 本模块【不驱动图】，也不该驱动图 ────────────────────────────────
 * 「节点失败 → 重试」的执行点本来在 LangGraph 节点外面包一层，而那需要真图运行时
 * （@langchain/* 本机装不上，0009 §2）。所以这里交的是两件能离线整条测完的东西：
 *   ① 判定：这个错误【该不该】重试、退避多久、第几次之后放弃（纯函数，可穷尽测）
 *   ② 执行器：一个 sleep 与 now 都可注入的 withRetry，它自己就是「绝不静默」的机器
 * 接线那天，图侧只需要把节点函数塞进 withRetry —— 判定与记账不用重写。
 *
 * ── 最有价值的是【分类】，不是「重试三次」────────────────────────────
 * 「失败就重试三次」是错的默认值。本仓有三类失败重试只会造成损失：
 *   · 预算硬停 —— 再跑一次只是多烧钱，而 §7.4 要求的是【暂停 + 卡片】
 *   · 越权 / 策略拒绝 —— 重试第 N 次仍然越权，而且每次都留一条审计
 *   · 非法状态跃迁 —— 那是我们自己写的边表在报错，重试一万次边表也不会变
 * 把它们和无网络、LLM 超时混在一起重试，后果是「一次故障期间审计里出现 12 条同类
 * 失败事件」，而回放视图会把这段读成「agent 反复尝试」—— 一个从未发生的意图被写进
 * 了 append-only 的历史。
 */

/** 规格 §23.1 Phase 6：重试上限 3 次。这里指【重试次数】，总执行次数是 1 + 3。 */
export const MAX_RETRIES = 3;
/** 首次退避。取 1 秒是因为被重试的那三类（网络 / harness / LLM 超时）都是秒级抖动。 */
export const BASE_BACKOFF_MS = 1_000;
/**
 * 退避上限。指数增长在 3 次上限内本来到不了 60 秒，
 * 这一格是为「将来上限调大」准备的：没有上限的退避会在第 10 次时睡 512 秒，
 * 而那时它看起来仍然像「策略在正常工作」。
 */
export const MAX_BACKOFF_MS = 60_000;

/** 失败分类。每一种都对应一种【不同的下一步】，否则不值得分开建模。 */
export const FAILURE_KINDS = [
  /** 网络 / 连接类：可重试。 */
  "transient",
  /** LLM 超时或 429/5xx：可重试。 */
  "llm_timeout",
  /** harness 崩溃：可重试（子进程重启即可）。 */
  "harness_crash",
  /** 预算硬停：不可重试，走 §7.4 的暂停 + 卡片。 */
  "budget_exhausted",
  /** 越权 / 策略拒绝：不可重试，走 §8.3 的升级。 */
  "policy_denied",
  /** 我们自己的一致性检查在报错：不可重试，是 bug。 */
  "invariant_broken",
  /** 调用方【主动取消】（AbortError）：不可重试 —— 没人取消过一次还想再来三轮。 */
  "cancelled",
  /** 认不出来。 */
  "unknown",
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/** 可重试的三类。写成显式清单而不是「除不可重试外」：未知默认【不】重试。 */
export const RETRYABLE_KINDS: readonly FailureKind[] = Object.freeze([
  "transient",
  "llm_timeout",
  "harness_crash",
]);

/**
 * 为什么未知【不】默认可重试（与 policy/engine.ts 的 fail-closed 同一个立场）：
 * 未知错误重试三次 ⇒ 同一个错误在 append-only 的 events 里出现四份。
 * 而「一次故障」与「四次故障」在回放里的读法完全不同 —— 后者会被读成
 * 「agent 反复做了同一件事」，那是审计历史里最贵的一种谎。
 * 认不出来就叫人，叫人永远是安全的。
 */
export const NON_RETRYABLE_KINDS: readonly FailureKind[] = Object.freeze(
  FAILURE_KINDS.filter((k) => !(RETRYABLE_KINDS as readonly string[]).includes(k)),
);

/**
 * 从错误里认分类。
 *
 * 只认【结构化标记】，不做「消息里含 timeout 就算超时」这种字符串猜：
 * 后者会把「LLM 返回的正文里写着 timeout」读成一次 LLM 超时，
 * 而那种读法在错误消息是别人的产出时必然出错。
 * 所以这里读的是 err.name / err.code / err.kind / err.failureKind 这几个
 * 【由抛出方声明】的字段，一个都不猜。
 */
export function classifyFailure(e: unknown): FailureKind {
  const declared = declaredKind(e);
  if (declared !== undefined) return declared;
  // AbortError 是【我们主动取消】，不是外部故障。单列一种而不是塞进
  // invariant_broken：那种错误说的是「我们的边表/一致性检查在报错，是 bug」，
  // 而取消不是 bug —— 把两者混成一格，卡片会说「发现程序缺陷」而真相是「你按了停止」。
  if (isAbort(e)) return "cancelled";
  return "unknown";
}

const DECLARED_FIELDS = ["failureKind", "kind", "code", "name"] as const;

/** 声明值必须【逐字命中】枚举；命中不了算 unknown，不做近义匹配。 */
function declaredKind(e: unknown): FailureKind | undefined {
  if (e === null || typeof e !== "object") return undefined;
  const bag = e as Record<string, unknown>;
  for (const f of DECLARED_FIELDS) {
    const v = bag[f];
    if (typeof v !== "string") continue;
    const hit = FAILURE_KINDS.find((k) => k === v);
    if (hit !== undefined) return hit;
  }
  // 结构化子类型：BUDGET_PAUSED 这类状态名是调用方最自然的声明方式，
  // 而它不在上面七个词里 —— 与其让调用方再翻译一遍（翻译表就是第二份判据），
  // 不如在这里认一次，并且【只认这三个】。
  const marker = typeof bag["code"] === "string" ? bag["code"] : "";
  if (marker === "BUDGET_PAUSED" || marker === "BUDGET_EXHAUSTED") return "budget_exhausted";
  if (marker === "UNAUTHORIZED" || marker === "POLICY_DENIED") return "policy_denied";
  if (marker === "ILLEGAL_TRANSITION") return "invariant_broken";
  return undefined;
}

function isAbort(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { name?: unknown })["name"] === "AbortError"
  );
}

/**
 * 第 n 次重试前睡多久（n 从 1 起）。
 *
 * 抖动【必须注入】而不是在这里 Math.random：
 * 带随机数的退避序列不可断言，测试只能写成「delay >= base && delay <= base*2」这种
 * 区间断言 —— 那种断言对「退避根本没生效」和「退避生效但抖错了」都没有鉴别力。
 * 所以这里给确定序列，抖动由调用方通过 jitter 传进来（生产传随机，测试传恒等）。
 */
export function backoffMs(
  retryNo: number,
  o: { baseMs?: number; capMs?: number; jitter?: (ms: number) => number } = {},
): number {
  if (!Number.isInteger(retryNo) || retryNo < 1) {
    throw new Error(
      "retryNo 必须是 ≥1 的整数（第几次【重试】），收到 " + String(retryNo),
    );
  }
  const base = o.baseMs ?? BASE_BACKOFF_MS;
  const cap = o.capMs ?? MAX_BACKOFF_MS;
  const raw = Math.min(base * 2 ** (retryNo - 1), cap);
  const j = o.jitter ?? ((x: number) => x);
  const out = j(raw);
  /**
   * 抖动产出的退避【必须是正数且不超过 2×cap】。
   *
   * 为什么要有这一道：一个把 delay 抖成 0 的 jitter 会让重试变成紧密循环，
   * 而那是「故障期间把上游打爆」的经典形状 —— 从外部看，策略仍在「正常退避」，
   * 因为它每次都确实 await 了一下。
   *
   * 【契约】jitter 必须返回 > 0。这排除了 AWS 那种
   * full jitter `Math.random() * raw`：Math.random() 能返回 0（概率 2⁻⁵³，
   * 但非零），撞上一次就是一次生产抛错。要 full jitter 请写成
   * `1 + Math.random() * (raw - 1)` —— 值域几乎一样，而它恒正。
   * 这一句写在这里而不是等谁撞上来，因为 2⁻⁵³ 的 bug 永远复现不出来。
   */
  if (!Number.isFinite(out) || out <= 0 || out > cap * 2) {
    throw new Error(
      "jitter 产出的退避不合理（" +
        String(out) +
        "，cap=" +
        cap +
        "）。0 退避等于紧密循环。",
    );
  }
  return out;
}

export type RetryDecision =
  | { readonly action: "retry"; readonly retryNo: number; readonly delayMs: number }
  | { readonly action: "escalate"; readonly reason: string };

/**
 * 一次失败之后怎么办。纯函数。
 *
 * attemptsSoFar = 已经执行过的次数（首次执行算 1）。
 * 不可重试的三类【当场】升级，不消耗重试额度 —— 让它们「先失败三次再升级」
 * 会让 events 里多出三条无意义的事件，而升级卡片上的「已重试 3 次」会是假的。
 */
export function decideRetry(
  kind: FailureKind,
  attemptsSoFar: number,
  o: { baseMs?: number; capMs?: number; jitter?: (ms: number) => number } = {},
): RetryDecision {
  if (!Number.isInteger(attemptsSoFar) || attemptsSoFar < 1) {
    throw new Error("attemptsSoFar 必须是 ≥1 的整数，收到 " + String(attemptsSoFar));
  }
  if (!(RETRYABLE_KINDS as readonly string[]).includes(kind)) {
    return {
      action: "escalate",
      reason: kind + " 不可重试（见 FAILURE_KINDS 的分类理由）",
    };
  }
  const retriesUsed = attemptsSoFar - 1;
  if (retriesUsed >= MAX_RETRIES) {
    return {
      action: "escalate",
      reason: "可重试类失败已用尽 " + MAX_RETRIES + " 次额度",
    };
  }
  return {
    action: "retry",
    retryNo: retriesUsed + 1,
    delayMs: backoffMs(retriesUsed + 1, o),
  };
}

/** 升级时交出去的东西。调用方拿它去写卡片（escalation.ts 起草、同事务落库）。 */
export type GaveUp = {
  readonly kind: FailureKind;
  readonly attempts: number;
  readonly reason: string;
  readonly lastError: unknown;
};

export type RetryOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly attempts: number }
  | { readonly ok: false; readonly gaveUp: GaveUp };

export interface RetryRunOptions {
  readonly kind: FailureKind;
  /** 注入的睡眠。生产传 setTimeout 包装；测试记时长而不真等。 */
  readonly sleep: (ms: number) => Promise<void>;
  /** 每次重试前回调：这是「第 N 次尝试」唯一的可见出口。 */
  readonly onRetry?: (d: { retryNo: number; delayMs: number; error: unknown }) => void;
  readonly backoff?: { baseMs?: number; capMs?: number; jitter?: (ms: number) => number };
  /** 每【次】执行都回调一次（含首次）。用来写审计。 */
  readonly onAttempt?: (a: { attempt: number; error: unknown }) => void;
}

/**
 * 跑 fn，按策略重试。
 *
 * 【三条硬规矩，都由返回类型而不是文档保证】：
 *  1. 绝不抛给调用方。fn 抛了要么重试、要么返回 ok:false。
 *     理由：重试执行器把异常重新抛出去，等于把「三次失败」压成一条 rejection，
 *     而调用方最省事的写法是 .catch(() => log(e)) —— 那一支就是静默停滞本身。
 *  2. 放弃时【必须】带回 lastError 与 attempts。只有「失败了」三个字的话，
 *     卡片上没法写「第几次、因为什么」。
 *  3. fn 正常返回就立刻返回，不看它返回的内容好不好。
 *     「跑成功了但结果不合格」是门控（gates/evaluate.ts）的活，不是重试的活 ——
 *     在这里掺进去会让「不合格」也被重试三次，而那是最烧钱的一种混淆。
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  o: RetryRunOptions,
): Promise<RetryOutcome<T>> {
  let attempt = 0;
  // 循环上界写死成 1 + MAX_RETRIES，而不是 while(true) 靠 decideRetry 里那一支退出：
  // 上界在这里，「额度用尽」就不依赖被调函数的正确性（判据坏了也只会多跑，不会无限跑）。
  while (attempt < 1 + MAX_RETRIES) {
    attempt += 1;
    try {
      const value = await fn(attempt);
      return { ok: true, value, attempts: attempt };
    } catch (e) {
      o.onAttempt?.({ attempt, error: e });
      const d = decideRetry(o.kind, attempt, o.backoff);
      if (d.action === "escalate") {
        return {
          ok: false,
          gaveUp: { kind: o.kind, attempts: attempt, reason: d.reason, lastError: e },
        };
      }
      o.onRetry?.({ retryNo: d.retryNo, delayMs: d.delayMs, error: e });
      await o.sleep(d.delayMs);
    }
  }
  // 【按构造不可达】：上界是 1 + MAX_RETRIES，而 decideRetry 在第 1 + MAX_RETRIES 次
  // 失败时必然判 escalate，所以循环内一定先返回。留这一支只为满足返回类型，
  // 而它写的理由必须是真话 —— 不要写成「判据与上界不一致时会走到这里」，
  // 那是一句无法被测试触达、也无法被证伪的安慰话（0018 §6 那一节的同一个毛病：
  // 给一段走不到的代码编一个听起来合理的成因）。
  // 真走到了只能是 MAX_RETRIES 与循环上界被人改成不一致的值，所以这里
  // 把两个数都打进消息里 —— 那一刻读的人不需要再翻源码。
  return {
    ok: false,
    gaveUp: {
      kind: o.kind,
      attempts: attempt,
      reason:
        "不可达分支被走到：循环上界 1 + MAX_RETRIES = " +
        (1 + MAX_RETRIES) +
        " 先生效，而 decideRetry(" +
        o.kind +
        ", " +
        attempt +
        ") 没有判 escalate。检查这两个数是否被改得不一致。",
      lastError: undefined,
    },
  };
}
