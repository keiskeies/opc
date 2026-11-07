/**
 * 起停"崩溃子进程"的唯一入口（Task 0.8 验收 ③）。
 *
 * 为什么用 createRequire(import.meta.url).resolve("tsx/cli") + process.execPath 直启，
 * 而不是 npx tsx：不依赖 PATH、不额外起一层 npm 进程，退出码就是子进程自己的退出码。
 * 实测：tsx 从 packages/hub/test/graph/ 这个位置能解析到根 devDep 里的 tsx/cli。
 *
 * 为什么不用 node 直接跑 .ts：Node 24 的原生类型剥离【不做 .js → .ts 说明符重映射】，
 * 而本仓是 NodeNext（import 一律写 .js），实测报 ERR_MODULE_NOT_FOUND mod.js。
 * 也就是说：在本仓，跨进程跑 TS 只有 tsx 这一条路，这是实测出来的，不是猜的。
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { CHILD_SCRIPT, HUB_ROOT } from "./company-fixtures.js";

export interface ChildArgs {
  readonly dbPath: string;
  readonly threadId: string;
  readonly taskId: string;
  readonly idea: string;
  /** 写完第 K 条状态边后 SIGKILL —— 最狠的崩溃时机：事件已 INSERT，超步事务尚未提交。 */
  readonly killEventIndex?: number;
  /** 第 N 次节点执行结束时 SIGKILL。与 killEventIndex 二选一。 */
  readonly killAfterNodes?: number;
}

export interface ChildRun {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

const req = createRequire(import.meta.url);

export function runChild(a: ChildArgs): ChildRun {
  const argv = [
    req.resolve("tsx/cli"),
    CHILD_SCRIPT,
    "--db",
    a.dbPath,
    "--thread",
    a.threadId,
    "--task",
    a.taskId,
    "--idea",
    a.idea,
  ];
  if (a.killEventIndex !== undefined) {
    argv.push("--kill-event-index", String(a.killEventIndex));
  } else if (a.killAfterNodes !== undefined) {
    argv.push("--kill-after-nodes", String(a.killAfterNodes));
  }
  const r = spawnSync(process.execPath, argv, {
    cwd: HUB_ROOT,
    encoding: "utf8",
    timeout: 170_000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    status: r.status,
    signal: r.signal ?? null,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}
