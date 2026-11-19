/**
 * round310 变异机：新测试 `new-role-via-http-to-its-own-criteria.test.ts` 那条
 * 「界面两条 HTTP 写入口串成 O8 链」的每一格，到底承不承重。
 *
 * ── 这台机器要回答的唯一问题 ──────────────────────────────────
 * 那条链由四格判据撑着，而【测试绿】一句都不证明：
 *   · add_node 真的把节点加进 after 图了吗（org/commit.ts 那一行赋值）
 *   · 验收标准真的从岗位书渲染进 prompt 了吗（prompt.ts 的 real.length 那一支）
 *   · 没有岗位书时那句 NO_CHARTER_LINE 真的在吗（runtime.ts 三元的第一支）
 *   · buildHubDeps 真把队列接到了 POST /charter 上吗（real-deps 那一行装配）
 * 每一发都【真抹生产字节】再跑一遍，跑完立刻逐字节回滚并核对。
 *
 * ── 事前预测（写在这台机器跑【之前】，跑完不许改）────────────────
 * ⚠ 按本仓家规，预测先落纸；事后照着实测补的「预期」不是预测，是抄答案。
 *   M0 控制组      ⇒ 全部相关文件全绿（新文件 + 旧 O8 + prompt + runtime + 两条路由）。
 *   M1 prompt.ts 的 `if (real.length > 0)` 恒假 ⇒ 已签标准那一格整段不渲染：
 *       该红：新文件【正题】（哨兵串与「不合格的情形」都不再出现）、
 *             旧 O8【正题】（同一条渲染路径）、
 *             prompt.test 的【该进的格】【condition 渲染成不合格的情形】
 *                       【escalate/reject 两支】【签过+占位混合】（真标准不进来了）、
 *             runtime.test 的【有岗位书⇒逐格出现】。
 *       该绿：新文件【反向对照 unsigned】（它判的是 NO_CHARTER_LINE 那一支，不经过这里）、
 *             prompt.test 的【含占位串】（占位句走 pending 那一支，还在）、
 *             prompt.test 的【全部签过⇒不提未签字】—— ⚠ 预测它【照样绿】：
 *               这条在 M1 下的绿是【语义已被吸收】的形状（M1 后"有标准也不渲染"，
 *               它要的"不提未签字"恒成立），若实测红了说明我对它的分析错了。
 *   M2 runtime.ts 三元第一支 NO_CHARTER_LINE ⇒ ""（没有岗位书时不再明说）：
 *       该红：新文件【正题】（intake 前提那一发）与【反向对照】、
 *             旧 O8【反空转 unseeded】与【播种那一格不是白给的】、
 *             runtime.test 的【一个版本都没有⇒明说】与【角色名跟着走】。
 *       该绿：prompt.test 全绿（纯渲染器不经过 runtime）、新文件【装配负对照】、
 *             旧 O8【正题】（signed 角色不读这一支；它的 not.toContain 照样成立）。
 *   M3 org/commit.ts 的 add_node 不再往 nodes 里加东西（提交照 200，节点蒸发）：
 *       该红：新文件【正题】（after 图里没有 translator）与【缺 model_family 那发】
 *             （节点根本没进 after ⇒ 家族判据无从判起 ⇒ 200 而不是 422！）、
 *             旧 O8【证据④】【六条拒绝】（pad 链第二步的上级"不存在"）、
 *             旧 O8【证据④的反向 canary/继承那发】（同理，422 变 200）。
 *       该绿：新文件【装配负对照】【反向对照】之外的…⚠ 说清楚：新文件【反向对照】
 *             也【该红】吗？—— 不。它断言的是 data 的 prompt 里有 NO_CHARTER_LINE，
 *             M3 下 data 根本没进图 ⇒ handoff 被 handoffGate 的 unknown_role 拒 ⇒
 *             r2.moved false ⇒ expect(r2.moved).toBe(true) 红。修正预测：该红。
 *             charter-route / prompt / runtime 全绿（不碰组织提交）。
 *   M4 real-deps.ts 摘掉 `charterWriter: o.queue` ⇒ buildHubDeps 装的 Hub 上
 *       POST /charter 落回 501：
 *       该红：新文件【正题】（第二跳 501 ≠ 200）。这是【新读者独有】的一发 ——
 *             旧 O8 走 runSeedCli（不经过 HTTP 装配）、charter-route 自带 harness，
 *             全仓只有新文件从 buildHubDeps 打这条写入口。
 *       该绿：新文件【装配负对照】（它本来就验 501，M4 让它绿得【与产品同形】——
 *             这正是那发负对照在 M4 下失去鉴别力的原因，记下：负对照防的是
 *             「装配白给成功」，防不了「装配根本没接」。）其余全绿。
 *
 * ⚠ 这台【写真字节】（packages/hub/src 下四个生产文件），逐发跑完立刻按原文
 *   回写并逐字节核对 ⇒ 单独跑，不许与任何测试并发。
 *   读红绿：vitest 退出码 + reporter 的【测试名】，不 grep 数字。
 *
 * 跑法：node .workbuddy/round310-mutate-o8-http.mjs
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");

const SRC = {
  prompt: "packages/hub/src/charter/prompt.ts",
  runtime: "packages/hub/src/engine/runtime.ts",
  commit: "packages/hub/src/org/commit.ts",
  realDeps: "packages/hub/src/http/real-deps.ts",
};
const T = {
  fresh: "packages/hub/test/acceptance/new-role-via-http-to-its-own-criteria.test.ts",
  old: "packages/hub/test/acceptance/new-role-to-its-own-criteria.test.ts",
  prompt: "packages/hub/test/charter/prompt.test.ts",
  runtime: "packages/hub/test/engine/runtime.test.ts",
  charterRoute: "packages/hub/test/http/charter-route.test.ts",
  orgRoute: "packages/hub/test/http/org-route.test.ts",
};

/** it 标题的子串（够认出哪一发，且不随标题里的标点漂移）。 */
const N = {
  newMain: "正题（HTTP 全链路）",
  newNeg: "反向对照（unsigned）",
  newNoFamily: "缺 model_family 的 add_node 在这条链上同样 422",
  newWiring: "没接 charterWriter ⇒ 同一份 POST /charter 得到 501",
  oldMain: "播种之后，派给它的",
  oldUnseeded: "没给它签岗位书的那个角色",
  oldPlaceholder: "播种那一格不是白给的",
  oldEvid4: "走正经路【能】加出一个节点",
  oldRejects: "每种坏形状 422 + 对的 code",
  oldInherit: "但判它的是【继承】那一格",
  pCells: "该进的格逐格出现",
  pCond: "渲染成【不合格的情形】而不是目标",
  pEscalate: "escalate 那一支渲染出目标",
  pPlaceholder: "含占位串 ⇒ 渲染【没有那条标准】",
  pMixed: "签过标准 + 仍留着一条占位",
  pNoPending: "全部签过 ⇒ 不提未签字",
  rHas: "有岗位书 ⇒ 标准/禁止项/决策范围",
  rNone: "一个版本都没有 ⇒ 明说「没有岗位书」",
  rName: "dev 的岗位书不会拼到 director",
};

