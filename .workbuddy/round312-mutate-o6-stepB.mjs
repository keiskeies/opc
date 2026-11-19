/**
 * 2026-11-19 · Step B 交付物的变异机（打在真字节上，自回滚）。
 *
 * Step B = runtime.ts 的 runTurn 从「直调 runRole」换成「经 harness/gateway」
 * （dispatch 账三句 + harness_call 双方齐备）。本台对上 http://round311 那台
 * （Step A 的适配器 + runner），Step A 那台管的是适配器层，这一台管的是
 * 「真装配 + 真 SQL + 真桩 CLI」那一段。
 *
 * 跑法：node .workbuddy/round312-mutate-o6-stepB.mjs 【单独跑】，不与任何测试并发
 * （它会临时改盘上字节）。跑前确认没人在跑 vitest / 别的变异机。
 *
 * ── 五发的预测（先写在这里，跑完对账）───────────────────────────────
 *  · M0 控制组【该绿】：runtime.ts 的 runTurn 注释加一个空格。它红了就说明这台在判
 *    字节变没变而不是判读数变没变，后面四发全部不可信。
 *  · M1 gateway 第三层从 isAbsoluteWorkspacePath 退回旧写法 startsWith("/")
 *    （safety.ts 426 行整行换掉）⇒ 预测红在：safety 的「POSIX 与 Windows」、
 *    gateway 的「绝对性按两种分隔符」、「UNC 裸相对空串」（其 D:\ 根正例）、
 *    runtime 的 O6 Step B 三发（d.cwd 在 Windows 上是 D:\...，退回旧写法 ⇒ workspace 不是绝对 ⇒ 全部 safety_blocked）。
 *    反向对照（D:x 真拒）那一发【该绿】—— 旧写法同样拒它。
 *    这一发的方向：旧写法是一个【真的回归】（round312 修的就是它），
 *    换回去必须有人红，而不是「startsWith("/") 看起来也还行」。
 *  · M2 gateway 从 isAbsoluteWorkspacePath 换成恒 true（绝对性检查被绕过）
 *    ⇒ 预测红在：safety 的「UNC 裸相对空串」与「`D:x`」两发（它们内部调的是
 *    同一个函数，恒 true 之后它们全部放行 ⇒ 断言红）、gateway 的「相对路径工作区 ⇒ 拒」
 *    与「绝对性按两种分隔符」（"repo" 与 "D:ws" 必须拒的那一半红了）。
 *    与 M1 反向的一对刀：M1 判「绝对路径被误拒会红」，M2 判「相对路径被放行会红」。

 *  · M3 runtime 恒交 grantedSandbox:"workspace-write"（不再读岗位书，编一个常量）
 *    ⇒ 预测红在：runtime 的「岗位书写了 workspace-write」（授权侧 granted_forbidden
 *    变 [] 而岗位书声明 ["--yolo"] ⇒ 红）。恒常量恰好与岗位书同值的那一半
 *    由 T_NO_CHARTER / T_ROLE_BOUND 的 else-锚点 miss 掉 —— 它们是「没有岗位书」的
 *    world，走的是 if 臂的显式 read-only，撞不到这个 else ⇒ 如实登记覆盖面。
 *  · M4 runtime 不再 flush，缓冲永不落库 ⇒ 预测红在：runtime 的 O6 Step B 三发
 *    全红（它们全部断言「gateway 那一行必须落到库里」）。这一发的方向：
 *    flush 那半在 round312 是审计落库的真通道，拔掉它必须有人红。
 *
 * ⚠ 三条纪律（同 round311 那台，逐条带着）：
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
const SAFETY = "packages/hub/src/harness/safety.ts";
const GATEWAY = "packages/hub/src/harness/gateway.ts";
const RUNTIME = "packages/hub/src/engine/runtime.ts";
const SPEC_SAFE = "packages/hub/test/harness/safety.test.ts";
const SPEC_GW = "packages/hub/test/harness/gateway.test.ts";
const SPEC_RT = "packages/hub/test/engine/runtime.test.ts";
const SPECS = [SPEC_SAFE, SPEC_GW, SPEC_RT];

/** 用例名逐字抄自三份 SPEC，改一个字这台就会报「点不到名」。 */
const T_ABS_SAFE = "POSIX 与 Windows（反斜杠 / 正斜杠混写）都算绝对";
const T_DRIVE_SAFE = "`D:x`【不是】绝对路径 —— 它是「D 盘当前目录下的 x」";
const T_UNC_SAFE = "UNC、裸相对、空串都不算（宁可拒，不可放行一个歧义路径）";
const T_REL_GW = "相对路径工作区 ⇒ 拒（同一条岗位书在两个 cwd 下意味着两个可写范围）";
const T_ABS_GW = "⭐ 绝对性按两种分隔符读：`D:\\ws` 与 `C:/ws` 放行，`D:ws` 仍拒";
const T_CHARTER = "⭐ 岗位书写了 workspace-write ⇒ 授权侧与请求侧【同一轮】都带着它落到库里";
const T_NO_CHARTER = "⭐ 反向对照：没有岗位书 ⇒ 落的是 read-only + 空基线，而不是上面那个值";
const T_ROLE_BOUND = "同一张库里岗位书按角色走：dev 的档位不会拼到 director 的授权侧";
const NAMED = [
  T_ABS_SAFE, T_DRIVE_SAFE, T_UNC_SAFE, T_REL_GW, T_ABS_GW,
  T_CHARTER, T_NO_CHARTER, T_ROLE_BOUND,
];

