/**
 * 回放时间线（计划 Task 3.4，规格 §22.2 / §22.3）。
 *
 * 回放的目的规格写得很直接（§22.2 末句）：『让 CEO 以极低时间成本理解"组织是怎么
 * 运转的"，从而调整岗位书、委派规则或审阅门控 —— 审计是组织调参的数据来源，
 * 不是合规工具』。这条决定了本模块的判据不是「有没有把库里的行都倒出来」，
 * 而是「倒出来的东西能不能被拿去做决定」。于是有两类失效必须挡：
 *
 *  A. **给出假样本**：一行读坏了却显示成一个正常条目。
 *  B. **静默少一段**：某几行读不出来而时间线看着是完整的 —— 一条断掉的因果链
 *     会被读成「这一步是角色自己决定做的」，正是 §24 风险 1 要防的那种误读。
 *
 * 两者的处置是同一条：**坏行照常出现，带 degraded 标记 + 原文**。
 * 这不是新发明 —— `contracts/api.ts` 的 feedItemSchema 里已经有
 * `degraded: z.literal(true).optional()`，而 http/app.ts:531 的注释把这个方案
 * 点名给了本任务（『真要做容错，正确形态是给那一行加 degraded 标记 + 照常返回原始值，
 * 那是 Task 3.4 回放视图的事』）。同一段落里它否掉的两种做法（静默跳行 / 整请求 500）
 * 分别对应上面 B 与 A 的反面，所以这里照它执行而不是另起一套。
 *
 * ── Checkpoint 那一半：只登记，不解码 ──────────────────────────────────
 * 计划写的是「按 Checkpoint + events 重建时间线」。events 是纯 JSON 文本，直接可读；
 * 而 `checkpoints.checkpoint` / `.metadata` 是 `serde.dumpsTyped()` 出来的 BLOB
 * （0004 的 V7/V19：载荷 + 类型标签），读回必须走 `loadsTyped(type, bytes)` ——
 * 那是 `@langchain/core` 的序列化器，**本机装不上**（0009 §2 三条通路实测拿不到）。
 *
 * 所以本模块的做法是：把 checkpoint 行**按库里的原样登记进时间线**
 * （thread_id / checkpoint_id / parent_checkpoint_id / type / 字节长度），
 * 解码不了这件事**写在每一行上**（`decoded: false`）。
 * 我不做两件事，理由各一条：
 *  - **不猜序列化格式自己解**。msgpack-ish + 自定义 type 标签，猜错会得到
 *    「解出来一个能看的东西」，而那比解不出来危险得多。
 *  - **不因为解不出就不列这些行**。那样时间线会显得完整而少了节点级步骤，
 *    正是上面 B 类失效。
 * 「逐节点可展开并显示输入输出摘要」这条验收因此**只完成了一半**：
 * 审计侧的节点信息（state_change 的 from/to、actor、快照）齐全，
 * Checkpoint 侧的通道值摘要要等依赖到位。准确边界写进 0013 §8。
 */

import type { DatabaseSync } from "node:sqlite";
import { assertParamCount, assertSingleStatement } from "../db/write-queue.js";
import { currentGraphVersion, readGraphByVersion } from "../org/commit.js";
import { MAX_SEARCH_LIMIT, searchEvents } from "./search.js";

