/**
 * 插件与 MCP 契约（design-2026-11-23-群角色上层.md D14 / 上游 §2.9，实施计划 §3）。
 *
 * plugins 是「可插拔能力源」的登记簿，两类消费方（0019 文件头）：
 * member_executors 的 builtin-plugin / platform-webhook 执行器。
 * 工具清单落表而不是每次现探：招聘页渲染不随外部 MCP server 健康度抖动，
 * 真探测只在显式 POST /plugins/:id/probe 时发生。
 */
import { z } from "zod";

export const PLUGIN_KINDS = ["mcp", "builtin"] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];

export const pluginToolViewSchema = z
  .object({
    plugin_id: z.string().min(1),
    tool_name: z.string().min(1),
    description: z.string(),
    /** MCP tools/list 的 JSON Schema 原样存；执行器侧用它做入参校验。 */
    input_schema_json: z.record(z.string(), z.unknown()),
  })
  .strict();
export type PluginToolView = z.infer<typeof pluginToolViewSchema>;

export const pluginViewSchema = z
  .object({
    plugin_id: z.string().min(1),
    name: z.string(),
    kind: z.enum(PLUGIN_KINDS),
    endpoint: z.string().nullable(),
    enabled: z.boolean(),
    installed_at: z.number().int(),
    /** 最近一次探测的原始回执（可空 = 从未探测）。形状不约束：MCP 回执格式外方演化。 */
    last_probe_json: z.record(z.string(), z.unknown()).nullable(),
    tools: z.array(pluginToolViewSchema),
  })
  .strict();
export type PluginView = z.infer<typeof pluginViewSchema>;

/**
 * 安装请求。
 * kind 判别 endpoint 必填性：mcp 没有 endpoint 就什么都连不上（安装即废），
 * builtin 的 endpoint 恒空（进程内）。让必缺/必空两条约束在提交时生效，
 * 而不是等到第一次执行才炸 —— 与 executorConfigSchema 同一立场。
 *
 * builtin 分支带【必填 plugin_id】：内置插件的行为在代码模块里（plugin.ts 下方
 * BuiltinPluginModule），表行 = 老板对它的授权。「装一个内置插件」只能是
 * 「授权一个已注册的代码模块」，plugin_id 就是两边唯一的连接键 —— 让调用方
 * 现编 id 会造出一行永远执行不了的授权（执行侧拿 id 找不到模块）。
 * name 可选：缺省用模块自己的展示名（单一来源），传了就是老板改的叫法。
 */
export const installPluginRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("mcp"),
      name: z.string().trim().min(1).max(200),
      endpoint: z.string().url().max(2000),
      config: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
  z
    .object({
      kind: z.literal("builtin"),
      plugin_id: z.string().trim().min(1).max(200),
      name: z.string().trim().min(1).max(200).optional(),
      config: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
]);
export type InstallPluginRequest = z.infer<typeof installPluginRequestSchema>;

export const updatePluginRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    endpoint: z.string().url().max(2000).optional(),
    enabled: z.boolean().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type UpdatePluginRequest = z.infer<typeof updatePluginRequestSchema>;

/** 探测回执（POST /plugins/:id/probe 的响应体，同时覆盖 last_probe_json）。 */
export const pluginProbeResultSchema = z
  .object({
    ok: z.boolean(),
    /** 探测到的工具数与清单（ok=false 时为空数组）。 */
    tools: z.array(pluginToolViewSchema),
    /** 人类可读结论（失败时是给招聘页直接展示的错因，不是堆栈）。 */
    message: z.string(),
    probed_at: z.number().int(),
  })
  .strict();
export type PluginProbeResult = z.infer<typeof pluginProbeResultSchema>;

