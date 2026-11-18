// round288 探针：docs/INDEX.md 里那 24 条完整形态引用，现在指向什么。
//
// 为什么要先探再决定接不接：doc-refs 的语料今天覆盖 decisions/*.md + 主设计文档，
// 而 INDEX 也有 24 条同样形状的引用，一条都没有读者。但"接进来"不是免费的 ——
// 每条活引用都要登记一条快照，而快照的值必须【逐字从目标行抄】。
// 所以这一发先回答两件可判的事：① 有多少条今天【本来就坏的】（那才是接进来的收益）；
// ② 有多少条要新登记（那是接进来的成本）。两者都打出来，再决定。
//
// ⚠ 口径照抄守卫，不自己发明：FILE_REF 与 resolveTarget 的歧义规则都按
//   test/arch/doc-refs.test.ts 里的实现写。自己另写一套 = 两个口径互相打脸
//   （本轮 51/50 那格刚记过这件事）。
import { readdirSync, readFileSync, statSync } from "node:fs";
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

/** 与 doc-refs.test.ts 的 resolveTarget 逐行同形。 */
function resolveTarget(file) {
  const direct = names.filter((p) => p === file || p.endsWith("/" + file));
  if (direct.length === 1) return direct[0];
  if (direct.length > 1) return undefined;
  const base = file.split("/").pop() ?? "";
  const byBase = names.filter((p) => p.endsWith("/" + base));
  return byBase.length === 1 ? byBase[0] : undefined;
}

const targets = process.argv.slice(2);
if (targets.length === 0) throw new Error("用法：node 本文件 <doc> [<doc> …]");

for (const doc of targets) {
  const lines = readFileSync(join(ROOT, doc), "utf8").split(/\r?\n/);
  const rows = [];
  lines.forEach((l, i) => {
    for (const m of l.matchAll(FILE_REF)) {
      rows.push({ docLine: i + 1, file: m[1], ln: Number(m[2]) });
    }
  });
  let bad = 0;
  const report = [];
  for (const r of rows) {
    const rel = resolveTarget(r.file);
    if (rel === undefined) {
      bad++;
      report.push({ kind: "找不到/歧义", r, txt: "" });
      continue;
    }
    const src = readFileSync(join(ROOT, rel), "utf8").split(/\r?\n/);
    if (r.ln < 1 || r.ln > src.length) {
      bad++;
      report.push({ kind: "越界", r, txt: "文件只有 " + src.length + " 行" });
      continue;
    }
    const txt = (src[r.ln - 1] ?? "").trim();
    if (txt === "") {
      bad++;
      report.push({ kind: "空行", r, txt: "" });
      continue;
    }
    report.push({ kind: "OK", r, txt });
  }
  console.log(
    "\n" + doc + "  size=" + statSync(join(ROOT, doc)).size + "B",
  );
  console.log("  引用 " + rows.length + " 条 ⇒ 坏的 " + bad + " / 要新登记快照的 " + rows.filter((_, i) => report[i].kind === "OK").length);
  for (const x of report) {
    if (x.kind === "OK") continue;
    console.log(
      "  ✗ " + x.kind + "  " + x.r.file + ":" + x.r.ln +
        " (doc:" + x.r.docLine + ")" + (x.txt ? "  " + x.txt : ""),
    );
  }
  const sample = report.filter((x) => x.kind === "OK").slice(0, 6);
  if (sample.length) {
    console.log("  前 " + sample.length + " 条 OK 的样子（快照要抄的就是这个）：");
    for (const x of sample) console.log("     " + x.txt.slice(0, 96));
  }
}
