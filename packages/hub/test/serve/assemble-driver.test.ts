/**
 * 驱动器接进常驻 Hub（serve/assemble.ts 那一侧，0048）。
 *
 * ── 为什么单独一个文件 ──────────────────────────────────────────────
 * 与 assemble-pump.test.ts 同一条分工理由：那一份的夹具是「库里有几条停在
 * CHARTER_PENDING」，本文件的夹具是「库里有几条停在 agent 那一格」。
 * 混在一个文件里最坏的结果是后来者为了自己的夹具改掉对方的 world()。
 *
 * ── 这一组存在的理由：不测它，「驱动器写完了」是一句假话 ─────────────
 * driver-pump.test.ts 那 41 发测的是【驱动器自己】。它可以全绿而【没有任何东西叫它】
 * —— 那是 0016 §4 / 0043 §4 反复抓的形状（有测试、有导出、零生产调用方）。
 * 本文件判的全是【接上之后才会坏】的事：
 *   A. 默认不开 / 注入 driveTask 【不算】开（花钱的那条路必须只由显式开关开）
 *   B. 开了真的推，而且【每一轮的 nowMs 是本轮那一刻】（认领行的先后正是尝试上限的判据）
 *   C. ⭐ 一趟驱动在飞时【巡检照跑、不排第二份】（await 上去 = 停滞检测与备份被停掉）
 *   D. 关机等到落地，而那句等待时长【从配置算】（第一版抄的是章程泵那个量级，错一个数量级）
 *   E. 只开驱动器时横幅【不说】章程卡由泵起草；两个开关各说各的
 *   F. 代码位置判据（没配备份目录时驱动器【照样开】）
 *   G. 花钱的门挡着时【终端上有声音】且【只说一次】
 *   H. 放弃那一格【当场】响
 *
 * ── 注入点用哪个，每一发不同，而且是判据 ────────────────────────────
 *  · driverPumpVia 换掉【整趟】⇒ 只在 C / D 两发用（那两发要一份【停在半路】的轮次，
 *    而真驱动器没有可控的停留点）
 *  · driveTask 只换掉【推一条任务那一发】⇒ 其余全走真驱动器（候选 SQL、认领行、
 *    上限判定、blocked、放弃那一行）
 * 代价照 charterPumpVia / pumpCardDeps 那条口径写清：走 via 的两发【不证】真驱动器的
 * 行为（那一半在 driver-pump.test.ts），走 driveTask 的几发【不证】真子进程能起
 * （那一半在 driver-pump.test.ts J 组与 engine/claude.test.ts）。
 *
 * 跑法（离线、node v24.14.0）：
 *   PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH \
 *     node --experimental-transform-types --import /tmp/opc-harness/register.mjs \
 *     --test packages/hub/test/serve/assemble-driver.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { openDb } from "../../src/db/driver.js";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import type { HubDeps } from "../../src/http/app.js";
import type { HubServer } from "../../src/http/server.js";
import type { LockAcquire } from "../../src/serve/lock.js";
import { INSERT_DELEGATION_GRAPH_SQL } from "../../src/org/commit.js";
import type { AdvanceResult, AdvanceTurnLog } from "../../src/engine/driver.js";
import type { PumpRoundResult } from "../../src/serve/charter-pump.js";
import type { DriveOptions, DriveRoundResult } from "../../src/serve/driver-pump.js";
import { boot, shutdownOrderLine, type BootResult, type ServeIo } from "../../src/serve/assemble.js";
import type { ServeArgs } from "../../src/serve/config.js";
import { createFakeScheduler } from "../../src/serve/timer.js";
import { EXIT_USAGE } from "../../src/heartbeat/maintenance.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "opc-driver-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, maxRetries: 40, retryDelay: 50 });
    } catch {
      /* 清不掉不影响结论 */
    }
  }
});

const NOW = Date.parse("2026-03-10T08:00:00Z");
const OK_LOCK: LockAcquire = { ok: true, path: "/virtual/hub.db.lock" };

function ioOf(): { io: ServeIo; log: string[]; warn: string[] } {
  const log: string[] = [];
  const warn: string[] = [];
  return {
    log,
    warn,
    io: {
      log: (m: string): void => {
        log.push(m);
      },
      warn: (m: string): void => {
        warn.push(m);
      },
    },
  };
}

const fakeServer = (): {
  serve(d: HubDeps, p: number, b: unknown): Promise<HubServer>;
  portUsed(): number | null;
} => {
  let used: number | null = null;
  return {
    serve(_d: HubDeps, p: number, _b: unknown): Promise<HubServer> {
      used = p;
      return Promise.resolve({ port: p, close: async (): Promise<void> => {} });
    },
    portUsed: () => used,
  };
};

