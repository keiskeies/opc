/**
 * 岗位书（Role Charter）契约 —— 规格 §3.2 的 zod 4 实现（规格 §5.11：zod 4 是岗位书、
 * 证据包、审批卡片的【唯一 schema 来源】）。
 *
 * 三条不可让的设计约束，都不是风格偏好：
 *
 * 1. **strict**：未知键一律拒绝。岗位书会被 CEO 在配置页手改，拼错的字段名（model_tier_typo）
 *    若被静默忽略，那条约束就等于没写 —— 而它的存在正是为了让「产出华丽但不合规」不再发生。
 * 2. **honesty_boundaries / version 必填**：规格附录 B.1 的样例里【没有】这两个字段，但计划
 *    Task 0.7 明确要求缺失即拒绝加载。§14.4 红线二要求 skill 必须声明诚实边界，本 schema 把
 *    同一要求延伸到角色层。version 则支撑 §3.2 的版本化规则（运行中的任务保持创建时版本）。
 * 3. **escalate 必须带 target**：没有目标的升级会静默丢掉 —— 这是 §4.2.2「升级权」最容易被
 *    写坏的地方。
 */
import { z } from "zod";

/** Task 0.9 的 CI 红灯靠它：模板里的验收标准若仍是这个串，说明 CEO 还没签字。 */
export const CHARTER_PLACEHOLDER_ACCEPTANCE = "CEO-PLACEHOLDER-ACCEPTANCE";

/** §5.9 三档：management（CEO/助理/总监层）与 execution（开发/测试/运营）。 */
export const MODEL_TIERS = ["management", "execution"] as const;

/**
 * 档位的类型形态。派生自 MODEL_TIERS —— 常量和类型若各写一份，
 * 加档位时最先漂移的一定是类型（z.infer 出来的字段会变成 string，校验静默失效）。
 */
export type ModelTier = (typeof MODEL_TIERS)[number];

/**
 * acceptance_criteria 的动作只有 reject | escalate —— 规格里 action 还出现过
 * create_approval_card / pause_and_escalate / create_decision_meeting，但那属于
 * escalation_triggers（§4.2.2），是另一个字段，不能混进来当本字段的合法值。
 */
export const ACCEPTANCE_ACTIONS = ["reject", "escalate"] as const;

/** §4 的判断模式。 */
export const JUDGMENT_MODES = [
  "strict_rules",
  "bounded_judgment",
  "full_discretion",
] as const;

/**
 * 【规格】附录 B.3 给技术总监那一份里写的 `search_policy`（§13.3）。
 *
 * ⚠ **只认 `tier_1_mandatory` 这一个键**，而这不是漏写。B.3 原文还有
 * `tier_2_conditional` 与 `tier_3_budget_downgrade_ratio`，本 schema 刻意不收：
 *   · 第 2 层的判断是**每次任务**由 Agent 显式表态的（`SearchPolicyInput.judgment`），
 *     不是一格静态开关，收成 boolean 会得到一个「配了而没人读」的键；
 *   · 第 3 层的阈值是**每次调用注入**的（`searchBudgetTier` 的 `thresholds`，
 *     理由在它函数头：规格没说那个比例是多少），把它挪进 YAML 等于允许
 *     「谁改一行 YAML」调整一次运行期的成本闸，而那一格的口径是「不由被约束方现填」。
 * 一个**没有消费方**的可选字段与一张有码而无返回点的码表是同一种装饰（本仓删过一次那种码表），
 * 所以等事前那一遍真接上时再一起加，那时它才有读者。这一格记在 0033 §4。
 *
 * `tier_1_mandatory` 也不在这里校验取值（不比对那四个领域名）：
 * 那是 `unknown_mandatory_domain` 的活，而它该在**门控那一刻**报 ——
 * 那时报错才有人看得到 message。加载期拒掉会把「写岗位书的人」与「看到报错的人」分开。
 *
 * 【规格】B.3 那四个名字（`framework_version_compat` / `api_deprecation` /
 * `security_advisory` / `benchmark`）与本层 `FAST_CHANGING_DOMAINS` **交集为空**，
 * 所以照抄进 YAML 的后果是每次门控直接打回而不是「拦住了一次不该拦的搜索」
 * （那条 criteria 的 action 是 reject）。细节与判后处置在 0033 §2。
 */
const searchPolicySchema = z
  .object({
    tier_1_mandatory: z.array(z.string().min(1)).optional(),
  })
  .strict();

/** §4.2.2：升级触发条件在规格里出现【两种形状】—— 附录 B.1 用裸字符串，§4.2.2 用对象。
 *  两种都是合法写法，故 union；只认一种会让合法模板加载失败。 */
const escalationTriggerSchema = z.union([
  z.string().min(1),
  z
    .object({
      condition: z.string().min(1),
      target: z.string().min(1),
      action: z.string().min(1),
    })
    .strict(),
]);

