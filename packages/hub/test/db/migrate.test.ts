import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrate } from "../../src/db/migrate.js";

/**
 * Task 0.5　迁移框架。
 *
 * 幂等在这里不是便利，是运维前提：Hub 每次启动都会跑 migrate，
 * 「第二次报 table already exists」等于每次重启都要人工介入。
 */

const HUB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TMP = join(HUB, ".tmp", "migrate");

type Db = {
  prepare: (sql: string) => {
    all: (...a: unknown[]) => Record<string, unknown>[];
  };
  exec: (sql: string) => void;
  close: () => void;
};

const opened: Db[] = [];
let seq = 0;

async function open(): Promise<{ db: Db; path: string }> {
  const { openDb } = await import("../../src/db/driver.js");
  const path = join(TMP, "mig-" + process.pid + "-" + ++seq + ".db");
  const db = openDb(path) as unknown as Db;
  opened.push(db);
  return { db, path };
}

/** 读 sqlite_master 里全部对象的规范化签名，用于比较两次独立迁移的结果。 */
function signature(db: Db): string[] {
  return (
    db
      .prepare(
        "SELECT type, name, sql FROM sqlite_master " +
          "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all() as { type: string; name: string; sql: string | null }[]
  ).map(
    (r) =>
      r.type + "|" + r.name + "|" + (r.sql ?? "").replace(/\s+/gu, " ").trim(),
  );
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  // Windows：不 close 就 rm 会 EBUSY
  for (const db of opened) {
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
  }
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

it("迁移目录能扫到文件：扫不到必须抛错，而不是静默应用 0 个", async () => {
  const { db } = await open();
  const res = migrate(db);
  // 元守卫：目录路径或文件名匹配写错时，migrate 会「成功应用 0 个」并全绿 ——
  // 那正是最危险的失效方式：库里一张表都没有，测试却全过。
  expect(res.applied.length, "一个迁移都没应用 = 扫描失效").toBeGreaterThan(0);
  expect(res.applied).toContain("0001_init");
  expect(MIGRATIONS_DIR).toContain(join("hub", "resources"));
});

it("迁移目录不存在时抛错（不静默跳过）", async () => {
  const { db } = await open();
  expect(() => migrate(db, { dir: join(TMP, "definitely-not-here") })).toThrow(
    /迁移目录|不存在|unreadable/iu,
  );
});

it("SQL 文件里声明的每张表都真的建成了（文件与库对账）", async () => {
  const { db } = await open();
  migrate(db);
  const sql = readFileSync(join(MIGRATIONS_DIR, "0001_init.sql"), "utf8");
  const declared = [
    ...sql.matchAll(/CREATE (?:VIRTUAL )?TABLE(?: IF NOT EXISTS)? (\w+)/giu),
  ].map((m) => m[1] as string);
  // 元守卫：正则失效会让 declared 变空，下面的 for 就成了空循环而全绿
  expect(
    declared.length,
    "从 SQL 文件提取到的表名太少 = 正则失效",
  ).toBeGreaterThanOrEqual(17);

  const actual = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = ?")
        .all("table") as {
        name: string;
      }[]
    ).map((r) => r.name),
  );
  const missing = declared.filter((t) => !actual.has(t));
  expect(missing, "声明了但没建出来的表：" + missing.join(", ")).toEqual([]);
});

