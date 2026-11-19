// Does presentTenseClaim() fire on exactly the sites I intend, and NOT on the
// rule-stating meta line or the drift records? Read-only.
import { decisionRows, presentTenseClaim } from "../test/arch/doc-coords.js";
let n = 0;
for (const r of decisionRows()) {
	r.lines.forEach((l: string, i: number): void => {
		if (presentTenseClaim(l)) {
			n++;
			console.log(r.doc + " l." + (i + 1) + "  " + l.trim().slice(0, 115));
		}
	});
}
console.log("\nfired = " + n);
