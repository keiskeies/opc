/**
 * 真实会议服务（T7）：开场、逐回合推进、结论三件套与取消。
 *
 * 写面只开一个 w.node：会议状态、逐字稿、群内会议卡片与审计同生共死；
 * 广播留在提交之后，投递失败只写 broadcastError，不改写已提交的事实。
 * 群会话可能缺行，ensureGroupConversation 是异步节点，故在写节点外先补建。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import {
  CEO_ROLE_ID,
  cancelMeetingRequestSchema,
  concludeMeetingRequestSchema,
  createMeetingRequestSchema,
  type MeetingTurnView,
  type MeetingView,
  meetingTurnViewSchema,
  meetingViewSchema,
  postTurnRequestSchema,
} from "@opc/contracts";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import {
  ensureGroupConversation,
  insertCardMessage,
} from "../conversations/service.js";
import {
  assertParamCount,
  assertSingleStatement,
  type Writer,
} from "../db/write-queue.js";
import type { DomainEvent, EventBus } from "../events/bus.js";
import { appendAudit } from "../events/recorder.js";

export type MeetingServiceCode =
  | "meeting_not_found"
  | "group_not_found"
  | "member_not_found"
  | "not_participant"
  | "member_archived"
  | "bad_body"
  | "meeting_closed"
  | "not_your_turn"
  | "invalid_next_speaker"
  | "no_turn"
  | "not_writable";

export type MeetingServiceError = {
  readonly ok: false;
  readonly code: MeetingServiceCode;
  readonly reason: string;
};

export function meetingServiceStatus(code: MeetingServiceCode): number {
  switch (code) {
    case "meeting_not_found":
    case "group_not_found":
    case "member_not_found":
      return 404;
    case "not_writable":
      return 500;
    case "meeting_closed":
    case "not_your_turn":
      return 409;
    default:
      return 422;
  }
}

function err(code: MeetingServiceCode, reason: string): MeetingServiceError {
  return { ok: false, code, reason };
}

type DbLike = Pick<DatabaseSync, "prepare">;
type SqlRow = Record<string, SQLOutputValue>;

type MeetingWriteSuccess = {
  readonly ok: true;
  readonly meeting: MeetingView;
  readonly auditSeq: number;
  readonly broadcastError?: string;
};

export type CreateMeetingResult =
  | (MeetingWriteSuccess & { readonly card_message_id: string })
  | MeetingServiceError;

export type PostTurnResult =
  | (MeetingWriteSuccess & { readonly turn: MeetingTurnView })
  | MeetingServiceError;

export type ConcludeMeetingResult = MeetingWriteSuccess | MeetingServiceError;
export type CancelMeetingResult = MeetingWriteSuccess | MeetingServiceError;

type CreateMeetingWrote = MeetingWriteSuccess & {
  readonly card_message_id: string;
};
type PostTurnWrote = MeetingWriteSuccess & { readonly turn: MeetingTurnView };

const MEETING_ACTOR = { actorType: "human", actorId: CEO_ROLE_ID } as const;

const MEETING_COLUMNS =
  "id AS meeting_id, group_id, task_id, meeting_type, topic," +
  " moderator_member_id, speaking_order_json, status, decision," +
  " owner_member_id, deadline_at, summary_doc_id, opened_at," +
  " concluded_at, next_speaker_member_id";

const MEETING_ONE_SQL = `SELECT ${MEETING_COLUMNS} FROM meetings WHERE id = ?`;
const MEETINGS_ALL_SQL =
  `SELECT ${MEETING_COLUMNS} FROM meetings` +
  " ORDER BY opened_at DESC, created_at DESC, meeting_id";
const MEETINGS_GROUP_SQL =
  `SELECT ${MEETING_COLUMNS} FROM meetings WHERE group_id = ?` +
  " ORDER BY opened_at DESC, created_at DESC, meeting_id";
const TURNS_SQL =
  "SELECT turn_id, meeting_id, speaker_member_id, content, turn_seq, created_at" +
  " FROM meeting_turns WHERE meeting_id = ? ORDER BY turn_seq ASC";
const TURN_ONE_SQL =
  "SELECT turn_id, meeting_id, speaker_member_id, content, turn_seq, created_at" +
  " FROM meeting_turns WHERE meeting_id = ? AND turn_seq = ?";
const MAX_TURN_SEQ_SQL =
  "SELECT COALESCE(MAX(turn_seq), 0) + 1 AS next_seq" +
  " FROM meeting_turns WHERE meeting_id = ?";

const INSERT_MEETING_SQL =
  "INSERT INTO meetings (id, task_id, meeting_type, participants, created_at," +
  " group_id, moderator_member_id, speaking_order_json, status, topic," +
  " opened_at, next_speaker_member_id)" +
  " VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)";
const INSERT_TURN_SQL =
  "INSERT INTO meeting_turns (meeting_id, speaker_member_id, content, turn_seq, created_at)" +
  " VALUES (?, ?, ?, ?, ?)";
const UPDATE_NEXT_SQL =
  "UPDATE meetings SET next_speaker_member_id = ? WHERE id = ? AND status = 'open'";
const CONCLUDE_SQL =
  "UPDATE meetings SET decision = ?, owner_member_id = ?, deadline_at = ?," +
  " status = 'concluded', concluded_at = ?, next_speaker_member_id = NULL" +
  " WHERE id = ? AND status = 'open'";
const CANCEL_SQL =
  "UPDATE meetings SET status = 'cancelled', concluded_at = ?," +
  " next_speaker_member_id = NULL WHERE id = ? AND status = 'open'";

const GROUP_EXISTS_SQL = "SELECT 1 AS hit FROM groups WHERE group_id = ?";
const MEMBER_STATUS_SQL = "SELECT status FROM members WHERE member_id = ?";
const GROUP_SEAT_SQL =
  "SELECT 1 AS hit FROM group_members WHERE group_id = ? AND member_id = ?";

/** 所有 SQL 都经单语句与占位符自检；参数只用 SQLite 原生输入类型。 */
function one(
  db: DbLike,
  sql: string,
  params: SQLInputValue[],
): SqlRow | undefined {
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  return db.prepare(sql).get(...params);
}

