/**
 * 联网搜索的三层策略（计划 Task 5.7，【规格】§13.3 / §13.2 末段）。
 *
 * ── 计划与规格在这里给的**不是同一套三层** ──────────────────────────
 * 计划那一行写「强制搜索 / 建议搜索 / 禁止搜索」，
 * 【规格】§13.3 那张表写「强制搜索 / **条件搜索** / **预算降级**」。
 * 我按**规格**实现（需求那一层它以 §13.3 为权威，计划是它的派生），
 * 并把计划多出来的「禁止」实现成一条**独立开关**而不是第三层 ——
 * 理由写在 SEARCH_PROHIBITED 那一段（它和第三层管的不是同一件事）。
 * 这一处分歧记在 0024。
 *
 * ── 本文件是【纯判定】，不碰网络、不碰 SDK ──────────────────────────
 * 与 `harness/gateway.ts` 同一取舍：三层判据全部与「搜索由谁提供」无关，
 * 而 `@modelcontextprotocol/sdk` 在本机装不上（0009 §2 那三条通路）。
 * 所以判定层先钉死，传输层在 `search/mcp.ts` 里只留一个**注入的传输接口**
 * （不是假的 MCP，是一个真实的边界：谁提供搜索结果，谁实现这一个方法）。
 *
 * ── ⭐ 本层最容易被写坏的地方，和它躲不过的那一条 ────────────────────
 * 「这个任务属于快速变化领域吗」与「这个证据包算不算带了来源」这两问，
 * **两侧不能由同一个主体回答**。0021 §1 / 0022 §1 记过这个家族三次，
 * 而它在搜索这一层特别容易复发，因为最省事的写法是：
 *     让 Agent 自己在证据包里声明「本任务涉及 X 领域，我搜了」——
 * 那正是让被约束者 declaring 自己的约束条件。所以：
 *   - `mandatoryDomains` 必须**从岗位书注入**（`charterMandatoryDomains`），
 *     不接受从证据包内容里推；
 *   - 「搜过没有」有两个强度：包里有没有 URL（【规格】字面要求，**可被编造**）
 *     与审计里有没有真的发生过搜索（**编不出来**）。两个都做，差别写在函数注释里。
 */
import {
  isExternalSourceRef,
  SEARCH_MANDATORY_SOURCES_CONDITION,
  type Charter,
  type EvidenceBundle,
} from "@opc/contracts";
// `metricCriteriaEvaluator` 作为**默认 fallback** 用在下面那条测试里，
// 而类型 `CriteriaEvaluator` 是这一节的接口本体 —— 都来自门控那一层，不另写一份。
import type { CriteriaEvaluator } from "../graph/gates/evaluate.js";

/* ═════════════════ 三层：取值与注入 ═════════════════ */

/**
 * 三层策略的**判定结果**。
 *
 * 注意这一串取值不是「允许/拒绝」的二值：【规格】§13.3 第 2 层的核心洞察是
 * 「让 Agent **显式决定**是否搜索，不默认搜索也不默认不搜索」，
 * 所以「Agent 没表态」本身是一个需要被区分的状态 ——
 * 把它折叠进「不允许」会毁掉那条可审计性（决策过程本身就是产物）。
 */
export const SEARCH_DECISIONS = [
  /** 第 1 层：该领域必须搜过才放行。 */
  "required",
  /** 第 2 层：Agent 显式判断知识不足 ⇒ 允许，且理由进审计。 */
  "allowed_by_judgment",
  /** 第 2 层反面：Agent 判断参数化知识够用 ⇒ 不搜，理由同样进审计。 */
  "skipped_by_judgment",
  /** 第 3 层：成本已达阈值 ⇒ 后续搜索要人批。 */
  "needs_approval",
] as const;
// ⚠ 「禁止」不在这个取值表里，而这不是漏写：禁止走的是 SearchBlock（一条拒绝），
// 不是 SearchPolicyVerdict。一个**永不产出**的 decision 取值与一张有码而无返回点的
// 码表是同一种装饰（Task 5.4 刚为那四个码删过一轮），所以这里不留。
export type SearchDecision = (typeof SEARCH_DECISIONS)[number];

export const SEARCH_REJECT_CODES = [
  "unknown_mandatory_domain",
  "no_source_for_mandatory_domain",
  "mandatory_source_not_observed",
  "no_judgment_declared",
  "judgment_without_reason",
  "prohibited_by_charter",
  "search_result_no_url",
  "decision_without_adr",
  "escalation_required",
] as const;
// ⚠ 表里**不**放 budget_unknown / over_search_budget：预算那一维产出的是
// SearchPolicyVerdict（needs_approval + budgetTier），不是一次拒绝。写进码表就是
// 「有码而代码永不返回」—— Task 5.4 刚为四个这样的码删过一轮，同一个错不犯第二次。
export type SearchRejectCode = (typeof SEARCH_REJECT_CODES)[number];

export type SearchBlock = { ok: true } | { ok: false; code: SearchRejectCode; reason: string };

/* ═════════════════ 第 1 层：强制搜索领域 ═════════════════ */

