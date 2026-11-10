/**
 * 测试 Agent 的独立验证（计划 Task 5.4，【规格】§12.4 / §12.6 / §23.1 Phase 1）。
 *
 * ── 这一层要挡的那一件事只有一句 ────────────────────────────────────
 * 【规格】§12.6 末段：程序员的证据包里若写着「我已覆盖所有边界条件」，
 * 测试 Agent 的岗位书要求它**忽略该文本**，转而用自己的测试用例去验证。
 * 这在代码层不是一句「提示词里提醒一下模型」—— 提示词是一次可以被改写的输入，
 * 而 §8.2 的立场是门控不依赖任何一方的自觉。所以这一层的实现方式是：
 * **作者写过的文本根本不进这次调用的入参**（`stripSelfReported` 是兜底，不是主判据）。
 *
 * ── 独立性有四维，缺任何一维都只是「看起来独立」 ────────────────────
 *   1 工作区   —— 不同目录，且不是作者的子目录（`independentWorkspace`）
 *   2 会话     —— 不同 session_id（否则审阅者拿到的是作者的上下文与自我印象）
 *   3 模型家族 —— 不同家族（§5.9 第 1 条 / §24 风险 1，同家族判断高度相关）
 *   4 否决权   —— 审阅这一侧必须是 enforced（**这一维是我第一版漏掉的**，见 §下）
 * 第 1、2 维是本模块独有的；第 3 维**不重新实现**，直接调
 * `graph/gates/author-reviewer.ts` 的 `sameFamilyReviewBlock`
 * （两份「什么算同源」的判据必然漂移 —— 0020 记过同一类错，而这次漂的一侧在安全侧）。
 *
 * ── 本模块**不产** artifacts 的 sha256 ──────────────────────────────
 * `assemble` 是一个由调用方交出的回调。理由不是省事：**制品哈希必须来自真实文件**，
 * 我离线拼一个哈希就是**编造证据**。0020 §4 已经抓到过一次「契约允许一个字段过内存
 * 而库里没列」；那一条是留痕缺失，这一条如果我自己填，是**造假**，严重一个量级。
 * 于是本模块只填**它自己知道**的那几格（产出者身份、包类型、任务号），
 * 内容性的一律由调用方从真实产物算出来。
 */
import type {
  ExecutionResult,
  EvidenceArtifact,
  EvidenceBundle,
  Charter,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessRequest,
} from "@opc/contracts";
import { harnessRequestSchema, SHA256_RE } from "@opc/contracts";
import { randomUUID } from "node:crypto";
import type { AuditRow } from "../events/recorder.js";
import {
  evaluateGate,
  metricCriteriaEvaluator,
  type CriteriaEvaluator,
  type GateCriterion,
  type GateVerdict,
} from "../graph/gates/evaluate.js";
import {
  type Party,
  sameFamilyReviewBlock,
} from "../graph/gates/author-reviewer.js";
// 【规格】§13.3 第 1 层的那一侧。方向是 harness → search（search 只回依赖 graph 的类型），
// 所以这一格不会成环；`search/policy.ts` 也不 import harness 里的任何东西。
import { observeSearchCalls, toObservedSearches, type SearchObservation } from "../search/observe.js";
import { charterMandatoryDomains, makeSearchCriteriaEvaluator } from "../search/policy.js";
import {
  callHarness,
  type GatewayDeps,
  type GatewayOutcome,
} from "./gateway.js";
import { preventionFor } from "./safety.js";
import type { RouteStage } from "./routing.js";

/** 审阅方的身份（比 `Party` 多一个会话身份 —— 那一维是这一层独有的）。 */
export interface VerifierParty extends Party {
  readonly sessionId: string;
}

/**
 * 拒绝码。**每一条都必须有一个返回点** —— 那份列表由下面那条用例逐条核对
 * （「码表里有码而代码永不返回」的码表会让人以为某条防线存在，而它一次也不会触发）。
 * 曾有四个（no_workspace_suffix / author_workspace_unbounded / no_criteria / no_result）
 * 写在这里而没有返回点，删掉了：前两个的判定其实由 `independentWorkspace` 抛错承担，
 * `no_criteria` 归 evaluateGate（它自己报「空标准 ⇒ reject」，我不该抢），
 * `no_result` 归 gateway。
 */
export const VERIFY_REJECT_CODES = [
  "same_workspace",
  "nested_workspace",
  "same_role",
  "same_session",
  "empty_session",
  "same_model_family",
  "unknown_model_family",
  "approval_by_author",
  "verifier_not_enforced",
  "bad_artifact",
  "verifier_call_failed",
] as const;
export type VerifyRejectCode = (typeof VERIFY_REJECT_CODES)[number];

