/**
 * 「今天我的公司怎么样了」那几个数（【规格】§16.3 右栏 + §16.5 顶部策略摘要条）。
 *
 * ── 为什么这一发住在 hub 而不在界面里算 ──────────────────────────────
 * `packages/web/src/hub/projection.ts` 文件头写着渲染进程内不存在业务状态机，
 * 而它的破法不是「别 import 状态机」，是「别为了显得顺自己补一拍判定」。
 * 那几个数看着都是「数一下列表」，逐个问一遍【判据从哪来】就知道不是：
 *  · 「被阻塞」= 哪几个状态？两个（`BUDGET_PAUSED` / `BLOCKED`），而那是边表的知识；
 *  · 「今天完成」= 什么时候完成的？`tasks.updated_at` 答不了这一问
 *    （最后一次更新可能是预算列被加了一下），要回答只能去 events 里找那次跃迁；
 *  · 「自动通过几项」= 库里那条 payload 的键（`auto_approved_by`），
 *    而写侧刻意不开新的 action 值（§22.1 的枚举 append-only）。
 * 三条都是【判定】，不是排版。判定住在模块里、HTTP 只是一个入口 ——
 * 与 `approvals/query.ts`、`replay/query.ts` 同一个分法（0013 §6 记的就是这条落点偏离）。
 *
 * ── 本模块只回答【别处答不了】的那几问 ──────────────────────────────
 * 待批张数、任务列表、组织图，各自都已有对账源（`GET /approvals` 的 `pendingTotal`、
 * `GET /tasks`、`GET /org`）。这里【一个都不重抄】：两个来源给同一个数，
 * 就是本仓反复抓的「两张表两个答案」（0041 §4 那条钱的教训是同一族的实证）。
 * 所以这里只有：窗口内的完成数、阻塞数、三类决策次数、预算总额。
 *
 * ── 一条我没法满足的口径，写在响应里而不是藏在注释里 ────────────────
 * §16.3 要「今日预算消耗比例」、§21.3 要「日消耗 vs 预算」的条形。
 * 而【按天的消耗额今天没有记录方】：
 *  · `budgets` 只有累计的 `consumed_cents`，且全仓**唯一**写入是 `+ ?`
 *    （实测见 0015 文件头 ②：没有任何归零/重算路径 ⇒ 单调不减 ⇒ 它就是「至今总共」）；
 *  · 表上**没有** `updated_at`（0001_init.sql 那七列），「什么时候变的」在表上不可问；
 *  · 唯一带时刻的是 `budget_events.created_at`。所以「窗口内花了多少」我能给准数
 *    （下面 `consumed_in_window_cents`），而「日预算的上限是多少」给不出 ——
 *    角色级 `daily` 那一格【没有任何生产者】：engine/runtime.ts 的 onCost 只声明
 *    `task|<id>|per_task` 一种作用域，`hub/src` 里也没有角色级/公司级的声明方。
 * 于是这里的取舍是：【给有判据的那两半，并明写缺的是哪一半】。
 * 画一根「今日消耗 / 未知上限」的条形比不画更坏 —— 那根条形的长度本身在说谎。
 */

import type { DatabaseSync } from "node:sqlite";
import { assertParamCount, assertSingleStatement } from "../db/write-queue.js";
import { silentOverBudgets } from "../charter/budget-sync.js";
// 只读一张**常量表**（不是写通道，也不是查询函数）。为什么今日视图要带一张审批侧的
// 名单：收件箱那张卡的颜色看的是 approval_type，而那份判据不能落在渲染进程里
// —— 同 `blocked_statuses` 那条「判据随响应发出」的立场。
import { OPERATIONAL_APPROVAL_TYPES } from "../approvals/cards.js";

