/**
 * 心跳巡检（Task 6.1 的「停滞检测」那一半，规格 §7.3）。
 *
 * ── 本模块只回答一个问题：哪些任务【悄悄停了】────────────────────────
 * 「悄悄」是有定义的：任务还在干活的状态里、超过阈值没有任何真实事件、
 * 也没有人在等它（审批卡片没挂着）、而且【这一轮停滞还没被记过】。
 * 计划 Task 6.1 的验收原文就是这一条：「不允许出现既无事件也无卡片的状态」，
 * 并指定用「遍历所有任务，检查是否有孤儿活跃任务」的巡检测试守。
 *
 * ── 三条不做什么，每条都有出处 ────────────────────────────────────
 * 1. 【不改 tasks.status】。规格 §7.1 里 BLOCKED 只有【一条】入边（IN_REVIEW→BLOCKED），
 *    所以「检测到停滞就把状态改成 BLOCKED」对 IN_PROGRESS 上的任务是【非法跃迁】，
 *    而跃迁一旦写进 append-only 的 events 就永远在那儿（graph/status.ts 文件头同一条理由）。
 *    停滞是「需要人看一眼」，不是「状态变了」。
 * 2. 【不往 approvals 插卡片行】。规格 §7.3 要的是【信息性】异常卡片，而 approvals.approval_type
 *    的五个取值（charter / strategic / irreversible_action / budget_override / meeting_escalation）
 *    没有一个表达「信息性」；那张表装的是【能被 POST /approvals/:id 回答的】决策卡，
 *    而它的 id 来自 LangGraph 的 interrupt。异常卡没有 interrupt，回答它没有语义。
 *    计划 §6 那张四卡片表（MeetingSummaryReady / ApprovalRequired / BudgetPaused /
 *    HeartbeatStalled）说的是卡片由【事件】投影出来 —— 所以写事件就够了，
 *    多插一行 approvals 反而会造出一张【永远批不掉】的卡。
 * 3. 【不是独立调度器，也不驱动图】。规格 §7.3 最后一条明确「心跳逻辑绑定在 LangGraph
 *    节点状态上……而非独立外部调度器」。恢复（把任务推回图里跑）需要真图执行，
 *    那一半要 @langchain/*（本机装不上，0009 §2）。这里交的是【检测 + 记账】：
 *    它不 import graph/、不 import checkpoint/，因此能离线整条测完。
 *
 * ── 停滞时钟【不计】心跳事件本身，而【去重】看它 ────────────────────
 * 两个方向都必须对，否则会写出那种「第一天好用、第三天开始说谎」的代码：
 *  - 若把 HeartbeatStalled 算进「最后动作」：报给 CEO 的停滞时长每巡检一次就归零，
 *    一张停滞三天的卡片会永远显示「已停滞 15 分钟」。
 *  - 若完全不记它：每一轮都把同一个任务再报一次，收件箱被同一个任务刷屏。
 * 所以：时钟只认真实事件；而「本轮停滞是否已经报过」= 最后一次心跳事件
 * 【晚于或等于】最后一次真实事件。这两条各有一条测试钉住。
 */

import type { DatabaseSync } from "node:sqlite";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import { appendAudit } from "../events/recorder.js";
import type { EventBus, DomainEvent } from "../events/bus.js";
import type { Writer } from "../db/write-queue.js";
import { TASK_STATES, type TaskState } from "../graph/status.js";

/**
 * 规格 §7.3 默认心跳间隔 15 分钟。停滞阈值取【两个间隔】而不是一个：
 * 一个间隔意味着「调度抖一下 + 一个慢 LLM 调用」就能让 CEO 收到一张异常卡，
 * 而那种卡片多了以后会被整体忽略 —— 告警疲劳把检测的价值清零。
 */
export const HEARTBEAT_INTERVAL_MS = 15 * 60_000;
export const DEFAULT_STALL_THRESHOLD_MS = 2 * HEARTBEAT_INTERVAL_MS;

