// admin --chip 候选扫描：在【现值 → 工作台 --neutral】这条线上取若干档，
// 每档都拿 color-scale.test.ts 里把 chip 当落点的【全部行】过一遍尺子。
// 目的：先看存不存在「换了底、前景一个都不用动」的档 —— 存在就只改一枚 token，
// 不存在才去解前景的新值（每加深一枚前景都要单独给理由，能不动就不动）。
// 同时报 chip 自己在 bg / card 上的可辨性：那才是本轮症状（浅色 chip/bg = 1.000，芯片隐形）。
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
const SCOPES = {
  "admin-light": {
    A: hexes(blockOf("packages/web/public/admin.css", ".admin-root {")),
    neutral: hexes(blockOf("packages/web/public/group.css", ":root {")).get("neutral"),
    rows: [
      ["muted", ["card", "bg", "chip"], 4.5],
      ["green", ["chip", "card"], 4.5],
      ["blue-ink", ["chip", "card"], 4.5],
      ["pill-red", ["chip", "card"], 4.5],
      ["gray", ["card", "bg", "chip"], 3.0],
    ],
  },
  "admin-dark": {
    A: hexes(blockOf("packages/web/public/theme.css", 'html[data-theme="dark"] .admin-root {')),
    neutral: hexes(blockOf("packages/web/public/group.css", 'html[data-theme="dark"] {')).get("neutral"),
    rows: [
      ["muted", ["card", "bg", "chip"], 4.5],
      ["green", ["chip", "card"], 4.5],
      ["blue-ink", ["chip", "card"], 4.5],
      ["gray", ["card", "chip"], 3.0],
    ],
  },
};

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
const mix = (a, b, t) =>
  `#${[1, 3, 5]
    .map((i) => Math.round(Number.parseInt(a.slice(i, i + 2), 16) * (1 - t) + Number.parseInt(b.slice(i, i + 2), 16) * t))
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;

for (const [scope, { A, neutral, rows }] of Object.entries(SCOPES)) {
  const cur = A.get("chip");
  console.log(`\n######## ${scope}：chip 现值 ${cur}，目标 ${neutral}（工作台 --neutral）########`);
  console.log(`  ${"chip".padEnd(9)} ${"vs bg".padStart(6)} ${"vs card".padStart(7)}  各行读数（★=不过）`);
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const chip = mix(cur, neutral, t);
    const fails = [];
    const detail = rows.map(([tok, backs, need]) => {
      const rs = backs.map((b) => cr(A.get(tok), b === "chip" ? chip : A.get(b)));
      const bad = rs.filter((r) => r < need).length;
      if (bad > 0) fails.push(tok);
      return `${tok}${bad > 0 ? "★" : ""}`;
    });
    console.log(
      `  ${chip} ${String(cr(chip, A.get("bg"))).padStart(6)} ${String(cr(chip, A.get("card"))).padStart(7)}  ${detail.join(" ")}  ${fails.length === 0 ? "← 全过" : `需动 ${fails.join(",")}`}`,
    );
  }
}
