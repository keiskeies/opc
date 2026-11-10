/**
 * 组织图三层确定性校验（规格 §18.3，计划 Task 3.1）。
 *
 * ── 「三层」是哪三层，以及为什么分开 ──────────────────────────────────
 *  L1 单节点能否被这样挂（validateReparenting）—— 环、管理角色、深度、CEO 根
 *  L2 单条边能否存在（validateNewEdge）—— 门控、自审、升级可达、深度
 *  L3 这次变更由谁发起、影响什么（validateOrgChange）—— 鉴权 + 运行中任务确认
 * 分开不是为了好看：前端在拖拽过程中只能拿到【一次增量操作】，它必须能在
 * 鼠标抬起那一刻就给出回弹理由（§18.2 的 D/E 两条非法操作也是这一层的事）；
 * 而保存时才有的是「谁点的、现在有几个任务在跑」。把三压进一二，
 * 前端就得为了做一次实时高亮去问 Hub 有没有在跑的任务 —— 那正好把
 * 「体验优化」和「安全边界」重新缝回一处，§18.3 结尾要避免的就是这个。
 *
 * ── 三条我自己定的口径（规格没给，而实现必须给；分歧登记进 0011）──────
 *  ① CEO 深度 = 1（不是 0）。见 graph.ts 的 pathToRoot。
 *  ② 「新增边使层级超过上限」这条判据里的「层级」，我按【委派链最长路径】算，
 *     不是汇报树高。理由：§18.3 把它放在 validateNewEdge 里，而那个函数的输入
 *     只有边能变；如果它判的是树高，它在新增边时【永远不可能触发】
 *     （加一条边不改 reports_to）—— 一条不能触发的判据不是保守，是假装有防线。
 *     代价：委派链的语义是「谁审谁」，把它当深度算，一条 dev→test→tech→dev 的
 *     同行评审环会把长度算成无限……所以我在有环时【不按环算长度】，见下。
 *  ③ violatesNoSelfReview 在【缺 model_family】时判违规（拦），而不是跳过这一维。
 *     与 hub 的 unknown_model_family 同方向（author-reviewer.ts 里那句
 *     「缺这一维时不放行：否则【不声明家族】就成了绕过同家族拦截的通路」）。
 *     规格 §18.3 那句原文只写「审阅者不能是产出者的直接执行者」，
 *     同家族那一维是 §5.9 第 1 条 + §24 风险 1 的，我按 hub 已有的口径合并进来。
 *
 * ── 一处规格自相矛盾，以及我按哪一半实现 ──────────────────────────────
 * §18.3 第三个函数的示例代码里写着 `const running = getRunningTasks()` —— 一次取数。
 * 而同一节【紧接着】的那段加粗原文写着「全部是确定性代码」「纯函数 + zod 校验，
 * 不查 LLM、不读网络」。两句在同一节里冲突。我按后一句实现：运行中任务由调用方
 * 作为【参数】传入（RunningTasksInput）。选后一句不是偏好，是因为后一句是【要求】
 * 而前一句是【示例】；并且按前一句实现会让这三个函数在纯 Node 之外还要一个库连接，
 * 「同一份代码前后端共用」当场失效 —— 前端拿不到库。
 * 代价：调用方可能传一个【过期的】列表（它查完之后又有任务开始跑）。
 * 所以 L3 的确认结论是【提示】而不是【闸门】，真正的隔离由 §18.4 阶段 2 那条
 * 「运行中任务用创建时版本、不重建图」保证。这句话是本模块最重要的边界声明：
 * **validateOrgChange 不保证运行中任务不受影响，它保证的是有人被问过一句。**
 */
import {
  canReach,
  CEO_ROLE_ID,
  depthOf,
  getDescendants,
  nodeOf,
  ORG_MAX_DEPTH,
  type OrgActor,
  type OrgChange,
  type OrgGraph,
  reportsToCycle,
} from "./graph.js";