/* ═════════════════ 第 1 维：独立工作区 ═════════════════ */

/**
 * 审阅目录的默认根。**刻意不是** `/.verify` 那种「长在作者仓库里面」的形状。
 *
 * 这一格我第一版写的是 `<作者工作区>/.verify/<taskId>`，而它与自己旁边的
 * `nested_workspace` 判据直接冲突：派生出来的目录**必然**是作者工作区的子目录，
 * 于是 `verifyFix` 拒掉了自己发起的每一次调用。修的时候有两个方向可以走
 * （把嵌套判据放宽，或者把派生挪出去），选后者的理由不是「测试想要哪个」，
 * 是一条**权限**上的不对称（【规格】§12.7 第 2 层的口径）：
 *
 *   作者的 sandbox 是 workspace-write，写范围就是作者工作区。
 *   审阅目录如果长在里面，作者**有权**往审阅目录里放东西 ——
 *   那「独立工作区跑出来的结果」就是一份作者能预先写入的材料，第一维等于没有。
 *
 * 所以默认根必须落在作者写不到的地方。`/tmp` 的代价写在下面那条用例里
 * （机器重启会清、多用户机器上它也可被别人写），要换由调用方交 `verifyRoot`。
 */
export const DEFAULT_VERIFY_ROOT = "/tmp/opc-verify";

/**
 * 派生审阅用的工作区。
 *
 * 为什么带 taskId 而不是一个随机后缀：审阅要能对**同一个 diff** 复跑，
 * 目录得能被事后找回（回放里指得回那次跑的东西）；随机目录 = 事后找不回 =
 * 回放里指不回那次审阅。而 taskId 必须是那一个：两个任务共用一个审阅目录
 * ⇒ 后一次看见前一次的残留产物 ⇒「独立工作区」变成了「上一次审阅的工作区」。
 *
 * ⚠ 这一维最容易被写成「换个路径字符串」而实际不成立，所以判据全在
 * `independenceBlock` 里，而不是在这里：调用方完全可以自己传一个工作区进来，
 * 派生函数只是**默认值**。真正拦人的是那几条。本函数只保证**形状**。
 */
export function independentWorkspace(
  taskId: string,
  root: string = DEFAULT_VERIFY_ROOT,
): string {
  const base: string = root.replace(/\/+$/u, "");
  if (base === "" || !base.startsWith("/")) {
    // 抛错而不是返回一个相对路径：相对路径的审阅目录会跟 cwd 走，
    // 于是「独立工作区」在两个目录下意味着两个不同的东西（gateway 对 workspace
    // 必须是绝对路径说的是同一件事）。
    throw new Error(
      "派生审阅工作区需要**绝对路径**的根，实到 [" +
        root +
        "]。刻意不退回「./verify」这种相对形状：那会让审阅目录随 cwd 变。",
    );
  }
  if (taskId.trim() === "") {
    throw new Error(
      "派生审阅工作区需要 taskId，实到空。刻意不用随机后缀兜底：审阅产物必须能被找回，" +
        "否则『独立工作区跑过』这句话在审计里指不回任何东西。",
    );
  }
  return base + "/" + taskId.trim();
}

/* ═════════════════ 四维独立性的总判据 ═════════════════ */

export type IndependenceVerdict =
  | { ok: true }
  | { ok: false; code: VerifyRejectCode; reason: string };

/**
 * 独立性总判据。**在发起调用之前**跑的那一遍（`preCall` 那几条）。
 *
 * 顺序：先判**结构性**的（同一目录 / 同一角色），再判**能力**的（enforced）。
 * 反过来的话，一份配置错的岗位书 + 一次复用作者目录的调用只会报「能力不符」，
 * 而当事人要修的第一件事其实是工作区 —— 报错要给最近的那一层（与 safety.ts 那四层同一条理由）。
 */
