/**
 * Hub HTTP 传输层：跑在【真 TCP 回环端口】上。
 *
 * 这个文件存在理由只有一句话：之前我说「传输层测不了」，
 * 那句里混进了一个没根据的推广 —— 不能测的是【框架胶水】，
 * 而 node:http 是内置模块，它能给真 socket。
 *
 * ── 写这个文件期间被它自己推翻的三条断言（值得留着，别再犯）────────────
 * ① 最初所有 SSE 用例都走【等 res 结束再整体读】的那个 raw() 帮助函数。
 *    结果第一条就挂住不返回：GET /events 不带 limit 时 frames() 是【永不断流】的
 *    （那正是长连接的语义），res 的 end 事件【永不触发】。
 *    所以这个文件里 SSE 一律走 openStream()：拿到响应头就 resolve、按帧计数、
 *    够了由测试自己 destroy。谁要再加 SSE 用例，别把 raw() 抄过去。
 * ② 我写过「带 query 的请求能正常鉴权」这类话，而它【整条是假的】：
 *    客户端签的是它发出去的那一串（含 ?cursor=），服务端算的是剥过 query 的 path，
 *    两侧永远算不出同一个规范串 ⇒ 任何带 query 的请求恒 401 ⇒ 断线重连整条路是死的。
 *    contract 层的单测【看不见】这件事：那边手写的 path 与签名的 path 是同一个人
 *    写的同一个值。修法是鉴权签【原始 target】（见 auth.ts 的 canonicalString）。
 * ③ 我原本打算断言「断开之后【空闲时】订阅也被回收」，并给自己一个理由：
 *    「回收的触发点是一次写失败，空闲连接不写东西所以没人知道对端没了」。
 *    那句话把一个【实现缺陷】说成了一个【性质】。真测下去发现：
 *    res.write 对已关 socket 既不抛也不返回可靠的 false，
 *    于是老写法一路 await 挂死，订阅【永远】留在总线上 ——
 *    每个关掉的标签页漏一条，而 §5.8 要的是「断开即回收」。
 *    现在的触发点是 res 的 close 事件 + ResumeStream.close()，
 *    所以下面那条用例【不再需要】publish 一条事件来「撞出」回收。
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeSseFrame, type SseFrame } from "@opc/contracts";
import { type DomainEvent, InMemoryEventBus } from "../../src/events/bus.js";
import { migrate } from "../../src/db/migrate.js";
import type { HubDeps } from "../../src/http/app.js";
import { LOOPBACK_HOST, MAX_BODY_BYTES, type HubServer, serveHub } from "../../src/http/server.js";

// 本文件在 packages/hub/test/http/ ⇒ 往上【两层】才是 hub 根。
// 只上一层得到的是 packages/hub/test，于是下面那条源码扫描读的是另一个目录，
// 报 ENOENT（这一条在本文件第一版里真的红了，红法恰好证明扫描不是恒真的）。
const HUB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TMP = join(HUB, ".tmp", "http-server");

type Row = Record<string, unknown>;
type Db = {
  prepare: (sql: string) => {
    all: (...a: unknown[]) => Row[];
    get: (...a: unknown[]) => Row | undefined;
    run: (...a: unknown[]) => unknown;
  };
  exec: (sql: string) => void;
  close: () => void;
};

const opened: Db[] = [];
const servers: HubServer[] = [];
let fileSeq = 0;

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterAll(async () => {
  for (const s of servers) await s.close();
  for (const db of opened) {
    try {
      db.close();
    } catch {
      /* 已关 */
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});

const NOW = 1_700_000_000_000;

interface Harness {
  readonly deps: HubDeps;
  readonly db: Db;
  readonly bus: InMemoryEventBus;
  readonly port: number;
  readonly token: string;
  readonly calls: { decision: number };
}

