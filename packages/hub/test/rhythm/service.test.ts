import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { HireMemberRequest, Persona } from "@opc/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import type { DomainEvent, EventBus } from "../../src/events/bus.js";
import { createGroup } from "../../src/groups/service.js";
import { hireMember } from "../../src/members/service.js";
import {
  createResearchCard,
  listResearch,
  listRhythm,
  recordRhythmEvent,
  rhythmServiceStatus,
} from "../../src/rhythm/service.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("rhythm", import.meta.url);
mkdirSync(TMP, { recursive: true });
const NOW = Date.UTC(2026, 10, 23, 2);
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
}> {
  const q = new WriteQueue(join(TMP, `rhythm-${process.pid}-${++fileSeq}.db`));
  queues.push(q);
  const db = q.writeConnection();
  migrate(db);
  await hire(q, "dev-1", "dev");
  await hire(q, "pm-1", "product_director");
  const group = await createGroup(q, {
    req: { title: "Launch", goal: "Ship", member_ids: ["dev-1", "pm-1"] },
    nowMs: NOW,
  });
  if (!group.ok) throw new Error(group.reason);
  return { q, db, bus: new RecordingBus(), groupId: group.group.group_id };
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

describe("rhythm events", () => {
  it("records a team event with audit and broadcast", async () => {
    const { q, db, bus, groupId } = await world();
    const result = await recordRhythmEvent(q, bus, {
      actor: { kind: "boss" },
      req: {
        kind: "standup",
        group_id: groupId,
        payload: { summary: "No blockers" },
      },
      nowMs: NOW,
      newId: () => "rhythm-1",
      newDocId: () => "rhythm-doc-1",
    });
    expect(result).toMatchObject({
      ok: true,
      created: true,
      item: {
        event_id: "rhythm-1",
        kind: "standup",
        group_id: groupId,
        at: NOW,
        payload: { summary: "No blockers" },
        digest_doc_id: "rhythm-doc-1",
      },
      document: { doc_id: "rhythm-doc-1" },
    });
    const audit = db
      .prepare("SELECT id, action, payload FROM events WHERE target = ?")
      .get("rhythm-1") as { id: number; action: string; payload: string };
    expect(audit.action).toBe("state_change");
    expect(JSON.parse(audit.payload)).toMatchObject({
      kind: "rhythm_recorded",
      rhythm_kind: "standup",
    });
    expect(bus.published).toEqual([
      {
        event: {
          kind: "DocumentChanged",
          docId: "rhythm-doc-1",
          op: "created",
        },
        seq: audit.id - 1,
      },
      {
        event: {
          kind: "RhythmEventRecorded",
          eventId: "rhythm-1",
          groupId,
          rhythmKind: "standup",
        },
        seq: audit.id,
      },
    ]);
  });

  it("allows product/CoS members, rejects ordinary members, and leaves no row on bad requests", async () => {
    const { q, db, bus, groupId } = await world();
    const denied = await recordRhythmEvent(q, bus, {
      actor: { kind: "member", memberId: "dev-1" },
      req: { kind: "review", group_id: groupId },
      nowMs: NOW,
    });
    expect(denied).toMatchObject({ ok: false, code: "not_authorized" });
    const allowed = await recordRhythmEvent(q, bus, {
      actor: { kind: "member", memberId: "pm-1" },
      req: { kind: "review", group_id: groupId },
      nowMs: NOW,
      newId: () => "rhythm-pm",
    });
    expect(allowed.ok).toBe(true);
    const missing = await recordRhythmEvent(q, bus, {
      actor: { kind: "boss" },
      req: { kind: "retro", group_id: "missing" },
      nowMs: NOW,
    });
    expect(missing).toMatchObject({ ok: false, code: "group_not_found" });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM rhythm_events").get(),
    ).toEqual({ count: 1 });
  });

  it("filters lists and returns bad_query instead of throwing", async () => {
    const { q, bus, groupId } = await world();
    await recordRhythmEvent(q, bus, {
      actor: { kind: "system" },
      req: { kind: "sprint_planning", group_id: groupId },
      nowMs: NOW,
      newId: () => "plan-1",
    });
    await recordRhythmEvent(q, bus, {
      actor: { kind: "system" },
      req: { kind: "standup" },
      nowMs: NOW + 1,
      newId: () => "standup-1",
    });
    const listed = listRhythm(q.readConnection(), {
      group_id: groupId,
      kind: "sprint_planning",
    });
    expect(listed.ok && listed.items.map((item) => item.event_id)).toEqual([
      "plan-1",
    ]);
    expect(listRhythm(q.readConnection(), { limit: 201 })).toMatchObject({
      ok: false,
      code: "bad_query",
    });
  });

  it("keeps committed events when broadcast fails", async () => {
    const { q, db, bus } = await world();
    bus.fail = true;
    const result = await recordRhythmEvent(q, bus, {
      actor: { kind: "system" },
      req: { kind: "retro", payload: { mood: "steady" } },
      nowMs: NOW,
      newId: () => "retro-1",
    });
    expect(result).toMatchObject({
      ok: true,
      broadcastError: "bus unavailable; bus unavailable",
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM rhythm_events").get(),
    ).toEqual({ count: 1 });
  });
});

describe("daily research cards", () => {
  it("creates one card per day/URL and treats a duplicate as an idempotent read", async () => {
    const { q, db, bus } = await world();
    const req = {
      day: "2026-11-23",
      source: "web",
      title: "Market signal",
      summary: "A signal",
      url: "https://example.com/signal",
    };
    const first = await createResearchCard(q, bus, {
      actor: { kind: "member", memberId: "pm-1" },
      req,
      nowMs: NOW,
      newId: () => "research-1",
      newDocId: () => "research-doc-1",
      newBacklogId: () => "research-backlog-1",
    });
    expect(first).toMatchObject({
      ok: true,
      created: true,
      item: {
        card_id: "research-1",
        doc_id: "research-doc-1",
        backlog_item_id: "research-backlog-1",
      },
      document: { doc_id: "research-doc-1" },
      backlogItemId: "research-backlog-1",
    });
    const before = eventCount(db);
    const again = await createResearchCard(q, bus, {
      actor: { kind: "member", memberId: "pm-1" },
      req: { ...req, title: "Duplicate title" },
      nowMs: NOW + 1,
      newId: () => "must-not-be-inserted",
    });
    expect(again).toMatchObject({
      ok: true,
      created: false,
      item: { card_id: "research-1" },
    });
    expect(eventCount(db)).toBe(before);
    expect(bus.published).toHaveLength(3);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM research_cards").get(),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare("SELECT title, state FROM backlog_items WHERE id = ?")
        .get("research-backlog-1"),
    ).toEqual({ title: "调研建议：Market signal", state: "backlog" });
    expect(
      db
        .prepare("SELECT origin FROM documents WHERE doc_id = ?")
        .get("research-doc-1"),
    ).toEqual({ origin: "auto" });
  });

  it("accepts manual cards without URLs and rejects unlabelled URL-less sources", async () => {
    const { q, bus } = await world();
    const invalid = await createResearchCard(q, bus, {
      actor: { kind: "system" },
      req: { day: "2026-11-23", source: "web", title: "No URL" },
      nowMs: NOW,
    });
    expect(invalid).toMatchObject({ ok: false, code: "bad_body" });
    const manual = await createResearchCard(q, bus, {
      actor: { kind: "system" },
      req: { day: "2026-11-23", source: "manual", title: "Offline note" },
      nowMs: NOW,
      newId: () => "manual-1",
    });
    expect(manual).toMatchObject({
      ok: true,
      item: { url: null, source: "manual" },
    });
    const listed = listResearch(q.readConnection(), { day: "2026-11-23" }, NOW);
    expect(listed.ok && listed.items.map((item) => item.card_id)).toEqual([
      "manual-1",
    ]);
    const second = await createResearchCard(q, bus, {
      actor: { kind: "system" },
      req: { day: "2026-11-23", source: "manual", title: "Second note" },
      nowMs: NOW,
      newId: () => "manual-2",
    });
    expect(second).toMatchObject({
      ok: true,
      created: true,
      item: { card_id: "manual-2", url: null },
    });
  });

  it("defaults today from the injected clock and maps error categories", async () => {
    const { q, bus } = await world();
    await createResearchCard(q, bus, {
      actor: { kind: "system" },
      req: { source: "manual", title: "Today" },
      nowMs: NOW,
      newId: () => "today-1",
    });
    const date = new Date(NOW);
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    expect(listResearch(q.readConnection(), {}, NOW)).toMatchObject({
      ok: true,
      items: [{ card_id: "today-1", day }],
    });
    expect(rhythmServiceStatus("group_not_found")).toBe(404);
    expect(rhythmServiceStatus("not_authorized")).toBe(403);
    expect(rhythmServiceStatus("bad_body")).toBe(422);
    expect(rhythmServiceStatus("not_writable")).toBe(500);
  });
});