/** 【规格】§16.5 那句「过去 24 小时」的字面窗口。做成常量是为了让界面不必自己拼 86400000。 */
export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 「被阻塞」的两个状态，逐字来自 §7.1 的边表：
 *  · `BUDGET_PAUSED` —— §7.1 只给它一条出边（`ESCALATED_TO_CEO`），等 CEO；
 *  · `BLOCKED` —— 出边是【空数组】（status.ts 明写「规格未给出路」）。
 * 不含 `MEETING_REQUIRED`：它同样是死路（出边空数组），但规格里它的名字属于【会议】
 * 而不是「阻塞」，把它并进来等于替 §10.1 决定「辩论会卡住算不算阻塞」—— 那不在射程内。
 * 这份清单是手抄的，所以旁边那条 `BLOCKED_STATES 覆盖 edge 表死路` 的用例
 * 会去真边表里把死路列出来对一遍（抄漏一个方向是「少报」，界面看着像「没坏事」。
 */
export const BLOCKED_STATUSES: readonly string[] = ["BUDGET_PAUSED", "BLOCKED"];

/**
 * 「活跃」的两个排除状态 —— 定义成【不是已完成/已归档】而不是列举一堆进行中状态，
 * 这个方向是刻意的：边表里有十来个状态，逐个判"算不算活跃"会漏
 * （漏掉的方向是新加一个进行中状态时它悄悄不计入，界面显示"活跃 2 个"而实际 5 个）。
 * 反过来只排除两个终点，新增中间态【自动】被算进来，而那正是对的方向。
 *
 * 为什么 DELIVERED 不算活跃：§7.1 给它一条出边（→ARCHIVED），它是"交付了、等归档"，
 * 而不是"还在干活"。§16.3 那一格问的是"有多少活正在跑"，把已交付的算进去会让
 * CEO 以为还有活在压着。如果哪天这一格的读者改成"未归档的任务数"，
 * 要改的是这一行 + 下面那条用例，不是界面。
 *
 * ⚠ 与 blocked / attention 那两份**不一样**，这一份【不随响应发出】。
 * 我原先在这儿写的是「与 blocked 那一格一样，这份清单随响应发出」—— 那句是【假的】，
 * 是 test/web/renderer-criteria.test.ts 那条「顶层键名集合」把它照出来的
 * （响应里从来没有 active_statuses 这个字段，而注释声称它有）。
 *
 * 不发是对的，差别在【有没有消费者】：
 *  · blocked / attention 那两份，看板要【拿清单去筛任务】⇒ 界面必须持有清单
 *    ⇒ 不发出去它就只能自己抄一份 ⇒ 抄件必然漂移（0006 §7）；
 *  · 这一份，界面只消费一个【服务端算好的数】active_tasks，
 *    今天没有任何一处按"活跃"筛 ⇒ 没有抄件可漂移。
 * 反过来说，哪天看板要加「只看活跃」那个过滤器，这一行就【必须】变成字段：
 * 那时候加 `active_statuses`（或 inactive_statuses）+ 今日页那个过滤器一起加，
 * 而键名集合那一发会先红并指回这里。
 *
 * 排除式定义本身仍然要求"全量枚举"在 hub 侧才看得见 —— 界面拿不到 TASK_STATES，
 * 所以就算想要那份清单，它也只能来自服务端（这一句不变，只是它今天没有下游）。
 */
export const INACTIVE_STATUSES: readonly string[] = ["DELIVERED", "ARCHIVED"];

