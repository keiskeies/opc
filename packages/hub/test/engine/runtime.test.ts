/**
 * 装配层（engine/runtime.ts）—— 那些 SQL 真的读对了东西吗。
 *
 * ── 为什么这一发不能省 ────────────────────────────────────────────────
 * dispatch.test.ts 把判定测尽了，而那些测试给 dispatch 喂的是【测试作者手写的回调】。
 * 于是有一整类缺陷在那边结构性测不到：判定全对、SQL 读错。典型三条
 *  · modelFamily 读了最新图而不是任务那一版 ⇒ 审阅独立性按错的档位判，而每一轮都「正常」；
 *  · roleSession 取到 NULL（上次那次 CLI 启动失败）⇒ 这个角色从此每轮从零开始，症状只是慢；
 *  · onCost 少写一行 budget_events ⇒ tasks.consumed_cents 与 budgets.consumed_cents 分叉，
 *    而 integrity.ts 那条 harness_call_recorded 就是为这一格准备的（它今天恒 not_observable）。
 * 本文件测的就是【真 SQL + 真 schema + 真 CLI 桩】那一段。
 *
 * ── 为什么用的是 HubWriter 而不是只喂 node() ──────────────────────────
 * runtime 的多数回调是【同步】签名，等不了 queue.read()/node()。所以读走
 * readConnection()。这条选择本身带着一个必须钉住的边界（见 runtime.ts 文件头）：
 * 只读连接只看得到【已提交】，所以「同一轮里先写后读」必然读到旧值 ——
 * 下面那条【写完之后从回调读回来】的用例就是把这个边界摆在明处，
 * 免得下一个人以为回调能读到自己刚写的东西。
 *
 * 跑法（离线、node v24.14.0）：
 *   PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH \
 *     node --experimental-transform-types --import /tmp/opc-harness/register.mjs \
 *     --test packages/hub/test/engine/runtime.test.ts
 */
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { OrgGraph } from "@opc/contracts";
import { fixtureTmp } from "../fixtures/fixture-dir.js";
import { migrate } from "../../src/db/migrate.js";
import { INSERT_DELEGATION_GRAPH_SQL } from "../../src/org/commit.js";
import { InMemoryEventBus } from "../../src/events/bus.js";
import { appendAudit } from "../../src/events/recorder.js";
import { makeDispatch } from "../../src/engine/dispatch.js";
import {
  CEO_APPROVED_SQL,
  INSERT_HARNESS_CALL_SQL,
  LAST_SESSION_SQL,
  LOAD_TASK_SQL,
  makeRuntime,
} from "../../src/engine/runtime.js";

const TMP = fixtureTmp("engine-runtime", import.meta.url);
const NOW = 1_700_000_000_000;
const FAKE_CLI = new URL("./fixtures/fake-claude.mjs", import.meta.url).pathname;

type Row = Record<string, unknown>;
type Db = {
  prepare: (sql: string) => {
    all: (...a: unknown[]) => Row[];
    get: (...a: unknown[]) => Row | undefined;
    run: (...a: unknown[]) => unknown;
  };
  exec: (sql: string) => void;
};
type Queue = {
  node: <T>(fn: () => Promise<T> | T) => Promise<T>;
  readConnection: () => Db;
  writeConnection: () => Db;
  close: () => Promise<void>;
};

const queues: Queue[] = [];
let fileSeq = 0;

const GRAPH: OrgGraph = {
  nodes: {
    ceo: { role_id: "ceo", can_manage: true, reports_to: null, model_family: "opus" },
    director: { role_id: "director", can_manage: true, reports_to: "ceo", model_family: "sonnet" },
    dev: { role_id: "dev", can_manage: false, reports_to: "director", model_family: "claude" },
    // 没有 model_family 的那一格：装配方必须交出空串（reviewGate 据此拒放行）
    blank: { role_id: "blank", can_manage: false, reports_to: "director" },
  },
  edges: [{ from: "dev", to: "director", review_gate: true }],
};

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
  // 桩 CLI 要能被 spawn 执行。git 不一定保住执行位（新克隆 / 换文件系统），
  // 少了这一发，报错会是「CLI 输出不是预期的 JSON」—— 那次误导我在 claude.test.ts
  // 里已经记过一次，这里直接在装配处兜住，不再让 EACCES 伪装成协议错误。
  try {
    chmodSync(FAKE_CLI, 0o755);
  } catch {
    /* 测试夹具缺失就让后面的用例如实红，不在这里编一个成功 */
  }
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

