/**
 * 常驻 Hub 的装配（serve/assemble.ts）。
 *
 * ── 这一组钉的不是「能不能起来」，是【起不来时留下了什么】──────────────
 * boot 有十一条出口，其中九条是失败。失败路径的代价不对称：
 *   · 没还锁 ⇒ 这个库【永久起不来】，且报错指向一个不存在的另一个 Hub
 *   · 没关队列 ⇒ 一条留在 WAL 里的连接，下一次 migrate 撞 locked
 *   · 没说话 ⇒ 「Hub 在跑而停滞检测/备份根本没配」，只在出事那天才知道
 * 所以本文件里断言「锁目录干净」的次数比断言「能起来」多。这不是口味：
 * boot 的失败路径在本机【全部可构造】（不需要两个进程、不需要 @langchain），
 * 不测它们就是能测而没测。
 *
 * ── 注入点开四个（acquire / openQueue / serve / scheduler）────────────
 * 不是为了「解耦」这个抽象理由。是因为这四件在本机各有一种做不了的事：
 *   真锁：要两个进程（缺 tsx，带相对 import 的 .ts 子进程起不来，0009 §2）
 *   真图：要 @langchain（同上）
 *   真时钟：一轮心跳 15 分钟
 *   真监听：端口在本机是竞争资源
 * 代价写清楚，别把本组读成「装配已充分验证」：
 *   · 本组【不证】真的 WriteQueue 打得开这个库 ⇒ 那是 test/db/write-queue.test.ts
 *   · 本组【只有一发】碰真的 serveHub（最后一组那发），其余都换掉 ⇒
 *     「真在听那个端口」由 test/http/server.test.ts（真 TCP 回环）覆盖
 *   · 本组【不证】图恢复 ⇒ 那一格只证「它响亮地说自己不可用」
 * 本组证的是【顺序、清理、与说了什么】—— 那是 assemble.ts 唯一自己的东西。
 *
 * ── 真的那半边尽量是真的 ────────────────────────────────────────────
 * 库、迁移、完整性检查（含 worker 里那条 PRAGMA integrity_check）、事件总线、
 * 巡检 SQL、备份（真 VACUUM INTO + 真保留策略）都走真实现。
 * 唯一被换掉的是上面那四件。
 */
import {
  closeSync,
  copyFileSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { HubDeps } from "../../src/http/app.js";
import type { HubServer } from "../../src/http/server.js";
import type { WriteQueue } from "../../src/db/write-queue.js";
import { backupName } from "../../src/db/backup.js";
import { acquireLock, lockPathFor, type LockAcquire } from "../../src/serve/lock.js";
import { bindFailureIsFatal, LOOPBACK_HOST, type BindDecision } from "../../src/http/bind.js";
import {
  bindForAssembly,
  boot,
  graphNotWiredMessage,
  GRAPH_NOT_WIRED,
  lastBackupAtMs,
  runServeCli,
  serveBannerOf,
  unavailableGraphFor,
  type BootResult,
  type ServeIo,
} from "../../src/serve/assemble.js";
import type { ServeArgs } from "../../src/serve/config.js";
import { createFakeScheduler, type FakeScheduler } from "../../src/serve/timer.js";
import { EXIT_OK, EXIT_PROBLEM, EXIT_USAGE } from "../../src/heartbeat/maintenance.js";
import { openDb } from "../../src/db/driver.js";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue as RealWriteQueue } from "../../src/db/write-queue.js";

const dirs: string[] = [];
function tmp(prefix = "opc-serve-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
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

/** 一份真迁移过的库。用真 migrate 而不是手搓表：本组要跑真的完整性检查与真的巡检。 */
function db(dir = tmp()): string {
  const path = join(dir, "hub.db");
  const dbh: DatabaseSync = openDb(path);
  migrate(dbh as never);
  dbh.close();
  return path;
}

/**
 * 往库里塞够多行，让「覆盖中间某一页」命中【数据页】而不是空闲页。
 * 空闲页被写坏是不报错的 —— 那会让下面那条「拒绝启动」绿在不存在的位置上。
 */
function fillEvents(path: string, n: number): void {
  const dbh = openDb(path);
  const stmt = dbh.prepare(
    "INSERT INTO events (task_id, actor_type, actor_id, action, target, payload, created_at) " +
      "VALUES (?,?,?,?,?,?,?)",
  );
  for (let i = 0; i < n; i++) {
    stmt.run(
      null, // task_id 给 NULL：FK 开着，不想为夹具再造 3000 个任务行
      "system",
      "fixture",
      "Probe",
      "probe",
      JSON.stringify({ kind: "Probe", i, pad: "x".repeat(160) }),
      1_700_000_000_000 + i,
    );
  }
  dbh.close();
}

/** 把库里第 page 页整页写成 0xFF。库【仍然打得开】，只有 integrity_check 看得见。 */
function corruptMiddlePage(path: string): number {
  const size = statSync(path).size;
  const off = Math.floor(size / 2 / 4096) * 4096;
  const fd = openSync(path, "r+"); // 必须 r+：integrity.test.ts 那格撞过只读 fd 上的 EINVAL
  try {
    writeSync(fd, Buffer.alloc(4096, 0xff), 0, 4096, off);
  } finally {
    closeSync(fd);
  }
  return off;
}

/** 一条被记录下来的 io。断言「说了什么」全靠它。 */
function ioOf(): { log: string[]; warn: string[]; io: ServeIo } {
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

const OK_LOCK: LockAcquire = { ok: true, path: "/virtual/hub.db.lock" };

/** 假 server：port 可控、传给它的 port 可查、close 计数可查。 */
function fakeServer(port = 8787): {
  serve(d: HubDeps, p: number): Promise<HubServer>;
  closed(): number;
  portUsed(): number | null;
} {
  let closed = 0;
  let used: number | null = null;
  return {
    serve(_d: HubDeps, p: number): Promise<HubServer> {
      used = p;
      return Promise.resolve({
        port,
        close(): Promise<void> {
          closed++;
          return Promise.resolve();
        },
      });
    },
    closed: () => closed,
    portUsed: () => used,
  };
}

/**
 * 一个 close() 可以被【人按住】的 server。
 *
 * 存在的唯一理由：giveUp 在 `await server.close()` 上是【真的会挂住】的，
 * 而「巡检那一轮在关机挂起期间恢复」这件事必须【由测试决定什么时候发生】。
 * 用 fakeServer（close 立刻 resolve）时，giveUp 与那一轮的恢复顺序
 * 完全由微任务排队决定 —— 那种写法会通过变异「把 `cleaned = true` 挪到 giveUp 末尾」，
 * 而它【该红】：一次真 Ctrl-C 撞上一条慢的 server.close() 就是那个形状。
 */
function pausableServer(port = 8787): {
  serve(d: HubDeps, p: number): Promise<HubServer>;
  /** 放行 close()。没被叫过时是 no-op。 */
  finishClose(): void;
  /** close() 已经被叫过（= giveUp 走到那一步、并且挂在那儿）。 */
  closeRequested(): boolean;
} {
  let requested = false;
  let release: (() => void) | null = null;
  return {
    serve(_d: HubDeps, _p: number): Promise<HubServer> {
      return Promise.resolve({
        port,
        close(): Promise<void> {
          requested = true;
          return new Promise<void>((res) => {
            release = () => {
              res();
              release = null;
            };
          });
        },
      });
    },
    finishClose: () => {
      release?.();
    },
    closeRequested: () => requested,
  };
}

/** 排空整条微任务队列（借一次真宏任务边界），不用「猜要 await 几个」。 */
const drainMicrotasks = (): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, 0);
  });

/** 真队列的薄壳，只多一个 close 计数 ——「失败路径也必须关队列」要有可读的判据。 */
function countingQueue(path: string): { q: WriteQueue; closed(): boolean } {
  const q = new RealWriteQueue(path);
  let closed = false;
  const orig = q.close.bind(q);
  q.close = (async (): Promise<void> => {
    closed = true;
    await orig();
  }) as typeof q.close;
  return { q, closed: () => closed };
}

