import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  DOC_RETENTION_DAYS,
  type HireMemberRequest,
  type Persona,
} from "@opc/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import {
  createDocument,
  createDocumentTemplate,
  deleteDocument,
  deleteDocumentPermission,
  documentServiceStatus,
  getDocument,
  getDocumentVersion,
  listDocuments,
  listDocumentVersions,
  listTemplates,
  pruneDocumentVersions,
  restoreDocument,
  saveDocument,
  setDocumentPermission,
  updateDocumentMeta,
} from "../../src/documents/service.js";
import type { DomainEvent, EventBus } from "../../src/events/bus.js";
import { createGroup } from "../../src/groups/service.js";
import { hireMember } from "../../src/members/service.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("documents", import.meta.url);
mkdirSync(TMP, { recursive: true });
const NOW = Date.UTC(2026, 10, 23);
const DAY = 24 * 60 * 60 * 1000;
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
  const q = new WriteQueue(join(TMP, `doc-${process.pid}-${++fileSeq}.db`));
  queues.push(q);
  const db = q.writeConnection();
  migrate(db);
  await hire(q, "pm-1", "product_director");
  await hire(q, "dev-1", "dev");
  await hire(q, "outsider", "qa");
  const group = await createGroup(q, {
    req: { title: "Launch", goal: "Ship", member_ids: ["pm-1", "dev-1"] },
    nowMs: NOW,
  });
  if (!group.ok) throw new Error(group.reason);
  return { q, db, bus: new RecordingBus(), groupId: group.group.group_id };
}

const boss = { kind: "boss" } as const;
const pm = { kind: "member", memberId: "pm-1" } as const;
const dev = { kind: "member", memberId: "dev-1" } as const;
const outsider = { kind: "member", memberId: "outsider" } as const;

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

describe("document creation and versions", () => {
  it("creates from a server-side template with version 1, audit, and broadcast", async () => {
    const { q, db, bus } = await world();
    const result = await createDocument(q, bus, {
      viewer: boss,
      req: { kind: "markdown", title: "Weekly", template_id: "tpl_weekly" },
      nowMs: NOW,
      newId: () => "doc-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document).toMatchObject({
      doc_id: "doc-1",
      title: "Weekly",
      owner: "boss",
      origin: "created",
      template_id: "tpl_weekly",
      my_tier: "owner",
    });
    expect(result.document.body_text).toContain("周报");
    expect(getDocumentVersion(db, "doc-1", 1, boss)).toMatchObject({
      ok: true,
      version: { seq: 1, body_text: result.document.body_text },
    });
    const audit = db
      .prepare("SELECT id, action, payload FROM events WHERE target = ?")
      .get("doc-1") as { id: number; action: string; payload: string };
    expect(audit.action).toBe("state_change");
    expect(JSON.parse(audit.payload)).toMatchObject({
      kind: "document_changed",
      op: "created",
    });
    expect(bus.published).toEqual([
      {
        event: { kind: "DocumentChanged", docId: "doc-1", op: "created" },
        seq: audit.id,
      },
    ]);
    expect(listTemplates(db)).toHaveLength(4);
    const custom = await createDocumentTemplate(q, {
      req: { name: "Custom", kind: "markdown", body_text: "# Custom" },
      nowMs: NOW,
      newId: () => "tpl_custom",
    });
    expect(custom).toMatchObject({
      ok: true,
      template: { template_id: "tpl_custom", builtin: false },
    });
    expect(listTemplates(db)).toHaveLength(5);
  });

  it("enforces optimistic concurrency and restores by adding a new version", async () => {
    const { q, db, bus } = await world();
    await createDocument(q, bus, {
      viewer: boss,
      req: { kind: "markdown", title: "Doc", body_text: "v1" },
      nowMs: NOW,
      newId: () => "doc-conflict",
    });
    const conflict = await saveDocument(q, bus, {
      docId: "doc-conflict",
      viewer: boss,
      req: { body_text: "stale", base_seq: 2 },
      nowMs: NOW + 1,
    });
    expect(conflict).toMatchObject({ ok: false, code: "version_conflict" });
    const saved = await saveDocument(q, bus, {
      docId: "doc-conflict",
      viewer: boss,
      req: { body_text: "v2", title: "Doc 2", base_seq: 1 },
      nowMs: NOW + 2,
    });
    expect(saved).toMatchObject({
      ok: true,
      document: { body_text: "v2", title: "Doc 2" },
    });
    const restored = await restoreDocument(q, bus, {
      docId: "doc-conflict",
      seq: 1,
      viewer: boss,
      nowMs: NOW + 3,
    });
    expect(restored).toMatchObject({ ok: true, document: { body_text: "v1" } });
    const versions = listDocumentVersions(db, "doc-conflict", boss);
    expect(
      versions.ok && versions.versions.map((version) => version.seq),
    ).toEqual([3, 2, 1]);
    expect(bus.published.at(-1)?.event).toEqual({
      kind: "DocumentChanged",
      docId: "doc-conflict",
      op: "restored",
    });
  });

  it("prunes expired snapshots but always keeps each document's latest version", async () => {
    const { q, db, bus } = await world();
    await createDocument(q, bus, {
      viewer: boss,
      req: { kind: "markdown", title: "Retention", body_text: "one" },
      nowMs: NOW,
      newId: () => "doc-retention",
    });
    await saveDocument(q, bus, {
      docId: "doc-retention",
      viewer: boss,
      req: { body_text: "two" },
      nowMs: NOW + 1,
    });
    await saveDocument(q, bus, {
      docId: "doc-retention",
      viewer: boss,
      req: { body_text: "three" },
      nowMs: NOW + 2,
    });
    db.prepare(
      "UPDATE document_versions SET created_at = ? WHERE doc_id = ? AND seq IN (1, 2)",
    ).run(NOW - (DOC_RETENTION_DAYS + 1) * DAY, "doc-retention");
    expect(await pruneDocumentVersions(q, { nowMs: NOW })).toEqual({
      ok: true,
      deleted: 2,
    });
    const versions = listDocumentVersions(db, "doc-retention", boss);
    expect(
      versions.ok && versions.versions.map((version) => version.seq),
    ).toEqual([3]);
  });
});

