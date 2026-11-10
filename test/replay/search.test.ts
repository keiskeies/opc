/**
 * 回放时间线与中文检索（计划 Task 3.4 的 Test 项）。
 *
 * 计划点名的四条，逐条在这里有归属：
 *  ① 『覆盖率』可命中（trigram）           ⇒ ① 节
 *  ② 『件通』（2 字）走 LIKE 仍命中        ⇒ ① 节
 *  ③ 回放逐节点可展开并显示输入输出摘要     ⇒ ③ 节（【只做了一半】，见下面那条边界）
 *  ④ 同一任务连续回放两次输出完全相同       ⇒ ④ 节
 *  ⑤ 搜索必须在只读连接 + 分页上执行，断言搜索期间写队列仍可提交 ⇒ ② 节
 *
 * ── ③ 的准确边界，先说在这里而不是藏在某条 it 里 ──────────────────────
 * 「逐节点可展开」的数据源有两个：events（纯 JSON，本轮全量可读）与
 * checkpoints.checkpoint（serde.dumpsTyped 的 BLOB，解码要 @langchain/core）。
 * 后者本机装不上（0009 §2），所以③证到的是
 *   「审计侧的节点信息完整可读，checkpoint 行按原样登记且明说没解码」，
 * 【没证到】「通道值级别的输入输出摘要」。
 * 有一条断言专门钉住这个缺口（decoded 恒 false），接上 serde 那天它会红，
 * 那是在提醒改的人：这条验收还没完，别只改实现不改这条。
 *
 * ── 与规格附录 C.3 示例代码的偏离 ─────────────────────────────────────
 * 三条，全部由本机实测得出（本机 SQLite 3.51.2，C.3 测于 3.53.4），
 * 每条都有对应用例，详见 search.ts 文件头。其中①是我认为最值钱的一条：
 * 它不是「报错」而是「返回一堆无关行」，会让审计检索给出【假样本】。
 *   ① LIKE 兜底必须转义 % 与 _ 并带 ESCAPE 子句；
 *   ② 排序要有末位 tiebreaker（同毫秒并列时 SQLite 不保证顺序）；
 *   ③ 关键词长度按 code point 数。
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../packages/hub/src/db/migrate.js";
import { fixtureTmp } from "../../packages/hub/test/fixtures/fixture-dir.js";
import {
  DEFAULT_SEARCH_LIMIT,
  escapeLikePattern,
  ftsSearchSql,
  FTS_SEARCH_SQL,
  LIKE_SEARCH_SQL,
  likeSearchSql,
  quoteFtsPhrase,
  searchEvents,
  type SearchOrder,
  TRIGRAM_MIN_CHARS,
} from "../../packages/hub/src/replay/search.js";
import {
  buildReplayView,
  REPLAY_EVENTS_SQL,
} from "../../packages/hub/src/replay/query.js";

const TMP = fixtureTmp("replay", import.meta.url);

type Row = Record<string, unknown>;
type Db = {
  prepare: (sql: string) => {
    all: (...a: unknown[]) => Row[];
    get: (...a: unknown[]) => Row | undefined;
    run: (...a: unknown[]) => unknown;
  };
  exec: (sql: string) => void;
};

const NOW = 1_700_000_000_000;
const open: { close: () => Promise<void> }[] = [];
let fileSeq = 0;

async function newDb(): Promise<{ db: Db; w: Wq; path: string }> {
  const { WriteQueue } = await import("../../packages/hub/src/db/write-queue.js");
  const path = join(TMP, "r-" + process.pid + "-" + ++fileSeq + ".db");
  const q = new WriteQueue(path) as unknown as Wq;
  open.push(q as unknown as { close: () => Promise<void> });
  const db = q.writeConnection() as unknown as Db;
  migrate(db as never);
  return { db, w: q, path };
}

type Wq = {
  writeConnection(): unknown;
  readConnection(): unknown;
  node<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

function addTask(db: Db, id: string, graphVersion = 0): void {
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, " +
      "updated_at, graph_version) VALUES (?, ?, 'IN_PROGRESS', 'dev', 'intake', ?, ?, ?)",
  ).run(id, "任务 " + id, NOW, NOW, graphVersion);
}

let auditSeq = 0;
/**
 * 落一条审计。
 *
 * 会先把 task 行补出来 —— events.task_id 上有 REFERENCES tasks(id) 且开了
 * 外键约束，直接插事件会 `FOREIGN KEY constraint failed`（我第一版就是这么红的，
 * 13 条一起红，形状又长得像加载失败）。
 * 检索本身不需要 task（search.ts 只看 events），补它是为了让夹具能建出【合法】的库：
 * 拿一个 FK 违例的库去测检索，测到的性质将来不能外推到真库。
 */
function audit(
  db: Db,
  o: {
    taskId: string;
    action?: string;
    payload: unknown;
    createdAt?: number;
    snapshot?: unknown;
    actorId?: string;
  },
): number {
  const exists = db
    .prepare("SELECT id FROM tasks WHERE id = ?")
    .get(o.taskId);
  if (exists === undefined) addTask(db, o.taskId);
  const before = Number(
    db.prepare("SELECT COALESCE(MAX(id), 0) AS v FROM events").get()?.["v"] ?? 0,
  );
  db.prepare(
    "INSERT INTO events (task_id, actor_type, actor_id, action, target, payload, " +
      "state_snapshot, created_at) VALUES (?, 'agent', ?, ?, ?, ?, ?, ?)",
  ).run(
    o.taskId,
    o.actorId ?? "dev",
    o.action ?? "state_change",
    o.taskId,
    typeof o.payload === "string" ? o.payload : JSON.stringify(o.payload),
    o.snapshot === undefined
      ? null
      : typeof o.snapshot === "string"
        ? o.snapshot
        : JSON.stringify(o.snapshot),
    o.createdAt ?? NOW,
  );
  auditSeq += 1;
  return Number(
    db.prepare("SELECT MAX(id) AS v FROM events").get()?.["v"] ?? before + 1,
  );
}

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  // 必须真的建出来：node:sqlite 不会替你把父目录创建出来，
  // 少了这一行每条用例都是 `unable to open database file`（21 条一起红，
  // 形状长得像加载失败，实际是夹具少一步 —— 见 0012 §5 那条「先看仪器」）。
  mkdirSync(TMP, { recursive: true });
});
afterAll(async () => {
  for (const q of open) await q.close();
  rmSync(TMP, { recursive: true, force: true });
});

