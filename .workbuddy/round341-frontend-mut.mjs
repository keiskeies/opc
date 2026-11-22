/**
 * round341 变异机（web 侧）：摘要条补读 human_decided / 事件行 target /
 * checkpoints_unavailable 降级提示 + 两处死代码清理（data.degraded 三目、重复
 * notesHtml）。照 round340-replay-mut.mjs 的形状：读文件→字节级变异→写回→
 * 跑目标测试→记录命中数→恢复原内容→逐字节核对+打印 reverted: true。
 *
 * ── 这台机器要回答的唯一问题 ──────────────────────────────────
 * 三处新读数的展示半各自由测试钉住，而【测试绿】对它们不证明 —— 每发变异都
 * 【真抹生产字节】：
 *   M1 human_decided 那一节删除（恒不入句）⇒ 摘要条永不显示「人已拍板 N 项」。
 *   M2 eventTargetText 恒返空串 ⇒ 事件行永不渲染 target（目标角色列消失）。
 *   M3 checkpointDegradedNote 恒返空串 ⇒ 断点区「解码失败/仅显示数量」提示消失。
 *   M4 data.degraded 三目【删回来】⇒ 死代码从古墓里复活（它本就不该存在）。
 *   M5 重复的 notesHtml(t.notes)【删回来】⇒ 同样的口径说明块在页面上出现两次。
 *   M6 (追加) eventRow 内联 target 撤掉 ⇒ 即使 eventTargetText 正确也永不显示
 *       target（接线断了，纯函数活得再好也白搭）。
 *
 * 每一发都【真抹生产字节】（packages/web/public/app.js），跑完逐字节还原并核对
 * next !== before，且每发变异前后断言源码字符串【真的变了】。
 *
 * ⚠ 跑法（仓根）：npx tsx .workbuddy/round341-frontend-mut.mjs
 *   这台机器写真字节 ⇒ 单独跑，不与任何测试并发（round292 (b)）。
 *   读红绿：vitest 退出码 + 失败【测试名】，不 grep 汇总数字（round301 §⑦③）。
 *   只跑目标单文件（test/web/app-pure.test.ts），不碰全量。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");
const SRC = "packages/web/public/app.js";
const TEST_FILE = "test/web/app-pure.test.ts";

/** 失败测试名的子串（够认出哪一发，不随标题标点漂移）。 */
const N = {
  hdIn: "人已拍板 > 0",
  hdZero: "句子与现状逐字一致",
  hdMissing: "upstream 缺该字段（老服务端）",
  ttSingle: "单值字符串：原样返回且过 esc",
  ttArray: "数组：join",
  ttEmpty: "空/缺 ⇒ 空串",
  rowTarget: "有 target ⇒ 「→ {已 esc}」小标签",
  rowEmpty: "target 为空/缺 ⇒ 事件行不占那一格",
  rowEsc: "target 过 esc",
  cdTrue: "unavailable 为真 ⇒ 给降级提示",
  cdFalse: "unavailable 为假",
  cdEsc: "原因过 esc",
  cdCount: "count 非正/非数",
  sN1: "回放响应扁平无 top-level degraded",
  sN2: "notesHtml 只出现一次",
  sN3: "摘要条读 human_decided_in_window",
  sN4: "事件行接上 eventTargetText(e.target)",
};

