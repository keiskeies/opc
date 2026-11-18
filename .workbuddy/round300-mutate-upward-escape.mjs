/**
 * round300 · 「往上跳（`../`）的仓外路径」这条判据有没有牙齿（打在真字节上，自回滚）。
 *
 * 跑法：node .workbuddy/round300-mutate-upward-escape.mjs
 * 【单独跑】，不与任何测试并发（它会临时改盘上字节）。
 *
 * ── 本轮起因：台账里那条登记【把方向猜反了】───────────────────────────
 * round296 的射程段写着「`parseTscOutput` 那一侧的仓外路径没有单测。它红在『新目录』上」
 * —— 前半句对，后半句只对了一半。本轮先量再动，量出来是两格：
 *  · 绝对式（`E:/other/repo/…`、`/other/repo/…`）：确实进 errors、确实报「基线外的测试
 *    目录」⇒ 方向是【红】。难看，但看得见。登记没说错。
 *  · `../` 式：`toRepoRelative` 的 while (p.startsWith("../")) 把前缀整段抹掉 ⇒
 *    `../packages/hub/test/engine/x0.ts` 归一出来是【地道的仓内路径】⇒ 那条错
 *    【花掉本仓那个目录的配额】⇒ 方向是【绿】。登记完全没看到这半格。
 *  实测的坏读数（`.workbuddy/probe300-fold.ts`，落判据之前）：把 TYPE_BASELINE 每一格
 *  按 `../<该格目录>/xN.ts` 灌满 ⇒ 归一出 291 条而 diffTypeBaseline 返回【空字符串】
 *  ⇒ 一次「include 指向隔壁仓」的事故会逐字读出本仓的配额表并宣布合格。
 *  同一个形状在 parseListFiles 那边给 filesChecked 灌水（两条 `../other-repo/*.ts`
 *  被数成 2 个「本仓语料文件」）⇒ 0006 §7 第 41 条那条哨兵会被外来文件替本仓作证。
 *
 * ── 七发，各自的形状 ───────────────────────────────────────────────
 *  · M0 控制组【该绿】：只在 escapesUpward 函数体开头加一条空注释。
 *    它红了就说明这台在判【字节变没变】而不是【读数变没变】，后面六发全部不可信。
 *  · M1 判据本身改成恒假 ⇒ 该红在「往上跳」那一发。
 *  · M2 【调用点】不再用它（函数体一字不动，parseTscOutput 退回无条件归一）⇒ 同上。
 *    与 M1 分开是老牌那一格：函数在而没人调 = 没判（同 r22 那条纪律）。
 *  · M3 parseListFiles 的调用点退回 round296 那一版（`isStillAbsolute(rel)`）
 *    ⇒ 该红在「往上跳」那一发的丙格。
 *  · M4 判据【改成判宽了但判错侧】：绝对那一半去读 raw 而不是归一后的结果
 *    ⇒ 该红在【老那一发】「--listFilesOnly 只数本仓自己的 .ts」上，
 *      且【必须】是「往上跳」那一发【不红】。
 *    ⭐ 这一发是本轮最值的一发：「raw 里有斜杠就排除」是一种【看起来更安全】的写法，
 *    而它把 unix checkout 上 tsc 输出的【仓内】绝对路径整个错排掉 ⇒ 语料恒 0
 *    ⇒ 那条 filesChecked 下限当场红（看得见），但「往上跳」那一发【全绿】——
 *    一个洞补上了、另一个洞被这个补法【造出来】。只有点名「红在老那一发 + 绿在新那一发」
 *    才同时钉住两件事：新判据有效，且它不能靠【一律排除】蒙对。
 *  · M5 反向对照【该绿】：把 isOutsideRepo 的两个判据【换个顺序】。语义一字未动。
 *    M0 测的是「加注释不算」，这一发测的是【重排不算】：一台会把语义等价的改写读成红的
 *    机器，它给出的 6/6 命中里有一半是噪声。（这台机器读过两次这种亏了：round292/295。）
 *  · M6 把这一族【改成用丢掉来修】：`../` 那一型不报错、只记 unparsed
 *    ⇒ 该同时红在「往上跳」与「仓外路径计数而不是丢掉」两发上。
 *    这是本轮落判据时真的面对过的那个选择：丢掉看起来更干净，而它把一次 include 事故
 *    读成「那些文件没有类型错」⇒ 配额表读空字符串 ⇒ 绿。M6 就是那个坏选择的化石。
 *
 * ⚠ 四条纪律（同 round296，逐条带着）：
 *  ① 还原写【进场时读到的字节】，不用 replace 反推；
 *  ② 还原在 finally 里，且在【校验之前】；
 *  ③ 所有锚点在第一发跑之前全部验一遍（命中必须恰好 1 次，且 to ≠ from），
 *     【用例名】也必须逐条在 SPEC 里 —— 点不到名的 mustRed 是一条永假判据；
 *  ④ 读 vitest 输出先剥 ANSI，且「读不到摘要行」必须【抛】而不是当 0。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const GUARD = "test/arch/test-type-baseline.ts";
const SPEC = "test/arch/test-type-baseline.test.ts";

/** 用例名逐字抄自 SPEC，改一个字这台就会报「点不到名」。 */
const T_UP =
  "⭐ 往上跳（`../`）的仓外路径【不许】折进仓内目录 —— 两种消费各一条（round300）";
