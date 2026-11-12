/**
 * 人席的【写路径】：CEO 点一次批准，任务真的往前走一格。
 *
 * ── 这一发补的是什么 ─────────────────────────────────────────────────
 * dispatch 会停在三个人坐的格子（CHARTER_PENDING / ESCALATED_TO_CEO / FINAL_REVIEW），
 * 并且每一处都写着「推进它的是审批收件箱里的一次点击」。HUMAN_EDGES 那张表把
 * 每条 approve 能走到哪也算好了，humanEdge() 把它查出来 —— 然后【全仓没有一个人调它】
 * （grep 的命中只有表本身、那句提示、和 dispatch.test.ts 那条「落点合法」的表扫描）。
 *
 * 于是引擎路线今天的真实形状是：任务能跑到 CHARTER_PENDING，而【没有任何东西能把它
 * 带出去】。一个 CEO 下发想法之后拿到的是「等人不等 agent」，然后永久停在那里 ——
 * 这就是「一个人的一人公司」最核心的那一次交互（§7.2 步骤 2）缺席。
 * 0013/0014/0020/0031/0033/0040 抓了二十几篇的都是这一族：判定写完、测试全绿、
 * 运行时没人走到。这一篇是那一族的下一格。
 *
 * ── 为什么不直接复用 http/real-deps.ts 的 applyDecision ───────────────
 * 它做的是「认领那张卡 + 落一条 CEO 决策审计」，写得很好，但它【不动任务】：
 * 那条路上任务的推进交给图恢复（makeResumeGraph → graph.invoke），
 * 而引擎路线没有图。只调它的后果是卡片变 approved、tasks.status 原地不动、
 * 审计里多一条批准 —— 三样各自都自洽，这正是本仓认定最贵的那种静默。
 * 所以这里是【一个事务写三样】：认领卡片 + 写状态边 + 两条审计，
 * 形状照 dispatch 的写路径（同一条守卫式 UPDATE、同一套 events），
 * 认领那一步的 WHERE 条件照抄 applyDecision 的幂等承重写法。
 *
 * ── 为什么【不】起图、也不 import 任何 langchain ──────────────────────
 * 同 engine/work.ts 文件头：一条能独立跑的路径不该被另一条路径的依赖拖下水。
 *
 * ── 只实现「批准」，不实现「打回 / 暂缓」 ────────────────────────────
 * 不是偷懒，是 §7.1 只给人席画了 approve 这一条出边（HUMAN_EDGES 的类型
 * Partial<Record<"approve", …>> 就是这件事的编译期表达）。reject_with_comment 落到
 * 哪个状态【规格没定】，已登记在 real-deps.ts §4.1 的等待区。在那里拍板之前，
 * 这里宁可对那一颗按钮报「这条出边不存在」，也不猜一条边写进 append-only 的审计库。
 */
import type { HubWriter } from "../db/write-queue.js";
import { assertParamCount, assertSingleStatement } from "../db/write-queue.js";
import type { DatabaseSync } from "node:sqlite";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import { appendAudit, KIND_TO_ACTION } from "../events/recorder.js";
import type { DomainEvent } from "../events/bus.js";
import { APPROVAL_STATUS_PENDING } from "../approvals/cards.js";
import type { TaskState } from "../graph/status.js";
import { humanEdge, seatOf, WRITE_EDGE_SQL } from "./dispatch.js";
import {
  mintSeatCard,
  needsSeatCard,
  ownCardsOf,
  type PendingCardLite,
} from "./seat-card.js";

/**
 * 认领那张待批的卡片。
 *
 * 与 http/real-deps.ts 的 CLAIM_APPROVAL_SQL 是【同一条 SQL】，这里是第二份文本。
 * 为什么不 import 那一份：它在 http/ 那一层，而那一层迟早要长出不属于这里的依赖
 * （它自己就 import 了 token 那一族与 org 提交）。两处文本漂移的后果不是崩，是
 * 「一条路挡得住重复点击、另一条挡不住」，所以把它钉成断言（approve.test.ts 里
 * 那条逐字比对）而不是靠记得。
 *
 * `WHERE status = ?`（绑 APPROVAL_STATUS_PENDING）是幂等承重那一步，理由照抄那边：
 * 两次读之间可以有一次并发点击，那时「查出来是 pending」与「写下去」不原子，
 * 而 events 是 append-only —— 第二条决策事件写下去删不掉，回放会重建出
 * 「这个审批批过两次」。把判定压进 WHERE 之后，并发那一支 changes=0，
 * 我们在写下【任何】事件之前就知道没抢到。
 */
