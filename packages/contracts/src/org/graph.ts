/**
 * 组织图的数据形状与图原语（计划 Task 3.1 的「数据层」那一半，规格 §18.3）。
 *
 * ── 为什么在 packages/contracts 而不是 hub ─────────────────────────────
 * 计划对这一条写得很硬：**同一份代码前后端共用**。拖拽那一侧要在鼠标抬起的瞬间
 * 决定「回弹还是落下」，保存那一侧要在写库前再判一次。两处各写一份的漂移方式是
 * 「前端允许、Hub 拒绝」—— 而它的症状是节点先落下、转圈、再弹回并给一句
 * 用户在本地找不出原因的话。规格 §18.3 结尾那句「前端校验只是体验优化，
 * 安全边界在 Hub 内」讲的就是这层关系：两侧必须能给出【同一个答案】。
 * 放 hub 里则前端要么复制一份、要么依赖 hub（dependency-boundary 守卫直接挡，
 * 见 test/arch/dependency-boundary.test.ts）。
 *
 * ── 本模块只有类型、schema 与纯图算法，没有第三样东西 ──────────────────
 * 不读库、不读网络、不读岗位书文件。运行中任务（validateOrgChange 要用）由调用方
 * 查好后【作为参数传进来】—— 规格 §18.3 的示例代码在那里写的是 `getRunningTasks()`，
 * 而【同节紧接着的段落】自己写着「纯函数 + zod 校验，不查 LLM、不读网络」。
 * 那段代码与那段话互相矛盾，我按那段话实现，理由记在 validate.ts。
 *
 * ── 一棵树 + 若干委派边，两套关系【分开建模】────────────────────────────
 * 规格 §18.2 把五种拖拽语义分成「改汇报关系」与「建委派边」两类，
 * §18.3 给这两类的是【不同的判据组】（前者管环/深度/管理角色，后者管门控/自审/升级可达）。
 * 所以我没有把它们塞进同一张 `edges` 表再加一个 `kind` 字段。形状决定记在这里，
 * 因为它决定了「环」这个词在本模块里只有一种含义：
 * **汇报环**是非法的（组织不能自我嵌套），而**委派环**是合法的同行评审
 * （`dev → test → dev` 在 hub 那边被明确放行，见 graph/gates/author-reviewer.ts 的
 * independentReviewerPath 注释）。合成一张表的第一件事就是分不清这两种环。
 */
import { z } from "zod";

/**
 * CEO 的角色 id。
 *
 * 这条字符串在仓库里已经有了两个来源：`graph/gates/author-reviewer.ts` 的
 * `CEO_ROLE_ID`（hub，运行时门控用）与 `http/real-deps.ts` 的 `CEO_ACTOR`（hub，
 * 审计身份用）。第三个来源写在契约层是因为【归属】而不是省事：组织图的根节点、
 * 「谁能改组织」这两件事是【契约性质】，前端要在不 import hub 的前提下判
 * 「这个节点能不能被拖」（规格 §18.2 的非法操作之一）。
 * hub 那两处本应改成本常量的引用 —— **我没有顺手改**，因为改的是已提交的门控代码，
 * 而那批门控测试是本仓最贵的一类防线（§8.2），不该被一次 org 改动顺带动到。
 * 三条常量并存这件事本身登记进 0011，别让下一个人以为它们是三套语义。
 */
export const CEO_ROLE_ID = "ceo";

/**
 * 组织层级上限。
 *
 * 名字取 `ORG_MAX_DEPTH` 而不是规格里的裸 `MAX_DEPTH`：委派图的深度上限
 * （§18.3 的 wouldExceedMaxDepth）与汇报树的深度上限是【两个不同的数】——
 * 一个是树高，一个是「加一条边之后委派链的最长路径」。规格里两处共用一个名字，
 * 我就得替它分开；分开的代价是规格那两句读起来要对应到这里两个常量。
 */
export const ORG_MAX_DEPTH = 5;

/**
 * 节点。
 *
 * `canManage` 是【必填】而不是 `.optional()`。规格 §18.3 的示例写的是
 * `!org.nodes[newParent].canManage` —— 那个写法在字段缺失时把「没声明」当成
 * 「不是管理角色」，方向上是【收紧】，所以结果碰巧对；但碰巧对的问题是
 * 它同时让「漏填」变成一个静默的、每天少几个可拖目标的 bug，
 * 而必填把它变成一个加载期就报出来的 schema 错误。
 * 这一维和 hub 那边 model_family 为空的处理是同一个判据
 * （author-reviewer.ts：缺信息时必须落到【有人来判】，不能落到放行）。
 */
