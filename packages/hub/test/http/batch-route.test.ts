/**
 * POST /approvals/batch —— 【规格】§9.4 的批量批准 / 批量打回。
 *
 * ── 这一格此前缺什么 ─────
 * 0052 §3.2 差账表里那行「批量批准/批量打回：前后端都缺」，而它不依赖 Electron/React
 * （前端是手写 app.js），也不是 CEO 规格题 —— §9.4 把判据写死了：仅同类型同方向。
 * 0052 §4 第 3 条定了实现口径：【服务端一处判、前端只做选择集】。
 *
 * ── 审计形状：与 §9.4 字面的一处【刻意偏差】，由 CEO 定 ─────
 * §9.4 写「一次批量操作写入一条审计事件」，落地是【逐卡一条，与单条审批逐字同源，
 * 批量不新增聚合事件】。理由写在 http/app.ts 的 decideBatch 文件头，两处同一口径，
 * 改一处必须改另一处。本文件里那发 ⑦ 把这件事钉成一个读数：3 张卡 ⇒ 3 条决策事件。
 *
 * ── ①–⑥ 与 ⑦ 为什么必须分开 ─────
 * ①–⑥ 的 recordDecision 是【替身 + 计数器】，测的是「有没有调、调了几次、什么顺序」；
 * ⑦ 换成【真 applyDecision + 真迁移库 + 真事件表】，测的是「库里真长出几条事件」。
 * 这个分法不是洁癖：contract.test.ts 那条「404 不写审计」曾经只在替身计数器上成立，
 * 而生产路径压根不存在（real-deps.test.ts 文件头记的就是这次）。批量这边同理 ——
 * 「applied=3」是 handler 自己数出来的，事件表里真有几条是另一件事。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BATCH_MAX_CARDS } from "@opc/contracts";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { InMemoryEventBus } from "../../src/events/bus.js";
import {
  type HubDeps,
  type HubRequest,
  handleRequest,
  matchRoute,
} from "../../src/http/app.js";
import { applyDecision } from "../../src/http/real-deps.js";
import { newLocalToken, signedHeaders } from "../../src/http/auth.js";
import { LOOPBACK_HOST } from "../../src/http/bind.js";
import { DRIVER_OFF } from "../fixtures/driver-state.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("http-batch-route", import.meta.url);
const NOW = 1_700_000_000_000;
const BATCH_PATH = "/approvals/batch";

type Row = Record<string, unknown>;
type Db = {
  prepare: (sql: string) => {
    all: (...a: unknown[]) => Row[];
    get: (...a: unknown[]) => Row | undefined;
    run: (...a: unknown[]) => unknown;
  };
};

const queues: { close: () => Promise<void> }[] = [];
let fileSeq = 0;

interface Harness {
  readonly deps: HubDeps;
  /** 只读连接，与生产 deps.db 同一条；断言读这里。 */
  readonly db: Db;
  /**
   * 写连接，【只用于种夹具数据】。
   *
   * 为什么单独一条：deps.db 必须是【只读】连接（生产 real-deps.ts 给的就是
   * queue.readConnection()，而 handler 里那次 SELECT 走它）—— 拿它种数据会当场
   * "attempt to write a readonly database"。种在写连接、读在只读连接，正好也是
   * 生产形状：写队列 COMMIT 之后只读连接才看得见。④ 那两发的「一张都不动」
   * 断言读的就是这条只读连接，所以它同时是一次 WAL 可见性的实测。
   */
  readonly write: Db;
  readonly calls: {
    decision: { approvalId: string; taskId: string; resume: string }[];
    resumed: string[];
  };
  readonly req: (
    o: Partial<HubRequest> & { method: string; path: string },
  ) => HubRequest;
  readonly sign: (
    method: string,
    target: string,
    body?: string,
  ) => Record<string, string>;
}

/**
 * 一份真迁移库 + 真 WriteQueue。
 *
 * recordDecision 用【真 applyDecision】而不是计数器：批量最贵的两种错是
 * 「handler 数了 3 张而库里只落了 2 行」与「同一条决策写了两次事件」。
 * 计数器对这两种都是瞎的 —— 它自己就是那个数出来的 3。
 *
 * resumeGraph 仍用替身：真图要 @langchain/langgraph 运行时（0009 §2），
 * 而这里要钉的是【调用顺序与失败处置】，不是 LangGraph 收到 resume 之后做了什么。
 * 那半句在 real-deps.test.ts 文件头同样写着，两处同一口径。
 */
