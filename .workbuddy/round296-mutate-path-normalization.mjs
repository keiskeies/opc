/**
 * round296 · 路径归一与「在不在仓内」那一族有没有牙齿（打在真字节上，自回滚）。
 *
 * 跑法：node .workbuddy/round296-mutate-path-normalization.mjs
 * 【单独跑】，不与任何测试并发（它会临时改盘上字节）。
 *
 * ── 本轮起因（不是我想加戏，是一次换 checkout 的实测）──────────────────
 * 为了核「HEAD 那三个提交在新 checkout 里跑得起来吗」，我把仓库用 git worktree
 * 开到 %TEMP% 下跑了一遍 test/arch。红的那一发是「路径三种写法归一到同一个目录」，
 * 而红因不是归一逻辑，是【夹具假设了自己站在 D 盘】。顺着这条扫了一遍语料，
 * 量出三格（逐条都在本轮修掉并配了变异）：
 *  ① 同一发夹具写死 checkout 路径 ⇒ 换机器必红（假红，方向：红）。
 *  ② `parseListFiles` 的注释写着「不在仓内的绝对路径也排除」，实现只判了
 *     `rel.startsWith("/")` ⇒ unix 式排得掉，【windows 式排不掉】（本机天天在用那一型）。
 *     危害方向是【绿】：仓外文件灌进「本仓语料」⇒ include 真被改窄时下限仍够。
 *     ①② 合起来还有一格最好笑的：那发 `--listFilesOnly` 夹具【原来在别处也是绿的】，
 *     绿的原因是洞 ② —— 落不进 ROOT 的绝对路径原样退回、没前导斜杠、照样计数。
 *     ⇒ 一个洞把另一个洞的假绿【撑住了】。修 ② 而不改夹具 = 把假红换来换去。
 *  ③ `toRepoRelative` 注释吹「三种形状是实测出来的」，实际【只有绝对路径那一型有测试】：
 *     把 `while (p.startsWith("../"))` 整行删掉，本文件照绿。
 *
 * ── 六发，各自的形状 ───────────────────────────────────────────────
 *  · M0 控制组【该绿】：只在判据函数体上方加一条空注释。
 *  · M1 把 `isStillAbsolute` 的 windows 式那一半拿掉（退回旧口径）⇒ 该红，
 *    且【必须】红在「仓外路径不计进语料」那一发上 —— 这一发证新加的测试真在判那对斜杠。
 *  · M2 在【调用点】把 `isStillAbsolute(rel)` 换回 `rel.startsWith("/")`（函数体一字不动）
 *    ⇒ 同样该红。与 M1 分开是因为它证的是【调用点真在调它】：只留一个函数、
 *    没人调，等于没判（同 r22 那条「仍在真调判据而不是只剩一条注释」）。
 *  · M3 删掉 `../` 那一整行剥前缀 ⇒ 该红，红在新那发「另外三种形状」上。
 *  · M4 `return p.replace(/^\.\//u, "")` 改成 `return p`（`./` 不再剥）⇒ 该红，同一发。
 *  · M5 盘符大小写比较改成【敏感】（`p.toLowerCase().startsWith(...)` 去掉两处 toLowerCase）
 *    ⇒ 该红，红在「路径三种写法」那一发：小写盘符那条不再归一 ⇒ 计数 4→3、目录数 1→2。
 *    它是【改坏】而不是【改成不判】，所以这一发同时是 M1~M4 的控制组反例：
 *    这台机器读的不是「字节变没变」而是「读数变没变」。
 *
 * ── 比 round295 那台多的一格：归因到【具体哪一发】而不是【哪份文件】────────
 * round295 那台只有 `files`（文件级），于是「该红的文件红了」这件事的分辨率是整份文件 ——
 * 一份 23 发的文件里只要有任何一发红，M1 的 mustRed 就算命中，而它可能红在【别处】。
 * vitest 的 FAIL 行本来带用例名（`FAIL  文件 > suite > 用例名`），本轮把它读出来，
 * mustRed 逐条点【用例名】。⇒ 空变异（改了字节、没人受影响）在这台上会被当场抓住：
 * 它要么整份绿（红/绿不符），要么红在别的用例上（点名不符）。
 * 装载期失败那一型【没有】用例名（`FAIL  文件 [ 文件 ]`），所以自证② 单独钉它。
 *
 * ⚠ 四条纪律（同 round295，逐条带着）：
 *  ① 还原写【进场时读到的字节】，不用 replace 反推；
 *  ② 还原在 finally 里，且在【校验之前】；
 *  ③ 所有锚点在第一发跑之前全部验一遍（命中必须恰好 1 次，且 to ≠ from）；
 *  ④ 读 vitest 输出先剥 ANSI，且「读不到摘要行」必须【抛】而不是当 0。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const GUARD = "test/arch/test-type-baseline.ts";
const SPEC = "test/arch/test-type-baseline.test.ts";

/** 本轮新加/翻新的那三发用例名（逐字抄自 SPEC，改一个字这台就会报点不到名）。 */
const T_OUTSIDE = "⭐ 仓外路径不计进语料：unix 式【和 windows 式】都不计（round296 补的洞）";
const T_SHAPES = "⭐ 另外三种形状：`../` 前缀、`./` 前缀、根本身（注释吹的「实测三种」在这儿）";
const T_THREE = "⭐ 路径三种写法归一到同一个目录（不归一就会报一条假的『基线外新目录』）";