export const CLAIM_CARD_SQL =
  "UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? " +
  "WHERE id = ? AND status = ?";

/** 卡片被点掉之后的三种结局。 */
export const CARD_DECIDED_STATUS = ["approved", "rejected", "deferred"] as const;
export type CardDecidedStatus = (typeof CARD_DECIDED_STATUS)[number];

/**
 * 三颗按钮的取值。与 contracts 的 RESUME_VALUES / APPROVAL_BUTTONS 同一组三个词
 * （那两份的注释解释了【为什么是这三颗、为什么不能有第四颗】—— 一键全批会
 * 让 §8.2 第 4 条被 UI 自己绕过）。这里给一个类型别名而不是 import：
 * approveCard 的调用方（CLI / 桌面 IPC）拿到的字符串本来就该由 contracts 校验过，
 * 这一层要的是【不再依赖 http 那一族】，不是自立一套词表。同值由测试钉住。
 */
export type CardButton = "approve" | "reject_with_comment" | "defer_deep_review";

/**
 * 三颗按钮 → 卡片状态。
 *
 * 与 http/real-deps.ts 的 STATUS_BY_RESUME 同值（那边也是三条）。这里之所以要有自己
 * 的一份而不是 import：那张表住在 http 层，而它把「按钮 → 状态」与「状态 → 图恢复」
 * 绑在同一个模块里；引擎路线要的只有前半截。两份的【同值】由测试钉住
 * （approve.test.ts 那条 STATUS_BY_BUTTONtoEqual(STATUS_BY_RESUME)）。
 *
 * ⚠ 今天【只有 approve 这一条真的能推进任务】（HUMAN_EDGES 只有 approve 那一条出边）。
 * 另外两条落进 rejected / deferred 之后任务原地不动，这是规格缺口不是这里的取舍，
 * 返回值里的 edgeExists 就是为了让调用方能把这件事说出来而不是含糊过去。
 */
export const STATUS_BY_BUTTON: Readonly<Record<CardButton, CardDecidedStatus>> = {
  approve: "approved",
  reject_with_comment: "rejected",
  defer_deep_review: "deferred",
};

/**
 * 打回必须带理由。判据与 contracts 的 approvalDecisionRequestSchema 那条 superRefine
 * 【同一条】，而这里必须在【写库之前】判：
 * reject_with_comment 而 note 为空 ⇒ 产出方拿到的是「被拒了，为什么不知道」，
 * 而 §8.3 要的恰好是「产出方看到的每一件都得可执行」。写进 append-only 的
 * decision_note 之后再补就补不进去了（那一行只能再写一条新的，两条并存）。
 */
export function requiresNote(button: CardButton): boolean {
  return button === "reject_with_comment";
}

/** 卡片当前那一行的形状（只取这一步要的几列）。 */
export interface CardRow {
  readonly id: string;
  readonly taskId: string;
  readonly status: string;
  readonly approvalType: string;
  readonly cardKey: string | null;
}

const LOAD_CARD_SQL =
  "SELECT id, task_id, status, approval_type, card_key FROM approvals WHERE id = ?";

/**
 * 任务那一行只取这一步要的四列。
 *
 * assigned_role 是【读出来原值回填】的，不是要改它（见下面那条 UPDATE 的注释）：
 * WRITE_EDGE_SQL 会写 current_node / assigned_role 两列，少回填一次就等于
 * 让一次批准顺手改一次组织分配。
 */
const LOAD_TASK_STATE_SQL =
  "SELECT status, assigned_role, graph_version FROM tasks WHERE id = ?";

/**
 * 事务内读那条任务上【所有待批】卡片的 (id, card_key)。
 *
 * 必须在事务里、用【那条事务的】连接读而不能用 `w.readConnection()`：读连接是
 * 另一条 WAL 连接，它看到的可能是【这一笔之前】的快照 —— 用旧快照判"谁是当前格的卡"，
 * 判完就是一次基于过期认知的决定（与本文件 LOAD_TASK_STATE_SQL 同一条理由：
 * 那一条也是从 requireScopeDb 那条连接读的，而注释里写着"取库里那一行而不是调用方传的"）。
 *
 * SQL 复用文件底部那条 PENDING_CARDS_SQL（同源），不另写一份 —— 两份"什么叫待批"
 * 漂移的结局是：一处把已批掉的算进来，收件箱计数从此恒大于真值（0026 §9 那一族）。
 */
