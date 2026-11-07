/*
 * Checkpoint Saver 契约测试：同一套用例同时跑 MemorySaver 与 SqliteWALSaver，
 * 证明两者可互换（Task 0.4b 验收）。
 *
 * 用例的行为基线不是「我以为 LangGraph 要什么」，而是实测 MemorySaver 的实际行为
 * + 读官方 SqliteSaver 的 SQL。两条最反直觉、必须复现的语义：
 *   - 普通通道的 write 是【先写胜出】（INSERT OR IGNORE）
 *   - 特殊通道（ERROR / INTERRUPT / RESUME / SCHEDULED，idx 为负）是【后写覆盖】
 *     （INSERT OR REPLACE）
 * 这不是设计选择，是框架依赖的既有行为；自研实现不一致就会在重放时重建出不同的状态。
 */

import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type {
  BaseCheckpointSaver,
  Checkpoint,
  CheckpointMetadata,
} from "@langchain/langgraph-checkpoint";
import {
  ERROR,
  INTERRUPT,
  MemorySaver,
  RESUME,
  SCHEDULED,
} from "@langchain/langgraph-checkpoint";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteWALSaver } from "../../src/checkpoint/saver";
import { txScope } from "../../src/checkpoint/tx-scope";

const HUB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TMP = join(HUB, ".tmp", "saver-contract");

/*
 * 每个实现包一层「怎么执行一次调用」：SqliteWALSaver 的 put / putWrites 必须在
 * txScope() 内（0.4a 判定 + 0003 §6.2 的抛错约定），MemorySaver 无此要求。
 * 这套用例本身对两者是同一份 —— 差异只体现在这个包装器里。
 */
interface Harness {
  readonly label: string;
  readonly saver: BaseCheckpointSaver;
  /** 在一次事务作用域内执行（MemorySaver 直接透传）。 */
  run<T>(body: () => Promise<T>): Promise<T>;
  /** 只读：不进事务。 */
  read<T>(body: () => Promise<T>): Promise<T>;
  /** 仅 Sqlite 侧有值：用于另开连接做「外部观察者」断言。 */
  readonly dbPath?: string;
}

const opened: DatabaseSync[] = [];
/** 外部观察连接（独立于被测连接）。 */
const observers: DatabaseSync[] = [];
let seq = 0;

/** SqliteWALSaver 工厂的 label，唯一权威，避免字符串字面量散落两处各写各的。 */
const SQLSAVER_LABEL = "SqliteWALSaver";

/** Sqlite 专属用例条数；改动它必须同步下方元守卫，让它成为显式契约。 */
const SQLITE_EXCLUSIVE_CASES = 6;
let exclusiveRuns = 0;

type Factory = () => Promise<Harness>;

const factories: Array<[string, Factory]> = [
  [
    "MemorySaver",
    async () => {
      const saver = new MemorySaver();
      const pass = async <T>(body: () => Promise<T>): Promise<T> => body();
      return { label: "MemorySaver", saver, run: pass, read: pass };
    },
  ],
  [
    "SqliteWALSaver",
    async () => {
      mkdirSync(TMP, { recursive: true });
      const path = join(TMP, "db-" + ++seq + "-" + process.pid + ".db");
      const db = new DatabaseSync(path);
      opened.push(db);
      const saver = new SqliteWALSaver(db);
      return {
        label: SQLSAVER_LABEL,
        saver,
        dbPath: path,
        run: <T>(body: () => Promise<T>): Promise<T> => txScope(db, body),
        read: <T>(body: () => Promise<T>): Promise<T> => body(),
      };
    },
  ],
];

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
  for (const db of observers) {
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});

const ck = (id: string, tsOffset = 0): Checkpoint => ({
  v: 4,
  id,
  ts: new Date(1700000000000 + tsOffset).toISOString(),
  channel_values: { doc: "value-" + id },
  channel_versions: { doc: 1 },
  versions_seen: {},
});

