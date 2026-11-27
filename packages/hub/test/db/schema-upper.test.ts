import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

/**
 * 0011–0021（群角色上层）DDL 层的【行为】验证。
 *
 * 与 schema-0001.test.ts 同一立场：跑在真迁移出来的 schema 上，不是手造简化表 ——
 * 手造表证明的是「SQLite 触发器能用」，证明不了【我们的】roles 表真的免疫 DELETE。
 * 这一篇逐条对着迁移文件里【写进 DDL 的约束】打：文件头声称「不可删/不可改/不可分叉」
 * 的每一条，这里都有一发把它撞出来。约束不测就等于没有（0010 文件头：
 * 注释与校验拦不住的东西，要靠 DDL；DDL 若不测，就退化成另一份注释）。
 */

const TMP = fixtureTmp("schema-upper", import.meta.url);

type Db = DatabaseSync;

const opened: Db[] = [];
let seq = 0;

async function migrated(): Promise<Db> {
  const { openDb } = await import("../../src/db/driver.js");
  const db = openDb(join(TMP, "su-" + process.pid + "-" + ++seq + ".db"));
  opened.push(db);
  migrate(db);
  return db;
}

function count(db: Db, sql: string, ...params: SQLInputValue[]): number {
  const row = db.prepare(sql).get(...params) as
    | { c: number | bigint }
    | undefined;
  return Number(row?.c ?? -1);
}

