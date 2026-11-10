/**
 * 心跳调度器：`patrol.ts:373` 拒的那个 setInterval 归这里。
 *
 * ── 为什么必须有另一个模块接这件事 ─────────────────────────────────
 * patrol.ts 文件头那句话（「调度（什么时候醒）属于常驻进程」）不是谦让，是两条
 * 具体的坏味道：导入一个纯判定模块不该顺手装上一个定时器（测试进程会因为一个
 * 没人关的 timer 挂着不走），以及「什么时候醒」与「醒了做什么」的失败模式不同
 * （后者抛不抛是业务问题，前者会不会漏醒/重叠/静默停止是进程问题）。
 * 那两条都成立，所以判定留在 patrol.ts，定时器住在这里。
 *
 * ── 定时器是【注入】的，且这里没有 setInterval ──────────────────────
 * 真实节奏用【一条 setTimeout 链】而不是 setInterval：每轮跑完才安排下一轮。
 * 差别在慢的那一侧才有意义，而它迟早会发生（一轮巡检 = 一条全表 SQL）：
 *   · setInterval + 一个 async 回调 ⇒ 上一轮没跑完就再开一轮，两轮巡检【并发】，
 *     于是同一个停滞任务被两条 HeartbeatStalled 事件写进 append-only 的库
 *     （patrol 自己的去重判据是「上一轮已报过就不报」，并发时那一读还没看到未提交的那一行）。
 *   · 同理，事件循环被卡住一段时间后，setInterval 会把欠下的轮次【挤在一起补】。
 * 链式安排下一轮 ⇒ 天然串行、永不重叠、不补债。代价是周期会漂移（每轮多花的那点
 * 时间累加进去），这个代价【要】：宁可口头上「15 分钟一醒」变成「15 分钟 + 巡检耗时」，
 * 也不要两个巡检同时在写库。这一点写在 API 名字上（every 的注释），别当调优结果改回去。
 *
 * ── 假时钟是这一篇能被测的原因 ──────────────────────────────────────
 * 用真 setTimeout 的话，「连续三轮失败 ⇒ 停」这条要真等三轮；
 * 「巡检卡住时不重叠」这条要么测不了，要么靠 sleep 变成一条 flaky。
 * 所以时间源与定时器都收在 Scheduler 这一个形状后面，测试里 advance(45 * 60_000)
 * 就等价于真等 45 分钟。
 */

/** 一次已安排的唤醒。只有 clear，没有 pause —— 没有需要的地方，多一个状态就多一个错的可能。 */
export type TimerHandle = {
  clear(): void;
};

/**
 * 时间源 + 定时器。测试里两者必须【同一个】实现：
 * 只假定时器、时钟还是 Date.now，那么「巡检按 now() 判停滞」与「我推进了 45 分钟」
 * 会对不上，测试会绿在错的地方（本仓在别的夹具上撞过同一族：假时钟只覆盖了一半）。
 */
export interface Scheduler {
  /** ms 之后叫一次 fn。返回句柄用于取消。 */
  after(ms: number, fn: () => void): TimerHandle;
  now(): number;
}

/** 真时钟 + 真定时器。`.unref()` 见下面那行注释 —— 这一格决定了测试进程能不能自己退出。 */
export const REAL_SCHEDULER: Scheduler = {
  after(ms, fn) {
    const t = setTimeout(fn, ms);
    // unref 的必要性很具体：本模块被生产入口用，也被测试 import。
    // 一个未 ref 的 timer 会【吊住整个进程】不让它退出 —— 而那种挂起在 CI 里
    // 表现为「测试跑完了但不退」，很容易被一句 --force-exit 糊过去，
    // 于是真正的「没人关定时器」这个缺陷永久隐藏（patrol.ts 文件头说的正是这一族）。
    // 常驻进程不会因为 unref 而提前退出：它同时持有 HTTP server 的 handle。
    if (typeof t.unref === "function") t.unref();
    return {
      clear: () => {
        clearTimeout(t);
      },
    };
  },
  now: () => Date.now(),
};

