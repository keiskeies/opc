/**
 * Task 5.7 的三层搜索策略测试（【规格】§13.3 / §13.2 末段）。
 *
 * 计划点名的三条 Test：
 *   ① 被标「强制搜索」的领域而证据包无来源引用 ⇒ **门控直接打回**（不是警告）；
 *   ② 搜索结果进入证据包并**带来源 URL**；
 *   ③ 技术总监的搜索结论**不得直接变成架构决策**，必须落成 ADR 证据。
 *
 * ── 这一组最该被记住的是「第 1 层有两个强度」那一条 ────────────────
 * 【规格】的字面要求是「包里有没有来源引用」，而那一判据**编一个 URL 就绕过**
 * （编 URL 比编覆盖率数字还省事：没有数值范围可对账）。
 * 所以本文件同时钉住字面判据与观测判据，并明确**前者拦不住后者拦的那种写法** ——
 * 只留一条的话，留下来的那条给的是它给不了的保证。
 *
 * ── 「判不了 ⇒ 要批」那两条是本文件的方向声明 ──────────────────────
 * 预算读不到、阈值没配、阈值配反 ⇒ 一律要批，不是放行。
 * 反过来（判不了当没超）会让「不接预算上报」成为一条绕过第 3 层的通路。
 */
import type { EvidenceBundle } from "@opc/contracts";
import { isExternalSourceRef } from "@opc/contracts";
import { describe, expect, it } from "vitest";
import { evaluateGate, metricCriteriaEvaluator } from "../../src/graph/gates/evaluate.js";
import {
  adrEvidenceBlock,
  deprecationEscalationBlock,
  FAST_CHANGING_DOMAINS,
  isFastChangingDomain,
  makeSearchCriteriaEvaluator,
  judgmentBlock,
  mandatorySearchObservedBlock,
  mandatorySourceBlock,
  matchDomains,
  OBSERVATION_UNAVAILABLE,
  prohibitedBlock,
  SEARCH_DECISIONS,
  SEARCH_REJECT_CODES,
  searchBudgetTier,
  searchEvidenceGate,
  searchPolicy,
  searchResultUrlBlock,
  type SearchBudgetThresholds,
  type SearchJudgment,
  unobservedSearchBlock,
} from "../../src/search/policy.js";

const SHA: string = "b".repeat(64);
const URL1 = "https://example.com/advisory/CVE-2026-0001";

function bundle(over: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    bundle_id: "00000000-0000-4000-8000-000000000001",
    task_id: "task-1",
    bundle_type: "design",
    produced_by_role: "tech_lead",
    produced_by_model_family: "claude",
    artifacts: [{ path: "notes.md", sha256: SHA, bytes: 10 }],
    claims: [{ text: "结论 A", evidence_refs: [URL1] }],
    honesty_boundaries: [],
    ...over,
  };
}

const THRESHOLDS: SearchBudgetThresholds = { techLeadRatio: 0.6, ceoRatio: 0.9 };
const DECLARED: SearchJudgment = { declared: true, needsSearch: true, reason: "参数化知识停在两个版本前" };

function input(over: Partial<Parameters<typeof searchPolicy>[0]> = {}) {
  return {
    charterMandatoryDomains: ["security_advisories"] as string[],
    taskDomains: [] as string[],
    prohibited: false,
    judgment: DECLARED,
    spentCents: 10,
    limitCents: 1000,
    thresholds: THRESHOLDS,
    observedSearches: 0,
    ...over,
  };
}

