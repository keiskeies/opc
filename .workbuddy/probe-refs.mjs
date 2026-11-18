// 一次性坐标定位器：把某个文档某几行里的 `file:line` 引用与裸 `:NNN` 引用连同上下文打印出来。
// 用法：node .workbuddy/probe-refs.mjs <相对路径> <行号,逗号分隔>
import fs from "node:fs";
const path = process.argv[2];
const rows = (process.argv[3] || "").split(",").map((s) => Number(s.trim())).filter(Boolean);
const lines = fs.readFileSync(path, "utf8").split(/\r?\n/);
for (const n of rows) {
  const t = lines[n - 1] ?? "";
  console.log("=== " + path + ":" + n + " len=" + t.length);
  let m;
  const ref = /[\w./-]+\.(ts|tsx|md|sql|mjs|js):([0-9]+)/g;
  while ((m = ref.exec(t)) !== null) {
    console.log("  REF " + m[0] + " @" + m.index);
    console.log("      ..." + t.slice(Math.max(0, m.index - 220), Math.min(t.length, m.index + 120)));
  }
  const bare = /主断言[^。]{0,40}|:`?[0-9]{3}`? ?\/ ?`?[0-9]{3}`?/g;
  while ((m = bare.exec(t)) !== null) {
    console.log("  BARE " + JSON.stringify(m[0]) + " @" + m.index);
  }
}
