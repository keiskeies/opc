/**
 * ⚠⚠ 今天【零生产入口】：plugins/service.ts 只被 test/plugins/service.test.ts 调，
 * HTTP（T10）与 executors/（T6 后续文件）还没接线 ⚠⚠
 * 接线那天 checkBaseline 方向 B 会红并点名基线里这一行 ⇒ 连横幅一起自删。
 *
 * 插件服务（T6 / D14「完整插件运行时」）：plugins / plugin_tools 的唯一写路径，
 * 外加两条运行时能力：探测（probe）与执行（executeTool）。
 *
 * ── 两半生命周期的接线处（registry.ts 文件头立过的分法，落在这里）──────
 *   · 代码侧 = hub/src/plugins/registry.ts：内置模块清单（发布时定死，运行期只读）；
 *   · 库侧 = 本文件写的行：老板的【授权与配置】（enabled / config_json）。
 * 内置安装因此必须带 plugin_id（契约 builtin 分支的必填）：「装一个内置插件」
 * = 「授权一个已注册的代码模块」。代码里没有那个模块 ⇒ 安装当场拒
 * （builtin_module_not_found）——装一行跑不起来的授权，比装不上更糟。
 *
 * ── 内置不自动落表（产品判断，登记）────────────────────────────────
 * registry 有模块 ≠ plugins 表有行。老板没授权的内置不该出现在招聘页上
 * （§12.7：授权面前置）；要它出现就显式 install。启动时静默 seed 会把
 * 「代码里存在」伪装成「老板允许用」，两者是两个问题。
 *
 * ── 网络不进写事务（本文件与 members/service.ts 形状最大的差别）──────
 * 探测/执行要出网（MCP streamable HTTP 连外部 server）。若整段包在 w.node() 里，
 * 单写者队列就被一次外部调用按住几十秒：期间所有招聘、发言、审计全部排队
 * （0003 单写者的代价在这里第一次真的付钱）。所以 mcp 路径拆三步：
 *   node1 读授权行 → 事务外开连接 + 调用 → node2 落账。
 * node1 与 node2 之间授权可能被并发改（禁用/删除）。不防：授权检查的执行点
 * 在调用【之前】，调用已经发生的部分不因后到的禁用而撤销 —— 这是所有外部
 * 副作用的固有竞态，SQLite 的行锁救不了它，假装能救才会写出错的判据。
 *
 * ── mcp 连接策略：每次探测/执行一条新连接 ──────────────────────────
 * streamable HTTP 会话可复用，但连接池的生命周期管理（重连/失效/泄漏回收）
 * 是又一整个子系统；完整运行时承诺的是行为、授权、版本三件，不是连接池。
 * 每次新建 + finally 必关：无状态 ⇒ 无泄漏、无失效会话、无跨请求串话。
 * 代价（每次一个 initialize 往返）是本地部署可忽略的毫秒级。
 *
 * ── 执行判据链（顺序即口径，§12.7「拦在门外」清单）───────────────────
 *   ① 行存在        ⇒ plugin_not_found
 *   ② enabled=1     ⇒ plugin_disabled（禁用 = 老板一键止血，先于一切细节报它）
 *   ③ 工具在 plugin_tools 里 ⇒ plugin_tool_not_found（表 = 授权面，不在 = 没授权）
 *   ④ 入参过 input_schema_json ⇒ plugin_tool_invalid_args（@cfworker/json-schema）
 *   ⑤ builtin：模块在 + 版本钉得住 ⇒ plugin_not_found / plugin_version_mismatch
 *   ⑥ 真调用 ⇒ 对端业务错 plugin_tool_error / 连不上 plugin_transport_error
 * 为什么工具先于入参：入参校验要用工具自己的 schema，工具都不存在就没有
 * schema 可用 —— 依赖顺序，不是偏好。
 *
 * ── 删除为什么物理删 ────────────────────────────────────────────────
 * 0019 的 plugins 没有 status 列（DDL 冻结），enabled=0 是软删语义。但授权表与
 * 通讯录不同：成员归档要留席位证据（members/service.ts 文件头），插件行没有
 * 同类证据需求（执行历史在 events 审计里，不在这张表）。member_executors 的
 * config_json 里指向已删插件的引用【不清理】（JSON 列无 FK），执行链撞上时
 * 得到 plugin_not_found —— 报错可修，静默改写别人的执行器配置不可追。
 *
 * ── 新插件默认 enabled=1（产品判断，登记）──────────────────────────
 * 装插件的动作本身就是授权（老板亲手填了端点/点了安装）；再默认禁用会造出
 * 「装了但处处报 plugin_disabled」的迷惑态，一键启停另有其键。
 *
 * ── 读侧守门 ────────────────────────────────────────────────────────
 * last_probe_json / input_schema_json 读回过 pluginViewSchema（同 members 侧
 * assembleMember 立场）：行在而形状坏 ⇒ 抛，不把「库坏了」翻译成「这插件没工具」。
 * config_json【不在】视图里（pluginViewSchema 无此字段）：它的坏形状不拦列表页，
 * 只在真正要用它的 executeTool 里炸 —— 报表不该被一行坏配置打挂。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ValidationResult } from "@cfworker/json-schema";
import { Validator } from "@cfworker/json-schema";
import type {
  ExecutorFailureCode,
  InstallPluginRequest,
  PluginKind,
  PluginProbeResult,
  PluginView,
  RejectCode,
  UpdatePluginRequest,
} from "@opc/contracts";
import { CEO_ROLE_ID, pluginViewSchema } from "@opc/contracts";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import {
  assertParamCount,
  assertSingleStatement,
  type Writer,
} from "../db/write-queue.js";
import { appendAudit } from "../events/recorder.js";
import {
  builtinPluginModules,
  getBuiltinPlugin,
  versionPinProblem,
} from "./registry.js";

/** 审计署名：插件是老板亲手装的资产（同 MEMBER_ACTOR / ROLE_ACTOR 的立场）。 */
const PLUGIN_ACTOR = { actorType: "human", actorId: CEO_ROLE_ID } as const;

/** 一次 MCP 网络往返的硬上限（毫秒）。无超时的探测会把 UI 挂到 TCP 自己放弃。 */
const MCP_TIMEOUT_MS = 60_000;

