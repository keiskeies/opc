/**
 * 事件全文检索（计划 Task 3.4，规格 §22 + 附录 C.3）。
 *
 * 三档策略照规格：**FTS(trigram) 优先 → 短查询与 0 命中时降级 LIKE**。
 * 但 C.3 那段示例代码是**在 SQLite 3.53.4 上测的**，本机 `node:sqlite` 内嵌 **3.51.2**
 * （0004 §文件头那条同类提醒：『上线前须用同样的用例重跑本表，不得假定行为一致』）。
 * 本轮逐条重跑，结论是示例代码有一处**会让检索结果说谎**，另有一处**会把一次检索
 * 变成一次 500**。两处都在下面写清了，并各有一条用例守着。
 *
 * ── 与 C.3 示例代码的差异，逐条 ─────────────────────────────────────────
 *
 * ① **LIKE 兜底必须转义 `%`、`_`、`\`。** 示例只对关键词做了双引号转义（那是给
 *    FTS 的），LIKE 那一发是 `'%' + kw + '%'` 直接拼。实测（本机 3.51.2）：
 *      关键词 "%"  → 不转义命中 **全部行**，转义后 0 行
 *      关键词 "_"  → 不转义命中 **全部行**，转义后 0 行
 *    后果不是报错，是**返回一堆无关行**。而 CEO 拿这个结果会当「确实有这些事件」读 ——
 *    审计检索给出假阳性，比给不出结果更坏（§4.5『审计是组织调参的数据来源』，
 *    数据来源里的假样本会被拿去做真决定）。
 *
 * ② **关键词必须包成 FTS 短语，否则语法报错。** 实测不转义时：
 *      "AND"        → fts5: syntax error near "AND"
 *      "覆盖率 OR"  → fts5: syntax error near ""
 *      "-a"         → no such column: a
 *    规格的 `'\"' + kw.replace(/\"/g,'\"\"') + '\"'` 这一手**是对的**，本轮验过：
 *    关键词 `说"你` 在含该串的库上 MATCH 命中 1（我第一版夹具把关键词写成了
 *    行里并不存在的 `他"你`，于是得到「0 命中」并误判成规格有缺陷 —— 那是夹具错，
 *    不是规格错，见 0013 §3）。
 *
 * ③ **排序必须带末位 tiebreaker。** 计划要「同一任务连续回放两次输出完全相同」，
 *    而实测：同一毫秒落 6 条事件时，只按 `ORDER BY created_at DESC` 翻页得到
 *    `2,3,4`，加上 `id DESC` 得到 `5,4,3` —— **并列时 SQLite 不保证顺序**。
 *    「两次回放一致」这条验收在只按时间排序的实现下会**偶尔**成立、**偶尔**不成立，
 *    是最难复现的那类红。所以两条 SQL 都写 `ORDER BY created_at DESC, id DESC`。
 *
 * ④ **trigram 对 ASCII 大小写不敏感**（实测：行里是 `CoVeRaGe`，查 `coverage` 与
 *    `COVER` 都命中），LIKE 也不敏感。所以不需要 LOWER()，也不需要提示用户大小写。
 *
 * ⑤ 关键词长度按 **code point** 数而不是 UTF-16 单元数：`[...kw].length`。
 *    一个 emoji（代理对）长度算 1。写成 `kw.length` 的话，两个 emoji 会被当 4 字符
 *    送去 MATCH，而 trigram 需要 3 个**字符**，实测会 0 命中 —— 症状是「我明明打了
 *    两个 emoji 搜不到」，而不是任何报错。
 *
 * ── 为什么这个模块住在 hub 而不是计划写的 packages/web ──────────────────
 * 计划 3.4 的 Files 写的是 `packages/web/src/replay/search.ts`，但它要开库读 events，
 * 而 `test/arch/package-deps.test.ts` 明令 **web 禁止依赖 SQLite**（规格 §5.6.1 的
 * Hub/UI 边界，那条守卫此刻是红的，红在别的原因）。检索必然读 events，所以只能在 hub。
 * web 侧要搜索就调 `GET /replay/:taskId` 的 query（见 http/app.ts）。
 * 这条偏离记在 0013 §6。
 */

import { assertParamCount, assertSingleStatement } from "../db/write-queue.js";

