/**
 * Task 0.7 验收：岗位书是【结构化】契约，不是自由文本（规格 §3.2）。
 *
 * 为什么值得这么严：§3.2 指出早期岗位书写得像简历，「产出华丽但不合规」。把行业验收
 * 标准焊死在 schema 里，是这套系统能替 CEO 过滤审阅负担的前提（§23.2）。
 *
 * honesty_boundaries 与 version 在规格附录 B.1 的样例里【没有】，但计划 Task 0.7 明确
 * 要求「缺 honesty_boundaries / version 时必须拒绝加载」—— 意图是把 §14.4 红线二
 * （必须声明诚实边界）延伸到角色层。附录 B 是配置示例、不是 schema 全集，故以计划为准。
 * 本段注释存在的意义：防止将来有人「照着附录 B.1 把这两个字段删掉」。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHARTER_PLACEHOLDER_ACCEPTANCE,
  SEARCH_MANDATORY_SOURCES_CONDITION,
} from "@opc/contracts";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { templateFiles } from "../../src/charter/seed.js";
import {
  charterFieldPaths,
  loadCharterFile,
  loadCharterText,
  mergeForbiddenForRun,
} from "../../src/roles/loader.js";
import { NODE_TO_TEMPLATE } from "../../src/roles/preset.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = join(HERE, "..", "..", "resources", "charter-templates");
const SEVEN = ["ceo", "assistant", "product", "tech", "dev", "test", "ops"];

/*
 * 本文件【故意】按包名 import @opc/contracts，而不是相对路径 import 它的源码。
 * 实测过：contracts/package.json 当时既无 main 也无 exports，而此前全仓无人 import 它，
 * 所以「按包名到底能不能解析」从没红过。相对路径 import 会绕过 package exports，
 * 等于把这个洞永久藏起来。构建由 test/global-setup/build-contracts.ts 负责 ——
 * 【不能】在本文件里 beforeAll 构建：顶层 import 比钩子先解析，实测失败时 0 个测试会跑。
 */
/** 合法骨架：字段名与规格附录 B.1 / B.3 一一对应。 */
const BASE: Record<string, unknown> = {
  role_id: "test_engineer",
  display_name: "测试工程师",
  version: 1,
  reports_to: "tech_director",
  honesty_boundaries: ["不判定自己写过的代码为通过"],
  acceptance_criteria: [
    {
      condition: "coverage < 0.90",
      action: "reject",
      message: "覆盖率不足90%，不得标记通过",
    },
  ],
  forbidden_actions: [
    "approve_own_work",
    "modify_source_code",
    "merge_to_main",
  ],
  tool_permissions: ["read_repo", "run_tests", "create_review_report"],
  model_tier: "execution",
  budget: { daily_usd: 15, per_task_usd: 5 },
  escalation_triggers: ["review_conflict_rounds >= 3"],
  decision_scope: {
    autonomous: ["测试用例设计"],
    requires_consultation: ["跨模块集成测试范围变更 → consult: tech_director"],
    forbidden: ["修改源代码", "自行放行P0缺陷", "合并到主干"],
  },
  judgment_mode: {
    type: "bounded_judgment",
    strict_rules: ["coverage < 0.90 → reject"],
    bounded_judgment: ["P2缺陷是否可接受上线（需附风险评估）"],
    full_discretion: [],
  },
};

const DROP = "__DROP__";

/** 生成 YAML：overrides 里值为 DROP 的键【删除】而不是置 null —— 「缺失」和「为 null」是两件事 */
function yamlWith(overrides: Record<string, unknown>): string {
  const merged: Record<string, unknown> = { ...BASE };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === DROP) delete merged[k];
    else merged[k] = v;
  }
  return stringify(merged);
}

/**
 * 在夹具那一条之外，**再加**一条点了第 1 层的验收标准。
 *
 * condition 取 `SEARCH_MANDATORY_SOURCES_CONDITION` 而不是手抄那串字面量：
 * 本文件钉的那条判据读的就是那个常量，夹具若与它漂开，得到的形状是
 * 「岗位书写了一条而判定方不认」，而那个形状**不会红**（全绿 + 生产不判）。
 * 提到顶层是因为两个 describe 都用它（成对判据拒掉的就是「只写领域」那份夹具）。
 */