/**
 * 终态：不再期待任何推进，因此不参与停滞判定。
 *
 * DELIVERED 也算终态，这一条需要给理由：§7.1 里它只有 DELIVERED→ARCHIVED 一条出边，
 * 而 ARCHIVED 是「归档」不是「工作」。把 DELIVERED 当活跃任务，结果是每一个交付完
 * 而没归档的任务在两天后都长出一张异常卡 —— 那会让巡检的头一周就把收件箱淹掉，
 * 而它想报的东西一件也没报出来。
 */
export const TERMINAL_STATES: readonly TaskState[] = Object.freeze([
  "DELIVERED",
  "ARCHIVED",
]);

/**
 * 「在等人」也算被看着，不算孤儿。
 *
 * ESCALATED_TO_CEO / BUDGET_PAUSED / MEETING_REQUIRED 三个状态按 §7.1 的结构就是
 * 「球在人那边」：ESCALATED_TO_CEO 只有一条出边且由 CEO 触发，BUDGET_PAUSED 的出口
 * 是 CEO 那三个按钮（§7.4），MEETING_REQUIRED 在规格里连出路都没给。
 * 把它们判成停滞 = 催 CEO 去处理他【已经在看】的东西。
 * 注意这跟「有没有 pending 卡片行」是两件事：状态说「该谁动」，卡片说「有没有问出问题」。
 */
export const HUMAN_HOLD_STATES: readonly TaskState[] = Object.freeze([
  "ESCALATED_TO_CEO",
  "BUDGET_PAUSED",
  "MEETING_REQUIRED",
]);

export const PATROL_VERDICTS = [
  "terminal",
  "human_hold",
  "never_started",
  "recent",
  "already_flagged",
  "stalled",
] as const;
export type PatrolVerdict = (typeof PATROL_VERDICTS)[number];

export type TaskSignals = {
  readonly id: string;
  readonly status: string;
  readonly currentNode: string;
  readonly createdAtMs: number;
  /** 最后一次【非心跳】事件的时刻。null = 这任务一条事件都没有过。 */
  readonly lastRealEventAtMs: number | null;
  /** 最后一次 HeartbeatStalled 的时刻。null = 从没报过。 */
  readonly lastStallAtMs: number | null;
  /** 有挂着未决的审批卡片（由事件配对得出，见 pendingApprovalSql）。 */
  readonly awaitingApproval: boolean;
};

export type TaskJudgement = TaskSignals & {
  readonly verdict: PatrolVerdict;
  /** 停滞多久（毫秒）。没有真实事件时以 created_at 起算 —— 见 verdict 里那条 null 陷阱。 */
  readonly silentForMs: number;
};

export type PatrolOptions = {
  readonly now?: () => number;
  readonly thresholdMs?: number;
};

