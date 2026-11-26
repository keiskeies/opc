// round358: repair the U+FFFD in packages/hub/src/charter/store.ts line 35.
// Anchor: "`criteriaForRoleAtVersion()`：<CJK>「库里这一版岗位书」" — git HEAD says the
// missing glyph is 把 (U+628A). Written with escapes only, so nothing depends on the
// shell surviving non-ASCII bytes.
import { readFileSync, writeFileSync } from "node:fs";

const f = process.argv[2];
const s = readFileSync(f, "utf8");
const BAD = String.fromCharCode(0xfffd);
const re = new RegExp(
  "(criteriaForRoleAtVersion\\(\\)`" + String.fromCharCode(0xff1a) + ")" + BAD + "+",
);
const found = re.test(s);
const out = s.replace(re, "$1" + String.fromCharCode(0x628a));
if (found) writeFileSync(f, out, "utf8");
const left = (readFileSync(f, "utf8").match(new RegExp(BAD, "g")) ?? []).length;
console.log(found ? "REPAIRED" : "PATTERN_NOT_FOUND", "remaining_fffd=" + String(left));
