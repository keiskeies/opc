/**
 * Task 6.2/6.3 的接线层（src/heartbeat/maintenance.ts）。
 *
 * ── 为什么单独一个文件测这个 ───────────────────────────────────────
 * integrity / backup / patrol 三块各自有自己的测试，而那三份测试里
 * 三块模块【都没有生产调用方】—— 这是本仓反复撞到的同一格（0013 §7、0014 标题、
 * 0017 §1 第 1 条）。本文件测的就是「接上了没有」这一格：
 * 一轮调用之后，库里应当同时出现【备份文件】与【停滞事件】，
 * 而退出码要能把「好」「查出问题」「用法不对」三态分开。
 *
 * ── 最重要的一格：源库页面检查不过时【不备份】──────────────────────
 * 这是本模块唯一的实质决定，代价算在 maintenance.ts 文件头。
 * 反向对照必须成对：健康库【必须】备份出来，损坏库【必须】不备份出来。
 * 只写后者的测试会放过一个「永远不备份」的实现；只写前者会放过「损坏也备份」——
 * 而后者才是会丢数据的那一支（保留策略只留 7 份，坏的那份成为最新那份）。
 *
 * ── 不起真子进程 ──────────────────────────────────────────────────
 * tsx 在本机装不上（0009 §2），cli/smoke.test.ts 那批子进程用例就在红名单里。
 * 这里走 runMaintenanceCli(argv, io) 的注入形状：退出码照测，进程边界不测，
 * 并且不冒充测了。
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { openDb } from "../../src/db/driver.js";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { InMemoryEventBus } from "../../src/events/bus.js";
import { appendAudit } from "../../src/events/recorder.js";
import { openSnapshotReadonlyDb } from "../../src/db/pragmas.js";
import {
  EXIT_OK,
  EXIT_PROBLEM,
  EXIT_USAGE,
  parseMaintenanceArgs,
  runMaintenance,
  runMaintenanceCli,
} from "../../src/heartbeat/maintenance.js";

const HUB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TMP = join(HUB, ".tmp", "maintenance");
const T0 = Date.parse("2026-11-12T03:04:05.123Z");

const opened: Array<{ close(): void }> = [];
const queues: Array<{ close(): Promise<void> }> = [];
let seq = 0;

type Fix = {
  path: string;
  backupDir: string;
  db: ReturnType<typeof openDb>;
  q: WriteQueue;
  bus: InMemoryEventBus;
};

/**
 * stalled 那一支的【基准时刻】要能改：runMaintenanceCli 没有注入时钟
 * （注入它是为了测试，而 CLI 那一层就是 Date.now —— 再包一层注入点只会让
 * 退出码测试测的是一个假时钟）。夹具默认把任务摆在 T0 - 9h，
 * 而 T0 是 2026-11-12，相对真实【现在】是【未来】，
 * 于是 silentFor 被 Math.max(0, …) 夹成 0，判 recent。
 * CLI 那两条因此必须拿真实此刻往前推的时刻。
 */
function fresh(opts: { stalledBase?: number } = {}): Fix {
  const path = join(TMP, "mt-" + process.pid + "-" + ++seq + ".db");
  const db = openDb(path);
  opened.push(db);
  migrate(db as never);
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
      "VALUES ('T-1', '维护夹具', 'IN_PROGRESS', 'dev', 'implement', ?, ?)",
  ).run(T0, T0);
  db.prepare(
    "INSERT INTO events (task_id, actor_type, actor_id, action, payload, state_snapshot, created_at) " +
      "VALUES ('T-1', 'system', 'hub', 'state_change', ?, '{}', ?)",
  ).run(JSON.stringify({ kind: "TaskStateChanged", taskId: "T-1", to: "IN_PROGRESS", n: 1 }), T0);
  if (opts.stalledBase !== undefined) {
    // 把任务摆到「很久以前建、很久以前动过」，一轮巡检就该抓到它。
    // 【只能 INSERT，不能 UPDATE/DELETE 那条已有事件】—— 自家 append-only 触发器
    // 会挡下来（0018 §6 第 6 条同一条坑，本轮又踩一次：第一版就是 DELETE，
    // 报错是 "events table is append-only"，而它发生在夹具里）。
    // 做法是把任务与它唯一那条事件都摆在 9 小时前，上面那条 T0 事件属于另一个夹具分支，
    // 所以这里另开一个 task id。
    const old = opts.stalledBase;
    db.prepare(
      "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
        "VALUES ('T-old', '停滞夹具', 'IN_PROGRESS', 'dev', 'implement', ?, ?)",
    ).run(old, old);
    appendAudit(
      db,
      {
        actorType: "system",
        actorId: "hub",
        taskId: "T-old",
        target: null,
        action: "state_change",
        payload: { kind: "TaskStateChanged", taskId: "T-old", to: "IN_PROGRESS", n: 2 },
        createdAt: old,
      },
      () => old,
    );
  }
  const backupDir = join(TMP, "bk-" + process.pid + "-" + seq);
  const q = new WriteQueue(path);
  queues.push(q);
  return { path, backupDir, db, q, bus: new InMemoryEventBus() };
}

