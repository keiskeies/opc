/** 群消息 → CoS 规划 → 执行任务 + 群内回话：派发是一件可审计事实。 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type ExecutionOutcome,
  type ExecutionTarget,
  executionOutcomeSchema,
  type ModelTier,
} from "@opc/contracts";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import {
  ensureGroupConversation,
  type SendMessageResult,
  sendMessage,
} from "../conversations/service.js";
import {
  assertParamCount,
  assertSingleStatement,
  type HubWriter,
} from "../db/write-queue.js";
import { depositAutoDocument } from "../documents/deposit.js";
import type { EventBus } from "../events/bus.js";
import { appendAudit } from "../events/recorder.js";
import { type DispatchPlan, planDispatch } from "./co.js";

export type RouteGroupMessageResult =
  | {
      readonly ok: true;
      readonly plan: DispatchPlan;
      readonly message: SendMessageResult | null;
      readonly taskId?: string;
      readonly documentId?: string;
      readonly documentError?: string;
      readonly broadcastError?: string;
      /** 新任务已排入后台执行；false = 因启动数据缺失等原因未能排队。 */
      readonly execution_started?: boolean;
      /** 启动失败原文；执行期失败由成员结果消息与“执行结果”文档承载。 */
      readonly execution_error?: string;
    }
  | {
      readonly ok: false;
      readonly code: "group_not_found" | "cos_missing" | "message_failed";
      readonly reason: string;
      readonly taskId?: string;
    };

export type RoutePrivateInstructionResult =
  | {
      readonly ok: true;
      readonly taskId: string;
      readonly replayed: boolean;
      readonly execution_started: boolean;
      readonly execution_error?: string;
      readonly broadcastError?: string;
    }
  | {
      readonly ok: false;
      readonly code:
        | "conversation_not_found"
        | "invalid_private_conversation"
        | "member_not_participant"
        | "member_not_found"
        | "member_archived"
        | "invalid_member_route";
      readonly reason: string;
    };

type ExecutionReport =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