/** 一个 readConnection 可被【事后】扳坏的队列壳。见用它的那发为什么要事后。 */
function breakableQueue(path: string): { q: WriteQueue; break(): void } {
  const real = new RealWriteQueue(path);
  let broken = false;
  const shell = {
    readConnection() {
      if (broken) throw new Error("读连接坏了（夹具扳的）");
      return real.readConnection();
    },
    writeConnection: () => real.writeConnection(),
    node: <T,>(fn: () => T): Promise<T> => Promise.resolve(fn()),
    tx: (fn: () => Promise<void> | void): Promise<void> => Promise.resolve().then(fn),
    close: async (): Promise<void> => {
      await real.close();
    },
  } as unknown as WriteQueue;
  return {
    q: shell,
    break: () => {
      broken = true;
    },
  };
}

/**
 * 一个 node() 可以被【事后武装成「写完再挂住」】的队列壳。
 *
 * 两个设计决定都不是省事：
 *   ① 【事后】武装：boot 自己要用这条队列（迁移走 writeConnection，启动时的完整性检查
 *      把 writer 传给 append-only 探针 ⇒ 它调 node()）。一开始就挡会把 boot 挂住，
 *      测到的是「起不来」而不是「关机之后回来了」。与 breakableQueue 同一个理由。
 *   ② 【写完再挂】而不是【不写就挂】：真队列的 node() 负责建立事务作用域（ALS），
 *      绕开它去挂 promise 会让 patrol 里的 requireScopeDb 直接抛 ⇒
 *      job 根本走不到备份那一段，测试会以一个不相干的原因绿。
 *      所以这里照原样调 real.node(fn)（审计【真的落库】），只在它 resolve之后
 *      再挂一节 —— 于是「巡检这一轮还挂在 await 上」这件事是真的，
 *      而库里也确实有了那一行停滞事件（= 下面那条防空转断言的凭据）。
 */
function gatedQueue(path: string): {
  q: WriteQueue;
  arm(): void;
  release(): void;
  /** 【已经登记在闸门上、等人放行】的数量。等到它为 1 再 release，否则会把闸门放空。 */
  waiting(): number;
} {
  const real = new RealWriteQueue(path);
  let armed = false;
  const waiters: Array<() => void> = [];
  const shell = {
    readConnection: () => real.readConnection(),
    writeConnection: () => real.writeConnection(),
    node: <T,>(fn: () => T | Promise<T>): Promise<T> => {
      const done = real.node(fn);
      if (!armed) return done;
      return done.then((v: T) => {
        let open = () => {};
        const gate = new Promise<T>((res) => {
          open = () => res(v);
        });
        waiters.push(open);
        return gate;
      });
    },
    tx: (fn: () => Promise<void> | void): Promise<void> => Promise.resolve().then(fn),
    close: async (): Promise<void> => {
      await real.close();
    },
  } as unknown as WriteQueue;
  return {
    q: shell,
    arm: () => {
      armed = true;
    },
    release: () => {
      for (const w of waiters.splice(0)) w();
    },
    waiting: () => waiters.length,
  };
}

/** 造一个【真的会被巡检判成停滞】的任务：活跃状态 + 创建于很久以前 + 一条事件都没有。 */
function plantStalledTask(path: string, id = "T-STALL"): void {
  const dbh = openDb(path);
  try {
    dbh
      .prepare(
        "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
          "VALUES (?, '停滞夹具', 'IN_PROGRESS', 'dev', 'implement', ?, ?)",
      )
      .run(id, Date.parse("2020-01-01T00:00:00Z"), Date.parse("2020-01-01T00:00:00Z"));
  } finally {
    dbh.close();
  }
}

const args = (o: Partial<ServeArgs>): ServeArgs => ({ dbPath: "/virtual/hub.db", ...o }) as ServeArgs;

/**
 * 等一个条件成立（真定时器轮询），等不到就返回 false 让断言去红。
 *
 * 为什么不用「await 固定几个微任务」：心跳那一发要穿
 * 微任务 → 动态 import → 同步 SQLite → 再一次微任务，链的长度是实现细节。
 * 「猜一个够大的轮数」这种常量正是本仓反对的形状（它会在链变长那天静默失效，
 * 而且失效方式是【绿】）。轮询 + 明确超时把失败变成看得见的红。
 */
async function happens(cond: () => boolean, ms = 4000): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (cond()) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => {
      setTimeout(r, 5);
    });
  }
}

const names = (d: string): string[] => (existsSync(d) ? readdirSync(d).map(String) : []);

function countEvents(path: string, kind: string): number {
  const dbh = openDb(path);
  try {
    const row = dbh
      .prepare("SELECT COUNT(*) AS n FROM events WHERE json_extract(payload, '$.kind') = ?")
      .get(kind) as { n: number | bigint };
    return Number(row.n);
  } finally {
    dbh.close();
  }
}

const needOk = (r: BootResult): Extract<BootResult, { ok: true }> => {
  if (!r.ok) throw new Error("前置失败：" + r.message);
  return r;
};
const needErr = (r: BootResult): Extract<BootResult, { ok: false }> => {
  if (r.ok) throw new Error("本该失败却起来了");
  return r;
};

describe("boot 是公开 API：参数层的判据它自己也要有", () => {
  it("缺 dbPath ⇒ EXIT_USAGE，且不碰锁也不碰库", async () => {
    const { io, warn, log } = ioOf();
    let acquired = 0;
    const r = needErr(
      await boot({} as ServeArgs, io, {
        acquire: (): LockAcquire => {
          acquired++;
          return OK_LOCK;
        },
      }),
    );
    expect(r.code).toBe(EXIT_USAGE);
    // Electron 主进程直接调 boot 时【不经过 argv 解析】，所以这一格必须在 boot 里有自己的判据。
    expect(acquired).toBe(0);
    expect(warn).toEqual([]);
    expect(log).toEqual([]);
  });

  it("心跳小于下界 ⇒ 拒，且【已经起好的服务被关掉、真锁被还掉】", async () => {
    const path = db();
    const { io, warn } = ioOf();
    const srv = fakeServer();
    // 锁走【真】实现：这一发要钉的就是「失败路径真的把锁还回去了」。
    // 换上一向成功的假锁，下面那句 existsSync 就成了恒真断言 ——
    // 那种断言比不写更糟，它让人以为清理已经测过。
    const r = needErr(
      await boot(args({ dbPath: path, port: 8787, heartbeatMs: 1, noBackup: true }), io, {
        serve: srv.serve,
        scheduler: createFakeScheduler(0),
      }),
    );
    expect(r.code).toBe(EXIT_USAGE);
    // 心跳校验排在 serve 之后（装配顺序如此）⇒ 这一发必须走清理那条路。
    expect(srv.closed()).toBe(1);
    expect(existsSync(lockPathFor(path))).toBe(false);
    expect(warn.join(" ")).not.toContain("Hub 已在");
    // 反向对照：同一份参数把心跳改合法，锁就该【在】。
    // 少这一发，上面那句「不在」可能只是因为锁从来没被建过。
    const { io: io2 } = ioOf();
    const ok = needOk(
      await boot(args({ dbPath: path, port: 8787, heartbeatMs: 60_000, noBackup: true }), io2, {
        serve: srv.serve,
        scheduler: createFakeScheduler(0),
      }),
    );
    expect(existsSync(lockPathFor(path))).toBe(true);
    await ok.shutdown();
  });

  it("心跳大于停滞阈值 ⇒ 警告而【不是】失败（『一天一醒』是合法的低功耗配法）", async () => {
    const path = db();
    const { io, warn } = ioOf();
    const r = needOk(
      await boot(args({ dbPath: path, port: 8787, heartbeatMs: 3 * 86_400_000, noBackup: true }), io, {
        serve: fakeServer().serve,
        scheduler: createFakeScheduler(0),
      }),
    );
    expect(warn.join(" ")).toContain("粒度变粗");
    await r.shutdown();
  });
});

