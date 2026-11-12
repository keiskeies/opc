/**
 * 常驻 Hub 的驱动器：把「CEO 下发一个想法」与「各个角色吭哧吭哧干活」接上。
 *
 * ── 为什么需要它（【规格】§7.2 步骤 2–7 要的是 CEO 什么都不做）──────────
 * 0044 补上了「章程卡从哪来」，0046 补上了「走到人席时她看得见、点得动」，
 * 0047 补上了「顶层是谁不该问名字」。合起来仍然有一格是空的：
 *   CEO 批掉一张卡 ⇒ 任务进到 CHARTER_APPROVED ⇒ 那一格是【agent 席位】
 *   ⇒ 全仓没有任何东西会让它跑下一轮。
 * `advance()`（engine/driver.ts）早就会推这个循环，而它当时【只有一个生产调用方】：
 * `hub work`，而那条命令要 tsx 而本机装不上（0039）。也就是说
 * 「一个人公司」在真机上仍然需要有人每过一格去终端敲一次回车。
 * 本篇接的就是那一次敲回车。
 *
 * ── 住在 serve/ 而不是 engine/（与章程泵同一条分界）─────────────────
 * 「什么时候再推一次」是常驻进程的【节奏】，不是引擎的【能力】。
 * engine/ 那一侧已经知道怎么推一格（makeDispatch）与推到推不动（advance），
 * 反过来放会让 engine/ 认识 Scheduler —— 它今天能在 CLI 单发跑完靠的就是它不认识任何东西。
 * 与 patrol.ts 那句「故意不 setInterval，tick 由调用方驱动」同形：本文件也叫一次动一次。
 *
 * ── 为什么候选状态是【派生】的而不是抄一份名单 ────────────────────────
 * 判据是 `seatOf(s) === "agent"`，也就是 `Object.keys(AGENT_EDGES[s]).length > 0`
 * —— 与 dispatch 决定「这一格放不放 agent 进场」用的【同一个谓词】（dispatch.ts:150）。
 * 抄一份状态名单会造出两个来源判同一件事，而漂移的方向是这一族里最贵的那种：
 * 将来给某个状态加一条 agent 出边，dispatch 会跑它而驱动器【不会想到它】——
 * 症状是"那条边只在有人手动跑 work 时才动"，与"这条边坏了"在屏幕上一样。
 * 派生的默认值是「新增一格自动可驱动」，而那是【对的方向】：那条边能走 = 那格该被驱动。
 *
 * ⚠ 顺带说清 `BUDGET_PAUSED` 为什么在候选里而不在任何名单里：它有一条 agent 出边
 * （`blocked` → `ESCALATED_TO_CEO`），所以派生结果包含它。今天【没有任何代码写那个状态】
 * （0041 §7），所以这一支是空转的；真有一天有了，驱动器的做法是【花一轮钱让那个角色自己说
 * blocked】而【不】替它免钱宣布 —— 理由与两个候选的代价都在 0047 §7。
 * `MEETING_REQUIRED` / `BLOCKED` 两格【结构性地进不了候选】：两张边表都没有出边，
 * 于是它们连"可驱动"这个谓词都不满足（不是被排除，是没有可走的路）。
 *
 * ── 按格的尝试次数住在【审计】里，且必须按【这一格】计 ─────────────────
 * 一个会花钱的自动循环必须有界。章程泵数的是「这条任务上跑过几轮 RoleTurnReported」，
 * 那个数在章程那一格是安全的（没有任何合法边能把任务送回 CHARTER_PENDING）。
 * 驱动器【不能照抄那个数法】，两个理由：
 *   ① 任务在 agent 那一族里【会重复经过同一格】（打回 ⇒ IN_PROGRESS），
 *      而 RoleTurnReported 在【每一格】都可能有别人的轮次 —— 包括 `hub work` 手跑的那些。
 *      拿它当上限，等于手跑几次就把自动的那条路永久关掉。
 *   ② 上限要挡的是「在这一格反复花钱而没推进」，那必须是【按格】的计数。
 * 所以驱动器写【自己的一行】（payload.kind = DriverTurnClaimed，target = "<状态>:<角色>"），
 * 只数自己写的、只数落在【这一次来到这一格之后】的那些（见 driverCandidatesSql 那条 marker）。
 *
 * ⚠ 为什么是「先写行、再花钱」而不是反过来：崩溃循环（起了子进程而没活到写结论）
 * 正是上限要挡的那一种，而"跑完再记"的记法会【恰好漏掉全部崩溃】——
 * 于是上限看起来在而永远数不到需要它的那些次。代价是审计里可能出现一行
 * 「认领了而那一轮没跑完」；那一行说的就是"认领"这件事本身，
 * 它没有声称任何一轮发生过，所以它不是假记录。
 *
 * ── 这一格与【停滞巡检】的相互作用（量过两次，第一次量错了）────────────
 * patrol 算「这任务多久没动」用的是 `max(created_at) WHERE payload.kind IS NOT NULL`
 * （PATROL_SQL）。也就是说【任何带 payload.kind 的行都会重置停滞计时器】——
 * 包括驱动器自己写的认领行。于是驱动器每心跳写一行认领，等于把那条任务的
 * 停滞计时器【每心跳拨一次零】：在【还在试的那几轮里】巡检认为"这一格有人在看着"，
 * 而唯一在看着它的东西正是【正在失败的那个循环】。这条窗口是真的，
 * 也正是「尝试上限」存在的理由（那几轮在花钱而没推进，且没有任何外部告警）。
 *
 * ⚠ 但我第一版把这一条写成了【上限到顶之后巡检也永远不会报这一格】，
 * 那是【读了一遍 PATROL_SQL 就下的结论而没跑一遍】。量过之后（/tmp/probe48c，
 * maxAttempts=3，阈值 DEFAULT_STALL_THRESHOLD_MS=30 分钟）：
 *   三趟驱动跑完 ⇒ 认领行 3 行 + 放弃行 1 行，last_real_event_at 被推到最后一趟那一刻；
 *   同刻巡检 ⇒ verdict=recent，不报（这是上面那个窗口，真的）；
 *   放弃之后驱动器【不再认领】⇒ 那一行之后没有新行 ⇒ 计时器开始变老；
 *   推进到「最后一行 + 阈值 + 1 分钟」再巡 ⇒ 【stalled=1，silentFor=31 分钟】。
 * ⇒ 正确的说法是【两个时段】而不是一个断言：
 *   · 还在试的那几轮：巡检被认领行弄哑 —— 这是真的盲区，也是上限必须存在的理由。
 *   · 放弃之后：巡检会在约一个阈值之后【自己报出来】，是一层延后的兜底。
 * 那"io.warn 仍然必须响"这条结论【不变】，但理由要换准：不是"否则永远没人报"，
 * 而是①那句 io.warn 是【当场】的信号而巡检那句要再等约 30 分钟，
 * ②巡检那一层【只在 Hub 继续开着且心跳继续跑】的前提才存在（放弃之后就退进程 /
 * 心跳坏掉 ⇒ 那层兜底不存在），③巡检那句是"停滞 N 个任务"一句计数，
 * 不会说出"这是驱动器试到上限那一格、它的认领行自己把计时器拨着"这段成因，
 * 而这段成因正是知道该去改什么所需要的。
 * 所以 reportDriveRound（assemble.ts）对 gave_up 那一支仍必须 io.warn，
 * 而它现在说的是【当场】而不是【唯一】—— 措辞错了会让人以为巡检坏了。
 *
 * ── 花钱的东西不给默认值，也不默认开 ────────────────────────────────
 * 与 --charter-pump 同一条立场而理由更长：章程泵起的是一次【起草】，
 * 驱动器起的是【一条链上的每一轮】（一条想法可能连着跑掉好几轮真钱）。
 * 所以 `--driver-pump` 不写 ⇒ 这一整块不存在，`hub:serve` 今天照样一分钱不花；
 * 写了则三个上限同伴必填，且【刻意没有 env 缺省源】（账单是事后才知道的）。
 *
 * ── 本篇【没有】补上的一格 ──────────────────────────────────────────
 *  · 「追加预算」仍然没有入口（0041 §7 / 0045 §7）：花钱的门挡住一条任务时，
 *    这一轮只能【说出来】而不能放开它。
 *  · 打回之后【没有自动重跑上游角色】这一说 —— 驱动器只是下一轮把新那一格推一次。
 *    「谁该被叫起来改」是 dispatch 的 handoff 语义决定的，本篇不加边。
 *  · 并行分支（同一想法下多条任务）各推各的，本篇不引入任何跨任务的顺序或依赖。
 */
