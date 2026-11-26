// round379 修复：group.css 里那行注释被 shell 内联 -e 写坏了（U+FFFD 反复出现在同一位置）。
// 内联 node -e 传中文时会在多字节边界上截断，所以改用文件写。跑完自检 FFFD 必须 0。
import { readFileSync, writeFileSync } from "node:fs";

const f = "packages/web/public/group.css";
const R = String.fromCharCode(0xfffd);
const lines = readFileSync(f, "utf8").split("\n");

// 目标行：以「⚠ 这里【不写】min-width:0」开头的那一条。
const idx = lines.findIndex((l) => l.includes("min-width:0") && l.includes("round378"));
if (idx === -1) {
  console.log("找不到目标行");
  process.exit(1);
}
lines[idx] =
  "   ⚠ 这里【不写】min-width:0。round378 写过它，并配了一句错的理由（「去掉后自动最小尺寸";

writeFileSync(f, lines.join("\n"), "utf8");

const after = readFileSync(f, "utf8");
const bad = after.split("\n").filter((l) => l.includes(R));
console.log("FFFD_COUNT", (after.match(new RegExp(R, "g")) || []).length);
for (const l of bad) console.log("  残留:", JSON.stringify(l.slice(0, 100)));
console.log("该行:", after.split("\n")[idx]);
