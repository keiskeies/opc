import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrate } from "../../src/db/migrate.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

/**
 * Task 0.5　迁移框架。
 *
 * 幂等在这里不是便利，是运维前提：Hub 每次启动都会跑 migrate，
 * 「第二次报 table already exists」等于每次重启都要人工介入。
 */

const TMP = fixtureTmp("migrate", import.meta.url);

/**
 * 真类型，不是面子类型（round310 在 test/acceptance 立的先例，
 * 如 rejected-waiver-still-asks.test.ts 的 `World.db: DatabaseSync`）：
 * openDb 的声明返回就是 node:sqlite 的 DatabaseSync，migrate 收的也是它。
 * 原先这里手写一份 { prepare/exec/close } 替身，于是 11 处 `migrate(db)`
 * 全报 TS2345「Db 不能赋给 DatabaseSync」——替身从未与真类型和解过。
 */
type Db = DatabaseSync;

const opened: Db[] = [];
let seq = 0;

async function open(): Promise<{ db: Db; path: string }> {
  const { openDb } = await import("../../src/db/driver.js");
  const path = join(TMP, "mig-" + process.pid + "-" + ++seq + ".db");
  const db = openDb(path);
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

it("0024 给老会议补开场顺序，但不伪造开场时间与下一发言人", async () => {
  const { db } = await open();
  const dir = join(TMP, "meeting-upgrade-" + process.pid + "-" + ++seq);
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name < "0024_")
    .sort()) {
    copyFileSync(join(MIGRATIONS_DIR, name), join(dir, name));
  }
  migrate(db, { dir });
  db.prepare(
    "INSERT INTO meetings (id, meeting_type, participants, created_at)" +
      " VALUES ('legacy-meeting', 'review', ?, ?)",
  ).run('["member-1"]', 1234);
  copyFileSync(
    join(MIGRATIONS_DIR, "0024_meetings_driver.sql"),
    join(dir, "0024_meetings_driver.sql"),
  );
  expect(migrate(db, { dir }).applied).toEqual(["0024_meetings_driver"]);
  expect(
    db
      .prepare(
        "SELECT speaking_order_json, opened_at, next_speaker_member_id FROM meetings WHERE id = ?",
      )
      .get("legacy-meeting"),
  ).toEqual({
    speaking_order_json: '["member-1"]',
    opened_at: 0,
    next_speaker_member_id: null,
  });
});

