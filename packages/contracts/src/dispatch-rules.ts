/**
 * CoS 分发规则契约（§2.2「特助实现为规则优先」/ 0025 的读写面）。
 *
 * ── 为什么这张表需要一份契约 ──────────────────────────────────────
 * 分发判定是规则优先、模型兜底：规则命中就直接建任务，压根不问模型。既然是规则，
 * 它就是【老板的配置项】而不是代码常量 —— 0025 文件头写的「规则本身可停用」讲的
 * 是这件事。而 keyword → target_role_id 这条映射一旦可编辑，它的非法形状就不再是
 * 「显示不好看」：一个指向不存在岗位的关键字，会让每一条命中它的群消息当场失败；
 * 一个空串关键字会命中所有消息并把整群的活派给同一个岗位。所以判据在提交时生效。
 *
 * ── 为什么【不】给 id 与 keyword 设长度上限 ─────────────────────────
 * 0025 的 DDL 没有 VARCHAR 长度（SQLite 的 TEXT 恒不限长），而 0025 不可回改。
 * 契约若在这里写 .max(N)，那 N 就是仓库凭空发明的一条约束：界面、HTTP、手写库
 * 三条路只有前两条受它管，第三条照样能写出更长的值 —— 于是「超长」既不真拦得住、
 * 又会在合法长值上假报错（DDL 与界面各说一套）。plugin.ts 那边给 name 写了
 * .max(200)，那边写得上是因为端点 URL 有对端上限这个外部真相可对；关键字没有。
 */
import { z } from "zod";

/** 一条分发规则的完整视图（snake_case：与 HTTP/库里同名，少一层翻译）。 */
export const dispatchRuleViewSchema = z
  .object({
    rule_id: z.string().min(1),
    /** null = 全局规则；非空 = 只在该群生效（同优先级时本群规则优先）。 */
    group_id: z.string().nullable(),
    keyword: z.string(),
    target_role_id: z.string().min(1),
    /** 岗位展示名：规则列表要能读出「派给谁」，而不只一个 id。视图侧 JOIN 出来。 */
    target_role_name: z.string(),
    priority: z.number().int(),
    enabled: z.boolean(),
    created_at: z.number().int(),
    updated_at: z.number().int(),
  })
  .strict();
export type DispatchRuleView = z.infer<typeof dispatchRuleViewSchema>;

/** GET /api/v1/dispatch/rules 的响应体。 */
export const dispatchRuleListResponseSchema = z
  .object({ rules: z.array(dispatchRuleViewSchema) })
  .strict();
export type DispatchRuleListResponse = z.infer<
  typeof dispatchRuleListResponseSchema
>;

/**
 * 新建规则。
 * group_id 用 .nullable().default(null)：不传就是全局规则，这是常态而不是缺参数。
 * priority 给默认 0：DDL 的 DEFAULT 0 在库里，但 HTTP 的 PATCH 能改 priority ⇒
 * 请求体不写 priority 时前端必须能读到「现在是多少」，否则默认值这件事只有服务端知道。
 * rule_id 不接受调用方传入：主键由服务端生成，理由见 rules/service.ts 的 newRuleId。
 */
export const createDispatchRuleRequestSchema = z
  .object({
    keyword: z.string().trim().min(1),
    target_role_id: z.string().trim().min(1),
    group_id: z.string().trim().min(1).nullable().default(null),
    priority: z.number().int().default(0),
    enabled: z.boolean().default(true),
  })
  .strict();
export type CreateDispatchRuleRequest = z.infer<
  typeof createDispatchRuleRequestSchema
>;

/**
 * 改规则：所有字段可选，一个都不传 = 什么都没改（服务侧返回 audit_seq=0 哨兵）。
 * keyword 允许改（打错字与业务口径变化都是改名的理由），但 trim 后非空 ——
 * DDL 的 CHECK(length(trim(keyword)) > 0) 说「不许空」，而 0025 没约束首尾空格，
 * 所以这里补 trim：`" bug "` 与 `"bug"` 在 SQL 的 LIKE 里是两个关键字，
 * 前者永远匹配不上任何消息，而列表页把它们显示成同一个词。
 * rule_id 不可改：它是审计里指向这条规则的引用键。
 */
export const updateDispatchRuleRequestSchema = z
  .object({
    keyword: z.string().trim().min(1).optional(),
    target_role_id: z.string().trim().min(1).optional(),
    priority: z.number().int().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type UpdateDispatchRuleRequest = z.infer<
  typeof updateDispatchRuleRequestSchema
>;
