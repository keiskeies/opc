/**
 * Task 2.1 的三条 Test 项（计划原文）：
 *   ① SSE 断线重连后按游标续订不丢事件；
 *   ② 无 token 请求 401；
 *   ③ POST /approvals/:id 对不存在的 id 返回 404 且【不产生审计事件】。
 *
 * 写这个文件时的一条自我约束：【每条正向断言都要配一条反例】，否则它守不住任何东西。
 * 举两个本文件里真的出现过的例子：
 *  - 「404 不写审计」如果只断言 recordDecision 没被调用，那么把 decide() 整个删掉
 *    （任何请求都返回 404）也能过 —— 所以要配一条「存在的 id ⇒ 恰好调用一次」。
 *  - 「按游标续订不丢事件」如果只断言收到了 seq 3、4，那么把 resume(fromSeq) 换成
 *    begin()（从 latestSeq 续）在【事件还没发布】的夹具里同样能过 —— 所以必须
 *    【先发布、后续订】，并且额外钉一条「换错方法会丢」的对照（见下面那条
 *    「同一个夹具走 begin() 就收不到」）。这一条是整个文件里唯一会【主动证明
 *    另一种写法是错的】的断言，也是最贵的一条。
 *
 * 跑在【真迁移出来的库】上（同 test/acceptance/、test/budget/ 的立场）：
 * 「404 不写审计」这件事的判据是 events 表的行数，而那张表上有 append-only 触发器，
 * 自造的简化表既没有触发器、也不会因为写错而红 —— 那正是本仓认定自造表不可信的理由。
 */
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvalOutcome,
  decodeSseFrame,
  encodeSseFrame,
  isImplemented,
  type SseFrame,
} from "@opc/contracts";
import type { DomainEvent } from "../../src/events/bus.js";
import { InMemoryEventBus } from "../../src/events/bus.js";
import { migrate } from "../../src/db/migrate.js";
import {
  handleRequest,
  matchRoute,
  titleOf,
  type HubDeps,
  type HubRequest,
} from "../../src/http/app.js";
import { newLocalToken, signedHeaders, verifyRequest, NonceGuard } from "../../src/http/auth.js";
import { reconnectDelayMs, ResumeStream, shouldGiveUp } from "../../src/http/sse.js";

const HUB = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(HUB, ".tmp", "http");

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
let fileSeq = 0;

/** 每个用例一个【独立库文件】：脏行那条用例要往库里写坏数据，共享会串味。 */
async function newDb(taskId = "task-1"): Promise<Db> {
  const { openDb } = await import("../../src/db/driver.js");
  const db = openDb(join(TMP, "h-" + process.pid + "-" + ++fileSeq + ".db")) as unknown as Db;
  opened.push(db);
  migrate(db);
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
      "VALUES (?, ?, 'IN_PROGRESS', 'dev', 'implement', ?, ?)",
  ).run(taskId, "HTTP 契约用的任务", 1_700_000_000_000, 1_700_000_000_000);
  return db;
}

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
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
const TOKEN = newLocalToken();

/**
 * 一套 handler 依赖，附【recordDecision 被调用了几次】这个计数器。
 *
 * 这个计数器就是 Test 项 ③ 的全部判据，所以它的取值得站得住：
 * 判「有没有产生审计事件」如果去数 events 表的行数，那么在真总线上有其它事件在飞时
 * 是噪声；而 handler 唯一能写审计的路径就是 deps.recordDecision，
 * 数它等于数「这条请求有没有走到写审计那一步」—— 正是那条不变量的可测形态。
 */
