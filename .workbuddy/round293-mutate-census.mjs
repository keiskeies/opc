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
  // round301 补：Tests 行里【一个数字都没有】的那一型 —— 真 vitest 在
  // 「整份文件装载失败、一个用例都没跑到」时把它打成 `      Tests  no tests`。
  // 本机第一版把「读不到 failed」当 0 ⇒ M0 控制组（应绿）在什么都没跑的前提下
  // 判【命中】，而 M1~M5 若恰好也全炸就一起判【未命中】⇒ 整台机器只剩一句
  // 「命中 1/7」的红字，读的人以为判据松了。
  // 判「无数字」而不是「等于 0」：真绿屏是「0 failed 缺失 + N passed」，有数字 ⇒ 不误伤。
  const seg = line.replace(/^\s*Tests\s+/, "");
  if (!/\d/u.test(seg)) {
    throw new Error(
      "Tests 摘要行里【一个数字都没有】（实得：" + seg.trim() + "）—— 这一型是" +
        "「一个用例都没跑到」（装载/采集失败），不是「全部通过」。不能当 0。尾部：\n" +
        plain.slice(-800),
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
  const red = failed === null ? 0 : Number(failed[1]);
  const redFiles = failedFiles === null ? 0 : Number(failedFiles[1]);
  // round301 补（本机最危险的那一型）：【死一份、其余照跑】。那时 Tests 行有数字，
  // 上一格不响，而红只落在 Test Files 行 ⇒ 用例级读到 0 红 ⇒ 控制组判命中、
  // 变异发判未命中 —— 一张【归因错了】的矩阵，exit 1 但红话说的是假原因。
  // 与 round298「文件红了而读不到 FAIL 文件名 ⇒ 抛」同族；本机没有 FAIL 行归因，
  // 所以文件级/用例级不自洽是唯一抓得住它的判据。
  if (redFiles > 0 && red === 0) {
    throw new Error(
      "Test Files 红了 " + redFiles + " 份而用例级【一条红都没有】⇒ 那是装载/采集期" +
        "失败，不是判据红，两种读数都不许采信。尾部：\n" + plain.slice(-800),
    );
  }
  /* round302 补（格③）：这一格【不依赖别处有没有红】⇒ 它补的正是 round301 登记的
     那格残留。格② 只在「用例级 0 红」时响，而真实的一次装载失败常常【和另一发的
     真红同屏】（变异打坏 src ⇒ 判据那一发红，同时夹具那份装载不起来）：那时格①②
     都不响，装载失败被【并进那一发正常的红】里读成「命中」。
     四份真屏实测（.workbuddy/probe302-{mixed,hook,hookgreen,shapes}-raw.txt）：
       语法坏 / import 找不到 ⇒ `FAIL  <文件> [ <同一个文件> ]`  ← 变异真会造出的两型
       一个用例红            ⇒ `FAIL  <文件> > suite > 用例名`
       beforeAll 里抛        ⇒ `FAIL  <文件> > suite`（用例级会长出 skipped）
     ⇒ 「方括号里把同一条路径重复一遍」是装载失败的【专属】特征，实测误报面为空。 */
  const deadFiles = [];
  for (const deadLine of plain.split("\n")) {
    const deadHit = /^\s*FAIL\s+(\S+)\s+\[\s*(\S+)\s*\]\s*$/u.exec(deadLine);
    if (deadHit !== null && deadHit[1] === deadHit[2]) deadFiles.push(deadHit[1]);
  }
  if (deadFiles.length > 0) {
    throw new Error(
      "读到装载失败那型的 FAIL 行（" + deadFiles.join("、") + "）⇒ 整份文件没跑起来，" +
        "这一发的读数不可信。格①② 在这种屏上【不响】（Tests 行有数字、用例级也有红），" +
        "只有这一格认得它。尾部：\n" + plain.slice(-800),
    );
  }
  return {
    red,
    green: passed === null ? 0 : Number(passed[1]),
    redFiles,
  };
}

/**
 * 读数自证（round301 补，round302 加到 6 格）：喂【真屏逐行抄写】，判这台读得对不对。
 * 字节来自 .workbuddy/probe301-{green,red,loadfail}-raw.txt 与
 * probe302-{mixed,hookgreen}-raw.txt（两轮真跑抓的）。分母数出来，不写死。
 */
function selfCheckParser() {
  const esc = String.fromCharCode(27);
  const w = (s) => s.split("ESC").join(esc);
  const cases = [
    [
      "甲 真绿屏读成绿",
      w(
        " Test Files ESC[22m ESC[1mESC[32m1 passedESC[39mESC[22m ESC[90m (1)ESC[39m\n" +
          "      Tests ESC[22m ESC[1mESC[32m12 passedESC[39mESC[22m ESC[90m (12)ESC[39m\n",
      ),
      (s) => (s.red === 0 && s.green === 12 ? "" : "red=" + s.red + " green=" + s.green),
    ],
    [
      "乙 真红屏读成红",
      w(
        " Test Files ESC[22m ESC[1mESC[31m1 failedESC[39mESC[22m ESC[90m (1)ESC[39m\n" +
          "      Tests ESC[22m ESC[1mESC[31m2 failedESC[39mESC[22m | 10 passed ESC[90m (12)ESC[39m\n",
      ),
      (s) => (s.red === 2 && s.redFiles === 1 ? "" : "red=" + s.red + " redFiles=" + s.redFiles),
    ],
    [
      "丙 装载失败（no tests）必须抛",
      w(
        "ESC[41mESC[1m FAIL ESC[22mESC[49m test/arch/census.test.ts ESC[2m [ test/arch/census.test.ts ]ESC[22m\n" +
          " Test Files ESC[22m ESC[1mESC[31m1 failedESC[39mESC[22m ESC[90m (1)ESC[39m\n" +
          "      Tests ESC[22m ESC[2mno testsESC[22m\n",
      ),
      null,
    ],
    [
      "丁 死一份其余照跑必须抛",
      w(
        "ESC[41mESC[1m FAIL ESC[22mESC[49m test/arch/other.test.ts ESC[2m [ test/arch/other.test.ts ]ESC[22m\n" +
          " Test Files ESC[22m ESC[1mESC[31m1 failed | 1 passedESC[39mESC[22m ESC[90m (2)ESC[39m\n" +
          "      Tests ESC[22m ESC[1mESC[32m24 passedESC[39mESC[22m ESC[90m (24)ESC[39m\n",
      ),
      null,
    ],
    /* round302 补两型，各钉【一格】。加了格③ 之后丁那一屏两格都拦得住 ⇒
       「摘掉某一格还剩几格」必须有【各自唯一】的屏才量得出来：
         戊 = 装载失败【加】另一发真红（真屏 probe302-mixed-raw.txt）⇒ 只有格③ 认得：
              Tests 行有数字（①不响）、用例级【也有】红（②不响）⇒ 旧三格全静默。
              这正是 round301 登记的那格残留，现在是【被钉住的】而不是【被登记的】。
         己 = hook 炸 + 其余全绿（probe302-hookgreen-raw.txt）⇒ 只有格② 认得：
              FAIL 行是 `FAIL <文件> > <suite>`（没方括号 ⇒ ③不响）、Tests 行有数字、
              用例级 0 红。没有己，摘掉② 时丁照样被③ 拦 ⇒ ② 看起来像装饰。
       ⚠ 登记的残留：hook 炸【加】另一发红（probe302-hook-raw.txt）三格都不响 ——
         那种屏上「打到判据的红」与「别处炸的红」在字节上分不开，要分只能靠用例名。 */
    [
      "戊 装载失败+另一发红（只有格③ 认得）必须抛",
      w(
        "ESC[41mESC[1m FAIL ESC[22mESC[49m test/arch/probe302dead.test.tsESC[2m [ test/arch/probe302dead.test.ts ]ESC[22m\n" +
          "ESC[41mESC[1m FAIL ESC[22mESC[49m test/arch/probe302red.test.tsESC[2m > ESC[22mprobe302 真红ESC[2m > ESC[22m这一发故意红\n" +
          "ESC[2m Test Files ESC[22m ESC[1mESC[31m2 failedESC[39mESC[22mESC[2m | ESC[22mESC[1mESC[32m1 passedESC[39mESC[22mESC[90m (3)ESC[39m\n" +
          "ESC[2m      Tests ESC[22m ESC[1mESC[31m1 failedESC[39mESC[22mESC[2m | ESC[22mESC[1mESC[32m5 passedESC[39mESC[22mESC[90m (6)ESC[39m\n",
      ),
      null,
    ],
    [
      "己 hook 炸+其余绿（只有格② 认得）必须抛",
      w(
        "ESC[41mESC[1m FAIL ESC[22mESC[49m test/arch/probe302hook.test.tsESC[2m > ESC[22mprobe302 hook 炸\n" +
          "ESC[2m Test Files ESC[22m ESC[1mESC[31m1 failedESC[39mESC[22mESC[2m | ESC[22mESC[1mESC[32m1 passedESC[39mESC[22mESC[90m (2)ESC[39m\n" +
          "ESC[2m      Tests ESC[22m ESC[1mESC[32m4 passedESC[39mESC[22mESC[2m | ESC[22mESC[33m1 skippedESC[39mESC[90m (5)ESC[39m\n",
      ),
      null,
    ],
  ];
  const problems = [];
  /* round302：戊/己【判红话出自哪一格】而不是只判「抛了」。只判抛了就是 round295 M4
     那一族【红因来自别人】的假变异 —— 摘掉承重那格之后别的门照样会抛，自证却说过了。
     戊 要找格③ 那句（四台共用同一段字节，见台账 round302 ②）；己 要找格② 那句。 */
  const NAMED = new Map([
    ["戊 装载失败+另一发红（只有格③ 认得）必须抛", "装载失败那型的 FAIL 行"],
    ["己 hook 炸+其余绿（只有格② 认得）必须抛", "用例级【一条红都没有】"],
  ]);
  for (const [name, text, judge] of cases) {
    try {
      const s = readSummary(text);
      if (judge === null) {
        problems.push(name + "：【没抛】—— 读成 red=" + s.red + " redFiles=" + s.redFiles);
        continue;
      }
      const bad = judge(s);
      if (bad !== "") problems.push(name + "：读错（" + bad + "）");
    } catch (e) {
      if (judge === null) {
        const needle = NAMED.get(name);
        const msg = String(e instanceof Error ? e.message : e);
        if (needle !== undefined && !msg.includes(needle)) {
          problems.push(
            name + "：抛是抛了，但红话【不是那一格】（要找「" + needle + "」，实得「" +
              msg.split("\n")[0].slice(0, 70) + "」）⇒ 红因来自别人 = 假变异",
          );
        }
        continue;
      }
      problems.push(name + "：真屏【抛了】⇒ M0 永远红：" + String(e.message).slice(0, 80));
    }
  }
  if (problems.length > 0) {
    throw new Error(
      "这台机器自己的读数不可信，【一发都没跑】（" + cases.length + " 格里红 " +
        problems.length + " 格）：\n  " + problems.join("\n  "),
    );
  }
  console.log(
    "  读数自证  " + cases.length + " 格全过（真绿/真红读对，四种装载/采集失败屏都抛；" +
      "戊 只由格③ 拦住、己 只由格② 拦住 ⇒ 两格各自承重，不是一格看起来像装饰）",
  );
}
selfCheckParser();

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
