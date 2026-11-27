// SNAP 键重复自检：对象字面量里重复键会静默折叠，守卫照样绿。
import { readFileSync } from "node:fs";

const src = readFileSync("test/arch/doc-refs.test.ts", "utf8");
const start = src.indexOf("const SNAP: Record<string, string> = {");
const body = src.slice(start, src.indexOf("\n};", start));
const lines = body.split("\n").slice(1, -1);
const keys = [];
for (const l of lines) {
  const m = /^ {2}"((?:[^"\\]|\\.)*)":/u.exec(l);
  if (m) keys.push(m[1]);
}
const counts = new Map();
for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
const dup = [...counts].filter(([, n]) => n > 1);
console.log(`SNAP 键 ${keys.length} 行 / 去重 ${counts.size} / 重复 ${dup.length}`);
for (const [k, n] of dup) console.log(`  DUP x${n} ${k}`);
console.log(dup.length === 0 ? "✅ 无静默折叠" : "⛔ 有键被顶掉");
