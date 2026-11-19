// 用守卫【自己的】解析函数列：每条验收行点名了哪些路径 token、各自在不在盘上、有没有豁免标记。
import { existsSync } from "node:fs";
import { join } from "node:path";
const { acceptanceBlocks, pathTokens, exemptedBlocks, readPlan, NOT_BUILT_TAG } =
  await import("../test/arch/plan-gate-paths.ts");
const ROOT = process.cwd();
const blocks = acceptanceBlocks(readPlan(ROOT));
console.log("blocks=" + blocks.length + " tagged=" + exemptedBlocks(blocks).length);
for (const b of blocks) {
  const toks = pathTokens(b.text);
  if (toks.length === 0 && !b.text.includes(NOT_BUILT_TAG)) continue;
  console.log("--- 计划第 " + b.lineNo + " 行  tagged=" + b.text.includes(NOT_BUILT_TAG));
  for (const t of toks) console.log("    " + (existsSync(join(ROOT, t)) ? "OK  " : "MISS") + " " + t);
}
