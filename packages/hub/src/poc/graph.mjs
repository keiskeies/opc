
import { StateGraph, Annotation, interrupt, END } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph-checkpoint";

export const State = Annotation.Root({
  doc: Annotation({ reducer: (_p, n) => n }),
  trail: Annotation({ reducer: (a, b) => a.concat(b) }),
});

// 子图：辩论会（§10.2）—— 三个辩手并行 + 主持汇聚
const Debate = Annotation.Root({
  trail: Annotation({ reducer: (a, b) => a.concat(b) }),
  verdict: Annotation({ reducer: (_p, n) => n }),
});
function debateGraph() {
  return new StateGraph(Debate)
    .addNode("pro", () => ({ trail: "pro" }))
    .addNode("con", () => ({ trail: "con" }))
    .addNode("judge", (s) => ({ verdict: "go", trail: "judge:" + s.trail.length }))
    .addEdge("__start__", "pro")
    .addEdge("__start__", "con")
    .addEdge(["pro", "con"], "judge")
    .addEdge("judge", END)
    .compile({ checkpointer: new MemorySaver() });
}

export function build(saver) {
  const debate = debateGraph();
  return new StateGraph(State)
    .addNode("producer", () => ({ doc: "draft-v1", trail: "producer" }))
    .addNode("gateA", () => ({ trail: "gateA-pass" }))
    .addNode("gateB", () => ({ trail: "gateB-pass" }))
    .addNode("merge", () => ({ trail: "merge" }))
    .addNode("debate", async () => {
      const sub = await debate.invoke({ trail: [], verdict: "" }, { configurable: { thread_id: "debate-1" } });
      return { trail: "debate[" + sub.trail.join("+") + "]=" + sub.verdict };
    })
    .addNode("approval", (s) => {
      const d = interrupt({ question: "CEO 批准？", snapshot: s.doc });
      return { trail: "approval:" + d };
    })
    .addEdge("__start__", "producer")
    .addEdge("producer", "gateA")
    .addEdge("producer", "gateB")
    .addEdge(["gateA", "gateB"], "merge")
    .addEdge("merge", "debate")
    .addEdge("debate", "approval")
    .addEdge("approval", END)
    .compile({ checkpointer: saver });
}