/**
 * 服务层自己的错误码。与执行语义侧的七个【复用】ExecutorFailureCode（子集），
 * 执行器拿到 executeTool 的拒绝后原样进自己的 attempts —— 两份词表漂移过一次
 * 就是「插件层说 A、执行层报 B」。子集由 test/plugins/service.test.ts 逐字钉住。
 * 服务独有的四个：
 *  · builtin_module_not_found —— 授权请求指向代码里没有的内置模块（安装期）；
 *  · plugin_already_installed —— plugin_id 已占用（幂等安装交给调用方判断）；
 *  · endpoint_not_allowed —— 给 builtin 改 endpoint（进程内插件没有端点）；
 *  · plugin_name_required —— mcp 安装缺展示名（契约已必填，这里是防御性镜像）。
 */
export type PluginServiceCode =
  | Extract<
      ExecutorFailureCode,
      | "plugin_not_found"
      | "plugin_disabled"
      | "plugin_tool_not_found"
      | "plugin_tool_invalid_args"
      | "plugin_transport_error"
      | "plugin_tool_error"
      | "plugin_version_mismatch"
    >
  | "builtin_module_not_found"
  | "plugin_already_installed"
  | "endpoint_not_allowed"
  | "plugin_name_required"
  | "not_writable"
  | RejectCode;

export type PluginServiceError = {
  ok: false;
  reason: string;
  code: PluginServiceCode;
};

/** 写操作成功：插件视图 + 审计游标。 */
export type PluginWriteResult =
  | { ok: true; plugin: PluginView; auditSeq: number }
  | PluginServiceError;

/**
 * 探测成功信封。probe.ok=false 是【业务结果】（连不上、工具列表拉不到）——
 * 它照常落 last_probe_json 并记审计，所以走 ok:true 信封；
 * 行不存在才是 ok:false 的服务错误（没有东西可落账）。
 */
export type PluginProbeOutcome =
  | { ok: true; plugin: PluginView; probe: PluginProbeResult; auditSeq: number }
  | PluginServiceError;

/** 执行工具成功：文本输出 + 插件种类（执行器审计要记走的是哪条路）。 */
export type ExecuteToolResult =
  | { ok: true; text: string; kind: PluginKind }
  | PluginServiceError;

export function pluginServiceStatus(code: PluginServiceCode): number {
  switch (code) {
    case "plugin_not_found":
      return 404;
    case "not_writable":
      return 500;
    default:
      return 422;
  }
}

/** 审计 payload.kind 的六个取值（action 恒为 state_change，与成员/角色侧同族）。 */
export const PLUGIN_AUDIT_KINDS = [
  "plugin_installed",
  "plugin_updated",
  "plugin_enabled",
  "plugin_disabled",
  "plugin_deleted",
  "plugin_probed",
] as const;
export type PluginAuditKind = (typeof PLUGIN_AUDIT_KINDS)[number];

/** 只读侧最小连接形状（同 members/service.ts 的 DbLike 手法）。 */
type DbLike = Pick<DatabaseSync, "prepare">;

/** plugins 行形状（config_json/last_probe_json 是 JSON 文本列）。 */
export interface PluginRow {
  plugin_id: string;
  name: string;
  kind: string;
  endpoint: string | null;
  config_json: string;
  enabled: number | bigint;
  installed_at: number | bigint;
  last_probe_json: string | null;
}

interface ToolRow {
  plugin_id: string;
  tool_name: string;
  description: string;
  input_schema_json: string;
}

const PLUGIN_COLS =
  "plugin_id, name, kind, endpoint, config_json, enabled, installed_at, last_probe_json";

/** 全部插件（无外键级联需求，一次 JOIN 前缀 + 一次 tools 全表按插件分组，两次查询）。 */
const SELECT_ALL_PLUGINS_SQL =
  "SELECT " +
  PLUGIN_COLS +
  " FROM plugins ORDER BY installed_at DESC, plugin_id";

const SELECT_PLUGIN_SQL =
  "SELECT " + PLUGIN_COLS + " FROM plugins WHERE plugin_id = ?";

const SELECT_PLUGIN_TOOLS_SQL =
  "SELECT plugin_id, tool_name, description, input_schema_json FROM plugin_tools " +
  "ORDER BY plugin_id, tool_name";

const SELECT_PLUGIN_TOOLS_FOR_SQL =
  "SELECT plugin_id, tool_name, description, input_schema_json FROM plugin_tools " +
  "WHERE plugin_id = ? ORDER BY tool_name";

const SELECT_PLUGIN_TOOL_SQL =
  "SELECT tool_name, description, input_schema_json FROM plugin_tools " +
  "WHERE plugin_id = ? AND tool_name = ?";

const INSERT_PLUGIN_SQL =
  "INSERT INTO plugins (plugin_id, name, kind, endpoint, config_json, enabled, " +
  "installed_at, last_probe_json) VALUES (?, ?, ?, ?, ?, 1, ?, NULL)";

const INSERT_PLUGIN_TOOL_SQL =
  "INSERT INTO plugin_tools (plugin_id, tool_name, description, input_schema_json) " +
  "VALUES (?, ?, ?, ?)";

const DELETE_PLUGIN_TOOLS_SQL = "DELETE FROM plugin_tools WHERE plugin_id = ?";

const DELETE_PLUGIN_SQL = "DELETE FROM plugins WHERE plugin_id = ?";

/**
 * 覆盖式更新（一次 UPDATE 改任意字段子集）拆成三条窄语句而不是动态拼 SET：
 * assertParamCount 的自检要吃【字面量】SQL 才数得出问号，拼出来的 SQL 让每处
 * 写入都退化成「运行时才知道形状」—— 这是 0.5 立 assertSingleStatement 时
 * 点名的失效方向。三条窄语句覆盖全部组合：
 *  · 名称/配置（config 变更时版本钉校验在调用点先做过）；
 *  · 端点（仅 mcp 可达，builtin 在 updatePlugin 里先拒）；
 *  · 启停。
 */
const UPDATE_PLUGIN_META_SQL =
  "UPDATE plugins SET name = ?, config_json = ? WHERE plugin_id = ?";

const UPDATE_PLUGIN_ENDPOINT_SQL =
  "UPDATE plugins SET endpoint = ? WHERE plugin_id = ?";

const UPDATE_PLUGIN_ENABLED_SQL =
  "UPDATE plugins SET enabled = ? WHERE plugin_id = ?";

