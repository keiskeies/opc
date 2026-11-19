// round334: 0062 §2 那张表落库【当时】（ffae248），author-reviewer.ts 文件内
// 到底有没有这三个组合调用点？若有，「0 调用点」在写下那天就是跨文件口径。只读。
import { execFileSync } from "node:child_process";
const NAMES: string[] = [
	"forbiddenRemovalAttempt",
	"unauthorizedAttemptPayload",
	"selfReviewEdgeBlock",
	"independentReviewerPath",
	"gateConfigBlock",
	"sameFamilyReviewBlock",
];
function show(commit: string, path: string): string {
	return execFileSync("git", ["show", commit + ":" + path], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}
for (const [tag, path] of [
	["ffae248 author-reviewer", "packages/hub/src/graph/gates/author-reviewer.ts"],
	["ffae248 verifier", "packages/hub/src/harness/verifier.ts"],
] as [string, string][]) {
	const src: string = show(tag.startsWith("ffae248") ? "ffae248" : "HEAD", path);
	const lines: string[] = src.split("\n");
	console.log("═══ " + tag + "（共 " + lines.length + " 行）═══");
	for (const n of NAMES) {
		const call: RegExp = new RegExp("\\b" + n + "\\s*\\(", "u");
		const hits: string[] = [];
		lines.forEach((x: string, i: number): void => {
			const t: string = x.trim();
			if (!call.test(x)) return;
			if (/^export (async )?function /u.test(t)) return;
			if (/^(\*|\/\/|\/\*)/u.test(t)) return;
			hits.push(i + 1 + ": " + t.slice(0, 72));
		});
		console.log("  " + n + " 调用点 " + hits.length);
		hits.forEach((h: string): void => console.log("    " + h));
	}
}
