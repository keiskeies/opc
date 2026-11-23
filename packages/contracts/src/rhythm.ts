/**
 * 节奏事件与每日调研契约（design-2026-11-23-群角色上层.md D15，实施计划 §3）。
 *
 * rhythm_events 是周期性管理动作的台账（计划会/站会/评审/回顾），
 * digest_doc_id 指向自动生成的纪要文档（文档中心自动沉淀的入口）；
 * research_cards 是 PM 每日调研卡（0021：同 URL 同日去重）。
 */
import { z } from "zod";

export const RHYTHM_EVENT_KINDS = [
  "sprint_planning",
  "standup",
  "review",
  "retro",
] as const;
export type RhythmEventKind = (typeof RHYTHM_EVENT_KINDS)[number];

export const rhythmEventViewSchema = z
  .object({
    event_id: z.string().min(1),
    kind: z.enum(RHYTHM_EVENT_KINDS),
    group_id: z.string().nullable(),
    at: z.number().int(),
    digest_doc_id: z.string().nullable(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type RhythmEventView = z.infer<typeof rhythmEventViewSchema>;

/** day 的形态（'YYYY-MM-DD'）：URL 参数按字符串透传，判式挡手改地址栏的坏值。 */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/u;

export const researchCardViewSchema = z
  .object({
    card_id: z.string().min(1),
    day: z.string().regex(DAY_RE),
    source: z.string(),
    title: z.string(),
    summary: z.string(),
    url: z.string().nullable(),
    created_at: z.number().int(),
    group_id: z.string().nullable(),
    backlog_item_id: z.string().nullable(),
    doc_id: z.string().nullable(),
  })
  .strict();
export type ResearchCardView = z.infer<typeof researchCardViewSchema>;

export const listRhythmQuerySchema = z
  .object({
    group_id: z.string().min(1).max(200).optional(),
    kind: z.enum(RHYTHM_EVENT_KINDS).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type ListRhythmQuery = z.infer<typeof listRhythmQuerySchema>;

export const listResearchQuerySchema = z
  .object({
    /** 缺省 = 今天（GET /research/today 的 today 由服务端时钟决定）。 */
    day: z.string().regex(DAY_RE).optional(),
  })
  .strict();
export type ListResearchQuery = z.infer<typeof listResearchQuerySchema>;

export const createRhythmEventRequestSchema = z
  .object({
    kind: z.enum(RHYTHM_EVENT_KINDS),
    group_id: z.string().min(1).max(200).optional(),
    at: z.number().int().positive().optional(),
    digest_doc_id: z.string().min(1).max(200).optional(),
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type CreateRhythmEventRequest = z.infer<
  typeof createRhythmEventRequestSchema
>;

export const createResearchCardRequestSchema = z
  .object({
    day: z.string().regex(DAY_RE).optional(),
    source: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(300),
    summary: z.string().trim().max(8000).default(""),
    url: z.string().url().max(2000).optional(),
    group_id: z.string().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.url === undefined && data.source !== "manual") {
      ctx.addIssue({
        code: "custom",
        message: "没有 URL 的调研卡必须标明 source='manual'。",
      });
    }
  });
export type CreateResearchCardRequest = z.infer<
  typeof createResearchCardRequestSchema
>;
