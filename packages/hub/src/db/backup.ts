/**
 * 备份与恢复（Task 6.3，规格 §6.5、计划 Task 6.3）。
 *
 * ── 为什么只有 VACUUM INTO 这一条路 ────────────────────────────────────
 * `node:sqlite` 不提供 `db.backup()`（实测 `typeof db.backup === "undefined"`，
 * 复算见 0018 §1 第 1 条）。规格 §25-D6 风险 12 因此把备份路径写死为
 * `VACUUM INTO`。任何「顺手改成 db.backup()」的改动第一天就抛 TypeError，
 * 所以这条不是风格偏好，是唯一的可用 API。
 *
 * ── 三件动手前实测过、并且决定了实现形状的事 ─────────────────────────
 * 1) **目标文件已存在 ⇒ 直接抛** "output file already exists"（实测）。
 *    VACUUM INTO 不覆盖。所以文件名必须自带唯一性，「保留最近 7 份」那条
 *    策略里的「按名字排序」也必须是**字典序 == 时间序**的名字（下面有断言）。
 *    规格 §6.5 写的是 `opc-{date}.db`。只到「日」不够唯一：同规格同一段还要求
 *    「岗位书变更、委派规则图变更前自动触发一次备份」—— 一天改两次岗位书就是
 *    两个备份撞同一个名字，第二次必然失败，而失败的那一次看起来像「备份功能坏了」。
 *    所以名字用完整时间戳（毫秒），形状仍是 `opc-{...}.db`。这一处偏离规格字面，
 *    登记在 0018 §5。
 * 2) **快照取自只读连接，不占写队列**（实测）。在写事务持有期间从另一条只读连接
 *    跑 VACUUM INTO 成功，拿到的是**已提交**的内容（未提交那一行不在里面）。
 *    这条决定了验收「备份期间写入不失败」能不能成立：如果备份走
 *    WriteQueue.writeConnection()，一次多 GB 的拷贝就把唯一的写者占住
 *    （规格 §6.5 估一万任务 2–4GB），期间所有事件写入排队等待。
 * 3) **恢复目标旁边留着【别的库的】-wal 会被静默采纳**（实测，本轮最值钱的一条）。
 *    把 A.db 复制成 B.db，再把 A 的 -wal 复制到 B-wal，打开 B：
 *    journal_mode 变回 wal、行数从 500 变 520、`PRAGMA integrity_check` 仍然报 "ok"。
 *    也就是说一次「目标目录里上次恢复留了个 -wal」的普通事故，会得到一份
 *    **通过了完整性检查、内容却不是那个备份**的库，而且没有任何一层会报。
 *    所以 restoreBackup 必须先把目标旁边的 -wal / -shm 清掉，再复制主文件。
 *
 * ── 备份不替代审计 ────────────────────────────────────────────────────
 * 规格 §6.5 末段：备份是灾难恢复，回放依赖 events 表的完整性，两者独立。
 * 本模块因此【不】试图判断「这份备份是不是审计完整」—— 那是 src/db/integrity.ts 的活。
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join } from "node:path";
import { openSnapshotReadonlyDb } from "./pragmas.js";

/** 规格 §6.5：保留最近 7 份。改动它属于改运维口径，不在这里单方面调。 */
export const KEEP_BACKUPS = 7;

/** 备份文件名字符串的前缀，规格 §6.5 逐字 `opc-`。 */
export const BACKUP_PREFIX = "opc-";

/** 备份文件后缀。清理旧备份时只认这个后缀（见 pruneBackups 的白名单判据）。 */
export const BACKUP_SUFFIX = ".db";

/**
 * 备份文件名的完整形状：`opc-<ISO 时间戳，冒号与点换成 ->.db`。
 *
 * 例：`opc-2026-11-12T03-04-05-123Z.db`。
 * 三条性质，逐条有断言（backup.test.ts ①）：
 *  - **字典序 == 时间序**：UTC ISO 从左到右是「年-月-日T时:分:秒-毫秒Z」，
 *    高位在前，所以 sort() 的结果就是时间序。保留策略靠这一条，不靠 mtime
 *    （mtime 会被 cp / rsync / git checkout 改掉，一次复制就把最旧的排到最后）。
 *  - **同一毫秒之内唯一**：见 nextBackupPath。
 *  - **只有这一种形状能被删**：见 pruneBackups。多一个字符就不是备份。
 */
const BACKUP_NAME =
  /^opc-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db$/u;

