/**
 * Task 1.4 验收：五条升级触发条件 + 审批卡片形状（规格 §8.3、§9.2）。
 *
 * 为什么升级判定要集中、且要被穷尽测试：§8.3 那句「CEO 看到的每一件事都是真正
 * 需要 CEO 的事」是全局性质。散写在各个节点里必然出两类病 —— 该升的没升
 * （节点作者不知道有这条触发条件），不该升的狂升（每个节点都怕背锅而上交）。
 * 集中判定 + 固定卡片形状，才谈得上统计「这周升了多少、各因为什么」。
 */
import {
  approvalCardDraftSchema,
  ESCALATION_REASONS,
} from "@opc/contracts";
import { describe, expect, it } from "vitest";
import {
  canEscalateFrom,
  decideEscalation,
  type EscalationState,
  REVIEW_CONFLICT_LIMIT,
  timeoutFor,
} from "../../src/graph/routing/escalation.js";
import { TASK_STATES } from "../../src/graph/status.js";

const st = (over: Partial<EscalationState> = {}): EscalationState => ({
  taskId: "T-1",
  state: "IN_REVIEW",
  ...over,
});

describe("五条触发条件，各一例", () => {
  it("审阅冲突轮次达到上限 → 升级", () => {
    const r = decideEscalation(st({ reviewRoundNo: REVIEW_CONFLICT_LIMIT }));
    expect(r.escalate).toBe(true);
    if (r.escalate) expect(r.reason).toBe("review_conflict_rounds_exceeded");
  });

  it("差一轮不升级（上限是【达到即升】）", () => {
    expect(
      decideEscalation(st({ reviewRoundNo: REVIEW_CONFLICT_LIMIT - 1 }))
        .escalate,
    ).toBe(false);
  });

  it("不可逆动作 → 升级", () => {
    const r = decideEscalation(st({ riskTier: "irreversible" }));
    expect(r.escalate).toBe(true);
    if (r.escalate) expect(r.reason).toBe("irreversible_action");
  });

  it("预算越过阈值 → 升级，且摘要里带具体数字", () => {
    const r = decideEscalation(st({ spentCents: 12_340, limitCents: 10_000 }));
    expect(r.escalate).toBe(true);
    if (r.escalate) {
      expect(r.reason).toBe("budget_threshold");
      // 「超出预算」是不可决策的信息，「已用 12340 / 上限 10000」才是。
      expect(r.card.summary).toContain("12340");
      expect(r.card.summary).toContain("10000");
    }
  });

  it("刚好等于上限【不算】超预算（阈值判定是【超过】，不是【达到】）", () => {
    // 与 budget/tracker.ts 的 breached 口径一致：before <= limit && after > limit。
    // 两侧口径必须一致，否则会出现「预算侧没暂停、路由侧却在升级」的分裂。
    expect(
      decideEscalation(st({ spentCents: 10_000, limitCents: 10_000 })).escalate,
    ).toBe(false);
  });

  it("超出 decision_scope → 升级", () => {
    const r = decideEscalation(st({ outsideDecisionScope: true }));
    expect(r.escalate).toBe(true);
    if (r.escalate) expect(r.reason).toBe("outside_decision_scope");
  });

  it("自报置信度低于下限 → 升级，摘要带上自报值", () => {
    const r = decideEscalation(st({ confidence: 0.2 }));
    expect(r.escalate).toBe(true);
    if (r.escalate) {
      expect(r.reason).toBe("low_confidence");
      expect(r.card.summary).toContain("0.2");
    }
  });

  it("门控没判定的标准条数 > 0 → insufficient_evidence", () => {
    const r = decideEscalation(st({ unresolvedCriteriaCount: 2 }));
    expect(r.escalate).toBe(true);
    if (r.escalate) {
      expect(r.reason).toBe("insufficient_evidence");
      expect(r.card.summary).toContain("2");
    }
  });

  it("置信度【未声明】不算低（缺字段 ≠ 条件成立）", () => {
    expect(decideEscalation(st()).escalate).toBe(false);
    expect(decideEscalation(st({ confidenceFloor: 0.9 })).escalate).toBe(false);
  });

  it("置信度恰好等于下限 → 不升级（条件写的是【低于】）", () => {
    expect(decideEscalation(st({ confidence: 0.4 })).escalate).toBe(false);
  });
});