async function harness(taskId = "task-1"): {
  deps: HubDeps;
  db: Db;
  bus: InMemoryEventBus;
  calls: { decision: number; created: number };
  sign: (method: string, path: string, body?: string) => Record<string, string>;
  req: (o: Partial<HubRequest> & { method: string; path: string }) => HubRequest;
  approvals: (id: string, status?: string) => void;
} {
  const db = await newDb(taskId);
  const bus = new InMemoryEventBus();
  const calls = { decision: 0, created: 0 };
  const nonces = new NonceGuard();
  const deps: HubDeps = {
    db: db as unknown as DatabaseSync,
    bus,
    token: TOKEN,
    now: () => NOW,
    nonces,
    recordDecision: async () => {
      calls.decision += 1;
      db.prepare("UPDATE approvals SET status = 'approved', decided_at = ? WHERE id = ?").run(
        NOW,
        taskId,
      );
      return true;
    },
    createTask: async () => {
      calls.created += 1;
    },
  };
  const sign = (method: string, path: string, body = ""): Record<string, string> =>
    signedHeaders(TOKEN, { method, path, body, now: NOW });
  return {
    deps,
    db,
    bus,
    calls,
    sign,
    approvals: (id: string, status = "pending") => {
      db.prepare(
        "INSERT INTO approvals (id, task_id, approval_type, summary, parameters, status) " +
          "VALUES (?, ?, 'strategic', 's', '{}', ?)",
      ).run(id, taskId, status);
    },
    req: (o) => ({
      query: {},
      headers: {},
      body: "",
      ...o,
    }),
  };
}

/* ───────────────────────── ② 无 token 请求 401 ───────────────────────── */

