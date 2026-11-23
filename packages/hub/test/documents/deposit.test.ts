import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { HireMemberRequest, Persona } from "@opc/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import {
  depositAutoDocument,
  depositMeetingSummary,
} from "../../src/documents/deposit.js";
import { createDocument, getDocument } from "../../src/documents/service.js";
import type { DomainEvent, EventBus } from "../../src/events/bus.js";
import { createGroup } from "../../src/groups/service.js";
import {
  concludeMeeting,
  createMeeting,
  getMeeting,
  postTurn,
} from "../../src/meetings/service.js";
import { hireMember } from "../../src/members/service.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("deposit", import.meta.url);
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
    throw new Error("not used by deposit tests");
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

async function world(): Promise<{
  q: WriteQueue;
  db: DatabaseSync;
  bus: RecordingBus;
  groupId: string;
}> {
  const q = new WriteQueue(join(TMP, `deposit-${process.pid}-${++fileSeq}.db`));
  queues.push(q);
  const db = q.writeConnection();
  migrate(db);
  for (const [id, role] of [
    ["pm-1", "product_director"],
    ["dev-1", "dev"],
  ] as const) {
    const req: HireMemberRequest = {
      name: `Member ${id}`,
      role_id: role,
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
    if (!result.ok) throw new Error(result.reason);
  }
  const group = await createGroup(q, {
    req: { title: "Launch", goal: "Ship", member_ids: ["pm-1", "dev-1"] },
    nowMs: NOW,
  });
  if (!group.ok) throw new Error(group.reason);
  return { q, db, bus: new RecordingBus(), groupId: group.group.group_id };
}

async function concludedMeeting(
  q: WriteQueue,
  bus: RecordingBus,
  groupId: string,
): Promise<string> {
  const created = await createMeeting(q, bus, {
    req: {
      group_id: groupId,
      topic: "Launch decision",
      moderator_member_id: "pm-1",
      speaking_order: ["pm-1", "dev-1"],
    },
    nowMs: NOW,
    newId: (() => {
      const ids = ["meeting-1", "card-1"];
      let index = 0;
      return () => ids[index++] ?? "extra";
    })(),
  });
  if (!created.ok) throw new Error(created.reason);
  await postTurn(q, bus, {
    meetingId: "meeting-1",
    req: { speaker_member_id: "pm-1", content: "建议上线" },
    nowMs: NOW + 1,
  });
  const concluded = await concludeMeeting(q, bus, {
    meetingId: "meeting-1",
    req: {
      decision: "上线",
      owner_member_id: "dev-1",
      deadline_at: NOW + 1000,
    },
    nowMs: NOW + 2,
  });
  if (!concluded.ok) throw new Error(concluded.reason);
  return "meeting-1";
}

const boss = { kind: "boss" } as const;

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

describe("automatic document deposit", () => {
  it("creates origin=auto documents through the normal version/permission path", async () => {
    const { q, db, bus } = await world();
    const result = await depositAutoDocument(q, bus, {
      viewer: boss,
      req: { kind: "markdown", title: "Auto note", body_text: "body" },
      nowMs: NOW,
      newId: () => "auto-doc",
    });
    expect(result).toMatchObject({
      ok: true,
      docId: "auto-doc",
      document: { origin: "auto" },
    });
    expect(getDocument(db, "auto-doc", boss)).toMatchObject({
      ok: true,
      document: { body_text: "body" },
    });
  });

  it("deposits a complete meeting transcript and conclusion, links it, and is idempotent", async () => {
    const { q, db, bus, groupId } = await world();
    const meetingId = await concludedMeeting(q, bus, groupId);
    const result = await depositMeetingSummary(q, bus, {
      meetingId,
      nowMs: NOW + 3,
      newId: () => "summary-doc",
    });
    expect(result).toMatchObject({
      ok: true,
      created: true,
      docId: "summary-doc",
    });
    if (!result.ok || !result.created) return;
    expect(result.document.origin).toBe("auto");
    expect(result.document.body_text).toContain("建议上线");
    expect(result.document.body_text).toContain("决定：上线");
    expect(result.document.body_text).toContain("负责人：dev-1");
    expect(getMeeting(db, meetingId)?.summary_doc_id).toBe("summary-doc");
    expect(bus.published.at(-1)?.event).toEqual({
      kind: "MeetingSummaryReady",
      taskId: null,
      meetingId,
    });
    const again = await depositMeetingSummary(q, bus, {
      meetingId,
      nowMs: NOW + 4,
      newId: () => "must-not-exist",
    });
    expect(again).toEqual({ ok: true, created: false, docId: "summary-doc" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM documents").get()).toEqual(
      { count: 1 },
    );
  });

  it("rolls back the new document when the meeting link cannot be claimed", async () => {
    const { q, db, bus, groupId } = await world();
    const existing = await createDocument(q, bus, {
      viewer: boss,
      req: { kind: "markdown", title: "Existing", body_text: "existing" },
      nowMs: NOW,
      newId: () => "existing-doc",
    });
    expect(existing.ok).toBe(true);
    const meetingId = await concludedMeeting(q, bus, groupId);
    db.prepare("UPDATE meetings SET summary_doc_id = ? WHERE id = ?").run(
      "existing-doc",
      meetingId,
    );
    const before = db.prepare("SELECT COUNT(*) AS count FROM documents").get();
    const result = await createDocument(q, bus, {
      viewer: boss,
      req: { kind: "markdown", title: "Orphan", body_text: "orphan" },
      origin: "auto",
      meetingSummaryId: meetingId,
      nowMs: NOW + 3,
      newId: () => "orphan-must-not-exist",
    });
    expect(result).toMatchObject({ ok: false, code: "meeting_summary_exists" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM documents").get()).toEqual(
      before,
    );
    expect(getDocument(db, "orphan-must-not-exist", boss)).toMatchObject({
      ok: false,
      code: "document_not_found",
    });
  });

  it("refuses open meetings and keeps committed deposit when broadcast fails", async () => {
    const { q, db, bus, groupId } = await world();
    const created = await createMeeting(q, bus, {
      req: { group_id: groupId, topic: "Open", moderator_member_id: "pm-1" },
      nowMs: NOW,
      newId: (() => {
        const ids = ["open-meeting", "open-card"];
        let index = 0;
        return () => ids[index++] ?? "extra";
      })(),
    });
    expect(created.ok).toBe(true);
    expect(
      await depositMeetingSummary(q, bus, {
        meetingId: "open-meeting",
        nowMs: NOW + 1,
      }),
    ).toMatchObject({ ok: false, code: "meeting_not_concluded" });

    const meetingId = await concludedMeeting(q, bus, groupId);
    bus.fail = true;
    const result = await depositMeetingSummary(q, bus, {
      meetingId,
      nowMs: NOW + 3,
      newId: () => "summary-failed-broadcast",
    });
    expect(result).toMatchObject({
      ok: true,
      created: true,
      broadcastError: "bus unavailable；bus unavailable",
    });
    expect(getMeeting(db, meetingId)?.summary_doc_id).toBe(
      "summary-failed-broadcast",
    );
  });
});