/**
 * §16.4「需要我注意」这个【过滤器】要的状态集合 = 【阻塞 ∪ 已升级到 CEO】。
 *
 * 为什么单开一个字段而不是让界面自己拼 `blocked_statuses + 'ESCALATED_TO_CEO'`：
 * 后者要在渲染进程里写那个状态名字面量，而那是边表的知识 ——
 * projection.ts 文件头那条「渲染进程内不存在任何业务状态机」禁的正是这个。
 * 抄件的失效方式很具体：哪天边表给升级加一档（比如 ESCALATED_TO_BOARD），
 * hub 侧改了、看板那一列【继续显示旧的】，而两个界面都在同一屏上。
 *
 * 「触及预算」这一维【不在这里】，它是算术不是状态：consumed >= budget_cents 且
 * budget_cents 非空 —— 两个服务端给的数比一下，不构成状态机判定，所以留在界面里。
 *
 * ⚠ 这一份清单管的是【哪些任务进那一列】，**不是**【哪些标琥珀】。
 * 后者是另一份清单（`CEO_DECISION_STATUSES`），两者不能合并成一个字段 ——
 * 理由见下面那个常量旁边的说明（0042 §3，那一格我第一版就是合并着做的）。
 */
export const ATTENTION_STATUSES: readonly string[] = ["ESCALATED_TO_CEO", ...BLOCKED_STATUSES];

/**
 * 「需要 CEO 决策」= 琥珀色的【唯一】合法触发状态，随响应发出。
 *
 * 为什么这份清单不能由 `ATTENTION_STATUSES` 派生 —— 这是本篇踩过的一个坑，
 * 我第一版就是把「进哪一列」和「标不标琥珀」当成同一件事（0042 §3）：
 *  §19.2 那张色表把 `#E8A33D` 定成「全局仅用于『需要 CEO 决策』这一种状态」，
 *  并给出可扫视的用法：「眼睛在任何页面一扫，琥珀色出现处就是需要你动手的地方」。
 *  而 `BUDGET_PAUSED` 在规格里【四处】被点名非琥珀：
 *    §6 事件表 `BudgetPaused` → 「**非琥珀色**卡片 + 日消耗条变红」；
 *    §7.4 → 「审批收件箱出现**非琥珀色**的『预算暂停』卡片（这是运营事件，不是战略决策）」；
 *    §21.3 界面表现 → 「预算暂停 → 审批收件箱出现**非琥珀色**卡片（§7.4）」；
 *    附录 D 术语表 → 「在收件箱生成**非琥珀色**卡片」。
 *  反过来说，`BUDGET_PAUSED` 确实【该进】「需要我注意」那一列（§7.4 那三个按钮
 *  追加预算 / 维持暂停 / 终止任务 全是 CEO 按的）。
 *  ⇒ 于是「进那一列」与「标琥珀」**在规格里就是两个不同的集合**，交集非空而不相等。
 *
 * ⚠ 这份清单**推不出来**，只能抄，这一点要说清：`BUDGET_PAUSED` 在 §7.1 边表里
 * 只有【一条】出边（→ `ESCALATED_TO_CEO`），按「等谁的下一步」推，它必然被推成琥珀。
 * 规格却四处明写非琥珀 ⇒ 这是一条【规格的断言】，不是边表的定理，
 * 所以它只能作为常量抄在这里，配下面那条用例钉住「两个集合的差恰好是 BUDGET_PAUSED」。
 *
 * 只有一档：`ESCALATED_TO_CEO`。不含 `BUDGET_PAUSED`（上面那四条）、
 * 不含 `BLOCKED`（§7.3 那个「异常」卡片明写「标记为『信息性』，非琥珀色决策卡」）、
 * 不含 `MEETING_REQUIRED`（§10 的辩论会/决策会里有 CEO 在场，但那是【会议】不是
 * 「CEO 一个人点按钮」，且 §10.1 的形态本身还没定 —— 同 §3 不并它的同一条理由）。
 */
export const CEO_DECISION_STATUSES: readonly string[] = ["ESCALATED_TO_CEO"];

