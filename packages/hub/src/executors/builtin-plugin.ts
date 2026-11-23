/**
 * builtin-plugin 执行器（T6，design-2026-11-23-群角色上层.md D4 七种 kind 之第五种）：
 * 「员工」是一个进程内内置插件（plugins 表 kind='builtin' 的授权行，行为在
 * plugins/registry.ts 的代码侧模块里）。
 *
 * ── 登记在案的限制：config 指定不了「多工具插件里的哪一个工具」────────
 * contracts/member.ts 的 executorConfigSchema 给 builtin-plugin 的格子只有
 * plugin_id 一格（platform-webhook 才有 tool_name）。这是契约的形状，执行器
 * 不改契约（本任务硬约束），于是「这个内置插件注册了 3 个工具，成员该用哪个」
 * 在配置里【无法表达】。本文件的取法：按 tool_name 字典序取第一个，并在消息里
 * 把选中了谁写出来 —— 确定性（同一份库永远选同一个），但确实是个限制，
 * 将来要给 builtin 补 tool_name 就同时改契约、招聘页与这里。
 *
 * ── 工具选择的读取点 ──────────────────────────────────────────────
 * 读 plugin_tools（= 授权面，0019 文件头：表即授权）而不是代码模块的 tools()：
 * 执行判据链（executeTool 门③）认的是表，这里若读代码，就会出现「这里选了表外
 * 工具、executeTool 当场拒」的两本账。查询与 executeTool 之间工具集可能被并发
 * 刷新 —— 不防：与 plugins/service.ts 文件头「授权检查的执行点」同一条固有竞态。
 *
 * 共同骨架（run 永不抛 / 恰好一行 executor_run 审计 / cost_cents 缺省 ≠ 0）
 * 见 plugin-webhook.ts 文件头，两份一致，不在此重述。
 */
import type { ExecutorRunOutcome, ExecutorRunRequest } from "@opc/contracts";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import type { Writer } from "../db/write-queue.js";
import { executeTool } from "../plugins/service.js";
// 三件套助手（args 拼装 / 摘要取行 / 错误码透传判据）住在地基 types.ts 里复用：
// 四份执行器各抄一份就是「两份抄本」的本体。builtin 不传 connectorFactory（见 #attempt 注释）。
import {
  asExecutorFailureCode,
  auditExecutorRunViaWriter,
  buildToolArgs,
  type Executor,
  errRun,
  firstNonEmptyLine,
  okRun,
} from "./types.js";

export interface BuiltinPluginExecutorOptions {
  readonly writer: Writer;
}

/** 该插件当前授权的工具名（字典序）。 */
function toolNamesOf(w: Writer, pluginId: string): Promise<string[]> {
  return w.node(() => {
    const rows = requireScopeDb("executors.builtin-plugin.tools")
      .prepare(
        "SELECT tool_name FROM plugin_tools WHERE plugin_id = ? ORDER BY tool_name",
      )
      .all(pluginId) as unknown as { tool_name: string }[];
    return rows.map((r) => String(r.tool_name));
  });
}

export class BuiltinPluginExecutor implements Executor {
  readonly kind = "builtin-plugin" as const;
  readonly #w: Writer;

  constructor(opts: BuiltinPluginExecutorOptions) {
    this.#w = opts.writer;
  }

  async run(req: ExecutorRunRequest): Promise<ExecutorRunOutcome> {
    let outcome: ExecutorRunOutcome;
    try {
      outcome = await this.#attempt(req);
    } catch (e) {
      // 覆盖两类抛：工具名查询本身失败（表都不在 = 迁移没跑够）与 executeTool 内部抛。
      // 原话带进 message（「不吞」口径），retry true —— 下一格执行器不一定读这张表。
      outcome = errRun(req, {
        code: "executor_error",
        message:
          "builtin-plugin 执行器自身抛错：" +
          (e instanceof Error ? e.message : String(e)),
        retry_next_executor: true,
      });
    }
    await auditExecutorRunViaWriter(
      this.#w,
      outcome,
      "executors.builtin-plugin.run",
    );
    return outcome;
  }

  async #attempt(req: ExecutorRunRequest): Promise<ExecutorRunOutcome> {
    if (req.config.kind !== "builtin-plugin") {
      throw new Error(
        "builtin-plugin 执行器收到 config.kind=" +
          req.config.kind +
          " 的请求（kind 与 config 不一致，属装配 bug）。",
      );
    }
    const tools = await toolNamesOf(this.#w, req.config.plugin_id);
    if (tools.length === 0) {
      // 0 工具 = 「这个执行器的配置指向了一个没有工具集的插件」——配置坏了。
      // 但 retry_next_executor 判的不是「这个配置能不能修」而是「换下一个执行器
      // 有没有意义」（契约 executorRunErrorSchema 注释的分工）：下一格可能是
      // 好的插件、真人席，当然有意义 ⇒ true。
      return errRun(req, {
        code: "plugin_tool_not_found",
        message:
          "内置插件 [" +
          req.config.plugin_id +
          "] 没有登记任何工具（plugin_tools 零行）：先安装/探测登记工具集，" +
          "或让下一个执行器接这一轮。",
        retry_next_executor: true,
      });
    }
    const tool = tools[0] as string;
    // 不传 connectorFactory：builtin 路不建 MCP 连接（executeTool 门⑤ 走进程内模块），
    // 传了也没有读取方。
    const r = await executeTool(this.#w, {
      pluginId: req.config.plugin_id,
      tool,
      args: buildToolArgs(req),
    });
    if (r.ok) {
      return okRun(req, {
        text: r.text,
        summary: firstNonEmptyLine(r.text),
        harness_result: {
          plugin_id: req.config.plugin_id,
          tool_name: tool,
          plugin_kind: r.kind,
        },
        // cost_cents 缺省：进程内模块不报账，不知道 ≠ 0。
      });
    }
    return errRun(req, {
      code: asExecutorFailureCode(r.code),
      message: r.reason,
      retry_next_executor: true,
    });
  }
}
