// round407：给 0087 台账与 INDEX 入口行追加 SNAP 键。家法：值 = 目标行 .trim() 原文，由本脚本逐行
// 读源文件生成，不手抄；插入点 = SNAP 对象收尾 `};` 前；插完交给 biome format 排版。
//
// SITES 与守卫 FILE_REF 抠出的那一组严格一致，由下面两条 grep 现抄（33 + 3 = 36 条；
// 台账初稿里 `spec.ts:4746` 这种裸路径复述已改成非坐标措辞——守卫抠不出的路径不建键，
// 建了就是孤儿红；能抠出的复述必须建键，漏了就是「快照里没有这条引用」红）：
//   grep -ohE "[A-Za-z0-9_./-]+\.(ts|tsx|js|mjs|cjs|md|sql):[0-9]+" docs/decisions/0087-*.md | sort -u
//   grep "^- \*\*0087\*\*" docs/INDEX.md | grep -ohE "...同正则" | sort -u
import { readFileSync, writeFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const SNAP_FILE = "test/arch/doc-refs.test.ts";
const DOC = "0087-member-profile-had-two-clocks-one-never-written-and-one-never-read.md";

const SITES = [
  [DOC, "packages/contracts/src/member.ts", 205],
  [DOC, "packages/contracts/src/member.ts", 206],
  [DOC, "packages/hub/resources/migrations/0013_members.sql", 30],
  [DOC, "packages/hub/resources/migrations/0013_members.sql", 54],
  [DOC, "packages/hub/src/members/service.ts", 253],
  [DOC, "packages/hub/src/members/service.ts", 257],
  [DOC, "packages/hub/src/members/service.ts", 491],
  [DOC, "packages/hub/src/members/service.ts", 542],
  [DOC, "packages/hub/src/members/service.ts", 550],
  [DOC, "packages/hub/src/members/service.ts", 865],
  [DOC, "packages/hub/src/members/service.ts", 936],
  [DOC, "packages/hub/test/members/service.test.ts", 675],
  [DOC, "packages/hub/test/members/service.test.ts", 691],
  [DOC, "packages/hub/test/members/service.test.ts", 721],
  [DOC, "packages/hub/test/members/service.test.ts", 753],
  [DOC, "packages/hub/test/members/service.test.ts", 786],
  [DOC, "packages/web/public/group.js", 80],
  [DOC, "packages/web/public/group.js", 6604],
  [DOC, "packages/web/public/group.js", 6653],
  [DOC, "packages/web/public/group.js", 6655],
  [DOC, "test/e2e/group-workbench.spec.ts", 4746],
  [DOC, "test/e2e/group-workbench.spec.ts", 4756],
  [DOC, "test/e2e/group-workbench.spec.ts", 4880],
  [DOC, "test/e2e/group-workbench.spec.ts", 4888],
  [DOC, "test/e2e/group-workbench.spec.ts", 4897],
  [DOC, "test/e2e/group-workbench.spec.ts", 4902],
  [DOC, "test/e2e/group-workbench.spec.ts", 4928],
  [DOC, "test/e2e/group-workbench.spec.ts", 4935],
  [DOC, "test/e2e/group-workbench.spec.ts", 4962],
  [DOC, "test/e2e/group-workbench.spec.ts", 4964],
  [DOC, "test/e2e/group-workbench.spec.ts", 4978],
  [DOC, "test/e2e/group-workbench.spec.ts", 5005],
  [DOC, "test/e2e/group-workbench.spec.ts", 5013],
  // INDEX 的 0087 入口行同样在语料里，坐标各要一枚键。
  ["INDEX.md", "packages/hub/src/members/service.ts", 257],
  ["INDEX.md", "packages/web/public/group.js", 6656],
  ["INDEX.md", "test/e2e/group-workbench.spec.ts", 4746],
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
