/**
 * Hub 的 HTTP 传输层（node:http，不引框架）。
 *
 * ── 为什么用 node:http 而不是计划里写的 Hono ─────────────────────────
 * 直接理由是本机离线、hono 装不上。但如果只是这个理由，那这一层应当【留空】
 * 等依赖到位再写，而不是找个替代品顶上 —— 替代品的风险是「它看着像做完了」。
 * 真正让我决定【要写】的是一次自我质询：我说「传输层测不了」，说的是测不了什么？
 * 答案是测不了【真 socket 上的 HTTP】。而 node:http 是内置模块，它就能提供真 socket。
 * 所以「测不了」那句话里混进了一个没根据的推广：把「不能测框架胶水」
 * 当成了「不能测传输」。这一层就是那个推广被戳破之后的东西 ——
 * 现在 401 / 404 / 501 / 游标续订这几件事是在【真的 TCP 连接】上验的，
 * 带着真报头、真分块传输、真断连。
 *
 * Hono 将来要接也很省事：handleRequest 是框架无关的（HubRequest → HubResponse），
 * 换过去只是把 c.req 拆成 HubRequest、把返回翻成 c.body，
 * 而那一层【薄到不需要测试】—— 这是它可以等的唯一理由。
 * 反过来说：如果哪天有人把路由/鉴权/状态码判定【搬进】 hono 的 handler 里，
 * 这些测试就失效了，那种搬动要连带把这些用例搬过去，别丢。
 *
 * ── 只绑 127.0.0.1，而且把这条写进测试 ───────────────────────────────
 * 这个服务【没有任何远程鉴权】：它的全部凭据是一个本机 HMAC 密钥（见 auth.ts），
 * 而那个密钥就躺在同一个进程的内存里。绑到 0.0.0.0 等于把
 * 「任何人可以以 CEO 身份批准付款」开放给同一局域网 ——
 * 而签名机制给的保护在这里几乎为零（它防的是【链路窃听】，不防【同机进程读到密钥】，
 * 更不防【根本不在链路上的邻居】）。
 * 所以这里【没有】host 选项：写死回环。要暴露到远程是 Task 4.1 的事，
 * 而那一层必须先有真正的远程鉴权（一次性配对 + 长期 token 轮换），
 * 届时删掉这个写死是一次【显式的、会被 review 的】改动。
 */

import { encodeSseFrame } from "@opc/contracts";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type HubRequest, type HubResponse, handleRequest, type HubDeps } from "./app.js";

/** 唯一的监听地址。没有第二个值，也没有 host 参数（见文件头）。 */
export const LOOPBACK_HOST = "127.0.0.1";

/** 单个请求体的上限。与 contracts 的 MAX_IDEA_CHARS 同量级，留足 JSON 包裹与将来字段。 */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * 读请求体，带【字节上限】。
 *
 * 上限必须落在【读取】这一侧而不是等 schema 去判：schema 判的是解出来的对象，
 * 而一条 500MB 的 body 在 JSON.parse 之前就已经把进程内存吃光了 ——
 * 那种失败方式是进程 OOM，不是 413，而 OOM 会带走【整个 Hub】，
 * 包括正在跑的所有 agent 图。单用户本机不会有人这么发，
 * 但这一层守的是「最坏情况下 Hub 还活着」。
 */
export async function readBody(req: IncomingMessage): Promise<{ text: string; tooLarge: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const b = c as Buffer;
    total += b.length;
    if (total > MAX_BODY_BYTES) {
      // 【继续消费掉剩下的流】再返回。直接 return 会让 Node 觉得没人读了而 RESET 连接，
      // 客户端看到的是「连接被重置」而不是 413 —— 一个能读的报错值得多这一次循环。
      req.resume();
      return { text: "", tooLarge: true };
    }
    chunks.push(b);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), tooLarge: false };
}