const UPDATE_PLUGIN_PROBE_SQL =
  "UPDATE plugins SET last_probe_json = ? WHERE plugin_id = ?";

function err(code: PluginServiceCode, reason: string): PluginServiceError {
  return { ok: false, reason, code };
}

function exists(db: DbLike, sql: string, params: unknown[]): boolean {
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  return db.prepare(sql).get(...(params as never[])) !== undefined;
}

function runSql(db: DbLike, sql: string, params: unknown[]): void {
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  db.prepare(sql).run(...(params as never[]));
}

// ── 读侧装配 ────────────────────────────────────────────────────────

/**
 * 行 + 工具行 → PluginView（读侧唯一守门，同 members/assembleMember 立场）。
 * last_probe_json 是【我们】写进去的 JSON 对象；parse 不出对象 = 手改库，抛。
 * 工具行按 plugin_id 预分组后传入（列表页两次查询拼好，避免 N+1）。
 */
function assemblePlugin(
  row: PluginRow,
  toolRows: readonly ToolRow[],
): { ok: true; view: PluginView } | { ok: false; reason: string } {
  const tools: unknown[] = [];
  let probe: Record<string, unknown> | null = null;
  try {
    for (const t of toolRows) {
      tools.push({
        plugin_id: t.plugin_id,
        tool_name: t.tool_name,
        description: t.description,
        input_schema_json: JSON.parse(t.input_schema_json) as Record<
          string,
          unknown
        >,
      });
    }
    probe =
      row.last_probe_json === null
        ? null
        : (JSON.parse(row.last_probe_json) as Record<string, unknown>);
  } catch (e) {
    return {
      ok: false,
      reason:
        "插件 [" +
        row.plugin_id +
        "] 的 JSON 列坏了（" +
        (e instanceof Error ? e.message : String(e)) +
        "），读侧拒绝装配。",
    };
  }
  const candidate = {
    plugin_id: row.plugin_id,
    name: row.name,
    kind: row.kind as PluginKind,
    endpoint: row.endpoint,
    enabled: Number(row.enabled) === 1,
    installed_at: Number(row.installed_at),
    last_probe_json: probe,
    tools,
  };
  const parsed = pluginViewSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      reason:
        "插件 [" +
        row.plugin_id +
        "] 的行形状与契约不一致：" +
        parsed.error.issues
          .map((i) => i.path.join(".") + " " + i.message)
          .join("；"),
    };
  }
  return { ok: true, view: parsed.data };
}

function listToolRows(db: DbLike): Map<string, ToolRow[]> {
  assertSingleStatement(SELECT_PLUGIN_TOOLS_SQL);
  const rows = db
    .prepare(SELECT_PLUGIN_TOOLS_SQL)
    .all() as unknown as ToolRow[];
  const byPlugin = new Map<string, ToolRow[]>();
  for (const r of rows) {
    const arr = byPlugin.get(r.plugin_id);
    if (arr === undefined) byPlugin.set(r.plugin_id, [r]);
    else arr.push(r);
  }
  return byPlugin;
}

/** 插件列表（含工具清单）；一次全表读 + 一次工具全表读，不随插件数 N+1。 */
export function listPlugins(db: DbLike): PluginView[] {
  assertSingleStatement(SELECT_ALL_PLUGINS_SQL);
  const rows = db
    .prepare(SELECT_ALL_PLUGINS_SQL)
    .all() as unknown as PluginRow[];
  const byPlugin = listToolRows(db);
  return rows.map((row) => {
    const a = assemblePlugin(row, byPlugin.get(row.plugin_id) ?? []);
    if (!a.ok) throw new Error("listPlugins：" + a.reason);
    return a.view;
  });
}

/** 读一个插件；undefined = 库里没有。装配失败（JSON 坏）抛错。 */
export function getPlugin(
  db: DbLike,
  pluginId: string,
): PluginView | undefined {
  const params = [pluginId];
  assertSingleStatement(SELECT_PLUGIN_SQL);
  assertParamCount(SELECT_PLUGIN_SQL, params);
  const row = db.prepare(SELECT_PLUGIN_SQL).get(...(params as never[])) as
    | PluginRow
    | undefined;
  if (row === undefined) return undefined;
  assertSingleStatement(SELECT_PLUGIN_TOOLS_FOR_SQL);
  assertParamCount(SELECT_PLUGIN_TOOLS_FOR_SQL, params);
  const toolRows = db
    .prepare(SELECT_PLUGIN_TOOLS_FOR_SQL)
    .all(...(params as never[])) as unknown as ToolRow[];
  const a = assemblePlugin(row, toolRows);
  if (!a.ok) throw new Error("getPlugin：" + a.reason);
  return a.view;
}

function mustView(db: DbLike, pluginId: string): PluginView {
  const v = getPlugin(db, pluginId);
  if (v === undefined) {
    // 写路径刚写完再读却没了：事务里自己刚插的行不可能消失，走到这就是接缝坏了。
    throw new Error(
      "mustView：插件 [" + pluginId + "] 写入后读不到（不应发生）",
    );
  }
  return v;
}

function parseConfigOrThrow(row: PluginRow): Record<string, unknown> {
  let cfg: unknown;
  try {
    cfg = JSON.parse(row.config_json) as unknown;
  } catch (e) {
    throw new Error(
      "插件 [" +
        row.plugin_id +
        "] 的 config_json 不是合法 JSON（" +
        (e instanceof Error ? e.message : String(e)) +
        "）。执行拒绝：拿一份读不懂的配置去调工具，等于没配置。",
    );
  }
  if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) {
    throw new Error(
      "插件 [" + row.plugin_id + "] 的 config_json 不是 JSON 对象，执行拒绝。",
    );
  }
  return cfg as Record<string, unknown>;
}

// ── 写侧：安装 ──────────────────────────────────────────────────────

/**
 * 安装。mcp：name+endpoint 必填（契约判别分支保证），id 由服务生成 —— 端点没有
 * 天然主键，让老板现编 id 会造出重名/撞车两类假故障。
 * builtin：plugin_id 必填且必须是【已注册模块】；name 缺省用模块展示名（单一来源）。
 * 两条路都在同一事务里把工具清单刷进 plugin_tools：
 *  · builtin 取模块声明（seedTools）；
 *  · mcp 留空表 —— 「装完即见工具」要靠一次显式探测（安装时同步连外网会把
 *    安装接口绑死在对方健康度上；招聘页读表不读网，0019 文件头同一条理由）。
 */
