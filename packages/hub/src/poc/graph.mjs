import { Annotation, END, interrupt, StateGraph } from "@langchain/langgraph";
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
    .addNode("judge", (s) => ({
      verdict: "go",
      trail: "judge:" + s.trail.length,
    }))
    .addEdge("__start__", "pro")
    .addEdge("__start__", "con")
    .addEdge(["pro", "con"], "judge")
    .addEdge("judge", END)
    .compile({ checkpointer: new MemorySaver() });
}

export function build(saver) {
  const debate = debateGraph();
  return (
    new StateGraph(State)
      .addNode("producer", () => ({ doc: "draft-v1", trail: "producer" }))
      .addNode("gateA", () => ({ trail: "gateA-pass" }))
      // gateB 故意慢 300ms。理由【不是】用 trail 顺序证明 fan-in —— Pregel 超步语义下，
      // 同一超步的兄弟节点整批收尾后才进下一超步，trail 顺序不携带 fan-in 信息（计划 V10：
      // 实测把 addEdge([gateA,gateB],merge) 改成 addEdge(gateA,merge)，trail 一字不差）。
      // 保留延时只为排除【调度运气】的解释：让 merge 必须真的等待，而非恰好排在其后。
      .addNode("gateB", async () => {
        await new Promise((r) => setTimeout(r, 300));
        return { trail: "gateB-pass" };
      })
      .addNode("merge", () => ({ trail: "merge" }))
      .addNode("debate", async () => {
        const sub = await debate.invoke(
          { trail: [], verdict: "" },
          { configurable: { thread_id: "debate-1" } },
        );
        return { trail: "debate[" + sub.trail.join("+") + "]=" + sub.verdict };
      })
      .addNode("approval", (s) => {
        const d = interrupt({ question: "CEO 批准？", snapshot: s.doc });
        return { trail: "approval:" + d };
      })
      .addEdge("__start__", "producer")
      .addEdge("producer", "gateA")
      .addEdge("producer", "gateB")
      .addEdge("gateA", "merge")
      .addEdge("merge", "debate")
      .addEdge("debate", "approval")
      .addEdge("approval", END)
      .compile({ checkpointer: saver })
  );
}
