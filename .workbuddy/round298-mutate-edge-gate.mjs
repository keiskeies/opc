/**
 * round298 · 「委派边门控」那一条自检到底有没有牙齿（打在真字节上，自回滚）。
 *
 * 跑法：node .workbuddy/round298-mutate-edge-gate.mjs
 * 【单独跑】，不与任何测试并发（它会临时改盘上字节）。
 *
 * ── 判的对象 ────────────────────────────────────────────────────────
 *  packages/hub/src/db/integrity.ts 的 delegationEdgeGateCheck（新格子
 *  delegation_edges_gated），配 packages/hub/test/db/integrity.test.ts 的 ⑤b 七发。
 *  0064 §6 第 4 条登记的那一格：保存期判据只看【增量】那条边，存量脏图没人看。
 *
 * ── 六发，各打一个不同的失效方向 ────────────────────────────────────
 *  · M0 控制组【该绿】：在函数头上方加一条空注释。字节变了而读数不变，
 *    证明这台读的是【读数】不是「文件动过没有」。
 *  · M1 门控判成「有没有填」而不是「是不是 true」（`!== true` → `!= null`）
 *    ⇒ 该红，且必须红在 ok/violated 那一发【和】脏在老版本那一发上。
 *    这是本条自检最本质的失效方式：`review_gate: false` 是【填了】的，
 *    拿「填没填」当判据会把它放过去，而 §8.2 第 4 条要的是「带不带门控」。
 *  · M2 只扫最新版（SQL 加 WHERE version = MAX(version)）⇒ 该红，红在⭐脏在老版本。
 *    ⚠ 这是本轮【最想写错】的那一发：只扫最新看起来完全合理，而且【今天】的库
 *    只有 0 行，两种写法在真库里给【一样】的读数 —— 也就是说这一发的红
 *    只能靠【夹具】造出来，靠现网数据永远发现不了。
 *  · M3 撤掉 schema 那道判（信 `as OrgGraph` 那种强转）⇒ 该红，红在⭐形状不合契约。
 *    对应本轮量到的事实：读取口全部 `JSON.parse(...) as OrgGraph`，
 *    而 test/graph/e2e-linear.test.ts 真存过 `{nodes:{},edges:{}}`（edges 是对象）。
 *  · M4 把「整库零边」也算 ok（`edges === 0` → `false`）⇒ 该红，红在空图那一发。
 *    本文件的家规：空不是通过，是单独一栏（④ 节那段 0016 §4b）。
 *  · M5 把假句子写回 not_observable 文案（「src 里零 INSERT」）⇒ 该红，红在零行那一发。
 *    对应 0063 / zero-producer.ts 那一格：文案里的事实断言【会过期】而文案本身恒绿。
 *    本轮这条的真相是【有】写入方（INSERT_DELEGATION_GRAPH_SQL），所以那句话是假的。
 *
 *  · M5 把假句子写回 not_observable 文案（「src 里零 INSERT」）⇒ 该红，但【红的不是 ⑤b】。
 *    这是本轮最值钱的一发：⑤b 里那条 not.toContain(「零 INSERT」)【抓不到它】
 *    （假句与真句可以并存，子判据判不了"多了一句假话"），真抓它的是
 *    test/arch/zero-producer.ts 的登记表对账（红话点名 integrity.ts 那一行）。
 *    ⇒ 这台从 round296 的「一台打一份 spec」改成【每发带自己的 spec】：
 *      跨守卫的防护如果只在一台机器的取材面里，读数会说"没防护"。
 *      盲区本身也是【量】出来的（M5 顺手跑一次 ⑤b，逐发点名它没红），不是主张的。
 *
 * ── 归因到【哪一发用例】，不是【哪份文件】（round296 那台已有的一判）────────
 * 整份 integrity.test.ts 有 37 发，「文件红了」的分辨率不够：M2 可能红在别处而算命中。
 * 所以逐发点【用例名】，并且自证里专门有一发钉「红在别的用例上不算命中」。
 *
 * ⚠ 「这份文件根本没装载起来」有两种读数，本轮【各实测一次】（自证⑥⑦）：
 *    语法/transform 坏 ⇒ FAIL 只到文件级、`Tests no tests`、用例名【一个都没有】；
 *    运行期坏（函数体里塞个合法的坏表达式）⇒ 用例名【照长】，而且 ⑤b 六发同时红
 *    （判据抛 ⇒ guarded 翻 could_not_run ⇒ 每发断言都不符）。
 *    我第一版的装载判写的是「前提自证那一发红」—— 它只在第二种读数下成立，
 *    第一种读数下【永不触发】= 一条装饰。实测否证之后改成两种都认。
 *
 * ⚠ 五条纪律（前四条抄 round296 第五节，第五条是本轮自己撞出来的）：
 *  ① 还原写【进场时读到的字节】，不用 replace 反推；
 *  ② 还原在 finally 里，且在【校验之前】；
 *  ③ 所有锚点在第一发跑之前全部验一遍（命中恰好 1 次，且 to ≠ from）；
 *  ④ 读 vitest 输出先剥 ANSI，且「读不到摘要行」必须【抛】而不是当 0；
 *  ⑤ 锚点【命中 0 次】也要抛 —— 本轮把一条锚点写成单行，而盘上是
 *     `return {\n      name,\n      verdict: "not_observable",` 三行，
 *     命不中 ⇒ 那发变成空变异 ⇒ 「该红没红」会被读成判据没牙齿。
 *     （与 round295 那发不带引号的 add_edge、round297 那个 9999 夹具同一族：
 *      变异/夹具自己没落进判据的语言，而机器照样给一个数。）
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const GUARD = "packages/hub/src/db/integrity.ts";
const SPEC = "packages/hub/test/db/integrity.test.ts";

/** ⑤b 那七发的用例名（逐字抄自 SPEC；改一个字这台就会报「点不到名」）。 */
const T_EMPTY_TABLE = "delegation_graphs 零行 ⇒ not_observable，且文案【承认写入方存在】";
const T_NO_EDGES = "有图而整库一条边都没有 ⇒ not_observable（空图是合法形状，不是通过）";
const T_OK_FLIP = "每条边都带门控 ⇒ ok + checked=边数；把其中一条翻成 false ⇒ 立刻 violated";
const T_OLD_VERSION = "⭐ 脏在老版本也抓：v7 干净而 v3 有一条无门控边 ⇒ violated 点名 v3";
const T_BAD_JSON = "graph_json 不是合法 JSON ⇒ violated 点名那一版（判据跑成了，读不动是【数据】的结论）";
const T_BAD_SHAPE = "⭐ 形状不合契约也抓：edges 写成对象 ⇒ violated 说「不过 orgGraphSchema」";
const T_PREMISE = "前提自证：无门控边【过产品自己的两道闸门】—— 本自检的红不是只防手工修库";
/** M5 的归属：文案里的事实断言归这道守卫管（不是 ⑤b）。 */
const ZERO_SPEC = "test/arch/zero-producer.test.ts";
const T_ZERO_CLAIM = "登记表与原文对得上（七类不符全为空，报错时点名）";

