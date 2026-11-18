/**
 * 岗位书 → 角色提示词。**纯函数，不碰文件也不碰库**（先例见 `pending-decisions.ts` /
 * `test/arch/pending-inventory.ts`：只有纯函数能被合成输入逐格喂，而这一模块的
 * 每一格都需要同成的正反两发）。
 *
 * ── 为什么要有这个文件（优化设计文档 O2 动作 1 写的是「不需要新代码」）──────────
 * 那句话对【读取口】成立 —— `charter/store.ts` 的 `readLatestCharter` 早就写好了，
 * 缺的确实是那一次 import。但它不对【把读回来的 14 个字段变成一段话】成立：
 * 那一步要逐格决定「进不进提示词、以什么口径进」，而那些决定是**判据**，
 * 判据散在装配层里就没法逐条测（`engine/runtime.ts` 的每一发测试都要先起一个
 * WriteQueue + migrate 的世界，为一句措辞付那个代价，实际结果就是没人测）。
 *
 * ── 唯一的取舍规则：有执行点的字段【不】抄进提示词 ────────────────────────────
 * O2 的病根就是「同一件事有两份来源，哪份生效看谁后写」。而提示词是一份**没人校验的
 * 副本**：把已经被代码管着的东西再抄一遍，抄的那份会漂，而漂了不报错。所以判据是
 * 「这个字段今天有没有一个真的执行点」，逐格记在下面，不是一张凭手感的名单。
 *
 * 进的格（agent 自己要照着做事、而代码管不到它）：
 *   display_name / honesty_boundaries / acceptance_criteria / forbidden_actions /
 *   decision_scope / judgment_mode / escalation_triggers / untrusted_inputs
 * 不进的格，每条给【为什么不进】而不是沉默：
 *   model_tier        → 已由 runtime 的 modelFamily 从【组织图节点】读，抄一份进来
 *                       就是第二个真相，而且那两个源的键根本不同（图 vs 岗位书）
 *   budget*           → 真闸在 CLI 的 --max-budget-usd 与 budgets 表，提示词里那句
 *                       「别花太多」一直都不是边界（claude.ts 文件头同一条立场）
 *   tool_permissions  → 今天【没有执行点】：--permission-mode plan 下没有工具调用。
 *                       把它写进提示词 = 对 agent 承诺一份 hub 并不给的权力，
 *                       那比不写更坏。接在 O6-3 的安全层上之后一起进。
 *   search_policy     → 门控那一刻判（search/policy.ts），不是措辞能约束的
 *   dissent_rights    → 升级路径由 hub 的边表决定，agent 点名也没用（同 parseDecision
 *                       里 pass 刻意不读 to_role 那条理由）
 *   reports_to        → 简报里已经有「你的直接上级」那句，两处各写一份会漂
 *   harness_defaults  → 注入给 harness 侧的参数，不是给角色读的话
 *   cognitive_skill / stance → 0 个 src 读者，且是描述性形容词不是指令
 */
import { CHARTER_PLACEHOLDER_ACCEPTANCE, type Charter } from "@opc/contracts";

/**
 * 渲染出的提示词。**只有 `sections` 一格**，而这个模块刚写出来时这里有三格
 * （`hasCharter` / `placeholderPending`），两格都被删了 —— 删的理由就是 0057 §6
 * 那条判据，记在这里是因为它是我自己在【同一轮】里造的：
 *  · `hasCharter` —— 唯一的实现【恒返回 true】。「没有岗位书」那一支根本不走这个函数
 *    （runtime 拿到 `undefined` 时直接拼 `NO_CHARTER_LINE`，压根不构造 CharterPrompt）。
 *    所以它是一个恒真字段，而它的注释在描述一条【不存在的】false 分支 ——
 *    比没写更坏：下一个人会去写 `if (p.hasCharter)`，而那个 else 永远不可达。
 *  · `placeholderPending` —— 值是算出来的（不是恒真），但【零消费者】：唯一的读者
 *    只读 `.sections`。占位这件事**已经进了渲染出来的那句话**，那才是被消费的形状。
 *    留着一个不进任何断言的布尔，就是 0057 §6 说的「删掉它而全绿的断言是装饰」的
 *    数据结构版本 —— 装饰会让人以为那一维有人管。
 * ⇒ 「标准未签字」这件事的唯一出口是**渲染进 sections 的那句提示词**（`acceptanceLines`
 *   里 pending 那一支），它跟着话进 agent 的嘴，而不是变成一个没人读的 flag。
 */
export interface CharterPrompt {
  /** 每一格渲染出的一行（不含身份句，身份句由调用方给，见 runtime 的 rolePrompt）。 */
  readonly sections: readonly string[];
}

/** 一条一格，前面带「· 」。空列表 ⇒ 整格不出现（不留一行「你的禁止项：」后面空着）。 */
function bullets(label: string, items: readonly string[]): string[] {
  if (items.length === 0) return [];
  return [label, ...items.map((s) => "  · " + s)];
}

