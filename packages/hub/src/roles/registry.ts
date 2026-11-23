/**
 * 旧 COMPANY_NODES 的只读兼容层（T4）：图谱节点的 charter 从 roles 表读，缺省回退 preset。
 *
 * ── 这一格补的是哪一种分裂 ──────────────────────────────────────────
 * 引擎（graph/company.ts）至今仍按七个固定节点装配（COMPANY_NODES），而 D9 把
 * 角色换成了 roles 表（0011）。两边的 role_id 词表【本来就不一致】：
 * preset 模板按文件名走（assistant/product/tech/dev/test/ceo），0011 种子按
 * D11 语义 id 走（cos/product_director/tech_director/dev/qa/boss）。
 * 只重叠一个 dev。若图谱继续读 preset，CEO 在角色表里改的档位与岗位书
 * 对引擎【一个字节都不生效】—— 屏幕上一套、跑起来另一套，本仓最贵那一类缺陷。
 *
 * ── 映射表为什么写死在这里而不是数据里 ──────────────────────────────
 * COMPANY_NODES 是编译期常量（状态通道、条件边、崩溃夹具全按它生成），
 * roles 表里没有一列叫 engine_node —— 加这么一列等于宣称「引擎节点可配置」，
 * 而引擎今天不可配置（图形状写死在 company.ts）。写死一张七格表是【当前
 * 真实边界】的表达；哪天图可配置了，删这张表的正是那次改造本身。
 *
 * ── 回退语义（计划 T4 原话「缺省回退 preset」）─────────────────────
 * 行缺失或 charter_json 为 NULL ⇒ 该节点用 preset 模板。这不是兜底装饰：
 * 0011 全部种子的 charter_json 都是 NULL（岗位书要 CEO 亲自签，0008 §7 的
 * 代笔边界），所以【今天每个节点都走回退】—— 测试钉的就是这条现状，
 * 而不是一个理想态。行存在且带岗位书 ⇒ 用库里的，roleId 取 D11 语义 id。
 *
 * ⚠ roleId 语义 id 会改变 askModel 提示串里的一格（assistant→cos 等）与
 * 审计里的 actor_id 显示。字节稳定族测试（e2e-linear / foreign-model-loop）
 * 继续显式用 loadPresetRoles()：它们钉的是「同库重放逐字节一致」，
 * 角色来源由测试自己指定；生产装配（cli.ts）从这里取【库里当前】的角色。
 */
import type { DatabaseSync } from "node:sqlite";
import type { Charter } from "@opc/contracts";
import { assertCharterShape } from "../charter/store.js";
import type { CompanyNode, NodeCharter } from "../graph/company.js";
import { loadPresetRoles } from "./preset.js";

/**
 * 引擎节点 → D11 语义 role_id（0011 种子的键）。
 * intake 与 charter 共用 cos：两个节点干的是同一份岗位书的两个动作
 * （接待归位 / 立项签书），0011 没有给「接待」单开一行 —— 挂两行会让
 * 通讯录里凭空多一个从不接活的岗位。report → boss：终审席就是人类锚点
 * （D1 老板只拍板；档位上 boss 是 management，与 preset 的 ceo 模板同档）。
 */
export const NODE_TO_ORG_ROLE: Record<CompanyNode, string> = {
  intake: "cos",
  charter: "cos",
  product: "product_director",
  tech: "tech_director",
  dev: "dev",
  test: "qa",
  report: "boss",
};

type RoleCharterRow = { charter_json: string | null };

const SELECT_CHARTER_SQL = "SELECT charter_json FROM roles WHERE role_id = ?";

/**
 * 图谱装配用的角色表（buildCompanyGraph 的 roles 入参）。
 *
 * 档位取【生效岗位书的 modelTier】而不是 roles.model_tier 列：两列今天恒等
 * （validateCharterDraft 不校验档位一致性，见 service.ts 文件头那条已登记缺口），
 * 但引擎历史上吃的就是 Charter.modelTier（preset 时代）—— 保持同一来源，
 * 否则「roles 表改了档、岗位书没改」的中间态里引擎按哪边跑会成为一个新问题。
 */
export function rolesFromOrg(
  db: DatabaseSync,
): Record<CompanyNode, NodeCharter> {
  const preset = loadPresetRoles();
  const out = {} as Record<CompanyNode, NodeCharter>;
  for (const [node, roleId] of Object.entries(NODE_TO_ORG_ROLE) as [
    CompanyNode,
    string,
  ][]) {
    const row = db.prepare(SELECT_CHARTER_SQL).get(roleId) as
      | RoleCharterRow
      | undefined;
    let charter: Charter | undefined;
    if (row?.charter_json !== null && row?.charter_json !== undefined) {
      // 读侧守门与 charter/store.ts 同一函数：库里读坏的形态【抛】而不是静默回退 ——
      // 行明明存在且带 JSON，解析却坏了，那是数据异常；静默换 preset 会让
      // 「CEO 签的岗位书没生效」以一次正常运行出面。
      charter = assertCharterShape(roleId, JSON.parse(row.charter_json));
    }
    const effective = charter ?? preset[node];
    out[node] = { modelTier: effective.modelTier, roleId };
  }
  return out;
}
