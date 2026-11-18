// round290：量一个【还没人判】的形状 —— 源码注释里点名「红的是 xxx.test.ts」，
// 而那个测试文件到底在不在。
//
// 为什么先量再建门禁：round282 那条 bug 的形状是「feishu.ts 的文件头与形状表都写着
// 『字段变了红的是 feishu.test.ts』，而那个文件当时不存在」⇒ 一张表没有读者，
// 漂移一路绿到真发请求。今天若还有第二处，那是【现成的真缺陷】；若 0 处，
// 这道门禁的价值只剩【防未来】。两种结论决定值不值得加，所以必须先有分母，
// 不能先写守卫再祈祷它绿。
//
// 只取注释（AST trivia），不取全文：doc-refs 与 comment-citations 两条守卫都记过同一理由
// —— 扫全文会把 fixture 里「看着像引用」的数据当引用。
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const DIRS = ["packages", "test", "apps", "resources"];
const SEP = String.fromCharCode(47);

function tsFiles(dir) {
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (/\.(ts|tsx|mts)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 注释行（带原行号），口径【照搬】test/arch/comment-citations.ts 的 commentLines。 */
function commentLines(text) {
  const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
  const spans = new Map();
  const add = (a) => {
    if (a === undefined) return;
    for (const c of a) spans.set(c.pos, c.end);
  };
  const walk = (n) => {
    add(ts.getLeadingCommentRanges(text, n.getFullStart()));
    add(ts.getTrailingCommentRanges(text, n.getEnd()));
    n.forEachChild(walk);
  };
  walk(sf);
  const out = [];
  for (const [pos, end] of spans) {
    const startLine = text.slice(0, pos).split("\n").length;
    const parts = text.slice(pos + 2, end).split("\n");
    for (let k = 0; k < parts.length; k++) {
      const t = String(parts[k]).replace(/^\s*[*]?\s?/, "").trim();
      if (t.length > 0) out.push({ line: startLine + k, text: t });
    }
  }
  return out;
}

const allFiles = DIRS.flatMap((d) => tsFiles(join(ROOT, d))).map((p) =>
  p.slice(ROOT.length + 1).split("\\").join(SEP),
);
const baseHits = new Map();
for (const rel of allFiles) {
  if (!rel.endsWith(".test.ts")) continue;
  const b = rel.split(SEP).pop();
  baseHits.set(b, [...(baseHits.get(b) ?? []), rel]);
}

const NAME = /\b([A-Za-z0-9][A-Za-z0-9._-]*\.test\.tsx?)\b/g;
const refs = [];
for (const rel of allFiles) {
  const text = readFileSync(join(ROOT, rel), "utf8");
  for (const c of commentLines(text)) {
    for (const m of c.text.matchAll(NAME)) {
      refs.push({ from: rel + ":" + c.line, name: m[1], snippet: c.text.trim().slice(0, 120) });
    }
  }
}

const broken = refs.filter((r) => !baseHits.has(r.name));
console.log(`扫了 ${allFiles.length} 个 .ts，注释里点名 *.test.ts 共 ${refs.length} 处`);
console.log(`其中【仓库里找不到同名测试文件】的：${broken.length} 处`);
for (const b of broken) console.log(`  x ${b.from} -> ${b.name}\n      「${b.snippet}」`);

// 同名歧义也要说出来：注释只写基名，而仓库里有两份同名测试文件时，
// 「红的是 x.test.ts」这句指的是哪一份？（doc-refs 那条守卫记过的同一条坑）
const amb = refs.filter((r) => (baseHits.get(r.name) ?? []).length > 1);
console.log(`同名歧义（基名命中多份）：${amb.length} 处`);
for (const a of amb.slice(0, 8)) {
  console.log(`  ? ${a.from} -> ${a.name} 命中 ${baseHits.get(a.name).join(" , ")}`);
}
