import { describe, expect, it } from "vitest";
import {
  DEFAULT_RING_CAPACITY,
  type EventSubscription,
  type FeedItem,
  InMemoryEventBus,
} from "../../src/events/bus.js";

/**
 * next() 一律带超时。理由在 Task 0.5 踩过：实现死锁时整个文件会挂到 vitest 的
 * 180s 全局超时，报错只有一行 "Test timed out"，看不出是谁在等谁。
 * 2s 相对实现耗时（微秒级）有六个数量级余量，不会误报。
 */
function next(
  sub: EventSubscription,
  label: string,
): Promise<FeedItem | "DONE" | "TIMEOUT"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // label 只进日志：返回值保持纯字面量哨兵，断言处的类型才不被污染
      console.error("[bus test] next() 超时：", label);
      resolve("TIMEOUT");
    }, 2_000);
    timer.unref();
    void (async () => {
      try {
        const r = await sub[Symbol.asyncIterator]().next();
        clearTimeout(timer);
        resolve(r.done ? "DONE" : r.value);
      } catch (e) {
        clearTimeout(timer);
        console.error("[bus test] next() 抛错：", label, e);
        resolve("TIMEOUT");
        throw e; // 让它显式失败，不静默
      }
    })();
  });
}

/** 连发 n 条：seq 用 1..n，kind 固定 TaskStateChanged。 */
const emit = (bus: InMemoryEventBus, n: number, fromSeq = 1): void => {
  for (let i = 0; i < n; i++) {
    bus.publishPersisted(
      { kind: "TaskStateChanged", taskId: "T-1", from: "a", to: "b" },
      fromSeq + i,
    );
  }
};

describe("InMemoryEventBus 的游标语义", () => {
  it("latestSeq 无事件时为 0；有事件时为最大 seq（不是最后发布的那个）", async () => {
    const bus = new InMemoryEventBus();
    expect(bus.latestSeq()).toBe(0);
    emit(bus, 3);
    expect(bus.latestSeq()).toBe(3);
    // 单调性由 publishPersisted 保证（下一条用例），所以 latestSeq 就是「最大」。
  });

  it("seq 必须严格递增：倒退、重复都当场拒绝", async () => {
    const bus = new InMemoryEventBus();
    emit(bus, 3);
    // 倒退。为什么必须炸而不是容忍：seq 是 SSE 断线续订的游标（计划接口注释），
    // 一旦允许回退，前端按 fromSeq 续订就会静默漏事件 —— 且没有任何报错迹象。
    expect(() =>
      bus.publishPersisted(
        { kind: "TaskStateChanged", taskId: "T-1", from: "a", to: "b" },
        2,
      ),
    ).toThrow(/seq/);
    expect(() =>
      bus.publishPersisted(
        { kind: "TaskStateChanged", taskId: "T-1", from: "a", to: "b" },
        3,
      ),
    ).toThrow(/seq/);
    expect(bus.latestSeq()).toBe(3);
  });

  it("seq 必须是正整数：0 是「无事件」的哨兵，不能当事件用", async () => {
    const bus = new InMemoryEventBus();
    expect(() =>
      bus.publishPersisted(
        { kind: "TaskStateChanged", taskId: "T-1", from: "a", to: "b" },
        0,
      ),
    ).toThrow(/seq/);
    expect(() =>
      bus.publishPersisted(
        { kind: "TaskStateChanged", taskId: "T-1", from: "a", to: "b" },
        Number.NaN,
      ),
    ).toThrow(/seq/);
    expect(() =>
      bus.publishPersisted(
        { kind: "TaskStateChanged", taskId: "T-1", from: "a", to: "b" },
        1.5,
      ),
    ).toThrow(/seq/);
  });
});

