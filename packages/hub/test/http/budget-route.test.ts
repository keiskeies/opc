/**
 * GET/POST /budget 路由对外开放的那一面。
 *
 * 与 test/budget/、test/charter/store.test.ts 落预算那一发的分工：那些验
 * tracker/budget-sync 的语义；这里验 HTTP 这一层：路由形状、回环门、请求体
 * 枚举与整数美分的严格程度、upsert 走 UNIQUE(scope_type,scope_id,period)、
 * 审计的 alarm_silenced，以及 GET 的 totals / unset_scopes 两格口径。
 *
 * 库与队列都是真的（同 org-route.test.ts / charter-route.test.ts）。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HTTP_NOT_IMPLEMENTED, HTTP_UNPROCESSABLE } from "@opc/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
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
  assertLoopbackBudgetRoute,
  budgetListRoute,
  putBudgetRoute,
} from "../../src/http/budget.js";
import { DRIVER_OFF } from "../fixtures/driver-state.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("http-budget-route", import.meta.url);

const UNAUTHORIZED = 401;
const LAN_PEER = "192.168.1.7";
const T0 = 1_700_000_000_000;

const queues: WriteQueue[] = [];
let fileSeq = 0;

type Row = Record<string, unknown>;
type Db = {
  prepare: (sql: string) => {
    all: (...a: unknown[]) => Row[];
    get: (...a: unknown[]) => Row | undefined;
    run: (...a: unknown[]) => unknown;
  };
};

function body(o: Record<string, unknown>): string {
  return JSON.stringify(o);
}

/** 一份合法的 POST /budget 请求体，逐用例覆写要破坏的那一格。 */
function okBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scope_type: "company",
    scope_id: "company",
    period: "daily",
    limit_cents: 50000,
    hard_stop: true,
    ...over,
  };
}

interface Harness {
  readonly deps: HubDeps;
  readonly db: Db;
  readonly write: Db;
  readonly sign: (
    method: string,
    target: string,
    body?: string,
  ) => Record<string, string>;
  readonly req: (
    o: Partial<HubRequest> & { method: string; path: string },
  ) => HubRequest;
}

/** wired:false ⇒ 不挂 budgetWriter ⇒ 该路由 501。 */
function harness(o: { wired?: boolean } = {}): Harness {
  const path = join(TMP, "bg-" + process.pid + "-" + ++fileSeq + ".db");
  const queue = new WriteQueue(path);
  queues.push(queue);
  const write = queue.writeConnection() as unknown as Db;
  migrate(write as never);
  const read = queue.readConnection() as unknown as Db;
  const token = newLocalToken();
  const clock = () => T0;
  const sign = (
    method: string,
    target: string,
    body = "",
  ): Record<string, string> =>
    signedHeaders(token, { method, target, body, now: clock() });
  const deps: HubDeps = {
    db: read as never,
    bus: new InMemoryEventBus(),
    token,
    now: clock,
    recordDecision: async () => true,
    createTask: async () => {},
    resumeGraph: async () => {},
    driverState: () => DRIVER_OFF,
    ...(o.wired === false ? {} : { budgetWriter: queue }),
  };
  return {
    deps,
    db: read,
    write,
    sign,
    req: (q) => {
      const target = q.path;
      return {
        query: {},
        body: "",
        ...q,
        target,
        peer: q.peer ?? LOOPBACK_HOST,
        headers: q.headers ?? sign(q.method, target, q.body ?? ""),
      };
    },
  };
}

/** 往库里塞一张生效组织图（只读节点集合用，不参与校验 —— readLatestGraph 只 JSON.parse）。 */
function seedGraph(db: Db, roles: string[]): void {
  const nodes: Record<string, unknown> = {};
  for (const r of roles) {
    nodes[r] = {
      role_id: r,
      can_manage: false,
      reports_to: null,
      model_family: "gpt",
    };
  }
  db.prepare(
    "INSERT INTO delegation_graphs (id, version, graph_json, effective_from, created_by, change_summary) " +
      "VALUES ('g1', 1, ?, ?, 'ceo', '夹具组织图')",
  ).run(JSON.stringify({ nodes, edges: [] }), T0);
}