const ESC = String.fromCharCode(27);
const results = [];
const MUTATIONS = [];

function mutate(rel, from, to, label, expectRed, mustRedTests, mustGreenTests, note) {
  MUTATIONS.push({ rel, from, to, label, expectRed, mustRedTests, mustGreenTests, note });
}

/* ── M0：控制组（该绿）────────────────────────────────────────────── */
mutate(
  GUARD,
  "function isStillAbsolute(rel: string): boolean {",
  "function isStillAbsolute(rel: string): boolean { //",
  "M0 控制组：在函数体开头加一条空注释",
  false,
  [],
  [],
  "字节变了而三个判据的语义一个字没动 ⇒ 整份必须绿。" +
    "这一发如果红，说明这台在判【字节变没变】而不是【读数变没变】，后面五发全部不可信",
);

/* ── M1：函数体退回旧口径（只判 unix 式）──────────────────────────── */
mutate(
  GUARD,
  '  return rel.startsWith("/") || /^[A-Za-z]:\\//u.test(rel);',
  '  return rel.startsWith("/");',
  "M1 把 isStillAbsolute 的 windows 式那一半拿掉",
  true,
  [T_OUTSIDE],
  [],
  "这就是 round296 之前【真实存在】的那一版实现（注释说排除、实现只排 unix 式）。" +
    "⇒ 新那发必须红在它身上。它若不红，那条注释就还是假证人",
);

/* ── M2：调用点不再用它（函数体一字不动）──────────────────────────── */
mutate(
  GUARD,
  '    if (rel === "" || isStillAbsolute(rel) || !rel.endsWith(".ts")) continue;',
  '    if (rel === "" || rel.startsWith("/") || !rel.endsWith(".ts")) continue;',
  "M2 调用点换回 rel.startsWith(\"/\")（函数还在，没人调）",
  true,
  [T_OUTSIDE],
  [],
  "与 M1 的分工：M1 改【判据本身】，M2 只改【调用点】。" +
    "只有 M1 的话，「函数在而没人调」那种改法能躲过去 —— 同 r22 那条纪律",
);

/* ── M3：不再剥 `../` ─────────────────────────────────────────────── */
mutate(
  GUARD,
  '  while (p.startsWith("../")) p = p.slice(3);',
  "  // 变异：不再剥 ../ 前缀",
  "M3 删掉剥 `../` 那一整行",
  true,
  [T_SHAPES],
  [],
  "这一发是本轮 ③ 的直接回归：注释吹「三种形状实测出来的」，而 round296 之前" +
    "删掉这一行【整份照绿】。现在它必须红，且红在新那发上",
);

/* ── M4：不再剥 `./` ──────────────────────────────────────────────── */
mutate(
  GUARD,
  '  return p.replace(/^\\.\\//u, "");',
  "  return p;",
  "M4 不再剥 `./` 前缀（return p 原样出去）",
  true,
  [T_SHAPES],
  [],
  "与 M3 分开：两行各管一型前缀，合成一发的话【少修一行】看不出来。" +
    "⚠ 它只该红在新那发 —— 其余用例都不喂 `./` 开头的路径，" +
    "所以这一点不到名就说明【只有新那发覆盖这一型】，那正是本轮要钉的空白",
);

