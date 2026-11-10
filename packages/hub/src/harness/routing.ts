/**
 * 程序员 Agent 的任务路由（计划 Task 5.3，【规格】§12.4 双轴 + §12.5 分段流程）。
 *
 * ── 双轴是什么，以及为什么必须有第二轴 ──────────────────────────────
 * 【规格】§12.4 那张表的行是**任务类别**（功能 / 缺陷 / 重构 / 实验），
 * 而它的输入里还有一句容易被读过去的话：「风险等级（**架构师评审时标记**）」。
 * 也就是同一类任务可以有两个方向相反的风险档，而【规格】§12.4 那张表**没有**给出
 * 风险轴改变什么。这一层就是补那一格的，口径只有一条：
 *
 *   **风险轴只能收紧，永远不能放松。**（`riskTightens`，见那里）
 *
 * 为什么这一条值得单独钉：不加它的话，「风险低」是一个很自然的优化方向
 * （「这个 bug 很小，就别 read-only 先分析一遍了，直接改」），
 * 而那次优化拿掉的是【缺陷修复流程的第 2 段】—— 【规格】§12.5 那段流程存在的理由
 * 恰恰是「程序员 Agent 不自行判断根因是否正确」。一个能让被约束者自己声明
 * 「这次风险低」的双轴，等于把双轴退化成单轴。
 *
 * ── 本模块**不**决定「用哪一家」的偏好顺序 ─────────────────────────
 * 【规格】§12.4 表里那一列（Claude / Codex / Kimi）在这里是**候选清单 + 硬过滤**，
 * 不是排序：候选由调用方（岗位书 + 已接入的适配器）交出，本模块只负责
 * 「这台适配器能不能满足这个 plan 的硬要求」。**满足不了的 ⇒ 拒，而不是挑一个次优的**
 * —— 与 gateway 那条「能力不符 ⇒ 拒绝而不是降级」同源，理由在 capabilityGap 那里已经写过。
 *
 * ── prevention 在这里从「事后记录」变成「事前硬约束」（0021 §6 预告的那一步）──
 * `prevention` 在 Task 5.2 只是审计里的一格。这一层开始**用它做决定**：
 * 一段可能碰不可逆工具的 stage 不得被派给一家「我们问不到它」的适配器
 * （`toolApproval=false` ⇒ 整场没有否决权 ⇒ prevention 只能是 observed_only）。
 * 这一条不新写判据，**直接调 safety.ts 的 `preventionFor`**（同一份口径，
 * 两处各写一份 ternary 会得出「审计里写 enforced 而路由当初按 observed_only 判」）。
 *
 * ── 路由给的是**上限**，不是授权 ────────────────────────────────────
 * 最容易在这里犯的错与 0021 §1 那两处自比同一个形状：如果 `grantedSandbox` 与
 * `req.sandbox` 都由这一层查同一张表得到，gateway 那条「档位不得提级」就在路由来的请求上
 * 结构性地永不触发。所以这里分成两个值交出去（见 `RoutePlan.charterCeiling` 与
 * `RouteStage.sandbox`）：
 *   · `charterCeiling` —— **岗位书**给的上限（调用方从 harness_defaults 读出来交给路由）；
 *   · `stage.sandbox` —— 这一段想用的档位。
 * 路由对二者的关系**不静默夹取**而是**拒**（`charter_tier_below_stage`）：
 * 静默降档会得到一个「跑完了而什么都没改」的任务，那是 0021 §3 记过的
 * 「一条写不通的收紧，最后换来的是一次放松」的同一条账 —— 宁可现在炸。
 */
import {
  type ApprovalPolicy,
  type HarnessCapabilities,
  type HarnessId,
  type RiskTier,
  type SandboxTier,
  SANDBOX_TIERS,
} from "@opc/contracts";
import { preventionFor, toolRiskTier } from "./safety.js";

/**
 * 任务类别，逐字对应【规格】§12.4 那四行。
 * 值用英文而表里是中文：这个值要进审计与路由表配置，中文值在 shell 与 YAML 里
 * 都是给自己找麻烦（而 §12.4 的原话在下面的 `CATEGORY_DEFAULTS` 注释里逐行引着）。
 */
export const TASK_CATEGORIES = [
  "feature",
  "bugfix",
  "refactor",
  "experimental",
] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

/**
 * 一段（stage）。【规格】§12.5 把缺陷修复切成段，而**分段是本模块唯一的强判据来源**：
 * 「只读段不许写」这种话在整次调用层面没法判，只能在段层面判。
 *
 * 五个取值里 `report` 也在内，看着多余（上报不发 harness 调用），但它存在理由是
 * 【规格】§12.5 第 6 条那句「程序员 Agent 不能自己标记完成」——
 * 那是一段**要出现在计划里、因而要被人看见**的事，不是一句「然后上报」的旁白。
 * 一个不在计划里的步骤是一个没人会去检查有没有做的步骤。
 */