/**
 * 判定结果。与规格的 `Verdict` 同形（`{ok, reason}`），多加一个 `code`。
 *
 * 加 code 的理由不是方便：`reason` 是【给人看的一句话】，它会随措辞改动；
 * 而 §18.2 的操作 D/E 与自动化用例要按【哪条判据】分支（例如「CEO 不可拖」
 * 这条要决定的是拖拽手势根本不启动，而「超深」只是回弹）。
 * 让调用方去 match 中文 reason，等于把判据变成字符串协议 ——
 * hub 那边的 author-reviewer.ts 早先踩过这一点，所以它也是 code + reason 双份。
 */
export type Verdict =
  | { ok: true }
  | { ok: false; reason: string; code: RejectCode };

/** 需要人确认才能继续（不是拒绝）。见 RunningTasksInput。 */
export type NeedsConfirmation = {
  ok: true;
  needsConfirmation: string;
  runningTaskIds: readonly string[];
};

export type RejectCode =
  | "unknown_role"
  | "would_create_cycle"
  | "parent_not_manager"
  | "depth_exceeded"
  | "ceo_is_root"
  | "missing_review_gate"
  | "self_review"
  | "unknown_model_family"
  | "same_model_family"
  | "escalation_unreachable"
  | "report_cycle_present"
  | "dangling_report"
  | "not_ceo";

function reject(code: RejectCode, reason: string): Verdict {
  return { ok: false, reason, code };
}

/**
 * 校验器拿到的图【不合规】时给的答案。
 *
 * 为什么不直接往下判：三个函数的每一条判据都假设「图是一张正常的图」
 * （深度是有限数、根只有一个）。图本身坏了的时候，往下判会给出【ok】——
 * 一张 reports_to 成环的图，depthOf 因为 visited 保护而给出一个有限的短值，
 * 于是「深度超限」这条在真正超深的坏图上反而不触发。
 * 静默放行坏输入，是本仓反复出现的那一类最贵缺陷（0003 / 0005 各记过一次同形）。
 */
export function rejectMalformed(org: OrgGraph): Verdict | null {
  const cyc = reportsToCycle(org);
  if (cyc !== null) {
    return reject(
      "report_cycle_present",
      "当前组织图的汇报关系本身成环（" +
        cyc.join(" → ") +
        "），无法在此之上判断新变更。请先修掉这条环。",
    );
  }
  for (const [id, node] of Object.entries(org.nodes)) {
    const p = node.reports_to;
    if (p !== null && nodeOf(org, p) === undefined) {
      return reject(
        "dangling_report",
        "角色 [" +
          id +
          "] 的上级 [" +
          p +
          "] 在图里不存在。汇报关系指向不存在的节点时，深度与升级路径都无从计算。",
      );
    }
  }
  return null;
}

/**
 * L1：把 `childRole` 挂到 `newParent` 之下，合法吗。
 *
 * 判据顺序照规格 §18.3 的示例（环 → 管理角色 → 深度 → CEO 根），但【CEO 那条我挪到最前】，
 * 且这是本篇一处刻意的偏离。挪的理由是失败信息的可用性：拖 CEO 节点时，
 * 「CEO 是根节点」是【唯一】能被用户行动的理由，而按原顺序它会排在
 * 「会形成环」之后 —— CEO 的下级包含所有人，所以把 CEO 挂到任何节点下
 * 都【先】命中环判据，用户看到的是「不能将角色挂到自己的下级之下」，
 * 一句他无法用来行动的话（他不知道该改哪里，因为正确回答是「这根本不该发生」）。
 * 代价：判据顺序与规格示例不一致，读规格的人对照代码时会看到四处换位。
 */