/** 一次聚合的结果。字段是 snake_case，沿用本仓对外视图的口径（见 api.ts 那段说明）。 */
export type TodayView = {
  /** 服务端时刻。所有「多久之前」都以它为基准，客户端时钟不参与（同 SSE 的 asOfMs）。 */
  readonly as_of_ms: number;
  /** 【实际】用的窗口长度。与调用方传的可以不同（被钳过），口径同 effective_limit。 */
  readonly window_ms: number;
  readonly delivered_in_window: number;
  readonly blocked_tasks: number;
  /** 没到终点的任务数（排除式定义，见 INACTIVE_STATUSES 那段）。 */
  readonly active_tasks: number;
  /**
   * `blocked_tasks` 那一格【实际】数了哪些状态，逐字发给调用方。
   *
   * 这不是把 UI 的细节漏进 API，正相反：它是让 UI 能【不自己判】的唯一办法。
   * 看板那一页（§16.4「需要我注意」过滤器）要按同样的口径挑任务，
   * 而那份清单是边表的知识（哪几个状态算"卡着等人"）。渲染进程里
   * `packages/web/src/hub/projection.ts` 文件头写着「不存在任何业务状态机」，
   * 在那儿写一个字面量数组 = 两份清单，而两份清单的漂移方向是
   * 「看板说这件事不需要你注意、首页说它阻塞着」—— 两个数都在同一屏上，且都说得通。
   * 同 `pendingTotal` / `effective_limit` 那条「分母由服务端给」的立场（0013 §5）。
   */
  readonly blocked_statuses: readonly string[];
  /** §16.4「需要我注意」**那一列**的判据（阻塞 ∪ 升级到 CEO），随响应发出。 */
  readonly attention_statuses: readonly string[];
  /**
   * 琥珀色的触发判据（§19.2「全局仅用于需要 CEO 决策」）。
   *
   * 与 `attention_statuses` 是**两个集合**而不是一个：交集非空而不相等
   * （`BUDGET_PAUSED` 在后者、不在前者）。合并成一个字段的后果很具体 ——
   * 看板上那一列会把预算暂停的卡涂琥珀，而规格四处明写它非琥珀（见
   * `CEO_DECISION_STATUSES` 旁边那四条逐字引用）。
   */
  readonly ceo_decision_statuses: readonly string[];
  /**
   * 「运营事件」那一档审批类型（目前只有 `budget_override`），随响应发出。
   *
   * 收件箱那张卡要不要标琥珀，读的是**审批类型**而不是任务状态 —— 所以这一份
   * 名单和上面那一份是**两个不同维度**上的清单，都必须来自服务端：
   * 渲染进程里写死 `"budget_override"` 就是又一份抄件（同一个理由，见
   * `blocked_statuses` 那段）。
   */
  readonly operational_approval_types: readonly string[];
  readonly budget: {
    /** 窗口内真实发生的消费（`budget_events`，带时刻，这一格是准数）。 */
    readonly consumed_in_window_cents: number;
    /** 至今总共（`budgets.consumed_cents` 求和，单调不减的累计值）。 */
    readonly consumed_total_cents: number;
    /** 已声明的 per_task 上限之和。**不是**「今天可以花多少」，见文件头那条缺口。 */
    readonly declared_task_limits_cents: number;
    /** 声明过预算的作用域格子数（让界面能区分「一行都没有」与「都是 0」，0015 那条口径）。 */
    readonly declared_scopes: number;
    /** 已超限而【警报已哑】的格子数（0015 的读侧补救；> 0 就该在界面上说出来）。 */
    readonly silent_over_scopes: number;
  };
  readonly decisions: {
    /** 策略引擎自动通过的次数。今天恒 0，原因在 `notes` 里逐字写着（0014 §3）。 */
    readonly auto_approved_in_window: number;
    /** 窗口内新建的待批事项（= §16.5 那句「拦截 Y 项进入人工」的 Y）。 */
    readonly to_human_in_window: number;
    /** 窗口内人已点掉的（批准/打回/转深度审阅都算，判据是 actor_type 而不是 payload.kind）。 */
    readonly human_decided_in_window: number;
  };
  /**
   * 口径与缺口，原样发给界面。
   *
   * 为什么进响应而不是只写注释：这一族的每一个数都有一条「今天别按字面读」的话，
   * 而注释只对读源码的人说话。§16.5 那条摘要条是【给 CEO 扫一眼的】，
   * 「自动通过 0 项」在不带这句话的界面上读起来是「策略引擎很闲」，
   * 带上之后才读起来是它本来的意思：「这条链路今天还没接」。
   */
  readonly notes: readonly string[];
};

