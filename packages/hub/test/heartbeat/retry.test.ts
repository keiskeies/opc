/**
 * Task 6.1　重试策略（src/heartbeat/retry.ts）。
 *
 * ── 这一文件在证什么 ──────────────────────────────────────────────────
 * 计划的三个注入点（网络错误 / harness 崩溃 / LLM 超时）在这里等价于
 * 「三个可重试分类 + 一个执行器」，因为本模块不驱动图（@langchain 本机装不上，
 * 0009 §2）。所以能测的是【判定与记账】，测法是把三种故障当输入喂进去，
 * 断言三件出口：恢复、升级、以及【绝不变静默】。
 *
 * 三条最重要的断言：
 *   ① 不可重试那三类【第一次失败就】升级。少了这条，「失败就重试三次」的写法全绿，
 *      而它会在 append-only 的 events 里留下四份同类失败 ——
 *      回放把它读成「agent 反复尝试」，那是审计历史里最贵的谎。
 *   ② withRetry 不向调用方抛。这条守的就是 Task 6.1 的出口标准本身。
 *   ③ 退避序列确定且不为 0。抖动走注入，所以序列本身能被逐值断言
 *      —— 区间断言（>= base）对「退避根本没生效」没有鉴别力。
 *
 * sleep 全部注入成记时长，测试不真等；时钟也不参与判定（判定是纯函数）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BASE_BACKOFF_MS,
  FAILURE_KINDS,
  MAX_BACKOFF_MS,
  MAX_RETRIES,
  NON_RETRYABLE_KINDS,
  RETRYABLE_KINDS,
  backoffMs,
  classifyFailure,
  decideRetry,
  withRetry,
  type RetryOutcome,
} from "../../src/heartbeat/retry.js";

const HUB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 记时长而不真等的 sleep。 */
function recorder() {
  const slept: number[] = [];
  return {
    slept,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
  };
}

describe("① 分类：认结构化声明，不猜错误消息", () => {
  it("三类可重试故障各自被认出来", () => {
    expect(classifyFailure({ failureKind: "transient" })).toBe("transient");
    expect(classifyFailure({ kind: "llm_timeout" })).toBe("llm_timeout");
    expect(classifyFailure({ code: "harness_crash" })).toBe("harness_crash");
  });

  it("三个状态名 marker 被认成对应分类（调用方不必再翻译一遍）", () => {
    expect(classifyFailure({ code: "BUDGET_PAUSED" })).toBe("budget_exhausted");
    expect(classifyFailure({ code: "UNAUTHORIZED" })).toBe("policy_denied");
    expect(classifyFailure({ code: "ILLEGAL_TRANSITION" })).toBe("invariant_broken");
  });

  it("认不出来就是 unknown，不做近义匹配", () => {
    // 「消息里写着 timeout」必须【不】被判成 llm_timeout：错误消息可能是 LLM 的产出，
    // 那种猜法会在「模型输出了一个含 timeout 的字符串」时把一次成功读成一次超时。
    expect(classifyFailure(new Error("LLM timeout after 30s"))).toBe("unknown");
    expect(classifyFailure({ code: "TimeoutError" })).toBe("unknown");
    expect(classifyFailure(null)).toBe("unknown");
    expect(classifyFailure("transient")).toBe("unknown");
    // 反向对照：同一个对象换个字段名就命中，证明判据看的是字段而不是运气
    expect(classifyFailure({ failureKind: "transient" })).toBe("transient");
  });

  it("AbortError = 主动取消，不是 bug", () => {
    const abort = new Error("stopped");
    abort.name = "AbortError";
    expect(classifyFailure(abort)).toBe("cancelled");
    // 反向对照：不是所有 Error 都算取消
    expect(classifyFailure(new Error("boom"))).toBe("unknown");
  });

  it("可重试 + 不可重试 = 全部枚举，两边都不许手写漏项", () => {
    expect(RETRYABLE_KINDS.length + NON_RETRYABLE_KINDS.length).toBe(FAILURE_KINDS.length);
    for (const k of RETRYABLE_KINDS) {
      expect(NON_RETRYABLE_KINDS).not.toContain(k);
    }
    // 未知与不可重试同侧 —— 这条是「默认不重试」那个立场的机器表达
    expect(NON_RETRYABLE_KINDS).toContain("unknown");
  });
});

