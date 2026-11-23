import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { HireMemberRequest, Persona } from "@opc/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import type { DomainEvent, EventBus } from "../../src/events/bus.js";
import { createGroup } from "../../src/groups/service.js";
import {
  cancelMeeting,
  concludeMeeting,
  createMeeting,
  getMeeting,
  listMeetings,
  meetingServiceStatus,
  postTurn,
} from "../../src/meetings/service.js";
import { hireMember } from "../../src/members/service.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("meetings", import.meta.url);
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

async function hire(q: WriteQueue, id: string, roleId: string): Promise<void> {
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
}> {
  const q = new WriteQueue(join(TMP, `meeting-${process.pid}-${++fileSeq}.db`));
  queues.push(q);
  const db = q.writeConnection();
  migrate(db);
  await hire(q, "pm-1", "product_director");
  await hire(q, "dev-1", "dev");
  await hire(q, "qa-1", "qa");
  const group = await createGroup(q, {
    req: {
      title: "Launch",
      goal: "Ship",
      member_ids: ["pm-1", "dev-1", "qa-1"],
    },
    nowMs: NOW,
  });
  if (!group.ok) throw new Error(group.reason);
  return {
    q,
    db,
    bus: new RecordingBus(),
    groupId: group.group.group_id,
    conversationId: group.conversation_id,
  };
}

function ids(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `generated-${index}`;
}

