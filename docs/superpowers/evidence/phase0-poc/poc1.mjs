
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { build } from "./poc-graph.mjs";
const saver = SqliteSaver.fromConnString("./poc-ckpt.db");
const g = build(saver);
const cfg = { configurable: { thread_id: "T2" } };
const r = await g.invoke({ doc: "", trail: [] }, cfg);
console.log("P1 返回值里的 interrupt:", JSON.stringify(r.__interrupt__ ?? null).slice(0, 200));
const st = await g.getState(cfg);
console.log("P1 next:", JSON.stringify(st.next), "| trail:", JSON.stringify(st.values.trail));
console.log("P1 tasks:", JSON.stringify((st.tasks ?? []).map(t => t.name)));