/** 造一名最小可用成员（多张表外键指向它，测试里反复要用）。 */
function seedMember(db: Db, id: string, roleId = "dev"): void {
  db.prepare(
    "INSERT INTO members (member_id, name, role_id, persona_json, model_tier, tone, status, hired_at, updated_at)" +
      " VALUES (?, ?, ?, '{}', 'execution', 'neutral', 'active', 1, 1)",
  ).run(id, "成员" + id, roleId);
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

describe("0011 roles", () => {
  it("种子 = 完整公司树：13 个内置岗位，树形与 D9 一致", async () => {
    const db = await migrated();
    expect(
      count(db, "SELECT count(*) AS c FROM roles WHERE kind = 'builtin'"),
    ).toBe(13);
    const rows = db
      .prepare(
        "SELECT role_id, reports_to, model_tier FROM roles ORDER BY role_id",
      )
      .all() as {
      role_id: string;
      reports_to: string | null;
      model_tier: string;
    }[];
    const by = new Map(rows.map((r) => [r.role_id, r]));
    // 根与关键挂法（逐条对应上游那棵公司树）
    expect(by.get("boss")?.reports_to).toBeNull();
    expect(by.get("cos")?.reports_to).toBe("boss");
    expect(by.get("product_director")?.reports_to).toBe("cos");
    expect(by.get("tech_director")?.reports_to).toBe("cos");
    expect(by.get("designer")?.reports_to).toBe("product_director");
    expect(by.get("dev")?.reports_to).toBe("tech_director");
    for (const support of ["finance", "hr", "legal", "marketing", "sales"]) {
      expect(
        by.get(support)?.reports_to,
        support + " 必须激活且挂老板下（D9）",
      ).toBe("boss");
    }
    // 档位映射（实施计划 A4）：主持/决策类 = management
    expect(by.get("cos")?.model_tier).toBe("management");
    expect(by.get("dev")?.model_tier).toBe("execution");
  });

  it("内置角色删不掉、降级不掉；自定义角色能删", async () => {
    const db = await migrated();
    expect(() =>
      db.prepare("DELETE FROM roles WHERE role_id = ?").run("boss"),
    ).toThrow(/内置角色不可删除/u);
    expect(() =>
      db
        .prepare("UPDATE roles SET kind = 'custom' WHERE role_id = ?")
        .run("boss"),
    ).toThrow(/不可降级/u);
    // custom 行两头都放行（D9 的另一半；「已卸任」检查在 store 层，不在 DDL）
    db.prepare(
      "INSERT INTO roles VALUES ('c1', '自定义', 'custom', 'support', 'boss', 'execution', NULL, 'c', 1, 1)",
    ).run();
    db.prepare("DELETE FROM roles WHERE role_id = 'c1'").run();
    expect(
      count(db, "SELECT count(*) AS c FROM roles WHERE role_id = 'c1'"),
    ).toBe(0);
  });

  it("角色树的外键真实存在（防止靠删 FK 让种子照样跑通）", async () => {
    const db = await migrated();
    expect(() =>
      db
        .prepare(
          "INSERT INTO roles VALUES ('c2', '环', 'custom', 'support', '不存在的岗位', 'execution', NULL, '', 1, 1)",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/iu);
  });
});

describe("0013 members 四件套", () => {
  it("执行器 kind 的 CHECK 恰好认七种，第八种炸", async () => {
    const db = await migrated();
    seedMember(db, "m1");
    const kinds = [
      "claude-cli",
      "codex-cli",
      "qoder-cli",
      "platform-webhook",
      "builtin-plugin",
      "pure-model",
      "human",
    ];
    for (const [i, k] of kinds.entries()) {
      db.prepare(
        "INSERT INTO member_executors (member_id, seq, kind, config_json) VALUES (?, ?, ?, '{}')",
      ).run("m1", i + 1, k);
    }
    expect(
      count(
        db,
        "SELECT count(*) AS c FROM member_executors WHERE member_id = 'm1'",
      ),
    ).toBe(7);
    expect(() =>
      db
        .prepare(
          "INSERT INTO member_executors VALUES ('m1', 99, 'foo-cli', '{}', 1)",
        )
        .run(),
    ).toThrow(/CHECK constraint/iu);
  });

  it("同一成员同一 seq 只有一条执行器（优先级不可并列）", async () => {
    const db = await migrated();
    seedMember(db, "m2");
    db.prepare(
      "INSERT INTO member_executors VALUES ('m2', 1, 'pure-model', '{}', 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO member_executors VALUES ('m2', 1, 'human', '{}', 1)",
        )
        .run(),
    ).toThrow(/UNIQUE/iu);
  });

  it("hire_events 是 append-only：改与删都炸", async () => {
    const db = await migrated();
    seedMember(db, "m3");
    db.prepare(
      "INSERT INTO hire_events (member_id, action, from_json, to_json, at) VALUES ('m3', 'hired', NULL, '{}', 1)",
    ).run();
    expect(() =>
      db.prepare("UPDATE hire_events SET action = 'archived'").run(),
    ).toThrow(/append-only/u);
    expect(() => db.prepare("DELETE FROM hire_events").run()).toThrow(
      /append-only/u,
    );
  });

  it("成员必须挂在真实角色上；档位只有两档", async () => {
    const db = await migrated();
    expect(() =>
      db
        .prepare(
          "INSERT INTO members (member_id, name, role_id, persona_json, model_tier, tone, status, hired_at, updated_at)" +
            " VALUES ('x', 'x', '不存在的岗位', '{}', 'execution', 'neutral', 'active', 1, 1)",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/iu);
    expect(() =>
      db
        .prepare(
          "INSERT INTO members (member_id, name, role_id, persona_json, model_tier, tone, status, hired_at, updated_at)" +
            " VALUES ('x', 'x', 'dev', '{}', 'boss-tier', 'neutral', 'active', 1, 1)",
        )
        .run(),
    ).toThrow(/CHECK constraint/iu);
  });
});

describe("0014 groups", () => {
  it("同一成员在同一群只有一条任职；跨群任职合法", async () => {
    const db = await migrated();
    seedMember(db, "m4");
    db.prepare(
      "INSERT INTO groups (group_id, title, task_id, cos_member_id, status, created_at, updated_at)" +
        " VALUES ('g1', '双十一', NULL, 'm4', 'active', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO groups (group_id, title, status, created_at, updated_at) VALUES ('g2', '其他', 'active', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO group_members VALUES ('g1', 'm4', 'dev', 'cos', 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO group_members VALUES ('g1', 'm4', 'qa', 'member', 2)",
        )
        .run(),
    ).toThrow(/UNIQUE/iu);
    db.prepare(
      "INSERT INTO group_members VALUES ('g2', 'm4', 'dev', 'member', 2)",
    ).run();
    expect(
      count(
        db,
        "SELECT count(*) AS c FROM group_members WHERE member_id = 'm4'",
      ),
    ).toBe(2);
  });
});

describe("0015 conversations / messages", () => {
  function seedConv(db: Db): void {
    seedMember(db, "a");
    seedMember(db, "b");
  }

  it("私聊键归一化：(b,a) 插不进去，(a,b) 重复插炸 UNIQUE", async () => {
    const db = await migrated();
    seedConv(db);
    // 'a' < 'b' ⇒ 归一形状 (a,b) 合法
    db.prepare(
      "INSERT INTO conversations (conversation_id, kind, member_a, member_b, created_at) VALUES ('p1', 'private', 'a', 'b', 1)",
    ).run();
    // 反序形状直接被 CHECK 拒（库级不变量，不靠应用层排序的自觉）
    expect(() =>
      db
        .prepare(
          "INSERT INTO conversations (conversation_id, kind, member_a, member_b, created_at) VALUES ('p2', 'private', 'b', 'a', 1)",
        )
        .run(),
    ).toThrow(/CHECK constraint/iu);
    // 同一条线换个 conversation_id 再开 ⇒ 部分唯一索引炸（「跨群可读」的地基）
    expect(() =>
      db
        .prepare(
          "INSERT INTO conversations (conversation_id, kind, member_a, member_b, created_at) VALUES ('p3', 'private', 'a', 'b', 2)",
        )
        .run(),
    ).toThrow(/UNIQUE/iu);
  });

  it("会话形状 CHECK：group 会话不许带 member 对，private 不许带 group", async () => {
    const db = await migrated();
    seedConv(db);
    db.prepare(
      "INSERT INTO groups (group_id, title, status, created_at, updated_at) VALUES ('g1', 'x', 'active', 1, 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO conversations (conversation_id, kind, group_id, member_a, created_at) VALUES ('c1', 'group', 'g1', 'a', 1)",
        )
        .run(),
    ).toThrow(/CHECK constraint/iu);
    expect(() =>
      db
        .prepare(
          "INSERT INTO conversations (conversation_id, kind, created_at) VALUES ('c2', 'private', 1)",
        )
        .run(),
    ).toThrow(/CHECK constraint/iu);
    // 每群恰好一条群会话
    db.prepare(
      "INSERT INTO conversations (conversation_id, kind, group_id, created_at) VALUES ('c3', 'group', 'g1', 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO conversations (conversation_id, kind, group_id, created_at) VALUES ('c4', 'group', 'g1', 2)",
        )
        .run(),
    ).toThrow(/UNIQUE/iu);
  });

  it("会话内 seq 唯一 + 正文中文全文检索命中", async () => {
    const db = await migrated();
    seedConv(db);
    db.prepare(
      "INSERT INTO conversations (conversation_id, kind, member_a, member_b, created_at) VALUES ('p1', 'private', 'a', 'b', 1)",
    ).run();
    db.prepare(
      "INSERT INTO messages (message_id, conversation_id, sender_member_id, author_kind, body, seq_in_conv, created_at)" +
        " VALUES ('msg1', 'p1', 'a', 'member', '双十一大促的预算要重算', 1, 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO messages (message_id, conversation_id, sender_member_id, author_kind, body, seq_in_conv, created_at)" +
            " VALUES ('msg2', 'p1', 'b', 'member', '撞车', 1, 2)",
        )
        .run(),
    ).toThrow(/UNIQUE/iu);
    const hits = db
      .prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?")
      .all('"预算要重"') as { rowid: number | bigint }[];
    expect(hits.length).toBe(1);
  });
});