describe("② 鉴权：无 token 请求 401", () => {
  it("缺任一个签名头都是 401，且【不区分是哪个】", async () => {
    const h = await harness();
    for (const headers of [
      {},
      { "x-opc-timestamp": String(NOW), "x-opc-nonce": "n1" },
      { "x-opc-signature": "deadbeef", "x-opc-nonce": "n2" },
      { "x-opc-signature": "deadbeef", "x-opc-timestamp": String(NOW) },
    ]) {
      const res = await handleRequest(h.deps, h.req({ method: "GET", path: "/tasks", headers }));
      expect(res.status).toBe(401);
      // 报错体只有一句通用文案：不得把「缺哪个头 / 时间戳过期 / 签名不符」写进去。
      // 那三者对合法用户毫无用处（他要么全对要么全错），对攻击者却是一台
      // 免费告诉他「你已经过到哪一步」的预言机。
      expect(JSON.stringify(res.body)).not.toMatch(/signature|timestamp|nonce|stale/iu);
    }
  });

  it("token 从不出现在任何头里（它是 HMAC 密钥，不是口令）", async () => {
    const h = await harness();
    const headers = h.sign("GET", "/tasks");
    expect(Object.values(headers).join("|")).not.toContain(TOKEN);
    const res = await handleRequest(h.deps, h.req({ method: "GET", path: "/tasks", headers }));
    expect(res.status).toBe(200);
  });

  it("错误 token 签的名 ⇒ 401", async () => {
    const h = await harness();
    const headers = signedHeaders(newLocalToken(), {
      method: "GET",
      path: "/tasks",
      body: "",
      now: NOW,
    });
    const res = await handleRequest(h.deps, h.req({ method: "GET", path: "/tasks", headers }));
    expect(res.status).toBe(401);
  });

  it("签名之后【改了 body】⇒ 401（签名覆盖 body）", async () => {
    const h = await harness();
    const body = JSON.stringify({ idea: "原想法" });
    const headers = h.sign("POST", "/tasks", body);
    const res = await handleRequest(
      h.deps,
      h.req({ method: "POST", path: "/tasks", headers, body: JSON.stringify({ idea: "被换了" }) }),
    );
    expect(res.status).toBe(401);
    expect(h.calls.created).toBe(0);
  });

  it("【同一个签名换端点复用】⇒ 401（method+path 进规范串）", async () => {
    const h = await harness();
    // 只读端点上取到的合法签名，拿去 POST 审批。若规范串里不带 method+path，
    // 这一枪就能打中 —— 这类实现最常漏，而漏了的后果是「读一次就能写」。
    const stolen = h.sign("GET", "/tasks");
    const res = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/approvals/a-1",
        headers: { ...stolen, ...(h.sign("GET", "/tasks"), {}) },
        body: JSON.stringify({ resume: "approve" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("时间戳超出窗口 ⇒ 401；窗口内 ⇒ 通过", async () => {
    const h = await harness();
    const stale = signedHeaders(TOKEN, {
      method: "GET",
      path: "/tasks",
      body: "",
      now: NOW - 61_000,
    });
    expect(
      (await handleRequest(h.deps, h.req({ method: "GET", path: "/tasks", headers: stale })))
        .status,
    ).toBe(401);
    const ok = signedHeaders(TOKEN, { method: "GET", path: "/tasks", body: "", now: NOW - 59_000 });
    expect(
      (await handleRequest(h.deps, h.req({ method: "GET", path: "/tasks", headers: ok }))).status,
    ).toBe(200);
  });

  it("同一个 nonce 重放第二次 ⇒ 401；而【签名失败不烧掉 nonce】", () => {
    const nonces = new NonceGuard();
    const base = {
      token: TOKEN,
      method: "GET",
      path: "/tasks",
      body: "",
      now: NOW,
      nonces,
    };
    const good = signedHeaders(TOKEN, { method: "GET", path: "/tasks", body: "", now: NOW });
    const first = verifyRequest({ ...base, headers: good });
    expect(first.ok).toBe(true);
    expect(verifyRequest({ ...base, headers: good })).toEqual({
      ok: false,
      code: "replayed_nonce",
    });

    // 反例，也是这段真正的目的：攻击者【不需要破签名】，只要抢在合法请求之前
    // 用同一个 nonce 打一枪（签名故意错），就能让随后那次合法请求被判成重放。
    // 所以 nonce 只能在【整体通过】之后记账。
    const victim = signedHeaders(TOKEN, { method: "GET", path: "/tasks", body: "", now: NOW });
    const bogus = { ...victim, "x-opc-signature": "0".repeat(64) };
    expect(verifyRequest({ ...base, headers: bogus })).toEqual({
      ok: false,
      code: "bad_signature",
    });
    expect(verifyRequest({ ...base, headers: victim }).ok).toBe(true);
  });

  it("头名【大小写不同】也认（HTTP 头名不区分大小写）", async () => {
    const h = await harness();
    const s = h.sign("GET", "/tasks");
    const reshaped: Record<string, string> = {};
    for (const [k, v] of Object.entries(s)) reshaped[k.toUpperCase()] = v;
    const res = await handleRequest(h.deps, h.req({ method: "GET", path: "/tasks", headers: reshaped }));
    expect(res.status).toBe(200);
  });

  it("【未授权者拿不到端点清单】：不存在的路径也回 401，而不是 404/501", async () => {
    const h = await harness();
    // 鉴权排在路由【之前】。顺序反了的话，未授权者用 401 / 404 / 501 三种答复
    // 就能枚举出哪些路径存在、哪些已实现（501 尤其漏）。
    for (const p of ["/nope", "/replay/task-1", "/tasks"]) {
      const res = await handleRequest(h.deps, h.req({ method: "GET", path: p }));
      expect(res.status).toBe(401);
    }
  });

  it("已鉴权后：未知路径 404，未实现端点 501（两种「没有」可区分）", async () => {
    const h = await harness();
    expect(
      (
        await handleRequest(
          h.deps,
          h.req({ method: "GET", path: "/nope", headers: h.sign("GET", "/nope") }),
        )
      ).status,
    ).toBe(404);
    const res = await handleRequest(
      h.deps,
      h.req({ method: "GET", path: "/replay/task-1", headers: h.sign("GET", "/replay/task-1") }),
    );
    expect(res.status).toBe(501);
    expect(isImplemented("GET /replay/:taskId")).toBe(false);
  });
});

/* ───────────────── ③ 404 且不产生审计事件 ───────────────── */

describe("③ POST /approvals/:id", () => {
  const decideBody = (o: Record<string, unknown>): string => JSON.stringify(o);

  it("id 不存在 ⇒ 404 且【一次审计都不写】", async () => {
    const h = await harness();
    const body = decideBody({ resume: "approve" });
    const res = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/approvals/does-not-exist",
        headers: h.sign("POST", "/approvals/does-not-exist", body),
        body,
      }),
    );
    expect(res.status).toBe(404);
    expect(h.calls.decision).toBe(0);
    // 库侧再钉一次：approvals 与 events 都没有因这次请求而动。
    expect(h.db.prepare("SELECT COUNT(*) AS c FROM events").get()).toEqual({ c: 0 });
  });

  it("反例：存在的 pending 卡片 ⇒ 200 且【恰好一次】", async () => {
    const h = await harness();
    h.approvals("a-1");
    const body = decideBody({ resume: "approve" });
    const res = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/approvals/a-1",
        headers: h.sign("POST", "/approvals/a-1", body),
        body,
      }),
    );
    expect(res.status).toBe(200);
    expect((res.body as { replayed: boolean }).replayed).toBe(false);
    expect(h.calls.decision).toBe(1);
  });

  it("已决策过的卡片 ⇒ 200 replayed，且【不再写第二条审计】", async () => {
    const h = await harness();
    h.approvals("a-2", "approved");
    const body = decideBody({ resume: "approve" });
    const res = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/approvals/a-2",
        headers: h.sign("POST", "/approvals/a-2", body),
        body,
      }),
    );
    // 200 而不是 4xx：渲染进程要的答案是「我的点击生效了吗」，答案是生效了。
    // 回 4xx 会把一条【其实已经批准】的审批标红，那比重复点击更让人困惑。
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, replayed: true });
    expect(h.calls.decision).toBe(0);
  });

  it("判定函数层面：【404 与 replayed 两支在类型上都没有 audit】", () => {
    const missing = approvalOutcome({
      exists: false,
      taskId: "t",
      approvalId: "a",
      request: { resume: "approve" },
    });
    expect(missing.status).toBe(404);
    expect("audit" in missing).toBe(false);

    const replayed = approvalOutcome({
      exists: true,
      alreadyDecided: true,
      taskId: "t",
      approvalId: "a",
      request: { resume: "approve" },
    });
    expect(replayed.replayed).toBe(true);
    // 这条是【运行期】的钉子，配的是编译期那一条：判别式收窄让 TS 在 replayed:true
    // 这一支读不到 audit（改一下试试就知道），而这条断言保证将来有人
    // 「顺手把 audit 加回去」时这里会红 —— 类型约束没有测试配套的话，
    // 下一个人只会把类型改回去，而不是把逻辑改对。
    expect("audit" in replayed).toBe(false);

    const fresh = approvalOutcome({
      exists: true,
      taskId: "t",
      approvalId: "a",
      request: { resume: "approve" },
    });
    expect("audit" in fresh).toBe(true);
  });

  it("reject_with_comment 不带 note ⇒ 422（空理由的打回不可执行）", async () => {
    const h = await harness();
    h.approvals("a-3");
    const body = decideBody({ resume: "reject_with_comment" });
    const res = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/approvals/a-3",
        headers: h.sign("POST", "/approvals/a-3", body),
        body,
      }),
    );
    expect(res.status).toBe(422);
    expect(h.calls.decision).toBe(0);

    const withNote = decideBody({ resume: "reject_with_comment", note: "缺压测数据" });
    const ok = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/approvals/a-3",
        headers: h.sign("POST", "/approvals/a-3", withNote),
        body: withNote,
      }),
    );
    expect(ok.status).toBe(200);
  });

  it("resume 里没有批量语义（没有 approve_all）", async () => {
    const h = await harness();
    h.approvals("a-4");
    const body = decideBody({ resume: "approve_all" });
    const res = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/approvals/a-4",
        headers: h.sign("POST", "/approvals/a-4", body),
        body,
      }),
    );
    expect(res.status).toBe(422);
    expect(h.calls.decision).toBe(0);
  });
});

