/**
 * 最小公司图的【节点 → 预设岗位书】装配（Task 0.10）。
 *
 * 为什么在 src/ 而不是留在测试夹具里：CLI（hub run）与 e2e 测试需要【同一份】装配。
 * 两处各写一份的结局是必然漂移 —— 改了 CLI 的挂载、忘了改测试，于是 e2e 全绿而
 * 真跑起来用的是另一套档位，§5.9 的断言当场失去意义。
 *
 * ⚠ 这里是【按仓库现有模板文件名】挂载。规格附录 B 用的是语义 role_id
 * （test_engineer / tech_director / product_director …），两边不一致已登记为计划
 * §10.2 的 D11、尚未拍板 —— 拍板之前任何代码都不得依赖 role_id 的语义命名，
 * 所以这张表里只出现文件名，不出现"这个节点等于那个语义角色"的断言。
 */
import { fileURLToPath } from "node:url";
import type { Charter, ModelTier } from "@opc/contracts";
import type { CompanyNode } from "../graph/company.js";
import { loadCharterFile } from "./loader.js";

const TEMPLATES_DIR = new URL(
  // src/roles/ → src/ → packages/hub/ ：两层 ../。夹具时代是三层 ../
  //（文件住在 test/graph/fixtures/）。搬文件必须同时核对相对 URL 的层数：
  // 这类错误编译期看不出来，只在运行时炸 ENOENT。
  "../../resources/charter-templates/",
  import.meta.url,
);

/** 节点 → 模板文件名（不含 .yaml）。 */
export const NODE_TO_TEMPLATE: Record<CompanyNode, string> = {
  intake: "assistant",
  charter: "assistant",
  product: "product",
  tech: "tech",
  dev: "dev",
  test: "test",
  report: "ceo",
};

/** 节点用的完整岗位书类型。图按结构化类型取它需要的切面（NodeCharter），
 *  所以这里给整份 Charter，不裁字段 —— 裁过会导致被裁字段在运行时 undefined，
 *  而类型检查（test/ 不在 tsc -b 覆盖范围内）抓不到。 */
export type PresetRoles = Record<CompanyNode, Charter>;

let cached: PresetRoles | undefined;

/**
 * 加载 7 个节点用到的真岗位书（不是内联假数据：假数据会让 §5.9 的档位断言变成
 * "我写的假数据等于我写的假数据"）。
 *
 * 缓存是必需的，不是优化：期望值计算会循环调用 tierOfNode，不缓存就是几十次
 * YAML 读 + zod 校验。
 */
export function loadPresetRoles(): PresetRoles {
  if (cached !== undefined) return cached;
  const out = {} as PresetRoles;
  for (const [node, file] of Object.entries(NODE_TO_TEMPLATE)) {
    out[node as CompanyNode] = loadCharterFile(
      fileURLToPath(new URL(file + ".yaml", TEMPLATES_DIR)),
    );
  }
  cached = out;
  return out;
}

/** 某个节点用的档位（§5.9）。CLI 打印装配、测试算期望序列都读这一处。 */
export function tierOfNode(node: CompanyNode): ModelTier {
  return loadPresetRoles()[node].modelTier;
}
