// 这个守卫防的是【比假绿更隐蔽】的一类失效：一个长得像测试的文件被写了、提交了、
// CI 报了绿，但它一次都没有被执行 —— 因为没有任何一个【已配置】的 runner 认领它。
// 没有任何断言被写坏，只是根本没人跑它，所以也没有任何断言会红。
//
// vitest.config.ts 的 include 是两条模式。原文照抄在这里是安全的（双斜杠之后整行都是
// 注释），但同样的 glob 不能写进块注释：其中星号紧跟斜杠的那个组合会提前闭合注释。
// 我第一版就是那么写的，代价是 biome 报 Expected a statement 而后 vitest 报 Transform
// failed —— 这个坑归档里明令禁止过，我下笔时没检索，同一个错误在本轮踩了两次。
//   test/**/*.test.{ts,tsx}
//   packages/*/test/**/*.test.{ts,tsx}
//
// 关键边界（决定本守卫将来会不会假红）：计划第 507 行写的是「Playwright E2E：
// test/e2e/ceo-loop.spec.ts」，第 38 行的选型是「vitest + Playwright + biome」。也就是说
// .spec.ts 归 Playwright 自己的 runner，vitest 不收它是【正确分工】，不是遗漏。
// 我一度把这件事当成计划内在不一致、还提议往 include 里加一条 .spec.ts —— 那个修法会
// 让 vitest 去收集 Playwright 的规格文件，反而引入新缺陷。判断与更正都记在 0007 §9。
//
// 所以本守卫此刻判红的根据是【Playwright 尚未安装】：根与四个子包的 package.json 里
// 测试类依赖只有 vitest，仓库里没有 playwright.config.*（本轮实测）。于是 test/e2e 下的
// .spec.ts 当下【谁都不认】。等到 Task 2.9 真的引入 Playwright，同一条断言会变成假红 ——
// 那时正确的做法是把「认领者」从 vitest 的 include 扩成「vitest include ∪ Playwright
// config 的 testDir」，而不是把这条守卫关掉。改它的人请先读 0007 §9.2。
//
// 探针实测（三个文件名各不相同，避免 0006 第 7 节第 11 条那种 basename 恒真）：
//   test/e2e/probeA_specname.spec.ts 被静默忽略
//   test/e2e/probeB_testname.test.mjs 被静默忽略
//   packages/hub/src/probeC_intestdir.test.ts 被静默忽略，但会被 production-deps 抓到，
//     因为那里 import 了 vitest；而 test/e2e 下的 .spec.ts 是【全仓无人发现】的那种。
//
// 防恒真：下面 includedByVitest 必须对已知盲区返回 false（反向 canary）。它若哪天被放宽
// 成恒真，主断言「每一项都被认领」立刻退化成恒绿装饰；这条 canary 就是防这一手的。
// 宽枚举 looksLikeTest 与 include【不是】同一套规则，这是整条守卫不退化为恒真的唯一根据。
//
// 已知限制（刻意）：本守卫不 spawn vitest list 去拿真实执行清单。那样要在测试里再起一个
// vitest，会重触发 globalSetup（build-contracts）并与并行测试争写同一产物，属 0006 第 6.4
// 节记过的竞态族。与真实清单的交叉留作 Phase 1 候选。
//
// 下方 includedByVitest 是【手抄】的两条 include：真配置改窄时它不会自己跟着变，于是本守卫会继续
// 宣布【每个测试文件都被收集】，而 vitest 实际已不再收集它们 —— 这是假绿。所以下面新增一条 it，直接
// import 真配置，断言手抄模式与它逐字相同。之所以必须这样补，是因为 vitest.config.ts 自己
// 【不在任何一根柱子的射程内】，本轮实测（两条都配了正对照）：
//   · biome 曾经照不到它（显式点名回答 Checked 0 files）。本轮已修：根目录的 .ts 加进
//     files.includes，实测点名它之后统计数比点名之前多 1 —— 该 glob 不递归，只多这一个。
//     它同时是全仓唯一不以换行结尾的 .ts（末字节 0x3b），一并补上：
//     这个缺陷能活到今天，正因为没有一根柱子照它，本身即本节主题的实例。
//   · tsc -b --force 给它注入一个类型错误 → exit 0；同一探针注入 packages/hub/src/index.ts → exit 2
//     且错误行指向那个文件。它又不被任何文件 import（孤立），所以 tsc 也永远不会顺带看它。
//     tsc 至今不覆盖它：根 tsconfig 是 files: [] 加四个包引用，test/** 一个都不在里面。
//
// 比对逻辑在 config-match.ts 而不是内联：本守卫有自指性 —— 想测【真配置读不出 include】
// 这一态，就得把 include 改空，而那会同时把承载断言的文件自己从收集范围里摘掉，于是既
// 看不到红也看不到绿，只看到 No test files found。抽成纯函数后四态都能用普通单测固定住，
// 不依赖运行时配置。同类先例见 test/arch/index-diff.ts。

import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// vitest.config.ts 是【被检查对象】而非安全依赖，故意 import 它，理由见文件头。
import config from "../../vitest.config";
import { checkConfigMatch } from "./config-match.js";
import { diffInventory, explain, looksLikeTest } from "./test-inventory.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const IGNORED = new Set<string>([
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  ".tmp",
]);

