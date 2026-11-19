// round332 变异机（纯 JS，.mjs 走 node 直跑，别写类型标注）：
// 对 test/arch/doc-coords.ts 的 presentTenseClaim 逐件拆零件，每拆一件跑
// test/arch/doc-coords.test.ts，读【红的用例名】而不只是退出码
// （round300 口径：mustRed 要点名期望用例，否则「红了」这个词可以藏任何东西）。
//
// 预测来自 .workbuddy/round332-mutate-predict.probe.mts 的【量】，不是许愿。
// ⚠ 两条【该绿】的格子同样是判据：一发变异若连范围外的格子一起弄红，说明它是
//   大锤而不是手术刀，抓住了也不能算"这一件零件被钉住"。
//   M0 最初被我写成「真语料也该红」—— 探针量到 alwaysFalse 下 corpus=0，
//   也就是【判据失效时真语料那条照样绿】：这条守卫的"真语料 0 命中"与"判据恒假"
//   在真语料那条上不可区分，唯一的区别是判据用例里那四条正向断言。这件事记进台账。
//   M0 恒假            -> 判据用例红（c1/c4/c6/c7 四条正向断言全断）；真语料仍绿
//   M1 不剥强调标记     -> 判据用例红（c7 的 `第 298 行`就是 漏）；真语料仍绿
//   M2 拆过去时豁免     -> 判据用例红（c3 翻成 true）+ 真语料红（0043@208 命中）
//   M3 拆现在时闸       -> 判据用例红（c8 翻成 true）+ 真语料红（0014@198、0048@298）
//   M4 拆前置措辞臂     -> 判据用例红（c1/c4/c6 漏）；真语料仍绿
//   M5 拆后置措辞臂     -> 判据用例红（c7 漏）；真语料仍绿
//   M6 正则丢区间       -> 判据用例红（c6 漏）；真语料仍绿（95 >= 50 那条下限，量过）
//   M7 取消位置判据     -> 真语料红（0050@465 误伤）+ 判据用例红（c2 翻成 true）
//   M8 扩到冒号形态     -> 判据用例红（c5 翻成 true）+ 真语料红（0051@72、设计文档@1636）
// 任何一发对不上预测 ⇒ 记 MISS 并最终以非零退出，不当「大致符合」。
// 跑完逐字节回滚并复跑基线自证。
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "test/arch/doc-coords.ts");
const SPEC = "test/arch/doc-coords.test.ts";
const ESC = String.fromCharCode(27);
const original = readFileSync(SRC, "utf8");

/**
 * 从 vitest 输出读「红了几发 / 红了哪几发用例名」。**逐字沿用 round331 那一台**：
 * `test/arch/mutation-parser-screen.test.ts` 会拿真 vitest 屏喂每一台
 * `.workbuddy/round*-mutate-*.mjs` 的 readSummary，并要求它归得进两种已知架构之一
 * （计数型 / 并红型）。我自己写的那一版归不进去 —— 那是"换了写法"，守卫要求改机器
 * 而不是改守卫（"别把这一台从语料里排掉来让它过"）。并红型还多一件事我做漏了：
 * 把【文件级】红并进 failed，装载失败那种屏上一个用例都没跑也算红。
 */
