/**
 * human 执行器（T6，design-2026-11-23-群角色上层.md D4/D7 七种 kind 之第七种）：
 * 「员工」是一个真人 —— 执行 = 往审批收件箱建一张真人待办卡，本轮【没有产出】。
 *
 * ── 为什么终态是 errRun(human_pending) 而不是 done ──────────────────
 * 直觉上「卡建成功了」该算 done，但契约把 human_pending 定义为
 * 「卡片已写入待办，这不是错误，但这一轮【没有产出】」（EXECUTOR_FAILURE_CODES 注释），
 * 而 done 的语义是「产出了可推进状态机的东西」（executorRunDoneSchema 文件头）。
 * 等人的活儿不能推进状态机 —— 返回 done 等于让路由层在「真人还没看」的时刻
 * 把任务往前送。所以 created 与 duplicate 两支都收敛到
 * errRun(human_pending, retry_next_executor: true)：
 *  · retry true：真人本轮空转，下一格执行器（如果配了）才有机会真干活；
 *  · 契约的 err 支没有 card_id 格（done 才有），所以 approvalId 写进 message ——
 *    「UI 拿着回执就能跳转到那张卡」是这一格存在的全部理由。
 *
 * ── duplicate 时 approvalId 的来源（读 cards.ts 确认过的事实）────────
 * insertCard 撞去重键时返回的 InsertCardResult.approvalId 是【当场新发的 UUID】
 * （cards.ts insertCard：randomUUID() 在 INSERT 之前生成，撞键后原样带回）——
 * 它【不是】库里那张已有卡的 id。直接把它写进 message 会给 UI 一个点不开的链接，
 * 这是一次伪证（0013 §10.1 同款立场）。所以 duplicate 支改为按
 * (task_id, card_key, status='pending') 回查真实卡 id（0006 的部分唯一索引
 * 保证同名待批卡至多一张）；回查落空（并发下刚好被批掉的窄窗）就只说「已有待办」
 * 而不编 id。
 *
 * ── 卡片参数里的产品判据 ──────────────────────────────────────────
 *  · timeout_behavior 恒 "escalate"，永远不给 auto_approve：真人待办的推荐动作是
 *    「由真人直接处理」，让超时器替人点头与这张卡的存在理由自相矛盾
 *    （cards.ts O10 判据「自动放行不可逆动作 = 无后果的决定」的同族立场）；
 *  · recommendation_is_not_decision 恒 true（§9.2 口径，契约 literal(true) 钉死）；
 *  · recommendation_source 不传：§9.2 说这一栏归「总监层」，执行器不是总监，
 *    没有出处就不编一个（cards.ts 同款立场，落 NULL）。
 *
 * 共同骨架（run 永不抛 / 恰好一行 executor_run 审计 / cost_cents 缺省 ≠ 0）
 * 见 plugin-webhook.ts 文件头，不在此重述。
 */

import type { ExecutorRunOutcome, ExecutorRunRequest } from "@opc/contracts";
import { APPROVAL_BUTTONS } from "@opc/contracts";
import { createCard, type NewCardDraft } from "../approvals/cards.js";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import type { Writer } from "../db/write-queue.js";
import { auditExecutorRunViaWriter, type Executor, errRun } from "./types.js";

export interface HumanExecutorOptions {
  readonly writer: Writer;
}

/** 卡片摘要里指令正文的截断长度（卡片是「一行决策摘要」，不是全文投递）。 */
const INSTRUCTION_SNIPPET_CHARS = 200;

/** 同一执行的重投标的：card_key 只按 execution_id 收，同一执行重复投递不重复建卡。 */
export function humanCardKeyOf(executionId: string): string {
  return "human:" + executionId;
}

export class HumanExecutor implements Executor {
  readonly kind = "human" as const;
  readonly #w: Writer;

  constructor(opts: HumanExecutorOptions) {
    this.#w = opts.writer;
  }

