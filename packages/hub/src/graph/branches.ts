/**
 * 并行分支与汇聚（计划 Task 3.7 的另一半，规格 §3.3 `parallel_allowed` + §24 风险 2 的
 * 「一个想法同时涉及产品与运营，需并行拆解而非串行」）。
 *
 * ── 本模块不含任何 LangGraph 调用，这是**实测逼出来的**而不是风格 ──────────
 * 本机装不上 @langchain/*（0009 §2 三条通路：DNS 通、两个 registry 的 TCP 443 超时、
 * store 与锁文件零命中）。graph/company.ts 现在带着 15 个 TS2307 就是这个原因。
 * 所以这里能交付、也**只有**这些能被本机验证：
 *  ① 「该不该并行」这个**判定**（§23.2 反过度设计要求：无绕行需求就不许启用）；
 *  ② **汇聚的合并语义**——也就是规格 §5.4 PoC 门禁第 3 项那句『并行分支 Reducer 合并语义』。
 *     reducer 本质是一个纯函数 `(accumulated, update) => merged`，框架只是**调用**它，
 *     合并对不对与框架在不在无关。这一半做实，接上 `Annotation({…, reducer})` 是接线。
 * 真接进 StateGraph 的扇出扇入需要网络，缺口登记在 0016 §7「没做到」，不写成「已接入」。
 *
 * ── 为什么合并语义要单独写而不是「用框架默认的」────────────────────────
 * 默认 reducer 是**覆盖**（`(_a, b) => b`）。并行两条分支写同一个通道时，覆盖的意思是
 * 「后到的那条赢」，而**谁后到不可依赖**：V10 实测过，同一超步的兄弟节点整批收尾，
 * 连 trail 顺序都没有鉴别力（把 `addEdge([a,b],c)` 改成 `addEdge(a,c)`，b 慢 300ms
 * 顺序也不变）。所以「后到的赢」在框架这里等价于「随机的赢」。
 * 本模块给的 reducer 的用例钉的是**多重集合**意义下的不变性，这两个词的区别要说准：
 *  - **多重集合**不变：追加型具备 —— 谁先来不影响【有哪些】条目。
 *  - **序列**不变：追加型【不】具备 —— `[a,b]` 与 `[b,a]` 给出不同数组。
 * 所以汇聚点若要的是「产物清单的确定顺序」，那一条由 mergeParallelResults 按
 * 【分支声明顺序】输出来给，而不是靠 reducer —— 交给 reducer 等于交给到达序。
 * 这一区分是本轮被自己的元断言逼出来的：那条元断言原先写成 `toEqual(new Set(…))`
 * 而**恒绿**，改好之后当场红，红出来的是【我自己的期望错了】。
 * 详见 test/graph/branches.test.ts 元断言那发的注释与 0016 §2、§5。
 */

/**
 * 一条并行分支的**声明**。名字用 branch 而不是 node：一条分支上可能有多个节点，
 * 本模块管的是「哪几条支路可以同时跑、跑完怎么合」，不管支路内部。
 */
export interface ParallelBranch {
  readonly roleId: string;
  /** 这条分支产出的交接物类型（规格 §3.3 `handoff_artifact`）。 */
  readonly artifact: string;
}

/** 判定输入：一个想法要拆给谁。 */
export interface DecompositionInput {
  readonly idea: string;
  /** 拟并行的分支，顺序**不应**影响任何结论（有用例钉）。
   *  但它是数组而不是 Set —— 因为「同一个角色被列了两次」本身是要报出来的输入错误，
   *  换成 Set 会让那次重复在类型面上消失。 */
  readonly branches: readonly ParallelBranch[];
  /**
   * 组织图上这些边是否声明了 `parallel_allowed`（规格 §3.3 那条边的第四个字段）。
   * key 形如 `"fromId->toId"`；**缺键按不允许**处理（§4.1「受约束的自主」：
   * 缺配置时落到收紧那一侧，与 contracts/org/validate.ts 的「缺了就拦」同一条）。
   */
  readonly parallelAllowed: Readonly<Record<string, boolean>>;
  /** 从想法到各分支的委派边。缺边 ⇒ 那条分支根本不该存在。 */
  readonly edges: readonly { readonly from: string; readonly to: string }[];
  /** 起点（通常是产品或运营的上游节点，由调用方决定，本模块不猜组织图形状）。 */
  readonly from: string;
}