describe("升级判定与门控判定的分工（不让被约束者否决门控）", () => {
  it("自报高置信度盖不住「有标准没判定」这一维", () => {
    // 若合成一维，agent 只要说「我很有信心」就能把三条没证据的标准压掉 ——
    // 那是让被约束者否决门控（§8.2 的立场正相反）。
    const r = decideEscalation(
      st({ confidence: 0.99, unresolvedCriteriaCount: 3 }),
    );
    expect(r.escalate).toBe(true);
    if (r.escalate) expect(r.reason).toBe("insufficient_evidence");
  });
});

describe("优先级：多个条件同时命中时，主原因必须是最贵的那个", () => {
  it("不可逆 > 预算 > 范围 > 证据 > 轮次 > 置信度", () => {
    const r = decideEscalation(
      st({
        riskTier: "irreversible",
        spentCents: 99,
        limitCents: 1,
        outsideDecisionScope: true,
        unresolvedCriteriaCount: 1,
        reviewRoundNo: 9,
        confidence: 0.01,
      }),
    );
    expect(r.escalate).toBe(true);
    if (r.escalate) {
      expect(r.reason).toBe("irreversible_action");
      // 其余原因也要【全报】：卡片只讲一条理由时，CEO 会以为问题只有一个
      expect(r.also).toEqual([
        "budget_threshold",
        "outside_decision_scope",
        "insufficient_evidence",
        "review_conflict_rounds_exceeded",
        "low_confidence",
      ]);
      for (const extra of r.also) {
        expect(r.card.summary.length).toBeGreaterThan(0);
      }
    }
  });

  it("摘要把每个命中原因都写进去（不是只写主原因）", () => {
    const r = decideEscalation(
      st({ riskTier: "irreversible", spentCents: 200, limitCents: 100 }),
    );
    if (!r.escalate) throw new Error("本例应当升级");
    expect(r.card.summary.split("；").length).toBe(2);
  });
});

describe("审批卡片形状（§9.2 三行 + 三按钮）", () => {
  it("每条升级原因产出的卡片都过 approvalCardDraftSchema", () => {
    // 逐条枚举而不是随手挑一例：卡片形状是 CEO 每天看几十次的东西，
    // 任何一种原因漏一行（比如只有某条原因忘了填 recommendation）都得红。
    const cases: Partial<EscalationState>[] = [
      { reviewRoundNo: REVIEW_CONFLICT_LIMIT },
      { riskTier: "irreversible" },
      { spentCents: 200, limitCents: 100 },
      { outsideDecisionScope: true },
      { unresolvedCriteriaCount: 1 },
      { confidence: 0.01 },
    ];
    expect(cases.length).toBe(ESCALATION_REASONS.length);
    for (const c of cases) {
      const r = decideEscalation(st(c));
      if (!r.escalate) throw new Error("应当升级：" + JSON.stringify(c));
      const parsed = approvalCardDraftSchema.safeParse(r.card);
      expect(parsed.success, JSON.stringify(r.card)).toBe(true);
    }
  });

  it("buttons 恒为三个，且第四个按钮会被 schema 拒绝", () => {
    const r = decideEscalation(st({ riskTier: "irreversible" }));
    if (!r.escalate) throw new Error("应当升级");
    expect(r.card.buttons).toEqual([
      "approve",
      "reject_with_comment",
      "defer_deep_review",
    ]);
    // 「一键全批」这类按钮一旦出现，§8.2 第 4 条的不可绕过就被自己的 UI 绕过了
    expect(
      approvalCardDraftSchema.safeParse({
        ...r.card,
        buttons: [...r.card.buttons, "approve_all"],
      }).success,
    ).toBe(false);
  });

  it("推荐语一律标注「推荐，非决定」，且标志位必须是 true", () => {
    const r = decideEscalation(st({ outsideDecisionScope: true }));
    if (!r.escalate) throw new Error("应当升级");
    expect(r.card.parameters.recommendation).toContain("推荐，非决定");
    expect(r.card.parameters.recommendation_is_not_decision).toBe(true);
    // 漏标不是风格问题：它让 CEO 把推荐读成结论，所以 schema 用 literal(true)
    expect(
      approvalCardDraftSchema.safeParse({
        ...r.card,
        parameters: {
          ...r.card.parameters,
          recommendation_is_not_decision: false,
        },
      }).success,
    ).toBe(false);
  });

  it("evidence_refs 必须非空（卡片必须能点开看到依据）", () => {
    const r = decideEscalation(st({ riskTier: "irreversible" }));
    if (!r.escalate) throw new Error("应当升级");
    expect(r.card.evidence_refs.length).toBeGreaterThan(0);
    expect(
      approvalCardDraftSchema.safeParse({ ...r.card, evidence_refs: [] }).success,
    ).toBe(false);
  });

  it("超时行为：不可逆 ⇒ auto_reject，可逆 ⇒ escalate；永不由机器默认点头", () => {
    expect(timeoutFor(true)).toBe("auto_reject");
    expect(timeoutFor(false)).toBe("escalate");
    // §9.3 允许对可逆事项超时默认通过，但那是 Task 3.5「有历史模式之后」的能力。
    // 现在给它 auto_approve，等于在没有数据时让机器替 CEO 点头。
    expect(timeoutFor(false)).not.toBe("auto_approve");
    for (const s of [
      st({ riskTier: "irreversible" }),
      st({ outsideDecisionScope: true }),
    ]) {
      const r = decideEscalation(s);
      if (!r.escalate) throw new Error("应当升级");
      expect(
        r.card.parameters.timeout_behavior,
        JSON.stringify(s),
      ).toBe(timeoutFor(r.card.parameters.irreversible));
    }
  });

  it("卡片的 irreversible 标志跟着风险分级走（不可逆动作不许被标成可逆）", () => {
    const ir = decideEscalation(st({ riskTier: "irreversible" }));
    const re = decideEscalation(st({ riskTier: "reversible" }));
    expect(re.escalate).toBe(false); // 可逆本身不触发升级（本期一律走审批，不走升级）
    if (ir.escalate) expect(ir.card.parameters.irreversible).toBe(true);
  });
});

