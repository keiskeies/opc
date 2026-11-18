/**
 * 岗位书 → 角色提示词（`charter/prompt.ts`）。**纯函数，不起库、不起 WriteQueue。**
 *
 * ── 为什么单独一个文件而不是并进 runtime.test.ts ──────────────────────────
 * `engine/runtime.ts` 的每一发都要先起一个真 WriteQueue + 真迁移的世界。渲染器的
 * 全部内容是「十四格里哪几格进提示词、以什么口径进」，几十条措辞级判据若挂在那种
 * 世界上，实际结果就是没人测（这正是 `charter/prompt.ts` 文件头把渲染拆出来的理由）。
 *
 * ── 这一发测的是【取舍】不是【拼接】──────────────────────────────────────
 * 拼接级的断言（「输出里含有 honesty_boundaries 那个串」）判别力接近零：
 * 把每一格都渲染进去也能全绿。所以每一格都有**正反两发**，而反向那一批发的是
 * 「这个字段【不该】出现在提示词里」—— 不写那些反向的，整个「有执行点就不抄」
 * 的立场可以整条删掉而套件照绿（0057 §6 那条判据在本文件的具体形状）。
 */

import {
  CHARTER_PLACEHOLDER_ACCEPTANCE,
  type Charter,
  type CharterInput,
  charterSchema,
  SEARCH_MANDATORY_SOURCES_CONDITION,
} from "@opc/contracts";
import { describe, expect, it } from "vitest";
import {
  NO_CHARTER_LINE,
  renderCharterPrompt,
} from "../../src/charter/prompt.js";

/**
 * 一份**填满了每一格**的岗位书 —— 刻意填满，因为「不该进的那些格」只有在
 * 它们真的有值时才可判。空值下的「没出现」什么也不证明（它本来就没内容可渲染）。
 *
 * 走 `charterSchema.parse`：`as Charter` 会让「夹具与真实形状不符」在测试里永久隐形，
 * 而本文件全部结论都建立在"这份就是读侧拿到的那一颗"上。
 */
