// round379 一次性改写：把 doc-layout.spec.ts 里抄来的 TOPBAR 常数换成【从页面量】的 m.topbarH。
// 单独成文件是因为内联 -e 的反斜杠转义在这个 shell 里会自伤（上一发就是 Unterminated regexp）。
import { readFileSync, writeFileSync } from "node:fs";

const f = "test/e2e/doc-layout.spec.ts";
const pairs = [
  ["    const ceiling = m.innerH - TOPBAR;", "    const ceiling = m.innerH - m.topbarH;"],
  ["    ).toBe(m.innerH - TOPBAR);", "    ).toBe(m.innerH - m.topbarH);"],
];

let s = readFileSync(f, "utf8");
const counts = [];
for (const [from, to] of pairs) {
  counts.push(s.split(from).length - 1);
  s = s.split(from).join(to);
}
writeFileSync(f, s, "utf8");

const after = readFileSync(f, "utf8");
const left = after.split("\n").filter((l) => l.includes("TOPBAR") && !l.includes("round379"));
console.log("替换命中:", counts.join("/"), "| 残留 TOPBAR 代码行:", left.length);
for (const l of left) console.log("  ", l.trim().slice(0, 90));
const R = String.fromCharCode(0xfffd);
console.log("FFFD", (after.match(new RegExp(R, "g")) || []).length);
