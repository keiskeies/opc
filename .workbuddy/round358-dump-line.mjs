// round358: locate U+FFFD occurrences without putting the char in a file literal.
const BAD = String.fromCharCode(0xfffd);
import { readFileSync } from "node:fs";
const p = process.argv[2] ?? "packages/hub/src/engine/dispatch.ts";
const lines = readFileSync(p, "utf8").split("\n");
lines.forEach((l, i) => {
  if (!l.includes(BAD)) return;
  console.log("LINE " + (i + 1));
  console.log(JSON.stringify(l));
});
