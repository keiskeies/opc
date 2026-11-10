/**
 * 岗位书预算 → `budgets` 三级限额（计划 Task 3.6「预算层级配置」那一半的**后端**）。
 *
 * 计划那条 Test 的原话是「预算层级（公司 / 角色 / 任务）显示与编辑一致」。
 * 动手前先量了四个事实，每一个都改变了这里该写什么：
 *
 *  ① `declareLimit()` 对**已存在**的作用域是**静默 no-op**。
 *     它的 SQL 是 `ON CONFLICT … DO NOTHING`（ENSERT_BUDGET_SQL，tracker.ts:65-67）。实测：
 *     先 declare 1000、再 declare 2000，`limitCents()` 读回来仍然是 **1000**。
 *     ⇒ 拿它做「编辑器里保存新预算」，症状是**保存成功、数字没变、零报错**。
 *     这是本模块存在的首要理由：编辑器要的是 UPDATE 而不是 declare。
 *     我没有改 tracker.declareLimit —— 它的语义（「重复声明不该把已消费量清零」）
 *     对自己那些启动期的调用方是对的，且它带着 Task 1.6 的既有用例；
 *     改它会把「declare 幂等」这条已验收的行为换掉。要改限流的**就**是限流。
 *  ② **把上限调到已消费量之下，警报永久关闭**（实测，三条连着看）：
 *       消费 1200 / 上限 1000 ⇒ breached=true，BudgetPaused 1 条
 *       UPDATE limit_cents=500 ⇒ **不发任何事件**（仍 1 条）
 *       之后再消费 100 ⇒ applied=true、**breached=false**、over=true，仍 1 条
 *     成因在 tracker.ts:233 那行：`breached = before <= limit && after > limit`
 *     （「跨过才算突破」，它自己的注释说明是为了不让收件箱被同一条超限刷满）。
 *     而 `consumed_cents` 在整个 src 里**只有 `+ ?` 一处写入**（实测：除
 *     ADD_CONSUMED_SQL 之外零写入方，没有任何归零/重算路径）⇒ consumed 单调不减。
 *     于是 `before <= limit` 一旦为假就**永不为真**：那个作用域的突破警报
 *     **永久关闭**，而关闭它的是一次看起来无害的「把预算从 $10 调到 $5」。
 *     ⇒ 本模块必须自己把这件事说出来（`silence_alarm` / `now_over`），
 *       并给出一条**读侧**的补救 `silentOverBudgets()`：警报哑了，但数还在。
 *     我没有替它补发 BudgetPaused：那个事件要求 `taskId`（bus.ts:49 的
 *     DomainEvent 形状，tracker.ts:238 传的是消费方的任务），而一次限额变更
 *     不属于任何任务。编一个 taskId 就是伪造一条 CEO 点得进去的卡片
 *     （同 0014 §3 那条立场：少一个事件是可以补的缺口，脏了的审计库删不掉）。
 *  ③ USD → 美分**不能直接乘**（实测）：0–20.00 这 2001 个两位小数里，
 *     `usd * 100` **不是整数**的有 **271 个**（0.07 → 7.000000000000001、
 *     0.29 → 28.999999999999996…）。`assertCents` 会当场拒掉它们，
 *     而报错说「必须是整数美分」—— 一个从 YAML 里抄 `daily_usd: 0.07` 的人
 *     会以为是自己的数字写错了。`Math.round` 之后 2001 个全整数（实测）。
 *     但**不做无条件的 round**：那会把半分钱悄悄抬成一分钱。
 *     判据是「离整数够不够近」，够近（1e-9，远小于任何浮点表示误差、
 *     远大于任何真实精度）才算同一个数，否则拒（§6.1 金额以美分为最小单位）。
 *  ④ **规格没有给公司级默认值**。§21.1 只说「公司级 → 角色级 → 任务级，任一层级
 *     达到阈值自动暂停」。preset 七份岗位书里 `daily_usd` 合计 **150**、
 *     `per_task_usd` 合计 **49**（实测逐份相加）。
 *     ⇒ 两件事跟着定：
 *       (a) **不编一个公司级默认值**（150 是七份 YAML 的和，不是「公司每天该花多少」，
 *           拿它当公司上限等于让 CEO 的 YAML 措辞变成公司预算决策 —— 那归 CEO，§4.4.3）；
 *       (b) **不断言 task ⊆ role ⊆ company**。它听起来是三级预算的应有之义，
 *           而在现成数据上**根本无从判定**：公司级那一格一行都没有（见 (a)）。
 *           而且规格没说是「数值嵌套」还是「三道各自独立的阈值」——
 *           若是嵌套，某角色 per_task 5000¢ 该不该 ≤ 它自己的 daily 1500¢？
 *           并发四条任务时角色日额会被四条 per_task 一起打穿，
 *           那既不是 bug 也不是 feature，规格没说。所以这里只做**能算的那一半**：
 *           报告每一级声明了没有，不猜没声明的那一级，
 *           也不给「三级关系不成立」这种没有判据的结论。
 *
 * 「显示与编辑一致」这一维由 `readBudgetTiers()` 承担，它把**没声明**与**声明为 0**
 * 分成两种结果。合并成 0 会让「这个角色没配预算」显示成「这个角色预算是 0」，
 * 而界面上那两种东西该说的话完全相反（前者是「没设限」，后者是「一分钱都不许花」）。
 */