interface World {
  db: Db;
  q: Queue;
  rt: ReturnType<typeof makeRuntime>;
  bus: InMemoryEventBus;
}

async function world(o: {
  readonly status?: string;
  readonly role?: string;
  readonly graphVersion?: number;
  /** 写不写组织图。不写 ⇒ 造「版本缺失」那一发。 */
  readonly writeGraph?: boolean;
  /** 换整张图（0047 那几发要的是【根不叫 ceo】与【两个根】两种形状）。 */
  readonly graph?: OrgGraph;
  /**
   * 装配的 --ceo。给 null 表示【不指定】—— 那时「谁是 CEO」只能由图回答，
   * 这一格是 0047 那一半修复唯一的开关（原来 runtime 里写死 `?? "ceo"`，
   * 不指定就等于宣布根叫 ceo）。
   */
  readonly ceoRoleId?: string | null;
}): Promise<World> {
  const { WriteQueue } = await import("../../src/db/write-queue.js");
  const q = new WriteQueue(TMP + "/r-" + process.pid + "-" + ++fileSeq + ".db") as unknown as Queue;
  queues.push(q);
  const db = q.writeConnection();
  migrate(db as unknown as Parameters<typeof migrate>[0]);
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at, graph_version) " +
      "VALUES ('t1', '做个 AI 笔记应用', ?, ?, 'intake', ?, ?, ?)",
  ).run(o.status ?? "IN_PROGRESS", o.role ?? "dev", NOW, NOW, o.graphVersion ?? 1);
  if (o.writeGraph !== false) {
    db.prepare(INSERT_DELEGATION_GRAPH_SQL).run(
      "g1",
      1,
      JSON.stringify(o.graph ?? GRAPH),
      NOW,
      "ceo",
      "测试用组织图",
    );
  }
  const bus = new InMemoryEventBus();
  const rt = makeRuntime({
    writer: q as unknown as Parameters<typeof makeRuntime>[0]["writer"],
    bus,
    maxBudgetUsd: 0.5,
    taskLimitCents: 1000,
    cwd: TMP,
    bin: FAKE_CLI,
    ...(o.ceoRoleId === null ? {} : { ceoRoleId: o.ceoRoleId ?? "ceo" }),
  });
  return { db, q, rt, bus };
}

