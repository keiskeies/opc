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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/db/driver.js";
import { openReadonlyDb, openSnapshotReadonlyDb } from "../../src/db/pragmas.js";
import { migrate } from "../../src/db/migrate.js";
import {
  BACKUP_PREFIX,
  BACKUP_SUFFIX,
  KEEP_BACKUPS,
  backupName,
  createBackup,
  isBackupName,
  listBackups,
  pruneBackups,
  restoreBackup,
  restoreDrill,
} from "../../src/db/backup.js";
import { WriteQueue } from "../../src/db/write-queue.js";

const HUB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TMP = join(HUB, ".tmp", "backup");

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
});