function withSearchCriterion(
  extra: { condition: string; action: "reject"; message: string }[] = [],
): Record<string, unknown>[] {
  return [
    ...(BASE.acceptance_criteria as Record<string, unknown>[]),
    {
      condition: SEARCH_MANDATORY_SOURCES_CONDITION,
      action: "reject" as const,
      message: "强制搜索领域必须附带可追溯来源",
    },
    ...extra,
  ];
}

/** 抓异常：断言异常里的字段路径比 toThrow(/字符串/) 更精确 */
function grab(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("期望抛错，但函数正常返回了");
}

describe("charter zod schema（Task 0.7）", () => {
  it("合法岗位书解析通过，且关键字段解析成预期值", () => {
    const c = loadCharterText(yamlWith({}), "inline");
    expect(c.roleId).toBe("test_engineer");
    expect(c.modelTier).toBe("execution");
    expect(c.acceptanceCriteria).toHaveLength(1);
    expect(c.decisionScope.forbidden).toContain("修改源代码");
  });

  it("缺 honesty_boundaries → 拒绝加载，并给出【字段路径】而非整坨原文", () => {
    const e = grab(() =>
      loadCharterText(yamlWith({ honesty_boundaries: DROP }), "x.yaml"),
    );
    expect(charterFieldPaths(e)).toContain("honesty_boundaries");
  });

  it("缺 version → 拒绝加载并给出字段路径", () => {
    const e = grab(() =>
      loadCharterText(yamlWith({ version: DROP }), "x.yaml"),
    );
    expect(charterFieldPaths(e)).toContain("version");
  });

  it("缺 acceptance_criteria → 拒绝加载并给出字段路径", () => {
    const e = grab(() =>
      loadCharterText(yamlWith({ acceptance_criteria: DROP }), "x.yaml"),
    );
    expect(charterFieldPaths(e)).toContain("acceptance_criteria");
  });

  it("version 为 null 与【缺失】都要拒，且路径都指向 version", () => {
    const missing = charterFieldPaths(
      grab(() => loadCharterText(yamlWith({ version: DROP }), "x.yaml")),
    );
    expect(missing).toContain("version");
    const nul = charterFieldPaths(
      grab(() => loadCharterText(yamlWith({ version: null }), "x.yaml")),
    );
    expect(nul).toContain("version");
  });

  it("嵌套字段缺失要给出【完整路径】，不能只说根字段错了", () => {
    const e = grab(() =>
      loadCharterText(
        yamlWith({
          acceptance_criteria: [
            { condition: "coverage < 0.90", message: "缺 action 字段" },
          ],
        }),
        "x.yaml",
      ),
    );
    expect(charterFieldPaths(e)).toContain("acceptance_criteria[0].action");
  });

  /*
   * ↓ 三条断言是变异测试逼出来的：第一轮变异里「honesty_boundaries 允许空数组」
   * 「version 放宽为任意 number」「acceptance_criteria 允许空」三个变异【全部存活】，
   * 因为我只测了 key 缺失，没测 key 在但值为空。而手写 YAML 时 acceptance_criteria: []
   * 比整段删掉更常见 —— 缺这一层，「焊死验收标准」这件事在最常用的错法上是没保护的。
   */
  it("honesty_boundaries 为空数组 → 拒绝加载（min(1)）：自认毫无局限的角色不可信", () => {
    const e = grab(() =>
      loadCharterText(yamlWith({ honesty_boundaries: [] }), "x.yaml"),
    );
    expect(charterFieldPaths(e)).toContain("honesty_boundaries");
  });

  it("acceptance_criteria 为空数组 → 拒绝加载：没有验收标准的岗位书就是自由文本", () => {
    const e = grab(() =>
      loadCharterText(yamlWith({ acceptance_criteria: [] }), "x.yaml"),
    );
    expect(charterFieldPaths(e)).toContain("acceptance_criteria");
  });

  it("version 必须为正整数：0 / 负数 / 小数都拒（§3.2 靠它定位任务运行时的岗位书版本）", () => {
    for (const bad of [0, -1, 1.5]) {
      const e = grab(() =>
        loadCharterText(yamlWith({ version: bad }), "x.yaml"),
      );
      expect(charterFieldPaths(e), "version=" + bad).toContain("version");
    }
  });

  it("forbidden 传空数组必须抛错：语义歧义（清空 还是 不追加？）不许靠猜", () => {
    const c = loadCharterText(yamlWith({}), "x.yaml");
    expect(() => mergeForbiddenForRun(c, { forbidden: [] })).toThrow(
      /语义歧义/,
    );
  });

  it("forbidden 里的空白条目必须抛错：拦不住行为却会在审计里显示成一条空条目", () => {
    const c = loadCharterText(yamlWith({}), "x.yaml");
    expect(() => mergeForbiddenForRun(c, { forbidden: ["   "] })).toThrow(
      /空白/,
    );
  });

  it("拼错字段名必须被拒（strict）：岗位书会被 CEO 手改，打错的约束等于没有约束", () => {
    const e = grab(() =>
      loadCharterText(yamlWith({ model_tier_typo: "management" }), "x.yaml"),
    );
    expect(charterFieldPaths(e).length).toBeGreaterThan(0);
  });

  it("model_tier 只接受规格枚举（§5.9 的映射表由它驱动）", () => {
    const e = grab(() =>
      loadCharterText(yamlWith({ model_tier: "cheap" }), "x.yaml"),
    );
    expect(charterFieldPaths(e)).toContain("model_tier");
  });

  it("judgment_mode.type 只接受 strict_rules | bounded_judgment | full_discretion（§4）", () => {
    const e = grab(() =>
      loadCharterText(
        yamlWith({
          judgment_mode: {
            type: "whatever",
            strict_rules: [],
            bounded_judgment: [],
            full_discretion: [],
          },
        }),
        "x.yaml",
      ),
    );
    expect(charterFieldPaths(e)).toContain("judgment_mode.type");
  });

  it("escalate 类验收标准必须带 target —— 否则「升级」不知道升给谁，会静默丢掉", () => {
    const e = grab(() =>
      loadCharterText(
        yamlWith({
          acceptance_criteria: [
            {
              condition: "p0_defect_count > 0",
              action: "escalate",
              message: "P0必须升级",
            },
          ],
        }),
        "x.yaml",
      ),
    );
    expect(charterFieldPaths(e)).toContain("acceptance_criteria[0].target");
  });
});

