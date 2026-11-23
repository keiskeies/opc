/** 节奏事件与每日调研卡：团队状态事实，写库与广播在同一条提交链上。 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CEO_ROLE_ID,
  type CreateResearchCardRequest,
  type CreateRhythmEventRequest,
  createResearchCardRequestSchema,
  createRhythmEventRequestSchema,
  listResearchQuerySchema,
  listRhythmQuerySchema,
  type ResearchCardView,
  type RhythmEventView,
  researchCardViewSchema,
  rhythmEventViewSchema,
} from "@opc/contracts";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import {
  assertParamCount,
  assertSingleStatement,
  type Writer,
} from "../db/write-queue.js";
import { insertDocumentRecord } from "../documents/service.js";
import type { DomainEvent, EventBus } from "../events/bus.js";
import { appendAudit } from "../events/recorder.js";

export type RhythmActor =
  | { readonly kind: "boss" }
  | { readonly kind: "system" }
  | { readonly kind: "member"; readonly memberId: string };

export type RhythmServiceCode =
  | "rhythm_not_found"
  | "research_not_found"
  | "group_not_found"
  | "document_not_found"
  | "member_not_found"
  | "not_authorized"
  | "not_participant"
  | "bad_body"
  | "bad_query"
  | "not_writable";

export type RhythmServiceError = {
  readonly ok: false;
  readonly code: RhythmServiceCode;
  readonly reason: string;
};

export type RhythmWriteResult<T> =
  | {
      readonly ok: true;
      readonly item: T;
      readonly created: boolean;
      readonly auditSeq: number;
      readonly document?: { readonly doc_id: string };
      readonly backlogItemId?: string;
      readonly broadcastError?: string;
    }
  | RhythmServiceError;

export type RhythmListResult =
  | { readonly ok: true; readonly items: RhythmEventView[] }
  | RhythmServiceError;
export type ResearchListResult =
  | { readonly ok: true; readonly items: ResearchCardView[] }
  | RhythmServiceError;

type DbLike = Pick<DatabaseSync, "prepare">;

const RHYTHM_COLS = "event_id, kind, group_id, at, digest_doc_id, payload_json";
const RESEARCH_COLS =
  "card_id, day, source, title, summary, url, created_at, group_id, backlog_item_id, doc_id";

function err(code: RhythmServiceCode, reason: string): RhythmServiceError {
  return { ok: false, code, reason };
}

export function rhythmServiceStatus(code: RhythmServiceCode): number {
  switch (code) {
    case "rhythm_not_found":
    case "research_not_found":
    case "group_not_found":
    case "document_not_found":
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

function one(
  db: DbLike,
  sql: string,
  params: unknown[],
): Record<string, unknown> | undefined {
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  return db.prepare(sql).get(...(params as never[])) as
    | Record<string, unknown>
    | undefined;
}

function all(
  db: DbLike,
  sql: string,
  params: unknown[],
): Record<string, unknown>[] {
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  return db.prepare(sql).all(...(params as never[])) as unknown as Record<
    string,
    unknown
  >[];
}

function run(db: DatabaseSync, sql: string, params: unknown[]): number {
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  return Number(db.prepare(sql).run(...(params as never[])).changes);
}

function localDay(nowMs: number): string {
  const date = new Date(nowMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function rhythmView(row: Record<string, unknown>): RhythmEventView {
  let payload: unknown;
  try {
    payload = JSON.parse(String(row["payload_json"]));
  } catch (error) {
    throw new Error(
      "rhythm/service：节奏事件 payload_json 坏 JSON：" +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  const parsed = rhythmEventViewSchema.safeParse({
    event_id: row["event_id"],
    kind: row["kind"],
    group_id: row["group_id"],
    at: row["at"],
    digest_doc_id: row["digest_doc_id"],
    payload,
  });
  if (!parsed.success) {
    throw new Error(
      "rhythm/service：节奏事件行形状坏：" + parsed.error.issues[0]?.message,
    );
  }
  return parsed.data;
}

function researchView(row: Record<string, unknown>): ResearchCardView {
  const parsed = researchCardViewSchema.safeParse(row);
  if (!parsed.success) {
    throw new Error(
      "rhythm/service：调研卡行形状坏：" + parsed.error.issues[0]?.message,
    );
  }
  return parsed.data;
}

function authorizeGroup(
  db: DbLike,
  groupId: string | undefined,
  actor: RhythmActor,
): RhythmServiceError | undefined {
  if (groupId === undefined) return undefined;
  if (
    one(db, "SELECT 1 AS hit FROM groups WHERE group_id = ?", [groupId]) ===
    undefined
  ) {
    return err("group_not_found", `群 [${groupId}] 不存在，整单未写。`);
  }
  if (actor.kind !== "member") return undefined;
  const row = one(
    db,
    "SELECT m.status AS status, gm.seat AS seat, r.category AS category" +
      " FROM members m LEFT JOIN group_members gm ON gm.group_id = ? AND gm.member_id = m.member_id" +
      " LEFT JOIN roles r ON r.role_id = gm.role_id WHERE m.member_id = ?",
    [groupId, actor.memberId],
  );
  if (row === undefined)
    return err("member_not_found", `成员 [${actor.memberId}] 不存在。`);
  if (row["status"] !== "active")
    return err("not_authorized", "离任成员不能记录团队节奏。");
  if (row["seat"] === undefined)
    return err("not_participant", "成员不在该群席位里。");
  if (row["seat"] !== "cos" && row["category"] !== "product") {
    return err("not_authorized", "只有产品岗位或特助席能记录团队节奏。");
  }
  return undefined;
}

type Delivery = { readonly event: DomainEvent; readonly seq: number };

function actorIdentity(actor: RhythmActor): {
  readonly actorType: "human" | "agent" | "system";
  readonly actorId: string;
} {
  return actor.kind === "member"
    ? { actorType: "agent", actorId: actor.memberId }
    : actor.kind === "system"
      ? { actorType: "system", actorId: "system" }
      : { actorType: "human", actorId: CEO_ROLE_ID };
}

function publishDeliveries(
  bus: EventBus,
  deliveries: readonly Delivery[],
): { readonly broadcastError?: string } {
  const errors: string[] = [];
  for (const delivery of deliveries) {
    try {
      bus.publishPersisted(delivery.event, delivery.seq);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors.length === 0 ? {} : { broadcastError: errors.join("; ") };
}

function insertAutoDocument(
  db: DatabaseSync,
  o: {
    readonly title: string;
    readonly bodyText: string;
    readonly groupId: string | null;
    readonly actor: RhythmActor;
    readonly nowMs: number;
    readonly newId: () => string;
  },
): { readonly documentId: string; readonly auditSeq: number } {
  const document = insertDocumentRecord(db, {
    viewer: { kind: "boss" },
    req: {
      kind: "markdown",
      title: o.title,
      body_text: o.bodyText,
      watermark_profile: "none",
      ...(o.groupId === null ? {} : { group_id: o.groupId }),
    },
    origin: "auto",
    nowMs: o.nowMs,
    newId: o.newId,
  });
  const identity = actorIdentity(o.actor);
  const auditSeq = appendAudit(
    db,
    {
      taskId: null,
      actorType: identity.actorType,
      actorId: identity.actorId,
      action: "state_change",
      target: document.doc_id,
      payload: {
        kind: "document_changed",
        op: "created",
        doc_id: document.doc_id,
        group_id: o.groupId,
        origin: "auto",
      },
      createdAt: o.nowMs,
    },
    () => o.nowMs,
  );
  return { documentId: document.doc_id, auditSeq };
}

const RHYTHM_TITLES = {
  sprint_planning: "冲刺计划",
  standup: "每日站会摘要",
  review: "冲刺评审",
  retro: "冲刺回顾",
} as const;

function rhythmMarkdown(
  kind: RhythmEventView["kind"],
  groupId: string | null,
  at: number,
  payload: Record<string, unknown>,
): string {
  return [
    `# ${RHYTHM_TITLES[kind]}`,
    "",
    `- 时间：${new Date(at).toISOString()}`,
    `- 群：${groupId ?? "未关联群"}`,
    "",
    "## 节奏内容",
    "",
    JSON.stringify(payload, null, 2),
    "",
  ].join("\n");
}

function researchMarkdown(req: CreateResearchCardRequest, day: string): string {
  return [
    `# 调研建议：${req.title}`,
    "",
    `- 日期：${day}`,
    `- 来源：${req.source}`,
    `- 链接：${req.url ?? "手工记录，无外部链接"}`,
    `- 群：${req.group_id ?? "未关联群"}`,
    "",
    "## 摘要",
    "",
    req.summary === "" ? "（尚未填写摘要）" : req.summary,
    "",
    "## 下一步",
    "",
    "此卡已同步进入任务面板草稿；会议讨论采纳后才进入执行线。",
    "",
  ].join("\n");
}

export function listRhythm(db: DbLike, rawQuery: unknown): RhythmListResult {
  const parsed = listRhythmQuerySchema.safeParse(rawQuery);
  if (!parsed.success)
    return err(
      "bad_query",
      "节奏查询不合契约：" + parsed.error.issues[0]?.message,
    );
  const query = parsed.data;
  const rows = all(
    db,
    `SELECT ${RHYTHM_COLS} FROM rhythm_events` +
      " WHERE (? IS NULL OR group_id = ?) AND (? IS NULL OR kind = ?)" +
      " ORDER BY at DESC, event_id LIMIT ?",
    [
      query.group_id ?? null,
      query.group_id ?? null,
      query.kind ?? null,
      query.kind ?? null,
      query.limit,
    ],
  );
  return { ok: true, items: rows.map(rhythmView) };
}

export function listResearch(
  db: DbLike,
  rawQuery: unknown,
  nowMs: number,
): ResearchListResult {
  const parsed = listResearchQuerySchema.safeParse(rawQuery);
  if (!parsed.success)
    return err(
      "bad_query",
      "调研查询不合契约：" + parsed.error.issues[0]?.message,
    );
  const day = parsed.data.day ?? localDay(nowMs);
  const rows = all(
    db,
    `SELECT ${RESEARCH_COLS} FROM research_cards WHERE day = ? ORDER BY created_at DESC, card_id`,
    [day],
  );
  return { ok: true, items: rows.map(researchView) };
}

export async function recordRhythmEvent(
  w: Writer,
  bus: EventBus,
  o: {
    readonly req: unknown;
    readonly actor: RhythmActor;
    readonly nowMs: number;
    readonly newId?: () => string;
    readonly newDocId?: () => string;
  },
): Promise<RhythmWriteResult<RhythmEventView>> {
  const parsed = createRhythmEventRequestSchema.safeParse(o.req);
  if (!parsed.success)
    return err(
      "bad_body",
      "节奏请求不合契约：" + parsed.error.issues[0]?.message,
    );
  const req: CreateRhythmEventRequest = parsed.data;
  const at = req.at ?? o.nowMs;
  const bodyText = rhythmMarkdown(
    req.kind,
    req.group_id ?? null,
    at,
    req.payload,
  );
  if (bodyText.length > 2_000_000) {
    return err("bad_body", "节奏内容超过文档正文上限，整单未写。");
  }
  const wrote = await w.node(() => {
    const db = requireScopeDb("recordRhythmEvent");
    const denied = authorizeGroup(db, req.group_id, o.actor);
    if (denied !== undefined) return denied;
    if (
      req.digest_doc_id !== undefined &&
      one(db, "SELECT 1 AS hit FROM documents WHERE doc_id = ?", [
        req.digest_doc_id,
      ]) === undefined
    ) {
      return err(
        "document_not_found",
        `纪要文档 [${req.digest_doc_id}] 不存在。`,
      );
    }
    let digestDocId = req.digest_doc_id ?? null;
    let documentAuditSeq: number | undefined;
    if (digestDocId === null) {
      const deposited = insertAutoDocument(db, {
        title: `${RHYTHM_TITLES[req.kind]}：${new Date(at).toISOString().slice(0, 10)}`,
        bodyText,
        groupId: req.group_id ?? null,
        actor: o.actor,
        nowMs: o.nowMs,
        newId: o.newDocId ?? randomUUID,
      });
      digestDocId = deposited.documentId;
      documentAuditSeq = deposited.auditSeq;
    }
    const eventId = o.newId?.() ?? randomUUID();
    run(
      db,
      "INSERT INTO rhythm_events (event_id, kind, group_id, at, digest_doc_id, payload_json)" +
        " VALUES (?, ?, ?, ?, ?, ?)",
      [
        eventId,
        req.kind,
        req.group_id ?? null,
        req.at ?? o.nowMs,
        digestDocId,
        JSON.stringify(req.payload),
      ],
    );
    const row = one(
      db,
      `SELECT ${RHYTHM_COLS} FROM rhythm_events WHERE event_id = ?`,
      [eventId],
    );
    if (row === undefined)
      throw new Error("rhythm/service：节奏事件刚写入却读不回。");
    const item = rhythmView(row);
    const identity = actorIdentity(o.actor);
    const auditSeq = appendAudit(
      db,
      {
        taskId: null,
        actorType: identity.actorType,
        actorId: identity.actorId,
        action: "state_change",
        target: eventId,
        payload: {
          kind: "rhythm_recorded",
          event_id: eventId,
          rhythm_kind: req.kind,
          group_id: req.group_id ?? null,
        },
        createdAt: o.nowMs,
      },
      () => o.nowMs,
    );
    return {
      ok: true as const,
      item,
      created: true as const,
      auditSeq,
      document: { doc_id: digestDocId },
      deliveries: [
        ...(documentAuditSeq === undefined
          ? []
          : [
              {
                event: {
                  kind: "DocumentChanged",
                  docId: digestDocId,
                  op: "created",
                } as const,
                seq: documentAuditSeq,
              },
            ]),
        {
          event: {
            kind: "RhythmEventRecorded",
            eventId: item.event_id,
            groupId: item.group_id,
            rhythmKind: item.kind,
          } as const,
          seq: auditSeq,
        },
      ],
    };
  });
  if (!wrote.ok) return wrote;
  const { deliveries, ...result } = wrote;
  return { ...result, ...publishDeliveries(bus, deliveries) };
}

export async function createResearchCard(
  w: Writer,
  bus: EventBus,
  o: {
    readonly req: unknown;
    readonly actor: RhythmActor;
    readonly nowMs: number;
    readonly newId?: () => string;
    readonly newDocId?: () => string;
    readonly newBacklogId?: () => string;
  },
): Promise<RhythmWriteResult<ResearchCardView>> {
  const parsed = createResearchCardRequestSchema.safeParse(o.req);
  if (!parsed.success)
    return err(
      "bad_body",
      "调研卡请求不合契约：" + parsed.error.issues[0]?.message,
    );
  const req: CreateResearchCardRequest = parsed.data;
  const wrote = await w.node(() => {
    const db = requireScopeDb("createResearchCard");
    const deniedGroup = authorizeGroup(db, req.group_id, o.actor);
    if (deniedGroup !== undefined) return deniedGroup;
    if (o.actor.kind === "member") {
      const row = one(
        db,
        "SELECT m.status AS status, r.category AS category FROM members m" +
          " LEFT JOIN roles r ON r.role_id = m.role_id WHERE m.member_id = ?",
        [o.actor.memberId],
      );
      if (row === undefined)
        return err("member_not_found", `成员 [${o.actor.memberId}] 不存在。`);
      if (row["status"] !== "active" || row["category"] !== "product") {
        return err("not_authorized", "只有在职产品岗位能登记调研卡。");
      }
    }
    const day = req.day ?? localDay(o.nowMs);
    if (req.url !== undefined) {
      const existing = one(
        db,
        `SELECT ${RESEARCH_COLS} FROM research_cards WHERE day = ? AND url = ?`,
        [day, req.url],
      );
      if (existing !== undefined) {
        const item = researchView(existing);
        return {
          ok: true as const,
          item,
          created: false as const,
          auditSeq: -1 as const,
          ...(item.doc_id === null
            ? {}
            : { document: { doc_id: item.doc_id } }),
          ...(item.backlog_item_id === null
            ? {}
            : { backlogItemId: item.backlog_item_id }),
        };
      }
    }
    const cardId = o.newId?.() ?? randomUUID();
    const deposited = insertAutoDocument(db, {
      title: `调研建议：${req.title}`,
      bodyText: researchMarkdown(req, day),
      groupId: req.group_id ?? null,
      actor: o.actor,
      nowMs: o.nowMs,
      newId: o.newDocId ?? randomUUID,
    });
    const backlogId = o.newBacklogId?.() ?? randomUUID();
    run(
      db,
      "INSERT INTO backlog_items" +
        " (id, group_id, title, detail, state, priority, due_at, parent_id, merged_into, created_at, updated_at)" +
        " VALUES (?, ?, ?, ?, 'backlog', 0, NULL, NULL, NULL, ?, ?)",
      [
        backlogId,
        req.group_id ?? null,
        `调研建议：${req.title}`,
        req.summary,
        o.nowMs,
        o.nowMs,
      ],
    );
    const backlogAuditSeq = appendAudit(
      db,
      {
        taskId: null,
        actorType: actorIdentity(o.actor).actorType,
        actorId: actorIdentity(o.actor).actorId,
        action: "state_change",
        target: backlogId,
        payload: {
          kind: "backlog_changed",
          op: "create",
          backlog_item_id: backlogId,
          group_id: req.group_id ?? null,
          origin: "research",
          research_card_id: cardId,
        },
        createdAt: o.nowMs,
      },
      () => o.nowMs,
    );
    run(
      db,
      "INSERT INTO research_cards" +
        " (card_id, day, source, title, summary, url, created_at, group_id, backlog_item_id, doc_id)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        cardId,
        day,
        req.source,
        req.title,
        req.summary,
        req.url ?? null,
        o.nowMs,
        req.group_id ?? null,
        backlogId,
        deposited.documentId,
      ],
    );
    const row = one(
      db,
      `SELECT ${RESEARCH_COLS} FROM research_cards WHERE card_id = ?`,
      [cardId],
    );
    if (row === undefined)
      throw new Error("rhythm/service：调研卡写入后读不回。");
    const item = researchView(row);
    const identity = actorIdentity(o.actor);
    const auditSeq = appendAudit(
      db,
      {
        taskId: null,
        actorType: identity.actorType,
        actorId: identity.actorId,
        action: "state_change",
        target: item.card_id,
        payload: {
          kind: "research_card_created",
          card_id: item.card_id,
          day,
          url: item.url,
          group_id: item.group_id,
          backlog_item_id: item.backlog_item_id,
          doc_id: item.doc_id,
        },
        createdAt: o.nowMs,
      },
      () => o.nowMs,
    );
    return {
      ok: true as const,
      item,
      created: true as const,
      auditSeq,
      document: { doc_id: deposited.documentId },
      backlogItemId: backlogId,
      deliveries: [
        {
          event: {
            kind: "DocumentChanged",
            docId: deposited.documentId,
            op: "created",
          } as const,
          seq: deposited.auditSeq,
        },
        {
          event: {
            kind: "BacklogChanged",
            backlogItemId: backlogId,
            op: "create",
          } as const,
          seq: backlogAuditSeq,
        },
        {
          event: {
            kind: "ResearchCardCreated",
            cardId: item.card_id,
            day: item.day,
          } as const,
          seq: auditSeq,
        },
      ],
    };
  });
  if (!wrote.ok) return wrote;
  if (!wrote.created) return wrote;
  const { deliveries, ...result } = wrote;
  return { ...result, ...publishDeliveries(bus, deliveries) };
}
