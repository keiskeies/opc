/**
 * 2026-11-18 · Step A 交付物（claude 适配器 + gateway-runner）的变异机（打在真字节上，自回滚）。
 *
 * 跑法：node .workbuddy/round311-mutate-o6-stepA.mjs
 * 【单独跑】，不与任何测试并发（它会临时改盘上字节）。跑之前确认没人在跑 vitest。
 *
 * ── 七发的预测（先写在这里，跑完对账）───────────────────────────────
 *  · M0 控制组【该绿】：在 ClaudeCliAdapterOptions 接口体开头加一条空注释。
 *    它红了就说明这台在判【字节变没变】而不是【读数变没变】，后面六发全部不可信。
 *  · M1 【永远不发 session_started】⇒ 预测红在：AD 全链、AD callHarness 全链、
 *    RN 全绿、RN settle 四发（成功路装配不出会话 ⇒ gateway no_session）。
 *    AD 的 nosession 发【该绿】—— 它判的就是不发。
 *    这一发的方向：session_started 是【载荷】，成功装配依赖它，摘了必须有人红。
 *  · M2 【null 也发 session_started】⇒ 预测只红在 AD nosession 那一发
 *    （事件序列多了 session_started ⇒ kinds 判红）。与 M1 方向相反：M1 判「不发会红」，
 *    M2 判「编着发会红」，两把刀合起来才钉住「null 不发」这条。
 *  · M3 美分换算忘了 ×100（Math.round(r.costUsd * 100) → Math.round(r.costUsd)）
 *    ⇒ 预测红在 4 发读金额的：AD 全链（usage.spentCents=4 读成 0）、RN 全绿、
 *    RN 业务错、RN settle。被拒那五发【该绿】—— 它们在读金额之前就返回了，
 *    金额刀碰不到拒路（这同时是「拒路不经换算」的覆盖面证据）。
 *  · M4 安全拒的 spawnErrno 从空串换成编的 "ENOENT"（run?.spawnErrno ?? "" → ?? "ENOENT"）
 *    ⇒ 预测红在 RN forbidden（spawnErrno==="" 与 retryable===false 双断言）；
 *    budget/tier 两发【红不红取决于断言里有没有钉 errno】——当前它们只钉 retryable，
 *    而 retryable(ENOENT) 同样 false ⇒ 这两发【该绿】，矩阵里如实读。
 *    AD 四发与 RN 其余发【该绿】（刀在 gateway 拒的映射段，适配器不经过）。
 *  · M5 capabilities 谎报 toolApproval=true ⇒ 预测红在：AD 能力逐格、AD 策略要审批拒
 *    （声明有了审批能力 ⇒ capability_gap 不再拒 ⇒ 桩被执行 ⇒ 三处断言全违）、
 *    AD callHarness 全链与 RN 全绿/settle（approval_policy=never 时谎报无害？不——
 *    gateway 落审计的 prevention 格与 capabilityGap 无关，这两发【该绿】，见下）。
 *    ⚠ 预测修正（写死在此，跑前不改口）：never 策略下谎报 toolApproval 不改变任何调用
 *    行为 ⇒ AD callHarness 全链 / RN 全绿 / RN settle 【该绿】。真正必须红的是前两条。
 *  · M6 runner 不再调 buildGatewayDeps（函数还在、没人调；退回硬编码 read-only 授权）
 *    ⇒ 预测红在：装配期抛那一发 + RN「grantedSandbox 缺省 read-only ⇒ 请求
 *    workspace-write 被拒」（硬编码后仍拒，红不红？——硬编码 read-only 恰好同档，
 *    该发【该绿】⚠ 如实预测：红只应在「装配期抛」。tier 那发要红必须靠岗位书覆盖路径，
 *    而 M6 的硬编码绕开岗位书 ⇒ 它判不到「岗位书 read-only」的真来源 ⇒ 矩阵若显示
 *    它绿，登记为覆盖面缺口而不是命中。）
 *
 * ⚠ 四条纪律（同 round300，逐条带着）：
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
const ADAPTER = "packages/hub/src/harness/adapters/claude.ts";
const RUNNER = "packages/hub/src/harness/gateway-runner.ts";
const SPEC_AD = "packages/hub/test/harness/adapters/claude-adapter.test.ts";
const SPEC_RN = "packages/hub/test/harness/gateway-runner.test.ts";
const SPECS = [SPEC_AD, SPEC_RN];

/** 用例名逐字抄自两份 SPEC，改一个字这台就会报「点不到名」。 */
const A_CHAIN = "全链成功一轮：session_started → usage → finished，finished 唯一且最后";
const A_MARK = "桩【真的被执行】了（SPY_MARK 落盘）";
const A_RESUME = "resume 带 session：--resume 真的出现在 argv，且值正确";
const A_SEED = "resume 没有 seedResumeRequest ⇒ 抛，而不是编一个默认工作区";
const A_NOSESS =
  "sessionId 缺失（CLI 没给）⇒【不发】session_started，finished 的 exitCode 是 null 不是 0";
