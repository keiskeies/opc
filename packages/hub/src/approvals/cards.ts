/**
 * 审批卡片的**创建**路径（Task 2.6 那块缺口里唯一不靠装依赖就能补的一半）。
 *
 * ── 这一篇补的是本仓最大的一处「写入方缺席」────────────────────────
 * 写之前的 grep（当场跑的，不是回忆；0013 §10.1 是它的第一次实测）：
 *   · `grep -rn "INSERT INTO approvals"` 在所有 src 目录下 ⇒ **0 命中**
 *   · 全仓唯一的写是两条 **UPDATE**（http/real-deps.ts 的 CLAIM_APPROVAL_SQL、
 *     policy/auto-approve.ts 的 CLAIM_APPROVAL_FOR_AUTO_SQL）。UPDATE 不创建行。
 *   · `INSERT INTO approvals` 只出现在测试文件的**夹具**里。
 * 后果不是「少一行数据」，是**一整串东西被伪装成已完成**：
 * `GET /tasks` 能列任务、`POST /approvals/:id` 状态码对、审计也不重复 —— 而
 * `approvals` 那一行永远不存在，所以那次点击走的是 `approvalOutcome` 的 404 分支，
 * 「CEO 批了一次」这件事在生产里从未发生过（real-deps.ts 文件头量的就是这个）。
 * 连带失效的还有四处**已经写好、正在空转**的东西：
 * `countSimilarApprovals`（恒 0）、`role-memory` 的战略档判据（恒
 * `APPROVAL_TYPE_UNKNOWN`）、`decideEscalation` 那张草好的卡（无落点）、
 * §7.3/§7.4 那两张卡（无创建方）。
 *
 * ── 为什么这一半能离线做，而「自动推进任务」那一半不能 ──────────────
 * 创建卡片 = 一条 INSERT + 一条 ApprovalRequired 事件，两者今天都有现成机制。
 * 「卡片被创建出来」这件事**已经可达**：`POST /tasks` 就建一行
 * `CHARTER_PENDING` 的任务（app.ts 的 createTask），图**本来就没在跑**（0025 §6），
 * 所以这里不需要有人调 `decideEscalation`，也不需要 @langchain。
 * 而「批了之后任务真的往下走」需要图，那是 0010 §7 挂在 CEO 名下的那一格。
 *
 * ── 三条口径，每条都对应一种会被静默造出来的假象 ──────────────────
 * 1. **只建【规格】§9.2 那种决策卡**。【规格】§7.3 的异常卡与 §7.4 的预算卡是**信息性**卡片，
 *    `approval_type` 那五个取值没有一个表达「信息性」，而且它们**没有按钮语义**
 *    （`POST /approvals/:id` 的 resume 三值是「同意打回这条决策」，不是「知道了」）。
 *    建出来就是一张**永远批不掉**的卡 —— 这个判断 patrol.ts 文件头第 2 条已经写全了，
 *    本篇**沿用**它而不是推翻。
 * 2. **卡片是事实，不是待办提示**。一张卡一旦写下就进 append-only 的事件流，
 *    所以「这张卡代表哪个决定」必须有**稳定身份**（`draft.key`），否则同一个决定
 *    会被建出第二张、第三张，而收件箱的待批数从此恒大于真值。去重见下。
 * 3. **`timeout_at` 落库但不执行**。见 `timeoutAtMs` 上方那段 —— 那是一处**我替
 *    CEO 拍的产品决定**，因此它必须显眼到在代码、决策文档、INDEX 三处都能撞见。
 *
 * ── 去重的判据为什么必须是 partial unique index 而不是「先查再插」────
 * `INSERT ... ` 前面挂一条 `SELECT ... WHERE status = 'pending'` 看着等价，实际不是：
 * 两次调用可以交错在「都查到没有」与「都插进去」之间。WriteQueue 把**事务**串行化，
 * 所以只要两个创建方走同一个队列，这个交错今天就不成立 —— 但这条依赖是**运行期装配**
 * 给的，不是数据库给的：`cli.ts` 那条路、测试里手搓的连接、以及哪天有人直接
 * `new WriteQueue` 都不在这条链上（0025 §2 实测：第二个写者空闲时照写）。
 * 于是判据落在 DDL 上：`UNIQUE(task_id, card_key) WHERE card_key IS NOT NULL`
 * 由 SQLite 保证，`INSERT` 撞键 ⇒ 这条不建、返回 false。
 * **注释拦不住的东西，不要只用注释拦**（【规格】§8.2 第 4 条同一条思路）。
 */

