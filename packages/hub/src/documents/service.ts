/**
 * 文档中心 CORE 服务：文档、全量版本、模板与三级权限的唯一业务入口。
 *
 * 读侧先判有效权限再出口；无权限一律 document_not_found，不泄露资源存在性。
 * 写侧每个操作只开一个 w.node，实体变化与审计同事务；广播留在提交之后，
 * 投递失败只带回 broadcastError，不改写已经提交的成功事实。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CEO_ROLE_ID,
  type CreateDocumentRequest,
  createDocumentRequestSchema,
  createDocumentTemplateRequestSchema,
  DOC_RETENTION_DAYS,
  type DocKind,
  type DocPermissionTier,
  type DocumentPermissionView,
  type DocumentTemplateView,
  type DocumentVersionView,
  type DocumentView,
  docGranteeSchema,
  documentPermissionViewSchema,
  documentTemplateViewSchema,
  documentVersionViewSchema,
  documentViewSchema,
  listDocumentsQuerySchema,
  saveDocumentRequestSchema,
  setDocumentPermissionRequestSchema,
  updateDocumentMetaRequestSchema,
} from "@opc/contracts";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import {
  assertParamCount,
  assertSingleStatement,
  type Writer,
} from "../db/write-queue.js";
import type { DomainEvent, EventBus } from "../events/bus.js";
import { appendAudit } from "../events/recorder.js";

export type DocumentViewer =
  | { readonly kind: "boss" }
  | { readonly kind: "member"; readonly memberId: string };

/** 简短别名，便于调用方直接声明 viewer 参数。 */
export type Viewer = DocumentViewer;

export type DocumentServiceCode =
  | "document_not_found"
  | "version_not_found"
  | "group_not_found"
  | "task_not_found"
  | "member_not_found"
  | "template_not_found"
  | "not_authorized"
  | "bad_body"
  | "bad_query"
  | "version_conflict"
  | "meeting_not_found"
  | "meeting_not_concluded"
  | "meeting_summary_exists"
  | "not_writable";

export type DocumentServiceError = {
  readonly ok: false;
  readonly code: DocumentServiceCode;
  readonly reason: string;
};

export type ListDocumentsResult =
  | { readonly ok: true; readonly documents: DocumentView[] }
  | DocumentServiceError;

export type GetDocumentResult =
  | { readonly ok: true; readonly document: DocumentView }
  | DocumentServiceError;

export type ListDocumentVersionsResult =
  | { readonly ok: true; readonly versions: DocumentVersionView[] }
  | DocumentServiceError;

export type GetDocumentVersionResult =
  | { readonly ok: true; readonly version: DocumentVersionView }
  | DocumentServiceError;

export type DocumentMutationResult =
  | {
      readonly ok: true;
      readonly document: DocumentView;
      readonly auditSeq: number;
      /** 自动沉淀会议纪要时，同一事务内的第二条审计与广播。 */
      readonly meetingAuditSeq?: number;
      readonly meetingTaskId?: string | null;
      readonly meetingGroupId?: string | null;
      readonly broadcastError?: string;
    }
  | DocumentServiceError;

export type PruneDocumentVersionsResult =
  | { readonly ok: true; readonly deleted: number }
  | DocumentServiceError;

type DbLike = Pick<DatabaseSync, "prepare">;
type Success = { readonly ok: true };
type DocumentOp = Extract<DomainEvent, { kind: "DocumentChanged" }>["op"];

type WriteOptions = {
  readonly viewer: DocumentViewer;
  readonly req: unknown;
  readonly nowMs: number;
  readonly newId?: () => string;
  /** 仅限受信任的自动沉淀调用方；HTTP 请求体不能注入 origin。 */
  readonly origin?: "created" | "imported" | "auto";
  /** 受信任的自动沉淀调用方：文档与会议纪要回填/审计同一事务。 */
  readonly meetingSummaryId?: string;
};

const DOCUMENT_COLS =
  "doc_id, kind, title, group_id, task_id, owner, mime, watermark_profile," +
  " origin, template_id, created_at, updated_at, deleted_at";
const DOCUMENT_DETAIL_COLS = DOCUMENT_COLS + ", body_text";
const VERSION_COLS = "version_id, doc_id, seq, author, created_at";
const VERSION_DETAIL_COLS = VERSION_COLS + ", body_text";

const DOCUMENT_SQL = `SELECT ${DOCUMENT_DETAIL_COLS} FROM documents WHERE doc_id = ?`;
const DOCUMENT_SUMMARY_SQL = `SELECT ${DOCUMENT_COLS} FROM documents WHERE doc_id = ?`;
const LIST_DOCUMENTS_SQL =
  `SELECT ${DOCUMENT_COLS} FROM documents` +
  " WHERE deleted_at IS NULL" +
  " AND (? IS NULL OR group_id = ?)" +
  " AND (? IS NULL OR task_id = ?)" +
  " AND (? IS NULL OR kind = ?)" +
  " ORDER BY updated_at DESC, doc_id ASC";
const LIST_PERMISSIONS_SQL =
  "SELECT doc_id, grantee, tier FROM document_permissions WHERE doc_id = ? ORDER BY grantee";
