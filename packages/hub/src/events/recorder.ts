/**
 * 审计写入器（Task 0.6，规格 §6.3）。
 *
 * 职责边界：recorder 只认「数据库事务」和「事件」，不认识 LangGraph。
 * 超步边界由 hub 侧的 Saver 适配器告知 —— 实测 Saver.put 严格先于该超步的节点执行，
 * 且并行超步只调一次 put（见 decisions/0005）。
 *
 * 为什么事件攒到提交后才 publish：§5.8 明确 events 表是事实源、事件流只是投影。
 * 若在写库时就广播，节点随后抛错导致事务回滚，前端就收到一条数据库里【不存在】的
 * 事件：界面显示「已完成」而库里没有，而且永远不会自我纠正。
 */

import type { DatabaseSync } from "node:sqlite";
import { assertParamCount, assertSingleStatement } from "../db/write-queue.js";
import type { DomainEvent, EventBus, EventKind } from "./bus.js";

/** §22.1 的 action 枚举，逐字照抄规格。 */
export const AUDIT_ACTIONS = [
  "state_change",
  "review_decision",
  "approval",
  "tool_call",
  "budget_consume",
  "meeting",
  "harness_call",
  "unauthorized_attempt",
  "dissent",
  "escalation",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** DomainEvent.kind 到 events.action 的固定映射（一 kind 一 action，不做多对多）。 */
export const KIND_TO_ACTION: Record<EventKind, AuditAction> = {
  TaskStateChanged: "state_change",
  ReviewDecided: "review_decision",
  ApprovalRequired: "approval",
  ApprovalDecided: "approval",
  BudgetPaused: "budget_consume",
  MeetingSummaryReady: "meeting",
  HeartbeatStalled: "escalation",
  // 第 8 个 kind（Task 4.1）。action 仍是 'approval' 而【不开第 11 个 action 值】：
  // §22.1 那个十值枚举与 events 表一样是 append-only 的口径，
  // 加一个值会让所有按 action 统计的报表当场少一批（同 auto-approve.ts 给自动批
  // 选 'approval' 时记的那条理由）。它在库里的身份靠 payload.kind，
  // 而 role-memory 那边已经有一道显式过滤认领这件事（它不是决定，不该进记忆）。
  ApprovalTokenRedeemed: "approval",
  // 第 9 个 kind（engine/ 调度器的「跑了一轮但没推进」）。同样【不开新的 action 值】，
  // 理由与上面那条一字不差；选 'tool_call' 是因为它是十个值里唯一语义为
  // 「agent 干了事而没做决定」的那个。role-memory 的 SQL 只捞 approval /
  // review_decision 两种 action，所以这一行天然不进记忆（那条 SQL 放宽时要回头看这里）。
  RoleTurnReported: "tool_call",
  // 第 10–18 个 kind（实施计划 §5 的 kind→action 表逐行照抄，那边是规范源）。
  // AUDIT_ACTIONS 仍是十个值：九个 kind 全部复用既有 action，不开第 11 个，
  // 理由与上面两条一字不差（§22.1 十值枚举 append-only）。
  // ⚠ 一处【刻意的分歧】要记下：执行器审计行在库里的 action 是 'tool_call'
  // （T6 的派发语义，executors/types.ts auditExecutorRun 写的就是它，不动它），
  // 而 ExecutorRunFinished 这条广播事件按 §5 表映射到 'harness_call'。
  // 两者不冲突的依据：auditExecutorRun 直接走 appendAudit、不经过这张表，
  // 库里已有的 executor_run 行保持 tool_call；这张表只在 recorder.record()
  // 拿 action 时被查到。若将来 T8–T11 里有人把 ExecutorRunFinished 也改成
  // 经 record() 落库，他会发现库里这一族行出现两种 action —— 那时要回头统一，
  // 统一方向是改表还是改 auditExecutorRun 由那时的人拍板，这里先把话说明白。
  GroupUpdated: "state_change", // §5：群档案的增删改是状态事实
  MemberHired: "state_change", // §5：新成员进表
  MemberUpdated: "state_change", // §5：档案字段变了
  MessageReceived: "meeting", // §5：会话/会议同族（一条消息 = 一次发言事件）
  MeetingTurnPosted: "meeting", // §5：会议逐字稿
  MeetingConcluded: "meeting", // §5：散会
  BacklogChanged: "state_change", // §5：面板行变了
  DocumentChanged: "state_change", // §5：文档变了
  DocumentAccessed: "state_change", // 文档读取是访问事实，不新增审计 action
  ExecutorRunFinished: "harness_call", // §5：执行器调用完成（见上面那条分歧说明）
  // 第 19 个 kind（会议取消）。§5 那张表没有它 —— 表只给了会议「发言/散会」两条，
  // 而 0017 的 status 是三值。它落 'meeting' 与另两条会议 kind 同一个 action：
  // 按 action 统计「这个群开过几场会」时，取消的那场【本来就该在分母里】
  // （开错头而取消的会也是开过），分辨哪一种靠 payload.kind，
  // 与 ApprovalTokenRedeemed 复用 'approval' 是同一立场。target 落 meetingId
  // 的理由与 MeetingTurnPosted/MeetingConcluded 一字不差：三线要能 join 到同一场会。
  MeetingCancelled: "meeting",
  // 第 20 个 kind（开会）。与上一条同一处补票、同一个 action，理由一字不差：
  // 按 action 数「开过几场会」时，开了又取消的那场同样该在分母里。
  MeetingOpened: "meeting",
  // T8 节奏与调研是团队状态事实，复用 state_change；payload.kind 区分具体动作。
  RhythmEventRecorded: "state_change",
  ResearchCardCreated: "state_change",
  DispatchAssigned: "state_change",
};

/** 单条 events 插入：8 列 8 个匿名问号，单语句无分号。 */
export const INSERT_EVENT_SQL =
  "INSERT INTO events (task_id, actor_type, actor_id, action, target, payload, " +
  "state_snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";

/**
 * 带重放键的那一条：与上面只差最后一列，前 8 列的【列序逐字相同】。
 *
 * 为什么不把 INSERT_EVENT_SQL 直接改成 9 列：那 8 列版本有 26 个生产调用方
 * （approvals/、engine/、heartbeat/、http/、org/、policy/、serve/…），全都不涉及重放，
 * 让它们每人多传一个字面 null 是【把新机制的税摊给所有人】；而 recorder.test.ts:233
 * 钉着它的占位符个数正是为了让「少绑参数写成 NULL」当场可见 —— 动它等于同时改判据。
 * 分成两条 SQL 的代价是列序有两份，所以两份都由 assertParamCount 各自自检，
 * 且下面的 eventParams 是两条共用的同一个参数来源（列序漂移会在参数拼装处就炸）。
 */
export const INSERT_EVENT_WITH_REPLAY_KEY_SQL =
  "INSERT INTO events (task_id, actor_type, actor_id, action, target, payload, " +
  "state_snapshot, created_at, replay_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";

/**
 * 重放预检查：这一行是否已经存在。三个条件正是 0010 那条部分唯一索引的三列，
 * 所以这条 SELECT 走的就是那个索引（同一个口径，不存在「索引改了预检查没改」）。
 */
export const REPLAY_KEY_EXISTS_SQL =
  "SELECT id FROM events WHERE action = ? AND target = ? AND replay_key = ? LIMIT 1";

export interface AuditRow {
  readonly taskId: string | null;
  readonly actorType: "agent" | "human" | "system";
  readonly actorId: string;
  readonly action: AuditAction;
  readonly target: string | null;
  readonly payload: unknown;
  readonly stateSnapshot?: unknown;
  readonly createdAt?: number;
  /**
   * 重放不变量：同一次「节点执行 / 中断」重复执行时【算得出同一个值】的东西。
   *
   * 有值 ⇒ 这一行可去重（重复写就吞掉）；不传 ⇒ 与从前完全一致地插一行。
   * 键本身从哪来不认识（recorder 不认识 LangGraph，见本文件头），由图侧算好交进来。
   * 判据在库那边：0010 的 (action, target, replay_key) 部分唯一索引。
   */
  readonly replayKey?: string;
}

/**
 * target 列的规范值：没给就落 SQL NULL。
 *
 * 单独成一个函数只为了一个理由：预检查与 INSERT 必须用【同一个】口径。
 * 各写一份 `row.target ?? null` 的话，将来谁改成 `?? ""`，预检查就会去查一个
 * 库里不存在的值 ⇒ 查不到 ⇒ 照常 INSERT ⇒ 唯一索引把整个超步事务打回
 * （不是「多一行」而是「这一超步全丢」）。
 */
const targetColumn = (row: AuditRow): string | null => row.target ?? null;

/**
 * 落成 events.payload / state_snapshot 的 JSON 文本。
 *
 * 三条规则、三种失效方向，都不是洁癖：
 *  - undefined/null 落成 "null"：列是 NOT NULL，而下游回放一律 JSON.parse(payload)。
 *    存 JS 的 null（即 SQL NULL）会让 JSON.parse(null) 得到 null 再 .xxx 崩掉。
 *  - 裸文本直接抛：JSON.parse("已完成") 抛错，整条回放视图崩。
 *    而 JSON.stringify("已完成") 会存成 "\"已完成\"" —— 双重编码同样是脏数据，
 *    回放拿到的是字符串而不是对象，`.ok` 静默 undefined。两种写法都不对，所以抛错
 *    逼调用方把语义显式写成对象（{"text":"已完成"}）。
 *  - 循环引用抛错：审计记录写不进去是事故，静默写个 "{}" 是伪证。
 */
export function serializePayload(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value === "string") {
    try {
      JSON.parse(value);
      return value; // 本身已是合法 JSON，原样存，不双重编码
    } catch {
      throw new Error(
        "payload 是裸文本字符串 [" +
          value.slice(0, 40) +
          "]，不是合法 JSON。请包成对象再记录（例如 { text: ... }）—— events.payload " +
          "与 state_snapshot 在回放视图里一律被 JSON.parse，塞非 JSON 文本会让整段回放失败。",
      );
    }
  }
  let out: string | undefined;
  try {
    out = JSON.stringify(value);
  } catch (e) {
    throw new Error(
      "payload 无法序列化成 JSON：" +
        (e instanceof Error ? e.message : String(e)) +
        "（审计记录宁可抛错，也不写一条打不开的伪证）",
    );
  }
  // JSON.stringify(Symbol()) / 函数 => undefined，同样落成 "null"，
  // 否则会把 JS 的字面量 "undefined" 写进 JSON 列（那不是合法 JSON）
  return out === undefined ? "null" : out;
}