import type { DatabaseSync } from "node:sqlite";
import type { Charter } from "@opc/contracts";
import { assertParamCount, assertSingleStatement, type Writer } from "../db/write-queue.js";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import { appendAudit } from "../events/recorder.js";
import { assertCents, type BudgetPeriod, type BudgetScope } from "../budget/tracker.js";

/** 与 charter/store.ts 同一个署名：改预算的是人，不是 agent（规格 §4.4.3 `role_budget: "ceo"`）。 */
export const BUDGET_ACTOR = { actorType: "human", actorId: "ceo" } as const;

/** 审计 payload.kind。action 仍是 state_change（§22.1 那个 10 值枚举里没有「改预算」）。 */
export const BUDGET_SYNC_AUDIT_KIND = "budget_limits_synced";

/**
 * USD → 美分。判据见文件头 ③。
 * 拒而不是 round 的那一类：0.005（半分钱，账上表达不出来）。
 */
export function usdToCents(usd: number, what = "金额"): number {
  if (typeof usd !== "number" || !Number.isFinite(usd)) {
    throw new Error(what + " 必须是有限数值（实到 " + String(usd) + "）。");
  }
  if (usd < 0) {
    throw new
      Error(what + " 不得为负（实到 " + usd + "）。负预算等于凭空增加额度（与 assertCents 同一立场）。");
  }
  const raw = usd * 100;
  const near = Math.round(raw);
  // 容差的量级是刻意选的，别改成 1e-6 或 1e-12：
  // 浮点表示误差在这个题面上是 1e-14 量级（0.07*100 偏 8.9e-15），
  // 而「真的有半分钱」的差距是 5e-1。1e-9 把两者分开且两边都有几个数量级余量。
  if (Math.abs(raw - near) > 1e-9) {
    throw new Error(
      what + " [" +
        usd +
        "] 换算成美分是 " +
        raw +
        "，**不是**整数（差距 " +
        Math.abs(raw - near) +
        "，超过容差 1e-9）。规格 §6.1 以美分为最小单位：半分钱在账上表达不出来。" +
        "刻意不做无条件 Math.round —— 那会把 0.005 悄悄抬成 0.01，" +
        "而「悄悄抬」的方向是让 CEO 批的钱比他想的多。",
    );
  }
  const cents = near;
  assertCents(cents, what + "（" + usd + " USD 换算后）");
  return cents;
}

/** 作用域在 `budgets` 里的主键形状。**逐字照抄 tracker.ts:121** 的拼法。 */
export function budgetRowId(scope: BudgetScope, scopeId: string, period: BudgetPeriod): string {
  return scope + "|" + scopeId + "|" + period;
}

/**
 * 岗位书里那两格预算 → 该写进 `budgets` 的行。
 *
 * 只出 **role** 层两行。公司级与任务级**不出**（文件头 ④：规格没给默认值，
 * 而 preset 里的 per_task 是「这个角色的单条任务」而不是「公司给每条任务的默认」，
 * 两种读法给出的数不同）。要写那两级必须由调用方**显式**传值。
 */
export const ROLE_DAILY_SCOPE: { scope: BudgetScope; period: BudgetPeriod } = {
  scope: "role",
  period: "daily",
};
export const ROLE_PER_TASK_SCOPE: { scope: BudgetScope; period: BudgetPeriod } = {
  scope: "role",
  period: "per_task",
};

