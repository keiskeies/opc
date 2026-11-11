#!/usr/bin/env node
/**
 * 假 claude：一个真的可执行文件，按 argv/stdin 返回 claude -p --output-format json
 * 的那份形状。它不是 mock —— runRole 起的是真子进程，走的真是 spawn/stdin/stdout，
 * 只有对面那个「模型」是查表的。这样测的是适配器本身（解析、参数、超时、退出码），
 * 而不是「我把函数换成我希望它长的样子」。
 */
import process from "node:process";

// 这个文件是【纯 JS】（.mjs 不经 --experimental-transform-types）：类型注解在这里
// 是语法错误。第一次跑就死在 `(d: Buffer)` 上，而报出来的错长得像「CLI 输出不是 JSON」——
// 正是本层要测的那个失效，被适配器诚实地透传回来了（这次轮到测试自己不会写）。
let stdin = "";
process.stdin.on("data", (d) => (stdin += d.toString()));
process.stdin.on("end", () => {
  const argv = process.argv.slice(2);
  const mode = process.env["FAKE_CLAUDE_MODE"] ?? "ok";
  const sessionId = process.env["FAKE_CLAUDE_SESSION"] ?? "sess-1";

  if (mode === "garbage") {
    process.stdout.write("这不是 JSON，是 stderr 混进来的东西\n");
    process.exit(0);
  }
  if (mode === "nonzero") {
    // 带 total_cost_usd：真的 CLI 在 is_error 那一条里【照样】报账单（预算超支 = 钱已花完），
    // 所以这一发的验点是「适配器失败时不把账单抹成 0」，而不是「桩没给账单」。
    process.stdout.write(
      JSON.stringify({
        is_error: true,
        result: "budget exceeded",
        session_id: sessionId,
        total_cost_usd: 0.042,
      }),
    );
    process.exit(1);
  }
  if (mode === "hang") {
    // 永久挂着，让 runRole 的超时那一发能真的开火
    setInterval(() => {}, 1000);
    return;
  }
  // 把收到的关键参数回显进 result，好让测试断在【真的传了 --resume】上，
  // 而不是断在「测试作者以为传了」。
  const resumed = argv.includes("--resume") ? (argv[argv.indexOf("--resume") + 1] ?? "") : "";
  const budget = argv.includes("--max-budget-usd") ? (argv[argv.indexOf("--max-budget-usd") + 1] ?? "") : "";
  const echoed = { resumed, budget, prompt: stdin.trim() };
  const body =
    "这是员工的一轮汇报。\n\n" +
    JSON.stringify(echoed) +
    "\n\n" +
    "<<<OPC_DECISION>>>\n" +
    JSON.stringify({ action: "handoff", to_role: "tech", summary: "方案已成型，交技术总监审阅" });
  process.stdout.write(
    JSON.stringify({ is_error: false, result: body, session_id: sessionId, total_cost_usd: 0.042 }),
  );
  process.exit(0);
});