function pendingCardKeys(db: DatabaseSync, taskId: string): PendingCardLite[] {
  const rows = db.prepare(PENDING_CARDS_SQL).all(taskId, APPROVAL_STATUS_PENDING) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r["id"] ?? ""),
    cardKey: r["card_key"] === null || r["card_key"] === undefined ? null : String(r["card_key"]),
  }));
}


export interface ApproveOptions {
  readonly taskId: string;
  readonly approvalId: string;
  /** CEO 按的那颗按钮。 */
  readonly button: CardButton;
  readonly nowMs: number;
  /** 决策的附言（打回时那句理由）。落 decision_note 与 state_snapshot。 */
  readonly note?: string;
}

export interface ApproveResult {
  readonly outcome:
    /** 全部落库：卡片已决策 + 任务状态边（有合法出边时）+ 事件已广播。 */
    | "decided"
    /** 卡片不在库里。【不写任何东西】—— 与 applyDecision 同一条不变量。 */
    | "card_missing"
    /** 卡片指着一条不在库里的任务。同样什么都不写（一致性坏了，不是并发）。 */
    | "task_missing"
    /** 卡片已经批过/拒过/暂缓过（含并发点击）。同样不写任何东西。 */
    | "already_decided"
    /** 卡片挂在另一条任务上。拒绝，因为审计的 task_id 只能有一个答案。 */
    | "card_belongs_to_other_task"
    /**
     * 那张卡片问的【不是任务当前这一格】，而当前这一格【已经有】自己的入口卡在等着。
     * 0046 §5：补卡之后「一条任务上两张 pending 卡」是正常状态，于是"点旧卡推新边"
     * 从无从发生变成可达，而它的后果是「回答 A 问题而任务按 B 问题动」+
     * 审计里留下一条她没做过的批准（append-only，删不掉）。【什么都不写】。
     */
    | "stale_card"
    /**
     * 打了回而没给理由。判在【开事务之前】：这不是「抢不到所以不写」，是这次请求
     * 本身不成立，不该让它碰到写连接（同 parseWorkArgs 把参数错排在 cmdWork 之前）。
     * 返回而不是抛：CLI 要打的是人话，不是一句 stack；而 HTTP 那一侧本来就有
     * 422 那条路（contracts 的 superRefine），这条只服务 CLI/桌面这两个直连入口。
     */
    | "note_required";
  /** 落库后的卡片状态。 */
  readonly cardStatus: CardDecidedStatus;
  /** 决策前的任务状态。 */
  readonly from: TaskState | "";
  /** 决策后的任务状态。没走边时与 from 相同。 */
  readonly to: TaskState | "";
  /** 这一颗按钮在这个状态上到底有没有出边。false = 卡片被记掉了而任务没动。 */
  readonly edgeExists: boolean;
  /**
   * 这一发【没查】的东西，写出来而不是不提：
   * 认领卡片与推进状态都在【同一个事务】里，所以不存在「半套」；但这一发
   * 不校验那张卡是在【任务当前这一版组织图】上起草的。理论上「卡是 v3 时建的、
   * 任务此刻在 v4」，而批准照走。影响面比组织图门控小（人席的出边不看组织图），
   * 但它是 §18.4 的一个已知未覆盖点，登记在 0041。
   */
  readonly orgVersionUnchecked: true;
  /** 本轮消费掉的每一条 (事件, seq)（提交后已广播）。空 = 什么都没写。 */
  readonly published: readonly { readonly event: DomainEvent; readonly seq: number }[];
  /**
   * 一句人话：这一步走到了哪 / 为什么没走到。与 DispatchResult.note 同位同义。
   * 别与入参那个 note（CEO 写的理由）混起来 —— 那是【决策的附件】，这里是【给终端
   * 用户看的那一行】。两个名字撞上是有代价的（读代码的人会以为输出把输入原样带回来），
   * 但沿用 DispatchResult 的叫法换来的是【三个模块同一套读法】，
   * 于是留着并在这里说明，而不是另起一个名字制造第四种叫法。
   */
  readonly note: string;
}

