/**
 * 任务落到【人席】时，那张等着被点的卡片。
 *
 * ── 这一格补的是什么（实测，0046 §1）─────────────────────────────────
 * dispatch 会把任务合法地推到 ESCALATED_TO_CEO（【规格】§7.2 步骤 8，那一步界面表现
 * 写的就是「审批收件箱出现**琥珀色**卡片」），approveCard 又会把它推到 FINAL_REVIEW
 * （步骤 9）。两处分居两处代码而都【只写状态边，不建卡】。实测原话：
 *
 *   dispatch 一轮 pass（顶层）⇒ status = ESCALATED_TO_CEO，卡片数 = 0，
 *                                  审计只有 state_change/TaskStateChanged 一行。
 *
 * 后果不是「收件箱少一张卡」那么轻。CEO 推进一个任务的**唯一**入口是
 * `POST /approvals/:id/decide`，而那个 id 只能从 `GET /approvals` 拿；
 * `approveCard` 也是按 approvalId 认领。⇒ **一条走到 ESCALATED_TO_CEO 的任务，
 * 全仓没有任何东西能把它带出去**：状态说「等人」，而那个人连按钮都找不到。
 * 这比 0044 那格「收件箱是空的」更硬 —— 那一格缺的是生产者，这一格是
 * **状态已经宣布"等人了"而人手上的入口不存在**。
 *
 * 于是本篇的立场与 0043 那条同一条：不把这件事写成「调用方记得建一张卡」，
 * 而是让【状态边与卡片在同一个事务里】—— 于是「任务在人席而收件箱没有东西」
 * 在库里【不可表达】，而不是「很可能不会发生」。
 *
 * ── 为什么卡片键是「那一条状态边的 events.id」────────────────────────
 * 去重键 `UNIQUE(task_id, card_key)`（迁移 0004）**不看 status**。所以：
 *  · 键里【不含轮次/状态】⇒ 第二次升到 CEO 时撞键 ⇒ 不建卡 ⇒ 这一格又空了
 *    （正是 §8.3 允许的「同一任务多次升级」，而那一次升级是真需要人决定的）；
 *  · 键里【含时刻】⇒ 同一秒内的两次到达合成一张（同一轮里可能写两条边，见下）；
 *  · ⇒ 用【那一次到达本身的身份】：落到人席那一条状态边的 events.id。
 *    它是全局唯一、单调、且天然【一次到达一个】的：同一轮里如果真写了两条边
 *    （chain：EVIDENCE_SUBMITTED → IN_REVIEW 那一族），两条边的 seq 不同，
 *    而只有【最后那条】的落点才是人席，所以只有一个键 —— 不需要另外发明一个计数器。
 *
 * ⚠ 这个键的代价写在测试里：卡片身份依赖 events.id，所以【任何重写状态边的路径】
 *   （将来若有）都会造出新的一格而不是复用旧的 —— 那正是我们要的行为
 *   （每一次到达都值得一次独立的决定），但它意味着"去重"挡不住"重复到达"，
 *   挡住重复到达的是【状态机】（不在人席就不能再升一次）。
 *
 * ── 哪些人席要建卡 ──────────────────────────────────────────────────
 * 从 HUMAN_EDGES 的键【派生】而不是手抄一份名单：新增一个人类席位时，
 * 默认值应当是「它会自动有一张卡」，而手抄名单的默认值是「它静默地没有」。
 * 唯一排除的是 CHARTER_PENDING —— 那一格的卡有【另一个】生产者（engine/charter.ts
 * 起草章程提案，由 serve/charter-pump.ts 补），再建一张就是同一件事两张卡，
 * 而 CEO 会看到两条"批准章程"（重复比缺失吵，但这里更坏：点了其中一张，
 * 另一张永远点不动，因为任务已经不在那一格了）。
 */
import type { TaskState } from "../graph/status.js";
import { appendAudit, KIND_TO_ACTION } from "../events/recorder.js";
import { currentScope } from "../checkpoint/tx-scope.js";
import {
  approvalRequiredEvent,
  insertCard,
  type ApprovalRequiredEvent,
  type NewCardDraft,
} from "../approvals/cards.js";
import type { EscalationReason } from "@opc/contracts";
import { CHARTER_CARD_KEY } from "./charter.js";
import { HUMAN_EDGES } from "./dispatch.js";

/** 卡片键的前缀。稳定值，改了等于给同一批任务换一套身份（会把旧卡变成"没见过的到达"）。 */
export const SEAT_CARD_KEY_PREFIX = "seat";

