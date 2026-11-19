/**
 * `hub:eventsReady` 握手（0052 §7 第 3 条的落地）—— 主进程【何时可以开流】。
 *
 * ── 这一组钉的失效只有一个形状 ──────────────────────────────────────
 * 事件流早于渲染进程的监听者存在：webContents.send 在页面还没挂上监听器时
 * 【丢弃而不是排队】，而事件流的游标【已经前进了】—— 主进程以为送了、
 * 渲染进程从没收到，头几帧就这么没了（wire.ts 文件头时序 ②）。
 * 之前这一格靠注释约定（"start() 在窗口 load 完之后由胶水调"）保证，
 * 而那段胶水恰好是不写的另一半（0052 §7 第 1 条），所以约定等于没有。
 * 现在开流的闸门是一条注册在 EVENTS_READY_CHANNEL 上的 handler：
 * 渲染进程（preload 的 notifyEventsReady）挂好监听 invoke 它，被调那一刻才开流。
 *
 * ⚠ 这一组测的是【主进程侧】的次序：ready 到达之前【零连接】、到达之后才有一条。
 * 渲染侧「先 onHubEvent 再 notifyEventsReady」的调用次序不在这里（那要真页面），
 * preload 侧的方法形状与通道名在 ipc-surface.test.ts 钉，各管各的一侧。
 *
 * electron 三样仍是手搓替身（同 wire.test.ts 的立场：形状就三个方法）。
 */
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { EVENTS_READY_CHANNEL } from "../../packages/desktop/src/preload/api.js";
import { type IpcMainLike, type SenderLike, invokeChannels, wireMain } from "../../packages/desktop/src/main/wire.js";
import { verifyRequest } from "../../packages/hub/src/http/auth.js";

const TOKEN = "events-ready-token-0123456789";

interface FakeIpc {
  readonly handlers: Map<string, (e: unknown, a: unknown) => Promise<unknown>>;
  ipcMain: IpcMainLike;
}
function fakeIpc(): FakeIpc {
  const handlers = new Map<string, (e: unknown, a: unknown) => Promise<unknown>>();
  return {
    handlers,
    ipcMain: {
      handle: (channel, h) => {
        if (handlers.has(channel)) throw new Error("通道 " + channel + " 被注册了两次");
        handlers.set(channel, h);
      },
      removeHandler: (channel) => {
        handlers.delete(channel);
      },
    },
  };
}

function fakeSender() {
  let dead = false;
  const sent: { channel: string; payload: unknown }[] = [];
  return {
    sent,
    sender: {
      send: (channel: string, payload: unknown) => {
        if (dead) return; // 静默丢掉那种（silentlyDrops），本文件只关心开没开流
        sent.push({ channel, payload });
      },
      isDestroyed: () => dead,
    } as SenderLike,
    destroy: () => {
      dead = true;
    },
  };
}

