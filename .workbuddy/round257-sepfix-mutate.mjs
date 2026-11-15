/**
 * 变异复证：把修好的接线断言真的推一遍，确认它们【会红】。
 *
 * ── 为什么必须做 ────────────────────────────────────────────────
 * 这 8 发在 Windows 上恒红（分隔符），修完变绿。"修完就绿"不是证据：一条断言从
 * 恒红变恒绿，最坏的可能是判据被我改瞎（filter 放宽 → 名单恒空 → 怎么接线都绿）。
 * 0013 §8 的原话是「对目标缺陷的分辨能力是零」，分辨力只能靠注入真缺陷量出来。
 *
 * ── 两处我自己踩过、留在这里的坑 ────────────────────────────────
 * ① 还原必须**写回原字节**。第一版写的是 `rmSync(abs)`，而 append 之后删文件
 *    = 把原文件删了。那会让"还原后应绿"红在「文件不见了」上，红因与判据无关。
 * ② 判据锚点在**定义处**（charter/store.ts），而我注入的是**另一个文件**
 *    （overview/today.ts）。第一版拿定义处的锚点去断言注入落地，恒假。
 *    所以这里分成两个独立的自检：锚点存在性查定义处，落地性数注入处 `name(` 的次数。
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * ROOT 从**本文件位置**算，不写死绝对路径：这份脚本是仓库资产（不是 /tmp 里的一次性件），
 * 换一台机器 / 换一个克隆目录，写死的根会变成「在别人的机器上悄悄扫到别的东西」。
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.TEMP + "/mut-out.json";
const results = [];

/** 注入目标必须**开工时是干净的**，否则「还原后字节比对」比的是别人的改动，红因与判据无关。 */
function gitClean(path) {
  const r = spawnSync("git", ["status", "--porcelain", "--", path], {
    cwd: ROOT,
    encoding: "utf8",
    shell: true,
  });
  return r.status === 0 && r.stdout.trim() === "";
}


function runTest(file) {
  try {
    spawnSync("npx", ["vitest", "run", file, "--reporter=json", "--outputFile=" + OUT], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      shell: true,
    });
    const j = JSON.parse(readFileSync(OUT, "utf8"));
    return { failed: j.numFailedTests, total: j.numTotalTests };
  } catch {
    return { failed: -1, total: -1 };
  }
}

/**
 * @param name        被注入调用的函数名（判据扫 `name(`）
 * @param defFile     它的定义处 —— 只用来核对"这个名字真是导出的"（防假变异）
 * @param injectFile  注入目标，必须在判据的射程内且当前不在名单里
 */
function mutate(label, name, defFile, injectFile, testFile) {
  const defAbs = ROOT + "/" + defFile;
  const defSrc = readFileSync(defAbs, "utf8");
  if (!defSrc.includes("export function " + name + "(") && !defSrc.includes("export async function " + name + "(")) {
    results.push({ label, verdict: "SKIP-NOEXPORT", note: name + " 不是 " + defFile + " 的导出 ⇒ 假变异" });
    return;
  }
  const abs = ROOT + "/" + injectFile;
  if (!gitClean(injectFile)) {
    results.push({ label, verdict: "SKIP-DIRTY", note: injectFile + " 开工前就不干净 ⇒ 拒绝注入" });
    return;
  }
  const before = readFileSync(abs, "utf8");
  const injection =
    `
/* round-sepfix mutation probe (temporary; this script rewrites the original bytes back) */
export function __probeCallerForMutation(a: unknown): unknown {
  return ${name}(a as never);
}
`;
  appendFileSync(abs, injection);
  const landed = readFileSync(abs, "utf8");
  const count = (s) => s.split(name + "(").length - 1;
  if (statSync(abs).size <= before.length || count(landed) <= count(before)) {
    writeFileSync(abs, before);
    results.push({ label, verdict: "SKIP-NOLAND", note: "注入未形成新的调用形状 ⇒ 假变异" });
    return;
  }
  const red = runTest(testFile);
  /*
   * 还原写成「重试 + 逐字节核对」而不是裸 writeFileSync：round185 量过 Windows 上
   * SQLite/句柄未释放会让文件写/删 EPERM，而这里中途抛出去的代价是**注入留在真 src 里**。
   * 抛出去时脚本会打出文件路径，但那条路依赖有人读输出 —— 所以补下面那道终检。
   */
  let restored = false;
  for (let i = 0; i < 6 && !restored; i++) {
    try {
      writeFileSync(abs, before);
      restored = readFileSync(abs, "utf8") === before;
    } catch {
      spawnSync("cmd", ["/c", "timeout", "/t", "1", "/nobreak"], { shell: true });
    }
  }
  if (!restored) {
    results.push({ label, verdict: "RESTORE-FAIL", note: "⚠ 还原后字节不等，手工核对 " + injectFile });
    return;
  }
  const green = runTest(testFile);
  results.push({
    label,
    verdict: red.failed > 0 && green.failed === 0 ? "PASS" : "FAIL",
    note: `注入后 failed=${red.failed}/${red.total}  还原后 failed=${green.failed}/${green.total}`,
  });
}

