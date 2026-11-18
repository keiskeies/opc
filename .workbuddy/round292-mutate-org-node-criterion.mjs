/**
 * round292 · O8 动作 1：「提交时逐节点判 model_family」这条守卫有没有牙齿。
 *
 * 跑法：node .workbuddy/round292-mutate-org-node-criterion.mjs
 *
 * 打的是【生产代码】，不是测试。每一发抹掉一处真实实现，跑那三份测试，逐字节还原。
 *
 * ── 为什么有一发【该绿】 ────────────────────────────────────────────────
 * M2（改判 before 而不是 after）是【变异等价】的：applyChangeToGraph 对
 * reparent 只改 reports_to、对 add_edge 只加一条边，【两种 kind 都不碰任何
 * model_family】⇒ 判 before 与判 after 在这条判据上恒同解。
 * 于是没有任何测试该为它红。把它列进来并标 expectRed:false，是为了把这件事
 * 记成【量过的结论】而不是我的断言：这条守卫的「判 after」这个写法
 * 【不是】它可靠的原因，可靠的原因是它判【整张图】（M6 那一发才是它的证人）。
 * 反过来，如果哪天 applyChangeToGraph 开始改 model_family，M2 会【变成红】——
 * 那时它就不等价了，而这条记录会提醒下一个人重新看这一格。
 *
 * ⚠ 三条从 round291 带来的纪律（那份脚本当场把自己的文件写坏过一次）：
 *  ① 还原写【进场时读到的字节】，不用 replace 反推 —— 有些 `to` 是 `orig` 的子串；
 *  ② 还原在 finally 里，且在【校验之前】—— 否则 throw 会把变异永久留在文件里；
 *  ③ 所有锚点在第一发跑【之前】全部验一遍（plan()）—— round291 的 M2 锚点
 *     是格式化前的旧形状，那一发【从来没跑过】而没人发现。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** 变异打的测试：判据本体 + 提交路径 + 那条端到端。 */
const TEST_FILES = [
  "test/org/validate.test.ts",
  "test/org/versioning.test.ts",
  "packages/hub/test/acceptance/new-role-to-its-own-criteria.test.ts",
];

const COMMIT = "packages/hub/src/org/commit.ts";
const VALIDATE = "packages/contracts/src/org/validate.ts";

const results = [];
/** @type {{rel:string,from:string,to:string,label:string,expectRed:boolean,note:string}[]} */
const MUTATIONS = [];

function mutate(rel, from, to, label, expectRed, note) {
  MUTATIONS.push({ rel, from, to, label, expectRed, note });
}

/* ── M1：把判据从提交路径上摘掉（判据还在，但没人调）────────────────── */
mutate(
  COMMIT,
  "  if (!families.ok) return { ok: false, reason: families.reason, code: families.code };",
  "  if (false && !families.ok) return { ok: false, reason: families.reason, code: families.code };",
  "M1 提交路径不再采纳这条判据",
  true,
  "旁路该重新变回 200；端到端那一发与 commit 层那两发都该红",
);

/* ── M2：改判 before（o.graph）而不是 after —— 预期【绿】，变异等价 ───── */
mutate(
  COMMIT,
  "  const families = everyNodeDeclaresModelFamily(after);",
  "  const families = everyNodeDeclaresModelFamily(o.graph);",
  "M2 判 before 而不是 after（变异等价，该绿）",
  false,
  "applyChangeToGraph 不碰 model_family ⇒ 两种写法恒同解；红了说明有测试在判别的不是这条判据",
);

/* ── M3：只看 undefined，丢掉 trim ─────────────────────────────────────
 * 这是「yaml 里 model_family: 后面留空」那一格：读进来是空串/空格，不是 undefined。 */
mutate(
  VALIDATE,
  '    if (fam === undefined || fam.trim() === "") {',
  "    if (fam === undefined) {",
  "M3 空串/纯空格不再算缺（只判 undefined）",
  true,
  "该红在 test/org/validate.test.ts 那发「空串与纯空格同判」",
);

