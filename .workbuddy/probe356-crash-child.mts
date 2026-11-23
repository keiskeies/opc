/**
 * 探针 3（子进程）：崩溃重启【换进程】后，同一个未完成节点的 task_id 还是不是同一个？
 *
 * 探针 2 测的是同进程 resume —— 那次 task_id 稳定可能是因为 resume 直接拿着
 * pending write 里记的 id 复用。真正的「崩溃恢复」（0005 §11 缺陷 B 的场景）是
 * 【新进程 + invoke(null)】：task_id 必须由【checkpoint + 节点输入】重新推导出来。
 * 探针 2 里那个 id 的 version nibble 是 5（uuid v5 = 名字派生、确定性），
 * 而 checkpoint_id 的 nibble 是 6（时间派生）—— 那正解释了为什么一个稳一个不稳。
 * 这里要把推测换成实测。
 *
 * argv[2] = 数据库路径，argv[3] = "first" | "restart"
 */
import { DatabaseSync } from "node:sqlite";
import { Command, END, interrupt, START, StateGraph, Annotation } from "@langchain/langgraph";
import { SqliteWALSaver } from "../packages/hub/src/checkpoint/saver.js";
import { CHECKPOINT_TABLES } from "../packages/hub/src/checkpoint/schema.js";
import type { DomainEvent, EventBus } from "../packages/hub/src/events/bus.js";
import { SuperStepAuditor } from "../packages/hub/src/graph/audit-middleware.js";

class FakeBus implements EventBus {
  publishPersisted(_e: DomainEvent, _seq: number): void {}
  latestSeq(): number {
    return 0;
  }
  subscribe(): never {
    throw new Error("不该订阅");
  }
}

const dbPath = process.argv[2] ?? "";
const mode = process.argv[3] ?? "first";
const isNew = mode === "first";

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL;");
if (isNew) {
  db.exec(
    "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT," +
      " actor_type TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL," +
      " target TEXT, payload TEXT NOT NULL, state_snapshot TEXT, created_at INTEGER NOT NULL)",
  );
  for (const ddl of CHECKPOINT_TABLES) db.exec(ddl);
}

const auditor = new SuperStepAuditor({ db, bus: new FakeBus() });
const saver = auditor.instrumentSaver(new SqliteWALSaver(db));

const State = Annotation.Root({
  trail: Annotation<string[]>({ reducer: (a, b) => a.concat(b) }),
});

let seenTaskId = "（节点没跑到）";
const graph = new StateGraph(State)
  .addNode("approval", async (_s: unknown, cfg: Record<string, unknown>) => {
    seenTaskId = String((cfg["configurable"] as Record<string, unknown>)["__pregel_task_id"]);
    await auditor.recorder.record({
      kind: "TaskStateChanged",
      taskId: "T-CRASH",
      from: "running",
      to: "need_approval",
    });
    interrupt({ reason: "请批准" });
    return { trail: ["resumed"] };
  })
  .addEdge(START, "approval")
  .addEdge("approval", END)
  .compile({ checkpointer: saver }) as never;

const g = graph as { invoke(i: unknown, c: unknown): Promise<unknown> };
const cfg = { configurable: { thread_id: "crash-1" } };

if (isNew) {
  // 跑到中断就【不 resume】—— 模拟进程在这里没了（已提交的超步留着）
  await auditor.invoke(() => g.invoke({ trail: [] }, cfg));
} else {
  // 崩溃恢复姿势：invoke(null)，不带 Command、不带 resume
  await auditor.invoke(() => g.invoke(null, cfg));
}

const rows = (
  db.prepare("SELECT COUNT(*) c FROM events").get() as { c: number }
).c;
console.log(
  JSON.stringify({
    mode,
    pid: process.pid,
    nodeTaskId: seenTaskId,
    eventRows: rows,
  }),
);
db.close();