export async function installPlugin(
  w: Writer,
  o: {
    readonly req: InstallPluginRequest;
    readonly nowMs: number;
    readonly newId?: () => string;
  },
): Promise<PluginWriteResult> {
  return w.node(() => {
    const db = requireScopeDb("installPlugin");
    if (o.req.kind === "builtin") {
      const mod = getBuiltinPlugin(o.req.plugin_id);
      if (mod === undefined) {
        return err(
          "builtin_module_not_found",
          "代码里没有内置模块 [" +
            o.req.plugin_id +
            "]（当前清单：" +
            (builtinPluginModules()
              .map((m) => m.plugin_id)
              .join(", ") || "空") +
            "）。内置插件随 hub 版本发布，安装只能授权已有模块。",
        );
      }
      if (exists(db, SELECT_PLUGIN_SQL, [mod.plugin_id])) {
        return err(
          "plugin_already_installed",
          "插件 [" + mod.plugin_id + "] 已安装：改配置用 PATCH，不要重复安装。",
        );
      }
      // 与 updatePlugin 的门⑤同判据：钉一个代码里没有的版本在安装时就拒，
      // 比让第一个挂它的成员在执行期撞 plugin_version_mismatch 早一整条链路。
      const pin = versionPinProblem(mod, o.req.config);
      if (pin !== null) return err("plugin_version_mismatch", pin);
      const insertParams: unknown[] = [
        mod.plugin_id,
        o.req.name ?? mod.name,
        "builtin",
        null,
        JSON.stringify(o.req.config),
        o.nowMs,
      ];
      runSql(db, INSERT_PLUGIN_SQL, insertParams);
      seedTools(db, mod.plugin_id, mod.tools());
      const view = mustView(db, mod.plugin_id);
      const auditSeq = appendAudit(
        db,
        {
          taskId: null,
          actorType: PLUGIN_ACTOR.actorType,
          actorId: PLUGIN_ACTOR.actorId,
          action: "state_change",
          target: mod.plugin_id,
          payload: {
            kind: "plugin_installed" satisfies PluginAuditKind,
            plugin_id: mod.plugin_id,
            plugin_kind: "builtin",
            module_version: mod.version,
            tool_count: mod.tools().length,
          },
          stateSnapshot: { before: null, after: view },
          createdAt: o.nowMs,
        },
        () => o.nowMs,
      );
      return { ok: true, plugin: view, auditSeq };
    }
    // mcp 分支
    const name = o.req.name.trim();
    if (name === "") {
      return err(
        "plugin_name_required",
        "MCP 插件必须有展示名（契约已必填；走到这格说明请求绕过了契约）。",
      );
    }
    const pluginId = o.newId?.() ?? randomUUID();
    const insertParams: unknown[] = [
      pluginId,
      name,
      "mcp",
      o.req.endpoint,
      JSON.stringify(o.req.config),
      o.nowMs,
    ];
    runSql(db, INSERT_PLUGIN_SQL, insertParams);
    const view = mustView(db, pluginId);
    const auditSeq = appendAudit(
      db,
      {
        taskId: null,
        actorType: PLUGIN_ACTOR.actorType,
        actorId: PLUGIN_ACTOR.actorId,
        action: "state_change",
        target: pluginId,
        payload: {
          kind: "plugin_installed" satisfies PluginAuditKind,
          plugin_id: pluginId,
          plugin_kind: "mcp",
          endpoint: o.req.endpoint,
        },
        stateSnapshot: { before: null, after: view },
        createdAt: o.nowMs,
      },
      () => o.nowMs,
    );
    return { ok: true, plugin: view, auditSeq };
  });
}

/** 模块声明 → plugin_tools（先清后刷，同值幂等）。注册表判据保证工具名不重复。 */
function seedTools(
  db: DbLike,
  pluginId: string,
  tools: {
    readonly name: string;
    readonly description: string;
    readonly input_schema: Record<string, unknown>;
  }[],
): void {
  runSql(db, DELETE_PLUGIN_TOOLS_SQL, [pluginId]);
  for (const t of tools) {
    runSql(db, INSERT_PLUGIN_TOOL_SQL, [
      pluginId,
      t.name,
      t.description,
      JSON.stringify(t.input_schema),
    ]);
  }
}

// ── 写侧：改 / 启停 / 删 ────────────────────────────────────────────

/**
 * PATCH 语义。三条窄 UPDATE 按变更字段各跑各的；changed 空数组 ⇒ 不写不审
 * （同值 PATCH 不落审计 = 成员侧「同值写不记台账」的插件版：授权没变）。
 * builtin 改 endpoint ⇒ endpoint_not_allowed（进程内没有端点可改）；
 * builtin 改 config ⇒ 当场过 versionPinProblem —— 钉一个不存在的版本在设置时
 * 拒，比让成员跑第一次才炸早一整条链路（文件头①②③的「拦在门外」取向）。
 */