/**
 * 「这一格要不要由本模块补一张卡」。
 *
 * 判据来自 HUMAN_EDGES（谁坐在那一格）减去 CHARTER_PENDING（那张卡有别人在生产），
 * 而【不是】来自 seatOf —— seatOf 问的是「有没有 agent 出边」，那会把
 * APPROVED_UPWARD 也算成"人席"（它两张表里都没有出边，是【规格】§7.1 的死路，
 * 给它建一张 approve 卡等于假装它有出路）。
 */
export function needsSeatCard(status: TaskState): boolean {
  return status !== "CHARTER_PENDING" && HUMAN_EDGES[status] !== undefined;
}

/** 那一次到达的卡片身份。见文件头那节：用状态边的 events.id，不用时刻、不用状态名。 */
export function seatCardKey(status: TaskState, arrivalSeq: number): string {
  return SEAT_CARD_KEY_PREFIX + ":" + status + ":" + String(arrivalSeq);
}

/**
 * 「这张卡是不是【当前这一格】自己的那张入口卡」。
 *
 * ── 为什么要有这一判（实测，0046 §5）───────────────────────────────
 * 补卡带来一个此前不存在的形状：一条任务上可以【同时】躺着两张 pending 卡。
 * 探针原话（dev 试了一条越权边被拦下留下拦截卡，任务随后合法升到 CEO 那一格）：
 *
 *   pending 卡 = 2 ["handoff-block:dev->dev", "seat:ESCALATED_TO_CEO:4"]
 *   点【旧的那张】⇒ outcome=decided，ESCALATED_TO_CEO → FINAL_REVIEW
 *                  剩下 pending = ["seat:ESCALATED_TO_CEO:4", "seat:FINAL_REVIEW:7"]
 *
 * 也就是说 approveCard 只认「卡片属于这条任务 + 卡片是 pending」，**不认这张卡属于哪一格**。
 * 于是 CEO 点的是「dev 想把活儿交给 dev，这一跳机器不认」，而机器把任务从
 * 「等你裁决升级」推进到了「进终审」—— 她回答的是 A 问题，任务按 B 问题动了。
 * 更要紧的是【那张真正在等的卡还躺着】：收件箱的待批数不减反增（多了一张新的终审卡），
 * 而审计里写着「CEO 批准了升级」—— 她没有批准过升级。
 *
 * ⚠ 这一格【不是补卡引入的】，是补卡让它【可达】的。在此之前一条任务上只可能有一张
 *   pending 卡（拦截卡那一族的键不含轮次，重复尝试撞键；而人席根本没有卡），
 *   所以「点旧卡推新边」在没有第二张卡之前无从发生。0044 §9.1 记的「card_key 带轮次」
 *   一旦去做，同一格会出现多张卡，这一格就从"可达"变成"天天发生"。
 *
 * ── 判据是【优先】而不是【白名单】──────────────────────────────────
 * 另一种写法是「只有 seat:<当前格>:* 这张卡能推进当前格」—— 那是白名单，更严，
 * 但它会把【这一发之前落库的存量任务】变成【永久批不动】：那些任务停在人席而
 * 没有补出来的卡（补卡是这一发才开始写的），白名单等于对它们说"谁都不能推进"。
 * 我不能为了判据整洁，造出一格「CEO 看着一张待批卡而一个按钮都点不动」——
 * 那正是本篇在修的那个症状的镜像。所以判据是：
 *  · 当前格【有】自己的入口卡 ⇒ 只有它能推进这一格（其余卡只能被打回/暂缓，不能推进）；
 *  · 当前格【没有】自己的卡 ⇒ 沿用旧行为（谁都能推进）。
 * 残余（存量任务、以及将来某个不建卡的人席）登记在 0046 §5，不写成已修完。
 *
 * CHARTER_PENDING 那一格认的是 charter.ts 的键：那张卡的生产者是它而不是本模块
 * （见 needsSeatCard 的排除），所以"它自己的入口卡"由它自己定义。
 */
export function isSeatOwnCard(status: TaskState, cardKey: string | null): boolean {
  if (cardKey === null) return false;
  if (status === "CHARTER_PENDING") return cardKey === CHARTER_CARD_KEY;
  return cardKey.startsWith(SEAT_CARD_KEY_PREFIX + ":" + status + ":");
}

export interface PendingCardLite {
  readonly id: string;
  readonly cardKey: string | null;
}

