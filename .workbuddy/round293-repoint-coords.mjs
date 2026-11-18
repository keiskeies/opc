#!/usr/bin/env node
// round293：把 claims-registry.ts 的 19 条 source.line 重新指向【当前】锚点行。
//
// 为什么不是正则一把梭：上一轮就栽在这儿。逐条 replace 会【链式污染】——
// r6 的新值 143 正好等于 r2 的旧值，若按顺序替换，等轮到 r2 时文件里已经有两处
// `line: 143,`，替换会多改一格（或撞上「不唯一」），而输出看起来完全正常。
// 所以这里一次正则、回调查表：每个旧值只被读一次，写完立刻回读校验。
//
// 新值不是猜的：来自 claim-coords 红话自己交出的「现在在 [...]」。
// 命中多处的那四条（r1/r3/r8/r9）取【与旧值同偏移】的那一格，
// 另一格是文档里另处【引用】了同一句话 —— 那不能当坐标，坐标要指主张本体。
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "test/arch/claims-registry.ts";
const MAP = {
  146: 186, // r1（另一命中 1462 = 引用）
  143: 183, // r2
  1175: 1215, // r3（另一命中 1464）
  938: 978, // r4
  673: 713, // r5
  103: 143, // r6
  1053: 1093, // r7
  828: 868, // r8（另一命中 1469）
  140: 180, // r9（另一命中 459）
  1620: 1667, // r10
  1711: 1758, // r11
  1742: 1789, // r12
  1806: 1853, // r13
  1862: 1909, // r14
  1903: 1950, // r15
  1303: 1343, // r16
  1266: 1306, // r17
  1239: 1279, // r18
  1829: 1876, // r19
};

const before = readFileSync(FILE, "utf8");
const seen = new Map();
let guard = 0;
const after = before.replace(/^( +)line: (\d+),$/gmu, (_m, pad, raw) => {
  guard += 1;
  const old = Number(raw);
  const next = MAP[old];
  if (next === undefined) {
    throw new Error(`line: ${old} 不在这轮的 19 条里 —— 停，不落盘`);
  }
  seen.set(old, (seen.get(old) ?? 0) + 1);
  return pad + "line: " + next + ",";
});

if (guard !== 19) throw new Error(`读到 ${guard} 条 line 字段，不是 19 —— 停`);
const missing = Object.keys(MAP)
  .map(Number)
  .filter((k) => seen.get(k) !== 1);
if (missing.length > 0) {
  throw new Error("这些旧值【没有恰好命中一次】：" + missing.join(", ") + " —— 停");
}
// 回读：新值集合必须恰好是期望的那 19 个，各一次。
const now = [...after.matchAll(/^ +line: (\d+),$/gmu)].map((m) => Number(m[1]));
const want = Object.values(MAP).sort((a, b) => a - b);
const got = [...now].sort((a, b) => a - b);
if (JSON.stringify(want) !== JSON.stringify(got)) {
  throw new Error(
    "回读对不上\n  期望 " + want.join(",") + "\n  实际 " + got.join(","),
  );
}
writeFileSync(FILE, after, "utf8");
console.log("19 条坐标已重指向，回读逐条一致：\n  " + got.join(", "));
