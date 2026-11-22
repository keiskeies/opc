/**
 * round346 变异机（web 侧）：回放行 auto_approved 对象渲染 + complete 聚合告警。
 * 照 round345-memory-band-mut.mjs 的形状：读文件→字节级变异→写回→跑目标测试→
 * 记录命中数→恢复原内容→逐字节核对+打印 reverted: true。
 *
 * ── 这台机器要回答的唯一问题 ──────────────────────────────────
 * 两处新读数的展示半被测试钉住，而【测试绿】对它们不证明 —— 每发变异都
 * 【真抹生产字节】：
 *   M1 autoApprovedOf 恒返 null ⇒ 事件行永不出现「基于模式的自动批准」标注
 *       （这正是本格修的缺陷 —— 早先 === true 恒假时它从未上屏过）。
 *   M2 eventRow 内联撤销接线（autoApprovedOf(e) 那处删掉）⇒ 纯函数活着也白搭。
 *   M3 incompleteNote 恒返空串 ⇒ 时间线「中间缺行」提示消失。
 *   M4 renderReplay/loadReplay 接线撤掉（incompleteNote(data.complete) 删掉）⇒
 *       缺口的聚合提示没人摆上屏。
 *   M5 autoApprovedOf 改回 === true 布尔比较 ⇒ 对象恒不等于 true，缺陷复活。
 *   M6 incompleteNote 判据放宽（undefined 也当缺口）⇒ 老服务端没发这一格时
 *       页面多出一行假告警（complete 缺失不该算缺口）。
 *
 * 每一发都【真抹生产字节】（packages/web/public/app.js），跑完逐字节还原并核对
 * next !== before，且每发变异前后断言源码字符串【真的变了】。
 *
 * ⚠ 跑法（仓根）：npx tsx .workbuddy/round346-replay-notes-mut.mjs
 *   这台机器写真字节 ⇒ 单独跑，不与任何测试并发。
 *   读红绿：vitest 退出码 + 失败【测试名】，不 grep 汇总数字。
 *   只跑目标两文件（app-pure + renderer-criteria），不碰全量。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");
const SRC = "packages/web/public/app.js";
const TEST_FILES = ["test/web/app-pure.test.ts", "test/web/renderer-criteria.test.ts"];

/** 失败测试名的子串（够认出哪一发，不随标题标点漂移）。 */
const N = {
  aaObj: "auto_approved 是对象时标注真的上屏",
  aaMiss: "auto_approved 缺失/非对象",
  aaEsc: "auto_approved 的 rule/annotation 过 esc",
  aaWiring: "auto_approved 标注【真的按对象读】",
  incTrue: "complete 是 false ⇒ 给一条聚合提示",
  incSilent: "complete true / 缺字段 / 非布尔 ⇒ 静默",
  incWiring: "incompleteNote【真的接在回放头卡】",
};

