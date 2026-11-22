/**
 * round352 变异机（web 侧）：今日页窗口接线（?window_ms= 的前端入口）。
 * 照 round342/351 的形状：读文件→字节级变异→写回→跑目标测试→记录命中数→
 * 恢复原内容→逐字节核对+打印 reverted: true。
 *
 * ── 这台机器要回答的唯一问题 ──────────────────────────────────
 * 今日页窗口三件套（hash 解析 / 缓存分窗口 / renderToday 接线）各自由测试钉住，
 * 而【测试绿】对它们不证明 —— 每发变异都【真抹生产字节】：
 *  M1 windowMsOfHash 的「剥离 d/天 尾缀」撤掉 ⇒ 「?window=7d」解析成 NaN ⇒
 *    undefined（7 天开关坏成默认 24h —— 最有用户可感的失败方向）。
 *  M2 todayCacheHit 放宽成「有缓存即命中，不看窗口」⇒ 切到 7 天时读到 30 天
 *    缓存（7 天标签配 30 天数据，两个都对而互相矛盾）。
 *  M3 todayCacheHit 的 force 短路删掉 ⇒ force=true 时命中缓存 ⇒ 切窗口后
 *    不重拉（今日页刷新失效）。
 *  M4 getToday 的 q 拼串把 ?window_ms= 撤掉 ⇒ 即使 hash 正确，请求仍是裸
 *    /today ⇒ 服务端永远 24h（接线在，参数丢了）。
 *  M5 renderToday 的 windowMsOfHash(location.hash) 撤回成 undefined ⇒
 *    窗口选择器渲染了，但数据永远是 24h（界面显示与数据脱钩）。
 *
 * ⚠ 跑法（仓根）：npx tsx .workbuddy/round352-window-mut.mjs
 *   这台机器写真字节 ⇒ 单独跑，不与任何测试并发（round292 (b)）。
 *   读红绿：vitest 退出码 + 失败【测试名】，不 grep 汇总数字（round301 §⑦③）。
 *   只跑目标单文件（app-pure + renderer-criteria），不碰全量。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");
const SRC = "packages/web/public/app.js";
// 目标集 = 纯函数直测 + 接线守卫。M4/M5 杀的是 getToday/renderToday 本体（不在
// app-pure 射程内），靠 renderer-criteria 的源码接线断言兜住 —— 两个文件一起跑，
// 仍是「目标单文件」，不是全量。
const TEST_FILES = ["test/web/app-pure.test.ts", "test/web/renderer-criteria.test.ts"];

/** 失败测试名的子串（够认出哪一发，不随标题标点漂移）。 */
const N = {
  w1: "三种写法归一：7d / 7天 / 裸 7",
  w2: "非法输入 ⇒ undefined",
  w3: "只认 ?window=，其它 query 一并忽略",
  cacheForce: "force ⇒ 恒 miss",
  cacheNoWin: "无窗口读默认缓存",
  cacheWin: "有窗口只命中 windowMs 完全相同",
  cacheNull: "缓存为 null ⇒ miss",
  // 接线守卫（renderer-criteria.test.ts，M4/M5 专用）
  wireQ: "窗口参数【真的拼进请求】",
  wireMs: "今日页窗口【真的接进 renderToday】",
};

const MUTATIONS = [
  {
    label: "M1 剥离 d/天 尾缀撤掉 ⇒ 7d 解析成 NaN ⇒ 7 天开关坏（undefined）",
    from: [
      "  const n = Number((v ?? \"\").replace(/[d天]$/u, \"\"));",
    ],
    to: [
      "  const n = Number((v ?? \"\").replace(/[d天]$/u, \"x\")); // 变异：尾缀不剥",
    ],
    expectRed: [N.w1, N.w3],
    expectGreen: [N.w2],
  },
  {
    label: "M2 缓存命中放宽成不看窗口 ⇒ 7 天命中 30 天缓存（标签配错数据）",
    from: [
      "  return windowMs === undefined || cache.windowMs === windowMs;",
    ],
    to: [
      "  return cache !== null; // 变异：窗口不看，恒命中",
    ],
    // 语义推演：force 短路在变异【前】那行（if (force||...）已被移除窗口匹配）没被
    // 动 —— force=true 仍先 false ⇒ cacheForce 绿；只有「窗口戳不一致也命中」的
    // cacheWin 红。expectRed 只留 cacheWin。（round352 修正：上一版把 cacheForce
    // 误列进来，实红只有 cacheWin。）
    expectRed: [N.cacheWin],
    expectGreen: [N.cacheNoWin],
  },
  {
    label: "M3 force 短路删掉 ⇒ force=true 也命中缓存 ⇒ 切窗口不重拉",
    from: [
      "  if (force || cache === null) return false;",
    ],
    to: [
      "  if (cache === null) return false; // 变异：force 不再强制 miss",
    ],
    // 语义推演：变异后 force=true 有缓存 ⇒ return cache!==null = true（原 false）⇒
    // mine cacheForce；cacheNoWin（undefined 窗口）与 cacheWin（同窗戳）的返回值在
    // 变异前后【一样】，不该红 —— 上一版把它们误列为 expectRed。
    expectRed: [N.cacheForce],
    expectGreen: [N.cacheNoWin, N.cacheWin, N.cacheNull],
  },
  {
    label: "M4 getToday 的 q 拼串把 ?window_ms= 撤掉 ⇒ 请求永远是裸 /today",
    from: [
      "  const q = windowMs === undefined ? \"\" : `?window_ms=${windowMs}`;",
    ],
    to: [
      "  const q = \"\"; // 变异：窗口参数不拼进请求",
    ],
    // getToday 不在 app-pure 射程，靠 renderer-criteria 的接线守卫 wireQ。
    expectRed: [N.wireQ],
    expectGreen: [N.w1, N.w2, N.w3, N.cacheForce, N.cacheNoWin, N.cacheWin, N.cacheNull, N.wireMs],
  },
  {
    label: "M5 renderToday 撤回 windowMsOfHash(location.hash) ⇒ 数据永远 24h",
    from: [
      "  const winMs = windowMsOfHash(location.hash);",
    ],
    to: [
      "  const winMs = undefined; // 变异：hash 不再传给 getToday",
    ],
    expectRed: [N.wireMs],
    expectGreen: [N.w1, N.w2, N.w3, N.wireQ],
  },
];

