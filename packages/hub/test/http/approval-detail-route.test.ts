/**
 * `GET /approvals/:interruptId` —— 单张卡片详情（§9.2 第二行「关键参数快照」的落点）。
 *
 * ── 这个文件与 query.test.ts 的分工 ──────────────────────────────────
 * 那边测【读侧判据】：点查取哪几列、脏 parameters 的三种坏法、视图过一次 schema。
 * 这边测【判据 → 状态码 → 响应体】那一段，加两件事只有 HTTP 层能证：
 *  ① 列表与详情【字段面不同】这件事是真的（列表到今天还不带 parameters，
 *     本文件同时钉【详情带】与【列表不带】两侧 —— 只钉一侧的话，
 *     「把 parameters 塞进列表」那一次改动不会红，而那正是 app.ts
 *     「不该被塞进列表接口当作副产品」那句话要拦的动作）；
 *  ② 一次性审批 token【打不到】这一条。
 *
 * ── ②那一发为什么不是 tokens-route.test.ts 那发的抄件 ──────────────
 * 那边钉的是 `GET /tasks` 带票 ⇒ 401，挡的是 `kind === "list_tasks"` 那一格。
 * 挡这一条的是 remoteTokenAuth 顶上同一句 `hit.kind !== "decide"`，
 * 而它【按 kind 判】：有人把白名单放宽成 `decide || get_approval`
 * ——正是 app.ts 里预言的「读收件箱时那一次很自然的改动」——
 * 那一发【照样绿】（GET /tasks 不在新白名单里），这一发才红。
 * 所以这一发买的是【这一条路由自己的】可达面，不是重复覆盖。
 * 反向对照配在同一发里（同一张票打在 POST /approvals/:id ⇒ 200）：
 * 少了它，这个 401 可能只是「这条路由根本不通」。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { InMemoryEventBus } from "../../src/events/bus.js";
import {
  type HubDeps,
  type HubRequest,
  handleRequest,
  matchRoute,
} from "../../src/http/app.js";
import { newLocalToken, signedHeaders } from "../../src/http/auth.js";
import { LOOPBACK_HOST } from "../../src/http/bind.js";
import {
  hashToken,
  issueToken,
  newApprovalToken,
  redeemToken,
} from "../../src/http/tokens.js";
import { DRIVER_OFF } from "../fixtures/driver-state.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("http-approval-detail", import.meta.url);

const NOT_FOUND = 404;
const UNAUTHORIZED = 401;
const NOW = 1_700_000_000_000;
const TOKEN = newLocalToken();
const LAN_PEER = "192.168.1.7";
const TOKEN_HEADER = "x-opc-approval-token";
const DECIDE_BODY = JSON.stringify({ resume: "approve" });

type Row = Record<string, unknown>;
/**
 * 夹具里的库就是【真类型】，不是手搓的结构替身。
 *
 * 我第一版照抄了 contract.test.ts 那个 `Db = { prepare: …; exec: …; close: … }`
 * 的形状，于是 `migrate(db)` 当场 TS2345（结构类型对不上 `DatabaseSync`），
 * 而修法要么是把基线配额 24→25 抬一格，要么是换写法。选后者，理由有两条：
 *  ① 仓里已经有这件事的【正解先例】（migrate.test.ts:24 / schema-0001.test.ts:28
 *     都写 `type Db = DatabaseSync;`）—— 有先例而另起一式，就是本仓一直拒的那种第二份；
 *  ② 那个替身还【逼出】四处 `as unknown as` / `as never` 强转（openDb 返回、
 *     HubDeps.db、issueToken、redeemToken），而每一处强转都是"以后真类型变了
 *     这里不报"的一次买断（0058 §7 那句 `as never` 同一条账）。换成真类型之后
 *     那四处【全部拆掉了】—— 这是选它的实际收益，不是口味。
 * ⚠ 那四个既有文件（contract / server / tokens-route 与 bind 那一族）里的同款错误
 *   仍在 TYPE_BASELINE 的 24 里，【本轮不动它们】：改一份存量类型替身是一次独立改动，
 *   塞进这一发会让"新端点"这件事的 diff 里混进四个无关文件。
 */
type Db = DatabaseSync;

const opened: Db[] = [];
let fileSeq = 0;

async function newDb(): Promise<Db> {
  const { openDb } = await import("../../src/db/driver.js");
  // 这里【没有】`as unknown as Db`：openDb 的返回本来就是 DatabaseSync（见上面 Db 那段）。
  const db = openDb(join(TMP, "ad-" + process.pid + "-" + ++fileSeq + ".db"));
  opened.push(db);
  migrate(db);
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
      "VALUES (?, ?, 'IN_PROGRESS', 'dev', 'implement', ?, ?)",
  ).run("task-1", "详情路由用的任务", NOW, NOW);
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