const LIST_VERSIONS_SQL =
  `SELECT ${VERSION_COLS} FROM document_versions WHERE doc_id = ?` +
  " ORDER BY seq DESC";
const VERSION_SQL = `SELECT ${VERSION_DETAIL_COLS} FROM document_versions WHERE doc_id = ? AND seq = ?`;
const LATEST_VERSION_SQL =
  "SELECT COALESCE(MAX(seq), 0) AS seq FROM document_versions WHERE doc_id = ?";
const LIST_TEMPLATES_SQL =
  "SELECT template_id, name, kind, body_text, builtin FROM document_templates" +
  " ORDER BY template_id";
const TEMPLATE_SQL =
  "SELECT template_id, name, kind, body_text, builtin FROM document_templates" +
  " WHERE template_id = ?";
const INSERT_TEMPLATE_SQL =
  "INSERT INTO document_templates (template_id, name, kind, body_text, builtin)" +
  " VALUES (?, ?, ?, ?, 0)";

const GROUP_EXISTS_SQL = "SELECT 1 AS hit FROM groups WHERE group_id = ?";
const TASK_EXISTS_SQL = "SELECT 1 AS hit FROM tasks WHERE id = ?";
const MEMBER_STATUS_SQL = "SELECT status FROM members WHERE member_id = ?";
const MEMBER_EXISTS_SQL = "SELECT 1 AS hit FROM members WHERE member_id = ?";
const ACTIVE_SEAT_SQL =
  "SELECT 1 AS hit FROM group_members gm" +
  " JOIN members m ON m.member_id = gm.member_id" +
  " WHERE gm.group_id = ? AND gm.member_id = ? AND m.status = 'active'";
const EXPLICIT_PERMISSION_SQL =
  "SELECT doc_id, grantee, tier FROM document_permissions" +
  " WHERE doc_id = ? AND grantee = ?";
const GROUP_PERMISSION_SQL =
  "SELECT p.doc_id, p.grantee, p.tier FROM document_permissions p" +
  " JOIN group_members gm ON gm.group_id = substr(p.grantee, 7)" +
  " JOIN members m ON m.member_id = gm.member_id" +
  " WHERE p.doc_id = ? AND substr(p.grantee, 1, 6) = 'group:'" +
  " AND gm.member_id = ? AND m.status = 'active'" +
  " ORDER BY CASE p.tier WHEN 'editor' THEN 0 WHEN 'reader' THEN 1 ELSE 2 END" +
  " LIMIT 1";

const INSERT_DOCUMENT_SQL =
  "INSERT INTO documents" +
  " (doc_id, kind, title, group_id, task_id, owner, body_text, mime," +
  "  watermark_profile, origin, template_id, created_at, updated_at)" +
  " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const INSERT_VERSION_SQL =
  "INSERT INTO document_versions (doc_id, seq, body_text, author, created_at)" +
  " VALUES (?, ?, ?, ?, ?)";
const SAVE_DOCUMENT_SQL =
  "UPDATE documents SET title = COALESCE(?, title), body_text = ?," +
  " updated_at = ? WHERE doc_id = ?";
const UPDATE_META_SQL =
  "UPDATE documents SET title = COALESCE(?, title)," +
  " watermark_profile = COALESCE(?, watermark_profile)," +
  " group_id = CASE WHEN ? THEN ? ELSE group_id END," +
  " updated_at = ? WHERE doc_id = ?";
const RESTORE_DOCUMENT_SQL =
  "UPDATE documents SET body_text = ?, updated_at = ? WHERE doc_id = ?";
const UPSERT_PERMISSION_SQL =
  "INSERT INTO document_permissions (doc_id, grantee, tier) VALUES (?, ?, ?)" +
  " ON CONFLICT(doc_id, grantee) DO UPDATE SET tier = excluded.tier";
const DELETE_PERMISSION_SQL =
  "DELETE FROM document_permissions WHERE doc_id = ? AND grantee = ?";
const DELETE_DOCUMENT_SQL =
  "UPDATE documents SET deleted_at = ?, updated_at = ? WHERE doc_id = ? AND deleted_at IS NULL";
const LINK_MEETING_SUMMARY_SQL =
  "UPDATE meetings SET summary_doc_id = ?" +
  " WHERE id = ? AND status = 'concluded' AND summary_doc_id IS NULL";
const MEETING_SUMMARY_SQL =
  "SELECT task_id, group_id, status, summary_doc_id FROM meetings WHERE id = ?";
const PRUNE_VERSIONS_SQL =
  "DELETE FROM document_versions AS old" +
  " WHERE old.created_at < ?" +
  " AND EXISTS (SELECT 1 FROM document_versions AS newer" +
  "             WHERE newer.doc_id = old.doc_id AND newer.seq > old.seq)";

const MIME_BY_KIND: Record<DocKind, string> = {
  markdown: "text/markdown",
  doc: "text/markdown",
  sheet: "application/json",
  mindmap: "application/json",
};

function err(code: DocumentServiceCode, reason: string): DocumentServiceError {
  return { ok: false, code, reason };
}