/**
 * 验收标准逐条渲染。`condition` 是「不合格的情形」（`GateCriterion` 的口径，
 * 见 graph/gates/evaluate.ts 的 CriterionOutcome），所以话要说成「出现这些情形 = 不合格」，
 * 而不是把 condition 当目标贴上去 —— 那会把「测试未通过」读成「去让测试通过」。
 */
function acceptanceLines(c: Charter): { lines: string[]; pending: boolean } {
  const real = c.acceptanceCriteria.filter(
    (a) => !a.condition.includes(CHARTER_PLACEHOLDER_ACCEPTANCE),
  );
  const pending = real.length < c.acceptanceCriteria.length;
  const lines: string[] = [];
  if (real.length > 0) {
    lines.push(
      "你的产出按下面这些情形判不合格（condition = 不合格的情形，不是目标）：",
    );
    for (const a of real) {
      const act =
        a.action === "escalate" ? "升级到 " + (a.target ?? "上级") : "打回";
      lines.push(
        "  · " +
          a.condition +
          " ⇒ " +
          act +
          (a.message === "" ? "" : "（" + a.message + "）"),
      );
    }
  }
  if (pending) {
    // 这一句是本模块最重要的一格：占位串【不能】以标准的样子进提示词。
    // 进了就等于对 agent 说「你有一条标准叫 CEO-PLACEHOLDER-ACCEPTANCE」，
    // 而它会当真空转，症状是「这一轮看起来有标准」—— 假绿的标准版。
    lines.push(
      "（注意：你的岗位书里【验收标准还没由 CEO 签字】，模板占位串还在。" +
        "所以这一轮没有任何机械标准可判，不要自称「按标准通过」。）",
    );
  }
  return { lines, pending };
}

/**
 * 升级触发器：schema 是 `string | {condition, target, action}` 的 union（§4.2.2 允许
 * 两种写法），所以这里必须【两条都渲染得出】。漏掉对象那一支的后果不是崩，
 * 是「岗位书写了升级目标而 agent 看不见」—— 它只会按默认往上走，安静地走错。
 */
function triggerText(t: Charter["escalationTriggers"][number]): string {
  return typeof t === "string"
    ? t
    : t.condition + " ⇒ " + t.action + " 到 " + t.target;
}

export function renderCharterPrompt(c: Charter): CharterPrompt {
  const acc = acceptanceLines(c);
  const sections: string[] = [
    "你是 [" +
      c.roleId +
      "]（" +
      c.displayName +
      "），岗位书第 " +
      c.version +
      " 版。",
  ];
  sections.push(
    ...bullets(
      "诚实边界（你自认做不到什么，遇到就说，不要硬编）：",
      c.honestyBoundaries,
    ),
  );
  sections.push(...acc.lines);
  sections.push(
    ...bullets("禁止动作（黑名单，运行时只能让它变长）：", c.forbiddenActions),
  );
  const ds = c.decisionScope;
  sections.push(...bullets("你可以自己定的：", ds.autonomous));
  sections.push(...bullets("要先商量的：", ds.requiresConsultation));
  sections.push(...bullets("你无权决定的：", ds.forbidden));
  const jm = c.judgmentMode;
  sections.push("判断模式：" + jm.type);
  sections.push(...bullets("  硬规则（没有判断空间）：", jm.strictRules));
  sections.push(
    ...bullets("  有限判断（可判断但须附理由）：", jm.boundedJudgment),
  );
  sections.push(...bullets("  完全自主：", jm.fullDiscretion));
  sections.push(
    ...bullets(
      "出现这些情形就升级（不是你说了算的边界）：",
      c.escalationTriggers.map(triggerText),
    ),
  );
  // untrusted_inputs 是 optional：undefined 与空数组在契约里是两件事
  // （「岗位书没说过」对「说过而没有」），所以这里判 undefined 而不是统一当空。
  if (c.untrustedInputs !== undefined && c.untrustedInputs.length > 0) {
    // §12.6：这一格是唯一执行点 —— 门控只能判交上来的证据，管不了 agent 心里把什么当证据。
    sections.push(
      ...bullets(
        "这些输入【不可信】，不能当证据（别人自称做完了 ≠ 做完了）：",
        c.untrustedInputs,
      ),
    );
  }
  // 只回 sections：见 CharterPrompt 文件头那两个被删掉的字段。`acc.pending` 在这里
  // 【只用来决定要不要 push 那句话】，不作为 flag 交出去 —— 那句话就是它的消费者。
  return { sections };
}

/** 没岗位书时的那一句。刻意【不】渲染成一份通用岗位书 —— 那正是 O2 要防的事。 */
export const NO_CHARTER_LINE =
  "hub 里【没有你的岗位书】（role_charters 里没有你的任何版本）。" +
  "所以没有任何人签过你该做什么、不许做什么、怎么算做完 —— " +
  "不要凭空扮演一个岗位：把这一点如实写进你的汇报，然后按简报里的事实做你能做的那部分。";