export async function updatePlugin(
  w: Writer,
  o: {
    readonly pluginId: string;
    readonly req: UpdatePluginRequest;
    readonly nowMs: number;
  },
): Promise<PluginWriteResult> {
  return w.node(() => {
    const db = requireScopeDb("updatePlugin");
    const params = [o.pluginId];
    assertSingleStatement(SELECT_PLUGIN_SQL);
    assertParamCount(SELECT_PLUGIN_SQL, params);
    const row = db.prepare(SELECT_PLUGIN_SQL).get(...(params as never[])) as
      | PluginRow
      | undefined;
    if (row === undefined) {
      return err(
        "plugin_not_found",
        "插件 [" + o.pluginId + "] 不存在，没有任何东西被改。",
      );
    }
    const isBuiltin = row.kind === "builtin";
    if (isBuiltin && o.req.endpoint !== undefined) {
      return err(
        "endpoint_not_allowed",
        "内置插件没有端点可改（行为在代码模块里）：endpoint 只对 mcp 插件有意义。",
      );
    }
    if (isBuiltin && o.req.config !== undefined) {
      const mod = getBuiltinPlugin(row.plugin_id);
      if (mod === undefined) {
        // 行在模块缺 = hub 降级发布过（或手插过行）。改配置前就拒，
        // 免得新 config 落库后执行期撞 plugin_not_found，病因被时间线冲淡。
        return err(
          "plugin_not_found",
          "内置模块 [" + row.plugin_id + "] 不在当前代码里，改配置没有意义。",
        );
      }
      const pin = versionPinProblem(mod, o.req.config);
      if (pin !== null) return err("plugin_version_mismatch", pin);
    }
    const before = mustView(db, o.pluginId);
    const changed: string[] = [];
    const nextName = o.req.name?.trim() ?? row.name;
    const nextConfigJson =
      o.req.config === undefined
        ? row.config_json
        : JSON.stringify(o.req.config);
    if (nextName !== row.name || nextConfigJson !== row.config_json) {
      changed.push("name/config");
      runSql(db, UPDATE_PLUGIN_META_SQL, [
        nextName,
        nextConfigJson,
        o.pluginId,
      ]);
    }
    if (
      o.req.endpoint !== undefined &&
      o.req.endpoint !== null &&
      o.req.endpoint !== row.endpoint
    ) {
      changed.push("endpoint");
      runSql(db, UPDATE_PLUGIN_ENDPOINT_SQL, [o.req.endpoint, o.pluginId]);
    }
    if (
      o.req.enabled !== undefined &&
      Number(o.req.enabled) !== Number(row.enabled)
    ) {
      changed.push("enabled");
      runSql(db, UPDATE_PLUGIN_ENABLED_SQL, [
        o.req.enabled ? 1 : 0,
        o.pluginId,
      ]);
    }
    if (changed.length === 0) {
      // 同值 PATCH：返回现视图，auditSeq=0 表示【没有】新审计行（0 是「无事件」哨兵，
      // recorder 文件头那条游标语义的镜像用法）。
      return { ok: true, plugin: before, auditSeq: 0 };
    }
    const after = mustView(db, o.pluginId);
    const auditSeq = appendAudit(
      db,
      {
        taskId: null,
        actorType: PLUGIN_ACTOR.actorType,
        actorId: PLUGIN_ACTOR.actorId,
        action: "state_change",
        target: o.pluginId,
        payload: {
          kind: "plugin_updated" satisfies PluginAuditKind,
          plugin_id: o.pluginId,
          changed,
        },
        stateSnapshot: { before, after },
        createdAt: o.nowMs,
      },
      () => o.nowMs,
    );
    return { ok: true, plugin: after, auditSeq };
  });
}

/**
 * 启用/停用（一键止血键）。停用不改任何授权内容，只让门 ② 落下；
 * 启用回滚同一条 —— 两个方向各记各的审计 kind，报表按 kind 分得清开关史。
 */
export async function setPluginEnabled(
  w: Writer,
  o: {
    readonly pluginId: string;
    readonly enabled: boolean;
    readonly nowMs: number;
  },
): Promise<PluginWriteResult> {
  return w.node(() => {
    const db = requireScopeDb("setPluginEnabled");
    const params = [o.pluginId];
    assertSingleStatement(SELECT_PLUGIN_SQL);
    assertParamCount(SELECT_PLUGIN_SQL, params);
    const row = db.prepare(SELECT_PLUGIN_SQL).get(...(params as never[])) as
      | PluginRow
      | undefined;
    if (row === undefined) {
      return err(
        "plugin_not_found",
        "插件 [" + o.pluginId + "] 不存在，开不了也关不了。",
      );
    }
    const before = mustView(db, o.pluginId);
    if (before.enabled === o.enabled) {
      return { ok: true, plugin: before, auditSeq: 0 };
    }
    runSql(db, UPDATE_PLUGIN_ENABLED_SQL, [o.enabled ? 1 : 0, o.pluginId]);
    const after = mustView(db, o.pluginId);
    const kind: PluginAuditKind = o.enabled
      ? "plugin_enabled"
      : "plugin_disabled";
    const auditSeq = appendAudit(
      db,
      {
        taskId: null,
        actorType: PLUGIN_ACTOR.actorType,
        actorId: PLUGIN_ACTOR.actorId,
        action: "state_change",
        target: o.pluginId,
        payload: {
          kind: kind satisfies PluginAuditKind,
          plugin_id: o.pluginId,
        },
        stateSnapshot: { before, after },
        createdAt: o.nowMs,
      },
      () => o.nowMs,
    );
    return { ok: true, plugin: after, auditSeq };
  });
}

/**
 * 物理删（文件头「删除为什么物理删」）。先删 plugin_tools 子行（FK 无级联）。
 * 审计在删【之后】落：stateSnapshot.after=null 语义是「这行已经没了」，
 * 删前落账会让快照撒谎。
 */
export async function deletePlugin(
  w: Writer,
  o: { readonly pluginId: string; readonly nowMs: number },
): Promise<PluginWriteResult> {
  return w.node(() => {
    const db = requireScopeDb("deletePlugin");
    const before = getPlugin(db, o.pluginId);
    if (before === undefined) {
      return err(
        "plugin_not_found",
        "插件 [" + o.pluginId + "] 不存在，没有任何东西被删。",
      );
    }
    runSql(db, DELETE_PLUGIN_TOOLS_SQL, [o.pluginId]);
    runSql(db, DELETE_PLUGIN_SQL, [o.pluginId]);
    const auditSeq = appendAudit(
      db,
      {
        taskId: null,
        actorType: PLUGIN_ACTOR.actorType,
        actorId: PLUGIN_ACTOR.actorId,
        action: "state_change",
        target: o.pluginId,
        payload: {
          kind: "plugin_deleted" satisfies PluginAuditKind,
          plugin_id: o.pluginId,
          plugin_kind: before.kind,
        },
        stateSnapshot: { before, after: null },
        createdAt: o.nowMs,
      },
      () => o.nowMs,
    );
    return { ok: true, plugin: before, auditSeq };
  });
}

// ── MCP 连接器（探测与执行共用的接缝）───────────────────────────────

