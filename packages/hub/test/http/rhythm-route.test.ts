import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ResearchCardView, RhythmEventView } from "@opc/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { type DomainEvent, InMemoryEventBus } from "../../src/events/bus.js";
import {
  type HubDeps,
  type HubRequest,
  handleRequest,
} from "../../src/http/app.js";
import { signedHeaders } from "../../src/http/auth.js";
import { LOOPBACK_HOST } from "../../src/http/bind.js";
import { buildHubDeps } from "../../src/http/real-deps.js";
import { DRIVER_OFF } from "../fixtures/driver-state.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("rhythm-route", import.meta.url);
mkdirSync(TMP, { recursive: true });
const NOW = new Date(2026, 10, 23, 12, 0, 0).getTime();
const DAY = "2026-11-23";
const TOKEN = "rhythm-route-token";
const queues: WriteQueue[] = [];
let fileSeq = 0;

/** 真总线加只读探针：广播时必须已经能从另一条连接读到对应审计行。 */
class CommitProbeBus extends InMemoryEventBus {
  readonly published: { event: DomainEvent; seq: number }[] = [];
  readonly visibleAtPublish: number[] = [];

  constructor(private readonly readDb: DatabaseSync) {
    super();
  }

  override publishPersisted(event: DomainEvent, seq: number): void {
    const row = this.readDb
      .prepare("SELECT COUNT(*) AS count FROM events WHERE id = ?")
      .get(seq) as { count: number } | undefined;
    this.visibleAtPublish.push(row?.count ?? 0);
    super.publishPersisted(event, seq);
    this.published.push({ event, seq });
  }
}

interface World {
  readonly deps: HubDeps;
  readonly db: DatabaseSync;
  readonly bus: CommitProbeBus;
  readonly groupId: string;
  readonly baselineSeq: number;
}

interface RhythmWriteBody {
  readonly ok: true;
  readonly created: true;
  readonly item: RhythmEventView;
  readonly auditSeq: number;
  readonly document: { readonly doc_id: string };
}

interface ResearchWriteBody {
  readonly ok: true;
  readonly created: boolean;
  readonly item: ResearchCardView;
  readonly auditSeq: number;
  readonly document: { readonly doc_id: string };
  readonly backlogItemId: string;
}

interface AuditRow {
  readonly id: number;
  readonly actor_type: string;
  readonly actor_id: string;
  readonly action: string;
  readonly target: string;
  readonly payload: string;
}

interface Snapshot {
  readonly documents: number;
  readonly document_versions: number;
  readonly rhythm_events: number;
  readonly research_cards: number;
  readonly backlog_items: number;
  readonly events: number;
}

async function world(): Promise<World> {
  const q = new WriteQueue(
    join(TMP, `rhythm-route-${process.pid}-${++fileSeq}.db`),
  );
  queues.push(q);
  const db = q.writeConnection();
  migrate(db);
  const bus = new CommitProbeBus(q.readConnection());
  const deps = buildHubDeps({
    queue: q,
    bus,
    token: TOKEN,
    now: () => NOW,
    driverState: () => DRIVER_OFF,
  });
  const group = await call(deps, "POST", "/api/v1/groups", {
    title: "Rhythm HTTP",
    goal: "Verify the real domain route",
  });
  if (group.status !== 201) {
    throw new Error(`group fixture failed: ${JSON.stringify(group.body)}`);
  }
  const groupId = data<{ group: { group_id: string } }>(group.body).group
    .group_id;
  bus.published.length = 0;
  bus.visibleAtPublish.length = 0;
  return { deps, db, bus, groupId, baselineSeq: bus.latestSeq() };
}

function request(
  _deps: HubDeps,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = signedHeaders(TOKEN, {
    method,
    target: path,
    body: body === undefined ? "" : JSON.stringify(body),
    now: NOW,
  }),
): HubRequest {
  const text = body === undefined ? "" : JSON.stringify(body);
  const question = path.indexOf("?");
  const pathname = question < 0 ? path : path.slice(0, question);
  const query: Record<string, string> = {};
  if (question >= 0) {
    for (const [key, value] of new URLSearchParams(path.slice(question + 1))) {
      query[key] = value;
    }
  }
  return {
    method,
    path: pathname,
    target: path,
    query,
    headers,
    body: text,
    peer: LOOPBACK_HOST,
  };
}

async function call(
  deps: HubDeps,
  method: string,
  path: string,
  body?: unknown,
) {
  return handleRequest(deps, request(deps, method, path, body));
}

async function callRaw(
  deps: HubDeps,
  method: string,
  path: string,
  text: string,
) {
  return handleRequest(deps, {
    ...request(deps, method, path),
    body: text,
    headers: signedHeaders(TOKEN, {
      method,
      target: path,
      body: text,
      now: NOW,
    }),
  });
}

