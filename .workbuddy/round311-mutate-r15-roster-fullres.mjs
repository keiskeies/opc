/**
 * round308 那台 roster 变异的【完整分辨率】版：mustRed 逐条点「该红的那一发用例名」，
 * 不再只判「红集合非空」。登记这条债的原话在 test/arch/claims-registry.ts 的 r15 method 里
 * （「这台要完整分辨率还欠 mustRed 逐条点该红那发」，round300 立的口径，当时登记未做）。
 *
 * ── 为什么「红集合非空」不够 ────────────────────────────────────
 * round308 的证据（.workbuddy/round308-r15-mutation-evidence.txt）里 M4 那一发只红在
 * `r15 之五的控制组` 上 —— 那是【控制组那一发】，它红只说明「判据在跑」，不说明
 * 「M4 被哪一格抓住了」。按旧口径它算命中 5/5；按本台的口径它是【点不到名】。
 * 一个恒非空的红集合可以让任何一发变异都算命中，而那一格其实没被测过。
 *
 * ── 判据形状（照 round300 那台，四条失效各防一次历史上真中过的事故）────────
 *  a) 剥 ANSI 不生效 ⇒ 摘要行前留着 ESC ⇒ 抛，不当「没红」；
 *  b) 读不到 `Tests` 摘要行 ⇒ 抛（当 0 就是把红读成绿，整张矩阵假绿）；
 *  c) 文件级装载失败时 `Tests` 报「红发 0」⇒ 必须并上 `Test Files`，
 *     且那种 FAIL 行【没有用例名】⇒ 不许硬造名字；
 *  d) 红了但读不到 FAIL 行的文件名 ⇒ 抛（归因失真比不判更坏）。
 * 外加装载期一条：SPEC 里逐字钉的用例名必须真在那份测试文件的源码里 ——
 * 点不到名的 mustRed 是一条【永假判据】，它换来的每一次「未命中」都是假故障。
 *
 * ── 跑法 ──────────────────────────────────────────────────────
 *   node .workbuddy/round311-mutate-r15-roster-fullres.mjs --self-check   # 不碰盘、不起 vitest
 *   node .workbuddy/round311-mutate-r15-roster-fullres.mjs               # 打盘：必须单独跑
 * ⚠ 打盘那一路会临时改 packages/hub/test/acceptance/ 那份真测试的字节（逐字节回滚）。
 *   任何时刻它都【不许】与别的东西并发跑（含另一个 agent 的 vitest）—— 这条纪律本轮真踩过：
 *   并发的读数会让一整族测试先红后绿。
 *
 * ⚠ 本机【预期命中 4/5，那 1 发缺的不是这台坏了】：M4 在 round308 就是被诱饵中和的那一发
 *   （round308-r15-mutation-evidence.txt 里它只红在 `r15 之五的控制组` 上，诱饵注释抢在
 *   replace 的锚点前面把变异自己抵掉了）。点名之后它【点不到 T_ZHI7B】= 量出来的分辨率，
 *   不是缺陷 —— 别为了让它变 5/5 去放宽点名口径。切片边界那一格的证据是守卫里
 *   【合成】喂进去的那发「之七·乙」，不在【磁盘】这一发上；两者不是一回事，别互相顶替。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_REL = join(
  "packages",
  "hub",
  "test",
  "acceptance",
  "new-role-to-its-own-criteria.test.ts",
);
const TARGET = join(ROOT, TARGET_REL);
const GUARD_REL = join("test", "arch", "claims-registry.test.ts");
const GUARD = join(ROOT, GUARD_REL);
const ESC = String.fromCharCode(27);
const SELF_CHECK = process.argv.includes("--self-check");

/** 逐字抄自 GUARD 的 it 标题（少一个字这台就在装载期报「点不到名」）。 */
const T_CONTROL =
  "⭐ r15 之五的控制组：一字不改 ⇒ 返回空（否则上面三发红在变异之外）";
const T_ZHI7 =
  "⭐⭐ 变异 r15 之七：名单里 add_edge 那一格被放宽成空 ⇒ 红（round308 补的那格）";
