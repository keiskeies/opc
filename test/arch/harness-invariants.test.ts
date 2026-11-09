// 判据本体的 canary。真配置的一致性另有 test-inventory.test.ts 管，
// 这里只管判据和解码器有没有判别力。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  checkHarness,
  countTestFiles,
  type HarnessInput,
  MIN_TEST_FILES,
  REQUIRED_BIOME_INCLUDES,
  REQUIRED_GLOBAL_SETUP,
  REQUIRED_REQUIRE_ASSERTIONS,
  REQUIRED_VITEST_INCLUDE,
  type RequiredLists,
  readBiomeIncludes,
  readVitestGlobalSetup,
  readVitestInclude,
  readVitestRequireAssertions,
} from "./harness-invariants.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const OK: HarnessInput = {
  requireAssertions: REQUIRED_REQUIRE_ASSERTIONS,
  vitestInclude: [...REQUIRED_VITEST_INCLUDE],
  globalSetup: [...REQUIRED_GLOBAL_SETUP],
  biomeIncludes: [
    ...REQUIRED_BIOME_INCLUDES,
    "packages/**/*.{ts,tsx,js,mjs,json}",
  ],
  diskTestFiles: Array.from(
    { length: 30 },
    (_: unknown, i: number): string => "t" + i + ".test.ts",
  ),
};

const reasons = (input: HarnessInput): string[] =>
  checkHarness(input)
    .map((p: { why: string }): string => p.why)
    .sort();

const reasonsFor = (input: HarnessInput, required: RequiredLists): string[] =>
  checkHarness(input, required)
    .map((p: { why: string }): string => p.why)
    .sort();