import type { HubWriter } from "../db/write-queue.js";
import type { EventBus } from "../events/bus.js";
import { appendAudit, KIND_TO_ACTION } from "../events/recorder.js";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import { AGENT_EDGES, makeDispatch, seatOf } from "../engine/dispatch.js";
import { advance, type AdvanceResult } from "../engine/driver.js";
import { makeRuntime, type EngineRuntime } from "../engine/runtime.js";
import { underTaskBudgetSql } from "./charter-pump.js";
import { kindOf } from "../heartbeat/patrol.js";
import type { TaskState } from "../graph/status.js";

/**
 * 驱动器会考虑的那些状态。
 *
 * ⭐ 【派生】而不是抄：`seatOf(s) === "agent"` 与 dispatch 那一侧的门槛是同一个函数，
 * 所以「这一格 dispatch 会不会放 agent 进去」与「驱动器会不会考虑它」
 * 在编译期就是同一件事 —— 两个来源不可能漂。
 *
 * 今天算出来是 CHARTER_APPROVED / DECOMPOSING / IN_PROGRESS / IN_REVIEW / BUDGET_PAUSED。
 * 前四个是【活的那条链】，第五个今天没有写入方（见文件头）。
 */
export const DRIVER_ELIGIBLE_STATES: readonly TaskState[] = Object.keys(AGENT_EDGES).filter(
  (s): s is TaskState => seatOf(s as TaskState) === "agent",
) as readonly TaskState[];

/** 认领行的 target 里状态与角色之间的那个分隔符。写在一处，两侧共用。 */
export const DRIVER_CELL_SEP = ":";

/**
 * 认领行的 target：`"<状态>:<角色>"`。
 *
 * ⚠ SQL 那一侧拼的是 `t.status || ':' || t.assigned_role`（见 driverCandidatesSql），
 * 与本函数是【同一句话的两种写法】。这件事本身是本仓抓过的那类"两份抄件"，
 * 而我没有把它合成一份的手段：一行审计的 target 只能在写的时候知道，
 * 而计数只能在读的时候按列拼。挡住漂移的不是注释而是【一发往返用例】：
 * 用本函数真写一行，再让候选 SQL 去数它（driver-pump.test.ts B 组）。
 * 分隔符换掉、大小写改掉、顺序换掉，那一发当场红。
 *
 * 为什么把【角色】放进 target 而不是只放状态：一次认领说的是「谁在这一格上花了一轮」，
 * 只放状态会把 dev 的三次失败算到接手它的 manager 头上（打回重来换了人，
 * 上限却是延续的 —— 而换了人正是"这次可能不一样"的那个理由）。
 */
