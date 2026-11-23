import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { MeetingView } from "@opc/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { openDb } from "../../src/db/driver.js";
import { migrate } from "../../src/db/migrate.js";
import {
  planMeetingConclusion,
  sampleAudit,
} from "../../src/governance/service.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("governance", import.meta.url);
mkdirSync(TMP, { recursive: true });
const opened: DatabaseSync[] = [];

function db(): DatabaseSync {
  const connection = openDb(
    join(TMP, `governance-${process.pid}-${opened.length}.db`),
  );
  opened.push(connection);
  migrate(connection);
  return connection;
}

function meeting(overrides: Partial<MeetingView> = {}): MeetingView {
  return {
    meeting_id: "m-1",
    group_id: "g-1",
    task_id: null,
    meeting_type: "decision",
    topic: "Decision",
    moderator_member_id: "pm-1",
    speaking_order: ["pm-1"],
    status: "concluded",
    decision: "Ship",
    owner_member_id: "dev-1",
    deadline_at: 1000,
    summary_doc_id: null,
    next_speaker_member_id: null,
    turns: [],
    opened_at: 1,
    concluded_at: 2,
    ...overrides,
  };
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

describe("meeting conclusion governance", () => {
  it("turns a complete in-scope conclusion into backlog input", () => {
    expect(planMeetingConclusion(meeting())).toEqual({
      action: "backlog",
      ownerMemberId: "dev-1",
      deadlineAt: 1000,
      reason: "结论三件套完整且未越权，可作为 backlog 输入。",
    });
  });

  it("holds open/cancelled/incomplete meetings and escalates reserved decisions", () => {
    expect(
      planMeetingConclusion(meeting({ status: "open", concluded_at: null }))
        .action,
    ).toBe("hold");
    expect(planMeetingConclusion(meeting({ status: "cancelled" })).action).toBe(
      "hold",
    );
    expect(planMeetingConclusion(meeting({ decision: null })).action).toBe(
      "hold",
    );
    expect(
      planMeetingConclusion(meeting({ decision: "采购新服务" })),
    ).toMatchObject({
      action: "escalate",
      ownerMemberId: "dev-1",
      deadlineAt: 1000,
    });
  });
});

describe("deterministic audit sampling", () => {
  it("samples by id modulus and reports malformed payloads without hiding good rows", () => {
    const connection = db();
    const insert = connection.prepare(
      "INSERT INTO events (task_id, actor_type, actor_id, action, target, payload, state_snapshot, created_at)" +
        " VALUES (NULL, 'system', 'hub', 'state_change', NULL, ?, NULL, ?)",
    );
    for (let index = 1; index <= 14; index += 1) {
      const payload =
        index === 7
          ? "[]"
          : index === 14
            ? "{broken"
            : JSON.stringify({ kind: "sample", index });
      insert.run(payload, index);
    }
    const sample = sampleAudit(connection, { modulus: 7, limit: 10 });
    expect(sample.rows).toEqual([]);
    expect(sample.anomalies.map((item) => item.id)).toEqual([7, 14]);
    expect(sample.anomalies[0]?.reason).toBe("payload 必须是对象。");
    expect(sample.anomalies[1]?.reason).toContain("JSON");
    const good = sampleAudit(connection, { modulus: 2, limit: 6 });
    expect(good.rows.map((row) => row.id)).toEqual([2, 4, 6, 8, 10, 12]);
    expect(good.anomalies).toEqual([]);
  });

  it("rejects invalid sampling options instead of silently changing the sample", () => {
    const connection = db();
    expect(() => sampleAudit(connection, { modulus: 0 })).toThrow(/modulus/u);
    expect(() => sampleAudit(connection, { limit: 501 })).toThrow(/limit/u);
    expect(() => sampleAudit(connection, { afterId: -1 })).toThrow(/afterId/u);
  });
});