const MUTATIONS = [
  {
    label: "M1 autoApprovedOf 恒返 null ⇒ 自动批准标注永不出现（缺陷原位复活）",
    from: [
      "function autoApprovedOf(e) {\n" +
        "  if (!e || typeof e !== \"object\") return null;\n" +
        '  const a = e.auto_approved;\n' +
        '  if (a == null || typeof a !== "object" || Array.isArray(a)) return null;\n',
    ],
    to: [
      "function autoApprovedOf(e) {\n" +
        "  return null; // 变异：恒空\n",
    ],
    expectRed: [N.aaObj, N.aaEsc],
    expectGreen: [N.aaMiss, N.incTrue, N.incSilent],
  },
  {
    label: "M2 eventRow 内联 autoApprovedOf 接线撤掉 ⇒ 纯函数活着也白搭",
    from: [
      "  const auto = autoApprovedOf(e);\n" +
        "  const decide = e.actor_type === \"human\";\n" +
        '  const cls = auto !== null ? "auto" : decide ? "decide" : "";\n',
    ],
    to: [
      "  const auto = null; // 变异：接线断（eventRow 里不再调 autoApprovedOf）\n" +
        "  const decide = e.actor_type === \"human\";\n" +
        '  const cls = auto !== null ? "auto" : decide ? "decide" : "";\n',
    ],
    expectRed: [N.aaObj, N.aaEsc],
    expectGreen: [N.aaMiss, N.incTrue],
  },
  {
    label: "M3 incompleteNote 恒返空串 ⇒ 「中间缺行」聚合提示消失（服务端注释明说要做）",
    from: [
      "function incompleteNote(complete) {\n" +
        '  if (complete !== false) return "";\n',
    ],
    to: [
      "function incompleteNote(complete) {\n" +
        "  return ''; // 变异：恒空\n",
    ],
    expectRed: [N.incTrue],
    expectGreen: [N.incSilent, N.aaObj],
  },
  {
    label: "M4 loadReplay 接线撤掉 ⇒ 纯函数活着也没人摆上屏",
    from: [
      "    ${checkpointDegradedNote(data.checkpoints_unavailable, (data.checkpoints ?? []).length)}\n" +
        "    ${incompleteNote(data.complete)}\n",
    ],
    to: [
      "    ${checkpointDegradedNote(data.checkpoints_unavailable, (data.checkpoints ?? []).length)}\n",
    ],
    expectRed: [N.incWiring],
    expectGreen: [N.incTrue, N.incSilent, N.aaObj],
  },
  {
    label: "M5 autoApprovedOf 改成 === true 布尔比较 ⇒ 缺陷原样复活（round346 前形状）",
    from: [
      "function autoApprovedOf(e) {\n" +
        "  if (!e || typeof e !== \"object\") return null;\n" +
        '  const a = e.auto_approved;\n' +
        '  if (a == null || typeof a !== "object" || Array.isArray(a)) return null;\n' +
        "  const by = typeof a.by === \"string\" && a.by !== \"\" ? esc(a.by) : null;\n" +
        "  const rule = typeof a.rule === \"string\" && a.rule !== \"\" ? esc(a.rule) : null;\n",
    ],
    to: [
      "function autoApprovedOf(e) {\n" +
        "  return e.auto_approved === true ? { by: null, rule: null, annotation: null } : null; // 变异\n",
    ],
    expectRed: [N.aaObj, N.aaEsc, N.aaMiss],
    expectGreen: [N.incTrue, N.incSilent],
  },
  {
    label: "M6 incompleteNote 放宽判据（只要非 true 就算缺口）⇒ 老服务端没发时假告警",
    from: [
      "function incompleteNote(complete) {\n" +
        '  if (complete !== false) return "";\n',
    ],
    to: [
      "function incompleteNote(complete) {\n" +
        "  if (complete === true) return ''; // 变异：null/undefined 也当缺口\n",
    ],
    expectRed: [N.incSilent],
    expectGreen: [N.incTrue, N.aaObj],
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
  const r = spawnSync(
    process.execPath,
    [VITEST, "run", ...TEST_FILES],
    { cwd: ROOT, encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 },
  );
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

/** 锚点先全验：任一失配/真空 ⇒ 一发不发。 */
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
    "M0 一字不改 ⇒ app-pure + renderer-criteria 全绿",
    control.green ? "全绿" : "意外红：" + control.names.join("、").slice(0, 500),
  ]);
  if (!control.green) throw new Error("控制组就红 ⇒ 后面每一发的「该红/该绿」都没有地基");

  for (const mut of MUTATIONS) {
    const before = readFileSync(join(ROOT, SRC), "utf8");
    const next = before.replace(anchor(before, mut.from), anchor(before, mut.to));
    if (next === before)
      throw new Error("断言失败：变异前后源码逐字节相同（" + mut.label + "）");
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
    "══════════ round346 回放 auto_approved + complete 渲染变异矩阵（写 app.js 真字节，逐发自回滚）══════════",
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
