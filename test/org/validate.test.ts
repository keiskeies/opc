/**
 * 组织图三层校验（计划 Task 3.1，规格 §18.3）。
 *
 * ── 位置为什么在仓库根 test/org/ 而不是 packages/contracts/test/ ────────
 * contracts 包【没有 test 目录，也没有 vitest 依赖】（见它的 package.json：
 * 运行时依赖只有 zod）。被测代码住在 contracts 是计划的硬要求
 * （「同一份代码前后端共用」），而测试装置住在根 test/ 与
 * test/web/hub-projection.test.ts 是同一个先例 —— 那个文件测的也是
 * packages/web 里的纯模块。这样 contracts 保持【零测试依赖】，
 * 而「共用同一份」这件事由 import 路径证明：这里 import 的是
 * `@opc/contracts`（走 dist）而不是深路径 —— 深路径会让「前端能不能拿到」
 * 这个问题被绕过（前端只能拿到包的公开出口）。
 *
 * ── 这份测试里【不是照抄规格】的部分，逐条说明 ─────────────────────────
 * 计划列了九条用例，九条都在。除此之外有五条是我改判据时【必须】配的：
 * 自环、图本来就有环、委派环不得误拒、CEO 那条判据挪到最前、agent 顶着
 * ceo 这个 id 也要拒。五条都是【规格示例代码覆盖不到】的形状，
 * 少一条就是「判据存在但没被钉住」—— 0007 那条纪律说的正是这个。
 *
 * ── 一处测试装置上的选择：为什么这里不用 zod parse 兜一遍 ────────────────
 * 每个夹具都是【手写的对象字面量】而不是 orgGraphSchema.parse(...)。
 * 理由：校验器要能在【过不了 schema 的图】上给出结论（库里读出来的旧数据、
 * 编辑中途的草稿）。让夹具先过 schema，等于用被测代码的邻居把被测代码
 * 要处理的输入形状先筛掉一遍 —— 那三层校验最要紧的那部分输入就永远进不了测试。
 * 所以 schema 自己单独测（最后那节），图的夹具直接给字面量。
 */
import { describe, expect, it } from "vitest";
import {
  CEO_ROLE_ID,
  everyNodeDeclaresModelFamily,
  ORG_MAX_DEPTH,
  orgActorSchema,
  orgChangeSchema,
  orgGraphSchema,
  rejectMalformed,
  type OrgActor,
  type OrgGraphNode,
  type OrgGraph,
  pathToRoot,
  reportsToCycle,
  validateNewEdge,
  validateNewNode,
  validateOrgChange,
  validateReparenting,
  type Verdict,
  violatesNoSelfReview,
} from "@opc/contracts";

const CEO = CEO_ROLE_ID;

/**
 * 一棵能用的公司树：ceo → tech → dev；ceo → product。
 * 深度：ceo=1，tech=2，dev=3。
 *
 * 四个节点【都】带 model_family —— 包括 ceo。少了那一格，任何以 CEO 为审阅方的
 * 边都会先撞上 unknown_model_family（那是正确行为），于是「可达性」「深度」
 * 这些【排在其后】的判据在测试里根本走不到。夹具完整不是装饰：
 * 它决定了一条用例报出的失败【是不是它声称的那个失败】。
 */
function base(): OrgGraph {
  return {
    nodes: {
      ceo: { role_id: CEO, can_manage: true, reports_to: null, model_family: "o3" },
      tech: { role_id: "tech", can_manage: true, reports_to: CEO, model_family: "claude" },
      dev: { role_id: "dev", can_manage: false, reports_to: "tech", model_family: "gpt" },
      product: { role_id: "product", can_manage: true, reports_to: CEO, model_family: "gemini" },
    },
    edges: [
      { from: "dev", to: "tech", review_gate: true },
      { from: "tech", to: CEO, review_gate: true },
      { from: "product", to: CEO, review_gate: true },
    ],
  };
}

/** 一条拒绝结论，便于逐条读 code。 */
function bad(v: Verdict): { code: string; reason: string } {
  if (v.ok) throw new Error("期望被拒绝，实际通过了");
  return { code: v.code, reason: v.reason };
}

/**
 * 取图上某个节点并保证类型收窄。
 *
 * 本文件既有那几发写的是 `org.nodes.dev.model_family = ...`，在
 * `noUncheckedIndexedAccess` 下每条都是一发 TS18048，而那 5 发【已经登记在
 * `test/arch/test-type-baseline.ts` 的 291 里】。我这里不改它们（改一批已登记的
 * 语料属另一件事），但【新写的这几发不再往棘轮里添】：用抛错而不是 `!`，
 * 因为夹具缺节点时我要的是一句「夹具里没有节点 dev」，不是 undefined 上的一条
 * 属性访问 —— `!` 在那种时候只会让失败的形状变成 TypeError。
 */
function node(org: OrgGraph, id: string): OrgGraph["nodes"][string] {
  const n = org.nodes[id];
  if (n === undefined) throw new Error("夹具里没有节点 [" + id + "]");
  return n;
}

const CEO_ACTOR: OrgActor = { type: "human", id: CEO };

