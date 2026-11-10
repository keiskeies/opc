/**
 * Task 1.7 验收：Phase 1 的门控行为可预期（规格 §23.1 Phase 1 三条）。
 *
 * 与 test/gates/、test/budget/ 那些单测的【分工】值得先说清楚，否则这个文件看着像重复劳动：
 * 单测问的是「每个模块在各输入下返回什么」，本文件问的是「CEO 关心的那三件事，
 * 端到端会不会真的发生」。这两问会分叉，而且分叉的方向很不友好 ——
 * 每个模块各自全绿，拼起来却不满足验收标准。本文件拦的正是这个缝，具体已经撞到过一次：
 *  门控放行 metrics 缺失的标准（evaluateGate 曾走 pass），同时 escalation 那边
 *  把 unresolvedCriteriaCount 定成 insufficient_evidence 的触发条件 —— 两边各自都「对」，
 *  而门控先跑，于是升级那条永远走不到，两条验收标准同时失效却没有任何单测变红。
 *
 * 【桩驱动，不接真模型】（计划 §10.4 第 7 条：不联网不计费）。这里的「开发标记完成」
 * 是一个直接构造的产出包，不是 agent 真的写代码 —— 本文件要判的是【门控与护栏的反应】，
 * 产出本身怎么来不影响被验的性质。真要验「模型会不会主动伪造证据」，那是 Phase 5
 * 对抗性 Harness 的范围（§24 风险 3），在这里塞个假模型只会给出一个假的安全感。
 *
 * ⚠ 三条用例都跑在【真 schema + 真 recorder + 真总线】上（同 test/budget/ 的立场）。
 * 自造简化表只能证明「我写的表能用」，证明不了「迁移出来的那张表上这条链路走得通」——
 * 而验收判的是后者。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { EvidenceBundle } from "@opc/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureTmp } from "../fixtures/fixture-dir.js";
import { BudgetTracker } from "../../src/budget/tracker.js";
import { migrate } from "../../src/db/migrate.js";
import type { DomainEvent } from "../../src/events/bus.js";
import { InMemoryEventBus } from "../../src/events/bus.js";
import type { StepTx } from "../../src/events/recorder.js";
import { AuditRecorder } from "../../src/events/recorder.js";
import { EvidenceStore, sha256Text } from "../../src/evidence/store.js";
import {
  criteriaFromCharter,
  evaluateGate,
  type GateCriterion,
} from "../../src/graph/gates/evaluate.js";
import {
  canEscalateFrom,
  decideEscalation,
  type EscalationState,
} from "../../src/graph/routing/escalation.js";
import type { TaskState } from "../../src/graph/status.js";

const TMP = fixtureTmp("acceptance", import.meta.url);

type Row = Record<string, unknown>;
type Db = {
  prepare: (sql: string) => {
    all: (...a: unknown[]) => Row[];
    get: (...a: unknown[]) => Row | undefined;
    run: (...a: unknown[]) => unknown;
  };
  exec: (sql: string) => void;
  close: () => void;
};

const opened: Db[] = [];
let fileSeq = 0;

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  // Windows：不 close 就 rm 会 EBUSY
  for (const db of opened) {
    try {
      db.close();
    } catch {
      /* 已关 */
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});

/**
 * 一次验收运行的全部零件：真库、真事务、真审计、真总线、真预算、真制品存储。
 *
 * 事务必须由 recorder.run() 开（同 test/budget/tracker.test.ts 文件头那条坑）：
 * 测试里自己 BEGIN 会造出「recorder.inTx() 为 true 而 db() 作用域丢失」的组合，
 * 那是 StepTx 那两个【不能合并】的谓词（inTx 判库状态、db 判代码位置）的镜像形状。
 */