  async run(req: ExecutorRunRequest): Promise<ExecutorRunOutcome> {
    let outcome: ExecutorRunOutcome;
    try {
      outcome = await this.#attempt(req);
    } catch (e) {
      // createCard 抛只剩两类真成因：卡片内容过不了 §9.2 契约（编程错误）、
      // task_id 外键不存在（引用了不存在的任务，cards.ts 刻意不兜）。
      // 都按未分类错带原话交回路由；retry true —— 建卡坏了不该连坐整条路由，
      // 下一格（真人之外的执行器）不读 approvals 表。
      outcome = errRun(req, {
        code: "executor_error",
        message:
          "human 执行器建卡抛错：" +
          (e instanceof Error ? e.message : String(e)),
        retry_next_executor: true,
      });
    }
    await auditExecutorRunViaWriter(this.#w, outcome, "executors.human.run");
    return outcome;
  }

  async #attempt(req: ExecutorRunRequest): Promise<ExecutorRunOutcome> {
    if (req.config.kind !== "human") {
      throw new Error(
        "human 执行器收到 config.kind=" +
          req.config.kind +
          " 的请求（kind 与 config 不一致，属装配 bug）。",
      );
    }
    // 收件线索：请求侧优先（调用方最知道这轮该找谁），配置侧兜底（招聘页登记的常驻收件人）。
    const hint = req.assignee_hint ?? req.config.assignee_hint;
    const snippet =
      req.instruction.length > INSTRUCTION_SNIPPET_CHARS
        ? req.instruction.slice(0, INSTRUCTION_SNIPPET_CHARS) + "…"
        : req.instruction;
    const draft: NewCardDraft = {
      taskId: req.task_id,
      approvalType: "escalation",
      cardKey: humanCardKeyOf(req.execution_id),
      summary:
        "【真人待办】" +
        (hint !== undefined && hint !== ""
          ? "收件线索：" + hint + "；"
          : "（无收件线索）") +
        "指令：" +
        snippet,
      parameters: {
        impact_scope: "manual_review",
        irreversible: false,
        recommendation: "由真人直接处理本任务",
        recommendation_is_not_decision: true,
        // 真人待办不许自动批准（见文件头「产品判据」段）：escalate 是三值里
        // 唯一不替人点头的档（cards.ts 文件头记的 §9.3 口径）。
        timeout_behavior: "escalate",
      },
      evidence_refs: ["executor:" + req.execution_id + ":" + String(req.seq)],
      buttons: [...APPROVAL_BUTTONS],
      escalation: { reason: "outside_decision_scope" },
    };
    const { result } = await createCard(this.#w, draft, { nowMs: Date.now() });
    if (result.created) {
      return errRun(req, {
        code: "human_pending",
        message:
          "已建真人待办卡（approvalId=" +
          result.approvalId +
          "），本轮无人格产出，等收件人处理。",
        retry_next_executor: true,
      });
    }
    // 走到这里 = skipped:"duplicate"（insertCard 除 duplicate 外只有抛）。
    // 幂等重投的语义是「卡还在，继续等」：回查真实卡 id 给 UI（见文件头，
    // 撞键回执里的 approvalId 是新发 UUID，不能当卡 id 用）。
    const realId = await this.#findPendingCardId(
      req.task_id,
      draft.cardKey ?? "",
    );
    return errRun(req, {
      code: "human_pending",
      message:
        "同一执行已有待批的真人待办卡" +
        (realId !== null
          ? "（approvalId=" + realId + "）"
          : "（刚被处理，id 不可得）") +
        "，本轮不重复建卡，继续等人处理。",
      retry_next_executor: true,
    });
  }

  /** 撞键后回查那张待批真卡的 id；查不到（并发下刚好被批掉）⇒ null，不编。 */
  #findPendingCardId(taskId: string, cardKey: string): Promise<string | null> {
    return this.#w.node(() => {
      const row = requireScopeDb("executors.human.findPendingCard")
        .prepare(
          "SELECT id FROM approvals WHERE task_id = ? AND card_key = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
        )
        .get(taskId, cardKey) as { id: string } | undefined;
      if (row === undefined) return null;
      return String(row.id);
    });
  }
}
