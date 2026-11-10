/**
 * Task 1.3 验收：「作者不给自己打分」的硬拦截（规格 §8.2 第 1/4 条、§24 风险 1）。
 *
 * 计划把这一组测试称作【本设计的核心防线】，理由是：整套系统的成立前提就一句话 ——
 * 「产出一个东西的人，不能是判定它合格的人」。这一条如果只在提示词里约定，
 * 那么系统的全部审阅价值等于模型那一刻的自觉。
 *
 * 因此这里刻意构造【试图绕过】的用例，而不是只测「正常情况能拦住」：
 * 一条防线的强度由最便宜的绕过方式决定。找到的每条绕路（不填 model_family、
 * 自己填 approved_by、绕三个节点回到自己）都必须有用例，否则它就是没被堵住。
 */
import type { Charter } from "@opc/contracts";
import { describe, expect, it } from "vitest";
import {
  type Block,
  CEO_ROLE_ID,
  type DelegationEdge,
  forbiddenRemovalAttempt,
  gateConfigBlock,
  independentReviewerPath,
  sameFamilyReviewBlock,
  selfReviewEdgeBlock,
  unauthorizedAttemptPayload,
} from "../../src/graph/gates/author-reviewer.js";

const DEV = { roleId: "dev", modelFamily: "claude" };
const TEST = { roleId: "test", modelFamily: "gpt" };

/** 一条最普通的合法边集：dev 产出 → test 带门控审阅。 */
const OK_EDGES: DelegationEdge[] = [
  { from: "dev", to: "test", gate: true },
  { from: "test", to: "cto", gate: true },
];

function grab(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("期望抛错，但函数正常返回了");
}

describe("判据 1：同一角色不能审自己", () => {
  it("审阅者与产出者同角色 → 拒绝，code=self_review", () => {
    const r = sameFamilyReviewBlock(DEV, DEV);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("self_review");
      // 报错要指到规格条目，否则改的人会以为这是一条风格约定
      expect(r.reason).toContain("8.2");
    }
  });

  it("任何一侧 role_id 为空 → 拒绝（空 = 无从判定独立性，不能当通过）", () => {
    for (const p of [
      { roleId: "", modelFamily: "claude" },
      { roleId: "   ", modelFamily: "claude" },
    ]) {
      expect(sameFamilyReviewBlock(p, TEST).ok).toBe(false);
      expect(sameFamilyReviewBlock(DEV, p).ok).toBe(false);
    }
  });

  it("不同角色 + 不同家族 → 放行", () => {
    expect(sameFamilyReviewBlock(DEV, TEST).ok).toBe(true);
  });
});

