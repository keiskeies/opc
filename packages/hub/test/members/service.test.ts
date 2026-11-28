/**
 * 成员服务（T5）：招聘流水线、四件套、hire_events 台账、归档语义、审计。
 *
 * ⚠ 夹具全部走真 WriteQueue + 真迁移（同 roles/service.test.ts 的立场）：
 * 服务函数全部经 requireScopeDb 要求「已在事务里」，手搓假 tx 会让这条结构性消失。
 *
 * 本文件同时钉两条跨层对账：
 *  · HIRE_EVENT_ACTIONS 与 0013 hire_events.action 的 CHECK 词表逐字一致；
 *  · getMember 对坏 JSON 行抛（读侧守门）——用直接 UPDATE 造坏行，绕开写路径。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  HireMemberRequest,
  MemberExecutor,
  MemberSkill,
  Persona,
  Voice,
} from "@opc/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import {
  COS_EXECUTORS,
  COS_ROLE_ID,
  ensureCosMember,
  getMember,
  HIRE_EVENT_ACTIONS,
  type HireEventRow,
  hireMember,
  listHireEvents,
  listMembers,
  MEMBER_AUDIT_KINDS,
  memberName,
  memberServiceStatus,
  setMemberExecutors,
  setMemberSkills,
  updateMember,
} from "../../src/members/service.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("members", import.meta.url);
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
  const path = join(TMP, "mb-" + process.pid + "-" + ++fileSeq + ".db");
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
  rmSync(TMP, { recursive: true, force: true });
});

/** 一条审计行（列形状与 0001 events 一致）。 */
interface AuditRowLite {
  id: number | bigint;
  task_id: string | null;
  actor_type: string;
  actor_id: string;
  action: string;
  target: string | null;
  payload: string;
}

function auditRows(db: AnyDb, target: string): AuditRowLite[] {
  return db
    .prepare(
      "SELECT id, task_id, actor_type, actor_id, action, target, payload" +
        " FROM events WHERE target = ? ORDER BY id",
    )
    .all(target) as unknown as AuditRowLite[];
}

const PERSONA: Persona = {
  style: "先读代码再改代码",
  values: ["最小改动"],
  honesty: "跑过的才叫能跑",
};

const EXECUTORS: MemberExecutor[] = [
  { seq: 1, kind: "claude-cli", config: { kind: "claude-cli" }, enabled: true },
  { seq: 2, kind: "pure-model", config: { kind: "pure-model" }, enabled: true },
];

const SKILLS: MemberSkill[] = [
  { skill_id: "ts-v1", name: "TypeScript" },
  { skill_id: "sql-v1", name: "SQL" },
];

/** 读面把技能按 skill_id 归一排序（视图顺序是规范序，不是插入序））。 */
const SKILLS_CANON: MemberSkill[] = [
  SKILLS[1] as MemberSkill,
  SKILLS[0] as MemberSkill,
];

const VOICE: Voice = { lang: "zh-CN", rate: 1.1, pitch: 1, voice_hint: "v1" };

/** 一份能通过契约与服务的招聘请求基线（overrides 逐用例覆盖）。 */
function req(over: Partial<HireMemberRequest> = {}): HireMemberRequest {
  return {
    name: over.name ?? "小开",
    role_id: over.role_id ?? "dev",
    model_tier: over.model_tier ?? "execution",
    persona: over.persona ?? PERSONA,
    tone: over.tone ?? "direct",
    ...(over.voice === undefined ? {} : { voice: over.voice }),
    ...(over.avatar_asset_id === undefined
      ? {}
      : { avatar_asset_id: over.avatar_asset_id }),
    ...(over.avatar_seed === undefined
      ? {}
      : { avatar_seed: over.avatar_seed }),
    skills: over.skills ?? SKILLS,
    executors: over.executors ?? EXECUTORS,
    seat_group_ids: over.seat_group_ids ?? [],
  };
}

/** 在 hireMember 之外注入一个群行（groups/service 不在本文件被测，避免耦合）。 */
function insertGroup(db: AnyDb, groupId: string, status = "active"): void {
  db.prepare(
    "INSERT INTO groups (group_id, title, goal, task_id, cos_member_id, status, created_at, updated_at)" +
      " VALUES (?, '群', '', NULL, NULL, ?, ?, ?)",
  ).run(groupId, status, NOW, NOW);
}

