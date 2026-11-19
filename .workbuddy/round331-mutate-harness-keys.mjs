/**
 * 2026-11-19 · harness_defaults 键判据的变异机（打在真字节上，自回滚）。
 *
 * 被测交付物（round331）：contracts 的 unrecognizedHarnessKeys / shadowedHarnessKeys /
 * harnessDefaultsKeyProblem 三个纯函数，加上【两个执行点】——
 *   写入期 charterSchema.superRefine ⇒ 422；
 *   读取期 harnessDefaultsFor      ⇒ 装配期抛。
 *
 * ── 为什么必须有两个执行点，也就为什么这台有 M6 ──────────────────────
 * 只有写入期那一遍是不够的：它挡的是【从那一刻之后】的写入，而读取侧读的是
 * 【库里已经存着的那一份】。charter/store.ts 的 readCharterConfig 明写着「不重解析」
 * 并把代价写在它自己文件头（「schema 后来收紧了 ⇒ 历史版本读回来是 Charter 类型而
 * 实际缺字段」），而本仓【没有迁移器】。⇒ 今天加的写入期判据对昨天存下的岗位书
 * 一个字都改不动，而这一格失效方向是【开】（forbidden_flags 落回 []，禁令消失而全绿）。
 * ⇒ M6 单独把【读取期那一遍】关掉：只有读侧那几发必须红。它若也全绿，
 *   就说明读侧那四发是【靠写入期判据顺带绿】的 —— 那等于没有读侧兜底。
 *
 * 跑法：node .workbuddy/round331-mutate-harness-keys.mjs 【单独跑】，不与任何测试并发
 * （它会临时改盘上字节）。跑前确认没人在跑 vitest / 别的变异机。
 *
 * ── 七发的预测（先写在这里，跑完对账）───────────────────────────────
 *  · M0 控制组【该绿】：函数头注释加一个尾随空格。字节变了而语义一字没动。
 *    它红了就说明这台在判字节变没变而不是判读数变没变，后面六发全部不可信。
 *  · M1 键臂探测器恒 false（所有键都算合法）⇒ 红在：写侧三发 + 读侧三发。
 *    ⚠ 两种写法那三发【该照旧绿】—— 这是预测最容易搞反的一格：它们的夹具两个键名
 *    都【合法】，M1 动的是键臂。这一格对上，就证明两臂【互不掩盖】。
 *  · M2 原型洞复发（hasOwn → 下标 === undefined）⇒ 预测【只有】原型链那一发红。
 *    这台最值钱的一发之一：它证明那发的三个继承名真在判【实现细节】而不是顺带绿。
 *  · M3 重复臂探测器恒返 [] ⇒ 红在：写侧两发 + 读侧那一发。与 M1 是反向的一对刀。
 *  · M4 胜者改由 raw 的键序决定 ⇒ 预测【只有】「与书写先后无关」那一发红
 *    （第二顺序下 loser 翻成 claude-code ⇒ 断言红；第一顺序恰好同 loser，
 *    所以那发【只会被一半抓住】—— 这正是它必须两种顺序都跑的理由）。
 *  · M5 组合函数恒返 null = 【两个执行点一起失效】⇒ 红在全部九发。
 *    这一发是整台的「判据整条不存在」上界：它若只红几发，说明有几发其实不靠这条判据。
 *  · M6 【只】摘掉读取期那一遍 ⇒ 红在读侧四发，写侧五发【必须照旧绿】。
 *    见上面那段：这是本轮唯一能证明「读侧兜底不是写侧的影子」的一发。
 *
 * ⚠ 四条纪律（同 round312 那台，逐条带着）：
 *  ① 还原写【进场时读到的字节】，不用 replace 反推；
 *  ② 还原在 finally 里，且在【校验之前】；
 *  ③ 所有锚点在第一发跑之前全部验一遍（命中必须恰好 1 次，且 to ≠ from），
 *     【用例名】也必须逐条在 SPEC 里 —— 点不到名的 mustRed 是一条永假判据；
 *  ④ 读 vitest 输出先剥 ANSI，且「读不到摘要行」必须【抛】而不是当 0。
 *     ⚡ 纪律 ④ 在本轮真触发过一次：第一版 M4 的替换写法编译不过（TS2322
 *     string|undefined → string），contracts 由 vitest globalSetup 构建 ⇒ 构建红
 *     ⇒ 没有「Tests」摘要行 ⇒ 这台【抛】而不是当 0，于是报的是「跑挂了」而不是
 *     「没红」。若当时把「读不到摘要」当 0，那一发会被登记成「判据没被抓住」。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const HARNESS = "packages/contracts/src/harness.ts";
const CHARTER = "packages/contracts/src/charter.ts";
const SPEC = "packages/hub/test/roles/charter.test.ts";
const SPEC_RUNNER = "packages/hub/test/harness/gateway-runner.test.ts";
const SPECS = [SPEC, SPEC_RUNNER];

/** 用例名逐字抄自两份 SPEC，改一个字这台就会报「点不到名」。 */
const T_TYPO = "⭐ 键名拼错 ⇒ 拒加载，并报 harness_defaults 这一格";
const T_KEYNAME = "⭐ 报错必须点名那个错键名（只说「配错了」他没法改）";
const T_INHERIT = "⭐ 判据【不代填、不自动改名】：拼错的键不会被就地纠成合法名";
const T_DUP = "⭐ 同一家写两种写法 ⇒ 拒：后写那一格被读取顺序吞掉，且不报错";
const T_ORDER = "⭐ 被点名的是【读取侧真的跳过】那一格，与 YAML 里的书写先后无关";
const T_LEGAL = "⭐ 正向对照：合法键名原样放行，值一字不改（判据不是「一律拒」）";
const T_TWO = "两个合法写法各写一格（claude-code / codex）⇒ 合法：那是两家，不是重复";
const T_NONE = "整个不写这一格 ⇒ 合法（没配 ≠ 配错）";
const T_VALUE = "⭐ 值写坏仍由读取侧抛 —— 这里【不抄第二份值判据】";
const R_TYPO = "⭐ 库里那份的键名拼错 ⇒ 装配期抛，而不是带着空禁令跑起来";
const R_NAME = "⭐ 报错点名那个键名与合法键集（历史数据要能照着改）";
const R_DUP = "⭐ 库里那份同一家写了两种写法 ⇒ 同样抛（生效格由顺序决定 = 不可接受）";
const R_EXPLICIT = "⭐ 显式授权格【不能】绕过键判据（它是被比侧，不是免检侧）";
const R_CODEX = "⭐ 反向对照：合法键 + 只有 codex 那一格 ⇒ 照旧读成 read-only + 空基线";