describe("第 1 层：强制搜索领域", () => {
  it("⭐ 计划点名那条：无来源引用 ⇒ **reject**（不是 warning、不是 escalate）", () => {
    const b = mandatorySourceBlock(["security_advisories"], bundle({ claims: [] }));
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.code).toBe("no_source_for_mandatory_domain");
    // 一条外部 URL 就放行（口径是【有没有】，不是【够不不够】—— 后者判不了，见下）。
    expect(mandatorySourceBlock(["security_advisories"], bundle()).ok).toBe(true);
  });

  it("领域名没听过 ⇒ 独立的一个码，**不借用**『缺来源』那个", () => {
    // 借用的话，报错会说「你没带来源」而真相是「岗位书写了个不存在的领域」——
    // 两者修法完全不同（补证据 vs 改岗位书/改规格表）。
    const b = mandatorySourceBlock(["vibe_coding_trends"], bundle());
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.code).toBe("unknown_mandatory_domain");
  });

  it("规格那四条领域是**照抄**的，且不接受现场加一项", () => {
    expect(FAST_CHANGING_DOMAINS).toEqual([
      "competitive_landscape",
      "framework_versions",
      "pricing_benchmarks",
      "security_advisories",
    ]);
    expect(isFastChangingDomain("security_advisories")).toBe(true);
    expect(isFastChangingDomain("framework_version")) .toBe(false); // 少个 s 就是没听过
  });

  it("⭐⭐ 第 1 层的**两个强度**：字面判据放过的，观测判据拦得住", () => {
    // 这一条是本文件存在的理由。一个编造的 URL 在【规格】字面判据下完全合格，
    // 而「编一个 URL」比「编一个覆盖率数字」更省事（后者至少还有个范围会被对账）。
    const fabricated = bundle({
      claims: [{ text: "该框架已停止维护", evidence_refs: ["https://never-fetched.invalid/x"] }],
    });
    expect(mandatorySourceBlock(["framework_versions"], fabricated).ok).toBe(true);
    const obs = mandatorySearchObservedBlock(["framework_versions"], 0);
    expect(obs.ok).toBe(false);
    if (!obs.ok) expect(obs.code).toBe("mandatory_source_not_observed");
    // 真搜过一次就放行（这一条判的是搜过没有，不管包里写了什么）。
    expect(mandatorySearchObservedBlock(["framework_versions"], 1).ok).toBe(true);
  });

  it("没有观测通路 ⇒ 拒，且**不允许**用传 0 之外的方式混过去", () => {
    const b = unobservedSearchBlock(["pricing_benchmarks"]);
    expect(b.ok).toBe(false);
    // 反向对照：没有强制领域时这一条不该拦（否则「没观测通路」会拦掉所有任务）。
    expect(unobservedSearchBlock([]).ok).toBe(true);
  });

  it("领域取的是 任务声明 ∩ 岗位书，匹配不上的名字**报错**而不是丢弃", () => {
    expect(matchDomains(["framework_versions", "unrelated"], ["framework_versions"])).toEqual([
      "framework_versions",
    ]);
    // 岗位书写了个规格表里没有的名字：不静默丢，丢了就变成「那条声明永不生效」而没人知道。
    const b = mandatorySourceBlock(["team_internal_jargon"], bundle());
    expect(b.ok).toBe(false);
  });
});

describe("第 2 层：显式判断（可审计性本身是产物）", () => {
  it("没表态 ⇒ 拒，且报的是『没留决策过程』而不是『不许搜』", () => {
    const b = judgmentBlock({ declared: false });
    expect(b.ok).toBe(false);
    if (!b.ok) {
      expect(b.code).toBe("no_judgment_declared");
      expect(b.reason).toContain("有没有把决定过程留下来");
    }
  });

  it("表态了而理由为空 ⇒ 拒（空理由与没判断等价，且它看起来满足了一条要求）", () => {
    const b = judgmentBlock({ declared: true, needsSearch: true, reason: "   " });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.code).toBe("judgment_without_reason");
  });

  it("⭐ 判断为【不搜】也放行 —— 这一层拦的是没表态，不是搜太多", () => {
    // 反过来说才成立：如果 needsSearch=false 被拒，Agent 学会的就是「随便找个理由去搜」，
    // 而【规格】明确反对默认搜索。这一发钉的是那一侧。
    const v = searchPolicy(
      input({ judgment: { declared: true, needsSearch: false, reason: "索引原理是稳定知识" } }),
    );
    if (!("ok" in v)) expect(v.decision).toBe("skipped_by_judgment");
  });
});

