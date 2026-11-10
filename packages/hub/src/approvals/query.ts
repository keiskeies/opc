/**
 * 审批卡片的**读侧**（`GET /approvals` 的那一条查询）。
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
  type ApprovalView,
  approvalViewSchema,
} from "@opc/contracts";
import { assertSingleStatement } from "../db/write-queue.js";

/**
 * 具名列，理由与 app.ts 的 `TASK_COLUMNS` 同一条：`SELECT *` 会让以后加的任何一个
 * 内部列【自动】变成对外契约，而那一刻没人 review 过它。
 * 这里尤其不能 `*`：`parameters` 里装着证据摘要，`decision_note` 是决策附件，
 * 两个都不属于列表接口（0026 的视图字段表逐条给了理由）。
 */
export const APPROVAL_COLUMNS =
  "id, task_id, approval_type, summary, recommendation, recommendation_source, " +
  "timeout_behavior, timeout_at, status, created_at, parameters";

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
export function escalationReasonOf(parametersJson: string | null): string | null {
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
  if (esc === null || typeof esc !== "object" || Array.isArray(esc)) return null;
  const reason: unknown = (esc as Record<string, unknown>)["reason"];
  return typeof reason === "string" && reason !== "" ? reason : null;
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
export function approvalViewOf(
  r: Record<string, unknown>,
): ApprovalView {
  const statusRaw = r["status"];
  const status =
    typeof statusRaw === "string" && statusRaw !== "" ? statusRaw : "unknown";
  const v = {
    id: String(r["id"]),
    task_id: (r["task_id"] as string | null) ?? null,
    approval_type: String(r["approval_type"] ?? ""),
    summary: String(r["summary"] ?? ""),
    recommendation: (r["recommendation"] as string | null) ?? null,
    recommendation_source: (r["recommendation_source"] as string | null) ?? null,
    timeout_behavior: (r["timeout_behavior"] as string | null) ?? null,
    timeout_at: r["timeout_at"] == null ? null : Number(r["timeout_at"]),
    status,
    created_at: r["created_at"] == null ? null : Number(r["created_at"]),
    escalation_reason: escalationReasonOf(
      r["parameters"] == null ? null : String(r["parameters"]),
    ),
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
    "SELECT " + APPROVAL_COLUMNS + " FROM approvals WHERE status = ?" +
    APPROVAL_ORDER + " LIMIT ?";
  const params: unknown[] = [status, limit];
  assertSingleStatement(sql);
  const rows = db
    .prepare(sql)
    .all(...(params as never[])) as Record<string, unknown>[];

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
 * 待批总数用的字面量。
 *
 * **取自 contracts 而不是在这里打「pending」这两个字**：
 * 「卡片现在待批吗」这条判据在 SQL 侧的另一个使用者是 `real-deps.ts` 的
 * `CLAIM_APPROVAL_SQL`（那条 `WHERE status = 'pending'`）。两处各写一遍字符串，
 * 漂移的症状是「这张卡明明显示待批，点下去说已经批过了」——
 * 而那句话在审计里对应一次**没有发生**的点击。
 * SQL 里只能是字面量（SQLite 的表名/键名不能绑参，虽然这里绑的是值），
 * 所以做法是【从 contracts 的默认过滤集里取那一个值】，让两处共享同一个来源。
 * 它是 contracts 的 `APPROVAL_STATUS_PENDING`，而 query.test.ts 有一发【源码级】
 * 断言：real-deps.ts 那条 `WHERE status = 'pending'` 里的字面量必须等于它
 * （SQL 文本里没法绑常量，所以那一处只能是字面量 —— 只能靠断言把它钉住）。
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
