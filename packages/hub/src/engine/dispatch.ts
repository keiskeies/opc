/**
 * 调度器：让【当前负责这个任务的那个角色】作为一个真的 agent 干一轮活，
 * 然后由 hub 判它这一步能不能算数。
 *
 * ── 分工（这条线是整个 engine/ 的全部理由）────────────────────────────
 *   agent 决定【内容 + 下一跳】：做什么、结论是什么、交给哪个角色。
 *   hub 决定【这一步能不能过】：状态机跃迁、组织边界、审阅独立性、预算、审批。
 *
 * 为什么不照 §5.4 那样把流转写进图（7 节点 / 8 条线性边）：员工的下一步由【这一轮的
 * 产出】决定，那是运行期的事实，编译期的边表达不了。为什么不干脆让 agent 说了算：
 * 那等于让被约束者否决门控（§8.2 的立场正相反），而且 events 是 append-only ——
 * 一次越权跃迁写下去就永远在审计里（status.ts 文件头同一条）。
 *
 * ── 谁能动：AGENT_EDGES / HUMAN_EDGES 那两张表 ────────────────────────
 * 每条边都写明【谁能走】。CEO 那三个席位（CHARTER_PENDING / ESCALATED_TO_CEO /
 * FINAL_REVIEW）【没有 agent 出边】⇒ 站在那些状态上的一轮执行根本不会开始
 * （seatOf 判掉，token 都不烧）。于是「一个被 prompt 注入的角色输出 pass 把自己
 * 交付掉」在结构上不可能：不是提示词不许，是那条边不存在。这比任何措辞都硬。
 *
 * ── 写路径 ────────────────────────────────────────────────────────────
 * 一条状态边 = tasks 那一行（带 status 守卫的 UPDATE）+ 一行 events，同一个 node()
 * 事务。缺任何一半都是 §6.3 那个老形状；后半缺得更隐蔽：events.id 被消费而没 publish
 * ⇒ SSE 订阅看到一个 seq 空洞 ⇒ 每次推进都把连接标脏一次（0010 §4）。
 *
 * ── 本模块【没有】接的东西，写在这里而不是散在注释里 ────────────────────
 *  · Checkpoint（§7.4 断点恢复）：原责任方是 LangGraph 的 Saver.put（0005 §16），
 *    引擎换了之后归属要重定 → 0041。
 *  · 证据包（§8.1）：交接只带一句 summary，没有 bundle ⇒ §8.2 第 2 条
 *    「通过必须附可验证证据」现在【无处可满足】。缺口在 0041 里是显式一格。
 *  · 「终止任务」：§7.4 给了这个按钮，而 §7.1 的 15 个状态里【没有终止态】，
 *    所以那个按钮在全仓任何一张边表里都落不了地（不是没写，是没有合法的目的地）。
 *  · 自动批准 / 策略引擎 / 会议子图 / 心跳：未接。
 */
import type { OrgGraph } from "@opc/contracts";
import type { Writer } from "../db/write-queue.js";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import { appendAudit, KIND_TO_ACTION } from "../events/recorder.js";
import type { DomainEvent } from "../events/bus.js";
import {
  approvalRequiredEvent,
  insertCard,
  type ApprovalRequiredEvent,
  type NewCardDraft,
} from "../approvals/cards.js";
import { getDescendants } from "@opc/contracts";
import { readGraphByVersion } from "../org/commit.js";
import { assertTaskTransition, legalTransitionsFrom, type TaskState } from "../graph/status.js";
import { DECISION_MARK, parseDecision, type RoleAction, type RoleDecision } from "./claude.js";

/** 一轮执行的账单：CLI 报美元浮点，账上一律整数美分（§6.1）。 */
export function usdToCents(usd: number): number {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) return 0;
  return Math.round(usd * 100);
}

/**
 * 状态边写入。守卫里那半个 `AND status = ?` 是本模块最容易写错的一格：
 *
 * 一轮 agent 执行要几分钟。期间 CEO 可能改了组织、巡检可能升了级、另一轮 dispatch
 * 可能已经推进过这个任务。若只按 id 更新，那条【基于过期认知算出来的】边会盖掉
 * 期间发生的一切 —— 审计里出现一条从未合法的跃迁，而它删不掉。
 * `changes !== 1` 时整笔回滚（连账单都不记）：「状态没动而钱记上了」会让下一次重试
 * 看着像为同一轮又付一遍。
 *
 * `consumed_cents` 用 COALESCE：那一列可空（0001_init.sql:44），而 `NULL + 3` 是 NULL ——
 * 直接写 `consumed_cents + ?` 会把第一笔之后的账面永远变成 NULL，界面显示「没花过钱」。
 */
export const WRITE_EDGE_SQL =
  "UPDATE tasks SET status=?, current_node=?, assigned_role=?, " +
  "consumed_cents=COALESCE(consumed_cents,0)+?, updated_at=? WHERE id=? AND status=?";

/** 不跃迁的那一轮（待料 / 判不了 / 被拦）：只结账，不动状态。 */
export const LEDGER_SQL =
  "UPDATE tasks SET consumed_cents=COALESCE(consumed_cents,0)+?, updated_at=? WHERE id=?";

/* ───────────────────────── 谁能走哪条边 ───────────────────────── */

/** 一条 agent 可走的边。next 说明【下一轮由谁开口】。 */
export interface AgentEdge {
  readonly to: TaskState;
  /**
   * same=还是这个角色 | target=它点名的那个角色 | upstream=它的直接上级
   * | topmost=沿汇报树向上的第一个非 ceo 角色，到顶则升 CEO。
   */
  readonly next: "same" | "target" | "upstream" | "topmost";
  readonly why: string;
}

/**
 * agent 能推进的那些边。取值全部对着 §7.1 的边表，一条不加一条不减 ——
 * 加一条边 = 改状态机（要 CEO 拍板），减一条 = 任务卡死。
 *
 * 表【之外】的组合一律不动状态，并在 note 里说明为什么不动。这个「不默认往下走」
 * 的立场与 claude.ts 的 parseDecision 同源：格式跑偏不该变成一次静默推进。
 */