describe("升级在状态机上是否走得通", () => {
  it("IN_REVIEW 与 APPROVED_UPWARD 能升；其余不能", () => {
    expect(canEscalateFrom("IN_REVIEW")).toBe(true);
    expect(canEscalateFrom("APPROVED_UPWARD")).toBe(true);
    expect(canEscalateFrom("DECOMPOSING")).toBe(false);
    expect(canEscalateFrom("IN_PROGRESS")).toBe(false);
    // BUDGET_PAUSED 是【本轮新加】的第三态（§8.3 第二条把预算硬停列为升级触发条件）。
    // 显式写在这里而不是只留在那条遍历用例里：遍历只证「与边表一致」，
    // 而「预算暂停到底该不该升」是一个要被人看见的语义决定。
    expect(canEscalateFrom("BUDGET_PAUSED")).toBe(true);
  });

  it("升级后原节点不得继续向前流转（ESCALATED_TO_CEO 的唯一出边是终审）", () => {
    // 计划 Test 项最后一条。要点：升到 CEO 之后，任务【不能】再回到 IN_PROGRESS
    // 或 DELIVERED —— 否则「等 CEO」变成可以绕过的形式等待。
    expect(canEscalateFrom("ESCALATED_TO_CEO")).toBe(false);
  });

  it("每条【不可升级】的边上写升级都是可发现的（遍历全部状态交叉验证）", () => {
    // 遍历而不是列举：手写列举会随边表演化而过时，而这里要的正是
    // 「canEscalateFrom 与状态机边表一致」这句话本身。
    //
    // 这份名单【真的被边表改动红过一次】：本轮给 BUDGET_PAUSED 补上升级边
    // （§8.3 第二条）时它立刻变红。这正是它存在的意义 —— 三个方向都拦得住：
    //  ① 加了边没改这里 ⇒ 红（本轮实际发生的那次）；
    //  ② 删了边没改这里 ⇒ 红；
    //  ③ canEscalateFrom 的实现与 EDGES 脱钩（比如有人改成硬编码两个状态）⇒ 红。
    const can = TASK_STATES.filter((s) => canEscalateFrom(s));
    expect(can).toEqual(["IN_REVIEW", "APPROVED_UPWARD", "BUDGET_PAUSED"]);
  });

  it("未知状态名 → 抛错而不是返回 false（伪装的合法拒绝最危险）", () => {
    expect(() => canEscalateFrom("NOT_A_STATE" as never)).toThrow(/未知的任务状态/u);
  });
});
