/**
 * 审批卡片的**读侧**（`GET /approvals` 那一条列表查询 + `GET /approvals/:id` 那一条点查）。
 *
 * ── 为什么单独一个文件而不是写进 http/app.ts ────────────────────────
 * app.ts 里 `readTasks` 那条读法只有三行 WHERE 可用，跟着 handler 走没问题。
 * 这一条不一样：它要解析 `parameters` 里那一格升级原因，而**解析规则是产品口径**
 * （「按原因统计今天升了几件」，【规格】§8.3），不是 HTTP 的细节。
 * 与 `replay/query.ts` 同一个分法：**判定的形状住在模块里，HTTP 只是它的一个入口**
 * （0013 §6 记的就是这条落点偏离：检索住在 hub 而不住在 web，同一个理由）。
 *
 * ── 这个端点存在的全部理由：那个计数此前【无从校验】 ────────────────
 * `events/bus.ts` 里 `ApprovalDecided` 那段注释写着收件箱计数的算法
 * （`ApprovalRequired` +1、`ApprovalDecided` −1），也写着
 * 「⚠ 但【对账的那条 REST 源还不存在】」。0010 §5 把它列为「两处没做」的第一条，
 * 理由是「加一个端点要同时改五处手抄表而没有 Electron 环境可验」。
 * **那两条论据今天都不成立**（当场查的，0026 §3 记着）：
 *   · 那五处里唯一的测试文件是 `test/desktop/ipc-surface.test.ts` 一个（不是五个），
 *     而它**不 import electron** —— 本机 27 条全绿，改它是有门禁的；
 *   · `preload/api.ts` 那份手抄字面量同样离线可跑。
 * 也就是说那一条 blocker 的成因不是「做不了」，是「当时估错了成本」。
 * 少这一条读路径的代价今天仍然在那儿：**一个只能靠自己不丢不重来维持正确的数字**。
 *
 * ── 三条判据，各对应一种会静默的坏法 ──────────────────────────────
 * 1. **默认只列 pending**。收件箱要的是「等我处理的」，把历史全列出来
 *    等于让第一屏被上周批过的卡占满 —— 那种界面的结局是没人再看收件箱。
 *    取值白名单在 contracts 的 `APPROVAL_STATUS_VALUES`，不在这边重写一份。
 * 2. **排序按「等得最久」而不是按「刚发生」**。这一列是 0004 才补的，存量行为 NULL，
 *    而 SQLite 升序把 NULL 排在最前 ⇒ 「最老的在最上面」会退化成
 *    「不知年龄的排最上面」，而那些存量行恰恰是新列建之前那些最老的卡 ——
 *    看起来对，实际是巧合。所以判据写成「NULL 落最后」（见 APPROVAL_ORDER 那段）。
 * 3. **解析不出 escalation 时给 null，不抛**。这一格是从 JSON 里读的，
 *    而 JSON 是【当时写下的】：一行 0026 之前写的卡、一次旁路插入、
 *    一个改过的键名，都不该让整个收件箱 500。列表面向的是「扫一眼」，
 *    少一格原因只是少一个分组标签。
 */

import type { DatabaseSync } from "node:sqlite";
import {
  APPROVAL_STATUS_PENDING,
  APPROVAL_STATUS_VALUES,
  type ApprovalDetailView,
  type ApprovalView,
  approvalDetailViewSchema,
  approvalViewSchema,
} from "@opc/contracts";
import { assertSingleStatement } from "../db/write-queue.js";
import { autoApprove } from "../policy/auto-approve.js";

/**
 * 具名列，理由与 app.ts 的 `TASK_COLUMNS` 同一条：`SELECT *` 会让以后加的任何一个
 * 内部列【自动】变成对外契约，而那一刻没人 review 过它。
 * 这里尤其不能 `*`：`parameters` 里装着证据摘要，`decision_note` 是决策附件，
 * 两个都不属于列表接口（0026 的视图字段表逐条给了理由）。
 */
export const APPROVAL_COLUMNS =
  "id, task_id, approval_type, summary, recommendation, recommendation_source, " +
  "timeout_behavior, timeout_at, status, created_at, parameters, evidence_refs";

