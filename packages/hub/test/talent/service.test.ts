/**
 * 人才市场服务（T5）：三入口一形状、导出导入互逆、挂牌派生键 upsert、builtin 禁删。
 *
 * ⚠ 夹具全部走真 WriteQueue + 真迁移（同 roles/service.test.ts 的立场）。
 * 成员一律 hireMember 造，挂牌走 publishTalent —— 除了「读侧守门」与
 * 「触发器兜底」用例刻意手改库。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type HireMemberRequest,
  hireMemberRequestSchema,
  type Persona,
  type TalentPayload,
  talentPayloadSchema,
} from "@opc/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { hireMember } from "../../src/members/service.js";
import {
  exportTalentPayload,
  getTalentItem,
  hireRequestFromTalent,
  importTalent,
  listTalentItems,
  PUBLISHED_ITEM_PREFIX,
  publishTalent,
  TALENT_AUDIT_KINDS,
  talentServiceStatus,
  unlistTalent,
} from "../../src/talent/service.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("talent", import.meta.url);
mkdirSync(TMP, { recursive: true });

type AnyDb = {
  prepare: (sql: string) => {
    all: (...a: unknown[]) => Record<string, unknown>[];
    get: (...a: unknown[]) => Record<string, unknown> | undefined;
    run: (...a: unknown[]) => unknown;
  };
  exec: (sql: string) => void;
};

const NOW = Date.UTC(2026, 10, 23);
const queues: WriteQueue[] = [];
let fileSeq = 0;

async function newQ(): Promise<{ q: WriteQueue; db: AnyDb }> {
  const path = join(TMP, "tl-" + process.pid + "-" + ++fileSeq + ".db");
  const q = new WriteQueue(path) as WriteQueue;
  queues.push(q);
  const db = (
    q as unknown as { writeConnection: () => AnyDb }
  ).writeConnection();
  migrate(db as never);
  return { q, db };
}

afterAll(async () => {
  for (const q of queues) {
    try {
      await (q as unknown as { close?: () => Promise<void> | void }).close?.();
    } catch {
      /* 关掉失败不影响别的 */
    }
  }
  // Windows 上 SQLite 文件句柄释放可能滞后于 close：重试几次再作罢
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(TMP, { recursive: true, force: true });
      break;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
});

const PERSONA: Persona = {
  style: "先读代码再改代码",
  values: ["最小改动"],
  honesty: "跑过的才叫能跑",
};

function hireReq(over: Partial<HireMemberRequest> = {}): HireMemberRequest {
  return {
    name: "测试成员",
    role_id: "dev",
    model_tier: "execution",
    persona: PERSONA,
    tone: "direct",
    skills: [
      { skill_id: "ts-v1", name: "TypeScript" },
      { skill_id: "sql-v1", name: "SQL" },
    ],
    executors: [
      {
        seq: 1,
        kind: "claude-cli",
        config: { kind: "claude-cli" },
        enabled: true,
      },
      {
        seq: 2,
        kind: "pure-model",
        config: { kind: "pure-model" },
        enabled: true,
      },
    ],
    seat_group_ids: [],
    ...over,
  };
}

async function hire(
  q: WriteQueue,
  id: string,
  over: Partial<HireMemberRequest> = {},
): Promise<void> {
  const r = await hireMember(q, {
    req: hireReq(over),
    nowMs: NOW,
    newId: () => id,
  });
  expect(r.ok).toBe(true);
}

function auditRows(db: AnyDb, target: string): Record<string, string>[] {
  return db
    .prepare(
      "SELECT id, task_id, actor_type, actor_id, action, target, payload" +
        " FROM events WHERE target = ? ORDER BY id",
    )
    .all(target) as unknown as Record<string, string>[];
}