const MUTATIONS = [
  {
    label:
      "M1 human_decided 那一节删除 ⇒ 摘要条永不显示「人已拍板 N 项」（round341 补读失效）",
    from: [
      "  (t.decisions.human_decided_in_window\n" +
        "    ? `人已拍板 ${t.decisions.human_decided_in_window} 项。`\n" +
        '    : "") +\n' +
        "  `当前待处理 ${navPending} 项。`;",
    ],
    to: ["  `当前待处理 ${navPending} 项。`; // 变异：human_decided 那一节删掉"],
    expectRed: [N.hdIn, N.sN3],
    expectGreen: [N.hdZero, N.hdMissing, N.ttSingle],
  },
  {
    label: "M2 eventTargetText 恒返空串 ⇒ 事件行 target 永不显示（对什么做了什么没了）",
    from: [
      "function eventTargetText(target) {\n" +
        "  if (Array.isArray(target)) {\n" +
        "    const parts = target.map((x) => String(x ?? \"\")).filter((x) => x !== \"\");\n" +
        "    return parts.length ? esc(parts.join(\"、\")) : \"\";\n" +
        "  }\n" +
        '  if (target == null) return "";\n' +
        '  const t = String(target).trim();\n' +
        '  return t ? esc(t) : "";\n' +
        "}",
    ],
    to: ["function eventTargetText(target) { return ''; } // 变异：target 恒空"],
    expectRed: [N.ttSingle, N.ttArray, N.rowTarget, N.rowEsc],
    expectGreen: [N.ttEmpty, N.hdIn, N.cdTrue],
  },
  {
    label:
      "M3 checkpointDegradedNote 恒返空串 ⇒ 断点区「解码失败/仅显示数量」提示消失",
    from: [
      "function checkpointDegradedNote(unavailable, count) {\n" +
        '  if (!unavailable) return "";\n' +
        "  const n =\n" +
        '    typeof count === "number" && Number.isFinite(count) && count > 0 ? count : 0;\n' +
        "  return (\n" +
        '    `<div class="banner warn" style="margin:0 0 10px"><b>断点解码失败，仅显示数量</b>` +\n' +
        "    `（${esc(String(unavailable))}${n > 0 ? ` · 实际断点 ${esc(n)} 个` : \"\"}）</div>`\n" +
        "  );\n" +
        "}",
    ],
    to: [
      "function checkpointDegradedNote(unavailable, count) { return ''; } // 变异：恒空",
    ],
    expectRed: [N.cdTrue, N.cdEsc, N.cdCount],
    expectGreen: [N.cdFalse, N.hdIn, N.ttSingle],
  },
  {
    label:
      "M4 data.degraded 三目【删回来】⇒ 死代码复活（round341 已确认 ReplayView 扁平无 top-level degraded）",
    from: [
      '    <div class="meta" style="margin:10px 0">事件 <span class="mono">${esc(entries.length)}</span> 条（服务端 limit ${esc(data.effective_limit)}',
    ],
    to: [
      '    ${data.degraded ? banner("warn", "这份回放是降级的：" + esc(data.degraded.reason ?? "原因未给出")) : ""}\n' +
        '    <div class="meta" style="margin:10px 0">事件 <span class="mono">${esc(entries.length)}</span> 条（服务端 limit ${esc(data.effective_limit)}',
    ],
    // 死代码还魂字面本身被 N1 那个源码级守门杀掉（复辟 = src contains
    // `data.degraded ? banner(`）。checkpointDegradedNote 那条降级提示没被碰 ⇒ 全绿。
    expectRed: [N.sN1],
    expectGreen: [N.cdTrue, N.cdFalse, N.hdIn, N.ttSingle],
  },
  {
    label: "M5 重复 notesHtml(t.notes)【删回来】⇒ 口径说明块在今日页出现两次",
    from: [
      "        <details class=\"lowcontrast\" style=\"margin-top:18px\">\n" +
        "          <summary>自动决策摘要 · 过去 ${esc(windowLabel(t))}</summary>\n" +
        "          <div class=\"meta\" style=\"margin-top:8px\">${esc(strategyLine(t))}</div>\n" +
        "        </details>\n" +
        "\n" +
        "        <details class=\"lowcontrast\" style=\"margin-top:10px\">",
    ],
    to: [
      "        <details class=\"lowcontrast\" style=\"margin-top:18px\">\n" +
        "          <summary>自动决策摘要 · 过去 ${esc(windowLabel(t))}</summary>\n" +
        "          <div class=\"meta\" style=\"margin-top:8px\">${esc(strategyLine(t))}</div>\n" +
        "          ${notesHtml(t.notes)}\n" +
        "        </details>\n" +
        "\n" +
        "        <details class=\"lowcontrast\" style=\"margin-top:10px\">",
    ],
    // 复辟 = 左栏折叠区里出现 notesHtml(t.notes) ⇒ N2 那个源码级守门杀掉。
    expectRed: [N.sN2],
    expectGreen: [N.hdZero, N.ttSingle, N.cdFalse],
  },
  {
    label:
      "M6 eventRow 内联 target 接线撤掉 ⇒ 即使 eventTargetText 活着也永不显示 target",
    from: [
      '      ${eventTargetText(e.target) ? `<span class="tag mono">→ ${eventTargetText(e.target)}</span>` : ""}\n',
    ],
    to: ['      ${""}\n'],
    expectRed: [N.rowTarget, N.rowEsc, N.sN4],
    expectGreen: [N.ttSingle, N.hdIn, N.cdTrue],
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
  const r = spawnSync(process.execPath, [VITEST, "run", TEST_FILE], {
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
    "M0 一字不改 ⇒ " + TEST_FILE + " 全绿",
    control.green
      ? "全绿"
      : "意外红：" + control.names.join("、").slice(0, 500),
  ]);
  if (!control.green) throw new Error("控制组就红 ⇒ 后面每一发的「该红/该绿」都没有地基");

  for (const mut of MUTATIONS) {
    const before = readFileSync(join(ROOT, SRC), "utf8");
    const next = before.replace(anchor(before, mut.from), anchor(before, mut.to));
    // 变异【真改了字节】的断言：next === before 就是真空操作，当场停。
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

  // 收尾复核：还原后的源码上测试必须回到全绿（全绿的终态 = 证据成立的前提）。
  const after = runTests();
  results.push([
    after.green,
    "M9 全部还原后复跑 ⇒ " + TEST_FILE + " 回到全绿",
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
    "══════════ round341 前端三读数+两处死代码清理变异矩阵（写 app.js 真字节，逐发自回滚）══════════",
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
