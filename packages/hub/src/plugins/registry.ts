/**
 * 内置插件注册表（D14「完整插件运行时」的加载/生命周期/版本管理三维）。
 *
 * ── 为什么注册表在 hub 代码里，而 plugins 表只记授权 ────────────────
 * builtin 的行为是进程内代码，没有任何安全的"从表里解释出行为"的办法。
 * 所以生命周期分成两半：
 *   · 代码侧（本文件）：模块清单 + 版本 + 工具声明 —— 发布时定死，运行期只读；
 *   · 库侧（plugins 表）：enabled 与 config_json —— 老板随时可改的授权面。
 * 两边的连接点是 plugin_id 字符串：安装（plugins/service.ts installPlugin 的
 * builtin 分支）必须指向【已注册模块】，表行只记授权。代码里有模块 ≠ 老板已授权：
 * 启动时不自动落表（无静默 seed），要它在招聘页出现就得显式安装 ——
 * 「装什么」与「配什么」在 UI 上同一条路，而执行只认真模块。
 *
 * ── 版本管理的口径（表里没有 version 列，为什么不加）────────────────
 * 0019 的列集是冻结的（迁移 append-only）。版本走 config_json 的
 * PLUGIN_VERSION_CONFIG_KEY：
 *   · 缺省 = 跟随代码侧当前版本（正常升级不需要老板动手）；
 *   · 显式写旧值 = 钉版本 —— 代码升级后配置没跟上就【拒绝执行】
 *     （plugin_version_pinned_unavailable），而不是悄悄用新代码跑旧配置。
 * 后一条是本文件存在意义最大的一格：插件行为变了而某成员还按旧行为授权，
 * 静默兼容 = 老板批准过的东西已经不再是他批准的那个。报错可修，伪证不可追。
 *
 * ── registerBuiltinPlugin 为什么判结构而不是只信类型 ────────────────
 * 见 contracts/plugin.ts 的 builtinPluginModuleProblem 注释（运行时注册绕得过
 * interface）。注册即判 ⇒ 坏模块起不来；判据只有一份，在 contracts 侧。
 */
import {
  type BuiltinPluginModule,
  builtinPluginModuleProblem,
} from "@opc/contracts";

/** config_json 里钉版本用的键（与 plugins 表的唯一交集，导出给 UI 文案用）。 */
export const PLUGIN_VERSION_CONFIG_KEY = "plugin_version";

const modules = new Map<string, BuiltinPluginModule>();

/**
 * 注册一个内置插件模块。重复注册同一 plugin_id ⇒ 抛
 * （两次 import 说明入口装配坏了；静默覆盖会让"哪个版本在跑"不可答）。
 */
export function registerBuiltinPlugin(m: BuiltinPluginModule): void {
  const problem = builtinPluginModuleProblem(m);
  if (problem !== null) {
    throw new Error(
      "registerBuiltinPlugin：模块不合格 —— " +
        problem +
        "。坏模块在注册点拒绝，而不是第一次执行才炸。",
    );
  }
  if (modules.has(m.plugin_id)) {
    throw new Error(
      "registerBuiltinPlugin：plugin_id=[" +
        m.plugin_id +
        "] 重复注册（先 " +
        modules.get(m.plugin_id)?.version +
        " 后 " +
        m.version +
        "）。「当前跑的是哪个版本」必须只有一个答案，静默覆盖会毁掉这一格。",
    );
  }
  modules.set(m.plugin_id, m);
}

/** 代码侧清单（安装校验/探测刷新/展示用），按 plugin_id 定序。 */
export function builtinPluginModules(): BuiltinPluginModule[] {
  return [...modules.values()].sort((a, b) =>
    a.plugin_id < b.plugin_id ? -1 : a.plugin_id > b.plugin_id ? 1 : 0,
  );
}

/** 取模块；未注册 ⇒ undefined（调用方负责翻成 plugin_not_found）。 */
export function getBuiltinPlugin(id: string): BuiltinPluginModule | undefined {
  return modules.get(id);
}

/**
 * 表里那行的 config_json 是否把版本【钉】在代码侧没有的值上。
 *
 * @returns null = 没钉或钉得住（可执行）；字符串 = 拒绝执行的理由。
 */
export function versionPinProblem(
  m: BuiltinPluginModule,
  config: Record<string, unknown>,
): string | null {
  const pinned = config[PLUGIN_VERSION_CONFIG_KEY];
  if (pinned === undefined || pinned === null) return null;
  if (typeof pinned !== "string") {
    return (
      "config_json." +
      PLUGIN_VERSION_CONFIG_KEY +
      " 必须是字符串（semver），实际是 " +
      typeof pinned
    );
  }
  if (pinned === m.version) return null;
  return (
    "配置钉在版本 [" +
    pinned +
    "]，当前代码里这个插件是 [" +
    m.version +
    "]。刻意【不静默兼容】：老板授权的是旧行为，代码升级后拿新行为跑旧授权，" +
    "等于批准过的东西不再是批准的那个。修法二选一：把版本钉回当前值，" +
    "或回滚到提供 " +
    pinned +
    " 的 hub 版本。"
  );
}

/** 仅测试用：清空注册表（装配类测试要自己注册桩模块，模块名单例不能互相踩）。 */
export function resetBuiltinPluginsForTests(): void {
  modules.clear();
}
