// round407 重钉（0087）：members/service.ts 加了 20 行（含 4 行改写）、group.js 纯追加 4 行。
// 三条铁律：① 只搬坐标数字，永不改 SNAP 的值；② 单趟搬运（每个数字只由原始值映射一次）；
// ③ 动手前先量：映射整文件自证 + 目标键集合与旧键集合等势（碰撞当场停）。默认 dry-run。
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const APPLY = process.argv.includes("--apply");
const SNAP_PATH = "test/arch/doc-refs.test.ts";

/** 分档来自 `git diff -U0`：add = 该 hunk 的净增行数；after = 影响点之前的 HEAD 行号。 */
const TARGETS = [
  {
    rel: "packages/hub/src/members/service.ts",
    re: /packages\/hub\/src\/members\/service\.ts:(\d+)/gu,
    steps: [
      { after: 255, add: 3 },
      { after: 486, add: 12 },
      { after: 814, add: 1 },
      { after: 849, add: 2 },
      { after: 918, add: 2 },
    ],
    replaced: [813, 814, 848, 917],
  },
  {
    rel: "packages/web/public/group.js",
    re: /packages\/web\/public\/group\.js:(\d+)/gu,
    steps: [{ after: 6652, add: 4 }],
    replaced: [],
  },
];

const docs = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (["node_modules", ".git", ".tmp", "dist"].includes(e.name)) continue;
    const p = `${d}/${e.name}`;
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".md")) docs.push(p);
  }
})("docs");
const files = [...docs, SNAP_PATH];

let sites = 0;
for (const t of TARGETS) {
  const cur = fs.readFileSync(t.rel, "utf8").split("\n");
  const head = execFileSync("git", ["show", `HEAD:${t.rel}`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).split("\n");
  const move = (n) =>
    n + t.steps.filter((s) => n > s.after).reduce((a, s) => a + s.add, 0);

  // —— 门 0：映射整文件自证（未改写的行必须逐字节落在映射后的位置上）。
  let mapBad = 0;
  for (let i = 1; i <= head.length; i++) {
    if (t.replaced.includes(i)) continue;
    if ((head[i - 1] ?? "") !== (cur[move(i) - 1] ?? "")) mapBad++;
  }
  if (mapBad !== 0) {
    console.log(`⛔ [${t.rel}] 映射自证不符 ${mapBad} 行 —— 分档与真实 diff 不一致，停`);
    process.exit(3);
  }
  const totalAdd = t.steps.reduce((a, s) => a + s.add, 0);
  if (cur.length - head.length !== totalAdd) {
    console.log(`⛔ [${t.rel}] 行数差 ${cur.length - head.length} ≠ 分档和 ${totalAdd} —— 停`);
    process.exit(3);
  }
  console.log(
    `门 0 过 [${t.rel}]：HEAD ${head.length} 行（wc -l ${head.length - 1}）映射后 0 行不符，净增 ${totalAdd} ⇒ ${cur.length} 行`,
  );

  // —— 门 0.5：落在被改写行上的旧主张必须点名交给人（这些行内容真的变了）。
  const mid = [];
  for (const rel of files) {
    for (const m of fs.readFileSync(rel, "utf8").matchAll(t.re)) {
      if (t.replaced.includes(Number(m[1]))) mid.push(`${rel} ${m[1]}`);
    }
  }
  if (mid.length > 0) {
    console.log(`⛔ [${t.rel}] ${mid.length} 处坐标落在改写行上，需人工重钉：\n  ${mid.join("\n  ")}`);
    process.exit(4);
  }

  // —— 门 1：坐标集合等势（单趟搬运不许碰撞）。
  const nums = new Set();
  for (const rel of files) {
    for (const m of fs.readFileSync(rel, "utf8").matchAll(t.re)) {
      nums.add(Number(m[1]));
    }
  }
  const after = new Set([...nums].map((n) => move(n)));
  if (after.size !== nums.size) {
    console.log(`⛔ [${t.rel}] ${nums.size} 个不同行号搬成 ${after.size} 个（碰撞）—— 停`);
    process.exit(5);
  }
  const moved = [...nums].filter((n) => move(n) !== n).sort((a, b) => a - b);
  console.log(
    `门 1 过 [${t.rel}]：整面 ${nums.size} 个不同行号 → ${after.size} 个、无碰撞；需搬 ${moved.length} 个（${moved[0]}..${moved[moved.length - 1]}）`,
  );

  // —— 落盘：每处坐标按原始值一次映射。
  for (const rel of files) {
    const before = fs.readFileSync(rel, "utf8");
    const wrote = before.replace(t.re, (s) => {
      const n = Number(s.split(":").pop());
      const to = move(n);
      if (to === n) return s;
      sites += 1;
      return `${s.split(":")[0]}:${to}`;
    });
    if (wrote !== before && APPLY) fs.writeFileSync(rel, wrote);
  }
}
console.log(`${APPLY ? "已改写" : "待改写"}坐标合计 ${sites} 处（面：${files.length} 个文件）`);
if (!APPLY) console.log("dry-run：加 --apply 落盘");
