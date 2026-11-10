import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

/**
 * Task 0.3　把 D6 决策记录（docs/decisions/0001-sqlite-driver.md §2.1 / §2.2）的探针结论
 * 固化成仓库内测试。在此之前这些结论只躺在归档探针脚本里 —— 驱动一旦不可用，CI 毫无反应。
 *
 * 为什么【绝不 skip】：若运行时没有 node:sqlite，本文件在加载阶段就抛错并提示改判 D6-b。
 * skip 会让「驱动不可用」在 CI 里静默通过，而这正是 D6 最坏的失效方式。
 *
 * 断言与决策文档表格【逐行对应】，便于核对「固化」是否完整；每条测试上方标注对应行。
 */

type Db = InstanceType<typeof import("node:sqlite")["DatabaseSync"]>;

let DatabaseSync: typeof import("node:sqlite")["DatabaseSync"];
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch (e) {
  throw new Error(
    "目标运行时没有 node:sqlite —— 按规格 §25-D6 应【改判 D6-b】（改用 better-sqlite3），" +
      "而不是把本测试 skip 掉。请确认 Node 主版本为 24 LTS（package.json engines 已锁 >=24 <25）。" +
      "原始错误：" +
      (e as Error).message,
  );
}

const TMP = fixtureTmp("driver-preflight", import.meta.url);

const opened: Db[] = [];
let seq = 0;
function freshDb(): { db: Db; path: string } {
  const path = join(TMP, "probe-" + process.pid + "-" + ++seq + ".db");
  const db = new DatabaseSync(path) as Db;
  opened.push(db);
  return { db, path };
}

function get(
  db: Db,
  sql: string,
  ...params: unknown[]
): Record<string, unknown> {
  return (
    db.prepare as (s: string) => {
      get: (...a: unknown[]) => Record<string, unknown>;
    }
  )(sql).get(...params);
}

/**
 * 读 PRAGMA 的第一列。
 *
 * 不要写 get(db, "PRAGMA busy_timeout")["busy_timeout"]：实测该 PRAGMA 的返回列名是
 * 【timeout】而非 busy_timeout（journal_mode / foreign_keys / synchronous 才与名字同名）。
 * 取不存在的 key 得 undefined，Number(undefined) = NaN —— 测试会以「值是 NaN」失败，
 * 看着像实现坏了，其实是断言写错列名。读第一列可以免疫这类脆弱依赖。
 */