/* ───────────────── ① SSE 断线重连按游标续订不丢事件 ───────────────── */

/**
 * 取前 limit 帧，取不到就【在 2s 内失败】，不是一直等。
 *
 * 这个超时不是随手加的保险，而是被一次变异测出来的：把 handler 里的
 * resume(fromSeq) 换成 begin()（也就是「客户端的游标被忽略了」），
 * 下面那条断言并不会变红 —— 它拿不到那两帧，于是【永远挂在那里】，
 * 最后由 testTimeout 在 180 秒后报一句超时。一个要抓「事件丢了」的测试
 * 用挂死来表达失败，读起来像测试自己坏了，而那正是「事件静默丢失」这个
 * bug 本体的形状。所以这里主动设界，并把失败原因写成「等不到第 N 帧」。
 *
 * ⚠ 清理那段有个坑，写在这以免再踩：在【还挂着一个没落地的 next()】时
 * await it.return() 会【死锁】—— 异步生成器会把 return 请求排在 next 之后，
 * 而那个 next 正因为等不到帧而悬着。第一版的 finally 就是这么写的，
 * 于是「修泄漏」修出了一个比原来更难查的挂死（且只在失败路径上出现，
 * 正常路径全绿）。现在不等它：失败路径本来就要抛出，泄漏一条订阅无关紧要；
 * 【成功】路径由 frames(limit) 自己 return、由它自己的 finally 关订阅，
 * 那条才是「回收」断言真正要测的路径（见下面那条 subscribers() 的用例）。
 */