/**
 * 锚点按【行数组】写，运行时按该文件自己的换行符拼（round305 实测：
 * 盘上是 CRLF 而锚点用 \n 拼 ⇒ 命中 0 次 ⇒ 真空变异）。
 */
function eolOf(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}
function anchor(text, lines) {
  return lines.join(eolOf(text));
}

const MUTATIONS = [
  {
    label: "M1 prompt.ts 已签标准那一格恒不渲染 ⇒ 第四跳的哨兵判据该全线红",
    file: SRC.prompt,
    from: ["  if (real.length > 0) {"],
    to: ["  if (false && real.length > 0) {"],
    tests: [T.fresh, T.old, T.prompt, T.runtime],
    expectRed: [
      N.newMain,
      N.oldMain,
      N.pCells,
      N.pCond,
      N.pEscalate,
      N.pMixed,
      N.rHas,
    ],
    expectGreen: [N.newNeg, N.pPlaceholder, N.pNoPending],
  },
  {
    label: "M2 runtime.ts 的「没有岗位书」那一支换成空串 ⇒ 反向对照该红",
    file: SRC.runtime,
    from: ["          ? NO_CHARTER_LINE"],
    to: ['          ? ""'],
    tests: [T.fresh, T.old, T.prompt, T.runtime],
    expectRed: [
      N.newMain,
      N.newNeg,
      N.oldUnseeded,
      N.oldPlaceholder,
      N.rNone,
      N.rName,
    ],
    expectGreen: [N.pCells, N.pPlaceholder, N.rHas, N.oldMain],
  },
  {
    label: "M3 commit.ts 的 add_node 不再加节点（200 照发、节点蒸发）⇒ 第一跳全线该红",
    file: SRC.commit,
    from: ["    nodes[change.node.role_id] = change.node;"],
    to: ["    // 变异：不加了"],
    tests: [T.fresh, T.old],
    expectRed: [
      N.newMain,
      N.newNeg,
      N.newNoFamily,
      N.oldEvid4,
      N.oldRejects,
      N.oldInherit,
    ],
    expectGreen: [N.newWiring],
  },
  {
    label: "M4 real-deps 摘掉 charterWriter 装配 ⇒ 预测【只有新文件正题】红（新读者独有的一发）",
    file: SRC.realDeps,
    from: ["    charterWriter: o.queue,"],
    to: ["    // 变异：装配不接岗位书写入口"],
    tests: [T.fresh, T.old, T.charterRoute],
    expectRed: [N.newMain],
    // ⚠ newWiring 在 M4 下【照样绿】是刻意的预测（文件头 M4 段写了原因）：
    //   那发负对照自带一份没接 charterWriter 的 Hub，它防不了「真装配也没接」。
    expectGreen: [N.newWiring, N.oldMain, N.oldUnseeded],
  },
];