export function documentServiceStatus(code: DocumentServiceCode): number {
  switch (code) {
    case "document_not_found":
    case "version_not_found":
    case "group_not_found":
    case "task_not_found":
    case "member_not_found":
    case "template_not_found":
      return 404;
    case "not_authorized":
      return 403;
    case "version_conflict":
    case "meeting_not_concluded":
    case "meeting_summary_exists":
      return 409;
    case "meeting_not_found":
      return 404;
    case "not_writable":
      return 500;
    default:
      return 422;
  }
}

function queryRow(
  db: DbLike,
  sql: string,
  params: unknown[],
): Record<string, unknown> | undefined {
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  return db.prepare(sql).get(...(params as never[]));
}

function queryRows(
  db: DbLike,
  sql: string,
  params: unknown[],
): Record<string, unknown>[] {
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  return db.prepare(sql).all(...(params as never[]));
}

function run(db: DbLike, sql: string, params: unknown[]): void {
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  db.prepare(sql).run(...(params as never[]));
}

function exists(db: DbLike, sql: string, params: unknown[]): boolean {
  return queryRow(db, sql, params) !== undefined;
}

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
  fn: () => T | DocumentServiceError,
): Promise<T | DocumentServiceError> {
  try {
    return await w.node(fn);
  } catch (e) {
    if (!isSqliteError(e)) throw e;
    return err(
      "not_writable",
      "数据库拒绝这次文档写入，整单已回滚：" +
        (e instanceof Error ? e.message : String(e)),
    );
  }
}

function isFailure(
  value: Success | DocumentServiceError,
): value is DocumentServiceError {
  return value.ok === false;
}

function badBody(
  schemaName: string,
  issue: string | undefined,
): DocumentServiceError {
  return err(
    "bad_body",
    schemaName + " 请求不合契约，整单未写：" + (issue ?? "契约校验失败"),
  );
}

function viewerId(viewer: DocumentViewer): string {
  return viewer.kind === "boss" ? "boss" : viewer.memberId;
}

function documentView(
  row: Record<string, unknown>,
  tier: DocPermissionTier,
): DocumentView {
  const parsed = documentViewSchema.safeParse({ ...row, my_tier: tier });
  if (!parsed.success) {
    throw new Error(
      "documents/service：文档 [" +
        String(row["doc_id"]) +
        "] 行形状坏（documentViewSchema 不过）——拒当合法视图： " +
        parsed.error.issues[0]?.message,
    );
  }
  return parsed.data;
}

function versionView(row: Record<string, unknown>): DocumentVersionView {
  const parsed = documentVersionViewSchema.safeParse(row);
  if (!parsed.success) {
    throw new Error(
      "documents/service：文档 [" +
        String(row["doc_id"]) +
        "] 版本 [" +
        String(row["seq"]) +
        "] 行形状坏（documentVersionViewSchema 不过）——拒当合法视图： " +
        parsed.error.issues[0]?.message,
    );
  }
  return parsed.data;
}

function templateView(row: Record<string, unknown>): DocumentTemplateView {
  const builtin =
    row["builtin"] === 0 ? false : row["builtin"] === 1 ? true : row["builtin"];
  const parsed = documentTemplateViewSchema.safeParse({ ...row, builtin });
  if (!parsed.success) {
    throw new Error(
      "documents/service：模板 [" +
        String(row["template_id"]) +
        "] 行形状坏（documentTemplateViewSchema 不过）——拒当合法视图： " +
        parsed.error.issues[0]?.message,
    );
  }
  return parsed.data;
}

function rawDocument(
  db: DbLike,
  docId: string,
  detail: boolean,
): Record<string, unknown> | undefined {
  const row = queryRow(db, detail ? DOCUMENT_SQL : DOCUMENT_SUMMARY_SQL, [
    docId,
  ]);
  return row !== undefined && row["deleted_at"] !== null ? undefined : row;
}

function permissionTier(
  row: Record<string, unknown>,
): DocPermissionTier | undefined {
  const parsed = documentPermissionViewSchema.safeParse(row);
  if (!parsed.success) {
    throw new Error(
      "documents/service：文档 [" +
        String(row["doc_id"]) +
        "] 权限行形状坏（documentPermissionViewSchema 不过）——拒当合法视图： " +
        parsed.error.issues[0]?.message,
    );
  }
  return parsed.data.tier;
}

function permissionView(row: Record<string, unknown>): DocumentPermissionView {
  const parsed = documentPermissionViewSchema.safeParse(row);
  if (!parsed.success) {
    throw new Error(
      "documents/service：文档权限行形状坏：" + parsed.error.issues[0]?.message,
    );
  }
  return parsed.data;
}

function effectiveTier(
  db: DbLike,
  document: DocumentView,
  viewer: DocumentViewer,
): DocPermissionTier | undefined {
  if (document.owner === viewerId(viewer)) return "owner";
  if (viewer.kind === "member") {
    const explicit = queryRow(db, EXPLICIT_PERMISSION_SQL, [
      document.doc_id,
      viewer.memberId,
    ]);
    if (explicit !== undefined) return permissionTier(explicit);
  } else {
    const explicit = queryRow(db, EXPLICIT_PERMISSION_SQL, [
      document.doc_id,
      "boss",
    ]);
    if (explicit !== undefined) return permissionTier(explicit);
  }

  if (viewer.kind !== "member") return undefined;
  const groupPermission = queryRow(db, GROUP_PERMISSION_SQL, [
    document.doc_id,
    viewer.memberId,
  ]);
  if (groupPermission !== undefined) return permissionTier(groupPermission);
  if (document.group_id === null) return undefined;
  return exists(db, ACTIVE_SEAT_SQL, [document.group_id, viewer.memberId])
    ? "reader"
    : undefined;
}