const FRAME_WAIT_MS = 2_000;

async function collect(
  stream: AsyncIterable<SseFrame>,
  limit: number,
): Promise<SseFrame[]> {
  const it = stream[Symbol.asyncIterator]();
  const out: SseFrame[] = [];
  try {
    while (out.length < limit) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const step = await Promise.race([
        it.next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "等不到第 " +
                    (out.length + 1) +
                    " 帧（已收 " +
                    out.length +
                    " 帧，要 " +
                    limit +
                    " 帧）。这不是慢：帧只有快照与事件两种来源，两者都不来就意味着" +
                    "【游标或订阅接错了】—— 典型形态是续订时用了 latestSeq 而不是调用方给的游标。",
                ),
              ),
            FRAME_WAIT_MS,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      if (step.done === true) {
        throw new Error(
          "流提前结束：收到 " +
            out.length +
            " 帧，要 " +
            limit +
            " 帧（订阅被 close 或游标接错）",
        );
      }
      out.push(step.value);
    }
    return out;
  } finally {
    if (out.length < limit) void it.return?.(undefined as never);
  }
}

const evt = (seq: number): DomainEvent => ({
  kind: "TaskStateChanged",
  taskId: "task-1",
  from: "IN_PROGRESS",
  to: "IN_REVIEW",
  seq,
}) as DomainEvent;

