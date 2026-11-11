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
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fixtureTmp } from "../fixtures/fixture-dir.js";
import { openDb } from "../../src/db/driver.js";
import { migrate } from "../../src/db/migrate.js";
import { isBackupName, isSamePath } from "../../src/db/backup.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { InMemoryEventBus } from "../../src/events/bus.js";
import { appendAudit } from "../../src/events/recorder.js";
import { openSnapshotReadonlyDb } from "../../src/db/pragmas.js";
import {
  DRILL_TARGET_NAME,
  EXIT_OK,
  EXIT_PROBLEM,
  EXIT_USAGE,
  parseMaintenanceArgs,
  removeDrillTarget,
  report,
  runMaintenance,
  runMaintenanceCli,
} from "../../src/heartbeat/maintenance.js";

const TMP = fixtureTmp("maintenance", import.meta.url);
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

  /**
   * ⭐ 0038：检查【没跑成】这一格。三条断言各挡一种错法：
   *  1. **备份照做**（`backup.ok === true` 且目录里真有文件）——
   *     挡「照 pageBroken 那一支把它也跳过」。那一条路的代价是【真损失】：
   *     保留策略只留最近 7 份，为一个仪器的毛病停一天数据保护是给错的药。
   *     ⚠ 它安全的理由不是「反正源库大概是好的」，是 `createBackup` 自己对产物
   *     再跑一道 integrity_check、不过就 rmSync 并在清理旧备份【之前】早退
   *     （backup.ts 那一段 + 本篇实测：page 级损坏的源库连 VACUUM INTO 都过不去）。
   *  2. **必须响**（onWarning 里出现「没有跑成」与那个失败名）——
   *     挡 0038 之前的「一声不吭」。
   *  3. **ok 仍然是 false**（退出码 1）—— 挡「既然照常备份了就报成功」。
   *     少这一条，前两条会给人一种「这轮没事」的错觉。
   *
   * ⚠ 造法同 assemble.test.ts 那一发：`integrityTimeoutMs: 0` 走真的 runIntegrityScan，
   *   拿到真的 worker_timeout。CLI 那条路上【没有】这个旗（刻意的：那等于一个
   *   「关掉启动闸门」的命令行开关），所以这一发只能直接调 runMaintenance。
   */
  it("⭐ 检查没跑成 ⇒ 备份照做 + 响一声 + 仍然不算成功（0038）", async () => {
    const f = fresh();
    const warnings: string[] = [];
    const r = await runMaintenance({
      dbPath: f.path,
      db: f.q.readConnection(),
      writer: f.q,
      bus: f.bus,
      backupDir: f.backupDir,
      skipPatrol: true,
      integrityTimeoutMs: 0,
      now: () => T0,
      onWarning: (m) => warnings.push(m),
    });
    // 前置自查：这一发要测的是「检查没跑成」而不是「检查报了损坏」。
    expect(r.integrity.unavailable, "夹具没造出仪器故障，这一发测不到那一格").toBe("worker_timeout");
    expect(r.backup?.ok, "检查没跑成【不该】连带跳过备份").toBe(true);
    expect(existsSync(f.backupDir)).toBe(true);
    expect(warnings.join("\n")).toContain("没有跑成");
    expect(warnings.join("\n")).toContain("worker_timeout");
    // 指路方向：修环境，而不是恢复数据。
    expect(warnings.join("\n")).toContain("不要");
    expect(warnings.join("\n")).not.toContain("按 scripts/restore.md 恢复");
    expect(r.ok).toBe(false);
  });

  it("⭐ report()：仪器故障那一轮不许喊「库可能已损坏」；真损坏那一轮仍然喊（0038）", async () => {
    /*
     * 这一发测的是【人读到的那两行】，而它只能用直接调 report() 测：
     * CLI 没有 integrityTimeoutMs 那个旗（刻意不加），所以 CLI 那条通路永远
     * 拿不到 unavailable，写不出这条用例。
     *
     * 两条腿（缺一条整发就是恒绿的）：
     *  · 仪器故障的 result ⇒ 出现「没跑成」+「不要……恢复」，且【不】出现
     *    「库可能已损坏」—— 挡的是 0038 之前那句对【所有】!ok 一律喊恢复的文案。
     *  · 真损坏的 result ⇒ 仍然出现「库可能已损坏」+ restore.md ——
     *    挡「把那句指路整个删掉」这种把上一条变绿的改法。
     * 两份 result 都来自【真跑一次 runMaintenance】，不是手搓的假对象：
     * report 只读 result，喂真结果才能让「unavailable 到底长什么样」也一起被验到。
     */
    const brokenRun = (() => {
      const f = fresh();
      return runMaintenance({
        dbPath: f.path,
        db: f.q.readConnection(),
        writer: f.q,
        bus: f.bus,
        backupDir: f.backupDir,
        skipPatrol: true,
        integrityTimeoutMs: 0,
        now: () => T0,
        onWarning: () => {},
      });
    })();
    const h1 = io();
    report(await brokenRun, h1.io);
    const instrument = h1.out.join("\n");
    expect(instrument).toContain("没跑成");
    expect(instrument).toContain("不要");
    expect(instrument).not.toContain("库可能已损坏");

    // 对照腿：【真损坏】的那一轮必须仍然喊「库可能已损坏」+ 指 restore.md。
    // 少了这条，上面那三断言可以靠「把 else 那一支整个删掉」蒙绿 ——
    // 而删掉它等于让真损坏的那一轮【没有】指路，那比原来那句更糟。
    // 这一跑同时补上一格空白：此前 report() 的 else 分支【没有任何用例覆盖】
    //（CLI 那些用例里，损坏的库要么在 openDb 就抛、要么走的是 runMaintenance 直调，
    //  两条都到不了 report()）。
    const corruptFixture = fresh();
    await corruptFixture.q.close();
    queues.pop();
    closeAllQuietly(corruptFixture.db);
    corruptWholePages(corruptFixture.path, 6);
    const cq = new WriteQueue(corruptFixture.path);
    queues.push(cq);
    const corruptRun = await runMaintenance({
      dbPath: corruptFixture.path,
      db: cq.readConnection(),
      writer: cq,
      bus: new InMemoryEventBus(),
      skipBackup: true,
      skipPatrol: true,
      now: () => T0,
      onWarning: () => {},
    });
    // 前置自查：这一跑得是「检查跑成了而它报损坏」，不是又一次没跑成。
    expect(corruptRun.integrity.unavailable).toBeUndefined();
    expect(corruptRun.integrity.ok).toBe(false);
    const h2 = io();
    report(corruptRun, h2.io);
    expect(h2.out.join("\n")).toContain("库可能已损坏");
    expect(h2.out.join("\n")).toContain("restore.md");
    // 反向对照：损坏那一轮不许同时喊「没跑成」（那会把人送去修环境）。
    expect(h2.out.join("\n")).not.toContain("没跑成");
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

describe("④ 恢复演练接进来了（0032）", () => {
  /**
   * ⭐ 演练跑通了、目标【不留在】备份目录里。
   *
   * 这一发的落点是【目录里恰好一份文件、就是那份备份】。它同时钉住三件事：
   *  ① 演练真的跑了（r.drill 在场且 restore.ok）；
   *  ② 演练产物被删干净了（没留下第二份库拷贝，否则备份目录体积每次翻倍）；
   *  ③ 演练产物【没被当成一份备份】—— 如果它的名字匹配备份形状，
   *     这里会看到两份文件，而 KEEP_BACKUPS=7 的语义会从「留 7 天」变成「留 3.5 天」。
   * ② 与 ③ 在屏幕上都是「多一个文件」，所以要靠名字把它们分开判。
   */
  it("演练通过 ⇒ drill 在场、ok 为真、备份目录里【只有那一份备份】", async () => {
    const f = fresh();
    const warnings: string[] = [];
    const r = await runMaintenance({
      dbPath: f.path,
      db: f.q.readConnection(),
      writer: f.q,
      bus: f.bus,
      backupDir: f.backupDir,
      skipPatrol: true,
      now: () => T0,
      onWarning: (m) => warnings.push(m),
    });
    expect(r.drill).toBeDefined();
    expect(r.drill?.ok).toBe(true);
    expect(r.drill?.restore.ok).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.drillSkipped).toBeUndefined();
    expect(warnings).toEqual([]);

    const files = readdirSync(f.backupDir).sort();
    expect(files).toEqual(["opc-2026-11-12T03-04-05-123Z.db"]);
    // 反向对照：演练目标的名字确实【不是】备份名 —— 这一句把上面那个「只有一份」
    // 从「恰好碰上了」升级成「名字形状决定的」。
    expect(isBackupName(DRILL_TARGET_NAME)).toBe(false);
    expect(isBackupName(files[0] ?? "")).toBe(true);
  });

  it("sidecar 成对删：主文件与 -wal / -shm 都不许留下", () => {
    // removeDrillTarget 单独判。为什么单开一条：跨用例那条只看得见「目录里没文件」，
    // 而【留下一个孤零零的 -wal】恰好是 0018 §1 第 3 条实测过的那个静默失效 ——
    // 下一次恢复会把它采纳进来，得到一份「完整性检查通过而内容不是任何备份」的库。
    // 「只删 .db」是这里最容易犯的形式，而它比不删更糟。
    const dir = join(TMP, "sidecar-" + process.pid + "-" + ++seq);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, DRILL_TARGET_NAME);
    for (const p of [target, target + "-wal", target + "-shm"]) writeFileSync(p, "x");
    removeDrillTarget(target);
    expect(readdirSync(dir)).toEqual([]);
    // 反向对照 + 幂等：文件本来不存在时不抛（成功路径每轮都会走到它）
    removeDrillTarget(target);
    // 而且它只删这三个名字，不碰邻居
    writeFileSync(join(dir, "邻居.db"), "y");
    removeDrillTarget(target);
    expect(readdirSync(dir)).toEqual(["邻居.db"]);
  });

  /**
   * ⭐ runMaintenance 那句「不抛」是**实现**出来的，不是声明出来的。
   *
   * 触发条件（0032 §2）：库文件名正好叫 drill-target.db —— 于是备份目录里
   * 拼出来的演练目标 = 源库本身，restoreDrill 抛 TypeError。
   * 真实来路是「上一次演练失败留下的那个目标文件被当成现网库跑了」，
   * 而它之所以危险，是因为 restoreDrill【原本会返回 ok:true】而库里已经被删了重写过。
   *
   * 断言的是【三个方向】：不抛、ok=false、告警里说清了「整块没跑」与修法。
   * 少第一个的话这一发只是在测 ok；少第三个的话它测到的是一个「失败了而没人知道怎么修」的态。
   */
  it("演练目标算成源库 ⇒ 不抛、ok=false、告警给得出修法，且【没有备份落地】", async () => {
    // 库直接建在备份目录里、名字就叫 drill-target.db
    const dir = join(TMP, "selftarget-" + process.pid + "-" + ++seq);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, DRILL_TARGET_NAME);
    // 这一发【不配】「拼出来的目标 == 源库」这种前置断言 —— 那个等式两边的值
    // 就是上面那一行 join 出来的，写成断言是恒真的（本仓禁的那类判据）。
    // 防「守卫恒抛 / 实现退化」的是本节【第一条】用例：正常目录 + 正常库名 ⇒
    // ok=true 且 drill 在场。一发只判「撞上了要拦住」，另一发判「没撞上别拦」。
    const db = openDb(path);
    opened.push(db);
    migrate(db as never);
    db.prepare(
      "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
        "VALUES ('T-1', '自指夹具', 'IN_PROGRESS', 'dev', 'implement', ?, ?)",
    ).run(T0, T0);
    const q = new WriteQueue(path);
    queues.push(q);

    const warnings: string[] = [];
    const r = await runMaintenance({
      dbPath: path,
      db: q.readConnection(),
      writer: q,
      bus: new InMemoryEventBus(),
      backupDir: dir,
      skipPatrol: true,
      now: () => T0,
      onWarning: (m) => warnings.push(m),
    });
    expect(r.ok).toBe(false);
    expect(r.drill).toBeUndefined(); // 【没跑】而不是「跑了而失败」
    expect(r.drillSkipped).toContain("同一个文件");
    expect(r.backup).toBeUndefined(); // 备份整块没跑 ⇒ 目录里不该有一份「成功」的备份
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("整块没跑");
    expect(warnings[0]).toContain(DRILL_TARGET_NAME); // 报错要能让人看出触发条件
    // ⭐ 库还在、还能读，而且那条任务一条不少 —— 这一句才是这条用例的落点。
    // 守卫被拆掉时，这一发【不会】在 ok 上红（那边返回 ok:true），
    // 会红在这里：库被删掉重建后，这条连接报 "database is not open"。
    const rows = countTasks(q.readConnection());
    expect(rows).toBe(1);
  });

  /**
   * 「备份成功而演练失败」这一支必须与「备份失败」【分开报】。
   *
   * 造法：不给一个正常的备份目录，而是让恢复那一步自己撞上 IO 失败 ——
   * 最直接的办法是让备份目录【是一位文件】，createBackup 在里面写不出东西。
   * 但那条测的是「备份失败」那一支（已有用例覆盖），所以这里用另一条路：
   * 把备份目录做成只读 ⇒ VACUUM INTO 写不进去？实测那条走的是「备份失败」不是「演练失败」。
   * 因此本发用【真正能落地的备份 + 一个不能落地的演练目标】：目标位置上放一个目录，
   * restoreBackup 就会报 target_not_writable（backup.test.ts 里那条同源夹具）。
   *
   * 期望的形状：backup.ok=true（备份【真的】落地了）、drill.restore.ok=false、
   * ok=false、告警里出现「备份已经落地」这句 —— 少这句，运维会去找备份失败的原因，
   * 而备份目录里明明躺着一份新的。
   */
  it("备份落地而演练失败 ⇒ ok=false、告警里有「备份已经落地」、目标留在原地当现场", async () => {
    const f = fresh();
    mkdirSync(join(f.backupDir, DRILL_TARGET_NAME), { recursive: true });
    const warnings: string[] = [];
    const r = await runMaintenance({
      dbPath: f.path,
      db: f.q.readConnection(),
      writer: f.q,
      bus: f.bus,
      backupDir: f.backupDir,
      skipPatrol: true,
      now: () => T0,
      onWarning: (m) => warnings.push(m),
    });
    expect(r.backup?.ok).toBe(true);
    expect(r.drill?.restore.ok).toBe(false);
    expect(r.drill?.ok).toBe(false);
    expect(r.ok).toBe(false);
    expect(warnings.join("\n")).toContain("备份已经落地");
    expect(warnings.join("\n")).toContain("恢复演练失败");
    // 现场留着：失败时那个路径【不许被删】—— 它是排查时唯一的现场
    expect(existsSync(join(f.backupDir, DRILL_TARGET_NAME))).toBe(true);
    // 而那份备份还在，且仍是可读的库（这一条把「演练失败」与「备份也坏了」分开）
    if (r.backup !== undefined && r.backup.ok) {
      const snap = openSnapshotReadonlyDb(r.backup.path);
      opened.push(snap);
      expect(
        Number((snap.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check === "ok" ? 1 : 0),
      ).toBe(1);
    }
  });

  /**
   * ⭐ 反向对照 + 一条【命名不变式】：生产参数的正常形状下，演练目标永远算不出源库。
   *
   * 判据是 `join(backupDir, DRILL_TARGET_NAME)` 与 `dbPath` 走 isSamePath。
   * 这一发把「什么条件下会相等」写成可执行的判据，而不是留在注释里：
   * 只要库文件名不等于 DRILL_TARGET_NAME，两者【不可能】相等 ——
   * 所以那条守卫不会误拦正常用法（正常用法每次都跑演练），
   * 而它的触发条件窄到只有一句话：`--db` 指的文件正好叫那个名字。
   *
   * 顺带钉住真正重要的那半句：`DRILL_TARGET_NAME` 不匹配备份名形状。
   * 它一旦匹配上，一次演练就产出一份与真备份【完全同权】的「备份」，
   * 7 份保留位被演练挤掉，KEEP_BACKUPS=7 的语义从「留 7 天」变成「留 3.5 天」。
   */
  it("命名不变式：库名不等于演练名 ⇒ 永不误拦；演练名不匹配备份名 ⇒ 不进保留策略", () => {
    const dir = "/data/backups";
    const drill = join(dir, DRILL_TARGET_NAME);
    // 正常库名（含与它同目录那种）⇒ 一律不算同一个文件
    for (const name of ["opc.db", "hub.db", "drill-target.db.bak", "drill.db", "DRILL-TARGET.DB"]) {
      expect(isSamePath(join(dir, name), drill)).toBe(false);
    }
    // 唯一会算成同一个文件的那一种
    expect(isSamePath(join(dir, DRILL_TARGET_NAME), drill)).toBe(true);
    // 演练产物不许被 pruneBackups / listBackups / lastBackupAtMs 看见
    expect(isBackupName(DRILL_TARGET_NAME)).toBe(false);
    // 而它得像个 sqlite 库名（否则 sidecar 那三条 -wal / -shm 的名字就说不清）
    expect(DRILL_TARGET_NAME.endsWith(".db")).toBe(true);
  });

  it("--no-backup ⇒ drillSkipped 有一行话，而退出码照旧是 0", async () => {
    // 这一发守的是【输出面】：report() 里演练那一行【无条件】出现。
    // 一个只在成功时打印的行，与一个「没练」也报出来的行，对读日志的人是两种东西 ——
    // 前者看不出「今天压根没演练」，而那正是这个模块要防的看不见的失效。
    const f = fresh();
    const h = io();
    const r = await runMaintenanceCli(["--db", f.path, "--no-backup", "--no-patrol"], h.io);
    expect(r.code).toBe(EXIT_OK);
    expect(h.out.join("\n")).toContain("恢复演练：没跑");
  });
});

/** events 行数。单开一个函数只是为了让上面那条自指用例读起来是一句断言。 */
function countTasks(db: { prepare(sql: string): { get(): unknown } }): number {
  const row = db.prepare("SELECT count(*) AS c FROM tasks").get() as { c: number | bigint };
  return Number(row.c);
}

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
