/**
 * 桩路线的写权限守卫（O1-1）：`hub run` / `hub resume` 只许写**桩自己建的库**。
 *
 * ── 这一族防的是什么 ────────────────────────────────────────────────
 * `hub run` 用 `StubRegistry`（返回 `"stub:" + tier`，一行工具调用都不做），
 * 而它写的是一张【真的状态机】，一路推到终态、中间**没有任何人类席位判定**。
 * 打在生产库上的产物是「一批看着跑完了、还带完整审计轨迹的任务」，
 * 而那条轨迹里没有一次是人批的。审计越漂亮，这种产物越像证据。
 *
 * ── 为什么不是设计文档原本写的那句「库里已有 tasks 行 ⇒ 拒绝」────────
 * **那句不成立，而且是静默不成立**：一条全新的真库被误指给桩时 `count(tasks) === 0`
 * ⇒ 放行 ⇒ 桩把生产库当演示库收养。守卫在**最有价值的那一发**上是绿的。
 * 所以判据换成【归属】：库文件头上带 `STUB_DB_MARKER` 的才是桩可以自己写的库。
 * 本文件第 3 发（"一条【全新的】真库也被拒"）钉的就是这个差别 ——
 * **把它删掉，另外两发照样绿，而守卫就退回那个有洞的版本了。**
 *
 * ── 退出码即契约 ────────────────────────────────────────────────────
 * 全部走真子进程（同 smoke.test.ts 那条纪律：V13 实测过"日志里看着报错了"不等于
 * 门禁生效，凡是退出码都得是真进程的 exit code）。
 */
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { STUB_DB_MARKER } from "../../src/db/pragmas.js";

const HUB_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI_SCRIPT = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const MIGRATE_SCRIPT = fileURLToPath(
  new URL("../../src/db/migrate-cli.ts", import.meta.url),
);
const req = createRequire(import.meta.url);

interface Run {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

function run(script: string, args: readonly string[]): Run {
  const r = spawnSync(
    process.execPath,
    [req.resolve("tsx/cli"), script, ...args],
    {
      cwd: HUB_ROOT,
      encoding: "utf8",
      timeout: 170_000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    },
  );
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}
const hub = (args: readonly string[]): Run => run(CLI_SCRIPT, args);

const dirs: string[] = [];
function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "opc-stub-guard-"));
  dirs.push(dir);
  return join(dir, "hub.db");
}

afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, maxRetries: 40, retryDelay: 50 });
    } catch {
      /* Windows 上 WAL 句柄释放有延迟，清不掉不影响结论 */
    }
  }
});

/** 只读的第二条连接（写连接看得见自己未提交的写入，拿它数行会假绿）。 */
function readOne(dbPath: string, sql: string): Record<string, unknown> {
  const ro = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return ro.prepare(sql).get() as Record<string, unknown>;
  } finally {
    ro.close();
  }
}
const userVersion = (dbPath: string): number =>
  Number(readOne(dbPath, "PRAGMA user_version")["user_version"]);
const taskIds = (dbPath: string): string[] => {
  const ro = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (
      ro.prepare("SELECT id FROM tasks ORDER BY id").all() as { id: string }[]
    ).map((r) => r.id);
  } finally {
    ro.close();
  }
};

/**
 * 造一条【真库】：走 `pnpm migrate` 那条路（生产入口建的库就是这个形状）。
 *
 * 不用手搓 `CREATE TABLE`：手搓出来的库缺一半表，它被拒可能是因为【表不全】
 * 而不是因为【不是桩建的】—— 那样这条测试证的就不是守卫的判据。
 */
function makeRealDb(dbPath: string): void {
  const r = run(MIGRATE_SCRIPT, ["--db", dbPath]);
  expect(r.code, "造真库这一步自己得先成功：" + r.out + r.err).toBe(0);
  // 前提断言：生产入口【没有】打桩标记。哪天 migrate-cli 学会打标记了，
  // 下面所有「被拒」的测试都会变成「被放行」，而原因完全看不出来。
  expect(userVersion(dbPath)).not.toBe(STUB_DB_MARKER);
}

