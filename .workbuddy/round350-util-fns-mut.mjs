/**
 * round350 变异机（test/web）：五个漏网顶层纯函数的执行证据有没有牙齿。
 *
 * 缺口：fmtDate / fmtAgo / windowLabel / joinLines / linkText 不在 EXPORTS
 * 白名单（app-loader.ts），app-pure.test.ts 从无任何 it 直接跑它们 —— 只在
 * 消费它们的白名单成员内部被间接执行到，改坏输出没有任何断言会红。
 * round350 补：白名单 5 名 + 独立 describe（app-pure 190 → 201 发）。
 * 写测试的过程中意外抓到 linkText 的真实缺陷：null 输入 TypeError
 * （`(…)[p.link]` 先读 p.link 就炸）。已修实现（null ⇒ undefined，
 * 渲染层 esc 兜住 —— 符合「缺失不许被读成一个肯定陈述」姿态）。
 * 本机变异方向是【对修复后的实现反向注入】。
 *
 * 逐发【真抹 app.js 字节】，验证 5 个 describe 每发都有对应的红：
 *   M1 fmtDate 坏值分支改错（`: "—"` → `: ""`）⇒ 「坏值 ⇒ —」红；
 *   M2 fmtAgo 秒档改 `<= 60` ⇒ 「59 秒前」须走分钟档、红；
 *   M3 windowLabel 三目写反 ⇒ 「1 小时/1 天」那颗红；
 *   M4 joinLines 非数组兜底删掉 ⇒ 「非数组 ⇒ 空串」红；
 *   M5 linkText null 防护删掉 ⇒ 「null ⇒ undefined」红（回退到 TypeError）；
 *   M6 只加注释 ⇒ 全绿（控制组）。
 * 每发真抹 app.js 字节 + 逐字节回滚 + next!==before + reverted:true。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");
const TARGET = "packages/web/public/app.js";
const TEST_FILE = ["test/web/app-pure.test.ts"];

const N = {
  d1: "⭐ 坏值（0 / null / undefined / NaN）⇒ 「—」，不许是任何日期形状",
  d2: "⭐ 好值 ⇒ 非「—」且含数字（不钉字面：locale/时区漂移留给变异机）",
  a1: "⭐ 缺 now 或缺 ms ⇒ 「—」（没有基准不许编一个相对时间）",
  a2: "⭐ 四档边界逐字钉：秒 / 分钟 / 小时 / 天",
  a3: "⭐ 未来时刻（now - ms 为负）钳到 0，不显示负数秒",
  w1: "⭐ 默认（无 window_ms）⇒ 24h ⇒ 「1 天」",
  w2: "⭐ <24h ⇒ 小时；≥24h ⇒ 天（rounding 边界）",
  j1: "⭐ 数组 ⇒ 换行 join；空数组 ⇒ 空串",
  j2: "⭐ 非数组（null / undefined / 对象 / 数字）⇒ 空串 —— 这是它区别于裸 .join() 的判据",
  l1: "⭐ 四档逐字钉：live / stale / down / connecting",
  l2: "⭐ 未知枚举 ⇒ undefined（调用方 esc 兜住 —— 不许悄悄变成任何一句肯定陈述）",
};

// 注意：这里 from/to 都是数组（anchor 的既有约定：lines.join(eolOf(text))）。
const MUTATIONS = [
  {
    label: "M1 fmtDate 坏值分支改错（「—」→ 空串）",
    from: ["const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString(\"zh-CN\") : \"—\");"],
    to: ["const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString(\"zh-CN\") : \"\");"],
    expectRed: [N.d1],
    expectGreen: [N.d2, N.a1, N.a2, N.a3, N.w1, N.w2, N.j1, N.j2, N.l1, N.l2],
  },
  {
    label: "M2 fmtAgo 秒档边界写错（`< 60` → `<= 60`）",
    from: [
      "const fmtAgo = (ms, nowMs) => {\n  if (!ms || !nowMs) return \"—\";\n  const s = Math.max(0, Math.round((nowMs - ms) / 1000));\n  if (s < 60) return s + \" 秒前\";",
    ],
    to: [
      "const fmtAgo = (ms, nowMs) => {\n  if (!ms || !nowMs) return \"—\";\n  const s = Math.max(0, Math.round((nowMs - ms) / 1000));\n  if (s <= 60) return s + \" 秒前\";",
    ],
    expectRed: [N.a2],
    expectGreen: [N.d1, N.d2, N.a1, N.a3, N.w1, N.w2, N.j1, N.j2, N.l1, N.l2],
  },
  {
    label: "M3 windowLabel 三目写反（≥24 给小时、<24 给天）",
    from: [
      "  return h >= 24 ? Math.round(h / 24) + \" 天\" : h + \" 小时\";",
    ],
    to: [
      "  return h < 24 ? Math.round(h / 24) + \" 天\" : h + \" 小时\";",
    ],
    expectRed: [N.w1, N.w2],
    expectGreen: [N.d1, N.d2, N.a1, N.a2, N.a3, N.j1, N.j2, N.l1, N.l2],
  },
  {
    label: "M4 joinLines 非数组兜底删掉（直接 .join ⇒ 非数组炸）",
    from: [
      "const joinLines = (arr) => (Array.isArray(arr) ? arr : []).join(\"\\n\");",
    ],
    to: [
      "const joinLines = (arr) => arr.join(\"\\n\");",
    ],
    expectRed: [N.j2],
    expectGreen: [N.d1, N.d2, N.a1, N.a2, N.a3, N.w1, N.w2, N.j1, N.l1, N.l2],
  },
  {
    label: "M5 linkText null 防护删掉（回到 TypeError）",
    from: [
      "const linkText = (p) =>\n  !p\n    ? undefined\n    : ({",
    ],
    to: [
      "const linkText = (p) =>\n  ({",
    ],
    expectRed: [N.l2],
    expectGreen: [N.d1, N.d2, N.a1, N.a2, N.a3, N.w1, N.w2, N.j1, N.j2, N.l1],
  },
  {
    label: "M6 只加注释（不碰逻辑）⇒ 全绿（控制组）",
    from: ["const fmtDate = (ms) =>"],
    to: ["// round350 控制组注释：不影响逻辑。\nconst fmtDate = (ms) =>"],
    expectRed: [],
    expectGreen: [N.d1, N.d2, N.a1, N.a2, N.a3, N.w1, N.w2, N.j1, N.j2, N.l1, N.l2],
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

for (const [ok, label, detail] of results) {
  console.log((ok ? "✓ " : "✗ ") + label);
  console.log("    " + detail);
}
if (fatal) {
  console.error("【停摆】" + fatal);
  process.exitCode = 1;
} else {
  const bad = results.filter((r) => !r[0]).length;
  if (bad !== 0) {
    console.error("命中数 = " + bad + "，期望 0");
    process.exitCode = 1;
  } else {
    console.log("全部命中 ✓（exit 0）");
  }
}
