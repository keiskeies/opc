/**
 * round305 变异机：Task 6.1 那条「只重试结构上零花费的失败」判据，逐格验承重。
 *
 * ── 这台机器要回答的唯一问题 ──────────────────────────────────
 * 「重试层接上了」这句话由四格判据撑着，而【测试绿】对它们一句都不证明：
 *   · 判据少一半（只看 errno 名单，不看 started）
 *   · 判据恒假（重试其实是死代码）
 *   · 额度用尽后抛而不是交回失败轮
 *   · 执行器 reject 被包成正常失败轮
 * 每一格都得【真抹掉生产字节】再跑一遍，看有没有一发红。没有 ⇒ 那一格不承重。
 *
 * ── 事前预测（写在这台机器跑【之前】，跑完不许改）───────────────
 * 主张链的规矩是预测先落纸：事后照着实测补的「预期」不是预测，是抄答案。
 *   M0 控制组      ⇒ 全绿
 *   M1 抹掉 started ⇒ turn-retry 的「起过进程 + 瞬时 errno」该红；
 *                     预测【只有】这一发红 —— 其余 started:true 的失败 errno 恒空，
 *                     名单那一半照样挡住它们。⚠ 这一发是【设计 M1 时推演出来的漏网】，
 *                     不是跑机器跑出来的：先补用例、再跑机器 ⇒ 机器只能证明它承重。
 *   M2 判据恒假    ⇒ 「退避重试 1s/2s/4s」与「名单逐字钉住」两发该红（恒不放行）。
 *                     方向要说准：恒假是【fail-closed】—— 坏起来像「重试没生效」，
 *                     不会多花钱，所以它不是最危险的那一格，但它是【整条判据的死活】。
 *   M3 放弃时抛    ⇒ turn-retry「额度用尽后交出最后那次」+ runtime「多烧 4 次 spawn
 *                     而一处账都不多记」该红（外壳把资源型故障变成 hub 崩）。
 *   M4 摘掉 reject 原样抛回 ⇒ turn-retry「执行器自己 reject ⇒ 原样抛回」该红。
 *   M5 spawned 恒真（claude.ts）⇒ claude.test 的「二进制不存在」「bin 指着目录」该红。
 *   M6 errno 不带出（claude.ts）⇒ 同上两发该红（钉 ENOENT 与钉非空各红一次）。
 *
 * ⚠ 这台【写真字节】（生产源码 packages/hub/src/engine/*.ts），逐发跑完立刻按原文
 *   回写并逐字节核对 ⇒ 单独跑，不许与任何测试并发（round292 (b)）。
 *   读红绿：vitest 的退出码 + reporter 的【测试名】，不 grep 数字（round301 §⑦③）。
 *
 * 跑法：node .workbuddy/round305-mutate-retry.mjs
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");

const SRC = {
  claude: "packages/hub/src/engine/claude.ts",
  retry: "packages/hub/src/engine/turn-retry.ts",
};
const TEST = {
  claude: "packages/hub/test/engine/claude.test.ts",
  retry: "packages/hub/test/engine/turn-retry.test.ts",
  runtime: "packages/hub/test/engine/runtime.test.ts",
};

/** 测试名的子串（够认出是哪一发，且不随标题里的标点漂移）。 */
const N = {
  backoff: "退避重试，退避序列是 1s/2s/4s",
  startedTrue: "起过进程 + 瞬时 errno ⇒ 仍不重试",
  whitelist: "瞬时名单逐字钉住",
  loud: "执行器自己 reject ⇒ 原样抛回",
  enoentTitle: "二进制不存在 ⇒ ok:false 并报出错",
  dir: "bin 指着一个目录",
  transparent: "多烧 4 次 spawn 而【一处账都不多记】",
};

/**
 * 锚点按【行数组】写，运行时按该文件自己的换行符拼。
 *
 * 起因（实测）：claude.ts 在盘上是 CRLF，而我第一版的锚点用 \n 拼 ⇒ 命中 0 次。
 * preflight 先验锚点、失配就【一发不发】，所以这次是机器停摆而不是假绿 ——
 * 这正是它存在的理由（round293：命中 0 次的变异是真空操作，会让那一发「按预期绿」）。
 * 不去改文件换行符：那是全仓排版，属「先 commit 再全仓修」那一格，不归这台机器。
 */
