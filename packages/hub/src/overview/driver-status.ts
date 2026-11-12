/**
 * 「这条想法停在 agent 那一格，而【已经没有人推它了】」—— 看板要的那几格。
 *
 * ── 这一格为什么存在（0048 §7 那一站）──────────────────────────────
 * 0048 把驱动器接上之后，留下一格没接：驱动器试到上限不再推某条任务时，
 * 只在这个终端 `io.warn` 响一声。而 0046 整篇的立场是「你在桌面端看公司」，
 * 终端不在你每天开的那个窗口里。于是有一格的形状是：
 *   任务停在 IN_PROGRESS/dev，界面写着「开发中」，而已经没有任何东西在推它 ——
 *   **在屏幕上与"正在被推"无法区分**。
 * 那正是本仓反复在消灭的那一族（配置写了而没生效、状态说了而没人做），
 * 而这一发的特殊之处是它伪装成的那一头恰好是【一切正常】。
 *
 * ── 为什么判据住在 hub 而不在 app.js（与 blocked_statuses 同一条理由）─
 * 「这一格是不是已经放弃了」问的是：这一格里有没有一行 DriverTurnAbandoned，
 * 且那一行落在【这一次来到这一格之后】。后半句是审计形状的知识，
 * 写进渲染进程就是又一份判据抄件（projection.ts 文件头禁的正是这个）。
 * 所以这里出【判定】，界面只把结果排出来。
 *
 * ── ⭐ 为什么必须连【机器级那两格】一起发 ──────────────────────────
 * 单发「哪些任务被放弃了」会造出一个【新的】同族谎言：驱动器【根本没开】时
 * 这一份名单是【空的】，而空名单在看板上读起来是「没有任何任务被放弃」= 一切正常，
 * 真相是「这台 Hub 从来不推任何东西」。**没有告警读起来像一切正常** ——
 * 那正是这一篇要消灭的形状，只是换个方向再发生一次。
 * 所以响应里带着 enabled / pumping / task_limit_cents，
 * 界面在 driver_enabled 为假时【必须说出来】而不是画一张空名单。
 *
 * ── 三个数为什么是【每请求现取】而不是启动时算一次 ─────────────────
 * 这三格都是【进程状态】，而进程状态里只有 enabled 是启动定的：
 *  · pumping —— 承载驱动器的那条心跳连番失败之后 onFatal 会「不再安排下一轮」
 *    （assemble.ts 那句 io.warn 原文：「停滞检测现在【不再运行】，而 HTTP 仍在服务」）。
 *    那一刻看板还开着，若把启动时的 --driver-pump 原样回放，
 *    就是一句【在出事之后仍然说"有人在推"】的谎。
 *  · task_limit_cents —— 它是花钱那一发的【分母】。它不在库里（只在那条命令行上），
 *    而读侧要报「被钱挡住」就必须用【驱动器用的那个数】，
 *    自己拿 budgets.limit_cents 顶上会得到一句【看着同源而其实不同】的话
 *    （两条 INSERT 都写 limit_cents = 传进去的那个 taskLimitCents，
 *     所以今天两者恰好相等 —— 而"恰好相等"不是同源，见 §文件末那条测试）。
 *
 * ── 三档而不是两档 ────────────────────────────────────────────────
 * 停在 agent 格而没在动的任务，成因不同、**下一步动作也不同**：
 *  · `at_limit`   —— 试到上限，驱动器自己放弃了 ⇒ 要人看"为什么推不动"；
 *  · `no_budget` —— 被花钱的门挡住 ⇒ 要人是【放开预算】而不是查 bug（0045）；
 *  · 其余        —— 下一心跳会被推，不进这一格。
 * 只发一档的话，第二档的读者会去查一个根本不存在的 bug —— 与 0041 §7 记的
 * 「报错教的那一步跑不起来」同一族：屏幕上那句话得指向【真的能做的下一步】。
 */
import type { DatabaseSync } from "node:sqlite";
import { assertParamCount, assertSingleStatement } from "../db/write-queue.js";
import { underTaskBudgetSql } from "../serve/charter-pump.js";
import {
  DRIVER_ELIGIBLE_STATES,
  DRIVER_GAVE_UP_KIND,
  driverCellMarkerSql,
  driverCellTargetSql,
} from "../serve/driver-pump.js";
import { kindOf } from "../heartbeat/patrol.js";

