// round332 probe v3 (read-only): sizes ONE narrow population — prose-form
// ("第 N 行") citations sitting in a sentence that asserts TODAY's position
// ("今天" / "现在" / "此刻" / "目前").
//
// Why this predicate and not "extract every prose citation and snapshot it":
//   0050 §6.5 and 0051 §2(b) make an explicit house decision —
//     断言今天的位置  ⇒ `file:123`  (belongs in doc-refs' SNAP)
//     陈述当时是什么  ⇒ 汉字「第 N 行」(deliberately OUT of SNAP)
//   So a 第 N 行 citation is exempt *because* it reads as past tense. A sentence
//   that says 今天/现在 is not making a historical statement: by the repo's own
//   口径 it belongs on the snapshot side, and the exemption is the hole.
//   That makes "today-marker present" the decidable half of the rule — it needs
//   no filename resolution, which is the half my v1 probe got wrong (it attached
//   "第 605 行" across a full stop to a .spec.ts file, when the number was a
//   PLAN-document line; a guard built on that attachment would manufacture the
//   very phantom defect 0006 §7 records an earlier round producing).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

const CN: RegExp = /第 [0-9]+(?:-[0-9]+)? 行/g;
/** present-tense markers, checked line-wide (broad set — re-measured, not assumed) */
const NOW: RegExp = /(今天|如今|此刻|目前|现在)/;
/** explicit past markers; any one of them exempts the whole line (measured blind spot) */
const THEN: RegExp =
	/(当时|当年|那时|此前|曾|原本|原写|原是|原来|后来|漂|挪|顶|改成|改为|旧|那一版|写作|一度|修之前|改之前)/;
/** 【撤回】-prefixed lines are exempt by existing house rule (doc-coords.isRetracted) */
const RETRACTED: RegExp = /^[\s>]*【撤回】/;

const docs: string[] = walk("docs", []).filter((p: string): boolean => /^docs\/.*\.md$/.test(p));
let hits: number = 0;
let cnTotal: number = 0;
let retracted: number = 0;
for (const d of docs) {
	const lines: string[] = readFileSync(d, "utf8").split("\n");
	lines.forEach((l: string, i: number): void => {
		CN.lastIndex = 0;
		let m: RegExpExecArray | null = CN.exec(l);
		while (m !== null) {
			cnTotal++;
			if (RETRACTED.test(l)) {
				retracted++;
				m = CN.exec(l);
				continue;
			}
			// window: from the previous sentence terminator to the next one
			const start: number = Math.max(
				l.lastIndexOf("。", m.index),
				l.lastIndexOf("；", m.index),
				l.lastIndexOf("；", m.index),
			);
			const endRel: number = l.slice(m.index).search(/[。；\n]/);
			const end: number = endRel === -1 ? l.length : m.index + endRel;
			const sentence: string = l.slice(start + 1, end);
			const now: boolean = NOW.test(sentence);
			const then: boolean = THEN.test(sentence);
			if (now && !then) {
				hits++;
				console.log(
					"NOW  " + d + ":" + (i + 1) + "  «" + (m as RegExpExecArray)[0] + "»  | " + sentence.trim().slice(0, 110),
				);
			} else if (now && then) {
				console.log(
					"AMBIG " + d + ":" + (i + 1) + "  «" + (m as RegExpExecArray)[0] + "»  | " + sentence.trim().slice(0, 110),
				);
			}
			m = CN.exec(l);
		}
	});
}
console.log(
	"\n第N行 phrases total=" + cnTotal + "  撤回-line exempt=" + retracted + "  NOW-without-THEN=" + hits,
);