export function independenceBlock(o: {
  readonly author: Party;
  readonly verifier: Party;
  readonly authorWorkspace: string;
  readonly verifierWorkspace: string;
  /** 发起前就知道的那一侧的能力与策略（审阅这一侧）。 */
  readonly verifierCaps: HarnessCapabilities;
  readonly verifierApprovalPolicy: "never" | "on-request";
  /** 同家族审阅所需的 CEO 批准（与门控层同一份凭据形状）。 */
  readonly sameFamilyApproval?: { readonly approvedBy: string; readonly reason: string };
  readonly stage: "pre_call" | "post_call";
}): IndependenceVerdict {
  const a = o.authorWorkspace.replace(/\/+$/u, "");
  const v = o.verifierWorkspace.replace(/\/+$/u, "");
  if (a === v) {
    return {
      ok: false,
      code: "same_workspace",
      reason:
        "审阅方与产出方用同一个工作区 [" + v + "]，拒绝发起。" +
        "【规格】§12.6 第 2 条要的是『在隔离工作区调用独立 harness 实例』：" +
        "同一个目录里审阅方看到的是作者**已经改过**的东西，" +
        "它跑出来的『通过』审的是作者的状态而不是产物本身。",
    };
  }
  // 子目录也算同一侧。这一条不是洁癖：`/repo` 与 `/repo/.verify` 是两条不同的字符串，
  // 只比 `!==` 会放行一个「审阅目录长在作者工作区里面」的配置，
  // 而那时审阅方仍能读到作者写的每一个文件 —— 第一维等于没有。
  if (v.startsWith(a + "/") || a.startsWith(v + "/")) {
    return {
      ok: false,
      code: "nested_workspace",
      reason:
        "审阅工作区 [" + v + "] 与作者工作区 [" + a + "] 互为嵌套，拒绝发起。" +
        "『不同路径』不等于『隔离』：内含的那一侧能被另一侧读到底，" +
        "而 §12.6 要的是读不到作者状态。修法是把审阅目录放到 /tmp/… 或仓库外。",
    };
  }
  if (o.author.roleId === o.verifier.roleId) {
    return {
      ok: false,
      code: "same_role",
      reason:
        "审阅者与产出者是同一角色 [" + o.author.roleId + "]（【规格】§8.2 第 1 条）。" +
        "这一条在门控层也判一次，那不是重复：门控拦的是**结论算不算**，" +
        "这里拦的是**这次审阅该不该发起** —— 走到门控时预算已经花掉、事件流已经写下。",
    };
  }
  if (o.stage === "pre_call") {
    // ⚠ 这一维是我第一版**完全漏掉**的那一维，而它漏得很自然：
    // 独立性讲的是「谁在看」，而「看的那一家会不会被我们问到」看起来是另一个话题。
    // 它其实是同一件事：审阅方的结论要能变成一次拦下，靠的是我们**有权不让它继续**。
    // 一家 toolApproval=false 的执行器上，审阅方跑出来的「不通过」只能事后记账 ——
    // 那正是 0021 §6 给 `observed_only` 下的定义。
    // 所以一次「审阅」如果跑在 observed_only 上，它是一次**观察**，不是一次**验证**。
    const p = preventionFor(o.verifierCaps, o.verifierApprovalPolicy);
    if (p !== "enforced") {
      return {
        ok: false,
        code: "verifier_not_enforced",
        reason:
          "审阅调用被配置在 prevention=" + p + " 的执行器上，拒绝发起。" +
          "『独立验证』与『独立观察』的区别就在这一格：审阅方发现 P0 时我们得有能力" +
          "不让这件事继续往下走，而 toolApproval=false 的适配器整场不会问我们一次。" +
          "修法：审阅这一侧换一家有审批回调的执行器，或把 approval_policy 设成 on-request。",
      };
    }
    return { ok: true };
  }
  // 事后那一遍判**只有事后才知道**的那一维（实际模型家族）。
  // 会话那一维**不在**这里：它有自己的函数 `sessionIndependenceBlock`，理由写在那里 ——
  // 并进来会得到一个「某些分支只在某个 stage 生效」的判据，调用方读不出哪些条件现在生效。
  const fam = sameFamilyReviewBlock(
    { roleId: o.author.roleId, modelFamily: o.author.modelFamily },
    { roleId: o.verifier.roleId, modelFamily: o.verifier.modelFamily },
    o.sameFamilyApproval,
  );
  if (!fam.ok) {
    return {
      ok: false,
      code: fam.code === "unknown_model_family" ? "unknown_model_family"
        : fam.code === "approval_by_author" ? "approval_by_author"
        : "same_model_family",
      reason:
        fam.reason +
        "（【规格】§5.9 第 1 条 / §24 风险 1；判据**复用**门控层那一份，" +
        "本模块不写第二份『什么算同源』）",
    };
  }
  return { ok: true };
}

/**
 * 会话身份必须不同（第 2 维，只有事后才知道）。
 *
 * 为什么不并进 `independenceBlock`：`pre_call` 那一次两侧会话都还不存在
 * （审阅方的会话是它跑起来才有的）。并进一个函数就会得到一个「某些分支只在某个
 * stage 生效」的判据，而那种函数的调用方**读不出**哪些条件现在生效 ——
 * 分成两个函数，每个的条件都在它自己的签名里。
 */