function full(over: Partial<CharterInput> = {}): Charter {
  const input: CharterInput = {
    role_id: "dev",
    display_name: "开发负责人",
    version: 7,
    // 上级改名 boss_of_dev 而【不写 director】：dissent_rights 那一格里也出现过
    // "director"，两个字段共用一个 needle 会让 reports_to 那一发的"在输入里"由
    // dissent_rights 供给（下面「needle 全夹具唯一」那一发抓的就是这种张冠李戴）。
    reports_to: "boss_of_dev",
    honesty_boundaries: ["不声称未跑过的测试已通过"],
    cognitive_skill: "深度推理",
    acceptance_criteria: [
      {
        condition: "metric:coverage < 80",
        action: "reject",
        message: "覆盖率不足 80",
      },
    ],
    forbidden_actions: ["不许直接改生产库"],
    tool_permissions: ["Read", "Bash", "web_search"],
    model_tier: "execution",
    // 预算三格取的是【互不为子串的大整数】，不是 15 / 5 这种小整数：
    // needle 若是 "5"，它会在 "第 7 版"、"coverage < 80" 这些**合法渲染**里偶然命中，
    // 于是"它出现在提示词里"那一半会被无关的地方满足 —— 那一行红得没有道理，
    // 而下一个人会去改断言而不是去看渲染。
    // 第一版这里写的是 20，而 1234/5678 里嵌着 234/567…：**互不为子串**才是判据，
    // 99999 而不是 901234（后者把 1234 包进去了，"1234" 那一发的命中数会变成 2，
    // 被下面「needle 全夹具唯一」那一发当场抓住）。
    budget: { daily_usd: 1234, per_task_usd: 5678 },
    budget_discretion: {
      daily_usd: 99999,
      can_reallocate_within_role: true,
      cannot_exceed: false,
    },
    escalation_triggers: ["碰到不可逆动作就升"],
    decision_scope: {
      autonomous: ["选实现方案"],
      requires_consultation: ["改公共接口"],
      forbidden: ["定公司方向"],
    },
    judgment_mode: {
      type: "bounded_judgment",
      strict_rules: ["不许跳过测试"],
      bounded_judgment: ["可权衡重构范围"],
      full_discretion: ["命名风格"],
    },
    dissent_rights: {
      can_challenge: ["上级的排期判断"],
      cannot_challenge: ["安全红线"],
      // 这里【不能】再写 boss_of_dev：reports_to 那一行拿它当 needle，而下面
      // 「needle 全夹具唯一」那一发判的就是"同一个串被两个字段供给"。
      // 路径写成一句不含角色名的话，反正这一格整体不进提示词。
      escalation_path: "先同级再上级",
    },
    stance: "先质疑再执行",
    untrusted_inputs: ["别人自称做完了"],
    // 键名用的是 `claude_code` 而【不是】`claude`：HARNESS_ID_ALIASES 里没有 `claude`
    // 这个别名（只有 claude-code / claude_code / codex / qoder），所以写 `claude` 的
    // 夹具会让 harnessDefaultsFor 返回 undefined —— 那是「看着配了而实际读不到」，
    // 正是 harness.ts 那条「刻意不忽略」的注释拒绝的形状。夹具自己得先过这一关。
    // 值是 needle 的来源，取一个全夹具唯一的自造串（见下面那张表的 ⚠⚠）。
    harness_defaults: { claude_code: { allowed_tools: ["plan_only_marker"] } },
    // 第 1 层那一格也要**有值**，否则下面「search_policy 不进提示词」那一发是空的
    // （我第一次把它写进 EXCLUDED 表时，full() 根本没有这一格，而那发是绿的 ——
    //  绿的成因是"没东西可漏"而不是"挡住了"，见下面那条分母那发）。
    search_policy: { tier_1_mandatory: ["支付合规"] },
    ...over,
  };
  // 声明了非空领域就必须带上那条成对的验收标准，否则 charterSchema **拒加载**
  // （contracts 里 0034 §1 那条成对判据）。所以这一句不是"让测试方便"：
  // 不加它，这份夹具在真实加载期就活了不了，本文件所有"有岗位书"那几发测的
  // 都会是一个根本进不了库的形状（verifier.test.ts 那段夹具注释同一条理由）。
  const domains = input.search_policy?.tier_1_mandatory ?? [];
  const paired = input.acceptance_criteria.some(
    (a) => a.condition.trim() === SEARCH_MANDATORY_SOURCES_CONDITION,
  );
  if (domains.length > 0 && !paired) {
    input.acceptance_criteria = [
      ...input.acceptance_criteria,
      {
        condition: SEARCH_MANDATORY_SOURCES_CONDITION,
        action: "reject",
        message: "强制搜索领域必须附带可追溯来源",
      },
    ];
  }
  return charterSchema.parse(input);
}

/** 渲染结果拍平成一行，好让"某串没出现"这一类断言能拼在一条 expect 上（数组只报 Array(n)）。 */
const flat = (c: Charter): string => renderCharterPrompt(c).sections.join("\n");