export function driverCellTarget(state: string, role: string): string {
  return state + DRIVER_CELL_SEP + role;
}

/** 认领行的 payload.kind。 */
export const DRIVER_CLAIM_KIND = "DriverTurnClaimed";
/** 放弃行的 payload.kind。 */
export const DRIVER_GAVE_UP_KIND = "DriverTurnAbandoned";

/**
 * 认领/放弃那两行的 actor。
 *
 * `system / driver_pump`，与 patrol 的 STALL_ACTOR、章程泵的 PUMP_ACTOR 同一形状。
 * ⚠ 【绝不】用 agent + 角色名：那会写出「manager 跑了一轮」而 manager 什么都没被叫起来 ——
 * 那正是 0047 花整篇消灭的那行 `actor_type='agent', actor_id='ceo'` 的复刻。
 * 驱动器是【决定叫谁干活的那个人】，不是【干活的那个人】。
 */
export const DRIVER_ACTOR = { actorType: "system", actorId: "driver_pump" } as const;

/**
 * SQL 那一侧的【那一格】：`t.status || ':' || t.assigned_role`（`t` 换成 tasks 的别名）。
 *
 * ⭐ 这一格被抽成函数，是因为它现在有【两个读侧使用点 + 一个写侧】：
 *  ① 写：`driverCellTarget(state, role)`（TS 侧，认领行/放弃行的 target 列）；
 *  ② 写侧的自数：`driverAttemptsSql` 里那句 `p.target = <这一格>`；
 *  ③ 读：`overview/today.ts` 的「这一格被放弃了没有」（0048 §7 那一站）。
 * 三处各写一遍字面量，漂了的那份【不会有人发现】，而两处的失效方向不一样：
 * ②漂 ⇒ 上限数不到东西 ⇒ 驱动器在同一格【无限花钱】；
 * ③漂 ⇒ 界面上那一行「不再推」永远不出现 ⇒ 0048 整篇要消灭的那个状态原样回来。
 * 挡住漂移的手法与 kindOf() 一模一样（0026 §0）：**不是注释，是同一个函数**。
 * 而它必须是一段 SQL 而不是把 ① 的结果绑进去：这一格要拿 tasks 那一行的【当前】
 * 两列去比（任务换了格子，旧的放弃行就不该再算数），而"当前"只有在查询里才知道。
 *
 * 分隔符用 DRIVER_CELL_SEP 常量拼进去，所以换分隔符会【同时】改到写侧与读侧。
 */
export function driverCellTargetSql(t: string): string {
  return (
    t +
    ".status || '" +
    DRIVER_CELL_SEP +
    "' || " +
    t +
    ".assigned_role"
  );
}

/**
 * 【这一格这一次】的锚点：本条任务【最后一次进入当前这一格】那条状态边的 id。
 *
 * 抽成函数的理由与 driverCellTargetSql 同一条，而漂了的失效方向不同：
 * 读侧（`overview/driver-status.ts`）若自己抄一份而【漏掉这个锚点】，
 * 一条被打回、重新走回 `IN_PROGRESS/dev` 的任务会仍然带着上一次那行
 * `DriverTurnAbandoned` ⇒ 界面在它【刚刚被重新推】的时候写着「不再推了」。
 * 那比不显示更坏 —— 0048 一整篇要消灭的是"看不见的沉默"，
 * 而这一发造出来的是【看得见的谎】。
 *
 * 三个条件缺一个都会算错（原文在 driverAttemptsSql 上面那段，逐条对着看）：
 *  · kind = TaskStateChanged 且 payload.to = 当前状态 —— "进入这一格"这件事的落点；
 *  · 用 id 而不用 created_at —— 同一毫秒可以先写边再写认领行，id 才是插入序；
 *  · `json_valid` 那层壳由 kindOf 提供 —— 坏 payload 得 NULL 而不是抛。
 */
export function driverCellMarkerSql(t: string): string {
  return (
    "COALESCE((SELECT MAX(m.id) FROM events m " +
    "WHERE m.task_id = " +
    t +
    ".id " +
    "AND " +
    kindOf("m") +
    " = 'TaskStateChanged' " +
    "AND json_extract(CASE WHEN json_valid(m.payload) THEN m.payload END, '$.to') = " +
    t +
    ".status), 0)"
  );
}

/**
 * 「这条任务在当前这一格上，驱动器已经认领过几次」。
 *
 * 三个条件缺一个都会算错，方向各不同：
 *  ① `target = 状态:角色` —— 按格按人计（见 driverCellTarget 那段）。
 *  ② `p.id > marker` —— marker = 【本条任务最后一次"进入这一格"那条状态边的 id】
 *     （kind=TaskStateChanged 且 payload.to = 当前状态），没有则 0。
 *     这一条挡的是【打回重来的合法重访】：任务被打回 ⇒ 重新进 IN_PROGRESS ⇒
 *     新的 marker ⇒ 之前那些认领【不算进这一次】。少了 ②，
 *     一条被来回打三次回的任务会在第三次之后【永久不可驱动】，而界面上一句提示都没有
 *     —— 上限本该挡"反复花钱而没推进"，那样它会变成"推进过的事也算错过"。
 *     ⚠ marker 用 id 而不用 created_at：同一毫秒内可以先写状态边再写认领行，
 *     按时间比会得到"认领早于进入"从而把它排除掉。id 是 AUTOINCREMENT 的插入序，
 *     在这两点上就是【真实先后】（events.id 就是总线 seq，见 recorder.ts 那段）。
 *  ③ `json_valid` 那层壳由 kindOf 提供（payload 不是合法 JSON 的脏行得 NULL 而不是抛）。
 *     `$.to` 那一层【没有】同样的壳 —— 所以我把 CASE 写在了 json_extract 外面而不是省略它：
 *     库里躺一行坏 JSON 时，省略它的后果是【整趟驱动抛错】而不是"这一格数不到"，
 *     而 patrol 那边同类问题（PATROL_SQL 那段注释）记的正是这一发的教训。
 */