/** 组装 8 个绑定参数，顺序必须与 INSERT_EVENT_SQL 的列序逐一对应。 */
export function eventParams(row: AuditRow, now: () => number): unknown[] {
  if (!(AUDIT_ACTIONS as readonly string[]).includes(row.action)) {
    throw new Error(
      "非法的审计 action [" +
        String(row.action) +
        "]。events 是 append-only 审计库（触发器挡住 UPDATE/DELETE），枚举值一旦写脏就永远" +
        "留在库里，回放与合规审查都会读到不存在的动作类型。合法值：" +
        AUDIT_ACTIONS.join(" | "),
    );
  }
  // 纯空白也算空：actor_id = "   " 会写出一行【看起来有值】的匿名事件，
  // 比空串更难发现 —— append-only 触发器挡住了事后清理，只能一直留在库里。
  if (
    row.actorId === undefined ||
    row.actorId === null ||
    row.actorId.trim() === ""
  ) {
    throw new Error("actor_id 不能为空：审计里「谁干的」缺了就无法问责");
  }
  return [
    row.taskId, // task_id
    row.actorType, // actor_type
    row.actorId, // actor_id
    row.action, // action
    targetColumn(row), // target
    serializePayload(row.payload), // payload
    row.stateSnapshot === undefined
      ? null
      : serializePayload(row.stateSnapshot),
    row.createdAt ?? now(), // created_at
  ];
}