const T_KEEP =
  "⭐ 仓外路径【计数】而不是丢掉：红着比读空字符串好（round300 立的分工）";
const T_LIST =
  "--listFilesOnly 只数本仓自己的 .ts：node_modules（含 lib 与 @types）不进下限";
const T_SINGLE =
  "单变量对照：同一个位置从仓外搬进仓内 ⇒ 立刻计数（证明判的是在不在仓内）";
const T_296 =
  "⭐ 仓外路径不计进语料：unix 式【和 windows 式】都不计（round296 补的洞）";
const NAMED = [T_UP, T_KEEP, T_LIST, T_SINGLE, T_296];

const ESC = String.fromCharCode(27);
const results = [];
const MUTATIONS = [];

function mutate(rel, from, to, label, expectRed, mustRedTests, mustGreenTests, note) {
  MUTATIONS.push({ rel, from, to, label, expectRed, mustRedTests, mustGreenTests, note });
}

/* ── M0：控制组（该绿）────────────────────────────────────────────── */
mutate(
  GUARD,
  "function escapesUpward(raw: string): boolean {",
  "function escapesUpward(raw: string): boolean { //",
  "M0 控制组：在函数体开头加一条空注释",
  false,
  [],
  [],
  "字节变了而三个判据的语义一个字没动 ⇒ 整份必须绿。它红了就说明这台在判字节而不是判读数",
);

/* ── M1：判据本身恒假 ─────────────────────────────────────────────── */
mutate(
  GUARD,
  '  return p === ".." || p.startsWith("../");',
  "  return false;",
  "M1 escapesUpward 改成恒假（这一族不再被认成仓外）",
  true,
  [T_UP],
  [T_296],
  "「往上跳」那一发必须红。T_296 不许红：绝对式那一条判据（isStillAbsolute）没被碰到，" +
    "它若跟着红，说明这台把【整份】的红当成点名命中",
);

/* ── M2：parseTscOutput 的调用点退回旧写法（函数还在，没人调）───────── */
mutate(
  GUARD,
  '    const file = escapesUpward(raw)\n      ? raw\n      : toRepoRelative(m[1] as string, root);',
  "    const file = toRepoRelative(m[1] as string, root);",
  "M2 配额那一侧退回无条件归一（函数体一字不动）",
  true,
  [T_UP],
  [],
  "与 M1 的分工：M1 改判据本身，M2 只改调用点。只有 M1 的话，" +
    "「函数留着而那一处不调」这种改法能躲过去",
);

/* ── M3：parseListFiles 的调用点退回 round296 那一版 ───────────────── */
mutate(
  GUARD,
  '    if (rel === "" || isOutsideRepo(raw, rel) || !rel.endsWith(".ts")) continue;',
  '    if (rel === "" || isStillAbsolute(rel) || !rel.endsWith(".ts")) continue;',
  "M3 语料那一侧退回只判绝对式（isOutsideRepo 还在，没人调它）",
  true,
  [T_UP],
  [T_296, T_SINGLE],
  "这一发是【round296 那台的 M2 的镜像】：那台证的是「isStillAbsolute 真被调」，" +
    "这台证的是「isOutsideRepo 真被调」。两条都在挡同一句话 —— 只剩一个函数不等于判了",
);

