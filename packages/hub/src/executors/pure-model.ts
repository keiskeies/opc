/**
 * pure-model 执行器（T6，design-2026-11-23-群角色上层.md D4 七种 kind 之第六种）：
 * 「员工」是一个裸模型调用（没有 CLI 进程、没有插件工具、没有真人），
 * 产出必须落成 <<<OPC_DECISION>>> 决策块才可推进状态机。
 *
 * ── 注入缝为什么是 ModelCaller 而不是 ModelRegistry ────────────────
 * engine 侧的 ModelRegistry 是 LangChain BaseChatModel 的装配层（厚：档位映射、
 * 重试、成本核算都在里面）。执行器若直接吃它，单测就得装 LangChain 依赖，
 * 而本层要钉的只有「拿到一段文本 → 解析决策 → 落一行审计」这条窄链。
 * 所以这里只认最小缝：一个 (model_tier, instruction, role_prompt) → { text }
 * 的异步函数。装配方（T7 dispatch 接线）负责把 ModelRegistry 包成它。
 *
 * ── 两个失败码的【唯一生产者】身份（防下一个人找错门）────────────────
 *  · model_unavailable：callModel 缺省（装配方没给模型）时本文件是【唯一】生产者。
 *  · decision_missing：契约注释说「执行成功但没有 <<<OPC_DECISION>>> 块」，而
 *    parseDecision 只在这里被调用 —— CLI 三家执行器【不解析决策】（决策解析在
 *    engine/dispatch 那一层，CLI 回执原样进 harness_result），所以要去 CLI 里
 *    找这个码的生产点是找不到的，本文件是唯一一处。
 *
 * 共同骨架（run 永不抛 / 恰好一行 executor_run 审计 / cost_cents 缺省 ≠ 0）
 * 见 plugin-webhook.ts 文件头，不在此重述。
 */
import type {
  ExecutorRunOutcome,
  ExecutorRunRequest,
  ModelTier,
} from "@opc/contracts";
import type { Writer } from "../db/write-queue.js";
import { parseDecision } from "../engine/claude.js";
import {
  auditExecutorRunViaWriter,
  type Executor,
  errRun,
  okRun,
} from "./types.js";

/**
 * 模型调用最小缝（见文件头「注入缝」段）。
 * role_prompt 恒有值（契约 default ""），空串怎么拼进提示词是注入方的事。
 */
export type ModelCaller = (params: {
  model_tier: ModelTier;
  instruction: string;
  role_prompt: string;
}) => Promise<{ text: string }>;

export interface PureModelExecutorOptions {
  readonly writer: Writer;
  /** 缺省 undefined = 这台 hub 没装模型：每次尝试都记 model_unavailable。 */
  readonly callModel?: ModelCaller;
}

export class PureModelExecutor implements Executor {
  readonly kind = "pure-model" as const;
  readonly #w: Writer;
  readonly #callModel: ModelCaller | undefined;

  constructor(opts: PureModelExecutorOptions) {
    this.#w = opts.writer;
    this.#callModel = opts.callModel;
  }

  async run(req: ExecutorRunRequest): Promise<ExecutorRunOutcome> {
    let outcome: ExecutorRunOutcome;
    try {
      outcome = await this.#attempt(req);
    } catch (e) {
      // callModel 自己抛（网络断 / 配额爆 / LangChain 内部错）走到这里。
      // 分不出「换谁有没有用」（那是注入方的领域知识），按未分类错 retry true 交回路由。
      outcome = errRun(req, {
        code: "executor_error",
        message:
          "pure-model 执行器自身抛错：" +
          (e instanceof Error ? e.message : String(e)),
        retry_next_executor: true,
      });
    }
    await auditExecutorRunViaWriter(
      this.#w,
      outcome,
      "executors.pure-model.run",
    );
    return outcome;
  }

  async #attempt(req: ExecutorRunRequest): Promise<ExecutorRunOutcome> {
    if (req.config.kind !== "pure-model") {
      throw new Error(
        "pure-model 执行器收到 config.kind=" +
          req.config.kind +
          " 的请求（kind 与 config 不一致，属装配 bug）。",
      );
    }
    const callModel = this.#callModel;
    if (callModel === undefined) {
      // model_unavailable 的唯一生产者（见文件头）。retry true：本 hub 没装模型，
      // 但下一个执行器可能装了（CLI 自带模型、真人自带大脑）。
      return errRun(req, {
        code: "model_unavailable",
        message:
          "本 hub 未装配模型（ModelCaller 缺省），pure-model 执行器无法起轮。",
        retry_next_executor: true,
      });
    }
    const r = await callModel({
      model_tier: req.model_tier,
      instruction: req.instruction,
      role_prompt: req.role_prompt,
    });
    const d = parseDecision(r.text);
    if (d === null) {
      // decision_missing 的唯一生产者（见文件头）。retry true：换个执行器
      // （CLI 会在提示词里带决策规约、人天然会写结论）可能拿回可判定的东西。
      // 原文截断带进 message：「模型到底吐了什么」是这条失败唯一的现场证据。
      return errRun(req, {
        code: "decision_missing",
        message:
          "模型输出没有 <<<OPC_DECISION>>> 决策块（或块不是合法 JSON/缺 action/summary）。原文片段：" +
          r.text.replace(/\s+/g, " ").slice(0, 300),
        retry_next_executor: true,
      });
    }
    return okRun(req, {
      text: r.text,
      summary: d.summary,
      // note 不传：okRun 自己有缺省 ""（多传一份同值反而邀请调用方改写缺省）。
      // cost_cents 缺省：最小缝不报账，不知道 ≠ 0。
    });
  }
}