/* ── M4：拒绝理由里不点名角色 ─────────────────────────────────────────
 * 判据仍拦，但 CEO 拿到一句「有节点没配家族」而不知道该改哪一个。
 * 这一发红的是【可用性】那一格，不是安全那一格 —— 分开写是因为它们会被分开修。 */
mutate(
  VALIDATE,
  "        `角色 [${id}] 未声明 model_family，这次组织变更不予提交。` +",
  '        "某个角色未声明 model_family，这次组织变更不予提交。" +',
  "M4 理由里不点名是哪个角色",
  true,
  "该红在 test/org/validate.test.ts 那发「reason 里点名角色」",
);

/* ── M5：退回「只判这次变更涉及的节点」＝ 三层判据原来的射程 ───────────
 * 这一发要把守卫改回它补的那三层各自的样子：只看这次改动碰到的节点。
 * 它挡不住 ghost（ghost 不在那条边上），所以端到端与 validate 的反向 canary 该红。 */
mutate(
  COMMIT,
  "  const families = everyNodeDeclaresModelFamily(after);",
  `  const families = (() => {
    const ids =
      o.change.kind === "add_edge"
        ? [o.change.edge.from, o.change.edge.to]
        : [o.change.child_role, o.change.new_parent_role];
    for (const i of ids) {
      const f = after.nodes[i]?.model_family ?? "";
      if (f.trim() === "") {
        return { ok: false, reason: "边端点缺家族", code: "unknown_model_family" };
      }
    }
    return { ok: true };
  })();`,
  "M5 只判这次变更涉及的节点（退回三层的射程）",
  true,
  "ghost 不在那条边上 ⇒ 旁路复活；反向 canary 该红",
);

/* ── M6：「只判新增节点」那个恒真版本 —— 本轮我确实先写过它 ────────────
 * 这是全组最有牙齿的一发。它看起来【比正确版本更精准】（「只判这次新加的嘛，
 * 合理」），而它对旁路【恒为空】：applyChangeToGraph 两种 kind 都把 before.nodes
 * 原样展开，所以偷偷塞进来的节点在 before 里【也在】⇒ 差集为空 ⇒ 双向恒真。
 * 如果这一发【绿】，说明本组测试抓不住「把守卫精准化到什么都不判」这种改法，
 * 而那是本仓最贵的一族缺陷（一条看起来更合理的恒真断言）。 */
mutate(
  COMMIT,
  "  const families = everyNodeDeclaresModelFamily(after);",
  "  const families = everyNodeDeclaresModelFamily({\n    nodes: Object.fromEntries(\n      Object.entries(after.nodes).filter(([id]) => !(id in o.graph.nodes)),\n    ),\n    edges: [],\n  });",
  "M6 「只判新增节点」—— 看着更精准的那一版恒真",
  true,
  "旁路节点在 before 里也在 ⇒ 差集为空 ⇒ 拦不到；本组必须抓住这种改法",
);

/* ── 锚点先全部验一遍，再跑第一发 ───────────────────────────────────── */
function plan() {
  const originals = new Map();
  const bad = [];
  for (const m of MUTATIONS) {
    const text = originals.get(m.rel) ?? readFileSync(join(ROOT, m.rel), "utf8");
    originals.set(m.rel, text);
    const hits = text.split(m.from).length - 1;
    if (hits !== 1) bad.push(m.rel + " :: [" + m.label + "] 锚点命中 " + hits + " 次（要恰好 1 次）");
    if (m.to === m.from) bad.push(m.rel + " :: [" + m.label + "] to 与 from 相同 = 空变异");
  }
  if (bad.length > 0) {
    console.error("锚点校验失败，【一发都没跑】：\n  " + bad.join("\n  "));
    process.exit(1);
  }
  return originals;
}

