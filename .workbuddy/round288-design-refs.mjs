// round288 探针：docs/OPC-OS-功能优化设计.md 里的「完整形态 file:line」引用有没有读者？
//
// 为什么要写它：doc-refs 守卫的 decisionDocs() 只 readdirSync(docs/decisions)，
// 而主设计文档里同样写着 `file:line`。本轮在 §2 补修正块时顺手数了一下：5 条。
// 5 条今天【一条都没有快照】，也就是说它们是 60 多格快照所治的同一族里
// 唯一没被接进去的一组。这一发先把「它们现在指向什么」打出来，再决定要不要接。
//
// ⚠ 它不是守卫，也不该被当成守卫：它只打印【那一行现在写了什么】。
//   「那行内容是否与主张相符」是逐条人读的判断，机器判不了（判了就是又一个
//   「按字面量子串数」的假分母 —— round286 撞过三次的那族）。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const DOC = "docs/OPC-OS-功能优化设计.md";
const REF = /([A-Za-z0-9_@./-]+\.(?:ts|tsx|mjs|yaml|sql|md|json)):(\d+)/g;
const SKIP = new Set(["node_modules", ".git", "dist", ".workbuddy"]);

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

/** 与 doc-refs 的 resolveTarget 同一套口径：尾段匹配 + 目录限定 + 歧义要报出来。 */
function resolveTarget(file) {
  const base = file.split("/").pop();
  const hits = names.filter((n) => {
    if (!n.endsWith(base)) return false;
    if (base === n) return true;
    return n.endsWith("/" + file) || n === file;
  });
  const exact = names.includes(file) ? [file] : [];
  const pool = exact.length > 0 ? exact : hits;
  return { pool, ambiguous: pool.length > 1 };
}

const text = readFileSync(join(ROOT, DOC), "utf8");
const lines = text.split(/\r?\n/);
const rows = [];
for (let i = 0; i < lines.length; i++) {
  for (const m of lines[i].matchAll(REF)) {
    rows.push({ docLine: i + 1, file: m[1], ln: Number(m[2]) });
  }
}

let missing = 0;
let ambiguous = 0;
let empty = 0;
for (const r of rows) {
  const { pool, ambiguous: amb } = resolveTarget(r.file);
  if (pool.length === 0) {
    missing++;
    console.log(`MISSING  ${r.file}:${r.ln}  (doc:${r.docLine}) 仓库里找不到`);
    continue;
  }
  if (amb) {
    ambiguous++;
    console.log(
      `AMBIG    ${r.file}:${r.ln}  (doc:${r.docLine}) 命中 ${pool.length} 个：${pool.join(" , ")}`,
    );
    continue;
  }
  const src = readFileSync(join(ROOT, pool[0]), "utf8").split(/\r?\n/);
  if (r.ln < 1 || r.ln > src.length) {
    missing++;
    console.log(
      `OUT-OF-RANGE ${pool[0]}:${r.ln}  文件只有 ${src.length} 行  (doc:${r.docLine})`,
    );
    continue;
  }
  const content = (src[r.ln - 1] ?? "").trim();
  if (content === "") empty++;
  console.log(
    `${content === "" ? "EMPTY   " : "OK      "} ${pool[0]}:${r.ln}  (doc:${r.docLine})\n          现文: ${content.slice(0, 110)}`,
  );
}

console.log(
  `\n合计 ${rows.length} 条引用 ⇒ OK ${rows.length - missing - ambiguous - empty} / ` +
    `找不到或越界 ${missing} / 歧义 ${ambiguous} / 空行 ${empty}`,
);
console.log(
  "\n对照：doc-refs.test.ts 的 decisionDocs() 只扫 docs/decisions/*.md ⇒ 上面这些【一条都不在】它的扫描范围里。",
);
console.log(
  "读者存在性核对：" +
    (readdirSync(join(ROOT, "test/arch")).includes("doc-refs.test.ts")
      ? "doc-refs.test.ts 在场"
      : "⚠ doc-refs.test.ts 不在场") +
    `，其 decisionDocs() 覆盖 ${
      readdirSync(join(ROOT, "docs/decisions")).filter((f) => f.endsWith(".md"))
        .length
    } 篇 decisions/*.md（不含主设计文档，${
      statSync(join(ROOT, DOC)).size
    } 字节）`,
);
