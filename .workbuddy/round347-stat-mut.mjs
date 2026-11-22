/**
 * round347 变异机（test/web）：stat —— 顶部四个大数字格的纯函数。
 *
 * 缺口：stat 在 EXPORTS 白名单（test/web/app-loader.ts:41）里早已被捞出来，
 * 但 app-pure.test.ts 直到 round347 前没有任何一条 it 真跑它 —— 四格大数字
 * （活跃任务 / 完成 / 被阻塞 / 待你决策）的 HTML 拼装是【零执行证据】。
 * round347 补了 6 条 it（常态无 tone / 琥珀 statbad / 数字 esc / label esc /
 * title esc / 消费点回归），这台机器验证那 6 条真有牙齿。
 *
 * 逐发【真抹 app.js 字节】：
 *   M1 esc 全摘（把 stat 体内的三处 esc() 掏成直拼）⇒ 注入三形必须红；
 *   M2 tone 拼法写反（无 tone 也拼类名）⇒ 常态那条红；
 *   M3 tone 条件取反（有 tone 时不拼、无 tone 时拼）⇒ 琥珀那条红；
 *   M4 类名字符串改错（statbad → statbxd）⇒ 琥珀那条红；
 *   M5 只加注释 ⇒ 全绿（M0 控制组：加注释不该红）。
 * 每发跑 test/web/app-pure.test.ts，失败测试名见「红的落点」。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");
const TARGET = "packages/web/public/app.js";
const TEST_FILE = ["test/web/app-pure.test.ts"];

const N = {
  t01: "⭐ 常态：无 tone ⇒ stat 类不带后缀",
  t02: "⭐ 琥珀（§19.2 唯一给 stat 用的色调）：tone=statbad ⇒ class 带后缀",
  t03: "⭐ 数字进 HTML 过 esc（自由文本不假设上游干净）",
  t04: "⭐ label 过 esc（标签是本地常量——守的是将来有人把动态文本塞进来）",
  t05: "⭐ title 过 esc（attribute 注入面，与 innerHTML 分开防）",
  t06: "⭐ 消费点回归：四格大数字的真实传参形状能被 stat 接住",
  t07: "⭐ tone 是【条件】加后缀，不是【无条件】拼（变异机 M2 抓出的盲区）",
};

// 注意：这里 from/to 都是数组（anchor 的既有约定：lines.join(eolOf(text))）。
const MUTATIONS = [
  {
    label: "M1 esc 全摘（三处 esc 直拼 ⇒ 注入防线消失）",
    from: [
      'const stat = (label, n, tone, title) =>\n  `<div class="stat${tone ? " " + tone : ""}" title="${esc(title)}">\n     <div class="num mono">${esc(n)}</div><div class="lbl">${esc(label)}</div>\n   </div>`;',
    ],
    to: [
      'const stat = (label, n, tone, title) =>\n  `<div class="stat${tone ? " " + tone : ""}" title="${title}">\n     <div class="num mono">${n}</div><div class="lbl">${label}</div>\n   </div>`;',
    ],
    expectRed: [N.t03, N.t04, N.t05],
    expectGreen: [N.t01, N.t02, N.t06, N.t07],
  },
  {
    label: "M2 tone 拼法写反（无条件拼类名）",
    from: [
      '`<div class="stat${tone ? " " + tone : ""}" title="${esc(title)}">',
    ],
    to: [
      '`<div class="stat ${tone}" title="${esc(title)}">',
    ],
    expectRed: [N.t01, N.t07],
    expectGreen: [N.t02, N.t03, N.t04, N.t05, N.t06],
  },
  {
    label: "M3 tone 条件取反（有 tone 反而不拼）",
    from: [
      '`<div class="stat${tone ? " " + tone : ""}" title="${esc(title)}">',
    ],
    to: [
      '`<div class="stat${tone ? "" : " " + tone}" title="${esc(title)}">',
    ],
    expectRed: [N.t01, N.t02, N.t06, N.t07],
    expectGreen: [N.t03, N.t04, N.t05],
  },
  {
    label: "M4 div 骨架错（num 与 lbl 顺序互换 ⇒ 结构形状变了）",
    from: [
      '     <div class="num mono">${esc(n)}</div><div class="lbl">${esc(label)}</div>',
    ],
    to: [
      '     <div class="lbl">${esc(label)}</div><div class="num mono">${esc(n)}</div>',
    ],
    expectRed: [N.t01],
    expectGreen: [N.t02, N.t03, N.t04, N.t05, N.t06, N.t07],
  },
  {
    label: "M5 只加注释（不碰逻辑）⇒ 全绿（控制组）",
    from: ['const stat = (label, n, tone, title) =>'],
    to: ['// round347 控制组注释：不影响逻辑。\nconst stat = (label, n, tone, title) =>'],
    expectRed: [],
    expectGreen: [N.t01, N.t02, N.t03, N.t04, N.t05, N.t06, N.t07],
  },
];

const original = readFileSync(join(ROOT, TARGET), "utf8");

function eolOf(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}
const anchor = (text, lines) =>
  Array.isArray(lines) ? lines.join(eolOf(text)) : lines;

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
    if (n !== 1) bad.push("锚点命中 " + n + " 次（要恰好 1）：" + mut.from.slice(0, 60));
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
    "M0 一字不改 ⇒ app-pure 全绿",
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
    "══════════ round347 stat 纯函数变异矩阵（写 app.js 真字节，逐发自回滚）══════════",
  );
  for (const [isHit, label, msg] of results) {
    ok += isHit ? 1 : 0;
    console.log((isHit ? "✓ " : "✗ ") + label + "\n      | " + msg);
  }
  const want = MUTATIONS.length + 2;
  console.log("命中 " + ok + " / " + results.length + "（分母 = " + MUTATIONS.length + " 发变异 + 控制 + 还原）");
  process.exitCode = ok === results.length && results.length === want ? 0 : 1;
}