describe("runtime 的读回调（真 schema 上的真 SQL）", () => {
  it("loadTask 交出的是 tasks 那一行，不是它旁边的东西", async () => {
    const w = await world({});
    const t = w.rt.deps.loadTask("t1");
    expect(t).not.toBeNull();
    expect(t?.title).toBe("做个 AI 笔记应用");
    expect(t?.status).toBe("IN_PROGRESS");
    expect(t?.role).toBe("dev");
    expect(t?.graphVersion).toBe(1);
  });

  it("loadTask 对不存在的任务给 null，而不是一个字段全空的壳", async () => {
    const w = await world({});
    expect(w.rt.deps.loadTask("ghost")).toBeNull();
  });

  it("modelFamily 读的是【任务那一版】的图；版本缺失 ⇒ 空串而不是最新图（§18.4）", async () => {
    const ok = await world({});
    ok.rt.deps.loadTask("t1");
    expect(ok.rt.deps.modelFamily("dev")).toBe("claude");
    // 没声明家族的那一格：交出空串。这里【不能】给一个默认家族名 ——
    // 审阅独立性整个建立在「这个角色属于哪个家族」上，编一个就是发一张假身份证。
    expect(ok.rt.deps.modelFamily("blank")).toBe("");
    expect(ok.rt.deps.modelFamily("没这个角色")).toBe("");

    // 任务指向一个不存在的图版本
    const missing = await world({ graphVersion: 9 });
    missing.rt.deps.loadTask("t1");
    expect(missing.rt.deps.modelFamily("dev")).toBe("");
  });

  it("roleSession 跳过【没有 session_id 的那几次】执行，取回真正上一个会话", async () => {
    const w = await world({});
    const ins = (session: string | null, at: number, role = "dev"): void => {
      w.db
        .prepare(INSERT_HARNESS_CALL_SQL)
        .run("h-" + at, "t1", role, "0.0.0", "{}", session, session === null ? 1 : 0, 1, at);
    };
    // 时间序：有会话 → 无会话（那次 CLI 没起来）→ 无会话（又一次）
    ins("sess-old", NOW);
    ins(null, NOW + 1000);
    ins(null, NOW + 2000);
    expect(w.rt.deps.roleSession("t1", "dev")).toBe("sess-old");
    // 换个角色就查不到：会话是【按角色】的，dev 的上下文不能 resume 到 director 身上
    expect(w.rt.deps.roleSession("t1", "director")).toBeNull();
    // SQL 形状本身也钉一下：条件里少了 session_id IS NOT NULL 这条查询就会取到 NULL，
    // 而症状是「这个角色每轮都从零开始」，没人会去查 SQL。
    expect(LAST_SESSION_SQL).toContain("session_id IS NOT NULL");
  });

  it("lastProducer 从最近的状态变化里往回找带 producerRole 的那一条", async () => {
    const w = await world({});
    const evt = (payload: unknown): void => {
      w.db
        .prepare(
          "INSERT INTO events (task_id, actor_type, actor_id, action, target, payload, state_snapshot, created_at) " +
            "VALUES ('t1','agent','dev','state_change','x',?, NULL, ?)",
        )
        .run(JSON.stringify(payload), NOW);
    };
    // 最新的是【另一条】状态变化（没有 producerRole），往回第二条才是提交审阅那条
    evt({ kind: "TaskStateChanged", taskId: "t1", from: "EVIDENCE_SUBMITTED", to: "IN_REVIEW" });
    evt({ kind: "TaskStateChanged", taskId: "t1", from: "IN_PROGRESS", to: "EVIDENCE_SUBMITTED", producerRole: "dev" });
    expect(w.rt.deps.lastProducer("t1")).toBe("dev");

    // 一条提交都没有 ⇒ null（不是拿最近一条的 producerRole 顶上，也不是拿 assigned_role）
    const fresh = await world({});
    expect(fresh.rt.deps.lastProducer("t1")).toBeNull();
  });

  it("⭐ rejectionCount 数的是【打回那一条边】，一次打回 = 1 而不是 2", async () => {
    // §4.2.1 max_rejections 的分子。这条 SQL 全部的正确性在"数 payload.$.to
    // 而【不数 action】"，而这件事只能在这一层测：dispatch.test.ts 喂的是手写回调。
    //
    // 为什么【必须】用生产的 appendAudit 写这些行而不用裸 INSERT：
    // 一次打回在 dispatch 那一轮写的是【两条】state_change 边（REJECTED_DOWNWARD 那一跳
    // + AUTO_AFTER_EDGE 自动补的 IN_PROGRESS 那一跳）。裸 INSERT 手写两条是我【以为的】
    // 写入形状；appendAudit 写的才是库里的真形状。真形状变了（比如将来有人把自动那一跳
    // 的 payload.to 也写成 REJECTED_DOWNWARD），裸 INSERT 那一发照样绿。
    const w = await world({});
    expect(w.rt.deps.rejectionCount("t1")).toBe(0); // 干净库 ⇒ 0，不是 null / undefined

    // 一轮打回 = 两条边（形状抄 dispatch.ts 那条 chain 循环）
    const edge = (from: string, to: string): void => {
      appendAudit(
        w.db as never,
        {
          taskId: "t1",
          actorType: "agent",
          actorId: "director",
          action: "state_change",
          target: to,
          payload: { kind: "TaskStateChanged", taskId: "t1", from, to, summary: "测试" },
          createdAt: NOW,
        },
        () => NOW,
      );
    };
    edge("IN_REVIEW", "REJECTED_DOWNWARD");
    edge("REJECTED_DOWNWARD", "IN_PROGRESS");
    const rows = w.db.prepare("SELECT COUNT(*) AS n FROM events WHERE action='state_change'").get();
    expect(rows?.["n"]).toBe(2); // 一轮确实留了两条 state_change
    expect(w.rt.deps.rejectionCount("t1")).toBe(1); // ⭐ 而分子只能是 1

    // 再来两轮 ⇒ 3。上限正好在 3 这一格触发（dispatch.test.ts 那两发接的就是这个数），
    // 所以这一句同时钉住"分子不多不少"：数成 6 会让上限【提前一倍】咬，
    // 屏幕上没有任何一处会说"这次升级是因为计数算重了"。
    edge("IN_REVIEW", "REJECTED_DOWNWARD");
    edge("REJECTED_DOWNWARD", "IN_PROGRESS");
    edge("IN_REVIEW", "REJECTED_DOWNWARD");
    edge("REJECTED_DOWNWARD", "IN_PROGRESS");
    expect(w.rt.deps.rejectionCount("t1")).toBe(3);

    // 别的动作不算打回（同一件事换个 action 就是另一件事）
    appendAudit(
      w.db as never,
      {
        taskId: "t1",
        actorType: "agent",
        actorId: "director",
        action: "review_decision",
        target: "REJECTED_DOWNWARD",
        payload: { kind: "ReviewDecided", taskId: "t1", to: "REJECTED_DOWNWARD" },
        createdAt: NOW,
      },
      () => NOW,
    );
    expect(w.rt.deps.rejectionCount("t1")).toBe(3);
    // 另一条任务的打回不串号（分子是【这条想法】被打回几次）
    expect(w.rt.deps.rejectionCount("ghost")).toBe(0);
  });

  it("recentSummaries 拿到的是 payload.summary，脏 payload 不会掀翻整轮", async () => {
    const w = await world({});
    const evt = (payload: string): void => {
      w.db
        .prepare(
          "INSERT INTO events (task_id, actor_type, actor_id, action, target, payload, state_snapshot, created_at) " +
            "VALUES ('t1','agent','dev','state_change','x',?, NULL, ?)",
        )
        .run(payload, NOW);
    };
    evt(JSON.stringify({ summary: "登录模块写完" }));
    evt("{这不是合法 JSON"); // 一行历史脏数据
    evt(JSON.stringify({ summary: "   " })); // 空白摘要不算一条汇报
    const s = w.rt.deps.recentSummaries("t1");
    expect(s).toEqual(["登录模块写完"]);
  });

  it("ceoApproved 只认 status='approved'：pending / rejected 都不算放行凭据", async () => {
    const w = await world({});
    const card = (status: string, key: string): void => {
      w.db
        .prepare(
          "INSERT INTO approvals (id, task_id, approval_type, summary, parameters, recommendation, " +
            "recommendation_source, timeout_behavior, timeout_at, status, decided_by, decided_at, " +
            "decision_note, card_key, created_at) " +
            "VALUES (?, 't1', 'escalation', 's', '{}', 'r', NULL, 'escalate', ?, ?, NULL, NULL, NULL, ?, ?)",
        )
        .run("a-" + status, NOW + 1, status, key, NOW);
    };
    card("pending", "k-pending");
    card("rejected", "k-rejected");
    card("approved", "k-approved");
    expect(w.rt.deps.ceoApproved("t1", "k-approved")).toBe(true);
    expect(w.rt.deps.ceoApproved("t1", "k-pending")).toBe(false);
    expect(w.rt.deps.ceoApproved("t1", "k-rejected")).toBe(false);
    expect(w.rt.deps.ceoApproved("t1", "没有这张卡")).toBe(false);
    expect(CEO_APPROVED_SQL).toContain("status = 'approved'");
  });
});

