/**
 * round330 变异机（web 侧）：§9.4 批量选择集的两格判据，逐格验承重。
 *
 * ── 这台机器要回答的唯一问题 ──────────────────────────────────
 * 「前端只做选择集」这句话由两格纯函数判据撑着，而【测试绿】对它们不证明：
 *   M1 「非 pending 剔除」    —— 抹掉后：已决定的卡会被混进批量请求体。
 *   M2 「note 空白 ⇒ 省略键」 —— 恒带空 note 后：契约里 note 是可选键，
 *        approve 也带 note:"" 出网，等于前端替服务端改写了请求形状。
 *   M3 勾选框不再只给 pending —— 已决定的卡能被勾进批量。M1 是提交侧那道剔除，
 *        M3 是渲染侧那道；两处代码分开打，只验其一会让另一处的消失变成静默的。
 *
 * ⚠ 本轮【删掉】了 batchTypeCheck（客户端类型预检），所以这台机器里【没有】它那一发；
 *   删它的理由与「为什么这里不该有一条类型判据」都写在 app.js 那一节的注释里。
 * 每一发都【真抹生产字节】（packages/web/public/app.js），跑完逐字节还原并核对，
 * 且每发变异前后断言源码字符串【真的变了】（命中 0 次的真空操作会让那一发假绿）。
 *
 * ── 事前预测（写在跑之前，跑完不许改）─────────────────────────
 *   M0 控制组   ⇒ test/web 全绿（当前实测 119 通过）。
 *   M1 不剔除   ⇒ 该红：「选中里的非 pending 卡被剔除」一发。
 *                 预测【只有这一族红】：types 齐一那发用的卡片全 pending，不沾这格。
 *   M2 恒带空 note ⇒ 该红：「note 为空 ⇒ 根本没有 note 这个键」与
 *                 「空选择 ⇒ approval_ids: []」两发（后者用 toEqual 精确钉住了请求体形状，
 *                 恒带 note:"" 会把它一起顶红 —— 这是形状断言的复利，不是意外）。
 *   M3 勾选框放开 ⇒ 该红：「已决定的卡没有勾选框」一发。
 *                 预测【只有这一族红】：M1 的剔除是提交侧，渲染侧放开不惊动它；
 *                 M2 的形状断言也不沾渲染。这发的价值是证明【入口】本身被测试钉住
 *                 —— 若 M3 全绿，说明"勾选框只给 pending"只是注释，没有任何测试在管。
 *
 * ⚠ 跑法（仓根）：npx tsx .workbuddy/round330-mut-web.mjs
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
  dropPending: "选中里的非 pending 卡被剔除",
  noteKeyAbsent: "note 这个键（契约里它是可选键",
  emptySelection: "空选择 ⇒ approval_ids: []",
  noCheckbox: "已决定的卡没有勾选框",
};

const MUTATIONS = [
  {
    label: "M1 「非 pending 剔除」抹掉 ⇒ 已决定的卡混进批量请求体",
    from: ["  return list.filter((a) => a && picked.has(a.id) && a.status === \"pending\");"],
    to: ["  return list.filter((a) => a && picked.has(a.id)); // 变异：非 pending 不剔除"],
    expectRed: [N.dropPending],
    expectGreen: [N.noteKeyAbsent, N.emptySelection],
  },
  {
    label: "M2 note 省略改成恒带 ⇒ approve 也带着空 note 出网，请求形状被前端改写",
    from: ["  return { approval_ids, resume, ...(trimmed ? { note: trimmed } : {}) };"],
    to: ["  return { approval_ids, resume, note: trimmed }; // 变异：恒带 note"],
    expectRed: [N.noteKeyAbsent, N.emptySelection],
    expectGreen: [],
  },
  {
    label: "M3 勾选框放开给已决定卡 ⇒ 已决定的卡也能勾进批量（入口还在，剔除被藏进提交路径）",
    from: [
      "      ${decided ? \"\" : `<label class=\"meta\" style=\"display:flex;align-items:center;gap:4px\"><input type=\"checkbox\" data-batch-pick=\"${esc(a.id)}\" />批量</label>`}",
    ],
    to: [
      "      <label class=\"meta\" style=\"display:flex;align-items:center;gap:4px\"><input type=\"checkbox\" data-batch-pick=\"${esc(a.id)}\" />批量</label>",
    ],
    expectRed: [N.noCheckbox],
    expectGreen: [N.dropPending, N.noteKeyAbsent, N.emptySelection],
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
  console.log("══════════ round330 批量选择集变异矩阵（写 app.js 真字节，逐发自回滚）══════════");
  for (const [isHit, label, msg] of results) {
    ok += isHit ? 1 : 0;
    console.log((isHit ? "✓ " : "✗ ") + label + "\n      | " + msg);
  }
  const want = MUTATIONS.length + 2; // + M0 控制 + M9 还原复核
  console.log("命中 " + ok + " / " + results.length + "（分母 = " + MUTATIONS.length + " 发变异 + 控制组 + 还原复核）");
  process.exitCode = ok === results.length && results.length === want ? 0 : 1;
}