describe("① SSE 游标续订", () => {
  it("先发布、后用【旧游标】续订 ⇒ 一条不丢", async () => {
    const bus = new InMemoryEventBus();
    for (let s = 1; s <= 4; s++) bus.publishPersisted(evt(s) as DomainEvent, s);

    const stream = await ResumeStream.resume(bus, { name: "tasks", read: async () => ({}) }, 2);
    const frames = await collect(stream.frames(), 3); // snapshot + 2 条

    expect(frames[0]?.event).toBe("snapshot");
    expect(frames.map((f) => f.id)).toEqual([undefined, "3", "4"]);
    // 游标 2 之前那两条【不该】重发：客户端说「我处理到 2」，重发是噪音。
    expect(frames.some((f) => f.id === "1" || f.id === "2")).toBe(false);
  });

  it("对照：同一个夹具若【从 latestSeq 续】就收不到任何事件（这才证明上面那条测到了东西）", async () => {
    const bus = new InMemoryEventBus();
    for (let s = 1; s <= 4; s++) bus.publishPersisted(evt(s) as DomainEvent, s);
    // begin() 是【首次连接】那条路：它取当前 latestSeq 作游标。
    // 拿它做重连 = 把客户端「我缺 3、4」那句话抹掉，静默只发 5 之后的。
    // 这条断言的价值全在下面那句：无事件 = 事件丢了，而连接看着完全健康。
    const wrong = await ResumeStream.begin(bus, { name: "tasks", read: async () => ({}) });
    const frames = await collect(wrong.frames(2), 1);
    expect(frames.length).toBe(1);
    expect(frames[0]?.event).toBe("snapshot");
    expect(wrong.cursor).toBe(4);
    expect(wrong.snapshotBody).toEqual({});
  });

  it("首连的游标【在快照之前】取 ⇒ 快照期间落库的那条不会静默丢失", async () => {
    const bus = new InMemoryEventBus();
    bus.publishPersisted(evt(1) as DomainEvent, 1);
    let readHappened = false;
    const stream = await ResumeStream.begin(bus, {
      name: "tasks",
      read: async () => {
        // 模拟「读快照要花时间，期间落了第 2 条」—— 竞态的那个窗口。
        readHappened = true;
        bus.publishPersisted(evt(2) as DomainEvent, 2);
        return { tasks: [] };
      },
    });
    expect(readHappened).toBe(true);
    // 游标必须是【快照前】的 1，不是快照后的 2。是 2 的话第 2 条两头不靠：
    // 快照读它之前就已经取完游标、续订又从它之后开始 ⇒ 静默丢。
    expect(stream.cursor).toBe(1);
    const frames = await collect(stream.frames(), 2);
    expect(frames.map((f) => f.id)).toEqual([undefined, "2"]);
  });

  it("快照帧【不带 id】（给它编一个 id 等于伪造游标）", async () => {
    const bus = new InMemoryEventBus();
    const stream = await ResumeStream.begin(bus, { name: "tasks", read: async () => ({ ok: 1 }) });
    const [snapshot] = await collect(stream.frames(), 1);
    expect(snapshot?.id).toBeUndefined();
    const body = JSON.parse(String(snapshot?.data)) as { as_of_seq: number };
    expect(body.as_of_seq).toBe(0);
  });

  it("负数 / 小数游标 ⇒ 抛错，而不是夹紧到 0", async () => {
    const bus = new InMemoryEventBus();
    for (const bad of [-1, 1.5, Number.NaN]) {
      await expect(
        ResumeStream.resume(bus, { name: "tasks", read: async () => ({}) }, bad),
      ).rejects.toThrow(/非负整数/u);
      // 夹紧到 0 会让「客户端的游标管理错了」这件事【看起来成功】，
      // 代价是从头重放全部历史 —— 那是比报错难查得多的症状。
    }
  });

  it("取完就 close：bus.subscribers() 回到 0", async () => {
    const bus = new InMemoryEventBus();
    bus.publishPersisted(evt(1) as DomainEvent, 1);
    const stream = await ResumeStream.resume(bus, { name: "tasks", read: async () => ({}) }, 0);
    expect(bus.subscribers()).toBe(0);
    const it = stream.frames(1)[Symbol.asyncIterator]();
    await it.next(); // snapshot
    await it.next(); // seq 1 ⇒ 触发 limit 里的 return
    const tail = await it.next();
    expect(tail.done).toBe(true);
    // §5.8 明确要求「写失败即视为断开并回收队列」，而这是本仓认定的唯一回收证据。
    // 漏 close 泄漏的是连接加一条有界队列，dropped() 那种断言看不出来。
    expect(bus.subscribers()).toBe(0);
  });

  it("GET /events 的 cursor 参数：非法 422，合法则【真的】用它续订", async () => {
    const h = await harness();
    for (let s = 1; s <= 3; s++) h.bus.publishPersisted(evt(s) as DomainEvent, s);

    const bad = await handleRequest(
      h.deps,
      h.req({ method: "GET", path: "/events", headers: h.sign("GET", "/events"), query: { cursor: "abc" } }),
    );
    expect(bad.status).toBe(422);

    const good = await handleRequest(
      h.deps,
      h.req({ method: "GET", path: "/events", headers: h.sign("GET", "/events"), query: { cursor: "1" } }),
    );
    expect(good.status).toBe(200);
    expect(good.headers?.["content-type"]).toMatch(/text\/event-stream/u);
    // 参数【被用上】了：从 1 续 ⇒ 实得 2、3。若这里错误地复用 begin()，
    // 游标会变成 3 ⇒ 一帧事件都没有，而 status 仍然是 200。
    const frames = await collect(good.stream as AsyncIterable<SseFrame>, 3);
    expect(frames.map((f) => f.id)).toEqual([undefined, "2", "3"]);
    expect(good.headers?.["last-event-id"]).toBe("1");
  });

  it("环形缓冲吐掉了一段 ⇒ 降级标记跟着【现存最早那条】走，前端才知道要去拉快照", async () => {
    const bus = new InMemoryEventBus(2); // 只留最后两条
    for (let s = 1; s <= 6; s++) bus.publishPersisted(evt(s) as DomainEvent, s);
    const stream = await ResumeStream.resume(bus, { name: "tasks", read: async () => ({}) }, 0);
    const frames = await collect(stream.frames(), 3);
    const data = frames.slice(1).map((f) => JSON.parse(String(f.data)) as { seq: number; degraded?: true });
    expect(data.map((d) => d.seq)).toEqual([5, 6]);
    // 标记必须落在【现存最早】那条上。落在「下一条」上的话，慢消费者攒着的那批里
    // 带标记的那条可能已被挤出队列 ⇒ 永远收不到 degraded ⇒ 前端以为画面是全的。
    expect(data[0]?.degraded).toBe(true);
    expect(data[1]?.degraded).toBeUndefined();
  });
});