export function sessionIndependenceBlock(
  authorSessionId: string,
  verifierSessionId: string,
): IndependenceVerdict {
  const a = authorSessionId.trim();
  const v = verifierSessionId.trim();
  if (a === "") {
    return {
      ok: false,
      code: "empty_session",
      reason:
        "产出方没有 session_id，无法判定审阅是否换了会话。刻意不当成『不同会话』：" +
        "空串与任何值都不相等，于是【缺失】会伪装成【独立性成立】—— " +
        "这是本仓一路在防的那一族（缺信息必须落到有人来判，不能落到放行）。",
    };
  }
  if (v === "") {
    return {
      ok: false,
      code: "empty_session",
      reason: "审阅方没有 session_id，同上。",
    };
  }
  if (a === v) {
    return {
      ok: false,
      code: "same_session",
      reason:
        "审阅与产出用的是同一个会话 [" + a + "]，拒绝采信审阅结论。" +
        "同一个会话意味着审阅方拿到的是作者**自己的上下文**（含它自己那份『已经测过了』），" +
        "§12.6 那句『不复用开发 Agent 的会话与结论』讲的就是这一维 —— " +
        "换目录不换会话，得到的是同一个 agent 换个地方重跑一遍。",
    };
  }
  return { ok: true };
}

/* ═════════════════ 不可信输入（§12.6 末段） ═════════════════ */

/**
 * 作者自报的完成声明。命中即**不进**审阅调用。
 *
 * 口径与 `policy/engine.ts` 那三张表一样是**子串表**，理由也一样：
 * 要求产出方自报「这句是不是我的完成声明」等于让被约束者自证清白。
 * 表只加不减（同一条维护规则）。
 *
 * ⚠ 这一条是**兜底**，主判据是 `verifyFix` 的入参形状：那里根本没有地方放作者的文本。
 * 之所以还留一个函数，是因为真实装配里调用方会从任务上下文里带一堆东西过来，
 * 一个「顺手把 dev 的证据包传进去看看」的写法迟早会出现。
 */
export const SELF_REPORTED_PATTERNS: readonly string[] = [
  "自测通过",
  "本地跑过",
  "已通过所有测试",
  "测试都过了",
  "我已覆盖",
  "已经覆盖所有边界",
  "tests pass",
  "all tests passed",
  "self_test_passed",
  "self_reported_completion",
];

export interface StripResult {
  readonly kept: readonly string[];
  readonly dropped: readonly { readonly text: string; readonly matched: string }[];
}

export function stripSelfReported(texts: readonly string[]): StripResult {
  const kept: string[] = [];
  const dropped: { text: string; matched: string }[] = [];
  for (const t of texts) {
    const low: string = t.toLowerCase();
    // 双向包含（与 engine.ts 的 matchForbidden 同一口径）：
    // 「dev 说：自测通过」这种【包着】的写法，只判 includes(pattern) 能命中；
    // 而条目被写成一句长话时（"self_reported_completion 不可信"）要反过来判。
    const hit: string | undefined = SELF_REPORTED_PATTERNS.find(
      (p: string): boolean => low.includes(p.toLowerCase()) || p.toLowerCase().includes(low),
    );
    if (hit === undefined) kept.push(t);
    else dropped.push({ text: t, matched: hit });
  }
  return { kept, dropped };
}

/* ═════════════════ 编排：跑一次独立验证并出门控结论 ═════════════════ */