/**
 * 【规格】§13.3 第 1 层那张表里列的四个领域。
 *
 * ⚠ 这四条是**照抄规格**，不是我归纳的（规格原文：竞品动态 / 框架版本 / 定价基准 / 安全公告）。
 * 为什么把它做成常量表而不是让岗位书自由填：自由填会让「这个领域算不算快速变化」
 * 变成每次现场解释的东西，而第 1 层的后果是**门控直接打回**——
 * 一个能现场解释的判据担不起一个 reject。
 * 代价：规格没列的领域（比如某个新出的协议版本）今天不会触发强制搜索，
 * 要加得改这张表（= 改规格 = CEO 的事），我**不**给它一个「其他/疑似」的口子。
 */
export const FAST_CHANGING_DOMAINS = [
  "competitive_landscape",
  "framework_versions",
  "pricing_benchmarks",
  "security_advisories",
] as const;
export type FastChangingDomain = (typeof FAST_CHANGING_DOMAINS)[number];

export function isFastChangingDomain(d: string): d is FastChangingDomain {
  return (FAST_CHANGING_DOMAINS as readonly string[]).includes(d);
}

/**
 * 第 1 层的**字面**判据：该领域的证据包必须带来源引用。
 *
 * 【规格】原话「该领域证据包无来源引用 ⇒ 门控直接打回」，所以这里的返回不是 warning。
 *
 * ⚠⚠ 这一条能判的是「**有没有**引用」，判不了「这条引用**是不是真的搜来的**」。
 * 一个编造的 `https://example.com/x` 在这里完全合格 —— 而它不是理论风险，
 * 编一个 URL 比编一个覆盖率数字更省事（覆盖率至少还有个数值范围会被对账）。
 * 所以本层还有第二个判据 `mandatorySearchObservedBlock`，它读的是**观测到的搜索**。
 * 两个都留着：前者是【规格】的字面要求，后者才是那句「无来源引用」想要的意思。
 *
 * `mandatoryDomains` 是**注入**的那一侧（来自岗位书，不是来自包）——
 * 见文件头那条 ⭐。让包自己声明涉及哪些领域，等于被约束者自己划定约束范围。
 */
export function mandatorySourceBlock(
  mandatoryDomains: readonly string[],
  bundle: Pick<EvidenceBundle, "claims" | "artifacts">,
): SearchBlock {
  const unknown = mandatoryDomains.filter((d) => !isFastChangingDomain(d));
  if (unknown.length > 0) {
    return {
      ok: false,
      code: "unknown_mandatory_domain",
      reason:
        "强制搜索领域里有没听过的名字 [" + unknown.join(", ") + "]。" +
        "FAST_CHANGING_DOMAINS 是【规格】§13.3 那张表的四条，不接受现场加一项 —— " +
        "一个能现场解释的判据担不起 reject 这个后果。修法：改那张表（= 改规格），" +
        "或把这一项从岗位书里去掉。",
    };
  }
  const sources = bundle.claims.flatMap((c) => c.evidence_refs).filter(isExternalSourceRef);
  if (mandatoryDomains.length > 0 && sources.length === 0) {
    return {
      ok: false,
      code: "no_source_for_mandatory_domain",
      reason:
        "本任务声明了强制搜索领域 [" + mandatoryDomains.join(", ") + "]，" +
        "而证据包里**一条 http(s) 来源引用都没有**（【规格】§13.3 第 1 层：门控直接打回，" +
        "不是警告）。为什么是 reject 而不是 escalate：这一层的语义是" +
        "「这个领域的结论必须建立在外部来源上」，缺它就是结论没有依据 —— " +
        "缺依据是**不合格**，不是「需要人来看」。",
    };
  }
  return { ok: true };
}

/**
 * 第 1 层的**强**判据：审计里真的发生过搜索。
 *
 * 上面那条判的是「包里写了 URL」，这一条判的是「**搜过**」。
 * 只有这一条能拦住编造的 URL，因为审计行不是 Agent 能往自己包里写的东西
 * （它由 Gateway 在工具调用时落，见 0021 §4 那条「事前有否决权 / 事后只能观察」）。
 *
 * `observedSearches` 由调用方从审计里读出来交进来。**没读到就按 0 算**：
 * 0 是「观测通路说没搜过」，undefined 才会是「没看」——
 * 这里刻意不接受 undefined，因为「没看」在这一层必须是一个显式的调用方决定
 * （见 `SearchEvidence.observedSearchesUnobserved`）。
 */
export function mandatorySearchObservedBlock(
  mandatoryDomains: readonly string[],
  observedSearches: number,
): SearchBlock {
  if (mandatoryDomains.length === 0) return { ok: true };
  if (observedSearches <= 0) {
    return {
      ok: false,
      code: "mandatory_source_not_observed",
      reason:
        "声明了强制搜索领域 [" + mandatoryDomains.join(", ") + "]，" +
        "而审计里**一次搜索调用都没观测到**（observedSearches=" + observedSearches + "）。" +
        "包里也许写了 URL，但那条 URL 没有被任何一次真实搜索支撑 —— " +
        "这正是上一条判据结构性拦不住的那种写法。",
    };
  }
  return { ok: true };
}

