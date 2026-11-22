/**
 * round340 变异机（web 侧）：回放时间线那三处欠账（决策 0052 / §16.7 / §22.3）。
 * 四发变异逐格验承重，照抄 round330-mut-web.mjs 的形状。
 *
 * ── 这台机器要回答的唯一问题 ──────────────────────────────────
 * 「加载更多」的判据 / 翻页游标 / 事件行意见原文 / 头卡汇报关系，
 * 四格各自由测试钉住，而【测试绿】对它们不证明 —— 每发变异都【真抹生产字节】：
 *   M1 分页判据短路成恒 false ⇒「加载更多」按钮永不出现（判据被写成
 *      `rawLen === 0` 那种打死结的版本）。
 *   M2 游标累加忘加当前 offset ⇒ 点「加载更多」每次都重拉第 1 页
 *      （翻页重复同一段，最像「没做分页」的那版实现）。
 *   M3 意见提取删掉（恒返 ""）⇒ 事件行永不显示审阅者/审批者的理由原文。
 *   M4 汇报关系整段不渲染 ⇒ 头卡只有 id·角色·图版本，欠账 ③ 的那一句消失。
 *
 * 每一发都【真抹生产字节】（packages/web/public/app.js），跑完逐字节还原并核对，
 * 且每发变异前后断言源码字符串【真的变了】（命中 0 次的真空操作会让那一发假绿）。
 *
 * ── 事前预测（写在跑之前，跑完不许改）─────────────────────────
 *   M0 控制组   ⇒ test/web 全绿（当前实测 208 通过，其中本轮的 18 发在里面）。
 *   M1 判据打死 ⇒ 该红：「一页拉满 ⇒ 可能还有更多」「一页不满 ⇒ 到底了」两发。
 *                 形态猜「形状不对按到底算」也红 —— 实测不红：
 *                 rawLen===0 恰好也让那三个形状输入都得到 false（取消这个预计，
 *                 见 N.shapeBottom 被删）。判据本身仍被杀（两发正向红）。
 *   M2 游标忘加 ⇒ 该红：「游标 = 当前 offset + 本页实际返回条数」一发（真正钉
 *                 offset 累加的那条；「输入非整数按 0 计」里的 next(200,null)
 *                 期望 200 而忘加 offset 的实现恰好给 200 ⇒ 不红，是形状盲区）。
 *   M3 意见恒空 ⇒ 该红：「review_decision 有 payload.note ⇒ 原样」、
 *                 「approval 有 state_snapshot.note ⇒ 显示为理由」、
 *                 「意见决定哪一款」「意见过 esc」四发。
 *   M4 汇报不渲 ⇒ 该红：「角色在图上」「reports_to===null=顶层」「键缺=不在图上」
 *                 「degraded=读不到」「不在图上不装没看见」「角色名/上级过 esc」六发。
 *
 * ⚠ 跑法（仓根）：npx tsx .workbuddy/round340-replay-mut.mjs
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
  fullPage: "一页拉满 ⇒ 可能还有更多",
  notFull: "一页不满 ⇒ 到底了（按钮该消失）",
  offsetSum: "游标 = 当前 offset + 本页【实际返回条数】",
  rdNote: "review_decision 有 payload.note ⇒ 原样",
  apNote: "approval 有 state_snapshot.note（decision_note 那条路）",
  family: "意见决定哪一款",
  escNote: "意见过 esc",
  noNote: "没有意见 ⇒ 空串",
  rtOnGraph: "角色在图上：dir ↖ 上级",
  rtTop: "reports_to === null = 顶层",
  rtMissing: "键缺 = 那一版图里没有这个角色",
  rtDegraded: "graph 是 degraded 块（ok:false）",
  rtEmpty: "没有报告 ⇒ 空串",
  rtGhost: "说「当时不在图上」不装没看见",
  rtEsc: "角色名与上级都过 esc",
};

const MUTATIONS = [
  {
    label: "M1 分页判据短路成恒 false ⇒「加载更多」永远不会出现",
    from: [
      "  return (\n" +
        "    Number.isInteger(rawLen) &&\n" +
        "    Number.isInteger(effectiveLimit) &&\n" +
        "    rawLen > 0 &&\n" +
        "    rawLen >= effectiveLimit\n" +
        "  );",
    ],
    to: ["  return rawLen === 0; // 变异：分页判据短路成恒 false"],
    expectRed: [N.fullPage, N.notFull],
    expectGreen: [N.offsetSum, N.rdNote, N.rtOnGraph],
  },
  {
    label: "M2 游标累加忘加当前 offset ⇒「加载更多」每次都重拉第 1 页",
    from: [
      "function replayNextOffset(rawLen, curOffset) {\n" +
        "  const n = Number.isInteger(rawLen) ? rawLen : 0;\n" +
        "  const c = Number.isInteger(curOffset) ? curOffset : 0;\n" +
        "  return c + n;\n" +
        "}",
    ],
    to: [
      "function replayNextOffset(rawLen, curOffset) {\n" +
        "  const n = Number.isInteger(rawLen) ? rawLen : 0;\n" +
        "  return n; // 变异：忘加当前 offset（每次都从第 0 条重拉）\n" +
        "}",
    ],
    expectRed: [N.offsetSum],
    expectGreen: [N.fullPage, N.rdNote, N.rtOnGraph],
  },
  {
    label: "M3 意见提取删掉（恒返空串）⇒ 事件行永不显示理由原文",
    from: [
      "function eventNoteText(e) {\n" +
        "  if (!e || typeof e !== \"object\") return \"\";\n" +
        "  const snap =\n" +
        "    e.state_snapshot && typeof e.state_snapshot === \"object\"\n" +
        "      ? e.state_snapshot.note\n" +
        "      : undefined;\n" +
        "  const fromSnapshot = typeof snap === \"string\" ? snap.trim() : \"\";\n" +
        "  const payloadNote =\n" +
        "    e.payload && typeof e.payload === \"object\"\n" +
        "      ? e.payload.note\n" +
        "      : undefined;\n" +
        "  const fromPayload = typeof payloadNote === \"string\" ? payloadNote.trim() : \"\";\n" +
        "  if (e.action === \"review_decision\") {\n" +
        "    return fromPayload;\n" +
        "  }\n" +
        "  if (e.action === \"approval\") {\n" +
        "    return fromSnapshot;\n" +
        "  }\n" +
        "  return \"\";\n" +
        "}",
    ],
    to: ["function eventNoteText(e) { return \"\"; } // 变异：意见提取删掉"],
    expectRed: [N.rdNote, N.apNote, N.family, N.escNote],
    expectGreen: [N.noNote, N.fullPage, N.rtOnGraph],
  },
  {
    label: "M4 汇报关系整段不渲染 ⇒ 头卡只有 id·角色·图版本",
    from: [
      "function replayReportsToHtml(graph, taskRole) {\n" +
        "  if (!graph) return \"\";\n" +
        "  if (graph.ok === false) {\n" +
        "    return ` · 汇报关系<b>读不到</b>（原本 v${esc(graph.version ?? \"?\")}：${esc(graph.reason ?? \"未给出原因\")}）`;\n" +
        "  }\n" +
        "  const rt = graph.reports_to;\n" +
        "  if (!rt || typeof rt !== \"object\") return \"\";\n" +
        "  const bits = [];\n" +
        "  if (taskRole && typeof taskRole === \"string\") {\n" +
        "    const parent = rt[taskRole];\n" +
        "    if (parent === undefined) {\n" +
        "      // 键不在 reports_to 里 ⇒ 这一版图里【没有这个角色】（reports_to 由图上每个节点的\n" +
        "      // reports_to 字段填成，graphSection 用的是 Object.keys(g.nodes)）。\n" +
        "      // 说查不到，不说它是顶层 —— 顶层是 reports_to===null 的表态，两句话不可混。\n" +
        "      bits.push(`${esc(taskRole)} 当时不在图上`);\n" +
        "    } else if (parent === null || parent === \"\") {\n" +
        "      // reports_to===null = 直接向 CEO 汇报（graph.ts:94 那张 nullable 单值；\n" +
        "      // 空串是防御 —— schema min(1) 不允许，但渲染层不假设上游一定折过）。\n" +
        "      bits.push(`${esc(taskRole)} → 顶层`);\n" +
        "    } else {\n" +
        "      bits.push(`${esc(taskRole)} ↖ ${esc(parent)}`);\n" +
        "    }\n" +
        "  }\n" +
        "  return bits.length ? ` · 汇报关系 ${bits.join(\"；\")}` : \"\";\n" +
        "}",
    ],
    to: ["function replayReportsToHtml(graph, taskRole) { return \"\"; } // 变异：汇报不渲染"],
    expectRed: [N.rtOnGraph, N.rtTop, N.rtMissing, N.rtDegraded, N.rtGhost, N.rtEsc],
    expectGreen: [N.rtEmpty, N.fullPage, N.rdNote],
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
  console.log("══════════ round340 回放时间线三处欠账变异矩阵（写 app.js 真字节，逐发自回滚）══════════");
  for (const [isHit, label, msg] of results) {
    ok += isHit ? 1 : 0;
    console.log((isHit ? "✓ " : "✗ ") + label + "\n      | " + msg);
  }
  const want = MUTATIONS.length + 2; // + M0 控制 + M9 还原复核
  console.log(
    "命中 " + ok + " / " + results.length + "（分母 = " + MUTATIONS.length + " 发变异 + 控制组 + 还原复核）",
  );
  process.exitCode = ok === results.length && results.length === want ? 0 : 1;
}
