/**
 * /api/v1/dispatch/rules 三个端点对外开放的那一面。
 *
 * 与 test/dispatch/rules.test.ts 的分工：那边验服务本身的判据（作用域、大小写折叠、
 * 审计）；这里验从 HTTP 进来会发生什么：路由能命中、状态码按 code 分派、
 * 坏请求体在 422 就停住、以及【写完之后 GET 读得到】—— 最后这一条只在服务层测
 * 是测不到的：写走 WriteQueue 的写连接，读走另一条只读连接，两条连接之间的可见性
 * 属于装配层，服务测试里读写同一条连接永远绿。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { DispatchRuleView } from "@opc/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { InMemoryEventBus } from "../../src/events/bus.js";
import {
  type HubDeps,
  type HubRequest,
  handleRequest,
} from "../../src/http/app.js";
import { signedHeaders } from "../../src/http/auth.js";
import { LOOPBACK_HOST } from "../../src/http/bind.js";
import { buildHubDeps } from "../../src/http/real-deps.js";
import { DRIVER_OFF } from "../fixtures/driver-state.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("dispatch-rules-route", import.meta.url);
mkdirSync(TMP, { recursive: true });
const NOW = Date.UTC(2026, 10, 23);
const TOKEN = "dispatch-rules-route-token";
const queues: WriteQueue[] = [];
let fileSeq = 0;

interface World {
  readonly deps: HubDeps;
  readonly db: DatabaseSync;
}

async function world(o: { wired?: boolean } = {}): Promise<World> {
  const q = new WriteQueue(
    join(TMP, "dr-" + process.pid + "-" + ++fileSeq + ".db"),
  );
  queues.push(q);
  const db = q.writeConnection();
  migrate(db);
  const deps = buildHubDeps({
    queue: q,
    bus: new InMemoryEventBus(),
    token: TOKEN,
    now: () => NOW,
    driverState: () => DRIVER_OFF,
  });
  // wired:false ⇒ 摘掉领域写入装配 ⇒ 两条写路由该 501，而读侧照旧 200。
  // 用解构【删键】而不是写 undefined：HubDeps.domainWriter 是可选属性，
  // exactOptionalPropertyTypes 下 undefined 不是它的合法取值，而「没接装配」这件事
  // 本来就是这个键不存在（同 rhythm-route.test.ts / domain-routes.test.ts 那一族）。
  if (o.wired === false) {
    const { domainWriter: _writer, ...withoutWriter } = deps;
    return { deps: withoutWriter, db };
  }
  return { deps, db };
}

function request(method: string, path: string, body?: unknown): HubRequest {
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    method,
    path,
    target: path,
    query: {},
    headers: signedHeaders(TOKEN, {
      method,
      target: path,
      body: text,
      now: NOW,
    }),
    body: text,
    peer: LOOPBACK_HOST,
  };
}

async function call(
  deps: HubDeps,
  method: string,
  path: string,
  body?: unknown,
) {
  return handleRequest(deps, request(method, path, body));
}

async function callText(
  deps: HubDeps,
  method: string,
  path: string,
  text: string,
) {
  return handleRequest(deps, {
    ...request(method, path),
    body: text,
    headers: signedHeaders(TOKEN, {
      method,
      target: path,
      body: text,
      now: NOW,
    }),
  });
}

function rules(body: unknown): DispatchRuleView[] {
  return (body as { rules: DispatchRuleView[] }).rules;
}

function code(body: unknown): string {
  return (body as { code: string }).code;
}

afterAll(async () => {
  for (const q of queues) {
    try {
      await q.close();
    } catch {
      // 清理阶段不该冲掉断言结果
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});

describe("GET /api/v1/dispatch/rules", () => {
  it("200 且列出种子（带岗位名，配置面直接可读）", async () => {
    const { deps } = await world();
    const res = await call(deps, "GET", "/api/v1/dispatch/rules");
    expect(res.status).toBe(200);
    const list = rules(res.body);
    expect(list.map((r) => r.rule_id)).toContain("cos_rule_bug");
    const bug = list.find((r) => r.rule_id === "cos_rule_bug");
    expect(bug?.target_role_name).toBe("开发工程师");
    expect(bug?.enabled).toBe(true);
  });
});

describe("POST /api/v1/dispatch/rules", () => {
  it("201 之后 GET 读得到（写连接与只读连接之间的可见性）", async () => {
    const { deps } = await world();
    const res = await call(deps, "POST", "/api/v1/dispatch/rules", {
      keyword: "压测",
      target_role_id: "qa",
      priority: 3,
    });
    expect(res.status).toBe(201);
    const created = (res.body as { rule: DispatchRuleView; auditSeq: number })
      .rule;
    expect(created.rule_id).toMatch(/^cos_rule_/u);
    expect(created.target_role_name).toBe("测试工程师");
    expect(created.group_id).toBeNull();
    expect((res.body as { auditSeq: number }).auditSeq).toBeGreaterThan(0);

    const after = rules(
      (await call(deps, "GET", "/api/v1/dispatch/rules")).body,
    );
    expect(after.find((r) => r.rule_id === created.rule_id)).toEqual(created);
  });

  it("空请求体 ⇒ 422（keyword 与 target_role_id 必填），issues 点名坏在哪一格", async () => {
    const { deps } = await world();
    const res = await callText(deps, "POST", "/api/v1/dispatch/rules", "");
    expect(res.status).toBe(422);
    expect(code(res.body)).toBe("bad_body");
    const issues = (res.body as { issues: { path: string }[] }).issues;
    expect(issues.map((i) => i.path).sort()).toEqual([
      "keyword",
      "target_role_id",
    ]);
  });

  it("未知键被拒（strict）：调用方拼错的字段不会被静默丢掉", async () => {
    const { deps } = await world();
    const res = await call(deps, "POST", "/api/v1/dispatch/rules", {
      keyword: "灰度",
      target_role_id: "qa",
      role_id: "dev",
    });
    expect(res.status).toBe(422);
    const issues = (res.body as { issues: { path: string; message: string }[] })
      .issues;
    // path 是空串：zod 对未识别键报的是【对象本身】而不是那个键，键名在 message 里。
    // 断 message 而不改 http 层的桥接口径 —— 键名有没有说出口才是这一格的内容。
    expect(issues.map((i) => i.path)).toContain("");
    expect(issues.some((i) => i.message.includes("role_id"))).toBe(true);
  });

  it("纯空白关键字 ⇒ 422（trim 后才判非空，与 DDL 的 CHECK 同向）", async () => {
    const { deps } = await world();
    const res = await call(deps, "POST", "/api/v1/dispatch/rules", {
      keyword: "   ",
      target_role_id: "qa",
    });
    expect(res.status).toBe(422);
  });

  it("坏 JSON ⇒ 422 bad_body 而不是 500", async () => {
    const { deps } = await world();
    const res = await callText(
      deps,
      "POST",
      "/api/v1/dispatch/rules",
      "{keyword:",
    );
    expect(res.status).toBe(422);
    expect(code(res.body)).toBe("bad_body");
  });

  it("岗位不存在 ⇒ 404（引用没落地，不是请求体语法坏了）", async () => {
    const { deps } = await world();
    const res = await call(deps, "POST", "/api/v1/dispatch/rules", {
      keyword: "压测",
      target_role_id: "ghost",
    });
    expect(res.status).toBe(404);
    expect(code(res.body)).toBe("role_not_found");
  });

  it("同关键字撞车 ⇒ 409 且一行未写", async () => {
    const { deps } = await world();
    const before = rules(
      (await call(deps, "GET", "/api/v1/dispatch/rules")).body,
    ).length;
    const res = await call(deps, "POST", "/api/v1/dispatch/rules", {
      keyword: "BUG",
      target_role_id: "qa",
    });
    expect(res.status).toBe(409);
    expect(code(res.body)).toBe("keyword_conflict");
    expect(
      rules((await call(deps, "GET", "/api/v1/dispatch/rules")).body).length,
    ).toBe(before);
  });
});

describe("PATCH /api/v1/dispatch/rules/:id", () => {
  it("200 停用之后 GET 读到 enabled=false", async () => {
    const { deps } = await world();
    const res = await call(
      deps,
      "PATCH",
      "/api/v1/dispatch/rules/cos_rule_bug",
      {
        enabled: false,
      },
    );
    expect(res.status).toBe(200);
    expect((res.body as { rule: DispatchRuleView }).rule.enabled).toBe(false);
    const bug = rules(
      (await call(deps, "GET", "/api/v1/dispatch/rules")).body,
    ).find((r) => r.rule_id === "cos_rule_bug");
    expect(bug?.enabled).toBe(false);
  });

  it("空体 PATCH ⇒ 200 且 auditSeq=0（未传字段保持原值，不是「改了个空」）", async () => {
    const { deps } = await world();
    const before = rules(
      (await call(deps, "GET", "/api/v1/dispatch/rules")).body,
    ).find((r) => r.rule_id === "cos_rule_test");
    const res = await callText(
      deps,
      "PATCH",
      "/api/v1/dispatch/rules/cos_rule_test",
      "",
    );
    expect(res.status).toBe(200);
    expect((res.body as { auditSeq: number }).auditSeq).toBe(0);
    expect((res.body as { rule: DispatchRuleView }).rule).toEqual(before);
  });

  it("规则不存在 ⇒ 404 dispatch_rule_not_found", async () => {
    const { deps } = await world();
    const res = await call(deps, "PATCH", "/api/v1/dispatch/rules/nope", {
      enabled: false,
    });
    expect(res.status).toBe(404);
    expect(code(res.body)).toBe("dispatch_rule_not_found");
  });
});

describe("装配未接领域写入", () => {
  it("两条写路由 ⇒ 501 而读侧照旧 200（501 而非 404：路由在，装配没连）", async () => {
    const { deps } = await world({ wired: false });
    expect((await call(deps, "GET", "/api/v1/dispatch/rules")).status).toBe(
      200,
    );
    const post = await call(deps, "POST", "/api/v1/dispatch/rules", {
      keyword: "压测",
      target_role_id: "qa",
    });
    expect(post.status).toBe(501);
    expect(String((post.body as { error: string }).error)).toContain(
      "domainWriter",
    );
    const patch = await call(
      deps,
      "PATCH",
      "/api/v1/dispatch/rules/cos_rule_bug",
      {
        enabled: false,
      },
    );
    expect(patch.status).toBe(501);
  });
});
