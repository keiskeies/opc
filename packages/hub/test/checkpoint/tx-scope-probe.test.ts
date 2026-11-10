// @ts-nocheck  // 探针测试：重点是框架调度下的事务边界，不是类型（Task 0.4a）
/*
 * Task 0.4a　框架路径同事务探针（规格 §6.3 的设计门）
 *
 * 唯一要回答的问题：LangGraph 在我们代码之外调用 Saver 的 put / putWrites 时，
 * AsyncLocalStorage 的事务上下文还在不在？手工把三张表写进同一事务已证可行（V7），
 * ALS 在 Node 原生调度下可传递也已证（决策 0001 §2.2），但中间有道缝：框架的内部
 * 调度不归我们。这道缝只能实测 —— 它决定审计完整性是真的，还是只写在文档里。
 *
 * 结论写进 docs/decisions/0003-checkpoint-transaction-scope.md，决定 Task 0.4b 形态。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Annotation, END, StateGraph } from "@langchain/langgraph";
import {
  BaseCheckpointSaver,
  MemorySaver,
} from "@langchain/langgraph-checkpoint";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("tx-scope-probe", import.meta.url);

const als = new AsyncLocalStorage();
const opened = [];
let seq = 0;

function openDbAt(path) {
  mkdirSync(TMP, { recursive: true });
  const db = new DatabaseSync(path);
  opened.push(db);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(
    "CREATE TABLE checkpoints (thread_id TEXT, checkpoint_id TEXT, src TEXT)",
  );
  db.exec("CREATE TABLE writes (thread_id TEXT, checkpoint_id TEXT, src TEXT)");
  db.exec("CREATE TABLE events (thread_id TEXT, checkpoint_id TEXT, src TEXT)");
  return db;
}

function openDb(tag) {
  return openDbAt(join(TMP, tag + "-" + process.pid + "-" + ++seq + ".db"));
}
function count(db, table) {
  return Number(
    Object.values(db.prepare("SELECT COUNT(*) AS c FROM " + table).get())[0],
  );
}

function countWhere(db, table, where) {
  return Number(
    Object.values(
      db
        .prepare("SELECT COUNT(*) AS c FROM " + table + " WHERE " + where)
        .get(),
    )[0],
  );
}

/*
 * RecordingSaver：put / putWrites 一律【只从 ALS 取连接】。
 * 取不到就不写 —— 让 ALS 缺失暴露成「表里少行」，而不是静默换条连接写进去。
 *
 * 断言依据是【表里的行数】，不是调用自己上报的布尔值。上一版探针把 wrote 写到了
 * 包装对象上，出现 wrote=false 而数据其实已写入的矛盾 —— 自己汇报自己的断言不可信。
 */
class RecordingSaver extends BaseCheckpointSaver {
  // 本记录器【只从 ALS 取连接】；让 Saver 自带连接的写法见 decisions/0003 §3.1（会撞 SQLITE_BUSY）。
  constructor(db, calls) {
    super();
    this.db = db;
    this.calls = calls;
    this.mem = new MemorySaver();
  }
  record(label, table) {
    const st = als.getStore();
    const used = st ? st.db : null;
    let wrote = false;
    if (used) {
      used
        .prepare(
          "INSERT INTO " +
            table +
            " (thread_id, checkpoint_id, src) VALUES (?, ?, ?)",
        )
        .run(label, "probe", used === this.db ? "same" : "other");
      wrote = true;
    }
    this.calls.push({
      label,
      hadScope: Boolean(st),
      sameConn: used === this.db,
      wrote,
    });
  }
  async getTuple(config) {
    return this.mem.getTuple(config);
  }
  async *list(config, options) {
    yield* this.mem.list(config, options);
  }
  async put(config, checkpoint, metadata, newVersions) {
    this.record("put", "checkpoints");
    return this.mem.put(config, checkpoint, metadata, newVersions);
  }
  async putWrites(config, writes, taskId, taskPath) {
    this.record("putWrites", "writes");
    return this.mem.putWrites(config, writes, taskId, taskPath);
  }
  async deleteThread(threadId) {
    return this.mem.deleteThread(threadId);
  }
}

const State = Annotation.Root({
  trail: Annotation({ reducer: (a, b) => a.concat(b) }),
});

