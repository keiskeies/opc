// round405 重钉（0085：group.js 在 dateInputValue 处 +3 行、拆分弹窗一带 +14 行）：
// 把 docs 与 SNAP 里的 group.js 坐标搬到新行号。
// 三条铁律（前几轮撞出来的）：
//  ① 只搬坐标数字，永不改 SNAP 的值 —— 改值等于给旧主张换新标签。
//  ② 单趟搬运：每个数字只由「原始值」映射一次，绝不做 a→b 再 b→c。
//  ③ 动手前先量：映射整文件自证 + 目标键集合与旧键集合等势（碰撞当场停）。
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

// 分档增量 = `git diff -U0` 的逐项读数（add = 该 hunk 的净增行；1→1 的替换行净增 0，
// 但它后面的档要照 cumulative 走）。8 个 hunk 合计 +50 = 9717 − 9667。
const STEPS = [
  { after: 82, add: 3 },
  { after: 4193, add: 5 },
  { after: 4194, add: 4 },
  { after: 4200, add: 3 },
  { after: 4202, add: 2 },
];
const shift = (n) => STEPS.filter((s) => n > s.after).reduce((a, s) => a + s.add, 0);
const move = (n) => n + shift(n);

// 本轮真被替换掉的那几行（HEAD 坐标系，1→1 净增 0 但内容换了）：落在它们身上的旧主张指的是
// 旧字节，机器搬过去会指到新代码上 ⇒ 硬停，人工判断那条主张还成不成立。
// ⚠ 别再加一份「当前行号的新增区间」来做判据：坐标是 HEAD 行号，两个坐标系混用会把
// 616→666 这种正常搬运误报成「落在改动点上」（本轮第一版就撞在这）。
const REPLACED = [4199, 4200];

// —— 门 0：映射整文件自证。允许的不符行 = 本轮真被替换的行（1→1 共 4 行）。
let mapBad = 0;
for (let i = 1; i <= head.length; i++) {
  if ((head[i - 1] ?? "") !== (cur[move(i) - 1] ?? "")) mapBad++;
}
if (mapBad !== REPLACED.length) {
  console.log(
    `⛔ 映射自证不符 ${mapBad} 行（预期 ${REPLACED.length}），分档读数与真实 diff 不一致 —— 停`,
  );
  process.exit(3);
}
console.log(
  `门 0 过：HEAD ${head.length} 行按分档映射后仅 ${mapBad} 行不符 = 本轮真改写的那 ${REPLACED.length} 行`,
);
// 反向：当前文件多出来的行数必须等于各档之和
const totalAdd = STEPS.reduce((a, s) => a + s.add, 0);
if (cur.length - head.length !== totalAdd) {
  console.log(
    `⛔ 行数差 ${cur.length - head.length} ≠ 分档和 ${totalAdd} —— 停`,
  );
  process.exit(3);
}

const REF = /packages\/web\/public\/group\.js:(\d+)/gu;
// 落在被替换行上的坐标是「本轮改过的代码」，机器搬不了 —— 必须人工处理，直接停
const mid = [];
const collect = (rel, text) => {
  for (const m of text.matchAll(REF)) {
    const n = Number(m[1]);
    if (REPLACED.includes(n)) mid.push(`${rel} ${n}`);
  }
};

// —— 收集 docs 侧（walk 与守卫同法：递归 docs/ 只收 .md，未跟踪的新台账也在面内）
const docs = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (["node_modules", ".git", ".tmp", "dist"].includes(e.name)) continue;
    const p = `${d}/${e.name}`;
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".md")) docs.push(p);
  }
})("docs");
const targets = [...docs, SNAP_PATH];
for (const rel of targets) collect(rel, fs.readFileSync(rel, "utf8"));
if (mid.length > 0) {
  console.log(
    `⛔ ${mid.length} 处坐标落在本轮改动点上，需人工重钉：\n  ${mid.join("\n  ")} —— 停`,
  );
  process.exit(4);
}

// —— 门 1：坐标集合等势（搬运后不许凭空多出或撞车）。
const setOf = (text) => new Set([...text.matchAll(REF)].map((m) => Number(m[1])));
const beforeNums = new Set();
for (const rel of targets) for (const n of setOf(fs.readFileSync(rel, "utf8"))) beforeNums.add(n);
const afterNums = new Set([...beforeNums].map((n) => move(n)));
if (afterNums.size !== beforeNums.size) {
  console.log(
    `⛔ 坐标从 ${beforeNums.size} 个不同值搬成 ${afterNums.size} 个（有碰撞）—— 停`,
  );
  process.exit(5);
}
console.log(
  `门 1 过：整面 ${beforeNums.size} 个不同行号单趟搬运后仍 ${afterNums.size} 个、无碰撞`,
);

// —— 落盘：每处坐标按原始值一次映射
let sites = 0;
for (const rel of targets) {
  const before = fs.readFileSync(rel, "utf8");
  const after = before.replace(REF, (s) => {
    const n = Number(s.split(":")[1]);
    const to = move(n);
    if (to === n) return s;
    sites += 1;
    return `${s.split(":")[0]}:${to}`;
  });
  if (after !== before && APPLY) fs.writeFileSync(rel, after);
}
console.log(`${APPLY ? "已改写" : "待改写"}坐标 ${sites} 处（面：${targets.length} 个文件）`);
if (!APPLY) console.log("dry-run：加 --apply 落盘");
