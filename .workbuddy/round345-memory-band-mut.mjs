/**
 * round345 变异机（web 侧）：memoryBandHtml —— GET /today 的 memory 三数
 * （0060 §8 补上的界面半）。这台机器要回答的唯一问题：界面那一小块【真承重】，
 * 不是"函数在、测试绿"的装饰。照 round341-frontend-mut.mjs 的形状：
 * 读文件→字节级变异→写回→跑目标测试→记命中→逐字节还原并核对 next !== before。
 *
 * ── 每一发变异都真抹生产字节 ──────────────────────────────────
 *   M1 memoryBandHtml 恒返空串 ⇒ 记忆三数在界面上永远看不见。
 *   M2 未署名那两行删掉（只报条数）⇒「有判定而没署上名」在屏幕上消失。
 *   M3 空档那行「在等它的生产者」删掉 ⇒ 审阅判定空时屏幕上只剩一句「空的」，
 *      把「缺生产者」读成「角色没做过决定」。
 *   M4 renderToday 接线撤掉（memoryBandHtml(t.memory) 删掉）⇒ 纯函数活着也白搭，
 *      响应的三数没有任何消费者（这正是 0060 §8 修的「发了没人读」）。
 *   M5 形状防御那一支删掉（m 非法时直接拼）⇒ 老服务端没发 memory 时页面崩。
 *   M0 控制组 ⇒ test/web/app-pure.test.ts 全绿。
 *   M9 全部还原后复跑 ⇒ 回到全绿。
 *
 * ⚠ 跑法（仓根）：npx tsx .workbuddy/round345-memory-band-mut.mjs
 *   这台机器写真字节 ⇒ 单独跑，不与任何测试并发。
 *   读红绿：vitest 退出码 + 失败测试名，不 grep 汇总数字。
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
  regular: "审阅判定有数据",
  allZero: "三数全 0",
  emptyBand: "审阅判定空而其它记忆有数据",
  defShape: "非数/缺失形状防御",
  esc: "数是自由文本",
  wiring: "接线", // renderToday 里的 ${memoryBandHtml(t.memory)}
  loader: "EXPORTS", // 取不到函数 ⇒ 装载器红
};

const MUTATIONS = [
  {
    label: "M1 memoryBandHtml 恒返空串 ⇒ 记忆三数在界面上永远看不见（0060 §8 原位回退）",
    from: [
      "function memoryBandHtml(m) {\n" +
        '  if (!m || typeof m !== "object") return "";\n' +
        '  const n0 = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);\n',
    ],
    to: [
      "function memoryBandHtml(m) {\n" +
        '  if (true) return "";\n' +
        '  const n0 = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);\n',
    ],
    expectRed: [N.regular, N.emptyBand, N.esc],
    expectGreen: [N.allZero, N.defShape],
  },
  {
    label: "M2 未署名那两行删掉 ⇒「有判定而没署上名」在屏幕上消失",
    from: [
      '  if (unatt > 0) {\n' +
        "    body +=\n" +
        '      \'<div class="meta" style="margin-top:6px">· 那 \' +\n' +
        '      `${esc(unatt)} 条按 actor_id 分桶，所以【不会】进任何角色的提示词。` +\n' +
        '      "不是「没人做过判定」，是做过而没署上名。</div>";\n' +
        "  }\n",
    ],
    to: ["  // 变异：未署名那两行删掉\n"],
    expectRed: [N.regular],
    expectGreen: [N.allZero, N.emptyBand, N.esc],
  },
  {
    label: "M3 空档那行「在等它的生产者」删掉 ⇒「缺生产者」被读成「角色没做过决定」",
    from: [
      "    body +=\n" +
        '      \'<div class="meta" style="margin-top:6px">· 审阅判定那一档是【空的】（库里另有 \' +\n' +
        '      `${esc(scope)} 条其它记忆口径的审计，它们不是审阅判定）。` +\n' +
        '      \'规格 §24 风险 2 要的是「历史审阅决定与理由」⇒ 这一档在等它的生产者，不是「角色还没做过决定」。</div>\';\n',
    ],
    to: [
      "    body +=\n" +
        '      \'<div class="meta" style="margin-top:6px">· 审阅判定那一档是【空的】。</div>\';\n',
    ],
    expectRed: [N.emptyBand],
    expectGreen: [N.regular, N.allZero, N.esc],
  },
  {
    label: "M4 renderToday 接线撤掉 ⇒ 响应的 memory 三数没有任何消费者（0060 §8 原位）",
    from: [
      '        ${budgetHtml(t)}\n' +
        "        ${memoryBandHtml(t.memory)}\n" +
        "        ${notesHtml(t.notes)}\n",
    ],
    to: [
      '        ${budgetHtml(t)}\n' +
        "        ${notesHtml(t.notes)}\n",
    ],
    // renderToday 碰 DOM，不在 app-pure 纯函数射程内 ⇒ 这一发由 renderer-criteria
    // 新加的「memory band 真的接在 renderToday 里」守门杀掉（源码扫接线形状）。
    // 这里跑 app-pure 只验证【接线断开时其它用例不红】；真正的红在渲染守门里。
    expectRed: [N.wiring], // 期望红在 renderer-criteria；下面 runTests 跑两文件
    expectGreen: [N.allZero],
  },
  {
    label: "M5 形状防御那一支删掉 ⇒ 老服务端没发 memory 时页面崩",
    from: [
      "function memoryBandHtml(m) {\n" +
        '  if (!m || typeof m !== "object") return "";\n',
    ],
    to: [
      "function memoryBandHtml(m) {\n" +
        "  // 变异：形状防御删掉（直接读 m.scope_rows）\n",
    ],
    // 形状防御那一行同时守两件事：非对象（defShape）与 undefined（「三数全 0」测试里
    // 的 band(undefined) 分支 —— 注释原话「老服务端没发 memory 字段 ⇒ 同样静默」）。
    // 整行删掉 ⇒ 两个都崩，都红得正当（首次跑就抓到这个预期划分错误）。
    expectRed: [N.defShape, N.allZero],
    expectGreen: [N.regular, N.esc],
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
  // M4 的红在 renderer-criteria（源码守门）⇒ 两个文件都跑，其余变异不看它会不会顺带红。
  const r = spawnSync(
    process.execPath,
    [VITEST, "run", "test/web/app-pure.test.ts", "test/web/renderer-criteria.test.ts"],
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
    "══════════ round345 记忆三数界面半变异矩阵（写 app.js 真字节，逐发自回滚）══════════",
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