describe("库不存在 / 锁拿不到：不创建、不留下垃圾", () => {
  it("⭐ 缺库 ⇒ EXIT_USAGE + 教你跑 migrate，而锁目录【必须干净】", async () => {
    const dir = tmp();
    const missing = join(dir, "typo.db");
    const { io, warn } = ioOf();
    const r = needErr(await boot(args({ dbPath: missing, port: 8787 }), io, {}));
    expect(r.code).toBe(EXIT_USAGE);
    // 修法的出口在 hint 里（runServeCli 把它单独打成一行 `→ …`）。
    // 断在 message 上会让这条用例绿在「文案挪了位置」这种无关变化上。
    expect(r.hint).toContain("migrate");
    // ⭐ 这一发防的是第一版的顺序（先抢锁再查库）：每次打错路径都在目录里
    // 留一颗 <db>.lock，长得像「曾有个 Hub 在这里跑过」。打错路径是高频动作。
    expect(names(dir)).toEqual([]);
    // 库也不该被顺手创建：openDb 会建文件，而空库的完整性检查全绿 = 最坏的「检查通过」。
    expect(existsSync(missing)).toBe(false);
    // 这一条走 message 而不是 warn（runServeCli 负责把 message 打到 stderr）。
    expect(warn).toEqual([]);
  });

  it("抢锁这一步就抛 ⇒ 翻成失败而不是让 boot 抛，且不留下锁文件", async () => {
    const path = db();
    const { io } = ioOf();
    const r = needErr(
      await boot(args({ dbPath: path, port: 8787 }), io, {
        acquire: (): LockAcquire => {
          throw new Error("EACCES 模拟");
        },
      }),
    );
    expect(r.code).toBe(EXIT_PROBLEM);
    expect(r.message).toContain("EACCES 模拟");
    // 「这一刻还没写过库」是本条出口唯一能给出的保证，所以要钉住那句话。
    expect(r.message).toContain("还没有");
    expect(existsSync(lockPathFor(path))).toBe(false);
  });

  it("锁被活人持有 ⇒ 报错带 pid 与一条可执行动作，且【一次库都没打开】", async () => {
    const path = db();
    const { io } = ioOf();
    let opened = 0;
    const r = needErr(
      await boot(args({ dbPath: path, port: 8787 }), io, {
        acquire: (): LockAcquire => ({
          ok: false,
          reason: "held_by_other_process",
          holder: { pid: 4321, startedAtMs: Date.parse("2026-03-04T05:06:07Z"), host: "h", who: "hub-serve" },
        }),
        openQueue: (): WriteQueue => {
          opened++;
          throw new Error("不该被叫到");
        },
      }),
    );
    expect(r.message).toContain("pid 4321");
    expect(r.message).toContain("kill 4321");
    expect(opened).toBe(0);
    expect(r.hint).toContain("没有开过库");
  });

  it("接管陈旧锁 ⇒ 一定【说出来】（抢错的方向是双开，这一句是唯一的现场记录）", async () => {
    const path = db();
    const { io, warn } = ioOf();
    const r = needOk(
      await boot(args({ dbPath: path, port: 8787, noBackup: true }), io, {
        acquire: (): LockAcquire => ({
          ok: true,
          path: lockPathFor(path),
          tookOverFrom: { pid: 999, startedAtMs: 1, host: "h", who: "hub-serve" },
        }),
        serve: fakeServer().serve,
        scheduler: createFakeScheduler(0),
      }),
    );
    expect(warn.join(" ")).toContain("999");
    expect(warn.join(" ")).toContain("两个写者");
    await r.shutdown();
  });
});

describe("库打不开 / 页面损坏：两种「带伤运行」都被挡住", () => {
  it("库文件被截断 ⇒ openQueue 抛被翻成 EXIT_PROBLEM，且指向 restore.md", async () => {
    const good = db();
    const cut = join(tmp(), "cut.db");
    copyFileSync(good, cut);
    const fd = openSync(cut, "r+");
    try {
      ftruncateSync(fd, Math.floor(statSync(cut).size * 0.5));
    } finally {
      closeSync(fd);
    }
    const { io } = ioOf();
    // 真锁：这一发也断言「失败必须还锁」，换成恒成功的假锁那句就是恒真的。
    const r = needErr(await boot(args({ dbPath: cut, port: 8787 }), io, {}));
    expect(r.code).toBe(EXIT_PROBLEM);
    expect(r.message).toContain("库打不开");
    expect(r.message).toContain("restore.md");
    expect(existsSync(lockPathFor(cut))).toBe(false);
  });

  it("⭐ 中间一页被写坏 ⇒ 【拒绝启动】：库打得开、迁移过得去，只有 page_integrity 看得见", async () => {
    const good = db();
    fillEvents(good, 3000);
    const bad = join(tmp(), "bad.db");
    copyFileSync(good, bad);
    const off = corruptMiddlePage(bad);
    // 前置自查：这一发要测的是「打得开而内容坏了」。
    // 如果这份夹具连库都打不开，它测的就变成上面那一发了 —— 那就是一条绿在错位上的断言。
    const probe = new RealWriteQueue(bad);
    await probe.close();

    const { io, warn } = ioOf();
    const srv = fakeServer();
    const r = needErr(
      await boot(args({ dbPath: bad, port: 8787, noBackup: true }), io, {
        serve: srv.serve,
        scheduler: createFakeScheduler(0),
      }),
    );
    expect(off).toBeGreaterThan(0);
    expect(r.code).toBe(EXIT_PROBLEM);
    expect(r.message).toContain("拒绝启动");
    expect(r.message).toContain("restore.md");
    // 服务【一次都没起】：这是「HTTP 排在完整性检查之后」那条顺序纪律的判据。
    expect(srv.portUsed()).toBe(null);
    expect(srv.closed()).toBe(0);
    expect(existsSync(lockPathFor(bad))).toBe(false);
    expect(warn.join(" ")).not.toContain("Hub 已在");
  });

  it("反向对照：同一份夹具【不损坏】时能起来（否则上面那条绿是恒红换来的）", async () => {
    const good = db();
    fillEvents(good, 500);
    const { io } = ioOf();
    const srv = fakeServer();
    const r = needOk(
      await boot(args({ dbPath: good, port: 8787, noBackup: true }), io, {
        serve: srv.serve,
        scheduler: createFakeScheduler(0),
      }),
    );
    expect(srv.portUsed()).toBe(8787);
    await r.shutdown();
  });
});