function accessibleDocument(
  db: DbLike,
  docId: string,
  viewer: DocumentViewer,
  detail: boolean,
):
  | { readonly document: DocumentView; readonly tier: DocPermissionTier }
  | DocumentServiceError {
  const row = rawDocument(db, docId, detail);
  if (row === undefined) {
    return err("document_not_found", "文档 [" + docId + "] 不存在或不可访问。");
  }
  const base = documentViewSchema.safeParse(row);
  if (!base.success) {
    throw new Error(
      "documents/service：文档 [" +
        docId +
        "] 行形状坏（documentViewSchema 不过）——拒当合法视图： " +
        base.error.issues[0]?.message,
    );
  }
  const tier = effectiveTier(db, base.data, viewer);
  if (tier === undefined) {
    return err("document_not_found", "文档 [" + docId + "] 不存在或不可访问。");
  }
  return { document: documentView(row, tier), tier };
}

function requireWriteTier(
  access: { readonly document: DocumentView; readonly tier: DocPermissionTier },
  ownerOnly: boolean,
): DocumentServiceError | undefined {
  if (
    ownerOnly
      ? access.tier === "owner"
      : access.tier === "owner" || access.tier === "editor"
  ) {
    return undefined;
  }
  return err(
    "not_authorized",
    ownerOnly
      ? "只有文档所有者可以执行这项操作。"
      : "只有文档所有者或编辑者可以执行这项操作。",
  );
}

function mustDocument(
  db: DbLike,
  docId: string,
  viewer: DocumentViewer,
): DocumentView {
  const access = accessibleDocument(db, docId, viewer, true);
  if ("ok" in access) {
    throw new Error(
      "documents/service：刚写完文档 [" +
        docId +
        "] 却不可读：" +
        access.reason,
    );
  }
  return access.document;
}

function auditDocument(
  db: DatabaseSync,
  document: DocumentView,
  op: DocumentOp,
  viewer: DocumentViewer,
  nowMs: number,
  extra: Record<string, unknown> = {},
): number {
  return appendAudit(
    db,
    {
      taskId: null,
      actorType: viewer.kind === "boss" ? "human" : "agent",
      actorId: viewer.kind === "boss" ? CEO_ROLE_ID : viewer.memberId,
      action: "state_change",
      target: document.doc_id,
      payload: {
        kind: "document_changed",
        op,
        doc_id: document.doc_id,
        group_id: document.group_id,
        ...extra,
      },
      createdAt: nowMs,
    },
    () => nowMs,
  );
}

function broadcast(
  bus: EventBus,
  docId: string,
  op: DocumentOp,
  auditSeq: number,
): { readonly broadcastError?: string } {
  try {
    bus.publishPersisted({ kind: "DocumentChanged", docId, op }, auditSeq);
    return {};
  } catch (e) {
    return { broadcastError: e instanceof Error ? e.message : String(e) };
  }
}

function validateViewer(
  db: DbLike,
  viewer: DocumentViewer,
): DocumentServiceError | undefined {
  if (viewer.kind === "boss") return undefined;
  const member = queryRow(db, MEMBER_STATUS_SQL, [viewer.memberId]);
  if (member === undefined) {
    return err(
      "member_not_found",
      "成员 [" + viewer.memberId + "] 不存在，整单未写。",
    );
  }
  return member["status"] === "active"
    ? undefined
    : err(
        "not_authorized",
        "成员 [" + viewer.memberId + "] 已归档，不能新建文档。",
      );
}

function validateGroup(
  db: DbLike,
  groupId: string | null | undefined,
): DocumentServiceError | undefined {
  if (groupId === undefined || groupId === null) return undefined;
  return exists(db, GROUP_EXISTS_SQL, [groupId])
    ? undefined
    : err("group_not_found", "群 [" + groupId + "] 不存在，整单未写。");
}

function validateTask(
  db: DbLike,
  taskId: string | null | undefined,
): DocumentServiceError | undefined {
  if (taskId === undefined || taskId === null) return undefined;
  return exists(db, TASK_EXISTS_SQL, [taskId])
    ? undefined
    : err("task_not_found", "任务 [" + taskId + "] 不存在，整单未写。");
}

function validateGrantee(
  db: DbLike,
  grantee: string,
): DocumentServiceError | undefined {
  if (grantee === "boss") return undefined;
  if (grantee.startsWith("group:")) {
    const groupId = grantee.slice("group:".length);
    return exists(db, GROUP_EXISTS_SQL, [groupId])
      ? undefined
      : err("group_not_found", "群 [" + groupId + "] 不存在，整单未写。");
  }
  return exists(db, MEMBER_EXISTS_SQL, [grantee])
    ? undefined
    : err("member_not_found", "成员 [" + grantee + "] 不存在，整单未写。");
}

