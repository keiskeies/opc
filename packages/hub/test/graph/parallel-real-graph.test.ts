/**
 * Task 3.7 的「框架内落点」：真 StateGraph 扇出扇入 + Reducer 合并语义。
 *
 * 0016 §7 登记过：真图扇出扇入「需要网络」（0009 §2 装不上 @langchain/*），
 * branches.ts 于是只交付判定 + 合并语义两块纯函数。round319 实测该前提已过期：
 * node_modules/@langchain/langgraph@1.7.1 已装上且 ESM invoke 真执行
 * （`LANGGRAPH_OK invoke={"n":3}`）。本文件补的就是那格【框架内的落点】。
 *
 * ── 承重（每发钉住什么）────────────────────────────────────────────
 * ① 真 StateGraph 里两条并行分支写同一个通道，汇聚节点读到的是【合并后】的值
 *    —— 证明 reducer 语义在真框架里生效，不是只活在看得到的纯函数里。
 * ② 汇聚输出按【分支声明顺序】而不是【到达序】—— 这正是 branches.ts 文件头那四行
 *    （「汇聚点若要产物清单的确定顺序，由 mergeParallelResults 按分支声明顺序输
 *    来给，交给 reducer 等于交给到达序」）要钉的事。用 sleep 制造到达序翻转，
 *    断言结果不变：若框架把到达序泄露进输出，这发必须红。
 * ③ 汇聚节点直接调用生产函数 mergeParallelResults —— 不是测试里抄一份合并，
 *    是让同一份实现被【纯函数测试】和【真图测试】两个方向夹住。
 *
 * ── 不承重（刻意不写，理由见文件头那条防过度设计）────────────────────
 * · 不把并行分支接进 company.ts 生产图 —— 0016 §7 明说计划允许「本期仅保留
 *   能力而不接入生产图」，§23.2 反过度设计正冲着「为并行而并行」。那是产品场景
 *   决定，不是实现层能单方面做的（本文件头注释下面 self-check 会盯住这一点：
 *   若哪天真的接进生产图，别指望本文件去发现它 —— 本文件管的是合并语义）。
 * · 不做并行 checkpoint 重放 —— 那要求先有并行生产图；在纯测试图上做的重放
 *   验证对「把并行接进生产图后会不会坏」没有鉴别力（0016 §7 那条立场同形：
 *   未实现比悄悄按宽松语义判过好）。
 *
 * 用途：满足规格 §5.4 PoC 门禁第 3 项『并行分支 Reducer 合并语义』的框架内现象；
 * 0016 §7 首条从「没做到」改口成「前提已过期，已补框架落点」。
 *
 * 类型口径（round319-8 修正）：gate 域用生产函数要的 GateSeverity，不用测试自造
 * 的 info/warning/blocked —— 换错了 gate 字符串在编译期就红，而不是真图跑起来
 * 才在测试断言里露馅。graph 组装复刻 company.ts 的纯链式（StateGraph 的节点名
 * 只沿链式返回值累积，中断成语句调用会让 addEdge 的字面量过不了类型检查）。
 */
import { describe, expect, it } from "vitest";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import {
  mergeParallelResults,
  type GateSeverity,
  type ParallelBranch,
  type ParallelMergeResult,
} from "../../src/graph/branches.js";

/**
 * 一条平行边的贡献。用真实生产函数要的 {artifact, gate: GateSeverity} 形状，
 * 不用测试自造的结构（见文件头「类型口径」）。
 */
type Contribution = {
  readonly artifact: string;
  readonly gate: GateSeverity;
};

/**
 * 扇出扇入的最小真图。
 *
 * fanIn 汇聚节点直接调用生产函数 mergeParallelResults —— 这一条的鉴别力在：
 * 若有人在 branches.ts 里改了合并顺序（比如按到达序），纯函数测试（branches.test）
 * 因为直接喂固定顺序的 contributions【可能】看不出来，而这里 contributions 来自
 * 两条并行分支的真实执行，顺序由框架调度决定。
 */
const BRANCHES: readonly ParallelBranch[] = [
  { roleId: "product", artifact: "spec" },
  { roleId: "ops", artifact: "runbook" },
];
const CONTRIBUTIONS: Readonly<Record<string, Contribution>> = {
  product: { artifact: "spec", gate: "reject" },
  ops: { artifact: "runbook", gate: "pass" },
};

