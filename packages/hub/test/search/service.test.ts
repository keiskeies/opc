import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { openDb } from "../../src/db/driver.js";
import { migrate } from "../../src/db/migrate.js";
import { searchAll } from "../../src/search/service.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("search", import.meta.url);
mkdirSync(TMP, { recursive: true });
const NOW = Date.UTC(2026, 10, 23);
const opened: DatabaseSync[] = [];

function db(): DatabaseSync {
  const connection = openDb(
    join(TMP, `search-${process.pid}-${opened.length}.db`),
  );
  opened.push(connection);
  migrate(connection);
  return connection;
}

afterAll(() => {
  for (const connection of opened) {
    try {
      connection.close();
    } catch {
      // Already closed.
    }
  }
  let cleared = false;
  for (let attempt = 0; attempt < 40 && !cleared; attempt += 1) {
    try {
      rmSync(TMP, { recursive: true, force: true });
      cleared = true;
    } catch (error) {
      if (attempt === 39) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
});

describe("seven-face global search", () => {
  it("finds group/task/member/message/document/meeting/backlog and sorts by time", () => {
    const connection = db();
    connection
      .prepare(
        "INSERT INTO groups (group_id, title, goal, status, created_at, updated_at)" +
          " VALUES ('g-search', '双十一项目', 'ship', 'active', ?, ?)",
      )
      .run(NOW, NOW);
    connection
      .prepare(
        "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at)" +
          " VALUES ('task-1', '双十一任务', 'pending', 'dev', 'start', ?, ?)",
      )
      .run(NOW, NOW);
    for (const id of ["m-1", "m-2"]) {
      connection
        .prepare(
          "INSERT INTO members (member_id, name, role_id, persona_json, model_tier, status, hired_at, updated_at)" +
            " VALUES (?, ?, 'dev', ?, 'execution', 'active', ?, ?)",
        )
        .run(id, id, JSON.stringify({ style: "双十一" }), NOW, NOW);
    }
    connection
      .prepare(
        "INSERT INTO conversations (conversation_id, kind, member_a, member_b, title, created_at)" +
          " VALUES ('conv-1', 'private', 'm-1', 'm-2', '双十一', ?)",
      )
      .run(NOW);
    connection
      .prepare(
        "INSERT INTO messages (message_id, conversation_id, sender_member_id, author_kind, body," +
          " mentions_json, kind, seq_in_conv, created_at) VALUES ('msg-1', 'conv-1', 'm-1', 'member'," +
          " '双十一消息', '[]', 'text', 1, ?)",
      )
      .run(NOW);
    connection
      .prepare(
        "INSERT INTO documents (doc_id, kind, title, owner, body_text, origin, created_at, updated_at)" +
          " VALUES ('doc-1', 'markdown', '双十一文档', 'boss', '正文', 'created', ?, ?)",
      )
      .run(NOW, NOW);
    connection
      .prepare(
        "INSERT INTO meetings (id, meeting_type, participants, topic, created_at)" +
          " VALUES ('meeting-1', 'review', '[]', '双十一会议', ?)",
      )
      .run(NOW);
    connection
      .prepare(
        "INSERT INTO backlog_items (id, title, state, created_at, updated_at)" +
          " VALUES ('backlog-1', '双十一待办', 'backlog', ?, ?)",
      )
      .run(NOW, NOW);
    const result = searchAll(connection, { q: "双十一", limit: 20 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new Set(result.hits.map((hit) => hit.face))).toEqual(
      new Set([
        "group",
        "task",
        "member",
        "message",
        "document",
        "meeting",
        "backlog",
      ]),
    );
    expect(
      result.hits.find((hit) => hit.face === "message")?.conversation_id,
    ).toBe("conv-1");
    expect(result.hits.every((hit) => hit.at === NOW)).toBe(true);
  });

  it("treats LIKE wildcards literally and excludes soft-deleted documents", () => {
    const connection = db();
    connection
      .prepare(
        "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at)" +
          " VALUES ('task-%', '100% done', 'pending', 'dev', 'start', ?, ?)," +
          " ('task-other', '100 anything done', 'pending', 'dev', 'start', ?, ?)",
      )
      .run(NOW, NOW, NOW, NOW);
    connection
      .prepare(
        "INSERT INTO documents (doc_id, kind, title, owner, body_text, origin, created_at, updated_at, deleted_at)" +
          " VALUES ('doc-deleted', 'markdown', '100% doc', 'boss', '', 'created', ?, ?, ?)",
      )
      .run(NOW, NOW, NOW);
    const result = searchAll(connection, {
      q: "%",
      faces: ["task", "document"],
    });
    expect(result).toEqual({
      ok: true,
      hits: [
        {
          face: "task",
          id: "task-%",
          title: "100% done",
          snippet: "100% done",
          conversation_id: null,
          group_id: null,
          at: NOW,
        },
      ],
    });
  });

  it("returns bad_query for empty/oversized queries", () => {
    const connection = db();
    expect(searchAll(connection, { q: " " })).toMatchObject({
      ok: false,
      code: "bad_query",
    });
    expect(searchAll(connection, { q: "x".repeat(201) })).toMatchObject({
      ok: false,
      code: "bad_query",
    });
  });
});
