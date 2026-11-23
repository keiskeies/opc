/**
 * round356 变异机（B1-B 判据 3）：节点/审批审计写入点的【快照 + 中断重放去重】。
 * 照 round342/351/352 的形状：读文件→字节级变异→写回→跑目标测试→记录命中→
 * 恢复原内容→逐字节核对 + 打印 reverted: true。
 *
 * ── 这台机器要回答的唯一问题 ──────────────────────────────────
 * CEO 拍板第 ② 项要的三件事都落在【两个写入点 + 一层去重】上：
 *   快照生成（company.ts edge / audit-middleware 审批）、中断重放去重（0010 索引 +
 *   recorder 预检查）、方向性断言（快照说的是【本条边之前】）。
 * 测试绿对这三件事不证明 —— 每一发都【真抹生产字节】：
 *  M1 recorder 的重放预检查短路掉（恒不命中）⇒ 去重整个失效，重放行照写第二行。
 *  M2 键源退化成【常量】⇒ 去重【过宽】：第二次节点执行的合法事件被第一次吞掉
 *     （实测红在「9 应该等于 11」—— dev#2 交的那条证据边没了）。
 *  M3 键源每次调用都变（Math.random）⇒ 去重【过窄】：一条也吞不掉，而索引看起来
 *     完全正常。这一发就是 0005 §11.4 用「超步序号」时真实的失效形状。
 *  M4 快照丢掉 `current: from` 的替换 ⇒ 一个超步写多条边时，第二条边的快照说的
 *     是【上一条边之前】（实测红在 IN_REVIEW->REJECTED_DOWNWARD 那条：
 *     expected 'EVIDENCE_SUBMITTED' to be 'IN_REVIEW'）。
 *  M5 被吞的那次 record 仍然 push pending ⇒ 同一个 seq 广播第二遍，真总线会因
 *     严格递增守卫抛错 ⇒ 表现是「每次 resume 都把 SSE 订阅弄脏一次」。
 *  M6 审批快照不再摘 __interrupt__ ⇒ 框架的控制流包装混进「决定时的任务状态」。
 *
 * ⚠ 一条【已知等价变异】，写下来免得下次再去找它：把审批的 replayKey 改成常量
 *   测不红（实测过）。审批行的身份靠 target（= interruptId），两张不同卡片的 target
 *   本来就不同，常量键与 hit.id 在【索引语义】上等价。第一版我把「不是常量」这条
 *   写成「两个任务各开一个库」，那台机器整个是真空的 —— 已改成同一个库里放两张卡。
 *   过宽风险真正住在【节点侧】：dev#1 与 dev#2 写的边【逐字相同】
 *   （IN_PROGRESS->EVIDENCE_SUBMITTED），只有任务 id 那一维【不】区分它们，
 *   区分它俩的唯一东西就是这里的键 —— 所以 M2 才必须红。
 *
 * ⚠ 跑法（仓根）：node .workbuddy/round356-replay-dedup-mut.mjs
 *   写真字节 ⇒ 单独跑，不与任何测试并发（round292 (b)）。只跑两个目标文件，不碰全量。
 *   读红绿：vitest 退出码 + 失败【测试名】，不 grep 汇总数字（round301 §⑦③）。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");
const TEST_FILES = [
  "packages/hub/test/graph/interrupt-resume.test.ts",
  "packages/hub/test/graph/e2e-linear.test.ts",
];

const REC = "packages/hub/src/events/recorder.ts";
const KEY = "packages/hub/src/graph/replay-key.ts";
const COMPANY = "packages/hub/src/graph/company.ts";
const MW = "packages/hub/src/graph/audit-middleware.ts";

/** 失败测试名的子串（够认出哪一发，不随标题标点漂移）。 */
const N = {
  keyedResume: "resume 重放被吞：仍是 1 行",
  keyedNull: "invoke(null) + 重放键 ⇒ 不重复",
  notTooBroad: "修复不过宽",
  approvalOnce: "同一个 interruptId 再中断一次 ⇒ 审批仍是 1 行",
  twoCards: "两张不同卡片】都落库",
  noRepublish: "被吞掉的那次 record 不广播",
  swallowedSnap: "重放行被吞时，库里那一行的快照仍是",
  approvalSnap: "审批那条边也带快照",
  // e2e-linear
  linear1: "① 一句想法能跑到 END",
  linear4: "④ from/to 序列与 §7.1 完全一致",
  snap5: "⑤ 每条状态边都有 state_snapshot",
  crashResume: "新进程续跑：补齐剩下所有边",
};