/** 只读连接的最小面：只有 prepare().all()。刻意不含任何写方法。 */
export type ReadDb = {
  prepare(sql: string): { all(...params: never[]): unknown[] };
};

/** 命中来源。三档里走了哪一档要能被调用方看见 —— 理由见 SearchHit.via。 */
export type SearchVia = "fts" | "like";

export type SearchHit = {
  readonly id: number;
  /**
   * 这一行是**哪一档**命中的。带出来而不是内部消化，是因为两档的语义不同：
   * fts 走的是「payload 里存在这个 3+ 字符连续串」，like 走的是「整行文本里
   * 存在这个子串」—— 后者会连 **JSON 的键名**一起匹配（实测 `{"text":"x"}`
   * 搜 `text` 命中）。CEO 看到一条命中而它是键名撞上的，与看到「没搜到」
   * 是两种完全不同的误判，所以界面必须能标出来。
   */
  readonly via: SearchVia;
};

/** trigram 的分词窗口。短于这个长度，FTS 一定 0 命中（C.3 实测 + 本机复测）。 */
export const TRIGRAM_MIN_CHARS = 3;

/** 单页上限。搜索是全表扫（LIKE 那档），不设上界等于让一次输入拖住只读连接。 */
export const MAX_SEARCH_LIMIT = 200;
export const DEFAULT_SEARCH_LIMIT = 50;

/**
 * LIKE 的转义。用 `\` 作 ESCAPE 字符。
 *
 * 三个字符都得转，漏一个的后果不同：
 *  - `%` 漏 → 匹配任意串（实测命中全部行）；
 *  - `_` 漏 → 匹配任意单字符（同上）；
 *  - `\` 漏 → 关键词里原有的 `\` 会把**下一个字符**当转义对象吃掉。
 *    例：关键词 `a\%b` 只转 `%` 会得到 `a\%b` → LIKE 读作「a 后跟字面 %，再 b」，
 *    与用户输入的含义**相同**，看似没事；但关键词 `a\\b`（两个反斜杠）会退化成
 *    匹配 `a\b`。少转义第三个字符是「多数输入没事、少数输入静默错」的形状。
 */
export function escapeLikePattern(keyword: string): string {
  return keyword.replace(/[\\%_]/gu, (m: string): string => "\\" + m);
}

/**
 * FTS5 的短语化。双引号整体包裹 + 内部双引号翻倍（C.3 原式，本轮验其正确）。
 *
 * 不做语法白名单而用引号包死，是因为白名单会**拒绝**合法输入：
 * 事件文本里真有 `AND`、`NEAR`、带空格的短语（实测这三条包裹后都能正常查，
 * 不包裹有两条直接 syntax error）。
 */
