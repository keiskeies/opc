// round271 O4 验收句【复测】的变异脚本（自恢复）。
//
// 要量的那句话（设计文档 O4 验收 + 落点段自己承认没复测过的旧读数）：
//   「把上表第 3、4 行的每一个函数调用点删掉 ⇒ 各自必须有一发红。今天删掉它们 0 发红。」
// 五个调用点各打一发「调用点删除」变异。**每一发都过 tsc**（O4 原文那句
// 「tsc 只看见函数还在被同目录引用」要的就是这个形状：语法合法、类型合法，
// 只有测试能看见判据没了）。canned 值写成【带返回类型标注的 IIFE】——
// 直接写 `const x: Union = {ok:true}` 会被 TS 收窄成字面量分支，后续 `!x.ok`
// 分支里的 `x.code` 就报 never；IIFE 的标注返回联合类型，不收窄。
//   M1 verifier.ts   的 sameFamilyReviewBlock(...)      ⇒ canned {ok:true}
//   M2 author-reviewer 的 independentReviewerPath(...)  ⇒ canned {reachable:true}
//   M3 gateConfigBlock 里的 sameFamilyReviewBlock(...)  ⇒ canned {ok:true}
//   M4 gateConfigBlock 里的 selfReviewEdgeBlock(...)    ⇒ canned {ok:true}
//   M5 verifier.ts   的 evaluateGate(...)               ⇒ canned pass 判定
//
// 用法：node .workbuddy/round271-o4-acceptance-mutate.mjs apply M1..M5
//       node .workbuddy/round271-o4-acceptance-mutate.mjs revert
import { readFileSync, writeFileSync } from "node:fs";

const AR = "packages/hub/src/graph/gates/author-reviewer.ts";
const VF = "packages/hub/src/harness/verifier.ts";

const SPECS = {
  M1: {
    file: VF,
    from: "  const fam = sameFamilyReviewBlock(",
    to:
      "  const fam = ((): ReturnType<typeof sameFamilyReviewBlock> => ({ ok: true }))();\n" +
      "  if (false) sameFamilyReviewBlock(",
  },
  M2: {
    file: AR,
    from: "  const r = independentReviewerPath(author, edges);",
    to:
      "  const r = ((): ReturnType<typeof independentReviewerPath> => ({ reachable: true, path: [] }))();\n" +
      "  void independentReviewerPath;",
  },
  M3: {
    file: AR,
    from: "  const a = sameFamilyReviewBlock(o.producer, o.reviewer, o.approval);",
    to:
      "  const a = ((): ReturnType<typeof sameFamilyReviewBlock> => ({ ok: true }))();\n" +
      "  void sameFamilyReviewBlock;",
  },
  M4: {
    file: AR,
    from: "  const b = selfReviewEdgeBlock(o.producer.roleId, o.edges);",
    to:
      "  const b = ((): ReturnType<typeof selfReviewEdgeBlock> => ({ ok: true }))();\n" +
      "  void selfReviewEdgeBlock;",
  },
  M5: {
    file: VF,
    from: "  const verdict: GateVerdict = evaluateGate({",
    to:
      "  const verdict: GateVerdict = ((o: Parameters<typeof evaluateGate>[0]) => {\n" +
      "    void o;\n" +
      "    return { decision: \"pass\" as const, unresolved: [] as string[] };\n" +
      "  })({",
  },
};

const cmd = process.argv[2];
if (cmd === "apply") {
  const key = process.argv[3];
  const s = SPECS[key];
  if (s === undefined) throw new Error("M1..M5，实到 " + key);
  const origin = ".workbuddy/round271-o4-acceptance-orig-" + key + ".ts";
  const src = readFileSync(s.file, "utf8");
  const n = src.split(s.from).length - 1;
  if (n !== 1) throw new Error(key + " 锚点出现 " + n + " 次，不是恰好一次，拒绝施加");
  writeFileSync(origin, src);
  writeFileSync(s.file, src.replace(s.from, s.to));
  console.log("已施加 " + key + "（存档 " + origin + "）");
} else if (cmd === "revert") {
  for (const key of Object.keys(SPECS)) {
    const origin = ".workbuddy/round271-o4-acceptance-orig-" + key + ".ts";
    try {
      const orig = readFileSync(origin, "utf8");
      writeFileSync(SPECS[key].file, orig);
      if (readFileSync(SPECS[key].file, "utf8") !== orig) throw new Error(key + " 还原核对失败");
      console.log("已还原 " + key + " 并核对一致");
    } catch {
      console.log(key + " 无存档（本轮没施加过），跳过");
    }
  }
} else {
  throw new Error("用法: apply M1..M5 | revert");
}