export function validateReparenting(
  childRole: string,
  newParent: string,
  org: OrgGraph,
): Verdict {
  const malformed = rejectMalformed(org);
  if (malformed !== null) return malformed;
  const child = nodeOf(org, childRole);
  if (child === undefined) {
    return reject("unknown_role", `角色 [${childRole}] 不在组织图里。`);
  }
  if (childRole === CEO_ROLE_ID) {
    return reject(
      "ceo_is_root",
      "CEO 是组织根节点，不可改变汇报关系（规格 §18.3 判据 4）。",
    );
  }
  if (newParent === childRole) {
    // 自环。放在环判据【之前】是必须的：getDescendants 不含自身，
    // 所以「挂到自己下面」按示例那句 getDescendants(child).includes(newParent)
    // 判是【放行】的 —— 规格那段示例代码漏了自环这一格。
    return reject("would_create_cycle", `角色 [${childRole}] 不能挂到自己之下。`);
  }
  const parent = nodeOf(org, newParent);
  if (parent === undefined) {
    return reject("unknown_role", `上级角色 [${newParent}] 不在组织图里。`);
  }
  if (getDescendants(org, childRole).includes(newParent)) {
    return reject(
      "would_create_cycle",
      `不能将角色挂到自己的下级之下：[${newParent}] 是 [${childRole}] 的下级。`,
    );
  }
  if (!parent.can_manage) {
    return reject(
      "parent_not_manager",
      `${newParent} 不是管理角色，不能接收汇报（规格 §18.3 判据 2）。`,
    );
  }
  // 深度：挂上去之后 child 这一支的深度 = newParent 的深度 + 1，
  // 而 child 下面还挂着东西，所以要加上 child 自己那一支的【高度】，
  // 不能只看 newParent 有多深 —— 规格示例那句
  // `getDepth(newParent, org) + 1 > MAX_DEPTH` 只算了被挂节点自己，
  // 漏了它【带着的下级】：把一整支三层深的子树挂到第四层下面，
  // 那句判据给出 4+1=5 通过，而实际上最深处到了 7。
  // 这是本篇第二处偏离（也是我认为示例的一处真错），推导与用例见 0011。
  const parentDepth = depthOf(org, newParent);
  const movedHeight = heightBelow(org, childRole);
  if (parentDepth + movedHeight > ORG_MAX_DEPTH) {
    return reject(
      "depth_exceeded",
      `组织层级超过 ${ORG_MAX_DEPTH} 层上限：挂上去之后最深处到第 ` +
        `${parentDepth + movedHeight} 层（${newParent} 在第 ${parentDepth} 层，` +
        `[${childRole}] 那一支本身有 ${movedHeight} 层深）。`,
    );
  }
  return { ok: true };
}

/**
 * `roleId` 那一支的高度，含自身（叶子 = 1）。
 *
 * 只沿 reports_to 向下走。它【不自己】处理有环的图：调用前 rejectMalformed
 * 已经把成环的图拒掉了，所以这里的 visited 保护只是【不炸】的保证，不是业务判据。
 * 要说清它挡住什么、挡不住什么 ——
 *  · 挡住：递归在坏图上无限下降直到栈溢出（校验器崩掉，用户看不到一句人话）。
 *  · 挡不住：环会让这里返回一个【偏小】的高度，于是深度判据【放行】。
 * 所以「坏图不得放行」这条红是 rejectMalformed 挣来的，不是这里挣来的。
 * 把这个区别写下来是因为它决定了将来谁能动哪一处：若有人把 rejectMalformed
 * 挪走或改成告警，这里就从「防御」变成「唯一的闸门」，而它是拦不住放行方向的。
 */
function heightBelow(org: OrgGraph, roleId: string): number {
  let best = 0;
  const seen = new Set<string>();
  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    best = Math.max(best, depthOf(org, id) - depthOf(org, roleId) + 1);
    for (const [cid, node] of Object.entries(org.nodes)) {
      if (node.reports_to === id) walk(cid);
    }
  };
  walk(roleId);
  return best;
}