export const PARALLEL_MIN_BRANCHES = 2;

/** 判定的返回值：允许就给出分支清单，不允许就给出**具体**理由。 */
export type ParallelDecision =
  | { readonly parallel: true; readonly branches: readonly ParallelBranch[] }
  | { readonly parallel: false; readonly reason: string; readonly blocked_by: BlockedBy };

export const BLOCKED_BY = [
  "fewer_than_two_branches",
  "duplicate_role",
  "edge_missing",
  "parallel_not_allowed",
] as const;
export type BlockedBy = (typeof BLOCKED_BY)[number];

/**
 * 「这个想法该不该并行拆解」。
 *
 * 顺序是**有意义**的，四条判据各挡一种真实漏法，先报哪一个决定人先看到哪句人话：
 *  1. **少于两条就不叫并行**。这一条排第一是因为它排掉的是「配置写错只剩一条」——
 *     此时后面那三条判据全在判那唯一一条，会报出一句「parallel_allowed 没开」，
 *     而真相是分支少了一条。症状指向错误的方向。
 *  2. **同一角色列两次**：两条分支给同一个角色，扇入时两个 update 来自同一个角色，
 *     于是「两个视角汇聚」这件事**结构上不存在**，而它正是并行唯一的收益。
 *     这一条排在边检查前面：先报「你的两条分支是同一个角色」比先报「有一条边不存在」有用。
 *  3. **边不存在**：没有 from→to 的委派边却要跑那条支路，等于绕过委派规则图
 *     （§3.3 那句「与 LangGraph 的图结构一一对应」）。
 *  4. **parallel_allowed 没开**：最后判它，因为前三条都是「这个并行根本不成立」，
 *     而这一条是「成立但没被授权」。顺序反过来的话，一个配置齐全但分支写重的草稿
 *     会被报成「没开权限」，人去查配置，而真正的问题是分支。
 */
export function decideParallelDecomposition(
  o: DecompositionInput,
): ParallelDecision {
  if (o.branches.length < PARALLEL_MIN_BRANCHES) {
    // ⚠ 这句文案里**不要出现 "parallel_allowed" 字样**（哪怕是「不是它」的否定式）。
    // test/graph/branches.test.ts 有一条用例断言这一档的 reason 里不含那个词，
    // 用来保证「分支少了一条」不会被误读成「配置没开」。我第一版在文案里加了一句
    // 「若继续往下判，报出的会是 parallel_allowed 没开」的讲解 —— 那是**给读代码的人**
    // 看的，却把那条断言撞红了（0015 §7 第三错同一族：错误文案里的字样会让
    // 断言在错误的那一半上通过或失败）。讲解留在注释里，文案只讲该怎么修。
    return {
      parallel: false,
      blocked_by: "fewer_than_two_branches",
      reason:
        "只有 " +
        o.branches.length +
        " 条分支，不构成并行。并行的前提是有【两条以上】各自独立的支路 —— " +
        "要修的是分支清单，不是任何开关。",
    };
  }
  const seen = new Set<string>();
  for (const b of o.branches) {
    if (seen.has(b.roleId)) {
      return {
        parallel: false,
        blocked_by: "duplicate_role",
        reason:
          "分支里 [" +
          b.roleId +
          "] 出现两次。并行的全部收益是【不同视角汇聚】，同一角色跑两遍只多一份" +
          "重复产物与两倍花费，而汇聚点会以为那是两个独立判断。",
      };
    }
    seen.add(b.roleId);
  }
  for (const b of o.branches) {
    const has = o.edges.some((e) => e.from === o.from && e.to === b.roleId);
    if (!has) {
      return {
        parallel: false,
        blocked_by: "edge_missing",
        reason:
          "组织图上没有 [" +
          o.from +
          " → " +
          b.roleId +
          "] 这条委派边，却要它跑一条支路。§3.3 要求委派规则图与运行图一一对应 —— " +
          "绕过图跑支路，等于让一次拆解不受门控约束。",
      };
    }
  }
  for (const b of o.branches) {
    const key = o.from + "->" + b.roleId;
    if (o.parallelAllowed[key] !== true) {
      return {
        parallel: false,
        blocked_by: "parallel_not_allowed",
        reason:
          "边 [" +
          key +
          "] 没有声明 parallel_allowed。**缺键按不允许**处理：§3.3 那个字段存在的" +
          "意义就是要人显式开启，缺省放行会让「忘了配」变成一次并行拆解" +
          "（§24 风险 2 明写要避免过度设计）。",
      };
    }
  }
  return { parallel: true, branches: o.branches };
}

