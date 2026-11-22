/**
 * round346 变异机（test/arch）：production-deps.tsFiles 的 statSync 并发雷保护。
 *
 * 0054 §5/§8 登记：tsFiles 的裸 `statSync(p).isDirectory()` 在「目录夹具并行建、
 * 扫描途中被删」时会随机 ENOENT —— doc 明说「不是没有雷，谁哪天往 src/ 里建个
 * 目录夹具，它就是第二个 no-native-deps；修法与本轮同形」。round346 用
 * `survivesStat` 包上（ENOENT/ENOTDIR ⇒ false ⇒ 「目录刚消失」被读成「不是目录」）。
 *
 * 这台机器回答的唯一问题：round346 那发新测试（语义 + 接线守门）到底有没有按住
 * 生产字节。逐发【真抹字节】：
 *   M1 拿掉保护（statSync 裸奔回归）⇒ 接线守门必须红（语义那半该绿 —— 它测的是
 *      survivesStat 本身，不依赖 tsFiles 里有没有包）。
 *   M2 保护改成不同包法（readdirSurvives 式换皮）⇒ 接线守门红；语义那半该绿。
 *   M3 只改注释（不碰逻辑）⇒ 全绿（M0 的控制组：加注释不该红）。
 * 每发跑 test/arch/production-deps.test.ts，失败测试名见「红的落点」。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");
const TARGET = "test/arch/production-deps.test.ts";
const TEST_FILE = ["test/arch/production-deps.test.ts"];

const N = {
  wiring: "tsFiles 的 statSync 被 survivesStat 包着",
  probe: "接了名单的取材函数在【探针真的存在】时不列出它",
};

const MUTATIONS = [
  {
    label: "M1 拿掉保护：statSync(p).isDirectory() 裸奔回归（0054 那颗雷）",
    from: ['    if (survivesStat(() => statSync(p).isDirectory())) out.push(...tsFiles(p));'],
    to: ['    if (statSync(p).isDirectory()) out.push(...tsFiles(p)); // 变异：裸奔'],
    expectRed: [N.wiring],
    expectGreen: [N.probe],
  },
  {
    label: "M2 换皮保护：用 readdirSurvives 同语义但【不是 survivesStat】",
    from: ['    if (survivesStat(() => statSync(p).isDirectory())) out.push(...tsFiles(p));'],
    to: ['    if (survivesStat2(() => statSync(p).isDirectory())) out.push(...tsFiles(p)); // 变异：函数名变了但语义相同'],
    expectRed: [N.wiring],
    expectGreen: [N.probe],
  },
  {
    label: "M3 只加注释（不碰逻辑）⇒ 全绿（控制组：加注释不该红）",
    from: ['    if (survivesStat(() => statSync(p).isDirectory())) out.push(...tsFiles(p));'],
    to: [
      '    // round346 控制组注释：不影响逻辑。\n    if (survivesStat(() => statSync(p).isDirectory())) out.push(...tsFiles(p));',
    ],
    expectRed: [],
    expectGreen: [N.wiring, N.probe],
  },
];

const original = readFileSync(join(ROOT, TARGET), "utf8");

function eolOf(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}
const anchor = (text, lines) => lines.join(eolOf(text));

function failedTests(out) {
  const plain = out.replace(
    new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "gu"),
    "",
  );
  const names = new Set();
  for (const line of plain.split("\n")) {
    const m = /(?:×|✗)\s+(.+?)(?:\s+\d+ms)?\s*$/u.exec(line.trim());
    if (m !== null && m[1] !== undefined) names.add(m[1].trim());
  }
  return [...names];
}

function runTests() {
  const r = spawnSync(process.execPath, [VITEST, "run", ...TEST_FILE], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = String(r.stdout) + String(r.stderr);
  return { green: r.status === 0, names: failedTests(out) };
}

function rollback() {
  writeFileSync(join(ROOT, TARGET), original, "utf8");
  if (readFileSync(join(ROOT, TARGET), "utf8") !== original) {
    throw new Error("回滚失败，字节对不上：" + TARGET);
  }
}

function preflight() {
  const bad = [];
  for (const mut of MUTATIONS) {
    const from = anchor(original, mut.from);
    const to = anchor(original, mut.to);
    if (from === to) bad.push(mut.label + " 是真空操作");
    const n = original.split(from).length - 1;
    if (n !== 1) bad.push("锚点命中 " + n + " 次（要恰好 1）：" + mut.from.slice(0, 70));
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
    "M0 一字不改 ⇒ production-deps 全绿",
    control.green ? "全绿" : "意外红：" + control.names.join("、").slice(0, 500),
  ]);
  if (!control.green) throw new Error("控制组就红 ⇒ 无地基");

  for (const mut of MUTATIONS) {
    const before = readFileSync(join(ROOT, TARGET), "utf8");
    const next = before.replace(anchor(before, mut.from), anchor(before, mut.to));
    if (next === before) throw new Error("断言失败：变异前后字节相同（" + mut.label + "）");
    writeFileSync(join(ROOT, TARGET), next, "utf8");
    if (readFileSync(join(ROOT, TARGET), "utf8") !== next) {
      throw new Error("断言失败：写盘后读回不是变异体（" + mut.label + "）");
    }
    let got;
    let reverted = false;
    try {
      got = runTests();
    } finally {
      rollback();
      reverted = readFileSync(join(ROOT, TARGET), "utf8") === original;
    }
    if (!reverted) throw new Error("reverted !== true（" + mut.label + "）");
    const hit = (needle) => got.names.some((x) => x.includes(needle));
    const problems = [];
    if (mut.expectRed.length > 0 && got.green) problems.push("【全绿】⇒ 这一格不承重");
    for (const w of mut.expectRed) if (!hit(w)) problems.push("该红的没红：" + w);
    for (const w of mut.expectGreen) if (hit(w)) problems.push("不该红的红了：" + w);
    results.push([
      problems.length === 0,
      mut.label + "（reverted: " + reverted + "，next!==before ✓，红 " + got.names.length + " 发）",
      problems.length === 0
        ? "红的落点正是：" + got.names.join("、").slice(0, 500)
        : problems.join("；") + " ｜实红：" + got.names.join("、").slice(0, 500),
    ]);
  }

  const after = runTests();
  results.push([
    after.green,
    "M9 全部还原后复跑 ⇒ 回到全绿",
    after.green ? "全绿" : "还原后仍红：" + after.names.join("、").slice(0, 500),
  ]);
} catch (err) {
  fatal = String(err instanceof Error ? err.message : err);
  try {
    rollback();
    results.push([true, "收尾回滚", "已按原文逐字节还原（停摆路径）"]);
  } catch (e2) {
    console.error("【致命】收尾回滚失败：" + String(e2));
    process.exitCode = 1;
  }
}

if (fatal !== "") {
  console.error("【整台机器停摆，不出命中数】" + fatal);
  process.exitCode = 1;
} else {
  let ok = 0;
  console.log(
    "══════════ round346 production-deps statSync 保护变异矩阵（写 test 真字节，逐发自回滚）══════════",
  );
  for (const [isHit, label, msg] of results) {
    ok += isHit ? 1 : 0;
    console.log((isHit ? "✓ " : "✗ ") + label + "\n      | " + msg);
  }
  const want = MUTATIONS.length + 2;
  console.log("命中 " + ok + " / " + results.length + "（分母 = " + MUTATIONS.length + " 发变异 + 控制 + 还原）");
  process.exitCode = ok === results.length && results.length === want ? 0 : 1;
}
