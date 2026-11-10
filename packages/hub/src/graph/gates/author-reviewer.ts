/**
 * 「作者不给自己打分」的硬拦截（计划 Task 1.3，规格 §8.2 第 1/4 条、§24 风险 1）。
 *
 * 这一组判据是【本设计的核心防线】，所以它必须在【保存时】拒绝，而不是运行时才发现。
 * 区别在哪：运行时发现意味着这条违规的边已经存在于组织图里，只是这一次执行没走到它；
 * 而 §8.2 第 4 条说的是「门控绑定在边上、不可绕过」。一条能存在但偶尔生效的边不是约束。
 *
 * 三条同源判据，粒度不同，缺一不可：
 *  1) 同一角色            → 直接拒绝。§8.2 第 1 条的字面要求。
 *  2) 同一模型家族        → 需要显式批准才放行。§5.9 第 1 条 + §24 风险 1：
 *     同家族模型高度相关（同一套训练数据与偏好），「两个不同 agent」的独立性在
 *     同家族下只是表象 —— 这正是「共谋」的真实形态，比同一个 agent 更隐蔽。
 *  3) 作者的出边        → 作者必须有一条【带门控且指向别的角色】的出边。口径为什么
 *     收在「离开作者那一条边」而不是「图上可达」，见 independentReviewerPath 的注释。
 *
 * 本模块【不碰数据库】：它是纯判定，供「保存门控配置」与「校验委派图」两条路径共用。
 * 写 review_gates 那一行的动作在调用方，它必须把本模块的拒绝当硬错误处理。
 */

import type { Charter } from "@opc/contracts";

export interface Party {
  readonly roleId: string;
  readonly modelFamily: string;
}

/** 同模型家族审阅所需的显式批准凭据。 */
export interface SameFamilyApproval {
  /** 谁批的（必须是 CEO，见 sameFamilyReviewBlock 的判定）。 */
  readonly approvedBy: string;
  readonly reason: string;
}

export const CEO_ROLE_ID = "ceo";

export type Block = { ok: false; reason: string; code: BlockCode };
export type Allow = { ok: true };
export type BlockResult = Allow | Block;

export type BlockCode =
  | "self_review"
  | "same_model_family"
  | "unknown_model_family"
  | "approval_by_author"
  | "no_independent_reviewer_path";

function block(code: BlockCode, reason: string): Block {
  return { ok: false, reason, code };
}

/**
 * 判据 1 + 2：审阅者与产出者不得同角色；同模型家族需 CEO 显式批准。
 *
 * 批准人不能是作者自己（code: "approval_by_author"）—— 这是这条防线最容易被绕过去的
 * 方式：给「同家族审阅」开一个批准口子，然后让作者自己填那个字段。字段存在 ≠ 批准有效，
 * 所以批准人这一维必须单独判，不能省。
 */
export function sameFamilyReviewBlock(
  producer: Party,
  reviewer: Party,
  approval?: SameFamilyApproval,
): BlockResult {
  if (producer.roleId.trim() === "") {
    return block("self_review", "产出方 role_id 为空：无法判定审阅独立性，拒绝保存。");
  }
  if (reviewer.roleId.trim() === "") {
    return block("self_review", "审阅方 role_id 为空：无法判定审阅独立性，拒绝保存。");
  }
  if (producer.roleId === reviewer.roleId) {
    return block(
      "self_review",
      "审阅者 [" +
        reviewer.roleId +
        "] 与产出者是同一角色 —— 规格 §8.2 第 1 条「作者不给自己打分」。" +
        "这是图结构上的硬约束，不是提示词约定：不接受任何运行时豁免。",
    );
  }
  // 家族未知 ⇒ 直接拒绝（code: unknown_model_family），而不是「跳过这一维」。
  // 这是我第一版写错的地方：当时写成 producer.modelFamily !== "" && 相等才拦，
  // 于是「不填家族」就成了一条绕过 §24 风险 1 的通路 —— 判据的失效方向必须是收紧，
  // 缺信息时必须落到【有人来判】，不能落到放行。
  if (producer.modelFamily.trim() === "" || reviewer.modelFamily.trim() === "") {
    return block(
      "unknown_model_family",
      "产出方或审阅方的 model_family 为空，无法判定是否同源（§5.9 第 1 条 / §24 风险 1）。" +
        "缺这一维时不放行：否则【不声明家族】就成了绕过同家族拦截的通路。",
    );
  }
  if (producer.modelFamily === reviewer.modelFamily) {
    if (approval === undefined) {
      return block(
        "same_model_family",
        "审阅者与产出者同属模型家族 [" +
          producer.modelFamily +
          "]（§5.9 第 1 条 / §24 风险 1）。同家族模型的判断高度相关，" +
          "「两个不同 agent」只是表象。需要 CEO 的显式批准（explicit_approval）才能保存。",
      );
    }
    if (approval.approvedBy !== CEO_ROLE_ID) {
      return block(
        "approval_by_author",
        "同模型家族审阅的批准人必须是 [" +
          CEO_ROLE_ID +
          "]，实到 [" +
          approval.approvedBy +
          "]。批准人若可以是任意角色，作者就能自己批准自己 —— 那这条防线只剩形式。",
      );
    }
    if (approval.reason.trim() === "") {
      return block(
        "approval_by_author",
        "同模型家族审阅的批准必须写明理由（进审计）。空理由的批准等于没有批准。",
      );
    }
  }
  return { ok: true };
}