export interface VerifyInput {
  readonly taskId: string;
  readonly author: { readonly roleId: string; readonly modelFamily: string; readonly sessionId: string };
  /**
   * 作者的工作区。**只用来比对**，不用来派生审阅目录。
   *
   * 这个区分是修 `nested_workspace` 那次自相矛盾时落下来的：如果审阅目录由它派生，
   * 作者就能在自己的写范围里预定审阅方的输入（见 `independentWorkspace` 上方那段）。
   */
  readonly authorWorkspace: string;
  /** 审阅目录的根，默认 `/tmp/opc-verify`；生产上应指到作者账号写不到的挂载点。 */
  readonly verifyRoot?: string;
  /** 审阅用哪家（能力决定第 4 维）。 */
  readonly adapter: HarnessAdapter;
  readonly verifierRoleId: string;
  /** 审阅这一段的指令（**由调用方按 §12.6 写**，本模块不代写提示词）。 */
  readonly instruction: string;
  /** 审阅段的档位与审批策略；来自路由的 verify 段。 */
  readonly stage: RouteStage;
  readonly allowedTools: readonly string[];
  readonly forbiddenFlags: readonly string[];
  readonly maxBudgetUsd: number;
  /** 期望的模型家族（真正的判定读结果里那一格，不读这一格）。 */
  readonly modelFamily?: string;
  /** 同家族时的 CEO 批准凭据（与门控层同一形状）。 */
  readonly sameFamilyApproval?: { readonly approvedBy: string; readonly reason: string };
  /** 审阅产物 → 证据包内容。**由调用方从真实文件算出**，见文件头那条。 */
  readonly assemble: (r: {
    readonly output: string;
    /** ExecutionResult.exit_code 在 SDK 路径上是**缺省**的，所以这里允许 undefined。 */
    readonly exitCode: number | null | undefined;
  }) => {
    readonly artifacts: readonly EvidenceArtifact[];
    readonly claims: readonly { readonly text: string; readonly evidence_refs: readonly string[] }[];
    readonly metrics?: Readonly<Record<string, number>>;
    readonly honestyBoundaries?: readonly string[];
  };
  /** 门控标准：必须来自**测试角色**的岗位书，不是开发角色的（见调用点注释）。 */
  readonly criteria: readonly GateCriterion[];
  readonly gate?: string;
  /**
   * 证据完整性对账结论（`EvidenceStore.verify()` 的结论）。
   *
   * **本模块自己不核磁盘** —— 制品哈希是 `assemble` 从真实文件算出来的，
   * 我也没有第二份文件内容可比，硬要「顺手算一下」就是再编一份证据。
   * 但这一格**必须存在**：`evaluateGate` 在拿到 undefined 时记一条 unresolved，
   * 而它末尾那条「有标准没判成 ⇒ 不能 pass」会让**每一次**干净运行 escalate。
   * 我第一版没有这一格，于是「独立验证通过」在 Production 里永远出不来 ——
   * 与本文件已记的 producer 填错、bundle_type 对不上是**同一族**（三种都是恒判定）。
   * 缺这一格的后果是吵（每次升级人工），不是静默放行，这个方向是对的。
   */
  readonly integrityOk?: boolean;
  /** 透传给 gateway 的那一套依赖。 */
  readonly gateway: Omit<GatewayDeps, "grantedSandbox" | "grantedForbidden"> & {
    readonly grantedSandbox: GatewayDeps["grantedSandbox"];
    readonly grantedForbidden: readonly string[];
  };
  readonly onApproval?: Parameters<typeof callHarness>[3];
  /**
   * ⭐ 【规格】§13.3 第 1 层接进这一层门控要的那一格。**必填，没有默认值** ——
   * 沿用 `harness/gateway.ts` 里 `grantedSandbox` 那条口径（0021 §1）：
   * 拿不到就说明调用方还没接岗位书，那时该在装配期炸，而不是在运行期静默放行。
   *
   * ── 为什么是**审阅方**那份岗位书（这一格我第一版写反了，0033 §3）──
   * 直觉是「这一层 gate 的是作者的工作，所以当然读作者那份」，而它错在**包里装的是谁的话**：
   * `evaluateGate` 拿到的 bundle 是本层自己产的 `test_report`，
   * 里面的 claim 是**审阅方**写的（producer 那一格填作者回答的是「谁的工作在被评审」，
   * 那是另一问，见下面那段长注释）。`mandatorySourceBlock` 读的是 bundle 的 claim，
   * 所以第 1 层在这里判的是「**审阅方**那些依赖外部来源的话搜过没有」。
   * 于是三个入参必须同源，而它们恰好都在本层手上：
   *   包 = 审阅方产的 · 领域 = 审阅方那份岗位书 · 观测 = 审阅方那一次调用的 toolSightings。
   * **作者**那一层的第 1 不归本层管：那是 gate 作者自己那份包的人的事。
   *
   * 第一版我写的是一发「观测必须出自作者」的核对（还配了一个新拒绝码），
   * 它会**拒掉唯一正确的接线**并逼调用方交出作者的观测 —— 那种形状不会被测试抓到，
   * 因为夹具里两个 roleId 常常可以随便写。细节与教训记在 0033 §3。
   *
   * `null` 的语义是「运行期没加载岗位书」⇒ 第 1 层那一条判 unresolved（不是放行），
   * 理由在 `makeSearchCriteriaEvaluator` 那个 null 分支。
   */
  readonly verifierCharter: Charter | null;
}

