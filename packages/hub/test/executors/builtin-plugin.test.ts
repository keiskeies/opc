/**
 * builtin-plugin 执行器（T6）的行为判据。
 *
 * ⚠ 夹具走真 WriteQueue + 真迁移（同 plugins/service.test.ts 的立场）：
 * 执行链全程 writer.node → requireScopeDb，手搓假 tx 会让这条结构性消失。
 *
 * 本文件钉执行器自己的三件事（判据链本体在 plugins/service.test.ts 逐门钉过）：
 *  ① 工具选择的读点是 plugin_tools 表（= 授权面）：显式 tool_name 优先，缺省才按
 *     tool_name 字典序取第一个 —— 桩模块刻意按【逆字典序】声明工具，选中「排在
 *     后面的先声明」的那个才证明排序来自 SQL 的 ORDER BY 而不是插入顺序；
 *     显式指定未授权工具必须拒绝，不能回退到字典序第一个；
 *  ② 0 工具 = plugin_tool_not_found + retry true（retry 判「换下一格有没有意义」，
 *     不判「这个配置能不能修」—— 见执行器文件头注释）；
 *  ③ 一次尝试恰好一行 executor_run。
 *
 * builtin 安装会种工具（installPlugin 的 builtin 分支 seedTools），所以授权行走
 * 真安装路径而不是手插 —— 这正是「表即授权」的登记来源。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { BuiltinPluginModule, ExecutorRunRequest } from "@opc/contracts";
import { executorConfigSchema, executorRunRequestSchema } from "@opc/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { BuiltinPluginExecutor } from "../../src/executors/builtin-plugin.js";
import {
  registerBuiltinPlugin,
  resetBuiltinPluginsForTests,
} from "../../src/plugins/registry.js";
import { installPlugin } from "../../src/plugins/service.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("executors-builtin", import.meta.url);
mkdirSync(TMP, { recursive: true });

type AnyDb = {
  prepare: (sql: string) => {
    all: (...a: unknown[]) => Record<string, unknown>[];
    get: (...a: unknown[]) => Record<string, unknown> | undefined;
    run: (...a: unknown[]) => unknown;
  };
  exec: (sql: string) => void;
};

const NOW = Date.UTC(2026, 10, 24);
const queues: WriteQueue[] = [];
let fileSeq = 0;

async function newQ(): Promise<{ q: WriteQueue; db: AnyDb }> {
  const path = join(TMP, "bi-" + process.pid + "-" + ++fileSeq + ".db");
  const q = new WriteQueue(path) as WriteQueue;
  queues.push(q);
  const db = (
    q as unknown as { writeConnection: () => AnyDb }
  ).writeConnection();
  migrate(db as never);
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at)" +
      " VALUES ('t1', '任务', 'IN_PROGRESS', 'dev', 'implement', ?, ?)",
  ).run(NOW, NOW);
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

function auditRows(db: AnyDb, target: string): Record<string, unknown>[] {
  return db
    .prepare(
      "SELECT id, action, target, payload FROM events WHERE target = ? ORDER BY id",
    )
    .all(target) as unknown as Record<string, unknown>[];
}

// ── 桩模块（注册表是模块级单例，本文件开头注册一次）────────────────
// 工具按【逆字典序】声明（zeta 在 alpha 前）：执行器若按插入顺序取第一个会选中
// zeta，按 ORDER BY tool_name 才选中 alpha —— 声明顺序就是这条判据的对照组。
const twoToolModule: BuiltinPluginModule = {
  plugin_id: "stub.two",
  name: "双工具桩",
  version: "1.0.0",
  tools() {
    return [
      {
        name: "zeta",
        description: "后字典序",
        input_schema: { type: "object" },
      },
      {
        name: "alpha",
        description: "先字典序",
        input_schema: { type: "object" },
      },
    ];
  },
  async run(a) {
    return { text: "ran:" + a.tool };
  },
};

// 空工具集桩：装得上（seedTools 种零行），执行期撞「0 工具 = 配置指向没有工具集的插件」。
const noToolModule: BuiltinPluginModule = {
  plugin_id: "stub.none",
  name: "空工具桩",
  version: "1.0.0",
  tools() {
    return [];
  },
  async run() {
    return { text: "不该被调到" };
  },
};

resetBuiltinPluginsForTests();
registerBuiltinPlugin(twoToolModule);
registerBuiltinPlugin(noToolModule);

async function installBuiltin(q: WriteQueue, pluginId: string): Promise<void> {
  const r = await installPlugin(q, {
    req: { kind: "builtin", plugin_id: pluginId, config: {} },
    nowMs: NOW,
  });
  if (!r.ok) throw new Error("builtin 安装夹具失败：" + r.reason);
}

function req(over: {
  execution_id: string;
  plugin_id: string;
  tool_name?: string;
  seq?: number;
}): ExecutorRunRequest {
  return executorRunRequestSchema.parse({
    execution_id: over.execution_id,
    task_id: "t1",
    member_id: "m1",
    role_id: "dev",
    seq: over.seq ?? 1,
    kind: "builtin-plugin",
    config: {
      kind: "builtin-plugin",
      plugin_id: over.plugin_id,
      ...(over.tool_name === undefined ? {} : { tool_name: over.tool_name }),
    },
    model_tier: "execution",
    instruction: "跑一下桩",
  });
}

describe("BuiltinPluginExecutor", () => {
  it("契约：tool_name 可选且限 1..200，plugin_id 仍必填", () => {
    const base = { kind: "builtin-plugin", plugin_id: "stub.two" };
    expect(executorConfigSchema.parse(base)).toEqual(base);
    expect(executorConfigSchema.parse({ ...base, tool_name: "zeta" })).toEqual({
      ...base,
      tool_name: "zeta",
    });
    for (const tool_name of ["", "x".repeat(201)]) {
      expect(
        executorConfigSchema.safeParse({ ...base, tool_name }).success,
      ).toBe(false);
    }
    expect(
      executorConfigSchema.safeParse({ kind: "builtin-plugin" }).success,
    ).toBe(false);
  });

  it("两个工具：显式选择第二个 zeta，结果与消息写明实际工具", async () => {
    const { q, db } = await newQ();
    await installBuiltin(q, "stub.two");
    const ex = new BuiltinPluginExecutor({ writer: q });
    const r = await ex.run(
      req({
        execution_id: "e-bi-explicit",
        plugin_id: "stub.two",
        tool_name: "zeta",
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("期望 done 回执");
    expect(r.text).toBe("ran:zeta");
    expect(r.summary).toBe("内置插件 [stub.two] 工具 [zeta]：ran:zeta");
    expect(r.harness_result).toEqual({
      plugin_id: "stub.two",
      tool_name: "zeta",
      plugin_kind: "builtin",
    });
    expect(auditRows(db, "executor:e-bi-explicit:1")).toHaveLength(1);
  });

  it("显式指定未授权工具：plugin_tool_not_found，不回退到 alpha", async () => {
    const { q, db } = await newQ();
    await installBuiltin(q, "stub.two");
    const ex = new BuiltinPluginExecutor({ writer: q });
    const r = await ex.run(
      req({
        execution_id: "e-bi-denied",
        plugin_id: "stub.two",
        tool_name: "missing",
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("期望失败回执");
    expect(r.code).toBe("plugin_tool_not_found");
    expect(r.message).toContain("missing");
    expect(r.message).toContain("alpha, zeta");
    expect(r.message).not.toContain("ran:alpha");
    expect(r.retry_next_executor).toBe(true);
    expect(auditRows(db, "executor:e-bi-denied:1")).toHaveLength(1);
  });

  it("两个工具：缺省按字典序选择第一个 alpha，结果写明实际工具", async () => {
    const { q, db } = await newQ();
    await installBuiltin(q, "stub.two");
    const ex = new BuiltinPluginExecutor({ writer: q });
    const r = await ex.run(
      req({ execution_id: "e-bi-ok", plugin_id: "stub.two" }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("期望 done 回执");
    // ran:alpha 而不是 ran:zeta ⇒ 选中来自 ORDER BY，不是注册/插入顺序。
    expect(r.text).toBe("ran:alpha");
    expect(r.summary).toBe("内置插件 [stub.two] 工具 [alpha]：ran:alpha");
    expect(r.harness_result).toEqual({
      plugin_id: "stub.two",
      tool_name: "alpha",
      plugin_kind: "builtin",
    });
    expect(r.cost_cents).toBeUndefined();
    const rows = auditRows(db, "executor:e-bi-ok:1");
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(String(rows[0]?.payload)) as Record<
      string,
      unknown
    >;
    expect(payload.ok).toBe(true);
  });

  it("0 工具：plugin_tool_not_found + retry true + 审计恰一行", async () => {
    const { q, db } = await newQ();
    await installBuiltin(q, "stub.none");
    const ex = new BuiltinPluginExecutor({ writer: q });
    const r = await ex.run(
      req({ execution_id: "e-bi-0", plugin_id: "stub.none" }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("期望失败回执");
    expect(r.code).toBe("plugin_tool_not_found");
    // retry 判「换下一格有没有意义」：下一格可能是好插件或真人席 ⇒ true。
    expect(r.retry_next_executor).toBe(true);
    const rows = auditRows(db, "executor:e-bi-0:1");
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(String(rows[0]?.payload)) as Record<
      string,
      unknown
    >;
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("plugin_tool_not_found");
  });

  it("模块已随版本移除：plugin_not_found 透传且消息写明实际工具", async () => {
    // ghost 形状必须是【行在库里、模块不在代码】：plugin_tools.plugin_id 有 FK，
    // 「插件行都不存在」的幽灵在本执行器只会停在 0 工具门（上面那条已钉），
    // 走不到 executeTool —— 透传判据要靠这个真实形状才测得到。
    const { q, db } = await newQ();
    db.prepare(
      "INSERT INTO plugins (plugin_id, name, kind, endpoint, config_json, enabled, installed_at, last_probe_json)" +
        " VALUES ('ghost.mod', '幽灵', 'builtin', NULL, '{}', 1, ?, NULL)",
    ).run(NOW);
    db.prepare(
      "INSERT INTO plugin_tools (plugin_id, tool_name, description, input_schema_json)" +
        " VALUES ('ghost.mod', 'only', '遗留工具', '{\"type\":\"object\"}')",
    ).run();
    const ex = new BuiltinPluginExecutor({ writer: q });
    const r = await ex.run(
      req({ execution_id: "e-bi-ghost", plugin_id: "ghost.mod" }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("期望失败回执");
    expect(r.code).toBe("plugin_not_found");
    expect(r.retry_next_executor).toBe(true);
    expect(auditRows(db, "executor:e-bi-ghost:1")).toHaveLength(1);
  });
});
