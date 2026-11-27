/**
 * round387 探针 ②：看板能出现的那个场景里（Hub 正在跑并持锁），
 * 屏幕上教的「手工 hub work」是不是把守约的一方支去当第二个写入者。
 *
 * 跑法：npx tsx .workbuddy/round387-double-writer.mts
 * 不花钱：work / serve 一律只为看它撞在锁上还是别处，work 的 task_id 故意不存在。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../packages/hub/src/serve/lock.js";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const tsx = "node_modules/tsx/dist/cli.mjs";

function run(args: string[], timeoutMs = 120_000): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  return {
    code: r.status,
    out: [String(r.stdout ?? ""), String(r.stderr ?? "")]
      .join("")
      .split("\n")
      .filter(
        (l) =>
          l.trim() !== "" &&
          !l.includes("Warning") &&
          !l.includes("trace-warnings"),
      )
      .slice(0, 3)
      .join(" ⏎ "),
  };
}

const dir = mkdtempSync(join(tmpdir(), "r387-"));
const db = join(dir, "hub.db");
try {
  console.log("① 用 hub run 建一个真库（桩模型，不联网）");
  const built = run([
    tsx, "packages/hub/src/cli.ts", "run",
    "--db", db, "--task", "t1", "--idea", "一句话",
  ]);
  console.log("    退出", built.code, "|", built.out.slice(0, 110));
  console.log("    库存在：", existsSync(db));

  console.log("② 模拟 Hub 启动：拿住那一把锁（assemble.ts 无条件 acquireLock）");
  const lock = acquireLock(db);
  console.log("   ", lock.ok ? "锁已持有" : "锁没拿到：" + JSON.stringify(lock));
  console.log("    锁文件：", existsSync(db + ".lock") ? readFileSync(db + ".lock", "utf8").slice(0, 90) : "不在");

  console.log("③ 锁被 Hub 持有期间敲 hub work（task 故意不存在 ⇒ 看它撞的是锁还是任务）");
  const w = run([
    tsx, "packages/hub/src/engine/hub-work.ts", "work",
    "--db", db, "--task", "nope", "--max-budget-usd", "1", "--task-limit-cents", "100",
  ]);
  console.log("   ", JSON.stringify(w));
  console.log(
    "    ⇒ hub work 有没有避让那把锁：" +
      (w.out.includes("任务不存在")
        ? "没有 —— migrate 与 loadTask 都真跑成了，全程没提锁"
        : "看上一行"),
  );

  console.log("④ 对照：同一个库再起一个 hub serve（守约那一方）—— 该被挡");
  const s = run([tsx, "packages/hub/src/serve/hub-serve.ts", "--db", db], 30_000);
  console.log("   ", JSON.stringify(s).slice(0, 260));

  console.log("⑤ 释放锁之后 hub work 是否立刻可跑（同一条命令）");
  if (lock.ok) {
    rmSync(lock.path, { force: true });
  }
  const w2 = run([
    tsx, "packages/hub/src/engine/hub-work.ts", "work",
    "--db", db, "--task", "nope", "--max-budget-usd", "1", "--task-limit-cents", "100",
  ]);
  console.log("   ", JSON.stringify(w2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
