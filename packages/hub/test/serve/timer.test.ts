/**
 * 心跳调度器（serve/timer.ts）。
 *
 * ── 这一组测的不是「定时器会不会响」，是【四种坏法会不会静默】──────────
 * 一个常驻进程的心跳坏了，用户看到的仍然是「Hub 在跑」—— 端口在、界面绿、
 * 任务点得动，只有停滞检测【悄悄不做了】。那是本仓反复定义为最贵的一类失效
 * （200 + 什么都不动）。所以四条判据各自钉一种静默：
 *   ① 上一轮没跑完 ⇒ 跳过并【计数】（不计数就是静默漏巡检）
 *   ② 一次抛错 ⇒ 循环继续（抛错杀循环 = 一次抖动换来永久失效）
 *   ③ 连续失败到阈值 ⇒ 停 + 上报（一直坏着别再刷，但要【说出来】）
 *   ④ stop 之后不再叫（包括已排在队里的那一发）
 *
 * ── 假时钟是这一组能存在的原因 ──────────────────────────────────────
 * 用真 setTimeout，「连续三轮失败」要真等三轮，「巡检卡住时不重叠」要么测不了、
 * 要么靠 sleep 变成一条 flaky（会被一句重试糊过去）。所以时间源与定时器【必须一起】
 * 注入：只假定时器而时钟还是 Date.now，那「advance 了 45 分钟」与「patrol 看到的
 * now()」会对不上，测试会绿在错的地方。
 */
import { describe, expect, it } from "vitest";
import {
  createFakeScheduler,
  createInFlightWatch,
  createTicker,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  type Ticker,
} from "../../src/serve/timer.js";

/** 一个可手动了结的 job：让「上一轮还没跑完」这一格变得可构造。 */
function gate(): {
  job(): Promise<void>;
  release(): void;
  started(): number;
  done(): number;
} {
  let started = 0;
  let done = 0;
  let resolveNext: (() => void) | null = null;
  return {
    async job() {
      started++;
      await new Promise<void>((r) => {
        resolveNext = r;
      });
      done++;
    },
    release() {
      resolveNext?.();
      resolveNext = null;
    },
    started: () => started,
    done: () => done,
  };
}

/**
 * 排空微任务队列。
 *
 * 为什么需要它而不是「advance 完直接断言」：ticker 的 job 调用被【刻意】推迟了一个
 * 微任务（见 timer.ts runOnce 那段——不推迟会有一个「同步抛错把心跳永久锁死」的缺陷）。
 * 于是 advance 只保证【叫到了】，回调里的状态变更要等微任务落地。
 *
 * 写法上用一次真的 setTimeout(0)：宏任务边界会排空【整条】微任务队列，
 * 而 `await Promise.resolve()` N 次要靠 N 猜得够大 ——
 * 那种「猜一个够大的轮数」的常量正是本仓反对的形状（它会在链变长的那天静默失效）。
 */
const drain = async (): Promise<void> => {
  await new Promise((r) => {
    setTimeout(r, 0);
  });
};

/** 推进假时钟并等这一轮真正跑完。测试里几乎每次 advance 都该用它。 */
const advanceAndDrain = async (s: { advance(ms: number): void }, ms: number): Promise<void> => {
  s.advance(ms);
  await drain();
};

describe("假时钟本身要先可信", () => {
  it("advance 之前不叫；advance 到位才叫", () => {
    const s = createFakeScheduler(0);
    let calls = 0;
    s.after(1000, () => calls++);
    s.advance(999);
    expect(calls).toBe(0);
    s.advance(1);
    expect(calls).toBe(1);
  });

  it("⭐ 时钟与定时器同源：advance 之后 now() 也跟着走", () => {
    // 这一发是整组的前置条件。分开假（定时器假、Date.now 真）时，
    // 心跳里的 patrol 会看到真实时刻，而我以为推进了 45 分钟 ——
    // 那种夹具会让「按 now() 判停滞」的用例绿在错的地方。
    const s = createFakeScheduler(1000);
    expect(s.now()).toBe(1000);
    s.advance(45 * 60_000);
    expect(s.now()).toBe(1000 + 45 * 60_000);
  });

  it("clear 之后的回调不叫", () => {
    const s = createFakeScheduler(0);
    let calls = 0;
    const h = s.after(1000, () => calls++);
    h.clear();
    s.advance(10_000);
    expect(calls).toBe(0);
    expect(s.pending()).toBe(0);
  });

  it("同一毫秒排下的两个回调按登记顺序跑", () => {
    // 顺序不确定的话，测试会变成「本地绿、别人红」。
    const s = createFakeScheduler(0);
    const order: string[] = [];
    s.after(500, () => order.push("first"));
    s.after(500, () => order.push("second"));
    s.advance(500);
    expect(order).toEqual(["first", "second"]);
  });

  it("负数 advance / 负数 after 都拒（时间不倒流）", () => {
    const s = createFakeScheduler(0);
    expect(() => s.advance(-1)).toThrow();
    expect(() => s.after(-1, () => {})).toThrow();
  });

  it("回调里再排的下一个回调，在同一次 advance 覆盖范围内时也被叫到", () => {
    // 链式定时器靠的就是这一格：每轮跑完安排下一轮，而 advance(3*interval)
    // 要一次叫满三轮，测试才不需要「advance 三次 + await」。
    const s = createFakeScheduler(0);
    let calls = 0;
    const chain = (): void => {
      calls++;
      if (calls < 3) s.after(1000, chain);
    };
    s.after(1000, chain);
    s.advance(3000);
    expect(calls).toBe(3);
  });
});

