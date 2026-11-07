import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Checkpoint,
  CheckpointMetadata,
} from "@langchain/langgraph-checkpoint";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireScopeDb } from "../../src/checkpoint/tx-scope.js";
import { openDb } from "../../src/db/driver.js";
import { migrate } from "../../src/db/migrate.js";
import {
  assertParamCount,
  assertSingleStatement,
  WriteQueue,
} from "../../src/db/write-queue.js";

/**
 * Task 0.5　单写者写队列（规格 §5.5、附录 C.2）。
 *
 * ── 【为什么并发用例的 tx 体内必须有 await】────────────────────────────
 * node:sqlite 是同步 API。若 tx 的语句序列全程不 relinquish 事件循环，
 * Promise.all 里的 50 个 tx 天然串行 —— 【完全没有队列也全绿】，测试鉴别力为零。
 * 实测对照（50 个 tx，每个两条 INSERT）：
 *   体内无 await：无队列 49…0 抛错、行数照常 → 测不出区别
 *   体内有 await：无队列 49 抛「cannot start a transaction within a transaction」、
 *                 仅 2 行；有队列 0 抛错、100 行
 * 真实 tx 体内一定有 await（算 sha256、等门控判定、调 checkpoint saver），
 * 所以「有 await」才是生产形态。计划原文只说「并发 50 次各插一行」，没点明这点 ——
 * 缺了它，写队列整个删掉测试也不会变红。
 *
 * ── 相对规格附录 C.2 参考实现的偏离 ──────────────────────────────────
 * 1) 不自己 new DatabaseSync，改用 driver.openDb()：否则 4 条 PRAGMA 就有了第二个
 *    权威源，而两处 PRAGMA 不一致的表现是「打包后 synchronous 掉回 FULL」。
 * 2) 不用 JSON.stringify 打包 stmts（规格 C.2 那么写）。实测该做法会破坏参数类型：
 *    Uint8Array → {"0":0,"1":255,…} → run() 报「Unknown named parameter '0'」；
 *    BigInt 直接抛「Do not know how to serialize a BigInt」；Date 退化成 ISO 字符串。
 *    checkpoint saver 写的正是 BLOB，照抄会做出「测试全绿、生产写不进 checkpoint」。
 * 3) tail 链上的错误不许污染队列（见「一次失败不会卡死队列」用例）。
 */

const HUB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TMP = join(HUB, ".tmp", "write-queue");

const queues: WriteQueue[] = [];
const extraDbs: { close(): void }[] = [];
let seq = 0;

const tick = () => new Promise((r) => setImmediate(r));

/**
 * 建表走【独立连接 + exec】，不通过写队列。
 * 理由见「tx 里的多语句字符串」用例：prepare 只执行第一条语句，
 * 把 "CREATE TABLE a …; CREATE TABLE b …" 交给 tx() 会静默丢掉 b。
 * DDL 属于启动期的一次性动作，本就不该排进运行期写队列。
 */
async function queueWith(ddl: string): Promise<WriteQueue> {
  const path = join(TMP, "wq-" + process.pid + "-" + ++seq + ".db");
  const boot = openDb(path);
  extraDbs.push(boot);
  boot.exec(ddl);
  boot.close();
  const q = new WriteQueue(path);
  queues.push(q);
  return q;
}

const countOf = async (q: WriteQueue, table: string): Promise<number> => {
  const rows = await q.read<{ c: number | bigint }>(
    "SELECT count(*) AS c FROM " + table,
  );
  return Number(rows[0].c);
};

/**
 * 观察一个 promise 的结局，且绝不无限等。返回形如
 * <label>:settled / <label>:threw:<消息> / <label>:TIMEOUT。
 *
 * 为什么要 TIMEOUT 分支而不是让测试自己超时：测试级超时会把整个文件拖成失败，
 * 看不出是哪一条断言没满足；这里把"它没在有限时间内失败"变成一条可读的断言
 * 失败，故障定位落在测试身上而不是 runner 身上。
 */