function data<T>(body: unknown): T {
  return body as T;
}

function count(db: DatabaseSync, table: string): number {
  return Number(
    (
      db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count: number;
      }
    ).count,
  );
}

function snapshot(db: DatabaseSync): Snapshot {
  return {
    documents: count(db, "documents"),
    document_versions: count(db, "document_versions"),
    rhythm_events: count(db, "rhythm_events"),
    research_cards: count(db, "research_cards"),
    backlog_items: count(db, "backlog_items"),
    events: count(db, "events"),
  };
}

function auditsAfter(db: DatabaseSync, seq: number): AuditRow[] {
  return db
    .prepare(
      "SELECT id, actor_type, actor_id, action, target, payload " +
        "FROM events WHERE id > ? ORDER BY id",
    )
    .all(seq) as unknown as AuditRow[];
}

function auditKinds(rows: readonly AuditRow[]): string[] {
  return rows.map((row) => (JSON.parse(row.payload) as { kind: string }).kind);
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

describe("rhythm and research HTTP production routes", () => {
  it("records a rhythm event atomically, broadcasts after commit, and reads it back", async () => {
    const { deps, db, bus, groupId, baselineSeq } = await world();
    const payload = { summary: "No blockers", conclusion: "Ship the patch" };
    const response = await call(deps, "POST", "/api/v1/rhythm/events", {
      kind: "standup",
      group_id: groupId,
      payload,
    });
    expect(response.status).toBe(201);
    const body = data<RhythmWriteBody>(response.body);
    const eventId = body.item.event_id;
    const docId = body.item.digest_doc_id;
    expect(body).toMatchObject({
      ok: true,
      created: true,
      item: {
        event_id: eventId,
        kind: "standup",
        group_id: groupId,
        at: NOW,
        digest_doc_id: docId,
        payload,
      },
      document: { doc_id: docId },
    });
    expect(docId).not.toBeNull();
    expect(
      db
        .prepare(
          "SELECT origin, group_id, owner FROM documents WHERE doc_id = ?",
        )
        .get(docId),
    ).toEqual({ origin: "auto", group_id: groupId, owner: "boss" });
    const versions = db
      .prepare(
        "SELECT doc_id, seq, author, body_text FROM document_versions " +
          "WHERE doc_id = ?",
      )
      .all(docId) as {
      doc_id: string;
      seq: number;
      author: string;
      body_text: string;
    }[];
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      doc_id: docId,
      seq: 1,
      author: "boss",
    });
    expect(versions[0]?.body_text).toContain("No blockers");
    expect(versions[0]?.body_text).toContain("Ship the patch");
    expect(
      db
        .prepare(
          "SELECT event_id, kind, group_id, at, digest_doc_id, payload_json " +
            "FROM rhythm_events WHERE event_id = ?",
        )
        .get(eventId),
    ).toEqual({
      event_id: eventId,
      kind: "standup",
      group_id: groupId,
      at: NOW,
      digest_doc_id: docId,
      payload_json: JSON.stringify(payload),
    });

    const audits = auditsAfter(db, baselineSeq);
    expect(audits.map((row) => row.id)).toEqual([
      body.auditSeq - 1,
      body.auditSeq,
    ]);
    expect(auditKinds(audits)).toEqual(["document_changed", "rhythm_recorded"]);
    expect(
      audits.every(
        (row) =>
          row.actor_type === "human" &&
          row.actor_id === "ceo" &&
          row.action === "state_change",
      ),
    ).toBe(true);
    expect(bus.published).toEqual([
      {
        event: { kind: "DocumentChanged", docId, op: "created" },
        seq: body.auditSeq - 1,
      },
      {
        event: {
          kind: "RhythmEventRecorded",
          eventId,
          groupId,
          rhythmKind: "standup",
        },
        seq: body.auditSeq,
      },
    ]);
    expect(bus.visibleAtPublish).toEqual([1, 1]);

    const listed = await call(
      deps,
      "GET",
      `/api/v1/rhythm/events?group_id=${encodeURIComponent(groupId)}&kind=standup`,
    );
    expect(listed.status).toBe(200);
    expect(data<{ items: RhythmEventView[] }>(listed.body).items).toEqual([
      body.item,
    ]);
  });

  it("creates a research card, auto document/version, backlog draft, three audits, and ordered broadcasts", async () => {
    const { deps, db, bus, groupId, baselineSeq } = await world();
    const url = "https://example.com/signal";
    const response = await call(deps, "POST", "/api/v1/research/today", {
      source: "web",
      title: "Market signal",
      summary: "A useful signal",
      url,
      group_id: groupId,
    });
    expect(response.status).toBe(201);
    const body = data<ResearchWriteBody>(response.body);
    const item = body.item;
    expect(body).toMatchObject({
      ok: true,
      created: true,
      item: {
        card_id: item.card_id,
        day: DAY,
        source: "web",
        title: "Market signal",
        summary: "A useful signal",
        url,
        group_id: groupId,
        backlog_item_id: body.backlogItemId,
        doc_id: body.document.doc_id,
      },
      document: { doc_id: item.doc_id },
      backlogItemId: item.backlog_item_id,
    });
    expect(
      db
        .prepare("SELECT origin, group_id FROM documents WHERE doc_id = ?")
        .get(item.doc_id),
    ).toEqual({ origin: "auto", group_id: groupId });
    expect(
      db
        .prepare(
          "SELECT doc_id, seq, author, body_text FROM document_versions " +
            "WHERE doc_id = ?",
        )
        .get(item.doc_id),
    ).toMatchObject({ doc_id: item.doc_id, seq: 1, author: "boss" });
    expect(
      db
        .prepare(
          "SELECT id, group_id, state, title, detail FROM backlog_items " +
            "WHERE id = ?",
        )
        .get(body.backlogItemId),
    ).toEqual({
      id: body.backlogItemId,
      group_id: groupId,
      state: "backlog",
      title: "调研建议：Market signal",
      detail: "A useful signal",
    });

    const audits = auditsAfter(db, baselineSeq);
    expect(audits.map((row) => row.id)).toEqual([
      body.auditSeq - 2,
      body.auditSeq - 1,
      body.auditSeq,
    ]);
    expect(auditKinds(audits)).toEqual([
      "document_changed",
      "backlog_changed",
      "research_card_created",
    ]);
    expect(
      audits.every(
        (row) =>
          row.actor_type === "human" &&
          row.actor_id === "ceo" &&
          row.action === "state_change",
      ),
    ).toBe(true);
    expect(bus.published).toEqual([
      {
        event: {
          kind: "DocumentChanged",
          docId: body.document.doc_id,
          op: "created",
        },
        seq: body.auditSeq - 2,
      },
      {
        event: {
          kind: "BacklogChanged",
          backlogItemId: body.backlogItemId,
          op: "create",
        },
        seq: body.auditSeq - 1,
      },
      {
        event: { kind: "ResearchCardCreated", cardId: item.card_id, day: DAY },
        seq: body.auditSeq,
      },
    ]);
    expect(bus.visibleAtPublish).toEqual([1, 1, 1]);

    const listed = await call(deps, "GET", "/api/v1/research/today");
    expect(listed.status).toBe(200);
    expect(data<{ items: ResearchCardView[] }>(listed.body).items).toEqual([
      item,
    ]);
  });

  it("deduplicates only same-day URLs and allows repeated manual cards without URLs", async () => {
    const { deps, db, bus } = await world();
    const req = {
      source: "web",
      title: "Original signal",
      summary: "First summary",
      url: "https://example.com/replay",
    };
    const first = await call(deps, "POST", "/api/v1/research/today", req);
    expect(first.status).toBe(201);
    const firstBody = data<ResearchWriteBody>(first.body);
    const before = snapshot(db);
    const seqBefore = bus.latestSeq();

    const replay = await call(deps, "POST", "/api/v1/research/today", {
      ...req,
      title: "Changed title",
      summary: "Changed summary",
    });
    expect(replay.status).toBe(201);
    const replayBody = data<ResearchWriteBody>(replay.body);
    expect(replayBody).toMatchObject({
      ok: true,
      created: false,
      item: firstBody.item,
      document: firstBody.document,
      backlogItemId: firstBody.backlogItemId,
    });
    expect(snapshot(db)).toEqual(before);
    expect(bus.latestSeq()).toBe(seqBefore);
    expect(bus.published).toHaveLength(3);

    const manualReq = {
      source: "manual",
      title: "Offline note",
      summary: "No URL",
    };
    const manualOne = await call(
      deps,
      "POST",
      "/api/v1/research/today",
      manualReq,
    );
    const manualTwo = await call(
      deps,
      "POST",
      "/api/v1/research/today",
      manualReq,
    );
    expect(manualOne.status).toBe(201);
    expect(manualTwo.status).toBe(201);
    const one = data<ResearchWriteBody>(manualOne.body);
    const two = data<ResearchWriteBody>(manualTwo.body);
    expect(one.created).toBe(true);
    expect(two.created).toBe(true);
    expect(one.item).toMatchObject({ source: "manual", url: null });
    expect(two.item).toMatchObject({ source: "manual", url: null });
    expect(two.item.card_id).not.toBe(one.item.card_id);
    const afterManual = snapshot(db);
    expect(afterManual.research_cards).toBe(before.research_cards + 2);
    expect(afterManual.documents).toBe(before.documents + 2);
    expect(afterManual.document_versions).toBe(before.document_versions + 2);
    expect(afterManual.backlog_items).toBe(before.backlog_items + 2);
    expect(afterManual.events).toBe(before.events + 6);

    const listed = await call(deps, "GET", "/api/v1/research/today");
    const items = data<{ items: ResearchCardView[] }>(listed.body).items;
    expect(items).toHaveLength(3);
    expect(items.filter((item) => item.url === null)).toHaveLength(2);
    expect(
      items.find((item) => item.card_id === firstBody.item.card_id),
    ).toEqual(firstBody.item);
  });

  it("maps malformed JSON, bad schemas, missing groups, and missing writer without writes", async () => {
    const { deps, db, groupId } = await world();
    const before = snapshot(db);
    for (const path of ["/api/v1/rhythm/events", "/api/v1/research/today"]) {
      const malformed = await callRaw(deps, "POST", path, "{broken");
      expect(malformed.status).toBe(422);
      expect(malformed.body).toMatchObject({ code: "bad_body" });
    }
    const invalidSchema = [
      {
        path: "/api/v1/rhythm/events",
        body: { kind: "not-a-rhythm-kind", payload: {} },
      },
      {
        path: "/api/v1/research/today",
        body: { source: "web", title: "URL required" },
      },
    ] as const;
    for (const entry of invalidSchema) {
      const response = await call(deps, "POST", entry.path, entry.body);
      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({ code: "bad_body" });
    }
    for (const entry of [
      {
        path: "/api/v1/rhythm/events",
        body: { kind: "standup", group_id: "missing", payload: {} },
      },
      {
        path: "/api/v1/research/today",
        body: {
          source: "manual",
          title: "Missing group",
          group_id: "missing",
        },
      },
    ] as const) {
      const response = await call(deps, "POST", entry.path, entry.body);
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ code: "group_not_found" });
    }

    const { domainWriter: _writer, ...withoutWriter } = deps;
    expect(
      (
        await call(withoutWriter, "POST", "/api/v1/rhythm/events", {
          kind: "standup",
          group_id: groupId,
          payload: { summary: "No writer" },
        })
      ).status,
    ).toBe(501);
    expect(
      (
        await call(withoutWriter, "POST", "/api/v1/research/today", {
          source: "manual",
          title: "No writer",
        })
      ).status,
    ).toBe(501);
    expect(snapshot(db)).toEqual(before);
    expect(
      data<{ items: unknown[] }>(
        (await call(deps, "GET", "/api/v1/rhythm/events")).body,
      ).items,
    ).toEqual([]);
    expect(
      data<{ items: unknown[] }>(
        (await call(deps, "GET", "/api/v1/research/today")).body,
      ).items,
    ).toEqual([]);
  });

  it("rolls back both multi-table writes when the domain insert fails and broadcasts nothing", async () => {
    const { deps, db, bus, groupId, baselineSeq } = await world();
    db.exec(
      "CREATE TRIGGER fail_rhythm_insert BEFORE INSERT ON rhythm_events " +
        "BEGIN SELECT RAISE(ABORT, 'injected rhythm failure'); END;",
    );
    db.exec(
      "CREATE TRIGGER fail_research_insert BEFORE INSERT ON research_cards " +
        "BEGIN SELECT RAISE(ABORT, 'injected research failure'); END;",
    );
    const before = snapshot(db);

    const rhythm = await call(deps, "POST", "/api/v1/rhythm/events", {
      kind: "standup",
      group_id: groupId,
      payload: { summary: "Must roll back" },
    });
    expect(rhythm.status).toBe(500);
    expect(data<{ error: string }>(rhythm.body).error).toContain(
      "injected rhythm failure",
    );
    expect(snapshot(db)).toEqual(before);

    const research = await call(deps, "POST", "/api/v1/research/today", {
      source: "manual",
      title: "Must roll back",
      summary: "No partial document or backlog",
      group_id: groupId,
    });
    expect(research.status).toBe(500);
    expect(data<{ error: string }>(research.body).error).toContain(
      "injected research failure",
    );
    expect(snapshot(db)).toEqual(before);
    expect(bus.latestSeq()).toBe(baselineSeq);
    expect(bus.published).toEqual([]);
    expect(bus.visibleAtPublish).toEqual([]);
    expect(
      data<{ items: unknown[] }>(
        (await call(deps, "GET", "/api/v1/rhythm/events")).body,
      ).items,
    ).toEqual([]);
    expect(
      data<{ items: unknown[] }>(
        (await call(deps, "GET", "/api/v1/research/today")).body,
      ).items,
    ).toEqual([]);
  });
});
