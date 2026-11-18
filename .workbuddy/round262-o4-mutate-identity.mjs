// 变异探针：把 CEO_APPROVED_SQL 的【身份那一维】退回，新断言必须红。
// 不红就说明那两发是假绿（断言的其实是状态，不是身份）。
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const RT = "packages/hub/src/engine/runtime.ts";
const TEST = "packages/hub/test/engine/runtime.test.ts";
const FROM = "AND status = 'approved' AND decided_by = 'ceo' LIMIT 1";
const TO = "AND status = 'approved' LIMIT 1";

const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 12);
const base = sha(RT);
const orig = readFileSync(RT, "utf8");
const restore = () => {
  writeFileSync(RT, orig);
  if (sha(RT) !== base) {
    process.stderr.write("!!! 还原失败：" + RT + "\n");
    process.exit(3);
  }
};

if (!orig.includes(FROM)) {
  process.stderr.write("锚点没找到，先读源码\n");
  process.exit(1);
}
writeFileSync(RT, orig.replace(FROM, TO));
if (sha(RT) === base) {
  restore();
  process.stderr.write("NOT APPLIED（字节没变）\n");
  process.exit(1);
}
process.stderr.write("已把身份那一维退回（" + base + " -> " + sha(RT) + "）\n");

let out = "";
try {
  out = execFileSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", TEST], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  out = (e.stdout ?? "") + (e.stderr ?? "");
}
restore();

if (!/Test Files/.test(out)) {
  process.stderr.write("!!! PROBE DID NOT RUN，前 1200 字节：\n" + out.slice(0, 1200) + "\n");
  process.exit(4);
}
const lines = out.split(/\r?\n/);
const fails = lines.filter((l) => /^\s+(×|✕)/.test(l)).map((l) => l.trim());
const detail = lines
  .filter((l) => /(AssertionError|expected |策略引擎|没署名)/.test(l))
  .map((l) => l.trim().slice(0, 150));
process.stdout.write(
  "退回身份那一维 ⇒\n红发 " + fails.length + "\n" + fails.join("\n") +
    "\n--- 明细 ---\n" + detail.join("\n") + "\n",
);
