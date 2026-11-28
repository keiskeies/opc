// 0087 红探针（最终测试字节版）：把 service.ts 与 group.js 一起退回 `git show HEAD:` 字节，
// 跑两把新尺子 —— 单测那个 describe 必须红（4 failed）、那条 e2e 必须红（断在「线 1」dt 列表）；
// 跑完按 sha256 还原并逐字节核对。⚠ 第一版红探针取的是判据加固前的测试字节，本轮又补了
// settlePastSecond 与 qoder-cli 两处，按家法在【最终测试字节】上重取。
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const FILES = [
  "packages/hub/src/members/service.ts",
  "packages/web/public/group.js",
];
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

const work = new Map(
  FILES.map((f) => {
    const text = readFileSync(f, "utf8");
    return [f, { text, sha: sha(text) }];
  }),
);
const head = new Map(
  FILES.map((f) => [
    f,
    execFileSync("git", ["show", `HEAD:${f}`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  ]),
);
for (const f of FILES) {
  if (head.get(f) === work.get(f).text) {
    console.log(`⛔ ${f} 工作树与 HEAD 一字不差 ⇒ 本轮没改它，探针无意义 —— 停`);
    process.exit(3);
  }
}

try {
  for (const f of FILES) writeFileSync(f, head.get(f));
  console.log("已把两文件退回 HEAD 字节");

  const unit = spawnSync("npx", ["vitest", "run", "packages/hub/test/members/service.test.ts", "-t", "挂载替换与 updated_at"], { encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024 });
  const unitOut = `${unit.stdout ?? ""}${unit.stderr ?? ""}`;
  const unitFailed = /(\d+) failed/u.exec(unitOut);
  console.log(`单测：exit=${unit.status ?? -1} 失败计数=${unitFailed ? unitFailed[1] : "无"}`);
  if ((unit.status ?? -1) === 0 || !unitFailed) {
    console.log("⛔ 单测在 HEAD 字节上没红（或没测到）—— 判据不承重，停");
    console.log(unitOut.slice(-2000));
    process.exit(4);
  }

  const e2e = spawnSync("npx", ["playwright", "test", "test/e2e/group-workbench.spec.ts", "-g", "成员档案的时刻：换技能与换执行器算不算档案变了", "--reporter=list", "--timeout=40000"], { encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024 });
  const e2eOut = `${e2e.stdout ?? ""}${e2e.stderr ?? ""}`;
  // 失败标题行也报 `spec.ts:4746`（test 声明行），那是用例名不是断言位置 —— 跳过它取
  // 第一枚【断言】坐标；顺带列出全部坐标供台账点名（4746 = 用例声明，不作数）。
  const rows = [...e2eOut.matchAll(/group-workbench\.spec\.ts:(\d+)/gu)]
    .map((m) => Number(m[1]))
    .filter((n, i, a) => n !== 4746 && a.indexOf(n) === i)
    .sort((a, b) => a - b);
  const atLine = rows[0];
  console.log(`e2e：exit=${e2e.status ?? -1} 断言红行=${atLine ?? "无"}（全部坐标 ${rows.join(",") || "无"}）`);
  if ((e2e.status ?? -1) === 0 || !atLine) {
    console.log("⛔ e2e 在 HEAD 字节上没红（或没测到）—— 停");
    console.log(e2eOut.slice(-2000));
    process.exit(4);
  }
} finally {
  let bad = 0;
  for (const [f, entry] of work) {
    writeFileSync(f, entry.text);
    const ok = sha(readFileSync(f, "utf8")) === entry.sha;
    console.log(`还原 ${f}：SHA ${ok ? "一致" : "⚠ 不符"}（${entry.sha}）`);
    if (!ok) bad++;
  }
  if (bad > 0) {
    console.log("⛔ 还原不符 —— 人工核对");
    process.exit(5);
  }
}
console.log("探针完成且两文件已按 SHA 还原");