function closeAll(): void {
  for (const o of opened) {
    try {
      o.close();
    } catch {
      /* 已关 */
    }
  }
  opened.length = 0;
}

async function closeQueues(): Promise<void> {
  for (const q of queues) {
    try {
      await q.close();
    } catch {
      /* 已关 */
    }
  }
  queues.length = 0;
}

afterAll(async () => {
  await closeQueues();
  closeAll();
  rmSync(TMP, { recursive: true, force: true });
});

mkdirSync(TMP, { recursive: true });

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { write: (t: string) => out.push(t), error: (t: string) => err.push(t) } };
}

describe("① 参数与退出码", () => {
  it("缺 --db 时报错并拒绝猜路径", () => {
    const r = parseMaintenanceArgs([], {});
    expect(r.error).toContain("--db");
    expect(r.dbPath).toBeUndefined();
  });

  it("OPC_DB 作为缺省来源，但空白值不算设置了它", () => {
    expect(parseMaintenanceArgs(["--no-backup"], { OPC_DB: "/tmp/a.db" }).dbPath).toBe("/tmp/a.db");
    expect(parseMaintenanceArgs([], { OPC_DB: "   " }).error).toContain("--db");
    // 反向对照：显式参数赢过环境变量，否则「今天想换个库」做不到
    expect(
      parseMaintenanceArgs(["--db", "/tmp/b.db", "--no-backup"], { OPC_DB: "/tmp/a.db" }).dbPath,
    ).toBe("/tmp/b.db");
  });

  it("要备份就必须给目录：不给 ⇒ 要么给目录要么显式 --no-backup", () => {
    const r = parseMaintenanceArgs(["--db", "/tmp/a.db"], {});
    expect(r.error).toContain("--backup-dir");
    expect(parseMaintenanceArgs(["--db", "/tmp/a.db", "--no-backup"], {}).error).toBeUndefined();
    expect(parseMaintenanceArgs(["--db", "/tmp/a.db", "--backup-dir", "/tmp/bk"], {}).backupDir).toBe("/tmp/bk");
  });

  it("--db=值 这种写法也认（不能只认空格分隔）", () => {
    expect(parseMaintenanceArgs(["--db=/tmp/a.db", "--no-backup"], {}).dbPath).toBe("/tmp/a.db");
  });

  it("未知参数退 2 而不是被当裸参数吃掉", () => {
    expect(parseMaintenanceArgs(["--frobnicate"], {}).error).toContain("--frobnicate");
    expect(parseMaintenanceArgs(["--db"], {}).error).toContain("--db");
  });

  it("--help 退 0 且用法里有三件事", () => {
    const r = parseMaintenanceArgs(["--help"], {});
    expect(r.help).toBe(true);
    expect(r.error).toBeUndefined();
  });
});