describe("备份：没配目录必须说出来；配了就必须真的备一次", () => {
  it("⭐ 没给 --backup-dir 也没给 --no-backup ⇒ 响亮警告（不是静默放行）", async () => {
    const path = db();
    const { io, warn } = ioOf();
    const r = needOk(
      await boot(args({ dbPath: path, port: 8787 }), io, {
        serve: fakeServer().serve,
        scheduler: createFakeScheduler(0),
      }),
    );
    const w = warn.join(" ");
    expect(w).toContain("不做自动备份");
    expect(w).toContain("6.5");
    await r.shutdown();
  });

  it("--no-backup ⇒ 【不】重复提醒（那是人的显式决定，再说一遍就是噪音）", async () => {
    const path = db();
    const { io, warn } = ioOf();
    const r = needOk(
      await boot(args({ dbPath: path, port: 8787, noBackup: true }), io, {
        serve: fakeServer().serve,
        scheduler: createFakeScheduler(0),
      }),
    );
    expect(warn.join(" ")).not.toContain("不做自动备份");
    await r.shutdown();
  });

  it("⭐ 首轮心跳就落一份【真的】备份；同一天再推两轮 ⇒ 仍然只有一份", async () => {
    const path = db();
    const dir = join(tmp(), "bk");
    const s: FakeScheduler = createFakeScheduler(Date.parse("2026-03-10T08:00:00Z"));
    const { io, log } = ioOf();
    const r = needOk(
      await boot(args({ dbPath: path, port: 8787, backupDir: dir, heartbeatMs: 60_000 }), io, {
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
      }),
    );
    expect(await happens(() => log.join(" ").includes("备份完成"))).toBe(true);
    expect(names(dir)).toHaveLength(1);
    // ⭐ 反向对照，这一发才是「日历日而不是 24 小时计时器」的判据：
    // 同一天内再推两轮心跳，一份都不该多。用计时器的写法这里会多出两份。
    s.advance(60_000);
    expect(await happens(() => names(dir).length > 1, 400)).toBe(false);
    expect(names(dir)).toHaveLength(1);
    s.advance(60_000);
    await happens(() => false, 50);
    expect(names(dir)).toHaveLength(1);
    await r.shutdown();
  });

  it("第二天 ⇒ 该再多一份（否则上面那个「只有一份」可能是恒不备）", async () => {
    const path = db();
    const dir = join(tmp(), "bk2");
    const s = createFakeScheduler(Date.parse("2026-03-10T08:00:00Z"));
    const { io, log } = ioOf();
    const r = needOk(
      await boot(args({ dbPath: path, port: 8787, backupDir: dir, heartbeatMs: 60_000 }), io, {
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
      }),
    );
    expect(await happens(() => names(dir).length === 1)).toBe(true);
    // 推到次日【同一时刻】：跨了日历日 ⇒ 必须再备一份。
    s.advance(24 * 3_600_000 + 60_000);
    expect(await happens(() => names(dir).length === 2)).toBe(true);
    expect(log.join(" ")).toContain("events");
    await r.shutdown();
  });

  it("备份目录是多层不存在的路径 ⇒ createBackup 自己 mkdir，备成功", async () => {
    const path = db();
    const dir = join(tmp(), "deep", "nested", "bk");
    const s = createFakeScheduler(Date.parse("2026-03-10T08:00:00Z"));
    const { io, log, warn } = ioOf();
    const r = needOk(
      await boot(args({ dbPath: path, port: 8787, backupDir: dir, heartbeatMs: 60_000 }), io, {
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
      }),
    );
    expect(await happens(() => existsSync(dir))).toBe(true);
    expect(await happens(() => log.join(" ").includes("备份完成"))).toBe(true);
    expect(warn.join(" ")).not.toContain("备份失败");
    await r.shutdown();
  });

  it("⭐ 关机之后【不再开始】新备份，且任何已落盘的一份都是完整的", async () => {
    // 这一发改过判据，因为它原来钉的东西已经不存在了。
    // 第一版的备份是 async IIFE，里面还带一句 `await import(...)` ⇒
    // 「关机时有一份备份正在进行」是个真实状态，于是 shutdown 里要 `await backupInFlight`。
    // 现在备份在心跳那一轮里【同步】跑完（见 assemble.ts job 上面那整段），
    // 那个状态在本进程里构造不出来，`await` 一个不存在的东西只会给人错觉。
    // 留下来的、也是真正要钉的性质有两条：
    //   ① 关机之后不再【开始】一份新备份（否则 giveUp 已经关了队列、还了锁，
    //      而备份照做 ⇒ 「我已经停了」不再为真，且那是一份【没有锁保护】的备份）
    //   ② 落盘的每一份都必须非 0 字节（VACUUM INTO 中途被打断留下的文件是诱饵）
    const path = db();
    const dir = join(tmp(), "bk3");
    const s = createFakeScheduler(Date.parse("2026-03-10T08:00:00Z"));
    const { io, log } = ioOf();
    const r = needOk(
      await boot(args({ dbPath: path, port: 8787, backupDir: dir, heartbeatMs: 60_000 }), io, {
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
      }),
    );
    // 先等首轮真的备完（这一发要测的是【之后】的关机）。
    expect(await happens(() => names(dir).length === 1)).toBe(true);
    await r.shutdown();
    const after = names(dir);
    expect(after).toHaveLength(1);
    expect(statSync(join(dir, after[0] as string)).size).toBeGreaterThan(0);
    expect(log.join(" ")).toContain("备份完成");
    // ① 关机之后推过三个心跳周期：一发的新备份都不该出现（ticker 也停了，两重保险）。
    s.advance(3 * 60_000);
    await happens(() => false, 100);
    expect(names(dir)).toEqual(after);
    expect(s.pending()).toBe(0);
  });

  /**
   * ⭐⭐ 结构性守卫：备份那一段【不许有任何 await】。
   *
   * 这一发是补一个真实存在过的漏洞：0025 §3 第 ④ 条说「修法是把这一段改成整体同步」，
   * 而我做完之后【没有任何东西守着这件事】—— 我拿变异实验验过：
   * 在 `shouldBackUp(...)` 与 `createBackup(...)` 之间插一句 `await Promise.resolve()`，
   * 本文件**35 条全绿**。也就是说「同步」当时只是**源码里的一段注释 + 我的一句话**，
   * 而这两样都会在重构里活下来，代码不会。
   *
   * 为什么必须用【文本守卫】而不是行为用例来守：那一族缺陷的失效方式正是
   * 「要恰好在判定与执行之间关机才看得见」，而关机时刻在本进程的测试里造不出来
   * （要真信号 + 真并发）。同 patrol.ts 那条「不得含 setInterval」是同一个选择：
   * **判不了的性质就退到源码形状上钉住，并写清它证不了什么**。
   *
   * ⚠ 这一发【证不了】同步性本身（那是 node:sqlite 与 VACUUM INTO 的语义）；
   *   它证的是「这段区间里没有 await」，也就是那道保护【还在】。
   * ⚠ 它同时【会误伤】：如果哪天把备份挪进 worker（0025 §7 第 2 条），
   *   这一发会红，而那时**正确**的改法是连「等一份在飞的备份」+ cancelling 状态
   *   一起补回来 —— 不是把这一发删掉。红的时候请去读 0025 §3 与 §7 再动手。
   */
  it("⭐⭐ 备份那一段【零 await】（源码形状守卫；变异实验验过它确实会红）", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "serve", "assemble.ts"),
      "utf8",
    );
    // 区间的两端用的是【代码里的原文】而不是行号：行号会在无关改动后指向别处，
    // 而那会让这一发静默地扫一段错的东西（扫不到 await ⇒ 绿）。
    // 所以先断言两端都**找得到**，再断言区间内容。
    const START = "if (backupDir === undefined) return;";
    const END = "reportBackup(b, io);";
    const a = src.indexOf(START);
    const b = src.indexOf(END);
    expect(a, "区间起点找不到：备份那一段被改写过了，这一发要跟着改").toBeGreaterThan(-1);
    expect(b, "区间终点找不到：同上").toBeGreaterThan(a);
    const region = src
      .slice(a, b + END.length)
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
      })
      .join("\n");
    // await / async / .then / await import 四种写法一起挡：
    // 只挡 `await` 关键字的话，`void something.then(...)` 或 `queue node` 的
    // 异步包装照样能开出一条缝，而症状与第 ④ 条一模一样。
    for (const bad of [/\bawait\b/, /\basync\b/, /\.then\s*\(/, /\bimport\s*\(/]) {
      const hit = region.match(bad);
      expect(
        hit === null,
        "备份区间里出现了 " + String(bad) + "（命中 " + String(hit?.[0]) + "）：" +
          "0025 §3 第 ④ 条那一族 —— 判定与执行之间跨一个 await，" +
          "『关机时不等备份』就变成有时生效的保护",
      ).toBe(true);
    }
    // 反向对照：同一条扫描必须能【捞到】别处的 await，否则「区间里没有」
    // 可能只是「我把整段切错了 / 过滤条件把代码也滤掉了」。
    // runPatrol 那一发就在区间上方几行，是最近的真 await，切错一寸就捞不到。
    expect(/\bawait\b/.test(src.slice(src.indexOf("const r = await runPatrol"), a))).toBe(true);
    expect(region).toContain("createBackup({");
  });

  /**
   * ⭐⭐ 巡检那一轮【在关机进行中间跑完】时，也不许开始备份。
   *
   * 上面那条「关机之后不再开始新备份」挡的是【新一轮】（ticker 已 stop，本来就轮不到）。
   * 这一发挡的是另一条路：giveUp 走到 `await server.close()` 上挂着，
   * 而一【已经挂在半路】的巡检轮次在这期间恢复并一路走到备份那一段。
   * 那时挡住它的只有 job 里那句 `if (cleaned) return`。
   *
   * ⚠ 这一发【为什么必须存在】：我做变异实验把那句守卫拆掉之后，全文件【36 条全绿】。
   *   同步改造废掉了「等在飞的备份」那一发，于是这句守卫成了【唯一】还活着的
   *   「关机与备份互斥」的保护 —— 而它当时一条用例都没有。
   *
   * ⚠ 我第一版【写错过一次判据】，值得留着：那一发用 fakeServer（close 立刻 resolve），
   *   于是「恢复发生在什么时候」完全由微任务排队决定。它杀得掉「拆掉守卫」，
   *   却【杀不掉】「把 `cleaned = true` 挪到 giveUp 末尾」—— 后者是同一个缺陷的另一种写法，
   *   而在真机上「server.close() 慢」恰恰是常态。换成 pausableServer 并显式
   *   断言 close 确实挂住之后，两种变异都红。
   *   教训：**并发用例里凡是靠「顺序刚好如此」绿的地方，都要问一句这个顺序是谁保证的。**
   *
   * ⚠ 判据里「停滞审计确实落库了」那一发是【防空转】的命门：
   *   如果这一轮根本没走到巡检（例如队列先关、appendAudit 抛掉），
   *   那「没有新备份」会以一个【完全不相干的原因】成立。审计落了 = 这一轮确实走到了备份之前。
   */
  it("⭐⭐ 巡检跑一半时关机 ⇒ 那一轮【跑完之后】仍然不备（变异实验验过它确实会红）", async () => {
    const path = db();
    plantStalledTask(path, "T-FIRST");
    const dir = join(tmp(), "bk5");
    const s = createFakeScheduler(Date.parse("2026-03-10T08:00:00Z"));
    const g = gatedQueue(path);
    const srv = pausableServer();
    const { io } = ioOf();
    const r = needOk(
      await boot(args({ dbPath: path, port: 8787, backupDir: dir, heartbeatMs: 60_000 }), io, {
        serve: srv.serve,
        scheduler: s,
        openQueue: () => g.q,
        now: () => s.now(),
      }),
    );
    // 让【启动那一轮】先跑干净（它既报停滞、也备第一份）。
    // 闸门在那之后才武装，否则 boot 自己的完整性检查会被挂住（见 gatedQueue ①）。
    expect(await happens(() => names(dir).length === 1)).toBe(true);
    const stallsBefore = countEvents(path, "HeartbeatStalled");
    expect(stallsBefore).toBe(1);
    /*
     * 第二轮必须有一个【新】的停滞任务，不能只推进时钟：
     * patrol 的去重判据是「最后一次 HeartbeatStalled 不早于停滞起点」，
     * 同一个任务第二轮【一行都不写】⇒ writer.node() 一次都不调 ⇒ 闸门空等，
     * 这一发会以「闸门没等到东西」红，而那与要测的性质无关。
     */
    plantStalledTask(path, "T-SECOND");
    g.arm();
    // 推进一整天：一轮到点（那一轮的 writer.node 被挂住），而时钟跨了 UTC 日历日
    // ⇒ shouldBackUp 变成真。这一条【不是】随手选的：不跨日的话，即便把
    // `if (cleaned) return` 拆掉，备份判据自己就是假的，这一发会【白绿】。
    // （拆掉守卫的那次变异实验第一次就是这么绿的，重做才暴露出这一点。）
    s.advance(24 * 60 * 60_000);
    expect(await happens(() => g.waiting() === 1)).toBe(true);
    // 关机必须【确实挂住】在 server.close() 上：不挂住的话下面那次放行
    // 不在「关机进行中」这个窗口里，这一发就退化成了按顺序排好的两件事而不是【并发】。
    // 这也是【不用 fakeServer 的理由】—— fakeServer 的 close 立刻 resolve，
    // 恢复时机就交给微任务排队，变异「cleaned 挪到 giveUp 末尾」都能绿。
    const down = r.shutdown();
    expect(await happens(() => srv.closeRequested())).toBe(true);
    // 在 giveUp 还挂着的时候放行那一轮，并排空微任务。
    // 备份那一段是【整体同步】的 ⇒ 只要它决定要备，这一次 drain 之后就看得见文件。
    g.release();
    await drainMicrotasks();
    expect(names(dir)).toHaveLength(1);
    srv.finishClose();
    await down;
    // 命门（防空转）：这一轮必须【真的越过了巡检】。
    // 若 giveUp 先把队列关掉，patrol 的 appendAudit 会抛 ⇒ job 走不到备份那一段 ⇒
    // 「没有新备份」会以一个完全不相干的原因成立。审计落了 = 这一轮确实走到了备份之前。
    expect(countEvents(path, "HeartbeatStalled")).toBeGreaterThan(stallsBefore);
    expect(names(dir)).toHaveLength(1);
    expect(existsSync(lockPathFor(path))).toBe(false);
  });

  it("首轮还没跑完就关机 ⇒ 【没有】半份备份，也没有崩", async () => {
    // 这是上面那条的另一半：备份开始【之前】关机。
    // 判据落在「目录里要么什么都没有、要么是一份完整的」——
    // 而不是「一定有 / 一定没有」，因为那取决于 runPatrol 的 await 落在哪，
    // 把实现细节钉成断言就是一条 flaky。
    const path = db();
    const dir = join(tmp(), "bk4");
    const s = createFakeScheduler(Date.parse("2026-03-10T08:00:00Z"));
    const { io } = ioOf();
    const r = needOk(
      await boot(args({ dbPath: path, port: 8787, backupDir: dir, heartbeatMs: 60_000 }), io, {
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
      }),
    );
    await r.shutdown();
    const got = names(dir);
    expect(got.length).toBeLessThanOrEqual(1);
    for (const n of got) {
      expect(statSync(join(dir, n)).size).toBeGreaterThan(0);
    }
    expect(existsSync(lockPathFor(path))).toBe(false);
  });

  it("lastBackupAtMs 读的是【文件名】而不是 mtime（目录被 cp/rsync 过也不能误判）", async () => {
    const dir = tmp();
    const stamp = Date.UTC(2026, 2, 10, 1, 2, 3, 4);
    const name = backupName(stamp);
    writeFileSync(join(dir, name), "假的一份备份");
    utimesSync(join(dir, name), new Date(0), new Date(0)); // mtime 改到 1970
    expect(lastBackupAtMs(dir)).toBe(stamp);
    // 反向：不认识的文件名 ⇒ null（= 该备），而不是一个猜测。
    const d2 = tmp();
    writeFileSync(join(d2, "not-a-backup.db"), "x");
    expect(lastBackupAtMs(d2)).toBeNull();
    // 目录根本不存在 ⇒ null 而不是抛（第一次运行就是这个状态）。
    expect(lastBackupAtMs(join(tmp(), "never-created"))).toBeNull();
  });
});

