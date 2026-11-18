/**
 * 把【指定某一条】主张的表行同步成 renderMarkdown 的渲染结果。
 *
 * 为什么不是 `.workbuddy/append-registry-row.mjs`：那份的 `--sync` 只认【最后一条】
 * （它拿「倒数第二行」当锚点）。改了一条中间的主张文案（round280 改的是 r3）它帮不上，
 * 而它文件头自己就记着上一版「写完就过期，本身就是一格小债」。这里按 id 认，
 * 加一条 = `npx tsx .workbuddy/sync-registry-row.mjs r17`，改一条 = 同一句
 * （必须 tsx：这文件 import 了 `../test/arch/claims-registry.ts`）。
 *
 * 表是渲染的【产物】，产物跟着来源走 —— 但只许覆盖【同一 id 那一行】，
 * 找不到就抛、写完立即重读核对。`claims-registry.test.ts` 判的是整块逐字一致，
 * 所以这里宁可抛也不要「差不多就行」。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REGISTRY, renderMarkdown } from "../test/arch/claims-registry.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOC = join(ROOT, "docs", "OPC-OS-功能优化设计.md");

const ids = process.argv.slice(2).filter((a) => /^r\d+$/u.test(a));
if (ids.length === 0) throw new Error("用法：sync-registry-row.mjs <rN> [<rM> …]");

const rendered = new Map(
  renderMarkdown(REGISTRY)
    .split("\n")
    .filter((l) => l.startsWith("| **r"))
    .map((l) => [/^\| \*\*(r\d+)\*\*/u.exec(l)?.[1] ?? "", l]),
);

const lines = readFileSync(DOC, "utf8").split("\n");
let changed = 0;
for (const id of ids) {
  const want = rendered.get(id);
  if (want === undefined) throw new Error(`渲染里没有 ${id} —— 登记表里没这条？`);
  const idx = lines.findIndex((l) => l.startsWith(`| **${id}** `));
  if (idx < 0) throw new Error(`${id} 在文档表里找不到那一行`);
  if (lines[idx] === want) {
    console.log(`${id} 已逐字一致（第 ${idx + 1} 行）`);
    continue;
  }
  lines[idx] = want;
  changed++;
  console.log(`${id} 同步为渲染结果（第 ${idx + 1} 行）`);
}
if (changed > 0) {
  writeFileSync(DOC, lines.join("\n"));
  const after = readFileSync(DOC, "utf8");
  for (const id of ids) {
    // ⚠ 这里不能写 `as string`：`.mjs` 走的是纯 JS 解析（tsx 只转译 .ts）。
    // rendered.get(id) 在上面已经查过一轮，到不了 undefined。
    if (!after.includes(rendered.get(id))) {
      throw new Error(`写完再读没找到 ${id} 那一行`);
    }
  }
}