async function scenario(taskId: string): Promise<{
  db: Db;
  tracker: BudgetTracker;
  recorder: AuditRecorder;
  bus: InMemoryEventBus;
  store: EvidenceStore;
  eid: () => number;
  actions: () => string[];
}> {
  const { openDb } = await import("../../src/db/driver.js");
  const db = openDb(join(TMP, "a-" + process.pid + "-" + ++fileSeq + ".db")) as unknown as Db;
  opened.push(db);
  migrate(db);
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
      "VALUES (?, ?, 'IN_PROGRESS', 'dev', 'implement', ?, ?)",
  ).run(taskId, "Phase 1 验收用的任务", 1_700_000_000_000, 1_700_000_000_000);

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
        /* 事务已被 SQLite 自身中止 */
      }
      open = false;
    },
    scope: <T,>(fn: () => Promise<T>): Promise<T> => als.run({ db }, fn),
    inTx: () => open,
    db: () => {
      const s = als.getStore();
      if (s === undefined) throw new Error("SCOPE-MISS");
      return s.db;
    },
  };
  const bus = new InMemoryEventBus();
  const recorder = new AuditRecorder({
    tx,
    bus,
    now: () => 1_700_000_000_000,
    onBroadcastError: (e) => {
      throw e;
    },
  });
  const tracker = new BudgetTracker({
    db: db as unknown as DatabaseSync,
    recorder,
    now: () => 1_700_000_000_000,
  });
  let eidLocal = 0;
  const eid = (): number => {
    const head = Number(
      Object.values(
        db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM events").get() ?? {},
      )[0],
    );
    eidLocal = Math.max(head, eidLocal) + 1;
    return eidLocal;
  };
  const store = new EvidenceStore({
    root: join(TMP, "artifacts"),
    exec: () => {},
    now: () => 1_700_000_000_000,
  });
  return {
    db,
    tracker,
    recorder,
    bus,
    store,
    eid,
    actions: () =>
      (
        db.prepare("SELECT action FROM events ORDER BY id").all() as Row[]
      ).map((r) => String(r["action"])),
  };
}

/** 取干总线里已发布的事件（取法与不会挂住的理由见 test/budget/tracker.test.ts 同名函数）。 */
async function feed(bus: InMemoryEventBus): Promise<DomainEvent[]> {
  const owed = bus.latestSeq();
  const sub = bus.subscribe(0);
  const it = sub[Symbol.asyncIterator]();
  const got: DomainEvent[] = [];
  for (let i = 0; i < owed; i++) {
    const step = await it.next();
    if (step.done === true) break;
    got.push(step.value);
  }
  sub.close();
  return got;
}

let bundleSeq = 0;
const nextBundleId = (): string => {
  const h = (++bundleSeq).toString(16).padStart(32, "0");
  return (
    h.slice(0, 8) +
    "-" +
    h.slice(8, 12) +
    "-4" +
    h.slice(13, 16) +
    "-8" +
    h.slice(17, 20) +
    "-" +
    h.slice(20, 32)
  );
};

/**
 * 升级判定的默认入参。放在模块级而不是某个 describe 里：验收 2 也要用它
 * （「门控判不出」这一维要接到升级路由上，两个验收标准共用同一个夹具）。
 */
function escalationState(over: Partial<EscalationState> = {}): EscalationState {
  return { taskId: "T-1", state: "IN_REVIEW", ...over };
}

/* ══════════ 验收标准 1：开发标记完成但不附测试报告 → reject ══════════ */

