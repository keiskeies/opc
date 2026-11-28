// round405：给 0085 台账追加 SNAP 键。家法：值 = 目标行 .trim() 原文，由本脚本逐行读源文件生成，
// 不手抄；插入点 = SNAP 对象收尾 `};` 前；插完交给 biome format 排版。
import { readFileSync, writeFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const SNAP_FILE = "test/arch/doc-refs.test.ts";

// SITES 必须是【守卫真的会从台账里抠出来的那一组】：取材正则 FILE_REF 要求「路径.扩展名:行号」，
// 所以台账里写成 `:4205` 这种续写、以及写成「4051-4055 行」的区间，都不会成为引用 —— 给它们建键
// 只会得到「快照里有，文档里已经没有这条引用」的孤儿红。这 11 条由
// `grep -ohE "[A-Za-z0-9_./-]+\.(ts|js|sql):[0-9]+" docs/decisions/0085-*.md | sort -u` 现抄。
const SITES = [
  ["0085-split-backlog-modal-dropped-the-parent-due-at-and-null-read-as-epoch.md", "packages/contracts/src/backlog.ts", 81],
  ["0085-split-backlog-modal-dropped-the-parent-due-at-and-null-read-as-epoch.md", "packages/contracts/src/backlog.ts", 93],
  ["0085-split-backlog-modal-dropped-the-parent-due-at-and-null-read-as-epoch.md", "packages/hub/src/backlog/service.ts", 599],
  ["0085-split-backlog-modal-dropped-the-parent-due-at-and-null-read-as-epoch.md", "packages/web/public/group.js", 85],
  ["0085-split-backlog-modal-dropped-the-parent-due-at-and-null-read-as-epoch.md", "packages/web/public/group.js", 3236],
  ["0085-split-backlog-modal-dropped-the-parent-due-at-and-null-read-as-epoch.md", "packages/web/public/group.js", 4054],
  ["0085-split-backlog-modal-dropped-the-parent-due-at-and-null-read-as-epoch.md", "packages/web/public/group.js", 4131],
  ["0085-split-backlog-modal-dropped-the-parent-due-at-and-null-read-as-epoch.md", "packages/web/public/group.js", 4199],
  ["0085-split-backlog-modal-dropped-the-parent-due-at-and-null-read-as-epoch.md", "packages/web/public/group.js", 4219],
  ["0085-split-backlog-modal-dropped-the-parent-due-at-and-null-read-as-epoch.md", "packages/web/public/group.js", 4415],
  ["0085-split-backlog-modal-dropped-the-parent-due-at-and-null-read-as-epoch.md", "test/e2e/group-workbench.spec.ts", 4314],
  // INDEX 的 0085 入口行同样在语料里（守卫 walk docs/ 全量 .md），坐标各要一枚键。
  ["INDEX.md", "packages/contracts/src/backlog.ts", 81],
  ["INDEX.md", "packages/contracts/src/backlog.ts", 93],
  ["INDEX.md", "packages/hub/src/backlog/service.ts", 599],
  ["INDEX.md", "packages/web/public/group.js", 85],
  ["INDEX.md", "packages/web/public/group.js", 4199],
  ["INDEX.md", "packages/web/public/group.js", 4219],
];

const line = (f, n) => readFileSync(`D:/item/opc/${f}`, "utf8").split("\n")[n - 1].trim();
const entries = SITES.map(([doc, f, n]) => [`${doc}>${f}:${n}`, line(f, n)]);
for (const [k, v] of entries) console.log(`${k}\n    ${JSON.stringify(v)}`);

const snap = readFileSync(`D:/item/opc/${SNAP_FILE}`, "utf8");
let text = snap;
const fresh = entries.filter(([k]) => {
  if (text.includes(`"${k}":`)) {
    console.log(`跳过（键已在册）：${k}`);
    return false;
  }
  return true;
});
const block = fresh.map(([k, v]) => `  ${JSON.stringify(k)}:\n    ${JSON.stringify(v)},`).join("\n");
const at = text.lastIndexOf("\n};");
if (at < 0) {
  console.log("⛔ 找不到 SNAP 收尾 —— 停");
  process.exit(3);
}
text = text.slice(0, at) + "\n" + block + text.slice(at);
if (APPLY) {
  writeFileSync(`D:/item/opc/${SNAP_FILE}`, text);
  console.log(`已插入 ${fresh.length} 键`);
} else console.log(`dry-run：将插入 ${fresh.length} 键，加 --apply 落盘`);