export function driverAttemptsSql(t: string): string {
  const marker = driverCellMarkerSql(t);
  return (
    "(SELECT COUNT(*) FROM events p " +
    "WHERE p.task_id = " +
    t +
    ".id " +
    "AND " +
    kindOf("p") +
    " = '" +
    DRIVER_CLAIM_KIND +
    "' " +
    "AND p.target = " +
    driverCellTargetSql(t) +
    " " +
    "AND p.id > " +
    marker +
    ")"
  );
}

/**
 * 候选：停在某一 agent 格、这一格还没试到上限、而花钱的门开着。
 *
 * 状态集合来自【绑定的占位符】而不是拼进 SQL 的字面量：值出自 DRIVER_ELIGIBLE_STATES，
 * 而它是从边表派生的 —— 拼字符串会在派生集合里出现奇怪名字时【变成一条语法错误】
 * 或者更糟（一句永远为真的条件），而 `IN (?, ?…)` 在同样的错误下只是筛不出东西。
 * 占位符数量由 `placeholdersFor` 从数组长度算出，所以【拼错个数】这件事
 * 在运行期不可能发生（绑参数与 IN 的个数同源）。
 *
 * ⚠ 状态【不能】从 tasks.status 直接信：库里那一列没有 CHECK 约束（0001），
 * 而这里筛的是"值在派生集合里"，所以从 SQL 出来的 status 必然 ∈ DRIVER_ELIGIBLE_STATES。
 * 下面 driveTasks 里仍然逐条 `seatOf` 复核一次 —— 不是防 SQL，是防【未来有人改了候选 SQL
 * 或把派生那一半删掉】那种改动。
 *
 * ⚠⚠ 而这一发复核【今天没有任何测试覆盖】，这一句是本篇变异量出来的（0048 §9 的 M7）：
 * 把它整块去掉 ⇒ 107 发【全绿】。原因不是测试写得松，是【唯一调用方到不了那一支】：
 * 候选 SQL 的 `status IN (DRIVER_ELIGIBLE_STATES)` 与这里问的 `seatOf` 是同一个谓词，
 * 所以从 SQL 出来的每一行必然通过复核 —— 那个分支在当前 API 下【恒假】。
 * 所以它的身份是【今天不承重的保险】（与 assemble.ts 里 `driverBudgetWarned` 那一格同一类）：
 * 留着是因为它便宜、且它挡的那一天（有人把 `DRIVER_ELIGIBLE_STATES` 换成手抄名单、
 * 或给候选 SQL 加一个 `OR`）真的会让"库里那一格根本不该放 agent 进场"变成一次真花钱的子进程；
 * 但它【不是判据】，别把它当判据读 —— 真要让它承重，得先让那一支【可达】，
 * 而那意味着把候选 SQL 或状态集合做成可注入的，本篇不做（那会把"派生"这个卖点换成注入点）。
 * 我第一版在这里写的是「那种改动下复核会响（E 组那发变异）」—— 那句话是【错的】，
 * 而我是在跑变异之前把它写下的。
 *
 * ORDER BY t.updated_at ASC, t.id ASC：最久没动的先推。
 * ⚠ 这一条与【尝试上限】合起来才不构成饿死：一条卡死的任务 updated_at 不变
 * （不推进的那一轮【不写 tasks 行】，只写 events），所以它会永远排在最前，
 * 而 LIMIT 只有几个位子 —— 没有上限时它会把后面所有想法【永久挡在门外】。
 * 有了上限，它最多占前几轮（每心跳一轮）然后被 attempts 滤掉。
 * 这条相互作用写在这里，因为它是【两处各自正确而合起来才有界】的那种：
 * 单独读候选 SQL 或单独读上限都会以为另一侧不需要自己。
 */
export function driverCandidatesSql(states: readonly string[]): string {
  return (
    "SELECT t.id AS id, t.title AS title, t.status AS status, t.assigned_role AS role, " +
    driverAttemptsSql("t") +
    " AS attempts " +
    "FROM tasks t " +
    "WHERE t.status IN (" +
    placeholdersFor(states.length) +
    ") " +
    "AND " +
    driverAttemptsSql("t") +
    " < ? " +
    "AND " +
    underTaskBudgetSql("t") +
    " ORDER BY t.updated_at ASC, t.id ASC " +
    "LIMIT ?"
  );
}

/** `?, ?, ?`（n 个）。绑参数与占位符【同源】，见上面那条。 */
export function placeholdersFor(n: number): string {
  if (!Number.isInteger(n) || n < 1) {
    // 空集合会拼出 `IN ()`（SQLite 语法错误）。空集合在这里是【配置坏了】而不是"什么都不筛"，
    // 所以抛而不是返回一个恒空候选 —— 后者看起来像"今天没有可驱动的任务"。
    throw new Error("驱动器候选 SQL 的状态集合至少要有 1 格，实到 " + String(n));
  }
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push("?");
  return parts.join(", ");
}

