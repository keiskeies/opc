/**
 * 会话坐标与恢复选路 —— 两处消费者共用的那一份（CLI 与 HTTP 决策落库）。
 *
 * 为什么单独成文件，而且**刻意不 import 任何框架**：这两条判定原本各自长在
 * `cli.ts` 里（`config()` 是个私有函数），而第二个需要它们的调用方在 http 侧。
 * 直接 import cli.ts 会连带把 `@langchain/langgraph`、图、桩模型一起拖进来 ——
 * 那意味着「把一条 CEO 决策写进库」这件事在缺三个装不上的包时【连 import 都做不到】，
 * 于是可离线验证的那一半（条件 UPDATE、审计行、并发抢占）也一起测不了。
 * 把两条与框架无关的判定抽到这里，两侧共用一份判定，而框架留在各自的外壳里。
 *
 * 这也让「复用」这个词是【真的】：不是我在 http 侧照抄一遍 CLI 的逻辑、
 * 注释里写「复用 0006 §1」，而是两处 grep 到同一个函数。
 * 抄一份的漂移方式是「CLI 能恢复、点了批准不恢复」，而两边各自都看着有理由。
 */

/**
 * thread_id 与 task_id 同值，所以不给第二个自由字符串的入口（0006 §4）。
 *
 * 为什么这条值得一个函数而不是让调用方手写那个嵌套字面量：
 * 手写的下一站就是「有人传了一个和 task_id 不同的 thread_id」。两个自由字符串
 * 迟早被传进一对不匹配的值，于是恢复时读的是甲会话的进度、写的是乙任务的审计，
 * 两边还都「看着合理」—— CLI 显式拒绝 --thread 是同一条纪律（0006 §6.2）。
 */
export function threadConfig(taskId: string): { configurable: { thread_id: string } } {
  return { configurable: { thread_id: taskId } };
}

/** 恢复时该喂给 `graph.invoke` 的输入种类。 */
export type ResumeChoice = "command" | "invoke-null";

/**
 * 恢复选路：**先读 checkpoint 再选**，不 try/catch 兜异常（计划 §10.4 第 4 条）。
 *
 * 实测依据（0006 §1）：
 *  - 无中断时喂 `Command({ resume: null })` 抛 "Received empty Command input"；
 *  - 已完成的 thread 上喂 `invoke(null)` 只推进一个空超步 —— events 与节点执行都不增。
 * 两种选错的后果是【静默的不同】：一种当场崩、一种什么都不发生。
 * 「什么都不发生」那一支尤其贵：HTTP 返回 200、卡片显示已批准、任务不动。
 *
 * 这里只回答【该选哪一种】，不构造 Command 对象 —— 构造要 import
 * `@langchain/langgraph`，而那正是本文件存在理由（不带框架）会破掉的地方。
 * 判据与构造分开之后，判据可以被普通单测穷尽，构造那一行留在外壳里。
 */
export function chooseResumeInput(hasInterrupts: boolean): ResumeChoice {
  return hasInterrupts ? "command" : "invoke-null";
}

/**
 * 从一次 `graph.getState()` 的结果里判「有没有待恢复的中断」。
 *
 * 只吃一个 unknown，不 import 框架类型 —— 与上面同样的理由：这一条判据的两侧
 * 消费者（CLI 与 HTTP 决策落库）必须共用一份，而 HTTP 那一侧不能带框架。
 *
 * 【形状不认识就抛】，不静默返回 false。静默 false 会选到 invoke-null 那一支，
 * 后果是「卡片显示已批准、HTTP 返回 200、任务一步都不动」——
 * 与 audit-middleware.ts 的 detectInterrupts 同一条立场：
 * 假设框架私有形状时，静默回退比抛错危险得多。
 */
export function hasPendingInterrupt(state: unknown): boolean {
  if (state === null || typeof state !== "object") {
    throw new Error(
      "graph.getState() 返回的不是对象（得到 " +
        typeof state +
        "），无法判断有没有待恢复的中断。宁可抛错：判错这一条会选错恢复输入，" +
        "而选错的两种后果都是静默的（0006 §1）。",
    );
  }
  const raw = (state as Record<string, unknown>)["interrupts"];
  if (raw === undefined || raw === null) return false;
  if (!Array.isArray(raw)) {
    throw new Error(
      "state.interrupts 不是数组（得到 " +
        typeof raw +
        "）。LangGraph 实测给数组，形状变了必须立刻知道 —— " +
        "静默当成「没有中断」会让批准之后图不动，而 HTTP 返回 200。",
    );
  }
  return raw.length > 0;
}