describe("0016 documents", () => {
  it("版本 seq 文档内唯一；还原式新写合法", async () => {
    const db = await migrated();
    db.prepare(
      "INSERT INTO documents (doc_id, kind, title, owner, origin, created_at, updated_at) VALUES ('d1', 'markdown', 'T', 'boss', 'created', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO document_versions (doc_id, seq, body_text, author, created_at) VALUES ('d1', 1, 'v1', 'boss', 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO document_versions (doc_id, seq, body_text, author, created_at) VALUES ('d1', 1, 'v1bis', 'boss', 2)",
        )
        .run(),
    ).toThrow(/UNIQUE/iu);
    db.prepare(
      "INSERT INTO document_versions (doc_id, seq, body_text, author, created_at) VALUES ('d1', 2, 'v2', 'boss', 2)",
    ).run();
    db.prepare(
      "INSERT INTO document_versions (doc_id, seq, body_text, author, created_at) VALUES ('d1', 3, 'v1 还原', 'boss', 3)",
    ).run();
    expect(
      count(
        db,
        "SELECT count(*) AS c FROM document_versions WHERE doc_id = 'd1'",
      ),
    ).toBe(3);
  });

  it("kind / 权限档 / 水印全走 CHECK", async () => {
    const db = await migrated();
    expect(() =>
      db
        .prepare(
          "INSERT INTO documents (doc_id, kind, title, owner, origin, created_at, updated_at) VALUES ('dx', 'ppt', 'T', 'boss', 'created', 1, 1)",
        )
        .run(),
    ).toThrow(/CHECK constraint/iu);
    // origin 也是必填：每条创建路径都知道自己怎么来的（编辑器/导入/自动沉淀），
    // 给默认值会让未来的新路径忘传而不被发现。
    expect(() =>
      db
        .prepare(
          "INSERT INTO documents (doc_id, kind, title, owner, created_at, updated_at) VALUES ('dn', 'doc', 'T', 'boss', 1, 1)",
        )
        .run(),
    ).toThrow(/NOT NULL constraint/iu);
    db.prepare(
      "INSERT INTO documents (doc_id, kind, title, owner, origin, created_at, updated_at) VALUES ('d2', 'doc', 'T', 'boss', 'created', 1, 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO document_permissions VALUES ('d2', 'boss', 'admin')",
        )
        .run(),
    ).toThrow(/CHECK constraint/iu);
    db.prepare(
      "INSERT INTO document_permissions VALUES ('d2', 'group:g9', 'reader')",
    ).run();
    expect(
      count(
        db,
        "SELECT count(*) AS c FROM document_permissions WHERE doc_id = 'd2'",
      ),
    ).toBe(1);
  });

  it("内置模板删不掉，自建模板能删", async () => {
    const db = await migrated();
    expect(
      count(
        db,
        "SELECT count(*) AS c FROM document_templates WHERE builtin = 1",
      ),
    ).toBe(4);
    expect(() =>
      db
        .prepare("DELETE FROM document_templates WHERE template_id = 'tpl_prd'")
        .run(),
    ).toThrow(/不可删除/u);
    db.prepare(
      "INSERT INTO document_templates VALUES ('t-mine', '我的', 'markdown', 'x', 0)",
    ).run();
    db.prepare(
      "DELETE FROM document_templates WHERE template_id = 't-mine'",
    ).run();
  });

  it("文档标题与正文进 FTS（trigram 中文可搜）", async () => {
    const db = await migrated();
    db.prepare(
      "INSERT INTO documents (doc_id, kind, title, owner, origin, body_text, created_at, updated_at) VALUES ('d3', 'markdown', '站会摘要', 'boss', 'auto', '今天没有阻塞', 1, 1)",
    ).run();
    const hits = db
      .prepare("SELECT rowid FROM documents_fts WHERE documents_fts MATCH ?")
      .all('"没有阻塞"') as { rowid: number | bigint }[];
    expect(hits.length).toBe(1);
  });
});