async function harness(o: { resumeFailsFor?: string[] } = {}): Promise<Harness> {
  const path = join(TMP, "b-" + process.pid + "-" + ++fileSeq + ".db");
  const queue = new WriteQueue(path) as unknown as {
    writeConnection: () => Db;
    readConnection: () => Db;
    close: () => Promise<void>;
    node: <T>(fn: () => T) => Promise<T>;
  };
  queues.push(queue);
  const write = queue.writeConnection();
  migrate(write as unknown as Parameters<typeof migrate>[0]);
  const read = queue.readConnection();
  const token = newLocalToken();
  const calls: Harness["calls"] = { decision: [], resumed: [] };
  const sign = (method: string, target: string, body = ""): Record<string, string> =>
    signedHeaders(token, { method, target, body, now: NOW });
  const deps: HubDeps = {
    db: read as unknown as DatabaseSync,
    bus: new InMemoryEventBus(),
    token,
    now: () => NOW,
    recordDecision: async ({ approvalId, taskId, resume, note }) => {
      calls.decision.push({ approvalId, taskId, resume });
      return applyDecision(
        queue as unknown as Parameters<typeof applyDecision>[0],
        {
          approvalId,
          taskId,
          resume,
          ...(note === undefined ? {} : { note }),
          nowMs: NOW,
        },
        () => {},
      );
    },
    createTask: async () => {},
    resumeGraph: async (taskId: string) => {
      calls.resumed.push(taskId);
      if (o.resumeFailsFor?.includes(taskId) === true) {
        throw new Error("夹具注入的图恢复失败：" + taskId);
      }
    },
    driverState: () => DRIVER_OFF,
  };
  return {
    deps,
    db: read,
    write,
    calls,
    sign,
    req: (q) => {
      const body = q.body ?? "";
      return {
        query: {},
        body: "",
        ...q,
        target: q.path,
        peer: q.peer ?? LOOPBACK_HOST,
        headers: q.headers ?? sign(q.method, q.path, body),
      };
    },
  };
}

function task(db: Db, id: string): void {
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
      "VALUES (?, ?, 'IN_PROGRESS', 'dev', 'implement', ?, ?)",
  ).run(id, "批量夹具任务 " + id, NOW, NOW);
}

function approval(db: Db, id: string, taskId: string, type = "strategic", status = "pending"): void {
  db.prepare(
    "INSERT INTO approvals (id, task_id, approval_type, summary, parameters, status) " +
      "VALUES (?, ?, ?, '一句话摘要', '{}', ?)",
  ).run(id, taskId, type, status);
}

const json = (body: unknown): string => JSON.stringify(body);
const auditRows = (db: Db): Row[] =>
  db.prepare("SELECT action, task_id, target, payload FROM events ORDER BY id").all();

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

describe("① matchRoute：batch 是两段里的字面段，不许被 :interruptId 吃掉", () => {
  it("⭐ POST /approvals/batch 匹成 decide_batch（这一发同时钉住两条路由的【顺序】）", () => {
    // 挪动 matchRoute 里那两条的先后 ⇒ 这里拿到 kind:"decide" + id:"batch" ⇒ 红。
    // 顺序承重在本仓是【少数派】（:id/token 那两条靠段数就互斥），所以单独钉一发。
    expect(matchRoute("POST", BATCH_PATH)).toEqual({
      kind: "decide_batch",
      endpoint: "POST /approvals/batch",
    });
  });

  it("反向对照：batch 之外的一段仍归 :interruptId；三段仍归 token", () => {
    // 没有这一发，把匹配写成「approvals 后面任何一段都当 batch」也能过 ①。
    expect(matchRoute("POST", "/approvals/a-1")).toEqual({
      kind: "decide",
      endpoint: "POST /approvals/:interruptId",
      id: "a-1",
    });
    expect(matchRoute("POST", "/approvals/a-1/token")?.kind).toBe("mint_token");
    expect(matchRoute("GET", BATCH_PATH)).toBeNull();
    expect(matchRoute("POST", "/approvals/batch/x")).toBeNull();
    expect(matchRoute("POST", "/approvals/")).toBeNull();
  });
});

/* ══════════════════ ② 鉴权：批量没有远程通道 ══════════════════ */