export type VerifyOutcome =
  | {
      ok: true;
      verdict: GateVerdict;
      verifier: VerifierParty;
      bundle: EvidenceBundle;
      /** 被剔除的作者自报文本（进了审计，让「我们没采信哪几句」可回放）。 */
      droppedClaims: readonly string[];
      /**
       * `instruction` 里命中 SELF_REPORTED_PATTERNS 的那几条。
       * **只记不拒**，理由写在 verifyFix 的注释里（拒会误伤一句正当提到这句话的指令）。
       */
      instructionFlags: readonly string[];
      /**
       * 第 1 层那一条判据**当时看到的是什么**（三态 + 出处）。
       *
       * 为什么单独带出来而不是只留那个数字：`criterion` 判成 violated 时，
       * `evaluateGate` 报的是**岗位书里那条 message**（它写的是「必须附可追溯来源」这类话），
       * 而我们看到的成因可能是「这次调用根本没被授予搜索工具」——
       * 那句话在门控输出里**没有通道**（`CriterionOutcome` 的 violated 分支没有 why，
       * 这是刻意的：内核不让注入方改写门控措辞）。所以它只能走审计。
       * ⚠ 于是有一条已知代价：只看看板的人会被引导去「让 agent 补引用」，
       * 而该修的是装配。这一格记在 0033 §5，不在这里掩盖。
       */
      searchObservation: SearchObservation;
      result: ExecutionResult;
    }
  | { ok: false; code: VerifyRejectCode; reason: string };

/**
 * 跑一次独立验证：独立工作区 + 独立会话 + 不同模型家族 + 有否决权，
 * 然后把它自己的产出送进 `evaluateGate`。
 *
 * 计划 Task 5.4 的 Test 项那条「开发谎报 ⇒ 门控 reject」在这条链上的实现点是：
 * **`VerifyInput` 里没有任何字段用来放作者的自测文本**，门控读的是审阅方自己跑出来的
 * metrics（`assemble` 交回来的那份）。所以谎报不需要被「识破」—— 它不在场。
 *
 * ⚠ 「不在场」这句话只对**入参形状**成立，对运行期不做保证：`instruction` 是调用方
 * 给的自由文本，「顺手把 dev 那句话拼进指令里」在类型上完全写得出来，而这一层拦不了
 * （拦了会误伤一句正当提到这句话的指令，比如「不要采信『自测通过』」）。
 * 所以我**不拒、只记**：命中 SELF_REPORTED_PATTERNS 就在结果里留一条
 * `instructionFlags`，让它进审计、在回放页可见。
 * 「设计上有这道保护」与「这道保护在运行期可被绕过」是两句不同的话，
 * 后者必须写在同一处，否则文件头那句「不在场」会被读成一条运行期的保证。
 *
 * 四道独立性里有**两道**是在调用**之后**才知道结论（会话、实际模型家族），
 * 而那时审阅已经跑完、预算已经花掉。这是这一层的真实形状，我把它写成
 * **事后不过 ⇒ 结论不采信并 reject**，而不是「跑了但照样算通过」：
 * 花掉预算换一次不算数的审阅是损失，而**采信**一次不独立的审阅是 §8.2 被绕过。
 */