const NEST_TIMEOUT_MS = 2000;
const outcomeOf = <T>(p: Promise<T>, label: string): Promise<string> =>
  Promise.race([
    p.then(
      () => label + ":settled",
      (e: unknown) => label + ":threw:" + String((e as Error).message),
    ),
    new Promise<string>((resolve) => {
      const t = setTimeout(() => resolve(label + ":TIMEOUT"), NEST_TIMEOUT_MS);
      t.unref();
    }),
  ]);

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterAll(async () => {
  // Windows：句柄不关就 rmSync 会 EBUSY / EPERM（实测过），所以 close 必须 await。
  // WriteQueue.close() 是 async —— 它要先 await 串行链排空，再关两条连接；
  // 同步调用等于把 close 变成没人等的 promise，rmSync 就会撞上仍打开的句柄。
  for (const q of queues) {
    // close() 是幂等的（已关闭直接 return），正常路径下不该失败。
    // 失败必须原样冒出来：吞掉它就会退化成 rmSync 的 EPERM，把断言全过的套件
    // 标成失败，而真正的因由（连接没关）从错误消息里彻底消失。
    await q.close();
  }
  for (const db of extraDbs) {
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
  }
  // Windows：SQLite 句柄的 OS 级释放会落后于 close() 的 promise，rmSync 于是偶发
  // EPERM / EBUSY。断言此时已全部通过，让清理失败冒充测试失败会掩盖真实信号
  // （变异测试时真的踩过一次：一个变异被误判成「已杀死」）。阻塞等待而不是 await ——
  // afterAll 有的是 async 有的是 sync，Atomics.wait 两者都不依赖。
  let cleared = false;
  for (let attempt = 0; attempt < 40 && !cleared; attempt++) {
    try {
      rmSync(TMP, { recursive: true, force: true });
      cleared = true;
    } catch (e) {
      if (attempt === 39) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
});

describe("串行化", () => {
  it("并发 50 次各插一行：50 行且无 database is locked", async () => {
    const q = await queueWith("CREATE TABLE rows (seq INTEGER, tag TEXT)");
    const errs: unknown[] = [];
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        q
          .tx([["INSERT INTO rows (seq, tag) VALUES (?, ?)", [i, "a"]]])
          .catch((e: unknown) => {
            errs.push(e);
          }),
      ),
    );
    expect(errs, "并发提交不得出现锁错误，首个：" + String(errs[0])).toEqual(
      [],
    );
    expect(await countOf(q, "rows")).toBe(50);
    // 逐行核对 seq，而不是只看总数：两个 tx 挤进同一事务时，可能一个的写入被
    // 另一个的回滚带走 —— 总数会少，但如果只断言「无错误」就完全看不出来。
    const seqs = (
      await q.read<{ seq: number }>("SELECT seq FROM rows ORDER BY seq")
    ).map((r) => Number(r.seq));
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it("tx 体内有 await 时仍严格互斥（这才是写队列存在的理由）", async () => {
    const q = await queueWith("CREATE TABLE pair (seq INTEGER, leg TEXT)");
    const errs: unknown[] = [];
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        q
          .node(async () => {
            const db = requireScopeDb("测试 tx 体");
            db.prepare("INSERT INTO pair (seq, leg) VALUES (?, ?)").run(i, "a");
            await tick(); // 让出事件循环：无队列时另一个 tx 会挤进来开第二个事务
            db.prepare("INSERT INTO pair (seq, leg) VALUES (?, ?)").run(i, "b");
          })
          .catch((e: unknown) => errs.push(e)),
      ),
    );
    expect(
      errs,
      "含 await 的 tx 必须被串行化，首个：" + String(errs[0]),
    ).toEqual([]);
    expect(await countOf(q, "pair"), "8 个 tx × 2 条插入 = 16 行").toBe(16);
  });

  it("一次失败不会卡死队列：后续写必须照常成功", async () => {
    const q = await queueWith(
      "CREATE TABLE uniq (u TEXT NOT NULL UNIQUE); CREATE TABLE after (x INTEGER)",
    );
    await q.tx([["INSERT INTO uniq (u) VALUES (?)", ["taken"]]]);

    let threw = false;
    await q
      .tx([
        ["INSERT INTO uniq (u) VALUES (?)", ["taken"]], // UNIQUE 冲突
        ["INSERT INTO after (x) VALUES (1)", []],
      ])
      .catch(() => {
        threw = true;
      });
    expect(threw, "失败必须上抛（风险 6：宁可停，不可丢事件）").toBe(true);

    // 关键：若失败把 tail 链污染成 rejected，此后每次提交都会以
    // 「cannot start a transaction within a transaction」失败 —— Hub 从此再也写不进
    // 任何东西，而所有报错都指向「事务嵌套」这个假原因，看不见第一次的真失败。
    // 这是实测出来的失效形态（规格 C.2 的实现就会这样），不是假想。
    await expect(
      q.tx([["INSERT INTO after (x) VALUES (2)", []]]),
    ).resolves.toBeUndefined();
    expect(await countOf(q, "after")).toBe(1);
  });

  it("失败之后立刻 close()：不得重抛旧失败，且必须真的关掉连接", async () => {
    const q = await queueWith("CREATE TABLE uniq2 (u TEXT NOT NULL UNIQUE)");
    await q.tx([["INSERT INTO uniq2 (u) VALUES (?)", ["taken"]]]);
    await q.tx([["INSERT INTO uniq2 (u) VALUES (?)", ["taken"]]]).catch(() => {
      /* 预期失败，调用方已处理 */
    });

    // 与上一条测试的分工：上一条证明【后续写入】不被污染，靠的是 #tail.then(job, job)
    // 两条分支都接了 job —— 哪怕 tail 是 rejected 的，新任务照样会跑，那条变异在那儿
    // 【测不出来】（实测：去掉 SETTLED 去毒，18 条断言全过）。这里中间不夹任何成功写入，
    // 直接 close()：close 内部 await this.#tail，tail 若带毒就会把早就处理掉的 UNIQUE
    // 冲突重新抛出来，close() 当场中断 —— #closed 与两条 db.close() 都不执行，于是
    // WAL 没 checkpoint、两条连接悬挂、Windows 上库文件被永久占用。
    // 这是 tail 去毒唯一【外部可见】的后果，所以值得一条独立测试。
    await expect(
      q.close(),
      "close() 不得重新抛出早已处理过的旧失败",
    ).resolves.toBeUndefined();

    // close 真的走完了：#closed 已置位，再碰它就是错误；重复 close 必须静默 no-op
    expect(() => q.writeConnection()).toThrow(/已关闭/u);
    expect(() => q.readConnection()).toThrow(/已关闭/u);
    await expect(
      q.close(),
      "重复 close() 必须是 no-op",
    ).resolves.toBeUndefined();
  });
});

