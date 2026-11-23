/**
 * 角色表服务（T4）：roles 公司树的读写、builtin/custom 约束、结构校验桥接、审计。
 *
 * 与相邻测试的分工：
 *  · test/org/*.test.ts 判的是 contracts 里 L1 纯函数【本身】；本文件判的是
 *    「roles 表怎么桥接进那两个函数、以及桥接口径（can_manage=管理档、boss 焊根）」；
 *  · test/charter/store.test.ts 判的是版本台账 role_charters；本文件的 charter 段
 *    判的是 roles.charter_json 这一份一次性快照（写前归一复用同一个 validateCharterDraft）。
 *
 * ⚠ 夹具全部走真 WriteQueue + 真迁移（同 charter/store.test.ts 的立场）：
 * 服务函数全部经 requireScopeDb 要求「已在事务里」，手搓一个永远在事务里的
 * 假 tx 会让这条结构性消失。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type CharterInput,
  type CreateRoleRequest,
  createRoleRequestSchema,
} from "@opc/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import {
  createRole,
  deleteRole,
  getRole,
  getRoleForEdit,
  HUMAN_ANCHOR_ROLE_ID,
  listRoles,
  roleServiceStatus,
  setRoleCharter,
  updateRole,
} from "../../src/roles/service.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("roles", import.meta.url);
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
  const path = join(TMP, "rs-" + process.pid + "-" + ++fileSeq + ".db");
  const q = new WriteQueue(path) as WriteQueue;
  queues.push(q);
  const db = (
    q as unknown as { writeConnection: () => AnyDb }
  ).writeConnection();
  migrate(db as never);
  // 刻意不插任何业务行：13 条内置角色随迁移而来，正好当「初始态」对照。
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

function auditRows(db: AnyDb): AuditRowLite[] {
  return db
    .prepare(
      "SELECT id, task_id, actor_type, actor_id, action, target, payload FROM events ORDER BY id",
    )
    .all() as unknown as AuditRowLite[];
}

function lastAudit(db: AnyDb): {
  payload: Record<string, unknown>;
  row: AuditRowLite;
} {
  const rows = auditRows(db);
  const row = rows[rows.length - 1] as AuditRowLite;
  return { row, payload: JSON.parse(row.payload) as Record<string, unknown> };
}

/** 最小 CharterInput（snake_case），形状纪律同 charter/store.test.ts 的 draft()。 */
const draft = (over: Partial<CharterInput> = {}): CharterInput => ({
  role_id: "translator",
  display_name: "翻译",
  version: 1,
  honesty_boundaries: ["不意淫原文没有的意思"],
  // condition 表达【不合格的情形】配 reject（0008 §7.3 末段），与 charter 侧夹具同口径。
  acceptance_criteria: [
    {
      condition: "metric:untranslated > 0",
      action: "reject",
      message: "仍有未译段落",
    },
  ],
  forbidden_actions: [],
  tool_permissions: ["read"],
  model_tier: "execution",
  budget: { daily_usd: 10, per_task_usd: 3 },
  decision_scope: { autonomous: [], requires_consultation: [], forbidden: [] },
  judgment_mode: {
    type: "strict_rules",
    strict_rules: [],
    bounded_judgment: [],
    full_discretion: [],
  },
  escalation_triggers: [],
  ...over,
});

const req = (over: Partial<CreateRoleRequest> = {}): CreateRoleRequest => ({
  role_id: "translator",
  name: "翻译",
  category: "support",
  reports_to: "boss",
  model_tier: "execution",
  ...over,
});

/** 直插一条成员（0013 全列形状），只用于给删除门 ③ 造引用。 */
function seedMember(
  db: AnyDb,
  memberId: string,
  roleId: string,
  status = "active",
): void {
  db.prepare(
    "INSERT INTO members (member_id, name, role_id, persona_json, model_tier, tone, status, " +
      "hired_at, updated_at) VALUES (?, ?, ?, '{}', 'execution', 'neutral', ?, ?, ?)",
  ).run(memberId, "成员" + memberId, roleId, status, NOW, NOW);
}

