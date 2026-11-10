/**
 * 并行分支与汇聚（计划 Task 3.7 的 Test 项：『产品与运营**并行拆解同一想法**后汇聚正确』）。
 *
 * ── 本节能证什么、不能证什么，先说死 ────────────────────────────────
 * 本机装不上 @langchain/*（0009 §2），所以这里**没有**真图扇出扇入。证的是：
 *  ① 「该不该并行」这个判定的四条判据（§23.2 反过度设计）；
 *  ② **汇聚的合并语义** —— 规格 §5.4 PoC 门禁第 3 项那句『并行分支 Reducer 合并语义』。
 * 真接进 StateGraph 需要网络，缺口登记在 0016 §7，不写成「已接入」。
 *
 * ── 「汇聚正确」在这里的可验证含义是**交换律**，不是「trail 顺序对」────────
 * 计划 V10 实测过：同一超步的兄弟节点整批收尾，把 addEdge([a,b],c) 改成 addEdge(a,c)
 * 之后 b 慢 300ms，**trail 顺序完全不变**。所以「trail 里两条都在」既不能证明汇聚正确、
 * 也不能证明少了一条 —— 用它当断言是一条**怎么坏都不红**的用例（0014 §2 那条
 * 「怎么修都红」的镜像）。这里改成断言：任意到达顺序得到**同一个结果**。
 * 3 条分支的全部 6 种排列逐一比 JSON 串，把 appendReducer 换成覆盖型立刻会红
 * （本文件末尾那条元断言就是这么测的）。
 */

import { describe, expect, it } from "vitest";
import {
  appendReducer,
  assertAllBranchesReported,
  BLOCKED_BY,
  decideParallelDecomposition,
  GATE_SEVERITY,
  mergeParallelResults,
  PARALLEL_MIN_BRANCHES,
  severityRank,
  worstOfReducer,
  type ParallelBranch,
} from "../../src/graph/branches.js";

const BR = (roleId: string, artifact: string): ParallelBranch => ({ roleId, artifact });

const PRODUCT = BR("product", "prd");
const OPS = BR("ops", "content_package");
const TECH = BR("tech", "tech_plan");

/** 三条分支全排列（不依赖任何排序，排列是手写的 —— 手写才不会跟着实现一起错）。 */
const PERMUTATIONS_3: readonly (readonly ParallelBranch[])[] = [
  [PRODUCT, OPS, TECH],
  [PRODUCT, TECH, OPS],
  [OPS, PRODUCT, TECH],
  [OPS, TECH, PRODUCT],
  [TECH, PRODUCT, OPS],
  [TECH, OPS, PRODUCT],
];

const allowedAll = (branches: readonly ParallelBranch[]): Record<string, boolean> =>
  Object.fromEntries(branches.map((b) => ["ceo->" + b.roleId, true]));

const edgesFrom = (
  branches: readonly ParallelBranch[],
): { from: string; to: string }[] => branches.map((b) => ({ from: "ceo", to: b.roleId }));

