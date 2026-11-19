/**
 * round330 变异机（hub note 侧）：0061 §8.3「建卡 note 与拦门判定同源、无守卫」那格。
 *
 * ── 这台机器要回答的唯一问题 ──────────────────────────────────
 * dispatch.test.ts 新加的那发 ⇔ 守卫（note 声称「已建卡」⟺ 该输入在声明式建卡表里）
 * 有没有牙齿。三种失效方向各打一发，全打在【真发生故障的那个面】= dispatch.ts 的
 * planEdge 分支字节上：
 *   M1 真实现消失（改词）  —— 抹掉越权交接那支的「已建卡」⇒ 该声称的格子不再声称。
 *   M2 真实现消失（改词）  —— 抹掉同源审阅那支的「已建卡」⇒ 同上，另一格。
 *   M3 新增分支没登记      —— 给 wait 那支加上「（已建卡）」⇒ 表外格子开始声称，
 *        这正是 0061 §8.3 预言的「第三种情形出现时 note 会重新变假话而没人发现」。
 *
 * ⚠ M3 的落点选 wait 而不是 d===null / failure：那两支在 ⇔ 矩阵的输入形状里
 *   【不可达】（矩阵永远带着一个可判定的 decision），打在那里的变异是【测不到的真空】。
 *   选锚点之前先确认它在矩阵里可达 —— 这一条本身就是本轮记下的教训。
 *
 * ── 事前预测（写在跑之前，跑完不许改）─────────────────────────
 *   M0 控制组 ⇒ dispatch.test.ts 全绿（当前实测 83 通过）。
 *   M1/M2/M3 ⇒ 该红【恰好各一发】：新加的那发 ⇔ 守卫。
 *     M1/M2 红在「该声称的没声称」那一侧，M3 红在「表外格子声称了」那一侧，
 *     三个方向共用同一条断言 —— 这正是 ⇔ 形状买到的东西。
 *
 * ⚠ 跑法（仓根）：npx tsx .workbuddy/round330-mut-note.mjs
 *   这台机器写真字节 ⇒ 单独跑，不与任何测试并发（round292 (b)）。
 *   读红绿：vitest 退出码 + 失败【测试名】，不 grep 汇总数字（round301 §⑦③）。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");
const SRC = "packages/hub/src/engine/dispatch.ts";
const TESTS = ["packages/hub/test/engine/dispatch.test.ts"];

/** 那条 ⇔ 守卫的测试名子串（不随标题标点漂移）。 */
const GUARD = "有卡可建的那两种判定";

const MUTATIONS = [
  {
    label: "M1 越权交接那支抹掉「已建卡」⇒ 该声称的格子不再声称",
    from: ['    return stay(o.blockedHandoff + "（已建卡，等你裁决）");'],
    to: ['    return stay(o.blockedHandoff + "（等你裁决）"); // 变异：抹掉建卡声称'],
    expectRed: [GUARD],
    expectGreen: [],
  },
  {
    label: "M2 同源审阅那支抹掉「已建卡」⇒ 另一格同样不再声称",
    from: ['    return stay(o.review.reason + "（已建卡）");'],
    to: ['    return stay(o.review.reason); // 变异：抹掉建卡声称'],
    expectRed: [GUARD],
    expectGreen: [],
  },
  {
    label: "M3 wait 那支凭空加上「已建卡」⇒ 表外格子声称建了根本没建的卡（0061 预言的第三种情形）",
    from: ['  if (d.action === "wait") return stay(d.summary);'],
    to: ['  if (d.action === "wait") return stay(d.summary + "（已建卡）"); // 变异：没建卡也声称'],
    expectRed: [GUARD],
    expectGreen: [],
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
    "M0 一字不改 ⇒ dispatch.test.ts 全绿",
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
    "M9 全部还原后复跑 ⇒ dispatch.test.ts 回到全绿",
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
  console.log("══════════ round330 note 侧同源守卫变异矩阵（写 dispatch.ts 真字节，逐发自回滚）══════════");
  for (const [isHit, label, msg] of results) {
    ok += isHit ? 1 : 0;
    console.log((isHit ? "✓ " : "✗ ") + label + "\n      | " + msg);
  }
  const want = MUTATIONS.length + 2; // + M0 控制 + M9 还原复核
  console.log("命中 " + ok + " / " + results.length + "（分母 = " + MUTATIONS.length + " 发变异 + 控制组 + 还原复核）");
  process.exitCode = ok === results.length && results.length === want ? 0 : 1;
}
