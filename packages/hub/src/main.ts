/**
 * Hub 进程入口（Task 0.10）。
 *
 * 计划把 main.ts 与 cli.ts 都列进 Files。这里的分工是刻意的：
 *   · cli.ts —— 参数、子命令、退出码。验收对象（V13）是【命令行退出码】。
 *   · main.ts —— 未来 Electron 主进程的挂载点，Phase 0 只把 CLI 转发出去。
 *
 * 【为什么不把参数解析也写进 main.ts】：main.ts 迟早要装 BrowserWindow、IPC 与生命
 * 周期，那些都需要 Electron 运行时；参数与退出码不需要。分开放，Phase 1 接 Electron
 * 时才不必把 CLI 逻辑从主进程里搬出来（那会连带把测试也搬走）。
 *
 * 本文件被直接执行时等价于 hub cli（Phase 0 没有 GUI）。真正的 Electron 入口到
 * Phase 1 再建，届时它 import 这里的导出，而不是重新解析一遍 argv。
 */
import { runCliOnStdio } from "./cli.js";
import { isDirectRun } from "./internal/direct-run.js";

export type { CliIo, CliResult } from "./cli.js";
export { runCli, runCliOnStdio } from "./cli.js";

// 入口块只回答一个问题：这次是【被直接执行】吗。
// 怎么跑（stdio 装配、退出码写入）在 cli.ts 的 runCliOnStdio 里，只有一份。
if (isDirectRun(import.meta.url, process.argv[1])) {
  await runCliOnStdio(process.argv.slice(2));
}
