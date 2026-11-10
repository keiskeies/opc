/**
 * 门控判定内核（计划 Task 1.2，规格 §8.2 第 5 条、§24 风险 5）。
 *
 * 一句话立场：门控是【确定性代码】，不查 LLM、不读网络、不读时钟。
 *
 * 为什么「确定性」是硬规定而不是风格要求（规格 §24 风险 5）：门控一旦引入 LLM 判断，
 * 「作者不给自己打分」就退化成提示词约定 —— 同一段产出可以因为措辞不同而过/不过，
 * 而 §8.2 第 4 条的「不可绕过」要求门控是结构约束。只有纯函数才谈得上「可绕过」这件事
 * 有没有被证明过：它能被传统单元测试穷尽，LLM 不能。
 *
 * 因此本文件里【不允许】出现：Date.now()、Math.random()、任何 fs/net import、
 * 任何 await（无 I/O 就无需异步；改成 async 会让「100 次调用逐字节相同」这条测试
 * 失去意义 —— await 引入了调度点，而调度点引入顺序不确定性）。
 *
 * 需要判断【质量】的环节怎么办？产出「待验证断言列表」（pendingAssertions），
 * 交给测试执行器（Phase 5 的 Harness）或人工（Phase 1）。质量判断不消失，
 * 只是从门控内部搬到门控外部，并且变成【可列举、可追踪】的东西。
 */

import type { Charter, EvidenceBundle } from "@opc/contracts";
import {
  HANDOFF_BUNDLE_TYPES,
  unresolvableClaimIndexes,
} from "@opc/contracts";

/** 判定入参里的产出方信息。modelFamily 在【家族】粒度上比，见 evidence.ts 的注释。 */
export interface ProducerInfo {
  readonly roleId: string;
  readonly modelFamily: string;
}

/**
 * 一条验收标准在门控里的形态。
 *
 * 岗位书的 acceptance_criteria 是 { condition, action, target, message }，其中 condition
 * 是【自由文本】（例："p0_defect_count > 0"）。本内核【不解析】那段自由文本 ——
 * 解析自由文本要么写一个自造表达式语言（超出 Phase 1 范围，且每加一种语法就多一处
 * 静默失效面），要么交给 LLM（违反上面的硬规定）。
 *
 * 正解是把「怎么判」交给调用方注入：criteriaEvaluator 是一个纯函数，由它读 condition
 * 文本与证据包的 metrics，返回三态。这样：
 *  - 内核仍然不解析语义 ⇒ 仍然确定、仍可穷尽测试；
 *  - 「标准到底怎么判」这件事有一个唯一注入点，Phase 5 接测试执行器时换实现，
 *    内核零改动；
 *  - 没注入时【不猜】：一律 unresolved ⇒ 升级人工。默认放行是最危险的静默失效
 *    （计划 Test 项点名的就是这条）。
 */
export interface GateCriterion {
  readonly condition: string;
  readonly action: "reject" | "escalate";
  readonly target?: string;
  readonly message: string;
}

export type CriterionOutcome =
  /** 条件成立 ⇒ 这条标准【被违反】（condition 的语义就是「不合格的情形」） */
  | { status: "violated" }
  /** 条件不成立 ⇒ 这条标准通过 */
  | { status: "satisfied" }
  /** 判不了：证据不足、语法不认识、指标缺失 */
  | { status: "unresolved"; why: string };

export type CriteriaEvaluator = (
  criterion: GateCriterion,
  bundle: EvidenceBundle,
) => CriterionOutcome;

export interface GateInput {
  readonly gate: string;
  readonly producer: ProducerInfo;
  readonly bundle: EvidenceBundle;
  readonly criteria: readonly GateCriterion[];
  readonly reviewer?: ProducerInfo;
  /** 层级审阅已进行的轮次（§8.3 第一条触发条件）。 */
  readonly roundNo?: number;
  readonly maxRounds?: number;
  /** 证据包完整性对账结论（由 hub 侧的 EvidenceStore.verify 得出后传入）。 */
  readonly integrityOk?: boolean;
  readonly criteriaEvaluator?: CriteriaEvaluator;
}

