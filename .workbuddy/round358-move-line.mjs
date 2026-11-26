// Move a contiguous line range (1-based, inclusive) to just before another line,
// without touching any bytes in between. Pure rearrangement: no new text, no CJK risk.
// usage: node round358-move-line.mjs <file> <start> <end> <insertBefore>
import { readFileSync, writeFileSync } from "node:fs";
const [f, a, b, before] = process.argv.slice(2);
const src = readFileSync(f, "utf8");
const nl = src.endsWith("\n") ? "\n" : "";
const body = nl === "" ? src : src.slice(0, -1);
const lines = body.split("\n");
const [s, e, ins] = [a, b, before].map((x) => Number.parseInt(x, 10));
const moved = lines.slice(s - 1, e);
if (moved.length !== e - s + 1) {
  console.log("ABORT range_out_of_bounds");
  process.exit(1);
}
if (ins > s && ins <= e) {
  console.log("ABORT insert_inside_range");
  process.exit(1);
}
const rest = [...lines.slice(0, s - 1), ...lines.slice(e)];
const shift = ins > e ? -(e - s + 1) : 0;
const at = ins - 1 + shift;
const out = [...rest.slice(0, at), ...moved, ...rest.slice(at)];
writeFileSync(f, out.join("\n") + nl, "utf8");
console.log(
  "MOVED n=" + String(moved.length),
  "before_line=" + String(ins),
  "ffd=" + String((out.join("\n").match(new RegExp(String.fromCharCode(0xfffd), "g")) ?? []).length),
);