describe("§13.3 搜索策略那一格（0033 新加的可选字段）", () => {
  it("不写这一格 ⇒ 派生结果里【没有】searchPolicy，而不是一个空对象", () => {
    const c = loadCharterText(yamlWith({}), "x.yaml");
    // 「没写过」与「写过而留空」在回放里必须分得开：后者是 CEO 看过那一栏并清空了。
    expect(c.searchPolicy).toBeUndefined();
  });

  it("写了 tier_1_mandatory ⇒ 派生成 camelCase 的 mandatoryDomains", () => {
    const c = loadCharterText(
      yamlWith({
        search_policy: { tier_1_mandatory: ["security_advisories"] },
        acceptance_criteria: withSearchCriterion(),
      }),
      "x.yaml",
    );
    expect(c.searchPolicy?.mandatoryDomains).toEqual(["security_advisories"]);
  });

  it("写了这一格而没给名单 ⇒ 空数组（这是「声明了而没有领域」，与缺格不同）", () => {
    const c = loadCharterText(yamlWith({ search_policy: {} }), "x.yaml");
    expect(c.searchPolicy?.mandatoryDomains).toEqual([]);
    // 两态各归其位：缺格是 undefined、声明了而空是 []。若两者都是 []，
    // 「这个角色的领域还没定」与「定过了、答案是零个」就分不开了。
    expect(
      loadCharterText(yamlWith({}), "x.yaml").searchPolicy,
    ).toBeUndefined();
  });

  it("⭐ 只认 tier_1_mandatory：B.3 那两键进来必须被 strict 拒掉", () => {
    // 收进来而没人读 = 一个「配了而不生效」的键，比没这个键更坏。
    // 拒掉才是能被人看见的写法（理由在 contracts 里 searchPolicySchema 上面那段）。
    const e = grab(() =>
      loadCharterText(
        yamlWith({
          search_policy: { tier_1_mandatory: [], tier_2_conditional: true },
        }),
        "x.yaml",
      ),
    );
    expect(charterFieldPaths(e).join(" ")).toContain("search_policy");
  });

  it("领域名拼错在【加载期】放行 —— 报错的活是门控的，不是这里的", () => {
    // 这不是「不校验」的懒，是校验该落在谁身上：加载 YAML 的是装配代码，
    // 知道领域写错了的是写岗位书的人。在这里拒会把两者分开。
    // ⚠ 这一发刻意**没有**改成合法名字：它钉的就是「加载期不比对取值」，
    // 而成对判据（下面那一组）只看那条 criteria 在不在、不看领域名对不对 ——
    // 两判据互不掩盖，所以这一发的夹具必须同时过得了成对那一关（补上那条标准）。
    const c = loadCharterText(
      yamlWith({
        search_policy: { tier_1_mandatory: ["framework_version_compat"] },
        acceptance_criteria: withSearchCriterion(),
      }),
      "x.yaml",
    );
    expect(c.searchPolicy?.mandatoryDomains).toEqual([
      "framework_version_compat",
    ]);
  });
});