function readSummary(out) {
  const clean = out.replace(new RegExp(ESC + "\\[[0-9;]*m", "g"), "");
  if (clean.indexOf(ESC) !== -1) {
    throw new Error("剥 ANSI 没生效（剥完输出里还剩 ESC 字节）—— 摘要行会读不到");
  }
  const m = clean.match(/^\s*Tests\s+(.+)$/m);
  if (m === null) {
    throw new Error(
      "读不到 vitest 的「Tests」摘要行 —— 【不能】当 0 处理：那会把红读成绿。尾部：\n" + clean.slice(-900),
    );
  }
  const seg = m[1] ?? "";
  const failedTests = Number((seg.match(/(\d+) failed/) ?? [0, "0"])[1]);
  const passed = Number((seg.match(/(\d+) passed/) ?? [0, "0"])[1]);
  const files = new Set();
  const tests = new Set();
  for (const line of clean.split("\n")) {
    const fm = /^\s*FAIL\s+(\S+\.(?:ts|tsx))\b/u.exec(line);
    if (fm === null || fm[1] === undefined) continue;
    files.add(fm[1].split("\\").join("/"));
    const gt = line.indexOf(">");
    if (gt >= 0) {
      const name = line.slice(gt + 1).split(">").pop().trim();
      if (name !== "") tests.add(name);
    }
  }
  const tf = clean.match(/^\s*Test Files\s+(.+)$/m);
  if (tf === null) {
    throw new Error("读不到「Test Files」摘要行 —— 同「Tests」那条纪律。尾部：\n" + clean.slice(-500));
  }
  const failedFiles = Number((tf[1].match(/(\d+) failed/) ?? [0, "0"])[1]);
  if (failedFiles > 0 && files.size === 0) {
    throw new Error("有文件红了但【读不到 FAIL 行的文件名】⇒ 归因失真。尾部：\n" + clean.slice(-900));
  }
  return { failed: failedTests + failedFiles, failedTests, failedFiles, passed, files, tests };
}

