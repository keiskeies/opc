// round288 · 「还有哪份文档写了坐标却没有读者」——把缺口从【逐份补】变成【可判】。
//
// 为什么现在写它：这一族我已经连着补了三级（decisions/*.md 一直有 → 主设计文档 → INDEX）。
// 每一级的动作都是「发现一份文档没进语料 ⇒ 手工加一个键」。手工加的语料表下一次一定再漏：
// 没有任何东西判【漏】这件事。本探针回答可判的那半 —— docs/ 下（含子目录）每一份 .md，
// 有多少条完整形态坐标、它在不在 doc-refs 的语料里。
//
// 口径：FILE_REF 与 resolveTarget 照抄 test/arch/doc-refs.test.ts，不自己发明。
// 跑法：node .workbuddy/round288-corpus-gap.mjs
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const FILE_REF =
  /([A-Za-z0-9_./-]+[.](?:ts|tsx|mts|cts|js|mjs|cjs|md|sql))[:]([0-9]+)/g;
const SKIP = new Set(["node_modules", ".git", ".tmp", "dist"]);

function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(relative(ROOT, p).split(sep).join("/"));
  }
  return out;
}
const names = walk(ROOT, []).sort();
function resolveTarget(file) {
  const direct = names.filter((p) => p === file || p.endsWith("/" + file));
  if (direct.length === 1) return direct[0];
  if (direct.length > 1) return undefined;
  const base = file.split("/").pop() ?? "";
  const byBase = names.filter((p) => p.endsWith("/" + base));
  return byBase.length === 1 ? byBase[0] : undefined;
}

// 语料 = decisionDocs() 今天实际读到的那些：docs/decisions/*.md + 两个手写键。
const covered = new Set();
for (const f of readdirSync(join(ROOT, "docs", "decisions"))) {
  if (f.endsWith(".md")) covered.add(f);
}
covered.add("OPC-OS-功能优化设计.md");
covered.add("INDEX.md");

const md = walk(join(ROOT, "docs"), []).filter((p) => p.endsWith(".md"));
let withRefs = 0;
let uncoveredWithRefs = 0;
const rows = [];
for (const p of md.sort()) {
  const short = p.split("/").pop();
  const text = readFileSync(join(ROOT, p), "utf8");
  const refs = [];
  for (const l of text.split(/\r?\n/)) {
    for (const m of l.matchAll(FILE_REF)) refs.push({ file: m[1], ln: Number(m[2]) });
  }
  if (refs.length === 0) continue;
  withRefs++;
  const cov = covered.has(short);
  // 只在【没覆盖】时才付解析成本：坏条数决定接进来的收益。
  let bad = -1;
  if (!cov) {
    bad = 0;
    for (const r of refs) {
      const rel = resolveTarget(r.file);
      if (rel === undefined) bad++;
      else {
        const src = readFileSync(join(ROOT, rel), "utf8").split(/\r?\n/);
        if (r.ln < 1 || r.ln > src.length || (src[r.ln - 1] ?? "").trim() === "") bad++;
      }
    }
  }
  if (!cov) uncoveredWithRefs++;
  rows.push({ p, n: refs.length, cov, bad });
}

console.log("docs/ 下 .md 共 " + md.length + " 份");
console.log("含完整形态坐标的 " + withRefs + " 份，其中【不在 doc-refs 语料里】的 " + uncoveredWithRefs + " 份\n");
console.log("路径" + " ".repeat(52) + "引用  覆盖  其中坏的");
for (const r of rows) {
  console.log(
    r.p.padEnd(60) +
      String(r.n).padStart(4) +
      "  " +
      (r.cov ? "有读者" : "无读者") +
      "  " +
      (r.bad < 0 ? "—" : r.bad),
  );
}
const gap = rows.filter((r) => !r.cov);
console.log(
  "\n无读者且含坐标的文档 " + gap.length + " 份；它们的坏坐标合计 " +
    gap.reduce((a, r) => a + (r.bad < 0 ? 0 : r.bad), 0) + " 条。",
);
