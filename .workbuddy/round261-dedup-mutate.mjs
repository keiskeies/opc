// round261（0061）变异探针 · 审批去重键收窄
//
// 用法（在本仓根目录）：
//   node .workbuddy/round261-dedup-mutate.mjs M1
//   node .workbuddy/round261-dedup-mutate.mjs M2
//   node .workbuddy/round261-dedup-mutate.mjs M3sql
//   node .workbuddy/round261-dedup-mutate.mjs M3ts
//   node .workbuddy/round261-dedup-mutate.mjs M4
//   node .workbuddy/round261-dedup-mutate.mjs none excise   ← 对照组
//
// 三条立场，每条都对应本轮真实踩过的一次假读数（0061 §5）：
//  ① 变异【必须证明落到了字节上】：改完比对 sha256，没变就 NOT APPLIED 退出。
//     否则「红发 0」会被读成「这个变异无害」，而真相是「我什么都没改」。
//  ② 探针【必须证明自己跑了】：输出里没有汇总行就 exit 4 并打前 1200 字节。
//     上一版用 execFileSync("npx") —— 本机 npx 是 npx.cmd，无 shell 时 ENOENT，
//     输出是空串，于是 M1（把索引退回 0004，必须红）报出「红发 0」。
//     「探针死了」与「变异无害」在输出上完全一样，这是本轮最贵的一条。
//  ③ 红了【不等于因为我改的那一格红的】：断言明细一起打出来。
//     M3ts 那一发补完之后，必须能看出它红在承重那条
//     （expected [ 't1' ] to deeply equal []）而不是红在我写的前置断言上。
//
// 读数（2026-11-16 实跑，套件 = 三个相关文件；mutfull 模式跑全套）：
//   M1    去掉索引的 status 条件（退回 0004）      → 4 红
//   M2    索引整个拿掉（模拟"干脆不去重"）          → 7 红 ← 唯一能证明「收窄 ≠ 没索引」的一发
//   M3sql 两处逐字相同的 SQL 筛只认 pending        → 2 红（失效方式：白烧一轮 token）
//   M3ts  TS 侧前置检查只认 pending               → 补测试前【全套 2543 发 0 红】，补后 1 红
//   M4    把那道 TS 检查整行删掉                   → 2 红（与新补那发从两个方向钉同一条件）
//   none/excise  只摘掉新补的那发、不做变异（对照组）→ 0 红，2543 通过
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [MUT, EXCISE] = process.argv.slice(2);
if (!MUT) {
  process.stderr.write("用法：node 本文件 M1|M2|M3sql|M3ts|M3|M4|none [excise] [full]\n");
  process.exit(1);
}
const FULL = process.argv.includes("full") || EXCISE === "excise";

const MIG = "packages/hub/resources/migrations/0006_approval_dedup_pending_only.sql";
const PUMP = "packages/hub/src/serve/charter-pump.ts";
const TEST = "packages/hub/test/serve/charter-pump.test.ts";
const NEW_TITLE = "⭐ 泵跑着的时候 CEO 把卡批了 ⇒ 那一轮仍不给它写「不再试了」";
const SUITE = [
  "packages/hub/test/acceptance/rejected-waiver-still-asks.test.ts",
  "packages/hub/test/approvals/cards.test.ts",
  TEST,
];

const sha = (f) =>
  createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 12);
const ALL = [MIG, PUMP, TEST];
const base = {};
const orig = {};
for (const f of ALL) {
  base[f] = sha(f);
  orig[f] = readFileSync(f, "utf8");
}

function restore() {
  for (const f of ALL) writeFileSync(f, orig[f]);
  const bad = ALL.filter((f) => sha(f) !== base[f]);
  if (bad.length > 0) {
    process.stderr.write("!!! 还原失败，工作树被留下改动：" + bad.join(",") + "\n");
    process.exit(3);
  }
}

const INDEX_DDL =
  "CREATE UNIQUE INDEX idx_approvals_card_identity\n" +
  "  ON approvals(task_id, card_key)\n" +
  "  WHERE card_key IS NOT NULL AND status = 'pending';";

const TS_CHECK = "SELECT 1 AS x FROM approvals WHERE task_id = ? AND card_key = ? LIMIT 1";
const SQL_FILTER = "SELECT 1 FROM approvals a WHERE a.task_id = t.id AND a.card_key = ?";

