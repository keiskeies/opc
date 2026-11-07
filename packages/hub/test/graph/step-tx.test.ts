import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Checkpoint,
  CheckpointMetadata,
  PendingWrite,
} from "@langchain/langgraph-checkpoint";
import { afterAll, describe, expect, it } from "vitest";
import { SqliteWALSaver } from "../../src/checkpoint/saver.js";
import { CHECKPOINT_TABLES } from "../../src/checkpoint/schema.js";
import type { DomainEvent, EventBus } from "../../src/events/bus.js";
import {
  auditedInvoke,
  SuperStepAuditor,
} from "../../src/graph/audit-middleware.js";

const dirs: string[] = [];
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
  const dir = mkdtempSync(join(tmpdir(), "opc-step-"));
  dirs.push(dir);
  const db = new DatabaseSync(join(dir, "s.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(EVENTS_DDL);
  for (const ddl of CHECKPOINT_TABLES) db.exec(ddl);
  dbs.push(db);
  return db;
}

class FakeBus implements EventBus {
  readonly published: { event: DomainEvent; seq: number }[] = [];
  publishPersisted(e: DomainEvent, seq: number): void {
    this.published.push({ event: e, seq });
  }
  latestSeq(): number {
    return this.published.length;
  }
  subscribe(): never {
    throw new Error("不该订阅");
  }
}

/** 第二个连接读【已提交】的行：写连接永远看得见自己的未提交写入，据此断言毫无鉴别力。 */
function readCommitted(index: number, sql: string): Record<string, unknown>[] {
  const file = join(dirs[index] ?? "", "s.db");
  const other = new DatabaseSync(file, { readOnly: true });
  try {
    return other.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    other.close();
  }
}

const ck = (id: string, parentId: string | null): Checkpoint =>
  ({
    v: 1,
    id,
    ts: "2026-11-07T00:00:00.000Z",
    root_id: id,
    parent_checkpoint_id: parentId,
    channel_values: { n: id },
    channel_versions: { n: id },
    versions_seen: {},
    pending_sends: [],
  }) as unknown as Checkpoint;

const META = {
  step: 0,
  source: "loop",
  writes: null,
} as unknown as CheckpointMetadata;
const cfg = (checkpointId?: string) => ({
  configurable: {
    thread_id: "T-STEP",
    checkpoint_ns: "",
    ...(checkpointId ? { checkpoint_id: checkpointId } : {}),
  },
});

function make() {
  const db = openDb();
  const bus = new FakeBus();
  const auditor = new SuperStepAuditor({ db, bus, now: () => 1700000000000 });
  const saver = auditor.instrumentSaver(new SqliteWALSaver(db));
  const index = dirs.length - 1;
  const events = () =>
    readCommitted(index, "SELECT id, action, target FROM events ORDER BY id");
  const cps = () =>
    readCommitted(
      index,
      "SELECT checkpoint_id FROM checkpoints ORDER BY checkpoint_id",
    );
  return { db, bus, auditor, saver, events, cps };
}

/*
 * 调用序列取自 docs/decisions/0005-event-bus-and-audit.md §1 的实测结论（LangGraph JS 1.7.1）：
 *   put(超步) → 该超步所有节点执行 → putWrites → put(下一超步) → …
 * 平行扇出时同一超步的多个节点共享一次 put（3 节点 4 次 put）。
 */
describe("SuperStepAuditor：Saver.put 就是超步边界", () => {
  it("put 切事务 + events 同事务提交；提交前另一个连接什么都看不见（§6.3）", async () => {
    const { auditor, saver, events, cps, bus } = make();
    await auditor.invoke(async () => {
      await saver.put(cfg("cp1"), ck("cp1", null), META, {});
      await auditor.recorder.record({
        kind: "TaskStateChanged",
        taskId: "T-STEP",
        from: "start",
        to: "dev",
      });
      await saver.putWrites(
        cfg("cp1"),
        [["messages", "hello"]] as PendingWrite[],
        "task1",
      );
      // 提交前：两个连接都看不到（events 与 checkpoint 必须一起可见或一起不可见）
      expect(events().length).toBe(0);
      expect(cps().length).toBe(0);
      expect(bus.published.length).toBe(0);

      await saver.put(cfg("cp2"), ck("cp2", "cp1"), META, {}); // 提交 cp1 + ev1，开第二个事务
      expect(events().map((r) => r.action)).toEqual(["state_change"]);
      expect(cps().length).toBe(1); // cp1 已提交，cp2 还在事务里
      expect(bus.published.map((p) => p.seq)).toEqual([1]); // 广播也在提交之后
    });
    // invoke 收尾把最后一个超步也提交了
    expect(cps().length).toBe(2);
    expect(events().length).toBe(1);
  });

  it("节点失败：该超步的 events 与 checkpoint 一起消失（计划硬规定 1 的验收）", async () => {
    const { auditor, saver, events, cps } = make();
    const boom = new Error("节点里炸了");
    await expect(
      auditor.invoke(async () => {
        await saver.put(cfg("ok1"), ck("ok1", null), META, {});
        await auditor.recorder.record({
          kind: "TaskStateChanged",
          taskId: "T-STEP",
          from: "a",
          to: "b",
        });
        await saver.putWrites(
          cfg("ok1"),
          [["messages", "m"]] as PendingWrite[],
          "task-ok",
        );

        await saver.put(cfg("bad"), ck("bad", "ok1"), META, {});
        await auditor.recorder.record({
          kind: "TaskStateChanged",
          taskId: "T-STEP",
          from: "b",
          to: "crash",
        });
        throw boom;
      }),
    ).rejects.toBe(boom);

    // 只留下【上一个】超步的一行事件 + 一个 checkpoint；失败超步的 checkpoint 也一起回滚，
    // 于是 V11 重放会重跑该节点、重新写事件 —— 不会留下半条记录（也不需要去重列）。
    expect(events().length).toBe(1);
    expect(cps().map((r) => r.checkpoint_id)).toEqual(["ok1"]);
  });

  it("invoke 之外 record：没有超步事务就抛错，绝不 autocommit", async () => {
    // 曾经这里套着一层 auditor.runOutside(fn)，而 runOutside 的实现就是 return fn()：
    // 它既不建作用域也不开事务，测的其实是「什么都不做」，还逼出一个 void db; 遮丑。
    // 删掉它，测试直接面对真相：不在 invoke 里就没有事务，守卫必须当场拒绝。
    const { auditor, events } = make();
    await expect(
      auditor.recorder.record({
        kind: "TaskStateChanged",
        taskId: "T-STEP",
        from: "a",
        to: "b",
      }),
    ).rejects.toThrow(/autocommit/);
    expect(events().length).toBe(0);
  });

  it("连续两次 put 之间没写 events → 复用同一事务，不产生空 WAL 往返", async () => {
    // 原断言写成 committedSteps === 取值时点 + 1，而取值时点本身随变异一起变，
    // 于是【删掉复用分支】也照样通过（1+1=2、2+1=3，两边都自洽）。改成绝对数字，
    // 并加一条【有写入】的对照：同一个协调器，差别只在中不中途 record。
    const bare = make();
    await bare.auditor.invoke(async () => {
      await bare.saver.put(cfg("a1"), ck("a1", null), META, {});
      await bare.saver.put(cfg("a2"), ck("a2", "a1"), META, {});
      await bare.saver.put(cfg("a3"), ck("a3", "a2"), META, {});
    });
    // 三次 put 一个事务：只有 invoke 收尾那一次 COMMIT。
    expect(bare.auditor.committedSteps).toBe(1);
    // 三个 checkpoint 一起可见 —— 它们本来就在同一事务里
    expect(bare.cps().map((r) => r.checkpoint_id)).toEqual(["a1", "a2", "a3"]);
    expect(bare.events().length).toBe(0);

    const busy = make();
    await busy.auditor.invoke(async () => {
      await busy.saver.put(cfg("b1"), ck("b1", null), META, {});
      await busy.auditor.recorder.record({
        kind: "TaskStateChanged",
        taskId: "T-STEP",
        from: "x",
        to: "y",
      });
      await busy.saver.put(cfg("b2"), ck("b2", "b1"), META, {});
    });
    // 事务里有过写入，下一次 put 就必须切：commit(b1 超步) + 收尾 commit(b2 超步) = 2
    expect(busy.auditor.committedSteps).toBe(2);
    expect(busy.events().length).toBe(1);
    expect(busy.cps().length).toBe(2);
  });

  it("saver 与 recorder 必须落在同一条连接、同一个事务（§6.3 的实质）", async () => {
    // 这条断言防的是将来的【连接漂移】：若 DbStepTx 改成每次 begin 新建一条连接，
    // recorder 写 events 用的连接就和 saver 写 checkpoints 用的不是同一条 ——
    // §6.3 当场失效，而且是【静默】失效：两边都写成功，只是不再原子。
    // 判别方式：另一个连接上同时观测两边的可见性，必须【同步】翻转。
    const { auditor, saver, events, cps } = make();
    await auditor.invoke(async () => {
      await saver.put(cfg("z1"), ck("z1", null), META, {});
      await auditor.recorder.record({
        kind: "TaskStateChanged",
        taskId: "T-STEP",
        from: "p",
        to: "q",
      });
      // 同一事务内：两边都还没提交
      expect(events().length).toBe(0);
      expect(cps().length).toBe(0);
      await saver.put(cfg("z2"), ck("z2", "z1"), META, {}); // 切超步 = 提交上一超步
      // 一起翻转为可见：一条可见另一条不可见，就说明两边不再同一事务
      expect(events().length).toBe(1);
      expect(cps().length).toBe(1);
    });
  });

  it("seq 严格跟随 events.id：跨超步连续递增，投影收到的是已提交的行", async () => {
    const { auditor, saver, bus } = make();
    await auditor.invoke(async () => {
      for (const id of ["c1", "c2", "c3"]) {
        await saver.put(cfg(id), ck(id, null), META, {});
        await auditor.recorder.record({
          kind: "BudgetPaused",
          taskId: "T-STEP",
          spentUsdCents: id.length,
        });
      }
    });
    expect(bus.published.map((p) => p.seq)).toEqual([1, 2, 3]);
    const rows = readCommitted(
      dirs.length - 1,
      "SELECT id FROM events ORDER BY id",
    );
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it("auditedInvoke 不经 invoke() 也能写审计：事务与作用域由 recorder.run 自己负责", async () => {
    // 这条测试锁 StepTx.scope() 【必须真的建帧】。recorder.run() 的事务是它自己
    // begin 的，帧也得它自己建 —— 若 scope() 退化成直接调 fn，帧就只剩下
    // SuperStepAuditor.invoke() 建的那一层，绕过 invoke 直接用 recorder 的路径
    // （审批、HTTP 侧的手动审计）会当场失去连接，表现是「丢失了事务作用域」。
    const { auditor, events, bus } = make();
    const out = await auditedInvoke({
      invoke: async () => ({
        __interrupt__: [{ id: "i-9", value: { gate: "ceo" } }],
      }),
      recorder: auditor.recorder,
      taskId: "T-STEP",
    });
    expect(out.__interrupt__).length(1);
    expect(events().map((r) => r.action)).toEqual(["approval"]);
    expect(events()[0]?.target).toBe("i-9");
    // recorder.run 自己开事务、自己提交：committedSteps 走了一格
    expect(auditor.committedSteps).toBe(1);
    expect(bus.published.map((p) => p.seq)).toEqual([1]);
  });
});
