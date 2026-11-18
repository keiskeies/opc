// round287 · 7 份岗位书头注释说「charter.test.ts 断言它已从模板消失 ⇒ 没签完 CI 恒红」。
// 实测方向相反：那一发断言的是【占位串还在】。这发量真方向 —— 把一份模板签字，看谁红。
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const TARGET = "packages/hub/resources/charter-templates/ops.yaml";
const orig = readFileSync(TARGET, "utf8");
const before = '  - condition: "CEO-PLACEHOLDER-ACCEPTANCE"';
const after = '  - condition: "落地页 Lighthouse 性能 ≥ 80"';
if (!orig.includes(before)) throw new Error("锚点没命中");
const ANSI = new RegExp(String.fromCharCode(27) + "\[[0-9;]*m", "gu");
const run = (args) => {
  const r = spawnSync("npx", args, {
    shell: true, cwd: process.cwd(), encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024, timeout: 900000,
  });
  if (r.status === null) throw new Error("vitest 没起来（status=null）≠ 全绿");
  return (String(r.stdout) + String(r.stderr)).replace(ANSI, "");
};
const read = (out) => ({
  tests: (out.match(/Tests\s+([^\n]*)/u) ?? [])[1] ?? "(无读数行)",
  cases: [...new Set([...out.matchAll(/^\s*× (.+?) \d+ms/gmu)].map((x) => x[1]))],
});
const SUITE = ["packages/hub/test/roles/charter.test.ts", "packages/hub/test/charter/seed.test.ts"];
const base = read(run(["vitest", "run", ...SUITE]));
console.log("基线:", base.tests);
if (/failed/u.test(base.tests)) throw new Error("基线就红，变异读数无意义");
try {
  writeFileSync(TARGET, orig.replace(before, after));
  const m = read(run(["vitest", "run", ...SUITE]));
  console.log("【CEO 签了那一份】之后:", m.tests);
  console.log("红的用例:\n  " + (m.cases.join("\n  ") || "无"));
} finally {
  writeFileSync(TARGET, orig);
  console.log("还原:" + (readFileSync(TARGET, "utf8") === orig ? "与原文逐字一致" : "⚠ 不一致"));
}