/**
 * 坏 payload 的预检。这一发【必须】排在任何 json_extract 之前，理由不是防御性编程：
 * `json_extract` 对畸形 JSON 是【抛错】而不是返回 NULL（0014 实测），
 * 于是「同一段时间里一条毫不相干的坏行」会把整个今日视图炸成 500。
 * 症状是「首页打不开」，而报错里没有那条行的 id 也没有它的 action ——
 * 人会去修没坏的那一半。先点名，再出数（同 auto-approve.ts 那条 MALFORMED_PAYLOAD_PROBE_SQL）。
 *
 * ⚠ 与日报那一发有一处【刻意的】不同：那边直接拒绝出数（日报是「给一个总数」的场景，
 * 少几行就是总数错），这边【照常出数并把坏行数带出去】。理由是这一页的每一个数
 * 都是【按条件筛过的窗口计数】，坏行落在筛选条件之外时不影响任何一个数；
 * 而首页 500 的代价是 CEO 整天看不到这一页。两边各自的取舍由各自的读者定。
 */
const MALFORMED_PROBE_SQL =
  "SELECT COUNT(*) AS n FROM events WHERE created_at >= ? AND created_at <= ? AND json_valid(payload) = 0";

/**
 * 三个判据都是【逐字挑过】的，不是"看着像就行"：
 *  · `action = 'state_change'` —— 状态跃迁的落点（recorder.ts 的 kind→action 映射表）。
 *  · `payload.kind = 'TaskStateChanged'` —— 这一截是【刻意的多余】。今天所有非任务的
 *    state_change 行（org/commit.ts 的 org_graph_changed、charter/store.ts、
 *    charter/budget-sync.ts）的 payload 里都没有 `to` 这个键，所以只按 `to` 筛今天也对。
 *    但"今天也对"在这里值零：三个生产者共用一个 action 值、靠 payload.kind 区分
 *    （§22.1 的枚举 append-only，加第 11 个值属改规格），而"某个生产者哪天也写一个
 *    叫 to 的键"这条未来改动不会有人回头来改这一页。0041 §4 钉的就是同一个形状。
 *  · `COUNT(DISTINCT task_id)` 同时干了两件事，第二件是【后来才发现的】：
 *    它去重的同时把 `task_id IS NULL` 的行【无声丢掉】（SQL 的 COUNT(DISTINCT) 不看 NULL）。
 *    今天 kind 那一关已经把这类行挡在外面 ⇒ 下面那个 unattributed 恒 0，
 *    而它作为【缺口探测器】留着：真命中时的症状是"首页少算一个"，永远查不出来。
 */
const DELIVERED_SQL =
  "SELECT COUNT(DISTINCT task_id) AS n, " +
  "SUM(CASE WHEN task_id IS NULL THEN 1 ELSE 0 END) AS unattributed FROM events " +
  "WHERE action = 'state_change' AND created_at >= ? AND created_at <= ? " +
  "AND json_valid(payload) = 1 " +
  "AND json_extract(payload, '$.kind') = 'TaskStateChanged' " +
  "AND json_extract(payload, '$.to') = 'DELIVERED'";

/**
 * 阻塞数用【当前状态】而不是事件窗口：这一格问的是「此刻有几件事卡着」，
 * 一件三天前就卡住的事今天仍然需要人处理，把它按「窗口内发生」筛掉是错的方向。
 */
const BLOCKED_SQL =
  "SELECT COUNT(*) AS n FROM tasks WHERE status IN (" +
  BLOCKED_STATUSES.map(() => "?").join(", ") +
  ")";

