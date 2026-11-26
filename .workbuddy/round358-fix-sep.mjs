// 把注释分隔线上被写坏的 3 个 U+FFFD 换回 3 个 U+2500（box drawing），
// 只在这一处形状上动手，不碰任何别的字节。全 ASCII 源码，CJK 不进 shell。
import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2];
const run = String.fromCharCode(0xfffd).repeat(3);
const dash = String.fromCharCode(0x2500).repeat(3);
const text = readFileSync(file, "utf8");
const hits = text.split(run).length - 1;
if (hits !== 1) {
  console.log("ABORT hits=" + hits);
  process.exit(1);
}
const out = text.split(run).join(dash);
writeFileSync(file, out, "utf8");
const left = (out.match(new RegExp(String.fromCharCode(0xfffd), "gu")) || []).length;
console.log("FIXED hits=" + hits + " remaining_fffd=" + left);