describe("进提示词的那些格：每一格正反两发", () => {
  it("该进的格逐格出现，且带的是【口径】而不只是那个串", () => {
    const t = flat(full());
    for (const needle of [
      "dev",
      "开发负责人",
      "第 7 版",
      "不声称未跑过的测试已通过",
      "metric:coverage < 80",
      "不许直接改生产库",
      "选实现方案",
      "改公共接口",
      "定公司方向",
      "bounded_judgment",
      "不许跳过测试",
      "可权衡重构范围",
      "命名风格",
      "碰到不可逆动作就升",
      "别人自称做完了",
    ]) {
      expect(t).toContain(needle);
    }
  });

  it("⭐ condition 渲染成【不合格的情形】而不是目标", () => {
    // 这一格不是润色：condition 的口径是「成立即不合格」（GateCriterion 那一族）。
    // 把它当目标贴上去，"测试未通过"会被读成"去让测试通过"，方向正好反过来。
    const t = flat(full());
    expect(t).toContain("condition = 不合格的情形，不是目标");
  });

  it("acceptance 的 escalate 那一支渲染出目标，reject 那一支渲染成打回", () => {
    const esc = full({
      acceptance_criteria: [
        {
          condition: "碰到方向问题",
          action: "escalate",
          target: "ceo",
          message: "方向由 CEO 定",
        },
        {
          condition: "metric:coverage < 80",
          action: "reject",
          message: "覆盖率不足",
        },
      ],
    });
    const t = flat(esc);
    expect(t).toContain("升级到 ceo");
    expect(t).toContain("打回");
    // 反向：两种动作**不能**渲染成同一句话，否则 agent 分不清要不要停手等人。
    expect(t).not.toContain("打回 ceo");
  });

  it("⭐ escalation_triggers 的两种合法形状都渲染得出（union 的两支）", () => {
    // 漏掉对象那一支的后果不是崩，是「岗位书写了升级目标而 agent 看不见」。
    const both = full({
      escalation_triggers: [
        "裸字符串那一支",
        {
          condition: "花了八成额度",
          action: "pause_and_escalate",
          target: "director",
        },
      ],
    });
    const t = flat(both);
    expect(t).toContain("裸字符串那一支");
    expect(t).toContain("花了八成额度 ⇒ pause_and_escalate 到 director");
  });

  it("空列表那一格【整格不出现】，而不是一行标题后面空着", () => {
    const t = flat(
      full({
        forbidden_actions: [],
        honesty_boundaries: ["仍要有一条，schema 要求 min(1)"],
      }),
    );
    expect(t).not.toContain("禁止动作");
    // 反向对照：同一份渲染路径在**有值**时必须出现那一格。
    // 少了这条，"整格不出现"与"这一格根本没实现"不可区分（0045 §9 那个分母同族）。
    expect(flat(full())).toContain("禁止动作");
  });

  it("untrusted_inputs：undefined 与 [] 都不渲染那一格", () => {
    /*
     * 标题原来写的是「undefined 与【键不存在】」，那个前提被 tsc 驳回了，而驳回得对：
     * charterSchema 的 transform 是【逐键列出】的（charter.ts:277 `untrustedInputs:
     * c.untrusted_inputs`），所以读侧的 Charter 里这一格【永远存在】，值域是
     * string[] | undefined。TS 把 `Charter` 里这一格标成必填而非可选就是这个意思。
     * ⇒ 我第一版用 `{ untrustedInputs: _drop, ...noKey }` 造的那颗"键不存在"的岗位书，
     *   是一个【生产造不出来的状态】，而 renderCharterPrompt(noKey) 拿到的类型
     *   已经不是 Charter（TS2345 报的就是这个）。vitest 不会报：esbuild 只剥类型。
     *
     * 真正的两件事在【输入侧】（CharterInput 那一侧的 YAML）：写没写这一栏。
     * 读侧只剩 undefined / [] 两个值，"没说过"与"写了而没值"在过 schema 时并成一颗。
     * 这一发因此测的是读侧真实的两值，别再把它当成三值。
     */
    // 三颗输入。前两颗在【读侧是同一颗】（读侧只剩 undefined / [] 两个值），
    // 第三颗 [] 是另一个值而渲染相同。
    const undef: Charter = { ...full(), untrustedInputs: undefined };
    const empty = full({ untrusted_inputs: [] });
    expect(undef.untrustedInputs).toBeUndefined();
    expect(empty.untrustedInputs).toEqual([]);
    const a = renderCharterPrompt(undef).sections.join("\n");
    const b = renderCharterPrompt(empty).sections.join("\n");
    // 两发的渲染结果逐字相同（都不渲染），而类型上仍是两个值 ——
    // 这一发钉的是"渲染刻意不在这里造第三个真相"。
    expect("undefined 与 [] 渲染相同: " + String(a === b)).toBe(
      "undefined 与 [] 渲染相同: true",
    );
    /*
     * 再补一颗【键真的不在】的对象。读侧永远不会造出它（见上面那段），喂它进来
     * 不是为了测那个状态，而是为了钉实现的判据形状：渲染器判的是 `!== undefined`，
     * 不是 `'untrustedInputs' in c`。后者会多出一条读侧根本不存在的分叉 ——
     * 而它两种写法今天全绿，只有喂少一键的对象才分得开。
     */
    const noKey = JSON.parse(JSON.stringify(full())) as Record<string, unknown>;
    delete noKey["untrustedInputs"];
    // Object.hasOwn 而不是 hasOwnProperty.call：biome 的 noPrototypeBuiltins 报后者，
    // 而两者判的是同一件事 —— 用哪个不影响这一发要钉的东西（键【根本不在】那颗上）。
    expect(Object.hasOwn(noKey, "untrustedInputs")).toBe(false);
    expect(
      renderCharterPrompt(noKey as unknown as Charter).sections.join("\n"),
    ).toBe(a);
    expect(a).not.toContain("不可信");
    expect(flat(full())).toContain("不可信");
  });
});