describe("tx 的边界", () => {
  it("tx 里塞多条语句的字符串必须抛错，不许静默丢第二条", async () => {
    const q = await queueWith(
      "CREATE TABLE a (x INTEGER); CREATE TABLE b (x INTEGER)",
    );
    // 实测：db.prepare("INSERT INTO a …; INSERT INTO b …") 不报错，但【只执行第一条】，
    // b 永远 0 行。审计库里「events 写了、预算没累计」就是这么来的。
    await expect(
      q.tx([
        ["INSERT INTO a (x) VALUES (1); INSERT INTO b (x) VALUES (2)", []],
      ]),
    ).rejects.toThrow(/多于一(条语句|条)|多条语句|单条/);
    expect(
      await countOf(q, "a"),
      "整笔必须回滚，不能留下已经执行的第一个分片",
    ).toBe(0);
    expect(await countOf(q, "b")).toBe(0);
  });

  it("空 stmts 的 tx 合法（no-op）：合法空集不该被当成错误", async () => {
    const q = await queueWith("CREATE TABLE e (x INTEGER)");
    await expect(q.tx([])).resolves.toBeUndefined();
    expect(await countOf(q, "e")).toBe(0);
  });

  it("tx 内第二条失败 → 第一条不可见", async () => {
    const q = await queueWith(
      "CREATE TABLE audit (id INTEGER PRIMARY KEY, note TEXT); " +
        "CREATE TABLE blocker (n INTEGER NOT NULL)",
    );
    let threw = false;
    await q
      .tx([
        ["INSERT INTO audit (note) VALUES (?)", ["第一条成功但必须被回滚"]],
        ["INSERT INTO blocker (n) VALUES (?)", [null]], // NOT NULL 违约
      ])
      .catch(() => {
        threw = true;
      });
    expect(threw).toBe(true);
    // 只断言 0 行是【假通过】：把循环写成「只执行最后一条」同样得到 0 行。
    // 所以补一条 differential：证明第一条语句确实执行过。
    expect(
      await countOf(q, "audit"),
      "同事务内的前一条必须一起回滚（§6.3）",
    ).toBe(0);
    let threw2 = false;
    const seen: number[] = [];
    await q
      .node(async () => {
        const db = requireScopeDb("差分对照");
        db.prepare("INSERT INTO audit (note) VALUES (?)").run(
          "写了，应当被回滚",
        );
        // 在同一事务内自读：能看到说明第一条真的执行了，而非被跳过
        seen.push(
          Number(db.prepare("SELECT count(*) AS c FROM audit").get().c),
        );
        throw new Error("故意失败");
      })
      .catch(() => {
        threw2 = true;
      });
    expect(threw2).toBe(true);
    expect(
      seen,
      "事务内自读必须看到自己的写入，否则上面那个 0 行毫无意义",
    ).toEqual([1]);
    expect(await countOf(q, "audit")).toBe(0);
  });

  it("参数原样绑定：BLOB 不得被序列化往返破坏", async () => {
    const q = await queueWith("CREATE TABLE blobs (b BLOB, j TEXT)");
    const bytes = new Uint8Array([0, 255, 16, 0, 1]);
    await q.tx([
      ["INSERT INTO blobs (b, j) VALUES (?, ?)", [bytes, '{"k":1}']],
    ]);

    const rows = await q.read<{ b: Uint8Array; j: string }>(
      "SELECT b, j FROM blobs",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].b, "BLOB 必须以字节到达").toBeInstanceOf(Uint8Array);
    expect(Array.from(rows[0].b)).toEqual(Array.from(bytes));
    expect(rows[0].j).toBe('{"k":1}');
  });

  it("参数少绑必须抛错（node:sqlite 自己【不报】这个错）", async () => {
    const q = await queueWith("CREATE TABLE p (a TEXT, b TEXT)");
    let msg = "";
    try {
      await q.tx([["INSERT INTO p (a, b) VALUES (?, ?)", ["只有这一个"]]]);
    } catch (e) {
      msg = String((e as Error).message);
    }
    // 实测依据（写这条测试的全部理由）：node:sqlite 对【少绑】参数在可空列上
    // 【不报错】，直接写 NULL —— 只绑一个值时得到 {"a":"只有这一个","b":null}；
    // 只有【多绑】才抛 "column index out of range"。也就是说最危险的方向毫无保护。
    // events 的 task_id / target / state_snapshot 都是可空列，少绑一个参数就写出
    // 「事件记了但没关联任务」，而 NULL 完全合法，审计回放看不出任何异常。
    expect(msg, "少绑必须由写队列自己拦住").toMatch(/占位符与参数个数不符/u);
    expect(msg, "少绑必须由写队列自己拦住").toMatch(/占位符与参数个数不符/u);
    // 锁住自己写的消息文案是有意为之：这条错误的全部价值在于解释了「为什么少绑比
    // 多绑危险」。谁把它简化成一句 "param mismatch"，这条就会红。Node 侧文案不锁，
    // 自己的文案锁。
    expect(msg, "错误消息必须保留解释：少绑会静默写出 NULL").toMatch(/NULL/u);
    expect(msg).toMatch(/宁可抛错/u);

    // 反向对照：证明上面的 0 行来自拦截，而不是「这条 SQL 本来也插不进去」。
    // 绕过校验直接用只读之外的连接写 —— 这里用 writeConnection()，它不经过参数校验，
    // 于是能把 node:sqlite 的静默语义原样暴露出来。这条断言是整个用例的活文档：
    // 将来谁升级 Node 后行为变了（开始报错了），这条会失败并告诉我们校验可以删。
    // 反向对照：证明上面的 0 行来自【拦截】，而不是「这条 SQL 本来也插不进去」。
    // writeConnection() 不经过参数校验，用它把 node:sqlite 的静默语义原样暴露出来 ——
    // 与探针同样的调用形态：两个占位符只传一个实参。注意不能改写成显式绑 undefined，
    // 那是「绑定 NULL」而不是「少绑」，两回事，只有前者才是这条测试要钉住的行为。
    // 这条断言同时是活文档：将来升级 Node 后若 SQLite 自己开始报错，它会失败，
    // 并告诉我们写队列里那层校验可以删掉了。
    q.writeConnection()
      .prepare("INSERT INTO p (a, b) VALUES (?, ?)")
      .run("绕开写队列");
    const rows = await q.read<{ a: string | null; b: string | null }>(
      "SELECT a, b FROM p",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.b, "少绑在 SQLite 层面确实静默写成 NULL").toBeNull();

    // 多绑方向：node:sqlite 自己会抛（实测 "column index out of range"，errcode 25）。
    // 校验应当【先于】它生效，给出比原文更有信息量的中文提示。
    let over = "";
    try {
      await q.tx([["INSERT INTO p (a, b) VALUES (?, ?)", ["x", "y", "z"]]]);
    } catch (e) {
      over = String((e as Error).message);
    }
    expect(over, "多绑也要给出中文提示，而不是 Node 的原文").toMatch(
      /占位符与参数个数不符/u,
    );
    expect(
      await countOf(q, "p"),
      "多绑被拦：行数仍只是上面 bypass 写入的那一行",
    ).toBe(1);
  });
  it("字符串字面量与注释里的 ? 和分号都不参与计数", () => {
    // ── 三条方向不同的断言，各钉住 skeleton() 的一处失效，缺一不可 ──
    //
    // ① 字面量替换成【空格】而不是 ?：若替换成 ?，"VALUES (?, '?')" 会被数成 2 个
    //    占位符，合法写入被误拦。误拦比漏拦更糟 —— 它挡住的是正确的业务代码。
    expect(() =>
      assertParamCount("INSERT INTO t VALUES (?, '?')", ["x"]),
    ).not.toThrow();
    expect(() =>
      assertParamCount("INSERT INTO t VALUES ('?', '?')", []),
    ).not.toThrow();
    //
    // ② 注释必须被【剥掉】：行注释里的 ? 不计数，所以传 0 个参数才对。
    //    若去掉 '--' 处理，这一行的 anonymous 变成 1，传 [] 就会抛「个数不符」——
    //    合法 SQL 被拦下。块注释同理。
    expect(() =>
      assertParamCount("SELECT 1 -- 备注里有个 ?", []),
    ).not.toThrow();
    expect(() => assertParamCount("SELECT 1 /* 也有个 ? */", [])).not.toThrow();
    expect(() =>
      assertSingleStatement("SELECT 1 -- 尾巴上有个 ;"),
    ).not.toThrow();
    //
    // ③ 反方向：字符串内部的 -- 与 /* 【不得】被当成注释起点。
    //    若扫描顺序弄反（先找注释再跳字符串），从 '-- 一路吃到行尾，后面的 ?, ? 一起
    //    消失，anonymous 变 0 —— 于是传 1 个参数反被拦。0001_init.sql 的注释里就有
    //    成对的分号和问号，这条同时保护迁移路径。
    expect(() =>
      assertParamCount("SELECT '-- not a comment', ?", ["x"]),
    ).not.toThrow();
    expect(() =>
      assertSingleStatement("INSERT INTO t VALUES ('; -- /*')"),
    ).not.toThrow();
  });

  it("匿名 ? 的个数必须等于参数个数（少绑与多绑都抛）", () => {
    expect(() =>
      assertParamCount("INSERT INTO t VALUES (?)", ["x"]),
    ).not.toThrow();
    // 少绑：node:sqlite 在可空列上【不报错】、直接写 NULL（实测）。这层校验是唯一防线。
    expect(() => assertParamCount("INSERT INTO t VALUES (?)", [])).toThrow(
      /占位符与参数个数不符/u,
    );
    expect(() =>
      assertParamCount("INSERT INTO t VALUES (?, ?)", ["x"]),
    ).toThrow(/占位符与参数个数不符/u);
    expect(() =>
      assertParamCount("INSERT INTO t VALUES (?)", ["a", "b"]),
    ).toThrow(/占位符与参数个数不符/u);
    // 无占位符却传参 —— 同样拦下（参数会被静默丢弃，属同一类错误）
    expect(() => assertParamCount("SELECT 1", ["x"])).toThrow(
      /占位符与参数个数不符/u,
    );
    expect(() => assertParamCount("SELECT 1", [])).not.toThrow();
  });

  it("编号 ?N：我们【放弃】校验交给 SQLite，绝不猜", async () => {
    // 编号风格下「参数个数」与「占位符个数」不是一回事（实测 ?1,?1 只消耗【一个】位置
    // 参数），任何基于计数的校验都会误判，所以 indexedMax > 0 时直接 return。
    expect(() =>
      assertParamCount("INSERT INTO t VALUES (?1, ?2)", ["a", "b"]),
    ).not.toThrow();
    expect(() =>
      assertParamCount("INSERT INTO t VALUES (?1, ?1)", ["a", "b"]),
    ).not.toThrow();
    // 少传也放行：这是有意的取舍 —— 宁可不校验，也不用一条错的规则去拦对的 SQL。
    expect(() =>
      assertParamCount("INSERT INTO t VALUES (?1, ?2)", ["a"]),
    ).not.toThrow();

    // 但「放弃」不等于「漏过去」：真绑错时由 SQLite 兜底。上面纯函数的放行配上这里库层
    // 的报错才构成完整语义 —— 单看任何一半都可能被误读成漏洞。
    const q = await queueWith("CREATE TABLE idx (a TEXT, b TEXT)");
    await q.tx([["INSERT INTO idx (a, b) VALUES (?1, ?2)", ["一", "二"]]]);
    expect(await countOf(q, "idx"), "合法的 ?1,?2 不得被我们的校验误拦").toBe(
      1,
    );
    let msg = "";
    try {
      await q.tx([["INSERT INTO idx (a, b) VALUES (?1, ?1)", ["一", "二"]]]);
    } catch (e) {
      msg = String((e as Error).message);
    }
    expect(msg, "?1,?1 只消耗一个位置参数，第二个应由 SQLite 拒绝").not.toBe(
      "",
    );
    expect(msg, "我们放弃了编号风格，就不该冒充报错方").not.toMatch(
      /占位符与参数个数不符/u,
    );
    expect(msg).toMatch(/column index out of range|out of range/iu);
  });

  it("双冒号不得被当成命名参数（否则少绑校验会被静默关掉）", () => {
    // scanPlaceholders 遇到单个冒号会置 otherStyle=true，而 otherStyle 会让
    // assertParamCount【整个 return】。所以把双冒号误判成命名参数的后果不是报错变多，
    // 而是【校验消失】—— 同一条 SQL 里的少绑再也拦不住，静默写 NULL。这条测的就是这点。
    // 注：双冒号并不是 SQLite 的类型转换写法（实测 unrecognized token），那是 PostgreSQL
    // 方言；跳过第二个冒号唯一的作用是防止 a::b 误置 otherStyle。
    expect(() =>
      assertParamCount("SELECT a::b FROM t WHERE c = ?", []),
    ).toThrow(/占位符与参数个数不符/u);
    expect(() =>
      assertParamCount("SELECT a::b FROM t WHERE c = ?", ["x"]),
    ).not.toThrow();
    // 真正的命名参数仍然放弃校验
    expect(() =>
      assertParamCount("INSERT INTO t VALUES (:name)", [{ name: "x" }]),
    ).not.toThrow();
    expect(() =>
      assertParamCount("INSERT INTO t VALUES (:name)", []),
    ).not.toThrow();
  });

  it("尾分号放行；真多条语句拒绝；触发器体是已知边界", () => {
    // 人写 SQL 习惯带尾分号。replace(/;+$/u, "") 就是为此；去掉它，所有带尾分号的合法
    // 写入都会被误判成多条语句。
    expect(() => assertSingleStatement("UPDATE t SET x = 1;")).not.toThrow();
    expect(() => assertSingleStatement("UPDATE t SET x = 1;;")).not.toThrow();
    expect(() =>
      assertSingleStatement(
        "INSERT INTO t VALUES (1); INSERT INTO u VALUES (2)",
      ),
    ).toThrow(/多于一(条语句|条)|多条语句|单条/);
    // 已知边界（不是 bug，但必须写下来）：触发器体里的 BEGIN … INSERT …; END 含分号，
    // 会被判成多条。因此【任何 DDL 都不得走 WriteQueue.tx()】—— DDL 走 migrate() 的
    // db.exec()，那里没有这条限制。0001_init.sql 的 5 个触发器就是这么活下来的。
    expect(() =>
      assertSingleStatement(
        "CREATE TRIGGER tr AFTER INSERT ON e BEGIN INSERT INTO f VALUES (1); END",
      ),
    ).toThrow(/多于一(条语句|条)|多条语句|单条/);
  });
  it("嵌套 node() 必须立刻拒绝（不静默复用外层事务，也不许死锁）", async () => {
    const q = await queueWith("CREATE TABLE nest (x INTEGER)");
    let innerOutcome = "";
    let outerScope = "";
    await q.node(async () => {
      // 关键：外层【不直接 await 内层 promise】。旧写法是 await q.node(...)，一旦去掉
      // node() 里的 currentScope() 守卫，内层就排到外层后面、外层又在等内层 —— 真死锁，
      // 只能靠测试超时结束（实测：整文件被拖挂 31 秒，失败消息不含任何有用信息）。
      // outcomeOf 给了有限期限，"嵌套没有被拒绝"于是变成一条可读的断言失败，
      // 而不是 runner 超时。
      innerOutcome = await outcomeOf(
        q.node(() => undefined),
        "inner",
      );
      outerScope = String(requireScopeDb("嵌套检查") !== undefined);
    });
    expect(innerOutcome, "嵌套必须被拒绝，静默复用会把提交时机变成谜").toMatch(
      /inner:threw/u,
    );
    expect(innerOutcome).toMatch(/嵌套/u);
    expect(outerScope, "外层必须仍持有自己的事务作用域").toBe("true");
  });
});