describe("第 3 层：预算降级（判不了 ⇒ 要批）", () => {
  it("四档阈值：within / tech_lead / ceo 各就各位", () => {
    expect(searchBudgetTier(100, 1000, THRESHOLDS).tier).toBe("within");
    expect(searchBudgetTier(600, 1000, THRESHOLDS).tier).toBe("tech_lead");
    expect(searchBudgetTier(950, 1000, THRESHOLDS).tier).toBe("ceo");
  });

  it("⭐ 成本或上限拿不到 ⇒ unknown ⇒ **要批**，不是按没超处理", () => {
    for (const [s, l] of [[null, 1000], [10, null], [undefined, 1000], [10, 0]] as const) {
      const d = searchBudgetTier(s, l, THRESHOLDS);
      expect(d.tier).toBe("unknown");
    }
    const v = searchPolicy(input({ spentCents: null }));
    if (!("ok" in v)) {
      expect(v.decision).toBe("needs_approval");
      expect(v.approver).toBe("tech_lead");
    }
  });

  it("⭐ 阈值配反 ⇒ 拦（配反的阈值让 CEO 那一档永不触发而看起来仍在防）", () => {
    const d = searchBudgetTier(9999, 1, { techLeadRatio: 0.9, ceoRatio: 0.5 });
    expect(d.tier).toBe("unknown");
    if (d.tier === "unknown") expect(d.why).toContain("非法");
  });

  it("阈值**没有默认值**（规格没说那个比例是多少，我不编）", () => {
    const d = searchBudgetTier(999, 1000, undefined);
    expect(d.tier).toBe("unknown");
    if (d.tier === "unknown") expect(d.why).toContain("不编");
  });

  it("升级对象随金额变（规格那句『取决于金额』）", () => {
    const v = searchPolicy(input({ spentCents: 950 }));
    if (!("ok" in v)) expect(v.approver).toBe("ceo");
  });
});

describe("计划多出来的那一层：显式禁止", () => {
  it("禁止 ⇒ 拒；与强制领域**同时**声明时也拒（按禁止处理）", () => {
    expect(prohibitedBlock(true, []).ok).toBe(false);
    const both = prohibitedBlock(true, ["security_advisories"]);
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.reason).toContain("配置矛盾");
    expect(prohibitedBlock(false, []).ok).toBe(true);
  });

  it("⭐ 禁止**先于**预算判（否则报错会把人引去查预算配置）", () => {
    const v = searchPolicy(input({ prohibited: true, spentCents: 999 }));
    expect("ok" in v).toBe(true);
    if ("ok" in v && !v.ok) expect(v.code).toBe("prohibited_by_charter");
  });
});

describe("② 搜索结果必须带来源 URL", () => {
  it("观测到搜索而包里没 URL ⇒ 拒（复述搜来的内容 + refs 指向自己笔记）", () => {
    const noUrl = bundle({
      claims: [{ text: "这个框架已经不维护了", evidence_refs: ["notes.md"] }],
    });
    expect(searchResultUrlBlock({ searched: true, bundle: noUrl }).ok).toBe(false);
    // 反向对照：没搜索时这一条**不该**拦（否则普通任务全被要求带外链）。
    expect(searchResultUrlBlock({ searched: false, bundle: noUrl }).ok).toBe(true);
  });

  it("包内引用不算来源（notes.md 在 artifacts 里，§8.1 那关它是过的）", () => {
    expect(isExternalSourceRef("notes.md")).toBe(false);
    expect(isExternalSourceRef("https://x.dev/a")).toBe(true);
    expect(isExternalSourceRef("http://x.dev/a")).toBe(true);
    expect(isExternalSourceRef("ftp://x.dev/a")).toBe(false);
  });
});

describe("③ 搜索结论不得直接变成架构决策", () => {
  it("⭐ 依据**全是**外部链接的 claim ⇒ 必须指向一份 ADR", () => {
    const b = bundle({ claims: [{ text: "选 Postgres", evidence_refs: [URL1] }] });
    expect(adrEvidenceBlock(b, []).ok).toBe(false);
    // 空名单与「有名单但这条 claim 没引用它」是两种坏法，报错一样而修法不同，都得判住。
    expect(adrEvidenceBlock(b, ["adr-0004.md"]).ok).toBe(false);
    const withAdr = bundle({
      claims: [{ text: "选 Postgres", evidence_refs: [URL1, "adr-0004.md#备选方案"] }],
    });
    expect(adrEvidenceBlock(withAdr, ["adr-0004.md"]).ok).toBe(true);
  });

  it("⭐ 判据收在【全是】而不是【有】：正常调研不能被全拦住", () => {
    // 拦法太宽的第一后果不是合规，是更精心的规避：人们开始给内部制品编 URL。
    const mixed = bundle({
      claims: [{ text: "基准测试显示 X 快 3 倍", evidence_refs: [URL1, "bench.json"] }],
    });
    expect(adrEvidenceBlock(mixed, []).ok).toBe(true);
  });

  it("ADR 名单是**注入**的，不按文件名猜（改名即绕过 ⇒ 猜规则等于没规则）", () => {
    const b = bundle({ claims: [{ text: "选 Postgres", evidence_refs: [URL1] }] });
    expect(adrEvidenceBlock(b, ["decisions/db.md"]).ok).toBe(false);
    expect(adrEvidenceBlock(b, ["decisions/db.md", "x"]).ok).toBe(false);
  });

  it("发现依赖即将废弃 ⇒ **必须**升级，不给『已处理』的出口", () => {
    expect(deprecationEscalationBlock(false).ok).toBe(true);
    const b = deprecationEscalationBlock(true);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.code).toBe("escalation_required");
  });
});