describe("L1 validateReparenting：改汇报关系", () => {
  it("合法：dev 挂到 product 之下（同为 CEO 的下级之间挪）", () => {
    expect(validateReparenting("dev", "product", base())).toEqual({ ok: true });
  });

  it("环：tech 挂到它自己的下级 dev 之下 ⇒ would_create_cycle", () => {
    // 计划用例「环检测」。这条同时是 getDescendants 的传递性证明：
    // dev 是 tech 的【孙】辈（tech → dev 中间隔了一层）时也必须抓到，
    // 所以另配一条三层的，见下面那条。
    expect(bad(validateReparenting("tech", "dev", base())).code).toBe(
      "would_create_cycle",
    );
  });

  it("环：三层之下也要抓到（隔两代才算的下级）", () => {
    const org = base();
    org.nodes.lead = { role_id: "lead", can_manage: true, reports_to: "dev" };
    expect(bad(validateReparenting("tech", "lead", org)).code).toBe(
      "would_create_cycle",
    );
  });

  it("自环：挂到【自己】之下 ⇒ 拒绝（规格那句 getDescendants 判不出来）", () => {
    // 规格 §18.3 示例用的是 `getDescendants(child, org).includes(newParent)`，
    // 而 getDescendants 不含自身 —— 按那句实现，「dev 挂到 dev 之下」是【放行】的。
    // 这条用例挡住的就是那次「照抄示例」的实现。
    expect(bad(validateReparenting("dev", "dev", base())).code).toBe(
      "would_create_cycle",
    );
  });

  it("非管理角色不收汇报：dev 的 can_manage=false ⇒ parent_not_manager", () => {
    expect(bad(validateReparenting("product", "dev", base())).code).toBe(
      "parent_not_manager",
    );
  });

  it(`深度：超过 ${ORG_MAX_DEPTH} 层 ⇒ 拒绝，并报出实际到达的那一层`, () => {
    // 树：ceo(1) → tech(2) → dev(3) → l4(4) → l5(5)。
    // 把 product（它自己还带着 dev 那一支吗？不带）挂到 l5 之下 ⇒ 第 6 层 ⇒ 拒。
    const org = base();
    org.nodes.l4 = { role_id: "l4", can_manage: true, reports_to: "dev" };
    org.nodes.l5 = { role_id: "l5", can_manage: true, reports_to: "l4" };
    const v = bad(validateReparenting("product", "l5", org));
    expect(v.code).toBe("depth_exceeded");
    expect(v.reason).toContain(String(ORG_MAX_DEPTH + 1));
  });

  it("深度【恰好等于】上限 ⇒ 通过（边界不收紧到 N-1）", () => {
    const org = base();
    org.nodes.l4 = { role_id: "l4", can_manage: true, reports_to: "dev" };
    expect(validateReparenting("product", "l4", org)).toEqual({ ok: true });
    expect(pathToRoot(org, "l4").length).toBe(4);
  });

  it("深度：被挂的那一支【自己带着下级】时，要算整支的高度", () => {
    // 这是我对规格示例的一处偏离（validate.ts 里那段推导）。
    // 树：ceo → tech → dev → junior（dev 那一支高 2）。
    //     ceo → product（第 2 层），product 可管理。
    // 把整支 dev（带着 junior）挂到 product 下：product 在第 2 层，
    // dev 那支高 2 ⇒ 最深到第 4 层 ⇒ 【通过】。
    // 再把 product 往下挪两层之后同样这一挂就该【拒】。用例成对写，
    // 因为「只算被挂节点自己」那份实现在第一对上碰巧也对 —— 单写通过那条
    // 挡不住它，必须连那条会超的。
    const org = base();
    org.nodes.junior = { role_id: "junior", can_manage: false, reports_to: "dev" };
    expect(validateReparenting("dev", "product", org)).toEqual({ ok: true });
    org.nodes.p4 = { role_id: "p4", can_manage: true, reports_to: "product" };
    org.nodes.p5 = { role_id: "p5", can_manage: true, reports_to: "p4" };
    // p5 在第 4 层，dev 那一支高 2 ⇒ 最深第 6 层 ⇒ 拒。
    // 只看 newParent 深度的那份实现会算出 4+1=5 ⇒ 放行，这条就是它红的时候。
    expect(bad(validateReparenting("dev", "p5", org)).code).toBe("depth_exceeded");
  });

  it("CEO 不可拖，且【不能】被环判据抢先报成「挂到自己下级之下」", () => {
    // 计划用例「CEO 不可拖」。但真正要钉的是【哪条判据先命中】：
    // CEO 的下级是所有人，所以按规格示例的顺序（环判据在前），
    // 这一拖会先命中环，用户看到一句他无法行动的话。
    const v = bad(validateReparenting(CEO, "tech", base()));
    expect(v.code).toBe("ceo_is_root");
    expect(v.reason).not.toContain("下级");
  });

  it("图本身有环 ⇒ 【拒绝】而不是给出一个 ok", () => {
    // 判据的存在理由写在 rejectMalformed：坏图上 depthOf 会给一个偏小的数，
    // 于是「深度超限」反而不触发。这条用例是那条推理唯一的地面。
    const org = base();
    org.nodes.tech.reports_to = "dev"; // tech → dev → tech
    expect(reportsToCycle(org)).not.toBeNull();
    expect(bad(validateReparenting("product", "dev", org)).code).toBe(
      "report_cycle_present",
    );
  });

  it("汇报关系指向不存在的节点 ⇒ 拒绝（不静默把它当根）", () => {
    const org = base();
    org.nodes.dev.reports_to = "ghost";
    expect(bad(validateReparenting("product", "tech", org)).code).toBe(
      "dangling_report",
    );
  });

  it("未知角色 ⇒ unknown_role，两种（child 不存在 / parent 不存在）", () => {
    expect(bad(validateReparenting("ghost", "tech", base())).code).toBe("unknown_role");
    expect(bad(validateReparenting("dev", "ghost", base())).code).toBe("unknown_role");
  });
});

