/**
 * 组织变更的**版本化提交**（计划 Task 3.3，规格 §18.4 阶段 2）。
 *
 * ── 这个文件补的是 0011 §8 自己记下的那个洞 ─────────────────────────────
 * 0011 里我写着「这三个函数现在没有任何生产调用方」。本文件是第一个。
 * 写它之前先 grep 到一条更基本的事实：
 *   `grep -rn "graph_version" packages/hub/src packages/hub/test test` ⇒ 【0 命中】
 * 也就是说 0001_init.sql:49 那一列 `graph_version INTEGER NOT NULL DEFAULT 1`
 * 从建库那天起【没有任何代码写过它】。每条任务都是 DEFAULT 1。
 * 于是规格 §18.4 阶段 3 那句「旧任务从 Checkpoint 恢复时加载创建时版本的图定义」
 * 此前不是「没做完」，是【前提不成立】—— 所有任务的创建时版本都是 1，
 * 而 1 号版本在 delegation_graphs 里【一行都不存在】。
 * 本文件同时补上那一侧（见 stampTaskGraphVersion），否则计划要求的
 * 「运行中任务仍用旧版图 / 新任务用新版图」那两条 Test 只能对着恒为 1 的列断言，
 * 那是恒真判定。
 *
 * ── 三条不变量，各自对应一种真实故障 ──────────────────────────────────
 *  ① 校验在【Hub 侧】重跑，不复信前端结论（§18.3 结尾：前端校验只是体验优化）。
 *     形状上这不是口号：commitOrgGraph 收的是【图 + 变更】，它自己调 validate*，
 *     返回值里【没有】一个「前端说合法」的入口 —— 想跳过校验得先删代码。
 *  ② 三张表在【同一个事务】里写（§18.4 ③）。半提交的样子是：
 *     delegation_graphs 有了 v7 而 role_charters 还在 v6，或图版本涨了而审计没有那一行。
 *     前一种让回放里「v7 的汇报关系」与「v6 的岗位书」互相矛盾；
 *     后一种让「谁在什么时候把组织改了」查不出来 —— 而 events 是事实源（§5.8）。
 *  ③ 【不碰运行中的任务】。这一条的实现方式是「什么都不做」，
 *     而「什么都不做」必须被写成一条【断言】而不是注释：
 *     否则下一个人会以为「让运行中任务跟上最新版」是个遗漏并去补它，
 *     那正好违反 §18.4（运行中任务用创建时版本）。
 *
 * ── 与规格的一处【做不到】，写在离代码最近的地方 ────────────────────────
 * §18.4 ③ 要求同一事务写 role_charters（version + 1）。但 OrgGraph 的节点只有
 * role_id / can_manage / model_family / reports_to —— 它【不带】岗位书的其余必填字段
 * （acceptance_criteria、honesty_boundaries、decision_scope…，见 charter.ts 的
 * charterInput 全是 .min(1)/.min(1) 级约束）。所以从一张组织图**造不出**一份合法岗位书。
 * 我的处置：只给【reports_to 真的变了】且【库里已有上一版岗位书】的角色写新行，
 * config 由上一版的 config JSON 打 reportsTo 补丁得到。
 * 其余角色不写 charter 新行 —— 「每个角色都 +1」会造出一堆
 * 内容与上一版完全相同、版本号不同的行，让「v6→v7 改了什么」这个问题
 * 得到「什么都没改」这种答案，版本历史就废了。
 * 代价与这条缺口本身记在 docs/decisions/0012。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CEO_ROLE_ID,
  validateNewEdge,
  validateOrgChange,
  validateReparenting,
  type OrgActor,
  type OrgChange,
  type OrgGraph,
  type RunningTasksInput,
  type Verdict,
} from "@opc/contracts";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import { assertParamCount, assertSingleStatement, type Writer } from "../db/write-queue.js";
import { appendAudit } from "../events/recorder.js";

/**
 * 组织变更的审计身份。
 *
 * 【不】从 http/real-deps.ts 拿那个 CEO_ACTOR —— 不是因为它不对，是因为方向：
 * org/ 依赖 http/ 会让「HTTP 层是组织功能的一个入口」这件事反过来说成
 * 「组织功能属于 HTTP 层」。桌面端走 IPC（packages/desktop）同样要提交组织变更，
 * 那时它 import 的应当是 org/，而不是被迫 import 一个 http 模块。
 * 真正的单一来源是 contracts 的 CEO_ROLE_ID；这里的 actorType 是这条链【唯一】
 * 需要写死 "human" 的地方，因为 §4.2.3 集中给 CEO 的是【人】那个权，
 * 而 validateOrgChange 已经把这个判断做过了（actor 由调用方传，这里只是落审计）。
 */