describe("① 串行不重叠", () => {
  it("⭐ 上一轮没落地时到点【不叫第二轮】，且跳过被计数", async () => {
    const s = createFakeScheduler(0);
    const g = gate();
    const t = createTicker({ intervalMs: 1000, job: g.job, scheduler: s });
    void t.tick();
    await drain();
    expect(g.started()).toBe(1);
    s.advance(10_000); // 期间到点 10 次，全该被跳过
    await drain();
    expect(g.started()).toBe(1);
    expect(t.skipped).toBeGreaterThanOrEqual(1);
    g.release();
    await drain();
  });

  it("⭐ 跳过必须【说出来】：一次都没上报的跳过就是静默漏巡检", async () => {
    const s = createFakeScheduler(0);
    const g = gate();
    const errs: string[] = [];
    const t = createTicker({
      intervalMs: 1000,
      job: g.job,
      scheduler: s,
      onError: (m) => errs.push(m),
    });
    void t.tick();
    await drain();
    s.advance(5000);
    expect(errs.join(" ")).toContain("跳过");
    g.release();
    await drain();
  });

  it("跑完一轮之后【只安排一个】下一轮（重复安排 = 一轮里叫两次）", async () => {
    const s = createFakeScheduler(0);
    const t = createTicker({ intervalMs: 1000, job: () => {}, scheduler: s });
    await t.tick();
    // createTicker 一建好就排了一个（那是「启动后每 interval 一轮」的那一发），
    // tick() 跑完又排一个 —— scheduleNext 的 timer !== null 短路让它们【合成一个】。
    expect(s.pending()).toBe(1);
    await advanceAndDrain(s, 1000);
    expect(s.pending()).toBe(1);
    t.stop();
  });

  it("用真定时器时也不重叠：链式而不是 setInterval（这是【设计选择】，钉住它）", async () => {
    // 判据：job 是慢的 async 时，一次 advance 覆盖多个周期只跑一轮。
    // 换成 setInterval + async 回调，这里会 started() 多次，
    // 于是同一个停滞任务可能被两轮并发写进 append-only 的 events（去重那一读还看不到未提交的那行）。
    const s = createFakeScheduler(0);
    const g = gate();
    const t = createTicker({ intervalMs: 1000, job: g.job, scheduler: s });
    void t.tick();
    await drain();
    s.advance(60_000);
    await drain();
    expect(g.started()).toBe(1);
    g.release();
    t.stop();
  });
});