/* ───────────────── SSE 线格式（前后端共用一份编解码） ───────────────── */

describe("SSE 线格式", () => {
  it("编解码对偶，含多行 data", () => {
    const f: SseFrame = { event: "TaskStateChanged", id: "42", data: 'a\n{"b":1}\nc' };
    const back = decodeSseFrame(encodeSseFrame(f));
    expect(back).toEqual(f);
  });

  it("每帧以【空行】结尾（少一个换行 = 客户端静静收不到）", () => {
    expect(encodeSseFrame({ event: "x", data: "y" }).endsWith("\n\n")).toBe(true);
  });

  it("data 里的裸换行【不会截断事件】", () => {
    const raw = encodeSseFrame({ event: "notice", data: "第一行\n第二行" });
    expect(decodeSseFrame(raw).data).toBe("第一行\n第二行");
    // 反例的形态是「后半截被当成新字段解析掉」，所以钉一下字段数没变。
    expect(raw.split("\n").filter((l) => l.startsWith("event:")).length).toBe(1);
  });

  it("retry 非法 ⇒ 抛；空事件名 ⇒ 抛", () => {
    expect(() => encodeSseFrame({ event: "x", data: "y", retryMs: -1 })).toThrow();
    expect(() => encodeSseFrame({ event: "  ", data: "y" })).toThrow();
  });

  it("退避：有下限、有上限、按次数放弃", () => {
    expect(reconnectDelayMs(0)).toBe(500);
    expect(reconnectDelayMs(3)).toBe(4000);
    expect(reconnectDelayMs(99)).toBe(15_000); // 不会算成 Infinity / 几十分钟
    expect(shouldGiveUp(7)).toBe(false);
    expect(shouldGiveUp(8)).toBe(true);
    expect(() => reconnectDelayMs(-1)).toThrow();
  });
});

/* ───────────────── 路由与任务视图 ───────────────── */

