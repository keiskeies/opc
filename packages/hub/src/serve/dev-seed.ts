/**
 * `pnpm dev:seed` —— 往 dev 库填一份**仅用于开发演示**的种子数据。
 *
 * ── 为什么存在 ─────────────────────────────────────────────────────
 * `pnpm dev` 起的库（devPaths 算出的 `.opc-os/dev.db`，见 dev-entry.ts 文件头）
 * 出厂是空的：delegation_graphs / tasks / budgets 全 0 行，CEO 界面打开就是五个空页，
 * 「先看完整功能界面再评好坏」这件事没有评审对象。本命令把三张表填成有内容的样子：
 * 一棵组织树、几条停在**不同**状态的任务、几条有进度可读的预算行。
 *
 * ── 三条刻意的不碰，都是项目规矩而不是省事 ──────────────────────────
 * ① **不写 role_charters**。岗位书的七条验收标准按 0008 §7 只能 CEO 本人写，
 *    种子命令代写属违规（charter/seed.ts 对七份模板恒拒正是设计好的）。
 *    delegation_graphs 的节点不含验收标准，所以种组织图不越界。
 * ② 组织图**只走 commitOrgGraph** 这一条正当写入口（org/commit.ts），
 *    校验、版本化、审计全按生产路径走 —— 种子数据若旁路写入，
 *    演示到的就不是真行为。一个角色一次 add_node，版本逐格涨上去。
 * ③ 幂等判据是 **delegation_graphs 是否已有行**：种过就整体跳过，
 *    而不是再叠加一版组织图（add_node 撞 role_exists 会半途而废，
 *    留下种了一半的树比空库更难查）。
 *
 * ── 入口块的边界 ───────────────────────────────────────────────────
 * 只有被直接执行时才开库（isDirectRun，同 dev-entry.ts 的口径）；
 * 测试 import 本模块时零副作用，seedDemoOrg 收一个注入的 Writer，跑在临时库上。
 *
 * ── 收件箱与今日页预算条（第二轮补的两处演示盲区）────────────────────
 * ① 收件箱：今日页「待你决策」读的是审批收件箱的待批卡张数（web app.js 的 navPending，
 *    源头是 GET /approvals），而旧种子一条审批卡都没建 ⇒ 看板上明明有
 *    ESCALATED_TO_CEO 的任务、收件箱却是空的。现在种 2 张 pending 卡挂在已有任务上，
 *    **只走 approvals/cards.ts 的 createCard** 这一条正当写入口（卡 + 事件 + 审计同事务，
 *    与生产建卡逐字节同构），幂等靠它自带的 (task_id, card_key) 去重键：
 *    撞键返回 created:false，与文件头第 ③ 条的 currentGraphVersion 短路**两层都在**。
 *    ⚠ 卡一律用【可逆】类型（不是 irreversible_action，且 parameters.irreversible:false，
 *    过 isIrreversibleApproval 的三档判据都是「可逆」）—— O11 不许在 IM 侧批不可逆卡，
 *    演示卡要让「点批准」这条流程走得通。
 * ② 今日页「已声明上限合计」那一行：它读的是【任务级】预算
 *    （overview/today.ts 的 BUDGET_SUM_SQL，参数固定 ["task", "per_task"]），
 *    而旧种子只有 company 与 role 两种作用域 ⇒ 那行显示「一行都没设过」，
 *    与预算页的 $535 看着互相矛盾。这是【口径】不是 bug（有测试钉着，不许改读侧），
 *    所以补一条 scope_type='task' / period='per_task' 的预算行让那一行有数。
 */
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CEO_ROLE_ID,
  type DelegationEdge,
  type OrgActor,
  type OrgGraph,
  type OrgGraphNode,
} from "@opc/contracts";
import { createCard, type NewCardDraft } from "../approvals/cards.js";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import {
  assertParamCount,
  assertSingleStatement,
  type Writer,
} from "../db/write-queue.js";
import { isDirectRun } from "../internal/direct-run.js";
import {
  applyChangeToGraph,
  commitOrgGraph,
  currentGraphVersion,
  readLatestGraph,
} from "../org/commit.js";

/** 种子数据的固定时钟偏移基准：入口用 Date.now()，测试注入固定值。 */
export interface SeedOptions {
  readonly nowMs: number;
}

