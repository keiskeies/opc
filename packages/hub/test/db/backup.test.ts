/**
 * Task 6.3　备份与恢复（src/db/backup.ts）。
 *
 * ── 这一文件在证什么、不在证什么 ────────────────────────────────────
 * 证的是计划 Task 6.3 Test 三条里【本机可测的两条半】：
 *   · 「备份文件可被另一连接打开并通过 integrity_check」→ ② 节
 *   · 「备份期间写入不失败」→ ④ 节（观测出来的，不是看代码形状）
 *   · 「从备份恢复后能 hub resume 继续跑未完成任务」→ ⑤ 节只做到【前半】，
 *     后半（真图 resume）需要 @langchain/*，本机装不上（0009 §2）。
 *     那一半在这里钉成一条【零调用方断言】，接线那天它会红 ——
 *     所以本文件的结论是「恢复出来的文件可用」，不是「恢复演练端到端通过」。
 *
 * ── 三条实测事实，它们决定了断言为什么长这样 ─────────────────────────
 * 1) VACUUM INTO 的产物 journal_mode 是 **delete**（不是 wal）。
 *    所以校验产物【不能】用 openReadonlyDb —— 那条会执行
 *    `PRAGMA journal_mode = WAL`，而它是持久设置，在只读连接上改一份
 *    delete 模式的库要写库头，当场抛 "attempt to write a readonly database"（实测）。
 *    ② 节里有一条专门把这件事钉住：如果哪天有人把 backup.ts 改回 openReadonlyDb，
 *    所有备份会【全部失败在校验那一步】，而失败信息说的是「只读不能改模式」。
 * 2) 目标文件已存在 ⇒ VACUUM INTO 抛 "output file already exists"（不覆盖）。
 *    所以「同一毫秒两次备份」这件事必须有名可走（nextBackupPath），
 *    而保留策略必须按【名字】排序（字典序 == 时间序），不能按 mtime。
 * 3) 恢复目标旁边留着【别的库的】-wal 会被静默采纳（本轮实测，最值钱的一条）：
 *    A.db 复制成 B.db、A 的 -wal 复制成 B-wal，打开 B ⇒ journal_mode 变 wal、
 *    行数 500 变 520、integrity_check 仍报 "ok"。
 *    ⑤ 节那一发就是钉这个：一个【通过完整性检查而内容不是那个备份】的库
 *    必须被拦住，而不是被当成恢复成功。
 *
 * ── 夹具口径 ────────────────────────────────────────────────────────
 * 用真迁移库（migrate()）而不是手搓表：备份要验的是「这份库能不能用来恢复」，
 * 手搓一张表会让 append-only 触发器、FTS、sqlite_sequence 这些
 * 【恢复之后才需要成立的东西】根本不存在。
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  closeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fixtureTmp } from "../fixtures/fixture-dir.js";
import { openDb } from "../../src/db/driver.js";
import { openReadonlyDb, openSnapshotReadonlyDb } from "../../src/db/pragmas.js";
import { migrate } from "../../src/db/migrate.js";
import {
  BACKUP_FAILURE_REASONS,
  BACKUP_PREFIX,
  BACKUP_SUFFIX,
  BACKUP_WORKER_FAILURES,
  KEEP_BACKUPS,
  BackupWorkerThrewError,
  backupName,
  createBackup,
  createBackupOffLoop,
  isBackupName,
  isSamePath,
  listBackups,
  pruneBackups,
  restoreBackup,
  restoreDrill,
} from "../../src/db/backup.js";
import { WriteQueue } from "../../src/db/write-queue.js";

const HUB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TMP = fixtureTmp("backup", import.meta.url);

const opened: { close(): void }[] = [];
/**
 * 【每条用例之前清空】。它一度是跨用例累加的，于是「成功路径不得叫 onWarning」
 * 那一类断言从第二条用例起必然红 —— 红的原因与备份毫无关系。
 * 这正是 0006 §7 记过的「夹具自带状态让断言测到别的东西」，本轮自己踩了一次。
 */
let warnings: string[] = [];
let seq = 0;

beforeEach(() => {
  warnings = [];
});

/** 一个跑过迁移、带 N 条事件的库。返回路径，连接留在 opened 里统一关。 */
function migratedDb(events: number): string {
  const path = join(TMP, "bk-" + process.pid + "-" + ++seq + ".db");
  const db = openDb(path);
  opened.push(db);
  migrate(db as never);
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
      "VALUES ('T-1', '备份夹具', 'IN_PROGRESS', 'dev', 'implement', ?, ?)",
  ).run(1_700_000_000_000, 1_700_000_000_000);
  const ins = db.prepare(
    "INSERT INTO events (task_id, actor_type, actor_id, action, target, payload, state_snapshot, created_at) " +
      "VALUES ('T-1', 'system', 'hub', 'state_change', NULL, ?, '{}', ?)",
  );
  for (let i = 0; i < events; i++) {
    ins.run(JSON.stringify({ i, text: "覆盖率达标，第 " + i + " 条" }), 1_700_000_000_000 + i);
  }
  return path;
}

function countEvents(path: string): number {
  const db = openSnapshotReadonlyDb(path);
  try {
    const row = db.prepare("SELECT count(*) AS c FROM events").get() as {
      c: number | bigint;
    };
    return Number(row.c);
  } finally {
    db.close();
  }
}

function sha256Of(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 就地截断一个文件，用来造「形状合法而内容坏掉」的样本。 */
function truncateTo(path: string, fraction: number): void {
  const fd = openSync(path, "r+");
  try {
    ftruncateSync(fd, Math.floor(statSync(path).size * fraction));
  } finally {
    closeSync(fd);
  }
}

function freshDir(tag: string): string {
  const dir = join(TMP, "dir-" + tag + "-" + process.pid + "-" + ++seq);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const warn = (m: string): void => {
  warnings.push(m);
};

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  // Windows：不 close 就 rm 会 EBUSY
  for (const c of opened) {
    try {
      c.close();
    } catch {
      /* 已经关了 */
    }
  }
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 留给下次 */
  }
});

