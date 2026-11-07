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
