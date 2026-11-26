// round358 generic U+FFFD repair: replace the Nth (default: every) run of U+FFFD in a file
// with the codepoints given as hex argv. Keeps every CJK out of the shell and out of
// inline literals that the Edit path has been mangling.
//
// usage: node round358-fix-ffd.mjs <file> <hex> [hex...] [--only-run N]
//   e.g. node round358-fix-ffd.mjs packages/hub/src/engine/work.ts 5728 88c5
import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const f = argv[0];
let onlyRun = 0;
const hexes = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--only-run") {
    onlyRun = Number(argv[i + 1]);
    i += 1;
  } else hexes.push(a);
}
if (hexes.length === 0) throw new Error("need at least one codepoint hex");
const BAD = String.fromCharCode(0xfffd);
const repl = String.fromCodePoint(...hexes.map((h) => Number.parseInt(h, 16)));
const s = readFileSync(f, "utf8");
const runs = s.split(new RegExp(BAD + "+"));
const n = runs.length - 1;
if (n === 0) {
  console.log("NO_FFFD");
} else {
  const out =
    onlyRun === 0
      ? runs.join(repl)
      : runs
          .map((chunk, i) => (i < runs.length - 1 ? (i + 1 === onlyRun ? chunk + repl : chunk + BAD) : chunk))
          .join("");
  writeFileSync(f, out, "utf8");
  const left = (readFileSync(f, "utf8").match(new RegExp(BAD, "g")) ?? []).length;
  console.log("runs=" + String(n), "replaced_with=" + repl, "remaining_fffd=" + String(left));
}
