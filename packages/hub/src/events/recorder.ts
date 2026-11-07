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
  BudgetPaused: "budget_consume",
  MeetingSummaryReady: "meeting",
  HeartbeatStalled: "escalation",
};

/** 单条 events 插入：8 列 8 个匿名问号，单语句无分号。 */
export const INSERT_EVENT_SQL =
  "INSERT INTO events (task_id, actor_type, actor_id, action, target, payload, " +
  "state_snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";

export interface AuditRow {
  readonly taskId: string | null;
  readonly actorType: "agent" | "human" | "system";
  readonly actorId: string;
  readonly action: AuditAction;
  readonly target: string | null;
  readonly payload: unknown;
  readonly stateSnapshot?: unknown;
  readonly createdAt?: number;
}

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
    row.target ?? null, // target
    serializePayload(row.payload), // payload
    row.stateSnapshot === undefined
      ? null
      : serializePayload(row.stateSnapshot),
    row.createdAt ?? now(), // created_at
  ];
}

/** 在【当前事务】里插一行，返回 events.id（= 总线 seq）。 */
export function appendAudit(
  db: DatabaseSync,
  row: AuditRow,
  now?: () => number,
): number {
  // 两条自检是 0.5 留下的现成工具，这里必须复用而不是另写一份：
  // 少绑参数在可空列上【不报错】，直接写 NULL —— 审计库最危险的失效方向。
  assertSingleStatement(INSERT_EVENT_SQL);
  const params = eventParams(row, now ?? Date.now);
  assertParamCount(INSERT_EVENT_SQL, params);
  const info = db.prepare(INSERT_EVENT_SQL).run(...(params as never[]));
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
  return id;
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
   * 里（0003 §6.2、规格 §6.3）。常驻连接会让 recorder 在事务边界之外 autocommit，
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
    case "MeetingSummaryReady":
      return e.meetingId;
    case "HeartbeatStalled":
      return e.node;
    case "BudgetPaused":
      return null; // 没有更具体的对象，回落到 taskId
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
    const id = appendAudit(db, row, this.#now);
    this.#writtenInTx += 1;
    this.#pending.push({ event: e, seq: id });
    return id;
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