/* ── M4：判宽了但判错侧（读 raw 而不是读归一后的结果）───────────────── */
mutate(
  GUARD,
  "  return isStillAbsolute(rel) || escapesUpward(raw);",
  "  return isStillAbsolute(raw) || escapesUpward(raw);",
  "M4 绝对那一半改成读 raw（看起来更安全，实际把仓内绝对路径整个错排掉）",
  true,
  [T_LIST],
  [T_UP, T_296],
  "⭐ 本轮最值的一发。「raw 里有斜杠就排除」这种写法【比现在的更严】，而它把 unix " +
    "checkout 上 tsc 输出的仓内绝对路径一起排掉 ⇒ 语料恒 0 ⇒ 红在【老那一发】上；" +
    "新那发的甲乙丙三格【全绿】—— 它一条也没判到。" +
    "必须同时点名「红在 T_LIST + 绿在 T_UP」，否则这台分不清「补对了」与「一律排除」",
);

/* ── M5：反向对照（语义等价的重排，该绿）──────────────────────────── */
mutate(
  GUARD,
  "  return isStillAbsolute(rel) || escapesUpward(raw);",
  "  return escapesUpward(raw) || isStillAbsolute(rel);",
  "M5 反向对照：isOutsideRepo 两个判据换个顺序（语义一字未动）",
  false,
  [],
  [],
  "该绿。M0 测「加注释不算红」，这一发测「重排不算红」：一台把语义等价的改写读成红的" +
    "机器，它给出的命中里有一半是噪声（round292/295 各在这种机器上吃过一次亏）",
);

/* ── M6：把这一族【改成用丢掉来修】────────────────────────────────── */
mutate(
  GUARD,
  '    const file = escapesUpward(raw)\n      ? raw\n      : toRepoRelative(m[1] as string, root);',
  '    const file = escapesUpward(raw)\n      ? ""\n      : toRepoRelative(m[1] as string, root);',
  "M6 往上跳那一型不报错、只记 unparsed（用『丢掉』来『修』这个洞）",
  true,
  [T_UP, T_KEEP],
  [],
  "这是本轮落判据时真的面对过、并且【否掉】的那个选择。丢掉看起来更干净，" +
    "而它把「这个 project 吃进了仓外的文件」读成「那些文件没有类型错」⇒ 配额表读空字符串 " +
    "⇒ 绿。M6 就是那个坏选择的化石：以后有人想把它改回来，这台会念出这两发",
);

/* ── 锚点先全部验一遍（纪律 ③）───────────────────────────────────── */
const originals = new Map();
const bad = [];
for (const m of MUTATIONS) {
  const text = originals.get(m.rel) ?? readFileSync(join(ROOT, m.rel), "utf8");
  originals.set(m.rel, text);
  const hits = text.split(m.from).length - 1;
  if (hits !== 1) {
    bad.push(m.rel + " :: [" + m.label + "] 锚点命中 " + hits + " 次（要恰好 1 次）");
  }
  if (m.to === m.from) bad.push(m.rel + " :: [" + m.label + "] to 与 from 相同 = 空变异");
}
const specText = readFileSync(join(ROOT, SPEC), "utf8");
for (const t of NAMED) {
  if (specText.indexOf(t) < 0) {
    bad.push("用例名锚点不在 SPEC 里（这台会【永远点不到名】）：" + t);
  }
}
if (bad.length > 0) {
  console.error("锚点校验失败，【一发都没跑】：\n  " + bad.join("\n  "));
  process.exit(1);
}

/**
 * 从 vitest 的输出里读「红了几发 / 红了哪几份文件 / 红了【哪几发用例名】」。
 * 四条失效各自防的（同 round296，那四条各是历史上真中过的一次）：
 *  a) 剥 ANSI 不生效 ⇒ 摘要行前留着 ESC ⇒ 报「读不到摘要」⇒ 当场验。
 *  b) 「读不到摘要」当 0 ⇒ 红读成绿，整张矩阵假绿 ⇒ 一律抛。
 *  c) 文件级装载失败时 `Tests` 行报「红发 0」⇒ 必须并上 `Test Files`。
 *  d) 红在【别的用例】上不算点名命中；文件红了却读不到 FAIL 行 ⇒ 抛。
 */