import { randomUUID } from "node:crypto";
import {
  type ApprovalCardDraft,
  approvalCardDraftSchema,
  APPROVAL_STATUS_PENDING,
  type TimeoutBehavior,
} from "@opc/contracts";
import {
  assertParamCount,
  assertSingleStatement,
  type Writer,
} from "../db/write-queue.js";
import type { EscalationResult } from "../graph/routing/escalation.js";
import type { DomainEvent } from "../events/bus.js";
import { appendAudit, serializePayload } from "../events/recorder.js";
import { requireScopeDb } from "../checkpoint/tx-scope.js";

/**
 * 「同一张卡」的稳定身份 = `card_key` 这一列的值（见 migration 0004）。
 *
 * 建卡方传它（例如一次超步的 checkpoint id、一个 gate 的 `taskId:gate:round`），
 * 而不是本模块自己算一个：能唯一标识「哪一次决定」的信息**只有调用方知道**，
 * 而本模块猜出来的任何一份（按 task_id？按 summary？）都会把**两个不同的决定**
 * 合成一张卡 —— 那比重复卡片更糟：重复是吵，合并是**吞掉一个决定且不留痕迹**。
 *
 * 不传 ⇒ 不去重。这是**允许**的（有些调用方天生没有可复用的身份），
 * 但它必须是个显式选择：省略这个字段就等于声明「我接受重复卡片」。
 */
/** 表里的 `card_key` 列由此建成（见 migration 0004）。 */
export type NewCardDraft = ApprovalCardDraft & {
  readonly taskId: string;
  /** 建这张卡的审批类型。见 APPROVAL_TYPES 那张表的取值口径。 */
  readonly approvalType: ApprovalType;
  readonly cardKey?: string;
  /**
   * 「为什么升上来」（`decideEscalation` 的 `reason` / `also`）。
   *
   * 它是**升级卡专用**的附加信息，落进 `parameters.escalation`（见 parametersFor）。
   * 为什么不并进 `ApprovalCardDraft`：那份契约是 `.strict()` 的（【规格】§9.2 三行 + 三按钮
   * 是产品口径，多一个键必须过一次 review），而 reason 是**升级这一类**卡才有的维度。
   * 为什么不丢：它是【规格】§8.3 那条北极星（「CEO 看到的每件都真需要 CEO」）唯一能统计的
   * 依据 —— 丢了它，收件箱只能答「有几张卡」，答不了「因为什么」。
   */
  readonly escalation?: {
    readonly reason: string;
    readonly also?: readonly string[];
  };
  /**
   * ⚠ 这里**故意没有** `note` 字段，也**不写** `approvals.decision_note`：
   * 那一列的意思是「做决定时附的意见」（CLAIM_APPROVAL_SQL 写它），
   * 建卡时写进去 = 一行「还没决定」的卡片带着一条**决策附件**，
   * 而下面 insertCard 那条「决策侧四列必须是 NULL」的不变式当场被自己破坏。
   * 建卡方要交代的背景走 `summary` / `parameters`（【规格】§9.2 那两行本来就是给它的位置）。
   */
};

