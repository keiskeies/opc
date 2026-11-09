/**
 * 契约层：zod schema + 类型，Hub 与前端共用（规格 §5.11：zod 4 是岗位书、
 * 证据包、审批卡片的唯一 schema 来源）。
 *
 * 唯一 schema 来源是设计约束，不是口味：岗位书在前端要能编辑、在 Hub 要能拒载、
 * 在审计里要能回放。三处各写一份校验，最先漂移的一定是「哪条约束真的生效」。
 * 运行时依赖只有 zod —— 不要往这里加带 I/O 的东西，否则前端就欠了一个 Node 运行时。
 */
export const CONTRACTS_PACKAGE_READY = true;

export {
  ACCEPTANCE_ACTIONS,
  CHARTER_PLACEHOLDER_ACCEPTANCE,
  type Charter,
  type CharterInput,
  charterSchema,
  JUDGMENT_MODES,
  MODEL_TIERS,
  type ModelTier,
} from "./charter.js";