/** 工具清单条目（连接器返回形状；落表时补 plugin_id）。 */
export interface PluginToolListing {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** 工具调用的连接器结果：ok=false 时对端回了 isError（业务错），不是没联系上。 */
export interface PluginCallResult {
  ok: boolean;
  text: string;
  message?: string;
}

/**
 * 连接器的最小接口 —— 服务的判据链只认这四个方法，不认 SDK。
 * 测试注入桩连接器（不开端口）就能测完执行链；真实现是下面的 mcpConnector。
 * start() 单独成一步：连不上（transport_error）与调用出错（tool_error）的
 * 分界点是它，合进 callTool 就把两类错揉成一种。
 */
export interface PluginConnector {
  start(): Promise<void>;
  listTools(): Promise<PluginToolListing[]>;
  callTool(name: string, args: unknown): Promise<PluginCallResult>;
  close(): Promise<void>;
}

/**
 * 连接器工厂（注入接缝）。【异步】：SDK 是 ESM-only 且体积不小，动态 import
 * 让 plugins 服务在没有 mcp 插件的部署里一行 SDK 代码都不加载。
 * 抛错 = transport_error 原料（含 bad URL / 坏 header 配置 / 连不上）。
 */
export type ConnectorFactory = (row: PluginRow) => Promise<PluginConnector>;

/** config_json 的 mcp 侧可用键（其余键插件自己解释，服务不猜）。 */
const MCP_CONFIG_KEYS = {
  bearer: "bearer_token",
  headers: "headers",
} as const;

/**
 * 从 config_json 攒 HTTP 头。两个键都严格判型（不是字符串 ⇒ 抛给 transport
 * 分支翻译成人话）：bearer_token 后写，覆盖 headers 里同名的 Authorization ——
 * 专用键赢过通用袋是配置界面的通行语义，反过来会让老板以为写了 bearer 生效了。
 */
export function headersFromConfig(
  config: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const rawHeaders = config[MCP_CONFIG_KEYS.headers];
  if (rawHeaders !== undefined) {
    if (
      typeof rawHeaders !== "object" ||
      rawHeaders === null ||
      Array.isArray(rawHeaders)
    ) {
      throw new Error("config.headers 必须是字符串→字符串的对象");
    }
    for (const [k, v] of Object.entries(
      rawHeaders as Record<string, unknown>,
    )) {
      if (typeof v !== "string") {
        throw new Error("config.headers[" + k + "] 必须是字符串");
      }
      out[k] = v;
    }
  }
  const bearer = config[MCP_CONFIG_KEYS.bearer];
  if (bearer !== undefined) {
    if (typeof bearer !== "string" || bearer.trim() === "") {
      throw new Error("config.bearer_token 必须是非空字符串");
    }
    out["Authorization"] = "Bearer " + bearer;
  }
  return out;
}

/** content 块数组里抠人类可读文本；没有 text 块就把原结构 JSON 化带出（不编话）。导出给测试直接钉判据。 */
export function textFromContent(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (typeof b === "object" && b !== null) {
        const t = b as { type?: unknown; text?: unknown };
        if (t.type === "text" && typeof t.text === "string") parts.push(t.text);
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  // 非文本回执（纯 image/resource 块）：原样 JSON 化，读的人看到的是结构而不是空白。
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** 真连接器：每次调用一条新连接（文件头「连接策略」），close 幂等。 */
export async function mcpConnector(row: PluginRow): Promise<PluginConnector> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );
  const endpoint = row.endpoint;
  if (endpoint === null || endpoint === "") {
    throw new Error("mcp 插件行缺 endpoint（行数据坏了）");
  }
  const headers = headersFromConfig(parseConfigOrThrow(row));
  const client = new Client({ name: "opc-hub", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    ...(Object.keys(headers).length > 0 ? { requestInit: { headers } } : {}),
  });
  let started = false;
  return {
    async start() {
      await client.connect(transport);
      started = true;
    },
    async listTools() {
      const r = await client.listTools(undefined, { timeout: MCP_TIMEOUT_MS });
      return r.tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        input_schema: (t.inputSchema ?? {}) as Record<string, unknown>,
      }));
    },
    async callTool(name, args) {
      const r = (await client.callTool(
        { name, arguments: args as Record<string, never> },
        undefined,
        { timeout: MCP_TIMEOUT_MS },
      )) as unknown as { isError?: boolean; content?: unknown };
      const text = textFromContent(r.content);
      if (r.isError === true) {
        return {
          ok: false,
          text,
          message: text === "" ? "对端报 isError 且无文本内容" : text,
        };
      }
      return { ok: true, text };
    },
    async close() {
      if (started) {
        started = false;
        await client.close();
      }
    },
  };
}

// ── 运行时：探测 ────────────────────────────────────────────────────

/**
 * 探测 = 刷新这个插件的能力清单（工具表 + last_probe_json 一起刷）。
 * mcp：走连接器真连一次；失败【也落库】（last_probe_json 记 ok:false + 错因，
 * 招聘页直接展示）——「最近一次探测是什么结果」必须诚实到连失败都在。
 * builtin：本地读模块声明，不联网（探测对内置的全部含义 = 「把模块声明刷进表」，
 * 升级 hub 后内置新工具靠它进授权面）。
 * 网络不进事务（文件头）：mcp 三步 node1/外/ node2；builtin 全程一个 node。
 */