/**
 * L2：加一条委派边 `source → target`（source 产出，target 审阅），合法吗。
 *
 * 判据顺序照规格。两处偏离，都写在下面。
 */
export function validateNewEdge(
  source: string,
  target: string,
  org: OrgGraph,
  /**
   * 这条边上的审阅门控。规格 §18.3 的签名里没有这一位 —— 它写的是
   * `hasReviewGate(source, target, org)`，也就是从 org 里查这条【已存在】的边。
   * 但 §18.2 操作 C 的流程是 `onConnect → validateNewEdge → 通过后弹出边配置面板`，
   * 门控配置在【校验之后】才填。所以按规格字面实现，第一条新边【必然】被
   * 「必须配置审阅门控」拒掉（它还不存在于 org 里）—— 这个功能写不出来。
   * 我把它做成入参，缺省 false（= 保守：没说带门控就是不带）。
   * 这一处是规格示例与规格正文互相矛盾、我按正文（§8.2 第 4 条门控绑在边上）实现。
   */
  reviewGate = false,
): Verdict {
  const malformed = rejectMalformed(org);
  if (malformed !== null) return malformed;
  for (const [who, id] of [
    ["产出方", source],
    ["审阅方", target],
  ] as const) {
    if (nodeOf(org, id) === undefined) {
      return reject("unknown_role", `${who}角色 [${id}] 不在组织图里。`);
    }
  }
  if (!reviewGate) {
    return reject(
      "missing_review_gate",
      "委派边必须配置审阅门控（规格 §8.2 第 4 条：门控绑定在边上、不可绕过）。",
    );
  }
  const self = violatesNoSelfReview(source, target, org);
  if (!self.ok) return self;
  // 这里【不】把待加的边传给 canReach —— 传了也不改变结果，论证与教训在
  // graph.ts 的 canReach 注释里（那个参数存在过，被删了）。
  // 判据本身就是规格那句 canReach(target, "ceo")。
  if (!canReach(org, target, CEO_ROLE_ID)) {
    return reject(
      "escalation_unreachable",
      `委派边会导致升级路径断裂：[${target}] 无法到达 CEO。` +
        "规格 §18.3 判据 3 —— 产出必须能一路被看见。（计划 V12：LangGraph 对这件事帮不上忙，" +
        "条件边声明 ends 却总返回 END 也编译通过，所以这条只能在保存时自己判。）",
    );
  }
  const deep = wouldExceedMaxDepth(org, source, target);
  if (!deep.ok) return deep;
  return { ok: true };
}

/**
 * §8.2 第 1 条 + §5.9 第 1 条：作者不给自己打分，同家族要显式批准。
 *
 * 这一维与 hub/graph/gates/author-reviewer.ts 的 sameFamilyReviewBlock 有【重叠但不重合】：
 * 那边判的是「运行时这一次审阅的双方 + 一张批准凭据」，这里判的是
 * 「这条边【将来】会不会导致自审」，而 org 里没有 model_family 之外的运行时信息
 * （没有 approval 凭据 —— 凭据在 review_gates 表里，不在图里）。
 * 所以两份判据【不能合并成一份】：合并要么让运行时那份读不到批准，
 * 要么让保存时这份假装读得到批准。共同的部分只有「同一角色即拒」那一句，
 * 而它一句话的量不足以撑起共享模块，硬共享会让两个模块互相 import 出环。
 * 这条重复是我权衡后【选择】的，登记在 0011 等一次审视。
 *
 * 入参节点【可以】不在图里（本函数被单独调用时，比如属性面板改 model_family 之后
 * 重判已有的边）。那种情况报 unknown_model_family 而不是 unknown_role ——
 * 方向是【拦】，而两种 code 都拦；选前者是因为「读不到家族」是对这个节点唯一诚实的说法。
 */