export interface SeedResult {
  /** true = delegation_graphs 已有行，本次一行未动。 */
  readonly skipped: boolean;
  /** 跳过时给的人话（种了什么/为什么不再种，入口原样打印）。 */
  readonly message: string;
  /** 本次种进图的角色 id（跳过时为空数组）。 */
  readonly roles: readonly string[];
  /** 本次种的任务 id（跳过时为空数组）。 */
  readonly taskIds: readonly string[];
  /** 本次种的预算行 id（`scope|scopeId|period` 三段拼接，同 tracker.ts 口径）。 */
  readonly budgetIds: readonly string[];
  /** 本次建的审批卡 id（跳过或全部撞去重键时为空数组）。 */
  readonly approvalIds: readonly string[];
}

/**
 * 演示组织：CEO + 6 个角色，汇报关系成树（深度 4，在 ORG_MAX_DEPTH=5 之内）。
 *
 * 顺序即插入顺序：add_node 要求上级已在图里（validateNewNode 的 unknown_role），
 * 所以父必须先于子。**数组顺序就是正确性的一部分，别重排。**
 *
 * model_family 的取值没有枚举约束（orgNodeSchema 只要求非空串），
 * 取的是仓内测试夹具一直在用的家族名（opus / sonnet / gpt / gemini / claude），
 * 且审阅门控的 same_model_family 判据在【家族】粒度比 —— 父子刻意错开，
 * 让 DEMO_ORG_EDGES 那几条门控边不会一上来就红。这件事在【保存期】是硬约束：
 * validateNewEdge 的 violatesNoSelfReview 对同家族直接拒，因为提交组织变更时
 * 手上没有任何审批凭据（commitOrgChangeRequestSchema 不带批准字段），
 * 「CEO 批过了所以可以让同家族互审」这条豁免在保存那一刻表达不出来。
 */
export const DEMO_ORG_NODES: readonly OrgGraphNode[] = [
  {
    role_id: CEO_ROLE_ID,
    can_manage: true,
    reports_to: null,
    model_family: "opus",
  },
  {
    role_id: "tech_director",
    can_manage: true,
    reports_to: CEO_ROLE_ID,
    model_family: "opus",
  },
  {
    role_id: "product_lead",
    can_manage: true,
    reports_to: CEO_ROLE_ID,
    model_family: "sonnet",
  },
  {
    role_id: "operations",
    can_manage: false,
    reports_to: CEO_ROLE_ID,
    model_family: "claude",
  },
  {
    role_id: "architect",
    can_manage: true,
    reports_to: "tech_director",
    model_family: "sonnet",
  },
  {
    role_id: "dev_engineer",
    can_manage: false,
    reports_to: "architect",
    model_family: "gpt",
  },
  {
    role_id: "qa_engineer",
    can_manage: false,
    reports_to: "architect",
    model_family: "gemini",
  },
];

/**
 * 演示委派边：`from` 产出，`to` 审阅，且【全部 review_gate=true】。
 *
 * ── 为什么种子必须有边（这一格以前是空的）─────────────────────────────
 * §8.2 第 3 条的审阅独立性判据（hub 的 independentReviewerPath）读的就是这张图的边：
 * 「产出方有没有一条 review_gate=true、指向别的角色的出边」。旧种子【一条边都没有】，
 * 于是判据 3 接进 dispatch 之后的演示形状是固定的：每一次审阅都判「没有独立审阅者」，
 * 而那条阻断的修法是「去 POST /org 加一条边」—— 可 CEO 在演示库里看不到任何一条边做样例，
 * 界面也就演示不出「带门控的委派边长什么样」。补边不是让演示变绿的手段，
 * 是演示本来就该带上这个不变量的载体。
 *
 * ── 为什么边只能长这个形状（不是审美，是 save 期判据逼出来的）──────────
 * commitOrgGraph 走 validateNewEdge，里面有两条先把别的形状拒了：
 *  ① escalation_unreachable：`to` 必须【沿委派边】能走到 CEO（canReach 只走 edges，
 *     不走 reports_to）。空图上第一条边若是 X → Y（Y 非 CEO），那条边自己就不可达 CEO ⇒ 拒。
 *     所以空图上的第一批带门控的边只能指向 ceo。
 *  ② violatesNoSelfReview：保存期没有审批凭据，同家族直接拒 —— 所以两端家族必须不同。
 *     ceo=opus ⇒ 另一端不能是 opus，于是 tech_director(opus) 与 ceo 之间【加不出】门控边。
 * depth 那一维不构成约束：委派边此前为空，`longestChainTo/From` 都返回 0，总长 1。
 * 加完两条指向 ceo 的边之后 qa_engineer 才有合法出边（qa→dev 的账是
 * longestChainTo(dev)=0 + 边 1 + longestChainFrom(dev)=1 ⇒ 2 ≤ ORG_MAX_DEPTH=5）。
 *
 * ⚠ 数组顺序同样是正确性的一部分：qa→dev 依赖 dev→ceo 已在图上
 * （否则 canReach(dev, ceo) 走不通 ⇒ escalation_unreachable），别把它挪到前头。
 *
 * ⚠ 这两条边【只满足 structure 那一维】。运行期 reviewGate 还要比 model_family，
 * 所以 ceo(opus) 审 architect(sonnet) 判得过，而同一张图上 ceo 审 tech_director(opus)
 * 仍然要 CEO 点一次批准 —— 那正是 review-preview.ts 那个读数在演示图上要说的事，
 * 补边不会、也不该把它抹平。
 */
