/**
 * 审批超时执行者（O10）。
 *
 * 这一格此前是【写下来的缺席】：`cards.ts` 把 `timeout_at` / `timeout_behavior`
 * 落库（`DEFAULT_TIMEOUT_HOURS = 8`），而全仓没有任何代码扫它并行动 ——
 * cards.test.ts ⑤ 那条「到期之后【什么都不发生】」断言的就是这种形状。
 * 本模块补的正是那一格：到期未决的卡，按 `timeout_behavior` 三档处理。
 * （cards.ts 文件头那段「拍下来的答案是『什么都不做』」随之过期，按 0026 §4
 * 的口径，那里现在指向本篇。）
 *
 * ── 三档语义（TIMEOUT_BEHAVIORS，contracts/src/gates.ts:40）──────────
 *   · `auto_reject` —— 到期自动打回。改 status='rejected'，审计一行，演员是
 *     system 不是 human：「CEO 没在 8 小时内回」被记成「CEO 拒绝了」是真话，
 *     记成「CEO 拒绝了」却是假话 —— 而 audience 在审计里必须分得开机器与人的决定
 *     （0026 §2 那句「把机器决定署了人的名」正是本条要防的）。
 *   · `auto_approve` —— 到期自动通过。改 status='approved'，审计一行 system。
 *     ⚠ 建卡时【不许】给它配上不可逆卡（拒建判据见 cards.ts），因为自动放行
 *     一张不可逆动作 = 一段没有人承担后果的决定 —— 它是 O9-3 的姐妹判据。
 *   · `escalate` —— 到期升级。对那张卡【不能再改它自己的 status】
 *     （approvals 没有 'escalated' 值），正确的动作是【新建一张 escalation 卡】
 *     （APPROVAL_TYPES 里的 'escalation'，0025 §8.2 拍板过它的卡片语义），
 *     原卡保持 pending —— 收件箱里出现一张新的、更醒目（escalation）的卡，
 *     才是「升级」在界面上的形状（0026 §3 原文：「升到哪一级」留给会议机制）。
 *
 * ── 与并发决定的关系 ────────────────────────────────────────────────
 * 到期瞬间 CEO 恰好点下批准：两次写同一行。这里是条件 UPDATE
 * （`WHERE id = ? AND status = 'pending'`），与 applyDecision 同一形状 ——
 * 谁先赢谁写，输的那次 changes === 0 且【不写审计】；那一行的后果是
 * 「CEO 的点击生效与否」以他的 UPDATE 为准，超时器不会倒填。
 *
 * ── 接线 ────────────────────────────────────────────────────────────
 * 本模块【不】自己起 ticker：调度归常驻进程（assemble.ts 的心跳 / patrol 的
 * 节奏），本模块只暴露 `runTimeoutPass(w, readDb, nowMs)` 这一个入口。
 * 十五分钟一跳的 ticker 放在哪、与 patrol 怎么穿插，是 assemble 那一层的事
 * （O10 动作 1 的「心跳里加一发扫描」）。
 *
 * ── 事务 ────────────────────────────────────────────────────────────
 * 一张卡的处理【一次 UPDATE + 一条审计，同一事务】—— 与 applyDecision 同一条
 * 纪律（规格 §6.3）。多个到期卡是多次独立的 `w.node()` 调用，
 * 一张坏了不拖累整批（心跳 job 的 onError 会报它）。
 */
import type { DatabaseSync } from "node:sqlite";
import {
  approvalRequiredEvent,
  insertCard,
  type NewCardDraft,
} from "../approvals/cards.js";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import {
  assertParamCount,
  assertSingleStatement,
  type Writer,
} from "../db/write-queue.js";
import type { DomainEvent } from "../events/bus.js";
import { appendAudit } from "../events/recorder.js";

/** 超时执行的审计演员：机器决定，绝不署 human（0026 §2 / O10 验收第 3 条）。 */
export const TIMEOUT_ACTOR = {
  actorType: "system" as const,
  actorId: "timeout-executor",
} as const;

/**
 * 超时执行的认领：只认【还没被决定】的卡。`status = 'pending'` 那半条
 * 与 CLAIM_APPROVAL_SQL 同源 —— 谁先写谁赢；超时器输给 CEO 的并发点击时
 * changes === 0，什么都不写。
 */
export const CLAIM_TIMEOUT_SQL =
  "UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? " +
  "WHERE id = ? AND status = ?";

/**
 * 一张到期待处理的卡。选出来的形状只带执行需要的列。
 */
export interface DueApproval {
  readonly id: string;
  readonly taskId: string | null;
  readonly timeoutBehavior: string | null;
}

