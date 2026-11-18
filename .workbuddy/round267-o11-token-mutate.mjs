// round267 O11-② 守卫判据自身的变异证据。自还原（保存原文 + 反写 + 逐字比对）。
// 用法：node .workbuddy/round267-o11-token-mutate.mjs
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const GUARD = "test/arch/irreversible-token.ts";
const orig = readFileSync(GUARD, "utf8");

const run = () => {
  try {
    execSync("pnpm vitest run test/arch/irreversible-token.test.ts", {
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
// 变异1：写判据正则永不命中 ⇒ 「偷偷写 UPDATE approvals」的合成发必须红
mutate(
  "export const APPROVE_WRITE_RE = /UPDATE\\s+approvals\\s+SET\\s+status/isu;",
  "export const APPROVE_WRITE_RE = /^$/u;",
  "变异1（写判据恒不命中）",
);
// 变异2：调用方正则永不命中 ⇒ 验收句那一发必须红
mutate(
  'export const APPROVE_CARD_CALL_RE = /await\\s+approveCard\\s*\\(/u;',
  "export const APPROVE_CARD_CALL_RE = /^$/u;",
  "变异2（approveCard 调用判据恒不命中）",
);
// 变异3：条目过期检查跳过（text 视作总能读到）⇒ 「特征串被删」两发必须红
mutate(
    "if (text === undefined || !text.includes(e.marker)) {\n      problems.push(\n        \"APPROVE_PATHS 条目",
    "if (false) {\n      problems.push(\n        \"APPROVE_PATHS 条目",
    "变异3（APPROVE_PATHS 过期检查失效）",
);
// 变异4：拒建判据检查跳过 ⇒ cards.ts 特征串消失那一发必须红
mutate(
  'if (cards === undefined || !cards.includes(REJECT_BUILD_MARKER)) {',
  "if (false) {",
  "变异4（建卡拒建检查失效）",
);

if (readFileSync(GUARD, "utf8") !== orig) {
  console.error("还原校验失败！");
  process.exit(1);
}
console.log("还原校验 ⇒ 与原文逐字一致 ✓");
console.log("还原后 ⇒ " + run());