/** 按【臂】与【执行点】分四组 —— M1/M3/M6 的预测全靠这个分法。 */
const KEY_W = [T_TYPO, T_KEYNAME, T_INHERIT];
const SHADOW_W = [T_DUP, T_ORDER];
const KEY_R = [R_TYPO, R_NAME, R_EXPLICIT];
const SHADOW_R = [R_DUP];
const GREENS = [T_LEGAL, T_TWO, T_NONE, T_VALUE, R_CODEX];
const ALL_RED = [...KEY_W, ...SHADOW_W, ...KEY_R, ...SHADOW_R];
const NAMED = [...ALL_RED, ...GREENS];

const ESC = String.fromCharCode(27);
const MUTATIONS = [];

function mutate(rel, from, to, label, expectRed, mustRedTests, mustGreenTests, note) {
  MUTATIONS.push({ rel, from, to, label, expectRed, mustRedTests, mustGreenTests, note });
}

/* ── M0：控制组（该绿）────────────────────────────────────────────── */
mutate(
  HARNESS,
  " * @returns 没人读的键名（保持原顺序）；`raw === undefined` ⇒ `[]`（没配 ≠ 配错）。",
  " * @returns 没人读的键名（保持原顺序）；`raw === undefined` ⇒ `[]`（没配 ≠ 配错）。 ",
  "M0 控制组：函数头注释加一个尾随空格",
  false,
  [],
  NAMED,
  "字节变了而语义没动 ⇒ 必须全绿。红了就说明这台在判字节而不是判读数",
);

/* ── M1：键臂探测器失效 ───────────────────────────────────────────── */
mutate(
  HARNESS,
  "    (k: string): boolean => !Object.hasOwn(HARNESS_ID_ALIASES, k),",
  "    (): boolean => false,",
  "M1 键臂恒 false（所有键都算合法 = 这一臂不存在）",
  true,
  [...KEY_W, ...KEY_R],
  [...SHADOW_W, ...SHADOW_R, ...GREENS],
  "红六发（写侧三 + 读侧三）。⚠ 两种写法那三发【必须照旧绿】：夹具两个键名都合法，" +
    "M1 动不到重复臂 ⇒ 对上就证明两臂互不掩盖。",
);