export const DEMO_ORG_EDGES: readonly DelegationEdge[] = [
  { from: "architect", to: CEO_ROLE_ID, review_gate: true },
  { from: "dev_engineer", to: CEO_ROLE_ID, review_gate: true },
  { from: "qa_engineer", to: "dev_engineer", review_gate: true },
];

/**
 * 演示任务：状态**必须散在不同列**，且至少一条落在 CEO_DECISION_STATUSES
 * （today.ts 的 `ESCALATED_TO_CEO`）—— 否则「今日视图需要你决策有东西」这句话是假的。
 * dev-seed.test.ts 钉的就是这两条。
 */
export const DEMO_TASKS: readonly {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly assignedRole: string;
  readonly budgetCents: number | null;
  readonly consumedCents: number | null;
  readonly parentId: string | null;
}[] = [
  {
    id: "seed-task-1",
    title: "上线订阅计费功能",
    // 需要你决策：CEO_DECISION_STATUSES 里唯一的成员。
    status: "ESCALATED_TO_CEO",
    assignedRole: CEO_ROLE_ID,
    budgetCents: 20000,
    consumedCents: 8600,
    parentId: null,
  },
  {
    id: "seed-task-2",
    title: "支付回调重构",
    status: "IN_PROGRESS",
    assignedRole: "dev_engineer",
    budgetCents: 8000,
    consumedCents: 2400,
    parentId: "seed-task-1",
  },
  {
    id: "seed-task-3",
    title: "支付链路回归测试",
    // BUDGET_PAUSED 在 ATTENTION_STATUSES 而【不在】CEO_DECISION（非琥珀，规格明写）——
    // 两条列语义演示各占一格。
    status: "BUDGET_PAUSED",
    assignedRole: "qa_engineer",
    budgetCents: 1500,
    consumedCents: 1500,
    parentId: "seed-task-1",
  },
];

/**
 * 演示预算：company 一条 + 两个 role + 【一条任务级】。
 * consumed 拉开梯度让进度条有区分度（qa 那条故意 100%，演示「触顶」那一格的样子）。
 *
 * ⚠ 最后那条 task|seed-task-1|per_task 不是「凑数的第四行」，它是补一处**口径差**：
 * 今日页「已声明上限合计」那一行只算**任务级**预算 —— overview/today.ts 的
 * BUDGET_SUM_SQL 参数固定 ["task", "per_task"]（那是有测试钉着的既有判据，别动读侧）。
 * 旧种子只有 company 与 role ⇒ 那一行显示「一行都没设过」，与预算页的合计 $535
 * 看着互相矛盾。数字对不上是【口径】不是数据缺失：今日页只数 per_task，
 * 预算页数全部作用域。下一位读种子的人若以为「缺了任务级预算」去改 today.ts，
 * 改坏的是那条测试钉着的判据。
 * limit/consumed 与 DEMO_TASKS 里 seed-task-1 的 budgetCents/consumedCents 同源同值。
 */
export const DEMO_BUDGETS: readonly {
  readonly scope: string;
  readonly scopeId: string;
  readonly period: string;
  readonly limitCents: number;
  readonly consumedCents: number;
}[] = [
  {
    scope: "company",
    scopeId: "company",
    period: "monthly",
    limitCents: 50000,
    consumedCents: 18400,
  },
  {
    scope: "role",
    scopeId: "dev_engineer",
    period: "daily",
    limitCents: 2000,
    consumedCents: 780,
  },
  {
    scope: "role",
    scopeId: "qa_engineer",
    period: "daily",
    limitCents: 1500,
    consumedCents: 1500,
  },
  {
    scope: "task",
    scopeId: "seed-task-1",
    period: "per_task",
    limitCents: 20000,
    consumedCents: 8600,
  },
];

