/**
 * Task 6.4 那批基准数的【复算脚本】（docs/decisions/0019 §1 第 9~12 条、§6 最后两条）。
 *
 * 跑法（约 1~2 分钟，要建 10 万事件 + 一次 FTS rebuild）：
 *
 *   PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH \
 *     node --experimental-transform-types packages/hub/scripts/bench-recompute.mjs
 *
 * 与测试跑法的区别：不需要 --import /tmp/opc-harness。
 * 一是因为它不 import vitest，二是解析钩子就在 ./ts-resolve-hook.mjs 里、
 * 由本文件自己注册（见下面那段动态 import 的理由）。
 * 库落在 packages/hub/.tmp/bench-recompute.db（.gitignore 里），每次跑先删重建，
 * 所以复算不依赖任何人手上那个探针库 —— 这一条正是 0019 §1 第 13 条要的：
 * 那一轮我把「同一句 SQL 在两份库上差 30 倍」记成两个自洽的事实，
 * 真相是两份库的 sqlite_master 差着两个手工建过又忘了的实验索引。
 * 复算因此必须是【一份自己重建的库】，而不是「去找当初那个库」。
 *
 * ── 为什么不复制 SQL 文本而 import ─────────────────────────────────
 * PATROL_SQL 与 ftsSearchSql 是从 src 直接取的。抄一份 SQL 进脚本，
 * 三个月后这条索引失效了脚本还是绿的（0006 §7 那一族「第二份抄本」问题；
 * patrol.ts 的 kindOf 导出就是为了不在测试里重写表达式，同一个理由）。
 *
 * ── 为什么这脚本【不断言】任何毫秒数 ────────────────────────────────
 * 毫秒数换台机器就不成立，而「基准测试因为机器抖动变红之后被人放宽」这条
 * 我在 perf-thresholds.test.ts 文件头写过它守的是空气。所以这里只【打印】。
 * 断言（比值、EXPLAIN 计划形状）在 test/acceptance/perf-thresholds.test.ts，
 * 那才是门禁。这个脚本的用途是：文档里那些数能不能被任何人重出来。
 */
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 注册解析钩子【之后】才能碰 src：静态 import 会在任何一行代码跑起来之前
// 就去解析 src/db/driver.ts 里那句 `import "./pragmas.js"`，于是钩子还没装上就已经炸了
// （症状是 pragmas.js 找不到，看着像文件被删）。所以这一批必须是动态 import。
await import("./ts-resolve-hook.mjs");
const { openDb } = await import("../src/db/driver.ts");
const { migrate } = await import("../src/db/migrate.ts");
const { WriteQueue } = await import("../src/db/write-queue.ts");
const { appendAuditBatch } = await import("../src/events/batch.ts");
const { PATROL_SQL } = await import("../src/heartbeat/patrol.ts");
const { ftsSearchSql, searchEvents } = await import("../src/replay/search.ts");

const HUB = join(dirname(fileURLToPath(import.meta.url)), "..");
const PATH_ = join(HUB, ".tmp", "bench-recompute.db");
const EVENTS = 100_000;
const TASKS = 50;
const IDX = "idx_events_task_kind_created";

rmSync(PATH_, { recursive: true, force: true });
rmSync(PATH_ + "-wal", { force: true });
rmSync(PATH_ + "-shm", { force: true });
mkdirSync(dirname(PATH_), { recursive: true });