/** 一条时间线条目。字段是 snake_case，沿用本仓对外视图的口径（见 api.ts 那段说明）。 */
export type ReplayEntry = {
  /** events.id。也是 SSE 游标口径，两端同一个数才对得上。 */
  readonly seq: number;
  readonly action: string;
  readonly actor_type: string;
  readonly actor_id: string;
  readonly target: string | null;
  readonly created_at: number;
  /** payload 解出来的对象。坏行时是 null，原文在 raw_payload 里。 */
  readonly payload: unknown;
  readonly state_snapshot: unknown;
  /** 读不出来 / 解不开标记（§22.3 之外我们自己的那条容错口）。 */
  readonly degraded?: true;
  /** 降级原因。有 degraded 必须有 reason —— 只标不给原因等于让人重新排查一遍。 */
  readonly degrade_reason?: string;
  /** 降级时保留的库内原文，让界面还能把「那一行到底是什么」摊开给人看。 */
  readonly raw_payload?: string;
  readonly raw_state_snapshot?: string;
  /**
   * §22.3 第二条：策略引擎自动通过的决策 ⇒ 标『基于模式的自动批准』。
   *
   * 判据取 payload.auto_approved_by（写入方 policy/auto-approve.ts 就是它），
   * 【不取 actor_id】：actor_id 是「谁」，而「谁」可以是将来任何一种自动批准的署名，
   * 那个字段今天还承担别的系统事件（recorder 默认 actorId 就是 hub）。
   * 拿一个共享维度当判据，将来加一种系统署名就会连带标错一批回放条目。
   *
   * 规格 §22.3 那一行写的是『策略引擎自动通过的决策 → 标注「基于模式的自动批准」』，
   * 把三档里的两档（自动放行 / 模式自动通过）【合并成了同一句措辞】。
   * 我照规格给 annotation（对外可见的那句归规格管），同时把 rule 原样带出去，
   * 让界面想分开显示「只读自动放行」与「基于模式的自动批准」时【有数据可分】。
   * 规格的这处合并已在 0014 登记。
   */
  readonly auto_approved?: AutoApprovedAnnotation;
};

/**
 * payload.auto_approved_by 那一格的形状。
 *
 * 单独命名而不是就地写字面量，是为了下面那个 helper 的返回类型能指到它：
 * 早先返回类型写成 `{ auto_approved: ReplayEntry["auto_approved"] } | undefined`，
 * 而索引访问一个**可选**属性会把 `| undefined` 一起带出来，配上本仓开的
 * `exactOptionalPropertyTypes: true`，展开进对象字面量当场 TS2375
 * （「undefined 不能赋给那个非 undefined 的类型」）。这里不是靠 `!` 或 `as` 糊过去，
 * 是把「可选」这件事只留在字段上、类型本身不带 undefined。
 */
export type AutoApprovedAnnotation = {
  readonly by: string;
  readonly rule: string;
  readonly annotation: string;
};

/** Checkpoint 行。decoded=false 时通道值拿不到，见文件头那段。 */
export type ReplayCheckpoint = {
  readonly checkpoint_id: string;
  readonly parent_checkpoint_id: string | null;
  readonly checkpoint_ns: string;
  readonly type: string | null;
  readonly checkpoint_bytes: number;
  readonly metadata_bytes: number;
  readonly decoded: boolean;
};

export type ReplayView = {
  readonly task: {
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly assigned_role: string;
    readonly current_node: string;
    readonly graph_version: number;
    readonly created_at: number;
    readonly updated_at: number;
  };
  /**
   * 该任务运行时的汇报关系（§22.3 第 4 条：『标注该任务运行时的 graph_version
   * 及其汇报关系』）。来自 tasks.graph_version → delegation_graphs 那一版，
   * 不是当前图。缺那一版时不是 null 而是带原因的 degraded 块（见 graphSection）。
   */
  readonly graph: GraphSection;
  readonly entries: readonly ReplayEntry[];
  readonly checkpoints: readonly ReplayCheckpoint[];
  /**
   * 本次【实际】用来取行的 limit —— 不带关键词时就是 clamp 后的 limit，
   * 带关键词时还要再被 MAX_SEARCH_LIMIT 夹一次。
   *
   * 为什么把它放进响应而不是只写在文档里：调用方判断「下面还有没有」靠的是
   * `entries.length === limit`。它手上的 limit 是自己传的那个（比如 500），
   * 而服务端只给了 200 条 ⇒ 500 ≠ 200 会被读成「没有更多了」，
   * 于是第 2 页永远不会被请求，一次「搜完了，只有这些」的假结论就这么成立。
   * 给出真实分母，这个判断才是可算的。（与 `complete` 各管一件事：
   * 那个说「中间缺行」，这个说「后面还有行」。）
   */
  readonly effective_limit: number;
  /**
   * checkpoints 一段【整体读不到】的原因（表不存在等）。
   * 与条目级的 degraded 分开：那是「一行坏了」，这是「节点这一整段都没有」。
   * 混在一起的话，界面就没法区分「这条任务没跑过节点」与「本进程没装配 Saver」。
   */
  readonly checkpoints_unavailable?: string;
  /**
   * 时间线是否完整。false 意味着中间有行没读出来 —— 界面应当把它渲染成
   * 一段**看得见**的缺口，而不是让缺口看起来像「那段时间什么都没发生」。
   */
  readonly complete: boolean;
};