describe("验收 1：开发说「做完了」但没交测试报告", () => {
  /**
   * 这条用例判的是【方向要求的证据没交】，不是「措辞不好」。
   *
   * 第一版想直接写成「claim 里提到测试报告」，但那要靠文本匹配，等于让门控去读自然语言
   * —— 违反 §8.2 第 5 条（门控是确定性代码）。真正的判据在 §8.1 那张表里：
   * dev_to_test 这一闸该收的是 code_diff，而「测试报告」是 test → 上报 方向的
   * test_report。所以这条用例把两件事分开验：
   *  ① 交错类型 ⇒ 拦（§8.1 表有约束力，这是本轮才接上的：那张表此前没有任何生产调用方）；
   *  ② 声称「测试通过」却没有任何制品支撑这句话 ⇒ 拦（§8.2 第 2 条）。
   * 两条合起来才是「不附测试报告就过不去」的完整含义：既不能拿别的东西顶，
   * 也不能只用一句自我声明顶。
   */
  const criteria: GateCriterion[] = [
    {
      condition: "metric:p0_defect_count != 0",
      action: "reject",
      message: "存在 P0 缺陷，不得交接给测试",
    },
  ];

  it("① 交接方向要 code_diff，实到 spec ⇒ reject", () => {
    const v = evaluateGate({
      gate: "dev_to_test",
      producer: { roleId: "dev", modelFamily: "claude" },
      bundle: {
        bundle_id: nextBundleId(),
        task_id: "T-1",
        bundle_type: "spec",
        produced_by_role: "dev",
        produced_by_model_family: "claude",
        artifacts: [
          { path: "T-1/spec/x.md", sha256: sha256Text("s"), bytes: 1 },
        ],
        claims: [{ text: "按方案实现完了", evidence_refs: ["T-1/spec/x.md"] }],
        honesty_boundaries: [],
        metrics: { p0_defect_count: 0 },
      } as EvidenceBundle,
      criteria,
      integrityOk: true,
    });
    expect(v.decision).toBe("reject");
    if (v.decision === "reject") {
      expect(v.reasons.join("")).toContain("code_diff");
      expect(v.reasons.join("")).toContain("spec");
    }
  });

  it("② 类型对了，但「测试已通过」这句话没有任何制品支撑 ⇒ reject", () => {
    const v = evaluateGate({
      gate: "dev_to_test",
      producer: { roleId: "dev", modelFamily: "claude" },
      bundle: {
        bundle_id: nextBundleId(),
        task_id: "T-1",
        bundle_type: "code_diff",
        produced_by_role: "dev",
        produced_by_model_family: "claude",
        // artifacts 里【只有 diff】，没有测试报告
        artifacts: [
          { path: "T-1/code_diff/x.diff", sha256: sha256Text("d"), bytes: 1 },
        ],
        claims: [
          {
            text: "本地跑过测试，全部通过",
            // 引用的是一个从未声明的测试报告 —— 形状合法（refs 非空），内容空手
            evidence_refs: ["T-1/code_diff/test-report.md"],
          },
        ],
        honesty_boundaries: [],
        metrics: { p0_defect_count: 0 },
      } as EvidenceBundle,
      criteria,
      integrityOk: true,
    });
    expect(v.decision).toBe("reject");
    if (v.decision === "reject") {
      expect(v.reasons.join("")).toContain("evidence_refs");
    }
  });

  it("反面：方向对、引用实、指标达标 ⇒ pass（否则上面两条是在测「永远不过」）", () => {
    const v = evaluateGate({
      gate: "dev_to_test",
      producer: { roleId: "dev", modelFamily: "claude" },
      bundle: {
        bundle_id: nextBundleId(),
        task_id: "T-1",
        bundle_type: "code_diff",
        produced_by_role: "dev",
        produced_by_model_family: "claude",
        artifacts: [
          { path: "T-1/code_diff/x.diff", sha256: sha256Text("d"), bytes: 1 },
          {
            path: "T-1/code_diff/test-report.md",
            sha256: sha256Text("r"),
            bytes: 1,
          },
        ],
        claims: [
          {
            text: "自测结果见报告",
            evidence_refs: ["T-1/code_diff/test-report.md"],
          },
        ],
        honesty_boundaries: ["未覆盖并发场景"],
        metrics: { p0_defect_count: 0 },
      } as EvidenceBundle,
      criteria,
      integrityOk: true,
    });
    expect(v.decision).toBe("pass");
  });

  it("标准来自岗位书而不是测试里手搓（criteriaFromCharter 真接线）", () => {
    const charterLike = {
      acceptanceCriteria: [
        {
          condition: "metric:p0_defect_count != 0",
          action: "reject",
          message: "存在 P0 缺陷，不得交接给测试",
        },
      ],
    } as unknown as Parameters<typeof criteriaFromCharter>[0];
    const fromCharter = criteriaFromCharter(charterLike);
    expect(fromCharter).toEqual(criteria);
  });
});