/** 「没有观测通路」这个状态必须是**显式**的，不能靠传 0 混过去。 */
export function unobservedSearchBlock(mandatoryDomains: readonly string[]): SearchBlock {
  if (mandatoryDomains.length === 0) return { ok: true };
  return {
    ok: false,
    code: "mandatory_source_not_observed",
    reason:
      "声明了强制搜索领域，而调用方**明确说没有观测通路**。" +
      "刻意不允许「看不到就当搜过」：那会让第 1 层在有观测通路时严格、" +
      "在没有观测通路时恒放行，而后者是攻击面（把观测关掉就绕过它）。" +
      "修法二选一：① 接上审计读侧；② 承认这一层今天判不了，把它从岗位书里摘掉而不是留着。",
  };
}

/* ═════════════════ 第 2 层：条件搜索（显式判断） ═════════════════ */

/**
 * Agent 的显式表态。【规格】§13.3 第 2 层：输出**搜索必要性判断 + 理由**，可审计。
 *
 * 三种形状都必须存在，尤其是「没表态」：
 * 把它当成「不搜」会让 Agent 少写一格就省掉一次审计，
 * 把它当成「搜」会让默认值变成搜索（规格明确反对默认搜索）。
 */
export type SearchJudgment =
  | { readonly declared: false }
  | {
      readonly declared: true;
      /** true = 判断参数化知识不足，需要搜。 */
      readonly needsSearch: boolean;
      readonly reason: string;
    };

export function judgmentBlock(j: SearchJudgment): SearchBlock {
  if (!j.declared) {
    return {
      ok: false,
      code: "no_judgment_declared",
      reason:
        "既不在强制搜索领域，也没有【搜索必要性判断】，不予放行（【规格】§13.3 第 2 层）。" +
        "这一条拦的不是『搜没搜』，是『**有没有把决定过程留下来**』—— " +
        "AdaSearch 那一格的要点就是决策本身可审计。两种偷懒形状都会被这里挡住：" +
        "把判断折叠成『不搜』（省掉一次审计）、把判断折叠成『搜』（默认搜索）。",
    };
  }
  if (j.reason.trim() === "") {
    return {
      ok: false,
      code: "judgment_without_reason",
      reason:
        "声明了搜索必要性判断（needsSearch=" + j.needsSearch + "）而理由为空。" +
        "一个空的理由与没有判断等价，而且它比没有更坏：它看起来满足了一条可审计的要求。" +
        "（同 0021 那条『空理由的批准等于没有批准』。）",
    };
  }
  return { ok: true };
}

/* ═════════════════ 第 3 层：预算降级 ═════════════════ */

/**
 * 升级到谁批。**取决于金额**（【规格】§13.3 第 3 层原话「取决于金额」）。
 *
 * 那两个阈值**不是规格给的**，规格只说「取决于金额」。我不编金额数，
 * 所以阈值是**注入**的（`thresholds`），缺省 ⇒ 判不了 ⇒ 拦（见下）。
 * 这一格与 0022 §4「风险低所以少跑一段」是同一立场：
 * 能改判据后果的参数，不能由被约束的那一方现填。
 */
export interface SearchBudgetThresholds {
  /** 达到任务预算的这个比例 ⇒ 后续搜索需技术总监批。0–1。 */
  readonly techLeadRatio: number;
  /** 达到这个比例 ⇒ 升级 CEO。必须 > techLeadRatio。 */
  readonly ceoRatio: number;
}

export type BudgetDecision =
  | { readonly tier: "within"; readonly ratio: number }
  | { readonly tier: "tech_lead"; readonly ratio: number }
  | { readonly tier: "ceo"; readonly ratio: number }
  | { readonly tier: "unknown"; readonly why: string };

/**
 * 第 3 层的判据。
 *
 * 三条刻意的选择：
 *  1. **spent 或 limit 缺任何一个 ⇒ unknown**，而 unknown ⇒ 要批。
 *     反过来（判不了就当没超）会让「不接预算上报」成为一条绕过第 3 层的通路 ——
 *     与本仓一路的「缺信息必须落到有人来判」同一方向。
 *  2. 用**比例**而不是绝对金额（规格给的就是比例语义）。
 *  3. 阈值本身**不校验合理性**吗？校验：见下（`ceoRatio <= techLeadRatio` 直接拦），
 *     因为一个配反的阈值会让 CEO 那一档永远不触发而看起来像在防。
 */
export function searchBudgetTier(
  spentCents: number | null | undefined,
  limitCents: number | null | undefined,
  thresholds: SearchBudgetThresholds | undefined,
): BudgetDecision {
  if (thresholds === undefined) {
    return {
      tier: "unknown",
      why:
        "没有搜索预算阈值（thresholds 未注入）。**不**按『没超』处理：" +
        "那会让『不配阈值』成为一条绕过【规格】§13.3 第 3 层的通路。" +
        "阈值不由本模块给默认值 —— 规格没说那个比例是多少，我不编。",
    };
  }
  if (!(thresholds.ceoRatio > thresholds.techLeadRatio)) {
    return {
      tier: "unknown",
      why:
        "阈值配置非法（ceoRatio=" + thresholds.ceoRatio + " 必须 > techLeadRatio=" +
        thresholds.techLeadRatio + "）。配反的话 CEO 那一档**永不触发**而看起来仍在防，" +
        "这是【恒不命中的判据】最坏的一种：它给了两条防线的外观。",
    };
  }
  if (
    spentCents === null || spentCents === undefined ||
    limitCents === null || limitCents === undefined ||
    !(limitCents > 0)
  ) {
    return {
      tier: "unknown",
      why:
        "搜索成本或任务预算上限拿不到（spent=" + String(spentCents) +
        ", limit=" + String(limitCents) + "），无法判断是否达到降级阈值。" +
        "0015 §3 记过岗位书预算与 `budgets` 表是**两个源**，所以『读不到』在今天不是罕见情况。",
    };
  }
  const ratio: number = spentCents / limitCents;
  if (ratio >= thresholds.ceoRatio) return { tier: "ceo", ratio };
  if (ratio >= thresholds.techLeadRatio) return { tier: "tech_lead", ratio };
  return { tier: "within", ratio };
}