/**
 * `approvals.approval_type` 的取值表。
 *
 * ⚠ **0025 §8.2 记的是「这一格要 CEO 定」，本篇按 CEO 授权自行拍了，原文不删。**
 * 拍的是**第二个候选**（原文：「加一个通用的 escalation 值 + 把 reason 放 payload」，
 * 那也是 0025 里写了「我倾向」的那个）。理由与代价：
 *  - **不膨胀枚举**：`EscalationReason` 今天有 6 个值，逐个加进 `approval_type`
 *    会让两个枚举从此必须同步维护，而它们回答的本来就是两个问题
 *    （「这是什么审批」vs「为什么升上来」）。
 *  - **reason 是自由维度**：新增一条升级原因不该是一次 schema 变更。
 *  - **代价照记**：按类型统计时，`escalation` 这一格会**混装**六种完全不同的事由，
 *    要按原因统计必须去解析 `parameters.escalation_reason`（JSON 文本，
 *    没有索引，10 万卡片量级上是全表扫）。今天没有任何代码做这件事；
 *    要做的那天应当加一条表达式索引，口径与 `db/kind.ts` 的 `kindOf` 同源。
 *
 * `strategic` 这一格**不是**本篇造的：`role-memory.ts` 的战略档判据当场读的就是
 * `approvalType === "strategic"`（0016 写的，此前恒为 UNKNOWN）。
 */
export const APPROVAL_TYPES = [
  "charter",
  "strategic",
  "irreversible_action",
  "budget_override",
  "meeting_escalation",
  "escalation",
] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];

/**
 * 卡片初始状态取自 contracts 的 `APPROVAL_STATUS_PENDING`（这里再导出一次，
 * 让建卡这条路与列表/认领那两条读的是**同一个**字面量）。
 * `pending` 是 CLAIM_APPROVAL_SQL 那条 `WHERE status = 'pending'` 的分母，不是风格选择。
 */
export { APPROVAL_STATUS_PENDING };

/**
 * ⚠⭐ **本篇唯一一处我替 CEO 拍的产品决定：`timeout_at` 有值，而没有任何执行者。**
 *
 * 这里**会**把到期时刻写进那一列（以前连值都没有），而**不会**因为到期做任何事：
 * 不自动批准、不自动打回、不升级、不提醒。整仓仍然没有一处 `approvals` 的超时扫描。
 *
 * 为什么这是我能拍的：0025 §8.3 把「超时之后该做什么」列为需要 CEO 决定的产品行为，
 * 而 CEO 已授权我按产品逻辑自行判断。**拍下来的答案是「什么都不做」**，理由：
 *  - `auto_approve` 意味着机器替人点头。规格 §9.3 把它限定在「仅限可逆事项」，
 *    而「可逆」的判定来自 policy/engine 的风险分级，那份分级今天**没有生产写入方**
 *    （它只在超步里被调）—— 也就是说今天连「这条是可逆的」都还没有可信出处。
 *  - `auto_reject` 意味着 CEO 吃个午饭回来，一晚上攒的卡片被打回一半。
 *    规格 §19.1 的效率承诺是「20 秒完成一次审批」，不是「不在时机器替你拒绝」。
 *  - `escalate` 需要一个「更深审阅流程」的落点，那是【规格】§10 的会议机制，Phase 3 才有。
 * 所以**值先落库**（它是将来任何策略的事实依据，且写了不可改），
 * **动作留空**。这不同于「忘了接」：全仓没有 `timeout_at` 的扫描方这件事
 * 是**写下来的性质**，出现在这一处代码、0026 §2、以及 INDEX 的等待区三处。
 *
 * 一旦接执行者，**必须先回答**「提醒算不算一次升级」——
 * patrol.ts 文件头那条「不要拿 15 分钟的节奏去催一个人类审批」的告警疲劳判断
 * 在那个设计上同样成立，不要绕过它。
 */
export const DEFAULT_TIMEOUT_HOURS = 8;