const ESC = String.fromCharCode(27);
const results = [];
const MUTATIONS = [];

function mutate(rel, from, to, label, expectRed, mustRedTests, mustGreenTests, note) {
  MUTATIONS.push({ rel, from, to, label, expectRed, mustRedTests, mustGreenTests, note });
}

/* ── M0：控制组（该绿）────────────────────────────────────────────── */
mutate(
  RUNTIME,
  "  // ── O6 Step B（round312）：角色轮改走 harness/gateway ─────────────────",
  "  // ── O6 Step B（round312）：角色轮改走 harness/gateway ───────────────── ",
  "M0 控制组：runTurn 注释加一个尾随空格",
  false,
  [],
  [],
  "字节变了而所有判据的语义一个字没动 ⇒ 整份必须绿。它红了就说明这台在判字节而不是判读数",
);

/* ── M1：gateway 第三层退回 startsWith("/") ───────────────────────── */
mutate(
  SAFETY,
  'export function isAbsoluteWorkspacePath(p: string): boolean {\n  return p.startsWith("/") || /^[A-Za-z]:[\\\\/]/u.test(p);\n}',
  'export function isAbsoluteWorkspacePath(p: string): boolean {\n  return p.startsWith("/");\n}',
  "M1 绝对性退回旧写法 startsWith(\"/\")（round312 修的回归又被换回去）",
  true,
  [T_ABS_SAFE, T_ABS_GW, T_CHARTER, T_NO_CHARTER, T_ROLE_BOUND, T_UNC_SAFE],
  [T_DRIVE_SAFE],
  // ⚡ 初版把 T_UNC_SAFE 当 mustGreen，跑出"不该红" —— 那是【预测错】，不是判据失灵：
  // 该发末格断言 `D:\` 是绝对根（"盘符+分隔符 = 根"），旧写法 startsWith("/") 把根也拒了
  // ⇒ 它必然红，且红在【正确】的一格（旧写法连 Windows 根都不认）。T_DRIVE_SAFE 全是负例 ⇒ 仍该绿。
  "预测红 6：safety 的 POSIX/Windows 两发 + UNC 那发的 D:\\ 根正例、gateway 的绝对性两发、runtime 的 Step B 三发。",
);

