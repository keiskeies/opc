// vitest.config.ts 的 include 与 test-inventory.test.ts 里手抄的 INCLUDE_PATTERNS 必须逐字一致。
// 为什么比对逻辑要放在独立纯模块里，而不是写在测试体内：这条守卫有自指性 ——
// 被比对的对象（include）正决定了【哪些测试文件会被收集】。想测【真配置读不出 include】
// 这一态，就得把 include 改空，而那会同时把承载断言的文件自己从收集范围里摘掉，
// 于是既看不到红也看不到绿，只看到 No test files found（本轮实测）。抽成纯函数后，
// 四态都能用普通单测固定住，不依赖运行时配置。同类先例见 test/arch/index-diff.ts。

import { describe, expect, it } from "vitest";
import { checkConfigMatch } from "./config-match.js";

const WHY_PREMISE = "真配置的 include 一条都读不出来，比对会退化成空对空";

describe("include 与手抄常量的一致性比对", () => {
  it("一致 → 无问题", () => {
    expect(
      checkConfigMatch(
        ["a/**/*.test.ts", "b/**/*.test.ts"],
        ["a/**/*.test.ts", "b/**/*.test.ts"],
      ),
    ).toEqual([]);
  });

  it("顺序不同不算不一致（比对与顺序无关）", () => {
    expect(
      checkConfigMatch(
        ["b/**/*.test.ts", "a/**/*.test.ts"],
        ["a/**/*.test.ts", "b/**/*.test.ts"],
      ),
    ).toEqual([]);
  });

  it("两边都空必须报前提问题（否则空对空假绿）", () => {
    expect(checkConfigMatch([], [])).toEqual([{ why: WHY_PREMISE }]);
  });

  it("真配置空、手抄非空：前提问题 + 每条模式各报一次", () => {
    expect(checkConfigMatch([], ["a/**/*.test.ts", "b/**/*.test.ts"])).toEqual([
      { why: WHY_PREMISE },
      { why: "手抄模式 a/**/*.test.ts 在真配置里出现 0 次，应为 1 次" },
      { why: "手抄模式 b/**/*.test.ts 在真配置里出现 0 次，应为 1 次" },
    ]);
  });

  it("真配置里同一条模式重复两次要报（toEqual 抓不到这种一致的错误）", () => {
    expect(
      checkConfigMatch(
        ["a/**/*.test.ts", "a/**/*.test.ts"],
        ["a/**/*.test.ts"],
      ),
    ).toEqual([
      { why: "手抄模式 a/**/*.test.ts 在真配置里出现 2 次，应为 1 次" },
    ]);
  });

  it("真配置合法新增一条而手抄未同步要报", () => {
    expect(
      checkConfigMatch(
        ["a/**/*.test.ts", "c/**/*.test.ts"],
        ["a/**/*.test.ts"],
      ),
    ).toEqual([{ why: "真配置有 c/**/*.test.ts，手抄常量没有" }]);
  });

  it("真配置里同一条未同步的模式重复出现，只报一次（不锁住就会刷屏，V5 变异实测存活）", () => {
    expect(
      checkConfigMatch(
        ["a/**/*.test.ts", "z/**/*.test.ts", "z/**/*.test.ts"],
        ["a/**/*.test.ts"],
      ),
    ).toEqual([{ why: "真配置有 z/**/*.test.ts，手抄常量没有" }]);
  });
});