/** 设计文档 B.6 那份卡片示例用的是 `timeout_hours`；这里沿用同一个名字与默认值。 */
export function timeoutAtMs(nowMs: number, timeoutHours: number): number {
  // 非负有限：NaN 会让 `timeout_at` 落成 NaN ⇒ SQLite 存成 NULL，
  // 于是「没设超时」与「超时算错了」在库里长得一模一样（0018 那三条「检查器自己抛」同族）。
  if (!Number.isFinite(timeoutHours) || timeoutHours < 0) {
    throw new Error(
      "timeoutHours 必须是非负有限数（实到 " + String(timeoutHours) + "）",
    );
  }
  return nowMs + Math.round(timeoutHours * 3_600_000);
}

/**
 * `parameters` 落库前的样子：契约那张 schema 是 `.strict()`，
 * 所以升级原因这类附加信息**不能塞进** `ApprovalCardDraft`（会被 parse 拒），
 * 只能在**落库这一步**并进去。
 *
 * 为什么要落而不是丢：`decideEscalation` 返回的 `reason` 与 `also` 是
 * 「为什么升上来」的唯一出处，而【规格】§8.3 那条北极星（CEO 看到的每件都真需要 CEO）
 * 要靠它统计。丢了它，收件箱就只能回答「有几张卡」，答不了「因为什么」。
 * 键名用 `escalation` 包一层而不是平铺，是为了**不与契约那四个键撞名** ——
 * 撞了就是契约字段被实现侧悄悄改写。
 */
export function parametersFor(
  draft: ApprovalCardDraft,
  extra?: { readonly reason?: string; readonly also?: readonly string[] },
): Record<string, unknown> {
  const base: Record<string, unknown> = { ...draft.parameters };
  if (extra?.reason !== undefined) {
    base["escalation"] = {
      reason: extra.reason,
      ...(extra.also && extra.also.length > 0 ? { also: [...extra.also] } : {}),
    };
  }
  return base;
}

/**
 * 卡片 id 的生成点。
 *
 * 与 `events.id` 一样由服务端发号，不接受调用方传入：卡片 id 是
 * `POST /approvals/:interruptId` 的路径段，也是 `ApprovalRequired` 事件的
 * `interruptId`（= 审计的 `target`）。让调用方传 = 让调用方能拿同一个 id
 * 建两张卡，那两条审计事件的 `target` 会 join 到同一张卡上。
 */

/**
 * 只有 `card_key` 非空时才受那条 partial unique index 约束。
 * `card_key IS NOT NULL` 这一半写在 DDL 里，不在这里重复 —— 重复一份就会漂移。
 */
export const INSERT_CARD_SQL =
  "INSERT INTO approvals (id, task_id, approval_type, summary, parameters, " +
  "recommendation, recommendation_source, timeout_behavior, timeout_at, status, " +
  "decided_by, decided_at, decision_note, card_key, created_at) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

/** 建卡结果。`created: false` 的两种成因见 insertCard 的注释。 */
export type InsertCardResult = {
  readonly created: boolean;
  readonly approvalId: string;
  /** 事件是否真的落库。`created === false` 时恒为 false（一条都不写）。 */
  readonly recorded: boolean;
  /**
   * `false` 的成因。两种都不是错误：
   *  - `"duplicate"` —— `(task_id, card_key)` 撞了那条 partial unique index，
   *    即这个决定**已经有一张待批的卡**。
   *  - `undefined` —— 建成了。
   * 第三种理论上的成因「task_id 外键不存在」**刻意不兜**：那是一行引用了
   * 不存在任务的任务，属于**编程错误**，让它抛。卡片是审计对象，
   * 悄悄丢掉一张卡比一次带原文的抛错贵得多。
   */
  readonly skipped?: "duplicate";
};

