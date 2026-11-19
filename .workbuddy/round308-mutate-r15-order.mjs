/**
 * round308 · 「顺序」那一发的供电检查。
 *
 * claims-registry.test.ts 里「变异 r15 之九」钉的是：名单坏了【同时】取材也空 ⇒
 * 红因必须是「不可信」（取材问题）而不是「名单」（主张问题）。它在正确顺序下绿。
 * 但绿可能是【恒绿】：如果那道兜底根本没在拦，之九 也该红。这一台就是去把兜底
 * 短路成 false（字节留着、永远走不到 —— r22 的 M8 同一招），之九 必须翻红。
 *
 * 用法：npx tsx .workbuddy/round308-mutate-r15-order.mjs（单独跑，会临时改工作树）
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(ROOT, "test", "arch", "claims-registry.ts");
const ORIGINAL = readFileSync(TARGET, "utf8");
const ANCHOR = "if (web + pub + desktop < 5) {";

function run(nameFilter) {
  const r = spawnSync(
    "npx",
    ["vitest", "run", "test/arch/claims-registry.test.ts", "-t", nameFilter],
    { cwd: ROOT, encoding: "utf8", shell: true },
  );
  return { red: r.status !== 0, out: (r.stdout || "") + (r.stderr || "") };
}

const rows = [];
try {
  // 控制组：一字不改，之九 该绿。
  const ctrl = run("之九");
  rows.push({ id: "C0 控制（该绿）", want: false, got: ctrl.red });

  // 变异：兜底短路成 false —— 字节全留着，永远走不到。
  const mutated = ORIGINAL.replace(
    ANCHOR,
    "if (false && web + pub + desktop < 5) { // MUTANT",
  );
  if (mutated === ORIGINAL) throw new Error(`锚点没匹到：${ANCHOR}`);
  writeFileSync(TARGET, mutated);
  const m1 = run("之九");
  rows.push({ id: "M1 兜底短路成 false（该红）", want: true, got: m1.red });
  // 顺带：红因要落在名单那一格（证明是它抢了报，不是别的）。
  const reasonOk = /名单里 add_edge/.test(m1.out.replace(/\u001b\[[0-9;]*m/g, ""));
  rows.push({ id: "M1 的红因 = 名单抢报", want: true, got: reasonOk });
} finally {
  writeFileSync(TARGET, ORIGINAL);
}

let bad = 0;
for (const r of rows) {
  const hit = r.want === r.got;
  if (!hit) bad++;
  console.log(`${hit ? "✔" : "✘"} ${r.id}：期望${r.want ? "红" : "绿"}，实际${r.got ? "红" : "绿"}`);
}
console.log(`还原逐字节一致=${readFileSync(TARGET, "utf8") === ORIGINAL}`);
process.exit(bad === 0 ? 0 : 1);
