// round401 诊断（只读）：把 docs 里所有指向 packages/web/public/group.js 的坐标 + SNAP 里对应的键
// 逐条列出，并按本轮 diff 的 hunk 算术算出「应然新行号」，再拿当前文件核对 SNAP 值是否正好落在那里。
// 目的有两个：① 先量「键集合覆盖率」（同一套键要用两种独立方式数一遍，认不全就别动手）；
// ② 每一处 +N 的分档都要由当前文件实证，不接受「我以为插在几行就移几行」。
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const TARGET = "packages/web/public/group.js";
const snapPath = "test/arch/doc-refs.test.ts";
const cur = fs.readFileSync(TARGET, "utf8").split("\n");
const head = execFileSync("git", ["show", `HEAD:${TARGET}`], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
}).split("\n");
console.log(`当前 ${cur.length} 行 / HEAD ${head.length} 行 / 差 ${cur.length - head.length}`);

// hunk 算术：(old 末行, 增量) 按 HEAD 侧坐标累积，来自 `git diff -U0` 的逐项读数
const STEPS = [
  { after: 87, add: 13 },
  { after: 615, add: 3 },
  { after: 3259, add: 4 },
  { after: 3578, add: 3 },
  { after: 3589, add: 7 },
];
const shift = (n) => STEPS.filter((s) => n > s.after).reduce((a, s) => a + s.add, 0);
console.log(
  "分档读数：",
  [0, 87, 88, 615, 616, 3259, 3260, 3578, 3579, 3589, 3590, 9624]
    .map((n) => `${n}->${n + shift(n)}`)
    .join("  "),
);
// 自证：HEAD 每一行搬到新行号后内容必须一致（整文件逐行比对，这比抽查任何一条都硬）
let mapBad = 0;
for (let i = 1; i <= head.length; i++) {
  const j = i + shift(i);
  if ((head[i - 1] ?? "") !== (cur[j - 1] ?? "")) {
    mapBad++;
    if (mapBad <= 8) console.log(`  映射失效 HEAD:${i} -> ${j} HEAD[${(head[i - 1] ?? "").trim().slice(0, 40)}] NOW[${(cur[j - 1] ?? "").trim().slice(0, 40)}]`);
  }
}
console.log(`映射自证：HEAD ${head.length} 行按该映射搬过去后内容不符 ${mapBad} 行（预期 = 被替换的那 2 行）`);

// —— 方式一：正则扫 SNAP 里指向 group.js 的键（键值同行 / 换行两种排版都认）
const KEY = /"([^">]+>packages\/web\/public\/group\.js:(\d+))":\s*\n?\s*"((?:[^"\\]|\\.)*)"/gmu;
const snap = fs.readFileSync(snapPath, "utf8");
const snapKeys = new Map();
for (const m of snap.matchAll(KEY)) {
  if (snapKeys.has(m[1])) console.log("!! SNAP 重复键 " + m[1]);
  snapKeys.set(m[1], m[3].split('\\"').join('"'));
}
// —— 方式二：独立数一遍（grep 同形），用于量方式一有没有漏
const grepCount = execFileSync("grep", ["-c", "group\\.js:[0-9]*\":", snapPath], { encoding: "utf8" }).trim();
console.log(`SNAP 键（正则认全）${snapKeys.size} 条 / 独立 grep 计数 ${grepCount} ⇒ 覆盖率 ${snapKeys.size === Number(grepCount) ? "满" : "不满，别动手"}`);

// —— docs 侧的坐标（守卫真正取的语料），与 SNAP 键必须一一对应
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
const docsKeys = new Map();
for (const rel of docs.sort()) {
  const base = rel.split("/").pop();
  fs.readFileSync(rel, "utf8")
    .split("\n")
    .forEach((line, idx) => {
      REF.lastIndex = 0;
      let m = REF.exec(line);
      while (m) {
        if (m[1] === TARGET) {
          const k = `${base}>${TARGET}:${m[2]}`;
          if (docsKeys.has(k)) docsKeys.get(k).push(`${rel}:${idx + 1}`);
          else docsKeys.set(k, [`${rel}:${idx + 1}`]);
        }
        m = REF.exec(line);
      }
    });
}
console.log(`docs 侧 group.js 坐标 ${docsKeys.size} 条（去重后）`);

// —— 对照：docs 有键而 SNAP 没有 / SNAP 有键而 docs 没有
for (const k of docsKeys.keys()) if (!snapKeys.has(k)) console.log("  docs 有 SNAP 无 " + k);
for (const k of snapKeys.keys()) if (!docsKeys.has(k)) console.log("  SNAP 有 docs 无 " + k);

// —— 逐条：旧行 → 新行，SNAP 值是否正好落在新行
let ok = 0;
const needsHuman = [];
for (const [k, val] of snapKeys) {
  const old = Number(k.split(":").pop());
  const want = val.split('\\"').join('"').trim();
  const nowAtOld = (cur[old - 1] ?? "").trim();
  if (nowAtOld === want) {
    ok++; // 未受影响（旧行号本来就对）
    continue;
  }
  const nw = old + shift(old);
  const nowAtNew = (cur[nw - 1] ?? "").trim();
  if (nowAtNew === want) continue; // 需要重钉，且机械搬运即可
  const hits = [];
  cur.forEach((l, i) => {
    if (l.trim() === want) hits.push(i + 1);
  });
  needsHuman.push(`${k.slice(0, 40)} 旧:${old} 新算:${nw} 新行内容[${nowAtNew.slice(0, 40)}] 值[${want.slice(0, 40)}] 全文命中[${hits.join(",")}]`);
}
const movable = snapKeys.size - ok - needsHuman.length;
console.log(`无需动 ${ok} / 可机械搬运 ${movable} / 需人工看 ${needsHuman.length}`);
for (const n of needsHuman) console.log("  ⚠ " + n);