/**
 * 演示审批卡：让收件箱在演示时**有卡可批**。
 *
 * ── 每张卡挂哪条任务、为什么 ────────────────────────────────────────
 *  · seed-task-1（ESCALATED_TO_CEO）配 `escalation` 卡：任务状态与卡片类型讲同一个故事
 *    （这条就是"因为超出决策范围升上来等 CEO 拍板"的那条），看板和收件箱互相对得上。
 *  · seed-task-3（BUDGET_PAUSED）配 `budget_override` 卡：qa 那条预算刻意种成 100%，
 *    这张卡就是【规格】§7.4 明写的「预算暂停的非琥珀运营事件」
 *    （OPERATIONAL_APPROVAL_TYPES 恰好只有它，收件箱按它判琥珀色的演示正主）。
 *
 * ── 两条硬性口径 ────────────────────────────────────────────────────
 * ① **一律可逆**：approval_type 不是 irreversible_action，parameters.irreversible 恒 false
 *    —— isIrreversibleApproval（http/tokens.ts）的三档判据（类型标记 / 卡片声明 /
 *    脏 JSON fail-closed）对这两张卡都答「可逆」。本仓有 O11 判据不许在 IM 侧批
 *    不可逆卡，演示卡若不可逆，「点批准」流程在 IM 那条路上根本走不通。
 *    timeout_behavior 也刻意避开 auto_approve（那意味着机器替人点头，演示不该有）。
 * ② **cardKey 必须稳定**：这是幂等的第二层（第一层是 currentGraphVersion 短路）。
 *    createCard 撞 (task_id, card_key) 的 partial unique index 返回 created:false，
 *    一条卡一行事件一条审计都不多写。键里带 dev-seed: 前缀，不与生产建卡方的键空间相撞。
 *
 * buttons / 三行结构由 approvalCardDraftSchema 的 .strict() 兜着，写错一格建卡当场抛。
 * ⚠ approvalType 的取值只在本文件（后端种子）出现，不写进任何前端路由字面量 ——
 * 仓里有守卫规定审批类型名不许出现在前端路由字面量里。
 */
export const DEMO_CARDS: readonly NewCardDraft[] = [
  {
    taskId: "seed-task-1",
    approvalType: "escalation",
    cardKey: "dev-seed:seed-task-1:escalation",
    summary:
      "「上线订阅计费功能」升级到 CEO：支付回调改造涉及生产数据迁移，等 CEO 决定是否放行灰度上线",
    parameters: {
      amount_cents: 8600,
      impact_scope: "生产环境订阅计费链路",
      irreversible: false,
      recommendation:
        "推荐：先开 5% 灰度并保留回滚脚本，再逐步放量（推荐，非决定）",
      recommendation_is_not_decision: true,
      timeout_behavior: "escalate",
    },
    evidence_refs: ["task:seed-task-1/evidence"],
    buttons: ["approve", "reject_with_comment", "defer_deep_review"],
    escalation: { reason: "outside_decision_scope" },
  },
  {
    taskId: "seed-task-3",
    approvalType: "budget_override",
    cardKey: "dev-seed:seed-task-3:budget-override",
    summary:
      "「支付链路回归测试」的 qa_engineer 日预算已触顶暂停，等 CEO 决定是否追加额度",
    parameters: {
      amount_cents: 3000,
      impact_scope: "qa_engineer 回归测试预算（daily 1500¢ 已用满）",
      irreversible: false,
      recommendation:
        "推荐：追加 $15.00 日额度而不是放宽任务级上限（推荐，非决定）",
      recommendation_is_not_decision: true,
      timeout_behavior: "auto_reject",
    },
    evidence_refs: ["budget:qa_engineer|daily"],
    buttons: ["approve", "reject_with_comment", "defer_deep_review"],
  },
];

/** 种子写入方的审计身份：与生产组织提交同一身份（human/ceo，见 commit.ts 的 ORG_ACTOR）。 */
const SEED_ACTOR: OrgActor = { type: "human", id: CEO_ROLE_ID };

const INSERT_TASK_SQL =
  "INSERT INTO tasks (id, parent_id, title, status, assigned_role, current_node, " +
  "budget_cents, consumed_cents, created_at, updated_at, graph_version) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING";