export const orgNodeSchema = z
  .object({
    role_id: z.string().min(1),
    /** 能不能接收汇报（规格 §18.3 判据 2 的输入）。 */
    can_manage: z.boolean(),
    /**
     * 模型家族。可选是【数据形状】上的可选（一张尚未配模型的草稿图里可能没有），
     * 但判定上是【缺了就拦】—— 见 violatesNoSelfReview：缺家族时不给放行，
     * 与 hub 的 unknown_model_family 同一个方向。
     */
    model_family: z.string().min(1).optional(),
  })
  .strict();
export type OrgNode = z.infer<typeof orgNodeSchema>;

/**
 * 委派边：`from` 产出，`to` 审阅。方向口径与 hub 的 DelegationEdge 一致
 * （author-reviewer.ts 的 `independentReviewerPath(author, edges)` 收的就是这个方向）。
 * 两套边类型【有意不合并】：hub 那一套不带审阅门控的载荷（它判的是运行时的一跳），
 * 而组织图这一套必须带（§8.2 第 4 条「门控绑在边上」在保存期的载体就是这里）。
 */
export const delegationEdgeSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    /** 审阅门控。缺失即「这条边上的产出没人看」，validateNewEdge 的第一条判据。 */
    review_gate: z.boolean(),
  })
  .strict();
export type DelegationEdge = z.infer<typeof delegationEdgeSchema>;

/**
 * 整张组织图。
 *
 * 汇报关系是 `nodes` 上的 `reports_to` 而不是单独的边表 —— 因为「一个角色只有一个直接
 * 上级」是【数据形状上的事实】（岗位书里 `reports_to` 就是一个标量，见 charter.ts:81）。
 * 用边表表达它，就要额外写一条「同一 child 不得有两条 parent」的校验；
 * 用标量表达它，那条不变量由类型给，不需要人写、也就没人漏。
 *
 * `strict()` 是刻意的：编辑器草稿态将来会往节点上塞坐标（§18.2 操作 A 的 ui_position），
 * 那时应该【显式给 schema 加字段】，而不是让未知键静默通过 —— 后者会让一次
 * 「把 reports_to 拼成 report_to」的错别字变成「所有汇报关系凭空消失」，
 * 而一张没有汇报关系的图在三层校验下【全绿】（没有树 ⇒ 没有环、没有超深、
 * 升级可达性判定时也只会有一个孤立节点集）。
 */
export const orgGraphSchema = z
  .object({
    nodes: z
      .record(z.string().min(1), orgNodeSchema.extend({
        /** 直接上级；CEO 为 null。 */
        reports_to: z.string().min(1).nullable(),
      }))
      .default({}),
    edges: z.array(delegationEdgeSchema).default([]),
  })
  .strict();
export type OrgGraph = z.infer<typeof orgGraphSchema>;
export type OrgNodeId = keyof OrgGraph["nodes"];

/**
 * 一次组织变更（保存/确认那一层要的东西，规格 §18.3 第三个函数）。
 *
 * 形状是【判别式】而不是一个塞满可选字段的对象：新增边时只有 kind/edge 有值，
 * 改汇报时只有 kind/child/newParent。写成可选字段的话，
 * 「一个既没有 child 也没有 edge 的变更」是一个合法值，而它只能是 bug。
 * zod 的 discriminateUnion 让这个值写不出来。
 */
export const orgChangeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("reparent"),
      child_role: z.string().min(1),
      new_parent_role: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal("add_edge"), edge: delegationEdgeSchema }).strict(),
]);
export type OrgChange = z.infer<typeof orgChangeSchema>;

/**
 * 发起者。
 *
 * 只有两值而不是一个 actor 表：规格 §18.3 第三个函数只问一件事
 * —— `actor.type !== "human" || actor.id !== "ceo"`。写成 `{type, id}` 是
 * 把「人的种类」这一维留给以后（多审批人时 type 会有第二个值），
 * 而它【现在】不参与判定，所以我不给它编第三个取值。
 */
export const orgActorSchema = z
  .object({
    type: z.enum(["human", "agent"]),
    id: z.string().min(1),
  })
  .strict();
export type OrgActor = z.infer<typeof orgActorSchema>;

/* ───────────────────────── 图原语 ───────────────────────── */

