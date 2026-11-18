/**
 * round295 · 证据③ 那一族有没有牙齿（打在真字节上，自回滚）。
 *
 * 跑法：node .workbuddy/round295-mutate-frontend-egress.mjs
 * 【单独跑】，不与任何测试并发（它会临时改盘上字节）。
 *
 * ── 本轮要证的是一件很具体的事 ──────────────────────────────────────
 * 证据③ 原来写「两个前端里 add_edge / reparent 零出现」并且绿了六轮，而
 * `packages/web/public/app.js` 从 2026-11-11 起就在真发 `kind: "reparent"`
 * （`git log -S` 追到 2bcbdb0）。修完之后「绿」有两种：一种是因为扫描面修对了，
 * 一种是因为扫描器根本没在跑。这一台就是分开那两种的。
 *
 * ── 六发，各自的形状 ───────────────────────────────────────────────
 *  · M0 控制组【该绿】。矩阵里没有任何一发绿得比"控制组也绿"更值得信。
 *  · M1 把 reparent 那个载荷换成 add_edge ⇒ 名单从 {reparent:[app.js],add_edge:[]}
 *    变成 {reparent:[],add_edge:[app.js]} ⇒ 该红。这一发证【名单真的在比字节】。
 *  · M2 把那次 api("POST","/org") 调用摘掉（载荷还在而没人发）⇒ 该红。
 *    它钉的是「构造 ≠ 发出」。
 *  · M3 把 kind 名改成 `reparent `（多一个空格，正则不再匹配）⇒ 该红。
 *    它与 M1 分开，因为 M1 换的是【另一种 kind】（名单仍非空），M3 换成【谁都不算】
 *    ⇒ 两格全空。只有 M3 能证「空名单」是会红的，否则那两格可能恒绿。
 *  · M4 往 `packages/web/src/hub/projection.ts` 的注释里写【带引号的】"add_edge"
 *    ⇒ 【该红】。这一发是本轮的【射程边界】，不是缺陷清单：那道判据扫的是字节，
 *    不剥注释（剥注释要处理字符串里的 `//`、块注释里的 `//`，r22 那条判据
 *    为这两个洞各写了一发，代价明显高于本轮收益）。它红，说明将来有人在
 *    前端注释里写一份 `kind: "add_edge"` 的示例时，那道判据会把他叫停 ——
 *    那是【保守方向的红】（多响一次），不是漏响。量出来登记，别让它当缺陷被删。
 *  · M5 同一位置写【不带引号】的 add_edge ⇒ 【该绿】。
 *    ⚠ 本轮我自己的主张在这儿被推翻过一次：第一版 M4 写的是「注释里提 add_edge
 *    三个字 ⇒ 该红」，跑出来 0 红 —— 那道判据的正则两侧都要引号，裸词不算发变更，
 *    所以那发是【空变异】，而错的【预期】被登记成了「射程边界」。
 *    ⇒ 口径是「引号」不是「字节」；M4/M5 同位置只差那对引号，一边红一边绿。
 *
 *
 * ── 这台机器自己撞出来的那一格（比本轮那个假证人更贵）────────────────
 * 第一版跑完 0/5 命中，五发全部读成「红发=0」。真因不是变异，是本轮新写的
 * ④ 那一发里有一个 `const consoleText` 与上面重名 ⇒ 那整份测试文件【装载期就解析失败】，
 * 而 vitest 的 `Tests` 摘要行照报「红发 0」（它一个用例都没跑到），
 * 只有 `Test Files` 那一行写着 1 failed。⇒ 只读前一行的机器，
 * 可以在【一发都没测】的状态下把整张矩阵报成命中。
 * ⇒ readSummary 现在把【文件级失败】并进红，且「文件红了但读不到 FAIL 文件名」
 * 一律【抛】—— 归因失真会让「该红的文件没红」那一判变成假命中。
 *
 * ⚠ 加那条「抛」之前量过一次真输出（一份故意红的探针，跑完即删）：
 * 普通「一个用例红」也会打 ` FAIL  <文件> > <suite> > <用例名>` ⇒
 * 「文件红 ⇒ 必有 FAIL 行」不是只对本机装载失败成立的那格，这判才敢留。
 * 而自证① 的夹具【第一版没给 FAIL 行】，于是这台机器把【自己的】不可能夹具
 * 报成判据坏了 —— 这段留在这儿是因为它的反面（判据在真语料上抛、在假语料上过）
 * 是最难看出来的一种坏。
 * 前几轮那几台（round292/293/294）的 readSummary 是同一个形状，这个洞它们【也】有；
 * 本轮只修了这一台，其余那三台的账记进台账（不顺手改：那三台的证据文件已交出去，
 * 改了要重跑才能说「修完仍然 7/7」，而那是另起一轮的账）。
 * ⚡ round301 改口（原话留着，因为它记的那件【事】是真的，错的只是「同一形状」）：
 *    逐字节切出来喂真屏量过 —— 那三台与本机【不是】同一形状，是【两种架构】：
 *    本机与 round296 起那几台靠 FAIL 行归因、把文件级红【并进】自己的 failed；
 *    那三台只数两行摘要、没有用例名归因 ⇒ 同一屏上给出三种不同读数，
 *    危害方向也不同（那三台是「控制组在什么都没跑上判绿」，本机这一族是「红话说假原因」）。
 *    「形状」这类断言只能切字节量，不能从「判式长得像」推 —— 推出来的那半错的
 *    恰是决定危害方向的那半（round300 立的那条家规，这次中的是我自己的登记）。
 *    那三台 round301 已各补两格 + 一段读真屏的自证（7/7、7/7、5/5、10/10，全部重跑）。
 *
 * ⚠ 四条纪律（前几轮那几台机器各自撞过的坑，逐条带着）：
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

const E2E = "packages/hub/test/acceptance/new-role-to-its-own-criteria.test.ts";
const CRIT = "test/arch/claims-registry.test.ts";
const APP = "packages/web/public/app.js";
const PROJ = "packages/web/src/hub/projection.ts";

/** 这一台只跑这两份：那发端到端 + r15 那条判据自己。 */
const TEST_FILES = [E2E, CRIT];