function linearGraph(saver, opts) {
  const failAt = opts?.failAt || null;
  const g = new StateGraph(State);
  for (const name of ["a", "b"]) {
    g.addNode(name, () => {
      const st = als.getStore();
      if (st)
        st.db
          .prepare(
            "INSERT INTO events (thread_id, checkpoint_id, src) VALUES (?, ?, ?)",
          )
          .run(name, "node", name);
      if (failAt && failAt === name) throw new Error("boom-" + name);
      return { trail: name };
    });
  }
  g.addEdge("__start__", "a");
  g.addEdge("a", "b");
  g.addEdge("b", END);
  return g.compile({ checkpointer: saver });
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  for (const db of opened) {
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});

// —— 断言 1：框架调用 Saver 时 ALS 存活，且用的就是 scope 里那个连接 ——
it("框架调用 put / putWrites 时 ALS 上下文存活，且写入用的就是 scope 中的连接", async () => {
  const db = openDb("a1");
  const calls = [];
  const graph = linearGraph(new RecordingSaver(db, calls));

  await als.run({ db }, () =>
    graph.invoke({ trail: [] }, { configurable: { thread_id: "t-a1" } }),
  );

  expect(
    calls.length,
    "框架必须真的调用过 Saver，否则本探针什么都没测",
  ).toBeGreaterThan(0);
  const lost = calls.filter((c) => !c.hadScope);
  expect(
    lost,
    "任何一次调用丢失 ALS 上下文，同事务方案就不成立：" + JSON.stringify(lost),
  ).toHaveLength(0);
  expect(calls.every((c) => c.sameConn && c.wrote)).toBe(true);

  const puts = calls.filter((c) => c.label === "put").length;
  const pw = calls.filter((c) => c.label === "putWrites").length;
  expect(puts, "put 必须被调用过").toBeGreaterThan(0);
  expect(count(db, "checkpoints")).toBe(puts);
  expect(count(db, "writes")).toBe(pw);
  expect(
    count(db, "events"),
    "节点内的审计写入也必须落进同一连接",
  ).toBeGreaterThan(0);
});

/*
 * 断言 2 与 3 需要一个「事务化 scope」：外层 BEGIN，节点与框架 Saver 全部走同一个
 * 连接，成功才 COMMIT，任何异常都 ROLLBACK。这正是 Task 0.4b 里 txScope() 的雏形。
 */
function txRun(db, body) {
  db.exec("BEGIN IMMEDIATE");
  return als.run({ db }, async () => {
    try {
      const r = await body();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* 事务可能已被 SQLite 自身中止，此时 ROLLBACK 也会抛，不能盖住原始异常 */
      }
      throw e;
    }
  });
}