// ── 读面 ────────────────────────────────────────────────────────────

export function listDocuments(
  db: DbLike,
  rawQuery: unknown,
  viewer: DocumentViewer,
): ListDocumentsResult {
  const parsed = listDocumentsQuerySchema.safeParse(rawQuery);
  if (!parsed.success) {
    return err(
      "bad_query",
      "listDocumentsQuerySchema 不合契约：" +
        (parsed.error.issues[0]?.message ?? "契约校验失败"),
    );
  }
  const query = parsed.data;
  const rows = queryRows(db, LIST_DOCUMENTS_SQL, [
    query.group_id ?? null,
    query.group_id ?? null,
    query.task_id ?? null,
    query.task_id ?? null,
    query.kind ?? null,
    query.kind ?? null,
  ]);
  const documents: DocumentView[] = [];
  for (const row of rows) {
    const base = documentViewSchema.safeParse(row);
    if (!base.success) {
      throw new Error(
        "documents/service：文档 [" +
          String(row["doc_id"]) +
          "] 行形状坏（documentViewSchema 不过）——拒当合法视图： " +
          base.error.issues[0]?.message,
      );
    }
    const tier = effectiveTier(db, base.data, viewer);
    if (tier !== undefined) documents.push(documentView(row, tier));
  }
  return { ok: true, documents: documents.slice(0, query.limit) };
}

export function getDocument(
  db: DbLike,
  docId: string,
  viewer: DocumentViewer,
): GetDocumentResult {
  const access = accessibleDocument(db, docId, viewer, true);
  return "ok" in access ? access : { ok: true, document: access.document };
}

export function listDocumentPermissions(
  db: DbLike,
  docId: string,
  viewer: DocumentViewer,
):
  | { readonly ok: true; readonly permissions: DocumentPermissionView[] }
  | DocumentServiceError {
  const access = accessibleDocument(db, docId, viewer, false);
  if ("ok" in access) return access;
  return {
    ok: true,
    permissions: queryRows(db, LIST_PERMISSIONS_SQL, [docId]).map(
      permissionView,
    ),
  };
}

export function listDocumentVersions(
  db: DbLike,
  docId: string,
  viewer: DocumentViewer,
): ListDocumentVersionsResult {
  const access = accessibleDocument(db, docId, viewer, false);
  if ("ok" in access) return access;
  const rows = queryRows(db, LIST_VERSIONS_SQL, [docId]);
  return { ok: true, versions: rows.map(versionView) };
}

export function getDocumentVersion(
  db: DbLike,
  docId: string,
  seq: number,
  viewer: DocumentViewer,
): GetDocumentVersionResult {
  const access = accessibleDocument(db, docId, viewer, false);
  if ("ok" in access) return access;
  if (!Number.isInteger(seq) || seq <= 0) {
    return err("version_not_found", "版本号必须是正整数。");
  }
  const row = queryRow(db, VERSION_SQL, [docId, seq]);
  return row === undefined
    ? err(
        "version_not_found",
        "文档 [" + docId + "] 的版本 [" + seq + "] 不存在。",
      )
    : { ok: true, version: versionView(row) };
}

export function listTemplates(db: DbLike): DocumentTemplateView[] {
  return queryRows(db, LIST_TEMPLATES_SQL, []).map(templateView);
}

// ── 写面 ────────────────────────────────────────────────────────────

export async function createDocumentTemplate(
  w: Writer,
  o: {
    readonly req: unknown;
    readonly nowMs: number;
    readonly newId?: () => string;
  },
): Promise<
  | { readonly ok: true; readonly template: DocumentTemplateView }
  | DocumentServiceError
> {
  const parsed = createDocumentTemplateRequestSchema.safeParse(o.req);
  if (!parsed.success) {
    return badBody(
      "createDocumentTemplateRequestSchema",
      parsed.error.issues[0]?.message,
    );
  }
  return w.node(() => {
    const db = requireScopeDb("createDocumentTemplate");
    const templateId = o.newId?.() ?? randomUUID();
    run(db, INSERT_TEMPLATE_SQL, [
      templateId,
      parsed.data.name,
      parsed.data.kind,
      parsed.data.body_text,
    ]);
    const row = queryRow(db, TEMPLATE_SQL, [templateId]);
    if (row === undefined)
      throw new Error("documents/service：模板刚写入却读不回。");
    return { ok: true, template: templateView(row) };
  });
}

/**
 * Insert a document and its first version inside an existing write node.
 * Trusted automatic deposits (meeting/rhythm/research) use this primitive so
 * their domain row, links and audit commit together. Callers validate the
 * domain references and write their own actor-accurate audit before returning.
 */
