/**
 * 主进程接线（main/wire.ts）—— 三块已测过的东西接起来之后，接缝还在不在。
 *
 * ── 这一发不为"覆盖率"，为的是三类只有【接起来】才看得见的失效 ──────
 *  ① 通道路由漏一条：ipc-surface 加了 invoke 通道而这里没接 ⇒ 渲染进程
 *     调到一个没人应答的通道。这一发从 CHANNEL_SPECS 现筛名单再逐个真的调一遍。
 *  ② 生命周期：窗口关了而流还活着 / start() 调两次造出两条活流 /
 *     handler 握着已销毁的 sender 继续往 Hub 发【真的有副作用的】请求。
 *  ③ fetchImpl 到底兼不兼容 —— 这一发【不注入替身】，
 *     对着一台真 node:http 服务器发真请求。
 *     为什么：signed-fetch.ts 文件头那条理由（"兼容这件事必须由装配那一次赋值去证"）
 *     在这里才是唯一一次被证的。之前 signed-fetch 的测试用的是抓请求头的桩，
 *     它证的是【签名】，证不了【这个 fetchImpl 真的能把请求发出去】。
 *
 * electron 那三样（ipcMain / webContents / 窗口生命周期）在本文件里是【手搓的替身】，
 * 而那是可以的：它们的形状就三个方法，而【真 electron 的语义】本来也不在这一格里
 * （那要等依赖到位，0052 §7 第 1 条记的就是那一句）。
 */
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CHANNEL_SPECS } from "../../packages/desktop/src/ipc-surface.js";
import { EVENT_CHANNEL } from "../../packages/desktop/src/preload/api.js";
import { LINK_EVENT } from "../../packages/desktop/src/main/event-stream.js";
import { invokeChannels, nodeHttpFetch, wireMain, type IpcMainLike, type SenderLike } from "../../packages/desktop/src/main/wire.js";
import { verifyRequest } from "../../packages/hub/src/http/auth.js";
import { encodeSseFrame } from "../../packages/contracts/src/api.js";

const TOKEN = "wire-test-token-0123456789";

/* ───────────────────────── electron 那一侧的替身 ───────────────────────── */

interface FakeIpc {
  readonly handlers: Map<string, (e: unknown, a: unknown) => Promise<unknown>>;
  readonly removed: string[];
  ipcMain: IpcMainLike;
}
function fakeIpc(): FakeIpc {
  const handlers = new Map<string, (e: unknown, a: unknown) => Promise<unknown>>();
  const removed: string[] = [];
  return {
    handlers,
    removed,
    ipcMain: {
      handle: (channel, h) => {
        if (handlers.has(channel)) throw new Error("通道 " + channel + " 被注册了两次");
        handlers.set(channel, h);
      },
      removeHandler: (channel) => {
        removed.push(channel);
        handlers.delete(channel);
      },
    },
  };
}

/**
 * @param mode 【throws】= 销毁后 send 抛（Electron 某些版本的行为）；
 *   【silentlyDrops】= 销毁后 send 【静默不抛】。
 *
 * 两种都要有，因为 wire.ts 里那道 isDestroyed 闸门【只在第二种下才有内容】：
 * 第一种下 send 自己会抛，event-stream 那边把抛当终止条件，于是把闸门删掉
 * 也观察不到区别（我实测 W6 那个变异在第一种模式下 fail=0 —— 那是
 * 【等价变异】，不是漏测，而区分这两者的唯一办法就是把替身换成更真那种）。
 * 真实世界里"send 不抛而只是丢掉"是完全可能的（页面刚导航走、
 * 或者 webContents 处于中间态），那一支才是这道闸门为它准备的那一支。
 */
