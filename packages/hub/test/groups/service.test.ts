/**
 * 群服务（T5）：建群事务（特助+会话+席位）、PATCH、拉人/移人、立项回填、审计。
 *
 * ⚠ 夹具全部走真 WriteQueue + 真迁移（同 roles/service.test.ts 的立场）。
 * 成员一律用 hireMember 造（真实生产形状），群用 createGroup 造 —— 除了
 * 「读侧守门」用例刻意手改库。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type GroupMemberView,
  groupViewSchema,
  type HireMemberRequest,
  type Persona,
} from "@opc/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import {
  addGroupMember,
  createGroup,
  GROUP_AUDIT_KINDS,
  getGroup,
  groupConversationId,
  groupServiceStatus,
  linkGroupTask,
  listGroupMembers,
  listGroups,
  removeGroupMember,
  updateGroup,
} from "../../src/groups/service.js";
import {
  COS_ROLE_ID,
  hireMember,
  updateMember,
} from "../../src/members/service.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("groups", import.meta.url);
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
  const path = join(TMP, "gp-" + process.pid + "-" + ++fileSeq + ".db");
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

/** 招一个成员（真实形状：走 hireMember，不走手插）。 */
async function hire(q: WriteQueue, id: string, roleId = "dev"): Promise<void> {
  const req: HireMemberRequest = {
    name: "成员" + id,
    role_id: roleId,
    model_tier: "execution",
    persona: PERSONA,
    tone: "direct",
    skills: [],
    executors: [
      {
        seq: 1,
        kind: "pure-model",
        config: { kind: "pure-model" },
        enabled: true,
      },
    ],
    seat_group_ids: [],
  };
  const r = await hireMember(q, { req, nowMs: NOW, newId: () => id });
  expect(r.ok).toBe(true);
}

function insertTask(db: AnyDb, id: string): void {
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at)" +
      " VALUES (?, '任务', 'pending', 'dev', 'start', ?, ?)",
  ).run(id, NOW, NOW);
}