/**
 * 一张卡。`params` 直接给【要落库的那段文本】而不是对象 —— 本文件有一发要往库里
 * 塞非 JSON 字符串，能填文本才塞得进去（那种行是真会有的：0026 之前写的卡、
 * 一次旁路插入。DDL 的 NOT NULL 管不到它是不是 JSON）。
 */
function card(
  db: Db,
  id: string,
  o: {
    params?: string;
    type?: string;
    status?: string;
    decidedBy?: string | null;
    decidedAt?: number | null;
    note?: string | null;
    evidence?: string | null;
  } = {},
): void {
  db.prepare(
    "INSERT INTO approvals (id, task_id, approval_type, summary, parameters, status, " +
      "decided_by, decided_at, decision_note, evidence_refs) " +
      "VALUES (?, ?, ?, '一句话摘要', ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    "task-1",
    o.type ?? "strategic",
    o.params ?? "{}",
    o.status ?? "pending",
    o.decidedBy ?? null,
    o.decidedAt ?? null,
    o.note ?? null,
    o.evidence ?? null,
  );
}

function mint(db: Db, approvalId: string): string {
  const raw = newApprovalToken();
  issueToken(db, { rawToken: raw, approvalId, nowMs: NOW });
  return raw;
}

function tokenUsed(db: Db, raw: string): boolean {
  const row = db
    .prepare("SELECT used FROM im_tokens WHERE token = ?")
    .get(hashToken(raw)) as Row | undefined;
  return Number(row?.["used"] ?? 0) !== 0;
}

async function harness(): Promise<{
  deps: HubDeps;
  db: Db;
  calls: { decision: number; resumed: string[] };
  sign: (
    method: string,
    target: string,
    body?: string,
  ) => Record<string, string>;
  req: (
    o: Partial<HubRequest> & { method: string; path: string },
  ) => HubRequest;
}> {
  const db = await newDb();
  const calls = { decision: 0, resumed: [] as string[] };
  const deps: HubDeps = {
    db,
    bus: new InMemoryEventBus(),
    token: TOKEN,
    now: () => NOW,
    recordDecision: async () => {
      calls.decision += 1;
      return true;
    },
    createTask: async () => {},
    resumeGraph: async (id: string) => {
      calls.resumed.push(id);
    },
    driverState: () => DRIVER_OFF,
    // 注入点接【真 tokens.ts + 真库】（同 tokens-route.test.ts 的理由：替身随手回一个
    // 自造字符串也能过，而这一发要的正是「真票真烧」）。
    redeemApprovalToken: async ({ token, approvalId }) => {
      const r = redeemToken(db, {
        rawToken: token,
        nowMs: NOW,
        expectedApprovalId: approvalId,
      });
      return r.ok === true
        ? { ok: true, taskId: r.taskId }
        : { ok: false, reason: r.reason };
    },
  };
  const sign = (
    method: string,
    target: string,
    body = "",
  ): Record<string, string> =>
    signedHeaders(TOKEN, { method, target, body, now: NOW });
  return {
    deps,
    db,
    calls,
    sign,
    // 签名由这里做（同 contract.test.ts 的 harness）：让每个用例自己拼 target
    // = 安排一次遗忘。偏离（空 headers / 别处的签名）才是显式传 headers 的理由。
    //
    // ⚠ target 由 path + query 拼出，【不是】把 query 写进 path。第一版我图省事
    // 传了 `path: "/approvals?status=pending"`，那一发拿到 404：路由读的是 path
    // （不含 query，见 HubRequest.path 的注释），带问号的这一段匹不上任何一条，
    // 而失败长相是「详情路由没接上」，真相是夹具把 URL 写错了。
    // 鉴权签的又是 target（含 query），所以带 query 的请求必须【两份都给】——
    // 同 auth.ts 里 canonicalString 那条真 socket 教训。
    req: (o) => {
      const qs = Object.entries(o.query ?? {})
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => k + "=" + (v as string))
        .join("&");
      const target = o.path + (qs === "" ? "" : "?" + qs);
      return {
        query: {},
        body: "",
        ...o,
        target,
        peer: o.peer ?? LOOPBACK_HOST,
        headers: o.headers ?? sign(o.method, target, o.body ?? ""),
      };
    },
  };
}