it("foreign_key_check 无输出（附录 C 的 trust_scores 外键必须已修）", async () => {
  const { db } = await open();
  migrate(db);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it("pnpm migrate 对已应用迁移是 no-op（幂等）", async () => {
  const { db } = await open();
  const first = migrate(db);
  const second = migrate(db);
  expect(second.applied, "第二次必须什么都不应用").toEqual([]);
  expect(second.alreadyApplied).toEqual(first.applied);
  // 第三次也不许报 table already exists —— 幂等不是只测两次
  expect(migrate(db).applied).toEqual([]);
});

it("删库重建可重放：两次独立迁移产出完全相同的 schema", async () => {
  const a = await open();
  const b = await open();
  migrate(a.db);
  migrate(b.db);
  expect(signature(b.db)).toEqual(signature(a.db));
});

it("schema_migrations 记录版本与 Unix 毫秒时间戳", async () => {
  const { db } = await open();
  migrate(db);
  const rows = db
    .prepare(
      "SELECT version, applied_at FROM schema_migrations ORDER BY version",
    )
    .all() as { version: string; applied_at: number }[];
  // 版本清单【硬编码】而不是从目录扫出来再比对自己 —— 扫出来比对等于永远通过，
  // 这一维要拦的恰恰是「多了一个迁移却没人核对过它该不该存在」。
  // 加新迁移时必须同时改这一行，这是刻意的摩擦（见 test/arch 的同类立场）。
  expect(rows.map((r) => r.version)).toEqual([
    "0001_init",
    "0002_phase1_evidence_and_budget",
    "0003_patrol_event_index",
  ]);
  // applied_at 必须是 Unix 毫秒整数：审计要能还原「这张表什么时候建的」
  for (const r of rows) {
    expect(Number.isInteger(r.applied_at)).toBe(true);
    expect(r.applied_at).toBeGreaterThan(1_600_000_000_000);
  }
});

it("迁移中途失败不留半套表：整体回滚且不登记版本", async () => {
  const { db } = await open();
  const dir = join(TMP, "broken-" + process.pid + "-" + ++seq);
  mkdirSync(dir, { recursive: true });
  // 同一个 CREATE TABLE 名写两遍 → 第二条必然失败
  writeFileSync(
    join(dir, "0001_broken.sql"),
    "CREATE TABLE ok_first (x INTEGER); CREATE TABLE ok_first (y INTEGER);",
    "utf8",
  );
  expect(() => migrate(db, { dir })).toThrow(/already exists/iu);

  const left = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = ?")
      .all("table") as {
      name: string;
    }[]
  ).map((r) => r.name);
  expect(left, "失败迁移的第一条语句必须被回滚").not.toContain("ok_first");

  const versions = (
    db.prepare("SELECT version FROM schema_migrations").all() as {
      version: string;
    }[]
  ).map((r) => r.version);
  expect(versions, "失败的迁移不得登记为已应用").not.toContain("0001_broken");
});

// —— 以下两条守卫生的是【以后的迁移文件】，不是 0001_init.sql ——
// 0001 已经由 scripts/extract-appendix-c.mjs 保证不含 PRAGMA、文件名也合规，
// 所以这两条在今天的仓库里【永远不会因为 0001 而失败】。它们防的是半年后
// 某人新增 0002_xxx.sql 时犯的两个错，而那两种错一旦犯下都很难查：
//   ① 文件名不合规 → readdir 扫不到 → 静默应用 0 个迁移，表压根没建；
//   ② 迁移里写 PRAGMA journal_mode → 迁移整体包事务 → 事务内改 WAL 直接抛错，
//      而且报错点离真正的因由（连接级 PRAGMA 不该出现在迁移里）非常远。

it("迁移目录里有不合命名的 .sql 必须抛错，不许静默忽略", async () => {
  const dir = join(TMP, "badname-" + process.pid);
  mkdirSync(dir, { recursive: true });
  // 连字符不符合 ^\d{4}_[a-z0-9_]+\.sql$ —— 最典型的笔误就是写成 0001-init.sql
  writeFileSync(
    join(dir, "0001-init.sql"),
    "CREATE TABLE t (x INTEGER);",
    "utf8",
  );
  const db = await open();
  expect(() => migrate(db.db as never, { dir })).toThrow(
    /0001-init|命名|不符合|name/iu,
  );
});

it("迁移脚本含 PRAGMA journal_mode 时给出指名 src/db/pragmas.ts 的错误", async () => {
  const dir = join(TMP, "walpragma-" + process.pid);
  mkdirSync(dir, { recursive: true });
  // 实测：事务内改 journal_mode 抛 "cannot change into wal mode from within a transaction"，
  // 那句话完全没提"迁移"或"pragmas.ts"，排查的人会去翻连接代码。
  // 所以要在这里拦下，并把该去的地方写进错误消息。
  writeFileSync(
    join(dir, "0002_wal.sql"),
    ["PRAGMA journal_mode = WAL;", "CREATE TABLE t (x INTEGER);"].join("\n"),
    "utf8",
  );
  const db = await open();
  expect(() => migrate(db.db as never, { dir })).toThrow(/journal_mode/iu);
  let msg = "";
  try {
    migrate(db.db as never, { dir });
  } catch (e) {
    msg = String((e as Error).message);
  }
  expect(msg, "错误消息必须指路：连接级 PRAGMA 属于 pragmas.ts").toMatch(
    /pragmas\.ts/u,
  );
});
