/**
 * 会话契约（design-2026-11-23-群角色上层.md D2/D5/D16，实施计划 §3）。
 *
 * 两类会话（群 / 私聊 1:1，跨群可读）共用同一视图形状，kind 判别。
 * @ 提及是升级链的入口（D16）：正文里的 @老板 不是一个名字，
 * 而是一条会触发特助升级规则的指令，因此 mentions 是【解析后的结构】，
 * 调用方发正文、服务端解析 —— 但契约把解析结果显式化进视图，前端不再二次解析。
 */
import { z } from "zod";

/** @老板 的特殊提及值（D16：拍板升级链的入口，恒指向人类老板）。 */
export const MENTION_BOSS = "@boss";

export const CONVERSATION_KINDS = ["group", "private"] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

export const conversationViewSchema = z
  .object({
    conversation_id: z.string().min(1),
    kind: z.enum(CONVERSATION_KINDS),
    group_id: z.string().nullable(),
    /** 私聊双方（member_a 恒字典序小者——归一化在 DDL 的 CHECK 里，视图原样带出）。 */
    member_a: z.string().nullable(),
    member_b: z.string().nullable(),
    title: z.string(),
    created_at: z.number().int(),
    /** 未读数由服务端按 message_reads 游标算出（客户端不自算，见 0015 文件头）。 */
    unread_count: z.number().int().nonnegative(),
    last_message_preview: z.string().nullable(),
    last_message_at: z.number().int().nullable(),
  })
  .strict();
export type ConversationView = z.infer<typeof conversationViewSchema>;

export const MESSAGE_KINDS = [
  "text",
  "system",
  "meeting_card",
  "backlog_card",
  "doc_card",
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const AUTHOR_KINDS = ["member", "boss", "system"] as const;
export type AuthorKind = (typeof AUTHOR_KINDS)[number];

/** 消息正文上限：会话正文进 messages_fts 与全局搜索，与 idea 同量级收口。 */
export const MAX_MESSAGE_CHARS = 8000;

export const messageViewSchema = z
  .object({
    message_id: z.string().min(1),
    conversation_id: z.string().min(1),
    sender_member_id: z.string().nullable(),
    author_kind: z.enum(AUTHOR_KINDS),
    body: z.string(),
    /** 解析后的提及：member_id 或 MENTION_BOSS。 */
    mentions: z.array(z.string().min(1).max(200)),
    reply_to: z.string().nullable(),
    kind: z.enum(MESSAGE_KINDS),
    seq_in_conv: z.number().int().nonnegative(),
    created_at: z.number().int(),
  })
  .strict();
export type MessageView = z.infer<typeof messageViewSchema>;

/**
 * POST /conversations/:id/messages —— 老板在群里/私聊里说话。
 *
 * body 必填非空：空消息进 append-only 的时间线没有任何可读性，
 * 「撤回」也不是删除的理由（IM 惯例里空发会被拦截，这里在契约层就拦）。
 */
export const sendMessageRequestSchema = z
  .object({
    body: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
    reply_to: z.string().min(1).max(200).optional(),
  })
  .strict();
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

/** 打开私聊（D5：跨群可读——同两人恒同一条会话，重复打开返回既有的）。 */
export const openPrivateRequestSchema = z
  .object({
    member_a: z.string().min(1).max(200),
    member_b: z.string().min(1).max(200),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.member_a === data.member_b) {
      ctx.addIssue({
        code: "custom",
        message: "不能和自己开私聊：私聊的定义是两个人（D5）。",
      });
    }
  });
export type OpenPrivateRequest = z.infer<typeof openPrivateRequestSchema>;

export const markReadRequestSchema = z
  .object({
    /** 读到会话内第几号消息；省略 = 读到当前最新。 */
    last_seq_in_conv: z.number().int().nonnegative().optional(),
  })
  .strict();
export type MarkReadRequest = z.infer<typeof markReadRequestSchema>;

/** 会话历史翻页：before_seq 游标（往旧翻），limit 有界防全表拖取。 */
export const listMessagesQuerySchema = z
  .object({
    before_seq: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;