const T_ZHI7B =
  "⭐ 变异 r15 之七·乙：把名单写进【切片之外】的注释而清空真名单 ⇒ 仍红（切片边界有牙）";
const T_ZHI8 =
  "⭐ 变异 r15 之八：名单的止锚改名 ⇒ 红在「名单边界读不到」，不退回全文搜";

/** 每发：id / 该不该红 / 该红在哪一发用例名上 / 该保持绿的是哪一发 / 怎么抹。 */
const SPECS = [
  {
    id: "M0",
    note: "控制组：行尾加一句空注释 ⇒ 该绿（防判据恒红）",
    expectRed: false,
    mustRedTests: [],
    mustGreenTests: [T_ZHI7],
    apply: (t) =>
      t.replace(
        "    const consolePath = CONSOLE_JS;",
        "    const consolePath = CONSOLE_JS; // control\n",
      ),
  },
  {
    id: "M1",
    note: "add_edge 那一格放宽成空名单 ⇒ 该红在【之七本体】",
    expectRed: true,
    mustRedTests: [T_ZHI7],
    mustGreenTests: [],
    apply: (t) => t.replace("add_edge: [consolePath],", "add_edge: [],"),
  },
  {
    id: "M2",
    note: "reparent 换成另一个路径常量 ⇒ 该红（名单还在但不再指名 app.js）",
    expectRed: true,
    mustRedTests: [T_ZHI7],
    mustGreenTests: [],
    apply: (t) =>
      t.replace("reparent: [consolePath],", 'reparent: ["some/other/file.js"],'),
  },
  {
    id: "M3",
    note: "止锚那行改名 ⇒ 该红在「名单边界读不到」那一族",
    expectRed: true,
    mustRedTests: [T_ZHI8],
    mustGreenTests: [],
    apply: (t) => t.replaceAll("// ② 前提自证", "// ② PREMISE RENAMED"),
  },
  {
    id: "M4",
    note:
      "清空真名单 + 同一行上方留一句【带同样字节】的诱饵注释 ⇒ round308 实测只红在控制组上" +
      "（诱饵抢在 replace 锚点前面把变异中和）。点名之后这一发点不到名字 = 量出来的分辨率",
    expectRed: true,
    mustRedTests: [T_ZHI7B],
    mustGreenTests: [],
    apply: (t) =>
      t
        .replace("add_edge: [consolePath],", "add_edge: [],")
        .replace(
          "    expect(emitters).toEqual({",
          "    /* 诱饵：add_edge: [consolePath], */\n    expect(emitters).toEqual({",
        ),
  },
];

/** 装载期：钉住的用例名必须真的写在那份守卫测试里，否则点名判据永假。 */
function checkPins() {
  const src = readFileSync(GUARD, "utf8");
  const bad = [];
  for (const spec of SPECS) {
    for (const t of [...spec.mustRedTests, ...spec.mustGreenTests]) {
      if (!src.includes(t)) {
        bad.push(spec.id + " 钉的用例名不在 " + GUARD_REL + " 里 ⇒ 永假判据：" + t);
      }
    }
  }
  if (bad.length > 0) throw new Error(bad.join("\n"));
}

/**
 * 从 vitest 输出里读「红了几发 / 红了哪几份文件 / 红了【哪几发用例名】」。
 * 四条失效各防一次真事故，逐条见文件头。
 */
