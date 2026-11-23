/**
 * platform-webhook 执行器（T6，design-2026-11-23-群角色上层.md D4 七种 kind 之第四种）：
 * 「员工」是一个被授权的 MCP 工具（plugins 表 kind='mcp' 的行 + 它的一个工具）。
 *
 * ── 这一份文件做的事 ─────────────────────────────────────────────
 * 收请求 → 交给 plugins/service.ts 的 executeTool → 把结果映射成契约回执 →
 * 结尾落恰好一行 executor_run 审计。判据链（行存在 / enabled / 工具在授权表 /
 * 入参过 schema / 真调用）全在 executeTool 里，本文件【不复述】——
 * 同一判据抄两份必漂（plugins/service.ts 文件头「执行判据链」段是唯一定义处）。
 *
 * ── 四执行器共同骨架（types.ts 文件头立过，这里展开 webhook 这条腿）────
 *  · run() 永远 resolve：整体 try/catch，意外抛错翻成 executor_error 且原话带进
 *    message（契约 EXECUTOR_FAILURE_CODES 那条「不吞」的口径）；
 *  · 一次尝试恰好一行 executor_run 审计（auditExecutorRunViaWriter，router 不代写）；
 *  · cost_cents 结构上不知道花了多少 ⇒ 【缺省而不是 0】：「没记到钱」与「没花钱」
 *    是两个事实，填 0 是伪证（契约 executorRunDoneSchema.cost_cents 注释同款立场）。
 *
 * ── 失败透传：code 原样透传、retry 一律 true ─────────────────────────────
 * executeTool 的错误码是 ExecutorFailureCode 的子集（service.ts 的 PluginServiceCode
 * 注释 + test/plugins/service.test.ts 逐字钉住），这里【不再抄一份词表】：运行时
 * contains 判据过就原样透传，判不过（服务侧独有码，执行路径结构上产不出）翻成
 * executor_error —— 两份词表漂移过一次就是「插件层说 A、执行层报 B」，宁可退到
 * 未分类码也不发明第三种说法。
 * retry_next_executor 恒 true：判据链上每一个拒（缺行 / 停用 / 未授权工具 /
 * 坏 schema / 连不上 / 对端报错）都还有「下一格是别的插件、或干脆是真人席」的指望，
 * 换人有没有意义由重试层读这一格，不许它自己按 code 猜（契约注释的分工）。
 */
import type { ExecutorRunOutcome, ExecutorRunRequest } from "@opc/contracts";
import type { Writer } from "../db/write-queue.js";
import { type ConnectorFactory, executeTool } from "../plugins/service.js";
import {
  asExecutorFailureCode,
  auditExecutorRunViaWriter,
  buildToolArgs,
  type Executor,
  errRun,
  firstNonEmptyLine,
  okRun,
} from "./types.js";

export interface PluginWebhookExecutorOptions {
  readonly writer: Writer;
  /** MCP 连接器工厂（装配方注桩/真实现；缺省走 service.ts 的默认 mcpConnector）。 */
  readonly connectorFactory?: ConnectorFactory;
}

export class PluginWebhookExecutor implements Executor {
  readonly kind = "platform-webhook" as const;
  readonly #w: Writer;
  readonly #connectorFactory: ConnectorFactory | undefined;

  constructor(opts: PluginWebhookExecutorOptions) {
    this.#w = opts.writer;
    this.#connectorFactory = opts.connectorFactory;
  }

  async run(req: ExecutorRunRequest): Promise<ExecutorRunOutcome> {
    let outcome: ExecutorRunOutcome;
    try {
      outcome = await this.#attempt(req);
    } catch (e) {
      // 走到这里只剩「executeTool 自己抛」（坏 config_json 的 JSON.parse 等）。
      // 原话必须带进 message：这一族异常的内容本身就是诊断信息，吞了要重跑才拿得到。
      outcome = errRun(req, {
        code: "executor_error",
        message:
          "platform-webhook 执行器自身抛错：" +
          (e instanceof Error ? e.message : String(e)),
        retry_next_executor: true,
      });
    }
    await auditExecutorRunViaWriter(
      this.#w,
      outcome,
      "executors.plugin-webhook.run",
    );
    return outcome;
  }

  async #attempt(req: ExecutorRunRequest): Promise<ExecutorRunOutcome> {
    // 路由层（run.ts）保证 kind 与 config.kind 同值；这里再判一次是执行器自己的
    // 入口守卫 —— run() 是公开接口，未来的 HTTP 层未必经过 run.ts 的那道 superRefine。
    // 不匹配是装配 bug：抛出去由外层翻成 executor_error（响亮，不静默错拿配置执行）。
    if (req.config.kind !== "platform-webhook") {
      throw new Error(
        "platform-webhook 执行器收到 config.kind=" +
          req.config.kind +
          " 的请求（kind 与 config 不一致，属装配 bug）。",
      );
    }
    const r = await executeTool(this.#w, {
      pluginId: req.config.plugin_id,
      tool: req.config.tool_name,
      args: buildToolArgs(req),
      ...(this.#connectorFactory !== undefined
        ? { connectorFactory: this.#connectorFactory }
        : {}),
    });
    if (r.ok) {
      return okRun(req, {
        text: r.text,
        summary: firstNonEmptyLine(r.text),
        // harness_result 三键：审计要能回答「哪一层、哪个插件的哪个工具说的」。
        harness_result: {
          plugin_id: req.config.plugin_id,
          tool_name: req.config.tool_name,
          plugin_kind: r.kind,
        },
        // cost_cents 刻意不传：结构上不知道对端花了多少 ≠ 0（见文件头）。
      });
    }
    return errRun(req, {
      code: asExecutorFailureCode(r.code),
      message: r.reason,
      retry_next_executor: true,
    });
  }
}