const original = readFileSync(join(ROOT, SRC), "utf8");

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
  const r = spawnSync(process.execPath, [VITEST, "run", ...TEST_FILES], {
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
    if (mut.from.length !== mut.to.length) {
      bad.push(mut.label + " 的 from/to 锚点数不一致");
      continue;
    }
    for (let i = 0; i < mut.from.length; i++) {
      const n = original.split(mut.from[i]).length - 1;
      if (n !== 1)
        bad.push("锚点命中 " + n + " 次（要恰好 1）：" + mut.from[i].slice(0, 70));
      if (mut.from[i] === mut.to[i])
        bad.push(mut.label + " 锚点 #" + i + " 是真空操作（from === to）");
    }
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
    "M0 一字不改 ⇒ " + TEST_FILES.join(" + ") + " 全绿",
    control.green
      ? "全绿"
      : "意外红：" + control.names.join("、").slice(0, 500),
  ]);
  if (!control.green) throw new Error("控制组就红 ⇒ 后面每一发的「该红/该绿」都没有地基");

  for (const mut of MUTATIONS) {
    const before = readFileSync(join(ROOT, SRC), "utf8");
    let next = before;
    for (let i = 0; i < mut.from.length; i++) {
      next = next.replace(mut.from[i], mut.to[i]);
      if (next === before)
        throw new Error("断言失败：变异前后源码逐字节相同（" + mut.label + "）");
    }
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
    if (mut.expectRed.length > 0 && got.green)
      problems.push("【全绿】⇒ 这一格不承重（或者锚点没抹到）");
    for (const w of mut.expectRed) if (!hit(w)) problems.push("该红的没红：" + w);
    for (const w of mut.expectGreen) if (hit(w)) problems.push("不该红的红了：" + w);
    results.push([
      problems.length === 0,
      mut.label +
        "（reverted: " +
        reverted +
        "，next!==before ✓，红的共 " +
        got.names.length +
        " 发）",
      problems.length === 0
        ? "红的落点正是：" + got.names.join("、").slice(0, 700)
        : problems.join("；") + " ｜实红：" + got.names.join("、").slice(0, 700),
    ]);
  }

  // 收尾复核：还原后的源码上测试必须回到全绿（全绿的终态 = 证据成立的前提）。
  const after = runTests();
  results.push([
    after.green,
    "M9 全部还原后复跑 ⇒ " + TEST_FILES.join(" + ") + " 回到全绿",
    after.green ? "全绿" : "还原后仍红：" + after.names.join("、").slice(0, 500),
  ]);
} catch (err) {
  fatal = String(err instanceof Error ? err.message : err);
  try {
    rollback();
    results.push([true, "收尾回滚", "已按原文逐字节还原（机器停摆路径）"]);
  } catch (e2) {
    console.error(
      "【致命】收尾回滚失败，立刻去 git 核对：" + SRC + " ｜" + String(e2),
    );
    process.exitCode = 1;
  }
}

if (fatal !== "") {
  console.error("【整台机器停摆，不出命中数】" + fatal);
  process.exitCode = 1;
} else {
  let ok = 0;
  console.log(
    "══════════ round352 今日页窗口接线变异矩阵（写 app.js 真字节，逐发自回滚）══════════",
  );
  for (const [isHit, label, msg] of results) {
    ok += isHit ? 1 : 0;
    console.log((isHit ? "✓ " : "✗ ") + label + "\n      | " + msg);
  }
  const want = MUTATIONS.length + 2; // + M0 控制 + M9 还原复核
  console.log(
    "命中 " +
      ok +
      " / " +
      results.length +
      "（分母 = " +
      MUTATIONS.length +
      " 发变异 + 控制组 + 还原复核）",
  );
  process.exitCode = ok === results.length && results.length === want ? 0 : 1;
}
