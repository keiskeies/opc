/**
 * round330 变异机（hub 批量端点侧）：§9.4 POST /approvals/batch 的五格判据，逐格验承重。
 *
 * ── 这台机器要回答的唯一问题 ──────────────────────────────────
 * batch-route.test.ts 那 19 发绿，对「判据被改成不判」是不是瞎的？本仓三次独立撞上
 * 「真仓库那一发对判据失效是瞎的」（round274-M3 / round276-G4 / round278-C3），
 * 所以每条判据都要打在【真实现消失】的那个面上。五发：
 *   M1 路由顺序被打乱（删掉 batch 那条 if）—— 这段顺序在本仓是【少数派：承重】
 *      （:id/token 那两条靠段数互斥、顺序不承重），删掉 ⇒ batch 被 :interruptId 吃掉。
 *   M2 「同类型」判据失效（types.length > 1 ⇒ > 99）—— 混类型照样往下写。
 *   M3 「都存在」判据失效（missing.length > 0 ⇒ > 99）—— 缺 id 不再整批不写。
 *   M4 「重放那一张不再写」的跳过被删 —— 已决定的卡重复走写路径。
 *   M5 图恢复失败不再逐张兜住（catch 里 accumulate ⇒ 直接 rethrow）——
 *      第一张失败就中断整批，剩下的卡图一次都不恢复。
 *
 * ── 事前预测（写在跑之前，跑完不许改）─────────────────────────
 *   M0 控制组 ⇒ batch-route.test.ts 全绿（当前实测 19 通过）。
 *   M1 ⇒ 该红：① 那发 matchRoute 断言 + ② 两发鉴权那族拿不到批量端点 ⇒ 至少 3 发。
 *        （被 :interruptId 吃掉后走单条 decide，请求体 schema 不同 ⇒ ②③ 全红，
 *         这是【预期】的连带，不写进 expectGreen。）
 *   M2 ⇒ 该红：混类型那一发。预测【只有它红】—— 其余判据不沾类型这格。
 *   M3 ⇒ 该红：缺失 id 那一发（拿 ghost 去 byId.get ⇒ undefined 上取属性 ⇒ 500，
 *        断言 404 的那一发红）。「正向对照 200」那发无 ghost ⇒ 预测仍绿。
 *   M4 ⇒ 该红：⑤ 第一发（calls.decision 断言等于 ["a-1"]）；「全部已决策」那发
 *        （断言 calls.decision 长度 0）同样该红。
 *   M5 ⇒ 该红：⑥ 第一发（calls.resumed 断言两张都在）。
 *
 * ⚠ 跑法（仓根）：npx tsx .workbuddy/round330-mut-hub.mjs
 *   这台机器写真字节 ⇒ 单独跑，不与任何测试并发（round292 (b)）。
 *   读红绿：vitest 退出码 + 失败【测试名】，不 grep 汇总数字（round301 §⑦③）。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");
const SRC = "packages/hub/test/http/batch-route.test.ts";
const CONTRACT = "packages/hub/test/http/contract.test.ts";
const TESTS = [SRC, CONTRACT];

/** 失败测试名的子串（够认出哪一发，不随标题标点漂移）。 */
const N = {
  routeShape: "batch 匹成 decide_batch",
  mixedType: "混类型 ⇒ 422 + 报出混了哪几种",
  missingId: "有一个 id 不存在 ⇒ 404 + missing",
  replaySkip: "pending + approved 混选",
  allDecided: "全部已决策 ⇒ applied 0 / replayed 2",
  resumeFail: "第 1 张恢复失败",
  positive: "正向对照：同类型 200",
};

