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
    expect(Buffer.from(stored?.data ?? []).equals(Buffer.from(bytes))).toBe(
      true,
    );
    expect(db.prepare("SELECT COUNT(*) AS count FROM assets").get()).toEqual({
      count: 1,
    });
  });

  // 0074：去重键少 purpose 那一维时，这条链是屏幕上无解的死路 ——
  // 先当附件传过的字节再当头像传，拿回的是那条 attachment 行，绑头像必拒。
  it("same bytes under another purpose become a new row that passes the avatar gate", async () => {
    const { q, db } = world();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]);
    const asAttachment = await putAsset(q, {
      purpose: "attachment",
      mime: "image/png",
      data: bytes,
      nowMs: NOW,
      newId: () => "asset-att",
    });
    expect(asAttachment).toMatchObject({ ok: true, created: true });
    const asAvatar = await putAsset(q, {
      purpose: "avatar",
      mime: "image/png",
      data: bytes,
      nowMs: NOW + 1,
      newId: () => "asset-ava",
    });
    expect(asAvatar).toMatchObject({
      ok: true,
      created: true,
      asset: { asset_id: "asset-ava", purpose: "avatar" },
    });
    // 头像门（http/people.ts 与 members/service.ts 共用的那道 SQL 形状）逐字复用。
    const gate =
      "SELECT 1 AS ok FROM assets WHERE asset_id = ? AND purpose = 'avatar'";
    expect(db.prepare(gate).get("asset-ava")).toEqual({ ok: 1 });
    expect(db.prepare(gate).get("asset-att")).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS count FROM assets").get()).toEqual({
      count: 2,
    });
  });

  it("reverse direction keeps each purpose's own metadata", async () => {
    const { q, db } = world();
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    expect(
      await putAsset(q, {
        purpose: "avatar",
        mime: "image/png",
        data: bytes,
        nowMs: NOW,
        newId: () => "rev-ava",
      }),
    ).toMatchObject({ ok: true, created: true });
    const asAttachment = await putAsset(q, {
      purpose: "attachment",
      mime: "application/pdf",
      data: bytes,
      nowMs: NOW + 1,
      newId: () => "rev-att",
    });
    expect(asAttachment).toMatchObject({
      ok: true,
      created: true,
      asset: { asset_id: "rev-att", mime: "application/pdf" },
    });
    const rows = db
      .prepare(
        "SELECT purpose, mime FROM assets WHERE sha256 = (" +
          "SELECT sha256 FROM assets WHERE asset_id = ?) ORDER BY purpose",
      )
      .all("rev-att") as { purpose: string; mime: string }[];
    expect(rows).toEqual([
      { purpose: "attachment", mime: "application/pdf" },
      { purpose: "avatar", mime: "image/png" },
    ]);
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
