// Round379 T4 重定形的自回滚变异机（会话列表行高判据）。
// 为什么单开这一发：T4 原判据（整行 rowH < 60）被本轮的内距 10→8 【解除武装】——
// 同一发「摘掉 line-height」的变异在整行上只走到 56.73，掉到阈值以下。
// 判据换成「预览盒高 ≤ 自己的字号 × 1.45」之后，必须重新证明两件事：
//  ① 新尺子真的吃这根线（Q1 全摘 / Q2 放松到 1.5 / Q3 窄档同线 ⇒ 必须红）；
//  ② 台账与注释里那句「60 这一格抓不住内距放回」是【真话】而不是安慰话
//     （Q4 把内距放回 10 ⇒ 期望 SURVIVED；它要是被杀了，说明我写的分工是错的）。
// 所以这一发有两类判据：KILL 类要红，SCOPE 类要活。两类都不符期望才红着退。
// 每发变异【真抹字节】，跑完从原 Buffer 还原，还原后复跑控制组，SHA 必须与开局一致。
// 变异基 = 工作树原态，不是 git HEAD。
// Run: node .workbuddy/round379-t4-mutations.mjs [id 子串]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const ROOT = "D:/item/opc";
const CSS = "packages/web/public/group.css";
const SPEC = "test/e2e/group-workbench.spec.ts";
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runSpec(grepTitle) {
  const r = spawnSync(
    process.execPath,
    [
      "node_modules/@playwright/test/cli.js",
      "test",
      SPEC,
      "-g",
      grepTitle,
      "--reporter=line",
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 480_000,
      maxBuffer: 40 * 1024 * 1024,
    },
  );
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** 自证「grep 只命中一条用例」：命中多条时红了也不知道是谁，等于没有判据。 */
function matchCount(grepTitle) {
  const r = spawnSync(
    process.execPath,
    ["node_modules/@playwright/test/cli.js", "test", SPEC, "-g", grepTitle, "--list"],
    { cwd: ROOT, encoding: "utf8", timeout: 180_000, maxBuffer: 20 * 1024 * 1024 },
  );
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return (out.match(/\.spec\.ts:\d+:\d+/gu) || []).length;
}

// 唯一锚点（离线先验过命中数）：.conversation-preview 那一行。
const LH_ANCHOR = "font-size: var(--fs-sm); line-height: 1.35;";
const WIDE = "14 字放得下";
const NARROW = "12 字放得下";

const PROBES = [
  {
    // 线：预览行高显式跟着字号。摘掉声明 ⇒ 退回继承 body 的 1.55（18.59 > 17.4）⇒ 红。
    id: "Q1-erase-line-height-wide",
    from: LH_ANCHOR,
    to: "font-size: var(--fs-sm);",
    grep: WIDE,
    kind: "KILL",
  },
  {
    // 线：阈值不是「只对全摘敏感」。1.35 → 1.5 在 12px 上读 18 > 17.4，仍要红。
    id: "Q2-loosen-to-1.5",
    from: LH_ANCHOR,
    to: "font-size: var(--fs-sm); line-height: 1.5;",
    grep: WIDE,
    kind: "KILL",
  },
  {
    // 反向的一半：同一根线在窄档那条用例里也有自己的判据（两个 viewport 各自量过）。
    id: "Q3-erase-line-height-narrow",
    from: LH_ANCHOR,
    to: "font-size: var(--fs-sm);",
    grep: NARROW,
    kind: "KILL",
  },
  {
    // 这条剪的不是新判据，是【我写在注释里的那句分工】：内距 8 → 10 之后整行 58.33
    // （= pad 20 + copy 38.33）仍 < 60 ⇒ 期望 SURVIVED。它要是被杀了，说明注释里
    // 「这一格管不到内距」写错了，得改注释。
    id: "Q4-padding-back-scope",
    from: "width: 100%; padding: 8px 9px;",
    to: "width: 100%; padding: 10px 9px;",
    grep: WIDE,
    kind: "SCOPE",
  },
];

const only = process.argv[2] || "";
const SELECTED = only ? PROBES.filter((p) => p.id.includes(only)) : PROBES;
if (!SELECTED.length) {
  console.log(`没有 id 含 "${only}" 的探针`);
  process.exit(2);
}

const CSS_ABS = `${ROOT}/${CSS}`;
const before = sha(CSS_ABS);
const weird = () => {
  const CH = String.fromCharCode(0xfffd);
  const text = readFileSync(CSS_ABS, "utf8");
  return `FFFD_COUNT ${[...text].filter((c) => c === CH).length}`;
};

// ── 预检 A：锚点与变异量先查完，再开始跑用例 ──────────────────────
let bad = 0;
for (const probe of SELECTED) {
  const text = readFileSync(CSS_ABS, "utf8");
  const hits = text.split(probe.from).length - 1;
  if (hits !== 1) {
    console.log(`${probe.id}: FROM 命中 ${hits} 处（要恰好 1 处）⇒ 脚本过期`);
    bad += 1;
    continue;
  }
  if (text.replace(probe.from, probe.to) === text) {
    console.log(`${probe.id}: 变异是 no-op（字节没变）`);
    bad += 1;
  }
}
if (bad > 0) {
  console.log(`预检 A 失败 ${bad} 发 ⇒ 未改动任何字节，停`);
  process.exit(2);
}

// ── 预检 B：未变异必须绿 + grep 自证唯一 ─────────────────────────
for (const probe of SELECTED) {
  const hits = matchCount(probe.grep);
  if (hits !== 1) {
    console.log(`${probe.id}: grep "${probe.grep}" 命中 ${hits} 条用例（要恰好 1 条）⇒ 停`);
    process.exit(2);
  }
  const base = runSpec(probe.grep);
  console.log(`预检 ${probe.grep} 未变异 exit ${base.code}`);
  if (base.code !== 0) {
    console.log(`基线就是红 ⇒ 变异后的「红」不可信，先修基线：\n${base.out.slice(-2000)}`);
    process.exit(2);
  }
}

console.log(`开局 ${CSS} sha ${before.slice(0, 12)} ${weird()}`);

let asExpected = 0;
let restoredOk = 0;
for (const probe of SELECTED) {
  const original = readFileSync(CSS_ABS, "utf8");
  writeFileSync(CSS_ABS, original.replace(probe.from, probe.to), "utf8");
  const run = runSpec(probe.grep);
  const killed = run.code !== 0;
  writeFileSync(CSS_ABS, original, "utf8");
  const restored = sha(CSS_ABS) === before;
  if (restored) restoredOk += 1;
  const control = runSpec(probe.grep);
  const ok = probe.kind === "KILL" ? killed : !killed;
  if (ok) asExpected += 1;
  console.log(
    `${probe.id} [期望 ${probe.kind === "KILL" ? "KILLED" : "SURVIVED"}]: ` +
      `${killed ? "KILLED" : "SURVIVED"}（exit ${run.code}）` +
      ` / 还原后控制组 exit ${control.code} / SHA ${restored ? "一致" : "不一致"} ⇒ ${ok ? "符合期望" : "不符期望"}`,
  );
  if (!ok) console.log(run.out.slice(-2500));
  if (killed && control.code !== 0)
    console.log(`!! 控制组也红（还原后仍失败），这发的绿不可信：\n${control.out.slice(-1500)}`);
}
console.log(
  `收摊 ${CSS} sha ${sha(CSS_ABS).slice(0, 12)} ${weird()} 目标 ${before.slice(0, 12)}`,
);
console.log(
  `合计：符合期望 ${asExpected}/${SELECTED.length}，SHA 还原一致 ${restoredOk}/${SELECTED.length}`,
);
process.exit(
  asExpected === SELECTED.length && restoredOk === SELECTED.length ? 0 : 1,
);
