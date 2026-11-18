// round265 O13-3 诚实标注守卫的变异证据。自还原：保存原文、反写、断言还原。
// 用法：node .workbuddy/round265-o13-honest-label-mutate.mjs
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const GUARD = "test/arch/desktop-honest-label.ts";
const orig = readFileSync(GUARD, "utf8");

const run = () => {
  try {
    execSync("pnpm vitest run test/arch/desktop-honest-label.test.ts", {
      stdio: "pipe",
      encoding: "utf8",
    });
    return "PASS";
  } catch {
    return "FAIL";
  }
};

const mutate = (from, to, label) => {
  if (!orig.includes(from)) throw new Error("变异锚点缺失: " + label);
  writeFileSync(GUARD, orig.replace(from, to), "utf8");
  const r = run();
  writeFileSync(GUARD, orig, "utf8");
  console.log(label + " ⇒ " + r + (r === "FAIL" ? " ✓（变异被杀）" : " ✗（变异存活！）"));
  if (r !== "FAIL") process.exitCode = 1;
};

console.log("基线 ⇒ " + run());
// 变异 1：标注判定恒真 ⇒ 「摘标注」与「变真后摘标注」两发必须红
mutate(
  "const labeled = f.indexTs.includes(HONEST_LABEL_MARKER);",
  "const labeled = true; void f;",
  "变异1（labeled 恒真）",
);
// 变异 2：electron 依赖探测恒假 ⇒ 方向 B① 必须红
mutate(
  'return /"@?[a-z0-9-]*electron[a-z0-9/-]*"\\s*:/iu.test(pkgJson);',
  "return false; void pkgJson;",
  "变异2（electron 探测恒假）",
);
// 变异 3：入口探测恒假 ⇒ 方向 B② 必须红
mutate(
  'return rootScripts.includes("packages/desktop");',
  "return false; void rootScripts;",
  "变异3（入口探测恒假）",
);

if (readFileSync(GUARD, "utf8") !== orig) {
  console.error("还原校验失败！");
  process.exit(1);
}
console.log("还原校验 ⇒ 与原文逐字一致 ✓");
console.log("还原后 ⇒ " + run());