it("0028 升级旧库保留会话/消息/游标，失败可回滚并拒绝悬空私聊参与者", async () => {
  const { db } = await open();
  const dir = join(TMP, "boss-private-upgrade-" + process.pid + "-" + ++seq);
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name < "0028_" && name.endsWith(".sql"))
    .sort()) {
    copyFileSync(join(MIGRATIONS_DIR, name), join(dir, name));
  }
  migrate(db, { dir });
  for (const id of ["m-a", "m-b"]) {
    db.prepare(
      "INSERT INTO members (member_id, name, role_id, persona_json, model_tier, status, hired_at, updated_at)" +
        " VALUES (?, ?, 'dev', '{}', 'execution', 'active', 1, 1)",
    ).run(id, "Member " + id);
  }
  db.prepare(
    "INSERT INTO conversations (conversation_id, kind, member_a, member_b, title, created_at)" +
      " VALUES ('legacy-private', 'private', 'm-a', 'm-b', 'legacy', 1)",
  ).run();
  db.prepare(
    "INSERT INTO messages (message_id, conversation_id, sender_member_id, author_kind, body, seq_in_conv, created_at)" +
      " VALUES ('legacy-message', 'legacy-private', 'm-a', 'member', 'legacy message', 1, 1)",
  ).run();
  db.prepare(
    "INSERT INTO message_reads (conversation_id, reader, last_seq_in_conv, read_at)" +
      " VALUES ('legacy-private', 'boss', 1, 2)",
  ).run();

  const migrationPath = join(dir, "0028_boss_private_conversations.sql");
  const migrationSql = readFileSync(
    join(MIGRATIONS_DIR, "0028_boss_private_conversations.sql"),
    "utf8",
  );
  writeFileSync(
    migrationPath,
    migrationSql + "\nSELECT * FROM conversations_0028_missing;\n",
    "utf8",
  );
  expect(() => migrate(db, { dir })).toThrow(/0028.*失败并已回滚/iu);
  expect(
    db
      .prepare("SELECT * FROM conversations WHERE conversation_id = ?")
      .get("legacy-private"),
  ).toMatchObject({ member_a: "m-a", member_b: "m-b", title: "legacy" });
  expect(
    db
      .prepare("SELECT body FROM messages WHERE message_id = ?")
      .get("legacy-message"),
  ).toEqual({ body: "legacy message" });
  expect(
    db
      .prepare("SELECT reader FROM message_reads WHERE conversation_id = ?")
      .get("legacy-private"),
  ).toEqual({ reader: "boss" });
  expect(
    (
      db.prepare("PRAGMA foreign_key_list(conversations)").all() as {
        from: string;
      }[]
    )
      .map((row) => row.from)
      .sort(),
  ).toEqual(["group_id", "member_a", "member_b"]);
  expect(
    (
      db
        .prepare("SELECT version FROM schema_migrations WHERE version = ?")
        .get("0028_boss_private_conversations") as
        | { version: string }
        | undefined
    )?.version,
  ).toBeUndefined();

  writeFileSync(migrationPath, migrationSql, "utf8");
  expect(migrate(db, { dir }).applied).toEqual([
    "0028_boss_private_conversations",
  ]);
  expect(
    db
      .prepare("SELECT * FROM conversations WHERE conversation_id = ?")
      .get("legacy-private"),
  ).toMatchObject({ member_a: "m-a", member_b: "m-b", title: "legacy" });
  expect(
    db
      .prepare("SELECT body FROM messages WHERE message_id = ?")
      .get("legacy-message"),
  ).toEqual({ body: "legacy message" });
  expect(
    db
      .prepare("SELECT reader FROM message_reads WHERE conversation_id = ?")
      .get("legacy-private"),
  ).toEqual({ reader: "boss" });
  expect(
    db
      .prepare(
        "SELECT body FROM messages_fts WHERE messages_fts MATCH 'legacy'",
      )
      .all(),
  ).toEqual([{ body: "legacy message" }]);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("PRAGMA defer_foreign_keys").get()).toEqual({
    defer_foreign_keys: 0,
  });
  expect(
    (
      db.prepare("PRAGMA foreign_key_list(conversations)").all() as {
        from: string;
        table: string;
      }[]
    ).map((row) => ({ from: row.from, table: row.table })),
  ).toEqual([{ from: "group_id", table: "groups" }]);
  expect(
    (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index'" +
            " AND tbl_name = 'conversations' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name),
  ).toEqual(["idx_conv_group", "idx_conv_pair"]);

  db.prepare(
    "INSERT INTO conversations (conversation_id, kind, member_a, member_b, title, created_at)" +
      " VALUES ('boss-private', 'private', 'boss', 'm-a', 'boss', 2)",
  ).run();
  for (const [id, a, b] of [
    ["boss-boss", "boss", "boss"],
    ["boss-ghost", "boss", "ghost"],
    ["ghost-member", "ghost", "m-a"],
  ] as const) {
    expect(() =>
      db
        .prepare(
          "INSERT INTO conversations (conversation_id, kind, member_a, member_b, title, created_at)" +
            " VALUES (?, 'private', ?, ?, 'invalid', 3)",
        )
        .run(id, a, b),
    ).toThrow(/private 会话必须/u);
  }
  expect(() =>
    db
      .prepare(
        "UPDATE conversations SET member_b = 'ghost' WHERE conversation_id = 'boss-private'",
      )
      .run(),
  ).toThrow(/private 会话必须/u);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
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
    "0004_approval_card_identity",
    "0005_im_binding_identity",
    "0006_approval_dedup_pending_only",
    "0007_evidence_metrics",
    "0008_approval_evidence_refs",
    "0009_card_delivery_ledger",
    // 0010：中断重放去重（0005 §11 缺陷 A/B 的修复落点）。这条必须与上面那句
    // 「加新迁移时必须同时改这一行」一起改 —— 它就是那道刻意摩擦。
    "0010_interrupt_replay_dedup",
    // 0011–0021：群角色上层（docs/design-2026-11-23-群角色上层-实施计划.md §2）。
    // 顺序按【外键依赖】排，不是按上游功能面排：roles ← members ← groups ←
    // conversations/documents ← meetings(扩列) ← backlog ← plugins ← talent ← rhythm。
    // 换序会让某条 ALTER/CREATE 引用尚未存在的表，foreign_key_check 当轮就红。
    "0011_roles",
    "0012_assets",
    "0013_members",
    "0014_groups",
    "0015_conversations",
    "0016_documents",
    "0017_meetings_real",
    "0018_backlog",
    "0019_plugins",
    "0020_talent_market",
    "0021_rhythm",
    "0022_meetings_topic",
    "0023_message_refs",
    "0024_meetings_driver",
    "0025_cos_dispatch_rules",
    "0026_documents_soft_delete",
    "0027_research_artifacts",
    "0028_boss_private_conversations",
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
  expect(() => migrate(db.db, { dir })).toThrow(/0001-init|命名|不符合|name/iu);
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
  expect(() => migrate(db.db, { dir })).toThrow(/journal_mode/iu);
  let msg = "";
  try {
    migrate(db.db, { dir });
  } catch (e) {
    msg = String((e as Error).message);
  }
  expect(msg, "错误消息必须指路：连接级 PRAGMA 属于 pragmas.ts").toMatch(
    /pragmas\.ts/u,
  );
});