describe("L1 validateNewNode：加一个新节点（round294，O8 §7 第 18 格的修法）", () => {
  /** 一个新节点的默认形状：挂在 tech 之下、不可管理、声明了家族。 */
  const newNode = (
    over: Partial<OrgGraphNode> = {},
  ): OrgGraphNode => ({
    role_id: "junior",
    can_manage: false,
    reports_to: "tech",
    model_family: "kimi",
    ...over,
  });

  it("合法：挂在一个能收汇报的节点之下 ⇒ 通过", () => {
    expect(validateNewNode(newNode(), base())).toEqual({ ok: true });
  });

  it("重名 ⇒ role_exists（add_node 是加不是改）", () => {
    const v = bad(validateNewNode(newNode({ role_id: "dev" }), base()));
    expect(v.code).toBe("role_exists");
    // reason 要指路，不能只说「不行」：这条判据最常被误当成 bug 而绕去走旁路。
    expect(v.reason).toContain("reparent");
  });

  it("⭐ 重名【抢在】自环之前：同一条既有故障不许被换成一句指向别处的话", () => {
    // dev 已存在，而它的 reports_to 恰好又是自己。两条判据都能命中。
    // 若自环那条先命中，用户看到的是「不能以自己的 id 作为上级」—— 而他真正
    // 做错的是「这个角色已经在图上了」。（与 reparent 那条「CEO 不可拖不许被
    // 环判据抢先」是同一族：判据顺序 = 用户拿到那句能不能行动的话。）
    const v = bad(validateNewNode(newNode({ role_id: "dev", reports_to: "dev" }), base()));
    expect(v.code).toBe("role_exists");
  });

  it("自环 ⇒ would_create_cycle，且不被「上级不存在」吃掉", () => {
    // junior 不在图里，所以「上级 [junior] 不在图里」这句话【也】是真的。
    // 按 spec 示例的顺序（先查上级存在）就会命中它 —— 那是一句无法行动的话：
    // 用户会去图里找 junior，而 junior 正是他自己要加的那个节点。
    const v = bad(validateNewNode(newNode({ reports_to: "junior" }), base()));
    expect(v.code).toBe("would_create_cycle");
    expect(v.reason).not.toContain("不在图里");
  });

  it("上级不存在 ⇒ unknown_role", () => {
    expect(bad(validateNewNode(newNode({ reports_to: "ghost" }), base())).code).toBe(
      "unknown_role",
    );
  });

  it("上级不是管理角色 ⇒ parent_not_manager（与 reparent 同一条判据、同一个 code）", () => {
    // dev 在夹具里 can_manage=false。这一发同时钉住了【复用】：新节点那条路
    // 没有另立一个"上一级不能管人"的新 code。
    expect(base().nodes["dev"]?.can_manage).toBe(false);
    expect(bad(validateNewNode(newNode({ reports_to: "dev" }), base())).code).toBe(
      "parent_not_manager",
    );
  });

  it(`深度：挂上去会到第 ${ORG_MAX_DEPTH + 1} 层 ⇒ 拒`, () => {
    const org = base();
    // 夹具：ceo(1) → tech(2) → dev(3)。垫到第 5 层，再往下面加就是第 6 层。
    org.nodes.l4 = { role_id: "l4", can_manage: true, reports_to: "dev" };
    org.nodes.l5 = { role_id: "l5", can_manage: true, reports_to: "l4" };
    const v = bad(validateNewNode(newNode({ reports_to: "l5" }), org));
    expect(v.code).toBe("depth_exceeded");
    expect(v.reason).toContain(String(ORG_MAX_DEPTH + 1));
  });

  it(`深度【恰好】到第 ${ORG_MAX_DEPTH} 层 ⇒ 通过（边界成对，不收紧到 N-1）`, () => {
    // 与上一发只差一层。单写超的那条挡不住「把上限写成 >=」那种改法，
    // 而单写通过的又挡不住「忘了判深度」—— 必须成对（本文件那两发 reparent
    // 深度用例同理，那不是巧合）。
    const org = base();
    org.nodes.l4 = { role_id: "l4", can_manage: true, reports_to: "dev" };
    expect(validateNewNode(newNode({ reports_to: "l4" }), org)).toEqual({ ok: true });
    const after: OrgGraph = { ...org, nodes: { ...org.nodes, junior: newNode({ reports_to: "l4" }) } };
    expect(pathToRoot(after, "junior").length).toBe(ORG_MAX_DEPTH);
  });

  it("⭐ 森林：reports_to=null 而图上已有根 ⇒ multiple_roots", () => {
    // 这一格是本轮唯一【新造 code】的一条，所以它得有一条"为什么不是运行时判完就行"的
    // 证据 —— 见 validate.ts 函数头 ⑤：dispatch 的 resolveCeoRoleId 遇到森林拒绝跑，
    // 而一轮就是钱。保存期能算出来的事不留到花钱的时候算。
    const v = bad(validateNewNode(newNode({ reports_to: null }), base()));
    expect(v.code).toBe("multiple_roots");
    expect(v.reason).toContain("森林");
  });

  it("⭐ multiple_roots 的反向 canary：空图加第一个节点，reports_to=null 是唯一合法写法", () => {
    // 没有这一发，上面那条会被读成「凡是根都拒」，而那种实现会让【第一格永远加不进去】。
    // 判据是「加完之后根多于一个」，不是「它是根」。
    expect(
      validateNewNode(
        { role_id: CEO, can_manage: true, reports_to: null, model_family: "o3" },
        { nodes: {}, edges: [] },
      ),
    ).toEqual({ ok: true });
    // 反向配对：空图之后已经有根了，第二个根就该拒（上面那条通过不是"永远通过"）。
    expect(
      bad(
        validateNewNode(
          { role_id: "another_root", can_manage: true, reports_to: null },
          { nodes: { ceo: { role_id: CEO, can_manage: true, reports_to: null } }, edges: [] },
        ),
      ).code,
    ).toBe("multiple_roots");
  });

  it("⭐ 与 model_family 那条判据【不重叠】：本函数放行，由整图那条拦", () => {
    // 这一发钉的是【分工】而不是"也能拦"。如果有人在 validateNewNode 里也判一遍
    // model_family，这一发照样绿 —— 所以 r22 的判据读的是 validate.ts 的字节：
    // 那里【不得】出现家族那两条 code。两处口径迟早会漂（本仓治过的那一族）。
    const org = base();
    const noFamily = newNode({ model_family: undefined });
    expect(validateNewNode(noFamily, org)).toEqual({ ok: true });
    const after: OrgGraph = { ...org, nodes: { ...org.nodes, junior: noFamily } };
    expect(bad(everyNodeDeclaresModelFamily(after)).code).toBe("unknown_model_family");
  });

  it("图本身有环 ⇒ rejectMalformed 先命中，不在坏图上给一个 ok", () => {
    const org = base();
    node(org, "tech").reports_to = "dev";
    expect(bad(validateNewNode(newNode(), org)).code).toBe("report_cycle_present");
  });

  it("本函数不改图（纯函数：判据跑完，图上没有多出那个节点）", () => {
    // 看起来多余，但它挡住的是"顺手在里面写图"那种改法 —— 一处校验器把节点写进
    // 入参对象，audit 的 before 快照就会跟着变，而 before 快照的语义是【提交前】。
    const org = base();
    const before = JSON.stringify(org);
    expect(validateNewNode(newNode(), org)).toEqual({ ok: true });
    expect(JSON.stringify(org)).toBe(before);
  });
});