describe("桩路线的写权限守卫（O1-1）", () => {
  it("桩新建的库会被自动认领，且能接着 resume", () => {
    const dbPath = tmpDbPath();
    const r = hub([
      "run",
      "--db",
      dbPath,
      "--task",
      "T-CLAIM",
      "--idea",
      "想法",
    ]);
    expect(r.code, r.err).toBe(0);
    expect(userVersion(dbPath)).toBe(STUB_DB_MARKER);
    // 认领不是只在 run 那一次生效：resume 走的是同一道守卫，它必须放行同一个库。
    const again = hub(["resume", "--db", dbPath, "--task", "T-CLAIM"]);
    expect(again.code, again.err).toBe(0);
  });

  it("一条【已有内容、但不是桩建的】库被拒：退出 2，且库一个字节没变", () => {
    const dbPath = tmpDbPath();
    makeRealDb(dbPath);
    const before = userVersion(dbPath);
    const r = hub([
      "run",
      "--db",
      dbPath,
      "--task",
      "T-FORB",
      "--idea",
      "想法",
    ]);
    expect(r.code).toBe(2);
    // 红行要能认出【为什么】，只说"拒绝"会被当成环境坏了去重装依赖。
    expect(r.err).toContain("桩模型");
    expect(r.err).toContain("user_version");
    // ⚠ 反向配对：只断「退出 2」不够 —— 守卫可能在报错之前已经跑了一半。
    expect(taskIds(dbPath)).toEqual([]);
    expect(userVersion(dbPath)).toBe(before);
  });

  it("⭐ 一条【全新的】真库也被拒（这条是守卫与设计文档原方案的差别所在）", () => {
    // 设计文档 O1-1 原话是「若该库已经有 tasks 行且没有任何标记 ⇒ 拒绝」。
    // 这一发就是那句判据会【放行】的场景：库是生产入口刚建的、一行任务都没有。
    // 「有没有内容」判不了【这个库是谁的】—— 而要看的是后者。
    const dbPath = tmpDbPath();
    makeRealDb(dbPath);
    expect(taskIds(dbPath)).toEqual([]); // 空库 ⇒ 原方案的判据在这里放行
    const r = hub([
      "run",
      "--db",
      dbPath,
      "--task",
      "T-BRAND",
      "--idea",
      "想法",
    ]);
    expect(r.code).toBe(2);
    expect(taskIds(dbPath)).toEqual([]);
  });

  it("resume 同样被挡（只挡 run 等于留了一个『第一次不许、第二次随便』的门槛）", () => {
    const dbPath = tmpDbPath();
    makeRealDb(dbPath);
    const r = hub(["resume", "--db", dbPath, "--task", "T-RES"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("hub resume");
  });

  it("status 不被挡：只读命令不该需要写权限", () => {
    // 这一发是【反向对照】，不是凑数。守卫若被写成"任何子命令都查标记"，
    // 上面四发全绿而用户连看都看不了一个真库 —— 那种守卫会被人整个关掉。
    const dbPath = tmpDbPath();
    makeRealDb(dbPath);
    const r = hub(["status", "--db", dbPath, "--task", "T-NONE"]);
    expect(r.code).toBe(2); // 任务不存在 ⇒ 2
    expect(r.err).not.toContain("桩模型"); // 但红因必须是"任务不存在"，不是归属
    expect(r.err).toContain("任务不存在");
  });

  it("打不开的那个库【不能】被放行：读不出标记就等于不是桩的", () => {
    // 一个不是 SQLite 文件的文件。判据必须是拒绝而不是"读失败 ⇒ 当它是新库"：
    // openDb 对这种路径也会抛，所以这里同时钉住"失败方向是拒绝"。
    const dir = mkdtempSync(join(tmpdir(), "opc-stub-guard-junk-"));
    dirs.push(dir);
    const dbPath = join(dir, "hub.db");
    writeFileSync(dbPath, "这不是 SQLite 文件\n");
    const r = hub([
      "run",
      "--db",
      dbPath,
      "--task",
      "T-JUNK",
      "--idea",
      "想法",
    ]);
    expect(r.code).toBe(2);
    // 红因也得对：退 2 的形状有好几种（参数错、任务已存在、归属不明…），
    // 只判退出码的话，一条因为【解析参数失败】而红的测试会替这条掩护。
    expect(r.err).toContain("无法确认这个库的归属");
    // 原样还在：守卫不能一边拒绝一边把人家文件截断（openDb 若先跑就会这样）。
    expect(readFileSync(dbPath, "utf8")).toBe("这不是 SQLite 文件\n");
  });

  it("标记值的两条性质：大到不可能是迁移条数，且全仓只有一处在写它", () => {
    // `PRAGMA user_version` 是 SQLite 唯一【读不需要写权限】的自定义槽位，所以被
    // 本守卫占了。它的另一条常见用法是存迁移条数 —— 那两个语义会互相伪装
    // （条数会长，标记必须恒定），所以这里把"它不能长得像条数"钉成一条断言。
    expect(STUB_DB_MARKER).toBeGreaterThan(10_000);
    const writers: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const f = join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== "node_modules" && e.name !== "dist") walk(f);
          continue;
        }
        if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) continue;
        let t: string;
        try {
          t = readFileSync(f, "utf8");
        } catch (e) {
          // 并行的越界探针（写进 packages/hub/src/ 又当场删掉）会撞在这里。
          // 只宽容"消失了"，其他错误照旧抛 —— 同 test-inventory.ts 那条纪律。
          const code = (e as { code?: string }).code;
          if (code === "ENOENT" || code === "ENOTDIR") continue;
          throw e;
        }
        // 判的是【写】：PRAGMA user_version = <值>。读（prepare 那条）不算。
        if (/PRAGMA user_version\s*=/i.test(t)) writers.push(f);
      }
    };
    walk(join(HUB_ROOT, "src"));
    // 唯一出处是 pragmas.ts 的 markStubDb。第二处写它 = 第二个地方能决定"这库是谁的"。
    expect(
      writers.map((f) => f.replace(/\\/g, "/").split("/").slice(-2).join("/")),
    ).toEqual(["db/pragmas.ts"]);
  });

  it("守卫本身有判别力：把标记值改掉一位，桩自己的库就会被拒", () => {
    // 方向反过来的一发：如果【读侧】和【写侧】各抄一份标记值，改一位就会让
    // 所有合法演示库被拒（红得像是守卫生效了）。这条钉的是"两处必须是同一个常量"。
    // 做法：用 cli 建库，然后把 user_version 手动改成 STUB_DB_MARKER + 1，再 resume ⇒ 拒。
    const dbPath = tmpDbPath();
    expect(
      hub(["run", "--db", dbPath, "--task", "T-OFF", "--idea", "想法"]).code,
    ).toBe(0);
    const w = new DatabaseSync(dbPath);
    w.exec("PRAGMA user_version = " + (STUB_DB_MARKER + 1) + ";");
    w.close();
    const r = hub(["resume", "--db", dbPath, "--task", "T-OFF"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("user_version");
  });
});
