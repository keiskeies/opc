// round358: replace an exact codepoint sequence in a file. CJK never touches the shell,
// the Edit tool, or an inline literal — everything is hex codepoints passed as argv.
//
// usage: node round358-replace-cp.mjs <file> <from:cp,cp,...> <to:cp,cp,...>
//   e.g. node round358-replace-cp.mjs src/a.ts 9ed8,5955,914d,5c42 88c5,914d,5c42
import { readFileSync, writeFileSync } from "node:fs";

const [f, fromHex, toHex] = process.argv.slice(2);
const cps = (s) => String.fromCodePoint(...s.split(",").map((h) => Number.parseInt(h, 16)));
const from = cps(fromHex);
const to = cps(toHex);
const s = readFileSync(f, "utf8");
const hits = s.split(from).length - 1;
if (hits > 0) writeFileSync(f, s.split(from).join(to), "utf8");
const after = readFileSync(f, "utf8");
console.log(
  "hits=" + String(hits),
  "still_has_from=" + String(after.includes(from)),
  "ffd=" + String((after.match(new RegExp(String.fromCharCode(0xfffd), "g")) ?? []).length),
);