/**
 * 库里有 N 条【停在 agent 那一格】的任务（IN_PROGRESS），外加一张【角色在图上】的组织图。
 *
 * 图与状态都不是脚手架细节：候选 SQL 只认「派生集合里的状态 + assigned_role 在图上」，
 * 图读不出来的话 dispatch 直接 stop ⇒ 一轮不跑 ⇒ 下面每一发会绿在"根本没推"上。
 * 状态取 IN_PROGRESS 而不是 DECOMPOSING：那是驱动器最典型的形状（已经在干活而没人敲命令），
 * 且它在巡检那一侧是【活跃状态】—— C 组要用一条独立的停滞任务对照，见 plantStalledTask。
 */
function dbWithWorkingTasks(ids: readonly string[]): string {
  const path = join(tmp(), "hub.db");
  const dbh: DatabaseSync = openDb(path);
  migrate(dbh as never);
  dbh
    .prepare(INSERT_DELEGATION_GRAPH_SQL)
    .run(
      "g1",
      1,
      JSON.stringify({
        nodes: {
          ceo: { role_id: "ceo", can_manage: true, reports_to: null, model_family: "opus" },
          manager: { role_id: "manager", can_manage: true, reports_to: "ceo", model_family: "opus" },
          dev: { role_id: "dev", can_manage: false, reports_to: "manager", model_family: "opus" },
        },
        edges: [],
      }),
      NOW,
      "ceo",
      "测试用组织图",
    );
  const ins = dbh.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at, graph_version) " +
      "VALUES (?, ?, 'IN_PROGRESS', 'manager', 'manager', ?, ?, 1)",
  );
  ids.forEach((id, i) => ins.run(id, "想法 " + id, NOW + i, NOW + i));
  dbh.close();
  return path;
}

/** 事后种一条【一定会被判停滞】的任务，与驱动器那条分开（两个事实不共用一行）。 */
function plantStalledTask(path: string, id: string): void {
  const dbh = openDb(path);
  try {
    dbh
      .prepare(
        "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at, graph_version) " +
          "VALUES (?, '停滞夹具', 'IN_PROGRESS', 'dev', 'dev', ?, ?, 1)",
      )
      .run(id, Date.parse("2020-01-01T00:00:00Z"), Date.parse("2020-01-01T00:00:00Z"));
  } finally {
    dbh.close();
  }
}

/** 事后给某条任务种一笔【已花掉的钱】（花钱的门读的那一列）。 */
function spendIn(path: string, taskId: string, cents: number): void {
  const dbh = openDb(path);
  try {
    dbh
      .prepare(
        "INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, consumed_cents, hard_stop) " +
          "VALUES (?, 'task', ?, 'per_task', ?, ?, 1) " +
          "ON CONFLICT(scope_type, scope_id, period) DO UPDATE SET consumed_cents = excluded.consumed_cents",
      )
      .run("task|" + taskId + "|per_task", taskId, cents, cents);
  } finally {
    dbh.close();
  }
}

const claimTimes = (path: string): number[] => {
  const dbh = openDb(path);
  try {
    const rows = dbh
      .prepare(
        "SELECT DISTINCT created_at AS t FROM events " +
          "WHERE json_extract(payload, '$.kind') = 'DriverTurnClaimed' ORDER BY t",
      )
      .all() as { t: number | bigint }[];
    return rows.map((r) => Number(r.t));
  } finally {
    dbh.close();
  }
};

const kindCount = (path: string, kind: string): number => {
  const dbh = openDb(path);
  try {
    return Number(
      (
        dbh
          .prepare("SELECT COUNT(*) AS n FROM events WHERE json_extract(payload, '$.kind') = ?")
          .get(kind) as { n: number | bigint }
      ).n,
    );
  } finally {
    dbh.close();
  }
};

/** 一条推不动也不花钱的 AdvanceResult（stopped:stalled ⇒ 驱动器本轮不推进状态）。 */
function stalledAdvance(taskId: string): AdvanceResult {
  const log: AdvanceTurnLog = {
    turn: 1,
    res: {
      taskId,
      role: "manager",
      moved: false,
      seat: "agent",
      note: "这一轮在等一份外部确认（夹具）",
      costCents: 0,
      sessionId: null,
      stateEventSeq: null,
      card: null,
    },
    recorded: true,
    why: "已留痕",
  };
  return { taskId, turns: [log], stopped: "stalled", totalCostCents: 0, status: "IN_PROGRESS" };
}

const happens = async (cond: () => boolean, ms = 4000): Promise<boolean> => {
  const until = Date.now() + ms;
  for (;;) {
    if (cond()) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => {
      setTimeout(r, 5);
    });
  }
};

const needOk = (r: BootResult): Extract<BootResult, { ok: true }> => {
  if (!r.ok) throw new Error("前置失败：" + r.message);
  return r;
};
const needErr = (r: BootResult): Extract<BootResult, { ok: false }> => {
  if (r.ok) throw new Error("本该失败却起来了");
  return r;
};

