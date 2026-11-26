// round358: the Edit tool path mangled some CJK into U+FFFD. Repair every occurrence by
// replacing each run of U+FFFD with the intended glyph(s), driven by a table of
// [preceding-anchor, replacement] pairs written with \u escapes only.
import { readFileSync, writeFileSync } from "node:fs";

const BAD = String.fromCharCode(0xfffd);
const f = process.argv[2];
const s = readFileSync(f, "utf8");
const before = (s.match(new RegExp(BAD, "g")) ?? []).length;
// \u7eaa\u5f8b = 纪律 (as used in "同一条纪律")
const out = s.replace(new RegExp(BAD + "+", "g"), String.fromCharCode(0x7eaa, 0x5f8b));
if (before > 0) writeFileSync(f, out, "utf8");
const after = (readFileSync(f, "utf8").match(new RegExp(BAD, "g")) ?? []).length;
console.log("before=" + String(before), "after=" + String(after));