function eolOf(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}
function anchor(text, lines) {
  return lines.join(eolOf(text));
}

const MUTATIONS = [
  {
    label: "M1 抹掉判据第一条（started）⇒ 只剩 errno 名单挡一切",
    file: SRC.claude,
    from: ["  if (r.ok || r.started) return false;"],
    to: ["  if (r.ok) return false; // 变异：第一条没了，进程起过也照重试"],
    tests: [TEST.retry],
    expectRed: [N.startedTrue],
    expectGreen: [N.backoff, N.whitelist, N.loud],
  },
  {
    label: "M2 判据恒假（fail-closed 方向）⇒ 重试整条是死代码",
    file: SRC.claude,
    from: [
      "  if (r.ok || r.started) return false;",
      "  return (SPAWN_TRANSIENT_ERRNOS as readonly string[]).includes(r.spawnErrno);",
    ],
    to: ["  return false; // 变异：恒不放行"],
    tests: [TEST.retry],
    expectRed: [N.backoff, N.whitelist],
    expectGreen: [N.startedTrue, N.loud],
  },
  {
    label: "M3 额度用尽后【抛】而不是交回失败轮 ⇒ 资源型故障把 hub 弄崩",
    file: SRC.retry,
    from: ["  if (last instanceof TurnSpawnMissed) return last.result;"],
    to: ['  if (last instanceof TurnSpawnMissed) throw new Error("变异：放弃即崩溃");'],
    tests: [TEST.retry, TEST.runtime],
    expectRed: [N.backoff, N.transparent],
    expectGreen: [N.loud],
  },
  {
    label: "M4 摘掉 reject 的原样抛回 ⇒ 装配期 bug 降级成一条正常失败轮",
    file: SRC.retry,
    from: ["      throw attempt.error;"],
    to: [
      "      // 变异：把 reject 转成一条【看起来正常】的失败轮",
      '      return { ok: false, text: "", sessionId: null, costUsd: 0, error: "变异：吞掉了崩溃", started: true, spawnErrno: "" };',
    ],
    tests: [TEST.retry],
    expectRed: [N.loud],
    expectGreen: [N.backoff],
  },
  {
    label: "M5 claude.ts 的 error 分支里 spawned 写死 true ⇒ started 恒真",
    file: SRC.claude,
    from: ["        spawned: false,"],
    to: ["        spawned: true, // 变异：谎报「起来过」"],
    tests: [TEST.claude],
    expectRed: [N.enoentTitle, N.dir],
    expectGreen: [],
  },
  {
    label: "M6 errno 名不带出 Promise ⇒ 判据的输入恒空",
    file: SRC.claude,
    from: [
      '        spawnErrno: typeof (e as { code?: unknown })["code"] === "string"',
      '          ? String((e as { code?: unknown })["code"])',
      '          : "",',
    ],
    to: ['        spawnErrno: "", // 变异：名字丢了'],
    tests: [TEST.claude],
    expectRed: [N.dir, N.enoentTitle],
    expectGreen: [],
  },
];

const originals = new Map();
function orig(rel) {
  if (!originals.has(rel)) originals.set(rel, readFileSync(join(ROOT, rel), "utf8"));
  return originals.get(rel);
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
    timeout: 600_000,
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

/**
 * 锚点先全验一遍：任一失配就【一发不发】。
 * 命中 0 次的变异是真空操作，它会让那一发「按预期绿」—— 假绿来自机器而不是判据。
 */
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
  const control = runTests([TEST.claude, TEST.retry]);
  results.push([
    control.green,
    "M0 一字不改 ⇒ claude + turn-retry 两套全绿",
    control.green ? "全绿" : "意外红：" + control.names.join("、").slice(0, 500),
  ]);
  if (!control.green) throw new Error("控制组就红 ⇒ 后面每一发的「该红/该绿」都没有地基");

  for (const mut of MUTATIONS) {
    const text = orig(mut.file);
    writeFileSync(
      join(ROOT, mut.file),
      text.replace(anchor(text, mut.from), anchor(text, mut.to)),
      "utf8",
    );
    let got;
    try {
      got = runTests(mut.tests);
    } finally {
      rollback(mut.file);
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
  console.log("══════════ round305 重试判据变异矩阵（写生产真字节，逐发自回滚）══════════");
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
