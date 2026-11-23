/** round359 探针：全量拦下 IN_REVIEW+pass 的真实行为（写哪些行、建哪张卡）。 */
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const base = "file://" + process.cwd().replace(/\/g, "/") + "/packages/hub/";
const TMP = process.cwd() + "/.workbuddy/tmp-probe358";
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const dbmod = await import(base + "src/db/driver.ts");
const queueMod = await import(base + "src/db/write-queue.ts");
const busMod = await import(base + "src/events/bus.ts");
const dispatchMod = await import(base + "src/engine/dispatch.ts");
const gateDepsMod = await import(base + "test/fixtures/gate-deps.ts");
const cardsMod = await import(base + "src/approvals/cards.ts");

const NOW = 1700000000000;
const DB = TMP + "/probe.db";
const { openDb } = dbmod;
const db = openDb({ path: DB });
const { migrate } = await import(base + "src/db/migrate.ts");
migrate(db);

const GRAPH = {
  version: 1,
  roles: {
    intake: { model_family: "claude" },
    dev: { model_family: "claude" },
    director: { model_family: "claude" },
    ceo: { model_family: "claude" },
  },
  edges: [
    { from: "intake", to: "dev", review_gate: false },
    { from: "dev", to: "director", review_gate: false },
    { from: "director", to: "ceo", review_gate: false },
  ],
};
const CEO = "ceo";
const INSERT_GRAPH = `INSERT INTO delegation_graphs (id, version, graph_json, created_at, updated_at, author, note)
  VALUES ('g1', 1, ?, ?, ?, ?, 'probe')`;
db.prepare(INSERT_GRAPH).run(JSON.stringify(GRAPH), NOW, NOW, CEO);
db.prepare(
  `INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at, graph_version)
   VALUES ('t1', 'probe', 'IN_REVIEW', 'director', 'director', ?, ?, 1)`
).run(NOW, NOW);

const q = new queueMod.WriteQueue(db);
const bus = new busMod.InMemoryEventBus();
const published: { kind: string; seq: number }[] = [];
bus.subscribe(0);
const dispatch = dispatchMod.makeDispatch({
  writer: q,
  ...gateDepsMod.gateDepsFrom(db, TMP + "/artifacts"),
  loadTask: () => ({ id: "t1", title: "probe", status: "IN_REVIEW", role: "director", graphVersion: 1 }),
  modelFamily: (r) => String(GRAPH.roles[r]?.["model_family"] ?? ""),
  rolePrompt: () => "",
  roleSession: () => null,
  runTurn: async () => ({
    ok: true,
    text: '干完了。\n\n<<<OPC_DECISION>>>\n' + JSON.stringify({ action: "pass", summary: "覆盖率 92%" }),
    costCents: 4,
    sessionId: "sess",
    error: null,
  }),
  recentSummaries: () => [],
  lastProducer: () => "dev",
  rejectionCount: () => 0,
  ceoApproved: () => false,
  publish: (e, seq) => { published.push({ kind: e.kind, seq }); bus.publishPersisted(e, seq); },
});
const res = await dispatch({ taskId: "t1", nowMs: NOW, maxBudgetUsd: 0.5 });
console.log("res:", JSON.stringify(res, null, 2));
console.log("status:", String(db.prepare("SELECT status FROM tasks WHERE id='t1'").get()?.["status"]));
const cards = db.prepare("SELECT card_key, summary, approval_type FROM approvals ORDER BY rowid").all();
console.log("cards:", JSON.stringify(cards, null, 2));
const events = db.prepare("SELECT id, action, actor_id, target FROM events ORDER BY id").all();
console.log("events:", JSON.stringify(events, null, 2));
console.log("published:", JSON.stringify(published));
const rg = db.prepare("SELECT gate_type, decision, round_no, evidence_bundle_id FROM review_gates").all();
console.log("review_gates:", JSON.stringify(rg, null, 2));
const eb = db.prepare("SELECT bundle_id, produced_by_role FROM evidence_bundles").all();
console.log("evidence_bundles:", JSON.stringify(eb, null, 2));