/** 挂着不结束的事件流服务器（同 wire.test.ts 那张：能数连接、能不 end）。 */
async function startStreamServer(): Promise<{
  address: string;
  connections: number;
  closed: number;
}> {
  const api = { address: "", connections: 0, closed: 0 };
  const srv: Server = createServer((req, res) => {
    const target = req.url ?? "/";
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
    api.connections += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.on("close", () => {
      api.closed += 1;
    });
    // 刻意不 end：真 SSE 一直挂着
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  api.address = "127.0.0.1:" + port;
  servers.push({
    srv,
    close: async () => {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    },
  });
  return api;
}

let servers: { srv: Server; close(): Promise<void> }[] = [];

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

function fakeClock() {
  const pending: { fn: () => void }[] = [];
  return {
    setTimeoutImpl: (fn: () => void, _ms: number) => {
      pending.push({ fn });
      return () => {
        const i = pending.findIndex((p) => p.fn === fn);
        if (i >= 0) pending.splice(i, 1);
      };
    },
  };
}

describe("hub:eventsReady：开流的时机闸门", () => {
  it("⭐ wireMain 之后、ready 之前【零连接】；ready 到达后才开流", async () => {
    // 这一发是整个握手的存在理由。判据读【服务器看到的连接条数】，
    // 不读 wire.running —— 后者是自我确认（wire.test.ts W8 记过那一族）。
    const srv = await startStreamServer();
    const ipc = fakeIpc();
    const s = fakeSender();
    const wire = wireMain({
      token: TOKEN,
      hubAddress: srv.address,
      ipcMain: ipc.ipcMain,
      sender: s.sender,
      setTimeoutImpl: fakeClock().setTimeoutImpl,
    });
    await settle();
    expect(srv.connections, "wireMain 自己就把流开了 ⇒ ready 成了摆设").toBe(0);
    expect(wire.running).toBe(false);

    const ready = ipc.handlers.get(EVENTS_READY_CHANNEL);
    if (ready === undefined) throw new Error("hub:eventsReady 没注册 handler");
    await ready({}, undefined);
    await tick();
    expect(srv.connections, "ready 到了而流没开 ⇒ 界面永远停在『连不上』").toBe(1);
    expect(wire.running).toBe(true);
    wire.stop();
    wire.unregister();
  });

  it("⭐ ready 的 handler 就在注册集里，且与 invoke 通道【各一条】互不覆盖", async () => {
    const srv = await startStreamServer();
    const ipc = fakeIpc();
    const s = fakeSender();
    const wire = wireMain({
      token: TOKEN,
      hubAddress: srv.address,
      ipcMain: ipc.ipcMain,
      sender: s.sender,
      setTimeoutImpl: fakeClock().setTimeoutImpl,
    });
    // 注册集 = invoke 通道 + 握手通道，一条不多一条不少。
    // 这里【显式列出握手通道的在场】而不是复用 invokeChannels()：
    // 变异实验里"摘掉 ready 的注册"必须在这一发上红，而不是只红在新测试文件里
    // （wire.test.ts 的同款断言与这条互为两侧的重复，重复是有意的：摘注册的人
    //  不该需要跑两个文件才知道自己拆了闸门）。
    expect([...ipc.handlers.keys()].sort()).toEqual(
      [...invokeChannels(), EVENTS_READY_CHANNEL].sort(),
    );
    wire.unregister();
  });

  it("ready 重复调 ⇒ 仍只有一条流（幂等归 open，不归 handler）", async () => {
    const srv = await startStreamServer();
    const ipc = fakeIpc();
    const s = fakeSender();
    const wire = wireMain({
      token: TOKEN,
      hubAddress: srv.address,
      ipcMain: ipc.ipcMain,
      sender: s.sender,
      setTimeoutImpl: fakeClock().setTimeoutImpl,
    });
    const ready = ipc.handlers.get(EVENTS_READY_CHANNEL);
    if (ready === undefined) throw new Error("没注册");
    await ready({}, undefined);
    await ready({}, undefined);
    await settle();
    expect(srv.connections, "重复 ready 造出第二条活流").toBe(1);
    wire.stop();
    wire.unregister();
  });

  it("stop() 之后再来 ready（页面重载）⇒ 重新开流", async () => {
    // 页面重载 = 监听先没了、再挂回来、再 ready 一次。装配里窗口 close 调 stop()，
    // 重载后的 ready 必须能把流【再】开起来，否则界面从此停在旧游标上。
    const srv = await startStreamServer();
    const ipc = fakeIpc();
    const s = fakeSender();
    const wire = wireMain({
      token: TOKEN,
      hubAddress: srv.address,
      ipcMain: ipc.ipcMain,
      sender: s.sender,
      setTimeoutImpl: fakeClock().setTimeoutImpl,
    });
    const ready = ipc.handlers.get(EVENTS_READY_CHANNEL);
    if (ready === undefined) throw new Error("没注册");
    await ready({}, undefined);
    await settle();
    expect(srv.connections).toBe(1);
    wire.stop();
    await settle();
    expect(srv.closed).toBe(1);
    await ready({}, undefined);
    await tick();
    expect(srv.connections, "重载后的 ready 没能重开流").toBe(2);
    wire.stop();
    wire.unregister();
  });

  it("窗口已销毁【之后】才到的 ready ⇒ 不开流（也不抛）", async () => {
    // 乱序是真实的：invoke 在路上而窗口恰好关了。正确行为是【什么都不做】：
    // 开一条推不出去的流才是错。返回 { ok: true } 而不是报错 —— 理由写在 wire.ts
    // handler 的注释里（渲染进程不该有那条永远该忽略的错误分支）。
    const srv = await startStreamServer();
    const ipc = fakeIpc();
    const s = fakeSender();
    const wire = wireMain({
      token: TOKEN,
      hubAddress: srv.address,
      ipcMain: ipc.ipcMain,
      sender: s.sender,
      setTimeoutImpl: fakeClock().setTimeoutImpl,
    });
    s.destroy();
    const ready = ipc.handlers.get(EVENTS_READY_CHANNEL);
    if (ready === undefined) throw new Error("没注册");
    const r = (await ready({}, undefined)) as { ok: boolean };
    await settle();
    expect(r.ok).toBe(true);
    expect(srv.connections, "给已死的页面开了流").toBe(0);
    expect(wire.running).toBe(false);
    wire.stop();
    wire.unregister();
  });

  it("unregister() 之后 ready 通道【没人应答】而不是悄悄还能开流", async () => {
    const srv = await startStreamServer();
    const ipc = fakeIpc();
    const s = fakeSender();
    const wire = wireMain({
      token: TOKEN,
      hubAddress: srv.address,
      ipcMain: ipc.ipcMain,
      sender: s.sender,
      setTimeoutImpl: fakeClock().setTimeoutImpl,
    });
    wire.unregister();
    expect(ipc.handlers.has(EVENTS_READY_CHANNEL), "握手通道没被摘 ⇒ handler 握着已死的 sender").toBe(false);
    await settle();
    expect(srv.connections).toBe(0);
  });
});
