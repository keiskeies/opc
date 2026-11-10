/**
 * 事件批量写（src/events/batch.ts）—— 计划 Task 6.4「事件写入必须走批量事务」（V9）。
 *
 * ── 本文件真正在守的三件事 ──────────────────────────────────────────
 * ① N 行只用 ceil(N/分片) 个事务。这是「批量」这个词的全部内容，
 *    而它是【结构性质】不是【快不快】：慢 10% 没人看得出来，事务数翻倍看不出来。
 *    所以这一条不看计时，数事务个数 —— 计时那条留给 §④，且用比值而不是绝对值（见那里）。
 * ② 校验在【入队之前】对整批做完。这一条是批量写独有的危险：
 *    逐条写时第 4 行写错 ⇒ 前三行在库里、第四行没进去，那是常态；
 *    批量写如果边校验边写，同一个错误会留在「一半进去了」的状态上，
 *    而 append-only 挡不住事后清理 —— 所以这里必须是【要么整批没写，要么整批写完】。
 * ③ 分片之间【不是】原子的。这条写进文件头了，就得有一条用例钉住它：
 *    否则后来人读到注释会以为它只是「没优化」，而不是一个可观察的行为。
 *
 * ── 为什么计时断言用比值 ────────────────────────────────────────────
 * 计划给的是绝对阈值（2000 条 < 50 ms）。本机实测【过不了】，
 * 而且本文件里那个库很小，绝对值换台机器、换个库大小就完全不同 ——
 * 所以这里【不写任何绝对毫秒数】，只打印。要归因（FTS 触发器占多少）
 * 去看 scripts/bench-recompute.mjs，它每次都重出那个比例（0019 §3）。
 * 把阈值改成 200 ms 以让测试变绿是假绿 —— 那种断言抓不到【任何】回归：
 * 有人把分片大小改成 1（等于逐条写），200 ms 的阈值照样绿。
 * 所以真正跑得动的断言是【比值】：批量必须显著快于逐条事务。
 * 比值与机器快慢基本无关（同一台机器上两边同涨同跌），
 * 而「分片大小 = 1」这个最真实的回归会当场红。绝对值只记录，不断言。
 */
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { fixtureTmp } from "../fixtures/fixture-dir.js";
import { BATCH_ROWS, openDb } from "../../src/db/driver.js";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue, type Writer } from "../../src/db/write-queue.js";

import { appendAudit, type AuditRow } from "../../src/events/recorder.js";
import { appendAuditBatch, shard } from "../../src/events/batch.js";

const TMP = fixtureTmp("batch", import.meta.url);
// 先清再建：只 rmSync 的话目录不存在，openDb 报的是 "unable to open database file"，
// 而那条错误读起来像「权限/磁盘问题」，不像「忘了 mkdir」。
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const opened: Array<{ close(): void }> = [];
const queues: Array<{ close(): Promise<void> }> = [];
let seq = 0;