describe("L2 validateNewEdge：加委派边", () => {
  it("合法：product 产出、tech 审阅（不同家族、带门控、tech 可达 CEO）", () => {
    expect(validateNewEdge("product", "tech", base(), true)).toEqual({ ok: true });
  });

  it("门控：review_gate=false ⇒ 拒绝（§8.2 第 4 条不可绕过）", () => {
    expect(bad(validateNewEdge("product", "tech", base(), false)).code).toBe(
      "missing_review_gate",
    );
  });

  it("门控参数【缺省】按 false 处理（没说带门控就是不带）", () => {
    // 这条单独存在是因为「缺省值取 true 还是 false」决定这条判据还剩不剩。
    // 取 true 的话，省略第三个参数的调用【全部放行】—— 判据形同删除，
    // 而删除判据不会有人来改这条用例。
    expect(bad(validateNewEdge("product", "tech", base())).code).toBe(
      "missing_review_gate",
    );
  });

  it("无门控的委派边：即使其余三条判据全过，仍然拒（判据顺序不互相掩盖）", () => {
    const v = bad(validateNewEdge("product", "tech", base(), false));
    expect(v.code).toBe("missing_review_gate");
    // 门控是第一个能失败的判据。把「未知角色」也叠上时，仍然【先】报未知角色 ——
    // 那个 reason 更能指路（用户得先有这两个节点才谈得上配门控）。
    expect(bad(validateNewEdge("ghost", "tech", base(), false)).code).toBe(
      "unknown_role",
    );
  });

  it("同家族自审：dev(claude) 交给 tech(claude) 审 ⇒ 拒", () => {
    const org = base();
    org.nodes.dev.model_family = "claude";
    expect(bad(validateNewEdge("dev", "tech", org, true)).code).toBe("same_model_family");
  });

  it("同一角色自审 ⇒ self_review（比同家族更直接的那一格）", () => {
    expect(bad(validateNewEdge("dev", "dev", base(), true)).code).toBe("self_review");
    expect(bad(violatesNoSelfReview("dev", "dev", base())).code).toBe("self_review");
  });

  it("model_family 缺失 ⇒ 【拦】而不是跳过这一维", () => {
    // 与 hub 的 unknown_model_family 同方向：缺信息必须落到【有人来判】。
    // 「不声明家族」若成了一条放行通路，绕过同家族拦截的代价就是删掉一行 yaml。
    const org = base();
    delete org.nodes.dev.model_family;
    expect(bad(validateNewEdge("dev", "tech", org, true)).code).toBe(
      "unknown_model_family",
    );
    // 空串与缺失同判（trim）。这条不是洁癖：yaml 里 `model_family:` 后面留空
    // 读进来就是空串，而那正是「作者忘了填」最常见的那一种。
    org.nodes.dev.model_family = "   ";
    expect(bad(validateNewEdge("dev", "tech", org, true)).code).toBe(
      "unknown_model_family",
    );
  });

  it("升级路径不可达 CEO ⇒ 拒绝（计划 V12：框架帮不上忙，只能自己判）", () => {
    // dev 产出给 junior 审，而 junior 没有任何出边通往 CEO ⇒ 那条产出永远上不去。
    const org = base();
    org.nodes.junior = {
      role_id: "junior", can_manage: false, reports_to: "dev", model_family: "llama",
    };
    expect(bad(validateNewEdge("dev", "junior", org, true)).code).toBe(
      "escalation_unreachable",
    );
  });

  it("升级路径靠【这条边之外】的既有边连通 ⇒ 通过", () => {
    // junior 自己没有出边时上一条拒；补一条 junior → tech（带门控）就该过。
    // 这条与上一条是【一对】：只写拒的那条，判据可以被写成「恒拒」而全绿。
    const org = base();
    org.nodes.junior = {
      role_id: "junior", can_manage: false, reports_to: "dev", model_family: "llama",
    };
    org.edges.push({ from: "junior", to: "tech", review_gate: true });
    expect(validateNewEdge("dev", "junior", org, true)).toEqual({ ok: true });
  });

  it("可达性判的是【有向】可达：CEO→junior 那样的反向边不算数", () => {
    // 若把边当无向，一条 CEO 委派给 junior 的边就会造成「junior 可达 CEO」的假象，
    // 于是判据 3 在最常见的图形状上失效。
    const org = base();
    org.nodes.junior = {
      role_id: "junior", can_manage: false, reports_to: "dev", model_family: "llama",
    };
    org.edges.push({ from: CEO, to: "junior", review_gate: true });
    expect(bad(validateNewEdge("dev", "junior", org, true)).code).toBe(
      "escalation_unreachable",
    );
  });

  it("合法的同行评审环【不得】被深度判据误拒（我第一版就是误拒的）", () => {
    // hub 明确放行 dev ⇄ test 这种环（independentReviewerPath 的注释）。
    // 我第一版按「预算耗尽即封顶」算链长，结果这张图上加【任何】边都报「超过 5 层」
    // —— 不是误报某条边，是这条判据在合法图上恒真，功能整个不可用。
    const org = base();
    org.nodes.test = { role_id: "test", can_manage: false, reports_to: "tech", model_family: "gpt" };
    org.edges.push({ from: "dev", to: "test", review_gate: true });
    org.edges.push({ from: "test", to: "dev", review_gate: true });
    // product 与 CEO 之间那条新边：环不在它的路径上，必须通过。
    expect(validateNewEdge("product", CEO, org, true)).toEqual({ ok: true });
    // 环上的两个节点做端点也要通过（product → test：test 可达 CEO 经由 tech）。
    expect(validateNewEdge("product", "test", org, true)).toEqual({ ok: true });
  });

  it("委派链【真的】超过 5 层 ⇒ 拒，并且与通过的那一对只差一条边", () => {
    // 通过/拒绝写成【同一张图加一条边】的一对，而不是两个独立夹具：
    // 两个夹具的话，拒的那条可以因为任何别的原因拒（可达性、家族……），
    // _on-pass_ 那条并不能排除那些原因。只差一条边，唯一变量就是链长。
    //
    // 链 b1→b2→b3→b4（b4 之前 3 层），待加边 b4→t，t→ceo（t 之后 1 层）
    //   ⇒ 3 + 1 + 1 = 5 = 上限 ⇒ 通过。
    // 再补 b0→b1 ⇒ b4 之前 4 层 ⇒ 4 + 1 + 1 = 6 > 5 ⇒ 拒。
    const mk = (): OrgGraph => ({
      nodes: {
        ceo: { role_id: CEO, can_manage: true, reports_to: null, model_family: "mc" },
        b1: { role_id: "b1", can_manage: true, reports_to: CEO, model_family: "m1" },
        b2: { role_id: "b2", can_manage: true, reports_to: CEO, model_family: "m2" },
        b3: { role_id: "b3", can_manage: true, reports_to: CEO, model_family: "m3" },
        b4: { role_id: "b4", can_manage: true, reports_to: CEO, model_family: "m4" },
        t: { role_id: "t", can_manage: true, reports_to: CEO, model_family: "mt" },
      },
      edges: [
        { from: "b1", to: "b2", review_gate: true },
        { from: "b2", to: "b3", review_gate: true },
        { from: "b3", to: "b4", review_gate: true },
        // t → ceo：让【升级可达】这条判据先过，于是失败只能来自深度。
        { from: "t", to: CEO, review_gate: true },
      ],
    });
    const ok = mk();
    expect(validateNewEdge("b4", "t", ok, true)).toEqual({ ok: true });
    const over = mk();
    over.nodes.b0 = { role_id: "b0", can_manage: true, reports_to: CEO, model_family: "m0" };
    over.edges.push({ from: "b0", to: "b1", review_gate: true });
    const v = bad(validateNewEdge("b4", "t", over, true));
    expect(v.code).toBe("depth_exceeded");
    expect(v.reason).toContain("4");
  });
});