/** 宽枚举：仓库里所有「名字长得像测试」的文件，规则见 looksLikeTest（比 include 宽）。 */
function enumerate(relDir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(ROOT, relDir), { withFileTypes: true })) {
    if (IGNORED.has(e.name)) {
      continue;
    }
    const rel = relDir === "" ? e.name : relDir + "/" + e.name;
    if (e.isDirectory()) {
      out.push(...enumerate(rel));
    } else if (statSync(join(ROOT, rel)).isFile() && looksLikeTest(rel)) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * vitest 两条 include 的独立复刻（写成字符串判断而非正则，避免反斜杠带来的转义歧义）。
 * 刻意与 looksLikeTest 不是一套规则：见文件头，同规则会让差集恒为空。
 * 它与 INCLUDE_PATTERNS 的一致性由【与真配置逐字比对】那条 it 守着，不靠任何人记得同步。
 */
/** includedByVitest 所依据的两条模式。改这里不算数 —— 与真配置不一致就会红。 */
const INCLUDE_PATTERNS: string[] = [
  "test/**/*.test.{ts,tsx}",
  "packages/*/test/**/*.test.{ts,tsx}",
];

function includedByVitest(rel: string): boolean {
  const name = rel.split("/").pop() ?? "";
  const named = name.endsWith(".test.ts") || name.endsWith(".test.tsx");
  if (!named) {
    return false;
  }
  if (rel.startsWith("test/")) {
    return true;
  }
  const segs = rel.split("/");
  return segs[0] === "packages" && segs[2] === "test";
}

describe("测试文件的执行清单覆盖", () => {
  it("谓词有判别力：已知盲区必须返回 false（反向 canary）", () => {
    // 三个形状全部来自本轮实测，不是推测
    expect(includedByVitest("test/e2e/mobile-approval.spec.ts")).toBe(false);
    expect(includedByVitest("test/poc/resume.test.mjs")).toBe(false);
    expect(includedByVitest("packages/hub/src/leak.test.ts")).toBe(false);
    // 正向：仓库里真实存在的三个位置
    expect(includedByVitest("test/poc/resume.test.ts")).toBe(true);
    expect(includedByVitest("test/arch/production-deps.test.ts")).toBe(true);
    expect(includedByVitest("packages/hub/test/cli/smoke.test.ts")).toBe(true);
    // 宽枚举与 include 不是同一套规则 —— 这是守卫不退化为恒真的唯一根据
    expect(looksLikeTest("test/e2e/x.spec.ts")).toBe(true);
    expect(includedByVitest("test/e2e/x.spec.ts")).toBe(false);

    // 主断言依赖的是 diffInventory，不是上面两个谓词。只测谓词而放过比对函数本身，
    // 它就可能返回恒空、把主断言变成恒绿装饰（变异 N-4 实测到这一点）。
    expect(
      diffInventory({
        expected: ["a.test.ts", "b.spec.ts"],
        collected: ["a.test.ts"],
      }),
    ).toEqual({
      uncollected: ["b.spec.ts"],
      phantom: [],
    });
    expect(
      diffInventory({
        expected: ["a.test.ts"],
        collected: ["a.test.ts", "ghost.test.ts"],
      }),
    ).toEqual({
      uncollected: [],
      phantom: ["ghost.test.ts"],
    });
    expect(diffInventory({ expected: [], collected: [] })).toEqual({
      uncollected: [],
      phantom: [],
    });
  });

  it("手抄常量与 vitest.config.ts 的 include 逐字一致", () => {
    const c = config as unknown as { test?: { include?: string[] } };
    const real = (c.test?.include ?? []).map(String);
    // 比对规则本身（含【两边都空要报前提问题】那一态）由 config-match.test.ts 的 7 个用例守着，
    // 那里还带对 checkConfigMatch 的变异实验。这里只是把真数据灌进去。
    // 本条只灌真数据，判据若被掏空它会假绿 —— 所以下面紧接一条自足的正对照，不依赖别的文件。
    expect(checkConfigMatch(real, INCLUDE_PATTERNS)).toEqual([]);
    // 正对照：合成一份【已知必然不一致】的输入，判据必须报出问题。
    // 它不依赖 config-match.test.ts 是否存在 —— 判据被掏空成恒返回空数组，这里当场红。
    const knownBad = checkConfigMatch(["a.test.ts"], ["b.test.ts"]);
    expect(knownBad.length).toBeGreaterThan(0);
    // 反过来，已知一致必须为空，否则上面那条 toBeGreaterThan(0) 会因【永远非空】而失去意义。
    expect(checkConfigMatch(["a.test.ts"], ["a.test.ts"])).toEqual([]);
  });

  it("磁盘上每个测试样文件都在 include 覆盖范围内", () => {
    const expected = enumerate("").sort();
    const collected = expected.filter(includedByVitest);
    const diff = diffInventory({ expected, collected });
    for (const u of diff.uncollected) {
      console.log("[未被 vitest 收集] " + u + " —— " + explain(u));
    }
    // 下限：枚举根写错会让 expected 为空，于是 0 == 0 假绿
    expect(expected.length).toBeGreaterThanOrEqual(21);
    expect(diff.uncollected).toEqual([]);
    expect(diff.phantom).toEqual([]);
  });
});