/** 群 + 成员 + 任职席位一行造齐（0014 要求群与成员先存在）。 */
function seedGroupWithSeat(
  db: AnyDb,
  groupId: string,
  memberId: string,
  roleId: string,
): void {
  db.prepare(
    "INSERT INTO groups (group_id, title, goal, status, created_at, updated_at) " +
      "VALUES (?, '群', '', 'active', ?, ?)",
  ).run(groupId, NOW, NOW);
  seedMember(db, memberId, roleId);
  db.prepare(
    "INSERT INTO group_members (group_id, member_id, role_id, seat, joined_at) " +
      "VALUES (?, ?, ?, 'member', ?)",
  ).run(groupId, memberId, roleId, NOW);
}

describe("读侧：列表 / 单查 / 编辑装配", () => {
  it("0011 种子 13 行全部在列，初始任职数为 0，boss 是唯一根", async () => {
    const { db } = await newQ();
    const roles = listRoles(db as never);
    expect(roles).toHaveLength(13);
    expect(roles.every((r) => r.kind === "builtin")).toBe(true);
    expect(roles.every((r) => r.occupant_count === 0)).toBe(true);
    const roots = roles.filter((r) => r.reports_to === null);
    expect(roots.map((r) => r.role_id)).toEqual([HUMAN_ANCHOR_ROLE_ID]);
    // 设计拍板（D9）：设计师进内置、支撑职能全激活。
    const ids = roles.map((r) => r.role_id);
    expect(ids).toContain("designer");
    for (const id of ["finance", "hr", "legal", "marketing", "sales"]) {
      expect(ids).toContain(id);
    }
  });

  it("occupant_count = group_members 任职席位（同一人兼任两群按两席计）", async () => {
    const { q, db } = await newQ();
    void q;
    seedGroupWithSeat(db, "g1", "m1", "dev");
    // 第二个群复用同一个成员：验证计数数的是【席位】不是【人头】。
    db.prepare(
      "INSERT INTO groups (group_id, title, goal, status, created_at, updated_at) " +
        "VALUES ('g2', '群2', '', 'active', ?, ?)",
    ).run(NOW, NOW);
    db.prepare(
      "INSERT INTO group_members (group_id, member_id, role_id, seat, joined_at) " +
        "VALUES ('g2', 'm1', 'dev', 'member', ?)",
    ).run(NOW);
    expect(getRole(db as never, "dev")?.occupant_count).toBe(2);
    expect(getRole(db as never, "qa")?.occupant_count).toBe(0);
  });

  it("getRole 未命中返回 undefined（不是抛，也不是兜底对象）", async () => {
    const { db } = await newQ();
    expect(getRole(db as never, "ghost")).toBeUndefined();
  });

  it("getRoleForEdit：种子行 charter 为 null（岗位书要 CEO 签，库里不代笔）", async () => {
    const { db } = await newQ();
    const e = getRoleForEdit(db as never, "cos");
    expect(e?.charter).toBeNull();
  });
});

