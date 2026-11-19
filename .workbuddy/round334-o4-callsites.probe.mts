// round334 探针：0062 §2 那张「5 个零调用点」表的【口径】到底是什么？
// 疑点：grep 今天能直接看到 author-reviewer.ts 内部有三处组合调用
//   :213 sameFamilyReviewBlock、:215 selfReviewEdgeBlock、:183 independentReviewerPath
// 而 0062 把后两个记成 0、把第一个记成 1。三处组合的字节在 0e2f2c9（2026-11-10）
// 就在，早于 round271 —— 所以这不是"表落库后代码变了"，是表【数的时候就没数它们】。
// 本探针把两种口径分开数：全调用点 vs 排除定义文件自身。只读。
// 阳性对照：runTimeoutPass（已知跨文件被 serve/assemble.ts 调）与
// reviewGate（已知在 dispatch.ts 同文件被调）—— 任一数不出来就 exit 4。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT: string = process.cwd();
const SEVEN: string[] = [
	"sameFamilyReviewBlock",
	"evaluateGate",
	"gateConfigBlock",
	"selfReviewEdgeBlock",
	"independentReviewerPath",
	"forbiddenRemovalAttempt",
	"unauthorizedAttemptPayload",
];
function walk(dir: string, out: string[]): string[] {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.name === "node_modules" || e.name === "dist" || e.name === ".turbo") continue;
		const p: string = join(dir, e.name).replace(/\\/g, "/");
		if (e.isDirectory()) walk(p, out);
		else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
	}
	return out;
}
const SRC: string[] = walk(join(ROOT, "packages"), []).filter((p: string): boolean => p.includes("/src/"));

type Hit = { file: string; ln: number; line: string; comment: boolean; def: boolean; call: boolean };
function refs(name: string): Hit[] {
	const out: Hit[] = [];
	for (const p of SRC) {
		const lines: string[] = readFileSync(p, "utf8").split("\n");
		lines.forEach((l: string, i: number): void => {
			if (!new RegExp("\\b" + name + "\\b", "u").test(l)) return;
			const trimmed: string = l.trim();
			const comment: boolean = trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("//") || trimmed.startsWith("*/");
			const def: boolean = new RegExp("^export (async )?function " + name + "\\b", "u").test(trimmed);
			const call: boolean = !comment && !def && new RegExp("\\b" + name + "\\s*\\(", "u").test(l);
			out.push({ file: p.replace(ROOT.replace(/\\/g, "/") + "/", ""), ln: i + 1, line: trimmed.slice(0, 80), comment, def, call });
		});
	}
	return out;
}
// 阳性对照
const ctrl1: number = refs("runTimeoutPass").filter((h: Hit): boolean => h.call && !h.file.includes("approvals/timeout.ts")).length;
const ctrl2: number = refs("reviewGate").filter((h: Hit): boolean => h.call).length;
if (ctrl1 < 1 || ctrl2 < 1) {
	console.log("阳性对照红：runTimeoutPass 跨文件调用=" + ctrl1 + " reviewGate 调用=" + ctrl2 + " ⇒ 数法坏了，0 读数不可信");
	process.exit(4);
}
console.log("阳性对照绿：runTimeoutPass 跨文件 " + ctrl1 + " / reviewGate 总调用 " + ctrl2 + "\n");

for (const name of SEVEN) {
	const rs: Hit[] = refs(name);
	const defs: Hit[] = rs.filter((h: Hit): boolean => h.def);
	const calls: Hit[] = rs.filter((h: Hit): boolean => h.call);
	const defFiles: Set<string> = new Set(defs.map((h: Hit): string => h.file));
	const cross: Hit[] = calls.filter((h: Hit): boolean => !defFiles.has(h.file));
	console.log("═══ " + name + " ═══");
	console.log("  定义: " + (defs.map((h: Hit): string => h.file + ":" + h.ln).join(", ") || "（无 ⇒ 已删）"));
	console.log("  调用点 全部=" + calls.length + "  跨文件=" + cross.length + "  定义文件内=" + (calls.length - cross.length));
	for (const h of calls) console.log("    " + (defFiles.has(h.file) ? "同文件 " : "跨文件 ") + h.file + ":" + h.ln + "  " + h.line);
}