const ESC = String.fromCharCode(27);
const MUTATIONS = [];

/**
 * 一发变异。`spec` = 这一发【期望被谁抓住】。
 *
 * ⚠ 默认打 ⑤b 那份测试，但 M5 不打：它是【文案里的事实断言】那一族，
 *   本仓管这件事的守卫是 test/arch/zero-producer.ts（登记表 + 双向对账），
 *   不是某条测试里的 not.toContain。本轮第一版就是把它当 ⑤b 的事来打，
 *   于是那发读成「判据没牙齿」—— 真相是【抓它的另有其人】。
 *   ⇒ 矩阵必须允许「红在哪份 spec」这一格，否则跨守卫的防护会被误读成没防护
 *     （round295 那台「扫的面里没有那件事」的镜像形状：面选错，读数就假）。
 */
function mutate(from, to, label, expectRed, mustRedTests, note, spec, blindGreen) {
  MUTATIONS.push({
    from,
    to,
    label,
    expectRed,
    mustRedTests,
    note,
    spec: spec ?? SPEC,
    blindGreen: blindGreen ?? [],
  });
}

/* 前提自证那一发【不发】跟着红：它不读 integrity.ts，所以它一旦红，红因就是
   【整份文件装载失败】而不是判据被改动 —— 那正是 round295 那台把 0/5 读成
   「红发 0」的镜像：红在别处也算红 ⇒ 归因失真。每台 SPEC 侧的读数都过这一判。 */
