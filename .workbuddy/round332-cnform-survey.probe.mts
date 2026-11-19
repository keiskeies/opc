// round332 probe v2 (read-only): size the population of prose-form ("第 N 行")
// line citations that assert a SOURCE coordinate, and classify each by whether
// the surrounding text marks it as PAST (a drift record) or PRESENT (a live claim).
//
// Why the tight gap: v1 attached "第 605 行" in
//   `test/e2e/ceo-loop.spec.ts`。第 605 行（Task 4.7）写作 ...
// across a full stop. That number is a PLAN-document line, not a spec line — the
// filename and the number are different noun phrases. A noun phrase allows
// whitespace and inline-code backticks, never a sentence terminator. So the gap
// between the filename and 第 must contain no 。；!? and stay short.
//
// Why the past-tense split: docs in this repo deliberately keep the OLD coordinate
// visible when reporting a drift ("第 239 行 → 第 249 行", "后来漂到了第 258 行").
// Those records are CORRECT even when the old line is now blank or out of range —
// re-pointing them would destroy the evidence. A live claim ("第 237 行就是那句
// INSERT") is the opposite: it asserts what is there TODAY, so it can be wrong, and
// today no guard can see it. This probe counts both so the rule can be written
// against a measured population instead of an impression.
import { readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";

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
	(p: string): boolean =>
		/\.(ts|tsx|mts|cts|js|mjs|cjs|sql)$/.test(p) &&
		!p.startsWith("docs/") &&
		!p.endsWith(".d.ts"),
);

function resolve(file: string): string {
	const direct: string[] = SRC.filter((p: string): boolean => p === file || p.endsWith("/" + file));
	if (direct.length === 1) return direct[0] as string;
	if (direct.length > 1) return "AMBIGUOUS(" + direct.length + ")";
	const b: string = basename(file);
	const byBase: string[] = SRC.filter((p: string): boolean => basename(p) === b);
	return byBase.length === 1 ? (byBase[0] as string) : "NOTFOUND";
}

/** filename + optional inline-code/space gap, immediately before 第 N 行 */
const ATTACH: RegExp =
	/([A-Za-z0-9_./-]+\.(?:ts|tsx|mts|cts|js|mjs|cjs|sql))`?[ \t、,，（(「「《]{0,3}$/;
const CN: RegExp = /第 ([0-9]+)(?:-([0-9]+))? 行/g;
/** markers that put the number in the PAST tense (a record, not a claim) */
const PAST: RegExp =
	/(曾|原来|原是|原本|此前|当时|此前|后来|漂|挪|顶|改成|改为|改过|写成|原本写|原写|旧|当年|那一版|曾经|一度|曾落|曾经落|曾经指|当年的|它曾|此前写|原本指)/;

const docs: string[] = ALL.filter((p: string): boolean => /^docs\/.*\.m(d|js)$/.test(p));
type Row = {
	at: string;
	target: string;
	ln: string;
	kind: string;
	note: string;
};
const rows: Row[] = [];
let barePhrase: number = 0;

for (const d of docs) {
	const lines: string[] = readFileSync(d, "utf8").split("\n");
	lines.forEach((l: string, i: number): void => {
		CN.lastIndex = 0;
		let m: RegExpExecArray | null = CN.exec(l);
		while (m !== null) {
			const idx: number = m.index;
			const before: string = l.slice(0, idx);
			const after: string = l.slice(idx + m[0].length, idx + m[0].length + 40);
			const a: RegExpExecArray | null = ATTACH.exec(before);
			if (a === null) {
				barePhrase++;
				m = CN.exec(l);
				continue;
			}
			const file: string = a[1] as string;
			const rel: string = resolve(file);
			const ln: number = Number(m[1]);
			const window: string = l.slice(Math.max(0, idx - 70), idx) + after;
			const marked: boolean = PAST.test(window);
			let kind: string = "ok";
			let note: string = "";
			if (rel.startsWith("NOTFOUND") || rel.startsWith("AMBIG")) {
				kind = rel.startsWith("AMBIG") ? "ambiguous" : "nofile";
			} else {
				const src: string[] = readFileSync(join(ROOT, rel), "utf8").split("\n");
				const raw: string | undefined = src[ln - 1];
				if (raw === undefined) kind = "out_of_range(" + src.length + ")";
				else if (raw.trim() === "") kind = "blank";
				note = (raw ?? "").trim().slice(0, 60);
			}
			rows.push({
				at: d + ":" + (i + 1),
				target: rel + ":" + ln,
				ln: m[1] as string + (m[2] ? "-" + m[2] : ""),
				kind: (marked ? "PAST/" : "LIVE/") + kind,
				note,
			});
			m = CN.exec(l);
		}
	});
}

const tally: Map<string, number> = new Map();
for (const r of rows) tally.set(r.kind, (tally.get(r.kind) ?? 0) + 1);
for (const r of rows) console.log(r.kind.padEnd(22) + r.at + "  " + r.target + "  [" + r.note + "]");
console.log("\nattached=" + rows.length + "  bare-phrase(no filename) =" + barePhrase);
console.log("tally:");
for (const [k, v] of [...tally.entries()].sort()) console.log("  " + k.padEnd(22) + v);
