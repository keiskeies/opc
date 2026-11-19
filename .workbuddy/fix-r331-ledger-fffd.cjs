// round331: the ledger line I appended describes the grep pattern
//   grep -c $'<REPLACEMENT-CHAR>'
// and the char I wrote there landed as a literal U+FFFD. That is confusing on its own
// (a reader cannot tell "this pattern contains U+FFFD" from "this line is corrupted"),
// and it makes the ENTIRE ledger fail a content scan -- which is the tool we use to find
// real corruption. Rewrite it as the ASCII escape spelling so the file scans clean and
// the sentence still says what it means.
//
// Pure ASCII source on purpose: any CJK typed here could itself get mangled on write
// (memory: cjk-write-corruption-in-this-repo).
const fs = require("fs");

const P = ".workbuddy/AUDIT-LEDGER.txt";
const FFFD = String.fromCharCode(0xfffd);
const SQ = String.fromCharCode(39);
const BT = String.fromCharCode(96);

// what is on disk:  `grep -c $'<FFFD>'`
const FROM = BT + "grep -c $" + SQ + FFFD + SQ + BT;
// what we want:    `grep -c $'�'`   (six literal ASCII chars: backslash u F F F D)
const TO = BT + "grep -c $" + SQ + "\\uFFFD" + SQ + BT;

const before = fs.readFileSync(P, "utf8");
const hits = before.split(FROM).length - 1;
if (hits !== 1) {
	console.error("anchor hits = " + hits + " (need exactly 1) -- NOT WRITING");
	process.exit(1);
}
const after = before.split(FROM).join(TO);

// Assert the result is genuinely clean, not "clean because we deleted the sentence".
const remaining = [...after].filter((c) => c.codePointAt(0) === 0xfffd).length;
if (remaining !== 0) {
	console.error("still " + remaining + " U+FFFD after replace -- NOT WRITING");
	process.exit(1);
}
// 1 char (U+FFFD) -> 6 chars (backslash u F F F D) = +5
if (after.length !== before.length + 5) {
	// length must change by exactly the swap: 1 char -> 6 chars
	console.error(
		"length moved by " + (after.length - before.length) + " (expected +5) -- NOT WRITING",
	);
	process.exit(1);
}
if (!after.includes(TO)) {
	console.error("replacement string not present after write -- NOT WRITING");
	process.exit(1);
}

fs.writeFileSync(P, after);
console.log("ok: rewrote 1 occurrence as the ASCII escape spelling");
console.log("line now reads: " + after.split("\n")[6106]);