const ESC = String.fromCharCode(27);
const results = [];
const MUTATIONS = [];

function mutate(rel, from, to, label, expectRed, mustRed, mustGreen, note) {
  MUTATIONS.push({ rel, from, to, label, expectRed, mustRed, mustGreen, note });
}

/* ── M0：控制组（该绿）────────────────────────────────────────────── */
mutate(
  APP,
  '    change: { kind: "reparent", child_role: child, new_parent_role: parent },',
  '    change: { kind: "reparent", child_role: child, new_parent_role: parent }, //',
  "M0 控制组：只在行尾加一条空注释",
  false,
  [],
  [E2E, CRIT],
  "字节变了而 kind 名单、调用、取材面一个字没动 ⇒ 两份都必须绿。" +
    "这一发如果红，说明那判据对【无关文案】敏感，那它活不过下周",
);

/* ── M1：reparent 载荷换成 add_edge ───────────────────────────────── */
mutate(
  APP,
  '    change: { kind: "reparent", child_role: child, new_parent_role: parent },',
  '    change: { kind: "add_edge", edge: { from: child, to: parent, review_gate: true } },',
  "M1 界面那一跳从 reparent 改成 add_edge",
  true,
  [E2E],
  [CRIT],
  "名单从 {reparent:[app.js], add_edge:[]} 翻成 {reparent:[], add_edge:[app.js]} ⇒ 端到端红。" +
    "⚠ 它【不该】红在 claims-registry：那条判据管的是取材面自不自洽，不管名单内容 —— " +
    "「加戏要经过判据」这件事在 r15 那边另有一格，本轮不动它的口径",
);