export function budgetRowsFromCharter(
  charter: Charter,
): { scope: BudgetScope; scopeId: string; period: BudgetPeriod; limitCents: number }[] {
  return [
    {
      scope: ROLE_DAILY_SCOPE.scope,
      scopeId: charter.roleId,
      period: ROLE_DAILY_SCOPE.period,
      limitCents: usdToCents(charter.budget.dailyUsd, charter.roleId + " 的 dailyUsd"),
    },
    {
      scope: ROLE_PER_TASK_SCOPE.scope,
      scopeId: charter.roleId,
      period: ROLE_PER_TASK_SCOPE.period,
      limitCents: usdToCents(charter.budget.perTaskUsd, charter.roleId + " 的 perTaskUsd"),
    },
  ];
}

/**
 * 声明或改一个限额，返回**有没有真的变**。
 *
 * 与 declareLimit 的唯一区别就是那句 `DO UPDATE`，而那一句换来 `changed` 可判定。
 * 为什么还要先读一次旧值：`DO UPDATE` 即使写入的值与旧值**完全相同**，
 * `changes` 仍然是 1（SQLite 按「有没有匹配到行」计 changes，不按「值有没有变」）。
 * 所以「这次保存有没有改动任何东西」**不能**靠 changes 判 —— 只能读一次旧值比。
 * 这个多出来的一次读是必要的，不是可以省的冗余。
 */
export function upsertLimit(
  db: DatabaseSync,
  o: { scope: BudgetScope; scopeId: string; period: BudgetPeriod; limitCents: number },
): { changed: boolean; previousLimitCents: number | null; consumedCents: number; nowOver: boolean } {
  assertCents(o.limitCents, "limit_cents");
  const selSql =
    "SELECT limit_cents, consumed_cents FROM budgets " +
    "WHERE scope_type = ? AND scope_id = ? AND period = ?";
  assertSingleStatement(selSql);
  const selParams = [o.scope, o.scopeId, o.period];
  assertParamCount(selSql, selParams);
  const before = db.prepare(selSql).get(...(selParams as never[])) as
    | { limit_cents: number; consumed_cents: number | null }
    | undefined;

  const upSql =
    "INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, consumed_cents, hard_stop) " +
    "VALUES (?, ?, ?, ?, ?, 0, 1) " +
    "ON CONFLICT(scope_type, scope_id, period) DO UPDATE SET limit_cents = excluded.limit_cents";
  assertSingleStatement(upSql);
  const upParams: unknown[] = [
    // id 用三段拼接而不是 randomUUID：这一行的身份【就是】三元组（tracker.ts:120 那条理由）。
    // 用 UUID 的话，本模块先建的那一行会带着一个「看起来是随机实体」的 id 活下去，
    // 而 tracker 后来 declare 时撞了唯一索引、DO NOTHING —— 于是同一个逻辑预算
    // 在库里的身份取决于「谁先到」。
    budgetRowId(o.scope, o.scopeId, o.period),
    o.scope,
    o.scopeId,
    o.period,
    o.limitCents,
  ];
  assertParamCount(upSql, upParams);
  db.prepare(upSql).run(...(upParams as never[]));

  const prev = before === undefined ? null : Number(before.limit_cents);
  const consumed = before === undefined ? 0 : Number(before.consumed_cents ?? 0);
  return {
    changed: prev !== o.limitCents,
    previousLimitCents: prev,
    consumedCents: consumed,
    // 「这一格现在处于超限态」。调低上限让它成立，而它**不会**产生任何 BudgetPaused
    // （文件头 ②），所以只能在这里自己算并报出去。
    nowOver: consumed > o.limitCents,
  };
}

export interface SyncBudgetInput {
  /** 要落哪些角色的预算。通常来自 readLatestCharter()，但由调用方给（谁决定同步哪些角色是策略）。 */
  readonly rows: readonly {
    scope: BudgetScope;
    scopeId: string;
    period: BudgetPeriod;
    limitCents: number;
  }[];
  readonly nowMs: number;
  readonly changeSummary: string;
}