// —— 断言 2：事务提交之前，另一条连接读不到任何一行（真原子，不是「提交得快」）——
it("事务未提交期间，另一条连接到同一文件也看不到任何一行", async () => {
  // 两条连接必须指向【同一个文件】。曾经的写法是给 observer 另拼一个路径，
  // 于是它打开的是另一个空库，三张表读到 0 纯属必然 —— 那种绿是假的。
  const path = join(TMP, "a2-shared-" + process.pid + ".db");
  const db = openDbAt(path);
  const calls = [];
  const observations = [];
  let observerInTxFailed = null;

  /*
   * 哨兵：在事务开始【之前】各插一行并让它们处于已提交状态（此刻还没 BEGIN）。
   * 用途是区分两种看起来一模一样的 0 —— 「真原子提交所以看不见」与
   * 「观察连接压根连到了另一个空文件所以什么都看不见」。
   * 只有先证明观察连接能读到已提交的哨兵，后面那句「读不到未提交的新行」
   * 才有内容。我先前那次假通过，缺的就是这一步。
   */
  for (const t of ["checkpoints", "writes", "events"]) {
    db.prepare(
      "INSERT INTO " + t + " (thread_id, checkpoint_id, src) VALUES (?, ?, ?)",
    ).run("sentinel", "sentinel", "sentinel");
  }

  const g = new StateGraph(State);
  g.addNode("observe", () => {
    // 顺序要紧：先写，再用第二条连接读。否则读到的 0 只是「压根没写」的同义反复。
    const st = als.getStore();
    st.db
      .prepare(
        "INSERT INTO events (thread_id, checkpoint_id, src) VALUES (?, ?, ?)",
      )
      .run("observe", "node", "observe");
    // 此刻外层事务仍未提交。第二条连接连到同一个文件读三张表。
    const obs = new DatabaseSync(path);
    try {
      for (const t of ["checkpoints", "writes", "events"]) {
        observations.push({
          table: t,
          committed: countWhere(obs, t, "src = " + "'sentinel'"),
          uncommitted: countWhere(obs, t, "src != " + "'sentinel'"),
          /*
           * 同一个时刻，用【持有事务的那条连接】再数一次。
           * 它必须看得见未提交的行 —— 否则外部那个 0 只是因为「其实什么都没写」。
           * 真正的原子性是一个差异：写者可见、外人不可见。两个 0 不叫原子性。
           */
          fromWriter: countWhere(st.db, t, "src != " + "'sentinel'"),
        });
      }
    } catch (e) {
      observerInTxFailed = String(e?.message ? e.message : e);
    } finally {
      obs.close();
    }
    return { trail: "observe" };
  });
  g.addNode("tail", () => ({ trail: "tail" }));
  g.addEdge("__start__", "observe");
  g.addEdge("observe", "tail");
  g.addEdge("tail", END);
  const compiled = g.compile({ checkpointer: new RecordingSaver(db, calls) });

  await txRun(db, () =>
    compiled.invoke({ trail: [] }, { configurable: { thread_id: "t-a2" } }),
  );

  expect(
    observerInTxFailed,
    "第二条连接在事务中读取不该报错：" + observerInTxFailed,
  ).toBeNull();
  expect(
    calls.length,
    "框架必须调用过 Saver，否则没有东西可观察",
  ).toBeGreaterThan(0);
  expect(
    observations.length,
    "节点观察点必须执行过，否则断言 2 什么都没测",
  ).toBe(3);
  for (const o of observations) {
    // 第一步：证明这条观察连接确实连在同一个文件上、确实读得到数据。
    expect(
      o.committed,
      "观察连接必须看得见已提交的哨兵行（" +
        o.table +
        "）——看不见就说明它连的是别的文件，后面的 0 无意义",
    ).toBe(1);
    // 第二步：写者自己【必须】看得见这些行 —— 数据确实已经在库里，只是还没提交。
    expect(
      o.fromWriter,
      "写入连接应当看得见 " +
        o.table +
        " 的未提交行；看不见说明根本没写进去，下面的 0 是空对空",
    ).toBeGreaterThan(0);
    // 第三步：在这个前提下，事务内新增的行对外部连接必须一行都看不见。
    expect(
      o.uncommitted,
      "提交前外部连接不该看到 " + o.table + " 的新行（否则不是真原子提交）",
    ).toBe(0);
  }
  // 提交后必须全部可见 —— 否则上面那个 0 只是「什么都没写」的同义反复
  expect(
    count(db, "checkpoints"),
    "提交后 checkpoints 必须可见，否则上面断言的 0 毫无意义",
  ).toBeGreaterThan(0);
  expect(count(db, "events"), "提交后 events 必须可见").toBeGreaterThan(0);

  /*
   * 但光看【写入连接】自己数行数还不够：那只能证明「写进去了」。
   * 「提交前读到 0」有两种成因 —— 真原子提交，或者观察连接连的是另一个空文件。
   * 两者在上面的断言里长得一模一样。区分它们的唯一办法：提交后让观察连接按
   * 【同一条路径】重开再读一遍，必须看见行。少了这一步，断言 2 可以靠一个
   * 拼错的库路径长期全绿（我先前就是这么假通过过一次）。
   */
  const afterCommit = [];
  const obs2 = new DatabaseSync(path);
  try {
    for (const t of ["checkpoints", "writes", "events"])
      afterCommit.push({ table: t, n: count(obs2, t) });
  } finally {
    obs2.close();
  }
  expect(afterCommit.length).toBe(3);
  for (const o of afterCommit) {
    expect(
      o.n,
      "提交后，外部连接到同一文件必须能看见 " +
        o.table +
        " 的行（否则「提交前为 0」只是连接开错了文件）",
    ).toBeGreaterThan(0);
  }
});