/**
 * 建一张卡。**必须在事务作用域里调**（`queue.node(() => txScope(..., () => insertCard(db, …)))`
 * 或直接 `queue.tx(...)`）。
 *
 * 三条不变量：
 *  ① **一张卡 + 一条事件，同一个事务**。只写成一半 ⇒ 库里有一行 pending 而审计没有，
 *     或者反过来：SSE 推了一张点不开的卡（`GET /tasks/:id` 那套读法会在
 *     `decide` 那里 404）。这是【规格】§6.3 同一条理由，也是 auto-approve 那边
 *     「卡片认领与审计必须同事务」的同一条。
 *  ② 撞去重键 ⇒ **一条都不写**，返回 `{created:false, skipped:"duplicate"}`。
 *     判据是**捕获约束冲突**而不是先查后插（文件头那段）。
 *  ③ 事件走 `appendAudit` 而不是 recorder：本模块的事务由调用方拥有，
 *     与 `applyDecision` 同一个形状。`seq` 交回调用方在**提交之后** publish。
 */
export function insertCard(
  db: Parameters<typeof appendAudit>[0],
  draft: NewCardDraft,
  o: { readonly nowMs: number; readonly recommendationSource?: string },
): InsertCardResult {
  // 契约校验在**这里**做，不在调用方做。理由与 app.ts 把 zod 放在 handler 里同源：
  // 校验散在调用方 = 少调一次就少一道检查，而这张表是 append-only 的下游读法唯一的依据。
  // .strict() 的三条硬约束正是【规格】§9.2 的产品口径（三行都在、按钮只有三个、
  // 「推荐，非决定」那个标志位必须为 true），绕过它等于绕过【规格】§8.2 第 4 条。
  //
  // ⚠ 喂给它的**只有卡片那四个字段**，不是整个 draft：schema 是 `.strict()`，
  // 而 taskId / approvalType / cardKey 是【落库用的列】、不是卡片内容 ——
  // 直接把 draft 传进去，`.strict()` 会因三个「未知键」整体拒绝，
  // 于是每一次建卡都抛「不符合契约」。第一版就是这么写的，
  // 而它一直绿到有人真的建一张卡为止 —— 契约校验把自己校验掉了，是最难读的一种红。
  const parsed = approvalCardDraftSchema.safeParse({
    summary: draft.summary,
    parameters: draft.parameters,
    evidence_refs: draft.evidence_refs,
    buttons: draft.buttons,
  });
  if (!parsed.success) {
    throw new Error(
      "审批卡片不符合【规格】§9.2 契约：" +
        parsed.error.issues
          .map((i) => i.path.join(".") + " " + i.message)
          .join("；"),
    );
  }
  // 取值检查跑在【raw 值】上，不是跑在收窄后的类型上：TS 的 ApprovalType 在运行时不存在，
  // 而这张表是 append-only 审计库的下游读法（role-memory 的战略档判据、
  // countSimilarApprovals 的同类口径）唯一的依据。让一个错值写进去，
  // 症状是「这条卡片在两类统计里都不出现」—— 静默少一类，正是本仓最贵的那一类。
  const approvalType: string = draft.approvalType;
  if (!(APPROVAL_TYPES as readonly string[]).includes(approvalType)) {
    throw new Error(
      "approval_type 取值非法（实到 " + String(approvalType) + "）。候选：" +
        APPROVAL_TYPES.join(" / ") +
        " —— 加一格的口径见本文件 APPROVAL_TYPES 上方（0025 §8.2 由 0026 拍板）。",
    );
  }
  const approvalId = randomUUID();
  const params: unknown[] = [
    approvalId,
    draft.taskId,
    approvalType,
    parsed.data.summary,
    serializePayload(parametersFor(draft, draft.escalation)),
    parsed.data.parameters.recommendation,
    // recommendation_source：【规格】§9.2 说这一栏由「总监层生成」。没有出处时**不编一个**，
    // 落 NULL —— 这一列的用途正是「这条推荐是谁给的」，编一个就是把推荐伪装成有来源。
    o.recommendationSource ?? null,
    parsed.data.parameters.timeout_behavior as TimeoutBehavior,
    timeoutAtMs(o.nowMs, DEFAULT_TIMEOUT_HOURS),
    APPROVAL_STATUS_PENDING,
    // 决策侧四列在建卡时**必须**是 NULL：CLAIM_APPROVAL_SQL 的
    // `WHERE status = 'pending'` 依赖的是这个初值，非 NULL 的初值会让那张
    // 「已经批过的卡」看起来像待批（收件箱计数恒不对的直接来源）。
    null,
    null,
    null,
    draft.cardKey ?? null,
    // 创建时刻。approvals 那十三列里【原本一个创建时刻都没有】（0001），
    // 于是「这张卡等了多久」问不出答案 —— 补这一列的理由与「为什么不回填存量」
    // 写在 0004 第二列那一段。
    o.nowMs,
  ];
  assertSingleStatement(INSERT_CARD_SQL);
  assertParamCount(INSERT_CARD_SQL, params);

  try {
    db.prepare(INSERT_CARD_SQL).run(...(params as never[]));
  } catch (e) {
    if (isUniqueCardKeyViolation(e)) {
      return { created: false, approvalId, recorded: false, skipped: "duplicate" };
    }
    throw e;
  }

  return {
    created: true,
    approvalId,
    recorded: true,
  };
}