export type GraphSection =
  | {
      readonly ok: true;
      readonly version: number;
      readonly reports_to: Readonly<Record<string, string | null>>;
    }
  | {
      readonly ok: false;
      readonly version: number;
      readonly degraded: true;
      readonly reason: string;
    };

/** events 里 JSON 列的读取结果：要么解出来，要么留下原文与原因。 */
type ParsedColumn =
  | { readonly value: unknown; readonly degraded: false }
  | {
      readonly value: null;
      readonly degraded: true;
      readonly reason: string;
      readonly raw: string;
    };

/**
 * events 的取行 SQL。
 *
 * 排序：`ORDER BY id ASC`。这里**不用** created_at ——
 * 实测同一毫秒落多条事件时（一个超步里多条审计是常态），
 * 只按 created_at 排序的并列顺序 SQLite 不保证，两次回放可能给出不同顺序，
 * 而「同一任务连续回放两次输出完全相同」是计划点名的验收。
 * id 是 AUTOINCREMENT 单调、且就是 events 的物理写入序（= 因果序），
 * 比时间戳更贴「时间线」这个词。
 */
export const REPLAY_EVENTS_SQL =
  "SELECT id, action, actor_type, actor_id, target, payload, state_snapshot, created_at " +
  "FROM events WHERE task_id = ? ORDER BY id ASC LIMIT ? OFFSET ?";

export const REPLAY_TASK_SQL =
  "SELECT id, title, status, assigned_role, current_node, graph_version, " +
  "created_at, updated_at FROM tasks WHERE id = ?";

/**
 * checkpoint 行。thread_id = task_id 是 0006 §4 定下的同一性，
 * 所以这里能直接用任务 id 查，不需要多存一条映射。
 */
export const REPLAY_CHECKPOINTS_SQL =
  "SELECT checkpoint_id, parent_checkpoint_id, checkpoint_ns, type, " +
  "checkpoint, metadata FROM checkpoints WHERE thread_id = ? " +
  "ORDER BY checkpoint_id ASC";

export const DEFAULT_REPLAY_LIMIT = 500;
export const MAX_REPLAY_LIMIT = 2000;

export type BuildReplayInput = {
  readonly taskId: string;
  /**
   * 全文关键词。给了就**只返回命中的那些事件**（仍按因果序）。
   *
   * 为什么过滤发生在这一层而不是让界面自己拿 entries 去 filter：
   * 时间线是分页的（limit/offset）。前端过滤会先取一页 500 条、在那一页里搜，
   * 命中 0 条时显示「没有相关事件」—— 而真相是「命中的在第 3 页」。
   * 那是一条会把 CEO 引向错误结论的空结果（§22.2 的回放是给决定用的）。
   * 过滤发生在取行的那一层，分页才是「在命中的集合里翻页」这个意思。
   */
  readonly keyword?: string;
  readonly limit?: number;
  readonly offset?: number;
};

/**
 * 按 id 集合取事件行。占位符按 id 个数展开 —— 这是本模块唯一一处动态拼 SQL 的地方，
 * 而拼进去的**只有 `?` 的个数**，id 一律走参数绑定（searchEvents 返回的是数字 id）。
 * 空集合在调用处提前返回，不进这条 SQL（`IN ()` 是语法错误）。
 */
