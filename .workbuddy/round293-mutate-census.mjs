// round293 变异矩阵：census.ts 那四条读数是不是【真算出来的】。
//
// 跑法：node .workbuddy/round293-mutate-census.mjs
//
// ── 为什么这一族【必须】有变异 ─────────────────────────────────────
// census.ts 是一条【测量】，它自己恒 exit 0、恒不红。它唯一的失效方式是
// 「安静地读出一个错数」—— 而错数不会以报错的形状出现，只会以【文档里多一条假账】
// 的形状出现。dead-modules.ts 文件头记着它自己犯的那一发（往带 .ts 的 token 后再拼
// 一次 .ts ⇒ 闭包空转 ⇒ 83 个模块里 77 个被判死模块，输出形状与「一切正常」逐字一样）。
// ⇒ 一条测量型脚本的可信度【只能】来自「把它的关键一步抹掉，看有没有一发会红」。
//
// ── 三条纪律（round292 那轮的教训直接抄过来）────────────────────────
//  ① 进场前把所有锚点逐一验存在，任一失配就【一发不发】。
//     否则矩阵里既没有那一发红、也没有那一发绿，读的人会以为这一族验过了。
//  ② 真空操作只有 from === to。「变异串本来就是原文的子串」不是判据（M1 会误报）。
//  ③ 读汇总必须剥 ANSI，且读不到汇总行就【抛】：一个把红读成绿的解析器
//     比没有解析器更坏（vitest 全绿时【整段不输出 failed】）。
//
// ⚠ 自回滚变异改的是【生产字节】⇒ 跑它的时候【不要并发任何东西】。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const TARGET = join(ROOT, "test", "arch", "census.ts");
const SUITE = ["test/arch/census.test.ts"];

const M = "isEntry: entries.has(m.rel),";
const ACC = "for (const to of tos) importers.get(to)?.push(from);";
const FILT = "const rows = c.zeroImporter.filter((r) => !r.isEntry);";
const UNRES = "unresolved: g.unresolved.length,";
const LINES = 'const lineCount = (text: string): number => text.split("\\n").length;';
const SORT = ".sort((a, b) => b.lines - a.lines),";

/** M6 那种「看着更精准」的写法：把入口排除做成【恒假】，两栏就永远相等。 */
const plan = [
  {
    id: "M0",
    name: "控制组：一字不改",
    expectRed: false,
    why: "绿是后面每一发红的前提；同时自证这台机器上计数读得出红与绿",
    edits: [],
  },
  {
    id: "M1",
    name: "反向边不累积（解析器退化成零条边的同形）",
    expectRed: true,
    why: "全仓都成孤儿 ⇒ 「明知有调用方的模块不在名单里」那一发必须红，而且名单会【膨胀】",
    edits: [[ACC, "// 变异：不累积反向边"]],
  },
  {
    id: "M2",
    name: "入口标记恒 false（isEntry 不再问 entries）",
    expectRed: true,
    why: "「非入口」那一栏等于全量 ⇒ 子集/条数那一发该红",
    edits: [[M, "isEntry: false,"]],
  },
  {
    id: "M3",
    name: "underEntries 不过滤（原样返回全量）",
    expectRed: true,
    why: "入口排除这一整格失效 ⇒ 反向对照那一发（标成入口才消失）该红",
    edits: [[FILT, "const rows = c.zeroImporter;"]],
  },
  {
    id: "M4",
    name: "unresolved 写死 0",
    expectRed: true,
    why: "「坏图上的读数」不再可见 ⇒ 悬空说明符那一发（合成语料给 1）该红",
    edits: [[UNRES, "unresolved: 0,"]],
  },
  {
    id: "M5",
    name: "行数按换行符数（wc 口径）",
    expectRed: true,
    why: "行数口径钉住那一发该红；顺带证明「行数」不是只有一个定义",
    edits: [[LINES, 'const lineCount = (text: string): number => text.split("\\n").length - 1;']],
  },
  {
    id: "M6",
    name: "不排序（改成原序）",
    expectRed: false,
    why: "【该绿】：本文件那 12 发一条都没判顺序 ⇒ 这是已登记的射程余量，不是 bug。留着它是为了让下一个人看见这一格没被判住。",
    edits: [[SORT, ","]],
  },
];

function readSource() {
  return readFileSync(TARGET, "utf8");
}

/** 进场前验锚点：任一失配就拒绝开跑。 */
function preflight() {
  const src = readSource();
  const bad = [];
  for (const mut of plan) {
    for (const [from, to] of mut.edits) {
      if (from === to) bad.push(mut.id + " 是真空操作（from === to）");
      const n = src.split(from).length - 1;
      if (n !== 1) bad.push(mut.id + " 的锚点命中 " + n + " 次（要求恰好 1）：" + from.slice(0, 40));
    }
  }
  if (bad.length > 0) {
    throw new Error("锚点校验失败，一发不发：\n  " + bad.join("\n  "));
  }
}

/** 剥 ANSI 后读汇总；读不到就抛。 */
function readSummary(out) {
  const plain = out.replace(/\[[0-9;]*m/g, "");
  const line = plain
    .split("\n")
    .find((l) => /^\s*Tests\s/.test(l));
  if (line === undefined) {
    throw new Error(
      "读不到 vitest 汇总行 ⇒ 拒绝把这一发当绿。原文尾部：\n" +
        plain.slice(-1200),
    );
  }
  const failed = /(\d+) failed/.exec(line);
  const passed = /(\d+) passed/.exec(line);
  const fileLine = plain
    .split("\n")
    .find((l) => /^\s*Test Files\s/.test(l));
  if (fileLine === undefined) {
    throw new Error("读不到 Test Files 汇总行：\n" + plain.slice(-800));
  }
  const failedFiles = /(\d+) failed/.exec(fileLine);
  return {
    red: failed === null ? 0 : Number(failed[1]),
    green: passed === null ? 0 : Number(passed[1]),
    redFiles: failedFiles === null ? 0 : Number(failedFiles[1]),
  };
}

function runSuite() {
  try {
    const out = execFileSync("npx", ["vitest", "run", ...SUITE], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
    return readSummary(out);
  } catch (err) {
    const out = String(err.stdout ?? "") + String(err.stderr ?? "");
    if (/Tests\s/.test(out)) return readSummary(out);
    throw new Error("vitest 起跑失败：\n" + out.slice(-1500));
  }
}

preflight();
const original = readSource();
const results = [];
try {
  for (const mut of plan) {
    let body = original;
    for (const [from, to] of mut.edits) body = body.replace(from, to);
    writeFileSync(TARGET, body, "utf8");
    const r = runSuite();
    const hit = mut.expectRed ? r.red > 0 : r.red === 0;
    results.push({ id: mut.id, name: mut.name, why: mut.why, ...r, hit, expectRed: mut.expectRed });
  }
} finally {
  writeFileSync(TARGET, original, "utf8");
  const back = readFileSync(TARGET, "utf8");
  if (back !== original) throw new Error("回滚后字节不一致 —— 立刻人工核对 census.ts");
}

console.log("\n══════════ round293 census 变异矩阵 ══════════");
for (const r of results) {
  console.log(
    (r.hit ? "✓ " : "✗ ") +
      r.id +
      " " +
      r.name +
      "  [应" +
      (r.expectRed ? "红" : "绿") +
      "] 红发=" +
      r.red +
      " 绿发=" +
      r.green +
      " 红文件=" +
      r.redFiles +
      " | " +
      r.why,
  );
}
const hits = results.filter((r) => r.hit).length;
console.log("命中 " + hits + " / " + results.length);
if (hits !== results.length) process.exitCode = 1;