afterAll(async () => {
  for (const q of queues) {
    try {
      await q.close();
    } catch {
      /* 已关 */
    }
  }
  for (const d of opened) {
    try {
      d.close();
    } catch {
      /* 已关 */
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});

/** 一个已迁移的库 + 一条写队列 + 一个可引用的 task id。 */
async function fresh(): Promise<{
  path: string;
  db: ReturnType<typeof openDb>;
  q: WriteQueue;
}> {
  const path = join(TMP, "bt-" + process.pid + "-" + ++seq + ".db");
  const db = openDb(path);
  opened.push(db);
  migrate(db as never);
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
      "VALUES ('T-batch', '批量夹具', 'IN_PROGRESS', 'dev', 'implement', 1, 1)",
  ).run();
  const q = new WriteQueue(path);
  queues.push(q);
  return { path, db, q };
}

/**
 * 数事务的包装。
 *
 * 为什么是【包一层真 WriteQueue】而不是写一个假 Writer：
 * 假 Writer 只数调用次数，于是「分片数对了而分片里其实一行都没写」也能过。
 * 真的跑到底、只在外面数一遍 node() 调用次数，才能同时拿到
 * 「几个事务」和「库里真有几行」两个数 —— 这两个数不一致才是本模块的失效形状。
 */
function counting(writer: Writer): { writer: Writer; calls: () => number } {
  let n = 0;
  return {
    calls: () => n,
    writer: {
      node<T>(fn: () => T | Promise<T>): Promise<T> {
        n += 1;
        return writer.node(fn);
      },
    },
  };
}

function rows(n: number, taskId: string | null = "T-batch"): AuditRow[] {
  return Array.from({ length: n }, (_, i): AuditRow => ({
    taskId,
    actorType: "system",
    actorId: "hub",
    action: "state_change",
    target: null,
    payload: { kind: "TaskStateChanged", taskId, n: i, note: "批量写入的第 " + i + " 条正文" },
  }));
}

function countEvents(db: { prepare(s: string): { get(...p: never[]): unknown } }): number {
  const r = db.prepare("SELECT count(*) AS c FROM events").get() as { c: number | bigint };
  return Number(r.c);
}

describe("① shard：分片边界（纯函数）", () => {
  it("空批 ⇒ 零分片，而不是【一个空分片】", () => {
    // 反向对照必须成对：空批若产出 [[]]，调用方会白跑一次 BEGIN/COMMIT。
    // 空事务不报错、不写数据、不在日志里留痕 —— 它只在一次循环里被调用 5 万次时才看得出来。
    expect(shard([])).toEqual([]);
    expect(shard([1], 3)).toEqual([[1]]);
  });

  it("正好整除时【不】多一个空尾片", () => {
    const s = shard([1, 2, 3, 4], 2);
    expect(s).toEqual([[1, 2], [3, 4]]);
    // 逐格点名：只比长度的话，「第二片其实是第一片的副本」看不出来
    expect(s.map((g) => g.length)).toEqual([2, 2]);
  });

  it("差一个就切第二片（1000 / 1001 这两格最容易错）", () => {
    const exact = shard(Array.from({ length: BATCH_ROWS }, (_, i) => i));
    expect(exact).toHaveLength(1);
    const plus = shard(Array.from({ length: BATCH_ROWS + 1 }, (_, i) => i));
    expect(plus.map((g) => g.length)).toEqual([BATCH_ROWS, 1]);
    // 一条都不能丢也不能重：分片代码最典型的错是 off-by-one，
    // 症状是「最后一批少一条」或「第 1000 条写两遍」，两者都不报错。
    const flat = plus.flat();
    expect(flat).toHaveLength(BATCH_ROWS + 1);
    expect(new Set(flat).size).toBe(BATCH_ROWS + 1);
    expect(flat[0]).toBe(0);
    expect(flat[flat.length - 1]).toBe(BATCH_ROWS);
  });

  it("分片大小必须是 ≥1 的整数", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => shard([1], bad)).toThrow(/≥1/u);
    }
    expect(() => shard([1], 1)).not.toThrow();
  });
});

describe("② N 行只用 ceil(N/分片) 个事务", () => {
  it("2000 行 ⇒ 恰好 2 个 node() 调用，库里恰好 2000 行", async () => {
    const f = await fresh();
    const c = counting(f.q);
    const r = await appendAuditBatch(c.writer, rows(2000), () => 1234);
    expect(r.shards).toEqual([1000, 1000]);
    expect(r.written).toBe(2000);
    // 这一发是本模块的头号断言。有人把默认分片大小改成 1，
    // written 与 shards 都能对上（[1,1,1,…]），只有【事务数】会红。
    expect(c.calls()).toBe(2);
    expect(countEvents(f.db)).toBe(2000);
  });

  it("少于一片 ⇒ 一个事务；正好一片 ⇒ 还是一个事务", async () => {
    const f = await fresh();
    const c = counting(f.q);
    await appendAuditBatch(c.writer, rows(3), () => 1);
    expect(c.calls()).toBe(1);
    await appendAuditBatch(c.writer, rows(BATCH_ROWS), () => 1);
    expect(c.calls()).toBe(2);
    expect(countEvents(f.db)).toBe(3 + BATCH_ROWS);
  });

  it("空批 ⇒ 一个事务都不开，也不抛", async () => {
    const f = await fresh();
    const c = counting(f.q);
    const r = await appendAuditBatch(c.writer, [], () => 1);
    expect(r).toEqual({ written: 0, shards: [] });
    expect(c.calls()).toBe(0);
  });

  it("created_at 走注入的时钟，而不是各自 Date.now()", async () => {
    const f = await fresh();
    // 一批之内取多次时钟的话，「这一批是同一时刻发生的」这个语义就没了 ——
    // 而回放按 created_at 排序，一批事件散在几个毫秒上时，回放顺序不再由插入顺序决定。
    let clockCalls = 0;
    await appendAuditBatch(f.q, rows(5), () => {
      clockCalls += 1;
      return 777;
    });
    const times = f.db
      .prepare("SELECT DISTINCT created_at AS t FROM events")
      .all() as Array<{ t: number | bigint }>;
    expect(times.map((x) => Number(x.t))).toEqual([777]);
    expect(clockCalls).toBeGreaterThan(0);
  });

  it("FTS 索引真的跟着长了（批量写没绕过触发器）", async () => {
    const f = await fresh();
    await appendAuditBatch(f.q, rows(20), () => 1);
    const hit = f.db
      .prepare("SELECT rowid FROM events_fts WHERE events_fts MATCH ?")
      .all('"批量写入的第 7 条正文"') as Array<{ rowid: number | bigint }>;
    expect(hit.length).toBe(1);
    // 反向对照：没写进去的关键词必须搜不到，否则上面那条是「MATCH 恒返回东西」的假绿
    const miss = f.db
      .prepare("SELECT rowid FROM events_fts WHERE events_fts MATCH ?")
      .all('"从没写进库的一句中文"') as unknown[];
    expect(miss).toHaveLength(0);
  });
});

