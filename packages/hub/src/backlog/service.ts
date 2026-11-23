/**
 * 任务面板服务：读面逐行过契约，写面在一个节点内完成实体变更与审计。
 * 广播留在提交之后；投递失败只报告，不改写已经提交的成功事实。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type BacklogItemView,
  backlogItemViewSchema,
  CEO_ROLE_ID,
  createBacklogRequestSchema,
  listBacklogQuerySchema,
  mergeBacklogRequestSchema,
  moveBacklogRequestSchema,
  reprioritizeBacklogRequestSchema,
  rescheduleBacklogRequestSchema,
  splitBacklogRequestSchema,
} from "@opc/contracts";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import {
  assertParamCount,
  assertSingleStatement,
  type Writer,
} from "../db/write-queue.js";
import type { DomainEvent, EventBus } from "../events/bus.js";
import { appendAudit } from "../events/recorder.js";

export type BacklogServiceCode =
  | "backlog_not_found"
  | "group_not_found"
  | "member_not_found"
  | "not_authorized"
  | "not_participant"
  | "bad_body"
  | "bad_query"
  | "invalid_state"
  | "invalid_target"
  | "not_writable";

export type BacklogServiceError = {
  readonly ok: false;
  readonly code: BacklogServiceCode;
  readonly reason: string;
};

export type BacklogActor =
  | { readonly kind: "boss" }
  | { readonly kind: "member"; readonly memberId: string };

export type BacklogOp = Extract<DomainEvent, { kind: "BacklogChanged" }>["op"];

export type BacklogMutationResult =
  | {
      readonly ok: true;
      readonly item: BacklogItemView;
      readonly auditSeq: number;
      readonly broadcastError?: string;
    }
  | BacklogServiceError;

export type SplitBacklogResult =
  | {
      readonly ok: true;
      readonly parent: BacklogItemView;
      readonly children: BacklogItemView[];
      readonly auditSeq: number;
      readonly broadcastError?: string;
    }
  | BacklogServiceError;

type DbLike = Pick<DatabaseSync, "prepare">;
type WriteOptions = {
  readonly actor: BacklogActor;
  readonly req: unknown;
  readonly nowMs: number;
  readonly newId?: () => string;
};
type Success = { readonly ok: true };

// 契约现有名称是 RequestSchema；本地别名保持调用方指定的校验器名称。
const reprioritizeBacklogSchema = reprioritizeBacklogRequestSchema;

const VIEW_COLS =
  "id, group_id, task_id, title, detail, state, priority, due_at," +
  " parent_id, merged_into, created_at, updated_at";

const ITEM_SQL = `SELECT ${VIEW_COLS} FROM backlog_items WHERE id = ?`;
const LIST_SQL =
  `SELECT ${VIEW_COLS} FROM backlog_items` +
  " WHERE (? IS NULL OR group_id = ?) AND (? IS NULL OR state = ?)" +
  " ORDER BY priority ASC, due_at ASC NULLS LAST, created_at ASC, id ASC LIMIT ?";
const GROUP_EXISTS_SQL = "SELECT 1 AS hit FROM groups WHERE group_id = ?";
const MEMBER_SEAT_SQL =
  "SELECT m.status AS status, gm.seat AS seat, r.category AS category" +
  " FROM members m" +
  " LEFT JOIN group_members gm ON gm.group_id = ? AND gm.member_id = m.member_id" +
  " LEFT JOIN roles r ON r.role_id = gm.role_id" +
  " WHERE m.member_id = ?";
const INSERT_SQL =
  "INSERT INTO backlog_items" +
  " (id, group_id, task_id, title, detail, state, priority, due_at," +
  "  parent_id, merged_into, created_at, updated_at)" +
  " VALUES (?, ?, NULL, ?, ?, 'backlog', ?, ?, ?, NULL, ?, ?)";
const MOVE_SQL =
  "UPDATE backlog_items SET group_id = ?, updated_at = ? WHERE id = ?";
const RESCHEDULE_SQL =
  "UPDATE backlog_items SET due_at = ?, updated_at = ? WHERE id = ?";
const PRIORITY_SQL =
  "UPDATE backlog_items SET priority = ?, updated_at = ? WHERE id = ?";
const CANCEL_SQL =
  "UPDATE backlog_items SET state = 'cancelled', updated_at = ? WHERE id = ?";
const TOUCH_SQL = "UPDATE backlog_items SET updated_at = ? WHERE id = ?";
const MERGE_SQL =
  "UPDATE backlog_items SET state = 'cancelled', merged_into = ?," +
  " updated_at = ? WHERE id = ?";
const CHILD_SQL =
  "INSERT INTO backlog_items" +
  " (id, group_id, task_id, title, detail, state, priority, due_at," +
  "  parent_id, merged_into, created_at, updated_at)" +
  " VALUES (?, ?, NULL, ?, ?, 'backlog', ?, ?, ?, NULL, ?, ?)";

function err(code: BacklogServiceCode, reason: string): BacklogServiceError {
  return { ok: false, code, reason };
}

export function backlogServiceStatus(code: BacklogServiceCode): number {
  switch (code) {
    case "backlog_not_found":
    case "group_not_found":
    case "member_not_found":
      return 404;
    case "not_authorized":
      return 403;
    case "not_writable":
      return 500;
    default:
      return 422;
  }
}

function run(db: DbLike, sql: string, params: unknown[]): void {
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  db.prepare(sql).run(...(params as never[]));
}

function rowView(row: Record<string, unknown>): BacklogItemView {
  const parsed = backlogItemViewSchema.safeParse(row);
  if (!parsed.success) {
    throw new Error(
      "backlog/service：条目 [" +
        String(row["id"]) +
        "] 行形状坏（backlogItemViewSchema 不过）——拒当合法视图： " +
        parsed.error.issues[0]?.message,
    );
  }
  return parsed.data;
}

function getItem(db: DbLike, id: string): BacklogItemView | undefined {
  assertSingleStatement(ITEM_SQL);
  const params: unknown[] = [id];
  assertParamCount(ITEM_SQL, params);
  const row: Record<string, unknown> | undefined = db
    .prepare(ITEM_SQL)
    .get(...(params as never[]));
  return row === undefined ? undefined : rowView(row);
}

function mustItem(db: DbLike, id: string): BacklogItemView {
  const item = getItem(db, id);
  if (item === undefined) {
    throw new Error(
      "backlog/service：刚写完条目 [" + id + "] 却读不回来，整单回滚。",
    );
  }
  return item;
}

function exists(db: DbLike, sql: string, params: unknown[]): boolean {
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  return db.prepare(sql).get(...(params as never[])) !== undefined;
}

/** 先确认群存在，再按在席岗位与席位判操作权；全局群由调用方单独拒绝成员。 */
function authorizeGroup(
  db: DbLike,
  groupId: string,
  actor: BacklogActor,
): BacklogServiceError | undefined {
  if (!exists(db, GROUP_EXISTS_SQL, [groupId])) {
    return err("group_not_found", "群 [" + groupId + "] 不存在，整单未写。");
  }
  if (actor.kind === "boss") return undefined;
  const params: unknown[] = [groupId, actor.memberId];
  assertSingleStatement(MEMBER_SEAT_SQL);
  assertParamCount(MEMBER_SEAT_SQL, params);
  const row: Record<string, unknown> | undefined = db
    .prepare(MEMBER_SEAT_SQL)
    .get(...(params as never[]));
  if (row === undefined) {
    return err(
      "member_not_found",
      "成员 [" + actor.memberId + "] 不存在，整单未写。",
    );
  }
  if (row["status"] !== "active") {
    return err(
      "not_authorized",
      "成员 [" + actor.memberId + "] 已离职，不能操作面板。",
    );
  }
  if (row["seat"] === undefined) {
    return err(
      "not_participant",
      "成员 [" + actor.memberId + "] 不在群 [" + groupId + "] 的席位表里。",
    );
  }
  if (row["seat"] !== "cos" && row["category"] !== "product") {
    return err(
      "not_authorized",
      "成员 [" +
        actor.memberId +
        "] 在群 [" +
        groupId +
        "] 既非产品岗位，也非特助席。",
    );
  }
  return undefined;
}