/* ═════════════════ 计划多出来的那一层：显式禁止 ═════════════════ */

/**
 * 计划写「禁止搜索」而【规格】§13.3 那一栏没有它。我把它实现成**一条独立开关**，
 * 不实现成第三层，理由是这两者管的不是同一件事：
 *
 *   - 规格的第 3 层「预算降级」管的是**花多少钱**（超阈值后要先批）；
 *   - 「禁止」管的是**这个角色/这类任务根本不该联网**（例如只碰内部数据、
 *     或合规上不许把上下文发给外部检索服务）。
 *
 * 合成一层会丢东西：禁止若靠「预算设 0」表达，它会**看起来**像一次预算限制，
 * 于是「为什么被拦」在审计里是错的（金额问题 vs 资格问题），
 * 而修的人会说「那我加点预算」—— 那句话在这个场景里根本不该成立。
 *
 * 禁止**盖过**第 1 层：若岗位书既把某领域列为强制搜索又禁止该角色搜索，那是配置矛盾，
 * 按禁止处理并报错（宁可不搜也不越权；见 `prohibitedBlock` 的 reason）。
 */
export function prohibitedBlock(
  prohibited: boolean,
  mandatoryDomains: readonly string[],
): SearchBlock {
  if (!prohibited) return { ok: true };
  if (mandatoryDomains.length > 0) {
    return {
      ok: false,
      code: "prohibited_by_charter",
      reason:
        "岗位书**同时**声明了「禁止搜索」与强制搜索领域 [" + mandatoryDomains.join(", ") + "]，" +
        "这是配置矛盾，按**禁止**处理并停下等人改岗位书。" +
        "不选『让强制搜索赢』的理由是资格与金额不对称：一个被认定不该联网的角色，" +
        "不能因为『这个领域需要外部信息』就联网 —— 那种组合的正确结论是" +
        "「这件事在这一层做不了，得换角色或升级」。",
    };
  }
  return {
    ok: false,
    code: "prohibited_by_charter",
    reason: "岗位书禁止该角色联网搜索（【规格】§13.3 挂载方式那句「由岗位书决定是否授予该权限」）。",
  };
}

/* ═════════════════ §13.2 末段：搜索结论不得直接变成架构决策 ═════════════════ */

/**
 * 技术总监的搜索结果必须落成 ADR 证据，不得直接成为决策（【规格】§13.2 Step 3 末段）。
 *
 * 判据形状（口径写死，见函数体注释）：
 *   一条 claim 的 evidence_refs **全部**是外部 URL ⇒ 这句话完全建立在搜索上 ⇒
 *   它必须同时引用一个 ADR 制品。
 *
 * 为什么用「全部」而不是「有」：技术总监大量引用外部来源做**调研**是完全正常的，
 * 按「有外部 URL 就拦」会把正常的调研全拦住，而那种拦法的第一后果是
 * 人们开始给内部制品编 URL —— 一个坏判据产出的不是合规，是更精心的规避。
 * 「全部是 URL」才是那句「搜索结论**直接**变成架构决策」的字面形状：
 * 除了搜来的东西，这句话没有任何本地依据（没有代码、没有基准、没有 ADR）。
 *
 * `adrPaths` 是**注入**的（岗位书或任务声明哪些制品算 ADR），
 * 不从 bundle 里按文件名猜 —— 按 `adr` 三个字猜文件名会让「改个名字」成为绕过通路。
 */
export function adrEvidenceBlock(
  bundle: Pick<EvidenceBundle, "claims" | "artifacts">,
  adrPaths: readonly string[],
): SearchBlock {
  const declared = new Set(adrPaths);
  const bad: string[] = [];
  for (const c of bundle.claims) {
    if (c.evidence_refs.length === 0) continue;
    const allExternal = c.evidence_refs.every(isExternalSourceRef);
    if (!allExternal) continue;
    const hitsAdr = c.evidence_refs.some((r) => declared.has(r.split("#")[0] as string));
    if (!hitsAdr) bad.push(c.text);
  }
  if (bad.length > 0) {
    return {
      ok: false,
      code: "decision_without_adr",
      reason:
        "有 " + bad.length + " 条主张的依据**全部**是外部搜索链接，而没有任何一条指向 ADR 制品：" +
        "\n  - " + bad.join("\n  - ") +
        "\n【规格】§13.2 Step 3：搜索结果作为 ADR 的**支撑证据**附加，而不是作为决策本身。" +
        "技术总监不能以『最终决定』姿态绕过架构师评审。修法：把这些依据写进一份 ADR" +
        "（含备选方案与选择理由），再让 claim 引用那份 ADR。",
    };
  }
  return { ok: true };
}

