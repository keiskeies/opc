/**
 * 审阅独立性读数（`GET /org` 的 `review_independence` 那一格）的判据。
 *
 * ── 这一篇要钉的是三件事，每件都对应一种会静默的坏法 ──────────────────
 *  ① 【复用而不是抄】：读数是调用 `sameFamilyReviewBlock` 算出来的。这一条不能用
 *     「我看了代码，是调用的」来维持 —— 所以有一发把【空白家族】打在前面：
 *     内联一份 `a.model_family === b.model_family` 会把「两边都没配家族」算成
 *     同族（两个空串相等），而正本判的是 `unknown_model_family`。那一发【只有】
 *     真调用才绿。另有一发逐字比【正本自己返回的那句 reason】，比的是对象相等，
 *     不是我手抄的子串。
 *  ② 【分母别是空的还被读成没问题】：0 个角色 / 1 个角色时 `always_needs_approval`
 *     必须是 false。写 `sameFamily === total` 在最开始那个版本里【就是这么错的】：
 *     空图 0 === 0 ⇒ true ⇒ 界面上会写「每一次审阅都要你批」，而这张图上
 *     一次审阅都发生不了。失去分母的守卫比没有守卫更坏（本仓那条老立场）。
 *  ③ 【三档不许合并】：same_family（点一次能过）与 refused（点了也没用，得改图）
 *     合并了就得到一个「N 次点击可解决」的假承诺。
 *
 * ── 分母的真假 ──────────────────────────────────────────────────────
 * ⑥ 那一组用的是【真演示图】：直接把 `serve/dev-seed.ts` 的 DEMO_ORG_NODES 拿过来，
 * 不手抄七个家族。理由与 query.test.ts 那条「列名从 PRAGMA 现读」同一条：
 * 手抄的夹具会在演示图改了之后【继续绿】，而这一发存在的唯一理由就是
 * 「界面上那句话在【正在演示的那张图】上到底成不成立」。
 */

import type { OrgGraph, OrgGraphNode } from "@opc/contracts";
import { describe, expect, it } from "vitest";
import { sameFamilyReviewBlock } from "../../src/graph/gates/author-reviewer.js";
import { reviewIndependencePreview } from "../../src/graph/gates/review-preview.js";
import { DEMO_ORG_NODES } from "../../src/serve/dev-seed.js";

/** 一张只填了家族的图（委派边与这一格无关，见 review-preview.ts 文件头那段「它不答」）。 */
function graphOf(families: Record<string, string | undefined>): OrgGraph {
  const nodes: Record<string, OrgGraphNode> = {};
  for (const [role, model_family] of Object.entries(families)) {
    nodes[role] = {
      role_id: role,
      can_manage: false,
      reports_to: null,
      ...(model_family === undefined ? {} : { model_family }),
    };
  }
  return { nodes, edges: [] };
}

/* ══════════════════ ① 三种落点 ══════════════════ */

describe("① 三种落点各就各位，且【和为分母】", () => {
  it("全家同家族 ⇒ 全部 same_family，always_needs_approval=true", () => {
    const p = reviewIndependencePreview(
      graphOf({ ceo: "opus", tech: "opus", dev: "opus" }),
    );
    expect(p).toMatchObject({
      roles: 3,
      pairs_total: 3,
      pairs_ok: 0,
      pairs_same_family: 3,
      pairs_refused: 0,
      always_needs_approval: true,
      any_refused: false,
    });
    expect(p.blocked).toHaveLength(3);
    expect(p.blocked.every((b) => b.code === "same_model_family")).toBe(true);
  });

  it("家族两两不同 ⇒ 全 ok，blocked 空，always=false（同一张图上那句「每次都要批」就是假的）", () => {
    const p = reviewIndependencePreview(
      graphOf({ ceo: "opus", tech: "sonnet", dev: "gpt" }),
    );
    expect(p).toMatchObject({
      pairs_total: 3,
      pairs_ok: 3,
      pairs_same_family: 0,
      pairs_refused: 0,
      always_needs_approval: false,
      any_refused: false,
    });
    expect(p.blocked).toEqual([]);
  });

  it("⭐ 混合图：三档【同时非零】且 三档之和 === pairs_total", () => {
    // a/b 同族；c/d 各不同；e 没配家族 ⇒ 与任何人的配对都 refused。
    const p = reviewIndependencePreview(
      graphOf({ a: "opus", b: "opus", c: "sonnet", d: "gpt", e: undefined }),
    );
    // 分母 C(5,2)=10：a-b 同族(1)；含 e 的四对全 refused(4)；其余 5 对 ok。
    expect(p.pairs_total).toBe(10);
    expect(p.pairs_same_family).toBe(1);
    expect(p.pairs_refused).toBe(4);
    expect(p.pairs_ok).toBe(5);
    expect(p.pairs_ok + p.pairs_same_family + p.pairs_refused).toBe(
      p.pairs_total,
    );
    expect(p.blocked).toHaveLength(5);
    expect(p.always_needs_approval).toBe(false);
    expect(p.any_refused).toBe(true);
  });

  it("⭐ refused 与 same_family 【不许合并】：修法不同，一个是点击、一个是改图", () => {
    const p = reviewIndependencePreview(
      graphOf({ a: "opus", b: "opus", c: undefined }),
    );
    const codes = p.blocked.map((b) => b.code);
    expect(codes).toContain("same_model_family");
    expect(codes).toContain("unknown_model_family");
    // 三个配对全被拦，但 always_needs_approval=false —— 因为其中一次【批了也没用】。
    expect(p.blocked).toHaveLength(3);
    expect(p.always_needs_approval).toBe(false);
    expect(p.pairs_ok).toBe(0);
  });
});

