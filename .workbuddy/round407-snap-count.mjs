// round407 收尾：SNAP 键数机械复算（台账/INDEX 声明的横杆，不心算）。
import { readFileSync } from "node:fs";

const src = readFileSync("test/arch/doc-refs.test.ts", "utf8");
const lines = src.split("\n");
const s = lines.findIndex((l) => l.startsWith("const SNAP"));
if (s < 0) throw new Error("找不到 SNAP 声明");
let e = -1;
for (let i = s + 1; i < lines.length; i += 1) {
  if (lines[i].startsWith("};")) {
    e = i;
    break;
  }
}
if (e < 0) throw new Error("找不到 SNAP 收尾");
const KEY_RE = /^ {2}(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*:/;
const keys = [];
let unrecognized = 0;
for (const l of lines.slice(s + 1, e)) {
  const m = l.match(KEY_RE);
  if (m) keys.push((m[1] ?? m[2]).replace(/\\"/g, '"'));
  else if (l.trim() !== "" && !l.trim().startsWith("//")) unrecognized += 1;
}
const seen = new Set();
const dup = [];
for (const k of keys) {
  if (seen.has(k)) dup.push(k);
  seen.add(k);
}
console.log(`块范围 l.${s + 1}..${e + 1}`);
console.log(`键行数 ${keys.length} / 唯一 ${seen.size} / 重复 ${dup.length}`);
if (dup.length) console.log(dup);
console.log(`未识别非空行 ${unrecognized}（应≈0；值换行会造成误报，需人工看）`);