describe("① 备份文件名的三条性质（保留策略建立在这三条上）", () => {
  it("字典序 == 时间序：这是 pruneBackups 排序的正确性前提", () => {
    // 用 ISO 字面量而不是 Date.UTC(y, m, ...)：Date.UTC 的月份是【0 基】，
    // 我第一版写 Date.UTC(2026, 8, 30) 而期望串写的是 08-30，实到 09-30 ——
    // 红得像是「排序不守时间序」，而真相是夹具自己错了月份。见 0018 §6。
    const at = (iso: string): number => Date.parse(iso);
    const names = [
      backupName(at("2026-11-12T03:04:05.123Z")),
      backupName(at("2026-11-12T03:04:05.124Z")),
      backupName(at("2026-11-12T23:59:59.999Z")),
      backupName(at("2027-01-01T00:00:00.000Z")),
      backupName(at("2026-08-30T23:59:59.000Z")),
    ];
    const sorted = [...names].sort();
    // 期望的时间序（旧 → 新）与 sort() 的结果必须一字不差。
    expect(sorted).toEqual([
      "opc-2026-08-30T23-59-59-000Z" + BACKUP_SUFFIX,
      "opc-2026-11-12T03-04-05-123Z" + BACKUP_SUFFIX,
      "opc-2026-11-12T03-04-05-124Z" + BACKUP_SUFFIX,
      "opc-2026-11-12T23-59-59-999Z" + BACKUP_SUFFIX,
      "opc-2027-01-01T00-00-00-000Z" + BACKUP_SUFFIX,
    ]);
    // 月份必须是【真实月份】而不是 Date.UTC 的那个索引：这一发钉住我上面那个错。
    expect(backupName(at("2026-08-30T23:59:59.000Z"))).toContain("-08-30");
    // 反向对照：这一发不是恒真。毫秒差 1 的两个名字必须【不同】且顺序正确，
    // 否则「sort() 等于时间序」可能只是在证「所有名字都相等」。
    expect(backupName(1_700_000_000_000)).not.toBe(backupName(1_700_000_000_001));
    expect([...[backupName(1_700_000_000_001), backupName(1_700_000_000_000)]].sort()[0]).toBe(
      backupName(1_700_000_000_000),
    );
  });

  it("形状：前缀后缀照规格 §6.5，中间不含冒号与点", () => {
    const n = backupName(Date.UTC(2026, 10, 12, 3, 4, 5, 123));
    expect(n.startsWith(BACKUP_PREFIX)).toBe(true);
    expect(n.endsWith(BACKUP_SUFFIX)).toBe(true);
    expect(n.includes(":")).toBe(false);
    // 除了结尾那个后缀点，中间不许有点：多点会让「取扩展名」这类操作读到错的东西。
    expect([...n].filter((c) => c === ".").length).toBe(1);
    expect(isBackupName(n)).toBe(true);
  });

  it("isBackupName 只认这一种形状（清理旧备份的白名单判据）", () => {
    const rejected = [
      "opc-2026-11-12T03-04-05-123Z.sqlite", // 后缀不对
      "opc-2026-11-12T03-04-05-123Z.db-wal", // 快照的 sidecar，不是备份
      "opc-2026-11-12.db", // 只到「日」：规格字面那种，一天两份就撞
      "backup-2026-11-12T03-04-05-123Z.db", // 前缀不对
      "notes.db", // 谁手放进备份目录的笔记
      "opc-2026-11-12T03-04-05-123Z.db-journal",
      "opc-20261112T030405123Z.db", // 缺分隔符
      "", // 空串
    ];
    for (const r of rejected) {
      expect(isBackupName(r), "应当被拒：" + r).toBe(false);
    }
    // 正对照：判据不是恒假（上面 8 发在恒假的判据下全过）。
    expect(isBackupName(backupName(0))).toBe(true);
  });

  it("backupName 拒绝坏时间戳，不静默造出一个排序无意义的名字", () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => backupName(bad), "应抛：" + String(bad)).toThrow();
    }
    expect(backupName(0)).toContain("1970-01-01");
  });
});

