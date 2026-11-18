// round288 · 把 docs/INDEX.md 的活引用【机械生成】成 doc-refs 的 SNAP 条目。
//
// 为什么生成而不手抄：快照的值要求逐字等于目标行（守卫比的是 trim 后的整行）。
// 23 条手抄 = 23 次打错字的机会，而打错的快照比没有快照更坏 —— 它会让守卫恒红，
// 或者更坏：让守卫把「引用漂到了另一行」读成「代码变了」，去改代码。
// 判断留在坐标里（哪条引用该钉），值由目标文件自己给。
//
// 口径照抄 test/arch/doc-refs.test.ts：FILE_REF、resolveTarget、trim 规则都按守卫写。
// 跑法：node .workbuddy/round288-index-snap-gen.mjs docs/INDEX.md
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

const docs = process.argv.slice(2);
if (docs.length === 0) throw new Error("用法：node 本文件 <doc> …");

for (const doc of docs) {
  const short = doc.split("/").pop();
  const lines = readFileSync(join(ROOT, doc), "utf8").split(/\r?\n/);
  const entries = new Map();
  const skipped = [];
  lines.forEach((l, i) => {
    for (const m of l.matchAll(FILE_REF)) {
      const rel = resolveTarget(m[1]);
      const key = short + ">" + m[1] + ":" + m[2];
      if (rel === undefined) {
        skipped.push(key + " 找不到/歧义");
        continue;
      }
      const src = readFileSync(join(ROOT, rel), "utf8").split(/\r?\n/);
      const ln = Number(m[2]);
      const txt = (src[ln - 1] ?? "").trim();
      if (txt === "") {
        skipped.push(key + " 空行/越界（" + rel + " 有 " + src.length + " 行）");
        continue;
      }
      if (!entries.has(key)) entries.set(key, { txt, rel });
    }
  });
  const out = [];
  let weak = 0;
  for (const [key, v] of [...entries.entries()].sort()) {
    if (v.txt.length < 12) weak++;
    out.push(
      '  "' + key + '":\n    ' + JSON.stringify(v.txt) + ",   // → " + v.rel,
    );
  }
  console.log("// " + doc + "：活引用 " + entries.size + " 条唯一键，跳过 " + skipped.length + " 条");
  for (const s of skipped) console.log("//   跳过 " + s);
  console.log("// 其中目标行短于 12 字符（快照几乎不含信息）的 " + weak + " 条");
  console.log(out.join("\n"));
  console.log("  // 共 " + entries.size + " 条");
}
