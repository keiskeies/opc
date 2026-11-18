/**
 * 把 renderMarkdown(REGISTRY) 里【最后一条】那一行【原样】插进 O14 那张表。
 * 不手抄：r11/r12 历史上漂过，而 `claims-registry.test.ts` 判的是【整块逐字一致】。
 *
 * 与 round277 那份一次性的 append-r13-row.mjs 的差别：这里不写死 r13 / r12，
 * 而是「渲染表的倒数第二行 = 锚点，最后一行 = 要插的」。⇒ 下一次加 r15 不用再改脚本。
 * （上一轮那份写完就过期，本身就是一格小债。）
 *
 * 前后各做一次核对：锚点找不到就抛、已存在但不是逐字一致也抛（宁可让人来看差异，
 * 也不要静默覆盖掉一行已经对着守卫的表行）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REGISTRY, renderMarkdown } from "../test/arch/claims-registry.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOC = join(ROOT, "docs", "OPC-OS-功能优化设计.md");

const rows = renderMarkdown(REGISTRY)
  .split("\n")
  .filter((l) => l.startsWith("| **r"));
if (rows.length < 2) throw new Error("渲染出来的表行不足两行");
const last = rows[rows.length - 1];
const anchor = rows[rows.length - 2];
const id = /^\| \*\*(r\d+)\*\*/u.exec(last || "")?.[1];
const anchorId = /^\| \*\*(r\d+)\*\*/u.exec(anchor || "")?.[1];
if (!id || !anchorId) throw new Error("表行开头解析不出 id ⇒ 渲染格式变了");

const text = readFileSync(DOC, "utf8");
if (text.includes(last)) {
  console.log(id + " ALREADY PRESENT (逐字已在)");
  process.exit(0);
}
const lines = text.split("\n");
const idx = lines.findIndex((l) => l.startsWith(`| **${anchorId}** `));
if (idx < 0) throw new Error(`找不到 ${anchorId} 那一行`);
const SYNC = process.argv.includes("--sync");
if (lines[idx + 1]?.startsWith(`| **${id}**`)) {
  if (!SYNC) {
    throw new Error(
      `${id} 已存在但【不是逐字一致】—— 要么改主张文案的人忘了同步表（那就加 --sync 用渲染覆盖），` +
        `要么是有人手改了表（那要去看差异，别覆盖）。渲染出来的：\n${last}`,
    );
  }
  // 用渲染结果覆盖那一行：表是 renderMarkdown 的【产物】，产物跟着来源走。
  // 但仍只允许覆盖【同一 id】那一行，且覆盖后立即重跑整块核对，不做局部模糊匹配。
  lines[idx + 1] = last;
  writeFileSync(DOC, lines.join("\n"));
  if (!readFileSync(DOC, "utf8").includes(last)) {
    throw new Error("覆盖后整块核对失败");
  }
  console.log(`${id} SYNCED to renderMarkdown (line ${idx + 2})`);
  process.exit(0);
}
lines.splice(idx + 1, 0, last);
writeFileSync(DOC, lines.join("\n"));
if (!readFileSync(DOC, "utf8").includes(last)) {
  throw new Error("写完再读没找到那一行");
}
console.log(`${id} APPENDED after ${anchorId} (line ${idx + 1})`);
