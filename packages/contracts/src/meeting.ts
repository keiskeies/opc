/**
 * 会议契约（design-2026-11-23-群角色上层.md D8 / 上游 §2.4，实施计划 §3）。
 *
 * 「真实会议」= 发言序列 + 主持指定下一位 + 结论三件套（决定/负责人/截止）。
 * 三件套在 conclude 请求里是【必填】—— 与 0017 的 DDL CHECK 同一判据的两端：
 * 契约挡调用方，DDL 挡一切旁路写入。只在一端挡，另一端就是洞。
 */
import { z } from "zod";

export const MEETING_STATUSES = ["open", "concluded", "cancelled"] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

/** 会议类型沿用 0001 既有词表（规格 §10）：扩展而不是另立（0017 文件头）。 */
export const MEETING_TYPES = ["review", "debate", "decision"] as const;
export type MeetingType = (typeof MEETING_TYPES)[number];

export const MAX_MEETING_TOPIC_CHARS = 200;
export const MAX_TURN_CHARS = 8000;

export const meetingTurnViewSchema = z
  .object({
    turn_id: z.number().int(),
    meeting_id: z.string().min(1),
    speaker_member_id: z.string().min(1),
    content: z.string(),
    turn_seq: z.number().int().nonnegative(),
    created_at: z.number().int(),
  })
  .strict();
export type MeetingTurnView = z.infer<typeof meetingTurnViewSchema>;

export const meetingViewSchema = z
  .object({
    meeting_id: z.string().min(1),
    group_id: z.string().nullable(),
    task_id: z.string().nullable(),
    meeting_type: z.enum(MEETING_TYPES),
    topic: z.string(),
    moderator_member_id: z.string().nullable(),
    /** 开场既定顺序；实际发言以 turns 为准（主持可临场指定，0017 文件头）。 */
    speaking_order: z.array(z.string().min(1)),
    status: z.enum(MEETING_STATUSES),
    decision: z.string().nullable(),
    owner_member_id: z.string().nullable(),
    deadline_at: z.number().int().nullable(),
    summary_doc_id: z.string().nullable(),
    /** 当前轮到谁；散会/取消后为 null。由服务层在每次发言后原子推进。 */
    next_speaker_member_id: z.string().nullable(),
    turns: z.array(meetingTurnViewSchema),
    opened_at: z.number().int(),
    concluded_at: z.number().int().nullable(),
  })
  .strict();
export type MeetingView = z.infer<typeof meetingViewSchema>;

export const createMeetingRequestSchema = z
  .object({
    group_id: z.string().min(1).max(200),
    task_id: z.string().min(1).max(200).optional(),
    meeting_type: z.enum(MEETING_TYPES).default("decision"),
    topic: z.string().trim().min(1).max(MAX_MEETING_TOPIC_CHARS),
    moderator_member_id: z.string().min(1).max(200),
    /** 开场发言顺序；缺省 = [主持]，后续由主持临场指定。 */
    speaking_order: z.array(z.string().min(1).max(200)).max(50).optional(),
  })
  .strict();
export type CreateMeetingRequest = z.infer<typeof createMeetingRequestSchema>;

export const postTurnRequestSchema = z
  .object({
    speaker_member_id: z.string().min(1).max(200),
    content: z.string().trim().min(1).max(MAX_TURN_CHARS),
    /** 发言者/主持人指定下一位；省略时按既定顺序推进并在末尾回到主持人。 */
    next_speaker_member_id: z.string().min(1).max(200).optional(),
  })
  .strict();
export type PostTurnRequest = z.infer<typeof postTurnRequestSchema>;

/**
 * POST /meetings/:id/conclude —— 结论三件套（上游 §2.4）。
 *
 * decision / owner_member_id / deadline_at 全必填：缺一不算开完会。
 * deadline_at 是 Unix 毫秒；契约不收「明天下午」这种自然语言——录入点应该
 * 是日期控件（前端），ISO/毫秒是机器间唯一的无歧义形状。
 */
export const concludeMeetingRequestSchema = z
  .object({
    decision: z.string().trim().min(1).max(4000),
    owner_member_id: z.string().min(1).max(200),
    deadline_at: z.number().int().positive(),
  })
  .strict();
export type ConcludeMeetingRequest = z.infer<
  typeof concludeMeetingRequestSchema
>;

/** 取消会议必须留下原因：时间线上不能说「取消了」却没有为什么。 */
export const cancelMeetingRequestSchema = z
  .object({
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
export type CancelMeetingRequest = z.infer<typeof cancelMeetingRequestSchema>;
