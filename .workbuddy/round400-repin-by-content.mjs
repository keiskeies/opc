// ⛔ 这一版方向对了（值一律不动），但仍然不能照抄：它的 SNAP 扫描只认「键与值写在同一行」
//    那一种排版，认全的键集合不完整 ⇒ 推出的映射缺一档，而映射是【全局】套用的，
//    于是 `9221 → 9224` 与本来就存在的 `9224` 撞成两条同名键（dup 审计报「有键被顶掉」）。
//    两条教训：① 搬运前先跑一遍「键集合覆盖率」，认不全就别动；② `a→b` 与 `b→c` 必须
//    在【同一趟】里换，分两趟必然自撞。终态是靠
//    .workbuddy/round400-audit-group-snap.mjs 逐条核对 + 手工 revert 三篇旧台账重推出来的。
//
// 上一版搬运脚本的 MAP 只覆盖了我这一轮点名的锚点，漏了 0075/0076/0079 那些【也受 formatter
// 平移影响】的旧键 ⇒ 脚本没搬键、却把键的【值】改成了陈旧行上的内容（把旧主张重新贴标签 =
// 最坏的一种「绿」）。这一版反过来做：值一律不动，只搬键，且搬的依据是「该值在文件里
// 逐字符唯一」—— 不唯一就停下来交人判断，绝不去改值。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const TARGET = "packages/web/public/group.js";
const APPLY = process.argv.includes("--apply");
const lines = readFileSync(TARGET, "utf8").split("\n");
const snapPath = "test/arch/doc-refs.test.ts";
const snap = readFileSync(snapPath, "utf8");

const KEY =
  /"([^">]+>packages\/web\/public\/group\.js:(\d+))":\n(\s*)"((?:[^"\\]|\\.)*)",/gmu;

const unq = [];
const moves = [];
for (const m of snap.matchAll(KEY)) {
  const key = m[1];
  const line = Number(m[2]);
  const want = m[4].split('\\"').join('"').trim();
  const cur = (lines[line - 1] ?? "").trim();
  if (cur === want) continue;
  const hits = [];
  lines.forEach((l, i) => {
    if (l.trim() === want) hits.push(i + 1);
  });
  if (hits.length !== 1) {
    unq.push(key + " | 期望 [" + want.slice(0, 60) + "] 命中 " + hits.length + " 处 " + hits.slice(0, 5).join(","));
    continue;
  }
  moves.push([key, line, hits[0], want]);
}

console.log("需要搬键 " + moves.length + " 条；判不了 " + unq.length + " 条");
for (const [key, old, next, want] of moves) {
  console.log("  " + key.replace(/^.*>/, "") + " " + old + " → " + next + " | " + want.slice(0, 60));
}
for (const u of unq) console.log("  ✗ 不唯一/找不到：" + u);

if (unq.length > 0) {
  console.log("有不唯一项 ⇒ 拒绝写盘（改键可以，猜不行）");
  process.exit(2);
}

if (APPLY) {
  // 键与散文引用一起搬：docs/ 下那几篇也引了同批坐标。
  const map = new Map(moves.map(([, old, next]) => [old, next]));
  const REF = /(packages\/web\/public\/group\.js:)(\d+)/gu;
  const ledgers = execFileSync("git", ["ls-files", "docs"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((f) => f.endsWith(".md"));
  for (const f of [snapPath, ...ledgers]) {
    const src = readFileSync(f, "utf8");
    const out = src.replace(REF, (whole, prefix, digits) => {
      const old = Number(digits);
      return map.has(old) ? prefix + map.get(old) : whole;
    });
    if (out !== src) writeFileSync(f, out, "utf8");
  }
  console.log("已按内容唯一性搬键并写盘");
} else {
  console.log("（演练模式，未写盘；加 --apply 落盘）");
}
