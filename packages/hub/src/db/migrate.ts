import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

/**
 * Task 0.5　迁移框架（规格 §6.1、附录 C；计划要求 pnpm migrate 对已应用迁移是 no-op）。
 *
 * 幂等由【版本表】实现，不是靠给 DDL 加 IF NOT EXISTS：
 * 「IF NOT EXISTS 然后继续」会把 schema 与版本记录的分叉留在库里 —— 比如有人手动改过
 * 表、或 schema_migrations 被误删，此时静默跳过意味着此后所有迁移都以为库是新的。
 * 让重复执行报 "table already exists" 是有意的：炸出来，才知道要修的是版本记录。
 */

/** 迁移 SQL 所在目录（packages/hub/resources/migrations）。 */
export const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "resources",
  "migrations",
);

/** 文件名必须是 4 位数字前缀 + 小写下划线名，例如 0001_init.sql。 */
const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/u;

export interface MigrateOptions {
  /** 覆盖迁移目录，仅测试用（验证失败回滚时要塞自造 SQL 进去）。 */
  dir?: string;
}

export interface MigrateResult {
  /** 本次真正应用的迁移版本，按应用顺序。 */
  applied: string[];
  /** 之前已应用、本次跳过的版本。 */
  alreadyApplied: string[];
}

interface MigrationFile {
  version: string;
  path: string;
}

function assertUsableDir(dir: string): MigrationFile[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(
      "迁移目录不存在或不可读：" +
        dir +
        "。宁可抛错也不要静默应用 0 个迁移 —— 后者会让库一张表都没有而 migrate 仍返回" +
        "成功，故障推迟到第一次写入才暴露。",
    );
  }
  // 排序即应用顺序：靠 4 位数字前缀保证字典序 == 数字序。不用 mtime —— 打包后会变。
  const names = readdirSync(dir)
    .filter((n) => n.endsWith(".sql"))
    .sort();
  const files: MigrationFile[] = [];
  for (const name of names) {
    if (!MIGRATION_NAME.test(name)) {
      throw new Error(
        "迁移文件名不合规：" +
          name +
          "。要求形如 0001_init.sql（4 位数字前缀 + 小写下划线）。应用顺序由文件名字典序" +
          "决定，命名自由就会让应用顺序自由。",
      );
    }
    files.push({ version: name.replace(/\.sql$/u, ""), path: join(dir, name) });
  }
  return files;
}

function ensureVersionTable(db: DatabaseSync): void {
  // 这条 DDL 必须在【事务外】且自带 IF NOT EXISTS：它就是幂等的判据本身，
  // 不能由自己来记版本（鸡生蛋问题）。
  db.exec(
    [
      "CREATE TABLE IF NOT EXISTS schema_migrations (",
      "  version     TEXT PRIMARY KEY,",
      "  applied_at  INTEGER NOT NULL",
      ");",
    ].join("\n"),
  );
}

function appliedVersions(db: DatabaseSync): string[] {
  return (
    db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as {
      version: string;
    }[]
  ).map((r) => r.version);
}

function applyOne(db: DatabaseSync, file: MigrationFile): void {
  const sql = readFileSync(file.path, "utf8");
  // 事务内改 WAL 模式会抛 "cannot change into wal mode from within a transaction"，
  // 且报错点离真正的因由（迁移脚本里混进了连接级 PRAGMA）很远 —— 在这里显式拦住。
  // 0001_init.sql 已由 scripts/extract-appendix-c.mjs 把 PRAGMA 剥掉；这条是给以后
  // 新增迁移用的护栏。
  if (/^\s*PRAGMA\s+journal_mode/imu.test(sql)) {
    throw new Error(
      file.version +
        " 含 PRAGMA journal_mode：迁移整体包事务，而事务内改 journal_mode 会抛错。" +
        "连接级设置请放 src/db/pragmas.ts。",
    );
  }

  // BEGIN IMMEDIATE：与写队列、txScope 同一套取锁语义（decisions/0003 §3.1）。
  // 整个文件一次 exec —— 逐句按分号切会切进 CREATE TRIGGER 的 BEGIN…END 体，
  // 那是实测过的错误做法（附录 C 就有 5 个触发器）。
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(sql);
    db.prepare(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    ).run(file.version, Date.now());
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* SQLite 可能已自行中止事务；不能让它盖掉原始错误 */
    }
    throw new Error(
      "迁移 " +
        file.version +
        " 失败并已回滚（库保持迁移前状态）：" +
        String((e as Error).message),
      { cause: e },
    );
  }
}

/**
 * 应用所有尚未应用的迁移；已应用的静默跳过（no-op）。
 * 这是 pnpm migrate 每次启动都能安全重跑的前提。
 */
export function migrate(
  db: DatabaseSync,
  opts: MigrateOptions = {},
): MigrateResult {
  const dir = opts.dir ?? MIGRATIONS_DIR;
  const files = assertUsableDir(dir);
  ensureVersionTable(db);

  const done = new Set(appliedVersions(db));
  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  for (const file of files) {
    if (done.has(file.version)) {
      alreadyApplied.push(file.version);
      continue;
    }
    applyOne(db, file);
    applied.push(file.version);
  }
  return { applied, alreadyApplied };
}
