/**
 * 升级路由（计划 Task 1.4，规格 §8.3、§9.2）。
 *
 * 一句话职责：判【这件事该不该升到 CEO】，并把它整理成一张 §9.2 形状的审批卡片。
 *
 * 为什么这件事要独立成模块，而不是散在各个节点里各写一句「这里升级」：
 * §8.3 那句「CEO 看到的每一件事都是真正需要 CEO 的事」是一个【全局】性质 ——
 * 散写必然导致两类病：该升的没升（节点作者不知道有这条触发条件），以及不该升的狂升
 * （每个节点都怕背锅而上交）。集中判定 + 固定卡片形状，才谈得上统计「本周升了多少、
 * 各因为什么」，也才谈得上把量压下去。
 *
 * 【纯函数，不写库】。理由与 gates/evaluate.ts 同源：升级判定必须可穷尽测试，
 * 而写库会引入事务归属问题（升级往往发生在超步中间，事务责任方已经存在）。
 * 落库（approvals 那一行 + ESCALATED_TO_CEO 状态边）由调用方在同事务内做。
 */

import {
  type ApprovalCardDraft,
  type EscalationReason,
  ESCALATION_REASONS,
  type RiskTier,
} from "@opc/contracts";
import { legalTransitionsFrom, type TaskState } from "../status.js";

/** 触发条件之一：层级审阅轮次上限（§8.3 第一条，默认 3）。 */
export const REVIEW_CONFLICT_LIMIT = 3;

/**
 * 升级判定的输入。
 *
 * 字段【缺省 = 该条不成立】，这与 gates/evaluate.ts 的「判不了不默认放行」看着相反，
 * 其实是两件事：那里缺的是【产出该不该过】的证据，这里缺的是【有没有这回事】。
 * 一个没声明风险分级的动作不会因此升级 CEO，但它同样不会因此被放行 —— 上游
 * policy/engine.ts 在未知时判 irreversible（fail-closed），到这里的已经是「该升的」。
 * 也就是说 fail-closed 落在分级那一层，而不是每一层都各自猜一遍。
 */
export interface EscalationState {
  readonly taskId: string;
  readonly state: TaskState;
  readonly reviewRoundNo?: number;
  /** 本次涉及动作的风险分级（policy/engine 的产出）。 */
  readonly riskTier?: RiskTier;
  /** 已消费 / 上限，单位美分。 */
  readonly spentCents?: number;
  readonly limitCents?: number;
  /** 本次动作是否落在角色 decision_scope 的 requiresConsultation / forbidden 里。 */
  readonly outsideDecisionScope?: boolean;
  /** 产出方的自评置信度 0..1。缺 = 未声明。 */
  readonly confidence?: number;
  /** 置信度下限（低于它算「证据不足」）。 */
  readonly confidenceFloor?: number;
  /**
   * 门控没能判定的标准条数（evaluateGate 返回的 unresolved.length）。
   * > 0 触发 insufficient_evidence。
   *
   * 为什么单开一维而不是复用 confidence：confidence 是【产出方自己说】没把握，
   * 这一维是【门控按客观标准判不出】。前者的信息源是被约束者，后者是门控自己 ——
   * 合成一维就会允许「自报信心满满」把「三条标准没证据」盖掉，那是让被约束者
   * 否决门控的判定（§8.2 的立场正相反）。
   */
  readonly unresolvedCriteriaCount?: number;
}

export type EscalationResult =
  | { escalate: false }
  | {
      escalate: true;
      reason: EscalationReason;
      card: ApprovalCardDraft;
      /** 一并命中的其它原因（卡片摘要里要说全，否则 CEO 只看到一条理由）。 */
      also: EscalationReason[];
    };

/** §9.2 第二行要求的超时行为归属：不可逆 ⇒ auto_reject，可逆 ⇒ escalate。 */
export function timeoutFor(irreversible: boolean): "auto_reject" | "escalate" {
  // 刻意【不返回 auto_approve】。规格 §9.3 允许它对可逆事项超时默认通过，但那是
  // Task 3.5「模式自动批准」的能力范围（要先有历史模式），Phase 1 就给这个值，
  // 等于在没有数据时就允许机器替 CEO 点头 —— §12.8 记的正是这类冲突。
  return irreversible ? "auto_reject" : "escalate";
}

/** 原因 → 一行摘要（§9.2 第一行）。措辞要能让人不看详情也知道在问什么。 */
const SUMMARY: Readonly<Record<EscalationReason, string>> = {
  review_conflict_rounds_exceeded:
    "层级审阅多轮未达成一致，需要你裁决（继续投入还是砍掉）",
  irreversible_action: "有一个不可逆动作等着执行，只有你能批准",
  budget_threshold: "预算已触顶，继续要额外额度",
  outside_decision_scope: "这件事超出该角色的授权范围，需要你或总监层定",
  insufficient_evidence: "产出的证据不足以判定，需要人工看一眼",
  low_confidence: "产出方自报置信度过低，结论可能不成立",
};

