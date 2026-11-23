/** 底层治理：可复算的审计抽样与会议结论下一步规划；不直接操作界面。 */
import type { DatabaseSync } from "node:sqlite";
import type { MeetingView } from "@opc/contracts";
import { assertParamCount, assertSingleStatement } from "../db/write-queue.js";
import { needsBossDecision } from "../dispatch/co.js";

export type GovernancePlan = {
  readonly action: "backlog" | "escalate" | "hold";
  readonly ownerMemberId: string | null;
  readonly deadlineAt: number | null;
  readonly reason: string;
};

/** 会议结论先过老板保留职权，再进入 backlog；取消/未散会永远 hold。 */
export function planMeetingConclusion(meeting: MeetingView): GovernancePlan {
  if (meeting.status === "cancelled") {
    return {
      action: "hold",
      ownerMemberId: null,
      deadlineAt: null,
      reason: "会议已取消，不产生下一步。",
    };
  }
  if (meeting.status !== "concluded") {
    return {
      action: "hold",
      ownerMemberId: null,
      deadlineAt: null,
      reason: "会议尚未形成结论三件套。",
    };
  }
  if (
    meeting.decision === null ||
    meeting.owner_member_id === null ||
    meeting.deadline_at === null
  ) {
    return {
      action: "hold",
      ownerMemberId: null,
      deadlineAt: null,
      reason: "结论三件套不完整，拒绝进入执行线。",
    };
  }
  if (needsBossDecision(meeting.decision)) {
    return {
      action: "escalate",
      ownerMemberId: meeting.owner_member_id,
      deadlineAt: meeting.deadline_at,
      reason: "结论涉及资金/边界/战略保留职权，需老板授权后再进 backlog。",
    };
  }
  return {
    action: "backlog",
    ownerMemberId: meeting.owner_member_id,
    deadlineAt: meeting.deadline_at,
    reason: "结论三件套完整且未越权，可作为 backlog 输入。",
  };
}

export type AuditSampleRow = {
  readonly id: number;
  readonly action: string;
  readonly target: string | null;
  readonly payload: unknown;
  readonly createdAt: number;
};

export type AuditSample = {
  readonly rows: AuditSampleRow[];
  readonly anomalies: { readonly id: number; readonly reason: string }[];
};

/** 确定性抽样：id 对 modulus 取余，避免每次抽查随机换一批而无法复算。 */
export function sampleAudit(
  db: Pick<DatabaseSync, "prepare">,
  options: {
    readonly modulus?: number;
    readonly limit?: number;
    readonly afterId?: number;
  } = {},
): AuditSample {
  const modulus = options.modulus ?? 7;
  const limit = options.limit ?? 50;
  const afterId = options.afterId ?? 0;
  if (!Number.isSafeInteger(modulus) || modulus < 1 || modulus > 10_000) {
    throw new Error("governance/sampleAudit：modulus 必须是 1..10000 的整数。");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("governance/sampleAudit：limit 必须是 1..500 的整数。");
  }
  if (!Number.isSafeInteger(afterId) || afterId < 0) {
    throw new Error("governance/sampleAudit：afterId 必须是非负整数。");
  }
  const sql =
    "SELECT id, action, target, payload, created_at FROM events" +
    " WHERE id > ? AND id % ? = 0 ORDER BY id ASC LIMIT ?";
  const params: unknown[] = [afterId, modulus, limit];
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  const raw = db.prepare(sql).all(...(params as never[])) as unknown as Record<
    string,
    unknown
  >[];
  const rows: AuditSampleRow[] = [];
  const anomalies: { id: number; reason: string }[] = [];
  for (const row of raw) {
    const id = row["id"];
    if (typeof id !== "number")
      throw new Error("governance/sampleAudit：events.id 不是数字。");
    let payload: unknown;
    try {
      payload = JSON.parse(String(row["payload"]));
    } catch (error) {
      anomalies.push({
        id,
        reason:
          "payload 不是合法 JSON：" +
          (error instanceof Error ? error.message : String(error)),
      });
      continue;
    }
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload)
    ) {
      anomalies.push({ id, reason: "payload 必须是对象。" });
      continue;
    }
    if (
      !("kind" in payload) ||
      typeof payload.kind !== "string" ||
      payload.kind.length === 0
    ) {
      anomalies.push({ id, reason: "payload.kind 必须是非空字符串。" });
      continue;
    }
    rows.push({
      id,
      action: String(row["action"]),
      target: typeof row["target"] === "string" ? row["target"] : null,
      payload,
      createdAt: Number(row["created_at"]),
    });
  }
  return { rows, anomalies };
}
