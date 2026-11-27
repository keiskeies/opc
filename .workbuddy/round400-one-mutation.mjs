// 单发取证：应用一发变异 → 跑那条 e2e → 打印完整失败段 → 按 SHA 还原。
// 用法：node .workbuddy/round400-one-mutation.mjs M3
// 目的：机器只报「红在哪条线」，这里要看的是【为什么红在那条线】（归因，不是判据）。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const id = process.argv[2];
const machine = new URL("./round400-wire-mutations.mjs", import.meta.url).pathname;
// 从机壳里取 MUTATIONS，避免两处清单走样：把机壳当模块读源码再 eval 那段数组太脆，
// 这里改成直接 import 机壳的副作用会被预热挡住，所以复制一份最小清单（只这两发需要）。
const MINIMAL = {
  M3: {
    from: '            { label: "删除这一件技能", onClick: (row) => row.remove() },',
    to: '            { label: "删除这一件技能", onClick: () => removeSkill("", "ghost") },',
  },
  M6: {
    from: '            { label: "删除这一档执行器", onClick: (row) => row.remove() },',
    to: '            { label: "删除这一档执行器", onClick: () => removeExecutor("", "99") },',
  },
};
if (!MINIMAL[id]) {
  console.log("只支持 M3 / M6（机壳报的红线与预期线不一致的那两发），machine=" + machine);
  process.exit(1);
}
const GROUP = "packages/web/public/group.js";
const sha = (t) => createHash("sha256").update(t).digest("hex");
const m = MINIMAL[id];
const orig = readFileSync(GROUP, "utf8");
const before = sha(orig);
if (orig.split(m.from).length - 1 !== 1) {
  console.log("⛔ 锚点命中不是 1 次，未动字节。");
  process.exit(3);
}
writeFileSync(GROUP, orig.replace(m.from, m.to), "utf8");
let out = "";
try {
  const r = spawnSync(
    "npx",
    [
      "playwright",
      "test",
      "test/e2e/group-workbench.spec.ts",
      "-g",
      "成员设置面板增删技能与执行器",
      "--reporter=list",
      "--timeout=25000",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: true },
  );
  out = `${r.stdout}${r.stderr}`;
  console.log(`exit=${r.status}`);
} finally {
  writeFileSync(GROUP, orig, "utf8");
  console.log("还原：" + (sha(readFileSync(GROUP, "utf8")) === before ? "SHA 一致" : "SHA 不一致！"));
}
const lines = out.split("\n");
const start = lines.findIndex((l) => /Error|expect\(|✘|failed/u.test(l));
console.log(lines.slice(Math.max(0, start - 5), start + 60).join("\n"));
