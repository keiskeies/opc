/**
 * POST /org 路由【对外开放的那一面】（0040）。
 *
 * ── 与 test/org/versioning.test.ts / test/replay/search.test.ts 的分工 ─────
 * 那些文件测的是 commitOrgGraph 本身（版本化、事务、半提交、运行中任务）。本文件
 * 测的是从 HTTP 进来会发生什么：状态码、请求体的严格程度、actor 不从请求体来、
 * 回环门 + 装配方有没有接「变更前备份 + 提交」这条链。
 *
 * ── 三条只在 HTTP 层存在的判据，每条各有一发 ─────────────────────────────
 *  ① 回环门：非回环对端 ⇒ 401（组织变更是 self-escalating 的 CEO 写，[spec]
 *     §4.2.3 组织权集中给 CEO；远程可提交 = 直接改组织本身，比「自封 CEO」还重一档）。
 *  ② actor【不从请求体来】：schema 里没有 actor 键（.strict() 挡着）—— 多传一个
 *     actor 是看得见的 422，而不是一次静默的采纳。
 *  ③ 装配没接 commitOrgChange ⇒ 501；接了 ⇒「备份在提交前发生、失败即拒」。
 *     这一条单独在 ① 与 ② 之后讲，因为它把「谁负责说 501/422」与「备份的编排
 *     归装配」这两件事分开了 —— 路由只解析 + 判回环 + 透传。
 *
 * ── 库与队列都是【真的】──────────────────────────────────────────────────
 * 同 bindings-route.test.ts：写入走真 WriteQueue，备份走注入的假备份（记录调用），
 * 于是「备份在提交前真的发生了且失败就拒绝提交」是一条能红的用例。
 * actor 用真 ORG_COMMIT_ACTOR（{human, ceo}），验证名从 real-deps 拿，不手搓。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HTTP_NOT_IMPLEMENTED,
  HTTP_UNPROCESSABLE,
  type OrgActor,
  type OrgGraph,
} from "@opc/contracts";
import { fixtureTmp } from "../fixtures/fixture-dir.js";
import { DRIVER_OFF } from "../fixtures/driver-state.js";
import { InMemoryEventBus } from "../../src/events/bus.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { migrate } from "../../src/db/migrate.js";
import { handleRequest, matchRoute, type HubDeps, type HubRequest } from "../../src/http/app.js";
import { assertLoopbackOrgRoute, commitOrgRoute, orgGraphRoute } from "../../src/http/org.js";
import { ORG_COMMIT_ACTOR } from "../../src/http/real-deps.js";
import { readLatestGraph } from "../../src/org/commit.js";
import { newLocalToken, signedHeaders } from "../../src/http/auth.js";
import { LOOPBACK_HOST } from "../../src/http/bind.js";

const TMP = fixtureTmp("http-org-route", import.meta.url);

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

/** 一张能提交的最小合法图（四角色，全带 model_family —— 0011 §5 那条夹具教训）。 */
function graph(): OrgGraph {
  return {
    nodes: {
      ceo: { role_id: "ceo", can_manage: true, reports_to: null, model_family: "o3" },
      tech: { role_id: "tech", can_manage: true, reports_to: "ceo", model_family: "claude" },
      dev: { role_id: "dev", can_manage: false, reports_to: "tech", model_family: "gpt" },
      test: { role_id: "test", can_manage: false, reports_to: "tech", model_family: "gemini" },
    },
    edges: [
      { from: "dev", to: "test", review_gate: true },
      { from: "test", to: "ceo", review_gate: true },
      { from: "tech", to: "ceo", review_gate: true },
    ],
  };
}

const REPARENT_BODY = JSON.stringify({
  graph: graph(),
  change: { kind: "reparent", child_role: "dev", new_parent_role: "ceo" },
  change_summary: "dev 直接汇报 CEO",
});

interface BackupRecorder {
  calls: number;
  result: { ok: boolean; message?: string };
}

interface Harness {
  readonly deps: HubDeps;
  readonly db: Db;
  readonly sign: (method: string, target: string, body?: string) => Record<string, string>;
  readonly req: (o: Partial<HubRequest> & { method: string; path: string }) => HubRequest;
}