export function insertDocumentRecord(
  db: DatabaseSync,
  o: {
    readonly req: CreateDocumentRequest;
    readonly viewer: DocumentViewer;
    readonly nowMs: number;
    readonly origin: "created" | "imported" | "auto";
    readonly newId?: () => string;
  },
): DocumentView {
  const docId = o.newId?.() ?? randomUUID();
  const owner = viewerId(o.viewer);
  run(db, INSERT_DOCUMENT_SQL, [
    docId,
    o.req.kind,
    o.req.title,
    o.req.group_id ?? null,
    o.req.task_id ?? null,
    owner,
    o.req.body_text,
    MIME_BY_KIND[o.req.kind],
    o.req.watermark_profile,
    o.origin,
    o.req.template_id ?? null,
    o.nowMs,
    o.nowMs,
  ]);
  run(db, INSERT_VERSION_SQL, [docId, 1, o.req.body_text, owner, o.nowMs]);
  return mustDocument(db, docId, o.viewer);
}

export async function createDocument(
  w: Writer,
  bus: EventBus,
  o: WriteOptions,
): Promise<DocumentMutationResult> {
  const parsed = createDocumentRequestSchema.safeParse(o.req);
  if (!parsed.success) {
    return badBody(
      "createDocumentRequestSchema",
      parsed.error.issues[0]?.message,
    );
  }
  const req = parsed.data;
  const wrote = await inNode(w, () => {
    const db = requireScopeDb("createDocument");
    const deniedViewer = validateViewer(db, o.viewer);
    if (deniedViewer !== undefined) return deniedViewer;
    const deniedGroup = validateGroup(db, req.group_id);
    if (deniedGroup !== undefined) return deniedGroup;
    const deniedTask = validateTask(db, req.task_id);
    if (deniedTask !== undefined) return deniedTask;

    let body = req.body_text;
    if (req.template_id !== undefined) {
      const templateRow = queryRow(db, TEMPLATE_SQL, [req.template_id]);
      if (templateRow === undefined) {
        return err(
          "template_not_found",
          "模板 [" + req.template_id + "] 不存在，整单未写。",
        );
      }
      body = templateView(templateRow).body_text;
    }

    let meetingAuditSeq: number | undefined;
    let meetingTaskId: string | null = null;
    let meetingGroupId: string | null = null;
    if (o.meetingSummaryId !== undefined) {
      const meeting = queryRow(db, MEETING_SUMMARY_SQL, [o.meetingSummaryId]);
      if (meeting === undefined) {
        return err(
          "meeting_not_found",
          `会议 [${o.meetingSummaryId}] 不存在，整单未写。`,
        );
      }
      if (meeting["status"] !== "concluded") {
        return err(
          "meeting_not_concluded",
          `会议 [${o.meetingSummaryId}] 尚未散会，整单未写。`,
        );
      }
      if (meeting["summary_doc_id"] !== null) {
        return err(
          "meeting_summary_exists",
          `会议 [${o.meetingSummaryId}] 已有纪要，整单未写。`,
        );
      }
      meetingTaskId =
        typeof meeting["task_id"] === "string" ? meeting["task_id"] : null;
      meetingGroupId =
        typeof meeting["group_id"] === "string" ? meeting["group_id"] : null;
    }

    const document = insertDocumentRecord(db, {
      req: { ...req, body_text: body },
      viewer: o.viewer,
      nowMs: o.nowMs,
      origin: o.origin ?? "created",
      ...(o.newId === undefined ? {} : { newId: o.newId }),
    });
    const auditSeq = auditDocument(db, document, "created", o.viewer, o.nowMs);
    if (o.meetingSummaryId !== undefined) {
      run(db, LINK_MEETING_SUMMARY_SQL, [document.doc_id, o.meetingSummaryId]);
      meetingAuditSeq = appendAudit(
        db,
        {
          taskId: meetingTaskId,
          actorType: "system",
          actorId: "hub",
          action: "meeting",
          target: o.meetingSummaryId,
          payload: {
            kind: "meeting_summary_ready",
            meeting_id: o.meetingSummaryId,
            group_id: meetingGroupId,
            doc_id: document.doc_id,
          },
          createdAt: o.nowMs,
        },
        () => o.nowMs,
      );
    }
    return {
      ok: true,
      document,
      auditSeq,
      ...(meetingAuditSeq === undefined
        ? {}
        : { meetingAuditSeq, meetingTaskId, meetingGroupId }),
    };
  });
  if (isFailure(wrote)) return wrote;
  const documentDelivery = broadcast(
    bus,
    wrote.document.doc_id,
    "created",
    wrote.auditSeq,
  );
  let meetingError: string | undefined;
  if (o.meetingSummaryId !== undefined && wrote.meetingAuditSeq !== undefined) {
    try {
      bus.publishPersisted(
        {
          kind: "MeetingSummaryReady",
          taskId: wrote.meetingTaskId ?? null,
          meetingId: o.meetingSummaryId,
        },
        wrote.meetingAuditSeq,
      );
    } catch (error) {
      meetingError = error instanceof Error ? error.message : String(error);
    }
  }
  const errors = [documentDelivery.broadcastError, meetingError].filter(
    (error): error is string => error !== undefined,
  );
  return {
    ...wrote,
    ...(errors.length === 0 ? {} : { broadcastError: errors.join("；") }),
  };
}