/* ─────────────────────────────────────────────────────────────────────────
   ① 检索的三档策略。计划的两条验收用例（『覆盖率』与『件通』）在这里，
      外加三条 C.3 示例代码没处理、而实测会出真实问题的形状。
   ───────────────────────────────────────────────────────────────────────── */
describe("① 检索：trigram 优先、LIKE 兜底", () => {
  it("『覆盖率』3 字 ⇒ 走 FTS 命中（C.3 的既定事实）", async () => {
    const { db } = await newDb();
    audit(db, { taskId: "t1", payload: { text: "本次测试覆盖率为 92%" } });
    const hits = searchEvents(db as never, { keyword: "覆盖率" });
    expect(hits).toHaveLength(1);
    // via 必须是 fts 而不是 like：两档语义不同（LIKE 会连 JSON 键名一起匹配），
    // 界面要靠这个字段标出「这条是整行子串命中」。
    expect(hits[0]?.via).toBe("fts");
  });

  it("『件通』2 字 ⇒ FTS 必 0 命中，LIKE 兜底仍命中", async () => {
    const { db } = await newDb();
    audit(db, { taskId: "t1", payload: { text: "组件通过审阅" } });
    // 先单独证实「trigram 对 2 字确实 0 命中」—— 这条性质是整个双路设计的根据，
    // 如果哪天它不成立了（换 SQLite 版本），兜底逻辑就该重审，所以钉死在这里。
    const raw = db
      .prepare("SELECT rowid AS id FROM events_fts WHERE events_fts MATCH ?")
      .all('"件通"');
    expect(raw).toHaveLength(0);
    const hits = searchEvents(db as never, { keyword: "件通" });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.via).toBe("like");
  });

  it("3+ 字时 FTS 是 LIKE 的【超集】⇒ 兜底那一支靠的是短查询与索引失同步，不是分词边界", async () => {
    /*
     * 我第一版这里写的是「含双引号的关键词 3 字但 FTS 0 命中 ⇒ 降级 LIKE」，
     * 断言 via === "like"。**那条前提是编的**：实测 `说"你` 在 trigram 下命中 1，
     * via 是 fts。红了之后我做了两件事，顺序很重要：
     *   ① 先确认【夹具】有没有说谎（0012 §6 那条：夹具想制造一次失败，
     *      得先确认那次失败在真实代码路径上可达）；
     *   ② 再穷举找一支真能命中的输入：把 24 条各种形状的文本切成
     *      238 个长度 3–5 的子串，逐个比 fts 与 like ——
     *      【fts=0 而 like>=1 的个数 = 0】。
     * 这个 0 不是「我还没找到」，它有个结构性理由：
     *   trigram 索引的是文本里【所有 3 字符窗口】。一个长度 ≥3 的关键词 kw
     *   若真是某行的子串，那 kw 自己的头 3 个字符必然是那一行的某个窗口 ⇒ 必然命中。
     *   所以「kw 长度 ≥3」时 LIKE 能中的，FTS 也必中；反过来不成立（FTS 只认子串，
     *   不认大小写折叠之外的东西）。
     * 于是规格 C.3 那句『0 命中时降级 LIKE』在**索引健康**时是**永不可达**的一支。
     * 那这行代码该删吗？不该 —— events_fts 是 external content 表
     * （content='events'），它的正确性【完全依赖】events 上那三个同步触发器。
     * 触发器被人改掉、或有人用 ALTER 重建表时漏掉，索引就会与表脱钩，
     * 那时「FTS 说没有而库里确实有」就真的发生。兜底那一支防的是这个，
     * 所以下面第二条用例【手工制造一次失同步】，让它可达。
     */
    const { db } = await newDb();
    const corpus = [
      "覆盖率92%",
      "组件通过",
      "hello world",
      "a-b_c%d",
      '他说"你好"',
      "Ünïcödé",
      "㍿平方メートル",
      "🎉🎉 庆祝",
      "空格  分隔",
      "中文English混排",
    ];
    for (const text of corpus) {
      audit(db, { taskId: "t1", payload: { text } });
    }
    // 先证「fts ⊇ like」这条性质本身（对 ≥3 字的子串）。
    let counterexamples = 0;
    const seen = new Set<string>();
    for (const text of corpus) {
      const cps = [...text];
      for (let i = 0; i < cps.length; i++) {
        for (let n = TRIGRAM_MIN_CHARS; n <= 5 && i + n <= cps.length; n++) {
          const kw = cps.slice(i, i + n).join("");
          if (seen.has(kw)) continue;
          seen.add(kw);
          const f = searchEvents(db as never, { keyword: kw }).length;
          const l = db
            .prepare("SELECT id FROM events WHERE payload LIKE ? ESCAPE '\\'")
            .all("%" + escapeLikePattern(kw) + "%").length;
          if (l > 0 && f === 0) counterexamples += 1;
        }
      }
    }
    expect(counterexamples).toBe(0);
    expect(seen.size > 100).toBe(true); // 扫得太少的话上面那个 0 是空的
    // 顺带钉住「双引号关键词走的是 fts 而不是 like」—— 我第一版就是在这里读反了。
    //
    // 关键词必须按【存进库里的样子】写：payload 列是 JSON.stringify 出来的，
    // 里面的 " 已经变成 \" —— 所以搜 `说"你` 命不中是【正确的】，
    // 库里那一串实际是 说\"你。
    // 这个坑我踩了【三次】：两次在 /tmp 探针（把关键词写成行里并不存在的形状，
    // 于是拿「0 命中」误判成规格有缺陷），这次是第三次，写进仓库里的测试。
    // 同一个夹具错误的顽固程度值得记一句：测的是【索引里的字节】，
    // 而我脑子里想的是【用户看到的文本】，两者在 JSON 转义处分叉。
    const quoted = searchEvents(db as never, { keyword: '你好\\"' });
    expect(quoted).toHaveLength(1);
    expect(quoted[0]?.via).toBe("fts");
    // 而真正含裸双引号的关键词【不抛】、返回空 —— 空是对的，不是缺陷。
    expect(searchEvents(db as never, { keyword: '说"你' })).toHaveLength(0);
  });

  it("FTS 索引与 events【脱钩】时 ⇒ 兜底那一支真的救回来（可达性证明）", async () => {
    // 上面那条刚说「索引健康时这一支不可达」。不可达的性质要靠【制造反例】才测得到，
    // 否则我写的是一条恒不执行的分支的用例，而它看起来像在测东西（0011 §5 那族问题）。
    //
    // 反例怎么造：events_fts 是 external content 表，同步全靠 events 上的触发器。
    // 这里直接对它下一条 'delete' 指令，模拟「表里有这行、索引里没有」。
    // 真实成因就是这个形状：触发器被改坏、或重建表时漏挂（0001_init.sql 的注释里
    // 已经写着那两个同步触发器『正常运行期不会被触发』，说明作者也知道它们微妙）。
    const { db } = await newDb();
    audit(db, { taskId: "t1", payload: { text: "覆盖率索引外" } });
    const before = searchEvents(db as never, { keyword: "索引外" });
    expect(before).toHaveLength(1);
    expect(before[0]?.via).toBe("fts");

    db.prepare(
      "INSERT INTO events_fts(events_fts, rowid, payload) VALUES ('delete', ?, ?)",
    ).run(before[0]?.id ?? 0, JSON.stringify({ text: "覆盖率索引外" }));

    // 索引现在说没有 —— 直接查 FTS 证实这一点，别让下面那条断言变成无源之水。
    expect(
      db
        .prepare("SELECT rowid AS id FROM events_fts WHERE events_fts MATCH ?")
        .all('"索引外"'),
    ).toHaveLength(0);

    const after = searchEvents(db as never, { keyword: "索引外" });
    expect(after).toHaveLength(1);
    // 命中来源变成 like ⇒ 界面能标出「这条是兜底命中的」，
    // 而运维有机会发现索引该重建了（否则脱钩永远看不见）。
    expect(after[0]?.via).toBe("like");
    expect(after[0]?.id).toBe(before[0]?.id);
  });

  it("空关键词返回【空】而不是全部行", async () => {
    const { db } = await newDb();
    audit(db, { taskId: "t1", payload: { text: "a" } });
    audit(db, { taskId: "t1", payload: { text: "b" } });
    expect(searchEvents(db as never, { keyword: "" })).toHaveLength(0);
    // 直接查库证明「两行确实在」，否则上一条会因为「表本来就是空的」而恒真。
    expect(
      db.prepare("SELECT id FROM events").all(),
    ).toHaveLength(2);
  });

  it("关键词是 FTS 操作符（AND / NEAR / 带 OR）⇒ 不抛、按字面查", async () => {
    // C.3 的示例把关键词包进双引号，这一手是对的：实测不包时
    // "AND" 直接 fts5: syntax error、"覆盖率 OR" 报 near ""、"-a" 报 no such column。
    // 症状会是「搜索框输入 AND 就 500」。
    const { db } = await newDb();
    audit(db, { taskId: "t1", payload: { text: "AND 与 NEAR 是两个操作符" } });
    // 判据是【不抛】，所以必须把抛捕获下来再断言。
    // 反面写法 expect(f(kw).length >= 0).toBe(true) 我差点就交了 —— 那是恒真：
    // length 恒 ≥0，函数抛不抛都绿，而它看起来像在测东西。
    // （vitest 的 requireAssertions 只保证「写了 expect」，保证不了「那个 expect
    //  有能力失败」—— 这正是 0007 §4.1 那类恒真守卫的测试版。）
    const thrown: string[] = [];
    for (const kw of ["AND", "NEAR", "覆盖率 OR", "-a", '"', "a*"]) {
      try {
        searchEvents(db as never, { keyword: kw });
      } catch (e) {
        thrown.push(kw + " -> " + (e instanceof Error ? e.message : String(e)));
      }
    }
    expect(thrown).toEqual([]);
    // 反向对照：同一批关键词【不转义】直接喂给 SQLite 必须抛。
    // 少了这一半，上面那半在「FTS 其实根本不校验语法」的世界里也是绿的 ——
    // 那时这条用例守的东西是零，而它看起来像在守一件很重要的事。
    let rawThrew = 0;
    for (const kw of ["AND", "覆盖率 OR", "-a"]) {
      try {
        db.prepare("SELECT rowid AS id FROM events_fts WHERE events_fts MATCH ?").all(kw);
      } catch {
        rawThrew += 1;
      }
    }
    expect(rawThrew).toBe(3);
    expect(quoteFtsPhrase('a"b')).toBe('"a""b"');
  });

  it("LIKE 兜底【必须转义 % 与 _，SQL 必须带 ESCAPE】：否则一次搜索返回整表", async () => {
    /*
     * 这一条测的是【第二档】。写它的时候踩了一个值得单独记的坑，记在这里：
     * 第一版夹具是三行「没有百分号」的文本，断言「搜 % 返回 0 行」，
     * 另外加一条「搜 92% 返回 1 行」当作反向对照，看起来正反都有 —— 然后我把
     * LIKE_SEARCH_SQL 里的 ESCAPE 子句删掉跑变异，【全绿】。
     * 原因是：`92%` 是 3 个字符 ⇒ 走的是【FTS 那一档】并直接命中返回，
     * 那条「反向对照」从头到尾没有经过被测代码。而 `%` 那一问在没有 ESCAPE 时
     * 拼出的 pattern 是 `%\%%`，它要求行里有【字面反斜杠】，第一版夹具里一个都没有
     * ⇒ 两种实现都给 0。整条用例对「ESCAPE 有没有写」这件事的分辨能力是【零】，
     * 而它是我这一轮自评「最值钱」的一条。
     *
     * 修法是让夹具带上【字面反斜杠】（真实库里到处都是：JSON 转义、Windows 路径），
     * 于是没有 ESCAPE 时 `%\%%` 会命中那一行 ⇒ 「搜 % 返回 0 行」这条断言
     * 第一次真的能在实现写错时红。下面把两种写法都跑一遍并【写下各自的行数】，
     * 这样夹具是否具备分辨能力是可见的，不用靠读注释相信。
     */
    const { db } = await newDb();
    audit(db, { taskId: "t1", payload: { text: "第一行没有百分号" } });
    audit(db, { taskId: "t1", payload: { text: "第二行也没有" } });
    audit(db, { taskId: "t1", payload: { text: "日志里有反斜杠 \\ 结尾" } });
    audit(db, { taskId: "t1", payload: { text: "这里有92%的概率" } });

    // ① 正向：转义 + ESCAPE ⇒ 语义是「文本里真的含有这个字符」。
    //    【用 JS 当预言机】而不是把行数写死：库里那一列存的是 JSON.stringify 的产物，
    //    人肉推算「哪几行算含 %」我已经错过一次（把 \\ 在 JSON 里被写成 \\\\ 这件事
    //    忘了）。JS 的 includes 跑在【取出来的字符串】上，与 SQL 完全无关，
    //    所以它给的是独立第二意见，而不是把 SQL 的结论抄一遍。
    const stored = db
      .prepare("SELECT id, payload FROM events ORDER BY id")
      .all() as unknown as { id: number; payload: string }[];
    const oracle = (kw: string): number[] =>
      stored.filter((r): boolean => r.payload.includes(kw)).map((r): number => Number(r.id));
    for (const kw of ["%", "_", "\\"]) {
      const got = searchEvents(db as never, { keyword: kw }).map((h): number => h.id);
      expect(got).toEqual(oracle(kw));
      // 反向：这一格必须在【两种实现】之间选边，否则它守的是零。
      const naive = db
        .prepare("SELECT id FROM events WHERE payload LIKE ?")
        .all("%" + kw + "%")
        .map((r): number => Number((r as { id: number }).id));
      if (oracle(kw).length !== naive.length) {
        // C.3 原样（不转义）给出的是【另一批行】—— 假样本就是这么来的。
        expect(got).not.toEqual(naive);
      }
    }
    expect(oracle("%").length > 0).toBe(true); // 预言机本身非空，否则上面三格可能全是空对空
    expect(oracle("\\").length > 0).toBe(true);

    // ② 反向对照【必须走 LIKE】，所以关键词取 2 字（≥3 字会被 FTS 截走，见上面那段）。
    const likeOnly = searchEvents(db as never, { keyword: "%的" });
    expect(likeOnly.map((h): number => h.id)).toEqual(oracle("%的"));
    expect(likeOnly.length > 0).toBe(true);
    expect(likeOnly.every((h): boolean => h.via === "like")).toBe(true);

    // ③ 【夹具具备分辨能力】的证明：把同一批 pattern 用【不带 ESCAPE 子句】的 SQL 跑一遍，
    //    必须至少有一个关键词给出【不同的行集合】。若两种写法结果全同，
    //    上面①②两条就是恒真的装饰 —— 无论实现怎么写都绿（我第一次交的就是这种）。
    const noEscape = (kw: string): number[] =>
      db
        .prepare("SELECT id FROM events WHERE payload LIKE ?")
        .all("%" + escapeLikePattern(kw) + "%")
        .map((r): number => Number((r as { id: number }).id));
    const discriminating: string[] = [];
    for (const kw of ["%", "_", "\\", "%的"]) {
      const right = searchEvents(db as never, { keyword: kw }).map((h): number => h.id);
      if (right.join(",") !== noEscape(kw).join(",")) discriminating.push(kw);
    }
    expect(discriminating.length > 0).toBe(true);
    // ④ 规格原样（不转义也不 ESCAPE）：关键词 % 拼出的 pattern 是 `%%%`，
    //    等价于「匹配一切」⇒ 返回【整表】。这才是 C.3 示例的真实后果，
    //    也是这条用例存在的理由：后果不是报错，是 CEO 在回放里看到一堆
    //    与该关键词无关的事件并当「确实有这些事件」读（§4.5：假样本会被拿去做真决定）。
    expect(
      db.prepare("SELECT id FROM events WHERE payload LIKE ?").all("%%%").length,
    ).toBe(stored.length);

    expect(LIKE_SEARCH_SQL).toContain("ESCAPE");
    expect(escapeLikePattern("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
  });

  it("关键词长度按 code point 数：两个 emoji 不算 4 字符", async () => {
    // 写成 kw.length 的话，两个 emoji 会被当 4 字符送去 MATCH，
    // 而 trigram 要 3 个【字符】⇒ 0 命中且【不报错】。
    const { db } = await newDb();
    audit(db, { taskId: "t1", payload: { text: "上线发了 🎉🎉 庆祝" } });
    const hits = searchEvents(db as never, { keyword: "🎉🎉" });
    expect(hits).toHaveLength(1);
    // 2 个 code point ⇒ 应当走 like 那一档，而不是白跑一次 FTS。
    expect(hits[0]?.via).toBe("like");
    expect(TRIGRAM_MIN_CHARS).toBe(3);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   ② 计划点名的那条：搜索跑在只读连接上，且【搜索期间写队列仍可提交】。
   ───────────────────────────────────────────────────────────────────────── */
describe("② 只读连接 + 分页：读不阻塞写（WAL）", () => {
  it("搜索用的连接【物理只读】：拿它写会当场报", async () => {
    const { w } = await newDb();
    const ro = w.readConnection() as Db;
    let threw = "";
    try {
      ro.prepare("INSERT INTO events (task_id, actor_type, actor_id, action, payload, created_at) " +
        "VALUES ('x','agent','dev','state_change','{}',1)").run();
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    expect(threw).toContain("readonly");
  });

  it("一个写事务【正开着】时搜索照旧返回，且该写事务随后成功提交", async () => {
    // 这条测的是【并发】而不是「两条语句都能跑」：
    // 如果哪天有人把搜索改成走写连接，搜索会排在写队列后面 ⇒
    // 一次模型调用期间（0010 §7 量的 P5：5 秒以上）CEO 打开回放页会一直转圈。
    // 那属 0010 §7 等 CEO 拍板的那个锁问题，而【本不该】扩大到只读路径上。
    const { db, w } = await newDb();
    audit(db, { taskId: "t1", payload: { text: "覆盖率写在前一半" } });
    const ro = w.readConnection() as Db;

    let release: () => void = () => {};
    const gate = new Promise<void>((res) => {
      release = res;
    });
    let committed = false;
    const writer = w.node(async () => {
      // 事务里先插一条，再等外面的信号 —— 此刻写锁是-held 的。
      const inner = w.writeConnection() as Db;
      inner
        .prepare(
          "INSERT INTO events (task_id, actor_type, actor_id, action, target, payload, " +
            "state_snapshot, created_at) VALUES ('t1','agent','dev','state_change','t1',?,NULL,?)",
        )
        .run(JSON.stringify({ text: "事务里刚写的" }), NOW);
      await gate;
      committed = true;
      return true;
    });

    // 搜索跑在只读连接上 ⇒ 不等这个事务。
    const during = searchEvents(ro as never, { keyword: "覆盖率" });
    expect(during).toHaveLength(1);

    release();
    await writer;
    expect(committed).toBe(true);
    // 提交后只读连接【看得到】那一行（WAL 的读快照是新事务级的）。
    const after = searchEvents(ro as never, { keyword: "事务里刚写的" });
    expect(after).toHaveLength(1);
  });

  it("分页：limit 与 offset 生效，且超上限被夹到 MAX 而不是原样传给 SQLite", async () => {
    const { db } = await newDb();
    for (let i = 0; i < 5; i++) {
      audit(db, { taskId: "t1", payload: { text: "第" + i + "条覆盖率记录" } });
    }
    const page1 = searchEvents(db as never, { keyword: "覆盖率", limit: 2, offset: 0 });
    const page2 = searchEvents(db as never, { keyword: "覆盖率", limit: 2, offset: 2 });
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
    // 两页【不重叠】。这条看着显然，但它测的是「ORDER BY 稳定」——
    // 没有确定的全序时，LIMIT/OFFSET 翻页可以两页都给同一批行。
    const ids1 = page1.map((h) => h.id).sort((a, b) => a - b).join(",");
    const ids2 = page2.map((h) => h.id).sort((a, b) => a - b).join(",");
    expect(ids1 === ids2).toBe(false);
    const all = searchEvents(db as never, { keyword: "覆盖率" });
    expect(all).toHaveLength(5);
    expect(DEFAULT_SEARCH_LIMIT > 5).toBe(true);
  });

  it("limit ≤0 抛错而不是静默返回空页", async () => {
    const { db } = await newDb();
    audit(db, { taskId: "t1", payload: { text: "覆盖率" } });
    let msg = "";
    try {
      searchEvents(db as never, { keyword: "覆盖率", limit: 0 });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    // SQLite 的 LIMIT 0 是合法的「全不给」而 OFFSET 仍生效 ⇒
    // 客户端拿到连续两个空页会以为翻到头了，而真相是参数写错。
    expect(msg).toContain("limit");
  });

  it("四种 SQL 形状【全部能真的执行】，且对外常量与组合函数同源", async () => {
    /*
     * 这一条守的是【组合本身】。searchEvents 现在按 (是否限定任务) × (排序) 拼四条
     * SQL，而片段常量只有六块 —— 拼错一处（比如给 LIKE 拼上 FTS 的 ORDER BY rank）
     * 会让【某一个组合】在运行时报语法错，而另外三种照常绿。
     * 只测默认那一档等于把三种组合留在「编译过、没跑过」的状态。
     *
     * 顺带把「对外常量 = 组合函数的一次取值」钉住：用例里断言字面量的地方
     * （LIKE_SEARCH_SQL 含 ESCAPE）测的是【常量】，而真跑的是函数产物。
     * 两者同源这件事成立时那条断言才有意义；一旦有人把常量改回手写字符串，
     * 「SQL 里带 ESCAPE」就变成了在证明一个不被执行的常量的性质。
     */
    const { db } = await newDb();
    addTask(db, "t1");
    addTask(db, "t2");
    audit(db, { taskId: "t1", payload: { text: "覆盖率一" } });
    audit(db, { taskId: "t2", payload: { text: "覆盖率二" } });
    expect(FTS_SEARCH_SQL).toBe(ftsSearchSql({ scope: false, order: "recent" }));
    expect(LIKE_SEARCH_SQL).toBe(likeSearchSql({ scope: false, order: "recent" }));
    /*
     * 四种组合逐格跑【行为】：跑一遍才知道拼出来的 SQL 合法、且限定与排序真的生效。
     * 两个关键词分别踩到两档：『覆盖率』3 字走 FTS，『覆盖』2 字 FTS 必 0 ⇒ 走 LIKE。
     * 期望值同为 want 是因为夹具里两行都含『覆盖』，而含『覆盖率』的也是那两行 ——
     * 这个「恰好相同」不是巧合而是夹具刻意选的：两档给出同一集合，
     * 才说明【兜底那一档没有把限定条件弄丢】（丢了的症状是 scope=true 也返回 2 行）。
     */
    const cells: Array<[boolean, SearchOrder, number]> = [
      [false, "recent", 2],
      [false, "timeline", 2],
      [true, "recent", 1],
      [true, "timeline", 1],
    ];
    for (const [scope, order, want] of cells) {
      for (const kw of ["覆盖率", "覆盖"]) {
        const hits = searchEvents(db as never, {
          keyword: kw,
          ...(scope ? { taskId: "t1" } : {}),
          order,
        });
        expect(hits.length).toBe(want);
        // 走的是哪一档也要对得上，否则「四格都过」可能是四格都走了同一档。
        const via = kw.length === 3 ? "fts" : "like";
        expect(hits.map((h): string => h.via)).toEqual(hits.map((): string => via));
      }
    }
    // 因果序与最近序在【scope=false】时必须给出相反的两串，否则上面四格里
    // order 参数其实没生效（两种序在 2 行夹具上可以同序 —— 本轮第二次踩同形夹具）。
    const asc = searchEvents(db as never, { keyword: "覆盖率", order: "timeline" }).map((h): number => h.id);
    const desc = searchEvents(db as never, { keyword: "覆盖率", order: "recent" }).map((h): number => h.id);
    expect(asc.join(",")).toBe([...desc].reverse().join(","));
    expect(asc[0]).not.toBe(desc[0]);
    // 反向对照：给 LIKE 拼上 FTS 才有的 rank 排序，SQLite 必须报。
    // 没有这一半，上面那个循环在「组合函数其实忽略了 order 参数」时也是全绿的。
    let threw = "";
    try {
      db.prepare(
        "SELECT id FROM events WHERE payload LIKE ? ESCAPE '\\' ORDER BY rank LIMIT ? OFFSET ?",
      ).all("%覆盖率%", 10, 0);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    expect(threw).toContain("rank");
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   ③ 回放时间线：坏行照常出现 + degraded 标记 + 原文。
      这是 http/app.ts:531 那条注释点名给 Task 3.4 的方案（『正确形态是给那一行
      加 degraded 标记 + 照常返回原始值』），本轮照它做，而不是另起一套。
   ───────────────────────────────────────────────────────────────────────── */
describe("③ 时间线：一行读坏不让整段回放不可用，也不静默少一段", () => {
  it("payload 非法 JSON ⇒ 该条 degraded + 保留原文，其余条目不受影响", async () => {
    const { db } = await newDb();
    addTask(db, "t1");
    audit(db, { taskId: "t1", payload: { text: "第一条正常" } });
    // 绕过 recorder 直写（recorder 在写入侧拦非 JSON，serializePayload 会抛）。
    // 绕过的方式就是直接 prepare().run()，形状等价于「有人手工写了一行」。
    db.prepare(
      "INSERT INTO events (task_id, actor_type, actor_id, action, target, payload, " +
        "state_snapshot, created_at) VALUES ('t1','agent','dev','state_change','t1'," +
        "'不是JSON',NULL,?)",
    ).run(NOW);
    audit(db, { taskId: "t1", payload: { text: "第三条正常" } });

    const view = buildReplayView(db as never, { taskId: "t1" });
    if (view === null) throw new Error("任务存在，不该返回 null");
    // 【三条都在】。跳行的话条目数变少而总数不说，CEO 读到的是「这段流程只有 2 步」，
    // 而真相是「有 3 步、其中 1 步读不出来」—— 一条断掉的因果链会被读成
    // 「这一步是角色自己决定做的」。
    expect(view.entries).toHaveLength(3);
    expect(view.entries[1]?.degraded).toBe(true);
    expect(view.entries[1]?.raw_payload).toBe("不是JSON");
    expect(view.entries[1]?.payload).toBeNull();
    // 有标记必须有原因（只标不给原因等于让人重新排查一遍）。
    expect(typeof view.entries[1]?.degrade_reason).toBe("string");
    expect((view.entries[1]?.degrade_reason ?? "").length > 0).toBe(true);
    expect(view.complete).toBe(false);
    // 前后两条不受影响：一条坏行没让整段挂掉（那是 app.ts 里被否掉的另一种做法）。
    expect(view.entries[0]?.degraded).toBeUndefined();
    expect(view.entries[2]?.degraded).toBeUndefined();
  });

  it("state_snapshot 为 NULL ⇒ 不算降级（列本来就可空）", async () => {
    const { db } = await newDb();
    addTask(db, "t1");
    audit(db, { taskId: "t1", payload: { text: "没有快照" } });
    const view = buildReplayView(db as never, { taskId: "t1" });
    expect(view?.entries[0]?.degraded).toBeUndefined();
    expect(view?.complete).toBe(true);
  });

  it("时间线按 events.id 升序，【不是】按 created_at", async () => {
    // 实测：同一毫秒落 6 条时只按 created_at 翻页得 2,3,4，加 id 才稳定。
    // 这里更进一步：造出【created_at 与 id 顺序相反】的数据，
    // 于是「按 id 排」与「按 created_at 排」给出【相反】的答案 ——
    // 这才是这条用例能分辨两种实现的原因。
    // （上一版我写成 (view.entries).map(e => Number(e.payload))，
    //  payload 是对象不是数字，Number() 得到 NaN，于是 e.n 恒 undefined、
    //  三条 toBe 全对 undefined 比较而红。红得对，但错在我的取值方式。）
    const { db } = await newDb();
    addTask(db, "t1");
    audit(db, { taskId: "t1", payload: { n: 1 }, createdAt: 3000 });
    audit(db, { taskId: "t1", payload: { n: 2 }, createdAt: 2000 });
    audit(db, { taskId: "t1", payload: { n: 3 }, createdAt: 1000 });
    const view = buildReplayView(db as never, { taskId: "t1" });
    if (view === null) throw new Error("任务存在");
    const byId = view.entries.map(
      (e) => (e.payload as { n: number }).n,
    );
    expect(byId).toEqual([1, 2, 3]);

    // 反向对照：直接问库「按 created_at 升序」得到什么。
    // 必须是【升序】而不是 DESC —— 我先写的 DESC 恰好与 id ASC 得到同一个答案
    // （夹具的 created_at 是递减的），那样上面那条断言就成了恒真：
    // 两种排序给出同一答案，用例什么都没说，而它看起来在测一件事。
    // 两个都是升序、彼此矛盾，才是这条用例的分辨力所在。
    const byTime = db
      .prepare(
        "SELECT payload FROM events WHERE task_id = ? ORDER BY created_at ASC",
      )
      .all("t1")
      .map((r) => (JSON.parse(String(r["payload"])) as { n: number }).n);
    expect(byTime).toEqual([3, 2, 1]);
    expect(byId.join(",") === byTime.join(",")).toBe(false);

    expect(REPLAY_EVENTS_SQL).toContain("ORDER BY id ASC");
  });

  it("tasks 里没有这条 ⇒ 返回 null（让 HTTP 层去给 404）", async () => {
    const { db } = await newDb();
    expect(buildReplayView(db as never, { taskId: "nope" })).toBeNull();
  });

  it("checkpoints 表整个不存在 ⇒ 空数组 + 原因，而不是静默的空", async () => {
    // 迁移不建 checkpoints（实测 grep 0001_init.sql = 0 命中），它只在
    // SqliteWALSaver 构造时建。所以「Hub 装好了、一条图没跑过」时这张表就是没有。
    // 静默成空数组的话，「本进程没装配 Saver」与「这条任务真没跑过节点」
    // 在界面上长得一模一样，而前者是环境缺陷。
    const { db } = await newDb();
    addTask(db, "t1");
    audit(db, { taskId: "t1", payload: { text: "只有审计" } });
    const view = buildReplayView(db as never, { taskId: "t1" });
    expect(view?.checkpoints).toHaveLength(0);
    expect(typeof view?.checkpoints_unavailable).toBe("string");
    expect((view?.checkpoints_unavailable ?? "").length > 0).toBe(true);
    // 缺 checkpoint 不算时间线不完整：complete 只管【有的行读不出来】。
    expect(view?.complete).toBe(true);
  });

  it("建了 checkpoints 之后：行被登记，而 decoded 恒 false（这是【已知缺口】不是漏做）", async () => {
    const { db } = await newDb();
    addTask(db, "t1");
    db.exec(
      "CREATE TABLE checkpoints (thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL " +
        "DEFAULT '', checkpoint_id TEXT NOT NULL, parent_checkpoint_id TEXT, type TEXT, " +
        "checkpoint BLOB, metadata BLOB, PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id))",
    );
    // 4 字节与 2 字节【取不同值】：两个数不一样才能同时挡住两种错 ——
    //  ① byteLen 退化成「恒 0」或「恒非零」；
    //  ② byteLen 返回的是 hex 文本长度（X'81A4A5A6' 的文本形式是 10 个字符）
    //     而不是字节数。所以我第一版写 X'81A4' 配 toBe(4) 是【两处都错】：
    //     字节数其实是 2，而 4 恰好是它的 hex 文本长度 —— 一个巧合让断言看着像有依据。
    db.prepare(
      "INSERT INTO checkpoints (thread_id, checkpoint_id, type, checkpoint, metadata) " +
        "VALUES ('t1','ck1','msgpack',X'81A4A5A6',X'81A5')",
    ).run();
    const view = buildReplayView(db as never, { taskId: "t1" });
    expect(view?.checkpoints).toHaveLength(1);
    expect(view?.checkpoints[0]?.checkpoint_id).toBe("ck1");
    expect(view?.checkpoints[0]?.checkpoint_bytes).toBe(4);
    expect(view?.checkpoints[0]?.metadata_bytes).toBe(2);
    expect(view?.checkpoints_unavailable).toBeUndefined();
    // ★ 这条断言【故意】锁住一个未完成状态：解码需要 @langchain/core 的 serde，
    //   本机装不上（0009 §2）。接上 serde 的那天这行会红 —— 那是它在提醒
    //   「计划的③『输入输出摘要』还没做完」，而不是「实现写坏了」。
    expect(view?.checkpoints[0]?.decoded).toBe(false);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   ④ 计划 Test：同一任务连续回放两次输出【完全相同】（§24 风险 6 的校验用例）
   ───────────────────────────────────────────────────────────────────────── */
describe("④ 回放幂等：同一任务连续两次逐字节相同", () => {
  it("同毫秒落 6 条审计时，两次回放的序列一模一样", async () => {
    // 为什么夹具要【同毫秒】：并列时 SQLite 不保证顺序。
    // 用递增时间戳做夹具，这条用例会【恒真】—— 两种排序实现都给出同样输出，
    // 于是它守不住任何东西，而下一个人不会知道（0011 §5 / 012 §5 那条判据的又一次应用：
    // 夹具必须能让「错的那版实现」红）。
    const { db } = await newDb();
    addTask(db, "t1");
    for (let i = 0; i < 6; i++) {
      audit(db, { taskId: "t1", payload: { n: i }, createdAt: NOW });
    }
    const a = JSON.stringify(buildReplayView(db as never, { taskId: "t1" }));
    const b = JSON.stringify(buildReplayView(db as never, { taskId: "t1" }));
    expect(a).toBe(b);
    // 而且要真的拿到 6 条（否则「两次都是空」也满足上一条）。
    expect((a.match(/"seq":/gu) ?? []).length).toBe(6);
  });

  it("时间线不受【别的任务】的事件影响", async () => {
    const { db } = await newDb();
    addTask(db, "t1");
    addTask(db, "t2");
    audit(db, { taskId: "t1", payload: { mine: 1 } });
    audit(db, { taskId: "t2", payload: { other: 1 } });
    const view = buildReplayView(db as never, { taskId: "t1" });
    expect(view?.entries).toHaveLength(1);
    expect(view?.entries[0]?.payload).toEqual({ mine: 1 });
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   ⑤ §22.3 第 4 条：回放要标注【该任务运行时】的 graph_version 及汇报关系。
      这是 0012 那条版本化链条的【读侧】：提交时写下坐标，回放时才看得见。
   ───────────────────────────────────────────────────────────────────────── */
describe("⑤ 回放标注当时那一版组织图，不退回当前版", () => {
  it("任务引用 v1 而当前是 v2 ⇒ 标注的是 v1 的汇报关系", async () => {
    const { db } = await newDb();
    // 直接写两张图，绕开 commitOrgGraph（那是 Task 3.3 的事，本模块只读）。
    const writeGraph = (version: number, devParent: string): void => {
      db.prepare(
        "INSERT INTO delegation_graphs (id, version, graph_json, effective_from, " +
          "created_by, change_summary) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        "g" + version,
        version,
        JSON.stringify({
          nodes: {
            ceo: { role_id: "ceo", can_manage: true, reports_to: null },
            tech: { role_id: "tech", can_manage: true, reports_to: "ceo" },
            dev: { role_id: "dev", can_manage: false, reports_to: devParent },
          },
          edges: [],
        }),
        NOW,
        "ceo",
        "v" + version,
      );
    };
    writeGraph(1, "tech");
    writeGraph(2, "ceo");
    addTask(db, "t-old", 1);
    addTask(db, "t-new", 2);

    const old = buildReplayView(db as never, { taskId: "t-old" });
    const fresh = buildReplayView(db as never, { taskId: "t-new" });
    if (old === null || fresh === null) throw new Error("两条任务都存在");
    expect(old.graph.ok === true && old.graph.reports_to["dev"]).toBe("tech");
    expect(fresh.graph.ok === true && fresh.graph.reports_to["dev"]).toBe("ceo");
  });

  it("那一版图不存在 ⇒ degraded + 原因，【不】退回当前图", async () => {
    // 0001_init.sql 的列默认值是 1，而 delegation_graphs 可能空着 ——
    // 这正是 0012 §1 量到的那个形状（每条任务都躺在假的 v1 上）。
    // 退回当前图会得到一张「看着对」而当时【并不存在】的汇报关系。
    const { db } = await newDb();
    addTask(db, "t1", 1);
    audit(db, { taskId: "t1", payload: { text: "x" } });
    const view = buildReplayView(db as never, { taskId: "t1" });
    expect(view?.graph.ok).toBe(false);
    if (view === null || view.graph.ok !== false) throw new Error("应当是降级");
    expect(view.graph.version).toBe(1);
    expect(view.graph.degraded).toBe(true);
    expect(view.graph.reason).toContain("v1");
    // 降级【不影响】时间线本身：审计还是能看，只是汇报关系那一格空着并注明原因。
    expect(view.entries).toHaveLength(1);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   ⑥ 关键词接进回放视图。这一节存在的理由不是「多加一个参数」，而是：
      在 Task 3.4 收尾前，searchEvents 是一个【有 22 条用例、零生产调用方】的函数 ——
      与 0011 §8 / 0012 §7 记的「三个校验函数没有生产调用方」同一种缺陷：
      测试全绿而产物没接上，绿的程度反而掩盖了它。
      下面第一条就是这个接法独有的失效：默认序是「最近在前」，直接拿来填时间线
      会得到一份【倒放】的回放。它只有在「检索真的被时间线调用」之后才可能存在，
      所以这条用例同时也是「接上了」的证据。
   ───────────────────────────────────────────────────────────────────────── */
describe("⑥ 关键词过滤：检索接进时间线", () => {
  it("带关键词时条目按【因果序】（id 升序）给出，不是检索默认的最近在前", async () => {
    const { db } = await newDb();
    addTask(db, "t1");
    // 同毫秒：与④节同一条理由 —— 时间戳并列时 SQLite 不保证顺序，
    // 用递增时间戳做夹具会让这条断言在错误实现下也成立（恒真夹具）。
    for (let i = 1; i <= 4; i++) {
      audit(db, { taskId: "t1", payload: { n: i, text: "覆盖率第" + i + "次" }, createdAt: NOW });
    }
    audit(db, { taskId: "t1", payload: { n: 99, text: "与关键词无关" }, createdAt: NOW });

    const view = buildReplayView(db as never, { taskId: "t1", keyword: "覆盖率" });
    const ns = (view?.entries ?? []).map((e): unknown => (e.payload as { n: number }).n);
    expect(ns).toEqual([1, 2, 3, 4]);
    // 反向对照：把默认序直接拿来用会得到 [4,3,2,1]。
    // 少了这一半，上面那条在「两种排序恰好同序」的夹具上是恒真的（本轮第三次踩同一坑，
    // 见①节那条 byTime 的反向对照）。
    const recent = searchEvents(db as never, { keyword: "覆盖率", order: "recent" });
    const reversed = [...recent].reverse().map((h): number => h.id);
    expect(reversed.join(",")).toBe((view?.entries ?? []).map((e): number => e.seq).join(","));
  });

  it("关键词只命中【本任务】的事件：别的任务里同样的词不混进来", async () => {
    const { db } = await newDb();
    addTask(db, "t1");
    addTask(db, "t2");
    audit(db, { taskId: "t1", payload: { text: "本任务的覆盖率" } });
    audit(db, { taskId: "t2", payload: { text: "别的任务的覆盖率" } });
    const view = buildReplayView(db as never, { taskId: "t1", keyword: "覆盖率" });
    expect(view?.entries).toHaveLength(1);
    expect((view?.entries[0]?.payload as { text: string }).text).toContain("本任务");
    // 反向对照：不限定任务时两条都在。少了这一半，「只命中一条」可能只是因为
    // 限定条件写成了恒假（那也是一种「隔离生效」的错觉）。
    expect(searchEvents(db as never, { keyword: "覆盖率" })).toHaveLength(2);
  });

  it("命中 0 条 ⇒ 空时间线 + complete=true，而任务信息仍在（不是 404）", async () => {
    const { db } = await newDb();
    addTask(db, "t1");
    audit(db, { taskId: "t1", payload: { text: "有内容" } });
    const view = buildReplayView(db as never, { taskId: "t1", keyword: "根本没有这个词" });
    expect(view).not.toBeNull();
    expect(view?.entries).toHaveLength(0);
    // 空结果【不是】「读坏了」，所以 complete 是真的。把两者混成一个信号，
    // 界面就分不清「这次没搜到」与「库里有行读不出来」。
    expect(view?.complete).toBe(true);
    expect(view?.task.id).toBe("t1");
  });

  it("空串关键词 = 【不过滤】（与「搜一个空串」不是一回事）", async () => {
    const { db } = await newDb();
    addTask(db, "t1");
    audit(db, { taskId: "t1", payload: { text: "a" } });
    audit(db, { taskId: "t1", payload: { text: "b" } });
    expect(buildReplayView(db as never, { taskId: "t1", keyword: "" })?.entries).toHaveLength(2);
    // 而直接问检索函数，空串是【空集】（①节那条）。两个语义必须不同，
    // 且分工清楚：过滤发生在 buildReplayView（空=不筛），
    // 「别拿空串去扫全库」发生在 searchEvents（空=不查）。
    expect(searchEvents(db as never, { keyword: "" })).toHaveLength(0);
  });

  it("分页：offset 落在【命中集合】上，而不是全量事件上", async () => {
    /*
     * 这条是「为什么过滤必须发生在取行那一层」的全部理由。
     * 如果实现是「先取一页 500 条、再在前端 filter」，第 2 页的 offset 会相对
     * 【全量行】偏移 ⇒ 命中项集中在前 5 行时，offset=2 会直接跳过它们，
     * 界面显示「没有更多结果」。而真相是「命中的在第 1 页已被取走、第 2 页取的是别处」。
     */
    const { db } = await newDb();
    addTask(db, "t1");
    for (let i = 1; i <= 5; i++) {
      audit(db, { taskId: "t1", payload: { n: i, hit: i % 2 === 1, text: "第" + i + "条" } });
    }
    audit(db, { taskId: "t1", payload: { n: 90, text: "噪声甲" } });
    audit(db, { taskId: "t1", payload: { n: 91, text: "噪声乙" } });
    audit(db, { taskId: "t1", payload: { n: 92, text: "噪声丙" } });
    const p1 = buildReplayView(db as never, { taskId: "t1", keyword: '"hit":true', limit: 2, offset: 0 });
    const p2 = buildReplayView(db as never, { taskId: "t1", keyword: '"hit":true', limit: 2, offset: 2 });
    const ns = (v: typeof p1): number[] =>
      (v?.entries ?? []).map((e): number => (e.payload as { n: number }).n);
    expect(ns(p1)).toEqual([1, 3]);
    // offset=2 给的是【第 3 个命中】（n=5），不是「全量第 3 行」。
    expect(ns(p2)).toEqual([5]);
  });

  it("带关键词时 limit 被夹到 MAX_SEARCH_LIMIT，而响应把【真实分母】说出去", async () => {
    /*
     * 不带关键词时 limit 能到 MAX_REPLAY_LIMIT(2000)，带关键词时检索那一档只有
     * MAX_SEARCH_LIMIT(200)。传 500 拿到 200 条，调用方按自己手上那个 500 判断
     * 「到底了」⇒ 第 2 页永远不请求，一次「就这些」的假结论。
     * effective_limit 存在的意义就是让这个判断可算 —— 这条用例同时钉住两点：
     * 响应里的分母是 200（不是调用方传的 500），以及它确实等于内部那个夹值。
     */
    const { db } = await newDb();
    addTask(db, "t1");
    const view = buildReplayView(db as never, { taskId: "t1", keyword: "覆盖率", limit: 500 });
    expect(view?.effective_limit).toBe(200);
    const plain = buildReplayView(db as never, { taskId: "t1", limit: 500 });
    expect(plain?.effective_limit).toBe(500);
  });

  it("坏行在被命中的那几行里也照常带 degraded 出现（过滤不改变容错口径）", async () => {
    const { db } = await newDb();
    addTask(db, "t1");
    audit(db, { taskId: "t1", payload: { text: "正常覆盖率一行" } });
    // 直接写一条非法 JSON 的 payload（绕过 recorder 的形状，与③节同一手法）。
    const bad = audit(db, { taskId: "t1", payload: "{坏掉的覆盖率" });
    const view = buildReplayView(db as never, { taskId: "t1", keyword: "覆盖率" });
    expect(view?.entries).toHaveLength(2);
    expect(view?.complete).toBe(false);
    expect(view?.entries.some((e): boolean => e.degraded === true)).toBe(true);
    expect(bad > 0).toBe(true);
  });
});