/* ══════════════════ ② 分母 ══════════════════ */

describe("② 分母：无序对，且空图不许被读成「每次都要批」", () => {
  it("分母是无序对 C(k,2)，不是有序对 k(k-1)", () => {
    // 判据对方向不敏感（家族相等是对称的）：数两遍会把「一半」读成「四分之一」。
    const p = reviewIndependencePreview(
      graphOf({ a: "x", b: "y", c: "z", d: "w" }),
    );
    expect(p.pairs_total).toBe(6);
    expect(p.roles).toBe(4);
  });

  it("⭐ 0 个角色 ⇒ 分母 0 且 always_needs_approval=【false】（0===0 那一版是错的）", () => {
    const p = reviewIndependencePreview(graphOf({}));
    expect(p.roles).toBe(0);
    expect(p.pairs_total).toBe(0);
    expect(p.always_needs_approval).toBe(false);
    expect(p.any_refused).toBe(false);
    expect(p.blocked).toEqual([]);
  });

  it("⭐ 1 个角色 ⇒ 分母 0 且 always=false（图上没有任何配对，那句「每次」无主语）", () => {
    const p = reviewIndependencePreview(graphOf({ solo: "opus" }));
    expect(p.roles).toBe(1);
    expect(p.pairs_total).toBe(0);
    expect(p.always_needs_approval).toBe(false);
  });
});

/* ══════════════════ ③ 复用，不是抄 ══════════════════ */

describe("③ 这条读数是【调用】判据正本算的，不是内联一份等号", () => {
  it("⭐ 两边都【没配家族】⇒ refused，不是 same_family（内联等号在这一发红）", () => {
    // 抄件的形状就是这一发：`"" === ""` 为真 ⇒ 报成同族 ⇒ 界面说「点一次批准就行」，
    // 而正确答案是「先把 model_family 配上」。同一家族的修法与缺信息的修法不同。
    const p = reviewIndependencePreview(
      graphOf({ a: undefined, b: undefined }),
    );
    expect(p.pairs_same_family).toBe(0);
    expect(p.pairs_refused).toBe(1);
    expect(p.blocked[0]?.code).toBe("unknown_model_family");
    expect(p.always_needs_approval).toBe(false);
  });

  it("⭐ blocked 里的 reason 与【正本自己返回的那句】逐字相同（不是我抄的子串）", () => {
    const graph = graphOf({ dev: "opus", test: "opus" });
    const p = reviewIndependencePreview(graph);
    const authority = sameFamilyReviewBlock(
      { roleId: "dev", modelFamily: "opus" },
      { roleId: "test", modelFamily: "opus" },
    );
    expect(authority.ok).toBe(false);
    const reason = authority.ok ? "" : authority.reason;
    expect(p.blocked.map((b) => b.reason)).toContain(reason);
    // 反向对照：换一个不存在的配对，正本那句话不该出现在读数里。
    const other = reviewIndependencePreview(
      graphOf({ dev: "opus", qa: "gemini" }),
    );
    expect(other.blocked.map((b) => b.reason)).not.toContain(reason);
  });

  it("读数里【永不】出现 approval_by_author：本函数根本不传批准凭据", () => {
    // 那一个 code 只在传了 approval 时才可能出。出现就说明有人把「问会不会拦」
    // 改成了「问批了之后过不过」—— 后者恒过，读数会变成「不存在这一格」。
    const p = reviewIndependencePreview(
      graphOf({ a: "opus", b: "opus", c: undefined, d: "gpt" }),
    );
    expect(p.blocked.some((b) => b.code === "approval_by_author")).toBe(false);
  });

  it("⭐ 角色键是纯空白时落进 refused（注释里那句「极端情形」有分母，不是我编的）", () => {
    // orgGraphSchema 的 role_id 只要求 min(1)，所以 " " 是一个合法的键；
    // 正本对空白 role_id 判 self_review（无法判定独立性 ⇒ 不放行）。
    const graph = graphOf({ " ": "opus", b: "opus" });
    const p = reviewIndependencePreview(graph);
    expect(p.pairs_refused).toBe(1);
    expect(p.pairs_same_family).toBe(0);
    expect(p.blocked[0]?.code).toBe("self_review");
  });
});

