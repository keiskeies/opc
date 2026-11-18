// round269 O9 动作 1 影子判定的变异证据（自恢复）。
//
// 三发变异，各打一条新判据：
//  M1 policy_shadow: policyShadowOf(r) ⇒ null（读数死字段）
//     ⇒ query.test ⑦(甲) 红；r7 仍绿（autoApprove( 文本还在 ⇒ 判据不能只认文本）。
//  M2 explicitIrreversible 恒 false（短路失效，不可逆卡掉进 summary 估算）
//     ⇒ query.test ⑦(乙) 红 —— 阴性样本不能建在子串表上，这条红的就是那件事。
//  M3 写路径越界：query.ts 里出现 recordAutoApproval 的真实 import + 调用
//     ⇒ r7 红 + auto-approve.test ⑧ 写者名单红 + query.test ⑦(丙) 红。
//
// 用法：node .workbuddy/round269-o9-shadow-mutate.mjs apply M1|M2|M3
//       node .workbuddy/round269-o9-shadow-mutate.mjs revert
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "packages/hub/src/approvals/query.ts";
const ORIGIN = ".workbuddy/round269-o9-shadow-orig.ts";

const MUTS = {
  M1: [
    "    policy_shadow: policyShadowOf(r),",
    "    policy_shadow: null,",
  ],
  M2: [
    '  return (parsed as Record<string, unknown>)["irreversible"] === true;',
    "  void parsed;\n  return false;",
  ],
  M3: [
    'import { autoApprove } from "../policy/auto-approve.js";',
    'import { autoApprove, recordAutoApproval } from "../policy/auto-approve.js";\nexport const _o9Phase2Leak = (db: never, o: never): void => void recordAutoApproval(db, o);',
  ],
};

const cmd = process.argv[2];
if (cmd === "apply") {
  const key = process.argv[3];
  const m = MUTS[key];
  if (m === undefined) throw new Error("M1|M2|M3，实到 " + key);
  const src = readFileSync(FILE, "utf8");
  const n = src.split(m[0]).length - 1;
  if (n !== 1) throw new Error(key + " 锚点出现 " + n + " 次，不是恰好一次，拒绝施加");
  writeFileSync(ORIGIN, src);
  writeFileSync(FILE, src.replace(m[0], m[1]));
  console.log("已施加 " + key);
} else if (cmd === "revert") {
  const orig = readFileSync(ORIGIN, "utf8");
  writeFileSync(FILE, orig);
  if (readFileSync(FILE, "utf8") !== orig) throw new Error("还原后逐字节核对失败");
  console.log("已还原并核对一致");
} else {
  throw new Error("用法: apply M1|M2|M3 | revert");
}
