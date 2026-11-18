// 字节级普查：那三台老机器（以及 round295 那一台）的「剥 ANSI」到底剥没剥 ESC。
// 为什么要字节级：Read 出来的文本里 0x1b 是不可见的，
// `/\[[0-9;]*m/`（漏 ESC）与 `/\u001b\[[0-9;]*m/`（对）在肉眼下一模一样。
import { readFileSync } from "node:fs";

const ROOT = "D:/item/opc";
const ESC = String.fromCharCode(27);
const files = [
  ".workbuddy/round292-mutate-org-node-criterion.mjs",
  ".workbuddy/round293-mutate-census.mjs",
  ".workbuddy/round294-mutate-add-node.mjs",
  ".workbuddy/round295-mutate-frontend-egress.mjs",
];

const show = (s) => s.split(ESC).join("<ESC>");

for (const rel of files) {
  const s = readFileSync(`${ROOT}/${rel}`, "utf8");
  const literal = s.split(ESC).length - 1;
  const named =
    (s.match(/\\u001b/g) ?? []).length +
    (s.match(/\\x1b/g) ?? []).length +
    (s.match(/\\e\[/g) ?? []).length;
  console.log(`\n=== ${rel}  字面ESC=${literal} 可见转义=${named}`);
  s.split(/\r?\n/).forEach((l, i) => {
    const relevant = l.includes(ESC) || /\[0-9;/.test(l) || /u001b|x1b/.test(l);
    if (!relevant) return;
    console.log(`  L${i + 1}: ${show(l).trim()}`);
  });
}
