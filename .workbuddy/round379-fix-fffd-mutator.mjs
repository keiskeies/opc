// 按码点修复 round379-compact-mutations.mjs 注释里的两处传输腐蚀。
import fs from "node:fs";

const FILE = ".workbuddy/round379-compact-mutations.mjs";
const CH = "\uFFFD";
const FIXES = [
  { line: 10, bad: CH + CH, good: String.fromCharCode(0x987b), anchor: String.fromCharCode(0x987b) + "\u6709" }, // 须有
  { line: 122, bad: CH + CH, good: String.fromCharCode(0x6761), anchor: "\u90a3" + String.fromCharCode(0x6761) + "\u89c4\u5219" }, // 那条规则
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