export function quoteFtsPhrase(keyword: string): string {
  return '"' + keyword.replace(/"/gu, '""') + '"';
}
/*
 * 接下来几段是**可选 SQL 片段**，由 ftsSearchSql / likeSearchSql 组合成
 * 实际执行的那四条 SQL（全库/限定任务 × 最近在前/因果序）。
 * 放在组合函数【之前】是被实测教出来的顺序：const 不提升，
 * 组合函数定义在它们上面时模块一加载就 `Cannot access 'X' before initialization`，
 * 症状是【整个测试文件一条都不同过】而不是某条断言红。
 *
 * 为什么不写成八个常量把「是否限定任务 × 按什么序」全枚举出来：
 * 八个字面量里必然有一个与另外七个漂移（0006 §7 记的就是这种「两份抄本」的形状）。
 * 片段只有一份，组合发生在代码里，而组合结果由用例逐条打在行为上。
 *
 * 也**不是**把限定条件做成 `AND (? IS NULL OR task_id = ?)` 那种「一个模板走天下」——
 * 那种写法读起来省一件事、做起来让 SQLite 用不上 task_id 那一侧的任何索引意图，
 * 更麻烦的是它让「没传 taskId」与「传了但匹配零行」在 SQL 层完全同形，
 * 而这两种情况界面上要说的话不一样。
 */

/**
 * 限定单个任务。回放页必须带它：CEO 在任务 A 的回放里搜一个词，
 * 得到任务 B 的事件是**答非所问**（§22.2 的回放对象是「任意一个任务」）。
 *
 * FTS 侧用 `rowid IN (SELECT id FROM events WHERE task_id = ?)` 而不是直接
 * `events_fts` 上加列：这张表是 external content 表（content='events'），
 * 它手上只有被索引的 payload 列，task_id 不在索引里。实测两种限定都返回预期行
 * （探针见 0013 §2），这一条按可读性选。
 */
const FTS_SCOPE = " AND rowid IN (SELECT id FROM events WHERE task_id = ?)";
const LIKE_SCOPE = " AND task_id = ?";

/**
 * 排序。两档，因为两个消费者要的**恰好相反**：
 *  - 全文检索（审计翻页）要最近的在前 —— 排查「刚刚发生了什么」；
 *  - 回放时间线要**因果序**（id 升序）。
 *
 * 第二档不是「顺手加的一个开关」。它是这一节接进 buildReplayView 的理由：
 * 拿默认排序去过滤时间线，会得到一份**倒放**的回放 —— 结论从「A 导致 B」
 * 变成「B 之后才有 A」，而 §24 风险 1 防的正是这种因果误读。
 * 反过来让回放迁就检索的默认序，是让消费者去适配工具的默认排序：
 * 界面上一眼看不出错，只有想把「顺序」讲给别人听的人才卡住。
 */
const FTS_ORDER_RECENT = " ORDER BY rank, rowid DESC";
const FTS_ORDER_TIMELINE = " ORDER BY rowid ASC";
const LIKE_ORDER_RECENT = " ORDER BY created_at DESC, id DESC";
const LIKE_ORDER_TIMELINE = " ORDER BY id ASC";

/** 命中顺序。见上面那些 ORDER 片段旁的说明。 */
export type SearchOrder = "recent" | "timeline";

/** 一条检索 SQL 的两个可选维度。 */
export type SqlShape = {
  readonly scope: boolean;
  readonly order: SearchOrder;
};

/**
 * 拼 FTS 那一发。
 *
 * 做成函数而不是四个常量：常量枚举出来后必然有一个与另外三个漂移
 * （0006 §7 那族「两份抄本」的问题），而下面 FTS_SEARCH_SQL 那个对外常量
 * 现在只是 `ftsSearchSql({scope:false, order:"recent"})` 的一次取值 ——
 * 用例断言的字面量与真跑的那条 SQL 是**同一个来源**，测的才是真东西。
 */
export function ftsSearchSql(s: SqlShape): string {
  return (
    "SELECT rowid AS id FROM events_fts WHERE events_fts MATCH ?" +
    (s.scope ? FTS_SCOPE : "") +
    (s.order === "timeline" ? FTS_ORDER_TIMELINE : FTS_ORDER_RECENT) +
    " LIMIT ? OFFSET ?"
  );
}

/**
 * 拼 LIKE 兜底那一发。
 *
 * `ESCAPE '\'` 这一句【不能省】：省了之后上面 escapeLikePattern 转义出来的 `\%`
 * 会被 SQLite 当通配符，于是「转义」这一步变成纯装饰 ——
 * 症状是搜 `%` 仍然返回全部行，而代码看上去【确实转义了】。
 * 这是本轮最容易写错的一行，所以两条用例一起打：一条打在【结果行数】上
 * （搜 `%` 返回 0 行才算真生效），一条打在 SQL 字面量上（少写 ESCAPE 时当场指出是哪句）。
 * 只有后者的话它证明的是「我写了这三个字」，前者才证明它起作用。
 */
export function likeSearchSql(s: SqlShape): string {
  return (
    "SELECT id FROM events WHERE payload LIKE ? ESCAPE '\\'" +
    (s.scope ? LIKE_SCOPE : "") +
    (s.order === "timeline" ? LIKE_ORDER_TIMELINE : LIKE_ORDER_RECENT) +
    " LIMIT ? OFFSET ?"
  );
}

/** 全库、最近优先 —— 审计页那一档，也是 C.3 示例对应的形状。 */
const DEFAULT_SHAPE: SqlShape = { scope: false, order: "recent" };
export const FTS_SEARCH_SQL: string = ftsSearchSql(DEFAULT_SHAPE);
export const LIKE_SEARCH_SQL: string = likeSearchSql(DEFAULT_SHAPE);


export type SearchEventsInput = {
  readonly keyword: string;
  /** 只看这一个任务的事件。缺省即全库搜（审计页那种跨任务检索走这一档）。 */
  readonly taskId?: string;
  /** 缺省 "recent"：全库检索的默认；回放时间线必须显式传 "timeline"。 */
  readonly order?: SearchOrder;
  readonly limit?: number;
  readonly offset?: number;
};

/** 参数校验过的分页量。负数与 NaN 都在这里挡掉，不让它进 SQL。 */
function paging(o: SearchEventsInput): { limit: number; offset: number } {
  const rawLimit = o.limit ?? DEFAULT_SEARCH_LIMIT;
  const rawOffset = o.offset ?? 0;
  if (!Number.isInteger(rawLimit) || rawLimit < 1) {
    throw new Error(
      "limit 必须是 ≥1 的整数，实到 " + String(rawLimit) + "。" +
        "传 0 或负数不会得到「空页」，SQLite 的 LIMIT 0 是合法的「全不给」而 OFFSET 仍生效，" +
        "于是分页游标会停不住（第 2 页与第 1 页同样空，客户端以为翻到头了）。",
    );
  }
  if (!Number.isInteger(rawOffset) || rawOffset < 0) {
    throw new Error("offset 必须是 ≥0 的整数，实到 " + String(rawOffset));
  }
  return {
    limit: Math.min(rawLimit, MAX_SEARCH_LIMIT),
    offset: rawOffset,
  };
}

/**
 * 检索事件。空关键词返回**空**而不是「全部」。
 *
 * 这一条值得单独说：C.3 示例没有处理空串，而 FTS 空短语与 `LIKE '%%'` 都返回全部行。
 * 「搜索框为空就列出全部事件」看着像合理的默认，实际是把回放页变成一个
 * 无界全表扫的入口（payload 没有长度上限，events 是 append-only ⇒ 行数只增）。
 * 空输入的正确语义是「别查」，界面提示「关键词建议 ≥3 个汉字」（C.3 的 UI 约束）。
 */
export function searchEvents(
  db: ReadDb,
  o: SearchEventsInput,
): SearchHit[] {
  const keyword = o.keyword;
  if ([...keyword].length === 0) return [];
  const { limit, offset } = paging(o);
  const scope = o.taskId;
  const timeline = o.order === "timeline";

  // 第一档：FTS。只在长度够 trigram 窗口时试（短于 3 必 0 命中，试了就是白付一次查询）。
  if ([...keyword].length >= TRIGRAM_MIN_CHARS) {
    const ftsSql = ftsSearchSql({ scope: scope !== undefined, order: timeline ? "timeline" : "recent" });
    const head: unknown[] = scope === undefined
      ? [quoteFtsPhrase(keyword)]
      : [quoteFtsPhrase(keyword), scope];
    const hits = runAll(db, ftsSql, [...head, limit, offset]);
    if (hits.length > 0) {
      return hits.map((r): SearchHit => ({ id: idOf(r), via: "fts" }));
    }
    // 0 命中才落到第二档。注意这是「FTS 说没有」而不是「FTS 报错」：
    // 报错一律往上抛，不在这里吞 —— 语法错误意味着转义坏了，静默降级到 LIKE
    // 会让「转义坏了」这件事永远查不出来（LIKE 通常也能命中，测试就一直是绿的）。
  }

  const pattern = "%" + escapeLikePattern(keyword) + "%";
  const likeHead: unknown[] = scope === undefined
    ? [pattern]
    : [pattern, scope];
  const likeSql = likeSearchSql({ scope: scope !== undefined, order: timeline ? "timeline" : "recent" });
  return runAll(db, likeSql, [...likeHead, limit, offset]).map(
    (r): SearchHit => ({ id: idOf(r), via: "like" }),
  );
}

function runAll(db: ReadDb, sql: string, params: readonly unknown[]): unknown[] {
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  return db.prepare(sql).all(...(params as never[]));
}

function idOf(row: unknown): number {
  const v = (row as { id?: unknown }).id;
  // node:sqlite 对 INTEGER 列可能返回 bigint（0004 记过同类形状）。
  // 不转的话 JSON.stringify 直接 TypeError: Do not know how to serialize a BigInt，
  // 症状是「打开回放页报 500」而不是「少一条结果」。
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  throw new Error(
    "检索结果的 id 不是数字，实到 " + typeof v + "。" +
      "SQL 里的列别名（rowid AS id）被改坏了，或者表结构变了。",
  );
}