export async function verifyFix(input: VerifyInput): Promise<VerifyOutcome> {
  const fail = (code: VerifyRejectCode, reason: string): VerifyOutcome => ({ ok: false, code, reason });
  const verifierWorkspace = independentWorkspace(input.taskId, input.verifyRoot);

  const authorView: Party & { sessionId: string } = {
    roleId: input.author.roleId,
    modelFamily: input.author.modelFamily,
    sessionId: input.author.sessionId,
  };
  // 事后那两维在这里还没有值，先用**占位**跑事前那一遍（pre_call 分支不读它们）。
  const pre = independenceBlock({
    author: authorView,
    verifier: { roleId: input.verifierRoleId, modelFamily: input.modelFamily ?? "" },
    authorWorkspace: input.authorWorkspace,
    verifierWorkspace,
    verifierCaps: input.adapter.capabilities,
    verifierApprovalPolicy: input.stage.approvalPolicy,
    ...(input.sameFamilyApproval === undefined
      ? {}
      : { sameFamilyApproval: input.sameFamilyApproval }),
    stage: "pre_call",
  });
  if (!pre.ok) return fail(pre.code, pre.reason);

  // 走 schema 而不是手写一个 HarnessRequest 字面量。
  // 我第一版就是手写的，而它**漏了两个字段**（outputSchema / resumeSessionId）——
  // `HarnessRequest` 是 zod transform 的产物，那两个键在推断出来的类型里是
  // 「必填而值可为 undefined」，所以漏了只有 tsc 报得出来。更重要的是口径：
  // 让**契约**去校验我们自己造的请求，比让本模块记住有几个字段更不容易漂。
  const req: HarnessRequest = harnessRequestSchema.parse({
    task_id: input.taskId,
    role_id: input.verifierRoleId,
    instruction: input.instruction,
    workspace: verifierWorkspace,
    sandbox: input.stage.sandbox,
    approval_policy: input.stage.approvalPolicy,
    allowed_tools: [...input.allowedTools],
    forbidden_flags: [...input.forbiddenFlags],
    requested_args: ["--sandbox", input.stage.sandbox],
    max_budget_usd: input.maxBudgetUsd,
    ...(input.modelFamily === undefined ? {} : { model_family: input.modelFamily }),
  });
  const out: GatewayOutcome = await callHarness(
    input.adapter,
    req,
    input.gateway as GatewayDeps,
    input.onApproval,
  );
  if (!out.ok) {
    return {
      ok: false,
      code: "verifier_call_failed",
      reason:
        "审阅调用本身没跑成（gateway 报 [" + out.code + "]）：" + out.reason +
        "\n刻意**不**把它换算成 reject：审阅没跑成与『审阅判定不合格』是两件事，" +
        "前者该重试或找人，后者该打回开发者。把前者写成后者会让一次网关故障" +
        "看起来像一次开发质量事故，而修的东西完全不同。",
    };
  }
  const r: ExecutionResult = out.result;
  const verifier: VerifierParty = {
    roleId: input.verifierRoleId,
    modelFamily: r.modelFamily,
    sessionId: r.sessionId,
  };

  const sess = sessionIndependenceBlock(input.author.sessionId, r.sessionId);
  if (!sess.ok) return fail(sess.code, sess.reason);
  const post = independenceBlock({
    author: authorView,
    verifier,
    authorWorkspace: input.authorWorkspace,
    verifierWorkspace,
    verifierCaps: input.adapter.capabilities,
    verifierApprovalPolicy: input.stage.approvalPolicy,
    ...(input.sameFamilyApproval === undefined
      ? {}
      : { sameFamilyApproval: input.sameFamilyApproval }),
    stage: "post_call",
  });
  if (!post.ok) return fail(post.code, post.reason);

  const made = input.assemble({ output: r.output, exitCode: r.exitCode });
  // 制品形状**当场核**，不交给下游：一个形状错的 sha256 会让证据包整包被拒，
  // 而那次拒绝的报错说的是「形状不符」，真相是「调用方拼哈希时拼错了」。
  for (const a of made.artifacts) {
    if (!SHA256_RE.test(a.sha256)) {
      return fail(
        "bad_artifact",
        "assemble 交回的制品 [" + a.path + "] 的 sha256 不是 64 位十六进制 [" + a.sha256 + "]。",
      );
    }
  }
  // 被命中的 claim **整条**不进包（不是「留下文本、剔掉依据」）：
  // 后者会造出一条「有文本无依据」的主张，而 schema 对 evidence_refs 是 min(1) ——
  // 那等于为了留住一句话去破坏契约，而那句话本来就是不该被采信的那句。
  const strip = stripSelfReported(made.claims.map((c) => c.text));
  // ⚠ 对 `instruction` **只记不拒**（口径见函数头那条 ⚠）：这一层拿到的是一句自由文本，
  // 命中可能是【坏写法】（把 dev 那句话拼进来了），也可能是【正当提到】
  // （「不要采信『自测通过』」这一句本身就命中，而它是**对的**提示词）。
  // 拒掉会误伤后者，而误伤的代价是调用方绕开这一层自己拼请求 —— 那比漏记严重。
  const instructionFlags: readonly string[] = stripSelfReported([input.instruction]).dropped.map(
    (d) => d.matched,
  );
  const claims = made.claims
    .filter((c): boolean => !strip.dropped.some((d) => d.text === c.text))
    // 拷成可变形状：EvidenceBundle 的类型来自 zod 推断（不是 readonly），
    // 直接塞 readonly 数组只有 tsc 报得出来，而报错点在装配处而不是判定处。
    .map((c) => ({ text: c.text, evidence_refs: [...c.evidence_refs] }));
  const bundle: EvidenceBundle = {
    bundle_id: randomUUID(),
    task_id: input.taskId,
    bundle_type: "test_report",
    // 身份两格取的是**审阅方的结果**，不是请求里期望的那个（§5.9 判同源读实际值）。
    produced_by_role: verifier.roleId,
    produced_by_model_family: verifier.modelFamily,
    artifacts: [...made.artifacts],
    claims,
    honesty_boundaries: [...(made.honestyBoundaries ?? [])],
    ...(made.metrics === undefined ? {} : { metrics: { ...made.metrics } }),
  };

  // ⭐ 【规格】§13.3 第 1 层：把这条标准接成**门控打回**而不是外面判一次。
  // 走的是 `GateInput.criteriaEvaluator` 那个**已有的注入点**（内核一行没改，
  // 理由在 policy.ts 那一段：判据住在门控外面躺着 = 拦不拦取决于调用方记不记得判）。
  //
  // 三格同源的口径写在 `VerifyInput.verifierCharter` 那一格：
  // 包是审阅方产的、领域来自审阅方那份岗位书、观测来自审阅方那一次调用。
  // 第四格 `fallback` 交的是 metric 判据本体：这条 evaluator 只认
  // `search:mandatory_sources`，其余 condition **必须**原样交回，
  // 否则接上第 1 层的代价是把岗位书里那些 `metric:` 标准全变成不适用（静默放行）。
  const observation: SearchObservation = observeSearchCalls({
    granted: input.allowedTools,
    sightings: out.toolSightings,
  });
  const searchEvaluator: CriteriaEvaluator = makeSearchCriteriaEvaluator({
    mandatoryDomains: charterMandatoryDomains(input.verifierCharter),
    observedSearches: toObservedSearches(observation),
    fallback: metricCriteriaEvaluator,
  });

  const verdict: GateVerdict = evaluateGate({
    // 门控问的是「**谁的工作**在被 gate」，不是「这份包是谁产的」，所以
    // producer 必须是**作者**（dev）而 reviewer 是审阅方。
    // ⚠ 我第一版两处都填了审阅方（因为「这份 test_report 是审阅方产的」听起来对），
    // 而 evaluateGate 的第 3 步判的正是 `reviewer.roleId === producer.roleId` ⇒
    // **每一次审阅都会 escalate**，而报错说的是「作者不给自己打分」。
    // 那是本文件最像成功的一个失败：门控在动、结论在出、审计在写，而每一次都是同一句话。
    // 证据包的 produced_by_role 那一格仍然是审阅方（它确实是产出者，§8.1 的包类型核对读它）。
    //
    // gate 默认 `test_upward` 而不是 `dev_to_test`：这一层产的是 **test_report**，
    // 而 §8.1 那张表里 `dev_to_test` 要的是 `code_diff`。默认成前者会让
    // evaluateGate 的类型核对**每一次**都判「包类型不符」而 reject ——
    // 一个恒拒的门控与一个恒放行的门控一样没用，而且它拒的理由是假的。
    gate: input.gate ?? "test_upward",
    producer: { roleId: input.author.roleId, modelFamily: input.author.modelFamily },
    bundle,
    criteria: [...input.criteria],
    reviewer: { roleId: verifier.roleId, modelFamily: verifier.modelFamily },
    // 只有调用方**明确给了**才传：把 undefined 变成 true 就是我替调用方对账。
    ...(input.integrityOk === undefined ? {} : { integrityOk: input.integrityOk }),
    criteriaEvaluator: searchEvaluator,
  });
  return {
    ok: true,
    verdict,
    verifier,
    bundle,
    droppedClaims: strip.dropped.map((d) => d.text),
    instructionFlags,
    searchObservation: observation,
    result: r,
  };
}