export const DUE_APPROVALS_SQL =
  "SELECT id, task_id, timeout_behavior FROM approvals " +
  "WHERE status = 'pending' AND timeout_at IS NOT NULL AND timeout_at <= ?";

/**
 * 纯读：列出所有到期未决的卡。**不写库** —— 写走 w.node()。
 */
export function dueApprovals(db: DatabaseSync, nowMs: number): DueApproval[] {
  assertSingleStatement(DUE_APPROVALS_SQL);
  const rows = db.prepare(DUE_APPROVALS_SQL).all(nowMs) as Array<{
    id: string;
    task_id: string | null;
    timeout_behavior: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    timeoutBehavior: r.timeout_behavior,
  }));
}

export interface TimeoutPassOutcome {
  readonly handled: number;
  /** 每种行为各处理了几张，审计/日志用。全部三种都必须在键里（枚举完整性）。 */
  readonly byBehavior: Record<string, number>;
  /** 行为取值非法（旁路数据）的卡。它不该被判成什么都不做。 */
  readonly skippedInvalid: number;
}

/**
 * 扫描 + 执行一趟超时处理。
 *
 * @param w 写队列（单写者）。所有写走它 —— 与 applyDecision 同一条 P1 教训。
 * @param readDb 只读连接（扫描用）。用只读连接跑 SELECT，不参与写队列。
 * @param nowMs 注入时钟。
 * @param publish 每张被处理的卡发一条事件（提交之后），与 applyDecision 同形状。
 */
export async function runTimeoutPass(
  w: Writer,
  readDb: DatabaseSync,
  nowMs: number,
  publish: (e: DomainEvent, seq: number) => void = () => {},
): Promise<TimeoutPassOutcome> {
  const due = dueApprovals(readDb, nowMs);
  let handled = 0;
  let skippedInvalid = 0;
  const byBehavior: Record<string, number> = {};
  for (const card of due) {
    const wrote = await processCard(card, w, nowMs);
    if (wrote === null) continue;
    const b = card.timeoutBehavior ?? "invalid";
    // 行为取值非法的卡：单独数，不进 handled（它不是「被处理了」）。
    if (wrote.skipped) {
      skippedInvalid += 1;
      continue;
    }
    handled += 1;
    if (b !== "invalid") byBehavior[b] = (byBehavior[b] ?? 0) + 1;
    if (wrote.event !== null) publish(wrote.event, wrote.seq);
  }
  return { handled, byBehavior, skippedInvalid };
}

/**
 * 处理一张到期卡。
 *
 * `skipped` 区分两种「不处理」：(a) 行为取值非法 —— 数进 skippedInvalid，
 * 让它显眼而不是被静默成「什么都没做」；(b) 并发被抢 / 无法升级 ——
 * 那不是超时器的错，不数。返回 null 只表示「没抢到，什么都不该记」。
 */
async function processCard(
  card: DueApproval,
  w: Writer,
  nowMs: number,
): Promise<{
  event: DomainEvent | null;
  seq: number;
  skipped: boolean;
} | null> {
  const b = card.timeoutBehavior;
  if (b !== "auto_reject" && b !== "auto_approve" && b !== "escalate") {
    return { event: null, seq: 0, skipped: true };
  }
  return w.node(async () => {
    const db = requireScopeDb("runTimeoutPass." + card.id);
    if (b === "escalate") return applyEscalate(db, card, nowMs);
    return applyMachineDecision(db, card, b, nowMs);
  });
}

/**
 * auto_reject / auto_approve 的共同形状：条件 UPDATE + 一条 system 审计。
 *
 * 返回 null = 没抢到（并发已被决定）。注意顺序【先 UPDATE 后 appendAudit】，
 * 与 applyDecision 同一条：抢不到就不写审计（写审计而 UPDATE 失败 = 一条假的
 * 决策历史）。`changes === 0` 时审计【绝】不发 —— 那正是「那份决定不是我的」的分界。
 */
async function applyMachineDecision(
  db: DatabaseSync,
  card: DueApproval,
  behavior: "auto_reject" | "auto_approve",
  nowMs: number,
): Promise<{
  event: DomainEvent | null;
  seq: number;
  skipped: boolean;
} | null> {
  const status = behavior === "auto_reject" ? "rejected" : "approved";
  const params: unknown[] = [
    status,
    TIMEOUT_ACTOR.actorId,
    nowMs,
    card.id,
    "pending",
  ];
  assertSingleStatement(CLAIM_TIMEOUT_SQL);
  assertParamCount(CLAIM_TIMEOUT_SQL, params);
  const info = db.prepare(CLAIM_TIMEOUT_SQL).run(...(params as never[])) as {
    changes: number | bigint;
  };
  if (Number(info.changes) === 0) return null;

  const seq = appendAudit(
    db,
    {
      taskId: card.taskId ?? "",
      actorType: TIMEOUT_ACTOR.actorType,
      actorId: TIMEOUT_ACTOR.actorId,
      action: "approval",
      target: card.id,
      payload: {
        approvalId: card.id,
        timeout: true,
        timeoutBehavior: behavior,
      },
      createdAt: nowMs,
    },
    () => nowMs,
  );
  return {
    event: {
      kind: "ApprovalDecided",
      taskId: card.taskId ?? "",
      interruptId: card.id,
      decision: status,
    },
    seq,
    skipped: false,
  };
}

