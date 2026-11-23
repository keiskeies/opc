/**
 * 群契约（design-2026-11-23-群角色上层.md D2/D6，实施计划 §3）。
 *
 * 群 = 一个任务（D2）。「建群」与「立项」是两个动作：建群时 task_id 为空，
 * 老板说「立项」且特助规则命中后回填 —— 所以 task_id 在创建请求与视图里都是可选项，
 * 这不是建模含糊，是上游 §2.2 的流程形状。
 */
import { z } from "zod";

export const GROUP_STATUSES = ["active", "archived"] as const;
export type GroupStatus = (typeof GROUP_STATUSES)[number];

/** 群标题上限：与 MAX_IDEA_CHARS 同量级——标题进审计 payload，审计 append-only。 */
export const MAX_GROUP_TITLE_CHARS = 200;
export const MAX_GROUP_GOAL_CHARS = 4000;

export const createGroupRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_GROUP_TITLE_CHARS),
    goal: z.string().trim().max(MAX_GROUP_GOAL_CHARS).default(""),
    /** 首批成员；特助由服务端自动追加，调用方不需要（也不应该）自己塞。 */
    member_ids: z.array(z.string().min(1).max(200)).max(50).default([]),
  })
  .strict();
export type CreateGroupRequest = z.infer<typeof createGroupRequestSchema>;

export const groupViewSchema = z
  .object({
    group_id: z.string().min(1),
    title: z.string(),
    goal: z.string(),
    task_id: z.string().nullable(),
    cos_member_id: z.string().nullable(),
    status: z.enum(GROUP_STATUSES),
    member_count: z.number().int().nonnegative(),
    created_at: z.number().int(),
    updated_at: z.number().int(),
  })
  .strict();
export type GroupView = z.infer<typeof groupViewSchema>;

/** 群成员任职行（seat 两值：特助席 / 普通席）。 */
export const GROUP_SEATS = ["cos", "member"] as const;
export type GroupSeat = (typeof GROUP_SEATS)[number];

export const groupMemberViewSchema = z
  .object({
    group_id: z.string().min(1),
    member_id: z.string().min(1),
    role_id: z.string().min(1),
    seat: z.enum(GROUP_SEATS),
    joined_at: z.number().int(),
  })
  .strict();
export type GroupMemberView = z.infer<typeof groupMemberViewSchema>;

export const addGroupMemberRequestSchema = z
  .object({
    member_id: z.string().min(1).max(200),
    /** 任职岗位：缺省用成员默认岗位；显式传 = 兼任（同一成员在不同群不同岗位）。 */
    role_id: z.string().min(1).max(200).optional(),
  })
  .strict();
export type AddGroupMemberRequest = z.infer<typeof addGroupMemberRequestSchema>;

export const updateGroupRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_GROUP_TITLE_CHARS).optional(),
    goal: z.string().trim().max(MAX_GROUP_GOAL_CHARS).optional(),
    status: z.enum(GROUP_STATUSES).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    // 空 PATCH 当场拒：200 而什么都没改，调用方会以为改成了（前端据此刷新缓存）。
    if (
      data.title === undefined &&
      data.goal === undefined &&
      data.status === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "PATCH /groups/:id 至少要带一个可改字段（title/goal/status）。",
      });
    }
  });
export type UpdateGroupRequest = z.infer<typeof updateGroupRequestSchema>;
