/**
 * 预算（budgets 表）的 HTTP 读写（浏览器预算页）。
 *
 * ── 为什么写侧【只认回环】，与 POST /charter 同一条判据 ──────────────────
 * POST /budget 直接改限流数字：执行侧（BudgetTracker）判超限时只读 budgets，
 * 改预算 = 改「跑到多少钱就停」。规格 §4.4.3 把 role_budget / company_budget
 * 都集中给 CEO，所以它与改岗位书、改组织同级 —— 只认回环 + HMAC，
 * 不进远程一次性 token 通道（§20.3 只授权「审批」出本机）。
 *
 * ── 为什么不复用 charter/budget-sync 里那条 upsert ───────────────────────
 * 那条（budget-sync.ts 的 upsertLimit）语义是「岗位书同步只管改上限，
 * hard_stop 恒写 1」；HTTP 这一条必须同时写 hard_stop —— 那是语义不同的语句，
 * 不是同一份判据的第二份抄本。行 id 的三段拼接形状在那边有注释说明，这里同形。
 *
 * ── GET /budget 的 unset_scopes ──────────────────────────────────────────
 * 「组织图里有岗位角色、而 budgets 里没有任何对应 role 行」的角色个数
 * （界面要显示「有几个角色一行预算都没设」）。角色集合优先取当前生效组织图
 * （与 GET /org 同源）；没提交过组织图时退到 tasks.assigned_role
 * （budget-sync 的 budgetTierSummary 同口径），两者都没有 ⇒ 0。
 */
import {
  BUDGET_PERIOD_VALUES,
  BUDGET_SCOPE_VALUES,
  HTTP_NOT_IMPLEMENTED,
  HTTP_UNAUTHORIZED,
  HTTP_UNPROCESSABLE,
  putBudgetRequestSchema,
} from "@opc/contracts";
import {
  assertCents,
  type BUDGET_PERIODS,
  type BUDGET_SCOPES,
} from "../budget/tracker.js";
import { CHARTER_ACTOR } from "../charter/store.js";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import {
  assertParamCount,
  assertSingleStatement,
  type Writer,
} from "../db/write-queue.js";
import { appendAudit } from "../events/recorder.js";
import { readLatestGraph } from "../org/commit.js";
import type { HubDeps, HubRequest, HubResponse } from "./app.js";
import { isLoopbackAddress } from "./bind.js";

function res(status: number, body: unknown): HubResponse {
  return { status, body };
}

function parseJson(text: string): unknown {
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { __unparseable__: true };
  }
}

function issueBody(
  error: string,
  issues: { path: string; message: string }[],
): HubResponse {
  return res(HTTP_UNPROCESSABLE, { error, issues });
}

