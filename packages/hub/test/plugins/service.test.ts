/**
 * 插件服务（T6 之 plugins/service.ts）：授权台账、探测刷新、执行判据链。
 *
 * ⚠ 夹具全部走真 WriteQueue + 真迁移（同 members/service.test.ts 的立场）：
 * 服务函数全部经 requireScopeDb 要求「已在事务里」，手搓假 tx 会让这条结构性消失。
 * mcp 路用注入的桩连接器（不开端口）测完整判据链；文件末尾另有一节【真】MCP
 * 端到端：node:http + SDK 服务端 transport 进程内起服务，走默认 mcpConnector，
 * 把「协议层没接错」钉成证据而不只是桩层的自洽。
 *
 * 本文件同时钉三条跨层对账：
 *  · PLUGIN_AUDIT_KINDS 词表与 0019/审计写点一致（六类各至少出现一次）；
 *  · PLUGIN_KINDS 与 0019 plugins.kind 的 CHECK 词表逐字一致；
 *  · executeTool 不写审计（执行器层的 harness_call 是唯一账本）。
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  type BuiltinPluginModule,
  type InstallPluginRequest,
  PLUGIN_KINDS,
} from "@opc/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import {
  registerBuiltinPlugin,
  resetBuiltinPluginsForTests,
} from "../../src/plugins/registry.js";
import {
  type ConnectorFactory,
  deletePlugin,
  executeTool,
  getPlugin,
  headersFromConfig,
  installPlugin,
  listPlugins,
  PLUGIN_AUDIT_KINDS,
  type PluginCallResult,
  type PluginToolListing,
  pluginServiceStatus,
  probePlugin,
  resetArgsValidatorCacheForTests,
  setPluginEnabled,
  textFromContent,
  updatePlugin,
} from "../../src/plugins/service.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("plugins", import.meta.url);
mkdirSync(TMP, { recursive: true });

type AnyDb = {
  prepare: (sql: string) => {
    all: (...a: unknown[]) => Record<string, unknown>[];
    get: (...a: unknown[]) => Record<string, unknown> | undefined;
    run: (...a: unknown[]) => unknown;
  };
  exec: (sql: string) => void;
};

const NOW = Date.UTC(2026, 10, 23);
const queues: WriteQueue[] = [];
let fileSeq = 0;

async function newQ(): Promise<{ q: WriteQueue; db: AnyDb }> {
  const path = join(TMP, "pl-" + process.pid + "-" + ++fileSeq + ".db");
  const q = new WriteQueue(path) as WriteQueue;
  queues.push(q);
  const db = (
    q as unknown as { writeConnection: () => AnyDb }
  ).writeConnection();
  migrate(db as never);
  return { q, db };
}

afterAll(async () => {
  for (const q of queues) {
    try {
      await (q as unknown as { close?: () => Promise<void> | void }).close?.();
    } catch {
      /* 关掉失败不影响别的 */
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});

interface AuditRowLite {
  id: number | bigint;
  task_id: string | null;
  actor_type: string;
  actor_id: string;
  action: string;
  target: string | null;
  payload: string;
  state_snapshot: string | null;
}

function auditRows(db: AnyDb, target: string): AuditRowLite[] {
  return db
    .prepare(
      "SELECT id, task_id, actor_type, actor_id, action, target, payload, state_snapshot" +
        " FROM events WHERE target = ? ORDER BY id",
    )
    .all(target) as unknown as AuditRowLite[];
}

// ── 内置桩模块（注册表是模块级单例，本文件开头注册一次）────────────
//
// echo 模块的 tools() 读可变状态：探测「升级后新增工具」的路径靠翻转它来测，
// 而不是再造一个模块 —— 同一个 plugin_id 的声明变化才是升级的真实形状。
const echoState = { extraTool: false };

const echoModule: BuiltinPluginModule = {
  plugin_id: "stub.echo",
  name: "回声桩",
  version: "1.2.3",
  tools() {
    const ts: {
      name: string;
      description: string;
      input_schema: Record<string, unknown>;
    }[] = [
      {
        name: "echo",
        description: "回显消息",
        input_schema: {
          type: "object",
          properties: { msg: { type: "string" } },
          required: ["msg"],
        },
      },
      {
        name: "fail",
        description: "执行必抛",
        input_schema: { type: "object" },
      },
    ];
    if (echoState.extraTool) {
      ts.push({
        name: "late",
        description: "升级后新增",
        input_schema: { type: "object" },
      });
    }
    return ts;
  },
  async run(a) {
    if (a.tool === "fail") throw new Error("桩模块故意抛");
    const msg = (a.args as { msg?: unknown }).msg;
    const tag = (a.config as { tag?: unknown }).tag;
    return { text: "echo:" + String(msg) + "|tag:" + String(tag ?? "-") };
  },
};

const pinnedModule: BuiltinPluginModule = {
  plugin_id: "stub.pinned",
  name: "钉版桩",
  version: "2.0.0",
  tools() {
    return [
      {
        name: "noop",
        description: "无操作",
        input_schema: { type: "object" },
      },
    ];
  },
  async run() {
    return { text: "pinned ok" };
  },
};

resetBuiltinPluginsForTests();
registerBuiltinPlugin(echoModule);
registerBuiltinPlugin(pinnedModule);

/** 装一个 mcp 插件（id 可控，断言好写）。 */
let idSeq = 0;
async function installMcp(
  q: WriteQueue,
  endpoint = "http://127.0.0.1:9/mcp",
): Promise<string> {
  const r = await installPlugin(q, {
    req: { kind: "mcp", name: "MCP 桩", endpoint, config: {} },
    nowMs: NOW,
    newId: () => "mcp-" + ++idSeq,
  });
  if (!r.ok) throw new Error("mcp 安装夹具失败：" + r.reason);
  return r.plugin.plugin_id;
}