describe("① 路由形状", () => {
  it("GET 带 id ⇒ 详情；不带 id ⇒ 列表；两者不互相抢", () => {
    expect(matchRoute("GET", "/approvals/a-1")?.kind).toBe("get_approval");
    expect(matchRoute("GET", "/approvals/a-1")?.id).toBe("a-1");
    expect(matchRoute("GET", "/approvals")?.kind).toBe("list_approvals");
    // 空段判【不匹配】。让它匹配成 id="" 的后果是拿空串查库、查不到、
    // 报「这张卡不存在」—— 把 URL 写错伪装成资源不存在（get_task 同一条论证）。
    expect(matchRoute("GET", "/approvals/")).toBeNull();
    expect(matchRoute("GET", "/approvals/a/b")).toBeNull();
  });
});

describe("② 详情把参数快照带出来，列表不带（那一行参数的两面）", () => {
  it("⭐ parameters 原文进详情，且金额那一格在里面", async () => {
    const h = await harness();
    card(h.db, "d-1", {
      params: JSON.stringify({
        amount_cents: 1250,
        impact_scope: "生产库",
        irreversible: true,
        recommendation: "上线",
        recommendation_is_not_decision: true,
        timeout_behavior: "auto_reject",
      }),
    });
    const res = await handleRequest(
      h.deps,
      h.req({ method: "GET", path: "/approvals/d-1" }),
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      approval: Record<string, unknown>;
      asOfMs: number;
    };
    expect(body.approval["parameters"]).toEqual({
      amount_cents: 1250,
      impact_scope: "生产库",
      irreversible: true,
      recommendation: "上线",
      recommendation_is_not_decision: true,
      timeout_behavior: "auto_reject",
    });
    expect(body.asOfMs).toBe(NOW);
    // 列表侧的反面：同一次调用里再打一发列表，parameters 一个字节都不许在里面。
    // 分开的两条用例做不到这件事 —— 「列表不带」与「详情带」必须在同一张卡上比，
    // 否则「列表里那张卡恰好没有参数」会让 toContain 那一发假绿。
    const list = await handleRequest(
      h.deps,
      h.req({
        method: "GET",
        path: "/approvals",
        query: { status: "pending" },
      }),
    );
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain("生产库");
    expect(JSON.stringify(list.body)).toContain("d-1"); // 那张卡确实在列表里
  });

  it("⭐ 已决卡的 decided_by / decided_at / decision_note 只在详情里出现", async () => {
    const h = await harness();
    card(h.db, "d-2", {
      status: "rejected",
      decidedBy: "ceo",
      decidedAt: NOW + 1,
      note: "P0 缺陷没修完就上",
    });
    const res = await handleRequest(
      h.deps,
      h.req({ method: "GET", path: "/approvals/d-2" }),
    );
    expect(res.status).toBe(200);
    const a = (res.body as { approval: Record<string, unknown> }).approval;
    expect(a["decided_by"]).toBe("ceo");
    expect(a["decided_at"]).toBe(NOW + 1);
    expect(a["decision_note"]).toBe("P0 缺陷没修完就上");
    // 详情【不按 status 过滤】：已决的那一张也读得到（「我上周批的是什么来着」）。
    // 列表默认只列 pending，所以这个对照必须是显式那一档。
    const list = await handleRequest(
      h.deps,
      h.req({
        method: "GET",
        path: "/approvals",
        query: { status: "rejected" },
      }),
    );
    const row = (
      list.body as { approvals: Record<string, unknown>[] }
    ).approvals.find((r) => r["id"] === "d-2");
    expect(row).toBeDefined();
    expect(row?.["decision_note"]).toBeUndefined();
  });

  it("pending 卡上那三格是 null，而不是缺键", async () => {
    const h = await harness();
    card(h.db, "d-3");
    const res = await handleRequest(
      h.deps,
      h.req({ method: "GET", path: "/approvals/d-3" }),
    );
    const a = (res.body as { approval: Record<string, unknown> }).approval;
    // 「没有决定」与「没带这个字段」在界面上必须是两种可读的形状 —— 后者会让
    // 渲染层写一段 `if ("decided_at" in a)` 的分支，而它永远不为真。
    expect(a).toHaveProperty("decided_by", null);
    expect(a).toHaveProperty("decided_at", null);
    expect(a).toHaveProperty("decision_note", null);
  });
});

