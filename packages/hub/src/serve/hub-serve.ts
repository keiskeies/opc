/**
 * `pnpm hub:serve` 的进程入口（规格 §5.1「Hub 是唯一常驻进程」那句的字面实现）。
 * ⚠ 名字写全：`hub serve` 这个子命令【不存在】—— cli.ts 的 VERBS 只有
 *   run / status / resume，敲 `hub serve` 拿到的是「未知子命令」退出 2。
 *   为什么不加那个 verb：cli.ts 顶层 import @langchain/langgraph，本机装不上（0009 §2），
 *   挂上去之后本篇的启动顺序/退出码/清理在离线机器上一行都测不了（0025 §7 第 1 条）。
 *
 * 本文件【只有入口块】，因为入口块的失效方式是静默的：
 * 装配写在这里、判定写别处，那么「入口块没跑」与「装配坏了」在退出码上长得一样。
 * 与 main.ts / migrate-cli.ts / maintenance.ts 同一个形状，四条同源：
 *   · 入口块只回答一个问题 —— 这次是【被直接执行】吗（isDirectRun）
 *   · 怎么跑（stdio 装配、退出码写入）在 serveMain 里，只有【一处】写 process.exitCode
 *   · 顶层不 import @langchain/*，所以这条入口在本机离线可跑（见 assemble.ts 文件头）
 *   · 被 import 时【绝不】产生副作用：写错这一格的话，测试进程 import 它就起了一个
 *     真 Hub，那比不跑更糟（端口占用 + 一颗锁住临时库的锁文件）
 *
 * 为什么另开一个文件而不是给 cli.ts 加一个 `serve` 子命令：
 * cli.ts 顶层 import `@langchain/langgraph`（它自己就是图的那一侧）。挂上去之后
 * 「serve 的启动顺序 / 退出码 / 清理」在离线机器上【一行都测不了】——
 * 可验证性由 import 图决定，不由逻辑决定，这一条在本仓已经写过三次
 * （thread.ts、real-deps.ts、以及 assemble.ts 文件头）。
 * 代价是两个可执行入口，已登记在 0025 §7。
 */
import { serveMain } from "./assemble.js";
import { isDirectRun } from "../internal/direct-run.js";

if (isDirectRun(import.meta.url, process.argv[1])) {
  await serveMain(process.argv.slice(2));
}
