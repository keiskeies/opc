/**
 * 岗位书预算 → budgets 三级限额（Task 3.6「预算层级」那一半）。
 *
 * 本文件最值得读的是 ① 那节：它钉的不是「我写的函数能用」，而是
 * **Tracker.declareLimit 在这个用途上会静默失效**（文件头 ①），
 * 以及 **把上限调低会永久关闭突破警报**（文件头 ②）。
 * 两条都是实测来的，都在 tracker.ts 既有语义之内（不是它的 bug，
 * 是它的语义放到「编辑器保存」这个场景里的后果）。
 *
 * 夹具两条腿：
 *  - 限额写入与审计 → 真 WriteQueue（syncCharterBudgets 要求「已在事务里」）；
 *  - 与 BudgetTracker 的连通性 → 真 openDb + 真 StepTx + 真总线（照搬
 *    test/budget/tracker.test.ts:120-144 那套，理由在它自己文件头写着：
 *    手搓假总线会跳过 seq 递增校验，于是「事件带了个假 seq」这种真 bug 全绿）。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { fixtureTmp } from "../fixtures/fixture-dir.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { migrate } from "../../src/db/migrate.js";
import { openDb } from "../../src/db/driver.js";
import { AuditRecorder, type StepTx } from "../../src/events/recorder.js";
import { InMemoryEventBus } from "../../src/events/bus.js";
import { BudgetTracker } from "../../src/budget/tracker.js";
import {
  budgetRowId,
  budgetRowsFromCharter,
  budgetTierSummary,
  BUDGET_SYNC_AUDIT_KIND,
  readBudgetTiers,
  silentOverBudgets,
  syncCharterBudgets,
  upsertLimit,
  usdToCents,
} from "../../src/charter/budget-sync.js";
import { charterSchema, type CharterInput } from "@opc/contracts";

const HUB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TMP = fixtureTmp("budget-sync", import.meta.url);
mkdirSync(TMP, { recursive: true });

type Row = Record<string, unknown>;
type AnyDb = {
  prepare: (sql: string) => {
    all: (...a: unknown[]) => Row[];
    get: (...a: unknown[]) => Row | undefined;
    run: (...a: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
  };
  exec: (sql: string) => void;
  close: () => void;
};

const NOW = Date.UTC(2026, 2, 1);
const queues: WriteQueue[] = [];
const conns: AnyDb[] = [];
let fileSeq = 0;

const path = (): string => join(TMP, "bs-" + process.pid + "-" + ++fileSeq + ".db");

async function newQ(): Promise<{ q: WriteQueue; db: AnyDb }> {
  const q = new WriteQueue(path()) as WriteQueue;
  queues.push(q);
  const db = (q as unknown as { writeConnection: () => AnyDb }).writeConnection();
  migrate(db as never);
  return { q, db };
}

/** 真 openDb + 真 StepTx + 真总线（与 tracker.test.ts 同一套，见文件头）。 */
async function newTracker(): Promise<{
  db: AnyDb;
  tracker: BudgetTracker;
  recorder: AuditRecorder;
  run: <T>(fn: () => Promise<T>) => Promise<T>;
}> {
  const db = openDb(path()) as unknown as AnyDb;
  conns.push(db);
  migrate(db as never);
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
      "VALUES ('T-1','预算夹具','IN_PROGRESS','dev','implement',?,?)",
  ).run(NOW, NOW);
  const als = new AsyncLocalStorage<{ db: DatabaseSync }>();
  let open = false;
  const tx: StepTx = {
    begin: async () => {
      db.exec("BEGIN IMMEDIATE");
      open = true;
    },
    commit: async () => {
      db.exec("COMMIT");
      open = false;
    },
    rollback: async () => {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* SQLite 自己已中止 */
      }
      open = false;
    },
    scope: <T,>(fn: () => Promise<T>): Promise<T> => als.run({ db }, fn),
    inTx: () => open,
    db: () => {
      const s = als.getStore();
      if (s === undefined) throw new Error("SCOPE-MISS");
      return s.db as unknown as DatabaseSync;
    },
  };
  const bus = new InMemoryEventBus();
  const recorder = new AuditRecorder({
    tx,
    bus,
    now: () => NOW,
    onBroadcastError: (e) => {
      throw e;
    },
  });
  // 直接给真连接（同 tracker.test.ts:159）：BEGIN 就发在这条连接上，
  // 所以 tracker 自己 prepare 的语句天然落在同一个事务里，不需要代理层。
  const tracker = new BudgetTracker({
    db: db as unknown as DatabaseSync,
    recorder,
    now: () => NOW,
  });
  return {
    db,
    tracker,
    recorder,
    run: <T,>(fn: () => Promise<T>): Promise<T> => recorder.run(fn),
  };
}