/**
 * 可推进的假时钟。`advance` 会【同步】跑完整回调链 —— 包括回调里安排的下一轮，
 * 所以 advance(3 * interval) 就是三轮，不需要 await 一个 tick。
 * 回调是 async 的时候，`advance` 只保证【叫到了】，不保证【跑完了】：
 * 需要等结果的地方用 ticker.tick() 直接叫（那才是测试该用的入口）。
 */
export interface FakeScheduler extends Scheduler {
  advance(ms: number): void;
  set(ms: number): void;
  /** 当前排着多少个定时器。测试用它钉「没有重复安排」这一格。 */
  pending(): number;
}

export function createFakeScheduler(startMs = 0): FakeScheduler {
  let clock = startMs;
  let seq = 0;
  type Item = { readonly at: number; readonly order: number; fn: () => void; done: boolean; handle: TimerHandle };
  let items: Item[] = [];

  const remove = (it: Item): void => {
    it.done = true;
    items = items.filter((x) => x !== it);
  };

  const step = (limit: number): void => {
    for (;;) {
      // 同一毫秒里排下的多个回调按【登记顺序】跑。写成「只按 at 排」的话，
      // 顺序由数组当前状态决定，测试里就会出现「两个回调谁先跑不确定」——
      // 那种不确定只会以「本地绿、别人红」的形式回来。
      const due = items
        .filter((x) => !x.done && x.at <= limit)
        .sort((a, b) => (a.at === b.at ? a.order - b.order : a.at - b.at))[0];
      if (due === undefined) return;
      remove(due);
      clock = Math.max(clock, due.at);
      due.fn();
    }
  };

  return {
    after(ms, fn) {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new Error("Scheduler.after 的 ms 必须是非负有限数，收到 " + String(ms));
      }
      const it: Item = { at: clock + ms, order: seq++, fn, done: false, handle: undefined as unknown as TimerHandle };
      it.handle = { clear: () => remove(it) };
      items.push(it);
      return it.handle;
    },
    now: () => clock,
    advance(ms) {
      if (ms < 0) throw new Error("advance 不接受负数（时间不倒流）");
      const limit = clock + ms;
      step(limit);
      clock = limit;
    },
    set(ms) {
      const limit = Math.max(ms, clock);
      step(limit);
      clock = limit;
    },
    pending: () => items.filter((x) => !x.done).length,
  };
}

export type TickOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

/**
 * 一轮接一轮跑的循环。四个语义各自都对应一种真实的坏法：
 *
 *  1. 【串行不重叠】上一轮的 promise 没落地 ⇒ 到点也不叫，只记一笔「跳了一轮」。
 *     不记那一笔就是静默：巡检一直在漏而日志一片干净。
 *  2. 【抛不杀循环】一次抛错绝不结束整个心跳。杀循环的后果是 Hub 一直「在跑」
 *     （端口在、界面显示运行中）而永不停滞检测 —— 本仓反复定义为最贵的那类失效。
 *  3. 【连续失败到阈值就停并上报】与 2 不矛盾：2 说的是「一次偶发不该杀」，
 *     3 说的是「一直坏着要说一句然后停下别再刷」。阈值见 createTicker。
 *  4. 【stop 之后不再叫】包括已经安排在队里的那一发。
 */
export interface Ticker {
  /** 手动叫一轮。测试与「启动时立即跑一轮」都走这里，不等定时器。 */
  tick(): Promise<TickOutcome>;
  stop(): void;
  readonly stopped: boolean;
  readonly running: boolean;
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
  /** 因为「上一轮还没跑完」而被跳过的次数。 */
  readonly skipped: number;
}

