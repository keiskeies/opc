/**
 * 计划引用对账守卫（判据在 ./plan-refs.ts）。
 *
 * 一发真仓库 + 五发合成变异 + 一发口径对照。合成那几发是主力：真仓库那一发今天
 * 必然绿（悬空就是本轮刚修完的），它证不了「下次再拆一个编号时会红」。
 *
 * ⚠ 本文件【在自己的语料里】，所以下面的合成字符串一律拼出来、不直写。
 * 字面写出那个「关键字 + 空格 + 数字.数字」的形状，本文件自己就成了语料里的第 N 处
 * 悬空，判据于是把自己判红 —— 本轮我在 ./plan-refs.ts 的注释里已经踩进去一次。
 * 同族先例：0056 §2 为了不被「7 位 hex ⇒ 这是提交」那条守卫误判，规定哈希一律写全长。
 * 同一条约束下的同一个解法：**描述坏形状时，不能长成坏形状**。
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  danglingTaskRefs,
  PLAN_PATH,
  planTaskIds,
  readCorpus,
  referencedTaskIds,
  TASK_REF_RE,
} from "./plan-refs.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 拼出来，不直写 —— 见文件头那条约束。 */
const KW = "Ta" + "sk";
/** 一处引用文本。 */
const ref = (id: string): string => KW + " " + id;
/** 一条小节标题文本。 */
const head = (id: string, title: string): string =>
  "### " + KW + " " + id + "　" + title;

const PLAN = [
  "# 计划",
  head("0.1", "骨架"),
  head("0.4a", "探针"),
  head("0.4b", "实现"),
  head("1.8", "出口门禁"),
].join("\n");

/** 现数一批文本里的引用处数 —— 用判据自己那条正则，不另抄一份。 */
const countRefs = (texts: Iterable<string>): number =>
  [...texts].reduce((acc, t) => acc + [...t.matchAll(TASK_REF_RE)].length, 0);

