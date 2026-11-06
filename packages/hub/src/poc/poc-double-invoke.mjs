// 反例守卫：演示「重复 invoke」而不是「Command resume」会发生什么。
// 若将来 LangGraph 改成重复 invoke 也能推进，test/poc/resume.test.ts 会红 —— 那正是我们想要的信号。
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { build } from "./graph.mjs";

const [dbPath, threadId] = process.argv.slice(2);
if (!dbPath || !threadId) {
  console.error("usage: node poc-double-invoke.mjs <db-path> <thread-id>");
  process.exit(2);
}

const saver = SqliteSaver.fromConnString(dbPath);
const graph = build(saver);
const cfg = { configurable: { thread_id: threadId } };

let outcome = "ok";
let finalTrail = null;
try {
  const again = await graph.invoke({ doc: "re-fed", trail: [] }, cfg); // 错误用法：普通输入而非 Command
  finalTrail = again.trail ?? null;
} catch (e) {
  outcome = "threw:" + String(e?.message ?? e).slice(0, 120);
}

const state = await graph.getState(cfg);
console.log(
  JSON.stringify({
    phase: "double-invoke",
    outcome,
    finalTrail,
    next: state.next ?? [],
  }),
);
await saver.close?.();