describe("builtin 种子：货架开箱可用", () => {
  it("四条 builtin 逐条过 talentPayloadSchema（种子字节必须过契约）", async () => {
    const { db } = await newQ();
    const items = listTalentItems(db as never);
    expect(items.map((i) => i.item_id)).toEqual([
      "talent_design",
      "talent_eng",
      "talent_pm",
      "talent_qa",
    ]);
    for (const item of items) {
      expect(item.source).toBe("builtin");
      // assembleItem 已经 parse 过一次；这里独立再钉一遍，防守门自身被改坏
      expect(talentPayloadSchema.safeParse(item.payload).success).toBe(true);
    }
  });

  it("builtin 蓝图不引用任何本地 id（可移植性判据）", async () => {
    const { db } = await newQ();
    for (const item of listTalentItems(db as never)) {
      const keys = Object.keys(item.payload);
      expect(keys).not.toContain("member_id");
      expect(keys).not.toContain("avatar_asset_id");
      expect(keys).not.toContain("seat_group_ids");
    }
  });

  it("getTalentItem：存在给出视图，不存在给 null", async () => {
    const { db } = await newQ();
    expect(getTalentItem(db as never, "talent_pm")?.name).toBe("产品经理·模板");
    expect(getTalentItem(db as never, "nope")).toBeNull();
  });

  it("builtin 直接 DELETE 被触发器拦（0020 兜底，绕过应用层也删不掉）", async () => {
    const { db } = await newQ();
    expect(() =>
      db.prepare("DELETE FROM talent_market WHERE item_id = 'talent_pm'").run(),
    ).toThrow(/内置人才模板不可/);
  });
});

describe("importTalent：只挂牌，不入职", () => {
  it("成功导入 ⇒ imported 条目 + 审计一次，且成员表一根毛没动", async () => {
    const { q, db } = await newQ();
    const before = (
      db.prepare("SELECT COUNT(*) AS n FROM members").get() as { n: number }
    ).n;
    const r = await importTalent(q, {
      req: {
        payload: {
          name: "外来工程师",
          role_id: "dev",
          model_tier: "execution",
          avatar_seed: "seed-x",
          tone: "direct",
          persona: PERSONA,
          skills: [{ skill_id: "ts-v1", name: "TypeScript" }],
          executors: [
            {
              seq: 1,
              kind: "pure-model",
              config: { kind: "pure-model" },
              enabled: true,
            },
          ],
        },
      },
      nowMs: NOW,
      newId: () => "imp-1",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.source).toBe("imported");
    expect(r.auditSeq).toBeGreaterThan(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM members").get() as { n: number })
        .n,
    ).toBe(before); // 挂牌 ≠ 入职
    const rows = auditRows(db, "imp-1");
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(
      (rows[0] as Record<string, string>).payload as string,
    ) as Record<string, unknown>;
    expect(payload["kind"]).toBe("talent_imported");
    expect(payload["role_id"]).toBe("dev");
  });

  it("蓝图岗位本店不存在 ⇒ role_not_found 整单拒，货架无残留", async () => {
    const { q, db } = await newQ();
    const r = await importTalent(q, {
      req: {
        payload: {
          name: "外星岗位",
          role_id: "alien_role",
          model_tier: "execution",
          avatar_seed: "",
          tone: "neutral",
          persona: PERSONA,
          skills: [],
          executors: [
            {
              seq: 1,
              kind: "pure-model",
              config: { kind: "pure-model" },
              enabled: true,
            },
          ],
        },
      },
      nowMs: NOW,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("role_not_found");
    expect(talentServiceStatus(r.code)).toBe(422);
    expect(r.reason).toContain("alien_role"); // 指名缺哪个角色
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM talent_market WHERE source = 'imported'",
          )
          .get() as { n: number }
      ).n,
    ).toBe(0);
  });

  it("重复导入同一份蓝图 ⇒ 两条条目（两份同一 PDF 心智），删一份不伤另一份", async () => {
    const { q, db } = await newQ();
    const req = {
      payload: {
        name: "同一份",
        role_id: "dev",
        model_tier: "execution" as const,
        avatar_seed: "",
        tone: "neutral" as const,
        persona: PERSONA,
        skills: [],
        executors: [
          {
            seq: 1,
            kind: "pure-model" as const,
            config: { kind: "pure-model" as const },
            enabled: true,
          },
        ],
      },
    };
    const a = await importTalent(q, { req, nowMs: NOW, newId: () => "imp-a" });
    const b = await importTalent(q, { req, nowMs: NOW, newId: () => "imp-b" });
    expect(a.ok && b.ok).toBe(true);
    const del = await unlistTalent(q, { itemId: "imp-a", nowMs: NOW + 1 });
    expect(del.ok).toBe(true);
    expect(getTalentItem(db as never, "imp-a")).toBeNull();
    expect(getTalentItem(db as never, "imp-b")).not.toBeNull();
  });
});

