// round259 变异探针：claude.test.ts 从 node:test 搬进 vitest 之后，那 13 发真的【在跑】吗。
//
// 为什么必须跑：本轮的结论是「这一发今天从门禁里的假绿变成了真测试」，
// 而假绿的定义就是【改坏了也不红】。所以验收只有一条：把被测代码逐处改坏，
// 每一处都必须红。任何一处改坏仍绿 ⇒ 那一发搬进来还是假绿，本轮结论不成立。
//
// ⚠ 这里改的是【生产源码】packages/hub/src/engine/claude.ts，不是测试文件。
// 所以还原必须是【写回原字节 + 逐字节核对】，并在收尾时无条件自检（round257 同口径）。
//
// 用法：node .workbuddy/round259-vitest-port-mutate.mjs
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = "packages/hub/src/engine/claude.ts";
const T = "packages/hub/test/engine/claude.test.ts";

/*
 * 基线取【探针启动那一刻的字节】而不是 HEAD（0054 §7 第 5 条的教训：抄来的前置会把
 * 本轮自己的未提交改动当成脏）。收尾自检也照这个基线比。
 */
const BASELINE = readFileSync(join(ROOT, SRC), "utf8");

function run() {
  const r = spawnSync("npx", ["vitest", "run", T], {
    cwd: ROOT,
    encoding: "utf8",
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { red: r.status !== 0, out: (r.stdout || "") + (r.stderr || "") };
}

// 基线必须先是绿的，否则「改坏变红」不能归因于这一发变异。
const base = run();
console.log("baseline green: " + !base.red);
if (base.red) {
  console.log(base.out.slice(-2500));
  console.log("ABORT: 基线就是红的");
  process.exit(1);
}

const results = [];
function mutate(label, find, replace) {
  const abs = join(ROOT, SRC);
  // 进场自检：上一发没还原干净的话，这一发的结论不成立，立即停手。
  if (readFileSync(abs, "utf8") !== BASELINE) {
    results.push({ label, verdict: "DIRTY-ENTRY" });
    console.log("  DIRTY-ENTRY  " + label + "  ← 进场时 src 已不是基线，停手");
    process.exitCode = 1;
    return;
  }
  if (!BASELINE.includes(find)) {
    results.push({ label, verdict: "ANCHOR-MISS" });
    console.log("  ANCHOR-MISS  " + label + "  ← 锚点串不在源码里，这一发没打中");
    return;
  }
  writeFileSync(abs, BASELINE.replace(find, replace));
  const first = run();
  let restored = false;
  for (let i = 0; i < 6 && !restored; i++) {
    try {
      writeFileSync(abs, BASELINE);
      restored = readFileSync(abs, "utf8") === BASELINE;
    } catch {
      spawnSync("node", ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000)"]);
    }
  }
  if (!restored) {
    results.push({ label, verdict: "RESTORE-FAIL" });
    console.log("  RESTORE-FAIL " + label + "  ← ⚠ 生产源码被留在改坏的状态，立刻手工核对 " + SRC);
    process.exitCode = 1;
    return;
  }
  const again = run();
  const ok = first.red && !again.red;
  results.push({ label, verdict: ok ? "PASS" : "FAIL" });
  console.log("  " + (ok ? "PASS" : "FAIL") + "  " + label + "  (改坏红=" + first.red + " 还原绿=" + !again.red + ")");
  if (!ok) console.log("      ↳ 这一发改坏后仍绿 = 那一发搬进 vitest 之后依然是假绿");
}

/*
 * 12 发。挑法不是「随机改几处」，而是照着文件头自己写的那句承诺：
 * 「这一层最容易出的错全在进程边界上（参数没传过去、输出不是 JSON、进程挂住不退、
 * 非零退出被当成功）」—— 那四件事各至少一发，外加 parseDecision 的判据与
 * 「钱花了要记账」那一族。
 */

// —— 参数没传过去 ——
mutate("P1 prompt 不写进 stdin（文件头点名的第一类）", "      p.stdin.write(i.prompt);", "      void i.prompt;");
mutate("P2 预算不真的上 argv（写成常量）", '"--max-budget-usd",\n    String(i.maxBudgetUsd),', '"--max-budget-usd",\n    "0",');
mutate("P3 rolePrompt 不真的上 argv", '"--append-system-prompt",\n    i.rolePrompt,', '"--append-system-prompt",\n    "",');
mutate("P4 空 resumeSessionId 也推 --resume", "if (i.resumeSessionId !== undefined && i.resumeSessionId !== \"\") {", "if (i.resumeSessionId !== undefined) {");
mutate("P5 根本不推 --resume", "    args.push(\"--resume\", i.resumeSessionId);", "    void i.resumeSessionId;");

// —— 非零退出被当成功 / 钱花了不记账 ——
mutate("N1 只看 is_error，非零退出被当成功", "if (j.is_error === true || raw.code !== 0) {", "if (j.is_error === true) {");
mutate("N2 失败时账单报 0（钱花了却说没花）", "      costUsd: cost,\n      error: (typeof j.result", "      costUsd: 0,\n      error: (typeof j.result");
mutate("N3 失败时丢掉会话 id（下一轮接不上）", "      sessionId,\n      costUsd: cost,", "      sessionId: null,\n      costUsd: cost,");

// —— 输出不是 JSON ——
mutate("J1 解析失败被当成成功（编一段空 text 当回答）", "    return {\n      ok: false,\n      text: \"\",\n      sessionId: i.resumeSessionId ?? null,\n      costUsd: 0,\n      error:\n        \"CLI 输出不是预期的 JSON", "    return {\n      ok: true,\n      text: \"\",\n      sessionId: i.resumeSessionId ?? null,\n      costUsd: 0,\n      error:\n        \"CLI 输出不是预期的 JSON");

// —— 进程挂住不退 / spawn 失败 ——
mutate("T1 超时不生效（不杀进程也不置 timedOut）", "      const t = setTimeout(() => {\n        timedOut = true;\n        p.kill(\"SIGKILL\");\n      }, i.timeoutMs ?? 180_000);", "      const t = setTimeout(() => {\n        void timedOut;\n      }, i.timeoutMs ?? 180_000);");
mutate("T2 spawn 失败被当成超时（丢掉 error 通道）", "        resolveP({ code: -1, stdout: \"\", stderr: String(e), timedOut: false });", "        resolveP({ code: -1, stdout: \"\", stderr: \"\", timedOut: true });");

// —— parseDecision：员工说了算的那一步 ——
mutate("D1 取第一个决策段而不是最后一个", "const idx = text.lastIndexOf(DECISION_MARK);", "const idx = text.indexOf(DECISION_MARK);");
// 注意 D2 不能写成【删掉那行守卫】：那样下面 `o["summary"].trim()` 会在缺字段时抛
// TypeError，红的理由是「崩了」而不是「空摘要被放行」—— 那是探针错而不是判据对。
// 所以改成「缺了就补一个空串」：不抛，且空摘要照样过。
mutate("D2 缺/空 summary 也放行（空摘要推进状态机）", "  if (typeof o[\"summary\"] !== \"string\" || o[\"summary\"].trim() === \"\") return null;", "  if (typeof o[\"summary\"] !== \"string\") o[\"summary\"] = \"\";");
mutate("D3 未知 action 也放行", "  if (!(ROLE_ACTIONS as readonly string[]).includes(action)) return null;\n", "");

console.log("\n--- 汇总 ---");
for (const r of results) console.log(r.verdict.padEnd(13), r.label);
const passed = results.filter((r) => r.verdict === "PASS").length;
console.log("PASS " + passed + " / " + results.length);

// 收尾自检：无条件核对生产源码回到基线，不靠人去翻 git status。
if (readFileSync(join(ROOT, SRC), "utf8") !== BASELINE) {
  console.log("\n!!! 收尾自检失败：" + SRC + " 与基线不一致，必须手工还原 !!!");
  process.exitCode = 1;
} else {
  console.log("收尾自检：" + SRC + " 与探针启动时逐字节一致");
}
