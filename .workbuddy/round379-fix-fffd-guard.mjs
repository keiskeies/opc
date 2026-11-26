// Repair U+FFFD runs left by the file-writing transport. Each replacement char is
// rebuilt from its code point so no Chinese has to survive transport. ASCII-only source.
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "test/web/compact-scale.test.ts";
const FF = String.fromCharCode(0xfffd);

// line (1-based) -> intended code point replacing the run of U+FFFD on that line
const FIX = new Map([
  [53, 0x7b49], // deng  (equal-length)
  [260, 0x7a84], // zhai  (narrower)
  [350, 0x7f1d], // feng  (seam/gap)
]);

const lines = readFileSync(FILE, "utf8").split("\n");
for (const [no, cp] of FIX) {
  const line = lines[no - 1] ?? "";
  const runs = line.match(new RegExp(FF + "+", "gu")) || [];
  if (runs.length !== 1) throw new Error(`line ${no}: expected 1 corrupted run, got ${runs.length}`);
  lines[no - 1] = line.replace(new RegExp(FF + "+", "gu"), String.fromCharCode(cp));
  console.log(`FIXED ${no}: ${lines[no - 1].trim()}`);
}
writeFileSync(FILE, lines.join("\n"), "utf8");
const total = ((readFileSync(FILE, "utf8").match(new RegExp(FF, "gu")) || []).length);
console.log("FFFD_TOTAL " + total);