/**
 * 「这一行的 kind」的【唯一】SQL 写法。四处引用都从这里取，不在各处手抄。
 *
 * 为什么不是直接的 json_extract(a.payload, '$.kind')：
 * json_extract 对畸形 payload 是【抛错】而不是返回 NULL —— 这条本仓量过两次
 * （0014 §2；policy/auto-approve.ts 的 MALFORMED_PAYLOAD_PROBE_SQL 注释）。
 * 实测形状：库里有一行 payload = '坏掉的不是JSON'，PATROL_SQL 直接抛
 * "malformed JSON" ⇒ 【整轮巡检一行结果都没有】。
 *
 * 而那种行今天【写得进去】：events.payload 只有 NOT NULL，没有 json_valid 检查，
 * 直写 appendAudit 之外任何一条旁路 INSERT（人工修数据、迁移脚本、
 * 未来的导入工具）都能留下它。于是原写法的效果是：
 * 一行毫不相干的脏数据，让【所有】任务的停滞检测永久失效 ——
 * 而这正是本模块存在的全部理由（消灭静默）的反面。
 * 报错里既没有那行的 id 也没有 task_id，症状指向「巡检坏了」而不是「有一行脏数据」，
 * 与 auto-approve.ts 那条「把数据事故伪装成功能故障」同族。
 *
 * 守卫取值是 CASE WHEN json_valid(...) THEN ... END ⇒ 坏行得 NULL，
 * 而 NULL 在这一支里的语义【正是】下面 PATROL_SQL 那段说的「脏行不算真实事件」。
 * 所以这不是新增语义，是让既有语义在遇到坏行时不再以抛错的形式实现。
 * 反向对照在 patrol.test.ts ⑤：删掉守卫，那条用例必红。
 *
 * 导出是为了让测试能把【这一段】与 0003 那份 DDL 里的表达式逐字比一遍 ——
 * 表达式索引匹配的是字面写法，两侧漂移的后果是索引静默失效（不报错、不变红）。
 * 不导出的话那条用例只能重写一份表达式，而重写的那份就是第二份抄本（0006 §7 那族问题）。
 */
export function kindOf(alias: string): string {
  return (
    "(CASE WHEN json_valid(" +
    alias +
    ".payload) THEN json_extract(" +
    alias +
    ".payload, '$.kind') END)"
  );
}

/**
 * 一次扫描取回全部判定所需信号。
 *
 * 三个子查询都在 events 上，而 0003 那条 idx_events_task_kind_created 正好覆盖 ——
 * 巡检是【每 15 分钟对全表 tasks 跑一次】的东西，写成 N+1 就是
 * 「任务数 × 3 次查询」，规格 §6.5 的量级是十万任务。这一条必须一条 SQL 出。
 *
 * ⚠ 但「一条 SQL」只解决了往返次数，没解决【每行一次 json 解析】。
 * kind 在 payload 这个 TEXT 列里，0001 那两条索引都覆盖不到它，于是这条 SQL
 * 在 10 万事件的库上实测要 413 ms —— 而它跑在 Hub 主线程上，node:sqlite 是同步 API，
 * 那期间【写队列、HTTP、SSE 全停】。补的索引在 0003_patrol_event_index.sql；
 * 那条索引要求 SQL 里的 kind 表达式与 DDL 【逐字一致】，这就是 kindOf 存在的理由。
 *
 * ⚠ 载荷里【没有 kind】的脏行：json_extract 出 NULL，
 * 而 SQL 里 `NULL <> 'x'` 是 NULL 而不是 true ⇒ 那种行【不】算真实事件。
 * 「显式写 IS NOT NULL」与「靠 <> 的三值逻辑」在这一支上【结果相同】（实测），
 * 加它不是为了改行为，是为了让「脏行被剔除」这件事在 SQL 里【看得见】——
 * 三值逻辑省下来的是一次误读。真正会变行为的是反方向那支：
 * 换成 COALESCE(json_extract(...),'') 会把脏行算成【活动】，于是这类任务【永远不被报】。
 * 本模块存在的全部理由就是消灭「静默」，所以宁可多一张可撤销的卡片，
 * 也不要一个永远一声不吭的巡检。改之前先去看 patrol.test.ts ② 那条同名用例。
 *
 * 另一类脏行——payload 【不是合法 JSON】——由上面的 kindOf 兜住，走的是同一套语义
 * （得 NULL ⇒ 不算真实事件），但如果没有那层守卫，它实现的方式是【整轮巡检抛错】。
 */