export const AGENT_EDGES: Readonly<Partial<Record<TaskState, Partial<Record<RoleAction, AgentEdge>>>>> = {
  // §7.1 767→768：章程已批（那一格是 CEO 的席位，见 HUMAN_EDGES），开始拆解
  CHARTER_APPROVED: { pass: { to: "DECOMPOSING", next: "same", why: "章程已批，开始拆解这件事" } },
  // §7.1 768→769：拆解 = 决定谁来做 ⇒ 这一跳是 handoff，活儿落到被点名的角色身上
  DECOMPOSING: { handoff: { to: "IN_PROGRESS", next: "target", why: "拆解完成，活儿交给被点名的角色" } },
  // §7.1 769→770：我这一轮做完了，交直接上级审阅。⚠ 这里【还没有】证据包（文件头那条缺口）
  IN_PROGRESS: { pass: { to: "EVIDENCE_SUBMITTED", next: "upstream", why: "本轮产出提交上级审阅" } },
  IN_REVIEW: {
    // §7.1 772：通过。next=topmost —— 还有上级就进下一层，到顶就升 CEO（§7.2 步骤 7→8）
    pass: { to: "APPROVED_UPWARD", next: "topmost", why: "审阅通过" },
    // §7.1 773：打回。沿汇报树【向下】，所以复用 handoff（同一个方向、同一条边）
    handoff: { to: "REJECTED_DOWNWARD", next: "target", why: "审阅打回 / 派回下游" },
    blocked: { to: "ESCALATED_TO_CEO", next: "same", why: "审阅者要求 CEO 裁决（§8.3）" },
  },
  // §8.3 第二条 + §7.4：预算暂停必须升到 CEO，否则卡片起草了却送不到（status.ts 那段补边理由）
  BUDGET_PAUSED: { blocked: { to: "ESCALATED_TO_CEO", next: "same", why: "预算暂停需 CEO 决定追加/终止" } },
};

/**
 * EVIDENCE_SUBMITTED → IN_REVIEW 是 hub 自动走的边。
 *
 * 「自动」在这里不是偷懒：§7.1 从这一状态【只有一个出口】，没有任何判断发生 ——
 * 产出进了审阅队列，下一个动作是审阅者开口（§8.2 第 3 条把显式决定放在【审阅】那一格，
 * 不在「进入队列」这一格）。同一事务里多写一条边，审计反而更完整。
 */
export const AUTO_AFTER_EDGE: Readonly<Partial<Record<TaskState, TaskState>>> = {
  EVIDENCE_SUBMITTED: "IN_REVIEW",
};

/** CEO 的三个席位 + 交付。只有人类决策能走（§9）。 */
export interface HumanEdge {
  readonly to: TaskState;
  readonly why: string;
}

/**
 * 人坐的格子的那三条边。写进表而不是散在 handler 里，是为了让 seatOf 的那句
 * 「这个状态有没有 agent 出边」有【另一半】可对：一张状态若在两张表里都没有出边，
 * 它就是死路，而那是 §7.1 的现状（MEETING_REQUIRED / BLOCKED），不是本模块的漏洞。
 */
export const HUMAN_EDGES: Readonly<Partial<Record<TaskState, Partial<Record<"approve", HumanEdge>>>>> = {
  CHARTER_PENDING: { approve: { to: "CHARTER_APPROVED", why: "CEO 签署岗位书/章程（§7.1 766→767）" } },
  ESCALATED_TO_CEO: { approve: { to: "FINAL_REVIEW", why: "CEO 批准上线（§7.2 步骤 8→9）" } },
  FINAL_REVIEW: { approve: { to: "DELIVERED", why: "终审通过，交付（§7.1 778→779）" } },
};

/**
 * 这一轮【该不该让 agent 说话】。
 *
 * 判据不是「状态名在某个黑名单里」，而是「这个状态有没有 agent 出边」。
 * 差别在于会不会腐烂：黑名单是手抄的，加状态时漏抄 = 那个状态上白烧 token 且
 * 可能推进不该推进的边；按边表判则新状态【默认是人的席位】（fail-closed）。
 */
export function seatOf(status: TaskState): "agent" | "human" {
  return Object.keys(AGENT_EDGES[status] ?? {}).length > 0 ? "agent" : "human";
}

/** 人坐的那一格，一次「批准」能走到哪。 */
export function humanEdge(status: TaskState, decision: "approve"): { to: TaskState; why: string } | null {
  return HUMAN_EDGES[status]?.[decision] ?? null;
}

/* ───────────────────────── 组织边界 ───────────────────────── */

/**
 * agent 点名的下一跳，hub 认不认。
 *
 * 只判【组织边界】（是不是图上的人、是不是自己人链子里的人），不判审阅独立性 ——
 * 那是 reviewGate 的活。分开是因为两者回答不同问题，混在一个函数里会导致
 * 「派活被独立性规则拦下」这种说不清的拒绝。
 */
export type HandoffGate =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "self_handoff" | "unknown_role" | "not_downstream";
      readonly reason: string;
    };

export function handoffGate(o: {
  readonly graph: OrgGraph;
  readonly from: string;
  readonly to: string;
}): HandoffGate {
  const { graph, from, to } = o;
  if (to === "") {
    return {
      ok: false,
      code: "self_handoff",
      reason: "handoff 没点名收件人。hub 不猜下游 —— 猜错一次的代价是任务跑到一个没人负责的角色手里。",
    };
  }
  if (to === from) {
    return { ok: false, code: "self_handoff", reason: "handoff 的收件人是它自己 [" + from + "]。自己交给自己不是一次交接。" };
  }
  if (graph.nodes[to] === undefined) {
    return {
      ok: false,
      code: "unknown_role",
      reason:
        "角色 [" + to + "] 不在这张组织图上。agent 不能凭空造一个收件人 —— 要加角色，" +
        "先在组织配置里加（POST /org，那条路径上有 L1/L2/L3 三关校验）。",
    };
  }
  // 「向下」= 被交者在自己的汇报子树里。跨部门平级塞活儿等于绕开 §3.3 的委派规则图，
  // 而绕开之后「谁的活儿谁负责」在审计里就断了。
  if (!getDescendants(graph, from).includes(to)) {
    const subs = subordinateRoles(graph, from);
    return {
      ok: false,
      code: "not_downstream",
      reason:
        "[" + to + "] 不在 [" + from + "] 的汇报子树里。" + from + " 能直接交下去的角色：" +
        (subs.length > 0 ? subs.join(" / ") : "（无 —— 它是叶子角色）") + "。",
    };
  }
  return { ok: true };
}

/**
 * §8.2 第 1 条 + §24 风险 1：审阅者与产出者不得同源。
 *
 * 同家族 ⇒ 拦，并交给 CEO 显式批准（§5.9 允许「同家族 + CEO 批」）。今天全仓角色
 * 都跑在同一个模型家族上，所以【每一道审阅都会先落到这张卡】—— 这是刻意的：
 * 宁可CEO多点一次「同源可以」，也不让「两个不同 agent」的表象冒充独立性。
 * 代价与撤除条件记在 0041 §5。
 */
