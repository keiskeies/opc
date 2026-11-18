// round285 · 那 11 条 lint【规则】error 到底在哪、各是什么写法。
// 跑法：npx tsx .workbuddy/round285-lint-rules.mjs
import { spawnSync } from "node:child_process";
import { findBiomeBinary } from "../test/arch/lint-baseline.ts";

const biome = findBiomeBinary(process.cwd());
const r = spawnSync(biome, ["check", ".", "--max-diagnostics=100000"], {
  cwd: process.cwd(),
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
});
const out = String(r.stdout) + String(r.stderr);
const RULES = [
  "lint/correctness/noAssignInExpressions",
  "lint/correctness/noUnsafeOptionalChaining",
  "lint/suspicious/useIterableCallbackReturn",
  "lint/suspicious/noSelfCompare",
  "lint/correctness/noConstantCondition",
  "lint/correctness/noUnusedImports",
];
const re = /^([^\s]+\.ts):(\d+):(\d+)\s+lint\//gm;
for (const m of out.matchAll(re)) {
  const cat = out.slice(m.index, m.index + 90).match(/lint\/[A-Za-z/]+/u)?.[0] ?? "?";
  if (!RULES.includes(cat)) continue;
  console.log(m[1] + ":" + m[2] + "  " + cat);
}