export const ROUTE_STAGES = [
  "precheck",
  "analyze",
  "reproduce",
  "implement",
  "verify",
  "report",
] as const;
export type RouteStageId = (typeof ROUTE_STAGES)[number];

/**
 * 这一段由谁跑。**这一维是【规格】§8.2 第 1 条「作者不给自己打分」在路由层的落点。**
 *
 * 为什么要在路由层表达而不是只在门控层判：门控（graph/gates/author-reviewer.ts）判的是
 * 「产出出来后谁审」，而它拿到的是**已经跑完的结果**。如果 `verify` 这一段从一开始就
 * 由作者自己发起，那门控要拦的东西已经花掉了预算、已经写进了事件流。
 * 路由层拦一次 = 那一次调用根本不发生。**同一条纪律在两个层次上各拦一次不是重复**：
 * 一层拦「结论算不算」，一层拦「这次调用该不该由你发起」。
 */
export type StageExecutor = "author" | "independent";

export interface RouteStage {
  readonly id: RouteStageId;
  readonly sandbox: SandboxTier;
  readonly approvalPolicy: ApprovalPolicy;
  /**
   * 只读段 ⇒ 这一段里**任何**非只读动作都是违规（【规格】§12.5 第 2 段那句「不修改文件」）。
   * 判据在 `stageWriteViolation`，它读的是 safety 的 `toolRiskTier`，与审批同一个判据。
   */
  readonly readOnly: boolean;
  readonly executor: StageExecutor;
  /** 【规格】§12.4 重构那一行的「在**独立分支**运行，不直接改主干」。 */
  readonly independentBranch: boolean;
  /** 人话：这一段为什么要这么配（进审计与配置页，不能只给一个档位值）。 */
  readonly why: string;
}

export const ROUTE_REJECT_CODES = [
  "charter_tier_below_stage",
  "no_candidate",
  "prevention_gap",
  "experimental_not_enabled",
  "no_workspace",
] as const;
export type RouteRejectCode = (typeof ROUTE_REJECT_CODES)[number];

export type RouteResult =
  | { ok: true; plan: RoutePlan }
  | { ok: false; code: RouteRejectCode; reason: string };

export interface RouteCandidate {
  readonly id: HarnessId;
  readonly capabilities: HarnessCapabilities;
}

export interface RouteInput {
  readonly taskId: string;
  readonly roleId: string;
  readonly category: TaskCategory;
  /** 架构师评审时标的风险档（【规格】§12.4 的第二轴）。 */
  readonly risk: RiskTier;
  readonly workspace: string;
  /**
   * **岗位书**给这一家的沙箱上限（`harness_defaults.<id>.sandbox`）。
   * 必填，理由见文件头那段：这是被比侧，给默认值就等于把「档位不得提级」
   * 在路由来的请求上变成结构性的空判据。
   */
  readonly charterCeiling: SandboxTier;
  readonly charterForbiddenFlags: readonly string[];
  readonly allowedTools: readonly string[];
  /** 已接入的适配器 + 它的声明。顺序即偏好（调用方按【规格】§12.4 那一列排）。 */
  readonly candidates: readonly RouteCandidate[];
  /**
   * 【规格】§12.4 第四行（实验性 → Kimi Code）那一行的开关。**默认关**。
   * 关的理由不是保守，是类型：`HarnessAdapter.id` 是 `HarnessId`（三家），
   * `kimi-code` 在 `EXPERIMENTAL_HARNESS_IDS` 里，**今天根本没有这样的适配器**，
   * 路由把它选出来只会让调用方在装配处撞类型或撞运行时。
   * 打开它等于「我知道我在把一个任务派给一个尚未接入的执行器」。
   */
  readonly allowExperimental?: boolean;
  /** 期望的模型家族（透传给请求；真正的独立性判定在门控读结果那一格）。 */
  readonly modelFamily?: string;
}