/** 时间戳 → 文件名。分隔符全部避开 `:` 与 `.`，它们在文件名里的含义各处不一致。 */
export function backupName(nowMs: number): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError(
      "backupName 需要一个非负整数毫秒时间戳（得到 " + String(nowMs) + "）。",
    );
  }
  return (
    BACKUP_PREFIX +
    new Date(nowMs).toISOString().replace(/:/gu, "-").replace(/\./gu, "-") +
    BACKUP_SUFFIX
  );
}

/** 这个名字是不是本模块产出的备份名。 */
export function isBackupName(name: string): boolean {
  return BACKUP_NAME.test(name);
}

/**
 * 备份根目录。规格 §6.5 写 `~/.opc-os/backups/`。
 *
 * 与 evidence/store.ts 的 artifactsRoot 同一条纪律：**生产入口用，测试不要用它**。
 * 备份是【写盘 + 删盘】的模块，测试若靠 env 覆盖路径，忘设 env 的那一次就会
 * 去删真实用户 ~/.opc-os/backups 里的文件 —— 那是「删掉唯一的灾难恢复」级别的错。
 * 所以 backupDir 在 BackupRequest 里是必填的，忘了传是编译不过，而不是写错地方。
 */
export function backupsRoot(home = defaultHome()): string {
  return join(home, ".opc-os", "backups");
}

function defaultHome(): string {
  const h = process.env["HOME"];
  if (h === undefined || h.trim() === "") {
    throw new Error(
      "取不到 HOME，无法定位备份根目录 ~/.opc-os/backups。显式传 backupDir，" +
        "不要退回 cwd —— 那会把备份写进仓库工作区，还可能被清理逻辑当旧备份删掉。",
    );
  }
  return h;
}

/** 失败原因枚举。告警文案要能按这一维分组（备份静默失败等于没有备份）。 */
export const BACKUP_FAILURE_REASONS = [
  "source_missing",
  "name_collision",
  "vacuum_failed",
  "verify_failed",
] as const;
export type BackupFailureReason = (typeof BACKUP_FAILURE_REASONS)[number];

export type BackupRequest = {
  /** 源库文件路径。必须已存在（不存在的库备份出来是个空文件，那是假备份）。 */
  readonly dbPath: string;
  /** 备份目录。必填，理由见 backupsRoot。不存在会创建。 */
  readonly backupDir: string;
  readonly now?: () => number;
  /**
   * 失败告警回调。**不传就是静默失败**，而计划 Task 6.3 的验收写的正是
   * 「备份失败必须告警（备份静默失败等于没有备份）」。
   * 所以这里不给你一个「可选、默认什么都不做」的舒适形状：调用方必须
   * 显式传 onWarning，或者显式传 `onWarning: () => {}` 表示「我知道我在关掉告警」。
   */
  readonly onWarning: (message: string) => void;
  /** 保留份数，默认 KEEP_BACKUPS。 */
  readonly keep?: number;
};

export type BackupOk = {
  readonly ok: true;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  /** 备份里 events 的行数。审计是否完整由 integrity.ts 判，这里只报数。 */
  readonly eventsInBackup: number;
  /** 做快照那一刻之后源库的 events 行数。备份期间的写入会让它更大，那是正常的。 */
  readonly eventsInSourceNow: number;
  /** 真正被清理掉的旧备份路径。 */
  readonly pruned: readonly string[];
  readonly createdAtMs: number;
};

export type BackupFailed = {
  readonly ok: false;
  readonly reason: BackupFailureReason;
  readonly message: string;
  /** 已经落盘但没通过校验的文件路径（有的话）。校验失败的半成品【不会】留在目录里。 */
  readonly partialPath?: string;
};

export type BackupResult = BackupOk | BackupFailed;

/**
 * 打开源库做只读快照时用的连接。
 *
 * 单独成函数是为了下面那条「备份期间写入不失败」的用例能拿到同一条通路，
 * 而不是测试自己另开一条连接测另一件事。
 *
 * 用的是快照形打开（跳过 journal_mode）而不是 openReadonlyDb：备份的源
 * 【可以就是一份刚恢复出来、还没被 hub 按生产方式打开过的文件】，
 * 那种文件是 delete 模式，openReadonlyDb 会在设 WAL 时抛
 * "attempt to write a readonly database"（见 pragmas.ts 那条注释的实测）。
 * 对活库（WAL）而言跳过那一条没有任何差别 —— journal_mode 是持久设置，
 * 库已经是 WAL，那一发 PRAGMA 本来也只是重述现状。
 */