function authorizeItemGroup(
  db: DbLike,
  groupId: string | null,
  actor: BacklogActor,
): BacklogServiceError | undefined {
  if (groupId === null) {
    return actor.kind === "boss"
      ? undefined
      : err("not_authorized", "全局面板仅老板可写。");
  }
  return authorizeGroup(db, groupId, actor);
}

function audit(
  db: DatabaseSync,
  item: BacklogItemView,
  op: BacklogOp,
  actor: BacklogActor,
  nowMs: number,
  extra: Record<string, unknown> = {},
): number {
  return appendAudit(
    db,
    {
      taskId: null,
      actorType: actor.kind === "boss" ? "human" : "agent",
      actorId: actor.kind === "boss" ? CEO_ROLE_ID : actor.memberId,
      action: "state_change",
      target: item.id,
      payload: {
        kind: "backlog_changed",
        op,
        backlog_item_id: item.id,
        group_id: item.group_id,
        ...extra,
      },
      createdAt: nowMs,
    },
    () => nowMs,
  );
}

/** 只把 SQLite 拒绝翻成业务错误；程序错误仍抛出，不能伪装成可重试的写入失败。 */
function isSqliteError(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    ("errcode" in e ||
      ("code" in e &&
        typeof e.code === "string" &&
        e.code.startsWith("ERR_SQLITE")))
  );
}

