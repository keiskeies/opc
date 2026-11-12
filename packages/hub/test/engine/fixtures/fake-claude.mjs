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
  // mode=cwd：把【子进程自己的】cwd 与收到的 --max-budget-usd 塞进 decision.summary，
  // 而不是只塞进下面那份回显 JSON。
  // 为什么驱动器那条路需要这一档而章程那条不需要：charter.ts 会把回显 JSON 折进
  // 卡片第二行（impact_scope），所以那边读得到 cwd 与 budget；dispatch 这条路上
  // 进正文的只有 decision.summary（`edge.why + "：" + d.summary`），回显 JSON 整块
  // 落在审计之外 —— 于是"--agent-cwd / --max-budget-usd 真的到了子进程"这两格
  // 在驱动器那一侧【读不回来】。判据要能读回来，就得让桩把那两个值放进一条
  // 【会被折进审计】的位置。
  const summary =
    mode === "cwd"
      ? "cwd=" + process.cwd() + " budget=" + (argv.includes("--max-budget-usd") ? argv[argv.indexOf("--max-budget-usd") + 1] : "(缺)")
      : "方案已成型，交技术总监审阅";
  // 把收到的关键参数回显进 result，好让测试断在【真的传了 --resume】上，
  // 而不是断在「测试作者以为传了」。
  const resumed = argv.includes("--resume") ? (argv[argv.indexOf("--resume") + 1] ?? "") : "";
  const budget = argv.includes("--max-budget-usd") ? (argv[argv.indexOf("--max-budget-usd") + 1] ?? "") : "";
  // cwd 排在【最前面】而不是 prompt 之后：调用方（charter 那条路）会把这段 JSON 折进
  // 卡片第二行，而那一行在 600 字处截断（charter.ts 的 impactScopeOf），
  // prompt 有几百字 —— 排在后面的字段会被截掉，那一发就会红在截断上而不是红在判据上。
  // 读的是【子进程自己的】process.cwd()：这是"调用方给的工作目录真到了进程里"唯一
  // 量得到的位置。测试里读父进程的 cwd 只能证明"我以为我传了"。
  const echoed = { cwd: process.cwd(), resumed, budget, prompt: stdin.trim() };

  const body =
    "这是员工的一轮汇报。\n\n" +
    JSON.stringify(echoed) +
    "\n\n" +
    "<<<OPC_DECISION>>>\n" +
    JSON.stringify({ action: "handoff", to_role: "tech", summary });
  process.stdout.write(
    JSON.stringify({ is_error: false, result: body, session_id: sessionId, total_cost_usd: 0.042 }),
  );
  process.exit(0);
});
