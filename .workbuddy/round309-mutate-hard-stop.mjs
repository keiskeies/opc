/**
 * round309 变异机：`budgets.hard_stop` 那位【新读方】到底承不承重。
 *
 * ── 这台机器要回答的唯一问题 ──────────────────────────────────
 * O7 动作 3 落地之后，「门现在读 hard_stop」这句话由四格撑着，而【测试绿】一句都不证明：
 *   · 那半个 OR 分支其实不在（= 改前的形状）
 *   · 方向写反（= 1 时放行）
 *   · 最外层括号被摘（SQLite 里 AND 比 OR 紧，整条 WHERE 被劈开）
 *   · 缺省值那一格（推演过：它【不承重】，见 M4）
 * 每一发都【真抹生产字节】再跑一遍，跑完立刻逐字节回滚并核对。
 *
 * ── 事前预测（写在这台机器跑【之前】，跑完不许改）────────────────
 * ⚠ 按本仓家规，预测先落纸；事后照着实测补的「预期」不是预测，是抄答案。
 *   M0 控制组        ⇒ 四个文件全绿。
 *   M1 抹掉整个 OR 分支（hard_stop 读方消失）
 *                    ⇒ hard-stop-gate 里凡是【期望放行】的都红：hard_stop=0 那发、
 *                      真起子进程那发、只差 hard_stop 的对照、括号那发的第二断言、
 *                      互补那发、驱动器那发、看板那发。
 *                      该绿的：分母（hard_stop=1）、无预算行、绑参个数。
 *   M1b 【同一变异】而只跑【旧】测试（charter-pump / driver-pump / driver-status）
 *                    ⇒ 预测【一条都不红】。这一发不是测判据，是测【旧账的射程】：
 *                      M1 之后源码逐字等于改前，而改前那 120 发全绿 ——
 *                      它就是「hard_stop 有读者吗」这件事【以前机器看不见】的证据，
 *                      也是新文件不是把旧测试搬一遍的证明。
 *   M2 方向翻向（`= 0` → `= 1`）
 *                    ⇒ 两头的期望【同时倒过来】：分母那发（原本期望被挡）也红。
 *                      无预算行那发该绿（前半 0 < limit 恒真，缺省不参与）。
 *   M3 摘掉最外层括号
 *                    ⇒ 预测【只有括号那一发红】。这不是凑数，是这一族最该被看见的读数：
 *                      hard_stop=0 / 对照 / 互补 / 驱动器 / 看板 五发【全绿】，
 *                      因为它们的数据形状让两种结合方式给出同一个答案。
 *                      ⇒ 「现有那几条写得挺全」对这一型改动是【误读】。
 *   M4 缺省 1 → 0    ⇒ 预测【全绿】，而且这条绿是【结论不是失败】：
 *                      无预算行时前半 `COALESCE(consumed,0) < ?` 恒真（上限是必填正整数），
 *                      所以那一格读 1 还是 0 都放行 ⇒ COALESCE 的那个 1 今天【不承重】。
 *                      留着的理由是方向：哪天门改成"没配预算就不许花"，它是那条语义的载体。
 *                      ⚠ 这一条是【我先推演再跑】的，如果实测红了，说明推演错了，
 *                        按台账规矩把预测原样留着、把实测写在旁边。
 *
 * ⚠ 这台【写真字节】（packages/hub/src/serve/charter-pump.ts），逐发跑完立刻按原文
 *   回写并逐字节核对 ⇒ 单独跑，不许与任何测试并发。
 *   读红绿：vitest 退出码 + reporter 的【测试名】，不 grep 数字。
 *
 * 跑法：node .workbuddy/round309-mutate-hard-stop.mjs
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");

const SRC = "packages/hub/src/serve/charter-pump.ts";
const T = {
  gate: "packages/hub/test/budget/hard-stop-gate.test.ts",
  old: [
    "packages/hub/test/serve/charter-pump.test.ts",
    "packages/hub/test/serve/driver-pump.test.ts",
    "packages/hub/test/overview/driver-status.test.ts",
  ],
};

/** it 标题的子串（够认出哪一发，且不随标题里的标点漂移）。 */
const N = {
  denom: "超预算 + hard_stop=1",
  off: "超预算 + hard_stop=0",
  spawn: "起草发生、钱真花出去",
  pair: "只差 hard_stop",
  noRow: "照旧放行（缺省读成 1",
  paren: "状态根本不该被驱动",
  mirror: "两档恰好互补",
  driver: "驱动器那一支同样读 hard_stop",
  board: "看板那一格",
  param: "不许偷加绑参",
};

/** 谓词本体的三段（盘上是 CRLF，锚点按行数组拼，见 eolOf）。 */
const OPEN = '    "(COALESCE((SELECT b.consumed_cents FROM budgets b " +';
const TAIL = '    ".id AND b.period = \'per_task\'), 1) = 0)"';
const HARD_LINE = '    " OR COALESCE((SELECT b.hard_stop FROM budgets b " +';

