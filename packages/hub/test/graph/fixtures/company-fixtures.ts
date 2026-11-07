/**
 * e2e 测试的共享夹具（Task 0.8）。
 *
 * 存在的理由只有一条：崩溃续跑测试要在**另一个进程**里跑同一个图。
 * 岗位书映射与桩模型若各写一份，子进程跑的就不是被测路径 ——
 * 「已完成节点不重复执行」会退化成自我确认。
 */
import { fileURLToPath } from "node:url";
import type { Charter, ModelTier } from "@opc/contracts";
import type { CompanyNode } from "../../../src/graph/company.js";
import { loadCharterFile } from "../../../src/roles/loader.js";

const TEMPLATES_DIR = new URL(
  "../../../resources/charter-templates/",
  import.meta.url,
);

/** 崩溃子进程脚本（run-child.ts 起的就是它）。 */
export const CHILD_SCRIPT = fileURLToPath(
  new URL("./e2e-crash-child.ts", import.meta.url),
);

/** packages/hub 根，子进程的 cwd。换到别的目录 @langchain/core 就解析不到
 *  （pnpm 严格布局：它只在 packages/hub 的 deps 里）。 */
export const HUB_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * 节点 → 模板文件名。
 *
 * 这是【按仓库现有模板文件名】挂载。规格附录 B 用的是语义 role_id
 * （test_engineer / tech_director / product_director …），两边不一致已登记为
 * 计划 §10.2 的 D11、未拍板 —— 所以在拍板之前，e2e 不得依赖 role_id 的语义命名，
 * 这里因此只出现文件名，不出现任何"这个节点等于那个语义角色"的断言。
 */
const NODE_TO_TEMPLATE: Record<CompanyNode, string> = {
  intake: "assistant",
  charter: "assistant",
  product: "product",
  tech: "tech",
  dev: "dev",
  test: "test",
  report: "ceo",
};

/**
 * 返回【完整 Charter】而不是裁成 { modelTier }。
 *
 * 教训（实测）：曾经只取 modelTier，于是图里 roles.intake.roleId 是 undefined，
 * 一路传到 SQLite 参数绑定才炸 —— 而 tsc -b 不覆盖 test/ 目录，类型不一致躲过了编译。
 * 岗位书夹具就给出岗位书本身，图需要什么切面由图的参数类型（NodeCharter）自己约束。
 */
export type LoadedRoles = Record<CompanyNode, Charter>;

let cached: LoadedRoles | undefined;

/**
 * 加载节点用的真岗位书（不是内联假数据：假数据会让 §5.9 的档位断言失去意义 ——
 * 断言就变成"我写的假数据等于我写的假数据"）。
 *
 * 缓存是必需的，不是优化：tierOfNode 会在期望值计算里被循环调用，
 * 不缓存就是几十次 YAML 读 + zod 校验，测试慢且没人会注意到为什么慢。
 */
export function loadRoles(): LoadedRoles {
  if (cached !== undefined) return cached;
  const out = {} as LoadedRoles;
  for (const [node, file] of Object.entries(NODE_TO_TEMPLATE)) {
    const c = loadCharterFile(
      fileURLToPath(new URL(file + ".yaml", TEMPLATES_DIR)),
    );
    // 存【整份 charter】。上一版这里写 { modelTier: c.modelTier } 而类型声明是 Charter，
    // 于是 roleId 在运行时是 undefined —— 类型是 as 断言换来的，等于自欺。
    out[node as CompanyNode] = c;
  }
  cached = out;
  return out;
}

export function tierOfNode(node: CompanyNode): ModelTier {
  return loadRoles()[node].modelTier;
}

/**
 * 一个节点在一趟完整执行里调用模型的次数。dev / test 因回退各两次，其余一次。
 * 这个数必须和 EXPECTED_TRACE 里"dev 出现两次"同源 —— 两处若各写一份，
 * 改回退次数时一定只改一处。
 */
export function runsOfNode(node: CompanyNode): number {
  return node === "dev" || node === "test" ? 2 : 1;
}

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
