// 按码点修复 compact-scale.test.ts 的两处传输腐蚀：
// 行30「放松】[天]然失明」、行534「读一次，[供]下面每条」。
import fs from "node:fs";

const FILE = "test/web/compact-scale.test.ts";
const CH = "\uFFFD";
const FIXES = [
  { line: 30, bad: CH + CH, good: String.fromCharCode(0x5929), anchor: String.fromCharCode(0x5929) + "\u7136\u5931\u660e" }, // 天然失明
  { line: 534, bad: CH + CH + CH, good: String.fromCharCode(0x4f9b), anchor: String.fromCharCode(0x4f9b) + "\u4e0b\u9762\u6bcf\u6761" }, // 供下面每条
];

const lines = fs.readFileSync(FILE, "utf8").split("\n");
for (const fix of FIXES) {
  const idx = fix.line - 1;
  const before = lines[idx] ?? "";
  if (before.includes(fix.anchor)) {
    console.log(`SKIP 行${fix.line} 已修好`);
    continue;
  }
  if (!before.includes(fix.bad)) {
    console.log(`FAIL 行${fix.line} 未找到预期替换符串：${JSON.stringify(before)}`);
    process.exit(1);
  }
  lines[idx] = before.replace(fix.bad, fix.good);
  console.log(`FIXED 行${fix.line} = ${JSON.stringify(lines[idx])}`);
}
fs.writeFileSync(FILE, lines.join("\n"));
const rest = (fs.readFileSync(FILE, "utf8").match(new RegExp(CH, "gu")) || []).length;
console.log(`剩余 U+FFFD = ${rest}`);
