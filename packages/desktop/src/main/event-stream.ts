/**
 * 桌面主进程侧的【事件流 → 渲染进程推送】（Task 2.2 剩下那一半）。
 *
 * ── 这一格补的是什么 ─────────────────────────────────────────────
 * `channels.ts` 的 `toPushPayload()` 早就写好了（SSE 帧 → 推给渲染进程的载荷），
 * `preload/api.ts` 的 `onHubEvent()` 也写好了（渲染进程那一侧的监听 + 退订），
 * 中间那一格 —— 【谁去开那条流、按什么切帧、断了怎么续】—— 全仓没有。
 * 于是两端各自绿着，中间是空的：与 `signedFetch` 那次同一个形状（0052 §1）。
 *
 * ── 为什么这一格不能用 signedFetch 那条路 ─────────────────────────
 * `MainDeps.signedFetch` 的形状是 `{ status, bodyText }`：**整段缓冲**。
 * 一条活着的 SSE 流装不进 `bodyText` —— 等它拿到值的时候连接已经关了，
 * 界面会一直空白（dev-server.ts 里为同一件事写的原话：「SSE 的 GET /events
 * 靠这个才活着：先攒成字符串等于等连接关闭」）。
 * 所以这里**只要签名、不要那个函数**：`signedHeaders()` 出三个头，
 * 开流由本文件用 node:http 自己做。签名逻辑仍然只有一份（在 signed-fetch.ts）。
 *
 * ── 本文件真正承重的只有一条：重连带什么游标 ──────────────────────
 * 规格 Task 2.3 的「快照 + 续订幂等」有一个没写出来的前提，
 * `http/sse.ts` 文件头把它挑明了，这里抄它的结论：
 *   客户端【不带】游标 ⇒ 服务端走 `ResumeStream.begin()` ⇒ 游标取在服务端
 *   读快照之前 ⇒ 断线期间落库的那些条【永远不会被投递】。
 * 症状不是报错，是「看板偶尔少一次状态变化，刷一次就好」（sse.ts 原话）。
 * 所以：**只要收到过任何一条带 id 的帧，重连就必须带上那个 seq**。
 * 这一条由 test/desktop/event-stream.test.ts 用【真 socket + 真断线】量：
 * 服务端记下每一次收到的 cursor，第二次必须是上一次推出去的那个 seq。
 *
 * 顺带同一条理由决定了【快照帧不许推进游标】：`frames()` 的第一帧刻意不带 id
 * （sse.ts:「给它编一个 id 等于伪造游标」），所以对 undefined 做 Number() 会得到 NaN。
 * ⚠ 我第一版在这里写的是「NaN 会拼进 `/events?cursor=NaN`，服务端 resume() 直接抛，
 * 此后每次重连都死在建流上」—— 那是【推断】。变异实验实测的形状更安静：
 * `NaN > 0` 是 false ⇒ 那个三元判断永远选到【不带游标】那一支 ⇒
 * 每次重连都从头重放一遍，重复被幂等投影吃掉，功能上【看不出来】。
 * 两种都不对，而实测那一种更难查（它没有报错，也没有丢东西）。
 * 这一格由测试里那条「快照之后立刻断线」钉住【观察到的】形状，不是我以为的那种。
 *
 * ── 为什么这里【直接】用 node:http 而不是注入一个开流函数 ──────────
 * 注入替身能测到我写了什么，测不到【真线上跑的字节】：帧的切分跨越 TCP 分片、
 * 头名大小写、真实断线时 res 的 close 顺序 —— 那三样都是替身会给不出的东西，
 * 而它们恰好是这一层最容易坏的地方。node:http 离线可用（web/dev-server.ts 一直在用），
 * 所以本文件的测试是真的起一个 Hub 形状的服务器，
 * 并在服务器里拿 **hub 自己的 `verifyRequest`** 当门（签名错了根本收不到帧）。
 */
import { request } from "node:http";
import { decodeSseFrame, reconnectDelayMs, shouldGiveUp } from "@opc/contracts";
import type { HubEventPayload } from "../preload/api.js";
import { signedHeaders } from "./signed-fetch.js";