describe("L3 validateOrgChange：谁发起、影响什么", () => {
  const reparent = { kind: "reparent", child_role: "dev", new_parent_role: "product" } as const;

  it("CEO 本人 + 无运行中任务 ⇒ 直接通过", () => {
    expect(validateOrgChange(reparent, CEO_ACTOR, [])).toEqual({ ok: true });
  });

  it("非 CEO 的人 ⇒ 拒（§4.2.3 资源分配权集中）", () => {
    expect(bad(validateOrgChange(reparent, { type: "human", id: "tech" }, [])).code).toBe(
      "not_ceo",
    );
  });

  it("agent 顶着 ceo 这个 id ⇒ 同样拒（type 那一维必须单独判）", () => {
    // 这不是稻草人：图里 report 节点用的 role_id 就是 "ceo"（roles/preset.ts
    // 的 NODE_TO_TEMPLATE）。只判 id 的话，那条 agent 通道就能改组织。
    expect(bad(validateOrgChange(reparent, { type: "agent", id: CEO }, [])).code).toBe(
      "not_ceo",
    );
  });

  it("有运行中任务 ⇒ 【通过但需确认】，不是拒绝", () => {
    const r = validateOrgChange(reparent, CEO_ACTOR, ["t-1", "t-2"]);
    if (!r.ok || !("needsConfirmation" in r)) throw new Error("应给出需确认结论");
    expect(r.needsConfirmation).toContain("2");
    expect(r.runningTaskIds).toEqual(["t-1", "t-2"]);
  });

  it("零个运行中任务 ⇒ 不得出现 needsConfirmation（否则每次都弹窗）", () => {
    const r = validateOrgChange(reparent, CEO_ACTOR, []);
    expect("needsConfirmation" in r).toBe(false);
  });
});

