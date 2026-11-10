/**
 * 岗位书库内读写（Task 3.6 的岗位书那一半）。
 *
 * 与 test/org/versioning.test.ts 的分工：那边验的是「组织图提交时顺带 bump 岗位书」，
 * 本文件验的是「CEO 直接改一版岗位书，以及门控能不能读到它」。
 * 这两件事在 src 里此前**都没有入口**（store.ts 文件头 ①：跑完迁移
 * `SELECT COUNT(*) FROM role_charters` = 0）。
 *
 * ⚠ 夹具全部走真 WriteQueue + 真迁移。理由与 budget/acceptance 那些文件同一条：
 * saveCharterVersion 要求「已经在事务里」（requireScopeDb），而手搓一个
 * 永远在事务里的假 tx 会让「事务外调用必须抛」这条结构性消失。
 */

import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CharterInput } from "@opc/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { WriteQueue } from "../../src/db/write-queue.js";
import {
  assertCharterShape,
  CHARTER_ACTOR,
  CHARTER_AUDIT_KIND,
  gateCriteriaForRole,
  gateCriteriaForRoleAtVersion,
  latestCharterVersion,
  readCharterConfig,
  readLatestCharter,
  saveCharterVersion,
  validateCharterDraft,
} from "../../src/charter/store.js";
import { migrate } from "../../src/db/migrate.js";
import { evaluateGate, type GateCriterion } from "../../src/graph/gates/evaluate.js";
import type { EvidenceBundle } from "@opc/contracts";

const HUB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TMP = join(HUB, ".tmp", "charter");
mkdirSync(TMP, { recursive: true });

type AnyDb = {
  prepare: (sql: string) => {
    all: (...a: unknown[]) => Record<string, unknown>[];
    get: (...a: unknown[]) => Record<string, unknown> | undefined;
    run: (...a: unknown[]) => unknown;
  };
  exec: (sql: string) => void;
};

const NOW = Date.UTC(2026, 2, 1);
const queues: WriteQueue[] = [];
let fileSeq = 0;

async function newQ(): Promise<{ q: WriteQueue; db: AnyDb }> {
  const path = join(TMP, "ch-" + process.pid + "-" + ++fileSeq + ".db");
  const q = new WriteQueue(path) as WriteQueue;
  queues.push(q);
  const db = (q as unknown as { writeConnection: () => AnyDb }).writeConnection();
  migrate(db as never);
  // 刻意【不】插任务：岗位书变更不属于任何任务（审计 task_id = null，同 org_graph_changed），
  // 插一条会让「task_id 是 null」这条断言即使被写成任务 id 也没有对照可见。
  return { q, db };
}

/**
 * 一份能过 charterSchema 的最小草案（snake_case —— 它是 CharterInput）。
 *
 * 为什么手写而不是拿 resources/charter-templates/dev.yaml：模板里那七份的
 * acceptance_criteria 现在还带着 `CEO-PLACEHOLDER-ACCEPTANCE`（Task 0.9 等 CEO 签，
 * 见 0008 §7），把它们当夹具等于**替 CEO 填了验收标准** —— 那正是那条护栏拦的事。
 * 这里用的是明显是假数据的条件串，不会被误读成真标准。
 */
const draft = (over: Partial<CharterInput> = {}): CharterInput => ({
  role_id: "dev",
  display_name: "开发",
  version: 1,
  honesty_boundaries: ["不谎报测试结果"],
  // ⚠ condition 写的是【不合格的情形】，配 reject 读作「成立即拒」（0008 §7.3 末段）。
  // 我第一版写的是 `metric:coverage >= 80` + reject —— 那表达的是「覆盖率好就拒」，
  // 全绿而门控从不拦任何东西，正是那一节点名「我自己第一版就这么写错过一次」的形状，
  // 我隔了几轮又写了一遍。区别只是这次被自己的夹具用例当场拦住（前一次靠人指出）。
  acceptance_criteria: [
    { condition: "metric:coverage < 80", action: "reject", message: "覆盖率不足 80" },
  ],
  forbidden_actions: [],
  tool_permissions: ["read"],
  model_tier: "execution",
  budget: { daily_usd: 15, per_task_usd: 5 },
  decision_scope: { autonomous: [], requires_consultation: [], forbidden: [] },
  judgment_mode: { type: "strict_rules", strict_rules: [], bounded_judgment: [], full_discretion: [] },
  escalation_triggers: [],
  ...over,
});