describe("② 一次抛错不杀循环", () => {
  it("第一轮抛 ⇒ 第二轮照跑，且错误被上报", async () => {
    const s = createFakeScheduler(0);
    let n = 0;
    const errs: string[] = [];
    const t = createTicker({
      intervalMs: 1000,
      job: () => {
        n++;
        if (n === 1) throw new Error("一次抖动");
      },
      scheduler: s,
      onError: (m) => errs.push(m),
      maxConsecutiveFailures: 5,
    });
    await t.tick();
    expect(n).toBe(1);
    await advanceAndDrain(s, 1000);
    expect(n).toBe(2);
    expect(errs.join(" ")).toContain("一次抖动");
    expect(t.stopped).toBe(false);
    t.stop();
  });

  it("⭐ 同步抛错的 job 【不会】把心跳永久锁死（这一发钉的是我自己写错的那一版）", async () => {
    // 第一版把 job 写在 async IIFE 里，同步抛错时 finally 先跑、`inFlight = p` 后跑，
    // 于是 inFlight 被一个【已落地】的 promise 永久占住 ⇒ 之后每一轮都「跳过」。
    // 那种心跳不会崩，只会【一直跳过】，而日志里全是合理的「上一轮还没结束」。
    // 一个同步 throw 的 job 在测试里最常见，在生产里也真实存在
    //（runPatrol 里 SQL prepare 阶段就是同步的），所以这不是理论形状。
    const s = createFakeScheduler(0);
    let n = 0;
    const t = createTicker({
      intervalMs: 1000,
      job: () => {
        n++;
        if (n === 1) throw new Error("同步就抛");
      },
      scheduler: s,
      maxConsecutiveFailures: 99,
    });
    await t.tick();
    expect(t.running).toBe(false); // 跑完了就必须是「不在跑」
    await advanceAndDrain(s, 1000);
    expect(n).toBe(2);
    expect(t.skipped).toBe(0); // 这一发是那一版真正会红的地方
    t.stop();
  });

  it("成功一次就把连续失败计数【清零】（否则偶发失败会攒成一次停机）", async () => {
    const s = createFakeScheduler(0);
    let n = 0;
    const t = createTicker({
      intervalMs: 1000,
      job: () => {
        n++;
        if (n % 2 === 1) throw new Error("奇数轮坏");
      },
      scheduler: s,
      maxConsecutiveFailures: 2,
    });
    for (let i = 0; i < 6; i++) {
      await t.tick();
      await advanceAndDrain(s, 1000);
    }
    expect(t.consecutiveFailures).toBeLessThan(2);
    expect(t.stopped).toBe(false);
    t.stop();
  });

  it("抛的是非 Error（字符串/null）也被抄成文本，不冒泡成 unhandledRejection", async () => {
    // unhandledRejection 会【终止整个进程】—— 一次「job 里 throw 了一个字符串」
    // 不该带走整个 Hub。server.ts 的文件头为同一件事写过同一条理由。
    const s = createFakeScheduler(0);
    let n = 0;
    const last: string[] = [];
    const t = createTicker({
      intervalMs: 1000,
      job: () => {
        n++;
        if (n === 1) throw "只是个字符串";
      },
      scheduler: s,
      onError: (m) => last.push(m),
      maxConsecutiveFailures: 9,
    });
    const r = await t.tick();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("只是个字符串");
    t.stop();
  });
});

describe("③ 连续失败到阈值：停 + 上报", () => {
  it("到阈值 ⇒ stopped=true，且 onFatal 叫了一次", async () => {
    const s = createFakeScheduler(0);
    let fatal = 0;
    let n = 0;
    const t = createTicker({
      intervalMs: 1000,
      job: () => {
        n++;
        throw new Error("一直坏");
      },
      scheduler: s,
      maxConsecutiveFailures: 3,
      onFatal: () => fatal++,
    });
    await t.tick();
    expect(fatal).toBe(0);
    await advanceAndDrain(s, 1000);
    expect(fatal).toBe(0);
    await advanceAndDrain(s, 1000);
    expect(fatal).toBe(1);
    expect(t.stopped).toBe(true);
    // 停了之后到点不再叫（这一发让 fatal=1 不是巧合）
    await advanceAndDrain(s, 60_000);
    expect(fatal).toBe(1);
    expect(n).toBe(3);
  });

  it("默认阈值是 3，而【3 不是调优结果】", async () => {
    // 判据本身在 timer.ts 的注释里：15 分钟一轮 ⇒ 三次 = 45 分钟，
    // 长到不是一次抖动、短到不至于让停滞检测静默一整天。
    // 这里只钉常量值与「不传就是它」，不去证那个权衡（它属于产品口径）。
    expect(DEFAULT_MAX_CONSECUTIVE_FAILURES).toBe(3);
    const s = createFakeScheduler(0);
    let fatal = 0;
    const t = createTicker({
      intervalMs: 1000,
      job: () => {
        throw new Error("x");
      },
      scheduler: s,
      onFatal: () => fatal++,
    });
    await t.tick();
    expect(fatal).toBe(0); // 一次不算
    await advanceAndDrain(s, 1000);
    expect(fatal).toBe(0); // 两次还不该停
    await advanceAndDrain(s, 1000);
    expect(fatal).toBe(1);
  });

  it("maxConsecutiveFailures = 0 被拒（0 的意思是『一次都不许失败』，那不是这台机器上的东西）", () => {
    expect(() =>
      createTicker({ intervalMs: 1000, job: () => {}, scheduler: createFakeScheduler(0), maxConsecutiveFailures: 0 }),
    ).toThrow(/1/);
  });

  it("lastError 停在最后一条，而不是第一条", async () => {
    const s = createFakeScheduler(0);
    let n = 0;
    const t = createTicker({
      intervalMs: 1000,
      job: () => {
        n++;
        throw new Error("第 " + n + " 次");
      },
      scheduler: s,
      maxConsecutiveFailures: 9,
    });
    await t.tick();
    await advanceAndDrain(s, 1000);
    expect(t.lastError).toBe("第 2 次");
    t.stop();
  });
});