const MUST_STAY_GREEN = T_PREMISE;

/* M0 控制组：该绿。 */
mutate(
  "function delegationEdgeGateCheck(db: DatabaseSync): CheckResult {",
  "function delegationEdgeGateCheck(db: DatabaseSync): CheckResult { //",
  "M0 控制组：函数头加一条空注释",
  false,
  [],
  "字节变了而所有结论不变 ⇒ 这台读的是读数，不是「文件动过没有」",
);

/* M1 门控判成「填没填」。 */
mutate(
  "      if (e.review_gate !== true) {",
  "      if (e.review_gate == null) {",
  "M1 门控判成「有没有填」而不是「是不是 true」",
  true,
  [T_OK_FLIP, T_OLD_VERSION],
  "false 是【填了】的值；按「填没填」判就把它放过去了",
);

/* M2 只扫最新版。 */
mutate(
  '        "FROM delegation_graphs ORDER BY version",',
  '        "FROM delegation_graphs " +\n        "WHERE version = (SELECT MAX(version) FROM delegation_graphs) " +\n        "ORDER BY version",',
  "M2 只扫【最新版】那张图",
  true,
  [T_OLD_VERSION],
  "今天真库 0 行 ⇒ 两种写法读数相同；这一发的红只能靠夹具造出来",
);

/* M3 撤掉 schema 那道判（信强转）。 */
mutate(
  "    const parsed = orgGraphSchema.safeParse(raw);",
  "    const parsed = { success: true as const, data: raw as never };",
  "M3 撤掉 orgGraphSchema 那道判，退回【信 as OrgGraph】",
  true,
  [T_BAD_SHAPE],
  "读取口今天全是 JSON.parse(...) as OrgGraph；这一发证明那条链上确实有东西在判",
);

/* M4 整库零边也算通过。 */
mutate(
  "  if (edges === 0) {",
  "  if (false) {",
  "M4 「整库一条边都没有」不再单独成栏，混进 ok",
  true,
  [T_NO_EDGES],
  "空不是通过（本文件 ④ 节 0016 §4b 那一格）",
);

/* M5 把假句子写回文案 —— 打的是 zero-producer，不是 ⑤b（见上面 mutate 的注释）。 */
mutate(
  '        "delegation_graphs 是空的 —— 这一份库还没提交过任何一版组织图，" +',
  '        "delegation_graphs 是空的。src 里【没有任何 INSERT INTO delegation_graphs】" +',
  "M5 把【过期/假】的句子写回 not_observable 的文案",
  true,
  [T_ZERO_CLAIM],
  "0063 / zero-producer.ts 那一格：文案里的事实断言会过期而文案本身恒绿。" +
    "本轮实测：⑤b 那条 not.toContain(零 INSERT) 抓不到它（假句与真句可以并存），" +
    "真抓它的是 zero-producer 的登记表对账，红话直接点名 integrity.ts 那一行",
  ZERO_SPEC,
  [T_EMPTY_TABLE],
);

function strip(s) {
  return s.replace(new RegExp(ESC + "\\[[0-9;]*m", "g"), "");
}

/** 读 vitest 的读数：文件级【和】用例级归因都要拿到，拿不到就抛。 */
function readSummary(out) {
  const clean = strip(out);
  if (/Transform failed|Cannot find module|SyntaxError/u.test(clean)) {
    if (!clean.includes("FAIL")) {
      throw new Error("装载期失败但读不到 FAIL 行，整张矩阵不可读。尾部：\n" + clean.slice(-800));
    }
  }
  const m = clean.match(/^\s*Tests\s+(.+)$/m);
  if (m === null) {
    throw new Error(
      "读不到 vitest 的「Tests」摘要行 —— 【不能】当 0：那会把红读成绿，整张矩阵假绿。尾部：\n" +
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
    throw new Error("读不到「Test Files」摘要行，不许当 0。尾部：\n" + clean.slice(-400));
  }
  const failedFiles = Number((tf[1].match(/(\d+) failed/) ?? [0, "0"])[1]);
  if (failedFiles > 0 && files.size === 0) {
    throw new Error(
      "有 " + failedFiles + " 份文件红了但【读不到 FAIL 行的文件名】⇒ 归因失真。尾部：\n" +
        clean.slice(-800),
    );
  }
  return { failed: failedTests + failedFiles, failedTests, failedFiles, passed, files, tests };
}

function run(spec) {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", spec],
    { cwd: ROOT, encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 },
  );
  const got = readSummary(String(r.stdout) + String(r.stderr));
  return Object.assign({}, got, { red: got.failed > 0 });
}

