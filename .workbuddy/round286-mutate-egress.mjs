// round286 · 打在【真·网络出口】上的变异：defaultFetch 不再转发 init 里的 signal。
// r18 射程 ② 说的是「注入方可以不读信号」；这一发打的是它的反面 —— 适配器自己交出信号，
// 但默认实现把它【半路丢掉】。射程 ② 那句话把这格算在「没有任何一发会红」里，这一发验的就是这句。
// 跑法：npx tsx .workbuddy/round286-mutate-egress.mjs
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const TARGET = "packages/hub/src/channels/feishu.ts";
const orig = readFileSync(TARGET, "utf8");
const before = "  const res = await fetch(url, init);";
const after =
  "  const res = await fetch(url, {\n" +
  "    method: init.method,\n" +
  "    headers: init.headers,\n" +
  "    body: init.body,\n" +
  "  });";
if (!orig.includes(before)) throw new Error("锚点没命中，别硬改");

const runSuite = () => {
  // shell:true 不是可选项：Windows 上 npx 是 .cmd，不带 shell 直接 spawnSync 会得到
  // `status = null` + 空输出，而这份脚本差一点就把「一个进程都没起」读成「0 发红 = 全绿」。
  const r = spawnSync("npx", ["vitest", "run", "packages/hub/test/channels"], {
    shell: true, cwd: process.cwd(), encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024, timeout: 900000,
  });
  if (r.status === null) throw new Error("vitest 进程没起来（status=null）—— 这不是「全绿」");
  return String(r.stdout) + String(r.stderr);
};
const read = (raw) => {
  // 必须先剥 ANSI：vitest 非 TTY 也带色，`FAIL` 前面那串 `[31m` 会让锚定 `^\s*FAIL`
  // 的正则【一条都不命中】—— 于是「有 1 发红」会被打印成「红的用例：无」。
  // 这是本脚本第一次跑出来的形状：读数行说有 1 failed，用例名单是空的。
  const ANSI = new RegExp(String.fromCharCode(27) + "\[[0-9;]*m", "gu");
  const out = raw.replace(ANSI, "");
  return {
    tests: (out.match(/Tests\s+([^\n]*)/u) ?? [])[1] ?? "(没读到读数行)",
    files: [...new Set([...out.matchAll(/^\s*FAIL\s+(\S+)/gmu)].map((x) => x[1]))],
    cases: [...new Set([...out.matchAll(/^\s*× (.+?) \d+ms/gmu)].map((x) => x[1]))],
  };
};

const base = read(runSuite());
console.log("基线（未变异）:", base.tests);
if (/failed/u.test(base.tests)) throw new Error("基线就是红的，变异读数没有意义 —— 先修基线");

try {
  writeFileSync(TARGET, orig.replace(before, after));
  const m = read(runSuite());
  console.log("变异后:", m.tests);
  console.log("红的文件:", m.files.length ? m.files.join(" | ") : "无");
  console.log("红的用例:\n  " + (m.cases.join("\n  ") || "无"));
} finally {
  writeFileSync(TARGET, orig);
  console.log("还原:" + (readFileSync(TARGET, "utf8") === orig ? "与原文逐字一致" : "⚠ 不一致，人工查"));
}