function apply() {
  if (EXCISE === "excise") {
    const src = orig[TEST];
    const start = src.indexOf('  it("' + NEW_TITLE);
    if (start < 0) throw new Error("摘不到那一发（标题变了？先读源码）");
    const end = src.indexOf("\n  });\n", start);
    if (end < 0) throw new Error("找不到那一发的结尾");
    const body = src.slice(0, start) + src.slice(end + "\n  });\n".length);
    if (body.includes(NEW_TITLE)) throw new Error("摘完还剩着，摘得不完整");
    writeFileSync(TEST, body);
    process.stderr.write("已摘掉那一发（" + (src.length - body.length) + " 字节）\n");
    if (MUT === "none") return; // 对照组：只摘测试，不动生产代码
  }
  if (MUT === "M1") {
    const to =
      "CREATE UNIQUE INDEX idx_approvals_card_identity\n" +
      "  ON approvals(task_id, card_key)\n" +
      "  WHERE card_key IS NOT NULL;";
    if (!orig[MIG].includes(INDEX_DDL)) throw new Error("M1 锚点没找到");
    writeFileSync(MIG, orig[MIG].replace(INDEX_DDL, to));
  } else if (MUT === "M2") {
    if (!orig[MIG].includes(INDEX_DDL)) throw new Error("M2 锚点没找到");
    writeFileSync(MIG, orig[MIG].replace(INDEX_DDL, "-- M2：索引被拿掉"));
  } else if (MUT.startsWith("M3")) {
    const SITES = [
      { tag: "sql", from: SQL_FILTER, to: SQL_FILTER + " AND a.status = 'pending'" },
      { tag: "ts", from: TS_CHECK, to: TS_CHECK.replace("LIMIT 1", "AND status = 'pending' LIMIT 1") },
    ];
    const want = MUT === "M3" ? ["sql", "ts"] : [MUT.slice(2)];
    let body = orig[PUMP];
    for (const s of SITES) {
      if (!want.includes(s.tag)) continue;
      const n = body.split(s.from).length - 1;
      if (n < 1) throw new Error(MUT + " 锚点没找到，先读源码");
      process.stderr.write(MUT + " [" + s.tag + "] 命中 " + n + " 处\n");
      body = body.split(s.from).join(s.to);
    }
    writeFileSync(PUMP, body);
  } else if (MUT === "M4") {
    const from = "    if (hasCard !== undefined) continue;";
    if (!orig[PUMP].includes(from)) throw new Error("M4 锚点没找到");
    writeFileSync(PUMP, orig[PUMP].replace(from, "    // M4：这道 hasCard 检查被拿掉"));
  } else if (MUT !== "none") {
    throw new Error("未知变异：" + MUT);
  }
  const touched = MUT === "M1" || MUT === "M2" ? [MIG] : [PUMP];
  if (MUT === "none" && EXCISE === "excise") touched.push(TEST);
  for (const f of touched) {
    if (sha(f) === base[f]) throw new Error("NOT APPLIED（字节没变）：" + f);
  }
}

let out = "";
try {
  apply();
} catch (e) {
  restore();
  process.stderr.write("!!! " + e.message + " —— 已还原，没跑测试\n");
  process.exit(1);
}

try {
  out = execFileSync(
    process.execPath,
    ["node_modules/vitest/vitest.mjs", "run", ...(FULL ? [] : SUITE)],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
  );
} catch (e) {
  out = (e.stdout ?? "") + (e.stderr ?? "");
}
restore();

if (!/Test Files/.test(out)) {
  process.stderr.write(
    "!!! PROBE DID NOT RUN（输出里没有汇总行）—— 这不是「没有红」，是探针没跑。前 1200 字节：\n" +
      out.slice(0, 1200) + "\n",
  );
  process.exit(4);
}

const lines = out.split(/\r?\n/);
const fails = lines
  .filter((l) => /^\s+(×|✕)/.test(l))
  .map((l) => l.replace(/^\s+/, "").trim());
const detail = lines
  .filter((l) => /(AssertionError|expected |Error:)/.test(l))
  .map((l) => l.replace(/^\s+/, "").slice(0, 170));
const summary = lines
  .filter((l) => /Tests {2}|Test Files {2}/.test(l))
  .map((l) => l.trim())
  .join("  ||  ");
process.stdout.write(
  "### " + MUT + (EXCISE ? "/" + EXCISE : "") + "\n" + summary + "\n红发 " +
    fails.length + " 发\n" + fails.join("\n") +
    "\n--- 断言明细（红了要能看出是因为哪一格）---\n" + detail.join("\n") + "\n",
);