function fakeSender(mode: "throws" | "silentlyDrops" = "throws") {
  let dead = false;
  const sent: { channel: string; payload: unknown }[] = [];
  return {
    sent,
    sender: {
      send: (channel, payload) => {
        if (dead) {
          if (mode === "throws") throw new Error("webContents.send: 对象已销毁");
          return; // 静默丢掉：什么都不发生
        }
        sent.push({ channel, payload });
      },
      isDestroyed: () => dead,
    },
    destroy: () => {
      dead = true;
    },
  } as { sender: SenderLike; sent: { channel: string; payload: unknown }[]; destroy(): void };
}

/* ─────────────────────── 一台真 Hub 形状的服务器 ─────────────────────── */

interface Served {
  readonly method: string;
  readonly target: string;
  readonly body: string;
}
let servers: { srv: Server; close(): Promise<void> }[] = [];

/**
 * 服务器那侧【拿 hub 自己的 verifyRequest 当门】。
 * 于是这一发绿意味着：desktop 签出来的请求，hub 的验签函数判它过 ——
 * 而中间那一段（fetchImpl 拼 host/port/path、body 怎么 end）是真跑过的。
 */
async function startServer(
  onReq: (s: Served) => { status: number; body: string },
  opts: { auth?: boolean } = {},
): Promise<{ address: string; requests: Served[] }> {
  const requests: Served[] = [];
  const srv = createServer((req, res) => {
    const target = req.url ?? "/";
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      if (opts.auth !== false) {
        const v = verifyRequest({
          token: TOKEN,
          method: req.method ?? "GET",
          target,
          body: raw,
          headers: req.headers as Record<string, string | undefined>,
          now: Date.now(),
        });
        if (v.ok !== true) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized: " + v.code }));
          return;
        }
      }
      requests.push({ method: req.method ?? "GET", target, body: raw });
      const r = onReq({ method: req.method ?? "GET", target, body: raw });
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(r.body);
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  const rec = { srv, close: () => new Promise<void>((r) => srv.close(() => r())) };
  servers.push(rec);
  return { address: "127.0.0.1:" + port, requests };
}

/**
 * 一台【挂着不结束】的事件流服务器：能数连接条数、能按需推帧。
 *
 * 为什么要有它而不是全用上面那个"一次写完就 end"的服务器：
 * W4 / W6 / W8 三个变异（start 不幂等、推送不查销毁、stop 不关流）
 * 在"连完就断"的服务器下【全部 fail=0】—— 因为我原来的那几发断言
 * （streamCursor 相等、running=false）在变异后【照样成立】。
 * 那是三条【只会绿的断言】，而它们看起来完全像在测生命周期。
 * 要测这三样，服务器必须【能观察连接条数】与【能继续推】。
 */
async function startStreamServer(opts: { skipAuth?: boolean } = {}): Promise<{
  address: string;
  connections: number;
  /** 被【客户端】关掉的连接条数（服务端 res 的 close 事件）。 */
  closed: number;
  /** 对当前活着的那条连接推一帧。 */
  emit(event: string, data: string, id: string): void;
  /** 服务端主动断掉当前连接。 */
  dropCurrent(): void;
  readonly targets: string[];
}> {
  const api = {
    address: "",
    connections: 0,
    closed: 0,
    targets: [] as string[],
    emit: (_e: string, _d: string, _i: string) => {
      throw new Error("没有活的连接");
    },
    dropCurrent: () => {
      throw new Error("没有活的连接");
    },
  };
  let current: import("node:http").ServerResponse | null = null;
  const srv = createServer((req, res) => {
    const target = req.url ?? "/";
    api.targets.push(target);
    if (opts.skipAuth !== true) {
      const v = verifyRequest({
        token: TOKEN,
        method: req.method ?? "GET",
        target,
        body: "",
        headers: req.headers as Record<string, string | undefined>,
        now: Date.now(),
      });
      if (v.ok !== true) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
    }
    api.connections += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    current = res;
    api.emit = (event, data, id) => {
      current?.write(encodeSseFrame({ event, data, id }));
    };
    api.dropCurrent = () => {
      res.end();
      if (current === res) current = null;
    };
    res.on("close", () => {
      // 客户端 destroy() 会走到这里。stop() 那一条【真的把连接关掉了】
      // 必须由这一维观察，而不是由 handle.closed 观察 —— 后者读的是
      // 我自己那个 boolean，变异把 close() 删掉它照样是 false（W8 fail=0 的成因）。
      api.closed += 1;
      if (current === res) current = null;
    });
    // 刻意【不 end】：真 SSE 就是一直挂着
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  api.address = "127.0.0.1:" + port;
  // close 里必须先 closeAllConnections()：SSE 那条连接是【挂着不结束】的，
  // 而 srv.close() 的语义是「等所有连接结束」⇒ 它会一直等。
  // 变异实验里这一发真的挂满 240 秒被我掐掉了（W6：流没关 ⇒ 收尾永远等不到），
  // 症状是"测试卡住"而不是"测试红"，那比红难查得多。
  servers.push({
    srv,
    close: async () => {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    },
  });
  return api;
}

afterEach(async () => {
  const closing = servers;
  servers = [];
  for (const s of closing) {
    try {
      await s.close();
    } catch {
      /* 已关 */
    }
  }
});

const tick = async (turns = 15): Promise<void> => {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setImmediate(r));
};
const settle = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 手动时钟 + 手动推流口：事件流那一段不需要真 socket（它自己的文件里有真 socket 的发）。 */
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
    runOne(): number {
      const p = pending.shift();
      if (p === undefined) throw new Error("没有待调度项");
      p.fn();
      return p.ms;
    },
    get waiting(): number {
      return pending.length;
    },
  };
}