/**
 * 【规格】§13.2 Step 3 末段那句：搜索发现关键依赖即将废弃 ⇒ **触发风险升级**，
 * 而不是让技术总监自己换个方案（换方案涉及产品边界）。
 *
 * 这一条我实现成「**必须**升级」而不是「建议升级」：规格给的是祈使句，
 * 而它挑的那个场景（依赖要废弃 → 换方案）恰好是总监权限**之外**的那一类，
 * 所以「顺手换个方案」正是这条要避免的动作。
 */
export function deprecationEscalationBlock(flagged: boolean): SearchBlock {
  if (!flagged) return { ok: true };
  return {
    ok: false,
    code: "escalation_required",
    reason:
      "搜索结果显示关键依赖即将废弃。这一条**不允许**在技术总监层收敛（【规格】§13.2 Step 3 末段：" +
      "换方案涉及产品边界，需回到产品经理或升级 CEO）。" +
      "所以这里不给『已处理』的出口：必须走升级，产出一条 escalation 事件。",
  };
}

/* ═════════════════ 搜索结果本身：必须带来源 URL ═════════════════ */

/**
 * 搜索结果进包时必须带来源 URL（计划 Task 5.7 Test 项第二句）。
 *
 * 拦的是这一种形状：Agent 把搜来的内容**复述**进 claim，而 refs 指向它自己的笔记。
 * 那种包在 §8.1 的引用核对里是**通过**的（笔记确实在 artifacts 里），
 * 于是「有依据」的外观完整而来源不可追 —— 这是【规格】§14.4 红线一那一族。
 */
export function searchResultUrlBlock(o: {
  /** 本任务发生过搜索（来自观测，不是自报）。 */
  readonly searched: boolean;
  readonly bundle: Pick<EvidenceBundle, "claims" | "artifacts">;
}): SearchBlock {
  if (!o.searched) return { ok: true };
  const anyUrl = o.bundle.claims.some((c) => c.evidence_refs.some(isExternalSourceRef));
  if (!anyUrl) {
    return {
      ok: false,
      code: "search_result_no_url",
      reason:
        "审计里观测到搜索，而证据包里没有任何一条 http(s) 来源引用。" +
        "拦的是这个形状：把搜来的内容【复述】成主张、refs 指向自己的笔记 —— " +
        "它在 §8.1 的引用核对里【是】通过的（笔记确实在包里），" +
        "于是『有依据』的外观完整而来源不可追。",
    };
  }
  return { ok: true };
}

/* ═════════════════ 事后那一遍：证据包的门控 ═════════════════ */

/**
 * 事后门控：证据包已经产出了，判它**够不够格**往下走。
 *
 * 为什么不并进 `searchPolicy`：那一遍是**事前**的（要不要允许这次搜索），
 * 那时**还没有证据包**。并成一个函数就会得到「某些判据只在某个时刻成立」
 * 那种调用方读不出条件的形状（Task 5.4 里 `sessionIndependenceBlock`
 * 单独成函数是同一个理由）。分成两遍之后，每一遍的入参就是它那一刻**拿得到**的东西。
 *
 * 三发判据的顺序同样是语义：先问**义务**（该带的来源带了没有），
 * 再问**观测一致性**（说搜过就得真搜过），最后问**资格越界**（搜索结论有没有直接变成决策）。
 */
export function searchEvidenceGate(o: {
  readonly bundle: Pick<EvidenceBundle, "claims" | "artifacts">;
  readonly mandatoryDomains: readonly string[];
  /** 审计里观测到的搜索次数（`"unobserved"` = 没有观测通路）。 */
  readonly observedSearches: number | typeof OBSERVATION_UNAVAILABLE;
  readonly adrPaths: readonly string[];
}): SearchBlock {
  const src = mandatorySourceBlock(o.mandatoryDomains, o.bundle);
  if (!src.ok) return src;
  // 下面两发是**同一件事的两个方向**，都只在有观测通路时判
  //（没有观测通路时事前那条 unobservedSearchBlock 已经拦过强制领域那一档）：
  //   ① 该搜的领域：包里有 URL 而审计里没搜过 ⇒ URL 来路不明；
  //   ② 不该搜的领域：审计里搜过而包里没 URL ⇒ 搜来的东西被复述进了主张。
  // 只判其中一个会留一条绕过：只判 ①，就没人拦「随意搜索而不留来源」。
  if (o.observedSearches !== OBSERVATION_UNAVAILABLE) {
    if (o.mandatoryDomains.length > 0) {
      const obs = mandatorySearchObservedBlock(o.mandatoryDomains, o.observedSearches);
      if (!obs.ok) return obs;
    } else {
      const url = searchResultUrlBlock({ searched: o.observedSearches > 0, bundle: o.bundle });
      if (!url.ok) return url;
    }
  }
  return adrEvidenceBlock(o.bundle, o.adrPaths);
}


/* ═════════════════ 接进门控：让「打回」真的是门控打回 ═════════════════ */

/* ═════════════════ 注入那一侧：岗位书 → mandatoryDomains ═════════════════ */

