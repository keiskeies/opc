/**
 * 预算护栏（计划 Task 1.6，规格 §7.4 / §21）。
 *
 * 三条硬规矩，都写在代码里而不是文档里：
 *
 * 1) 【金额一律整数美分】（规格 §6.1）。美元浮点是这个功能最经典的失效方式：
 *    0.1 + 0.2 !== 0.3，累计一万次就凭空多出几分钱，而「超没超预算」是一个
 *    边界判定 —— 浮点误差恰好在边界上决定结果。所有对外接口也只接受美分整数，
 *    不给调用方传美元小数的口子（传口子就会有人传）。
 *
 * 2) 【突破 ⇒ 暂停该节点，不杀任务】（规格 §7.4）。杀任务会把已完成的工作一起丢掉，
 *    而预算突破是「需要人决定要不要继续花」，不是「这条任务作废」。落地上表现为
 *    发一条 BudgetPaused 事件 + 该节点在下一步停下，任务状态留在 BUDGET_PAUSED。
 *
 * 3) 【同一事件的重复上报不重复扣减】。这是崩溃重启的正确性问题：重放时同一条消费
 *    会被再报一次（0005 §11 那条重放缺陷就是这个形状）。幂等靠 budget_events 表的
 *    主键 source_event = events.id 承载 —— 不是靠调用方记得判重。为什么幂等键必须
 *    是 events.id 而不是自造 UUID：重放同一条审计行拿到的 seq 相同，而自造 UUID
 *    每次都是新的，那种键在真正需要它的时刻（重放）恰好失效。
 */

import type { DatabaseSync } from "node:sqlite";
import { assertParamCount, assertSingleStatement } from "../db/write-queue.js";
import type { AuditRecorder } from "../events/recorder.js";

/** §21.1 三级作用域，逐字对齐 budgets.scope_type。 */
export const BUDGET_SCOPES = ["company", "role", "task"] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

/** budgets.period 的取值。 */
export const BUDGET_PERIODS = ["daily", "monthly", "per_task"] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

/** 一次消费上报。amountCents 是【本次新增】的量，不是累计值。 */
export interface ConsumeInput {
  /** 幂等键：events.id（seq）。见文件头第 3 条。 */
  readonly sourceEvent: number;
  readonly scope: BudgetScope;
  readonly scopeId: string;
  readonly period: BudgetPeriod;
  readonly amountCents: number;
  /**
   * 归属任务。【必填】不是可选：DomainEvent 的 BudgetPaused 要求 taskId，
   * 而语义上也确实必填 —— 预算总是在【某个任务的节点执行中】被消耗的，
   * 角色级/公司级日预算也一样（超限的是角色今天的总额，但花这笔钱的是这个任务）。
   * 做成可选会让「这条超限是为谁发的」在审计里变成 NULL，CEO 收到卡片却点不回任务。
   */
  readonly taskId: string;
  /** 突破时要暂停的那个节点名（图里的节点，不是角色）。 */
  readonly node?: string;
}

export interface ConsumeResult {
  /** 本次上报是否真的扣减了（false = 幂等命中，重复上报）。 */
  readonly applied: boolean;
  readonly consumedCents: number;
  readonly limitCents: number;
  /** 本次上报【导致】突破。已处于突破态时为 false（不重复发事件）。 */
  readonly breached: boolean;
  /** 当前是否处于突破态（调用方据此决定是否暂停节点）。 */
  readonly over: boolean;
  readonly duplicateOf?: number;
}

const ENSERT_BUDGET_SQL =
  "INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, consumed_cents, hard_stop) " +
  "VALUES (?, ?, ?, ?, ?, 0, 1) ON CONFLICT(scope_type, scope_id, period) DO NOTHING";

const IDEMPOTENT_INSERT_SQL =
  "INSERT INTO budget_events (source_event, scope_type, scope_id, period, amount_cents, task_id, created_at) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_event) DO NOTHING";

const SELECT_CONSUMED_SQL =
  "SELECT consumed_cents FROM budgets WHERE scope_type = ? AND scope_id = ? AND period = ?";

const ADD_CONSUMED_SQL =
  "UPDATE budgets SET consumed_cents = consumed_cents + ? " +
  "WHERE scope_type = ? AND scope_id = ? AND period = ?";

const SELECT_LIMIT_SQL =
  "SELECT limit_cents FROM budgets WHERE scope_type = ? AND scope_id = ? AND period = ?";