describe("测试装置不变量判据", () => {
  it("完好输入必须没有问题（反向：恒返回非空会在这里红）", () => {
    expect(reasons(OK)).toEqual([]);
  });

  it("vitest 的 include 少一条就必须报", () => {
    const cut: HarnessInput = {
      ...OK,
      vitestInclude: [REQUIRED_VITEST_INCLUDE[0] ?? ""],
    };
    const got = reasons(cut);
    expect(got.length).toBe(1);
    expect(got[0]).toContain("packages/*/test/**/*.test.{ts,tsx}");
  });

  it("biome 的 includes 丢掉 test 目录就必须报", () => {
    const got = reasons({
      ...OK,
      biomeIncludes: ["packages/**/*.{ts,tsx,js,mjs,json}"],
    });
    expect(got.length).toBe(1);
    expect(got[0]).toContain("test/**/*.{ts,tsx}");
  });

  it("include 被换成更窄的模式也算缺失，不是读到东西就行", () => {
    const got = reasons({ ...OK, vitestInclude: ["test/arch/doc-*.test.ts"] });
    expect(got.length).toBe(REQUIRED_VITEST_INCLUDE.length);
  });

  it("解码成空数组是解码失败，不是没问题", () => {
    expect(reasons({ ...OK, vitestInclude: [] }).length).toBe(1);
    expect(reasons({ ...OK, biomeIncludes: [] }).length).toBe(1);
  });

  it("磁盘测试文件数掉到下限以下必须报", () => {
    const thin = Array.from(
      { length: MIN_TEST_FILES - 1 },
      (_: unknown, i: number): string => "a" + i + ".test.ts",
    );
    expect(reasons({ ...OK, diskTestFiles: thin }).length).toBe(1);
    const edge = Array.from(
      { length: MIN_TEST_FILES },
      (_: unknown, i: number): string => "a" + i + ".test.ts",
    );
    expect(reasons({ ...OK, diskTestFiles: edge })).toEqual([]);
  });

  it("必需项清单自己不许被掏空", () => {
    expect(REQUIRED_VITEST_INCLUDE.length).toBeGreaterThanOrEqual(2);
    expect(REQUIRED_BIOME_INCLUDES.length).toBeGreaterThanOrEqual(1);
    expect(MIN_TEST_FILES).toBeGreaterThan(0);
  });

  // 这一段钉的是判据里【必需项清单本身为空就提前返回】那个分支。
  // 清单一旦被掏空，逐条比对永远数不到缺失 —— 全绿而什么都没查，和「空对空」同族。
  // 实测：把该分支改成永不触发，本文件其余各条全绿，所以它此前没有任何测试断过它的输出。
  it("必需项清单被掏空时只报一条【判据已被掏空】，不得退化成逐条比对", () => {
    const empty: RequiredLists = {
      vitestInclude: [],
      biomeIncludes: [],
      globalSetup: [],
    };
    const got = reasonsFor(OK, empty);
    expect(got.length).toBe(1);
    expect(got[0]).toContain("掏空");
    expect(got[0]).not.toContain("空对空");
    // 守卫的条件是【或】：只认两侧同时为空，就漏掉单边掏空那种坏法。
    const onlyVitest: RequiredLists = {
      vitestInclude: [],
      biomeIncludes: [...REQUIRED_BIOME_INCLUDES],
      globalSetup: [...REQUIRED_GLOBAL_SETUP],
    };
    const onlyBiome: RequiredLists = {
      vitestInclude: [...REQUIRED_VITEST_INCLUDE],
      biomeIncludes: [],
      globalSetup: [...REQUIRED_GLOBAL_SETUP],
    };
    expect(reasonsFor(OK, onlyVitest).length).toBe(1);
    expect(reasonsFor(OK, onlyBiome).length).toBe(1);
    // 第三样同样要单独测：这一侧当初就是这么漏掉的（把子句改成永不触发，
    // 只有两侧的用例全绿，第三侧无人问津）。
    const onlySetup: RequiredLists = {
      vitestInclude: [...REQUIRED_VITEST_INCLUDE],
      biomeIncludes: [...REQUIRED_BIOME_INCLUDES],
      globalSetup: [],
    };
    expect(reasonsFor(OK, onlySetup).length).toBe(1);
    // 且必须抢在逐条比对之前：输入同时坏掉时也只该有这一条。
    const broken: HarnessInput = {
      requireAssertions: false,
      globalSetup: [],
      vitestInclude: [],
      biomeIncludes: [],
      diskTestFiles: [],
    };
    expect(reasonsFor(broken, empty).length).toBe(1);
  });

  // 钉的是【套件中止通道自己的开关】。那条【必需清单被掏空】的变异，靠 globalSetup
  // 抛错中止全套来报警；而注册那一行若被删，中止通道本身就没有一条用例能红 ——
  // 让 globalSetup 报告【我没被注册】是循环：它没执行，就没有任何东西替它说话。
  // 实测只删 vitest.config.ts 那一行：全套照常全绿、退出码 0，无人报警。所以
  // 兜底必须在用例这一侧读真配置。
  it("真配置必须仍注册 globalSetup，否则【测试面被改窄】这件事没有报警者", () => {
    const cfg = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
    // 读法认双引号对：读出来的必须逐字等于必需项，不是【非空就算】
    expect(readVitestGlobalSetup(cfg)).toEqual([...REQUIRED_GLOBAL_SETUP]);
    // 真配置在判据上不空转
    expect(reasons({ ...OK, globalSetup: readVitestGlobalSetup(cfg) })).toEqual(
      [],
    );
    // 那一行被整条删掉：读出来是空数组，而空必须报，不许当成零发现
    const removed = cfg.replace(/^ {4}globalSetup:.*$/m, "");
    expect(removed).not.toMatch(/^ {4}globalSetup:/m);
    expect(readVitestGlobalSetup(removed)).toEqual([]);
    // 注意：不能断言整份文本【不含 globalSetup】—— 配置里的散文注释也提这个词。
    expect(reasons({ ...OK, globalSetup: [] })).toEqual([
      expect.stringContaining("globalSetup"),
    ]);
    // 被改成别的脚本路径同样要报：只有必需项那一条算完好
    expect(
      reasons({ ...OK, globalSetup: ["test/global-setup/other.ts"] }),
    ).toEqual([expect.stringContaining("globalSetup")]);
  });

  // 开关本身也要有人守：把某条用例的整个 body 掏空，标题与条数一字未动，
  // 默认配置下 2 例全绿（实测 test/arch/decision-index.test.ts 第一条）。
  // 这一行被删掉后那把刀就没人接得住，而删掉它【不会有任何一条用例变红】——
  // 与上一条 globalSetup 的处境同构，所以读法也一样：由用例去读真配置。
  it("真配置必须仍开着 requireAssertions，否则【断言被整条掏空】没有报警者", () => {
    const cfg = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
    expect(readVitestRequireAssertions(cfg)).toBe(true);
    expect(reasons({ ...OK, requireAssertions: true })).toEqual([]);
    // 整行被删：读到 false，且必须报，不许当成零发现
    const removed = cfg.replace(/^ {4}expect: \{[^\n]*\},\n/mu, "");
    expect(removed).not.toContain("requireAssertions:");
    expect(readVitestRequireAssertions(removed)).toBe(false);
    expect(reasons({ ...OK, requireAssertions: false })).toEqual([
      expect.stringContaining("requireAssertions"),
    ]);
    // 值被改成 false 同样要报：只有 true 算完好
    expect(
      readVitestRequireAssertions(
        cfg.replace("requireAssertions: true", "requireAssertions: false"),
      ),
    ).toBe(false);
    // 归因必须是【这一样坏了】，不许顺带把别的输入也判坏
    expect(
      reasons({ ...OK, globalSetup: [], requireAssertions: false }).length,
    ).toBe(2);
  });

  // 标题不写【几样输入】：加一样就得改数字，那和 canary 条数同属会漂的计数。
  it("真仓库的配置输入必须全过（正向：整条守卫在真配置上不空转）", () => {
    const cfgText = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
    const vi = readVitestInclude(cfgText);
    const gsRead = readVitestGlobalSetup(cfgText);
    const raRead = readVitestRequireAssertions(cfgText);
    const bi = readBiomeIncludes(
      readFileSync(join(ROOT, "biome.json"), "utf8"),
    );
    const n = countTestFiles(ROOT);
    expect(
      reasons({
        requireAssertions: raRead,
        globalSetup: gsRead,
        vitestInclude: vi,
        biomeIncludes: bi,
        diskTestFiles: Array.from(
          { length: n },
          (_: unknown, i: number): string => "f" + i,
        ),
      }),
    ).toEqual([]);
    expect(n).toBeGreaterThanOrEqual(MIN_TEST_FILES);
  });
});