describe("不进提示词的那些格：每一格都要一发反向的", () => {
  /**
   * 一张表，一行一个字段，全部喂的是**有值**的岗位书（见 `full()` 那段）。
   *
   * ⚠ 这张表是 O2 那个立场**唯一**的机械证据：立场本身写在 prompt.ts 文件头，
   * 而文件头不会被任何断言执行。少一行 = 那一个字段"抄进提示词"这件事不会有人发现。
   *
   * ⚠⚠ 每一行的 needle 必须是【夹具里那个字段的真实取值】，而不是字段名 ——
   *   下面那个循环同时判两半（不在渲染里 **且** 在输入里），所以字段名当 needle
   *   会让那一行**恒绿**：camelCase 的 Charter 里根本没有 `per_task_usd` /
   *   `tier_1_mandatory` / `permission_mode` 这些 snake_case 键名，
   *   「它没出现在提示词里」这一半当然成立，而它证明的是"我搜了个不存在的串"。
   *   本表第一版就有三行是这个形状（自己写完第一版才发现：那条把十格全塞进
   *   提示词的变异跑下来只红了 5/10，漏网的正是这三行 —— 而它当时的"10/10 全红"
   *   是【注入的那十格】被杀，不是【这张表】有判别力，两者不是一件事）。
   *   取值还要**全夹具唯一**（预算用 1234/5678/901234，上级改名 boss_of_dev，
   *   harness 那格用自造的 plan_only_marker），否则「在输入里」这一半会被
   *   【别的字段】满足：needle 写成 "director" 时，dissent_rights 的
   *   escalation_path "director → ceo" 也能供上它，那一行就在替另一个字段发言。
   *
   * `key` 那一列不是给人看的注释，是下面「覆盖面」那一发的输入：不并进表里就要
   * 在旁边再手写一份名单，而两份名单会漂（本文件的病根本身）。
   */
  const EXCLUDED: ReadonlyArray<{
    key: string;
    label: string;
    why: string;
    needle: string;
  }> = [
    // model_tier 由 runtime 的 modelFamily 从【组织图节点】读，抄进来就是第二个真相。
    {
      key: "modelTier",
      label: "model_tier",
      why: "档位住在组织图，不住在措辞里",
      needle: "execution",
    },
    // 真闸是 --max-budget-usd 与 budgets 表；提示词里那句"别花太多"从来不是边界。
    {
      key: "budget",
      label: "budget.daily",
      why: "花钱的边界是代码给的数，不是话",
      needle: "1234",
    },
    {
      key: "budget",
      label: "budget.perTask",
      why: "同上（任务级）",
      needle: "5678",
    },
    {
      key: "budgetDiscretion",
      label: "budget_discretion",
      why: "额度的裁量权归代码，不归措辞",
      needle: "99999",
    },
    // 今天没有执行点：--permission-mode plan 下压根没有工具调用。
    // 写进去 = 对 agent 承诺一份 hub 并不给的权力，比不写更坏。
    {
      key: "toolPermissions",
      label: "tool_permissions",
      why: "承诺 hub 不给的权力",
      needle: "web_search",
    },
    // 门控那一刻判（search/policy.ts），措辞约束不了它。
    {
      key: "searchPolicy",
      label: "search_policy",
      why: "门控判它，话管不住它",
      needle: "支付合规",
    },
    // 升级路径由边表决定，agent 点名也没用。
    {
      key: "dissentRights",
      label: "dissent_rights",
      why: "边表决定路径",
      needle: "安全红线",
    },
    {
      key: "reportsTo",
      label: "reports_to",
      why: "简报里已有上级那句，两处各写一份会漂",
      needle: "boss_of_dev",
    },
    {
      key: "harnessDefaults",
      label: "harness_defaults",
      why: "注入给 harness 的参数，不是给角色读的话",
      needle: "plan_only_marker",
    },
    {
      key: "cognitiveSkill",
      label: "cognitive_skill",
      why: "描述性形容词，0 个 src 读者",
      needle: "深度推理",
    },
    {
      key: "stance",
      label: "stance",
      why: "同上",
      needle: "先质疑再执行",
    },
  ];

  /**
   * 一行两半，写在**同一条** expect 上，所以「挡住了」与「有东西可挡」不可能只成立一半。
   *
   * 为什么不用两条 expect：分开发言时有人会把后半那半删掉（它就是 0057 §6 那种装饰），
   * 而合成一个字符串之后，删掉任何一半都会让**这一行自己**红，且红行里看得见是哪个字段。
   */
  it.each(EXCLUDED)("$label 不进提示词（$why）", ({ label, needle }) => {
    const c = full();
    const rendered = flat(c);
    const inInput = JSON.stringify(c).includes(needle);
    const inOutput = rendered.includes(needle);
    expect(
      label + ": 在输入里=" + inInput + "，出现在提示词里=" + inOutput,
    ).toBe(label + ": 在输入里=true，出现在提示词里=false");
  });

  it("⚠ needle 要全夹具唯一，且表里不许有重复行", () => {
    /*
     * 上面那一批发的是「这一行自己成立」，而它成立有两种绿法：
     *   ① 渲染器真的不抄（想要的）；② needle 被【别的字段】供给，"在输入里"由
     *      张冠李戴满足，而渲染里恰好也没有（不想要，而它长得一模一样）。
     * 这一发把 ② 关掉：每个 needle 在**整颗输入 JSON**里只许命中一次。
     * （"恰好命中一次"不是随便定的：命中 0 次说明夹具没给值，>1 次说明会被张冠李戴。）
     *
     * 顺带钉表自身的完整性：label 撞名会让 it.each 的两发标题相近而容易只盯一条，
     * 而重复 needle 意味着两行其实在判同一件事 —— 表看起来 11 行、实际判别力 10。
     */
    const c = full();
    const json = JSON.stringify(c);
    const hits = (needle: string): number => json.split(needle).length - 1;
    const bad = EXCLUDED.filter(({ needle }) => hits(needle) !== 1).map(
      ({ label, needle }) =>
        label + '→"' + needle + '" 命中 ' + hits(needle) + " 次",
    );
    expect("needle 命中次数不是 1 的行: " + bad.join("; ")).toBe(
      "needle 命中次数不是 1 的行: ",
    );
    const labels = EXCLUDED.map((r) => r.label);
    const dup = labels.filter((l, i) => labels.indexOf(l) !== i);
    expect("重复的 label: " + dup.join(", ")).toBe("重复的 label: ");
  });

  it("⚠ 这张表要【覆盖全部】Charter 字段 —— 没归类过的字段等于没人决定过", () => {
    /*
     * 上面那些发都判"表里的行成立"，没有一发判"表全不全"。少一行是最坏的失效形状：
     * 套件全绿，而那个新加的字段悄悄进了提示词（O2 的病根就是这种"没人决定过"）。
     *
     * 两份名单：INCLUDED 手抄自 prompt.ts 文件头「进的格」那一段；
     * NOT_INCLUDED **从 EXCLUDED 派生**，不另写一份 —— 在旁边手写第二份名单
     * 就是再造一个会漂的源，而这个文件整个就是为了治"两个源"。
     *
     * 名字集合写死是有意为之：contracts 的 Charter 加字段 ⇒ 这一发红，逼加的人
     * 当场决定「进不进提示词、不进的理由是什么」，而不是让它默认落进"没决定过"。
     */
    const keys = Object.keys(full()).sort();
    const INCLUDED = [
      "acceptanceCriteria",
      "decisionScope",
      "displayName",
      "escalationTriggers",
      "forbiddenActions",
      "honestyBoundaries",
      "judgmentMode",
      "roleId",
      "untrustedInputs",
      "version",
    ].sort();
    const NOT_INCLUDED = [...new Set(EXCLUDED.map((r) => r.key))].sort();
    const unclassified = keys.filter(
      (k) => !INCLUDED.includes(k) && !NOT_INCLUDED.includes(k),
    );
    expect("没有归类过的字段: [" + unclassified.join(", ") + "]").toBe(
      "没有归类过的字段: []",
    );
    // 反向：并集不许【超出】实际键集（INCLUDED 里打错一个键名，上面那一发抓不到它，
    // 但打错成"看着像"的名字会在这里露出来 —— 两份名单都得是键集的子集）。
    const invented = [...INCLUDED, ...NOT_INCLUDED].filter(
      (k) => !keys.includes(k),
    );
    expect("名单里有而 Charter 没有的键: " + invented.join(", ")).toBe(
      "名单里有而 Charter 没有的键: ",
    );
    // 双向：两份名单不许有交集（一个字段既"进"又"不进"是最直接的自相矛盾）。
    const both = INCLUDED.filter((k) => NOT_INCLUDED.includes(k));
    expect("同时出现在两份名单里的键: " + both.join(", ")).toBe(
      "同时出现在两份名单里的键: ",
    );
  });
});