describe("路由与视图", () => {
  it("空 id 段【不匹配】，而不是匹配成 id=\"\"", () => {
    expect(matchRoute("GET", "/tasks/")).toBeNull();
    // 中间的空段也一样：filter(s => s !== "") 会把它抹成一次合法匹配，
    // 于是「id 必须非空」那条判断变成死代码。
    expect(matchRoute("GET", "/tasks//abc")).toBeNull();
    expect(matchRoute("POST", "/approvals/")).toBeNull();
    expect(matchRoute("GET", "/tasks/abc")?.id).toBe("abc");
    expect(matchRoute("POST", "/tasks")).not.toBeNull();
    expect(matchRoute("DELETE", "/tasks")).toBeNull();
  });

  it("对外视图【不含】内部字段（state_snapshot / checkpoint 不发到渲染进程）", async () => {
    const h = await harness();
    const res = await handleRequest(
      h.deps,
      h.req({ method: "GET", path: "/tasks", headers: h.sign("GET", "/tasks") }),
    );
    const body = res.body as { tasks: Record<string, unknown>[] };
    expect(body.tasks.length).toBe(1);
    const row = body.tasks[0] as Record<string, unknown>;
    expect("state_snapshot" in row).toBe(false);
    expect("graph_checkpoint_id" in row).toBe(false);
    expect(row["consumed_cents"]).toBe(0);
    expect(typeof row["budget_cents"]).not.toBe("string"); // §6.1：美分整数，不是浮点美元
    expect(h.db.prepare("SELECT COUNT(*) AS c FROM tasks").get()).toEqual({ c: 1 });
  });

  it("GET /tasks/:id 找不到 ⇒ 404", async () => {
    const h = await harness();
    const res = await handleRequest(
      h.deps,
      h.req({ method: "GET", path: "/tasks/ghost", headers: h.sign("GET", "/tasks/ghost") }),
    );
    expect(res.status).toBe(404);
  });

  it("idea 校验：空 / 纯空白 / 超长 ⇒ 422；正常 ⇒ 201", async () => {
    const h = await harness();
    for (const idea of ["", "   ", "x".repeat(4001)]) {
      const body = JSON.stringify({ idea });
      const res = await handleRequest(
        h.deps,
        h.req({ method: "POST", path: "/tasks", headers: h.sign("POST", "/tasks", body), body }),
      );
      expect(res.status).toBe(422);
    }
    expect(h.calls.created).toBe(0);
    const body = JSON.stringify({ idea: "做一个能自动跑通的接单系统" });
    const ok = await handleRequest(
      h.deps,
      h.req({ method: "POST", path: "/tasks", headers: h.sign("POST", "/tasks", body), body }),
    );
    expect(ok.status).toBe(201);
    expect(h.calls.created).toBe(1);
  });

  it("JSON 写错 ⇒ 422 而不是 500（调用方能自己修的那一类）", async () => {
    const h = await harness();
    const body = "{not json";
    const res = await handleRequest(
      h.deps,
      h.req({ method: "POST", path: "/tasks", headers: h.sign("POST", "/tasks", body), body }),
    );
    expect(res.status).toBe(422);
  });

  it("超长标题被截断且【留下痕迹】", () => {
    const t = titleOf("x".repeat(500));
    expect(t.length).toBe(200);
    expect(t.endsWith("…")).toBe(true);
    expect(titleOf("  第一行\n第二行")).toBe("第一行");
  });

  it("库里读出脏行 ⇒ 500 且【报出字段】，而不是静默少一条", async () => {
    const h = await harness();
    h.db.prepare("UPDATE tasks SET status = '' WHERE id = 'task-1'").run();
    const res = await handleRequest(
      h.deps,
      h.req({ method: "GET", path: "/tasks", headers: h.sign("GET", "/tasks") }),
    );
    expect(res.status).toBe(500);
    const msg = JSON.stringify(res.body);
    expect(msg).toMatch(/status/u);
    // 「看板少了任务 #37、刷新又好了」是本仓最难查的一类失效。
    // 一个坏行让整条 GET 变红是【故意】的取舍，理由写在 app.ts 的 toTaskView 上。
    expect(msg).toMatch(/契约与库不一致/u);
  });

  it("状态名【拼错但非空】也拦得住（schema 只管到非空，对账在 hub 这一侧）", async () => {
    const h = await harness();
    // 这一条是 toTaskView 里那次 assertKnownStatus 的【唯一】存在证据。
    // 少了那个调用，这一行会带着 "IN_PROGRES" 顺利发到前端：API 200、日志干净、
    // schema 全绿，而前端按状态名分支渲染认不出来 ⇒ 那块卡片不画 ⇒
    // CEO 看到的是「任务凭空少了」。所以【不能】只测空字符串那一例 ——
    // 空串会被 schema 先拦掉，测不出状态名对账这条通路有没有接上。
    h.db.prepare("UPDATE tasks SET status = 'IN_PROGRES' WHERE id = 'task-1'").run();
    const res = await handleRequest(
      h.deps,
      h.req({ method: "GET", path: "/tasks", headers: h.sign("GET", "/tasks") }),
    );
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).toMatch(/IN_PROGRES/u);
    // 原型键同样不能混过去（状态名可能来自事件载荷）。
    h.db.prepare("UPDATE tasks SET status = 'constructor' WHERE id = 'task-1'").run();
    const proto = await handleRequest(
      h.deps,
      h.req({ method: "GET", path: "/tasks", headers: h.sign("GET", "/tasks") }),
    );
    expect(proto.status).toBe(500);
  });
});