describe("清理：每一条出口都还锁、都关队列、都关服务", () => {
  it("成功路径的 shutdown：还锁 + 关服务 + 关队列 + 清端口文件", async () => {
    const path = db();
    const portFile = join(tmp(), "hub.port");
    const { io } = ioOf();
    const srv = fakeServer(5599);
    const q = countingQueue(path);
    const r = needOk(
      await boot(args({ dbPath: path, portFile, noBackup: true }), io, {
        serve: srv.serve,
        openQueue: () => q.q,
        scheduler: createFakeScheduler(0),
      }),
    );
    expect(r.port).toBe(5599);
    expect(readFileSync(portFile, "utf8").trim()).toBe("5599");
    expect(existsSync(lockPathFor(path))).toBe(true);
    await r.shutdown();
    expect(existsSync(lockPathFor(path))).toBe(false);
    expect(srv.closed()).toBe(1);
    expect(q.closed()).toBe(true);
    // 端口文件被【清空】而不是删除：留着旧端口会让下一次「连上一个已经不存在的 Hub」，
    // 症状是界面一直转圈而不是「Hub 没起」。
    expect(existsSync(portFile)).toBe(true);
    expect(readFileSync(portFile, "utf8")).toBe("");
  });

  it("shutdown 幂等：第二次不重复关（真 WriteQueue 的第二次 close 是抛的）", async () => {
    const path = db();
    const { io } = ioOf();
    const q = countingQueue(path);
    const srv = fakeServer();
    const r = needOk(
      await boot(args({ dbPath: path, port: 8787, noBackup: true }), io, {
        serve: srv.serve,
        openQueue: () => q.q,
        scheduler: createFakeScheduler(0),
      }),
    );
    await r.shutdown();
    await expect(r.shutdown()).resolves.toBeUndefined();
    expect(srv.closed()).toBe(1);
  });

  it("serve 抛（端口被占）⇒ 还锁 + 关队列 + 给出可执行动作", async () => {
    const path = db();
    const { io } = ioOf();
    const q = countingQueue(path);
    const r = needErr(
      await boot(args({ dbPath: path, port: 8787, noBackup: true }), io, {
        openQueue: () => q.q,
        serve: (): Promise<HubServer> => {
          const e = new Error("listen EADDRINUSE: address already in use :::8787");
          (e as { code?: string }).code = "EADDRINUSE";
          throw e;
        },
      }),
    );
    expect(r.code).toBe(EXIT_PROBLEM);
    expect(r.message).toContain("8787");
    expect(r.message).toContain("--port-file");
    expect(existsSync(lockPathFor(path))).toBe(false);
    expect(q.closed()).toBe(true);
  });

  it("没给 --port 时传给 serve 的是 0（系统分配）——这条通路就是 --port-file", async () => {
    const path = db();
    const portFile = join(tmp(), "p.port");
    const { io } = ioOf();
    const srv = fakeServer(41111);
    const r = needOk(
      await boot(args({ dbPath: path, portFile, noBackup: true }), io, {
        serve: srv.serve,
        scheduler: createFakeScheduler(0),
      }),
    );
    expect(srv.portUsed()).toBe(0);
    expect(readFileSync(portFile, "utf8").trim()).toBe("41111");
    expect(r.portFile).toBe(portFile);
    await r.shutdown();
  });

  it("装配中途抛（兜底 catch）⇒ 仍然还锁，否则那颗锁会锁死这个库", async () => {
    const path = db();
    const { io } = ioOf();
    const brk = breakableQueue(path);
    brk.break(); // 迁移用 writeConnection（照常工作），完整性检查用 readConnection（抛）
    const r = needErr(
      await boot(args({ dbPath: path, port: 8787, noBackup: true }), io, {
        openQueue: () => brk.q,
      }),
    );
    // 这条出口上面【没有】就地 catch ⇒ 走的正是最后那个兜底 catch。
    // 上面若被就地处理成「完整性检查未通过」，那条消息里会有「拒绝启动」——
    // 两种失败都要还锁，但本发要钉的是兜底那一发，所以要能分辨。
    expect(r.message).not.toContain("拒绝启动");
    expect(r.message).toContain("读连接坏了");
    expect(existsSync(lockPathFor(path))).toBe(false);
  });
});

