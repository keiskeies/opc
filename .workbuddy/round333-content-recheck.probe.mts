// round333 probe: round332 fixed the 3 prose citations that carried a tense word
// and left 18 classified as "historical" UNCHECKED. It also only ever tested
// whether a line EXISTS (blank / out-of-range) — never whether the line contains
// what the sentence CLAIMS is there.
//
// This probe does the content level for the bounded population of prose citations
// that (a) attach to a SOURCE filename and (b) quote an identifier in backticks
// within the same clause. For those, the claim is machine-checkable WITHOUT any
// tense word: if the sentence says "foo.ts 第 N 行那个 `bar`" and line N does not
// contain `bar`, the sentence is false today regardless of how it's phrased.
// That was the INTENT; the measured reach is narrower, and the ledger (round333)
// records why: the no-space filter below rejects exactly the motivating example —
// `expected.length >= 21` carries spaces, so this machine NEVER flagged 0006:2856.
// The defect was found by a human reading the handcheck probe's output (its
// claimed target line printed against its sentence). Measured run after the fix:
// attached=18, machine-checkable claims=5, all 5 flagged FALSE were probe
// artifacts (claim lives on an adjacent line / range start / the citation talks
// about the citation). A shape with 5/18 reach and 5/5 false positives is
// evidence NOT to promote this into a guard.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const ROOT: string = process.cwd();
const SKIP: RegExp = /^(node_modules|\.git|dist|\.turbo|coverage)$/;

function walk(dir: string, out: string[]): string[] {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (SKIP.test(e.name)) continue;
		const p: string = join(dir, e.name).replace(/\\/g, "/");
		if (e.isDirectory()) walk(p, out);
		else out.push(p);
	}
	return out;
}
const ALL: string[] = walk(".", []);
const SRC: string[] = ALL.filter(
	(p: string): boolean => /\.(ts|tsx|mts|cts|js|mjs|cjs|sql)$/.test(p) && !p.startsWith("docs/") && !p.endsWith(".d.ts"),
);
function resolve(file: string): string {
	const direct: string[] = SRC.filter((p: string): boolean => p === file || p.endsWith("/" + file));
	if (direct.length === 1) return direct[0] as string;
	if (direct.length > 1) return "AMBIG(" + direct.length + ")";
	const b: string = basename(file);
	const byBase: string[] = SRC.filter((p: string): boolean => basename(p) === b);
	return byBase.length === 1 ? (byBase[0] as string) : "NOTFOUND";
}

const ATTACH: RegExp = /([A-Za-z0-9_./-]+\.(?:ts|tsx|mts|cts|js|mjs|cjs|sql))`?[ \t、,，（(「《]{0,3}$/;
const CN: RegExp = /第 ([0-9]+)(?:-([0-9]+))? 行/g;
/** backticked code span; identifier-ish only, to avoid prose in backticks */
const CODE: RegExp = /`([^`\n]{2,60})`/g;
const IDENT: RegExp = /[A-Za-z_$][A-Za-z0-9_$.]{1,40}/;

const docs: string[] = ALL.filter((p: string): boolean => /^docs\/.*\.m(d|js)$/.test(p));
let attached: number = 0;
let withClaim: number = 0;
let mismatch: number = 0;
for (const d of docs) {
	const lines: string[] = readFileSync(d, "utf8").split("\n");
	lines.forEach((l: string, i: number): void => {
		CN.lastIndex = 0;
		let m: RegExpExecArray | null = CN.exec(l);
		while (m !== null) {
			const before: string = l.slice(0, m.index);
			const a: RegExpExecArray | null = ATTACH.exec(before);
			if (a !== null) {
				attached++;
				const file: string = a[1] as string;
				const rel: string = resolve(file);
				const ln: number = Number(m[1]);
				// claimed content: identifier-ish backticked span in the SAME CLAUSE,
				// on EITHER side of the phrase — 0006:2856 reads
				//   `test-inventory.test.ts` 第 174 行那个 `expected.length >= 21`
				// i.e. the claim comes AFTER the number, not before it.
				const cutBack: number = Math.max(
					before.lastIndexOf("。"),
					before.lastIndexOf("；"),
					before.lastIndexOf("|"),
				);
				const afterRaw: string = l.slice(m.index + m[0].length);
				const cutFwdRel: number = afterRaw.search(/[。；|]/);
				const after: string = cutFwdRel === -1 ? afterRaw : afterRaw.slice(0, cutFwdRel);
				const window: string = before.slice(cutBack + 1) + " " + after;
				CODE.lastIndex = 0;
				let c: RegExpExecArray | null = CODE.exec(window);
				let claim: string | null = null;
				while (c !== null) {
					const inner: string = (c as RegExpExecArray)[1] as string;
					// A content claim is code, not a file reference and not prose:
					//  · reject path-like and extension-bearing spans (`http/tokens.ts`)
					//  · reject the attached file's own basename
					//  · reject spans with spaces (those are quoted prose, not a symbol)
					const pathLike: boolean = inner.includes("/") || /\.(ts|tsx|js|mjs|sql|md|yaml|json)$/u.test(inner);
					if (IDENT.test(inner) && !inner.includes(" ") && !pathLike && inner !== basename(file)) claim = inner;
					c = CODE.exec(window);
				}
				if (claim !== null && !rel.startsWith("NOTFOUND") && !rel.startsWith("AMBIG")) {
					withClaim++;
					const src: string[] = readFileSync(join(ROOT, rel), "utf8").split("\n");
					const target: string = src[ln - 1] ?? "<越界 " + src.length + ">";
					const hit: boolean = target.includes(claim);
					if (!hit) mismatch++;
					console.log(
						(hit ? "ok   " : "FALSE ") + d + ":" + (i + 1) + "  «" + file + " 第 " + m[1] + " 行» 声称含 [" + claim + "]" +
							"\n        -> " + rel + ":" + ln + " [" + target.trim().slice(0, 85) + "]",
					);
				}
			}
			m = CN.exec(l);
		}
	});
}
console.log("\nattached=" + attached + "  有可机检的声称内容=" + withClaim + "  当场为假=" + mismatch);