const limitOf = (db: AnyDb, scope: string, scopeId: string, period: string): number | undefined => {
  const r = db
    .prepare("SELECT limit_cents FROM budgets WHERE scope_type=? AND scope_id=? AND period=?")
    .get(scope, scopeId, period);
  return r === undefined ? undefined : Number(r["limit_cents"]);
};

describe("① declareLimit 在「保存新预算」这个场景里会静默失效（实测钉住）", () => {
  it("tracker.declareLimit 第二次声明【不生效】：症状是保存成功、数字没变、零报错", async () => {
    const { tracker } = await newTracker();
    tracker.declareLimit({ scope: "role", scopeId: "dev", period: "daily", limitCents: 1000 });
    tracker.declareLimit({ scope: "role", scopeId: "dev", period: "daily", limitCents: 2000 });
    // 这条断言是【关于别人的行为】的，它红了说明 tracker.ts 的 ON CONFLICT 语义变了。
    // 那时本模块的 upsertLimit 仍然正确，但文件头 ① 那段理由要重写 —— 所以让它红。
    expect(tracker.limitCents("role", "dev", "daily")).toBe(1000);
  });

  it("upsertLimit 真的改到了；而 declareLimit 改不到的那一格，改完 tracker 立刻读到新值", async () => {
    const { db, tracker, run } = await newTracker();
    tracker.declareLimit({ scope: "role", scopeId: "dev", period: "daily", limitCents: 1000 });
    await run(async () => {
      const r = upsertLimit(db as unknown as DatabaseSync, {
        scope: "role",
        scopeId: "dev",
        period: "daily",
        limitCents: 2000,
      });
      expect(r).toMatchObject({ changed: true, previousLimitCents: 1000, nowOver: false });
    });
    // 判据来自【执行侧】而不是本模块自己的读：tracker 是真正拿这个数判超限的人。
    expect(tracker.limitCents("role", "dev", "daily")).toBe(2000);
    expect(limitOf(db, "role", "dev", "daily")).toBe(2000);
    // 反向对照：没被 upsert 过的另一个作用域仍然没有行（不是「全都跟着变了」）。
    expect(limitOf(db, "role", "test", "daily")).toBeUndefined();
  });

  it("写入的值与旧值【完全相同】⇒ changed=false（SQLite 的 changes 分辨不出，只能读旧值比）", async () => {
    const { db, run } = await newTracker();
    await run(async () => {
      upsertLimit(db as unknown as DatabaseSync, {
        scope: "role",
        scopeId: "dev",
        period: "daily",
        limitCents: 1000,
      });
    });
    // 先证明 SQLite 本身给不出这个信息：同值 UPSERT 的 changes 也是 1。
    // 少了这一发，「changed=false」会被读成「UPSERT 没匹配到行」，
    // 而实现只要改成看 changes 就既绿又错。
    const same = db
      .prepare(
        "INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, consumed_cents, hard_stop) " +
          "VALUES ('role|dev|daily','role','dev','daily',1000,0,1) " +
          "ON CONFLICT(scope_type, scope_id, period) DO UPDATE SET limit_cents = excluded.limit_cents",
      )
      .run();
    expect(Number(same.changes)).toBe(1);
    await run(async () => {
      const r = upsertLimit(db as unknown as DatabaseSync, {
        scope: "role",
        scopeId: "dev",
        period: "daily",
        limitCents: 1000,
      });
      expect(r.changed).toBe(false);
      expect(r.previousLimitCents).toBe(1000);
    });
  });
});