describe("事前 / 事后两遍", () => {
  it("强制领域在**事前**要求观测到搜索，事后要求包里有来源", () => {
    const pre = searchPolicy(input({ taskDomains: ["security_advisories"], observedSearches: 3 }));
    if ("ok" in pre) throw new Error("不应被拒");
    expect(pre.decision).toBe("required");
    const blocked = searchPolicy(input({ taskDomains: ["security_advisories"], observedSearches: 0 }));
    expect("ok" in blocked).toBe(true);

    const post = searchEvidenceGate({
      bundle: bundle({ claims: [] }),
      mandatoryDomains: ["security_advisories"],
      observedSearches: 3,
      adrPaths: [],
    });
    expect(post.ok).toBe(false);
  });

  it("事后那一遍的两个方向都判：该搜的没搜 / 搜了不留来源", () => {
    const shouldSearchDidnt = searchEvidenceGate({
      bundle: bundle(),
      mandatoryDomains: ["framework_versions"],
      observedSearches: 0,
      adrPaths: [],
    });
    expect(shouldSearchDidnt.ok).toBe(false);
    const searchedNoUrl = searchEvidenceGate({
      bundle: bundle({ claims: [{ text: "x", evidence_refs: ["notes.md"] }] }),
      mandatoryDomains: [],
      observedSearches: 2,
      adrPaths: [],
    });
    expect(searchedNoUrl.ok).toBe(false);
  });

  it("没有观测通路时事后那一遍**不假装**判过（跳过观测类判据）", () => {
    // ⚠ 夹具这一发写错过一次：本来用 bundle()，而它的默认 claim 依据**全是**外部链接，
    // 于是被 ADR 那一批发掉 —— 报错说的是 ADR，我要测的却是观测通路。
    // 「一条判据红在另一条判据上」是最容易误诊的一族红。
    const g = searchEvidenceGate({
      bundle: bundle({ claims: [{ text: "本地依据", evidence_refs: ["notes.md"] }] }),
      mandatoryDomains: [],
      observedSearches: OBSERVATION_UNAVAILABLE,
      adrPaths: [],
    });
    expect(g.ok).toBe(true);
    // 反向对照：同一份包配上【强制领域】就该红（缺来源那一发），
    // 否则上面那条绿只是因为整遍没跑。
    const strict = searchEvidenceGate({
      bundle: bundle({ claims: [{ text: "本地依据", evidence_refs: ["notes.md"] }] }),
      mandatoryDomains: ["security_advisories"],
      observedSearches: OBSERVATION_UNAVAILABLE,
      adrPaths: [],
    });
    expect(strict.ok).toBe(false);
  });

  it("预算闸在**判断之前**生效（它是 Gateway 强制的，不等 Agent 表态）", () => {
    const v = searchPolicy(
      input({ spentCents: 950, judgment: { declared: false } }),
    );
    if ("ok" in v) throw new Error("应给出结论");
    expect(v.decision).toBe("needs_approval");
  });
});

