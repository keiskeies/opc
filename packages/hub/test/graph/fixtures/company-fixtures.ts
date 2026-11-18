/**
 * e2e 测试的共享夹具（Task 0.8）。
 *
 * 存在的理由只有一条：崩溃续跑测试要在**另一个进程**里跑同一个图 —— 子进程脚本
 * 路径、子进程 cwd、以及"测试怎么起子进程"都是测试侧的东西。
 *
 * 【节点 → 岗位书】与【桩模型】原先也住在这里，Task 0.10 把它们搬进 src/
 * （src/roles/preset.ts、src/graph/stub-model.ts）：CLI 与测试必须用同一份装配，
 * 两处各写一份必然漂移，届时 §5.9 的档位断言测的是 A 套、跑的是 B 套。
 */
import { fileURLToPath } from "node:url";
import type { CompanyNode } from "../../../src/graph/company.js";
import type { TaskState } from "../../../src/graph/status.js";
import { tierOfNode } from "../../../src/roles/preset.js";

/** 崩溃子进程脚本（run-child.ts 起的就是它）。 */
export const CHILD_SCRIPT = fileURLToPath(
  new URL("./e2e-crash-child.ts", import.meta.url),
);

/** packages/hub 根，子进程的 cwd。换到别的目录 @langchain/core 就解析不到
 *  （pnpm 严格布局：它只在 packages/hub 的 deps 里）。 */
export const HUB_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * 一个节点在一趟完整执行里调用模型的次数。dev / test 因回退各两次，其余一次。
 * 这个数必须和 EXPECTED_TRACE 里"dev 出现两次"同源 —— 两处若各写一份，
 * 改回退次数时一定只改一处。
 *
 * 【留在测试而不进 src 的理由】：这是测试自己算期望值用的假设，不是生产语义。
 * 搬进 src 会让"图本来该跑几次"看起来像是图定义的属性，而它其实是"这一条用例里
 * 桩怎么配"的函数。
 */
export function runsOfNode(node: CompanyNode): number {
  return node === "dev" || node === "test" ? 2 : 1;
}

/** 节点档位（转出去只为让测试读起来短一点；唯一实现在 src/roles/preset.ts）。 */
export { tierOfNode };

/**
 * 桩图【应当】产生的那条 §7.1 状态边序列，顺序即图应当产生的顺序。
 *
 * ── 为什么从 e2e-linear 搬到这里 ────────────────────────────────
 * 这条路线的长度原先手抄在【六处】：e2e-linear 的三处 + cli/smoke 的 countEvents
 * 四处（14 / 28 / 15 / 14 / 14）。把 report 从「四条边直冲到 ARCHIVED」改成
 * 「停在 ESCALATED_TO_CEO」时，这六处全部要跟着动，而其中任何一处漏改都是
 * 一条【看着像回归】的红。本文件文件头写的正是这条理由（「两处若各写一份，
 * 改回退次数时一定只改一处」），只是当时只管了 runsOfNode 那个数。
 *
 * ── 为什么停在 ESCALATED_TO_CEO，以及为什么这份期望【不该】再长回 14 ──
 * report 原先一次超步写四条边，其中 ESCALATED_TO_CEO→FINAL_REVIEW 与
 * FINAL_REVIEW→DELIVERED 那两条在 HUMAN_EDGES 里的 why 分别是「CEO 批准上线」
 * 与「终审通过，交付」—— 桩替 CEO 批了两次，而这两条会进 append-only 的 events 表。
 * 现在停在 ESCALATED_TO_CEO（agent 能走的那一格的终点），后面三条边由人点一次
 * 批准产生。守卫在 test/arch/stub-terminal-write.ts：它把 HUMAN_EDGES 的落点当
 * 「人坐的格子」，桩的写点落进去一条就红。所以这份期望如果被人加长到跨过
 * FINAL_REVIEW，红的是那条守卫，不是这里 —— 那正是想要的耦合方向。
 *
 * charter 那一格（CHARTER_PENDING→CHARTER_APPROVED）仍然是桩直通，
 * 已作为【已知越权】登记在守卫的 BASELINE 里，由 O4/O5 的门控收。
 */
export const EXPECTED_STUB_TRACE: readonly [TaskState, TaskState][] = [
  ["CHARTER_PENDING", "CHARTER_APPROVED"], // charter：章程提案获批（0.8 无门控，见上）
  ["CHARTER_APPROVED", "DECOMPOSING"], // product：接手拆解
  ["DECOMPOSING", "IN_PROGRESS"], // tech：进入执行
  ["IN_PROGRESS", "EVIDENCE_SUBMITTED"], // dev#1：交证据
  ["EVIDENCE_SUBMITTED", "IN_REVIEW"], // test#1：入审
  ["IN_REVIEW", "REJECTED_DOWNWARD"], // test#1：桩判不通过 → 打回
  ["REJECTED_DOWNWARD", "IN_PROGRESS"], // 【§7.2 补边】沿边交回开发
  ["IN_PROGRESS", "EVIDENCE_SUBMITTED"], // dev#2：再交证据
  ["EVIDENCE_SUBMITTED", "IN_REVIEW"], // test#2：入审
  ["IN_REVIEW", "APPROVED_UPWARD"], // test#2：通过
  ["APPROVED_UPWARD", "ESCALATED_TO_CEO"], // 【§7.2 补边】上报，然后【停】
];

/** 桩一趟跑完该留下的状态边条数。计数类断言都从它算，不再写死。 */
export const STUB_EDGES = EXPECTED_STUB_TRACE.length;

/** 桩跑完之后任务该停的那一格。 */
export const STUB_STOP_STATE: TaskState = "ESCALATED_TO_CEO";

/**
 * 把已提交的 events 行解码成状态机轨迹。
 *
 * 读 payload 而不是 target：payload 是 recorder 写的【事件本体】，target 是它的派生
 * 摘要。只断言 target 的话，"payload 与 target 不一致"这类缺陷就测不出来。
 */
export function traceFromRows(
  rows: Record<string, unknown>[],
): [string, string][] {
  return rows.map((r) => {
    const e = JSON.parse(String(r.payload)) as { from?: unknown; to?: unknown };
    if (typeof e.from !== "string" || typeof e.to !== "string") {
      throw new Error("events 行缺少 from/to：" + JSON.stringify(r));
    }
    return [e.from, e.to];
  });
}