/**
 * 一条任务【所有待批】的卡里，属于「当前这一格自己的入口卡」的那些。
 *
 * 非空 = 这一格有它自己的卡在等着 ⇒ 只有【这里返回的那些 id】能推进这一格。
 * 空 = 这一格没有自己的卡（补卡之前落库的存量任务、或某个不建卡的人席）⇒ 调用方沿用旧行为。
 *
 * ⚠ 这里【刻意不做】"取最近那张"那种收窄，所以调用方判的是【成员关系】而不是
 *   "等于某一张"：后者需要一个"哪张最新"的次序，而手上那份读法
 *   （`PENDING_CARDS_SQL`：`ORDER BY created_at, id`）里 created_at 同一轮相同、
 *   id 是 randomUUID() 发的 TEXT —— 那个次序是【随机的】。按它挑"最新那张"会得到
 *   一条看起来确定、实际随机的判定（我第一版在这里写了 `ORDER BY id` 取最后一张，
 *   与 cards 表 id 随机这件事撞个正着，见 0046 §5）。成员关系不依赖次序：
 *   同一格真有多张自己的卡时，它们【都】能推进这一格，那是对的 ——
 *   它们问的是同一格的决定，而认领那一步的 `WHERE status='pending'` 保证只有第一次算数。
 */
export function ownCardsOf(status: TaskState, pending: readonly PendingCardLite[]): PendingCardLite[] {
  return pending.filter((c) => isSeatOwnCard(status, c.cardKey));
}



/**
 * 「为什么升上来」的枚举值。
 *
 * 走到人席的两条路（顶层审阅通过、CEO 批过升级之后进终审）在【规格】§8.3 那六个值里
 * 对应的都是 `outside_decision_scope`：不是预算、不是证据不足、不是置信度低，
 * 而是「这件事超出了这一层的权限，所以要你拍」。
 * ⚠ 这一格【刻意不】由 agent 说了算：agent 报的是 pass/blocked，
 *   而"超出谁的权限"由组织树与状态机决定（dispatch 那条 topmost 判据），
 *   让 agent 直接填一个 EscalationReason 等于让它给自己的事定性。
 */
const SEAT_ESCALATION_REASON: EscalationReason = "outside_decision_scope";

export interface SeatCardRequest {
  readonly taskId: string;
  readonly status: TaskState;
  /** 把任务落到这一格的那一条状态边的 events.id。 */
  readonly arrivalSeq: number;
  /** 那一条边的 note（人话），它会成为卡片摘要里 CEO 读到的那一句。 */
  readonly why: string;
  readonly nowMs: number;
}

export interface SeatCardOutcome {
  /** null = 这一格不需要卡（不是人席 / 章程那一格另有生产者），或撞了去重键。 */
  readonly event: ApprovalRequiredEvent | null;
  /**
   * 那条审计行消费掉的 events.id。
   *
   * ⚠ 必须由本模块带出去而【不是】让调用方去猜：outgoing 那份列表要的是
   * 「消费了 seq 的每一行」，少一条就是在活着的 SSE 连接上挖一个洞（0010 §4），
   * 而洞的表现是每次推进都把前端连接标脏。调用方手里只有【状态边】那一个 seq，
   * 拿它填这一格会产出一条 seq 重复的广播 —— 看起来是"都发出去了"，实际上是
   * 那条卡片事件从来没存在过。所以 seq 与 event 在类型上是一对：event 非 null 时 seq 非 null。
   */
  readonly seq: number | null;
  /** true = 建成了；false 有两种成因，看 event 分辨。 */
  readonly created: boolean;
  /** 一句人话，含【没建成】的成因。 */
  readonly note: string;
}

/**
 * 建那张卡 + 落审计。**必须在调用方的事务里**（与 dispatch 的状态边同一个 node()）。
 *
 * ⚠ 这一条【当场判】而不是只写在注释里（0046 §4）：本模块收的是【一条 DatabaseSync】，
 * 而调用方手里同时有【事务内那条】（requireScopeDb 给的）和【队列那条】（writeConnection()）。
 * 传错的那一支不报错、不崩，只是 autocommit：卡片落库而状态边回滚 ⇒
 * 收件箱躺着一张指向【agent 席位】的卡，CEO 点下去拿到「这一格没有出边」。
 * 那是全仓认定最贵的一类（各自都自洽的静默），而 cards.ts 文件头那条纪律说的正是它：
 * 「注释拦不住的东西，不要只用注释拦」。判据用【对象同一性】而不是"在不在事务里"：
 * 后者答不了「写的是哪条连接」—— 同一进程里两条写连接各自都能有事务。
 *
 * 三条与 approvals/cards.ts 同源的形状，一条都不自己发明：
 *  ① 事件走 approvalRequiredEvent（两份下游会漂移）；
 *  ② 审计 payload 存 `evt.payload` 而【不是】`{...evt}`（dispatch 那条踩过的两源分叉：
 *     createCard 落内层那份，按 approval_type 数待批的读法照它读）；
 *  ③ actor 是 system/hub —— 卡片是系统提出的一次请求，不是任何人的决定，
 *     署人名会污染 role-memory 的分桶依据。
 *
 * 撞去重键 ⇒ 一条都不写（insertCard 自己判），返回 created:false。
 * 这一支今天应当不可达（一次到达只写一条边、只调一次），留着是因为它**便宜**而
 * 它的替代（先查后插）正是 cards.ts 文件头否掉的那种写法。
 */