describe("0017 meetings 扩展列", () => {
  function openMeeting(db: Db): void {
    seedMember(db, "mod");
    seedMember(db, "spk");
    db.prepare(
      "INSERT INTO groups (group_id, title, status, created_at, updated_at) VALUES ('g1', 'x', 'active', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO meetings (id, meeting_type, participants, created_at, group_id, moderator_member_id, speaking_order_json, status)" +
        " VALUES ('mt1', 'review', '[]', 1, 'g1', 'mod', '[\"spk\"]', 'open')",
    ).run();
  }

  it("结论三件套：缺任一列都不许 concluded（上游 §2.4）", async () => {
    const db = await migrated();
    openMeeting(db);
    expect(() =>
      db
        .prepare("UPDATE meetings SET status = 'concluded' WHERE id = 'mt1'")
        .run(),
    ).toThrow(/CHECK constraint/iu);
    expect(() =>
      db
        .prepare(
          "UPDATE meetings SET status = 'concluded', decision = '做' WHERE id = 'mt1'",
        )
        .run(),
    ).toThrow(/CHECK constraint/iu);
    db.prepare(
      "UPDATE meetings SET status = 'concluded', decision = '做', owner_member_id = 'spk', deadline_at = 9, concluded_at = 10 WHERE id = 'mt1'",
    ).run();
    const row = db
      .prepare("SELECT status, decision FROM meetings WHERE id = 'mt1'")
      .get() as { status: string; decision: string } | undefined;
    expect(row?.status).toBe("concluded");
    expect(row?.decision).toBe("做");
  });

  it("发言回合 (meeting, turn_seq) 唯一", async () => {
    const db = await migrated();
    openMeeting(db);
    db.prepare(
      "INSERT INTO meeting_turns (meeting_id, speaker_member_id, content, turn_seq, created_at) VALUES ('mt1', 'mod', '开场', 1, 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO meeting_turns (meeting_id, speaker_member_id, content, turn_seq, created_at) VALUES ('mt1', 'spk', '撞车', 1, 2)",
        )
        .run(),
    ).toThrow(/UNIQUE/iu);
  });

  it("摘要文档外键真实（自动沉淀的指针不能悬空）", async () => {
    const db = await migrated();
    openMeeting(db);
    expect(() =>
      db
        .prepare(
          "UPDATE meetings SET summary_doc_id = '不存在的文档' WHERE id = 'mt1'",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/iu);
  });
});