export interface RoutePlan {
  readonly taskId: string;
  readonly roleId: string;
  readonly category: TaskCategory;
  readonly risk: RiskTier;
  readonly harnessId: HarnessId;
  readonly stages: readonly RouteStage[];
  readonly charterCeiling: SandboxTier;
  readonly charterForbiddenFlags: readonly string[];
  readonly allowedTools: readonly string[];
  readonly workspace: string;
  readonly modelFamily: string | undefined;
  /**
   * 这一段计划**要求**的否决权。`required: "enforced"` 而选中那一家只能给
   * `observed_only` ⇒ 上面那个 `prevention_gap` 已经把它拒了，所以
   * **成功的 plan 里这两个值必然一致**。这条不变量钉成用例（见 routing.test.ts），
   * 因为「要求」与「实际」悄悄分叉是本模块最像成功的失败。
   */
  readonly preventionRequired: "enforced" | "observed_only";
  /**
   * 选出来的那一家能给什么。**口径要读准，它与审计里那一格不是同一个粒度**：
   * 这里是**计划级**（这批段里最需要否决权的那些段，实际拿到的是什么），
   * 而 gateway 记的 `harness_call.prevention` 是**单次调用级**（那一次请求的
   * `approval_policy` 算出来的）。两者会在一种情况下取到不同的值：
   * 风险档 = irreversible 时，写段被抬到 on-request（⇒ 那一次记 enforced）
   * 而只读段照旧 never（⇒ 那一次记 observed_only）。
   *
   * 这不是不一致，而是两个问题需要两个粒度：审计那一格问「**那一次**我们有没有否决权」，
   * 这一格问「**这份计划**该有否决权的那些段有没有」。我把差别写在这里而不是让它们
   * 同名同形，因为「读代码的人会把两个同名字段当成同一个」这条我在 0021 §8 已经付过一次学费。
   */
  readonly prevention: "enforced" | "observed_only";
}

/**
 * 【规格】§12.4 那张表的机器形状。逐行对照（原话在每行注释里）：
 *
 *  · 新功能实现 → `workspace-write` + 审批 never，但 **diff 必须经测试门控**
 *      ⇒ 那一行的后半句就是 `verify` 这一段 executor: "independent"，
 *        它**不是**注释，是路由产出的一个步骤。
 *  · 缺陷修复（P1/P2）→ **先 read-only 分析根因，再 workspace-write 修复**
 *      ⇒ 两段，两段之间由测试 Agent 独立复现（§12.5 第 3 步）夹着。
 *  · 重构 / 技术债 → workspace-write，**独立分支**
 *      ⇒ `independentBranch: true`，由 `branchIsOnMain` 判（见那里）。
 *  · 实验性 / 低风险 → 自动批准，但**外层必须拦截不可逆操作**
 *      ⇒ 允许 observed_only，代价见 `experimental` 那一段的注释。
 *
 * ⚠ 这张表**只回答「这一类任务默认怎么走」**，它不是授权表。
 * 能改这些取值的只有【规格】§12.4 本身（也就是 CEO），不是某一次的运行时参数 ——
 * 所以它不是 `RouteInput` 的一个字段（做成字段就等于交给调用方）。
 */
const CATEGORY_DEFAULTS: Readonly<
  Record<TaskCategory, { stages: readonly RouteStage[]; why: string }>