describe("rolePrompt 里那句「谁是 CEO」（0047 的装配那一半）", () => {
  const BOSS_GRAPH: OrgGraph = {
    nodes: {
      boss: { role_id: "boss", can_manage: true, reports_to: null, model_family: "opus" },
      dev: { role_id: "dev", can_manage: false, reports_to: "boss", model_family: "claude" },
    },
    edges: [],
  };

  it("根叫 boss ⇒ 简报里写的是 boss，而【不是】那个字面量 ceo", async () => {
    // 修前这里是 `?? "ceo"`：简报会告诉一个 agent「CEO（角色 ceo）是唯一的决策者」，
    // 而这张图里没有 ceo 这个人 —— agent 照着喊一句汇报对象，对象不存在。
    const w = await world({ graph: BOSS_GRAPH, ceoRoleId: null });
    w.rt.deps.loadTask("t1"); // 图跟着任务钉进来（不 loadTask 就没有 cacheGraph）
    const p = w.rt.deps.rolePrompt("dev");
    expect(p).toContain("角色 boss");
    expect(p).not.toContain("角色 ceo");
  });

  it("⭐ 判不出【不退回任何名字】，而是把「说不出来」原样写进简报", async () => {
    // 两个根的图 + 不指定 ⇒ resolveCeoRoleId 拒绝。这一条守的是"编一个名字出去"
    // 那条退路：编出来的名字会让 agent 对着一个不存在的同事汇报。
    const forest: OrgGraph = {
      nodes: {
        a: { role_id: "a", can_manage: true, reports_to: null, model_family: "opus" },
        b: { role_id: "b", can_manage: true, reports_to: null, model_family: "opus" },
      },
      edges: [],
    };
    const w = await world({ graph: forest, ceoRoleId: null });
    w.rt.deps.loadTask("t1");
    const p = w.rt.deps.rolePrompt("a");
    expect(p).toContain("说不出");
    // 一个名字都没提：既不编根，也不拿 nodes 里第一个凑数
    expect(p).not.toContain("角色 a");
    expect(p).not.toContain("角色 b");
    // 而它【不改变动作】—— 下一跳仍由 hub 判，这句是提示词层的全部职责
    expect(p).toContain("由 hub 按组织图判");
  });

  it("图还没钉（没 loadTask）⇒ 同样是「说不出」那一支，而不是拿最新图顶上", async () => {
    const w = await world({});
    expect(w.rt.deps.rolePrompt("dev")).toContain("说不出");
  });
});