/**
 * 链路状态用的【保留事件名】。
 *
 * 为什么走同一条推送通道而不是新加一个 IPC 通道：`hub:subscribeEvents` 是白名单里
 * 唯一的推送通道（ipc-surface.ts 那条注释写明了推送通道不进 invoke 白名单），
 * 加第二条会把那条「只有一个推送通道」的断言变成装饰。
 * 而**必须有这个信号**：contracts 的 `shouldGiveUp` 文件头那句
 * 「继续显示最后一帧装作实时，比说『我连不上了』坏得多 —— CEO 会基于一个过期看板
 * 做审批决定」对桌面壳同样成立，而桌面壳今天连一个说法都给不出。
 *
 * ⚠ 这个名字【不是】任何 Hub 事件的 kind（contracts 的 kindOf 那一份名单里没有冒号
 * 前缀 `desktop:`），所以渲染进程的投影不会把它当成一条真事件。
 * 而它【永远不带 seq】—— 那是本文件里唯一一条安全性质：
 * 一条带 seq 的状态帧会把投影的游标推到错误的位置，从而【静默丢掉】中间那段。
 */
export const LINK_EVENT = "desktop:link";

export type LinkStatus =
  | { readonly state: "live" }
  | { readonly state: "retrying"; readonly attempt: number; readonly delayMs: number; readonly reason: string }
  | { readonly state: "down"; readonly reason: string };

export interface EventStreamOptions {
  readonly token: string;
  /** Hub 的 `host:port`。不带 scheme，与 makeSignedFetch 同一个口径。 */
  readonly hubAddress: string;
  /** 推给渲染进程（真装配里就是 `webContents.send(EVENT_CHANNEL, payload)`）。 */
  readonly push: (payload: HubEventPayload) => void;
  /** 链路状态。可选，但真装配【必须】传：不传就等于回到「装作实时」。 */
  readonly onStatus?: (s: LinkStatus) => void;
  /** 首次连接的游标。缺省 0 = 「我什么都没有」，服务端走 begin()。 */
  readonly initialCursor?: number;
  /**
   * 定时器注入点。**只给测试**：退避曲线在 contracts 里是 500ms…15s、
   * 八次才放弃，真等一遍要几十秒，而那一发测试会变成「所以注释掉了」。
   * 注的是【调度器】不是【曲线】—— 曲线仍然由 contracts 那份算出来，
   * 注掉它才会造成两份漂移。
   */
  readonly setTimeoutImpl?: (fn: () => void, ms: number) => () => void;
  readonly now?: () => number;
  readonly nonce?: () => string;
}

export interface EventStreamHandle {
  /** 关掉流并停止重连。幂等。 */
  close(): void;
  /** 已经推给渲染进程的最大 seq（重连时带它）。快照帧不计入。 */
  readonly cursor: number;
  readonly closed: boolean;
  /** 连续失败次数。成功连上一次就归零（与 app.js 同一个口径：描述的是【连续】失败）。 */
  readonly attempt: number;
}

/**
 * 4xx 里哪些【值得再试】。
 *
 * 分界线不是「客户端错就不试」这么粗，而是这一条：**重试有可能成功吗**。
 *  · 401 / 403 ⇒ 密钥或权限不对。重试【永远】不会成功（channels.ts 对 unreachable
 *    同一条判断：「而重试在这里永远不会成功，用户会一直点」）。
 *  · 400 / 404 ⇒ 我们拼出的 target 本身不合法（比如游标坏了）。同样不会自愈。
 *  · 408 / 429 ⇒ 服务端主动说「稍后再来」。这两个是唯一两个把重试写进语义的。
 *  · 5xx ⇒ Hub 自己在重启，正是退避曲线为它准备的那一段。
 * 放弃时给的是 `down` 而**不是一句静默**：静默在前端等于装作实时。
 */
function retryableStatus(status: number): boolean {
  if (status >= 500) return true;
  return status === 408 || status === 429;
}