describe("createGroup：建群事务", () => {
  it("成功路径：groups 行 + 群会话 + 特助席 + 成员席 + 审计一次落齐", async () => {
    const { q, db } = await newQ();
    await hire(q, "m-a", "dev");
    await hire(q, "m-b", "qa");
    // newId 按消费顺序取号：特助、群、会话各一个（恒同值会让审计 target 撞车）
    const ids = ["cos-1", "g-1", "conv-1"];
    let n = 0;
    const r = await createGroup(q, {
      req: {
        title: "改版群",
        goal: "把首页改了",
        member_ids: ["m-b", "m-a", "m-a"],
      },
      nowMs: NOW,
      newId: () => ids[n++] as string,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.group.title).toBe("改版群");
    expect(r.group.task_id).toBeNull();
    expect(r.group.status).toBe("active");
    // 特助在同一个事务里被孵化（newId 序列：成员、会话各取一个，特助第一个取）
    const cosId = r.group.cos_member_id;
    expect(cosId).not.toBeNull();
    expect(
      db.prepare("SELECT role_id FROM members WHERE member_id = ?").get(cosId),
    ).toEqual({
      role_id: COS_ROLE_ID,
    });
    // 会话行随行而生（0015「每群恰好一条」的应用侧半边）
    expect(r.conversation_id).toBeTruthy();
    expect(
      db
        .prepare(
          "SELECT kind, group_id, title FROM conversations WHERE conversation_id = ?",
        )
        .get(r.conversation_id),
    ).toEqual({ kind: "group", group_id: "g-1", title: "改版群" });
    // 席位：特助 + 两个成员（member_ids 去重）
    const seats = listGroupMembers(db as never, "g-1");
    expect(seats.map((s) => s.seat)).toEqual(["cos", "member", "member"]);
    expect(
      seats.filter((s) => s.seat === "member").map((s) => s.member_id),
    ).toEqual(["m-a", "m-b"]);
    expect(seats.find((s) => s.member_id === "m-b")?.role_id).toBe("qa");
    expect(r.group.member_count).toBe(3);
    // 审计
    const rows = auditRows(db, "g-1");
    expect(rows).toHaveLength(1);
    const payload = JSON.parse((rows[0] as AuditRowLite).payload) as Record<
      string,
      unknown
    >;
    expect(payload["kind"]).toBe("group_created");
    expect(payload["member_ids"]).toEqual(["m-a", "m-b"]);
    expect(payload["cos_member_id"]).toBe(cosId);
  });

  it("调用方把特助也塞进 member_ids ⇒ 幂等剔除，不坐双席", async () => {
    const { q, db } = await newQ();
    const seed = await createGroup(q, {
      req: { title: "先有群孵化特助", goal: "", member_ids: [] },
      nowMs: NOW,
      newId: () => "g-seed",
    });
    expect(seed.ok).toBe(true);
    if (!seed.ok) return;
    const cosId = seed.group.cos_member_id as string;
    const r = await createGroup(q, {
      req: { title: "第二群", goal: "", member_ids: [cosId] },
      nowMs: NOW + 1,
      newId: () => "g-2",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const seats = listGroupMembers(db as never, "g-2");
    expect(seats).toHaveLength(1);
    expect((seats[0] as GroupMemberView).member_id).toBe(cosId);
    expect((seats[0] as GroupMemberView).seat).toBe("cos");
    // 特助仍复用同一人（不克隆）
    expect(r.group.cos_member_id).toBe(cosId);
  });

  it("名单里查无此人 ⇒ member_not_found，整单回滚（群/会话/特助都不留）", async () => {
    const { q, db } = await newQ();
    const r = await createGroup(q, {
      req: { title: "坏名单", goal: "", member_ids: ["ghost"] },
      nowMs: NOW,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("member_not_found");
    expect(groupServiceStatus(r.code)).toBe(422);
    expect(db.prepare("SELECT COUNT(*) AS n FROM groups").get()).toEqual({
      n: 0,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM conversations").get()).toEqual(
      { n: 0 },
    );
    expect(db.prepare("SELECT COUNT(*) AS n FROM members").get()).toEqual({
      n: 0, // 特助孵化也在同一事务里，一起回滚
    });
  });

  it("名单含归档成员 ⇒ member_archived 整单拒（历史不篡改，入口要在职）", async () => {
    const { q, db } = await newQ();
    await hire(q, "m-arch");
    const arch = await updateMember(q, {
      memberId: "m-arch",
      req: { status: "archived" },
      nowMs: NOW + 1,
    });
    expect(arch.ok).toBe(true);
    const r = await createGroup(q, {
      req: { title: "拉归档人", goal: "", member_ids: ["m-arch"] },
      nowMs: NOW,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("member_archived");
    expect(groupServiceStatus(r.code)).toBe(422);
    // 整单回滚：群、会话、特助一个都不留（归档判定在孵化特助之前，但即便之后也回滚）
    expect(db.prepare("SELECT COUNT(*) AS n FROM groups").get()).toEqual({
      n: 0,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM conversations").get()).toEqual(
      { n: 0 },
    );
  });

  it("空名单也建得出群（特助自动在席）", async () => {
    const { q, db } = await newQ();
    const r = await createGroup(q, {
      req: { title: "光杆群", goal: "", member_ids: [] },
      nowMs: NOW,
      newId: () => "g-solo",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.group.member_count).toBe(1);
    const seats = listGroupMembers(db as never, "g-solo");
    expect((seats[0] as GroupMemberView).seat).toBe("cos");
    expect((seats[0] as GroupMemberView).role_id).toBe("cos");
  });
});

describe("updateGroup：PATCH 语义", () => {
  async function group(q: WriteQueue, id = "g-1"): Promise<void> {
    const r = await createGroup(q, {
      req: { title: "原名", goal: "原目标", member_ids: [] },
      nowMs: NOW,
      newId: () => id,
    });
    expect(r.ok).toBe(true);
  }

  it("改 title/goal/status 各改各的，没传的不动", async () => {
    const { q, db } = await newQ();
    await group(q);
    const r1 = await updateGroup(q, {
      groupId: "g-1",
      req: { title: "新名" },
      nowMs: NOW + 1,
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.group.title).toBe("新名");
    expect(r1.group.goal).toBe("原目标");
    expect(r1.group.status).toBe("active");
    expect(r1.group.updated_at).toBe(NOW + 1);
    const r2 = await updateGroup(q, {
      groupId: "g-1",
      req: { goal: "" }, // 清空目标：空串不是 NULL，COALESCE 不吞
      nowMs: NOW + 2,
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.group.goal).toBe("");
    const r3 = await updateGroup(q, {
      groupId: "g-1",
      req: { status: "archived" },
      nowMs: NOW + 3,
    });
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    expect(r3.group.status).toBe("archived");
    expect(listGroups(db as never, "active")).toEqual([]);
    expect(listGroups(db as never, "archived").map((g) => g.group_id)).toEqual([
      "g-1",
    ]);
    expect(listGroups(db as never, null)).toHaveLength(1);
  });

  it("changed 记在审计里（同值 PATCH ⇒ changed=[]，写了但没改变要诚实）", async () => {
    const { q, db } = await newQ();
    await group(q);
    await updateGroup(q, {
      groupId: "g-1",
      req: { title: "原名" },
      nowMs: NOW + 1,
    });
    const rows = auditRows(db, "g-1");
    const last = JSON.parse(
      (rows[rows.length - 1] as AuditRowLite).payload,
    ) as {
      kind: string;
      changed: string[];
    };
    expect(last.kind).toBe("group_updated");
    expect(last.changed).toEqual([]);
    await updateGroup(q, {
      groupId: "g-1",
      req: { title: "改一次" },
      nowMs: NOW + 2,
    });
    const rows2 = auditRows(db, "g-1");
    const last2 = JSON.parse(
      (rows2[rows2.length - 1] as AuditRowLite).payload,
    ) as {
      changed: string[];
    };
    expect(last2.changed).toEqual(["title"]);
  });

  it("群不存在 ⇒ group_not_found（404）", async () => {
    const { q } = await newQ();
    const r = await updateGroup(q, {
      groupId: "ghost",
      req: { title: "x" },
      nowMs: NOW,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("group_not_found");
    expect(groupServiceStatus(r.code)).toBe(404);
  });
});

describe("addGroupMember / removeGroupMember：席位进出", () => {
  async function seeded(q: WriteQueue): Promise<void> {
    await hire(q, "m-1", "dev");
    await hire(q, "m-2", "qa");
    const r = await createGroup(q, {
      req: { title: "岗群", goal: "", member_ids: [] },
      nowMs: NOW,
      newId: () => "g-1",
    });
    expect(r.ok).toBe(true);
  }

  it("缺省任职岗 = 成员默认岗；显式 role_id = 兼任", async () => {
    const { q, db } = await newQ();
    await seeded(q);
    const r1 = await addGroupMember(q, {
      groupId: "g-1",
      req: { member_id: "m-2" },
      nowMs: NOW + 1,
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.member.role_id).toBe("qa");
    expect(r1.member.seat).toBe("member");
    const r2 = await addGroupMember(q, {
      groupId: "g-1",
      req: { member_id: "m-1", role_id: "qa" }, // 兼任：dev 的人坐 qa 岗
      nowMs: NOW + 2,
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.member.role_id).toBe("qa");
    const seats = listGroupMembers(db as never, "g-1");
    expect(seats.find((s) => s.member_id === "m-1")?.role_id).toBe("qa");
    // 成员档案本身不动（兼任挂在席位上，不写在 members.role_id）
    expect(
      db.prepare("SELECT role_id FROM members WHERE member_id = 'm-1'").get(),
    ).toEqual({ role_id: "dev" });
  });

  it("岗位不存在 ⇒ role_not_found（兼任也要挂真实岗位）", async () => {
    const { q } = await newQ();
    await seeded(q);
    const r = await addGroupMember(q, {
      groupId: "g-1",
      req: { member_id: "m-1", role_id: "nope" },
      nowMs: NOW + 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("role_not_found");
  });

  it("重复拉人 ⇒ already_seated（审计唯一答案）", async () => {
    const { q } = await newQ();
    await seeded(q);
    expect(
      (
        await addGroupMember(q, {
          groupId: "g-1",
          req: { member_id: "m-1" },
          nowMs: NOW + 1,
        })
      ).ok,
    ).toBe(true);
    const r = await addGroupMember(q, {
      groupId: "g-1",
      req: { member_id: "m-1" },
      nowMs: NOW + 2,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("already_seated");
  });

  it("成员/群不存在各自报错方向正确", async () => {
    const { q } = await newQ();
    await seeded(q);
    const a = await addGroupMember(q, {
      groupId: "g-1",
      req: { member_id: "ghost" },
      nowMs: NOW + 1,
    });
    expect(a.ok).toBe(false);
    if (a.ok) return;
    expect(a.code).toBe("member_not_found");
    const b = await addGroupMember(q, {
      groupId: "ghost",
      req: { member_id: "m-1" },
      nowMs: NOW + 2,
    });
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.code).toBe("group_not_found");
  });

  it("归档群不进新人（与 hireMember 落座同判）", async () => {
    const { q } = await newQ();
    await seeded(q);
    await updateGroup(q, {
      groupId: "g-1",
      req: { status: "archived" },
      nowMs: NOW + 1,
    });
    const r = await addGroupMember(q, {
      groupId: "g-1",
      req: { member_id: "m-1" },
      nowMs: NOW + 2,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("group_not_found");
    expect(r.reason).toContain("已归档");
  });

  it("移出成员：席位删、人在职；member_count 跟着掉", async () => {
    const { q, db } = await newQ();
    await seeded(q);
    await addGroupMember(q, {
      groupId: "g-1",
      req: { member_id: "m-1" },
      nowMs: NOW + 1,
    });
    const r = await removeGroupMember(q, {
      groupId: "g-1",
      memberId: "m-1",
      nowMs: NOW + 2,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.group.member_count).toBe(1);
    expect(
      listGroupMembers(db as never, "g-1").map((s) => s.member_id),
    ).not.toContain("m-1");
    // 成员本身还在职（移出群 ≠ 离职）
    expect(
      db.prepare("SELECT status FROM members WHERE member_id = 'm-1'").get(),
    ).toEqual({ status: "active" });
    const rows = auditRows(db, "g-1");
    const last = JSON.parse(
      (rows[rows.length - 1] as AuditRowLite).payload,
    ) as Record<string, unknown>;
    expect(last["kind"]).toBe("group_member_removed");
  });

  it("特助移不走 ⇒ cos_required（D6 每群必有特助）", async () => {
    const { q, db } = await newQ();
    await seeded(q);
    const cosId = (
      db
        .prepare(
          "SELECT cos_member_id AS id FROM groups WHERE group_id = 'g-1'",
        )
        .get() as {
        id: string;
      }
    ).id;
    const r = await removeGroupMember(q, {
      groupId: "g-1",
      memberId: cosId,
      nowMs: NOW + 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("cos_required");
  });

  it("不在席 ⇒ seat_not_found（404）", async () => {
    const { q } = await newQ();
    await seeded(q);
    const r = await removeGroupMember(q, {
      groupId: "g-1",
      memberId: "m-1",
      nowMs: NOW + 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("seat_not_found");
    expect(groupServiceStatus(r.code)).toBe(404);
  });
});

describe("linkGroupTask：立项回填（T8 原语）", () => {
  async function seeded(q: WriteQueue): Promise<void> {
    const r = await createGroup(q, {
      req: { title: "待立项", goal: "", member_ids: [] },
      nowMs: NOW,
      newId: () => "g-1",
    });
    expect(r.ok).toBe(true);
  }

  it("挂上任务：task_id 回填 + 审计带 task_id", async () => {
    const { q, db } = await newQ();
    await seeded(q);
    insertTask(db, "t-1");
    const r = await linkGroupTask(q, {
      groupId: "g-1",
      taskId: "t-1",
      nowMs: NOW + 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.group.task_id).toBe("t-1");
    const rows = auditRows(db, "g-1");
    const last = rows[rows.length - 1] as AuditRowLite;
    expect(JSON.parse(last.payload)["kind"]).toBe("group_task_linked");
    expect(last.task_id).toBe("t-1");
  });

  it("同任务重挂 ⇒ 幂等成功且不重复审计（规则重试不炸）", async () => {
    const { q, db } = await newQ();
    await seeded(q);
    insertTask(db, "t-1");
    await linkGroupTask(q, { groupId: "g-1", taskId: "t-1", nowMs: NOW + 1 });
    const r = await linkGroupTask(q, {
      groupId: "g-1",
      taskId: "t-1",
      nowMs: NOW + 2,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.auditSeq).toBe(-1);
    const linked = auditRows(db, "g-1").filter(
      (row) => JSON.parse(row.payload)["kind"] === "group_task_linked",
    );
    expect(linked).toHaveLength(1);
  });

  it("已挂别的任务再挂新任务 ⇒ task_already_linked（换任务要显式解绑）", async () => {
    const { q, db } = await newQ();
    await seeded(q);
    insertTask(db, "t-1");
    insertTask(db, "t-2");
    await linkGroupTask(q, { groupId: "g-1", taskId: "t-1", nowMs: NOW + 1 });
    const r = await linkGroupTask(q, {
      groupId: "g-1",
      taskId: "t-2",
      nowMs: NOW + 2,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("task_already_linked");
  });

  it("任务已被别的群挂走 ⇒ task_already_linked（一任务一群）", async () => {
    const { q, db } = await newQ();
    await seeded(q);
    const other = await createGroup(q, {
      req: { title: "平行群", goal: "", member_ids: [] },
      nowMs: NOW + 1,
      newId: () => "g-2",
    });
    expect(other.ok).toBe(true);
    insertTask(db, "t-1");
    await linkGroupTask(q, { groupId: "g-2", taskId: "t-1", nowMs: NOW + 2 });
    const r = await linkGroupTask(q, {
      groupId: "g-1",
      taskId: "t-1",
      nowMs: NOW + 3,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("task_already_linked");
    expect(r.reason).toContain("g-2");
  });

  it("任务不存在 ⇒ task_not_found（先建任务再回填）", async () => {
    const { q } = await newQ();
    await seeded(q);
    const r = await linkGroupTask(q, {
      groupId: "g-1",
      taskId: "ghost",
      nowMs: NOW + 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("task_not_found");
  });

  it("归档群不受理立项", async () => {
    const { q, db } = await newQ();
    await seeded(q);
    insertTask(db, "t-1");
    await updateGroup(q, {
      groupId: "g-1",
      req: { status: "archived" },
      nowMs: NOW + 1,
    });
    const r = await linkGroupTask(q, {
      groupId: "g-1",
      taskId: "t-1",
      nowMs: NOW + 2,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("group_not_found");
    expect(r.reason).toContain("已归档");
  });
});

describe("读面与守门", () => {
  it("getGroup：查得给视图、查无给 null；listGroups 按创建时间排序", async () => {
    const { q, db } = await newQ();
    await createGroup(q, {
      req: { title: "先后", goal: "", member_ids: [] },
      nowMs: NOW,
      newId: () => "g-a",
    });
    await createGroup(q, {
      req: { title: "后后", goal: "", member_ids: [] },
      nowMs: NOW + 1,
      newId: () => "g-b",
    });
    expect(getGroup(db as never, "g-a")?.title).toBe("先后");
    expect(getGroup(db as never, "ghost")).toBeNull();
    expect(listGroups(db as never, null).map((g) => g.group_id)).toEqual([
      "g-a",
      "g-b",
    ]);
  });

  it("groupConversationId 对缺会话行的群抛（0015 不变量被旁路破坏时不降级）", async () => {
    const { q, db } = await newQ();
    const r = await createGroup(q, {
      req: { title: "会话被删", goal: "", member_ids: [] },
      nowMs: NOW,
      newId: () => "g-x",
    });
    expect(r.ok).toBe(true);
    db.prepare(
      "DELETE FROM conversations WHERE kind = 'group' AND group_id = 'g-x'",
    ).run();
    expect(() => groupConversationId(db as never, "g-x")).toThrow();
  });

  it("读侧守门：INTEGER 列被手改成字符串 ⇒ getGroup 抛（坏行不出口）", async () => {
    const { q, db } = await newQ();
    await createGroup(q, {
      req: { title: "坏行", goal: "", member_ids: [] },
      nowMs: NOW,
      newId: () => "g-bad",
    });
    // status 有 DDL CHECK 兜底（'zombie' 根本写不进去，见下一条），
    // 守门真正要防的是 DDL 管不住的形状：INTEGER 亲和列塞字符串 SQLite 照收。
    db.prepare(
      "UPDATE groups SET created_at = '昨天' WHERE group_id = 'g-bad'",
    ).run();
    expect(() => getGroup(db as never, "g-bad")).toThrow();
    expect(() => listGroups(db as never, null)).toThrow();
  });

  it("status 枚举外写不进库（DDL CHECK 兜底），视图契约同样拦得住", async () => {
    const { q, db } = await newQ();
    await createGroup(q, {
      req: { title: "坏状态", goal: "", member_ids: [] },
      nowMs: NOW,
      newId: () => "g-bad2",
    });
    expect(() =>
      db
        .prepare(
          "UPDATE groups SET status = 'zombie' WHERE group_id = 'g-bad2'",
        )
        .run(),
    ).toThrow(/CHECK constraint/);
    // 视图契约自己也要能拦住这种行（守门不是测试的发明）
    expect(
      groupViewSchema.safeParse({
        group_id: "g-bad2",
        title: "坏状态",
        goal: "",
        task_id: null,
        cos_member_id: null,
        status: "zombie",
        member_count: 1,
        created_at: NOW,
        updated_at: NOW,
      }).success,
    ).toBe(false);
  });

  it("GROUP_AUDIT_KINDS 与写面一一对应（防枚举漂）", () => {
    expect(GROUP_AUDIT_KINDS).toEqual([
      "group_created",
      "group_updated",
      "group_member_added",
      "group_member_removed",
      "group_task_linked",
    ]);
  });

  it("席位排序：特助席恒在最前", async () => {
    const { q, db } = await newQ();
    await hire(q, "m-1", "dev");
    await hire(q, "m-2", "qa");
    const r = await createGroup(q, {
      req: { title: "排序", goal: "", member_ids: ["m-1", "m-2"] },
      nowMs: NOW,
      newId: () => "g-o",
    });
    expect(r.ok).toBe(true);
    const seats = listGroupMembers(db as never, "g-o");
    expect((seats[0] as GroupMemberView).seat).toBe("cos");
    expect(seats.map((s) => s.seat)).toEqual(["cos", "member", "member"]);
  });

  it("归档成员既有席位保留，但既有成员归档不踢（归档语义）", async () => {
    const { q, db } = await newQ();
    await hire(q, "m-keep", "dev");
    const r = await createGroup(q, {
      req: { title: "留席", goal: "", member_ids: ["m-keep"] },
      nowMs: NOW,
      newId: () => "g-k",
    });
    expect(r.ok).toBe(true);
    // 直接归档成员（updateMember 在 members 测里盖过，这里只验证席位不动）
    await q.node(() => {
      db.prepare(
        "UPDATE members SET status = 'archived' WHERE member_id = 'm-keep'",
      ).run();
      return 1;
    });
    expect(
      listGroupMembers(db as never, "g-k").map((s) => s.member_id),
    ).toContain("m-keep");
    expect(getGroup(db as never, "g-k")?.member_count).toBe(2);
  });
});