/**
 * 从 vitest 的输出里读「红了几发 / 红了几份文件」。
 *
 * ⚠ 两个坑，都是实测撞到的（第一版两个都中了，于是 M1~M6 全部读成「红发=0」，
 *    而 expectRed 那几发因此【判成未命中】—— 一个把红读成绿的解析器，
 *    比没有解析器更坏：它会安静地让整张变异矩阵失去意义）：
 *  ① vitest 在标签与数字之间夹了 ANSI：真实字节是
 *    "\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m43 passed\u001b[39m"，
 *    所以【必须先剥 ANSI】再 match。
 *  ② 全绿时它【不打印 failed 那一段】（只有 "43 passed (43)"）。
 *    所以「读不到 failed」有两种含义：真的全绿，或者格式变了。
 *    两者必须分开 —— 格式变了要【当场抛】，不能当 0。判据是那一行摘要本身在不在。
 */
function readSummary(out, wantFail) {
  const clean = out.replace(/\u001b\[[0-9;]*m/g, "");
  const grab = (label) => {
    const m = clean.match(new RegExp("^\\s*" + label + "\\s+(.+)$", "m"));
    if (m === null) {
      throw new Error(
        "读不到 vitest 的「" + label + "」摘要行 —— 输出格式变了或被别的输出污染了。" +
          "【不能】当 0 处理：那会把红读成绿，整张矩阵会假绿。摘要尾部：\n" +
          clean.slice(-600),
      );
    }
    const seg = m[1];
    const failed = Number((seg.match(/(\d+) failed/) ?? [0, "0"])[1]);
    const passed = Number((seg.match(/(\d+) passed/) ?? [0, "0"])[1]);
    return { failed, passed };
  };
  const files = grab("Test Files");
  const tests = grab("Tests");
  if (wantFail !== undefined && (tests.failed > 0) !== wantFail) {
    // 控制组专门用来证明上面这套解析【真的能分辨红与绿】。
    throw new Error(
      "控制组形状不对：期望" + (wantFail ? "红" : "绿") + "，实际 红发=" + tests.failed,
    );
  }
  return { files, tests };
}

function run(label, expectRed, note) {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", ...TEST_FILES],
    { cwd: ROOT, encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 },
  );
  const out = String(r.stdout) + String(r.stderr);
  // 控制组（label 以 M0 开头）额外自证解析器能分辨红绿。
  const { files, tests } = readSummary(out, label.startsWith("M0") ? false : undefined);
  const hit = expectRed ? tests.failed > 0 : tests.failed === 0;
  results.push([
    hit,
    label,
    expectRed ? "应红" : "应绿",
    "红发=" + tests.failed + " 绿发=" + tests.passed + " 红文件=" + files.failed,
    "",
    note,
  ]);
  console.log(
    (hit ? "  命中    " : "  未命中  ") +
      label +
      "  [" +
      (expectRed ? "应红" : "应绿") +
      "]  红发=" +
      tests.failed +
      " 红文件=" +
      files.failed,
  );
}

function execute(m, originals) {
  const p = join(ROOT, m.rel);
  const orig = originals.get(m.rel);
  writeFileSync(p, orig.replace(m.from, m.to));
  let restored = false;
  try {
    run(m.label, m.expectRed, m.note);
  } finally {
    writeFileSync(p, orig);
    restored = readFileSync(p, "utf8") === orig;
  }
  if (!restored) throw new Error("还原后字节不一致，必须手工修：" + m.rel);
}

const originals = plan();

run("M0 控制组：一字不改", false, "绿是后面每一发红的前提；同时自证这台上的计数读得出红与绿");
for (const m of MUTATIONS) execute(m, originals);

console.log("\n══════════ round292 变异矩阵 ══════════");
let ok = 0;
for (const [hit, label, want, state, err, note] of results) {
  ok += hit ? 1 : 0;
  console.log((hit ? "✓" : "✗") + " " + label + "  [" + want + "] " + state + " | " + note + " | " + err);
}
console.log("命中 " + ok + " / " + results.length);
process.exitCode = ok === results.length ? 0 : 1;