export function violatesNoSelfReview(
  source: string,
  target: string,
  org: OrgGraph,
): Verdict {
  if (source === target) {
    return reject(
      "self_review",
      `产出者与审阅者是同一角色 [${source}] —— 规格 §8.2 第 1 条「作者不给自己打分」，` +
        "这是图结构上的硬约束，不接受运行时豁免。",
    );
  }
  const a = nodeOf(org, source)?.model_family;
  const b = nodeOf(org, target)?.model_family;
  if (a === undefined || a.trim() === "" || b === undefined || b.trim() === "") {
    return reject(
      "unknown_model_family",
      `产出方或审阅方未声明 model_family，无法判定是否同源（§5.9 第 1 条 / §24 风险 1）。` +
        "缺这一维时【拦】而不是跳过：否则「不声明家族」就成了绕过同家族拦截的通路。",
    );
  }
  if (a === b) {
    return reject(
      "same_model_family",
      `审阅者与产出者同属模型家族 [${a}]（§5.9 第 1 条 / §24 风险 1）。` +
        "同家族模型的判断高度相关，「两个不同 agent」只是表象。" +
        "需要 CEO 的显式批准（写在 review_gates 的 explicit_approval 里）才能保存 —— " +
        "而那份批准不在组织图内，本函数看不到，所以这里一律拒，由保存路径带凭据重判。",
    );
  }
  return { ok: true };
}

/**
 * 新增这条边之后，经过这条边的委派链是否超上限（口径见文件头 ②）。
 *
 * 「最长路径」在【有环】的图上是无限长的 —— 而委派环是【合法的】：
 * hub 的 independentReviewerPath 明确放行 dev → dev2 → dev3 → dev 这种同行评审环。
 * 所以这里算的是【最长简单路径】（同一条路上不重复经过同一节点），
 * 环不会被反复计入长度。
 *
 * 这一处我【先写错过一次】，形状值得留下：第一版按「预算耗尽就封顶」实现
 * （budget 递减到 0 即返回 LIMIT），于是【任何】合法的同行评审环都让
 * longestChainTo 返回 6 —— 推导：test → dev → test → … 反复走满 6 步。
 * 实测（本机 node，见 0011 §2）：一张只有一条 dev⇄test 环的正常组织图上，
 * 【任何】新增边都被判「超过 5 层上限」。这不是误报某条边，是这条判据
 * 在一批合法图上恒真 —— 也就是「CEO 加不了任何委派边」，功能整个不可用，
 * 而且报错指向「层级超限」这个与真相无关的方向。
 * 根因是把「路径不能无限长」实现成了「步数不能无限花」：前者约束节点，后者约束步数，
 * 而有环时两者不等价。改成简单路径（onPath 集合）之后环不重复计数。
 *
 * 复杂度的账：最长简单路径一般是 NP-hard，这里靠【上限只有 5】收住 ——
 * 一旦某条简单路径长度达到 LIMIT 就停止展开（再长也一定超限，无需知道确切值），
 * 于是上界是 O(N·5^L)。几十个节点的组织图（单人公司）在这个量级下是微秒，
 * 而换来的是「含合法环不会误拒」。
 */
export function wouldExceedMaxDepth(
  org: OrgGraph,
  source: string,
  target: string,
): Verdict {
  // 经过这条边的链长度 = (走到 source 的最长简单链) + 这条边 1 层 + (从 target 出发的最长简单链)。
  const before = longestChainTo(org, source);
  const after = longestChainFrom(org, target);
  const total = before + 1 + after;
  if (total > ORG_MAX_DEPTH) {
    return reject(
      "depth_exceeded",
      `新增边使委派链超过 ${ORG_MAX_DEPTH} 层上限：` +
        `[${source}] 之前有 ${before} 层，边本身 1 层，[${target}] 之后还有 ${after} 层。`,
    );
  }
  return { ok: true };
}

/**
 * 走到 node 的最长【简单】委派链层数（不含 node 自己）。
 * 上限 LIMIT 处剪枝：达到它就说明已超限，无需继续展开（见 wouldExceedMaxDepth）。
 */
