/**
 * platform-webhook 执行器（T6）的行为判据。
 *
 * ⚠ 夹具走真 WriteQueue + 真迁移（同 plugins/service.test.ts 的立场）：
 * 执行链全程 writer.node → requireScopeDb，手搓假 tx 会让这条结构性消失。
 *
 * 这一层是「判据链的交钥匙层」：行存在 / enabled / 工具在授权表 / 入参过 schema /
 * 真调用，全部判据在 plugins/service.ts 的 executeTool（那边有自己的测试逐门钉过）。
 * 本文件【不重测判据链】，只钉执行器自己的三件事：
 *  ① 结果映射：ok → done（summary 取首行、harness_result 三键、cost_cents 缺省）；
 *     err → errRun（code 原样透传、message=reason、retry 恒 true）；
 *  ② args 形状：instruction 恒带、role_prompt 非空才带（工具少拿一格内部形状都好归因）；
 *  ③ 审计：一次尝试恰好一行 executor_run —— 成功行与失败行都要有，
 *     「失败尝试在 events 里不存在」会让重试链没法回答「前面几次为什么不行」。
 *
 * mcp 的 plugin_tools 行直接写库：installPlugin 的 mcp 分支只插插件行，
 * 工具集要探测才有（plugins/service.ts 文件头「工具表只刷成功探测」），
 * 而这里要测的是执行器不是探测器。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ExecutorRunRequest } from "@opc/contracts";
import { executorRunRequestSchema } from "@opc/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { PluginWebhookExecutor } from "../../src/executors/plugin-webhook.js";
import {
  type ConnectorFactory,
  installPlugin,
  type PluginCallResult,
} from "../../src/plugins/service.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("executors-webhook", import.meta.url);
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

/** 真库：迁移 + 一条 task（events.task_id 有 FK，审计用例要真 task）。 */
async function newQ(): Promise<{ q: WriteQueue; db: AnyDb }> {
  const path = join(TMP, "wh-" + process.pid + "-" + ++fileSeq + ".db");
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

/** 装一个 mcp 插件（id 可控，断言好写）。 */
async function installMcp(q: WriteQueue, id: string): Promise<void> {
  const r = await installPlugin(q, {
    req: {
      kind: "mcp",
      name: "MCP 桩",
      endpoint: "http://127.0.0.1:9/mcp",
      config: {},
    },
    nowMs: NOW,
    newId: () => id,
  });
  if (!r.ok) throw new Error("mcp 安装夹具失败：" + r.reason);
}

/** 直接写授权行（mcp 安装不种工具，见文件头）。 */
function insertTool(db: AnyDb, pluginId: string, tool: string): void {
  db.prepare(
    "INSERT INTO plugin_tools (plugin_id, tool_name, description, input_schema_json)" +
      " VALUES (?, ?, '说一句', '{\"type\":\"object\"}')",
  ).run(pluginId, tool);
}

/** 一份合规请求（executorRunRequestSchema.parse 兜形状，条件展开伺候 exactOptionalPropertyTypes）。 */
function req(over: {
  execution_id: string;
  plugin_id: string;
  tool_name: string;
  seq?: number;
  role_prompt?: string;
}): ExecutorRunRequest {
  return executorRunRequestSchema.parse({
    execution_id: over.execution_id,
    task_id: "t1",
    member_id: "m1",
    role_id: "dev",
    seq: over.seq ?? 1,
    kind: "platform-webhook",
    config: {
      kind: "platform-webhook",
      plugin_id: over.plugin_id,
      tool_name: over.tool_name,
    },
    model_tier: "execution",
    instruction: "把首页按钮文案改掉",
    ...(over.role_prompt === undefined
      ? {}
      : { role_prompt: over.role_prompt }),
  });
}

/** 桩连接器：调用记账 + 回执可控（不开端口，真 MCP 协议在 plugins 测试那边钉）。 */
function stubFactory(result: PluginCallResult) {
  const seen: { name: string; args: unknown }[] = [];
  const factory: ConnectorFactory = async () => ({
    async start() {},
    async listTools() {
      return [];
    },
    async callTool(name: string, args: unknown) {
      seen.push({ name, args });
      return result;
    },
    async close() {},
  });
  return { factory, seen };
}

describe("PluginWebhookExecutor", () => {
  it("成功：done + summary 取首行 + harness_result 三键 + cost_cents 缺省 + 审计恰一行", async () => {
    const { q, db } = await newQ();
    await installMcp(q, "mcp-h");
    insertTool(db, "mcp-h", "say");
    const { factory, seen } = stubFactory({
      ok: true,
      text: "首行结论\n次行细节",
    });
    const ex = new PluginWebhookExecutor({
      writer: q,
      connectorFactory: factory,
    });
    const r = await ex.run(
      req({
        execution_id: "e-ok",
        plugin_id: "mcp-h",
        tool_name: "say",
        role_prompt: "你是测试工程师",
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("期望 done 回执");
    expect(r.text).toBe("首行结论\n次行细节");
    expect(r.summary).toBe("首行结论");
    expect(r.harness_result).toEqual({
      plugin_id: "mcp-h",
      tool_name: "say",
      plugin_kind: "mcp",
    });
    // 「没记到钱」≠「没花钱」：done 里这一格必须整个不存在。
    expect(r.cost_cents).toBeUndefined();
    // args 形状（instruction + 非空 role_prompt 都进工具）。
    const first = seen[0];
    if (first === undefined) throw new Error("桩连接器没被调用");
    expect(first.name).toBe("say");
    expect(first.args).toEqual({
      instruction: "把首页按钮文案改掉",
      role_prompt: "你是测试工程师",
    });
    const rows = auditRows(db, "executor:e-ok:1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("tool_call");
    const payload = JSON.parse(String(rows[0]?.payload)) as Record<
      string,
      unknown
    >;
    expect(payload.kind).toBe("executor_run");
    expect(payload.ok).toBe(true);
  });

  it("role_prompt 为空串：args 只带 instruction（内部形状少给一格是一格）", async () => {
    const { q, db } = await newQ();
    await installMcp(q, "mcp-p");
    insertTool(db, "mcp-p", "say");
    const { factory, seen } = stubFactory({ ok: true, text: "好了" });
    const ex = new PluginWebhookExecutor({
      writer: q,
      connectorFactory: factory,
    });
    const r = await ex.run(
      req({ execution_id: "e-args", plugin_id: "mcp-p", tool_name: "say" }),
    );
    expect(r.ok).toBe(true);
    const first = seen[0];
    if (first === undefined) throw new Error("桩连接器没被调用");
    expect(first.args).toEqual({ instruction: "把首页按钮文案改掉" });
  });

  it("插件不存在：plugin_not_found + retry true + 审计恰一行（失败尝试也要在案）", async () => {
    const { q, db } = await newQ();
    const ex = new PluginWebhookExecutor({ writer: q });
    const r = await ex.run(
      req({ execution_id: "e-ghost", plugin_id: "ghost", tool_name: "say" }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("期望失败回执");
    expect(r.code).toBe("plugin_not_found");
    expect(r.retry_next_executor).toBe(true);
    const rows = auditRows(db, "executor:e-ghost:1");
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(String(rows[0]?.payload)) as Record<
      string,
      unknown
    >;
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("plugin_not_found");
  });

  it("插件停用：plugin_disabled + retry true", async () => {
    const { q, db } = await newQ();
    await installMcp(q, "mcp-off");
    insertTool(db, "mcp-off", "say");
    db.prepare("UPDATE plugins SET enabled = 0 WHERE plugin_id = ?").run(
      "mcp-off",
    );
    const ex = new PluginWebhookExecutor({ writer: q });
    const r = await ex.run(
      req({ execution_id: "e-off", plugin_id: "mcp-off", tool_name: "say" }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("期望失败回执");
    expect(r.code).toBe("plugin_disabled");
    expect(r.retry_next_executor).toBe(true);
    expect(auditRows(db, "executor:e-off:1")).toHaveLength(1);
  });

  it("工具不在授权表：plugin_tool_not_found + retry true", async () => {
    const { q, db } = await newQ();
    await installMcp(q, "mcp-notool");
    const ex = new PluginWebhookExecutor({ writer: q });
    const r = await ex.run(
      req({
        execution_id: "e-notool",
        plugin_id: "mcp-notool",
        tool_name: "say",
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("期望失败回执");
    expect(r.code).toBe("plugin_tool_not_found");
    expect(r.retry_next_executor).toBe(true);
    expect(auditRows(db, "executor:e-notool:1")).toHaveLength(1);
  });
});
