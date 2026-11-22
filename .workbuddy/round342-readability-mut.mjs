/**
 * round342 变异机（web 侧，可读性三件套）：
 * ① 审批卡已决明细 decidedMetaHtml（decided_at/by/note，contracts/api.ts:500-503）；
 * ② policy_shadow.note 显式 policyNoteHtml（query.ts:271 例）；
 * ③ evidence_refs 可点开 evidenceRefsHtml（路径/sha256 逐条 `<code>`）。
 * 照 round341-frontend-mut.mjs 的形状：读文件→字节级变异→写回→跑目标测试→
 * 记录命中数→恢复原内容→逐字节核对+打印 reverted: true。
 *
 * ── 这台机器要回答的唯一问题 ──────────────────────────────────
 * 三处新读数的展示半各自由测试钉住，而【测试绿】对它们不证明 —— 每发变异都
 * 【真抹生产字节】：
 *  M1 loadSnapshot 里 decidedMetaHtml 接线撤掉 ⇒ 已决明细永不显示（纯函数活着
 *     但没人叫它）。
 *  M2 decidedMetaHtml 恒返空串 ⇒ 即使接线在，pending 之外的已决详情也没了。
 *  M3 policyNoteHtml 恒返空串 ⇒ 规则依据永不显示（坏的方向是静默变旧）。
 *  M4 policyShadowLine 里 policyNoteHtml(s.note) 撤掉 ⇒ 接线断（纯函数活着
 *     也白搭，回到「只列 blocked_by 不列理由」）。
 *  M5 evidenceRefsHtml 恒返旧文案「N 条引用」⇒ cursor 没了、逐条原文不显示。
 *  M6 evidenceRefsHtml 不 esc ⇒ esc 守门破（注入恢复，esc 测试们抗议）。
 *
 * 每一发都【真抹生产字节】（packages/web/public/app.js），跑完逐字节还原并核对
 * next !== before，且每发变异前后断言源码字符串【真的变了】。
 *
 * ⚠ 跑法（仓根）：npx tsx .workbuddy/round342-readability-mut.mjs
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
  dmPending: "pending（decided_at 为 null",
  dmNote: "已决 + 有理由",
  dmNoNote: "已决但理由空缺",
  dmNoBy: "decided_by 缺",
  dmEsc: "decision_note 过 esc",
  n5Guard: "N5 参数快照渲染接上 decidedMetaHtml",
  n6Guard: "N6 缓存带整份 approval",
  n7Guard: "N7 policyShadowLine 转人工分支接上 policyNoteHtml",
  pnNone: "无 note（undefined / null",
  pnNote: "有 note ⇒ 原文",
  pnEsc: "note 过 esc",
  slNote: "转人工 + note",
  slAuto: "auto_approved 分支【不】加 note",
  slMiss: "note 缺失 ⇒ 转人工分支照旧",
  erNull: "null / undefined / []",
  erList: "非空 ⇒ N 条 + 逐条",
  erEsc: "逐条过 esc（防注入守门）",
  elList: "非空数组 ⇒ `<details>` 可点开",
  elEsc: "逐条过 esc（refs 是库内路径",
  elCard: "证据行嵌进卡片",
};

const MUTATIONS = [
  {
    label:
      "M1 loadSnapshot 里 decidedMetaHtml 两处接线全撤 ⇒ 审批卡已决明细永不显示（接线断）",
    from: [
      "      paramSnapshotHtml(st?.parameters ?? null) + decidedMetaHtml(st);",
      "  slot.innerHTML = paramSnapshotHtml(params) + decidedMetaHtml(data?.approval);",
    ],
    to: [
      "      paramSnapshotHtml(st?.parameters ?? null); // 变异：已决明细接线撤了",
      "  slot.innerHTML = paramSnapshotHtml(params); // 变异：已决明细接线撤了",
    ],
    expectRed: [N.n5Guard],
    expectGreen: [N.dmNote, N.n6Guard, N.pnNote, N.erList],
  },
  {
    label: "M2 decidedMetaHtml 恒返空串 ⇒ 已决且带理由的卡也说成『已决 · 空』",
    from: [
      "function decidedMetaHtml(approval) {\n" +
        "  const at = approval?.decided_at;\n" +
        "  if (at === null || at === undefined) return \"\";\n" +
        "  const who = approval?.decided_by ?? \"—\";\n" +
        "  const note = approval?.decision_note;\n" +
        "  const why = note ? ` · 理由：${esc(note)}` : \"\";\n" +
        "  return `已决 · ${esc(fmtDate(at))} · ${esc(who)}${why}`;\n" +
        "}",
    ],
    to: [
      "function decidedMetaHtml(approval) { return ''; } // 变异：恒空（pending 判据没了）",
    ],
    expectRed: [N.dmNote, N.dmNoNote, N.dmNoBy, N.dmEsc],
    expectGreen: [N.dmPending, N.pnNote, N.erList],
  },
  {
    label: "M3 policyNoteHtml 恒返空串 ⇒ 规则依据永不显示（静默变旧）",
    from: [
      "function policyNoteHtml(note) {\n" +
        "  if (note === null || note === undefined || note === \"\") return \"\";\n" +
        "  return `<span class=\"meta\">规则依据：${esc(note)}</span>`;\n" +
        "}",
    ],
    to: ["function policyNoteHtml(note) { return ''; } // 变异：恒空"],
    expectRed: [N.pnNote, N.pnEsc, N.slNote],
    expectGreen: [N.pnNone, N.dmNote, N.erList],
  },
  {
    label:
      "M4 policyShadowLine 里 policyNoteHtml(s.note) 撤掉 ⇒ 接线断（回到只列 blocked_by 不列理由）",
    from: [
      "`规则判：转人工（${esc(s.blocked_by)}${s.missing.length > 0 ? \" · 缺 \" + esc(s.missing.join(\"、\")) : \"\"}）${policyNoteHtml(s.note)}`;",
    ],
    to: [
      "`规则判：转人工（${esc(s.blocked_by)}${s.missing.length > 0 ? \" · 缺 \" + esc(s.missing.join(\"、\")) : \"\"}）`; // 变异：note 接线撤了",
    ],
    expectRed: [N.n7Guard, N.slNote],
    expectGreen: [N.slMiss, N.pnNote, N.dmNote],
  },
  {
    label: "M5 evidenceRefsHtml 恒返旧文案「N 条引用」⇒ 逐条原文/`<details>` 消失",
    from: [
      "function evidenceRefsHtml(refs) {\n" +
        "  if (refs === null || refs === undefined || refs.length === 0) return \"\";\n" +
        "  const items = refs\n" +
        "    .map((r) => `<div class=\"mono\"><code>${esc(r)}</code></div>`)\n" +
        "    .join(\"\");\n" +
        "  return `<details><summary>证据 ${refs.length} 条</summary>${items}</details>`;\n" +
        "}",
    ],
    to: [
      "function evidenceRefsHtml(refs) { // 变异：退回旧文案，N 条引用不展开\n" +
        "  if (refs === null || refs === undefined || refs.length === 0) return \"\";\n" +
        "  return `证据 ${refs.length} 条引用`;\n" +
        "}",
    ],
    expectRed: [N.erList, N.erEsc, N.elList, N.elCard],
    expectGreen: [N.erNull, N.dmNote, N.pnNote],
  },
  {
    label: "M6 evidenceRefsHtml 不 esc ⇒ 注入恢复（esc 守门破）",
    from: [
      "function evidenceRefsHtml(refs) {\n" +
        "  if (refs === null || refs === undefined || refs.length === 0) return \"\";\n" +
        "  const items = refs\n" +
        "    .map((r) => `<div class=\"mono\"><code>${esc(r)}</code></div>`)\n" +
        "    .join(\"\");",
    ],
    to: [
      "function evidenceRefsHtml(refs) {\n" +
        "  if (refs === null || refs === undefined || refs.length === 0) return \"\";\n" +
        "  const items = refs\n" +
        "    .map((r) => `<div class=\"mono\"><code>${r}</code></div>`) // 变异：esc 摘掉\n" +
        "    .join(\"\");",
    ],
    expectRed: [N.erEsc, N.elEsc],
    expectGreen: [N.erList, N.dmNote, N.slNote],
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
    "M0 一字不改 ⇒ " + TEST_FILE + " 全绿",
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
    "══════════ round342 前端可读性三件套变异矩阵（写 app.js 真字节，逐发自回滚）══════════",
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