/* ── M2：原型洞复发 ───────────────────────────────────────────────── */
mutate(
  HARNESS,
  "    (k: string): boolean => !Object.hasOwn(HARNESS_ID_ALIASES, k),",
  "    (k: string): boolean => HARNESS_ID_ALIASES[k] === undefined,",
  "M2 原型洞复发（hasOwn → 下标 === undefined，继承名被判合法）",
  true,
  [T_INHERIT],
  ALL_RED.filter((t) => t !== T_INHERIT).concat(GREENS),
  "只有原型链那一发红，才证明那发的三个继承名真在判【实现细节】而不是顺带绿。" +
    "其余各发的键名都不在原型链上 ⇒ 行为一字不变 ⇒ 必须照旧。",
);

/* ── M3：重复臂探测器失效 ─────────────────────────────────────────── */
mutate(
  HARNESS,
  "  return out;\n}",
  "  return [];\n}",
  "M3 重复臂恒返 []（两种写法同时出现不再被算出来）",
  true,
  [...SHADOW_W, ...SHADOW_R],
  [...KEY_W, ...KEY_R, ...GREENS],
  "与 M1 反向的一对刀：M1 证键臂有人判，M3 证重复臂有人判。两臂各自只被自己那一组抓住。" +
    "⚠ 锚点 `return out;` 在 harness.ts 里必须唯一（上面纪律 ③ 会验），" +
    "否则这一发会同时改掉别的函数。",
);

/* ── M4：胜者改由 raw 的键序决定 ──────────────────────────────────── */
// 锚点取【两行】：换遍历序必须同时换掉 hasOwn 那一次跳过（raw 序遍历下它天然成立），
// 而 HARNESS_ID_ALIASES[key] 的形状是 `HarnessId | undefined` —— 实测只换头一行、
// 把 id 标成 string 会编译不过（TS2322），见文件头纪律 ④ 那次真触发。
mutate(
  HARNESS,
  "  for (const [key, id] of Object.entries(HARNESS_ID_ALIASES)) {\n    if (!Object.hasOwn(raw, key)) continue;",
  "  for (const key0 of Object.keys(raw)) {\n    const key: string = key0;\n    const id: string | undefined = HARNESS_ID_ALIASES[key];\n    if (id === undefined) continue;",
  "M4 胜者改由 raw 的键序决定（生效格随 CEO 书写顺序漂）",
  true,
  [T_ORDER],
  ALL_RED.filter((t) => t !== T_ORDER).concat(GREENS),
  "只红「与书写先后无关」那一发：raw 序在前时 loser 翻成 claude-code ⇒ 断言红。" +
    "T_DUP 只断路径 + 一个子串 ⇒ 两种顺序红在同一处 ⇒ 照旧绿（它不判顺序，这是分工）。" +
    "⚠ 这一发【不是】无害重构：它把「哪一格生效」从别名表交给 YAML 的书写顺序，" +
    "于是同一份岗位书重排一次键，沙箱档位与禁令基线就换了一份。",
);

/* ── M5：组合函数恒 null（两个执行点一起失效）─────────────────────── */
mutate(
  HARNESS,
  "  if (unknown.length === 0 && shadowed.length === 0) return null;",
  "  if (unknown.length >= 0) return null;",
  "M5 组合函数恒返 null = 写入期与读取期【一起】失明",
  true,
  ALL_RED,
  GREENS,
  "整台的上界：判据整条不存在 ⇒ 九发全红。它若只红几发，说明剩下那几发其实" +
    "不靠这条判据（那就是白写的断言）。用 `unknown.length >= 0` 而不是 `true`" +
    "是为了不触发 TS 的「条件恒真」类报错而让整台在编译期就先红一次。",
);

/* ── M6：只摘掉读取期那一遍 ───────────────────────────────────────── */
mutate(
  HARNESS,
  "  if (keyProblem !== null) {",
  "  if (keyProblem !== null && keyProblem.length < 0) {",
  "M6 只摘掉【读取期】那一遍（写入期照旧）⇒ 历史数据重新变成静默失效",
  true,
  [...KEY_R, ...SHADOW_R],
  [...KEY_W, ...SHADOW_W, ...GREENS],
  "本轮唯一能证明「读侧兜底不是写侧的影子」的一发：写侧五发必须照旧绿" +
    "（charterSchema 那条一个字没动），读侧四发必须红。" +
    "若读侧四发照旧绿，它们就是在靠写入期判据顺带绿 ⇒ 那等于没有读侧兜底，" +
    "而【库里已经存着的那一份】正是这条判据存在的理由。" +
    "条件写成 `keyProblem.length < 0` 而不是 `false &&` ⇒ 不改类型、不触发恒假告警。",
);