/**
 * 一台 Hub 的驱动器【此刻】的真实状态，由装配层【每请求现取】。
 * 这是【注入侧】的形状，字段是 camelCase —— 与 config.ts 的 ServeArgs
 * （driverPump / taskLimitCents / maxBudgetUsd）同一套命名，
 * 因为它的生产者就是那一层。对外（DriverStatus）是另一套，见下面那条说明。
 *
 * 三个字段都是【进程状态】而不是库里的数 —— 这正是它必须由装配层给的原因：
 * 库里没有任何一行写着"这台 Hub 开了 --driver-pump"（审计只有它【做过】的事，
 * 而一个关着的泵什么都不做）。
 */
export type DriverRuntimeState = {
  /** 启动时开了 --driver-pump 而三个上限形状有效吗（与真的派发用的是同一个值）。 */
  readonly enabled: boolean;
  /** 承载驱动器的那条心跳还在跑吗（连番失败之后为假，而 HTTP 照旧服务）。 */
  readonly pumping: boolean;
  /** 命令行那份「每条任务最多花多少美分」；关着时是 null（那时候没有这个数）。 */
  readonly taskLimitCents: number | null;
};

/** 一条「停在 agent 格而没在动」的任务，含它的成因。 */
export type DriverStoppedTask = {
  readonly task_id: string;
  readonly state: string;
  readonly role: string;
  readonly cause: "at_limit" | "no_budget";
  /** 到顶那一行写下的 attempts / max_attempts；钱那一档是 null（那一行不存在）。 */
  readonly attempts: number | null;
  readonly max_attempts: number | null;
  /** 到顶那一行的时刻；钱那一档用任务自己的 updated_at（没写过那一行）。 */
  readonly since_ms: number;
};

/**
 * 一台 Hub 的驱动器全景 —— 【对外】形状，字段一律 snake_case。
 *
 * ⚠ 为什么与上面那个注入侧的类型【命名不同】而不是合成一个：
 * 今日视图的对外口径明写着 snake_case（today.ts 文件头：「字段是 snake_case，
 * 沿用本仓对外视图的口径」，api.ts 的 taskViewSchema 那段同一条），
 * 而注入侧那一套跟着 ServeArgs 走 camelCase。
 * 一个类型两头用的话，必然有一头违反自己的口径 —— 而那种违反是【静默的】：
 * 界面拿 driver.taskLimitCents 与 driver.task_limit_cents 都能编译过吗？不能，
 * 但 JS 那一侧（app.js 没有类型）拿到 undefined 只会画成空，
 * 于是"这一维永远为空"读起来像"没有异常"。分成两个类型 + 一次显式转换，
 * 就是让那次口径转换发生在【一个看得见的地方】。
 */
export type DriverStatus = {
  readonly enabled: boolean;
  readonly pumping: boolean;
  readonly task_limit_cents: number | null;
  readonly stopped: readonly DriverStoppedTask[];
};

/**
 * 「这一格那一条放弃记录」的几个属性，各来一遍。
 *
 * ⚠ 别名【必须】每发不同（g2/g3/g4）而【不能】共用一个：它们相关到外层的 t，
 * 而同名别名在同一条 SQL 里出现三次，读的人（和 SQLite）都得靠位置去认哪一个是谁 ——
 * 这类"看着复用、其实各指一处"的写法是本仓抓过的那族（0041 §4 的共用 kind 同一形状）。
 * 别名不同还有一层用场：EXPLAIN QUERY PLAN 打出的每一行都写着它扫的是哪个别名，
 * 于是「某一发没配上索引」在计划里指得出名字（0003 文件头那条排查路径）。
 *
 * ⭐ 三发【必须取同一行】，而这一条是被自己抓出来的（不是我预先想到的）：
 * 第一版那两列 payload 写的是「子查询里不带 ORDER BY」—— 那意味着
 * SQLite 从满足条件的行里【随便给一行】。今天同一格里只有一行放弃记录，所以看不出来；
 * 而同一格合法地可以有多行（marker 之后驱动器重来一轮又到顶，见 driver-pump 的
 * 打回重访那一支），那时 `attempts` 可能来自第一行而 `gave_up_id` 是第二行 ——
 * 界面就会写着「第 3/3 次，17:02 停的」而那两个数来自【两次不同的放弃】。
 * 所以取 payload 的两发都带 `ORDER BY <别名>.id DESC LIMIT 1`，
 * 而取 id 那一发用 MAX(id)：两者【定义上】指同一行。
 * 下面 driver-status.test.ts 那条「同一格两行放弃记录」的用例就是钉这一件事的。
 */