/**
 * SQLite 的约束冲突识别。
 *
 * 判据是**消息文本**，这一条需要理由而不是嫌弃：`node:sqlite` 的 `Error` 上
 * 只有 `errcode`（`SQLITE_CONSTRAINT_UNIQUE = 2067`）在部分版本上会带，
 * 而**部分**意味着不能只靠它 —— 只认 errcode 的实现，在没有那个字段的环境上
 * 会把重复卡片当成一次 500 抛给调用方。所以两者都认，且**只认 UNIQUE**：
 * 外键冲突（`SQLITE_CONSTRAINT_FOREIGNKEY`）仍然抛，理由见 insertCard 第 ② 条。
 */
export function isUniqueCardKeyViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  if (/FOREIGN KEY constraint failed/iu.test(msg)) return false;
  if (typeof e === "object" && e !== null && "errcode" in e) {
    const code = (e as { readonly errcode?: unknown }).errcode;
    if (typeof code === "number" && code === SQLITE_CONSTRAINT_UNIQUE) return true;
  }
  return /UNIQUE constraint failed: approvals\.task_id, approvals\.card_key/u.test(
    msg,
  );
}

/** SQLite 结果码。写死而不是从别处 import：本仓没有任何 SQLite 常量模块。 */
export const SQLITE_CONSTRAINT_UNIQUE = 2067;

/**
 * 事件构造。**只在这里**拼 `ApprovalRequired`，因为它有两个下游：
 * `events`（回放与 `role-memory` 读的那一行）与 SSE 投影（收件箱计数 +1）。
 * 两份各写一遍就会漂移，而漂移的症状是「库里有一张卡而界面上没有」。
 *
 * `payload` 的形状是 `role-memory.ts` 读的那一份：它靠 `payload.kind` 区分
 * 「有人被要求批准」与「有人做了决定」（recorder 把整个 DomainEvent 连 kind 存进
 * payload），所以 `kind` 这个键**必须**在 —— 少它，那条区分逻辑会把这张卡
 * 当成一次**决定**放进角色的 few-shot 记忆（它失败方向是「保留」，不会报错）。
 */
export function approvalRequiredEvent(
  taskId: string,
  approvalId: string,
  draft: ApprovalCardDraft,
  approvalType: string,
): ApprovalRequiredEvent {
  return {
    kind: "ApprovalRequired",
    taskId,
    interruptId: approvalId,
    payload: {
      kind: "ApprovalRequired",
      approval_type: approvalType,
      summary: draft.summary,
      evidence_refs: [...draft.evidence_refs],
    },
  };
}

