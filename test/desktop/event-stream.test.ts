/**
 * 桌面壳的【事件流 → 推送】那一段（main/event-stream.ts）。
 *
 * ── 为什么这一发用【真 socket】而不用注入的替身 ─────────────────────
 * 本仓别的地方用替身是因为依赖装不上（electron / undici 的类型是空壳）。
 * 这里不是：node:http 离线可用（web/dev-server.ts 一直在用）。
 * 而这一层最容易坏的三件事恰好都是【替身给不出的东西】：
 *  ① 一帧被 TCP 劈成两包（切帧只按 `\n\n`，半截必须留在缓冲里）；
 *  ② 真断线时 res 的 end / error 顺序；
 *  ③ 签名与请求目标必须是【同一个字符串】—— 替身不会验签，
 *     于是「多拼一个 /api 前缀」这种错在替身下永远绿，而线上是 401。
 * 所以本文件的服务器【拿 hub 自己的 verifyRequest 当门】：签名不对直接 401，
 * 一帧都收不到。这不是把 hub 拖进桌面测试 —— §5.6.1 管的是【产物里的依赖边】，
 * 测试进程同时 import 两侧是本仓既有做法（dev-server-sign.test.ts 同一形状）。
 *
 * ── 那一发真正在验的是【重连带什么游标】────────────────────────────
 * 见 event-stream.ts 文件头。Task 2.3 的「快照 + 续订幂等」依赖
 * 「客户端把手上最大 seq 带回来」；不带的话服务端走 begin()，
 * 断线期间落库的那几条【永远不会被投递】—— 症状是"看板偶尔少一次变化，刷一次就好"。
 * 这一发把每次连接收到的 cursor 记在服务器上，第二次【必须】是上次推出去的那个 seq。
 *
 * 跑法（离线、node v24.14.0）：
 *   PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH \
 *     node --experimental-transform-types --import /tmp/opc-harness/register.mjs \
 *     --test "test/desktop/event-stream.test.ts"
 */
import { type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { encodeSseFrame, reconnectDelayMs } from "../../packages/contracts/src/api.js";
import { verifyRequest } from "../../packages/hub/src/http/auth.js";
import { LINK_EVENT, openEventStream, type LinkStatus } from "../../packages/desktop/src/main/event-stream.js";
import type { HubEventPayload } from "../../packages/desktop/src/preload/api.js";

const TOKEN = "desktop-stream-test-token";

/** 一次连接的推流口。write 是【裸字节】—— 分片那一发需要它。 */
interface Conn {
  write(raw: string): void;
  push(frame: { event: string; data: string; id?: string }): void;
  end(): void;
}

interface FakeHub {
  /**
   * ⚠ 不是 readonly，而这不是疏忽：端口是 listen(0) 之后【才知道】的，
   * 而 FakeHub 这个对象必须在 listen 之前就存在（handler 闭包要引用它）。
   * 我第一版写的 readonly 直接编译不过。要"真 readonly"得把对象拆成两段构造，
   * 那为了一个测试夹具不值。
   */
  port: number;
  /** 每次连接在 query 上收到的 cursor（没带记 0）。 */
  readonly cursors: number[];
  readonly targets: string[];
  /** 当前活着的连接（断了就是 null）。 */
  conn(): Conn | null;
  /** 让下一个连接直接回这个状态码（一次性）。 */
  failNext(status: number, body?: string): void;
  /** 下一个连接【跳过验签】（用来单独测「签名本身对不对」那一维）。 */
  skipAuthOnce(): void;
  close(): Promise<void>;
}

let live: FakeHub[] = [];

async function startHub(onConnect: (cursor: number, conn: Conn) => void): Promise<FakeHub> {
  let current: ServerResponse | null = null;
  let pendingFail: { status: number; body: string } | null = null;
  let skipAuth = false;
  const connOf = (res: ServerResponse): Conn => ({
    write: (raw) => {
      res.write(raw);
    },
    push: (frame) => {
      res.write(
        encodeSseFrame({
          event: frame.event,
          data: frame.data,
          ...(frame.id === undefined ? {} : { id: frame.id }),
        }),
      );
    },
    end: () => {
      res.end();
    },
  });
  const srv: Server = createServer((req, res) => {
    const target = req.url ?? "/";
    hub.targets.push(target);
    if (pendingFail !== null) {
      const f = pendingFail;
      pendingFail = null;
      res.writeHead(f.status, { "content-type": "application/json" });
      res.end(f.body);
      return;
    }
    if (skipAuth) {
      skipAuth = false;
    } else {
      const v = verifyRequest({
        token: TOKEN,
        method: req.method ?? "GET",
        target, // 【原始请求目标】，与 hub 的 app.ts 同一个口径
        body: "",
        headers: req.headers as Record<string, string | undefined>,
        now: Date.now(),
      });
      if (v.ok !== true) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized: " + v.code }));
        return;
      }
    }
    const raw = new URL(target, "http://x").searchParams.get("cursor");
    const cursor = raw === null ? 0 : Number(raw);
    hub.cursors.push(cursor);
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    current = res;
    res.on("close", () => {
      if (current === res) current = null;
    });
    onConnect(cursor, connOf(res));
  });
  const hub: FakeHub = {
    port: 0,
    cursors: [],
    targets: [],
    conn: () => (current === null ? null : connOf(current)),
    failNext: (status, body = "") => {
      pendingFail = { status, body };
    },
    skipAuthOnce: () => {
      skipAuth = true;
    },
    close: async () => {
      current?.destroy();
      current = null;
      await new Promise<void>((r) => srv.close(() => r()));
    },
  };
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  hub.port = (srv.address() as AddressInfo).port;
  live.push(hub);
  return hub;
}