/** 装一个内置插件（授权已注册模块）。 */
async function installBuiltin(
  q: WriteQueue,
  pluginId = "stub.echo",
  config: Record<string, unknown> = {},
): Promise<string> {
  const r = await installPlugin(q, {
    req: { kind: "builtin", plugin_id: pluginId, config },
    nowMs: NOW,
  });
  if (!r.ok) throw new Error("builtin 安装夹具失败：" + r.reason);
  return r.plugin.plugin_id;
}

/** 库里直接插一行「模块已不在代码里」的 builtin 授权（降级发布/手插行的形状）。 */
function insertGhostBuiltin(db: AnyDb, pluginId = "ghost.mod"): void {
  db.prepare(
    "INSERT INTO plugins (plugin_id, name, kind, endpoint, config_json, enabled, installed_at, last_probe_json)" +
      " VALUES (?, '幽灵', 'builtin', NULL, '{}', 1, ?, NULL)",
  ).run(pluginId, NOW);
}

/** 桩连接器：每个失败位独立可控，调用计数验证 close 纪律。 */
function fakeConnector(o: {
  tools?: PluginToolListing[];
  factoryErr?: Error;
  startErr?: Error;
  listErr?: Error;
  callResult?: PluginCallResult;
  callErr?: Error;
}) {
  const calls = { factory: 0, start: 0, list: 0, call: 0, close: 0 };
  const factory: ConnectorFactory = async () => {
    calls.factory++;
    if (o.factoryErr !== undefined) throw o.factoryErr;
    return {
      async start() {
        calls.start++;
        if (o.startErr !== undefined) throw o.startErr;
      },
      async listTools() {
        calls.list++;
        if (o.listErr !== undefined) throw o.listErr;
        return o.tools ?? [];
      },
      async callTool() {
        calls.call++;
        if (o.callErr !== undefined) throw o.callErr;
        return o.callResult ?? { ok: true, text: "" };
      },
      async close() {
        calls.close++;
      },
    };
  };
  return { factory, calls };
}

const SAY_TOOL: PluginToolListing = {
  name: "say",
  description: "说一句",
  input_schema: { type: "object" },
};