/** 一份「驱动器开着且三格齐全」的 args。注意 charterPump 【不带】—— 两个开关独立。 */
const driverArgs = (path: string, extra: Partial<ServeArgs> = {}): ServeArgs =>
  ({
    dbPath: path,
    port: 8787,
    heartbeatMs: 60_000,
    noBackup: true,
    driverPump: true,
    maxBudgetUsd: 0.5,
    taskLimitCents: 500,
    agentCwd: tmp(),
    ...extra,
  }) as ServeArgs;

/** 只记【被推的是哪条、给的是哪个时刻】的假推法。 */
function spyDrive(
  calls: { taskId: string; nowMs: number }[],
  o: { readonly throwFor?: string } = {},
): DriveOptions["driveTask"] {
  return async (taskId: string): Promise<AdvanceResult> => {
    // nowMs 不在 DriveTaskFn 的签名里（它是 DriveOptions 的一格），
    // 所以 B 组要的那个值只能从【认领行】读回来 —— 见 claimTimes。
    // 这里记 taskId 是为了让"推了哪几条"这一判据不依赖读库。
    calls.push({ taskId, nowMs: 0 });
    if (o.throwFor !== undefined && o.throwFor === taskId) throw new Error("推这一发炸了（夹具）");
    return stalledAdvance(taskId);
  };
}

describe("A 组：默认不开 = 一分钱不花", () => {
  it("⭐ 库里有可推的任务而【没开驱动器】⇒ 三个心跳之后一次都没推，也没有认领行", async () => {
    const path = dbWithWorkingTasks(["t1"]);
    const calls: { taskId: string; nowMs: number }[] = [];
    const s = createFakeScheduler(NOW);
    const { io } = ioOf();
    const r = needOk(
      await boot({ ...driverArgs(path), driverPump: undefined } as ServeArgs, io, {
        acquire: () => OK_LOCK,
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
        driveTask: spyDrive(calls),
      }),
    );
    s.advance(3 * 60_000);
    await r.heartbeat.tick();
    expect(calls).toEqual([]);
    expect(kindCount(path, "DriverTurnClaimed")).toBe(0);
    await r.shutdown();
  });

  it("⭐ 只注入 driveTask 而 args 里没开 ⇒ 注入【不算】开关", async () => {
    // 防的是"为了让测试方便而让注入等于开泵"那条后门：一旦存在，
    // 「花钱必须显式」这条立场就只是文档 —— 任何组合根（Electron 主进程）
    // 都能不带开关地把自动花钱那条路打开。
    const path = dbWithWorkingTasks(["t1"]);
    const calls: { taskId: string; nowMs: number }[] = [];
    const s = createFakeScheduler(NOW);
    const { io, warn } = ioOf();
    const r = needOk(
      await boot({ ...driverArgs(path), driverPump: undefined } as ServeArgs, io, {
        acquire: () => OK_LOCK,
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
        driveTask: spyDrive(calls),
      }),
    );
    await r.heartbeat.tick();
    expect(calls).toEqual([]);
    expect(warn.join(" ")).not.toContain("驱动器【已开】");
    await r.shutdown();
  });

  it("⭐ 只开【章程泵】而三格齐全 ⇒ 驱动器【不】被连带打开（M8 补的那一发）", async () => {
    /**
     * 这一发是**变异实验逼出来的**，不是我先想到的（0048 §9 的 M8）。
     *
     * 装配层那两个开关长这样：
     *   const charterOn = args.charterPump === true && bounds.ok === true;
     *   const driverOn  = args.driverPump  === true && bounds.ok === true;
     * 把 `driverOn` 写成 `bounds.ok === true`（漏掉 `args.driverPump` 那一半）之后，
     * 我**原来那 41 发全绿** —— 因为 E 组只测了「只开驱动器」那一侧，
     * 而 A 组测的是「两个都没开」。缺的正是中间那一格：**只开章程泵**。
     *
     * 而那一格在真机上是**到得了的**：`pumpBoundsOf` 在【任一】开关开着时就判 bounds.ok，
     * 所以 `--charter-pump --max-budget-usd 0.5 --task-limit-cents 500 --agent-cwd …`
     * 这样一行**完全合法**的命令行（config.ts 那三格必填吃的是"任一开关"），
     * 在坏版本下会**顺带把驱动器打开** —— 一个人批的是"让它自己补章程卡"这一件事，
     * 得到的是"另外还有一条会持续跑角色的循环"。那是两条独立的**花钱决定被一个参数打开**，
     * 而 `--driver-pump` 那条"必须显式"的立场（config.ts 里那句"刻意没有 env 缺省源"）
     * 就在这行命令行上失效。
     */
    const path = dbWithWorkingTasks(["t1"]);
    const calls: { taskId: string; nowMs: number }[] = [];
    const pumpCalls: number[] = [];
    const s = createFakeScheduler(NOW);
    const { io, warn } = ioOf();
    const r = needOk(
      await boot(
        driverArgs(path, { driverPump: undefined, charterPump: true }) as ServeArgs,
        io,
        {
          acquire: () => OK_LOCK,
          serve: fakeServer().serve,
          scheduler: s,
          now: () => s.now(),
          driveTask: spyDrive(calls),
          // 章程泵那一侧【也要注入】，否则这一发会变成"真起子进程去起草章程"——
          // 那正是这一发要避免的副作用本身。它同时充当**分母**：下面断它被调过，
          // 证明这趟心跳【确实跑到了泵那一段】，于是上面那个 calls 为空
          // 不是"心跳什么都没干"造成的（0044 §9.2 那条：空断言必须先有分母）。
          charterPumpVia: (): Promise<PumpRoundResult> => {
            pumpCalls.push(1);
            return Promise.resolve({ cards: [], costCents: 0, abandoned: [], turns: [] });
          },
        },
      ),
    );
    s.advance(3 * 60_000);
    await r.heartbeat.tick();
    // 分母：章程泵【真的】被叫起来了（所以这一趟心跳不是空转）
    expect(pumpCalls.length).toBeGreaterThan(0);
    // 而驱动器【一次都没被推】—— 它没被打开，虽然 bounds.ok 成立
    expect(calls).toEqual([]);
    expect(kindCount(path, "DriverTurnClaimed")).toBe(0);
    // 横幅也不许谎称驱动器开着
    expect(warn.join(" ")).not.toContain("驱动器【已开】");
    expect(warn.join(" ")).toContain("章程泵【已开】");
    await r.shutdown();
  });
});