/**
 * 活跃数用【排除式】，与 INACTIVE_STATUSES 那段同一理由（列举一堆进行中状态会漏新增的）。
 * 参数化而不是写死两个字符串：判据只有一处（那个常量），SQL 只是它的投影。
 */
const ACTIVE_SQL =
  "SELECT COUNT(*) AS n FROM tasks WHERE status NOT IN (" +
  INACTIVE_STATUSES.map(() => "?").join(", ") +
  ")";

const BUDGET_SUM_SQL =
  "SELECT COUNT(*) AS scopes, COALESCE(SUM(consumed_cents), 0) AS consumed, " +
  "COALESCE(SUM(limit_cents), 0) AS declared FROM budgets WHERE scope_type = ? AND period = ?";

const BUDGET_WINDOW_SQL =
  "SELECT COALESCE(SUM(amount_cents), 0) AS consumed FROM budget_events " +
  "WHERE created_at >= ? AND created_at <= ?";

/**
 * 三类决策次数【一条 SQL 出三个数】。
 *
 * 三条查询之间夹一次写入会得到一份自相矛盾的摘要条（「拦了 3 件、人批了 4 件」），
 * 而那种矛盾在 UI 上没有任何一处会报错。同 auto-approve.ts 用窗口函数而不是两条查询、
 * 以及 0013 §5 那条「分母由服务端给」的立场。
 *
 * 三个判据各自挑过，都不靠 `payload.kind` 之外的巧合：
 *  · 进入人工 = `action='approval'` 且 payload.kind='ApprovalRequired'。
 *    建卡那一条的 payload 是【顶层带 kind 的】evt.payload（0041 §4 把跨生产者的形状钉住了），
 *    所以这一格【可以】靠 kind —— 与下面那两格不同，那边不行。
 *  · 人已决定 = `actor_type='human'`。这里【不能】用 kind：决策那条的 payload 是
 *    `{approvalId, resume}`，**没有 kind**（0041 §10 记的就是我在这儿数出过 0 条）。
 *  · 自动通过 = `payload.auto_approved_by` 有值。判据取键不取 actor_id，
 *    与 replay/query.ts 的标注同源（那边写了为什么不取署名：署名是共享维度）。
 */
/*
 * `json_valid(payload) = 1` 那一截是【承重】的，不是保险丝。
 * 实测（同一份夹具两条对照查询）：把 json_extract 写在 CASE 的条件里而对畸形行
 * 【不】加这道门 ⇒ `Error: malformed JSON`；加上 ⇒ 正常出数。
 * SQLite 不会对 CASE 的分支做「先判条件再求值」的短路保证，
 * 所以「坏行根本不会走到那一支」这个直觉在 SQL 里不成立。
 * 少这一截的症状是首页 500，而报错里没有那条行的 id —— 人会去修没坏的那一半
 * （同 auto-approve.ts 那条 MALFORMED_PAYLOAD_PROBE_SQL 撞的是同一件事）。
 */
const DECISIONS_SQL =
  "SELECT " +
  "SUM(CASE WHEN json_valid(payload) = 1 AND json_extract(payload, '$.auto_approved_by') IS NOT NULL THEN 1 ELSE 0 END) AS auto_approved, " +
  "SUM(CASE WHEN json_valid(payload) = 1 AND json_extract(payload, '$.kind') = 'ApprovalRequired' THEN 1 ELSE 0 END) AS to_human, " +
  "SUM(CASE WHEN actor_type = 'human' THEN 1 ELSE 0 END) AS human_decided " +
  "FROM events WHERE action = 'approval' AND created_at >= ? AND created_at <= ?";

