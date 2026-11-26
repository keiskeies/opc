/**
 * `pnpm lint` 基线棘轮的守卫（判据在 ./lint-baseline.ts）。
 *
 * 形状沿用 claims-registry 的分工：判据是纯函数，这里喂合成读数做变异，
 * 另有一发真仓库的哨兵。**合成那一半是主力** —— 真仓库那一发只能证明
 * 「今天的数在表内」，证明不了「判据会在数变坏时红」；后者只能靠变异拿到。
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type BaselineEntry,
  type BiomeDiagnostic,
  countErrorCategories,
  diffLintBaseline,
  findBiomeBinary,
  LINT_BASELINE,
  runBiomeJson,
  staleBaselineEntries,
} from "./lint-baseline.js";
import { BOUNDARY_PROBE } from "./run-fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function diag(
  category: string,
  path = "packages/hub/src/x.ts",
  severity = "error",
): BiomeDiagnostic {
  return { severity, category, location: { path } };
}

/** 逐条照抄基线的合成读数：用它当「恰好在基线上」的控制组。 */
function atBaseline(): BiomeDiagnostic[] {
  const out: BiomeDiagnostic[] = [];
  for (const b of LINT_BASELINE) {
    for (let i = 0; i < b.atMost; i++) out.push(diag(b.category));
  }
  return out;
}

describe("lint 基线：计数", () => {
  it("只数 error，warning / info 不进基线（它们不参与 lint 的退出码）", () => {
    const counts = countErrorCategories([
      diag("format", undefined, "error"),
      diag("lint/style/noNonNullAssertion", undefined, "warning"),
      diag("lint/style/useShorthandFunctionType", undefined, "info"),
    ]);
    expect([...counts.entries()]).toEqual([["format", 1]]);
  });

  it("运行期夹具探针不进基线（否则与 dependency-boundary 并发时随机红）", () => {
    // 这条是判别式的：把 isRuntimeFixture 那两行删掉，这里立刻红。
    const counts = countErrorCategories([
      diag("lint/correctness/noUnusedImports", "packages/hub/src/a.ts"),
      diag(
        "lint/suspicious/noExplicitAny",
        "packages/desktop/src/" + BOUNDARY_PROBE,
      ),
      diag(
        "lint/suspicious/noExplicitAny",
        "packages\\web\\src\\" + BOUNDARY_PROBE,
      ),
    ]);
    expect(counts.get("lint/correctness/noUnusedImports")).toBe(1);
    expect(counts.has("lint/suspicious/noExplicitAny")).toBe(false);
  });

  it("路径分隔符两种写法都归一（Windows 的 JSON 给反斜杠）", () => {
    const counts = countErrorCategories([
      diag("format", "packages/hub/src/a.ts"),
      diag("format", "packages\\hub\\src\\b.ts"),
    ]);
    expect(counts.get("format")).toBe(2);
  });
});

