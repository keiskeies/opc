// 打印某个文档某几行里指定片段前后的原文（用于构造 Edit 的 old_string）。
// 用法：node .workbuddy/probe-slice.mjs <相对路径> <行号> <要围绕定位的子串>
import fs from "node:fs";
const path = process.argv[2];
const line = Number(process.argv[3]);
const needle = process.argv[4];
const t = fs.readFileSync(path, "utf8").split(/\r?\n/)[line - 1] ?? "";
let from = 0;
for (;;) {
  const idx = t.indexOf(needle, from);
  if (idx < 0) break;
  console.log("--- @" + idx);
  console.log(JSON.stringify(t.slice(Math.max(0, idx - 120), Math.min(t.length, idx + needle.length + 120))));
  from = idx + needle.length;
}