/**
 * 把一次人类决策落成事实。
 *
 * 事务里有【四】件事，缺任何一半都是本仓反复量的那个形状：
 *  ① 认领卡片（守卫式 UPDATE）—— 抢不到就整体不写；
 *  ② 决策那条审计（actor=human/ceo，action='approval'）；
 *  ③ 状态边（守卫式 UPDATE，带 AND status=? —— 决策算出来那条边基于的状态可能已经变了）；
 *  ④ 状态变化那条审计。
 * ② 与 ③④ 在同一个事务里，所以「卡片已批而任务没动」在库里【不可表达】。
 * （http 那条路上这两半是分开的，因为它靠图恢复推进 —— 而恢复失败被那边显式接受
 * 并写明了理由。这里没有图，所以没有接受这个缺口的余地。）
 *
 * 广播在提交之后（w.node 返回即已提交），逐条广播 ②④ 两条 —— 少广播任何一条都是
 * 在活着的 SSE 连接上挖一个 seq 空洞（0010 §4，与 dispatch 同源）。
 */
export async function approveCard(
  w: HubWriter,
  o: ApproveOptions,
  /** 必填，理由与 dispatch 的 publish / real-deps 的 applyDecision 完全同源。 */
  publish: (e: DomainEvent, seq: number) => void,
): Promise<ApproveResult> {
  const now = o.nowMs;
  const status = STATUS_BY_BUTTON[o.button];

  // 【开事务之前】判。这一条与事务里那几条不是一类：那几条是「库里此刻不允许」，
  // 这一条是「这次请求本身不成立」，它不该碰到写连接（碰了就白拿一次
  // BEGIN IMMEDIATE，把别人的一次正常决策排在后面排队 —— WriteQueue 是全局串行的）。
  // 判据同 contracts 的 approvalDecisionRequestSchema 那条 superRefine，而 HTTP 那边
  // 有 422 兜着、CLI/桌面直连这一层没有，所以缺这一道时它的缺席表现是：
  // 一张 rejected 的卡 + decision_note 为 NULL + 产出方不知道为什么被拒。
  const trimmed = o.note?.trim() ?? "";
  if (requiresNote(o.button) && trimmed === "") {
    return {
      outcome: "note_required",
      cardStatus: status,
      from: "",
      to: "",
      edgeExists: false,
      orgVersionUnchecked: true,
      published: [],
      note:
        "打回必须带理由（--note）。没有理由的打回到产出方那里就是「被拒了，为什么不知道」，" +
        "而 append-only 的 decision_note 事后补不进去。什么都没写。",
    };
  }
  // 纯空白的理由（"   "）与没有理由是【同一件事】，但不能悄悄变成 NULL 落库：
  // 那样 CEO 会以为系统把她那句话存下来了。这里判空、那里判缺，两支同一句人话。
  const storedNote = trimmed === "" ? null : trimmed;

  const wrote = await w.node(() => {
    const db = requireScopeDb("engine.approve");
    const card = db.prepare(LOAD_CARD_SQL).get(o.approvalId) as
      | Record<string, unknown>
      | undefined;
    if (card === undefined) return { kind: "card_missing" as const, status };

    const cardTaskId = String(card["task_id"] ?? "");
    if (cardTaskId !== o.taskId) {
      return { kind: "card_belongs_to_other_task" as const, status, from: "" as const, to: "" as const };
    }
    // 只认 pending。已经决策过的卡片【一条审计都不写】：写一条就等于在 append-only
    // 的历史里说「这个人又决定了一次」，而没发生（同 applyDecision 第 ① 条不变量）。
    if (String(card["status"] ?? "") !== APPROVAL_STATUS_PENDING) {
      return { kind: "already_decided" as const, status };
    }

    const taskRow = db.prepare(LOAD_TASK_STATE_SQL).get(o.taskId) as
      | Record<string, unknown>
      | undefined;
    if (taskRow === undefined) {
      // 卡片说它属于这条任务而任务不在 —— 这是一致性坏了，不是并发。
      // 整体不写：认领一张指向虚空的任务的卡片，会留下一条批不掉的批准记录。
      return { kind: "task_missing" as const, status };
    }
    const from = String(taskRow["status"] ?? "") as TaskState;
    // 负责角色原值回填（不改它，理由见下面 WRITE_EDGE_SQL 那条 UPDATE）。
    // 取【库里那一行】而不是调用方传的：传一份错的就是一次静默覆盖。
    const keeper = String(taskRow["assigned_role"] ?? "");

    /**
     * ⭐ 「这张卡问的是当前这一格吗」—— 0046 §5 那一发实测补上的判据。
     *
     * 上面那三道检查回答的是「这张卡【属于】这条任务吗」，而它们对
     * 「这张卡属于这条任务的【哪一格】」一字未提。一条任务上同时躺着两张 pending 卡
     * 从今天起是正常状态（拦截卡 + 补出来的席位卡），于是那个缺口从"无从发生"变成"可达"：
     * 实测点【旧的那张】拦截卡，机器把任务从 ESCALATED_TO_CEO 推到了 FINAL_REVIEW，
     * 而真正在等的那张卡【仍然躺着】。⇒ CEO 回答的是 A 问题，任务按 B 问题动了，
     * 且审计里写着「CEO 批准了升级」—— 她没有批准过升级（append-only，事后删不掉）。
     *
     * 判在【认领之前】：认领之后再判会留下一条「已决策而任务没动」的卡片，
     * 那与这一发要防的那一格（收件箱有东西而推不动）是同一个症状，只是换了成因。
     *
     * 只在 approve 这一支判（`o.button === "approve"`）：reject / defer 不推进任何状态，
     * 挡掉它们会让 CEO【连"这条不是我此刻要答的"都表达不出来】——
     * 一张过期的拦截卡从此既推不动也关不掉，永远挂在待批数里。
     *
     * ⚠ 判据是【成员关系】而"取最新那张"那种写法不用：见 ownCardsOf 那条，
     *   手上那份读法的次序是随机的（created_at 同轮相同 + id 是 UUID），
     *   靠它挑一张会得到一条看起来确定、实际随机的判定。
     */
    const own = ownCardsOf(from, pendingCardKeys(db, o.taskId));
    const isOwn = own.some((c) => c.id === o.approvalId);
    if (own.length > 0 && !isOwn && o.button === "approve") {
      return {
        kind: "stale_card" as const,
        status,
        from,
        to: from,
        ownCount: own.length,
        ownKey: own[0]?.cardKey ?? "（读不到卡片键）",
      };
    }


    // 先认领，再动任务。顺序反过来的话，「卡片已被别人抢先批掉」这一支会留下一条
    // 【没有批准记录的状态变化】，而它是回放里最难查的那种缺口。
    const claimParams: unknown[] = [
      status,
      // decided_by 存【谁】而不是【决定了什么】（同 applyDecision：status 已回答后者）。
      "ceo",
      now,
      storedNote,
      o.approvalId,
      APPROVAL_STATUS_PENDING,
    ];
    assertSingleStatement(CLAIM_CARD_SQL);
    assertParamCount(CLAIM_CARD_SQL, claimParams);
    const claimed = db.prepare(CLAIM_CARD_SQL).run(...(claimParams as never[])) as {
      changes: number | bigint;
    };
    if (Number(claimed.changes) === 0) {
      // 抢输了（同一张卡在两个窗口各点一次）。回滚是免费的：这一支还没写任何行。
      return { kind: "already_decided" as const, status };
    }

    const published: { event: DomainEvent; seq: number }[] = [];
    const decidedPayload = { approvalId: o.approvalId, resume: o.button, by: "engine" };
    const decidedSeq = appendAudit(
      db,
      {
        taskId: o.taskId,
        actorType: "human",
        actorId: "ceo",
        // 'approval'：CEO 点按钮是审批决策，不是门控判定（review_decision）。
        // 从 KIND_TO_ACTION 同源取值而不是手写字面量（dispatch 里那条同源理由）。
        action: KIND_TO_ACTION.ApprovalDecided,
        // target = 卡片 id：这是「这张卡被谁在什么时候点掉」的唯一定位手段。
        target: o.approvalId,
        payload: decidedPayload,
        createdAt: now,
        ...(storedNote === null ? {} : { stateSnapshot: { note: storedNote } }),
      },
      () => now,
    );
    published.push({
      event: {
        kind: "ApprovalDecided",
        taskId: o.taskId,
        interruptId: o.approvalId,
        decision: status,
      },
      seq: decidedSeq,
    });

    const edge = o.button === "approve" ? humanEdge(from, "approve") : null;
    if (edge === null) {
      return {
        kind: "decided" as const,
        status,
        from,
        to: from,
        edgeExists: false,
        published,
        publishedNote:
          "卡片已记为 " + status + "，但 " + from + " 上【没有】这一颗按钮对应的出边（HUMAN_EDGES 只有 approve）。",
      };
    }

    const edgeEvent: DomainEvent = { kind: "TaskStateChanged", taskId: o.taskId, from, to: edge.to };
    const stateSeq = appendAudit(
      db,
      {
        taskId: o.taskId,
        // actor 是 human/ceo 而不是 agent：这条边是人走的。写 agent 的话，
        // 「回放里这一步是谁推的」会答错，而那是 §12.7 第 2 层（审计链）问的问题。
        actorType: "human",
        actorId: "ceo",
        action: "state_change",
        target: edge.to,
        payload: { ...edgeEvent, summary: edge.why },
        createdAt: now,
      },
      () => now,
    );
    published.push({ event: edgeEvent, seq: stateSeq });

    // 守卫式 UPDATE：基于过期状态（决策期间有人改了任务）时整笔回滚。
    // 不写状态边而只写卡片 = 「批过了而任务没动」；而带守卫的失败必须是抛（回滚），
    // 不能是静默跳过 —— 静默的那一支与上面那条「没出边」在返回值上长得一样。
    const edgeParams: unknown[] = [
      edge.to,
      // current_node 在引擎路线上装的是【负责角色】（语义变更记在 0041）。
      // 人席这一格【不改负责角色】：三条出边的下一跳由任务上已有的那一格决定
      // （CHARTER_PENDING 的负责角色就是起草章程的那个），在这里改它等于让
      // CEO 这一颗按钮顺手做组织分配，而那不在它的语义里。
      // 于是 current_node 与 assigned_role 都原值回填 —— 回填而不是少绑参数：
      // 少绑在 node:sqlite 上【不报错、直接写 NULL】（write-queue 文件头第 4 条，
      // 那两列还是 NOT NULL），症状是批一次就把负责角色抹掉一次。
      keeper,
      keeper,
      // 人的一格不烧 token：写 0（COALESCE 那一列照旧累加 0）。
      0,
      now,
      o.taskId,
      from,
    ];
    const info = db.prepare(WRITE_EDGE_SQL).run(...(edgeParams as never[])) as {
      changes: number | bigint;
    };
    if (Number(info.changes) !== 1) {
      throw new Error(
        "approveCard: 状态边被守卫拦下 —— 任务 [" + o.taskId + "] 在写 " + from + " → " + edge.to +
          " 时状态已不是 " + from + "（实到 changes=" + Number(info.changes) + "）。整笔回滚，" +
          "卡片退回待批：不能让 CEO 看见「已批准」而任务原地不动。",
      );
    }

    /**
     * ⭐ 落点若还是【人类席位】，同事务补下一张卡。
     *
     * 今天真走到这一发的只有一条路：ESCALATED_TO_CEO → FINAL_REVIEW（【规格】§7.2
     * 步骤 8 → 步骤 9）。少了它，CEO 点完「批准上线」之后任务停在 FINAL_REVIEW，
     * 而那一格【同样】只能靠一张卡推进 —— 于是"批了一步就再也点不动下一步"，
     * 交付那一步（→ DELIVERED）永远发生不了。这一格比 dispatch 那一格更隐蔽：
     * 前者的症状是"收件箱空"，后者的症状是"我明明批过了，怎么还没交付"。
     *
     * 键取的是【刚才那条状态边】的 seq（stateSeq），与 dispatch 那一侧同一个身份规则：
     * 一次到达一个身份。CHARTER_PENDING 被 needsSeatCard 排除 —— 那张卡的生产者是
     * charter.ts / 章程泵，在这里再建一张会让同一格出现两张"批准章程"。
     */
    if (needsSeatCard(edge.to)) {
      const seat = mintSeatCard(db, {
        taskId: o.taskId,
        status: edge.to,
        arrivalSeq: stateSeq,
        why: edge.why,
        nowMs: now,
      });
      if (seat.event !== null && seat.seq !== null) {
        published.push({ event: seat.event, seq: seat.seq });
      }
    }

    return {
      kind: "decided" as const,
      status,
      from,
      to: edge.to,
      edgeExists: true,
      published,
      publishedNote: edge.why,
    };
  });

  if (wrote.kind === "card_missing") {
    return {
      outcome: "card_missing",
      cardStatus: wrote.status,
      from: "",
      to: "",
      edgeExists: false,
      orgVersionUnchecked: true,
      published: [],
      note: "卡片不存在（id = " + o.approvalId + "），什么都没写。",
    };
  }
  if (wrote.kind === "task_missing") {
    return {
      outcome: "task_missing",
      cardStatus: wrote.status,
      from: "",
      to: "",
      edgeExists: false,
      orgVersionUnchecked: true,
      published: [],
      note:
        "卡片挂在 [" + o.taskId + "] 上而那条任务不在库里 —— 一致性坏了，什么都没写。" +
        "这一发不能只批卡片：那会留下一条【批掉了却推不动任何东西】的批准记录。",
    };
  }
  if (wrote.kind === "already_decided") {
    return {
      outcome: "already_decided",
      cardStatus: wrote.status,
      from: "",
      to: "",
      edgeExists: false,
      orgVersionUnchecked: true,
      published: [],
      note: "那张卡片此前已被决策（或这次是重复点击），什么都没写。",
    };
  }
  if (wrote.kind === "card_belongs_to_other_task") {
    return {
      outcome: "card_belongs_to_other_task",
      cardStatus: wrote.status,
      from: "",
      to: "",
      edgeExists: false,
      orgVersionUnchecked: true,
      published: [],
      note: "卡片挂在另一条任务上，不能拿它推进 [" + o.taskId + "]。",
    };
  }
  if (wrote.kind === "stale_card") {
    return {
      outcome: "stale_card",
      cardStatus: wrote.status,
      from: wrote.from,
      to: wrote.to,
      edgeExists: false,
      orgVersionUnchecked: true,
      published: [],
      note:
        "那张卡片问的不是 [" + wrote.from + "] 这一格，而这一格已经有它自己的卡在等着（" +
        String(wrote.ownKey) + "，共 " + String(wrote.ownCount) + " 张）。点它不会推进任务——" +
        "任务此刻在 [" + wrote.from + "]，要批的是那张卡，不是这张过期的。什么都没写。",
    };
  }
  // 提交成功之后才广播（回滚的话那些行根本没存在过 —— §5.8）。
  for (const p of wrote.published) publish(p.event, p.seq);
  return {
    outcome: "decided",
    cardStatus: wrote.status,
    from: wrote.from,
    to: wrote.to,
    edgeExists: wrote.edgeExists,
    orgVersionUnchecked: true,
    published: wrote.published,
    note: wrote.publishedNote,
  };
}