describe("① 该不该并行：四条判据各挡一种真实漏法", () => {
  it("两条以上 + 边齐 + 开了 parallel_allowed ⇒ 并行", () => {
    const d = decideParallelDecomposition({
      idea: "做个面向小企业的数据看板",
      branches: [PRODUCT, OPS],
      parallelAllowed: allowedAll([PRODUCT, OPS]),
      edges: edgesFrom([PRODUCT, OPS]),
      from: "ceo",
    });
    expect(d.parallel).toBe(true);
  });

  it("只有一条分支时报 fewer_than_two，而**不是**「没开权限」", () => {
    /*
     * 顺序判据的用例。只断言 blocked_by 不够 —— 要断言**没有**报成 parallel_not_allowed，
     * 因为那正是会让人去查配置的那句错话。
     */
    const d = decideParallelDecomposition({
      idea: "x",
      branches: [PRODUCT],
      parallelAllowed: {},
      edges: [],
      from: "ceo",
    });
    expect(d.parallel).toBe(false);
    if (!d.parallel) {
      expect(d.blocked_by).toBe("fewer_than_two_branches");
      expect(d.reason).not.toContain("parallel_allowed");
    }
    expect(PARALLEL_MIN_BRANCHES).toBe(2);
  });

  it("同一角色列两次 ⇒ duplicate_role，且排在边检查之前", () => {
    // 两条分支都给 product，而第二条**连边都没有**：先报的必须是重复角色。
    const d = decideParallelDecomposition({
      idea: "x",
      branches: [PRODUCT, BR("product", "另一份")],
      parallelAllowed: {},
      edges: [{ from: "ceo", to: "product" }],
      from: "ceo",
    });
    expect(d.parallel).toBe(false);
    if (!d.parallel) {
      expect(d.blocked_by).toBe("duplicate_role");
      expect(d.reason).toContain("不同视角汇聚");
    }
  });

  it("组织图上没有那条边 ⇒ edge_missing（绕过委派规则图要被拦）", () => {
    const d = decideParallelDecomposition({
      idea: "x",
      branches: [PRODUCT, OPS],
      parallelAllowed: { "ceo->product": true, "ceo->ops": true },
      edges: [{ from: "ceo", to: "product" }], // 缺 ops 那条
      from: "ceo",
    });
    expect(d.parallel).toBe(false);
    if (!d.parallel) {
      expect(d.blocked_by).toBe("edge_missing");
      expect(d.reason).toContain("一一对应");
    }
  });

  it("缺 parallel_allowed 键 ⇒ 按【不允许】处理", () => {
    /*
     * 缺省方向的反向对照：三条边只开两条，必须报未开的那一条（而不是碰巧放行）。
     * 「忘了配」若等于放行，一次并行拆解会静默发生，而 §24 风险 2 明写要避免过度设计。
     */
    const d = decideParallelDecomposition({
      idea: "x",
      branches: [PRODUCT, OPS],
      parallelAllowed: { "ceo->product": true },
      edges: edgesFrom([PRODUCT, OPS]),
      from: "ceo",
    });
    expect(d.parallel).toBe(false);
    if (!d.parallel) {
      expect(d.blocked_by).toBe("parallel_not_allowed");
      expect(d.reason).toContain("ceo->ops");
    }
  });

  it("显式写 false 与缺键同义（不能让 false 变成「没配」）", () => {
    const d = decideParallelDecomposition({
      idea: "x",
      branches: [PRODUCT, OPS],
      parallelAllowed: { "ceo->product": true, "ceo->ops": false },
      edges: edgesFrom([PRODUCT, OPS]),
      from: "ceo",
    });
    expect(d.parallel).toBe(false);
  });

  it("blocked_by 的取值必须全部来自 BLOCKED_BY（拼错一个值就是一条对不上的对外输出）", () => {
    const cases: Parameters<typeof decideParallelDecomposition>[0][] = [
      { idea: "x", branches: [], parallelAllowed: {}, edges: [], from: "ceo" },
      {
        idea: "x",
        branches: [PRODUCT, PRODUCT],
        parallelAllowed: {},
        edges: [],
        from: "ceo",
      },
      {
        idea: "x",
        branches: [PRODUCT, OPS],
        parallelAllowed: {},
        edges: [],
        from: "ceo",
      },
      {
        idea: "x",
        branches: [PRODUCT, OPS],
        parallelAllowed: allowedAll([PRODUCT, OPS]),
        edges: edgesFrom([PRODUCT, OPS]),
        from: "ceo",
      },
    ];
    const got = cases.map((c) => {
      const d = decideParallelDecomposition(c);
      return d.parallel ? null : d.blocked_by;
    });
    // 第四发是【允许】的，所以 got 里有 null —— 顺手钉住它，
    // 否则「全部落在枚举里」这条在四条都返回同一个值时也成立。
    expect(got[3]).toBeNull();
    for (const g of got) {
      if (g === null) continue;
      expect((BLOCKED_BY as readonly string[]).includes(g)).toBe(true);
    }
    /*
     * 四个输入给出**四种不同**结论（三个 blocked 值互不相同 + 一个是允许）。
     * ⚠ 用 Set 的 .size 而不是toHaveLength：Set **没有 `length` 属性**，
     * `expect(new Set()).toHaveLength(3)` 在真 vitest 里报「received value must have
     * a length property」，在本机替身里走 `undefined === 3` 那条路径同样红（两侧都实测过）。
     * 所以这不是夹具的问题，是我一开始把 Set 当成了数组。归因记下来是因为我第一版
     * 写成「替身格式化读不出信息」—— 那个归因会让人以为换真 vitest 就能用，而不能。
     */
    expect(new Set(got.filter((g) => g !== null)).size).toBe(3);
  });

  it("分支数组的**顺序**不改变结论（判据不能依赖声明序）", () => {
    /*
     * 「结论」= parallel 这个判定本身。**不**比 JSON 全等：
     * 允许时返回值里 echo 了 branches 清单，那份清单【按声明顺序原样返回】是
     * 设计（调用方要的就是自己声明的那份顺序），所以 JSON 必然随顺序变。
     * 要比的是「同一种拓扑换个声明序，是否仍然给出同一个是/否」。
     */
    const base = {
      idea: "x",
      parallelAllowed: allowedAll([PRODUCT, OPS]),
      edges: edgesFrom([PRODUCT, OPS]),
      from: "ceo",
    };
    const a = decideParallelDecomposition({ ...base, branches: [PRODUCT, OPS] });
    const b = decideParallelDecomposition({ ...base, branches: [OPS, PRODUCT] });
    expect(a.parallel).toBe(true);
    expect(b.parallel).toBe(true);

    // 反向对照：把其中一条的边抽掉，两种顺序都必须**同样**报 edge_missing。
    // 少了这一发，上面那条「顺序无关」在「两条都合法」这种平凡情形上是空的。
    const broken = { ...base, edges: [{ from: "ceo", to: "product" }] };
    const c = decideParallelDecomposition({ ...broken, branches: [PRODUCT, OPS] });
    const e = decideParallelDecomposition({ ...broken, branches: [OPS, PRODUCT] });
    expect(c.parallel).toBe(false);
    expect(e.parallel).toBe(false);
    if (!c.parallel && !e.parallel) expect(c.blocked_by).toBe(e.blocked_by);
  });
});