> = {
  feature: {
    why:
      "【规格】§12.4「新功能实现：workspace-write + 审批 never，但 diff 必须经测试门控」。" +
      "never 管的是车间内的自主（§12.8），而『diff 必须经测试门控』被实现成一个 " +
      "independent 的 verify 段，不是一句口头约定。",
    stages: [
      {
        id: "implement",
        sandbox: "workspace-write",
        approvalPolicy: "never",
        readOnly: false,
        executor: "author",
        independentBranch: false,
        why: "写代码要 workspace-write；不可逆动作由第 3 层单独拦，不靠这里的 approval_policy。",
      },
      {
        id: "verify",
        sandbox: "workspace-write",
        approvalPolicy: "never",
        readOnly: false,
        executor: "independent",
        independentBranch: false,
        why:
          "§12.4 那一行的后半句『diff 必须经测试门控』。跑测试要写临时产物 ⇒ workspace-write；" +
          "但**发起方必须是测试角色**（§8.2 第 1 条）。",
      },
    ],
  },
  bugfix: {
    why:
      "【规格】§12.5 那六步。这里的段是计划 Task 5.3 的 Test 项原话那五段：" +
      "只读分析 → 复现验证 → 修复 → 测试独立验证 → 上报。",
    stages: [
      {
        id: "analyze",
        sandbox: "read-only",
        approvalPolicy: "never",
        readOnly: true,
        executor: "author",
        independentBranch: false,
        why:
          "§12.5 第 2 步『分析（只读）…不修改文件』。这一段是**根因假设**的生产环节，" +
          "一旦允许写，『先看清问题再动手』这句话就没有实现点了。",
      },
      {
        id: "reproduce",
        sandbox: "workspace-write",
        approvalPolicy: "never",
        readOnly: false,
        executor: "independent",
        independentBranch: false,
        why:
          "§12.5 第 3 步『测试 Agent 独立构造复现用例』。写用例要能写；" +
          "**必须由独立角色发起** —— 作者自己构造的复现用例天然是为『能过』而写的。",
      },
      {
        id: "implement",
        sandbox: "workspace-write",
        approvalPolicy: "never",
        readOnly: false,
        executor: "author",
        independentBranch: false,
        why: "§12.5 第 4 步『修复（受限写入）』。受限 = 工作区 + 档位 + 白名单，不是不写。",
      },
      {
        id: "verify",
        sandbox: "workspace-write",
        approvalPolicy: "never",
        readOnly: false,
        executor: "independent",
        independentBranch: false,
        why: "§12.5 第 5 步 + §12.6 第 2 条：独立跑测试，且**不读开发角色的自评文本**（Task 5.4）。",
      },
      {
        id: "report",
        sandbox: "read-only",
        approvalPolicy: "never",
        readOnly: true,
        executor: "author",
        independentBranch: false,
        why:
          "§12.5 第 5-6 步『证据包组装 → 提交测试门控』，且『程序员 Agent 不能自己标记完成』。" +
          "列为只读段是因为组装证据包不该改任何东西 —— 而这一段一旦允许写，" +
          "『顺手改一下让它过』就有了发生的地方，那正是 §12.6 不可信输入要防的。",
      },
    ],
  },
  refactor: {
    why:
      "【规格】§12.4『重构 / 技术债：workspace-write，要求 harness 在**独立分支**运行，" +
      "不直接改主干；产出重构前后对比与行为等价性证据』。",
    stages: [
      {
        id: "analyze",
        sandbox: "read-only",
        approvalPolicy: "never",
        readOnly: true,
        executor: "author",
        independentBranch: false,
        why: "『重构前后对比』要求**动手之前**先有一份基线，而基线必须在只读下取。",
      },
      {
        id: "implement",
        sandbox: "workspace-write",
        approvalPolicy: "never",
        readOnly: false,
        executor: "author",
        independentBranch: true,
        why: "独立分支是这一行的硬要求（见 branchIsOnMain）。",
      },
      {
        id: "verify",
        sandbox: "workspace-write",
        approvalPolicy: "never",
        readOnly: false,
        executor: "independent",
        independentBranch: false,
        why: "『行为等价性证据』由独立角色出（§12.4 那一行 + §8.2 第 1 条）。",
      },
    ],
  },
  experimental: {
    why:
      "【规格】§12.4『实验性 / 低风险：自动批准，但外层必须拦截不可逆操作』。" +
      "这一行是四行里唯一**接受 observed_only**（没有否决权）的，" +
      "它凭什么成立见下面那条 stage 的注释。",
    stages: [
      {
        id: "implement",
        sandbox: "workspace-write",
        approvalPolicy: "never",
        readOnly: false,
        executor: "author",
        independentBranch: false,
        why:
          "自动批准（never）+ 一家可能没有审批回调的执行器 ⇒ 我们整场可能一次否决权都没有。" +
          "这一行之所以还敢放行，唯一理由是**第 3 层不看 approval_policy**" +
          "（safety.ts 的 needsApproval：能由被调用方的一个参数关掉的安全层不是安全层）" +
          "⇒ 不可逆动作照样会被拦并在审计里点名。但『拦得住』在 observed_only 下" +
          "只是『看得见』，所以风险档一旦是 irreversible 就直接拒" +
          "（`prevention_gap`），这一行只承接低风险 —— 这正是 §12.4 那一行名字里" +
          "『低风险』那三个字的实现。",
      },
    ],
  },
};

/** 类别 → 段计划（只读，且**不含**任何调用方可以改的东西）。 */
export function stagesFor(category: TaskCategory): readonly RouteStage[] {
  return CATEGORY_DEFAULTS[category].stages;
}

/**
 * 风险轴怎么收紧。**只有一条作用**：不可逆档 ⇒ 把 approvalPolicy 抬到 on-request。
 *
 * 为什么只有这一条而不再动别的（比如「risk=read_only 就跳过 verify 段」）——
 * 因为放松的那一半迟早会被写进来，而它每一次都是在削【规格】§8.2 / §12.5 的步骤。
 * 这一层的立场是：**风险档不能删步骤**。要删步骤请改【规格】§12.4 那张表（= CEO 的事）。
 *
 * 抬到 on-request 还有一个副作用要写清：它同时把这一家的 `prevention` 从 observed_only
 * 抬成 enforced 的**必要条件**摆到台面上（`preventionFor` 读 policy），
 * 于是「风险不可逆 + 这家没有审批回调」变成一次**路由期拒绝**，
 * 而不是运行时一次没人看见的自动批准。
 */
