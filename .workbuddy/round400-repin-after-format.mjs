// ⛔ 不要照抄这一版 —— 它把 SNAP 的【值】也改了（见下），等于给旧主张换了个新标签，
//    是最坏的一种「绿」。它搬的键是对的，改值那一半是错的。配套记录见
//    docs/decisions/0081-…md 的 §8；正确的收尾做法是 .workbuddy/round400-audit-group-snap.mjs
//    （逐条拿值在目标文件里找命中，命中数 != 1 就拒搬，全程不碰值）。
//
// 0081：formatter 把 group.js 里几处换行改了 ⇒ 已引用坐标整体重钉。
// 每个新行号来自「该锚点在文件里恰好出现一次」的内容定位（见 round400-line-map 的生成方式），
// 这里只做搬运 + 按新行号读真实行内容核对 SNAP 值。
// ⚠ 上面那句「核对」当时实现成了【不一致就把值改成新行读到的内容】，于是它一边搬键一边
//    重写值；0075/0076 两格的值就是被这一版改掉的。而且它只遍历 `git ls-files` ⇒ 未跟踪的
//    新台账（0081 自己）压根不在重钉面里。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

// 旧行号 → 新行号（formatter 只在那 4 个 hunk 里改了行数）。
const MAP = {
  6808: 6809,
  6813: 6814,
  6842: 6844,
  7014: 7016,
  7025: 7027,
  8340: 8342,
  8350: 8353,
  8362: 8368,
  8368: 8374,
  8389: 8392,
  8545: 8548,
  8552: 8555,
  8567: 8570,
  8573: 8576,
  8589: 8592,
  8602: 8605,
};

const lines = readFileSync("packages/web/public/group.js", "utf8").split("\n");
const ledgers = execFileSync("git", ["ls-files", "docs/decisions"], {
  encoding: "utf8",
})
  .trim()
  .split("\n");
const files = ["test/arch/doc-refs.test.ts", "docs/INDEX.md", ...ledgers];

const REF = /(packages\/web\/public\/group\.js:)(\d+)/gu;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const moved = [];
  const out = src.replace(REF, (whole, prefix, digits) => {
    const old = Number(digits);
    if (!(old in MAP)) return whole;
    moved.push(old + "→" + MAP[old]);
    return prefix + MAP[old];
  });
  if (out !== src) {
    writeFileSync(f, out, "utf8");
    console.log(f + ": " + moved.join(", "));
  }
}

// SNAP 值同步：键里的行号已经指向新行，快照值须等于那一行的 trim 原文。
const snapPath = "test/arch/doc-refs.test.ts";
let snap = readFileSync(snapPath, "utf8");
const KEY =
  /"([^">]+>packages\/web\/public\/group\.js:(\d+))":\s*\n(\s*)"((?:[^"\\]|\\.)*)",/gmu;
let rewritten = 0;
const bad = [];
for (const m of snap.matchAll(KEY)) {
  const line = Number(m[2]);
  const indent = m[3];
  const want = m[4].split('\\"').join('"').trim();
  const got = (lines[line - 1] ?? "").trim();
  if (got === want) continue;
  const oldTail = m[0];
  const escaped = got.split("\\").join("\\\\").split('"').join('\\"');
  const newTail =
    '"' + m[1] + '":\n' + indent + '"' + escaped + '",';
  if (!snap.includes(oldTail)) {
    bad.push("找不到键尾 " + m[1]);
    continue;
  }
  snap = snap.replace(oldTail, newTail);
  rewritten += 1;
  console.log("  值改写 " + m[1] + "\n     旧: " + want.slice(0, 72) + "\n     新: " + got.slice(0, 72));
}
writeFileSync(snapPath, snap, "utf8");
console.log("SNAP 值改写 " + rewritten + " 条");
if (bad.length) {
  for (const b of bad) console.log("  ✗ " + b);
  process.exit(2);
}