function gaveUpSubquery(alias: string, payloadKey: string | null): string {
  const where =
    " WHERE " +
    alias +
    ".task_id = t.id AND " +
    kindOf(alias) +
    " = '" +
    DRIVER_GAVE_UP_KIND +
    "' AND " +
    alias +
    ".target = " +
    driverCellTargetSql("t") +
    " AND " +
    alias +
    ".id > " +
    driverCellMarkerSql("t");
  if (payloadKey === null) {
    return "(SELECT MAX(" + alias + ".id) FROM events " + alias + where + ")";
  }
  return (
    "(SELECT json_extract(CASE WHEN json_valid(" +
    alias +
    ".payload) THEN " +
    alias +
    ".payload END, '$." +
    payloadKey +
    "') FROM events " +
    alias +
    where +
    " ORDER BY " +
    alias +
    ".id DESC LIMIT 1)"
  );
}

/**
 * 一行一任务：停在 agent 格的任务 + 这一格有没有被放弃 + 有没有被钱挡住。
 *
 * ⚠ 为什么是【一条】查询而不是"先取任务再逐条问"：后者是 N+1，活跃任务数就是 N。
 * patrol 那条链记的正是这种形状（无索引时一趟 413 ms 冻住主线程，
 * 期间写队列 / HTTP / SSE 全停 —— 0003 那条迁移就是为了它加的）。
 * 实测这一发（量的是【产品代码真发的那条 SQL】，探针把 prepare 包了一层截下来的，
 * 不是探针里手抄的一份 —— 0049 §8 有复算命令与完整 EXPLAIN）：
 *   10 万事件 / 200 任务 / 40 条活跃 / 1 条放弃 ⇒ 中位 0.56 ms
 *   50 万事件 / 400 任务 / 120 条活跃 / 0 条放弃 ⇒ 中位 1.53 ms
 *   50 万事件 / 400 任务 / 120 条活跃 / 40 条放弃 ⇒ 中位 3.90 ms
 * 最后一条多出来的那部分就是下面那次回表（ABANDONED_AT_SQL）：约 0.06 ms 一条，
 * 而它的 N 是【已经放弃的任务数】—— 四十条想法同时停在半路，
 * 本来就已经是要人工看一眼的局面了，那 2 ms 不在要紧的地方。
 * 计划里四发相关子查询（g / g2 / g3 / g4，各自带一份 marker 子查询 m）
 * 全部走 SEARCH ... USING INDEX idx_events_task_kind_created，
 * 而别名不同让计划里每一行指得出是谁（0003 文件头那条排查路径兑现了）。
 *
 * ⚠ 早先我在注释里写过「1.25 ms」，那是【另一版 SQL】上量的数字
 * （那一版还带着一列没人读的 EXISTS），删掉那一列之后没回去重量就把旧数字留下了。
 * 一个"看起来已经量过"的过期数字比没有数字更坏 —— 它会让下一个人跳过本来该跑的复算。
 *
 * ⚠ 同一份库上"多带一列 EXISTS"的版本要 6.39 ms（那一列今天没有读者，
 * 所以没带 —— 每一列都要挣到自己那个读者的位置，见下面 `ever_claimed` 那条注释）。
 *
 * 判据逐条：
 *  ① `t.status IN (DRIVER_ELIGIBLE_STATES)` —— 与候选 SQL 同一个【派生】集合。
 *  ② 放弃那一发是「有没有」而不是"几条"：只问存在。`target = <这一格>` 用的是
 *     tasks 的【当前】两列 ⇒ 任务换格子之后旧放弃行【自动不再算数】，
 *     这正是打回/换人之后该把那句话撤下来的语义（不需要任何清理动作）。
 *  ③ `id > marker` —— 少了这一条，被打回后重新走回 IN_PROGRESS/dev 的任务会
 *     带着上一次那行放弃记录，在【刚刚被重新推】的时候写着「不再推了」。
 *     那比不显示更坏：0048 要消灭的是"看不见的沉默"，而这一发造出来的是
 *     【看得见的谎】。marker 与驱动器【同一个函数】（driverCellMarkerSql），
 *     不是"看起来一样的另一份写法"。
 *  ④ 钱那一发用驱动器自己的 underTaskBudgetSql 取反，绑驱动器自己那个数。
 *  ⑤ attempts / max_attempts 直接读【驱动器写下的那两个数】而不在这里重算 ——
 *     重算要拿配置，而 payload 里那两个数正是"当时生效的上限"，
 *     配置后来改了也不会让历史上那一行说谎。
 *
 * ⚠ 【没有】加「这一格有没有被认领过」那一列（我第一版写了）。两个理由：
 *  · 今天没有读者（界面上那句话只问"到顶了没有"）；
 *  · 实测它让这一发从 1.25 ms 涨到 6.39 ms。
 * 留着它的诱惑是"将来也许能区分'驱动器刚开而还没轮到'与'从没轮到过'"，
 * 而那个区分今天会用在哪儿我不知道 —— 为一句话都还没有的读者付 5 倍的主线程时间，
 * 是本仓抓过的那族【先建后用】的反面。
 */