describe("② 调低上限会永久关闭突破警报（本文件最重要的一节）", () => {
  it("实测三段式：跨过 ⇒ 1 条 BudgetPaused；调低到已消费量之下 ⇒ 不加新事件；再消费 ⇒ breached 仍 false", async () => {
    const { db, tracker, run } = await newTracker();
    const o = { scope: "role" as const, scopeId: "dev", period: "daily" as const };
    const paused = (): number =>
      Number(
        db.prepare("SELECT COUNT(*) c FROM events WHERE action = 'budget_consume'").get()?.["c"] ?? 0,
      );

    tracker.declareLimit({ ...o, limitCents: 1000 });
    const r1 = await run(() =>
      tracker.consume({ sourceEvent: 100001, ...o, amountCents: 1200, taskId: "T-1" }),
    );
    expect({ breached: r1.breached, over: r1.over, paused: paused() }).toEqual({
      breached: true,
      over: true,
      paused: 1,
    });

    await run(async () => {
      const low = upsertLimit(db as unknown as DatabaseSync, { ...o, limitCents: 500 });
      // 这一格现在超限，而**没有任何东西会再为它发声**。
      expect(low.nowOver).toBe(true);
    });
    expect(paused()).toBe(1);

    const r2 = await run(() =>
      tracker.consume({ sourceEvent: 100002, ...o, amountCents: 100, taskId: "T-1" }),
    );
    expect({ applied: r2.applied, breached: r2.breached, over: r2.over, paused: paused() }).toEqual({
      applied: true,
      breached: false,
      over: true,
      paused: 1,
    });
  });

  it("syncCharterBudgets 把这件事【说出来】：alarmSilenced=true，且进审计 payload", async () => {
    const { q, db } = await newQ();
    await q.tx([
      [
        "INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, consumed_cents, hard_stop) " +
          "VALUES ('role|dev|daily','role','dev','daily',1500,2000,1)",
        [],
      ],
    ]);
    const r = await syncCharterBudgets(q, {
      rows: [{ scope: "role", scopeId: "dev", period: "daily", limitCents: 500 }],
      nowMs: NOW,
      changeSummary: "把开发日预算从 $15 收到 $5",
    });
    expect(r.rows[0]).toMatchObject({
      previousLimitCents: 1500,
      limitCents: 500,
      changed: true,
      nowOver: true,
      alarmSilenced: true,
    });
    const payload = JSON.parse(
      String(db.prepare("SELECT payload FROM events WHERE id = ?").get(r.auditSeq)?.["payload"]),
    ) as Record<string, unknown>;
    expect(payload["alarm_silenced"]).toEqual(["role|dev|daily"]);

    // 反向对照（少了它，「凡是写入都报 alarmSilenced」的实现也能绿）：
    // 同一格处在【未超限】状态时必须是 false。
    const ok = await syncCharterBudgets(q, {
      rows: [{ scope: "role", scopeId: "test", period: "daily", limitCents: 500 }],
      nowMs: NOW + 1,
      changeSummary: "测试角色首次配预算",
    });
    expect(ok.rows[0]?.alarmSilenced).toBe(false);
    expect(ok.rows[0]?.nowOver).toBe(false);
  });

  it("第一版预算（原先没有这一格）不算 alarmSilenced：从没响过的警报谈不上被关掉", async () => {
    const { q } = await newQ();
    const r = await syncCharterBudgets(q, {
      rows: [{ scope: "role", scopeId: "dev", period: "daily", limitCents: 100 }],
      nowMs: NOW,
      changeSummary: "第一版",
    });
    expect(r.rows[0]?.previousLimitCents).toBeNull();
    expect(r.rows[0]?.nowOver).toBe(false);
    expect(r.rows[0]?.alarmSilenced).toBe(false);
  });

  it("silentOverBudgets 是补救的读侧：把哑掉的格列出来，按超出量从大到小", async () => {
    const { db } = await newQ();
    await q(db, [
      "INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, consumed_cents, hard_stop) " +
        "VALUES ('role|dev|daily','role','dev','daily',100,500,1)",
      "INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, consumed_cents, hard_stop) " +
        "VALUES ('role|ops|daily','role','ops','daily',100,900,1)",
      // 这一行没超限，必须【不】出现在结果里（反向对照）
      "INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, consumed_cents, hard_stop) " +
        "VALUES ('role|test|daily','role','test','daily',1000,200,1)",
    ]);
    const rows = silentOverBudgets(db as unknown as DatabaseSync);
    expect(rows.map((r) => r.scopeId)).toEqual(["ops", "dev"]);
    expect(rows.every((r) => r.consumedCents > (r.limitCents ?? 0))).toBe(true);
  });
});

