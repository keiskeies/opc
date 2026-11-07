import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import type { DomainEvent, EventBus } from "../../src/events/bus.js";
import { AuditRecorder, type StepTx } from "../../src/events/recorder.js";
import {
  auditedInvoke,
  detectInterrupts,
} from "../../src/graph/audit-middleware.js";

const dirs: string[] = [];
// Windows 下 SQLite 连接不 close 就删目录会 EPERM，且 maxRetries 对它无效：
// 目录被文件句柄锁着，重试一万次也删不掉。必须先关连接。
const dbs: DatabaseSync[] = [];
afterAll(() => {
  for (const d of dbs) d.close();
  for (const d of dirs)
    rmSync(d, { recursive: true, maxRetries: 40, retryDelay: 50 });
});

const EVENTS_DDL = [
  "CREATE TABLE events (",
  "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  task_id TEXT,",
  "  actor_type TEXT NOT NULL,",
  "  actor_id TEXT NOT NULL,",
  "  action TEXT NOT NULL,",
  "  target TEXT,",
  "  payload TEXT NOT NULL,",
  "  state_snapshot TEXT,",
  "  created_at INTEGER NOT NULL",
  ")",
].join("\n");

function openDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "opc-graph-"));
  dirs.push(dir);
  const db = new DatabaseSync(join(dir, "g.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(EVENTS_DDL);
  dbs.push(db);
  return db;
}

const rowsIn = (db: DatabaseSync) =>
  db
    .prepare(
      "SELECT id, task_id, actor_type, actor_id, action, target, payload FROM events ORDER BY id",
    )
    .all() as Record<string, unknown>[];

class FakeBus implements EventBus {
  readonly published: { event: DomainEvent; seq: number }[] = [];
  publishPersisted(e: DomainEvent, seq: number): void {
    this.published.push({ event: e, seq });
  }
  latestSeq(): number {
    return this.published.length;
  }
  subscribe(): never {
    throw new Error("interrupt 测试不该订阅总线");
  }
}

class FakeTx implements StepTx {
  readonly als = new AsyncLocalStorage<{ db: DatabaseSync }>();
  #open = false;
  readonly calls: string[] = [];
  constructor(readonly conn: DatabaseSync) {}
  async begin(): Promise<void> {
    this.conn.exec("BEGIN IMMEDIATE");
    this.calls.push("begin");
    this.#open = true;
  }
  async commit(): Promise<void> {
    this.conn.exec("COMMIT");
    this.calls.push("commit");
    this.#open = false;
  }
  async rollback(): Promise<void> {
    try {
      this.conn.exec("ROLLBACK");
    } catch {
      /* 事务可能已被 SQLite 自己中止 */
    }
    this.calls.push("rollback");
    this.#open = false;
  }
  scope<T>(fn: () => Promise<T>): Promise<T> {
    return this.als.run({ db: this.conn }, fn);
  }
  inTx(): boolean {
    return this.#open;
  }
  db(): DatabaseSync {
    const s = this.als.getStore();
    if (!s) throw new Error("SCOPE-MISS");
    return s.db;
  }
}

/** 最近一次 make() 造出的 FakeTx.calls，用于断言事务往返次数。 */
let LAST_TX_CALLS: string[] = [];

function make() {
  const db = openDb();
  const tx = new FakeTx(db);
  const bus = new FakeBus();
  const rec = new AuditRecorder({ tx, bus, now: () => 1700000000000 });
  LAST_TX_CALLS = tx.calls;
  return { db, tx, bus, rec };
}

/** 探针实测的形状（LangGraph JS 1.7.1）：数组，元素只有 id 与 value 两个键。 */
const INTERRUPTED = {
  out: "x",
  __interrupt__: [
    { id: "71f40f2363f22cad8ee77c462e0ef2fe", value: { reason: "请批准" } },
  ],
};

describe("detectInterrupts：按 V2 检查返回值，而不是 catch 异常", () => {
  it("识别 __interrupt__ 数组，取出 id 与 value", () => {
    expect(detectInterrupts(INTERRUPTED)).toEqual([
      { id: "71f40f2363f22cad8ee77c462e0ef2fe", value: { reason: "请批准" } },
    ]);
  });

  it("普通返回值 / undefined / null 都没有中断", () => {
    expect(detectInterrupts({ out: "done" })).toEqual([]);
    expect(detectInterrupts(undefined)).toEqual([]);
    expect(detectInterrupts(null)).toEqual([]);
  });

  it("__interrupt__ 为空数组 → 没有中断（LangGraph 会给空数组）", () => {
    expect(detectInterrupts({ __interrupt__: [] })).toEqual([]);
  });

  it("多条中断全部返回，顺序保持", () => {
    const r = {
      __interrupt__: [
        { id: "a1", value: 1 },
        { id: "b2", value: 2 },
      ],
    };
    expect(detectInterrupts(r)).toEqual([
      { id: "a1", value: 1 },
      { id: "b2", value: 2 },
    ]);
  });

  it("id 是纯空白同样抛错：看起来有值，实则既不能审计也不能 resume", () => {
    for (const bad of ["", "   ", "\t"]) {
      expect(() =>
        detectInterrupts({ __interrupt__: [{ id: bad, value: 1 }] }),
      ).toThrow(/id/);
    }
  });

  it("缺 id 的中断必须抛错：没有 id 既不能审计也不能 resume", () => {
    expect(() =>
      detectInterrupts({ __interrupt__: [{ value: { reason: "x" } }] }),
    ).toThrow(/id/);
  });

  it("数组元素不是对象 → 抛错：null/字符串都不是合法中断", () => {
    for (const bad of [null, "oops", 42, undefined]) {
      expect(() => detectInterrupts({ __interrupt__: [bad] })).toThrow(
        /不是对象/,
      );
    }
  });

  it("__interrupt__ 显式为 null/undefined → 视为没有中断（LangGraph 不该给，但抛错更糟：正常任务被卡住）", () => {
    expect(detectInterrupts({ __interrupt__: null })).toEqual([]);
    expect(detectInterrupts({ __interrupt__: undefined })).toEqual([]);
  });

  it("__interrupt__ 不是数组 → 抛错而不是静默忽略（形状变了要立刻知道）", () => {
    expect(() => detectInterrupts({ __interrupt__: "oops" })).toThrow(/数组/);
  });
});

describe("auditedInvoke：中断落审计，普通异常原样冒泡", () => {
  it("返回值带 __interrupt__ → 记一条 ApprovalRequired", async () => {
    const { db, rec, bus, tx } = make();
    const out = await auditedInvoke({
      invoke: async () => INTERRUPTED,
      recorder: rec,
      taskId: "T-1",
    });
    expect(out).toBe(INTERRUPTED); // 包装不改变返回值语义
    const r = rowsIn(db);
    expect(r.length).toBe(1);
    expect(r[0]?.action).toBe("approval"); // §22.1 的 action 枚举
    expect(r[0]?.actor_type).toBe("system");
    expect(r[0]?.actor_id).toBe("hub");
    expect(r[0]?.target).toBe("71f40f2363f22cad8ee77c462e0ef2fe"); // interruptId 当 target
    expect(r[0]?.task_id).toBe("T-1");
    const payload = JSON.parse(String(r[0]?.payload));
    expect(payload.kind).toBe("ApprovalRequired");
    expect(payload.payload).toEqual({ reason: "请批准" }); // 中断的 value 必须留档
    expect(bus.published.map((p) => p.seq)).toEqual([1]); // seq = events.id
    expect(tx.calls).toEqual(["begin", "commit"]);
  });

  it("普通返回值 → 一条都不写（不许造空事件）", async () => {
    const { db, rec, bus } = make();
    const out = await auditedInvoke({
      invoke: async () => ({ out: "done" }),
      recorder: rec,
      taskId: "T-2",
    });
    expect(out).toEqual({ out: "done" });
    expect(rowsIn(db).length).toBe(0);
    expect(bus.published.length).toBe(0);
    // 不许为「没有中断」也开一层 begin/commit：正常任务白跑一次 WAL 往返，
    // 并行超步下还会把事务日志塞满空事务噪音。
    expect(LAST_TX_CALLS).toEqual([]);
  });

  it("invoke 抛【普通异常】必须原样冒泡：中断走返回值不走 catch（V2）", async () => {
    const { db, rec } = make();
    const boom = new Error("节点里真的炸了");
    await expect(
      auditedInvoke({
        invoke: async () => {
          throw boom;
        },
        recorder: rec,
        taskId: "T-3",
      }),
    ).rejects.toBe(boom); // 同一个错误对象，不许吞、不许重新包装
    expect(rowsIn(db).length).toBe(0);
  });

  it("两条中断 → 两条 ApprovalRequired，各自带自己的 id", async () => {
    const { db, rec, bus } = make();
    await auditedInvoke({
      invoke: async () => ({
        __interrupt__: [
          { id: "a1", value: { gate: "qa" } },
          { id: "b2", value: { gate: "ceo" } },
        ],
      }),
      recorder: rec,
      taskId: "T-4",
    });
    const r = rowsIn(db);
    expect(r.length).toBe(2);
    expect(r.map((x) => x.target)).toEqual(["a1", "b2"]);
    expect(bus.published.map((p) => p.seq)).toEqual([1, 2]);
  });
});