/* ── M2：构造了载荷而没人发 ───────────────────────────────────────── */
mutate(
  APP,
  '  const { status, data } = await api("POST", "/org", {',
  '  const { status, data } = await orgRequestUnused("POST", "/org", {',
  'M2 把 api("POST","/org") 那次调用摘掉（载荷照旧构造）',
  true,
  [E2E],
  [CRIT],
  "这一发钉的是本轮那条④：『界面发得出 X』这句里有【发出】两个字。" +
    "只核载荷的话，把调用注释掉不改变前③条任何一条，而它现在会红。" +
    "⚠ 本机没有浏览器（0039），做不到真点一次 ⇒ ④ 是【最接近那格】而不是浏览器证据",
);

/* ── M3：kind 名改成谁都不算 ──────────────────────────────────────── */
mutate(
  APP,
  '    change: { kind: "reparent", child_role: child, new_parent_role: parent },',
  '    change: { kind: "reparent ", child_role: child, new_parent_role: parent },',
  "M3 把 kind 那个字符串改成带尾空格的 reparent（谁都不匹配）",
  true,
  [E2E],
  [CRIT],
  "与 M1 分开跑的理由：M1 把 reparent 挪到【另一种 kind】名下（名单非空，只是内容变了），" +
    "M3 让它【什么都不落在】⇒ 两格全空。只有 M3 能证『空名单会红』——" +
    "没有它，那两格空名单是恒绿还是真判，读代码分不出来",
);

/* ── M4：注释里写一个【带引号】的 "add_edge"（射程边界，该红）──────── */
mutate(
  PROJ,
  " * 幂等【只覆盖重复】，不覆盖【丢失】。",
  ' * 幂等【只覆盖重复】，不覆盖【丢失】（与 "add_edge" 无关，纯注释）。',
  'M4 往 web/src 一份文件的【注释】里写带引号的 "add_edge"',
  true,
  [E2E],
  [],
  "【射程边界，量出来登记用】那道判据扫字节、不剥注释 ⇒ 注释里出现【带引号的】kind 名就红。" +
    "方向是保守的（多响一次，不是漏响）；剥注释那一刀在本仓有两个已登记的洞" +
    "（字符串里的 // 与块注释里的 //，r22 各有一发钉），代价高于本轮收益。" +
    "⇒ 别把这一发当缺陷删掉；要减它的噪声，先读 r22 那两发",
);

