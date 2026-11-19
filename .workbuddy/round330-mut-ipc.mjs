#!/usr/bin/env node
/**
 * round330 变异证据：hub:eventsReady 握手（wire.ts / preload/api.ts）。
 *
 * 判据形状沿用本仓口径：
 *  ① 改真实现【若干字节】→ 跑 test/desktop → 必须【有红】；
 *  ② 逐字节还原 → 断言与原文【逐字相同】(reverted: true)；
 *  ③ 变异前后各读一次源码，断言字符串【确实变了】（防"needle 没命中、
 *     跑的还是真实现"那种假红——needle 命中数必须恰为 1）。
 *
 * 三发：
 *  M1 摘掉 ready handler 的开流动作（handler 还在但什么都不做）
 *     ⇒ 期望红在「ready 到达后才开流」那一族。
 *  M2 wireMain 构造时就抢先开流（不等 ready）
 *     ⇒ 期望红在「ready 之前零连接」—— 这正是握手要拦的原 bug 形状。
 *  M3 摘掉 ready 通道的注册（换成一个别的通道名）
 *     ⇒ 期望红在注册集对账（wire.test.ts / events-ready.test.ts 两侧）。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const WIRE = "packages/desktop/src/main/wire.ts";

function run(label, file, from, to, expectRedIn) {
  const original = readFileSync(file, "utf8");
  const hits = original.split(from).length - 1;
  if (hits !== 1) {
    console.log(label + " SKIP-FAIL: needle 命中 " + hits + " 次（必须恰为 1），不动文件");
    process.exitCode = 1;
    return;
  }
  const mutated = original.split(from).join(to);
  if (mutated === original) {
    console.log(label + " SKIP-FAIL: 变异后字符串未变（变异等价于没改）");
    process.exitCode = 1;
    return;
  }
  writeFileSync(file, mutated, "utf8");
  const mid = readFileSync(file, "utf8");
  const changedOnDisk = mid !== original && mid === mutated;

  let out = "";
  let failed = 0;
  try {
    execFileSync("npx", ["vitest", "run", ...expectRedIn], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    out = (e.stdout ?? "") + (e.stderr ?? "");
  }
  const m = out.match(/Tests\s+.*?(\d+) failed/);
  failed = m ? Number(m[1]) : 0;
  const passedLine = (out.match(/Tests\s+[^\n]+/) ?? ["(没抓到汇总行)"])[0].trim();

  writeFileSync(file, original, "utf8");
  const back = readFileSync(file, "utf8");
  const reverted = back === original;
  const ok = changedOnDisk && failed > 0 && reverted;
  if (!ok) process.exitCode = 1;
  console.log(
    label +
      " file=" + file +
      " mutated=" + changedOnDisk +
      " failed=" + failed +
      " reverted=" + reverted +
      " | " + passedLine,
  );
}

const ALL = ["test/desktop"];

run(
  "M1 ready handler 摘掉开流（在而不动）",
  WIRE,
  "    if (!o.sender.isDestroyed()) open();",
  "    if (!o.sender.isDestroyed() && false) open();",
  ALL,
);

run(
  "M2 wireMain 抢先开流（不等 ready）",
  WIRE,
  "  return {\n    start: open,",
  "  open(); // 变异 M2：抢在 ready 之前开流\n  return {\n    start: open,",
  ALL,
);

run(
  "M3 ready 通道注册换成没人调的通道名",
  WIRE,
  "  o.ipcMain.handle(EVENTS_READY_CHANNEL, async () => {",
  "  o.ipcMain.handle(EVENTS_READY_CHANNEL + \"-x\", async () => {",
  ALL,
);

console.log("done. exitCode=" + (process.exitCode ?? 0));