/* ── M2：gateway 绝对性检查被绕过（恒 true）───────────────────────── */
mutate(
  SAFETY,
  'export function isAbsoluteWorkspacePath(p: string): boolean {\n  return p.startsWith("/") || /^[A-Za-z]:[\\\\/]/u.test(p);\n}',
  "export function isAbsoluteWorkspacePath(p: string): boolean {\n  return true;\n}",
  "M2 绝对性恒 true（相对路径 / D: 盘符相对全被放行）",
  true,
  [T_UNC_SAFE, T_DRIVE_SAFE, T_REL_GW, T_ABS_GW],
  [T_ABS_SAFE, T_CHARTER, T_NO_CHARTER, T_ROLE_BOUND],
  "与 M1 反向的一对刀。safety 的 UNC/D: 两发（判定真实）、gateway 的相对拒绝与 D:ws 拒绝两发。绝对路径仍放行 ⇒ 其余该绿。",
);

/* ── M3：runtime 恒交 workspace-write（不读岗位书）────────────────── */
mutate(
  RUNTIME,
  "          : { audit, charterHarnessDefaults: charter.harnessDefaults ?? {} };",
  '          : { audit, grantedSandbox: "workspace-write", grantedForbidden: [] };',
  "M3 runtime 恒交 workspace-write（岗位书被绕过，授权散成常量）",
  true,
  [T_CHARTER],
  [T_NO_CHARTER, T_ROLE_BOUND, T_ABS_SAFE, T_ABS_GW, T_REL_GW],
  // ⚡ 初版预测 T_NO_CHARTER/T_ROLE_BOUND 该红 —— 错在哪：变异锚点在
  // `charter !== undefined` 那条的 else 臂，而这两发走【都没有岗位书】的 world ⇒
  // 恒走 if 臂的显式 read-only，撞不到被改的 else。真正被抓住的是 T_CHARTER：
  // 授权侧 grantedForbidden 变 [] 而岗位书声明 ["--yolo"] ⇒ 其 granted_forbidden
  // 断言红。∴ 捕捉面【比预期更准】：M3 连「岗位书的 forbidden 也转发」都验了。
  "预测红 1（修订后）：「岗位书写了 workspace-write」——恒常量让 granted_forbidden 与岗位书不符 ⇒ 红。",
);