// —— 断言 3：节点抛错 → 三表全部无残留 ——
it("节点抛错时事务回滚，checkpoints / writes / events 三表一律零残留", async () => {
  const db = openDb("a3");
  const calls = [];
  const saver = new RecordingSaver(db, calls);
  const graph = linearGraph(saver, { failAt: "b" });

  let threw = null;
  try {
    await txRun(db, () =>
      graph.invoke({ trail: [] }, { configurable: { thread_id: "t-a3" } }),
    );
  } catch (e) {
    threw = String(e?.message ? e.message : e);
  }

  expect(threw, "节点异常必须冒泡，不能在这里被吞掉").toBeTruthy();
  expect(
    calls.length,
    "框架在失败前已经调用过 put（所以回滚才是必要的）",
  ).toBeGreaterThan(0);
  // 关键：不是「部分留下」，而是三张表全空
  expect(count(db, "checkpoints"), "回滚后 checkpoints 必须为 0").toBe(0);
  expect(count(db, "writes"), "回滚后 writes 必须为 0").toBe(0);
  expect(
    count(db, "events"),
    "回滚后 events 必须为 0（审计不得留下孤儿事件）",
  ).toBe(0);
});

/*
 * 断言 4：并发下的事务隔离。分两例，失败后果完全不同：
 *  4a 两个 thread 各自一个事务（两个连接、两个文件）—— 串了就等于把 A 公司的
 *     数据写进 B 公司的库，属于不可逆的数据损坏。
 *  4b 同一 thread 内的并行兄弟节点 —— 它们必须落在【同一个】事务里，否则
 *     并行超步会撕开「Checkpoint 与 events 同事务」这条承诺。
 *
 * 两例都必须证明【并发真的交错了】：顺序执行时它们也会绿，那是空转型假通过。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function racingGraph(saver, tag, trace) {
  const g = new StateGraph(State);
  g.addNode("slow", async () => {
    const st = als.getStore();
    trace.push({
      tag,
      phase: "start",
      sameAsExpected: st && st.db === saver.db,
    });
    await sleep(5 + Math.floor(Math.random() * 25)); // 主动让出事件循环，逼出交错
    trace.push({ tag, phase: "end", sameAsExpected: st && st.db === saver.db });
    st.db
      .prepare(
        "INSERT INTO events (thread_id, checkpoint_id, src) VALUES (?, ?, ?)",
      )
      .run(tag, "node", tag);
    return { trail: "slow" };
  });
  g.addNode("after", () => ({ trail: "after" }));
  g.addEdge("__start__", "slow");
  g.addEdge("slow", "after");
  g.addEdge("after", END);
  return g.compile({ checkpointer: saver });
}

// —— 4a：两个 thread 各持一个事务，互不串用连接 ——
it("两个 thread 并发执行时各自的事务不串用连接，且确实发生了交错", async () => {
  const dbA = openDb("a4a-A");
  const dbB = openDb("a4a-B");
  const callsA = [];
  const callsB = [];
  const trace = [];

  const gA = racingGraph(new RecordingSaver(dbA, callsA), "A", trace);
  const gB = racingGraph(new RecordingSaver(dbB, callsB), "B", trace);

  await Promise.all([
    txRun(dbA, () =>
      gA.invoke({ trail: [] }, { configurable: { thread_id: "t-A" } }),
    ),
    txRun(dbB, () =>
      gB.invoke({ trail: [] }, { configurable: { thread_id: "t-B" } }),
    ),
  ]);

  // 前提：并发真的交错了，否则这条测试什么都没测
  const aStart = trace.findIndex((e) => e.tag === "A" && e.phase === "start");
  const aEnd = trace.findIndex((e) => e.tag === "A" && e.phase === "end");
  const bStart = trace.findIndex((e) => e.tag === "B" && e.phase === "start");
  const bEnd = trace.findIndex((e) => e.tag === "B" && e.phase === "end");
  const interleaved = aStart < bEnd && bStart < aEnd;
  expect(
    interleaved,
    "两次执行没有交错（顺序跑完），本例形同虚设：" +
      JSON.stringify(trace.map((e) => e.tag + e.phase[0])),
  ).toBe(true);

  expect(
    trace.every((e) => e.sameAsExpected),
    "任何一次节点执行拿错连接，就是跨公司写数据",
  ).toBe(true);
  expect(callsA.length, "A 的 Saver 必须被调用过").toBeGreaterThan(0);
  expect(callsB.length, "B 的 Saver 必须被调用过").toBeGreaterThan(0);
  expect(callsA.every((c) => c.sameConn)).toBe(true);
  expect(callsB.every((c) => c.sameConn)).toBe(true);

  // 数据落点：各归各库，零泄漏
  expect(count(dbA, "checkpoints"), "A 库要有 A 的 checkpoint").toBe(
    callsA.filter((c) => c.label === "put").length,
  );
  expect(count(dbA, "events"), "A 库要有 A 的审计行").toBe(1);
  expect(count(dbB, "events"), "B 库要有 B 的审计行").toBe(1);

  /*
   * 「B 用了 A 的库」这种故障，在【同一连接上嵌套 BEGIN】时会被 SQLite 直接
   * 拒绝（cannot start a transaction within a transaction），所以靠崩溃就能挡住。
   * 但靠崩溃不算断言的功劳，而且换一个稍微不同的错法（两个 thread 共用连接但
   * 不嵌套事务）就漏过去了。所以这里正面断言：两个库必须是不同文件，且彼此
   * 看不见对方的数据。
   */
  const pathA = dbA.prepare("PRAGMA database_list").get();
  const pathB = dbB.prepare("PRAGMA database_list").get();
  const fileA = String(Object.values(pathA)[2]);
  const fileB = String(Object.values(pathB)[2]);
  expect(
    fileA === fileB,
    "A 与 B 必须落在不同的库文件上（同文件等于把两家公司写进同一本账）",
  ).toBe(false);
  // 审计行里带着 thread 标签，交叉查询必须为空
  expect(
    countWhere(dbA, "events", "src = " + "'B'"),
    "A 库里不得出现 B 的审计行",
  ).toBe(0);
  expect(
    countWhere(dbB, "events", "src = " + "'A'"),
    "B 库里不得出现 A 的审计行",
  ).toBe(0);
});