function all(db: DbLike, sql: string, params: SQLInputValue[]): SqlRow[] {
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  return db.prepare(sql).all(...params);
}

function run(db: DatabaseSync, sql: string, params: SQLInputValue[]): number {
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  return Number(db.prepare(sql).run(...params).changes);
}

/** 开场顺序是推进不变量；NULL、空数组、坏 JSON 都按脏数据抛，不静默兜底。 */
function parseSpeakingOrder(raw: unknown, meetingId: string): string[] {
  if (typeof raw !== "string") {
    throw new Error(
      `meetings/service：会议 [${meetingId}] 的 speaking_order_json 不是字符串——库里数据异常。`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `meetings/service：会议 [${meetingId}] 的 speaking_order_json 不是合法 JSON： ` +
        (e instanceof Error ? e.message : String(e)),
    );
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every(
      (value): value is string => typeof value === "string" && value.length > 0,
    )
  ) {
    throw new Error(
      `meetings/service：会议 [${meetingId}] 的 speaking_order_json 必须是非空字符串数组。`,
    );
  }
  return parsed;
}

function parseTurn(row: SqlRow, meetingId: string): MeetingTurnView {
  const parsed = meetingTurnViewSchema.safeParse(row);
  if (!parsed.success) {
    throw new Error(
      `meetings/service：会议 [${meetingId}] 的发言行形状坏： ` +
        parsed.error.issues[0]?.message,
    );
  }
  return parsed.data;
}

function turnsFor(db: DbLike, meetingId: string): MeetingTurnView[] {
  return all(db, TURNS_SQL, [meetingId]).map((row) =>
    parseTurn(row, meetingId),
  );
}

function rowToMeeting(db: DbLike, row: SqlRow): MeetingView {
  const meetingId =
    typeof row["meeting_id"] === "string" ? row["meeting_id"] : "未知";
  const parsed = meetingViewSchema.safeParse({
    meeting_id: row["meeting_id"],
    group_id: row["group_id"],
    task_id: row["task_id"],
    meeting_type: row["meeting_type"],
    topic: row["topic"],
    moderator_member_id: row["moderator_member_id"],
    speaking_order: parseSpeakingOrder(row["speaking_order_json"], meetingId),
    status: row["status"],
    decision: row["decision"],
    owner_member_id: row["owner_member_id"],
    deadline_at: row["deadline_at"],
    summary_doc_id: row["summary_doc_id"],
    next_speaker_member_id: row["next_speaker_member_id"],
    turns: turnsFor(db, meetingId),
    opened_at: row["opened_at"],
    concluded_at: row["concluded_at"],
  });
  if (!parsed.success) {
    throw new Error(
      `meetings/service：会议 [${meetingId}] 行形状坏（meetingViewSchema 不过）： ` +
        parsed.error.issues[0]?.message,
    );
  }
  return parsed.data;
}

