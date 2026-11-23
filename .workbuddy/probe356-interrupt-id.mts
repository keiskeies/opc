import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os"; import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Annotation, Command, END, interrupt, START, StateGraph } from "@langchain/langgraph";
import { SqliteWALSaver } from "../packages/hub/src/checkpoint/saver.js";
import { CHECKPOINT_TABLES } from "../packages/hub/src/checkpoint/schema.js";
import type { DomainEvent, EventBus } from "../packages/hub/src/events/bus.js";
import { SuperStepAuditor } from "../packages/hub/src/graph/audit-middleware.js";
class B implements EventBus { publishPersisted(): void {} latestSeq(){return 0} subscribe(){throw new Error("x")} }
const dir = mkdtempSync(join(tmpdir(), "opc-p4-")); const db = new DatabaseSync(join(dir, "s.db"));
db.exec("PRAGMA journal_mode = WAL;");
db.exec("CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, actor_type TEXT, actor_id TEXT, action TEXT, target TEXT, payload TEXT, state_snapshot TEXT, created_at INTEGER)");
for (const d of CHECKPOINT_TABLES) db.exec(d);
const a = new SuperStepAuditor({ db, bus: new B() });
const saver = a.instrumentSaver(new SqliteWALSaver(db));
const S = Annotation.Root({ n: Annotation<number>({ reducer: (_x, y) => y, default: () => 0 }) });
const g = new StateGraph(S)
  .addNode("nd", async (_s: unknown, c: Record<string, unknown>) => {
    const t = String((c.configurable as Record<string, unknown>).__pregel_task_id);
    let k = 0;
    // 同一个节点任务里连续两次 interrupt：第二次的 id 会不会撞上第一次？
    const r1 = interrupt({ why: "第一次" }); void r1; void k;
    return {};
  })
  .addEdge(START, "nd").addEdge("nd", END).compile({ checkpointer: saver }) as never;
const gg = g as { invoke(i: unknown, c: unknown): Promise<unknown> };
const cfg = { configurable: { thread_id: "p4" } };
const r = await a.invoke(() => gg.invoke({ n: 0 }, cfg));
console.log("第一次中断 =", JSON.stringify((r as Record<string, unknown>).__interrupt__));
const r2 = await a.invoke(() => gg.invoke(new Command({ resume: { ok: 1 } }), cfg));
console.log("resume 后中断 =", JSON.stringify((r2 as Record<string, unknown>).__interrupt__));
console.log("两次 id 是否相同？", JSON.stringify((r as Record<string,unknown>).__interrupt__) === JSON.stringify((r2 as Record<string,unknown>).__interrupt__) ? "★相同(会被审批索引误吞)" : "不同(合法的第二张卡不吞)");
db.close(); rmSync(dir, { recursive: true, maxRetries: 40, retryDelay: 50 });