function eventCount(db: DatabaseSync): number {
  return (
    db.prepare("SELECT COUNT(*) AS count FROM events").get() as {
      count: number;
    }
  ).count;
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

describe("meeting lifecycle", () => {
  it("opens a meeting, inserts its group card, and publishes one audited event", async () => {
    const { q, db, bus, groupId, conversationId } = await world();
    const result = await createMeeting(q, bus, {
      req: {
        group_id: groupId,
        topic: "  Launch decision  ",
        moderator_member_id: "pm-1",
        speaking_order: ["pm-1", "dev-1", "pm-1"],
      },
      nowMs: NOW,
      newId: ids("meeting-1", "card-1"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meeting).toMatchObject({
      meeting_id: "meeting-1",
      topic: "Launch decision",
      status: "open",
      speaking_order: ["pm-1", "dev-1"],
      next_speaker_member_id: "pm-1",
      opened_at: NOW,
      turns: [],
    });
    expect(result.card_message_id).toBe("card-1");
    expect(
      db
        .prepare(
          "SELECT kind, ref_id, conversation_id FROM messages WHERE message_id = ?",
        )
        .get("card-1"),
    ).toEqual({
      kind: "meeting_card",
      ref_id: "meeting-1",
      conversation_id: conversationId,
    });
    const audit = db
      .prepare("SELECT id, action, payload FROM events WHERE target = ?")
      .get("meeting-1") as { id: number; action: string; payload: string };
    expect(audit.action).toBe("meeting");
    expect(JSON.parse(audit.payload)).toMatchObject({
      kind: "meeting_opened",
      card_message_id: "card-1",
    });
    expect(bus.published).toEqual([
      {
        event: { kind: "MeetingOpened", meetingId: "meeting-1", groupId },
        seq: audit.id,
      },
    ]);
  });

  it("defaults the speaking order to the moderator and validates participants before any repair write", async () => {
    const { q, db, bus, groupId } = await world();
    db.prepare("DELETE FROM conversations WHERE group_id = ?").run(groupId);
    const before = eventCount(db);
    const invalid = await createMeeting(q, bus, {
      req: {
        group_id: groupId,
        topic: "Invalid attendee",
        moderator_member_id: "pm-1",
        speaking_order: ["pm-1", "outsider"],
      },
      nowMs: NOW,
      newId: ids("unused-conversation", "unused-meeting", "unused-card"),
    });
    expect(invalid).toMatchObject({ ok: false, code: "member_not_found" });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM conversations WHERE group_id = ?",
        )
        .get(groupId),
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM meetings WHERE topic = ?")
        .get("Invalid attendee"),
    ).toEqual({ count: 0 });
    expect(eventCount(db)).toBe(before);

    const valid = await createMeeting(q, bus, {
      req: { group_id: groupId, topic: "Solo", moderator_member_id: "pm-1" },
      nowMs: NOW,
      newId: ids("repaired-conversation", "meeting-solo", "card-solo"),
    });
    expect(valid).toMatchObject({
      ok: true,
      meeting: { speaking_order: ["pm-1"], next_speaker_member_id: "pm-1" },
    });
  });

  it("enforces the persisted turn order and supports an explicit next speaker", async () => {
    const { q, db, bus, groupId } = await world();
    await createMeeting(q, bus, {
      req: {
        group_id: groupId,
        topic: "Turn order",
        moderator_member_id: "pm-1",
        speaking_order: ["pm-1", "dev-1", "qa-1"],
      },
      nowMs: NOW,
      newId: ids("meeting-turns", "card-turns"),
    });
    const outOfTurn = await postTurn(q, bus, {
      meetingId: "meeting-turns",
      req: { speaker_member_id: "dev-1", content: "Too early" },
      nowMs: NOW + 1,
    });
    expect(outOfTurn).toMatchObject({ ok: false, code: "not_your_turn" });
    const first = await postTurn(q, bus, {
      meetingId: "meeting-turns",
      req: { speaker_member_id: "pm-1", content: "PM first" },
      nowMs: NOW + 2,
    });
    expect(first).toMatchObject({
      ok: true,
      turn: { turn_seq: 1, speaker_member_id: "pm-1" },
      meeting: { next_speaker_member_id: "dev-1" },
    });
    const second = await postTurn(q, bus, {
      meetingId: "meeting-turns",
      req: {
        speaker_member_id: "dev-1",
        content: "Dev response",
        next_speaker_member_id: "pm-1",
      },
      nowMs: NOW + 3,
    });
    expect(second).toMatchObject({
      ok: true,
      turn: { turn_seq: 2 },
      meeting: { next_speaker_member_id: "pm-1" },
    });
    expect(
      getMeeting(db, "meeting-turns")?.turns.map((turn) => turn.turn_seq),
    ).toEqual([1, 2]);
    expect(bus.published.map(({ event }) => event.kind)).toEqual([
      "MeetingOpened",
      "MeetingTurnPosted",
      "MeetingTurnPosted",
    ]);
  });

  it("requires the conclusion trio, closes the meeting, and rejects later turns", async () => {
    const { q, db, bus, groupId } = await world();
    await createMeeting(q, bus, {
      req: {
        group_id: groupId,
        topic: "Decision",
        moderator_member_id: "pm-1",
      },
      nowMs: NOW,
      newId: ids("meeting-decision", "card-decision"),
    });
    const incomplete = await concludeMeeting(q, bus, {
      meetingId: "meeting-decision",
      req: { decision: "Ship", owner_member_id: "dev-1" },
      nowMs: NOW + 1,
    });
    expect(incomplete).toMatchObject({ ok: false, code: "bad_body" });
    const result = await concludeMeeting(q, bus, {
      meetingId: "meeting-decision",
      req: {
        decision: "Ship",
        owner_member_id: "dev-1",
        deadline_at: NOW + 1000,
      },
      nowMs: NOW + 2,
    });
    expect(result).toMatchObject({
      ok: true,
      meeting: {
        status: "concluded",
        decision: "Ship",
        owner_member_id: "dev-1",
        deadline_at: NOW + 1000,
        concluded_at: NOW + 2,
        next_speaker_member_id: null,
      },
    });
    expect(
      await postTurn(q, bus, {
        meetingId: "meeting-decision",
        req: { speaker_member_id: "pm-1", content: "Late" },
        nowMs: NOW + 3,
      }),
    ).toMatchObject({ ok: false, code: "meeting_closed" });
    expect(bus.published.at(-1)?.event).toEqual({
      kind: "MeetingConcluded",
      meetingId: "meeting-decision",
      summaryDocId: null,
    });
    expect(() =>
      db
        .prepare("UPDATE meetings SET status = 'concluded' WHERE id = ?")
        .run("meeting-decision"),
    ).not.toThrow(); // Already valid; the trio remains present.
    expect(() =>
      db
        .prepare("UPDATE meetings SET decision = NULL WHERE id = ?")
        .run("meeting-decision"),
    ).toThrow(/CHECK/u);
  });

  it("cancels with a reason and keeps the cancellation auditable", async () => {
    const { q, db, bus, groupId } = await world();
    await createMeeting(q, bus, {
      req: {
        group_id: groupId,
        topic: "Cancel me",
        moderator_member_id: "pm-1",
      },
      nowMs: NOW,
      newId: ids("meeting-cancel", "card-cancel"),
    });
    const result = await cancelMeeting(q, bus, {
      meetingId: "meeting-cancel",
      req: { reason: "Waiting on data" },
      nowMs: NOW + 1,
    });
    expect(result).toMatchObject({
      ok: true,
      meeting: {
        status: "cancelled",
        concluded_at: NOW + 1,
        next_speaker_member_id: null,
      },
    });
    expect(bus.published.at(-1)?.event).toEqual({
      kind: "MeetingCancelled",
      meetingId: "meeting-cancel",
      reason: "Waiting on data",
    });
    const payload = db
      .prepare(
        "SELECT payload FROM events WHERE target = ? ORDER BY id DESC LIMIT 1",
      )
      .get("meeting-cancel") as { payload: string };
    expect(JSON.parse(payload.payload)).toMatchObject({
      kind: "meeting_cancelled",
      reason: "Waiting on data",
    });
  });

  it("keeps a committed turn when broadcast fails and maps error categories", async () => {
    const { q, db, bus, groupId } = await world();
    await createMeeting(q, bus, {
      req: {
        group_id: groupId,
        topic: "Broadcast",
        moderator_member_id: "pm-1",
      },
      nowMs: NOW,
      newId: ids("meeting-broadcast", "card-broadcast"),
    });
    bus.fail = true;
    const result = await postTurn(q, bus, {
      meetingId: "meeting-broadcast",
      req: { speaker_member_id: "pm-1", content: "Stored" },
      nowMs: NOW + 1,
    });
    expect(result).toMatchObject({
      ok: true,
      broadcastError: "bus unavailable",
    });
    expect(getMeeting(db, "meeting-broadcast")?.turns).toHaveLength(1);
    expect(meetingServiceStatus("meeting_not_found")).toBe(404);
    expect(meetingServiceStatus("meeting_closed")).toBe(409);
    expect(meetingServiceStatus("not_your_turn")).toBe(409);
    expect(meetingServiceStatus("bad_body")).toBe(422);
    expect(meetingServiceStatus("not_writable")).toBe(500);
  });

  it("filters meeting lists by group and rejects corrupt speaking order instead of guessing", async () => {
    const { q, db, bus, groupId } = await world();
    await createMeeting(q, bus, {
      req: { group_id: groupId, topic: "List", moderator_member_id: "pm-1" },
      nowMs: NOW,
      newId: ids("meeting-list", "card-list"),
    });
    expect(
      listMeetings(db, groupId).map((meeting) => meeting.meeting_id),
    ).toEqual(["meeting-list"]);
    expect(listMeetings(db, "missing-group")).toEqual([]);
    db.prepare("UPDATE meetings SET speaking_order_json = ? WHERE id = ?").run(
      "{broken",
      "meeting-list",
    );
    expect(() => getMeeting(db, "meeting-list")).toThrow(
      /speaking_order_json.*JSON/u,
    );
  });
});