describe("② 鉴权：批量只有回环 HMAC 一条路，带票打在它上面 401", () => {
  it("无签名 401", async () => {
    const h = await harness();
    const res = await handleRequest(
      h.deps,
      h.req({ method: "POST", path: BATCH_PATH, headers: {}, body: json({ approval_ids: ["a"], resume: "approve" }) }),
    );
    expect(res.status).toBe(401);
  });

  it("⭐ 一次性审批票【不覆盖】批量（§20.3 只授权单条审批出本机）", async () => {
    // 这一发是整套里安全形状那一格。remoteTokenAuth 只放 kind==="decide"，
    // 若有人把批量加进那条白名单，远程持票者就能一次批掉整屏卡片 ——
    // 那正是 contracts 拒绝把 approve_all 放进 RESUME_VALUES 时挡的形状（§8.2 第 4 条）。
    const h = await harness();
    const res = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: BATCH_PATH,
        peer: "192.168.1.7",
        body: json({ approval_ids: ["a"], resume: "approve" }),
        headers: { "x-opc-approval-token": "whatever" },
      }),
    );
    expect(res.status).toBe(401);
    expect(h.calls.decision).toHaveLength(0);
  });
});

/* ══════════════════ ③ 请求体判据 ══════════════════ */

describe("③ 请求体：空集 / 超限 / 重复 id / 批量不含第三个按钮 / 打回必带理由", () => {
  const ok = { approval_ids: ["a-1"], resume: "approve" };

  it("空数组 422（要批就点名，不许「全批」）", async () => {
    const h = await harness();
    const res = await handleRequest(
      h.deps,
      h.req({ method: "POST", path: BATCH_PATH, body: json({ ...ok, approval_ids: [] }) }),
    );
    expect(res.status).toBe(422);
    expect(h.calls.decision).toHaveLength(0);
  });

  it(`超限 422（${BATCH_MAX_CARDS + 1} 个 id）`, async () => {
    const h = await harness();
    const ids = Array.from({ length: BATCH_MAX_CARDS + 1 }, (_, i) => `a-${i}`);
    const res = await handleRequest(
      h.deps,
      h.req({ method: "POST", path: BATCH_PATH, body: json({ ...ok, approval_ids: ids }) }),
    );
    expect(res.status).toBe(422);
    expect(h.calls.decision).toHaveLength(0);
  });

  it("⭐ 重复 id 当场 422，而不是服务端悄悄去重", async () => {
    // 去重会让 applied 说谎：交 [a,a] 报 1 要解释「为什么两个 id 只批一张」，
    // 报 2 就是假事实。判在 schema 里 ⇒ 一次决策都不发。
    const h = await harness();
    const res = await handleRequest(
      h.deps,
      h.req({ method: "POST", path: BATCH_PATH, body: json({ ...ok, approval_ids: ["a-1", "a-1"] }) }),
    );
    expect(res.status).toBe(422);
    expect(h.calls.decision).toHaveLength(0);
  });

  it("⭐ defer_deep_review 不是批量取值（§9.4 只有批准/打回）", async () => {
    const h = await harness();
    const res = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: BATCH_PATH,
        body: json({ approval_ids: ["a-1"], resume: "defer_deep_review" }),
      }),
    );
    expect(res.status).toBe(422);
    expect(h.calls.decision).toHaveLength(0);
  });

  it("reject_with_comment 缺 note / 纯空白 note 都 422", async () => {
    const h = await harness();
    for (const note of [undefined, "   "]) {
      const res = await handleRequest(
        h.deps,
        h.req({
          method: "POST",
          path: BATCH_PATH,
          body: json({
            approval_ids: ["a-1"],
            resume: "reject_with_comment",
            ...(note === undefined ? {} : { note }),
          }),
        }),
      );
      expect(res.status, `note=${String(note)}`).toBe(422);
    }
    expect(h.calls.decision).toHaveLength(0);
  });
});

/* ══════════════════ ④ 同类型 + 都存在：整批不写 ══════════════════ */