describe("document permissions", () => {
  it("does not leak private docs and applies explicit member > group > default", async () => {
    const { q, db, bus, groupId } = await world();
    await createDocument(q, bus, {
      viewer: boss,
      req: { kind: "doc", title: "Private", body_text: "secret" },
      nowMs: NOW,
      newId: () => "private-doc",
    });
    expect(getDocument(db, "private-doc", pm)).toMatchObject({
      ok: false,
      code: "document_not_found",
    });
    await setDocumentPermission(q, bus, {
      docId: "private-doc",
      viewer: boss,
      req: { grantee: "pm-1", tier: "editor" },
      nowMs: NOW + 1,
    });
    expect(getDocument(db, "private-doc", pm)).toMatchObject({
      ok: true,
      document: { my_tier: "editor" },
    });
    await setDocumentPermission(q, bus, {
      docId: "private-doc",
      viewer: boss,
      req: { grantee: `group:${groupId}`, tier: "reader" },
      nowMs: NOW + 2,
    });
    expect(getDocument(db, "private-doc", dev)).toMatchObject({
      ok: true,
      document: { my_tier: "reader" },
    });
    expect(getDocument(db, "private-doc", outsider)).toMatchObject({
      ok: false,
      code: "document_not_found",
    });
    expect(getDocument(db, "private-doc", pm)).toMatchObject({
      ok: true,
      document: { my_tier: "editor" },
    });
  });

  it("gives seated members default reader access to group docs and reserves permission changes for owner", async () => {
    const { q, db, bus, groupId } = await world();
    await createDocument(q, bus, {
      viewer: boss,
      req: {
        kind: "doc",
        title: "Group doc",
        group_id: groupId,
        body_text: "shared",
      },
      nowMs: NOW,
      newId: () => "group-doc",
    });
    expect(getDocument(db, "group-doc", dev)).toMatchObject({
      ok: true,
      document: { my_tier: "reader" },
    });
    expect(
      await updateDocumentMeta(q, bus, {
        docId: "group-doc",
        viewer: boss,
        req: { title: "Group doc 2", watermark_profile: "internal" },
        nowMs: NOW + 1,
      }),
    ).toMatchObject({
      ok: true,
      document: { title: "Group doc 2", watermark_profile: "internal" },
    });
    expect(
      await updateDocumentMeta(q, bus, {
        docId: "group-doc",
        viewer: dev,
        req: { group_id: null },
        nowMs: NOW + 1,
      }),
    ).toMatchObject({ ok: false, code: "not_authorized" });
    expect(
      await saveDocument(q, bus, {
        docId: "group-doc",
        viewer: dev,
        req: { body_text: "denied" },
        nowMs: NOW + 1,
      }),
    ).toMatchObject({ ok: false, code: "not_authorized" });
    expect(
      await setDocumentPermission(q, bus, {
        docId: "group-doc",
        viewer: dev,
        req: { grantee: "dev-1", tier: "editor" },
        nowMs: NOW + 1,
      }),
    ).toMatchObject({ ok: false, code: "not_authorized" });
    await deleteDocumentPermission(q, bus, {
      docId: "group-doc",
      grantee: "dev-1",
      viewer: boss,
      nowMs: NOW + 2,
    });
  });

  it("filters list results by access and returns bad_query instead of throwing", async () => {
    const { q, db, bus } = await world();
    await createDocument(q, bus, {
      viewer: pm,
      req: { kind: "markdown", title: "PM private", body_text: "mine" },
      nowMs: NOW,
      newId: () => "pm-doc",
    });
    expect(listDocuments(db, {}, boss)).toMatchObject({
      ok: true,
      documents: [],
    });
    const mine = listDocuments(db, {}, pm);
    expect(
      mine.ok && mine.documents.map((document) => document.doc_id),
    ).toEqual(["pm-doc"]);
    expect(listDocuments(db, { limit: 101 }, pm)).toMatchObject({
      ok: false,
      code: "bad_query",
    });
  });
});

