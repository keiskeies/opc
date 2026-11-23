import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { HireMemberRequest, Persona } from "@opc/contracts";
import { afterAll, describe, expect, it } from "vitest";
import {
  backlogServiceStatus,
  cancelBacklog,
  createBacklog,
  getBacklog,
  listBacklog,
  mergeBacklog,
  moveBacklog,
  reprioritizeBacklog,
  rescheduleBacklog,
  splitBacklog,
} from "../../src/backlog/service.js";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import type { DomainEvent, EventBus } from "../../src/events/bus.js";
import { createGroup } from "../../src/groups/service.js";
import { hireMember } from "../../src/members/service.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("backlog", import.meta.url);
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
  otherGroupId: string;
}> {
  const q = new WriteQueue(join(TMP, `backlog-${process.pid}-${++fileSeq}.db`));
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
  const other = await createGroup(q, {
    req: { title: "Other", goal: "Other", member_ids: ["dev-1"] },
    nowMs: NOW,
  });
  if (!other.ok) throw new Error(other.reason);
  return {
    q,
    db,
    bus: new RecordingBus(),
    groupId: group.group.group_id,
    otherGroupId: other.group.group_id,
  };
}

function auditCount(db: DatabaseSync): number {
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

describe("backlog create/list and authorization", () => {
  it("creates an intent item with audit and broadcast, without creating an execution task", async () => {
    const { q, db, bus, groupId } = await world();
    const result = await createBacklog(q, bus, {
      actor: { kind: "boss" },
      req: { title: "  Research market  ", group_id: groupId, priority: -5 },
      nowMs: NOW,
      newId: () => "item-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.item).toMatchObject({
      id: "item-1",
      title: "Research market",
      group_id: groupId,
      task_id: null,
      state: "backlog",
      priority: -5,
      parent_id: null,
      merged_into: null,
    });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM tasks WHERE title = ?")
        .get("Research market"),
    ).toEqual({ count: 0 });
    const audit = db
      .prepare("SELECT id, action, payload FROM events WHERE target = ?")
      .get("item-1") as { id: number; action: string; payload: string };
    expect(audit.action).toBe("state_change");
    expect(JSON.parse(audit.payload)).toMatchObject({
      kind: "backlog_changed",
      op: "create",
    });
    expect(bus.published).toEqual([
      {
        event: {
          kind: "BacklogChanged",
          backlogItemId: "item-1",
          op: "create",
        },
        seq: audit.id,
      },
    ]);
  });

  it("allows product members and CoS, rejects ordinary members and global writes", async () => {
    const { q, bus, groupId } = await world();
    const pm = await createBacklog(q, bus, {
      actor: { kind: "member", memberId: "pm-1" },
      req: { title: "PM item", group_id: groupId },
      nowMs: NOW,
      newId: () => "pm-item",
    });
    expect(pm.ok).toBe(true);
    const dev = await createBacklog(q, bus, {
      actor: { kind: "member", memberId: "dev-1" },
      req: { title: "Dev item", group_id: groupId },
      nowMs: NOW,
      newId: () => "dev-item",
    });
    expect(dev).toMatchObject({ ok: false, code: "not_authorized" });
    const global = await createBacklog(q, bus, {
      actor: { kind: "member", memberId: "pm-1" },
      req: { title: "Global item" },
      nowMs: NOW,
      newId: () => "global-item",
    });
    expect(global).toMatchObject({ ok: false, code: "not_authorized" });
  });

  it("filters by group/state and orders by priority, due date, then creation time", async () => {
    const { q, bus, groupId, otherGroupId } = await world();
    const rows = [
      {
        id: "late",
        title: "Late",
        group_id: groupId,
        priority: 0,
        due_at: NOW + 20,
      },
      {
        id: "urgent",
        title: "Urgent",
        group_id: groupId,
        priority: -1,
        due_at: NOW + 30,
      },
      {
        id: "early",
        title: "Early",
        group_id: groupId,
        priority: 0,
        due_at: NOW + 10,
      },
      { id: "other", title: "Other", group_id: otherGroupId, priority: -2 },
    ];
    for (const row of rows) {
      const { id, ...req } = row;
      const result = await createBacklog(q, bus, {
        actor: { kind: "boss" },
        req,
        nowMs: NOW,
        newId: () => id,
      });
      expect(result.ok).toBe(true);
    }
    const listed = listBacklog(q.readConnection(), {
      group_id: groupId,
      limit: 10,
    });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.items.map((item) => item.id)).toEqual([
      "urgent",
      "early",
      "late",
    ]);
    expect(
      listBacklog(q.readConnection(), { group_id: groupId, state: "doing" }),
    ).toEqual({ ok: true, items: [] });
    expect(listBacklog(q.readConnection(), { limit: 201 })).toMatchObject({
      ok: false,
      code: "bad_query",
    });
  });
});