describe("B 组：开了真的推，而时刻是【本轮那一刻】", () => {
  it("⭐ 驱动器开着 ⇒ 任务被推、认领行落库、终端说出推了几条", async () => {
    const path = dbWithWorkingTasks(["t1"]);
    const calls: { taskId: string; nowMs: number }[] = [];
    const s = createFakeScheduler(NOW);
    const { io, log } = ioOf();
    const r = needOk(
      await boot(driverArgs(path), io, {
        acquire: () => OK_LOCK,
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
        driveTask: spyDrive(calls),
      }),
    );
    expect(await happens(() => calls.length === 1)).toBe(true);
    expect(calls.map((c) => c.taskId)).toEqual(["t1"]);
    // 判的是【认领行真的进了审计】而不只是"函数被调过"：
    // 认领行先于花钱，它是"这一格被自动推过"的唯一事后证据。
    expect(kindCount(path, "DriverTurnClaimed")).toBe(1);
    expect(log.join(" ")).toContain("驱动器：本轮推了 1 条任务");
    await r.shutdown();
  });

  it("⭐ 每一轮的 nowMs 取【本轮那一刻】：两轮认领行的 created_at 不能相同", async () => {
    // 这一发测的是一个【看起来无害而后果具体】的写法：把 nowMs 定在启动那一刻。
    // 认领行的 created_at 全相等 ⇒ 事后读 events 时"这是第几次"看不出来，
    // 而那个数字正是按格尝试上限的判据本身（driverAttemptsSql 用插入序 id，
    // 而时刻相同还意味着停滞巡检的去重基准也塌成一个点）。
    const path = dbWithWorkingTasks(["t1"]);
    const calls: { taskId: string; nowMs: number }[] = [];
    const s = createFakeScheduler(NOW);
    const { io } = ioOf();
    const r = needOk(
      await boot(driverArgs(path), io, {
        acquire: () => OK_LOCK,
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
        driveTask: spyDrive(calls),
      }),
    );
    expect(await happens(() => calls.length === 1)).toBe(true);
    s.advance(60_000);
    expect(await happens(() => calls.length === 2)).toBe(true);
    const times = claimTimes(path);
    expect(times.length).toBe(2);
    // 反向对照：真钉死在启动那一刻时这里只有一个值，且它等于 NOW。
    expect(times.every((t) => t >= NOW)).toBe(true);
    expect(times.some((t) => t > NOW)).toBe(true);
    await r.shutdown();
  });

  it("⭐ 一轮最多推 driverTaskLimit 条（透传生效，不是写死）", async () => {
    const path = dbWithWorkingTasks(["a", "b"]);
    const calls: { taskId: string; nowMs: number }[] = [];
    const s = createFakeScheduler(NOW);
    const { io } = ioOf();
    const r = needOk(
      await boot(driverArgs(path), io, {
        acquire: () => OK_LOCK,
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
        driveTask: spyDrive(calls),
        driverTaskLimit: 1,
      }),
    );
    expect(await happens(() => calls.length === 1)).toBe(true);
    await new Promise((res) => {
      setTimeout(res, 30);
    });
    expect(calls).toHaveLength(1); // 第二条被 taskLimit 挡着，而不是"还没来得及"
    await r.shutdown();
  });
});