/**
 * escalate：对到期卡【新建一张 escalation 卡】。
 *
 * 为什么不是改原卡：「escalate」的语义是「这个决定需要更高的关注/更久的时间」，
 * 而 approvals.status 没有 'escalated' 值（0001 的枚举：pending/approved/rejected/deferred）。
 * 正确的界面形状是收件箱里【新出现一张 escalation 卡】（0026 §3：升级到哪一级、
 * 是否开会，交给会议机制，Phase 3），原卡保持 pending。
 *
 * 卡片自己造（不调 decideEscalation）：超时升级**【不是】**六条 EscalationReason
 * 里的任何一条，而是「这张卡等太久没人批」这个第七种触发 —— 让 reason
 * 进 parameters.escalation.reason（query.ts 的 escalationReasonOf 读的就是它），
 * 统计「因为什么升上来」时它占一格，不假装来源是那六条之一。
 * card_key 带到期卡 id ⇒ 同一张到期卡只会建出一张升级卡（partial unique index）。
 *
 * 写走 insertCard + appendAudit（本函数在 w.node 的事务作用域里被调，
 * createCard 会再开一个队列节点 —— 嵌套是静默复用，直接失败更安全；
 * cards.ts 文件头为「超步内部调用方」记的正是同一条）。
 * 事件走 approvalRequiredEvent ——「有一张新卡等着批」，
 * 不是「有人的决定落了地」，与建卡那条同源。
 *
 * 返回 `{skipped:false, event, seq}`：建过卡。
 * 返回 null：任务不存在 / 升级卡已存在（撞 card_key 去重键）——
 * 那两种都不是升级器的错，不该数进 handled，也【不发 ApprovalRequired】。
 * （与 applyMachineDecision 的 changes===0 同一个分界：没抢到 = 不是我的。）
 */
async function applyEscalate(
  db: DatabaseSync,
  card: DueApproval,
  nowMs: number,
): Promise<{
  event: DomainEvent | null;
  seq: number;
  skipped: boolean;
} | null> {
  if (card.taskId === null) return null;
  const taskRow = db
    .prepare("SELECT status FROM tasks WHERE id = ?")
    .get(card.taskId) as { status: string } | undefined;
  if (taskRow === undefined) return null;

  const draft: NewCardDraft = {
    taskId: card.taskId,
    approvalType: "escalation",
    cardKey: "timeout-escalate:" + card.id,
    summary:
      "审批卡片 " +
      card.id +
      "（任务 " +
      card.taskId +
      "）超时未决，升级请重新裁定",
    parameters: {
      impact_scope: "审批卡片 " + card.id + "（任务 " + card.taskId + "）超时",
      irreversible: false,
      recommendation: "推荐：重新看一眼，或明确打回（推荐，非决定）",
      recommendation_is_not_decision: true,
      timeout_behavior: "escalate",
    },
    evidence_refs: ["task:" + card.taskId + "/evidence"],
    buttons: ["approve", "reject_with_comment", "defer_deep_review"],
    escalation: {
      // 超时升级不是六条 EscalationReason 之一，是第七种触发。不假装来源是那六条。
      reason: "timeout-escalation",
      also: ["timeout"],
    },
  };

  const result = insertCard(db, draft, { nowMs });
  // 撞 card_key 去重键 = 这张到期卡已经有一张升级卡，不是这次的新卡。
  // 与 applyMachineDecision 的 changes===0 同一个分界：没抢到就不写、不发事件。
  if (!result.created) return null;
  const event = approvalRequiredEvent(
    draft.taskId,
    result.approvalId,
    draft,
    draft.approvalType,
  );
  const seq = appendAudit(
    db,
    {
      taskId: draft.taskId,
      // 演员是 system 不是 human：升级卡是机器提出的一次请求，不是人的决定。
      // 与 createCard（cards.ts）同一条署名纪律。
      actorType: TIMEOUT_ACTOR.actorType,
      actorId: TIMEOUT_ACTOR.actorId,
      action: "approval",
      target: result.approvalId,
      payload: event.payload,
    },
    () => nowMs,
  );
  return { event, seq, skipped: false };
}