export type GateVerdict =
  | {
      decision: "pass";
      /** 虽未违反但没能判定的标准；空数组表示全部判定了。 */
      unresolved: string[];
    }
  | {
      decision: "reject";
      reasons: string[];
      required_fixes: string[];
      /** 本可判定但因证据不足而判不了的标准（转人工时要知道缺什么）。 */
      unresolved: string[];
    }
  | { decision: "escalate"; reason: string; unresolved: string[] };

/** §8.3 第一条：层级审阅轮次默认上限。必须是显式常量，不能靠调用方每次传。 */
export const DEFAULT_MAX_REVIEW_ROUNDS = 3;

/**
 * 内置的兜底判据：condition 写成 "metric:<名字> <比较符> <数值>" 时机械判定。
 *
 * 为什么只认这一种形状就够：这一形状覆盖了 §23.1 与 Task 0.9 验收里所有【可机械判定】
 * 的标准（覆盖率 ≥ 80、P0 缺陷数 == 0、首屏毫秒 ≤ 2000），而这正是「门控能消费岗位书」
 * 的最小充分集。其余自由文本一律 unresolved → 升级人工，这是【保守方向】：
 * 判不了的事上人，而不是放行。
 *
 * 不写成通用表达式求值器：eval 一个字符串是「让证据包自己决定代码执行什么」，
 * 在不可信输入面前不可接受。
 */
export const METRIC_CONDITION =
  /^metric:\s*([A-Za-z0-9_.-]+)\s*(>=|<=|==|!=|>|<)\s*(-?\d+(?:\.\d+)?)$/u;

/** 缺省判据：只认 metric: 形状，其余一律 unresolved。 */
export const metricCriteriaEvaluator: CriteriaEvaluator = (c, bundle) => {
  const m = METRIC_CONDITION.exec(c.condition.trim());
  if (m === null) {
    return {
      status: "unresolved",
      why: "条件 [" + c.condition + "] 不是 metric:<名> <比较符> <数值> 形状",
    };
  }
  const key = m[1] as string;
  const op = m[2] as string;
  const rhs = Number(m[3]);
  const metrics = bundle.metrics;
  if (metrics === undefined || !Object.hasOwn(metrics, key)) {
    return {
      status: "unresolved",
      why: "证据包没有声明指标 [" + key + "]，无法判定 [" + c.condition + "]",
    };
  }
  const lhs = metrics[key] as number;
  // NaN 与 Infinity 走 unresolved：schema 里的 z.number().finite() 只保证【写进来时】
  // 有限，而 bundle 对象可能由调用方手搓（不经 schema）。比较 NaN 恒 false，
  // 于是「NaN 的覆盖率」会被判成满足阈值 —— 一个假通过。
  if (!Number.isFinite(lhs)) {
    return {
      status: "unresolved",
      why: "指标 [" + key + "] 不是有限数值（" + String(lhs) + "）",
    };
  }
  let holds: boolean;
  switch (op) {
    case ">=":
      holds = lhs >= rhs;
      break;
    case "<=":
      holds = lhs <= rhs;
      break;
    case ">":
      holds = lhs > rhs;
      break;
    case "<":
      holds = lhs < rhs;
      break;
    case "==":
      holds = lhs === rhs;
      break;
    default:
      holds = lhs !== rhs;
      break;
  }
  return { status: holds ? "violated" : "satisfied" };
};

/**
 * 判定本体。
 *
 * 求值顺序【有意】：先结构完整性，再轮次，最后业务标准。
 * 顺序在这里就是优先级 —— 一个连证据都对不上的包，就算标准全满足也不该往下走；
 * 反过来若先判业务标准，就会出现「覆盖率达标，但那份报告文件根本不在磁盘上」的通过。
 */