const meta = (step: number): CheckpointMetadata => ({
  source: step < 0 ? "input" : "loop",
  step,
  parents: {},
});

const cfg = (
  threadId: string,
  extra: Record<string, unknown> = {},
): { configurable: Record<string, unknown> } => ({
  configurable: { thread_id: threadId, checkpoint_ns: "", ...extra },
});

for (const [label, make] of factories) {
  describe(label, () => {
    // —— put / getTuple ——
    it("put 后 getTuple 返回同一 checkpoint_id，parentConfig 链正确", async () => {
      const h = await make();
      const t = "chain-" + label;

      await h.run(async () => {
        await h.saver.put(cfg(t), ck("c1"), meta(0), {});
        await h.saver.put(
          cfg(t, { checkpoint_id: "c1" }),
          ck("c2", 1000),
          meta(1),
          {},
        );
      });

      const got = await h.read(async () =>
        h.saver.getTuple(cfg(t, { checkpoint_id: "c1" })),
      );
      expect(got?.checkpoint.id).toBe("c1");
      expect(got?.parentConfig).toBeUndefined();

      const child = await h.read(async () =>
        h.saver.getTuple(cfg(t, { checkpoint_id: "c2" })),
      );
      expect(child?.checkpoint.id).toBe("c2");
      expect(child?.parentConfig?.configurable?.checkpoint_id).toBe("c1");
      expect(child?.metadata?.step).toBe(1);
    });

    it("getTuple 不带 checkpoint_id 时返回最新一条", async () => {
      const h = await make();
      const t = "latest-" + label;
      await h.run(async () => {
        await h.saver.put(cfg(t), ck("a1"), meta(0), {});
        await h.saver.put(cfg(t), ck("a2"), meta(1), {});
        await h.saver.put(cfg(t), ck("a3"), meta(2), {});
      });
      const latest = await h.read(async () => h.saver.getTuple(cfg(t)));
      expect(latest?.checkpoint.id).toBe("a3");
    });

    it("getTuple 对不存在的 checkpoint / thread 返回 undefined（不是抛错）", async () => {
      const h = await make();
      expect(
        await h.read(() =>
          h.saver.getTuple(cfg("ghost", { checkpoint_id: "x" })),
        ),
      ).toBeUndefined();
    });

    it("put 返回带 checkpoint_id 的 config", async () => {
      const h = await make();
      const t = "ret-" + label;
      const returned = await h.run(async () =>
        h.saver.put(cfg(t), ck("r1"), meta(0), {}),
      );
      expect(returned.configurable?.thread_id).toBe(t);
      expect(returned.configurable?.checkpoint_id).toBe("r1");
    });

    // —— list ——
    it("list 按 checkpoint_id 倒序，支持 before 与 limit", async () => {
      const h = await make();
      const t = "list-" + label;
      await h.run(async () => {
        for (const id of ["b1", "b2", "b3", "b4"]) {
          await h.saver.put(cfg(t), ck(id), meta(0), {});
        }
      });

      const all = await h.read(async () => {
        const ids: string[] = [];
        for await (const tup of h.saver.list(cfg(t)))
          ids.push(tup.checkpoint.id);
        return ids;
      });
      expect(all).toEqual(["b4", "b3", "b2", "b1"]);

      const before = await h.read(async () => {
        const ids: string[] = [];
        for await (const tup of h.saver.list(cfg(t), {
          before: cfg(t, { checkpoint_id: "b3" }),
        })) {
          ids.push(tup.checkpoint.id);
        }
        return ids;
      });
      expect(before).toEqual(["b2", "b1"]);

      const limited = await h.read(async () => {
        const ids: string[] = [];
        for await (const tup of h.saver.list(cfg(t), { limit: 2 })) {
          ids.push(tup.checkpoint.id);
        }
        return ids;
      });
      expect(limited).toEqual(["b4", "b3"]);
    });

    // —— putWrites 去重 ——
    it("putWrites 以 (thread, ns, ckpt, task, idx) 为键去重：普通通道【先写胜出】", async () => {
      const h = await make();
      const t = "dedup-" + label;
      await h.run(async () => {
        await h.saver.put(cfg(t), ck("w1"), meta(0), {});
        const c = cfg(t, { checkpoint_id: "w1" });
        await h.saver.putWrites(c, [["doc", "first"]], "taskA");
        // 同 task、同 idx、不同值：官方是 INSERT OR IGNORE，第二条必须被丢掉
        await h.saver.putWrites(c, [["doc", "second"]], "taskA");
      });
      const tup = await h.read(async () =>
        h.saver.getTuple(cfg(t, { checkpoint_id: "w1" })),
      );
      const docWrites = (tup?.pendingWrites ?? []).filter(
        (w) => w[1] === "doc",
      );
      expect(docWrites.length).toBe(1);
      expect(docWrites[0]?.[2]).toBe("first");
    });

    it("空串存储键必须拒绝（checkpoint_ns 例外），与 MemorySaver 一致", async () => {
      const h = await make();
      // 只断言「拒绝」与「是哪个键」，不断言错误措辞 —— 两家实现措辞本就不同。
      await expect(
        h.run(() =>
          h.saver.put(
            { configurable: { thread_id: "", checkpoint_ns: "" } },
            ck("k1"),
            meta(0),
            {},
          ),
        ),
      ).rejects.toThrow(/thread_id/);
      await expect(
        h.run(() =>
          h.saver.put(
            cfg("empty-ckpt"),
            { ...ck(""), ts: new Date().toISOString() },
            meta(0),
            {},
          ),
        ),
      ).rejects.toThrow(/checkpoint_id/);
      await h.run(async () => {
        await h.saver.put(cfg("empty-task"), ck("k2"), meta(0), {});
        await expect(
          h.saver.putWrites(
            cfg("empty-task", { checkpoint_id: "k2" }),
            [["c", 1]],
            "",
          ),
        ).rejects.toThrow(/task_id/);
      });
      // checkpoint_ns 空串是合法的（默认命名空间就是 ""），不得误拒
      await h.run(() =>
        h.saver.put(
          { configurable: { thread_id: "ns-empty", checkpoint_ns: "" } },
          ck("k3"),
          meta(0),
          {},
        ),
      );
      const tup = await h.read(() =>
        h.saver.getTuple(cfg("ns-empty", { checkpoint_id: "k3" })),
      );
      expect(tup?.checkpoint.id).toBe("k3");
    });

    it("特殊通道（ERROR 等）是【后写覆盖】，与普通通道相反", async () => {
      const h = await make();
      const t = "special-" + label;
      await h.run(async () => {
        await h.saver.put(cfg(t), ck("s1"), meta(0), {});
        const c = cfg(t, { checkpoint_id: "s1" });
        await h.saver.putWrites(c, [[ERROR, "err-1"]], "taskB");
        await h.saver.putWrites(c, [[ERROR, "err-2"]], "taskB");
        await h.saver.putWrites(c, [[INTERRUPT, "i1"]], "taskC");
        await h.saver.putWrites(c, [[RESUME, "r1"]], "taskC");
        await h.saver.putWrites(c, [[SCHEDULED, "s1"]], "taskC");
      });
      const tup = await h.read(async () =>
        h.saver.getTuple(cfg(t, { checkpoint_id: "s1" })),
      );
      const by = (ch: string) =>
        (tup?.pendingWrites ?? []).filter((w) => w[1] === ch).map((w) => w[2]);
      // 后写覆盖 —— 这是框架的既有语义，自研不一致就会在重放时重建出不同的状态
      expect(by(String(ERROR))).toEqual(["err-2"]);
      expect(by(String(INTERRUPT))).toEqual(["i1"]);
      expect(by(String(RESUME))).toEqual(["r1"]);
      expect(by(String(SCHEDULED))).toEqual(["s1"]);
    });

    it("不同 taskId 即使 idx 相同也互不吞掉", async () => {
      const h = await make();
      const t = "cross-" + label;
      await h.run(async () => {
        await h.saver.put(cfg(t), ck("k1"), meta(0), {});
        const c = cfg(t, { checkpoint_id: "k1" });
        await h.saver.putWrites(c, [["x", 1]], "taskD");
        await h.saver.putWrites(c, [["y", 2]], "taskE");
      });
      const tup = await h.read(async () =>
        h.saver.getTuple(cfg(t, { checkpoint_id: "k1" })),
      );
      const chans = (tup?.pendingWrites ?? []).map((w) => w[1]).sort();
      expect(chans).toEqual(["x", "y"]);
    });

    // —— V17：pendingWrites 必须按 writesSortKey(task_path, task_id, idx) 排 ——
    it("pendingWrites 按 (task_path, task_id, idx) 排序，且与 MemorySaver 输出一致", async () => {
      const h = await make();
      const t = "sort-" + label;
      // 刻意构造「按 task_id 的主键扫描序」与「按 (task_path, task_id) 的框架序」相反的数据：
      // 若实现只靠 SQL 索引的自然序、不做内存排序，拿到的就是主键序 chZ,chA,chB，必然出错。
      await h.run(async () => {
        await h.saver.put(cfg(t), ck("o1"), meta(0), {});
        const c = cfg(t, { checkpoint_id: "o1" });
        await h.saver.putWrites(c, [["chZ", "z"]], "task-z", "p/0");
        await h.saver.putWrites(c, [["chA", "a"]], "task-a", "p/1");
        await h.saver.putWrites(c, [["chB", "b"]], "task-b", "p/1");
      });
      const tup = await h.read(async () =>
        h.saver.getTuple(cfg(t, { checkpoint_id: "o1" })),
      );
      const order = (tup?.pendingWrites ?? []).map((w) => w[1]);
      // task_path 是第一优先级：p/0 先于 p/1，所以 task-z 必须排在 task-a / task-b 之前 ——
      // 这与 task_id 字典序（task-a < task-b < task-z）恰好相反
      expect(order).toEqual(["chZ", "chA", "chB"]);
    });

    it("task_path 按 Unicode 码点排序，不是 UTF-16 码元序", async () => {
      const h = await make();
      const t = "codepoint-" + label;
      await h.run(async () => {
        await h.saver.put(cfg(t), ck("cp1"), meta(0), {});
        const c = cfg(t, { checkpoint_id: "cp1" });
        // \u{10000} 是 astral（码点 65536，UTF-16 首代理元 55296）；\ue000 是 BMP（码点 57344）。
        // 码点序：\ue000 < \u{10000}；码元序恰好相反 —— 直接比 < 或 localeCompare 就会翻。
        await h.saver.putWrites(c, [["astral", 1]], "task-a", "p/\u{10000}");
        await h.saver.putWrites(c, [["bmp", 2]], "task-b", "p/\ue000");
      });
      const tup = await h.read(async () =>
        h.saver.getTuple(cfg(t, { checkpoint_id: "cp1" })),
      );
      const order = (tup?.pendingWrites ?? []).map((w) => w[1]);
      expect(order).toEqual(["bmp", "astral"]);
    });

    it("deleteThread 后 getTuple 返回 undefined、list 空", async () => {
      const h = await make();
      const t = "del-" + label;
      await h.run(async () => {
        await h.saver.put(cfg(t), ck("d1"), meta(0), {});
        const c = cfg(t, { checkpoint_id: "d1" });
        await h.saver.putWrites(c, [["doc", "v"]], "taskA");
      });
      await h.read(async () => h.saver.deleteThread(t));
      expect(
        await h.read(() => h.saver.getTuple(cfg(t, { checkpoint_id: "d1" }))),
      ).toBeUndefined();
      const rest = await h.read(async () => {
        const ids: string[] = [];
        for await (const tup of h.saver.list(cfg(t)))
          ids.push(tup.checkpoint.id);
        return ids;
      });
      expect(rest).toEqual([]);
    });

    it("缺 thread_id / checkpoint_id 时 putWrites 抛错", async () => {
      const h = await make();
      await expect(
        h.run(() =>
          h.saver.putWrites(
            { configurable: { checkpoint_id: "x" } },
            [["a", 1]],
            "taskA",
          ),
        ),
      ).rejects.toThrow(/thread_id/);
      await expect(
        h.run(() =>
          h.saver.putWrites(
            { configurable: { thread_id: "t" } },
            [["a", 1]],
            "taskA",
          ),
        ),
      ).rejects.toThrow(/checkpoint_id/);
    });

    // —— 以下是在 Sqlite 变体里跑的专属用例组 ——
    // 这组原先整块标着【仅对 SqliteWALSaver 成立】，实测只对 5 条成立：取消 skip 让
    // MemorySaver 也跑一遍（0007 §6.1 的 V4 实验）—— 5 条失败、1 条通过。通过的那条是
    // 【中文与嵌套对象在 channel_values 里完整往返】，它验的是我们的序列化往返，不靠
    // Sqlite 特有机制。留在本组是有意为之，不是漏网：把它改成常态双实现断言等于锁定
    // LangGraph 自带的 MemorySaver 行为，属扩大锁定面，要单独决定（同一结论见 0007 §6.1）。
    // 包一层而不是直接用三元：变异测试（B2）实测，一旦这个判定被写坏（标签改名、
    // 重构改条件），下面所有专属保护会静默变成 it.skip，整套测试仍然全绿 ——
    // 绿灯不等于保护生效。计数让「真的跑了」变成可断言的事实，见文件末尾元守卫；
    // 常量与真实调用数漂移（6 改成 7）实测会红在元守卫上，所以这个数不是装饰。
    const itSqlite = (title: string, fn: () => Promise<void>): void => {
      if (label === SQLSAVER_LABEL) {
        it(title, async () => {
          exclusiveRuns += 1;
          await fn();
        });
      } else {
        it.skip(title, fn);
      }
    };

    itSqlite(
      "同事务原子性：put 成功、putWrites 抛错 → 两者都不可见",
      async () => {
        const h = await make();
        const t = "atomic-" + label;
        let threw: string | null = null;
        try {
          await h.run(async () => {
            await h.saver.put(cfg(t), ck("x1"), meta(0), {});
            const c = cfg(t, { checkpoint_id: "x1" });
            await h.saver.putWrites(c, [["doc", "v"]], "taskA");
            // 制造失败：__proto__ 是被禁的存储键，putWrites 应抛错
            await h.saver.putWrites(c, [["doc", "bad"]], "__proto__");
          });
        } catch (e) {
          threw = e instanceof Error ? e.message : String(e);
        }
        // 分两步：防护失效时不会抛错，threw 为 null —— 必须由 not.toBeNull() 这条【断言】
        // 抓到，而不是让 toMatch 抛运行时 TypeError 冒充「测试失败了」
        expect(threw).not.toBeNull();
        expect(String(threw)).toMatch(/__proto__/);
        // 关键：checkpoint 也不能留下（0.4a 断言 3 的回归）
        expect(
          await h.read(() => h.saver.getTuple(cfg(t, { checkpoint_id: "x1" }))),
        ).toBeUndefined();
      },
    );

    itSqlite(
      "外层事务持写锁期间，另一条连接写入被数据库拒绝（重放 decisions/0003 §3.1）",
      async () => {
        const h = await make();
        if (!h.dbPath)
          throw new Error("工厂必须暴露 dbPath，否则本用例无从观察");
        const t = "busy-" + label;
        // observer 显式设 busy_timeout=0。实测 node:sqlite 的默认值恰好就是 0
        // （PRAGMA busy_timeout → { timeout: 0 }），所以这行【不是】防止「等待代替报错」——
        // 而是把前提钉死在测试里，不依赖上游默认值（driver.ts 给生产连接设的是另一个值）。
        const observer = new DatabaseSync(h.dbPath);
        observers.push(observer);
        observer.exec("PRAGMA busy_timeout=0");

        let errcode: number | undefined;
        let message = "";
        await h.run(async () => {
          // 观察点必须在【事务内任何写入之前】。BEGIN IMMEDIATE 一进入就持写锁，而
          // BEGIN DEFERRED 要到第一条写语句才升级 —— 等到 put 之后再观察，两者都已持锁，
          // 测试就分不出这两种事务（变异 E2 用 DEFERRED 替换时实测正是这样存活的）。
          try {
            observer
              .prepare(
                "INSERT INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, type, checkpoint, metadata) VALUES (?,?,?,NULL,X'00',NULL)",
              )
              .run("rogue", "", "ghost");
          } catch (e) {
            const err = e as { errcode?: number; message?: string };
            errcode = err.errcode;
            message = String(err.message ?? "");
          }
          // 断言留在事务内：失败时整个用例回滚，不留半成品
          expect(
            errcode,
            "外层事务必须已持写锁；message 供排查：" + message,
          ).toBe(5);
          expect(message).toMatch(/locked|busy/i);

          await h.saver.put(cfg(t), ck("bu1"), meta(0), {});
        });

        // 那次越界写入确实没落库（不是「写成了又被覆盖」）
        const ghost = observer
          .prepare(
            "SELECT count(*) AS c FROM checkpoints WHERE checkpoint_id = 'ghost'",
          )
          .get() as { c: number };
        expect(Number(ghost.c)).toBe(0);

        // 被测线程正常提交后可见 —— 证明外层事务没被这次冲突搞坏
        expect(
          await h.read(() =>
            h.saver.getTuple(cfg(t, { checkpoint_id: "bu1" })),
          ),
        ).toBeDefined();
      },
    );

    itSqlite(
      "事务作用域内 deleteThread：外层回滚则删除也回滚（复用外层事务，不自开）",
      async () => {
        const h = await make();
        const t = "del-atomic-" + label;
        await h.run(async () => {
          await h.saver.put(cfg(t), ck("da1"), meta(0), {});
          await h.saver.putWrites(
            cfg(t, { checkpoint_id: "da1" }),
            [["doc", "v"]],
            "taskA",
          );
        });
        // 前置：确实存在 —— 否则后面的断言只是「本来就没有」
        expect(
          await h.read(() =>
            h.saver.getTuple(cfg(t, { checkpoint_id: "da1" })),
          ),
        ).toBeDefined();

        // 在事务作用域内删除，然后强行让外层事务回滚
        let threw: string | null = null;
        try {
          await h.run(async () => {
            await h.saver.deleteThread(t);
            throw new Error("故意回滚");
          });
        } catch (e) {
          threw = e instanceof Error ? e.message : String(e);
        }
        expect(threw).toBe("故意回滚");

        // 删除必须随外层事务一起被回滚。若 deleteThread 自开短事务并已提交，
        // 这里就读到 undefined —— 数据被不可逆地删掉，且与同事务的其它写不一致。
        const after = await h.read(() =>
          h.saver.getTuple(cfg(t, { checkpoint_id: "da1" })),
        );
        expect(after?.checkpoint.id).toBe("da1");

        // 收尾：作用域外删除应真正生效 —— 否则本用例只是断言「没删成」，
        // 一个从不生效的 deleteThread 也能让上面的断言全绿。
        await h.read(async () => h.saver.deleteThread(t));
        expect(
          await h.read(() =>
            h.saver.getTuple(cfg(t, { checkpoint_id: "da1" })),
          ),
        ).toBeUndefined();
      },
    );

    itSqlite(
      "事务外调用 put / putWrites 直接抛错（不得静默自提）",
      async () => {
        const h = await make();
        await expect(
          h.saver.put(cfg("naked"), ck("n1"), meta(0), {}),
        ).rejects.toThrow(/txScope/);
        await expect(
          h.saver.putWrites(
            cfg("naked", { checkpoint_id: "n1" }),
            [["doc", "v"]],
            "taskA",
          ),
        ).rejects.toThrow(/txScope/);
        // 且确实没写进去
        expect(
          await h.read(() =>
            h.saver.getTuple(cfg("naked", { checkpoint_id: "n1" })),
          ),
        ).toBeUndefined();
      },
    );

    itSqlite(
      "type 列真被使用：顶层 Uint8Array 存成 bytes，取回仍是 Uint8Array",
      async () => {
        const h = await make();
        const t = "blob-" + label;
        const bytes = new Uint8Array([0, 1, 250, 255]);
        await h.run(async () => {
          await h.saver.put(cfg(t), ck("bl1"), meta(0), {});
          await h.saver.putWrites(
            cfg(t, { checkpoint_id: "bl1" }),
            [["blob", bytes]],
            "taskA",
          );
        });
        const tup = await h.read(async () =>
          h.saver.getTuple(cfg(t, { checkpoint_id: "bl1" })),
        );
        const w = (tup?.pendingWrites ?? []).find((x) => x[1] === "blob");
        expect(w?.[2]).toBeInstanceOf(Uint8Array);
        expect(Array.from(w?.[2] as Uint8Array)).toEqual([0, 1, 250, 255]);
      },
    );

    itSqlite("中文与嵌套对象在 channel_values 里完整往返", async () => {
      const h = await make();
      const t = "cn-" + label;
      const payload = ck("cn1");
      payload.channel_values = {
        doc: "覆盖率测试",
        nested: { arr: [1, 2, "三"], ok: true },
      };
      await h.run(async () => {
        await h.saver.put(cfg(t), payload, meta(0), {});
      });
      const tup = await h.read(async () =>
        h.saver.getTuple(cfg(t, { checkpoint_id: "cn1" })),
      );
      expect(tup?.checkpoint.channel_values?.doc).toBe("覆盖率测试");
      expect(tup?.checkpoint.channel_values?.nested).toEqual({
        arr: [1, 2, "三"],
        ok: true,
      });
    });
  });
}

