/**
 * 只读定位器：把 doc-refs 报红的坐标，按【快照文本】在目标源码里重新找一遍行号。
 *
 * ⚠ 它【不写】任何文件。doc-refs.test.ts 的文件头明写「不要写自动重写快照的脚本：
 * 那等于把这条守卫变成它要防止的东西」—— 那说的是【自动改 SNAP】。本脚本只回答
 * 「那一句话现在在第几行」；改 SNAP 与改文档里那个行号仍是一处一人手工的动作，
 * 而且那一步含一个机器做不了的判断：那句引用【还成不成立】——
 * 锚点可能确实被人删了，那时该改的是文档那句话，而不是把行号挪过去让它重新对上。
 *
 * 用法：npx tsx .workbuddy/find-docref-lines.mjs
 * 每格输出：旧坐标 → 匹配数。只有【恰好一处】才给新行号；
 * 0 处（锚点没了）与多处（挑哪一处是判断）一律标「需人工」。
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "test", "arch", "doc-refs.test.ts"), "utf8");
const start = src.indexOf("const SNAP: Record<string, string> = {");
const end = src.indexOf("\n};", start);
if (start < 0 || end < 0) throw new Error("读不到 SNAP 那一段（改名了？）");

// 键一律双引号，值【单双引号都有】（`'consumed_cents: Number(r["consumed_cents"] ?? 0),'`
// 那种内含双引号的就用单引号包 —— 第一版只认双引号值，于是这类全漏，
// 还对其中两条报了「SNAP 里没有这个键」这句【假话】：键在盘上（336 / 917 行）。
// ⇒ 解析器的漏读配上断言式文案，读起来就成了「那条不存在」。
// 现在两种引号都解，且文案改成「本脚本没解析到」—— 只说自己读到了什么，不宣布它没有。
const block = src.slice(start, end);
const pairs = [
  ...block.matchAll(/"([^"\n]+)"\s*:\s*\n?\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)')/g),
];
// 单引号值里可以出现【裸双引号】（0015 那条就是 `Number(r["consumed_cents"] ?? 0)`），
// 所以不能一律塞回 JSON.parse：那会在第一个内层双引号处炸，或在错误位置静默截断。
// 只解 TS 字面量里真会出现的那几种转义，其余按原样。
const decode = (raw) =>
  raw.replace(/\\(["'\\nt])/g, (_, c) =>
    c === "n" ? "\n" : c === "t" ? "\t" : c,
  );
const snap = new Map(pairs.map(([, k, dq, sq]) => [k, decode(dq ?? sq)]));
console.log(`SNAP 解析出 ${snap.size} 条键值（守卫自报登记 152 条，差额=本脚本解析面）\n`);

// 本轮报红的 15 格，【逐字取自 .workbuddy/agent-docrefs.txt】（2026-11-19 现跑）。
// ⚠ 第一版这里是【我按文档标题猜的键】，结果 10 格报「SNAP 里没有这个键」。
// 键里的文件部分【就是文档里写的那个子串】（doc-refs.test.ts:110 keyOf = doc+">"+file+":"+ln，
// 而 file 是正则原文匹配），可能是全路径也可能只有基名，猜不出来。
// 更贵的是我当时那句「按后缀找」的兜底：它把 0030 的 `contracts/src/api.ts:40`
// 匹到了【0012 的同名同行键】—— 两条键 `>…:40` 的后缀逐字相同。
// 一个能匹上的兜底把一个真缺口读成了「已定位」，比直接报错贵（本仓记过多次那一族）。
const STALE = [
  "INDEX.md>app.ts:441",
  "INDEX.md>assemble.ts:274",
  "INDEX.md>app.js:675",
  "0012-org-versioned-commit-and-unwritten-graph-version.md>packages/contracts/src/api.ts:40",
  "0012-org-versioned-commit-and-unwritten-graph-version.md>packages/contracts/src/api.ts:99",
  "0015-charter-editor-and-two-sources-of-budget.md>http/app.ts:1091",
  "0030-im-binding-identity-and-three-holes-i-did-not-design.md>contracts/src/api.ts:40",
  "0030-im-binding-identity-and-three-holes-i-did-not-design.md>contracts/src/api.ts:73",
  "0030-im-binding-identity-and-three-holes-i-did-not-design.md>app.ts:539",
  "0037-worker-import-in-threads-and-my-first-fix-was-wrong.md>assemble.ts:460",
  "0042-today-view-and-putting-the-criteria-on-the-server-side.md>packages/web/public/app.js:445",
  "0050-abandoned-task-never-resumes-and-a-knob-that-does-not-exist.md>assemble.ts:290",
  "0050-abandoned-task-never-resumes-and-a-knob-that-does-not-exist.md>assemble.ts:1913",
  "0050-abandoned-task-never-resumes-and-a-knob-that-does-not-exist.md>app.js:528",
  "0050-abandoned-task-never-resumes-and-a-knob-that-does-not-exist.md>app.js:675",
];

// 目标文件解析【照抄守卫的规则】（doc-refs.test.ts:115 resolveTarget）：
// 先按「等于该路径或以 /该路径 结尾」找唯一，再退到基名唯一。
// 不 import 而是照抄：本脚本是人工核对时的辅助，它坏了不该带崩守卫；
// 但口径必须同源，否则两边算出的目标文件不一致，定位结果本身就是错的。
const ALL = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", ".tmp", "dist"].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else ALL.push(relative(ROOT, p).split(sep).join("/"));
  }
})(ROOT);
function resolveTarget(file) {
  const direct = ALL.filter((p) => p === file || p.endsWith("/" + file));
  if (direct.length === 1) return { ok: direct[0] };
  if (direct.length > 1) return { ambiguous: direct };
  const base = file.split("/").pop() ?? "";
  const byBase = ALL.filter((p) => p.endsWith("/" + base));
  return byBase.length === 1 ? { ok: byBase[0] } : { ambiguous: byBase };
}

let needHuman = 0;
for (const key of STALE) {
  const want = snap.get(key);
  if (want === undefined) {
    needHuman++;
    console.log(`✘ SNAP 里没有这个键：${key}`);
    continue;
  }
  const [filePart, linePart] = key.split(">")[1].split(":");
  const t = resolveTarget(filePart);
  if (t.ok === undefined) {
    needHuman++;
    console.log(`⚠ 需人工 ${key}：目标文件歧义 ${JSON.stringify((t.ambiguous ?? []).slice(0, 4))}`);
    continue;
  }
  const lines = readFileSync(join(ROOT, t.ok), "utf8").split("\n");
  const hits = [];
  lines.forEach((l, i) => {
    if (l.trim() === want.trim()) hits.push(i + 1);
  });
  if (hits.length === 1) {
    console.log(`✔ ${key}\n    ${filePart}:${linePart} → 新 ${t.ok}:${hits[0]}`);
  } else {
    needHuman++;
    console.log(
      `⚠ 需人工 ${key}：快照文本在 ${t.ok} 里数出 ${hits.length} 处` +
        (hits.length > 1 ? " [" + hits.slice(0, 8).join(",") + "]" : "") +
        `\n    快照：${want.slice(0, 120)}`,
    );
  }
}
console.log(`\n合计 ${STALE.length} 格，需人工 ${needHuman} 格`);