export const PATROL_SQL =
  "SELECT t.id AS id, t.status AS status, t.current_node AS current_node, " +
  "  t.created_at AS created_at, " +
  "  (SELECT max(e.created_at) FROM events e WHERE e.task_id = t.id " +
  "     AND " + kindOf("e") + " IS NOT NULL " +
  "     AND " + kindOf("e") + " <> 'HeartbeatStalled') AS last_real_event_at, " +
  "  (SELECT max(e.created_at) FROM events e WHERE e.task_id = t.id " +
  "     AND " + kindOf("e") + " = 'HeartbeatStalled') AS last_stall_at, " +
  "  EXISTS (" +
  "    SELECT 1 FROM events r WHERE r.task_id = t.id " +
  "      AND " + kindOf("r") + " = 'ApprovalRequired' " +
  "      AND NOT EXISTS (SELECT 1 FROM events d WHERE d.task_id = r.task_id " +
  "        AND d.target = r.target " +
  "        AND " + kindOf("d") + " = 'ApprovalDecided')" +
  "  ) AS awaiting_approval " +
  "FROM tasks t ORDER BY t.created_at";

/**
 * 单个任务的判定。纯函数：数字进、结论出，不碰数据库也不碰时钟。
 *
 * 判定顺序是【有意义】的：terminal / human_hold / 挂卡 三格都在算时长之前先出，
 * 因为它们的共同语义是「已经有东西在被看着」—— 巡检要抓的是【没人看的那种】。
 *
 * 「挂着未决审批卡片」永久免检，这一条需要一个理由而不是想当然：
 *  §7.3 列的三种追问成因里确实有「审阅者未响应」，看着像该由心跳催。
 *  但催它【不是心跳的职责】—— approvals 表自带 timeout_at / timeout_behavior
 *  两列（0001_init.sql），那才是「卡片挂了多久、超时之后怎么办」的机制。
 *  心跳与它是两条不同通道：心跳管「悄悄停了」，超时管「问出去没人答」。
 *  把免检做成【阈值内】免检（超过阈值就报）看着更严，实际是拿 30 分钟的
 *  节奏去催一个人类审批 —— CEO 吃个午饭回来收件箱就多一张「你批得太慢」的卡，
 *  而这种卡片出现三次以后，巡检真正想报的东西就没人看了。
 *  代价照记：一张被【忘掉】的卡片不会由本模块报出来。今天这个代价还是零，
 *  因为 approvals 表在生产里【一次 INSERT 都没有】（0013 §10.1 实测），
 *  而 timeout_at 那两列同样没有任何读方 —— 也就是说两条通道都还没接通，
 *  「忘掉的卡片」这件事目前根本发生不了。接线那天要重看这一格。
 *  ── 「接线那天」到了，这一格当场重看过（0026 §4，原文留着）────────────
 *  两条里【只有一条变了】：
 *   · 「timeout_at 没有任何读方」—— 不再成立。GET /approvals 把它读出去展示
 *     （approvals/query.ts 的 APPROVAL_COLUMNS），前端能算「还剩多久过期」。
 *   · 「生产里一次 INSERT 都没有」—— 仍然成立，而且这是【刻意维持】的：
 *     创建路径 approvals/cards.ts 建好了，而 src 里【零调用方】
 *     （phase3.test.ts 与 auto-approve.test.ts 各有一发断言钉着这两半，
 *      把它们合成一句「已经接上了」会让这两发红不掉）。
 *  ⚠ 而【展示】不等于【执行】：到期之后仍然什么都不发生，
 *    这条缺席被 cards.test.ts ⑤ 钉成了一条【会过期】的性质（跑完巡检、推过 100 小时，
 *    卡片还是 pending）。所以本模块的免检结论【不变】：
 *    「有读方」改变的是能不能看见它老了，不是谁去催它。
 */