export interface SyncBudgetResult {
  readonly auditSeq: number;
  /** 逐行结果，顺序与入参一致。 */
  readonly rows: readonly {
    readonly scope: BudgetScope;
    readonly scopeId: string;
    readonly period: BudgetPeriod;
    readonly previousLimitCents: number | null;
    readonly limitCents: number;
    readonly changed: boolean;
    /** 落完这一个限额之后，这一格是否处于超限态（consumed > limit）。 */
    readonly nowOver: boolean;
    /**
     * `true` = 这一格现在超限，而**警报不会再响**（文件头 ②：
     * breached 只在「跨过」那一刻为真，consumed 单调不减 ⇒ 永远不会再跨过）。
     * 界面必须把它显示出来 —— 否则 CEO 看到的是「预算已收紧、一切正常」。
     */
    readonly alarmSilenced: boolean;
  }[];
}

/**
 * 在【调用方的事务里】落一份岗位书的两格预算，不自己开事务、不自己写审计。
 *
 * 存在的理由是「岗位书里写着 $15、budgets 里限流还是 $10」这件事不能存在。
 * 量到的形状：
 *  - `charter.budget` 是 CEO 写的（规格 §4.4.3 `role_budget: "ceo"`）；
 *  - `BudgetTracker.limitCents()` 判超限时【只读 budgets】，从不看岗位书
 *    （实测 tracker.ts 全文没有一处 charter 引用）；
 *  - 岗位书在 src 里此前【从来没有】往 budgets 写过任何东西（实测
 *    `INSERT INTO budgets` 的 src 侧写入口只有 tracker.declareLimit，
 *    而 declareLimit 的调用方【只有测试】—— 见 0015 §3）。
 *  ⇒ 两个源各存一份预算，谁生效看谁后写。这不是「以后再接」的缺口，
 *    是一个每次改岗位书都会【扩大漂移面】的结构。所以 saveCharterVersion
 *    必须在同一事务里把限额落到 budgets。
 *
 * 为什么【不】为这几行再写一条审计：saveCharterVersion 那条审计的
 * state_snapshot 里已经带了整份岗位书的 before/after（含 budget 两格），
 * 再补一条就是同一次变更的两条记录 —— 回放里会显示成「CEO 做了两件事」。
 * 代价如实说：单看 events，看不出「这次岗位书变更顺带改了限流表」。
 * 补救是把 alarm_silenced 放进同一条审计的 payload（见 store.ts），
 * 那一维恰恰是唯一需要在收件箱里主动喊出来的。
 */
export function applyBudgetRowsInTx(
  db: DatabaseSync,
  rows: readonly { scope: BudgetScope; scopeId: string; period: BudgetPeriod; limitCents: number }[],
): SyncRowResult[] {
  return rows.map((r) => {
    const res = upsertLimit(db, r);
    return {
      scope: r.scope,
      scopeId: r.scopeId,
      period: r.period,
      previousLimitCents: res.previousLimitCents,
      limitCents: r.limitCents,
      changed: res.changed,
      nowOver: res.nowOver,
      alarmSilenced: res.nowOver && res.previousLimitCents !== null,
    };
  });
}

/**
 * 一批限额 + 一条审计，同一事务。
 *
 * 审计**一条**而不是每行一条：这几行是「同一次保存」的产物，
 * 拆成多条会让「CEO 改了一次预算」在回放里看起来像改了几件事（与 org/commit 同口径）。
 * before/after 进 state_snapshot，人可读那句进 payload.change_summary。
 *
 * ⚠ 这条入口是给**公司级 / 任务级**用的（岗位书里没有那两级，文件头 ④）。
 *   角色级走 applyCharterBudgetsInTx —— 那里唯一的源是岗位书。
 *   给同一个作用域两条写入口而不做区分，就会出现「岗位书说 15、这条写了 5、
 *   下次同步岗位书又把它抬回 15」，而每一步单独看都合法。
 */
/** 单行结果的可变版本：SyncBudgetResult["rows"] 是 readonly 的，累加器不能用它（TS2339）。 */
type SyncRowResult = SyncBudgetResult["rows"][number];