function riskTightens(stage: RouteStage, risk: RiskTier): RouteStage {
  // ⚠ 这一支的存在只为了一件事：**别让只读段也去问人**。
  // 我第一版写的是「risk=irreversible ⇒ 每一段都抬到 on-request」，
  // 而注释里写的却是「只读段不抬」—— 注释承诺了实现没有的性质，
  // 那比注释缺失更坏（本仓在 evidence/store.ts 的 sha256File 上踩过同一次）。
  // 实际后果不是抽象的：一次风险被标成 irreversible 的缺陷修复会得到
  // 一张「可以 read 这个文件吗」的审批卡片（§9 开头的北极星是八成审批由规则自动决定，
  // 而这张卡片既不可自动决定也不该有人答）。
  if (risk !== "irreversible" || stage.readOnly) return stage;
  if (stage.approvalPolicy === "on-request") return stage;
  return {
    ...stage,
    approvalPolicy: "on-request",
    why:
      stage.why +
      " 【风险档 = irreversible ⇒ 审批策略被抬到 on-request（风险轴只收紧不放松），" +
      "并把『这台适配器必须有审批回调』变成路由期的硬要求】",
  };
}

/**
 * 这一段是否要求「我们真的能停下来问人」。
 *
 * 两个条件在 `riskTightens` 之后**其实是同一个**（只收紧会把非只读段抬成 on-request），
 * 而我仍然两个都判，理由与 0021 §8 那条「两个维度不共用词表」同源：
 * 只判 `approvalPolicy` 的话，这条判据的含义变成「**有人配了** on-request 才要否决权」，
 * 于是把风险档标成 irreversible 而忘了策略也会跟着走的那个人，
 * 会拿到一个「策略是 never ⇒ 不需要否决权」的计划。两个条件写在一起，
 * 判据的含义才是它本来的意思：**这批段可能碰不可逆动作 ⇒ 必须有否决权**。
 * 冗余的一侧不是浪费，是那条含义的第二份证词。
 */
function requiresEnforced(stage: RouteStage, risk: RiskTier): boolean {
  return risk === "irreversible" || stage.approvalPolicy === "on-request";
}

/**
 * 双轴路由。返回段计划 + 选中的适配器，或者**一次点名到该改哪一格的拒绝**。
 *
 * 拒绝的三个出口对应三件不同的事，刻意不合成一个「路由失败」：
 *   · `charter_tier_below_stage` —— 任务要写的东西**超出岗位书授权** ⇒ 改岗位书或换类别；
 *   · `no_candidate` / `prevention_gap` —— 接入面不满足 ⇒ 换适配器或接入那一家；
 *   · `experimental_not_enabled` —— 有人要把任务派给尚未接入的实验性执行器。
 * 前两类是配置问题，第三类是**开关没打开**，把三者混成一个码，
 * 配置页就只能回一句「路由不了」，而当事人要改的是三个完全不同的地方。
 */