describe("④ stop 与参数校验", () => {
  it("stop 之后已排队的下一发也不叫", () => {
    const s = createFakeScheduler(0);
    let n = 0;
    const t = createTicker({ intervalMs: 1000, job: () => void n++, scheduler: s });
    s.advance(0);
    t.stop();
    s.advance(60_000);
    expect(n).toBe(0);
    expect(s.pending()).toBe(0);
  });

  it("stop 幂等：调两次不抛，也不把已停的状态改回去", () => {
    const s = createFakeScheduler(0);
    const t = createTicker({ intervalMs: 1000, job: () => {}, scheduler: s });
    t.stop();
    expect(() => t.stop()).not.toThrow();
    expect(t.stopped).toBe(true);
  });

  it("stop 之后 tick() 什么都不做（不能靠手动绕回运行态）", async () => {
    const s = createFakeScheduler(0);
    let n = 0;
    const t: Ticker = createTicker({ intervalMs: 1000, job: () => void n++, scheduler: s });
    t.stop();
    await t.tick();
    expect(n).toBe(0);
  });

  it("间隔非正数 ⇒ 当场拒，不等第一次到点", () => {
    for (const bad of [0, -1, Number.NaN]) {
      expect(() =>
        createTicker({ intervalMs: bad, job: () => {}, scheduler: createFakeScheduler(0) }),
      ).toThrow();
    }
  });
});

/**
 * ⑤ 「一件事在飞」这个状态本身（0036 §3）。
 *
 * ── 这一组为什么必须存在，而不是只在 assemble.test.ts 里测行为 ──────
 * 0025 §3 第 ③ 条那次失效（`backupInFlight` 被局部同名声明遮蔽 ⇒ 一次【测试全绿】的
 * 「等备份落地」）的根因是【状态放在一个可被遮蔽的变量里】。本篇把它挪进闭包 +
 * 一个有名字的谓词，而**「挪进闭包」这件事本身需要一条用例才成立**：
 * 否则下一次重构把它挪回一个模块级 let，没有任何一条 assemble 的用例会红
 * （它们看得到行为，看不到状态住哪儿）。
 *
 * ── 四条判据各自挡一种坏法 ────────────────────────────────────────
 *   ① 同刻派第二件 ⇒ 拒，且【原因是 in_flight】（不是布尔 false）
 *   ② beginCancel 之后 ⇒ 拒，且【原因是 cancelling】—— 与 ① 分得开，
 *      这一条是 P-B 那一发变异的落点（原因混成一个 false 就分不出是哪道门挡的）
 *   ③ settle 等到落地，且【不 reject】（清理路径不该被任务的失败打断）
 *   ④ 同步抛的任务【不会】把一个已落地的 promise 永久留在 inFlight 上
 *      —— 这是 createTicker 那个真缺陷的同族（上面 runOnce 那段注释记的同一个坑），
 *      在这里是「从此再也派不出第二件，而日志看起来像上一份还没完」
 */