describe("read 走独立连接（规格 §5.5）", () => {
  it("读不到未提交数据，读得到已提交数据", async () => {
    const q = await queueWith("CREATE TABLE vis (x INTEGER)");
    let threw = false;
    await q
      .node(async () => {
        requireScopeDb("测试可见性")
          .prepare("INSERT INTO vis (x) VALUES (1)")
          .run();
        throw new Error("故意回滚");
      })
      .catch(() => {
        threw = true;
      });
    expect(threw).toBe(true);
    expect(await countOf(q, "vis"), "回滚的写入不得被 read 看见").toBe(0);

    await q.tx([["INSERT INTO vis (x) VALUES (2)", []]]);
    expect(await countOf(q, "vis")).toBe(1);
  });

  it("read 的连接物理上写不进（只读连接，不是靠约定）", async () => {
    const q = await queueWith("CREATE TABLE ro (x INTEGER)");
    // 规格说「只读查询走独立连接」。独立连接若仍可写，误用 read() 执行 DML 就会
    // 绕开单写者 —— 于是「单写者」变成两句注释，实际有两个写者，WAL 下表现为
    // SQLITE_BUSY 或丢写。实测：node:sqlite 的 readOnly 连接写入报
    // "attempt to write a readonly database"。
    let msg = "";
    try {
      q.readConnection().exec("INSERT INTO ro (x) VALUES (1)");
    } catch (e) {
      msg = String((e as Error).message);
    }
    expect(msg).toMatch(/readonly|read only/iu);
    expect(await countOf(q, "ro")).toBe(0);
  });

  it("read 绑定参数，不做字符串拼接", async () => {
    const q = await queueWith("CREATE TABLE bind (t TEXT)");
    await q.tx([["INSERT INTO bind (t) VALUES (?)", ["a' OR 1=1 --"]]]);
    expect(await q.read<{ t: string }>("SELECT t FROM bind")).toHaveLength(1);
    const hit = await q.read<{ c: number }>(
      "SELECT count(*) AS c FROM bind WHERE t = ?",
      ["a' OR 1=1 --"],
    );
    expect(Number(hit[0].c)).toBe(1);
    const none = await q.read<{ c: number }>(
      "SELECT count(*) AS c FROM bind WHERE t = ?",
      ["不存在的值"],
    );
    expect(Number(none[0].c)).toBe(0);
  });

  it("read 不排队：外层写事务持锁时仍能读（读不该被写队列饿住）", async () => {
    const q = await queueWith("CREATE TABLE busy_probe (x INTEGER)");
    await q.tx([["INSERT INTO busy_probe (x) VALUES (1)", []]]);
    // 读连接独立且只读：即便写连接正处事务中，read 也必须返回而不是等 5 秒超时。
    let readDuringTx = -1;
    await q.node(async () => {
      requireScopeDb("持锁期间读")
        .prepare("INSERT INTO busy_probe (x) VALUES (2)")
        .run();
      readDuringTx = await (async () => await countOf(q, "busy_probe"))();
    });
    // 独立连接看不到本事务未提交的那行 → 应为 1（不是 2）
    expect(readDuringTx).toBe(1);
    expect(await countOf(q, "busy_probe")).toBe(2);
  });
  it("只读连接同样带 busy_timeout / foreign_keys（读方也是连接）", async () => {
    // openReadonlyDb() 除了 readOnly: true，还必须把 pragmas.ts 那套连接级设置装上。
    // 最容易漏的是 busy_timeout：它的默认值是【0】—— 一旦撞上 EXCLUSIVE 锁（VACUUM、
    // journal_mode 切换期间），读会【立刻】抛 SQLITE_BUSY 而不是等 5 秒。"UI 读自己的
    // 库却偶发 database is locked" 就是这么来的，而它只在压力下出现，最难复现。
    //
    // 变异实测（别把"冗余"当成"安全"，得分别验）：
    //   R1 单独注释掉下面 openReadonlyDb 里的 applyPragmas() → 存活。构造函数选项
    //      已经把 foreign_keys/timeout 设成同样的值，journal_mode=WAL 又持久化在库
    //      文件里，所以单拆一处真的没有可观测差异 —— 这才是"双保险"的含义。
    //   X2 同时拆除两处（内联选项改 false/0 且不调 applyPragmas）→ 本用例杀死，
    //      报 "expected '0' to be '5000'"。
    // 所以这条钉的不是"今天有没有 bug"，而是【两处一起塌】的那一刻。
    const q = await queueWith("CREATE TABLE rop (x INTEGER)");
    const db = q.readConnection();
    const pragma = (name: string): string => {
      const row = db.prepare("PRAGMA " + name).get() as Record<string, unknown>;
      return String(Object.values(row)[0]);
    };
    expect(
      pragma("busy_timeout"),
      "读连接的 busy_timeout 默认是 0，必须显式设成 5000",
    ).toBe("5000");
    expect(pragma("foreign_keys")).toBe("1");
    expect(pragma("journal_mode")).toBe("wal");
  });
});