describe("⭐ 第 1 层那两半必须成对（0034 §1 新加的判据）", () => {
  it("⭐ 声明了领域而验收标准里没那条 ⇒ 拒加载，并报 acceptance_criteria", () => {
    // 这一发钉的是 0034 的起因：上一轮把判定侧接上之后，「写了领域」这件事
    // **本身不产生任何行为**（判定侧只在门控标准里有那一条时才被叫到）。
    // 实测当时：加载通过、领域读得到、展开出的标准里没有一条走搜索判据 ⇒ 全绿而不判。
    const e = grab(() =>
      loadCharterText(
        yamlWith({
          search_policy: { tier_1_mandatory: ["security_advisories"] },
        }),
        "x.yaml",
      ),
    );
    expect(charterFieldPaths(e)).toContain("acceptance_criteria");
    // 报错要点名那串 condition：写岗位书的人要去**加那一条**，
    // 而只说「配了一半」他会去删领域那一格（那是把配错改成没配，代价反的）。
    expect(String(e)).toContain(SEARCH_MANDATORY_SOURCES_CONDITION);
  });

  it("⭐ 反向对照：同一份领域 + 那条标准 ⇒ 加载通过", () => {
    // 没有这一发，上面那条红可能是「任何写了领域的岗位书都被拒」（恒真判据）。
    const c = loadCharterText(
      yamlWith({
        search_policy: { tier_1_mandatory: ["security_advisories"] },
        acceptance_criteria: withSearchCriterion(),
      }),
      "x.yaml",
    );
    expect(c.searchPolicy?.mandatoryDomains).toEqual(["security_advisories"]);
  });

  it("空数组不触发成对判据（声明过而没有领域 ⇒ 本来就没东西要判）", () => {
    expect(() =>
      loadCharterText(
        yamlWith({ search_policy: { tier_1_mandatory: [] } }),
        "x.yaml",
      ),
    ).not.toThrow();
  });

  it("⭐ 反向不要求：有那条标准而没声明领域 ⇒ 合法（那是「不适用」，不是配错）", () => {
    // 判据若双向，会把一个合法写法变成加载失败：判定侧对「有标准而无领域」
    // 已经按 satisfied 处理（0033 §4 那张四格表）。拒它等于用加载期去表达
    // 「这条标准这次不成立」—— 而那一格的答案本来就该由判定侧给。
    const c = loadCharterText(
      yamlWith({ acceptance_criteria: withSearchCriterion() }),
      "x.yaml",
    );
    expect(c.searchPolicy).toBeUndefined();
  });

  it("condition 空白围拢后仍算配上（判定侧也是 trim 后精确匹配）", () => {
    const c = loadCharterText(
      yamlWith({
        search_policy: { tier_1_mandatory: ["framework_versions"] },
        acceptance_criteria: withSearchCriterion().map((a, i) =>
          i === 1
            ? {
                ...a,
                condition: "  " + SEARCH_MANDATORY_SOURCES_CONDITION + " ",
              }
            : a,
        ),
      }),
      "x.yaml",
    );
    expect(c.searchPolicy?.mandatoryDomains).toEqual(["framework_versions"]);
  });

  it("⭐ 判据【不代填】那条标准：领域声明了而标准里没有，就一条也不多出", () => {
    // 另一条实现路径是「发现领域非空就自动追加那条 reject」，它省事而不能做：
    // acceptance_criteria 是 CEO 签的字，自动追加会让一条他从未写过的 reject
    // 出现在他岗位书里，而 reject 是打回产出的那一档。这一发钉住「没代填」。
    const c = loadCharterText(
      yamlWith({
        search_policy: { tier_1_mandatory: ["security_advisories"] },
        acceptance_criteria: withSearchCriterion(),
      }),
      "x.yaml",
    );
    const hits = c.acceptanceCriteria.filter(
      (a) => a.condition.trim() === SEARCH_MANDATORY_SOURCES_CONDITION,
    );
    expect(hits).toHaveLength(1);
    expect(c.acceptanceCriteria).toHaveLength(2); // 夹具那条 metric + 人写的那条，没有第三条
  });
});