function getMeetingRow(db: DbLike, meetingId: string): MeetingView | undefined {
  const row = one(db, MEETING_ONE_SQL, [meetingId]);
  return row === undefined ? undefined : rowToMeeting(db, row);
}

function mustMeeting(db: DbLike, meetingId: string): MeetingView {
  const meeting = getMeetingRow(db, meetingId);
  if (meeting === undefined) {
    throw new Error(
      `meetings/service：会议 [${meetingId}] 刚写入却读不回，事务内不变量被破坏。`,
    );
  }
  return meeting;
}

function requireOpen(meeting: MeetingView): MeetingServiceError | undefined {
  return meeting.status === "open"
    ? undefined
    : err(
        "meeting_closed",
        `会议 [${meeting.meeting_id}] 已${meeting.status === "concluded" ? "散会" : "取消"}，不能再推进。`,
      );
}

/** 成员存在、在职、有群席位是三件事；分开查才能给出准确错误码。 */
function activeGroupMember(
  db: DbLike,
  groupId: string,
  memberId: string,
): MeetingServiceError | undefined {
  const member = one(db, MEMBER_STATUS_SQL, [memberId]);
  if (member === undefined) {
    return err("member_not_found", `成员 [${memberId}] 不存在。`);
  }
  if (member["status"] !== "active") {
    return err(
      "member_archived",
      `成员 [${memberId}] 已归档，不能承接会议新动作。`,
    );
  }
  const seat = one(db, GROUP_SEAT_SQL, [groupId, memberId]);
  return seat === undefined
    ? err(
        "not_participant",
        `成员 [${memberId}] 不在群 [${groupId}] 的席位里。`,
      )
    : undefined;
}

function requireMeetingGroup(
  meeting: MeetingView,
): string | MeetingServiceError {
  if (meeting.group_id === null) {
    return err(
      "not_writable",
      `会议 [${meeting.meeting_id}] 没有 group_id，无法校验参与者；库里数据异常。`,
    );
  }
  return meeting.group_id;
}

function requireParticipant(
  db: DbLike,
  meeting: MeetingView,
  memberId: string,
): MeetingServiceError | undefined {
  const groupId = requireMeetingGroup(meeting);
  if (typeof groupId !== "string") return groupId;
  return activeGroupMember(db, groupId, memberId);
}

function appendMeetingAudit(
  db: DatabaseSync,
  o: {
    readonly meeting: MeetingView;
    readonly kind:
      | "meeting_opened"
      | "meeting_turn_posted"
      | "meeting_concluded"
      | "meeting_cancelled";
    readonly payload: Record<string, unknown>;
    readonly nowMs: number;
    readonly actorId?: string;
  },
): number {
  return appendAudit(
    db,
    {
      taskId: o.meeting.task_id,
      actorType: o.actorId === undefined ? MEETING_ACTOR.actorType : "agent",
      actorId: o.actorId ?? MEETING_ACTOR.actorId,
      action: "meeting",
      target: o.meeting.meeting_id,
      payload: {
        kind: o.kind,
        meeting_id: o.meeting.meeting_id,
        group_id: o.meeting.group_id,
        ...o.payload,
      },
      createdAt: o.nowMs,
    },
    () => o.nowMs,
  );
}

