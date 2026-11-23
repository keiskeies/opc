/** Six-face global search. FTS faces use trigram phrases; the other faces use escaped LIKE. */

import type { DatabaseSync } from "node:sqlite";
import {
  SEARCH_FACES,
  type SearchFace,
  type SearchHit,
  type SearchQuery,
  searchQuerySchema,
} from "@opc/contracts";
import { assertParamCount, assertSingleStatement } from "../db/write-queue.js";
import { escapeLikePattern, quoteFtsPhrase } from "../replay/search.js";

export type SearchResult =
  | { readonly ok: true; readonly hits: SearchHit[] }
  | { readonly ok: false; readonly code: "bad_query"; readonly reason: string };

type DbLike = Pick<DatabaseSync, "prepare">;
type Row = Record<string, unknown>;

const MESSAGE_SQL =
  "SELECT m.message_id AS id, substr(m.body, 1, 120) AS title, " +
  "snippet(messages_fts, 0, '<mark>', '</mark>', '…', 24) AS snippet, " +
  "m.conversation_id AS conversation_id, c.group_id AS group_id, " +
  "m.created_at AS at FROM messages_fts " +
  "JOIN messages m ON m.rowid = messages_fts.rowid " +
  "JOIN conversations c ON c.conversation_id = m.conversation_id " +
  "WHERE messages_fts MATCH ? ORDER BY m.created_at DESC, m.message_id DESC LIMIT ?";

const DOCUMENT_SQL =
  "SELECT d.doc_id AS id, d.title AS title, " +
  "snippet(documents_fts, 1, '<mark>', '</mark>', '…', 24) AS snippet, " +
  "NULL AS conversation_id, d.group_id AS group_id, d.updated_at AS at " +
  "FROM documents_fts JOIN documents d ON d.rowid = documents_fts.rowid " +
  "WHERE documents_fts MATCH ? AND d.deleted_at IS NULL " +
  "ORDER BY d.updated_at DESC, d.doc_id DESC LIMIT ?";

const GROUP_SQL =
  "SELECT group_id AS id, title AS title, substr(goal, 1, 240) AS snippet," +
  " NULL AS conversation_id, group_id AS group_id, updated_at AS at FROM groups" +
  " WHERE title LIKE ? ESCAPE '\\' OR goal LIKE ? ESCAPE '\\'" +
  " ORDER BY updated_at DESC, group_id DESC LIMIT ?";

const TASK_SQL =
  "SELECT id AS id, title AS title, substr(title, 1, 240) AS snippet, " +
  "NULL AS conversation_id, NULL AS group_id, updated_at AS at FROM tasks " +
  "WHERE title LIKE ? ESCAPE '\\' ORDER BY updated_at DESC, id DESC LIMIT ?";

const MEMBER_SQL =
  "SELECT member_id AS id, name AS title, substr(persona_json, 1, 240) AS snippet, " +
  "NULL AS conversation_id, NULL AS group_id, updated_at AS at FROM members " +
  "WHERE name LIKE ? ESCAPE '\\' OR persona_json LIKE ? ESCAPE '\\' " +
  "ORDER BY updated_at DESC, member_id DESC LIMIT ?";

const MEETING_SQL =
  "SELECT id AS id, topic AS title, substr(topic, 1, 240) AS snippet, " +
  "NULL AS conversation_id, group_id AS group_id, created_at AS at FROM meetings " +
  "WHERE topic LIKE ? ESCAPE '\\' OR participants LIKE ? ESCAPE '\\' " +
  "ORDER BY created_at DESC, id DESC LIMIT ?";

const BACKLOG_SQL =
  "SELECT id AS id, title AS title, " +
  "CASE WHEN detail = '' THEN substr(title, 1, 240) ELSE substr(detail, 1, 240) END AS snippet, " +
  "NULL AS conversation_id, group_id AS group_id, updated_at AS at FROM backlog_items " +
  "WHERE title LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\' " +
  "ORDER BY updated_at DESC, id DESC LIMIT ?";

function queryRows(
  db: DbLike,
  face: SearchFace,
  query: SearchQuery,
): SearchHit[] {
  const phrase = quoteFtsPhrase(query.q);
  const like = "%" + escapeLikePattern(query.q) + "%";
  let sql: string;
  let params: unknown[];
  switch (face) {
    case "message":
      sql = MESSAGE_SQL;
      params = [phrase, query.limit];
      break;
    case "document":
      sql = DOCUMENT_SQL;
      params = [phrase, query.limit];
      break;
    case "group":
    case "task":
      sql = face === "group" ? GROUP_SQL : TASK_SQL;
      params =
        face === "group" ? [like, like, query.limit] : [like, query.limit];
      break;
    case "member":
    case "meeting":
    case "backlog":
      sql =
        face === "member"
          ? MEMBER_SQL
          : face === "meeting"
            ? MEETING_SQL
            : BACKLOG_SQL;
      params = [like, like, query.limit];
      break;
  }
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  const rows = db.prepare(sql).all(...(params as never[])) as unknown as Row[];
  return rows.map((row) => ({
    face,
    id: String(row["id"]),
    title: String(row["title"]),
    snippet: row["snippet"] === null ? null : String(row["snippet"]),
    conversation_id:
      row["conversation_id"] === null ? null : String(row["conversation_id"]),
    group_id: row["group_id"] === null ? null : String(row["group_id"]),
    at: Number(row["at"]),
  }));
}

/** Validate once, fetch enough rows from each selected face, then merge and limit globally. */
export function searchAll(db: DbLike, rawQuery: unknown): SearchResult {
  const parsed = searchQuerySchema.safeParse(rawQuery);
  if (!parsed.success) {
    return {
      ok: false,
      code: "bad_query",
      reason: parsed.error.issues
        .map((issue) => issue.path.join(".") + " " + issue.message)
        .join("；"),
    };
  }
  const query = parsed.data;
  const selected = new Set(query.faces ?? SEARCH_FACES);
  const hits: SearchHit[] = [];
  for (const face of SEARCH_FACES) {
    if (selected.has(face)) hits.push(...queryRows(db, face, query));
  }
  hits.sort(
    (a, b) =>
      b.at - a.at || a.face.localeCompare(b.face) || a.id.localeCompare(b.id),
  );
  return { ok: true, hits: hits.slice(0, query.limit) };
}