export function routeTask(input: RouteInput): RouteResult {
  if (input.workspace.trim() === "") {
    return {
      ok: false,
      code: "no_workspace",
      reason:
        "路由不出一个没有工作区的任务。工作区决定【能改哪里的东西】，" +
        "空工作区会让后面每一次越界判定都拿空串比 —— 那等于没有边界。",
    };
  }
  const defaults = CATEGORY_DEFAULTS[input.category];
  // 风险轴逐段收紧（不是整份计划一个开关：只读段没有「更不可逆」这回事，
  // 给它 on-request 只会让审批队列里多出一张「读这个文件可以吗」的卡片）。
  const stages: RouteStage[] = defaults.stages.map((s) => riskTightens(s, input.risk));

  const ceilingViolation = stageExceedsCeiling(stages, input.charterCeiling);
  if (ceilingViolation !== undefined) {
    return {
      ok: false,
      code: "charter_tier_below_stage",
      reason:
        "任务类别 [" +
        input.category +
        "] 的第 " +
        (stages.indexOf(ceilingViolation) + 1) +
        " 段 [" +
        ceilingViolation.id +
        "] 需要 [" +
        ceilingViolation.sandbox +
        "]，而岗位书给这一家的上限是 [" +
        input.charterCeiling +
        "]。**刻意不做静默降档**：降到上限会得到一个『跑完了而什么都没改』的任务" +
        "（写操作全被沙箱挡掉，产出看起来正常而 diff 是空的），" +
        "那比现在拒掉更难查。修法二选一：改岗位书 harness_defaults 的 sandbox（要升 version 走审计），" +
        "或把这个任务改成不需要写的那一类。",
    };
  }

  // 实验性这一支排在**所有候选判定之前**，这是个刻意的顺序：
  // kimi 那一行今天没有适配器，所以它必然同时命中『没有合格候选』；
  // 先判开关，报错才说得出真正的原因（『这个开关没打开』而不是『找不到适配器』，
  // 后者会把人引去接一家根本没打算接的执行器）。
  if (input.category === "experimental" && input.allowExperimental !== true) {
    return {
      ok: false,
      code: "experimental_not_enabled",
      reason:
        "类别 experimental 对应【规格】§12.4 的第四行（实验性 → Kimi Code），" +
        "而它今天**没有适配器**：`HarnessAdapter.id` 的类型是 HarnessId（claude-code / codex / qoder），" +
        "kimi-code 在 EXPERIMENTAL_HARNESS_IDS 里，路由把它选出来只会让调用方在装配处撞类型。" +
        "确实要把任务派给一个尚未接入的执行器，就显式传 allowExperimental: true —— " +
        "传这个字段的含义是『我知道它在今天跑不起来』。",
    };
  }

  const needEnforced = stages.some((s) => requiresEnforced(s, input.risk));
  if (input.candidates.length === 0) {
    return {
      ok: false,
      code: "no_candidate",
      reason:
        "没有候选适配器可选。这个任务类别是 [" +
        input.category +
        "]，风险档 [" +
        input.risk +
        "]。路由**不会**为了出结果而编一个适配器 —— " +
        "没有接入任何执行器时，正确的结论是『这个任务今天没人能干』，" +
        "而不是产出一份跑不起来的计划。",
    };
  }

  // 只有**需要**否决权的那一次才把它当硬要求。风险档是 read_only / reversible 时
  // 一个 toolApproval=false 的候选是可以用的（那正是【规格】§12.4 第四行
  // 「自动批准」那一行存在的方式）—— 而把这条判据写成无条件硬过滤，
  // 会得到『低风险任务也路由不出去』，那是把双轴的第二轴做丢了。
  // 过滤而不是排序：第一个满足硬要求的候选胜出，顺序是调用方给的偏好
  // （【规格】§12.4 那一列）。跳过不合格者而不是拒整个路由，是因为
  // 「Claude 没接上而 Codex 接上了」是常态而不是异常。
  const chosen = input.candidates.find((c) => {
    const capsOk = !needEnforced || preventionFor(c.capabilities, "on-request") === "enforced";
    return capsOk;
  });
  if (chosen === undefined) {
    const why = stages
      .filter((s) => requiresEnforced(s, input.risk))
      .map((s) => s.id)
      .join(", ");
    return {
      ok: false,
      code: "prevention_gap",
      reason:
        "风险档 [" +
        input.risk +
        "] 让段 [" +
        why +
        "] 需要**真的能停下来问人**的执行器（prevention 必须是 enforced），" +
        "而候选里每一家都给不了：\n  - " +
        input.candidates
          .map(
            (c) =>
              c.id +
              " toolApproval=" +
              c.capabilities.toolApproval +
              " ⇒ prevention=" +
              preventionFor(c.capabilities, "on-request"),
          )
          .join("\n  - ") +
        "\n刻意**不挑一个『聊胜于无』的**：在一家不会问我们的执行器上，" +
        "『暂停并推到审批队列』这句话是空的，而我们连它有没有执行都不知道。" +
        "修法：接入一家有审批回调的执行器，或把这个任务的风险档由架构师评审重新标低。",
    };
  }

  // 这里【曾经多一段映射】：「选中的那一家没有审批回调时，把 on-request 段降回 never」。
  // 它是**不可达代码**，而它是本文件一路在防的那个形状 —— 一段看起来在做安全判断、
  // 实际永远走不到的分支：上面的 needEnforced 判据是「任一段是 on-request ⇒ 需要 enforced」，
  // 而候选过滤已经要求「需要 enforced ⇒ 必须有 toolApproval」，
  // 所以「有 on-request 段」与「选中的那家没有 toolApproval」**不可能同时成立**。
  // 留着它的后果不是多几行：下一个人会以为路由有一条「降级适应」的路，
  // 而真要有那条路， prevention_gap 那条拒绝就得同时被拆掉。
  // 现在这两个值在成功路径上必然一致，而那条不变量被钉成用例（routing.test.ts 那条 ⭐）。
  return {
    ok: true,
    plan: {
      taskId: input.taskId,
      roleId: input.roleId,
      category: input.category,
      risk: input.risk,
      harnessId: chosen.id,
      stages,
      charterCeiling: input.charterCeiling,
      charterForbiddenFlags: input.charterForbiddenFlags,
      allowedTools: input.allowedTools,
      workspace: input.workspace,
      modelFamily: input.modelFamily,
      preventionRequired: needEnforced ? "enforced" : "observed_only",
      prevention: preventionFor(
        chosen.capabilities,
        needEnforced ? "on-request" : "never",
      ),
    },
  };
}

