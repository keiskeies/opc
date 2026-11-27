/**
 * `test/e2e/o13-dev-smoke.spec.ts` 的子进程侧：把 dev-entry 的真编排跑起来。
 *
 * 为什么要有这个文件而不是 `tsx packages/hub/src/serve/dev-entry.ts`：
 * 那条命令会连【信号等待】一起继承（waitForShutdown 等 SIGINT/SIGTERM），
 * 而 fork 出来的子进程收不到可靠的信号投递（Windows 上 Ctrl-C 是控制台信号）。
 * 这里 import 真模块、调 runDev 真函数，【只有 waitStop 是假的】：
 * 「父进程说一句 stop 就落地」。迁移、devPaths 解析、真 boot、web 子进程 spawn
 * 全部走 runDev 的真默认装配 —— 换的是「什么时候停」，不是「启什么」。
 *
 * ⚠ 这一发证【启动编排 + 界面可用】，不证停止编排：停止那一支（web 被 kill、
 * Hub shutdown、且不误报「先退出了」）由 dev-entry.test.ts 用同一格注入钉着。
 * 两边不重复，也不互相顶替。
 */
import { spawn } from "node:child_process";
import { runCli } from "../../packages/hub/src/db/migrate-cli.js";
import { boot, type ServeIo } from "../../packages/hub/src/serve/assemble.js";
import { devPaths, runDev } from "../../packages/hub/src/serve/dev-entry.js";

const io: ServeIo = {
  log: (m) => console.log("[dev] " + m),
  warn: (m) => console.warn("[dev] " + m),
};

// rootDir 用 process.cwd() 而不是 repoRootOf(import.meta.url)：后者数的是
// 「从 packages/hub/src/serve/ 往上四层」，本文件在 test/e2e/ 下，拿它数出的是
// 仓库根【上面】。spec 以仓库根为 cwd 启动本文件，且三个路径 env 都给的是绝对值，
// 这里不需要相对回落 —— 但不写这一行，哪天有人加个相对 OPC_DEV_DB 就会种错地方。
const p = devPaths(process.env, process.cwd());
if ("error" in p) {
  io.warn(p.error);
  process.exitCode = 2;
} else {
  const { code } = await runDev(
    p,
    {
      io,
      bootHub: boot,
      spawnWeb: (spec) =>
        spawn(spec.command, [...spec.args], {
          cwd: process.cwd(),
          env: { ...process.env, ...spec.env },
          stdio: "inherit",
        }),
      runMigrate: runCli,
      // 父进程发 "stop" ⇒ 正常收尾（kill web → await shutdown → 释放库锁）。
      // 父进程若直接 SIGKILL 我们，这一发永远不落地 —— 收尾兜底在 spec 的 afterAll。
      waitStop: () =>
        new Promise<number>((res) => {
          process.once("message", (m: unknown) => {
            if (m === "stop") res(0);
          });
        }),
    },
    process.cwd(),
  );
  process.exitCode = code;
}
