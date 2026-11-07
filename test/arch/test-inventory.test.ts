// 磁盘上的测试文件是否真的会进 vitest 的执行清单。
//
// 动机不是假设。vitest.config.ts 的 include 是两条模式。原文照抄在下面，
// 但只能放在行注释里：其中星号紧跟斜杠的那个组合，出现在块注释中会提前闭合注释，
// 动机不是假设。vitest.config.ts 的 include 是两条模式，原文照抄如下。放在行注释里是安全的：
// 双斜杠之后整行都是注释；但同样的 glob 写进块注释就会出事 —— 其中的星号紧跟斜杠会提前闭合
// 注释，本文件第一版正是那样炸的（biome 报 Expected a statement）。这个坑我在归档里记过，
// 下笔时没检索，所以还是踩了两次（第二次是把这段说明写进另一个文件的块注释时）。
//   test/**/*.test.{ts,tsx}
//   packages/*/test/**/*.test.{ts,tsx}
// 它不收 .spec.ts，也不收 .mjs 与 .js。而计划 Task 4.7（Phase 4 出口门禁）明确要求产出
// test/e2e/mobile-approval.spec.ts。到那天它会被写出来、一次都不会跑，CI 照报
// Test Files 全绿。这比假绿更隐蔽：没有任何断言被写坏，只是根本没人执行它。
// 它不收 .spec.ts，也不收 .mjs 与 .js。而计划 Task 4.7（Phase 4 出口门禁）明确要求产出
// test/e2e/mobile-approval.spec.ts。到那天它会被写出来、一次都不会跑，CI 照报
// Test Files 全绿。这比假绿更隐蔽：没有任何断言被写坏，只是根本没人执行它。
//
// 实测依据（本轮三个探针，文件名各不相同，避免 0006 第 7 节第 11 条的 basename 恒真）：
//   test/e2e/probeA_specname.spec.ts 静默忽略
//   test/e2e/probeB_testname.test.mjs 静默忽略
//   packages/hub/src/probeC_intestdir.test.ts 静默忽略，但会被 production-deps 抓到，
//   因为那里 import 了 vitest；而 test/e2e 下的 .spec.ts 属于全仓无人发现的那种。
//
// 防恒真：下面的 includedByVitest 必须对已知盲区返回 false（反向 canary）。它若哪天被放宽
// 成恒真，主断言「每一项都被收集」立刻退化成恒绿装饰。这条 canary 就是防这一手的。
//
// 已知限制（刻意）：本守卫不 spawn vitest list 去拿真实清单。那样要在测试里起一个 vitest，
// 会重触发 globalSetup（build-contracts）并与并行测试争写同一产物，属 0006 第 6.4 节记过的
// 竞态族。与真实清单的交叉留作 Phase 1 候选。

import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
 */
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