export interface TickerOptions {
  readonly intervalMs: number;
  readonly job: () => void | Promise<void>;
  readonly scheduler?: Scheduler;
  /** 每一轮的错误都报（含第一次）。用于日志。 */
  readonly onError?: (error: string, consecutiveFailures: number) => void;
  /**
   * 连续失败到这个数 ⇒ 停止心跳并叫一次。
   *
   * 3 不是调优结果，是「一天三醒」的量级判断：15 分钟一轮的话三次 = 45 分钟，
   * 足够长到不是一次抖动，又足够短到不会让停滞检测静默失效一整天。
   * 传 0/1 是调用方的权利（比如测试要钉第一发就停）。
   */
  readonly maxConsecutiveFailures?: number;
  /** 停机上报。到这里事情已经不是「一轮坏了」而是「心跳没了」。 */
  readonly onFatal?: (error: string, consecutiveFailures: number) => void;
}

export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

/**
 * 「有一件事在飞」这个状态本身（0036 §3）。
 *
 * ── 为什么这是一个独立的、显式的对象而不是一个 Promise 变量 ──────────
 * 本仓为此付过一次代价（0025 §3 第 ③ 条）：`backupInFlight` 被一个局部同名声明遮蔽，
 * 于是「关机时等一份在飞的备份」读到的永远是 null，**测试全绿**。
 * 那一版的形状是「一个可能为 null 的 Promise 变量」，它的失效是【读不到】，
 * 而读不到与「确实没有在飞的东西」在断言里长得一模一样。
 *
 * 所以这里把它做成一个有名字的对象，两个字段各自对应一条独立的性质：
 *  · `inFlight`   ⇒ 「同一轮里会不会开出第二份」。挡住并发。
 *  · `cancelling` ⇒ 「关机已开始后不再【开始】新的」。挡住关机之后的新一轮。
 * 两者【不能合成一个】：一个说「有东西在跑，要等」，一个说「别再派新活」。
 * 合成一个之后，「等到落地」与「不再派新活」两种处置在类型上分不开
 * （与 0036 里 `run` / `failure` 那个分形、0031 §0 那个判决形状同一族）。
 *
 * 之所以住在 timer.ts 而不是 assemble.ts：它管的这件事（什么时候开始、要不要等）
 * 与本模块管的「什么时候醒」是同一类【进程问题】，而文件头那段划的界线正是
 * 「判定留业务模块，调度与生命周期归这里」。
 */
export type InFlightWatch<T> = {
  /** 当前有没有在飞的任务。给「不许开出第二份」那一格用。 */
  readonly inFlight: boolean;
  /** 已进入关机。给「不再开始新的」那一格用。 */
  readonly cancelling: boolean;
  /**
   * 进入关机。**必须在任何 await 之前调用**，否则「决定要派活」与「开始派活」之间
   * 就还开着缝（0025 §3 第 ④ 条那一族）。
   * @returns 是否真的进入了关机（false = 早就是了，调用方可据此知道自己是第二次叫）。
   */
  beginCancel(): boolean;
  /**
   * 等在飞的任务落地。**永不 reject**：这里等的是「别在它跑着的时候关资源」，
   * 而不是「它得成功」。让一个失败从 settle 里冒出来，调用方就会面对
   * 「要不要处理这个失败」这个它并不需要的决定（失败本来就有自己的出口）。
   *
   * ⚠ 「不 reject」不等于「没人说这句话」，它等于【说话的地方搬走了】：
   * 派发动作必须自己接住失败并说出去（assemble.ts 的 reportBackupOutcome 就是这么干的）。
   * 只读这一栏而不去看派发处，会得出「失败被吞了」这个结论 —— 而我写第一版时
   * 就是这么以为的，并且差一点据此给 settle 加一个 onRejected 参数。
   */
  settle(): Promise<void>;
  /**
   * 派一件活。派不派得出去，以及【派不出去是因为哪一道门】。
   *
   * 两道门都在这个函数【里面】，而不是让调用方自己查：调两个地方就会有两个忘一处的那天
   * （0036 §5 的 P-A / P-B 各拆一道门，都必须红）。
   *
   * ⚠ 为什么返回的是【原因】而不是 boolean：这里曾经同时存在【第三道门】
   * （调用方自己写的一句 `if (watch.cancelling) return`），而我把那句删掉了 ——
   * 不是因为嫌重复，是因为**它让 P-B 变成一发打不红的变异**：
   * 删掉调用方那一句，start() 里面那道同样的门照样把它挡住，行为一字不差。
   * 一个「补回来的守卫」如果拆掉不红，它就只是源码里的一句话（0025 §3 第 ③ 条同族）。
   * 换成带原因的返回值之后：门只有一处，而【测试可以直接断言被拒的原因】，
   * 于是「cancelling 真的在挡东西」这件事有一条打得红的用例。
   *
   * 返回值【必须被读】：拿到 started:false 而什么都不说，就是「备份没做成而日志一片干净」。
   *
   * ⚠ `task` 【不会在 start 这一行被调用】（理由见实现里那条微任务）。
   * 所以闭包里读的外部变量取值于【微任务那一刻】而不是叫 start 那一刻 ——
   * 这一条对调用方可见，所以写在类型上而不是只写在实现里。
   */
  start(task: () => Promise<T>): StartOutcome;
};

