/**
 * 探针 4（子进程）：两件事，都是【落地前必须量】的，不是补充说明。
 *
 * ① 审批写入点自己会不会重放重复？
 *    探针 3 只测了节点体内 recorder.record 那条边，从没把 auditedInvoke 套进崩溃
 *    重启里。而审计里【写 ApprovalRequired 的地方是 auditedInvoke】（invoke 返回之后），
 *    不是节点体。新进程 invoke(null) 会让图立刻停在同一个未决中断上、再返回一次
 *    __interrupt__ ⇒ 那一行可能又写一遍。若真重复，审批就必须有自己的 replayKey，
 *    且键里用的 interruptId 必须【跨进程稳定】（探针 356-interrupt-id 只测过同进程 resume）。
 *
 * ② 节点体里能不能拿到 __pregel_task_id —— 用【公开 API】getConfig()。
 *    company.ts 的节点工厂签名是 (state, write)，没有 config 形参；改签名会牵动
 *    每一个节点体与两套测试夹具。@langchain/langgraph 导出了 getConfig()
 *    （dist/index.d.ts 的 export 清单里有），它读 ALS，所以在 await 之后仍然可用。
 *    这里连测两个时机：模型 await【之前】与【之后】，因为 edge() 是在 await 之后调的。
 *
 * argv[2] = 数据库路径，argv[3] = "first" | "restart"
 */
import { DatabaseSync } from "node:sqlite";
import {
  Annotation,
  END,
  getConfig,
  interrupt,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { SqliteWALSaver } from "../packages/hub/src/checkpoint/saver.js";
import { CHECKPOINT_TABLES } from "../packages/hub/src/checkpoint/schema.js";
import type { DomainEvent, EventBus } from "../packages/hub/src/events/bus.js";
import {
  SuperStepAuditor,
  auditedInvoke,
} from "../packages/hub/src/graph/audit-middleware.js";

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
      " target TEXT, payload TEXT NOT NULL, state_snapshot TEXT, created_at INTEGER NOT NULL," +
      " replay_key TEXT)",
  );
  for (const ddl of CHECKPOINT_TABLES) db.exec(ddl);
}

const auditor = new SuperStepAuditor({ db, bus: new FakeBus() });
const saver = auditor.instrumentSaver(new SqliteWALSaver(db));

const State = Annotation.Root({
  trail: Annotation<string[]>({ reducer: (a, b) => a.concat(b) }),
});

const seen: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const graph = new StateGraph(State)
  .addNode("approval", async () => {
    // 时机 A：进入节点就取（await 之前）
    seen.beforeAwait = String(
      (getConfig()?.configurable ?? {})["__pregel_task_id"],
    );
    await sleep(5); // 模拟 askModel 的那一次 await
    // 时机 B：await 之后再取一次 —— edge() 实际就是在 await 之后被调的
    seen.afterAwait = String(
      (getConfig()?.configurable ?? {})["__pregel_task_id"],
    );
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
const cfg = { configurable: { thread_id: "probe4" } };

const result = await auditedInvoke({
  recorder: auditor.recorder,
  taskId: "T-CRASH",
  invoke: () =>
    auditor.invoke(() => g.invoke(isNew ? { trail: [] } : null, cfg)),
});

seen.interruptIds = (
  ((result as Record<string, unknown>)?.["__interrupt__"] ?? []) as Array<{
    id: string;
  }>
).map((i) => i.id);

const rows = db
  .prepare(
    "SELECT action, target, COUNT(*) c FROM events GROUP BY action, target ORDER BY action",
  )
  .all() as Array<{ action: string; target: string; c: number }>;

console.log(
  JSON.stringify({
    mode,
    pid: process.pid,
    seen,
    rows,
    total: db.prepare("SELECT COUNT(*) c FROM events").get(),
  }),
);
db.close();