const STOPPED_SQL =
  "SELECT t.id AS id, t.status AS status, t.assigned_role AS role, t.updated_at AS updated_at, " +
  "EXISTS (SELECT 1 FROM events g WHERE g.task_id = t.id AND " +
  kindOf("g") +
  " = '" +
  DRIVER_GAVE_UP_KIND +
  "' AND g.target = " +
  driverCellTargetSql("t") +
  " AND g.id > " +
  driverCellMarkerSql("t") +
  ") AS abandoned, " +
  gaveUpSubquery("g2", "attempts") + " AS attempts, " +
  gaveUpSubquery("g3", "max_attempts") + " AS max_attempts, " +
  gaveUpSubquery("g4", null) + " AS gave_up_id, " +
  "NOT (" +
  underTaskBudgetSql("t") +
  ") AS over_budget " +
  "FROM tasks t WHERE t.status IN (" +
  DRIVER_ELIGIBLE_STATES.map(() => "?").join(", ") +
  ") ORDER BY t.updated_at ASC, t.id ASC";

/**
 * 放弃那一行的时刻：先取那一行的 id，再回表取它的 created_at。
 *
 * ⚠ 不直接 `MAX(created_at)` —— 那与 `MAX(id)` 【不保证是同一行】。
 * 同一进程里 nowMs 单调，所以今天两者落在同一行；但 appendAudit 的 createdAt
 * 是【调用方给的】（驱动器的 o.nowMs），而进程里的时钟可以被改
 * （NTP 回调、手动改表、跨重启）。真漂了的时候，`MAX(created_at)` 会把
 * 「第几次到顶」与「什么时候」来自两行不同的记录拼成一句话，
 * 而那一句话在读的人眼里是同一件事的两个属性。多一次主键点查换掉这个缝。
 *
 * 代价是【每条 at_limit 任务一次点查】—— 这是本文件唯一的 N+1，
 * 而它的 N 是【已经放弃的任务数】（今天通常是 0 或 1），
 * 不是活跃任务数；这与 STOPPED_SQL 那一发"活跃任务不能逐条问"的分工是刻意的。
 */
const ABANDONED_AT_SQL = "SELECT created_at AS at FROM events WHERE id = ?";

type RawRow = {
  id: string;
  status: string;
  role: string;
  updated_at: number;
  abandoned: number;
  attempts: number | string | null;
  max_attempts: number | string | null;
  gave_up_id: number | null;
  over_budget: number | null;
};

/**
 * 这台 Hub 的驱动器全景。只读，走 deps.db（与今日视图同一条连接、同一条理由：
 * 一次超过 busy_timeout 的模型调用期间，CEO 打开看板照旧能看）。
 *
 * 关着 / 心跳停了 ⇒ 【一条都不查】直接返回空。不是因为查了会错（查了也对，恒空），
 * 而是「不查」让 enabled 为假这件事在代码里有一次真实分支，
 * 而不是只在一句注释里声称它被尊重 —— 这一族的教训是「注释承诺了实现没有的性质」。
 */
