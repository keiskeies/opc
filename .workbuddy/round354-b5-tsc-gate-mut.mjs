/**
 * round354 B5 变异机（tsc 硬门）：test/ 纳入 0 错硬门（根 tsconfig.test.json）的自回滚证据。
 * 照 round342/351/352 的形状：读文件→字节级变异→写回→跑【目标命令】→记录命中→
 * 恢复原内容→逐字节核对 + 打印 reverted: true。
 *
 * ── 这台机器要回答的唯一问题 ──────────────────────────────────
 * B5（CEO 2026-11-22 拍板，0007 §5）把 test/ 清到 0 错并接成【硬门】：
 * `pnpm typecheck` 末尾的 `tsc -p tsconfig.test.json --noEmit`。
 * 语料清了、脚本接了，都不等于【门真的承重】—— 每一发变异都【真抹一个测试文件
 * 的字节】，去验证这条门确实能把新增的一条测试类型错挡红：
 *  M1 往一个测试文件尾部插一条 `const x: number = "字符串"` ⇒ 门红（exit≠0，
 *    且报出来的正是被插那行）—— 证明【新增】的测试类型错过不了这条门。
 *  M2 一字不改 ⇒ 门绿（exit 0）—— 控制组，证明这条门今天确实放行一份干净语料。
 *
 * ⚠ 与 round352 的差异：读红绿靠的是 tsc 的【退出码 + 报错行】，不是 vitest 测试名。
 *   目标是「一条测试类型错」，天然只有 tsc 看得见（vitest 只跑运行时，类型错不进
 *   运行时）—— 这正是 B5 要堵的那类洞（本仓「tsc 绿但测试文件是坏的」踩过四次）。
 *
 * ⚠ 跑法（仓根）：node .workbuddy/round354-b5-tsc-gate-mut.mjs
 *   写真字节 ⇒ 单独跑，不与任何测试并发（round292 (b)）。只动一个测试文件，不碰全量。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
// 变异宿主：一个真实测试文件。选 policy.test.ts 只因为它在 test/ 语料里、
// 与 B5 的「新增测试类型错」同面 —— 换成任何其它测试文件结论一样，不因宿主而变。
const SRC = "packages/hub/test/search/policy.test.ts";
// 门本体：B5 接进 pnpm typecheck 末尾的那条。exit 0 = 语料 0 错。
const TSC = ["node_modules/typescript/bin/tsc", "-p", "tsconfig.test.json", "--noEmit"];

/** 跑一次 tsc 门，返回 { red, exit, reportedLine }。reportedLine 是命中的报错行。 */
function runGate() {
  const r = spawnSync(process.execPath, [
    "node_modules/typescript/bin/tsc",
    "-p",
    "tsconfig.test.json",
    "--noEmit",
  ], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = String(r.stdout ?? "") + String(r.stderr ?? "");
  const red = (r.status ?? 1) !== 0;
  // 被插那行会被 tsc 报成 `<file>(<line>,<col>): error TS2322` —— 命中它即证明
  // 门看见的是「我插的那条错」，不是别处旧错（旧错若还在，门本就不该绿过）。
  const reportedLine = (out.match(/policy\.test\.ts\(\d+,\d+\): error TS\d+/u) ??
    [null])[0];
  return { red, exit: r.status ?? -1, reportedLine, out };
}

const original = readFileSync(join(ROOT, SRC), "utf8");

// 变异体：原内容 + 一条确定会红的类型错。用 `void` 前缀让这条声明在「运行时」也
// 无害 —— 但本台只读 tsc，不读运行时，这条声明的唯一意义就是让【类型检查】红。
const PROBE = "\nconst __b5GateProbe: number = \"故意：这是字符串，类型错\"; // round354 B5 变异\n";
const mutated = original + PROBE;

/** 逐字节还原 + 核对：还原后内容与进机器前的原文一比一 ⇒ reverted。 */
function rollback() {
  writeFileSync(join(ROOT, SRC), original, "utf8");
  if (readFileSync(join(ROOT, SRC), "utf8") !== original) {
    throw new Error("回滚后字节对不上，立刻去 git 核对：" + SRC);
  }
}

const results = [];
let fatal = "";
try {
  // M2 控制组先行：一字不改 ⇒ 门绿。若它不绿，后面「M1 该红」就没有地基
  // （分不清是 M1 插的红，还是语料本来就有没清的旧错）。
  const control = runGate();
  results.push([
    control.red === false,
    "M2 一字不改 ⇒ tsc -p tsconfig.test.json 绿（exit " +
      control.exit +
      "）",
    control.red === false
      ? "全绿（0 错）"
      : "控制组就红 ⇒ 语料没清干净或门坏了：\n" + control.out.slice(-500),
  ]);
  if (control.red !== false) {
    throw new Error("控制组就红 ⇒ 后面「M1 该红」没有地基（语料或门本身有问题）");
  }

  // M1 插一条测试类型错 ⇒ 门红，且报出来的正是被插那行。
  writeFileSync(join(ROOT, SRC), mutated, "utf8");
  if (readFileSync(join(ROOT, SRC), "utf8") !== mutated) {
    throw new Error("断言失败：写盘后读回的不是变异体（M1）");
  }
  const m1 = runGate();
  let reverted = false;
  const okM1 =
    m1.red === true &&
    m1.reportedLine !== null &&
    m1.reportedLine.includes("error TS");
  try {
    rollback();
    reverted = readFileSync(join(ROOT, SRC), "utf8") === original;
  } finally {
    /* 即便 rollback 抛，也走收尾 */
  }
  if (!reverted) throw new Error("reverted !== true（M1）");
  results.push([
    okM1,
    "M1 测试文件插一条类型错 ⇒ 门红（exit " + m1.exit + "，reverted: " + reverted + "）",
    okM1
      ? "命中行：" + m1.reportedLine
      : "该红没红 / 没报出被插那行：\n" + m1.out.slice(-500),
  ]);
} catch (err) {
  fatal = String(err instanceof Error ? err.message : err);
  try {
    rollback();
    results.push([true, "收尾回滚", "已按原文逐字节还原（机器停摆路径）"]);
  } catch (e2) {
    console.error(
      "【致命】收尾回滚失败，立刻去 git 核对：" + SRC + " ｜" + String(e2),
    );
    process.exitCode = 1;
  }
}

if (fatal !== "") {
  console.error("【整台机器停摆，不出命中数】" + fatal);
  process.exitCode = 1;
} else {
  let ok = 0;
  console.log("══════════ round354 B5 tsc 硬门变异矩阵（写测试文件真字节，逐发自回滚）══════════");
  for (const [isHit, label, msg] of results) {
    ok += isHit ? 1 : 0;
    console.log((isHit ? "✓ " : "✗ ") + label + "\n      | " + msg);
  }
  // 分母 = 2 发（M1 红 + M2 控制绿）
  console.log("命中 " + ok + " / " + results.length + "（分母 = 1 发变异 + 1 控制组）");
  process.exitCode = ok === results.length && results.length === 2 ? 0 : 1;
}