const INSERT_BUDGET_SQL =
  "INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, consumed_cents, hard_stop) " +
  "VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT(scope_type, scope_id, period) DO NOTHING";

/**
 * 种一份演示数据。幂等：delegation_graphs 已有任何版本 ⇒ 整体跳过（判据见文件头第 ③ 条）。
 *
 * 组织图逐个 add_node 走 commitOrgGraph（校验 + 版本化 + 审计都是生产路径），
 * 任务与预算走 node() 里的直接 INSERT（演示行，不伪装成状态机跑出来的审计轨迹），
 * 两条路的 INSERT 都带 DO NOTHING/DO UPDATE 语义 —— 即使判据被绕过也不会叠行；
 * 审批卡走 createCard 的正当写入口，撞 (task_id, card_key) 去重键一条不写 ——
 * 幂等因此是【两层】：currentGraphVersion 短路 + 各自的行级去重，两个都要在。
 */
export async function seedDemoOrg(
  w: Writer,
  o: SeedOptions,
): Promise<SeedResult> {
  const existing = await w.node(() =>
    currentGraphVersion(requireScopeDb("dev-seed")),
  );
  if (existing > 0) {
    return {
      skipped: true,
      message:
        "delegation_graphs 已有 " +
        existing +
        " 个版本 ⇒ 判定已种过，本次一行未动。" +
        "想重种：删掉 dev 库再跑（库是可扔的演示数据，见 .gitignore）。",
      roles: [],
      taskIds: [],
      budgetIds: [],
      approvalIds: [],
    };
  }

  // ① 组织图：一个角色一次 add_node，after 图由 applyChangeToGraph 逐格推进，
  //    和 HTTP 那条提交路径落到库里的东西逐字节同构。
  const SEED_RUNNING_TASKS: readonly string[] = [];
  let graph: OrgGraph = { nodes: {}, edges: [] };
  const roles: string[] = [];
  for (const node of DEMO_ORG_NODES) {
    const change = { kind: "add_node" as const, node };
    const r = await commitOrgGraph(w, {
      graph,
      change,
      actor: SEED_ACTOR,
      runningTasks: SEED_RUNNING_TASKS,
      nowMs: o.nowMs,
      changeSummary: "dev 种子：加入角色 " + node.role_id,
    });
    if (!r.ok) {
      throw new Error(
        "dev-seed：add_node [" +
          node.role_id +
          "] 被拒（" +
          r.code +
          "）：" +
          r.reason,
      );
    }
    graph = applyChangeToGraph(graph, change);
    roles.push(node.role_id);
  }

  // ①b 委派边。一个 change 一次 commitOrgGraph —— 边若直接塞进 graph 对象再落库，
  //    演示到的就是「绕过了 validateNewEdge 的边」，而 §8.2 第 4 条「门控绑在边上」
  //    这件事的全部意义就在这道校验（不可绕过）。顺序见 DEMO_ORG_EDGES 的注释：
  //    qa→dev 依赖 dev→ceo 先落图。
  for (const edge of DEMO_ORG_EDGES) {
    const change = { kind: "add_edge" as const, edge };
    const r = await commitOrgGraph(w, {
      graph,
      change,
      actor: SEED_ACTOR,
      runningTasks: SEED_RUNNING_TASKS,
      nowMs: o.nowMs,
      changeSummary: "dev 种子：加委派边边 " + edge.from + " → " + edge.to,
    });
    if (!r.ok) {
      throw new Error(
        "dev-seed：add_edge [" +
          edge.from +
          " → " +
          edge.to +
          "] 被拒（" +
          r.code +
          "）：" +
          r.reason,
      );
    }
    graph = applyChangeToGraph(graph, change);
  }

  // ② 任务。graph_version 在事务内取 currentGraphVersion —— 与 real-deps 的
  //    INSERT_TASK_SQL 同一口径（§18.4：新任务盖最新版本的戳，不能事后补 UPDATE）。
  const taskIds: string[] = [];
  await w.node(() => {
    const db = requireScopeDb("dev-seed.tasks");
    const gv = currentGraphVersion(db);
    for (const t of DEMO_TASKS) {
      const params: unknown[] = [
        t.id,
        t.parentId,
        t.title,
        t.status,
        t.assignedRole,
        t.assignedRole,
        t.budgetCents,
        t.consumedCents,
        o.nowMs,
        o.nowMs,
        gv,
      ];
      assertSingleStatement(INSERT_TASK_SQL);
      assertParamCount(INSERT_TASK_SQL, params);
      db.prepare(INSERT_TASK_SQL).run(...(params as never[]));
      taskIds.push(t.id);
    }
  });

  // ③ 预算。id 用三段拼接（tracker.ts 口径：这一行的身份就是三元组）。
  //    含一条 task|seed-task-1|per_task —— 今日页那行「已声明上限合计」只算任务级，
  //    这是口径不是 bug（见 DEMO_BUDGETS 上方注释），删掉它会演示回「一行都没设过」。
  const budgetIds: string[] = [];
  await w.node(() => {
    const db = requireScopeDb("dev-seed.budgets");
    for (const b of DEMO_BUDGETS) {
      const id = b.scope + "|" + b.scopeId + "|" + b.period;
      const params: unknown[] = [
        id,
        b.scope,
        b.scopeId,
        b.period,
        b.limitCents,
        b.consumedCents,
      ];
      assertSingleStatement(INSERT_BUDGET_SQL);
      assertParamCount(INSERT_BUDGET_SQL, params);
      db.prepare(INSERT_BUDGET_SQL).run(...(params as never[]));
      budgetIds.push(id);
    }
  });

  // ④ 审批卡（收件箱演示内容）。每张走 createCard 的正当写入口：
  //    卡 + ApprovalRequired 事件 + 审计同事务，与生产建卡同构。
  //    必须在 ② 任务之后 —— approvals.task_id 有外键 REFERENCES tasks(id)，
  //    任务没落库就建卡会让外键冲突【抛】（cards.ts 第 ② 条：那是编程错误，不兜）。
  //    幂等：每个草稿都带稳定 cardKey，撞 (task_id, card_key) 的去重键返回
  //    created:false、一条不写 —— 所以哪怕绕过 ① 的整体短路重跑，卡也不会翻倍。
  //    recommendationSource 不传：没有真实出处就落 NULL，不编一个「总监层推荐」（cards.ts 口径）。
  const approvalIds: string[] = [];
  for (const draft of DEMO_CARDS) {
    const r = await createCard(w, draft, { nowMs: o.nowMs });
    if (r.result.created) {
      approvalIds.push(r.result.approvalId);
    }
  }

  const latest = await w.node(() =>
    readLatestGraph(requireScopeDb("dev-seed.verify")),
  );
  return {
    skipped: false,
    message:
      "已种：" +
      roles.length +
      " 个角色（组织图 v" +
      (latest?.version ?? roles.length) +
      "）、" +
      taskIds.length +
      " 条任务、" +
      budgetIds.length +
      " 条预算行、" +
      approvalIds.length +
      " 张待批审批卡（全可逆，IM 侧也能批）。跳过：无（岗位书 role_charters 刻意不种 —— 七条验收标准只能 CEO 本人写）。",
    roles,
    taskIds,
    budgetIds,
    approvalIds,
  };
}

