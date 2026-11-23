/**
 * 角色契约（design-2026-11-23-群角色上层.md D9/D11，实施计划 §3）。
 *
 * roles 是一张可配置的公司树（0011）：内置行随迁移而来、不可删；
 * 自定义行在无人任职时可删（任职检查在应用层，见 0011 触发器说明）。
 */
import { z } from "zod";
import { charterInput, MODEL_TIERS } from "./charter.js";

export const ROLE_CATEGORIES = [
  "executive",
  "product",
  "engineering",
  "design",
  "support",
] as const;
export type RoleCategory = (typeof ROLE_CATEGORIES)[number];

export const ROLE_KINDS = ["builtin", "custom"] as const;
export type RoleKind = (typeof ROLE_KINDS)[number];

export const MAX_ROLE_NAME_CHARS = 100;

export const roleViewSchema = z
  .object({
    role_id: z.string().min(1),
    name: z.string(),
    kind: z.enum(ROLE_KINDS),
    category: z.enum(ROLE_CATEGORIES),
    reports_to: z.string().nullable(),
    model_tier: z.enum(MODEL_TIERS),
    /** 当前任职人数（服务端 join group_members 算好；界面据此决定删除按钮可用性）。 */
    occupant_count: z.number().int().min(0),
    avatar_seed: z.string(),
    created_at: z.number().int(),
    updated_at: z.number().int(),
  })
  .strict();
export type RoleView = z.infer<typeof roleViewSchema>;

export const createRoleRequestSchema = z
  .object({
    role_id: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-z][a-z0-9_]*$/u, {
        message:
          "role_id 用小写字母开头的蛇形标识（与既有角色同形，避免展示层两种取键规则）",
      }),
    name: z.string().trim().min(1).max(MAX_ROLE_NAME_CHARS),
    category: z.enum(ROLE_CATEGORIES),
    /** 汇报线：缺省挂 boss（新设岗位默认是老板直属）。 */
    reports_to: z.string().min(1).max(200).default("boss"),
    model_tier: z.enum(MODEL_TIERS),
    avatar_seed: z.string().trim().max(200).optional(),
  })
  .strict();
export type CreateRoleRequest = z.infer<typeof createRoleRequestSchema>;

export const updateRoleRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_ROLE_NAME_CHARS).optional(),
    category: z.enum(ROLE_CATEGORIES).optional(),
    /**
     * 换汇报线。服务端必须拒环（A 改到 A 的子孙下会把公司树剪断）——
     * 判据与 test/org/validate.test.ts 的 validateReparenting 同源复用，
     * 这里不重复实现，只声明形状。kind 不可改：内置行禁降级由 0011 触发器焊死。
     */
    reports_to: z.string().min(1).max(200).optional(),
    model_tier: z.enum(MODEL_TIERS).optional(),
    avatar_seed: z.string().trim().max(200).optional(),
  })
  .strict();
export type UpdateRoleRequest = z.infer<typeof updateRoleRequestSchema>;

/**
 * 设置角色的内嵌岗位书（0011 的 charter_json 列）。
 *
 * charter 带的是【输入形状】（snake_case）：服务端写入前先过 validateCharterDraft
 * （身份一致 + charterSchema），库里只存归一后的 camelCase —— 与 charter/store.ts
 * 的 saveCharterVersion 同一条「写前归一」口径。null = 清除岗位书（该角色回到
 * 纯汇报节点；图谱装配侧这一格会回退 preset 模板，见 roles/registry.ts 文件头）。
 *
 * 为什么这里嵌 charterInput 而不是 charterSchema：后者是 transform 之后的输出
 * （camelCase）。请求体若按输出形状收，调用方就得自己先 snake→camel 一遍，
 * 而服务端马上又要 camel→snake 校验回去 —— 归一发生两次、两个方向，
 * 中间任何一端搞错键名，strict 会当场 422，但错误信息会指向「不认识的键
 * displayName」这种让人绕远路的方向。输入形状直通服务端归一，报错才落在点上。
 */
export const setRoleCharterRequestSchema = z
  .object({
    charter: charterInput.nullable(),
  })
  .strict();
export type SetRoleCharterRequest = z.infer<typeof setRoleCharterRequestSchema>;