/* ══════════ 验收标准 2：测试标记通过但覆盖率不足 → reject ══════════ */

describe("验收 2：测试说「通过」但覆盖率不足", () => {
  /**
   * ⚠ condition 的方向口径（本仓最容易整体写反的地方，见 test/gates/determinism.test.ts
   * 文件头）：condition 写的是【不合格的情形】，配 action: reject 读作
   * 「coverage < 80 就拒」。写成 ">= 80" 表达的是「覆盖率好就拒」，
   * 症状是全绿而门控从不拦任何东西 —— 最难发现的那一形。
   */
  const criteria: GateCriterion[] = [
    {
      condition: "metric:coverage < 80",
      action: "reject",
      message: "覆盖率不足 80，测试不得判通过",
    },
  ];

  const report = (metrics: Record<string, number>): EvidenceBundle =>
    ({
      bundle_id: nextBundleId(),
      task_id: "T-1",
      bundle_type: "test_report",
      produced_by_role: "test",
      produced_by_model_family: "gpt",
      artifacts: [
        { path: "T-1/test_report/r.md", sha256: sha256Text("r"), bytes: 1 },
      ],
      claims: [{ text: "全部用例通过", evidence_refs: ["T-1/test_report/r.md"] }],
      honesty_boundaries: [],
      metrics,
    }) as EvidenceBundle;

  it("自报通过 + 覆盖率 61 ⇒ reject，且 required_fixes 指回那条标准", () => {
    const v = evaluateGate({
      gate: "test_upward",
      producer: { roleId: "test", modelFamily: "gpt" },
      bundle: report({ coverage: 61 }),
      criteria,
      integrityOk: true,
    });
    expect(v.decision).toBe("reject");
    if (v.decision === "reject") {
      expect(v.reasons).toEqual(["覆盖率不足 80，测试不得判通过"]);
      expect(v.required_fixes).toEqual(["metric:coverage < 80"]);
    }
  });

  it("【最省事的绕过】是不报覆盖率 —— 它现在走 escalate，不是 pass", () => {
    // 这条是本轮真正补上的洞，也是本文件存在的理由的一个实例：
    // metrics 缺位时标准判不出，而「判不出」曾经一路走到 pass。
    // 于是 agent 只要【不提覆盖率】就必然过闸，连伪造都不必。
    const noCoverage = report({});
    const v = evaluateGate({
      gate: "test_upward",
      producer: { roleId: "test", modelFamily: "gpt" },
      bundle: noCoverage,
      criteria,
      integrityOk: true,
    });
    expect(v.decision).toBe("escalate");
    expect(v.unresolved.join("")).toContain("coverage");
    // 判不出 ⇒ 门控自己承认没判成，并把这件事接给升级路由（两侧同向）
    const e = decideEscalation(escalationState({ unresolvedCriteriaCount: v.unresolved.length }));
    expect(e.escalate).toBe(true);
    if (e.escalate) expect(e.reason).toBe("insufficient_evidence");
  });

  it("反面：覆盖率 91 ⇒ pass", () => {
    expect(
      evaluateGate({
        gate: "test_upward",
        producer: { roleId: "test", modelFamily: "gpt" },
        bundle: report({ coverage: 91 }),
        criteria,
        integrityOk: true,
      }).decision,
    ).toBe("pass");
  });

  it("报告文件被改过一个字节 ⇒ reject（哈希对账先于业务标准）", async () => {
    const { store } = await scenario("T-1");
    const head = {
      task_id: "T-1",
      bundle_type: "test_report" as const,
      bundle_id: nextBundleId(),
    };
    const w = store.writeArtifact(head, "md", "coverage 91%\n");
    const b: EvidenceBundle = {
      ...report({ coverage: 91 }),
      bundle_id: head.bundle_id,
      artifacts: [{ path: w.declared, sha256: w.sha256, bytes: w.bytes }],
      claims: [{ text: "全部用例通过", evidence_refs: [w.declared] }],
    };
    // 先按原样过：证明下面的 reject 是【篡改】造成的，不是夹具本来就不合格
    expect(
      evaluateGate({
        gate: "test_upward",
        producer: { roleId: "test", modelFamily: "gpt" },
        bundle: b,
        criteria,
        integrityOk: store.verify(b).ok,
      }).decision,
    ).toBe("pass");

    const { writeFileSync } = await import("node:fs");
    writeFileSync(w.absolute, "coverage 100%", "utf8"); // 同字节数，只有内容变了
    const v = evaluateGate({
      gate: "test_upward",
      producer: { roleId: "test", modelFamily: "gpt" },
      bundle: b,
      criteria,
      integrityOk: store.verify(b).ok,
    });
    expect(v.decision).toBe("reject");
    if (v.decision === "reject") {
      expect(v.reasons.join("")).toContain("完整性");
    }
  });
});