const MUTATIONS = [
  {
    label: "M1 抹掉整个 OR 分支（hard_stop 读方消失）⇒ 新文件该成片红",
    file: SRC,
    // 把尾巴那段的 hard_stop 半截整块删掉，并把开头的左括号与结尾的右括号一起摘掉
    // （否则剩下的是一个合法但语义不同的括号式子，测的就不是"读方消失"）。
    from: [
      OPEN,
      '    "WHERE b.scope_type = \'task\' AND b.scope_id = " +',
      "    t +",
      '    ".id AND b.period = \'per_task\'), 0) < ?" +',
      HARD_LINE,
      '    "WHERE b.scope_type = \'task\' AND b.scope_id = " +',
      "    t +",
      TAIL,
    ],
    to: ['    "COALESCE((SELECT b.consumed_cents FROM budgets b " +', '    "WHERE b.scope_type = \'task\' AND b.scope_id = " +', "    t +", '    ".id AND b.period = \'per_task\'), 0) < ?"'],
    tests: [T.gate],
    expectRed: [N.off, N.spawn, N.pair, N.paren, N.mirror, N.driver, N.board],
    expectGreen: [N.denom, N.noRow, N.param],
  },
  {
    label: "M1b 【同一变异】只跑旧测试 ⇒ 预测一条都不红（旧账对 hard_stop 无射程）",
    file: SRC,
    from: [
      OPEN,
      '    "WHERE b.scope_type = \'task\' AND b.scope_id = " +',
      "    t +",
      '    ".id AND b.period = \'per_task\'), 0) < ?" +',
      HARD_LINE,
      '    "WHERE b.scope_type = \'task\' AND b.scope_id = " +',
      "    t +",
      TAIL,
    ],
    to: ['    "COALESCE((SELECT b.consumed_cents FROM budgets b " +', '    "WHERE b.scope_type = \'task\' AND b.scope_id = " +', "    t +", '    ".id AND b.period = \'per_task\'), 0) < ?"'],
    tests: T.old,
    expectRed: [],
    expectGreen: [],
    expectAllGreen: true,
  },
  {
    label: "M2 方向翻向（hard_stop = 1 时放行）⇒ 两头的期望同时倒过来",
    file: SRC,
    from: ["    \".id AND b.period = 'per_task'), 1) = 0)\""],
    to: ["    \".id AND b.period = 'per_task'), 1) = 1)\""],
    tests: [T.gate],
    expectRed: [N.denom, N.off, N.spawn, N.pair, N.paren, N.mirror, N.driver, N.board],
    expectGreen: [N.noRow, N.param],
  },
  {
    label: "M3 摘掉最外层括号（AND 比 OR 紧）⇒ 预测【只有括号那一发红】",
    file: SRC,
    // ⚠ 必须【左右一起摘】：只摘左边会留下一只孤括号 ⇒ SQL 语法错 ⇒ 所有查它的用例
    //   全红，那测的是「语法」而不是「优先级」。整块替换才是真去掉分组。
    from: [
      OPEN,
      '    "WHERE b.scope_type = \'task\' AND b.scope_id = " +',
      "    t +",
      '    ".id AND b.period = \'per_task\'), 0) < ?" +',
      HARD_LINE,
      '    "WHERE b.scope_type = \'task\' AND b.scope_id = " +',
      "    t +",
      TAIL,
    ],
    to: [
      '    "COALESCE((SELECT b.consumed_cents FROM budgets b " +',
      '    "WHERE b.scope_type = \'task\' AND b.scope_id = " +',
      "    t +",
      '    ".id AND b.period = \'per_task\'), 0) < ?" +',
      HARD_LINE,
      '    "WHERE b.scope_type = \'task\' AND b.scope_id = " +',
      "    t +",
      '    ".id AND b.period = \'per_task\'), 1) = 0"',
    ],
    tests: [T.gate],
    expectRed: [N.paren],
    // 这五发在 M3 下【全绿】不是它们松，是它们造的数据让两种结合方式给出同一个答案。
    // 这一串 expectGreen 才是这一发的信息量：现有形状看不见这个改动。
    expectGreen: [N.off, N.denom, N.pair, N.mirror, N.driver, N.board, N.noRow, N.param, N.spawn],
  },
  {
    label: "M4 缺省 1 → 0 ⇒ 预测【全绿】（那一格今天不承重，见文件头 M4 那段）",
    file: SRC,
    from: ["    \".id AND b.period = 'per_task'), 1) = 0)\""],
    to: ["    \".id AND b.period = 'per_task'), 0) = 0)\""],
    tests: [T.gate],
    expectRed: [],
    expectGreen: [],
    expectAllGreen: true,
  },
];

const originals = new Map();
function orig(rel) {
  if (!originals.has(rel)) originals.set(rel, readFileSync(join(ROOT, rel), "utf8"));
  return originals.get(rel);
}