/*
 * ⭐ `harness_defaults` 的键必须【有人读、且只配一次】—— round331 加的判据。
 *
 * 这一组与上面那一组（成对判据）是同族，而它补的口子更靠近安全参数：
 * 本文件头约束 1 说 `.strict()` 是为了「拼错的字段名若被静默忽略，那条约束就等于没写」，
 * 可 `harness_defaults` 是 `z.record(z.string(), …)` —— 一个**开放的**键集，于是那份
 * 拒绝在深一层没了：顶层 `model_tier_typo` 被拒，而 `harness_defaults.claudecode`
 * （少一个下划线）原样通过。宿主从「一个档位」换成了【沙箱档位 + 绝对禁止项】。
 *
 * ⚠ 下面每发都成对写（正向对照 + 反向对照），理由是覆盖判据的方向性：
 * 只写「坏键被拒」，夹具被清空也会绿（恒真判据那一族：0013 §8 记的就是它 ——
 * 那一发的「反向对照」从头到尾没经过被测代码，整条用例对目标缺陷分辨能力为零）。
 */
describe("⭐ harness_defaults 的键必须有人读（round331：拼错的键 = 禁令静默失效）", () => {
  /** 一份点了禁止项的合法 harness_defaults（键名由参数定，值固定）。 */
  const BAN = "--dangerously-skip-permissions";
  const cell = (key: string): Record<string, unknown> => ({
    [key]: { sandbox: "workspace-write", forbidden_flags: [BAN] },
  });

  it("⭐ 键名拼错 ⇒ 拒加载，并报 harness_defaults 这一格", () => {
    // 失效不是崩，是【全绿而禁令不存在】：读取侧 harnessDefaultsFor 对认不出的键
    // return undefined，缺省口径（buildGatewayDeps）把 sandbox 落到 read-only、
    // 把 forbidden_flags 落到 []。前者只是变严，后者是【失败方向为开】——
    // 岗位书明明写了这条禁令，gateway 照放、审计照写、没人报错。
    const e = grab(() =>
      loadCharterText(
        yamlWith({ harness_defaults: cell("claudecode") }),
        "x.yaml",
      ),
    );
    expect(charterFieldPaths(e)).toContain("harness_defaults");
  });

  it("⭐ 报错必须点名那个错键名（只说「配错了」他没法改）", () => {
    const e = grab(() =>
      loadCharterText(
        yamlWith({ harness_defaults: cell("claude_cod") }),
        "x.yaml",
      ),
    );
    expect(String(e)).toContain("claude_cod");
    // 还要给出合法键集：别名表有四个名字，靠人记住必然再错一次。
    expect(String(e)).toContain("claude_code");
  });

  it("⭐ 正向对照：合法键名原样放行，值一字不改（判据不是「一律拒」）", () => {
    // 没有这一发，上面两条红的可能是「任何写了 harness_defaults 的岗位书都被拒」。
    const c = loadCharterText(
      yamlWith({ harness_defaults: cell("claude_code") }),
      "x.yaml",
    );
    expect(c.harnessDefaults).toEqual(cell("claude_code"));
  });

  it("两个合法写法各写一格（claude-code / codex）⇒ 合法：那是两家，不是重复", () => {
    // 判据若把「多个键」一律当重复，会拦掉一个完全合法的写法（两家都在跑的可能路上）。
    expect(() =>
      loadCharterText(
        yamlWith({
          harness_defaults: {
            claude_code: { sandbox: "workspace-write" },
            codex: { sandbox: "read-only" },
          },
        }),
        "x.yaml",
      ),
    ).not.toThrow();
  });

  it("整个不写这一格 ⇒ 合法（没配 ≠ 配错）", () => {
    const c = loadCharterText(yamlWith({}), "x.yaml");
    expect(c.harnessDefaults).toBeUndefined();
  });

  it("⭐ 同一家写两种写法 ⇒ 拒：后写那一格被读取顺序吞掉，且不报错", () => {
    // 这一臂比拼错更难发现：claude-code 与 claude_code 【都是合法键】，
    // `.strict()` 无话可说，而 harnessDefaultsFor 按别名表顺序试键、命中即 return
    // ⇒ 那份 YAML 里有一格【根本不存在】。生效的是哪一格取决于遍历顺序，
    // 不取决于 CEO 写的先后 —— 而这一格里装的是沙箱档位与绝对禁止项。
    const e = grab(() =>
      loadCharterText(
        yamlWith({
          harness_defaults: {
            "claude-code": { forbidden_flags: [BAN] },
            claude_code: { sandbox: "workspace-write" },
          },
        }),
        "x.yaml",
      ),
    );
    expect(charterFieldPaths(e)).toContain("harness_defaults");
    // 报错要点名【被吞掉的那一个】，不是两个都列一遍：修法就是「删掉它或改名」。
    expect(String(e)).toContain("claude_code");
  });

  it("⭐ 被点名的是【读取侧真的跳过】那一格，与 YAML 里的书写先后无关", () => {
    // 判据遍历的是【别名表的顺序】而不是 raw 的键序，而这不是风格选择：
    // harnessDefaultsFor 也按别名表顺序试键，所以「哪一格实际生效」由别名表定。
    // 若判据改按 raw 顺序遍历，报错就会点名【实际生效】那一格 —— 让 CEO 去删
    // 活着的那格、留下读不到的那格，改完仍然不生效而消息说「已修」。
    // 两种书写顺序都必须得到同一条消息（loser = claude_code，winner = claude-code）。
    const both = (first: "a" | "b"): Record<string, unknown> =>
      first === "a"
        ? {
            "claude-code": { forbidden_flags: [BAN] },
            claude_code: { sandbox: "workspace-write" },
          }
        : {
            claude_code: { sandbox: "workspace-write" },
            "claude-code": { forbidden_flags: [BAN] },
          };
    for (const first of ["a", "b"] as const) {
      const e = grab(() =>
        loadCharterText(yamlWith({ harness_defaults: both(first) }), "x.yaml"),
      );
      expect(String(e), "书写顺序 " + first).toContain(
        "claude_code（与 claude-code 同指 claude-code",
      );
    }
  });

  it("⭐ 判据【不代填、不自动改名】：拼错的键不会被就地纠成合法名", () => {
    // 另一条实现路径是「发现 claudecode 就纠成 claude_code」，它省事而不能做：
    // 自动纠正是替 CEO 判定他写的是笔误还是【另一个角色的配置】，
    // 而后者正是这里要拦住的那种歧义（与隔壁 search_policy 那条判据同一个立场）。
    // 钉法：一个【原型链上的名字】也必须被拒。别名表是对象字面量，
    // 若判据写成 `HARNESS_ID_ALIASES[k] === undefined`（而不是 Object.hasOwn），
    // `toString` 会取到继承来的函数 ⇒ 这个【根本没人读】的键被判成合法，
    // 而这条判据从此对任何继承名失效 —— 恰好是它要抓的形状。
    for (const inherited of ["toString", "constructor", "valueOf"]) {
      const e = grab(() =>
        loadCharterText(
          yamlWith({ harness_defaults: cell(inherited) }),
          "x.yaml",
        ),
      );
      expect(charterFieldPaths(e), inherited).toContain("harness_defaults");
    }
  });

  it("⭐ 值写坏仍由读取侧抛 —— 这里【不抄第二份值判据】", () => {
    // sandbox: "workspace"（少 -write）这一格在 schema 里是合法 record，
    // 值的形状只有一份口径（harnessDefaultEntrySchema，在 harnessDefaultsFor 里跑）。
    // 这里若再抄一份值判据，就是两份口径（本仓最贵那一族失效），所以这一发钉的是
    // 「加载期放行」—— 它必须在读取期才炸，那才是唯一那份 schema 在说话。
    expect(() =>
      loadCharterText(
        yamlWith({
          harness_defaults: { claude_code: { sandbox: "workspace" } },
        }),
        "x.yaml",
      ),
    ).not.toThrow();
  });

  // 「新判据有没有弄坏存量」不在这里另发一发：上面那个 describe("7 个预设模板")
  // 第一项就是把七个模板逐个过【同一份 schema】，模板真被这条拒了会在那里红。
});