/** 注入一个 asset（头像门要 purpose='avatar'）。 */
function insertAsset(db: AnyDb, assetId: string, purpose = "avatar"): void {
  db.prepare(
    "INSERT INTO assets (asset_id, purpose, mime, size_bytes, sha256, data, created_at)" +
      " VALUES (?, ?, 'image/png', 3, ?, X'89504E47', ?)",
  ).run(assetId, purpose, "sha-" + assetId, NOW);
}

describe("hireMember：招聘流水线", () => {
  it("成功路径：成员/技能/执行器/台账/审计四张表同步落库", async () => {
    const { q, db } = await newQ();
    const r = await hireMember(q, {
      req: req(),
      nowMs: NOW,
      newId: () => "m-1",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.member.member_id).toBe("m-1");
    expect(r.member.skills).toEqual(SKILLS_CANON);
    expect(r.member.executors).toEqual(EXECUTORS);
    expect(r.member.status).toBe("active");
    expect(r.member.avatar_seed).toBe("");
    expect(r.member.voice).toBeNull();
    expect(r.member.hired_at).toBe(NOW);

    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM member_skills WHERE member_id = 'm-1'",
        )
        .get(),
    ).toEqual({ n: 2 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM member_executors WHERE member_id = 'm-1'",
        )
        .get(),
    ).toEqual({ n: 2 });
    const ev = listHireEvents(db as never, "m-1");
    expect(ev).toHaveLength(1);
    const e0 = ev[0] as HireEventRow;
    expect(e0.action).toBe("hired");
    expect(e0.from).toBeNull();
    expect(e0.to.member_id).toBe("m-1");
    expect(e0.at).toBe(NOW);

    const rows = auditRows(db, "m-1");
    expect(rows).toHaveLength(1);
    const payload = JSON.parse((rows[0] as AuditRowLite).payload) as Record<
      string,
      unknown
    >;
    expect(payload["kind"]).toBe("member_hired");
    expect(payload["executor_kinds"]).toEqual(["claude-cli", "pure-model"]);
    expect((rows[0] as AuditRowLite).action).toBe("state_change");
    expect((rows[0] as AuditRowLite).actor_type).toBe("human");
  });

  it("岗位不存在 ⇒ role_not_found，且一行成员都没落", async () => {
    const { q, db } = await newQ();
    const r = await hireMember(q, {
      req: req({ role_id: "nope" }),
      nowMs: NOW,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("role_not_found");
    expect(memberServiceStatus(r.code)).toBe(422);
    expect(db.prepare("SELECT COUNT(*) AS n FROM members").get()).toEqual({
      n: 0,
    });
  });

  it("落座群不存在 ⇒ 整单回滚（不允许「聘成功但少坐群」）", async () => {
    const { q, db } = await newQ();
    insertGroup(db, "g-ok");
    const r = await hireMember(q, {
      req: req({ seat_group_ids: ["g-ok", "g-missing"] }),
      nowMs: NOW,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("group_not_found");
    expect(memberServiceStatus(r.code)).toBe(422);
    expect(db.prepare("SELECT COUNT(*) AS n FROM members").get()).toEqual({
      n: 0,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM group_members").get()).toEqual(
      { n: 0 },
    );
  });

  it("落座归档群 ⇒ 同样整单拒（群不可用）", async () => {
    const { q, db } = await newQ();
    insertGroup(db, "g-arch", "archived");
    const r = await hireMember(q, {
      req: req({ seat_group_ids: ["g-arch"] }),
      nowMs: NOW,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("group_not_found");
    expect(r.reason).toContain("已归档");
    expect(db.prepare("SELECT COUNT(*) AS n FROM members").get()).toEqual({
      n: 0,
    });
  });

  it("落座成功：seat_group_ids 去重排序后写 group_members（seat='member'）", async () => {
    const { q, db } = await newQ();
    insertGroup(db, "g-b");
    insertGroup(db, "g-a");
    const r = await hireMember(q, {
      req: req({ seat_group_ids: ["g-b", "g-a", "g-b"] }),
      nowMs: NOW,
      newId: () => "m-seat",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.seated_group_ids).toEqual(["g-a", "g-b"]);
    const seats = db
      .prepare(
        "SELECT group_id, member_id, role_id, seat FROM group_members ORDER BY group_id",
      )
      .all();
    expect(seats).toEqual([
      { group_id: "g-a", member_id: "m-seat", role_id: "dev", seat: "member" },
      { group_id: "g-b", member_id: "m-seat", role_id: "dev", seat: "member" },
    ]);
  });

  it("skill_id 重复 ⇒ duplicate_skill_id，不落半套技能", async () => {
    const { q, db } = await newQ();
    const r = await hireMember(q, {
      req: req({
        skills: [
          SKILLS[0] as MemberSkill,
          { ...(SKILLS[1] as MemberSkill), skill_id: "ts-v1" },
        ],
      }),
      nowMs: NOW,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("duplicate_skill_id");
    expect(db.prepare("SELECT COUNT(*) AS n FROM members").get()).toEqual({
      n: 0,
    });
  });

  it("执行器 seq 重复 ⇒ duplicate_executor_seq", async () => {
    const { q } = await newQ();
    const r = await hireMember(q, {
      req: req({
        executors: [
          EXECUTORS[0] as MemberExecutor,
          {
            seq: 1,
            kind: "pure-model",
            config: { kind: "pure-model" },
            enabled: true,
          },
        ],
      }),
      nowMs: NOW,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("duplicate_executor_seq");
  });

  it("头像资产用途不对 ⇒ asset_not_found（附件字节不能当头像）", async () => {
    const { q, db } = await newQ();
    insertAsset(db, "a-att", "attachment");
    const r = await hireMember(q, {
      req: req({ avatar_asset_id: "a-att" }),
      nowMs: NOW,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("asset_not_found");
    insertAsset(db, "a-ava", "avatar");
    const ok = await hireMember(q, {
      req: req({ avatar_asset_id: "a-ava" }),
      nowMs: NOW,
    });
    expect(ok.ok).toBe(true);
  });

  it("voice 落库并可读回；status 过滤读面正确", async () => {
    const { q, db } = await newQ();
    const r = await hireMember(q, {
      req: req({ voice: VOICE }),
      nowMs: NOW,
      newId: () => "m-v",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.member.voice).toEqual(VOICE);
    expect(getMember(db as never, "m-v")?.voice).toEqual(VOICE);
    expect(listMembers(db as never, "active").map((m) => m.member_id)).toEqual([
      "m-v",
    ]);
    expect(listMembers(db as never, "archived")).toEqual([]);
    expect(listMembers(db as never, null).map((m) => m.member_id)).toEqual([
      "m-v",
    ]);
  });
});

describe("updateMember：PATCH 合并与台账分事件", () => {
  async function hired(q: WriteQueue, id = "m-u"): Promise<void> {
    const r = await hireMember(q, { req: req(), nowMs: NOW, newId: () => id });
    expect(r.ok).toBe(true);
  }

  it("改 role/persona/status ⇒ 台账各记一条", async () => {
    const { q, db } = await newQ();
    await hired(q);
    const r = await updateMember(q, {
      memberId: "m-u",
      req: {
        role_id: "qa",
        persona: { ...PERSONA, style: "复现步骤精确到点击" },
        status: "archived",
      },
      nowMs: NOW + 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.member.role_id).toBe("qa");
    const actions = listHireEvents(db as never, "m-u").map((e) => e.action);
    expect(actions).toEqual([
      "hired",
      "role_changed",
      "persona_changed",
      "archived",
    ]);
    const rows = auditRows(db, "m-u");
    expect(rows).toHaveLength(2);
    const payload = JSON.parse((rows[1] as AuditRowLite).payload) as {
      kind: string;
      changed: string[];
    };
    expect(payload.kind).toBe("member_updated");
    expect(payload.changed.slice().sort()).toEqual([
      "persona",
      "role_id",
      "status",
    ]);
  });

  it("归档后再归档 ⇒ 不再落 archived 事件（同值不记台账）", async () => {
    const { q, db } = await newQ();
    await hired(q);
    expect(
      (
        await updateMember(q, {
          memberId: "m-u",
          req: { status: "archived" },
          nowMs: NOW + 1,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await updateMember(q, {
          memberId: "m-u",
          req: { status: "archived" },
          nowMs: NOW + 2,
        })
      ).ok,
    ).toBe(true);
    expect(listHireEvents(db as never, "m-u").map((e) => e.action)).toEqual([
      "hired",
      "archived",
    ]);
  });

  it("恢复在职 ⇒ restored 台账位", async () => {
    const { q, db } = await newQ();
    await hired(q);
    await updateMember(q, {
      memberId: "m-u",
      req: { status: "archived" },
      nowMs: NOW + 1,
    });
    await updateMember(q, {
      memberId: "m-u",
      req: { status: "active" },
      nowMs: NOW + 2,
    });
    expect(listHireEvents(db as never, "m-u").map((e) => e.action)).toEqual([
      "hired",
      "archived",
      "restored",
    ]);
  });

  it("改名/档位/语气/声音不落台账（0013 CHECK 没有这些人事动作位）", async () => {
    const { q, db } = await newQ();
    await hired(q);
    const r = await updateMember(q, {
      memberId: "m-u",
      req: {
        name: "新名",
        model_tier: "management",
        tone: "warm",
        voice: VOICE,
      },
      nowMs: NOW + 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(listHireEvents(db as never, "m-u")).toHaveLength(1); // 只有 hired
    const m = r.member;
    expect(m.name).toBe("新名");
    expect(m.model_tier).toBe("management");
    expect(m.tone).toBe("warm");
    expect(m.voice).toEqual(VOICE);
  });

  it("归档成员可改配置（归档不拦 PATCH）", async () => {
    const { q } = await newQ();
    await hired(q);
    await updateMember(q, {
      memberId: "m-u",
      req: { status: "archived" },
      nowMs: NOW + 1,
    });
    const r = await updateMember(q, {
      memberId: "m-u",
      req: { name: "修好再回来" },
      nowMs: NOW + 2,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.member.name).toBe("修好再回来");
    expect(r.member.status).toBe("archived");
  });

  it("成员不存在 ⇒ member_not_found（404）", async () => {
    const { q } = await newQ();
    const r = await updateMember(q, {
      memberId: "ghost",
      req: { name: "x" },
      nowMs: NOW,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("member_not_found");
    expect(memberServiceStatus(r.code)).toBe(404);
  });

  it("PATCH 里改到不存在的岗 ⇒ role_not_found 且原值不动", async () => {
    const { q, db } = await newQ();
    await hired(q);
    const r = await updateMember(q, {
      memberId: "m-u",
      req: { role_id: "nope" },
      nowMs: NOW + 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("role_not_found");
    expect(getMember(db as never, "m-u")?.role_id).toBe("dev");
  });
});

describe("setMemberSkills / setMemberExecutors：set 语义", () => {
  async function hired(q: WriteQueue, id = "m-s"): Promise<void> {
    expect(
      (await hireMember(q, { req: req(), nowMs: NOW, newId: () => id })).ok,
    ).toBe(true);
  }

  it("setSkills 全量替换：同值再存不落台账，变一次落一条", async () => {
    const { q, db } = await newQ();
    await hired(q);
    const r1 = await setMemberSkills(q, {
      memberId: "m-s",
      skills: SKILLS,
      nowMs: NOW + 1,
    });
    expect(r1.ok).toBe(true);
    expect(listHireEvents(db as never, "m-s")).toHaveLength(1); // 同值 ⇒ 不加事件
    const r2 = await setMemberSkills(q, {
      memberId: "m-s",
      skills: [{ skill_id: "go-v1", name: "Go" }],
      nowMs: NOW + 2,
    });
    expect(r2.ok).toBe(true);
    const events = listHireEvents(db as never, "m-s");
    expect(events.map((e) => e.action)).toEqual(["hired", "skills_changed"]);
    const e1 = events[1] as HireEventRow;
    expect(e1.to.skills).toEqual([{ skill_id: "go-v1", name: "Go" }]);
    expect(e1.from?.skills).toEqual(SKILLS_CANON);
    expect(getMember(db as never, "m-s")?.skills).toEqual([
      { skill_id: "go-v1", name: "Go" },
    ]);
  });

  it("setSkills 清空合法（技能可全卸）", async () => {
    const { q, db } = await newQ();
    await hired(q);
    const r = await setMemberSkills(q, {
      memberId: "m-s",
      skills: [],
      nowMs: NOW + 1,
    });
    expect(r.ok).toBe(true);
    expect(getMember(db as never, "m-s")?.skills).toEqual([]);
  });

  it("setSkills 数组内重复 skill_id ⇒ duplicate_skill_id", async () => {
    const { q } = await newQ();
    await hired(q);
    const r = await setMemberSkills(q, {
      memberId: "m-s",
      skills: [
        SKILLS[0] as MemberSkill,
        { ...(SKILLS[0] as MemberSkill), name: "TS" },
      ],
      nowMs: NOW + 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("duplicate_skill_id");
  });

  it("setExecutors 清空 ⇒ empty_executor_chain（零执行器=干不了活）", async () => {
    const { q, db } = await newQ();
    await hired(q);
    const r = await setMemberExecutors(q, {
      memberId: "m-s",
      executors: [],
      nowMs: NOW + 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("empty_executor_chain");
    expect(memberServiceStatus(r.code)).toBe(422);
    // 被拒之后原链完整。
    expect(getMember(db as never, "m-s")?.executors).toEqual(EXECUTORS);
  });

  it("setExecutors 变更落一条 executors_changed；enabled=false 往返无损", async () => {
    const { q, db } = await newQ();
    await hired(q);
    const next: MemberExecutor[] = [
      {
        seq: 1,
        kind: "codex-cli",
        config: { kind: "codex-cli" },
        enabled: false,
      },
    ];
    const r = await setMemberExecutors(q, {
      memberId: "m-s",
      executors: next,
      nowMs: NOW + 1,
    });
    expect(r.ok).toBe(true);
    expect(getMember(db as never, "m-s")?.executors).toEqual(next);
    expect(listHireEvents(db as never, "m-s").map((e) => e.action)).toEqual([
      "hired",
      "executors_changed",
    ]);
  });

  it("目标成员不存在 ⇒ member_not_found 且无副作用", async () => {
    const { q, db } = await newQ();
    const r = await setMemberSkills(q, {
      memberId: "ghost",
      skills: SKILLS,
      nowMs: NOW,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("member_not_found");
    expect(db.prepare("SELECT COUNT(*) AS n FROM hire_events").get()).toEqual({
      n: 0,
    });
  });
});

/**
 * updated_at 正向断言（0067 §5b：「随写而变」的字段要有一条正面断言承重）。
 *
 * members.updated_at 的语义是「这个成员的档案最后一次变」，而挂载（技能/执行器）
 * 是档案的一部分 —— 此前只有 updateMember 与 setAvatar 写这一列，两个挂载函数
 * 一次都没写过。反向断言（≠ / toBeLessThan）全绿推不出它有写入方，所以这里
 * 每条都钉「等于本次 nowMs」这一枚具体钟。
 */
describe("挂载替换与 updated_at：档案真的变了才前进", () => {
  async function hired(q: WriteQueue, id = "m-clock"): Promise<void> {
    expect(
      (await hireMember(q, { req: req(), nowMs: NOW, newId: () => id })).ok,
    ).toBe(true);
  }

  /** 绕开视图直接读列 —— 视图读错列时这一发要跟着红。 */
  function rawUpdatedAt(db: AnyDb, id: string): number {
    const row = db
      .prepare("SELECT updated_at FROM members WHERE member_id = ?")
      .get(id) as { updated_at: number | bigint };
    return Number(row.updated_at);
  }

  /**
   * 写结果回给调用方的那一枚钟（HTTP 直接把它编成响应体）。
   * 视图若在加钟之前取，库里那列照写、返回体给的是旧值 —— 界面立刻显示旧时刻。
   */
  function resultUpdatedAt(
    r: Awaited<ReturnType<typeof setMemberSkills>>,
  ): number {
    if (!r.ok) throw new Error("写被守卫拒了，读不到返回体");
    return r.member.updated_at;
  }

  it("换技能 ⇒ updated_at 前进到本次 nowMs，hired_at 纹丝不动", async () => {
    const { q, db } = await newQ();
    await hired(q);
    const r = await setMemberSkills(q, {
      memberId: "m-clock",
      skills: [{ skill_id: "go-v1", name: "Go" }],
      nowMs: NOW + 1,
    });
    expect(r.ok).toBe(true);
    const view = getMember(db as never, "m-clock");
    expect(view?.hired_at).toBe(NOW);
    expect(view?.updated_at).toBe(NOW + 1);
    expect(rawUpdatedAt(db, "m-clock")).toBe(NOW + 1);
    expect(resultUpdatedAt(r)).toBe(NOW + 1);
  });

  it("同一份技能列表再存一次 ⇒ 档案没变，updated_at 也不前进", async () => {
    const { q, db } = await newQ();
    await hired(q);
    const one = [{ skill_id: "go-v1", name: "Go" }];
    expect(
      (
        await setMemberSkills(q, {
          memberId: "m-clock",
          skills: one,
          nowMs: NOW + 1,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await setMemberSkills(q, {
          memberId: "m-clock",
          skills: one,
          nowMs: NOW + 2,
        })
      ).ok,
    ).toBe(true);
    // 同值写不落台账（文件头口径）——同一把尺子量时刻：变了才算变更，没变就不许动钟。
    expect(listHireEvents(db as never, "m-clock").map((e) => e.action)).toEqual(
      ["hired", "skills_changed"],
    );
    expect(getMember(db as never, "m-clock")?.updated_at).toBe(NOW + 1);
    expect(rawUpdatedAt(db, "m-clock")).toBe(NOW + 1);
  });

  it("被守卫拒掉的挂载 ⇒ 档案没变，updated_at 不前进也不留下半次写", async () => {
    const { q, db } = await newQ();
    await hired(q);
    const dup = await setMemberSkills(q, {
      memberId: "m-clock",
      skills: [
        { skill_id: "go-v1", name: "Go" },
        { skill_id: "go-v1", name: "Go 重复" },
      ],
      nowMs: NOW + 9,
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.code).toBe("duplicate_skill_id");
    }
    const empty = await setMemberExecutors(q, {
      memberId: "m-clock",
      executors: [],
      nowMs: NOW + 9,
    });
    expect(empty.ok).toBe(false);
    const ghost = await setMemberSkills(q, {
      memberId: "ghost",
      skills: SKILLS,
      nowMs: NOW + 9,
    });
    expect(ghost.ok).toBe(false);
    // 招聘那一刻写下的 updated_at 就是现在的值：三发被拒的写一次都没碰到这一列。
    expect(getMember(db as never, "m-clock")?.updated_at).toBe(NOW);
    expect(rawUpdatedAt(db, "m-clock")).toBe(NOW);
  });

  it("换执行器 ⇒ updated_at 前进；同一串再存一次不动（与技能同形）", async () => {
    const { q, db } = await newQ();
    await hired(q);
    const swapped = [
      {
        seq: 1,
        kind: "pure-model",
        config: { kind: "pure-model" },
        enabled: true,
      },
    ] as MemberExecutor[];
    const r = await setMemberExecutors(q, {
      memberId: "m-clock",
      executors: swapped,
      nowMs: NOW + 3,
    });
    expect(r.ok).toBe(true);
    expect(getMember(db as never, "m-clock")?.updated_at).toBe(NOW + 3);
    expect(rawUpdatedAt(db, "m-clock")).toBe(NOW + 3);
    expect(resultUpdatedAt(r)).toBe(NOW + 3);
    expect(
      (
        await setMemberExecutors(q, {
          memberId: "m-clock",
          executors: swapped,
          nowMs: NOW + 4,
        })
      ).ok,
    ).toBe(true);
    expect(getMember(db as never, "m-clock")?.updated_at).toBe(NOW + 3);
    expect(rawUpdatedAt(db, "m-clock")).toBe(NOW + 3);
  });

  it("旧形态反证：整删整插本身不算变更 —— 只改 enabled 才算", async () => {
    const { q, db } = await newQ();
    await hired(q);
    // 关掉 seq=2：形状真的变了 ⇒ 钟前进。
    const off = EXECUTORS.map((e) =>
      e.seq === 2 ? { ...e, enabled: false } : e,
    ) as MemberExecutor[];
    expect(
      (
        await setMemberExecutors(q, {
          memberId: "m-clock",
          executors: off,
          nowMs: NOW + 5,
        })
      ).ok,
    ).toBe(true);
    expect(getMember(db as never, "m-clock")?.updated_at).toBe(NOW + 5);
    // 重排 + 换插入序：规范化后同一串 ⇒ 档案没变，钟不许动。
    const shuffled = [...off].reverse();
    expect(
      (
        await setMemberExecutors(q, {
          memberId: "m-clock",
          executors: shuffled,
          nowMs: NOW + 6,
        })
      ).ok,
    ).toBe(true);
    expect(getMember(db as never, "m-clock")?.updated_at).toBe(NOW + 5);
  });
});

describe("ensureCosMember：全库唯一的特助", () => {
  it("首次孵化：成员+执行器+台账+审计(system 标记)，二次调用复用同一行", async () => {
    const { q, db } = await newQ();
    let seq = 0;
    const newId = () => "cos-" + ++seq;
    const id1 = await q.node(() =>
      ensureCosMember(db as never, { nowMs: NOW, newId }),
    );
    const id2 = await q.node(() =>
      ensureCosMember(db as never, { nowMs: NOW + 1, newId }),
    );
    expect(id1).toBe(id2);
    expect(id1).toBe("cos-1"); // 第二次命中复用，newId 不再被消耗
    const cos = getMember(db as never, id1);
    expect(cos?.role_id).toBe(COS_ROLE_ID);
    expect(cos?.status).toBe("active");
    expect(cos?.model_tier).toBe("management");
    expect(cos?.executors).toEqual(COS_EXECUTORS);
    const rows = auditRows(db, id1);
    expect(rows).toHaveLength(1);
    expect(JSON.parse((rows[0] as AuditRowLite).payload)).toMatchObject({
      kind: "member_hired",
      system: true,
    });
    expect(listHireEvents(db as never, id1).map((e) => e.action)).toEqual([
      "hired",
    ]);
  });

  it("归档的 CoS 不复活：二次调用孵化新的 active 行", async () => {
    const { q, db } = await newQ();
    let seq = 0;
    const newId = () => "cos-" + ++seq;
    const id1 = await q.node(() =>
      ensureCosMember(db as never, { nowMs: NOW, newId }),
    );
    await updateMember(q, {
      memberId: id1,
      req: { status: "archived" },
      nowMs: NOW + 1,
    });
    const id2 = await q.node(() =>
      ensureCosMember(db as never, { nowMs: NOW + 2, newId }),
    );
    expect(id2).not.toBe(id1);
    expect(getMember(db as never, id2)?.status).toBe("active");
    expect(getMember(db as never, id1)?.status).toBe("archived");
  });

  it("newId 缺省时也能孵化（randomUUID 兜底可跑通）", async () => {
    const { q, db } = await newQ();
    const id = await q.node(() => ensureCosMember(db as never, { nowMs: NOW }));
    expect(id.length).toBeGreaterThan(10);
    expect(getMember(db as never, id)?.name).toBe("特助");
  });
});

describe("对账与守门", () => {
  it("HIRE_EVENT_ACTIONS 与 0013 hire_events.action 的 CHECK 词表逐字一致", async () => {
    const { db } = await newQ();
    const ddl = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'hire_events'")
      .get() as { sql: string };
    const m = /action TEXT NOT NULL CHECK \(action IN \(([^)]*)\)/i.exec(
      ddl.sql.replace(/\s+/g, " "),
    );
    expect(m).not.toBeNull();
    const words = (m?.[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/'/g, ""));
    expect(words).toEqual([...HIRE_EVENT_ACTIONS]);
  });

  it("MEMBER_AUDIT_KINDS 覆盖四个写面的 payload.kind（防枚举漂）", () => {
    expect(MEMBER_AUDIT_KINDS).toEqual([
      "member_hired",
      "member_updated",
      "member_skills_set",
      "member_executors_set",
    ]);
  });

  it("读侧守门：persona_json 被手改成坏 JSON ⇒ getMember 抛而不是 null", async () => {
    const { q, db } = await newQ();
    const r = await hireMember(q, {
      req: req(),
      nowMs: NOW,
      newId: () => "m-bad",
    });
    expect(r.ok).toBe(true);
    db.prepare(
      "UPDATE members SET persona_json = '{oops' WHERE member_id = 'm-bad'",
    ).run();
    expect(() => getMember(db as never, "m-bad")).toThrow();
  });

  it("读侧守门：执行器 config 缺 kind ⇒ 抛（判别联合不许静默降级）", async () => {
    const { q, db } = await newQ();
    const r = await hireMember(q, {
      req: req(),
      nowMs: NOW,
      newId: () => "m-bad2",
    });
    expect(r.ok).toBe(true);
    db.prepare(
      "UPDATE member_executors SET config_json = '{}' WHERE member_id = 'm-bad2' AND seq = 1",
    ).run();
    expect(() => getMember(db as never, "m-bad2")).toThrow();
  });

  it("memberName：查得给名、查无给 null（读面容忍）", async () => {
    const { q, db } = await newQ();
    await hireMember(q, {
      req: req({ name: "小测" }),
      nowMs: NOW,
      newId: () => "m-n",
    });
    expect(memberName(db as never, "m-n")).toBe("小测");
    expect(memberName(db as never, "ghost")).toBeNull();
  });
});