async function inNode<T extends Success>(
  w: Writer,
  fn: () => T | BacklogServiceError,
): Promise<T | BacklogServiceError> {
  try {
    return await w.node(fn);
  } catch (e) {
    if (!isSqliteError(e)) throw e;
    return err(
      "not_writable",
      "数据库拒绝这次面板写入，整单已回滚：" +
        (e instanceof Error ? e.message : String(e)),
    );
  }
}

function broadcast(
  bus: EventBus,
  itemId: string,
  op: BacklogOp,
  auditSeq: number,
): { readonly broadcastError?: string } {
  try {
    bus.publishPersisted(
      { kind: "BacklogChanged", backlogItemId: itemId, op },
      auditSeq,
    );
    return {};
  } catch (e) {
    return { broadcastError: e instanceof Error ? e.message : String(e) };
  }
}

function isFailure(
  value: Success | BacklogServiceError,
): value is BacklogServiceError {
  return value.ok === false;
}

function badBody(
  schemaName: string,
  issue: string | undefined,
): BacklogServiceError {
  return err(
    "bad_body",
    schemaName + " 请求不合契约，整单未写：" + (issue ?? "契约校验失败"),
  );
}

export type ListBacklogResult =
  | { readonly ok: true; readonly items: BacklogItemView[] }
  | BacklogServiceError;

/** 列表不按调用者过滤；HTTP 的可见性留给 T10。坏查询返回可映射的 422，不混成 500。 */
export function listBacklog(db: DbLike, rawQuery: unknown): ListBacklogResult {
  const parsed = listBacklogQuerySchema.safeParse(rawQuery);
  if (!parsed.success) {
    return err(
      "bad_query",
      "listBacklogQuerySchema 不合契约：" +
        (parsed.error.issues[0]?.message ?? "契约校验失败"),
    );
  }
  const query = parsed.data;
  const params: unknown[] = [
    query.group_id ?? null,
    query.group_id ?? null,
    query.state ?? null,
    query.state ?? null,
    query.limit,
  ];
  assertSingleStatement(LIST_SQL);
  assertParamCount(LIST_SQL, params);
  const rows: Record<string, unknown>[] = db
    .prepare(LIST_SQL)
    .all(...(params as never[]));
  return { ok: true, items: rows.map(rowView) };
}

export function getBacklog(
  db: DbLike,
  id: string,
): BacklogItemView | undefined {
  return getItem(db, id);
}

export async function createBacklog(
  w: Writer,
  bus: EventBus,
  o: WriteOptions,
): Promise<BacklogMutationResult> {
  const parsed = createBacklogRequestSchema.safeParse(o.req);
  if (!parsed.success) {
    return badBody(
      "createBacklogRequestSchema",
      parsed.error.issues[0]?.message,
    );
  }
  const req = parsed.data;
  const wrote = await inNode(w, () => {
    const db = requireScopeDb("createBacklog");
    const groupId = req.group_id ?? null;
    const denied = authorizeItemGroup(db, groupId, o.actor);
    if (denied !== undefined) return denied;
    const id = o.newId?.() ?? randomUUID();
    run(db, INSERT_SQL, [
      id,
      groupId,
      req.title,
      req.detail,
      req.priority,
      req.due_at ?? null,
      null,
      o.nowMs,
      o.nowMs,
    ]);
    const item = mustItem(db, id);
    const auditSeq = audit(db, item, "create", o.actor, o.nowMs);
    return { ok: true, item, auditSeq };
  });
  if (isFailure(wrote)) return wrote;
  return {
    ...wrote,
    ...broadcast(bus, wrote.item.id, "create", wrote.auditSeq),
  };
}