/**
 * builtin 插件的【模块形状】（design D14「完整插件运行时：加载/生命周期/工具授权/版本管理」）。
 *
 * ── 运行时的真相放在哪（产品口径的落地方式）────────────────────────
 * builtin = 进程内代码。仓里没有也不该有「从配置解释出行为」的求值器（那是把
 * 配置界面伪装成图灵完备，§12.3 反过度抽象同一立场）。所以：
 *   · 行为 = hub 代码里注册的一个模块（registerBuiltinPlugin，随版本发布）；
 *   · plugins 表那一行 = 老板对它的【授权与配置】（enabled / config_json 里的版本）。
 * 启动时【不】自动落表：代码里有模块 ≠ 老板允许用。要它出现在招聘页，
 * 就走显式安装（installPlugin 的 builtin 分支带 plugin_id），于是招聘页从表里读出
 * builtin 插件 —— 「装什么」与「配什么」在 UI 上同一条路，而执行只认真模块。
 *
 * ── 与 plugin_tools 登记表的关系 ──────────────────────────────────
 * 模块自己声明工具（tools()），注册表在安装/探测时把声明刷进 plugin_tools；
 * 执行前的入参校验与授权判定读的是 plugin_tools.input_schema_json，
 * 即【落表的声明】—— 执行器不 import 任何具体插件（依赖方向与 MCP 同构：
 * 只经由注册表）。
 *
 * ⚠ args 刻意是 unknown 而不是 record：模块的入参由【它自己声明的 schema】验
 * （注册表执行前用 plugin_tools.input_schema_json 对应的 zod 判据把过），
 * 到 run 这一格已经是合法值。在这一层再收形状 = 两份校验口径。
 */
export interface BuiltinPluginModule {
  readonly plugin_id: string;
  /** 展示名（招聘页/插件管理页），与表里的 name 同步。 */
  readonly name: string;
  /**
   * semver。落进安装校验/探测回执；表里的生效版本 = config_json 的 "plugin_version"
   * （缺省 = 代码侧当前值；回滚 = 显式写旧值，版本不符 ⇒ 执行拒绝，不跑旧配置新代码）。
   */
  readonly version: string;
  /** 工具声明。name 全局仅在本插件内唯一（plugin_tools 的 PK 就是它）。 */
  tools(): {
    readonly name: string;
    readonly description: string;
    readonly input_schema: Record<string, unknown>;
  }[];
  run(a: {
    readonly tool: string;
    readonly args: unknown;
    readonly config: Record<string, unknown>;
  }): Promise<{ readonly text: string }>;
}

/**
 * 模块注册时的结构判据。为什么不在 interface 上表达（编译期管不到运行时注册）：
 * registerBuiltinPlugin 吃的是【运行时对象】（将来可从目录动态 import），
 * interface 只能约束 import 那一刻的类型，管不了 `registerBuiltinPlugin(JSON.parse(…))`。
 * 判据在注册点执行 ⇒ 坏模块【起不来】，而不是第一次执行才炸。
 *
 * ⚠ 不用 z.function() 判方法（zod 4 对函数类型的支持刻意残缺）：
 * 声明性字段全过 zod，方法形状用 typeof 显式判 —— 两边都是【运行时】判据。
 */
export function builtinPluginModuleProblem(m: unknown): string | null {
  if (typeof m !== "object" || m === null) return "模块不是对象";
  const o = m as Record<string, unknown>;
  if (typeof o["plugin_id"] !== "string" || o["plugin_id"].trim() === "") {
    return "plugin_id 必须是非空字符串";
  }
  if (typeof o["name"] !== "string" || o["name"].trim() === "") {
    return "name 必须是非空字符串";
  }
  if (
    typeof o["version"] !== "string" ||
    !/^\d+\.\d+\.\d+/.test(o["version"])
  ) {
    return "version 必须是 semver 形态（x.y.z）";
  }
  if (typeof o["tools"] !== "function") return "tools() 必须是方法";
  if (typeof o["run"] !== "function") return "run() 必须是方法";
  let ts: unknown;
  try {
    ts = (o["tools"] as () => unknown)();
  } catch (e) {
    return "tools() 调用即抛：" + String(e);
  }
  if (!Array.isArray(ts)) return "tools() 必须返回数组";
  const seen = new Set<string>();
  for (const [i, t] of (ts as unknown[]).entries()) {
    if (typeof t !== "object" || t === null) {
      return "tools()[" + i + "] 不是对象";
    }
    const tt = t as Record<string, unknown>;
    if (typeof tt["name"] !== "string" || tt["name"].trim() === "") {
      return "tools()[" + i + "].name 必须是非空字符串";
    }
    const name = tt["name"];
    if (seen.has(name)) {
      return (
        "工具名 [" +
        name +
        "] 重复：plugin_tools 的 PK 会撞，第二件声明等于没写"
      );
    }
    seen.add(name);
    if (typeof tt["description"] !== "string") {
      return "tools()[" + i + "].description 必须是字符串";
    }
    if (
      typeof tt["input_schema"] !== "object" ||
      tt["input_schema"] === null ||
      Array.isArray(tt["input_schema"])
    ) {
      return "tools()[" + i + "].input_schema 必须是 JSON Schema 对象";
    }
  }
  return null;
}