/**
 * 在【当前事务】里插一行，返回 events.id（= 总线 seq）。
 *
 * 带 replayKey 且库里已有同键行时【不写第二行】，返回【已有那一行的 id】：
 * seq 的唯一真相是 events.id（bus.ts 文件头），而这一行确实已经存在，
 * 所以「这一条审计的 seq 是几」的诚实答案就是那个 id —— 返回 0 会和
 * 「尚无事件」的游标哨兵撞车（下面 id 校验那段记的就是这个坑）。
 * 也不重新广播：那一行提交时广播过一次（或由崩掉的那个进程广播过），
 * 再发一遍是给投影喂重复 seq。
 *
 * ⚠ 键相同而内容不同 ⇒ 第二行【写不进去】（0010 的唯一索引本就禁止）。
 * 这对节点审计是对的：重放的【输入】按构造与第一次相同（LangGraph 用同一份
 * checkpoint + 同一份 task input 重跑），所以「同键 ⇒ 同一条记录」成立。
 * 若哪天有人给一个【输入会变】的事件加 replayKey，他会看到内容静默停在第一次 ——
 * 那属于「键选错了」，判据在键的算法那边，不在这里。
 */
function appendAuditRow(
  db: DatabaseSync,
  row: AuditRow,
  now: () => number,
): { readonly seq: number; readonly deduplicated: boolean } {
  // 两条自检是 0.5 留下的现成工具，这里必须复用而不是另写一份：
  // 少绑参数在可空列上【不报错】，直接写 NULL —— 审计库最危险的失效方向。
  const sql =
    row.replayKey === undefined
      ? INSERT_EVENT_SQL
      : INSERT_EVENT_WITH_REPLAY_KEY_SQL;
  assertSingleStatement(sql);
  const params = eventParams(row, now);
  if (row.replayKey !== undefined) {
    params.push(row.replayKey);
    // 预检查走 SELECT 而不是「靠 INSERT 撞唯一索引再 catch」：撞索引虽然实测不烧
    // AUTOINCREMENT id（不留 seq 空洞，.workbuddy 实测），但把一件【每次恢复都会发生】
    // 的常态做成异常控制流，会让真正该冒泡的约束冲突变得需要分辨 —— 而分辨不出来时
    // 表现是「整超步回滚」而不是「少写一行」。预检查与索引不是冗余：预检查漏了，
    // 索引让它炸而不是静默多一行（0010 文件头同一条立场）。
    const hit = db
      .prepare(REPLAY_KEY_EXISTS_SQL)
      .get(row.action, targetColumn(row), row.replayKey) as
      | { id: number | bigint | null }
      | undefined;
    if (hit !== undefined) {
      const existing = Number(hit.id);
      if (!Number.isSafeInteger(existing) || existing <= 0) {
        // 撞见一行 id 取不出来的行：宁可不吞，也不要返回一个假的 seq
        //（吞掉 + 假 seq = 审计少了且游标错，两件事叠一起最难查）。
        throw new Error(
          "重放预检查命中了一行取不到 id 的 events（得到 " +
            String(hit.id) +
            "），replayKey=" +
            row.replayKey +
            "。无法回答「这条审计的 seq 是几」，宁可抛错。",
        );
      }
      return { seq: existing, deduplicated: true };
    }
  }
  assertParamCount(sql, params);
  const info = db.prepare(sql).run(...(params as never[]));
  const id = Number(info.lastInsertRowid);
  if (!Number.isSafeInteger(id) || id <= 0) {
    // 拿不到 id 就绝不能返回 0：0 是「尚无事件」的游标哨兵，返回 0 会让订阅者
    // 从 0 开始续订，把历史全部重放一遍。
    throw new Error(
      "插入 events 后取不到 lastInsertRowid（得到 " +
        String(info.lastInsertRowid) +
        "）。seq 直接采用 events.id，取不到就没有可信游标 —— 宁可抛错。",
    );
  }
  return { seq: id, deduplicated: false };
}