describe("① 通道路由：一条不漏、一条不多", () => {
  it("invokeChannels() = CHANNEL_SPECS 里全部 invoke 通道，且【不含】推送通道", () => {
    const fromSpec = CHANNEL_SPECS.filter((s) => s.kind === "invoke").map((s) => s.channel);
    expect(invokeChannels()).toEqual(fromSpec);
    // 单独钉一次推送通道不在里面：它在 CHANNEL_SPECS 里【确实存在】（kind: "push"），
    // 所以"筛了 invoke"这件事必须有一个反例在场才算数。
    expect(fromSpec).not.toContain("hub:subscribeEvents");
    expect(CHANNEL_SPECS.map((s) => s.channel)).toContain("hub:subscribeEvents");
  });

  it("每一条 invoke 通道都真的注册了 handler，并且【能调通】", async () => {
    const srv = await startServer(() => ({ status: 200, body: '{"ok":true}' }));
    const ipc = fakeIpc();
    const s = fakeSender();
    const wire = wireMain({ token: TOKEN, hubAddress: srv.address, ipcMain: ipc.ipcMain, sender: s.sender });
    expect([...ipc.handlers.keys()].sort()).toEqual(invokeChannels().sort());

    const args: Record<string, unknown> = {
      "hub:createTask": { idea: "做个 AI 笔记应用" },
      "hub:listTasks": undefined,
      "hub:getTask": { taskId: "t-1" },
      "hub:listApprovals": undefined,
      "hub:decideApproval": { approvalId: "c-1", resume: "approve" },
      "hub:listBindings": undefined,
      "hub:getOrg": undefined,
    };
    for (const ch of invokeChannels()) {
      const h = ipc.handlers.get(ch);
      if (h === undefined) throw new Error(ch + " 没注册 handler");
      const r = (await h({}, args[ch])) as { ok: boolean; error?: { message: string } };
      // 调不通的两种形状都在这里：没注册（上一句抛）、签名不对（ok:false + 401）
      expect(r.ok, ch + " 调不通：" + (r.error?.message ?? "")).toBe(true);
    }
    wire.stop();
    wire.unregister();
  });

  it("⭐ 走完整条路之后，Hub 那侧看到的是【预期的方法 + 路径】", async () => {
    // 这一发不重复 signed-fetch 的签名对账，它钉的是【接线之后】的端点没串位：
    // 比如 getTask 与 decideApproval 都是 POST/GET 带一个 id，接错的可能性是真实的。
    const srv = await startServer(() => ({ status: 200, body: "{}" }));
    const ipc = fakeIpc();
    const s = fakeSender();
    const wire = wireMain({ token: TOKEN, hubAddress: srv.address, ipcMain: ipc.ipcMain, sender: s.sender });
    const call = async (ch: string, a: unknown): Promise<void> => {
      const h = ipc.handlers.get(ch);
      if (h === undefined) throw new Error(ch + " 没注册");
      await h({}, a);
    };
    await call("hub:createTask", { idea: "x" });
    await call("hub:listTasks", undefined);
    await call("hub:getTask", { taskId: "t-9" });
    await call("hub:listApprovals", { status: "pending", limit: 5 });
    // resume 用的是 contracts 的 RESUME_VALUES 里的合法值。
    // 我第一版这里写的是 "reject"，而它【不在】那三个值里 ⇒ checkArgs 直接拒了
    // 这次调用、一发请求都没发出去 ⇒ 期望的那一行永远等不到。
    // 那是我的测试错了，而它错得【很有参考价值】：参数闸门确实拦住了。
    await call("hub:decideApproval", { approvalId: "c-9", resume: "reject_with_comment", note: "缺测试" });
    await call("hub:getOrg", undefined);
    expect(srv.requests.map((r) => r.method + " " + r.target)).toEqual([
      "POST /tasks",
      "GET /tasks",
      "GET /tasks/t-9",
      "GET /approvals?status=pending&limit=5",
      "POST /approvals/c-9",
      "GET /org",
    ]);
    wire.stop();
    wire.unregister();
  });
});