/** 提交后投递；失败是投影问题，不能翻成写失败。 */
function publish(
  bus: EventBus,
  event: DomainEvent,
  auditSeq: number,
): string | undefined {
  try {
    bus.publishPersisted(event, auditSeq);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function withBroadcastError<T extends MeetingWriteSuccess>(
  result: T,
  broadcastError: string | undefined,
): T & { readonly broadcastError?: string } {
  return broadcastError === undefined ? result : { ...result, broadcastError };
}

export function listMeetings(db: DbLike, groupId?: string): MeetingView[] {
  const rows =
    groupId === undefined
      ? all(db, MEETINGS_ALL_SQL, [])
      : all(db, MEETINGS_GROUP_SQL, [groupId]);
  return rows.map((row) => rowToMeeting(db, row));
}

export function getMeeting(
  db: DbLike,
  meetingId: string,
): MeetingView | undefined {
  const row = one(db, MEETING_ONE_SQL, [meetingId]);
  return row === undefined ? undefined : rowToMeeting(db, row);
}

export async function createMeeting(
  w: Writer,
  bus: EventBus,
  o: {
    readonly req: unknown;
    readonly nowMs: number;
    readonly newId?: () => string;
  },
): Promise<CreateMeetingResult> {
  const parsed = createMeetingRequestSchema.safeParse(o.req);
  if (!parsed.success) {
    return err(
      "bad_body",
      `开场请求不合契约： ${parsed.error.issues[0]?.message}`,
    );
  }
  const req = parsed.data;
  const speakingOrder = [
    ...new Set(req.speaking_order ?? [req.moderator_member_id]),
  ];
  if (speakingOrder.length === 0) {
    return err(
      "bad_body",
      "speaking_order 去重后不能为空，会议必须有首位发言人。",
    );
  }
  const participants = [
    req.moderator_member_id,
    ...speakingOrder.filter((id) => id !== req.moderator_member_id),
  ];

  // 先校验群与参与者，再补建群会话。否则「坏请求」也会顺手留下一条修复行，
  // 拒绝看似没写会议，实际却已经改了会话容器——用户修完姓名再试会看到多余的修复痕迹。
  const preflight = await w.node((): MeetingServiceError | null => {
    const db = requireScopeDb("createMeeting.preflight");
    if (one(db, GROUP_EXISTS_SQL, [req.group_id]) === undefined) {
      return err("group_not_found", `群 [${req.group_id}] 不存在，整单未写。`);
    }
    for (const memberId of participants) {
      const invalid = activeGroupMember(db, req.group_id, memberId);
      if (invalid !== undefined) return invalid;
    }
    return null;
  });
  if (preflight !== null) return preflight;

  // 补建群会话是独立异步节点，绝不能嵌进下面的写节点。
  const conversation = await ensureGroupConversation(w, {
    groupId: req.group_id,
    nowMs: o.nowMs,
    ...(o.newId === undefined ? {} : { newId: o.newId }),
  });
  if (!conversation.ok) {
    return err(
      conversation.code === "group_not_found"
        ? "group_not_found"
        : "not_writable",
      conversation.reason,
    );
  }

  const wrote = await w.node((): CreateMeetingWrote | MeetingServiceError => {
    const db = requireScopeDb("createMeeting");
    if (one(db, GROUP_EXISTS_SQL, [req.group_id]) === undefined) {
      return err("group_not_found", `群 [${req.group_id}] 不存在，整单未写。`);
    }
    for (const memberId of participants) {
      const invalid = activeGroupMember(db, req.group_id, memberId);
      if (invalid !== undefined) return invalid;
    }
    const meetingId = o.newId?.() ?? randomUUID();
    const params: SQLInputValue[] = [
      meetingId,
      req.task_id ?? null,
      req.meeting_type,
      JSON.stringify(participants),
      o.nowMs,
      req.group_id,
      req.moderator_member_id,
      JSON.stringify(speakingOrder),
      req.topic,
      o.nowMs,
      speakingOrder[0] ?? null,
    ];
    if (run(db, INSERT_MEETING_SQL, params) !== 1) {
      throw new Error("meetings/service：会议 INSERT 未落一行，整单回滚。");
    }
    const card = insertCardMessage({
      conversationId: conversation.conversation.conversation_id,
      kind: "meeting_card",
      refId: meetingId,
      body: `会议：${req.topic}\n主持人：${req.moderator_member_id}`,
      nowMs: o.nowMs,
      ...(o.newId === undefined ? {} : { newId: o.newId }),
    });
    const meeting = mustMeeting(db, meetingId);
    const auditSeq = appendMeetingAudit(db, {
      meeting,
      kind: "meeting_opened",
      payload: { card_message_id: card.message_id },
      nowMs: o.nowMs,
    });
    return { ok: true, meeting, card_message_id: card.message_id, auditSeq };
  });
  if (!wrote.ok) return wrote;
  const broadcastError = publish(
    bus,
    {
      kind: "MeetingOpened",
      meetingId: wrote.meeting.meeting_id,
      groupId: req.group_id,
    },
    wrote.auditSeq,
  );
  return withBroadcastError(wrote, broadcastError);
}

/** 省略下一发言人时按开场顺序环绕；主持临场指定可偏离该顺序。 */
function advanceSpeaker(meeting: MeetingView, current: string): string | null {
  const index = meeting.speaking_order.indexOf(current);
  if (index < 0) return meeting.moderator_member_id;
  return (
    meeting.speaking_order[(index + 1) % meeting.speaking_order.length] ??
    meeting.moderator_member_id
  );
}

export async function postTurn(
  w: Writer,
  bus: EventBus,
  o: {
    readonly meetingId: string;
    readonly req: unknown;
    readonly nowMs: number;
    readonly newId?: () => string;
  },
): Promise<PostTurnResult> {
  const parsed = postTurnRequestSchema.safeParse(o.req);
  if (!parsed.success) {
    return err(
      "bad_body",
      `发言请求不合契约： ${parsed.error.issues[0]?.message}`,
    );
  }
  const req = parsed.data;
  const wrote = await w.node((): PostTurnWrote | MeetingServiceError => {
    const db = requireScopeDb("postTurn");
    const before = getMeetingRow(db, o.meetingId);
    if (before === undefined) {
      return err(
        "meeting_not_found",
        `会议 [${o.meetingId}] 不存在，发言未写。`,
      );
    }
    const closed = requireOpen(before);
    if (closed !== undefined) return closed;
    if (before.next_speaker_member_id === null) {
      return err("no_turn", `会议 [${o.meetingId}] 当前没有发言轮次。`);
    }
    if (before.next_speaker_member_id !== req.speaker_member_id) {
      return err(
        "not_your_turn",
        `当前轮到 [${before.next_speaker_member_id}]，不是 [${req.speaker_member_id}]。`,
      );
    }
    const invalidSpeaker = requireParticipant(
      db,
      before,
      req.speaker_member_id,
    );
    if (invalidSpeaker !== undefined) return invalidSpeaker;

    let nextSpeaker: string | null | MeetingServiceError;
    if (req.next_speaker_member_id !== undefined) {
      if (req.next_speaker_member_id === req.speaker_member_id) {
        return err("invalid_next_speaker", "下一发言人不能是刚发言的本人。");
      }
      const invalidNext = requireParticipant(
        db,
        before,
        req.next_speaker_member_id,
      );
      nextSpeaker =
        invalidNext === undefined
          ? req.next_speaker_member_id
          : err("invalid_next_speaker", invalidNext.reason);
    } else {
      nextSpeaker = advanceSpeaker(before, req.speaker_member_id);
    }
    if (nextSpeaker !== null && typeof nextSpeaker !== "string") {
      return nextSpeaker;
    }
    if (nextSpeaker === null) {
      return err("no_turn", "既定顺序与主持人均无法给出下一发言人。");
    }

    const seqRow = one(db, MAX_TURN_SEQ_SQL, [o.meetingId]);
    const turnSeq = seqRow?.["next_seq"];
    if (typeof turnSeq !== "number") {
      throw new Error("meetings/service：取不到下一 turn_seq，整单回滚。");
    }
    if (
      run(db, INSERT_TURN_SQL, [
        o.meetingId,
        req.speaker_member_id,
        req.content,
        turnSeq,
        o.nowMs,
      ]) !== 1
    ) {
      throw new Error("meetings/service：发言 INSERT 未落一行，整单回滚。");
    }
    if (run(db, UPDATE_NEXT_SQL, [nextSpeaker, o.meetingId]) !== 1) {
      throw new Error("meetings/service：下一发言人 UPDATE 未命中，整单回滚。");
    }
    const turnRow = one(db, TURN_ONE_SQL, [o.meetingId, turnSeq]);
    if (turnRow === undefined) {
      throw new Error("meetings/service：刚写入的发言读不回，整单回滚。");
    }
    const turn = parseTurn(turnRow, o.meetingId);
    const meeting = mustMeeting(db, o.meetingId);
    const auditSeq = appendMeetingAudit(db, {
      meeting,
      kind: "meeting_turn_posted",
      actorId: req.speaker_member_id,
      payload: {
        turn_id: turn.turn_id,
        speaker_member_id: req.speaker_member_id,
        turn_seq: turn.turn_seq,
        next_speaker_member_id: nextSpeaker,
      },
      nowMs: o.nowMs,
    });
    return { ok: true, meeting, turn, auditSeq };
  });
  if (!wrote.ok) return wrote;
  const broadcastError = publish(
    bus,
    {
      kind: "MeetingTurnPosted",
      meetingId: o.meetingId,
      turnSeq: wrote.turn.turn_seq,
    },
    wrote.auditSeq,
  );
  return withBroadcastError(wrote, broadcastError);
}

export async function concludeMeeting(
  w: Writer,
  bus: EventBus,
  o: {
    readonly meetingId: string;
    readonly req: unknown;
    readonly nowMs: number;
  },
): Promise<ConcludeMeetingResult> {
  const parsed = concludeMeetingRequestSchema.safeParse(o.req);
  if (!parsed.success) {
    return err(
      "bad_body",
      `散会请求不合契约： ${parsed.error.issues[0]?.message}`,
    );
  }
  const req = parsed.data;
  const wrote = await w.node((): MeetingWriteSuccess | MeetingServiceError => {
    const db = requireScopeDb("concludeMeeting");
    const before = getMeetingRow(db, o.meetingId);
    if (before === undefined) {
      return err("meeting_not_found", `会议 [${o.meetingId}] 不存在，未散会。`);
    }
    const closed = requireOpen(before);
    if (closed !== undefined) return closed;
    const invalidOwner = requireParticipant(db, before, req.owner_member_id);
    if (invalidOwner !== undefined) return invalidOwner;
    if (
      run(db, CONCLUDE_SQL, [
        req.decision,
        req.owner_member_id,
        req.deadline_at,
        o.nowMs,
        o.meetingId,
      ]) !== 1
    ) {
      throw new Error("meetings/service：散会 UPDATE 未命中，整单回滚。");
    }
    const meeting = mustMeeting(db, o.meetingId);
    const auditSeq = appendMeetingAudit(db, {
      meeting,
      kind: "meeting_concluded",
      payload: {
        decision: req.decision,
        owner_member_id: req.owner_member_id,
        deadline_at: req.deadline_at,
      },
      nowMs: o.nowMs,
    });
    return { ok: true, meeting, auditSeq };
  });
  if (!wrote.ok) return wrote;
  const broadcastError = publish(
    bus,
    { kind: "MeetingConcluded", meetingId: o.meetingId, summaryDocId: null },
    wrote.auditSeq,
  );
  return withBroadcastError(wrote, broadcastError);
}

export async function cancelMeeting(
  w: Writer,
  bus: EventBus,
  o: {
    readonly meetingId: string;
    readonly req: unknown;
    readonly nowMs: number;
  },
): Promise<CancelMeetingResult> {
  const parsed = cancelMeetingRequestSchema.safeParse(o.req);
  if (!parsed.success) {
    return err(
      "bad_body",
      `取消请求不合契约： ${parsed.error.issues[0]?.message}`,
    );
  }
  const req = parsed.data;
  const wrote = await w.node((): MeetingWriteSuccess | MeetingServiceError => {
    const db = requireScopeDb("cancelMeeting");
    const before = getMeetingRow(db, o.meetingId);
    if (before === undefined) {
      return err("meeting_not_found", `会议 [${o.meetingId}] 不存在，未取消。`);
    }
    const closed = requireOpen(before);
    if (closed !== undefined) return closed;
    if (run(db, CANCEL_SQL, [o.nowMs, o.meetingId]) !== 1) {
      throw new Error("meetings/service：取消 UPDATE 未命中，整单回滚。");
    }
    const meeting = mustMeeting(db, o.meetingId);
    const auditSeq = appendMeetingAudit(db, {
      meeting,
      kind: "meeting_cancelled",
      payload: { reason: req.reason },
      nowMs: o.nowMs,
    });
    return { ok: true, meeting, auditSeq };
  });
  if (!wrote.ok) return wrote;
  const broadcastError = publish(
    bus,
    { kind: "MeetingCancelled", meetingId: o.meetingId, reason: req.reason },
    wrote.auditSeq,
  );
  return withBroadcastError(wrote, broadcastError);
}
