
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { Command } from "@langchain/langgraph";
import { build } from "./poc-graph.mjs";
const saver = SqliteSaver.fromConnString("./poc-ckpt.db");
const g = build(saver);
const cfg = { configurable: { thread_id: "T2" } };
const st = await g.getState(cfg);
console.log("P2 重启后 next:", JSON.stringify(st.next), "| trail:", JSON.stringify(st.values.trail));
const done = await g.invoke(new Command({ resume: "approved-after-kill" }), cfg);
console.log("P2 完成 trail:", JSON.stringify(done.trail));