describe("心跳：首轮立刻跑；坏到底要出声并交出退出权", () => {
  it("⭐ 启动即一轮：不等第一个 tick（进程刚起来最容易留停滞）", async () => {
    const path = db();
    const s = createFakeScheduler(Date.parse("2026-03-10T08:00:00Z"));
    const { io } = ioOf();
    const r = needOk(
      await boot(args({ dbPath: path, port: 8787, heartbeatMs: 60_000, noBackup: true }), io, {
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
      }),
    );
    // 判据不是「有没有写停滞事件」（库里没有停滞任务，那是 patrol.test.ts 的事），
    // 而是【跑完过一轮】：假时钟一次没推进，而下一轮已被排上 ⇒ 只有真跑完一轮才会这样。
    expect(s.pending()).toBe(1); // createTicker 建好时那发
    expect(await happens(() => !r.heartbeat.running)).toBe(true);
    s.advance(59_999);
    expect(s.pending()).toBe(1);
    await r.shutdown();
    expect(s.pending()).toBe(0); // stop 把已排队那一发也撤了
  });

  it("⭐ 连续失败到阈值 ⇒ onHeartbeatFatal 被叫到，且 HTTP【仍在服务】", async () => {
    const path = db();
    const s = createFakeScheduler(Date.parse("2026-03-10T08:00:00Z"));
    const brk = breakableQueue(path);
    const srv = fakeServer();
    let fatal = 0;
    const { io, warn } = ioOf();
    const r = needOk(
      await boot(args({ dbPath: path, port: 8787, heartbeatMs: 60_000, noBackup: true }), io, {
        openQueue: () => brk.q,
        serve: srv.serve,
        scheduler: s,
        now: () => s.now(),
        onHeartbeatFatal: () => {
          fatal++;
        },
      }),
    );
    // 首轮【成功】之后才把库扳坏 —— 让第一轮去证「默认是好的」，
    // 否则这一发从头红到尾，分不清是夹具坏了还是行为坏了。
    expect(await happens(() => !r.heartbeat.running)).toBe(true);
    expect(fatal).toBe(0);
    brk.break();
    // 阈值是 3（DEFAULT_MAX_CONSECUTIVE_FAILURES），首轮成功 ⇒ 还要【三轮】才停。
    // 这里曾经只推一轮就断言 fatal === 1，那是把「一次抖动就杀循环」当成了期望行为 ——
    // 而「一次抛错不杀心跳」正是 timer.ts 存在的理由之一。少推两轮的话这一发是红的，
    // 但它红得有意义：它会把「阈值到底是几」这件事逼到台面上。
    for (let i = 1; i <= 2; i++) {
      s.advance(60_000);
      expect(await happens(() => r.heartbeat.consecutiveFailures === i)).toBe(true);
      expect(fatal).toBe(0); // 还没到阈值
    }
    s.advance(60_000);
    expect(await happens(() => fatal === 1)).toBe(true);
    expect(warn.join(" ")).toContain("不再安排下一轮");
    expect(warn.join(" ")).toContain("停滞检测现在【不再运行】");
    expect(r.heartbeat.stopped).toBe(true);
    // 关键的反向：心跳死了【不该】顺手把服务也悄悄停了。
    // 退不退进程由入口决定（runServeCli 的 onHeartbeatFatal），装配层不自己退 ——
    // 判据用 srv.closed()：为 0 才说明「HTTP 还在服务」这句话是真的，
    // 而不是只看 r.ok（needOk 之后它恒为 true，是一句恒真断言）。
    expect(srv.closed()).toBe(0);
    // 停了之后到点不再叫 ⇒ fatal 停在 1，不是一路刷到 10。
    s.advance(10 * 60_000);
    await happens(() => false, 100);
    expect(fatal).toBe(1);
    await r.shutdown();
    expect(srv.closed()).toBe(1); // shutdown 仍然把服务关干净了
  });

  it("心跳间隔取值优先级：overrides > args（Electron 那条路不给 argv）", async () => {
    const path = db();
    const s = createFakeScheduler(Date.parse("2026-03-10T08:00:00Z"));
    const { io } = ioOf();
    const r = needOk(
      await boot(args({ dbPath: path, port: 8787, heartbeatMs: 90_000, noBackup: true }), io, {
        serve: fakeServer().serve,
        scheduler: s,
        heartbeatMs: 60_000, // 覆盖 args 里的 90_000
      }),
    );
    expect(await happens(() => !r.heartbeat.running)).toBe(true);
    s.advance(60_000); // 按 overrides 的 60_000 该叫一轮；按 args 的 90_000 不该
    expect(await happens(() => r.heartbeat.consecutiveFailures === 0 && !r.heartbeat.running)).toBe(true);
    // 判据：推进到 60_000 之后，那一轮到点了（下一轮被重新排上 ⇒ pending 回到 1）。
    expect(s.pending()).toBe(1);
    s.advance(29_999); // 90_000 还没到，也不该有第二发
    expect(s.pending()).toBe(1);
    await r.shutdown();
  });
});