function openSourceForSnapshot(dbPath: string): DatabaseSync {
  return openSnapshotReadonlyDb(dbPath);
}

/** 唯一文件名：同一毫秒内撞上了就往后挪 1ms 再试（最多 1000 次，之后如实报错）。 */
function nextBackupPath(backupDir: string, nowMs: number): { path: string; atMs: number } {
  let at = nowMs;
  for (let i = 0; i < 1000; i++) {
    const path = join(backupDir, backupName(at));
    if (!existsSync(path)) return { path, atMs: at };
    at += 1;
  }
  throw new Error(
    "在 " +
      backupDir +
      " 里连续 1000 毫秒都有同名备份，放弃取名。这不像【同一毫秒两次备份】，" +
      "更像目录里堆了上百个来自同一时刻的文件 —— 先人工看目录，不要改这段逻辑。",
  );
}

function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function countEvents(db: DatabaseSync): number {
  // 表可能不存在（还没跑过迁移的库）。这时报 0 而不是抛：
  // 「备份一个空库」是可以的，「备份一个 schema 不认识的库」也应当留下文件让人看，
  // 而不是在备份这一步就把唯一可用的灾难恢复路径堵死。
  const has = db
    .prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'events'")
    .get() as { c: number | bigint };
  if (Number(has.c) === 0) return 0;
  const row = db.prepare("SELECT count(*) AS c FROM events").get() as {
    c: number | bigint;
  };
  return Number(row.c);
}

/**
 * 一次备份：VACUUM INTO → 打开产物验 integrity_check → 按名字保留最近 N 份。
 *
 * 三条判据，各挡一种「看起来成功的假备份」：
 *  1. **产物必须能用另一条只读连接打开并通过 `PRAGMA integrity_check`**（计划
 *     Task 6.3 Test 第一条）。VACUUM INTO 自己返回成功不代表文件可用 ——
 *     磁盘满、目录权限、以及「拷出去的是一份截断的壳」都在这一步现形。
 *  2. **校验不过就必须把文件删掉**，并把 partialPath 报出去。留着一个不合格的
 *     `.db` 在备份目录里，等于给下一次的 restoreBackup 准备一份诱饵。
 *  3. **任何失败都走 onWarning**。返回值 ok:false 之外再调一次告警，是因为
 *     调用方（未来的定时任务）很可能只 await 不看结果 —— 而它不看结果的这件事
 *     本身，就是这条验收存在的原因。
 */