describe("④ §9.4 判据在写之前判完：混类型 422、有缺失 404，两种都一张不动", () => {
  it("⭐ 混类型 ⇒ 422 + 报出混了哪几种，且 recordDecision 零调用", async () => {
    const h = await harness();
    task(h.write, "task-1");
    approval(h.write, "a-1", "task-1", "strategic");
    approval(h.write, "a-2", "task-1", "budget_override");
    const res = await handleRequest(
      h.deps,
      h.req({ method: "POST", path: BATCH_PATH, body: json({ approval_ids: ["a-1", "a-2"], resume: "approve" }) }),
    );
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ types: ["budget_override", "strategic"] });
    expect(h.calls.decision).toHaveLength(0);
    // 真库读数：卡片仍是 pending，事件表一条没有。422 的「一张都不动」不许只靠计数器。
    expect(String(h.db.prepare("SELECT status FROM approvals WHERE id='a-1'").get()?.status)).toBe("pending");
    expect(auditRows(h.db)).toHaveLength(0);
  });

  it("⭐ 有一个 id 不存在 ⇒ 404 + missing，且【已存在的那些也不动】（整批不写）", async () => {
    // 这一发守的是「半批成功」：服务端先判后写，所以存在的那张也不该被批掉。
    const h = await harness();
    task(h.write, "task-1");
    approval(h.write, "a-1", "task-1");
    const res = await handleRequest(
      h.deps,
      h.req({ method: "POST", path: BATCH_PATH, body: json({ approval_ids: ["a-1", "ghost"], resume: "approve" }) }),
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ missing: ["ghost"] });
    expect(h.calls.decision).toHaveLength(0);
    expect(String(h.db.prepare("SELECT status FROM approvals WHERE id='a-1'").get()?.status)).toBe("pending");
    expect(auditRows(h.db)).toHaveLength(0);
  });

  it("正向对照：同类型 200，逐张各写一次", async () => {
    // 上面两发的反例。少了它，「判据一命中就 return」把整条写路径删掉也能全绿。
    const h = await harness();
    task(h.write, "task-1");
    approval(h.write, "a-1", "task-1");
    approval(h.write, "a-2", "task-1");
    const res = await handleRequest(
      h.deps,
      h.req({ method: "POST", path: BATCH_PATH, body: json({ approval_ids: ["a-1", "a-2"], resume: "approve" }) }),
    );
    expect(res.status).toBe(200);
    expect(h.calls.decision.map((d) => d.approvalId)).toEqual(["a-1", "a-2"]);
  });
});

/* ══════════════════ ⑤ 重放那一张不重走写路径 ══════════════════ */

describe("⑤ 已决策的那一张计进 replayed，不再调写路径（append-only 不写第二条）", () => {
  it("⭐ pending + approved 混选 ⇒ applied 1 / replayed 1，库里只有 1 条决策事件", async () => {
    const h = await harness();
    task(h.write, "task-1");
    approval(h.write, "a-1", "task-1", "strategic", "pending");
    approval(h.write, "a-2", "task-1", "strategic", "approved");
    const res = await handleRequest(
      h.deps,
      h.req({ method: "POST", path: BATCH_PATH, body: json({ approval_ids: ["a-1", "a-2"], resume: "approve" }) }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, applied: 1, replayed: 1 });
    expect(h.calls.decision.map((d) => d.approvalId)).toEqual(["a-1"]);
    expect(auditRows(h.db)).toHaveLength(1);
  });

  it("全部已决策 ⇒ applied 0 / replayed 2 / 零事件，但仍 200", async () => {
    // 200 而不是 4xx 与单条 decide 同口径：调用方要的答案是「我的点击生效了吗」。
    const h = await harness();
    task(h.write, "task-1");
    approval(h.write, "a-1", "task-1", "strategic", "approved");
    approval(h.write, "a-2", "task-1", "strategic", "approved");
    const res = await handleRequest(
      h.deps,
      h.req({ method: "POST", path: BATCH_PATH, body: json({ approval_ids: ["a-1", "a-2"], resume: "approve" }) }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: 0, replayed: 2 });
    expect(h.calls.decision).toHaveLength(0);
    expect(auditRows(h.db)).toHaveLength(0);
  });
});

/* ══════════════════ ⑥ 图恢复的失败处置 ══════════════════ */