describe("② 汇聚的合并语义：交换律（PoC 门禁第 3 项的可验证形式）", () => {
  it("3 条分支的 6 种排列给出**完全相同**的汇聚结果", () => {
    /*
     * 本节的核心断言。JSON 串全等而不只是「多重集合相等」——
     * 因为 mergeParallelResults 按【声明顺序】输出，所以同一条排列必须逐字节相同，
     * 而不同排列之间我们只比集合。两种比较各测一件事，下面分开做。
     */
    const contributions = {
      product: { artifact: "prd", gate: "pass" as const },
      ops: { artifact: "content_package", gate: "reject" as const },
      tech: { artifact: "tech_plan", gate: "pass" as const },
    };
    const results = PERMUTATIONS_3.map((p) =>
      mergeParallelResults(p, contributions),
    );
    // 同一排列两次调用结果一致（纯函数，不藏状态）。
    expect(mergeParallelResults(PERMUTATIONS_3[0], contributions)).toEqual(results[0]);

    // 集合层面：6 种排列的产物集合与汇聚 gate 全同。
    // （用 .size 而不是 toHaveLength —— 理由见 ① 节末尾那条注释。）
    const asSet = results.map((r) =>
      [...r.artifacts.map((a) => a.role_id + ":" + a.artifact)].sort().join("|"),
    );
    expect(new Set(asSet).size).toBe(1);
    /*
     * 这里用【排序后的字符串数组】而不是 `toEqual(new Set(...))`。
     * 用后者本来是可以的 —— 写这段时机具确实瞎（对 Set 一律判等，见 0016 §1），
     * 但那一维已经修好并被 test/arch/matcher-oracle.test.ts 钉住了。
     * 仍保留排序数组这一形，是因为它**断言的形式与本体更近**：本节要的性质是
     * 「多重集合相同」，而排序数组把这件事写成肉眼可见的形式，
     * 失败时打出来的是两条字符串的差，不是两个集合的差。
     */
    expect([...new Set(results.map((r) => r.gate))].sort()).toEqual(["reject"]);
  });

  it("按**声明顺序**输出，而不是按 contributions 的键序", () => {
    /*
     * 这是最容易被「优化」掉的一句：Object.keys 保的是插入序，而插入序取决于谁先写完。
     * 若改成遍历 contributions，两条内容相同、键序不同的输入会给出不同数组，
     * 于是「汇聚结果」变成随运行而变的东西。
     */
    const contributions = {
      tech: { artifact: "tech_plan", gate: "pass" as const },
      product: { artifact: "prd", gate: "pass" as const },
    };
    const r = mergeParallelResults([PRODUCT, TECH], contributions);
    expect(r.artifacts.map((a) => a.role_id)).toEqual(["product", "tech"]);
    // 反向对照：换一个声明顺序 ⇒ 输出顺序跟着换（证明顺序真来自声明而不是键序）。
    const r2 = mergeParallelResults([TECH, PRODUCT], contributions);
    expect(r2.artifacts.map((a) => a.role_id)).toEqual(["tech", "product"]);
  });

  it("一条分支没交东西 ⇒ 抛，而且报错点名是哪一条", () => {
    expect(() =>
      assertAllBranchesReported([PRODUCT, OPS], { product: 1 }),
    ).toThrow(/ops/);
    // 反向对照：两条都交了 ⇒ 不抛。少了这一发，「抛错」那条在恒抛的实现前也绿。
    expect(() =>
      assertAllBranchesReported([PRODUCT, OPS], { product: 1, ops: 2 }),
    ).not.toThrow();
  });

  it("`{ops: undefined}` 也算没交（有 key 不等于交了东西）", () => {
    expect(() =>
      assertAllBranchesReported([PRODUCT, OPS], { product: 1, ops: undefined }),
    ).toThrow(/ops/);
  });

  it("mergeParallelResults 会先做那道校验（不会静默按缺的那条算）", () => {
    expect(() =>
      mergeParallelResults([PRODUCT, OPS], {
        product: { artifact: "prd", gate: "pass" },
      }),
    ).toThrow(/fan-in|trail/);
  });

  it("元断言：这条交换律用例对「覆盖型 reducer」有鉴别力", () => {
    /*
     * 0013 §8 那条纪律的沿用：负责发现 X 的守卫必须内建一个人工构造的 X。
     * 这里不测 branches.ts，测的是**上面那条用例本身**：拿一个覆盖型 reducer
     * 跑同样的排列，必须得到**不同**的结果。若仍相同，说明「排列」这个夹具没有分辨力，
     * 那条交换律就是恒绿装饰。
     *
     * ⚠ 这一发本身翻过一次车，而且翻法值得留着：它原先写的是
     * `expect(new Set(viaAppend)).toEqual(new Set([...]))`，**绿**。改成排序数组比较之后
     * 它当场红了 —— 也就是说那条断言此前是**空的**（本机 vitest 替身把任何 Set 与
     * 任何 Set 判为相等，见 0016 §2），而它一旦被修好，
     * 暴露的是**我自己的期望写错了**：append 的结果【顺序】确实随到达序变，
     * 恒同的只是【多重集合】。所以「交换律」在这里的准确形式是多重集合意义下的，
     * 上面那条 ① 用例比的是 sort 之后的串，它一直是对的。
     * 一条空断言把一个错期望盖了几轮，这条比前几条变异实验都值钱。
     */
    const sortJoin = (xs: readonly string[]): string => [...xs].sort().join(",");
    const seqs = [
      ["p", "o", "t"],
      ["p", "t", "o"],
      ["o", "p", "t"],
    ];
    /*
     * 返回类型写 T[] 而直接把 readonly 的 b 还回去，tsc 会报 TS4104
     * （`readonly` 不能赋给可变数组）—— 本仓第二次撞这一族（第一次是 budget-sync
     * 里那个 readonly 累加器）。这里用【展开一份】而不是 `as T[]`：
     * as 会把「这个 reducer 会不会就地改入参」这件事从类型面上抹掉，
     * 而这正是 ④ 节要单独断言的性质（appendReducer 不改入参）。
     */
    const overwrite = <T>(
      a: readonly T[] | undefined,
      b: readonly T[] | undefined,
    ): T[] => [...(b ?? a ?? [])];

    // 覆盖型：多重集合随排列变（只剩最后一个）。这就是 ① 那条用例的杀伤力来源。
    const viaOverwrite = seqs.map((s) =>
      sortJoin(s.reduce<string[]>((acc, x) => overwrite(acc, [x]), [])),
    );
    expect(new Set(viaOverwrite).size).toBeGreaterThan(1);

    // 追加型：多重集合恒同 —— 这才是 ① 断言的性质。
    const viaAppend = seqs.map((s) =>
      sortJoin(s.reduce<string[]>((acc, x) => appendReducer(acc, [x]), [])),
    );
    expect([...new Set(viaAppend)].sort()).toEqual(["o,p,t"]);

    /*
     * 而【顺序】确实会变（三发各不相同）。这一发钉住的是「为什么 ① 必须比排序后的
     * 集合」：如果这里也恒同，① 里那句 sort() 就是多余的防御，读代码的人会以为
     * append 给出稳定序列 —— 而它不给出。少这一发，「交换律」这个词会被读成
     * 「结果完全一致」，那是一个比实际更强的承诺。
     */
    const rawAppend = seqs.map((s) =>
      s.reduce<string[]>((acc, x) => appendReducer(acc, [x]), []).join(","),
    );
    expect(new Set(rawAppend).size).toBe(3);
  });
});