export function createBackup(o: BackupRequest): BackupResult {
  const now = o.now ?? Date.now;
  const keep = o.keep ?? KEEP_BACKUPS;

  if (!existsSync(o.dbPath)) {
    const msg = "备份失败：源库文件不存在 —— " + o.dbPath;
    o.onWarning(msg);
    return { ok: false, reason: "source_missing", message: msg };
  }
  if (!Number.isSafeInteger(keep) || keep < 1) {
    throw new TypeError(
      "keep 必须是 >= 1 的整数（得到 " + String(keep) + "）。keep = 0 意味着每次备份" +
        "都把自己删掉 —— 那不是「不留备份」，那是「每次备份完都以为留了一份」。",
    );
  }

  mkdirSync(o.backupDir, { recursive: true });
  const createdAtMs = now();
  let path: string;
  let stampMs: number;
  try {
    const picked = nextBackupPath(o.backupDir, createdAtMs);
    path = picked.path;
    stampMs = picked.atMs;
  } catch (e) {
    const msg = "备份失败：取不到唯一文件名 —— " + String(e);
    o.onWarning(msg);
    return { ok: false, reason: "name_collision", message: msg };
  }

  // 快照。只读连接、不占写队列（文件头实测第 2 条）。
  let source: DatabaseSync | null = null;
  try {
    source = openSourceForSnapshot(o.dbPath);
    // VACUUM INTO 是语句不是函数，不能带绑定参数以外的形式；这里用 prepare 绑定路径，
    // 是为了路径里的单引号不需要自己做转义（备份目录来自配置，不是常量）。
    source.prepare("VACUUM INTO ?").run(path);
  } catch (e) {
    const msg = "备份失败：VACUUM INTO 抛错 —— " + String(e);
    o.onWarning(msg);
    // 半途失败也可能留下文件（实测本机会抛 "output file already exists"，
    // 但磁盘满这类失败留不留半成品不保证）。留下就删掉，别留诱饵。
    const partial = existsSync(path) ? path : undefined;
    if (partial !== undefined) {
      try {
        rmSync(partial);
      } catch {
        /* 删不掉也要先把失败如实报出去，partialPath 指向它 */
      }
    }
    source?.close();
    return {
      ok: false,
      reason: "vacuum_failed",
      message: msg,
      ...(partial === undefined ? {} : { partialPath: partial }),
    };
  }
  source.close();

  // 校验产物。开一条 SQLite 连接而不是 fs.readFile：要验的是「SQLite 能不能用它」，
  // 读字节只能证明文件非空。
  let eventsInBackup: number;
  try {
    const probe = openSnapshotReadonlyDb(path);
    try {
      const rows = probe.prepare("PRAGMA integrity_check").all() as {
        integrity_check: string;
      }[];
      const verdict = rows.map((r) => r.integrity_check).join("; ");
      if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
        const msg =
          "备份失败：产物未通过 integrity_check（" +
          path +
          " → " +
          verdict.slice(0, 200) +
          "）。这份不能用来恢复。";
        o.onWarning(msg);
        // 先记下路径再删。留着它比删掉更危险，所以动作是删；路径进告警文案，
        // 需要人工看一眼的时候人知道去哪儿找（删掉的文件的 partialPath 反而误导）。
        try {
          rmSync(path);
        } catch {
          /* 同上 */
        }
        return {
          ok: false,
          reason: "verify_failed",
          message: msg,
          ...(existsSync(path) ? { partialPath: path } : {}),
        };
      }
      eventsInBackup = countEvents(probe);
    } finally {
      probe.close();
    }
  } catch (e) {
    const msg = "备份失败：产物打不开 —— " + path + "：" + String(e);
    o.onWarning(msg);
    return { ok: false, reason: "verify_failed", message: msg };
  }

  // 源库此刻的行数（备份之后可能又写了几个）。只报数，不判失败 ——
  // 「备份比源少」在 WAL 下是常态而不是缺陷。
  let eventsInSourceNow = eventsInBackup;
  try {
    const live = openSourceForSnapshot(o.dbPath);
    try {
      eventsInSourceNow = countEvents(live);
    } finally {
      live.close();
    }
  } catch {
    /* 读不到源库不影响这份备份已经成立这件事；报成备份里那个数即可 */
  }

  let pruned: readonly string[] = [];
  try {
    pruned = pruneBackups({ backupDir: o.backupDir, keep });
  } catch (e) {
    // 保留策略失败【不改写备份的成败】：这一份已经验过了，是可用的一份备份。
    // 把它报成 ok:false 会让调用方再去备份一次，于是目录越堆越厚 ——
    // 而那正是保留策略要防的事。所以这是告警，不是失败。
    o.onWarning(
      "备份成功但清理旧备份失败（目录会超出 " +
        keep +
        " 份）—— " +
        String(e),
    );
  }

  return {
    ok: true,
    path,
    bytes: statSync(path).size,
    sha256: sha256OfFile(path),
    eventsInBackup,
    eventsInSourceNow,
    pruned,
    createdAtMs: stampMs,
  };
}

export type PruneRequest = {
  readonly backupDir: string;
  readonly keep?: number;
};

/**
 * 只保留最近 keep 份，其余删掉，返回被删的路径。
 *
 * 三条判据：
 *  - **只删名字匹配 BACKUP_NAME 的文件**。备份目录里可能有别人的东西
 *    （手工拷进去的旧库、临时下载），一次 glob("*.db*") 就能把它们一起删掉。
 *  - **排序按名字，不按 mtime**。理由见 backupName 第一条性质。
 *  - **keep 之内的一份都不动**，包括「刚刚做出来的那一份」（它排在最后）。
 *    删完自己是一个很容易写错的方向：排序方向搞反就是每备份一次删掉最新那份。
 */
export function pruneBackups(o: PruneRequest): readonly string[] {
  const keep = o.keep ?? KEEP_BACKUPS;
  if (!Number.isSafeInteger(keep) || keep < 1) {
    throw new TypeError("keep 必须是 >= 1 的整数（得到 " + String(keep) + "）。");
  }
  if (!existsSync(o.backupDir)) return [];
  const names = readdirSync(o.backupDir)
    .filter((n) => isBackupName(n))
    .sort();
  const doomed = names.slice(0, Math.max(0, names.length - keep));
  const deleted: string[] = [];
  for (const n of doomed) {
    const p = join(o.backupDir, n);
    rmSync(p);
    deleted.push(p);
  }
  return deleted;
}