/** 一条任务上【待批】的卡片（收件箱与 CLI 都要读这一发）。 */
export const PENDING_CARDS_SQL =
  "SELECT id, task_id, status, approval_type, card_key FROM approvals " +
  "WHERE task_id = ? AND status = ? ORDER BY created_at ASC, id ASC";

/**
 * 这条任务此刻卡在【哪张卡】上。找不到返回 null。
 *
 * 读的是 status='pending' 而不是「最近一张」：收件箱要显示的是【还欠着一个决定】的那些，
 * 而把已批掉的算进来会让「还有 N 件等你」这个数永远不减（0026 §9 那一族：
 * 一个数读错，界面就长期说一件不成立的事）。
 */
export function pendingCards(w: HubWriter, taskId: string): CardRow[] {
  const rows = w
    .readConnection()
    .prepare(PENDING_CARDS_SQL)
    .all(taskId, APPROVAL_STATUS_PENDING) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r["id"] ?? ""),
    taskId: String(r["task_id"] ?? ""),
    status: String(r["status"] ?? ""),
    approvalType: String(r["approval_type"] ?? ""),
    cardKey: r["card_key"] === null || r["card_key"] === undefined ? null : String(r["card_key"]),
  }));
}

/** 人席那句提示（driver / CLI / 桌面端共用一份措辞）。 */
export function humanSeatHint(status: TaskState): string {
  const seat = seatOf(status);
  if (seat === "agent") return "这一格由 agent 推进，不需要人来点。";
  const e = humanEdge(status, "approve");
  return e === null
    ? status + " 是人坐的格子，而 §7.1 没给它出边（现状：MEETING_REQUIRED / BLOCKED 就是这种死路）。"
    : status + " 等你批准，批准后进入 " + e.to + "：" + e.why;
}