/**
 * 「本轮有多少条是【被那道花钱的门挡住的】」—— 与章程泵那一格同一个理由。
 *
 * 候选 SQL 把超限的任务筛掉了，于是它在候选结果里【不存在】：
 * 「系统因为没钱而不再推这条想法」如果只写在库里，那个人看到的与
 * 「驱动器没开」「驱动器在跑而一切正常」是【同一个画面】。
 * 判据与候选那条【同源】（同一个 underTaskBudgetSql、同一个 attempts 谓词），
 * 差别只把「没超钱」反过来。
 */
export function driverBlockedSql(states: readonly string[]): string {
  return (
    "SELECT t.id AS id, t.title AS title, " +
    "COALESCE((SELECT b.consumed_cents FROM budgets b " +
    "WHERE b.scope_type = 'task' AND b.scope_id = t.id AND b.period = 'per_task'), 0) AS consumed " +
    "FROM tasks t " +
    "WHERE t.status IN (" +
    placeholdersFor(states.length) +
    ") " +
    "AND " +
    driverAttemptsSql("t") +
    " < ? " +
    "AND NOT (" +
    underTaskBudgetSql("t") +
    ") " +
    "ORDER BY t.updated_at ASC, t.id ASC"
  );
}

/** 一轮最多推几条任务。上限的上限，方向是省，所以给得起默认值。 */
export const DEFAULT_DRIVER_TASK_LIMIT = 3;
/** 同一格最多认领几次。三次推不动的事，多半不是再多推几次能解决的。 */
export const DEFAULT_DRIVER_MAX_ATTEMPTS = 3;
/**
 * 一条任务一轮最多跑几格。默认沿用 advance 的 12。
 *
 * 这个数字【不是预算】，是最后一道闸 —— advance 文件头写的就是"防上面两条判据被
 * 将来的改动弄失效"。真正的预算是那三格必填（每轮美元硬顶 / 任务级美分上限）。
 * 之所以不在这里调小：调小会把一条正常的深链（5 层汇报 ⇒ 十来个跃迁）判成 limit，
 * 而 limit 那句提示写的是「通常是判据没生效」—— 一个会说谎的默认值。
 */
export const DEFAULT_DRIVER_MAX_TURNS = 12;

/**
 * 单轮 claude 执行的 SIGKILL 上限（claude.ts:85 那个 180_000）。
 *
 * 抄在这里而不是 import 那个数字：claude.ts 那一格是【内部实现默认值】
 * （`i.timeoutMs ?? 180_000`），没有导出常量，而导出它要动一个已接三条调用方的模块。
 * ⚠ 所以这一格【是】一处手抄，会漂；挡住它的不是注释而是下面那条用例
 * （driver-pump.test.ts G 组）：它去 claude.ts 的源码文本里数那个字面量。
 * 漂的时候那一发会红并说"两边不一致"，而那是【该红的一侧】——
 * 数字漂了最坏的后果是关机横幅承诺的等待时间比真的短，
 * 而那句承诺存在的唯一理由就是别让人误判成死锁去 kill -9。
 */
export const CLAUDE_TURN_CAP_MS = 180_000;

/**
 * 「一趟驱动最坏要等多久」，给人话形态。
 *
 * 存在的理由【不是排版】：assemble 关机那一句必须说准这个数，
 * 而 0044 那一版抄的是"最坏 180 秒"—— 那是章程泵的数字，
 * 驱动器的是 任务数 × 格数 × 180 秒，差一个数量级。
 * 一个偏小的等待承诺会让人在第四分钟判定进程卡死并 kill -9，
 * 而那正是那句话本来要防的动作。所以它做成【从两个配置算出来】的函数，
 * 而不是又一处写死的字符串。
 */
export function worstDriveWaitMs(o: { readonly taskLimit: number; readonly maxTurns: number }): string {
  const ms = o.taskLimit * o.maxTurns * CLAUDE_TURN_CAP_MS;
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return min + " 分钟";
  const h = Math.floor(min / 60);
  const rest = min - h * 60;
  return rest === 0 ? h + " 小时" : h + " 小时 " + rest + " 分";
}

/** 推一条任务的那一步。测试注入假的那一发；默认走真 runtime + 真 dispatch。 */
export type DriveTaskFn = (taskId: string, maxBudgetUsd: number, maxTurns: number) => Promise<AdvanceResult>;

export interface DriveOptions {
  readonly nowMs: number;
  /**
   * 推一条任务这一步的实现。不给 ⇒ 现造真 runtime（makeRuntime + makeDispatch + advance）。
   *
   * 注入点是【一整步】而不是 runTurn，与章程泵那边【分开两个注入点】的做法不同，
   * 理由：那边要注入的是"起草时别 spawn"，而它必须让【其余装配】保持真的，
   * 所以只能注入最里面那一格；这一边要注入的是"别真推"，而循环本身是本篇的逻辑本体，
   * 注到最里面那一格反而【测不到循环】。
   * ⚠ 代价照记（0044 §9.2 那条教训的形状）：注入之后【默认那一支】没有覆盖 ——
   * 也就是「bin / cwd / recordTurn 有没有接到真 runtime 上」这件事需要
   * 【另一发跑真子进程的用例】，不能靠这组注入用例宣称接上了。driver-pump.test.ts F 组判它。
   */
  readonly driveTask?: DriveTaskFn;
  /** 每轮的美元硬顶。必填（0041 §8）。 */
  readonly maxBudgetUsd: number;
  /** 任务级预算上限（美分）。必填。 */
  readonly taskLimitCents: number;
  /** agent 工作目录（§12 那一维）。必填 —— 猜一个目录等于猜它能看见哪些文件。 */
  readonly cwd: string;
  readonly bin?: string;
  readonly maxAttempts?: number;
  readonly taskLimit?: number;
  readonly maxTurns?: number;
  readonly ceoRoleId?: string;
}