const MUTATIONS = [
  {
    label: "M1 删掉 matchRoute 里 batch 那条 if ⇒ 顺序承重的证据（/approvals/batch 被 :interruptId 吃掉）",
    file: "packages/hub/src/http/app.ts",
    from: [
      '  if (',
      '    method === "POST" &&',
      '    segs.length === 2 &&',
      '    segs[0] === "approvals" &&',
      '    segs[1] === "batch"',
      '  ) {',
      '    return { kind: "decide_batch", endpoint: "POST /approvals/batch" };',
      "  }",
    ],
    to: [
      '  // 变异：批量那条整块删除 ⇒ 落到下面 :interruptId 那条，id 收到 "batch"',
    ],
    expectRed: [N.routeShape],
    expectGreen: [],
  },
  {
    label: "M2 「同类型」判据改成永不成立 ⇒ 混类型照样往下写",
    file: "packages/contracts/src/api.ts",
    from: ["  if (types.length > 1) {"],
    to: ["  if (types.length > 99) { // 变异：混类型不再拦"],
    expectRed: [N.mixedType],
    expectGreen: [N.missingId, N.resumeFail],
  },
  {
    label: "M3 「都存在」判据改成永不成立 ⇒ 缺 id 不再整批不写",
    file: "packages/contracts/src/api.ts",
    from: ["  if (missing.length > 0) {"],
    to: ["  if (missing.length > 99) { // 变异：缺 id 不再整批拦下"],
    expectRed: [N.missingId],
    expectGreen: [N.positive, N.mixedType],
  },
  {
    label: "M4 删掉「重放那一张跳过写路径」⇒ 已决定的卡重复走写",
    file: "packages/hub/src/http/app.ts",
    from: [
      "    if (card.alreadyDecided) {",
      "      replayed += 1;",
      "      continue;",
      "    }",
    ],
    to: ["    // 变异：不再跳过已决定的那张"],
    expectRed: [N.replaySkip, N.allDecided],
    expectGreen: [N.positive],
  },
  {
    label: "M5 图恢复失败改回「直接冒出去」⇒ 第一张失败就中断整批",
    file: "packages/hub/src/http/app.ts",
    from: [
      "    } catch (e) {",
      "      resumeFailed += 1;",
      '      if (firstResumeError === "") {',
      "        firstResumeError = e instanceof Error ? e.message : String(e);",
      "      }",
      "    }",
    ],
    to: ["    } catch (e) {", "      throw e; // 变异：不再逐张兜住", "    }"],
    expectRed: [N.resumeFail],
    expectGreen: [N.positive],
  },
];

const files = [...new Set(MUTATIONS.map((m) => m.file))];
const originals = new Map(files.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));

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

function rollback() {
  for (const [f, text] of originals) {
    writeFileSync(join(ROOT, f), text, "utf8");
    if (readFileSync(join(ROOT, f), "utf8") !== text) {
      throw new Error("回滚后字节对不上，立刻去 git 核对：" + f);
    }
  }
}

/** 锚点先全验：任一失配/真空 ⇒ 一发不发（round293：命中 0 次的变异是真空操作）。 */
function preflight() {
  const bad = [];
  for (const mut of MUTATIONS) {
    const text = originals.get(mut.file);
    const from = anchor(text, mut.from);
    const to = anchor(text, mut.to);
    if (from === to) bad.push(mut.label + " 是真空操作（from === to）");
    const n = text.split(from).length - 1;
    if (n !== 1) {
      bad.push("锚��命中 " + n + " 次（要恰好 1）：" + mut.file + " :: " + mut.from[0].slice(0, 60));
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
    "M0 一字不改 ⇒ batch-route + contract 全绿",
    control.green ? "全绿" : "意外红：" + control.names.join("、").slice(0, 500),
  ]);
  if (!control.green) throw new Error("控制组就红 ⇒ 后面每一发的「该红/该绿」都没有地基");

  for (const mut of MUTATIONS) {
    const path = join(ROOT, mut.file);
    const before = readFileSync(path, "utf8");
    const next = before.replace(anchor(before, mut.from), anchor(before, mut.to));
    if (next === before) throw new Error("断言失败：变异前后源码逐字节相同（" + mut.label + "）");
    writeFileSync(path, next, "utf8");
    if (readFileSync(path, "utf8") !== next) {
      throw new Error("断言失败：写盘后读回的不是变异体（" + mut.label + "）");
    }
    let got;
    let reverted = false;
    try {
      got = runTests();
    } finally {
      rollback();
      reverted = files.every((f) => readFileSync(join(ROOT, f), "utf8") === originals.get(f));
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
        : problems.join("；") + " ｜实红：" + got.names.join("、").slice(0, 900),
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
    console.error("【致命】收尾回滚失败，立刻去 git 核对：" + String(e2));
    process.exitCode = 1;
  }
}

if (fatal !== "") {
  console.error("【整台机器停摆，不出命中数】" + fatal);
  process.exitCode = 1;
} else {
  let ok = 0;
  console.log("══════════ round330 批量端点变异矩阵（写真字节，逐发自回滚）══════════");
  for (const [isHit, label, msg] of results) {
    ok += isHit ? 1 : 0;
    console.log((isHit ? "✓ " : "✗ ") + label + "\n      | " + msg);
  }
  const want = MUTATIONS.length + 2;
  console.log("命中 " + ok + " / " + results.length + "（分母 = " + MUTATIONS.length + " 发变异 + 控制组 + 还原复核）");
  process.exitCode = ok === results.length && results.length === want ? 0 : 1;
}