/**
 * 公开入口：签名与返回值与从前【逐字不变】（26 个生产调用方一个都不动）。
 * 去重那层的「有没有真写」由 record() 直接用 appendAuditRow 拿，不从这里的返回值里猜。
 */
export function appendAudit(
  db: DatabaseSync,
  row: AuditRow,
  now?: () => number,
): number {
  return appendAuditRow(db, row, now ?? Date.now).seq;
}

/** 由 hub 侧用 WriteQueue 实现：一次事务的生命周期 + ALS 作用域。 */
export interface StepTx {
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  /** 把 fn 放进当前事务的作用域里执行（决定 db() 能否取到连接）。 */
  scope<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * 当前是否有【活动事务】（BEGIN 已发出、尚未 COMMIT/ROLLBACK）。
   *
   * 与 db() 是两个不同谓词，不能合并 —— 这个坑开发时真实踩过：run() 的收尾
   * （commit + flush）跑在 scope() 之外，若 inTx() 拿「作用域里有没有连接」来回答，
   * 收尾时答案是 false，于是 COMMIT 被【静默跳过】：事件写进了 SQLite 却永远没提交、
   * 也没广播，而且全程不报错。活动性说的是数据库状态，作用域说的是代码位置。
   */
  inTx(): boolean;
  /**
   * 当前事务作用域里的写连接；不在作用域里必须抛错。
   *
   * 为什么不给一个「常驻连接」：recorder 与 checkpoint saver 必须落在【同一次事务】
   * 里（0003 §6 第 2 项、规格 §6.3）。常驻连接会让 recorder 在事务边界之外 autocommit，
   * 于是「节点失败 ⇒ 事件增量为 0」直接失效 —— 而且没人会报错。
   * 真实实现里这个方法就是 requireScopeDb()，与 saver 走同一条取用路径。
   */
  db(): DatabaseSync;
}