describe("慢消费者不拖慢生产者（规格 §5.8）", () => {
  it("队列有界：容量 2、连发 20 条，丢弃计数必须 = 18（无界实现永远等不到）", async () => {
    const bus = new InMemoryEventBus(2);
    const slow = bus.subscribe();
    emit(bus, 20);
    // 断言的是 dropped() 而不是「读到的条数」。无界数组实现能读满 20 条，
    // 但 dropped() 恒为 0 —— 这条断言专抓「用无界数组糊弄有界队列」。
    expect(slow.dropped()).toBe(18);
    expect(bus.latestSeq()).toBe(20);
  });

  it("丢的是【最旧】，且第一条就把 degraded 送到（规格 §5.8 丢最旧并标记）", async () => {
    const bus = new InMemoryEventBus(2);
    const slow = bus.subscribe();
    emit(bus, 5);
    const first = await next(slow, "slow#1");
    if (first === "TIMEOUT")
      throw new Error("慢消费者 2s 内没拿到任何事件（degraded 标记也没送到）");
    if (first === "DONE") throw new Error("慢消费者的流被提前关掉了");
    expect(first.degraded).toBe(true);
    expect(first.seq).toBe(4); // 容量 2、发 5 条 → 留 4、5
    const second = await next(slow, "slow#2");
    if (typeof second === "string") throw new Error("第二条异常: " + second);
    expect(second.seq).toBe(5);
    // degraded 只跟【那一次】丢失绑定，之后不再重复刷（§5.8：全量靠 REST 拉快照，
    // 事件流不该把同一个降级标记推 20 次）。
    expect(second.degraded).toBeUndefined();
  });

  it("默认容量存在且有限（不写死实现也挡住【不设上限】）", async () => {
    const bus = new InMemoryEventBus();
    const slow = bus.subscribe();
    emit(bus, DEFAULT_RING_CAPACITY + 7);
    expect(slow.dropped()).toBe(7);
  });

  it("及时消费的订阅者一条不丢", async () => {
    const bus = new InMemoryEventBus(2);
    const fast = bus.subscribe();
    const it = fast[Symbol.asyncIterator]();
    const got: number[] = [];
    for (let i = 1; i <= 10; i++) {
      emit(bus, 1, i); // 发一条
      const v = await it.next(); // 立刻收一条
      if (v.done) throw new Error("第 " + i + " 条后流被关掉");
      got.push(v.value.seq);
      expect(v.value.degraded).toBeUndefined();
    }
    expect(got).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(fast.dropped()).toBe(0);
  });
});

describe("订阅与断线续订（§5.8 的恢复路径）", () => {
  it("subscribe() 不带游标 = 只收未来，不回放历史", async () => {
    const bus = new InMemoryEventBus();
    emit(bus, 3);
    const sub = bus.subscribe();
    emit(bus, 1, 4);
    expect(sub.startSeq).toBeUndefined();
    const v = await next(sub, "future-only");
    if (typeof v === "string") throw new Error("新订阅者没收到新事件: " + v);
    expect(v.seq).toBe(4); // 不是 1
  });

  it("subscribe(fromSeq) 续订：环形里还留着的要补上", async () => {
    const bus = new InMemoryEventBus(8);
    emit(bus, 6);
    const sub = bus.subscribe(3); // 从 seq>3 的开始补
    expect(sub.startSeq).toBe(3);
    const it = sub[Symbol.asyncIterator]();
    const a = await it.next();
    const b = await it.next();
    expect([a.value?.seq, b.value?.seq]).toEqual([4, 5]);
    expect(a.value?.degraded).toBeUndefined();
  });

  it("续订起点已被环形覆盖 → 必须立刻 degraded（静默漏事件是最危险的）", async () => {
    const bus = new InMemoryEventBus(2);
    emit(bus, 10); // 1、2 已被覆盖
    const sub = bus.subscribe(1);
    const v = await next(sub, "resumed-past-ring");
    if (typeof v === "string") throw new Error("续订没拿到事件: " + v);
    expect(v.degraded).toBe(true);
    expect(v.seq).toBe(9); // 只剩 9、10
    expect(sub.dropped()).toBe(7); // 3..9 里真正没送出去的是 3..8（6 条）+ 起点 1、2
  });

  it("一个订阅者崩了不影响别人：close() 后从广播名单里摘掉", async () => {
    const bus = new InMemoryEventBus(4);
    const doomed = bus.subscribe();
    const healthy = bus.subscribe();
    emit(bus, 1, 1);
    doomed.close();
    emit(bus, 1, 2);
    const it = healthy[Symbol.asyncIterator]();
    const a = await it.next();
    expect(a.value?.seq).toBe(1);
    expect(doomed.dropped()).toBe(0); // close 之后的事件不再计入它的丢弃数
    emit(bus, 1, 3);
    expect(doomed.dropped()).toBe(0);
    // 回收的证据是【总线不再持有它】。漏摘除会一直泄漏队列与连接（§5.8 要求回收），
    // 而 doomed.dropped() 自己不累加是看不出泄漏的 —— 它只是不再被投递。
    expect(bus.subscribers?.()).toBe(1);
    const b = await it.next();
    expect(b.value?.seq).toBe(2);
  });

  it("无订阅者时 publish 不炸（审计写入先于前端连接是常态）", async () => {
    const bus = new InMemoryEventBus();
    expect(() => emit(bus, 3)).not.toThrow();
    expect(bus.latestSeq()).toBe(3);
  });
});