export async function saveDocument(
  w: Writer,
  bus: EventBus,
  o: WriteOptions & { readonly docId: string },
): Promise<DocumentMutationResult> {
  const parsed = saveDocumentRequestSchema.safeParse(o.req);
  if (!parsed.success) {
    return badBody(
      "saveDocumentRequestSchema",
      parsed.error.issues[0]?.message,
    );
  }
  const req = parsed.data;
  const wrote = await inNode(w, () => {
    const db = requireScopeDb("saveDocument");
    const access = accessibleDocument(db, o.docId, o.viewer, true);
    if ("ok" in access) return access;
    const denied = requireWriteTier(access, false);
    if (denied !== undefined) return denied;
    const latest = queryRow(db, LATEST_VERSION_SQL, [o.docId]);
    if (latest === undefined || !Number.isSafeInteger(latest["seq"])) {
      throw new Error("documents/service：读取最新版本号失败，整单回滚。");
    }
    const latestSeq = Number(latest["seq"]);
    if (req.base_seq !== undefined && req.base_seq !== latestSeq) {
      return err(
        "version_conflict",
        "基线版本 [" +
          req.base_seq +
          "] 与最新版本 [" +
          latestSeq +
          "] 不一致，整单未写。",
      );
    }
    run(db, SAVE_DOCUMENT_SQL, [
      req.title ?? null,
      req.body_text,
      o.nowMs,
      o.docId,
    ]);
    run(db, INSERT_VERSION_SQL, [
      o.docId,
      latestSeq + 1,
      req.body_text,
      viewerId(o.viewer),
      o.nowMs,
    ]);
    const document = mustDocument(db, o.docId, o.viewer);
    const auditSeq = auditDocument(db, document, "saved", o.viewer, o.nowMs, {
      version_seq: latestSeq + 1,
    });
    return { ok: true, document, auditSeq };
  });
  if (isFailure(wrote)) return wrote;
  return {
    ...wrote,
    ...broadcast(bus, wrote.document.doc_id, "saved", wrote.auditSeq),
  };
}

export async function updateDocumentMeta(
  w: Writer,
  bus: EventBus,
  o: WriteOptions & { readonly docId: string },
): Promise<DocumentMutationResult> {
  const parsed = updateDocumentMetaRequestSchema.safeParse(o.req);
  if (!parsed.success) {
    return badBody(
      "updateDocumentMetaRequestSchema",
      parsed.error.issues[0]?.message,
    );
  }
  const req = parsed.data;
  const wrote = await inNode(w, () => {
    const db = requireScopeDb("updateDocumentMeta");
    const access = accessibleDocument(db, o.docId, o.viewer, true);
    if ("ok" in access) return access;
    const changesGroup =
      req.group_id !== undefined && req.group_id !== access.document.group_id;
    const denied = requireWriteTier(access, changesGroup);
    if (denied !== undefined) return denied;
    const deniedGroup = validateGroup(db, req.group_id);
    if (deniedGroup !== undefined) return deniedGroup;
    const hasGroup = req.group_id === undefined ? 0 : 1;
    run(db, UPDATE_META_SQL, [
      req.title ?? null,
      req.watermark_profile ?? null,
      hasGroup,
      req.group_id ?? null,
      o.nowMs,
      o.docId,
    ]);
    const document = mustDocument(db, o.docId, o.viewer);
    const auditSeq = auditDocument(db, document, "saved", o.viewer, o.nowMs);
    return { ok: true, document, auditSeq };
  });
  if (isFailure(wrote)) return wrote;
  return {
    ...wrote,
    ...broadcast(bus, wrote.document.doc_id, "saved", wrote.auditSeq),
  };
}

export async function restoreDocument(
  w: Writer,
  bus: EventBus,
  o: {
    readonly docId: string;
    readonly seq: number;
    readonly viewer: DocumentViewer;
    readonly nowMs: number;
  },
): Promise<DocumentMutationResult> {
  if (!Number.isInteger(o.seq) || o.seq <= 0) {
    return badBody("restore path seq", "版本号必须是正整数");
  }
  const wrote = await inNode(w, () => {
    const db = requireScopeDb("restoreDocument");
    const access = accessibleDocument(db, o.docId, o.viewer, true);
    if ("ok" in access) return access;
    const denied = requireWriteTier(access, false);
    if (denied !== undefined) return denied;
    const target = queryRow(db, VERSION_SQL, [o.docId, o.seq]);
    if (target === undefined) {
      return err(
        "version_not_found",
        "文档 [" + o.docId + "] 的版本 [" + o.seq + "] 不存在，整单未写。",
      );
    }
    const targetVersion = versionView(target);
    const latest = queryRow(db, LATEST_VERSION_SQL, [o.docId]);
    if (latest === undefined || !Number.isSafeInteger(latest["seq"])) {
      throw new Error("documents/service：读取最新版本号失败，整单回滚。");
    }
    const nextSeq = Number(latest["seq"]) + 1;
    run(db, RESTORE_DOCUMENT_SQL, [targetVersion.body_text, o.nowMs, o.docId]);
    run(db, INSERT_VERSION_SQL, [
      o.docId,
      nextSeq,
      targetVersion.body_text,
      viewerId(o.viewer),
      o.nowMs,
    ]);
    const document = mustDocument(db, o.docId, o.viewer);
    const auditSeq = auditDocument(
      db,
      document,
      "restored",
      o.viewer,
      o.nowMs,
      {
        restored_from_seq: o.seq,
        version_seq: nextSeq,
      },
    );
    return { ok: true, document, auditSeq };
  });
  if (isFailure(wrote)) return wrote;
  return {
    ...wrote,
    ...broadcast(bus, wrote.document.doc_id, "restored", wrote.auditSeq),
  };
}