/**
 * `DomainEvent` 里 `ApprovalRequired` 那一支。
 *
 * 用 Extract 而不是自己写一份形状：自己写的那份会在 bus.ts 加字段时**静默不匹配**
 * （本模块照样编译过，而事件里少一个键）—— 与 recorder 那条
 * 「KIND_TO_ACTION 必须覆盖全部 kind」是同一族漂移，靠派生而不是靠记得。
 */
export type ApprovalRequiredEvent = Extract<
  DomainEvent,
  { readonly kind: "ApprovalRequired" }
>;

/**
 * `decideEscalation` 的结论 → 一张可落库的升级卡。
 *
 * 这一层存在的理由不是「转个字段」：`decideEscalation` 是纯函数（它不写库，
 * 理由写在它文件头：升级判定必须可穷尽测试），而它草好的那张卡**此前没有任何落点** ——
 * 全仓 `ApprovalCardDraft` 的引用只有它自己那一处构造。0013 §10.1 量的
 * 「approvals 在 src 里零 INSERT」缺的就是这一段。
 *
 * 三件事在这里定，都不该散到调用方：
 *  1. `approval_type` 固定 `"escalation"`（0025 §8.2 的拍板，见 APPROVAL_TYPES 上方）；
 *  2. reason 走 `escalation` 而不是塞进 summary —— summary 是给人读的那一行，
 *     把枚举名混进去之后就没法统计了（「按原因数卡片」变成中文匹配）；
 *  3. `cardKey` 由调用方给。**这里不拿 reason 当 key**：同一个任务可能因为
 *     同一个原因升两次（两次不同的不可逆动作），按 reason 去重会吞掉第二次。
 */
export function draftFromEscalation(
  s: { readonly taskId: string },
  r: Extract<EscalationResult, { readonly escalate: true }>,
  cardKey?: string,
): NewCardDraft {
  return {
    taskId: s.taskId,
    approvalType: "escalation",
    ...(cardKey === undefined ? {} : { cardKey }),
    summary: r.card.summary,
    parameters: r.card.parameters,
    evidence_refs: r.card.evidence_refs,
    buttons: r.card.buttons,
    escalation: { reason: r.reason, also: r.also },
  };
}

/**
 * 建卡 + 落审计，一个事务。返回事件与结果，**不 publish**（提交之后由调用方发）。
 *
 * 这是给「手上已经有 WriteQueue」的调用方的那一层（serve / 巡检 / CLI 都是）。
 * 超步内部的调用方**不要用它** —— 那时事务已经开着，应当直接调 `insertCard` +
 * `appendAudit`，与 `applyDecision` 同一个形状。
 */
export async function createCard(
  w: Writer,
  draft: NewCardDraft,
  o: { readonly nowMs: number; readonly recommendationSource?: string },
): Promise<{
  readonly result: InsertCardResult;
  readonly event: ApprovalRequiredEvent | null;
  readonly seq: number | null;
}> {
  return await w.node(() => {
    const db = requireScopeDb("createCard");
    const result = insertCard(db, draft, o);
    if (!result.created) {
      // 撞了去重键 ⇒ 这个决定已经有一张待批的卡。一条事件都不写：
      // 写一条就等于在审计里说「这里又发生了一次需要批准」，而没发生。
      return { result, event: null, seq: null };
    }
    const event = approvalRequiredEvent(
      draft.taskId,
      result.approvalId,
      draft,
      draft.approvalType,
    );
    const seq = appendAudit(
      db,
      {
        taskId: draft.taskId,
        // actor 是 system 而不是 ceo / 某个角色：卡片是**系统提出的一次请求**，
        // 不是任何人的决定。署人的名会让 role-memory 把它读成一次决定（它筛的是
        // action='approval'，而它区分请求与决定靠 payload.kind —— 署名错了不影响
        // 那一条，但会影响「这条是谁做的」那一列的可信度，而它是记忆的分桶依据）。
        actorType: "system",
        actorId: "hub",
        action: "approval",
        target: result.approvalId,
        payload: event.payload,
      },
      () => o.nowMs,
    );
    return { result, event, seq };
  });
}