export type ReviewGate = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function reviewGate(o: {
  readonly producerRole: string | null;
  readonly reviewerRole: string;
  readonly producerFamily: string;
  readonly reviewerFamily: string;
  readonly approvedByCeo: boolean;
}): ReviewGate {
  if (o.producerRole === null) {
    return { ok: false, reason: "查不到这条产出是谁交的（events 里没有产出方），无法判定审阅独立性。缺信息不放行。" };
  }
  if (o.producerRole === o.reviewerRole) {
    return {
      ok: false,
      reason: "审阅者 [" + o.reviewerRole + "] 与产出者是同一角色 —— §8.2 第 1 条，图结构上的硬约束，不接受运行时豁免。",
    };
  }
  if (o.producerFamily.trim() === "" || o.reviewerFamily.trim() === "") {
    return { ok: false, reason: "产出方或审阅方的 model_family 未声明，无法判定是否同源（§5.9），不放行。" };
  }
  if (o.producerFamily === o.reviewerFamily && !o.approvedByCeo) {
    return {
      ok: false,
      reason:
        "产出方 [" + o.producerRole + "] 与审阅者 [" + o.reviewerRole + "] 同属模型家族 [" +
        o.producerFamily + "]（§24 风险 1）：同家族判断高度相关，「两个不同 agent」只是表象。" +
        "需要 CEO 显式批准（§5.9）。",
    };
  }
  return { ok: true };
}

/** 直接下属（reports_to 指向它的角色），排序保证确定性。 */
export function subordinateRoles(graph: OrgGraph, roleId: string): string[] {
  return Object.values(graph.nodes)
    .filter((n) => n.reports_to === roleId)
    .map((n) => n.role_id)
    .sort();
}

/** 直接上级。CEO 或图里没写 ⇒ null。 */
export function upstreamOf(graph: OrgGraph, roleId: string): string | null {
  const up = graph.nodes[roleId]?.reports_to ?? null;
  return up === undefined || up === "" ? null : up;
}

/* ───────────────────────── 判定（纯函数）───────────────────────── */

export type EdgePlan =
  | { readonly move: true; readonly to: TaskState; readonly role: string; readonly note: string; readonly producerRole?: string }
  | { readonly move: false; readonly to: TaskState; readonly role: string; readonly note: string };

/**
 * 「这一轮该不该改状态」——本文件唯一可穷尽测试的那一块。
 *
 * 判据是 AGENT_EDGES[当前状态][action]，而不是「这个 action 通常映射到哪个状态」：
 * 一个角色说 pass 不代表它可以宣布自己终审通过，正如它不能批准自己的产出。
 * 表里没有 ⇒ 不动，并把【为什么不动】写进 note（回放里必须答得出任务为什么停着）。
 */
export function planEdge(o: {
  readonly status: TaskState;
  readonly role: string;
  readonly graph: OrgGraph;
  readonly decision: RoleDecision | null;
  /** handoffGate 的结论：ok 时才是合法收件人。 */
  readonly handoffTo: string | null;
  /** 越权交接的拒绝理由（有值 ⇒ 这一轮要建卡）。 */
  readonly blockedHandoff: string | null;
  /** pass 在 IN_REVIEW 上的独立性判定。 */
  readonly review: ReviewGate | null;
  /** pass 落点需要沿树上移时用的当前角色上级（CEO 判定的入口）。 */
  readonly ceoRoleId: string;
  /**
   * 这一轮执行【失败】的原文。非 null 时任何动作都不推进状态 ——
   * 判在 parseDecision 之前是有实据的：CLI 被 SIGKILL 或预算掐断时，stdout 上可能
   * 留着【上半轮的】半截输出，而那里头完全可以有一个格式完好的决策段。
   * 「进程没跑完」这件事只有调用方知道，所以它必须是一条输入而不是靠文本推断。
   *
   * 【可选】是因为绝大多数调用点没有失败这一维（纯函数测试尤其）。
   * 判定时先收成 null，免得 `!== null` 这一支把 undefined 当失败——
   * 那会让「没传这个字段」看起来像「这一轮失败了」，而两者的后果完全相反。
   */
  readonly failure?: string | null;
}): EdgePlan {
  const d = o.decision;
  const failure = o.failure ?? null;
  const stay = (note: string): EdgePlan => ({ move: false, to: o.status, role: o.role, note });

  if (failure !== null) {
    return stay(failure + "（状态不变；账单照记，那一行账与这条 note 在同一次事务里）");
  }
  if (d === null) {
    return stay("这一轮没有给出可判定的决策段（缺 " + DECISION_MARK + " 或格式不合），任务留在 " + o.status + "。");
  }
  if (d.action === "wait") return stay(d.summary);
  if (d.action === "handoff" && o.blockedHandoff !== null) {
    return stay(o.blockedHandoff + "（已建卡，等你裁决）");
  }
  if (d.action === "pass" && o.review !== null && !o.review.ok) {
    return stay(o.review.reason + "（已建卡）");
  }

  const edge = AGENT_EDGES[o.status]?.[d.action];
  if (edge === undefined) {
    const outs = legalTransitionsFrom(o.status);
    return stay(
      "角色报告 [" + d.action + "]：" + d.summary + " —— 但 " + o.status + " 状态下这个动作不对应任何合法的" +
        "状态跃迁（§7.1 从 " + o.status + " 出发：" + (outs.length === 0 ? "无出路，死路" : outs.join(" / ")) + "）。" +
        "状态不变。要改的是状态机（需 CEO 拍板），不是让它走过去。",
    );
  }

  let nextRole = o.role;
  let to = edge.to;
  if (edge.next === "target") {
    if (o.handoffTo === null) return stay("交接没点名收件人，状态不变。" + d.summary);
    nextRole = o.handoffTo;
  } else if (edge.next === "upstream") {
    const up = upstreamOf(o.graph, o.role);
    if (up === null) return stay(o.role + " 在组织图上没有上级，产出无处可交（状态不变）。" + d.summary);
    nextRole = up;
  } else if (edge.next === "topmost") {
    // §7.1 从 IN_REVIEW 同时给了 APPROVED_UPWARD 与 ESCALATED_TO_CEO 两条边，
    // 选哪条由【组织树】回答而不是由 agent 回答：还有上级 → 进下一层；到顶 → 升 CEO。
    const up = upstreamOf(o.graph, o.role);
    if (up === null || up === o.ceoRoleId) {
      to = "ESCALATED_TO_CEO";
      return { move: true, to, role: o.role, note: "审阅通过且已到组织顶层，升到 CEO：" + d.summary };
    }
    to = "IN_PROGRESS";
    nextRole = up;
  }

  const note = edge.why + "：" + d.summary;
  // 产出方那一格要留在审计里：IN_REVIEW 上判独立性时要知道【审的是谁的产出】。
  // 存 payload 而不是新增列 —— 这一列没有别的读方，而加一列要过一次迁移。
  return edge.to === "EVIDENCE_SUBMITTED"
    ? { move: true, to, role: nextRole, note, producerRole: o.role }
    : { move: true, to, role: nextRole, note };
}