export function toHubRequest(req: IncomingMessage, body: string): HubRequest {
  const raw = req.url ?? "/";
  const q = raw.indexOf("?");
  const path = q < 0 ? raw : raw.slice(0, q);
  const query: Record<string, string | undefined> = {};
  if (q >= 0) {
    // 用 URLSearchParams 而不是手拆：它处理 %XX、加号、同名多值，
    // 而手拆的游标解析会把 "cursor=1&cursor=2" 变成谁都说不清的东西。
    const sp = new URLSearchParams(raw.slice(q + 1));
    for (const [k, v] of sp) query[k] = v;
  }
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    // 同名多头（Node 给数组）在这里【取第一个】而不是拼接。
    // 拼接会把 "x-opc-nonce: a" + "x-opc-nonce: b" 变成一个谁都不是的值，
    // 于是签名校验的失败原因从「用了哪个 nonce」变成「看不懂的串」。
    headers[k] = Array.isArray(v) ? v[0] : v;
  }
  return {
    method: req.method ?? "GET",
    path,
    // 【原样的 req.url】：含 query、未解码。鉴权签这一份，路由用上面那份 path。
    // 在这里「顺手」写成 path 是最省事的破坏方式：编译通过、contract 层单测也通过
    // （那边手写的 path 与 target 恰好同值），只有真发一次带 ?cursor= 的请求才暴露。
    target: raw,
    query,
    headers,
    body,
  };
}

/**
 * 一次「对端没了」的哨兵异常。仅用于把 race 里的关闭那一支和真正的写失败区分开。
 * 不往外抛 —— 被 catch 之后走 finally 正常收尾。
 */
class ClientGone extends Error {}

async function pump(res: ServerResponse, hubRes: HubResponse): Promise<void> {
  if (hubRes.stream === undefined) {
    const text = JSON.stringify(hubRes.body ?? null);
    res.writeHead(hubRes.status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(text),
      ...(hubRes.headers ?? {}),
    });
    res.end(text);
    return;
  }
  res.writeHead(hubRes.status, {
    ...(hubRes.headers ?? {}),
    // SSE 必须关掉分块之外的缓冲提示；connection: close 是【刻意的】：
    // keep-alive 让一个断掉的 SSE 连接在 TCP 层留着，而 §5.8 的回收判据是
    // bus.subscribers() 归零 —— 连接留着，订阅就一直留着。
    connection: "close",
  });
  res.flushHeaders();

  // ── 断连检测，这一段的形状是被一条【红测试】逼出来的，不是风格选择 ──────────
  // 最初的写法是 for-await + 「一帧一帧问 res 还活着没（res.destroyed / write 返回值）
  // 决定是否 break」。它在真 socket 上根本不回收订阅：客户端 destroy 之后，
  // 服务端这一刻既没有【同步的】写失败（res.write 返回 false 是背压信号，
  // 且对已关 socket 的写错误是【异步】发出的），res.destroyed 也未必已经翻真
  // —— 于是循环一路 await it.next() 挂死，订阅（连它那条有界队列）永远留在总线上。
  // 每一个关掉的浏览器标签泄漏一个，正是 §5.8 明令要防的那种泄漏。
  //
  // 可靠的信号是 res 的 'close' 事件（连接终止时 Node 一定发，正常 end() 之后也发，
  // 但我们还没 end，所以此刻收到 close 就等于「对端没了」）。
  // 用 Promise.race 让「下一条事件」和「连接关闭」赛跑：谁先到听谁的。
  // 关键前提（本仓的总线已经满足，见 bus.ts 的 Subscription.close）：
  // close() 会主动放行所有挂着的 next()，所以 race 输了那条挂起的 next()
  // 不会变成悬空 promise，finally 里 it.return() 也就不会死锁 ——
  // 这条前提若不成立，这个写法会复刻 contract.test.ts 里那次 180 秒死锁。
  const it = hubRes.stream[Symbol.asyncIterator]();
  const gone = new Promise<never>((_, rej) => {
    const on = (): void => {
      // 先【同步】归还订阅，再打断循环。顺序反了也行（两步都在同一个 tick 里），
      // 但写成先回收更能说明意图：这一刻起总线已经不该再有这个连接。
      hubRes.onClose?.();
      rej(new ClientGone());
    };
    res.once("close", on);
    // 写失败的异步 error 也归到同一支：它同样意味着「这个连接不能再用」。
    // 挂这个监听还顺带避免了【未监听的 error 变成 uncaughtException 带走整个 Hub】——
    // 一个客户端关窗口不该把 CEO 的所有 agent 图一起带走。
    res.once("error", on);
  });
  try {
    for (;;) {
      const step = await Promise.race([it.next(), gone]);
      if (step.done === true) break;
      if (res.writableEnded || res.destroyed) break; // 双保险：close 之外再问一次
      res.write(encodeSseFrame(step.value as Parameters<typeof encodeSseFrame>[0]));
    }
  } catch (e) {
    if (!(e instanceof ClientGone)) throw e; // 真写失败照常往上抛，交给最外层 500
  } finally {
    // 无论正常结束、写失败、还是对端关闭，都归还订阅。§5.8：写失败即回收其队列。
    // it.return() 触发 ResumeStream.frames 的 finally（sub.close()），
    // 这是【唯一】的回收点 —— 不在这里再 close 一次，也不在别处 close。
    await it.return?.();
    if (!res.writableEnded) res.end();
  }
}