/* ───────────────────────── 汇聚 reducer ───────────────────────── */

/**
 * **追加**型 reducer：并行分支各自产出，汇聚点要看到**全部**。
 *
 * 这是并行拆解那个场景真正要的合并（产品视角 + 运营视角 = 两份都在）。
 * 顺序不敏感靠两件事保证，缺一不可：
 *  - 追加而非插入指定位置；
 *  - **不去重**：两条分支给出【看着相同】的条目时，它们来自【不同的角色】，
 *    去重会把「两个独立角色给出同样判断」这个信息抹掉，而那个信息是有分量的
 *    （两个视角一致 = 交叉验证通过）。所以这里刻意不做 Set。
 *
 * 与 company.ts 里 trail 那个 reducer 同一个形状 —— 不 import 它是因为那一份属于
 * CompanyNode 类型（本模块不知道图有哪些节点）。两份形状相同而类型不同，
 * 不是「两份抄本」那种漂移风险（抄本的风险是**判据**有两处，这里没有判据）。
 */
export function appendReducer<T>(
  accumulated: readonly T[] | undefined,
  update: readonly T[] | undefined,
): T[] {
  return [...(accumulated ?? []), ...(update ?? [])];
}

/**
 * **取最坏**型 reducer：两条分支并行做门控判定时，汇聚点必须取**最严**的那一个。
 *
 * 为什么不能用默认覆盖：两条分支一条 pass 一条 reject，覆盖的结果取决于谁后到，
 * 而「谁后到」按 V10 的实测**不可依赖** ⇒ 同一个输入跑两次可能一次放行一次拒。
 * 那是比一直拒更坏的失效：它看起来工作正常。
 *
 * 严格度序排在这里而不是散在各调用点：「escalate 比 reject 更严」这件事有两处判据时，
 * 一处按 escalate > reject、另一处按 reject > escalate，会出现**两个汇聚点给出相反答案**，
 * 而那比统一取错更难查。
 */
export const GATE_SEVERITY = ["pass", "reject", "escalate"] as const;
export type GateSeverity = (typeof GATE_SEVERITY)[number];

export function severityRank(s: string): number {
  const i: number = (GATE_SEVERITY as readonly string[]).indexOf(s);
  if (i < 0) {
    // 未知取值当**最严**处理。判不出来的东西不该被排在 pass 前面就放行。
    return GATE_SEVERITY.length;
  }
  return i;
}

export function worstOfReducer(
  accumulated: GateSeverity | undefined,
  update: GateSeverity | undefined,
): GateSeverity {
  if (accumulated === undefined) return update ?? "escalate";
  if (update === undefined) return accumulated;
  return severityRank(update) > severityRank(accumulated) ? update : accumulated;
}

