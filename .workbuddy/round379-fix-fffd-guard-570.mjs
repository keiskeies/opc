// 修复 test/web/compact-scale.test.ts:570 的 U+FFFD（传输层把「相」打成 3 个替换符）。
// 按码点写，不经过 shell 内联中文，避免二次腐蚀。
import fs from "node:fs";

const FILE = "test/web/compact-scale.test.ts";
const FIX = "\u76f8"; // 相
const raw = fs.readFileSync(FILE, "utf8");
const lines = raw.split("\n");
const idx = 569;
const before = lines[idx];

if (before.indexOf("\uFFFD") === -1) {
  console.log("SKIP 该行已无 U+FFFD");
  process.exit(0);
}
const anchor = FIX + "\u90bb\u5361"; // 相邻卡
if (before.indexOf(anchor) !== -1) {
  console.log("SKIP 锚点已存在");
  process.exit(0);
}
const bad = "\uFFFD\uFFFD\uFFFD";
if (before.indexOf(bad) === -1) {
  console.log("FAIL 未找到 3 连替换符，实际行：" + JSON.stringify(before));
  process.exit(1);
}
lines[idx] = before.replace(bad, FIX);
fs.writeFileSync(FILE, lines.join("\n"));

const after = fs.readFileSync(FILE, "utf8").split("\n")[idx];
const count = (fs.readFileSync(FILE, "utf8").match(/\uFFFD/g) || []).length;
console.log("FIXED 行570 = " + JSON.stringify(after));
console.log("剩余 U+FFFD 文件级计数 = " + count);