describe("接进门控：让『打回』真的是**门控**打回", () => {
  const CONDITION = "search:mandatory_sources";

  function gateWith(o: {
    mandatoryDomains: string[];
    observedSearches: number | typeof OBSERVATION_UNAVAILABLE;
    bundle: EvidenceBundle;
  }) {
    return evaluateGate({
      gate: "tech_to_dev",
      producer: { roleId: "tech_lead", modelFamily: "claude" },
      // bundle_type 得配得上 gate，否则会先撞类型那一发而测不到搜索判据（Task 5.4 刚踩过）。
      bundle: { ...o.bundle, bundle_type: "design" },
      criteria: [{ condition: CONDITION, action: "reject", message: "强制搜索领域缺来源" }],
      reviewer: { roleId: "architect", modelFamily: "gpt" },
      // 不传的话门控记一条「完整性未对账」的 unresolved ⇒ 顶成 escalate，
      // 那我就测不到搜索判据了（Task 5.4 里刚为同一格写过一整条用例）。
      integrityOk: true,
      criteriaEvaluator: makeSearchCriteriaEvaluator({
        mandatoryDomains: o.mandatoryDomains,
        observedSearches: o.observedSearches,
        fallback: metricCriteriaEvaluator,
      }),
    });
  }

  it("⭐ 计划点名那条走的是**门控**：decision = reject", () => {
    const v = gateWith({
      mandatoryDomains: ["security_advisories"],
      observedSearches: 2,
      bundle: bundle({ claims: [] }),
    });
    expect(v.decision).toBe("reject");
    expect(v.reasons.join(" ")).toContain("强制搜索领域缺来源");
  });

  it("搜过且包里有 URL ⇒ pass", () => {
    const v = gateWith({
      mandatoryDomains: ["security_advisories"],
      observedSearches: 2,
      bundle: bundle(),
    });
    expect(v.decision).toBe("pass");
  });

  it("⭐⭐ 包里有 URL 而**没搜过** ⇒ 门控 reject（这条是变异实验补出来的）", () => {
    // 这一条是**跑完变异实验才补的**：把 `observedSearches` 那一支改成恒 satisfied
    // 之后**零红**，因为我所有门控用例都用 observedSearches: 2，
    // 于是「有 URL 但没搜过」这条最该被门控拦的路径**一次都没走过门控**。
    // 「变异存活」在这一层不是「那条判据不重要」，而是「我的用例分布有洞」——
    // 补一条正向用例（而不是删掉那条判据）才是正确反应。
    const v = gateWith({
      mandatoryDomains: ["security_advisories"],
      observedSearches: 0,
      bundle: bundle(), // 默认那条 claim 带着一条 https 引用
    });
    expect(v.decision).toBe("reject");
    // 与「包里也没 URL」那条的区别在**报错来自哪一发**：
    // 那一发是 mandatorySourceBlock（缺引用），这一发是 mandatorySearchObservedBlock（引用没被搜过支撑）。
    // 两发的 message 都由岗位书给，所以这里能分辨的只有「都 reject」——
    // 分辨得开的是上面那两条 block 级用例，这一条钉的是【门控真的会因为它 reject】。
  });

  it("⭐ 没有观测通路 ⇒ **escalate**（不是 pass）：关掉观测不该把『真搜过』降级成『写个 URL』", () => {
    // 这一条是这一组里最值钱的：unresolved ⇒ evaluateGate 末尾那条「有标准没判成 ⇒ 不能 pass」
    // 会把它顶成 escalate。若这里返回 satisfied，绕过第 1 层就**不需要改任何代码**，
    // 只需要调用方不传审计。
    const v = gateWith({
      mandatoryDomains: ["security_advisories"],
      observedSearches: OBSERVATION_UNAVAILABLE,
      bundle: bundle(),
    });
    expect(v.decision).toBe("escalate");
    expect(v.unresolved.join(" ")).toContain("观测");
  });

  it("没声明强制领域 ⇒ satisfied 而**不是** unresolved（不适用 ≠ 判不了）", () => {
    const v = gateWith({
      mandatoryDomains: [],
      observedSearches: 0,
      bundle: bundle({ claims: [{ text: "本地依据", evidence_refs: ["notes.md"] }] }),
    });
    expect(v.decision).toBe("pass");
    expect(v.unresolved).toEqual([]);
  });

  it("其他 condition 交回 fallback，**不被这一层吞掉**", () => {
    // 吞掉的形状：一切非 metric 的 condition 都走到这里返回 satisfied ⇒ 岗位书里
    // 所有别的标准全变绿。这一发钉的是「只认那一串精确匹配」。
    const v = evaluateGate({
      gate: "tech_to_dev",
      producer: { roleId: "tech_lead", modelFamily: "claude" },
      bundle: { ...bundle(), bundle_type: "design" },
      criteria: [{ condition: "metric:coverage < 90", action: "reject", message: "覆盖率不足" }],
      reviewer: { roleId: "architect", modelFamily: "gpt" },
      // 不传的话门控记一条「完整性未对账」的 unresolved ⇒ 顶成 escalate，
      // 那我就测不到搜索判据了（Task 5.4 里刚为同一格写过一整条用例）。
      integrityOk: true,
      criteriaEvaluator: makeSearchCriteriaEvaluator({
        mandatoryDomains: ["security_advisories"],
        observedSearches: 5,
        fallback: metricCriteriaEvaluator,
      }),
    });
    // metrics 里没有 coverage ⇒ unresolved ⇒ escalate（fallback 的口径，不是本层的）。
    expect(v.decision).toBe("escalate");
    expect(v.unresolved.join(" ")).toContain("coverage");
  });

  it("condition 名字**近似**不认（宽匹配会造出一条看起来在防而实际没判的假防线）", () => {
    const v = evaluateGate({
      gate: "tech_to_dev",
      producer: { roleId: "tech_lead", modelFamily: "claude" },
      bundle: { ...bundle(), bundle_type: "design" },
      criteria: [
        { condition: "search:mandatory_source", action: "reject", message: "少个 s" },
      ],
      reviewer: { roleId: "architect", modelFamily: "gpt" },
      // 不传的话门控记一条「完整性未对账」的 unresolved ⇒ 顶成 escalate，
      // 那我就测不到搜索判据了（Task 5.4 里刚为同一格写过一整条用例）。
      integrityOk: true,
      criteriaEvaluator: makeSearchCriteriaEvaluator({
        mandatoryDomains: ["security_advisories"],
        observedSearches: 0,
        fallback: metricCriteriaEvaluator,
      }),
    });
    expect(v.decision).toBe("escalate");
    expect(v.unresolved.join(" ")).toContain("不是 metric:");
  });
});