export function mintSeatCard(
  db: Parameters<typeof appendAudit>[0],
  o: SeatCardRequest,
): SeatCardOutcome {
  const scope = currentScope();
  if (scope === undefined || scope.db !== db) {
    throw new Error(
      "mintSeatCard: 必须在调用方的事务里、且用的是【那条事务的】连接。" +
        (scope === undefined
          ? "当前不在任何事务作用域内（node() / txScope() 里）—— 直接写会 autocommit。"
          : "传入的连接不是当前事务那条连接 —— 写到另一条连接上同样会 autocommit。") +
        " 这一发不能退化成「先提交卡片、再提交状态边」：中间失败会留下一张指向错格子的卡，" +
        " 而它点下去推不动任何东西（0046 §4）。",
    );
  }
  if (!needsSeatCard(o.status)) {

    return {
      event: null,
      seq: null,
      created: false,
      note: "状态 " + o.status + " 不需要本模块补卡。",
    };
  }
  const draft: NewCardDraft = {
    taskId: o.taskId,
    approvalType: "escalation",
    cardKey: seatCardKey(o.status, o.arrivalSeq),
    // 摘要带着【那一句为什么】而不是只说"等你批"：CEO 在收件箱里要在几秒内决定，
    // 「审阅通过且已到顶层：覆盖率 92%，3 个 P2 缺陷」是可决策的信息，
    // 「任务需要你批准」不是（decideEscalation 文件头同一条口径）。
    summary: o.status + " 等你决定：" + o.why,
    parameters: {
      impact_scope: "任务 " + o.taskId + "，状态 " + o.status,
      irreversible: false,
      recommendation: seatRecommendation(o.status),
      recommendation_is_not_decision: true,
      timeout_behavior: "escalate",
    },
    evidence_refs: ["task:" + o.taskId + "/evidence"],
    // 三颗按钮的长名字（APPROVAL_BUTTONS 那套词表）。写错会被 .strict() 在建卡那一刻拒 ——
    // 方向是对的：卡片一侧的词表错在建卡时，比错在 CEO 点下去拿到 422 要好。
    buttons: ["approve", "reject_with_comment", "defer_deep_review"],
    escalation: { reason: SEAT_ESCALATION_REASON },
  };
  const res = insertCard(db, draft, { nowMs: o.nowMs });
  if (!res.created) {
    return {
      event: null,
      seq: null,
      created: false,
      note: "卡片没建：这一次到达的键（" + String(draft.cardKey) + "）已经有一张卡了。",
    };
  }
  const evt = approvalRequiredEvent(o.taskId, res.approvalId, draft, draft.approvalType);
  const seq = appendAudit(
    db,
    {
      taskId: o.taskId,
      actorType: "system",
      actorId: "hub",
      action: KIND_TO_ACTION.ApprovalRequired,
      target: res.approvalId,
      payload: evt.payload,
    },
    () => o.nowMs,
  );
  return {
    event: evt,
    seq,
    created: true,
    note: "已在收件箱放一张卡（" + res.approvalId + "）等 CEO 点。",
  };
}

/**
 * 推荐语一律带「推荐，非决定」（【规格】§9.2 原文要求，参数里那个字面量字段是它的落地）。
 *
 * 两个人席的下一步**不一样**所以不合成一句：
 *  · ESCALATED_TO_CEO 要拍的是「这些已知的问题要不要放行」（【规格】§7.2 步骤 8）；
 *  · FINAL_REVIEW 要拍的是「交付不交付」。
 * 合成一句的后果不是难看，是 CEO 在两种不同的决定前读到同一句建议。
 */
function seatRecommendation(status: TaskState): string {
  return status === "FINAL_REVIEW"
    ? "推荐：核对验收标准逐条有没有被满足，再决定交付；交付之后进入 ARCHIVED 就只是归档（推荐，非决定）"
    : "推荐：先看清单里那几条未尽事项，能进下一次迭代的就别让它卡住交付（推荐，非决定）";
}