describe("createRole", () => {
  it("成功：custom 行、审计 role_created、task_id 为 null、署名是人", async () => {
    const { q, db } = await newQ();
    const r = await createRole(q, { req: req(), nowMs: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.role.kind).toBe("custom");
    expect(r.role.reports_to).toBe("boss");
    expect(r.role.avatar_seed).toBe("translator"); // 缺省 = role_id
    const { row, payload } = lastAudit(db);
    expect(payload["kind"]).toBe("role_created");
    expect(row.action).toBe("state_change");
    expect(row.task_id).toBeNull();
    expect(row.actor_type).toBe("human");
    expect(row.actor_id).toBe("ceo");
    expect(row.target).toBe("translator");
  });

  it("契约默认值贯通：不传 reports_to ⇒ 挂 boss", async () => {
    const { q } = await newQ();
    const parsed = createRoleRequestSchema.parse({
      role_id: "archivist",
      name: "档案管理员",
      category: "support",
      model_tier: "execution",
    });
    expect(parsed.reports_to).toBe("boss");
    const r = await createRole(q, { req: parsed, nowMs: NOW });
    expect(r.ok).toBe(true);
  });

  it("重名拒 role_exists（add 不是 change）", async () => {
    const { q } = await newQ();
    expect((await createRole(q, { req: req(), nowMs: NOW })).ok).toBe(true);
    const again = await createRole(q, { req: req(), nowMs: NOW });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.code).toBe("role_exists");
  });

  it("上级不存在拒 unknown_role；上级是执行档拒 parent_not_manager", async () => {
    const { q } = await newQ();
    const miss = await createRole(q, {
      req: req({ reports_to: "nobody" }),
      nowMs: NOW,
    });
    expect(!miss.ok && miss.code).toBe("unknown_role");
    const notMgr = await createRole(q, {
      req: req({ reports_to: "dev" }),
      nowMs: NOW,
    });
    expect(!notMgr.ok && notMgr.code).toBe("parent_not_manager");
  });

  it("自环拒 would_create_cycle（重名检查之后、上级检查之前）", async () => {
    const { q } = await newQ();
    const r = await createRole(q, {
      req: req({ role_id: "loop", reports_to: "loop" }),
      nowMs: NOW,
    });
    expect(!r.ok && r.code).toBe("would_create_cycle");
  });

  it("契约就拒 null 上级：multiple_roots 在服务侧不可达（根只允许内置 boss）", async () => {
    const { q } = await newQ();
    // reports_to 的类型是 string（default boss），null 在 parse 就死 ——
    // validateNewNode 的 multiple_roots 判据对这条写路径是纵深防御，
    // 判据本身由 test/acceptance/new-role-to-its-own-criteria.test.ts 钉。
    expect(() =>
      createRoleRequestSchema.parse({
        role_id: "orphan",
        name: "孤根",
        category: "support",
        reports_to: null,
        model_tier: "execution",
      }),
    ).toThrow();
    const r = await createRole(q, { req: req(), nowMs: NOW });
    expect(r.ok).toBe(true);
  });

  it("深度：第 5 层放行、第 6 层拒 depth_exceeded（ORG_MAX_DEPTH=5 两侧都钉）", async () => {
    const { q } = await newQ();
    // 内置树最深管理链 boss(1) → cos(2) → tech_director(3)；中间格必须 management
    // （执行档当上级会先撞 parent_not_manager，到不了深度判据）。
    // l4 第 4 层、l5 第 5 层（= 上限，放行），l6 第 6 层（> 上限，拒）。
    const l4 = await createRole(q, {
      req: req({
        role_id: "l4",
        reports_to: "tech_director",
        model_tier: "management",
      }),
      nowMs: NOW,
    });
    expect(l4.ok).toBe(true);
    const l5 = await createRole(q, {
      req: req({ role_id: "l5", reports_to: "l4", model_tier: "management" }),
      nowMs: NOW,
    });
    expect(l5.ok).toBe(true);
    const l6 = await createRole(q, {
      req: req({ role_id: "l6", reports_to: "l5" }),
      nowMs: NOW,
    });
    expect(!l6.ok && l6.code).toBe("depth_exceeded");
  });

  it("失败不留行、不留审计（校验在任何写之前）", async () => {
    const { q, db } = await newQ();
    const before = auditRows(db).length;
    const r = await createRole(q, {
      req: req({ reports_to: "nobody" }),
      nowMs: NOW,
    });
    expect(r.ok).toBe(false);
    expect(getRole(db as never, "translator")).toBeUndefined();
    expect(auditRows(db)).toHaveLength(before);
  });
});

