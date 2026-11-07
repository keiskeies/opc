/**
 * 任务状态机（规格 §7.1）—— 跃迁合法性的唯一判定点。
 *
 * 为什么需要一个显式的状态机模块，而不是让节点「想写什么状态就写什么」：
 * events 表是 append-only（§20.4），一条错误的状态跃迁【写进去就永远在那儿】，
 * 无法修正、也无法删除。回放视图会照着这条错误历史重建出一个从未发生过的过程，
 * 而 CEO 看到的「完整审计轨迹」比没有轨迹更糟。所以跃迁必须在【写入之前】被拦。
 *
 * 边表用 Record<TaskState, readonly TaskState[]>：编译期强制 15 个状态【每个都要有条目】。
 * 为什么这比运行时检查强 —— 漏配一个状态会表现为「该状态的所有跃迁都非法」，
 * 任务卡死在某个状态上且没有任何报错指向边表；穷尽性检查把这类问题挡在编译阶段。
 * 死路必须【显式】写成空数组，不能靠漏写表达「没有出路」。
 */

/** §7.1 的 15 个状态，名字逐字照抄规格（改名字 = 改审计历史里的取值，属破坏性变更）。 */
export type TaskState =
  | "CHARTER_PENDING"
  | "CHARTER_APPROVED"
  | "DECOMPOSING"
  | "IN_PROGRESS"
  | "EVIDENCE_SUBMITTED"
  | "IN_REVIEW"
  | "APPROVED_UPWARD"
  | "REJECTED_DOWNWARD"
  | "MEETING_REQUIRED"
  | "ESCALATED_TO_CEO"
  | "BUDGET_PAUSED"
  | "BLOCKED"
  | "FINAL_REVIEW"
  | "DELIVERED"
  | "ARCHIVED";

/**
 * 出边表。每条边右侧标注出处。
 *
 * §7.1 的缩进图只给到 14 条边，其中 APPROVED_UPWARD / ESCALATED_TO_CEO 没有出边 ——
 * 照字面实现，任务一旦进入这两个状态就【永远无法交付】。下面四条「补边」逐条给出依据，
 * 依据全是规格自己的 §7.2 流转示例（文档不能自相矛盾：示例走过的路必须合法）。
 */
const EDGES: Record<TaskState, readonly TaskState[]> = {
  CHARTER_PENDING: ["CHARTER_APPROVED", "FINAL_REVIEW"], // §7.1 766→767；778（顶层任务可直接终审）
  CHARTER_APPROVED: ["DECOMPOSING"], // §7.1 767→768
  DECOMPOSING: ["IN_PROGRESS"], // §7.1 768→769
  IN_PROGRESS: ["EVIDENCE_SUBMITTED"], // §7.1 769→770
  EVIDENCE_SUBMITTED: ["IN_REVIEW"], // §7.1 770→771
  IN_REVIEW: [
    // §7.1 772-777 六个出口，顺序照规格原文
    "APPROVED_UPWARD",
    "REJECTED_DOWNWARD",
    "MEETING_REQUIRED",
    "ESCALATED_TO_CEO",
    "BUDGET_PAUSED",
    "BLOCKED",
  ],
  APPROVED_UPWARD: [
    "IN_PROGRESS", // §7.1 772 括注：「进入下一层级，重复 IN_PROGRESS → APPROVED_UPWARD」
    "ESCALATED_TO_CEO", // 【补边】§7.2 步骤 7→8：有条件通过后升到 CEO
  ],
  REJECTED_DOWNWARD: [
    "IN_PROGRESS", // 【补边】§7.2 打回路径说明：「任务沿边回退到上游重新处理」
  ],
  MEETING_REQUIRED: [], // 规格未给出路（辩论会子图落地时必须补，见测试里同名断言）
  ESCALATED_TO_CEO: [
    "FINAL_REVIEW", // 【补边】§7.2 步骤 8→9：CEO 批准上线后进入交付
  ],
  BUDGET_PAUSED: [], // 规格未给出路（§7.4 预算硬停落地时必须补）
  BLOCKED: [], // 规格未给出路（§7.3 心跳恢复落地时必须补）
  FINAL_REVIEW: ["DELIVERED"], // §7.1 778→779
  DELIVERED: ["ARCHIVED"], // §7.1 779→780
  ARCHIVED: [], // 终态
};

/**
 * 状态清单从边表的键派生，而不是另写一份数组。
 * 两份清单的后果：加状态时改了 union 忘了改这里，TASK_STATES 就少一个成员，
 * 而所有「遍历所有状态」的测试（自环检查就是）会【静默少测一个状态】。
 */
export const TASK_STATES: readonly TaskState[] = Object.freeze(
  Object.keys(EDGES) as TaskState[],
);

function assertKnown(state: TaskState, where: "from" | "to"): void {
  // Object.prototype.hasOwnProperty 而不是 in：状态名来自事件载荷，
  // 传 "constructor" / "toString" 这类原型键时 in 会误判为已知状态。
  if (!Object.hasOwn(EDGES, state)) {
    throw new Error(
      "未知的任务状态（" +
        where +
        "）：" +
        String(state) +
        "。" +
        "取值必须来自规格 §7.1 的枚举；已知状态 " +
        TASK_STATES.length +
        " 个。",
    );
  }
}

/** 某状态的合法出边（冻结副本，调用方改不动边表）。 */
export function legalTransitionsFrom(from: TaskState): readonly TaskState[] {
  assertKnown(from, "from");
  return EDGES[from];
}

/**
 * 跃迁是否合法。未知状态名【抛错】而不是返回 false ——
 * 两者的修法不同：false 意味着「编排写错了」，抛错意味着「状态名根本不认识」。
 * 混在一起会让拼错的枚举值伪装成一次合法的业务拒绝。
 */
export function isTaskTransitionLegal(from: TaskState, to: TaskState): boolean {
  assertKnown(from, "from");
  assertKnown(to, "to");
  return EDGES[from].includes(to);
}

/**
 * 写事件前的闸门。报错文案必须带上【该状态当前能写什么】：
 * 只说「非法跃迁」的报错没有可操作性，而这条路径将来会被 agent 自己踩到 ——
 * 它得能从报错里直接看出正确的下一步。
 */
export function assertTaskTransition(
  from: TaskState,
  to: TaskState,
): TaskState {
  assertKnown(from, "from");
  assertKnown(to, "to");
  if (EDGES[from].includes(to)) return to;
  const outs = EDGES[from];
  throw new Error(
    "非法的任务状态跃迁：" +
      from +
      " → " +
      to +
      "（规格 §7.1）。" +
      from +
      " 的合法出口：" +
      (outs.length === 0
        ? "（无 —— 该状态在当前跃迁表里是死路）"
        : outs.join(", ")) +
      "。events 表是 append-only，这条跃迁一旦写下去就无法修正。",
  );
}