function pragma<T extends string | number>(db: Db, name: string): T {
  const row = get(db, "PRAGMA " + name);
  return Object.values(row)[0] as T;
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  // 先释放文件句柄再删目录：Windows 上不 close 就 rm 会 EBUSY
  for (const db of opened) {
    try {
      db.close();
    } catch {
      /* 已关闭过，忽略 */
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

describe("运行时身份守卫", () => {
  it("node:sqlite 可加载且 DatabaseSync 可用", () => {
    expect(typeof DatabaseSync).toBe("function");
  });

  // §2.1 行「db.backup() 是否存在 → 不存在」：备份只能用 VACUUM INTO（V8）
  it("db.backup() 不存在：备份只能走 VACUUM INTO（决策 §2.1 / V8）", () => {
    const { db } = freshDb();
    // 反向断言。若未来 Node 给 node:sqlite 补上 backup()，本测试会红 —— 那是好事：
    // 提醒 Task 0.5 的 backup.ts 可以简化，而不是把绕行代码永久留在仓库里。
    expect(
      (db as unknown as Record<string, unknown>)["backup"],
    ).toBeUndefined();
  });
});

describe("决策 §2.1：PRAGMA / append-only / 同事务", () => {
  // §2.1 行「WAL 可开启」+ 统一 PRAGMA 由 driver.openDb 负责
  it("openDb 统一 PRAGMA：wal / foreign_keys=1 / busy_timeout=5000 / synchronous=1", async () => {
    const { openDb } = await import("../../src/db/driver.js");
    // 必须走 openDb 本身：曾经的写法是引入 openDb 却调用 freshDb()（裸构造），
    // 于是断言的是「裸连接没设 WAL」，driver.ts 被改坏时这条照样通过 —— 无效测试。
    const path = join(TMP, "openDb-" + process.pid + "-" + ++seq + ".db");
    const db = openDb(path);
    opened.push(db);
    expect(pragma(db, "journal_mode")).toBe("wal");
    expect(pragma(db, "foreign_keys")).toBe(1);
    expect(pragma(db, "busy_timeout")).toBe(5000);
    expect(pragma(db, "synchronous")).toBe(1); // NORMAL；默认是 2 = FULL
  });

  // §2.1 行「-wal 文件生成 → 是」
  it("WAL 生效后写入会生成 -wal 文件", () => {
    const { db, path } = freshDb();
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("CREATE TABLE t (v TEXT)");
    db.exec("BEGIN");
    db.prepare("INSERT INTO t (v) VALUES ('x')").run();
    db.exec("COMMIT");
    expect(existsSync(path + "-wal")).toBe(true);
  });

  // §2.1 行「append-only 触发器：UPDATE 被 RAISE(ABORT) 拦下」
  it("append-only 触发器拦下 UPDATE / DELETE（规格 §6.1 的地基）", () => {
    const { db } = freshDb();
    db.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, kind TEXT)");
    db.exec(
      "CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN " +
        "SELECT RAISE(ABORT, 'immutable'); END",
    );
    db.exec(
      "CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN " +
        "SELECT RAISE(ABORT, 'immutable'); END",
    );
    db.prepare("INSERT INTO events (kind) VALUES ('created')").run();

    expect(() =>
      db.prepare("UPDATE events SET kind = 'x' WHERE id = 1").run(),
    ).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM events WHERE id = 1").run()).toThrow(
      /immutable/,
    );
    // 拦下之后原行必须完好，且 INSERT 仍然允许
    expect(
      String(get(db, "SELECT kind FROM events WHERE id = 1")["kind"]),
    ).toBe("created");
    expect(() =>
      db.prepare("INSERT INTO events (kind) VALUES ('appended')").run(),
    ).not.toThrow();
  });

  // §2.1 行「三表同一事务提交」+「中途失败整体回滚」：规格 §6.3 的核心
  it("checkpoints + writes + events 三表同一事务提交；中途失败则三表同时回滚", () => {
    const { db } = freshDb();
    db.exec("CREATE TABLE checkpoints (id TEXT PRIMARY KEY)");
    db.exec(
      "CREATE TABLE writes (id INTEGER PRIMARY KEY AUTOINCREMENT, ck TEXT NOT NULL)",
    );
    db.exec(
      "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ck TEXT NOT NULL UNIQUE)",
    );

    const commitAll = (ck: string) => {
      db.exec("BEGIN");
      try {
        db.prepare("INSERT INTO checkpoints (id) VALUES (?)").run(ck);
        db.prepare("INSERT INTO writes (ck) VALUES (?)").run(ck);
        db.prepare("INSERT INTO events (ck) VALUES (?)").run(ck);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    };

    commitAll("ck-ok");
    expect(Number(get(db, "SELECT COUNT(*) AS c FROM checkpoints")["c"])).toBe(
      1,
    );

    // 第二条故意失败：events.ck 有 UNIQUE 约束，模拟「写事件失败」
    expect(() => commitAll("ck-ok")).toThrow(/UNIQUE|constraint/i);

    // 关键断言：失败后【三张表都没有半提交行】，而不是只有 events 干净
    const counts = (["checkpoints", "writes", "events"] as const).map((t) =>
      Number(get(db, "SELECT COUNT(*) AS c FROM " + t)["c"]),
    );
    expect(counts).toEqual([1, 1, 1]);
  });

  // §2.1 行「db.function() 自定义 SQL 函数 → 可用」
  it("db.function() 可注册自定义函数（但禁止承载业务规则，见决策 §4.4）", () => {
    const { db } = freshDb();
    (
      db as unknown as {
        function: (
          name: string,
          opts: Record<string, unknown>,
          fn: (...a: unknown[]) => unknown,
        ) => void;
      }
    ).function(
      "opc_len",
      { deterministic: true },
      (s: unknown) => [...String(s)].length,
    );
    expect(Number(get(db, "SELECT opc_len('abc中') AS n")["n"])).toBe(4);
  });

  // §2.1 行「BLOB 往返类型 → Uint8Array」：Saver 存 Checkpoint 二进制的必要能力
  it("BLOB 往返保持字节内容（Saver 存 Checkpoint 二进制的前提）", () => {
    const { db } = freshDb();
    db.exec("CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB)");
    const src = new Uint8Array([0, 1, 2, 253, 254, 255]);
    db.prepare("INSERT INTO blobs (data) VALUES (?)").run(src);
    const back = get(db, "SELECT data FROM blobs WHERE id = 1")["data"];
    expect(back).toBeInstanceOf(Uint8Array);
    // 刻意不断言 constructor.name：我们要的是「能装字节、能原样取回」的容器，
    // Buffer 是 Uint8Array 子类，同样满足 Saver 的需要。断言类名只会制造脆弱测试。
    expect(Array.from(back as Uint8Array)).toEqual(Array.from(src));
  });

  // §2.1 行「事务内 2000 行 → 1 ms（内存场景，不代表磁盘 fsync）」
  it("单事务写入 2000 行成功（决策记录的 1 ms 不作断言：计时分辨率不足且机器相关）", () => {
    const { db } = freshDb();
    db.exec("CREATE TABLE bulk (v TEXT)");
    db.exec("BEGIN");
    const ins = db.prepare("INSERT INTO bulk (v) VALUES (?)");
    for (let i = 0; i < 2000; i++) ins.run("row-" + i);
    db.exec("COMMIT");
    expect(Number(get(db, "SELECT COUNT(*) AS c FROM bulk")["c"])).toBe(2000);
  });
});

describe("决策 §2.2：绑定参数上限 / 列数 / AsyncLocalStorage", () => {
  // §2.2 行「绑定参数上限：4096 行 / 8192 参数仍成功，上界未穷尽」
  it("单条语句绑定 8192 个参数仍成功（分片常量据此存在）", () => {
    const { db } = freshDb();
    db.exec("CREATE TABLE wide (a TEXT, b TEXT)");
    const rows = 4096; // 4096 行 × 2 列 = 8192 个绑定参数
    // 手工构造 VALUES (?, ?), (?, ?), ... 一次性提交，逼近实测边界
    const tuples: string[] = [];
    for (let i = 0; i < rows; i++) tuples.push("(?, ?)");
    const args: string[] = [];
    for (let i = 0; i < rows; i++) {
      args.push("a" + i);
      args.push("b" + i);
    }
    db.prepare("INSERT INTO wide (a, b) VALUES " + tuples.join(", ")).run(
      ...args,
    );
    expect(Number(get(db, "SELECT COUNT(*) AS c FROM wide")["c"])).toBe(rows);
  });

  // §2.2 行「单表列数 ≥ 1000 → 通过」
  it("单表 1000 列可建可写", () => {
    const { db } = freshDb();
    const cols = Array.from({ length: 1000 }, (_, i) => "c" + i + " TEXT");
    db.exec("CREATE TABLE thousand (" + cols.join(", ") + ")");
    db.prepare("INSERT INTO thousand (c0, c999) VALUES (?, ?)").run(
      "first",
      "last",
    );
    expect(String(get(db, "SELECT c999 FROM thousand")["c999"])).toBe("last");
    expect(String(get(db, "SELECT c0 FROM thousand")["c0"])).toBe("first");
  });

  // §2.2 行「AsyncLocalStorage 传递同一连接 → 跨 await / setTimeout / Promise.all 均同一连接」
  it("AsyncLocalStorage 跨 await / setTimeout / Promise.all 保持同一连接", async () => {
    const als = new AsyncLocalStorage<{ db: Db; tag: string }>();
    const { db } = freshDb();
    const seen: boolean[] = [];
    await als.run({ db, tag: "CONN-X" }, async () => {
      await Promise.all(
        Array.from({ length: 6 }, async () => {
          await null;
          await new Promise((r) => setTimeout(r, 1));
          const st = als.getStore();
          seen.push(st?.db === db && st?.tag === "CONN-X");
        }),
      );
    });
    expect(seen).toHaveLength(6);
    expect(seen.every(Boolean)).toBe(true);
  });
  // ⚠ 上面只证明【Node 原生调度】成立，【没有】验证 LangGraph 内部调度是否保持 ALS。
  //    规格 §6.3「Checkpoint 与 events 同事务」在框架调用路径上仍未证实 —— 那是 Task 0.4a。
});

describe("分片常量（决策 §4.2 的缓解措施）", () => {
  it("BATCH_ROWS 存在且为 1000，注释指向决策 §2.2", async () => {
    const mod = await import("../../src/db/driver.js");
    expect(mod.BATCH_ROWS).toBe(1000);
  });
});

describe("openDb 的边界与强制性（Task 0.3 变异测试补的洞）", () => {
  // 变异测试发现的缺口：曾把 openDb 的 :memory: 拒绝逻辑改成 if (false)，测试全绿 ——
  // 说明我们没有任何测试守着「OPC-OS 不落内存库」这条规格 §6.1 前提。
  it("openDb 拒绝 :memory:，并说明改判方向（规格 §6.1 要求单个可备份文件）", async () => {
    const { openDb } = await import("../../src/db/driver.js");
    for (const bad of [":memory:", "file::memory:"]) {
      expect(() => openDb(bad)).toThrow(/内存库|VACUUM INTO/);
    }
    expect(() => openDb("   ")).toThrow(TypeError);
  });

  // 实测事实：node:sqlite 裸构造默认开启外键（= 1），与 sqlite3 CLI 默认 OFF 相反。
  // 这条断言把「驱动默认值」钉住：若哪天默认变了，本测试先红，而不是等外键静默失效。
  it("外键在默认状态下就是开启且真的强制（node:sqlite 与 CLI 默认相反）", () => {
    const { db } = freshDb(); // 裸构造，不经 openDb
    expect(pragma(db, "foreign_keys")).toBe(1);
    db.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY)");
    db.exec("CREATE TABLE child (pid INTEGER REFERENCES parent(id))");
    expect(() =>
      db.prepare("INSERT INTO child (pid) VALUES (999)").run(),
    ).toThrow(/FOREIGN KEY/i);
  });

  // 反向：显式关闭后违约行能写进去 —— 证明上面那条拦截不是环境里有什么别的机制在挡
  it("显式关闭外键后违约行可写入（确认拦截确实来自外键开关）", () => {
    const path = join(TMP, "fk-off-" + process.pid + "-" + ++seq + ".db");
    const db = new DatabaseSync(path) as Db;
    opened.push(db);
    (db as unknown as { exec: (s: string) => void }).exec(
      "PRAGMA foreign_keys = OFF",
    );
    expect(pragma(db, "foreign_keys")).toBe(0);
    db.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY)");
    db.exec("CREATE TABLE child (pid INTEGER REFERENCES parent(id))");
    expect(() =>
      db.prepare("INSERT INTO child (pid) VALUES (999)").run(),
    ).not.toThrow();
  });
});