/** 节点存在性。返回 undefined 而不是抛：校验器要把「不存在」也变成一个 reason。 */
export function nodeOf(
  org: OrgGraph,
  roleId: string,
): OrgGraph["nodes"][string] | undefined {
  return Object.prototype.hasOwnProperty.call(org.nodes, roleId)
    ? org.nodes[roleId]
    : undefined;
}

/**
 * `roleId` 的全部下级（传递闭包，不含自身）。
 *
 * 环检测靠它：把 child 挂到 newParent 之下会成环 ⇔ newParent 本来就在 child 的下级里。
 * 这是 §18.3 的写法，也是本模块唯一的环判据 —— 它只看【汇报树】，
 * 委派环不参与（理由在文件头）。
 *
 * 实现上刻意不用递归：一张【已经】有环的图（从库里读出来的脏数据、
 * 或前端编辑中途的草稿）会让递归无限下降直到栈溢出。而校验器要在这种图上
 * 【给出一个 reason】而不是崩 —— 「图坏了」正是用户最需要看到一句人话的时刻。
 * 用显式工作表 + visited，有环时它是有限步返回已到达的集合（环本身由
 * reportsToCycle 单独判，见下）。
 */
export function getDescendants(org: OrgGraph, roleId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([roleId]);
  const frontier: string[] = [roleId];
  while (frontier.length > 0) {
    const cur = frontier.pop() as string;
    for (const [id, node] of Object.entries(org.nodes)) {
      if (node.reports_to !== cur || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      frontier.push(id);
    }
  }
  return out;
}

/**
 * 沿 reports_to 上升的路径，从自身到根（含自身）。
 *
 * CEO 深度算 1 还是 0 这件事规格没说，我在 ORG_MAX_DEPTH 的调用点定义：
 * **根 = 1**（`depthOf(org, "ceo") === 1`），于是「CEO + 4 层」正好用满上限 5。
 * 这个约定必须写在代码里，因为「深度 > 5 拒绝」这条判据差一层就是差一整层组织。
 *
 * 有环时不无限走：走到重复节点就停，把环上的这一段交出去由 reportsToCycle 报告。
 */
export function pathToRoot(org: OrgGraph, roleId: string): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let cur = roleId;
  for (;;) {
    const node = nodeOf(org, cur);
    // 找不到 = 上级 id 不在图里（悬空引用）。这里【不报错】而是就此收尾：
    // 悬空由 rejectMalformed 给出带角色名的 reason，两处各报一次会让用户
    // 看到两条指向同一处的错误；而 depth 在这里收敛成一个【偏小】的数，
    // 那个方向上的放行风险由 rejectMalformed 挡（见 validate.ts）。
    if (node === undefined) break;
    if (seen.has(cur)) break; // 已在路上 ⇒ 遇环，停止而不是转圈
    seen.add(cur);
    path.push(cur);
    if (node.reports_to === null) break; // 根
    cur = node.reports_to;
  }
  return path;
}

/** 含自身的高度（根 = 1）。叶子为 1。有环时为有限步（同 pathToRoot）。 */
export function depthOf(org: OrgGraph, roleId: string): number {
  return pathToRoot(org, roleId).length;
}

/**
 * 汇报关系里是否存在环。返回环上的一条路径，无环返回 null。
 *
 * 为什么原语里要有这一条，而 §18.3 的示例里没有：**示例的环判据只在
 * 「改完之后」的图上判**（`getDescendants(child, org).includes(newParent)`），
 * 那挡住了「这次拖拽造出环」。它挡不到【图本来就有环】—— 而校验器在这种图上
 * 必须给出结论，不能给出一个错误的 ok。这不是假想的形状：库里存的是
 * `graph_json`（delegation_graphs 表），一次手工修库或一个旧版本写入就能造出它。
 *
 * 用法上它是 validateOrgChange 的入口守卫，而不是三个函数里的一条判据。
 */
export function reportsToCycle(org: OrgGraph): string[] | null {
  const state = new Map<string, "visiting" | "done">();
  for (const start of Object.keys(org.nodes)) {
    if (state.get(start) === "done") continue;
    const chain: string[] = [];
    let cur = start;
    for (;;) {
      const node = nodeOf(org, cur);
      if (node === undefined) break; // 悬空引用由 rejectMalformed 单独报，这里不重复
      // 「visiting」只可能来自【本轮】：上一轮走到的节点在收尾时全被标成 done，
      // 所以撞见 visiting 就一定意味着本轮的 chain 上有一个环。
      // 这一条依赖「每个节点至多一个 reports_to」（functional graph）——
      // 那个前提是数据形状给的（reports_to 是标量，见 orgGraphSchema 的注释），
      // 不是我校验出来的。改成边表表达汇报关系时，这段推理就【不再成立】。
      if (state.get(cur) === "visiting") {
        const at = chain.indexOf(cur);
        return chain.slice(at < 0 ? 0 : at).concat(cur);
      }
      state.set(cur, "visiting");
      chain.push(cur);
      if (node.reports_to === null) break;
      cur = node.reports_to;
    }
    for (const id of chain) state.set(id, "done");
  }
  return null;
}