describe("lint 基线：棘轮判据", () => {
  it("恰好在基线上 ⇒ 绿（控制组：判据不是恒红装饰）", () => {
    expect(diffLintBaseline(countErrorCategories(atBaseline()))).toBe("");
  });

  it("比基线少 ⇒ 绿（这一发只许减不许增，往下调正是它鼓励的）", () => {
    const fewer = atBaseline().slice(
      0,
      LINT_BASELINE.reduce((n, b) => n + b.atMost - 1, 0),
    );
    const msg = diffLintBaseline(countErrorCategories(fewer));
    expect(msg).toBe("");
  });

  it("变异：某类目多于基线配额 ⇒ 红，且红话点名是哪一类、从几到几", () => {
    // 判据形态用显式合成基线测，不再从 LINT_BASELINE 借「format 那条恰好在表里」的形态 ——
    // 2026-11-27 全仓修绿后真表清空，表里不再有任何类目可供借形。
    // 上限仍不手抄进断言文案：cap 从合成的基线对象取（同「手抄会漂」那一族）。
    const synth: BaselineEntry[] = [{ category: "format", atMost: 3 }];
    const counts = new Map<string, number>([["format", 4]]);
    const msg = diffLintBaseline(counts, synth);
    const cap = synth.find((b) => b.category === "format")?.atMost;
    expect(msg).toContain(`format ${cap}→${cap === undefined ? 0 : cap + 1}`);
    expect(msg).toContain("只许减不许增");
  });

  it("变异：表清空后冒出任何 error ⇒ 红并点名（0 error 是常态，新账必须新点名）", () => {
    // 真表今天为空（全仓 0 error）。空表下判据换了一副红话：不是「超配额」而是
    // 「基线外类目」。这一发钉的是【清空之后】的日常形态 —— format 回归 1 条也必须红。
    const msg = diffLintBaseline(countErrorCategories([diag("format")]));
    expect(msg).toContain("基线外的 error 类目");
    expect(msg).toContain("format=1");
  });

  it("变异：冒出基线外的新 error 类目 ⇒ 红并点名（防『反正 lint 本来就红』混过去）", () => {
    const mutated = [
      ...atBaseline(),
      diag("lint/correctness/noUndeclaredVariables"),
    ];
    const msg = diffLintBaseline(countErrorCategories(mutated));
    expect(msg).toContain("基线外的 error 类目");
    expect(msg).toContain("lint/correctness/noUndeclaredVariables=1");
  });

  it("变异：新增类目藏在一个已有类目之后 ⇒ 仍然红（不是『只看最大值』那种假判据）", () => {
    const mutated = [diag("format"), diag("lint/suspicious/newRule")];
    expect(diffLintBaseline(countErrorCategories(mutated))).toContain(
      "newRule",
    );
  });

  it("真把整仓修干净 ⇒ 绿（绝不造出一条恒不可能通过的验收命令）", () => {
    // 0057 / 0060 各记过一次「恒红的验收命令 = 恒红的断言」。
    // 这一发的目标状态是 0 条 error，所以 0 必须是绿，不能是红。
    expect(diffLintBaseline(new Map())).toBe("");
  });

  it("某类目修到 0 条 ⇒ 报「请把这条豁免删掉」（豁免不许比现实活得久）", () => {
    // 期望名单【从 LINT_BASELINE 派生】而不是手抄：本轮我把 noSelfCompare /
    // noConstantCondition 两类从表里删掉（它们真降到 0 了），手抄那一份当场过期，
    // 而它过期是【测试自己红】—— 这正是本仓治了好几遍的那族：一份手抄会跟着上游漂。
    // 派生保留了变异力：把 staleBaselineEntries 的判据摘掉 ⇒ 这里拿到空数组 ⇒ 红。
    const partial = new Map<string, number>([["format", 100]]);
    const others = LINT_BASELINE.map((b) => b.category).filter(
      (c) => c !== "format",
    );
    expect(staleBaselineEntries(partial)).toEqual(others);
    // 而且【不含 format】那一格是判据在说话，不是派生名单在说话：format 有 100 条。
    expect(staleBaselineEntries(partial)).not.toContain("format");
    expect(staleBaselineEntries(countErrorCategories(atBaseline()))).toEqual(
      [],
    );
  });
});

describe("lint 基线：真仓库那一半", () => {
  it("biome 平台二进制找得到（找不到就抛，不空跑成假通过）", () => {
    expect(findBiomeBinary(ROOT)).toMatch(/biome(\.exe)?$/u);
  });

  it("`pnpm lint` 今天的 error 全部在基线内，且读数本身可信", () => {
    const run = runBiomeJson(ROOT);
    // 哨兵 1：扫到的文件数有下限。根 include 命中 packages/** + test/** + 根 *.ts，
    // 本轮实测 282。下限取 200 是故意的 —— include 被改窄时（0006 §7 第 41 条那族
    // 「测试面被改窄，verify 整绿地通过」）这里先红，而不是让基线对着空语料自证通过。
    expect(
      run.filesChecked,
      "biome 只扫到 " + run.filesChecked + " 个文件，include 可能被改窄了",
    ).toBeGreaterThanOrEqual(200);

    const counts = countErrorCategories(run.diagnostics);
    const counted = [...counts.values()].reduce((a, b) => a + b, 0);
    const fixtureInPlay = run.diagnostics.some((d) =>
      String(d.location.path).split("\\").join("/").includes(BOUNDARY_PROBE),
    );
    // 哨兵 2：summary 的数与自己逐条数出来的数自洽。
    // 探针在场时（与 dependency-boundary 并发）允许 summary 更大那一条 —— 那一条
    // 是别人故意写进去的越界 import，不是本仓的代码质量。
    expect(counted).toBeLessThanOrEqual(run.summary.errors);
    if (!fixtureInPlay) {
      expect(counted, "summary.errors 与逐条计数不自洽：解析口径可能错了").toBe(
        run.summary.errors,
      );
    }

    const msg = diffLintBaseline(counts);
    expect(
      msg,
      "lint 基线红，且读数不可信的可能先排除：filesChecked=" +
        run.filesChecked +
        " errors=" +
        run.summary.errors,
    ).toBe("");
  });
});