/* ══════════════════ ④ 形状与确定性 ══════════════════ */

describe("④ 与枚举顺序无关、可重复", () => {
  it("⭐ 同一批节点【换个插入顺序】，读数逐字节相同（键排过序）", () => {
    const a = reviewIndependencePreview(
      graphOf({ zeta: "opus", alpha: "opus", mid: "sonnet" }),
    );
    const b = reviewIndependencePreview(
      graphOf({ mid: "sonnet", zeta: "opus", alpha: "opus" }),
    );
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.blocked.map((x) => [x.producer, x.reviewer])).toEqual([
      ["alpha", "zeta"],
    ]);
  });

  it("配对里的两侧也按序（producer 恒是排序后的那一个），不是随手塞的", () => {
    const p = reviewIndependencePreview(graphOf({ qa: "gpt", dev: "gpt" }));
    expect(p.blocked).toEqual([
      {
        producer: "dev",
        reviewer: "qa",
        code: "same_model_family",
        reason: expect.any(String),
      },
    ]);
  });

  it("纯函数：同一输入连调两次结果相同，且不改传入的图", () => {
    const graph = graphOf({ a: "opus", b: "opus", c: "gpt" });
    const before = JSON.stringify(graph);
    expect(reviewIndependencePreview(graph)).toEqual(
      reviewIndependencePreview(graph),
    );
    expect(JSON.stringify(graph)).toBe(before);
  });
});

/* ══════════════════ ⑤ 真演示图（分母不是手抄的） ══════════════════ */

describe("⑤ 演示图上的真实读数 —— 那句「每次都要批」在这里【不成立】", () => {
  const demo: OrgGraph = {
    nodes: Object.fromEntries(DEMO_ORG_NODES.map((n) => [n.role_id, n])),
    edges: [],
  };
  const p = reviewIndependencePreview(demo);

  it("七个角色 ⇒ 21 个配对，全部配了家族（没有 refused）", () => {
    expect(p.roles).toBe(DEMO_ORG_NODES.length);
    expect(p.roles).toBe(7);
    expect(p.pairs_total).toBe(21);
    expect(p.pairs_refused).toBe(0);
    expect(p.any_refused).toBe(false);
  });

  it("⭐ 演示图刻意错开家族 ⇒ same_family 只占 2/21 ⇒ always_needs_approval=false", () => {
    // dev-seed.ts :93-94 自己写着「父子刻意错开，让将来加委派边演示时门控不会一上来就红」。
    // 这一发钉的是那句话的【后果】：如果在演示数据上把「每次审阅都要批」写死进界面，
    // 那句话在它正在演示的那张图上就是假的 —— 21 个配对里只有 2 个真的同族。
    expect(p.pairs_same_family).toBe(2);
    expect(p.pairs_ok).toBe(19);
    expect(p.always_needs_approval).toBe(false);
    expect(p.blocked.map((b) => [b.producer, b.reviewer])).toEqual([
      ["architect", "product_lead"],
      ["ceo", "tech_director"],
    ]);
  });

  it("反向对照：把演示图全家改成同一家族 ⇒ always_needs_approval=true（上一发不是恒 false）", () => {
    const flat = reviewIndependencePreview(
      graphOf(
        Object.fromEntries(DEMO_ORG_NODES.map((n) => [n.role_id, "opus"])),
      ),
    );
    expect(flat.pairs_total).toBe(21);
    expect(flat.pairs_same_family).toBe(21);
    expect(flat.pairs_ok).toBe(0);
    expect(flat.always_needs_approval).toBe(true);
    // 这才是一台真机器上的形状：所有角色共用一个 model_family ⇒ 每次审阅都命中。
    expect(flat.pairs_same_family).toBe(flat.pairs_total);
  });
});