/**
 * 一个能过门控前四道的证据包。
 *
 * ⚠ bundle_type 是 `code_diff` 不是 `test_report`：实测 HANDOFF_BUNDLE_TYPES
 * （contracts/evidence.ts:162-168）里 `dev_to_test → code_diff`、
 * `test_upward → test_report`。我第一版凭印象写了 test_report，于是每一发
 * evaluateGate 都在 §8.1 那一维 reject，而 reject 的 reasons 里写着包类型 ——
 * 「改了标准 ⇒ 结论翻转」那两条用例**仍然会绿**（它们只看 decision），
 * 岗位书这一维**从未进入判定**。夹具假装具备的性质又一次恰好是用例要证的性质
 * （0014 §8 第 1 项同一族，第六次）。
 */
const SHA = "a".repeat(64);
const ART = "T-1/code_diff/x.diff";
const bundle = (metrics: Record<string, number>): EvidenceBundle =>
  ({
    bundle_id: "11111111-1111-4111-8111-111111111111",
    task_id: "T-1",
    bundle_type: "code_diff",
    produced_by_role: "dev",
    produced_by_model_family: "claude",
    artifacts: [{ path: ART, sha256: SHA, bytes: 1 }],
    // evidence_refs 是**字符串路径**不是下标（实测 claimSchema 在 contracts/evidence.ts:70-79（evidence_refs 字段在第 77 行），
    // unresolvableClaimIndexes 在 145-159：ref 要等于某个 artifact.path 才算命中）。
    // 我第一版写的是 [0]，当场 TypeError: r.split is not a function。
    claims: [{ text: "覆盖率达标", evidence_refs: [ART] }],
    honesty_boundaries: [],
    metrics,
  }) as unknown as EvidenceBundle;

/** 读 budgets 里某一格的限额（夹具与断言共用）。 */
function limitOf(db: AnyDb, scope: string, scopeId: string, period: string): number | undefined {
  const r = db
    .prepare("SELECT limit_cents FROM budgets WHERE scope_type=? AND scope_id=? AND period=?")
    .get(scope, scopeId, period);
  return r === undefined ? undefined : Number(r["limit_cents"]);
}

/**
 * 在一个事务里跑几条裸语句（只给夹具铺数据用，命名成 seed 而不是 q：
 * 用例里 `const { q, db } = await newQ()` 的 q 是 WriteQueue，同名会把它遮蔽）。
 */
async function seed(db: AnyDb, stmts: readonly string[]): Promise<void> {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const t of stmts) db.exec(t);
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* SQLite 自己已中止 */
    }
    throw e;
  }
}