describe("C 组：一趟驱动不得让巡检停摆（本篇最容易被【改对】改坏的一处）", () => {
  it("⭐ 一趟驱动卡在半路时，下一次心跳【巡检照跑、驱动不排第二份】", async () => {
    // await 上去会得到的形状：一趟驱动最坏 = taskLimit × maxTurns × 180 秒（默认 1 小时 48 分）
    // 远大于心跳下界 60s ⇒ ticker 走 timer.ts:335「上一轮还没结束，本轮【跳过】」
    // ⇒ 停滞检测与每日备份被一次驱动停掉，且不计失败、不触发 onFatal、不退进程。
    // 三条判据一起用，各自挡一种「看起来也测到了」（同 assemble-pump C 组）：
    //  ① skipped === 0 且 warn 里没有「上一轮心跳还没结束」
    //  ② 巡检【又报了一次停滞】⇒ 不是"job 提前 return 所以什么都没做"
    //  ③ 驱动那边 calls 仍是 1 ⇒ 挡第二份的是 driverWatch 那道 in_flight 门
    const path = dbWithWorkingTasks(["t1"]);
    const s = createFakeScheduler(NOW);
    const { io, warn } = ioOf();
    let release: (() => void) | null = null;
    let calls = 0;
    const held = new Promise<DriveRoundResult>((res) => {
      release = () => {
        res({ driven: [], costCents: 0, abandoned: [], blocked: [] });
      };
    });
    const r = needOk(
      await boot(driverArgs(path), io, {
        acquire: () => OK_LOCK,
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
        driverPumpVia: (): Promise<DriveRoundResult> => {
          calls++;
          return held;
        },
      }),
    );
    expect(await happens(() => calls === 1)).toBe(true);
    // 等第一轮的 job 【整个返回】，信号是【一个真宏任务边界】（assemble-pump C 组那条教训：
    // 等一个"我觉得它该发生"的信号会永远等不到，而红会把人推去放宽断言）。
    await new Promise((res) => {
      setTimeout(res, 10);
    });
    plantStalledTask(path, "T-STALL-2");
    const before = stallWarnCount(warn);
    s.advance(60_000);
    expect(await happens(() => stallWarnCount(warn) > before)).toBe(true);
    expect(r.heartbeat.skipped).toBe(0);
    expect(warn.join(" ")).not.toContain("上一轮心跳还没结束");
    expect(calls).toBe(1);
    expect(warn.join(" ")).toContain("上一轮驱动还在飞");
    release?.();
    await r.shutdown();
  });
});

describe("D 组：关机等到落地，而等待时长【从配置算】", () => {
  it("⭐ 驱动在飞时 shutdown ⇒ 等它落地才关队列，且那句等待时长是【真算出来的】", async () => {
    // 不等会怎样：驱动器的每一笔写入都走 q.node(...)，giveUp 后面就是 queue.close()
    // 与 releaseLock ⇒ 一趟驱动会写进【已关的队列 / 已还的锁】，那期间另一个 Hub
    // 可以起开并写同一个库。更硬的一条：认领行先于花钱，中间被切断会留下
    // "钱花了而状态边没落库"这种审计里解释不掉的形状。
    const path = dbWithWorkingTasks(["t1"]);
    const s = createFakeScheduler(NOW);
    const { io, warn } = ioOf();
    let release: (() => void) | null = null;
    let calls = 0;
    let closed = false;
    const real = new WriteQueue(path);
    const orig = real.close.bind(real);
    real.close = (async (): Promise<void> => {
      closed = true;
      await orig();
    }) as typeof real.close;
    const r = needOk(
      await boot(driverArgs(path), io, {
        acquire: () => OK_LOCK,
        openQueue: () => real,
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
        driverPumpVia: (): Promise<DriveRoundResult> => {
          calls++;
          return new Promise<DriveRoundResult>((res) => {
            release = () => {
              res({ driven: [], costCents: 0, abandoned: [], blocked: [] });
            };
          });
        },
        driverTaskLimit: 2,
        // 注意：driverTaskLimit 会影响 driverWait，而 maxTurns 没有装配注入入口
        // （BootOverrides 里没这一格）⇒ 横幅里那个"每条几格"永远是默认 12。
        // 这一发因此同时是那一格的【现状记录】：数字变了会红，红的时候来看这条注释。
      }),
    );
    // 「确实有一趟在飞」这条前置【必须真的断言】（恒真的等会绿在"根本没派发"上）。
    expect(await happens(() => calls === 1)).toBe(true);
    const shutting = r.shutdown();
    expect(await happens(() => warn.join(" ").includes("等它落地再关队列"))).toBe(true);
    const line = warn.join("\n");
    // 最坏等待 = 2 × 12 × 180s = 72 分钟 = 1 小时 12 分。
    // 断【具体那句】而不是断"含小时"：0048 第一版那句写的是"最坏 180 秒"（抄章程泵的量级），
    // 而"含小时"这种宽松断言会放过任何一句同样错的话。
    expect(line).toContain("1 小时 12 分");
    expect(line).toContain("至多 2 条任务");
    expect(line).toContain("每条至多 12 格");
    expect(line).toContain("不要 kill -9");
    await new Promise((res) => {
      setTimeout(res, 20);
    });
    expect(closed).toBe(false);
    release?.();
    await shutting;
    expect(closed).toBe(true);
  });
});