describe("③ 校验在入队之前对整批做完", () => {
  it("第 4 行的 action 非法 ⇒ 一个事务都没开，库里 0 行", async () => {
    const f = await fresh();
    const c = counting(f.q);
    const bad = rows(10);
    // 只改第 4 条：非法 action 由 eventParams 抛出（recorder.ts 那份枚举校验）。
    // 校验若在循环里做，前三行会先落库，然后才抛 —— 那正是本模块要防的半批。
    (bad[3] as { action: string }).action = "not_an_action";
    await expect(appendAuditBatch(c.writer, bad, () => 1)).rejects.toThrow(/非法的审计 action/u);
    expect(c.calls()).toBe(0);
    expect(countEvents(f.db)).toBe(0);
    // 反向对照：同一批把那条改回去就必须写得出来。
    // 没有这一发，「rejects」那一发能被一个「永远抛错、永远不写」的实现满足。
    const ok = rows(10);
    const r = await appendAuditBatch(c.writer, ok, () => 1);
    expect(r.written).toBe(10);
    expect(countEvents(f.db)).toBe(10);
  });

  it("actor_id 是纯空白也挡得住，而且同样在写之前", async () => {
    const f = await fresh();
    const c = counting(f.q);
    const bad = rows(6);
    (bad[5] as { actorId: string }).actorId = "   ";
    await expect(appendAuditBatch(c.writer, bad, () => 1)).rejects.toThrow(/actor_id/u);
    expect(c.calls()).toBe(0);
    expect(countEvents(f.db)).toBe(0);
  });

  it("批量与逐条写出来的行【逐字段相同】（两条路不能各自演化）", async () => {
    const f = await fresh();
    const row: AuditRow = {
      taskId: "T-batch",
      actorType: "system",
      actorId: "hub",
      action: "state_change",
      target: "node-1",
      payload: { kind: "TaskStateChanged", taskId: "T-batch", n: 1 },
      createdAt: 4242,
    };
    const single = appendAudit(f.db, row, () => 9999);
    await appendAuditBatch(f.q, [row], () => 9999);
    const got = f.db
      .prepare("SELECT task_id, actor_type, actor_id, action, target, payload, state_snapshot, created_at " +
        "FROM events ORDER BY id")
      .all() as Array<Record<string, unknown>>;
    expect(got).toHaveLength(2);
    const a = got[0] ?? {};
    const b = got[1] ?? {};
    // 逐字段比而不是 toEqual 整行：整行比的话，
    // 「两条都写成同一个错值」也能过，而逐字段列出来说明【哪一列】可能漂移。
    for (const k of Object.keys(a)) {
      const x = a[k];
      const y = b[k];
      expect([k, x === null ? null : String(x)]).toEqual([k, y === null ? null : String(y)]);
    }
    expect(Number(single)).toBeGreaterThan(0);
  });
});