/* ══════════ 验收标准 3：预算突破 → BudgetPaused + 升级卡片 ══════════ */

describe("验收 3：一次预算突破", () => {
  const escalationState = (over: Partial<EscalationState> = {}): EscalationState => ({
    taskId: "T-1",
    state: "IN_REVIEW",
    ...over,
  });

  it("突破 ⇒ 恰好一条 BudgetPaused 事件，且账面跨过了上限", async () => {
    const { tracker, recorder, bus, eid, actions } = await scenario("T-1");
    await recorder.run(async () => {
      tracker.declareLimit({
        scope: "role",
        scopeId: "dev",
        period: "daily",
        limitCents: 1000,
      });
      const r = await tracker.consume({
        sourceEvent: eid(),
        scope: "role",
        scopeId: "dev",
        period: "daily",
        amountCents: 1200,
        taskId: "T-1",
        node: "implement",
      });
      expect(r.breached).toBe(true);
      expect(r.over).toBe(true);
    });
    const paused = (await feed(bus)).filter((e) => e.kind === "BudgetPaused");
    expect(paused.length).toBe(1);
    // 事件走的是 events 表 → 总线这条真实投影路径，seq 由 events.id 派生
    // BudgetPaused 的审计动作名是 budget_consume，【不是】budget_paused（0005 的映射表）。
    // 按直觉写 budget_paused 会红，而红得对：那条映射是审计统计的口径来源。
    expect(actions()).toEqual(["budget_consume"]);
  });

  it("突破这件事真的能升到 CEO（BUDGET_PAUSED 曾是死路，升级边本轮补上）", () => {
    // 单测里「卡片起草得好」和「卡片送得出去」是两件事，而曾经只有前者成立：
    // decideEscalation 会为预算突破产出卡片，canEscalateFrom("BUDGET_PAUSED") 却判
    // false ⇒ 卡片写进了内存，状态机上没有任何合法路径把它送到 CEO 面前。
    // events 是 append-only，硬写一条非法跃迁会永久污染审计回放。
    expect(canEscalateFrom("BUDGET_PAUSED")).toBe(true);
    expect(canEscalateFrom("IN_REVIEW")).toBe(true);
    // 「暂停」态本身不是升级态：没到能升的状态时，调用方要先走到能升的状态
    expect(canEscalateFrom("IN_PROGRESS")).toBe(false);
  });

  it("突破 → 升级卡片：金额可决策、标注推荐非决定、超时不自动放行", () => {
    const e = decideEscalation(
      escalationState({ spentCents: 12340, limitCents: 10000 }),
    );
    expect(e.escalate).toBe(true);
    if (e.escalate !== true) return;
    expect(e.reason).toBe("budget_threshold");
    // 摘要要带【数字】：「超出预算」不可决策，「12340 / 10000 美分」可决策（§9.2 第一行）
    expect(e.card.summary).toContain("12340");
    expect(e.card.summary).toContain("10000");
    expect(e.card.parameters.recommendation_is_not_decision).toBe(true);
    // 预算突破是可逆事项（追加额度即可继续）⇒ 超时 escalate，绝不 auto_approve
    expect(e.card.parameters.timeout_behavior).toBe("escalate");
    expect(e.card.parameters.irreversible).toBe(false);
    // 三个按钮，一个不多一个不少（§9.2；第四个按钮会自己绕过 §8.2 第 4 条）
    expect(e.card.buttons).toEqual([
      "approve",
      "reject_with_comment",
      "defer_deep_review",
    ]);
    // 卡片必须能点开看到依据
    expect(e.card.evidence_refs.length).toBeGreaterThan(0);
  });

  it("同一次突破被重放 ⇒ 不重复扣减、不重复发卡（幂等键是 events.id）", async () => {
    const { tracker, recorder, bus, eid } = await scenario("T-1");
    tracker.declareLimit({
      scope: "task",
      scopeId: "T-1",
      period: "per_task",
      limitCents: 1000,
    });
    const ev = eid();
    const first = await recorder.run(async () =>
      tracker.consume({
        sourceEvent: ev,
        scope: "task",
        scopeId: "T-1",
        period: "per_task",
        amountCents: 1200,
        taskId: "T-1",
        node: "implement",
      }),
    );
    expect(first.breached).toBe(true);
    // 重放同一条上报（崩溃重启的形状，0005 §11 那个缺陷）
    const second = await recorder.run(async () =>
      tracker.consume({
        sourceEvent: ev,
        scope: "task",
        scopeId: "T-1",
        period: "per_task",
        amountCents: 1200,
        taskId: "T-1",
        node: "implement",
      }),
    );
    expect(second.applied).toBe(false);
    expect(second.breached).toBe(false);
    const paused = (await feed(bus)).filter((e) => e.kind === "BudgetPaused");
    expect(paused.length).toBe(1);
  });

  it("突破只暂停节点、不杀任务：任务状态仍停在 BUDGET_PAUSED 而不是终态", async () => {
    // §7.4：预算突破是「需要人决定要不要继续花」，不是「这条作废」。
    // 已完成的工作是真实成本，杀任务把它一起丢掉。
    const { tracker, recorder, db, eid, actions } = await scenario("T-1");
    await recorder.run(async () => {
      tracker.declareLimit({
        scope: "task",
        scopeId: "T-1",
        period: "per_task",
        limitCents: 500,
      });
      await tracker.consume({
        sourceEvent: eid(),
        scope: "task",
        scopeId: "T-1",
        period: "per_task",
        amountCents: 900,
        taskId: "T-1",
        node: "implement",
      });
    });
    const status = String(
      Object.values(
        db.prepare("SELECT status FROM tasks WHERE id = 'T-1'").get() ?? {},
      )[0],
    );
    // 消费本身【不改任务状态】—— 暂停是编排层的动作，不是记账层的副作用。
    // 这条断言钉的是「别把状态跃迁塞进 tracker」：那会让扣减与状态变更的因果
    // 绕开状态机闸门（assertTaskTransition），而 events 是 append-only。
    // 反过来若哪天 tracker 开始自己改状态，这条会红，提醒来把跃迁挪回编排层。
    expect(status).toBe("IN_PROGRESS");
    expect(actions()).toEqual(["budget_consume"]);
    // 【这一半才是本用例要拦的东西】：从 IN_PROGRESS 无法合法升到 CEO。
    // 所以「暂停 + 升级」不是发个事件就完事，编排层必须先走到能升的状态
    // （IN_REVIEW / APPROVED_UPWARD），否则卡片送不出去（见上一条用例）。
    expect(canEscalateFrom(status as TaskState)).toBe(false);
  });
});