describe("E 组：横幅按【各自的开关】说话", () => {
  it("⭐ 只开驱动器 ⇒ 说「驱动器已开」而【不说】「章程卡由泵起草」", async () => {
    // 这是 0048 把 pumpOn 拆成 charterOn / driverOn 的那一发的行为判据。
    // 合成一个布尔时，只开驱动器会得到「章程卡【由泵起草】」——
    // 一句写在关着的泵上的谎话，而它下面还在教人敲 hub work。
    const path = dbWithWorkingTasks(["t1"]);
    const s = createFakeScheduler(NOW);
    const { io, log, warn } = ioOf();
    const r = needOk(
      await boot(driverArgs(path), io, {
        acquire: () => OK_LOCK,
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
        driveTask: spyDrive([]),
      }),
    );
    const all = warn.join("\n") + "\n" + log.join("\n");
    expect(all).toContain("驱动器【已开】（--driver-pump）");
    expect(all).not.toContain("章程泵【已开】");
    expect(all).not.toContain("章程卡【由泵起草】");
    // 只开驱动器时那句"章程卡没人起草"必须说：CHARTER_PENDING 那一格驱动器【不管】。
    expect(all).toContain("章程卡【没人起草】");
    // 三个上限是从 bounds 来的，不是写死的（同一句在两个泵里同源）。
    expect(all).toContain("0.5 美元");
    expect(all).toContain("500 美分");
    await r.shutdown();
  });

  it("⭐ 两个开关都开 ⇒ 说「两个泵都开着」，一句都不少", async () => {
    const path = dbWithWorkingTasks(["t1"]);
    const s = createFakeScheduler(NOW);
    const { io, log, warn } = ioOf();
    const r = needOk(
      await boot({ ...driverArgs(path), charterPump: true } as ServeArgs, io, {
        acquire: () => OK_LOCK,
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
        driveTask: spyDrive([]),
      }),
    );
    const all = warn.join("\n") + "\n" + log.join("\n");
    expect(all).toContain("驱动器【已开】");
    expect(all).toContain("章程泵【已开】");
    expect(all).toContain("两个泵都开着");
    await r.shutdown();
  });

  it("⭐ 只开驱动器而【缺三格上限】⇒ 退 2 且不监听（bounds 吃两个开关）", async () => {
    const path = dbWithWorkingTasks(["t1"]);
    const { io, warn } = ioOf();
    const srv = fakeServer();
    const r = needErr(
      await boot({ ...driverArgs(path), taskLimitCents: undefined } as ServeArgs, io, {
        acquire: () => OK_LOCK,
        serve: srv.serve,
      }),
    );
    expect(r.code).toBe(EXIT_USAGE);
    // 判返回值而不是 io.warn（boot 的契约，assemble-pump E 组那条同一条）。
    expect(r.message).toContain("--task-limit-cents");
    expect(srv.portUsed()).toBeNull();
  });

  it("⭐ Ctrl-C 那句【停止顺序】按开关取措辞（只开驱动 ⇒ 带上驱动那一格）", () => {
    // ⚠ 这一发判的是【纯函数】而不是 boot 的输出，而这件事要如实写出来：
    // 那句话原本内联在 runServeCli 里，而 runServeCli 走到那行之后就挂在
    // waitForShutdown 上等信号 —— 测试里要走到那一行只能给自己发 SIGINT，
    // 而那一发会被同进程其它用例留下的监听收到（注册后不注销）。
    // 我先写的这一发是直接 boot 然后读 log，红在 `实到 ""`：boot 根本不打那行。
    // 那一次红的价值是它暴露了「这句话的两个分支在本机【一次也没被执行过】」，
    // 而它两个分支承诺的是两种差一个数量级的等待时长。所以按 serveBannerOf
    // 那条既有先例把它抽成 shutdownOrderLine，两个分支就有了分母。
    // 【这一发证不了】runServeCli 真的把这句话打出来了 —— 那一格本机没有覆盖度，
    // 与 serveBannerOf 文件头自己写的那句取舍同一条，不假装它被覆盖了。
    const driverOn = shutdownOrderLine({ driverPump: true } as ServeArgs);
    expect(driverOn).toContain("在飞的驱动轮");
    expect(driverOn).toContain("不要 kill -9");
    // 驱动开着时【不给具体秒数】：那句等待时长由横幅按配置算，这里指回它。
    // 两处各写一遍数字 = 两个来源，漂的时候没有东西会红。
    // （⚠ 这一句里【仍然】有 180 秒 —— 那是【章程起草】那一格的，它确实就是 180 秒。
    // 我第一版把它写成 not.toContain("最坏 180 秒") 并侥幸通过：真的那半句是
    // "最坏等 180 秒"，我挑的字符串只是差一个字而恰好躲开了。所以这里改判
    // "不重算一份"那句承诺本身 —— 它才是"等待时长只有横幅一个来源"这件事的物证。）
    expect(driverOn).toContain("上面那条驱动器横幅");
    expect(driverOn).toContain("这里不重算一份");
    // 反向对照：只开章程泵时那句【不该】提驱动轮，也【不该】指回一条不存在的横幅。
    const charterOnly = shutdownOrderLine({ charterPump: true } as ServeArgs);
    expect(charterOnly).not.toContain("在飞的驱动轮");
    expect(charterOnly).toContain("最坏等 180 秒");
    expect(charterOnly).not.toContain("上面那条驱动器横幅");

    // 两个都关着：与只开章程泵同一支（那一步真的什么都不等）。
    expect(shutdownOrderLine({} as ServeArgs)).not.toContain("在飞的驱动轮");
    // 只开驱动器：顺序里有驱动那一格，而那句 180 秒仍然只属于章程那一格。
    expect(driverOn).toContain("章程起草在飞最坏等 180 秒");
  });
});