describe("计划引用对账：判据本身", () => {
  it("控制组：引用全部指向存在的小节 ⇒ 零悬空", () => {
    const have = planTaskIds(PLAN);
    const files = new Map([
      [
        "packages/hub/src/a.ts",
        "// 见计划 " + ref("0.4a") + " 与 " + ref("1.8"),
      ],
      ["docs/decisions/0001.md", "计划 " + ref("0.4b") + " 的实现"],
    ]);
    expect([...have].sort()).toEqual(["0.1", "0.4a", "0.4b", "1.8"]);
    expect(danglingTaskRefs(files, have)).toEqual([]);
  });

  it("变异：写了一个不存在的编号 ⇒ 红并点名编号与次数", () => {
    const have = planTaskIds(PLAN);
    const files = new Map([
      ["packages/hub/src/a.ts", "// " + ref("0.4") + " 与 " + ref("0.4")],
      ["docs/decisions/0002.md", "// " + ref("9.9")],
    ]);
    const out = danglingTaskRefs(files, have);
    expect(out).toEqual([
      { id: "0.4", count: 2 },
      { id: "9.9", count: 1 },
    ]);
  });

  it("变异：小节的后缀就是引用格式的一部分 ⇒ 拿 0.4 冒充 0.4a 必须红", () => {
    // 本轮真实故障的形状：计划把编号拆成 a/b 两支，旧引用留在原地。
    // 判据若做成「前缀匹配」或「去掉字母后缀再比」，这一发就绿了 —— 而那正是病。
    const have = planTaskIds(PLAN);
    expect(danglingTaskRefs(new Map([["x.md", ref("0.4")]]), have)).toEqual([
      { id: "0.4", count: 1 },
    ]);
    // 对照：写成带后缀的那个立刻不红 ⇒ 判据不是「见到那个前缀就红」。
    expect(danglingTaskRefs(new Map([["x.md", ref("0.4a")]]), have)).toEqual(
      [],
    );
  });

  it("变异：计划解析不出任何小节 ⇒ 一律红，不放『0 个悬空』过去", () => {
    // 取材口径坏了（计划改名 / 标题格式变了）⇒ 集合为空，
    // 那时「没有任何悬空」是【什么都没解析到】换来的。
    const files = new Map([["x.md", ref("0.1")]]);
    expect(danglingTaskRefs(files, new Set())).toEqual([
      { id: "<计划里一个 Task 小节都没解析到>", count: 0 },
    ]);
    expect(planTaskIds("# 计划\n没有小节标题")).toEqual(new Set());
  });

  it("变异：标题降级成二级 ⇒ 集合变空 ⇒ 红且【红话是那句哨兵】", () => {
    // 上面那一发测的是「计划里压根没标题」，这一发测的是「标题在，但前缀换了」——
    // 计划文档被人整理过一次就够，而它换来的绿和那条坏掉的判据长得一模一样。
    // ⚠ 这里一度写成 toHaveLength(1)：round275-P1 把哨兵拔掉后它【仍然绿】，
    //   因为「引用 0.1 不存在」也恰好返回一条。数目不是判据，【红话是谁】才是。
    const demoted = PLAN.replace(/^### /gm, "## ");
    expect(planTaskIds(demoted)).toEqual(new Set());
    expect(
      danglingTaskRefs(new Map([["x.md", ref("0.1")]]), planTaskIds(demoted)),
    ).toEqual([{ id: "<计划里一个 Task 小节都没解析到>", count: 0 }]);
  });

  it("引用与标题都不在语料里的东西不会被凭空造出来（取材为空 ⇒ 引用为空）", () => {
    expect(referencedTaskIds(new Map())).toEqual(new Map());
    // 但空语料 + 空标题集仍然红：空不是通过。
    expect(danglingTaskRefs(new Map(), new Set()).length).toBe(1);
  });
});

describe("计划引用对账：真仓库那一半", () => {
  const corpus = readCorpus(ROOT);
  const refs = referencedTaskIds(corpus.files);
  const totalRefs = [...refs.values()].reduce((a, b) => a + b, 0);

  it("每一句「计划 Task X.Y」都指向计划里真存在的小节", () => {
    expect(danglingTaskRefs(corpus.files, corpus.planIds)).toEqual([]);
  });

  it("读数可信：取材的【每一块】都真的有料（不是被哪一块撑起来的）", () => {
    // 本轮实测（分块现数，命令见 .workbuddy/round275-scope-probe.mjs）：
    //   docs/decisions 的 md：65 个文件 / 221 处引用 / 49 个不同编号
    //   计划文档自己：230 处　|　全部 ts：610 处　|　合计 1061
    // 为什么要【分块】下限而不是只钉一个总数：round275-P4 把口径改成「计划 + 全部 ts」，
    // 总数仍有 840 ≥ 500，10 发【全绿】—— 而它恰好漏掉了本轮那 2 处真悬空所在的
    // docs/decisions 整块。**一个被撑大的总数会替一个空掉的分区作证**，这就是分块的全部理由。
    expect(corpus.planIds.size).toBeGreaterThanOrEqual(50);
    const bucket = (pred: (name: string) => boolean): [number, number] => {
      const sub = [...corpus.files].filter(([n]) => pred(n));
      return [sub.length, countRefs(sub.map(([, t]) => t))];
    };
    const isMd = (n: string): boolean => n.endsWith(".md");
    const [decFiles, decRefs] = bucket(
      (n) => n.startsWith("docs/decisions/") && isMd(n),
    );
    const [, planRefs] = bucket((n) => n === PLAN_PATH);
    const [, tsRefs] = bucket((n) => n.endsWith(".ts"));
    // 下限一律取实测的一半上下：够松，不会因日常增删而红；够紧，删掉一整块必红。
    expect(
      decFiles,
      "docs/decisions 的 md 几乎没进语料 ⇒ 口径又窄了",
    ).toBeGreaterThanOrEqual(50);
    expect(
      decRefs,
      "docs/decisions 整块零引用 ⇒ 本轮那 2 处真悬空恰好就在这块里",
    ).toBeGreaterThanOrEqual(100);
    expect(
      planRefs,
      "计划自己一处引用都没扫到 ⇒ 计划没进语料，它内部的前向引用没人管",
    ).toBeGreaterThan(0);
    expect(
      tsRefs,
      "代码那一侧零引用 ⇒ 口径退回只扫文档",
    ).toBeGreaterThanOrEqual(300);
    expect(totalRefs).toBeGreaterThanOrEqual(500);
    expect(refs.size).toBeGreaterThanOrEqual(50);
  });

  it("本文件不往语料里掺引用（否则上面两条是被自己污染的读数）", () => {
    // 这条不是装饰：本轮我先在 ./plan-refs.ts 的注释里写出坏形状，判据当夜就把自己
    // 判红了。它防的是【下一次】有人为了省事在测试里直写字面量 —— 那会让
    // 上面那条「零悬空」变成「零悬空 + 本文件掺进去的那几处」，而掺进去的若是
    // 不存在的编号，红；若恰好存在，则永远没人知道语料被测试自己撑大了。
    const self = corpus.files.get("test/arch/plan-refs.test.ts");
    if (self === undefined) throw new Error("取材没收到本文件 ⇒ 口径又窄了");
    expect(countRefs([self])).toBe(0);
  });

  it("『某标题零引用』是口径的产物，不是仓库的事实（本轮我自己踩过）", () => {
    // 上一轮我拿【只有代码】的口径数出「10 个标题从没被引用」，并把它写成【全仓】。
    // 真相：那 10 个在决策文档里全被引用着。所以这里钉【关系】而不是钉那个数 ——
    // 数会随每次加注释而漂，关系不会：窄口径的零引用集合 ⊇ 宽口径的，且两者不相等。
    const narrow = new Map(
      [...corpus.files].filter(
        ([n]) =>
          (n.startsWith("packages/") || n.startsWith("test/")) &&
          n.endsWith(".ts"),
      ),
    );
    const narrowRefs = referencedTaskIds(narrow);
    const narrowUncited = [...corpus.planIds].filter((k) => !narrowRefs.has(k));
    const wideUncited = [...corpus.planIds].filter((k) => !refs.has(k));
    expect(wideUncited).toEqual([]);
    expect(narrowUncited.length).toBeGreaterThan(0);
    // 本轮实测：窄口径 10 个（1.8 / 2.4 / 2.5 / 2.7 / 2.8 / 4.2 / 4.3 / 5.6 / 5.8 / 6.6）。
    // 不钉死这个数字 —— 它随代码注释增减而漂，而这条判据要说的只是「它非空」。
    expect(narrowUncited.length).toBeLessThanOrEqual(corpus.planIds.size);
  });
});