afterEach(async () => {
  const closing = live;
  live = [];
  for (const h of closing) {
    try {
      await h.close();
    } catch {
      /* 已关 */
    }
  }
});

/**
 * 手动调度的定时器。
 * ⚠ 注的是【调度器】而不是【退避曲线】—— 曲线仍然由 contracts 那份算，
 * 注掉曲线才会造成「桌面端 15 秒放弃、Web 无限重试」那种两份漂移（0035 §注释）。
 * 真的等一遍八次退避要几十秒，而那一发测试的下场是被人注释掉。
 */
function fakeClock() {
  const pending: { fn: () => void; ms: number }[] = [];
  return {
    setTimeoutImpl: (fn: () => void, ms: number) => {
      pending.push({ fn, ms });
      return () => {
        const i = pending.findIndex((p) => p.fn === fn);
        if (i >= 0) pending.splice(i, 1);
      };
    },
    async runOne(): Promise<number> {
      const p = pending.shift();
      if (p === undefined) throw new Error("没有待调度的重连 ⇒ 它要么放弃了，要么根本没失败过");
      p.fn();
      await tick();
      return p.ms;
    },
    get waiting(): number {
      return pending.length;
    },
    get waits(): number[] {
      return pending.map((p) => p.ms);
    },
  };
}

/**
 * 让【真 socket 上的一个来回】走完。
 *
 * ⚠ 这里原来是一发 `setTimeout(20)`，而它是我在这个文件里埋的一颗flake：
 * 我跑本机全绿 12 次，而把它和一次 `tsc` 并行跑就红过一发 —— 定长睡眠
 * 【不保证】覆盖一次回环往返，机器忙的时候 20ms 可以不够。
 * 改成【排干事件循环】：setImmediate 是 check 阶段，每一轮之前 libuv
 * 都会先跑 poll 阶段 ⇒ socket 回调必然在几轮之内被处理，与机器负载无关。
 * 判据不是"快一点"，是【不依赖挂钟】。
 *
 * 断言【不存在】的那些发（比如"close() 之后不再推"）仍然需要真的等一会儿——
 * 那种地方没有条件可等，见下面 settle()。
 */