async function harness(): Promise<Harness> {
  const { openDb } = await import("../../src/db/driver.js");
  const { newLocalToken } = await import("../../src/http/auth.js");
  const db = openDb(join(TMP, "s-" + process.pid + "-" + ++fileSeq + ".db")) as unknown as Db;
  opened.push(db);
  migrate(db);
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
      "VALUES (?, ?, 'IN_PROGRESS', 'dev', 'implement', ?, ?)",
  ).run("task-1", "传输层用的任务", NOW, NOW);
  const bus = new InMemoryEventBus();
  const token = newLocalToken();
  const calls = { decision: 0 };
  const deps: HubDeps = {
    db: db as unknown as DatabaseSync,
    bus,
    token,
    now: () => NOW,
    recordDecision: async () => {
      calls.decision += 1;
      return true;
    },
    createTask: async () => {},
  };
  const srv = await serveHub(deps, { port: 0 });
  servers.push(srv);
  return { deps, db, bus, port: srv.port, token, calls };
}

async function sign(
  h: Harness,
  method: string,
  path: string,
  body = "",
): Promise<Record<string, string>> {
  const { signedHeaders } = await import("../../src/http/auth.js");
  // 传的是【发出去的那一串】：带 query 就必须把 query 一起签。
  // 这里若图省事传剥过 query 的路径，服务端算出来的规范串就对不上，
  // 而症状是「/events 一切正常，/events?cursor=1 恒 401」—— 即重连整条路是死的。
  return signedHeaders(h.token, { method, target: path, body, now: NOW });
}