describe("7 个预设模板（Task 0.7 交付物）", () => {
  it("每个模板都能被 schema 接受；role_id 必须等于文件名", () => {
    for (const name of SEVEN) {
      const c = loadCharterFile(join(TEMPLATES, name + ".yaml"));
      expect(c.roleId, name + ".yaml 的 role_id 必须等于文件名").toBe(name);
    }
  });

  it("模板的 acceptance_criteria 仍是【固定占位串】，等 Task 0.9 由 CEO 逐条替换", () => {
    for (const name of SEVEN) {
      const c = loadCharterFile(join(TEMPLATES, name + ".yaml"));
      const texts = c.acceptanceCriteria.map(
        (a) => a.condition + "|" + a.message,
      );
      expect(
        texts.some((s) => s.includes(CHARTER_PLACEHOLDER_ACCEPTANCE)),
        name,
      ).toBe(true);
    }
  });

  // O2-4「ops.yaml 要么进装载表，要么删掉 —— 留着它最坏」。
  // 这一发不是选边，是把「它今天到底算什么」变成**算出来的**而不是**说出来的**：
  // 孤儿集合由 NODE_TO_TEMPLATE 反推，改这张表或加一份模板都会让它红。
  //
  // 为什么**留下**而不是删（当时的判断，写在这里免得下一轮当成没决定过）：
  //  1. `NODE_TO_TEMPLATE` 的键是**图阶段**（intake/charter/product/tech/dev/test/report），
  //     不是员工。把 ops 塞进去等于让 report 阶段拿运营的岗位书干活 —— 那是凭空造一次
  //     组织变更，而它不该由实现层代笔（0008 §7）。
  //  2. 运行时用的 role 是**组织图的节点 id**（`engine/dispatch.ts` 要求
  //     `graph.nodes[task.role]` 存在），而 `org/commit.ts` 对「没有岗位书的角色」是
  //     `continue` 而不是编一份。⇒ 删掉这个文件之后，CEO 真加一个 ops 角色时
  //     **连一份可读的模板都不存在**，那才是「空壳」的加强版。
  //  3. 「留着它最坏 = 读起来像运营角色已经存在」这半句**已经不再成立**：
  //     O2-2 的播种命令按目录 glob 读它，而判据 A 让「没签字」的模板整次拒绝、
  //     零写入 ⇒ 它现在读起来是「有一份没签的运营岗位书」，这句话是真的。
  it("孤儿模板集合恰好是 ops —— 而且『孤儿』只意味着【不走 preset 装配】", () => {
    const mounted = new Set(Object.values(NODE_TO_TEMPLATE));
    const files = templateFiles(TEMPLATES).map((f) =>
      f.replace(/\.ya?ml$/iu, ""),
    );
    const orphans = files.filter((f) => !mounted.has(f));
    // 断言的是**集合相等**，不是「有个 ops」：加一份新模板而不装配，这一发必须点名它。
    expect(orphans).toEqual(["ops"]);
    // 第二半句同样要判：孤儿 ≠ 死文件。播种命令读的是整个目录，所以 ops
    // 有一条真的入口（签字之后），preset 没有 —— 两种「装载」不是一回事。
    expect(files).toHaveLength(SEVEN.length);
    for (const name of orphans) {
      expect(() =>
        loadCharterFile(join(TEMPLATES, name + ".yaml")),
      ).not.toThrow();
    }
  });
});

describe("权限单调性（规格 §20.2 / §4）", () => {
  it("运行时参数【不得】删除 forbidden 条目", () => {
    const c = loadCharterText(yamlWith({}), "x.yaml");
    const e = grab(() =>
      mergeForbiddenForRun(c, { removeForbidden: ["修改源代码"] }),
    );
    expect(String(e)).toContain("修改源代码");
  });

  it("运行时参数【不得】用空数组清空 forbidden", () => {
    const c = loadCharterText(yamlWith({}), "x.yaml");
    expect(() => mergeForbiddenForRun(c, { forbidden: [] })).toThrow();
  });

  it("运行时只能【收紧】：追加生效，原有条目一条都不能少", () => {
    const c = loadCharterText(yamlWith({}), "x.yaml");
    const eff = mergeForbiddenForRun(c, { forbidden: ["额外禁止项"] });
    expect(eff).toContain("修改源代码");
    expect(eff).toContain("额外禁止项");
  });
});