describe("① 存：只有 CEO、只有合法草案、每次一版", () => {
  it("跑完迁移之后 role_charters 是空的（本模块存在的理由，钉成断言而不是注释）", async () => {
    const { db } = await newQ();
    // 这条断言在「有人给这张表加了别的写入方（比如迁移里种一批种子）」那天会红。
    // 那时它应该红：0015 整篇的「今天没有入口」这句话要么已过期、要么需要重写。
    const rows = db.prepare("SELECT COUNT(*) AS c FROM role_charters").get();
    expect(Number(rows?.["c"])).toBe(0);
  });

  it("第一版存进去是 v1，署名是 human/ceo，并留下一条审计", async () => {
    const { q, db } = await newQ();
    const r = await saveCharterVersion(q, {
      roleId: "dev",
      config: draft(),
      nowMs: NOW,
      changeSummary: "补上覆盖率标准",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.version).toBe(1);

    const row = db
      .prepare("SELECT * FROM role_charters WHERE role_id = 'dev' AND version = 1")
      .get();
    expect(row?.["created_by"]).toBe("ceo");
    expect(row?.["effective_from"]).toBe(NOW);
    // 存的是**归一后**的 camelCase（与 org/commit.ts 的 bump 同一个形状）。
    // 如果这里存的是原始 snake_case，同一个字段会在两张来源不同的行里有两种键名。
    expect(Object.keys(JSON.parse(String(row?.["config"])))).toContain("acceptanceCriteria");

    const ev = db.prepare("SELECT * FROM events WHERE id = ?").get(r.auditSeq);
    expect(ev?.["actor_type"]).toBe(CHARTER_ACTOR.actorType);
    expect(ev?.["actor_id"]).toBe(CHARTER_ACTOR.actorId);
    // action 必须是枚举里现成的 state_change（AUDIT_ACTIONS 是 §22.1 的 10 值封闭枚举）。
    expect(ev?.["action"]).toBe("state_change");
    expect(ev?.["task_id"]).toBeNull();
    const payload = JSON.parse(String(ev?.["payload"])) as Record<string, unknown>;
    expect(payload["kind"]).toBe(CHARTER_AUDIT_KIND);
    expect(payload["previous_version"]).toBeNull();
    expect(ev?.["target"]).toBe("dev@v1");
  });

  it("第二版是 v2 且不动 v1（就地 UPDATE 会让「当时按哪版验收」永久消失）", async () => {
    const { q, db } = await newQ();
    await saveCharterVersion(q, { roleId: "dev", config: draft(), nowMs: NOW, changeSummary: "第一版" });
    const r2 = await saveCharterVersion(q, {
      roleId: "dev",
      config: draft({ acceptance_criteria: [{ condition: "metric:coverage < 95", action: "reject", message: "更严" }] }),
      nowMs: NOW + 1,
      changeSummary: "把覆盖率抬到 95",
    });
    expect(r2.ok && r2.version === 2).toBe(true);
    const rows = db.prepare("SELECT version, config FROM role_charters WHERE role_id='dev' ORDER BY version").all();
    expect(rows.length).toBe(2);
    // v1 的原文必须**逐字还在**（append-only 的配置面等价物）。
    expect(JSON.parse(String(rows[0]?.["config"]))["acceptanceCriteria"][0]["condition"]).toBe(
      "metric:coverage < 80",
    );
    expect(JSON.parse(String(rows[1]?.["config"]))["acceptanceCriteria"][0]["condition"]).toBe(
      "metric:coverage < 95",
    );
    expect(latestCharterVersion(db as never, "dev")).toBe(2);
  });

  it("校验不过 ⇒ 一行都不写、一条审计都不写", async () => {
    const { q, db } = await newQ();
    const before = Number(db.prepare("SELECT COUNT(*) c FROM events").get()?.["c"]);
    const r = await saveCharterVersion(q, {
      roleId: "dev",
      // acceptance_criteria 空数组：charterSchema 要 min(1)
      config: draft({ acceptance_criteria: [] }),
      nowMs: NOW,
      changeSummary: "试图存一份空标准",
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("未过校验");
    expect(Number(db.prepare("SELECT COUNT(*) c FROM role_charters").get()?.["c"])).toBe(0);
    // 半套状态是这一族最贵的失效：为一次【没发生】的变更留一条删不掉的审计。
    expect(Number(db.prepare("SELECT COUNT(*) c FROM events").get()?.["c"])).toBe(before);
  });

  it("roleId 与 config.role_id 不一致 ⇒ 拒（不取其中之一为准）", async () => {
    const { q, db } = await newQ();
    const r = await saveCharterVersion(q, {
      roleId: "tech",
      config: draft({ role_id: "dev" }),
      nowMs: NOW,
      changeSummary: "试图写到别的角色名下",
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("不一致");
    expect(Number(db.prepare("SELECT COUNT(*) c FROM role_charters").get()?.["c"])).toBe(0);
  });

  it("changeSummary 空串被拒：它是回放里唯一人可读的那句「为什么改」", async () => {
    const { q } = await newQ();
    const r = await saveCharterVersion(q, { roleId: "dev", config: draft(), nowMs: NOW, changeSummary: "   " });
    expect(r.ok).toBe(false);
  });

  it("camelCase 草案被拒且报错点名 snake_case（我实测踩过的那个形状）", async () => {
    const { q } = await newQ();
    const camel = {
      roleId: "dev",
      displayName: "开发",
      version: 1,
      acceptanceCriteria: [{ condition: "c", action: "reject", message: "m" }],
    } as unknown as CharterInput;
    const r = await saveCharterVersion(q, { roleId: "dev", config: camel, nowMs: NOW, changeSummary: "错形状" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("snake_case");
    // 上面那条【本身是分辨得出来的】—— 它第一次就是红的，红在 reason 是那句
    // 「roleId 不一致…config.role_id 是 [undefined]」（那条里没有 snake_case 字样）。
    // 加下面这条不是为了补上面那条的漏，是防另一种实现：有人在那句【不一致】后面
    // 追加一句 snake_case 提示 —— 断言立刻转绿，而主诊断仍然是「角色名拼错」，
    // 读到的那个人仍然会去查角色名。这条防的是「绿了但没修对」。
    expect(!r.ok && r.reason).not.toContain("不一致");
  });

  it("蛇形但角色名真写错 ⇒ 走【不一致】那条（反向对照，钉住两条报错不互相串门）", async () => {
    const { q } = await newQ();
    const r = await saveCharterVersion(q, {
      roleId: "dev",
      config: draft({ role_id: "tech" }),
      nowMs: NOW,
      changeSummary: "角色名写错",
    });
    expect(!r.ok && r.reason).toContain("不一致");
    expect(!r.ok && r.reason).not.toContain("camelCase");
    // 少了这一半，「凡是 role_id 不对就报 camelCase」的实现能让上面两条一起绿。
  });
});

describe("② 读：读不到 vs 读坏了，必须是两种结果", () => {
  it("那一版不存在 ⇒ undefined；存在但 JSON 坏了 ⇒ 抛（两种「没有」修法相反）", async () => {
    const { q, db } = await newQ();
    expect(readCharterConfig(db as never, "dev", 1)).toBeUndefined();
    await saveCharterVersion(q, { roleId: "dev", config: draft(), nowMs: NOW, changeSummary: "v1" });
    // 绕过 appendAudit 那层校验，直写一条坏 config（append-only 表没有 UPDATE 触发器，
    // 这一发是真能发生的：外部改库 / 迁移事故）。
    db.exec("UPDATE role_charters SET config = '{not json' WHERE role_id = 'dev' AND version = 1");
    expect(() => readCharterConfig(db as never, "dev", 1)).toThrow(/不是合法 JSON/u);
    // 反向对照：同一个调用在「那一版根本没有」时**不**抛，而是 undefined。
    expect(() => readCharterConfig(db as never, "dev", 9)).not.toThrow();
  });

  it("assertCharterShape 挡住缺格的旧版（写入时校验过的是【当时】的规则）", () => {
    // 这份就是 test/org/versioning.test.ts 里那个夹具的形状：没有 modelTier。
    expect(() => assertCharterShape("dev", { roleId: "dev", version: 1, acceptanceCriteria: [] })).toThrow(
      /modelTier/u,
    );
    expect(() =>
      assertCharterShape("dev", { roleId: "dev", version: 1, acceptanceCriteria: [], modelTier: "execution" }),
    ).not.toThrow();
  });

  it("上一版坏掉时审计快照留 degraded 而不是把 before 变成 null（null = 「这是第一版」的假事实）", async () => {
    const { q, db } = await newQ();
    await saveCharterVersion(q, { roleId: "dev", config: draft(), nowMs: NOW, changeSummary: "v1" });
    db.exec("UPDATE role_charters SET config = '{broken' WHERE role_id = 'dev' AND version = 1");
    const r = await saveCharterVersion(q, {
      roleId: "dev",
      config: draft({ display_name: "开发二号" }),
      nowMs: NOW + 1,
      changeSummary: "v2",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const snap = JSON.parse(String(db.prepare("SELECT state_snapshot FROM events WHERE id = ?").get(r.auditSeq)?.["state_snapshot"]));
    expect(snap.before?.degraded).toBe(true);
    expect(snap.before).not.toBeNull();
  });
});

describe("③ 门控消费口：Task 3.6 那条 Test 的可测形态", () => {
  it("改 acceptance_criteria ⇒ 同一份产出的门控结论【反过来】（计划 Test 原文）", async () => {
    const { q, db } = await newQ();
    // 第一版：覆盖率 ≥ 80。产出实测 90 ⇒ 该过。
    await saveCharterVersion(q, { roleId: "dev", config: draft(), nowMs: NOW, changeSummary: "阈值 80" });
    const bundle90 = bundle({ coverage: 90 });
    const before = evaluateGate({
      gate: "dev_to_test",
      producer: { roleId: "dev", modelFamily: "claude" },
      reviewer: { roleId: "test", modelFamily: "gpt" },
      bundle: bundle90,
      integrityOk: true,
      criteria: gateCriteriaForRole(db as never, "dev"),
    });
    expect(before.decision).toBe("pass");

    // CEO 把阈值抬到 95 —— **产出一个字没改**。
    await saveCharterVersion(q, {
      roleId: "dev",
      config: draft({ acceptance_criteria: [{ condition: "metric:coverage < 95", action: "reject", message: "覆盖率不足 95" }] }),
      nowMs: NOW + 1,
      changeSummary: "抬到 95",
    });
    const after = evaluateGate({
      gate: "dev_to_test",
      producer: { roleId: "dev", modelFamily: "claude" },
      reviewer: { roleId: "test", modelFamily: "gpt" },
      bundle: bundle90,
      integrityOk: true,
      criteria: gateCriteriaForRole(db as never, "dev"),
    });
    expect(after.decision).toBe("reject");
    // 反向对照（少了这一半，「门控永远 reject」的实现也能让上面那条绿）：
    // 同一个 criteria 换一份达标的产出，必须又变回 pass。
    const passAgain = evaluateGate({
      gate: "dev_to_test",
      producer: { roleId: "dev", modelFamily: "claude" },
      reviewer: { roleId: "test", modelFamily: "gpt" },
      bundle: bundle({ coverage: 99 }),
      integrityOk: true,
      criteria: gateCriteriaForRole(db as never, "dev"),
    });
    expect(passAgain.decision).toBe("pass");
  });

  it("这条变化【只可能】来自库：criteriaFromCharter 与 evaluateGate 都不读库，中间那一步是本模块", () => {
    // 判据：同样的 criteria 数组喂给 evaluateGate，结论与上面一致 ⇒
    // 差异不在门控，在「criteria 从哪来」。
    const mk = (c: string): GateCriterion[] => [{ condition: c, action: "reject", message: "m" }];
    const base = {
      gate: "dev_to_test",
      producer: { roleId: "dev", modelFamily: "claude" },
      reviewer: { roleId: "test", modelFamily: "gpt" },
      integrityOk: true,
    } as const;
    expect(
      evaluateGate({ ...base, bundle: bundle({ coverage: 90 }), criteria: mk("metric:coverage < 80") }).decision,
    ).toBe("pass");
    expect(
      evaluateGate({ ...base, bundle: bundle({ coverage: 90 }), criteria: mk("metric:coverage < 95") }).decision,
    ).toBe("reject");
  });

  it("回放语义：指定版本读那一版，【不退回最新版】", async () => {
    const { q, db } = await newQ();
    await saveCharterVersion(q, { roleId: "dev", config: draft(), nowMs: NOW, changeSummary: "阈值 80" });
    await saveCharterVersion(q, {
      roleId: "dev",
      config: draft({ acceptance_criteria: [{ condition: "metric:coverage < 95", action: "reject", message: "更严" }] }),
      nowMs: NOW + 1,
      changeSummary: "阈值 95",
    });
    expect(gateCriteriaForRoleAtVersion(db as never, "dev", 1)[0]?.condition).toBe("metric:coverage < 80");
    expect(gateCriteriaForRoleAtVersion(db as never, "dev", 2)[0]?.condition).toBe("metric:coverage < 95");
    expect(() => gateCriteriaForRoleAtVersion(db as never, "dev", 7)).toThrow(/刻意不退回最新版/u);
  });

  it("库里一版都没有 ⇒ 抛且不退回 YAML 模板（两个源永远可能不一致）", async () => {
    const { db } = await newQ();
    expect(() => gateCriteriaForRole(db as never, "dev")).toThrow(/没有任何版本/u);
  });

  it("存进去的标准里带 escalate 而无 target ⇒ 写的时候就拒（不留给门控去猜）", async () => {
    const { q } = await newQ();
    const r = await saveCharterVersion(q, {
      roleId: "dev",
      config: draft({ acceptance_criteria: [{ condition: "metric:x > 1", action: "escalate", message: "m" }] }),
      nowMs: NOW,
      changeSummary: "escalate 不给 target",
    });
    expect(r.ok).toBe(false);
  });
});

describe("④ 接线状态", () => {
  it("src 里【还没有】任何地方调用 saveCharterVersion（写侧接线的已知缺口）", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const SRC = join(HUB, "src");
    const walk = (d: string): string[] => {
      const out: string[] = [];
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) out.push(...walk(p));
        else if (n.endsWith(".ts")) out.push(p);
      }
      return out;
    };
    const callers = walk(SRC)
      .filter((f) => !f.endsWith("charter/store.ts"))
      .filter((f) => /saveCharterVersion\(|gateCriteriaForRole\(/u.test(readFileSync(f, "utf8")));
    // 与 0014 §3 同一条：这条【今天成立】，接上那天它会红，逼着接的人同时更新文档。
    expect(callers.map((f) => f.replace(SRC + "/", ""))).toEqual([]);
  });

  it("保存岗位书【同时】把 budget 落进 budgets 表（否则屏幕显示新数字而执行侧按老数字放行）", async () => {
    const { q, db } = await newQ();
    // 先摆一格老限流（模拟 tracker 或上一次同步留下的）
    await seed(db, [
      "INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, consumed_cents, hard_stop) " +
        "VALUES ('role|dev|daily','role','dev','daily',9999,0,1)",
    ]);
    const r = await saveCharterVersion(q, {
      roleId: "dev",
      config: draft({ budget: { daily_usd: 5, per_task_usd: 2 } }),
      nowMs: NOW,
      changeSummary: "开发日预算降到 $5",
    });
    expect(r.ok).toBe(true);
    expect(limitOf(db, "role", "dev", "daily")).toBe(500);
    expect(limitOf(db, "role", "dev", "per_task")).toBe(200);
    // 落库结果挂在【同一条】审计上，不另开一条事件（岗位书变更与限流变更同生同死）。
    const ev = db.prepare("SELECT * FROM events WHERE id = ?").get(
      (r as { auditSeq: number }).auditSeq,
    );
    const payload = JSON.parse(String(ev?.["payload"])) as Record<string, unknown>;
    expect((payload["limits_applied"] as unknown[]).length).toBe(2);
    expect(Number(db.prepare("SELECT COUNT(*) c FROM events").get()?.["c"])).toBe(1);
  });

  it("applyBudgets:false ⇒ 只存岗位书、【不动】限流表（两种失败形状都要能表达）", async () => {
    const { q, db } = await newQ();
    await saveCharterVersion(q, {
      roleId: "dev",
      config: draft({ budget: { daily_usd: 5, per_task_usd: 2 } }),
      nowMs: NOW,
      changeSummary: "只存不生效",
      applyBudgets: false,
    });
    expect(limitOf(db, "role", "dev", "daily")).toBeUndefined();
  });

  it("半分钱预算 ⇒ 整笔保存被拒，岗位书一行【都不写】（换算提前到事务外）", async () => {
    const { q, db } = await newQ();
    const r = await saveCharterVersion(q, {
      roleId: "dev",
      // charterSchema 允许 0.005（非负数），拦得住它的只有美分换算那一层
      config: draft({ budget: { daily_usd: 0.005, per_task_usd: 5 } }),
      nowMs: NOW,
      changeSummary: "半分钱",
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("岗位书本身合法");
    // 关键是这条：校验失败必须与岗位书写入【一起】不发生。
    // 只测「被拒」而岗位书已落库 = 版本序列里多了一版跑不过预算换算的配置。
    expect(Number(db.prepare("SELECT COUNT(*) c FROM role_charters").get()?.["c"])).toBe(0);
    expect(Number(db.prepare("SELECT COUNT(*) c FROM budgets").get()?.["c"])).toBe(0);
    expect(Number(db.prepare("SELECT COUNT(*) c FROM events").get()?.["c"])).toBe(0);
  });

  it("调低预算到已消费量之下 ⇒ 审计里 alarm_silenced 点名那一格（警报哑了必须被说出来）", async () => {
    const { q, db } = await newQ();
    await seed(db, [
      "INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, consumed_cents, hard_stop) " +
        "VALUES ('role|dev|daily','role','dev','daily',1500,2000,1)",
    ]);
    const r = await saveCharterVersion(q, {
      roleId: "dev",
      config: draft({ budget: { daily_usd: 5, per_task_usd: 2 } }),
      nowMs: NOW,
      changeSummary: "收到 $5，而今天已花 $20",
    });
    const payload = JSON.parse(
      String(db.prepare("SELECT payload FROM events WHERE id = ?").get(
        (r as { auditSeq: number }).auditSeq,
      )?.["payload"]),
    ) as Record<string, unknown>;
    expect(payload["alarm_silenced"]).toEqual(["role|dev|daily"]);
  });

  it("这条通道【不经过】任何 HTTP / 组织图路径（今天它是孤岛，接上那天这条会红）", async () => {
    // 见 0015 §3。与 ④ 第一条同族：钉住【今天成立】，而不是假装已接上。
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const walk = (d: string): string[] => {
      const out: string[] = [];
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) out.push(...walk(p));
        else if (n.endsWith(".ts")) out.push(p);
      }
      return out;
    };
    const callers = walk(join(HUB, "src"))
      .filter((f) => !f.includes("/charter/"))
      .filter((f) => /applyBudgetRowsInTx\(|from ".*charter\/budget-sync/u.test(readFileSync(f, "utf8")));
    expect(callers.map((f) => f.replace(join(HUB, "src") + "/", ""))).toEqual([]);
  });
  it("读回不做二次校验这件事：库里那份与 validateCharterDraft 放行的那份逐字节相同", async () => {
    const { q, db } = await newQ();
    const v = validateCharterDraft("dev", draft());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    await saveCharterVersion(q, { roleId: "dev", config: draft(), nowMs: NOW, changeSummary: "v1" });
    // 归一化只发生一次：写入前一次，读回来应当与它完全相同。
    expect(readLatestCharter(db as never, "dev")).toEqual(v.charter);
  });
});

afterAll(() => {
  for (const q of queues) {
    try {
      (q as unknown as { close?: () => void | Promise<void> }).close?.();
    } catch {
      /* 关掉失败不影响别的 */
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});
