import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
const PLAN = "docs/superpowers/plans/2026-11-06-opc-os-development-plan.md";
const md = readFileSync(PLAN, "utf8");

// 仓库里的全部文件（posix 相对路径），用来判断「同一个文件名在不在别处」。
const all: string[] = [];
const walk = (dir: string) => {
  for (const e of readdirSync(dir === "" ? "." : dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
    const p = dir === "" ? e.name : dir + "/" + e.name;
    if (e.isDirectory()) walk(p);
    else all.push(p);
  }
};
walk("");
const byName = new Map<string, string[]>();
for (const p of all) byName.set(basename(p), [...(byName.get(basename(p)) ?? []), p]);

const paths = new Set<string>();
for (
  const m of md.matchAll(
    /`([A-Za-z0-9_@./-]+\/[A-Za-z0-9_.\/-]+\.(?:ts|tsx|mjs|json|sql|md|yaml|yml))`/g,
  )
)
  paths.add(m[1]!);

const exact: string[] = [];
const moved: Array<[string, string]> = [];
const absent: string[] = [];
for (const p of [...paths].sort()) {
  if (existsSync(p)) exact.push(p);
  else if ((byName.get(basename(p)) ?? []).length > 0)
    moved.push([p, byName.get(basename(p))![0]!]);
  else absent.push(p);
}
console.log(
  "计划里点名的文件路径:",
  paths.size,
  "| 逐字命中:",
  exact.length,
  "| 名字在但住址变了:",
  moved.length,
  "| 全仓查无此物:",
  absent.length,
);
console.log("\n── 住址变了（计划写的是【落地前】的布局，东西后来搬了家）──");
for (const [p, real] of moved.slice(0, 12)) console.log("  " + p + "  →  " + real);
console.log("  …共 " + moved.length + " 条");
console.log("\n── 全仓查无此物 ──");
for (const p of absent) console.log("  " + p);