function stageExceedsCeiling(
  stages: readonly RouteStage[],
  ceiling: SandboxTier,
): RouteStage | undefined {
  const ci: number = SANDBOX_TIERS.indexOf(ceiling);
  // 上限本身不认识 ⇒ 视为【最低】（一个写错的岗位书档位名不该让任何任务都能跑），
  // 而这条**不会**被这里拒绝：它由 gateway 的 sandboxTierBlock 报
  // `sandbox_tier_unknown`（那一层已经有『不知道就该停下来问，不能替它挑一个档位』的口径）。
  // 本层不重复判，是因为重复的两侧一旦漂移，就会出现「路由放行而 gateway 拒」这种
  // 看起来像随机故障的组合。
  if (ci < 0) return stages.find((s) => SANDBOX_TIERS.indexOf(s.sandbox) > 0);
  return stages.find((s) => SANDBOX_TIERS.indexOf(s.sandbox) > ci);
}

/* ═════════════════ 段闸门：只读段不许写 ═════════════════ */

export const STAGE_GATE_CODES = [
  "write_in_read_only_stage",
  "main_branch_write",
  "independent_stage_by_author",
] as const;
export type StageGateCode = (typeof STAGE_GATE_CODES)[number];

export type StageGateVerdict =
  | { ok: true }
  | { ok: false; code: StageGateCode; reason: string };

/**
 * 一次**已经被观测到**的工具调用是否违反它所在那一段的约束。
 *
 * 这条判据是【规格】§12.5 第 2 段那句话唯一的实现点，而它必须与审批同源：
 * 「什么算写」这个问题在 safety.ts 里已经有一份答案（`toolRiskTier`），
 * 这里不重答一遍。方向也是同一份 —— 认不出的工具名落 irreversible ⇒ 在只读段里就是违规。
 *
 * ⚠ 这一条与 gateway 的沙箱档位判定**不重复**，别看起来像：
 * `--sandbox read-only` 是**交给 harness 去执行**的（safety.ts 文件末「挡不住什么」
 * 第 3 条：harness 侧档位实现有 bug 时本层看不见）。这一段闸门判的是
 * **事件流里观测到的那一发**，所以它是外层那一份。两层各自的失效方向不同：
 * 沙箱失效 ⇒ harness 真改了东西（这一段会看到那一发 tool_call 并中止）；
 * 这一段失效 ⇒ 东西被改了而审计里没有任何一处说它越了段。
 */
export function stageWriteViolation(
  stage: RouteStage,
  o: { readonly tool: string; readonly args: unknown; readonly executor?: StageExecutor },
): StageGateVerdict {
  if (stage.readOnly) {
    const tier: RiskTier = toolRiskTier({ tool: o.tool, args: o.args });
    if (tier !== "read_only") {
      return {
        ok: false,
        code: "write_in_read_only_stage",
        reason:
          "只读段 [" +
          stage.id +
          "] 里出现了一次判定为 [" +
          tier +
          "] 的工具调用 [" +
          o.tool +
          "]，按【规格】§12.5『分析段不修改文件』中止这一段。" +
          "口径与审批用的是同一个函数（safety.ts 的 toolRiskTier），" +
          "所以『审批说可逆而这一段说只读』这种不一致结构上不可能出现；" +
          "认不出的工具名一律按不可逆算 ⇒ 违规（宁可打断一段分析，" +
          "也不要『分析阶段偷偷改了文件而没人知道』）。",
      };
    }
  }
  // §8.2 第 1 条在调用发起前那一次拦截（文件头说过它与门控层那次不是重复）。
  if (stage.executor === "independent" && o.executor === "author") {
    return {
      ok: false,
      code: "independent_stage_by_author",
      reason:
        "段 [" +
        stage.id +
        "] 要求由**独立角色**发起（【规格】§8.2 第 1 条 / §12.6 第 2 条），" +
        "而调用方声明发起方就是作者本人。门控层那道同样的判定审的是**产出之后**，" +
        "而到这里已经花掉了预算、写进了事件流；那两次拦不是重复，一次拦结论算不算、" +
        "一次拦这次调用该不该由你发起。",
    };
  }
  return { ok: true };
}