/**
 * 提交时的【节点级】判据（round292，O8 动作 1）。
 *
 * 它住在 L1/L2/L3 之外，因为三层判据的输入都是【一次增量操作】（一个 child、一条边），
 * 而这一条的输入是【提交后那张图整体】—— 正是这个差别让它能拦住
 * 「随一条无关的 add_edge 塞进图里的节点」（三层各自都只看那条边/那个 child）。
 */
describe("everyNodeDeclaresModelFamily：提交时逐节点判（不看这次改了什么）", () => {
  it("夹具那张完整图 ⇒ 通过（否则下面每一发红都可能来自夹具）", () => {
    expect(everyNodeDeclaresModelFamily(base()).ok).toBe(true);
  });

  it("缺 model_family ⇒ 拦，且 code 与 violatesNoSelfReview 同一词", () => {
    const org = base();
    delete node(org, "dev").model_family;
    const v = bad(everyNodeDeclaresModelFamily(org));
    expect(v.code).toBe("unknown_model_family");
    // 同一个 code 值不是省事：调用方（HTTP 的 422 body.code）只需要认一个词，
    // 而「缺家族」在保存期与提交期本来就是同一件事的两次问法。
    // ⚠ 这里【不能】用 validateNewEdge("dev","dev") 来对照 —— dev 对自己
    //    先命中 self_review（那条判据在家族那一维之前短路），拿到的 code 是
    //    self_review 而不是 unknown_model_family。第一版就是这么写的，
    //    于是这一发红在一个与被测对象无关的方向上。
    node(org, "dev").model_family = "";
    expect(bad(violatesNoSelfReview("dev", "tech", org)).code).toBe(
      "unknown_model_family",
    );
  });

  it("reason 里点名【是哪一个角色】缺 —— 否则 CEO 拿到一句无法行动的话", () => {
    const org = base();
    org.nodes.junior = { role_id: "junior", can_manage: false, reports_to: "dev" };
    const v = bad(everyNodeDeclaresModelFamily(org));
    expect(v.reason).toContain("junior");
  });

  it("空串与纯空格同判（yaml 里 `model_family:` 留空读进来就是这两种）", () => {
    for (const badFamily of ["", "   ", "\t"]) {
      const org = base();
      node(org, "dev").model_family = badFamily;
      expect(bad(everyNodeDeclaresModelFamily(org)).code).toBe("unknown_model_family");
    }
  });

  it("⭐ 反向 canary：非边端点的节点也判 —— 这正是三层判据漏掉的那一格", () => {
    // ghost 不在任何一条边上。拿它去问 L2 的边判据，得到的答案是「这两端都没问题」，
    // 因为那条边根本不认识它。这一发证明的不是"我的函数能红"，而是
    // 「它比三层判据多看了东西」—— 少了这一发，前面几发只证了"也能拦边端点"。
    const org = base();
    org.nodes.ghost = { role_id: "ghost", can_manage: false, reports_to: "product" };
    expect(validateNewEdge("dev", "tech", org, true).ok).toBe(true);
    expect(everyNodeDeclaresModelFamily(org).ok).toBe(false);
  });

  it("已知边界（登记，不修）：空图 ⇒ 通过", () => {
    // `orgGraphSchema.nodes` 是 `.default({})`，所以空图是一个合法值；
    // 「每个节点都声明了」在全称量词下对空集为真。
    // 记这一条是因为别把它读成防线：空图上这条判据【什么都没拦】，
    // 拦「一张空图进库」不属于本函数的射程（也没有别的判据在拦它）。
    expect(everyNodeDeclaresModelFamily({ nodes: {}, edges: [] }).ok).toBe(true);
  });
});