export interface RecorderOptions {
  tx: StepTx;
  bus: EventBus;
  now?: () => number;
  /** 投影广播失败的出口；默认 console.error。审计已落库，故不冒泡。 */
  onBroadcastError?: (e: unknown) => void;
  actor?: { actorType: "agent" | "human" | "system"; actorId: string };
}

/** 各 kind 的 target：挑该事件里最能指认「对什么做了什么」的字段。 */
function targetOf(e: DomainEvent): string | null {
  switch (e.kind) {
    case "TaskStateChanged":
      return e.from + "->" + e.to;
    case "ReviewDecided":
      return e.gate;
    case "ApprovalRequired":
      return e.interruptId;
    case "ApprovalDecided":
      // 与 ApprovalRequired 同一个 target（都是卡片 id）。这是【刻意的】：
      // 「这张卡片被要求批准」与「这张卡片被批掉了」必须能在 target 上 join 得起来。
      // 若这里改成 decision，两行事件就再也对不到同一张卡上了。
      return e.interruptId;
    case "ApprovalTokenRedeemed":
      // 同样落在卡片 id 上：于是「要求批准 → 烧票 → 做了决定」三行能在 target 上
      // 串成一条线，而这正是排查「远程点了没反应」时唯一能用的那条线。
      return e.interruptId;
    case "MeetingSummaryReady":
      return e.meetingId;
    case "HeartbeatStalled":
      return e.node;
    case "BudgetPaused":
      return null; // 没有更具体的对象，回落到 taskId
    case "RoleTurnReported":
      // 落回角色名而不是 taskId：target 这一列回答的是「对什么做了什么」，
      // 而这一行里比 taskId 更有信息量的正是【谁跑的这一轮】。taskId 在 task_id 列上，
      // 写进 target 等于把同一件事存两遍（与 HeartbeatStalled 落 node 同一取向）。
      return e.role;
    case "GroupUpdated":
      return e.groupId;
    case "MemberHired":
      return e.memberId;
    case "MemberUpdated":
      return e.memberId;
    case "MessageReceived":
      return e.messageId;
    case "MeetingOpened":
    case "MeetingTurnPosted":
    case "MeetingConcluded":
    case "MeetingCancelled":
      // 与 ApprovalRequired/ApprovalDecided 同一手：两条事件必须能在 target 上
      // join 起来（「这场会议说了什么」与「这场会议散了」按 meetingId 对到同一场）。
      // 会议一族现在五个 kind，全部落 meetingId，于是同一场会议的五类行一线串起。
      return e.meetingId;
    case "BacklogChanged":
      return e.backlogItemId;
    case "DocumentChanged":
    case "DocumentAccessed":
      return e.docId;
    case "RhythmEventRecorded":
      return e.eventId;
    case "ResearchCardCreated":
      return e.cardId;
    case "DispatchAssigned":
      return e.taskId;
    case "ExecutorRunFinished":
      // ⚠ 这里落【裸 executionId】而不是审计层那套 "executor:<id>:<seq>" ——
      // 同一次执行在 events 表里本就有两行、各答各的问题（bus.ts 那条注释写全了）：
      // auditExecutorRun 的 tool_call 行按尝试计数拼 target，回答「派发过哪一次尝试」；
      // 这行 harness_call 广播按执行会话落 target，回答「这一次跑完成没成」。
      // 两行两 action 两 target，互不覆盖，也都别拿去替对方作答；
      // auditExecutorRun 的拼装不动它。
      return e.executionId;
  }
}