describe("updateRole", () => {
  it("未命中拒 role_not_found（404 原料）", async () => {
    const { q } = await newQ();
    const r = await updateRole(q, {
      roleId: "ghost",
      req: { name: "幽灵" },
      nowMs: NOW,
    });
    expect(!r.ok && r.code).toBe("role_not_found");
    expect(roleServiceStatus("role_not_found")).toBe(404);
  });

  it("PATCH 语义：没传的列不动，传了的列生效；审计 changed 只列真变的", async () => {
    const { q, db } = await newQ();
    const c = await createRole(q, { req: req(), nowMs: NOW });
    expect(c.ok).toBe(true);
    const u = await updateRole(q, {
      roleId: "translator",
      req: { name: "笔译" },
      nowMs: NOW + 5,
    });
    expect(u.ok).toBe(true);
    if (!u.ok) return;
    expect(u.role.name).toBe("笔译");
    expect(u.role.reports_to).toBe("boss");
    expect(u.role.model_tier).toBe("execution");
    expect(u.role.updated_at).toBe(NOW + 5);
    const { payload } = lastAudit(db);
    expect(payload["changed"]).toEqual(["name"]);
  });

  it("空 PATCH 也成立：changed 为空数组（审计如实说这次没改业务列）", async () => {
    const { q, db } = await newQ();
    await createRole(q, { req: req(), nowMs: NOW });
    const u = await updateRole(q, {
      roleId: "translator",
      req: {},
      nowMs: NOW + 1,
    });
    expect(u.ok).toBe(true);
    const { payload } = lastAudit(db);
    expect(payload["changed"]).toEqual([]);
  });

  it("换汇报线成功：dev 挂到产品总监下，审计 changed 含 reports_to", async () => {
    const { q, db } = await newQ();
    const u = await updateRole(q, {
      roleId: "dev",
      req: { reports_to: "product_director" },
      nowMs: NOW,
    });
    expect(u.ok).toBe(true);
    if (!u.ok) return;
    expect(u.role.reports_to).toBe("product_director");
    const { payload } = lastAudit(db);
    expect(payload["changed"]).toContain("reports_to");
  });

  it("换上级成环拒 would_create_cycle；挂到执行档拒 parent_not_manager", async () => {
    const { q } = await newQ();
    const cyc = await updateRole(q, {
      roleId: "cos",
      req: { reports_to: "dev" },
      nowMs: NOW,
    });
    expect(!cyc.ok && cyc.code).toBe("would_create_cycle");
    // finance 是 boss 直属执行档：不在 cos 的子孙里，环判据不抢跑，露出档位判据。
    const bad = await updateRole(q, {
      roleId: "cos",
      req: { reports_to: "finance" },
      nowMs: NOW,
    });
    expect(!bad.ok && bad.code).toBe("parent_not_manager");
  });

  it("老板焊根：改 boss 的汇报线拒 ceo_is_root（D1），改它的名字放行", async () => {
    const { q } = await newQ();
    const r = await updateRole(q, {
      roleId: HUMAN_ANCHOR_ROLE_ID,
      req: { reports_to: "cos" },
      nowMs: NOW,
    });
    expect(!r.ok && r.code).toBe("ceo_is_root");
    const rename = await updateRole(q, {
      roleId: HUMAN_ANCHOR_ROLE_ID,
      req: { name: "大老板" },
      nowMs: NOW,
    });
    expect(rename.ok).toBe(true);
  });

  it("builtin 可改非焊死列（D9 焊的是删与 kind，展示名与档位要能迭代）", async () => {
    const { q } = await newQ();
    const r = await updateRole(q, {
      roleId: "product_director",
      req: { name: "首席产品", model_tier: "execution" },
      nowMs: NOW,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.role.kind).toBe("builtin");
  });

  it("PATCH 不碰 charter_json（COALESCE 语义）：改名字后岗位书还在", async () => {
    const { q, db } = await newQ();
    await createRole(q, { req: req(), nowMs: NOW });
    await setRoleCharter(q, {
      roleId: "translator",
      charter: draft(),
      nowMs: NOW,
    });
    const u = await updateRole(q, {
      roleId: "translator",
      req: { name: "笔译" },
      nowMs: NOW + 1,
    });
    expect(u.ok).toBe(true);
    expect(
      getRoleForEdit(db as never, "translator")?.charter?.displayName,
    ).toBe("翻译");
  });
});

describe("deleteRole（三道门的顺序 + 下级改挂）", () => {
  it("builtin 拒 builtin_undeletable，行还在", async () => {
    const { q, db } = await newQ();
    const r = await deleteRole(q, { roleId: "boss", nowMs: NOW });
    expect(!r.ok && r.code).toBe("builtin_undeletable");
    expect(getRole(db as never, "boss")).toBeDefined();
  });

  it("未命中拒 role_not_found", async () => {
    const { q } = await newQ();
    const r = await deleteRole(q, { roleId: "ghost", nowMs: NOW });
    expect(!r.ok && r.code).toBe("role_not_found");
  });

  it("有任职席位拒 role_in_use，消息列出群 id（409 语义）", async () => {
    const { q, db } = await newQ();
    await createRole(q, { req: req(), nowMs: NOW });
    seedGroupWithSeat(db, "g1", "m1", "translator");
    seedGroupWithSeat(db, "g2", "m2", "translator");
    const r = await deleteRole(q, { roleId: "translator", nowMs: NOW });
    expect(!r.ok && r.code).toBe("role_in_use");
    if (r.ok) return;
    expect(r.reason).toContain("g1");
    expect(r.reason).toContain("g2");
    expect(roleServiceStatus("role_in_use")).toBe(409);
  });

  it("归档成员的本职也算引用（成员是可复用资产，FK 不认归档）", async () => {
    const { q, db } = await newQ();
    await createRole(q, { req: req(), nowMs: NOW });
    seedMember(db, "m9", "translator", "archived");
    const r = await deleteRole(q, { roleId: "translator", nowMs: NOW });
    expect(!r.ok && r.code).toBe("role_in_use");
  });

  it("删自定义角色：直接下级改挂到它的上级，审计带改挂清单", async () => {
    const { q, db } = await newQ();
    // team_lead 必须 management：worker_a 挂它下面过不了 parent_not_manager 的话，
    // 这条用例测的就不是改挂而是创建失败（上一版 fixture 就栽在这）。
    await createRole(q, {
      req: req({
        role_id: "team_lead",
        name: "组长",
        reports_to: "cos",
        model_tier: "management",
      }),
      nowMs: NOW,
    });
    const w = await createRole(q, {
      req: req({ role_id: "worker_a", name: "组员A", reports_to: "team_lead" }),
      nowMs: NOW,
    });
    expect(w.ok).toBe(true);
    const r = await deleteRole(q, { roleId: "team_lead", nowMs: NOW + 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reattachedTo).toBe("cos");
    expect([...r.reattachedChildren]).toEqual(["worker_a"]);
    expect(getRole(db as never, "team_lead")).toBeUndefined();
    expect(getRole(db as never, "worker_a")?.reports_to).toBe("cos");
    const { payload } = lastAudit(db);
    expect(payload["kind"]).toBe("role_deleted");
    expect(payload["reattached_children"]).toEqual(["worker_a"]);
    expect(payload["reattached_to"]).toBe("cos");
  });

  it("无下级的叶子直接删：改挂清单为空数组", async () => {
    const { q, db } = await newQ();
    await createRole(q, { req: req(), nowMs: NOW });
    const r = await deleteRole(q, { roleId: "translator", nowMs: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.reattachedChildren]).toEqual([]);
    expect(getRole(db as never, "translator")).toBeUndefined();
  });

  it("custom 行带 null 上级 = 数据异常：拒删而不是制造森林", async () => {
    const { q, db } = await newQ();
    db.prepare(
      "INSERT INTO roles (role_id, name, kind, category, reports_to, model_tier, charter_json, " +
        "avatar_seed, created_at, updated_at) " +
        "VALUES ('orphan_root', '孤根', 'custom', 'support', NULL, 'execution', NULL, 'orphan', ?, ?)",
    ).run(NOW, NOW);
    const r = await deleteRole(q, { roleId: "orphan_root", nowMs: NOW });
    expect(!r.ok && r.code).toBe("not_writable");
    expect(getRole(db as never, "orphan_root")).toBeDefined();
  });

  it("0011 触发器兜底：直删 builtin 行被库拦（ABORT 消息含「内置角色不可」）", async () => {
    const { db } = await newQ();
    expect(() =>
      db.prepare("DELETE FROM roles WHERE role_id = 'boss'").run(),
    ).toThrow(/内置角色不可/);
  });
});

describe("setRoleCharter（charter_json 的写前归一）", () => {
  it("写入后按 camelCase 归一落库，getRoleForEdit 读回归一形态", async () => {
    const { q, db } = await newQ();
    await createRole(q, { req: req(), nowMs: NOW });
    const r = await setRoleCharter(q, {
      roleId: "translator",
      charter: draft(),
      nowMs: NOW,
    });
    expect(r.ok).toBe(true);
    const raw = db
      .prepare("SELECT charter_json FROM roles WHERE role_id = 'translator'")
      .get() as { charter_json: string };
    const stored = JSON.parse(raw.charter_json) as Record<string, unknown>;
    expect(stored["roleId"]).toBe("translator");
    expect(stored["modelTier"]).toBe("execution");
    expect(stored["role_id"]).toBeUndefined();
    const e = getRoleForEdit(db as never, "translator");
    expect(e?.charter?.displayName).toBe("翻译");
    const { payload } = lastAudit(db);
    expect(payload["kind"]).toBe("role_charter_set");
    expect(payload["cleared"]).toBe(false);
  });

  it("身份不一致拒 invalid_charter（400），库不动", async () => {
    const { q, db } = await newQ();
    await createRole(q, { req: req(), nowMs: NOW });
    const r = await setRoleCharter(q, {
      roleId: "translator",
      charter: draft({ role_id: "someone_else" }),
      nowMs: NOW,
    });
    expect(!r.ok && r.code).toBe("invalid_charter");
    expect(getRoleForEdit(db as never, "translator")?.charter).toBeNull();
    expect(roleServiceStatus("invalid_charter")).toBe(400);
  });

  it("camelCase 误提交收到点名形状错误的消息（不是绕远路的不一致提示）", async () => {
    const { q } = await newQ();
    await createRole(q, { req: req(), nowMs: NOW });
    const camel = {
      roleId: "translator",
      displayName: "翻译",
    } as unknown as CharterInput;
    const r = await setRoleCharter(q, {
      roleId: "translator",
      charter: camel,
      nowMs: NOW,
    });
    expect(!r.ok && r.code).toBe("invalid_charter");
    if (r.ok) return;
    expect(r.reason).toContain("camelCase");
  });

  it("null 清除岗位书，回到 preset 回退态；审计 cleared=true", async () => {
    const { q, db } = await newQ();
    await createRole(q, { req: req(), nowMs: NOW });
    await setRoleCharter(q, {
      roleId: "translator",
      charter: draft(),
      nowMs: NOW,
    });
    const r = await setRoleCharter(q, {
      roleId: "translator",
      charter: null,
      nowMs: NOW + 2,
    });
    expect(r.ok).toBe(true);
    expect(getRoleForEdit(db as never, "translator")?.charter).toBeNull();
    const { payload } = lastAudit(db);
    expect(payload["cleared"]).toBe(true);
  });

  it("角色不存在拒 role_not_found", async () => {
    const { q } = await newQ();
    const r = await setRoleCharter(q, {
      roleId: "ghost",
      charter: null,
      nowMs: NOW,
    });
    expect(!r.ok && r.code).toBe("role_not_found");
  });
});

describe("状态码映射（T10 HTTP 与桌面 IPC 共用一张表）", () => {
  it("RejectCode 一律 422，服务码各自对号", () => {
    expect(roleServiceStatus("role_not_found")).toBe(404);
    expect(roleServiceStatus("role_in_use")).toBe(409);
    expect(roleServiceStatus("invalid_charter")).toBe(400);
    expect(roleServiceStatus("not_writable")).toBe(500);
    expect(roleServiceStatus("parent_not_manager")).toBe(422);
    expect(roleServiceStatus("depth_exceeded")).toBe(422);
    expect(roleServiceStatus("ceo_is_root")).toBe(422);
    expect(roleServiceStatus("multiple_roots")).toBe(422);
  });
});
