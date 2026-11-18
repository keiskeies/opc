// round289：把指向 `graph/company.ts` 那句话的坐标从过期行号搬回真实行号。
//
// 触发原因：我在 company.ts 里插了注释行 ⇒ 那句话往下漂，doc-refs 门禁红了两发
// （INDEX.md 与 0050 各一条，同一个 from=254）。
//
// 为什么用脚本而不是手改：SNAP 的键【含行号】，改文档必须同时改键，两边手抄就有
// 「一边改了另一边没改」；而这条守卫存在的理由正是【不许凭印象推行号】（0057 同一条教训）。
//
// 值不需要动：脚本先校验那句话的【内容一字未变】，只有行号变了，所以只搬键里的数字。
// 内容若真被改过，这个前提不成立 ⇒ 搬行号是错的修法，脚本当场抛，而不是把快照悄悄抄成新的。
// ⚠ 本文件是 .mjs，里面不许有 TS 标注。
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const TARGET = "packages/hub/src/graph/company.ts";
const SENTENCE = 'if (state.current === "REJECTED_DOWNWARD") await write("IN_PROGRESS");';
// 每次用都新建一个：同一带 g 标志的实例在 .test() 之后 lastIndex 不为 0，
// 下一次 .test()/.matchAll() 会从中间继续 —— 第一版我就这么写出了「引用点少打一条」的假证据。
const fileG = () => /graph\/company\.ts:(\d+)/g;

const text = (rel) => readFileSync(join(ROOT, rel), "utf8");

const docFiles = (() => {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p.slice(ROOT.length + 1).replaceAll("\\", "/"));
    }
  };
  walk(join(ROOT, "docs"));
  return out.filter((p) => p.endsWith(".md"));
})();

const hits = text(TARGET)
  .split(/\r?\n/)
  .map((l, i) => [l.trim(), i + 1])
  .filter(([l]) => l === SENTENCE)
  .map(([, n]) => n);
if (hits.length !== 1) {
  throw new Error(`那句话在目标文件里出现 ${hits.length} 次 ⇒ 行号不唯一，人工判断`);
}
const actual = hits[0];

const corpus = [...docFiles, "test/arch/doc-refs.test.ts"];
const targets = corpus.filter((rel) => fileG().test(text(rel)));
const found = targets.flatMap((rel) => [...text(rel).matchAll(fileG())].map((m) => [rel, Number(m[1])]));
console.log(`目标句现在在 ${TARGET}:${actual}`);
console.log("引用点：\n" + found.map(([r, n]) => `  ${r} -> :${n}`).join("\n"));

// 前提校验：SNAP 里那两条键的值【仍然】等于那句话本身。
const guardSrc = text("test/arch/doc-refs.test.ts");
for (const key of [
  "INDEX.md",
  "0050-abandoned-task-never-resumes-and-a-knob-that-does-not-exist.md",
]) {
  const at = guardSrc.indexOf('"' + key + ">graph/company.ts:");
  if (at === -1) throw new Error("SNAP 里没有 " + key + " 那条键");
  const raw = guardSrc.slice(at).split(/\r?\n/)[1].trim().replace(/,$/, "");
  const body = raw.slice(1, -1);
  const val = raw.startsWith("'") ? body : body.replace(/\\"/g, '"');
  if (val !== SENTENCE) {
    throw new Error("快照值已经不是那句话了：[" + raw + "] ⇒ 内容被改过，搬行号是错的修法");
  }
}

let changed = 0;
for (const rel of targets) {
  const src = text(rel);
  const next = src.replace(fileG(), (m, d) => m.replace(d, String(actual)));
  if (next === src) {
    console.log("  = " + rel + "（已经是真实行）");
    continue;
  }
  const count = (s) => s.split(/\r?\n/).filter((l) => fileG().test(l)).length;
  const before = count(src);
  writeFileSync(join(ROOT, rel), next);
  const after = count(next);
  changed += 1;
  console.log("  ✎ " + rel + "：含坐标的行 " + before + " -> " + after);
}
if (changed === 0) {
  console.log("什么都不用改");
  process.exit(0);
}

// 自我校验：重跑一遍扫描，期望 0 处过期。
const still = corpus
  .flatMap((rel) => [...text(rel).matchAll(fileG())].map((m) => [rel, Number(m[1])]))
  .filter(([, n]) => n !== actual);
console.log(still.length === 0 ? "复检：0 处过期 ✅" : "复检：仍有 " + still.length + " 处过期 ❌");
if (still.length > 0) process.exit(1);
