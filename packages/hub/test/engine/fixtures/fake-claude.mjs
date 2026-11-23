#!/usr/bin/env node
import { writeFileSync } from "node:fs";
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
  /**
   * mode=write：模拟「这个 CLI 在没有 plan 模式时真的会往工作区写文件」。
   *
   * 这一档存在的唯一理由：`--permission-mode plan` 是生产路线上今天【唯一】生效的安全
   * 边界，而边界本身不可测 —— 本机装不上真的 CLI，离线拿不到「plan 模式会不会真的
   * 挡住写」。于是先前那一发守卫只能断「argv 上有这两个 token」，那是一句参数回显，
   * 不是边界在起作用。这一档把话说清楚：
   *   · 桩读 argv 里的 `--permission-mode`，值不是 plan（或压根没有）⇒ 【真的写盘】；
   *   · 值是 plan ⇒ 不写。
   * ⚠ 这是【桩在模拟 CLI 的语义】，不是「实测真 CLI 如此」。所以测试里那一发的标题写的是
   * 「适配器没把 plan 交出去 ⇒ 对面就会写」，而不是「plan 模式挡住了写文件」。
   * FAKE_CLAUDE_NO_PLAN=1 让桩【无视 argv 里的 plan】当作没给：那一发是【正向对照】，
   * 它证明这个写探针真的会写 —— 否则「文件不在」可能是路径写错、权限不够、桩根本没实现，
   * 而那种红永远等不到。
   */
  if (mode === "write") {
    const target = process.env["FAKE_CLAUDE_WRITE_TO"] ?? "";
    const granted =
      process.env["FAKE_CLAUDE_NO_PLAN"] === "1" ||
      argv[argv.indexOf("--permission-mode") + 1] !== "plan";
    if (target !== "" && granted) {
      writeFileSync(target, "写出去了：这一发没有 plan 模式挡着\n");
    }
    process.stdout.write(
      JSON.stringify({
        is_error: false,
        result: JSON.stringify({
          wrote: target !== "" && granted ? "yes" : "no",
          permissionMode: argv.includes("--permission-mode")
            ? (argv[argv.indexOf("--permission-mode") + 1] ?? "")
            : "(缺)",
          permissionFlag: argv.includes("--permission-mode"),
        }),
        session_id: sessionId,
        total_cost_usd: 0,
      }),
    );
    process.exit(0);
  }
  if (mode === "silentfail") {
    // ⚠ 这一档是为 round259 的变异 N1 加的：原先 nonzero 档【同时】给 is_error:true 与
    //   exit(1)，于是「适配器只看 is_error、把非零退出当成功」这个改法改完照样全绿 ——
    //   两个信号绑在一起，测试对其中任何一个都没有分辨力。真的 CLI 会不会给出
    //   is_error:false 却非零退出，我没有实测过（离线、装不上 CLI），所以这一档钉的是
    //   【适配器不许只信一个信号】，不是【真 CLI 长这样】。
    process.stdout.write(
      JSON.stringify({
        is_error: false,
        result: "（CLI 说自己没错，但它是以非零码退出的）",
        session_id: sessionId,
        total_cost_usd: 0.042,
      }),
    );
    process.exit(3);
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
      ? "cwd=" +
        process.cwd() +
        " budget=" +
        (argv.includes("--max-budget-usd")
          ? argv[argv.indexOf("--max-budget-usd") + 1]
          : "(缺)")
      : "方案已成型，交技术总监审阅";
  // 把收到的关键参数回显进 result，好让测试断在【真的传了 --resume】上，
  // 而不是断在「测试作者以为传了」。
  const resumed = argv.includes("--resume")
    ? (argv[argv.indexOf("--resume") + 1] ?? "")
    : "";
  const budget = argv.includes("--max-budget-usd")
    ? (argv[argv.indexOf("--max-budget-usd") + 1] ?? "")
    : "";
  // resumeFlag 与 resumed 分开报，是为了让「不带 --resume」与「带一个空串的 --resume」
  // 在测试里【可区分】。只看 resumed 的话这两种情况都是 ""，于是
  // 「把守卫从 `!== undefined && !== ""` 放宽成只判 `!== undefined`」这个改法测不出来
  // —— 变异 P4 就是这么存活过一次（round259）。
  const resumeFlag = argv.includes("--resume");
  // rolePrompt 回显：这一格原先桩不回收，「角色身份真的上了 argv」就无从断言
  //（变异 P3 存活的原因就是这个位置不存在，不是断言写松了）。
  const systemPrompt = argv.includes("--append-system-prompt")
    ? (argv[argv.indexOf("--append-system-prompt") + 1] ?? "")
    : "";
  // model 回显（T6）：member_executors.config.model 经 ClaudeCliAdapterOptions 落到
  // --model 的那条链，判据要能读回来 —— 没有回显，「装配传了但 argv 没拼」只能靠读码相信。
  const model = argv.includes("--model")
    ? (argv[argv.indexOf("--model") + 1] ?? "")
    : "";
  // cwd 排在【最前面】而不是 prompt 之后：调用方（charter 那条路）会把这段 JSON 折进
  // 卡片第二行，而那一行在 600 字处截断（charter.ts 的 impactScopeOf），
  // prompt 有几百字 —— 排在后面的字段会被截掉，那一发就会红在截断上而不是红在判据上。
  // 新增的 resumeFlag / systemPrompt 同样排在 prompt【之前】，同一个理由。
  // 读的是【子进程自己的】process.cwd()：这是"调用方给的工作目录真到了进程里"唯一
  // 量得到的位置。测试里读父进程的 cwd 只能证明"我以为我传了"。
  const echoed = {
    cwd: process.cwd(),
    resumed,
    resumeFlag,
    budget,
    systemPrompt,
    model,
    prompt: stdin.trim(),
  };

  const body =
    "这是员工的一轮汇报。\n\n" +
    JSON.stringify(echoed) +
    "\n\n" +
    "<<<OPC_DECISION>>>\n" +
    JSON.stringify({ action: "handoff", to_role: "tech", summary });
  process.stdout.write(
    JSON.stringify({
      is_error: false,
      result: body,
      session_id: sessionId,
      total_cost_usd: 0.042,
    }),
  );
  process.exit(0);
});