export function openEventStream(o: EventStreamOptions): EventStreamHandle {
  const [host, port] = o.hubAddress.split(":");
  if (host === undefined || host.trim() === "" || port === undefined || !/^\d+$/.test(port)) {
    // 与 makeSignedFetch 的空 token 同一条纪律：配置缺失要在这里说，
    // 不要拼出一个必然连不上的地址、让它以「Hub 没起来」的形状出现。
    throw new Error("hubAddress 必须是 host:port，实到 " + JSON.stringify(o.hubAddress));
  }
  const setTimeoutImpl = o.setTimeoutImpl ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    return () => {
      clearTimeout(t);
    };
  });

  let cursor = o.initialCursor ?? 0;
  let attempt = 0;
  let closed = false;
  let req: ReturnType<typeof request> | null = null;
  let cancelTimer: (() => void) | null = null;
  /** 本次连接已收到的裸帧缓冲（按 `\n\n` 切，尾部留半截）。 */
  let buf = "";
  /**
   * 推送【抛过】之后置真。见 emit() 那条。
   */
  let pushBroken = false;

  /**
   * 推送的唯一出口。包 try/catch **不是**为了「不让报错吵到人」——
   * 那条理由本仓在 preload/api.ts 里明确批评过（「错误在半路被吃掉」）。
   * 这里的理由是【不包的话更糟】：push 是在 res 的 `data` 回调里被调的，
   * 从那里抛出去是一个【无人接住的异常】，真实触发条件是「渲染进程已经被关掉
   * 而主进程还握着这条流」—— 那是一次【正常关机】，不是事故。
   * 所以：抓住它，但【如实上报】并停下（不装没事，也不继续往一个没了的对象上推）。
   *
   * ⚠ 「跟着倒」这件事我原先是**推出来的**（「回调里抛 ⇒ 进程死」是常识形状，
   * 我按常识写的）。0052 §5 把它换成了量出来的：裸 node v24.14.0、无 uncaughtException
   * 处理器，从 `data` 回调里抛与从 `response` 回调里抛【都】是进程 exit 1；
   * 装了处理器才活。**没量到的一半也写在这里**：Electron 主进程自己会不会装一个
   * 兜底处理器 ⇒ 离线装不上 electron、量不了 ⇒ 所以这句只敢承诺「Node 侧必死」，
   * 不敢写成「Electron 里必死」。这条 try/catch 不依赖那个未量的部分，
   * 它两条都挡得住 —— 记这一条是为了别再有人把没量的部分写成事实。
   */
  const emit = (payload: HubEventPayload): boolean => {
    if (pushBroken) return false;
    try {
      o.push(payload);
      return true;
    } catch (e) {
      pushBroken = true;
      closed = true;
      cancelTimer?.();
      cancelTimer = null;
      req?.destroy();
      req = null;
      // ⚠ 游标【不推进】—— 这一条事件的的确没送到渲染进程。
      // 停在这里而不重连（推给谁？），但游标留着是对的值：
      // 下一次壳起来时会从【真正送达的位置】续，而不是跳过这一条。
      process.stderr.write(
        "桌面壳推送失败，事件流已停：" + (e instanceof Error ? e.message : String(e)).slice(0, 200) + "\n",
      );
      return false;
    }
  };

  const status = (s: LinkStatus): void => {
    o.onStatus?.(s);
    // 状态帧【不带 seq】。见 LINK_EVENT 那条：带 seq 会推到错误位置。
    emit({ event: LINK_EVENT, data: JSON.stringify(s) });
  };

  const scheduleReconnect = (reason: string): void => {
    if (closed) return;
    if (shouldGiveUp(attempt)) {
      // 到这里说明连续失败已经 >= GIVE_UP_AFTER_ATTEMPTS 次。
      // 放弃之后【不重连】，但界面必须说得出为什么：这是 down 而不是 live 的唯一依据。
      status({ state: "down", reason: "连续 " + attempt + " 次连不上，已停止重连：" + reason });
      return;
    }
    const delayMs = reconnectDelayMs(attempt);
    attempt += 1;
    status({ state: "retrying", attempt, delayMs, reason });
    cancelTimer = setTimeoutImpl(() => {
      cancelTimer = null;
      connect();
    }, delayMs);
  };

  const takeFrames = (): void => {
    // 只按 `\n\n` 切。半截帧【留在缓冲里】而不是丢掉也不是一句报错：
    // TCP 会在任意字节位置切（一帧被劈成两包是常态而不是异常），
    // 而这里判错的表现是「偶发少一条事件」—— 最难查那一类。
    let i = buf.indexOf("\n\n");
    while (i >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (raw.trim() !== "") handleRaw(raw);
      i = buf.indexOf("\n\n");
    }
  };

  const handleRaw = (raw: string): void => {
    const frame = decodeSseFrame(raw);
    // `retry:` 是给自管重连的提示，不是一帧数据（app.js 里同一句 return）。
    // 推给渲染进程的话，投影会收到一条 data 是重试毫秒数的"事件"。
    if (frame.retryMs !== undefined) return;
    if (frame.id === undefined) {
      // 快照帧（sse.ts 刻意不给 id）。透传内容，但【不推进游标】——
      // 推进它不会报错，只会让每次重连从头重放（文件头那段实测）。
      emit({ event: frame.event, data: frame.data });
      return;
    }
    const seq = Number(frame.id);
    if (!Number.isSafeInteger(seq) || seq < 0) {
      // 协议违例。这里**不能**"就当没看见继续"：那条游标要么永远推不动
      // （下次重连又从旧位置重放一遍，看起来只是重复几条，无害到没人会查），
      // 要么被下游当成有效位置而丢事件。两种都比停下来说一句更坏。
      closed = true;
      req?.destroy();
      status({ state: "down", reason: "事件流给出了不是非负整数的 id：" + JSON.stringify(frame.id) });
      return;
    }
    // 游标【只在真的送达之后】才前进。顺序在这里有内容：
    // 先推进再推 ⇒ push 抛掉的那一条既没送到渲染进程、也不会被重投递，
    // 而重连时带的是那个推进过的游标 ⇒ 静默丢一条事件。
    // （这一格是变异实验逼出来的：我把那两行交换之后【全绿】，
    // 因为当时没有一发测试让 push 抛过 —— 0052 §2。）
    if (emit({ seq, event: frame.event, data: frame.data })) cursor = seq;
  };

  const connect = (): void => {
    if (closed) return;
    // 【同一个字符串】既用来签、又真的发出去。这不是风格问题：
    // 签名与请求目标只要差一个字符（多一个 /api 前缀、query 少一个键、
    // 大小写不同的百分号编码），症状就是 401，而 auth.ts 刻意不区分原因。
    const target = cursor > 0 ? "/events?cursor=" + cursor : "/events";
    const headers: Record<string, string> = {
      // accept 走【外面】而不是塞进 signedHeaders：规范串只签方法/target/body/
      // 时间戳/nonce（auth.ts 的 canonicalString），多塞一个键进那个参数对象
      // 要么改签名函数的形状、要么靠一次 as 断言压掉编译错。
      // 我第一版就是那么压的，而那一版【看起来】只是把 accept 放到一起更整齐 ——
      // 实际买到的是「签名函数的形状被一个它不关心的头污染了」。
      accept: "text/event-stream",
      ...signedHeaders({
        token: o.token,
        method: "GET",
        target,
        body: "",
        ...(o.now === undefined ? {} : { now: o.now }),
        ...(o.nonce === undefined ? {} : { nonce: o.nonce }),
      }),
    };
    if (req !== null) req.destroy(); // 上一轮流还没散干净（正常路径下已经是 null）
    const r = request({ host, port: Number(port), path: target, method: "GET", headers });
    req = r;
    r.on("response", (res) => {
      const st = res.statusCode ?? 0;
      if (st >= 400) {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          if (body.length < 2000) body += c; // 上限：报错体是给人看的，不是用来撑内存的
        });
        res.on("end", () => {
          req = null;
          res.destroy();
          const why = "HTTP " + st + (body.trim() === "" ? "" : " " + body.trim().slice(0, 200));
          if (retryableStatus(st)) scheduleReconnect(why);
          else status({ state: "down", reason: why + "（这一类重试不会成功，检查部署 token 与地址）" });
        });
        return;
      }
      attempt = 0; // 连上了就归零：曲线描述的是【连续】失败，不是整场会话
      status({ state: "live" });
      buf = ""; // 上一轮残留的半截帧不能拼到新一轮的字节前面（新流的位置未知）
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        takeFrames();
      });
      res.on("end", () => {
        req = null;
        scheduleReconnect("事件流被服务端关闭");
      });
      res.on("error", () => {
        req = null;
        scheduleReconnect("事件流读取失败");
      });
    });
    r.on("error", (e: Error) => {
      req = null;
      // 这一支是 Hub 进程没起来 / 端口不对 —— 桌面壳最常见的一支，
      // 因为壳可以比 Hub 先启动。它必须是个【说得出的状态】而不是一个 rejected promise。
      scheduleReconnect(e.message);
    });
    r.end();
  };

  connect();
  return {
    close: () => {
      closed = true;
      cancelTimer?.();
      cancelTimer = null;
      req?.destroy();
      req = null;
    },
    get cursor(): number {
      return cursor;
    },
    get closed(): boolean {
      return closed;
    },
    get attempt(): number {
      return attempt;
    },
  };
}