export async function probePlugin(
  w: Writer,
  o: {
    readonly pluginId: string;
    readonly nowMs: number;
    readonly connectorFactory?: ConnectorFactory;
  },
): Promise<PluginProbeOutcome> {
  const factory = o.connectorFactory ?? mcpConnector;
  // node1：读行 + 内置快捷路。
  const head = await w.node(
    async (): Promise<
      { ok: true; row: PluginRow } | { ok: false; e: PluginServiceError }
    > => {
      const db = requireScopeDb("probePlugin");
      const params = [o.pluginId];
      assertSingleStatement(SELECT_PLUGIN_SQL);
      assertParamCount(SELECT_PLUGIN_SQL, params);
      const row = db.prepare(SELECT_PLUGIN_SQL).get(...(params as never[])) as
        | PluginRow
        | undefined;
      if (row === undefined) {
        return {
          ok: false,
          e: err(
            "plugin_not_found",
            "插件 [" + o.pluginId + "] 不存在，无从探测。",
          ),
        };
      }
      return { ok: true, row };
    },
  );
  if (!head.ok) return head.e;
  const row = head.row;

  let probe: PluginProbeResult;
  let tools: PluginToolListing[];
  if (row.kind === "builtin") {
    const mod = getBuiltinPlugin(row.plugin_id);
    if (mod === undefined) {
      // 与 updatePlugin 同判据：模块不在，探测刷不出东西，报服务错误而不是 ok:false 回执。
      return err(
        "plugin_not_found",
        "内置模块 [" + row.plugin_id + "] 不在当前代码里，探测刷不出工具。",
      );
    }
    tools = mod.tools().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
    probe = {
      ok: true,
      tools: tools.map((t) => ({
        plugin_id: row.plugin_id,
        tool_name: t.name,
        description: t.description,
        input_schema_json: t.input_schema,
      })),
      message: "内置模块 " + mod.version + "，声明 " + tools.length + " 个工具",
      probed_at: o.nowMs,
    };
  } else {
    let connector: PluginConnector;
    try {
      connector = await factory(row);
    } catch (e) {
      probe = {
        ok: false,
        tools: [],
        message:
          "连接配置坏了：" + (e instanceof Error ? e.message : String(e)),
        probed_at: o.nowMs,
      };
      tools = [];
      return writeProbe(w, o, probe, row);
    }
    try {
      await connector.start();
      const listed = await connector.listTools();
      tools = listed;
      probe = {
        ok: true,
        tools: listed.map((t) => ({
          plugin_id: row.plugin_id,
          tool_name: t.name,
          description: t.description,
          input_schema_json: t.input_schema,
        })),
        message: "连上了，发现 " + listed.length + " 个工具",
        probed_at: o.nowMs,
      };
    } catch (e) {
      probe = {
        ok: false,
        tools: [],
        message:
          "连不上/拉不到工具：" + (e instanceof Error ? e.message : String(e)),
        probed_at: o.nowMs,
      };
      tools = [];
    } finally {
      try {
        await connector.close();
      } catch {
        // 关不上不影响探测结论；连接泄漏归 OS 回收（一次调用一条连接的策略兜底）。
      }
    }
  }
  return writeProbe(w, o, probe, row);
}

/** node2：落 last_probe_json + 刷 plugin_tools + 审计（mcp/builtin 两路共用）。 */
function writeProbe(
  w: Writer,
  o: { readonly pluginId: string; readonly nowMs: number },
  probe: PluginProbeResult,
  row: PluginRow,
): Promise<PluginProbeOutcome> {
  return w.node(() => {
    const db = requireScopeDb("probePlugin.write");
    const before = mustView(db, o.pluginId);
    runSql(db, UPDATE_PLUGIN_PROBE_SQL, [JSON.stringify(probe), o.pluginId]);
    // 工具表只刷【成功】探测：失败探测不该清空已有清单（连不上 ≠ 没工具）。
    // builtin 路恒成功（本地读声明），等价于「每次探测都刷声明」。
    if (probe.ok) {
      const delParams: unknown[] = [o.pluginId];
      assertSingleStatement(DELETE_PLUGIN_TOOLS_SQL);
      assertParamCount(DELETE_PLUGIN_TOOLS_SQL, delParams);
      db.prepare(DELETE_PLUGIN_TOOLS_SQL).run(...(delParams as never[]));
      for (const t of probe.tools) {
        runSql(db, INSERT_PLUGIN_TOOL_SQL, [
          o.pluginId,
          t.tool_name,
          t.description,
          JSON.stringify(t.input_schema_json),
        ]);
      }
    }
    const after = mustView(db, o.pluginId);
    const auditSeq = appendAudit(
      db,
      {
        taskId: null,
        actorType: PLUGIN_ACTOR.actorType,
        actorId: PLUGIN_ACTOR.actorId,
        action: "state_change",
        target: o.pluginId,
        payload: {
          kind: "plugin_probed" satisfies PluginAuditKind,
          plugin_id: o.pluginId,
          plugin_kind: row.kind,
          probe_ok: probe.ok,
          tool_count: probe.tools.length,
          message: probe.message,
        },
        stateSnapshot: { before, after },
        createdAt: o.nowMs,
      },
      () => o.nowMs,
    );
    return { ok: true, plugin: after, probe, auditSeq };
  });
}

// ── 运行时：执行 ────────────────────────────────────────────────────

/**
 * 入参判据缓存：schemaJson 逐字相同才复用（表行被探测刷新过 ⇒ 字符串变 ⇒ 重建）。
 * 缓存键带 plugin_id+tool_name；无容量上限 —— 工具总量是老板手工登记的量级，
 * 先不抽象（缓存判据文件在 heartbeat/patrol.ts 立过同一立场：量级不到不加淘汰）。
 */
const validatorCache = new Map<string, { schemaJson: string; v: Validator }>();

function argsValidator(
  pluginId: string,
  toolName: string,
  schemaJson: string,
): Validator {
  // 键用 JSON.stringify：plugin_id/tool_name 是任意可见字符串，
  // 任何裸拼接分隔符都有跨界相撞的形状（「a:」+「b」 vs 「a」+「:b」）。
  const key = JSON.stringify([pluginId, toolName]);
  const hit = validatorCache.get(key);
  if (hit !== undefined && hit.schemaJson === schemaJson) return hit.v;
  // input_schema_json 由【我们】写入且写前是 JSON Schema 对象；坏 JSON = 手改库。
  // 这里让 JSON.parse 抛出去：executeTool 的调用面（执行器）把抛翻译成 executor_error，
  // 比把它伪装成「入参非法」诚实 —— 入参没毛病，是库里的授权坏了。
  const v = new Validator(JSON.parse(schemaJson) as never);
  validatorCache.set(key, { schemaJson, v });
  return v;
}

/** 仅测试用：清入参判据缓存（桩模块换 schema 的测试之间不许互相踩）。 */
export function resetArgsValidatorCacheForTests(): void {
  validatorCache.clear();
}

/**
 * 执行一个插件工具（七执行器里 platform-webhook / builtin-plugin 两条腿的地基）。
 * 判据链顺序见文件头；错误码全是 ExecutorFailureCode 子集，执行器可原样透传。
 *
 * 入参口径：args 缺省视为 {}（「没参数」的规范形状）。mcp 路额外要求对象：
 * MCP 协议的 arguments 字段就是对象，schema 判据管不到协议字段形状。
 *
 * 网络不进事务：mcp 路 node1(门①②③④) → 外(连接+调用) → 不写库直接返回。
 * 执行【不写审计】—— 这一层「跑了一轮」的账由执行器链的统一审计点落
 * （executors 侧 harness_call + payload.kind 判别，一次尝试一行）；这里再写
 * 一份就是同一动作两本账，对不上时谁都不知道信谁。
 */