describe("与迁移的衔接", () => {
  it("migrate 与写队列共存于同一文件（写队列不独占库）", async () => {
    const path = join(TMP, "wq-" + process.pid + "-" + ++seq + ".db");
    const boot = openDb(path);
    extraDbs.push(boot);
    migrate(boot);
    boot.close();

    const q = new WriteQueue(path);
    queues.push(q);
    const names = (
      await q.read<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = ? ORDER BY name",
        ["table"],
      )
    ).map((t) => t.name);
    expect(names).toContain("events");
    expect(names).toContain("schema_migrations");
    // 写队列的连接也必须带上 openDb 的 PRAGMA，否则 foreign_keys 会静默为 OFF
    expect(
      q.writeConnection().prepare("PRAGMA foreign_keys").get(),
    ).toMatchObject({
      foreign_keys: 1,
    });
  });
});

describe("把 0.4b 的 checkpoint saver 装进写队列事务（§6.3 的真正目的）", () => {
  // 这一节是 node() 存在的理由。不是为了在单测里造一个 await，而是：0.4b 的
  // SqliteWALSaver.put 用 requireScopeDb() 取连接（saver.ts:262），指望调用方已经
  // 开好事务；写队列负责 BEGIN IMMEDIATE/COMMIT。两者接起来才可能有 §6.3 要求的
  // 「Checkpoint 与 events 同一事务」—— 否则审计回放会出现「状态变了但没日志」。

  const ck = (id: string): Checkpoint => ({
    // 形状照抄 saver.contract.test.ts:116（v:4 + 无 pending_sends），不是猜的：
    // v 错了 serde 会拒绝，那时测的就不是原子性而是版本校验。
    v: 4,
    id,
    ts: new Date(1700000000000).toISOString(),
    channel_values: { doc: "value-" + id },
    channel_versions: { doc: 1 },
    versions_seen: {},
  });

  const meta: CheckpointMetadata = { source: "loop", step: 0, parents: {} };

  const cfg = (
    threadId: string,
  ): { configurable: Record<string, unknown> } => ({
    configurable: { thread_id: threadId, checkpoint_ns: "" },
  });

  /** 建一个「已经 migrate 过」的空库路径；句柄必须关掉，否则 Windows 上 EBUSY。 */
  const migratedPath = (tag: string): string => {
    const path = join(TMP, "wq-" + tag + "-" + process.pid + ".db");
    const boot = openDb(path);
    migrate(boot);
    boot.close();
    return path;
  };

  const countCheckpoints = async (q: WriteQueue): Promise<number> => {
    const rows = await q.read<{ n: number | string }>(
      "SELECT count(*) AS n FROM checkpoints",
    );
    return Number(rows[0]?.n);
  };

  it("同事务内 events 写失败 → saver 写的 checkpoint 一起回滚", async () => {
    const queue = new WriteQueue(migratedPath("atomic"));
    queues.push(queue);
    // saver 的构造参数只用于【读】路径（getTuple/list 走 this.db），
    // 而 put/putWrites 走 requireScopeDb()。所以必须把这条连接就是队列的写连接 ——
    // 否则「同一事务」在物理上就是两个连接，回滚永远看不到对方的写入。
    const { SqliteWALSaver } = await import("../../src/checkpoint/saver.js");
    const saver = new SqliteWALSaver(queue.writeConnection());

    let message = "";
    await queue
      .node(async () => {
        await saver.put(cfg("thr-atomic"), ck("ckpt-atomic"), meta, {});
        // 故意在同事务里制造失败：payload NOT NULL。选它而不是 append-only 触发器，
        // 因为触发器抛的是 ABORT（语句级回滚），NOT NULL 是约束违约，两者回滚范围不同，
        // 这里要的是「事务后续失败 → 前面的写入整体不见」。
        queue
          .writeConnection()
          .prepare(
            "INSERT INTO events (actor_type, actor_id, action, payload, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run("system", "hub", "node.end", null, 1700000000000);
      })
      .catch((e: unknown) => {
        message = e instanceof Error ? e.message : String(e);
      });
    expect(message).toMatch(/NOT NULL|constraint/iu);

    expect(
      await countCheckpoints(queue),
      "事件写失败，同事务的 checkpoint 必须一起消失",
    ).toBe(0);
  });

  it("反向对照：同一个 put 没有后续失败时确实写出一行", async () => {
    // 缺这条，上面的 0 行就可能来自「根本没写成功」：例如 ALS 作用域没建起来，
    // put 在 requireScopeDb 处抛错，压根没走到 INSERT —— 那时 0 行是假阳性。
    // 两个 0 不构成原子性证明；必须有「正常路径确实写得出 1 行」作对照。
    const queue = new WriteQueue(migratedPath("atomic-ok"));
    queues.push(queue);
    const { SqliteWALSaver } = await import("../../src/checkpoint/saver.js");
    const saver = new SqliteWALSaver(queue.writeConnection());
    await queue.node(async () => {
      await saver.put(cfg("thr-ok"), ck("ckpt-ok"), meta, {});
    });
    expect(
      await countCheckpoints(queue),
      "put 在 queue.node() 里必须真的落一行",
    ).toBe(1);
  });
});