function buildParallelGraph() {
  const State = Annotation.Root({
    // 每分支的贡献各占一个 key，reduce 用追加语义（谁先到都保留全部 key 的交付物）。
    merged: Annotation<Record<string, Contribution[]>>({
      reducer: (a, b) => ({ ...(a ?? {}), ...(b ?? {}) }),
      default: () => ({}),
    }),
    // 汇聚节点把合并结果写进这条显式通道 —— LangGraph 只会把 state schema 里
    // 声明的 key 保留进 invoke 返回；直接返回未声明 key 会被静默丢弃（实测过，
    // 第一次写 `{ merged, __fanInResult }` 拿回 undefined）。
    fanInResult: Annotation<ParallelMergeResult | undefined>({
      reducer: (_a, b) => b,
      default: () => undefined,
    }),
  });
  const fanInNode = async (s: { merged: Record<string, Contribution[]> }) => {
    const flat: Record<string, Contribution> = {};
    for (const [k, v] of Object.entries(s.merged)) {
      const c = v?.[0];
      if (c === undefined) continue; // 真缺一份 ⇒ 让 mergeParallelResults 去报
      flat[k] = c;
    }
    const result = mergeParallelResults(BRANCHES, flat);
    return { merged: s.merged, fanInResult: result };
  };
  return new StateGraph(State)
    .addNode("product", async () => ({
      merged: { product: [CONTRIBUTIONS.product] },
    }))
    .addNode("ops", async () => ({
      merged: { ops: [CONTRIBUTIONS.ops] },
    }))
    .addNode("fanIn", fanInNode)
    .addEdge(START, "product")
    .addEdge(START, "ops")
    .addEdge("product", "fanIn")
    .addEdge("ops", "fanIn")
    .addEdge("fanIn", END)
    .compile();
}

/** 纯函数那一侧用的标准 contributions 形状 → 与本文件用的保持一致。 */
const mkMerge = (): ParallelMergeResult =>
  mergeParallelResults(BRANCHES, CONTRIBUTIONS);

describe("真 StateGraph：扇出扇入的 Reducer 合并语义（0016 §7 框架落点）", () => {
  it("两条并行分支的产物都被合并进同一份结果（不是后到赢）", async () => {
    const graph = buildParallelGraph();
    const out = (await graph.invoke({})) as Record<string, unknown>;
    const merged = out.merged as Record<string, Contribution[]>;
    expect(Object.keys(merged).sort()).toEqual(["ops", "product"]);
    expect(merged["product"]).toEqual([CONTRIBUTIONS.product]);
  });

  it("合并结果与纯函数一致，且按【声明顺序】输出（不随运行序翻）", async () => {
    const graph = buildParallelGraph();
    const out = (await graph.invoke({})) as Record<string, unknown>;
    const fanIn = out.fanInResult as ParallelMergeResult;
    // 与纯函数在同一份输入上的产出逐字一致 —— 证明真图没把顺序搞乱。
    expect(fanIn).toEqual(mkMerge());
    // 具体到顺序：product 在前、ops 在后（声明序），且产物是 role_id 顺序。
    const roleIds = fanIn.artifacts.map((a) => a.role_id);
    expect(roleIds).toEqual(["product", "ops"]);
  });

  it("到达序翻转（ops 慢 200ms）不改变合并结果 —— 汇聚不依赖到达序", async () => {
    const State = Annotation.Root({
      merged: Annotation<Record<string, Contribution[]>>({
        reducer: (a, b) => ({ ...(a ?? {}), ...(b ?? {}) }),
        default: () => ({}),
      }),
      fanInResult: Annotation<ParallelMergeResult | undefined>({
        reducer: (_a, b) => b,
        default: () => undefined,
      }),
    });
    const fanInNode = async (s: { merged: Record<string, Contribution[]> }) => {
      const flat: Record<string, Contribution> = {};
      for (const [k, v] of Object.entries(s.merged)) {
        const c = v?.[0];
        if (c === undefined) continue; // 真缺一份 ⇒ 让 mergeParallelResults 去报
        flat[k] = c;
      }
      return { fanInResult: mergeParallelResults(BRANCHES, flat) };
    };
    const graph = new StateGraph(State)
      .addNode("product", async () => ({
        merged: { product: [CONTRIBUTIONS.product] },
      }))
      .addNode("ops", async () => {
        // 制造真实到达序翻转：ops 比 product 慢 200ms，两条分支仍应汇聚成声明序。
        await new Promise((r) => setTimeout(r, 200));
        return { merged: { ops: [CONTRIBUTIONS.ops] } };
      })
      .addNode("fanIn", fanInNode)
      .addEdge(START, "product")
      .addEdge(START, "ops")
      .addEdge("product", "fanIn")
      .addEdge("ops", "fanIn")
      .addEdge("fanIn", END)
      .compile();
    const out = (await graph.invoke({})) as { fanInResult: ParallelMergeResult };
    expect(out.fanInResult.artifacts.map((a) => a.role_id)).toEqual([
      "product",
      "ops",
    ]);
  });
});