/** 机器自证：不打判据，只验这台读摘要的机器读得对。分母【数出来】。 */
function selfCheck() {
  const problems = [];
  let checks = 0;
  const colored =
    " " + ESC + "[41m" + ESC + "[1m FAIL " + ESC + "[22m" + ESC + "[49m " + SPEC +
    " > ⑤b 委派边门控 > " + T_OLD_VERSION + "\n" +
    "AssertionError: expected 'ok' to be 'violated'\n" +
    " Test Files " + ESC + "[31m1 failed" + ESC + "[39m (1)\n" +
    "      Tests " + ESC + "[31m1 failed" + ESC + "[39m | 36 passed (37)\n";
  try {
    const s = readSummary(colored);
    if (s.failedTests !== 1) problems.push("自证①：用例红 = " + s.failedTests + "（要 1）");
    if (!s.files.has(SPEC)) problems.push("自证①：色码里没归因到那份文件");
    if (!s.tests.has(T_OLD_VERSION)) problems.push("自证①：用例名没读出来 ⇒ 点名会全成假未命中");
    if (s.failed <= 0) problems.push("自证①：有红而读成了绿");
  } catch (e) {
    problems.push("自证① 抛：" + String(e instanceof Error ? e.message : e).slice(0, 160));
  }
  checks += 1;
  // ② 装载期失败：没有用例名，不许硬造一个。
  try {
    const s = readSummary(
      " FAIL  " + SPEC + " [ " + SPEC + " ]\nError: Transform failed with 1 error:\n" +
        " Test Files  1 failed | 36 passed (37)\n      Tests  37 passed (37)\n",
    );
    if (s.failed <= 0) problems.push("自证②：文件级失败被读成绿（round295 那个洞复发）");
    if (s.tests.size !== 0) problems.push("自证②：装载失败被【造】出了用例名");
  } catch (e) {
    problems.push("自证② 抛：" + String(e instanceof Error ? e.message : e).slice(0, 160));
  }
  checks += 1;
  // ③ 全绿读成绿：M0 只有在这判过之后才算数。
  try {
    const s = readSummary(" Test Files  1 passed (1)\n      Tests  37 passed (37)\n");
    if (s.failed !== 0) problems.push("自证③：全绿被读成红");
  } catch (e) {
    problems.push("自证③ 抛：" + String(e instanceof Error ? e.message : e).slice(0, 160));
  }
  checks += 1;
  // ④ 读不到摘要必须【抛】，不许返回 0。
  try {
    readSummary("some random output without summary lines");
    problems.push("自证④：读不到摘要行却没抛 —— 会被当成「红发 0」");
  } catch {
    /* 期望抛。 */
  }
  checks += 1;
  // ⑤ 红在【别的用例】上不算点名命中：这一判是 M1/M2 的归因可信度的全部依据。
  try {
    const s = readSummary(
      " FAIL  " + SPEC + " > ⑤ §22.4 审计自洽 > " + T_BAD_JSON + "\n" +
        " Test Files  1 failed (1)\n      Tests  1 failed | 36 passed (37)\n",
    );
    if (s.tests.has(T_OLD_VERSION)) {
      problems.push("自证⑤：没红的用例被当成红了 ⇒ mustRed 会假命中");
    }
    if (!s.tests.has(T_BAD_JSON)) problems.push("自证⑤：红掉的那发没被点名");
  } catch (e) {
    problems.push("自证⑤ 抛：" + String(e instanceof Error ? e.message : e).slice(0, 160));
  }
  checks += 1;
  // ⑥ 两种「装载/整份塌了」的读数都要认得（本轮各实测一次，见主循环那段注释）。
  //    这一判是【主循环那条 loadBroke】的依据；少了它，主循环那两行是没人验过的代码。
  try {
    const transformFail =
      " FAIL  " + SPEC + " [ " + SPEC + " ]\n" +
      "Test Files  1 failed (1)\n      Tests  no tests\n";
    const s = readSummary(transformFail);
    if (!(s.failedTests === 0 && s.failedFiles > 0)) {
      problems.push(
        "自证⑥：transform 失败没读成「用例 0 而文件红」(=" +
          s.failedTests + "/" + s.failedFiles + ") ⇒ 主循环会把整份塌掉读成正常命中",
      );
    }
  } catch (e) {
    problems.push("自证⑥ 抛：" + String(e instanceof Error ? e.message : e).slice(0, 160));
  }
  checks += 1;
  // ⑦ 运行期塌了那一型：用例名照长，前提自证那发红 ⇒ 必须认得出（实测过这种读数）。
  try {
    const s = readSummary(
      " FAIL  " + SPEC + " > ⑤b 委派边门控 > " + T_PREMISE + "\n" +
        " Test Files  1 failed (1)\n      Tests  7 failed | 30 passed (37)\n",
    );
    if (!s.tests.has(T_PREMISE)) problems.push("自证⑦：运行期塌了那一型认不出（前提自证没被点名）");
  } catch (e) {
    problems.push("自证⑦ 抛：" + String(e instanceof Error ? e.message : e).slice(0, 160));
  }
  checks += 1;
  return { problems, checks };
}