export function judgeTask(
  s: TaskSignals,
  nowMs: number,
  thresholdMs: number = DEFAULT_STALL_THRESHOLD_MS,
): TaskJudgement {
  const silentFrom = s.lastRealEventAtMs ?? s.createdAtMs;
  const silentForMs = Math.max(0, nowMs - silentFrom);
  const base = { ...s, silentForMs };

  if ((TERMINAL_STATES as readonly string[]).includes(s.status)) {
    return { ...base, verdict: "terminal" };
  }
  if ((HUMAN_HOLD_STATES as readonly string[]).includes(s.status)) {
    return { ...base, verdict: "human_hold" };
  }
  // 挂在未决审批卡片上：球在人那边，见上面那段理由（超时催办是 timeout_at 的活）。
  // 位置必须在时长判定【之前】—— 放在后面，这条只有「沉默未过阈值」时才生效，
  // 而那种情形本来就会被判 recent/never_started：整条分支【永不生效】。
  // 本轮写完第一版就是这个位置，是 patrol.test.ts ① 那条反向对照抓出来的。
  if (s.awaitingApproval) {
    return { ...base, verdict: "human_hold" };
  }
  // 一条事件都没有过：拿 created_at 起算。把 null 当 0 会让【每一个新建任务】
  // 在第一次巡检时被报成停滞（1970 年起的沉默），而新建任务正是最不该吵的那类。
  if (s.lastRealEventAtMs === null) {
    if (silentForMs <= thresholdMs) return { ...base, verdict: "never_started" };
  } else if (silentForMs <= thresholdMs) {
    return { ...base, verdict: "recent" };
  }
  // 「这一轮已经报过了」= 最后一次心跳事件【不早于】停滞起点。
  // 基准必须是 silentFrom（无真实事件时是 created_at），不是 lastRealEventAtMs ——
  // 拿后者做基准，一个【从没跑过、只被报过一次】的任务就永远匹配不上去重条件，
  // 于是每轮巡检都为它写一条新事件，收件箱被同一个任务刷屏。
  // 用 >= 而不是 >：同一次巡检里两条时间戳可能相等（同一毫秒写入）。
  if (s.lastStallAtMs !== null && s.lastStallAtMs >= silentFrom) {
    return { ...base, verdict: "already_flagged" };
  }
  return { ...base, verdict: "stalled" };
}

/** 读连接的最小形状。巡检只读，物理上就该拿不到写能力。 */
export type PatrolDb = Pick<DatabaseSync, "prepare">;

/** 全表巡检：每个任务一条判定，含【没停滞】的那些。 */
export function patrolTasks(
  db: PatrolDb,
  o: PatrolOptions = {},
): readonly TaskJudgement[] {
  const now = o.now ?? Date.now;
  const rows = db.prepare(PATROL_SQL).all() as Array<Record<string, unknown>>;
  return rows.map((r) =>
    judgeTask(
      {
        id: String(r["id"] ?? ""),
        status: String(r["status"] ?? ""),
        currentNode: String(r["current_node"] ?? ""),
        createdAtMs: num(r["created_at"]),
        lastRealEventAtMs: r["last_real_event_at"] == null ? null : num(r["last_real_event_at"]),
        lastStallAtMs: r["last_stall_at"] == null ? null : num(r["last_stall_at"]),
        awaitingApproval: num(r["awaiting_approval"]) === 1,
      },
      now(),
      o.thresholdMs ?? DEFAULT_STALL_THRESHOLD_MS,
    ),
  );
}

function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : Number(v ?? 0);
}

/** 只有这一种结论需要动手。 */
export function stalledTasks(
  js: readonly TaskJudgement[],
): readonly TaskJudgement[] {
  return js.filter((j) => j.verdict === "stalled");
}

/** 事件载荷里写清的三件事：停滞多久、球在哪个节点、这是第几轮巡检报的。 */
export const STALL_ACTOR = { actorType: "system", actorId: "heartbeat" } as const;

export function stallEvent(j: TaskJudgement): DomainEvent {
  return {
    kind: "HeartbeatStalled",
    taskId: j.id,
    node: j.currentNode,
  };
}

export type RecordResult = {
  readonly taskId: string;
  /** events.id；null = 这一条没写进去（原因在 error）。 */
  readonly seq: number | null;
  readonly error?: string;
};