describe("判据 2：同模型家族需 CEO 显式批准", () => {
  const SAME = { roleId: "test", modelFamily: "claude" };

  it("同家族且无批准 → 拒绝，code=same_model_family", () => {
    const r = sameFamilyReviewBlock(DEV, SAME);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("same_model_family");
  });

  it("同家族 + CEO 批准且写明理由 → 放行", () => {
    expect(
      sameFamilyReviewBlock(DEV, SAME, {
        approvedBy: CEO_ROLE_ID,
        reason: "只有一个可用家族的临时安排，两周内换家族",
      }).ok,
    ).toBe(true);
  });

  it("批准人是作者自己 → 拒绝（这是这条防线最便宜的绕过方式）", () => {
    const r = sameFamilyReviewBlock(DEV, SAME, {
      approvedBy: "dev",
      reason: "我批准我自己",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("approval_by_author");
  });

  it("批准人是别的角色但不是 CEO → 照样拒绝", () => {
    // 「批准人必须是 CEO」而不是「批准人不是作者」：后者会让 dev 拉 test 的
    // 同级角色互批，形成利益共同体 —— 与同家族共谋同构。
    expect(
      sameFamilyReviewBlock(DEV, SAME, {
        approvedBy: "tech_director",
        reason: "总监同意",
      }).ok,
    ).toBe(false);
  });

  it("批准人写 CEO 但理由为空 → 拒绝（空理由的批准等于没有批准）", () => {
    for (const reason of ["", "   "]) {
      const r = sameFamilyReviewBlock(DEV, SAME, {
        approvedBy: CEO_ROLE_ID,
        reason,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("approval_by_author");
    }
  });

  it("model_family 为空 → 拒绝，code=unknown_model_family（【不】跳过这一维）", () => {
    // 这条是开发过程中真实写错过的地方：第一版是「非空且相等才拦」，
    // 于是【不声明家族】成了绕过 §24 风险 1 的通路。判据的失效方向必须是收紧。
    for (const p of [
      { roleId: "dev", modelFamily: "" },
      { roleId: "test", modelFamily: "" },
    ]) {
      const other = p.roleId === "dev" ? SAME : DEV;
      const r = sameFamilyReviewBlock(p, other);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("unknown_model_family");
    }
  });

  it("家族名大小写不同 ⇒ 视为不同家族（口径写死，防止两侧各按一种归一化实现）", () => {
    // 这一条不是为了支持混用大小写，而是把【当前口径】钉住：现在做的是精确比较。
    // 若将来要改成大小写不敏感，这条会红，逼改的人显式决策 —— 因为放宽比较会
    // 让「Claude」与「claude」被当成同一家族，那是【收紧】方向，不该顺手发生。
    const r = sameFamilyReviewBlock(
      { roleId: "dev", modelFamily: "Claude" },
      { roleId: "test", modelFamily: "claude" },
    );
    expect(r.ok).toBe(true);
  });
});

describe("判据 3：必须存在通往独立审阅者的带门控路径", () => {
  it("正常带门控上游 → 可达", () => {
    expect(independentReviewerPath("dev", OK_EDGES).reachable).toBe(true);
  });

  it("出边没有门控 → 不可达（门控是审阅存在的载体）", () => {
    const r = independentReviewerPath("dev", [{ from: "dev", to: "test" }]);
    expect(r.reachable).toBe(false);
  });

  it("只有自环 → 不可达（带门控的自审仍是自审）", () => {
    expect(
      independentReviewerPath("dev", [{ from: "dev", to: "dev", gate: true }])
        .reachable,
    ).toBe(false);
  });

  it("【撤回】三个不同角色成环 ⇒ 合法同行评审，可达", () => {
    // 本文件第一版把这一形期望成「不可达」，理由是「绕一圈回到自己就是自审」。
    // 那个推理混了两件事：A→A2→A3→A 上，A 的产出在【离开 A 那一步】被 A2 带门控
    // 审过，此后 A2 审 A3、A3 审 A2 的产出，没有任何人给自己打分。环上的每一条边
    // 都是「别人审我」，而 §8.2 第 1 条要防的正是「自己审自己」，不是「评审关系
    // 不成树」。真正的自审只有两种形状：自环（to === from）、以及没有别的角色可去。
    // 这一条留在这里而不是删掉，是因为它是【容易被当成 bug 改回去】的形状。
    const ring: DelegationEdge[] = [
      { from: "dev", to: "dev2", gate: true },
      { from: "dev2", to: "dev3", gate: true },
      { from: "dev3", to: "dev", gate: true },
    ];
    const r = independentReviewerPath("dev", ring);
    expect(r.reachable).toBe(true);
    // 路径只有两元素：口径看的是【离开作者那一条边】，不追多跳（见实现注释）
    expect(r.path).toEqual(["dev", "dev2"]);
  });

  it("回边成环时不死循环（有向图必有的形状：company.ts 的 test→dev 就是回边）", () => {
    const cyclic: DelegationEdge[] = [
      { from: "dev", to: "test", gate: true },
      { from: "test", to: "dev", gate: true },
    ];
    const r = independentReviewerPath("test", cyclic);
    expect(r.reachable).toBe(true);
    expect(r.path).toEqual(["test", "dev"]);
  });

  it("多跳【不算】：审阅必须落在离开作者那一条边上", () => {
    // 这一对用例把「哪一跳需要 gate」这个口径钉住。第一跳无门控 ⇒ dev 的产出
    // 在离开 dev 时没被任何门控接住，两跳处那位审的是 junior 的东西，不是 dev 的。
    const deep: DelegationEdge[] = [
      { from: "dev", to: "junior", gate: false },
      { from: "junior", to: "test", gate: true },
    ];
    expect(independentReviewerPath("dev", deep).reachable).toBe(false);
    // 补上第一跳的门控 ⇒ 有审阅。修法就是这么一条边，这也是报错里给的建议。
    const fixed: DelegationEdge[] = [
      { from: "dev", to: "junior", gate: true },
      { from: "junior", to: "test", gate: true },
    ];
    expect(independentReviewerPath("dev", fixed).reachable).toBe(true);
    // 【注意】fixed 里 junior→test 那条其实不影响 dev 的判定 —— 这正是「只看一跳」
    // 的含义。留这行是为了让下一个读代码的人不用猜实现到底看了哪几条。
    expect(
      independentReviewerPath("dev", [
        { from: "dev", to: "junior", gate: true },
      ]).reachable,
    ).toBe(true);
  });

  it("作者自己那条边带门控但指向自己 → 不可达（gate 字段挡不住自审）", () => {
    // 与 ring 那条配对：环上的边指向【别的】角色所以合法，指向自己的边带不带
    // 门控都不合法。判据看的是独立性，不是「有没有一个 gate=true」。
    expect(
      independentReviewerPath("dev", [
        { from: "dev", to: "dev", gate: true },
        { from: "dev", to: "dev2", gate: false },
      ]).reachable,
    ).toBe(false);
  });

  it("没有任何出边 → 不可达，且报错说明缺的是【带门控的独立审阅者】", () => {
    const r = selfReviewEdgeBlock("dev", []);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("no_independent_reviewer_path");
      expect(r.reason).toContain("dev");
    }
  });
});

describe("保存门控配置时的总入口（拒绝必须发生在保存时）", () => {
  it("三项都合规 → 放行", () => {
    expect(
      gateConfigBlock({ producer: DEV, reviewer: TEST, edges: OK_EDGES }).ok,
    ).toBe(true);
  });

  it("同角色 + 无可达审阅者 → 两条理由【一次全报】，不分三轮才看全", () => {
    const r = gateConfigBlock({
      producer: DEV,
      reviewer: DEV,
      edges: [{ from: "dev", to: "dev", gate: true }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // 只报第一条的话，用户改一条、保存、又看到下一条，来回三轮 —— 而这三条往往同源。
      expect(r.reason.split("；").length).toBeGreaterThanOrEqual(2);
      expect(r.reason).toContain("同一角色");
      expect(r.reason).toContain("dev");
    }
  });

  it("放行时不附带任何理由字段（避免调用方误以为「有 reason 就是被拦」）", () => {
    const ok = gateConfigBlock({ producer: DEV, reviewer: TEST, edges: OK_EDGES });
    expect(ok.ok).toBe(true);
    expect(Object.hasOwn(ok, "reason")).toBe(false);
  });

  it("Block 的形状稳定：ok / code / reason 三件齐全", () => {
    const r = gateConfigBlock({
      producer: DEV,
      reviewer: DEV,
      edges: OK_EDGES,
    }) as Block;
    expect(r.ok).toBe(false);
    expect(typeof r.code).toBe("string");
    expect(typeof r.reason).toBe("string");
  });
});

describe("运行时覆盖 forbidden 的越权尝试（§20.2 权限单调性）", () => {
  const charter = {
    roleId: "dev",
    decisionScope: {
      autonomous: ["实现已通过评审的方案"],
      requiresConsultation: [],
      forbidden: ["修改源代码以外的生产配置", "自行合并到主干", "对外发布"],
    },
  } as unknown as Charter;

  it("请求的黑名单少了原有条目 → 报出被拿掉的那几条", () => {
    const removed = forbiddenRemovalAttempt(charter, [
      "修改源代码以外的生产配置",
      "自行合并到主干",
    ]);
    expect(removed).toEqual(["对外发布"]);
  });

  it("只追加新条目（收紧）→ 不算越权", () => {
    const removed = forbiddenRemovalAttempt(charter, [
      "修改源代码以外的生产配置",
      "自行合并到主干",
      "对外发布",
      "禁止直连生产库",
    ]);
    expect(removed).toEqual([]);
  });

  it("请求空黑名单 ⇒ 原有全部条目都算被删（最危险的一种：整体清空）", () => {
    expect(forbiddenRemovalAttempt(charter, [])).toHaveLength(3);
  });

  it("审计载荷的 action 固定 unauthorized_attempt，且带上想删的具体条目", () => {
    const removed = forbiddenRemovalAttempt(charter, []);
    const p = unauthorizedAttemptPayload(charter, removed);
    expect(p.action).toBe("unauthorized_attempt");
    expect(p.kind).toBe("forbidden_removal");
    expect(p.role_id).toBe("dev");
    expect(p.removed_entries).toEqual(removed);
    // 只写「有人试过」而写不出「试的是什么」的审计事后无法用
    expect(p.removed_entries.length).toBeGreaterThan(0);
  });

  it("抛错这件事由 loader 负责；本模块的结论必须与 loader 的守卫同向", () => {
    // 这一条不重复实现单调性判据（两份判据必然漂移，0006 §7 第 55、56 条记的
    // 就是这个形状）。它只钉住一件事：这里【不抛错】而是返回差集，
    // 因为抛错的职责在 mergeForbiddenForRun —— 两处都抛会双重报错，
    // 两处都不抛则无人拦。方向由下面这条断言把守：
    const e = grab(() => {
      const removed = forbiddenRemovalAttempt(charter, []);
      if (removed.length > 0) throw new Error("FORBIDDEN-REMOVED");
    });
    expect(String(e)).toContain("FORBIDDEN-REMOVED");
  });
});