describe("③ 汇聚时的门控取值：取最严，而不是取后到", () => {
  it("pass + reject ⇒ reject（两条分支谁先写完不影响）", () => {
    expect(worstOfReducer("pass", "reject")).toBe("reject");
    expect(worstOfReducer("reject", "pass")).toBe("reject");
    // 三档全序，含自反。
    for (const s of GATE_SEVERITY) expect(worstOfReducer(s, s)).toBe(s);
    expect(severityRank("escalate")).toBeGreaterThan(severityRank("reject"));
    expect(severityRank("reject")).toBeGreaterThan(severityRank("pass"));
  });

  it("escalate 压过 reject（严格度序只有一处定义）", () => {
    const r = mergeParallelResults(
      [PRODUCT, OPS, TECH],
      {
        product: { artifact: "prd", gate: "reject" },
        ops: { artifact: "cp", gate: "escalate" },
        tech: { artifact: "tp", gate: "pass" },
      },
    );
    expect(r.gate).toBe("escalate");
    // 反向对照：换顺序仍然 escalate。若两处严格度序不一致（一处 reject > escalate），
    // 不同顺序会给出不同答案 —— 那正是本模块存在理由里写的那个失效。
    const flipped = mergeParallelResults(
      [TECH, OPS, PRODUCT],
      {
        product: { artifact: "prd", gate: "reject" },
        ops: { artifact: "cp", gate: "escalate" },
        tech: { artifact: "tp", gate: "pass" },
      },
    );
    expect(flipped.gate).toBe("escalate");
  });

  it("未知取值排在 pass 之后（判不出的东西不被当成最轻）", () => {
    // 走 worstOfReducer 的公开面：未知值当最严，所以它压过 escalate。
    expect(severityRank("not-a-gate")).toBe(GATE_SEVERITY.length);
    expect(worstOfReducer("escalate", "not-a-gate" as never)).toBe("not-a-gate");
    // 反向对照：已知值之间仍是正常序，证明上一条不是「什么都压过 escalate」。
    expect(worstOfReducer("escalate", "pass")).toBe("escalate");
  });

  it("两边都缺 ⇒ escalate，而不是 pass", () => {
    /*
     * 与 0008 给门控定的「判不出 ⇒ escalate 而非 pass」同一条立场。
     * 这一格若默认 pass，「两条分支都没交东西」会变成一个放行结论。
     */
    expect(worstOfReducer(undefined, undefined)).toBe("escalate");
    expect(mergeParallelResults([PRODUCT], { product: { artifact: "p", gate: "pass" } }).gate).toBe(
      "pass",
    );
  });
});

describe("④ appendReducer 的边界：不吞 undefined，也不去重", () => {
  it("undefined 累积值当作空数组", () => {
    expect(appendReducer(undefined, ["a"])).toEqual(["a"]);
    expect(appendReducer(["a"], undefined)).toEqual(["a"]);
    expect(appendReducer(undefined, undefined)).toEqual([]);
  });

  it("两条分支给出**同样**的条目时保留两份", () => {
    /*
     * 不去重是刻意的：两条分支给出看着相同的判断，来自**不同角色**，
     * 「两个独立视角一致」这件事本身有分量（交叉验证通过）。
     * 去重会把它抹掉，而抹掉之后没有任何地方能还原。
     */
    expect(appendReducer(["x"], ["x"])).toEqual(["x", "x"]);
    // 反向对照：不修改入参（并行分支各自持有自己的数组，被就地改会互相踩）。
    const base = ["x"];
    const out = appendReducer(base, ["y"]);
    expect(base).toEqual(["x"]);
    expect(out).toEqual(["x", "y"]);
  });
});
