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
  REQUIRED_VITEST_INCLUDE,
  readBiomeIncludes,
  readVitestInclude,
} from "./harness-invariants.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const OK: HarnessInput = {
  vitestInclude: [...REQUIRED_VITEST_INCLUDE],
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

  it("真仓库的三样输入必须全过（正向：整条守卫在真配置上不空转）", () => {
    const vi = readVitestInclude(
      readFileSync(join(ROOT, "vitest.config.ts"), "utf8"),
    );
    const bi = readBiomeIncludes(
      readFileSync(join(ROOT, "biome.json"), "utf8"),
    );
    const n = countTestFiles(ROOT);
    expect(
      reasons({
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
});