function harness(o: {
  /** 缺 ⇒ 不装 commitOrgChange ⇒ 501。 */
  wired?: boolean;
  /** 假备份的结论；缺省 ok:true。 */
  backup?: { ok: boolean; message?: string };
} = {}): { h: Harness; recorder: BackupRecorder } {
  const path = join(TMP, "org-" + process.pid + "-" + ++fileSeq + ".db");
  const queue = new WriteQueue(path);
  queues.push(queue);
  const write = queue.writeConnection() as unknown as Db;
  migrate(write as never);
  const read = queue.readConnection() as unknown as Db;
  const token = newLocalToken();
  const clock = () => T0;
  const sign = (method: string, target: string, body = ""): Record<string, string> =>
    signedHeaders(token, { method, target, body, now: clock() });

  const recorder: BackupRecorder = { calls: 0, result: o.backup ?? { ok: true } };

  const base: HubDeps = {
    db: read as never,
    bus: new InMemoryEventBus(),
    token,
    now: clock,
    recordDecision: async () => true,
    createTask: async () => {},
    resumeGraph: async () => {},
    // 这台夹具扮演的是哪一台 Hub（HubDeps.driverState 必填的理由在那边）：同 bindings-route：这一文件测的是 POST /org 的提交顺序（备份在前），没有东西在推任务。
    driverState: () => DRIVER_OFF,
    // 组织提交：备份(`backup` 记录) 在前，成功才落 commitOrgGraph。
    ...(o.wired === false
      ? {}
      : {
          commitOrgChange: async ({ graph, change, changeSummary }) => {
            recorder.calls += 1;
            if (!recorder.result.ok) {
              return {
                ok: false,
                reason: recorder.result.message ?? "备份失败",
                code: "backup_failed",
              };
            }
            // 查 running tasks（空），再用真 actor 提交 —— 与 real-deps 的
            // makeCommitOrgChange 同方向的编排，但这儿把备份 replace 成假的。
            const db2 = queue.readConnection() as unknown as Db;
            const rows = db2.prepare(
              "SELECT id FROM tasks WHERE status NOT IN ('DELIVERED','ARCHIVED') ORDER BY id",
            ).all() as Row[];
            const runningTasks = rows.map((r) => String(r.id));
            const { commitOrgGraph } = await import("../../src/org/commit.js");
            const actor: OrgActor = ORG_COMMIT_ACTOR;
            return commitOrgGraph(queue as never, {
              graph,
              change,
              actor,
              runningTasks,
              nowMs: T0,
              changeSummary,
            });
          },
          // 组织读（GET /org）：从只读连接读「当前生效那份」。同 real-deps 的方向，
          // 但这里直接挂在装配上 —— 测试要的是「POST 后被 GET 能拿到」这条链。
          readOrgGraph: (() => {
            return () => {
              const latest = readLatestGraph(read as never);
              if (latest === null) return { versions: 0 };
              return {
                versions: latest.version,
                version: latest.version,
                graph: latest.graph,
                graphId: latest.graphId,
                effectiveFromMs: latest.effectiveFromMs,
                ...(latest.changeSummary === null
                  ? {}
                  : { changeSummary: latest.changeSummary }),
              };
            };
          })(),
        }),
  };

  const deps = base;
  return {
    h: {
      deps,
      db: read,
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
    },
    recorder,
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

describe("① matchRoute：POST /org 只有一段字面，方法不互换，拼错是 404", () => {
  it("POST /org 匹到 commit_org；GET /org 匹到 get_org；DELETE 打不到；/org/x 是 404", () => {
    expect(matchRoute("POST", "/org")?.kind).toBe("commit_org");
    expect(matchRoute("POST", "/org")?.endpoint).toBe("POST /org");
    expect(matchRoute("GET", "/org")?.kind).toBe("get_org");
    expect(matchRoute("GET", "/org")?.endpoint).toBe("GET /org");
    expect(matchRoute("DELETE", "/org")).toBeNull();
    expect(matchRoute("PUT", "/org")).toBeNull();
    expect(matchRoute("POST", "/org/anything")).toBeNull();
    expect(matchRoute("GET", "/org/anything")).toBeNull();
    expect(matchRoute("POST", "/org/")).toBeNull();
    expect(matchRoute("GET", "/org/")).toBeNull();
  });

  it("既有路由没被 /org 那条抢走", () => {
    expect(matchRoute("GET", "/tasks")?.kind).toBe("list_tasks");
    expect(matchRoute("POST", "/bindings")?.kind).toBe("request_binding");
    expect(matchRoute("POST", "/bindings/verify")?.kind).toBe("verify_binding");
  });
});

/* ══════════════════ ② 回环门 ══════════════════ */

describe("② 回环门：非回环对端 401，且不带原因", () => {
  it("⭐ 直接调 handler：非回环对端 401，未授权形状与凭据错逐字相同", async () => {
    const { h } = harness({ wired: true });
    const req = h.req({ method: "POST", path: "/org", peer: LAN_PEER, body: REPARENT_BODY });
    const gate = assertLoopbackOrgRoute(req);
    expect(gate).toEqual({ status: UNAUTHORIZED, body: { error: "unauthorized" } });
    // 拿到 gate 就不该继续进 handler 主体 —— 反向对照：回环对端 gate 为 null。
    expect(assertLoopbackOrgRoute(h.req({ method: "POST", path: "/org", body: REPARENT_BODY }))).toBeNull();
    // 未装配时（回环、可签）走 handler ⇒ 501，而不是被误放行。
    const { h: h2 } = harness({ wired: false });
    const res = await commitOrgRoute(
      h2.deps,
      h2.req({ method: "POST", path: "/org", body: REPARENT_BODY }),
    );
    expect(res.status).toBe(HTTP_NOT_IMPLEMENTED);
  });
});

/* ══════════════════ ③ 请求体 ══════════════════ */

describe("③ 请求体严格：缺键 422，多传 actor 422，brief 只有 change 才算数", () => {
  it("⭐ 多传 actor 键 ⇒ 422（actor 只从装配来，成了请求里的咒语就是谁能自称 CEO）", async () => {
    const { h } = harness({ wired: true });
    const body = JSON.stringify({
      graph: graph(),
      change: { kind: "reparent", child_role: "dev", new_parent_role: "ceo" },
      change_summary: "x",
      actor: { type: "human", id: "ceo" },
    });
    const res = await commitOrgRoute(
      h.deps,
      h.req({ method: "POST", path: "/org", body }),
    );
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
  });

  it("缺 change_summary ⇒ 422；change 缺 => 422；缺 graph => 422", async () => {
    const { h } = harness({ wired: true });
    for (const body of [
      JSON.stringify({ graph: graph(), change: { kind: "reparent", child_role: "dev", new_parent_role: "ceo" } }),
      JSON.stringify({ graph: graph(), change_summary: "x" }),
      JSON.stringify({ change: { kind: "reparent", child_role: "dev", new_parent_role: "ceo" }, change_summary: "x" }),
    ]) {
      const res = await commitOrgRoute(h.deps, h.req({ method: "POST", path: "/org", body }));
      expect(res.status).toBe(HTTP_UNPROCESSABLE);
    }
  });
});

/* ══════════════════ ④ 装配 + 备份编排 ══════════════════ */

describe("④ 装配与备份编排", () => {
  it("装配没接 commitOrgChange ⇒ 501，且消息把修法说清（配 --backup-dir）", async () => {
    const { h } = harness({ wired: false });
    const res = await commitOrgRoute(
      h.deps,
      h.req({ method: "POST", path: "/org", body: REPARENT_BODY }),
    );
    expect(res.status).toBe(HTTP_NOT_IMPLEMENTED);
    expect(JSON.stringify(res.body)).toContain("--backup-dir");
  });

  it("⭐ 备份在提交前发生，成功才提交：库里出现 v1、备份调了一次", async () => {
    const { h, recorder } = harness({ wired: true });
    const res = await commitOrgRoute(
      h.deps,
      h.req({ method: "POST", path: "/org", body: REPARENT_BODY }),
    );
    expect(res.status).toBe(200);
    expect(recorder.calls).toBe(1);
    expect(res.body).toMatchObject({ ok: true, graph_version: 1 });
    // 提交真的写进了 delegation_graphs。
    const v = h.db.prepare("SELECT version, change_summary FROM delegation_graphs ORDER BY version DESC LIMIT 1").get();
    expect(v).toEqual({ version: 1, change_summary: "dev 直接汇报 CEO" });
  });

  it("⭐ 备份失败 ⇒ 拒绝提交：库里【没有】v1，backup_failed，备份仍调了一次", async () => {
    const { h, recorder } = harness({ wired: true, backup: { ok: false, message: "disk full" } });
    const res = await commitOrgRoute(
      h.deps,
      h.req({ method: "POST", path: "/org", body: REPARENT_BODY }),
    );
    expect(recorder.calls).toBe(1);
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
    expect(JSON.stringify(res.body)).toContain("backup_failed");
    expect(JSON.stringify(res.body)).toContain("disk full");
    const v = h.db.prepare("SELECT count(*) AS c FROM delegation_graphs").get();
    expect(Number(v?.c)).toBe(0);
  });

  it("⭐ 校验在 Hub 侧重跑：前端说合法而 Hub 判不过 ⇒ 422 + 不写任何行", async () => {
    // dev→dev 自环会被 validateReparenting 拒（L1/L2），即使前端放行。
    const { h, recorder } = harness({ wired: true });
    const bad = JSON.stringify({
      graph: graph(),
      change: { kind: "reparent", child_role: "dev", new_parent_role: "dev" },
      change_summary: "self-loop",
    });
    const res = await commitOrgRoute(h.deps, h.req({ method: "POST", path: "/org", body: bad }));
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
    // 校验发生在备份【之后】但它不写行 —— 备份还是发生了一次（§6.5：改了组织
    // 就要有快照，哪怕这次没改成）。提交没写进 delegation_graphs。
    expect(recorder.calls).toBe(1);
    const v = h.db.prepare("SELECT count(*) AS c FROM delegation_graphs").get();
    expect(Number(v?.c)).toBe(0);
  });
});

/* ══════════════════ ⑤ GET /org（读侧） ══════════════════ */

describe("⑤ GET /org：装配没接 ⇒ 501；空存 ⇒ 200 空图 v0；提交过 ⇒ 取当前生效那份", () => {
  it("装配没接 readOrgGraph ⇒ 501", () => {
    const { h } = harness({ wired: false });
    const res = orgGraphRoute(h.deps, h.req({ method: "GET", path: "/org" }));
    expect(res.status).toBe(HTTP_NOT_IMPLEMENTED);
  });

  it("从没提交过 ⇒ 200，空图 + graph_version 0（不是 404/500：还没有这个资源）", () => {
    const { h } = harness({ wired: true });
    const res = orgGraphRoute(h.deps, h.req({ method: "GET", path: "/org" }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ graph: { nodes: {}, edges: [] }, graph_version: 0, effective_from: null });
  });

  it("⭐ 提交过一次后 ⇒ 200 取回那张图 + 版本元数据（『保存按钮的成果显示出来』这一格）", async () => {
    const { h } = harness({ wired: true });
    // 先 POST 提交，得 v1。
    const post = await commitOrgRoute(h.deps, h.req({ method: "POST", path: "/org", body: REPARENT_BODY }));
    expect(post.status).toBe(200);
    // 再 GET，能拿到那张图的内容 + 元数据。
    const res = orgGraphRoute(h.deps, h.req({ method: "GET", path: "/org" }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      graph_version: 1,
      change_summary: "dev 直接汇报 CEO",
      effective_from: T0,
    });
    const g = res.body.graph as OrgGraph;
    // delegation_graphs.graph_json 存的是【变更后】的图：dev 已被 reparent 到 ceo。
    expect(g.nodes.dev.reports_to).toBe("ceo");
    expect(g.nodes.tech.reports_to).toBe("ceo");
  });

  it("只取当前生效那份：再提交一次，GET 拿 v2 不拿 v1", async () => {
    const { h } = harness({ wired: true });
    const post1 = await commitOrgRoute(h.deps, h.req({ method: "POST", path: "/org", body: REPARENT_BODY }));
    expect(post1.status).toBe(200);
    // 第二次提交：把 test 汇报到 ceo（原图里 test 汇报 tech；一次合法 reparent）。
    const body2 = JSON.stringify({
      graph: graph(),
      change: { kind: "reparent", child_role: "test", new_parent_role: "ceo" },
      change_summary: "test 直接汇报 CEO",
    });
    const post2 = await commitOrgRoute(h.deps, h.req({ method: "POST", path: "/org", body: body2 }));
    expect(post2.status).toBe(200);
    const res = orgGraphRoute(h.deps, h.req({ method: "GET", path: "/org" }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ graph_version: 2, change_summary: "test 直接汇报 CEO" });
  });
});

