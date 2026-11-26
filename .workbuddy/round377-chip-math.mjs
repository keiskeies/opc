// admin 浅色 --chip(#f3f5f8) 与 --bg(#f3f5f8) 同值 —— replay 页实测 17 枚 .admin-pill +
// 17 枚 .admin-tag 直接坐在页背景上，芯片那一格读不出来（自底/所在面 = 1.00）。
// 本脚本只做算术，且【所有色值从 CSS 里解析】：上一版凭记忆写 hex，green 写成 #2f7d5b
// （真值 #237e5e）、blue-ink 写成 #2f5aa8（真值 #3867d6）—— 拿假数算出来的结论不能用。
// color-scale 那道硬门里 chip 是 5 行对照的底（muted/green/blue-ink/pill-red 走 4.5，gray 走 3.0），
// 换一个值这 5 行同时挪，所以逐枚过一遍。
import { readFileSync } from "node:fs";

const block = (file, sel) => {
  const src = readFileSync(file, "utf8");
  const i = src.indexOf(sel);
  if (i < 0) throw new Error(`找不到块：${sel} in ${file}`);
  const open = src.indexOf("{", i);
  let d = 0;
  for (let j = open; j < src.length; j += 1) {
    if (src[j] === "{") d += 1;
    else if (src[j] === "}" && (d -= 1) === 0) return src.slice(open, j);
  }
  throw new Error("花括号没配平");
};
const tokens = (s) => {
  const m = new Map();
  for (const x of s.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/gu)) m.set(x[1].slice(2), x[2]);
  return m;
};
const L = tokens(block("packages/web/public/admin.css", ".admin-root {"));
const D = tokens(block("packages/web/public/theme.css", "html[data-theme=\"dark\"] .admin-root {"));

const lum = (hex) => {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const cr = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
};

console.log(`解析到的浅色 token：chip=${L.get("chip")} bg=${L.get("bg")} card=${L.get("card")}`);
console.log(`解析到的暗色 token：chip=${D.get("chip")} bg=${D.get("bg")} card=${D.get("card")}\n`);
console.log(`浅色 chip/bg = ${cr(L.get("chip"), L.get("bg"))}（1.00 ⇒ 芯片坐在页背景上完全隐形）`);
console.log(`暗色 chip/bg = ${cr(D.get("chip"), D.get("bg"))}（暗色本来就分得开）`);
console.log(`暗色 chip/card = ${cr(D.get("chip"), D.get("card"))}，浅色 chip/card = ${cr(L.get("chip"), L.get("card"))}\n`);

// color-scale.test.ts 里 chip 当落点的那 5 行，逐枚按真值过尺子
const ROWS = [
  ["muted", "text", 4.5],
  ["green", "text", 4.5],
  ["blue-ink", "text", 4.5],
  ["pill-red", "text", 4.5],
  ["gray", "ui", 3.0],
];
const CANDIDATES = [
  ["现值（= --bg）", L.get("bg")],
  ["对齐工作台 --neutral", "#e9edf3"],
  ["比 bg 重一档 #eceff5", "#eceff5"],
  ["比 bg 重两档 #e6eaf1", "#e6eaf1"],
];
console.log("== 浅色候选：chip 当前景的底（须��过），以及 chip 自己在 bg/card 上的可辨性 ==\n");
for (const [name, chip] of CANDIDATES) {
  const lines = ROWS.map(([k, role, need]) => {
    const hex = L.get(k);
    const r = cr(hex, chip);
    return `     ${k.padEnd(9)}${hex} (${role}≥${need}) ${String(r).padStart(5)} ${r >= need ? "过" : "★不过"}`;
  }).join("\n");
  console.log(
    `${name} chip=${chip}\n     chip/bg ${cr(chip, L.get("bg"))} · chip/card ${cr(chip, L.get("card"))}\n${lines}\n`,
  );
}
console.log("== 参照：工作台那一族的中性填充 ==");
const g = block("packages/web/public/group.css", ":root {");
const neutral = /--neutral:\s*(#[0-9a-fA-F]{6})/u.exec(g)?.[1];
const gb = /--bg:\s*(#[0-9a-fA-F]{6})/u.exec(g)?.[1];
console.log(`  --neutral ${neutral} vs --bg ${gb} ⇒ ${cr(neutral, gb)}（工作台芯片与页背景分得开）`);
