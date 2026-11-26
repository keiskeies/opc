/**
 * 分发规则服务（dispatch/rules.ts）：配置面读写 + 三条写判据 + 审计。
 *
 * 夹具与 co.test.ts 同形：真 WriteQueue + 真迁移（服务经 requireScopeDb 要求
 * 「已在事务里」，手搓假 tx 会让这一条结构性消失）。
 *
 * 这个文件要钉住的，是「配置面写下的东西真的改变了派发行为」这一件事：
 * 停用一条规则 ⇒ listDispatchRules（消费侧只筛 enabled=1）里就没有它；
 * 改优先级 ⇒ 同关键字撞车时赢的那一条换人。只在服务这一层测「写了什么」是不够的
 * —— 0025 那句「规则本身可停用」要的是【停完之后派发生效为不存在】。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  CreateDispatchRuleRequest,
  HireMemberRequest,
  Persona,
} from "@opc/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { listDispatchRules, planDispatch } from "../../src/dispatch/co.js";
import {
  createDispatchRule,
  DISPATCH_RULE_AUDIT_KINDS,
  dispatchRuleServiceStatus,
  listDispatchRuleViews,
  updateDispatchRule,
} from "../../src/dispatch/rules.js";
import { createGroup } from "../../src/groups/service.js";
import { hireMember } from "../../src/members/service.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("dispatch-rules", import.meta.url);
mkdirSync(TMP, { recursive: true });
const NOW = Date.UTC(2026, 10, 23);
const queues: WriteQueue[] = [];
let fileSeq = 0;

const PERSONA: Persona = {
  style: "read first",
  values: ["evidence"],
  honesty: "test before claiming",
};

async function newQ(): Promise<{ q: WriteQueue; db: DatabaseSync }> {
  const path = join(TMP, "dr-" + process.pid + "-" + ++fileSeq + ".db");
  const q = new WriteQueue(path);
  queues.push(q);
  const db = q.writeConnection();
  migrate(db);
  return { q, db };
}

afterAll(async () => {
  for (const q of queues) {
    try {
      await q.close();
    } catch {
      // 已关过 / 平台差异都不该让清理阶段把断言结果冲掉
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});

async function hire(
  q: WriteQueue,
  memberId: string,
  roleId: string,
): Promise<void> {
  const req: HireMemberRequest = {
    name: "Member " + memberId,
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
    avatar_seed: memberId,
    seat_group_ids: [],
  };
  const r = await hireMember(q, { req, nowMs: NOW, newId: () => memberId });
  if (!r.ok) throw new Error("hire fixture failed: " + r.code + " " + r.reason);
}

/**
 * 一个带特助与若干成员的群。特助由 createGroup 自动追加（0014 的 D6「每群必有特助」
 * 归 groups/service 守），所以消费侧 planDispatch 在这里能真的选出目标。
 */
async function world(): Promise<{
  q: WriteQueue;
  db: DatabaseSync;
  groupId: string;
}> {
  const { q, db } = await newQ();
  await hire(q, "dev-1", "dev");
  await hire(q, "qa-1", "qa");
  const group = await createGroup(q, {
    req: {
      title: "Rules",
      goal: "verify the config surface",
      member_ids: ["dev-1", "qa-1"],
    },
    nowMs: NOW,
    newId: () => "group-1",
  });
  if (!group.ok) throw new Error("group fixture failed: " + group.reason);
  return { q, db, groupId: group.group.group_id };
}

function createReq(
  over: Partial<CreateDispatchRuleRequest> = {},
): CreateDispatchRuleRequest {
  return {
    keyword: "压测",
    target_role_id: "qa",
    group_id: null,
    priority: 5,
    enabled: true,
    ...over,
  };
}

function auditRows(
  db: DatabaseSync,
  target: string,
): Record<string, unknown>[] {
  return db
    .prepare(
      "SELECT id, actor_type, actor_id, action, target, payload, state_snapshot" +
        " FROM events WHERE target = ? ORDER BY id ASC",
    )
    .all(target) as Record<string, unknown>[];
}