/**
 * 被直接执行时的那一段：解析库路径（复用 devPaths，dev 命令族的库坐标只有一个定义）
 * → 建目录 → 迁移 → seed → 打印 → 关队列。
 */
async function seedMain(): Promise<void> {
  const rootDir = resolve(
    fileURLToPath(new URL(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
    "..",
  );
  const dbEnv = process.env["OPC_DEV_DB"]?.trim();
  const dbPath =
    dbEnv === undefined || dbEnv === ""
      ? join(rootDir, ".opc-os", "dev.db")
      : isAbsolute(dbEnv)
        ? dbEnv
        : resolve(rootDir, dbEnv);
  mkdirSync(dirname(dbPath), { recursive: true });

  const { WriteQueue } = await import("../db/write-queue.js");
  const { migrate } = await import("../db/migrate.js");
  const q = new WriteQueue(dbPath);
  try {
    migrate(q.writeConnection());
    const r = await seedDemoOrg(q, { nowMs: Date.now() });
    console.log("库：" + dbPath);
    console.log(r.message);
    if (!r.skipped) {
      console.log("  · 角色    " + r.roles.join(" → "));
      console.log("  · 任务    " + r.taskIds.join(", "));
      console.log("  · 预算    " + r.budgetIds.join(", "));
      console.log("  · 审批卡  " + r.approvalIds.join(", "));
    }
  } finally {
    await q.close();
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  await seedMain().catch((e: unknown) => {
    console.warn(
      "dev:seed 崩了：" +
        (e instanceof Error ? (e.stack ?? e.message) : String(e)),
    );
    process.exitCode = 1;
  });
}
