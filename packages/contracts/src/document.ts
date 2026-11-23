/**
 * 文档中心契约（design-2026-11-23-群角色上层.md D12 / 上游 §2.8，实施计划 §3）。
 *
 * 四形态共享一正文（实施计划 A6）：kind 判别形态，body_text 承载内容，
 * mime 兜住渲染器选择。版本、30 天保留、三级权限、水印对四种形态完全同构，
 * 所以这些机制在契约里也只有一套形状 —— 拆四套必然「改一处忘三处」。
 */
import { z } from "zod";

export const DOC_KINDS = ["doc", "sheet", "markdown", "mindmap"] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export const DOC_ORIGINS = ["created", "imported", "auto"] as const;
export type DocOrigin = (typeof DOC_ORIGINS)[number];

export const WATERMARK_PROFILES = ["none", "internal", "confidential"] as const;
export type WatermarkProfile = (typeof WATERMARK_PROFILES)[number];

export const DOC_PERMISSION_TIERS = ["owner", "editor", "reader"] as const;
export type DocPermissionTier = (typeof DOC_PERMISSION_TIERS)[number];

/**
 * 版本保留天数（D12「30 天版本还原」）。
 * 口径钉在契约层：前端要显示「该版本将于 X 日过期」，Hub 的保留任务要按同一数裁剪，
 * 两处各写一个 30 迟早漂（漂了界面会承诺还原得出、实际还原不出的版本）。
 */
export const DOC_RETENTION_DAYS = 30;

export const MAX_DOC_TITLE_CHARS = 300;
/** 导入的整本 xlsx/docx 序列化后落 body_text；上限按文本体量给。 */
export const MAX_DOC_BODY_CHARS = 2_000_000;

export const documentViewSchema = z
  .object({
    doc_id: z.string().min(1),
    kind: z.enum(DOC_KINDS),
    title: z.string(),
    group_id: z.string().nullable(),
    task_id: z.string().nullable(),
    owner: z.string(),
    mime: z.string(),
    watermark_profile: z.enum(WATERMARK_PROFILES),
    origin: z.enum(DOC_ORIGINS),
    template_id: z.string().nullable(),
    created_at: z.number().int(),
    updated_at: z.number().int(),
    /** 正文只在详情视图给（列表视图读封面字段就够，不拖 2M 正文）。 */
    body_text: z.string().optional(),
    /** 当前用户对该文档的有效权限档（服务端按 0016 判定顺序算好）。 */
    my_tier: z.enum(DOC_PERMISSION_TIERS).optional(),
  })
  .strict();
export type DocumentView = z.infer<typeof documentViewSchema>;

export const documentVersionViewSchema = z
  .object({
    version_id: z.number().int(),
    doc_id: z.string(),
    seq: z.number().int(),
    author: z.string(),
    created_at: z.number().int(),
    /** 列表不含正文；单版本详情与还原预览才带回。 */
    body_text: z.string().optional(),
  })
  .strict();
export type DocumentVersionView = z.infer<typeof documentVersionViewSchema>;

export const documentPermissionViewSchema = z
  .object({
    doc_id: z.string(),
    grantee: z.string(),
    tier: z.enum(DOC_PERMISSION_TIERS),
  })
  .strict();
export type DocumentPermissionView = z.infer<
  typeof documentPermissionViewSchema
>;

export const documentTemplateViewSchema = z
  .object({
    template_id: z.string(),
    name: z.string(),
    kind: z.enum(DOC_KINDS),
    body_text: z.string(),
    builtin: z.boolean(),
  })
  .strict();
export type DocumentTemplateView = z.infer<typeof documentTemplateViewSchema>;

export const createDocumentRequestSchema = z
  .object({
    kind: z.enum(DOC_KINDS),
    title: z.string().trim().min(1).max(MAX_DOC_TITLE_CHARS),
    body_text: z.string().max(MAX_DOC_BODY_CHARS).default(""),
    group_id: z.string().min(1).max(200).optional(),
    task_id: z.string().min(1).max(200).optional(),
    watermark_profile: z.enum(WATERMARK_PROFILES).default("none"),
    /** 从模板起稿：模板正文由服务端注入，客户端不必回传。 */
    template_id: z.string().min(1).max(200).optional(),
  })
  .strict();
export type CreateDocumentRequest = z.infer<typeof createDocumentRequestSchema>;

/**
 * 保存：正文 + 期望的基线版本号（乐观锁）。
 * base_seq 缺省 = 不强校验（老板手改与成员 agent 产出撞车时，界面要求显式带
 * base_seq 走冲突提示）；每次成功保存必产新版本行（seq 递增），这是 30 天还原的前提。
 */
export const saveDocumentRequestSchema = z
  .object({
    body_text: z.string().max(MAX_DOC_BODY_CHARS),
    title: z.string().trim().min(1).max(MAX_DOC_TITLE_CHARS).optional(),
    base_seq: z.number().int().positive().optional(),
  })
  .strict();
export type SaveDocumentRequest = z.infer<typeof saveDocumentRequestSchema>;

export const updateDocumentMetaRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_DOC_TITLE_CHARS).optional(),
    watermark_profile: z.enum(WATERMARK_PROFILES).optional(),
    group_id: z.string().min(1).max(200).nullable().optional(),
  })
  .strict();
export type UpdateDocumentMetaRequest = z.infer<
  typeof updateDocumentMetaRequestSchema
>;

/** grantee 三类取值（0016 文件头）：'boss'、member_id、'group:<id>'。 */
export const docGranteeSchema = z
  .string()
  .min(1)
  .max(201)
  .regex(/^(boss|group:[A-Za-z0-9_-]+|[A-Za-z0-9_-]+)$/u, {
    message:
      "grantee 只能是 boss、group:<group_id> 或 member_id（0016 三级权限的三类取值）",
  });

export const setDocumentPermissionRequestSchema = z
  .object({
    grantee: docGranteeSchema,
    tier: z.enum(["editor", "reader"]).default("reader"),
  })
  .strict();
export type SetDocumentPermissionRequest = z.infer<
  typeof setDocumentPermissionRequestSchema
>;

/**
 * 导入（docx/xlsx/md 上传字节后的登记请求）。
 * 字节先走 POST /assets（purpose='import-source'），这里只引用 asset_id ——
 * multipart 与 JSON 混一个端点会让 desktop IPC 面（纯 JSON 通道）接不了导入。
 */
export const importDocumentRequestSchema = z
  .object({
    asset_id: z.string().min(1).max(200),
    /** 缺省由服务端按资产 mime/扩展名推断；显式给出则必须与可解析格式匹配。 */
    kind: z.enum(DOC_KINDS).optional(),
    title: z.string().trim().min(1).max(MAX_DOC_TITLE_CHARS).optional(),
    group_id: z.string().min(1).max(200).optional(),
  })
  .strict();
export type ImportDocumentRequest = z.infer<typeof importDocumentRequestSchema>;

/** 导出：目标格式即对应 Content-Type 的选择器（md 恒可；docx/xlsx 仅 sheet/doc 形态）。 */
export const DOC_EXPORT_FORMATS = ["md", "docx", "xlsx", "pdf"] as const;
export type DocExportFormat = (typeof DOC_EXPORT_FORMATS)[number];

export const listDocumentsQuerySchema = z
  .object({
    group_id: z.string().min(1).max(200).optional(),
    task_id: z.string().min(1).max(200).optional(),
    kind: z.enum(DOC_KINDS).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>;
