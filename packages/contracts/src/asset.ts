/** 二进制资产上传契约：JSON base64 避免 Node HTTP 的 UTF-8 body 解码破坏字节。 */
import { z } from "zod";

export const ASSET_PURPOSES = [
  "avatar",
  "attachment",
  "import-source",
] as const;
export type AssetPurpose = (typeof ASSET_PURPOSES)[number];
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;

export const uploadAssetRequestSchema = z
  .object({
    purpose: z.enum(ASSET_PURPOSES),
    mime: z.string().trim().min(1).max(200),
    data_base64: z
      .string()
      .min(4)
      .max(Math.ceil(MAX_ASSET_BYTES / 3) * 4),
  })
  .strict();
export type UploadAssetRequest = z.infer<typeof uploadAssetRequestSchema>;

export const assetViewSchema = z
  .object({
    asset_id: z.string().min(1),
    purpose: z.enum(ASSET_PURPOSES),
    mime: z.string(),
    size_bytes: z.number().int().nonnegative(),
    sha256: z.string().length(64),
    created_at: z.number().int(),
  })
  .strict();
export type AssetView = z.infer<typeof assetViewSchema>;
