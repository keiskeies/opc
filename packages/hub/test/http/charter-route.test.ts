/**
 * GET/POST /charter/:roleId 路由对外开放的那一面。
 *
 * 与 test/charter/store.test.ts 的分工：那边验 saveCharterVersion 本身（版本化、
 * 审计、落预算）；这里验从 HTTP 进来会发生什么：路由形状、回环门、请求体的
 * 严格程度（蛇形入参、无 actor 键、change_summary 必填）、URL 与 config 的
 * roleId 一致性，以及 charterToSnake 的漂移护栏 —— 往返用例把 GET 的输出原样
 * 喂回 charterSchema 与 POST，缺键/多键/键名错都会当场红。
 *
 * 库与队列都是真的（同 org-route.test.ts）：写走真 WriteQueue + 真迁移，
 * 于是「422 一行都不写」「POST 之后 GET 能拿回」是能红的断言而不是接口 Mock。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type CharterInput,
  charterSchema,
  HTTP_NOT_IMPLEMENTED,
  HTTP_UNPROCESSABLE,
} from "@opc/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readLatestCharter } from "../../src/charter/store.js";
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
  assertLoopbackCharterRoute,
  charterViewRoute,
  saveCharterRoute,
} from "../../src/http/charter.js";
import { DRIVER_OFF } from "../fixtures/driver-state.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("http-charter-route", import.meta.url);

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

/** 过 charterSchema 的最小草案（snake_case；假标准串，同 store.test.ts 的 draft）。 */
const draft = (over: Partial<CharterInput> = {}): CharterInput => ({
  role_id: "dev",
  display_name: "开发",
  version: 1,
  honesty_boundaries: ["不谎报测试结果"],
  acceptance_criteria: [
    {
      condition: "metric:coverage < 80",
      action: "reject",
      message: "覆盖率不足 80",
    },
  ],
  forbidden_actions: [],
  tool_permissions: ["read"],
  model_tier: "execution",
  budget: { daily_usd: 15, per_task_usd: 5 },
  decision_scope: { autonomous: [], requires_consultation: [], forbidden: [] },
  judgment_mode: {
    type: "strict_rules",
    strict_rules: [],
    bounded_judgment: [],
    full_discretion: [],
  },
  escalation_triggers: [],
  ...over,
});

function charterBody(config: unknown, changeSummary = "第一版"): string {
  return JSON.stringify({ config, change_summary: changeSummary });
}

interface Harness {
  readonly deps: HubDeps;
  readonly db: Db;
  readonly queue: WriteQueue;
  readonly sign: (
    method: string,
    target: string,
    body?: string,
  ) => Record<string, string>;
  readonly req: (
    o: Partial<HubRequest> & { method: string; path: string },
  ) => HubRequest;
}