/*
 * 变异测试结论（2026-11-06）。判据：断言是否真有鉴别力；语法错误致红不算杀掉。
 *
 *   M1 删 PRAGMA journal_mode = WAL  -> 被杀（expected 'delete' to be 'wal'）
 *   M2 synchronous 改 FULL           -> 被杀（expected 2 to be 1）
 *   M4 busy_timeout 改 1000          -> 被杀
 *   M5 BATCH_ROWS 改 5000            -> 被杀
 *   M6 :memory: 拒绝改成 if(false)   -> 曾存活 => 真缺口 => 已补拒绝测试 => 复验被杀
 *   M7 空路径守卫改成 if(false)      -> 已补断言 => 被杀（expected error to be instance of TypeError）
 *   M3 删外键两处设置（任一层或全删）-> 存活，属【等价变异】而非缺口：
 *        node:sqlite 裸构造默认 foreign_keys = 1（实测），且 exec PRAGMA foreign_keys = ON
 *        会覆盖构造选项里的 false。外键因此有三层兜底，删掉任意一两层行为不变；
 *        上面两条外键测试已把【默认值本身】钉住，Node 若改默认会先在这里红。
 *   M8 enableForeignKeyConstraints:false -> 存活，同为等价变异（PRAGMA 兜底）；
 *        它反过来证明 driver.ts 里【故意重复设置】是对的。
 */
