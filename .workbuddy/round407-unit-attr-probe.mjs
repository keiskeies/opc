// 诊断：单测那把尺子在真变异下的原始输出里，「service.test.ts:行号」到底长什么样。
// 剪 M1 那一发 → 跑单测 → 全文落盘 → 按 SHA 还原。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SERVICE = "packages/hub/src/members/service.ts";
const UNIT = "packages/hub/test/members/service.test.ts";
const FROM =
  "    let after = mustView(db, o.memberId);\n" +
  "    if (skillsKey(before.skills) !== skillsKey(after.skills)) {\n" +
  "      bumpMemberUpdatedAt(db, o.memberId, o.nowMs);\n" +
  "      after = mustView(db, o.memberId);\n";
const TO =
  "    const after = mustView(db, o.memberId);\n" +
  "    if (skillsKey(before.skills) !== skillsKey(after.skills)) {\n";
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

const text = readFileSync(SERVICE, "utf8");
const before = sha(text);
if (text.split(FROM).length - 1 !== 1) {
  console.log("⛔ 锚点不是恰好 1 次");
  process.exit(3);
}
writeFileSync(SERVICE, text.replace(FROM, TO));
let res;
try {
  res = spawnSync("npx", ["vitest", "run", UNIT, "-t", "挂载替换与 updated_at"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: true,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
} finally {
  writeFileSync(SERVICE, text);
}
const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
writeFileSync(".workbuddy/round407-unit-attr-probe.log", out);
console.log(
  `还原 SHA 一致：${sha(readFileSync(SERVICE, "utf8")) === before} · exit ${res.status}`,
);
const lines = out.split("\n").filter((l) => l.includes("service.test.ts"));
for (const l of lines.slice(0, 12)) console.log(JSON.stringify(l));
console.log(`匹配 /service\\.test\\.ts:(\\d+)/ ：${[...out.matchAll(/service\.test\.ts:(\d+)/gu)].length} 处`);