const taskIdOf = (e: DomainEvent): string | null =>
  "taskId" in e ? e.taskId : null;

/**
 * 攒着待发的事件：提交成功才广播，回滚就整批丢掉（§5.8：events 表是事实源，
 * 事件流只是投影）。
 */
type Pending = { readonly event: DomainEvent; readonly seq: number };

const DEFAULT_ACTOR = { actorType: "system", actorId: "hub" } as const;

export class AuditRecorder {
  readonly #tx: StepTx;
  readonly #bus: EventBus;
  readonly #actor: { actorType: "agent" | "human" | "system"; actorId: string };
  readonly #now: () => number;
  readonly #onBroadcastError: (e: unknown) => void;
  readonly #pending: Pending[] = [];
  /** 当前事务里本 recorder 写了几行；用于跳过「空事务」的提交往返。 */
  #writtenInTx = 0;
  /** run 的重入计数。 */
  #depth = 0;

  constructor(o: RecorderOptions) {
    this.#tx = o.tx;
    this.#bus = o.bus;
    this.#actor = o.actor ?? DEFAULT_ACTOR;
    this.#now = o.now ?? Date.now;
    // 默认必须【可见】而不是静默：投影失败是可用性事故（前端看不到进度），
    // 但它不该让审计写入失败 —— 事实源已经落库了。
    this.#onBroadcastError =
      o.onBroadcastError ??
      ((e) => {
        console.error(
          "[events] 投影广播失败（events 表已落库，不影响审计）:",
          e,
        );
      });
  }