function events(db: Db): Row[] {
  return db
    .prepare(
      "SELECT action, task_id, target, payload, actor_type, actor_id FROM events ORDER BY id",
    )
    .all();
}

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterAll(async () => {
  for (const q of queues) {
    try {
      await q.close();
    } catch {
      /* 已关 */
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});

/* ══════════════════ ① 路由形状 ══════════════════ */

describe("① matchRoute：budget 两条是单段字面，方法不互换", () => {
  it("GET/POST /budget 各匹各的；/budget/x、PUT、DELETE 打不到", () => {
    expect(matchRoute("GET", "/budget")).toEqual({
      kind: "list_budget",
      endpoint: "GET /budget",
    });
    expect(matchRoute("POST", "/budget")?.kind).toBe("put_budget");
    expect(matchRoute("GET", "/budget/")).toBeNull();
    expect(matchRoute("GET", "/budget/company")).toBeNull();
    expect(matchRoute("PUT", "/budget")).toBeNull();
    expect(matchRoute("DELETE", "/budget")).toBeNull();
  });
});

/* ══════════════════ ② 回环门 ══════════════════ */

describe("② 回环门：直接调 handler 时非回环对端 401 且零写入", () => {
  it("⭐ gate 对 LAN 401 / 回环 null；handler 挡住后 budgets 与 events 都是零行", async () => {
    const h = harness({ wired: true });
    expect(
      assertLoopbackBudgetRoute(
        h.req({
          method: "POST",
          path: "/budget",
          peer: LAN_PEER,
          body: body(okBody()),
        }),
      ),
    ).toEqual({ status: UNAUTHORIZED, body: { error: "unauthorized" } });
    const res = await putBudgetRoute(
      h.deps,
      h.req({
        method: "POST",
        path: "/budget",
        peer: LAN_PEER,
        body: body(okBody()),
      }),
    );
    expect(res.status).toBe(UNAUTHORIZED);
    expect(
      Number(h.db.prepare("SELECT count(*) AS n FROM budgets").get()?.n),
    ).toBe(0);
    expect(events(h.db)).toHaveLength(0);
  });
});

/* ══════════════════ ③ 装配未接 ⇒ 501 ══════════════════ */

describe("③ 装配没接 budgetWriter ⇒ 501", () => {
  it("501 且消息点名 budgetWriter", async () => {
    const h = harness({ wired: false });
    const res = await putBudgetRoute(
      h.deps,
      h.req({ method: "POST", path: "/budget", body: body(okBody()) }),
    );
    expect(res.status).toBe(HTTP_NOT_IMPLEMENTED);
    expect(JSON.stringify(res.body)).toContain("budgetWriter");
  });
});

/* ══════════════════ ④ 请求体严格 ══════════════════ */

describe("④ 请求体：枚举、整数美分、无多余键，全 422 且零写入", () => {
  it("⭐ 枚举外的 scope_type / period、负数、小数、空 scope_id、多余键 ⇒ 422", async () => {
    const h = harness({ wired: true });
    const badBodies: Record<string, unknown>[] = [
      okBody({ scope_type: "org" }),
      okBody({ period: "weekly" }),
      okBody({ limit_cents: -1 }),
      okBody({ limit_cents: 10.5 }),
      okBody({ scope_id: "" }),
      okBody({ hard_stop: "yes" }),
      { ...okBody(), actor: "ceo" },
    ];
    for (const b of badBodies) {
      const res = await putBudgetRoute(
        h.deps,
        h.req({ method: "POST", path: "/budget", body: body(b) }),
      );
      expect(res.status).toBe(HTTP_UNPROCESSABLE);
    }
    // 反例对照：同一装配同一形状只把坏格改回去 ⇒ 200。少了这发，上面循环可能只是恒 422。
    const good = await putBudgetRoute(
      h.deps,
      h.req({ method: "POST", path: "/budget", body: body(okBody()) }),
    );
    expect(good.status).toBe(200);
    expect(
      Number(h.db.prepare("SELECT count(*) AS n FROM budgets").get()?.n),
    ).toBe(1);
  });
});

/* ══════════════════ ⑤ upsert 语义 + 审计 ══════════════════ */

describe("⑤ upsert 走 UNIQUE 三元组，审计逐次留痕且说得出 changed / alarm_silenced", () => {
  it("⭐ 同 (scope,scope_id,period) 打两次 ⇒ 表里仍一行、limit 换；换回旧值 changed:false 仍留审计", async () => {
    const h = harness({ wired: true });
    const a = await putBudgetRoute(
      h.deps,
      h.req({
        method: "POST",
        path: "/budget",
        body: body(
          okBody({ scope_type: "role", scope_id: "dev", limit_cents: 500 }),
        ),
      }),
    );
    expect(a.status).toBe(200);
    expect(a.body).toEqual({ ok: true });
    const b = await putBudgetRoute(
      h.deps,
      h.req({
        method: "POST",
        path: "/budget",
        body: body(
          okBody({
            scope_type: "role",
            scope_id: "dev",
            limit_cents: 900,
            hard_stop: false,
          }),
        ),
      }),
    );
    expect(b.status).toBe(200);

    const rows = h.db
      .prepare("SELECT id, limit_cents, hard_stop, consumed_cents FROM budgets")
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: "role|dev|daily",
      limit_cents: 900,
      hard_stop: 0,
      consumed_cents: 0,
    });

    const ev = events(h.db);
    expect(ev).toHaveLength(2);
    expect(ev[0]).toMatchObject({
      action: "state_change",
      task_id: null,
      target: "role|dev|daily",
      actor_type: "human",
      actor_id: "ceo",
    });
    expect(JSON.parse(String(ev[0]?.payload))).toMatchObject({
      kind: "budget_limit_put",
      previous_limit_cents: null,
      limit_cents: 500,
      changed: true,
      alarm_silenced: false,
    });
    expect(JSON.parse(String(ev[1]?.payload))).toMatchObject({
      previous_limit_cents: 500,
      limit_cents: 900,
      hard_stop: false,
      changed: true,
    });
  });

  it("⭐ 值原样再 PUT 一次 ⇒ changed:false（DO UPDATE 按匹配计 changes，靠比旧值判）", async () => {
    const h = harness({ wired: true });
    await putBudgetRoute(
      h.deps,
      h.req({ method: "POST", path: "/budget", body: body(okBody()) }),
    );
    await putBudgetRoute(
      h.deps,
      h.req({ method: "POST", path: "/budget", body: body(okBody()) }),
    );
    const ev = events(h.db);
    expect(ev).toHaveLength(2);
    expect(JSON.parse(String(ev[1]?.payload))).toMatchObject({
      changed: false,
    });
    expect(
      Number(h.db.prepare("SELECT count(*) AS n FROM budgets").get()?.n),
    ).toBe(1);
  });

  it("⭐ 把上限调到已消费量之下 ⇒ 审计 alarm_silenced:true（突破警报永久哑，必须说出来）", async () => {
    const h = harness({ wired: true });
    await putBudgetRoute(
      h.deps,
      h.req({
        method: "POST",
        path: "/budget",
        body: body(
          okBody({ scope_type: "role", scope_id: "dev", limit_cents: 500 }),
        ),
      }),
    );
    h.write
      .prepare(
        "UPDATE budgets SET consumed_cents = 700 WHERE id = 'role|dev|daily'",
      )
      .run();
    await putBudgetRoute(
      h.deps,
      h.req({
        method: "POST",
        path: "/budget",
        body: body(
          okBody({ scope_type: "role", scope_id: "dev", limit_cents: 300 }),
        ),
      }),
    );
    const ev = events(h.db);
    expect(JSON.parse(String(ev[1]?.payload))).toMatchObject({
      alarm_silenced: true,
      previous_limit_cents: 500,
      limit_cents: 300,
    });
    // 反例对照：第一次插入（prev 为 null）时 consumed 无从谈起 ⇒ 那一发是 false，见上一发。
  });
});