describe("document soft delete", () => {
  it("hides deleted documents while retaining versions and an audit trail", async () => {
    const { q, db, bus } = await world();
    await createDocument(q, bus, {
      viewer: boss,
      req: { kind: "markdown", title: "Delete me", body_text: "keep history" },
      nowMs: NOW,
      newId: () => "doc-delete",
    });
    const deleted = await deleteDocument(q, bus, {
      docId: "doc-delete",
      viewer: boss,
      nowMs: NOW + 1,
    });
    if (!deleted.ok) throw new Error(`${deleted.code}: ${deleted.reason}`);
    expect(deleted).toMatchObject({
      ok: true,
      document: { deleted_at: NOW + 1 },
    });
    expect(getDocument(db, "doc-delete", boss)).toMatchObject({
      ok: false,
      code: "document_not_found",
    });
    expect(listDocuments(db, {}, boss)).toMatchObject({
      ok: true,
      documents: [],
    });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM document_versions WHERE doc_id = ?",
        )
        .get("doc-delete"),
    ).toEqual({
      count: 1,
    });
    expect(bus.published.at(-1)?.event).toEqual({
      kind: "DocumentChanged",
      docId: "doc-delete",
      op: "deleted",
    });
  });
});

describe("document write resilience", () => {
  it("keeps committed saves when broadcast fails", async () => {
    const { q, db, bus } = await world();
    await createDocument(q, bus, {
      viewer: boss,
      req: { kind: "markdown", title: "Resilient", body_text: "one" },
      nowMs: NOW,
      newId: () => "doc-resilient",
    });
    bus.fail = true;
    const result = await saveDocument(q, bus, {
      docId: "doc-resilient",
      viewer: boss,
      req: { body_text: "two" },
      nowMs: NOW + 1,
    });
    expect(result).toMatchObject({
      ok: true,
      broadcastError: "bus unavailable",
    });
    expect(getDocument(db, "doc-resilient", boss)).toMatchObject({
      ok: true,
      document: { body_text: "two" },
    });
  });

  it("maps document errors to stable status categories", () => {
    expect(documentServiceStatus("document_not_found")).toBe(404);
    expect(documentServiceStatus("version_not_found")).toBe(404);
    expect(documentServiceStatus("not_authorized")).toBe(403);
    expect(documentServiceStatus("version_conflict")).toBe(409);
    expect(documentServiceStatus("bad_body")).toBe(422);
    expect(documentServiceStatus("not_writable")).toBe(500);
  });
});