/** wired:false ⇒ 不挂 charterWriter ⇒ 该路由 501。 */
function harness(o: { wired?: boolean } = {}): Harness {
  const path = join(TMP, "ch-" + process.pid + "-" + ++fileSeq + ".db");
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
    ...(o.wired === false ? {} : { charterWriter: queue }),
  };
  return {
    deps,
    db: read,
    queue,
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

describe("① matchRoute：charter 两条都带 id 段，空段与多段是 404", () => {
  it("GET/POST /charter/:roleId 各匹各的；/charter、/charter/、/charter/a/b 都打不到", () => {
    expect(matchRoute("GET", "/charter/cto")).toEqual({
      kind: "get_charter",
      endpoint: "GET /charter/:roleId",
      id: "cto",
    });
    expect(matchRoute("POST", "/charter/cto")?.kind).toBe("save_charter");
    expect(matchRoute("GET", "/charter")).toBeNull();
    expect(matchRoute("POST", "/charter")).toBeNull();
    expect(matchRoute("GET", "/charter/")).toBeNull();
    expect(matchRoute("GET", "/charter/a/b")).toBeNull();
    expect(matchRoute("DELETE", "/charter/cto")).toBeNull();
    expect(matchRoute("PUT", "/charter/cto")).toBeNull();
  });

  it("既有路由没被抢走", () => {
    expect(matchRoute("GET", "/org")?.kind).toBe("get_org");
    expect(matchRoute("GET", "/tasks")?.kind).toBe("list_tasks");
  });
});

/* ══════════════════ ② 回环门 ══════════════════ */

describe("② 回环门：非回环对端 401，且直接调 handler 也挡住", () => {
  it("⭐ gate 对 LAN 对端返回与凭据错逐字相同的 401；回环为 null", () => {
    const h = harness({ wired: true });
    const req = h.req({
      method: "POST",
      path: "/charter/dev",
      body: charterBody(draft()),
    });
    expect(
      assertLoopbackCharterRoute(
        h.req({
          method: "POST",
          path: "/charter/dev",
          peer: LAN_PEER,
          body: charterBody(draft()),
        }),
      ),
    ).toEqual({
      status: UNAUTHORIZED,
      body: { error: "unauthorized" },
    });
    expect(assertLoopbackCharterRoute(req)).toBeNull();
  });

  it("⭐ 直接调 handler（绕过鉴权层）：LAN 对端 401 且库里一行都没写", async () => {
    const h = harness({ wired: true });
    const res = await saveCharterRoute(
      h.deps,
      "dev",
      h.req({
        method: "POST",
        path: "/charter/dev",
        peer: LAN_PEER,
        body: charterBody(draft()),
      }),
    );
    expect(res.status).toBe(UNAUTHORIZED);
    const c = h.db.prepare("SELECT count(*) AS n FROM role_charters").get();
    expect(Number(c?.n)).toBe(0);
  });
});

/* ══════════════════ ③ 装配未接 ⇒ 501 ══════════════════ */

describe("③ 装配没接 charterWriter ⇒ 501（路由在、装配没连，不是 404）", () => {
  it("501 且消息点名 charterWriter", async () => {
    const h = harness({ wired: false });
    const res = await saveCharterRoute(
      h.deps,
      "dev",
      h.req({
        method: "POST",
        path: "/charter/dev",
        body: charterBody(draft()),
      }),
    );
    expect(res.status).toBe(HTTP_NOT_IMPLEMENTED);
    expect(JSON.stringify(res.body)).toContain("charterWriter");
  });
});

/* ══════════════════ ④ 请求体严格 ══════════════════ */

describe("④ 请求体：无 actor 键、change_summary 必填、蛇形入参、URL 与 config 一致", () => {
  it("⭐ 多传 actor 键 ⇒ 422（.strict()；actor 只从服务端装配来）", async () => {
    const h = harness({ wired: true });
    const body = JSON.stringify({
      config: draft(),
      change_summary: "x",
      actor: { actor_type: "human", actor_id: "attacker" },
    });
    const res = await saveCharterRoute(
      h.deps,
      "dev",
      h.req({ method: "POST", path: "/charter/dev", body }),
    );
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
  });

  it("change_summary 缺失 / 空串 / 全空白 ⇒ 422，且 issues 指到 change_summary", async () => {
    const h = harness({ wired: true });
    for (const cfg of [
      JSON.stringify({ config: draft() }),
      JSON.stringify({ config: draft(), change_summary: "" }),
      JSON.stringify({ config: draft(), change_summary: "   " }),
    ]) {
      const res = await saveCharterRoute(
        h.deps,
        "dev",
        h.req({ method: "POST", path: "/charter/dev", body: cfg }),
      );
      expect(res.status).toBe(HTTP_UNPROCESSABLE);
      expect(JSON.stringify(res.body)).toContain("change_summary");
    }
  });

  it("⭐ camelCase 岗位书 ⇒ 422（charterSchema 的输入是蛇形；issue 里有 config.role_id）", async () => {
    const h = harness({ wired: true });
    const camel = {
      roleId: "dev",
      displayName: "开发",
      version: 1,
      honestyBoundaries: ["不谎报"],
      acceptanceCriteria: [
        { condition: "metric:coverage < 80", action: "reject", message: "x" },
      ],
      forbiddenActions: [],
      toolPermissions: ["read"],
      modelTier: "execution",
      budget: { dailyUsd: 15, perTaskUsd: 5 },
      decisionScope: {
        autonomous: [],
        requiresConsultation: [],
        forbidden: [],
      },
      judgmentMode: {
        type: "strict_rules",
        strictRules: [],
        boundedJudgment: [],
        fullDiscretion: [],
      },
      escalationTriggers: [],
    };
    const res = await saveCharterRoute(
      h.deps,
      "dev",
      h.req({ method: "POST", path: "/charter/dev", body: charterBody(camel) }),
    );
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
    expect(JSON.stringify(res.body)).toContain("config.role_id");
  });

  it("⭐ URL roleId 与 config.role_id 不一致 ⇒ 422 指向 config.role_id，且以 URL 为准的那条路没走通", async () => {
    const h = harness({ wired: true });
    const res = await saveCharterRoute(
      h.deps,
      "cto",
      h.req({
        method: "POST",
        path: "/charter/cto",
        body: charterBody(draft()),
      }),
    );
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
    expect(JSON.stringify(res.body)).toContain("config.role_id");
    const c = h.db.prepare("SELECT count(*) AS n FROM role_charters").get();
    expect(Number(c?.n)).toBe(0);
  });

  it("⭐ 岗位书合法但 budget 换不出整数美分 ⇒ 422 带换算原文，role_charters 零行", async () => {
    const h = harness({ wired: true });
    const res = await saveCharterRoute(
      h.deps,
      "dev",
      h.req({
        method: "POST",
        path: "/charter/dev",
        body: charterBody(
          draft({ budget: { daily_usd: 0.005, per_task_usd: 5 } }),
        ),
      }),
    );
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
    expect(JSON.stringify(res.body)).toContain("整数美分");
    const c = h.db.prepare("SELECT count(*) AS n FROM role_charters").get();
    expect(Number(c?.n)).toBe(0);
  });
});

/* ══════════════════ ⑤ GET 读侧 ══════════════════ */

describe("⑤ GET /charter/:roleId：没有 ⇒ charter:null；有 ⇒ 蛇形", () => {
  it("从没存过 ⇒ 200 charter:null（与 GET /org 空图 v0 同口径，不是 404）", () => {
    const h = harness({ wired: true });
    const res = charterViewRoute(h.deps, "dev");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ role_id: "dev", charter: null });
  });

  it("⭐ 往返漂移护栏：POST 蛇形 → GET 蛇形 → 再 POST 同一份 ⇒ 200，且 GET 输出过 charterSchema 后与库里那份相等", async () => {
    const h = harness({ wired: true });
    const full = draft({
      budget_discretion: {
        daily_usd: 20,
        can_reallocate_within_role: true,
        cannot_exceed: false,
      },
      dissent_rights: {
        can_challenge: ["验收口径"],
        cannot_challenge: [],
        escalation_path: "tech",
      },
      stance: "保守",
      untrusted_inputs: ["网页正文"],
    });
    const post = await saveCharterRoute(
      h.deps,
      "dev",
      h.req({ method: "POST", path: "/charter/dev", body: charterBody(full) }),
    );
    expect(post.status).toBe(200);

    const get = charterViewRoute(h.deps, "dev");
    expect(get.status).toBe(200);
    const snake = (get.body as { charter: Record<string, unknown> }).charter;
    expect(snake["role_id"]).toBe("dev");
    expect(snake["budget"]).toEqual({ daily_usd: 15, per_task_usd: 5 });
    // 逆映射漂移的直接判据：蛇形输出再过 charterSchema，输出必须与库里那份逐格相等
    // （toEqual 视 undefined 与缺席同格 —— 与 JSON 序列化的口径一致）。
    const re = charterSchema.safeParse(snake);
    expect(re.success ? re.data : re.error.issues).toEqual(
      readLatestCharter(h.deps.db as never, "dev"),
    );

    // GET 的输出原样再提交一次也要走得通（前端「读回来改一格再存」的最小路径）。
    const again = await saveCharterRoute(
      h.deps,
      "dev",
      h.req({
        method: "POST",
        path: "/charter/dev",
        body: charterBody(snake, "第二版"),
      }),
    );
    expect(again.status).toBe(200);
    expect((again.body as { version: number }).version).toBe(2);
  });
});