/**
 * `mandatoryDomains` 的**正牌来源**。文件头那条 ⭐ 说「必须从岗位书注入，
 * 不接受从证据包内容里推」，而这句话在接线之前一直缺一个具体的读取点 ——
 * 没有它，接线的人只能自己决定读哪儿，而最省事的那一处恰好就是包（0033 §2）。
 *
 * 所以这一发的形状是判据：**入参类型里只有岗位书，没有 bundle**，
 * 想从包里推就编译不过。这不是装饰，是本层唯一一处能被编译器兑现的立场。
 *
 * `null` 的语义是「这个任务没有岗位书可读」，此时交回 `null` 而不是 `[]`：
 * `[]` 在下游是「无强制领域 ⇒ 第 1 层不适用 ⇒ 放行」，
 * 而「没有岗位书」不等于「岗位书批准了不搜」。调用方必须自己决定 `null` 怎么办
 * （本篇的处置与它的代价在 0033 §6）。
 */
export function charterMandatoryDomains(
  c: Pick<Charter, "searchPolicy"> | null | undefined,
): readonly string[] | null {
  // `undefined` 与 `null` 合并：两者的语义都是「没有岗位书可读」，
  // 而合并的方向是**安全**的那一侧 —— 两者都落到 unresolved（吵），不是放行。
  // 分成两支会得到两条措辞不同的报错，而它们要的修法一模一样。
  if (c === null || c === undefined) return null;
  // 缺 searchPolicy 与它有而 mandatoryDomains 为空，到这里都归 `[]`：
  // 那一格在 YAML 里长什么样是**加载期**的事（contracts 的 transform 负责），
  // 判定层不问「为什么是空」，只按空处理 —— 少一个分支就少一处能漂的地方。
  return c.searchPolicy?.mandatoryDomains ?? [];
}

/**
 * 把第 1 层接成 `evaluateGate` 的一个判据注入点。
 *
 * 为什么需要这个函数而不是让调用方自己判 `mandatorySourceBlock` 再决定：
 * 计划 Test 项写的是「**门控**直接打回（不是警告）」。如果判据在门控**外面**，
 * 那么它拦不拦取决于调用方记得不记得判一次 —— 而 §8.2 第 4 条的立场是
 * 门控绑定在边上、不可绕过。判据在门控外面躺着，是这一路记过多次的同一族缺口
 * （`HANDOFF_BUNDLE_TYPES` 曾零调用方、`searchEvents` 曾 22 例零调用方）。
 *
 * 走的是**已有的注入点**（`GateInput.criteriaEvaluator`）而不是给 evaluateGate 加参数：
 * 那个注入点存在的理由就是「内核不解析自由文本，语义由调用方给」（evaluate.ts 文件头）。
 * 内核一行没改，这是它设计出来给人用的样子。
 *
 * 口径：condition 写 `search:mandatory_sources` 时按第 1 层判。
 * **只有这一串精确匹配**才判 —— 不做前缀/模糊匹配，理由与 matchDomains 同一句：
 * 一条宽匹配会给出「配了个别的名字而它其实没在判」的假防线，
 * 而那比没配更难查（岗位书看起来写了东西）。
 *
 * ⚠ 这个串**不在这里定义**，它是 `@opc/contracts` 那个常量的一份别名。
 * 理由与上面那句是同一条：定义漂了的话，「岗位书写了一条而判定方不认」正好是
 * 那条宽匹配想防的东西，而漂的方式（各改一份）比写错名字更安静。
 * 那一侧的 schema 还用它判「声明了领域而没写这条标准」（0034 §1），
 * 所以这份定义现在有**两个**读者，复制一份等于让两个读者各读一本书。
 */
export const MANDATORY_SOURCES_CONDITION = SEARCH_MANDATORY_SOURCES_CONDITION;