export async function syncCharterBudgets(
  w: Writer,
  o: SyncBudgetInput,
): Promise<SyncBudgetResult> {
  if (o.changeSummary.trim() === "") {
    throw new Error(
      "changeSummary 不能是空串：审计里唯一人可读的那句「为什么改」。(与 charter/store 同一条判据)",
    );
  }
  if (o.rows.length === 0) {
    throw new Error(
      "rows 为空 ⇒ 一次「什么都没改」的保存也会留下一条 append-only 审计。" +
        "刻意拒绝：为一次没发生的变更留一条删不掉的记录（同 saveCharterVersion 那条立场）。",
    );
  }
  // 去重：同一个三元组出现两次会让第二行的 previousLimitCents 读到第一行刚写的值，
  // 于是 changed 报 false（「没改动」），而这一次保存明明改了数。
  const seen = new Set<string>();
  for (const r of o.rows) {
    const k = budgetRowId(r.scope, r.scopeId, r.period);
    if (seen.has(k)) {
      throw new Error(
        "rows 里同一个作用域出现了两次 [" +
          k +
          "]。刻意拒绝：第二行会把第一行刚写进去的值读成「旧值」，" +
          "于是 changed 报 false、审计的 before 也不是保存前的那个数。",
      );
    }
    seen.add(k);
  }

  const wrote = await w.node(() => {
    const db = requireScopeDb("syncCharterBudgets");
    const before: Record<string, number | null> = {};
    const results: SyncRowResult[] = [];
    for (const r of o.rows) {
      const k = budgetRowId(r.scope, r.scopeId, r.period);
      const res = upsertLimit(db, r);
      before[k] = res.previousLimitCents;
      results.push({
        scope: r.scope,
        scopeId: r.scopeId,
        period: r.period,
        previousLimitCents: res.previousLimitCents,
        limitCents: r.limitCents,
        changed: res.changed,
        nowOver: res.nowOver,
        alarmSilenced: res.nowOver && res.previousLimitCents !== null,
      });
    }
    const after: Record<string, number> = {};
    for (const r of o.rows) after[budgetRowId(r.scope, r.scopeId, r.period)] = r.limitCents;

    const silenced = results.filter((r) => r.alarmSilenced).map((r) => budgetRowId(r.scope, r.scopeId, r.period));
    const seq = appendAudit(
      db,
      {
        taskId: null,
        actorType: BUDGET_ACTOR.actorType,
        actorId: BUDGET_ACTOR.actorId,
        action: "state_change",
        // target 指向**这一批**而不是某一个作用域：一次保存一条事件。
        target: "budgets@" + o.rows.length,
        payload: {
          kind: BUDGET_SYNC_AUDIT_KIND,
          row_count: o.rows.length,
          change_summary: o.changeSummary,
          // 直接放进 payload 而不只放快照：日报/收件箱要能按这一维筛，
          // 而「有没有哑掉的格」是**告警**属性，不是历史细节。
          alarm_silenced: silenced,
        },
        stateSnapshot: { before, after },
        createdAt: o.nowMs,
      },
      () => o.nowMs,
    );
    return { seq, results };
  });

  if (wrote === undefined || wrote === null) {
    throw new Error("事务没有返回结果（WriteQueue 那一层给出空）—— 未写入，未审计。");
  }
  return { auditSeq: wrote.seq, rows: wrote.results };
}

/* ── 读侧：「显示与编辑一致」那一半 ─────────────────────────────────────── */

export interface BudgetTierRow {
  readonly scope: BudgetScope;
  readonly scopeId: string;
  readonly period: BudgetPeriod;
  /** 只在 `declared: false` 时为 null。声明为 0 时是 0，不是 null —— 见下面的类型注释。 */
  readonly limitCents: number | null;
  readonly consumedCents: number;
  readonly declared: boolean;
}

/**
 * 按「期望有哪些格」读回三级预算。
 *
 * 为什么入参要调用方给期望格而不是 `SELECT * FROM budgets`：
 * 「显示与编辑一致」这句话里，**编辑面**本来就有一份「该有哪几格」的清单
 * （每个角色两格 + 公司级那格 + 各任务那格）。读侧若用 SELECT *，
 * 一个从没声明过的作用域会**整行不出现**，界面就只能把它渲染成空白 ——
 * 空白与「0」在屏幕上是同一个东西，而它俩含义相反：
 *   没声明 = 这一级护栏**不存在**（tracker.limitCents 会抛，见其报错原文）
 *   声明为 0 = 一分钱都不许花（consumed 加 1 分就超限）
 * 所以这里按期望格补 `declared: false`，把两种情况在**数据类型**上就分开。
 */
