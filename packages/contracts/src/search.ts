/**
 * 全局搜索契约（design-2026-11-23-群角色上层.md §2.7 顶栏，实施计划 §3）。
 *
 * 多面聚合（task/member/message/doc/meeting/backlog）：顶栏一次查询跳六面，
 * 所以返回项必须自带「去哪一面」的判别字段，而不是六条并列数组各靠位置猜类型。
 * message/doc 两面走 FTS5（0015/0016 trigram），其余四面 LIKE 查询 ——
 * 各面的命中片段形状不同（FTS 有 snippet，LIKE 只有整行截断），故 snippet 可空。
 */
import { z } from "zod";

export const SEARCH_FACES = [
  "task",
  "member",
  "message",
  "document",
  "meeting",
  "backlog",
] as const;
export type SearchFace = (typeof SEARCH_FACES)[number];

export const searchHitSchema = z
  .object({
    face: z.enum(SEARCH_FACES),
    /** 面内主键（task.id / member_id / message_id / doc_id / meeting_id / backlog id）。 */
    id: z.string(),
    /** 展示标题（搜索框下拉里的主行）。 */
    title: z.string(),
    /** 命中上下文片段；非 FTS 面为整行截断，无片段时为空。 */
    snippet: z.string().nullable(),
    /** 跳转上下文：消息要带会话、文档要带群，否则点进去回不到原位。 */
    conversation_id: z.string().nullable(),
    group_id: z.string().nullable(),
    /** 结果行的时间戳（下拉里按时间倒序展示）。 */
    at: z.number().int(),
  })
  .strict();
export type SearchHit = z.infer<typeof searchHitSchema>;

export const searchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200),
    /** 缺省全面；界面切面（只搜文档）时传子集。 */
    faces: z.array(z.enum(SEARCH_FACES)).min(1).max(6).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type SearchQuery = z.infer<typeof searchQuerySchema>;