describe("图运行时没接这件事必须响亮（本入口唯一被【声明】为不可用的能力）", () => {
  it("⭐ 默认装配下启动就警告一次，并教你跑 hub resume", async () => {
    const path = db();
    const { io, warn } = ioOf();
    const r = needOk(
      await boot(args({ dbPath: path, port: 8787, noBackup: true }), io, {
        serve: fakeServer().serve,
        scheduler: createFakeScheduler(0),
      }),
    );
    expect(warn.join(" ")).toContain("未接图运行时");
    // 命令必须带 --db，而且带的是【这个 Hub 自己那个库】。理由见 resumeCommand 那段：
    // 不带 --db 的写法只在设了 OPC_DB 的机器上成立，而这句话存在的全部理由是人会照抄。
    expect(warn.join(" ")).toContain("hub resume --db " + path + " --task <id>");
    // 反向对照：显式注入图工厂时这一句【不该】出现 ——
    // 否则 Electron 主进程接上图之后还会被告知「没接」，那是一句假告警。
    // ⚠ 用的是【另一份库】：同一份库上第二个 Hub 会被写者锁拒掉，
    // 而我第一版正是复用同一个 path、被锁挡下才看见的。那一发不是这条用例要测的东西
    // （锁的行为在 lock.test.ts 与上面那组），把两件事混在一发里，
    // 红的时候分不清是「假告警没消」还是「锁生效了」。
    const { io: io2, warn: warn2 } = ioOf();
    const r2 = needOk(
      await boot(args({ dbPath: db(), port: 8787, noBackup: true }), io2, {
        serve: fakeServer().serve,
        scheduler: createFakeScheduler(0),
        graphFor: unavailableGraphFor(), // 同一个工厂；判据是【走没走默认】
      }),
    );
    expect(warn2.join(" ")).not.toContain("未接图运行时");
    await r.shutdown();
    await r2.shutdown();
  });

  it("⭐ 默认图工厂：装配时【不抛】，用到时【必抛】", async () => {
    const graphFor = unavailableGraphFor();
    const g = graphFor("task-42"); // 装配时抛的话，看板也打不开，而真相只是「恢复要人喊一声」
    expect(typeof g.invoke).toBe("function");
    await expect(g.invoke({} as never)).rejects.toThrow(/hub resume --db <库路径> --task task-42/u);
  });

  it("⭐ 工厂拿到库路径时，报错里印的是【能直接跑】的那条命令", async () => {
    // 上一发钉的是「没有库路径时印占位」，这一发钉「有库路径时印真路径」。
    // 两发都要：只留前一条，有人把 dbPath 一路传丢也全绿（占位符永远出现）；
    // 只留后一条，则传丢时那句报错变成一句看不懂的 `--db <库路径>` 而没人知道坏了。
    const g = unavailableGraphFor("/var/db/opc/hub.db")("task-7");
    await expect(g.invoke({} as never)).rejects.toThrow(
      /hub resume --db \/var\/db\/opc\/hub\.db --task task-7/u,
    );
    // 空串按【没给】处理：印 `--db ` 后面跟一个空格，是一条【看着完整、必然挂】的命令，
    // 比印占位符更坏 —— 所以这一格不是格式偏好。
    await expect(unavailableGraphFor("")("t1").invoke({} as never)).rejects.toThrow(
      /--db <库路径> --task t1/u,
    );
  });

  it("getState 也必须抛：返回一个「看起来是空状态」的对象会造成【假的成功】", async () => {
    // makeResumeGraph 用 getState 判「有没有 pending interrupt」。假空状态会让它选
    // invoke(null)，而那在已完成 thread 上【不重放节点】(0006 §1)
    // ⇒ HTTP 200、日志一个字没有、卡片停在批准 —— 最难诊断的那类失效。
    await expect(unavailableGraphFor()("t9").graph.getState("t9" as never)).rejects.toThrow(
      /task_id = t9/u,
    );
    await expect(unavailableGraphFor()("t9").graph.invoke()).rejects.toThrow(GRAPH_NOT_WIRED);
  });

  it("报错文案三件事都要有：为什么没接、归属哪条决策、现在能做什么", () => {
    const m = graphNotWiredMessage("abc");
    expect(m).toContain(GRAPH_NOT_WIRED);
    expect(m).toContain("0010");
    expect(m).toContain("hub resume --db <库路径> --task abc");
    // 「决策已落库」这一句防止人以为批准丢了而重重点批准 ——
    // 第二次批准是无效转移（审批终态唯一性会拒），症状变成「按钮坏了」。
    expect(m).toContain("决策已经落库");
  });
});

/**
 * 一个【记下第二、三参】的假 server。
 *
 * 为什么单独一个而不给 fakeServer 加两个 getter：既有的二十来处假 server
 * 故意【看不到】bind（TS 允许两形参函数赋给三形参类型），
 * 而「看不到 bind 的假 server」不该被用来断言绑定 —— 那样会得到
 * 「断言读到了一个实现根本没传的值」这种恒绿的形状。
 * 要断言绑定，就得用一个【明说自己收三个参】的替身。
 */
function bindRecordingServer(port = 8787): {
  serve: (d: HubDeps, p: number, b: BindDecision) => Promise<HubServer>;
  seen(): { port: number; host: string; exposure: string } | null;
} {
  let seen: { port: number; host: string; exposure: string } | null = null;
  return {
    serve: (_d: HubDeps, p: number, b: BindDecision): Promise<HubServer> => {
      seen = { port: p, host: b.host, exposure: b.exposure };
      return Promise.resolve({ port, close: () => Promise.resolve() });
    },
    seen: () => seen,
  };
}