  /**
   * 超步边界：提交上一超步、开新事务。由 Saver.put 调用
   * （实测 put 严格早于该超步的节点执行，且并行超步只调一次 —— decisions/0005）。
   *
   * 为什么按超步而不是按整次 invoke（0003 §3.2）：invoke 级事务里 ApprovalRequired
   * 的等待、LLM 调用都在事务内，DB 级写锁一握就是几十分钟（busy_timeout 只有 5000ms），
   * 而且崩溃时整个 invoke 的进度一起消失，V11 会重放。
   *
   * 「空事务直接复用」的分支只服务第一次 put：run 已 begin，第一个 put 进来时事务里
   * 还没有 recorder 的写入，此时 commit+begin 是纯开销；不 commit 反而正确 ——
   * 第一个超步的 checkpoint 与该超步的事件必须同事务。
   */
  async onStepStart(): Promise<void> {
    if (this.#tx.inTx()) {
      if (this.#writtenInTx === 0 && this.#pending.length === 0) return;
      await this.#tx.commit();
      this.#flush();
      this.#writtenInTx = 0;
    }
    await this.#tx.begin();
  }

  /** 节点内调用：写进当前事务，提交后才广播。返回 events.id（= seq）。 */
  async record(e: DomainEvent, extra?: Partial<AuditRow>): Promise<number> {
    if (!this.#tx.inTx()) {
      throw new Error(
        "record() 必须在超步事务的作用域内调用。事务外写 events 会 autocommit：" +
          "节点随后失败时那一行【留得下来】，「该节点 events 增量为 0」当场失效，" +
          "而审计回放看不出任何异常（那一行完全合法）。超步事务由 onStepStart() 开启。",
      );
    }
    const row: AuditRow = {
      taskId: extra?.taskId ?? taskIdOf(e),
      actorType: extra?.actorType ?? this.#actor.actorType,
      actorId: extra?.actorId ?? this.#actor.actorId,
      action: extra?.action ?? KIND_TO_ACTION[e.kind],
      target: extra?.target ?? targetOf(e) ?? taskIdOf(e),
      // payload 存整个事件（含 kind）：回放要能还原「当时发生了什么」，
      // 只存字段值会把「是哪一类事件」这个信息丢掉。
      payload: extra?.payload ?? { ...e },
      ...(extra?.stateSnapshot === undefined
        ? {}
        : { stateSnapshot: extra.stateSnapshot }),
      ...(extra?.replayKey === undefined ? {} : { replayKey: extra.replayKey }),
      ...(extra?.createdAt === undefined ? {} : { createdAt: extra.createdAt }),
    };
    // 第二道守卫：事务是活动的，但没有作用域（run() 收尾阶段、或在 scope() 之外
    // 调用）。此时 db() 会抛，底层消息讲的是 tx-scope/saver 该怎么用，对 record 的
    // 调用方是误导 —— 这里用自己的语境重新解释，同时把底层原因带上，不丢信息。
    let db: DatabaseSync;
    try {
      db = this.#tx.db();
    } catch (e) {
      throw new Error(
        "record() 丢失了事务作用域：有活动事务但不在 scope() 之内。" +
          "事务由 run()/onStepStart() 开启、由 scope() 暴露连接。底层原因：" +
          (e instanceof Error ? e.message : String(e)),
      );
    }
    const { seq, deduplicated } = appendAuditRow(db, row, this.#now);
    if (deduplicated) {
      // 这一行库里已经有了：不 ++writtenInTx（本超步确实【没写】任何新行，
      // 那个计数是「空事务可以跳过 commit 往返」的依据，虚增它会让空事务白提交一次），
      // 也不 push pending（那一行提交时已广播过，重发等于给投影喂重复 seq）。
      return seq;
    }
    this.#writtenInTx += 1;
    this.#pending.push({ event: e, seq });
    return seq;
  }

  /**
   * 外层是否已有【活动超步事务】。给 auditedInvoke 判断「该不该自己开事务」用。
   *
   * 为什么必须暴露：真实图执行同时需要两件事 —— saver 要 SuperStepAuditor.invoke
   * （= recorder.run）建的事务作用域，中断审计要 auditedInvoke 写 ApprovalRequired。
   * 若 auditedInvoke 无脑再 run 一次就撞嵌套守卫（0005 §11 缺陷 C）。不暴露这个谓词，
   * 调用方只能靠【猜】外层开没开事务 —— 猜错就是运行时抛错。
   *
   * 注意它回答的是【数据库状态】（BEGIN 已发出且未 COMMIT/ROLLBACK），不是【代码位置】，
   * 与 #tx.inTx() 同一谓词（§4：这两个谓词不能合并）。
   */
  inStepTx(): boolean {
    return this.#tx.inTx();
  }
  /** 包住一次图执行：负责首尾事务与异常回滚。 */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#depth > 0) {
      throw new Error(
        "AuditRecorder.run 嵌套：一次图执行只能有一个事务责任方。嵌套意味着「谁负责 " +
          "COMMIT」变成两个答案 —— 内层提交会把外层还没写完的超步提前发布出去。",
      );
    }
    this.#depth += 1;
    try {
      await this.#tx.begin();
      const out = await this.#tx.scope(fn);
      await this.#commitCurrentStep();
      return out;
    } catch (e) {
      // 当前超步整批丢掉：checkpoint 与 events 一起消失（实测 F 证实：LangGraph 侧
      // 的 checkpoint 同样回滚，恢复时从上一个已提交超步重跑）
      await this.#tx.rollback();
      this.#pending.length = 0;
      this.#writtenInTx = 0;
      throw e;
    } finally {
      this.#depth -= 1;
    }
  }

  async #commitCurrentStep(): Promise<void> {
    if (!this.#tx.inTx()) return;
    await this.#tx.commit();
    this.#flush();
    this.#writtenInTx = 0;
  }

  /** 只在【已提交】之后调用：seq 必须已经是一个真实存在的 events.id。 */
  #flush(): void {
    const batch = this.#pending.splice(0, this.#pending.length);
    for (const item of batch) {
      try {
        this.#bus.publishPersisted(item.event, item.seq);
      } catch (e) {
        // 单条失败不连坐其余订阅者，也不冒泡：事实源已提交，投影尽力而为
        this.#onBroadcastError(e);
      }
    }
  }
}