/**
 * 一份审阅调用的**最小**路由段：workspace-write + on-request + 由独立角色发起。
 *
 * 为什么不直接用 `stagesFor("bugfix")` 里那一段：调用方常常从别处进来（重构、功能），
 * 而那些类别的 verify 段与这一段的**唯一**区别是 id。写死在这里的取值是
 * 「一次独立验证**至少**要什么」，比从类别表里捞一段更不容易被上游的配置带跑。
 * `readOnly: false` 是必须的（审阅要写用例文件），而 `executor: "independent"`
 * 让路由层那条 §8.2 的闸门也能接上。
 */
export function verifierStage(): RouteStage {
  return {
    id: "verify",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    readOnly: false,
    executor: "independent",
    independentBranch: false,
    why:
      "【规格】§12.6 第 2 条的独立验证段。on-request 而不是 never：" +
      "审阅这一侧必须是 enforced，否则独立性只剩『换了个目录』这一维（见 verifier_not_enforced）。",
  };
}

/** 审计行（复用既有 action；本模块不自造新的 action —— 枚举一经写入就是永久的）。 */
export function verifierAuditRow(
  o: VerifyOutcome & { readonly ok: true },
  taskId: string,
): AuditRow {
  return {
    taskId,
    actorType: "system",
    actorId: "verifier",
    action: "harness_call",
    target: o.verifier.roleId,
    payload: {
      action: "harness_call",
      task_id: taskId,
      role_id: o.verifier.roleId,
      model_family: o.verifier.modelFamily,
      session_id: o.verifier.sessionId,
      bundle_id: o.bundle.bundle_id,
      gate_decision: o.verdict.decision,
      dropped_self_reported_claims: o.droppedClaims,
      // 「我们**知道**指令里有这句话」这件事也得能回放（只记不拒的那一笔）。
      instruction_self_reported_matches: o.instructionFlags,
      // 第 1 层当时看到的是三态里的哪一态、出处是什么（为什么不只记数字见
      // VerifyOutcome 那一格的注释；一句话：门控的输出里没有通道放「成因」）。
      search_observation: o.searchObservation,
    },
  };
}