const tick = async (turns = 12): Promise<void> => {
  for (let i = 0; i < turns; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
};

/** 断言「没有发生」用的：那种地方没有条件可轮询，只能给一段时间，然后看计数没变。 */
const settle = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

function collector() {
  const got: HubEventPayload[] = [];
  const links: LinkStatus[] = [];
  return {
    got,
    links,
    push: (p: HubEventPayload) => {
      got.push(p);
    },
    onStatus: (s: LinkStatus) => {
      links.push(s);
    },
    /** 不含链路状态帧的业务事件。 */
    get events(): HubEventPayload[] {
      return got.filter((p) => p.event !== LINK_EVENT);
    },
    lastLink(): LinkStatus | undefined {
      return links[links.length - 1];
    },
  };
}

describe("① 帧切分与推送形状", () => {
  it("快照帧【不带 seq】而事件帧【带 seq】，顺序与 Hub 推的一致", async () => {
    const h = await startHub((cursor, conn) => {
      conn.push({ event: "snapshot", data: JSON.stringify({ source: "tasks", as_of_seq: cursor, body: [] }) });
      conn.push({ event: "TaskStateChanged", data: '{"task_id":"t1"}', id: String(cursor + 1) });
      conn.push({ event: "ApprovalRequired", data: '{"task_id":"t1"}', id: String(cursor + 2) });
    });
    const c = collector();
    const stream = openEventStream({
      token: TOKEN,
      hubAddress: "127.0.0.1:" + h.port,
      push: c.push,
      onStatus: c.onStatus,
    });
    await tick();
    expect(c.events.map((p) => p.event)).toEqual(["snapshot", "TaskStateChanged", "ApprovalRequired"]);
    // 快照帧【没有】seq —— 它不对应任何 events.id，给它编一个是伪造游标（sse.ts 原话）。
    expect(c.events[0]?.seq).toBeUndefined();
    expect(c.events[1]?.seq).toBe(1);
    expect(c.events[2]?.seq).toBe(2);
    expect(stream.cursor).toBe(2);
    expect(c.lastLink()).toEqual({ state: "live" });
    stream.close();
  });

  it("⭐ 一帧被劈成三包 ⇒ 不丢不重", async () => {
    // 这一发【没法】用替身写：替身会一次性把整个 body 交给你，
    // 而真线上「一帧被切在任意字节位置」是常态而不是异常。
    const h = await startHub((_cursor, conn) => {
      conn.write("event: TaskState");
      conn.write("Changed\nid: 7\ndata: {\"a\"");
      conn.write(":1}\n");
      conn.write("\n");
    });
    const c = collector();
    const stream = openEventStream({ token: TOKEN, hubAddress: "127.0.0.1:" + h.port, push: c.push });
    await tick();
    expect(c.events).toEqual([{ seq: 7, event: "TaskStateChanged", data: '{"a":1}' }]);
    expect(stream.cursor).toBe(7);
    stream.close();
  });

  it("两帧在同一次 write 里 ⇒ 两条都推", async () => {
    const h = await startHub((_cursor, conn) => {
      conn.write(
        encodeSseFrame({ event: "A", data: "1", id: "1" }) + encodeSseFrame({ event: "B", data: "2", id: "2" }),
      );
    });
    const c = collector();
    const stream = openEventStream({ token: TOKEN, hubAddress: "127.0.0.1:" + h.port, push: c.push });
    await tick();
    expect(c.events.map((p) => p.event)).toEqual(["A", "B"]);
    stream.close();
  });

  it("`retry:` 帧【不推】给渲染进程", async () => {
    // 它是给自管重连的提示，不是一帧数据（web/public/app.js 里同一句 return）。
    // 推过去的话投影会收到一条 data 是毫秒数的"事件"。
    const h = await startHub((_cursor, conn) => {
      conn.write("retry: 3000\n\n");
      conn.write(encodeSseFrame({ event: "TaskStateChanged", data: "{}", id: "1" }));
    });
    const c = collector();
    const stream = openEventStream({ token: TOKEN, hubAddress: "127.0.0.1:" + h.port, push: c.push });
    await tick();
    expect(c.events.map((p) => p.event)).toEqual(["TaskStateChanged"]);
    stream.close();
  });

  it("多行 data 原样拼回来（不吞换行）", async () => {
    const h = await startHub((_cursor, conn) => {
      conn.write(encodeSseFrame({ event: "NoteAdded", data: '第一行\n第二行', id: "1" }));
    });
    const c = collector();
    const stream = openEventStream({ token: TOKEN, hubAddress: "127.0.0.1:" + h.port, push: c.push });
    await tick();
    expect(c.events[0]?.data).toBe("第一行\n第二行");
    stream.close();
  });
});

describe("② ⭐ 重连必须带上手上最大的 seq", () => {
  it("断线后续订的 cursor = 上次推出去的 seq，而断线期间那几条【收到了】", async () => {
    // 这是本文件存在的全部理由。不带游标的话服务端走 ResumeStream.begin()，
    // 游标取在快照之前 ⇒ 中间那几条永远不投递，而【第一次连接看起来完全正常】。
    const h = await startHub((cursor, conn) => {
      conn.push({ event: "snapshot", data: "[]" }); // 不写 id 键，而不是写 id: undefined
      // 模拟"这个连接能看到的两条"。第二次连接时 cursor 已经是 2，服务端从这里续。
      conn.push({ event: "TaskStateChanged", data: '{"seq_seen":' + cursor + "}", id: String(cursor + 1) });
      conn.push({ event: "TaskStateChanged", data: '{"seq_seen":' + cursor + "}", id: String(cursor + 2) });
      // 推完就断（Hub 重启的形状）
      conn.end();
    });
    const clock = fakeClock();
    const c = collector();
    const stream = openEventStream({
      token: TOKEN,
      hubAddress: "127.0.0.1:" + h.port,
      push: c.push,
      onStatus: c.onStatus,
      setTimeoutImpl: clock.setTimeoutImpl,
    });
    await tick();
    expect(h.cursors).toEqual([0]); // 第一次连接没带游标（本来就没有）
    expect(stream.cursor).toBe(2);

    // 断线 ⇒ 该排上一个重连，而带的游标必须是 2
    expect(clock.waiting).toBe(1);
    const waited = await clock.runOne();
    expect(waited).toBe(reconnectDelayMs(0)); // 曲线出自 contracts，不在这里重抄
    expect(h.cursors, "重连没带游标 ⇒ 断线期间落库的那几条永远不会被投递").toEqual([0, 2]);
    expect(stream.cursor).toBe(4);
    stream.close();
  });

  it("⭐ 快照之后【立刻】断线 ⇒ 重连不带 `?cursor=NaN`", async () => {
    // 快照帧刻意不带 id。若在这里对 undefined 做 Number()，游标会变成 NaN，
    // 而 NaN 一路拼进 `/events?cursor=NaN` ⇒ 服务端 resume() 直接抛。
    // 我第一次给这一格写注释时把它写成「此后每次重连都死在建流上」——
    // 那是【推断】。变异实验 M3 实测打出来的是另一种形状：
    // `NaN > 0` 是 false ⇒ 永远不带游标 ⇒ 每次重连都从头重放一遍。
    // 两种都不对，而真实的那种更安静（看起来只是重复几条，被幂等投影吃掉）。
    // 所以这一发钉的是【观察到的】那一种：只要收到过快照，重连的目标串里
    // 不许出现 NaN，也不许出现 cursor=。
    const h = await startHub((_cursor, conn) => {
      conn.push({ event: "snapshot", data: "[]" });
      conn.end(); // Hub 推完快照就重启
    });
    const clock = fakeClock();
    const c = collector();
    const stream = openEventStream({
      token: TOKEN,
      hubAddress: "127.0.0.1:" + h.port,
      push: c.push,
      onStatus: c.onStatus,
      setTimeoutImpl: clock.setTimeoutImpl,
    });
    await tick();
    expect(c.events.map((p) => p.event)).toEqual(["snapshot"]);
    expect(stream.cursor, "快照帧不许推进游标").toBe(0);
    await clock.runOne();
    expect(h.targets, "重连目标里不许出现 NaN").toEqual(["/events", "/events"]);
    stream.close();
  });

  it("⭐ 推送抛（渲染进程已销毁）⇒ 该条【不计入游标】，下次从它之前续", async () => {
    // 顺序在这里有内容：游标先推进再推 ⇒ 抛掉的那一条既没送到、也不会被重投递，
    // 而重连时带的是【已经推进过的】游标 ⇒ 静默丢一条事件。
    // 变异 M2 就是交换那两行，第一版【全绿】—— 因为我没有一发测试让 push 抛过。
    // 真触发条件很普通：关窗口时主进程还握着这条流。
    const h = await startHub((cursor, conn) => {
      conn.push({ event: "TaskStateChanged", data: '{"n":1}', id: String(cursor + 1) });
      conn.push({ event: "TaskStateChanged", data: '{"n":2}', id: String(cursor + 2) });
    });
    const got: HubEventPayload[] = [];
    const c = collector();
    const stream = openEventStream({
      token: TOKEN,
      hubAddress: "127.0.0.1:" + h.port,
      push: (p) => {
        if (p.event === LINK_EVENT) return; // 链路状态帧不算业务事件
        got.push(p);
        if (p.seq === 2) throw new Error("WebContents 已销毁");
      },
      onStatus: c.onStatus,
    });
    await tick();
    // 抛在 seq=2 上 ⇒ 游标必须停在 1（= 真正送达的位置）
    expect(got.map((p) => p.seq)).toEqual([1, 2]); // 2 确实送出去了，是送【之后】抛的
    expect(stream.cursor, "抛掉的那一条不该算送达").toBe(1);
    // 而且【停下】：往一个没了的对象上继续推、或者装作还在实时，都比停下坏
    expect(stream.closed).toBe(true);
    stream.close();
  });

  it("id 不是非负整数 ⇒ 停下来说一句，而不是带着坏游标继续", async () => {
    // 「就当没看见继续」的两种下场都比停下难查：要么每次重连重放一遍
    // （重复被幂等投影吃掉，功能上看不出来），要么下游把它当有效位置而丢一段。
    const h = await startHub((_cursor, conn) => {
      conn.write("event: TaskStateChanged\nid: not-a-number\ndata: {}\n\n");
      conn.write("event: TaskStateChanged\nid: 9\ndata: {}\n\n");
    });
    const clock = fakeClock();
    const c = collector();
    const stream = openEventStream({
      token: TOKEN,
      hubAddress: "127.0.0.1:" + h.port,
      push: c.push,
      onStatus: c.onStatus,
      setTimeoutImpl: clock.setTimeoutImpl,
    });
    await tick();
    expect(c.events.map((p) => p.seq)).toEqual([]); // 坏帧不推
    expect(c.lastLink()?.state).toBe("down");
    expect(clock.waiting, "协议违例不该当成一次普通断线去重连").toBe(0);
    expect(stream.cursor).toBe(0);
    stream.close();
  });

  it("服务端关闭 ⇒ 状态先是 retrying 而【不是静默】", async () => {
    const h = await startHub((_cursor, conn) => {
      conn.push({ event: "TaskStateChanged", data: "{}", id: "1" });
      conn.end();
    });
    const clock = fakeClock();
    const c = collector();
    const stream = openEventStream({
      token: TOKEN,
      hubAddress: "127.0.0.1:" + h.port,
      push: c.push,
      onStatus: c.onStatus,
      setTimeoutImpl: clock.setTimeoutImpl,
    });
    await tick();
    const link = c.lastLink();
    expect(link?.state).toBe("retrying");
    if (link?.state !== "retrying") throw new Error("类型收窄用（形状已在上一行判过）");
    expect(link.attempt).toBe(1);
    expect(link.delayMs).toBe(reconnectDelayMs(0));
    // 状态【也走推送】：渲染进程只有这一条通道，光调 onStatus 它看不见。
    const linkFrames = c.got.filter((p) => p.event === LINK_EVENT);
    expect(linkFrames.length).toBeGreaterThan(0);
    // 而链路状态帧【永远不带 seq】：带 seq 会把投影游标推到错误位置 ⇒ 静默丢一段
    for (const f of linkFrames) expect(f.seq).toBeUndefined();
    stream.close();
  });

  it("连不上（Hub 没起来）⇒ retrying 而不是抛", async () => {
    // 桌面壳可以比 Hub 先启动，这是最常见的一支。
    // channels.ts 为同一件事写的原话：那一支必须是渲染进程【能自己处理】的形态。
    const clock = fakeClock();
    const c = collector();
    const stream = openEventStream({
      token: TOKEN,
      hubAddress: "127.0.0.1:1", // 保留端口，必然连不上
      push: c.push,
      onStatus: c.onStatus,
      setTimeoutImpl: clock.setTimeoutImpl,
    });
    await tick();
    expect(c.lastLink()?.state).toBe("retrying");
    expect(clock.waiting).toBe(1);
    stream.close();
  });

  it("连续失败按 contracts 的曲线退避，到第八次【放弃并说得出原因】", async () => {
    const clock = fakeClock();
    const c = collector();
    const stream = openEventStream({
      token: TOKEN,
      hubAddress: "127.0.0.1:1",
      push: c.push,
      onStatus: c.onStatus,
      setTimeoutImpl: clock.setTimeoutImpl,
    });
    await tick();
    // 曲线一格一格对：这里比的是【值】而不是"在退避"。
    // 我第一版想写 expect(clock.waits.length).toBeGreaterThan(0)，那种断言
    // 在曲线被改成常数 0 时也成立 —— 而常数 0 就是把退避删掉了。
    for (let i = 0; i < 8; i++) {
      expect(clock.waiting, "第 " + i + " 次应当排着一个重连").toBe(1);
      expect(await clock.runOne(), "第 " + i + " 次退避时长").toBe(reconnectDelayMs(i));
    }
    expect(clock.waiting, "放弃之后不该再排重连").toBe(0);
    const link = c.lastLink();
    expect(link?.state).toBe("down");
    // 放弃必须是【界面说得出的】。contracts 里那条理由对桌面壳同样成立：
    // 装作实时比说「连不上」坏得多，CEO 会基于过期看板做审批决定。
    if (link?.state !== "down") throw new Error("形状已在上一行判过");
    expect(link.reason).toContain("停止重连");
    stream.close();
  });

  it("成功连上一次后 attempt 归零（曲线描述的是【连续】失败）", async () => {
    let first = true;
    const h = await startHub((_cursor, conn) => {
      if (first) {
        first = false;
        conn.end(); // 第一发立刻断
        return;
      }
      conn.push({ event: "TaskStateChanged", data: "{}", id: "1" });
    });
    const clock = fakeClock();
    const c = collector();
    const stream = openEventStream({
      token: TOKEN,
      hubAddress: "127.0.0.1:" + h.port,
      push: c.push,
      onStatus: c.onStatus,
      setTimeoutImpl: clock.setTimeoutImpl,
    });
    await tick();
    expect(stream.attempt).toBe(1); // 断过一次
    await clock.runOne();
    expect(stream.attempt, "连上了就该归零，否则下一次真断线时直接从第 8 档开始退避").toBe(0);
    stream.close();
  });
});

describe("③ 4xx 分界：哪些重试有意义", () => {
  it("401 ⇒ down 而【不重连】（重试永远不会成功）", async () => {
    const h = await startHub(() => {});
    h.failNext(401, '{"error":"unauthorized"}');
    const clock = fakeClock();
    const c = collector();
    const stream = openEventStream({
      token: TOKEN,
      hubAddress: "127.0.0.1:" + h.port,
      push: c.push,
      onStatus: c.onStatus,
      setTimeoutImpl: clock.setTimeoutImpl,
    });
    await tick();
    expect(c.lastLink()?.state).toBe("down");
    expect(clock.waiting, "401 排重连 = 用户会一直点而它永远不成功").toBe(0);
    // 报错体要【带得出去】：换成一句「请求失败」的话，UI 只能显示"请重试"，
    // 而这里的真相是「检查部署 token」。（channels.ts 里同一条判断。）
    // 收窄【必须落在一个 const 上】：c.lastLink() 是函数调用，
    // 每调一次 TS 都重新当成未知返回值，前一句的判型不留到后一句。
    const down = c.lastLink();
    if (down?.state !== "down") throw new Error("上一行已判过形状");
    expect(down.reason).toContain("token");
    stream.close();
  });

  it("500 ⇒ 重连（Hub 正在重启，正是退避曲线为它准备的那一段）", async () => {
    const h = await startHub(() => {});
    h.failNext(500, "restarting");
    const clock = fakeClock();
    const c = collector();
    const stream = openEventStream({
      token: TOKEN,
      hubAddress: "127.0.0.1:" + h.port,
      push: c.push,
      onStatus: c.onStatus,
      setTimeoutImpl: clock.setTimeoutImpl,
    });
    await tick();
    expect(c.lastLink()?.state).toBe("retrying");
    expect(clock.waiting).toBe(1);
    stream.close();
  });

  it("429 / 408 重连，400 / 404 不重连", async () => {
    for (const [status, shouldRetry] of [
      [429, true],
      [408, true],
      [400, false],
      [404, false],
      [403, false],
    ] as const) {
      const h = await startHub(() => {});
      h.failNext(status, "{}");
      const clock = fakeClock();
      const c = collector();
      const stream = openEventStream({
        token: TOKEN,
        hubAddress: "127.0.0.1:" + h.port,
        push: c.push,
        onStatus: c.onStatus,
        setTimeoutImpl: clock.setTimeoutImpl,
      });
      await tick();
      expect(clock.waiting, status + (shouldRetry ? " 该重连" : " 不该重连")).toBe(shouldRetry ? 1 : 0);
      expect(c.lastLink()?.state).toBe(shouldRetry ? "retrying" : "down");
      stream.close();
    }
  });
});

describe("④ 签名真的到了线上", () => {
  it("⭐ 带游标的重连【过得了 hub 自己的验签】", async () => {
    // 这一发挡的是那一整族「只有断线续订 401」。
    // `/events?cursor=N` 是这条路上唯一带 query 的请求 —— 而 query 正是
    // 签名最容易对不上的地方（auth.ts 与 dev-server.ts 各记过一次同一个死法：
    // 「所有带 query 的请求 401，而普通 JSON 请求全好」）。
    // 服务器那侧用的是 hub 的 verifyRequest，所以这里绿【不是】我对上了我自己的抄件。
    const h = await startHub((cursor, conn) => {
      conn.push({ event: "TaskStateChanged", data: "{}", id: String(cursor + 1) });
      conn.end();
    });
    const clock = fakeClock();
    const c = collector();
    const stream = openEventStream({
      token: TOKEN,
      hubAddress: "127.0.0.1:" + h.port,
      push: c.push,
      onStatus: c.onStatus,
      setTimeoutImpl: clock.setTimeoutImpl,
    });
    await tick();
    await clock.runOne();
    // 两次连接【都】收到了帧 ⇒ 两次都过了验签（401 的话一条帧都收不到）
    expect(h.cursors).toEqual([0, 1]);
    expect(c.events.filter((p) => p.event === "TaskStateChanged").length).toBe(2);
    expect(h.targets).toEqual(["/events", "/events?cursor=1"]);
    stream.close();
  });

  it("token 不对 ⇒ 服务端验签失败，一帧都收不到", async () => {
    const h = await startHub((_cursor, conn) => {
      conn.push({ event: "TaskStateChanged", data: "{}", id: "1" });
    });
    const clock = fakeClock();
    const c = collector();
    const stream = openEventStream({
      token: "wrong-token-entirely",
      hubAddress: "127.0.0.1:" + h.port,
      push: c.push,
      onStatus: c.onStatus,
      setTimeoutImpl: clock.setTimeoutImpl,
    });
    await tick();
    expect(c.events).toEqual([]);
    expect(c.lastLink()?.state).toBe("down"); // 401 ⇒ 不重连
    stream.close();
  });

  it("对照：验签这道门【真的会拦】（否则上一条是恒绿的）", async () => {
    // 少了这一发，「token 不对收不到帧」有可能只是我的服务器根本没验签。
    // 这一发【跳过验签】再走同一个 token，必须【能】收到帧。
    const h = await startHub((_cursor, conn) => {
      conn.push({ event: "TaskStateChanged", data: "{}", id: "1" });
    });
    h.skipAuthOnce();
    const c = collector();
    const stream = openEventStream({ token: "wrong-token-entirely", hubAddress: "127.0.0.1:" + h.port, push: c.push });
    await tick();
    expect(c.events.map((p) => p.event)).toEqual(["TaskStateChanged"]);
    stream.close();
  });
});

describe("⑤ 生命周期", () => {
  it("close() 之后【不再重连】也不推", async () => {
    const h = await startHub((_cursor, conn) => {
      conn.push({ event: "TaskStateChanged", data: "{}", id: "1" });
      conn.end();
    });
    const clock = fakeClock();
    const c = collector();
    const stream = openEventStream({
      token: TOKEN,
      hubAddress: "127.0.0.1:" + h.port,
      push: c.push,
      onStatus: c.onStatus,
      setTimeoutImpl: clock.setTimeoutImpl,
    });
    await tick();
    expect(clock.waiting).toBe(1);
    stream.close();
    expect(stream.closed).toBe(true);
    // 退订必须【真的取消】那个定时器。留着的话：React 组件重挂十次
    // 就留下十条活着的流，而症状是「每个事件被处理十次」——
    // 幂等投影会按 seq 吃掉重复，于是功能上看不出来，只在内存上长（preload/api.ts 同判）。
    expect(clock.waiting, "close() 没取消已排的重连 ⇒ 泄漏一条活流").toBe(0);
    const before = c.got.length;
    // 这一处【只能】真的等一会儿：断言的是「什么都没再来」，没有条件可轮询。
    // 所以用 settle 而不是 tick —— 而它的意义也仅此而已（有意义的判据是
    // 上一行那句 clock.waiting === 0：没有排着的定时器，就没有任何代码路径能再推）。
    await settle();
    expect(c.got.length).toBe(before);
  });

  it("close() 幂等（调两次不抛）", async () => {
    const h = await startHub(() => {});
    const c = collector();
    const stream = openEventStream({ token: TOKEN, hubAddress: "127.0.0.1:" + h.port, push: c.push });
    await tick();
    stream.close();
    expect(() => stream.close()).not.toThrow();
  });

  it("hubAddress 形状不对 ⇒ 构造时就抛，不拼一个必然连不上的地址", () => {
    const c = collector();
    // 与 signedFetch 的空 token 同一条纪律：配置缺失要说得出是配置缺失，
    // 不要以「Hub 没起来」的形状出现（那一支桌面壳每天都在走）。
    expect(() => openEventStream({ token: TOKEN, hubAddress: "", push: c.push })).toThrow(/host:port/);
    expect(() => openEventStream({ token: TOKEN, hubAddress: "localhost", push: c.push })).toThrow(/host:port/);
    expect(() => openEventStream({ token: TOKEN, hubAddress: "localhost:abc", push: c.push })).toThrow(/host:port/);
  });

  it("initialCursor 让壳【冷启动就续订】（渲染进程重挂后不该从头重放）", async () => {
    const h = await startHub((cursor, conn) => {
      conn.push({ event: "TaskStateChanged", data: "{}", id: String(cursor + 1) });
    });
    const c = collector();
    const stream = openEventStream({
      token: TOKEN,
      hubAddress: "127.0.0.1:" + h.port,
      push: c.push,
      initialCursor: 57,
    });
    await tick();
    expect(h.cursors).toEqual([57]);
    expect(c.events[0]?.seq).toBe(58);
    stream.close();
  });
});
