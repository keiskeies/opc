/**
 * 驱动循环：把「一个角色干一轮」推到「这件事推到推不动为止」。
 *
 * ── 为什么需要这一层，dispatch 本身不够吗 ────────────────────────────
 * makeDispatch 一次只跑【一轮】：让当前负责的角色干一次活，然后判那一步算不算数。
 * 而 CEO 的真实动作是「下发一个想法」，不是「按十次回车」。
 * 中间这一层要回答的是【什么时候该停】，而这个问题没有「跑满 N 轮」这种答案：
 *
 *  · 停在人坐的格子（CHARTER_PENDING / ESCALATED_TO_CEO / FINAL_REVIEW）—— 等人点按钮；
 *  · 停在【同一轮什么都没变】—— 角色说了 wait，或者它的动作对不上任何合法边。
 *    这一支必须停，不然循环会变成【拿钱买 wait】：每轮真烧一次 claude -p，
 *    状态一动不动，直到预算烧穿。这是本模块唯一一处「写错不报错、只是把钱花光」的地方；
 *  · 停在步数上限 —— 最后一道闸，防的是上面两条判据被将来的改动弄失效。
 *
 * ── 为什么循环【不在】dispatch 里 ────────────────────────────────────
 * dispatch 一次一事务、一次一判定，它的可测性全押在「一次调用 = 一个可判定的事实」上
 * （dispatch.test.ts 那 49 发全是这么写的）。把循环塞进去会让每一条断言都要先决定
 * 「这次会跑几轮」，而那是驱动方的策略不是门控的语义。策略与门控分开，
 * 与本仓 engine/ 那条一贯的分工同形（agent 定内容、hub 定门槛）。
 *
 * ── 为什么每次迭代都重新 loadTask ────────────────────────────────────
 * 一轮之后 assigned_role 与 status 都可能变了（活儿交到下一个角色手上了）。
 * 缓存那份快照会让第 2 轮拿【上一个角色】的身份去 --resume —— 症状是
 * 「director 接着 dev 的会话说话」，而两边都还在正常输出，看不出串了。
 */
import type { DispatchResult, DispatchTask } from "./dispatch.js";
import type { EngineRuntime } from "./runtime.js";

export interface AdvanceOptions {
  readonly taskId: string;
  /** 最多跑几轮。默认 12，是给「死循环烧钱」兜底的闸，不是预期工作量。 */
  readonly maxTurns?: number;
  /** 每轮的美元硬顶。 */
  readonly maxBudgetUsd: number;
  readonly nowMs?: () => number;
  /** 每轮结束时的回调（CLI 打进度、桌面端推 IPC 都挂这里）。 */
  readonly onTurn?: (r: AdvanceTurnLog) => void;
}

export interface AdvanceTurnLog {
  readonly turn: number;
  readonly res: DispatchResult;
  /** 留痕结果。recorded:false 时钱与状态都已提交，只是 §12.7 第 4 层少一行。 */
  readonly recorded: boolean;
  readonly why: string;
}

export interface AdvanceResult {
  readonly taskId: string;
  readonly turns: readonly AdvanceTurnLog[];
  /**
   * 停下来的原因。四个值各自对应【不同的下一步】，所以不能压成一句「跑完了」：
   *  · human_seat —— 去审批收件箱点一下；
   *  · stalled —— 角色自己在等 / 状态机少一条边，看最后一轮的 note；
   *  · limit —— 撞上 maxTurns，通常意味着上面两条判据其中之一被改坏了；
   *  · gone —— 任务在跑的过程中消失了（有人删库/换库），不是一种成功。
   */
  readonly stopped: "human_seat" | "stalled" | "limit" | "gone";
  readonly totalCostCents: number;
  /** 落库后的最终状态。 */
  readonly status: string;
}

/**
 * 跑一轮并留痕。留痕失败【不中断循环】：状态与账都已经提交了，
 * 因为一行日志写不进去就把剩下的活儿扔掉，等于让 CEO 重跑整轮去补那一行。
 */
