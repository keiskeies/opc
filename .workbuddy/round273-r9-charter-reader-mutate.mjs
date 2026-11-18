// round273 r9（岗位书字段的读者 = 提示词渲染）的变异证据（自恢复）。
//
// 三发，各打一条这一轮新立的判据，其中 M3 是【故意去打判据的盲区】：
//  M1 把 charter/prompt.ts 里 `c.forbiddenActions` 换成 `[]`（字段不再被读，渲染少一格）
//     ⇒ 预期：r9 判据红（字段级那一半）+ prompt.test.ts 那一发「全文里有『禁止动作』」红。
//  M2 把 engine/runtime.ts 里 `renderCharterPrompt(…)` 的调用摘掉（渲染函数还在、没人调）
//     ⇒ 预期：r9 判据红（调用那一半）+ engine/runtime.test.ts 红。
//     这一发是 r9 两半分工的证据：字段级判据对它【全绿】，所以只看字段会漏掉整个岗位书。
//  M3 【纯重构】把 `c.acceptanceCriteria` 改成解构别名 `acceptanceCriteria`（行为逐字节不变）
//     ⇒ 预期：r9 判据【红】而所有执行测试【全绿】。这不是判据坏了，是它判的就是文本：
//     红的时候该做的是把判据的 needle 一起改（就像 r1 那条「SQL 挪到第三个模块也红」）。
//     量它是因为【不量的话就没人知道这条判据会因重构而红】—— 那正是本仓反复登记的
//     「一条判据的边界没写下来，下一个人只能靠猜」。
//
// 用法：node .workbuddy/round273-r9-charter-reader-mutate.mjs apply M1|M2|M3
//       node .workbuddy/round273-r9-charter-reader-mutate.mjs revert
import { readFileSync, writeFileSync } from "node:fs";

const PROMPT = "packages/hub/src/charter/prompt.ts";
const RUNTIME = "packages/hub/src/engine/runtime.ts";

const MUTS = {
  M1: [
    PROMPT,
    '"禁止动作（黑名单，运行时只能让它变长）：", c.forbiddenActions',
    '"禁止动作（黑名单，运行时只能让它变长）：", []',
  ],
  M2: [
    RUNTIME,
    '          : renderCharterPrompt(assertCharterShape(roleId, charter)).sections.join("\\n");',
    '          : (void renderCharterPrompt, NO_CHARTER_LINE);',
  ],
  M3: [
    PROMPT,
    `  const real = c.acceptanceCriteria.filter(
    (a) => !a.condition.includes(CHARTER_PLACEHOLDER_ACCEPTANCE),
  );
  const pending = real.length < c.acceptanceCriteria.length;`,
    `  const { acceptanceCriteria } = c;
  const real = acceptanceCriteria.filter(
    (a) => !a.condition.includes(CHARTER_PLACEHOLDER_ACCEPTANCE),
  );
  const pending = real.length < acceptanceCriteria.length;`,
  ],
};

const origin = (key) => ".workbuddy/round273-r9-orig-" + key + ".ts";

const cmd = process.argv[2];
if (cmd === "apply") {
  const key = process.argv[3];
  const m = MUTS[key];
  if (m === undefined) throw new Error("M1|M2|M3，实到 " + key);
  const src = readFileSync(m[0], "utf8");
  const n = src.split(m[1]).length - 1;
  if (n !== 1)
    throw new Error(key + " 锚点在 " + m[0] + " 出现 " + n + " 次，不是恰好一次，拒绝施加");
  writeFileSync(origin(key), src);
  writeFileSync(m[0], src.replace(m[1], m[2]));
  console.log("已施加 " + key + " → " + m[0]);
} else if (cmd === "revert") {
  let any = false;
  for (const key of Object.keys(MUTS)) {
    let orig;
    try {
      orig = readFileSync(origin(key), "utf8");
    } catch {
      continue;
    }
    const file = MUTS[key][0];
    writeFileSync(file, orig);
    if (readFileSync(file, "utf8") !== orig)
      throw new Error(key + " 还原后逐字节核对失败");
    any = true;
    console.log("已还原 " + key + " 并核对一致 → " + file);
  }
  if (!any) console.log("没有待还原的原件（本轮尚未 apply，或已还原过）");
} else {
  throw new Error("用法: apply M1|M2|M3 | revert");
}
