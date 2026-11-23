import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type HireMemberRequest,
  MENTION_BOSS,
  openPrivateRequestSchema,
  type Persona,
} from "@opc/contracts";
import { afterAll, describe, expect, it } from "vitest";
import {
  BOSS_READER,
  conversationServiceStatus,
  ensureGroupConversation,
  insertCardMessage,
  listConversations,
  listMessages,
  markRead,
  openPrivate,
  resolveMentions,
  sendMessage,
} from "../../src/conversations/service.js";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import type { DomainEvent, EventBus } from "../../src/events/bus.js";
import { createGroup } from "../../src/groups/service.js";
import { hireMember, updateMember } from "../../src/members/service.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("conversations", import.meta.url);
mkdirSync(TMP, { recursive: true });
const NOW = Date.UTC(2026, 10, 23);
const queues: WriteQueue[] = [];
let fileSeq = 0;

class RecordingBus implements EventBus {
  readonly published: { event: DomainEvent; seq: number }[] = [];
  fail = false;

  publishPersisted(event: DomainEvent, seq: number): void {
    if (this.fail) throw new Error("bus unavailable");
    this.published.push({ event, seq });
  }

  subscribe(): never {
    throw new Error("not used by service tests");
  }

  latestSeq(): number {
    return this.published.at(-1)?.seq ?? 0;
  }
}

const PERSONA: Persona = {
  style: "read first",
  values: ["evidence"],
  honesty: "test before claiming",
};

async function hire(q: WriteQueue, id: string, roleId = "dev"): Promise<void> {
  const req: HireMemberRequest = {
    name: `Member ${id}`,
    role_id: roleId,
    model_tier: "execution",
    persona: PERSONA,
    tone: "direct",
    skills: [],
    executors: [
      {
        seq: 1,
        kind: "pure-model",
        config: { kind: "pure-model" },
        enabled: true,
      },
    ],
    seat_group_ids: [],
  };
  const result = await hireMember(q, { req, nowMs: NOW, newId: () => id });
  if (!result.ok)
    throw new Error(`hire ${id}: ${result.code} ${result.reason}`);
}

async function world(): Promise<{
  q: WriteQueue;
  db: DatabaseSync;
  bus: RecordingBus;
  groupId: string;
  conversationId: string;
  cosId: string;
}> {
  const q = new WriteQueue(join(TMP, `conv-${process.pid}-${++fileSeq}.db`));
  queues.push(q);
  const db = q.writeConnection();
  migrate(db);
  await hire(q, "m-a");
  await hire(q, "m-b", "qa");
  await hire(q, "m-c", "product_director");
  const group = await createGroup(q, {
    req: { title: "Launch", goal: "Ship", member_ids: ["m-a", "m-b"] },
    nowMs: NOW,
  });
  expect(group.ok).toBe(true);
  if (!group.ok) throw new Error(group.reason);
  return {
    q,
    db,
    bus: new RecordingBus(),
    groupId: group.group.group_id,
    conversationId: group.conversation_id,
    cosId: group.group.cos_member_id ?? "",
  };
}

function eventCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM events").get() as {
    count: number;
  };
  return row.count;
}

function messageCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM messages").get() as {
    count: number;
  };
  return row.count;
}

function findConversation(db: DatabaseSync, reader: string, id: string) {
  return listConversations(db, reader).find(
    (row) => row.conversation_id === id,
  );
}