export async function setDocumentPermission(
  w: Writer,
  bus: EventBus,
  o: WriteOptions & { readonly docId: string },
): Promise<DocumentMutationResult> {
  const parsed = setDocumentPermissionRequestSchema.safeParse(o.req);
  if (!parsed.success) {
    return badBody(
      "setDocumentPermissionRequestSchema",
      parsed.error.issues[0]?.message,
    );
  }
  const req = parsed.data;
  const wrote = await inNode(w, () => {
    const db = requireScopeDb("setDocumentPermission");
    const access = accessibleDocument(db, o.docId, o.viewer, true);
    if ("ok" in access) return access;
    const denied = requireWriteTier(access, true);
    if (denied !== undefined) return denied;
    const deniedGrantee = validateGrantee(db, req.grantee);
    if (deniedGrantee !== undefined) return deniedGrantee;
    run(db, UPSERT_PERMISSION_SQL, [o.docId, req.grantee, req.tier]);
    const document = mustDocument(db, o.docId, o.viewer);
    const auditSeq = auditDocument(
      db,
      document,
      "permission_changed",
      o.viewer,
      o.nowMs,
      { grantee: req.grantee, tier: req.tier },
    );
    return { ok: true, document, auditSeq };
  });
  if (isFailure(wrote)) return wrote;
  return {
    ...wrote,
    ...broadcast(
      bus,
      wrote.document.doc_id,
      "permission_changed",
      wrote.auditSeq,
    ),
  };
}

export async function deleteDocumentPermission(
  w: Writer,
  bus: EventBus,
  o: {
    readonly docId: string;
    readonly grantee: string;
    readonly viewer: DocumentViewer;
    readonly nowMs: number;
  },
): Promise<DocumentMutationResult> {
  const parsed = docGranteeSchema.safeParse(o.grantee);
  if (!parsed.success) {
    return badBody(
      "document permission grantee",
      parsed.error.issues[0]?.message,
    );
  }
  const wrote = await inNode(w, () => {
    const db = requireScopeDb("deleteDocumentPermission");
    const access = accessibleDocument(db, o.docId, o.viewer, true);
    if ("ok" in access) return access;
    const denied = requireWriteTier(access, true);
    if (denied !== undefined) return denied;
    run(db, DELETE_PERMISSION_SQL, [o.docId, parsed.data]);
    const document = mustDocument(db, o.docId, o.viewer);
    const auditSeq = auditDocument(
      db,
      document,
      "permission_changed",
      o.viewer,
      o.nowMs,
      { grantee: parsed.data, deleted: true },
    );
    return { ok: true, document, auditSeq };
  });
  if (isFailure(wrote)) return wrote;
  return {
    ...wrote,
    ...broadcast(
      bus,
      wrote.document.doc_id,
      "permission_changed",
      wrote.auditSeq,
    ),
  };
}

export async function deleteDocument(
  w: Writer,
  bus: EventBus,
  o: {
    readonly docId: string;
    readonly viewer: DocumentViewer;
    readonly nowMs: number;
  },
): Promise<DocumentMutationResult> {
  const wrote = await inNode(w, () => {
    const db = requireScopeDb("deleteDocument");
    const access = accessibleDocument(db, o.docId, o.viewer, true);
    if ("ok" in access) return access;
    const denied = requireWriteTier(access, true);
    if (denied !== undefined) return denied;
    run(db, DELETE_DOCUMENT_SQL, [o.nowMs, o.nowMs, o.docId]);
    const document = { ...access.document, deleted_at: o.nowMs };
    const auditSeq = auditDocument(db, document, "deleted", o.viewer, o.nowMs);
    return { ok: true, document, auditSeq };
  });
  if (isFailure(wrote)) return wrote;
  return {
    ...wrote,
    ...broadcast(bus, wrote.document.doc_id, "deleted", wrote.auditSeq),
  };
}

export async function pruneDocumentVersions(
  w: Writer,
  o: { readonly nowMs: number },
): Promise<PruneDocumentVersionsResult> {
  const cutoff = o.nowMs - DOC_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const wrote = await inNode(w, () => {
    const db = requireScopeDb("pruneDocumentVersions");
    assertSingleStatement(PRUNE_VERSIONS_SQL);
    const params: unknown[] = [cutoff];
    assertParamCount(PRUNE_VERSIONS_SQL, params);
    const info = db.prepare(PRUNE_VERSIONS_SQL).run(...(params as never[]));
    const deleted = Number(info.changes);
    if (!Number.isSafeInteger(deleted) || deleted < 0) {
      throw new Error("documents/service：版本裁剪计数无效，整单回滚。");
    }
    return { ok: true, deleted };
  });
  return wrote;
}