describe("⑥ 图恢复：一张失败不丢掉其余，且响应不许诱导重发整批", () => {
  it("⭐ 第 1 张恢复失败 ⇒ 仍继续恢复第 2 张，最后 500 + applied/resume_failed + retry_hint", async () => {
    // 不能照抄单条 decide 的「不 catch」：批量在第 1 张就整批 500，第 2 张的图
    // 一次都不恢复，而 500 会诱导调用方重发整批 —— 那时两张都已 decided，
    // 重发全读成 replayed（幂等空转、不再恢复），「图没恢复」就被永久钉死。
    const h = await harness({ resumeFailsFor: ["task-1"] });
    task(h.write, "task-1");
    task(h.write, "task-2");
    approval(h.write, "a-1", "task-1");
    approval(h.write, "a-2", "task-2");
    const res = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: BATCH_PATH,
        body: json({ approval_ids: ["a-1", "a-2"], resume: "approve" }),
      }),
    );
    expect(h.calls.resumed).toEqual(["task-1", "task-2"]); // 失败没截断循环
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ applied: 2, replayed: 0, resume_failed: 1 });
    expect(JSON.stringify(res.body)).toContain("不要重发");
    // 决策本身仍落库（不可回滚）：两张各有 1 条事件。
    expect(auditRows(h.db)).toHaveLength(2);
  });

  it("反向对照：都不失败 ⇒ 200 且每张各恢复一次", async () => {
    const h = await harness();
    task(h.write, "task-1");
    task(h.write, "task-2");
    approval(h.write, "a-1", "task-1");
    approval(h.write, "a-2", "task-2");
    const res = await handleRequest(
      h.deps,
      h.req({ method: "POST", path: BATCH_PATH, body: json({ approval_ids: ["a-1", "a-2"], resume: "approve" }) }),
    );
    expect(res.status).toBe(200);
    expect(h.calls.resumed).toEqual(["task-1", "task-2"]);
  });

  it("重放那一张不恢复图（抢到那次已恢复，重复一次 = 白烧一份预算）", async () => {
    const h = await harness();
    task(h.write, "task-1");
    approval(h.write, "a-1", "task-1", "strategic", "pending");
    approval(h.write, "a-2", "task-1", "strategic", "approved");
    await handleRequest(
      h.deps,
      h.req({ method: "POST", path: BATCH_PATH, body: json({ approval_ids: ["a-1", "a-2"], resume: "approve" }) }),
    );
    expect(h.calls.resumed).toEqual(["task-1"]);
  });
});

/* ══════════════════ ⑦ 真事件形状（§9.4 那处偏差的读数）══════════════════ */

describe("⑦ 真写路径：逐卡一条决策事件，批量不新增聚合事件", () => {
  it("⭐ 3 张卡 ⇒ 恰好 3 条 action=approval 事件，target 各指一张卡，零聚合行", async () => {
    // 「一次批量一条事件」若被实现成一条 payload 带 id 数组的聚合行，
    // 这里会是 1 条 ⇒ 红。CEO 定的口径与理由在 decideBatch 文件头。
    const h = await harness();
    task(h.write, "task-1");
    approval(h.write, "a-1", "task-1");
    approval(h.write, "a-2", "task-1");
    approval(h.write, "a-3", "task-1");
    const res = await handleRequest(
      h.deps,
      h.req({ method: "POST", path: BATCH_PATH, body: json({ approval_ids: ["a-1", "a-2", "a-3"], resume: "approve" }) }),
    );
    expect(res.status).toBe(200);
    const rows = auditRows(h.db);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => String(r.action)))).toEqual(new Set(["approval"]));
    expect(rows.map((r) => String(r.target)).sort()).toEqual(["a-1", "a-2", "a-3"]);
    expect(String(rows[0]?.payload)).toContain('"resume":"approve"');
    // 卡片状态真变了（不是只有事件）。
    expect(
      h.db.prepare("SELECT status FROM approvals ORDER BY id").all().map((r) => String(r.status)),
    ).toEqual(["approved", "approved", "approved"]);
  });

  it("打回带 note ⇒ 三张卡的 decision_note 都是那句理由，事件同样是 3 条", async () => {
    const h = await harness();
    task(h.write, "task-1");
    approval(h.write, "a-1", "task-1");
    approval(h.write, "a-2", "task-1");
    const res = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: BATCH_PATH,
        body: json({ approval_ids: ["a-1", "a-2"], resume: "reject_with_comment", note: "理由要能拿去执行" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: 2, resume: "reject_with_comment" });
    expect(
      h.db.prepare("SELECT decision_note, status FROM approvals ORDER BY id").all(),
    ).toEqual([
      { decision_note: "理由要能拿去执行", status: "rejected" },
      { decision_note: "理由要能拿去执行", status: "rejected" },
    ]);
    expect(auditRows(h.db)).toHaveLength(2);
  });
});