export interface BudgetTrackerOptions {
  readonly db: DatabaseSync;
  readonly recorder: AuditRecorder;
  readonly now?: () => number;
}

/**
 * 预算跟踪器。
 *
 * ⚠ 它【不自己开事务】：写 budgets 与写 events 必须在同一事务里（规格 §6.3），
 * 所以它要求调用方已经处在超步事务内，用 recorder 暴露的连接执行。
 * 与 evidence/store.ts 同一条理由：自己 openDb 就会在事务外 autocommit，
 * 于是「扣了预算但没有对应审计事件」这种半套状态重新可能出现。
 */
export class BudgetTracker {
  readonly #db: DatabaseSync;
  readonly #recorder: AuditRecorder;
  readonly #now: () => number;

  constructor(o: BudgetTrackerOptions) {
    this.#db = o.db;
    this.#recorder = o.recorder;
    this.#now = o.now ?? Date.now;
  }

  /** 声明一个作用域的预算上限。已存在则不动（重复声明不该把已消费量清零）。 */
  declareLimit(o: {
    scope: BudgetScope;
    scopeId: string;
    period: BudgetPeriod;
    limitCents: number;
  }): void {
    assertCents(o.limitCents, "limit_cents");
    const sql = ENSERT_BUDGET_SQL;
    assertSingleStatement(sql);
    const params: unknown[] = [
      // id 用三段拼接而不是 UUID：这一行的身份【就是】(scope, scope_id, period)，
      // 用随机 UUID 会让「同一作用域重复声明」产生两条语义上同一、身份上不同的行。
      o.scope + "|" + o.scopeId + "|" + o.period,
      o.scope,
      o.scopeId,
      o.period,
      o.limitCents,
    ];
    assertParamCount(sql, params);
    this.#db.prepare(sql).run(...(params as never[]));
  }

  limitCents(scope: BudgetScope, scopeId: string, period: BudgetPeriod): number {
    const sql = SELECT_LIMIT_SQL;
    assertSingleStatement(sql);
    const params = [scope, scopeId, period];
    assertParamCount(sql, params);
    const row = this.#db
      .prepare(sql)
      .get(...(params as never[])) as { limit_cents: number } | undefined;
    if (row === undefined) {
      throw new Error(
        "作用域 [" +
          scope +
          ":" +
          scopeId +
          "/" +
          period +
          "] 没有声明预算上限，无法判突破。" +
          "缺上限时【不默认放行】：默认无限额度意味着预算护栏对这条作用域完全不存在，" +
          "而它存在的意义正是拦突破。先 declareLimit()。",
      );
    }
    return row.limit_cents;
  }