const ORG_ACTOR = { actorType: "human", actorId: CEO_ROLE_ID } as const;

/** 提交结果：要么给了新版本号，要么给出【为什么没提交】。 */
export type CommitResult =
  | {
      ok: true;
      /** 写进 delegation_graphs.version 的那个号。 */
      readonly graphVersion: number;
      readonly graphId: string;
      /** 这次真正写了新行的角色（见文件头那条缺口）。 */
      readonly charterBumpedRoles: readonly string[];
      /** 那条审计的 events.id。 */
      readonly auditSeq: number;
      /** 需要 CEO 再确认一次时给的话术（有运行中任务）。原样透传 L3 的结论。 */
      readonly needsConfirmation?: string;
    }
  | { ok: false; reason: string; code: string };

/**
 * 当前最新组织图版本。空表 ⇒ 0 而不是 1。
 *
 * 为什么不返回 1 兜底：0 与 1 的区别是【这张图还没提交过】与
 * 「v1 存在」。返回 1 的话，第一次提交会写出 v2 而库里没有 v1，
 * 于是每条任务的 graph_version=2 指向的历史缺第一段，回放读不出起点。
 */
export const MAX_GRAPH_VERSION_SQL =
  "SELECT COALESCE(MAX(version), 0) AS v FROM delegation_graphs";

export const INSERT_DELEGATION_GRAPH_SQL =
  "INSERT INTO delegation_graphs (id, version, graph_json, effective_from, created_by, " +
  "change_summary) VALUES (?, ?, ?, ?, ?, ?)";

/** 上一版岗位书。同一 role_id 可能有多版，取最大 version。 */
export const LATEST_CHARTER_SQL =
  "SELECT version, config FROM role_charters WHERE role_id = ? ORDER BY version DESC LIMIT 1";

export const INSERT_CHARTER_SQL =
  "INSERT INTO role_charters (id, role_id, version, config, effective_from, created_by) " +
  "VALUES (?, ?, ?, ?, ?, ?)";

/**
 * 一条【新任务】该盖上的组织图版本（§18.4 阶段 3：「新任务…从 delegation_graphs
 * 读最新版本初始化」）。
 *
 * 形状是同步 + 收 db，而不是 async 自己开事务 —— 因为它必须与那条
 * `INSERT INTO tasks` 在【同一个事务】里：
 * 原本我写的是 `stampTaskGraphVersion()`，一条独立的 `UPDATE tasks SET graph_version=?`，
 * 然后删了。独立 UPDATE 留出两段窗口，都不是理论问题：
 *  ① INSERT 与 UPDATE 之间，库里存在一行 graph_version = 列默认值 1 的任务，
 *     而 1 号版本在表里【一行都没有】（这就是本轮 grep 到的那个洞的形状）；
 *     崩溃正好落在这中间，就永久留下这么一行。
 *  ② 更要紧的是「取最新版本」与「写这一行」必须同刻：
 *     读到 v6 →（别人提交 v7）→ 落成 v6，而它是 v7 生效【之后】建的任务。
 *     WriteQueue 排的是【事务之间】的顺序，同一条语句序列拆进两次 node()
 *     就是两个事务，中间那次提交是允许的 —— 所以第二次方案不安全，而它的症状
 *     是「这条任务用了旧汇报关系」并且一句报错也没有。
 * 于是现在只有这一个取数口，调用点在建任务那条 INSERT 的回调里（http/real-deps.ts）。
 *
 * 空表返回 0（与 MAX_GRAPH_VERSION_SQL 同口径）。0 是【还没有任何版图】，
 * 不是「第 1 版」—— 差别在 readGraphByVersion(0) 会抛错，而这正是我们想要的：
 * 让「一条任务引用了一张不存在的图」看得见，而不是静默退化成最新版。
 */
/**
 * 这两个只读函数（currentGraphVersion / readGraphByVersion）要的【最小】连接形状。
 *
 * 为什么不直接写 DatabaseSync：调用方有两类 —— 事务回调里那条真写连接
 * （requireScopeDb 返回的），以及【只读连接】上跑的恢复路径。
 * Pick 成只有 prepare 之后，两类都给得进来，而本模块拿不到 run/exec，
 * 写不进去（类型上就没这个口子）。
 *
 * prepare 的返回类型我只要求一个 get。为什么不用 (...a: unknown[]) 这种宽形状：
 * node:sqlite 的 StatementSync.get 收的是 SQLInputValue[]，
 * 那个宽形状【不可赋值】给它（参数逆变），tsc 会当场拒 —— 这是实测撞到的，
 * 不是提前规避。所以这里直接用官方类型而不是自己描一份。
 */