export type DriveOutcome =
  /** 推了一轮以上（stopped 说停在哪儿）。 */
  | "driven"
  /** 这一格试到上限，本轮判【放弃】并留了一行。 */
  | "gave_up"
  /** 本轮那一发直接抛了（钱可能已经花了，见下面 note）。 */
  | "threw";

export interface DriveRoundResult {
  readonly driven: readonly {
    readonly taskId: string;
    readonly title: string;
    readonly state: string;
    readonly role: string;
    readonly outcome: DriveOutcome;
    /** advance 的停机原因；抛了那一支是 null。 */
    readonly stopped: AdvanceResult["stopped"] | null;
    readonly turns: number;
    readonly costCents: number;
    readonly note: string;
  }[];
  readonly costCents: number;
  readonly abandoned: readonly string[];
  readonly blocked: readonly { readonly taskId: string; readonly title: string; readonly consumedCents: number }[];
}

const nothing: DriveRoundResult = { driven: [], costCents: 0, abandoned: [], blocked: [] };

/**
 * 一趟驱动。心跳每轮叫一次；测试也直接叫这一发。
 *
 * 逐条【各自不牵连】：一条推炸了不该让同轮另外两条不推（与章程泵同一条理由）。
 * 任何一条抛了都记成 threw 而【不整轮抛】—— 抛到 ticker 那层会变成心跳失败计数，
 * 连番之后停掉的是【整条心跳】（含巡检与备份）。一条任务推不动，
 * 不该让停滞检测从此不再运行。
 */