export async function moveBacklog(
  w: Writer,
  bus: EventBus,
  o: WriteOptions & { readonly id: string },
): Promise<BacklogMutationResult> {
  const parsed = moveBacklogRequestSchema.safeParse(o.req);
  if (!parsed.success) {
    return badBody("moveBacklogRequestSchema", parsed.error.issues[0]?.message);
  }
  const groupId = parsed.data.group_id;
  const wrote = await inNode(w, () => {
    const db = requireScopeDb("moveBacklog");
    const before = getItem(db, o.id);
    if (before === undefined) {
      return err("backlog_not_found", "条目 [" + o.id + "] 不存在，整单未写。");
    }
    const denied = authorizeItemGroup(db, before.group_id, o.actor);
    if (denied !== undefined) return denied;
    if (groupId !== before.group_id) {
      const destinationDenied = authorizeItemGroup(db, groupId, o.actor);
      if (destinationDenied !== undefined) return destinationDenied;
    }
    run(db, MOVE_SQL, [groupId, o.nowMs, o.id]);
    const item = mustItem(db, o.id);
    const auditSeq = audit(db, item, "move", o.actor, o.nowMs, {
      from_group_id: before.group_id,
      into_group_id: groupId,
    });
    return { ok: true, item, auditSeq };
  });
  if (isFailure(wrote)) return wrote;
  return {
    ...wrote,
    ...broadcast(bus, o.id, "move", wrote.auditSeq),
  };
}

export async function rescheduleBacklog(
  w: Writer,
  bus: EventBus,
  o: WriteOptions & { readonly id: string },
): Promise<BacklogMutationResult> {
  const parsed = rescheduleBacklogRequestSchema.safeParse(o.req);
  if (!parsed.success) {
    return badBody(
      "rescheduleBacklogRequestSchema",
      parsed.error.issues[0]?.message,
    );
  }
  const dueAt = parsed.data.due_at;
  const wrote = await inNode(w, () => {
    const db = requireScopeDb("rescheduleBacklog");
    const before = getItem(db, o.id);
    if (before === undefined) {
      return err("backlog_not_found", "条目 [" + o.id + "] 不存在，整单未写。");
    }
    const denied = authorizeItemGroup(db, before.group_id, o.actor);
    if (denied !== undefined) return denied;
    run(db, RESCHEDULE_SQL, [dueAt, o.nowMs, o.id]);
    const item = mustItem(db, o.id);
    const auditSeq = audit(db, item, "defer", o.actor, o.nowMs, {
      from_due_at: before.due_at,
      due_at: dueAt,
    });
    return { ok: true, item, auditSeq };
  });
  if (isFailure(wrote)) return wrote;
  return {
    ...wrote,
    ...broadcast(bus, o.id, "defer", wrote.auditSeq),
  };
}

export async function reprioritizeBacklog(
  w: Writer,
  bus: EventBus,
  o: WriteOptions & { readonly id: string },
): Promise<BacklogMutationResult> {
  const parsed = reprioritizeBacklogSchema.safeParse(o.req);
  if (!parsed.success) {
    return badBody(
      "reprioritizeBacklogSchema",
      parsed.error.issues[0]?.message,
    );
  }
  const priority = parsed.data.priority;
  const wrote = await inNode(w, () => {
    const db = requireScopeDb("reprioritizeBacklog");
    const before = getItem(db, o.id);
    if (before === undefined) {
      return err("backlog_not_found", "条目 [" + o.id + "] 不存在，整单未写。");
    }
    const denied = authorizeItemGroup(db, before.group_id, o.actor);
    if (denied !== undefined) return denied;
    run(db, PRIORITY_SQL, [priority, o.nowMs, o.id]);
    const item = mustItem(db, o.id);
    const auditSeq = audit(db, item, "priority", o.actor, o.nowMs, {
      from_priority: before.priority,
      priority,
    });
    return { ok: true, item, auditSeq };
  });
  if (isFailure(wrote)) return wrote;
  return {
    ...wrote,
    ...broadcast(bus, o.id, "priority", wrote.auditSeq),
  };
}

export async function cancelBacklog(
  w: Writer,
  bus: EventBus,
  o: Omit<WriteOptions, "req"> & {
    readonly id: string;
    readonly req?: unknown;
  },
): Promise<BacklogMutationResult> {
  const wrote = await inNode(w, () => {
    const db = requireScopeDb("cancelBacklog");
    const before = getItem(db, o.id);
    if (before === undefined) {
      return err("backlog_not_found", "条目 [" + o.id + "] 不存在，整单未写。");
    }
    const denied = authorizeItemGroup(db, before.group_id, o.actor);
    if (denied !== undefined) return denied;
    if (before.state === "done" && o.actor.kind !== "boss") {
      return err("invalid_state", "已完成的条目只能由老板取消。");
    }
    const item =
      before.state === "cancelled"
        ? before
        : mustItemAfterCancel(db, o.id, o.nowMs);
    const auditSeq = audit(db, item, "cancel", o.actor, o.nowMs, {
      from_state: before.state,
    });
    return { ok: true, item, auditSeq };
  });
  if (isFailure(wrote)) return wrote;
  return {
    ...wrote,
    ...broadcast(bus, o.id, "cancel", wrote.auditSeq),
  };
}

