/**
 * round340 变异机（a11y / 交互四小项）：导航 aria-current 与 Ctrl+Enter 判定，逐格验承重。
 *
 * ── 这台机器要回答的唯一问题 ──────────────────────────────────
 * 本轮在 app.js 里新写了两枚纯函数（round340 §① ③）：
 *   M1 「aria-current 只给当前视图」 —— 抹掉后：非当前页链接也带 aria-current="page"，
 *       读屏会把全部七个入口都报成"当前页"（round340 的核心判据）。
 *   M2 「Ctrl+Enter 判定拿反」 —— 改成只认裸 Enter / 只认 shift 后：要么 Enter 换行被
 *       吞成提交、要么 Ctrl+Enter 失效（round340 的快捷键判据，正反两发同反）。
 *
 * ⚠ 每一发都【真抹生产字节】（packages/web/public/app.js），跑完逐字节还原并核对，
 *   且每发变异前后断言源码字符串【真的变了】（命中 0 次的真空操作会让那一发假绿）。
 *
 * ── 事前预测（写在跑之前，跑完不许改）─────────────────────────
 *   M0 控制组   ⇒ test/web 全绿（本轮实测 183 通过，app-pure 111 + hub-projection 34 +
 *                renderer-criteria 31 + dev-server-sign 7）。
 *   M1 aria 删掉 ⇒ 该红：app-pure「非当前视图那一枚【不】带 aria-current」一发。
 *                  预测【只有这一族红】：同一枚上的 .act 与 data-r 都不碰它（看测试怎么写）。
 *   M2 判定取反 ⇒ 该红：isCtrlEnter 节「只有 Enter 不算」「Shift+Ctrl+Enter 不算」两发；
 *                  若实现只取反主键而没动 shift 分支，红的是两发里取反了的那一半，
 *                  反正这一格【必须红出至少一发】—— 全绿 = 判定没被钉住（变异机照旧报失败）。
 *
 * ⚠ 跑法（仓根）：npx tsx .workbuddy/round340-a11y-mut.mjs
 *   这台机器写真字节 ⇒ 单独跑，不与任何测试并发（round292 (b)）。
 *   读红绿：vitest 退出码 + 失败【测试名】，不 grep 汇总数字（round301 §⑦③）。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");
const SRC = "packages/web/public/app.js";
const TESTS = ["test/web"];

/** 失败测试名的子串（够认出哪一发，不随标题标点漂移）。 */
const N = {
  notCurrent: "非当前视图那一枚【不】带 aria-current",
  currentHas: "当前视图那一枚带 aria-current",
  plainEnter: "只有 Enter【不算】快捷键",
  notEnter: "key 不是 Enter 时不触发提交",
  shift: "Shift+Ctrl+Enter 不算",
};

const MUTATIONS = [
  {
    label: "M1 aria-current 判定抹成恒带 ⇒ 非当前页链接也宣称「我是当前页」",
    from: ['  (view.id === cur ? ` aria-current="page"` : "") +'],
    to: ['  ` aria-current="page"` + // 变异：判定被抹成恒带，所有链接都带当前页语义'],
    expectRed: [N.notCurrent],
    expectGreen: [N.currentHas],
  },
  {
    label: "M2 Ctrl+Enter 判定取反（只认裸 Enter）⇒ 换行被吞成提交 / 快捷键失效",
    from: ['const isCtrlEnter = (e) => !!(e && (e.ctrlKey || e.metaKey) && e.key === "Enter" && !e.shiftKey);'],
    to: ['const isCtrlEnter = (e) => !!(e && e.key === "Enter"); // 变异：判定取反，Ctrl 不再必需'],
    expectRed: [N.plainEnter, N.shift],
    expectGreen: [N.notEnter],
  },
];

const original = readFileSync(join(ROOT, SRC), "utf8");

function eolOf(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}
const anchor = (text, lines) => lines.join(eolOf(text));

function failedTests(out) {
  const plain = out.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "gu"), "");
  const names = new Set();
  for (const line of plain.split("\n")) {
    const m = /(?:×|✗)\s+(.+?)(?:\s+\d+ms)?\s*$/u.exec(line.trim());
    if (m !== null && m[1] !== undefined) names.add(m[1].trim());
  }
  return [...names];
}

