// 0080 坐标重钉：从 git diff 的 hunk 头推出【旧行号 → 新行号】的映射，
// 用它搬 SNAP 键与台账散文引用，逐条核对目标行的真实内容 == 快照内容，不符就停下人来。
//
// 为什么不用「按快照内容 grep 找新行」：`paintBacklogRows(content);` 这种短行在文件里
// 出现好几次，grep 会挑错一个看起来绿了的行（round395 的链式替换事故同源）。
// hunk 偏移是纯算术，不依赖内容唯一性；内容只用来【验证】，不用来找位置。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const TARGET = "packages/web/public/group.js";
const APPLY = process.argv.includes("--apply");

const diff = execFileSync("git", ["diff", "-U0", "--", TARGET], {
  encoding: "utf8",
});
// hunk: @@ -oldStart,oldCount +newStart,newCount @@
const hunks = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gmu)].map(
  (m) => ({
    oldStart: Number(m[1]),
    oldCount: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newCount: m[4] === undefined ? 1 : Number(m[4]),
  }),
);
if (hunks.length === 0) throw new Error("group.js 没有 diff，无事可钉");

/** 旧行号 → 新行号；落在被删区间里的返回 null（那条引用已经指向不存在的行）。 */
function mapLine(old) {
  let shift = 0;
  for (const h of hunks) {
    if (old < h.oldStart) break;
    if (old <= h.oldStart + h.oldCount - 1) {
      // 引用落在 hunk 覆盖的旧区间内：新增行不影响它之前的，删除行会让它悬空。
      if (h.oldCount === 0) break;
      const within = old - h.oldStart;
      if (within >= h.newCount) return null;
      return h.newStart + within;
    }
    shift += h.newCount - h.oldCount;
  }
  return old + shift;
}

const lines = readFileSync(TARGET, "utf8").split("\n");
const REF = /packages\/web\/public\/group\.js:(\d+)/gu;

function repin(path, isSnap) {
  const src = readFileSync(path, "utf8");
  const moved = [];
  const out = src.replace(
    /(packages\/web\/public\/group\.js:)(\d+)/gu,
    (whole, prefix, digits) => {
      const old = Number(digits);
      const next = mapLine(old);
      if (next === null) {
        moved.push([old, "悬空（落在被删除的行里）", ""]);
        return whole;
      }
      if (next === old) return whole;
      const text = (lines[next - 1] ?? "").trim();
      moved.push([old, next, text]);
      if (isSnap) {
        // SNAP 的键行形如 "doc.md>file:NN": [ "内容", … ] ⇒ 值在同一行或下一行，
        // 只在值与目标行对不上时才报，交由下面的核对统一处理。
      }
      return `${prefix}${next}`;
    },
  );
  if (APPLY && out !== src) writeFileSync(path, out, "utf8");
  return moved;
}

// SNAP 的快照值另有一道核对：按【键里的新行号】读目标行，与值逐字比（trim 后）。
function verifySnap(path) {
  const src = readFileSync(path, "utf8");
  const bad = [];
  const re =
    /"([^">]+>packages\/web\/public\/group\.js:(\d+))":\s*\n?\s*\[\s*"((?:[^"\\]|\\.)*)"/gmu;
  for (const m of src.matchAll(re)) {
    const line = Number(m[2]);
    const want = m[3].replace(/\\"/gu, '"').trim();
    const got = (lines[line - 1] ?? "").trim();
    if (got !== want) bad.push(`${m[1]} | 快照 [${want}] 现在是 [${got}]`);
  }
  return bad;
}

const snap = "test/arch/doc-refs.test.ts";
console.log("=== 键位搬运（旧 → 新）===");
const movedSnap = repin(snap, true);
for (const [o, n, t] of movedSnap) console.log(`  ${o} → ${n} | ${t.slice(0, 70)}`);
console.log(`SNAP 搬运 ${movedSnap.length} 处`);

const ledgers = execFileSync("git", ["ls-files", "docs/decisions"], {
  encoding: "utf8",
})
  .split("\n")
  .filter((f) => f.trim());
let ledgerTotal = 0;
for (const f of ledgers) {
  const moved = repin(f, false);
  if (moved.length) {
    console.log(`--- ${f}`);
    for (const [o, n, t] of moved)
      console.log(`  ${o} → ${n} | ${t.slice(0, 70)}`);
    ledgerTotal += moved.length;
  }
}
console.log(`台账散文搬运 ${ledgerTotal} 处`);
console.log("=== SNAP 内容核对（按搬运后的行号）===");
const bad = verifySnap(snap);
if (bad.length === 0) console.log("全部一致");
else for (const b of bad) console.log(`  ✗ ${b}`);
if (!APPLY) console.log("（演练模式，未写盘；加 --apply 落盘）");
