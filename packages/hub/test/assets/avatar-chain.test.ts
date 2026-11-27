import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { HireMemberRequest, Persona } from "@opc/contracts";
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
import { hireMember } from "../../src/members/service.js";
import { DRIVER_OFF } from "../fixtures/driver-state.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

/**
 * 头像上传的整条屏幕路径（0074）。
 *
 * 分三个文件测各段（assets/service.ts 的键、schema-upper 的索引）都不等于这条链能走通：
 * 0029 之前的失效正好落在【接缝】上 —— putAsset 返回 201 + 一个合法 asset_id，
 * 头像门随后按 purpose 拒掉它，屏幕上没有任何一步能补救。所以这条测试一次走完
 * 「传附件 → 同字节传头像 → 绑头像」，并且把负例（绑那条 attachment 行必拒）留在
 * 同一屏里 —— 负例是那道 purpose='avatar' 门的承重格，抽掉它这条链只剩半截证据。
 */
const TMP = fixtureTmp("avatar-chain", import.meta.url);
mkdirSync(TMP, { recursive: true });
const NOW = Date.UTC(2026, 10, 23);
const TOKEN = "avatar-chain-token";
const queues: WriteQueue[] = [];
let fileSeq = 0;

const PERSONA: Persona = {
  style: "read first",
  values: ["evidence"],
  honesty: "test before claiming",
};

/** 同一份字节两次上传时唯一变的就是 purpose —— 这正是 0029 之前会抢键的那一维。 */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52,
]);
const PNG_BASE64 = PNG_BYTES.toString("base64");

