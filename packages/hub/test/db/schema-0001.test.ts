import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureTmp } from "../fixtures/fixture-dir.js";
import { migrate } from "../../src/db/migrate.js";

/**
 * Task 0.5　0001_init.sql 的行为验证：append-only、外键、FTS5 中文检索。
 *
 * 这个文件跑在【真实迁移出来的 schema】上，不是自己造一遍简化表。
 * 理由：简化表会让「迁移文件写错了」和「行为不符合预期」混成一团 ——
 * 之前 driver-preflight 里那条 append-only 测试用的就是手造表，
 * 它证明的是 SQLite 触发器能用，证明不了【我们的】events 表真的免疫 UPDATE。
 */

const TMP = fixtureTmp("schema-0001", import.meta.url);

type Db = {
  prepare: (sql: string) => {
    all: (...a: unknown[]) => Record<string, unknown>[];
    get: (...a: unknown[]) => Record<string, unknown>;
    run: (...a: unknown[]) => unknown;
  };
  exec: (sql: string) => void;
  close: () => void;
};

const opened: Db[] = [];
let seq = 0;

async function migrated(): Promise<Db> {
  const { openDb } = await import("../../src/db/driver.js");
  const db = openDb(
    join(TMP, "s-" + process.pid + "-" + ++seq + ".db"),
  ) as unknown as Db;
  opened.push(db);
  migrate(db);
  return db;
}