/** start 的结论。两个拒因必须【分开】，理由见 start 那一栏。 */
export type StartOutcome =
  | { readonly started: true }
  | { readonly started: false; readonly reason: "cancelling" | "in_flight" };

export function createInFlightWatch<T = unknown>(): InFlightWatch<T> {
  let current: Promise<T> | null = null;
  let cancelling = false;

  const watch: InFlightWatch<T> = {
    get inFlight() {
      return current !== null;
    },
    get cancelling() {
      return cancelling;
    },
    beginCancel() {
      if (cancelling) return false;
      cancelling = true;
      return true;
    },
    start(task) {
      // 两道门都在这里，而不是让调用方自己查：调两个地方就会有两个忘一处的那天，
      // 而 P-A / P-B 那两发变异（0036 §5）分别拆掉一道门时都必须红。
      // 顺序上 cancelling 在前：关机【同时】也让在飞的东西存在，那时正确的原因是
      // 「别再派新活」而不是「有个活的在跑」—— 报反了会让人以为关机被一份备份卡住。
      if (cancelling) return { started: false, reason: "cancelling" };
      if (current !== null) return { started: false, reason: "in_flight" };
      /**
       * ⚠ 与上面 createTicker 那条【同一个坑】，形状也不同但病同源：
       * `task()` 若是【同步抛】（或返回一个已 settle 的 promise），
       * `.then/.catch` 链上的清理会在 `current = p` 之前跑完，
       * 于是把一个【已经落地】的 promise 永久留在 current 上 ⇒
       * 从此「不许开出第二份」那道门永远关着，备份/任务再也不跑，
       * 而日志上看起来像「上一份还没完」。
       * 修法照 ticker：让 task 的调用【推迟到微任务】，current 一定先落地。
       */
      const p = Promise.resolve()
        .then(task)
        .catch((): undefined => undefined)
        .then(
          (v): T => {
            current = null;
            return v as T;
          },
        );
      current = p;
      return { started: true };
    },
    settle() {
      // current 可能为 null（没有在飞的东西）—— 那时这就是「不用等」，不是「等一个不存在的东西」。
      // 与 0025 §3 第 ③ 条那条「await 一个永远为 null 的变量」的区别是：
      // 这里 null 是【真的没有】而不是【读错了地方】，因为读的是闭包里的 current。
      return current === null ? Promise.resolve() : current.then((): void => undefined);
    },
  };
  return watch;
}