describe("监听地址（Task 4.1）：绑定策略跟随【实际装配结果】", () => {
  it("⭐ 没接远程审批通道 + 要求 0.0.0.0 ⇒ 判成【致命拒】，且报错写着怎么才许开", () => {
    // 这一发是 bindForAssembly 的【存在理由】。同一条判据内联在 boot 里时，
    // 它的输入被 buildHubDeps 焊成了恒真 ⇒ 这一格在 boot 层面【没有活的分母】，
    // 「通道没接不许绑非回环」这条安全主张一次也没被测过。
    // 现在它有了分母：一份没接通道的 deps。
    const r = bindForAssembly({ requested: "0.0.0.0", deps: {} });
    expect(r.remoteApprovalsWired).toBe(false);
    expect(r.outcome.ok).toBe(false);
    if (r.outcome.ok === true) throw new Error("前置失败");
    expect(bindFailureIsFatal(r.outcome)).toBe(true);
    // 报错里必须写着【怎么才许开】。「拒绝而不给出口」是这一族报错最常见的形态，
    // 而它的后果是那人去翻防火墙或者干脆把判据注释掉。
    expect(r.outcome.message).toContain("一次性 token");
    expect(r.outcome.message).toContain("--bind " + LOOPBACK_HOST);
    // ⚠ 标题原来写的是「退 2 而不是退 1」，而这一发【没有】断退出码 ——
    // 写那个标题时我以为 boot 那支可达，其实不可达（原因见上）。
    // 「致命 ⇒ EXIT_USAGE」那一格在本机【仍然没有分母】：boot 只能拿到
    // buildHubDeps 装配好的 deps，而那两份注入点总是齐的。
    // 我没有为了能测它而加一个「注入一份残缺 deps」的 override ——
    // 那等于在装配上开一条【专门给测试用的旁路】，而装配层唯一该有的出口是 serve
    // （理由就在上面 serve 那个 override 的注释里）。要接那一格，正确的时机是
    // buildHubDeps 真的把两个注入点改成条件装配的那一天。
  });

  it("⭐ 只接了一半（有 redeem 没 mint）⇒ 仍算【没接通】，这是偏严那一侧", () => {
    // 远程鉴权真正依赖的只有 redeem，所以「只判 redeem」是【更松】的另一种写法，
    // 而且它读起来更精确 —— 精确到足以让下一个人顺手改对。
    // 这里选偏严（两个都在才算接通），理由与取向写在 bindForAssembly 文件头。
    // 这一发的作用是：那次「顺手改精确」必须红，而不是安静地放宽一条安全边界。
    const onlyRedeem = { redeemApprovalToken: async () => ({ ok: false, reason: "expired" as const }) };
    expect(bindForAssembly({ requested: "0.0.0.0", deps: onlyRedeem }).remoteApprovalsWired).toBe(
      false,
    );
    const onlyMint = { issueApprovalToken: async () => ({ ok: false, reason: "approval_missing" as const }) };
    expect(bindForAssembly({ requested: "0.0.0.0", deps: onlyMint }).remoteApprovalsWired).toBe(
      false,
    );
    // 反向对照：两个都在才算通 —— 证明上面那两个 false 不是「恒 false」。
    expect(
      bindForAssembly({ requested: "0.0.0.0", deps: { ...onlyRedeem, ...onlyMint } })
        .remoteApprovalsWired,
    ).toBe(true);
  });

  it("回环【永远】放行，与通道在不在无关（Phase 4 的能力不该是 Phase 2 的启动依赖）", () => {
    for (const deps of [{}, { redeemApprovalToken: async () => ({ ok: true, taskId: "t" }) }]) {
      const r = bindForAssembly({ requested: LOOPBACK_HOST, deps: deps as never });
      expect(r.outcome.ok).toBe(true);
      if (r.outcome.ok !== true) throw new Error("前置失败");
      expect(r.outcome.decision.exposure).toBe("loopback");
    }
    // 没填 requested 也一样。这一发挡的是「有人把默认那一支也去查 remoteApprovalsWired」——
    // 那一改动让桌面端在通道没接时【起不来】，而它看起来只是多加了一条一致的检查。
    expect(bindForAssembly({ requested: undefined, deps: {} }).outcome.ok).toBe(true);
  });

  it("boot 把 decision 真的交到了 serve 手上，而 BootResult 报的是【那个】地址", async () => {
    const path = db();
    const { io } = ioOf();
    const srv = bindRecordingServer();
    const r = needOk(
      await boot(
        args({ dbPath: path, port: 8787, heartbeatMs: 60_000, noBackup: true }),
        io,
        { serve: srv.serve, scheduler: createFakeScheduler(0) },
      ),
    );
    // 这三行必须【互相对得上】：假 server 收到的、BootResult 报的、实际默认值。
    // 只断言 BootResult 的话，「装配算出一个地址、传给 serve 另一个、往上报第三个」
    // 这种三处不一致能全绿 —— 而 CLI 那行「Hub 已在 X:port」读的正是 BootResult。
    expect(srv.seen()).toEqual({ port: 8787, host: LOOPBACK_HOST, exposure: "loopback" });
    expect(r.bindHost).toBe(LOOPBACK_HOST);
    expect(r.exposure).toBe("loopback");
    await r.shutdown();
  });

  it("打错成主机名 ⇒ 【照常起来】但响一声，而绑的还是回环", async () => {
    const path = db();
    const { io, warn } = ioOf();
    const srv = bindRecordingServer();
    const r = needOk(
      await boot(
        args({ dbPath: path, port: 8787, bind: "localhost", heartbeatMs: 60_000, noBackup: true }),
        io,
        { serve: srv.serve, scheduler: createFakeScheduler(0) },
      ),
    );
    expect(srv.seen()?.host).toBe(LOOPBACK_HOST);
    expect(r.bindHost).toBe(LOOPBACK_HOST);
    // 「响一声」的判据是【内容】不是条数：装配自己会打「未接图运行时」那一句，
    // 断 warn.length 会绿在错的那一句上。
    expect(warn.some((w) => w.includes("忽略 --bind") && w.includes("not_an_ip_literal"))).toBe(
      true,
    );
    await r.shutdown();
  });

  it("绑 ::1 ⇒ 起得来，并提示「这只覆盖 IPv6 回环」", async () => {
    const path = db();
    const { io, warn } = ioOf();
    const srv = bindRecordingServer();
    const r = needOk(
      await boot(
        args({ dbPath: path, port: 8787, bind: "::1", heartbeatMs: 60_000, noBackup: true }),
        io,
        { serve: srv.serve, scheduler: createFakeScheduler(0) },
      ),
    );
    expect(srv.seen()?.host).toBe("::1");
    expect(warn.some((w) => w.includes("127.0.0.1"))).toBe(true);
    await r.shutdown();
  });

  it("⭐ 正常回环启动【不多打一行】：告警不能靠刷屏维持效力", async () => {
    // 这一发测的是【没有】输出，而「没有」只能靠精确的分母来测：
    // 上面那两条各自断言了 warn 里【有】某一句，这一条断言默认路径里
    // 【没有】任何一句提到 bind/监听/暴露。绑定的告警每次都打，
    // 会被读的人训练成噪音 —— 而这条告警防的正是「没人再看它的那一天」。
    const path = db();
    const { io, warn } = ioOf();
    const r = needOk(
      await boot(args({ dbPath: path, port: 8787, heartbeatMs: 60_000, noBackup: true }), io, {
        serve: bindRecordingServer().serve,
        scheduler: createFakeScheduler(0),
      }),
    );
    expect(warn.some((w) => /--bind|监听|暴露|exposure/iu.test(w))).toBe(false);
    await r.shutdown();
  });

  it("⭐ 横幅那一行说的是【真监听的那个地址】，「只绑回环」只在真回环时出现", () => {
    // Task 4.1 之前这一行是写死的 "Hub 已在 127.0.0.1:" + port。加 --bind 之后它
    // 【照常打印】而服务其实对所有网卡开放 —— 一句仍然会打印的假话，
    // 且落在运维唯一一定会读的那一行上。
    // 抽成 serveBannerOf 的理由写在它自己的注释里：内联那一版要先打印、再挂进
    // waitForShutdown 等一个真信号才返回，而给自己发 SIGINT 会被同进程其他用例
    // 留下的信号监听一起收到（它注册了不注销），所以那一行【在本机一次也没被执行过】。
    // 「只绑回环」这四个字今天没有任何测试见过。
    const loopback = serveBannerOf({ bindHost: LOOPBACK_HOST, port: 8787, exposure: "loopback" });
    expect(loopback).toContain("127.0.0.1:8787");
    expect(loopback).toContain("只绑回环");

    const lan = serveBannerOf({ bindHost: "10.1.2.3", port: 9000, exposure: "lan" });
    expect(lan).toContain("10.1.2.3:9000");
    // ⚠ 承重的是【这一句不含「只绑回环】，而不是「含 exposure=lan」。
    // 只断后者的话，实现写成「只绑回环（⚠ exposure=lan）」照样全绿 ——
    // 而那正是那次缺陷的原样：一句仍然会打印的假话旁边挂一句真话。
    expect(lan).not.toContain("只绑回环");
    // 反向对照（地址维）：写死 127.0.0.1 的实现会让上面那句 lan 断言红。
    // 这里再钉一次【端口也是取的入参】：只写对 host 而把 port 写死，
    // 是这类「修了一半」最常见的形状。
    expect(serveBannerOf({ bindHost: "127.0.0.1", port: 1234, exposure: "loopback" })).toContain(
      ":1234",
    );
  });
});

describe("入口契约与「真起一个 Hub」", () => {
  it("--help ⇒ EXIT_OK，用法进 log 而不是 warn", async () => {
    const { io, log, warn } = ioOf();
    expect((await runServeCli(["--help"], io)).code).toBe(EXIT_OK);
    expect(log.join(" ")).toContain("--port-file");
    expect(warn).toEqual([]);
  });

  it("参数错 ⇒ EXIT_USAGE，且【同时】给出错误原文与用法（对着报错能自己修）", async () => {
    const { io, warn } = ioOf();
    expect((await runServeCli(["--db", "/tmp/nope-x.db", "--port", "70000"], io)).code).toBe(EXIT_USAGE);
    expect(warn.length).toBeGreaterThanOrEqual(2);
    expect(warn[0]).toContain("65535");
  });

  it("库不存在 ⇒ 非 0 退出码，hint 单独一行带箭头", async () => {
    const { io, warn } = ioOf();
    expect((await runServeCli(["--db", join(tmp(), "absent.db"), "--port", "8787"], io)).code).toBe(
      EXIT_USAGE,
    );
    expect(warn.some((w) => w.startsWith("→ "))).toBe(true);
  });

  it("⭐ 真的 serveHub、真的回环端口、真的 token：一次完整的起停", async () => {
    const path = db();
    const dir = tmp();
    const portFile = join(dir, "hub.port");
    const { io, log, warn } = ioOf();
    const r = needOk(
      await boot(args({ dbPath: path, portFile, heartbeatMs: 60_000, noBackup: true }), io, {
        acquire: (p): LockAcquire => acquireLock(p, { who: "hub-serve-test" }),
        scheduler: createFakeScheduler(Date.parse("2026-03-10T08:00:00Z")),
        token: "tok-fixed-for-assert",
      }),
    );
    expect(r.port).toBeGreaterThan(0);
    expect(readFileSync(portFile, "utf8").trim()).toBe(String(r.port));
    expect(existsSync(lockPathFor(path))).toBe(true);
    // token 一次都没进过磁盘（本组唯一一条「真起真停」的出口，也是唯一可能写文件的地方）。
    expect(names(dir).some((n) => /token|secret|cred/iu.test(n))).toBe(false);
    expect(warn.join(" ")).not.toContain("备份");

    // 真打一次 HTTP：不带 token 必须 401（证 boot 交出去的那份 deps 真的带着 token）。
    const res = await fetch("http://127.0.0.1:" + r.port + "/tasks");
    expect(res.status).toBe(401);

    await r.shutdown();
    expect(existsSync(lockPathFor(path))).toBe(false);
    expect(names(dir).filter((n) => n.endsWith(".lock"))).toEqual([]);
    expect(readFileSync(portFile, "utf8")).toBe("");
    expect(log.join(" ")).not.toContain("tok-fixed-for-assert"); // 横幅由入口负责，不是 boot
  });
});