export function readDriverStatus(
  db: DatabaseSync,
  state: DriverRuntimeState,
): DriverStatus {
  if (!state.enabled || !state.pumping) {
    // ⚠ 这里是【逐字段写出】而不是 `{ ...state, stopped: [] }`。
    // 展开写法在两个类型同名那天是等价的，而它们【刻意不同名】（注入侧 camelCase、
    // 对外 snake_case），所以展开会【静默地】把 taskLimitCents 发出去而少了
    // task_limit_cents —— TS 会在编译期拦住它，但只要有一处绕过了类型
    // （app.js 就没有类型），那一格就在界面上永远是空的。
    // 显式映射让"改一侧命名"必须同时改另一侧，而那是编译期的一次红。
    return {
      enabled: state.enabled,
      pumping: state.pumping,
      task_limit_cents: state.taskLimitCents,
      stopped: [],
    };
  }
  // ⭐ 绑参顺序 = ? 在【SQL 文本里】出现的顺序，而这一发的顺序【反直觉】：
  // 那份花钱的分母在 SELECT 列表里（`NOT (underTaskBudgetSql) AS over_budget`），
  // 状态集合在 WHERE 里 —— 所以是【先上限、后状态】。
  // 我第一版按"读代码的顺序"写成了 [...states, taskLimitCents]，全绿了一整个下午：
  // assertParamCount 只数【个数】而这一发两边都是 6 个，它过得去；
  // 于是 node:sqlite 按位置把 'CHARTER_APPROVED' 当成预算上限去比
  // （SQLite 里"数字 < 文本"恒假 ⇒ 「被钱挡住」那一档【永远不报】），
  // 而 IN 列表少一格、多出一个 500 —— 第一格状态的任务【静默地从名单里消失】。
  // 是 driver-status.test.ts 那三条 C 组用例把它撞出来的（它们期望 no_budget 而实到 {}），
  // 不是这段注释想出来的。这正是 0044 记过的那条：绑错顺序【不报错】。
  // 顺手一句：驱动器自己那条 driverCandidatesSql 里上限的 ? 在 IN 【之后】
  // （WHERE 里从上到下），所以两条 SQL 的顺序【不一样】—— 抄形状的人注意。
  const params: unknown[] = [state.taskLimitCents, ...DRIVER_ELIGIBLE_STATES];
  assertParamCount(STOPPED_SQL, params);
  assertSingleStatement(STOPPED_SQL);
  const rows = db.prepare(STOPPED_SQL).all(...(params as never[])) as unknown as RawRow[];

  const stopped: DriverStoppedTask[] = [];
  for (const r of rows) {
    if (Number(r.abandoned) === 1) {
      const at = r.gave_up_id === null ? null : readAbandonedAt(db, Number(r.gave_up_id));
      stopped.push({
        task_id: r.id,
        state: r.status,
        role: r.role,
        cause: "at_limit",
        attempts: numOrNull(r.attempts),
        max_attempts: numOrNull(r.max_attempts),
        since_ms: at ?? Number(r.updated_at),
      });
      continue;
    }
    // ⚠ 这里判的是 `=== 1` 而不是"真值"，而这一格【必须】这么写：
    // taskLimitCents 为 null 时 SQL 里那个比较得到 NULL，NOT(NULL) 也是 NULL，
    // 于是这一列回来的是 null ⇒ Number(null) = 0 ⇒ 不说「被钱挡住」。
    // 那是【对的行为】而不是巧合：**分母不知道的时候不许下判断**。
    // 我第一版在这里绑的是 budgets.limit_cents（"看着同源"），
    // 那会把「命令行上限 ≠ 库里声明上限」那一天变成一句自信的错话。
    if (Number(r.over_budget) === 1) {
      stopped.push({
        task_id: r.id,
        state: r.status,
        role: r.role,
        cause: "no_budget",
        attempts: null,
        max_attempts: null,
        since_ms: Number(r.updated_at),
      });
    }
  }
  return {
    enabled: state.enabled,
    pumping: state.pumping,
    task_limit_cents: state.taskLimitCents,
    stopped,
  };
}

/**
 * json_extract 回来的是 SQL 值：整数那一格 node:sqlite 给 number，
 * 但 payload 里写成字符串（外部改过库）时给 string。
 * 这里【不】按字面量透传 —— 那一列在契约里是 number|null，
 * 而把 "3" 发出去会让界面上的 `attempts + "/" + max_attempts` 拼出 "33" 那种东西。
 *
 * 只判 null 而【不】判 undefined：RawRow 那一型里那两格就是 `number | string | null`，
 * 多写一个 `|| v === undefined` 会得到 tsc 的「两个型没有重叠」，
 * 而那句要是能过，它就是在给一个【类型上不存在】的情况兜底 —— 那种分支本仓不留。
 */
function numOrNull(v: number | string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function readAbandonedAt(db: DatabaseSync, id: number): number | null {
  const sql = ABANDONED_AT_SQL;
  assertParamCount(sql, [id]);
  const r = db.prepare(sql).get(id) as { at: number } | undefined;
  return r === undefined ? null : Number(r.at);
}