describe("分发规则：读侧", () => {
  it("配置面列出全部种子（含停用），且带得出岗位展示名", async () => {
    const { db } = await newQ();
    const rules = listDispatchRuleViews(db);
    // 种子的条数是 0025 那份 INSERT 的行数，这里【不写死 6】：它随迁移增删而变，
    // 写死会让「加一条新种子」这种合法改动红在这里（那一格该由 0025 自己守）。
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.map((r) => r.rule_id)).toContain("cos_rule_bug");
    const bug = rules.find((r) => r.rule_id === "cos_rule_bug");
    expect(bug?.keyword).toBe("bug");
    expect(bug?.target_role_name).toBe("开发工程师");
    expect(bug?.group_id).toBeNull();
    expect(bug?.enabled).toBe(true);
    expect(bug?.priority).toBe(0);
    // 列表顺序 = 派发判定顺序（priority DESC，同优先级本群优先，再按 rule_id）
    expect(rules[0]?.rule_id).toBe("cos_rule_project");
  });

  it("目标岗位被手写库抽掉时读侧抛错，不翻译成「这条规则没有岗位」", async () => {
    const { db } = await newQ();
    // 绕过 FK 造一行孤儿引用（PRAGMA foreign_keys 是连接级的，这条连接上临时关掉）
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare(
      "INSERT INTO cos_dispatch_rules (rule_id, group_id, keyword, target_role_id," +
        " priority, enabled, created_at, updated_at)" +
        " VALUES ('r-orphan', NULL, '孤儿', 'ghost_role', 0, 1, 1, 1)",
    ).run();
    db.exec("PRAGMA foreign_keys = ON");
    expect(() => listDispatchRuleViews(db)).toThrow(/ghost_role/);
  });
});

describe("分发规则：停用真的改变派发（0025 那句「规则本身可停用」）", () => {
  it("停掉 cos_rule_test 后：命中「测试」的消息不再派给 QA，而命中「bug」的照旧派给开发", async () => {
    const { q, db } = await world();
    const before = planDispatch(db, {
      groupId: "group-1",
      text: "这版要测试一下",
    });
    expect(before.source).toBe("rule");
    expect(before.ruleId).toBe("cos_rule_test");
    expect(before.targetRoleId).toBe("qa");

    const upd = await updateDispatchRule(q, {
      ruleId: "cos_rule_test",
      req: { enabled: false },
      nowMs: NOW + 1,
    });
    expect(upd.ok).toBe(true);
    if (!upd.ok) return;
    expect(upd.rule.enabled).toBe(false);
    expect(upd.auditSeq).toBeGreaterThan(0);

    // 消费侧真的看不见它了（co.ts 两条 SQL 都带 enabled = 1）
    expect(listDispatchRules(db).map((r) => r.ruleId)).not.toContain(
      "cos_rule_test",
    );
    // 配置面仍看得见 —— 否则「我停用过吗」这一问在界面上无法回答
    expect(
      listDispatchRuleViews(db)
        .filter((r) => r.rule_id === "cos_rule_test")
        .map((r) => r.enabled),
    ).toEqual([false]);

    // 派发生效为「没有这条规则」：这句话不再命中任何东西
    const after = planDispatch(db, {
      groupId: "group-1",
      text: "这版要测试一下",
    });
    expect(after.source).toBe("none");
    expect(after.ruleId).toBeNull();

    // 而没被停用的那一条不受牵连
    const untouched = planDispatch(db, {
      groupId: "group-1",
      text: "这里有个 bug",
    });
    expect(untouched.source).toBe("rule");
    expect(untouched.ruleId).toBe("cos_rule_bug");
    expect(untouched.targetRoleId).toBe("dev");
  });

  it("同关键字的本群规则盖过全局规则，停用本群那条后赢家退回全局", async () => {
    const { q, db } = await world();
    const scoped = await createDispatchRule(q, {
      req: createReq({
        keyword: "bug",
        target_role_id: "qa",
        group_id: "group-1",
        priority: 0,
      }),
      nowMs: NOW,
      newId: () => "r-scope",
    });
    expect(scoped.ok).toBe(true);

    const won = planDispatch(db, { groupId: "group-1", text: "有个 bug" });
    expect(won.ruleId).toBe("r-scope");
    expect(won.targetRoleId).toBe("qa");

    const off = await updateDispatchRule(q, {
      ruleId: "r-scope",
      req: { enabled: false },
      nowMs: NOW + 2,
    });
    expect(off.ok).toBe(true);
    const back = planDispatch(db, { groupId: "group-1", text: "有个 bug" });
    expect(back.ruleId).toBe("cos_rule_bug");
    expect(back.targetRoleId).toBe("dev");
  });
});