/* ───────────────────────── 任务简报 ───────────────────────── */

/**
 * 给员工的任务简报。三件事是刻意的：能交给谁（列名字）、上一轮结果、
 * 以及「你没有推进状态 / 审批的权力」。第三句不是装饰 —— 提示词里的授权不影响
 * 代码里的判定，但它决定 agent 会不会每轮都试着宣布一次「我通过了」。
 */
export function buildTurnPrompt(o: {
  readonly title: string;
  readonly status: TaskState;
  readonly role: string;
  readonly subordinates: readonly string[];
  readonly upstream: string | null;
  readonly summaries: readonly string[];
  readonly ceoRoleId: string;
}): string {
  const lines = ["任务：" + o.title, "当前状态：" + o.status + "；负责角色：" + o.role];
  if (o.upstream !== null) lines.push("你的直接上级：" + o.upstream + "（你的 pass 会交到它手上）");
  lines.push(
    "你可以直接交下去的角色：" +
      (o.subordinates.length > 0 ? o.subordinates.join(" / ") : "（无 —— 你是叶子角色，只能 wait 或 blocked）"),
  );
  if (o.summaries.length > 0) {
    lines.push("", "这条任务上最近的汇报（新 → 旧）：");
    for (const s of o.summaries) lines.push("- " + s);
  }
  lines.push(
    "",
    "现在做你这一轮的活，然后向我汇报。",
    "",
    "最后一行之后【必须】原样输出下面这一行，紧跟一个 JSON 对象，全文只出现这一处（不要举例）：",
    DECISION_MARK,
    '{"action":"pass|handoff|blocked|wait","to_role":"仅 handoff 需要","summary":"一句话：做了什么、结论是什么","note":"可选"}',
    "",
    "- pass：你这一轮该做的事做完了，按汇报关系往上走（不要点名给谁）。",
    "- handoff：把活儿交给【上面列出的】某个角色，或把不合格产出打回下游。只能交给自己链子里的人。",
    "- blocked：只在这件事【必须】" + o.ceoRoleId + " 拍板、你自己定不了时用。",
    "- wait：其余一切情况（还需要继续做，或还在等外部东西）。",
    "",
    "你无权推进任务状态、无权批准任何审批、无权跳过审阅门控 —— 那些由 hub 判定。",
  );
  return lines.join("\n");
}

/* ───────────────────────── 卡片 ───────────────────────── */

const CARD_BUTTONS: readonly ["approve", "reject_with_comment", "defer_deep_review"] = [
  "approve",
  "reject_with_comment",
  "defer_deep_review",
];

/**
 * 建卡。cardKey 是「同一件事只出一张」的键，由调用方给（cards.ts 文件头那条判据：
 * 能唯一标识哪一次决定的信息只有调用方知道）。
 *
 * ⚠ buttons 用的是 APPROVAL_BUTTONS 那三个【长名字】。它与 http 决策侧的 ResumeValue
 * 是【两套词表】，卡片这一侧必须用前者；写错会被 .strict() 的枚举拒在建卡那一刻。
 */
function card(o: {
  readonly taskId: string;
  readonly cardKey: string;
  readonly summary: string;
  readonly impact: string;
  readonly recommendation: string;
  readonly evidence: string;
}): NewCardDraft {
  return {
    taskId: o.taskId,
    approvalType: "escalation",
    cardKey: o.cardKey,
    summary: o.summary,
    parameters: {
      impact_scope: o.impact,
      irreversible: false,
      recommendation: o.recommendation,
      recommendation_is_not_decision: true,
      timeout_behavior: "escalate",
    },
    evidence_refs: [o.evidence],
    buttons: [...CARD_BUTTONS],
    escalation: { reason: "outside_decision_scope" },
  };
}

/* ───────────────────────── 调度器 ───────────────────────── */

export interface DispatchTask {
  readonly id: string;
  readonly title: string;
  readonly status: TaskState;
  readonly role: string;
  /** 任务【创建时】的组织图版本（§18.4）。不是「当前最新」。 */
  readonly graphVersion: number;
}

export interface TurnOutcome {
  readonly ok: boolean;
  readonly text: string;
  readonly costCents: number;
  readonly sessionId: string | null;
  readonly error: string | null;
}

export interface RunTurnInput {
  readonly role: string;
  /**
   * 【本轮】的简报（任务、状态、能交给谁、最近的汇报）。
   * 里面带着 agent 上一轮自己写的 summary 原文，所以它是【不可信内容】的那一侧。
   */
  readonly prompt: string;
  /**
   * 角色身份（岗位书）。与 prompt【分开传】而不是在这里拼好：它走的是
   * --append-system-prompt 那一格，而简报走 stdin。拼成一条就把「谁在说话」和
   * 「这轮要干什么」塞进同一个通道，装配方再想分开发也只能把身份重复一遍。
   */
  readonly rolePrompt: string;
  readonly resumeSessionId: string | null;
  readonly maxBudgetUsd: number;
}

/**
 * 记账钩子：由装配方实现（真库上是 budget_events 那一行 + budgets 的扣减）。
 * seq = 本次写入的 events.id（幂等键）。
 *
 * ⚠ 同步、且【不返回任何东西】是有意的两格，别顺手改：
 *  1. 它跑在本模块的写事务里，钩子只能写【不消费 events.id 的表】。
 *     budget_events 与 budgets 正是这种表（它们不是 events，不发 seq），
 *     所以钩子写它们不会给 SSE 留洞。若将来钩子需要写 events
 *     （比如预算突破要发 BudgetPaused），它就必须拿到一个 publish 通道，
 *     而那时【先解决状态机】：§7.1 只有 IN_REVIEW → BUDGET_PAUSED 一条入边，
 *     从 IN_PROGRESS 硬停没有合法落点，不能为了记账现造一条边（0041 §7）。
 *  2. 它【不能】用 BudgetTracker.consume：那个方法要求 recorder.inStepTx()
 *     （超步事务的责任方是 recorder.run），而 engine/ 这条路线上没有超步。
 *     装配方直接落那两条 SQL，幂等键仍旧是这里的 seq。
 */
