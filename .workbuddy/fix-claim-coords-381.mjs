/**
 * round381 一次性：O14 表里插入 r27 那一行 ⇒ 表之后的正文整体 +1 行，
 * 11 条以该文档为 source.doc 的坐标全体漂一格。
 *
 * 只搬【漂报告里交出唯一命中行】的那些格；命中数不是 1 的一律抛（不猜）。
 * 判据本身（claim-coords）不在这个脚本里，跑完立刻用守卫复验。
 */
import { readFileSync, writeFileSync } from "node:fs";

const P = "test/arch/claims-registry.ts";
const MAP = {
  1829: 1830, 1920: 1921, 1951: 1952, 2015: 2016, 2071: 2072,
  2112: 2113, 2038: 2039, 2352: 2353, 2476: 2477, 2593: 2594, 2666: 2667,
};
let src = readFileSync(P, "utf8");
let n = 0;
for (const [o, nu] of Object.entries(MAP)) {
  const pat = "line: " + o + ",";
  const hits = src.split(pat).length - 1;
  if (hits !== 1) throw new Error("line: " + o + " 命中 " + hits + " 次 ⇒ 不猜，人工看");
  src = src.split(pat).join("line: " + nu + ",");
  n += 1;
}
writeFileSync(P, src);
console.log("re-pointed", n, "coords (+1 each)");