/**
 * 一条委派边：from 产出，to 审阅。
 *
 * gateOnEdge 是「门控绑定在边上」的载体（§8.2 第 4 条）。gate 为 false 的边意味着
 * 产出直接进入下一层，没有任何审阅 —— 若这条边是作者通往上层的唯一路径，
 * 「独立审阅」就在图上不存在。
 */
export interface DelegationEdge {
  readonly from: string;
  readonly to: string;
  readonly gate?: boolean;
}

/**
 * 判据 3：作者自己【必须有一条带门控的出边指向别的角色】。
 *
 * 口径写死成一句话：存在 from === author 且 gate === true 且 to !== author 的边
 * ⇒ 有独立审阅。为什么不取更宽的「图论可达性」—— 我第一版就是按可达性写的
 * （BFS 遍历带门控边），实现时暴露出两个问题：
 *  ① 那份实现的 frontier 推进是空的（next 从未 push），于是它【实际只查一跳】，
 *     而注释宣称多跳。注释承诺了实现没有的性质，比没有注释更坏 —— 同类的坑在
 *     evidence/store.ts 的 sha256File 上也踩过一次（那里写「流式」而实现是整读）。
 *  ② 更要紧的是语义：可达性会给出【假放行】。dev → junior（无门控）→ test（有门控）
 *     这条链上，dev 的产出在离开 dev 时【没被任何门控接住】，test 审的是 junior 的
 *     产出。按可达性判 = 可达 = 有审阅，而事实上 dev 自己那份东西从未被看过。
 *     「门控绑定在边上」（§8.2 第 4 条）的严格读法正是【离开作者那一条边】带门控。
 *
 * 取严格读法的代价也说清楚，不当它不存在：一个只有一条无门控出边的角色会被判
 * 「无独立审阅」，哪怕它下游两跳处有审阅者。这是【有意收紧】—— 委派图由 CEO 手工
 * 编排，「每个产出角色都有一条带门控的出边」是一条能解释、能逐行核对的不变量；
 * 而漏判那一侧的代价（越权放行）远大于另一侧（让 CEO 补一条边）。
 *
 * 顺带钉一个【不算违规】的形状，免得将来被误当 bug 改掉：dev → dev2 → dev3 → dev
 * 这种三个不同角色首尾相接的环是【合法的同行评审】，每个角色都有带门控的出边指向
 * 别的角色，本判据放行它。§8.2 要防的是「自己审自己」，不是「评审关系不成树」。
 * 真要拦的是同一角色绕回自己（自环、或多条 to === author 的边），由 to !== author
 * 这一条挡下。
 */
export function independentReviewerPath(
  author: string,
  edges: readonly DelegationEdge[],
): { reachable: boolean; path: string[] } {
  const out = new Map<string, DelegationEdge[]>();
  for (const e of edges) {
    const list = out.get(e.from);
    if (list === undefined) out.set(e.from, [e]);
    else list.push(e);
  }
  // 【不写成遍历】。第一版是 BFS，而它的 frontier 推进是空的（next 从未 push），
  // 于是「声称多跳、实际只看一跳」。修有两种改法：把 next 补上（放宽语义），或
  // 把循环删掉（承认语义就是一跳）。选后者，理由是上面那段口径 —— 留着循环哪怕
  // 行为相同，也等于在代码里挂一个「这里会走多跳」的暗示，而下一个人会信它。
  // 路径形状保持 [author, reviewer] 两元素：调用方（配置页）要显示「谁审」。
  for (const e of out.get(author) ?? []) {
    if (e.gate !== true) continue; // 没有门控的边不构成审阅
    if (e.to === author) continue; // 带门控的自审仍是自审（§8.2 第 1 条讲的是独立性）
    return { reachable: true, path: [author, e.to] };
  }
  return { reachable: false, path: [] };
}