type DbLike = Pick<DatabaseSync, "prepare">;

export function currentGraphVersion(db: DbLike): number {
  assertSingleStatement(MAX_GRAPH_VERSION_SQL);
  const row = db.prepare(MAX_GRAPH_VERSION_SQL).get() as { v: number | bigint } | undefined;
  if (row === undefined) {
    // COALESCE + 聚合恒返回一行。走到这里说明 SQL 被人改过（加了 WHERE / LIMIT），
    // 此时【不能】当 0 处理：那会让所有新任务静默盖成 0，
    // 症状是「每张新任务都恢复不回来」，而 0 看起来像合法值。
    throw new Error(
      "MAX_GRAPH_VERSION_SQL 没有返回行。聚合查询恒返回一行，拿不到就是 SQL 被改坏了。",
    );
  }
  return Number(row.v);
}

/** 运行中的任务（§18.3 第三个函数那个 `getRunningTasks()`，按纯函数原则由调用方查）。 */export const RUNNING_TASKS_SQL =
  "SELECT id FROM tasks WHERE status NOT IN ('DELIVERED', 'ARCHIVED') ORDER BY id";

/** 读出一张已提交的图。 */
export const SELECT_GRAPH_BY_VERSION_SQL =
  "SELECT graph_json FROM delegation_graphs WHERE version = ?";

/** 读出一张图 + 它的元数据（GET /org 用；graph_json 之外还要 id/effective_from/change_summary）。 */
export const SELECT_GRAPH_WITH_META_BY_VERSION_SQL =
  "SELECT id, version, graph_json, effective_from, change_summary FROM delegation_graphs WHERE version = ?";

/** 读 MAX(version) 那一行：图 + 元数据 + 当前版本号，一次查询拿全。 */
export const SELECT_LATEST_GRAPH_SQL =
  "SELECT id, version, graph_json, effective_from, change_summary FROM delegation_graphs ORDER BY version DESC LIMIT 1";


/**
 * 提交前必须过的三关。返回第一条不通过的理由。
 *
 * 为什么【不】把 change 直接丢给 validateOrgChange 就完事：那样只判了 L3。
 * L1/L2 在前端跑过，而「前端跑过」不是这里的依据 —— 计划 Task 3.1 的验收
 * 说的正是「Hub 保存时二次校验」。所以这里按 change 的 kind 分派回对应的判据。
 * 三种 kind 都覆盖到是刻意的（add_edge 与 reparent 走不同判据；
 * 漏一个 kind 就是「那种变更不校验」，而它看起来和其他 kind 一模一样）。
 */
function revalidate(
  change: OrgChange,
  graph: OrgGraph,
  actor: OrgActor,
  runningTasks: RunningTasksInput,
): Verdict | { ok: true; needsConfirmation: string } {
  let one: Verdict;
  if (change.kind === "reparent") {
    one = validateReparenting(change.child_role, change.new_parent_role, graph);
  } else {
    one = validateNewEdge(
      change.edge.from,
      change.edge.to,
      graph,
      change.edge.review_gate,
    );
  }
  if (!one.ok) return one;
  return validateOrgChange(change, actor, runningTasks);
}

/**
 * 把「变更」应用到图上，得到【提交后】的那张图（写进 graph_json 的东西）。
 *
 * 为什么单独一个纯函数：审计里的 after 快照必须是【真正落库的那张图】，
 * 不能是「前端传来的那张它以为会变成什么样的图」。两者分开的失效方式是
 * 审计说组织成了 A 而库里是 B —— 这是本仓认定最贵那一类静默。
 * 所以调用方（HTTP/IPC 层）不需要自己算 after，这里算，且审计与 INSERT 用同一个值。
 */
export function applyChangeToGraph(
  graph: OrgGraph,
  change: OrgChange,
): OrgGraph {
  const nodes = { ...graph.nodes };
  if (change.kind === "reparent") {
    const child = nodes[change.child_role];
    if (child === undefined) {
      throw new Error(
        "applyChangeToGraph: 子角色 [" +
          change.child_role +
          "] 不在图里。校验应当已经拦下，走到这里说明调用顺序反了（先改图后校验）。",
      );
    }
    nodes[change.child_role] = { ...child, reports_to: change.new_parent_role };
    return { nodes, edges: graph.edges };
  }
  return { nodes, edges: [...graph.edges, change.edge] };
}