function longestChainTo(org: OrgGraph, node: string): number {
  const LIMIT = ORG_MAX_DEPTH + 1;
  const onPath = new Set<string>([node]);
  const walk = (id: string, reached: number): number => {
    let best = 0;
    if (reached >= LIMIT) return LIMIT;
    for (const e of org.edges) {
      if (e.to !== id || onPath.has(e.from)) continue; // 简单路径：不重复经过节点
      onPath.add(e.from);
      const sub = walk(e.from, reached + 1);
      onPath.delete(e.from);
      best = Math.max(best, sub === LIMIT ? LIMIT : sub + 1);
      if (best >= LIMIT) return LIMIT;
    }
    return best;
  };
  return walk(node, 0);
}

/** node 往后能延伸出的最长【简单】委派链层数（不含 node 自己）。同上。 */
function longestChainFrom(org: OrgGraph, node: string): number {
  const LIMIT = ORG_MAX_DEPTH + 1;
  const onPath = new Set<string>([node]);
  const walk = (id: string, reached: number): number => {
    let best = 0;
    if (reached >= LIMIT) return LIMIT;
    for (const e of org.edges) {
      if (e.from !== id || onPath.has(e.to)) continue;
      onPath.add(e.to);
      const sub = walk(e.to, reached + 1);
      onPath.delete(e.to);
      best = Math.max(best, sub === LIMIT ? LIMIT : sub + 1);
      if (best >= LIMIT) return LIMIT;
    }
    return best;
  };
  return walk(node, 0);
}

/**
 * 运行中任务的【输入形状】。
 *
 * 收成「一个 id 数组」而不是「一个查询函数」：查函数会把 I/O 塞回纯函数
 * （文件头那条矛盾的处置）。而 id 数组够 L3 用 —— 它只需要【数量】和
 * 【能把话说清楚】。调用方查 SQL 那一行的位置在 hub（Task 3.3 的 commit 路径）。
 */
export type RunningTasksInput = readonly string[];

/**
 * L3：这次变更【由谁】发起、【影响什么】。
 *
 * 鉴权判据照规格原文（`type !== "human" || id !== "ceo"` ⇒ 拒）。
 * 两个条件都要，且是【或】：只判 id 的话，一个 role_id 为 ceo 的 agent
 * 就能改组织 —— 而 §4.2.3 把资源分配权集中给的是【人】那个 CEO，
 * 不是那个 id 字符串。这不是假想：图里 report 节点用的就是 ceo 这个 role_id
 * （roles/preset.ts 的 NODE_TO_TEMPLATE），所以「agent 侧出现 ceo 这个 id」
 * 是【当前代码里已经存在】的形状，不是稻草人。
 */
export function validateOrgChange(
  change: OrgChange,
  actor: OrgActor,
  runningTasks: RunningTasksInput = [],
): Verdict | NeedsConfirmation {
  if (actor.type !== "human" || actor.id !== CEO_ROLE_ID) {
    return reject(
      "not_ceo",
      `只有 CEO 可以修改组织架构（§4.2.3 资源分配权集中在 CEO）。` +
        `实到 actor = ${actor.type}/${actor.id}。`,
    );
  }
  if (runningTasks.length > 0) {
    // 原文那句「变更仅对新任务生效」我【保留在文案里】但它在模块内不成立 ——
    // 见文件头那句边界声明：保证它的是 §18.4 的版本化提交，不是这个函数。
    // 文案里保留是因为这是给 CEO 看的，他要的就是那句预期管理；
    // 而模块边界上我不把它当成自己给的保证。
    return {
      ok: true,
      needsConfirmation:
        `当前有 ${runningTasks.length} 个任务在运行，变更仅对新任务生效` +
        "（运行中任务用创建时的图版本，§18.4）。",
      runningTaskIds: runningTasks,
    };
  }
  return { ok: true };
}