describe("② 退避与额度", () => {
  it("指数序列逐值对得上（1s, 2s, 4s）", () => {
    expect(backoffMs(1)).toBe(BASE_BACKOFF_MS);
    expect(backoffMs(2)).toBe(BASE_BACKOFF_MS * 2);
    expect(backoffMs(3)).toBe(BASE_BACKOFF_MS * 4);
  });

  it("撞上限：第 20 次也不是天文物理数字", () => {
    expect(backoffMs(20)).toBe(MAX_BACKOFF_MS);
  });

  it("退避【不为 0】：抖成 0 的 jitter 当场抛，而不是变成紧密循环", () => {
    expect(() => backoffMs(1, { jitter: () => 0 })).toThrow();
    expect(() => backoffMs(1, { jitter: () => Number.NaN })).toThrow();
    expect(() => backoffMs(1, { jitter: () => MAX_BACKOFF_MS * 3 })).toThrow();
    // 反向对照：合拍的抖动照常返回
    expect(backoffMs(1, { jitter: (x) => x * 1.5 })).toBe(BASE_BACKOFF_MS * 1.5);
  });

  it("retryNo 从 1 起，0 与负数当场拒（静默按 1 处理会把序列整体错位一格）", () => {
    expect(() => backoffMs(0)).toThrow();
    expect(() => backoffMs(-1)).toThrow();
    expect(() => backoffMs(1.5)).toThrow();
  });

  it("可重试类恰好让出 MAX_RETRIES 次额度，第 4 次失败后升级", () => {
    for (let n = 1; n <= MAX_RETRIES; n++) {
      const d = decideRetry("transient", n);
      expect(d.action).toBe("retry");
      if (d.action === "retry") expect(d.retryNo).toBe(n);
    }
    const gone = decideRetry("transient", MAX_RETRIES + 1);
    expect(gone.action).toBe("escalate");
  });

  it("不可重试三类【第一次】就升级，不消耗额度", () => {
    for (const k of ["budget_exhausted", "policy_denied", "invariant_broken", "cancelled", "unknown"] as const) {
      const d = decideRetry(k, 1);
      expect(d.action).toBe("escalate");
      // reason 里必须带分类：卡片上「为什么没重试」不能只写「失败」
      if (d.action === "escalate") expect(d.reason).toContain(k);
    }
  });

  it("attemptsSoFar 非法值抛而不是被当成首次", () => {
    expect(() => decideRetry("transient", 0)).toThrow();
    expect(() => decideRetry("transient", 1.5)).toThrow();
  });
});

