// round294 · 我这轮碰的那几份文件，lint 报在哪一行哪一类。
// 跑法：npx tsx .workbuddy/round294-lint-where.mjs
import { runBiomeJson } from "../test/arch/lint-baseline.ts";

const run = runBiomeJson(process.cwd());
const targets = [
  "test/arch/claims-registry.ts",
  "test/arch/claims-registry.test.ts",
  "packages/hub/test/acceptance/new-role-to-its-own-criteria.test.ts",
  "test/org/validate.test.ts",
  "packages/contracts/src/org/validate.ts",
  "packages/hub/src/org/commit.ts",
  "packages/contracts/src/org/graph.ts",
];
for (const d of run.diagnostics) {
  if (d.severity !== "error") continue;
  const p = String(d.location?.path ?? "").split("\\").join("/");
  if (!targets.some((t) => p.endsWith(t))) continue;
  const line = d.location?.span?.start?.line;
  console.log(p + ":" + line + " :: " + d.category);
}
console.log("全仓 error =", run.summary.errors, " filesChecked =", run.filesChecked);
