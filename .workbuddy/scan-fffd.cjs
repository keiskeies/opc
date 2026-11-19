// round331: scan files for U+FFFD / U+0000 by CONTENT (memory: cjk-write-corruption-in-this-repo
// says `grep -c $'�'` gives a FALSE 0 on this shell, and fatal decoding misses the real
// failure mode entirely because the bytes are legal — the content simply *is* U+FFFD).
// Pure ASCII source. Usage: node scan-fffd.cjs <file> [<file> ...]
const fs = require("fs");

let bad = 0;
for (const p of process.argv.slice(2)) {
	const s = fs.readFileSync(p, "utf8");
	const lines = s.split("\n");
	lines.forEach((line, i) => {
		const fffd = [...line].filter((c) => c.codePointAt(0) === 0xfffd).length;
		const nul = [...line].filter((c) => c.codePointAt(0) === 0).length;
		if (fffd > 0 || nul > 0) {
			bad++;
			console.log(p + ":" + (i + 1) + "  U+FFFD=" + fffd + " NUL=" + nul);
		}
	});
	console.log(p + ": scanned " + lines.length + " lines");
}
console.log(bad === 0 ? "RESULT: clean (0 damaged lines)" : "RESULT: " + bad + " damaged line(s)");
process.exitCode = bad === 0 ? 0 : 1;