/* ------------------------------------------------------------ 配置解码器 */

// 读配置这一步【本身】会坏：按逗号切会把 {ts,tsx} 里的逗号当分隔符，切出一堆碎片，
// 碎片全都匹配不上任何模式 —— 于是【配置明明在，却像被改窄了】。本轮我真错过一次，
// 所以这条不能只靠我记得。
const NL_TEXT = String.fromCharCode(10);
const Q = String.fromCharCode(34);
const k = (s: string): string => Q + s + Q;

function fakeConfig(patterns: readonly string[]): string {
  const lines: string[] = ["export default {", "  test: {", "    include: ["];
  for (const p of patterns) lines.push("      " + k(p) + ",");
  lines.push("    ],", "  },", "};");
  return lines.join(NL_TEXT);
}

describe("配置解码器", () => {
  it("模式里的逗号不得被当成分隔符", () => {
    const got = readVitestInclude(fakeConfig(REQUIRED_VITEST_INCLUDE));
    // 按逗号切会切出四条碎片；先钉条数，坏解码器当场红。
    expect(got.length).toBe(REQUIRED_VITEST_INCLUDE.length);
    expect(got).toEqual([...REQUIRED_VITEST_INCLUDE]);
  });

  it("必需模式里必须仍有含逗号的样本，否则上面那条会悄悄失去判别力", () => {
    expect(
      REQUIRED_VITEST_INCLUDE.some((p: string): boolean => p.includes(",")),
    ).toBe(true);
  });

  it("读不出 include 时返回空，由 checkHarness 报且只报一条解码失败", () => {
    expect(readVitestInclude("export default { test: {} }")).toEqual([]);
    const got = reasons({ ...OK, vitestInclude: [] });
    expect(got.length).toBe(1);
    expect(got[0]).toContain("空对空");
  });

  it("坏 JSON 或缺字段一律空数组，非字符串条目不得混进比对", () => {
    expect(readBiomeIncludes("{ oops")).toEqual([]);
    expect(readBiomeIncludes("{}")).toEqual([]);
    expect(readBiomeIncludes("{ " + k("files") + ": {} }")).toEqual([]);
    expect(
      readBiomeIncludes("{ " + k("files") + ": { " + k("includes") + ": 3 } }"),
    ).toEqual([]);
    const withJunk =
      "{ " +
      k("files") +
      ": { " +
      k("includes") +
      ": [" +
      k("test/**/*.{ts,tsx}") +
      ", 7] } }";
    expect(readBiomeIncludes(withJunk)).toEqual([...REQUIRED_BIOME_INCLUDES]);
  });

  // 读法必须【结构性】：配置里出现这个词不等于开关开着。
  it("注释里写着同一个开关名的配置，必须读成 false", () => {
    expect(
      readVitestRequireAssertions(
        "  // expect: { requireAssertions: true }" + NL_TEXT + "};",
      ),
    ).toBe(false);
  });

  // 只看一行会把 biome 展开成的多行对象读成 false —— 那是假红，
  // 而假红会让人去改配置而不是改读法，比漏报更难查。
  it("开关被格式化器展开成多行时仍必须读成 true", () => {
    const multi = [
      "export default {",
      "  test: {",
      "    expect: {",
      "      requireAssertions: true,",
      "    },",
      "  },",
      "};",
    ].join(NL_TEXT);
    expect(readVitestRequireAssertions(multi)).toBe(true);
  });
});
