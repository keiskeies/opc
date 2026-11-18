// round270 O5 动作 4【补账】的变异证据（自恢复）。
//
// round264 落地时没留变异证据（台账自首过），本轮把三条判据各打一发：
//  M1 读侧死字段：query.ts 视图把 evidence_refs 写死 null
//     ⇒ query.test「evidence_refs 随视图带出」红（有证据的卡读出 null）。
//  M2 写侧断链：cards.ts 建卡落库写死 null
//     ⇒ cards.test ⑥「建卡带证据引用 ⇒ 落库读回逐字对得上」红。
//  M3 UI 沉默：app.js 的「无证据包」换成空串
//     ⇒ app-pure「evidenceLine」红（缺证据的卡与带证据的卡在屏幕上同形）。
//
// 用法：node .workbuddy/round270-o5-backfill-mutate.mjs apply M1|M2|M3
//       node .workbuddy/round270-o5-backfill-mutate.mjs revert
import { readFileSync, writeFileSync } from "node:fs";

const SPECS = {
  M1: {
    file: "packages/hub/src/approvals/query.ts",
    origin: ".workbuddy/round270-o5-backfill-orig-query.ts",
    from: '    evidence_refs: evidenceRefsOf(r["evidence_refs"]),',
    to: "    evidence_refs: null,",
  },
  M2: {
    file: "packages/hub/src/approvals/cards.ts",
    origin: ".workbuddy/round270-o5-backfill-orig-cards.ts",
    from: "    draft.evidence_refs.length === 0 ? null : JSON.stringify(draft.evidence_refs),",
    to: "    null,",
  },
  M3: {
    file: "packages/web/public/app.js",
    origin: ".workbuddy/round270-o5-backfill-orig-app.js",
    from: `    return ' · <b class="ev-none">无证据包</b>';`,
    to: "    return \"\";",
  },
};

const cmd = process.argv[2];
if (cmd === "apply") {
  const key = process.argv[3];
  const s = SPECS[key];
  if (s === undefined) throw new Error("M1|M2|M3，实到 " + key);
  const src = readFileSync(s.file, "utf8");
  const n = src.split(s.from).length - 1;
  if (n !== 1) throw new Error(key + " 锚点出现 " + n + " 次，不是恰好一次，拒绝施加");
  writeFileSync(s.origin, src);
  writeFileSync(s.file, src.replace(s.from, s.to));
  console.log("已施加 " + key);
} else if (cmd === "revert") {
  for (const key of Object.keys(SPECS)) {
    const s = SPECS[key];
    try {
      const orig = readFileSync(s.origin, "utf8");
      writeFileSync(s.file, orig);
      if (readFileSync(s.file, "utf8") !== orig) throw new Error(key + " 还原后逐字节核对失败");
      console.log("已还原 " + key + " 并核对一致");
    } catch {
      console.log(key + " 无存档（本轮没施加过），跳过");
    }
  }
} else {
  throw new Error("用法: apply M1|M2|M3 | revert");
}