export function replayEventsByIdsSql(ids: readonly number[]): string {
  if (ids.length === 0) {
    throw new Error("ids 为空时不要走这条 SQL（IN () 是语法错误），调用方应提前返回空。");
  }
  /*
   * 这一条是【上界对账】，不是防御性冗余。实测本机 SQLite 接受
   * 32766 个 `?`（32767 报 too many SQL variables）—— 探针与结论见 0013 §5。
   * 而这个函数的输入来自 searchEvents 的一页命中，被 MAX_SEARCH_LIMIT 夹住。
   * 两个数此刻相差 160 倍，永远撞不上；但「永远」是**两个文件里的两个常量**
   * 维持的，不是类型维持的。哪天有人把 MAX_SEARCH_LIMIT 抬到几万（比如为了
   * 「一次导出全部审计」），这里会当场报错并说出该改哪，
   * 而不是让 SQLite 在最不可能重跑的那条路径上报一句语法错。
   */
  if (ids.length > MAX_SQL_VARIABLES) {
    throw new Error(
      "ids 有 " +
        ids.length +
        " 个，超过单条 SQL 的变量上限 " +
        MAX_SQL_VARIABLES +
        "。要么把 MAX_SEARCH_LIMIT 调回上限以下，要么把这里换成分批 IN —— 不要直接调大这个数。",
    );
  }
  return (
    "SELECT id, action, actor_type, actor_id, target, payload, state_snapshot, created_at " +
    "FROM events WHERE id IN (" +
    ids.map(() => "?").join(",") +
    ") ORDER BY id ASC"
  );
}

/** 实测值：32766 个 `?` 可用，32767 报 too many SQL variables。见上面那段。 */
export const MAX_SQL_VARIABLES = 32766;