describe("F 组：代码位置判据（最容易【看起来接好了而其实没接】）", () => {
  it("⭐ 没配 --backup-dir ⇒ 驱动器【照样开】", async () => {
    // 派发那一段落在 `if (backupDir === undefined) return` 之后的话，现象是：
    // 命令行写了 --driver-pump、横幅说"已开"、而任务一步不动 ——
    // 一个【配置写了而没生效】的形状，症状与"从没打算开"逐字相同。
    const path = dbWithWorkingTasks(["t1"]);
    const calls: { taskId: string; nowMs: number }[] = [];
    const s = createFakeScheduler(NOW);
    const { io } = ioOf();
    const r = needOk(
      await boot(driverArgs(path, { noBackup: true }), io, {
        acquire: () => OK_LOCK,
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
        driveTask: spyDrive(calls),
      }),
    );
    expect(await happens(() => calls.length === 1)).toBe(true);
    await r.shutdown();
  });
});

describe("G 组：花钱的门挡着时【终端上要有声音】", () => {
  it("⭐ 超限的任务【不起子进程】而那句理由【说出来了】", async () => {
    const path = dbWithWorkingTasks(["t1"]);
    spendIn(path, "t1", 150);
    const calls: { taskId: string; nowMs: number }[] = [];
    const s = createFakeScheduler(NOW);
    const { io, warn } = ioOf();
    const r = needOk(
      await boot(driverArgs(path, { taskLimitCents: 100 }), io, {
        acquire: () => OK_LOCK,
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
        driveTask: spyDrive(calls),
      }),
    );
    expect(await happens(() => warn.join("\n").includes("花钱的门关着"))).toBe(true);
    expect(calls).toEqual([]);
    // 认领行【一条都没有】：被门挡住的任务按定义不在候选里，
    // 写了就会把停滞计时器拨着 —— 那会被读成"这一格有人在看着"。
    expect(kindCount(path, "DriverTurnClaimed")).toBe(0);
    const line = warn.join("\n");
    expect(line).toContain("追加预算");
    expect(line).toContain("想法 t1");
    expect(line).toContain("150");
    await r.shutdown();
  });

  it("⭐ 同一条任务【只说一次】：每心跳重复说等于把信号淹掉", async () => {
    const path = dbWithWorkingTasks(["t1"]);
    spendIn(path, "t1", 150);
    const calls: { taskId: string; nowMs: number }[] = [];
    const s = createFakeScheduler(NOW);
    const { io, warn } = ioOf();
    const r = needOk(
      await boot(driverArgs(path, { taskLimitCents: 100 }), io, {
        acquire: () => OK_LOCK,
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
        driveTask: spyDrive(calls),
      }),
    );
    for (let i = 0; i < 5; i++) {
      s.advance(60_000);
      await r.heartbeat.tick();
    }
    expect(await happens(() => warn.join("\n").includes("花钱的门关着"))).toBe(true);
    const said = warn.filter((m) => m.includes("花钱的门关着")).length;
    expect(said).toBe(1);
    // 分母：确实跑了多轮，否则"只说一次"可能只是"只跑了一次"。
    expect(s.now()).toBeGreaterThan(NOW + 4 * 60_000);
    expect(calls).toEqual([]);
    await r.shutdown();
  });

  it("⭐【没超限】时不说这句话（反向对照：上面两发不是恒绿）", async () => {
    const path = dbWithWorkingTasks(["t1"]);
    const calls: { taskId: string; nowMs: number }[] = [];
    const s = createFakeScheduler(NOW);
    const { io, warn } = ioOf();
    const r = needOk(
      await boot(driverArgs(path, { taskLimitCents: 100_000 }), io, {
        acquire: () => OK_LOCK,
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
        driveTask: spyDrive(calls),
      }),
    );
    expect(await happens(() => calls.length === 1)).toBe(true);
    expect(warn.join("\n")).not.toContain("花钱的门关着");
    await r.shutdown();
  });
});