describe("③ 脏 parameters 不能让详情页 500", () => {
  it("⭐ 不是 JSON ⇒ 200 + parameters: null（那一页是给人批钱的，不是给人看堆栈的）", async () => {
    const h = await harness();
    for (const [id, raw] of [
      ["bad-1", "这不是 JSON"],
      ["bad-2", '"一个标量"'],
      ["bad-3", "[1,2,3]"],
    ] as const) {
      card(h.db, id, { params: raw });
      const res = await handleRequest(
        h.deps,
        h.req({ method: "GET", path: "/approvals/" + id }),
      );
      expect(res.status, id).toBe(200);
      const a = (res.body as { approval: Record<string, unknown> }).approval;
      // null 的意思是【读不出来】，界面据此写「参数快照读不出来」。
      // 空对象 {} 才是「读出来了、里面什么都没有」—— 两种不许合并。
      expect(a["parameters"], id).toBeNull();
      // 卡片其余部分照常（少一行参数 ≠ 整张卡不存在）。
      expect(a["id"], id).toBe(id);
      expect(a["summary"], id).toBe("一句话摘要");
    }
  });

  it("空对象 parameters ⇒ 空对象，不是 null", async () => {
    const h = await harness();
    card(h.db, "d-empty", { params: "{}" });
    const res = await handleRequest(
      h.deps,
      h.req({ method: "GET", path: "/approvals/d-empty" }),
    );
    expect(
      (res.body as { approval: Record<string, unknown> }).approval[
        "parameters"
      ],
    ).toEqual({});
  });
});

describe("④ id 不存在 ⇒ 404，且什么都不写", () => {
  it("⭐ 404 带着 id，审计与图恢复一次都没被碰", async () => {
    const h = await harness();
    const res = await handleRequest(
      h.deps,
      h.req({ method: "GET", path: "/approvals/nope" }),
    );
    expect(res.status).toBe(NOT_FOUND);
    expect(res.body).toEqual({ error: "approval not found", id: "nope" });
    expect(h.calls.decision).toBe(0);
    expect(h.calls.resumed).toEqual([]);
  });

  it("空 id 段那一发在【路由层】就断，不到查库那一步", async () => {
    const h = await harness();
    const res = await handleRequest(
      h.deps,
      h.req({ method: "GET", path: "/approvals/" }),
    );
    expect(res.status).toBe(NOT_FOUND);
    // 两种 404 必须可分辨：`no such route` 是「你 URL 写错了」，
    // `approval not found` 是「这张卡不存在」。合成一句就等于把前者说成后者。
    expect(res.body).toEqual({ error: "no such route" });
  });
});

describe("⑤ 一次性审批 token 打不到详情（§20.3 只授权「审批」这一件事出本机）", () => {
  it("⭐ 带真签名 + 带票的远程详情 ⇒ 401，同一张票打在 decide 上 ⇒ 200", async () => {
    const h = await harness();
    card(h.db, "t-1");
    const raw = mint(h.db, "t-1");
    const detail = await handleRequest(
      h.deps,
      h.req({
        method: "GET",
        path: "/approvals/t-1",
        peer: LAN_PEER,
        // 真签名代表「对端拿到了本机密钥」。它在现实里不可能，而这一发要问的不是
        // 「他能不能签」，是【挡住他的是哪一道】：不带签名的话，401 可能只是
        // 「远程反正签不出」，那一发就是一条恒绿的装饰（tokens-route 同一手法）。
        headers: { ...h.sign("GET", "/approvals/t-1"), [TOKEN_HEADER]: raw },
      }),
    );
    expect(detail.status).toBe(UNAUTHORIZED);
    // 票【没被烧】：被拒的请求不该消耗一次性的凭据。
    expect(tokenUsed(h.db, raw)).toBe(false);

    // 反向对照（同一张票、同一个对端）：打在它本来的那条路由上 ⇒ 过鉴权。
    // 少了这一发，上面那个 401 就同时兼容「这条票坏了」「这台 Hub 挂了」两种解释。
    const decide = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/approvals/t-1",
        peer: LAN_PEER,
        body: DECIDE_BODY,
        headers: { [TOKEN_HEADER]: raw },
      }),
    );
    expect(decide.status).not.toBe(UNAUTHORIZED);
    expect(tokenUsed(h.db, raw)).toBe(true);
  });

  it("回环侧不受影响：桌面端是本机进程，它走 HMAC", async () => {
    const h = await harness();
    card(h.db, "t-2");
    const res = await handleRequest(
      h.deps,
      h.req({ method: "GET", path: "/approvals/t-2", peer: LOOPBACK_HOST }),
    );
    expect(res.status).toBe(200);
  });

  it("远程裸发（不带票、不带签名）⇒ 401，且 body 里连 reason 都没有", async () => {
    const h = await harness();
    card(h.db, "t-3");
    const res = await handleRequest(
      h.deps,
      h.req({
        method: "GET",
        path: "/approvals/t-3",
        peer: LAN_PEER,
        headers: {},
      }),
    );
    expect(res.status).toBe(UNAUTHORIZED);
    expect(res.body).toEqual({ error: "unauthorized" });
  });
});