interface Raw {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * 非流式请求：等响应结束，整体读。
 * 【只能用于会自己结束的响应】—— 理由见文件头第 ① 条。
 */
function raw(
  port: number,
  o: { method: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<Raw> {
  return new Promise((ok, bad) => {
    const req = httpRequest(
      { host: LOOPBACK_HOST, port, method: o.method, path: o.path, headers: o.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () =>
          ok({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", bad);
      },
    );
    req.on("error", bad);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

/** 签好名的非流式请求。 */
async function signed(h: Harness, method: string, path: string, body = ""): Promise<Raw> {
  const headers: Record<string, string> = { ...(await sign(h, method, path, body)) };
  if (body !== "") headers["content-type"] = "application/json";
  return raw(h.port, { method, path, headers, ...(body === "" ? {} : { body }) });
}

/**
 * 打开一条 SSE：响应头一到就 resolve，帧【增量】解出，够数了由调用方 destroy。
 *
 * 帧要按【累积缓冲】切而不是「一个 chunk 切一次」：真 TCP 会在一块里塞进两帧、
 * 也会把一帧劈成两半（本机 64KB 以下少见，但快照帧的 JSON 完全可能跨过一块）。
 * 按 chunk 切的解析器在这种切法下会【解出半截 JSON 然后抛】，
 * 而这个文件里最不该出现的就是「测试自己的解析器炸了」这种红。
 */
interface Stream {
  status(): Promise<number>;
  headers(): Promise<Record<string, string | string[] | undefined>>;
  frames(n: number): Promise<SseFrame[]>;
  destroy(): void;
}

function openStream(h: Harness, path: string, headers: Record<string, string>): Stream {
  const frames: SseFrame[] = [];
  let buffered = "";
  let settled: (() => void) | undefined;
  let died: ((e: unknown) => void) | undefined;
  const waiting = new Promise<never[]>((_, rej) => {
    died = rej;
  });
  const wake = (): void => settled?.();
  const req = httpRequest(
    { host: LOOPBACK_HOST, port: h.port, method: "GET", path, headers },
    (res) => {
      res.on("data", (c) => {
        buffered += (c as Buffer).toString("utf8");
        for (;;) {
          const i = buffered.indexOf("\n\n");
          if (i < 0) break;
          const part = buffered.slice(0, i);
          buffered = buffered.slice(i + 2);
          if (part.trim() !== "") frames.push(decodeSseFrame(part));
          wake();
        }
      });
      res.on("error", (e) => died?.(e));
      statusP.then(() => wake());
    },
  );
  // destroy 之后的 error 是【预期内】的：不挂这个监听，它就是个 uncaught exception，
  // 会把整个测试进程带走 —— 而带走的方式看着像「别的用例随机红」。
  req.on("error", () => {});
  const statusP = new Promise<number>((ok) => req.on("response", (r) => ok(r.statusCode ?? 0)));
  const headersP = new Promise<Record<string, string | string[] | undefined>>((ok) =>
    req.on("response", (r) => ok(r.headers as Record<string, string | string[] | undefined>)),
  );
  req.end();
  return {
    status: () => statusP,
    headers: () => headersP,
    frames: (n) =>
      new Promise<SseFrame[]>((ok, rej) => {
        const check = (): void => {
          if (frames.length >= n) ok(frames.slice());
          else if (!req.destroyed) settled = check;
          else rej(new Error("连接已断，还差 " + (n - frames.length) + " 帧。已收 " + frames.length + " 帧。"));
        };
        check();
        void waiting.catch(rej);
      }),
    destroy: () => req.destroy(),
  };
}

/** 带签名的 SSE。签名【必须含 path 里的 query】，所以 path 传进来一次就够。 */
async function openSigned(h: Harness, path: string): Promise<Stream> {
  return openStream(h, path, await sign(h, "GET", path));
}

/** 轮询等一个条件成立。超时不「算了通过」，而是把当前值报出来。 */
async function untilZero(get: () => number, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (get() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  expect(get()).toBe(0);
}

/** 带 seq 的用于【帧内容】；不带 seq 的用于 publishPersisted（seq 由它自己校验并附上）。 */
function changed(seq: number, taskId: string, from: string, to: string): DomainEvent & { seq: number } {
  return { kind: "TaskStateChanged", taskId, from, to, seq };
}
function evt(taskId: string, from: string, to: string): DomainEvent {
  return { kind: "TaskStateChanged", taskId, from, to };
}

/* ───────────── ① 真连接上的鉴权与状态码 ───────────── */

describe("真 socket 上的 HTTP", () => {
  it("裸请求 ⇒ 401，且响应体里没有任何线索", async () => {
    const h = await harness();
    const res = await raw(h.port, { method: "GET", path: "/tasks" });
    expect(res.status).toBe(401);
    expect(res.body).not.toMatch(/signature|timestamp|nonce|hmac/iu);
  });

  it("签名正确的 GET /tasks ⇒ 200 + JSON，且【没有】内部字段", async () => {
    const h = await harness();
    const res = await signed(h, "GET", "/tasks");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/u);
    const body = JSON.parse(res.body) as { tasks: Record<string, unknown>[] };
    expect(body.tasks[0]?.["id"]).toBe("task-1");
    expect("state_snapshot" in (body.tasks[0] as object)).toBe(false);
    expect("graph_checkpoint_id" in (body.tasks[0] as object)).toBe(false);
  });

  it("未实现的端点 ⇒ 501，未授权问同一句 ⇒ 401（顺序在真线上成立）", async () => {
    const h = await harness();
    expect((await raw(h.port, { method: "GET", path: "/replay/task-1" })).status).toBe(401);
    expect((await signed(h, "GET", "/replay/task-1")).status).toBe(501);
  });

  it("POST /approvals 的 404 在真线上也【不写审计】", async () => {
    const h = await harness();
    const body = JSON.stringify({ resume: "approve" });
    const res = await signed(h, "POST", "/approvals/ghost", body);
    expect(res.status).toBe(404);
    expect(h.calls.decision).toBe(0);
    expect(h.db.prepare("SELECT COUNT(*) AS c FROM events").get()).toEqual({ c: 0 });
  });

  it("非法 cursor ⇒ 422，且【没打开任何流】（订阅数仍为 0）", async () => {
    const h = await harness();
    const res = await signed(h, "GET", "/events?cursor=-3");
    expect(res.status).toBe(422);
    // 这一条守的是校验的位置：如果 422 是在 frames() 已经建好订阅之后才发的，
    // 那个订阅没有任何人接着关（响应体是 JSON，pump 走的是非流式分支，
    // onClose 也接不上 —— 非流式那条路根本不注册 close 监听），
    // 于是【一次打错的请求泄漏一个订阅】，而且它【永远不会】被回收：
    // 回收的两个触发点（连接关闭、迭代到结束）这一次一个都不会发生。
    expect(h.bus.subscribers()).toBe(0);
  });

  it("签名之后【改了 query】⇒ 401（query 在签名覆盖范围内）", async () => {
    // auth.ts 的注释里写着「query 进了签名，于是游标不能被中途改」。
    // 那句话在这条用例出现之前是【没有根据的】—— 它由 target 的实现顺带推出，
    // 而「顺带推出」正是本仓认定不可信的那一类：实现换了、注释还留着。
    //
    // 这条也是「带 query 能签通」那条的【另一半】：那一条证两侧算同一个串，
    // 这一条证那个串里【确实含 query】。只写前一条的话，
    // 把鉴权改成【完全不看 target】也能全绿 —— 那才是这条真正防的东西。
    //
    // 【用 /tasks 而不是 /events】：对照组要拿同一个签名把原样的请求再发一次，
    // 而那一次是【成功】的 —— 成功的 /events 是一条永不断流的 SSE，
    // 用 raw()（等 res 结束）会当场挂住整轮测试（本文件头第 ① 条，我自己踩了第二次）。
    // /tasks 是普通 JSON、会自己结束，对照组才写得下来。
    const h = await harness();
    const headers = await sign(h, "GET", "/tasks?foo=1");
    const tampered = await raw(h.port, { method: "GET", path: "/tasks?foo=2", headers });
    expect(tampered.status).toBe(401);
    // 同一条签名原样发出去就是 200 —— 排掉「这条签名本来就无效」这个解释。
    // 少了这一句，上面那次 401 可能来自任何别的原因（token 错、时钟歪、头名写错）。
    const same = await raw(h.port, { method: "GET", path: "/tasks?foo=1", headers });
    expect(same.status).toBe(200);
  });

  it("【尾部多一个 &】也算改过（刻意不做 query 规范化）", async () => {
    // 签 "?foo=1"，发 "?foo=1&"。语义上同一个请求，字节上不同。
    // 我们【刻意不规范化】（见 canonicalString：两侧各有一套规范化规则必然漂移），
    // 所以这里应当 401。这条钉的是【那个决定】本身 ——
    // 哪天有人「顺手加个排序 / 去掉尾部的 &」，他先撞到这里，
    // 而不是在生产上撞见「某些客户端偶尔 401」。
    const h = await harness();
    const headers = await sign(h, "GET", "/tasks?foo=1");
    const res = await raw(h.port, { method: "GET", path: "/tasks?foo=1&", headers });
    expect(res.status).toBe(401);
  });
});

/* ───────────── ② 只绑回环 ───────────── */

describe("监听地址", () => {
  it("同端口【占着时起不来、关掉后能立刻重用】（close 真的等完了）", async () => {
    const h = await harness();
    const { serveHub: serve } = await import("../../src/http/server.js");
    // 先证【端口确实被占着】：不占着的话，下面那句「关掉后能重用」是恒真的。
    // 这正是本仓反复处理的那种自我安慰式断言。
    const second = await serve(h.deps, { port: h.port }).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(Error);
    for (const s of servers) if (s.port === h.port) await s.close();
    const again = await serve(h.deps, { port: h.port });
    servers.push(again);
    expect(again.port).toBe(h.port);
    expect((await raw(again.port, { method: "GET", path: "/tasks" })).status).toBe(401);
  });

  it("close 会【等到 SSE 连接结束】，不是把端口拖进 TIME_WAIT", async () => {
    // 这条是上一条没有覆盖的那一半：上面重用的端口上【没有活连接】，
    // 而 Hub 真正会长命的是 SSE。server.close() 默认不等活跃连接，
    // 于是「测试跑完了、端口还被占着」会以下一轮 EADDRINUSE 的面目出现，
    // 看着像环境问题，会被当成 flaky 放过。
    const h = await harness();
    const s = await serveHub(h.deps, { port: 0 });
    // 【照常登记】。原本写的是 servers.pop()，意图是「别让 afterAll 抢先关」，
    // 但那个意图不成立而代价很贵：断言一失败，后面那句 s.close() 就跑不到，
    // 于是漏下一个还在监听的 server，整个测试进程【永不退出】——
    // 那种失败长得像「测试很慢」，而不是「有个地方没关」。
    // 而 afterAll 抢先关也伤不到本用例：close 一个已关的 server，
    // Node 会以 ERR_SERVER_NOT_RUNNING 调回调，promise 照样结算，不会挂。
    servers.push(s);
    const st = await openSigned(h, "/events?cursor=0");
    await st.frames(1); // 先证【连接真的建立了】，否则 close 等的是空气
    st.destroy();
    await s.close();
    const again = await serveHub(h.deps, { port: s.port });
    servers.push(again);
    expect(again.port).toBe(s.port);
  });

  it("源码层面【没有】host 参数可以改监听地址", () => {
    const src = readFileSync(join(HUB, "src/http/server.ts"), "utf8");
    // 「默认值是 127.0.0.1」和「没有别的取值路径」是两件不同的事，后者才守得住。
    expect(src).toMatch(/listen\(\s*port,\s*LOOPBACK_HOST/u);
    expect(src).not.toMatch(/listen\(\s*port\s*\)/u); // 漏 host ⇒ Node 绑所有网卡
    expect(src).not.toMatch(/opts\.host|\bhost\?\s*:/u);
    // 读到了内容（空串对上述三条全部成立 —— 本类守卫最典型的假绿）。
    expect(src.length).toBeGreaterThan(1000);
  });
});

/* ───────────── ③ 请求体上限 ───────────── */

describe("请求体上限", () => {
  it("超大 body ⇒ 413，而【进程还活着】", async () => {
    const h = await harness();
    const big = "x".repeat(MAX_BODY_BYTES + 4096);
    const res = await raw(h.port, {
      method: "POST",
      path: "/tasks",
      headers: { "content-type": "application/json", "content-length": String(big.length) },
      body: big,
    });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).error).toMatch(/413 而不是 422/u);
    // 同一进程之后仍然服务 ⇒ 这一次坏请求没有把服务带坏。
    expect((await signed(h, "GET", "/tasks")).status).toBe(200);
  });

  it("上限落在【读取】侧：schema 根本没被喂到那条超大 body", async () => {
    const h = await harness();
    // 413 必须在 schema 之前发生。判据不是状态码（422 也可能是「太长」，
    // contracts 的 idea 有 MAX_IDEA_CHARS 上限），而是【报错文案的出处】：
    // 413 的说法里只有字节数，422 的说法里会出现字段名 idea。
    const res = await raw(h.port, {
      method: "POST",
      path: "/tasks",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idea: "x".repeat(MAX_BODY_BYTES + 4096) }),
    });
    expect(res.status).toBe(413);
    expect(res.body).not.toMatch(/idea/u);
  });
});

/* ───────────── ④ SSE 真流与断开回收（§5.8） ───────────── */

describe("SSE 真流", () => {
  it("响应头：event-stream / last-event-id / 关缓冲", async () => {
    const h = await harness();
    const st = await openSigned(h, "/events?cursor=0");
    expect(await st.status()).toBe(200);
    const hs = await st.headers();
    expect(hs["content-type"]).toMatch(/text\/event-stream/u);
    expect(hs["last-event-id"]).toBe("0");
    expect(hs["x-accel-buffering"]).toBe("no");
    const got = await st.frames(1);
    expect(got[0]?.event).toBe("snapshot");
    expect(got[0]?.id).toBeUndefined(); // 快照帧没有 id（编一个 = 伪造游标）
    st.destroy();
  });

  it("带 cursor 的重连【真的补上了那几帧】，与不带的那次只差在帧数", async () => {
    const h = await harness();
    for (let i = 1; i <= 3; i++) {
      h.bus.publishPersisted(evt("task-1", "IN_PROGRESS", "IN_REVIEW"), i);
    }
    // 不带 cursor ⇒ begin：游标取当前 latestSeq=3 ⇒ 只有快照帧。
    const fresh = await openSigned(h, "/events");
    const a = await fresh.frames(1);
    expect(a.map((f) => f.id)).toEqual([undefined]);
    fresh.destroy();
    // 带 cursor=1 ⇒ 补发 2、3。两次请求【同一时刻、同一状态】，唯一差别是 query。
    // 这个对照的形状很重要：若 cursor 被忽略，两次结果【一模一样】，
    // 而那是最容易写错又最难发现的 bug（连接正常、也在推流、就是少几帧）。
    const resumed = await openSigned(h, "/events?cursor=1");
    const b = await resumed.frames(3);
    expect(b.map((f) => f.id)).toEqual([undefined, "2", "3"]);
    expect(b.length).not.toBe(a.length);
    resumed.destroy();
  });

  it("订阅只在游标之后【新落库】的事件上继续推（连接不是一次性读取）", async () => {
    const h = await harness();
    const st = await openSigned(h, "/events?cursor=0");
    await st.frames(1); // 只有快照
    h.bus.publishPersisted(evt("task-1", "IN_PROGRESS", "IN_REVIEW"), 1);
    const got = await st.frames(2); // 同一条连接上收到后到的那一帧
    expect(got[1]?.id).toBe("1");
    expect(JSON.parse(got[1]?.data ?? "{}").to).toBe("IN_REVIEW");
    st.destroy();
  });

  it("客户端断开 ⇒ 订阅【当场】回收，不等下一条事件", async () => {
    // 这是本文件存在的理由。§5.8：断开即回收其队列。
    // 在传输层之前，这条要求【只写在注释里】：handler 层的 stream 是个 async iterable，
    // 「消费者断开」那个概念根本不存在，写多少条单测都碰不到它。
    const h = await harness();
    const st = await openSigned(h, "/events?cursor=0");
    await st.frames(1);
    expect(h.bus.subscribers()).toBe(1); // 先证【真的挂着】，否则下面那句归零是恒真的

    st.destroy();
    // 【故意不 publish】。这一条要钉的就是「不需要有人再推一条才能发现连接没了」：
    // 老写法（for-await + 看 write 返回值）在这一步会停在 subscribers() === 1，
    // 要等一条无关事件才归零 —— 而单用户本机可能几小时没有事件，
    // 那意味着每个关掉的标签页长期占着一条订阅 + 一条有界队列。
    await untilZero(() => h.bus.subscribers());
    // 反例的形状：若 onClose 不接（或只在 frames() 的 finally 里 close），
    // 生成器正睡在 await 上、finally 跑不到，上面那句会停在 1。
    // 这个变异我跑过，确实红，而且是【等满超时】那种红，不是秒红 ——
    // 别因为它慢就以为是自己环境抖。
  });

  it("断开过的连接【不会把 error 变成未捕获异常】带走整个 Hub", async () => {
    // 断开之后进程还在、还能正常服务，这件事在这里不是顺带成立的：
    // res/socket 上冒出来的 error 事件【没有监听者】就是 uncaughtException，
    // 而 uncaughtException 的默认行为是【终止进程】—— 又一次「一个客户端带走所有 agent」。
    // 断言的形状：断连 + 推流之后，同进程还能完成一次签名请求。
    const h = await harness();
    const st = await openSigned(h, "/events?cursor=0");
    await st.frames(1);
    st.destroy();
    h.bus.publishPersisted(evt("task-1", "IN_PROGRESS", "IN_REVIEW"), 1);
    await new Promise((r) => setTimeout(r, 100));
    expect((await signed(h, "GET", "/tasks")).status).toBe(200);
  });

  it("回收之后新连接一切正常（没有残留的写队列）", async () => {
    const h = await harness();
    const s1 = await openSigned(h, "/events?cursor=0");
    await s1.frames(1);
    s1.destroy();
    await untilZero(() => h.bus.subscribers());
    const s2 = await openSigned(h, "/events?cursor=0");
    const got = await s2.frames(1); // 只有快照：上一条【没有】被 publish，别把它当成重放验证
    expect(got[0]?.event).toBe("snapshot");
    s2.destroy();
  });
});
