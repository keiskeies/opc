// round274：lint 基线棘轮的变异证据（自恢复）。
//
// 三发，各打一条这一轮新立的判据。跑法是每发单独 apply → 跑 test/arch/lint-baseline.test.ts
// → 记下哪几发红 → revert。为什么要变异：守卫的真仓库那一发今天必然绿（数就是照着今天写的），
// 它证明不了「数变坏时会红」—— 那句话只有变异能买。
//
//  M1 删掉 isRuntimeFixture 那两行排除
//     ⇒ 预期：只有「运行期夹具探针不进基线」那一发红。
//       这一发同时是给「探针会污染基线」那个实测读数做对照：不排除时并发跑会随机红。
//  M2 把「只数 error」那道过滤删掉（warning / info 也计进基线）
//     ⇒ 预期：「只数 error」红 + 真仓库那一发也红（109 warning 会冒出一堆基线外类目）。
//       这一发证明「只判 error」是一个**有后果的选择**，不是随手写的条件。
//  M3 把超阈值判据改成 n > allowed + 1000（棘轮被悄悄拔掉齿，表面目还在）
//     ⇒ 预期：「多一条 ⇒ 红」与「新类目 ⇒ 红」里前者红，真仓库那一发仍绿。
//       这一发最重要：它证明测试套件抓得住「有人把判据改成不判」。
//
// 用法：node .workbuddy/round274-lint-ratchet-mutate.mjs apply M1|M2|M3
//       node .workbuddy/round274-lint-ratchet-mutate.mjs revert
import { readFileSync, writeFileSync, rmSync } from "node:fs";

const FILE = "test/arch/lint-baseline.ts";

const MUTS = {
  M1: [
    "    if (isRuntimeFixture(name)) continue;",
    "    void name; // M1：排除被拔掉",
  ],
  M2: ['    if (d.severity !== "error") continue;', "    // M2：不再只看 error"],
  M3: ["    if (n > allowed) over.push(", "    if (n > allowed + 1000) over.push("],
};

const origin = (key) => ".workbuddy/round274-lint-orig-" + key + ".ts";

const cmd = process.argv[2];
if (cmd === "apply") {
  const key = process.argv[3];
  const m = MUTS[key];
  if (m === undefined) throw new Error("M1|M2|M3，实到 " + key);
  const src = readFileSync(FILE, "utf8");
  const n = src.split(m[0]).length - 1;
  if (n !== 1) throw new Error(key + " 锚点出现 " + n + " 次，不是恰好一次，拒绝施加");
  writeFileSync(origin(key), src);
  writeFileSync(FILE, src.replace(m[0], m[1]));
  console.log("已施加 " + key);
} else if (cmd === "revert") {
  let any = false;
  for (const key of Object.keys(MUTS)) {
    let orig;
    try {
      orig = readFileSync(origin(key), "utf8");
    } catch {
      continue;
    }
    writeFileSync(FILE, orig);
    if (readFileSync(FILE, "utf8") !== orig) {
      throw new Error(key + " 还原后逐字节核对失败");
    }
    any = true;
    console.log("已还原 " + key + " 并核对一致");
    // 核对通过才删原件：还原失败时原件必须留着，否则这一发的变异就永久烙在文件里了。
    rmSync(origin(key), { force: true });
  }
  if (!any) console.log("没有待还原的原件（本轮尚未 apply，或已还原过）");
} else {
  throw new Error("用法: apply M1|M2|M3 | revert");
}
