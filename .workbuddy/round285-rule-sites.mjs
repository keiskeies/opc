// round285 · 基线里那几条【规则】error 的原文与所在行（判「该修还是该豁免」用）。
// 跑法：npx tsx .workbuddy/round285-rule-sites.mjs
//
// 两处本轮踩过的形状问题都在这儿钉住了：
//  ① 行号在 `d.location.start.line`，不在 `location.source.span.start.line`
//     （后者是文本报告的形状；读错不抛错，只每行打印 `?`）。
//  ② 要看的类目【从输出里派生】，不手抄。上一版把五条 `lint/*` 手抄在 WATCH 里，
//     本轮 `noSelfCompare` / `noConstantCondition` 归零 ⇒ 那份名单当场过期。
//     同 `lint-baseline.test.ts` 里那条手抄名单：抄一次就会漂一次。
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { findBiomeBinary } from "../test/arch/lint-baseline.ts";

const biome = findBiomeBinary(process.cwd());
const r = spawnSync(biome, ["check", ".", "--reporter=json", "--max-diagnostics=100000"], {
  cwd: process.cwd(),
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
});
const j = JSON.parse(String(r.stdout));
const rows = [];
for (const d of j.diagnostics ?? []) {
  if (d.severity !== "error") continue;
  if (!String(d.category).startsWith("lint/")) continue;
  const p = String(d.location.path).split("\\").join("/");
  const line = d.location?.start?.line;
  if (typeof line !== "number") {
    throw new Error("biome JSON 里没有 location.start.line —— 形状又变了，别把它读成「没有错」");
  }
  rows.push({ p, line, category: d.category, msg: String(d.message?.[0]?.value ?? "").slice(0, 70) });
}
rows.sort((a, b) => (a.p + ":" + a.line).localeCompare(b.p + ":" + b.line));
for (const x of rows) {
  let src = "?";
  try {
    src = readFileSync(x.p, "utf8").split(/\r?\n/u)[x.line - 1]?.trim() ?? "?";
  } catch {
    /* 不在仓根 */
  }
  console.log(
    x.category.replace("lint/", "") +
      "\n  " +
      x.p +
      ":" +
      x.line +
      "\n  │ " +
      src.slice(0, 130) +
      "\n  · " +
      x.msg,
  );
}
const cats = new Map();
for (const x of rows) cats.set(x.category, (cats.get(x.category) ?? 0) + 1);
console.log("合计", rows.length, "｜按类目", JSON.stringify(Object.fromEntries(cats)));
console.log(
  "⚠ 只数 lint/* —— format / organizeImports 是 summarize/format/organizeImports，",
  "不在这个口径里（summary.errors =",
  j.summary?.errors,
  "）",
);