const MUTATIONS = [
  {
    label:
      "M1 重放预检查恒不命中 ⇒ 去重整体失效，重放行写第二行（缺陷 A/B 原样回来）",
    src: REC,
    from: ["    if (hit !== undefined) {"],
    to: ["    if (hit !== undefined && false) {"],
    // 预检查是【两个写入点共用】的唯一机制，所以它一死审批侧一起红 ——
    // 第一版把 approvalOnce 列为「该绿」，是我预测错，不是测试弱：
    // 审批的去重同样靠这一份预检查（节点侧靠 task_id、审批侧靠 interruptId，
    // 键不同而吞的动作是同一个）。noRepublish / swallowedSnap 同理：
    // 预检查不命中就没有 deduplicated 分支，第二次是真写一行 ⇒ 断言「仍 1 行」红。
    expectRed: [N.keyedResume, N.keyedNull, N.approvalOnce, N.noRepublish, N.swallowedSnap],
    expectGreen: [N.notTooBroad, N.linear1, N.twoCards],
  },
  {
    label:
      "M2 键源退化成常量 ⇒ 去重过宽，第二次执行的合法事件被吞（9 应该等于 11）",
    src: KEY,
    from: ["  return raw;"],
    to: ['  return "constant";'],
    expectRed: [N.linear1, N.linear4, N.snap5],
    expectGreen: [N.approvalOnce, N.twoCards],
  },
  {
    label: "M3 键源每次不同 ⇒ 去重过窄，一条也吞不掉（§11.4 超步序号的真实形状）",
    src: KEY,
    from: ["  return raw;"],
    to: ['  return raw + ":" + Math.random();'],
    expectRed: [N.keyedResume, N.keyedNull, N.snap5],
    expectGreen: [N.linear1, N.approvalOnce],
  },
  {
    label: "M4 快照不做 current:from 替换 ⇒ 多条边的第二条说成上一条边之前",
    src: COMPANY,
    from: ["        stateSnapshot: { ...state, current: from },"],
    to: ["        stateSnapshot: { ...state },"],
    expectRed: [N.snap5],
    expectGreen: [N.linear1, N.linear4, N.keyedResume],
  },
  {
    label: "M5 被吞的行仍然入广播队列 ⇒ 同一 seq 发两遍，SSE 订阅每次 resume 被标脏",
    // 锚点用 dedup 分支里那句缩进 6 空格的 return seq（全文件唯一；外层那句缩进 4 空格）。
    src: REC,
    from: ["      return seq;"],
    to: ["      this.#pending.push({ event: e, seq }); return seq; // 变异：被吞也广播"],
    expectRed: [N.noRepublish],
    expectGreen: [N.keyedResume, N.swallowedSnap, N.linear1],
  },
  {
    label: "M6 审批快照保留 __interrupt__ ⇒ 框架控制流冒充「决定时的任务状态」",
    src: MW,
    from: ["    delete state.__interrupt__;"],
    to: ["    // 变异：不摘 __interrupt__"],
    expectRed: [N.approvalSnap],
    expectGreen: [N.approvalOnce, N.twoCards, N.linear1],
  },
];

const SOURCES = [...new Set(MUTATIONS.map((m) => m.src))];
const originals = new Map();
for (const s of SOURCES) originals.set(s, readFileSync(join(ROOT, s), "utf8"));

const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");
const anchor = (text, lines) =>
  lines.join(eolOf(text));

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
  const r = spawnSync(process.execPath, [VITEST, "run", ...TEST_FILES], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 900_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = String(r.stdout) + String(r.stderr);
  return { green: r.status === 0, names: failedTests(out), out };
}

/** 逐字节还原全部宿主 + 核对。 */
function rollback() {
  for (const s of SOURCES) {
    const original = originals.get(s);
    writeFileSync(join(ROOT, s), original, "utf8");
    if (readFileSync(join(ROOT, s), "utf8") !== original) {
      throw new Error("回滚后字节对不上，立刻去 git 核对：" + s);
    }
  }
}