function readSummary(out) {
  const clean = out.replace(new RegExp(ESC + "\\[[0-9;]*m", "g"), "");
  if (clean.indexOf(ESC) !== -1) {
    throw new Error("剥 ANSI 没生效（剥完输出里还剩 ESC 字节）—— 摘要行会读不到");
  }
  const m = clean.match(/^\s*Tests\s+(.+)$/mu);
  if (m === null) {
    throw new Error(
      "读不到 vitest 的「Tests」摘要行 —— 【不能】当 0 处理：那会把红读成绿。尾部：\n" +
        clean.slice(-800),
    );
  }
  const seg = m[1] ?? "";
  const failedTests = Number((seg.match(/(\d+) failed/u) ?? [0, "0"])[1]);
  const passed = Number((seg.match(/(\d+) passed/u) ?? [0, "0"])[1]);
  const files = new Set();
  const tests = new Set();
  for (const line of clean.split("\n")) {
    const fm = /^\s*FAIL\s+(\S+\.(?:ts|tsx))\b/u.exec(line);
    if (fm === null || fm[1] === undefined) continue;
    files.add(fm[1].split("\\").join("/"));
    const gt = line.indexOf(">");
    if (gt >= 0) {
      const name = line.slice(gt + 1).split(">").pop().trim();
      if (name !== "") tests.add(name);
    }
  }
  const tf = clean.match(/^\s*Test Files\s+(.+)$/mu);
  if (tf === null) {
    throw new Error(
      "读不到 vitest 的「Test Files」摘要行 —— 同「Tests」那条纪律。尾部：\n" +
        clean.slice(-400),
    );
  }
  const failedFiles = Number((tf[1].match(/(\d+) failed/u) ?? [0, "0"])[1]);
  if (failedFiles > 0 && files.size === 0) {
    throw new Error(
      "有 " +
        failedFiles +
        " 份文件红了但【读不到 FAIL 行的文件名】⇒ 归因失真。尾部：\n" +
        clean.slice(-800),
    );
  }
  return {
    failed: failedTests + failedFiles,
    failedTests,
    failedFiles,
    passed,
    files,
    tests,
  };
}

/** 这台自己的自证：不打产品，只验【读摘要的那只手】读得对。不碰盘、不起子进程。 */
function selfCheck() {
  const problems = [];
  let checks = 0;
  const colored =
    " " + ESC + "[41m" + ESC + "[1m FAIL " + ESC + "[22m" + ESC + "[49m " +
    "test/arch/claims-registry.test.ts > 主张登记表：判据本身 > " + T_ZHI7 + "\n" +
    "AssertionError: expected '…' to be ''\n" +
    " Test Files  " + ESC + "[31m1 failed" + ESC + "[39m (1)\n" +
    "      Tests  " + ESC + "[31m1 failed" + ESC + "[39m | 157 passed (158)\n";
  try {
    const s = readSummary(colored);
    if (s.failedTests !== 1) problems.push("自证①：用例红 = " + s.failedTests + "（要 1）");
    if (s.failedFiles !== 1) problems.push("自证①：文件红 = " + s.failedFiles + "（要 1）");
    if (!s.files.has("test/arch/claims-registry.test.ts"))
      problems.push("自证①：色码里没归因到那份文件");
    if (!s.tests.has(T_ZHI7))
      problems.push("自证①：用例名没读出来 ⇒ 点名判据会全成假未命中");
  } catch (e) {
    problems.push("自证① 抛：" + String(e instanceof Error ? e.message : e).slice(0, 160));
  }
  checks += 1;
  // ② 装载期失败：FAIL 行没有用例名 ⇒ 只许归因到文件，不许硬造名字。
  try {
    const s = readSummary(
      " FAIL  test/arch/claims-registry.test.ts [ test/arch/claims-registry.test.ts ]\n" +
        "Error: Transform failed with 1 error:\n" +
        " Test Files  1 failed | 32 passed (33)\n" +
        "      Tests  534 passed (534)\n",
    );
    if (s.failed <= 0) problems.push("自证②：文件级失败被读成了绿");
    if (s.tests.size !== 0) problems.push("自证②：装载失败被【造】出了用例名");
  } catch (e) {
    problems.push("自证② 抛：" + String(e instanceof Error ? e.message : e).slice(0, 160));
  }
  checks += 1;
  // ③ 全绿读成绿（M0 只有在这判过之后才算数）。
  try {
    const s = readSummary(" Test Files  1 passed (1)\n      Tests  158 passed (158)\n");
    if (s.failed !== 0) problems.push("自证③：failed = " + s.failed + "（全绿不许读成红）");
    if (s.passed !== 158) problems.push("自证③：passed = " + s.passed + "（要 158）");
  } catch (e) {
    problems.push("自证③ 抛：" + String(e instanceof Error ? e.message : e).slice(0, 160));
  }
  checks += 1;
  // ④ 读不到摘要 ⇒ 抛，而不是当 0。
  try {
    readSummary("vitest 没跑起来，随便一句话\n");
    problems.push("自证④：读不到摘要被静默吞掉了（那是把红读成绿的那条路）");
  } catch {
    /* 抛 = 对 */
  }
  checks += 1;
  // ⑤ 钉住的用例名在守卫源码里存在（永假判据那一格）。
  try {
    checkPins();
  } catch (e) {
    problems.push("自证⑤ 抛：" + String(e instanceof Error ? e.message : e).slice(0, 240));
  }
  checks += 1;
  for (const p of problems) console.log("✘ " + p);
  console.log(
    "机器自证 " +
      (problems.length === 0 ? checks : checks - problems.length) +
      "/" +
      checks +
      " 通过（色码+用例名归因 / 装载失败不造名字 / 全绿读成绿 / 读不到摘要就抛 / 钉的名字真存在）",
  );
  process.exit(problems.length === 0 ? 0 : 1);
}

