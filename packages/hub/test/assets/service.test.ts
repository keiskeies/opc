import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { getAsset, putAsset } from "../../src/assets/service.js";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("assets", import.meta.url);
mkdirSync(TMP, { recursive: true });
const NOW = Date.UTC(2026, 10, 23);
const opened: DatabaseSync[] = [];
const queues: WriteQueue[] = [];
let fileSeq = 0;

function world(): { q: WriteQueue; db: DatabaseSync } {
  const q = new WriteQueue(join(TMP, `asset-${process.pid}-${++fileSeq}.db`));
  queues.push(q);
  const db = q.writeConnection();
  opened.push(db);
  migrate(db);
  return { q, db };
}

afterAll(async () => {
  for (const q of queues) {
    try {
      await q.close();
    } catch {
      // Already closed.
    }
  }
  for (const db of opened) {
    try {
      db.close();
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

describe("content-addressed assets", () => {
  it("deduplicates identical bytes and returns the original BLOB unchanged", async () => {
    const { q, db } = world();
    const bytes = new Uint8Array([0, 255, 128, 65, 0]);
    const first = await putAsset(q, {
      purpose: "attachment",
      mime: "application/octet-stream",
      data: bytes,
      nowMs: NOW,
      newId: () => "asset-1",
    });
    expect(first).toMatchObject({
      ok: true,
      created: true,
      asset: { asset_id: "asset-1" },
    });
    const again = await putAsset(q, {
      purpose: "attachment",
      mime: "application/octet-stream",
      data: bytes,
      nowMs: NOW + 1,
      newId: () => "must-not-be-inserted",
    });
    expect(again).toMatchObject({
      ok: true,
      created: false,
      asset: { asset_id: "asset-1" },
    });
    const stored = getAsset(db, "asset-1");
    expect(Buffer.from(stored?.data ?? []).equals(Buffer.from(bytes))).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS count FROM assets").get()).toEqual({
      count: 1,
    });
  });

  it("rejects empty, oversized, or invalid-purpose uploads", async () => {
    const { q } = world();
    expect(
      await putAsset(q, {
        purpose: "attachment",
        mime: "application/octet-stream",
        data: new Uint8Array(),
        nowMs: NOW,
      }),
    ).toMatchObject({ ok: false });
    expect(
      await putAsset(q, {
        purpose: "avatar",
        mime: "image/png",
        data: new Uint8Array(20 * 1024 * 1024 + 1),
        nowMs: NOW,
      }),
    ).toMatchObject({ ok: false });
  });
});