// —— 4b：同一 thread 内的并行兄弟节点，必须共用同一个连接（同一事务）——
it("并行兄弟节点与框架 Saver 共用同一个连接，不被并行调度分走", async () => {
  const db = openDb("a4b");
  const calls = [];
  const seen = [];

  const g = new StateGraph(State);
  for (const name of ["left", "right"]) {
    g.addNode(name, async () => {
      const st = als.getStore();
      seen.push({ name, phase: "start", same: st && st.db === db });
      await sleep(2 + Math.floor(Math.random() * 12));
      seen.push({ name, phase: "end", same: st && st.db === db });
      st.db
        .prepare(
          "INSERT INTO events (thread_id, checkpoint_id, src) VALUES (?, ?, ?)",
        )
        .run(name, "node", name);
      return { trail: name };
    });
  }
  g.addNode("join", (s) => ({ trail: "join:" + s.trail.length }));
  g.addEdge("__start__", "left");
  g.addEdge("__start__", "right");
  g.addEdge(["left", "right"], "join");
  g.addEdge("join", END);
  const compiled = g.compile({ checkpointer: new RecordingSaver(db, calls) });

  await txRun(db, () =>
    compiled.invoke({ trail: [] }, { configurable: { thread_id: "t-4b" } }),
  );

  /*
   * 前提（与 4a 的交错断言同构）：两个兄弟节点必须真的在时间上重叠。
   * 缺了它，下面每条断言在【并行退化成顺序执行】时都照样全绿 —— 那等于
   * 在测试一个不存在的并发。实测（本轮）：现在的 LangGraph 1.7.1 每次都
   * 重叠，且把 sleep 改成 0 或纯 microtask 也照样重叠，所以这条断言不会
   * 因机器快慢而误红；它是拿来挡【将来并行退化】的回归的。
   */
  const at = (name: string, phase: string) =>
    seen.findIndex(
      (s: { name: string; phase: string }) =>
        s.name === name && s.phase === phase,
    );
  const overlapped =
    at("left", "start") < at("right", "end") &&
    at("right", "start") < at("left", "end");
  expect(
    overlapped,
    "并行退化成了顺序执行，本例形同虚设：" +
      JSON.stringify(
        seen.map(
          (s: { name: string; phase: string }) => s.name[0] + s.phase[0],
        ),
      ),
  ).toBe(true);
  expect(seen.length, "两个并行节点各留 start / end 共 4 条记录").toBe(4);
  expect(
    seen.every((s) => s.same),
    "并行节点拿到的连接必须就是事务连接：" + JSON.stringify(seen),
  ).toBe(true);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((c) => c.sameConn)).toBe(true);
  // 两条并行分支的审计 + join 之前框架写入的 checkpoint，必须都在同一库里
  expect(count(db, "events"), "两条并行分支的审计行都要在同一库").toBe(2);
  expect(count(db, "checkpoints")).toBe(
    calls.filter((c) => c.label === "put").length,
  );
});