describe("schema：形状上的收紧", () => {
  it("can_manage 是【必填】：漏填不是「不是管理角色」，是加载期就报错", () => {
    expect(
      orgGraphSchema.safeParse({
        nodes: { a: { role_id: "a", reports_to: null } },
        edges: [],
      }).success,
    ).toBe(false);
  });

  it("未知键被拒：report_to 拼错不会退化成「所有汇报关系凭空消失」", () => {
    const r = orgGraphSchema.safeParse({
      nodes: { a: { role_id: "a", can_manage: true, report_to: null } },
      edges: [],
    });
    expect(r.success).toBe(false);
  });

  it("orgChange 是判别式：既没有 child 也没有 edge 的变更写不出来", () => {
    expect(orgChangeSchema.safeParse({ kind: "reparent" }).success).toBe(false);
    expect(
      orgChangeSchema.safeParse({ kind: "reparent", child_role: "a", new_parent_role: "b" })
        .success,
    ).toBe(true);
    // 多余的 kind 取值：
    expect(orgChangeSchema.safeParse({ kind: "delete" }).success).toBe(false);
  });

  it("⭐ 键≠node.role_id ⇒ schema 拒（round299 把这条从【登记的洞】翻成【判据】）", () => {
    /*
     * 这一发原来钉的是【反方向】：它证明 schema / rejectMalformed / validateNewNode
     * 三条判据对这种形状【全部放行】，并把修法登记成「下一格」。round299 落了那条修法
     * （orgGraphSchema 的 superRefine），所以主张翻向，原文里的诊断留着不删 ——
     * 那半段解释的是【为什么三条旧的都不管】，那是判据分工的账，不会因为加了新的而过期。
     *
     * 为什么值得拦：图有两批读者，一批按【键】查（gate 0 / handoff / modelFamily /
     * 岗位书落库那圈），一批按【值里的 role_id】查（汇报根、下级名单）。键 a / 值 b 时
     * 升级判据 `上级 === CEO` 两头各拿一半 ⇒ 永远不成立 ⇒ 升级永不触发。
     */
    const bad = orgGraphSchema.safeParse({
      nodes: {
        ceo: { role_id: "ceo", can_manage: true, reports_to: null },
        // 键是 a，值里的 id 是 b。
        a: { role_id: "b", can_manage: false, reports_to: "ceo" },
      },
      edges: [],
    });
    expect(bad.success).toBe(false);
    // 先按【判据没生效】处理再取 error：既是 zod 那份判别式联合要的收窄，
    // 也是一条前提自证 —— 如果哪天 superRefine 被人摘掉，这一发要说的是
    // 「夹具本该被拒」，而不是留一条 undefined 走到下面去变成一句看不懂的比对。
    if (bad.success) throw new Error("夹具本该被拒 ⇒ 那条 superRefine 没生效");
    // 诊断必须指得出【是哪一个键上的节点自称了别的 id】—— 只报「图不合法」等于
    // 让下一个人自己去猜是哪一半坏了。path 是 issueSummary 唯一读得出的字段。
    const issue = bad.error.issues.find((i) => i.path[0] === "nodes");
    expect(issue?.path).toEqual(["nodes", "a", "role_id"]);
    expect(String(issue?.message)).toContain("role_id=[b]");
    // 键上那个节点【自己】没错：坏的是"键与自称不一致"这一对，不是节点形状。
    expect(
      orgGraphSchema.safeParse({
        nodes: {
          ceo: { role_id: "ceo", can_manage: true, reports_to: null },
          a: { role_id: "a", can_manage: false, reports_to: "ceo" },
        },
        edges: [],
      }).success,
    ).toBe(true);
    /*
     * 旧注释里那两条「也不管」今天【依旧成立】，而且必须继续钉住 ——
     * 判据落在 schema 那一层，不代表下面两层也长出了眼睛。把它们留在这里是因为
     * 有人会把「这条缝被关掉了」读成「谁都能认出坏图了」：把这张图直接喂给
     * rejectMalformed（不走 schema）它照样放行。
     */
    const mismatched: OrgGraph = {
      nodes: {
        ceo: { role_id: "ceo", can_manage: true, reports_to: null },
        a: { role_id: "b", can_manage: false, reports_to: "ceo" },
      },
      edges: [],
    };
    expect(rejectMalformed(mismatched)).toBeNull();
    expect(
      validateNewNode(
        { role_id: "b", can_manage: false, reports_to: "ceo" },
        { nodes: { ceo: { role_id: "ceo", can_manage: true, reports_to: null } }, edges: [] },
      ),
    ).toEqual({ ok: true });
  });

  it("反向对照两发：空图与【每个键都等于自己的 role_id】⇒ 该绿（证明新判据不是恒红）", () => {
    // 少了这一发，"加了一条 superRefine" 与 "加了一条恒失败的 superRefine" 在上一发上
    // 读起来一模一样 —— 上一发只证得了【坏的被抓】，证不出【好的过】。
    expect(orgGraphSchema.safeParse({ nodes: {}, edges: [] }).success).toBe(true);
    expect(
      orgGraphSchema.safeParse({
        nodes: {
          ceo: { role_id: "ceo", can_manage: true, reports_to: null },
          tech: { role_id: "tech", can_manage: true, reports_to: "ceo" },
          dev: { role_id: "dev", can_manage: false, reports_to: "tech" },
        },
        edges: [{ from: "dev", to: "tech", review_gate: true }],
      }).success,
    ).toBe(true);
  });

  it("⭐ 一条图里多个坏键 ⇒ 每个键各报一条 issue（判据是逐节点而不是遇第一个就退）", () => {
    // 逐条报是刻意的：一次 422 要能看完就修完。只报第一条会让 CEO 改一次发一次、
    // 连改 N 次才看到全貌 —— 那条形状在 0006 §7 里记过好几次的反面就是它。
    const r = orgGraphSchema.safeParse({
      nodes: {
        ceo: { role_id: "ceo", can_manage: true, reports_to: null },
        a: { role_id: "b", can_manage: false, reports_to: "ceo" },
        x: { role_id: "y", can_manage: false, reports_to: "ceo" },
      },
      edges: [],
    });
    expect(r.success).toBe(false);
    if (r.success) throw new Error("夹具本该被拒 ⇒ 那条 superRefine 没生效");
    const keys = r.error.issues
      .filter((i) => i.path[0] === "nodes")
      .map((i) => String(i.path[1]))
      .sort();
    expect(keys).toEqual(["a", "x"]);
    // 前提自证：ceo 那个键【没被报】，否则上面那个相等是「全都报了」造成的。
    expect(keys).not.toContain("ceo");
  });

  it("actor.type 只有两值，编不出第三种", () => {
    expect(orgActorSchema.safeParse({ type: "system", id: CEO }).success).toBe(false);
    expect(orgActorSchema.safeParse({ type: "human", id: CEO }).success).toBe(true);
  });
});