/*
 * 元守卫。B2 变异实测：把 itSqlite 的判定改成恒假后，Sqlite 专属保护全部静默变成
 * it.skip，测试报告依然全绿 —— 那种绿灯是假的。这条把「保护确实执行了」变成断言。
 *
 * 为什么是 afterAll 而不是顶层 it：原先它是最后一个顶层 it，靠的是「vitest 按注册序
 * 执行」这个假设 —— 注释不是机制，它没能挡住 --sequence.shuffle。实测（本轮）打开
 * shuffle 后 seed=11 与 seed=202 都会把这条 it 排到六个 Sqlite 专属用例之前，于是计数
 * 还是 0，报出一条与产品无关的红；seed=987 则恰好不红。一条【有时红有时绿、且红得很
 * 误导人】的守卫比没守卫更糟。afterAll 绑定的是文件而不是注册位置，与 it 的排列无关。
 *
 * 形态变化，看见时不要误解：afterAll 里的断言失败被记作 Failed Suites，不是 Failed
 * Tests —— 报告里 Tests 那行会显示全 passed，只有 exit code 是 1、并有 FAIL 行。所以
 * 判绿必须看 exit code，不能只 grep Tests 那行（本轮实测：ok 夹具 exit=0，坏夹具 exit=1
 * 而两者 Tests 行都是 passed）。
 */
afterAll(() => {
  expect(exclusiveRuns, "Sqlite 专属用例的执行条数").toBe(
    SQLITE_EXCLUSIVE_CASES,
  );
});