describe("backlog six operations", () => {
  it("moves, reschedules, reprioritizes, and softly cancels with one audit per action", async () => {
    const { q, db, bus, groupId, otherGroupId } = await world();
    const created = await createBacklog(q, bus, {
      actor: { kind: "boss" },
      req: { title: "Item", group_id: groupId },
      nowMs: NOW,
      newId: () => "item-1",
    });
    expect(created.ok).toBe(true);
    const moved = await moveBacklog(q, bus, {
      id: "item-1",
      actor: { kind: "boss" },
      req: { group_id: otherGroupId },
      nowMs: NOW + 1,
    });
    expect(moved).toMatchObject({ ok: true, item: { group_id: otherGroupId } });
    const rescheduled = await rescheduleBacklog(q, bus, {
      id: "item-1",
      actor: { kind: "boss" },
      req: { due_at: NOW + 100 },
      nowMs: NOW + 2,
    });
    expect(rescheduled).toMatchObject({
      ok: true,
      item: { due_at: NOW + 100 },
    });
    const prioritized = await reprioritizeBacklog(q, bus, {
      id: "item-1",
      actor: { kind: "boss" },
      req: { priority: -9 },
      nowMs: NOW + 3,
    });
    expect(prioritized).toMatchObject({ ok: true, item: { priority: -9 } });
    const cancelled = await cancelBacklog(q, bus, {
      id: "item-1",
      actor: { kind: "boss" },
      nowMs: NOW + 4,
    });
    expect(cancelled).toMatchObject({ ok: true, item: { state: "cancelled" } });
    expect(getBacklog(db, "item-1")?.state).toBe("cancelled");
    expect(
      bus.published.map(
        ({ event }) => event.kind === "BacklogChanged" && event.op,
      ),
    ).toEqual(["create", "move", "defer", "priority", "cancel"]);
  });

  it("requires authorization on both sides of a cross-group move", async () => {
    const { q, bus, groupId, otherGroupId } = await world();
    await createBacklog(q, bus, {
      actor: { kind: "boss" },
      req: { title: "Item", group_id: groupId },
      nowMs: NOW,
      newId: () => "item-1",
    });
    const denied = await moveBacklog(q, bus, {
      id: "item-1",
      actor: { kind: "member", memberId: "pm-1" },
      req: { group_id: otherGroupId },
      nowMs: NOW + 1,
    });
    expect(denied).toMatchObject({ ok: false, code: "not_authorized" });
    expect(getBacklog(q.readConnection(), "item-1")?.group_id).toBe(groupId);
  });

  it("splits into at least two children while retaining the parent", async () => {
    const { q, db, bus, groupId } = await world();
    await createBacklog(q, bus, {
      actor: { kind: "boss" },
      req: { title: "Parent", group_id: groupId, priority: 7 },
      nowMs: NOW,
      newId: () => "parent-1",
    });
    const beforeSplit = auditCount(db);
    const result = await splitBacklog(q, bus, {
      id: "parent-1",
      actor: { kind: "boss" },
      req: {
        children: [
          { title: "Child A" },
          { title: "Child B", priority: -1, due_at: NOW + 50 },
        ],
      },
      nowMs: NOW + 1,
      newId: (() => {
        const ids = ["child-a", "child-b"];
        let index = 0;
        return () => ids[index++] ?? "child-overflow";
      })(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parent.id).toBe("parent-1");
    expect(result.children).toHaveLength(2);
    expect(result.children[0]).toMatchObject({
      parent_id: "parent-1",
      priority: 7,
    });
    expect(result.children[1]).toMatchObject({
      parent_id: "parent-1",
      priority: -1,
    });
    expect(new Set(result.children.map((child) => child.id)).size).toBe(2);
    expect(auditCount(db)).toBe(beforeSplit + 1);
    expect(bus.published.at(-1)?.event).toMatchObject({
      kind: "BacklogChanged",
      backlogItemId: "parent-1",
      op: "split",
    });
  });

  it("merges by cancelling the source and preserving a pointer to the target", async () => {
    const { q, db, bus, groupId } = await world();
    for (const id of ["source", "target"]) {
      await createBacklog(q, bus, {
        actor: { kind: "boss" },
        req: { title: id, group_id: groupId },
        nowMs: NOW,
        newId: () => id,
      });
    }
    const self = await mergeBacklog(q, bus, {
      id: "source",
      actor: { kind: "boss" },
      req: { into_id: "source" },
      nowMs: NOW + 1,
    });
    expect(self).toMatchObject({ ok: false, code: "invalid_target" });
    const result = await mergeBacklog(q, bus, {
      id: "source",
      actor: { kind: "boss" },
      req: { into_id: "target" },
      nowMs: NOW + 2,
    });
    expect(result).toMatchObject({
      ok: true,
      item: { id: "source", state: "cancelled", merged_into: "target" },
    });
    expect(getBacklog(db, "target")?.state).toBe("backlog");
    expect(bus.published.at(-1)?.event).toMatchObject({
      kind: "BacklogChanged",
      backlogItemId: "source",
      op: "merge",
    });
  });

  it("rejects malformed requests without writing and keeps committed writes when broadcast fails", async () => {
    const { q, db, bus, groupId } = await world();
    const before = auditCount(db);
    const invalid = await createBacklog(q, bus, {
      actor: { kind: "boss" },
      req: { title: " " },
      nowMs: NOW,
    });
    expect(invalid).toMatchObject({ ok: false, code: "bad_body" });
    expect(auditCount(db)).toBe(before);
    bus.fail = true;
    const committed = await createBacklog(q, bus, {
      actor: { kind: "boss" },
      req: { title: "Committed", group_id: groupId },
      nowMs: NOW,
      newId: () => "committed",
    });
    expect(committed).toMatchObject({
      ok: true,
      broadcastError: "bus unavailable",
    });
    expect(getBacklog(db, "committed")?.id).toBe("committed");
  });

  it("maps errors to stable HTTP status categories", () => {
    expect(backlogServiceStatus("backlog_not_found")).toBe(404);
    expect(backlogServiceStatus("group_not_found")).toBe(404);
    expect(backlogServiceStatus("not_authorized")).toBe(403);
    expect(backlogServiceStatus("bad_body")).toBe(422);
    expect(backlogServiceStatus("invalid_target")).toBe(422);
    expect(backlogServiceStatus("not_writable")).toBe(500);
  });
});