describe("runtime 跑一轮：真 CLI 桩 + 真记账 + 真留痕", () => {
  it("一轮 pass 之后：状态推进、钱进了 budget_events 与 budgets、会话落 harness_calls", async () => {
    const w = await world({});
    const dispatch = makeDispatch(w.rt.deps);
    const res = await dispatch({ taskId: "t1", nowMs: NOW + 1000, maxBudgetUsd: 0.5 });
    // 桩 CLI 的决策是 handoff 给 "tech"（图里没有这个角色）⇒ 越权，状态不动。
    // 这一发测的不是判定（dispatch.test.ts 测尽了），是【装配之后账还在不在】。
    expect(res.moved).toBe(false);
    expect(res.costCents).toBe(4); // 0.042 美元 ⇒ 4 美分

    const rec = await w.rt.recordTurn({
      taskId: "t1",
      role: res.role,
      sessionId: res.sessionId,
      costCents: res.costCents,
      ok: true,
      nowMs: NOW + 1000,
    });
    expect(rec.recorded).toBe(true);

    // 三处账必须一致：tasks / budget_events / budgets
    const task = w.db.prepare("SELECT consumed_cents FROM tasks WHERE id='t1'").get();
    expect(task?.["consumed_cents"]).toBe(4);
    const be = w.db.prepare("SELECT * FROM budget_events").all();
    expect(be.length).toBe(1);
    expect(be[0]?.["amount_cents"]).toBe(4);
    expect(be[0]?.["scope_type"]).toBe("task");
    expect(be[0]?.["period"]).toBe("per_task");
    // 幂等键【是】本轮那条 events.id。刻意断在 res.stateEventSeq 而不是
    // 「events 表最后一行」：卡片与越权尝试那两行是在记账【之后】写的，所以最后一行
    // 不是记账用的那个 id —— 断成"最后一行"会把这条测试变成对写入顺序的猜测。
    const ids = w.db.prepare("SELECT id FROM events ORDER BY id").all().map((r) => Number(r["id"]));
    expect(be[0]?.["source_event"]).not.toBeNull();
    expect(ids).toContain(Number(be[0]?.["source_event"]));
    expect(Number(be[0]?.["source_event"])).toBe(res.stateEventSeq);
    const b = w.db.prepare("SELECT * FROM budgets WHERE scope_type='task'").all();
    expect(b.length).toBe(1);
    expect(b[0]?.["consumed_cents"]).toBe(4);
    expect(b[0]?.["limit_cents"]).toBe(1000);

    const hc = w.db.prepare("SELECT * FROM harness_calls").all();
    expect(hc.length).toBe(1);
    expect(hc[0]?.["session_id"]).toBe("sess-1");
    expect(hc[0]?.["cost_cents"]).toBe(4);
    expect(hc[0]?.["exit_code"]).toBe(0);
    // 脱敏：那一列的名字是 redacted，prompt 由 CEO 输入、可能带业务机密。
    expect(String(hc[0]?.["args_redacted"])).not.toContain("做个 AI 笔记应用");

    // 下一轮真的能 resume 到这个会话（§5.9「打回时不从零开始」的落点）
    expect(w.rt.deps.roleSession("t1", "dev")).toBe("sess-1");
  });

  it("同一轮重复记账被幂等键挡下：budgets 不重复扣", async () => {
    const w = await world({});
    const dispatch = makeDispatch(w.rt.deps);
    const res = await dispatch({ taskId: "t1", nowMs: NOW + 1000, maxBudgetUsd: 0.5 });
    // 幂等键取 res.stateEventSeq，【不是】events 表最后一行：这一轮被越权拦下，
    // 卡片与越权尝试那两行写在记账之后，最后一行是别的行 —— 拿它当键会插进
    // 【第二笔真账】（我第一次就是这么写的，于是这条测试自己造出了它要防的分叉）。
    const seq = res.stateEventSeq;
    if (seq === null) throw new Error("本轮没写下 events，无从谈幂等键");
    // 直接拿同一个 seq 再喂一次钩子（等价于「同一轮重试」）
    await w.q.node(() => {
      const db = w.q.writeConnection();
      // 走的是 runtime 里那条 onCost，不是重抄一遍 SQL
      const hook = w.rt.deps.onCost;
      if (hook === undefined) throw new Error("onCost 没装配");
      hook({ db, taskId: "t1", role: "dev", seq, costCents: 4, nowMs: NOW + 2000 });
      return null;
    });
    expect(w.db.prepare("SELECT * FROM budget_events").all().length).toBe(1);
    expect(w.db.prepare("SELECT consumed_cents FROM budgets").get()?.["consumed_cents"]).toBe(4);
    // tasks 那一列【没有】幂等键可挡（dispatch.ts 的 centsForLeg 那条同源的说明），
    // 所以这一发同时在证明：钩子重复调用只动 budget_events 的去重，不会碰 tasks。
    expect(w.db.prepare("SELECT consumed_cents FROM tasks").get()?.["consumed_cents"]).toBe(4);
  });

  it("留痕失败【不冒泡】但报 recorded:false —— 不能让整条命令非零退出而诱导重跑一轮", async () => {
    const w = await world({});
    // harness_calls.task_id 【没有】外键（0001 里那列是裸 TEXT），所以「指向不存在的任务」
    // 造不出失败 —— 会照样插进去。改成关队列：node() 当场抛「已关闭」，
    // 这才是本发要测的形状（写入这一侧失败，而状态与账都已提交）。
    await w.q.close();
    const r = await w.rt.recordTurn({
      taskId: "t1",
      role: "dev",
      sessionId: null,
      costCents: 1,
      ok: true,
      nowMs: NOW,
    });
    expect(r.recorded).toBe(false);
    expect(r.why).toContain("harness_calls");
    // 不抛错这件事本身是断言的重点：抛出去的话驱动方会非零退出，
    // 而使用者看到失败会【重跑整轮】= 再烧一次 token 去补一行日志。
  });

  it("costCents 为负 ⇒ 拒写，而不是给执行日志记一笔退款", async () => {
    const w = await world({});
    const r = await w.rt.recordTurn({
      taskId: "t1",
      role: "dev",
      sessionId: null,
      costCents: -5,
      ok: true,
      nowMs: NOW,
    });
    expect(r.recorded).toBe(false);
    expect(w.db.prepare("SELECT * FROM harness_calls").all().length).toBe(0);
  });

  it("图版本缺失时，dispatch 以「版本缺失」停下而【没有烧一次 token】（装配不给回退）", async () => {
    const w = await world({ graphVersion: 9 });
    const dispatch = makeDispatch(w.rt.deps);
    const res = await dispatch({ taskId: "t1", nowMs: NOW + 1000, maxBudgetUsd: 0.5 });
    expect(res.moved).toBe(false);
    expect(res.note).toContain("版本 9");
    // 关键：一个 token 都没烧 ⇒ 一条 harness 调用都没发生
    expect(w.db.prepare("SELECT * FROM harness_calls").all().length).toBe(0);
    expect(w.db.prepare("SELECT * FROM budget_events").all().length).toBe(0);
    expect(w.db.prepare("SELECT consumed_cents FROM tasks").get()?.["consumed_cents"]).toBe(0);
  });

  it("回调读的是【已提交】的东西：同轮内先写后读会读到旧值（runtime.ts 文件头那条边界）", async () => {
    const w = await world({});
    w.rt.deps.loadTask("t1");
    // 写连接改了状态、还没提交到读侧视野之外？—— WAL 下同一连接的未提交改动
    // 本来就看不见。这一发的作用是：如果有人把回调的读连接换成写连接，
    // 他会看到【未提交】数据，而下面这条断言会红。
    await w.q.node(() => {
      w.q.writeConnection().prepare("UPDATE tasks SET title = '改了' WHERE id='t1'").run();
      const inTx = w.q.writeConnection().prepare(LOAD_TASK_SQL).get("t1") as Row | undefined;
      expect(inTx?.["title"]).toBe("改了");
      return null;
    });
    // 提交之后，只读连接看得到
    const after = w.rt.deps.loadTask("t1");
    expect(after?.title).toBe("改了");
  });
});