describe("② 生命周期", () => {
  it("⭐ start() 调两次 ⇒ 服务器上【只有一条】连接", async () => {
    // 组件重挂、或者两处都调了一次 start —— 两条活流的后果是
    // 每个事件被处理两遍，而幂等投影按 seq 吃掉重复 ⇒ 功能上看不出来，只在内存上长。
    // ⚠ 这一发【数的是服务器看到的连接条数】。我原来那版断的是
    // "两次 start 之间 streamCursor 没变" + 最后 running=false ——
    // 变异 W4（删掉那句幂等 return）之后【两条断言照样成立】，
    // 于是它是一条只会绿的断言，而它看起来完全像在测幂等。
    const srv = await startStreamServer();
    const ipc = fakeIpc();
    const s = fakeSender();
    const clock = fakeClock();
    const wire = wireMain({
      token: TOKEN,
      hubAddress: srv.address,
      ipcMain: ipc.ipcMain,
      sender: s.sender,
      setTimeoutImpl: clock.setTimeoutImpl,
    });
    wire.start();
    await tick();
    wire.start();
    wire.start();
    await settle();
    expect(srv.connections, "start() 调了三次而服务器上看到不止一条连接 ⇒ 多条活流").toBe(1);
    wire.stop();
    wire.unregister();
  });

  it("⭐ stop() 之后服务器【真的少了那条连接】（不是只看了我内部的 boolean）", async () => {
    // 变异 W8（stop() 不再 close 那条流）在我原来那版断言下 fail=0：
    // `wire.running` 读的是 wireMain 自己那个 `stream !== null`，
    // 与底层 socket 有没有关【是两件事】。读自己的状态字段去证明
    // "外部资源被释放了"，是本仓记过多次的那种自我确认。
    const srv = await startStreamServer();
    const ipc = fakeIpc();
    const s = fakeSender();
    const clock = fakeClock();
    const wire = wireMain({
      token: TOKEN,
      hubAddress: srv.address,
      ipcMain: ipc.ipcMain,
      sender: s.sender,
      setTimeoutImpl: clock.setTimeoutImpl,
    });
    wire.start();
    await tick();
    expect(srv.connections).toBe(1);
    expect(srv.closed).toBe(0);
    wire.stop();
    await settle();
    expect(srv.closed, "stop() 没真的关连接 ⇒ 窗口关了而 Hub 上挂着一条订阅").toBe(1);
    expect(wire.running).toBe(false);
    wire.unregister();
  });

  it("⭐ 页面【静默丢推送】那种销毁 ⇒ 流必须停（不靠 send 抛）", async () => {
    // 这是 W6 那一发。它的形状是：webContents 已经不在了而 send 不抛，
    // 只是把东西丢掉。少那道闸门时，event-stream 会【一直读、一直丢】，
    // 而任何一个"看有没有异常"的判据都是绿的。
    // 我第一版【只有】throws 那种替身，于是 W6 fail=0 ——
    // 那一度被我读成"这条变异等价"，实际是替身太假：
    // 真 fetch/webContents 世界里"不抛而丢掉"是完全可能的一支。
    const srv = await startStreamServer();
    const ipc = fakeIpc();
    const s = fakeSender("silentlyDrops");
    const clock = fakeClock();
    const wire = wireMain({
      token: TOKEN,
      hubAddress: srv.address,
      ipcMain: ipc.ipcMain,
      sender: s.sender,
      setTimeoutImpl: clock.setTimeoutImpl,
    });
    wire.start();
    await tick();
    srv.emit("TaskStateChanged", '{"n":1}', "1");
    await tick();
    expect(wire.streamCursor).toBe(1); // 先证明这条流【活着且在推进】
    s.destroy();
    // 页面没了之后服务端继续推 ⇒ 闸门必须把流【关掉】
    srv.emit("TaskStateChanged", '{"n":2}', "2");
    await settle();
    expect(srv.closed, "销毁后流没关 ⇒ 主进程一直读、一直丢，而没有任何地方看得见").toBe(1);
    expect(wire.running).toBe(false);
    wire.unregister();
  });

  it("stop() / start() 可反复调，stop() 之后 running=false", async () => {
    const srv = await startServer(() => ({ status: 200, body: "{}" }));
    const ipc = fakeIpc();
    const s = fakeSender();
    const clock = fakeClock();
    const wire = wireMain({
      token: TOKEN,
      hubAddress: srv.address,
      ipcMain: ipc.ipcMain,
      sender: s.sender,
      setTimeoutImpl: clock.setTimeoutImpl,
    });
    expect(wire.running).toBe(false); // 没 start 之前
    wire.start();
    expect(wire.running).toBe(true);
    wire.stop();
    wire.stop();
    expect(wire.running).toBe(false);
    wire.start();
    expect(wire.running).toBe(true);
    wire.stop();
    wire.unregister();
  });

  it("⭐ 窗口销毁之后【不再往 Hub 发】invoke（有副作用的那一发尤其）", async () => {
    const srv = await startServer(() => ({ status: 200, body: "{}" }));
    const ipc = fakeIpc();
    const s = fakeSender();
    const clock = fakeClock();
    const wire = wireMain({
      token: TOKEN,
      hubAddress: srv.address,
      ipcMain: ipc.ipcMain,
      sender: s.sender,
      setTimeoutImpl: clock.setTimeoutImpl,
    });
    s.destroy();
    const h = ipc.handlers.get("hub:createTask");
    if (h === undefined) throw new Error("没注册");
    const r = (await h({}, { idea: "x" })) as { ok: boolean; error?: { code: string } };
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("unreachable");
    // 这一句才是本发的内容：请求【一条都没到 Hub】。
    // 少了这道闸门，"窗口关了"会让一次建任务【真的发生】而屏幕上什么都没有。
    expect(srv.requests).toEqual([]);
    wire.stop();
    wire.unregister();
  });

  it("unregister() 摘掉每一条 handler", async () => {
    const srv = await startServer(() => ({ status: 200, body: "{}" }));
    const ipc = fakeIpc();
    const s = fakeSender();
    const wire = wireMain({ token: TOKEN, hubAddress: srv.address, ipcMain: ipc.ipcMain, sender: s.sender });
    wire.unregister();
    expect(ipc.handlers.size).toBe(0);
    expect(ipc.removed.sort()).toEqual(invokeChannels().sort());
    wire.stop();
  });

  it("⭐ 事件推给渲染进程时【用的是 EVENT_CHANNEL】，且业务帧带 seq、链路帧不带", async () => {
    // 通道名写错不会报错，只会【什么都收不到】：send 到一个没人听的通道是合法的。
    const ipc = fakeIpc();
    const s = fakeSender();
    const clock = fakeClock();
    // 这里【不】起服务器：这一发看的是【推出去的形状】，而"连不上"正是
    // 最该有形状的那一支。真帧的推送形状在 event-stream.test.ts 里用真 socket 测过。
    const wire = wireMain({
      token: TOKEN,
      hubAddress: "127.0.0.1:1", // 连不上也没关系：这一发要看的是【推出去的形状】，用下面手推
      ipcMain: ipc.ipcMain,
      sender: s.sender,
      setTimeoutImpl: clock.setTimeoutImpl,
    });
    wire.start();
    await tick();
    // 至少有过一次链路状态推送（retrying），而且走的是 EVENT_CHANNEL
    expect(s.sent.length, "连不上的时候界面必须收得到『连不上』").toBeGreaterThan(0);
    for (const m of s.sent) expect(m.channel).toBe(EVENT_CHANNEL);
    const payload = s.sent[0]?.payload as { event: string; seq?: number; data: string };
    expect(payload.event).toBe(LINK_EVENT);
    expect(payload.seq, "链路状态帧带 seq 会把投影游标推到错误位置").toBeUndefined();
    wire.stop();
    wire.unregister();
  });

  it("渲染进程销毁之后，事件流【停下】而不是继续读继续丢", async () => {
    // 一条长期流停不下来的后果是：一直读、一直丢，而没有任何地方看得见。
    const ipc = fakeIpc();
    const s = fakeSender();
    const clock = fakeClock();
    const wire = wireMain({
      token: TOKEN,
      hubAddress: "127.0.0.1:1",
      ipcMain: ipc.ipcMain,
      sender: s.sender,
      setTimeoutImpl: clock.setTimeoutImpl,
    });
    wire.start();
    await tick();
    s.destroy();
    const waitingBefore = clock.waiting;
    wire.stop(); // 装配里窗口 close 会调它；这里也验一次不抛
    await settle();
    expect(wire.running).toBe(false);
    expect(clock.waiting <= waitingBefore + 1).toBe(true);
    wire.unregister();
  });
});