describe("③ USD → 美分（实测 271/2001 个两位小数直接乘不是整数）", () => {
  it("0.07 这类浮点陷阱能过；半分钱被拒且报错说明为什么不 round", () => {
    // 元断言（0013 §8 那条规矩）：先证明【朴素写法】真的会坏。
    // 少了这一发，将来有人把容差判据说成「防御性代码」删掉，用例也不会红。
    const broken: number[] = [];
    for (let i = 0; i <= 2000; i++) {
      const raw = (i / 100) * 100;
      if (!Number.isInteger(raw)) broken.push(i / 100);
    }
    expect(broken.length).toBe(271);
    expect(broken).toContain(0.07);

    expect(usdToCents(0.07)).toBe(7);
    expect(usdToCents(15)).toBe(1500);
    expect(usdToCents(0)).toBe(0);
    expect(() => usdToCents(0.005, "日预算")).toThrow(/半分钱|美分为最小单位/u);
    expect(() => usdToCents(-1, "日预算")).toThrow(/不得为负/u);
    expect(() => usdToCents(Number.NaN, "日预算")).toThrow(/有限数值/u);
    expect(() => usdToCents(Number.POSITIVE_INFINITY, "日预算")).toThrow(/有限数值/u);
  });

  it("2001 个两位小数全部可换算，且【没有一个】被静默改动", () => {
    for (let i = 0; i <= 2000; i++) {
      const usd = i / 100;
      // 精确口径是 i（i 美分），不是「round 之后随便对不对」
      expect(usdToCents(usd, "第 " + usd + " 美元")).toBe(i);
    }
  });

  it("岗位书那两格 → 两行 role 级；不出公司级也不出任务级（规格没给默认值）", () => {
    const parsed = charterSchema.safeParse(presetCharter());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const rows = budgetRowsFromCharter(parsed.data);
    expect(rows).toEqual([
      { scope: "role", scopeId: "dev", period: "daily", limitCents: 1500 },
      { scope: "role", scopeId: "dev", period: "per_task", limitCents: 500 },
    ]);
    // 反向对照：公司级/任务级【没有】出现。它们出现就意味着有人替 CEO 定了公司预算。
    expect(rows.some((r) => r.scope === "company")).toBe(false);
    expect(rows.some((r) => r.scope === "task")).toBe(false);
  });

  it("预算写了半分钱 ⇒ 整份岗位书同步被拒（而不是悄悄抬成一分钱）", () => {
    const c = presetCharter();
    const parsed = charterSchema.safeParse({
      ...c,
      budget: { daily_usd: 0.005, per_task_usd: 5 },
    });
    // charterSchema 允许任意非负数（半分钱在 schema 面上合法），
    // 所以拦得住它的只能是本模块 —— 这正是这条用例的意义。
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(() => budgetRowsFromCharter(parsed.data)).toThrow(/半分钱|美分为最小单位/u);
  });
});

