// round397 · B11 快照承重机（自回滚）
// 目的：证明 0080 §6 → CEO 简报 B11 新登记的 SNAP 键与 claims-registry 行号
// 不是摆设 —— 每一发变异都真把守卫变红，还原后逐字节一致且复绿。
// 三发：
//   M1 抹掉 doc-refs SNAP 里 work 路由那条守卫键（含值行）⇒ 简报里那条引用变成
//      「无键引用」⇒ doc-refs 红。
//   M2 把枚举键的快照值改一个字节 ⇒ 快照与真行对不上 ⇒ doc-refs 红。
//   M3 把 claims-registry 里 B8 锚行号从 135 改回 134 ⇒ 那句标题不在 134 行 ⇒ 红。
// 纪律：锚点必须恰好出现 1 次；变异前守卫必须绿；每次还原用保存的原片段逐字节写回；
// 还原后 SHA 与变异前一致且复绿。任何一步不满足 ⇒ INDETERMINATE，立刻停并报。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const DOC = "test/arch/doc-refs.test.ts";
const REG = "test/arch/claims-registry.ts";

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

function runVitest(file) {
  try {
    const out = execFileSync(
      "npx",
      ["vitest", "run", file, "--reporter=dot"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true },
    );
    return { red: false, tail: out.split("\n").slice(-4).join(" | ") };
  } catch (e) {
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    const lines = out.split("\n").filter((l) => /FAIL|AssertionError|expected/.test(l));
    return { red: true, tail: lines.slice(0, 3).join(" | ") };
  }
}

function mustBeUnique(hay, needle, label) {
  const n = hay.split(needle).length - 1;
  if (n !== 1) {
    console.log(`INDETERMINATE：${label} 出现 ${n} 次（要求恰好 1），未做任何改动`);
    process.exit(2);
  }
}

function mutate({ file, anchor, replace, label, testFile }) {
  const orig = readFileSync(file, "utf8");
  const shaBefore = sha(orig);
  const pre = runVitest(testFile);
  if (pre.red) {
    console.log(`INDETERMINATE：${label} 变异前 ${testFile} 已红：${pre.tail}`);
    process.exit(2);
  }
  mustBeUnique(orig, anchor, `${label} 的锚点`);
  writeFileSync(file, orig.replace(anchor, replace));
  const mid = runVitest(testFile);
  writeFileSync(file, orig);
  const shaAfter = sha(readFileSync(file, "utf8"));
  const post = runVitest(testFile);
  const ok = mid.red && shaAfter === shaBefore && !post.red;
  console.log(
    `${ok ? "PASS" : "INDETERMINATE"} ${label}：变异后=${mid.red ? "红" : "绿"} 还原SHA=${shaAfter === shaBefore ? "一致" : "不一致"} 复绿=${!post.red}`,
  );
  console.log(`  红签名：${mid.tail.slice(0, 200)}`);
  if (!ok) process.exit(2);
}

mutate({
  file: DOC,
  anchor:
    '  "CEO-决策简报-2026-11-22.md>packages/hub/src/http/work.ts:154":\n    "if (Number(hasGroup) + Number(hasDue) + Number(hasPriority) !== 1) {",\n',
  replace: "",
  label: "M1 抹掉 PATCH 三选一守卫的快照键",
  testFile: DOC,
});

mutate({
  file: DOC,
  anchor:
    '"CEO-决策简报-2026-11-22.md>packages/contracts/src/backlog.ts:11":\n    "export const BACKLOG_STATES = [",',
  replace:
    '"CEO-决策简报-2026-11-22.md>packages/contracts/src/backlog.ts:11":\n    "export const BACKLOG_STATES = {",',
  label: "M2 枚举快照值改一个字节",
  testFile: DOC,
});

mutate({
  file: REG,
  anchor: "        line: 135,",
  replace: "        line: 134,",
  label: "M3 B8 锚行号退回加行之前",
  // 判 source.line 的是 claim-coords（「此前只是一次性脚本」那座的门禁化），
  // 不是 claims-registry.test.ts —— 第一版指错测试文件，M3 绿是【测了个寂寞】。
  testFile: "test/arch/claim-coords.test.ts",
});

console.log("三发全部：变异⇒红、还原⇒逐字节一致且复绿。");