const A_ERR = "CLI 业务错（is_error + 非零码）⇒ finished 仍发、exitCode null、账单不抹零";
const A_COST = "getCost 如实【抛】：CLI 路线没有跨调用会话账，返回全零会是假话";
const A_GATEWAY = "callHarness 全链：装配成 ExecutionResult，会话/账单/版本都在";
const A_CAPS = "能力逐格如实声明（谎报任一格 ⇒ 本发与下面那发一起红）";
const A_GAP = "策略要审批而声明 toolApproval=false ⇒ capability_gap 拒，桩一次都没执行";
const A_GNOSESS = "CLI 没给 session ⇒ gateway no_session 拒，而不是编一条可恢复的审计行";
const R_OK = "全绿：ok:true + text + sessionId + 美分→美元一处换算";
const R_FORBID =
  "forbidden_flags 命中 ⇒ ok:false、started:false、spawnErrno 空串【且桩没被执行】";
const R_BUDGET = "预算 checkBudget 报 over ⇒ 同样不可重试、桩不执行、账不落 settle";
const R_TIER = "grantedSandbox 缺省 read-only：岗位书没写那一格 ⇒ 请求 workspace-write 被拒";
const R_ENOENT = "started:false + ENOENT 透出 ⇒ 三态里「进程没起」可分，且 ENOENT 确定性 ⇒ 不放行";
const R_GNOSESS = "起了进程但 gateway 仍拒（CLI 没给会话）⇒ started:true 可分，不可重试";
const R_BIZ = "CLI 业务错 ⇒ ok:false、started:true、账透出而不是抹零";
const R_SETTLE = "settle 注入槽：全绿且花了钱 ⇒ runner 原样转交（落哪个事务是 Step B 的事）";
const R_THROW = "岗位书完全没接（undefined）⇒ 装配期抛，而不是运行期静默放行";
const R_DEF = "岗位书接了但没写 claude-code 那一格 ⇒ 缺省 read-only + 空基线";
const R_ALIAS = "岗位书写了 claude_code 那一格（下划线别名）⇒ 逐字读进来";
const NAMED = [
  A_CHAIN, A_MARK, A_RESUME, A_SEED, A_NOSESS, A_ERR, A_COST, A_GATEWAY, A_CAPS, A_GAP, A_GNOSESS,
  R_OK, R_FORBID, R_BUDGET, R_TIER, R_ENOENT, R_GNOSESS, R_BIZ, R_SETTLE, R_THROW, R_DEF, R_ALIAS,
];

const ESC = String.fromCharCode(27);
const results = [];
const MUTATIONS = [];

function mutate(rel, from, to, label, expectRed, mustRedTests, mustGreenTests, note) {
  MUTATIONS.push({ rel, from, to, label, expectRed, mustRedTests, mustGreenTests, note });
}

/* ── M0：控制组（该绿）────────────────────────────────────────────── */
mutate(
  ADAPTER,
  "export interface ClaudeCliAdapterOptions {",
  "export interface ClaudeCliAdapterOptions { //",
  "M0 控制组：接口体开头加一条空注释",
  false,
  [],
  [],
  "字节变了而所有判据的语义一个字没动 ⇒ 整份必须绿。它红了就说明这台在判字节而不是判读数",
);