describe("占位标准：不能以标准的样子进提示词", () => {
  it("含占位串 ⇒ 渲染【没有那条标准】而有一句「还没签字」", () => {
    const t = flat(
      full({
        acceptance_criteria: [
          {
            condition: CHARTER_PLACEHOLDER_ACCEPTANCE,
            action: "reject",
            message: "待 CEO 填",
          },
        ],
      }),
    );
    expect(t).toContain("还没由 CEO 签字");
    expect(t).toContain("不要自称");
    // 反向：占位串【不能】出现在提示词里。进了就等于告诉 agent
    // 「你有一条标准叫 CEO-PLACEHOLDER-ACCEPTANCE」，而它会当真空转 ——
    // 那是一条假绿的标准，症状是「这一轮看起来有标准」。
    expect(t).not.toContain(CHARTER_PLACEHOLDER_ACCEPTANCE);
  });

  it("签过标准 + 仍留着一条占位 ⇒ 真的那条照进，占位那条不进，未签字那句也要有", () => {
    const t = flat(
      full({
        acceptance_criteria: [
          {
            condition: "metric:coverage < 80",
            action: "reject",
            message: "覆盖率不足",
          },
          {
            condition: "还有一条 " + CHARTER_PLACEHOLDER_ACCEPTANCE,
            action: "reject",
            message: "待填",
          },
        ],
      }),
    );
    expect(t).toContain("metric:coverage < 80");
    expect(t).not.toContain(CHARTER_PLACEHOLDER_ACCEPTANCE);
    expect(t).toContain("还没由 CEO 签字");
  });

  it("全部签过 ⇒ 不提未签字（反向对照，否则那句是恒绿的安慰）", () => {
    expect(flat(full())).not.toContain("还没由 CEO 签字");
  });
});