async function oneTurn(
  rt: EngineRuntime,
  dispatch: (o: { taskId: string; nowMs: number; maxBudgetUsd: number }) => Promise<DispatchResult>,
  o: AdvanceOptions,
  turn: number,
): Promise<AdvanceTurnLog> {
  const now = (o.nowMs ?? Date.now)();
  const res = await dispatch({ taskId: o.taskId, nowMs: now, maxBudgetUsd: o.maxBudgetUsd });
  const rec = await rt.recordTurn({
    taskId: res.taskId,
    role: res.role,
    sessionId: res.sessionId,
    costCents: res.costCents,
    ok: res.seat === "agent",
    nowMs: now,
  });
  const log: AdvanceTurnLog = { turn, res, recorded: rec.recorded, why: rec.why };
  o.onTurn?.(log);
  return log;
}

/**
 * 推进一条任务直到推不动。
 *
 * dispatch 由调用方给（而不是这里 import makeDispatch）是为了让这一层能在
 * 【假 dispatch】上测「什么时候停」—— 那正是它全部的逻辑。真装配走 makeRuntime。
 */
export async function advance(
  rt: EngineRuntime,
  dispatch: (o: { taskId: string; nowMs: number; maxBudgetUsd: number }) => Promise<DispatchResult>,
  o: AdvanceOptions,
): Promise<AdvanceResult> {
  const maxTurns = o.maxTurns ?? 12;
  // 0 / 负数 / 小数当场拒。放着不管的话循环【一次都不跑】就返回，
  // 而返回值看起来像「推完了」—— 那正是本仓反复抓的形状：一个参数写错，
  // 结果是一句听起来成功的谎话（同 assertCents / assertParamCount 那条立场）。
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) {
    throw new Error(
      "advance: maxTurns 必须是正整数（实到 " + String(o.maxTurns) + "）。" +
      "0 会让循环一次都不跑而返回一个【看起来跑完了】的结果。",
    );
  }
  const turns: AdvanceTurnLog[] = [];
  // 任务不在了就不进循环：dispatch 会为一条不存在的任务抛错，而那句抛错
  // 到了 CLI 会变成「执行失败」，比「任务不存在」难懂一档。
  if (rt.deps.loadTask(o.taskId) === null) {
    return { taskId: o.taskId, turns, stopped: "gone", totalCostCents: 0, status: "" };
  }
  let stopped: AdvanceResult["stopped"] = "limit";

  for (let i = 0; i < maxTurns; i++) {
    const log = await oneTurn(rt, dispatch, o, i + 1);
    turns.push(log);
    const r = log.res;

    if (r.seat === "human") {
      stopped = "human_seat";
      break;
    }
    // 【同一轮没动就停】。判据是 res.moved 而不是「状态与上一轮相同」：
    // 后者会把「A→B→A 的合法往返」也判成停，而 moved 是 dispatch 自己给的结论
    // （它知道这一轮到底有没有写下一条边）。
    if (!r.moved) {
      stopped = "stalled";
      break;
    }
    // 走到这里说明这一轮真的推进了。循环【跑满】maxTurns 都没停 ⇒ stopped 保持 limit。
  }

  const last = turns[turns.length - 1];
  const status = last?.res.status ?? "";
  const totalCostCents = turns.reduce((s, t) => s + t.res.costCents, 0);
  return { taskId: o.taskId, turns, stopped, totalCostCents, status };
}

/** 一句人话的收尾。CLI 与桌面端都读这一句，所以措辞只有一份。 */
export function describeAdvance(r: AdvanceResult, task: DispatchTask | null): string {
  const head =
    "任务 " + r.taskId + " 停在 " + r.status + "（跑了 " + r.turns.length + " 轮，花 " + r.totalCostCents + " 美分）";
  const last = r.turns[r.turns.length - 1];
  const why = last === undefined ? "（一轮都没跑起来）" : "：" + last.res.note;
  const tail =
    r.stopped === "human_seat"
      ? "\n下一步在你手上：那一格是【人类席位】，推进它的是审批收件箱里的一次点击。"
      : r.stopped === "stalled"
        ? "\n角色自己说还没做完，或它的动作对不上 §7.1 的任何一条边。再推一次 hub work 即可。"
        : r.stopped === "limit"
          ? "\n撞上轮数上限。通常是「不动就停」那条判据没生效 —— 检查一下最后几轮的 moved。"
          : "\n任务在库里找不到了。";
  return head + why + tail + (task === null ? "" : "（负责角色：" + task.role + "）");
}