describe("0018 backlog", () => {
  it("合并指针只在取消态存在", async () => {
    const db = await migrated();
    db.prepare(
      "INSERT INTO backlog_items (id, title, state, priority, created_at, updated_at) VALUES ('b1', 'x', 'doing', 0, 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO backlog_items (id, title, state, priority, created_at, updated_at) VALUES ('b2', 'y', 'backlog', 0, 1, 1)",
    ).run();
    expect(() =>
      db
        .prepare("UPDATE backlog_items SET merged_into = 'b1' WHERE id = 'b2'")
        .run(),
    ).toThrow(/CHECK constraint/iu);
    db.prepare(
      "UPDATE backlog_items SET state = 'cancelled', merged_into = 'b1', updated_at = 2 WHERE id = 'b2'",
    ).run();
    const row = db
      .prepare("SELECT state, merged_into FROM backlog_items WHERE id = 'b2'")
      .get() as { state: string; merged_into: string } | undefined;
    expect(row?.merged_into).toBe("b1");
  });

  it("state 词表是看板列，不是 tasks 状态机", async () => {
    const db = await migrated();
    expect(() =>
      db
        .prepare(
          "INSERT INTO backlog_items (id, title, state, priority, created_at, updated_at) VALUES ('b3', 'x', 'IN_REVIEW', 0, 1, 1)",
        )
        .run(),
    ).toThrow(/CHECK constraint/iu);
  });
});

describe("0019/0020/0021 平台面", () => {
  it("MCP 插件 endpoint 可空可重（不同配置装两次合法），工具表挂外键", async () => {
    const db = await migrated();
    db.prepare(
      "INSERT INTO plugins (plugin_id, name, kind, endpoint, config_json, enabled, installed_at) VALUES ('p1', 'mcp', 'mcp', 'http://127.0.0.1:1/mcp', '{}', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO plugins (plugin_id, name, kind, endpoint, config_json, enabled, installed_at) VALUES ('p2', 'mcp2', 'mcp', 'http://127.0.0.1:1/mcp', '{\"token\":\"t2\"}', 1, 1)",
    ).run();
    expect(() =>
      db
        .prepare("INSERT INTO plugin_tools VALUES ('不存在', 't', '', '{}')")
        .run(),
    ).toThrow(/FOREIGN KEY/iu);
  });

  it("内置人才不可下架，导出件可下架", async () => {
    const db = await migrated();
    expect(
      count(
        db,
        "SELECT count(*) AS c FROM talent_market WHERE source = 'builtin'",
      ),
    ).toBe(4);
    expect(() =>
      db.prepare("DELETE FROM talent_market WHERE item_id = 'talent_pm'").run(),
    ).toThrow(/不可下架/u);
    db.prepare(
      "INSERT INTO talent_market (item_id, source, name, payload_json, published_at) VALUES ('t-imp', 'imported', '导入件', '{}', 1)",
    ).run();
    db.prepare("DELETE FROM talent_market WHERE item_id = 't-imp'").run();
  });

  it("内置人才 payload 是可解析档案：role_id 真、执行器 kind 全在七值枚举", async () => {
    const db = await migrated();
    const rows = db
      .prepare(
        "SELECT item_id, payload_json FROM talent_market WHERE source = 'builtin'",
      )
      .all() as {
      item_id: string;
      payload_json: string;
    }[];
    for (const r of rows) {
      const p = JSON.parse(r.payload_json) as {
        role_id: string;
        executors: { kind: string }[];
      };
      // 用真 FK 连接（openDb 恒 foreign_keys=ON）走一遍档案落地：
      // role_id 悬空 ⇒ members 插入炸；kind 越界 ⇒ member_executors 的 CHECK 炸。
      db.prepare(
        "INSERT INTO members (member_id, name, role_id, persona_json, model_tier, tone, status, hired_at, updated_at)" +
          " VALUES ('probe', '探针', ?, '{}', 'execution', 'neutral', 'active', 1, 1)",
      ).run(p.role_id);
      for (const [i, ex] of p.executors.entries()) {
        expect(() =>
          db
            .prepare(
              "INSERT INTO member_executors VALUES ('probe', ?, ?, '{}', 1)",
            )
            .run(i + 1, ex.kind),
        ).not.toThrow();
      }
      db.prepare(
        "DELETE FROM member_executors WHERE member_id = 'probe'",
      ).run();
      db.prepare("DELETE FROM members WHERE member_id = 'probe'").run();
    }
  });

  it("调研卡：同日同 URL 幂等，手记卡可无 URL", async () => {
    const db = await migrated();
    db.prepare(
      "INSERT INTO research_cards (card_id, day, source, title, url, created_at) VALUES ('r1', '2026-11-23', 'hn', 'T', 'http://x/1', 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO research_cards (card_id, day, source, title, url, created_at) VALUES ('r2', '2026-11-23', 'hn', 'T', 'http://x/1', 2)",
        )
        .run(),
    ).toThrow(/UNIQUE/iu);
    db.prepare(
      "INSERT INTO research_cards (card_id, day, source, title, url, created_at) VALUES ('r3', '2026-11-23', 'manual', '手记', NULL, 3)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO research_cards (card_id, day, source, title, url, created_at) VALUES ('r4', '2026-11-23', 'hn', '无源', NULL, 4)",
        )
        .run(),
    ).toThrow(/CHECK constraint/iu);
  });

  it("节奏事件四类 + 摘要文档外键", async () => {
    const db = await migrated();
    for (const k of ["sprint_planning", "standup", "review", "retro"]) {
      db.prepare(
        "INSERT INTO rhythm_events (event_id, kind, at) VALUES (?, ?, 1)",
      ).run("e-" + k, k);
    }
    expect(() =>
      db
        .prepare(
          "INSERT INTO rhythm_events VALUES ('e-x', 'party', NULL, 1, NULL, '{}')",
        )
        .run(),
    ).toThrow(/CHECK constraint/iu);
    expect(() =>
      db
        .prepare(
          "UPDATE rhythm_events SET digest_doc_id = '不存在' WHERE event_id = 'e-standup'",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/iu);
  });
});