/* ── M1：永远不发 session_started（载荷摘除）───────────────────────── */
mutate(
  ADAPTER,
  '    if (r.sessionId !== null) {\n      yield { kind: "session_started", sessionId: r.sessionId };\n    }',
  "    // 变异 M1：永远不发 session_started",
  "M1 摘掉 session_started 整发（成功装配的载荷被抽走）",
  true,
  [A_CHAIN, A_GATEWAY, R_OK, R_SETTLE],
  [A_NOSESS, R_ENOENT, R_FORBID],
  "预测 4 红：成功路装配不出会话 ⇒ gateway no_session。AD nosession 发【该绿】（判的就是不发）。",
);

/* ── M2：null 也发 session_started ────────────────────────────────── */
mutate(
  ADAPTER,
  "    if (r.sessionId !== null) {",
  "    if (true) {",
  "M2 sessionId 为 null 也发 session_started（编一个会话）",
  true,
  [A_NOSESS],
  [A_CHAIN, A_GATEWAY, R_OK, R_ENOENT],
  "与 M1 反向的一对刀：一把判「不发会红」，一把判「编着发会红」。",
);

/* ── M3：美分换算忘了 ×100 ────────────────────────────────────────── */
mutate(
  ADAPTER,
  "spentCents: Math.round(r.costUsd * 100)",
  "spentCents: Math.round(r.costUsd)",
  "M3 costUsd→美分换算翻（×100 忘了）",
  true,
  [A_CHAIN, A_GATEWAY, R_OK, R_BIZ, R_SETTLE],
  [R_FORBID, R_BUDGET, R_TIER, R_ENOENT],
  "预测 5 红（0.042 美元记成 0 美分）。拒路五发【该绿】：它们在读金额之前返回 ⇒ 同时是覆盖面证据。",
);

/* ── M4：安全拒映射成 spawnErrno:"ENOENT"（可重试化）───────────────── */
mutate(
  RUNNER,
  '      run?.spawnErrno ?? "",',
  '      run?.spawnErrno ?? "ENOENT",',
  "M4 gateway 前置拒的 spawnErrno 从空串换成编的 ENOENT",
  true,
  [R_FORBID],
  [A_CHAIN, A_NOSESS, A_GAP, R_OK, R_ENOENT, R_GNOSESS, R_BIZ],
  "预测只红 forbidden（唯一钉 spawnErrno===\"\" 的发）。budget/tier 未钉 errno 串而 ENOENT 也不可重试 ⇒ 该绿 ⇒ 若红要查因。适配器各发不经过这一刀。",
);

/* ── M5：capabilities 谎报 toolApproval=true ──────────────────────── */
mutate(
  ADAPTER,
  "    toolApproval: false,",
  "    toolApproval: true,",
  "M5 谎报 toolApproval=true（headless -p 根本没有审批回调）",
  true,
  [A_CAPS, A_GAP],
  [R_OK, R_SETTLE, R_ENOENT],
  "预测 2 红：能力逐格声明那发直接读这份声明；A_GAP 里 never→on-request 的请求不再被 capability_gap 拒。never 策略的发不受谎报影响 ⇒ 该绿（预测写死在文件头）。",
);