/**
 * 排序：**等得最久的在最上面**，NULL 年龄落最后。
 *
 * ⚠ 方向这一条写过一次错的，而且错在【注释与代码不一致】这种最难读的形状上：
 * 注释写「最老的在最上面」，代码写 `created_at DESC` —— 那是【最新】在前。
 * 两者不是一回事，而 DESC 恰好是错的那一个：收件箱要顶到第一行的是
 * 「已经等了 3 天没人理」那一张，不是「刚掉下来 5 分钟」那一张。
 * 一张等了 3 天的卡在 DESC 下会沉到列表最底部，而它正是最该被看到的那一张 ——
 * 那种界面的结局是人只扫前三行，于是等待时长越久的越不会被看到。
 * 所以这里是 `created_at ASC`（早的在前 = 等得久的在前）。
 *
 * `CASE WHEN created_at IS NULL THEN 1 ELSE 0 END` 这一截在 ASC 下是【承重】的，
 * 不是装饰：SQLite 升序把 NULL 排在【最前】，于是没有 created_at 的存量行
 * （0004 之前建的卡，恰恰是【最老】的那些）会顶到收件箱第一行 ——
 * 看着像「最老的在最上面」这条性质成立了，实际是 NULL 抢了那个位置，
 * 而它有多老【无从知道】。把「NULL 落最后」写进 SQL，
 * 正确性就不借「NULL 在升序里靠最前」这条方言行为。
 *
 * ⚠ 这里【没有】「待批优先」那一档（`CASE WHEN status = 'pending' THEN 0 …`），
 * 第一版写了，然后被自己的测试逼着删掉：`listApprovals` 的 WHERE 是
 * `status = ?` —— 单次查询里所有行的 status 相同，那一档【永远无法产生区分】。
 * 一个永不生效的排序键不是无害的：它会让下一个人以为「混合状态的列表按待批排过」，
 * 而今天没有任何一条查询路径能返回混合状态。本仓对「永不被触发的分支」的立场
 * 见 http/app.ts 里 501 那一支（那里保留有两条明写的理由，这里没有）。
 * ⇒ 将来若加多档过滤（`status=pending,deferred` 之类），排序必须同时重新决定，
 *   并由 query.test.ts 那条源码守卫当场提醒（它钉的就是「这里没有状态优先级」）。
 */
export const APPROVAL_ORDER =
  " ORDER BY CASE WHEN created_at IS NULL THEN 1 ELSE 0 END, created_at ASC";

/** 一次最多返回多少条。上限存在的理由不是性能，是【让它可被断言】。 */
export const DEFAULT_APPROVAL_LIMIT = 200;
export const MAX_APPROVAL_LIMIT = 1000;

export interface ListApprovalsInput {
  /** 状态过滤。缺省 = 只列 pending。非法取值【忽略并回落到缺省】，见下。 */
  readonly status?: string | undefined;
  readonly limit?: number | undefined;
}

export type ListApprovalsResult = {
  readonly approvals: ApprovalView[];
  /**
   * **实际生效**的那个状态过滤值。与调用方传进来的可以不同（非法取值回落时）。
   *
   * 必须报出来：回落这件事本身如果静默，界面写着「全部」而只列出待批，
   * 那就不是「少一个过滤器」，是【给了一个看起来没坏的错过滤】。
   */
  readonly statusFilter: string;
  /**
   * 库里**真的**有几张待批。与 `approvals.length` 可以不等（被 limit 截断时）。
   *
   * 这一格是这个端点对收件箱计数的**真正贡献**：前端那个由事件累计出来的数字
   * 要能对账，对的就是这个数，而不是列表长度。少了它，「limit 之后的第一页」
   * 会被读成「一共就这几张」，那比没有这个端点更糟 —— 它给了一个**错的**权威值。
   */
  readonly pendingTotal: number;
  readonly limit: number;
  readonly truncated: boolean;
};

/**
 * 从 `parameters` 那段 JSON 里取升级原因。
 *
 * 三层防御各有各的成因，少任何一层都会在某些行上抛：
 *  ① 不是合法 JSON（旁路插入 / 人工修数据，0003 文件头为 events 记过同一族）；
 *  ② 顶层不是对象（`[]`、`"x"`、`5` —— `JSON.parse` 全都成功）；
 *  ③ `escalation` 不是对象或是数组。
 * 抛错的代价是整个收件箱 500，而代价的成因是一行**读不出原因**的旧数据。
 */