describe("③ fetchImpl 是真发得出请求的", () => {
  it("nodeHttpFetch 把 method / path+query / body 原样送到", async () => {
    // 这一发存在的理由见文件头 ③：之前所有签名测试都用的是【抓请求头的桩】，
    // 它证不了 FetchLike 与 node:http 真的兼容（兼容这件事必须有人真的发一次）。
    const srv = await startServer(() => ({ status: 201, body: '{"id":"t-1"}' }), { auth: false });
    const res = await nodeHttpFetch("http://" + srv.address + "/tasks?x=1&y=%E4%B8%AD", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"idea":"中文的想法"}',
    });
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('{"id":"t-1"}');
    const got = srv.requests[0];
    expect(got?.method).toBe("POST");
    // query 里那个【未预编码】的中文必须原样到（不是被 decodeURIComponent 之后再发）
    expect(got?.target).toBe("/tasks?x=1&y=%E4%B8%AD");
    expect(got?.body).toBe('{"idea":"中文的想法"}');
  });

  it("GET 不带 body 键 ⇒ 线上不会有 content-length 的空 body 之争", async () => {
    const srv = await startServer(() => ({ status: 200, body: "[]" }), { auth: false });
    const res = await nodeHttpFetch("http://" + srv.address + "/tasks", {
      method: "GET",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(srv.requests[0]?.body).toBe("");
  });

  it("连不上 ⇒ reject，而 dispatch 把它翻成 unreachable（不是 500）", async () => {
    // 桌面壳比 Hub 先起是【常态】，这一支每天都在走。
    // 三态里那一态存在的理由（channels.ts 文件头）：500 在 UI 上长成"操作失败请重试"，
    // 而重试在这里永远不成功。
    const ipc = fakeIpc();
    const s = fakeSender();
    const clock = fakeClock();
    const wire = wireMain({
      token: TOKEN,
      hubAddress: "127.0.0.1:1",
      ipcMain: ipc.ipcMain,
      sender: s.sender,
      setTimeoutImpl: clock.setTimeoutImpl,
    });
    const h = ipc.handlers.get("hub:listTasks");
    if (h === undefined) throw new Error("没注册");
    const r = (await h({}, undefined)) as { ok: boolean; error?: { code: string; status?: number } };
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("unreachable");
    expect(r.error?.status, "unreachable 不该带 status：那是『没有 HTTP 响应』的意思").toBeUndefined();
    wire.stop();
    wire.unregister();
  });

  it("4xx 的报错体【一路带到】渲染进程（不在中途换成『请求失败』）", async () => {
    const srv = await startServer(() => ({ status: 422, body: '{"error":"idea 超过 4000 字符"}' }));
    const ipc = fakeIpc();
    const s = fakeSender();
    const clock = fakeClock();
    const wire = wireMain({
      token: TOKEN,
      hubAddress: srv.address,
      ipcMain: ipc.ipcMain,
      sender: s.sender,
      setTimeoutImpl: clock.setTimeoutImpl,
    });
    const h = ipc.handlers.get("hub:createTask");
    if (h === undefined) throw new Error("没注册");
    const r = (await h({}, { idea: "x" })) as { ok: boolean; error?: { code: string; status?: number; message: string } };
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("hub_error");
    expect(r.error?.status).toBe(422);
    expect(r.error?.message).toContain("4000");
    wire.stop();
    wire.unregister();
  });

  it("SSE 那种【挂着不结束】的响应，nodeHttpFetch 不会返回（它只能用于 invoke）", async () => {
    // 这一发是给「那为什么不复用这一个函数去读事件流」那句问题留的【证据】。
    // 光写注释说"它不行"是本仓记过至少三次的恒绿装饰 —— 注释不随漂移变红。
    // 所以这里真的挂一条流：帧已经在线上了，而 fetchImpl 还没 resolve。
    // 哪天有人让事件流走 fetchImpl，这一发会红，而红的那句就是这个原因本身。
    /**
     * 用【一个对象装】而不是 `let release: (() => void) | null = null`。
     * 后者在这台 tsc 上会变成 never：只在回调里赋过值，而控制流分析认为
     * 声明之后到 `release?.()` 之间没有任何赋值 ⇒ 类型收窄到 never ⇒
     * "This expression is not callable"。装进对象属性就没这个问题
     * （属性不参与这种收窄）。
     */
    const gate: { release?: () => void } = {};
    const srv = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(encodeSseFrame({ event: "TaskStateChanged", data: "{}", id: "1" }));
      // 刻意不 end —— 真 SSE 就是这样一直挂着
      gate.release = () => {
        res.end();
      };
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    // 同 startStreamServer：这条也刻意不 end，收尾必须强制断连接
    servers.push({
      srv,
      close: async () => {
        srv.closeAllConnections();
        await new Promise<void>((r) => srv.close(() => r()));
      },
    });

    const p = nodeHttpFetch("http://127.0.0.1:" + port + "/events", { method: "GET", headers: {} });
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await settle();
    expect(settled, "它不该在流没结束时就返回 ⇒ 红了说明有人把它用到了事件流上").toBe(false);
    gate.release?.();
    const res = await p;
    expect(res.status).toBe(200);
    // 而 end 之后它把攒下的整段给出 —— 这正是"缓冲"的形状，也是事件流不能要的形状
    expect(await res.text()).toContain("event: TaskStateChanged");
  });
});