/**
 * 把停滞记成事件，并向总线广播（卡片由此投影）。
 *
 * 【为什么用 appendAudit + writer.node 而不是 AuditRecorder.record】：
 * record() 要求在超步事务作用域内（recorder.ts 里那条守卫会抛），而那个事务由
 * LangGraph 的 Saver.put 开启。巡检不住在图里，它没有超步 —— 硬凑一个 recorder
 * 就是把「停滞检测」重新绑回图执行，也就违反 §7.3 那句「而非独立外部调度器」。
 * http/real-deps.ts 走的是同一条路（它也不是图），这里跟随它而不是另发明第三种。
 *
 * 【一条都不许静默】：写失败必须把错误带回来，而且要带 taskId。
 * 「记不下来」与「不需要记」在返回值上必须分得开 —— 计划 Task 6.1 要防的
 * 「既无事件也无卡片」，如果连「事件写失败」都被吞掉，那这一条守的就是空气。
 */
export async function recordStalls(
  writer: Writer,
  bus: EventBus,
  js: readonly TaskJudgement[],
  now?: () => number,
): Promise<readonly RecordResult[]> {
  const clock = now ?? Date.now;
  const out: RecordResult[] = [];
  for (const j of js) {
    const event = stallEvent(j);
    try {
      const seq = await writer.node(() =>
        appendAudit(
          requireScopeDb("心跳巡检"),
          {
            ...STALL_ACTOR,
            taskId: j.id,
            // target 用节点名：recorder.targetOf 对 HeartbeatStalled 就是这么定的，
            // 走 appendAudit 时必须自己对齐，否则直写路径与 recorder 路径会写出两种 target。
            target: j.currentNode,
            action: "escalation",
            payload: {
              ...event,
              silentForMs: j.silentForMs,
              lastRealEventAtMs: j.lastRealEventAtMs,
              verdict: j.verdict,
            },
            createdAt: clock(),
          },
          clock,
        ),
      );
      bus.publishPersisted(event, seq);
      out.push({ taskId: j.id, seq });
    } catch (e) {
      out.push({
        taskId: j.id,
        seq: null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return out;
}

export type PatrolRunResult = {
  readonly judgements: readonly TaskJudgement[];
  readonly stalled: number;
  readonly recorded: readonly RecordResult[];
};

/**
 * 一轮完整巡检：读判定 → 记停滞 → 广播。
 *
 * ⚠ 这里【故意】不 setInterval。调度（什么时候醒）属于常驻进程，
 * 而那件事的第一行代码要 openDb + 图运行时（Task 6.1 被堵的那一半）。
 * 把一个 setInterval 塞进本模块，等于让「导入这个模块」这件事自带一个定时器：
 * 测试进程会因为一个没人关的 timer 挂着不走，而这是最容易被「加个 --exit」
 * 糊过去的那类洞。tick 由调用方驱动，本模块保持「叫一次动一次」。
 */
export async function runPatrol(
  db: PatrolDb,
  writer: Writer,
  bus: EventBus,
  o: PatrolOptions = {},
): Promise<PatrolRunResult> {
  const judgements = patrolTasks(db, o);
  const stalled = stalledTasks(judgements);
  const recorded = await recordStalls(writer, bus, stalled, o.now);
  return { judgements, stalled: stalled.length, recorded };
}

/**
 * 自检用：状态枚举里既不是终态也不是「人被卡住」的那些，就是巡检会盯的活跃状态。
 * 从 TASK_STATES 派生而不是手写一份清单 —— 手写的那份会在加状态时静默漏掉新状态，
 * 而漏掉的状态永远是绿的（graph/status.ts 文件头同一条理由）。
 */
export const WATCHED_STATES: readonly TaskState[] = Object.freeze(
  TASK_STATES.filter(
    (s) =>
      !(TERMINAL_STATES as readonly string[]).includes(s) &&
      !(HUMAN_HOLD_STATES as readonly string[]).includes(s),
  ),
);
