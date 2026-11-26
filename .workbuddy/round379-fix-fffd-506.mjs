// U+FFFD repair: the corrupted character is rebuilt from its code point so no
// multibyte text has to survive the transport that corrupted it in the first place.
// Target: group.css line 506, where a run of 3 U+FFFD sits where the char U+90A3 belongs.
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "packages/web/public/group.css";
const LINENO = 506;
const REPLACEMENT = String.fromCharCode(0x90a3); // U+90A3
const FF = String.fromCharCode(0xfffd);

const lines = readFileSync(FILE, "utf8").split("\n");
const line = lines[LINENO - 1];

// Self-check the window: bail rather than guess if the line is not the one we mean.
// Anchors are ASCII-only on purpose: Chinese in this script could itself be corrupted
// by the same transport that produced the U+FFFD.
if (!line.includes("==") || !lines[LINENO - 2].includes("doc-layout.spec.ts")) {
  throw new Error(`Line ${LINENO} is not the intended target: ${line}`);
}
const runs = line.match(new RegExp(FF + "+", "g")) || [];
if (runs.length !== 1 || runs[0].length !== 3) {
  throw new Error(`Expected exactly one run of 3 U+FFFD, got ${runs.length} runs: ${JSON.stringify(runs.map((r) => r.length))}`);
}

const fixed = line.replace(new RegExp(FF + "{3}"), REPLACEMENT);
if (fixed.includes(FF)) throw new Error("U+FFFD still present after fix");
lines[LINENO - 1] = fixed;
writeFileSync(FILE, lines.join("\n"), "utf8");

const text = readFileSync(FILE, "utf8");
const total = (text.match(new RegExp(FF, "g")) || []).length;
console.log(`FIXED line ${LINENO}: ${fixed.trim()}`);
console.log(`FFFD_TOTAL ${total}`);