function insertEvent(db: Db, payload: string): number {
  const r = db
    .prepare(
      "INSERT INTO events (actor_type, actor_id, action, payload, created_at) " +
        "VALUES ('system', 'hub', 'task_created', ?, 1700000000000)",
    )
    .run(payload) as { lastInsertRowid: number | bigint };
  return Number(r.lastInsertRowid);
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
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

it("events 是 append-only：UPDATE 与 DELETE 都被拦下", async () => {
  const db = await migrated();
  const id = insertEvent(db, '{"note":"初始内容"}');

  // 错误文本来自 RAISE(ABORT, 'events table is append-only')，实测 node:sqlite 下
  // errcode = 1811（SQLITE_CONSTRAINT_TRIGGER），message 就是那句自定义文案。
  // 断言实测值而不是 /immutable/：文案是审计日志里人看到的字，改它要有意识地改。
  for (const [verb, sql] of [
    ["UPDATE", "UPDATE events SET payload = '{}' WHERE id = ?"],
    ["DELETE", "DELETE FROM events WHERE id = ?"],
  ] as const) {
    let caught: unknown;
    try {
      db.prepare(sql).run(id);
    } catch (e) {
      caught = e;
    }
    expect(caught, verb + " 必须被触发器拦下").toBeInstanceOf(Error);
    const err = caught as { message?: string; errcode?: number };
    expect(String(err.message)).toContain("append-only");
    expect(err.errcode, "1811 = SQLITE_CONSTRAINT_TRIGGER").toBe(1811);
  }

  // 拦下之后原行必须完好，INSERT 仍然允许 —— 否则就不是 append-only 而是整表不可写
  const row = db.prepare("SELECT payload FROM events WHERE id = ?").get(id);
  expect(String(row.payload)).toContain("初始内容");
  expect(() => insertEvent(db, '{"note":"追加"}')).not.toThrow();
  expect(Number(db.prepare("SELECT count(*) AS c FROM events").get().c)).toBe(
    2,
  );
});

it("其余 9 个外键仍然有效（防止靠【全删外键】让 foreign_key_check 变绿）", async () => {
  const db = await migrated();
  // 动机：trust_scores 那条外键因指向非唯一列而必须去掉。若实现者图省事把
  // 所有 REFERENCES 都删了，foreign_key_check 一样是空 —— 所以必须反向证明外键还在。
  const violations: string[] = [];
  const cases: Array<[label: string, sql: string]> = [
    [
      "events.task_id",
      "INSERT INTO events (task_id, actor_type, actor_id, action, payload, created_at) VALUES ('nope','system','hub','a','{}',1)",
      [],
    ],
    [
      "tasks.parent_id",
      "INSERT INTO tasks (id, parent_id, title, status, assigned_role, current_node, created_at, updated_at) VALUES ('t1','nope','x','new','r','n',1,1)",
      [],
    ],
    [
      "tasks.charter_id",
      "INSERT INTO tasks (id, charter_id, title, status, assigned_role, current_node, created_at, updated_at) VALUES ('t2','nope','x','new','r','n',1,1)",
      [],
    ],
    [
      "charters.task_id",
      "INSERT INTO charters (id, task_id, business_goal, success_criteria) VALUES ('c1','nope','g','[]')",
      [],
    ],
    [
      "evidence_bundles.task_id",
      "INSERT INTO evidence_bundles (id, task_id, producer_role, bundle_type, artifacts, created_at) VALUES ('e1','nope','r','prd','{}',1)",
      [],
    ],
    [
      "review_gates.task_id",
      "INSERT INTO review_gates (id, task_id, gate_type, reviewer_role) VALUES ('g1','nope','gt','r')",
      [],
    ],
    [
      "review_gates.evidence_bundle_id",
      "INSERT INTO review_gates (id, evidence_bundle_id, gate_type, reviewer_role) VALUES ('g2','nope','gt','r')",
      [],
    ],
    [
      "approvals.task_id",
      "INSERT INTO approvals (id, task_id, approval_type, summary, parameters) VALUES ('a1','nope','charter','s','{}')",
      [],
    ],
    [
      "meetings.task_id",
      "INSERT INTO meetings (id, task_id, meeting_type, participants, created_at) VALUES ('m1','nope','review','[]',1)",
      [],
    ],
  ];
  for (const [label, sql] of cases) {
    try {
      db.prepare(sql).run();
      violations.push(label + "（插入成功了，外键不存在）");
    } catch (e) {
      if (!/FOREIGN KEY/iu.test(String((e as Error).message))) {
        violations.push(
          label +
            "（抛错但不是外键错：" +
            String((e as Error).message).slice(0, 40) +
            "）",
        );
      }
    }
  }
  expect(violations).toEqual([]);
});

it("trust_scores 已不带那条非法外键（去掉 REFERENCES 是有意为之）", async () => {
  const db = await migrated();
  const fks = db.prepare("PRAGMA foreign_key_list(trust_scores)").all();
  expect(
    fks,
    "role_charters(role_id) 不是唯一键，SQLite 不接受这种引用",
  ).toEqual([]);
  // 但角色标识列必须在，且能正常写入（应用层维持引用完整性）
  db.prepare(
    "INSERT INTO trust_scores (role_id, current, components, updated_at) VALUES ('cto', 0.5, '{}', 1)",
  ).run();
  expect(
    Number(db.prepare("SELECT count(*) AS c FROM trust_scores").get().c),
  ).toBe(1);
});

describe("FTS5 中文检索（规格附录 C.3 的活文档）", () => {
  /**
   * 语料必须是【连续中文，词与词之间不能有空格】。
   *
   * 这不是风格问题，是这条测试有没有鉴别力的全部：默认分词器 unicode61 按空白切词，
   * 若写成 "事件通过 全链路 覆盖率"（空格分词），unicode61 会把「覆盖率」当成一个完整
   * token 从而命中 1 —— 于是【漏写 tokenize = 'trigram' 也能全绿】。
   * 实测（本机 SQLite 3.51.2，连续语料）：
   *   trigram:    MATCH '覆盖率' → 1，MATCH '件通' → 0
   *   unicode61:  MATCH '覆盖率' → 0
   * 所以「命中 ≥1」这条断言唯一能区分的就是分词器，正是它存在的理由。
   */
  const CONTIGUOUS = '{"note":"事件通过全链路覆盖率92%"}';

  it("插入 events 后 FTS 影子表同步（content= 外部内容表不会自动同步）", async () => {
    const db = await migrated();
    insertEvent(db, CONTIGUOUS);
    const ev = Number(db.prepare("SELECT count(*) AS c FROM events").get().c);
    const fts = Number(
      db.prepare("SELECT count(*) AS c FROM events_fts").get().c,
    );
    // 两个都必须为 1 且相等：只查 events_fts 的话，影子表被塞进脏数据也发现不了
    expect(ev).toBe(1);
    expect(fts).toBe(ev);
  });

  it("MATCH '覆盖率' 命中 ≥1（这就是漏写 tokenize 会被抓到的那条）", async () => {
    const db = await migrated();
    insertEvent(db, CONTIGUOUS);
    const hit = Number(
      db
        .prepare(
          "SELECT count(*) AS c FROM events_fts WHERE events_fts MATCH ?",
        )
        .get("覆盖率").c,
    );
    expect(hit).toBeGreaterThanOrEqual(1);
  });

  it("MATCH '件通' 命中 0：trigram 需 ≥3 字符，故搜索必须留 LIKE 兜底", async () => {
    const db = await migrated();
    insertEvent(db, CONTIGUOUS);
    expect(
      Number(
        db
          .prepare(
            "SELECT count(*) AS c FROM events_fts WHERE events_fts MATCH ?",
          )
          .get("件通").c,
      ),
    ).toBe(0);
    // 同一条 payload 用 LIKE 能命中 —— 这就是 §C.3 三档策略里「0 命中降级 LIKE」的依据。
    // 语料里刻意含『件通』二字（事件通过 → 件通），否则这条断言毫无意义。
    expect(CONTIGUOUS).toContain("件通");
    expect(
      Number(
        db
          .prepare("SELECT count(*) AS c FROM events WHERE payload LIKE ?")
          .get("%件通%").c,
      ),
    ).toBe(1);
  });

  it("tokenize 属性确实是 trigram（直接读影子表定义，不靠行为反推）", async () => {
    const db = await migrated();
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = ?")
      .get("events_fts");
    expect(String(row.sql)).toMatch(/tokenize\s*=\s*'trigram'/iu);
  });
});