function hireRequest(): HireMemberRequest {
  return {
    name: "Member m-a",
    role_id: "dev",
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
}

async function world(): Promise<{ deps: HubDeps; db: DatabaseSync }> {
  const q = new WriteQueue(
    join(TMP, `avatar-chain-${process.pid}-${++fileSeq}.db`),
  );
  queues.push(q);
  const db = q.writeConnection();
  migrate(db);
  const hired = await hireMember(q, {
    req: hireRequest(),
    nowMs: NOW,
    newId: () => "m-a",
  });
  if (!hired.ok) throw new Error(hired.reason);
  const deps = buildHubDeps({
    queue: q,
    bus: new InMemoryEventBus(),
    token: TOKEN,
    now: () => NOW,
    driverState: () => DRIVER_OFF,
  });
  return { deps, db };
}

function request(method: string, path: string, body?: unknown): HubRequest {
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    method,
    path,
    target: path,
    query: {},
    headers: signedHeaders(TOKEN, {
      method,
      target: path,
      body: text,
      now: NOW,
    }),
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
  return handleRequest(deps, request(method, path, body));
}

function data<T>(body: unknown): T {
  return body as T;
}

/** 写入必须落 events 表并推进总线游标 —— 与 domain-routes 同一把尺子。 */
async function expectPersistedEvent(
  deps: HubDeps,
  write: { auditSeq?: number; broadcast_error?: unknown },
  expected: DomainEvent,
): Promise<void> {
  expect(write).not.toHaveProperty("broadcast_error");
  const auditSeq = write.auditSeq;
  if (typeof auditSeq !== "number") {
    throw new Error("写入响应缺少 auditSeq，事件断言无从挂起。");
  }
  expect(deps.bus.latestSeq()).toBeGreaterThanOrEqual(auditSeq);
  const subscription = deps.bus.subscribe(auditSeq - 1);
  try {
    const item = await subscription[Symbol.asyncIterator]().next();
    expect(item.done).toBe(false);
    expect(item.value).toMatchObject({ ...expected, seq: auditSeq });
  } finally {
    subscription.close();
  }
  expect(
    deps.db.prepare("SELECT id FROM events WHERE id = ?").get(auditSeq),
  ).toEqual({ id: auditSeq });
}

function avatarColumn(db: DatabaseSync): {
  avatar_asset_id: string | null;
  avatar_seed: string;
} {
  return db
    .prepare(
      "SELECT avatar_asset_id, avatar_seed FROM members WHERE member_id = 'm-a'",
    )
    .get() as { avatar_asset_id: string | null; avatar_seed: string };
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

describe("avatar upload chain over HTTP", () => {
  it("同一份字节先当附件再当头像：头像拿到自己的行并绑定成功", async () => {
    const { deps, db } = await world();

    const asAttachment = await call(deps, "POST", "/api/v1/assets", {
      purpose: "attachment",
      mime: "image/png",
      data_base64: PNG_BASE64,
    });
    expect(asAttachment.status).toBe(201);
    const attachment = data<{
      ok: boolean;
      created: boolean;
      asset: { asset_id: string; purpose: string; sha256: string };
    }>(asAttachment.body).asset;
    expect(attachment.purpose).toBe("attachment");
    expect(attachment.sha256).toHaveLength(64);

    // 屏幕上这就是「选了同一张图当头像」：字节一模一样，只有 purpose 变了。
    const asAvatar = await call(deps, "POST", "/api/v1/assets", {
      purpose: "avatar",
      mime: "image/png",
      data_base64: PNG_BASE64,
    });
    expect(asAvatar.status).toBe(201);
    const avatarBody = data<{
      ok: boolean;
      created: boolean;
      asset: { asset_id: string; purpose: string; sha256: string };
    }>(asAvatar.body);
    expect(avatarBody.created).toBe(true);
    expect(avatarBody.asset.purpose).toBe("avatar");
    expect(avatarBody.asset.sha256).toBe(attachment.sha256);
    expect(avatarBody.asset.asset_id).not.toBe(attachment.asset_id);
    const avatarId = avatarBody.asset.asset_id;

    // 负例先跑： attachment 那一行不能绑成头像，且拒绝必须一个字都不写。
    const refused = await call(deps, "POST", "/api/v1/members/m-a/avatar", {
      avatar_asset_id: attachment.asset_id,
    });
    expect(refused.status).toBe(422);
    expect(data<{ code: string }>(refused.body).code).toBe("asset_not_found");
    expect(avatarColumn(db)).toEqual({
      avatar_asset_id: null,
      avatar_seed: "",
    });

    const bound = await call(deps, "POST", "/api/v1/members/m-a/avatar", {
      avatar_asset_id: avatarId,
    });
    expect(bound.status).toBe(200);
    expect(
      data<{ member: { avatar_asset_id: string | null } }>(bound.body).member
        .avatar_asset_id,
    ).toBe(avatarId);
    await expectPersistedEvent(deps, data<{ auditSeq: number }>(bound.body), {
      kind: "MemberUpdated",
      memberId: "m-a",
      op: "profile",
    });
    expect(avatarColumn(db)).toEqual({
      avatar_asset_id: avatarId,
      avatar_seed: "",
    });

    // 两份用途各自一行，BLOB 却是同一份字节的两个登记（去重仍按用途各自成立）。
    const rows = db
      .prepare(
        "SELECT purpose, mime FROM assets WHERE sha256 = ? ORDER BY purpose",
      )
      .all(attachment.sha256) as { purpose: string; mime: string }[];
    expect(rows).toEqual([
      { purpose: "attachment", mime: "image/png" },
      { purpose: "avatar", mime: "image/png" },
    ]);
  });

  it("同用途重复上传仍然复用同一行：补维度没有把去重本身拆掉", async () => {
    const { deps, db } = await world();
    const first = await call(deps, "POST", "/api/v1/assets", {
      purpose: "avatar",
      mime: "image/png",
      data_base64: PNG_BASE64,
    });
    expect(first.status).toBe(201);
    const firstBody = data<{ created: boolean; asset: { asset_id: string } }>(
      first.body,
    );
    expect(firstBody.created).toBe(true);

    const again = await call(deps, "POST", "/api/v1/assets", {
      purpose: "avatar",
      mime: "image/png",
      data_base64: PNG_BASE64,
    });
    expect(again.status).toBe(201);
    const againBody = data<{
      created: boolean;
      asset: { asset_id: string };
    }>(again.body);
    expect(againBody.created).toBe(false);
    expect(againBody.asset.asset_id).toBe(firstBody.asset.asset_id);
    expect(db.prepare("SELECT COUNT(*) AS count FROM assets").get()).toEqual({
      count: 1,
    });
  });

  it("方向 B：先当头像传过的字节再当附件用，附件拿到自己的行与自己的 mime", async () => {
    const { deps, db } = await world();
    const asAvatar = await call(deps, "POST", "/api/v1/assets", {
      purpose: "avatar",
      mime: "image/png",
      data_base64: PNG_BASE64,
    });
    expect(asAvatar.status).toBe(201);
    const avatarId = data<{ asset: { asset_id: string } }>(asAvatar.body).asset
      .asset_id;

    const asAttachment = await call(deps, "POST", "/api/v1/assets", {
      purpose: "attachment",
      mime: "application/pdf",
      data_base64: PNG_BASE64,
    });
    expect(asAttachment.status).toBe(201);
    const attachmentBody = data<{
      created: boolean;
      asset: { asset_id: string; mime: string; purpose: string };
    }>(asAttachment.body);
    const attachment = attachmentBody.asset;
    expect(attachmentBody.created).toBe(true);
    expect(attachment.purpose).toBe("attachment");
    // 0029 之前这里静悄悄拿回那条 avatar 行，mime 还是第一次上传时那个 image/png。
    expect(attachment.mime).toBe("application/pdf");
    expect(attachment.asset_id).not.toBe(avatarId);
    expect(db.prepare("SELECT COUNT(*) AS count FROM assets").get()).toEqual({
      count: 2,
    });
  });

  it("不存在的 asset_id 绑头像必拒，且不会覆盖已有头像", async () => {
    const { deps, db } = await world();
    const seeded = await call(deps, "POST", "/api/v1/members/m-a/avatar", {
      avatar_seed: "seed-first",
    });
    expect(seeded.status).toBe(200);

    const refused = await call(deps, "POST", "/api/v1/members/m-a/avatar", {
      avatar_asset_id: "asset-never-uploaded",
    });
    expect(refused.status).toBe(422);
    expect(data<{ code: string }>(refused.body).code).toBe("asset_not_found");
    expect(avatarColumn(db)).toEqual({
      avatar_asset_id: null,
      avatar_seed: "seed-first",
    });
  });
});
