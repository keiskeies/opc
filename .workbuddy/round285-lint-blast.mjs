// round285 · 「lint 修绿」这一格【要问 CEO】—— 这条探针把「该问什么」变成可数的东西。
// 跑法：npx tsx .workbuddy/round285-lint-blast.mjs
//
// 为什么不是直接 `biome check --write .`：format / organizeImports 一次会动上百份文件
// （本轮现数 169 份 —— 见下面那行「涉及的文件数」；仓里另一处历史叙述写过「200+ 文件」，
// 那是把【诊断条数 281】当成【文件数】读了，单位错。这一发存在的理由之一就是把单位钉死）。
// 而现在工作区有一大片【未提交】改动。排版混进那堆 diff 里之后，没人能读出哪一行是真改动。
// 于是真正要问的不是「修不修」，是「先 commit 再全仓修，还是先只修一部分」。
// 「只修一部分」里最安全的一刀，就是【只修那些这轮本来就被改过、diff 反正要重看】的文件 ——
// 这一发量的正是那一刀有多大。
//
// ⚠ 计数单位：format / organizeImports 是【一份文件一条】诊断（`start.line` 实测恒为 0），
// 所以下面所有数都是【文件数】，不是行数。
import { spawnSync } from "node:child_process";
import { findBiomeBinary } from "../test/arch/lint-baseline.ts";

const CATEGORIES = new Set(["format", "assist/source/organizeImports"]);
const biome = findBiomeBinary(process.cwd());

const chk = spawnSync(biome, ["check", ".", "--reporter=json", "--max-diagnostics=100000"], {
  cwd: process.cwd(),
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
});
const json = JSON.parse(String(chk.stdout));
const bad = new Set();
for (const d of json.diagnostics ?? []) {
  if (d.severity !== "error" || !CATEGORIES.has(d.category)) continue;
  const p = String(d.location.path).split("\\").join("/");
  if (p.includes("node_modules/")) continue;
  bad.add(p);
}

const read = (args) =>
  new Set(
    spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8" })
      .stdout.split("\n")
      .map((s) => s.trim().replace(/^"|"$/g, ""))
      .filter(Boolean),
  );
const modified = read(["diff", "--name-only", "HEAD"]);
const untracked = read(["ls-files", "--others", "--exclude-standard"]);
const dirty = new Set([...modified, ...untracked]);

const inDirty = [...bad].filter((p) => dirty.has(p));
const inClean = [...bad].filter((p) => !dirty.has(p));

console.log("biome error 合计（全类目）:", json.summary?.errors);
console.log("format / organizeImports 涉及的文件数:", bad.size);
console.log("  ├─ 在【已改动/未跟踪】文件里（这一刀可修，不新增盲区）:", inDirty.length);
console.log("  └─ 在【干净】文件里（要动就得整份重排别人的代码）:", inClean.length);
console.log("工作区：已改", modified.size, "+ 未跟踪", untracked.size);
console.log("\n干净那一批里排前的（示例，最多 15 条）：");
for (const p of inClean.slice(0, 15)) console.log("  " + p);
console.log(
  "\n⚠ 这条探针不修任何东西。它只回答一句：「先只修已改动的那批」这一刀 = 少 " +
    inDirty.length +
    " 条上限，且不需要碰任何一份干净文件。",
);