describe("② 一次备份：产物必须能用另一条连接打开并通过 integrity_check", () => {
  it("健康库备份成功，产物行数与源一致，sha256 是产物的而不是源库的", () => {
    const src = migratedDb(50);
    const dir = freshDir("ok");
    const res = createBackup({
      dbPath: src,
      backupDir: dir,
      now: () => Date.UTC(2026, 10, 12, 3, 4, 5, 0),
      onWarning: warn,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return; // 让类型收窄；上面已经红过了
    expect(res.pruned).toEqual([]);
    expect(existsSync(res.path)).toBe(true);
    expect(res.path).toBe(join(dir, "opc-2026-11-12T03-04-05-000Z" + BACKUP_SUFFIX));
    expect(res.eventsInBackup).toBe(50);
    expect(res.bytes).toBe(statSync(res.path).size);
    expect(res.bytes).toBeGreaterThan(0);
    expect(res.sha256).toHaveLength(64);
    // 反向对照：sha256 必须是【产物】的哈希。拿源库的哈希冒充，这一发就绿不了。
    expect(res.sha256).toBe(sha256Of(res.path));
    expect(res.sha256).not.toBe(sha256Of(src));
    // 告警必须是空的：ok:true 同时又叫了 onWarning，就是「成功但其实有问题」。
    expect(warnings).toEqual([]);
  });

  it("产物的 journal_mode 是 delete，而校验仍然通过（钉住快照形打开）", () => {
    const src = migratedDb(10);
    const dir = freshDir("journal");
    const res = createBackup({ dbPath: src, backupDir: dir, onWarning: warn });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const probe = openSnapshotReadonlyDb(res.path);
    try {
      const mode = probe.prepare("PRAGMA journal_mode").all() as { journal_mode: string }[];
      expect(mode[0]?.journal_mode).toBe("delete");
    } finally {
      probe.close();
    }
    // 这一发是【本文件最重要的一条】：它把「用 openReadonlyDb 校验产物」这条路堵死。
    // 那条会抛 "attempt to write a readonly database"（journal_mode 是持久设置）。
    expect(() => openReadonlyDb(res.path)).toThrow(/readonly/u);
    expect(warnings).toEqual([]);
  });

  it("备份不替代审计：产物里 append-only 触发器与 FTS 仍然在", () => {
    const src = migratedDb(5);
    const dir = freshDir("triggers");
    const res = createBackup({ dbPath: src, backupDir: dir, onWarning: warn });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const b = openSnapshotReadonlyDb(res.path);
    try {
      const names = (
        b.prepare("SELECT name FROM sqlite_master WHERE name IN ('events_no_update','events_no_delete','events_fts')").all() as {
          name: string;
        }[]
      ).map((r) => r.name);
      expect(names.includes("events_no_update")).toBe(true);
      expect(names.includes("events_no_delete")).toBe(true);
      expect(names.includes("events_fts")).toBe(true);
      // FTS 在产物上【可查】。VACUUM INTO 会带上 shadow 表，所以恢复后不需要重建索引。
      const hits = b
        .prepare("SELECT count(*) AS c FROM events_fts WHERE events_fts MATCH ?")
        .all('"覆盖率"') as { c: number | bigint }[];
      expect(Number(hits[0]?.c ?? 0)).toBe(5);
      // 反向对照：MATCH 这一发必须有分辨力 —— 一个不可能的关键词必须命中 0。
      expect(
        Number(
          (
            b.prepare("SELECT count(*) AS c FROM events_fts WHERE events_fts MATCH ?").all('"绝不可能出现的词组"') as {
              c: number | bigint;
            }[]
          )[0]?.c ?? -1,
        ),
      ).toBe(0);
    } finally {
      b.close();
    }
    // 触发器不能只在 sqlite_master 里【存在】，得真拦得住。而【只读连接测不出这件事】：
    // 实测只读连接上的 DELETE 先以 "attempt to write a readonly database" 失败，
    // 根本走不到触发器 —— 报错文本里没有 "append-only"。
    // 所以验触发器必须用【可写连接】。这条差异同时是 integrity.ts 那个 append-only
    // 探针【必须走 WriteQueue 而不是旁路只读连接】的理由（否则量到的是只读拒绝，
    // 而它看起来和「触发器挡住了」一模一样）。见 0018 §1 第 6 条。
    const rw = openDb(res.path);
    opened.push(rw);
    try {
      expect(() => rw.prepare("DELETE FROM events WHERE id = 1").run()).toThrow(/append-only/u);
      expect(() =>
        rw.prepare("UPDATE events SET payload = 'x' WHERE id = 1").run(),
      ).toThrow(/append-only/u);
      // 反向对照：同一张表上【能写】。少了这一发，上面两条只是在证「这张表怎么都写不进」，
      // 而「整表不可写」与「append-only」是两回事（后者允许 INSERT）。
      rw.prepare(
        "INSERT INTO events (task_id, actor_type, actor_id, action, payload, state_snapshot, created_at) " +
          "VALUES ('T-1','system','hub','state_change','{}','{}',?)",
      ).run(1_700_000_000_999);
      expect(() => rw.prepare("DELETE FROM events WHERE id = 1").run()).toThrow(/append-only/u);
    } finally {
      rw.close();
    }
  });

  it("写事务持有期间做备份：两侧都不失败，快照只含已提交内容", async () => {
    const src = migratedDb(200);
    const dir = freshDir("concurrent");
    const q = new WriteQueue(src);
    opened.push(q);
    await q.node(() => 1); // 确认两条连接可用

    /*
     * 怎么造出真的【交错】。createBackup 是同步 API，所以「备份跑着、别的写入也在跑」
     * 在主线程上只有一种真形状：【一个写事务横跨备份】。
     * 做法是在 q.node() 里写完未提交的行之后 await 一个门闩，门闩在备份跑完之后才开 ——
     * await 让出主线程，备份就落在那个写事务持有 BEGIN IMMEDIATE 的窗口里。
     * 实测这样能成（0018 §1 第 2 条）：只读连接上的 VACUUM INTO 在写事务期间成功，
     * 拿到的是【已提交】的内容，未提交那几行不在里面。
     *
     * 反过来说清这一发【没有】证的：它不证「备份不阻塞主线程」。
     * 那是同步 API 的固有代价，本模块测不到也不该假装测到 ——
     * 计划要求挪进 worker 的是 integrity_check（Task 6.2），那一发在 integrity.test.ts ①
     * 节真测得到。备份的规模性停摆代价如实记在 0018 §5。
     */
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inFlight = q.node(async () => {
      const db = q.writeConnection();
      const ins = db.prepare(
        "INSERT INTO events (task_id, actor_type, actor_id, action, payload, state_snapshot, created_at) " +
          "VALUES ('T-1','system','hub','state_change',?,?,?)",
      );
      for (let i = 0; i < 20; i++) {
        ins.run(JSON.stringify({ uncommitted: i }), "{}", 1_800_000_000_000 + i);
      }
      await gate; // 让出主线程，备份在此期间跑
    });

    const res = createBackup({ dbPath: src, backupDir: dir, onWarning: warn });
    release();
    await inFlight;

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 快照必须【不含】那 20 行未提交内容 —— 这是隔离性，也是「备份不是拷了个半截」。
    expect(res.eventsInBackup).toBe(200);
    expect(countEvents(res.path)).toBe(200);
    // 提交之后源库是 220 行，而备份仍是 200。两个数同时成立才叫「快照取自那一刻」。
    const live = openDb(src);
    opened.push(live);
    try {
      expect(
        Number((live.prepare("SELECT count(*) AS c FROM events").get() as { c: number | bigint }).c),
      ).toBe(220);
    } finally {
      live.close();
    }
    expect(warnings).toEqual([]);
  });

  it("同一毫秒两次备份不撞名（VACUUM INTO 不覆盖已存在文件）", () => {
    const src = migratedDb(3);
    const dir = freshDir("collision");
    const fixed = Date.UTC(2026, 10, 12, 3, 4, 5, 100);
    const a = createBackup({ dbPath: src, backupDir: dir, now: () => fixed, onWarning: warn });
    const b = createBackup({ dbPath: src, backupDir: dir, now: () => fixed, onWarning: warn });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.path).not.toBe(a.path);
    expect(b.createdAtMs).toBe(fixed + 1);
    expect(listBackups(dir)).toHaveLength(2);
    expect(warnings).toEqual([]);
  });
});

describe("③ 失败必须告警（备份静默失败等于没有备份）", () => {
  it("源库不存在：ok:false + 一次告警", () => {
    const res = createBackup({
      dbPath: join(TMP, "不存在.db"),
      backupDir: freshDir("missing"),
      onWarning: warn,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("source_missing");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("不存在");
  });

  it("ok:false 的每一种失败都恰好叫一次 onWarning", () => {
    const before = warnings.length;
    createBackup({ dbPath: join(TMP, "也没有.db"), backupDir: freshDir("w"), onWarning: warn });
    expect(warnings.length).toBe(before + 1);
  });

  it("产物坏了 ⇒ 文件被删掉，不留诱饵；路径进告警文案", () => {
    // 测的是「VACUUM INTO 自己抛」这一支：源换成一段纯文本。
    // 「产物校验失败即删文件」那一支本机造不出来（没有办法让 VACUUM INTO 报成功
    // 而产物是坏的），它在 ③ 节末尾以【截断产物 + restoreBackup 必须拒】的形式覆盖，
    // 而不是假装 createBackup 的校验分支被测过。这条口径记在 0018 §5。
    const dir = freshDir("partial");
    const notADB = join(TMP, "不是库-" + ++seq + ".bin");
    writeFileSync(notADB, "这是一段纯文本，不是 SQLite 文件");
    const res = createBackup({ dbPath: notADB, backupDir: dir, onWarning: warn });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("vacuum_failed");
    expect(warnings).toHaveLength(1);
    // 半途文件（若有）不得留下。
    expect(readdirSync(dir).filter((n) => isBackupName(n))).toEqual([]);
  });

  it("恢复一份被截断的备份 ⇒ 拒绝，且不碰目标", () => {
    const src = migratedDb(30);
    const dir = freshDir("truncated");
    const res = createBackup({ dbPath: src, backupDir: dir, onWarning: warn });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 手工做一份【形状合法但内容坏掉】的备份：重命名成备份名 + 截断。
    const bad = join(dir, backupName(Date.UTC(2020, 0, 1)));
    copyFileSync(res.path, bad);
    truncateTo(bad, 0.4);
    const target = join(dir, "目标.db");
    const r = restoreBackup({ backupPath: bad, targetPath: target });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("backup_unverified");
    // 拒绝必须发生在【动手之前】：目标文件压根没被创建。
    expect(existsSync(target)).toBe(false);
  });
});

describe("④ 保留策略", () => {
  it("只留最近 KEEP_BACKUPS 份，删的是最旧的", () => {
    const src = migratedDb(2);
    const dir = freshDir("prune");
    const base = Date.UTC(2026, 10, 1, 0, 0, 0, 0);
    for (let i = 0; i < KEEP_BACKUPS + 3; i++) {
      const r = createBackup({
        dbPath: src,
        backupDir: dir,
        now: () => base + i * 60_000,
        onWarning: warn,
      });
      expect(r.ok).toBe(true);
    }
    const left = listBackups(dir);
    expect(left).toHaveLength(KEEP_BACKUPS);
    // 【最新那份必须在】：删错方向（每备份一次删掉最新）是这里最贵的错。
    expect(left[left.length - 1]).toBe(join(dir, backupName(base + (KEEP_BACKUPS + 2) * 60_000)));
    // 删掉的必须是最旧的三份。
    expect(left[0]).toBe(join(dir, backupName(base + 3 * 60_000)));
    expect(warnings).toEqual([]);
  });

  it("清理不碰备份目录里【不是备份】的文件", () => {
    const dir = freshDir("foreign");
    const foreign = ["notes.txt", "opc-2026-11-12.db", "old.db-wal", "手动拷的库.db"];
    for (const f of foreign) writeFileSync(join(dir, f), "x");
    const src = migratedDb(1);
    for (let i = 0; i < 4; i++) {
      createBackup({
        dbPath: src,
        backupDir: dir,
        now: () => Date.UTC(2026, 10, i + 1),
        onWarning: warn,
        keep: 2,
      });
    }
    for (const f of foreign) {
      expect(existsSync(join(dir, f)), "被误删：" + f).toBe(true);
    }
    expect(listBackups(dir)).toHaveLength(2);
  });

  it("keep 必须是 >= 1：keep = 0 意味着每备份完都以为留了一份", () => {
    const src = migratedDb(1);
    expect(() =>
      createBackup({ dbPath: src, backupDir: freshDir("keep0"), onWarning: warn, keep: 0 }),
    ).toThrow();
    expect(() => pruneBackups({ backupDir: freshDir("keep0b"), keep: 0 })).toThrow();
  });
});

describe("⑤ 恢复：形状合法 ≠ 可以拿来覆盖现网库", () => {
  it("恢复到新路径：可用、行数一致、触发器仍在", () => {
    const src = migratedDb(25);
    const dir = freshDir("restore");
    const res = createBackup({ dbPath: src, backupDir: dir, onWarning: warn });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const target = join(dir, "子目录", "恢复出来的.db");
    const r = restoreBackup({ backupPath: res.path, targetPath: target });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.events).toBe(25);
    expect(r.removedSidecars).toEqual([]);
    expect(countEvents(target)).toBe(25);
    // 恢复出来的库【能被生产方式打开】：openDb 会把它设回 WAL。
    const prod = openDb(target);
    opened.push(prod);
    try {
      expect(Number((prod.prepare("PRAGMA journal_mode").get() as { journal_mode: string | number }).journal_mode === "wal" ? 1 : 0)).toBe(1);
      expect(Number((prod.prepare("SELECT count(*) AS c FROM events").get() as { c: number | bigint }).c)).toBe(25);
      // 触发器必须在【恢复出来的这一份】上真的挡住，而不是只在 sqlite_master 里有个名字。
      // 挂在 prod（可写）上而不是只读连接上：② 节记过的那条 —— 只读连接上的 DELETE
      // 先以 "attempt to write a readonly database" 失败，走不到触发器。
      // 第一版就是挂错的连接上，红在那句只读报错上，而恢复其实是好的。
      expect(() => prod.prepare("DELETE FROM events WHERE id = 1").run()).toThrow(/append-only/u);
      expect(() =>
        prod.prepare("UPDATE events SET payload = 'x' WHERE id = 1").run(),
      ).toThrow(/append-only/u);
      // 反向对照：这一份仍然【可以 INSERT】，否则上面两条只证「这张表写不进」。
      prod.prepare(
        "INSERT INTO events (task_id, actor_type, actor_id, action, payload, state_snapshot, created_at) " +
          "VALUES ('T-1','system','hub','state_change','{}','{}',?)",
      ).run(1_700_000_000_888);
      expect(countEvents(target)).toBe(26);
      // FTS 也必须活着（回放与检索靠它；恢复出一个 FTS 坏掉的库是静默失效）。
      const hit = prod
        .prepare("SELECT count(*) AS c FROM events_fts WHERE events_fts MATCH ?")
        .all('"覆盖率达标"') as { c: number | bigint }[];
      expect(Number(hit[0]?.c ?? 0)).toBe(25);
    } finally {
      prod.close();
    }
  });

  it("目标已存在而没给 confirmOverwrite ⇒ 拒绝，且不覆盖", () => {
    const src = migratedDb(7);
    const dir = freshDir("overwrite");
    const res = createBackup({ dbPath: src, backupDir: dir, onWarning: warn });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const target = join(TMP, "已有库-" + ++seq + ".db");
    const keep = openDb(target);
    opened.push(keep);
    migrate(keep as never);
    const before = statSync(target).size;
    const r = restoreBackup({ backupPath: res.path, targetPath: target });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("target_exists");
    expect(r.message).toContain("confirmOverwrite");
    expect(statSync(target).size).toBe(before);
    keep.close();
    // 正向：给了确认就真覆盖。少了这一发，上面那条可能只是在证「恢复从不生效」。
    const ok = restoreBackup({ backupPath: res.path, targetPath: target, confirmOverwrite: true });
    expect(ok.ok).toBe(true);
    expect(countEvents(target)).toBe(7);
  });

  it("文件名不是备份形状 ⇒ 拒绝（不接受【看起来像备份】的文件）", () => {
    const src = migratedDb(4);
    const dir = freshDir("namegate");
    const res = createBackup({ dbPath: src, backupDir: dir, onWarning: warn });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const hand = join(dir, "手工拷的.db");
    copyFileSync(res.path, hand);
    const r = restoreBackup({ backupPath: hand, targetPath: join(dir, "t.db") });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("backup_unverified");
    expect(r.message).toContain("重命名");
    // 重命名成合法形状之后【应当】放行 —— 这一发是上一条的反向对照：
    // 少了它，「恢复永远拒绝」也能让上一条绿。
    const renamed = join(dir, backupName(Date.UTC(2026, 10, 12)));
    copyFileSync(res.path, renamed);
    expect(restoreBackup({ backupPath: renamed, targetPath: join(dir, "t2.db") }).ok).toBe(true);
  });

  it("目标旁边留着【别的库的】-wal ⇒ 必须被清掉，内容必须等于备份", () => {
    // 本轮实测的坑：陈旧 -wal 会被静默采纳，行数变多而 integrity_check 仍报 ok。
    const src = migratedDb(40);
    const dir = freshDir("stalewal");
    const res = createBackup({ dbPath: src, backupDir: dir, onWarning: warn });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // 另造一个库，往 WAL 里堆内容（不 checkpoint、不 close ⇒ -wal 留着）。
    const other = migratedDb(60);
    const ow = openDb(other);
    opened.push(ow);
    // task_id 必须用夹具真建过的那行 'T-1'：events.task_id 上有外键，
    // 第一版图快写了个不存在的 'T-9'，于是这一发死在 FOREIGN KEY constraint failed 上 ——
    // 一个从没跑到断言的夹具，测不到 -wal 采纳这件事。
    const ins = ow.prepare(
      "INSERT INTO events (task_id, actor_type, actor_id, action, payload, state_snapshot, created_at) " +
        "VALUES ('T-1','system','hub','state_change',?,'{}',?)",
    );
    for (let i = 0; i < 300; i++) {
      ins.run(JSON.stringify({ poison: i }), 1_900_000_000_000 + i);
    }
    const otherWal = other + "-wal";
    expect(existsSync(otherWal), "夹具没能造出 -wal，这一发测不到东西").toBe(true);

    const target = join(TMP, "被污染的目标-" + ++seq + ".db");
    // 先放一份【旧内容】当目标，再把别的库的 -wal 挂到它旁边。
    const old = openDb(target);
    opened.push(old);
    migrate(old as never);
    old.close();
    copyFileSync(otherWal, target + "-wal");

    const r = restoreBackup({
      backupPath: res.path,
      targetPath: target,
      confirmOverwrite: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.removedSidecars).toEqual([target + "-wal"]);
    // 这就是那条反向对照：若 sidecar 没被清掉，这里会读到 40 + 300 而不是 40。
    expect(countEvents(target)).toBe(40);
    expect(existsSync(target + "-wal")).toBe(false);
    ow.close();
  });

  it("端到端那半截：hub resume 在本机跑不了，把缺口钉成断言", () => {
    // 计划 Task 6.3 的 Test 原文有「从备份恢复后能 hub resume 继续跑未完成任务（含 V3 语义）」。
    // 那需要 @langchain/langgraph（0009 §2：本机装不上）。这里【不】假装做到了，
    // 而是把「恢复路径上没有任何一处调用图/恢复」钉成断言：
    // 接线那天（有人把 hub resume 接到恢复流程上）这一发红，逼他回来改本文件的结论。
    const srcDirs = readdirSync(join(HUB, "src"));
    expect(srcDirs.length).toBeGreaterThan(5);
    const dbFiles = readdirSync(join(HUB, "src", "db")).filter((f) =>
      f.endsWith(".ts"),
    );
    expect(dbFiles.includes("backup.ts")).toBe(true);
    const text = readFileSync(join(HUB, "src", "db", "backup.ts"), "utf8");
    // 只扫【可执行代码】，不扫注释。第一版写的是 text.includes("@langchain")，
    // 当场就红了 —— 因为本文件头部那条注释里就写着 @langchain/*。
    // 「一条注释能让一条门禁通过或失败」的门禁不是门禁：它测的是文笔。
    // 所以先把块注释与行注释剥掉，剩下的才是 import 图。
    const code = text
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/^\s*\/\/.*$/gmu, "");
    // 反向对照：剥注释之后代码里【确实还有】import 语句，
    // 否则「不含某个字符串」会因为整段被剥光而恒真。
    expect(/from\s+"/u.test(code)).toBe(true);
    // 恢复代码里【不 import 图、不 import checkpoint、不 import 框架】——它现在只是文件操作。
    expect(code.includes('from "../graph/')).toBe(false);
    expect(code.includes('from "../checkpoint/')).toBe(false);
    expect(code.includes("@langchain")).toBe(false);
    // 这条是接线那天真正会红的：一旦有人把 hub resume 接进恢复路径，
    // backup.ts（或它直接 import 的模块）就会碰 graph / checkpoint。
    const imported = [...code.matchAll(/from\s+"([^"]+)"/gu)].map((m) => m[1] ?? "");
    expect(imported.length).toBeGreaterThan(3);
    expect(imported.filter((m) => m.startsWith("../"))).toEqual([]);
  });
});

describe("⑥ 恢复演练：备份成功 ≠ 恢复可用", () => {
  it("演练一次通过：备份 + 恢复到临时目标 + 两侧都算数", () => {
    const src = migratedDb(12);
    const dir = freshDir("drill");
    const drillTarget = join(dir, "drill-target.db");
    const d = restoreDrill({
      dbPath: src,
      backupDir: dir,
      drillTargetPath: drillTarget,
      onWarning: warn,
      now: () => Date.UTC(2026, 10, 12, 6, 0, 0, 0),
    });
    expect(d.ok).toBe(true);
    expect(d.backup.ok).toBe(true);
    expect(d.restore.ok).toBe(true);
    if (!d.restore.ok) return;
    expect(d.restore.events).toBe(12);
    expect(countEvents(drillTarget)).toBe(12);
    expect(warnings).toEqual([]);
  });

  it("第二次演练不受第一次残留影响（同一目标反复演练）", () => {
    const src = migratedDb(8);
    const dir = freshDir("drill2");
    const drillTarget = join(dir, "drill-target.db");
    const first = restoreDrill({
      dbPath: src,
      backupDir: dir,
      drillTargetPath: drillTarget,
      onWarning: warn,
      now: () => Date.UTC(2026, 10, 12, 6, 0, 0, 0),
    });
    expect(first.ok).toBe(true);
    // 在演练目标上写点东西，模拟「演练之后有人拿它试过恢复」。
    const t = openDb(drillTarget);
    opened.push(t);
    migrate(t as never);
    for (let i = 0; i < 50; i++) {
      t.prepare(
        "INSERT INTO events (task_id, actor_type, actor_id, action, payload, state_snapshot, created_at) " +
          "VALUES ('T-1','system','hub','state_change',?,'{}',?)",
      ).run(JSON.stringify({ drillResidue: i }), 1_950_000_000_000 + i);
    }
    t.close();
    const second = restoreDrill({
      dbPath: src,
      backupDir: dir,
      drillTargetPath: drillTarget,
      onWarning: warn,
      now: () => Date.UTC(2026, 10, 12, 7, 0, 0, 0),
    });
    expect(second.ok).toBe(true);
    if (!second.restore.ok) return;
    // 残留必须被清掉：这一发读到的必须还是 8，不是 58。
    expect(countEvents(drillTarget)).toBe(8);
    expect(second.restore.events).toBe(8);
  });

  it("源库坏了 ⇒ 演练如实失败，并告警一次", () => {
    const dir = freshDir("drill-bad");
    const notADB = join(TMP, "坏源-" + ++seq + ".bin");
    writeFileSync(notADB, "不是库");
    const d = restoreDrill({
      dbPath: notADB,
      backupDir: dir,
      drillTargetPath: join(dir, "t.db"),
      onWarning: warn,
    });
    expect(d.ok).toBe(false);
    expect(d.backup.ok).toBe(false);
    expect(d.restore.ok).toBe(false);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  /**
   * ⭐ 演练目标算成源库 ⇒ 必须【抛】，而且必须在删任何东西之前就抛。
   *
   * 这条用例防的是本模块唯一能毁掉现网库的一条路（文件头第 4 条，实测过）：
   * 守卫不存在时 `restoreDrill` **返回 ok:true**，而它已经把源库删了、
   * 用备份覆盖了它、删了它的 -wal。也就是说**没有这条用例时，那个 bug 的表现是「全绿」**。
   *
   * 三种写法都要覆盖，因为它们的失效方式不同：
   *  ① 一模一样的字符串 —— 只有「字符串比较」的实现能挡住这一种；
   *  ② 带 `..` 的另一种写法（`sub/../x.db`）—— 只有【归一化之后】的比较才挡得住，
   *     而这正是真实形状：路径是从 CLI 拼出来的，没人保证它是规范形式；
   *  ③ 反向对照 —— 同名而不同目录必须【照常跑】，否则这条判据可以是「永远抛」，
   *     那就把一个可用参数判成不可用（本仓那条「一条判据要有反向对照」的口径）。
   */
  it("⭐ 演练目标 = 源库（含 `..` 那种写法）⇒ 抛 TypeError 且源库毫发无损", () => {
    const src = migratedDb(9);
    const dir = freshDir("drill-selfguard");

    // ① 同一个字符串
    expect(() =>
      restoreDrill({ dbPath: src, backupDir: dir, drillTargetPath: src, onWarning: warn }),
    ).toThrow(TypeError);
    expect(existsSync(src)).toBe(true);
    expect(countEvents(src)).toBe(9);
    // 抛在 createBackup 之前 ⇒ 连备份都不该写出来。这一条把「先备份再报错」那种写法拒掉：
    // 那种写法会把一次自毁变成「一份备份 + 一次失败」，而库已经被删了。
    expect(readdirSync(dir)).toEqual([]);

    // ② 同一个文件的另一种写法。dir 就在 TMP 里面，所以 dir/sub/../.. 回到 TMP，
    // 拼上同一个 basename 就是 src 本身 —— 归一化之后相等，字符串不等。
    const sub = join(dir, "sub");
    mkdirSync(sub, { recursive: true });
    const base = src.slice(TMP.length + 1);
    expect(base).not.toContain("/"); // 夹具就在 TMP 根下，否则下面那个 `..` 的层数不对
    // ⚠ 必须用【字符串拼接】而不是 join 造这个路径：join 内部就调 normalize，
    // 会把 `/sub/../..` 直接折掉，得到与 src 一模一样的字符串 ——
    // 那一条断言（「字符串确实不同」）当场红，而红的原因在夹具不在判据。
    // 我第一版就是写成了 join，红在那里；换成拼接才是真在测归一化。
    const viaDotDot = sub + "/../.." + "/" + base;
    expect(viaDotDot).not.toBe(src); // 字符串确实不同 —— 所以这条测的是归一化本身
    expect(isSamePath(src, viaDotDot)).toBe(true);
    expect(() =>
      restoreDrill({ dbPath: src, backupDir: dir, drillTargetPath: viaDotDot, onWarning: warn }),
    ).toThrow(TypeError);
    expect(countEvents(src)).toBe(9);

    // ③ 反向对照：同名、另一个目录 ⇒ 不是同一个文件，必须照常演练
    const other = freshDir("drill-selfguard-other");
    const sameNameElsewhere = join(other, src.slice(TMP.length + 1));
    expect(basename(sameNameElsewhere))
      .toBe(basename(src));
    expect(isSamePath(src, sameNameElsewhere)).toBe(false);
    const d = restoreDrill({
      dbPath: src,
      backupDir: dir,
      drillTargetPath: sameNameElsewhere,
      onWarning: warn,
    });
    expect(d.ok).toBe(true);
    expect(countEvents(src)).toBe(9);
    expect(warnings).toEqual([]);
  });

  /**
   * 演练目标位置上躺着一个【目录】。这不是编的形状：演练失败时那个目标会被
   * 【留在原地当现场】（maintenance.ts 里那条决定），于是它进入人的视野，
   * 而人被它绊到的第二天可能把它换成同名目录再排查一遍。
   *
   * 这一发守的是一条【跨模块契约】：runMaintenance 承诺「不抛」，
   * 而它只接 TypeError 那一类异常。rmSync 对目录抛的是 ERR_FS_EISDIR ——
   * 不在那一条里，会一路冒到进程外，把「巡检顺手跑一次」变成一次崩溃。
   * 出口是 restoreBackup 那个有名字的失败态 target_not_writable。
   *
   * ⚠ 断言写的是【实测的形状】而不是我设想的样子：备份【会】落地（restoreDrill
   * 必须先备份才有东西可恢复），失败如实报在 restore 那一侧，那个目录【不会被删】。
   * 我第一版给它配了一条「备份目录里必须还是空的」的断言并在 restoreDrill 里前置一道
   * 抛门 —— 那条断言当场红了，而我起初以为是判据写错。真相是这个函数【兑现不了】那条：
   * 「跑不了」这件事只能在备份之后知道。⇒ 记下这一处，免得下一次我又给它许同一个承诺。
   */
  it("演练目标是一位目录 ⇒ 不崩、如实报 target_not_writable、那个目录不被递归删", () => {
    const src = migratedDb(4);
    const dir = freshDir("drill-dir");
    const target = join(dir, "drill-target.db");
    mkdirSync(target);

    const d = restoreDrill({ dbPath: src, backupDir: dir, drillTargetPath: target, onWarning: warn });
    expect(d.ok).toBe(false);
    expect(d.backup.ok).toBe(true); // 备份那一步真的成功了 —— 这一格必须如实，不能顺势报 false
    expect(d.restore.ok).toBe(false);
    if (d.restore.ok) return;
    expect(d.restore.reason).toBe("target_not_writable");
    // 那个目录还在：删它需要 recursive，而「递归删调用方给的路径」正是同路径守卫防的形状
    expect(statSync(target).isDirectory()).toBe(true);
    expect(countEvents(src)).toBe(4);
    // 告警恰好一次（restoreDrill 失败那一支），不多不少
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("恢复演练失败");
  });

  it("restoreBackup 遇到目录目标 ⇒ 一个有名字的失败态，而不是一段裸 IO 报错", () => {
    const src = migratedDb(3);
    const dir = freshDir("restore-dir");
    const b = createBackup({
      dbPath: src,
      backupDir: dir,
      onWarning: warn,
      now: () => Date.UTC(2026, 10, 12, 6, 0, 0, 0),
    });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    const target = join(dir, "不是文件");
    mkdirSync(target);
    // 传了 confirmOverwrite 也一样拒 —— 这一格防的就是「照 target_exists 那句去做会二次失败」
    const r = restoreBackup({ backupPath: b.path, targetPath: target, confirmOverwrite: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("target_not_writable");
    expect(r.message).toContain("不是普通文件");
    // 反向对照：换一个新路径就能恢复，否则这条判据可以是「恢复恒失败」
    const ok2 = restoreBackup({ backupPath: b.path, targetPath: join(dir, "ok-target.db") });
    expect(ok2.ok).toBe(true);
  });

  /**
   * `isSamePath` 的判据本身。为什么单开一条：上面那条用例里它是【被顺带用到】的，
   * 而它同时被维护入口的断言引用（那个断言要用【同一个】谓词，见 backup.ts 里
   * 那段「为什么导出」）。判据自己没人直接测的话，「两边用的是同一个谓词」
   * 这句话只保证了「两边一起错」。
   */
  it("isSamePath：归一化后才可比，而它不许退化成「永远 false」", () => {
    expect(isSamePath("/a/b.db", "/a/b.db")).toBe(true);
    expect(isSamePath("/a/b.db", "/a/x/../b.db")).toBe(true);
    expect(isSamePath("rel/b.db", join(process.cwd(), "rel", "b.db"))).toBe(true);
    // 反向对照三对，缺一对这条判据就可以是「恒 true」：
    expect(isSamePath("/a/b.db", "/a/c.db")).toBe(false);
    expect(isSamePath("/a/b.db", "/a/x/b.db")).toBe(false);
    // 大小写在判据上是【不同文件】—— 这条与 platform 归一化那一条方向相反，
    // 因为 macOS 的大小写不敏感只发生在真 open 的时候，而这里是纯字符串归一化。
    // 宁可多拦一次：这里错的方向是「拒绝跑演练」，不是「跑错文件」。
    expect(isSamePath("/a/B.db", "/a/b.db")).toBe(false);
  });
});

/**
 * ⑦ 备份挪出事件循环（0036，`createBackupOffLoop`）。
 *
 * ── 这一节与上面六节的【分工】──────────────────────────────────────
 * 上面六节测的是「一次备份对不对」，这一节测的是「一次备份【在主线程之外】跑完之后
 * 那些性质还在不在」，加上一条【新的】：主线程一毫秒都不许停。
 * 所以这一节里有几条是上面那几条的【异步版复制品】（比如「产物要能打开」）。
 * 那不是重复：同步版绿不蕴含异步版绿 —— 两条路走的是【不同的拼装代码】
 * （一条直接调 createBackup，一条要过 postMessage 的边界）。
 * 而边界的两侧各有一份拼装：主线程拼 workerData，worker 拼 BackupRequest。
 * **任何一处漏一个字段，症状都是「注入被静默丢掉」而不是报错**，
 * 这正是这一节存在的理由（本篇撞过一次：nowMs 在主线程带了、worker 拼装时没往下传）。
 *
 * ── 三条【这一节证不了】的事，先说在前面 ──────────────────────────
 *  · 证不了 worker 起不来时的行为（入口由 import.meta.url 推导，本机造不出「入口丢了」；
 *    integrity.test.ts ① 那一节撞过同一格，那里退成了「库路径不存在」的可达一半）。
 *  · 证不了「真卡住的备份会在 N ms 被打断」—— 超时那发是 timeoutMs: 0 造的，
 *    它证的是【超时会被判失败而不是判通过】。
 *  · 证不了 worker 被 terminate 而【不退进程】这件事（第四条通道 exit）——
 *    今天没有任何路径走到那里，见 backup.ts 那一支上面的注释。
 */
describe("⑦ 备份在 worker 里跑（0036）", () => {
  /** 一个够大的库：够到「同步跑会明显停一拍」的量级，否则下面那发恒绿。 */
  function bigDb(rows: number): string {
    const path = migratedDb(rows);
    // 用自家 schema 翻倍（不能 UPDATE，append-only 触发器会拒；integrity.test.ts 撞过）。
    for (let k = 0; k < 3; k++) {
      const db = openDb(path);
      opened.push(db);
      db.exec(
        "INSERT INTO events (task_id, actor_type, actor_id, action, payload, state_snapshot, created_at) " +
          "SELECT task_id, actor_type, actor_id, action, " +
          "json_set(payload, '$.pad', '一撑大页面规模的中文串' || id), '{}', created_at + id FROM events",
      );
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
    }
    return path;
  }

  it("⭐ 备份期间【主线程仍在推进】；而同步版会把主线程停住（反向对照）", async () => {
    /*
     * 这一发是 0036 的【全部理由】，所以它必须是一条【行为】判据而不是源码形状：
     * 「是不是 new Worker」这种断言在实现换成 worker 线程池 / 子进程的那天就会误红，
     * 而真正要的性质是「这段时间主循环没停」。与 integrity.test.ts ① 同一立场。
     *
     * ⚠ 判据的形式值得说一句：我第一版写成「ticks > 0」，那太松 ——
     * 一个只停 3ms 的实现照样过。所以这里比的是【同一份库上同步版与异步版的差距】：
     * 同步那一次【必须】停得住（ticks 少），异步那一次【必须】停不住（ticks 多几倍）。
     * 这样「库不够大」会让第一发红（而不是让整发白绿）。
     */
    const path = bigDb(4_000); // 4000 × 8 = 32000 行，实测约 37MB / 同步备份 500ms 级
    const dir = join(TMP, "offloop-" + ++seq);

    const probe = async (
      run: () => Promise<unknown>,
    ): Promise<{ ticks: number; maxGap: number }> => {
      let ticks = 0;
      let last = Date.now();
      let maxGap = 0;
      const timer = setInterval(() => {
        const now = Date.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
        ticks++;
      }, 5);
      await run();
      clearInterval(timer);
      return { ticks, maxGap };
    };

    const offLoop = await probe(async () => {
      const r = await createBackupOffLoop({ dbPath: path, backupDir: join(dir, "w") });
      expect(r.ran).toBe(true);
      if (r.ran) expect(r.result.ok).toBe(true);
    });
    const sync = await probe(async () => {
      const r = createBackup({
        dbPath: path,
        backupDir: join(dir, "s"),
        onWarning: () => {},
      });
      expect(r.ok).toBe(true);
    });

    /**
     * ⚠ 【没有】断言「offLoop.maxGap < sync.maxGap」，而那不是疏忽。
     * 我第一版就是这么写的，它【红】：同步那一次在主线程上跑，探针根本没法在它内部采样，
     * 于是 sync.maxGap 恰好等于整次备份时长（500ms 级），而 offLoop 的 gap 只有几十 ms ——
     * 断言方向是对的，但【ticks 那一维】才是稳的：同步期间一次都不 tick。
     * 改成「同步期间几乎不 tick、异步期间明显更多」之后，它测的还是同一件事，
     * 而不再依赖两个数值的相对大小（那两个数都随机器负载漂）。
     */
    expect(
      offLoop.ticks,
      "worker 版备份期间主线程定时器一次都没推进 ⇒ 判据多半还在主线程上（offLoop " +
        offLoop.ticks +
        " / sync " +
        sync.ticks +
        "，offLoop maxGap " +
        offLoop.maxGap +
        "ms）",
    ).toBeGreaterThan(0);
    expect(
      offLoop.ticks,
      "异步版的 ticks 不比同步版多 ⇒ 库不够大，同步那一次根本没停住主线程 ⇒ 这一发白绿"
      ).toBeGreaterThan(sync.ticks);
  });

  it("worker 备出来的那份【不是二等备份】：另一条连接打得开、integrity_check 过、行数一致", async () => {
    const path = migratedDb(37);
    const dir = join(TMP, "offloop-valid-" + ++seq);
    const r = await createBackupOffLoop({ dbPath: path, backupDir: dir });
    expect(r.ran).toBe(true);
    if (!r.ran) return;
    expect(r.result.ok).toBe(true);
    if (!r.result.ok) return;
    expect(existsSync(r.result.path)).toBe(true);
    // 与同步版【同一条】判据：开一条只读连接跑 integrity_check。
    const probe = openSnapshotReadonlyDb(r.result.path);
    try {
      const rows = probe.prepare("PRAGMA integrity_check").all() as {
        integrity_check: string;
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.integrity_check).toBe("ok");
    } finally {
      probe.close();
    }
    // 而且它能【真的被恢复】—— 走的是上面 ⑤ 那一节同一条路径，不是另搓一份。
    const target = join(dir, "restored.db");
    const back = restoreBackup({ backupPath: r.result.path, targetPath: target });
    expect(back.ok).toBe(true);
  });

  it("⭐ 注入的时刻【必须】跟着进 worker：文件名用的是它，不是墙钟", async () => {
    /*
     * 这一发守的是本篇最容易「悄悄丢掉」的一格，而且它【本来不存在】——
     * 我起初把「注入的时钟跨不过 worker 边界」当成一条限制登记下来（0036 §4 原话），
     * 而那句话只对一半：过不了的是【函数】，now 的【返回值】是个 number。
     *
     * 丢掉它的症状不是报错，是【相位判据与文件名不同源】：
     * serve 那边用假时钟判「今天备过了吗」，而文件名用的是真墙钟 ⇒
     * 每个心跳都判「该备」⇒ 每天挤满保留位、把上周那份真备份挤掉。
     * 所以这里断的是【文件名本身】，不是返回值里那个字段
     * （返回值里的 createdAtMs 与文件名是同一处算出来的，断文件名才断到落盘结果）。
     */
    const path = migratedDb(5);
    const dir = join(TMP, "offloop-now-" + ++seq);
    const injectedMs = Date.UTC(2026, 2, 10, 1, 2, 3, 4);
    const r = await createBackupOffLoop({ dbPath: path, backupDir: dir, nowMs: injectedMs });
    expect(r.ran).toBe(true);
    if (!r.ran) return;
    expect(r.result.ok).toBe(true);
    if (!r.result.ok) return;
    expect(r.result.path.endsWith(backupName(injectedMs))).toBe(true);
    // 反向对照：不注入时【不该】是这个时刻（否则上面那发可能只是恒成立）。
    const plain = await createBackupOffLoop({ dbPath: path, backupDir: join(dir, "plain") });
    expect(plain.ran).toBe(true);
    if (!plain.ran) return;
    if (plain.result.ok) {
      expect(plain.result.path.endsWith(backupName(injectedMs))).toBe(false);
    }
  });

  it("nowMs 不合法 ⇒ 抛，而不是【当作没传】用墙钟", async () => {
    // 「当作没传」是这一格里唯一会静默的方向：调用方以为注入生效了。
    // 与 §4 那条「传了函数被悄悄丢掉」同族，只是入口换成了「传了个坏值」。
    for (const bad of [1.5, -1, Number.NaN, "1700000000000"]) {
      await expect(
        createBackupOffLoop({ dbPath: "/nope.db", backupDir: TMP, nowMs: bad as never }),
      ).rejects.toThrow(TypeError);
    }
  });

  it("⭐ 传了 now / onWarning ⇒ 当场抛并指路，而不是带进 worker 后失效", async () => {
    // 类型上这两个字段已经不存在了（Omit），所以只有 JS / as any 能走到这里。
    // 而这一发【必须】有：类型挡得住编译器，挡不住「传了却完全不生效」那一种静默。
    const path = migratedDb(3);
    const dir = join(TMP, "offloop-fn-" + ++seq);
    for (const extra of [{ now: () => 1 }, { onWarning: () => {} }]) {
      await expect(
        createBackupOffLoop({ dbPath: path, backupDir: dir, ...(extra as never) }),
      ).rejects.toThrow(/函数不能过 worker 边界/u);
    }
    // 两个都传 ⇒ 两个都要在报错里点名（只报第一个会让人改完一个再撞第二个）。
    await expect(
      createBackupOffLoop({
        dbPath: path,
        backupDir: dir,
        now: () => 1,
        onWarning: () => {},
      } as never),
    ).rejects.toThrow(/now.*onWarning|onWarning.*now/u);
  });

  it("超时按【失败】处理，不按「没跑完 = 大概成了」处理", async () => {
    const path = migratedDb(50);
    const r = await createBackupOffLoop({
      dbPath: path,
      backupDir: join(TMP, "offloop-timeout-" + ++seq),
      timeoutMs: 0,
    });
    expect(r.ran).toBe(false);
    if (r.ran) return;
    expect(r.failure).toBe("worker_timeout");
    // 超时那一支【拿不到】worker 攒的告警（它没来得及回话）。空数组不等于「没有告警」，
    // 这一点在实现里写了注释，这里钉成断言：别让下一个人把它当成「worker 里没出事」。
    expect(r.warnings).toEqual([]);
    // 反向对照：worker_timeout 必须【不在】createBackup 自己的失败枚举里 ——
    // 两个维度混用会让人以为同步版也可能返回它（它结构上不可能）。
    expect(BACKUP_FAILURE_REASONS as readonly string[]).not.toContain("worker_timeout");
    expect(BACKUP_WORKER_FAILURES as readonly string[]).toContain("worker_timeout");
  });

  it("keep 非法 ⇒ reject 且【保留原文】，不压成一条 reason", async () => {
    /*
     * 这一发钉的是本篇一个【写错过的地方】：我第一版把 worker 里的抛错压成
     * `reason: "verify_failed"`，理由是「总得给调用方一个 reason」。
     * 那句错的代价是【不对症】：verify_failed 的既有语义是「产物落盘了而 integrity_check 不过」，
     * 读它会去查一份并不存在的产物，而真正要改的是调用参数（0032 §0 同一条）。
     * ⇒ 「抛」这一支不带 reason，只带原文，并且走 reject（与同步版只差一个通道）。
     */
    const path = migratedDb(3);
    const e = await createBackupOffLoop({
      dbPath: path,
      backupDir: join(TMP, "offloop-keep-" + ++seq),
      keep: 0,
    }).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(BackupWorkerThrewError);
    // 原文里必须还留着 keep 那句（它教人怎么改）。被压成枚举的话这里就没有了。
    expect(String((e as Error).message)).toContain("keep 必须是 >= 1 的整数");
  });

  it("⭐ 备份【成功】而清理失败时，告警原样带回而结论仍是 ok:true", async () => {
    /*
     * 这一发是本篇【最贵的一条】，因为它防的是我自己写过的那个错。
     *
     * 第一版 backup.worker.ts 里 `onWarning` 直接 throw，配的论证是
     * 「createBackup 每条告警之后都紧跟一条 ok:false，所以消息不会丢」——
     * 那句【是假的】：pruneBackups 失败那一条告警之后返回的是 ok:true
     * （「备份成功但清理旧备份失败」，那份备份确实可用）。
     * 于是那一版把一份【已经成功】的备份报成失败 ⇒ 调用方再备一次 ⇒ 目录越堆越厚，
     * 而那正是保留策略要防的事。
     *
     * 造法不需要 chflags / chmod：一个【目录】占用备份名就够了 ——
     * pruneBackups 只删名字匹配 BACKUP_NAME 的条目，而 rmSync(目录) 抛 EISDIR。
     * （比改权限好：那条在 root / CI 容器里会静默不生效，变成一条白绿的用例。）
     */
    const path = migratedDb(9);
    const dir = join(TMP, "offloop-prune-" + ++seq);
    mkdirSync(dir, { recursive: true });
    const squatter = join(dir, backupName(Date.UTC(2026, 0, 1)));
    mkdirSync(squatter); // 一个占着备份名的目录 = prune 删不掉它
    const r = await createBackupOffLoop({ dbPath: path, backupDir: dir, keep: 1 });
    expect(r.ran).toBe(true);
    if (!r.ran) return;
    // ⭐ 结论必须是【成功】。把它报成失败就是本篇第一版那个缺陷本体。
    expect(r.result.ok).toBe(true);
    // 而告警一条都不能少 —— 静默掉那一条，就没人知道目录在超出保留位。
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0] ?? "").toContain("清理旧备份失败");
  });

  it("worker 线程装配错（workerData 少字段）⇒ worker_error 且带原文", async () => {
    // 这一支测的是【环境/装配】层的失效，与 worker_unavailable 同一类（结论没拿到），
    // 所以它是 resolve 成 ran:false 而不是 reject —— 与上面 keep 那一发【刻意不同】：
    // 那里是「业务上不许继续」，这里是「这一轮没跑成，下一轮再试」。
    // 两批发酵成不同的形状，是因为调用方的处置动作不同（改代码 vs 等下一次）。
    const dir = join(TMP, "offloop-werr-" + ++seq);
    const r = await createBackupOffLoop({ dbPath: 42 as never, backupDir: dir });
    expect(r.ran).toBe(false);
    if (r.ran) return;
    expect(r.failure).toBe("worker_error");
    expect(r.message).toContain("backup.worker 没收到 dbPath");
    expect(BACKUP_WORKER_FAILURES as readonly string[]).toContain("worker_error");
  });

  it("⚠ worker 入口【被主线程 import】时必须抛（不得静默什么都不做）", async () => {
    // 抄 integrity.worker 那三条约束里的第 1 条：被主线程 import 时静默返回
    // = 一次备份从未发生而没人报错。这里是 P-E 那一发变异的落点。
    // 只能【动态 import】：静态 import 会直接让本文件炸掉。
    await expect(import("../../src/db/backup.worker.js")).rejects.toThrow(
      /被主线程 import 了/u,
    );
  });

  it("⭐ backup.ts 的模块图【不含框架】—— worker 入口能不能加载起来的前提", () => {
    /*
     * worker 拿到的是主线程的 execArgv 而【不是】它的模块图。
     * backup.worker.ts 只 import ./backup.js，所以 backup.ts 一旦顺手 import 了
     * 一个认识 @langchain 的东西，这个入口就会在缺那几个包时【连加载都做不到】
     * （本机就缺，0009 §2），于是「每日备份」这块的可验证性由 import 图决定。
     *
     * 为什么按【import 语句】数而不是按 import 图递归解析：
     * 递归解析要把整张图算出来（得依赖打包器或 tsc 的 API），而这里要防的只是
     * 「有人在本文件顶部加了一行 import」。0033 §3 那条「只有 import 形态能表达的约束
     * 要用 import 表达」在这里的可执行版本就是：数行首的 import。
     */
    const text = readFileSync(join(HUB, "src", "db", "backup.ts"), "utf8");
    const imports = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("import "))
      .join("\n");
    for (const bad of ["@langchain", "graph/", "http/app", "roles/"]) {
      expect(imports, "backup.ts import 了 " + bad + " ⇒ worker 入口会变重到加载不了").not.toContain(
        bad,
      );
    }
    // 反向对照：这条扫描必须真的【看得见】import 行，否则「不含 X」可能只是
    // 「我把过滤条件写错了，一条都没捞到」。node:sqlite 是 backup.ts 一定有的依赖。
    expect(imports).toContain("node:sqlite");
    // worker 入口自己的运行时 import 也钉住：它【只】能要 worker_threads 与 backup.js。
    // 那两个之外的每一个（哪怕看起来无害）都让入口在缺包时加载不了。
    const wtext = readFileSync(join(HUB, "src", "db", "backup.worker.ts"), "utf8");
    const runtimeImports = wtext
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("import ") && !l.startsWith("import type "))
      .join("\n");
    expect(runtimeImports).toContain("node:worker_threads");
    expect(runtimeImports).toContain("./backup.js");
    expect(runtimeImports.split("import ").length - 1).toBe(2);
  });
});
