// round276：门禁住址守卫的变异证据（自恢复）。
//
// 这一轮的变异【打在真文档上】，不是合成夹具 —— 因为这一发的全部价值就是
// 「计划里那条路径今天不存在，而它的验收命令今天绿」。只有把文档改回那个坏样子，
// 才能证明守卫真的会响。跑法同前：apply → 跑 plan-gate-paths.test.ts → revert。
//
//  G1 把 Task 1.8 那条 Run 的住址改回【本轮修之前】的旧写法（不带 packages/hub 前缀）
//     ⇒ 预期：真仓库那一发红（点名该路径）+ 「本轮修的三处住址」那一发也红。
//       这一发就是本轮真实故障的原样回放 —— 它必须红，否则整个守卫白做。
//  G2 把 Task 2.9 的豁免标记删掉（东西没建这件事仍在，但不再显式登记）
//     ⇒ 预期：真仓库那一发红，红话点名 test/e2e/ceo-loop.spec.ts。
//       它钉的是「豁免是显式可撤销的」，不是「写过一段说明就算数」。
//  G3 把豁免标记【多贴一行】到一个所有路径都存在的验收行上（凑数式豁免）
//     ⇒ 预期：「豁免是可数的账」那一发红（条数超上限 + 那条豁免没真的豁免掉任何东西）。
//  G4 把判据里的 existsSync 换成【一律返回 true】（住址判据被悄悄拔掉）
//     ⇒ 预期：合成那几发红，真仓库那几发仍绿。同 round274-M3 的形状：
//       真仓库那一发对「判据被改成不判」是瞎的，只有合成读数抓得住。
//
// 用法：node .workbuddy/round276-gate-path-mutate.mjs apply G1|G2|G3|G4
//       node .workbuddy/round276-gate-path-mutate.mjs revert
import { readFileSync, writeFileSync, rmSync } from "node:fs";

const PLAN = "docs/superpowers/plans/2026-11-06-opc-os-development-plan.md";
const JUDGE = "test/arch/plan-gate-paths.ts";

const MUTS = {
  G1: [
    PLAN,
    "`packages/hub/test/acceptance/phase1-gates.test.ts` 三条通过",
    "`test/acceptance/phase1-gates.test.ts` 三条通过",
  ],
  G2: [
    PLAN,
    "见优化设计文档 §7 第 10 格与台账 round274 账 ④。<!-- gate-path-not-built -->】",
    "见优化设计文档 §7 第 10 格与台账 round274 账 ④。】",
  ],
  G3: [
    PLAN,
    "- **Run**：`pnpm test packages/hub/test/db/driver-preflight.test.ts`",
    "- **Run**：`pnpm test packages/hub/test/db/driver-preflight.test.ts` <!-- gate-path-not-built -->",
  ],
  G4: [
    JUDGE,
    "      if (!exists(p)) out.push({ lineNo: b.lineNo, path: p });",
    "      if (!true) out.push({ lineNo: b.lineNo, path: p });",
  ],
};

const origin = (key) => ".workbuddy/round276-orig-" + key + ".txt";

const cmd = process.argv[2];
if (cmd === "apply") {
  const key = process.argv[3];
  const m = MUTS[key];
  if (m === undefined) throw new Error("G1|G2|G3|G4，实到 " + key);
  const [file, from, to] = m;
  const src = readFileSync(file, "utf8");
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error(key + " 锚点出现 " + n + " 次，不是恰好一次，拒绝施加");
  writeFileSync(origin(key), src);
  writeFileSync(file, src.replace(from, to));
  console.log("已施加 " + key + " 于 " + file);
} else if (cmd === "revert") {
  let any = false;
  for (const key of Object.keys(MUTS)) {
    let orig;
    try {
      orig = readFileSync(origin(key), "utf8");
    } catch {
      continue;
    }
    writeFileSync(MUTS[key][0], orig);
    if (readFileSync(MUTS[key][0], "utf8") !== orig) {
      throw new Error(key + " 还原后逐字节核对失败");
    }
    any = true;
    console.log("已还原 " + key + " 并核对一致");
    rmSync(origin(key), { force: true });
  }
  if (!any) console.log("没有待还原的原件（本轮尚未 apply，或已还原过）");
} else {
  throw new Error("用法: apply G1|G2|G3|G4 | revert");
}