function issuesOf(e: {
  readonly issues: readonly {
    readonly path: readonly PropertyKey[];
    readonly message: string;
  }[];
}): { path: string; message: string }[] {
  return e.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

/** 回环门。null = 放行。同 charter.ts / org.ts。 */
export function assertLoopbackBudgetRoute(req: HubRequest): HubResponse | null {
  if (isLoopbackAddress(req.peer)) return null;
  return res(HTTP_UNAUTHORIZED, { error: "unauthorized" });
}

/**
 * 两份枚举字面量各住一处（contracts 不 import hub），这里做一次【编译期】对账：
 * 类型互赋要求两侧是同一组字面量，任何一侧漂了 tsc 当场红。
 */
const SCOPES_AGREE: typeof BUDGET_SCOPES = BUDGET_SCOPE_VALUES;
const PERIODS_AGREE: typeof BUDGET_PERIODS = BUDGET_PERIOD_VALUES;
void SCOPES_AGREE;
void PERIODS_AGREE;

/** 行 id 的三段拼接，与 tracker.ts / charter/budget-sync.ts 同形（行的身份就是三元组）。 */
export function budgetRowKey(
  scopeType: string,
  scopeId: string,
  period: string,
): string {
  return scopeType + "|" + scopeId + "|" + period;
}

/**
 * 该有预算行的「岗位角色」集合，见文件头 unset_scopes 一段。
 */
export function expectedRoleScopes(deps: HubDeps): string[] {
  const g = readLatestGraph(deps.db);
  if (g !== null) return Object.keys(g.graph.nodes).sort();
  const sql =
    "SELECT DISTINCT assigned_role AS r FROM tasks WHERE assigned_role IS NOT NULL";
  assertSingleStatement(sql);
  const rows = deps.db.prepare(sql).all() as unknown as { r: string }[];
  return rows.map((x) => x.r).sort();
}

/**
 * `GET /budget` —— rows 是 budgets 全表（按作用域排序），totals 是三个汇总数。
 * limit/consumed 强制 Number()：node:sqlite 可能回 bigint，bigint 进 JSON 会抛。
 */
export function budgetListRoute(deps: HubDeps): HubResponse {
  const sql =
    "SELECT scope_type, scope_id, period, limit_cents, consumed_cents, hard_stop " +
    "FROM budgets ORDER BY scope_type, scope_id, period";
  assertSingleStatement(sql);
  const raw = deps.db.prepare(sql).all() as unknown as Record<
    string,
    unknown
  >[];
  const rows = raw.map((r) => ({
    scope_type: String(r["scope_type"]),
    scope_id: String(r["scope_id"]),
    period: String(r["period"]),
    limit_cents: Number(r["limit_cents"]),
    consumed_cents: Number(r["consumed_cents"] ?? 0),
    hard_stop: Number(r["hard_stop"] ?? 1) === 1,
  }));
  const withRole = new Set(
    rows.filter((r) => r.scope_type === "role").map((r) => r.scope_id),
  );
  const unset = expectedRoleScopes(deps).filter(
    (role) => !withRole.has(role),
  ).length;
  return res(200, {
    rows,
    totals: {
      limit_cents: rows.reduce((s, r) => s + r.limit_cents, 0),
      consumed_cents: rows.reduce((s, r) => s + r.consumed_cents, 0),
      unset_scopes: unset,
    },
  });
}

export const UPSERT_BUDGET_ROW_SQL =
  "INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, consumed_cents, hard_stop) " +
  "VALUES (?, ?, ?, ?, ?, 0, ?) " +
  "ON CONFLICT(scope_type, scope_id, period) " +
  "DO UPDATE SET limit_cents = excluded.limit_cents, hard_stop = excluded.hard_stop";

/**
 * 一格限额的 upsert + 一条审计，同一事务（§6.3：改限流与留痕同生同死）。
 * 审计的 actor 用 CHARTER_ACTOR（human/ceo）：与岗位书/预算同步同一个署名口径 ——
 * 改预算的是人，不是 agent（§4.4.3 role_budget: "ceo"）。
 * alarm_silenced 沿用 budget-sync 文件头 ② 的报警口径：把上限调到已消费量之下
 * 会永久哑掉该格的突破警报（breached 只在「跨过」那一刻为真），必须说出来。
 */
export async function putBudgetRowVia(
  w: Writer,
  o: {
    readonly scopeType: string;
    readonly scopeId: string;
    readonly period: string;
    readonly limitCents: number;
    readonly hardStop: boolean;
    readonly nowMs: number;
  },
): Promise<{ auditSeq: number; changed: boolean }> {
  const wrote = await w.node(() => {
    const db = requireScopeDb("putBudgetRow");
    // 先读旧值：ON CONFLICT DO UPDATE 即使值没变 changes 也是 1（SQLite 按匹配计），
    // 「这次保存改没改」只能靠比旧值判 —— 同 budget-sync 那条的必要读。
    const selSql =
      "SELECT limit_cents, consumed_cents FROM budgets " +
      "WHERE scope_type = ? AND scope_id = ? AND period = ?";
    assertSingleStatement(selSql);
    const selParams: unknown[] = [o.scopeType, o.scopeId, o.period];
    assertParamCount(selSql, selParams);
    const before = db.prepare(selSql).get(...(selParams as never[])) as
      | { limit_cents: number | null; consumed_cents: number | null }
      | undefined;

    const params: unknown[] = [
      budgetRowKey(o.scopeType, o.scopeId, o.period),
      o.scopeType,
      o.scopeId,
      o.period,
      o.limitCents,
      o.hardStop ? 1 : 0,
    ];
    assertSingleStatement(UPSERT_BUDGET_ROW_SQL);
    assertParamCount(UPSERT_BUDGET_ROW_SQL, params);
    db.prepare(UPSERT_BUDGET_ROW_SQL).run(...(params as never[]));

    const prev = before === undefined ? null : Number(before.limit_cents);
    const consumed = Number(before?.["consumed_cents"] ?? 0);
    const changed = prev !== o.limitCents;
    const nowOver = consumed > o.limitCents;
    const rowId = budgetRowKey(o.scopeType, o.scopeId, o.period);
    const seq = appendAudit(
      db,
      {
        taskId: null,
        actorType: CHARTER_ACTOR.actorType,
        actorId: CHARTER_ACTOR.actorId,
        action: "state_change",
        target: rowId,
        payload: {
          kind: "budget_limit_put",
          scope: rowId,
          previous_limit_cents: prev,
          limit_cents: o.limitCents,
          hard_stop: o.hardStop,
          changed,
          alarm_silenced: nowOver && prev !== null,
        },
        stateSnapshot: { before: prev, after: o.limitCents },
        createdAt: o.nowMs,
      },
      () => o.nowMs,
    );
    return { seq, changed };
  });
  if (wrote === undefined || wrote === null) {
    throw new Error(
      "事务没有返回结果（WriteQueue 那一层给出空）—— 未写入，未审计。",
    );
  }
  return { auditSeq: wrote.seq, changed: wrote.changed };
}

/**
 * `POST /budget` —— upsert 一格限额。
 * 流程：回环门 → 装配未接 ⇒ 501 → 请求体过 schema ⇒ 422（带 issues）
 * → assertCents ⇒ 422 → putBudgetRowVia ⇒ 200 { ok: true }。
 * assertCents 的拒因（浮点/负数/超安全整数）翻成 422 带原文，而不是让 500
 * 把「你的数字写错了」说成服务端故障。
 */
export async function putBudgetRoute(
  deps: HubDeps,
  req: HubRequest,
): Promise<HubResponse> {
  const gate = assertLoopbackBudgetRoute(req);
  if (gate !== null) return gate;
  if (deps.budgetWriter === undefined) {
    return res(HTTP_NOT_IMPLEMENTED, {
      error:
        "本装配未接预算写入（HubDeps.budgetWriter）。501 而不是 404：路由在，" +
        "契约里有，是这个装配没把写队列连起来。",
    });
  }
  const parsed = putBudgetRequestSchema.safeParse(parseJson(req.body));
  if (!parsed.success) {
    return issueBody("预算写入请求非法", issuesOf(parsed.error));
  }
  const o = parsed.data;
  try {
    assertCents(o.limit_cents, "limit_cents");
  } catch (e) {
    return res(HTTP_UNPROCESSABLE, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  await putBudgetRowVia(deps.budgetWriter, {
    scopeType: o.scope_type,
    scopeId: o.scope_id,
    period: o.period,
    limitCents: o.limit_cents,
    hardStop: o.hard_stop,
    nowMs: deps.now(),
  });
  return res(200, { ok: true });
}