describe("publishTalent：派生键 upsert，货架恒一", () => {
  it("挂牌成功 ⇒ pub:member_id 条目 + 审计；重复挂牌刷新而非堆条目", async () => {
    const { q, db } = await newQ();
    await hire(q, "m-pub");
    const first = await publishTalent(q, {
      req: { member_id: "m-pub" },
      nowMs: NOW,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.item.item_id).toBe(PUBLISHED_ITEM_PREFIX + "m-pub");
    expect(first.item.source).toBe("published");
    expect(first.item.payload.name).toBe("测试成员");
    // 成员改名后再挂：还是那一条，payload 刷新
    const r2 = await publishTalent(q, {
      req: { member_id: "m-pub" },
      nowMs: NOW + 1,
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM talent_market WHERE item_id = ?")
          .get(PUBLISHED_ITEM_PREFIX + "m-pub") as { n: number }
      ).n,
    ).toBe(1);
    const rows = auditRows(db, PUBLISHED_ITEM_PREFIX + "m-pub");
    expect(rows).toHaveLength(2);
    const kinds = rows.map(
      (r) =>
        (JSON.parse(r.payload as string) as Record<string, unknown>)[
          "republish"
        ],
    );
    expect(kinds).toEqual([false, true]);
  });

  it("成员不存在 ⇒ member_not_found，货架无动作", async () => {
    const { q, db } = await newQ();
    const r = await publishTalent(q, {
      req: { member_id: "ghost" },
      nowMs: NOW,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("member_not_found");
    expect(talentServiceStatus(r.code)).toBe(422);
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM talent_market WHERE source = 'published'",
          )
          .get() as { n: number }
      ).n,
    ).toBe(0);
  });

  it("挂牌是快照不是活引用：成员改档案后条目不自变", async () => {
    const { q, db } = await newQ();
    await hire(q, "m-snap");
    const pub = await publishTalent(q, {
      req: { member_id: "m-snap" },
      nowMs: NOW,
    });
    expect(pub.ok).toBe(true);
    if (!pub.ok) return;
    db.prepare(
      "UPDATE members SET name = '改了名' WHERE member_id = 'm-snap'",
    ).run();
    const item = getTalentItem(db as never, PUBLISHED_ITEM_PREFIX + "m-snap");
    expect(item?.payload.name).toBe("测试成员"); // 还是挂牌当时的快照
  });

  it("派生键撞进 builtin ⇒ not_writable（数据异常，不是覆盖）", async () => {
    const { q, db } = await newQ();
    await hire(q, "m-clash");
    // 手插一条 builtin 占住派生键（正常路径造不出这种行，DDL 允许 source='builtin'）
    db.prepare(
      "INSERT INTO talent_market (item_id, source, name, payload_json, published_at)" +
        " VALUES (?, 'builtin', '占位', ?, ?)",
    ).run(
      PUBLISHED_ITEM_PREFIX + "m-clash",
      JSON.stringify({
        name: "占位",
        role_id: "dev",
        model_tier: "execution",
        avatar_seed: "",
        tone: "neutral",
        persona: PERSONA,
        skills: [],
        executors: [
          { seq: 1, kind: "pure-model", config: { kind: "pure-model" } },
        ],
      }),
      NOW,
    );
    const r = await publishTalent(q, {
      req: { member_id: "m-clash" },
      nowMs: NOW + 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("not_writable");
    expect(talentServiceStatus(r.code)).toBe(500);
  });
});

describe("导出导入互逆（round-trip）", () => {
  it("挂牌导出 → 导入 → 再导出：蓝图逐字节等价", async () => {
    const { q, db } = await newQ();
    await hire(q, "m-rt", {
      voice: { lang: "zh-CN", rate: 1.1, pitch: 1, voice_hint: "v1" },
    });
    const pub = await publishTalent(q, {
      req: { member_id: "m-rt" },
      nowMs: NOW,
    });
    expect(pub.ok).toBe(true);
    if (!pub.ok) return;
    const exported = exportTalentPayload(
      db as never,
      PUBLISHED_ITEM_PREFIX + "m-rt",
    );
    expect(exported).not.toBeNull();
    const imp = await importTalent(q, {
      req: { payload: exported as TalentPayload },
      nowMs: NOW + 1,
      newId: () => "imp-rt",
    });
    expect(imp.ok).toBe(true);
    const reexported = exportTalentPayload(db as never, "imp-rt");
    expect(reexported).toEqual(exported);
  });

  it("导出的蓝图能直接喂 hireMemberRequestSchema（hire-from-talent 组合点）", async () => {
    const { q } = await newQ();
    await hire(q, "m-hire", {
      voice: { lang: "zh-CN", rate: 1.1, pitch: 1, voice_hint: "v1" },
    });
    const pub = await publishTalent(q, {
      req: { member_id: "m-hire" },
      nowMs: NOW,
    });
    expect(pub.ok).toBe(true);
    if (!pub.ok) return;
    const payload = pub.item.payload;
    const req = hireRequestFromTalent(payload, ["g-1"]) as HireMemberRequest;
    expect(hireMemberRequestSchema.safeParse(req).success).toBe(true);
    expect(req.seat_group_ids).toEqual(["g-1"]);
    expect(req.voice).toEqual(payload.voice);
    expect(req.avatar_seed).toBe(payload.avatar_seed);
  });
});

describe("talentPayloadFromMember：映射规则", () => {
  it("无头像种子 ⇒ 拿 member_id 兜底；无语音 ⇒ 键整个缺席", async () => {
    const { q } = await newQ();
    await hire(q, "m-map");
    const pub = await publishTalent(q, {
      req: { member_id: "m-map" },
      nowMs: NOW,
    });
    expect(pub.ok).toBe(true);
    if (!pub.ok) return;
    expect(pub.item.payload.avatar_seed).toBe("m-map");
    expect("voice" in pub.item.payload).toBe(false);
    // hireRequestFromTalent 对空种子/无语音同样缺席（不传空串给招聘）
    const req = hireRequestFromTalent(
      { ...pub.item.payload, avatar_seed: "" },
      [],
    ) as HireMemberRequest;
    expect("avatar_seed" in req).toBe(false);
    expect("voice" in req).toBe(false);
  });

  it("有头像种子 ⇒ 原样带过（不覆盖成 member_id）", async () => {
    const { q, db } = await newQ();
    await hire(q, "m-seed");
    // 手给成员补一个显式种子（正常由招聘落库，hire 夹具没带这个字段）
    db.prepare(
      "UPDATE members SET avatar_seed = 'face-42' WHERE member_id = 'm-seed'",
    ).run();
    const pub = await publishTalent(q, {
      req: { member_id: "m-seed" },
      nowMs: NOW,
    });
    expect(pub.ok).toBe(true);
    if (!pub.ok) return;
    expect(pub.item.payload.avatar_seed).toBe("face-42");
  });
});

describe("unlistTalent：下架", () => {
  it("下架 imported 条目 ⇒ 行删 + 审计 before 快照完整", async () => {
    const { q, db } = await newQ();
    const imp = await importTalent(q, {
      req: {
        payload: {
          name: "待下架",
          role_id: "dev",
          model_tier: "execution",
          avatar_seed: "",
          tone: "neutral",
          persona: PERSONA,
          skills: [],
          executors: [
            {
              seq: 1,
              kind: "pure-model",
              config: { kind: "pure-model" },
              enabled: true,
            },
          ],
        },
      },
      nowMs: NOW,
      newId: () => "imp-del",
    });
    expect(imp.ok).toBe(true);
    const r = await unlistTalent(q, { itemId: "imp-del", nowMs: NOW + 1 });
    expect(r.ok).toBe(true);
    expect(getTalentItem(db as never, "imp-del")).toBeNull();
    const rows = auditRows(db, "imp-del");
    // 同一条目先后两次动作（挂牌 + 下架）都记在同一 target 下
    expect(rows).toHaveLength(2);
    const kinds = rows.map(
      (r) =>
        (JSON.parse(r.payload as string) as Record<string, unknown>)["kind"],
    );
    expect(kinds).toEqual(["talent_imported", "talent_unlisted"]);
    const payload = JSON.parse(
      (rows[1] as Record<string, string>).payload as string,
    ) as Record<string, unknown>;
    expect(payload["name"]).toBe("待下架");
  });

  it("builtin ⇒ builtin_undeletable；不存在 ⇒ talent_not_found（404）", async () => {
    const { q } = await newQ();
    const a = await unlistTalent(q, { itemId: "talent_qa", nowMs: NOW });
    expect(a.ok).toBe(false);
    if (a.ok) return;
    expect(a.code).toBe("builtin_undeletable");
    expect(talentServiceStatus(a.code)).toBe(422);
    const b = await unlistTalent(q, { itemId: "nope", nowMs: NOW });
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.code).toBe("talent_not_found");
    expect(talentServiceStatus(b.code)).toBe(404);
  });

  it("下架不碰已按条目入职的成员（入职即独立）", async () => {
    const { q, db } = await newQ();
    await hire(q, "m-own");
    const pub = await publishTalent(q, {
      req: { member_id: "m-own" },
      nowMs: NOW,
    });
    expect(pub.ok).toBe(true);
    const del = await unlistTalent(q, {
      itemId: PUBLISHED_ITEM_PREFIX + "m-own",
      nowMs: NOW + 1,
    });
    expect(del.ok).toBe(true);
    expect(
      db.prepare("SELECT 1 AS ok FROM members WHERE member_id = 'm-own'").get(),
    ).toEqual({ ok: 1 });
  });
});

describe("读侧守门", () => {
  it("payload_json 坏了 ⇒ list/get 都抛（不伪装成空货架）", async () => {
    const { q, db } = await newQ();
    await hire(q, "m-bad");
    const pub = await publishTalent(q, {
      req: { member_id: "m-bad" },
      nowMs: NOW,
    });
    expect(pub.ok).toBe(true);
    db.prepare(
      "UPDATE talent_market SET payload_json = '{坏' WHERE item_id = ?",
    ).run(PUBLISHED_ITEM_PREFIX + "m-bad");
    expect(() =>
      getTalentItem(db as never, PUBLISHED_ITEM_PREFIX + "m-bad"),
    ).toThrow(/不是合法 JSON/);
    expect(() => listTalentItems(db as never)).toThrow();
    // 形状合法但内容坏（executors 空数组）：parse 拦下
    db.prepare(
      "UPDATE talent_market SET payload_json = ? WHERE item_id = ?",
    ).run(
      JSON.stringify({
        name: "坏内容",
        role_id: "dev",
        model_tier: "execution",
        avatar_seed: "",
        tone: "neutral",
        persona: PERSONA,
        skills: [],
        executors: [],
      }),
      PUBLISHED_ITEM_PREFIX + "m-bad",
    );
    expect(() =>
      getTalentItem(db as never, PUBLISHED_ITEM_PREFIX + "m-bad"),
    ).toThrow(/形状坏/);
  });

  it("TALENT_AUDIT_KINDS 与写面一一对应（防枚举漂）", () => {
    expect(TALENT_AUDIT_KINDS).toEqual([
      "talent_imported",
      "talent_published",
      "talent_unlisted",
    ]);
  });
});