function runTests() {
  const r = spawnSync(process.execPath, [VITEST, "run", ...TESTS], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = String(r.stdout) + String(r.stderr);
  return { green: r.status === 0, names: failedTests(out), out };
}

/** 逐字节还原 + 核对：还原后内容与进机器前的原文一比一 ⇒ reverted。 */
function rollback() {
  writeFileSync(join(ROOT, SRC), original, "utf8");
  if (readFileSync(join(ROOT, SRC), "utf8") !== original) {
    throw new Error("回滚后字节对不上，立刻去 git 核对：" + SRC);
  }
}

/** 锚点先全验：任一失配/真空 ⇒ 一发不发（round293：命中 0 次的变异是真空操作）。 */
function preflight() {
  const bad = [];
  for (const mut of MUTATIONS) {
    const from = anchor(original, mut.from);
    const to = anchor(original, mut.to);
    if (from === to) bad.push(mut.label + " 是真空操作（from === to）");
    const n = original.split(from).length - 1;
    if (n !== 1) bad.push("锚点命中 " + n + " 次（要恰好 1）：" + mut.from[0].slice(0, 70));
  }
  if (bad.length > 0) throw new Error("锚点校验失败，一发不发：\n  " + bad.join("\n  "));
}

const results = [];
let fatal = "";
try {
  preflight();

  const control = runTests();
  results.push([
    control.green,
    "M0 一字不改 ⇒ test/web 全绿",
    control.green ? "全绿" : "意外红：" + control.names.join("、").slice(0, 500),
  ]);
  if (!control.green) throw new Error("控制组就红 ⇒ 后面每一发的「该红/该绿」都没有地基");

  for (const mut of MUTATIONS) {
    const before = readFileSync(join(ROOT, SRC), "utf8");
    const next = before.replace(anchor(before, mut.from), anchor(before, mut.to));
    // 变异【真改了字节】的断言：next === before 就是真空操作，当场停。
    if (next === before) throw new Error("断言失败：变异前后源码逐字节相同（" + mut.label + "）");
    writeFileSync(join(ROOT, SRC), next, "utf8");
    if (readFileSync(join(ROOT, SRC), "utf8") !== next) {
      throw new Error("断言失败：写盘后读回的不是变异体（" + mut.label + "）");
    }
    let got;
    let reverted = false;
    try {
      got = runTests();
    } finally {
      rollback();
      reverted = readFileSync(join(ROOT, SRC), "utf8") === original;
    }
    if (!reverted) throw new Error("reverted !== true（" + mut.label + "）");
    const hit = (needle) => got.names.some((x) => x.includes(needle));
    const problems = [];
    if (got.green) problems.push("【全绿】⇒ 这一格不承重（或者锚点没抹到）");
    for (const w of mut.expectRed) if (!hit(w)) problems.push("该红的没红：" + w);
    for (const w of mut.expectGreen) if (hit(w)) problems.push("不该红的红了：" + w);
    results.push([
      problems.length === 0,
      mut.label + "（reverted: " + reverted + "，红的共 " + got.names.length + " 发）",
      problems.length === 0
        ? "红的落点正是：" + got.names.join("、").slice(0, 700)
        : problems.join("；") + " ｜实红：" + got.names.join("、").slice(0, 700),
    ]);
  }

  // 收尾复核：还原后的源码上测试必须回到全绿（全绿的终态 = 证据成立的前提）。
  const after = runTests();
  results.push([
    after.green,
    "M9 全部还原后复跑 ⇒ test/web 回到全绿",
    after.green ? "全绿" : "还原后仍红：" + after.names.join("、").slice(0, 500),
  ]);
} catch (err) {
  fatal = String(err instanceof Error ? err.message : err);
  try {
    rollback();
    results.push([true, "收尾回滚", "已按原文逐字节还原（机器停摆路径）"]);
  } catch (e2) {
    console.error("【致命】收尾回滚失败，立刻去 git 核对：" + SRC + " ｜" + String(e2));
    process.exitCode = 1;
  }
}

if (fatal !== "") {
  console.error("【整台机器停摆，不出命中数】" + fatal);
  process.exitCode = 1;
} else {
  let ok = 0;
  console.log("══════════ round340 a11y/交互四小项变异矩阵（写 app.js 真字节，逐发自回滚）══════════");
  for (const [isHit, label, msg] of results) {
    ok += isHit ? 1 : 0;
    console.log((isHit ? "✓ " : "✗ ") + label + "\n      | " + msg);
  }
  const want = MUTATIONS.length + 2; // + M0 控制 + M9 还原复核
  console.log("命中 " + ok + " / " + results.length + "（分母 = " + MUTATIONS.length + " 发变异 + 控制组 + 还原复核）");
  process.exitCode = ok === results.length && results.length === want ? 0 : 1;
}
