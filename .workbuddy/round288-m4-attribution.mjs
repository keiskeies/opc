// round288 · M4 的归因单检：那一发红到底是【INDEX 这一半】读到的，还是只有 0030 那篇读到的。
// 上一台机器把 received 行截到 200 字，看不见后半截 ⇒ 「M4 命中」这句话当时不算证完。
// 跑法：node .workbuddy/round288-m4-attribution.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const FILE = "test/desktop/ipc-surface.test.ts";
const FROM = "      expect(API_ENDPOINTS).toContain(s.endpoint);";
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "gu");
const original = readFileSync(FILE, "utf8");
if (!original.includes(FROM)) throw new Error("锚文本不在，探针自己坏了");

try {
  writeFileSync(
    FILE,
    original.replace(FROM, FROM + " // round288 归因单检，跑完即撤"),
    "utf8",
  );
  const r = spawnSync("npx", ["vitest", "run", "test/arch/doc-refs.test.ts"], {
    shell: true,
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600000,
  });
  if (r.status === null) throw new Error("vitest 没起来");
  const out = (r.stdout + r.stderr).replace(ANSI, "");
  const got = out
    .split(/\r?\n/)
    .filter((l) => l.startsWith("+ ") && l.includes("ipc-surface.test.ts:129"))
    .join("\n");
  console.log("完整 received（不截断）：\n" + got);
  for (const k of ["INDEX.md>", "0030-im-binding"]) {
    console.log("\n" + k + " 出现在 received 里吗：", got.includes(k) ? "是" : "否");
  }
  // ⚠ 这一行原先用 `/\.md>[^\s]*与快照不符/` 数键，打出 0 —— 那是【假的 0】：
  //   received 里每条消息都含空格（「目标行内容与快照不符：快照 […]」），`[^\s]*` 必然断在半句。
  //   改成直接数 got 里这句话的次数。留着这段是因为它和本轮其它三发是同一族错法：
  //   探针有输出、输出也对，错在我读它的那一层。
  const n = got.split("与快照不符").length - 1;
  console.log("\nreceived 里「与快照不符」出现 " + n + " 次（同一坐标在 INDEX 出现两次 ⇒ 会重复报）");
} finally {
  writeFileSync(FILE, original, "utf8");
  if (readFileSync(FILE, "utf8") !== original) throw new Error("回滚不干净，人工检查");
  console.log("还原：与原文逐字一致");
}