/**
 * 一次组织变更的完整提交。
 *
 * 顺序（顺序就是判据，反过来会有半提交）：
 *   读当前版本 → 校验（L1/L2 + L3）→ 算 after 图 → 一个事务里写
 *   delegation_graphs + 若干 role_charters + 一条审计
 *
 * 校验放在【读版本之后、开事务之前】：校验不过就一行都不该动，
 * 而把校验放进事务里会让「拒绝」也走一次 BEGIN/ROLLBACK —— 那不是错，
 * 但会让人以为拒绝路径也可能留下东西。
 */
export async function commitOrgGraph(
  w: Writer,
  o: {
    /** 提交【之前】的图。before 快照直接由它序列化，不做任何加工。 */
    readonly graph: OrgGraph;
    readonly change: OrgChange;
    readonly actor: OrgActor;
    /** 由调用方查好传入（纯函数原则，见 0011 §2 第 4 条）。 */
    readonly runningTasks: RunningTasksInput;
    readonly nowMs: number;
    /** 写进 delegation_graphs.change_summary 的那句人话（§18.4 那一列）。 */
    readonly changeSummary: string;
  },
): Promise<CommitResult> {
  const check = revalidate(o.change, o.graph, o.actor, o.runningTasks);
  if (!check.ok) return { ok: false, reason: check.reason, code: check.code };
  const needsConfirmation = "needsConfirmation" in check ? check.needsConfirmation : undefined;

  const after = applyChangeToGraph(o.graph, o.change);
  const graphJson = JSON.stringify(after);
  const beforeJson = JSON.stringify(o.graph);

  const wrote = await w.node(() => {
    const db = requireScopeDb("commitOrgGraph");

    assertSingleStatement(MAX_GRAPH_VERSION_SQL);
    const cur = db.prepare(MAX_GRAPH_VERSION_SQL).get() as { v: number | bigint };
    const next = Number(cur.v) + 1;

    // 哪些角色的汇报关系真的变了 —— 只有这些配得上一个新的岗位书版本。
    const changed = Object.keys(after.nodes).filter(
      (id) => after.nodes[id]?.reports_to !== o.graph.nodes[id]?.reports_to,
    );

    const id = randomUUID();
    const graphParams: unknown[] = [
      id,
      next,
      graphJson,
      o.nowMs,
      ORG_ACTOR.actorId,
      o.changeSummary,
    ];
    assertSingleStatement(INSERT_DELEGATION_GRAPH_SQL);
    assertParamCount(INSERT_DELEGATION_GRAPH_SQL, graphParams);
    db.prepare(INSERT_DELEGATION_GRAPH_SQL).run(...(graphParams as never[]));

    const bumped: string[] = [];
    for (const roleId of changed) {
      assertSingleStatement(LATEST_CHARTER_SQL);
      assertParamCount(LATEST_CHARTER_SQL, [roleId]);
      const prev = db.prepare(LATEST_CHARTER_SQL).get(roleId) as
        | { version: number | bigint; config: string }
        | undefined;
      // 没有上一版岗位书 ⇒ 【跳过而不是造一份】。
      // 造一份得编出 acceptance_criteria 等必填字段，而那些字段的语义属 CEO
      // （0008 §7 立的正是这件事不该由实现层代笔）。跳过是少写，编造是伪证。
      if (prev === undefined) continue;
      const config = JSON.parse(prev.config) as Record<string, unknown>;
      // 岗位书 config 是 charterSchema 的 transform 输出（camelCase），
      // 所以这里改的是 reportsTo 而不是 reports_to。写错键名不会报错，
      // 只会得到一份「reports_to 变了而 config 没变」的行 —— 见测试那条断言。
      config["reportsTo"] = after.nodes[roleId]?.reports_to ?? null;
      const charterParams: unknown[] = [
        randomUUID(),
        roleId,
        Number(prev.version) + 1,
        JSON.stringify(config),
        o.nowMs,
        ORG_ACTOR.actorId,
      ];
      assertSingleStatement(INSERT_CHARTER_SQL);
      assertParamCount(INSERT_CHARTER_SQL, charterParams);
      db.prepare(INSERT_CHARTER_SQL).run(...(charterParams as never[]));
      bumped.push(roleId);
    }

    const seq = appendAudit(
      db,
      {
        // task_id = null：组织变更不属于任何一条任务。
        // 这一格为 null 不是偷懒，而是让「任务级审计」与「组织级审计」在【列】上
        // 就分开 —— cli.ts 那两处回放查询都带 WHERE task_id = ?，
        // 所以这类行不会混进单任务时间线（那会让回放里凭空多一次「状态变更」）。
        taskId: null,
        actorType: ORG_ACTOR.actorType,
        actorId: ORG_ACTOR.actorId,
        // action 取 state_change 而不是加第 11 个枚举值 ——
        // AUDIT_ACTIONS 是 append-only 枚举（§22.1），加值属改规格，
        // 同 0010 §4 那条判定。区分靠 payload.kind，见下面的 payload。
        action: "state_change",
        // target = 版本号而不是图 id：回放与日报要回答的是「第几版改的」，
        // 而 UUID 对这个问题没有信息量（id 仍在 delegation_graphs 里，没丢）。
        target: String(next),
        payload: {
          kind: "org_graph_changed",
          graph_version: next,
          change: o.change,
          charter_bumped: bumped,
          running_task_count: o.runningTasks.length,
        },
        // 前后快照进 state_snapshot：§18.4 ③ 原话是「变更前后图快照」。
        // 放 state_snapshot 而不是 payload：payload 是【这次变更是什么】，
        // 快照是【变更前后各是什么】，两者的大小与生命周期都不同
        //（一张组织图几十 KB，一条变更几百字节）。
        stateSnapshot: { before: JSON.parse(beforeJson), after: after },
        createdAt: o.nowMs,
      },
      () => o.nowMs,
    );
    return { graphVersion: next, graphId: id, charterBumpedRoles: bumped, auditSeq: seq };
  });

  return needsConfirmation === undefined
    ? { ok: true, ...wrote }
    : { ok: true, needsConfirmation, ...wrote };
}

