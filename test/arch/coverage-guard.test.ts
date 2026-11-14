import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { fixtureTmp } from "../../packages/hub/test/fixtures/fixture-dir.js";

/**
 * 门控文件覆盖率下限的机械守卫（round197）。
 *
 * 背景：round193-194 装上 coverage-v8 并给 packages/hub/src/graph/gates/**.ts 设了 per-glob 阈值
 *（lines 95 / branches 95 / functions 100 / statements 90）。但那条阈值只在有人手动跑 `--coverage` 时
 * 才生效，是一个【文档化但没人机械执行】的软门槛。本守卫把它变成 arch 套件里每轮必跑的一条：
 * 门控判定内核一旦掉到 95 以下就红。
 *
 * 三条防假通过（沿用 dependency-boundary / gate-selfcheck 的纪律）：
 *  1. 跑完必须真的产出 coverage-summary.json，且里面【确实含两个门控文件的条目】——
 *     否则就是 glob 没匹配上（空对空），直接抛错，绝不放绿过去。
 *  2. 下限断言【独立重算】来源（json-summary 里每个文件的 lines/branches/functions），
 *     不抄 config 里的阈值数字 —— 万一 config 阈值被改成 0，本守卫照样能挡住掉到 90 的回归。
 *  3. worker 并发会互相污染 coverage 输出目录，这里用 fixtureTmp（pid 后缀 + afterAll 清理），
 *     正好落进 fixture-dir 判据认可的 helper 用法。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = fixtureTmp("cov-guard", import.meta.url);

const GATE_FILES = ["author-reviewer.ts", "evaluate.ts"];

// 下限：与 config 的 per-glob 阈值同一水平（但不复制其数字）。
const MIN = { lines: 95, branches: 95, functions: 95, statements: 90 };

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

it("门控判定内核文件覆盖率 ≥ 下限（反假绿：文件必须在场、红即失败）", () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  const vitest = join(ROOT, "node_modules", "vitest", "vitest.mjs");
  if (!existsSync(vitest)) throw new Error("找不到 vitest.mjs：" + vitest);
  const r = spawnSync(process.execPath, [
    vitest,
    "run",
    "--coverage",
    "--coverage.provider=v8",
    "--coverage.reporter=json-summary",
    "--coverage.reportsDirectory=" + TMP,
    "packages/hub/test/gates",
    "packages/hub/test/routing/escalation.test.ts",
    "packages/hub/test/acceptance/phase1-gates.test.ts",
  ], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
  });
  if (r.error) throw new Error("vitest 调用失败：" + r.error.message);
  const out = (r.stdout ?? "") + (r.stderr ?? "");

  const sumFile = join(TMP, "coverage-summary.json");
  // 哨兵：summary 必须在场 —— 没产出 = 调用没成功 = 不能当通过。
  if (!existsSync(sumFile))
    throw new Error("coverage-summary.json 未生成。vitest 输出（尾 300 字）：\n" + out.slice(-300));
  const sum = JSON.parse(readFileSync(sumFile, "utf8"));

  // 反假绿 2：两个门控源文件真的被 v8 纳入统计了 —— 空对空跑绿是假通过。
  const found = Object.keys(sum).filter((k) =>
    GATE_FILES.some((f) => k.replace(/\\/g, "/").endsWith("/" + f)));
  expect(found.length).toBe(GATE_FILES.length);

  // 反假绿 3：每条独立的、重算来源的下限断言。
  for (const k of found) {
    const v = sum[k];
    const fname = k.replace(/\\/g, "/").split("/").pop();
    expect(v.lines?.pct, fname + " lines").toBeGreaterThanOrEqual(MIN.lines);
    expect(v.branches?.pct, fname + " branches").toBeGreaterThanOrEqual(MIN.branches);
    expect(v.functions?.pct, fname + " functions").toBeGreaterThanOrEqual(MIN.functions);
  }

  // 兜底：vitest 进程本身应当成功。
  if (r.status !== 0)
    throw new Error("vitest --coverage 非零退出 " + r.status + "：\n" + out.slice(-500));
});