/** 目录里现有的备份，按时间序（旧 → 新）。 */
export function listBackups(backupDir: string): readonly string[] {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((n) => isBackupName(n))
    .sort()
    .map((n) => join(backupDir, n));
}

export const RESTORE_FAILURE_REASONS = [
  "backup_missing",
  "backup_unverified",
  "target_exists",
] as const;
export type RestoreFailureReason = (typeof RESTORE_FAILURE_REASONS)[number];

export type RestoreRequest = {
  readonly backupPath: string;
  /** 恢复落点。已存在时必须 confirmOverwrite = true，否则拒绝（见下）。 */
  readonly targetPath: string;
  /**
   * 确认覆盖一个已存在的目标库。
   *
   * 默认不给就把目标文件覆盖了，是把「恢复」这个动作的代价压给了下一次误操作：
   * 目标库里可能有【比备份更新】的事件，而 events 是 append-only —— 覆盖掉就没了，
   * 而且恢复动作本身不留审计（恢复是文件系统操作，写不进那个正要被覆盖的库）。
   */
  readonly confirmOverwrite?: boolean;
};

export type RestoreResult =
  | {
      readonly ok: true;
      readonly targetPath: string;
      readonly events: number;
      readonly sha256: string;
      /** 被清掉的目标旁边的陈旧 -wal / -shm。空数组意味着旁边本来干净。 */
      readonly removedSidecars: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: (typeof RESTORE_FAILURE_REASONS)[number];
      readonly message: string;
    };

/**
 * 恢复演练用的恢复动作：把一份备份变成一个可用的库文件。
 *
 * 计划 Task 6.3 的 Test 是「从备份恢复后能 hub resume 继续跑未完成任务」。
 * 那一条的【端到端】那一半需要 @langchain/*（本机装不上，见 0018 §6），
 * 本函数交付的是它的前半：恢复出来的文件必须【能打开、完整性过、行数与备份一致、
 * append-only 触发器与 FTS 仍在】。后半登记为缺口，并在 backup.test.ts ⑤
 * 里钉成一条断言（接线那天会红）。
 *
 * 顺序不能换：**先清旁边的 -wal / -shm，再复制主文件**。反过来的话，
 * 复制完成到清理之间有任何一次打开该文件的动作（杀软、索引器、上一个连接），
 * 就可能按文件头实测第 3 条那个形状得到一份「完整性检查通过而内容不是这个备份」的库。
 */
