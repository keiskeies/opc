/*
 * 一次性普查（round336）：docs/ 里 `file.ts:NNN` 这种【源码行号引用】，
 * 有多少连两条最弱的可机检判据都过不了 —— 文件存不存在、行号越不越界。
 *
 * ⚠ 射程：这只判【坐标还指得到东西】，完全不判【那一行说的是不是那句话】。
 * 后一半判不了的理由见台账 round333 ④（散文引文没有可机检的等价判据）。
 * 这一发的用途是量「要不要给源码行号补一条 doc-coords 那样的守卫」，
 * 所以它只需要分辨：坐标死没死。
 *
 * 判死之前先判【取材对不对】（0007 §4.1 / memory [[empty-output-is-not-a-clean-result]]）：
 * ① 命中总数为 0 ⇒ 打印 NO_HITS 并退非 0。上一版就是这个形状：正则字符类里的
 *    反斜杠被 shell heredoc 吃掉 ⇒ docs 过滤器恒不命中 ⇒ 报「0 条引用」，
 *    而真相是 161 条。空读数不是读数。
 * ② 正对照：同一台机器上必须能数到一条【已知存在】的引用（cli.ts 那一发）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SEP = /[\\/]/;

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "dist" || name === "coverage") {
      continue;
    }
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const all = walk(".", []);
const byName = new Map();
for (const p of all) {
  const b = p.split(SEP).pop();
  const list = byName.get(b);
  if (list) list.push(p);
  else byName.set(b, [p]);
}

// 取材：路径分段里含 "docs" 的 .md。不用 ^docs/ 那种前缀正则 ——
// Windows 下相对路径是 `docs\...`，前缀式在反斜杠上恒不命中（上一版的错因）。
const docs = all.filter((p) => p.split(SEP).includes("docs") && p.endsWith(".md"));
if (docs.length === 0) {
  console.log("NO_DOCS :: 取材就失败了，一个 .md 都没找到 —— 下面的任何读数都不成立。");
  process.exit(9);
}

const RE = /([a-zA-Z0-9_.-]+\.(?:ts|js|mjs)):(\d+)/g;
const seen = new Map();
let total = 0;
for (const d of docs) {
  const src = readFileSync(d, "utf8");
  let m;
  RE.lastIndex = 0;
  while ((m = RE.exec(src))) {
    total++;
    const cite = m[0];
    if (!seen.has(cite)) seen.set(cite, { file: m[1], line: Number(m[2]), docs: [] });
    seen.get(cite).docs.push(d);
  }
}
console.log("md files scanned: " + docs.length);
if (total === 0) {
  console.log("NO_HITS :: 引用总数为 0 ⇒ 是取材/正则坏了，不是「文档里没有行号引用」。");
  process.exit(9);
}

const lineCounts = new Map();
function linesOf(p) {
  let n = lineCounts.get(p);
  if (n === undefined) {
    n = readFileSync(p, "utf8").split(/\r?\n/).length;
    lineCounts.set(p, n);
  }
  return n;
}

let ok = 0;
let ambiguous = 0;
let missingFile = 0;
let beyondEof = 0;
const bad = [];
for (const [cite, v] of seen) {
  const cands = byName.get(v.file) ?? [];
  if (cands.length === 0) {
    missingFile++;
    bad.push("NO_FILE " + cite + "  (" + v.docs[0] + ")");
    continue;
  }
  const inRange = cands.some((c) => v.line >= 1 && v.line <= linesOf(c));
  if (!inRange) {
    beyondEof++;
    bad.push(
      "BEYOND_EOF " + cite + " 行数=" + cands.map((c) => linesOf(c)).join("/") + " (" + v.docs[0] + ")",
    );
    continue;
  }
  if (cands.length > 1) ambiguous++;
  ok++;
}

console.log(
  JSON.stringify(
    {
      totalCitations: total,
      unique: seen.size,
      ok,
      ambiguousBasename: ambiguous,
      missingFile,
      beyondEof,
    },
    null,
    1,
  ),
);
// 正对照：cli.ts 那条已知存在的引用必须在 ok 里（否则「ok 很多」本身没被证明过）。
const canary = [...seen.keys()].filter((k) => k.startsWith("cli.ts:"));
console.log("canary cli.ts cites: " + canary.join(", "));
for (const b of bad) console.log(b);