/** 任务不存在返回 null（让 HTTP 层去决定 404），存在则给出时间线。 */
export function buildReplayView(
  db: DatabaseSync,
  o: BuildReplayInput,
): ReplayView | null {
  const taskRow = readOne(db, REPLAY_TASK_SQL, [o.taskId]);
  if (taskRow === undefined) return null;

  const limit = clampLimit(o.limit);
  const offset = clampOffset(o.offset);
  /*
   * 有 keyword 时先检索、再按命中的 id 取行；没有就直接按任务取行。
   *
   * 检索那一发【必须显式传 order: "timeline"】。这不是可选的润色：
   * searchEvents 的默认排序是 created_at DESC（审计页要的「最近在前」），
   * 拿它去填时间线会得到一份**倒放**的回放 —— 「A 之后才有 B」被读成
   * 「B 导致 A」，而 §24 风险 1 防的正是这类因果误读。
   * 两个默认值相反这件事本身说明「一个 searchEvents 服务两个消费者」是有代价的，
   * 但拆成两个函数会让转义与双路兜底那套逻辑抄两份（0006 §7 那族问题），
   * 所以留一个函数 + 一个必须显式传的维度，并且下面那条用例钉住顺序。
   */
  const keyword = o.keyword;
  // 显式收窄而不是靠 `searching` 这个布尔：TS 不会顺着布尔把 keyword 收窄成 string，
  // 而写成 `keyword as string` 会把「空串也算搜不搜」这件事的判断权交回给类型断言。
  const needle = keyword !== undefined && [...keyword].length > 0 ? keyword : undefined;
  const searchLimit = Math.min(limit, MAX_SEARCH_LIMIT);
  const effectiveLimit = needle === undefined ? limit : searchLimit;
  let rows: Record<string, unknown>[];
  if (needle !== undefined) {
    /*
     * 带关键词时一页最多 MAX_SEARCH_LIMIT 条，而【不带关键词】时是 MAX_REPLAY_LIMIT。
     * searchEvents 内部本来就会夹（paging() 里的 Math.min），但这里【明着算一遍】并
     * 把结果放进响应的 effective_limit：悄悄被夹的话，调用方传 limit=500 拿到 200 条
     * 会以为「就命中这么多」，而界面按 entries.length < limit 判断「到底了」，
     * 于是第 2 页永远不被请求 —— 一次「没有更多结果」的假结论。
     * 夹在明处，配合下面那条用例，这件事才是可查的。
     */
    const hits = searchEvents(db as never, {
      keyword: needle,
      taskId: o.taskId,
      order: "timeline",
      limit: searchLimit,
      offset,
    });
    rows =
      hits.length === 0
        ? []
        : readAll(
            db,
            replayEventsByIdsSql(hits.map((h): number => h.id)),
            hits.map((h): number => h.id),
          );
  } else {
    rows = readAll(db, REPLAY_EVENTS_SQL, [o.taskId, limit, offset]);
  }

  const entries: ReplayEntry[] = [];
  for (const r of rows) {
    const payload = parseColumn(r["payload"], "payload", false);
    const snapshot = parseColumn(r["state_snapshot"], "state_snapshot", true);
    const base: ReplayEntry = {
      seq: num(r["id"], "events.id"),
      action: str(r["action"], "action"),
      actor_type: str(r["actor_type"], "actor_type"),
      actor_id: str(r["actor_id"], "actor_id"),
      target: (r["target"] as string | null | undefined) ?? null,
      created_at: num(r["created_at"], "created_at"),
      payload: payload.value,
      state_snapshot: snapshot.value,
      // §22.3 第二条。解不开的 payload 不标（那一行已经有 degraded + 原文在提示，
      // 再标一个「基于模式的自动批准」就是给一条读不出来的行【下一个肯定的结论】）。
      ...(autoApprovedSection(payload) ?? {}),
    };
    const reason =
      payload.degraded === true
        ? snapshot.degraded === true
          ? payload.reason + "；" + snapshot.reason
          : payload.reason
        : snapshot.degraded === true
          ? snapshot.reason
          : undefined;
    if (reason === undefined) {
      entries.push(base);
      continue;
    }
    // 坏行【照常进时间线】。跳行的话条目数变少而总数不说，CEO 读到的是
    // 「这段流程只有 5 步」，而真相是「有 7 步、其中 2 步读不出来」。
    entries.push({
      ...base,
      degraded: true,
      degrade_reason: reason,
      ...(payload.degraded === true ? { raw_payload: payload.raw } : {}),
      ...(snapshot.degraded === true
        ? { raw_state_snapshot: snapshot.raw }
        : {}),
    });
  }

  const version = num(taskRow["graph_version"], "tasks.graph_version");
  const graph = graphSection(db, version);
  const ckpt = readCheckpoints(db, o.taskId);
  // complete 只看【有没有降级行】。它不含「被分页截断」这件事 ——
  // 截断由调用方拿 limit/offset 自己判（entries.length === limit 就是可能还有）。
  // 把两件事混进一个布尔，界面上就没法分别显示「中间缺一段」与「下面还有」。
  const complete = !entries.some((e): boolean => e.degraded === true);

  return {
    task: {
      id: str(taskRow["id"], "tasks.id"),
      title: str(taskRow["title"], "tasks.title"),
      status: str(taskRow["status"], "tasks.status"),
      assigned_role: str(taskRow["assigned_role"], "assigned_role"),
      current_node: str(taskRow["current_node"], "current_node"),
      graph_version: version,
      created_at: num(taskRow["created_at"], "created_at"),
      updated_at: num(taskRow["updated_at"], "updated_at"),
    },
    graph,
    entries,
    effective_limit: effectiveLimit,
    checkpoints: ckpt.checkpoints,
    ...(ckpt.unavailableReason === undefined
      ? {}
      : { checkpoints_unavailable: ckpt.unavailableReason }),
    complete,
  };
}

/**
 * §22.3 第二条那一格的取数。写成函数而不是内联在循环里：
 * 它要在【降级那一支】和【正常那一支】之间共用同一个判断，内联就得抄两遍，
 * 而抄的那份只会在一支里被改（0006 §7 那族「两份抄本」）。
 */