export async function driveTasks(w: HubWriter, bus: EventBus, o: DriveOptions): Promise<DriveRoundResult> {
  const maxAttempts = o.maxAttempts ?? DEFAULT_DRIVER_MAX_ATTEMPTS;
  const perRound = o.taskLimit ?? DEFAULT_DRIVER_TASK_LIMIT;
  const maxTurns = o.maxTurns ?? DEFAULT_DRIVER_MAX_TURNS;
  // 这三条抛在任何读写之前。maxAttempts=0 会让候选恒空，
  // 表现是"驱动器在跑而永远无事可做"，而那不是配置错该有的样子（章程泵同一条）。
  // 逐条写而不是 for (const [name, v] of …)：那种写法要把 name 反过来索引回 o 才拿得到
  // 实到的值，而那一圈下标是【运行时才成立】的（TS 只能靠 as 糊过去）。
  // 三行重复换来的是每一行的报错里那个数字是【编译器已经证明存在的那个】。
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("驱动器的 maxAttempts 必须是 >= 1 的整数，实到 " + String(o.maxAttempts));
  }
  if (!Number.isInteger(perRound) || perRound < 1) {
    throw new Error("驱动器一轮最多推几条（taskLimit）必须是 >= 1 的整数，实到 " + String(o.taskLimit));
  }
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new Error("驱动器单条任务最多推几格（maxTurns）必须是 >= 1 的整数，实到 " + String(o.maxTurns));
  }

  const states = DRIVER_ELIGIBLE_STATES;
  const candidates = w
    .readConnection()
    .prepare(driverCandidatesSql(states))
    // ⚠ 绑参顺序 = ? 的出现顺序：N 个状态、attempts 上限、花钱的门、limit。
    // 而 node:sqlite 绑错顺序【不报错】（0044 记过那一发：把 limit 当成预算去比）。
    // 这里状态在前是因为它们在 SQL 里写在前（WHERE 的第一句），
    // 而这一处后面跟着【两个数字相邻而语义无关】—— 配一发判据：
    // taskLimit=1 而 taskLimitCents 很大时，门必须还是门（driver-pump.test.ts D 组）。
    .all(...states, maxAttempts, o.taskLimitCents, perRound) as unknown as {
    id: string;
    title: string;
    status: string;
    role: string;
    attempts: number;
  }[];

  const blocked = (
    w
      .readConnection()
      .prepare(driverBlockedSql(states))
      .all(...states, maxAttempts, o.taskLimitCents) as unknown as {
      id: string;
      title: string;
      consumed: number;
    }[]
  ).map((b) => ({ taskId: b.id, title: b.title, consumedCents: Number(b.consumed) }));

  if (candidates.length === 0 && blocked.length === 0) return nothing;
  if (candidates.length === 0) return { ...nothing, blocked };

  const drive = o.driveTask ?? defaultDriver(o, w, bus);
  // 局部累加器写成【可变】的而【不用】 DriveRoundResult["driven"]：
  // 那个类型是 readonly 数组，拿它当局部类型会把 push 一起禁掉（章程泵同一条）。
  const driven: {
    readonly taskId: string;
    readonly title: string;
    readonly state: string;
    readonly role: string;
    readonly outcome: DriveOutcome;
    readonly stopped: AdvanceResult["stopped"] | null;
    readonly turns: number;
    readonly costCents: number;
    readonly note: string;
  }[] = [];
  const abandoned: string[] = [];
  let costCents = 0;

  for (const c of candidates) {
    // 复核：候选 SQL 已经按派生集合筛过，这一发判的是【派生那一半被改坏】（见候选 SQL 那段）。
    if (seatOf(c.status as TaskState) !== "agent") {
      // 不认领、不花钱，而【要说】—— 一句"库里这一格不在边表里"的静默跳过
      // 与"驱动器没理它"同形，而前者是 bug。
      driven.push({
        taskId: c.id,
        title: c.title,
        state: c.status,
        role: c.role,
        outcome: "threw",
        stopped: null,
        turns: 0,
        costCents: 0,
        note: "候选 SQL 交出了 " + c.status + "，而 seatOf 判它不是 agent 席位 —— 派生与筛子已经不一致。",
      });
      continue;
    }
    // 先认领，再花钱（顺序是判据，见文件头那段：崩溃循环正是上限要挡的那种）。
    await writeClaim(w, c.id, c.status, c.role, Number(c.attempts) + 1, maxAttempts, o.nowMs);
    try {
      const r = await drive(c.id, o.maxBudgetUsd, maxTurns);
      costCents += r.totalCostCents;
      driven.push({
        taskId: c.id,
        title: c.title,
        state: c.status,
        role: c.role,
        outcome: "driven",
        stopped: r.stopped,
        turns: r.turns.length,
        costCents: r.totalCostCents,
        note: stopNote(r),
      });
    } catch (e) {
      // ⚠ 这一支【不重记钱】也【不说花了多少】：advance 抛的时候钱可能已经花了，
      // 而那个数在它内部（turns 累加器）而抛错拿不到。写 0 会是【一句听起来像结论的谎】，
      // 所以 note 里明写"这一发的花费拿不到，要看 harness_calls"。
      driven.push({
        taskId: c.id,
        title: c.title,
        state: c.status,
        role: c.role,
        outcome: "threw",
        stopped: null,
        turns: 0,
        costCents: 0,
        note: "驱动器推这一发直接抛了（原文如下）。它【可能已经花掉钱】—— 那个数在这里拿不到，" +
          "要查这一条任务的 harness_calls：\n" +
          (e instanceof Error ? e.message : String(e)),
      });
    }
  }

  // ── 判放弃：本轮【推完还是没动】而它已经到了上限 ────────────────────
  // 与章程泵同一条结构理由：候选 SQL 里的 attempts 是【本轮之前】的数字，
  // 本轮这一发可能刚好用完最后一次；下一轮它不再进候选（被 SQL 滤掉），
  // 所以这是【驱动器自己还能看见它】的最后一轮。不在这里留一行并【说出来】，
  // 这一格对驱动器就成了沉默。
  // ⚠ 我原来在这句后面还写着"于是连巡检也不会报"，那是【错的】（量过，见文件头那条）：
  // 放弃之后驱动器不再认领 ⇒ 不再有行把停滞计时器拨着 ⇒ 巡检约一个阈值之后
  // 会自己报这一格。所以这一行不是【唯一】的信号，它是【当场】那一个，
  // 巡检那一个是【延后约 30 分钟且要心跳还在跑】的那一个。
  for (const c of candidates) {
    // 先判【还在不在原来那一格】，再数次数。顺序不是风格：任务被推走之后
    // driverAttemptsSql 数的是【新格】的次数（新格 marker 变了、认领为零），
    // 于是"次数不到上限"这一条会替它说话而掩盖真正的理由 ——
    // 真正的理由是【这一格已经被离开了，"试到上限"这件事不再成立】。
    const still = w.readConnection().prepare("SELECT status FROM tasks WHERE id = ?").get(c.id) as
      | { status: string }
      | undefined;
    if (still === undefined || still.status !== c.status) continue;
    const after = Number(
      (
        w
          .readConnection()
          .prepare("SELECT " + driverAttemptsSql("t") + " AS n FROM tasks t WHERE t.id = ?")
          .get(c.id) as { n: number } | undefined
      )?.n ?? 0,
    );
    if (after < maxAttempts) continue;
    abandoned.push(c.id);
    driven.push({
      taskId: c.id,
      title: c.title,
      state: c.status,
      role: c.role,
      outcome: "gave_up",
      stopped: null,
      turns: 0,
      costCents: 0,
      note:
        "在 " + c.status + "/" + c.role + " 这一格试到第 " + after + " 次（上限 " + maxAttempts + "）而没推进，" +
        "驱动器不再推（那条 " + DRIVER_GAVE_UP_KIND + " 审计里有细节）。",
    });
    await writeGaveUp(w, c.id, c.status, c.role, after, maxAttempts, o.nowMs);
  }

  return { driven, costCents, abandoned, blocked };
}

/**
 * 停机原因 → 一句人话。
 *
 * ⚠ 这一份【不是】engine/driver.ts 的 describeAdvance 的复用，而是刻意另写的一份，
 * 理由要说准（否则看起来像没看见那个现成的）：describeAdvance 给 stalled 那支写的是
 * 「再推一次 hub work 即可」，而那句话在本文件的上下文里【正好是错的】——
 * 驱动器存在的全部理由就是「没有人再敲 hub work」。复用它会得到一句
 * 出现在自动路径上的手工补救指令，而那正是 0043 抓过的那类「报错教的那一步跑不起来」。
 * 两份共用的部分是【停机原因的四个值】（AdvanceResult["stopped"]），那才是判据；
 * 措辞各写一份的代价是同一件事在两条路径上说法略不同，我接受它，
 * 因为把 describeAdvance 改成"按调用方换那句 tail"会让引擎层认识"谁在驱动它"。
 */
