// 把一个 U+FFFD 换成指定的码点序列。argv: <file> <to-cp>
// 用法：node round358-fix-one.mjs <file> 5199
// 只在【全文件恰好 1 个】U+FFFD 时动手，避免指错位置。
import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2];
const cps = (process.argv[3] ?? "").split(",").filter((s) => s !== "");
if (cps.length === 0) {
  console.log("ABORT no-target-codepoints");
  process.exit(1);
}
const replacement = String.fromCharCode(0xfffd);
const text = readFileSync(file, "utf8");
const hits = text.split(replacement).length - 1;
if (hits !== 1) {
  console.log("ABORT fffd_hits=" + hits);
  process.exit(1);
}
const out = text.split(replacement).join(
  cps.map((c) => String.fromCodePoint(parseInt(c, 16))).join(""),
);
writeFileSync(file, out, "utf8");
const left = (out.match(new RegExp(replacement, "gu")) || []).length;
console.log("FIXED remaining_fffd=" + left);
