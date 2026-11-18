// round285 · 我碰过的那几份文件，格式/organizeImports 具体红在第几行。
// 跑法：npx tsx .workbuddy/round285-lint-lines.mjs
//
// ⚠ 行号在 `d.location.start.line`。我第一版读的是 `d.location.source.span.start.line`
// —— 那是 biome【文本】报告里的形状，JSON reporter 换了路径，于是它不抛错、
// 只是每行打印 `?`。这正好是本仓反复量到的那一族：**探针坏掉的形状是「有输出」，
// 不是「没输出」**。（本轮台账「⑧」那条假读数的同族。）
import { spawnSync } from "node:child_process";
import { findBiomeBinary } from "../test/arch/lint-baseline.ts";

const FILES = [
  "test/arch/test-type-baseline.ts",
  "test/arch/test-type-baseline.test.ts",
  "test/arch/claims-registry.ts",
  "test/arch/claims-registry.test.ts",
  "test/arch/production-deps.test.ts",
];
const biome = findBiomeBinary(process.cwd());
const r = spawnSync(biome, ["check", ...FILES, "--reporter=json", "--max-diagnostics=100000"], {
  cwd: process.cwd(),
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
});
const j = JSON.parse(String(r.stdout));
let printed = 0;
for (const d of j.diagnostics ?? []) {
  if (d.severity !== "error") continue;
  const p = String(d.location.path).split("\\").join("/");
  const line = d.location?.start?.line;
  if (typeof line !== "number") {
    throw new Error("biome JSON 里没有 location.start.line —— 形状又变了，别把它读成「没有错」");
  }
  printed += 1;
  console.log(p + ":" + line + "  " + d.category);
}
console.log("合计 error", printed, "/ summary.errors =", j.summary?.errors);
console.log(
  "⚠ 上面若出现 `:0`，那不是探针坏了：format / organizeImports 是【一份文件一条】诊断，" +
    "start.line 恒为 0（round286 复算）。要看【逐行】只有 lint/* 那些规则给得出，" +
    "用 round285-rule-sites.mjs；要问「这一刀会动多少份文件」用 round285-lint-blast.mjs。",
);