describe("没有岗位书那一支（NO_CHARTER_LINE）", () => {
  it("那句话说的是「没有」而【不是】「读坏了」，且不编一份通用岗位书", () => {
    expect(NO_CHARTER_LINE).toContain("没有你的岗位书");
    expect(NO_CHARTER_LINE).toContain("role_charters");
    // 不编职责：出现"你的职责是"这类句式就等于 O2 要防的那件事。
    expect(NO_CHARTER_LINE).not.toMatch(/你的职责是|你的验收标准/);
    // 它要求 agent 把这件事**如实写进汇报**，而不是安静地少做几件。
    expect(NO_CHARTER_LINE).toContain("如实写进你的汇报");
  });

  it("渲染器对一份齐格岗位书【不】输出这句话 —— 两种读结果不合并", () => {
    expect(flat(full())).not.toContain(NO_CHARTER_LINE);
  });
});

describe("输出形状：只有一格", () => {
  it("CharterPrompt 只有 sections —— 那两个被删的字段不许回来", () => {
    const r = renderCharterPrompt(full());
    expect(Object.keys(r).sort().join(",")).toBe("sections");
    /*
     * 这一发钉的是本模块自己犯过的一格（记在 prompt.ts 的 CharterPrompt 文件头）：
     * 第一版这里还有 hasCharter（恒 true，因为"没有岗位书"那一支压根不走这个函数）
     * 与 placeholderPending（算出来了而零消费者）。两个都是 0057 §6 那种装饰，
     * 而**结构上的装饰比断言上的装饰更难发现**：没人会去变异一个字段。
     * 所以这里钉的是键名集合：加一个没人读的布尔 ⇒ 这一发红。
     */
  });
});
