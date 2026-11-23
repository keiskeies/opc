/**
 * 人才市场契约（design-2026-11-23-群角色上层.md D3/D7，实施计划 §3）。
 *
 * 一条市场条目 = 一份自包含的成员蓝图（payload_json）：导出侧把成员的
 * persona/skills/executors/tier 全量序列化，导入侧在新公司生成全新 member_id。
 * 蓝图【不引用】源公司的 role_id 之外的任何本地 id —— role_id 是稳定语义键
 * （D11），新公司没有该角色时导入必须整单拒绝（见 importTalentRequestSchema 注释），
 * 而不是悄悄挂到一个不相干的默认角色上 —— 挂错角色的成员会在错误的汇报线里干活。
 */
import { z } from "zod";
import { MODEL_TIERS } from "./charter.js";
import {
  MAX_MEMBER_NAME_CHARS,
  memberExecutorSchema,
  memberSkillSchema,
  personaSchema,
  TONES,
  voiceSchema,
} from "./member.js";

export const TALENT_SOURCES = ["builtin", "imported", "published"] as const;
export type TalentSource = (typeof TALENT_SOURCES)[number];

/**
 * 市场条目蓝图（talent_market.payload_json 的形状）。
 *
 * 与 hireMemberRequestSchema 的关系：蓝图 = 招聘请求减去 seat_group_ids 与
 * avatar_asset_id。前者是「这个人是谁」（可移植），后者是「在这里怎么落位」
 * （本地决定）。avatar_asset_id 不可移植的理由：asset 字节存在源公司库里，
 * 导出文件带着二进制会让 payload 膨胀百倍且导入侧要处理任意字节入库。
 */
export const talentPayloadSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_MEMBER_NAME_CHARS),
    role_id: z.string().min(1).max(200),
    model_tier: z.enum(MODEL_TIERS),
    avatar_seed: z.string().trim().max(200).default(""),
    tone: z.enum(TONES).default("neutral"),
    persona: personaSchema,
    voice: voiceSchema.optional(),
    skills: z.array(memberSkillSchema).max(20).default([]),
    executors: z.array(memberExecutorSchema).min(1).max(10),
  })
  .strict();
export type TalentPayload = z.infer<typeof talentPayloadSchema>;

export const talentItemViewSchema = z
  .object({
    item_id: z.string().min(1),
    source: z.enum(TALENT_SOURCES),
    name: z.string(),
    published_at: z.number().int(),
    payload: talentPayloadSchema,
  })
  .strict();
export type TalentItemView = z.infer<typeof talentItemViewSchema>;

/**
 * 导入（把导出的蓝图文件挂进本店市场，不直接成成员 —— 先挂牌再雇，
 * 与 builtin 条目走同一条招聘路径，避免「导入专用快速通道」绕过招聘校验）。
 * 蓝图里的 role_id 在新公司不存在 ⇒ 服务端 422 整单拒绝（文件头说明的理由）。
 */
export const importTalentRequestSchema = z
  .object({
    payload: talentPayloadSchema,
  })
  .strict();
export type ImportTalentRequest = z.infer<typeof importTalentRequestSchema>;

/** 把本店在职成员挂上市（published 条目；payload 由服务端从成员现状生成，客户端只给 member_id）。 */
export const publishTalentRequestSchema = z
  .object({
    member_id: z.string().min(1).max(200),
  })
  .strict();
export type PublishTalentRequest = z.infer<typeof publishTalentRequestSchema>;