describe("③ withRetry：三种出口，没有第四种", () => {
  it("首次成功 ⇒ 一次都不睡，attempts = 1", async () => {
    const s = recorder();
    let runs = 0;
    const r = await withRetry(
      () => {
        runs += 1;
        return Promise.resolve("ok");
      },
      { kind: "transient", sleep: s.sleep },
    );
    expect(r).toEqual({ ok: true, value: "ok", attempts: 1 });
    expect(runs).toBe(1);
    expect(s.slept).toEqual([]);
  });

  it("第二次成功 ⇒ 睡了一格退避，attempts = 2", async () => {
    const s = recorder();
    let n = 0;
    const r = await withRetry(
      () => {
        n += 1;
        return n < 2 ? Promise.reject(new Error("网络断了")) : Promise.resolve("回来了");
      },
      { kind: "transient", sleep: s.sleep },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.attempts).toBe(2);
    expect(s.slept).toEqual([BASE_BACKOFF_MS]);
  });

  it("额度用尽 ⇒ ok:false，且【不向调用方抛】（这条就是『绝不静默停滞』的执行侧）", async () => {
    const s = recorder();
    const attempts: number[] = [];
    const r: RetryOutcome<never> = await withRetry(
      () => Promise.reject(new Error("一直坏")),
      {
        kind: "llm_timeout",
        sleep: s.sleep,
        onAttempt: (a) => {
          attempts.push(a.attempt);
        },
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.gaveUp.attempts).toBe(1 + MAX_RETRIES);
      expect(r.gaveUp.kind).toBe("llm_timeout");
      expect((r.gaveUp.lastError as Error).message).toBe("一直坏");
      expect(r.gaveUp.reason).toContain(String(MAX_RETRIES));
    }
    // 三次重试 ⇒ 三段退避，逐值可断言（区间断言看不住「退避没生效」）
    expect(s.slept).toEqual([BASE_BACKOFF_MS, BASE_BACKOFF_MS * 2, BASE_BACKOFF_MS * 4]);
    expect(attempts).toEqual([1, 2, 3, 4]);
  });

  it("不可重试分类 ⇒ 只跑一次，一次都不睡", async () => {
    for (const kind of ["budget_exhausted", "policy_denied"] as const) {
      const s = recorder();
      let runs = 0;
      const r = await withRetry(
        () => {
          runs += 1;
          return Promise.reject(new Error("越权"));
        },
        { kind, sleep: s.sleep },
      );
      expect(r.ok).toBe(false);
      expect(runs).toBe(1);
      // 这一格是整份文件最值钱的一发：预算硬停之后还重试三次 = 多烧三倍钱，
      // 而 §7.4 要的是【暂停 + 卡片】。runs 若是 4，说明「重试三次」成了默认值。
      expect(s.slept).toEqual([]);
    }
  });

  it("每一次失败都被 onAttempt 看见（审计写手的挂点，缺它就是静默）", async () => {
    const s = recorder();
    const seen: Array<{ attempt: number; message: string }> = [];
    await withRetry(
      (attempt) => Promise.reject(new Error("第" + attempt + "次")),
      {
        kind: "transient",
        sleep: s.sleep,
        onAttempt: (a) => {
          seen.push({ attempt: a.attempt, message: (a.error as Error).message });
        },
      },
    );
    expect(seen).toEqual([
      { attempt: 1, message: "第1次" },
      { attempt: 2, message: "第2次" },
      { attempt: 3, message: "第3次" },
      { attempt: 4, message: "第4次" },
    ]);
  });

  it("onRetry 收到的是【将要睡多久】，不是已经睡了多久", async () => {
    const s = recorder();
    const notices: number[] = [];
    await withRetry(() => Promise.reject(new Error("坏")), {
      kind: "transient",
      sleep: s.sleep,
      onRetry: (d) => {
        notices.push(d.delayMs);
      },
    });
    expect(notices).toEqual(s.slept);
    expect(notices.length).toBe(MAX_RETRIES);
  });

  it("fn 正常返回就不看内容（结果合不合格是门控的活）", async () => {
    const s = recorder();
    const r = await withRetry(() => Promise.resolve({ pass: false, coverage: 12 }), {
      kind: "transient",
      sleep: s.sleep,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ pass: false, coverage: 12 });
    expect(s.slept).toEqual([]);
  });

  it("fn 同步抛（不是 reject）也被接住", async () => {
    const s = recorder();
    const r = await withRetry(
      () => {
        throw new Error("同步炸");
      },
      { kind: "harness_crash", sleep: s.sleep },
    );
    expect(r.ok).toBe(false);
  });

  it("sleep 自己抛 ⇒ 冒泡给调用方（重试机器坏了不该被读成『任务失败』）", async () => {
    await expect(
      withRetry(() => Promise.reject(new Error("坏")), {
        kind: "transient",
        sleep: () => Promise.reject(new Error("定时器坏了")),
      }),
    ).rejects.toThrow("定时器坏了");
  });
});

describe("④ 分层：判定不该拖进图运行时", () => {
  it("retry.ts 零 import：分类与执行器谁都不拖", () => {
    const src = codeOnly(readSrc());
    expect(src.includes('from "../graph/')).toBe(false);
    expect(src.includes('from "../db/')).toBe(false);
    expect(src.includes('from "../checkpoint/')).toBe(false);
    expect(src.includes("@langchain")).toBe(false);
    expect(src.includes("node:sqlite")).toBe(false);
    // 本模块刻意【零 import】，所以这里反向对照数的是 export 条数而不是 import 条数
    // （数 import 会恒真：0 === 0）。零 import 是它能被图侧、CLI、测试三方共用的前提。
    expect((src.match(/^export /gmu) ?? []).length).toBeGreaterThanOrEqual(10);
    const imported = [...src.matchAll(/from\s+"([^"]+)"/gmu)].map((m) => m[1] ?? "");
    expect(imported).toEqual([]);
    // 而【注释里】确实出现过这些词 —— 钉住「必须先剥注释」这一步不是装饰（0018 §6 第 4 条）
    expect(readSrc().includes("@langchain")).toBe(true);
  });
});

function readSrc(): string {
  return readFileSync(join(HUB, "src", "heartbeat", "retry.ts"), "utf8");
}

function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "");
}
