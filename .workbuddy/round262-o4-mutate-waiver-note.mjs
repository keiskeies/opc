// 变异探针：把 approveCard 里那道「豁免卡批准必须带理由」的写侧闸门整行删掉。
// 断言必须红 —— 不红就说明那三发（waiver_note_required + 两张带理由后放行）是假绿。
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const APP = "packages/hub/src/engine/approve.ts";
const FROM =
  '    const cardKey = String(card["card_key"] ?? "");\n' +
  '    if (o.button === "approve" && cardKey.startsWith(SAME_FAMILY_REVIEW_KEY_PREFIX) && trimmed === "") {\n' +
  '      return { kind: "waiver_note_required" as const, status };\n' +
  "    }";
const TO = '    // M: 豁免卡批准必须带理由 —— 这一格被拿掉';

const SUITE = [
  "packages/hub/test/acceptance/rejected-waiver-still-asks.test.ts",
  "packages/hub/test/acceptance/idea-to-delivered.test.ts",
  "packages/hub/test/engine/approve.test.ts",
];

const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 12);
const base = sha(APP);
const orig = readFileSync(APP, "utf8");
const restore = () => {
  writeFileSync(APP, orig);
  if (sha(APP) !== base) {
    process.stderr.write("!!! 还原失败：" + APP + "\n");
    process.exit(3);
  }
};

if (!orig.includes(FROM)) {
  process.stderr.write("锚点没找到，先读源码\n");
  process.exit(1);
}
writeFileSync(APP, orig.replace(FROM, TO));
if (sha(APP) === base) {
  restore();
  process.stderr.write("NOT APPLIED（字节没变）\n");
  process.exit(1);
}
process.stderr.write("已删掉豁免批理由闸门（" + base + " -> " + sha(APP) + "）\n");

let out = "";
try {
  out = execFileSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...SUITE], {
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
  .filter((l) => /(AssertionError|waiver_note_required|必须带理由|空理由)/.test(l))
  .map((l) => l.trim().slice(0, 150));
process.stdout.write(
  "删掉豁免批理由闸门 ⇒\n红发 " + fails.length + "\n" + fails.join("\n") +
    "\n--- 明细 ---\n" + detail.join("\n") + "\n",
);