function readSummary(out) {
  const clean = out.replace(new RegExp(ESC + "\\[[0-9;]*m", "g"), "");
  if (clean.indexOf(ESC) !== -1) {
    throw new Error("剥 ANSI 没生效（剥完输出里还剩 ESC 字节）—— 摘要行会读不到");
  }
  const m = clean.match(/^\s*Tests\s+(.+)$/m);
  if (m === null) {
    throw new Error(
      "读不到 vitest 的「Tests」摘要行 —— 【不能】当 0 处理：那会把红读成绿。尾部：\n" +
        clean.slice(-800),
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
    throw new Error("读不到 vitest 的「Test Files」摘要行 —— 同「Tests」那条纪律。尾部：\n" + clean.slice(-400));
  }
  const failedFiles = Number((tf[1].match(/(\d+) failed/) ?? [0, "0"])[1]);
  if (failedFiles > 0 && files.size === 0) {
    throw new Error(
      "有 " + failedFiles + " 份文件红了但【读不到 FAIL 行的文件名】⇒ 归因失真。尾部：\n" + clean.slice(-800),
    );
  }
  return { failed: failedTests + failedFiles, failedTests, failedFiles, passed, files, tests };
}

function run() {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", SPEC],
    { cwd: ROOT, encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 },
  );
  const out = String(r.stdout) + String(r.stderr);
  const got = readSummary(out);
  return Object.assign({}, got, { red: got.failed > 0 });
}

/** 机器自己的自证：不打产品，只验这台读摘要的机器读得对。 */
function selfCheck() {
  const problems = [];
  let checks = 0;
  // ① 真屏逐行抄写（带色码 + FAIL 行带用例名）。
  const colored =
    " " + ESC + "[41m" + ESC + "[1m FAIL " + ESC + "[22m" + ESC + "[49m " + SPEC +
    " > 类型棘轮：计数与路径归一 > " + T_UP + "\n" +
    "AssertionError: expected 1 to be 0\n" +
    " " + ESC + "[22m Test Files " + ESC + "[22m " + ESC + "[1m" + ESC + "[31m1 failed" +
    ESC + "[39m" + ESC + "[22m" + ESC + "[90m (1)" + ESC + "[39m\n" +
    " " + ESC + "[22m      Tests " + ESC + "[22m " + ESC + "[1m" + ESC + "[31m1 failed" +
    ESC + "[39m" + ESC + "[22m | 24 passed (25)\n";
  try {
    const s = readSummary(colored);
    if (s.failedTests !== 1) problems.push("自证①：用例红 = " + s.failedTests + "（要 1）");
    if (s.failedFiles !== 1) problems.push("自证①：文件红 = " + s.failedFiles + "（要 1）");
    if (!s.files.has(SPEC)) problems.push("自证①：色码里没归因到那份文件");
    if (!s.tests.has(T_UP)) problems.push("自证①：用例名没读出来 ⇒ 点名判据会全成假未命中");
    if (s.failed <= 0) problems.push("自证①：有红而读成了绿");
  } catch (e) {
    problems.push("自证① 抛：" + String(e instanceof Error ? e.message : e).slice(0, 160));
  }
  checks += 1;
  // ② 装载期失败：FAIL 行【没有】用例名，必须只归因到文件而不硬造名字。
  const loadFail =
    " FAIL  " + SPEC + " [ " + SPEC + " ]\n" +
    "Error: Transform failed with 1 error:\n" +
    " Test Files  1 failed | 31 passed (32)\n" +
    "      Tests  420 passed (420)\n";
  try {
    const s = readSummary(loadFail);
    if (s.failed <= 0) problems.push("自证②：文件级失败被读成了绿");
    if (!s.files.has(SPEC)) problems.push("自证②：没归因到那份文件");
    if (s.tests.size !== 0) problems.push("自证②：装载失败被【造】出了用例名");
  } catch (e) {
    problems.push("自证② 抛：" + String(e instanceof Error ? e.message : e).slice(0, 160));
  }
  checks += 1;
  // ③ 全绿那一屏读成【绿】：M0/M5 只有在这判过之后才算数。
  try {
    const s = readSummary(" Test Files  1 passed (1)\n      Tests  25 passed (25)\n");
    if (s.failed !== 0) problems.push("自证③：failed = " + s.failed + "（全绿不许读成红）");
    if (s.passed !== 25) problems.push("自证③：passed = " + s.passed + "（要 25）");
    if (s.files.size !== 0 || s.tests.size !== 0) problems.push("自证③：绿屏里冒出了红");
  } catch (e) {
    problems.push("自证③ 抛：" + String(e instanceof Error ? e.message : e).slice(0, 160));
  }
  checks += 1;
  // ④ 「读不到摘要」必须抛而不是当 0。
  let threw = false;
  try {
    readSummary("完全不像 vitest 的一段输出");
  } catch {
    threw = true;
  }
  if (!threw) problems.push("自证④：读不到摘要时没抛（会被当成红=0 ⇒ 绿）");
  checks += 1;
  // ⑤ 文件红了却没有 FAIL 行 ⇒ 也抛。
  let threwAttr = false;
  try {
    readSummary(" Test Files  1 failed (1)\n      Tests  24 passed (25)\n");
  } catch {
    threwAttr = true;
  }
  if (!threwAttr) problems.push("自证⑤：文件红而无 FAIL 行时没抛 ⇒ 归因会失真");
  checks += 1;
  // ⑥ 红在【别的用例】上不算点名命中 —— M4 的 mustGreen[T_UP] 全靠这一判才不是恒真。
  const s6 = readSummary(
    " FAIL  " + SPEC + " > 类型棘轮：计数与路径归一 > " + T_LIST + "\n" +
      " Test Files  1 failed (1)\n" +
      "      Tests  1 failed | 24 passed (25)\n",
  );
  if (s6.tests.has(T_UP)) problems.push("自证⑥：红在别的用例上却被点成了 T_UP ⇒ 点名恒真");
  checks += 1;
  return { problems, checks };
}

