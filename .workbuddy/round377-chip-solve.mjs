// admin --chip 对齐工作台 --neutral 的全量算账（两套主题 × color-scale 里 chip 当落点的每一行）。
// 为什么不能只改一个数：--chip 是 admin 的中性填充面，浅色下它与自己的 --bg 同值 #f3f5f8
// ⇒ 直接坐在页背景上的 17 枚 .admin-pill + 17 枚 .admin-tag 形状完全不存在（round377-invisible-face.log
// 实测比 1.000）。而工作台同一角色走 --neutral(#e9edf3 vs --bg #f3f5f8 ⇒ 1.08)，分得开。
// 换底 ⇒ 压在它上面的每一枚前景同时挪尺子，所以要逐枚解出「刚好过线」的新值：
// 色相/饱和不动、只降明度，且过【该行在 PAIRS 里列出的每一格底】，取第一个满足的最浅档。
import { readFileSync } from "node:fs";

const blockOf = (file, sel) => {
  const src = readFileSync(file, "utf8");
  const i = src.indexOf(sel);
  if (i < 0) throw new Error(`找不到块 ${sel}`);
  const open = src.indexOf("{", i);
  let d = 0;
  for (let j = open; j < src.length; j += 1) {
    if (src[j] === "{") d += 1;
    else if (src[j] === "}" && (d -= 1) === 0) return src.slice(open, j);
  }
  throw new Error("花括号没配平");
};
const hexes = (s) => {
  const m = new Map();
  for (const x of s.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/gu)) m.set(x[1].slice(2), x[2]);
  return m;
};
const ADMIN_LIGHT = hexes(blockOf("packages/web/public/admin.css", ".admin-root {"));
const ADMIN_DARK = hexes(blockOf("packages/web/public/theme.css", 'html[data-theme="dark"] .admin-root {'));
const GROUP_LIGHT = hexes(blockOf("packages/web/public/group.css", ":root {"));
const GROUP_DARK = hexes(blockOf("packages/web/public/group.css", 'html[data-theme="dark"] {'));

const lum = (hex) => {
  const c = [1, 3, 5]
    .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const cr = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
};
const toHsl = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return [Math.round(((h * 60 + 360) % 360)), Math.round(s * 100), Math.round(l * 100)];
};
const toHex = (h, s, l) => {
  const S = s / 100;
  const L = l / 100;
  const c = (1 - Math.abs(2 * L - 1)) * S;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = L - c / 2;
  const seg = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `#${seg.map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("")}`;
};
/** 暗色要往【亮】走、浅色往【暗】走：方向由「现在压不压得住」决定，两向都搜。 */
function solve(hex, backs, need, dir) {
  const [h, s, l0] = toHsl(hex);
  for (let i = 0; i <= 60; i += 1) {
    const l = dir === "down" ? l0 - i : l0 + i;
    if (l < 3 || l > 97) break;
    const cand = toHex(h, s, l);
    const rs = backs.map((b) => cr(cand, b));
    if (rs.every((r) => r >= need)) return { hex: cand, l0, l, rs, steps: i };
  }
  return null;
}

// color-scale.test.ts PAIRS 里把 chip 列为落点的行（逐条抄，别凭记忆）
const ROWS = {
  "admin-light": [
    ["muted", ["card", "bg", "chip"], 4.5],
    ["green", ["chip", "card"], 4.5],
    ["blue-ink", ["chip", "card"], 4.5],
    ["pill-red", ["chip", "card"], 4.5],
    ["gray", ["card", "bg", "chip"], 3.0],
  ],
  "admin-dark": [
    ["muted", ["card", "bg", "chip"], 4.5],
    ["green", ["chip", "card"], 4.5],
    ["blue-ink", ["chip", "card"], 4.5],
    ["gray", ["card", "chip"], 3.0],
  ],
};

for (const theme of ["light", "dark"]) {
  const A = theme === "light" ? ADMIN_LIGHT : ADMIN_DARK;
  const NEUTRAL = (theme === "light" ? GROUP_LIGHT : GROUP_DARK).get("neutral");
  const dir = theme === "light" ? "down" : "up";
  console.log(`\n######## admin-${theme}：--chip ${A.get("chip")} → ${NEUTRAL}（= group.css --neutral）########`);
  console.log(
    `  新 chip 与两格面的可辨性：vs bg ${cr(NEUTRAL, A.get("bg"))} · vs card ${cr(NEUTRAL, A.get("card"))}` +
      `（现值：vs bg ${cr(A.get("chip"), A.get("bg"))} · vs card ${cr(A.get("chip"), A.get("card"))}）`,
  );
  for (const [tok, backs, need] of ROWS[`admin-${theme}`]) {
    const hex = A.get(tok);
    const backHexes = backs.map((b) => (b === "chip" ? NEUTRAL : A.get(b)));
    const now = backs.map((b, i) => cr(hex, backHexes[i]));
    const fail = now.some((r) => r < need);
    const line = backs.map((b, i) => `${b} ${now[i]}`).join(" · ");
    console.log(`  ${tok.padEnd(9)} ${hex} → ${line} ${fail ? "★不过" : "过"}`);
    if (!fail) continue;
    const r = solve(hex, backHexes, need, dir);
    if (!r) {
      console.log(`      找不到解（${dir} 搜到底仍不过）`);
      continue;
    }
    console.log(`      解：${hex} → ${r.hex}（L ${r.l0}%→${r.l}%，走 ${r.steps} 档）⇒ ${r.rs.join(" / ")}`);
  }
}
