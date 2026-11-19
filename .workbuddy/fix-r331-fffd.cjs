// round331 repair: packages/hub/src/http/app.ts line 1298 has one LEFT BLACK LENTICULAR
// BRACKET (U+3010) written as TWO U+FFFD replacement chars, inside a NEW (uncommitted)
// comment block => there is no HEAD copy to splice from, so repair by anchored
// single-run replacement (memory: cjk-write-corruption-in-this-repo).
//
// ZERO literal CJK in this file on purpose: every char below is built from a codepoint,
// so this helper cannot itself be hit by the write-corruption failure mode it repairs.
// (First draft of this file wrote the anchors as literal chars; the Write tool produced
// one U+FFFD inside the helper itself while writing it -- which is the whole reason
// this version is codepoint-only.)
//
// Anchors, by codepoint:
//   U+5728  zai4  "at"
//   U+FFFD  replacement char (x2)      <- the damage
//   U+56DE U+653E U+89C6 U+56FE  "replay view"
//   U+3011 right black lenticular bracket
// Repaired: the two U+FFFD become U+3010 (left black lenticular bracket), matching the
// U+3011 that already closes the phrase and every other such bracket in this repo.
const fs = require("fs");

const p = process.argv[2];
if (!p) {
	console.error("usage: node fix-r331-fffd.cjs <file>");
	process.exit(2);
}

const ZAI = String.fromCharCode(0x5728);
const HUI = String.fromCharCode(0x56de);
const FANG = String.fromCharCode(0x653e);
const SHI = String.fromCharCode(0x89c6);
const TU = String.fromCharCode(0x56fe);
const LBR = String.fromCharCode(0x3010);
const RBR = String.fromCharCode(0x3011);
const BADCHAR = String.fromCharCode(0xfffd);

const BAD = ZAI + BADCHAR + BADCHAR + HUI + FANG + SHI + TU + RBR;
const GOOD = ZAI + LBR + HUI + FANG + SHI + TU + RBR;

const src = fs.readFileSync(p, "utf8");
const before = [...src].filter((c) => c.codePointAt(0) === 0xfffd).length;
const hits = src.split(BAD).length - 1;
if (hits !== 1) {
	console.error("anchor hits = " + hits + " (expected exactly 1); refusing to write");
	process.exit(1);
}
const out = src.replace(BAD, GOOD);
const badOut = [...out].filter((c) => c.codePointAt(0) === 0xfffd).length;
if (badOut !== 0) {
	console.error("still " + badOut + " U+FFFD after replace; refusing to write");
	process.exit(1);
}
fs.writeFileSync(p, out, "utf8");

const check = fs.readFileSync(p, "utf8");
console.log("U+FFFD before: " + before + "  after: " + [...check].filter((c) => c.codePointAt(0) === 0xfffd).length);
console.log("diff in chars: " + ([...check].length - [...src].length));
console.log("the repaired line reads: " + check.split("\n")[1297]);
