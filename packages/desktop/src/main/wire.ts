/**
 * 桌面主进程的【接线】—— 把已经测过的三块接成一个能跑起来的壳。
 *
 * ── 为什么这一格单独成一个文件，而不是直接写 main.ts ────────────────
 * `electron` 本机装不上（离线），而 `import { app, BrowserWindow } from "electron"`
 * 会让 `tsc -p packages/desktop` 报 TS2307 —— 那是**用"少一个编译错误"换不掉的**：
 * 一旦这里红了，整个包的类型闸门就没了，而那道闸门刚拦住过
 * `signed-fetch.ts` 的两个真错（0052 §2）。
 * 所以 electron 的三样东西（ipcMain / webContents / 窗口生命周期）在这里全部
 * 做成【参数注入】。剩下的真 main.ts 只剩：
 *   app.whenReady() → new BrowserWindow(...) → wireMain({ token, hubAddress, ipcMain, sender })
 *   → 窗口 load 完调 handle.start()，窗口关时调 handle.stop()
 * —— 那几行是【等依赖到位再补的胶水】，与 channels.ts 文件头是同一条判断，
 * 但这里的"胶水"比那边少：那边写的时候三块都还没有，现在三块都有了并且各自有分母。
 *
 * ── 这一格真正的风险不在"接没接上"，在两处时序 ──────────────────────
 * ① **谁先起**：壳可以比 Hub 先启动（双击图标 vs 命令行里另开一个 serve）。
 *    所以起流失败【不是】启动失败：event-stream 会退避重试，界面显示"连不上"。
 *    这里刻意【不】在 wireMain 里 await 那条流。
 * ② **推给一个还没加载完的页面会静默丢**：webContents.send 在页面还没
 *    挂上监听器时是【丢弃而不是排队】的，而本文件的游标【已经前进了】——
 *    于是那几条事件主进程以为送了、渲染进程从没收到。
 *    这一条我没有在本文件里"修掉"，因为能在主进程侧修的版本都是错的
 *    （缓冲一份未送达队列 = 主进程里多出一个业务状态，而 Task 2.3 的验收
 *    标准正是"渲染进程内不存在任何业务状态机"，主进程更不该有）。
 *    它靠 §5.8 那条纪律闭环：渲染进程起来先拉快照、按 seq 幂等应用。
 *    ⚠ 彻底闭合需要一条 `hub:eventsReady` 的 invoke 通道（渲染进程说"我挂上监听了"
 *    再起流）。那是一次【白名单变更】，必须与渲染侧投影同一次落地 ——
 *    单独先加通道会造出一个"能调而没人应答"的入口。记在 0052 §7 第 3 条。
 */
import { request } from "node:http";
import type { HubEventPayload } from "../preload/api.js";
import { EVENT_CHANNEL } from "../preload/api.js";
import { CHANNEL_SPECS } from "../ipc-surface.js";
import { type IpcError, dispatch } from "./channels.js";
import { type EventStreamHandle, openEventStream } from "./event-stream.js";
import { type FetchLike, makeSignedFetch } from "./signed-fetch.js";

/**
 * ipcMain 用得上的那两个方法。
 * 刻意不 import electron 的类型（装不上，见文件头）；形状够就行，
 * 而"够不够"由装配那一次赋值去证，不由这里的断言自称（同 signed-fetch 的 fetchImpl）。
 */
export interface IpcMainLike {
  handle(channel: string, handler: (event: unknown, args: unknown) => Promise<unknown>): void;
  removeHandler(channel: string): void;
}

/** 一个能收推送的目标（真装配里就是 BrowserWindow 的 webContents）。 */
export interface SenderLike {
  send(channel: string, payload: unknown): void;
  /**
   * 页面是否已经没了。
   *
   * 为什么要有这一维而不用 try/catch 兜：`webContents.send` 在对象销毁之后调
   * 会抛（Electron 的行为），而 event-stream 那边把【抛】当成"推送这条路断了"
   * 并停住 + 写一行 stderr。那是给【意外】用的。关窗口是【预期内】的正常收尾，
   * 不该以一行 stderr 的形状出现在日志里 —— 那会让下一个读日志的人以为出了事故。
   */
  isDestroyed(): boolean;
}

export interface WireOptions {
  readonly token: string;
  readonly hubAddress: string;
  readonly ipcMain: IpcMainLike;
  readonly sender: SenderLike;
  /** 事件流游标的初值（渲染进程重挂时可以带着上次的值回来）。 */
  readonly initialCursor?: number;
  readonly setTimeoutImpl?: (fn: () => void, ms: number) => () => void;
}

export interface WireHandle {
  /** 起事件流。窗口【加载完成之后】调，理由见文件头时序 ②。可重复调（幂等）。 */
  start(): void;
  /** 停事件流。窗口关闭时调。可重复调。 */
  stop(): void;
  /** 卸载所有 invoke handler（窗口销毁时与 stop() 一起调，否则 handler 握着已死的 sender）。 */
  unregister(): void;
  readonly streamCursor: number;
  readonly running: boolean;
}