export function makeSearchCriteriaEvaluator(o: {
  /**
   * 本任务命中的强制领域（**注入**，见文件头那条 ⭐）。
   *
   * `null` = **没有岗位书可读**，与 `[]`（岗位书说过而领域为空）是两件事：
   * `[]` 判 satisfied（不适用），`null` 判 unresolved（判不了 ⇒ 升级人工）。
   * 把 `null` 折进 `[]` 就是文件头那条 ⭐ 的反面 —— 那等于
   * 「拿不到岗位书 ⇒ 自动免检」，而「不接岗位书」不需要改任何代码，
   * 只需要装配时不传（与 `observedSearches` 那一格同一个攻击面）。
   */
  readonly mandatoryDomains: readonly string[] | null;
  /** 审计观测到的搜索次数；`"unobserved"` = 无观测通路。 */
  readonly observedSearches: number | typeof OBSERVATION_UNAVAILABLE;
  /** 内建的 metric 判据兜底（其余 condition 交回给它，不吞掉）。 */
  readonly fallback: CriteriaEvaluator;
}): CriteriaEvaluator {
  return (criterion, bundle) => {
    if (criterion.condition.trim() !== MANDATORY_SOURCES_CONDITION) {
      return o.fallback(criterion, bundle);
    }
    if (o.mandatoryDomains === null) {
      return {
        status: "unresolved",
        why:
          "这条标准要求知道【本任务那个角色的哪些领域必须搜过】，而这个任务**没有岗位书可读**，" +
          "所以第 1 层今天判不了。**不**按『无强制领域』放行：那是把『装配时没接岗位书』" +
          "变成一次免检（不接岗位书不需要改代码，只需要不传）。" +
          "修法二选一：① 装配时交出这个角色那份岗位书；② 承认这一层判不了，" +
          "把这条标准从岗位书里摘掉而不是留着让它每次吵。",
      };
    }
    if (o.mandatoryDomains.length === 0) {
      // 没声明强制领域 ⇒ 这条标准**不适用**，判 satisfied。
      // 不是 unresolved：不适用与判不了是两件事，后者会触发升级而前者不该。
      return { status: "satisfied" };
    }
    // ⭐ 领域名不认识 ⇒ **unresolved**，而不是跟着下面的 violated 走。
    // 这是本篇接线时改掉的一个映射。理由：`violated` 出门只有岗位书里那条 message
    // （`CriterionOutcome` 的 violated 分支**没有 why** —— 内核刻意不让注入方改写门控措辞），
    // 而那条 message 写的是「强制搜索领域必须附带可追溯来源」。
    // 于是一个**岗位书写错了领域名**的人，看到的报错是「你没附来源」——
    // 他会去让 agent 补引用，补完照旧每次打回，而该改的是一个 YAML 键值。
    // （0032 §2 那条「不对症的报错」的又一发，只是这次不对称来自**门控的输出形状**不在我手里。）
    // `unresolved` 带得出 why，而配置错误本来就不是「作者不合格」而是「这条判据不成立」⇒ escalate 人工。
    const unknown = o.mandatoryDomains.filter((d) => !isFastChangingDomain(d));
    if (unknown.length > 0) {
      return {
        status: "unresolved",
        why:
          "岗位书声明的强制搜索领域里有**这层不认得**的名字 [" + unknown.join(", ") + "]，" +
          "所以这条标准本身不成立（不是产出不合格）。" +
          "FAST_CHANGING_DOMAINS 是【规格】§13.3 那张表的四条：" +
          FAST_CHANGING_DOMAINS.join(" / ") + "。" +
          "⚠ 已知的一处对不上：【规格】附录 B.3 给技术总监那份写的四个名字 " +
          "(framework_version_compat / api_deprecation / security_advisory / benchmark) " +
          "与这四条**一个都不相同**（0033 §2 量过：交集为空）。要么改 YAML 用上面那四条，" +
          "要么改那张表（= 改规格 = CEO 的事），**别**在这里加一层模糊匹配。",
      };
    }
    const src = mandatorySourceBlock(o.mandatoryDomains, bundle);
    if (!src.ok) return { status: "violated" };
    if (o.observedSearches === OBSERVATION_UNAVAILABLE) {
      // 包里写了 URL 但我们**看不见**有没有真搜过 ⇒ 判不了，而不是判过。
      // 这一格必须是 unresolved 而不是 satisfied：satisfied 会让「关掉观测通路」
      // 成为一条把第 1 层从「要真搜过」降级成「要写个 URL」的通路，
      // 而那条通路不需要改任何代码，只需要不传审计。
      return {
        status: "unresolved",
        why:
          "包里有外部来源引用，但**没有搜索观测通路**，无法确认那次搜索真的发生过" +
          "（编一条 URL 在这一判据下完全合格）。",
      };
    }
    const obs = mandatorySearchObservedBlock(o.mandatoryDomains, o.observedSearches);
    return obs.ok ? { status: "satisfied" } : { status: "violated" };
  };
}

/* ═════════════════ 一次调用的总判定（事前） ═════════════════ */

export interface SearchPolicyInput {
  /**
   * 岗位书声明的强制搜索领域（**注入**，见文件头那条 ⭐）。`null` = 没有岗位书可读。
   *
   * ⚠ 这里 `null` **不**拦下这次搜索，而门控那一遍会因同一个 `null` 判 unresolved。
   * 这不是口径不一致，是两遍要答的问题本来不同：
   *   · 事前这一遍答「**这次能不能发起搜索**」。没有岗位书 ⇒ 说不出「这个领域必须搜过」，
   *     但也没有任何依据说「不许搜」——拦一次合法的联网去要一份岗位书，
   *     修的人在电话里会被绕住（「那你先给我岗位书我才让 agent 查个版本号」）。
   *   · 事后那一遍答「**这份产出够不够格往下走**」，那一问**必须有**岗位书才答得出，
   *     所以那里判不了就该吵（`makeSearchCriteriaEvaluator` 的 null 分支）。
   * 于是缺岗位书的代价**恰好落一次**，落在有人读的地方，而不是把每次搜索都停掉。
   * 这一格的选择与代价记在 0033 §6。
   */
  readonly charterMandatoryDomains: readonly string[] | null;
  /** 本次任务实际落在这四个领域里的哪几个（由任务声明匹配，见 `matchDomains`）。 */
  readonly taskDomains: readonly string[];
  /** 岗位书是否禁止该角色联网。 */
  readonly prohibited: boolean;
  readonly judgment: SearchJudgment;
  readonly spentCents?: number | null;
  readonly limitCents?: number | null;
  readonly thresholds?: SearchBudgetThresholds;
  /** 审计里观测到的搜索次数；**没有观测通路时传 `unobserved` 而不是 0**。 */
  readonly observedSearches: number | "unobserved";
}

export const OBSERVATION_UNAVAILABLE = "unobserved" as const;