export async function executeTool(
  w: Writer,
  o: {
    readonly pluginId: string;
    readonly tool: string;
    readonly args?: unknown;
    readonly connectorFactory?: ConnectorFactory;
  },
): Promise<ExecuteToolResult> {
  const factory = o.connectorFactory ?? mcpConnector;
  const args = o.args ?? {};
  const head = await w.node(
    async (): Promise<
      | {
          ok: true;
          row: PluginRow;
          toolRow: {
            tool_name: string;
            description: string;
            input_schema_json: string;
          };
        }
      | { ok: false; e: PluginServiceError }
    > => {
      const db = requireScopeDb("executeTool");
      const p1 = [o.pluginId];
      assertSingleStatement(SELECT_PLUGIN_SQL);
      assertParamCount(SELECT_PLUGIN_SQL, p1);
      const row = db.prepare(SELECT_PLUGIN_SQL).get(...(p1 as never[])) as
        | PluginRow
        | undefined;
      if (row === undefined) {
        return {
          ok: false,
          e: err(
            "plugin_not_found",
            "插件 [" +
              o.pluginId +
              "] 不存在（被删了，或执行器配置指向了没有的授权行）。",
          ),
        };
      }
      if (Number(row.enabled) !== 1) {
        return {
          ok: false,
          e: err(
            "plugin_disabled",
            "插件 [" +
              o.pluginId +
              "] 已被停用：老板的止血开关先于一切执行细节。",
          ),
        };
      }
      const p2 = [o.pluginId, o.tool];
      assertSingleStatement(SELECT_PLUGIN_TOOL_SQL);
      assertParamCount(SELECT_PLUGIN_TOOL_SQL, p2);
      const toolRow = db
        .prepare(SELECT_PLUGIN_TOOL_SQL)
        .get(...(p2 as never[])) as
        | { tool_name: string; description: string; input_schema_json: string }
        | undefined;
      if (toolRow === undefined) {
        return {
          ok: false,
          e: err(
            "plugin_tool_not_found",
            "插件 [" +
              o.pluginId +
              "] 的工具 [" +
              o.tool +
              "] 不在授权表里：工具清单以最近一次探测/安装登记为准，先探测再调用。",
          ),
        };
      }
      return { ok: true, row, toolRow };
    },
  );
  if (!head.ok) return head.e;
  const { row, toolRow } = head;

  // 门④ 入参（两 kind 共用，schema 来自 plugin_tools = 落表授权）
  let validator: Validator;
  try {
    validator = argsValidator(
      row.plugin_id,
      toolRow.tool_name,
      toolRow.input_schema_json,
    );
  } catch (e) {
    return err(
      "plugin_tool_invalid_args",
      "工具 [" +
        toolRow.tool_name +
        "] 的授权 schema 读不出来（" +
        (e instanceof Error ? e.message : String(e)) +
        "），无法判收入参 —— 先修复 plugin_tools.input_schema_json。",
    );
  }
  let vr: ValidationResult;
  try {
    vr = validator.validate(args);
  } catch (e) {
    return err(
      "plugin_tool_invalid_args",
      "入参校验本身失败：" + (e instanceof Error ? e.message : String(e)),
    );
  }
  if (!vr.valid) {
    return err(
      "plugin_tool_invalid_args",
      "工具 [" +
        toolRow.tool_name +
        "] 入参不符合登记 schema：" +
        vr.errors.map((er) => er.instanceLocation + " " + er.error).join("；"),
    );
  }

  if (row.kind === "builtin") {
    // 门⑤ 模块在场 + 版本钉（config 坏 JSON ⇒ 抛，文件头「读侧守门」段认领）
    const mod = getBuiltinPlugin(row.plugin_id);
    if (mod === undefined) {
      return err(
        "plugin_not_found",
        "内置模块 [" +
          row.plugin_id +
          "] 不在当前代码里：授权行还在但行为已随 hub 版本移除，执行拒绝。",
      );
    }
    const pin = versionPinProblem(mod, parseConfigOrThrow(row));
    if (pin !== null) return err("plugin_version_mismatch", pin);
    try {
      const r = await mod.run({
        tool: toolRow.tool_name,
        args,
        config: parseConfigOrThrow(row),
      });
      return { ok: true, text: r.text, kind: "builtin" };
    } catch (e) {
      // 模块 run 自己抛 = 「联系上了、它跑了、它报错了」—— 与 transport 分家。
      return err(
        "plugin_tool_error",
        "内置模块 [" +
          row.plugin_id +
          "] 的 " +
          toolRow.tool_name +
          " 执行抛错：" +
          (e instanceof Error ? e.message : String(e)),
      );
    }
  }

  // mcp 路：门⑥ 真调用（事务外，每次一条新连接）
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return err(
      "plugin_tool_invalid_args",
      "MCP 工具的 arguments 必须是对象（协议字段形状），当前是 " +
        (Array.isArray(args) ? "数组" : typeof args) +
        "。",
    );
  }
  let connector: PluginConnector;
  try {
    connector = await factory(row);
  } catch (e) {
    return err(
      "plugin_transport_error",
      "连 MCP [" +
        row.endpoint +
        "] 的连接建不起来：" +
        (e instanceof Error ? e.message : String(e)),
    );
  }
  try {
    await connector.start();
  } catch (e) {
    try {
      await connector.close();
    } catch {
      /* 没连成，关失败无信息量 */
    }
    return err(
      "plugin_transport_error",
      "连不上 MCP [" +
        row.endpoint +
        "]：" +
        (e instanceof Error ? e.message : String(e)),
    );
  }
  try {
    const r = await connector.callTool(toolRow.tool_name, args);
    if (!r.ok) {
      return err(
        "plugin_tool_error",
        "MCP 工具 [" +
          toolRow.tool_name +
          "] 对端报错：" +
          (r.message ?? r.text ?? "无回执文本"),
      );
    }
    return { ok: true, text: r.text, kind: "mcp" };
  } catch (e) {
    return err(
      "plugin_transport_error",
      "调用 MCP 工具 [" +
        toolRow.tool_name +
        "] 时连接断了：" +
        (e instanceof Error ? e.message : String(e)),
    );
  } finally {
    try {
      await connector.close();
    } catch {
      /* 同上：结果已定，关断噪音不掩盖结论 */
    }
  }
}
