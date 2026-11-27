/**
 * round388 探针：同一份字节先当附件传、再当头像传，屏幕上会拿到什么。
 * 真库 + 真 SQL + 真 putAsset，不手工 stub。
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../packages/hub/src/db/migrate.js";
import { WriteQueue } from "../packages/hub/src/db/write-queue.js";
import { putAsset } from "../packages/hub/src/assets/service.js";

const TMP = join(tmpdir(), `r388-avatar-${process.pid}`);
mkdirSync(TMP, { recursive: true });
const NOW = Date.UTC(2026, 10, 27);
let seq = 0;
const queues: WriteQueue[] = [];

function world(): WriteQueue {
  const q = new WriteQueue(join(TMP, `p-${++seq}.db`));
  queues.push(q);
  migrate(q.writeConnection());
  return q;
}

// people.ts 的 AVATAR_ASSET_SQL 逐字复制。
const AVATAR_ASSET_SQL =
  "SELECT 1 AS ok FROM assets WHERE asset_id = ? AND purpose = 'avatar'";

function canBind(q: WriteQueue, assetId: string): boolean {
  return q.writeConnection().prepare(AVATAR_ASSET_SQL).get(assetId) !== undefined;
}

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8,
]);

let idSeq = 0;
const nid = () => `a-${++idSeq}`;

console.log("── ① 同一份字节：先 attachment 后 avatar ──");
{
  const q = world();
  const first = await putAsset(q, {
    purpose: "attachment",
    mime: "image/png",
    data: PNG,
    nowMs: NOW,
    newId: nid,
  });
  console.log("①a attachment:", JSON.stringify(first));
  if (!first.ok) throw new Error("①a 期望成功");
  const second = await putAsset(q, {
    purpose: "avatar",
    mime: "image/png",
    data: PNG,
    nowMs: NOW + 1,
    newId: nid,
  });
  console.log("①b avatar(同字节):", JSON.stringify(second));
  if (!second.ok) throw new Error("①b 期望成功");
  console.log(
    `①c 拿回的 asset：purpose=${second.asset.purpose} created=${second.created} id=${second.asset.asset_id}`,
  );
  console.log(`①d 绑头像能过吗（purpose='avatar' 那道门）：${canBind(q, second.asset.asset_id)}`);
  const rows = q
    .writeConnection()
    .prepare("SELECT asset_id, purpose, mime, sha256 FROM assets ORDER BY asset_id")
    .all();
  console.log("①e 库里实际行数:", JSON.stringify(rows));
  await q.close();
}

console.log("\n── ② 对照：全新字节直接当 avatar ──");
{
  const q = world();
  const bytes = new Uint8Array([...PNG, 0xff, 0xfe]);
  const r = await putAsset(q, {
    purpose: "avatar",
    mime: "image/png",
    data: bytes,
    nowMs: NOW,
    newId: nid,
  });
  console.log("②:", JSON.stringify(r));
  if (!r.ok) throw new Error("② 期望成功");
  console.log(`② 绑头像能过吗：${canBind(q, r.asset.asset_id)}`);
  await q.close();
}

console.log("\n── ③ 反向：先 avatar 后 attachment 会怎样 ──");
{
  const q = world();
  const a = await putAsset(q, {
    purpose: "avatar",
    mime: "image/png",
    data: PNG,
    nowMs: NOW,
    newId: nid,
  });
  const b = await putAsset(q, {
    purpose: "attachment",
    mime: "application/pdf",
    data: PNG,
    nowMs: NOW + 1,
    newId: nid,
  });
  console.log("③ 第二次（attachment）拿回:", JSON.stringify(b));
  if (a.ok && b.ok) {
    console.log(
      `③ mime 是否被第一次的Purpose带跑：期望 image/png（attachment 想写 application/pdf）⇒ 实得 ${b.asset.mime}`,
    );
  }
  await q.close();
}

for (const q of queues) {
  try {
    await q.close();
  } catch {
    /* already closed */
  }
}
rmSync(TMP, { recursive: true, force: true });
