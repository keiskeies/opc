// round358: 修复 turn-bundle.ts 里我写坏的 CJK 字节（U+FFFD）。
// 纯 ASCII 源码，替换文本全用码点转义，避免脚本自身再被编码搞坏。
import { readFileSync, writeFileSync } from "node:fs";

const file = "packages/hub/src/evidence/turn-bundle.ts";
const F = "�";
const reps = [
  ["\u5B83\u4E0D\u77E5" + F + F + "\u95E8\u63A7", "\u5B83\u4E0D\u77E5\u9053\u95E8\u63A7"],
  ["\u81EA" + F + F + "\u53EF\u58F0\u660E", "\u81EA\u68C0\u53EF\u58F0\u660E"],
  ["\u8EAB" + F + F + F + "\u62FC\u6210", "\u8EAB\u4EFD\u62FC\u6210"],
  ["Artifact " + F + F + F + "\u7ED3\u8BBA", "Artifact \u7684\u7ED3\u8BBA"],
];

let text = readFileSync(file, "utf8");
for (const [from, to] of reps) {
  const n = text.split(from).length - 1;
  if (n !== 1) {
    console.log("MISS count=" + n + " pattern=" + JSON.stringify(from));
    process.exit(1);
  }
  text = text.replace(from, to);
}
const left = text
  .split(/\r?\n/)
  .map((l, i) => [i + 1, l])
  .filter(([, l]) => l.includes(F));
writeFileSync(file, text, "utf8");
console.log("remaining U+FFFD lines: " + JSON.stringify(left));
