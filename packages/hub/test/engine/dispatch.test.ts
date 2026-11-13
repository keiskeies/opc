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
import { REJECTION_COUNT_SQL } from "../../src/engine/runtime.js";
import type { EventBus, EventSubscription } from "../../src/events/bus.js";
import {
  AGENT_EDGES,
  HUMAN_EDGES,
  buildTurnPrompt,
  handoffGate,
  humanEdge,
  makeDispatch,
  planEdge,
  resolveCeoRoleId,
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

/* ───────────────── 0047：顶层是【结构事实】而不是一个名字 ─────────────────
   两发探针量到的东西（原话抄在 dispatch.ts 的门 0.5 / 门 0.6 注释里）：

   A. 根叫 boss 时 `up === o.ceoRoleId`（字面量比较）恒假 ⇒「已到顶层」永远判不出
      ⇒ 任务停在 agent 席位、每轮白烧一次子进程、收件箱空着。
   B. 汇报深度上限 5，所以【任何比 ceo←dev 更深】的图第一次 pass 上去，
      下一位该接手的人就是 CEO 本人 —— 而 hub 会起一个子进程去【扮演 CEO】，
      往 append-only 的审计里写一行 actor_type='agent', actor_id='ceo'。

   下面两组用例分别钉这两发的【判据】，写路径（真库、真事务、真卡片）在下面
   「门 0.5 / 0.6 的写路径」那一组里。纯函数这一组刻意不碰库：
   判错的名字与判错的落点是【判定层】的事，那里穷尽它们不该需要 schema。 */

/** 根叫 boss 的那张图（探针 A 的形状）。节点集合与 GRAPH 一致，只改根的名字。 */
const BOSS_GRAPH: OrgGraph = {
  nodes: {
    boss: { role_id: "boss", can_manage: true, reports_to: null },
    director: { role_id: "director", can_manage: true, reports_to: "boss" },
    dev: { role_id: "dev", can_manage: false, reports_to: "director" },
  },
  edges: [],
};

/** 四层：ceo ← manager ← lead ← dev（探针 B 的形状，深度 4 < ORG_MAX_DEPTH=5，合法图）。 */
const DEEP_GRAPH: OrgGraph = {
  nodes: {
    ceo: { role_id: "ceo", can_manage: true, reports_to: null },
    manager: { role_id: "manager", can_manage: true, reports_to: "ceo" },
    lead: { role_id: "lead", can_manage: true, reports_to: "manager" },
    dev: { role_id: "dev", can_manage: false, reports_to: "lead" },
  },
  edges: [],
};

describe("resolveCeoRoleId —— 顶层从图里读，不从常量里猜", () => {
  const ok = (r: ReturnType<typeof resolveCeoRoleId>): string => (r.ok ? r.roleId : "FAIL:" + r.reason);

  it("⭐ 根叫 boss 也能认出来。这一条就是探针 A 的判据：名字不参与判定", () => {
    expect(ok(resolveCeoRoleId(undefined, BOSS_GRAPH))).toBe("boss");
    expect(ok(resolveCeoRoleId(undefined, GRAPH))).toBe(CEO);
  });
  it("装配显式指定的名字【优先】—— 单根图也可以被指定盖掉", () => {
    // 指定而有效 ⇒ 用指定值。这一格存在的意义是「两个根时装配能表态」，
    // 所以它必须真能盖掉结构判定，否则那条出路是假的。
    expect(ok(resolveCeoRoleId("director", BOSS_GRAPH))).toBe("director");
  });
  it("⭐ 指定的名字【不在图上】⇒ 拒绝，而不是照收（照收的症状与探针 A 逐字相同）", () => {
    const r = resolveCeoRoleId("ceo", BOSS_GRAPH); // 一个在这张图里压根不存在的合法名字
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // 报错要能指着修法：把图里的根列出来，而不是只说"无效参数"
    expect(r.reason).toContain("不在这张组织图的节点里");
    expect(r.reason).toContain("[boss]");
  });
  it("原型键不算角色：\"constructor\" 在 nodes 这个普通对象上【命中】而它不是节点", () => {
    // Object.hasOwn 那一发的证据。用 `nodes[name] !== undefined` 写法时这一条会绿得离谱：
    // 它会返回 ok:true 而 roleId="constructor"，于是顶层判定指向一个不存在的人。
    expect(resolveCeoRoleId("constructor", GRAPH).ok).toBe(false);
    expect(resolveCeoRoleId("toString", GRAPH).ok).toBe(false);
  });
  it("空白指定 = 没指定（trim 后再判），而不是「指定了一个空名字」⇒ 拒绝", () => {
    expect(ok(resolveCeoRoleId("   ", GRAPH))).toBe(CEO);
    expect(ok(resolveCeoRoleId(null, GRAPH))).toBe(CEO);
    expect(ok(resolveCeoRoleId(" director ", GRAPH))).toBe("director");
  });
  it("⭐ 多根 = 森林 ⇒ 拒绝。「谁是 CEO」在这里真的没有答案，随便挑一个 = 让一条不存在的汇报关系决定谁能交付", () => {
    const forest: OrgGraph = {
      nodes: {
        bossA: { role_id: "bossA", can_manage: true, reports_to: null },
        bossB: { role_id: "bossB", can_manage: true, reports_to: null },
        dev: { role_id: "dev", can_manage: false, reports_to: "bossA" },
      },
      edges: [],
    };
    const r = resolveCeoRoleId(undefined, forest);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("2 个汇报根");
    // 两个根都列出来（只列第一个会让人以为改另一个就行）
    expect(r.reason).toContain("bossA");
    expect(r.reason).toContain("bossB");
    // 而指定值仍然能救回来 —— 这是那条报错里给的出路，必须真能走通
    expect(ok(resolveCeoRoleId("bossB", forest))).toBe("bossB");
  });
  it("空图 = 没有根 ⇒ 拒绝，而不是「根是 undefined」", () => {
    const r = resolveCeoRoleId(undefined, { nodes: {}, edges: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("没有汇报根");
  });
  it("reports_to 写成空串也算根（库里那一版 JSON 不保证只有 null）", () => {
    const blank: OrgGraph = {
      nodes: { dev: { role_id: "dev", can_manage: true, reports_to: "" } },
      edges: [],
    };
    expect(ok(resolveCeoRoleId(undefined, blank))).toBe("dev");
  });
});

describe("planEdge 的 upstream 分支 —— 下一位是人类时【不起子进程扮演他】", () => {
  const d = (action: string, extra: Record<string, unknown> = {}) => ({
    action: action as never,
    summary: "干完了",
    ...extra,
  });
  const base = { handoffTo: null, blockedHandoff: null, review: null };

  it("⭐ IN_PROGRESS + pass 而上级是 CEO ⇒ 落点【不是】直接写终格，而是 EVIDENCE_SUBMITTED + 一个标志", () => {
    // lead 的上级是 manager，manager 的上级是 ceo ⇒ manager 这一格的上级才是 CEO。
    // 探针 B 的现场就是这一格：manager pass 之后"下一位"是 CEO 本人。
    const p = planEdge({
      ...base,
      graph: DEEP_GRAPH,
      status: "IN_PROGRESS",
      role: "manager",
      decision: d("pass"),
      ceoRoleId: "ceo",
    });
    expect(p.move).toBe(true);
    expect(p.to).toBe("EVIDENCE_SUBMITTED");
    expect(p.move && p.thenEscalateToCeo).toBe(true);
    // 角色保持【产出方】而不是写成 ceo：approveCard 原值回填会把"升给 CEO 看"
    // 变成一次组织分配（负责角色永久改成 CEO）。
    expect(p.role).toBe("manager");
    expect(p.move && p.producerRole).toBe("manager");
    expect(p.note).toContain("CEO 本人");
    expect(p.note).not.toContain("审阅通过");
  });

  it("三格链条【全部】落在 §7.1 已有的边上：EVIDENCE_SUBMITTED → IN_REVIEW → ESCALATED_TO_CEO", () => {
    // 这一条是「我没有发明任何一条边」的证据。逐格对着 LEGAL（§7.1 的独立一份手抄）核。
    expect(LEGAL.IN_PROGRESS.EVIDENCE_SUBMITTED).toBe(true);
    expect(LEGAL.EVIDENCE_SUBMITTED.IN_REVIEW).toBe(true);
    expect(LEGAL.IN_REVIEW.ESCALATED_TO_CEO).toBe(true);
  });

  it("⭐ 根叫 boss 时同样成立（探针 A + B 合起来的形状）：顶层判定不再依赖名字", () => {
    const p = planEdge({
      ...base,
      graph: BOSS_GRAPH,
      status: "IN_PROGRESS",
      role: "director",
      decision: d("pass"),
      // 装配不再指定（undefined 那一路），由 resolveCeoRoleId 从图里读出 boss。
      // 这里喂的是它的输出 —— 判据的输入输出各测各的，串起来那条在写路径那一组。
      ceoRoleId: "boss",
    });
    expect(p.move && p.thenEscalateToCeo).toBe(true);
    expect(p.role).toBe("director");
  });

  it("上级【不是】CEO 时一切照旧：还是「交给上级审阅」，没有那个标志", () => {
    const p = planEdge({
      ...base,
      graph: DEEP_GRAPH,
      status: "IN_PROGRESS",
      role: "lead",
      decision: d("pass"),
      ceoRoleId: "ceo",
    });
    expect(p.move).toBe(true);
    expect(p.to).toBe("EVIDENCE_SUBMITTED");
    expect(p.move && p.thenEscalateToCeo).toBeUndefined();
    expect(p.role).toBe("manager");
  });

  it("IN_REVIEW + pass 而审阅者的上级是 CEO ⇒ 直接升 CEO（原有那条 topmost 分支不换语义）", () => {
    const p = planEdge({
      ...base,
      graph: DEEP_GRAPH,
      status: "IN_REVIEW",
      role: "manager",
      decision: d("pass"),
      ceoRoleId: "ceo",
    });
    expect(p.to).toBe("ESCALATED_TO_CEO");
    // 这一格说的是「审阅通过了」—— 与 thenEscalateToCeo 那条【刻意不同】：
    // 那一条的语义是「下一个该接手的人是 CEO，而没人审过」，它不能冒充"审过了"。
    expect(p.note).toContain("审阅通过");
    expect(p.move && p.thenEscalateToCeo).toBeUndefined();
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
  /** 已发生的打回次数（§4.2.1 max_rejections 的分子）。默认 0 = 从没被打回过。 */
  readonly rejections?: number;
  /** 传了数组就记下 rejectionCount 每次被调用时的 taskId —— 用来测"读没读"。 */
  readonly rejectionCalls?: string[];
  readonly ceoApproved?: boolean;
  readonly graphVersion?: number;
  readonly writeGraph?: boolean;
  /**
   * 换整张组织图。0047 那两发探针吃的正是【图形状】：根叫 boss（顶层判不出）、
   * 四层深（下一位该接手的是 CEO 本人）。默认的 GRAPH 是三层、根叫 ceo，
   * 两发都撞不上 —— 所以这一格不是便利参数，是那两发的【存在条件】。
   */
  readonly graph?: OrgGraph;
  /** 装配显式指定的 CEO（`--ceo` 那一族的替身）。不传 = 由图里的汇报根回答。 */
  readonly ceoRoleId?: string;
  /** 出参：runTurn 被真的调用了几次。人席那几条用例断的就是它【等于 0】。 */
  readonly turns?: { n: number };
  /** 出参：每次 runTurn 被叫去【扮演谁】。探针 B 断的就是这个数组里没有 ceo。 */
  readonly roles?: string[];
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
    db.prepare(INSERT_DELEGATION_GRAPH_SQL).run("g1", 1, JSON.stringify(o.graph ?? GRAPH), NOW, CEO, "测试用组织图");
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
      // 记录【被叫去扮演谁】：探针 B 的那一发（hub 起子进程扮演 CEO）唯一的
      // 可见证据就是这个入参 —— 状态与账面上它都长得像"正常跑了一轮"。
      if (o.roles !== undefined) o.roles.push(i.role);
      // 简报里必须带着【这一轮该说话的角色】，否则 resume 会串到别人的会话上
      return state.turn;
    },
    recentSummaries: () => [],
    lastProducer: () => o.lastProducer ?? null,
    rejectionCount: (id) => {
      o.rejectionCalls?.push(id);
      // 显式给了数字就用它（那几发要的是"假装已经打过 N 次"这一维）；
      // 【没给】就走【真 SQL】而不是 return 0 —— 否则循环那一发数到的是我手写的常数，
      // 它绿不证明真 SQL 数得对（那正是 dispatch.test.ts 这个文件结构性测不到的一类，
      // 见 runtime.test.ts 文件头）。
      return o.rejections ?? countRejections(db, id);
    },
    ceoApproved: () => o.ceoApproved ?? false,
    ...(o.ceoRoleId === undefined ? {} : { ceoRoleId: o.ceoRoleId }),
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

/**
 * 真 SQL 数的打回次数（SQL 从 runtime.ts import，【不在这份测试里重抄一遍】——
 * 重抄就是造一份第二判据：runtime 那条改了而这里没改，两边会各自绿着说不同的话，
 * 而这一发测的恰好是"两边说的是不是同一件事"。
 * 读的是 writeConnection：这里没有 WAL 那层"读不到自己刚写的"边界（见 runtime.ts 文件头），
 * 因为循环那一发每一轮都是【独立的 dispatch 事务】，写在上一轮就提交了。
 */
function countRejections(db: { prepare: (sql: string) => { get: (...a: unknown[]) => unknown } }, id: string): number {
  const r = db.prepare(REJECTION_COUNT_SQL).get(id) as { n: number | bigint } | undefined;
  return r === undefined ? 0 : Number(r.n);
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

  /**
   * ⭐ 审阅者（一个 agent）打回 ⇒ 任务【必须】落回干活的那一格。
   *
   * 这一发是本篇唯一一条"跑出来才发现生产上是死的"的用例（0050 §7）。修之前它停在
   * `REJECTED_DOWNWARD`，而那一格在两张边表里【都没有键】，于是一整套判据同时沉默：
   *
   *   seatOf = human（AGENT_EDGES 没这个键）      ⇒ 驱动器不推（候选集派生自它）
   *   needsSeatCard = false（HUMAN_EDGES 没这个键）⇒ 不给 CEO 发卡
   *   humanEdge(S,"approve") = null               ⇒ 就算有卡也点不动
   *   不在 ATTENTION_STATUSES / BLOCKED_STATUSES  ⇒ 看板哪一列都不出现它
   *
   * 也就是【审阅者一说打回，这条想法就永久停住，而屏幕上没有任何一格显示它停住了】。
   * 而它【不在】任何已登记的死路名单里 —— 0041 §5 / 0046 §7 列的都是
   * MEETING_REQUIRED / BLOCKED，而 `status-machine.test.ts:172` 那条"已知缺口快照"
   * 扫的是【合法表】（`legalTransitionsFrom`），合法表里这条边【一直有】
   * （`status.ts:59`「§7.2 打回路径」），所以那具快照看不到这个洞：
   * **合法表有、可执行的两张边表没有**，正是三张表两有一无那一族。
   *
   * 断的四件事各自挡一种坏法：
   *  ① 终态是 IN_PROGRESS 而【不是】REJECTED_DOWNWARD —— 挡"只写第一格"；
   *  ② 负责角色是【被点名的下游 dev】而【不是】审阅者 director —— 挡"打回打回自己手上"
   *     （审阅者刚说完这活不行，任务又归他，等于没打回）；
   *  ③ 【两条】状态边都在 —— 挡"直接 UPDATE tasks 而不留那一路"（append-only 回放要的
   *     恰好是"曾经被打回"这件事，见 0047 §3 同一条理由）；
   *  ④ 第二条边的 summary 说的是【交回下游】而【不是】"进入审阅队列" —— 挡 note 写死
   *     （修之前那句是硬编码的，给 AUTO_AFTER_EDGE 加第二个键而不动 note，
   *     就会往审计里写一句听起来像那么回事的假话）。
   */
  it("⭐ handoff 打回 ⇒ 两条边一路落到 IN_PROGRESS/下游，审计不说「进审阅队列」", async () => {
    const turns = { n: 0 };
    const { db, res, events } = await newWorld({
      status: "IN_REVIEW",
      role: "director", // 审阅者
      turn: turn(said({ action: "handoff", to_role: "dev", summary: "登录模块缺鉴权，打回重做" })),
      turns,
    });
    expect(res.status).toBe("IN_PROGRESS");
    expect(res.role).toBe("dev");
    expect(res.moved).toBe(true);

    const states = events.filter((e) => e["action"] === "state_change");
    expect(states.length).toBe(2);
    const leg = (i: number) => JSON.parse(String(states[i]?.["payload"])) as Record<string, string>;
    expect(leg(0)?.["to"]).toBe("REJECTED_DOWNWARD");
    expect(leg(1)?.["from"]).toBe("REJECTED_DOWNWARD");
    expect(leg(1)?.["to"]).toBe("IN_PROGRESS");
    // ④ 那句审计话必须描述【这一格真的发生了什么】
    expect(String(leg(1)?.["summary"])).toContain("打回");
    expect(String(leg(1)?.["summary"])).not.toContain("审阅队列");

    const t = db.prepare("SELECT * FROM tasks WHERE id='t1'").get();
    expect(t["status"]).toBe("IN_PROGRESS");
    expect(t["assigned_role"]).toBe("dev");
    // 自动那一格【不】再烧一轮钱、【不】再起子进程（打回这个决定审阅者刚做过）
    expect(turns.n).toBe(1);
    expect(t["consumed_cents"]).toBe(4);
  });

  it("⭐ 反向对照：打回落点那一格【此刻真的可驱动】（否则上面那发只是换个格子停住）", async () => {
    // 上面那发断的是"不再停在 REJECTED_DOWNWARD"。而"挪了一格"本身不是修好 ——
    // 挪去另一格死路，那一发照绿。所以这一发直接问【驱动器的判据源】：它认这一格吗。
    // 问的是 seatOf / AGENT_EDGES 本身而【不是】 DRIVER_ELIGIBLE_STATES ——
    // 后者是前者的派生（driver-pump.ts:117 明写"派生而不是抄"），
    // 在这一层断派生物等于多绕一层而没多判任何东西，还要为此多一条跨模块 import。
    const { res } = await newWorld({
      status: "IN_REVIEW",
      role: "director",
      turn: turn(said({ action: "handoff", to_role: "dev", summary: "打回" })),
    });
    expect(res.status).toBe("IN_PROGRESS");
    expect(seatOf(res.status as never)).toBe("agent");
    expect(AGENT_EDGES[res.status as never]).toBeDefined();
    // 而修之前那一格确实是死的 —— 这一句是这条用例的【对照物】，
    // 少了它，上面那一发无法区分"修好了"与"这一格一直不是死路"。
    expect(seatOf("REJECTED_DOWNWARD" as never)).toBe("human");
    expect(AGENT_EDGES["REJECTED_DOWNWARD" as never]).toBeUndefined();
    expect(HUMAN_EDGES["REJECTED_DOWNWARD" as never]).toBeUndefined();
    expect(humanEdge("REJECTED_DOWNWARD" as never, "approve")).toBeNull();
  });

  it("⭐ 打回到第 3 次 ⇒ 不再派回下游，升给 CEO（§4.2.1 max_rejections）", async () => {
    // 规格原文（设计文档 319/323 行）：「同一需求最多被打回3次」
    // +「max_rejections 防止无限打回循环 —— 3 次未收敛自动升级到 CEO，不在总监层内耗」，
    // 配置块里紧挨着的另一行是 `escalation_on_exceed: "ceo"`。
    // 这一发测的是【规格写着而引擎没实现】的那一条被补上了。
    //
    // 为什么必须有它（0050 §8 探针 53/54 量的）：REJECTED_DOWNWARD→IN_PROGRESS 接上之后
    // dev ⇄ 审阅者这个循环才可能，而现存三道封顶一道都不拦它：
    // 按格 attempts 每次重访归零（maxAttempts=2 跑 12 轮一次没触发）、
    // advance 的"不动就停"因为每轮都 moved=true 而恒假、
    // maxTurns 是【每轮 advance】的闸而驱动器每心跳起一次新的。
    const turns = { n: 0 };
    const { db, res, events } = await newWorld({
      status: "IN_REVIEW",
      role: "director",
      rejections: 3, // 已经打回过 3 次
      turn: turn(said({ action: "handoff", to_role: "dev", summary: "还是缺鉴权" })),
      turns,
    });
    // 落 CEO 席位而【不是】IN_PROGRESS/dev
    expect(res.status).toBe("ESCALATED_TO_CEO");
    // ⭐ 负责角色【还是审阅者】而不变 ceo。0047 同一格的原话：写 ceo 的话
    // approveCard 原值回填会把负责角色永久改成 CEO —— 一次"升给 CEO 看"变成一次组织分配。
    expect(res.role).toBe("director");
    const t = db.prepare("SELECT * FROM tasks WHERE id='t1'").get();
    expect(t["status"]).toBe("ESCALATED_TO_CEO");
    expect(t["assigned_role"]).toBe("director");

    // 只有一条边：这条上限是【替换】那一跳的落点，不是在打回之后又追一跳
    // （追一跳会写出 REJECTED_DOWNWARD → ESCALATED_TO_CEO，规格里没有那条边）。
    const states = events.filter((e) => e["action"] === "state_change");
    expect(states.length).toBe(1);
    const leg = JSON.parse(String(states[0]?.["payload"])) as Record<string, string>;
    expect(leg["from"]).toBe("IN_REVIEW");
    expect(leg["to"]).toBe("ESCALATED_TO_CEO");
    // 审计里那句只能说【已打回 3 次】。曾经这里写的是"这是第 4 次打回"—— 而这一轮
    // 根本没有打回（落点是 CEO 那一格），那句话会往 append-only 的 events 里
    // 记一次没发生过的打回。措辞与那个数字的口径由这一句钉住。
    expect(String(leg["summary"])).toContain("已被打回 3 次");
    expect(String(leg["summary"])).not.toMatch(/第 ?\d+ ?次打回/);
    // 审计不许把这件事写成"打回"或"审阅通过"：它两者都不是
    expect(String(leg["summary"])).not.toContain("审阅队列");
    // 烧的那一轮就是审阅者这一轮（升级不额外起子进程、不扮演 CEO —— 0047 那一格）
    expect(turns.n).toBe(1);
    expect(t["consumed_cents"]).toBe(4);
    // 收件箱里有卡：ESCALATED_TO_CEO 在 HUMAN_EDGES 里 ⇒ needsSeatCard 为真。
    // 这一句是这一发的【落点有效性】—— 落到另一格死路的话，上面那些断言照绿。
    const cards = db.prepare("SELECT card_key, status FROM approvals WHERE task_id='t1'").all();
    expect(cards.length).toBe(1);
    expect(String(cards[0]?.["card_key"])).toContain("ESCALATED_TO_CEO");
    expect(cards[0]?.["status"]).toBe("pending");
  });

  it("⭐ 反向对照：第 2 次打回仍然照旧派回下游（上限不许提前咬）", async () => {
    // 没有这一发，"把阈值判据写成 >= 1"或">= 0"都能让上面那发绿，
    // 而代价是【第一次打回就不再重做】—— 打回这个动作直接被废掉。
    const { db, res } = await newWorld({
      status: "IN_REVIEW",
      role: "director",
      rejections: 2,
      turn: turn(said({ action: "handoff", to_role: "dev", summary: "缺鉴权" })),
    });
    expect(res.status).toBe("IN_PROGRESS");
    expect(res.role).toBe("dev");
    expect(db.prepare("SELECT status FROM tasks WHERE id='t1'").get()["status"]).toBe("IN_PROGRESS");
    expect(db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE task_id='t1'").get()["n"]).toBe(0);
  });

  it("⭐ ⭐ 打回次数是【无条件】读的：不许按状态/动作筛（筛了上限就永不触发）", async () => {
    // 装配层那句 `deps.rejectionCount(task.id)` 排在 planEdge 【之前】而无条件。
    // 省一次 COUNT 的写法是 `task.status === "IN_REVIEW" && decision?.action === "handoff"
    // ? deps.rejectionCount(...) : 0` —— 看着等价（今天确实等价），而分子与判据从此
    // 分处两处、各自收窄一次就永久失真：判据是边表里的 `edge.to === "REJECTED_DOWNWARD"`，
    // 那个筛是【手抄的状态名 + 动作名】。将来给别的状态加一条落点是打回的边，
    // planEdge 会认而分子恒 0 ⇒ 上限【永不触发】而全仓没有任何一处会红。
    // 「配置写了而没生效」正是这一格存在的理由，被实现成一个哑弹。
    //
    // 所以这一发【故意】让任务状态与决策动作都"不像打回"（IN_PROGRESS + wait），
    // 而问的是【读没读】。这一发绿的唯一条件是那次读没有前置条件。
    // ⚠ 它测的是"读了"，不是"用了" —— "用了"由上面那发（3 次 ⇒ 升 CEO）与
    // 反向那发（2 次 ⇒ 照旧打回）管。两件事分开测，是因为它们能被两次不同的改动各自弄坏。
    const calls: string[] = [];
    const { res } = await newWorld({
      status: "IN_PROGRESS", // 不在 IN_REVIEW
      role: "dev", // 不是审阅者
      turn: turn(said({ action: "wait", summary: "继续写" })), // 不是 handoff
      rejectionCalls: calls,
    });
    expect(calls).toEqual(["t1"]);
    expect(res.status).toBe("IN_PROGRESS");
    expect(res.moved).toBe(false); // wait 不动状态：读了不等于用了
  });

  it("⭐ ⭐ 真循环：审阅者【每轮都打回】，第 4 轮必然停在 CEO 那一格（有界，不是「再推一次看看」）", async () => {
    // 这一发是整篇的落点。上面几发测的是"某一轮判对了"，而 0050 §8 那两发探针量到的是
    // 【跨轮】的事：单轮 advance 跑满 12 格 / 480 美分，驱动器每心跳又能重新起一轮，
    // 按格 attempts 每次回到 IN_PROGRESS 就归零 ⇒ 三道封顶一道都不拦这个循环。
    // 修好 REJECTED_DOWNWARD 之后这个循环【第一次成为可能】，所以必须有一发
    // 把"它会不会自己停"钉在仓库里，而不是靠我跑一次 /tmp 探针然后相信它。
    //
    // 全程只【导演角色的嘴】（每一轮给什么决策文本），计数与落点全走生产代码：
    // 分子是真 SQL 数出来的（见 countRejections 那条注释），落点是真状态机走的。
    const w = await newWorld({
      status: "IN_PROGRESS",
      role: "dev",
      turn: turn(said({ action: "pass", summary: "登录模块写完" })),
    });
    const db = w.db;
    const status = () => String(db.prepare("SELECT status FROM tasks WHERE id='t1'").get()["status"]);
    const role = () => String(db.prepare("SELECT assigned_role FROM tasks WHERE id='t1'").get()["assigned_role"]);
    const trail: string[] = ["IN_PROGRESS/dev"];

    let r = w.res;
    let rounds = 0;
    // 上限是"最多 12 轮"而【期望远小于它】：如果实现退化到探针里那种不设防的样子，
    // 这一发会跑满 12 轮并红在下面那句"停在 CEO"上 —— 那一红就是探针量到的那个事故。
    while (status() !== "ESCALATED_TO_CEO" && rounds < 12) {
      const next =
        status() === "IN_PROGRESS"
          ? said({ action: "pass", summary: "补上了，再审" }) // dev：交上去
          : said({ action: "handoff", to_role: "dev", summary: "鉴权还是缺，打回" }); // 审阅者：永远不满意
      r = await w.again(turn(next));
      rounds += 1;
      trail.push(status() + "/" + role());
      void r;
    }
    // ⭐ 有界：三轮打回之后升 CEO，循环【不是靠预算烧完才停的】
    expect(status()).toBe("ESCALATED_TO_CEO");
    // dev 交 → 审阅者打回 × 3 → 第 4 轮升上去 = 7 轮。钉住这个数字是因为
    // "有界"这件事本身没有内容：12 轮也有界，而代价是每心跳多烧 5 轮真钱。
    expect(rounds).toBe(7);
    expect(trail.filter((x) => x === "IN_PROGRESS/dev").length).toBe(4); // 初次 + 三次重做
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id='t1' AND action='state_change' AND json_extract(payload,'$.to')='REJECTED_DOWNWARD'").get()["n"]).toBe(
      3,
    );
    // 而且它【真的进了人的收件箱】—— 不是停在一个没人能动的格子（0050 §8 那一族）
    const cards = db.prepare("SELECT card_key FROM approvals WHERE task_id='t1' AND status='pending'").all();
    expect(cards.length).toBe(1);
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
      rejectionCount: () => 0,
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
      rejectionCount: () => 0,
      ceoApproved: () => false,
      // publish 现在是【必填】：这一发跑不到广播那一步（loadTask 就抛了），但让它可选
      // 等于允许装配时漏传，而漏传的后果是 TS 不响、测试照绿、只有前端看得见空洞。
      publish: () => {},
    });
    await expect(dispatch({ taskId: "ghost", nowMs: NOW, maxBudgetUsd: 1 })).rejects.toThrow(/不存在的任务烧 token/);
  });
});

/* ───────────── 0047 门 0.5 / 门 0.6 的写路径（真库、真事务、真卡片）─────────────
   上面那两组纯函数用例证的是【判据】，这一组证的是【代价】：
   探针量到的两发都是「判据写对了也照样白烧一轮、照样写下那行假审计」，
   所以断言一律看三样东西 ——
    · turns.n（子进程起没起）：钱只有计数能证明；
    · events 里 actor_type='agent' 且 actor_id=CEO 的行数：那行假审计；
    · approvals 里那张卡：任务停在人席时那个人手上有没有入口（0046 那一发）。
   结果本身（moved / status）反而排在最后 —— 它可以由任何一条提前 return 造出来。 */

describe("0047 顶层判定与「下一位是人类」的写路径", () => {
  it("⭐ 四层图 + manager pass ⇒ 一次跑动写【三条】状态边，停在 ESCALATED_TO_CEO 且【带一张卡】", async () => {
    const turns = { n: 0 };
    const roles: string[] = [];
    const { db, res, events } = await newWorld({
      graph: DEEP_GRAPH,
      status: "IN_PROGRESS",
      role: "manager", // 它的上级正是 ceo
      turns,
      roles,
      turn: turn(said({ action: "pass", summary: "模块联调完了" })),
    });
    // 只跑了一轮 —— 产出方那一轮。CEO 那一格【没有】第二轮（探针 B 里 roles 是
    // ["manager","ceo"]，那一发就是这一条要断言红的东西）。
    expect(turns.n).toBe(1);
    expect(roles).toEqual(["manager"]);

    expect(res.status).toBe("ESCALATED_TO_CEO");
    expect(res.moved).toBe(true);
    const chain = events
      .filter((e) => e["action"] === "state_change")
      .map((e) => {
        const p = JSON.parse(String(e["payload"])) as Record<string, unknown>;
        return String(p["from"]) + "→" + String(p["to"]);
      });
    // 中间那两格在历史上【留着】：回放不能看到"从 IN_PROGRESS 直接升到 CEO"
    expect(chain).toEqual([
      "IN_PROGRESS→EVIDENCE_SUBMITTED",
      "EVIDENCE_SUBMITTED→IN_REVIEW",
      "IN_REVIEW→ESCALATED_TO_CEO",
    ]);
    // ⭐ 每一格的起点 = 上一格的落点。这是「第三格的起点取自链尾而不是写死
    // IN_REVIEW」的【可见性质】：写死的话一旦自动边形状变了，这里会写出
    // 一条 from 与 to 不同源的边，而 assertTaskTransition 照样放行。
    const legs = events
      .filter((e) => e["action"] === "state_change")
      .map((e) => JSON.parse(String(e["payload"])) as Record<string, unknown>);
    for (let i = 1; i < legs.length; i++) {
      expect(String(legs[i]?.["from"])).toBe(String(legs[i - 1]?.["to"]));
    }

    // ⭐ 那行假审计【一行都没有】：CEO 没有以 agent 身份跑过任何一轮
    const fake = db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE actor_type='agent' AND actor_id='ceo'")
      .get() as Row;
    expect(Number(fake["n"])).toBe(0);

    // 负责角色保持产出方，【没有】被改成 ceo（否则一次"升给 CEO 看"= 一次组织分配）
    expect(String(db.prepare("SELECT assigned_role FROM tasks").get()["assigned_role"])).toBe("manager");

    // 0046 那一发：停在人席 ⇒ 手上必须有一张卡，否则这一发只是换了个姿势的死路
    const cards = db.prepare("SELECT * FROM approvals").all();
    expect(cards.length).toBe(1);
    expect(String(cards[0]["card_key"])).toBe("seat:ESCALATED_TO_CEO:" + String(res.stateEventSeq));
    expect(res.card).not.toBeNull();
  });

  it("⭐ 根叫 boss 的图：顶层照样判得出，任务到 CEO 席位而不是停在 agent 席位", async () => {
    // 探针 A 的原样形状（修复前：status 停在 IN_REVIEW/agent 席位、每轮白烧、卡片数 0）。
    // 装配【不指定】ceoRoleId —— 顶层由图里的汇报根回答，这是"名字不参与判定"的完整链路。
    const turns = { n: 0 };
    const { res } = await newWorld({
      graph: BOSS_GRAPH,
      status: "IN_PROGRESS",
      role: "director",
      turns,
      turn: turn(said({ action: "pass", summary: "第一版做完" })),
    });
    expect(turns.n).toBe(1);
    expect(res.status).toBe("ESCALATED_TO_CEO");
    expect(res.seat).toBe("agent"); // 返回值上这一格仍是本轮的执行席位，看 status 才是落点
  });

  it("⭐ 图没有汇报根（成环 / 空图）⇒ 【一轮都不跑】、一条事件都不写，note 说得出修法", async () => {
    const turns = { n: 0 };
    const cyclic: OrgGraph = {
      nodes: {
        a: { role_id: "a", can_manage: true, reports_to: "b" },
        b: { role_id: "b", can_manage: true, reports_to: "a" },
      },
      edges: [],
    };
    const { res, events } = await newWorld({
      graph: cyclic,
      status: "IN_PROGRESS",
      role: "a",
      turns,
      turn: turn(said({ action: "pass", summary: "自审自过" })),
    });
    // 判在 runTurn 之前 = 钱没烧。这一格与"判对但代价照付"是这一发的全部区别。
    expect(turns.n).toBe(0);
    expect(res.moved).toBe(false);
    expect(events.length).toBe(0);
    expect(res.note).toContain("没有汇报根");
  });

  it("装配指定的 CEO 不在这版图上 ⇒ 响亮拒绝，而不是静采用一个无效名字", async () => {
    const turns = { n: 0 };
    const { res } = await newWorld({
      graph: BOSS_GRAPH,
      status: "IN_PROGRESS",
      role: "director",
      ceoRoleId: "ceo", // 一个在 BOSS_GRAPH 里不存在的角色名
      turns,
      turn: turn(said({ action: "pass", summary: "干完了" })),
    });
    expect(turns.n).toBe(0);
    expect(res.moved).toBe(false);
    expect(res.note).toContain("[ceo]");
    expect(res.note).toContain("[boss]");
  });

  it("⭐ 任务【一开始】就建在 CEO 角色上 ⇒ 不起子进程扮演他，且不写任何审计", async () => {
    const turns = { n: 0 };
    const roles: string[] = [];
    const { res, events } = await newWorld({
      graph: DEEP_GRAPH,
      status: "IN_PROGRESS",
      role: "ceo",
      turns,
      roles,
      // 替身会乖乖交出 pass。它必须根本没被跑到：CEO 是人类席位，
      // hub 起子进程扮演他 = 审计里一行「CEO 以 agent 身份跑了一轮」，append-only 删不掉。
      turn: turn(said({ action: "pass", summary: "我自己批自己" })),
    });
    expect(turns.n).toBe(0);
    expect(roles).toEqual([]);
    expect(res.moved).toBe(false);
    expect(res.status).toBe("IN_PROGRESS");
    expect(events.length).toBe(0);
    expect(res.note).toContain("人类席位");
    expect(res.note).toContain("扮演");
  });
});