/**
 * 起一个【只监听回环】的 Hub HTTP 服务。
 *
 * 返回 { close }，且 close 是【等待连接结束】的：
 * server.close() 默认【不等】活跃连接，而 SSE 连接是长命的 —— 不等到进程退出时
 * 它们还在，测试里就会拖出一个「测试跑完了但端口还被占着」的下一轮 EADDRINUSE。
 * 那种 flaky 会被当成环境问题放过，而那正是资源回收有问题的形状。
 * （Node 18+ 有 closeAllConnections，但它是对【未结束】的连接强制 destroy，
 *  对正常结束的 SSE 会话是打断；这里两者都用：先等，超时才强制。）
 */
export interface HubServer {
  readonly port: number;
  close(): Promise<void>;
}

export async function serveHub(
  deps: HubDeps,
  opts: { port?: number } = {},
): Promise<HubServer> {
  const server: Server = createServer((req, res) => {
    // 【每个请求一个 try/catch】，且覆盖到 readBody：
    // 读体失败（客户端提前断开、编码坏了）在 Node 默认行为下是 unhandledRejection，
    // 而一个未处理的 rejection 会【终止整个进程】—— 又一次「一次坏请求带走所有 agent」。
    void (async () => {
      try {
        const body = await readBody(req);
        if (body.tooLarge) {
          res.writeHead(413, { "content-type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              error:
                "请求体超过 " +
                MAX_BODY_BYTES +
                " 字节。413 而不是 422：422 说「内容不合 schema」，" +
                "而这里连内容都没收下，调用方的修法是【把请求变小】。",
            }),
          );
          return;
        }
        const hubRes = await handleRequest(deps, toHubRequest(req, body.text));
        await pump(res, hubRes);
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        }
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
    })();
  });

  const port = opts.port ?? 0;
  await new Promise<void>((ok, bad) => {
    server.once("error", bad);
    // 主机参数【不接受外部传入】：见文件头。写死 127.0.0.1，
    // 于是「绑到 0.0.0.0」这件事在这里【没有对应的代码路径】，
    // 而不是「有路径但默认值是对的」。
    server.listen(port, LOOPBACK_HOST, () => ok());
  });
  const actual = (server.address() as { port: number }).port;

  return {
    port: actual,
    close: async () => {
      await new Promise<void>((ok) => {
        // 长命的 SSE 连接不会自己结束，所以【先】给它们一点时间自然收尾、
        // 【再】强制断开。setTimeout 的秒数不是调优结果，只是一个
        // 「足够写完已经排队的帧」的常数；真正要保证的是 close 结束时端口一定释放。
        const force = setTimeout(() => server.closeAllConnections(), 250);
        server.close(() => {
          clearTimeout(force);
          ok();
        });
      });
    },
  };
}