function row(
  db: DatabaseSync,
  sql: string,
  params: readonly unknown[],
): Record<string, unknown> {
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  const r = db.prepare(sql).get(...(params as never[])) as Record<string, unknown> | undefined;
  if (r === undefined) {
    // 聚合查询不返回行是【事实源出了问题】（表被改名、连接不对），而不是「这个数是 0」。
    // 把缺行读成 0 会让首页显示「今天什么都没发生」—— 那正是这一页最坏的一种说谎。
    throw new Error(
      "今日视图的聚合查询没有返回行：[" + sql.slice(0, 70) + "…]。" +
        "COUNT/SUM 恒返回一行，拿不到行说明这条查询根本没跑到那张表。",
    );
  }
  return r;
}

function count(
  db: DatabaseSync,
  sql: string,
  params: readonly unknown[],
  what: string,
): number {
  return Number(row(db, sql, params)[what] ?? 0);
}

/** 窗口上限。上限不是性能问题而是「窗口越宽 ⇒ json_extract 扫的行越多」，
 *  而这条查询跑在【只读连接】上（不受写锁影响）却仍在主线程上同步跑。 */
export const MAX_WINDOW_MS = 90 * DEFAULT_WINDOW_MS;

/**
 * 今日视图的全部四个数。只读、不排队、不写任何东西。
 *
 * `nowMs` 由调用方给（`HubDeps.now()`），不在这里读时钟：这一发要报的
 * 「窗口」与「服务端时刻」必须同源，否则一台时钟偏的机器会让摘要条写着
 * 「过去 24 小时」而实际覆盖的是另一个区间（同 listApprovals 带 asOfMs 的理由）。
 */
