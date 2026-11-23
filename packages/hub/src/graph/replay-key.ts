/**
 * 节点执行的重放键（0005 §11 缺陷 A/B 的唯一解，0010 那条索引的键源）。
 *
 * ── 为什么单独成一个文件而不是留在 company.ts ────────────────────
 * 键的算法必须在【生产与测试】之间共用一份。测试里另抄一遍 `configurable["__pregel_task_id"]`
 * 的后果不是「重复代码」，是【测试可以绿在生产之外】：LangGraph 升级改了
 * configurable 的私有形状时，生产那边 replayKeyOf() 抛错、测试那份手抄的读到
 * undefined 于是【不传键】—— 于是一趟重放写出两行，而测试的夹具照旧断言「重放不重复」
 * 并【因为没传键而失败】……红是红了，但报的是「去重失效」，而不是「键源取不到了」。
 * 共用一份之后，取不到键这件事会在测试里以【那句原话】炸出来。
 *
 * ── 为什么是 __pregel_task_id，而不是别的（三条都实测过）──────────
 * 0005 §11.4 原本建议用【超步序号】，那一维【实测是错的】：
 *  - .workbuddy/probe356-replay-step.mts 量到 resume 时 checkpoint_id 每次都新、
 *    metadata.step 从 0 变 1。拿一个会变的值当键 = 重放行拿到不同的键 = 一条也吞不掉，
 *    而索引看起来完全正常。
 *  - .workbuddy/probe356-crash-child.mts 量到跨进程崩溃重启后 task_id 三次一模一样
 *    （uuid v5 = 名字派生，所以跨进程稳定）。
 *  - .workbuddy/probe356-approval-replay-child.mts 量到节点体内 await 前后各取一次
 *    getConfig() 同值 —— getConfig() 读 ALS，不依赖调用栈位置。
 *
 * ⚠ 它带下划线前缀，是 LangGraph 的私有字段。用它是【权衡】而不是【洁癖的胜利】：
 * 公开导出里没有第二个跨进程稳定的节点执行身份，而备选（自己数超步）实测会漂。
 * 漂移的代价是缺陷 A/B 静默回归，取不到的代价是当场抛错 —— 所以取不到必须抛，
 * 且下面那句错误信息把「多半是升级改了私有形状」写在第一时间。
 */
import { getConfig } from "@langchain/langgraph";

/**
 * 当前节点执行的重放键。只能在【节点体内】调用（依赖运行中的 runnable 上下文）。
 *
 * 取不到就抛而不是退回「不传键」：不传键等于这一行不参与去重，缺陷 A/B 原样回来，
 * 而且是【静默】回来 —— 没有任何测试会变红（行数与从前一致）。
 */
export function nodeReplayKey(): string {
  const raw = getConfig()?.configurable?.["__pregel_task_id"];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(
      "节点体内取不到 __pregel_task_id（得到 " +
        String(raw) +
        "）。它是中断重放去重唯一的键源，缺了就只能要么写重复审计、要么静默不去重 —— " +
        "两种都比在这里抛错好。多半是 LangGraph 升级改了 configurable 的私有形状。",
    );
  }
  return raw;
}