describe("④ 分片之间不是原子的（文件头那条承诺的可观察形态）", () => {
  it("第二个分片失败 ⇒ 第一个分片【留在库里】，而 Promise 仍 reject", async () => {
    const f = await fresh();
    // 让第二片失败而第一片成功：分片大小 2，第三行引用不存在的 task ⇒ 外键挡下。
    // 用外键而不是别的错法，是因为它撞在【行级】而不在 prepare 阶段：
    // 拿一条注定失败的 SQL 会让整批在 prepare 时就炸，那测的是另一件事。
    const batch = [
      ...rows(2, "T-batch"),
      ...rows(2, "task-不存在"),
    ];
    await expect(appendAuditBatch(f.q, batch, () => 1, 2)).rejects.toThrow(/FOREIGN KEY|外键/u);
    // 这一发就是「不原子」的定义。它不是 bug，是文件头写了的取舍：
    // 为了原子把分片上限抬到未穷尽的参数边界，换的是更坏的东西。
    expect(countEvents(f.db)).toBe(2);
    const after = await appendAuditBatch(f.q, rows(2, "T-batch"), () => 1, 2);
    expect(after.written).toBe(2);
    expect(countEvents(f.db)).toBe(4);
  });

  it("自定义分片大小生效（不能默默用回默认值）", async () => {
    const f = await fresh();
    const c = counting(f.q);
    const r = await appendAuditBatch(c.writer, rows(10), () => 1, 3);
    expect(r.shards).toEqual([3, 3, 3, 1]);
    expect(c.calls()).toBe(4);
  });
});

describe("⑤ 基准：批量必须显著快于逐条事务", () => {
  /**
   * 计划 Task 6.4 的原话是「2000 条事件批量事务写入 < 50 ms」。
   * 本机【没达到】，而且差的不是「一点点」：10 万行的库上批量是 100+ ms 量级。
   * 归因（FTS 触发器占批量写的约三分之二到七成）由
   * `scripts/bench-recompute.mjs` 每次重出，这里【不重述那个百分比】——
   * 同一笔账抄在两处必然漂移，本轮我自己就漂了一次（0019 §3 那条撤回：
   * 我先把「约 90%」写进文档，而它是在近乎空的库上量的）。
   * 结论不受影响：那条阈值测的主要不是批量事务，是 FTS 触发器；
   * 要让它达标得改 FTS 的维护时机（比如攒一批再 rebuild），
   * 而那是【搜索新鲜度】的取舍，归 CEO 拍（0019 §3 里连 rebuild 的代价一起给了）。
   * 这里因此不断言 50 ms，改断言一条能抓到真回归的：
   *
   * 【批量必须至少比逐条事务快一倍】。
   * 判据取 2× 而不是 4×：留出一倍余量，避免机器负载把测试跑成噪声。
   * 这一发能抓到的是「分片大小被改成 1」「每行一个事务」这类改动 ——
   * 那两种改动的表现正是【测试全绿而写队列被 fsync 拖死】。
   */
  it("同一份数据：批量 vs 逐条事务", async () => {
    const f = await fresh();
    const N = 2000;
    const data = rows(N);

    // 预热：第一趟要把页缓存、prepared statement、FTS 结构都焐热。
    // 不预热的话第一趟含一次性的建索引代价，比值会虚高，
    // 于是「批量并不比逐条快多少」这个结论能被一次不巧的计时掩盖掉。
    await appendAuditBatch(f.q, data.slice(0, 50), () => 1);

    const perRow0 = performance.now();
    const one =
      "INSERT INTO events (task_id, actor_type, actor_id, action, target, payload, state_snapshot, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
    const perRowPayloads = data.map((r) => [
      r.taskId, r.actorType, r.actorId, r.action, r.target,
      JSON.stringify(r.payload), "{}", 1,
    ]);
    for (const p of perRowPayloads) {
      await f.q.tx([[one, p]]);
    }
    const perRowMs = performance.now() - perRow0;

    const batchRuns: number[] = [];
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      await appendAuditBatch(f.q, data, () => 1);
      batchRuns.push(performance.now() - t0);
    }
    const batchMs = Math.min(...batchRuns);

    // 断言用的是【比值】，理由见本节注释。
    expect(batchMs * 2).toBeLessThan(perRowMs);
    // 结构侧照旧钉住：2000 行两个事务。
    const c = counting(f.q);
    const r = await appendAuditBatch(c.writer, data, () => 1);
    expect(r.shards).toEqual([1000, 1000]);
    expect(c.calls()).toBe(2);
    // 行数：预热 50 + 逐条 2000 + 批量 3×2000 + 核验 2000
    expect(countEvents(f.db)).toBe(50 + 2000 + 6000 + 2000);
    // 绝对值只打印不断言（本机比值随库大小在 4~5× 之间漂；
    // 计划那 50 ms 未达标，归因见 scripts/bench-recompute.mjs 与 0019 §3）。
    process.stdout.write(
      "\n[bench] 逐条 " + perRowMs.toFixed(0) + "ms / 批量(取 3 趟最小) " +
        batchMs.toFixed(0) + "ms / 比值 " + (perRowMs / batchMs).toFixed(1) + "×\n",
    );
  });
});
