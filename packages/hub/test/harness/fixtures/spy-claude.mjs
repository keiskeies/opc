#!/usr/bin/env node
/**
 * Gateway 适配器测试用的观察桩（2026-11，Step A）。
 *
 * 与 engine/fixtures/fake-claude.mjs 的分工：那份回显 argv/stdin 验「参数真的传到了」，
 * 这一份只回答一个问题 ——【进程被起过吗】：SPY_MARK 设了就先往那个路径写一个字节文件。
 * 「安全拒 ⇒ 桩没被执行」的判据靠它落成盘上证据（内存标记在进程没起的用例里本来就不可能存在，
 * 文件不在才是「没起」的证明）。
 *
 * 纯 JS（.mjs 不经类型 transform），形状对齐 claude -p --output-format json。
 */
import { writeFileSync } from "node:fs";
import process from "node:process";

let stdin = "";
process.stdin.on("data", (d) => (stdin += d.toString()));
process.stdin.on("end", () => {
  const mark = process.env["SPY_MARK"] ?? "";
  if (mark !== "") {
    writeFileSync(mark, "ran " + new Date().toISOString() + "\n");
  }
  const mode = process.env["SPY_MODE"] ?? "ok";
  const sessionId = process.env["SPY_SESSION"] ?? "sess-1";
  const argv = process.argv.slice(2);
  const resumed = argv.includes("--resume")
    ? (argv[argv.indexOf("--resume") + 1] ?? "")
    : "";
  // 身份回显（round312 加）：--append-system-prompt 的那一格【真的进了 argv】吗。
  // adapters/claude.test.ts 里「装配期给 rolePrompt」那条链（ClaudeCliAdapterOptions
  // 的注释说它是这一格唯一的机器凭据）判的就是这里 —— 少了回显，「岗位书整段静默消失」
  // 的症状只是输出质量差，谁都不会怀疑到装配参数上。
  const systemPrompt = argv.includes("--append-system-prompt")
    ? (argv[argv.indexOf("--append-system-prompt") + 1] ?? "")
    : null;

  if (mode === "nosession") {
    // CLI 没给 session_id 的形状：JSON 里【没有这个键】。
    // （空串不算 —— claude.ts 读的是 typeof === "string"，空串照样是合法会话 id，
    // 所以「null 不发 session_started」这一发只能靠缺键造出来。）
    process.stdout.write(
      JSON.stringify({
        is_error: false,
        result: "没有会话身份的一轮",
        total_cost_usd: 0.01,
      }),
    );
    process.exit(0);
  }
  if (mode === "error") {
    // 起了进程、报了业务错、账单照报（与 engine 桩的 nonzero 同一立场：失败不抹账）。
    process.stdout.write(
      JSON.stringify({
        is_error: true,
        result: "预算撞墙了（CLI 业务错）",
        session_id: sessionId,
        total_cost_usd: 0.04,
      }),
    );
    process.exit(1);
  }
  process.stdout.write(
    JSON.stringify({
      is_error: false,
      result:
        "桩的汇报 " +
        JSON.stringify({
          resumed,
          resumeFlag: argv.includes("--resume"),
          prompt: stdin.trim(),
          systemPrompt,
        }),
      session_id: sessionId,
      total_cost_usd: 0.042,
    }),
  );
  process.exit(0);
});
