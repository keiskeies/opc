/**
 * 把 renderMarkdown(REGISTRY) 的 r13 那一行【原样】插进 O14 那张表。
 * 不手抄：r11/r12 那两行历史上漂过，而守卫判的是【逐字一致】。
 * 只在 r12 行之后插入，且插入前后各做一次逐字核对；对不上就抛，不改文件。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REGISTRY, renderMarkdown } from "../test/arch/claims-registry.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOC = join(ROOT, "docs", "OPC-OS-功能优化设计.md");
const want = renderMarkdown(REGISTRY).split("\n");
const r13 = want[want.length - 1];
if (!r13.startsWith("| **r13**")) throw new Error("渲染出来的最后一行不是 r13");

const text = readFileSync(DOC, "utf8");
if (text.includes(r13)) {
  console.log("ALREADY PRESENT (逐字已在)");
  process.exit(0);
}
const lines = text.split("\n");
const idx = lines.findIndex((l) => l.startsWith("| **r12** "));
if (idx < 0) throw new Error("找不到 r12 那一行");
if (lines[idx + 1].startsWith("| **r13**")) throw new Error("r13 已存在但不是逐字一致 —— 要看差异，别覆盖");
lines.splice(idx + 1, 0, r13);
writeFileSync(DOC, lines.join("\n"));
const back = readFileSync(DOC, "utf8");
if (!back.includes(r13)) throw new Error("写完再读没找到那一行");
console.log("APPENDED after line", idx + 1);