describe("② 一轮维护真的把三块接上", () => {
  it("健康库：备份文件落地、内容可读、事件一条不少", async () => {
    const f = fresh();
    const r = await runMaintenance({
      dbPath: f.path,
      db: f.q.readConnection(),
      writer: f.q,
      bus: f.bus,
      backupDir: f.backupDir,
      now: () => T0,
      onWarning: () => {},
    });
    expect(r.integrity.ok).toBe(true);
    expect(r.backup?.ok).toBe(true);
    expect(r.backupSkipped).toBeUndefined();
    expect(r.ok).toBe(true);

    const files = readdirSync(f.backupDir);
    expect(files).toEqual(["opc-2026-11-12T03-04-05-123Z.db"]);
    if (r.backup !== undefined && r.backup.ok) {
      const snap = openSnapshotReadonlyDb(r.backup.path);
      opened.push(snap);
      const inSnap = Number((snap.prepare("SELECT count(*) AS c FROM events").get() as { c: number | bigint }).c);
      // 【不是 1】。完整性扫描的 append-only 探针自己会写一行安全审计 ——
      // 触发器里的写会被 RAISE(ABORT) 回滚，所以那一行必须由捕获异常之后的应用层写
      // （0018 §1 第 7 条）。于是「跑过一次检查」这个动作本身就往 events 里加了一行，
      // 备份拿到的必然是【检查之后】的状态。断言写成 1 会把这条真实因果藏掉。
      expect(inSnap).toBe(r.backup.eventsInBackup);
      expect(inSnap).toBeGreaterThanOrEqual(1);
      const live = Number(
        f.q.readConnection().prepare("SELECT count(*) AS c FROM events").all().length > 0
          ? (f.db.prepare("SELECT count(*) AS c FROM events").get() as { c: number | bigint }).c
          : 0,
      );
      expect(inSnap).toBe(live);
    }
  });

  it("停滞任务被巡检抓到并写成事件；退出面 ok=false（有问题不是「通过」）", async () => {
    const f = fresh({ stalledBase: T0 - 9 * 3_600_000 });
    const r = await runMaintenance({
      dbPath: f.path,
      db: f.q.readConnection(),
      writer: f.q,
      bus: f.bus,
      backupDir: f.backupDir,
      now: () => T0,
      onWarning: () => {},
    });
    expect(r.patrol?.stalled).toBe(1);
    expect(r.patrol?.judgements.find((j) => j.id === "T-old")?.verdict).toBe("stalled");
    expect(r.patrol?.judgements.find((j) => j.id === "T-1")?.verdict).toBe("recent");
    expect(r.ok).toBe(false);
    const rows = f.db
      .prepare("SELECT count(*) AS c FROM events WHERE action = 'escalation'")
      .get() as { c: number | bigint };
    expect(Number(rows.c)).toBe(1);
  });

  it("库文件不存在 ⇒ 退 2 且不创建文件", async () => {
    const missing = join(TMP, "不存在-" + ++seq + ".db");
    const h = io();
    const r = await runMaintenanceCli(["--db", missing, "--no-backup"], h.io);
    expect(r.code).toBe(EXIT_USAGE);
    expect(existsSync(missing)).toBe(false);
    expect(h.err.join("\n")).toContain("刻意不创建");
  });

  it("--no-backup 是人的决定，不该退 1（告警疲劳同一条理由）", async () => {
    const f = fresh();
    const h = io();
    const r = await runMaintenanceCli(["--db", f.path, "--no-backup", "--no-patrol"], h.io);
    expect(r.code).toBe(EXIT_OK);
    expect(h.out.join("\n")).toContain("跳过 —— 调用方显式 --no-backup");
  });

  it("停滞存在 ⇒ CLI 退 1", async () => {
    const f = fresh({ stalledBase: Date.now() - 9 * 3_600_000 });
    const h = io();
    const r = await runMaintenanceCli(["--db", f.path, "--no-backup"], h.io);
    expect(r.code).toBe(EXIT_PROBLEM);
    expect(h.err.join("\n")).toContain("停滞");
  });
});

