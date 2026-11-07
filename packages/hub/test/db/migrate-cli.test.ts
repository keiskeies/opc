import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { parseArgs } from "../../src/db/migrate-cli.js";

/**
 * Task 0.5　pnpm migrate 的入口行为。
 *
 * migrate() 的幂等在 migrate.test.ts 里已测过，这里测的是【进程边界】：
 * 真实子进程跑两次同一个库文件，第二次必须报告「已是最新」且退出码 0。
 * 只调函数测不到的是：CLI 有没有把参数传对、有没有在结束时关掉连接、
 * 第二次跑会不会因为「table already exists」崩在半路。
 */

const HUB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TMP = join(HUB, ".tmp", "migrate-cli");
const require_ = createRequire(import.meta.url);

function runCliCli(args: string[]): {
  status: number;
  stdout: string;
  stderr: string;
} {
  // 直接跑 migrate-cli.ts 而不是 pnpm：避开 Windows 下 pnpm.cmd 与参数转发的差异，
  // 同时仍然是真子进程、真模块加载。「pnpm migrate 这个脚本存不存在」由下面单独断言。
  const tsx = require_.resolve("tsx/cli", {
    paths: [HUB, join(HUB, "..", "..")],
  });
  try {
    const stdout = execFileSync(
      process.execPath,
      [tsx, join(HUB, "src", "db", "migrate-cli.ts"), ...args],
      {
        encoding: "utf8",
        cwd: HUB,
        timeout: 60_000,
        stdio: "pipe",
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      },
    );
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return {
      status: err.status ?? -1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  // Windows：SQLite 句柄的 OS 级释放会落后于 close() 的 promise，rmSync 于是偶发
  // EPERM / EBUSY。断言此时已全部通过，让清理失败冒充测试失败会掩盖真实信号
  // （变异测试时真的踩过一次：一个变异被误判成「已杀死」）。阻塞等待而不是 await ——
  // afterAll 有的是 async 有的是 sync，Atomics.wait 两者都不依赖。
  let cleared = false;
  for (let attempt = 0; attempt < 40 && !cleared; attempt++) {
    try {
      rmSync(TMP, { recursive: true, force: true });
      cleared = true;
    } catch (e) {
      if (attempt === 39) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
});

it("根 package.json 里有 migrate 脚本，且指向 migrate-cli", () => {
  const pkg = JSON.parse(
    readFileSync(join(HUB, "..", "..", "package.json"), "utf8"),
  ) as {
    scripts: Record<string, string>;
  };
  // 计划 Task 0.5 的 Run 行是「pnpm migrate && pnpm test test/db/」，
  // 脚本缺失时那条 Run 命令会直接失败，所以把它钉住。
  expect(
    pkg.scripts["migrate"],
    "根 package.json 缺 migrate 脚本",
  ).toBeDefined();
  expect(pkg.scripts["migrate"]).toContain("migrate-cli");
});

it("首次执行建库并报告应用的迁移", () => {
  const dbPath = join(TMP, "cli-" + process.pid + ".db");
  const r = runCliCli([dbPath]);
  expect(r.stderr.slice(0, 200)).toBe("");
  expect(r.status, "首次 migrate 必须成功").toBe(0);
  expect(r.stdout).toContain("已应用迁移");
  expect(r.stdout).toContain("0001_init");
});

it("第二次执行是 no-op：退出码 0 且不报 table already exists", () => {
  const dbPath = join(TMP, "noop-" + process.pid + ".db");
  expect(runCliCli([dbPath]).status).toBe(0);

  const second = runCliCli([dbPath]);
  expect(second.stderr.slice(0, 300)).toBe("");
  expect(second.status, "第二次必须仍然成功").toBe(0);
  expect(second.stdout.toLowerCase()).not.toMatch(/already exists|error/iu);
  expect(second.stdout).toMatch(/已是最新|no-op/iu);

  // 第三次也一样 —— 计划要求的是「每次启动都跑」，不是「只重跑一次没事」
  expect(runCliCli([dbPath]).status).toBe(0);
});

it("未指定路径时报错并给出用法，退出码非 0（刻意不猜默认路径）", () => {
  const saved = process.env["OPC_DB"];
  delete process.env["OPC_DB"];
  try {
    const r = runCliCli([]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("用法");
    expect(r.stderr).toMatch(/未指定数据库路径/);
  } finally {
    if (saved !== undefined) process.env["OPC_DB"] = saved;
  }
});

it("parseArgs 处理三种写法且拒绝含糊输入", () => {
  expect(parseArgs(["a.db"]).db).toBeTruthy();
  expect(parseArgs(["--db", "a.db"]).db).toBeTruthy();
  expect(parseArgs(["--db=a.db"]).db).toBeTruthy();
  expect(parseArgs(["--db"]).error).toContain("缺路径");
  expect(parseArgs(["a.db", "b.db"]).error).toContain("两个");
  expect(parseArgs(["--nope"]).error).toContain("未知选项");
  expect(parseArgs(["-h"]).db).toBeUndefined();
  expect(parseArgs(["-h"]).error).toBeUndefined();
  // 相对路径必须被绝对化：否则同一句命令在不同 cwd 下会迁到两个不同的库
  expect(parseArgs(["x/y.db"]).db).toMatch(/[/\\]x[/\\]y\.db$/u);
});

it("OPC_DB 环境变量作为缺省来源", () => {
  const saved = process.env["OPC_DB"];
  process.env["OPC_DB"] = join(TMP, "env-" + process.pid + ".db");
  try {
    const r = runCliCli([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("env-" + process.pid);
  } finally {
    if (saved === undefined) delete process.env["OPC_DB"];
    else process.env["OPC_DB"] = saved;
  }
});
