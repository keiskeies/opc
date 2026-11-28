// round402 重钉（0083：group.js 在 researchCreateModal 里 +13 行）：把 docs 与 SNAP 里的 group.js 坐标搬到新行号。
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

// 分档增量 = `git diff -U0` 的逐项读数（5 个 hunk 全在 3752 之后）
const STEPS = [
  { after: 3752, add: 3 },
  { after: 3773, add: 5 },
  { after: 3808, add: 1 },
  { after: 3814, add: 1 },
  { after: 3821, add: 3 },
];
const shift = (n) => STEPS.filter((s) => n > s.after).reduce((a, s) => a + s.add, 0);
const move = (n) => n + shift(n);

// —— 门 0：映射整文件自证。允许的不符行 = 本轮真被替换的行（本轮 diff 里 `-` 行共 1 条）。
let mapBad = 0;
for (let i = 1; i <= head.length; i++) {
  if ((head[i - 1] ?? "") !== (cur[move(i) - 1] ?? "")) mapBad++;
}
if (mapBad !== 1) {
  console.log(`⛔ 映射自证不符 ${mapBad} 行（预期 1），分档读数与真实 diff 不一致 —— 停`);
  process.exit(3);
}
console.log(`门 0 过：HEAD ${head.length} 行按分档映射后仅 1 行不符 = 本轮真改写的那 1 行文案`);
// 反向：当前文件多出来的行数必须等于各档之和
const totalAdd = STEPS.reduce((a, s) => a + s.add, 0);
if (cur.length - head.length !== totalAdd) {
  console.log(`⛔ 行数差 ${cur.length - head.length} ≠ 分档和 ${totalAdd} —— 停`);
  process.exit(3);
}

const REF = /packages\/web\/public\/group\.js:(\d+)/gu;
// 落在改动区间内的坐标是「本轮改过的代码」，机器搬不了 —— 必须人工处理，直接停
const mid = [];
const collect = (rel, text) => {
  for (const m of text.matchAll(REF)) {
    const n = Number(m[1]);
    if (shift(n) !== 0 && n <= 3821) mid.push(`${rel} ${n}`);
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
  console.log(`⛔ ${mid.length} 处坐标落在本轮改动区间内，需人工重钉：\n  ${mid.join("\n  ")} —— 停`);
  process.exit(4);
}

// —— 门 1：坐标集合等势（搬运后不许凭空多出或撞车）。
// 键扫描按引号形状认（0041 那条就是「键在上一行末尾、值在下一行」的排版），
// 这里改用【整面坐标集合】判：搬前搬后必须是双射且元素数不变 —— 不依赖引号排版，
// 也就绕开 round400 那对自撞脚本的根因「键集合认不全就动手」。
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