/** 锚点先全验：任一失配/真空 ⇒ 一发不发（round293：命中 0 次的变异是真空操作）。 */
function preflight() {
  const bad = [];
  for (const mut of MUTATIONS) {
    const src = originals.get(mut.src);
    if (mut.from.length !== mut.to.length) {
      bad.push(mut.label + " 的 from/to 锚点数不一致");
      continue;
    }
    for (let i = 0; i < mut.from.length; i++) {
      const needle = anchor(src, [mut.from[i]]);
      const n = src.split(needle).length - 1;
      if (n !== 1)
        bad.push(
          "锚点命中 " + n + " 次（要恰好 1）：" + String(mut.from[i]).slice(0, 60),
        );
      if (mut.from[i] === mut.to[i])
        bad.push(mut.label + " 锚点 #" + i + " 是真空操作（from === to）");
    }
  }
  if (bad.length > 0)
    throw new Error("锚点校验失败，一发不发：\n  " + bad.join("\n  "));
}

const includesAny = (names, needle) =>
  names.some((n) => n.includes(needle));

const results = [];
let fatal = "";
try {
  preflight();

  const control = runTests();
  results.push([
    control.green,
    "M0 一字不改 ⇒ " + TEST_FILES.length + " 个文件全绿",
    control.green
      ? "全绿"
      : "意外红：" + control.names.join("、").slice(0, 500),
  ]);
  if (!control.green)
    throw new Error("控制组就红 ⇒ 后面每一发的「该红/该绿」都没有地基");

  for (const mut of MUTATIONS) {
    const src = originals.get(mut.src);
    let next = src;
    for (let i = 0; i < mut.from.length; i++) {
      const needle = anchor(src, [mut.from[i]]);
      const repl = anchor(src, [mut.to[i]]);
      next = next.replace(needle, repl);
    }
    if (next === src)
      throw new Error("断言失败：变异前后源码逐字节相同（" + mut.label + "）");
    writeFileSync(join(ROOT, mut.src), next, "utf8");
    if (readFileSync(join(ROOT, mut.src), "utf8") !== next) {
      throw new Error("断言失败：写盘后读回的不是变异体（" + mut.label + "）");
    }
    const run = runTests();
    const missingRed = mut.expectRed.filter((n) => !includesAny(run.names, n));
    const wronglyRed = mut.expectGreen.filter((n) => includesAny(run.names, n));
    const ok = !run.green && missingRed.length === 0 && wronglyRed.length === 0;
    results.push([
      ok,
      mut.label,
      ok
        ? "该红的红全红（" +
          mut.expectRed.length +
          " 发）、该绿的绿全绿；实红 " +
          run.names.length +
          " 发"
        : "missingRed=[" +
          missingRed.join(" | ") +
          "] wronglyRed=[" +
          wronglyRed.join(" | ") +
          "] 实红=[" +
          run.names.join(" | ").slice(0, 400) +
          "]" +
          (run.green ? " 【整轮居然全绿】" : ""),
    ]);
    rollback();
  }
} catch (err) {
  fatal = String(err instanceof Error ? err.message : err);
  try {
    rollback();
    results.push([true, "收尾回滚", "全部宿主已按原文逐字节还原（机器停摆路径）"]);
  } catch (e2) {
    console.error(
      "【致命】收尾回滚失败，立刻去 git 核对全部宿主：" + String(e2),
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
    "══════════ round356 快照+重放去重变异矩阵（写真字节，逐发自回滚）══════════",
  );
  for (const [isHit, label, msg] of results) {
    ok += isHit ? 1 : 0;
    console.log((isHit ? "✓ " : "✗ ") + label + "\n      | " + msg);
  }
  for (const s of SOURCES) {
    const same =
      readFileSync(join(ROOT, s), "utf8") === originals.get(s);
    console.log((same ? "✓ " : "✗ ") + "reverted: " + same + " — " + s);
    ok += same ? 1 : 0;
  }
  const denom = results.length + SOURCES.length;
  console.log(
    "命中 " +
      ok +
      " / " +
      denom +
      "（分母 = 1 控制组 + " +
      MUTATIONS.length +
      " 发变异 + " +
      SOURCES.length +
      " 个宿主逐字节还原核对）",
  );
  process.exitCode = ok === denom ? 0 : 1;
}