function stopNote(r: AdvanceResult): string {
  if (r.turns.length === 0) return "一轮都没跑起来";
  const last = r.turns[r.turns.length - 1];
  const note = last === undefined ? "" : "：" + last.res.note;
  if (r.stopped === "human_seat") return "停在 " + r.status + "，那一格是【人类席位】—— 下一次点击在你手上" + note;
  if (r.stopped === "stalled") return "停在 " + r.status + "，角色这一轮没推进（它说了等，或它的动作对不上任何一条合法边）" + note;
  if (r.stopped === "limit") return "撞上单轮格数上限（" + r.turns.length + " 格）而没停 —— 通常是 advance 的「不动就停」那条判据没生效" + note;
  return "任务在库里找不到了";
}

/**
 * 认领那一行。纯审计行，形状照 charter-pump 的 writeGaveUp / charter store / org commit 三处先例：
 * 不广播、不新增 DomainEvent 的 kind（加 kind 要改 contracts 且 web 投影要接，
 * 而这一行【没有对应的状态跃迁】—— 广播一条没有跃迁的帧会被投影的 default 那一支丢掉，
 * 得到"库里有、SSE 发了、界面什么都不变"那种最难发现的坏，0044 §6 量过），
 * action 复用 KIND_TO_ACTION.RoleTurnReported（= 'tool_call'）：
 * 十个值是 §22.1 的 append-only 枚举，加第 11 个属改规格。
 * 选 'tool_call' 的理由与 RoleTurnReported 同一条：它是十个值里唯一语义为
 * 「有件事干过而没做决定」的那个。
 *
 * ⚠ 这条行会【重置停滞巡检的计时器】（文件头那条相互作用）。这是被接受的代价而不是疏忽：
 * 另一种写法（不写行）会让"驱动器在这一格花了三轮钱"这件事【只存在于内存里】，
 * 进程一重启就清零 ⇒ 上限变成"每次重启重新数三次"，那是比计时器被拨更坏的形状。
 */
async function writeClaim(
  w: HubWriter,
  taskId: string,
  state: string,
  role: string,
  attempt: number,
  maxAttempts: number,
  nowMs: number,
): Promise<void> {
  await w.node(() => {
    // node() 里的连接【必须】现取（与 runtime.recordTurn / charter-pump.writeGaveUp 同一句理由）：
    // 写连接只在作用域里暴露，而只有这一次 INSERT 参与那次提交。
    const db = requireScopeDb("serve.driver-pump.claim");
    appendAudit(
      db,
      {
        taskId,
        actorType: DRIVER_ACTOR.actorType,
        actorId: DRIVER_ACTOR.actorId,
        action: KIND_TO_ACTION.RoleTurnReported,
        target: driverCellTarget(state, role),
        payload: {
          kind: DRIVER_CLAIM_KIND,
          task_id: taskId,
          state,
          role,
          attempt,
          max_attempts: maxAttempts,
          note: "驱动器准备在 " + state + "/" + role + " 这一格推一轮（第 " + attempt + "/" + maxAttempts + " 次）。",
        },
        createdAt: nowMs,
      },
      () => nowMs,
    );
    return null;
  });
}

/** 放弃那一行。同样是纯审计行（不广播），理由见 writeClaim 那段。 */
async function writeGaveUp(
  w: HubWriter,
  taskId: string,
  state: string,
  role: string,
  attempts: number,
  maxAttempts: number,
  nowMs: number,
): Promise<void> {
  await w.node(() => {
    const db = requireScopeDb("serve.driver-pump.gave-up");
    appendAudit(
      db,
      {
        taskId,
        actorType: DRIVER_ACTOR.actorType,
        actorId: DRIVER_ACTOR.actorId,
        action: KIND_TO_ACTION.RoleTurnReported,
        target: driverCellTarget(state, role),
        payload: {
          kind: DRIVER_GAVE_UP_KIND,
          task_id: taskId,
          state,
          role,
          attempts,
          max_attempts: maxAttempts,
          note:
            "驱动器在 " +
            state +
            "/" +
            role +
            " 这一格试到上限（" +
            attempts +
            " / " +
            maxAttempts +
            "）而任务还停在原格，不再推。" +
            "这一行之后驱动器不再为这一格留行，所以停滞巡检会在约一个阈值之后自己报它；" +
            "在还试的那几轮里，认领行把那一格的停滞计时器一直拨着，巡检是看不见的。" +
            "要往下走得人工看一眼。",
        },
        createdAt: nowMs,
      },
      () => nowMs,
    );
    return null;
  });
}

/**
 * 默认那一支：真 runtime + 真 dispatch + advance，三者【出自同一套 runtime】。
 *
 * 与章程泵的 engineOf 同一条实质理由：recordTurn 与 runTurn 在 runtime.ts 文件头
 * 是被【故意分开】的，分开装配等于允许"执行走 A 套而执行日志记 B 套"。
 * 惰性：候选为空那一轮一次都不建（早退在上面）。
 */
function defaultDriver(o: DriveOptions, w: HubWriter, bus: EventBus): DriveTaskFn {
  let rt: EngineRuntime | null = null;
  const runtime = (): EngineRuntime => {
    if (rt === null) {
      rt = makeRuntime({
        writer: w,
        bus,
        maxBudgetUsd: o.maxBudgetUsd,
        taskLimitCents: o.taskLimitCents,
        cwd: o.cwd,
        ...(o.bin === undefined ? {} : { bin: o.bin }),
        ...(o.ceoRoleId === undefined ? {} : { ceoRoleId: o.ceoRoleId }),
        nowMs: () => o.nowMs,
      });
    }
    return rt;
  };
  return async (taskId, maxBudgetUsd, maxTurns) => {
    const r = runtime();
    const dispatch = makeDispatch(r.deps);
    return advance(r, (x) => dispatch(x), { taskId, maxBudgetUsd, maxTurns, nowMs: () => o.nowMs });
  };
}
