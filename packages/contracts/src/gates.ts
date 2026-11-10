/**
 * 审阅门控与策略引擎的契约（计划 Task 1.2 / 1.4 / 1.5，规格 §8、§9）。
 *
 * 为什么判定结果要分成三种 decision 而不是一个布尔：规格 §8.2 第 3 条要求审阅者能做
 * 「通过 / 打回 / 升级」三种显式决定。二值化会把「升级」压进「打回」，CEO 收件箱
 * 就再也收不到本该到它面前的事 —— 而规格 §9 开头的北极星指标（八成审批由规则自动决定）
 * 依赖「哪些事被升级」是可统计的。
 *
 * 本模块【只有类型与常量，没有判定逻辑】：判定的唯一实现在 packages/hub/src/graph/gates/。
 * 这里放类型的理由是 review_gates 表与审批卡片都要在 hub 之外被读到（Phase 2 的桌面端），
 * 而 packages/contracts 是三端共用的唯一契约层（规格 §5.11）。
 */
import { z } from "zod";

/** 门控的三种决定，逐字对齐 §8.2 第 3 条。 */
export const GATE_DECISIONS = ["pass", "reject", "escalate"] as const;
export type GateDecision = (typeof GATE_DECISIONS)[number];

/**
 * 升级原因（§8.3 的四条触发条件，外加规格 §9.1 的预算阈值突破与两条证据类原因）。
 *
 * 枚举而非自由文本：CEO 收件箱要按原因排序与统计（「今天有多少是因为不可逆动作上来的」），
 * 自由文本做不了这件事，而且会让「同一原因」写成五种写法。
 */
export const ESCALATION_REASONS = [
  "review_conflict_rounds_exceeded",
  "irreversible_action",
  "budget_threshold",
  "outside_decision_scope",
  "insufficient_evidence",
  "low_confidence",
] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number];

/** §9.1 三级分类。 */
export const RISK_TIERS = ["read_only", "reversible", "irreversible"] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

/** §9.3 超时行为三值。 */
export const TIMEOUT_BEHAVIORS = [
  "auto_approve",
  "auto_reject",
  "escalate",
] as const;
export type TimeoutBehavior = (typeof TIMEOUT_BEHAVIORS)[number];

/**
 * §9.2 那三个按钮的【唯一来源】。
 *
 * 写成常量而不是内联在 schema 里，是为了让「第四个按钮」成为一个显式的、必然被 review
 * 到的改动：它同时改到数组与下面的 .length(3)，任何一处漏改都编译不过或校验不过。
 * 「一键全批」这类按钮一旦出现，§8.2 第 4 条的「不可绕过」就被自己的 UI 绕过了，
 * 所以这里用 .length(3) 把数量也钉住，而不是只钉取值。
 */
export const APPROVAL_BUTTONS = [
  "approve",
  "reject_with_comment",
  "defer_deep_review",
] as const;
export type ApprovalButton = (typeof APPROVAL_BUTTONS)[number];

/**
 * 审批卡片（§9.2「三行固定 + 三按钮」）的输入形状。
 *
 * zod 在这里的价值不是「校验格式」，而是把 §9.2 的结构约束变成可执行的：
 * 三行【必须都在】（少一行卡片就缺信息），按钮【只有三个】（见 APPROVAL_BUTTONS 的注释）。
 */
export const approvalCardDraftSchema = z
  .object({
    /** 第一行：一行决策摘要。 */
    summary: z.string().min(1),
    /** 第二行：关键参数快照。金额用整数美分（规格 §6.1 禁浮点）。 */
    parameters: z
      .object({
        amount_cents: z.number().int().nonnegative().optional(),
        impact_scope: z.string().min(1),
        irreversible: z.boolean(),
        /** 推荐动作与理由。规格 §9.2 第二行原文要求这一栏「明确标注『推荐，非决定』」，
         *  所以下面那个标志位是 literal(true)：漏标不是风格问题，是让 CEO 把推荐
         *  读成结论 —— 用一个编译期就过不去的字段来表达，比靠 code review 看牢。 */
        recommendation: z.string().min(1),
        recommendation_is_not_decision: z.literal(true),
        timeout_behavior: z.enum(TIMEOUT_BEHAVIORS),
      })
      .strict(),
    /** 第三行：证据链接（点开是完整证据包）。 */
    evidence_refs: z.array(z.string().min(1)).min(1),
    buttons: z.array(z.enum(APPROVAL_BUTTONS)).length(3),
  })
  .strict();

export type ApprovalCardDraft = z.infer<typeof approvalCardDraftSchema>;