const acceptanceCriterionSchema = z
  .object({
    condition: z.string().min(1),
    action: z.enum(ACCEPTANCE_ACTIONS),
    /** escalate 没有 target 就是「升级给空气」：静默丢掉。 */
    target: z.string().min(1).optional(),
    message: z.string().min(1),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.action === "escalate" && c.target === undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "action=escalate 必须给出 target（§4.2.2 升级权：要写明升到哪一层）",
        path: ["target"],
      });
    }
  });

const charterInput = z
  .object({
    role_id: z.string().min(1),
    display_name: z.string().min(1),
    version: z.number().int().positive(),
    reports_to: z.string().min(1).nullable().optional(),
    honesty_boundaries: z.array(z.string().min(1)).min(1),
    cognitive_skill: z.string().min(1).optional(),
    acceptance_criteria: z.array(acceptanceCriterionSchema).min(1),
    forbidden_actions: z.array(z.string().min(1)),
    tool_permissions: z.array(z.string().min(1)),
    model_tier: z.enum(MODEL_TIERS),
    budget: z
      .object({
        daily_usd: z.number().nonnegative(),
        per_task_usd: z.number().nonnegative(),
      })
      .strict(),
    budget_discretion: z
      .object({
        daily_usd: z.number().nonnegative(),
        can_reallocate_within_role: z.boolean(),
        cannot_exceed: z.boolean(),
      })
      .strict()
      .optional(),
    escalation_triggers: z.array(escalationTriggerSchema),
    decision_scope: z
      .object({
        autonomous: z.array(z.string().min(1)),
        requires_consultation: z.array(z.string().min(1)),
        forbidden: z.array(z.string().min(1)),
      })
      .strict(),
    judgment_mode: z
      .object({
        type: z.enum(JUDGMENT_MODES),
        strict_rules: z.array(z.string().min(1)),
        bounded_judgment: z.array(z.string().min(1)),
        full_discretion: z.array(z.string().min(1)),
      })
      .strict(),
    dissent_rights: z
      .object({
        can_challenge: z.array(z.string().min(1)),
        cannot_challenge: z.array(z.string().min(1)),
        escalation_path: z.string().min(1),
      })
      .strict()
      .optional(),
    stance: z.string().min(1).optional(),
    untrusted_inputs: z.array(z.string().min(1)).optional(),
    /** §13.3 第 1 层那一半的岗位书侧（为什么只有一键见 searchPolicySchema 上面那段）。 */
    search_policy: searchPolicySchema.optional(),
    harness_defaults: z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .optional(),
  })
  .strict();

/** 校验后的岗位书：snake_case → camelCase 的映射【写在 transform 里】，所以字段只有一处定义。 */
export const charterSchema = charterInput.transform((c) => ({
  roleId: c.role_id,
  displayName: c.display_name,
  version: c.version,
  reportsTo: c.reports_to ?? null,
  honestyBoundaries: c.honesty_boundaries,
  cognitiveSkill: c.cognitive_skill,
  acceptanceCriteria: c.acceptance_criteria.map((a) => ({
    condition: a.condition,
    action: a.action,
    target: a.target,
    message: a.message,
  })),
  forbiddenActions: c.forbidden_actions,
  toolPermissions: c.tool_permissions,
  modelTier: c.model_tier,
  budget: { dailyUsd: c.budget.daily_usd, perTaskUsd: c.budget.per_task_usd },
  budgetDiscretion: c.budget_discretion
    ? {
        dailyUsd: c.budget_discretion.daily_usd,
        canReallocateWithinRole: c.budget_discretion.can_reallocate_within_role,
        cannotExceed: c.budget_discretion.cannot_exceed,
      }
    : undefined,
  escalationTriggers: c.escalation_triggers,
  decisionScope: {
    autonomous: c.decision_scope.autonomous,
    requiresConsultation: c.decision_scope.requires_consultation,
    forbidden: c.decision_scope.forbidden,
  },
  judgmentMode: {
    type: c.judgment_mode.type,
    strictRules: c.judgment_mode.strict_rules,
    boundedJudgment: c.judgment_mode.bounded_judgment,
    fullDiscretion: c.judgment_mode.full_discretion,
  },
  dissentRights: c.dissent_rights
    ? {
        canChallenge: c.dissent_rights.can_challenge,
        cannotChallenge: c.dissent_rights.cannot_challenge,
        escalationPath: c.dissent_rights.escalation_path,
      }
    : undefined,
  stance: c.stance,
  untrustedInputs: c.untrusted_inputs,
  // 与 budgetDiscretion / dissentRights 同一个形状（缺省 ⇒ undefined，不编一个空对象）：
  // 「这个角色的岗位书没说过搜索」与「它说过而领域为空」在回放里必须分得开，
  // 后者是一个 CEO 决策（他看过那一栏并留空），前者只是还没写过。
  searchPolicy: c.search_policy
    ? { mandatoryDomains: c.search_policy.tier_1_mandatory ?? [] }
    : undefined,
  harnessDefaults: c.harness_defaults,
}));

export type Charter = z.infer<typeof charterSchema>;
export type CharterInput = z.input<typeof charterInput>;
