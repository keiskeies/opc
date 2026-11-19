// round333: hand-check aid for the bounded population of prose citations that
// attach to a SOURCE file (18 of them). Machine detection cannot reach these:
// round333-that-population.probe.mts measured that widening the wording set adds
// 0 hits, because the gate excluding them is the TENSE requirement (0006:2856 has
// no 今天/现在 at all). So: print each one, its target line, and enough context
// for a human to judge whether the sentence's claim still holds. Read-only.
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
	const byBase: string[] = SRC.filter((p: string): boolean => basename(p) === basename(file));
	return byBase.length === 1 ? (byBase[0] as string) : "NOTFOUND";
}
const ATTACH: RegExp = /([A-Za-z0-9_./-]+\.(?:ts|tsx|mts|cts|js|mjs|cjs|sql))`?[ \t、,，（(「《]{0,3}$/;
const CN: RegExp = /第 ([0-9]+)(?:-([0-9]+))? 行/g;

let n = 0;
for (const d of ALL.filter((p: string): boolean => /^docs\/.*\.m(d|js)$/.test(p))) {
	const lines: string[] = readFileSync(d, "utf8").split("\n");
	lines.forEach((l: string, i: number): void => {
		CN.lastIndex = 0;
		let m: RegExpExecArray | null = CN.exec(l);
		while (m !== null) {
			const a: RegExpExecArray | null = ATTACH.exec(l.slice(0, m.index));
			if (a !== null) {
				n++;
				const file: string = a[1] as string;
				const rel: string = resolve(file);
				const ln: number = Number(m[1]);
				let tgt: string;
				if (rel.startsWith("NOTFOUND") || rel.startsWith("AMBIG")) tgt = "<< " + rel;
				else {
					const src: string[] = readFileSync(join(ROOT, rel), "utf8").split("\n");
					const raw: string | undefined = src[ln - 1];
					tgt = raw === undefined ? "<< 越界（文件共 " + src.length + " 行）" : raw.trim().slice(0, 95);
					if (raw !== undefined && raw.trim() === "") tgt = "<< 空行";
				}
				console.log(
					"[" + n + "] " + d + ":" + (i + 1) + "  «" + file + " 第 " + m[1] + (m[2] ? "-" + m[2] : "") + " 行»\n" +
						"    句子: …" + l.trim().slice(Math.max(0, m.index - 60), m.index + 90).trim() + "…\n" +
						"    落点: " + (rel.startsWith("N") || rel.startsWith("A") ? rel : rel + ":" + ln) + " [" + tgt + "]",
				);
			}
			m = CN.exec(l);
		}
	});
}
console.log("\n总数 = " + n);
