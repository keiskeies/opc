// round401 重钉（0082：group.js +30 行）：把 docs 里的 group.js 坐标与 SNAP 里的同名键搬到新行号。
// 三条铁律（都是前面几轮撞出来的）：
//  ① 只搬【键/坐标数字】，永不改 SNAP 的值 —— 改值等于给旧主张换新标签。
//  ② 单趟搬运：每个数字只由「原始值」映射一次，绝不做 a→b 再 b→c（分两趟必然自撞）。
//  ③ 动手前先量两件事：映射是否被整文件自证、目标键集合是否与旧键集合等势（碰撞当场停）。
// 默认 dry-run，`--apply` 才落盘。
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const APPLY = process.argv.includes("--apply");
const TARGET = "packages/web/public/group.js";
const SNAP_PATH = "test/arch/doc-refs.test.ts";
const cur = fs.readFileSync(TARGET, "utf8").split("\n");
const head = execFileSync("git", ["show", `HEAD:${TARGET}`], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
}).split("\n");

// 分档增量 = `git diff -U0` 的逐项读数（与 round401-audit-day-snap.mjs 同一份）
const STEPS = [
  { after: 87, add: 13 },
  { after: 615, add: 3 },
  { after: 3259, add: 4 },
  { after: 3578, add: 3 },
  { after: 3589, add: 7 },
];
const shift = (n) => STEPS.filter((s) => n > s.after).reduce((a, s) => a + s.add, 0);
const move = (n) => n + shift(n);

// —— 门 0：映射整文件自证。允许的不符行 = 本轮真改写的行（其 HEAD 内容应等于 SNAP 里某条旧值之外，
//    这里只要求「不符行数 == 被替换的行数」，本轮 diff 里 `-` 行共 2 条）。
let mapBad = 0;
for (let i = 1; i <= head.length; i++) {
  if ((head[i - 1] ?? "") !== (cur[move(i) - 1] ?? "")) mapBad++;
}
if (mapBad !== 2) {
  console.log(`⛔ 映射自证不符 ${mapBad} 行（预期 2），说明分档读数与真实 diff 不一致 —— 停`);
  process.exit(3);
}
console.log(`门 0 过：HEAD ${head.length} 行按分档映射后仅 2 行不符 = 本轮真改写的 2 行`);

// —— 收集 docs 侧坐标（walk 与守卫同法，不用 git ls-files，未跟踪的新台账也在面内）
const docs = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (["node_modules", ".git", ".tmp", "dist"].includes(e.name)) continue;
    const p = `${d}/${e.name}`;
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".md")) docs.push(p);
  }
})("docs");
const REF = /([A-Za-z0-9_./-]+[.](?:ts|tsx|mts|cts|js|mjs|cjs|md|sql))[:]([0-9]+)/g;
const nums = new Set();
const perDoc = new Map();
for (const rel of docs) {
  const base = rel.split("/").pop();
  for (const line of fs.readFileSync(rel, "utf8").split("\n")) {
    REF.lastIndex = 0;
    let m = REF.exec(line);
    while (m) {
      if (m[1] === TARGET) {
        const n = Number(m[2]);
        nums.add(n);
        const k = `${base}>${n}`;
        perDoc.set(k, (perDoc.get(k) ?? 0) + 1);
      }
      m = REF.exec(line);
    }
  }
}
// —— 门 1：碰撞预检。不同旧号映到同一新号，或新号撞上本轮不动的旧号 ⇒ 会顶掉键 ⇒ 停。
const images = new Map();
for (const n of nums) {
  if (shift(n) === 0) continue;
  const t = move(n);
  if (images.has(t)) {
    console.log(`⛔ 碰撞：${n} 与 ${images.get(t)} 都搬到 ${t} —— 停`);
    process.exit(3);
  }
  images.set(t, n);
}
for (const n of nums) {
  if (shift(n) !== 0) continue;
  if (images.has(n)) {
    console.log(`⛔ 碰撞：不动的 ${n} 被本轮某个搬运当成落点 —— 停`);
    process.exit(3);
  }
}
console.log(`门 1 过：docs 侧 group.js 坐标涉及 ${nums.size} 个行号，需搬 ${images.size} 个，无碰撞`);