/* ── M6：runner 不再调 buildGatewayDeps（函数在、没人调）──────────── */
mutate(
  RUNNER,
  "  const gwDeps = buildGatewayDeps(deps);",
  '  const gwDeps: GatewayDeps = { audit: deps.audit, grantedSandbox: "read-only", grantedForbidden: [] };',
  "M6 runViaGateway 绕过 buildGatewayDeps（硬编码缺省授权，注入槽与装配抛一起丢）",
  true,
  [R_BUDGET, R_SETTLE],
  [A_CHAIN, A_GAP, R_OK, R_FORBID, R_ENOENT, R_TIER, R_GNOSESS, R_BIZ, R_THROW, R_DEF, R_ALIAS],
  "修正后的预测（跑前改口，改口本身入账）：R_THROW【不红】—— 它直接测 buildGatewayDeps 本体，" +
    "绕过调用点伤不到它。真红的是 R_BUDGET/R_SETTLE：硬编码把 checkBudget/settle 注入槽一起丢了。" +
    "⇒ 覆盖面结论如实登记：调用点被绕的【授权侧】（岗位书来源/装配抛）今天没有经 runViaGateway 的判据，" +
    "只有【注入侧】有。若矩阵与此不符，以矩阵为准并回来改这条。",
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
 * 四条失效各自防的（同 round300，那四条各是历史上真中过的一次）：
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
    " " + ESC + "[41m" + ESC + "[1m FAIL " + ESC + "[22m" + ESC + "[49m " + SPEC_RN +
    " > runViaGateway —— 出口表 > " + R_FORBID + "\n" +
    "AssertionError: expected 1 to be 0\n" +
    " " + ESC + "[22m Test Files " + ESC + "[22m " + ESC + "[1m" + ESC + "[31m1 failed" +
    ESC + "[39m" + ESC + "[22m" + ESC + "[90m (2)" + ESC + "[39m\n" +
    " " + ESC + "[22m      Tests " + ESC + "[22m " + ESC + "[1m" + ESC + "[31m1 failed" +
    ESC + "[39m" + ESC + "[22m | 21 passed (22)\n";
  try {
    const s = readSummary(colored);
    if (s.failedTests !== 1) problems.push("自证①：用例红 = " + s.failedTests + "（要 1）");
    if (s.failedFiles !== 1) problems.push("自证①：文件红 = " + s.failedFiles + "（要 1）");
    if (!s.files.has(SPEC_RN)) problems.push("自证①：色码里没归因到那份文件");
    if (!s.tests.has(R_FORBID)) problems.push("自证①：用例名没读出来 ⇒ 点名判据会全成假未命中");
    if (s.failed <= 0) problems.push("自证①：有红而读成了绿");
  } catch (e) {
    problems.push("自证① 抛：" + String(e instanceof Error ? e.message : e).slice(0, 160));
  }
  checks += 1;
  // ② 装载期失败：FAIL 行【没有】用例名，必须只归因到文件而不硬造名字。
  const loadFail =
    " FAIL  " + SPEC_AD + " [ " + SPEC_AD + " ]\n" +
    "Error: Transform failed with 1 error:\n" +
    " Test Files  1 failed | 1 passed (2)\n" +
    "      Tests  11 passed (11)\n";
  try {
    const s = readSummary(loadFail);
    if (s.failed <= 0) problems.push("自证②：文件级失败被读成了绿");
    if (!s.files.has(SPEC_AD)) problems.push("自证②：没归因到那份文件");
    if (s.tests.size !== 0) problems.push("自证②：装载失败被【造】出了用例名");
  } catch (e) {
    problems.push("自证② 抛：" + String(e instanceof Error ? e.message : e).slice(0, 160));
  }
  checks += 1;
  // ③ 全绿那一屏读成【绿】：M0 只有在这判过之后才算数。
  try {
    const s = readSummary(" Test Files  2 passed (2)\n      Tests  22 passed (22)\n");
    if (s.failed !== 0) problems.push("自证③：failed = " + s.failed + "（全绿不许读成红）");
    if (s.passed !== 22) problems.push("自证③：passed = " + s.passed + "（要 22）");
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
    " FAIL  " + SPEC_RN + " > runViaGateway —— 出口表 > " + R_BUDGET + "\n" +
      " Test Files  1 failed (1)\n" +
      "      Tests  1 failed | 21 passed (22)\n",
  );
  if (s6.tests.has(R_FORBID)) problems.push("自证⑥：红在别的用例上却被点成了 R_FORBID ⇒ 点名恒真");
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

console.log("\n══════ 2026-11-18 Step A 变异矩阵（claude 适配器 + gateway-runner，逐字节自回滚）══════");
let ok = 0;
for (const [hit, label, want, state, err, note] of results) {
  ok += hit ? 1 : 0;
  console.log((hit ? "✓" : "✗") + " " + label + "  [" + want + "] " + state);
  if (err !== "") console.log("    未命中原因：" + err);
  console.log("    " + note);
}
console.log("命中 " + ok + " / " + results.length);
process.exitCode = ok === results.length ? 0 : 1;