/** 盘上是 CRLF 而锚点用 \n 拼 ⇒ 命中 0 次（round305 实测过），所以按文件自己的 EOL 拼。 */
function eolOf(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}
function anchor(text, lines) {
  return lines.join(eolOf(text));
}

function failedTests(out) {
  const plain = out.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "gu"), "");
  const names = new Set();
  for (const line of plain.split("\n")) {
    const m = /(?:×|✗)\s+(.+?)(?:\s+\d+ms)?\s*$/u.exec(line.trim());
    if (m !== null && m[1] !== undefined) names.add(m[1].trim());
  }
  return [...names];
}

function runTests(files) {
  const r = spawnSync(process.execPath, [VITEST, "run", ...files], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 900_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = String(r.stdout) + String(r.stderr);
  return { green: r.status === 0, names: failedTests(out), out };
}

function rollback(rel) {
  writeFileSync(join(ROOT, rel), orig(rel), "utf8");
  if (readFileSync(join(ROOT, rel), "utf8") !== orig(rel)) {
    throw new Error("回滚后字节对不上，立刻去 git 核对：" + rel);
  }
}

/** 锚点先全验一遍：任一失配就【一发不发】。命中 0 次的变异是真空操作。 */
function preflight() {
  const bad = [];
  for (const mut of MUTATIONS) {
    const text = orig(mut.file);
    const from = anchor(text, mut.from);
    const to = anchor(text, mut.to);
    if (from === to) bad.push(mut.label + " 是真空操作（from === to）");
    const n = text.split(from).length - 1;
    if (n !== 1) bad.push("锚点命中 " + n + " 次（要恰好 1）：" + mut.from[0].slice(0, 70));
  }
  if (bad.length > 0) throw new Error("锚点校验失败，一发不发：\n  " + bad.join("\n  "));
}

const results = [];
let fatal = "";
try {
  preflight();
  const control = runTests([T.gate, ...T.old]);
  results.push([
    control.green,
    "M0 一字不改 ⇒ 新文件 + 旧三件套全绿",
    control.green ? "全绿" : "意外红：" + control.names.join("、").slice(0, 500),
  ]);
  if (!control.green) throw new Error("控制组就红 ⇒ 后面每一发的「该红/该绿」都没有地基");

  for (const mut of MUTATIONS) {
    const text = orig(mut.file);
    const before = text;
    const after = text.replace(anchor(text, mut.from), anchor(text, mut.to));
    // 变异必须【真的改了字节】：语义变了而字符串还在 = no-op，会红得像抓到了。
    if (before === after) throw new Error("变异没有改动字节，这一发不发：" + mut.label);
    writeFileSync(join(ROOT, mut.file), after, "utf8");
    if (readFileSync(join(ROOT, mut.file), "utf8") !== after) {
      throw new Error("变异写盘后读回不一致：" + mut.label);
    }
    let got;
    try {
      got = runTests(mut.tests);
    } finally {
      rollback(mut.file);
    }
    const hit = (needle) => got.names.some((x) => x.includes(needle));
    const problems = [];
    if (mut.expectAllGreen === true) {
      if (!got.green) problems.push("预测全绿而实红 ⇒ 文件头那条推演错了：" + got.names.join("、").slice(0, 600));
    } else {
      if (got.green) problems.push("【全绿】⇒ 这一格不承重（或者锚点没抹到）");
      for (const w of mut.expectRed) if (!hit(w)) problems.push("该红的没红：" + w);
      for (const w of mut.expectGreen) if (hit(w)) problems.push("不该红的红了：" + w);
    }
    results.push([
      problems.length === 0,
      mut.label,
      problems.length === 0
        ? (got.green ? "全绿（符合这一发的预测）" : "红的落点正是：" + got.names.join("、").slice(0, 700))
        : problems.join("；") + " ｜实红：" + got.names.join("、").slice(0, 700),
    ]);
  }
} catch (err) {
  fatal = String(err instanceof Error ? err.message : err);
} finally {
  for (const rel of originals.keys()) {
    try {
      rollback(rel);
    } catch (err) {
      console.error("【致命】收尾回滚失败，立刻去 git 核对：" + rel + " ｜" + String(err));
      process.exitCode = 1;
    }
  }
}

if (fatal !== "") {
  console.error("【整台机器停摆，不出命中数】" + fatal);
  process.exitCode = 1;
} else {
  let ok = 0;
  console.log("══════════ round309 hard_stop 读方变异矩阵（写生产真字节，逐发自回滚）══════════");
  for (const [isHit, label, msg] of results) {
    ok += isHit ? 1 : 0;
    console.log((isHit ? "✓ " : "✗ ") + label + "\n      | " + msg);
  }
  const want = MUTATIONS.length + 1;
  console.log(
    "命中 " + ok + " / " + results.length + "（分母 = " + MUTATIONS.length + " 发变异 + 1 发控制组，数出来的）",
  );
  process.exitCode = ok === results.length && results.length === want ? 0 : 1;
}