describe("H 组：放弃那一格【当场】响", () => {
  it("⭐ 试到上限 ⇒「驱动器【不再推】」这句必须响，且审计里留下放弃行", async () => {
    // 这一句是【当场】那一个信号。它存在的三条理由（driver-pump.ts 文件头与
    // reportDriveRound 那段量过）：停滞巡检约一个阈值之后【会】报这一格，但那是
    // 半小时后的一句计数、要心跳还活着、且说不出成因。所以这句不能被"巡检会报"省掉。
    const path = dbWithWorkingTasks(["t1"]);
    const calls: { taskId: string; nowMs: number }[] = [];
    const s = createFakeScheduler(NOW);
    const { io, warn } = ioOf();
    const r = needOk(
      await boot(driverArgs(path), io, {
        acquire: () => OK_LOCK,
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
        driveTask: spyDrive(calls),
        driverMaxAttempts: 1,
      }),
    );
    expect(await happens(() => warn.join("\n").includes("驱动器【不再推】"))).toBe(true);
    const line = warn.join("\n");
    expect(line).toContain("没有人推它");
    // ⚠ 这一句【不许】说成"巡检永远不会报"（0048 那处读错的原文），
    // 也不许因此被删掉（删了就只剩半小时后那个计数）。
    expect(line).toContain("停滞巡检");
    expect(kindCount(path, "DriverTurnAbandoned")).toBe(1);
    expect(kindCount(path, "DriverTurnClaimed")).toBe(1);
    await r.shutdown();
  });

  it("⭐ 驱动一整轮抛 ⇒ 说一句【本轮没有结论】，而心跳【不因此计一次失败】", async () => {
    // 与"一条任务推不动"是两层：那一层由驱动器自己记进审计（F 组那发）。
    // 这一层坏的是候选 SQL 都跑不了 ⇒ 一条都没推而屏幕上一片安静，
    // 那与"库里没有可推的任务"无法区分。consecutiveFailures 必须仍是 0，
    // 否则一次配置事故会连坐掉整条心跳（含巡检与备份）。
    const path = dbWithWorkingTasks(["t1"]);
    const s = createFakeScheduler(NOW);
    const { io, warn } = ioOf();
    const r = needOk(
      await boot(driverArgs(path), io, {
        acquire: () => OK_LOCK,
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
        driverPumpVia: (): Promise<DriveRoundResult> =>
          Promise.reject(new Error("no such table: tasks（夹具）")),
      }),
    );
    expect(await happens(() => warn.join(" ").includes("本轮没有结论"))).toBe(true);
    expect(warn.join(" ")).toContain("no such table: tasks（夹具）");
    expect(r.heartbeat.consecutiveFailures).toBe(0);
    expect(r.heartbeat.stopped).toBe(false);
    await r.shutdown();
  });

  it("⭐ 一条推不动【不牵连】整轮：下一轮还会试，而那一句当场说过", async () => {
    const path = dbWithWorkingTasks(["t1"]);
    const calls: { taskId: string; nowMs: number }[] = [];
    const s = createFakeScheduler(NOW);
    const { io, warn } = ioOf();
    const r = needOk(
      await boot(driverArgs(path), io, {
        acquire: () => OK_LOCK,
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
        driveTask: spyDrive(calls, { throwFor: "t1" }),
        driverMaxAttempts: 5,
      }),
    );
    expect(await happens(() => warn.join("\n").includes("一条任务推不动"))).toBe(true);
    // 抛过的那一次【照样留了认领行】—— 上限的地基就是这件事（driver-pump F 组同一条）。
    expect(kindCount(path, "DriverTurnClaimed")).toBe(1);
    expect(warn.join("\n")).toContain("推这一发炸了（夹具）");
    await r.shutdown();
  });
});

/**
 * 「巡检报过停滞」的计数。
 *
 * 与 assemble-pump.test.ts 里那份同名 helper 【故意各写一份】：那一份数的是
 * 同一句话而两边判的是两个不同的任务集合，共用一份会把两个夹具耦在一起
 * （改一处两边都红，而红的原因只在其中一边）。重复的是三行 filter，耦住的是两个文件。
 */
function stallWarnCount(warn: readonly string[]): number {
  return warn.filter((m) => m.includes("巡检：本轮新增停滞")).length;
}
