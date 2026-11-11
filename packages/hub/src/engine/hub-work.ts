/**
 * `pnpm hub:work` / `pnpm hub:decide` 的进程入口（引擎路线的命令行那一头）。
 *
 * ── 为什么又是一个入口文件，不给 cli.ts 加两个 verb ──────────────────
 * 同一个理由第四次出现（thread.ts、real-deps.ts、assemble.ts 文件头、hub-serve.ts）：
 * cli.ts 顶层 import `@langchain/langgraph`，本机装不上（0009 §2），挂上去之后
 * work/decide 的退出码与参数报错在离线机器上【一行都测不了】。
 * 可验证性由 import 图决定，不由逻辑决定。
 *
 * 而且这一条不只是「测不了」：引擎路线存在的意义恰恰是【它不依赖那张图】
 * （0041 的转向），把它的入口挂在依赖那张图的文件上，等于让「不用 langchain」
 * 这件事在最外面那一层被推翻 —— 而推翻的方式是启动即 module not found，
 * 报的是依赖问题，不是「这条路线不存在」。
 *
 * ── 一个文件管两个 verb，不是两个文件各管一个 ────────────────────────
 * 两个 verb 共用 db 打开、migrate、以及那套退出码，而【共用部分的漂移】正是本仓
 * 抓过多次的那一族（两条路上「卡片 pending 的判定」各写一份）。
 * 分成两个入口文件的话，第三个 verb（hub status 的引擎版）来的时候会有三份。
 *
 * ── 形状照 hub-serve.ts：入口块【只有】这一格 ────────────────────────
 *   · isDirectRun 判「这次是被直接执行吗」，被 import 时零副作用
 *     （测试直接 import runEngineCli，不会起进程也不会锁库）；
 *   · 只有【一处】写 process.exitCode（hub-serve.ts 文件头那条同源纪律）。
 */
import { isDirectRun } from "../internal/direct-run.js";
import {
  DECIDE_USAGE,
  WORK_USAGE,
  cmdDecide,
  cmdWork,
  parseDecideArgs,
  parseWorkArgs,
  type WorkIo,
  type WorkResult,
} from "./work.js";

/**
 * 分发引擎路线的 verb。
 *
 * @returns 退出码。含义见 cmdWork / cmdDecide 各自那段（0 / 1 / 2 三条，
 *          分界线是【使用者的下一步动作不同】，不是「成功/失败」两分）。
 */
export async function runEngineCli(argv: readonly string[], io: WorkIo): Promise<WorkResult> {
  const verb = argv[0];
  const wantsHelp = verb === "--help" || verb === "-h" || verb === "help";
  if (wantsHelp || verb === undefined || verb === "") {
    // 用法【都】打，但走哪条流与退出码跟着「她是不是在问」走：
    //  · --help 是主动问 ⇒ stdout + 0（脚本里 `hub work --help` 不该被判成失败）；
    //  · 什么都没敲是【打错了】⇒ stderr + 2，与下面未知子命令同码。
    // 两种情况都不让人对着一个 exit 0 去查「为什么什么都没干」。
    (wantsHelp ? io.write : io.error)(WORK_USAGE + "\n");
    return { code: wantsHelp ? 0 : 2 };
  }
  const rest = argv.slice(1);
  if (verb === "work" || verb === "decide") {
    /**
     * 两条命令共用【一个】try，而不是各写一个：要收的错误形状是同一个
     * （库损坏 / 迁移失败 / 守卫抛出来的那句话），而两份 catch 迟早有一份漏掉。
     *
     * 为什么必须 catch 而不是让它冒出去：cmdWork / cmdDecide 承诺的退出码是
     * 0/1/2 三条，而 Promise rejection 在 node 里的表现是【进程以 1 退出并打一段 stack】。
     * 码对了，但那一段 stack 对人类是噪声 —— 更坏的是脚本作者看不出这是「跑炸了」
     * 还是「参数错了」（stderr 里第一行是 at Object.<anonymous>）。
     * 所以这里把消息本身打出来（守卫抛的那句话本来就写得比 stack 有用），码给 1。
     */
    try {
      if (verb === "work") {
        const p = parseWorkArgs(rest);
        if (!p.ok) {
          io.error("错误：" + p.error + "\n\n" + WORK_USAGE + "\n");
          return { code: 2 };
        }
        return await cmdWork(p.args, io);
      }
      const p = parseDecideArgs(rest);
      if (!p.ok) {
        io.error("错误：" + p.error + "\n\n" + DECIDE_USAGE + "\n");
        return { code: 2 };
      }
      return await cmdDecide(p.args, io);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      io.error("执行失败：" + msg + "\n");
      return { code: 1 };
    }
  }
  io.error(
    "错误：引擎路线没有 [" + verb + "] 这个子命令。\n\n" + WORK_USAGE + "\n",
  );
  // 未知 verb 用 2（与 cli.ts 的 VERBS 那条同码）：改命令就行，不该被当成一次执行失败。
  return { code: 2 };
}

/** stdio 版：进程入口与测试都走这一条，只是 io 不同。 */
export async function runEngineCliOnStdio(argv: readonly string[]): Promise<WorkResult> {
  const io: WorkIo = {
    write: (t) => {
      process.stdout.write(t);
    },
    error: (t) => {
      process.stderr.write(t);
    },
  };
  const r = await runEngineCli(argv, io);
  process.exitCode = r.code;
  return r;
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  await runEngineCliOnStdio(process.argv.slice(2));
}