/**
 * 【规格】§12.4 重构那一行的「不直接改主干」。
 *
 * 只认名字而不查 git：这一层不碰文件系统（与 safety.ts 同一立场，纯判定才装配得起来）。
 * `main` / `master` 之外的那些名字（`release/*`、`trunk`）**故意不列**：
 * 它们是不是主干是各仓约定，我离线状态**没有任何一处能核验**，
 * 而把它列进来会得到「在一个我们认不出主干的仓里放行重构」。
 * 所以口径是「认得出的主干 ⇒ 拒」，而认不出 ⇒ 交回白名单与岗位书
 * （`merge_to_main` 在 dev 岗位书的 forbidden_actions 里，那是另一层兜）。
 */
export function branchIsOnMain(branch: string): boolean {
  const b: string = branch.trim().toLowerCase();
  return b === "main" || b === "master";
}

export function branchViolation(
  stage: RouteStage,
  branch: string,
): StageGateVerdict {
  if (!stage.independentBranch) return { ok: true };
  if (!branchIsOnMain(branch)) return { ok: true };
  return {
    ok: false,
    code: "main_branch_write",
    reason:
      "段 [" +
      stage.id +
      "] 要求在独立分支运行（【规格】§12.4 重构那一行『不直接改主干』），" +
      "而当前分支是 [" +
      branch +
      "]。这里只认 main / master 两个名字，其余主干形状（release/*、trunk）" +
      "我不假装认得 —— 列一条我核验不了的约定，会换来『在那个仓里照样放行』。",
  };
}

/* ═════════════════ 段 → 请求（让这份计划真的能被 gateway 执行） ═════════════════ */

/**
 * 把一段翻成 `HarnessRequest` 的**策略部分**。
 *
 * 为什么要有这个函数而不是让调用方自己拼：plan 里的 `sandbox` / `approvalPolicy` /
 * `allowedTools` / `charterForbiddenFlags` 就是这次调用的策略，
 * 而调用方手拼时最容易丢的恰好是 `forbiddenFlags` —— 它是【规格】§20.2
 * 「运行时只能收窄」里**必须逐次交出**的那一份（gateway 拿它跟基线比才能判「有没有缩短」）。
 * 一次漏传不是少一条保护：`forbiddenFlags: []` 会让第 4 层的**命中**那一支照旧生效
 * （请求侧那份是空的 ⇒ 没有任何开关会被拦），而**缩短**那一支照样拦得住 ——
 * 于是这条判据在漏传时看起来是绿的。
 *
 * ⚠ 它**只**产策略，不产 instruction / requestedArgs（那两样只有当事人知道）。
 * 也没有产 `resumeSessionId`：恢复是**调用方的决定**（打回时恢复上下文，【规格】§12.5 末段），
 * 做成这个函数的参数就会有人把它默认填上。
 */
export function requestPolicyFor(
  plan: RoutePlan,
  stage: RouteStage,
): {
  workspace: string;
  sandbox: SandboxTier;
  approvalPolicy: ApprovalPolicy;
  allowedTools: readonly string[];
  forbiddenFlags: readonly string[];
} {
  return {
    workspace: plan.workspace,
    sandbox: stage.sandbox,
    approvalPolicy: stage.approvalPolicy,
    // 只读段**再收一次**白名单：沙箱档位是交给 harness 执行的（本层看不见它有没有生效），
    // 而白名单是**我们**判的。两道都用上才叫「与 harness 原生权限叠加」（【规格】§12.7 表头）。
    allowedTools: stage.readOnly ? readOnlyTools(plan.allowedTools) : plan.allowedTools,
    forbiddenFlags: plan.charterForbiddenFlags,
  };
}

/**
 * 只读段的白名单收窄。**判据是「名字里带写的那个动词」而不是「查一张写工具表」**：
 * 名单来自岗位书，是**人写的字符串**（【规格】§4.1.3 的 `"Bash(git:*)"` 那种形状），
 * 一张固定表永远追不上它。取反（把 edit/write/delete/push/commit… 这些动词剔掉）
 * 的**失效方向是安全的**：误剔 ⇒ 那一段少一个工具（跑不通，会报错），
 * 而误留 ⇒ 那一段真能写（静默越段）。两侧代价不对称，所以宁可少留。
 *
 * `Bash` **不在**剔除名单里，这是这里唯一一处刻意的宽松，所以钉住：
 * `Bash(git:*)` 在只读段里是「跑 git status / git diff」的正解，
 * 剔掉它等于做不出【规格】§12.5 第 1 步那句「预检：`git status`」。
 * 兜住它的是 `stageWriteViolation`（那一条会读**参数**并判 `rm -rf` 为不可逆 ⇒ 违规）。
 */
const WRITE_VERB = /(edit|write|delete|remove|create|add|patch|apply|push|commit|merge|deploy|move|rename)/u;

export function readOnlyTools(tools: readonly string[]): string[] {
  return tools.filter((t) => !WRITE_VERB.test(t.toLowerCase()));
}