/** 判据 3 的包装：缺独立审阅者即拒绝，并把「为什么」写进原因（报错要可操作）。 */
export function selfReviewEdgeBlock(
  author: string,
  edges: readonly DelegationEdge[],
): BlockResult {
  const r = independentReviewerPath(author, edges);
  if (r.reachable) return { ok: true };
  return block(
    "no_independent_reviewer_path",
    "角色 [" +
      author +
      "] 没有任何【带门控且指向别的角色】的出边，即没有独立审阅者。" +
      "§8.2 第 1 条要求产出必须经过至少一个独立审阅节点，第 4 条把门控绑在边上 —— " +
      "合起来的口径是【离开作者那一条边】必须带门控：更下游的门控审的是别人的产出，" +
      "补不上作者自己那份。修法：给 " +
      author +
      " 加一条 gate=true、to≠" +
      author +
      " 的委派边。",
  );
}

/**
 * 保存门控配置前的总入口（计划 Test 项第一条：保存门控时【即】拒绝）。
 *
 * 三条判据全部跑完再汇总，而不是第一条失败就返回：配置页要一次把三个问题都显示出来。
 * 只报第一条的话，用户改一条、保存、又看到下一条，来回三轮 —— 而这三条往往同源。
 */
export function gateConfigBlock(o: {
  producer: Party;
  reviewer: Party;
  edges: readonly DelegationEdge[];
  approval?: SameFamilyApproval;
}): BlockResult {
  const problems: Block[] = [];
  const a = sameFamilyReviewBlock(o.producer, o.reviewer, o.approval);
  if (!a.ok) problems.push(a);
  const b = selfReviewEdgeBlock(o.producer.roleId, o.edges);
  if (!b.ok) problems.push(b);
  if (problems.length === 0) return { ok: true };
  const first = problems[0] as Block;
  if (problems.length === 1) return first;
  return block(
    first.code,
    problems.map((p) => p.reason).join("；"),
  );
}

/**
 * 运行时越权尝试的判定（计划 Task 1.3 Test 最后一条：试图用运行时参数覆盖 forbidden
 * → 抛错，并写一条 unauthorized_attempt 审计事件）。
 *
 * 这里【不重新实现】那份单调性逻辑 —— 它已经存在于 roles/loader.ts 的
 * mergeForbiddenForRun（两份判据必然漂移，0006 §7 第 55、56 条记的就是这个形状）。
 * 本函数的职责是另一件事：把「哪些条目会被这次请求删掉」算出来，供调用方写进审计。
 * loader 抛错时给出的是拒绝结论；审计要的是【具体想删哪几条】，否则那条
 * unauthorized_attempt 事后读起来只知道「有人试过」而不知道「试的是什么」。
 *
 * 入参 requestedForbidden 是运行时请求的【有效】黑名单（不是「要追加的条目」——
 * 那种语义下永远删不掉东西，也就无从判定）。
 */
export function forbiddenRemovalAttempt(
  charter: Charter,
  requestedForbidden: readonly string[],
): string[] {
  const wanted = new Set(requestedForbidden);
  // 只报【原有条目被拿掉】的那些。运行时新增的条目不算越权（那是收紧，合法）。
  return charter.decisionScope.forbidden.filter((f) => !wanted.has(f));
}

/**
 * 越权尝试的审计载荷。action 固定 unauthorized_attempt（AUDIT_ACTIONS 里的既有枚举，
 * 见 events/recorder.ts —— 不自造新 action，审计枚举一经写入就是永久的）。
 */
export interface UnauthorizedAttemptPayload {
  readonly action: "unauthorized_attempt";
  readonly kind: "forbidden_removal";
  readonly role_id: string;
  readonly removed_entries: readonly string[];
}

export function unauthorizedAttemptPayload(
  charter: Charter,
  removed: readonly string[],
): UnauthorizedAttemptPayload {
  return {
    action: "unauthorized_attempt",
    kind: "forbidden_removal",
    role_id: charter.roleId,
    removed_entries: removed,
  };
}