function reasons(s: EscalationState): EscalationReason[] {
  const hit: EscalationReason[] = [];
  if (s.reviewRoundNo !== undefined && s.reviewRoundNo >= REVIEW_CONFLICT_LIMIT) {
    hit.push("review_conflict_rounds_exceeded");
  }
  if (s.riskTier === "irreversible") hit.push("irreversible_action");
  if (
    s.spentCents !== undefined &&
    s.limitCents !== undefined &&
    s.spentCents > s.limitCents
  ) {
    hit.push("budget_threshold");
  }
  if (s.outsideDecisionScope === true) hit.push("outside_decision_scope");
  if (s.unresolvedCriteriaCount !== undefined && s.unresolvedCriteriaCount > 0) {
    hit.push("insufficient_evidence");
  }
  const floor = s.confidenceFloor ?? 0.4;
  // 置信度【缺省不算低】，但也不能当高：缺省不触发本条，交由证据维（上面那条）去拦。
  // 触发条件是【自报了且低于下限】。
  if (s.confidence !== undefined && s.confidence < floor) hit.push("low_confidence");
  // 顺序即优先级：不可逆 > 预算 > 范围 > 证据 > 轮次 > 置信度。
  const order: EscalationReason[] = [
    "irreversible_action",
    "budget_threshold",
    "outside_decision_scope",
    "insufficient_evidence",
    "review_conflict_rounds_exceeded",
    "low_confidence",
  ];
  return hit
    .filter((r, i) => hit.indexOf(r) === i)
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/**
 * 判定 + 起草卡片。
 *
 * 卡片摘要带上【数字】而不是只说「超预算」：CEO 在收件箱里要在几秒内决定，
 * 「花了 12340 / 上限 10000 美分」是可决策的信息，「超出预算」不是。
 */
export function decideEscalation(s: EscalationState): EscalationResult {
  const all = reasons(s);
  if (all.length === 0) return { escalate: false };
  const primary = all[0] as EscalationReason;
  const irreversible = s.riskTier === "irreversible";

  const parts: string[] = [SUMMARY[primary]];
  for (const extra of all.slice(1)) parts.push(SUMMARY[extra]);
  if (primary === "budget_threshold" && s.spentCents !== undefined && s.limitCents !== undefined) {
    parts[0] += "（已用 " + s.spentCents + " / 上限 " + s.limitCents + " 美分）";
  }
  if (
    primary === "review_conflict_rounds_exceeded" &&
    s.reviewRoundNo !== undefined
  ) {
    parts[0] += "（已 " + s.reviewRoundNo + " 轮，上限 " + REVIEW_CONFLICT_LIMIT + "）";
  }
  if (primary === "low_confidence" && s.confidence !== undefined) {
    parts[0] += "（自报 " + s.confidence + "，下限 " + (s.confidenceFloor ?? 0.4) + "）";
  }
  if (
    primary === "insufficient_evidence" &&
    s.unresolvedCriteriaCount !== undefined
  ) {
    parts[0] += "（有 " + s.unresolvedCriteriaCount + " 条验收标准没能判定）";
  }

  const card: ApprovalCardDraft = {
    summary: parts.join("；"),
    parameters: {
      impact_scope: "任务 " + s.taskId + "，状态 " + s.state,
      irreversible,
      recommendation: recommendFor(primary),
      recommendation_is_not_decision: true,
      timeout_behavior: timeoutFor(irreversible),
    },
    // §9.2 第三行。这里给的是【该展开什么】的指称，不是 URL —— 审批卡片由 hub 生成，
    // 收件箱（Task 2.6）把它换成指向证据包的实链接。留一条非空引用是 schema 的硬要求，
    // 也是「卡片必须能点开看到依据」这条产品口径的机器可读形态。
    evidence_refs: ["task:" + s.taskId + "/evidence"],
    buttons: ["approve", "reject_with_comment", "defer_deep_review"],
  };
  return {
    escalate: true,
    reason: primary,
    card,
    also: all.slice(1),
  };
}

/** 推荐语一律标注「推荐，非决定」（§9.2 原文要求；ApprovalCardDraft 那个字面量字段就是它的落地）。 */
function recommendFor(r: EscalationReason): string {
  switch (r) {
    case "irreversible_action":
      return "推荐：先让开发给出可回滚的替代路径再批（推荐，非决定）";
    case "budget_threshold":
      return "推荐：按剩余价值决定追加额度，或把任务降级为小范围验证（推荐，非决定）";
    case "outside_decision_scope":
      return "推荐：先交总监层判断，只有战略分歧才由你拍（推荐，非决定）";
    case "review_conflict_rounds_exceeded":
      return "推荐：改开一次辩论会而不是直接裁决，冲突点本身可能有价值（推荐，非决定）";
    case "low_confidence":
      return "推荐：打回并要求补证据，不要在此刻硬判（推荐，非决定）";
    case "insufficient_evidence":
      return "推荐：打回补证据包（推荐，非决定）";
  }
}

/**
 * 升级在状态机上是否可走。
 *
 * 为什么要单独暴露：升级【不是】总能发的。§7.1 里 ESCALATED_TO_CEO 只从 IN_REVIEW
 * 与 APPROVED_UPWARD 进入（后者是本仓的补边）。节点若在 DECOMPOSING 里就想升级，
 * 硬写会造出一条非法状态边 —— 而 events 是 append-only，那条非法跃迁写下去就永远
 * 在审计里，回放照它重建出一个从未合法发生的过程（graph/status.ts 的文件头讲的正是这个）。
 *
 * 所以这里判【当前状态能不能升到 CEO】，判不了的时候调用方要先走到能升的状态，
 * 或者把这次当作 reject 处理 —— 而不是写一条非法边。
 */
export function canEscalateFrom(state: TaskState): boolean {
  return legalTransitionsFrom(state).includes("ESCALATED_TO_CEO");
}

/** 已知原因清单的再导出：卡片 UI 与统计都从这一处取，避免两处各写一份枚举。 */
export const KNOWN_ESCALATION_REASONS: readonly EscalationReason[] =
  ESCALATION_REASONS;
