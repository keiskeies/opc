/**
 * 探针：中断重放时，节点内 record() 所在超步的 checkpoint_id / step 稳不稳定？
 *
 * 这决定 B1-B 去重键能不能用「超步身份」当其中一维：
 *  · 若第一次跑与 resume 重放拿到【同一个 checkpoint_id / step】⇒ 键 =
 *    (task_id, action, target, checkpoint_id) 能吞掉重放，且不吞合法的重复跃迁
 *    （合法的第二条在另一个超步 ⇒ 另一个 id）。
 *  · 若【不一样】⇒ checkpoint 身份不能进去重键，只能退到业务语义键，
 *    而 0005 §11.4 明说业务键选错会把真实事件吞掉。
 *
 * 只读探针：建临时库、跑图、打印读数、删库。不改任何生产字节。
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

const dir = mkdtempSync(join(tmpdir(), "opc-probe-step-"));
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

// 观察 put 拿到的 checkpoint.id / metadata.step —— 这就是「当前超步身份」。
const puts: { id: string; step: unknown; source: unknown }[] = [];
const origPut = saver.put.bind(saver);
saver.put = ((c: never, cp: { id: string }, md: Record<string, unknown>) => {
  puts.push({ id: cp.id, step: md["step"], source: md["source"] });
  return origPut(c as never, cp as never, md as never, {} as never);
}) as typeof saver.put;

const State = Annotation.Root({
  trail: Annotation<string[]>({ reducer: (a, b) => a.concat(b) }),
});

let nodeRuns = 0;
const graph = new StateGraph(State)
  .addNode("approval", async () => {
    nodeRuns += 1;
    // 中断【之前】写一条：这是缺陷 A 的唯一触发形状（0005 §11）。
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

const cfg = { configurable: { thread_id: "probe-1" } };

const rows = () =>
  db
    .prepare(
      "SELECT id, action, target, payload FROM events ORDER BY id",
    )
    .all() as Record<string, unknown>[];

console.log("--- 第一次 invoke ---");
await auditor.invoke(() =>
  (graph as { invoke(i: unknown, c: unknown): Promise<unknown> }).invoke(
    { trail: [] },
    cfg,
  ),
);
console.log("nodeRuns =", nodeRuns, "puts =", JSON.stringify(puts));
console.log("rows =", rows().length);

const puts1 = puts.map((p) => p.id);

console.log("--- resume（重放）---");
await auditor.invoke(() =>
  (graph as { invoke(i: unknown, c: unknown): Promise<unknown> }).invoke(
    new Command({ resume: { decision: "pass" } }),
    cfg,
  ),
);
console.log("nodeRuns =", nodeRuns, "puts =", JSON.stringify(puts));
console.log("rows =", rows().length);

const puts2 = puts.slice(puts1.length).map((p) => p.id);
console.log("第一次的 put ids =", puts1);
console.log("resume 新增的 put ids =", puts2);
console.log(
  "重放期间是否有【与第一次相同】的 put id？⇒",
  puts2.some((id) => puts1.includes(id)),
);
console.log(
  "checkpoints 表里那一列可读的形状 =",
  db
    .prepare("SELECT checkpoint_id, type FROM checkpoints ORDER BY checkpoint_id")
    .all(),
);

db.close();
rmSync(dir, { recursive: true, maxRetries: 40, retryDelay: 50 });