describe("跨表形状抽查", () => {
  it("assets 按 (sha, purpose) 去重：同用途同字节第二条炸", async () => {
    const db = await migrated();
    db.prepare(
      "INSERT INTO assets (asset_id, purpose, mime, size_bytes, sha256, data, created_at) VALUES ('a1', 'avatar', 'image/png', 1, 'sha1', X'89', 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO assets (asset_id, purpose, mime, size_bytes, sha256, data, created_at) VALUES ('a2', 'avatar', 'image/png', 1, 'sha1', X'89', 2)",
        )
        .run(),
    ).toThrow(/UNIQUE/iu);
  });

  // 0029：去重键的第二维是 purpose。同一份字节换用途必须是【另一行】——
  // 否则「先当附件传过的图想当头像再传」会拿回附件行，头像绑定那道门必拒（0074）。
  it("assets 换用途不共键：同字节不同 purpose 各存一行", async () => {
    const db = await migrated();
    db.prepare(
      "INSERT INTO assets (asset_id, purpose, mime, size_bytes, sha256, data, created_at) VALUES ('a1', 'attachment', 'image/png', 1, 'sha1', X'89', 1)",
    ).run();
    db.prepare(
      "INSERT INTO assets (asset_id, purpose, mime, size_bytes, sha256, data, created_at) VALUES ('a2', 'avatar', 'image/png', 1, 'sha1', X'89', 2)",
    ).run();
    const rows = db
      .prepare(
        "SELECT asset_id, purpose FROM assets WHERE sha256 = 'sha1' ORDER BY asset_id",
      )
      .all();
    expect(rows).toEqual([
      { asset_id: "a1", purpose: "attachment" },
      { asset_id: "a2", purpose: "avatar" },
    ]);
  });

  it("群引用任务：task_id 立项前可空、立项后必须是真任务", async () => {
    const db = await migrated();
    db.prepare(
      "INSERT INTO groups (group_id, title, status, created_at, updated_at) VALUES ('g1', 'x', 'active', 1, 1)",
    ).run();
    expect(() =>
      db
        .prepare("UPDATE groups SET task_id = '不存在' WHERE group_id = 'g1'")
        .run(),
    ).toThrow(/FOREIGN KEY/iu);
  });
});