afterAll(async () => {
  for (const q of queues) {
    try {
      await q.close();
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

describe("mention parsing", () => {
  it("normalizes boss aliases, respects token boundaries, and deduplicates in body order", () => {
    const members = [
      { memberId: "m-a", name: "Alice" },
      { memberId: "m-b", name: "Bob" },
      { memberId: "m-c", name: "张三" },
    ];
    expect(
      resolveMentions(
        "@老板 @Alice @张三丰 @张三 @Bob @boss @m-a @unknown",
        members,
      ),
    ).toEqual([MENTION_BOSS, "m-a", "m-c", "m-b"]);
    expect(resolveMentions("plain text", members)).toEqual([]);
  });

  it("uses the first member for duplicate names instead of guessing", () => {
    expect(
      resolveMentions("@Same", [
        { memberId: "first", name: "Same" },
        { memberId: "second", name: "Same" },
      ]),
    ).toEqual(["first"]);
  });
});

describe("conversation containers", () => {
  it("normalizes and idempotently opens a private conversation", async () => {
    const { q, db } = await world();
    const before = eventCount(db);
    const first = await openPrivate(q, {
      memberA: "m-b",
      memberB: "m-a",
      nowMs: NOW,
      newId: () => "private-1",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.created).toBe(true);
    expect(first.conversation.member_a).toBe("m-a");
    expect(first.conversation.member_b).toBe("m-b");
    expect(first.conversation.title).toBe("Member m-a、Member m-b");

    const again = await openPrivate(q, {
      memberA: "m-a",
      memberB: "m-b",
      nowMs: NOW + 1,
      newId: () => "must-not-be-used",
    });
    expect(again.ok && again.created).toBe(false);
    expect(again.ok && again.conversation.conversation_id).toBe("private-1");
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM conversations WHERE kind = 'private'",
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(eventCount(db)).toBe(before);
  });

  it("accepts boss-member pairs in either order while rejecting boss/boss and self chat", () => {
    expect(
      openPrivateRequestSchema.safeParse({ member_a: "boss", member_b: "m-a" })
        .success,
    ).toBe(true);
    expect(
      openPrivateRequestSchema.safeParse({ member_a: "m-a", member_b: "boss" })
        .success,
    ).toBe(true);
    expect(
      openPrivateRequestSchema.safeParse({ member_a: "m-a", member_b: "m-b" })
        .success,
    ).toBe(true);
    expect(
      openPrivateRequestSchema.safeParse({ member_a: "boss", member_b: "boss" })
        .success,
    ).toBe(false);
    expect(
      openPrivateRequestSchema.safeParse({ member_a: "m-a", member_b: "m-a" })
        .success,
    ).toBe(false);
  });

  it("opens a normalized, idempotent boss-member thread visible to both readers", async () => {
    const { q, db } = await world();
    const first = await openPrivate(q, {
      memberA: "m-a",
      memberB: "boss",
      nowMs: NOW,
      newId: () => "boss-private-1",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.created).toBe(true);
    expect(first.conversation).toMatchObject({
      conversation_id: "boss-private-1",
      member_a: "boss",
      member_b: "m-a",
      title: "老板、Member m-a",
    });

    const again = await openPrivate(q, {
      memberA: "boss",
      memberB: "m-a",
      nowMs: NOW + 1,
      newId: () => "must-not-be-used",
    });
    expect(again.ok && again.created).toBe(false);
    expect(again.ok && again.conversation.conversation_id).toBe(
      "boss-private-1",
    );
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM conversations WHERE kind = 'private'",
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(findConversation(db, BOSS_READER, "boss-private-1")).toBeDefined();
    expect(findConversation(db, "m-a", "boss-private-1")).toBeDefined();
    expect(findConversation(db, "m-b", "boss-private-1")).toBeUndefined();
  });

  it("rejects boss/boss, missing participants, and archived members without writing", async () => {
    const { q, db } = await world();
    expect(
      await openPrivate(q, {
        memberA: "boss",
        memberB: "boss",
        nowMs: NOW,
      }),
    ).toMatchObject({ ok: false, code: "self_chat" });
    expect(
      await openPrivate(q, {
        memberA: "boss",
        memberB: "ghost",
        nowMs: NOW,
      }),
    ).toMatchObject({ ok: false, code: "member_not_found" });
    const existing = await openPrivate(q, {
      memberA: "m-a",
      memberB: "m-b",
      nowMs: NOW,
      newId: () => "private-before-archive",
    });
    expect(existing.ok).toBe(true);
    await updateMember(q, {
      memberId: "m-b",
      req: { status: "archived" },
      nowMs: NOW + 1,
    });
    expect(
      await openPrivate(q, {
        memberA: "m-b",
        memberB: "m-a",
        nowMs: NOW + 2,
      }),
    ).toMatchObject({ ok: false, code: "member_archived" });
    expect(
      await openPrivate(q, {
        memberA: "boss",
        memberB: "m-b",
        nowMs: NOW + 2,
      }),
    ).toMatchObject({ ok: false, code: "member_archived" });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM conversations WHERE kind = 'private'",
        )
        .get(),
    ).toEqual({ count: 1 });
  });

  it("rejects self chat and unknown members without writing a container", async () => {
    const { q, db } = await world();
    const self = await openPrivate(q, {
      memberA: "m-a",
      memberB: "m-a",
      nowMs: NOW,
    });
    expect(self).toMatchObject({ ok: false, code: "self_chat" });
    const missing = await openPrivate(q, {
      memberA: "m-a",
      memberB: "ghost",
      nowMs: NOW,
    });
    expect(missing).toMatchObject({ ok: false, code: "member_not_found" });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM conversations WHERE kind = 'private'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("repairs a missing group conversation idempotently without inventing an audit event", async () => {
    const { q, db, groupId } = await world();
    db.prepare("DELETE FROM conversations WHERE group_id = ?").run(groupId);
    const before = eventCount(db);
    const first = await ensureGroupConversation(q, {
      groupId,
      nowMs: NOW,
      newId: () => "repaired-conv",
    });
    expect(first).toMatchObject({ ok: true, created: true });
    const second = await ensureGroupConversation(q, {
      groupId,
      nowMs: NOW + 1,
      newId: () => "unused",
    });
    expect(second).toMatchObject({ ok: true, created: false });
    expect(eventCount(db)).toBe(before);
  });
});

describe("sendMessage", () => {
  it("writes message, normalized mentions, audit, and broadcast as one committed fact", async () => {
    const { q, db, bus, groupId, conversationId } = await world();
    const result = await sendMessage(q, bus, {
      conversationId,
      author: { kind: "member", memberId: "m-a" },
      req: { body: "  @老板 please decide  ", reply_to: undefined },
      nowMs: NOW,
      newId: () => "msg-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message).toMatchObject({
      message_id: "msg-1",
      body: "@老板 please decide",
      mentions: [MENTION_BOSS],
      author_kind: "member",
      sender_member_id: "m-a",
      seq_in_conv: 1,
      kind: "text",
    });
    expect(result.msgKind).toBe("mention_boss");
    const audit = db
      .prepare("SELECT id, action, payload FROM events WHERE target = ?")
      .get("msg-1") as { id: number; action: string; payload: string };
    expect(audit.action).toBe("meeting");
    expect(JSON.parse(audit.payload)).toMatchObject({
      kind: "message_posted",
      msg_kind: "mention_boss",
      mentions: [MENTION_BOSS],
      group_id: groupId,
    });
    expect(bus.published).toEqual([
      {
        event: {
          kind: "MessageReceived",
          messageId: "msg-1",
          conversationId,
          groupId,
          msgKind: "mention_boss",
        },
        seq: audit.id,
      },
    ]);
  });

  it("supports boss and member messages with audit, broadcast, and reader-specific views", async () => {
    const { q, db, bus } = await world();
    const opened = await openPrivate(q, {
      memberA: "boss",
      memberB: "m-a",
      nowMs: NOW,
      newId: () => "boss-private-chat",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const conversationId = opened.conversation.conversation_id;
    const fromBoss = await sendMessage(q, bus, {
      conversationId,
      author: { kind: "boss" },
      req: { body: "hello from boss" },
      nowMs: NOW,
      newId: () => "boss-private-msg-1",
    });
    expect(fromBoss.ok).toBe(true);
    if (!fromBoss.ok) return;
    expect(fromBoss.message).toMatchObject({
      author_kind: "boss",
      sender_member_id: null,
      seq_in_conv: 1,
    });
    const fromMember = await sendMessage(q, bus, {
      conversationId,
      author: { kind: "member", memberId: "m-a" },
      req: { body: "@老板 please decide" },
      nowMs: NOW + 1,
      newId: () => "boss-private-msg-2",
    });
    expect(fromMember.ok).toBe(true);
    if (!fromMember.ok) return;
    expect(fromMember.message).toMatchObject({
      author_kind: "member",
      sender_member_id: "m-a",
      mentions: [MENTION_BOSS],
      seq_in_conv: 2,
    });
    expect(fromMember.msgKind).toBe("mention_boss");

    const audits = db
      .prepare(
        "SELECT id, payload FROM events WHERE target IN (?, ?) ORDER BY id",
      )
      .all("boss-private-msg-1", "boss-private-msg-2") as {
      id: number;
      payload: string;
    }[];
    expect(audits.map((row) => JSON.parse(row.payload))).toMatchObject([
      { kind: "message_posted", author_kind: "boss", group_id: null },
      {
        kind: "message_posted",
        author_kind: "member",
        group_id: null,
        mentions: [MENTION_BOSS],
      },
    ]);
    expect(bus.published).toEqual([
      {
        event: {
          kind: "MessageReceived",
          messageId: "boss-private-msg-1",
          conversationId,
          groupId: null,
          msgKind: "message",
        },
        seq: audits[0]?.id,
      },
      {
        event: {
          kind: "MessageReceived",
          messageId: "boss-private-msg-2",
          conversationId,
          groupId: null,
          msgKind: "mention_boss",
        },
        seq: audits[1]?.id,
      },
    ]);

    const read = await markRead(q, {
      conversationId,
      reader: BOSS_READER,
      req: {},
      nowMs: NOW + 2,
    });
    expect(read).toMatchObject({ ok: true, last_seq_in_conv: 2 });
    const bossView = await openPrivate(q, {
      memberA: "m-a",
      memberB: "boss",
      nowMs: NOW + 3,
    });
    expect(bossView.ok && bossView.conversation.unread_count).toBe(0);
    const memberView = await openPrivate(q, {
      memberA: "boss",
      memberB: "m-a",
      nowMs: NOW + 3,
      reader: "m-a",
    });
    expect(memberView.ok && memberView.conversation.unread_count).toBe(2);

    const outsider = await sendMessage(q, bus, {
      conversationId,
      author: { kind: "member", memberId: "m-b" },
      req: { body: "let me in" },
      nowMs: NOW + 4,
    });
    expect(outsider).toMatchObject({ ok: false, code: "not_participant" });
    await updateMember(q, {
      memberId: "m-a",
      req: { status: "archived" },
      nowMs: NOW + 5,
    });
    const archived = await sendMessage(q, bus, {
      conversationId,
      author: { kind: "member", memberId: "m-a" },
      req: { body: "late message" },
      nowMs: NOW + 6,
    });
    expect(archived).toMatchObject({ ok: false, code: "member_archived" });
    expect(messageCount(db)).toBe(2);
    expect(bus.published).toHaveLength(2);
    expect(findConversation(db, "m-a", conversationId)).toBeDefined();
  });

  it("keeps a committed message when broadcast fails and surfaces the delivery error", async () => {
    const { q, db, bus, conversationId } = await world();
    bus.fail = true;
    const result = await sendMessage(q, bus, {
      conversationId,
      author: { kind: "boss" },
      req: { body: "still stored" },
      nowMs: NOW,
      newId: () => "msg-broadcast-fail",
    });
    expect(result).toMatchObject({
      ok: true,
      message: { message_id: "msg-broadcast-fail" },
      broadcastError: "bus unavailable",
    });
    expect(messageCount(db)).toBe(1);
    expect(eventCount(db)).toBeGreaterThan(0);
  });

  it("rejects invalid bodies, outsiders, archived members, and cross-conversation replies atomically", async () => {
    const { q, db, bus, conversationId } = await world();
    const invalid = await sendMessage(q, bus, {
      conversationId,
      author: { kind: "boss" },
      req: { body: "   " },
      nowMs: NOW,
    });
    expect(invalid).toMatchObject({ ok: false, code: "bad_body" });
    const outsider = await sendMessage(q, bus, {
      conversationId,
      author: { kind: "member", memberId: "m-c" },
      req: { body: "let me in" },
      nowMs: NOW,
    });
    expect(outsider).toMatchObject({ ok: false, code: "not_participant" });

    const privateResult = await openPrivate(q, {
      memberA: "m-a",
      memberB: "m-c",
      nowMs: NOW,
      newId: () => "private-other",
    });
    expect(privateResult.ok).toBe(true);
    if (!privateResult.ok) return;
    const otherMessage = await sendMessage(q, bus, {
      conversationId: privateResult.conversation.conversation_id,
      author: { kind: "member", memberId: "m-a" },
      req: { body: "private" },
      nowMs: NOW,
      newId: () => "private-msg",
    });
    expect(otherMessage.ok).toBe(true);
    const crossReply = await sendMessage(q, bus, {
      conversationId,
      author: { kind: "boss" },
      req: { body: "wrong thread", reply_to: "private-msg" },
      nowMs: NOW,
    });
    expect(crossReply).toMatchObject({ ok: false, code: "reply_not_found" });

    await updateMember(q, {
      memberId: "m-b",
      req: { status: "archived" },
      nowMs: NOW,
    });
    const archived = await sendMessage(q, bus, {
      conversationId,
      author: { kind: "member", memberId: "m-b" },
      req: { body: "late message" },
      nowMs: NOW,
    });
    expect(archived).toMatchObject({ ok: false, code: "member_archived" });
    expect(messageCount(db)).toBe(1);
    expect(bus.published).toHaveLength(1);
  });

  it("maps resource errors to 404, semantic errors to 422, and write failures to 500", () => {
    expect(conversationServiceStatus("conversation_not_found")).toBe(404);
    expect(conversationServiceStatus("group_not_found")).toBe(404);
    expect(conversationServiceStatus("bad_body")).toBe(422);
    expect(conversationServiceStatus("not_participant")).toBe(422);
    expect(conversationServiceStatus("not_writable")).toBe(500);
  });
});

describe("boss attention", () => {
  it("does not count ordinary unread messages as boss attention", async () => {
    const { q, db, bus, conversationId } = await world();
    const sent = await sendMessage(q, bus, {
      conversationId,
      author: { kind: "member", memberId: "m-a" },
      req: { body: "status update" },
      nowMs: NOW,
      newId: () => "ordinary-msg",
    });
    expect(sent.ok).toBe(true);
    expect(findConversation(db, BOSS_READER, conversationId)).toMatchObject({
      unread_count: 1,
      boss_attention_count: 0,
    });
  });

  it("counts an unread @boss message", async () => {
    const { q, db, bus, conversationId } = await world();
    const sent = await sendMessage(q, bus, {
      conversationId,
      author: { kind: "member", memberId: "m-a" },
      req: { body: "@boss please decide" },
      nowMs: NOW,
      newId: () => "boss-msg",
    });
    expect(sent.ok).toBe(true);
    expect(findConversation(db, BOSS_READER, conversationId)).toMatchObject({
      unread_count: 1,
      boss_attention_count: 1,
    });
  });

  it("counts multiple @boss messages once per message", async () => {
    const { q, db, bus, conversationId } = await world();
    for (const [index, body] of [
      "@boss @老板 decide",
      "@boss next decision",
      "ordinary follow-up",
    ].entries()) {
      const sent = await sendMessage(q, bus, {
        conversationId,
        author: { kind: "member", memberId: "m-a" },
        req: { body },
        nowMs: NOW + index,
        newId: () => `attention-msg-${index}`,
      });
      expect(sent.ok).toBe(true);
    }
    expect(findConversation(db, BOSS_READER, conversationId)).toMatchObject({
      unread_count: 3,
      boss_attention_count: 2,
    });
  });

  it("returns the field for members and clears it after the reader marks read", async () => {
    const { q, db, bus, conversationId } = await world();
    const sent = await sendMessage(q, bus, {
      conversationId,
      author: { kind: "member", memberId: "m-a" },
      req: { body: "@boss please decide" },
      nowMs: NOW,
      newId: () => "reader-specific-msg",
    });
    expect(sent.ok).toBe(true);
    expect(findConversation(db, "m-a", conversationId)).toMatchObject({
      unread_count: 1,
      boss_attention_count: 1,
    });

    const read = await markRead(q, {
      conversationId,
      reader: BOSS_READER,
      req: {},
      nowMs: NOW + 1,
    });
    expect(read).toMatchObject({ ok: true, last_seq_in_conv: 1 });
    expect(findConversation(db, BOSS_READER, conversationId)).toMatchObject({
      unread_count: 0,
      boss_attention_count: 0,
    });
    expect(findConversation(db, "m-a", conversationId)).toMatchObject({
      unread_count: 1,
      boss_attention_count: 1,
    });
  });

  it("keeps the conversation list readable when mentions_json is malformed", async () => {
    const { db, conversationId } = await world();
    const insert =
      "INSERT INTO messages (message_id, conversation_id, sender_member_id, author_kind," +
      " body, mentions_json, reply_to, kind, seq_in_conv, created_at)" +
      " VALUES (?, ?, NULL, 'system', ?, ?, NULL, 'system', ?, ?)";
    db.prepare(insert).run(
      "bad-json-msg",
      conversationId,
      "legacy broken",
      "{broken",
      1,
      NOW,
    );
    db.prepare(insert).run(
      "not-array-msg",
      conversationId,
      "legacy object",
      JSON.stringify({ mention: MENTION_BOSS }),
      2,
      NOW,
    );
    db.prepare(insert).run(
      "valid-boss-msg",
      conversationId,
      "valid mention",
      JSON.stringify([MENTION_BOSS]),
      3,
      NOW,
    );

    expect(findConversation(db, BOSS_READER, conversationId)).toMatchObject({
      unread_count: 3,
      boss_attention_count: 1,
    });
  });
});

describe("history, visibility, unread, and cards", () => {
  it("paginates oldest-first and derives unread counts including card messages", async () => {
    const { q, db, bus, groupId, conversationId } = await world();
    for (let index = 1; index <= 3; index += 1) {
      const sent = await sendMessage(q, bus, {
        conversationId,
        author: { kind: "boss" },
        req: { body: `message ${index}` },
        nowMs: NOW + index,
        newId: () => `msg-${index}`,
      });
      expect(sent.ok).toBe(true);
    }
    db.prepare(
      "INSERT INTO backlog_items (id, group_id, title, state, created_at, updated_at)" +
        " VALUES ('backlog-1', ?, 'Later', 'backlog', ?, ?)",
    ).run(groupId, NOW, NOW);
    await q.node(() => {
      insertCardMessage({
        conversationId,
        kind: "backlog_card",
        refId: "backlog-1",
        body: "Backlog card",
        nowMs: NOW + 4,
        newId: () => "card-1",
      });
    });

    const page = listMessages(db, conversationId, { before_seq: 4, limit: 2 });
    expect(
      page.ok && page.messages.map((message) => message.seq_in_conv),
    ).toEqual([2, 3]);
    expect(
      findConversation(db, BOSS_READER, conversationId)?.unread_count,
    ).toBe(4);
    expect(listMessages(db, conversationId, { limit: 201 })).toMatchObject({
      ok: false,
      code: "bad_query",
    });

    const read = await markRead(q, {
      conversationId,
      reader: BOSS_READER,
      req: { last_seq_in_conv: 3 },
      nowMs: NOW + 5,
    });
    expect(read).toMatchObject({ ok: true, last_seq_in_conv: 3, auditSeq: -1 });
    expect(
      findConversation(db, BOSS_READER, conversationId)?.unread_count,
    ).toBe(1);
    const backwards = await markRead(q, {
      conversationId,
      reader: BOSS_READER,
      req: { last_seq_in_conv: 1 },
      nowMs: NOW + 6,
    });
    expect(backwards).toMatchObject({ ok: true, last_seq_in_conv: 3 });
    const latest = await markRead(q, {
      conversationId,
      reader: BOSS_READER,
      req: {},
      nowMs: NOW + 7,
    });
    expect(latest).toMatchObject({ ok: true, last_seq_in_conv: 4 });
    expect(
      findConversation(db, BOSS_READER, conversationId)?.unread_count,
    ).toBe(0);
  });

  it("rejects out-of-range read cursors and missing conversations without moving state", async () => {
    const { q, db, conversationId } = await world();
    const result = await markRead(q, {
      conversationId,
      reader: BOSS_READER,
      req: { last_seq_in_conv: 1 },
      nowMs: NOW,
    });
    expect(result).toMatchObject({ ok: false, code: "seq_out_of_range" });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM message_reads").get(),
    ).toEqual({ count: 0 });
    expect(
      await markRead(q, {
        conversationId: "missing",
        reader: BOSS_READER,
        req: {},
        nowMs: NOW,
      }),
    ).toMatchObject({ ok: false, code: "conversation_not_found" });
  });

  it("shows members only their private threads and seated groups while boss sees all", async () => {
    const { q, db, conversationId } = await world();
    const otherGroup = await createGroup(q, {
      req: { title: "Other", goal: "Other", member_ids: ["m-c"] },
      nowMs: NOW,
    });
    expect(otherGroup.ok).toBe(true);
    if (!otherGroup.ok) return;
    const privateThread = await openPrivate(q, {
      memberA: "m-a",
      memberB: "m-c",
      nowMs: NOW,
      newId: () => "private-ac",
    });
    expect(privateThread.ok).toBe(true);
    const visibleToA = listConversations(db, "m-a").map(
      (row) => row.conversation_id,
    );
    expect(visibleToA).toContain(conversationId);
    expect(visibleToA).toContain("private-ac");
    expect(visibleToA).not.toContain(otherGroup.conversation_id);
    const visibleToBoss = listConversations(db, BOSS_READER).map(
      (row) => row.conversation_id,
    );
    expect(visibleToBoss).toContain(otherGroup.conversation_id);
  });

  it("refuses to build a card for a missing entity and rolls back the caller node", async () => {
    const { q, db, conversationId } = await world();
    await expect(
      q.node(() => {
        insertCardMessage({
          conversationId,
          kind: "meeting_card",
          refId: "missing-meeting",
          body: "Meeting",
          nowMs: NOW,
        });
      }),
    ).rejects.toThrow(/不在.*meetings/u);
    expect(messageCount(db)).toBe(0);
  });

  it("rejects malformed stored mentions instead of silently rendering an empty list", async () => {
    const { db, conversationId } = await world();
    db.prepare(
      "INSERT INTO messages (message_id, conversation_id, sender_member_id, author_kind," +
        " body, mentions_json, reply_to, kind, seq_in_conv, created_at)" +
        " VALUES ('bad-json', ?, NULL, 'system', 'legacy', '{broken', NULL, 'system', 1, ?)",
    ).run(conversationId, NOW);
    expect(() => listMessages(db, conversationId, {})).toThrow(
      /mentions_json.*JSON/u,
    );
  });
});