function execute(m) {
  const path = join(ROOT, m.rel);
  const before = originals.get(m.rel);
  let state = "";
  let err = "";
  let hit = false;
  try {
    writeFileSync(path, before.replace(m.from, m.to), "utf8");
    const got = run();
    const problems = [];
    if (got.red !== m.expectRed) {
      problems.push("红/绿与预期不符（应" + (m.expectRed ? "红" : "绿") + "，实得红=" + got.failed + "）");
    }
    for (const t of m.mustRedTests) {
      if (!got.tests.has(t)) problems.push("该红的【用例】没红：" + t);
    }
    for (const t of m.mustGreenTests) {
      if (got.tests.has(t)) problems.push("不该红的用例红了：" + t);
    }
    if (!m.expectRed && (got.files.size > 0 || got.tests.size > 0)) {
      problems.push("控制组有红：" + [...got.files, ...got.tests].join(" / "));
    }
    state =
      "红=" + got.failed + "（用例 " + got.failedTests + " / 文件 " + got.failedFiles +
      "）/ 绿发=" + got.passed + " / 红用例=" +
      (got.tests.size === 0 ? "—" : [...got.tests].map((t) => t.slice(0, 30)).join(","));
    hit = problems.length === 0;
    if (!hit) err = problems.join("；");
  } catch (e) {
    hit = false;
    err = String(e instanceof Error ? e.message : e);
    state = "抛";
  } finally {
    writeFileSync(path, before, "utf8");
  }
  const restored = readFileSync(path, "utf8") === before;
  if (!restored) {
    console.error("!!! 还原失败：" + m.rel + " —— 立刻 git checkout 该文件");
    process.exitCode = 1;
  }
  results.push([hit && restored, m.label, m.expectRed ? "该红" : "该绿",
    state + (restored ? "" : " 【还原失败】"), err, m.note]);
}

const self = selfCheck();
if (self.problems.length > 0) {
  console.error("这台机器自己没通过自证，【一发都没跑】：\n  " + self.problems.join("\n  "));
  process.exit(1);
}
console.log("机器自证 " + self.checks + "/" + self.checks + " 通过（色码+用例名归因 / 装载失败不造用例名 / 全绿读成绿 / 读不到摘要就抛 / 红而无 FAIL 名就抛 / 红在别处不算命中）");

for (const m of MUTATIONS) execute(m);

console.log("\n══════ round300 变异矩阵（往上跳的仓外路径，逐字节自回滚）══════");
let ok = 0;
for (const [hit, label, want, state, err, note] of results) {
  ok += hit ? 1 : 0;
  console.log((hit ? "✓" : "✗") + " " + label + "  [" + want + "] " + state);
  if (err !== "") console.log("    未命中原因：" + err);
  console.log("    " + note);
}
console.log("命中 " + ok + " / " + results.length);
process.exitCode = ok === results.length ? 0 : 1;