describe("跨层对账", () => {
  it("PLUGIN_KINDS 与 0019 的 kind CHECK 词表逐字一致", () => {
    const sql = readFileSync(
      new URL("../../resources/migrations/0019_plugins.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toContain("CHECK (kind IN ('mcp', 'builtin'))");
    expect(PLUGIN_KINDS.join(", ")).toBe("mcp, builtin");
  });

  it("pluginServiceStatus：404/500/其余 422", () => {
    expect(pluginServiceStatus("plugin_not_found")).toBe(404);
    expect(pluginServiceStatus("not_writable")).toBe(500);
    expect(pluginServiceStatus("plugin_disabled")).toBe(422);
    expect(pluginServiceStatus("builtin_module_not_found")).toBe(422);
    expect(pluginServiceStatus("plugin_version_mismatch")).toBe(422);
  });

  it("PLUGIN_AUDIT_KINDS 六类在下面的写路径里各至少出现一次（词表不养死词）", () => {
    expect([...PLUGIN_AUDIT_KINDS].sort()).toEqual(
      [
        "plugin_deleted",
        "plugin_disabled",
        "plugin_enabled",
        "plugin_installed",
        "plugin_probed",
        "plugin_updated",
      ].sort(),
    );
  });
});

describe("installPlugin", () => {
  it("builtin 指向没注册的模块 ⇒ builtin_module_not_found，理由带当前清单", async () => {
    const { q } = await newQ();
    const r = await installPlugin(q, {
      req: { kind: "builtin", plugin_id: "no.such.mod", config: {} },
      nowMs: NOW,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("builtin_module_not_found");
    expect(r.reason).toContain("no.such.mod");
    // 理由把当前可授权的清单摆出来：报错要能自答「那有什么可装」。
    expect(r.reason).toContain("stub.echo");
    expect(r.reason).toContain("stub.pinned");
  });

  it("builtin 安装期钉版本不符 ⇒ plugin_version_mismatch（不等执行期才炸）", async () => {
    const { q } = await newQ();
    const r = await installPlugin(q, {
      req: {
        kind: "builtin",
        plugin_id: "stub.pinned",
        config: { plugin_version: "1.0.0" },
      },
      nowMs: NOW,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("plugin_version_mismatch");
    expect(r.reason).toContain("1.0.0");
    expect(r.reason).toContain("2.0.0");
  });

  it("钉在当前版本 ⇒ 放行；name 缺省取模块展示名；工具声明刷进 plugin_tools", async () => {
    const { q, db } = await newQ();
    const r = await installPlugin(q, {
      req: {
        kind: "builtin",
        plugin_id: "stub.pinned",
        config: { plugin_version: "2.0.0" },
      },
      nowMs: NOW,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plugin.name).toBe("钉版桩");
    expect(r.auditSeq).toBeGreaterThan(0);
    const cfg = db
      .prepare("SELECT config_json FROM plugins WHERE plugin_id = ?")
      .get("stub.pinned") as { config_json: string };
    expect(JSON.parse(cfg.config_json)).toEqual({ plugin_version: "2.0.0" });
  });

  it("builtin 成功路：视图形状 + 一条 plugin_installed 审计（actor=ceo/human）", async () => {
    const { q, db } = await newQ();
    const r = await installPlugin(q, {
      req: { kind: "builtin", plugin_id: "stub.echo", config: { tag: "T6" } },
      nowMs: NOW,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plugin.kind).toBe("builtin");
    expect(r.plugin.endpoint).toBeNull();
    expect(r.plugin.enabled).toBe(true);
    expect(r.plugin.installed_at).toBe(NOW);
    expect(r.plugin.last_probe_json).toBeNull();
    expect(r.plugin.tools.map((t) => t.tool_name)).toEqual(["echo", "fail"]);
    const rows = auditRows(db, "stub.echo");
    expect(rows.length).toBe(1);
    expect((rows[0] as AuditRowLite).action).toBe("state_change");
    expect((rows[0] as AuditRowLite).actor_type).toBe("human");
    expect((rows[0] as AuditRowLite).actor_id).toBe("ceo");
    const payload = JSON.parse((rows[0] as AuditRowLite).payload) as Record<
      string,
      unknown
    >;
    expect(payload.kind).toBe("plugin_installed");
    expect(payload.plugin_kind).toBe("builtin");
    expect(payload.module_version).toBe("1.2.3");
    expect(payload.tool_count).toBe(2);
    const snap = JSON.parse(
      (rows[0] as AuditRowLite).state_snapshot as string,
    ) as {
      before: unknown;
      after: { plugin_id: string };
    };
    expect(snap.before).toBeNull();
    expect(snap.after.plugin_id).toBe("stub.echo");
  });

  it("builtin 重复安装 ⇒ plugin_already_installed（改配置走 PATCH）", async () => {
    const { q } = await newQ();
    await installBuiltin(q);
    const r = await installPlugin(q, {
      req: { kind: "builtin", plugin_id: "stub.echo", config: {} },
      nowMs: NOW + 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("plugin_already_installed");
    expect(r.reason).toContain("PATCH");
  });

  it("builtin 显式 name ⇒ 覆盖模块展示名（老板的叫法赢）", async () => {
    const { q } = await newQ();
    const r = await installPlugin(q, {
      req: {
        kind: "builtin",
        plugin_id: "stub.echo",
        name: "公司回声",
        config: {},
      },
      nowMs: NOW,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plugin.name).toBe("公司回声");
  });

  it("mcp 成功路：id 由 newId 注入、endpoint 落库、工具表为空（安装不联网）", async () => {
    const { q, db } = await newQ();
    const id = await installMcp(q, "https://mcp.example.com/rpc");
    expect(id).toBe("mcp-1");
    const view = getPlugin(db as never, id);
    expect(view).toBeDefined();
    if (view === undefined) return;
    expect(view.kind).toBe("mcp");
    expect(view.endpoint).toBe("https://mcp.example.com/rpc");
    expect(view.enabled).toBe(true);
    expect(view.tools.length).toBe(0);
    const rows = auditRows(db, id);
    expect(rows.length).toBe(1);
    const payload = JSON.parse((rows[0] as AuditRowLite).payload) as Record<
      string,
      unknown
    >;
    expect(payload.plugin_kind).toBe("mcp");
    expect(payload.endpoint).toBe("https://mcp.example.com/rpc");
    // 安装绝不触碰网络：默认工厂若是 mcpConnector，装 mcp 行时不可能有调用对象可查。
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM plugin_tools").get() as {
        c: number;
      },
    ).toEqual({ c: 0 });
  });

  it("mcp 空白名绕过契约直打服务 ⇒ plugin_name_required（防御性镜像门）", async () => {
    const { q } = await newQ();
    const sneaky = {
      kind: "mcp",
      name: "   ",
      endpoint: "https://mcp.example.com/rpc",
      config: {},
    } as unknown as InstallPluginRequest;
    const r = await installPlugin(q, { req: sneaky, nowMs: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("plugin_name_required");
  });
});

describe("读侧：list / get / 坏 JSON 守门", () => {
  it("列表含工具清单且不 N+1（两插件两工具只读两张表）", async () => {
    const { q, db } = await newQ();
    await installBuiltin(q, "stub.echo");
    await installBuiltin(q, "stub.pinned");
    const views = listPlugins(db as never);
    expect(views.length).toBe(2);
    const echo = views.find((v) => v.plugin_id === "stub.echo");
    expect(echo?.tools.length).toBe(2);
    const pinned = views.find((v) => v.plugin_id === "stub.pinned");
    expect(pinned?.tools.map((t) => t.tool_name)).toEqual(["noop"]);
  });

  it("getPlugin 未知 id ⇒ undefined", async () => {
    const { db } = await newQ();
    expect(getPlugin(db as never, "nope")).toBeUndefined();
  });

  it("last_probe_json 坏了 ⇒ 读侧抛（不是 null，不装没事）", async () => {
    const { q, db } = await newQ();
    const id = await installMcp(q);
    db.prepare(
      "UPDATE plugins SET last_probe_json = '{坏' WHERE plugin_id = ?",
    ).run(id);
    expect(() => getPlugin(db as never, id)).toThrow(/坏了|JSON/);
    expect(() => listPlugins(db as never)).toThrow();
  });

  it("config_json 坏了 ⇒ 执行拒绝且抛（读不懂的配置 = 没配置）", async () => {
    const { q, db } = await newQ();
    await installBuiltin(q);
    db.prepare(
      "UPDATE plugins SET config_json = 'oops' WHERE plugin_id = ?",
    ).run("stub.echo");
    await expect(
      executeTool(q, {
        pluginId: "stub.echo",
        tool: "echo",
        args: { msg: "x" },
      }),
    ).rejects.toThrow(/config_json/);
  });
});

describe("updatePlugin", () => {
  it("行不存在 ⇒ plugin_not_found，什么都没改", async () => {
    const { q } = await newQ();
    const r = await updatePlugin(q, {
      pluginId: "nope",
      req: { name: "改名" },
      nowMs: NOW,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("plugin_not_found");
  });

  it("builtin 改 endpoint ⇒ endpoint_not_allowed", async () => {
    const { q } = await newQ();
    await installBuiltin(q);
    const r = await updatePlugin(q, {
      pluginId: "stub.echo",
      req: { endpoint: "https://x.example.com" },
      nowMs: NOW,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("endpoint_not_allowed");
  });

  it("builtin 改 config 钉坏版本 ⇒ 先过 versionPinProblem，坏值不落库", async () => {
    const { q, db } = await newQ();
    await installBuiltin(q, "stub.pinned", { plugin_version: "2.0.0" });
    const r = await updatePlugin(q, {
      pluginId: "stub.pinned",
      req: { config: { plugin_version: "9.9.9" } },
      nowMs: NOW,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("plugin_version_mismatch");
    const cfg = db
      .prepare("SELECT config_json FROM plugins WHERE plugin_id = ?")
      .get("stub.pinned") as { config_json: string };
    expect(JSON.parse(cfg.config_json)).toEqual({ plugin_version: "2.0.0" });
  });

  it("builtin 行在但模块没了 ⇒ 改 config 拒绝（病因不许被时间线冲淡）", async () => {
    const { q, db } = await newQ();
    insertGhostBuiltin(db);
    const r = await updatePlugin(q, {
      pluginId: "ghost.mod",
      req: { config: { tag: "x" } },
      nowMs: NOW,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("plugin_not_found");
    expect(r.reason).toContain("不在当前代码里");
  });

  it("改 name/config 落一条 plugin_updated，changed=['name/config']，快照前后齐全", async () => {
    const { q, db } = await newQ();
    const id = await installMcp(q);
    const r = await updatePlugin(q, {
      pluginId: id,
      req: { name: "改名后", config: { tag: "v2" } },
      nowMs: NOW + 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plugin.name).toBe("改名后");
    const rows = auditRows(db, id);
    expect(rows.length).toBe(2);
    const payload = JSON.parse((rows[1] as AuditRowLite).payload) as Record<
      string,
      unknown
    >;
    expect(payload.kind).toBe("plugin_updated");
    expect(payload.changed).toEqual(["name/config"]);
    const snap = JSON.parse(
      (rows[1] as AuditRowLite).state_snapshot as string,
    ) as {
      before: { name: string };
      after: { name: string };
    };
    expect(snap.before.name).toBe("MCP 桩");
    expect(snap.after.name).toBe("改名后");
  });

  it("同值 PATCH ⇒ auditSeq=0 且零新审计行（授权没变 = 没发生事）", async () => {
    const { q, db } = await newQ();
    const id = await installMcp(q);
    const before = auditRows(db, id).length;
    const r = await updatePlugin(q, {
      pluginId: id,
      req: {
        name: "MCP 桩",
        endpoint: "http://127.0.0.1:9/mcp",
        enabled: true,
      },
      nowMs: NOW + 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.auditSeq).toBe(0);
    expect(auditRows(db, id).length).toBe(before);
  });

  it("mcp 改 endpoint 与 enabled 在同一次 PATCH：changed 记两格", async () => {
    const { q, db } = await newQ();
    const id = await installMcp(q);
    const r = await updatePlugin(q, {
      pluginId: id,
      req: { endpoint: "https://new.example.com", enabled: false },
      nowMs: NOW + 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plugin.endpoint).toBe("https://new.example.com");
    expect(r.plugin.enabled).toBe(false);
    const rows = auditRows(db, id);
    const payload = JSON.parse((rows[1] as AuditRowLite).payload) as {
      changed: string[];
    };
    expect(payload.changed).toEqual(["endpoint", "enabled"]);
  });
});

describe("setPluginEnabled / deletePlugin", () => {
  it("停用记 plugin_disabled、启用记 plugin_enabled，同值切回 auditSeq=0", async () => {
    const { q, db } = await newQ();
    const id = await installMcp(q);
    const off = await setPluginEnabled(q, {
      pluginId: id,
      enabled: false,
      nowMs: NOW + 1,
    });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.plugin.enabled).toBe(false);
    const on = await setPluginEnabled(q, {
      pluginId: id,
      enabled: true,
      nowMs: NOW + 2,
    });
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    expect(on.plugin.enabled).toBe(true);
    const noop = await setPluginEnabled(q, {
      pluginId: id,
      enabled: true,
      nowMs: NOW + 3,
    });
    expect(noop.ok).toBe(true);
    if (!noop.ok) return;
    expect(noop.auditSeq).toBe(0);
    const kinds = auditRows(db, id).map(
      (r) => (JSON.parse(r.payload) as { kind: string }).kind,
    );
    expect(kinds).toEqual([
      "plugin_installed",
      "plugin_disabled",
      "plugin_enabled",
    ]);
  });

  it("对不存在的插件开/关 ⇒ plugin_not_found", async () => {
    const { q } = await newQ();
    const r = await setPluginEnabled(q, {
      pluginId: "nope",
      enabled: false,
      nowMs: NOW,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("plugin_not_found");
  });

  it("删除：行与工具子行同灭，审计 after=null，第二次删 ⇒ 404", async () => {
    const { q, db } = await newQ();
    await installBuiltin(q);
    const r = await deletePlugin(q, { pluginId: "stub.echo", nowMs: NOW + 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plugin.plugin_id).toBe("stub.echo");
    expect(getPlugin(db as never, "stub.echo")).toBeUndefined();
    expect(
      db
        .prepare("SELECT tool_name FROM plugin_tools WHERE plugin_id = ?")
        .all("stub.echo"),
    ).toEqual([]);
    const rows = auditRows(db, "stub.echo");
    expect(rows.length).toBe(2);
    const payload = JSON.parse((rows[1] as AuditRowLite).payload) as Record<
      string,
      unknown
    >;
    expect(payload.kind).toBe("plugin_deleted");
    expect(payload.plugin_kind).toBe("builtin");
    const snap = JSON.parse(
      (rows[1] as AuditRowLite).state_snapshot as string,
    ) as {
      before: unknown;
      after: unknown;
    };
    expect(snap.before).not.toBeNull();
    expect(snap.after).toBeNull();
    const again = await deletePlugin(q, {
      pluginId: "stub.echo",
      nowMs: NOW + 2,
    });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.code).toBe("plugin_not_found");
  });
});

describe("probePlugin", () => {
  it("行不存在 ⇒ plugin_not_found（没有东西可落账才是服务错误）", async () => {
    const { q } = await newQ();
    const r = await probePlugin(q, { pluginId: "nope", nowMs: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("plugin_not_found");
  });

  it("builtin 恒成功：声明刷进表，升级新增的工具靠探测进授权面", async () => {
    const { q, db } = await newQ();
    await installBuiltin(q);
    expect(echoState.extraTool).toBe(false);
    echoState.extraTool = true;
    try {
      const r = await probePlugin(q, { pluginId: "stub.echo", nowMs: NOW + 1 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.probe.ok).toBe(true);
      expect(r.probe.message).toContain("内置模块 1.2.3");
      expect(r.plugin.tools.map((t) => t.tool_name)).toEqual([
        "echo",
        "fail",
        "late",
      ]);
      const rows = auditRows(db, "stub.echo");
      const payload = JSON.parse((rows[1] as AuditRowLite).payload) as Record<
        string,
        unknown
      >;
      expect(payload.kind).toBe("plugin_probed");
      expect(payload.probe_ok).toBe(true);
      expect(payload.tool_count).toBe(3);
      // last_probe_json 落库（插件管理页直接读它，不再现探）。
      expect(r.plugin.last_probe_json).not.toBeNull();
    } finally {
      echoState.extraTool = false;
    }
  });

  it("builtin 模块已不在代码里 ⇒ 服务错误而不是 ok:false 回执（且一行库都不碰）", async () => {
    const { q, db } = await newQ();
    insertGhostBuiltin(db);
    const r = await probePlugin(q, { pluginId: "ghost.mod", nowMs: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("plugin_not_found");
    expect(auditRows(db, "ghost.mod").length).toBe(0);
  });

  it("mcp 探测成功：工具表整刷（旧清单不残留）+ last_probe_json + 审计", async () => {
    const { q, db } = await newQ();
    const id = await installMcp(q);
    // 先手种一条旧工具，验证成功探测是先清后刷。
    db.prepare(
      "INSERT INTO plugin_tools (plugin_id, tool_name, description, input_schema_json) VALUES (?, 'stale', '旧货', '{}')",
    ).run(id);
    const fake = fakeConnector({ tools: [SAY_TOOL] });
    const r = await probePlugin(q, {
      pluginId: id,
      nowMs: NOW + 1,
      connectorFactory: fake.factory,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.probe.ok).toBe(true);
    expect(r.probe.message).toContain("1 个工具");
    expect(r.plugin.tools.map((t) => t.tool_name)).toEqual(["say"]);
    expect(fake.calls).toEqual({
      factory: 1,
      start: 1,
      list: 1,
      call: 0,
      close: 1,
    });
    const rows = auditRows(db, id);
    const payload = JSON.parse((rows[1] as AuditRowLite).payload) as Record<
      string,
      unknown
    >;
    expect(payload.kind).toBe("plugin_probed");
    expect(payload.probe_ok).toBe(true);
    expect(payload.tool_count).toBe(1);
  });

  it("mcp 连不上：失败回执照常落库、工具表不动、审计记 probe_ok=false", async () => {
    const { q, db } = await newQ();
    const id = await installMcp(q);
    const seed = fakeConnector({ tools: [SAY_TOOL] });
    await probePlugin(q, {
      pluginId: id,
      nowMs: NOW + 1,
      connectorFactory: seed.factory,
    });
    const bad = fakeConnector({ startErr: new Error("ECONNREFUSED") });
    const r = await probePlugin(q, {
      pluginId: id,
      nowMs: NOW + 2,
      connectorFactory: bad.factory,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.probe.ok).toBe(false);
    expect(r.probe.message).toContain("ECONNREFUSED");
    // 连不上 ≠ 没工具：清单保持上次成功探测的结果。
    expect(r.plugin.tools.map((t) => t.tool_name)).toEqual(["say"]);
    expect(r.plugin.last_probe_json?.message).toContain("ECONNREFUSED");
    expect(bad.calls.close).toBe(1);
    const rows = auditRows(db, id);
    const payload = JSON.parse((rows[2] as AuditRowLite).payload) as Record<
      string,
      unknown
    >;
    expect(payload.probe_ok).toBe(false);
  });

  it("mcp 拉列表半途炸 ⇒ 同失败路（start 成功也要 close）", async () => {
    const { q } = await newQ();
    const id = await installMcp(q);
    const fake = fakeConnector({ listErr: new Error("协议错乱") });
    const r = await probePlugin(q, {
      pluginId: id,
      nowMs: NOW,
      connectorFactory: fake.factory,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.probe.ok).toBe(false);
    expect(r.probe.message).toContain("协议错乱");
    expect(fake.calls).toEqual({
      factory: 1,
      start: 1,
      list: 1,
      call: 0,
      close: 1,
    });
  });

  it("连接配置坏了（factory 抛）⇒ 回执 message 说人话", async () => {
    const { q } = await newQ();
    const id = await installMcp(q);
    const fake = fakeConnector({
      factoryErr: new Error("config.headers 必须是字符串→字符串的对象"),
    });
    const r = await probePlugin(q, {
      pluginId: id,
      nowMs: NOW,
      connectorFactory: fake.factory,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.probe.ok).toBe(false);
    expect(r.probe.message).toContain("连接配置坏了");
  });

  it("默认工厂 + 坏 endpoint：真 mcpConnector 在 URL 解析处抛 ⇒ 归入连接配置坏了", async () => {
    const { q } = await newQ();
    const id = await installMcp(q, "不是个URL");
    const r = await probePlugin(q, { pluginId: id, nowMs: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.probe.ok).toBe(false);
    expect(r.probe.message).toContain("连接配置坏了");
  });
});

describe("executeTool：判据链", () => {
  it("门① 插件不在 ⇒ plugin_not_found", async () => {
    const { q } = await newQ();
    const r = await executeTool(q, { pluginId: "nope", tool: "x" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("plugin_not_found");
  });

  it("门② 停用 ⇒ plugin_disabled（止血开关先于一切执行细节）", async () => {
    const { q } = await newQ();
    await installBuiltin(q);
    await setPluginEnabled(q, {
      pluginId: "stub.echo",
      enabled: false,
      nowMs: NOW + 1,
    });
    const r = await executeTool(q, {
      pluginId: "stub.echo",
      tool: "echo",
      args: { msg: "x" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("plugin_disabled");
  });

  it("门③ 工具没登记 ⇒ plugin_tool_not_found，理由教人先探测", async () => {
    const { q } = await newQ();
    const id = await installMcp(q);
    const r = await executeTool(q, { pluginId: id, tool: "没登记的" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("plugin_tool_not_found");
    expect(r.reason).toContain("先探测再调用");
  });

  it("门④ 入参不合登记 schema ⇒ plugin_tool_invalid_args 带定位", async () => {
    const { q } = await newQ();
    await installBuiltin(q);
    const r = await executeTool(q, {
      pluginId: "stub.echo",
      tool: "echo",
      args: { msg: 42 },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("plugin_tool_invalid_args");
    expect(r.reason).toContain("echo");
  });

  it("门④ 库里 schema 坏了 ⇒ invalid_args 但理由指向授权本身（不冤枉入参）", async () => {
    const { q, db } = await newQ();
    await installBuiltin(q);
    db.prepare(
      "UPDATE plugin_tools SET input_schema_json = '坏JSON' WHERE plugin_id = ? AND tool_name = 'echo'",
    ).run("stub.echo");
    resetArgsValidatorCacheForTests();
    const r = await executeTool(q, {
      pluginId: "stub.echo",
      tool: "echo",
      args: { msg: "x" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("plugin_tool_invalid_args");
    expect(r.reason).toContain("input_schema_json");
  });

  it("入参判据缓存按 schemaJson 重建：表行刷新后旧判据不作祟", async () => {
    const { q, db } = await newQ();
    const id = await installMcp(q);
    const fake = fakeConnector({
      tools: [
        {
          name: "num",
          description: "要数字",
          input_schema: {
            type: "object",
            properties: { n: { type: "number" } },
            required: ["n"],
          },
        },
      ],
      callResult: { ok: true, text: "过了" },
    });
    await probePlugin(q, {
      pluginId: id,
      nowMs: NOW,
      connectorFactory: fake.factory,
    });
    const strict = await executeTool(q, {
      pluginId: id,
      tool: "num",
      args: { n: "非数字" },
      connectorFactory: fake.factory,
    });
    expect(strict.ok).toBe(false);
    if (strict.ok) return;
    expect(strict.code).toBe("plugin_tool_invalid_args");
    // 模拟再次探测把登记放宽（schema 字符串变 ⇒ 缓存必须重建）。
    db.prepare(
      "UPDATE plugin_tools SET input_schema_json = '{\"type\":\"object\"}' WHERE plugin_id = ? AND tool_name = 'num'",
    ).run(id);
    const loose = await executeTool(q, {
      pluginId: id,
      tool: "num",
      args: { n: "非数字" },
      connectorFactory: fake.factory,
    });
    expect(loose.ok).toBe(true);
    if (!loose.ok) return;
    expect(loose.text).toBe("过了");
  });

  it("builtin 成功路：args/config 原样进模块，回执文本原样出", async () => {
    const { q, db } = await newQ();
    await installBuiltin(q, "stub.echo", { tag: "T6" });
    const before = auditRows(db, "stub.echo").length;
    const r = await executeTool(q, {
      pluginId: "stub.echo",
      tool: "echo",
      args: { msg: "你好" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe("echo:你好|tag:T6");
    expect(r.kind).toBe("builtin");
    // 执行不写审计：这一层的账由执行器链 harness_call 单点落。
    expect(auditRows(db, "stub.echo").length).toBe(before);
  });

  it("builtin 模块 run 抛 ⇒ plugin_tool_error（与 transport 分家）", async () => {
    const { q } = await newQ();
    await installBuiltin(q);
    const r = await executeTool(q, { pluginId: "stub.echo", tool: "fail" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("plugin_tool_error");
    expect(r.reason).toContain("桩模块故意抛");
  });

  it("builtin 模块已不在代码里 ⇒ plugin_not_found（授权行还在但行为已移除）", async () => {
    const { q, db } = await newQ();
    insertGhostBuiltin(db);
    db.prepare(
      "INSERT INTO plugin_tools (plugin_id, tool_name, description, input_schema_json) VALUES ('ghost.mod', 'x', '', '{}')",
    ).run();
    const r = await executeTool(q, { pluginId: "ghost.mod", tool: "x" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("plugin_not_found");
  });

  it("builtin 执行期版本钉不符 ⇒ plugin_version_mismatch（不拿新代码跑旧授权）", async () => {
    const { q, db } = await newQ();
    await installBuiltin(q, "stub.pinned", { plugin_version: "2.0.0" });
    // 手改库模拟「授权停留在旧版本」的状态（老板界面钉旧值后代码升级的镜像）。
    db.prepare(
      "UPDATE plugins SET config_json = '{\"plugin_version\":\"1.0.0\"}' WHERE plugin_id = 'stub.pinned'",
    ).run();
    const r = await executeTool(q, { pluginId: "stub.pinned", tool: "noop" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("plugin_version_mismatch");
  });

  it("mcp 入参非对象 ⇒ invalid_args（协议字段形状，schema 管不到这格）", async () => {
    const { q, db } = await newQ();
    const id = await installMcp(q);
    // 登记一条【不加 type 约束】的 schema：这样门④ 放行、门⑥ 的形状判据才是拦下它的那一个。
    db.prepare(
      "INSERT INTO plugin_tools (plugin_id, tool_name, description, input_schema_json) VALUES (?, 'any', '形状不限', '{}')",
    ).run(id);
    const fake = fakeConnector({
      callResult: { ok: true, text: "不该被调用" },
    });
    const r = await executeTool(q, {
      pluginId: id,
      tool: "any",
      args: "我是字符串",
      connectorFactory: fake.factory,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("plugin_tool_invalid_args");
    expect(r.reason).toContain("必须是对象");
    // 拦在连接之前：形状不对不值得开一条连接。
    expect(fake.calls.factory).toBe(0);
  });

  it("mcp 入参数组被拦；null/缺省归一为 {} 可跑（入参口径钉死）", async () => {
    const { q, db } = await newQ();
    const id = await installMcp(q);
    db.prepare(
      "INSERT INTO plugin_tools (plugin_id, tool_name, description, input_schema_json) VALUES (?, 'any', '形状不限', '{}')",
    ).run(id);
    const fake = fakeConnector({ callResult: { ok: true, text: "过了" } });
    // 数组过不了协议形状门，且理由要说「数组」（typeof 会说谎成 object）。
    const arr = await executeTool(q, {
      pluginId: id,
      tool: "any",
      args: [1, 2],
      connectorFactory: fake.factory,
    });
    expect(arr.ok).toBe(false);
    if (arr.ok) return;
    expect(arr.code).toBe("plugin_tool_invalid_args");
    expect(arr.reason).toContain("数组");
    expect(fake.calls.factory).toBe(0);
    // null 与缺省同义（服务入口 ?? 归一）：到工具那一格已经是 {}。
    for (const okArgs of [undefined, null]) {
      const r = await executeTool(q, {
        pluginId: id,
        tool: "any",
        args: okArgs,
        connectorFactory: fake.factory,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.text).toBe("过了");
    }
    expect(fake.calls.factory).toBe(2);
  });

  it("mcp factory 抛 ⇒ plugin_transport_error（连接建不起来）", async () => {
    const { q } = await newQ();
    const id = await installMcp(q);
    const fake = fakeConnector({ tools: [SAY_TOOL] });
    await probePlugin(q, {
      pluginId: id,
      nowMs: NOW,
      connectorFactory: fake.factory,
    });
    const bad = fakeConnector({ factoryErr: new Error("配置坏了") });
    const r = await executeTool(q, {
      pluginId: id,
      tool: "say",
      args: {},
      connectorFactory: bad.factory,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("plugin_transport_error");
    expect(r.reason).toContain("建不起来");
  });

  it("mcp start 抛 ⇒ transport_error 且 close 仍被调（没有半开连接）", async () => {
    const { q } = await newQ();
    const id = await installMcp(q);
    const fake = fakeConnector({ tools: [SAY_TOOL] });
    await probePlugin(q, {
      pluginId: id,
      nowMs: NOW,
      connectorFactory: fake.factory,
    });
    const bad = fakeConnector({ startErr: new Error("ECONNREFUSED") });
    const r = await executeTool(q, {
      pluginId: id,
      tool: "say",
      args: {},
      connectorFactory: bad.factory,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("plugin_transport_error");
    expect(bad.calls.close).toBe(1);
  });

  it("mcp callTool 抛 ⇒ transport_error，finally close 兜底", async () => {
    const { q } = await newQ();
    const id = await installMcp(q);
    const fake = fakeConnector({
      tools: [SAY_TOOL],
      callErr: new Error("socket hang up"),
    });
    await probePlugin(q, {
      pluginId: id,
      nowMs: NOW,
      connectorFactory: fake.factory,
    });
    const r = await executeTool(q, {
      pluginId: id,
      tool: "say",
      args: {},
      connectorFactory: fake.factory,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("plugin_transport_error");
    expect(r.reason).toContain("socket hang up");
    expect(fake.calls.close).toBe(2);
  });

  it("mcp 对端 isError ⇒ plugin_tool_error（联系上了、它报错了）", async () => {
    const { q } = await newQ();
    const id = await installMcp(q);
    const fake = fakeConnector({
      tools: [SAY_TOOL],
      callResult: { ok: false, text: "对端坏了", message: "对端坏了" },
    });
    await probePlugin(q, {
      pluginId: id,
      nowMs: NOW,
      connectorFactory: fake.factory,
    });
    const r = await executeTool(q, {
      pluginId: id,
      tool: "say",
      args: {},
      connectorFactory: fake.factory,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("plugin_tool_error");
    expect(r.reason).toContain("对端坏了");
  });

  it("mcp 成功路：文本原样出、kind=mcp、每条调用一条连接且关净", async () => {
    const { q, db } = await newQ();
    const id = await installMcp(q);
    const fake = fakeConnector({
      tools: [SAY_TOOL],
      callResult: { ok: true, text: "外部说：hi" },
    });
    await probePlugin(q, {
      pluginId: id,
      nowMs: NOW,
      connectorFactory: fake.factory,
    });
    const before = auditRows(db, id).length;
    const r = await executeTool(q, {
      pluginId: id,
      tool: "say",
      args: {},
      connectorFactory: fake.factory,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe("外部说：hi");
    expect(r.kind).toBe("mcp");
    expect(fake.calls.factory).toBe(2);
    expect(fake.calls.start).toBe(2);
    expect(fake.calls.close).toBe(2);
    // 执行不写审计（与 builtin 路同一本账纪律）。
    expect(auditRows(db, id).length).toBe(before);
  });

  it("args 缺省 = {}：schema 只要 object 的 builtin 工具免传参数可跑", async () => {
    const { q } = await newQ();
    await installBuiltin(q, "stub.pinned");
    const r = await executeTool(q, { pluginId: "stub.pinned", tool: "noop" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe("pinned ok");
  });
});

describe("连接器助手", () => {
  it("headersFromConfig：空配置零头；headers 原样搬；bearer 变 Authorization", () => {
    expect(headersFromConfig({})).toEqual({});
    expect(headersFromConfig({ headers: { "X-Key": "abc" } })).toEqual({
      "X-Key": "abc",
    });
    expect(headersFromConfig({ bearer_token: "tok" })).toEqual({
      Authorization: "Bearer tok",
    });
  });

  it("headersFromConfig：bearer 覆盖 headers 里的同名 Authorization（专用键赢）", () => {
    expect(
      headersFromConfig({
        headers: { Authorization: "Bearer 旧的" },
        bearer_token: "新的",
      }),
    ).toEqual({ Authorization: "Bearer 新的" });
  });

  it("headersFromConfig：三个坏形状各抛各的（不是字符串就拒，不猜）", () => {
    expect(() => headersFromConfig({ headers: "x" })).toThrow(/headers/);
    expect(() => headersFromConfig({ headers: { a: 1 } })).toThrow(/a/);
    expect(() => headersFromConfig({ bearer_token: "  " })).toThrow(
      /bearer_token/,
    );
  });

  it("textFromContent：text 块拼接；非文本回执 JSON 原样带出不编话", () => {
    expect(
      textFromContent([
        { type: "text", text: "第一行" },
        { type: "image", data: "…" },
        { type: "text", text: "第二行" },
      ]),
    ).toBe("第一行\n第二行");
    expect(textFromContent([{ type: "image", data: "x" }])).toContain(
      '"image"',
    );
    expect(textFromContent(undefined)).toBe("");
    expect(textFromContent("标量")).toBe('"标量"');
  });
});

// ── 真 MCP 端到端（node:http + SDK 服务端 transport，进程内）────────
//
// 桩连接器证明了判据链的【形状】，这一节证明【协议接对了】：
// 默认 mcpConnector ↔ 真 StreamableHTTPServerTransport 走完整
// initialize → tools/list → tools/call 握手。SDK 只在这节内动态 import，
// 其余测试不背它的加载成本（与 mcpConnector 的加载策略同构）。
describe("真 MCP 端到端", () => {
  async function startMcpServer(): Promise<{
    url: string;
    close: () => Promise<void>;
  }> {
    const { Server } = (await import(
      "@modelcontextprotocol/sdk/server/index.js"
    )) as unknown as {
      Server: new (
        a: Record<string, unknown>,
        b: Record<string, unknown>,
      ) => {
        setRequestHandler: (
          s: unknown,
          h: (req: never) => Promise<unknown>,
        ) => void;
        connect: (t: unknown) => Promise<void>;
      };
    };
    const { StreamableHTTPServerTransport } = (await import(
      "@modelcontextprotocol/sdk/server/streamableHttp.js"
    )) as unknown as {
      StreamableHTTPServerTransport: new (
        o: Record<string, unknown>,
      ) => {
        handleRequest: (req: unknown, res: unknown) => Promise<void>;
      };
    };
    const types = (await import(
      "@modelcontextprotocol/sdk/types.js"
    )) as unknown as {
      ListToolsRequestSchema: unknown;
      CallToolRequestSchema: unknown;
    };
    const srv = createServer((req, res) => {
      void (async () => {
        const server = new Server(
          { name: "e2e-mcp", version: "1.0.0" },
          { capabilities: { tools: {} } },
        );
        server.setRequestHandler(types.ListToolsRequestSchema, async () => ({
          tools: [
            {
              name: "say",
              description: "说一句话",
              inputSchema: {
                type: "object",
                properties: { what: { type: "string" } },
                required: ["what"],
              },
            },
            {
              name: "boom",
              description: "永远 isError",
              inputSchema: { type: "object" },
            },
          ],
        }));
        server.setRequestHandler(types.CallToolRequestSchema, async (raw) => {
          const r = raw as unknown as {
            params: { name: string; arguments?: Record<string, unknown> };
          };
          if (r.params.name === "say") {
            return {
              content: [
                {
                  type: "text",
                  text: "说了：" + String(r.params.arguments?.["what"]),
                },
              ],
            };
          }
          return {
            isError: true,
            content: [{ type: "text", text: "对端坏了" }],
          };
        });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        await server.connect(transport);
        await transport.handleRequest(req, res);
      })().catch(() => {
        if (!res.writableEnded) {
          res.statusCode = 500;
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const addr = srv.address() as AddressInfo;
    return {
      url: "http://127.0.0.1:" + addr.port + "/mcp",
      close: async () => {
        srv.closeAllConnections();
        await new Promise<void>((resolve) => srv.close(() => resolve()));
      },
    };
  }

  it("真握手：探测发现工具 → 入参门 → 真调用出文本 → isError 归 tool_error", async () => {
    const { q, db } = await newQ();
    const srv = await startMcpServer();
    try {
      const id = await installMcp(q, srv.url);
      const pr = await probePlugin(q, { pluginId: id, nowMs: NOW });
      expect(pr.ok).toBe(true);
      if (!pr.ok) return;
      expect(pr.probe.ok).toBe(true);
      expect(pr.plugin.tools.map((t) => t.tool_name)).toEqual(["boom", "say"]);

      const bad = await executeTool(q, {
        pluginId: id,
        tool: "say",
        args: { what: 99 },
      });
      expect(bad.ok).toBe(false);
      if (bad.ok) return;
      expect(bad.code).toBe("plugin_tool_invalid_args");

      const ok = await executeTool(q, {
        pluginId: id,
        tool: "say",
        args: { what: "端到端" },
      });
      expect(ok.ok).toBe(true);
      if (!ok.ok) return;
      expect(ok.text).toBe("说了：端到端");
      expect(ok.kind).toBe("mcp");

      const err = await executeTool(q, {
        pluginId: id,
        tool: "boom",
        args: {},
      });
      expect(err.ok).toBe(false);
      if (err.ok) return;
      expect(err.code).toBe("plugin_tool_error");
      expect(err.reason).toContain("对端坏了");

      // 真探测的账也照常落：last_probe_json + plugin_probed。
      const rows = auditRows(db, id);
      const payload = JSON.parse((rows[1] as AuditRowLite).payload) as Record<
        string,
        unknown
      >;
      expect(payload.kind).toBe("plugin_probed");
      expect(payload.probe_ok).toBe(true);
    } finally {
      await srv.close();
    }
  }, 30_000);
});