/** 锚点预检：命中恰好 1 次，且 to ≠ from（纪律③⑤）。 */
function preflight() {
  const problems = [];
  for (const [i, m] of MUTATIONS.entries()) {
    if (m.from === m.to) problems.push("M" + i + "：to 与 from 相同 = 空变异");
    const text = readFileSync(join(ROOT, GUARD), "utf8");
    const hits = text.split(m.from).length - 1;
    if (hits !== 1) {
      problems.push(
        "M" + i + " 锚点命中 " + hits + " 次（要恰好 1 次）：" + m.label +
          "\n     锚点：" + m.from.slice(0, 70).replace(/\n/g, "\\n"),
      );
    }
  }
  return problems;
}

function main() {
  const self = selfCheck();
  if (self.problems.length > 0) {
    console.error("这台机器自己没通过，【读数不可用】：\n  " + self.problems.join("\n  "));
    process.exitCode = 1;
    return;
  }
  console.log("机器自证 " + self.checks + "/" + self.checks + " 通过（用例名归因 / 装载失败不造名 / 全绿读绿 / 读不到摘要要抛 / 红在别处不算命中）");

  const pre = preflight();
  if (pre.length > 0) {
    console.error("锚点预检失败，【一发都没跑】（跑了也是空变异）：\n  " + pre.join("\n  "));
    process.exitCode = 1;
    return;
  }
  console.log("锚点预检 " + MUTATIONS.length + "/" + MUTATIONS.length + " 命中且互不相同");

  const baseline = run(SPEC);
  const zeroBaseline = run(ZERO_SPEC);
  if (!baseline.red && !zeroBaseline.red) {
    console.log(
      "基线绿：" + SPEC.split("/").pop() + " " + baseline.passed +
        " passed；" + ZERO_SPEC.split("/").pop() + " " + zeroBaseline.passed + " passed。",
    );
  } else {
    console.error("基线【就是红的】(" + baseline.failed + " 红) —— 变异矩阵的读数全部不可信，先修基线。");
    console.error("  红的用例：" + [...baseline.tests].join(" | "));
    process.exitCode = 1;
    return;
  }

  const original = readFileSync(join(ROOT, GUARD), "utf8");
  const rows = [];
  try {
    for (const m of MUTATIONS) {
      writeFileSync(join(ROOT, GUARD), original.split(m.from).join(m.to), "utf8");
      let got;
      let other = null;
      /** SPEC 侧的读数（M5 有两次：cross-guard 那次也要过装载判）。 */
      const specSide = [];
      try {
        got = run(m.spec);
        if (m.spec === SPEC) specSide.push(got);
        // 跨守卫那一发（M5）顺手量另一侧：假句子在【这条自检】里到底红不红。
        // 不量就只能【主张】它有盲区，量了才是【数出来】它有盲区。
        if (m.spec !== SPEC) {
          other = run(SPEC);
          specSide.push(other);
        }
      } finally {
        writeFileSync(join(ROOT, GUARD), original, "utf8");
      }
      const missing = m.mustRedTests.filter((t) => !got.tests.has(t));
      let hit = m.expectRed ? got.red && missing.length === 0 : !got.red;
      let tail = "";
      /* 「装载坏了」有两种读数，本轮【各实测一次】，因为第一版只写了后一种：
         · 语法/transform 坏：FAIL 只到【文件级】，`Tests no tests`，用例名【一个都没有】
           ⇒ 判据是 failedTests === 0 而 failedFiles > 0。
           ⚠ 我第一版写的是「前提自证那一发红」—— 那一判在这种读数下【永不触发】，
             是一条装饰（写它时我以为装载失败会长出用例名，实测否证）。
         · 运行期坏（比如函数体里塞一个合法的坏表达式）：用例会【照样长出名字】，
           前提自证那一发【不读 integrity.ts】，它一红就说明整体塌了。 */
      const loadBroke =
        specSide.some((s) => s.failedTests === 0 && s.failedFiles > 0) ||
        specSide.some((s) => s.tests.has(MUST_STAY_GREEN));
      if (loadBroke) {
        hit = false;
        tail += " 【装载/整份塌了 ⇒ 这一发读数不可信】";
      }
      if (other !== null) {
        // 逐发点名判「盲区」：这些用例在【被改坏之后】仍然没红。
        // 判文件级太粗——别的用例红也会把它读成"有防护"。
        const stillGreen = m.blindGreen.filter((t) => !other.tests.has(t));
        const caught = m.blindGreen.filter((t) => other.tests.has(t));
        tail +=
          " ⑤b 侧点名：" +
          (stillGreen.length === m.blindGreen.length
            ? stillGreen.length + " 发【全绿】⇒ 盲区量出来了"
            : "有 " + caught.length + " 发红 ⇒ ⑤b 那条子判据其实抓得到") +
          (caught.length > 0 ? "（抓到：" + caught.join(" / ") + "）" : "");
        // 这一判的【预期】也是主张：本轮实测是"全绿"。哪天 ⑤b 真能抓到了，
        // 这里会红 —— 那是防护变密的好消息，修法是把预期翻成"该红"。
        if (stillGreen.length !== m.blindGreen.length) hit = false;
      }
      rows.push({ label: m.label, hit, got, missing, note: m.note, expectRed: m.expectRed });
      console.log(
        (hit ? "✓ " : "✗ ") + m.label +
          " ⇒ " + m.spec.split("/").pop() + " 红发 " + got.failed +
          "（" + (got.red ? "红" : "绿") + "）" +
          (missing.length > 0 ? " 【点不到名】" + missing.join(" / ") : "") +
          tail,
      );
    }
  } finally {
    writeFileSync(join(ROOT, GUARD), original, "utf8");
    const back = readFileSync(join(ROOT, GUARD), "utf8");
    console.log("还原校验：" + (back === original ? "字节一致" : "【不一致 —— 立刻 git diff 看现场】"));
    if (back !== original) process.exitCode = 1;
  }

  const miss = rows.filter((r) => !r.hit);
  const reds = rows.filter((r) => r.expectRed).length;
  console.log(
    "\n命中 " + (rows.length - miss.length) + "/" + rows.length +
      "（M0 该绿 + " + reds + " 发该红且点名）",
  );
  for (const r of miss) {
    console.log("  未命中：" + r.label + " ⇒ 实际红发 " + r.got.failed +
      (r.missing.length > 0 ? "，点不到：" + r.missing.join(" / ") : ""));
  }
  if (miss.length > 0) process.exitCode = 1;
}

main();