export function evaluateGate(input: GateInput): GateVerdict {
  const unresolved: string[] = [];
  const reasons: string[] = [];
  const fixes: string[] = [];
  const { bundle, criteria } = input;

  // ── 1. 空标准必须 reject（计划 Test 项点名：这是最危险的静默失效）────────────
  //
  // 为什么不是 escalate：escalate 的语义是「这件事需要人看」，而「这个角色的岗位书
  // 根本没写验收标准」是一个【配置缺陷】，不是需要 CEO 逐次判断的业务问题。reject
  // 会逼上游把标准补上；escalate 只会让 CEO 每周重看一次同一个缺陷。
  // 默认通过是三个选项里唯一不可接受的：那意味着「没写标准」比「写了标准且满足」
  // 更容易过关。
  if (criteria.length === 0) {
    return {
      decision: "reject",
      reasons: [
        "门控 [" +
          input.gate +
          "] 没有任何验收标准可判（岗位书 acceptance_criteria 为空）。" +
          "空标准不放行：那等于「没写标准」比「满足标准」更容易通过。",
      ],
      required_fixes: [
        "为该角色补上至少一条可机械判定的 acceptance_criteria（Task 0.9）",
      ],
      unresolved,
    };
  }

  // ── 2. 证据完整性 ────────────────────────────────────────────────────────
  /*
   * 交接方向 ↔ 包类型（§8.1 那张表）。
   *
   * 这张表在 contracts 里躺了很久却没有一个生产调用方（只有它自己的单测在调），
   * 后果是 §8.1 只是【文档上存在】：dev_to_test 这一闸收【任何】bundle_type 都照收。
   * 于是「开发标记完成但不附测试报告」这条 §23.1 的 Phase 1 验收标准无从判起 ——
   * 更糟的是它可以被反向绕过：交一个 bundle_type 写成 "test_report" 而内容只有两句
   * 话的包，类型这一维就过了。
   *
   * 【未知方向不抛错】。requiredBundleType() 那个函数对未知方向是抛错的（那是它自己的
   * 立场，见其注释），但这里不能抛：evaluateGate 是【全函数】—— 运行时传进来的
   * gate 名远不止五个交接方向（中断载荷里见过 "qa"、"ceo" 这种），抛错会让门控
   * 在一个名字上崩掉，而门控崩掉的默认表现是【这一闸整个跳过】。改成记 unresolved：
   * 方向不认识 ⇒ 类型这一维没核对过 ⇒ 不默认放行（见函数末尾那条）。
   */
  const required = Object.hasOwn(HANDOFF_BUNDLE_TYPES, input.gate)
    ? HANDOFF_BUNDLE_TYPES[input.gate]
    : undefined;
  if (required === undefined) {
    unresolved.push(
      "交接方向 [" +
        input.gate +
        "] 未登记应有的包类型，无法核对「这个方向该交什么证据」（§8.1）",
    );
  } else if (bundle.bundle_type !== required) {
    reasons.push(
      "交接方向 [" +
        input.gate +
        "] 要求的证据包类型是 [" +
        required +
        "]，实到 [" +
        bundle.bundle_type +
        "]（§8.1）。类型不对的产出不是「格式问题」，是这个方向【该交的东西没交】。",
    );
    fixes.push("换成 " + required + " 类型的证据包，或走正确的交接方向");
  }
  const unresolvable = unresolvableClaimIndexes(bundle);
  if (unresolvable.length > 0) {
    reasons.push(
      "有 " +
        unresolvable.length +
        " 条主张的 evidence_refs 对不上包内任何制品（下标 " +
        unresolvable.join(", ") +
        "）。§8.2 第 2 条：通过必须附【可验证】证据，引用不存在的文件不是证据。",
    );
    fixes.push("把这些主张改指向真实制品，或把缺失的制品补进 artifacts");
  }
  if (input.integrityOk === false) {
    reasons.push(
      "证据包完整性对账未通过：声明的 sha256 与磁盘内容不符或文件缺失。",
    );
    fixes.push("重新产出证据包，或用 EvidenceStore.verify() 看具体是哪个制品");
  }
  // 没传 integrityOk（undefined）时【不判】完整性，也不因此放行而不吭声：
  // 记进 unresolved，让下游知道这一维没被检查过。恒当 ok 是一种假绿。
  if (input.integrityOk === undefined) {
    unresolved.push("证据完整性未对账（调用方未传 integrityOk）");
  }

  // ── 3. 审阅方与产出方同源（§24 风险 1）───────────────────────────────────
  if (
    input.reviewer !== undefined &&
    input.reviewer.roleId === input.producer.roleId
  ) {
    return {
      decision: "escalate",
      reason:
        "审阅者与产出者是同一角色 [" +
        input.producer.roleId +
        "]（§8.2 第 1 条「作者不给自己打分」）。",
      unresolved,
    };
  }

  // ── 4. 轮次上限（§8.3 第一条）────────────────────────────────────────────
  const maxRounds = input.maxRounds ?? DEFAULT_MAX_REVIEW_ROUNDS;
  if (input.roundNo !== undefined && input.roundNo >= maxRounds) {
    return {
      decision: "escalate",
      reason:
        "层级审阅已进行 " +
        input.roundNo +
        " 轮，达到上限 " +
        maxRounds +
        "（§8.3：N 轮未达成一致需升级）。",
      unresolved,
    };
  }

  // ── 5. 业务标准 ─────────────────────────────────────────────────────────
  const evaluate = input.criteriaEvaluator ?? metricCriteriaEvaluator;
  const escalateMessages: string[] = [];
  for (const c of criteria) {
    const out = evaluate(c, bundle);
    if (out.status === "unresolved") {
      unresolved.push(c.condition + "（" + out.why + "）");
      continue;
    }
    if (out.status !== "violated") continue;
    if (c.action === "escalate") {
      escalateMessages.push(
        c.target === undefined
          ? c.message
          : c.message + "（升级目标 " + c.target + "）",
      );
    } else {
      reasons.push(c.message);
      fixes.push(c.condition);
    }
  }

  if (escalateMessages.length > 0) {
    return {
      decision: "escalate",
      reason: escalateMessages.join("；"),
      unresolved,
    };
  }
  if (reasons.length > 0) {
    return { decision: "reject", reasons, required_fixes: fixes, unresolved };
  }
  /*
   * 【有标准没判成 ⇒ 不能 pass】。本函数文件头一直写着「判不了的事上人，而不是放行」，
   * 而实现曾经一路走到 pass、只把 unresolved 挂在返回值上 —— 注释承诺了实现没有的性质。
   * 同类的「注释说 A 实现做 B」在 sha256File（写着流式其实整读）、
   * independentReviewerPath（写着多跳其实只看一跳）上都踩过，每一次都靠测试才暴露。
   *
   * 这个洞在真实运行里的形状很具体：agent 只要【不在证据包里写 metrics】，
   * 岗位书里那条 metric:coverage >= 80 就永远走 unresolved，于是门控恒 pass。
   * 换句话说，最省事的假绿方式不是伪造覆盖率数字，而是【不提覆盖率】——
   * 而伪造数字至少还会被「指标必须来自 harness」那一层的对账拦住。
   *
   * 为什么是 escalate 而不是 reject：reject 会告诉产出方「你不合格」，可他没做错任何事，
   * 缺的是【这条标准在这儿无法判定】。更坏的是它会给出一个错误的修法 ——
   * 「把 metrics 填上让标准能判」，于是逼出的是编一个指标值，那正是 §14.4 红线二
   * 禁止的形状（自评数据当证据）。escalate 的语义恰好是「这件事需要人看」。
   *
   * 与 routing/escalation.ts 的口径对齐：那边早把「门控没判定的标准条数 > 0」定成
   * insufficient_evidence 升级触发条件。两个模块对同一件事给两种结论时，
   * 实际生效的是【先跑的那个】，而那个是门控 —— 于是升级侧的这条触发条件永远不会被走到。
   *
   * 代价说清楚：CEO 会收到「这条标准判不了」的卡片，比静默放行吵。但吵是【能修的吵】
   * （补 metrics、或把标准改成 metric: 形状、或承认它只能人判），而静默 pass 是
   * §8.2 整节要防的那种失效：门控看起来在工作，实际上没在判任何东西。
   */
  if (unresolved.length > 0) {
    return {
      decision: "escalate",
      reason:
        "有 " +
        unresolved.length +
        " 条验收标准【无法判定】，门控不替人猜：\n  - " +
        unresolved.join("\n  - ") +
        "\n修法二选一：① 让标准变成 metric:<名> <比较符> <数值> 且证据包带上该指标；" +
        "② 承认这条只能人判，那就别写成门控标准（写成 honesty_boundaries 或人工审批项）。",
      unresolved,
    };
  }
  return { decision: "pass", unresolved };
}

/**
 * 岗位书 → 门控标准。放在这里而不是 loader 里，因为它是【门控的输入适配】，
 * 不是岗位书的校验规则（校验规则的唯一定义在 @opc/contracts）。
 */
export function criteriaFromCharter(
  charter: Charter,
): GateCriterion[] {
  return charter.acceptanceCriteria.map((a) => ({
    condition: a.condition,
    action: a.action,
    ...(a.target === undefined ? {} : { target: a.target }),
    message: a.message,
  }));
}