function autoApprovedSection(
  payload: ParsedColumn,
): { auto_approved: AutoApprovedAnnotation } | undefined {
  if (payload.degraded === true) return undefined;
  const p: unknown = payload.value;
  if (p === null || typeof p !== "object" || Array.isArray(p)) return undefined;
  const by = (p as Record<string, unknown>)["auto_approved_by"];
  if (typeof by !== "string" || by.trim() === "") return undefined;
  const rule = (p as Record<string, unknown>)["rule"];
  return {
    auto_approved: {
      by,
      rule: typeof rule === "string" ? rule : "",
      // 措辞逐字取自规格 §22.3 那一行（『标注「基于模式的自动批准」』）。
      // 不在这里改写措辞：界面显示的那句归规格管，改它要过一次文档。
      annotation: "基于模式的自动批准",
    },
  };
}

/**
 * §22.3 第 4 条那一块：任务运行时的汇报关系。
 *
 * 读不到那一版时【不退回当前图】。退回去会得到一张「看着对」的汇报关系，
 * 而它可能是三版之前 —— 0012 的 readGraphByVersion 立的正是同一条判据
 * （『兜底成最新图 = 让旧任务在新汇报关系下继续跑』）。
 * 这里同样是宁可给一个带原因的缺口。
 */
function graphSection(db: DatabaseSync, version: number): GraphSection {
  try {
    const g = readGraphByVersion(db, version);
    const reports: Record<string, string | null> = {};
    // nodes 是 Record<roleId, node> 而不是数组（contracts/org/graph.ts:112）。
    // 用 for...of 直接遍历它会得到 TS2488（Record 没有 Symbol.iterator）——
    // 这一处我是先写错、被 tsc 报出来才改的，不是提前知道的。
    // 键取 Object.keys 而不是 node.role_id：两者当前相同，但键是【图里的权威 id】，
    // 而 role_id 是节点自带字段，可以被人写成不同的值。
    for (const [roleId, node] of Object.entries(g.nodes)) {
      reports[roleId] = node.reports_to;
    }
    return { ok: true, version, reports_to: reports };
  } catch (e) {
    return {
      ok: false,
      version,
      degraded: true,
      reason:
        "任务引用的是组织图 v" +
        version +
        "，那一版读不出来：" +
        (e instanceof Error ? e.message : String(e)) +
        "。刻意不退回当前图 —— 那会让回放显示一张【当时并不存在】的汇报关系。",
    };
  }
}

function readCheckpoints(
  db: DatabaseSync,
  taskId: string,
): { checkpoints: ReplayCheckpoint[]; unavailableReason?: string } {
  let rows: Record<string, unknown>[];
  try {
    rows = readAll(db, REPLAY_CHECKPOINTS_SQL, [taskId]);
  } catch (e) {
    // checkpoints 表可能整个【不存在】：迁移里没有它（实测 grep 0001_init.sql = 0 命中），
    // 它由 SqliteWALSaver 构造时 CREATE TABLE IF NOT EXISTS —— 所以 Hub 单独跑过、
    // 一条图都没跑过时，这张表就是没有。
    //
    // 这【不该】抛（一个没跑过图的任务，节点段本来就该是空的），但也不能静默成
    // 空数组：静默之后，「这张表不存在」与「这张表存在而这任务确实没有 checkpoint」
    // 在界面上完全一样，而前者是一次环境缺陷（Saver 没被装配过）。
    // 早先这里写的是 `void e; return []`，配上「原因带出来，交给调用方在日志里看见」
    // —— 那句注释【没有对应的代码】，是注释承诺了实现没有的东西
    // （0008 §1 同类形状：注释比数值更容易被信）。现在真的把它交给调用方。
    return {
      checkpoints: [],
      unavailableReason:
        "读不到 checkpoints：" +
        (e instanceof Error ? e.message : String(e)) +
        "。若这张表尚不存在，说明本进程从未装配过 Saver（迁移不建它，" +
        "只有 SqliteWALSaver 构造时建），回放里【没有节点级步骤】是必然的，" +
        "不是这条任务没跑过。",
    };
  }
  return {
    checkpoints: rows.map((r): ReplayCheckpoint => ({
      checkpoint_id: str(r["checkpoint_id"], "checkpoint_id"),
      parent_checkpoint_id:
        (r["parent_checkpoint_id"] as string | null | undefined) ?? null,
      checkpoint_ns: str(r["checkpoint_ns"], "checkpoint_ns"),
      type: (r["type"] as string | null | undefined) ?? null,
      checkpoint_bytes: byteLen(r["checkpoint"]),
      metadata_bytes: byteLen(r["metadata"]),
      // 恒 false，且【不是】待办清单上被忘掉的一格：解码要 @langchain/core 的
      // serde（见文件头）。写死 false 而不是留个 try/catch 假装尝试过，
      // 是为了将来真接上 serde 时这一行必须被改到 —— 而改一个恒 false 的常量
      // 会红掉那条断言 decoded=false 的用例，逼着改的人同时更新用例。
      decoded: false,
    })),
  };
}

