/** Content-addressed BLOB assets. Uploads are serialized by the domain writer. */
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ASSET_PURPOSES,
  type AssetPurpose,
  MAX_ASSET_BYTES,
} from "@opc/contracts";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import {
  assertParamCount,
  assertSingleStatement,
  type Writer,
} from "../db/write-queue.js";

export interface AssetMetadata {
  readonly asset_id: string;
  readonly purpose: AssetPurpose;
  readonly mime: string;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly created_at: number;
}

export interface Asset extends AssetMetadata {
  readonly data: Uint8Array;
}

export interface PutAssetOptions {
  readonly purpose: AssetPurpose;
  readonly mime: string;
  readonly data: Uint8Array;
  readonly nowMs: number;
  readonly newId?: () => string;
}

export type PutAssetResult =
  | {
      readonly ok: true;
      readonly asset: AssetMetadata;
      readonly created: boolean;
    }
  | {
      readonly ok: false;
      readonly code: "invalid_asset";
      readonly reason: string;
    };

type DbLike = Pick<DatabaseSync, "prepare">;
interface AssetRow {
  asset_id: string;
  purpose: string;
  mime: string;
  size_bytes: number | bigint;
  sha256: string;
  created_at: number | bigint;
}

const SELECT_METADATA_SQL =
  "SELECT asset_id, purpose, mime, size_bytes, sha256, created_at FROM assets WHERE sha256 = ?";
const INSERT_ASSET_SQL =
  "INSERT INTO assets (asset_id, purpose, mime, size_bytes, sha256, data, created_at) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?)";
const SELECT_ASSET_SQL =
  "SELECT asset_id, purpose, mime, size_bytes, sha256, created_at, data FROM assets " +
  "WHERE asset_id = ?";

function invalid(reason: string): PutAssetResult {
  return { ok: false, code: "invalid_asset", reason };
}

function metadata(row: AssetRow): AssetMetadata {
  return {
    asset_id: row.asset_id,
    purpose: row.purpose as AssetPurpose,
    mime: row.mime,
    size_bytes: Number(row.size_bytes),
    sha256: row.sha256,
    created_at: Number(row.created_at),
  };
}

function findMetadata(db: DbLike, sha256: string): AssetMetadata | undefined {
  const params = [sha256];
  assertSingleStatement(SELECT_METADATA_SQL);
  assertParamCount(SELECT_METADATA_SQL, params);
  const row = db.prepare(SELECT_METADATA_SQL).get(...(params as never[])) as
    | AssetRow
    | undefined;
  return row === undefined ? undefined : metadata(row);
}

/** Store one immutable asset; equal bytes reuse the existing row regardless of purpose. */
export async function putAsset(
  writer: Writer,
  options: PutAssetOptions,
): Promise<PutAssetResult> {
  if (!ASSET_PURPOSES.includes(options.purpose)) {
    return invalid("purpose 必须是 avatar、attachment 或 import-source。");
  }
  if (typeof options.mime !== "string" || options.mime.trim() === "") {
    return invalid("mime 必须是非空字符串。");
  }
  if (!(options.data instanceof Uint8Array)) {
    return invalid("data 必须是 Uint8Array。");
  }
  const size = options.data.byteLength;
  if (size <= 0) return invalid("资产内容不能为空。");
  if (size > MAX_ASSET_BYTES) return invalid("资产内容不能超过 20MB。");

  const sha256 = createHash("sha256").update(options.data).digest("hex");
  return writer.node(() => {
    const db = requireScopeDb("putAsset");
    const existing = findMetadata(db, sha256);
    if (existing !== undefined) {
      return { ok: true, asset: existing, created: false } as const;
    }
    const params: unknown[] = [
      options.newId?.() ?? randomUUID(),
      options.purpose,
      options.mime,
      size,
      sha256,
      options.data,
      options.nowMs,
    ];
    assertSingleStatement(INSERT_ASSET_SQL);
    assertParamCount(INSERT_ASSET_SQL, params);
    db.prepare(INSERT_ASSET_SQL).run(...(params as never[]));
    const saved = findMetadata(db, sha256);
    if (saved === undefined) {
      throw new Error("putAsset：写入后读不到资产，事务回滚。");
    }
    return { ok: true, asset: saved, created: true } as const;
  });
}

/** Read metadata and bytes together; undefined means the asset does not exist. */
export function getAsset(db: DbLike, id: string): Asset | undefined {
  const params = [id];
  assertSingleStatement(SELECT_ASSET_SQL);
  assertParamCount(SELECT_ASSET_SQL, params);
  const row = db.prepare(SELECT_ASSET_SQL).get(...(params as never[])) as
    | (AssetRow & { data: unknown })
    | undefined;
  if (row === undefined) return undefined;
  if (!(row.data instanceof Uint8Array)) {
    throw new Error("资产 [" + id + "] 的 BLOB 数据形状不正确。");
  }
  return { ...metadata(row), data: new Uint8Array(row.data) };
}