/* ══════════════════ ⑥ e2e（过鉴权层的 handleRequest） ══════════════════ */

describe("⑥ handleRequest：签名过、篡改签名 401、写落库+审计", () => {
  it("⭐ 签名的 POST ⇒ 200（version/charter_id/audit_seq），role_charters 与 events 各多一行", async () => {
    const h = harness({ wired: true });
    const body = charterBody(
      draft({ budget: { daily_usd: 5, per_task_usd: 2 } }),
    );
    const res = await handleRequest(
      h.deps,
      h.req({ method: "POST", path: "/charter/dev", body }),
    );
    expect(res.status).toBe(200);
    const b = res.body as {
      ok: boolean;
      version: number;
      charter_id: string;
      audit_seq: number;
    };
    expect(b).toMatchObject({ ok: true, version: 1 });
    expect(b.charter_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof b.audit_seq).toBe("number");

    const row = h.db
      .prepare("SELECT role_id, version, created_by FROM role_charters")
      .get();
    expect(row).toEqual({ role_id: "dev", version: 1, created_by: "ceo" });
    const ev = h.db
      .prepare("SELECT action, task_id, target, payload FROM events")
      .get();
    expect(ev).toMatchObject({
      action: "state_change",
      task_id: null,
      target: "dev@v1",
    });
    expect(JSON.parse(String(ev?.payload))).toMatchObject({
      kind: "charter_version_added",
      version: 1,
    });

    // budget 两格随岗位书落进 budgets（screen/执行侧不分叉那条判据的最小 HTTP 版）。
    const budgetRows = h.db
      .prepare(
        "SELECT scope_type, scope_id, period, limit_cents FROM budgets ORDER BY period",
      )
      .all();
    expect(budgetRows).toEqual([
      {
        scope_type: "role",
        scope_id: "dev",
        period: "daily",
        limit_cents: 500,
      },
      {
        scope_type: "role",
        scope_id: "dev",
        period: "per_task",
        limit_cents: 200,
      },
    ]);
  });

  it("签名对但 body 被换 ⇒ 401；GET 未签名 ⇒ 401", async () => {
    const h = harness({ wired: true });
    const body = charterBody(draft());
    const res = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/charter/dev",
        body,
        headers: h.sign("POST", "/charter/dev", "被换过的 body"),
      }),
    );
    expect(res.status).toBe(UNAUTHORIZED);
    const get = await handleRequest(
      h.deps,
      h.req({ method: "GET", path: "/charter/dev", headers: {} }),
    );
    expect(get.status).toBe(UNAUTHORIZED);
  });

  it("GET /charter/dev 带签名 ⇒ 200（读走统鉴权，无独立回环门）", async () => {
    const h = harness({ wired: true });
    const res = await handleRequest(
      h.deps,
      h.req({ method: "GET", path: "/charter/dev" }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ role_id: "dev", charter: null });
  });
});