/* ══════════════════ ⑥ GET /budget ══════════════════ */

describe("⑥ GET /budget：rows 全表 + totals；unset_scopes 组织图优先、退到 tasks", () => {
  it("空库 ⇒ rows 空数组、三个汇总数全 0（不是 404）", () => {
    const h = harness({ wired: true });
    const res = budgetListRoute(h.deps);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      rows: [],
      totals: { limit_cents: 0, consumed_cents: 0, unset_scopes: 0 },
    });
  });

  it("⭐ 两格之后 ⇒ rows 逐格带 hard_stop 布尔，totals 求和；body 可 JSON 化（bigint 若漏 Number() 会在这抛）", async () => {
    const h = harness({ wired: true });
    await putBudgetRoute(
      h.deps,
      h.req({
        method: "POST",
        path: "/budget",
        body: body(okBody({ limit_cents: 50000, hard_stop: true })),
      }),
    );
    await putBudgetRoute(
      h.deps,
      h.req({
        method: "POST",
        path: "/budget",
        body: body(
          okBody({
            scope_type: "role",
            scope_id: "dev",
            period: "per_task",
            limit_cents: 800,
            hard_stop: false,
          }),
        ),
      }),
    );
    h.write
      .prepare(
        "UPDATE budgets SET consumed_cents = 123 WHERE scope_type = 'role'",
      )
      .run();

    const res = budgetListRoute(h.deps);
    expect(res.status).toBe(200);
    const b = res.body as {
      rows: Record<string, unknown>[];
      totals: Record<string, number>;
    };
    expect(() => JSON.stringify(res.body)).not.toThrow();
    expect(b.rows).toEqual([
      {
        scope_type: "company",
        scope_id: "company",
        period: "daily",
        limit_cents: 50000,
        consumed_cents: 0,
        hard_stop: true,
      },
      {
        scope_type: "role",
        scope_id: "dev",
        period: "per_task",
        limit_cents: 800,
        consumed_cents: 123,
        hard_stop: false,
      },
    ]);
    expect(b.totals).toEqual({
      limit_cents: 50800,
      consumed_cents: 123,
      unset_scopes: 0,
    });
    // 没有组织图也没有任务时 unset_scopes 是 0（expectedRoleScopes 两头都取不到角色）。
  });

  it("⭐ unset_scopes：有组织图 ⇒ 数图上有岗位而 budgets 无 role 行的角色；补一格就少一个", async () => {
    const h = harness({ wired: true });
    seedGraph(h.write, ["ceo", "tech", "dev"]);
    const before = budgetListRoute(h.deps).body as {
      totals: { unset_scopes: number };
    };
    expect(before.totals.unset_scopes).toBe(3);
    await putBudgetRoute(
      h.deps,
      h.req({
        method: "POST",
        path: "/budget",
        body: body(
          okBody({ scope_type: "role", scope_id: "dev", limit_cents: 100 }),
        ),
      }),
    );
    const after = budgetListRoute(h.deps).body as {
      totals: { unset_scopes: number };
    };
    expect(after.totals.unset_scopes).toBe(2);
    // company 行不算 unset（unset 只数 role 级），上面的差值已证：加的是 role 行才让数变小。
    await putBudgetRoute(
      h.deps,
      h.req({
        method: "POST",
        path: "/budget",
        body: body(okBody({ limit_cents: 999 })),
      }),
    );
    const after2 = budgetListRoute(h.deps).body as {
      totals: { unset_scopes: number };
    };
    expect(after2.totals.unset_scopes).toBe(2);
  });

  it("没有组织图 ⇒ 退到 tasks.assigned_role 的口径", () => {
    const h = harness({ wired: true });
    h.write
      .prepare(
        "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
          "VALUES ('t1','x','IN_PROGRESS','dev','implement',?,?), ('t2','y','IN_PROGRESS','dev','implement',?,?)",
      )
      .run(T0, T0, T0, T0);
    const b = budgetListRoute(h.deps).body as {
      totals: { unset_scopes: number };
    };
    // dev、test 两个角色去重后只剩一个 —— DISTINCT 没生效会数成 2。
    expect(b.totals.unset_scopes).toBe(1);
  });
});