describe("④ 审计：一次保存一条，署名是人", () => {
  it("一批两行 ⇒ events 只多【一条】，action=state_change，payload.kind 点名这件事", async () => {
    const { q, db } = await newQ();
    const before = Number(db.prepare("SELECT COUNT(*) c FROM events").get()?.["c"] ?? 0);
    const r = await syncCharterBudgets(q, {
      rows: [
        { scope: "role", scopeId: "dev", period: "daily", limitCents: 1500 },
        { scope: "role", scopeId: "dev", period: "per_task", limitCents: 500 },
      ],
      nowMs: NOW,
      changeSummary: "按新岗位书同步开发预算",
    });
    expect(Number(db.prepare("SELECT COUNT(*) c FROM events").get()?.["c"] ?? 0)).toBe(before + 1);
    const ev = db.prepare("SELECT * FROM events WHERE id = ?").get(r.auditSeq);
    expect(ev?.["actor_type"]).toBe("human");
    expect(ev?.["actor_id"]).toBe("ceo");
    expect(ev?.["action"]).toBe("state_change");
    expect(ev?.["task_id"]).toBeNull();
    const payload = JSON.parse(String(ev?.["payload"])) as Record<string, unknown>;
    expect(payload["kind"]).toBe(BUDGET_SYNC_AUDIT_KIND);
    expect(payload["row_count"]).toBe(2);
    expect(ev?.["target"]).toBe("budgets@2");
    const snap = JSON.parse(String(ev?.["state_snapshot"])) as {
      before: Record<string, number | null>;
      after: Record<string, number>;
    };
    expect(snap.before[budgetRowId("role", "dev", "daily")]).toBeNull();
    expect(snap.after[budgetRowId("role", "dev", "per_task")]).toBe(500);
  });

  it("空 rows / 重复 rows / 空摘要 ⇒ 一律拒，且不留下任何事件", async () => {
    const { q, db } = await newQ();
    const before = Number(db.prepare("SELECT COUNT(*) c FROM events").get()?.["c"] ?? 0);
    await expect(syncCharterBudgets(q, { rows: [], nowMs: NOW, changeSummary: "空" })).rejects.toThrow(
      /什么都没改/u,
    );
    await expect(
      syncCharterBudgets(q, {
        rows: [
          { scope: "role", scopeId: "dev", period: "daily", limitCents: 100 },
          { scope: "role", scopeId: "dev", period: "daily", limitCents: 200 },
        ],
        nowMs: NOW,
        changeSummary: "重复",
      }),
    ).rejects.toThrow(/同一个作用域出现了两次/u);
    await expect(
      syncCharterBudgets(q, {
        rows: [{ scope: "role", scopeId: "dev", period: "daily", limitCents: 100 }],
        nowMs: NOW,
        changeSummary: "   ",
      }),
    ).rejects.toThrow(/changeSummary/u);
    expect(Number(db.prepare("SELECT COUNT(*) c FROM events").get()?.["c"] ?? 0)).toBe(before);
    expect(Number(db.prepare("SELECT COUNT(*) c FROM budgets").get()?.["c"] ?? 0)).toBe(0);
  });

  it("同一作用域出现两次这件事【本来会】怎么错：第二行的 previous 会读到第一行刚写的值", async () => {
    // 这条不测 syncCharterBudgets（它已经拒了），测【为什么必须拒】：
    // 直接两次 upsert，第二次拿到的 previous 就是第一次写的数。
    // 没这条，「拒重复」看起来像过度谨慎，将来会被当成多余检查删掉。
    const { db, run } = await newTracker();
    await run(async () => {
      const d = db as unknown as DatabaseSync;
      const a = upsertLimit(d, { scope: "role", scopeId: "dev", period: "daily", limitCents: 100 });
      const b = upsertLimit(d, { scope: "role", scopeId: "dev", period: "daily", limitCents: 200 });
      expect(a.previousLimitCents).toBeNull();
      // 若一批里允许重复，审计的 before 会记成 100 而真实保存前是【无此行】。
      expect(b.previousLimitCents).toBe(100);
      expect(b.changed).toBe(true);
    });
  });
});