export function readBudgetTiers(
  db: DatabaseSync,
  expected: readonly { scope: BudgetScope; scopeId: string; period: BudgetPeriod }[],
): BudgetTierRow[] {
  const sql =
    "SELECT scope_type, scope_id, period, limit_cents, consumed_cents FROM budgets " +
    "WHERE scope_type = ? AND scope_id = ? AND period = ?";
  assertSingleStatement(sql);
  const out: BudgetTierRow[] = [];
  for (const e of expected) {
    const params = [e.scope, e.scopeId, e.period];
    assertParamCount(sql, params);
    const row = db.prepare(sql).get(...(params as never[])) as
      | { limit_cents: number | null; consumed_cents: number | null }
      | undefined;
    out.push({
      ...e,
      declared: row !== undefined,
      limitCents: row === undefined ? null : row.limit_cents === null ? null : Number(row.limit_cents),
      consumedCents: Number(row?.["consumed_cents"] ?? 0),
    });
  }
  return out;
}

/**
 * 找出所有「已超限而**警报已哑**」的格子（文件头 ② 的补救）。
 *
 * 说清它是什么、不是什么：它是**读侧**的一条如实汇报，不是把警报接回去。
 * 接回去要动 `BudgetTracker.consume` 的 breached 判据 —— 那会改掉 Task 1.6
 * 已验收的行为（「已超预算时不重复发事件」，tracker.ts:230-233 那条注释与
 * 它的既有用例都在管这件事），而「一次超限发几条 BudgetPaused」是产品问题
 * （收件箱会被刷满 vs 警报永久哑），归 CEO。登记在 0015。
 *
 * `since` 不做参数：这张表**没有** updated_at（实测 budgets 只有五列 + hard_stop，
 * 0001_init.sql:166-175），所以「什么时候变的」在表上不可问。要按时间筛只能
 * 去 events 里按那次 state_change 找 —— 那是另一条查询、另一种口径。
 */
export function silentOverBudgets(db: DatabaseSync): BudgetTierRow[] {
  const sql =
    "SELECT scope_type, scope_id, period, limit_cents, consumed_cents FROM budgets " +
    "WHERE consumed_cents > limit_cents ORDER BY (consumed_cents - limit_cents) DESC";
  assertSingleStatement(sql);
  const rows = db.prepare(sql).all() as unknown as {
    scope_type: string;
    scope_id: string;
    period: string;
    limit_cents: number;
    consumed_cents: number;
  }[];
  return rows.map((r) => ({
    scope: r.scope_type as BudgetScope,
    scopeId: r.scope_id,
    period: r.period as BudgetPeriod,
    limitCents: Number(r.limit_cents),
    consumedCents: Number(r.consumed_cents ?? 0),
    declared: true,
  }));
}

/**
 * 三级**声明情况**概览（不含任何推断出来的默认值，文件头 ④）。
 * `companyDeclared === false` 是一个需要显示的事实，不是缺陷。
 */
export function budgetTierSummary(db: DatabaseSync): {
  companyDeclared: boolean;
  roleDeclared: number;
  taskDeclared: number;
  /** 有任务在跑、而角色级预算一行都没声明的角色数（§21.1「任一层级达到阈值」在缺声明时那一层不存在）。 */
  undeclaredRoles: number;
} {
  const one = (scope: BudgetScope): number => {
    const sql = "SELECT COUNT(*) AS c FROM budgets WHERE scope_type = ?";
    assertSingleStatement(sql);
    const params = [scope];
    assertParamCount(sql, params);
    return Number((db.prepare(sql).get(...(params as never[])) as { c: number }).c);
  };
  const rolesSql = "SELECT DISTINCT scope_id FROM budgets WHERE scope_type = 'role'";
  assertSingleStatement(rolesSql);
  const withRole = new Set(
    (db.prepare(rolesSql).all() as unknown as { scope_id: string }[]).map((r) => r.scope_id),
  );
  const allRolesSql = "SELECT DISTINCT assigned_role FROM tasks WHERE assigned_role IS NOT NULL";
  assertSingleStatement(allRolesSql);
  const allRoles = (db.prepare(allRolesSql).all() as unknown as { assigned_role: string }[]).map(
    (r) => r.assigned_role,
  );
  return {
    companyDeclared: one("company") > 0,
    roleDeclared: one("role"),
    taskDeclared: one("task"),
    undeclaredRoles: allRoles.filter((r) => !withRole.has(r)).length,
  };
}