export function readToday(
  db: DatabaseSync,
  o: { readonly nowMs: number; readonly windowMs?: number } = { nowMs: Date.now() },
): TodayView {
  const windowMs = Math.min(Math.max(Math.trunc(o.windowMs ?? DEFAULT_WINDOW_MS), 1), MAX_WINDOW_MS);
  const from = o.nowMs - windowMs;
  const notes: string[] = [];

  const bad = count(db, MALFORMED_PROBE_SQL, [from, o.nowMs], "n");
  if (bad > 0) {
    notes.push(
      "这个窗口里有 " + bad + " 条 events 的 payload 不是合法 JSON，它们已被跳过（不算进下面任何一个数）。" +
        "appendAudit 只会写合法 JSON，所以这些行是【库被外部改过】的痕迹。",
    );
  }

  const deliveredRow = row(db, DELIVERED_SQL, [from, o.nowMs]);
  const delivered = Number(deliveredRow["n"] ?? 0);
  const unattributed = Number(deliveredRow["unattributed"] ?? 0);
  if (unattributed > 0) {
    notes.push(
      "有 " + unattributed + " 行 state_change 记的是【不属于任何任务】的交付（task_id 为空），" +
        "它们【没有】算进「今天完成几件事」—— 那一格问的是任务。这一行说的是【别的东西】也交付了。",
    );
  }
  const blocked = count(db, BLOCKED_SQL, BLOCKED_STATUSES, "n");
  const active = count(db, ACTIVE_SQL, INACTIVE_STATUSES, "n");

  const budget = row(db, BUDGET_SUM_SQL, ["task", "per_task"]);
  const scopes = Number(budget["scopes"] ?? 0);
  const consumedTotal = Number(budget["consumed"] ?? 0);
  const declared = Number(budget["declared"] ?? 0);
  const consumedWindow = count(db, BUDGET_WINDOW_SQL, [from, o.nowMs], "consumed");
  const silentOver = silentOverBudgets(db).length;

  const raw = row(db, DECISIONS_SQL, [from, o.nowMs]);
  /**
   * SUM 过【零行】时返回的是 SQL 的 NULL 而不是 0（实测：空表上
   * `SELECT SUM(CASE WHEN 1=1 THEN 1 ELSE 0 END)` 给 `null`）。
   *
   * ⚠ 真正承重的是外层那个 `Number()`，不是里面的 `?? 0` —— 这一条我是【跑变异跑出来的】：
   *   把 `?? 0` 拆掉，那一发【全绿】，因为 `Number(null) === 0`。
   *   而我原本写在这儿的理由（"少了这一步就会得到三个 null"）讲的是【第一版】的形态：
   *   那一版没有 Number()、把 SQL 的值【原样透传】，于是 null 一路到了响应里。
   *   留着 `?? 0` 的理由换成另一条真实存在的：`Number(undefined)` 是 NaN，
   *   而 undefined 出现在【列被改名】的时候（`row()` 那道门只管"有没有行"，管不了列名）。
   *   NaN 比 null 更坏 —— JSON.stringify 会把它写成 null，于是响应里那句"取不到"是【伪造出来的】。
   *
   * ⚠ 但别把下面这三行读成"被测住了"：把 `?? 0` 或 SQL 里的 COALESCE 拆掉，
   *   本模块的测试【全绿】，因为 node:sqlite 对 SUM 返回的就是真数字，
   *   而 `Number(null)` 与 `null ?? 0` 得到同一个 0。这里留着的是【等价写法里更稳的那个】，
   *   不是一条有分母的判据。空库那一发钉的是"响应里不许出现 null"（那条【有】分母：
   *   第一版真的透传过，空库上一片 null），至于第三行能不能挡住改列名，我不知道、也没测。
   */
  const decided = {
    auto_approved: Number(raw["auto_approved"] ?? 0),
    to_human: Number(raw["to_human"] ?? 0),
    human_decided: Number(raw["human_decided"] ?? 0),
  };

  // 三条「今天别按字面读」的话，只在条件真的成立时说（每次都念一遍的东西会被忽略）。
  if (decided.auto_approved === 0) {
    notes.push(
      "「自动通过 0 项」的含义是【策略引擎今天没有生产调用方】（0014 §3），不是「没有可逆决策」。",
    );
  }
  if (scopes === 0) {
    notes.push(
      "预算那一格一行都没有 ⇒ 这台 Hub 从没声明过上限。不是「上限是 0」（那是一分钱都不许花），" +
        "是【没设限】。两种情况界面上该说的话相反。",
    );
  } else {
    notes.push(
      "预算的「上限」是【各任务 per_task 之和】，不是「今天可以花多少」：角色级 daily 那一格" +
        "今天没有声明方，而 budgets 是累计值（无 updated_at、只加不减），" +
        "所以【按天的上限】这个数在库里不存在，这里不编。",
    );
  }
  if (silentOver > 0) {
    notes.push(
      "有 " + silentOver + " 格预算已超限而【突破警报已经哑】（把上限调到已消费量之下会永久关闭警报，" +
        "0015 文件头 ②）。数还在，警报没了 —— 这一格只能在这里看见。",
    );
  }

  return {
    as_of_ms: o.nowMs,
    window_ms: windowMs,
    delivered_in_window: delivered,
    blocked_tasks: blocked,
    active_tasks: active,
    // 发出的是【判据本身】而不是它的产物。少这一行，界面只能自己抄一份清单，
    // 而那份抄件没有任何测试能发现它和这里不一致（变异测试跑在 hub 侧，看不见 web 侧）。
    blocked_statuses: BLOCKED_STATUSES,
    attention_statuses: ATTENTION_STATUSES,
    ceo_decision_statuses: CEO_DECISION_STATUSES,
    operational_approval_types: OPERATIONAL_APPROVAL_TYPES,
    budget: {
      consumed_in_window_cents: consumedWindow,
      consumed_total_cents: consumedTotal,
      declared_task_limits_cents: declared,
      declared_scopes: scopes,
      silent_over_scopes: silentOver,
    },
    decisions: {
      auto_approved_in_window: decided.auto_approved,
      to_human_in_window: decided.to_human,
      human_decided_in_window: decided.human_decided,
    },
    notes,
  };
}