function run() {
	const r = spawnSync(
		process.execPath,
		[join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", SPEC],
		{
			cwd: ROOT,
			encoding: "utf8",
			timeout: 420000,
			maxBuffer: 64 * 1024 * 1024,
			shell: process.platform === "win32",
		},
	);
	// 正对照：spawn 本身失败（ENOENT 之类）时 stdout/stderr 可能双双为空，
	// 而空输出【不等于】全绿 —— 这条机器的整个前提就是这两件事必须分得开。
	if (r.error) throw new Error("spawn 失败: " + String(r.error.message));
	const got = readSummary(String(r.stdout) + String(r.stderr));
	return Object.assign({}, got, { red: got.failed > 0, summary: "failed=" + got.failed + " passed=" + got.passed });
}

function anchor(hay, needle) {
	const n = hay.split(needle).length - 1;
	if (n !== 1) throw new Error("锚点命中 " + n + "（需要恰好 1）: " + needle.slice(0, 60));
}

// 用例名【逐字】抄自 test/arch/doc-coords.test.ts 的 it("…")，归因用精确集合相等。
const G = "presentTenseClaim 判据本身有判别力（否则本节是恒绿装饰）";
const C = "真语料：决策文档与非决策 markdown 里都没有【汉字形态的现在时位置主张】";

const MUTS = [
	{
		id: "M0 恒假（判据整个失效）",
		from: "export function presentTenseClaim(line: string | undefined): boolean {\n  if (line === undefined) return false;",
		to: "export function presentTenseClaim(line: string | undefined): boolean {\n  if (line !== undefined) return false;\n  if (line === undefined) return false;",
		mustRedTests: [G],
		mustGreenTests: [C],
	},
	{
		id: "M1 不剥强调/代码标记",
		from: 'const bare: string = line.replace(/`|\\*/gu, "");',
		to: "const bare: string = line;",
		mustRedTests: [G],
		mustGreenTests: [C],
	},
	{
		id: "M2 拆过去时豁免",
		from: "if (!NOW_RE.test(line) || THEN_RE.test(line)) return false;",
		to: "if (!NOW_RE.test(line)) return false;",
		mustRedTests: [G, C],
		mustGreenTests: [],
	},
	{
		id: "M3 拆现在时闸",
		from: "if (!NOW_RE.test(line) || THEN_RE.test(line)) return false;",
		to: "if (THEN_RE.test(line)) return false;",
		mustRedTests: [G, C],
		mustGreenTests: [],
	},
	{
		id: "M4 拆前置措辞臂（只剩后置）",
		from: "      POS_BEFORE.test(bare.slice(0, m.index)) ||\n      POS_AFTER.test(bare.slice(m.index + m[0].length))",
		to: "      POS_AFTER.test(bare.slice(m.index + m[0].length))",
		mustRedTests: [G],
		mustGreenTests: [C],
	},
	{
		id: "M5 拆后置措辞臂（只剩前置）",
		from: "      POS_BEFORE.test(bare.slice(0, m.index)) ||\n      POS_AFTER.test(bare.slice(m.index + m[0].length))",
		to: "      POS_BEFORE.test(bare.slice(0, m.index))",
		mustRedTests: [G],
		mustGreenTests: [C],
	},
	{
		id: "M6 正则丢区间分支",
		from: "export const CN_LINE_RE: RegExp = /第 ([0-9]+)(?:-[0-9]+)? 行/g;",
		to: "export const CN_LINE_RE: RegExp = /第 ([0-9]+) 行/g;",
		mustRedTests: [G],
		mustGreenTests: [C],
	},
	{
		id: "M7 取消位置判据（有词就报）",
		from: "  let m: RegExpExecArray | null = CN_LINE_RE.exec(bare);\n  while (m !== null) {",
		to: "  CN_LINE_RE.lastIndex = 0;\n  if (CN_LINE_RE.test(bare)) return true;\n  let m: RegExpExecArray | null = CN_LINE_RE.exec(bare);\n  while (m !== null) {",
		mustRedTests: [G, C],
		mustGreenTests: [],
	},
	{
		id: "M8 汉字判据扩到冒号形态",
		from: "export const CN_LINE_RE: RegExp = /第 ([0-9]+)(?:-[0-9]+)? 行/g;",
		to: "export const CN_LINE_RE: RegExp =\n  /第 ([0-9]+)(?:-[0-9]+)? 行|[A-Za-z0-9_./-]+[.]tsx?:[0-9]+/g;",
		mustRedTests: [G, C],
		mustGreenTests: [],
	},
];

let fails = 0;
const lines = [];
try {
	const base = run();
	lines.push("基线: " + base.summary);
	if (base.failed > 0) throw new Error("基线不绿，变异矩阵的读数没有意义");
	for (const mu of MUTS) {
		anchor(original, mu.from);
		writeFileSync(SRC, original.replace(mu.from, mu.to));
		let r;
		try {
			r = run();
		} catch (e) {
			lines.push(mu.id.padEnd(30) + "跑挂了（不当「没抓住」）: " + String(e.message).slice(0, 160));
			fails++;
			continue;
		} finally {
			writeFileSync(SRC, original);
		}
		// 逐字沿用 round331 的归因口径：用例名【精确集合相等】而不是"包含"。
		// 用"包含"的话，一条永不出现的名字也会被判成"没漏"，mustRed 就退化成永假判据。
		const missRed = mu.mustRedTests.filter((t) => !r.tests.has(t));
		const hitGreen = mu.mustGreenTests.filter((t) => r.tests.has(t));
		const restored = readFileSync(SRC, "utf8") === original;
		const ok = missRed.length === 0 && hitGreen.length === 0 && restored;
		if (!ok) fails++;
		const redNames = [...r.tests];
		lines.push(
			(ok ? "✓ " : "✗ ") +
				mu.id.padEnd(28) +
				"red=" + r.red + " 用例红=" + r.failedTests + " 文件红=" + r.failedFiles + " passed=" + r.passed +
				"\n     红名=" + JSON.stringify(redNames) +
				(missRed.length ? "\n     ★ 预测该红而没红：" + missRed.join(" | ") : "") +
				(hitGreen.length ? "\n     ★ 预测该绿而红了：" + hitGreen.join(" | ") : "") +
				(restored ? "" : "\n     ★★ 还原失败！盘上字节与进场不同 —— 后续读数全部作废"),
		);
	}
} finally {
	writeFileSync(SRC, original);
}
if (readFileSync(SRC, "utf8") !== original) throw new Error("回滚后字节不一致！");
const post = run();
lines.push("回滚后基线: " + post.summary);
if (post.failed > 0) throw new Error("回滚后基线不绿");
lines.push(fails === 0 ? "RESULT: 九发全部对上预测" : "RESULT: " + fails + " 发对不上预测");
const report = lines.join("\n");
console.log(report);
writeFileSync(".workbuddy/round332-mutate-claim.txt", report + "\n");
process.exit(fails === 0 ? 0 : 1);