export interface CostHook {
  (o: {
    readonly db: Parameters<typeof appendAudit>[0];
    readonly taskId: string;
    readonly role: string;
    readonly seq: number;
    readonly costCents: number;
    /**
     * 本轮的时刻，与本轮写下的 events / tasks 行【同一个钟】。
     * 不给这一格的话，装配方只能自己 Date.now()，于是同一轮的 budget_events.created_at
     * 与 events.created_at 会差几毫秒 —— 平时无害，但「按时刻串一轮」的读法
     * （回放里那一轮花了多少）就会把同一轮的两行排到两个时刻上。
     */
    readonly nowMs: number;
  }): void;
}

export interface DispatchOptions {
  readonly taskId: string;
  readonly nowMs: number;
  /** 这一轮给角色的美元硬顶，直接落到 --max-budget-usd。 */
  readonly maxBudgetUsd: number;
}

export interface DispatchResult {
  readonly taskId: string;
  /** 【落库之后】的状态。与调用前相同时表示这一步没算数。 */
  readonly status: TaskState;
  readonly role: string;
  readonly moved: boolean;
  /** 这一轮是谁在决定：人坐的席位不会走到 agent。 */
  readonly seat: "agent" | "human";
  /** 一句人话：这一轮为什么走到这里（或为什么没动）。 */
  readonly note: string;
  readonly costCents: number;
  readonly sessionId: string | null;
  readonly stateEventSeq: number | null;
  readonly card: ApprovalRequiredEvent | null;
}

export interface DispatchDeps {
  readonly writer: Writer;
  readonly loadTask: (taskId: string) => DispatchTask | null;
  /**
   * 某角色可用的模型家族（§5.9）。缺 ⇒ 空串，而空串会让审阅【不放行】
   * （reviewGate 的 unknown_model_family 那一支）。装配方不能图省事返回 ""。
   */
  readonly modelFamily: (roleId: string) => string;
  readonly rolePrompt: (roleId: string) => string;
  /** 该角色上一轮在这个任务上的会话 id；没有 ⇒ null（首轮，不 --resume）。 */
  readonly roleSession: (taskId: string, roleId: string) => string | null;
  readonly runTurn: (i: RunTurnInput) => Promise<TurnOutcome>;
  /** 最近的汇报摘要（新的在前），喂进简报。 */
  readonly recentSummaries: (taskId: string) => readonly string[];
  /** 这条任务上最近一次【提交审阅】的产出方角色（独立性判定的输入）。 */
  readonly lastProducer: (taskId: string) => string | null;
  /** 同一件事是否已被 CEO 批过（同源审阅放行凭据）。 */
  readonly ceoApproved: (taskId: string, cardKey: string) => boolean;
  readonly ceoRoleId?: string;
  readonly onCost?: CostHook;
  /**
   * 提交之后广播【本轮写下的每一条】事件，而不只是卡片。必填。
   *
   * 为什么必填而不是可选：events.id 就是 SSE 的 seq（events/bus.ts 文件头）。
   * 写了一行 events 而不广播 = 【消费了一个 seq 而没送出去】，那正是 0010 §4 量过的
   * 失效形状：活着的订阅撞见空洞、把 link 标成 stale 去重拉快照。dispatch 一轮最多
   * 写四条 events（两条状态边 + 一条卡片 + 一条越权尝试），少广播任何一条，症状都不是
   * 「少一条更新」而是【每次推进都把连接标脏一次】—— 比什么都不写还糟。
   *
   * 与 http/real-deps.ts 的 applyDecision 同一个立场：那里也把这参数做成必填。
   * 「可选」会让【装配时忘了传】变成 TS 不响、测试也绿、只有前端能看见的缺陷。
   */
  readonly publish: (e: DomainEvent, seq: number) => void;
}

/**
 * 组织图读不出来的原因。两种都是「不该继续跑」而不是「换个写法继续」。
 *
 * 这里【不】读最新图，也不在无图时退回一张内置默认图 —— 那正是 §18.4 阶段 3 要防的
 * 「旧任务在新汇报关系下继续跑」，而且它以一次正常运行（handoff 全部合法）的面目出现。
 */