/**
 * invoke 通道名单。【从 CHANNEL_SPECS 里筛】而不是在这里手抄一遍通道名 ——
 * 这条与 preload/api.ts 的做法【相反】，而两边都是对的，理由不同：
 *  · preload 那边必须手写，因为那张表是【安全边界】：从白名单生成会让
 *    "随手加一个 dbQuery" 两侧一起变，测试一字不变地绿（ipc-surface.test.ts 记过）。
 *  · 这边的表是【路由表】：加一条 invoke 通道而忘了在这里接线，症状是
 *    渲染进程调到一个【没人应答】的通道（electron 那边报 "No handler registered"），
 *    而不是一个安全洞。这里筛表让"加了通道"与"接上线"是同一次改动。
 */
export function invokeChannels(): string[] {
  return CHANNEL_SPECS.filter((s) => s.kind === "invoke").map((s) => s.channel);
}

export function wireMain(o: WireOptions): WireHandle {
  const registered: string[] = [];
  let stream: EventStreamHandle | null = null;

  for (const channel of invokeChannels()) {
    registered.push(channel);
    o.ipcMain.handle(channel, async (_event: unknown, args: unknown) => {
      // sender 已经没了 ⇒ 不再往 Hub 发这一发。
      // 不拦的话：窗口关掉之后仍在飞的一发会照常签名、照常打到 Hub、
      // 结果送到一个不存在的收件人 —— 请求【成功了】而没人看，
      // 那比失败更难发现（写进去的副作用是真的发生了）。
      if (o.sender.isDestroyed()) return destroyedError(channel);
      return dispatch(deps, channel, args);
    });
  }

  // signedFetch 只造一次：token 与地址都不变，而 MainDeps 的形状就是那一个字段。
  // 每次 invoke 重建一个不会算错，只是把「它有没有可变状态」这件事留给读者去查。
  const deps = makeDeps(o);

  const push = (payload: HubEventPayload): void => {
    if (o.sender.isDestroyed()) {
      // 抛出去 = 让 event-stream 停住（它把"推送这条路断了"当成终止条件）。
      // 这一支与上面 handler 里那一支的【差别是有的】：这里是【一条长期流】，
      // 停不下来会一直读下去、一直丢，而没人看得见。
      throw new Error("渲染进程已销毁，事件流停止");
    }
    o.sender.send(EVENT_CHANNEL, payload);
  };

  return {
    start: () => {
      if (stream !== null) return; // 幂等：重挂窗口时别造出第二条活流
      stream = openEventStream({
        token: o.token,
        hubAddress: o.hubAddress,
        push,
        ...(o.initialCursor === undefined ? {} : { initialCursor: o.initialCursor }),
        ...(o.setTimeoutImpl === undefined ? {} : { setTimeoutImpl: o.setTimeoutImpl }),
      });
    },
    stop: () => {
      stream?.close();
      stream = null;
    },
    unregister: () => {
      for (const c of registered) o.ipcMain.removeHandler(c);
      registered.length = 0;
    },
    get streamCursor(): number {
      return stream?.cursor ?? 0;
    },
    get running(): boolean {
      return stream !== null && !stream.closed;
    },
  };
}

function destroyedError(channel: string): { ok: false; error: IpcError } {
  return {
    ok: false,
    error: {
      code: "unreachable",
      // 用 unreachable 而不是新造一个 code：渲染进程已经不在了，这个报错
      // 其实是给【日志】看的而不是给界面看的。造一个新 code 会让渲染侧
      // 多一条它永远不该处理的分支。
      message: "渲染进程已销毁，" + channel + " 未发出",
    },
  };
}

/**
 * `MainDeps` 的那一格。fetchImpl 用的是下面那个【真的】node:http 实现 ——
 * 它在本仓的测试里对着一台真服务器跑过（test/desktop/wire.test.ts ③），
 * 不是纸面代码。
 *
 * ⚠ 这里【不】注入 fetchImpl：它是本包唯一一处碰 node:http 的地方（事件流那边
 * 是另一处但形状不同），而它需要被真的跑一次才有意义 —— 注入替身的话
 * 「fetchImpl 与 FetchLike 到底兼不兼容」这件事就永远没人证过，
 * 而那正是我在 signed-fetch.ts 文件头列的第 ① 条理由要防的东西。
 */
function makeDeps(o: WireOptions) {
  return makeSignedFetch({ token: o.token, hubAddress: o.hubAddress, fetchImpl: nodeHttpFetch });
}

/**
 * invoke 那七条用的 fetchImpl：node:http → FetchLike（缓冲完再返回）。
 *
 * 与事件流那条【不共用】是刻意的：那条要的是【不缓冲】的开流方式
 * （`r.pipe` / 逐 chunk 解帧），这边要的是 status + 整段文本。
 * 硬共用一个函数，就得让其中一个成为另一个的退化版 —— 而退化版那一侧
 * 坏的时候不报错，只是拿不到流（dev-server.ts 里那句「先攒成字符串等于等连接关闭」）。
 */
export const nodeHttpFetch: FetchLike = (url, init) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request(
      {
        host: u.hostname,
        port: Number(u.port === "" ? 80 : u.port),
        path: u.pathname + u.search,
        method: init.method,
        headers: init.headers,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          body += c;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, text: async () => body });
        });
      },
    );
    req.on("error", reject);
    // 与 signed-fetch 那条同一条纪律：body 键【不存在】时不 end(undefined)。
    if (init.body === undefined) req.end();
    else req.end(init.body);
  });