describe("③ 那一条实质决定：页面检查不过就不备份", () => {
  it("健康库备份出来了（对照），损坏库【没有】备份出来", async () => {
    const healthy = fresh();
    const good = await runMaintenance({
      dbPath: healthy.path,
      db: healthy.q.readConnection(),
      writer: healthy.q,
      bus: healthy.bus,
      backupDir: healthy.backupDir,
      skipPatrol: true,
      now: () => T0,
      onWarning: () => {},
    });
    expect(good.backup?.ok).toBe(true);

    // 造一份【能打开而页面坏掉】的库。这一格的写法不能随手：
    //  - 截断文件 ⇒ openDb 在 applyPragmas 上就抛（0018 §1 第 11 条），
    //    那不是「检查报 violated」，那是「库根本开不了」—— 两种不同的失效，
    //    后者由下面那条 CLI 用例单独测。
    //  - 只覆写中段 512 字节 ⇒ 实测 integrity_check 仍报 "ok"
    //    （落在 freelist / 未使用区，btree 结构完好）。那种夹具会让本条用例
    //    变成一个「什么都没 corrupt」的摆设，而它看起来是在测损坏处理。
    // 实测有效的形状：把中段【整页】覆写掉，page size 从文件头读（4096），
    // 得到 "*** in database main *** Tree 9 page 9: btreeInitPage() returns error code 11"，
    // 而连接【开得了】—— 这才是本条要的那个态。
    const broken = fresh();
    await broken.q.close();
    queues.pop();
    closeAllQuietly(broken.db);
    corruptWholePages(broken.path, 6);

    const warnings: string[] = [];
    const q2 = new WriteQueue(broken.path);
    queues.push(q2);
    const bad = await runMaintenance({
      dbPath: broken.path,
      db: q2.readConnection(),
      writer: q2,
      bus: new InMemoryEventBus(),
      backupDir: broken.backupDir,
      skipPatrol: true,
      now: () => T0,
      onWarning: (m) => warnings.push(m),
    });
    const page = bad.integrity.checks.find((c) => c.name === "page_integrity");
    expect(page?.verdict).toBe("violated");
    expect(bad.backup).toBeUndefined();
    expect(bad.backupSkipped).toContain("页面检查未通过");
    expect(bad.ok).toBe(false);
    // 目录里【一个备份文件都不该有】—— 这一发才是那条决定的全部价值：
    // 一份坏备份成为「最新那份」并挤掉一份好备份，是这一步唯一防住的东西。
    expect(existsSync(broken.backupDir)).toBe(false);
    expect(warnings.join("\n")).toContain("restore.md");
  });

  it("库根本开不了 ⇒ 退 1 并指路 restore.md，而不是一段裸 SQLite 堆栈", async () => {
    // 截断到 50% ⇒ openDb 在 applyPragmas 上抛 "database disk image is malformed"。
    // 这一格守的是本文件最有价值的一条【可用性】性质：这个入口在【唯一需要它说话的时候】
    // 必须说人话。退码也必须是 1（库坏了）而不是 2（你命令写错了）——
    // 运维脚本按退码分支，2 会让人去检查命令行而不是去恢复数据。
    const f = fresh();
    await f.q.close();
    queues.pop();
    closeAllQuietly(f.db);
    truncateSync(f.path, Math.floor(statSync(f.path).size * 0.5));
    const h = io();
    const r = await runMaintenanceCli(["--db", f.path, "--no-backup", "--no-patrol"], h.io);
    expect(r.code).toBe(EXIT_PROBLEM);
    const all = h.err.join("\n");
    expect(all).toContain("库打不开");
    expect(all).toContain("restore.md");
    // 反向对照：裸堆栈不该是唯一出口
    expect(all.includes(" at ")).toBe(false);
  });

  it("not_observable 不拦备份（「没东西可查」≠「文件坏了」）", async () => {
    // 空库：所有自洽规则都是 not_observable，而页面检查是 ok ⇒ 必须照常备份。
    const path = join(TMP, "empty-" + process.pid + "-" + ++seq + ".db");
    const db = openDb(path);
    opened.push(db);
    migrate(db as never);
    const q = new WriteQueue(path);
    queues.push(q);
    const r = await runMaintenance({
      dbPath: path,
      db: q.readConnection(),
      writer: q,
      bus: new InMemoryEventBus(),
      backupDir: join(TMP, "bk-empty-" + seq),
      skipPatrol: true,
      now: () => T0,
      onWarning: () => {},
    });
    expect(r.integrity.checks.some((c) => c.verdict === "not_observable")).toBe(true);
    expect(r.backup?.ok).toBe(true);
  });
});

/** 把中段 n 个【整页】覆写成 0xAB。page size 从文件头第 16 字节读。 */
function corruptWholePages(path: string, n: number): void {
  const head = Buffer.alloc(100);
  const fd0 = openSync(path, "r");
  readSync(fd0, head, 0, 100, 0);
  closeSync(fd0);
  const ps = head.readUInt16BE(16) === 1 ? 65536 : head.readUInt16BE(16);
  const fd = openSync(path, "r+");
  try {
    // 从 page 3 起（0 是 header 页，1 通常是 sqlite_master）
    for (let i = 0; i < n; i++) writeSync(fd, Buffer.alloc(ps, 0xab), 0, ps, (3 + i) * ps);
  } finally {
    closeSync(fd);
  }
}

function closeAllQuietly(x: { close(): void }): void {
  try {
    x.close();
  } catch {
    /* 已关 */
  }
}