export function orgGateAtVersion(
  db: Parameters<typeof readGraphByVersion>[0],
  graphVersion: number,
): { ok: true; graph: OrgGraph } | { ok: false; reason: string } {
  try {
    return { ok: true, graph: readGraphByVersion(db, graphVersion) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export function makeDispatch(deps: DispatchDeps): (o: DispatchOptions) => Promise<DispatchResult> {
  const ceo = deps.ceoRoleId ?? "ceo";
  return async (o: DispatchOptions): Promise<DispatchResult> => {
    const task = deps.loadTask(o.taskId);
    if (task === null) {
      throw new Error("dispatch: 任务 [" + o.taskId + "] 不存在。不能为一条不存在的任务烧 token。");
    }
    const stop = (note: string, costCents = 0, sessionId: string | null = null): DispatchResult => ({
      taskId: task.id,
      status: task.status,
      role: task.role,
      moved: false,
      seat: seatOf(task.status),
      note,
      costCents,
      sessionId,
      stateEventSeq: null,
      card: null,
    });

    // ── 席位：人坐着的格子不放 agent 进场（token 都不烧）──────────────
    if (seatOf(task.status) === "human") {
      return stop(
        task.status + " 等人不等 agent：这一格的出路只有【人类决策】（HUMAN_EDGES）。" +
          "推进它的是审批收件箱里的一次点击，不是又一轮执行。",
      );
    }

    // ── 门 0：组织图（用一次 node() 读一行【不可变的历史版本】）────────
    const org = await deps.writer.node(() => orgGateAtVersion(requireScopeDb("dispatch.orgGate"), task.graphVersion));
    if (!org.ok) return stop(org.reason);
    const graph = org.graph;
    if (graph.nodes[task.role] === undefined) {
      return stop(
        "任务负责角色 [" + task.role + "] 不在组织图 v" + task.graphVersion + " 上。" +
          "任务用的是创建时那一版组织图（§18.4），这里不能拿最新图顶上 —— 要么这一版确实没有它，" +
          "要么任务行与图版本对不上，两种都需要人看。",
      );
    }

    // ── agent 干活（内容 + 下一跳由它定）────────────────────────────
    const upstream = upstreamOf(graph, task.role);
    const outcome = await deps.runTurn({
      role: task.role,
      // 身份走 rolePrompt（→ --append-system-prompt），简报走 prompt（→ stdin）。
      // 在这里就拼成一条的话，装配方拿不到分开的两格，只能把身份再发一遍。
      rolePrompt: deps.rolePrompt(task.role),
      prompt: buildTurnPrompt({
        title: task.title,
        status: task.status,
        role: task.role,
        subordinates: subordinateRoles(graph, task.role),
        upstream,
        summaries: deps.recentSummaries(task.id),
        ceoRoleId: ceo,
      }),
      resumeSessionId: deps.roleSession(task.id, task.role),
      maxBudgetUsd: o.maxBudgetUsd,
    });
    // 失败轮【不 return】：它要走下面那条「不跃迁」的写路径，把账单与「为什么没动」
    // 一起落库。直接 return 的话，症状是「任务停着、钱没记、审计里查不到这一轮」，
    // 而这一轮真的花了钱（claude.ts 里那条「失败的执行也花了钱」同源）。
    const decision: RoleDecision | null = outcome.ok ? parseDecision(outcome.text) : null;

    // ── 门 2：组织边界（只有真点了名才判）─────────────────────────────
    const failure = outcome.ok ? null : "角色执行失败：" + String(outcome.error);
    let handoffTo: string | null = null;
    let blockedHandoff: string | null = null;
    let handoffTarget = "";
    if (failure === null && decision?.action === "handoff") {
      handoffTarget = (decision.to_role ?? "").trim();
      const gate = handoffGate({ graph, from: task.role, to: handoffTarget });
      if (gate.ok) handoffTo = handoffTarget;
      else blockedHandoff = gate.reason;
    }

    // ── 门 3：审阅独立性（只在 IN_REVIEW 的 pass 上判）─────────────────
    let review: ReviewGate | null = null;
    let sameFamilyKey: string | null = null;
    if (failure === null && decision?.action === "pass" && task.status === "IN_REVIEW") {
      const producer = deps.lastProducer(task.id);
      const key = "same-family-review:" + (producer ?? "?") + "->" + task.role;
      sameFamilyKey = key;
      review = reviewGate({
        producerRole: producer,
        reviewerRole: task.role,
        producerFamily: deps.modelFamily(producer ?? ""),
        reviewerFamily: deps.modelFamily(task.role),
        approvedByCeo: deps.ceoApproved(task.id, key),
      });
    }

    // ── 门 1：状态机（跃迁合法性在【写入之前】判）──────────────────────
    const plan = planEdge({
      status: task.status,
      role: task.role,
      graph,
      decision,
      handoffTo,
      blockedHandoff,
      review,
      ceoRoleId: ceo,
      failure,
    });

    // 需要建卡的两类拦截（越权交接 / 同源审阅）。判在事务外，写在里面。
    //
    // 不是一张 NewCardDraft[] 而是带【归因】的一条：unauthorized_attempt 那一行要回答
    // 「谁想干什么而机器不认」，那是【这张卡为什么存在】的信息，只有造这张卡的地方知道。
    // 用两个并行数组（drafts[i] ↔ reasons[i]）就是等一个索引错位的机会 —— 一类卡填了
    // 另一类的归因，审计那行会指着一条没发生过的越权（append-only，事后清不掉）。
    interface PendingCard {
      readonly draft: NewCardDraft;
      /**
       * 越权归因；null = 这张卡【不是】越权造成的（同源审阅），于是不写
       * unauthorized_attempt 那一行。判据是「这个动作在状态机里合法吗」，
       * 不是「有没有人被拦住」—— 后者会把系统自身的配置记成某人的违规。
       */
      readonly attempt: { readonly from: string; readonly attempted: string; readonly verdict: string } | null;
    }
    const pending: PendingCard[] = [];
    if (blockedHandoff !== null) {
      pending.push({
        draft: card({
          taskId: task.id,
          cardKey: "handoff-block:" + task.role + "->" + handoffTarget,
          summary: task.role + " 想把活儿交给 " + (handoffTarget === "" ? "（没点名）" : handoffTarget) + "，这一跳机器不认",
          impact: "组织：谁可以把活儿交给谁（§3.3 委派规则图）",
          recommendation: "先看证据里那句原因。多数情况是让 " + task.role + " 改为 wait，而不是给组织加这条汇报关系。",
          evidence: "dispatch:" + task.id + ":" + task.role + "->" + handoffTarget,
        }),
        attempt: { from: task.role, attempted: "handoff->" + handoffTarget, verdict: blockedHandoff },
      });
    }
    if (review !== null && !review.ok && sameFamilyKey !== null) {
      pending.push({
        draft: card({
          taskId: task.id,
          cardKey: sameFamilyKey,
          summary: "一次审阅卡在「审的人和生产的人同源」上，需要你批准是否接受",
          impact: "审阅独立性：§8.2 第 1 条 / §24 风险 1",
          recommendation: "如果这台机器上目前只有这一个模型家族，批准等于接受「同源审阅」这个已知弱点；不批准则要接第二个家族。",
          evidence: "dispatch:" + task.id + ":" + sameFamilyKey,
        }),
        // 【不】记 unauthorized_attempt：这一条不是「有人试图走一条不该走的边」。
        // 审阅者做的动作（pass）在状态机里完全合法，被拦下的是【它的资格】，而资格
        // 不足是系统的属性（这台机器只有一个模型家族），不是某个角色的一次越权尝试。
        // 记进去的坏处不是崩，是【按 action 统计越权】这个数被系统自身的配置长期污染，
        // 而 §4.5 讲防滥用时读的正是那个数。
        attempt: null,
      });
    }

    // 本轮写下的每一条 (事件, seq)，提交成功之后逐条广播。
    // 【收集而不是边写边发】是必须的：回滚的那些行从来没存在过，广播出去就是让前端
    // 显示一条数据库里不存在的状态变化（recorder 文件头同一条 §5.8 纪律：events 是
    // 事实源，事件流只是投影）。
    const outgoing: { event: DomainEvent; seq: number }[] = [];
    const wrote = await deps.writer.node(() => {
      const db = requireScopeDb("dispatch.write");
      let stateEventSeq: number | null = null;
      // 落库后的最终状态：不跃迁时就是原状态，跃迁时由链的最后一格决定（含自动那一格）。
      let finalStatus: TaskState = task.status;

      if (plan.move) {
        // 落点之后可能还要自动走一格（AUTO_AFTER_EDGE）。先算出来，两条边一起判：
        // 只写第一格会让任务停在 EVIDENCE_SUBMITTED —— 那一格【没有 agent 出边】
        // （seatOf 判成 human 席位），于是下一轮 dispatch 直接拒绝开口，
        // 而 CEO 的收件箱里也没有一张等着点开的卡：任务不是等人，是【没人接着干】。
        // 这一格本身没有判断（§7.1 从它出发只有一个出口），所以由 hub 走；
        // 真正的显式决定在下一格的审阅者那里（§8.2 第 3 条）。
        const chain: readonly { readonly to: TaskState; readonly note: string }[] = [
          { to: plan.to, note: plan.note },
          ...(AUTO_AFTER_EDGE[plan.to] === undefined
            ? []
            : [
                {
                  to: assertTaskTransition(plan.to, AUTO_AFTER_EDGE[plan.to] as TaskState),
                  note: "产出已进入 " + plan.role + " 的审阅队列（§7.1 从 " + plan.to + " 只有一个出口，不需要判断）",
                },
              ]),
        ];
        let from: TaskState = task.status;
        let legNo = 0;
        for (const leg of chain) {
          // 账单只挂第一条边：一轮执行一次花钱，自动那一格没跑 agent。
          // 每格都挂就是把同一笔钱记两次 —— 而 tasks.consumed_cents 这一列
          // 没有幂等键可救（budgets 那侧靠 source_event 挡重复，这列挡不住）。
          const centsForLeg = legNo === 0 ? outcome.costCents : 0;
          legNo += 1;
          // 广播的是 §5.8 那六行表里的【线上传输形状】（kind/taskId/from/to），
          // 落库的 payload 是它的【超集】（多一条 summary）。这两者刻意不等价：
          // 线上那个形状被 web 投影与 SSE 契约吃死了，加一个键等于改契约；
          // 而回放（读 events.payload）要的恰好是那句人话理由。
          const evt: DomainEvent = { kind: "TaskStateChanged", taskId: task.id, from, to: leg.to };
          stateEventSeq = appendAudit(
            db,
            {
              taskId: task.id,
              actorType: "agent",
              actorId: task.role,
              action: "state_change",
              target: leg.to,
              payload: {
                ...evt,
                summary: leg.note,
                // 产出方那一格：IN_REVIEW 判独立性要审的是【谁的】产出（见 planEdge）
                ...(leg.to !== "EVIDENCE_SUBMITTED" || plan.producerRole === undefined
                  ? {}
                  : { producerRole: plan.producerRole }),
              },
            },
            () => o.nowMs,
          );
          outgoing.push({ event: evt, seq: stateEventSeq });
          const params: unknown[] = [
            leg.to,
            // current_node 在引擎路线上写的是【负责这个角色】。它原本装的是图节点名，
            // 而 engine/ 没有图节点这个概念了 —— 这一列语义变更是引擎换路线的连带后果，
            // 记在 0041（下游 taskViewSchema.current_node 的读者要跟着改口径）。
            plan.role,
            plan.role,
            centsForLeg,
            o.nowMs,
            task.id,
            from,
          ];
          const info = db.prepare(WRITE_EDGE_SQL).run(...(params as never[])) as { changes: number | bigint };
          if (Number(info.changes) !== 1) {
            // 抛 = 整笔回滚（含前面那条 events）。这里的静默分支是「界面显示动了而库里没动」。
            throw new Error(
              "状态边写入被守卫拦下：任务 [" + task.id + "] 的状态在写 " + from + " → " + leg.to +
                " 时已不是 " + from + "（UPDATE 带 AND status=? 守卫，实到 changes=" + Number(info.changes) + "）。" +
                "本轮基于过期认知，整笔回滚；账单同样不记，否则下一次重试像为同一轮又付一遍。",
            );
          }
          from = leg.to;
        }
        finalStatus = from;
      } else {
        // 没跃迁也要留一行审计说明【为什么没动】——「任务停着」在回放里必须能答出
        // 是哪一轮、为什么。这一行走【RoleTurnReported】那个第 9 个 kind，而不是自己
        // 拼一个 payload.kind="turn-no-edge"：两者留下的 seq 一模一样，而后者不属于
        // DomainEvent，没人能广播它 ⇒ 每一轮 wait / 每一次失败都给活着的 SSE 连接
        // 挖一个空洞（kind 的选型理由、为什么不复用 TaskStateChanged、为什么 action
        // 取 tool_call 而不加第 11 个枚举值，都写在 events/bus.ts）。
        const evt: DomainEvent = {
          kind: "RoleTurnReported",
          taskId: task.id,
          role: task.role,
          state: task.status,
          note: plan.note,
          costCents: outcome.costCents,
        };
        stateEventSeq = appendAudit(
          db,
          {
            taskId: task.id,
            actorType: "agent",
            actorId: task.role,
            // 从 KIND_TO_ACTION 取值而不是在这里再写一遍 "tool_call"：写死等于本模块
            // 另存一份 kind→action 映射，改 recorder 那张表时这里静默漂移
            // （与 cli.ts 读轨迹时同源取值那条理由一致）。
            action: KIND_TO_ACTION.RoleTurnReported,
            target: task.role,
            payload: { ...evt },
          },
          () => o.nowMs,
        );
        outgoing.push({ event: evt, seq: stateEventSeq });
        db.prepare(LEDGER_SQL).run(...([outcome.costCents, o.nowMs, task.id] as never[]));
      }

      // 记账钩子每轮【至多一次】，seq 取本轮最后写下的那条 events.id —— 它是本轮事务
      // 里真实存在的行，正好当 BudgetTracker 的幂等键（重复调用被 source_event 挡下）。
      // 不跃迁那一支同样要调，所以这一发留在 if/else 之外 —— 放进两支里各写一次，
      // 漏的那一支恰好是「失败轮」或「wait 轮」，正是最该看到账的那两支。
      if (deps.onCost !== undefined && outcome.costCents > 0 && stateEventSeq !== null) {
        deps.onCost({
          db,
          taskId: task.id,
          role: task.role,
          seq: stateEventSeq,
          costCents: outcome.costCents,
          nowMs: o.nowMs,
        });
      }

      let cardEvent: ApprovalRequiredEvent | null = null;
      /**
       * 越权尝试那一行。【与卡片那一行分开】：两者回答不同问题（「有件事要批」vs
       * 「有人试图走一条不该走的边」），合成一行的话按 action 统计越权尝试永远为 0，
       * 而那个数是 §4.5 防滥用那一半要读的东西。
       *
       * 拆成闭包是因为它【不能被卡片的去重结果挡住】（见下面调用点那条注释），
       * 而两处各写一份 appendAudit 就是等着一处改漂移另一处。
       *
       * 广播时借【RoleTurnReported】而不是留空洞：这一行没有自己的 DomainEvent kind
       * （§5.8 那张表里没有「越权尝试」这一类），而 appendAudit 已经消费了它的 seq，
       * 不送出去就是在活着的 SSE 连接上挖一个洞（0010 §4）。借它成立是因为语义吻合
       * —— 某个角色跑了一轮而状态没动。payload 是事件的【超集】（多带 attempted/verdict），
       * 与本文件状态边那一格「线上形状窄、回放 payload 宽」同一取向。
       * cardId 传 null 时 target 落在角色名上：那一行不再指向某一张卡（它是「撞过一张
       * 已存在的卡」），而把【上一次】那张卡的 id 填进来会让审计指认一次没发生过的批准请求。
       */
      const writeAttempt = (
        a: { readonly from: string; readonly attempted: string; readonly verdict: string },
        cardId: string | null,
      ): void => {
        const evt: DomainEvent = {
          kind: "RoleTurnReported",
          taskId: task.id,
          role: a.from,
          state: task.status,
          note: "越权尝试被拦 [" + a.attempted + "]：" + a.verdict,
          // 0 而不是 outcome.costCents：本轮的账已经挂在状态行 / 本轮那一行上，
          // 这里再写一遍就是同一轮记两次钱（本文件 centsForLeg 那条同源的理由）。
          costCents: 0,
        };
        const seq = appendAudit(
          db,
          {
            taskId: task.id,
            actorType: "agent",
            actorId: a.from,
            action: "unauthorized_attempt",
            target: cardId ?? a.from,
            payload: { ...evt, attempted: a.attempted, verdict: a.verdict },
          },
          () => o.nowMs,
        );
        outgoing.push({ event: evt, seq });
      };

      for (const p of pending) {
        const res = insertCard(db, p.draft, { nowMs: o.nowMs });
        if (!res.created) {
          // 撞去重键 ⇒ 这件事【已经有一张待批的卡】，所以不写 ApprovalRequired：
          // 写一条就等于在审计里说「这里又发生了一次需要批准」，而没发生；
          // 更要紧的是它会广播出去，把 CEO 收件箱的角标 +2（一张卡算成两张）。
          //
          // 但【越权那一行照写】。去重键管的是【卡片】不要重复，不是【尝试】不要重复：
          // 撞键这个事实本身就是又一次越权尝试，不写就变成「一个角色每分钟试一次同一条
          // 非法边，整本账只留下一次」，而 §4.5 那个数问的正是【试了几次】。
          //
          // target 传 null（于是落在角色名上）而不是去 SELECT 出【上次那张卡】的 id：
          // 那一次批准请求并没有因为本轮这次尝试而发出，把旧卡的 id 填进来会让审计
          // 指认一次没发生过的批准请求。「撞的是哪条边」在 payload.attempted 里，
          // 与卡片键同源（本文件 cardKey 的构造），不需要靠 id 那一列去猜。
          if (p.attempt !== null) writeAttempt(p.attempt, null);
          continue;
        }
        // 事件与 payload 都走 cards.ts 的 approvalRequiredEvent / createCard 同一条构造路径，
        // 不在这里手搓一份：手搓的那份在 bus.ts 给 ApprovalRequired 加键时会【编译照过、
        // 事件少一键】（cards.ts:391 那段就是为这件事写的）。
        const evt = approvalRequiredEvent(task.id, res.approvalId, p.draft, p.draft.approvalType);
        cardEvent = evt;
        const cardSeq = appendAudit(
          db,
          {
            taskId: task.id,
            // 署名 system/hub 而不是那个被拦下的角色：卡片是【系统提出的一次请求】，
            // 不是任何人的决定（createCard 同一条理由 —— 署人名会污染「这条是谁做的」
            // 那一列，而它是 role-memory 的分桶依据）。
            actorType: "system",
            actorId: "hub",
            // 'approval'（= KIND_TO_ACTION.ApprovalRequired），【不是】unauthorized_attempt：
            // 这一行记的事实是「有一件事等着批」，与 createCard / 巡检 / http 那条同值。
            // 之前这里写成 unauthorized_attempt，后果是【库里同一类事实有两种 action】，
            // 于是任何按 action='approval' 数待批事项的读法都少算引擎那一类，
            // 而 role-memory 也永远看不到引擎建的卡（它只捞 approval）。
            action: KIND_TO_ACTION.ApprovalRequired,
            target: res.approvalId,
            /**
             * payload 存 evt.payload（内层那份 {kind, approval_type, summary, evidence_refs}），
             * 【不是】{...evt}。理由不是风格：createCard（http / 巡检 / 远程那条路建卡时
             * 走的就是它）落的正是内层那一份，而 cards.test.ts:438 把
             * payload["approval_type"] / payload["summary"] 钉在【顶层】。
             * 这里从前写 {...evt}，于是同一张 action='approval' 的审计行在库里【有两种形状】
             * —— 按 approval_type 数待批事项的读法会漏掉引擎建的那一类。这个分叉由
             * engine/charter.test.ts 那条「从审计行里取 evidence_refs」的用例暴露：
             * 它照着 createCard 的口径读，读引擎自己的卡片读不到（我第一版 charter.ts
             * 抄的是这里，于是同一发测试把两处一起抓出来了）。
             * kind 那一格两种写法都带着，所以 role-memory 那个 payload.kind 判别式
             * 此前一直【看起来是对的】—— 这正是最难查的那类分叉：共用的那部分掩盖了
             * 不共用的那部分。
             *
             * 顺带一条【写法】上的：这里直接给 evt.payload 而不是 {...evt.payload} ——
             * DomainEvent 里 ApprovalRequired.payload 声明成 unknown（bus.ts），
             * 展开 unknown 是编译错 TS2698，而这份对象从构造到落库只读，不需要拷贝。
             */
            payload: evt.payload,
          },
          () => o.nowMs,
        );
        outgoing.push({ event: evt, seq: cardSeq });
        if (p.attempt !== null) writeAttempt(p.attempt, res.approvalId);
      }
      return { stateEventSeq, cardEvent, finalStatus };
    });

    // 提交成功之后才广播：回滚的话 outgoing 里那些行根本没存在过（§5.8）。
    // 逐条而不是挑一条：outgoing 是本轮【消费了 seq 的全部行】，漏一条就是一个空洞。
    for (const out of outgoing) deps.publish(out.event, out.seq);

    return {
      taskId: task.id,
      status: wrote.finalStatus,
      role: plan.role,
      moved: plan.move,
      seat: "agent",
      note: plan.note,
      costCents: outcome.costCents,
      sessionId: outcome.sessionId,
      stateEventSeq: wrote.stateEventSeq,
      card: wrote.cardEvent,
    };
  };
}