function byteLen(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (v instanceof Uint8Array) return v.byteLength;
  if (typeof v === "string") return v.length;
  return 0;
}

/**
 * 解一列 JSON。
 *
 * 三类失败分开报，因为它们指向不同的修法：
 *  - `null` 列 → 只有 state_snapshot 允许（列可空）；payload 是 NOT NULL，
 *    读到 null 说明【库与 schema 不符】，那是迁移或手工写坏的事，要标出来；
 *  - 空串 → recorder 不会写空串（它把 undefined 落成 "null"），所以这是外来写入；
 *  - 非法 JSON → recorder 在写入侧就拦过一道（serializePayload 抛），
 *    所以出现即意味着有人绕过 recorder 直写 events。
 * 三种都不抛，一律 degraded + 原文。抛的后果在文件头写过：一行坏数据让整段回放不可用。
 */
function parseColumn(
  raw: unknown,
  column: string,
  nullable: boolean,
): ParsedColumn {
  if (raw === null || raw === undefined) {
    if (nullable) return { value: null, degraded: false };
    return {
      value: null,
      degraded: true,
      reason: column + " 列是 NOT NULL 而读到 null：库与 schema 不符",
      raw: "",
    };
  }
  if (typeof raw !== "string") {
    return {
      value: null,
      degraded: true,
      reason: column + " 不是文本而是 " + typeof raw,
      raw: String(raw),
    };
  }
  if (raw.trim() === "") {
    return {
      value: null,
      degraded: true,
      reason: column + " 是空串（recorder 从不写空串，这行是绕过 recorder 直写的）",
      raw,
    };
  }
  try {
    return { value: JSON.parse(raw) as unknown, degraded: false };
  } catch (e) {
    return {
      value: null,
      degraded: true,
      reason:
        column + " 不是合法 JSON：" + (e instanceof Error ? e.message : String(e)),
      raw,
    };
  }
}

function readAll(
  db: DatabaseSync,
  sql: string,
  params: readonly unknown[],
): Record<string, unknown>[] {
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  return db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
}

function readOne(
  db: DatabaseSync,
  sql: string,
  params: readonly unknown[],
): Record<string, unknown> | undefined {
  return readAll(db, sql, params)[0];
}

function str(v: unknown, column: string): string {
  if (typeof v === "string") return v;
  throw new Error(column + " 期望字符串，实到 " + typeof v + "。列名或表结构变了。");
}

function num(v: unknown, column: string): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  throw new Error(column + " 期望数字，实到 " + typeof v + "。");
}

function clampLimit(raw: number | undefined): number {
  const v = raw ?? DEFAULT_REPLAY_LIMIT;
  if (!Number.isInteger(v) || v < 1) {
    throw new Error("limit 必须是 ≥1 的整数，实到 " + String(raw));
  }
  return Math.min(v, MAX_REPLAY_LIMIT);
}

function clampOffset(raw: number | undefined): number {
  const v = raw ?? 0;
  if (!Number.isInteger(v) || v < 0) {
    throw new Error("offset 必须是 ≥0 的整数，实到 " + String(raw));
  }
  return v;
}

/** 供 HTTP 层复用：当前最新图版本（回放页要显示「当时 vs 现在」）。 */
export function latestGraphVersionForReplay(db: DatabaseSync): number {
  return currentGraphVersion(db);
}