export function restoreBackup(o: RestoreRequest): RestoreResult {
  if (!existsSync(o.backupPath)) {
    return {
      ok: false,
      reason: "backup_missing",
      message: "恢复失败：备份文件不存在 —— " + o.backupPath,
    };
  }
  if (!isBackupName(basename(o.backupPath))) {
    return {
      ok: false,
      reason: "backup_unverified",
      message:
        "恢复失败：文件名不是本模块产出的备份名 —— " +
        basename(o.backupPath) +
        "。恢复是一个会覆盖现网库的动作，不接受【看起来像备份】的文件；" +
        "要用手工拷的文件恢复，就把它重命名成备份的形状（这是刻意的摩擦，不是校验过严）。",
    };
  }
  // 恢复之前先把备份自己验一遍。理由：备份文件躺在磁盘上六年，期间可以坏
  // （位翻转、被截断、被同步盘改过）。用一份坏备份去覆盖好库，是把一次故障变成事故。
  let eventsInBackup: number;
  try {
    const probe = openSnapshotReadonlyDb(o.backupPath);
    try {
      const rows = probe.prepare("PRAGMA integrity_check").all() as {
        integrity_check: string;
      }[];
      if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
        return {
          ok: false,
          reason: "backup_unverified",
          message:
            "恢复失败：备份自身未通过 integrity_check —— " +
            rows.map((r) => r.integrity_check).join("; ").slice(0, 200),
        };
      }
      eventsInBackup = countEvents(probe);
    } finally {
      probe.close();
    }
  } catch (e) {
    return {
      ok: false,
      reason: "backup_unverified",
      message: "恢复失败：备份打不开 —— " + String(e),
    };
  }

  if (existsSync(o.targetPath) && o.confirmOverwrite !== true) {
    return {
      ok: false,
      reason: "target_exists",
      message:
        "恢复被拒绝：目标库已存在 —— " +
        o.targetPath +
        "。恢复会覆盖它，而 events 是 append-only，覆盖掉的那部分【找不回来】。" +
        "确认要覆盖就显式传 confirmOverwrite: true（或者先把目标库改名留一份）。",
    };
  }

  mkdirSync(dirname(o.targetPath), { recursive: true });
  const removedSidecars: string[] = [];
  for (const suffix of ["-wal", "-shm"]) {
    const p = o.targetPath + suffix;
    if (existsSync(p)) {
      rmSync(p);
      removedSidecars.push(p);
    }
  }
  copyFileSync(o.backupPath, o.targetPath);

  // 复制完再验一次目标。备份自己是好的 ≠ 落地的这一份是好的（磁盘满会写出半截文件，
  // 而 copyFileSync 在 ENOSPC 时抛之前可能已经写了部分字节）。
  try {
    const after = openSnapshotReadonlyDb(o.targetPath);
    try {
      const rows = after.prepare("PRAGMA integrity_check").all() as {
        integrity_check: string;
      }[];
      if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
        return {
          ok: false,
          reason: "backup_unverified",
          message:
            "恢复后完整性检查未通过（目标 " +
            o.targetPath +
            " → " +
            rows.map((r) => r.integrity_check).join("; ").slice(0, 200) +
            "）。目标可能是半截文件，不要拿它跑任何写操作。",
        };
      }
      const eventsNow = countEvents(after);
      if (eventsNow !== eventsInBackup) {
        return {
          ok: false,
          reason: "backup_unverified",
          message:
            "恢复后 events 行数与备份不一致（备份 " +
            eventsInBackup +
            "，目标 " +
            eventsNow +
            "）。两侧都通过了 integrity_check，所以这不是格式坏掉，" +
            "而是【落地内容与备份不是同一份东西】—— 检查同目录的 -wal（见 0018 §1 第 3 条）。",
        };
      }
    } finally {
      after.close();
    }
  } catch (e) {
    return {
      ok: false,
      reason: "backup_unverified",
      message: "恢复后打不开目标 —— " + String(e),
    };
  }

  return {
    ok: true,
    targetPath: o.targetPath,
    events: eventsInBackup,
    sha256: sha256OfFile(o.targetPath),
    removedSidecars,
  };
}

/**
 * 一次「恢复演练」：备份 → 恢复到临时目标 → 验完整性，并给出可读结论。
 *
 * 计划把恢复演练写成 Test 而不是文档，理由是【没演练过的恢复等于没有备份】：
 * 备份成功只证明能拷出去，恢复成功才证明拷回来还能用。这个函数把两侧串起来，
 * 于是生产入口可以定期跑它（Task 6.5 那一周试运行要巡检「备份成功」就是这一条）。
 */
export function restoreDrill(o: {
  readonly dbPath: string;
  readonly backupDir: string;
  readonly drillTargetPath: string;
  readonly onWarning: (m: string) => void;
  readonly now?: () => number;
  readonly keep?: number;
}): {
  readonly backup: BackupResult;
  readonly restore: RestoreResult;
  readonly ok: boolean;
} {
  const backup = createBackup({
    dbPath: o.dbPath,
    backupDir: o.backupDir,
    ...(o.now === undefined ? {} : { now: o.now }),
    onWarning: o.onWarning,
    ...(o.keep === undefined ? {} : { keep: o.keep }),
  });
  if (!backup.ok) {
    return { backup, restore: { ok: false, reason: "backup_missing", message: "备份这一步就失败了，没有可恢复的文件" }, ok: false };
  }
  // 演练目标必须【每次都干净】：上一次演练留下的 -wal 会让这一次读到上一次的库
  // （文件头实测第 3 条）。restoreBackup 自己会清 sidecar，但主文件覆盖需要确认，
  // 而演练目标是本函数自己拥有的临时文件，覆盖它是本函数的职责而不是使用者的决定。
  if (existsSync(o.drillTargetPath)) {
    rmSync(o.drillTargetPath);
  }
  const restore = restoreBackup({
    backupPath: backup.path,
    targetPath: o.drillTargetPath,
    confirmOverwrite: true,
  });
  if (!restore.ok) {
    o.onWarning("恢复演练失败：" + restore.message);
  }
  return { backup, restore, ok: backup.ok && restore.ok };
}