export function createTicker(o: TickerOptions): Ticker {
  if (!Number.isFinite(o.intervalMs) || o.intervalMs <= 0) {
    throw new Error("心跳间隔必须是正数毫秒，收到 " + String(o.intervalMs));
  }
  const scheduler = o.scheduler ?? REAL_SCHEDULER;
  const maxFails = o.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  if (!Number.isInteger(maxFails) || maxFails < 1) {
    throw new Error(
      "maxConsecutiveFailures 必须是 >= 1 的整数，收到 " +
        String(o.maxConsecutiveFailures) +
        "。0 的意思是「一次都不许失败」，那不是这台机器上的东西 —— " +
        "要立刻停就传 1，别用 0 表达「不许失败」。",
    );
  }

  let inFlight: Promise<TickOutcome> | null = null;
  let timer: TimerHandle | null = null;
  let stopped = false;
  let consecutiveFailures = 0;
  let lastError: string | null = null;
  let skipped = 0;

  const scheduleNext = (): void => {
    if (stopped) return;
    // 只允许一个在排的定时器：重复安排会造成「一轮里叫两次」，
    // 那是与并发重叠同一族的东西，所以要有一条测试专门钉它。
    if (timer !== null) return;
    timer = scheduler.after(o.intervalMs, () => {
      timer = null;
      void runOnce();
    });
  };

  const runOnce = (): Promise<TickOutcome> => {
    if (stopped) return Promise.resolve({ ok: true });
    if (inFlight !== null) {
      skipped++;
      o.onError?.(
        "上一轮心跳还没结束，本轮【跳过】（累计跳过 " + skipped + " 次）",
        consecutiveFailures,
      );
      return inFlight;
    }
    /**
     * ⚠ job 的调用【必须】推迟一个微任务，不能直接写在同步路径上。
     *
     * 我第一版写的是 `(async () => { try { await o.job() } … finally { inFlight = null } })()`
     * 然后 `inFlight = p`。看着等价，实际不等价：async 函数体在【第一个 await 之前】是
     * 同步执行的，所以一个【同步抛错】的 job（`job: () => { throw new Error() }`，
     * 测试里最常见、生产里也完全可能——runPatrol 的 SQL 准备阶段就是同步的）会在
     * `finally` 里把 inFlight 置成 null、安排好下一轮，【那时】`inFlight = p` 才执行，
     * 于是把一个【已经落地】的 promise 永久留在 inFlight 上。
     * 后果不是崩，是【心跳从此每轮都报「上一轮还没结束」并跳过】——
     * 一个自己把自己锁死的心跳，而日志里那句跳过看起来像「巡检有点慢」。
     * 这正是本模块存在的理由（消灭静默）的反面，而且是它自己造成的。
     *
     * 修法是从根上消除竞态而不是加补救：让 job 的调用发生在【微任务里】，
     * 于是 `inFlight = p` 一定先落地，finally 里的清空一定后发生。
     */
    const p: Promise<TickOutcome> = Promise.resolve()
      .then(() => o.job())
      .then(
        (): TickOutcome => {
          consecutiveFailures = 0;
          return { ok: true };
        },
        (e: unknown): TickOutcome => {
          const msg = e instanceof Error ? e.message : String(e);
          consecutiveFailures++;
          lastError = msg;
          o.onError?.(msg, consecutiveFailures);
          if (consecutiveFailures >= maxFails) {
            // 先停再上报：onFatal 里通常会去关服务、退进程，那时代码应当能看见
            // 「心跳已经停了」这个事实，否则它自己也可能去 tick() 一轮。
            stopNow();
            o.onFatal?.(msg, consecutiveFailures);
          }
          return { ok: false, error: msg };
        },
      )
      .finally(() => {
        inFlight = null;
        scheduleNext();
      });
    inFlight = p;
    return p;
  };

  const stopNow = (): void => {
    stopped = true;
    if (timer !== null) {
      timer.clear();
      timer = null;
    }
  };

  scheduleNext();
  return {
    tick: runOnce,
    stop: stopNow,
    get stopped() {
      return stopped;
    },
    get running() {
      return inFlight !== null;
    },
    get consecutiveFailures() {
      return consecutiveFailures;
    },
    get lastError() {
      return lastError;
    },
    get skipped() {
      return skipped;
    },
  };
}