describe("⑤ 读侧：「显示与编辑一致」要求「没声明」与「0」是两种值", () => {
  it("没声明 ⇒ declared:false + limit null；声明为 0 ⇒ declared:true + limit 0", async () => {
    const { q, db } = await newQ();
    await syncCharterBudgets(q, {
      rows: [{ scope: "role", scopeId: "ops", period: "daily", limitCents: 0 }],
      nowMs: NOW,
      changeSummary: "运营暂停花钱",
    });
    const tiers = readBudgetTiers(db as unknown as DatabaseSync, [
      { scope: "role", scopeId: "dev", period: "daily" },
      { scope: "role", scopeId: "ops", period: "daily" },
    ]);
    expect(tiers[0]).toEqual({
      scope: "role",
      scopeId: "dev",
      period: "daily",
      limitCents: null,
      consumedCents: 0,
      declared: false,
    });
    expect(tiers[1]).toMatchObject({ declared: true, limitCents: 0 });
    // 界面措辞的反面：这两行若都是 0，「这个角色没配预算」会显示成「这个角色预算是 0」。
    expect(tiers[0]?.limitCents).not.toBe(tiers[1]?.limitCents);
  });

  it("consumed 从库里如实带出，且 NULL 读成 0（DDL 的 DEFAULT 挡不住显式 INSERT NULL）", async () => {
    const { db } = await newQ();
    await q(db, [
      "INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, consumed_cents, hard_stop) " +
        "VALUES ('task|T-1|per_task','task','T-1','per_task',900,NULL,1)",
    ]);
    const t = readBudgetTiers(db as unknown as DatabaseSync, [
      { scope: "task", scopeId: "T-1", period: "per_task" },
    ]);
    expect(t[0]).toMatchObject({ declared: true, limitCents: 900, consumedCents: 0 });
  });

  it("budgetTierSummary 报告【声明情况】而不是推断默认值：公司级没声明就报 false", async () => {
    const { q, db } = await newQ();
    db.prepare(
      "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
        "VALUES ('T-9','t','IN_PROGRESS','dev','implement',?,?)",
    ).run(NOW, NOW);
    const s0 = budgetTierSummary(db as unknown as DatabaseSync);
    expect(s0).toEqual({ companyDeclared: false, roleDeclared: 0, taskDeclared: 0, undeclaredRoles: 1 });
    await syncCharterBudgets(q, {
      rows: [
        { scope: "role", scopeId: "dev", period: "daily", limitCents: 1500 },
        { scope: "company", scopeId: "company", period: "monthly", limitCents: 100000 },
      ],
      nowMs: NOW,
      changeSummary: "公司级由 CEO 显式给",
    });
    const s1 = budgetTierSummary(db as unknown as DatabaseSync);
    expect(s1).toEqual({ companyDeclared: true, roleDeclared: 1, taskDeclared: 0, undeclaredRoles: 0 });
  });
});

describe("⑥ 与执行侧的连通：同步完，BudgetTracker 判超限用的就是这个新值", () => {
  it("同步 → 新上限【立刻】参与判定（这条才叫「编辑与生效一致」）", async () => {
    const { db, tracker, run } = await newTracker();
    tracker.declareLimit({ scope: "role", scopeId: "dev", period: "daily", limitCents: 10000 });
    // 先按宽上限花 3000（不超限）
    const a = await run(() =>
      tracker.consume({ sourceEvent: 200001, scope: "role", scopeId: "dev", period: "daily", amountCents: 3000, taskId: "T-1" }),
    );
    expect({ breached: a.breached, over: a.over }).toEqual({ breached: false, over: false });

    // CEO 收到 $20（2000 分）—— 走本模块的写入口
    await run(async () => {
      const r = upsertLimit(db as unknown as DatabaseSync, {
        scope: "role",
        scopeId: "dev",
        period: "daily",
        limitCents: 2000,
      });
      expect({ nowOver: r.nowOver, changed: r.changed }).toEqual({ nowOver: true, changed: true });
    });

    // 执行侧读到的就是这个新数
    expect(tracker.limitCents("role", "dev", "daily")).toBe(2000);
    // 再花一分钱 ⇒ 判定确实按新上限走（over=true）。
    // 但注意它【不会】发 BudgetPaused —— 那就是 ② 那节的事，在这里再验一次是因为
    // 「编辑与生效一致」的完整答案包含两半：判定生效了，警报没响。
    const b = await run(() =>
      tracker.consume({ sourceEvent: 200002, scope: "role", scopeId: "dev", period: "daily", amountCents: 1, taskId: "T-1" }),
    );
    expect({ over: b.over, breached: b.breached }).toEqual({ over: true, breached: false });
    // 反向对照：没同步过的另一个角色仍然【没有行】，limitCents 应当抛而不是默认放行
    expect(() => tracker.limitCents("role", "ops", "daily")).toThrow(/没有声明预算上限/u);
  });
});