export interface SearchPolicyVerdict {
  readonly decision: SearchDecision;
  readonly mandatoryDomains: readonly FastChangingDomain[];
  readonly reason: string;
  /** 第 3 层落到的那一档（`within` / `tech_lead` / `ceo` / `unknown`）。 */
  readonly budgetTier: BudgetDecision["tier"];
  /** 需要谁批（第 3 层触发时）。 */
  readonly approver?: "tech_lead" | "ceo";
}

/**
 * 任务领域 ∩ 规格那四条。**不做语义匹配**：
 * 「这个任务算不算涉及框架版本」这种判断留给**声明**（任务自己列 domains），
 * 我按字面比。理由与 `branchIsOnMain` 只认 main/master 同一句（0022 §7 第 3 条）：
 * 列一条离线核验不了的匹配规则，会换来「在那个任务里照样放行」。
 * 匹配不上的名字**报错**（见 `mandatorySourceBlock` 里那条 unknown 检查），不静默丢弃 ——
 * 静默丢弃会让「岗位书写了个领域而从不生效」变成永久的。
 */
export function matchDomains(
  declared: readonly string[],
  charter: readonly string[],
): FastChangingDomain[] {
  return charter.filter(isFastChangingDomain).filter((d) => declared.includes(d));
}

export function searchPolicy(input: SearchPolicyInput): SearchPolicyVerdict | SearchBlock {
  // `null`（没有岗位书）在这一遍按**无强制领域**走：理由与代价写在
  // `SearchPolicyInput.charterMandatoryDomains` 那一格（一句话：事前拦的是「一次合法的联网」，
  // 事后判不了吵一次才对；两处都拦会把缺装配变成整条链路停工）。
  const mandated = matchDomains(
    input.taskDomains,
    input.charterMandatoryDomains ?? [],
  );
  const budget = searchBudgetTier(input.spentCents, input.limitCents, input.thresholds);

  // 顺序是有语义的（0022 §6 第 7 条：同一个输入命中多条判据时，报哪条取决于顺序）：
  // 资格（禁止）→ 义务（强制领域）→ 成本（预算）→ 程序（显式判断）。
  // 反过来会给出误导性的修法：一个被禁止联网的角色，如果先命中预算判据，
  // 当事人会去查预算配置而问题根本不在那里。
  const proh = prohibitedBlock(input.prohibited, mandated);
  if (!proh.ok) return proh;

  if (mandated.length > 0) {
    const obs: SearchBlock =
      input.observedSearches === OBSERVATION_UNAVAILABLE
        ? unobservedSearchBlock(mandated)
        : mandatorySearchObservedBlock(mandated, input.observedSearches);
    if (!obs.ok) return obs;
    return {
      decision: "required",
      mandatoryDomains: mandated,
      budgetTier: budget.tier,
      reason:
        "强制搜索领域 [" + mandated.join(", ") + "]：本层的结论必须建立在外部来源上。" +
        "包里那条 URL 还得过 mandatorySourceBlock 那一发（这一发只证明**搜过**）。",
    };
  }

  // 第 3 层在判断之前：成本闸是** Gateway 强制**的（规格原话），
  // 它不该等 Agent 先表态再生效。
  // 收窄而不是断言：`budget` 是判别联合，tier 一判 ratio 就在类型里了。
  // （断言能过编译，但它把「这里真的只有这两档」这件事从类型检查手里拿走了。）
  if (budget.tier === "tech_lead" || budget.tier === "ceo") {
    const ratio: number = budget.ratio;
    return {
      decision: "needs_approval",
      mandatoryDomains: [],
      budgetTier: budget.tier,
      approver: budget.tier,
      reason:
        "搜索成本已达任务预算的 " + Math.round(ratio * 100) +
        "%，后续搜索需 [" + budget.tier + "] 批准（【规格】§13.3 第 3 层）。",
    };
  }
  if (budget.tier === "unknown") {
    return {
      decision: "needs_approval",
      mandatoryDomains: [],
      budgetTier: "unknown",
      approver: "tech_lead",
      reason:
        "预算那一维判不了 ⇒ 按『要批』处理：" + budget.why +
        "\n为什么不是『按没超处理』：那会让『不接预算上报』成为绕过第 3 层的通路。",
    };
  }

  const j = judgmentBlock(input.judgment);
  if (!j.ok) return j;
  // 同样靠收窄：judgmentBlock 放过之后，judgment 仍可能是 { declared: false }
  // 吗？不会 —— 那条分支它拒了。但类型不知道，所以这里**显式判**而不是断言。
  if (!input.judgment.declared) {
    return {
      ok: false,
      code: "no_judgment_declared",
      reason: "judgmentBlock 放过了一个未表态的判断 —— 这两处的口径漂了。",
    };
  }
  const needs: boolean = input.judgment.needsSearch;
  return {
    decision: needs ? "allowed_by_judgment" : "skipped_by_judgment",
    mandatoryDomains: [],
    budgetTier: "within",
    reason:
      "第 2 层：Agent 显式判断" + (needs ? "参数化知识不足 ⇒ 允许搜索" : "知识够用 ⇒ 不搜") +
      "，理由进审计（【规格】§13.3 第 2 层要的就是这个可审计性）。",
  };
}