/* ── M5：盘符大小写改成敏感 ───────────────────────────────────────── */
mutate(
  GUARD,
  '  if (p.toLowerCase().startsWith(r.toLowerCase() + "/")) {',
  "  if (p.startsWith(r + \"/\")) {",
  "M5 绝对路径那一判改成大小写敏感（改成坏，不是改成不判）",
  true,
  [T_THREE],
  [],
  "M1~M4 都是「改成不判」，这一发是【改成判坏】：小写盘符 `d:/…` 不再落进 `D:/…`，" +
    "于是那四条里有一条归一失败 ⇒ 计数 4→3 且目录数 1→2。" +
    "它同时是这台机器的反控制组：读数变了它就该红，" +
    "「改坏」与「改没判」两种病它分开不了，但都能抓到",
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
for (const t of [T_OUTSIDE, T_SHAPES, T_THREE]) {
  const specText = readFileSync(join(ROOT, SPEC), "utf8");
  if (specText.indexOf(t) < 0) bad.push("用例名锚点不在 SPEC 里（这台会【永远点不到名】）：" + t);
}
if (bad.length > 0) {
  console.error("锚点校验失败，【一发都没跑】：\n  " + bad.join("\n  "));
  process.exit(1);
}

/**
 * 从 vitest 的输出里读「红了几发 / 红了哪几份文件 / 红了【哪几发用例名】」。
 *
 * 四条失效各自防的：
 *  a) 剥 ANSI 不生效 ⇒ 摘要行前留着 ESC ⇒ 报「读不到摘要」（round292 中过）⇒ 当场验。
 *  b) 「读不到摘要」当 0 ⇒ 红读成绿，整张矩阵假绿（round292 中过）⇒ 一律抛。
 *  c) 文件级装载失败时 `Tests` 行报「红发 0」⇒ 必须并上 `Test Files`（round295 中过）。
 *  d) 【本轮加的一格】FAIL 行里的用例名要读得出来；文件红了却读不到 FAIL 行 ⇒ 抛
 *     （归因失真的话「该红的用例没红」会变成假未命中）。
 */
function readSummary(out) {
  const clean = out.replace(new RegExp(ESC + "\\[[0-9;]*m", "g"), "");
  if (clean.indexOf(ESC) !== -1) {
    throw new Error(
      "剥 ANSI 没生效（剥完输出里还剩 ESC 字节）—— 摘要行会读不到，" +
        "而那在本仓的历史上被当成过被测对象的错",
    );
  }
  const m = clean.match(/^\s*Tests\s+(.+)$/m);
  if (m === null) {
    throw new Error(
      "读不到 vitest 的「Tests」摘要行 —— 【不能】当 0 处理：那会把红读成绿，" +
        "整张矩阵会假绿。摘要尾部：\n" +
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
    // `FAIL  文件 > describe > it` ⇒ 最后一段是用例名。装载失败那一型是
    // `FAIL  文件 [ 文件 ]`，没有 `>` ⇒ 只归因到文件，不硬造一个用例名。
    const gt = line.indexOf(">");
    if (gt >= 0) {
      const name = line.slice(gt + 1).split(">").pop().trim();
      if (name !== "") tests.add(name);
    }
  }
  const tf = clean.match(/^\s*Test Files\s+(.+)$/m);
  if (tf === null) {
    throw new Error(
      "读不到 vitest 的「Test Files」摘要行 —— 与「Tests」同一条纪律，不许当 0。尾部：\n" +
        clean.slice(-400),
    );
  }
  const failedFiles = Number((tf[1].match(/(\d+) failed/) ?? [0, "0"])[1]);
  if (failedFiles > 0 && files.size === 0) {
    throw new Error(
      "有 " +
        failedFiles +
        " 份文件红了但【读不到 FAIL 行的文件名】⇒ 归因失真" +
        "（『该红的用例没红』那一判会变成假命中）。摘要尾部：\n" +
        clean.slice(-800),
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
  // 分母【数出来】，不写死：加了不发探针而忘了改摘要行的话，
  // 「N/N 通过」会变成一句永远为真的谎（round295 登记过同一格）。
  let checks = 0;
  // ① 真屏逐行抄写（带色码 + FAIL 行带用例名）：色码、文件归因、【用例名归因】都要生效。
  const colored =
    " " + ESC + "[41m" + ESC + "[1m FAIL " + ESC + "[22m" + ESC + "[49m " + SPEC +
    " > 类型棘轮：计数与路径归一 > " + T_OUTSIDE + "\n" +
    "AssertionError: expected 1 to be 0\n" +
    " " + ESC + "[22m Test Files " + ESC + "[22m " + ESC + "[1m" + ESC + "[31m1 failed" +
    ESC + "[39m" + ESC + "[22m" + ESC + "[90m (1)" + ESC + "[39m\n" +
    " " + ESC + "[22m      Tests " + ESC + "[22m " + ESC + "[1m" + ESC + "[31m1 failed" +
    ESC + "[39m" + ESC + "[22m | 22 passed (23)\n";
  try {
    const s = readSummary(colored);
    if (s.failedTests !== 1) problems.push("自证①：用例红 = " + s.failedTests + "（要 1）");
    if (s.failedFiles !== 1) problems.push("自证①：文件红 = " + s.failedFiles + "（要 1）");
    if (!s.files.has(SPEC)) problems.push("自证①：色码里没归因到那份文件");
    if (!s.tests.has(T_OUTSIDE)) {
      problems.push("自证①：用例名没读出来 ⇒ mustRed 逐条点名会全成假未命中（本轮新增那判）");
    }
    // 读 s.failed 而不是 s.red：red 是 run() 外面补的那格，readSummary 不返回它
    //（round292/295 各在这儿读过一次 undefined ⇒ 探针恒过）。
    if (s.failed <= 0) problems.push("自证①：有红而读成了绿");
  } catch (e) {
    problems.push("自证① 抛：" + String(e instanceof Error ? e.message : e).slice(0, 160));
  }
  checks += 1;
  // ② 装载期失败：FAIL 行【没有】用例名，必须只归因到文件而不硬造一个名字。
  const loadFail =
    " FAIL  " + SPEC + " [ " + SPEC + " ]\n" +
    "Error: Transform failed with 1 error:\n" +
    " Test Files  1 failed | 31 passed (32)\n" +
    "      Tests  420 passed (420)\n";
  try {
    const s = readSummary(loadFail);
    if (s.failed <= 0) problems.push("自证②：文件级失败被读成了绿（round295 那个洞复发）");
    if (!s.files.has(SPEC)) problems.push("自证②：没归因到那份文件");
    if (s.tests.size !== 0) {
      problems.push("自证②：装载失败被【造】出了用例名 ⇒ 点名判据会误命中");
    }
  } catch (e) {
    problems.push("自证② 抛：" + String(e instanceof Error ? e.message : e).slice(0, 160));
  }
  checks += 1;
  // ③ 全绿那一屏读成【绿】：M0 只有在这判过之后才算数。
  const green =
    " Test Files  1 passed (1)\n" +
    "      Tests  23 passed (23)\n" +
    "   Start at  08:34:11\n";
  try {
    const s = readSummary(green);
    if (s.failed !== 0) problems.push("自证③：failed = " + s.failed + "（要 0 ⇒ 全绿不许读成红）");
    if (s.passed !== 23) problems.push("自证③：passed = " + s.passed + "（要 23）");
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
  // ⑤ 文件红了却没有 FAIL 行 ⇒ 也抛（归因失真那一格）。
  let threwAttr = false;
  try {
    readSummary(" Test Files  1 failed (1)\n      Tests  22 passed (23)\n");
  } catch {
    threwAttr = true;
  }
  if (!threwAttr) problems.push("自证⑤：文件红而无 FAIL 行时没抛 ⇒ 归因会失真");
  checks += 1;
  // ⑥ 【本轮新增那判的反面】：红在【别的用例】上不算点名命中。
  //    这一发测的是这台机器的判定逻辑本身，不是 readSummary 的解析。
  const s6 = readSummary(
    " FAIL  " + SPEC + " > 类型棘轮：判据 > 恰好在基线上 ⇒ 绿（控制组）\n" +
      " Test Files  1 failed (1)\n" +
      "      Tests  1 failed | 22 passed (23)\n",
  );
  if (s6.tests.has(T_OUTSIDE)) {
    problems.push("自证⑥：红在别的用例上却被点成了本轮那一发 ⇒ 点名判据恒真");
  }
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
      problems.push(
        "红/绿与预期不符（应" + (m.expectRed ? "红" : "绿") + "，实得红=" + got.failed + "）",
      );
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
      "红=" +
      got.failed +
      "（用例 " +
      got.failedTests +
      " / 文件 " +
      got.failedFiles +
      "）/ 绿发=" +
      got.passed +
      " / 红用例=" +
      (got.tests.size === 0 ? "—" : [...got.tests].map((t) => t.slice(0, 26)).join(","));
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
  results.push([
    hit && restored,
    m.label,
    m.expectRed ? "该红" : "该绿",
    state + (restored ? "" : " 【还原失败】"),
    err,
    m.note,
  ]);
}

const self = selfCheck();
if (self.problems.length > 0) {
  console.error("这台机器自己没通过自证，【一发都没跑】：\n  " + self.problems.join("\n  "));
  process.exit(1);
}
console.log(
  "机器自证 " +
    String(self.checks) +
    "/" +
    String(self.checks) +
    " 通过（色码+用例名归因 / 装载失败不造用例名 / 全绿读成绿 / 读不到摘要就抛 / 红而无 FAIL 名就抛 / 红在别处不算命中）",
);

for (const m of MUTATIONS) execute(m);

console.log("\n══════ round296 变异矩阵（路径归一 + 仓内判定，逐字节自回滚）══════");
let ok = 0;
for (const [hit, label, want, state, err, note] of results) {
  ok += hit ? 1 : 0;
  console.log((hit ? "✓" : "✗") + " " + label + "  [" + want + "] " + state);
  if (err !== "") console.log("    未命中原因：" + err);
  console.log("    " + note);
}
console.log("命中 " + ok + " / " + results.length);
process.exitCode = ok === results.length ? 0 : 1;
