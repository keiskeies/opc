// round400 诊断：把 SNAP 里所有指向 packages/web/public/group.js 的键逐条对照当前文件
// 输出：每条「不符」的键行号、当前行内容、期望值在文件里的唯一命中行号（命中数 != 1 时标 ?）
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const target = "packages/web/public/group.js";
const snapPath = "test/arch/doc-refs.test.ts";
const lines = fs.readFileSync(target, "utf8").split("\n");
const snap = fs.readFileSync(snapPath, "utf8");

// 键形如 "0075-xxx>packages/web/public/group.js:8834": "内容",
const KEY = /"([^">]+>packages\/web\/public\/group\.js:(\d+))":\s*\n?\s*"((?:[^"\\]|\\.)*)"/gmu;
const seen = new Map();
const bad = [];
for (const m of snap.matchAll(KEY)) {
  const key = m[1];
  const n = Number(m[2]);
  const val = m[3].split('\\"').join('"').trim();
  if (seen.has(key)) console.log("!! 重复键 " + key);
  seen.set(key, val);
  const cur = (lines[n - 1] ?? "").trim();
  if (cur === val) continue;
  const hits = [];
  lines.forEach((l, i) => {
    if (l.trim() === val) hits.push(i + 1);
  });
  bad.push({ doc: key.split(">")[0], n, val, cur, hits });
}
console.log(`键 ${seen.size} 条，值不符 ${bad.length} 条`);
for (const b of bad) {
  console.log(
    `  ${b.doc.slice(0, 4)} 键:${b.n} 当前[${b.cur.slice(0, 50)}] 期望[${b.val.slice(0, 50)}] 命中[${b.hits.join(",")}]`,
  );
}

// HEAD 版 group.js 的同名行，用于确认「键属于改动前还是改动后」
const head = execFileSync("git", ["show", `HEAD:${target}`], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
}).split("\n");
console.log("--- 对照 HEAD ---");
for (const b of bad) {
  console.log(`  ${b.doc.slice(0, 4)} HEAD:${b.n} = [${(head[b.n - 1] ?? "").trim().slice(0, 50)}]`);
}