/* ── M5：注释里写【不带引号】的 add_edge（该绿）──────────────────── */
// ⚠ 这一发是【本轮我自己那句主张被推翻的地方】，所以它比 M4 更值得留。
// 矩阵第一版把 M4 写成「注释里提 add_edge 三个字 ⇒ 该红」，跑出来 0 红：
// 那道判据的正则是 ["'`]kind["'`] —— 两侧都要引号，裸词不算『发这个变更』。
// 于是那发 M4 是个【空变异】（改了字节、谁都匹配不上），而它【该红】的预期本身是错的。
// 空变异被登记成「射程边界」= 把机器的读数写成了产品的事实。
// ⇒ M4 改真（补引号），M5 钉住【不匹配】那一侧：裸词绿 ⇒ 边界是「引号」而不是「字节」。
mutate(
  PROJ,
  " * 幂等【只覆盖重复】，不覆盖【丢失】。",
  " * 幂等【只覆盖重复】，不覆盖【丢失】（与 add_edge 无关，纯注释）。",
  "M5 注释里写不带引号的 add_edge（空变异，该绿）",
  false,
  [],
  [E2E, CRIT],
  "M4 的反面：同一个位置、同一个 kind 名，只差那对引号 ⇒ 一边红一边绿。" +
    "没有这一发，M4 的红会被读成『注释里提到 kind 就红』（本轮第一版我就是这么写的），" +
    "而真口径是【带引号才算】—— 口径写宽了，下一个人会照着错的口径去改判据",
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
if (bad.length > 0) {
  console.error("锚点校验失败，【一发都没跑】：\n  " + bad.join("\n  "));
  process.exit(1);
}

/**
 * 从 vitest 的输出里读「红了几发 / 红了哪几份文件」。
 *
 * 三格各自防的失效：
 *  a) 剥 ANSI 不生效 ⇒ 摘要行前留着 ESC ⇒ 报「读不到摘要」，看着像被测对象的错
 *     （round292 中过）。这里不但用 new RegExp + 可见转义拼 ESC，
 *     还【当场验】它生效（剥完仍含 ESC ⇒ 抛）。
 *  b) 「读不到摘要」当 0 ⇒ 红读成绿，整张矩阵假绿（round292 中过）⇒ 一律抛。
 *  c) 【本轮新的一格】文件级装载失败时 `Tests` 行报「红发 0」⇒ 必须并上
 *     `Test Files` 那一行；且文件红了却读不到 FAIL 文件名 ⇒ 抛（归因不许失真）。
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
  for (const line of clean.split("\n")) {
    const fm = /^\s*FAIL\s+(\S+\.(?:ts|tsx))\b/u.exec(line);
    if (fm !== null && fm[1] !== undefined) files.add(fm[1].split("\\").join("/"));
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
        "（『该红的文件没红』那一判会变成假命中）。摘要尾部：\n" +
        clean.slice(-800),
    );
  }
  return {
    failed: failedTests + failedFiles,
    failedTests,
    failedFiles,
    passed,
    files,
  };
}

function run() {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", ...TEST_FILES],
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
  // 「5/5 通过」会变成一句永远为真的谎。
  let checks = 0;
  // 夹具是【真屏的逐行抄写】（一份故意红的探针跑出来的那四行，色码是真的 ESC）。
  // ⚠ 这不是吹毛求疵：我第一版的夹具① 只给了 Tests 那一行，自证当场抛
  // 「读不到 Test Files」；第二版补了两行摘要但没给 FAIL 行，又被【新的那条抛】
  // 拦下 —— 两次都看着像判据坏了，其实是我给的语料不像真输出。
  // 判据【该】在那种输入上抛（缺行不许当 0），所以错的是夹具。
  // ① 剥 ANSI 生效 + FAIL 行归因生效（真带色码、真有一发用例红）。
  const colored =
    " " + ESC + "[31m❯" + ESC + "[39m packages/hub/test/x.test.ts" +
    " 1 test" + ESC + "[31m 1 failed" + ESC + "[39m\n" +
    ESC + "[41m" + ESC + "[1m FAIL " + ESC + "[22m" + ESC + "[49m packages/hub/test/x.test.ts > s > c\n" +
    "AssertionError: expected 1 to be 2\n" +
    " " + ESC + "[22m Test Files " + ESC + "[22m " + ESC + "[1m" + ESC + "[31m1 failed" +
    ESC + "[39m" + ESC + "[22m" + ESC + "[90m (2)" + ESC + "[39m\n" +
    " " + ESC + "[22m      Tests " + ESC + "[22m " + ESC + "[1m" + ESC + "[31m1 failed" +
    ESC + "[39m" + ESC + "[22m | 111 passed (112)\n";
  try {
    const s = readSummary(colored);
    if (s.failedTests !== 1) {
      problems.push("自证①：带色码的摘要读出用例红 = " + s.failedTests + "（要 1）");
    }
    if (s.failedFiles !== 1) {
      problems.push("自证①：文件红 = " + s.failedFiles + "（要 1）");
    }
    if (!s.files.has("packages/hub/test/x.test.ts")) {
      problems.push("自证①：色码里没归因到那份文件 ⇒ M1/M2/M3 的 mustRed 会全成假未命中");
    }
    // ⚠ 这里读的是 failed 而不是 red：red 是 run() 外面补的那一格，
    //    readSummary 自己不返回它 —— 上一版在这里读过一次 s.red（同 round292 那台
    //    读过 s.red 的错），后果是【自证永远说机器坏了】，比不打产品更误导人。
    if (s.failed <= 0) problems.push("自证①：有红而读成了绿");
  } catch (e) {
    problems.push("自证① 抛：" + String(e instanceof Error ? e.message : e).slice(0, 140));
  }
  checks += 1;
  // ② 文件级装载失败必须算红（本轮那个洞的直接回归）：Tests 行【一个红都没有】，
  //    只有 Test Files 那一行写着 1 failed —— 旧版就在这儿把红读成绿。
  const loadFail =
    " FAIL  packages/hub/test/x.test.ts [ packages/hub/test/x.test.ts ]\n" +
    "Error: Transform failed with 1 error:\n" +
    " Test Files  1 failed | 1 passed (2)\n" +
    "      Tests  111 passed (111)\n";
  try {
    const s = readSummary(loadFail);
    if (s.failed <= 0) problems.push("自证②：文件级失败被读成了绿（本轮那个洞复发）");
    if (s.failedTests !== 0) problems.push("自证②：failedTests = " + s.failedTests + "（要 0）");
    if (s.failedFiles !== 1) problems.push("自证②：failedFiles = " + s.failedFiles + "（要 1）");
    if (!s.files.has("packages/hub/test/x.test.ts")) {
      problems.push("自证②：没归因到那份文件");
    }
  } catch (e) {
    problems.push("自证② 抛：" + String(e instanceof Error ? e.message : e).slice(0, 140));
  }
  checks += 1;
  // ③ 全绿那一屏读成【绿】：控制组 M0 只有在这判过之后才算数。
  //    少了它，「摘要读不出红」和「确实没红」同形 —— 与本轮登记的那一族一个形状。
  const green =
    " Test Files  2 passed (2)\n" +
    "      Tests  122 passed (122)\n" +
    "   Start at  02:41:26\n";
  try {
    const s = readSummary(green);
    // 同上一条：不许读 s.red（readSummary 不返回它 ⇒ 恒 undefined ⇒ 这判恒过）。
    if (s.failed !== 0) problems.push("自证③：failed = " + s.failed + "（要 0 ⇒ 全绿不许读成红）");
    if (s.passed !== 122) problems.push("自证③：passed = " + s.passed + "（要 122）");
    if (s.files.size !== 0) problems.push("自证③：绿屏里冒出了红文件");
  } catch (e) {
    problems.push("自证③ 抛：" + String(e instanceof Error ? e.message : e).slice(0, 140));
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
  // ⑤ 文件红了却没有 FAIL 行 ⇒ 也【抛】（归因失真的那格）。
  //    这条测的是判据本身，不是产品：它若不抛，M1~M4 的「该红的文件没红」会变成假未命中。
  let threwAttr = false;
  try {
    readSummary(" Test Files  1 failed (1)\n      Tests  111 passed (111)\n");
  } catch {
    threwAttr = true;
  }
  if (!threwAttr) problems.push("自证⑤：文件红而无 FAIL 行时没抛 ⇒ 归因会失真");
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
    for (const f of m.mustRed) {
      if (!got.files.has(f)) problems.push("该红的文件没红：" + f);
    }
    for (const f of m.mustGreen) {
      if (got.files.has(f)) problems.push("不该红的文件红了：" + f);
    }
    if (!m.expectRed && got.files.size > 0) {
      problems.push("控制组有文件红了：" + [...got.files].join(", "));
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
      " / 红文件=" +
      (got.files.size === 0 ? "—" : [...got.files].join(","));
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
    " 通过（色码+FAIL 归因 / 文件级失败算红 / 全绿读成绿 / 读不到摘要就抛 / 红而无 FAIL 名就抛）",
);

for (const m of MUTATIONS) execute(m);

console.log("\n══════ round295 变异矩阵（前端出口那一族，逐字节自回滚）══════");
let ok = 0;
for (const [hit, label, want, state, err, note] of results) {
  ok += hit ? 1 : 0;
  console.log((hit ? "✓" : "✗") + " " + label + "  [" + want + "] " + state);
  if (err !== "") console.log("    未命中原因：" + err);
  console.log("    " + note);
}
console.log("命中 " + ok + " / " + results.length);
process.exitCode = ok === results.length ? 0 : 1;
