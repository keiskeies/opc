/**
 * round304 变异机：`diffTypeBaseline` 新加的那句「病灶」尾巴到底承不承重。
 *
 * 为什么必须有它：本轮那条改动【只改红话，不改判定】——「测试绿」对这种改动
 * 一点价值都没有（判据没动，旧断言当然全绿）。能证明它做了事的只有一件事：
 * 把尾巴【无条件拼】与【永不拼】两种写法打上去，各有一发红、各有一发绿。
 * 特别是 M1 —— 它证的正是本轮新加的那发【反向对照】在做事：
 * 无条件拼尾巴会让真新目录也被指成 include 事故（处置动作相反），
 * 那一发必须红，否则「反向对照」是我写在注释里的愿望而不是测试。
 *
 * ⚠ 这台【写真字节】（test/arch/test-type-baseline.ts，那是守卫自己），逐发跑完
 *   立刻按原文回写并逐字节核对 ⇒ 单独跑，不许并发（round292 (b) 那条）。
 *   读红绿：vitest 的退出码 + reporter 的【测试名】，不 grep 数字（round301 §⑦③）。
 *
 * 跑法：node .workbuddy/round304-mutate-message.mjs
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const REL = "test/arch/test-type-baseline.ts";
const path = join(ROOT, REL);
const TEST = "test/arch/test-type-baseline.test.ts";

/** 两句测试名的子串：甲 = 真新目录那一发（带反向对照），乙 = 仓外形状那一发。 */
const JIA = "冒出基线外的新测试目录";
const YI = "仓外形状的那格";

const MUTATIONS = [
  {
    label: "M1 尾巴改成【无条件拼】⇒ 甲必须红（真新目录被指成 include 事故）",
    from: "    if (outsideCount === 0) return base;",
    to: "    // 变异：不区分两类，尾巴谁都拼",
    expectRed: [JIA],
    expectGreen: [YI],
  },
  {
    label: "M2 尾巴【永不拼】= 回到 round300 残留② 那一版 ⇒ 乙必须红",
    from: "    if (outsideCount === 0) return base;",
    to: "    return base; // 变异：残留② 那一版（两类事同一副面孔）",
    expectRed: [YI],
    expectGreen: [JIA],
  },
  {
    label: "M3 仓外计数改成【数所有未登记格】⇒ 乙里那句「只数仓外」必须红",
    from: "      if (isOutsideRepo(dir, dir)) outsideCount++;",
    to: "      outsideCount++; // 变异：不辨形状，有未登记就算仓外",
    expectRed: [YI],
    expectGreen: [],
  },
];

const orig = readFileSync(path, "utf8");

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
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", TEST],
    { cwd: ROOT, encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 },
  );
  const out = String(r.stdout) + String(r.stderr);
  return { green: r.status === 0, names: failedTests(out), out };
}

/**
 * 锚点先全验一遍：任一失配就【一发不发】。
 * 理由同 round293：锚点命中 0 次的变异是【真空操作】，它会让那一发「按预期绿」，
 * 于是假绿来自机器自己，而不是来自判据。
 */
function preflight() {
  const bad = [];
  for (const mut of MUTATIONS) {
    if (mut.from === mut.to) bad.push(mut.label + " 是真空操作（from === to）");
    const n = orig.split(mut.from).length - 1;
    if (n !== 1) bad.push("锚点命中 " + n + " 次（要恰好 1）：" + mut.from.slice(0, 60));
  }
  if (bad.length > 0) throw new Error("锚点校验失败，一发不发：\n  " + bad.join("\n  "));
}

const results = [];
let fatal = "";
try {
  preflight();
  const m0 = runTests();
  results.push([
    m0.green,
    "M0 一字不改 ⇒ 该文件全绿",
    m0.green ? "全绿" : "意外红：" + m0.names.join("、").slice(0, 400),
  ]);
  if (!m0.green) throw new Error("控制组就红 ⇒ 后面每一发的「该红/该绿」都没有地基");

  for (const mut of MUTATIONS) {
    writeFileSync(path, orig.replace(mut.from, mut.to), "utf8");
    let got;
    try {
      got = runTests();
    } finally {
      writeFileSync(path, orig, "utf8");
      if (readFileSync(path, "utf8") !== orig) {
        throw new Error("回滚后字节对不上，立刻去 git 核对：" + REL);
      }
    }
    const hit = (needle) => got.names.some((x) => x.includes(needle));
    const problems = [];
    if (got.green) problems.push("【全绿】⇒ 这一格不承重（或者锚点没抹到）");
    for (const w of mut.expectRed) if (!hit(w)) problems.push("该红的没红：" + w);
    for (const w of mut.expectGreen) if (hit(w)) problems.push("不该红的红了：" + w);
    results.push([
      problems.length === 0,
      mut.label,
      problems.length === 0
        ? "红的落点正是：" + got.names.join("、").slice(0, 700)
        : problems.join("；") + " ｜实红：" + got.names.join("、").slice(0, 700),
    ]);
  }
} catch (err) {
  fatal = String(err instanceof Error ? err.message : err);
} finally {
  writeFileSync(path, orig, "utf8");
  if (readFileSync(path, "utf8") !== orig) {
    console.error("【致命】收尾回滚失败，立刻去 git 核对：" + REL);
    process.exitCode = 1;
  }
}

if (fatal !== "") {
  console.error("【整台机器停摆，不出命中数】" + fatal);
  process.exitCode = 1;
} else {
  let ok = 0;
  console.log("══════════ round304 红话尾巴变异矩阵（写守卫真字节，逐发自回滚）══════════");
  for (const [isHit, label, msg] of results) {
    ok += isHit ? 1 : 0;
    console.log((isHit ? "✓ " : "✗ ") + label + "\n      | " + msg);
  }
  const want = MUTATIONS.length + 1;
  console.log(
    "命中 " + ok + " / " + results.length +
      "（分母 = " + MUTATIONS.length + " 发变异 + 1 发控制组，数出来的）",
  );
  process.exitCode = ok === results.length && results.length === want ? 0 : 1;
}