describe("⑦ 接线状态：与 0014 §3 同一条，钉住【今天成立】而不是假装已接上", () => {
  it("src 里【还没有】任何地方调用本模块的写入口（接上那天这条会红，逼着同时更新 0015）", async () => {
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
      // 排除整个 charter/ 目录而不是只排除本文件：saveCharterVersion 现在会调
      // budgetRowsFromCharter（岗位书的预算必须同时落进 budgets，见 store.ts 文件头 D）。
      // 那是【同一个还没接进生产的小模块内部】的调用，不构成「已接线」。
      // 我要钉的命题是「charter/ 之外没有任何人用这些入口」，判据必须与命题同宽。
      .filter((f) => !f.includes("/charter/"))
      .filter((f) =>
        /syncCharterBudgets\(|upsertLimit\(|budgetRowsFromCharter\(|readBudgetTiers\(|applyBudgetRowsInTx\(/u.test(
          readFileSync(f, "utf8"),
        ),
      );
    expect(callers.map((f) => f.replace(SRC + "/", ""))).toEqual([]);
  });

  it("本模块【不改】tracker：declareLimit 与 consume 的源码里没有被本模块塞进去的东西", async () => {
    // 防的是另一种「做到了」：有人为了让 alarmSilenced 真的报警，去改
    // tracker.ts 的 breached 判据 —— 那会换掉 Task 1.6 已验收的「不重复发事件」行为，
    // 而那是产品问题（收件箱刷屏 vs 警报永久哑），归 CEO（0015 登记）。
    const { readFileSync } = await import("node:fs");
    const t = readFileSync(join(HUB, "src", "budget", "tracker.ts"), "utf8");
    expect(t).not.toContain("charter/budget-sync");
    expect(t).toContain("before <= limit && after > limit");
  });
});
function presetCharter(): CharterInput {
  return {
    role_id: "dev",
    display_name: "开发",
    version: 1,
    honesty_boundaries: ["不谎报测试结果"],
    acceptance_criteria: [{ condition: "metric:p0_defect_count != 0", action: "reject", message: "有 P0" }],
    forbidden_actions: [],
    tool_permissions: ["read"],
    model_tier: "execution",
    budget: { daily_usd: 15, per_task_usd: 5 },
    decision_scope: { autonomous: [], requires_consultation: [], forbidden: [] },
    judgment_mode: { type: "strict_rules", strict_rules: [], bounded_judgment: [], full_discretion: [] },
    escalation_triggers: [],
  };
}

/** 在一个事务里跑几条裸语句（夹具用）。 */
async function q(db: AnyDb, stmts: readonly string[]): Promise<void> {
  await new Promise<void>((res, rej) => {
    try {
      db.exec("BEGIN IMMEDIATE");
      for (const s of stmts) db.exec(s);
      db.exec("COMMIT");
      res();
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* noop */
      }
      rej(e);
    }
  });
}

afterAll(async () => {
  for (const x of queues) {
    try {
      await (x as unknown as { close?: () => Promise<void> | void }).close?.();
    } catch {
      /* 关掉失败不影响别的 */
    }
  }
  for (const c of conns) {
    try {
      await Promise.resolve(c.close());
    } catch {
      /* 同上 */
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});
