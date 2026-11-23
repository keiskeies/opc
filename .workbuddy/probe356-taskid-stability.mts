/**
 * 探针 2：重放时 LangGraph 的【节点 task_id】稳不稳定？
 *
 * 探针 1 已排除 checkpoint_id / step（重放拿新 id、step 0→1）。
 * 若 task_id 稳定 ⇒ 它是唯一「同一次重放相同、合法第二次出现不同」的维度，
 * 去重键就有了正确的第四维。
 */
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

const dir = mkdtempSync(join(tmpdir(), "opc-probe-taskid-"));
const db = new DatabaseSync(join(dir, "s.db"));
db.exec("PRAGMA journal_mode = WAL;");
db.exec(
  "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT," +
    " actor_type TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL," +
    " target TEXT, payload TEXT NOT NULL, state_snapshot TEXT, created_at INTEGER NOT NULL)",
);
for (const ddl of CHECKPOINT_TABLES) db.exec(ddl);

const auditor = new SuperStepAuditor({ db, bus: new FakeBus() });
const saver = auditor.instrumentSaver(new SqliteWALSaver(db));

const writeTasks: { taskId: string; channels: string[] }[] = [];
const origWrites = saver.putWrites.bind(saver);
saver.putWrites = ((
  c: never,
  writes: never,
  taskId: string,
  taskPath?: string,
) => {
  writeTasks.push({
    taskId,
    channels: (writes as [string, unknown][]).map((w) => String(w[0])),
  });
  return origWrites(c as never, writes as never, taskId, taskPath);
}) as typeof saver.putWrites;

const State = Annotation.Root({
  trail: Annotation<string[]>({ reducer: (a, b) => a.concat(b) }),
});

const seen: { run: number; cfg: Record<string, unknown> }[] = [];
let nodeRuns = 0;
const graph = new StateGraph(State)
  .addNode("approval", async (_s: unknown, config: Record<string, unknown>) => {
    nodeRuns += 1;
    seen.push({ run: nodeRuns, cfg: (config["configurable"] ?? {}) as Record<string, unknown> });
    await auditor.recorder.record({
      kind: "TaskStateChanged",
      taskId: "T-PROBE",
      from: "running",
      to: "need_approval",
    });
    interrupt({ reason: "请批准" });
    return { trail: ["resumed"] };
  })
  .addEdge(START, "approval")
  .addEdge("approval", END)
  .compile({ checkpointer: saver }) as never;

const cfg = { configurable: { thread_id: "probe-2" } };
const g = graph as { invoke(i: unknown, c: unknown): Promise<unknown> };

await auditor.invoke(() => g.invoke({ trail: [] }, cfg));
console.log("第一次：节点看到的 configurable =", JSON.stringify(seen[0]?.cfg));
console.log("第一次：putWrites taskIds =", JSON.stringify(writeTasks));

const n1 = writeTasks.length;
await auditor.invoke(() =>
  g.invoke(new Command({ resume: { decision: "pass" } }), cfg),
);
console.log("重放：节点看到的 configurable =", JSON.stringify(seen[1]?.cfg));
console.log("重放新增：putWrites =", JSON.stringify(writeTasks.slice(n1)));

const first = Object.keys(seen[0]?.cfg ?? {});
const second = Object.keys(seen[1]?.cfg ?? {});
for (const k of new Set([...first, ...second])) {
  const a = seen[0]?.cfg?.[k];
  const b = seen[1]?.cfg?.[k];
  console.log(
    "  " + k.padEnd(18),
    "稳定?",
    a === b ? "★相同" : "不同",
    "| 1=" + String(a),
    "| 2=" + String(b),
  );
}
console.log(
  "重复 events 行数 =",
  (db.prepare("SELECT COUNT(*) c FROM events").get() as { c: number }).c,
);
console.log(
  "重放里 interruptId =",
  db
    .prepare("SELECT target FROM events ORDER BY id")
    .all()
    .map((r) => String(r["target"])),
);

db.close();
rmSync(dir, { recursive: true, maxRetries: 40, retryDelay: 50 });