describe("原语自身（判据的地面）", () => {
  it("pathToRoot：根在第 1 层（ORG_MAX_DEPTH 的口径全靠这一条钉住）", () => {
    const org = base();
    expect(pathToRoot(org, CEO)).toEqual([CEO]);
    expect(pathToRoot(org, "dev")).toEqual(["dev", "tech", CEO]);
  });

  it("pathToRoot 在有环的图上【不转圈】（有限步返回）", () => {
    const org = base();
    org.nodes.tech.reports_to = "dev";
    expect(() => pathToRoot(org, "dev")).not.toThrow();
    expect(pathToRoot(org, "dev").length).toBeGreaterThan(0);
  });

  it("reportsToCycle 在无环图上返回 null，且能报出环上的节点", () => {
    expect(reportsToCycle(base())).toBeNull();
    const org = base();
    org.nodes.tech.reports_to = "dev";
    const cyc = reportsToCycle(org);
    expect(cyc).not.toBeNull();
    expect(cyc).toContain("tech");
    expect(cyc).toContain("dev");
  });

  it("委派环【不是】汇报环：dev ⇄ test 不触发 reportsToCycle", () => {
    // 两套关系分开建模的全部理由就在这条用例上。合成一张 edge 表的话，
    // 这条断言与「同行评审合法」那条（上面 L2 里）会直接互相矛盾。
    const org = base();
    org.nodes.test = { role_id: "test", can_manage: false, reports_to: "tech", model_family: "gpt" };
    org.edges.push({ from: "dev", to: "test", review_gate: true });
    org.edges.push({ from: "test", to: "dev", review_gate: true });
    expect(reportsToCycle(org)).toBeNull();
  });
});