/**
 * 从 `from` 出发，沿【委派边】能否到达 `to`。
 *
 * BFS 在【有向】边上做。方向必须是有向的：「升级路径可达 CEO」讲的是
 * 产出能一路往上被看见，把边当无向用会让一条 CEO→dev 的边
 * 造成「dev 可达 CEO」的假象 —— 那正是 §18.3 判据 3 要拦的那件事。
 *
 * V12（计划已验证事实）在这条线上写着：框架对「升级路径可达 CEO」**帮不上忙**，
 * 条件边声明 `ends: ["approval", "__end__"]` 而总返回 END 也编译通过。
 * 也就是说这条可达性只能在这里自己算，算错一次就是审批可被绕过而无报错。
 *
 * ── 这里【曾经】有一个 extra 参数，我把它删了，理由值得留着 ──────────
 * 第一版的签名是 `canReach(org, from, to, extra?)`，多出来的那一位用来把
 * 「正在校验、还没写进 org 的那条边」塞进遍历。调用点写的是
 * `canReach(org, target, CEO, {from: source, to: target, ...})`，
 * 注释里那句理由是「加边之后才可达成，所以它必须参与遍历」—— **那句是错的**，
 * 而且错的方向很典型：它听起来显然对（「图变了当然要按新图算」），
 * 所以写的时候我完全没有怀疑它。
 *
 * 反证只需一步：一条从 `target` 出发、用上了边 `source → target` 的路径，
 * 必然【先回到 target】才能踩到那条边（那条边的头就是 target）。
 * 把中间那个环剪掉，就得到一条【不使用】新边、终点相同的路径。
 * 于是「从 target 出发可达的集合」在加这条边前后【恒等】，extra 永远不影响结果。
 * 依据是上面那步剪环论证，不是试出来的。我在三种图形状（新边指向已在链上的节点 /
 * 反向边 / 二元环）上比对过加与不加的可达集，都一样 —— 那只是佐证；
 * 第四个用例【没跑出来】，因为我那份探针自己写错了（在内层 for 里 shift 队列，
 * 某些形状下死循环，挂在那里被我中止），所以「四处都测过」这句不能说。
 *
 * 顺带把边界划准，免得这条删减被读成一个通用结论：加边 u→v 不改变
 * 「从 from 出发的可达集」的情形不止我这一种 —— v 本来就在可达集里时也不变
 * （可达集对传递封闭，v 能到的地方早在集合内）。【会变】的是
 * 「u 可达而 v 不可达」。我这一处落在第一种情形里。
 *
 * 为什么删掉而不是留着「以后也许用得上」：一个恒不生效的参数会骗到两类人 ——
 * 读的人以为判据考虑了新边（其实没有，而他会因此【不去想】这件事），
 * 改的人以为传了它就一定是「按新图判」（其实取决于上面那个判据）。
 * 真正【需要】按新图判的地方是深度判据（wouldExceedMaxDepth），那里新边
 * 确实在路径上，所以它自己展开了边集而没有走 canReach。
 * 「同一件事在两个函数里一边需要一边不需要」这件事，就是留一个恒惰性参数的
 * 代价 —— 它让下一个人以为不需要想清楚。
 */
export function canReach(org: OrgGraph, from: string, to: string): boolean {
  if (from === to) return true;
  const adj = new Map<string, string[]>();
  for (const e of org.edges) {
    const list = adj.get(e.from);
    if (list === undefined) adj.set(e.from, [e.to]);
    else list.push(e.to);
  }
  const seen = new Set<string>([from]);
  const frontier: string[] = [from];
  while (frontier.length > 0) {
    for (const nxt of adj.get(frontier.shift() as string) ?? []) {
      if (nxt === to) return true;
      if (seen.has(nxt)) continue;
      seen.add(nxt);
      frontier.push(nxt);
    }
  }
  return false;
}
