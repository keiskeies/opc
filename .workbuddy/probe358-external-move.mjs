/** round359 探针：被拦轮 + runTurn 期间外部挪走任务 ⇒ 最终状态。 */
import { rmSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
const ROOT = pathToFileURL(process.cwd() + "/packages/hub/").href;
const TMP = (process.cwd() + "/.workbuddy/tmp-probe358b").replace(/\\/g, "/");
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const { openDb } = await import(ROOT + "src/db/driver.ts");
const { WriteQueue } = await import(ROOT + "src/db/write-queue.ts");
const { InMemoryEventBus } = await import(ROOT + "src/events/bus.ts");
const { makeDispatch } = await import(ROOT + "src/engine/dispatch.ts");
const { gateDepsFrom } = await import(ROOT + "test/fixtures/gate-deps.ts");
const { migrate } = await import(ROOT + "src/db/migrate.ts");
const NOW = 1700000000000;
const db = openDb(TMP + "/probe.db");
migrate(db);
const GRAPH = {
  nodes: {
    ceo: { role_id: "ceo", can_manage: true, reports_to: null, model_family: "opus" },
    director: { role_id: "director", can_manage: true, reports_to: "ceo", model_family: "sonnet" },
    dev: { role_id: "dev", can_manage: false, reports_to: "director", model_family: "claude" },
  },
  edges: [{ from: "dev", to: "director", review_gate: true }],
};
db.prepare("INSERT INTO delegation_graphs (id, version, graph_json, effective_from, created_by, change_summary) VALUES ('g1', 1, ?, ?, ?, 'probe')").run(JSON.stringify(GRAPH), NOW, "ceo");
db.prepare("INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at, graph_version) VALUES ('t1', 'probe', 'IN_REVIEW', 'director', 'director', ?, ?, 1)").run(NOW, NOW);
const q = new WriteQueue(TMP + "/probe.db");
const bus = new InMemoryEventBus();
bus.subscribe(0);
const dispatch = makeDispatch({
  writer: q,
  ...gateDepsFrom(db, TMP + "/artifacts"),
  loadTask: () => ({ id: "t1", title: "x", status: "IN_REVIEW", role: "director", graphVersion: 1 }),
  modelFamily: (r) => { const fam = GRAPH.nodes[r]?.["model_family"]; if (GRAPH.nodes[r] === undefined) console.log("PROBE: role not found:", r, "keys:", Object.keys(GRAPH.nodes)); return String(fam ?? ""); },
  rolePrompt: () => "",
  roleSession: () => null,
  runTurn: async () => {
    db.prepare("UPDATE tasks SET status='BLOCKED' WHERE id='t1'").run();
    return { ok: true, text: '干完了。\n\n<<<OPC_DECISION>>>\n' + JSON.stringify({ action: "pass", summary: "全绿" }), costCents: 4, sessionId: "s", error: null };
  },
  recentSummaries: () => [],
  lastProducer: () => "dev",
  rejectionCount: () => 0,
  ceoApproved: () => false,
  publish: () => {},
});
try {
  const res = await dispatch({ taskId: "t1", nowMs: NOW, maxBudgetUsd: 0.5 });
  console.log("RESOLVED (no throw). res=", JSON.stringify(res));
} catch (e) {
  console.log("THREW:", e instanceof Error ? e.message : e);
  if (e instanceof Error && e.stack) console.log("STACK:", e.stack.split("\n").slice(0, 6).join("\n"));
}
console.log("status:", String(db.prepare("SELECT status FROM tasks WHERE id='t1'").get()?.["status"]));
console.log("cards:", JSON.stringify(db.prepare("SELECT card_key FROM approvals ORDER BY rowid").all()));
console.log("events:", JSON.stringify(db.prepare("SELECT id, action FROM events ORDER BY id").all()));
console.log("review_gates:", JSON.stringify(db.prepare("SELECT gate_type, decision FROM review_gates").all()));
console.log("evidence_bundles:", JSON.stringify(db.prepare("SELECT bundle_id FROM evidence_bundles").all()));