/* ══════════════════ ⑦ e2e（过鉴权层的 handleRequest） ══════════════════ */

describe("⑦ handleRequest：签名过、签名不覆盖被换的 body ⇒ 401", () => {
  it("⭐ 签名的 POST+GET 走通全链；GET 未签名 401", async () => {
    const h = harness({ wired: true });
    const post = await handleRequest(
      h.deps,
      h.req({ method: "POST", path: "/budget", body: body(okBody()) }),
    );
    expect(post.status).toBe(200);
    expect(post.body).toEqual({ ok: true });

    const get = await handleRequest(
      h.deps,
      h.req({ method: "GET", path: "/budget" }),
    );
    expect(get.status).toBe(200);
    const getUnsigned = await handleRequest(
      h.deps,
      h.req({ method: "GET", path: "/budget", headers: {} }),
    );
    expect(getUnsigned.status).toBe(UNAUTHORIZED);
  });

  it("签名指向另一个 body ⇒ 401 且 budgets 零行（HMAC 签的是原始 body）", async () => {
    const h = harness({ wired: true });
    const res = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/budget",
        body: body(okBody()),
        headers: h.sign("POST", "/budget", body(okBody({ limit_cents: 1 }))),
      }),
    );
    expect(res.status).toBe(UNAUTHORIZED);
    expect(
      Number(h.db.prepare("SELECT count(*) AS n FROM budgets").get()?.n),
    ).toBe(0);
  });
});