/**
 * 读出一条已提交的图（Task 3.3 的「运行中任务用创建时版本」要靠它验证）。
 *
 * 抛出而不是返回 undefined：版本号为 null 时返回 undefined 会让调用方写
 * `graph ?? 默认图`，于是「Checkpoint 指向一个不存在的版本」静默退化成用最新图跑 ——
 * 那正是 §18.4 要防的事，而它会以「一次正常的运行」的面目出现。
 */
export function readGraphByVersion(db: DbLike, version: number): OrgGraph {
  assertSingleStatement(SELECT_GRAPH_BY_VERSION_SQL);
  assertParamCount(SELECT_GRAPH_BY_VERSION_SQL, [version]);
  const row = db.prepare(SELECT_GRAPH_BY_VERSION_SQL).get(version) as
    | { graph_json: string }
    | undefined;
  if (row === undefined) {
    throw new Error(
      "delegation_graphs 里没有版本 " +
        version +
        "。任务的 graph_version 指向一个不存在的版本时【不能】退回最新版：那等于让旧任务" +
        "在新汇报关系下继续跑（§18.4 阶段 3）。宁可抛错，让『版本缺失』看得见。",
    );
  }
  return JSON.parse(row.graph_json) as OrgGraph;
}

/**
 * 读【当前生效】那一张图 + 元数据（GET /org 的装配原料）。
 *
 * 返回 `null` 表示 delegation_graphs 从没写过任何版本（versions === 0）。
 * 注意与 readGraphByVersion 的差异：那一只是「按版本读、版本缺失【抛错】」
 * （§18.4 阶段 3 的判据：旧任务的 graph_version 绝不退回最新版）；而这里是
 * 「读当前最新」，无图不是错而是「还没有这个资源」—— 由这本函数用空返回表达。
 */
export function readLatestGraph(db: DbLike): {
  graph: OrgGraph;
  graphId: string;
  version: number;
  effectiveFromMs: number;
  changeSummary: string | null;
} | null {
  assertSingleStatement(SELECT_LATEST_GRAPH_SQL);
  const row = db.prepare(SELECT_LATEST_GRAPH_SQL).get() as
    | {
        id: string;
        version: number;
        graph_json: string;
        effective_from: number;
        change_summary: string | null;
      }
    | undefined;
  if (row === undefined) return null;
  return {
    graph: JSON.parse(row.graph_json) as OrgGraph,
    graphId: row.id,
    version: Number(row.version),
    effectiveFromMs: Number(row.effective_from),
    changeSummary: row.change_summary,
  };
}