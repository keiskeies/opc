import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  Annotation,
  Command,
  END,
  interrupt,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { afterAll, describe, expect, it } from "vitest";
import { SqliteWALSaver } from "../../src/checkpoint/saver.js";
import { CHECKPOINT_TABLES } from "../../src/checkpoint/schema.js";
import type { DomainEvent, EventBus } from "../../src/events/bus.js";
import { SuperStepAuditor } from "../../src/graph/audit-middleware.js";

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

class FakeBus implements EventBus {
  readonly published: number[] = [];
  publishPersisted(_e: DomainEvent, seq: number): void {
    this.published.push(seq);
  }
  latestSeq(): number {
    return this.published.length;
  }
  subscribe(): never {
    throw new Error("不该订阅");
  }
}

function openDb(): { db: DatabaseSync; index: number } {
  const dir = mkdtempSync(join(tmpdir(), "opc-rerun-"));
  dirs.push(dir);
  const db = new DatabaseSync(join(dir, "s.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(EVENTS_DDL);
  for (const ddl of CHECKPOINT_TABLES) db.exec(ddl);
  dbs.push(db);
  return { db, index: dirs.length - 1 };
}

/** 第二个只读连接：写连接永远看得见自己未提交的写入，据此断言毫无鉴别力。 */
function readCommitted(index: number): Record<string, unknown>[] {
  const other = new DatabaseSync(join(dirs[index] ?? "", "s.db"), {
    readOnly: true,
  });
  try {
    return other
      .prepare("SELECT id, action, payload FROM events ORDER BY id")
      .all() as Record<string, unknown>[];
  } finally {
    other.close();
  }
}

const State = Annotation.Root({
  trail: Annotation<string[]>({ reducer: (a, b) => a.concat(b) }),
});

interface Harness {
  auditor: SuperStepAuditor;
  graph: {
    invoke(input: unknown, cfg: unknown): Promise<Record<string, unknown>>;
  };
  rows: () => Record<string, unknown>[];
  cfg: { configurable: { thread_id: string } };
  calls: () => { approval: number };
}

/**
 * @param writeBeforeInterrupt record 是否发生在 interrupt() 【之前】。
 *   这是本缺陷的唯一触发条件：LangGraph 的 interrupt 靠【重放节点直到 interrupt()
 *   那一行】实现（实测见 0005 §11），所以中断之前写的 events 会被重放写第二遍。
 */
function make(writeBeforeInterrupt: boolean): Harness {
  const { db, index } = openDb();
  const bus = new FakeBus();
  const auditor = new SuperStepAuditor({ db, bus, now: () => 1700000000000 });
  const saver = auditor.instrumentSaver(new SqliteWALSaver(db));
  const runs = { approval: 0 };
  const record = () =>
    auditor.recorder.record({
      kind: "TaskStateChanged",
      taskId: "T-RERUN",
      from: "running",
      to: "need_approval",
    });
  const graph = new StateGraph(State)
    .addNode("approval", async () => {
      runs.approval += 1;
      if (writeBeforeInterrupt) await record();
      interrupt({ reason: "请批准" });
      if (!writeBeforeInterrupt) await record();
      return { trail: ["resumed"] };
    })
    .addEdge(START, "approval")
    .addEdge("approval", END)
    .compile({ checkpointer: saver }) as unknown as Harness["graph"];
  return {
    auditor,
    graph,
    rows: () => readCommitted(index),
    cfg: { configurable: { thread_id: "rerun-" + index } },
    calls: () => runs,
  };
}

describe("interrupt resume 重放对 events 的影响（当前行为 = 缺陷，见 0005 §11）", () => {
  it("节点在 interrupt() 之前写的 events，resume 后被重放写第二遍", async () => {
    // 【这不是期望行为，是已知缺陷的回归锁。】
    // 期望是「不重复」（计划 Task 0.6 第 4 项），实测【会重复】。测试断言当前的
    // 真实行为，好处是：一旦去重机制落地，本测试立刻变红，逼着来改的人读这条注释，
    // 而不是留一条永远绿着的「测了个寂寞」。
    const h = make(true);
    await h.auditor.invoke(() => h.graph.invoke({ trail: [] }, h.cfg));
    const after1 = h.rows();
    expect(after1.length).toBe(1);

    await h.auditor.invoke(() =>
      h.graph.invoke(new Command({ resume: { decision: "pass" } }), h.cfg),
    );
    const after2 = h.rows();
    expect(after2.length).toBe(2);
    // 两条【逐字相同】才算「重复」：不同 payload 就是两个真实事件，不该去重。
    expect(after2[1]?.payload).toBe(after2[0]?.payload);
    expect(after2[1]?.action).toBe("state_change");
    expect(h.calls().approval).toBe(2); // 节点确实重跑到了 interrupt 那一行
  });

  it("崩溃恢复姿势 invoke(null) 同样重放 ⇒ 也会重复", async () => {
    // 计划原文正是「崩溃恢复（V3）」：进程重启后用 invoke(null) 续跑。
    // V3 只保证【checkpoint】不重跑，不保证【节点内副作用】不重放 —— 两者不是一回事。
    const h = make(true);
    await h.auditor.invoke(() => h.graph.invoke({ trail: [] }, h.cfg));
    expect(h.rows().length).toBe(1);
    await h.auditor.invoke(() => h.graph.invoke(null, h.cfg));
    expect(h.rows().length).toBe(2);
  });

  it("record 在 interrupt() 【之后】就不重复 ⇒ 缺陷边界就在中断之前那半段", async () => {
    // 这条对照把缺陷边界钉死：同一个节点、同一次 resume，差别只是 record 落在
    // interrupt 前还是后。有了它，「所有节点都不许写 events」这种一刀切规避就
    // 站不住 —— 也能用来验证将来的修复是否【过宽】（过宽会误杀合法的第二条事件）。
    const h = make(false);
    await h.auditor.invoke(() => h.graph.invoke({ trail: [] }, h.cfg));
    expect(h.rows().length).toBe(0); // 首次挂起在 interrupt，后半段没跑到
    await h.auditor.invoke(() =>
      h.graph.invoke(new Command({ resume: { decision: "pass" } }), h.cfg),
    );
    // resume 后才执行后半段：恰好一条，不重复。
    expect(h.rows().length).toBe(1);
  });
});
