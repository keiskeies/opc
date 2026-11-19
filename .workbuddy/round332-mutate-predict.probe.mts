// round332 — FINAL mutation predictions with strictly ONE-SIDED gate removal.
// Earlier passes conflated "remove the NOW requirement" with "remove the THEN
// exemption": two different ways to break the same line that must produce two
// different observable reds, or the machine would grade one defect twice.
//
// Semantics of each variant (exactly one clause of the real predicate removed):
//   base           — the predicate as committed
//   alwaysFalse    — function gutted (catches "guard silently disabled")
//   noStrip        — stop stripping ` and ** before matching position words
//   noThenExempt   — keep requiring a now-word; DROP the past-tense exemption
//   noNowGate      — keep the past-tense exemption; DROP the now-word requirement
//   dropBefore     — only the trailing POS_AFTER wording can trigger
//   dropAfter      — only the leading POS_BEFORE wording can trigger
//   noRange        — CN regex loses its "-NNN" range branch
//   noPosAtAll     — any 第N行 + tense fires (positional wording check removed)
//   broadenToColon — 汉字 test also accepts colon form (rule inversion)
import { decisionRows, markdownRows } from "../test/arch/doc-coords.js";

const NOW: RegExp = /(今天|如今|此刻|目前|现在)/;
const THEN: RegExp =
	/(当时|当年|那时|此前|曾|原本|原写|原是|原来|后来|漂|挪|顶|改成|改为|旧|那一版|写作|一度|修之前|改之前)/;
const POS_BEFORE: RegExp = /(在|落在|位于|处在)\s*$/;
const POS_AFTER: RegExp = /^\s*(就是|才是|即|写的是|住的是|装的是)/;
const CN: RegExp = /第 ([0-9]+)(?:-[0-9]+)? 行/g;
const CN_NORANGE: RegExp = /第 ([0-9]+) 行/g;
const CN_BROAD: RegExp = /第 ([0-9]+)(?:-[0-9]+)? 行|[A-Za-z0-9_./-]+\.(?:ts|tsx|mts|js|mjs|sql):[0-9]+/g;

function fires(line: string, v: string): boolean {
	if (v === "alwaysFalse") return false;
	if (v !== "noNowGate" && !NOW.test(line)) return false; // NOW gate
	if (v !== "noThenExempt" && THEN.test(line)) return false; // THEN exemption
	const bare: string = v === "noStrip" ? line : line.replace(/`|\*/gu, "");
	const re: RegExp = v === "noRange" ? CN_NORANGE : v === "broadenToColon" ? CN_BROAD : CN;
	re.lastIndex = 0;
	if (v === "noPosAtAll") return re.test(bare);
	let m: RegExpExecArray | null = re.exec(bare);
	while (m !== null) {
		const b: boolean = v !== "dropBefore" && POS_BEFORE.test(bare.slice(0, m.index));
		const a: boolean = v !== "dropAfter" && POS_AFTER.test(bare.slice(m.index + m[0].length));
		if (b || a) return true;
		m = re.exec(bare);
	}
	return false;
}

// FINAL case battery — exactly what the test file will contain, in order.
const CASES: Array<[string, boolean]> = [
	["那条 `applyDecision`（现在在第 298 行）只被走到。", true], // c1
	["> 快照会把「第 108 行现在的内容」当成本篇的主张来钉。", false], // c2
	["原写的是「那条（现在在第 298 行）」这一句。", false], // c3
	["> 今天 `X` 在 runtime.ts **第 110 行**、`Y` 在第 134 行，", true], // c4
	["今天 `REJECTION_COUNT_SQL` 在 runtime.ts:110。", false], // c5
	["现在落在第 269-275 行那一段。", true], // c6
	["今天的落点：`第 298 行`就是那句 INSERT。", true], // c7
	["坐标 `recorder.ts` 落在第 249 行，同因；", false], // c8 blind-spot pin
];

const ROWS = [...decisionRows(), ...markdownRows()];
for (const v of [
	"base",
	"alwaysFalse",
	"noStrip",
	"noThenExempt",
	"noNowGate",
	"dropBefore",
	"dropAfter",
	"noRange",
	"noPosAtAll",
	"broadenToColon",
]) {
	const hits: string[] = [];
	for (const r of ROWS)
		r.lines.forEach((l: string, i: number): void => {
			if (fires(l, v)) hits.push(r.doc.slice(0, 4).replace(/\W/g, "") + "@" + (i + 1));
		});
	const flipped: string[] = [];
	CASES.forEach((c: [string, boolean], i: number): void => {
		if (fires(c[0], v) !== c[1]) flipped.push("c" + (i + 1));
	});
	const hitStr: string = hits.length === 0 ? "" : "(" + hits.slice(0, 6).join(",") + ")";
	console.log(
		v.padEnd(15) +
			"corpus=" +
			String(hits.length).padEnd(2) +
			hitStr.padEnd(46) +
			"flips=" +
			(flipped.length ? flipped.join(",") : "NONE"),
	);
}
// self-check of the battery itself: no case may be a decoration
let dec: number = 0;
CASES.forEach((c: [string, boolean], i: number): void => {
	const kills: string[] = ["alwaysFalse", "noStrip", "noThenExempt", "noNowGate", "dropBefore", "dropAfter", "noRange", "noPosAtAll", "broadenToColon"].filter(
		(v: string): boolean => fires(c[0], v) !== c[1],
	);
	if (kills.length === 0) dec++;
	console.log("c" + (i + 1) + " kills: " + (kills.join(",") === "" ? "***DECORATION***" : kills.join(",")));
});
console.log("decorations = " + dec);
