// round358: repair the U+FFFD run in dispatch.ts (话术…CEO).
const BAD = String.fromCharCode(0xfffd);
import { readFileSync, writeFileSync } from "node:fs";
const p = "packages/hub/src/engine/dispatch.ts";
const s = readFileSync(p, "utf8");
const re = new RegExp("\u8BDD\u672F" + BAD + "+CEO");
if (!re.test(s)) {
  console.log("PATTERN_NOT_FOUND");
  process.exit(1);
}
const out = s.replace(re, "\u8BDD\u672F\u5199\u6210\uFF0CCEO");
writeFileSync(p, out);
console.log("REPAIRED remaining_fffd=" + ((out.match(new RegExp(BAD, "g")) ?? []).length));
