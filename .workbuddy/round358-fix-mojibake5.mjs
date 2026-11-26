// round358: line 73 of work.ts lost 一 (U+4E00) to the Edit path's CJK mangling.
import { readFileSync, writeFileSync } from "node:fs";

const BAD = String.fromCharCode(0xfffd);
const f = process.argv[2];
const s = readFileSync(f, "utf8");
const TONG = String.fromCharCode(0x540c); // 同
const TIAO = String.fromCharCode(0x6761); // 条
const YI = String.fromCharCode(0x4e00); // 一
const re = new RegExp(TONG + BAD + "+" + TIAO, "g");
const found = (s.match(re) ?? []).length;
const out = s.replace(re, TONG + YI + TIAO);
if (found > 0) writeFileSync(f, out, "utf8");
const left = (readFileSync(f, "utf8").match(new RegExp(BAD, "g")) ?? []).length;
console.log("hits=" + String(found), "remaining_fffd=" + String(left));