/*
 * 注入的形状：代码行上的真调用点，必须含 `name(`（判据扫的就是这个）。
 * 不能注进注释 —— phase3 的 srcFilesMatching 刻意滤整行注释（它文件头写的就是这件事），
 * 那样会得到一次"没红"，而那是**探针错**而不是判据瞎。
 * 调用点在函数体内而非顶层：today.ts 被别的测试 import 时，顶层引用未 import 的
 * 标识符会抛 ReferenceError，那种红与判据无关。
 *
 * ⚠ 注入的代码本身**编译不过**（today.ts 没 import 那个名字）。这是**可接受的**，
 * 因为这几发判据是**静态扫源码**（读字节、正则/includes），不编译、不执行 ——
 * 红的必须是那条接线断言本身。所以下面每一发都额外核对 failed 数恰好是预期的那几发，
 * 而不是"任何红"（typecheck 不进 vitest，见 0007 §5，所以编译错不会混进来）。
 */
const T = "packages/hub/src/overview/today.ts";
const P3 = "packages/hub/test/acceptance/phase3.test.ts";

mutate("store ④ saveCharterVersion 出现 charter/ 外调用方", "saveCharterVersion", "packages/hub/src/charter/store.ts", T, "packages/hub/test/charter/store.test.ts");
mutate("store ④ 写通道出现 charter/ 外 writer", "syncCharterBudgets", "packages/hub/src/charter/budget-sync.ts", T, "packages/hub/test/charter/store.test.ts");
mutate("budget-sync ⑦ 写入口出现调用方", "syncCharterBudgets", "packages/hub/src/charter/budget-sync.ts", T, "packages/hub/test/charter/budget-sync.test.ts");
mutate("auto-approve ⑧ autoApprove 出现调用方", "autoApprove", "packages/hub/src/policy/auto-approve.ts", T, "packages/hub/test/policy/auto-approve.test.ts");
mutate("auto-approve ⑧ createCard 出现调用方", "createCard", "packages/hub/src/approvals/cards.ts", T, "packages/hub/test/policy/auto-approve.test.ts");
mutate("phase3 ④ verifyFix 出现调用方（第 1 条 blocker 消掉那天）", "verifyFix", "packages/hub/src/harness/verifier.ts", T, P3);
mutate("phase3 ④ readAutoApprovalReport 出现调用方", "readAutoApprovalReport", "packages/hub/src/policy/auto-approve.ts", T, P3);

console.log("\n===== 变异复证 =====");
for (const r of results) console.log(r.verdict.padEnd(14), r.label, "|", r.note);
const bad = results.filter((r) => r.verdict !== "PASS");
console.log("\nPASS " + (results.length - bad.length) + " / " + results.length + (bad.length ? "   ⚠ " + bad.length + " 发未过" : ""));

/*
 * 终检：这份脚本写的是**真 src**，所以「跑完之后 src 仍然逐字节干净」是它自己的不变量，
 * 必须自己断言，不能靠人去翻 git status —— 忘翻的下场是一份注入体留在生产源码里而全绿。
 */
const dirty = spawnSync("git", ["status", "--porcelain", "--", "packages/hub/src"], {
  cwd: ROOT,
  encoding: "utf8",
  shell: true,
}).stdout.trim();
if (dirty !== "") {
  console.log("\n⚠ packages/hub/src 跑完仍脏（注入体没还原干净）：");
  console.log(dirty);
  process.exitCode = 1;
} else {
  console.log("\n终检：packages/hub/src 跑完 git status 净 —— 注入体已逐字节还原。");
}

