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

export {
  type BundleType,
  BUNDLE_TYPES,
  type EvidenceArtifact,
  type EvidenceBundle,
  type EvidenceClaim,
  evidenceBundleSchema,
  HANDOFF_BUNDLE_TYPES,
  isExternalSourceRef,
  requiredBundleType,
  SHA256_RE,
  unresolvableClaimIndexes,
  UUID_RE,
} from "./evidence.js";

export {
  type ApprovalButton,
  APPROVAL_BUTTONS,
  type ApprovalCardDraft,
  approvalCardDraftSchema,
  type EscalationReason,
  ESCALATION_REASONS,
  type GateDecision,
  GATE_DECISIONS,
  type RiskTier,
  RISK_TIERS,
  type TimeoutBehavior,
  TIMEOUT_BEHAVIORS,
} from "./gates.js";

export {
  type ApiEndpoint,
  API_ENDPOINTS,
  approvalOutcome,
  type ApprovalDecisionRequest,
  approvalDecisionRequestSchema,
  type ApprovalOutcome,
  type ApprovalStatusValue,
  APPROVAL_STATUS_PENDING,
  APPROVAL_STATUS_VALUES,
  type ApprovalView,
  approvalViewSchema,
  createTaskRequestSchema,
  type CreateTaskRequest,
  decodeSseFrame,
  encodeSseFrame,
  type FeedItemView,
  feedItemSchema,
  HTTP_NOT_FOUND,
  HTTP_NOT_IMPLEMENTED,
  HTTP_UNAUTHORIZED,
  HTTP_UNPROCESSABLE,
  IMPLEMENTED_ENDPOINTS,
  isImplemented,
  GIVE_UP_AFTER_ATTEMPTS,
  MAX_IDEA_CHARS,
  reconnectDelayMs,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  type ResumeValue,
  RESUME_VALUES,
  shouldGiveUp,
  type SseFrame,
  type TaskView,
  taskViewSchema,
  UNIMPLEMENTED_ENDPOINTS,
} from "./api.js";

/**
 * 组织图数据层与三层校验（Task 3.1）。两个模块【分开导出】而不是揉成一个
 * `export * from "./org/index.js"`：org/ 下目前只有 graph 与 validate 两个文件，
 * 加一层 barrel 会让人以为还有第三个入口。分开导出同时让
 * 「谁只用了原语、没用校验」在 import 那一行上可见（Task 3.2 的前端只用校验）。
 */
export {
  canReach,
  CEO_ROLE_ID,
  depthOf,
  getDescendants,
  type DelegationEdge,
  delegationEdgeSchema,
  nodeOf,
  ORG_MAX_DEPTH,
  type OrgGraph,
  orgActorSchema,
  type OrgActor,
  orgChangeSchema,
  type OrgChange,
  orgGraphSchema,
  type OrgNode,
  orgNodeSchema,
  pathToRoot,
  reportsToCycle,
} from "./org/graph.js";

export {
  type NeedsConfirmation,
  rejectMalformed,
  type RejectCode,
  type RunningTasksInput,
  validateNewEdge,
  validateOrgChange,
  validateReparenting,
  type Verdict,
  violatesNoSelfReview,
  wouldExceedMaxDepth,
} from "./org/validate.js";

/**
 * Harness Gateway 契约（Task 5.1，规格 §12）。单独一节而不是并进上面：
 * 这一层的读者只有 hub（适配器与门控），前端今天不读它 —— 但类型仍必须放 contracts，
 * 因为 `harness_call` 审计事件的载荷要能被回放页读到（§12.7 第四层）。
 */
export {
  type ApprovalHandler,
  type ApprovalPolicy,
  APPROVAL_POLICIES,
  type CostReport,
  costReportSchema,
  type ExecutionResult,
  executionResultSchema,
  type ExperimentalHarnessId,
  EXPERIMENTAL_HARNESS_IDS,
  type HarnessAdapter,
  type HarnessCapabilities,
  harnessCapabilitiesSchema,
  type HarnessDefaultEntry,
  harnessDefaultEntrySchema,
  HARNESS_ID_ALIASES,
  type HarnessEvent,
  type HarnessEventKind,
  HARNESS_EVENT_KINDS,
  type HarnessId,
  HARNESS_IDS,
  harnessDefaultsFor,
  type HarnessOutcome,
  harnessOutcomeSchema,
  type HarnessRequest,
  type HarnessRequestInput,
  harnessRequestSchema,
  type SandboxTier,
  SANDBOX_TIERS,
  type ToolApprovalDecision,
  type ToolApprovalRequest,
} from "./harness.js";