/**
 * 汇聚点的**入参校验**：每条分支都必须真的交过东西。
 *
 * 这一条存在的全部理由是 V10。计划 V10 的实测结论原话是「Pregel 超步调度让 trail 顺序
 * 对 fan-in 没有鉴别力」，并给出可观测证据是**汇聚节点读到的 state 值**。
 * 也就是说「trail 里有两条分支的名字」**不是**「两条分支都跑完了」的证据 ——
 * 用 trail 断言汇聚正确，是一条**看起来强而实际弱**的断言（0014 §2 那条
 * 「怎么修都红」的反面：怎么坏都不红）。
 *
 * 所以这里判的是**每条分支有没有留下自己那一格的值**，而不是它有没有出现在某个列表里。
 * 分支的 key 用 roleId：一条支路一个角色，是本模块的唯一口径（并行判据第 2 条就排掉了
 * 同角色两条支路，所以这个 key 不会撞）。
 */
export function assertAllBranchesReported(
  branches: readonly ParallelBranch[],
  contributions: Readonly<Record<string, unknown>>,
): void {
  const missing: string[] = [];
  for (const b of branches) {
    if (!Object.hasOwn(contributions, b.roleId)) missing.push(b.roleId);
    // 有 key 但值是 undefined：**也算缺**。`{dev: undefined}` 与 `{}` 在
    // Object.hasOwn 上不同，但在「分支到底交没交东西」这个问题上是同一件事。
    // 判不出交没交的时候必须算没交（收紧方向，同 decideParallelDecomposition 缺键判法）。
    else if (contributions[b.roleId] === undefined) missing.push(b.roleId + "(值为 undefined)");
  }
  if (missing.length > 0) {
    throw new Error(
      "汇聚点缺 " +
        missing.length +
        " 条分支的产出 [" +
        missing.join(", ") +
        "]。⚠ 不要用【trail 里有它的名字】来替代这一格：" +
        "V10 实测同一超步的兄弟节点整批收尾，trail 顺序对 fan-in 没有鉴别力。" +
        "少一条分支的产出而照样汇聚，给出的是【看起来完整】的拆解结果。",
    );
  }
}

/**
 * 一次并行拆解的汇聚结果。
 */
export interface ParallelMergeResult {
  /** 全部产物，**顺序不敏感**：任何分支到达顺序都得到同一个多重集合（有用例钉）。 */
  readonly artifacts: readonly { readonly role_id: string; readonly artifact: string }[];
  readonly gate: GateSeverity;
}

/**
 * 把多条分支的产出合成一个汇聚结果。
 *
 * **交换律是本函数的验收**，不是实现细节：test/graph/branches.test.ts 对 3 条分支的
 * 全部 6 种排列逐一断言结果**完全相同**（JSON 串比）。这一发是有判别力的：
 * 把 appendReducer 换成 `(_a, b) => b ?? _a ?? []`（覆盖型），6 种排列里会有不同的结果。
 */
export function mergeParallelResults(
  branches: readonly ParallelBranch[],
  contributions: Readonly<
    Record<string, { readonly artifact: string; readonly gate: GateSeverity }>
  >,
): ParallelMergeResult {
  assertAllBranchesReported(branches, contributions);
  let artifacts: ParallelMergeResult["artifacts"] = [];
  let gate: GateSeverity | undefined;
  // 按**分支声明顺序**取，而不是按 contributions 的键序。
  // 这一句是本函数最容易写错的地方：Object.keys 的序在两种输入下会变（JS 的字符串键
  // 保序，但「保的是插入序」），而插入序取决于谁先写完 —— 于是 artifacts 的顺序
  // 会变成「随运行而变」。按声明顺序遍历，就把这个不确定性消掉了，
  // 而不需要事后排序（排序需要一个「谁在前」的业务判据，而这里没有）。
  for (const b of branches) {
    const c = contributions[b.roleId] as {
      artifact: string;
      gate: GateSeverity;
    };
    artifacts = appendReducer(artifacts, [{ role_id: b.roleId, artifact: c.artifact }]);
    gate = worstOfReducer(gate, c.gate);
  }
  return { artifacts, gate: gate ?? "escalate" };
}