  /**
   * 记一笔消费，返回是否突破。
   *
   * 顺序：先校验（金额 → 幂等键 → budgets 有没有行）→ 幂等插入 → 扣减 → 判突破 → 发事件。
   *
   * 校验必须排在幂等插入【之前】，这个顺序不是风格问题。插入一旦成功，source_event
   * 这个键就被烧掉了；此后同一条上报再来，函数会走「applied: false」那条支路当成
   * 已处理。于是「插入成功、扣减失败」的组合若没有连带回滚（调用方没在事务里跑），
   * 结果就是 budget_events 里有一行、budgets 里没扣 —— 正是文件头那条「比重复扣更坏」
   * 的状态，而且此后每次重试都被静默判成重复。把「budgets 里有没有这行」这类校验
   * 提到插入前面，最常见的失败原因（作用域没声明）就再也烧不到键。
   *
   * 另一处前置：consume 要求【调用方已经处在超步事务里】（recorder.inStepTx()）。
   * 不检查会留下什么：非突破的那笔消费不写事件，所以在事务外调用一样「成功」，
   * 于是 consumed_cents 在节点失败回滚之后照样前进了一格 —— 扣了钱、活儿没干成，
   * 重放时那一笔还被幂等键挡住，账面看着完全自洽。declareLimit【不加】这条约束：
   * 它在启动期/迁移期声明限额，本来就不属于任何一次超步。
   */
  async consume(input: ConsumeInput): Promise<ConsumeResult> {
    if (!this.#recorder.inStepTx()) {
      throw new Error(
        "BudgetTracker.consume 必须在超步事务内调用（外层用 recorder.run() 包住）。" +
          "事务外调用不会报错但会 autocommit：节点随后失败时那一格扣减留得下来，" +
          "于是预算为一次【没有发生】的工作付了钱，而幂等键让重放无法纠正它。",
      );
    }
    assertCents(input.amountCents, "amount_cents");
    if (!Number.isSafeInteger(input.sourceEvent) || input.sourceEvent <= 0) {
      throw new Error(
        "source_event 必须是正的 events.id（实到 " +
          String(input.sourceEvent) +
          "）。幂等键不可用时重复扣减无法拦下 —— 宁可抛错。",
      );
    }
    // 这两次读同时兼作「作用域声明过没有」的前置校验（缺行即抛，见 #consumed）。
    const before = this.#consumed(input);
    const limit = this.limitCents(input.scope, input.scopeId, input.period);

    const sql = IDEMPOTENT_INSERT_SQL;
    assertSingleStatement(sql);
    const params: unknown[] = [
      input.sourceEvent,
      input.scope,
      input.scopeId,
      input.period,
      input.amountCents,
      input.taskId,
      this.#now(),
    ];
    assertParamCount(sql, params);
    const info = this.#db.prepare(sql).run(...(params as never[]));
    if (Number(info.changes) === 0) {
      // 主键冲突 ⇒ 这笔已经记过。幂等命中：不扣减、不发事件。
      return {
        applied: false,
        consumedCents: before,
        limitCents: limit,
        breached: false,
        over: before > limit,
        duplicateOf: input.sourceEvent,
      };
    }

    const addSql = ADD_CONSUMED_SQL;
    assertSingleStatement(addSql);
    const addParams: unknown[] = [
      input.amountCents,
      input.scope,
      input.scopeId,
      input.period,
    ];
    assertParamCount(addSql, addParams);
    this.#db.prepare(addSql).run(...(addParams as never[]));
    const after = this.#consumed(input);

    // 【跨过】才算突破：before <= limit && after > limit。
    // 用 after > limit 单独判会让每一次后续消费都再发一条 BudgetPaused（已超预算时
    // 每步都发），CEO 收件箱会被同一条超限刷满。
    const breached = before <= limit && after > limit;
    const over = after > limit;
    if (breached) {
      await this.#recorder.record({
        kind: "BudgetPaused",
        taskId: input.taskId,
        spentUsdCents: after,
      });
    }
    return {
      applied: true,
      consumedCents: after,
      limitCents: limit,
      breached,
      over,
    };
  }

  #consumed(i: {
    scope: BudgetScope;
    scopeId: string;
    period: BudgetPeriod;
  }): number {
    const sql = SELECT_CONSUMED_SQL;
    assertSingleStatement(sql);
    const params = [i.scope, i.scopeId, i.period];
    assertParamCount(sql, params);
    const row = this.#db
      .prepare(sql)
      .get(...(params as never[])) as { consumed_cents: number | null } | undefined;
    if (row === undefined) {
      throw new Error(
        "作用域 [" +
          i.scope +
          ":" +
          i.scopeId +
          "/" +
          i.period +
          "] 在 budgets 里没有行，无法记账。先 declareLimit()。",
      );
    }
    // NULL 视为 0 是【有依据的】：0001_init.sql 的 consumed_cents 有 DEFAULT 0，
    // 但 DEFAULT 只在 INSERT 未列该列时生效，显式 INSERT NULL 会存进 NULL。
    return row.consumed_cents ?? 0;
  }

}

/**
 * 美分校验。NaN / 小数 / 负数 / 超大整数全部拒绝。
 *
 * 负数必须拒：扣减为负 = 退款 = 凭空增加可用额度，而调用方是 agent。
 * 超过 MAX_SAFE_INTEGER 拒：一旦超过，+= 会静默失真（JS number 的整数精度上限），
 * 那种失真在审计里表现为「账对得上但金额不对」，几乎查不出来。
 */
export function assertCents(v: number, what: string): void {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) {
    throw new Error(
      what +
        " 必须是【整数美分】且不超过安全整数范围（实到 " +
        String(v) +
        "）。规格 §6.1 禁浮点金额：0.1 + 0.2 !== 0.3 在累计后会让「是否超预算」" +
        "这个边界判定随误差翻转。",
    );
  }
  if (v < 0) {
    throw new Error(
      what + " 不得为负（实到 " + v + "）。负数扣减等于凭空增加额度。",
    );
  }
}