describe("⑤ 在飞状态：inFlight / cancelling 两个字段各自是一条性质", () => {
  it("派一件 → 同刻第二件被拒，且原因是 in_flight", async () => {
    const w = createInFlightWatch<void>();
    let releaseFirst: (() => void) | null = null;
    const first = w.start(
      () =>
        new Promise<void>((r) => {
          releaseFirst = r;
        }),
    );
    expect(first).toEqual({ started: true });
    expect(w.inFlight).toBe(true);
    // 第二件必须【没跑】。断 started 计数而不是断「第二件的副作用」，
    // 因为后者要等一个不存在的调度时机。
    let secondCalled = 0;
    expect(w.start(async () => void secondCalled++)).toEqual({
      started: false,
      reason: "in_flight",
    });
    await drain();
    expect(secondCalled).toBe(0);
    releaseFirst?.();
    await w.settle();
    expect(w.inFlight).toBe(false);
  });

  it("beginCancel 之后派不出去，且原因【与 in_flight 分得开】", () => {
    const w = createInFlightWatch<void>();
    expect(w.beginCancel()).toBe(true);
    // 这一发是 P-B 的落点。reason 必须是 cancelling 而不是 in_flight：
    // 关机时【也】可能有东西在飞，那时报 in_flight 会让人以为「关机被一份备份卡住了」，
    // 而真正的语义是「别再派新活」。两个原因合成一个 false，这条就退化成
    // 「有一道门在挡」而看不出是哪一道 —— 那正是 0036 §5 说的「写成装饰」。
    expect(w.start(async () => {})).toEqual({ started: false, reason: "cancelling" });
    expect(w.cancelling).toBe(true);
    // beginCancel 幂等：第二次要说「早就是了」，不然调用方以为自己触发了关机。
    expect(w.beginCancel()).toBe(false);
  });

  it("先 cancel 再派：原因仍是 cancelling（两道门的【顺序】是判据）", () => {
    // 这一发看起来与上面重复，其实不是：它测的是【两个条件同时成立时先报哪个】。
    // 把实现里那两行 if 换个顺序，上面那发【不红】（那时还没有在飞的任务），
    // 只有这里「先派一件、再 cancel」的情形能分辨 —— 那时 inFlight 与 cancelling
    // 同时为真，而正确答案是 cancelling（别派新活）而不是 in_flight（有个活的在跑）。
    const w = createInFlightWatch<void>();
    let release: (() => void) | null = null;
    w.start(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    w.beginCancel();
    expect(w.start(async () => {})).toEqual({ started: false, reason: "cancelling" });
    release?.();
  });

  it("settle 等到落地；任务【抛】也照样 settle 而不 reject", async () => {
    // 「不 reject」不等于「没人说这句话」—— 它等于说话的地方搬到了派发动作那边
    // （assemble.ts 那个 catch）。这一发钉的是【搬得过去】：清理路径不会跟着炸。
    const w = createInFlightWatch<void>();
    w.start(async () => {
      throw new Error("备份炸了");
    });
    expect(w.inFlight).toBe(true);
    // 不 reject ⇒ 这一行【不该】抛。如果实现改成把 rejection 透出来，这一发红。
    await w.settle();
    expect(w.inFlight).toBe(false);
    // 落地之后可以再派（否则一次失败会把这道门永久关上 = 备份再也不跑）。
    expect(w.start(async () => {})).toEqual({ started: true });
    await w.settle();
  });

  it("⭐ 任务【同步抛】不会把一个已落地的 promise 永久留在 inFlight 上", async () => {
    // 这是 createTicker 里那个真缺陷的同族（见它 runOnce 上面那段注释）：
    // 同步抛的任务会在清理里把状态清掉，【那时】赋值才执行 ⇒ 状态永久停在「在飞」。
    // 在这里的后果不是「每轮跳过」而是「再也派不出第二件」，同样是一个
    // 自己把自己锁死的形状，而症状看起来像「上一份还没完」。
    const w = createInFlightWatch<void>();
    expect(
      w.start(() => {
        throw new Error("装配错了");
      }),
    ).toEqual({ started: true });
    await drain();
    expect(w.inFlight).toBe(false);
    // 第二件必须派得出去。这一行是这一发的本体：上一发断的是「不卡在 inFlight」。
    expect(w.start(async () => {})).toEqual({ started: true });
    await w.settle();
  });

  it("settle 在没有在飞任务时是【不用等】，不是「等一个不存在的东西」", async () => {
    // 与 0025 §3 第 ③ 条那条「await 一个永远为 null 的变量」的区别写在实现里：
    // 那里 null 是【读错了地方】（遮蔽），这里是【真的没有】。
    // 所以这一发不是废话 —— 它钉的是「空的时候不挂住」，挂住就是关机永不完成。
    const w = createInFlightWatch<void>();
    await w.settle();
    expect(w.inFlight).toBe(false);
  });

  it("start 里【不在这一行调用】任务（闭包读的是微任务那一刻的外部变量）", async () => {
    // 类型上写了这条（start 那一栏），所以它得有用例 —— 「写在注释里的契约」
    // 没有用例就是没有契约（test/arch/run-fixtures.ts 文件头那句「注释不是机制」）。
    const w = createInFlightWatch<void>();
    let when = "before";
    w.start(async () => {
      when = "inside";
    });
    expect(when).toBe("before");
    await w.settle();
    expect(when).toBe("inside");
  });
});