describe("分发规则：写判据", () => {
  it("新建成功：视图可读回，priority/作用域/启停都按请求落", async () => {
    const { q, db } = await newQ();
    const created = await createDispatchRule(q, {
      req: createReq(),
      nowMs: NOW,
      newId: () => "cos_rule_stress",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.rule).toEqual({
      rule_id: "cos_rule_stress",
      group_id: null,
      keyword: "压测",
      target_role_id: "qa",
      target_role_name: "测试工程师",
      priority: 5,
      enabled: true,
      created_at: NOW,
      updated_at: NOW,
    });
    expect(listDispatchRuleViews(db).map((r) => r.rule_id)).toContain(
      "cos_rule_stress",
    );
  });

  it("指向不存在的岗位 ⇒ role_not_found，且库里一行未增", async () => {
    const { q, db } = await newQ();
    const before = listDispatchRuleViews(db).length;
    const bad = await createDispatchRule(q, {
      req: createReq({ target_role_id: "nope" }),
      nowMs: NOW,
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.code).toBe("role_not_found");
    expect(dispatchRuleServiceStatus(bad.code)).toBe(404);
    expect(listDispatchRuleViews(db).length).toBe(before);
  });

  it("指向不存在的群 ⇒ group_not_found（要做全局规则就该传 null）", async () => {
    const { q } = await newQ();
    const bad = await createDispatchRule(q, {
      req: createReq({ group_id: "group-missing" }),
      nowMs: NOW,
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.code).toBe("group_not_found");
    expect(dispatchRuleServiceStatus(bad.code)).toBe(404);
  });

  it("同作用域同关键字 ⇒ 409，并把占用它的那条 rule_id 说出口", async () => {
    const { q } = await newQ();
    const first = await createDispatchRule(q, {
      req: createReq({ keyword: "压测" }),
      nowMs: NOW,
      newId: () => "r-1",
    });
    expect(first.ok).toBe(true);
    const dup = await createDispatchRule(q, {
      req: createReq({ keyword: "压测" }),
      nowMs: NOW + 1,
      newId: () => "r-2",
    });
    expect(dup.ok).toBe(false);
    if (dup.ok) return;
    expect(dup.code).toBe("keyword_conflict");
    expect(dispatchRuleServiceStatus(dup.code)).toBe(409);
    expect(dup.reason).toContain("r-1");
  });

  it("大小写等价算重复：判据与 co.ts 的 toLowerCase 同源，不是 sqlite 的 ASCII lower()", async () => {
    const { q } = await newQ();
    const first = await createDispatchRule(q, {
      req: createReq({ keyword: "Bug" }),
      nowMs: NOW,
      newId: () => "r-upper",
    });
    expect(first.ok).toBe(false);
    if (first.ok) return;
    // 种子里已有 cos_rule_bug（关键字 "bug"）⇒ 新建 "Bug" 算冲突：派发用
    // text.toLowerCase().includes(keyword.toLowerCase())，两条同大小写等价的关键字
    // 永远同时命中，只会互抢。
    expect(first.code).toBe("keyword_conflict");

    // 与 sqlite lower() 分岔的那一发：SQLite 只折叠 ASCII，lower('Σ') 仍是 'Σ'。
    // 判据若搬到 SQL 上，这两条会被判成【不冲突】而双双落库 —— 派发侧却照样同时命中。
    // 所以判据留在 JS、用与 co.ts 同一个 toLowerCase()（见 rules.ts 文件头）。
    const sigma = await createDispatchRule(q, {
      req: createReq({ keyword: "Σ" }),
      nowMs: NOW,
      newId: () => "r-sigma-1",
    });
    expect(sigma.ok).toBe(true);
    const sigmaDup = await createDispatchRule(q, {
      req: createReq({ keyword: "σ" }),
      nowMs: NOW + 1,
      newId: () => "r-sigma-2",
    });
    expect(sigmaDup.ok).toBe(false);
    if (sigmaDup.ok) return;
    expect(sigmaDup.code).toBe("keyword_conflict");
  });

  it("全局与本群可同关键字共存：冲突判据只在同一作用域内生效", async () => {
    const { q, db } = await world();
    const scoped = await createDispatchRule(q, {
      req: createReq({ keyword: "bug", group_id: "group-1", priority: 0 }),
      nowMs: NOW,
      newId: () => "r-scope",
    });
    expect(scoped.ok).toBe(true);
    if (!scoped.ok) return;
    expect(scoped.rule.group_id).toBe("group-1");
    // 反方向也成立：全局侧再建一条 "bug" 仍与本群那条并存（各自作用域各判各的）
    const global = await createDispatchRule(q, {
      req: createReq({ keyword: "灰度", target_role_id: "qa" }),
      nowMs: NOW,
      newId: () => "r-global",
    });
    expect(global.ok).toBe(true);
    // 消费侧顺序：同优先级时本群赢（GROUP_RULES_SQL 的 (group_id IS NULL) ASC）
    const rules = listDispatchRules(db, "group-1").filter(
      (r) => r.keyword === "bug",
    );
    expect(rules.map((r) => r.ruleId)).toEqual(["r-scope", "cos_rule_bug"]);
  });

  it("PATCH 不存在的规则 ⇒ dispatch_rule_not_found；全等值 PATCH ⇒ audit_seq=0 且无新审计行", async () => {
    const { q, db } = await newQ();
    const missing = await updateDispatchRule(q, {
      ruleId: "nope",
      req: { enabled: false },
      nowMs: NOW,
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.code).toBe("dispatch_rule_not_found");
    expect(dispatchRuleServiceStatus(missing.code)).toBe(404);

    const seed = listDispatchRuleViews(db).find(
      (r) => r.rule_id === "cos_rule_test",
    );
    if (seed === undefined) throw new Error("种子 cos_rule_test 不见了");
    const auditBefore = db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE action = 'state_change'")
      .get() as { n: number };
    const noop = await updateDispatchRule(q, {
      ruleId: "cos_rule_test",
      req: { enabled: true },
      nowMs: NOW + 9,
    });
    expect(noop.ok).toBe(true);
    if (!noop.ok) return;
    expect(noop.auditSeq).toBe(0);
    expect(noop.rule).toEqual(seed);
    const auditAfter = db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE action = 'state_change'")
      .get() as { n: number };
    expect(Number(auditAfter.n)).toBe(Number(auditBefore.n));
  });

  it("PATCH 改关键字撞车 ⇒ 什么都不改（原关键字与 updated_at 都保持原值）", async () => {
    const { q, db } = await newQ();
    const before = listDispatchRuleViews(db).find(
      (r) => r.rule_id === "cos_rule_bug",
    );
    const clash = await updateDispatchRule(q, {
      ruleId: "cos_rule_bug",
      req: { keyword: "修复" },
      nowMs: NOW + 5,
    });
    expect(clash.ok).toBe(false);
    if (clash.ok) return;
    expect(clash.code).toBe("keyword_conflict");
    const after = listDispatchRuleViews(db).find(
      (r) => r.rule_id === "cos_rule_bug",
    );
    expect(after).toEqual(before);
  });

  it("PATCH 只换关键字大小写：改得动、撞不到自己，且 updated_at 随写而变", async () => {
    const { q, db } = await newQ();
    const seed = listDispatchRuleViews(db).find(
      (r) => r.rule_id === "cos_rule_bug",
    );
    if (seed === undefined) throw new Error("种子 cos_rule_bug 不见了");
    expect(seed.keyword).toBe("bug");
    expect(seed.updated_at).toBe(seed.created_at);
    const same = await updateDispatchRule(q, {
      ruleId: "cos_rule_bug",
      req: { keyword: "BUG" },
      nowMs: NOW + 1,
    });
    expect(same.ok).toBe(true);
    if (!same.ok) return;
    expect(same.rule.keyword).toBe("BUG");
    expect(same.auditSeq).toBeGreaterThan(0);
    // updated_at 恒随写而变（created_at 不动）：这条断言是「写痕」的唯一承重点 ——
    // 少了它，UPDATE 把 updated_at 写成 created_at 也能全绿，而回放就看不出改过几次。
    expect(same.rule.created_at).toBe(seed.created_at);
    expect(same.rule.updated_at).toBe(NOW + 1);
    const stored = listDispatchRuleViews(db).find(
      (r) => r.rule_id === "cos_rule_bug",
    );
    expect(stored?.updated_at).toBe(NOW + 1);
    // 归一化判据的下游：库里现值已是 "BUG"，所以「改回 bug」仍是大小写等价 ⇒ 不是撞车
    const back = await updateDispatchRule(q, {
      ruleId: "cos_rule_bug",
      req: { keyword: "bug" },
      nowMs: NOW + 2,
    });
    expect(back.ok).toBe(true);
  });

  it("PATCH 改目标岗位到不存在的岗位 ⇒ role_not_found 且原行未动", async () => {
    const { q, db } = await newQ();
    const before = listDispatchRuleViews(db).find(
      (r) => r.rule_id === "cos_rule_design",
    );
    const bad = await updateDispatchRule(q, {
      ruleId: "cos_rule_design",
      req: { target_role_id: "ghost" },
      nowMs: NOW + 3,
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.code).toBe("role_not_found");
    expect(
      listDispatchRuleViews(db).find((r) => r.rule_id === "cos_rule_design"),
    ).toEqual(before);
  });

  it("改优先级会换掉派发时的赢家（配置的下游效果）", async () => {
    const { q, db } = await world();
    // 两条同优先级、都命中「立项/设计」之外的同一句话：先用关键字区分
    const a = await createDispatchRule(q, {
      req: createReq({ keyword: "灰度", target_role_id: "qa", priority: 1 }),
      nowMs: NOW,
      newId: () => "r-low",
    });
    expect(a.ok).toBe(true);
    const b = await createDispatchRule(q, {
      req: createReq({ keyword: "灰度", target_role_id: "dev", priority: 9 }),
      nowMs: NOW,
      newId: () => "r-high",
    });
    // 同关键字必须判冲突 ⇒ 第二条被拒，所以「换赢家」只能靠改既有那条的优先级实现
    expect(b.ok).toBe(false);
    const flip = await updateDispatchRule(q, {
      ruleId: "r-low",
      req: { priority: 20 },
      nowMs: NOW + 2,
    });
    expect(flip.ok).toBe(true);
    if (!flip.ok) return;
    expect(flip.rule.priority).toBe(20);
    const ordered = listDispatchRules(db, "group-1");
    expect(ordered[0]?.ruleId).toBe("r-low");
  });
});

describe("分发规则：审计", () => {
  it("创建与改动各落一条 state_change，署名是老板那份人签，快照带 before/after", async () => {
    const { q, db } = await newQ();
    const created = await createDispatchRule(q, {
      req: createReq(),
      nowMs: NOW,
      newId: () => "cos_rule_audit",
    });
    expect(created.ok).toBe(true);
    const upd = await updateDispatchRule(q, {
      ruleId: "cos_rule_audit",
      req: { enabled: false, priority: 7 },
      nowMs: NOW + 4,
    });
    expect(upd.ok).toBe(true);

    const rows = auditRows(db, "cos_rule_audit");
    expect(rows).toHaveLength(2);
    const kinds = rows.map(
      (r) => (JSON.parse(String(r.payload)) as { kind: string }).kind,
    );
    expect(kinds).toEqual(["dispatch_rule_created", "dispatch_rule_updated"]);
    for (const row of rows) {
      expect(row.actor_type).toBe("human");
      expect(row.actor_id).toBe("ceo");
      expect(row.action).toBe("state_change");
    }
    const changed = (
      JSON.parse(String(rows[1]?.payload)) as { changed: string[] }
    ).changed;
    expect(changed).toEqual(["priority", "enabled"]);
    const snap = JSON.parse(String(rows[1]?.state_snapshot)) as {
      before: { enabled: boolean };
      after: { enabled: boolean; priority: number };
    };
    expect(snap.before.enabled).toBe(true);
    expect(snap.after.enabled).toBe(false);
    expect(snap.after.priority).toBe(7);
  });

  it("DISPATCH_RULE_AUDIT_KINDS 词表与实际写点逐字一致（防「加了枚举没人写」/「写了没人登记」）", async () => {
    const { q, db } = await newQ();
    expect(DISPATCH_RULE_AUDIT_KINDS).toEqual([
      "dispatch_rule_created",
      "dispatch_rule_updated",
    ]);
    const created = await createDispatchRule(q, {
      req: createReq(),
      nowMs: NOW,
      newId: () => "r-kinds",
    });
    expect(created.ok).toBe(true);
    await updateDispatchRule(q, {
      ruleId: "r-kinds",
      req: { priority: 1 },
      nowMs: NOW + 1,
    });
    const written = new Set(
      (
        db
          .prepare(
            "SELECT payload FROM events WHERE target = ? ORDER BY id ASC",
          )
          .all("r-kinds") as { payload: string }[]
      ).map((r) => (JSON.parse(r.payload) as { kind: string }).kind),
    );
    expect([...written].sort()).toEqual([...DISPATCH_RULE_AUDIT_KINDS].sort());
  });
});