// —— 门 2：SNAP 键集合与 docs 坐标等势（两种引号排版都认，round400 就是栽在只认双引号）
const KEY = /^\s*"([^">]+>packages\/web\/public\/group\.js:(\d+))":\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/gmu;
const snapText = fs.readFileSync(SNAP_PATH, "utf8");
const snapKeys = new Map();
for (const m of snapText.matchAll(KEY)) {
  if (snapKeys.has(m[1])) console.log(`⛔ SNAP 重复键 ${m[1]}`);
  snapKeys.set(m[1], (m[3] ?? m[4] ?? "").replace(/\\"/g, '"'));
}
const docsKeyCount = new Set();
for (const rel of docs) {
  const base = rel.split("/").pop();
  for (const line of fs.readFileSync(rel, "utf8").split("\n")) {
    REF.lastIndex = 0;
    let m = REF.exec(line);
    while (m) {
      if (m[1] === TARGET) docsKeyCount.add(`${base}>${TARGET}:${m[2]}`);
      m = REF.exec(line);
    }
  }
}
let orphans = 0;
for (const k of docsKeyCount) if (!snapKeys.has(k)) orphans++;
for (const k of snapKeys.keys()) if (!docsKeyCount.has(k)) orphans++;
if (snapKeys.size !== docsKeyCount.size || orphans !== 0) {
  console.log(`⛔ 键集合不等势：SNAP ${snapKeys.size} / docs ${docsKeyCount.size} / 孤儿 ${orphans} —— 停`);
  process.exit(3);
}
console.log(`门 2 过：SNAP 与 docs 键集合等势（各 ${snapKeys.size} 条，孤儿 0）`);

// —— 门 3：搬运后每条 SNAP 值必须正好落在新号那行（值一个字节都不动）
let willMove = 0;
let already = 0;
for (const [k, val] of snapKeys) {
  const n = Number(k.split(":").pop());
  const want = val.trim();
  if ((cur[n - 1] ?? "").trim() === want) already++;
  else if ((cur[move(n) - 1] ?? "").trim() === want) willMove++;
  else {
    console.log(`⛔ ${k} 的值在新号 ${move(n)} 也不对 —— 停（别硬搬）`);
    process.exit(3);
  }
}
console.log(`门 3 过：${already} 条本就对位，${willMove} 条搬过去即对位，0 条需要动值`);
if (!APPLY) {
  console.log("dry-run 结束（未落盘）。加 --apply 才写。");
  process.exit(0);
}

// —— 落盘：单趟，每处数字只由原始值映射。docs 侧只替换【完整坐标】里的行号。
let fileChanges = 0;
let refChanges = 0;
for (const rel of docs) {
  const before = fs.readFileSync(rel, "utf8");
  if (!before.includes(`${TARGET}:`)) continue;
  const after = before
    .split("\n")
    .map((line) => {
      if (!line.includes(`${TARGET}:`)) return line;
      return line.replace(
        new RegExp(`${TARGET.replace(/[/.]/g, (c) => "\\" + c)}:(\\d+)`, "g"),
        (whole, d) => {
          const n = Number(d);
          if (shift(n) === 0) return whole;
          refChanges++;
          return `${TARGET}:${move(n)}`;
        },
      );
    })
    .join("\n");
  if (after !== before) {
    fs.writeFileSync(rel, after);
    fileChanges++;
    console.log(`  改 ${rel}`);
  }
}
// SNAP：只认行首键位置，别摸值
const snapBefore = fs.readFileSync(SNAP_PATH, "utf8");
const snapAfter = snapBefore
  .split("\n")
  .map((line) =>
    line.replace(
      /^(\s*"[^">]+>packages\/web\/public\/group\.js:)(\d+)(")/,
      (whole, pre, d, post) => {
        const n = Number(d);
        if (shift(n) === 0) return whole;
        refChanges++;
        return `${pre}${move(n)}${post}`;
      },
    ),
  )
  .join("\n");
if (snapAfter !== snapBefore) {
  fs.writeFileSync(SNAP_PATH, snapAfter);
  fileChanges++;
  console.log(`  改 ${SNAP_PATH}`);
}
console.log(`落盘完成：${fileChanges} 个文件，坐标数字改写 ${refChanges} 处（docs 与 SNAP 各一份）`);
