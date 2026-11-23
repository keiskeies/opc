/**
 * 任务面板契约（design-2026-11-23-群角色上层.md D10 / 上游 §2.6，实施计划 §3）。
 *
 * 六操作（取消/移动/延期/优先级/拆分/合并）各自一个显式请求形状：
 * 一个通用 PATCH 也能表达其中一半，但「移动」写进通用 body 就和「改标题」
 * 没有区别，误发的破坏半径完全不同（移动会把条目从别人的群里抽走）。
 * 显式形状让每个操作可单独审计、单独加约束。
 */
import { z } from "zod";

export const BACKLOG_STATES = [
  "backlog",
  "scheduled",
  "doing",
  "done",
  "cancelled",
] as const;
export type BacklogState = (typeof BACKLOG_STATES)[number];

export const MAX_BACKLOG_TITLE_CHARS = 200;
export const MAX_BACKLOG_DETAIL_CHARS = 8000;

export const backlogItemViewSchema = z
  .object({
    id: z.string().min(1),
    group_id: z.string().nullable(),
    task_id: z.string().nullable(),
    title: z.string(),
    detail: z.string(),
    state: z.enum(BACKLOG_STATES),
    priority: z.number().int(),
    due_at: z.number().int().nullable(),
    parent_id: z.string().nullable(),
    merged_into: z.string().nullable(),
    created_at: z.number().int(),
    updated_at: z.number().int(),
  })
  .strict();
export type BacklogItemView = z.infer<typeof backlogItemViewSchema>;

export const createBacklogRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_BACKLOG_TITLE_CHARS),
    detail: z.string().trim().max(MAX_BACKLOG_DETAIL_CHARS).default(""),
    group_id: z.string().min(1).max(200).optional(),
    priority: z.number().int().min(-100).max(100).default(0),
    due_at: z.number().int().positive().optional(),
  })
  .strict();
export type CreateBacklogRequest = z.infer<typeof createBacklogRequestSchema>;

/** 移动：改归属群（跨群挪，上游 §2.6 的「移动」）。 */
export const moveBacklogRequestSchema = z
  .object({
    group_id: z.string().min(1).max(200).nullable(),
  })
  .strict();
export type MoveBacklogRequest = z.infer<typeof moveBacklogRequestSchema>;

/** 延期：改 due_at；省略 = 清除期限。 */
export const rescheduleBacklogRequestSchema = z
  .object({
    due_at: z.number().int().positive().nullable(),
  })
  .strict();
export type RescheduleBacklogRequest = z.infer<
  typeof rescheduleBacklogRequestSchema
>;

/** 优先级：小者先，负数 = 加急（与 DDL 语义一致）。 */
export const reprioritizeBacklogRequestSchema = z
  .object({
    priority: z.number().int().min(-100).max(100),
  })
  .strict();
export type ReprioritizeBacklogRequest = z.infer<
  typeof reprioritizeBacklogRequestSchema
>;

/**
 * 拆分：父项保留、子项新建（parent_id 指回，0018 文件头）。
 * 至少 2 个子项 —— 拆 1 个等于改名或新建，语义是混淆而非省事。
 */
export const splitBacklogRequestSchema = z
  .object({
    children: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(MAX_BACKLOG_TITLE_CHARS),
            detail: z.string().trim().max(MAX_BACKLOG_DETAIL_CHARS).default(""),
            priority: z.number().int().min(-100).max(100).optional(),
            due_at: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .min(2)
      .max(20),
  })
  .strict();
export type SplitBacklogRequest = z.infer<typeof splitBacklogRequestSchema>;

/** 合并：本项取消 + merged_into 指向目标（原件保留可追溯）。 */
export const mergeBacklogRequestSchema = z
  .object({
    into_id: z.string().min(1).max(200),
  })
  .strict();
// into_id === 本项自己的形状在路径里已排除（:id 在 URL）；「合并进自己」由服务端
// 复核（前端把列表里另一行的 id 错填成同行 id 是这里唯一拦不住的笔误）。
export type MergeBacklogRequest = z.infer<typeof mergeBacklogRequestSchema>;

export const listBacklogQuerySchema = z
  .object({
    group_id: z.string().min(1).max(200).optional(),
    state: z.enum(BACKLOG_STATES).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();
export type ListBacklogQuery = z.infer<typeof listBacklogQuerySchema>;