type ExecutionReportContext = {
  readonly conversationId: string;
  readonly groupId: string | null;
  readonly taskId: string;
  readonly memberId: string;
  readonly roleId: string;
  readonly nowMs: number;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureReport(error: unknown): ExecutionReport {
  return { ok: false, code: "executor_error", message: errorText(error) };
}

/** 执行器回执在落消息/文档前再过一次契约，坏回执也按失败事实落档。 */
function executionReport(outcome: ExecutionOutcome): ExecutionReport {
  const parsed = executionOutcomeSchema.parse(outcome);
  if (parsed.ok && parsed.final?.ok === true) {
    return {
      ok: true,
      text: parsed.final.text === "" ? parsed.final.summary : parsed.final.text,
    };
  }
  if (!parsed.ok && parsed.final?.ok === false) {
    return {
      ok: false,
      code: parsed.final.code,
      message: parsed.final.message,
    };
  }
  throw new Error("执行器回执缺少与 ok 一致的 final。");
}

const MAX_MESSAGE_CHARS = 8000;

function resultMessageText(report: ExecutionReport): string {
  const prefix = report.ok ? "执行完成：" : `执行失败（${report.code}）：`;
  const detail = report.ok ? report.text : report.message;
  const room = MAX_MESSAGE_CHARS - prefix.length;
  return (
    prefix + (detail.length <= room ? detail : detail.slice(0, room - 1) + "…")
  );
}

function resultDocumentText(
  o: {
    readonly groupId: string | null;
    readonly taskId: string;
    readonly memberId: string;
    readonly roleId: string;
  },
  report: ExecutionReport,
): string {
  return [
    "# 执行结果",
    "",
    `- 任务 ID：${o.taskId}`,
    `- 群：${o.groupId ?? "未关联（私聊）"}`,
    `- 执行成员：${o.memberId}`,
    `- 岗位：${o.roleId}`,
    "",
    ...(report.ok
      ? ["## 执行正文", "", report.text]
      : [
          "## 失败原因",
          "",
          `- code：${report.code}`,
          `- message：${report.message}`,
        ]),
  ].join("\n");
}

/** 消息与文档分别兜错：一个写失败不能吞掉另一个，也不能制造未处理 rejection。 */
async function persistExecutionReport(
  w: HubWriter,
  bus: EventBus,
  o: ExecutionReportContext,
  report: ExecutionReport,
): Promise<void> {
  try {
    const message = await sendMessage(w, bus, {
      conversationId: o.conversationId,
      author: { kind: "member", memberId: o.memberId },
      req: { body: resultMessageText(report) },
      nowMs: o.nowMs,
    });
    if (!message.ok) {
      console.error(
        "dispatch/service：执行结果消息未写成：" +
          message.code +
          " " +
          message.reason,
      );
    }
  } catch (error) {
    console.error(
      "dispatch/service：执行结果消息写入抛错：" + errorText(error),
    );
  }
  try {
    const deposited = await depositAutoDocument(w, bus, {
      viewer: { kind: "boss" },
      req: {
        kind: "markdown",
        title: `执行结果：${o.taskId}`,
        body_text: resultDocumentText(o, report),
        ...(o.groupId === null ? {} : { group_id: o.groupId }),
        task_id: o.taskId,
      },
      nowMs: o.nowMs,
    });
    if (!deposited.ok) {
      console.error(
        "dispatch/service：执行结果文档未写成：" +
          deposited.code +
          " " +
          deposited.reason,
      );
    }
  } catch (error) {
    console.error(
      "dispatch/service：执行结果文档写入抛错：" + errorText(error),
    );
  }
}

function launchReport(
  w: HubWriter,
  bus: EventBus,
  o: ExecutionReportContext,
  report: ExecutionReport,
): void {
  void Promise.resolve()
    .then(() => persistExecutionReport(w, bus, o, report))
    .catch((error) => {
      console.error("dispatch/service：后台执行回写抛错：" + errorText(error));
    });
}

function launchExecution(
  w: HubWriter,
  bus: EventBus,
  o: ExecutionReportContext,
  target: ExecutionTarget,
  execute: (target: ExecutionTarget) => Promise<ExecutionOutcome>,
): void {
  // 先让出微任务再调用执行器：同步抛错也进入同一条后台失败回写链。
  void Promise.resolve()
    .then(() => execute(target))
    .then((outcome) => executionReport(outcome))
    .catch((error) => failureReport(error))
    .then((report) => persistExecutionReport(w, bus, o, report))
    .catch((error) => {
      console.error("dispatch/service：后台执行抛错：" + errorText(error));
    });
}

function memberModelTier(db: DatabaseSync, memberId: string): ModelTier {
  const sql = "SELECT model_tier FROM members WHERE member_id = ?";
  const params: unknown[] = [memberId];
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  const row = db.prepare(sql).get(...(params as never[])) as
    | { model_tier: ModelTier }
    | undefined;
  if (row === undefined) throw new Error(`派发成员 [${memberId}] 不存在。`);
  if (row.model_tier !== "management" && row.model_tier !== "execution") {
    throw new Error(`派发成员 [${memberId}] 的 model_tier 非法。`);
  }
  return row.model_tier;
}

type PrivateInstructionMember =
  | {
      readonly ok: true;
      readonly roleId: string;
      readonly modelTier: ModelTier;
    }
  | Extract<RoutePrivateInstructionResult, { readonly ok: false }>;

/** 私聊派发只认真实会话与真实在场成员；角色和模型档位取成员当前档案。 */
function privateInstructionMember(
  db: DatabaseSync,
  conversationId: string,
  memberId: string,
): PrivateInstructionMember {
  const sql =
    "SELECT c.kind, c.group_id, c.member_a, c.member_b, m.status, m.role_id, m.model_tier" +
    " FROM conversations c LEFT JOIN members m ON m.member_id = ?" +
    " WHERE c.conversation_id = ?";
  const params: unknown[] = [memberId, conversationId];
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  const row = db.prepare(sql).get(...(params as never[])) as
    | {
        kind: string;
        group_id: string | null;
        member_a: string | null;
        member_b: string | null;
        status: string | null;
        role_id: string | null;
        model_tier: ModelTier | null;
      }
    | undefined;
  if (row === undefined) {
    return {
      ok: false,
      code: "conversation_not_found",
      reason: `私聊会话 [${conversationId}] 不存在。`,
    };
  }
  if (row.kind !== "private" || row.group_id !== null) {
    return {
      ok: false,
      code: "invalid_private_conversation",
      reason: `会话 [${conversationId}] 不是无群归属的私聊。`,
    };
  }
  const isBossPrivate =
    memberId !== "boss" &&
    ((row.member_a === "boss" && row.member_b === memberId) ||
      (row.member_b === "boss" && row.member_a === memberId));
  if (!isBossPrivate) {
    return {
      ok: false,
      code: "member_not_participant",
      reason: `成员 [${memberId}] 不是老板私聊 [${conversationId}] 的对方。`,
    };
  }
  if (row.status === null || row.role_id === null) {
    return {
      ok: false,
      code: "member_not_found",
      reason: `派发成员 [${memberId}] 不存在。`,
    };
  }
  if (row.status !== "active") {
    return {
      ok: false,
      code: "member_archived",
      reason: `派发成员 [${memberId}] 未在职（status=${row.status}）。`,
    };
  }
  if (
    row.role_id.trim() === "" ||
    (row.model_tier !== "management" && row.model_tier !== "execution")
  ) {
    return {
      ok: false,
      code: "invalid_member_route",
      reason: `派发成员 [${memberId}] 的岗位或模型档位非法。`,
    };
  }
  return { ok: true, roleId: row.role_id, modelTier: row.model_tier };
}

function privateReplayTask(
  db: DatabaseSync,
  replayKey: string,
): string | undefined {
  const sql =
    "SELECT target FROM events WHERE action = 'state_change' AND replay_key = ? LIMIT 1";
  const params: unknown[] = [replayKey];
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  const row = db.prepare(sql).get(...(params as never[])) as
    | { target: string | null }
    | undefined;
  if (row === undefined) return undefined;
  if (row.target === null) {
    throw new Error("dispatch/service：私聊重放审计缺少 task target。");
  }
  return row.target;
}

/**
 * 老板给成员的私聊指令：建一个无群归属的执行任务，并复用群派发的后台执行/回写链。
 * 幂等键只取来源消息，不取成员或正文；同一消息重放不得再建任务或再跑执行器。
 */
export async function routePrivateInstruction(
  w: HubWriter,
  bus: EventBus,
  o: {
    readonly conversationId: string;
    readonly memberId: string;
    readonly text: string;
    readonly sourceMessageId: string;
    readonly nowMs: number;
    readonly execute?: (target: ExecutionTarget) => Promise<ExecutionOutcome>;
    readonly workspace?: string;
  },
): Promise<RoutePrivateInstructionResult> {
  const db = w.readConnection();
  const member = privateInstructionMember(db, o.conversationId, o.memberId);
  if (!member.ok) return member;
  const replayKey = "private:" + o.sourceMessageId;
  const existing = privateReplayTask(db, replayKey);
  if (existing !== undefined) {
    return {
      ok: true,
      taskId: existing,
      replayed: true,
      execution_started: false,
      execution_error: "来源消息已派发，重放未重复建任务或启动执行。",
    };
  }

  const assigned = await w.node(
    ():
      | {
          readonly taskId: string;
          readonly auditSeq: number;
          readonly replayed: false;
        }
      | {
          readonly taskId: string;
          readonly auditSeq: null;
          readonly replayed: true;
        } => {
      const tx = requireScopeDb("dispatch.private.assign");
      // 预检查在事务内再做一次：单写队列串行化后，第二次派发仍必须看见第一次的提交。
      const replayedTask = privateReplayTask(tx, replayKey);
      if (replayedTask !== undefined) {
        return { taskId: replayedTask, auditSeq: null, replayed: true };
      }
      const taskId = "task-" + randomUUID();
      const insertSql =
        "INSERT INTO tasks (id, parent_id, title, status, assigned_role, current_node," +
        " created_at, updated_at) VALUES (?, NULL, ?, 'IN_PROGRESS', ?, 'implement', ?, ?)";
      const insertParams: unknown[] = [
        taskId,
        o.text.trim().slice(0, 200),
        member.roleId,
        o.nowMs,
        o.nowMs,
      ];
      assertSingleStatement(insertSql);
      assertParamCount(insertSql, insertParams);
      tx.prepare(insertSql).run(...(insertParams as never[]));
      const auditSeq = appendAudit(
        tx,
        {
          taskId,
          actorType: "system",
          actorId: "dispatch",
          action: "state_change",
          target: taskId,
          payload: {
            kind: "private_dispatch",
            op: "assign",
            task_id: taskId,
            group_id: null,
            conversation_id: o.conversationId,
            member_id: o.memberId,
            role_id: member.roleId,
            source_message_id: o.sourceMessageId,
          },
          createdAt: o.nowMs,
          replayKey,
        },
        () => o.nowMs,
      );
      return { taskId, auditSeq, replayed: false };
    },
  );

  if (assigned.replayed) {
    return {
      ok: true,
      taskId: assigned.taskId,
      replayed: true,
      execution_started: false,
      execution_error: "来源消息已派发，重放未重复建任务或启动执行。",
    };
  }

  let broadcastError: string | undefined;
  try {
    bus.publishPersisted(
      {
        kind: "DispatchAssigned",
        taskId: assigned.taskId,
        memberId: o.memberId,
        groupId: null,
      },
      assigned.auditSeq,
    );
  } catch (error) {
    broadcastError = errorText(error);
  }

  const reportContext: ExecutionReportContext = {
    conversationId: o.conversationId,
    groupId: null,
    taskId: assigned.taskId,
    memberId: o.memberId,
    roleId: member.roleId,
    nowMs: o.nowMs,
  };
  if (o.execute === undefined) {
    return {
      ok: true,
      taskId: assigned.taskId,
      replayed: false,
      execution_started: false,
      execution_error: "本装配未提供执行器，私聊任务已建立但未执行。",
      ...(broadcastError === undefined ? {} : { broadcastError }),
    };
  }

  try {
    const target: ExecutionTarget = {
      task_id: assigned.taskId,
      member_id: o.memberId,
      role_id: member.roleId,
      model_tier: member.modelTier,
      instruction: o.text,
      role_prompt: "",
      max_budget_usd: 0,
      from_seq: 1,
      ...(o.workspace === undefined ? {} : { workspace: o.workspace }),
    };
    launchExecution(w, bus, reportContext, target, o.execute);
    return {
      ok: true,
      taskId: assigned.taskId,
      replayed: false,
      execution_started: true,
      ...(broadcastError === undefined ? {} : { broadcastError }),
    };
  } catch (error) {
    launchReport(w, bus, reportContext, failureReport(error));
    return {
      ok: true,
      taskId: assigned.taskId,
      replayed: false,
      execution_started: false,
      execution_error: errorText(error),
      ...(broadcastError === undefined ? {} : { broadcastError }),
    };
  }
}

/**
 * 只处理群消息：私聊没有群席位与 CoS，不能冒充群内派发。
 * 需要老板拍板时 CoS 发一条 @老板 的升级消息；有明确派发目标时 @ 目标成员。
 * 没有规则也没有 LLM 兜底时保持沉默，不制造“已派发”的假消息。
 */
export async function routeGroupMessage(
  w: HubWriter,
  bus: EventBus,
  o: {
    readonly groupId: string;
    readonly text: string;
    readonly sourceMessageId?: string;
    readonly nowMs: number;
    readonly newId?: () => string;
    readonly execute?: (target: ExecutionTarget) => Promise<ExecutionOutcome>;
    readonly workspace?: string;
  },
): Promise<RouteGroupMessageResult> {
  const db: DatabaseSync = w.readConnection();
  const sql = "SELECT cos_member_id, task_id FROM groups WHERE group_id = ?";
  const params: unknown[] = [o.groupId];
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  const group = db.prepare(sql).get(...(params as never[])) as
    | { cos_member_id: string | null; task_id: string | null }
    | undefined;
  if (group === undefined) {
    return {
      ok: false,
      code: "group_not_found",
      reason: `群 [${o.groupId}] 不存在。`,
    };
  }
  if (group.cos_member_id === null) {
    return {
      ok: false,
      code: "cos_missing",
      reason: `群 [${o.groupId}] 没有特助，无法升级或派发。`,
    };
  }
  const plan = planDispatch(db, { groupId: o.groupId, text: o.text });
  if (plan.source === "none") return { ok: true, plan, message: null };

  let taskId: string | undefined;
  let documentId: string | undefined;
  let documentError: string | undefined;
  let broadcastError: string | undefined;
  if (plan.source !== "escalate") {
    if (plan.targetMemberId === null || plan.targetRoleId === null) {
      return {
        ok: false,
        code: "message_failed",
        reason: "派发计划没有目标成员或岗位。",
      };
    }
    const replayKey =
      o.sourceMessageId === undefined ? undefined : "cos:" + o.sourceMessageId;
    if (replayKey !== undefined) {
      const existing = db
        .prepare(
          "SELECT target FROM events WHERE action = 'state_change' AND replay_key = ?",
        )
        .get(replayKey) as { target: string | null } | undefined;
      if (existing?.target !== undefined && existing.target !== null) {
        return { ok: true, plan, message: null, taskId: existing.target };
      }
    }
    const assigned = await w.node(() => {
      const tx = requireScopeDb("dispatch.assign");
      const groupSql = "SELECT task_id FROM groups WHERE group_id = ?";
      const groupParams: unknown[] = [o.groupId];
      assertSingleStatement(groupSql);
      assertParamCount(groupSql, groupParams);
      const current = tx.prepare(groupSql).get(...(groupParams as never[])) as
        | { task_id: string | null }
        | undefined;
      if (current === undefined)
        throw new Error("dispatch/service：派发前群消失了。");
      const id = "task-" + randomUUID();
      const insertSql =
        "INSERT INTO tasks (id, parent_id, title, status, assigned_role, current_node," +
        " created_at, updated_at) VALUES (?, ?, ?, 'IN_PROGRESS', ?, 'implement', ?, ?)";
      const insertParams: unknown[] = [
        id,
        current.task_id,
        o.text.trim().slice(0, 200),
        plan.targetRoleId,
        o.nowMs,
        o.nowMs,
      ];
      assertSingleStatement(insertSql);
      assertParamCount(insertSql, insertParams);
      tx.prepare(insertSql).run(...(insertParams as never[]));
      const linkSql =
        "UPDATE groups SET task_id = COALESCE(task_id, ?), updated_at = ? WHERE group_id = ?";
      const linkParams: unknown[] = [id, o.nowMs, o.groupId];
      assertSingleStatement(linkSql);
      assertParamCount(linkSql, linkParams);
      tx.prepare(linkSql).run(...(linkParams as never[]));
      const auditSeq = appendAudit(
        tx,
        {
          taskId: id,
          actorType: "system",
          actorId: "cos",
          action: "state_change",
          target: id,
          payload: {
            kind: "cos_dispatch",
            op: "assign",
            task_id: id,
            group_id: o.groupId,
            member_id: plan.targetMemberId,
            role_id: plan.targetRoleId,
            rule_id: plan.ruleId,
            source_message_id: o.sourceMessageId ?? null,
          },
          createdAt: o.nowMs,
          ...(replayKey === undefined ? {} : { replayKey }),
        },
        () => o.nowMs,
      );
      return { id, auditSeq };
    });
    taskId = assigned.id;
    try {
      bus.publishPersisted(
        {
          kind: "DispatchAssigned",
          taskId,
          memberId: plan.targetMemberId,
          groupId: o.groupId,
        },
        assigned.auditSeq,
      );
    } catch (error) {
      broadcastError = error instanceof Error ? error.message : String(error);
    }
    const deposited = await depositAutoDocument(w, bus, {
      viewer: { kind: "boss" },
      req: {
        kind: "markdown",
        title: `任务拆解：${o.text.trim().slice(0, 80)}`,
        body_text: [
          "# 任务拆解",
          "",
          `- 任务 ID：${taskId}`,
          `- 群：${o.groupId}`,
          `- 负责人：${plan.targetMemberId}`,
          `- 岗位：${plan.targetRoleId}`,
          `- 来源消息：${o.sourceMessageId ?? "未登记"}`,
          "",
          "## 原始指令",
          o.text,
        ].join("\n"),
        group_id: o.groupId,
        task_id: taskId,
      },
      nowMs: o.nowMs,
    });
    if (deposited.ok) documentId = deposited.docId;
    else documentError = deposited.reason;
  }

  const body =
    plan.source === "escalate"
      ? `@老板 这件事需要你拍板：${o.text}`
      : `@${plan.targetMemberId ?? ""} 这件事由你跟进：${o.text}` +
        (taskId === undefined ? "" : `（任务 ${taskId}）`);
  const conversation = await ensureGroupConversation(w, {
    groupId: o.groupId,
    nowMs: o.nowMs,
    ...(o.newId === undefined ? {} : { newId: o.newId }),
  });
  if (!conversation.ok) {
    return {
      ok: false,
      code: "message_failed",
      reason: `CoS 会话不可用：${conversation.code} ${conversation.reason}`,
    };
  }
  const message = await sendMessage(w, bus, {
    conversationId: conversation.conversation.conversation_id,
    author: { kind: "member", memberId: group.cos_member_id },
    req: { body },
    nowMs: o.nowMs,
    ...(o.newId === undefined ? {} : { newId: o.newId }),
  });
  if (!message.ok) {
    return {
      ok: false,
      code: "message_failed",
      reason: `CoS 回话未写成：${message.code} ${message.reason}`,
      ...(taskId === undefined ? {} : { taskId }),
    };
  }
  let executionStarted: boolean | undefined;
  let executionError: string | undefined;
  if (
    o.execute !== undefined &&
    taskId !== undefined &&
    plan.targetMemberId !== null &&
    plan.targetRoleId !== null
  ) {
    const reportContext = {
      conversationId: conversation.conversation.conversation_id,
      groupId: o.groupId,
      taskId,
      memberId: plan.targetMemberId,
      roleId: plan.targetRoleId,
      nowMs: o.nowMs,
    };
    try {
      const target: ExecutionTarget = {
        task_id: taskId,
        member_id: plan.targetMemberId,
        role_id: plan.targetRoleId,
        model_tier: memberModelTier(db, plan.targetMemberId),
        instruction: o.text,
        role_prompt: "",
        max_budget_usd: 0,
        from_seq: 1,
        ...(o.workspace === undefined ? {} : { workspace: o.workspace }),
      };
      launchExecution(w, bus, reportContext, target, o.execute);
      executionStarted = true;
    } catch (error) {
      executionStarted = false;
      executionError = errorText(error);
      launchReport(w, bus, reportContext, failureReport(error));
    }
  }
  return {
    ok: true,
    plan,
    message,
    ...(taskId === undefined ? {} : { taskId }),
    ...(documentId === undefined ? {} : { documentId }),
    ...(documentError === undefined ? {} : { documentError }),
    ...(broadcastError === undefined ? {} : { broadcastError }),
    ...(executionStarted === undefined
      ? {}
      : { execution_started: executionStarted }),
    ...(executionError === undefined
      ? {}
      : { execution_error: executionError }),
  };
}
