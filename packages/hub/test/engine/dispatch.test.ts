/**
 * 调度器的门（engine/dispatch.ts）。
 *
 * ── 这个文件测的是【谁说了不算】──────────────────────────────────────
 * 引擎换了路线之后，「下一步找谁」交回给了 agent（claude.ts + parseDecision），
 * 于是本仓最贵的那一类失效换了个位置：不再是「图写死了流转」，而是
 * 「agent 说自己交付了，于是任务真的交付了」。这里每一条断言都在钉【另一半】：
 * 那句话在 hub 这边撞上什么。所以断言的方向一律是【拒绝】优先 ——
 * 一条误拒的边下一轮还能重试，一条误放的边写进 append-only 的 events 就永远在那儿。
 *
 * ── 为什么一半是纯函数、一半要真库 ───────────────────────────────────
 * planEdge / handoffGate / reviewGate / seatOf 是纯判定，穷尽它们不需要库。
 * 而「tasks 与 events 同事务」「状态守卫真的拦得住」「卡片撞去重键不重复建」
 * 只有在【真迁移出来的 schema】上才算数 —— 那些约束（partial unique index、
 * append-only 触发器、FK）在替身连接上一条都不存在（同 real-deps.test.ts 的立场）。
 * agent 那一发用替身：本文件的主题是门，不是 CLI（CLI 的进程边界在 claude.test.ts）。
 *
 * 跑法（离线、node v24.14.0）：
 *   PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH \
 *     node --experimental-transform-types --import /tmp/opc-harness/register.mjs \
 *     --test packages/hub/test/engine/dispatch.test.ts
 */
import { mkdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { OrgGraph } from "@opc/contracts";
import { fixtureTmp } from "../fixtures/fixture-dir.js";
import { migrate } from "../../src/db/migrate.js";
import { INSERT_DELEGATION_GRAPH_SQL } from "../../src/org/commit.js";
import type { EventBus, EventSubscription } from "../../src/events/bus.js";
import {
  AGENT_EDGES,
  HUMAN_EDGES,
  buildTurnPrompt,
  handoffGate,
  humanEdge,
  makeDispatch,
  planEdge,
  reviewGate,
  seatOf,
  subordinateRoles,
  upstreamOf,
  usdToCents,
  type DispatchDeps,
  type DispatchResult,
  type TurnOutcome,
} from "../../src/engine/dispatch.js";

const TMP = fixtureTmp("engine-dispatch", import.meta.url);
const NOW = 1_700_000_000_000;
const CEO = "ceo";

/* ───────────────────── 一张够小的组织图 ─────────────────────
   ceo → director → dev / qa。够判「下游 / 平级 / 上级 / 到顶」四种关系，
   而断言里每个角色名都能一眼看出该不该被放行（六个角色的图只会让拒绝用例
   读起来像在测图本身）。 */
const GRAPH: OrgGraph = {
  nodes: {
    ceo: { role_id: CEO, can_manage: true, reports_to: null },
    director: { role_id: "director", can_manage: true, reports_to: CEO },
    dev: { role_id: "dev", can_manage: false, reports_to: "director" },
    qa: { role_id: "qa", can_manage: false, reports_to: "director" },
    // 与 dev 【同家族、不同角色】的那一格。它是「同源审阅」唯一能被测到的形状：
    // 同角色那一支是不可豁免的直接拒绝（reviewGate 先判角色），拿它测「CEO 批了就放行」
    // 会测到一条根本不存在的豁免路径。
    auditor: { role_id: "auditor", can_manage: false, reports_to: "director" },
  },
  edges: [
    { from: "dev", to: "qa", review_gate: true },
    { from: "director", to: CEO, review_gate: true },
  ],
};

const families: Record<string, string> = {
  ceo: "opus",
  director: "sonnet",
  dev: "claude",
  qa: "gpt",
  auditor: "claude", // 与 dev 同家族
};

beforeAll(() => mkdirSync(TMP, { recursive: true }));
// 清理钩子在文件下半部（newWorld 之后）：它必须在所有库连接关闭【之后】再删目录，
// 而 node:test 的 after 是先进先出 —— 注册早了就会「先删库再继续用」
// （fixture-dir.ts 文件头记的正是这个顺序坑）。

describe("usdToCents —— 账单换算", () => {
  it("美元浮点 ⇒ 整数美分，四舍五入", () => {
    expect(usdToCents(0.042)).toBe(4);
    expect(usdToCents(1.235)).toBe(124);
  });
  it("NaN / 负数 / Infinity ⇒ 0，而不是把 NaN 写进账（那一列此后永远算不清）", () => {
    expect(usdToCents(Number.NaN)).toBe(0);
    expect(usdToCents(-3)).toBe(0);
    expect(usdToCents(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("seatOf —— 谁坐在那一格", () => {
  it("CEO 的三个席位没有 agent 出边 ⇒ 人不来，agent 不开口（token 都不烧）", () => {
    for (const s of ["CHARTER_PENDING", "ESCALATED_TO_CEO", "FINAL_REVIEW"] as const) {
      expect(seatOf(s)).toBe("human");
    }
  });
  it("干活的格子是 agent 席位", () => {
    for (const s of ["CHARTER_APPROVED", "DECOMPOSING", "IN_PROGRESS", "IN_REVIEW", "BUDGET_PAUSED"] as const) {
      expect(seatOf(s)).toBe("agent");
    }
  });
  it("两张表都没有出边的状态 ⇒ human（fail-closed）：§7.1 的死路不该由 agent 猜出路", () => {
    for (const s of ["BLOCKED", "MEETING_REQUIRED", "DELIVERED", "ARCHIVED"] as const) {
      expect(seatOf(s)).toBe("human");
    }
  });
  it("humanEdge 只认 approve，且落点全部合法（对着 §7.1 的边表核，防手抄错）", () => {
    for (const [from, byDecision] of Object.entries(HUMAN_EDGES)) {
      for (const e of Object.values(byDecision ?? {})) {
        expect(LEGAL[from]?.[e.to]).toBe(true);
      }
    }
    // 「驳回 / 缓议」在这三个席位上【没有合法的落点】：§7.1 没给 CHARTER_PENDING
    // 一条「退回重做」的边。所以点 reject 的正确后果是不跃迁（留在原格继续等），
    // 而不是凭空发明一个状态 —— 这一发把那条判定钉住。
    expect(humanEdge("CHARTER_PENDING", "reject" as never)).toBeNull();
    expect(humanEdge("IN_PROGRESS", "approve")).toBeNull();
  });
});

/**
 * §7.1 边表的**独立一份**，只为上面那条「HUMAN_EDGES / AGENT_EDGES 的落点合法」存在。
 *
 * 为什么不直接 import legalTransitionsFrom 来断言：那样这条用例就成了
 * 「dispatch 用的表等于 dispatch 用的表」——表里同时写错 from 和 to 时全绿。
 * 这份手抄的价值恰恰在于它是**另一处**写的，代价是 §7.1 改动时要同步两个地方
 * （status.ts 才是判据本体；这份只在测试里，写错会红，不会写进生产）。
 */
const LEGAL: Record<string, Record<string, true>> = {
  CHARTER_PENDING: { CHARTER_APPROVED: true, FINAL_REVIEW: true },
  CHARTER_APPROVED: { DECOMPOSING: true },
  DECOMPOSING: { IN_PROGRESS: true },
  IN_PROGRESS: { EVIDENCE_SUBMITTED: true },
  EVIDENCE_SUBMITTED: { IN_REVIEW: true },
  IN_REVIEW: {
    APPROVED_UPWARD: true,
    REJECTED_DOWNWARD: true,
    MEETING_REQUIRED: true,
    ESCALATED_TO_CEO: true,
    BUDGET_PAUSED: true,
    BLOCKED: true,
  },
  APPROVED_UPWARD: { IN_PROGRESS: true, ESCALATED_TO_CEO: true },
  REJECTED_DOWNWARD: { IN_PROGRESS: true },
  ESCALATED_TO_CEO: { FINAL_REVIEW: true },
  BUDGET_PAUSED: { ESCALATED_TO_CEO: true },
  FINAL_REVIEW: { DELIVERED: true },
  DELIVERED: { ARCHIVED: true },
  MEETING_REQUIRED: {},
  BLOCKED: {},
  ARCHIVED: {},
};

describe("AGENT_EDGES —— 表本身就是权限清单", () => {
  it("每一格的落点都在 §7.1 的出边里（写错一个状态名就会在这里红）", () => {
    for (const [from, byAction] of Object.entries(AGENT_EDGES)) {
      for (const [action, edge] of Object.entries(byAction ?? {})) {
        expect(LEGAL[from]?.[edge.to]).toBe(true);
        expect(typeof edge.why).toBe("string");
        expect(edge.why.length > 0).toBe(true);
        void action;
      }
    }
  });
  it("关键的一条：CHARTER_PENDING / FINAL_REVIEW 在 agent 表里【一个动作都没有】", () => {
    expect(AGENT_EDGES.CHARTER_PENDING).toBeUndefined();
    expect(AGENT_EDGES.FINAL_REVIEW).toBeUndefined();
    expect(AGENT_EDGES.ESCALATED_TO_CEO).toBeUndefined();
  });
});

describe("handoffGate —— agent 点的收件人，hub 认不认", () => {
  const g = (from: string, to: string) => handoffGate({ graph: GRAPH, from, to });

  it("交给自己链子里的人 ⇒ 认", () => {
    expect(g("director", "dev").ok).toBe(true);
    expect(g("ceo", "qa").ok).toBe(true); // 跨级的自己人（getDescendants 是整棵子树）
  });
  it("没点名 ⇒ 拒。hub 不猜下游", () => {
    const r = g("director", "");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("self_handoff");
  });
  it("交给自己 ⇒ 拒", () => {
    expect(g("dev", "dev").ok).toBe(false);
  });
  it("图上没有的角色 ⇒ 拒（agent 不能凭空造一个收件人）", () => {
    const r = g("director", "intern");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unknown_role");
  });
  it("平级 / 向上 ⇒ 拒，并且报错里【列出它能交给谁】（这条报错将来被 agent 自己读到）", () => {
    const peer = g("dev", "qa");
    expect(peer.ok).toBe(false);
    if (!peer.ok) {
      expect(peer.code).toBe("not_downstream");
      expect(peer.reason).toContain("叶子角色");
    }
    const up = g("dev", "director");
    expect(up.ok).toBe(false);
    const over = g("qa", CEO);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toContain("不在 [qa] 的汇报子树里");
  });
});

describe("reviewGate —— §8.2 第 1 条 + §24 风险 1", () => {
  const g = (o: Partial<Parameters<typeof reviewGate>[0]>) =>
    reviewGate({
      producerRole: "dev",
      reviewerRole: "qa",
      producerFamily: "claude",
      reviewerFamily: "gpt",
      approvedByCeo: false,
      ...o,
    });

  it("不同角色 + 不同家族 ⇒ 放行", () => {
    expect(g({}).ok).toBe(true);
  });
  it("同角色 ⇒ 拒（作者不给自己打分）", () => {
    const r = g({ reviewerRole: "dev" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("同一角色");
  });
  it("同家族 ⇒ 拒，除非 CEO 显式批过（§5.9 那个批准口）", () => {
    expect(g({ reviewerFamily: "claude" }).ok).toBe(false);
    expect(g({ reviewerFamily: "claude", approvedByCeo: true }).ok).toBe(true);
  });
  it("家族没声明 ⇒ 拒。缺信息落到拦，不落到放行", () => {
    expect(g({ reviewerFamily: "" }).ok).toBe(false);
    expect(g({ producerFamily: "  " }).ok).toBe(false);
  });
  it("查不到产出方 ⇒ 拒（独立性无从判定，不能默认审过）", () => {
    const r = g({ producerRole: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("查不到");
  });
});

describe("planEdge —— 一句话能不能变成一条状态边", () => {
  const base = {
    graph: GRAPH,
    handoffTo: null,
    blockedHandoff: null,
    review: null,
    ceoRoleId: CEO,
  };
  const d = (action: string, extra: Record<string, unknown> = {}) => ({
    action: action as never,
    summary: "干了活",
    ...extra,
  });

  it("IN_PROGRESS + pass ⇒ 提交上级审阅，下一轮由上级开口", () => {
    const p = planEdge({ ...base, status: "IN_PROGRESS", role: "dev", decision: d("pass") });
    expect(p.move).toBe(true);
    expect(p.to).toBe("EVIDENCE_SUBMITTED");
    expect(p.role).toBe("director");
    // 产出方要留在审计里：IN_REVIEW 判独立性时得知道审的是谁的产出
    expect(p.move && p.producerRole).toBe("dev");
  });
  it("IN_PROGRESS + pass，但它在图上没有上级 ⇒ 不动，而不是凭空交付", () => {
    const orphan: OrgGraph = {
      nodes: { lone: { role_id: "lone", can_manage: false, reports_to: null } },
      edges: [],
    };
    const p = planEdge({ ...base, graph: orphan, status: "IN_PROGRESS", role: "lone", decision: d("pass") });
    expect(p.move).toBe(false);
    expect(p.note).toContain("没有上级");
  });
  it("DECOMPOSING + handoff ⇒ 拆解完成，活儿落到被点名的角色", () => {
    const p = planEdge({
      ...base,
      status: "DECOMPOSING",
      role: "director",
      decision: d("handoff", { to_role: "dev" }),
      handoffTo: "dev",
    });
    expect(p.move).toBe(true);
    expect(p.to).toBe("IN_PROGRESS");
    expect(p.role).toBe("dev");
  });
  it("IN_REVIEW + pass ⇒ 还有上级就进下一层（APPROVED_UPWARD 这一格的下一跳是上级）", () => {
    const p = planEdge({ ...base, status: "IN_REVIEW", role: "dev", decision: d("pass") });
    expect(p.move).toBe(true);
    expect(p.to).toBe("IN_PROGRESS");
    expect(p.role).toBe("director");
  });
  it("IN_REVIEW + pass 且【到顶】⇒ 升 CEO，而不是自己宣布交付", () => {
    const p = planEdge({ ...base, status: "IN_REVIEW", role: CEO, decision: d("pass") });
    expect(p.move).toBe(true);
    expect(p.to).toBe("ESCALATED_TO_CEO");
    expect(p.note).toContain("升到 CEO");
  });
  it("审阅者只能交付到 CEO 那一步【之前】—— DELIVERED 不在任何 agent 出边里", () => {
    for (const byAction of Object.values(AGENT_EDGES)) {
      for (const e of Object.values(byAction ?? {})) expect(e.to).not.toBe("DELIVERED");
    }
  });
  it("IN_REVIEW + handoff ⇒ 打回下游（REJECTED_DOWNWARD），方向与 pass 相反", () => {
    const p = planEdge({
      ...base,
      status: "IN_REVIEW",
      role: "director",
      decision: d("handoff", { to_role: "dev" }),
      handoffTo: "dev",
    });
    expect(p.to).toBe("REJECTED_DOWNWARD");
    expect(p.role).toBe("dev");
  });
  it("决策段缺失 ⇒ 不动状态，note 里点名那个缺失的标记", () => {
    const p = planEdge({ ...base, status: "IN_PROGRESS", role: "dev", decision: null });
    expect(p.move).toBe(false);
    expect(p.to).toBe("IN_PROGRESS");
    expect(p.note).toContain("<<<OPC_DECISION>>>");
  });
  it("wait ⇒ 不动状态、不换角色，但 note 是员工那句话（回放要能看到它说了什么）", () => {
    const p = planEdge({ ...base, status: "IN_PROGRESS", role: "dev", decision: d("wait") });
    expect(p.move).toBe(false);
    expect(p.role).toBe("dev");
    expect(p.note).toBe("干了活");
  });
  it("状态与动作对不上 ⇒ 不动，并且 note 里带上【该状态能走哪些边】", () => {
    // DECOMPOSING 上 pass：拆解阶段没法「做完」，只能决定交给谁。
    const p = planEdge({ ...base, status: "DECOMPOSING", role: "director", decision: d("pass") });
    expect(p.move).toBe(false);
    expect(p.note).toContain("IN_PROGRESS");
    expect(p.note).toContain("需 CEO 拍板");
  });
  it("死路状态上任何动作都不动（BLOCKED 在 §7.1 里无出路）", () => {
    for (const a of ["pass", "handoff", "blocked", "wait"]) {
      const p = planEdge({
        ...base,
        status: "BLOCKED",
        role: "dev",
        decision: d(a, { to_role: "qa" }),
        handoffTo: "qa",
      });
      expect(p.move).toBe(false);
    }
  });
  it("越权交接 ⇒ 不动状态，note 直接用拒绝理由（同一句话既进审计也进卡片）", () => {
    const p = planEdge({
      ...base,
      status: "IN_PROGRESS",
      role: "dev",
      decision: d("handoff", { to_role: "qa" }),
      blockedHandoff: "[qa] 不在 [dev] 的汇报子树里。",
    });
    expect(p.move).toBe(false);
    expect(p.note).toContain("汇报子树");
  });
  it("同源审阅未获 CEO 批准 ⇒ pass 不推进状态", () => {
    const p = planEdge({
      ...base,
      status: "IN_REVIEW",
      role: "qa",
      decision: d("pass"),
      review: { ok: false, reason: "同属模型家族 [claude]" },
    });
    expect(p.move).toBe(false);
    expect(p.note).toContain("模型家族");
  });
});

describe("组织原语", () => {
  it("subordinateRoles 只给直接下属、不给孙子，且排序稳定", () => {
    expect(subordinateRoles(GRAPH, "director")).toEqual(["auditor", "dev", "qa"]);
    expect(subordinateRoles(GRAPH, CEO)).toEqual(["director"]);
    expect(subordinateRoles(GRAPH, "dev")).toEqual([]);
  });
  it("upstreamOf：根是 null（不是 " + '"ceo"' + "，也不是自身）", () => {
    expect(upstreamOf(GRAPH, "dev")).toBe("director");
    expect(upstreamOf(GRAPH, CEO)).toBeNull();
    expect(upstreamOf(GRAPH, "ghost")).toBeNull();
  });
});

describe("buildTurnPrompt —— 简报里必须有的三件事", () => {
  const p = buildTurnPrompt({
    title: "做个 AI 笔记应用",
    status: "IN_PROGRESS",
    role: "dev",
    subordinates: [],
    upstream: "director",
    summaries: ["测试说覆盖率不够"],
    ceoRoleId: CEO,
  });
  it("列出可直接交付的角色（叶子就明说是叶子，别让它去猜）", () => {
    expect(p).toContain("叶子角色");
  });
  it("写明它无权推进状态 / 无权审批 —— 这句不影响判定，但决定它会不会每轮试一次", () => {
    expect(p).toContain("无权推进任务状态");
  });
  it("决策段的格式与 claude.ts 的标记【同一处来源】，不是提示词里另抄一份", () => {
    expect(p).toContain("<<<OPC_DECISION>>>");
    expect(p).toContain('"action":"pass|handoff|blocked|wait"');
  });
  it("上一轮的汇报进简报（否则每轮都从零自我介绍，而 resume 只带会话不带摘要）", () => {
    expect(p).toContain("测试说覆盖率不够");
  });
});

/* ═══════════════════ 写路径：真库 + 真队列 ═══════════════════ */

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
  node: DispatchDeps["writer"]["node"];
  writeConnection: () => Db;
  close: () => Promise<void>;
};

const queues: Queue[] = [];
let fileSeq = 0;

async function newWorld(o: {
  readonly status: string;
  readonly role: string;
  readonly turn: TurnOutcome;
  readonly lastProducer?: string | null;
  readonly ceoApproved?: boolean;
  readonly graphVersion?: number;
  readonly writeGraph?: boolean;
  /** 出参：runTurn 被真的调用了几次。人席那几条用例断的就是它【等于 0】。 */
  readonly turns?: { n: number };
}): Promise<{
  db: Db;
  res: DispatchResult;
  events: Row[];
  cost: { seq: number; cents: number }[];
  /**
   * 真的 InMemoryEventBus（不是「记一笔就完事」的桩）。
   *
   * 用真总线是为了让【两条本来就存在的守卫】参与测试，而不是我在断言里重述一遍：
   *  1. publishPersisted 要求 seq 严格递增 —— 本轮多条事件若按错顺序推送，当场抛；
   *  2. subscribe(0) 之后拿到的 seq 集合就是「有没有洞」的直接证据（下面那条
   *     【每一个 seq 都被广播】的用例吃的正是它）。
   */
  bus: EventBus;
  /** 建在 dispatch 之前的订阅者：它收到什么，前端就收到什么。 */
  seen: EventSubscription;
  /** publish 被调用的顺序与 seq。与 events 表的 id 序列比对，就是「有没有洞」。 */
  published: { kind: string; seq: number }[];
  /** 同一个库上再跑一轮。去重键那类性质【必须】在同一本库上连跑两次才成立。 */
  again: (t: TurnOutcome) => Promise<DispatchResult>;
}> {
  const { WriteQueue } = await import("../../src/db/write-queue.js");
  const { InMemoryEventBus } = await import("../../src/events/bus.js");
  const path = TMP + "/d-" + process.pid + "-" + ++fileSeq + ".db";
  const q = new WriteQueue(path) as unknown as Queue;
  queues.push(q);
  const db = q.writeConnection();
  migrate(db as unknown as Parameters<typeof migrate>[0]);
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at, graph_version) " +
      "VALUES ('t1', '做个 AI 笔记应用', ?, ?, 'intake', ?, ?, ?)",
  ).run(o.status, o.role, NOW, NOW, o.graphVersion ?? 1);
  if (o.writeGraph !== false) {
    db.prepare(INSERT_DELEGATION_GRAPH_SQL).run("g1", 1, JSON.stringify(GRAPH), NOW, CEO, "测试用组织图");
  }
  const cost: { seq: number; cents: number }[] = [];
  const published: { kind: string; seq: number }[] = [];
  const state = { turn: o.turn };
  // 订阅【建在 dispatch 之前】：总线只把事件投给当时在册的订阅者，晚 subscribe 的
  // 只能靠环形回填 —— 回填测的是总线自己（bus.test.ts 已测），这里要测的是
  // 「dispatch 有没有把每一条都送出去」，所以必须站在【实时在线】那个位置上。
  const bus = new InMemoryEventBus();
  const seen = bus.subscribe(0);
  const dispatch = makeDispatch({
    writer: q,
    loadTask: (id) => {
      const r = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
      if (r === undefined) return null;
      return {
        id: String(r["id"]),
        title: String(r["title"]),
        status: String(r["status"]) as never,
        role: String(r["assigned_role"]),
        graphVersion: Number(r["graph_version"]),
      };
    },
    modelFamily: (roleId) => families[roleId] ?? "",
    rolePrompt: (roleId) => "你是 " + roleId + "。",
    roleSession: () => null,
    runTurn: async (i) => {
      if (o.turns !== undefined) o.turns.n += 1;
      // 简报里必须带着【这一轮该说话的角色】，否则 resume 会串到别人的会话上
      return state.turn;
    },
    recentSummaries: () => [],
    lastProducer: () => o.lastProducer ?? null,
    ceoApproved: () => o.ceoApproved ?? false,
    onCost: (c) => cost.push({ seq: c.seq, cents: c.costCents }),
    publish: (e, seq) => {
      published.push({ kind: e.kind, seq });
      bus.publishPersisted(e, seq);
    },
  });
  const res = await dispatch({ taskId: "t1", nowMs: NOW + 1000, maxBudgetUsd: 0.5 });
  const events = db.prepare("SELECT * FROM events ORDER BY id").all();
  return {
    db,
    res,
    events,
    cost,
    bus,
    seen,
    published,
    again: async (t: TurnOutcome) => {
      state.turn = t;
      return await dispatch({ taskId: "t1", nowMs: NOW + 2000, maxBudgetUsd: 0.5 });
    },
  };
}

const turn = (text: string, over: Partial<TurnOutcome> = {}): TurnOutcome => ({
  ok: true,
  text,
  costCents: 4,
  sessionId: "sess-1",
  error: null,
  ...over,
});
const said = (o: Record<string, unknown>) => "干完了。\n\n<<<OPC_DECISION>>>\n" + JSON.stringify(o);

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

describe("dispatch 的写路径（真 schema：约束、索引、守卫只有真库有）", () => {
  it("pass ⇒ 一次执行写【两条】状态边（提交 + 自动进入审阅），任务停在有人的格子上", async () => {
    const { db, res, events } = await newWorld({
      status: "IN_PROGRESS",
      role: "dev",
      turn: turn(said({ action: "pass", summary: "登录模块写完" })),
    });
    expect(res.status).toBe("IN_REVIEW");
    expect(res.role).toBe("director");
    expect(res.moved).toBe(true);
    const states = events.filter((e) => e["action"] === "state_change");
    expect(states.length).toBe(2);
    expect(JSON.parse(String(states[0]["payload"]))["to"]).toBe("EVIDENCE_SUBMITTED");
    expect(JSON.parse(String(states[1]["payload"]))["from"]).toBe("EVIDENCE_SUBMITTED");
    // 第二条边上【不该】重复挂账单
    const t = db.prepare("SELECT * FROM tasks WHERE id='t1'").get();
    expect(t["status"]).toBe("IN_REVIEW");
    expect(t["assigned_role"]).toBe("director");
    expect(t["consumed_cents"]).toBe(4);
  });

  it("tasks 与 events 同事务：守卫拦下第二次跃迁时，【第一条也不留】", async () => {
    // 造「agent 执行期间状态被人改了」：loadTask 读到 IN_PROGRESS，写入时库里已是别的。
    const { WriteQueue } = await import("../../src/db/write-queue.js");
    const path = TMP + "/race-" + process.pid + ".db";
    const q = new WriteQueue(path) as unknown as Queue;
    queues.push(q);
    const db = q.writeConnection();
    migrate(db as unknown as Parameters<typeof migrate>[0]);
    db.prepare(
      "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at, graph_version) " +
        "VALUES ('t1','x','IN_PROGRESS','dev','intake',?, ?, 1)",
    ).run(NOW, NOW);
    db.prepare(INSERT_DELEGATION_GRAPH_SQL).run("g1", 1, JSON.stringify(GRAPH), NOW, CEO, "g");
    let flipped = false;
    // 真总线 + 真订阅者，而且【在改状态之前】就订上：这一发要断的是「整笔回滚时
    // 一条都不广播」。用桩记调用的话，「广播了一条不存在的状态变化」这个形状
    // 恰好测不出来 —— 桩不问 seq 合法性，也不在乎那一行在库里存不存在。
    const { InMemoryEventBus } = await import("../../src/events/bus.js");
    const bus = new InMemoryEventBus();
    const seen = bus.subscribe(0);
    const dispatch = makeDispatch({
      writer: q,
      loadTask: () => ({ id: "t1", title: "x", status: "IN_PROGRESS", role: "dev", graphVersion: 1 }),
      modelFamily: (r) => families[r] ?? "",
      rolePrompt: () => "",
      roleSession: () => null,
      // 执行完之后、写库之前，CEO 把任务挪走了（同一条写连接：单写者队列保证不重叠）
      runTurn: async () => {
        if (!flipped) {
          flipped = true;
          db.prepare("UPDATE tasks SET status='BLOCKED' WHERE id='t1'").run();
        }
        return turn(said({ action: "pass", summary: "写完" }));
      },
      recentSummaries: () => [],
      lastProducer: () => null,
      ceoApproved: () => false,
      publish: (e, seq) => bus.publishPersisted(e, seq),
    });
    await expect(dispatch({ taskId: "t1", nowMs: NOW, maxBudgetUsd: 1 })).rejects.toThrow(/过期认知/);
    // 一条都没广播（bus 的游标还在 0 = 它压根没收到过东西）。
    expect(bus.latestSeq()).toBe(0);
    expect(db.prepare("SELECT status FROM tasks WHERE id='t1'").get()["status"]).toBe("BLOCKED");
    // 关键断言：那一轮【一条事件都没留下】。留一条就是「审计里有一次从未发生的跃迁」。
    expect(db.prepare("SELECT * FROM events").all().length).toBe(0);
    // 账单同样不记（否则重试像为同一轮又付一遍）。0 是 0001_init.sql 那列的 DEFAULT，
    // 断 0 而不是断 null：null 会是「有人显式写过 NULL」，那是另一件事。
    expect(db.prepare("SELECT consumed_cents FROM tasks WHERE id='t1'").get()["consumed_cents"]).toBe(0);
  });

  it("wait ⇒ 状态不动，但【留下一行】说明为什么停着，并且结账", async () => {
    const { db, res, events, cost } = await newWorld({
      status: "IN_PROGRESS",
      role: "dev",
      turn: turn(said({ action: "wait", summary: "等 CI 跑完" })),
    });
    expect(res.status).toBe("IN_PROGRESS");
    expect(res.moved).toBe(false);
    expect(events.length).toBe(1);
    expect(events[0]["action"]).toBe("tool_call");
    const p = JSON.parse(String(events[0]["payload"]));
    expect(p["kind"]).toBe("RoleTurnReported");
    expect(p["note"]).toContain("等 CI");
    // 【留在原状态】这件事本身要在事件里 —— 它叫 RoleTurnReported 而不是
    // TaskStateChanged 的全部理由就是这一格：状态没动，而 events 的 id 已经被消费了
    // （理由见 events/bus.ts 那个第 9 个 kind 的注释）。
    expect(p["state"]).toBe("IN_PROGRESS");
    expect(p["costCents"]).toBe(4);
    expect(db.prepare("SELECT consumed_cents FROM tasks").get()["consumed_cents"]).toBe(4);
    expect(cost.length).toBe(1);
  });

  it("人坐的格子 ⇒ 直接不开口：runTurn 一次都没被调，一条事件都没写", async () => {
    const turns = { n: 0 };
    const { res, events } = await newWorld({
      status: "FINAL_REVIEW",
      role: CEO,
      turns,
      // 这一发的替身【会】自我交付。它必须根本没被跑到 —— 所以断言看 turns.n
      // 而不是看结果：结果可以由任何一条提前 return 的路径造出来，
      // 而「没烧 token」只有调用计数能证明。
      turn: turn(said({ action: "pass", summary: "自我交付" })),
    });
    expect(turns.n).toBe(0);
    expect(res.seat).toBe("human");
    expect(res.status).toBe("FINAL_REVIEW");
    expect(res.note).toContain("等人不等 agent");
    expect(events.length).toBe(0);
  });

  it("组织图版本缺失 ⇒ 不跑，且【不退回最新图】（§18.4）", async () => {
    const { res } = await newWorld({ status: "IN_PROGRESS", role: "dev", turn: turn("x"), graphVersion: 9 });
    expect(res.moved).toBe(false);
    expect(res.note).toContain("版本 9");
  });

  it("越权交接 ⇒ 状态不动 + 一张卡 + 一行 unauthorized_attempt；同一件事重复跑【不重复建卡】", async () => {
    const a = await newWorld({
      status: "IN_PROGRESS",
      role: "dev",
      // qa 是 dev 的平级 —— 越权
      turn: turn(said({ action: "handoff", to_role: "qa", summary: "交给测试" })),
    });
    expect(a.res.moved).toBe(false);
    expect(a.res.card).not.toBeNull();
    const cards = a.db.prepare("SELECT * FROM approvals").all();
    expect(cards.length).toBe(1);
    expect(cards[0]["status"]).toBe("pending");
    // 按钮是 contracts 那三个长名字（写错会被 .strict() 拒，这里再钉一次落库的形状）
    expect(String(cards[0]["parameters"])).toContain("recommendation_is_not_decision");
    expect(a.events.filter((e) => e["action"] === "unauthorized_attempt").length).toBe(1);
    // 卡片那一行的 action 是 'approval'（与 createCard / 巡检 / http 同一个值），
    // 【不是】unauthorized_attempt：否则任何按 action 数待批的读法都少算引擎这一类。
    expect(a.events.some((e) => e["action"] === "approval")).toBe(true);
    // 【payload 形状】同样要与 createCard 同值：从前这里写的是 {...evt}
    // （字段嵌一层），而 createCard 落的是 evt.payload（字段在顶层，被
    // cards.test.ts:438 钉住）。两种形状共存时，共用的是 payload.kind，
    // 所以 role-memory 那个判别式一直看起来是对的 —— 按 approval_type / summary
    // 顶层键的读法才会漏掉引擎这一类。engine/charter.test.ts 有一条跨生产者的
    // 键集合比对，这里钉的是【dispatch 这一处】自己别再改回去。
    const cardRow = a.events.find((e) => e["action"] === "approval");
    const cp = JSON.parse(String(cardRow?.["payload"])) as Record<string, unknown>;
    expect(cp["kind"]).toBe("ApprovalRequired");
    expect(typeof cp["approval_type"]).toBe("string");
    expect(typeof cp["summary"]).toBe("string");
    expect(Array.isArray(cp["evidence_refs"])).toBe(true);
    // 反面：不能退化成 {...evt}（那会把上面四个键挤进 evt.payload 里去）
    expect(cp["interruptId"]).toBeUndefined();

    // 同一本库上再撞一次【同一条边】⇒ 去重键生效。
    // 换一本新库来断这件事是测不出来的（新库里天然只有一张卡，那条断言恒真）。
    const again = await a.again(turn(said({ action: "handoff", to_role: "qa", summary: "还是想交" })));
    expect(again.card).toBeNull(); // 撞键 ⇒ 不重复广播（否则收件箱计数会 +2）
    expect(a.db.prepare("SELECT * FROM approvals").all().length).toBe(1);
    expect(a.db.prepare("SELECT * FROM events WHERE action='approval'").all().length).toBe(1);

    // 【但越权那一行不能跟着去重】。去重键管的是卡片不重复，不是尝试不重复：
    // 一个角色每分钟试一次同一条非法边时，§4.5 那个「试了几次」必须数得出来。
    const attempts = a.db.prepare("SELECT * FROM events WHERE action='unauthorized_attempt'").all();
    expect(attempts.length).toBe(2);
    // 第二次的 target 落在【角色名】而不是上次那张卡的 id：那一次批准请求并没有因为
    // 本轮这次尝试而发出，指着旧卡等于让审计记录一次没发生过的批准请求。
    expect(String(attempts[1]["target"])).toBe("dev");
  });

  it("审阅独立性：CEO 批过同源 ⇒ 放行；没批 ⇒ 建卡且状态不动", async () => {
    const blocked = await newWorld({
      status: "IN_REVIEW",
      role: "director", // director(sonnet) 审 dev(claude)：不同源
      lastProducer: "dev",
      turn: turn(said({ action: "pass", summary: "看着没问题" })),
    });
    expect(blocked.res.moved).toBe(true);

    // 作者审自己：拒，而且【不可豁免】
    const self = await newWorld({
      status: "IN_REVIEW",
      role: "director",
      lastProducer: "director",
      ceoApproved: true, // 即便 CEO 批过，同角色这一支也不放行（§8.2：不接受运行时豁免）
      turn: turn(said({ action: "pass", summary: "我审我自己" })),
    });
    expect(self.res.moved).toBe(false);
    expect(self.db.prepare("SELECT * FROM approvals").all().length).toBe(1);

    // 同家族、不同角色，CEO【没批】⇒ 拦 + 建卡
    const same = await newWorld({
      status: "IN_REVIEW",
      role: "auditor", // auditor(claude) 审 dev(claude)
      lastProducer: "dev",
      turn: turn(said({ action: "pass", summary: "看着行" })),
    });
    expect(same.res.moved).toBe(false);
    expect(same.res.note).toContain("模型家族");
    expect(same.db.prepare("SELECT * FROM approvals").all().length).toBe(1);
    // 同源审阅【不记 unauthorized_attempt】：审阅者那一句 pass 在状态机里完全合法，
    // 被拦下的是它的【资格】，而资格不足是这台机器的属性（只有一个模型家族），
    // 不是某个角色的越权。记进去会让「按 action 统计越权」这个 §4.5 要读的数
    // 被系统自己的配置长期污染。
    expect(same.db.prepare("SELECT * FROM events WHERE action='unauthorized_attempt'").all().length).toBe(0);
    expect(same.db.prepare("SELECT * FROM events WHERE action='approval'").all().length).toBe(1);

    // 同一件事 CEO 批过 ⇒ 放行
    const approved = await newWorld({
      status: "IN_REVIEW",
      role: "auditor",
      lastProducer: "dev",
      ceoApproved: true,
      turn: turn(said({ action: "pass", summary: "CEO 已接受同源" })),
    });
    expect(approved.res.moved).toBe(true);
  });

  it("执行失败 ⇒ 结账 + 留痕，且【绝不推进状态】—— 哪怕半截输出里有个合法决策段", async () => {
    // 这是本文件最要紧的一条：CLI 被 SIGKILL / 预算掐断时，stdout 上可能留着
    // 【上半轮的】完整输出，包括一个格式完好的 pass。进程没跑完这件事只有调用方知道。
    const { db, res, events } = await newWorld({
      status: "IN_PROGRESS",
      role: "dev",
      turn: turn(said({ action: "pass", summary: "被杀死前写的那半句" }), {
        ok: false,
        error: "budget exceeded",
        costCents: 7,
      }),
    });
    expect(res.moved).toBe(false);
    expect(res.status).toBe("IN_PROGRESS");
    expect(res.costCents).toBe(7);
    expect(res.note).toContain("budget exceeded");
    expect(db.prepare("SELECT consumed_cents FROM tasks").get()["consumed_cents"]).toBe(7);
    expect(events.length).toBe(1);
    expect(events[0]["action"]).toBe("tool_call");
    expect(db.prepare("SELECT * FROM events WHERE action='state_change'").all().length).toBe(0);
  });

  it("决策段缺失 ⇒ 状态不动 + 留下一行原因（不默认往下走）", async () => {
    const { res, events } = await newWorld({
      status: "IN_PROGRESS",
      role: "dev",
      turn: turn("我觉得差不多了吧"),
    });
    expect(res.status).toBe("IN_PROGRESS");
    expect(JSON.parse(String(events[0]["payload"]))["note"]).toContain("<<<OPC_DECISION>>>");
  });

  it("记账钩子拿到的 seq 是【真实存在】的 events.id（BudgetTracker 的幂等键靠它）", async () => {
    const { db, cost } = await newWorld({
      status: "IN_PROGRESS",
      role: "dev",
      turn: turn(said({ action: "wait", summary: "再推一次" })),
    });
    expect(cost.length).toBe(1);
    const hit = db.prepare("SELECT id FROM events WHERE id = ?").all(cost[0].seq);
    expect(hit.length).toBe(1);
  });

  it("【每一个被消费的 seq 都被广播】：状态轮 / 等待轮 / 越权轮都不给 SSE 留洞（0010 §4）", async () => {
    // 这一条是那个第 9 个 DomainEvent kind 存在的【全部】理由，所以它必须被断言，
    // 而不是停在注释里。判据取 events 表本身的 id 序列：只要有一行写了却没 publish，
    // 两个集合就不相等 —— 于是「新加一条 appendAudit 而忘了进 outgoing」这种
    // 将来一定会发生的改动，会在【加它的那一次提交】里红掉。
    const cases = [
      { name: "状态轮", status: "IN_PROGRESS", role: "dev", turn: turn(said({ action: "pass", summary: "写完" })) },
      { name: "等待轮", status: "IN_PROGRESS", role: "dev", turn: turn(said({ action: "wait", summary: "等 CI" })) },
      { name: "越权轮", status: "IN_PROGRESS", role: "dev", turn: turn(said({ action: "handoff", to_role: "qa", summary: "交出去" })) },
      { name: "失败轮", status: "IN_PROGRESS", role: "dev", turn: turn("x", { ok: false, error: "boom", costCents: 3 }) },
    ] as const;
    for (const c of cases) {
      const w = await newWorld({ status: c.status, role: c.role, turn: c.turn });
      const written = w.db.prepare("SELECT id FROM events ORDER BY id").all().map((r) => Number(r["id"]));
      const sent = w.published.map((p) => p.seq);
      // 断言消息带上用例名：四个 case 里红一个时，光看两个数组看不出是哪一轮。
      expect(sent, c.name + "：写下的 seq " + JSON.stringify(written) + "，广播的 " + JSON.stringify(sent)).toEqual(written);
      // 顺序也得对：真总线对 seq 严格递增有守卫（乱序推送当场抛错），所以这一发
      // 同时是在证明「按写入顺序推送」这件事成立。
      expect(sent.slice().sort((a, b) => a - b)).toEqual(sent);
      // 在线订阅者真的收到了（不是只调了回调）：证明事件形状是总线接受的 DomainEvent。
      expect(w.bus.latestSeq()).toBe(written[written.length - 1]);
    }
  });

  it("任务不存在 ⇒ 抛错，而不是返回一个「什么都没发生」的成功", async () => {
    const { WriteQueue } = await import("../../src/db/write-queue.js");
    const q = (new WriteQueue(TMP + "/none-" + process.pid + ".db") as unknown as Queue);
    queues.push(q);
    const db = q.writeConnection();
    migrate(db as unknown as Parameters<typeof migrate>[0]);
    const dispatch = makeDispatch({
      writer: q,
      loadTask: () => null,
      modelFamily: () => "",
      rolePrompt: () => "",
      roleSession: () => null,
      runTurn: async () => turn("x"),
      recentSummaries: () => [],
      lastProducer: () => null,
      ceoApproved: () => false,
      // publish 现在是【必填】：这一发跑不到广播那一步（loadTask 就抛了），但让它可选
      // 等于允许装配时漏传，而漏传的后果是 TS 不响、测试照绿、只有前端看得见空洞。
      publish: () => {},
    });
    await expect(dispatch({ taskId: "ghost", nowMs: NOW, maxBudgetUsd: 1 })).rejects.toThrow(/不存在的任务烧 token/);
  });
});