function mustItemAfterCancel(
  db: DbLike,
  id: string,
  nowMs: number,
): BacklogItemView {
  run(db, CANCEL_SQL, [nowMs, id]);
  return mustItem(db, id);
}

export async function splitBacklog(
  w: Writer,
  bus: EventBus,
  o: WriteOptions & { readonly id: string },
): Promise<SplitBacklogResult> {
  const parsed = splitBacklogRequestSchema.safeParse(o.req);
  if (!parsed.success) {
    return badBody(
      "splitBacklogRequestSchema",
      parsed.error.issues[0]?.message,
    );
  }
  const wrote = await inNode(w, () => {
    const db = requireScopeDb("splitBacklog");
    const parent = getItem(db, o.id);
    if (parent === undefined) {
      return err("backlog_not_found", "条目 [" + o.id + "] 不存在，整单未写。");
    }
    const denied = authorizeItemGroup(db, parent.group_id, o.actor);
    if (denied !== undefined) return denied;
    if (parent.state === "cancelled") {
      return err("invalid_state", "已取消的条目不能再拆分。");
    }
    const children: BacklogItemView[] = [];
    for (const child of parsed.data.children) {
      const id = o.newId?.() ?? randomUUID();
      run(db, CHILD_SQL, [
        id,
        parent.group_id,
        child.title,
        child.detail,
        child.priority ?? parent.priority,
        child.due_at ?? null,
        parent.id,
        o.nowMs,
        o.nowMs,
      ]);
      children.push(mustItem(db, id));
    }
    run(db, TOUCH_SQL, [o.nowMs, parent.id]);
    const after = mustItem(db, parent.id);
    const childIds = children.map((child) => child.id);
    const auditSeq = audit(db, after, "split", o.actor, o.nowMs, {
      child_ids: childIds,
    });
    return { ok: true, parent: after, children, auditSeq };
  });
  if (isFailure(wrote)) return wrote;
  return {
    ok: true,
    parent: wrote.parent,
    children: wrote.children,
    auditSeq: wrote.auditSeq,
    ...broadcast(bus, o.id, "split", wrote.auditSeq),
  };
}

export async function mergeBacklog(
  w: Writer,
  bus: EventBus,
  o: WriteOptions & { readonly id: string },
): Promise<BacklogMutationResult> {
  const parsed = mergeBacklogRequestSchema.safeParse(o.req);
  if (!parsed.success) {
    return badBody(
      "mergeBacklogRequestSchema",
      parsed.error.issues[0]?.message,
    );
  }
  const intoId = parsed.data.into_id;
  const wrote = await inNode(w, () => {
    const db = requireScopeDb("mergeBacklog");
    if (o.id === intoId) {
      return err("invalid_target", "不能把条目合并进自己。");
    }
    const before = getItem(db, o.id);
    if (before === undefined) {
      return err("backlog_not_found", "条目 [" + o.id + "] 不存在，整单未写。");
    }
    const target = getItem(db, intoId);
    if (target === undefined) {
      return err(
        "backlog_not_found",
        "合并目标 [" + intoId + "] 不存在，整单未写。",
      );
    }
    const denied = authorizeItemGroup(db, before.group_id, o.actor);
    if (denied !== undefined) return denied;
    if (target.group_id !== before.group_id) {
      const targetDenied = authorizeItemGroup(db, target.group_id, o.actor);
      if (targetDenied !== undefined) return targetDenied;
    }
    if (before.state === "cancelled") {
      return err("invalid_state", "已取消的条目不能再合并。");
    }
    if (target.state === "cancelled") {
      return err("invalid_state", "不能合并进已取消的条目 [" + intoId + "]。");
    }
    run(db, MERGE_SQL, [intoId, o.nowMs, o.id]);
    const item = mustItem(db, o.id);
    const auditSeq = audit(db, item, "merge", o.actor, o.nowMs, {
      into_id: intoId,
    });
    return { ok: true, item, auditSeq };
  });
  if (isFailure(wrote)) return wrote;
  return {
    ...wrote,
    ...broadcast(bus, o.id, "merge", wrote.auditSeq),
  };
}