describe("码表与取值表", () => {
  it("⭐ SEARCH_REJECT_CODES 每一个码都有返回点", () => {
    const seen = new Set<string>();
    const hit = (b: { ok: boolean; code?: string } | { ok: true }): void => {
      if (!b.ok && "code" in b && b.code !== undefined) seen.add(b.code);
    };
    hit(mandatorySourceBlock(["nope"], bundle()));
    hit(mandatorySourceBlock(["framework_versions"], bundle({ claims: [] })));
    hit(mandatorySearchObservedBlock(["framework_versions"], 0));
    hit(unobservedSearchBlock(["framework_versions"]));
    hit(judgmentBlock({ declared: false }));
    hit(judgmentBlock({ declared: true, needsSearch: true, reason: "" }));
    hit(prohibitedBlock(true, []));
    hit(searchResultUrlBlock({ searched: true, bundle: bundle({ claims: [] }) }));
    hit(adrEvidenceBlock(bundle({ claims: [{ text: "t", evidence_refs: [URL1] }] }), []));
    hit(deprecationEscalationBlock(true));
    // 预算那一维的两个码**不在**这张表里（它产出的是 verdict 而不是拒绝）。
    // 上面那条 SEARCH_DECISIONS 的用例钉的是同一件事的另一面。
    expect(SEARCH_REJECT_CODES).not.toContain("budget_unknown");
    expect(SEARCH_REJECT_CODES).not.toContain("over_search_budget");
    const over = searchPolicy(input({ spentCents: 950 }));
    if ("ok" in over) throw new Error("预算那一档该给结论而不是拒绝");
    expect(over.decision).toBe("needs_approval");
    const blocked = searchPolicy(input({ prohibited: true }));
    if ("ok" in blocked && !blocked.ok) seen.add(blocked.code);

    const missing = SEARCH_REJECT_CODES.filter((c) => !seen.has(c));
    if (missing.length > 0) throw new Error("没有返回点的码：" + missing.join(", "));
  });

  it("decision 取值表里**没有**永不产出的那一格", () => {
    // 「禁止」走的是 block 而不是 verdict。留一个取不到的值就是装饰。
    expect(SEARCH_DECISIONS).not.toContain("prohibited");
    expect(SEARCH_DECISIONS.length).toBe(4);
  });
});
