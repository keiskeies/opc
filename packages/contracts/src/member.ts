/**
 * 成员契约（design-2026-11-23-群角色上层.md D3/D4/D7/D13，实施计划 §3）。
 *
 * 成员 = persona + skills + executors + model_tier（上游 §2.3 的四件套），
 * 外加真人感三件（avatar / voice / tone，D13）。
 */
import { z } from "zod";
import { MODEL_TIERS, type ModelTier } from "./charter.js";

/**
 * 七种执行器（D4「全部可实现」，实施计划 T6）。
 *
 * ⚠ 这条常量与 packages/hub/resources/migrations/0013_members.sql 里
 * member_executors.kind 的 CHECK 枚举【必须逐字一致】，由
 * test/contracts/executor-kinds-parity.test.ts 把两侧词表对齐钉死。
 * 漂了的后果不是崩：DDL 收了第八种而 registry 没有 ⇒ 招进来一个跑不动的成员，
 * 第一次执行才炸；registry 有而 DDL 没有 ⇒ 招不进来。两种都比编译错难查。
 */
export const EXECUTOR_KINDS = [
  "claude-cli",
  "codex-cli",
  "qoder-cli",
  "platform-webhook",
  "builtin-plugin",
  "pure-model",
  "human",
] as const;
export type ExecutorKind = (typeof EXECUTOR_KINDS)[number];

/**
 * 执行器配置（config_json 的形状）。
 *
 * 刻意【按 kind 判别】而不是一张 all-optional 大杂烩：platform-webhook 必须有
 * plugin_id（它调的是 MCP 工具），human 不需要任何目标进程，CLI 三家可带 model 覆盖。
 * 判别联合让「platform-webhook 没配 plugin_id」在招聘页提交时就 422，
 * 而不是执行时才炸 —— 招聘失败与执行失败对用户的修复动作完全不同。
 */
export const executorConfigSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.enum(["claude-cli", "codex-cli", "qoder-cli"]),
      model: z.string().min(1).max(200).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("platform-webhook"),
      plugin_id: z.string().min(1).max(200),
      tool_name: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal("builtin-plugin"),
      plugin_id: z.string().min(1).max(200),
    })
    .strict(),
  z.object({ kind: z.literal("pure-model") }).strict(),
  z
    .object({
      kind: z.literal("human"),
      /** 真人席的收件方式（渲染成待办卡片；D7）。 */
      assignee_hint: z.string().trim().max(200).optional(),
    })
    .strict(),
]);
export type ExecutorConfig = z.infer<typeof executorConfigSchema>;

/** 成员执行器条目（seq = 优先级，数字小者优先）。 */
export const memberExecutorSchema = z
  .object({
    seq: z.number().int().min(1).max(99),
    kind: z.enum(EXECUTOR_KINDS),
    config: executorConfigSchema,
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine((data, ctx) => {
    // config.kind 必须与外层 kind 同值：外层用于路由，内层用于校验配置形状，
    // 两者各写一份就可能漂（外层 claude-cli 带着内层 plugin 配置也能落库）。
    if (data.config.kind !== data.kind) {
      ctx.addIssue({
        code: "custom",
        message: `执行器 kind=${data.kind} 与 config.kind=${data.config.kind} 不一致。`,
      });
    }
  });
export type MemberExecutor = z.infer<typeof memberExecutorSchema>;

export const memberSkillSchema = z
  .object({
    skill_id: z.string().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();
export type MemberSkill = z.infer<typeof memberSkillSchema>;

/**
 * 人格（D13 真人感的语义核心）。
 *
 * honesty 必填沿用 charter.ts 那条立场（§14.4 红线二：能力声明必须带诚实边界）——
 * 成员以「同事」身份出现在聊天流里，过度承诺的代价从「产出不可信」升级为
 * 「同事间不信任」，这一条不能因界面变友好而放松。
 */
export const personaSchema = z
  .object({
    style: z.string().trim().min(1).max(500),
    values: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
    honesty: z.string().trim().min(1).max(500),
  })
  .strict();
export type Persona = z.infer<typeof personaSchema>;

/** TTS 声音映射（D13）。引擎与音色留给浏览器 Web Speech API 的实际能力集。 */
export const voiceSchema = z
  .object({
    lang: z.string().min(2).max(35).default("zh-CN"),
    rate: z.number().min(0.5).max(2).default(1),
    pitch: z.number().min(0).max(2).default(1),
    /** 期望音色名（浏览器缺该音色时回落默认音，不报错）。 */
    voice_hint: z.string().trim().max(200).optional(),
  })
  .strict();
export type Voice = z.infer<typeof voiceSchema>;

export const TONES = [
  "neutral",
  "steady",
  "direct",
  "warm",
  "precise",
] as const;
export type Tone = (typeof TONES)[number];

export const MAX_MEMBER_NAME_CHARS = 100;

export const hireMemberRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_MEMBER_NAME_CHARS),
    role_id: z.string().min(1).max(200),
    model_tier: z.enum(MODEL_TIERS),
    persona: personaSchema,
    skills: z.array(memberSkillSchema).max(20).default([]),
    executors: z.array(memberExecutorSchema).min(1).max(10),
    tone: z.enum(TONES).default("neutral"),
    voice: voiceSchema.optional(),
    /** 头像：asset_id（已上传）与 avatar_seed（服务端生成）二选一。 */
    avatar_asset_id: z.string().min(1).max(200).optional(),
    avatar_seed: z.string().trim().max(200).optional(),
    /** 招聘后直接坐进这些群（招聘页支持「招完即上岗」）。 */
    seat_group_ids: z.array(z.string().min(1).max(200)).max(20).default([]),
  })
  .strict()
  .superRefine((data, ctx) => {
    const seqs = new Set<number>();
    for (const ex of data.executors) {
      if (seqs.has(ex.seq)) {
        ctx.addIssue({
          code: "custom",
          message: `执行器 seq=${ex.seq} 重复。优先级并列时「换下一个执行器重试」无从定义。`,
        });
      }
      seqs.add(ex.seq);
    }
    if (data.avatar_asset_id !== undefined && data.avatar_seed !== undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "avatar_asset_id 与 avatar_seed 二选一：两处都给时渲染方不知道该信谁。",
      });
    }
  });
export type HireMemberRequest = z.infer<typeof hireMemberRequestSchema>;

export const updateMemberRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_MEMBER_NAME_CHARS).optional(),
    role_id: z.string().min(1).max(200).optional(),
    model_tier: z.enum(MODEL_TIERS).optional(),
    persona: personaSchema.optional(),
    tone: z.enum(TONES).optional(),
    voice: voiceSchema.optional(),
    status: z.enum(["active", "archived"]).optional(),
  })
  .strict();
export type UpdateMemberRequest = z.infer<typeof updateMemberRequestSchema>;

export const memberViewSchema = z
  .object({
    member_id: z.string().min(1),
    name: z.string(),
    role_id: z.string(),
    model_tier: z.enum(MODEL_TIERS),
    persona: personaSchema,
    tone: z.enum(TONES),
    voice: voiceSchema.nullable(),
    avatar_asset_id: z.string().nullable(),
    avatar_seed: z.string(),
    skills: z.array(memberSkillSchema),
    executors: z.array(memberExecutorSchema),
    status: z.enum(["active", "archived"]),
    hired_at: z.number().int(),
    updated_at: z.number().int(),
  })
  .strict();
export type MemberView = z.infer<typeof memberViewSchema>;

/** 保证 ModelTier 与本文件的档位枚举同源（派生自 charter.ts，不复制值）。 */
export type MemberTier = ModelTier;