/* ── M4：runtime 不再 flush，缓冲永不落库 ─────────────────────────── */
mutate(
  RUNTIME,
  '      if (pending.length > 0) {\n        try {',
  '      if (false && pending.length > 0) {\n        try {',
  "M4 gateway 审计缓冲永不 flush（留痕断了，账照走）",
  true,
  [T_CHARTER, T_NO_CHARTER, T_ROLE_BOUND],
  [T_ABS_SAFE, T_ABS_GW],
  "预测红 3：Step B 三发全部断言「那一行必须落到库里」。账不经过 flush ⇒ budget 各发该绿。",
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
const specText = SPECS.map((s) => readFileSync(join(ROOT, s), "utf8")).join("\n");
/** 文件文本形态：源文件里的字符串字面量【转义后】才是运行态名字。`D:\\ws` 在文件里是两个反斜杠。 */
const fileForm = (name) => name.replace(/\\/g, "\\\\");
for (const t of NAMED) {
  if (specText.indexOf(t) < 0 && specText.indexOf(fileForm(t)) < 0) {
    bad.push("用例名锚点不在 SPEC 里（这台会【永远点不到名】）：" + t);
  }
}
if (bad.length > 0) {
  console.error("锚点校验失败，【一发都没跑】：\n  " + bad.join("\n  "));
  process.exit(1);
}

/**
 * 从 vitest 的输出里读「红了几发 / 红了哪几份文件 / 红了【哪几发用例名】」。
 * 四条失效各自防的（同 round311，那四条各是历史上真中过的一次）：
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
    [join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", ...SPECS],
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
    " " + ESC + "[41m" + ESC + "[1m FAIL " + ESC + "[22m" + ESC + "[49m " + SPEC_RT +
    " > runTurn → gateway 的授权侧 > " + T_CHARTER + "\n" +
    "AssertionError: expected 1 to be 0\n" +
    " " + ESC + "[22m Test Files " + ESC + "[22m " + ESC + "[1m" + ESC + "[31m1 failed" +
    ESC + "[39m" + ESC + "[22m" + ESC + "[90m (3)" + ESC + "[39m\n" +
    " " + ESC + "[22m      Tests " + ESC + "[22m " + ESC + "[1m" + ESC + "[31m1 failed" +
    ESC + "[39m" + ESC + "[22m | 21 passed (22)\n";
  try {
    const s = readSummary(colored);
    if (s.failedTests !== 1) problems.push("自证①：用例红 = " + s.failedTests + "（要 1）");
    if (s.failedFiles !== 1) problems.push("自证①：文件红 = " + s.failedFiles + "（要 1）");
    if (!s.files.has(SPEC_RT)) problems.push("自证①：色码里没归因到那份文件");
    if (!s.tests.has(T_CHARTER)) problems.push("自证①：用例名没读出来 ⇒ 点名判据会全成假未命中");
    if (s.failed <= 0) problems.push("自证①：有红而读成了绿");
  } catch (e) {
    problems.push("自证① 抛：" + String(e instanceof Error ? e.message : e).slice(0, 160));
  }
  checks += 1;
  // ② 装载期失败：FAIL 行【没有】用例名，必须只归因到文件而不硬造名字。
  const loadFail =
    " FAIL  " + SPEC_SAFE + " [ " + SPEC_SAFE + " ]\n" +
    "Error: Transform failed with 1 error:\n" +
    " Test Files  1 failed | 1 passed (2)\n" +
    "      Tests  11 passed (11)\n";
  try {
    const s = readSummary(loadFail);
    if (s.failed <= 0) problems.push("自证②：文件级失败被读成了绿");
    if (!s.files.has(SPEC_SAFE)) problems.push("自证②：没归因到那份文件");
    if (s.tests.size !== 0) problems.push("自证②：装载失败被【造】出了用例名");
  } catch (e) {
    problems.push("自证② 抛：" + String(e instanceof Error ? e.message : e).slice(0, 160));
  }
  checks += 1;
  // ③ 全绿那一屏读成【绿】：M0 只有在这判过之后才算数。
  try {
    const s = readSummary(" Test Files  3 passed (3)\n      Tests  46 passed (46)\n");
    if (s.failed !== 0) problems.push("自证③：failed = " + s.failed + "（全绿不许读成红）");
    if (s.passed !== 46) problems.push("自证③：passed = " + s.passed + "（要 46）");
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
    readSummary(" Test Files  1 failed (1)\n      Tests  21 passed (22)\n");
  } catch {
    threwAttr = true;
  }
  if (!threwAttr) problems.push("自证⑤：文件红而无 FAIL 行时没抛 ⇒ 归因会失真");
  checks += 1;
  // ⑥ 红在【别的用例】上不算点名命中 —— mustGreen 全靠这一判才不是恒真。
  const s6 = readSummary(
    " FAIL  " + SPEC_GW + " > harness_call 那一行 > " + T_CHARTER + "\n" +
      " Test Files  1 failed (1)\n" +
      "      Tests  1 failed | 21 passed (22)\n",
  );
  if (s6.tests.has(T_REL_GW)) problems.push("自证⑥：红在别的用例上却被点成了另一发 ⇒ 点名恒真");
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

console.log("\n══════ 2026-11-19 Step B 变异矩阵（O6 接线：safety 第三层 + gateway + runtime，逐字节自回滚）══════");
let ok = 0;
for (const [hit, label, want, state, err, note] of results) {
  ok += hit ? 1 : 0;
  console.log((hit ? "✓" : "✗") + " " + label + "  [" + want + "] " + state);
  if (err !== "") console.log("    未命中原因：" + err);
  console.log("    " + note);
}
console.log("命中 " + ok + " / " + results.length);
process.exitCode = ok === results.length ? 0 : 1;