export function escalationReasonOf(
  parametersJson: string | null,
): string | null {
  if (parametersJson === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(parametersJson);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const esc: unknown = (parsed as Record<string, unknown>)["escalation"];
  if (esc === null || typeof esc !== "object" || Array.isArray(esc))
    return null;
  const reason: unknown = (esc as Record<string, unknown>)["reason"];
  return typeof reason === "string" && reason !== "" ? reason : null;
}

/**
 * 从 `evidence_refs` 那列（0008，JSON 文本）取证据引用数组。
 *
 * 三层防御与 `escalationReasonOf` 同族：坏 JSON、非数组顶层、数组里混非字符串，
 * 任何一层都不该让整个收件箱 500 —— 读侧要把坏值【原样带出去】让人看见，
 * 而不是在解析层把「这行数据坏了」伪装成「这行很健康」。
 * 合法取值只有三种：null（没给）、字符串数组、[]。数组逐项必须是字符串；
 * 混入非字符串时也以 null 兜底（那是坏行，读侧不猜它的内容）。
 */
export function evidenceRefsOf(raw: unknown): string[] | null {
  if (raw === null || raw === undefined || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  if (parsed.length === 0) return [];
  if (!parsed.every((x): boolean => typeof x === "string")) return null;
  return parsed;
}

/** parameters JSON 里的显式 irreversible 标记（建卡契约那一格，cards.ts 拒建判据读的同一格）。 */
function explicitIrreversible(parametersJson: string | null): boolean {
  if (parametersJson === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(parametersJson);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return false;
  return (parsed as Record<string, unknown>)["irreversible"] === true;
}

/**
 * `parameters` 那列 → 详情视图要的对象（`GET /approvals/:interruptId` 专用）。
 *
 * ── 为什么单独一个函数，不复用上面那两个读 parameters 的东西 ────────
 * `escalationReasonOf` 与 `explicitIrreversible` 都是【从那段 JSON 里取一格】，
 * 一个给列表当分组标签、一个给影子判定短路。这一取是【整块给出】，
 * 因为 §9.2 第二行要的是快照本身而不是某一格。三者读同一列而目的不同，
 * 合成一个"通用取值函数 + 键名参数"会把三处各自的坏值处置并成一条 ——
 * 而那三处对坏值的【正确反应恰好不同】（列表：少一个标签；判定：不算不可逆；
 * 详情：明说读不出来）。
 *
 * ── 三种坏法的处置是 null，而 null 在这一格【不是】「没有参数」 ─────
 * DDL 写的是 `parameters TEXT NOT NULL`（0001_init.sql），约束管的是【有没有值】，
 * 不管【那串是不是 JSON 对象】。三种都会走到这里：
 *  ① 列值是 NULL。从库读回来的行到不了这一支（NOT NULL 挡着），
 *     但本函数的入参是 `unknown` —— 一个没有定义的输入就是一次抛，
 *     而抛在详情这条路上被翻成 500，500 说的是"服务端坏了"。
 *     与 `evidenceRefsOf` 同一个形状（那边第一支也是判 null），同一句理由。
 *  ② 存的是合法 JSON 但【不是对象】（一个数字、一个字符串、一个数组）。
 *  ③ 整串不是 JSON。
 * 三种都不该让详情 500：那一页是 CEO 决定要不要花钱的界面，
 * 「这一段读不出来」是一句可执行的真相，一次 500 是【整张卡看不见】。
 * 而它也不该被读成「这张卡没带参数」—— 所以契约把这一格命名为可空而不是空对象，
 * 界面（app.js 的 paramSnapshotLines，由 paramSnapshotHtml 渲染）对 null 写的是
 * 「参数快照读不出来」那一行。
 */
export function parametersObjectOf(
  raw: unknown,
): Record<string, unknown> | null {
  if (raw === null || raw === undefined || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

/** 影子判定的对外形状（contracts `approvalViewSchema.policy_shadow` 的同构窄化）。 */
export type PolicyShadowView = NonNullable<ApprovalView["policy_shadow"]>;

/**
 * 策略引擎对这张卡的**影子判定**（O9 动作 1 阶段一：只报不批）。
 *
 * ── 这一格存在的理由与它的边界 ─────────────────────────────────────
 * 「691 行判据、0 个调用方」的那 0，从这里开始不再是 0：`autoApprove` 第一次
 * 被生产代码调用。但它调用的是【读路径】—— 判定结果只进视图给界面并排显示，
 * 写路径（`recordAutoApproval` / `CLAIM_APPROVAL_FOR_AUTO_SQL`）一次都没碰。
 * 阶段一的全部主张是【测量】：先攒「规则会怎么判」的读数，再谈放开 R1。
 *
 * ── 三格前置为什么全部【不给】而不是猜 ─────────────────────────────
 * evidence.ok / gate.passed / history 今天都没有可靠的每卡出处：
 * 证据包完整性要 EvidenceStore.verify（dispatch 今天不产出真包，O5 的缺口），
 * 门控结论在 gate 事件里而卡片没带（O5 动作 1+2 的缺口），
 * 同类历史 countSimilarApprovals 在真库恒 0（O9 正文自己声明的数据未长出）。
 * `autoApprove` 对缺格的处置本来就是 fail-closed 的 missing 枚举
 * （evidence_missing / gate_missing / history_missing）—— 影子判定就如实报缺，
 * 这正是阶段一要攒的读数：「差哪一格」比「差多少格」可操作。
 *
 * ── 显式 irreversible 短路：不拿 summary 当动作文本 ─────────────────
 * `autoApprove` 的动作形状是 ActionDraft{kind, detail}，卡片上只有
 * approval_type 与 summary 可映射；拿 summary 当 detail 走子串表是【估算】，
 * 对不可逆那一档估算方向错了就是假阴性（验收第 2 条「不可逆被自动批准必须永远绿」
 * 不能建在子串表上）。而卡片带着显式 irreversible=true（建卡契约，
 * 与 cards.ts 的拒建判据同一格数据）⇒ 它【根本不进】autoApprove，
 * 直接短路成 blocked_by="irreversible"。R3 那一句照样是判据文件的原话。
 * 其余卡的 tier 由子串表从 summary 判 —— 读数页要写明它是估算。
 */
export function policyShadowOf(r: Record<string, unknown>): PolicyShadowView {
  const summary = String(r["summary"] ?? "");
  const kind = String(r["approval_type"] ?? "");
  if (
    explicitIrreversible(
      r["parameters"] == null ? null : String(r["parameters"]),
    )
  ) {
    return {
      decision: "require_approval",
      tier: "irreversible",
      blocked_by: "irreversible",
      missing: [],
      note: "卡片显式标记 irreversible=true：不可逆永不自动通过（R3，短路于动作文本估算之前）。",
    };
  }
  const o = autoApprove({ action: { kind, detail: summary } });
  return o.decision === "auto_approved"
    ? { decision: "auto_approved", rule: o.rule, tier: o.tier }
    : {
        decision: "require_approval",
        tier: o.tier,
        blocked_by: o.blocked_by,
        missing: [...o.missing],
        note: o.note,
      };
}

/**
 * 一行 → 对外视图。
 *
 * `status` 缺失时的兜底值得说一句：0001 那列写着 `DEFAULT 'pending'`，
 * 而 DEFAULT 只在**没写这一列**的 INSERT 上生效。一条显式写了 NULL 的旁路插入
 * 会留下 `status IS NULL` 的行，那种行既不是待批也不是已批。
 * 这里把它读成 `pending` 是**错的**（它会凭空多出一次待批），
 * 所以宁可原样报成 `"unknown"`：宁可显示一个看着不对的值让人来查，
 * 也不要一个看着对而实际错的值（0007 §4.1 同一条立场）。
 */
export function approvalViewOf(r: Record<string, unknown>): ApprovalView {
  const statusRaw = r["status"];
  const status =
    typeof statusRaw === "string" && statusRaw !== "" ? statusRaw : "unknown";
  const v = {
    id: String(r["id"]),
    task_id: (r["task_id"] as string | null) ?? null,
    approval_type: String(r["approval_type"] ?? ""),
    summary: String(r["summary"] ?? ""),
    recommendation: (r["recommendation"] as string | null) ?? null,
    recommendation_source:
      (r["recommendation_source"] as string | null) ?? null,
    timeout_behavior: (r["timeout_behavior"] as string | null) ?? null,
    timeout_at: r["timeout_at"] == null ? null : Number(r["timeout_at"]),
    status,
    created_at: r["created_at"] == null ? null : Number(r["created_at"]),
    escalation_reason: escalationReasonOf(
      r["parameters"] == null ? null : String(r["parameters"]),
    ),
    // 证据引用（0008）。JSON 文本 → 数组；解析失败的脏值【原样报成 null】
    // 而不是 500 —— 与 escalation_reason 同一条立场：读侧要让坏值可见，
    // 不能把「这行数据坏了」伪装成「这行很健康」。null 与 [] 都读作无证据包。
    evidence_refs: evidenceRefsOf(r["evidence_refs"]),
    // 影子判定（O9 动作 1 阶段一）。只读不批：见 policyShadowOf 文件头那段。
    policy_shadow: policyShadowOf(r),
  };
  // 出参也过一次 schema，与 taskViewSchema 在 app.ts 里那次同一用途：
  // 加列必须同时改视图 schema，否则这里编译不过或校验不过，而不是静默发出去。
  return approvalViewSchema.parse(v);
}

/**
 * 列卡片。只读连接上跑（`queue.readConnection()`），因此不被写队列排住（§5.5）。
 */
export function listApprovals(
  db: DatabaseSync,
  o: ListApprovalsInput = {},
): ListApprovalsResult {
  // 状态过滤：非法取值【回落到默认那一档（待批）】而不是 422，也不是「不过滤」。
  // 为什么不是 422：这是读侧过滤器，422 会让前端为一个下拉框的取值写一段
  // 错误处理，而那段代码在真机上永远不执行。
  // 为什么不是「不过滤」：判据 1 要的第一屏是「等我处理的」，
  // 一个拼错的参数把收件箱换成全量历史，比拒掉这一次请求更难被察觉。
  // 折中：回落 + 【把实际生效的那一档报出去】（statusFilter），
  // 由调用方决定怎么显示，这里不静默丢条件。
  const status: string =
    o.status !== undefined &&
    (APPROVAL_STATUS_VALUES as readonly string[]).includes(o.status)
      ? o.status
      : PENDING_LITERAL;
  const limit = clampLimit(o.limit);

  const sql =
    "SELECT " +
    APPROVAL_COLUMNS +
    " FROM approvals WHERE status = ?" +
    APPROVAL_ORDER +
    " LIMIT ?";
  const params: unknown[] = [status, limit];
  assertSingleStatement(sql);
  const rows = db.prepare(sql).all(...(params as never[])) as Record<
    string,
    unknown
  >[];

  return {
    approvals: rows.map(approvalViewOf),
    statusFilter: status,
    // 待批总数【无条件】查：它是那个计数要对的账，不能被 status / limit 影响。
    // 也就是说 status=approved 这一次查询里，pendingTotal 报的仍然是待批数 ——
    // 看着别扭，但「对账用的数」必须与「当前在看哪一档」无关，
    // 否则切一个 tab，收件箱角标就跟着变，那正是这个端点要消灭的那个 bug。
    pendingTotal: countPending(db),
    limit,
    truncated: countWithStatus(db, status) > rows.length,
  };
}

/**
 * 详情用的列 = 列表那十二列【整份重写一遍】+ 那一次决定的三个字段。
 *
 * ⚠ 【刻意不写成 `APPROVAL_COLUMNS + ", …"` 的拼接】。拼一份是省十二个字，
 * 代价是列表那一列将来加什么，详情【自动】跟着发出去，而那一刻没人 review 过它 ——
 * 这正是 APPROVAL_COLUMNS 上面那段「不许 SELECT *」的论点，只不过这次是
 * 用拼接把同一扇门开大（`.strict()` 那道 schema 也挡不住：加进 SELECT 的列
 * 只要同名字段在 schema 里就过得去，而 `parameters` 正是一个【列表为了别的用途
 * 才带着】、详情又【原样发出去】的键）。两条具名常量各写一遍，加列的人会看见两处。
 * 重复那一段字符串是本仓一直在买的那种保险（同一立场见 http/app.ts 的
 * TASK_COLUMNS；本文件里也有一条同款：两条 count SQL 各写一遍而不抽公共函数）。
 *
 * ⚠ 这一串必须与 approvalViewSchema + 详情那三格【逐列对齐】，
 * 由 query.test.ts 那一发「少一列就红」的用例钉住 —— 不是靠我数得对。
 */
export const APPROVAL_DETAIL_COLUMNS =
  "id, task_id, approval_type, summary, recommendation, recommendation_source, " +
  "timeout_behavior, timeout_at, status, created_at, parameters, evidence_refs, " +
  "decided_by, decided_at, decision_note";

/**
 * 一张卡的全部（`GET /approvals/:interruptId` 的读法）。返回 null = 库里没有这一张。
 *
 * ── 这一条读路径存在的理由 ─────────────────────────────────────────
 * `http/app.ts` 的 listApprovals 注释早就写过「要看参数与证据得进单张卡片的视图」，
 * 后面原本还跟着半句「那个视图今天还没有」—— 那半句在这条路由落地时【已从 app.ts
 * 摘掉】，留下的「它不该被塞进列表接口当作副产品」一个字没动。
 * ⚠ 这里曾把那句连同「还没有」一起【引用】着：引用另一份注释就是抄一份抄件，
 * 而被引文件改了措辞、这边不会红（本仓为 /today 的判据抄件立的同一条账）。
 * 现在引的是 app.ts 当下真有的那半句，「还没有」那一格按【已经发生的变化】记，
 * 不按引号里的原文记。
 * 分母是真的：`parameters` 有活写入方（`cards.ts` 的 INSERT_CARD_SQL 每条卡都写），
 * 而 §9.2 第二行「关键参数快照」在此之前【没有】任何一个界面能显示它 ——
 * 列表刻意不带，任务抽屉带的是任务的审计而不是卡的参数。
 *
 * ── 与列表那一条的两个差别，都不是巧合 ────────────────────────────
 *  ① 不按 status 过滤。收件箱默认只列 pending，而详情要能看【已决】的那一张
 *     （「我上周批的是什么来着」），也要能在批完之后立刻回看同一张。
 *     详情是「就是这一张卡」的唯一地方，那三个决策字段在这里才有主语。
 *  ② 走 `WHERE id = ?` 而不带 ORDER / LIMIT：主键点查。仍然过
 *     `assertSingleStatement`，与这个模块其余读法同一条纪律。
 */
export function readApprovalDetail(
  db: DatabaseSync,
  id: string,
): ApprovalDetailView | null {
  const sql =
    "SELECT " + APPROVAL_DETAIL_COLUMNS + " FROM approvals WHERE id = ?";
  assertSingleStatement(sql);
  const row = db.prepare(sql).get(id) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return approvalDetailViewOf(row);
}

/**
 * 一行 → 详情视图。列表那一格整块复用（`approvalViewOf`），差别只在补四格。
 *
 * 为什么不重抄一遍列表那十几行的字段映射：两处各写一遍 `status` 的兜底
 * （unknown 那一族）迟早会漂，而漂了之后的形状是「列表说这张卡 unknown、
 * 详情说它 pending」—— 同一张卡在同一个产品的两个界面上给出两种决定权判断，
 * 而决定权正是琥珀色那一格唯一的意思。先过列表那一份再 spread 出去，
 * 让「列表的口径是详情的子集」这件事由代码结构保证，而不是由我每次记得同步保证。
 *
 * 出参过一次 `approvalDetailViewSchema`，与 approvalView / taskView 同一条纪律：
 * 改字段必须同时改契约，否则这里编译不过或校验不过。
 *
 * ⚠ 我原本在这一格上面写的是「详情那些【内部列】（card_key / state_snapshot 之类）
 *   万一被谁加进 APPROVAL_DETAIL_COLUMNS，会在 parse 当场抛」。**那句是错的**，
 *   由 query.test.ts ⑧ 那条内部列的用例实跑否证的：视图是【逐字段映射】出来的
 *   （`approvalViewOf` 只读它认识的那几格 + 这里补四格），多出来的行键【没人读】，
 *   所以既不抛也不泄漏 —— 它是被【静默丢掉】。安全结果一样，机制不一样，
 *   而注释说错机制比不写更坏：下一个人会以为那里有闸门。
 *   真正的闸门是上面那条「列名逐列对齐」（含「每个名字都必须在真表里」那半）
 *   加 contracts 那张 `.strict()`。
 */
export function approvalDetailViewOf(
  r: Record<string, unknown>,
): ApprovalDetailView {
  const v = {
    ...approvalViewOf(r),
    // 参数快照走 parametersObjectOf：读不出来就是 null，界面上那句
    // 「参数快照读不出来」由它驱动（三种坏法的处置见那个函数的注释）。
    parameters: parametersObjectOf(r["parameters"]),
    decided_by: (r["decided_by"] as string | null) ?? null,
    decided_at: r["decided_at"] == null ? null : Number(r["decided_at"]),
    decision_note: (r["decision_note"] as string | null) ?? null,
  };
  return approvalDetailViewSchema.parse(v);
}

/**
 * 待批总数用的字面量。
 *
 * **取自 contracts 而不是在这里打「pending」这两个字**：
 * 「卡片现在待批吗」这条判据在 SQL 侧的另两个使用者是两条认领 SQL
 * （`real-deps.ts` 的 CLAIM_APPROVAL_SQL、`policy/auto-approve.ts` 的
 * CLAIM_APPROVAL_FOR_AUTO_SQL）。三处各写一遍字符串，
 * 漂移的症状是「这张卡明明显示待批，点下去说已经批过了」——
 * 而那句话在审计里对应一次**没有发生**的点击。
 *
 * ⚠ 这一段从前写的是「SQL 里只能是字面量，所以只能靠一发源码扫描钉住」。
 * 那句已经不再成立（0026 §9 那条绑参今天落地了）：两条认领 SQL 现在都写
 * `AND status = ?` 并绑这一个常量，所以**四处全部编译期同源**，
 * 那发扫描随之被删（一条失去分母的断言比没有断言更坏）。
 * query.test.ts 里留着的断言换成了它管得到的那一半：
 * **不许有人把绑参改回字面量拼接**（那种改法编译期不响，只有扫源码能报）。
 */
const PENDING_LITERAL: string = APPROVAL_STATUS_PENDING;

function countPending(db: DatabaseSync): number {
  const sql = "SELECT COUNT(*) AS n FROM approvals WHERE status = ?";
  assertSingleStatement(sql);
  const row = db.prepare(sql).get(PENDING_LITERAL) as
    | Record<string, unknown>
    | undefined;
  return Number(row?.["n"] ?? 0);
}

function countWithStatus(db: DatabaseSync, status: string): number {
  const sql = "SELECT COUNT(*) AS n FROM approvals WHERE status = ?";
  assertSingleStatement(sql);
  const row = db.prepare(sql).get(status) as
    | Record<string, unknown>
    | undefined;
  return Number(row?.["n"] ?? 0);
}

/**
 * limit 的钳制。**NaN / 负数 / 0 全都回落到默认值**而不是抛。
 *
 * ⚠ 分工要说清，别读成「query 里的 limit 写错了也没人管」：
 * HTTP 边界上 `GET /approvals?limit=abc` **是** 422（http/app.ts 那一条正则），
 * 所以走网络的调用方能立刻知道自己拼错了。这里的回落是**第二道**，
 * 服务的是进程内调用方（巡检、CLI、测试夹具）—— 那些调用方拿到一个
 * 「因为参数写错所以整条查询抛」的结果，代价是把一次读卡片列表升格成一次故障。
 *
 * 但**上界必须钳**（`MAX_APPROVAL_LIMIT`），两道都钳：没有上界的 limit 让
 * `/approvals?limit=99999999` 变成一次对 append-only 大表的全表读，
 * 而它在 Hub 主线程上同步跑（node:sqlite），期间**所有在途请求一起停**
 * —— 0003 文件头为巡检量过的那 413 ms 是同一件事。
 */
export function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_APPROVAL_LIMIT;
  const n = Math.trunc(raw);
  if (n <= 0) return DEFAULT_APPROVAL_LIMIT;
  return Math.min(n, MAX_APPROVAL_LIMIT);
}