const TASK_IDS = Array.from({ length: TASKS }, (_, i) => "T" + i);
/** 正文里嵌行号，好让「命中多少个」能被精确造出来（§6 那条 rank 阶梯要用）。 */
function rows(from, n) {
  return Array.from({ length: n }, (_, i) => {
    const id = TASK_IDS[(from + i) % TASKS];
    return {
      taskId: id,
      actorType: "system",
      actorId: "hub",
      action: "state_change",
      target: null,
      payload: {
        kind: "TaskStateChanged",
        taskId: id,
        note: "回放检索基准的合成正文" + (from + i),
      },
    };
  });
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
/** 一趟都不许吞：抛错本身就是这一档的结论（0019 §1 第 11 条那类）。 */
function timed(f, k = 9) {
  const a = [];
  for (let i = 0; i < k; i++) {
    const t = performance.now();
    try {
      f();
    } catch (e) {
      return "throw: " + e.message.slice(0, 60);
    }
    a.push(performance.now() - t);
  }
  return median(a);
}
const ms = (x) => (typeof x === "number" ? x.toFixed(2).padStart(8) + " ms" : String(x).padStart(11));
const head = (s) => console.log("\n── " + s + " " + "─".repeat(Math.max(0, 62 - s.length)));

// ── 建库 ────────────────────────────────────────────────────────────
{
  const db = openDb(PATH_);
  migrate(db);
  for (const id of TASK_IDS) {
    db.prepare(
      "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
        "VALUES (?, ?, 'IN_PROGRESS', 'dev', 'implement', ?, ?)",
    ).run(id, "复算任务 " + id, 1, 1);
  }
  db.close();
}
const q = new WriteQueue(PATH_);
{
  const t0 = performance.now();
  let written = 0;
  while (written < EVENTS) {
    const r = await appendAuditBatch(q, rows(written, Math.min(2000, EVENTS - written)), () => 1);
    written += r.written;
  }
  head("建库");
  console.log(
    "  " + EVENTS + " 事件 / " + TASKS + " 任务，用 " + ((performance.now() - t0) / 1000).toFixed(1) + "s",
  );
}
const read = q.readConnection();
const w = openDb(PATH_); // 只有这里需要 DDL：DROP / CREATE 那条受控索引
const hasIdx = () =>
  w.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='index' AND name=?").get(IDX) !== undefined;
const dropIdx = () => w.exec("DROP INDEX IF EXISTS " + IDX);
/**
 * 与 0003 那份 DDL 同一句表达式（守卫缺失会静默改结论，见 0003 文件头）。
 * cols 只给【列清单】；部分索引的 WHERE 在括号【外面】——
 * 第一版把它写在括号里，SQLite 报 "near WHERE: syntax error"，
 * 而那正是这一节要量的一档，语法错了就等于那一档从没被测过。
 */
const createIdx = (cols, where) =>
  w.exec(
    `CREATE INDEX ${IDX} ON events(${cols})` + (where ? ` WHERE ${where}` : ""),
  );
const KIND_EXPR = "CASE WHEN json_valid(payload) THEN json_extract(payload, '$.kind') END";

/**
 * ⚠ 每次改过 DDL 之后，【必须换一条新连接】去取 EXPLAIN 与计时。
 * 这不是凭空的谨慎：第一版复用同一条长驻读连接，某一轮测出
 * 「把索引 DROP 掉、换成另一个名字重建之后，计划里出现的【还是旧索引名】，
 * 而且耗时 0.27 ms —— 跟根本没删过一样」。
 * 我一度把它归因成「WAL 下读连接停在自己的 schema 快照上」，并把它写进了注释 ——
 * 【那句归因已被证伪】：另起一发（一条 WriteQueue 的只读连接先开，
 * 之后由别的连接 CREATE INDEX）读连接【看得见】新索引，计划也立刻跟上。
 * 也就是说这是一个【没复现出来成因】的观察，不是一条机制。
 * 处理方式不是「搞清原理之后再改」，是【每一臂都新开连接】：
 * 成本是几毫秒的 open，换来的是「这一臂看的必然是改过之后的 schema」，
 * 不需要我先赢下那场关于 WAL 的辩论。0019 §1 第 13 条那一族
 * （对照实验只许差一个变量）的第【四】次出现，而且这次的污染源【在连接里】——
 * 打开 sqlite_master 检查也没用，因为查的正是那条可能被污染的连接自己。
 */
function armPlan(sql) {
  const c = openDb(PATH_);
  try {
    return c
      .prepare("EXPLAIN QUERY PLAN " + sql)
      .all()
      .map((r) => String(r.detail))
      .filter((s) => /(SEARCH|SCAN)/.test(s));
  } finally {
    c.close();
  }
}
function armTime(sql) {
  const c = openDb(PATH_);
  try {
    return timed(() => c.prepare(sql).all());
  } finally {
    c.close();
  }
}

// ── §1 第 9 条：巡检那条索引的效果 ────────────────────────────────────
head("§1-9 巡检 PATROL_SQL：同一份库，只差 events 上那一条索引（每臂新开连接）");
/**
 * 每一臂的索引形状【由这条数据本身决定】，不在分支里另写一遍。
 * 第一版这里是个 if/else 链，把形状硬编码在各分支里，而 label 在数组里 ——
 * 结果「kind 放末位」那一臂因为 where 是 null 走进了 else，
 * 建出来的【是 0003 原本的形状】，于是这一档打印 0.26 ms（另一臂的数），
 * 而真正该量的 13 ms 一次都没测到。标签说 A、代码建 B，
 * 而且 B 恰好是【已经量过的那一档】⇒ 打印出来完全不像假数。
 * 这正是 0019 §1 第 13 条那一族的【第五】次出现，也是这一族里最阴的一种：
 * 前几次是【库】不一样，这次是【臂自己的定义】不一样，
 * 而 sqlite_master、连接、机器全都对得上。
 * 所以形状只写一次（就在这个数组里），并且下面把实际建出来的 DDL 打出来 ——
 * 让「标签 vs 实际」这一对【并排可见】，而不是要人去读分支。
 */
const arms = [
  { name: "① 0003 那条索引在（默认状态）", keep: true },
  { name: "② 摘掉，只剩 0001 那两条", drop: true },
  { name: "③ kind 放末位 (task,created,kind)", cols: ["task_id", "created_at", "K"] },
  { name: "④ 部分索引，索引里【不含】created_at", cols: ["task_id", "K"], partial: true },
  { name: "⑤ 部分索引，索引里【含】created_at", cols: ["task_id", "K", "created_at"], partial: true },
  { name: "⑥ 0003 原形状，无 WHERE", cols: ["task_id", "K", "created_at"] },
];
const actualDdl = () =>
  String(
    w.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(IDX)?.sql ?? "（无）",
  ).replace(/\s+/g, " ");
for (const a of arms) {
  if (a.keep) {
    if (!hasIdx()) createIdx(`task_id, ${KIND_EXPR}, created_at`);
  } else if (a.drop) {
    dropIdx();
  } else {
    dropIdx();
    const cols = a.cols.map((c) => (c === "K" ? KIND_EXPR : c)).join(", ");
    createIdx(cols, a.partial ? `${KIND_EXPR} IS NOT NULL` : undefined);
  }
  const plan = armPlan(PATROL_SQL);
  const used = plan.filter((s) => new RegExp(IDX).test(s)).length;
  console.log("  " + a.name);
  console.log(
    "      " + ms(armTime(PATROL_SQL)) + "   用了它的探测数 " + used + "/4",
  );
  console.log("      实建 DDL: " + actualDdl().slice(0, 118));
}
if (!hasIdx()) {
  createIdx(`task_id, ${KIND_EXPR}, created_at`);
  console.log("  ⚠ 最后一臂没把 0003 的形状留下，已补建（后面几档要用它）");
} else {
  console.log("  （最后一臂就是 0003 原形状，后面写侧与检索档直接在它上面测）");
}

/**
 * 写侧三档，【交替】跑而不是分批跑。
 *
 * 为什么不能分批：events 是 append-only（0001 的 events_no_delete 触发器），
 * 每测一档就往库里【永久加】2000 行。分批的话第二档是在一张【更大】的库上测的，
 * 于是「索引/触发器有多少代价」这个量里混进了「B 树更深了多少」——
 * 而 §1 第 13 条那条纪律说的正是【对照只许差一个变量】。
 * 本轮我在这里第一版就是分批的，打出 169 vs 42 ms；同一轮里库从 10 万涨到 14.4 万，
 * 那个 75% 里有多少是触发器、有多少是那 4 万行，说不清。
 * 交替之后每一档在各轮里看到的库大小【分布相同】，并把每档实际经历的
 * 行数区间打出来 —— 区间重叠了才算这组对照成立。
 *
 * 三档：
 *   A 索引在 + 触发器在   ← 生产形状，另两档的分母
 *   B 索引拆 + 触发器在   ← 与 A 只差那条 0003 索引 ⇒ 索引的写侧代价
 *   C 索引在 + 触发器拆   ← 与 A 只差 FTS 触发器 ⇒ §3 那句「量的其实是 FTS」
 *
 * ⚠ 摘触发器【只在这份 .tmp 里的临时库上】做，且当场装回去 + rebuild：
 *   ① 装回去是因为后面的标记行与 rank 阶梯都要靠 FTS 里有东西；
 *     忘了装回去那些档会【打印命中数 0】—— 脚本逐档核对并标 ⚠，所以不会静默。
 *   ② 真正的原因是不能拿现网库做这种事：摘触发器期间写进去的行
 *     在 events_fts 里【永远缺失】（外部内容表不会自己回填），
 *     而 events 是 append-only，没有任何办法补写 —— 检索会永久瞎掉那几行。
 *     这里靠末尾那次 rebuild 补回来，而现网库上【没有这个退路可言】：
 *     rebuild 本身要 1~3 s 且同步（§6 那一档），期间检索结果不完整。
 */
head("§1-9 + §3 写侧代价：索引与 FTS 触发器各占多少（三档交替，每档 2000 行 × 3 轮）");
const FT_TRIGGER_DDL =
  "CREATE TRIGGER events_fts_insert AFTER INSERT ON events " +
  "BEGIN INSERT INTO events_fts(rowid, payload) VALUES (new.id, new.payload); END;";
const IDX_DDL = `CREATE INDEX ${IDX} ON events(task_id, ${KIND_EXPR}, created_at)`;
const ROWS_PER_ARM = 2000;
const ROUNDS = 3;
const armState = {
  A: { setup: () => { ensureIdx(); ensureTrigger(); } },
  B: { setup: () => { dropIdx(); ensureTrigger(); } },
  C: { setup: () => { ensureIdx(); w.exec("DROP TRIGGER IF EXISTS events_fts_insert"); } },
};
function ensureIdx() {
  if (!hasIdx()) w.exec(IDX_DDL);
}
function ensureTrigger() {
  if (w.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='trigger' AND name='events_fts_insert'").get() === undefined) {
    w.exec(FT_TRIGGER_DDL);
  }
}
const rowCount = () => openDb(PATH_).prepare("SELECT count(*) AS n FROM events").get().n;
const samples = { A: [], B: [], C: [] };
const sizes = { A: [], B: [], C: [] };
let writeOffset = 5_000_000;
for (let r = 0; r < ROUNDS; r++) {
  for (const key of ["A", "B", "C"]) {
    armState[key].setup();
    const before = rowCount();
    const t = performance.now();
    await appendAuditBatch(q, rows(writeOffset, ROWS_PER_ARM), () => 1);
    samples[key].push(performance.now() - t);
    sizes[key].push(before, before + ROWS_PER_ARM);
    writeOffset += ROWS_PER_ARM;
  }
}
const span = (xs) => Math.min(...xs) + "→" + Math.max(...xs);
const label = {
  A: "A 索引在+触发器在",
  B: "B 索引拆+触发器在",
  C: "C 索引在+触发器拆",
};
for (const key of ["A", "B", "C"]) {
  console.log(
    "  " + label[key] + " " + ms(median(samples[key])) +
      "  逐轮 [" + samples[key].map((x) => x.toFixed(0)).join(", ") + "] ms" +
      "   库大小 " + span(sizes[key]) + " 行",
  );
}
const a = median(samples.A);
const b = median(samples.B);
const c = median(samples.C);
// 逐轮原始值【必须打出来】，不能只打中位数。这一档三次运行打出过 +20% / +35% / +43%，
// 另配一组库大小梯度的探针打过 +6% / +18% / +93%（0019 §5 第 21 条）。
// 只打中位数就会让人以为「+35%」是一个可以引用的数 —— 而 §1 第 10 条记的正是这种错。
// 更阴的一次是：我写下「它跳过 35%~93%」那句警告的【同一次运行】就打出了 +20%，
// 当场证伪了我自己刚写下的那个区间。所以警告里给的是【运行次数的口径】而不是一个新范围。
console.log(
  "  ⇒ 0003 索引的写侧代价 +" + (((a - b) / b) * 100).toFixed(0) + "%（口径：三档中位数之比）   " +
    "FTS 触发器占批量写的 " + (((a - c) / a) * 100).toFixed(0) + "%",
);
console.log(
  "  ⚠ 上面那两个百分比【单次值不可引用】：逐轮原始值就在上面。索引代价这一项本机三次运行" +
    "打过 +20% / +35% / +43%，另一组梯度探针打过 +6% / +93%；稳的是【方向与量级】——" +
    "这条索引确实让每次 INSERT 多维护一份 B 树，代价不为零、在几十个百分点这一档。" +
    "FTS 触发器那一项离散小得多（本机五次观察 64%~70%），所以 0019 §3 引用的就是区间而不是单点。",
);
console.log(
  "  三档各自经历的库大小见上：交替进行 ⇒ 三档看到的【增长过程】相同（不是三张不同大小的库）。" +
    "append-only 意味着每档都让库永久变大 2000 行，【没法】在同一大小的库上反复测 —— " +
    "这是这个指标的本质限制，只能靠交替把它摊平；比值因此偏保守。",
);
// 装回生产形状，并把摘触发器期间漏掉的那几千行补进 FTS
ensureIdx();
ensureTrigger();
w.exec("INSERT INTO events_fts(events_fts) VALUES('rebuild')");
const check = openDb(PATH_).prepare(
  "SELECT (SELECT count(*) FROM events) AS e, (SELECT count(*) FROM events_fts) AS f",
).get();
console.log(
  "  已装回并 rebuild：" + check.e + " 行 vs fts " + check.f + " 行" +
    (check.e === check.f ? "（一致）" : "  ⚠ 不一致 ⇒ 后面所有检索档都不可信"),
);

// ── §6 第二条：FTS rebuild 的代价 ─────────────────────────────────────
// 行数【打进标题】，因为它是这一档唯一的自变量。
// 第一版标签写死「10 万行」而实际跑在标记行之后（27 万行），
// 于是同一格里出现 708.9 ms 与 2 900 ms 两个数而其中一个没标行数 ——
// 那正是下一次「两个自洽的事实」的原料（§1 第 13 条那一族）。
// 位置也有意义：必须在【插标记行之前】，这样它量的是基准夹具本身（~10 万行），
// 而不是我为另一节临时造出来的形状。
const rowsAtRebuild = read.prepare("SELECT count(*) AS n FROM events").get().n;
head("§6 FTS rebuild 一趟的代价（此刻 " + rowsAtRebuild + " 行）+ 只读连接跑不跑得动");
console.log(
  "  写连接 rebuild      " +
    ms(
      timed(() => {
        w.exec("INSERT INTO events_fts(events_fts) VALUES('rebuild')");
      }, 3),
    ),
);
console.log("  只读连接 rebuild  " + ms(timed(() => read.prepare("INSERT INTO events_fts(events_fts) VALUES('rebuild')").run(), 1)));
console.log("  ↑ 这一档【应当】是 throw（0018 §5：rebuild 是写操作，只读连接跑不了）");

// ── 插入【命中数已知】的标记行 ───────────────────────────────────────
// 命中数必须由【构造】决定，不能靠「正文里行号的前缀」去凑：
// 第一版就是这么写的（"正文12345" 这类词去匹配 "…正文1234567" 那些行），
// 而能凑出多少命中取决于上面写了多少行 —— 每次跑的阶梯都不一样。
// 而且 trigram 的短语匹配是【子串】匹配："qk1" 会命中 "qk12345"，
// 于是那几个词的数量是叠起来的，看着像阶梯而其实是同一个数。
// 改成插标记行，且每个 token 以 x 收尾 ⇒ 没有任何一个是另一个的子串
// ⇒ 命中数才等于【我插了多少行】（下面逐档核对并打印）。
//
// 标记行必须在【检索那一节之前】插：§1-10 与 §6 都要「命中数已知的词」，
// 而巡检与写侧那两档必须在【恰好 10 万行】的库上测（它们测的是量级）。
head("插入命中数已知的标记行");
const tok = (n) => "qk" + n + "x";
const MARKS = [1, 12, 123, 1234, 12345, 55555, 100000];
{
  const t0 = performance.now();
  let n = 0;
  for (const target of MARKS) {
    let made = 0;
    while (made < target) {
      const chunk = Math.min(2000, target - made);
      const data = rows(20_000_000 + n, chunk).map((r, i) => ({
        ...r,
        payload: { kind: "TaskStateChanged", taskId: r.taskId, note: tok(target) + " 标记行 " + (made + i) },
      }));
      const r2 = await appendAuditBatch(q, data, () => 1);
      made += r2.written;
      n += r2.written;
    }
  }
  console.log("  +" + n + " 行（" + MARKS.map(tok).join(" / ") + "），用 " + ((performance.now() - t0) / 1000).toFixed(1) + "s");
  console.log("  ⚠ 从这一节起 events 不再是 10 万行；巡检与写侧已在上面测完，不受影响");
}

// 正确性【先于】性能：改这条 SQL 的理由是「快三个数量级」，
// 而它成立的前提是【结果一字不差】—— search.ts 里那句「八种组合全量比过」
// 就是靠这一段撑着的。没有这一段，那个断言只能靠【我说过】。
// 组合取：限定/全库 × 时间序/最近序 × 命中多的词/命中少的词/命不中的词。
head("§1-10 前置：两种写法【结果逐行相同】（不比时间，只比集合与顺序）");
const hitsOf = (kw) =>
  openDb(PATH_).prepare("SELECT count(*) AS n FROM events_fts WHERE events_fts MATCH ?").get(kw).n;
const EQ_KWS = [tok(12345), tok(123), "绝不可能出现在这份库里的词zz"];
const TASK_OF = ["T7", undefined];
const shapes = [];
for (const scoped of [true, false]) {
  for (const order of ["timeline", "recent"]) {
    shapes.push({ scoped, order });
  }
}
let eqCells = 0;
let eqReal = 0;
let eqBad = 0;
for (const kwRaw of EQ_KWS) {
  for (const sh of shapes) {
    const kw = '"' + kwRaw + '"';
    for (const task of TASK_OF) {
      if (sh.scoped && task === undefined) continue; // 限定必须有任务，那一格不存在
      if (!sh.scoped && task !== undefined) continue; // 全库那一格不看任务，同理
      // 参数个数跟着【SQL 里有几个 ?】走，不跟着循环变量走：
      // 第一版写的是 `task === undefined ? [kw] : [kw, task]`，
      // 于是「全库 × task=T7」那一格给一条 3 个 ? 的 SQL 塞了 4 个参数，
      // 报 "column index out of range" —— 症状指向 SQLite，实际是我多绑了一个。
      const args = sh.scoped ? [kw, task] : [kw];
      // LIMIT 取【装得下全部命中】而不是 50。
      // 第一版这里用 50，而这份夹具里每一行的 payload 结构相同 ⇒ bm25 【全部并列】，
      // 「按 rank 的前 50 条」在两种计划下【本来就可以给出不同的 50 条】——
      // 那会造出一个每几周红一次而代码没错的用例，
      // 正是 patrol/perf 那两处注释里写过【绝不写】的那类断言。
      // 把 LIMIT 抬到覆盖全部命中，比的就是【两种写法给出的行集合】，
      // 与并列顺序无关，也与「谁先填满 LIMIT」无关。
      const cap = hitsOf(kw) + 10;
      const oldS =
        "SELECT rowid AS id FROM events_fts WHERE events_fts MATCH ? " +
        (sh.scoped ? "AND rowid IN (SELECT id FROM events WHERE task_id = ?) " : "") +
        (sh.order === "recent" ? "ORDER BY rank, rowid DESC" : "ORDER BY rowid ASC") +
        " LIMIT ? OFFSET ?";
      const c = openDb(PATH_);
      // 两种写法【各自新连接】，谁都不欠谁一个缓存（§1 第 13 条同一条纪律）
      const a = c.prepare(oldS).all(...args, cap, 0).map((r) => Number(r.id));
      c.close();
      const c2 = openDb(PATH_);
      const b = c2
        .prepare(ftsSearchSql({ scope: sh.scoped, order: sh.order }))
        .all(...args, cap, 0)
        .map((r) => Number(r.id));
      c2.close();
      eqCells++;
      // 时间序【比顺序】：那一档是回放页真正走的那一档，翻页靠的就是顺序稳。
      // 最近序只比【集合】：rank 是 bm25 相关性，并列时两种计划的输出顺序不保证一致，
      // 比顺序就是上面说的那类假红。
      const sameSet =
        new Set(a).size === new Set(b).size &&
        a.length === b.length &&
        [...new Set(a)].every((v) => new Set(b).has(v));
      const sameOrder = a.length === b.length && a.every((v, i) => v === b[i]);
      const ok = sh.order === "timeline" ? sameOrder : sameSet;
      if (a.length > 0) eqReal++; // 空对空那一格【也算比过】，但不算【证据】
      if (!ok) {
        eqBad++;
        console.log(
          "  ⚠ 不一致：" + (sh.scoped ? "限定 " + task : "全库") + " × " + sh.order + " × " + kwRaw +
            "  旧 " + a.length + " 行 / 新 " + b.length + " 行",
        );
      }
    }
  }
}
console.log(
  "  比了 " + eqCells + " 格，其中 " + eqReal + " 格【有行】（LIMIT 覆盖全部命中；" +
    "时间序比顺序，最近序只比集合）：" + (eqBad === 0 ? "全部一致 ✔" : eqBad + " 格不一致 ✘"),
);
console.log(
  "  （其余 " + (eqCells - eqReal) + " 格是【两边都空】：它们只证明两种写法在没命中时【同样不命中】，" +
    "不证明行的顺序一致 —— 所以单独数出来，不混进【比过】那个数里）",
);
if (eqBad > 0) {
  console.log("  ⇒ 生产那条 EXISTS 改动的【正确性前提】不成立，性能收益不足以留下它");
  process.exitCode = 1;
}

// ── §1 第 10 条：限定任务的两种写法 ───────────────────────────────────
/**
 * 词取 tok(12345) ⇒ 【恰好 12 345 条 FTS 命中】，而不是「命中 10 万」那种词。
 * 理由是【跑得起】：旧写法最近序那一档的代价 ≈ 命中数 × bm25，
 * 10 万命中时它实测 135 s，默认跑这一发会把一个 1 分钟的复算脚本变成 4 分钟，
 * 而【慢到没人愿意跑的复算脚本等于没有复算脚本】。
 * 要复算文档里那个 18 338 ms 的头档，用 BENCH_HEAVY=1 显式打开（见下面）。
 *
 * 对照必须【同库同词同任务同 LIMIT】只差 SQL 写法这一个变量（§1 第 13 条）。
 */
head("§1-10 FTS 限定任务：IN 子查询 vs EXISTS 主键定位（词 " + tok(12345) + "，命中 12345）");
const KW = '"' + tok(12345) + '"';
/**
 * 旧写法【两种序各一发】。第一版只测了时间序那一发，
 * 而 0019 §1 第 10 条那两个数里最贵的一个（14 975 ms）是【最近序】，
 * 脚本压根没测它 —— 于是 §7 号称「可复算」而文档里最贵的那个数字【没有任何东西能重出来】。
 * 两种序差这么多是因为 recent 带 `ORDER BY rank`：布隆过滤器已经把全部命中物化了，
 * 还要再为排序逐条算 bm25（§6 那张阶梯表量的就是这一项）。
 */
const oldSql = (order) =>
  "SELECT rowid AS id FROM events_fts WHERE events_fts MATCH ? " +
  "AND rowid IN (SELECT id FROM events WHERE task_id = ?) " +
  (order === "recent" ? "ORDER BY rank, rowid DESC" : "ORDER BY rowid ASC") +
  " LIMIT ? OFFSET ?";
const timeOf = (sql, ...params) =>
  ms(timed(() => openDb(PATH_).prepare(sql).all(...params, 50, 0).length, 3));
const OLD = oldSql("timeline");
const NEW = ftsSearchSql({ scope: true, order: "timeline" });
// 计划文本【新旧各取一次】，并且各自标注是哪个 —— 第一版这里打的是
// 「新写法计划含 BLOOM: true（旧写法应当含）」：取的是旧 SQL 的计划而标签写的是新写法，
// 读的人会以为【新写法】带布隆过滤器，而这一节的全部论点正好是反的。
const planOf = (sql) =>
  openDb(PATH_)
    .prepare("EXPLAIN QUERY PLAN " + sql)
    .all()
    .map((r) => String(r.detail))
    .join(" | ");
console.log("  FTS 命中数 " + hitsOf(KW) + "（应为 12345）");
console.log(
  "  计划含 BLOOM —— 旧写法 " + /BLOOM/.test(planOf(OLD)) + " / 新写法 " + /BLOOM/.test(planOf(NEW)) +
    "（期望 旧 true / 新 false）",
);
for (const o of ["timeline", "recent"]) {
  console.log(
    "  " + (o === "timeline" ? "时间序" : "最近序").padEnd(6) +
      " 旧 " + timeOf(oldSql(o), KW, "T7") + "   新 " + timeOf(ftsSearchSql({ scope: true, order: o }), KW, "T7"),
  );
}
console.log(
  "  searchEvents 生产入口（限定+时间序）P50 " +
    ms(timed(() => searchEvents(read, { keyword: tok(12345), taskId: "T7", order: "timeline", limit: 50 }))),
);
if (process.env.BENCH_HEAVY === "1") {
  const heavy = '"' + tok(100000) + '"';
  console.log(
    "  [BENCH_HEAVY] 命中 " + hitsOf(heavy) + " 时旧写法最近序 " +
      ms(timed(() => openDb(PATH_).prepare(oldSql("recent")).all(heavy, "T7", 50, 0).length, 1)) +
      "   （文档里那个 18 338 ms 的头档）",
  );
} else {
  console.log("  （旧写法【命中 10 万 × 最近序】那一档默认不跑，约 2 分钟；BENCH_HEAVY=1 打开）");
}

// ── §6 第一条：rank 排序的代价构成 ────────────────────────────────────
head("§6 ORDER BY rank 的代价是【命中数】的函数（LIMIT 恒 50）");
const RANK = ftsSearchSql({ scope: false, order: "recent" });
const ROWID_ONLY = RANK.replace("ORDER BY rank, rowid DESC", "ORDER BY rowid DESC");
if (ROWID_ONLY === RANK) console.log("  ⚠ 没替换成功：search.ts 的 recent 排序子句改了，这一档失效");
const RANK_SCOPED = ftsSearchSql({ scope: true, order: "recent" });
const TIMELINE_SCOPED = ftsSearchSql({ scope: true, order: "timeline" });
console.log("  FTS命中数 | 全库rank  | 全库rowid | 限定rank  | 限定时间序   （命中数应当等于造的行数）");
for (const target of MARKS) {
  const kw = '"' + tok(target) + '"';
  let n = -1;
  try {
    n = read.prepare("SELECT count(*) AS n FROM events_fts WHERE events_fts MATCH ?").get(kw).n;
  } catch (e) {
    console.log("  " + kw + " 解析失败: " + e.message);
    continue;
  }
  const ok = n === target ? "" : "  ⚠ 命中 " + n + " ≠ 造的 " + target;
  const f = (sql, ...p) => ms(timed(() => read.prepare(sql).all(...p, 50, 0), 5));
  console.log(
    "  " + String(n).padStart(9) + " | " + f(RANK, kw) + " | " + f(ROWID_ONLY, kw) +
      " | " + f(RANK_SCOPED, kw, "T7") + " | " + f(TIMELINE_SCOPED, kw, "T7") + ok,
  );
}

// ── §1 第 12 条：卡住写队列的是主线程被占 ──────────────────────────────
head("§1-12 归因：并发写 + (全库搜索 / 无关空转) 时，写什么时候落地");
async function worstLanding(block) {
  const done = [];
  const t0 = performance.now();
  const writes = Array.from({ length: 20 }, (_, i) =>
    appendAuditBatch(q, rows(9_000_000 + i * 10, 10), () => Date.now()).then(() => {
      done.push(performance.now() - t0);
    }),
  );
  const b0 = performance.now();
  block();
  const blockMs = performance.now() - b0;
  await Promise.all(writes);
  return { worst: Math.max(...done), blockMs };
}
const search = await worstLanding(() => {
  // 用标记行里【命中最多】那个 token，而不是随便一个中文词：
  // 「正文1」这种词的命中数取决于上面生成的行号里有多少以 1 开头，
  // 每次跑都不一样 ⇒ 这一档的数无法跟别人比。qk100000x 恒命中 10 万行，
  // 也正是 §6 那张表里最坏的一档，拿它做阻塞对照才对得上「以后审计页会撞上」那句话。
  for (let k = 0; k < 20; k++) searchEvents(read, { keyword: tok(100000), order: "recent", limit: 50 });
});
/**
 * 空转对照的时长【取搜索那一档实测占用的时长】，不写死常量。
 * 第一版写死 100 ms，而这一档的搜索实际占用了 ~3 s（命中 10 万行 × 20 次），
 * 于是「对照」两侧占用的主线程时间差 30 倍 —— 那已经不是对照，
 * 只是两次毫无关系的测量并排打印。要让「形状相同 ⇒ 原因相同」这句话成立，
 * 两侧【必须只差“占用的那段事是什么”这一个变量】（§1 第 13 条同一条纪律）。
 */
const spin = await worstLanding(() => {
  const s = performance.now();
  while (performance.now() - s < search.blockMs) {
    /* 同步占住主线程，故意什么都不做 */
  }
});
const onlyWrites = await worstLanding(() => {});
console.log("  只有写                    最晚 " + onlyWrites.worst.toFixed(0).padStart(5) + " ms");
console.log(
  "  写 + 20 次全库检索（占 " + search.blockMs.toFixed(0).padStart(5) + "ms）最晚 " +
    search.worst.toFixed(0).padStart(5) + " ms",
);
console.log(
  "  写 + 同步空转（占 " + spin.blockMs.toFixed(0).padStart(5) + "ms）最晚 " +
    spin.worst.toFixed(0).padStart(5) + " ms",
);
console.log(
  "  两侧占用时长差 " + Math.abs(search.blockMs - spin.blockMs).toFixed(0) + "ms；落地时刻差 " +
    Math.abs(search.worst - spin.worst).toFixed(0) + "ms ⇒ 同形 ⇒ 因是【同步占主线程】",
);
console.log("  （限定任务 + 时间序那一档在 test/acceptance/perf-thresholds.test.ts ④ 里断着）");

await q.close();
w.close();
rmSync(PATH_, { force: true });
rmSync(PATH_ + "-wal", { force: true });
rmSync(PATH_ + "-shm", { force: true });
console.log("\n完成。这些数是【本机单次实测】，与 0019 记录的允许有机器差异；量级不符才算复算失败。\n");