if (SELF_CHECK) selfCheck();

checkPins();
const ORIGINAL = readFileSync(TARGET, "utf8");

function runOne(spec) {
  const mutated = spec.apply(ORIGINAL);
  if (mutated === ORIGINAL) {
    return { id: spec.id, verdict: "空变异（字节没动）", summary: null };
  }
  writeFileSync(TARGET, mutated);
  const r = spawnSync(
    process.execPath,
    [
      join(ROOT, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "test/arch/claims-registry.test.ts",
      "-t",
      "r15",
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 },
  );
  return {
    id: spec.id,
    summary: readSummary(String(r.stdout) + String(r.stderr)),
  };
}

/** 点名判定：该红的每一发都要在红名单里；该绿的每一发都不许在。 */
function judge(spec, s) {
  const miss = spec.mustRedTests.filter((t) => !s.tests.has(t));
  const extra = spec.mustGreenTests.filter((t) => s.tests.has(t));
  const red = s.failed > 0;
  const problems = [];
  if (red !== spec.expectRed) {
    problems.push(spec.expectRed ? "预测该红而读成绿" : "预测该绿而红了");
  }
  if (miss.length > 0) problems.push("点不到名：" + miss.join(" ｜ "));
  if (extra.length > 0) problems.push("该绿的红了：" + extra.join(" ｜ "));
  return problems;
}

const rows = [];
for (const spec of SPECS) {
  const res = runOne(spec);
  writeFileSync(TARGET, ORIGINAL); // 无条件还原，红也还原
  const restored = readFileSync(TARGET, "utf8") === ORIGINAL;
  if (res.summary === null) {
    rows.push({ id: spec.id, restored, problems: ["空变异"] });
    console.log("✘ " + spec.id + " 空变异（字节没动）｜还原=" + restored);
    continue;
  }
  const problems = judge(spec, res.summary);
  rows.push({ id: spec.id, restored, problems });
  console.log(
    `${problems.length === 0 ? "✔" : "✘"} ${spec.id} ${spec.expectRed ? "该红" : "该绿"}` +
      `｜红发=${res.summary.failedTests} 红文件=${res.summary.failedFiles}` +
      `｜还原逐字节一致=${restored}｜${spec.note}`,
  );
  for (const p of problems) console.log("    ⚠ " + p);
  if (res.summary.tests.size > 0) {
    console.log("    红的用例名：" + [...res.summary.tests].join(" ｜ "));
  }
}
const hits = rows.filter((x) => x.problems.length === 0).length;
const restoredAll = rows.every((x) => x.restored);
console.log(
  "\n命中 " +
    hits +
    "/" +
    rows.length +
    "｜全部还原=" +
    restoredAll +
    "｜当前文件与开头读到的是否逐字一致=" +
    (readFileSync(TARGET, "utf8") === ORIGINAL),
);
console.log(
  "口径：命中 = 退出码方向对 【且】 每一条 mustRed 都在红的用例名里 【且】 mustGreen 一条都不在。",
);
console.log(
  "读法：✘ 的两种含义相反 —— 「点不到名」= 这一发在磁盘上【没有分辩力】（round308 的 M4 就是那格），",
);
console.log("      而「该绿的红了 / 预测该红而读成绿」= 判据或预测本身有问题。别混着修。");
process.exit(hits === rows.length && restoredAll ? 0 : 1);