/* ── 纪律 ③：锚点先全部验一遍 ─────────────────────────────────────── */
const SPECDATA = new Map([
  [SPEC, readFileSync(join(ROOT, SPEC), "utf8")],
  [SPEC_RUNNER, readFileSync(join(ROOT, SPEC_RUNNER), "utf8")],
]);
const bad = [];
for (const [i, m] of MUTATIONS.entries()) {
  const text = readFileSync(join(ROOT, m.rel), "utf8");
  const hits = text.split(m.from).length - 1;
  if (hits !== 1) {
    bad.push("M" + i + " [" + m.rel + "] 锚点命中 " + hits + " 次（要恰好 1）：" + m.from.slice(0, 70));
  }
  if (m.from === m.to) bad.push("M" + i + " from === to（这一发不会改任何字节）");
  for (const t of [...m.mustRedTests, ...m.mustGreenTests]) {
    let found = false;
    for (const s of SPECDATA.values()) if (s.includes(t)) found = true;
    if (!found) bad.push("M" + i + " 用例名在两份 SPEC 里都找不到：" + t);
  }
  if (m.expectRed && m.mustRedTests.length === 0) {
    bad.push("M" + i + " 说该红却【点不出任何用例名】⇒ 那是一条永假判据");
  }
}
// 用例名不得重名跨文件（重名会让「红了哪一发」的归因失真）
for (const [specPath, specText] of SPECDATA) {
  for (const t of NAMED) {
    const n = specText.split(t).length - 1;
    if (n > 1) bad.push("用例名在 " + specPath + " 里出现 " + n + " 次 ⇒ 归因不唯一：" + t);
  }
}
if (bad.length > 0) {
  console.error("锚点校验失败，【一发都没跑】：\n  " + bad.join("\n  "));
  process.exit(1);
}

/** 从 vitest 输出读「红了几发 / 红了哪几发用例名」。四条失效各自防的（同 round312）。 */
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
    [join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", ...SPECS],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 420_000,
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === "win32",
    },
  );
  const got = readSummary(String(r.stdout) + String(r.stderr));
  return Object.assign({}, got, { red: got.failed > 0 });
}

console.log("── 基线（未变异）");
const base = run();
console.log("  " + base.passed + " passed / " + base.failed + " failed");
if (base.failed > 0) {
  console.error("★ 基线就是红的，这台机器的读数不可采信。");
  process.exit(1);
}

let problems = 0;
for (const [i, mu] of MUTATIONS.entries()) {
  const path = join(ROOT, mu.rel);
  const original = readFileSync(path, "utf8"); // 纪律 ①：还原写进场字节
  let got = null;
  let err = null;
  try {
    writeFileSync(path, original.replace(mu.from, mu.to));
    got = run();
  } catch (e) {
    err = e;
  } finally {
    writeFileSync(path, original); // 纪律 ②：还原在校验之前
  }
  if (err !== null) {
    console.log("\n✗ " + mu.label + "\n   跑挂了：" + String(err).slice(0, 260));
    problems++;
    continue;
  }
  const restored = readFileSync(path, "utf8") === original;
  const redNames = [...got.tests];
  const missRed = mu.mustRedTests.filter((t) => !got.tests.has(t));
  const hitGreen = mu.mustGreenTests.filter((t) => got.tests.has(t));
  const ok = (mu.expectRed ? got.red && missRed.length === 0 : !got.red) && restored;
  console.log("\n" + (ok ? "✓ " : "✗ ") + mu.label);
  console.log(
    "   red=" + got.red + " 用例红=" + got.failedTests + " 文件红=" + got.failedFiles +
      " passed=" + got.passed + "  红名=" + JSON.stringify(redNames.slice(0, 6)),
  );
  if (missRed.length > 0) console.log("   ★ 预测该红而没红：" + missRed.join(" | "));
  if (hitGreen.length > 0) console.log("   ★ 预测该绿而红了：" + hitGreen.join(" | "));
  if (!restored) console.log("   ★★ 还原失败！盘上字节与进场不同 —— 后续读数全部作废");
  if (!ok) problems++;
}

const verify = run();
console.log("\n── 还原后复跑：" + verify.passed + " passed / " + verify.failed + " failed");
if (verify.failed > 0) {
  console.log("★★ 还原后仍红 —— 盘上有残留，本轮所有读数作废");
  problems++;
}

console.log(
  "\n" + (problems === 0 ? "RESULT: 七发全部对上预测" : "RESULT: " + problems + " 发与预测不符"),
);
process.exitCode = problems === 0 ? 0 : 1;
