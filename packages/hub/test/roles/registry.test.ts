/**
 * COMPANY_NODES 只读兼容层（T4）：图谱 charter 从 roles 表读、缺省回退 preset。
 *
 * 这个文件钉的是 registry.ts 文件头承诺的四件事：
 *  ① 今天（0011 种子 charter_json 全 NULL）每个节点都走 preset 回退 —— 现状本身；
 *  ② 库里带岗位书 ⇒ 生效档位跟【岗位书】走，不跟 roles.model_tier 列走；
 *  ③ roles.model_tier 列单独改不动引擎档位（已登记缺口的消费侧选边）；
 *  ④ charter_json 坏了 ⇒ 抛，不静默回退。
 *
 * 与 test/roles/service.test.ts 的分工：那边判写路径；这边判装配出口
 * （buildCompanyGraph 的 roles 入参到底长什么样）。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CharterInput } from "@opc/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { COMPANY_NODES, type CompanyNode } from "../../src/graph/company.js";
import { loadPresetRoles } from "../../src/roles/preset.js";
import { NODE_TO_ORG_ROLE, rolesFromOrg } from "../../src/roles/registry.js";
import { setRoleCharter, updateRole } from "../../src/roles/service.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("roles-reg", import.meta.url);
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
  const path = join(TMP, "reg-" + process.pid + "-" + ++fileSeq + ".db");
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

/** 一份身份为 [roleId] 的最小岗位书（snake_case 请求形态）。 */
function draftFor(
  roleId: string,
  over: Partial<CharterInput> = {},
): CharterInput {
  return {
    role_id: roleId,
    display_name: "岗位书夹具",
    version: 1,
    honesty_boundaries: ["不假装有依据"],
    acceptance_criteria: [
      {
        condition: "metric:placeholder_used > 0",
        action: "reject",
        message: "仍有占位内容",
      },
    ],
    forbidden_actions: [],
    tool_permissions: ["read"],
    model_tier: "execution",
    budget: { daily_usd: 10, per_task_usd: 3 },
    decision_scope: {
      autonomous: [],
      requires_consultation: [],
      forbidden: [],
    },
    judgment_mode: {
      type: "strict_rules",
      strict_rules: [],
      bounded_judgment: [],
      full_discretion: [],
    },
    escalation_triggers: [],
    ...over,
  };
}

describe("NODE_TO_ORG_ROLE 映射表", () => {
  it("七个引擎节点一格不缺，值全部落在 0011 种子里", async () => {
    const { db } = await newQ();
    expect(Object.keys(NODE_TO_ORG_ROLE).sort()).toEqual(
      [...COMPANY_NODES].sort(),
    );
    const seeded = new Set(
      (
        db.prepare("SELECT role_id FROM roles").all() as { role_id: string }[]
      ).map((r) => r.role_id),
    );
    for (const roleId of Object.values(NODE_TO_ORG_ROLE)) {
      expect(seeded.has(roleId)).toBe(true);
    }
    // intake/charter 共用 cos 是有意的两节点一岗位（文件头注释）；钉住防「顺手拆行」。
    expect(NODE_TO_ORG_ROLE.intake).toBe(NODE_TO_ORG_ROLE.charter);
  });
});

describe("rolesFromOrg：缺省回退（今天的现状）", () => {
  it("种子全 NULL ⇒ 七节点档位逐格等于 preset，roleId 是 D11 语义 id", async () => {
    const { db } = await newQ();
    const preset = loadPresetRoles();
    const out = rolesFromOrg(db as never);
    expect(Object.keys(out).sort()).toEqual([...COMPANY_NODES].sort());
    for (const node of COMPANY_NODES as readonly CompanyNode[]) {
      expect(out[node].modelTier).toBe(preset[node].modelTier);
      expect(out[node].roleId).toBe(NODE_TO_ORG_ROLE[node]);
    }
    // 语义 id 与 preset 模板名【本来就该不同】的词表差异也钉一条：
    // intake 挂 cos 而不是 assistant —— 这正是这层桥存在的理由。
    expect(out.intake.roleId).toBe("cos");
  });
});

describe("rolesFromOrg：库优先", () => {
  it("cos 带上 management 岗位书 ⇒ intake/charter 生效档位变 management", async () => {
    const { q, db } = await newQ();
    const r = await setRoleCharter(q, {
      roleId: "cos",
      charter: draftFor("cos", { model_tier: "management" }),
      nowMs: NOW,
    });
    expect(r.ok).toBe(true);
    const out = rolesFromOrg(db as never);
    expect(out.intake.modelTier).toBe("management");
    expect(out.charter.modelTier).toBe("management");
    // 没被动过的节点不受牵连。
    expect(out.report.roleId).toBe("boss");
  });

  it("档位跟岗位书不跟 roles.model_tier 列（缺口消费侧选边：列改不动引擎）", async () => {
    const { q, db } = await newQ();
    const preset = loadPresetRoles();
    const u = await updateRole(q, {
      roleId: "dev",
      req: { model_tier: "management" },
      nowMs: NOW,
    });
    expect(u.ok).toBe(true);
    const out = rolesFromOrg(db as never);
    expect(out.dev.modelTier).toBe(preset.dev.modelTier);
  });

  it("charter_json 坏了 ⇒ 抛而不是静默换 preset（岗位书没生效不能装成正常运行）", async () => {
    const { q, db } = await newQ();
    void q;
    db.prepare("UPDATE roles SET charter_json = ? WHERE role_id = 'dev'").run(
      JSON.stringify({ not: "a charter" }),
    );
    expect(() => rolesFromOrg(db as never)).toThrow();
  });
});
