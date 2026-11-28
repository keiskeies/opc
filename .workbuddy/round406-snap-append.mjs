// round406：给 0086 台账与 INDEX 入口行追加 SNAP 键。家法：值 = 目标行 .trim() 原文，由本脚本逐行
// 读源文件生成，不手抄；插入点 = SNAP 对象收尾 `};` 前；插完交给 biome format 排版。
//
// SITES 必须是【守卫真的会从语料里抠出来的那一组】：取材正则 FILE_REF 要求「路径.扩展名:行号」，
// 台账里写成 `:139` 这种同行续写、以及区间写法都不会成为引用 —— 给它们建键只会得到孤儿红。
// 这 16 条由下面两条 grep 现抄（台账整篇 + INDEX 的 0086 入口行，守卫 walk docs/ 全量 .md）：
//   grep -ohE "[A-Za-z0-9_./-]+\.(ts|tsx|js|mjs|cjs|md|sql):[0-9]+" docs/decisions/0086-*.md | sort -u
//   grep "^- \*\*0086\*\*" docs/INDEX.md | grep -ohE "...同正则" | sort -u
import { readFileSync, writeFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const SNAP_FILE = "test/arch/doc-refs.test.ts";
const DOC = "0086-meeting-detail-and-minutes-never-recorded-the-moment-it-ended.md";

const SITES = [
  [DOC, "packages/contracts/src/meeting.ts", 51],
  [DOC, "packages/hub/src/documents/deposit.ts", 105],
  [DOC, "packages/hub/src/documents/deposit.ts", 132],
  [DOC, "packages/hub/src/meetings/service.ts", 136],
  [DOC, "packages/hub/src/meetings/service.ts", 139],
  [DOC, "packages/hub/src/meetings/service.ts", 236],
  [DOC, "packages/web/public/group.js", 80],
  [DOC, "packages/web/public/group.js", 3024],
  [DOC, "packages/web/public/group.js", 3123],
  [DOC, "test/e2e/group-workbench.spec.ts", 4541],
  [DOC, "test/e2e/group-workbench.spec.ts", 4671],
  // INDEX 的 0086 入口行同样在语料里，坐标各要一枚键。
  ["INDEX.md", "packages/contracts/src/meeting.ts", 51],
  ["INDEX.md", "packages/hub/src/documents/deposit.ts", 105],
  ["INDEX.md", "packages/hub/src/documents/deposit.ts", 132],
  ["INDEX.md", "packages/hub/src/meetings/service.ts", 136],
  ["INDEX.md", "packages/web/public/group.js", 3024],
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