const originals = new Map();
function orig(rel) {
  if (!originals.has(rel))
    originals.set(rel, readFileSync(join(ROOT, rel), "utf8"));
  return originals.get(rel);
}

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
    if (n !== 1)
      bad.push(
        "锚点命中 " + n + " 次（要恰好 1）：" + mut.from[0].slice(0, 70),
      );
  }
  if (bad.length > 0)
    throw new Error("锚点校验失败，一发不发：\n  " + bad.join("\n  "));
}

const results = [];
let fatal = "";
try {
  preflight();
  const control = runTests([
    T.fresh,
    T.old,
    T.prompt,
    T.runtime,
    T.charterRoute,
    T.orgRoute,
  ]);
  results.push([
    control.green,
    "M0 一字不改 ⇒ 新文件 + 旧 O8 + prompt + runtime + 两条路由全绿",
    control.green
      ? "全绿"
      : "意外红：" + control.names.join("、").slice(0, 500),
  ]);
  if (!control.green)
    throw new Error("控制组就红 ⇒ 后面每一发的「该红/该绿」都没有地基");

  for (const mut of MUTATIONS) {
    const text = orig(mut.file);
    const after = text.replace(anchor(text, mut.from), anchor(text, mut.to));
    // 变异必须【真的改了字节】：语义变了而字符串还在 = no-op，会红得像抓到了。
    if (text === after)
      throw new Error("变异没有改动字节，这一发不发：" + mut.label);
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
    if (got.green) problems.push("【全绿】⇒ 这一格不承重（或者锚点没抹到）");
    for (const w of mut.expectRed)
      if (!hit(w)) problems.push("该红的没红：" + w);
    for (const w of mut.expectGreen)
      if (hit(w)) problems.push("不该红的红了：" + w);
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
      console.error(
        "【致命】收尾回滚失败，立刻去 git 核对：" + rel + " ｜" + String(err),
      );
      process.exitCode = 1;
    }
  }
}

if (fatal !== "") {
  console.error("【整台机器停摆，不出命中数】" + fatal);
  process.exitCode = 1;
} else {
  let ok = 0;
  console.log(
    "══════════ round310 O8-HTTP 链变异矩阵（写生产真字节，逐发自回滚）══════════",
  );
  for (const [isHit, label, msg] of results) {
    ok += isHit ? 1 : 0;
    console.log((isHit ? "✓ " : "✗ ") + label + "\n      | " + msg);
  }
  const want = MUTATIONS.length + 1;
  console.log(
    "命中 " +
      ok +
      " / " +
      results.length +
      "（分母 = " +
      MUTATIONS.length +
      " 发变异 + 1 发控制组，数出来的）",
  );
  process.exitCode =
    ok === results.length && results.length === want ? 0 : 1;
}
