// 一次性对账：注释里的「计划 Task X.Y」引用 vs 计划文档里真实存在的小节标题。
// ⚠ 不用 grep/child_process：本仓守卫链里同类脚本一律用 fs 自己走目录，
//   一来 Windows 上 `/bin/bash.exe` 直接 ENOENT（第一版就撞在这），
//   二来 exec 的 shell 字符串对这种纯读文件的活儿是多余的攻击面。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const plan = readFileSync(
  "docs/superpowers/plans/2026-11-06-opc-os-development-plan.md",
  "utf8",
);
const have = new Set(
  [...plan.matchAll(/^###\s+Task\s+([0-9]+\.[0-9]+[a-z]*)/gm)].map((m) => m[1]),
);

const files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "poc") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".ts")) files.push(p);
  }
};
for (const root of ["packages", "test"]) {
  if (statSync(root).isDirectory()) walk(root);
}

const refs = new Map();
for (const f of files) {
  for (const m of readFileSync(f, "utf8").matchAll(/Task ([0-9]+\.[0-9]+[a-z]*)/g)) {
    refs.set(m[1], (refs.get(m[1]) ?? 0) + 1);
  }
}

const missing = [...refs]
  .filter(([k]) => !have.has(k))
  .sort((a, b) => b[1] - a[1]);
console.log("计划里的 Task 小节标题数:", have.size);
console.log("注释里出现的不同 Task 号:", refs.size);
console.log("引用总次数:", [...refs.values()].reduce((a, b) => a + b, 0));
console.log("--- 指向【计划里不存在的小节】---");
for (const [k, n] of missing) console.log("  Task " + k + " 被引用 " + n + " 次");
if (missing.length === 0) console.log("  （无）");
console.log(
  "--- 计划里有标题但注释从不引用 ---",
  [...have]
    .filter((h) => !refs.has(h))
    .join(", ") || "（无）",
);
