/**
 * 装配层（engine/runtime.ts）—— 那些 SQL 真的读对了东西吗。
 *
 * ── 为什么这一发不能省 ────────────────────────────────────────────────
 * dispatch.test.ts 把判定测尽了，而那些测试给 dispatch 喂的是【测试作者手写的回调】。
 * 于是有一整类缺陷在那边结构性测不到：判定全对、SQL 读错。典型三条
 *  · modelFamily 读了最新图而不是任务那一版 ⇒ 审阅独立性按错的档位判，而每一轮都「正常」；
 *  · roleSession 取到 NULL（上次那次 CLI 启动失败）⇒ 这个角色从此每轮从零开始，症状只是慢；
 *  · onCost 少写一行 budget_events ⇒ tasks.consumed_cents 与 budgets.consumed_cents 分叉，
 *    而 integrity.ts 那条 harness_call_recorded 就是为这一格准备的（它今天恒 not_observable）。
 * 本文件测的就是【真 SQL + 真 schema + 真 CLI 桩】那一段。
 *
 * ── 为什么用的是 HubWriter 而不是只喂 node() ──────────────────────────
 * runtime 的多数回调是【同步】签名，等不了 queue.read()/node()。所以读走
 * readConnection()。这条选择本身带着一个必须钉住的边界（见 runtime.ts 文件头）：
 * 只读连接只看得到【已提交】，所以「同一轮里先写后读」必然读到旧值 ——
 * 下面那条【写完之后从回调读回来】的用例就是把这个边界摆在明处，
 * 免得下一个人以为回调能读到自己刚写的东西。
 *
 * 跑法（离线、node v24.14.0）：
 *   PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH \
 *     node --experimental-transform-types --import /tmp/opc-harness/register.mjs \
 *     --test packages/hub/test/engine/runtime.test.ts
 */
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { OrgGraph } from "@opc/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import type { RoleRunResult } from "../../src/engine/claude.js";
import type { RunTurnInput, TurnOutcome } from "../../src/engine/dispatch.js";
import { makeDispatch } from "../../src/engine/dispatch.js";
import {
  CEO_APPROVED_SQL,
  INSERT_HARNESS_CALL_SQL,
  LAST_SESSION_SQL,
  LOAD_TASK_SQL,
  makeRuntime,
} from "../../src/engine/runtime.js";
import { runTurnWithRetry } from "../../src/engine/turn-retry.js";
import { InMemoryEventBus } from "../../src/events/bus.js";
import { appendAudit } from "../../src/events/recorder.js";
import { INSERT_DELEGATION_GRAPH_SQL } from "../../src/org/commit.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("engine-runtime", import.meta.url);
const NOW = 1_700_000_000_000;
const FAKE_CLI = fileURLToPath(
  new URL("./fixtures/fake-claude.mjs", import.meta.url),
);

type Row = Record<string, unknown>;
type Db = {
  prepare: (sql: string) => {
    all: (...a: unknown[]) => Row[];
    get: (...a: unknown[]) => Row | undefined;
    run: (...a: unknown[]) => unknown;
  };
  exec: (sql: string) => void;
};
type Queue = {
  node: <T>(fn: () => Promise<T> | T) => Promise<T>;
  readConnection: () => Db;
  writeConnection: () => Db;
  close: () => Promise<void>;
};

const queues: Queue[] = [];
let fileSeq = 0;

const GRAPH: OrgGraph = {
  nodes: {
    ceo: {
      role_id: "ceo",
      can_manage: true,
      reports_to: null,
      model_family: "opus",
    },
    director: {
      role_id: "director",
      can_manage: true,
      reports_to: "ceo",
      model_family: "sonnet",
    },
    dev: {
      role_id: "dev",
      can_manage: false,
      reports_to: "director",
      model_family: "claude",
    },
    // 没有 model_family 的那一格：装配方必须交出空串（reviewGate 据此拒放行）
    blank: { role_id: "blank", can_manage: false, reports_to: "director" },
  },
  edges: [{ from: "dev", to: "director", review_gate: true }],
};

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
  // 桩 CLI 要能被 spawn 执行。git 不一定保住执行位（新克隆 / 换文件系统），
  // 少了这一发，报错会是「CLI 输出不是预期的 JSON」—— 那次误导我在 claude.test.ts
  // 里已经记过一次，这里直接在装配处兜住，不再让 EACCES 伪装成协议错误。
  try {
    chmodSync(FAKE_CLI, 0o755);
  } catch {
    /* 测试夹具缺失就让后面的用例如实红，不在这里编一个成功 */
  }
});

afterAll(async () => {
  for (const q of queues) {
    try {
      await q.close();
    } catch {
      /* 已关 */
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});

interface World {
  db: Db;
  q: Queue;
  rt: ReturnType<typeof makeRuntime>;
  bus: InMemoryEventBus;
}

async function world(o: {
  readonly status?: string;
  readonly role?: string;
  readonly graphVersion?: number;
  /** 写不写组织图。不写 ⇒ 造「版本缺失」那一发。 */
  readonly writeGraph?: boolean;
  /** 换整张图（0047 那几发要的是【根不叫 ceo】与【两个根】两种形状）。 */
  readonly graph?: OrgGraph;
  /**
   * 装配的 --ceo。给 null 表示【不指定】—— 那时「谁是 CEO」只能由图回答，
   * 这一格是 0047 那一半修复唯一的开关（原来 runtime 里写死 `?? "ceo"`，
   * 不指定就等于宣布根叫 ceo）。
   */
  readonly ceoRoleId?: string | null;
  /**
   * 换 claude 二进制。给一个不存在的路径 ⇒ 造「进程从未起来」那一型
   * （round305 的重试判据那一族要用）。不给 ⇒ 用真桩 CLI。
   */
  readonly bin?: string;
  /** 重试退避的注入点。记录时长，不真等（见 turn-retry.test.ts 同一条理由）。 */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onRetryWarn?: (m: string) => void;
}): Promise<World> {
  const { WriteQueue } = await import("../../src/db/write-queue.js");
  const q = new WriteQueue(
    TMP + "/r-" + process.pid + "-" + ++fileSeq + ".db",
  ) as unknown as Queue;
  queues.push(q);
  const db = q.writeConnection();
  migrate(db as unknown as Parameters<typeof migrate>[0]);
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at, graph_version) " +
      "VALUES ('t1', '做个 AI 笔记应用', ?, ?, 'intake', ?, ?, ?)",
  ).run(
    o.status ?? "IN_PROGRESS",
    o.role ?? "dev",
    NOW,
    NOW,
    o.graphVersion ?? 1,
  );
  if (o.writeGraph !== false) {
    db.prepare(INSERT_DELEGATION_GRAPH_SQL).run(
      "g1",
      1,
      JSON.stringify(o.graph ?? GRAPH),
      NOW,
      "ceo",
      "测试用组织图",
    );
  }
  const bus = new InMemoryEventBus();
  const rt = makeRuntime({
    writer: q as unknown as Parameters<typeof makeRuntime>[0]["writer"],
    bus,
    maxBudgetUsd: 0.5,
    taskLimitCents: 1000,
    cwd: TMP,
    bin: o.bin ?? FAKE_CLI,
    ...(o.ceoRoleId === null ? {} : { ceoRoleId: o.ceoRoleId ?? "ceo" }),
    ...(o.sleep === undefined ? {} : { sleep: o.sleep }),
    ...(o.onRetryWarn === undefined ? {} : { onRetryWarn: o.onRetryWarn }),
  });
  return { db, q, rt, bus };
}

/**
 * 往这个真库里写一版 dev 的岗位书（走真写入方，不手搓 config JSON）。
 *
 * round312 从 O2 那一节移到模块作用域：gateway 审计那两发（下面「岗位书的
 * harness_defaults 真的走到 gateway 的授权侧」）要的是【同一份写入口径】。
 * 复制一份 config 字面量就是第二份口径 —— 而本仓最贵的那一族失效正是
 * 「两份同一事实的写法，改一处不动另一处」（round272 收敛记账 SQL 同一条理由）。
 */
async function seedCharter(
  w: World,
  over: Record<string, unknown> = {},
): Promise<void> {
  const { saveCharterVersion } = await import("../../src/charter/store.js");
  const r = await saveCharterVersion(
    w.q as unknown as Parameters<typeof saveCharterVersion>[0],
    {
      roleId: "dev",
      nowMs: NOW,
      changeSummary: "测试用第一版",
      config: {
        role_id: "dev",
        display_name: "开发负责人",
        version: 1,
        honesty_boundaries: ["不声称未跑过的测试已通过"],
        acceptance_criteria: [
          {
            condition: "metric:coverage < 80",
            action: "reject",
            message: "覆盖率不足 80",
          },
        ],
        forbidden_actions: ["不许直接改生产库"],
        tool_permissions: ["Read"],
        model_tier: "execution",
        budget: { daily_usd: 15, per_task_usd: 5 },
        decision_scope: {
          autonomous: ["选实现方案"],
          requires_consultation: ["改公共接口"],
          forbidden: ["定公司方向"],
        },
        judgment_mode: {
          type: "bounded_judgment",
          strict_rules: ["不许跳过测试"],
          bounded_judgment: [],
          full_discretion: [],
        },
        escalation_triggers: ["碰到不可逆动作就升"],
        ...over,
      },
    } as never,
  );
  if (!r.ok) throw new Error("夹具写岗位书被拒：" + r.reason);
}

describe("runtime 的读回调（真 schema 上的真 SQL）", () => {
  it("loadTask 交出的是 tasks 那一行，不是它旁边的东西", async () => {
    const w = await world({});
    const t = w.rt.deps.loadTask("t1");
    expect(t).not.toBeNull();
    expect(t?.title).toBe("做个 AI 笔记应用");
    expect(t?.status).toBe("IN_PROGRESS");
    expect(t?.role).toBe("dev");
    expect(t?.graphVersion).toBe(1);
  });

  it("loadTask 对不存在的任务给 null，而不是一个字段全空的壳", async () => {
    const w = await world({});
    expect(w.rt.deps.loadTask("ghost")).toBeNull();
  });

  it("modelFamily 读的是【任务那一版】的图；版本缺失 ⇒ 空串而不是最新图（§18.4）", async () => {
    const ok = await world({});
    ok.rt.deps.loadTask("t1");
    expect(ok.rt.deps.modelFamily("dev")).toBe("claude");
    // 没声明家族的那一格：交出空串。这里【不能】给一个默认家族名 ——
    // 审阅独立性整个建立在「这个角色属于哪个家族」上，编一个就是发一张假身份证。
    expect(ok.rt.deps.modelFamily("blank")).toBe("");
    expect(ok.rt.deps.modelFamily("没这个角色")).toBe("");

    // 任务指向一个不存在的图版本
    const missing = await world({ graphVersion: 9 });
    missing.rt.deps.loadTask("t1");
    expect(missing.rt.deps.modelFamily("dev")).toBe("");
  });

  it("roleSession 跳过【没有 session_id 的那几次】执行，取回真正上一个会话", async () => {
    const w = await world({});
    const ins = (session: string | null, at: number, role = "dev"): void => {
      w.db
        .prepare(INSERT_HARNESS_CALL_SQL)
        .run(
          "h-" + at,
          "t1",
          role,
          "0.0.0",
          "{}",
          session,
          session === null ? 1 : 0,
          1,
          at,
        );
    };
    // 时间序：有会话 → 无会话（那次 CLI 没起来）→ 无会话（又一次）
    ins("sess-old", NOW);
    ins(null, NOW + 1000);
    ins(null, NOW + 2000);
    expect(w.rt.deps.roleSession("t1", "dev")).toBe("sess-old");
    // 换个角色就查不到：会话是【按角色】的，dev 的上下文不能 resume 到 director 身上
    expect(w.rt.deps.roleSession("t1", "director")).toBeNull();
    // SQL 形状本身也钉一下：条件里少了 session_id IS NOT NULL 这条查询就会取到 NULL，
    // 而症状是「这个角色每轮都从零开始」，没人会去查 SQL。
    expect(LAST_SESSION_SQL).toContain("session_id IS NOT NULL");
  });

  it("lastProducer 从最近的状态变化里往回找带 producerRole 的那一条", async () => {
    const w = await world({});
    const evt = (payload: unknown): void => {
      w.db
        .prepare(
          "INSERT INTO events (task_id, actor_type, actor_id, action, target, payload, state_snapshot, created_at) " +
            "VALUES ('t1','agent','dev','state_change','x',?, NULL, ?)",
        )
        .run(JSON.stringify(payload), NOW);
    };
    // 最新的是【另一条】状态变化（没有 producerRole），往回第二条才是提交审阅那条
    evt({
      kind: "TaskStateChanged",
      taskId: "t1",
      from: "EVIDENCE_SUBMITTED",
      to: "IN_REVIEW",
    });
    evt({
      kind: "TaskStateChanged",
      taskId: "t1",
      from: "IN_PROGRESS",
      to: "EVIDENCE_SUBMITTED",
      producerRole: "dev",
    });
    expect(w.rt.deps.lastProducer("t1")).toBe("dev");

    // 一条提交都没有 ⇒ null（不是拿最近一条的 producerRole 顶上，也不是拿 assigned_role）
    const fresh = await world({});
    expect(fresh.rt.deps.lastProducer("t1")).toBeNull();
  });

  it("⭐ rejectionCount 数的是【打回那一条边】，一次打回 = 1 而不是 2", async () => {
    // §4.2.1 max_rejections 的分子。这条 SQL 全部的正确性在"数 payload.$.to
    // 而【不数 action】"，而这件事只能在这一层测：dispatch.test.ts 喂的是手写回调。
    //
    // 为什么【必须】用生产的 appendAudit 写这些行而不用裸 INSERT：
    // 一次打回在 dispatch 那一轮写的是【两条】state_change 边（REJECTED_DOWNWARD 那一跳
    // + AUTO_AFTER_EDGE 自动补的 IN_PROGRESS 那一跳）。裸 INSERT 手写两条是我【以为的】
    // 写入形状；appendAudit 写的才是库里的真形状。真形状变了（比如将来有人把自动那一跳
    // 的 payload.to 也写成 REJECTED_DOWNWARD），裸 INSERT 那一发照样绿。
    const w = await world({});
    expect(w.rt.deps.rejectionCount("t1")).toBe(0); // 干净库 ⇒ 0，不是 null / undefined

    // 一轮打回 = 两条边（形状抄 dispatch.ts 那条 chain 循环）
    const edge = (from: string, to: string): void => {
      appendAudit(
        w.db as never,
        {
          taskId: "t1",
          actorType: "agent",
          actorId: "director",
          action: "state_change",
          target: to,
          payload: {
            kind: "TaskStateChanged",
            taskId: "t1",
            from,
            to,
            summary: "测试",
          },
          createdAt: NOW,
        },
        () => NOW,
      );
    };
    edge("IN_REVIEW", "REJECTED_DOWNWARD");
    edge("REJECTED_DOWNWARD", "IN_PROGRESS");
    const rows = w.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE action='state_change'")
      .get();
    expect(rows?.["n"]).toBe(2); // 一轮确实留了两条 state_change
    expect(w.rt.deps.rejectionCount("t1")).toBe(1); // ⭐ 而分子只能是 1

    // 再来两轮 ⇒ 3。上限正好在 3 这一格触发（dispatch.test.ts 那两发接的就是这个数），
    // 所以这一句同时钉住"分子不多不少"：数成 6 会让上限【提前一倍】咬，
    // 屏幕上没有任何一处会说"这次升级是因为计数算重了"。
    edge("IN_REVIEW", "REJECTED_DOWNWARD");
    edge("REJECTED_DOWNWARD", "IN_PROGRESS");
    edge("IN_REVIEW", "REJECTED_DOWNWARD");
    edge("REJECTED_DOWNWARD", "IN_PROGRESS");
    expect(w.rt.deps.rejectionCount("t1")).toBe(3);

    // 别的动作不算打回（同一件事换个 action 就是另一件事）
    appendAudit(
      w.db as never,
      {
        taskId: "t1",
        actorType: "agent",
        actorId: "director",
        action: "review_decision",
        target: "REJECTED_DOWNWARD",
        payload: {
          kind: "ReviewDecided",
          taskId: "t1",
          to: "REJECTED_DOWNWARD",
        },
        createdAt: NOW,
      },
      () => NOW,
    );
    expect(w.rt.deps.rejectionCount("t1")).toBe(3);
    // 另一条任务的打回不串号（分子是【这条想法】被打回几次）
    expect(w.rt.deps.rejectionCount("ghost")).toBe(0);
  });

  it("recentSummaries 拿到的是 payload.summary，脏 payload 不会掀翻整轮", async () => {
    const w = await world({});
    const evt = (payload: string): void => {
      w.db
        .prepare(
          "INSERT INTO events (task_id, actor_type, actor_id, action, target, payload, state_snapshot, created_at) " +
            "VALUES ('t1','agent','dev','state_change','x',?, NULL, ?)",
        )
        .run(payload, NOW);
    };
    evt(JSON.stringify({ summary: "登录模块写完" }));
    evt("{这不是合法 JSON"); // 一行历史脏数据
    evt(JSON.stringify({ summary: "   " })); // 空白摘要不算一条汇报
    const s = w.rt.deps.recentSummaries("t1");
    expect(s).toEqual(["登录模块写完"]);
  });

  it("ceoApproved 要 status='approved'【且】decided_by='ceo'：状态那一半单独为真不算凭据", async () => {
    const w = await world({});
    // decided_by 成了判据的一维，夹具就必须能填它 —— 第一版这个 helper 把它写死成 NULL，
    // 于是「approved + 非 ceo」那一格【摆不出来】，测出来会是假绿（看起来测了身份，
    // 实际所有样本的身份都一样）。
    const card = (
      status: string,
      key: string,
      decidedBy: string | null = null,
    ): void => {
      w.db
        .prepare(
          "INSERT INTO approvals (id, task_id, approval_type, summary, parameters, recommendation, " +
            "recommendation_source, timeout_behavior, timeout_at, status, decided_by, decided_at, " +
            "decision_note, card_key, created_at) " +
            "VALUES (?, 't1', 'escalation', 's', '{}', 'r', NULL, 'escalate', ?, ?, ?, NULL, NULL, ?, ?)",
        )
        .run("a-" + key, NOW + 1, status, decidedBy, key, NOW);
    };
    card("pending", "k-pending", "ceo");
    card("rejected", "k-rejected", "ceo");
    // ⭐ 承重那一发：状态对而身份不对 ⇒ 不算。这一格对应的就是
    // policy/auto-approve.ts 那条 UPDATE 写进库的形状（decided_by='policy-engine'）。
    card("approved", "k-policy", "policy-engine");
    // 历史形状：那条 SQL 补上身份那一维【之前】，任何一行 approved 都算凭据。
    card("approved", "k-no-identity", null);
    card("approved", "k-approved", "ceo");
    expect(w.rt.deps.ceoApproved("t1", "k-approved")).toBe(true);
    expect(w.rt.deps.ceoApproved("t1", "k-pending"), "pending 不是凭据").toBe(
      false,
    );
    expect(w.rt.deps.ceoApproved("t1", "k-rejected"), "rejected 不是凭据").toBe(
      false,
    );
    expect(
      w.rt.deps.ceoApproved("t1", "k-policy"),
      "策略引擎写的 approved 不是 CEO 的批准",
    ).toBe(false);
    expect(
      w.rt.deps.ceoApproved("t1", "k-no-identity"),
      "没署名的 approved 不是凭据",
    ).toBe(false);
    expect(w.rt.deps.ceoApproved("t1", "没有这张卡")).toBe(false);
    // SQL 文本也钉一条：有人把 WHERE 里那一维删掉时，上面那发会红，而这一发说出【为什么】红。
    expect(CEO_APPROVED_SQL).toContain("status = 'approved'");
    expect(CEO_APPROVED_SQL).toContain("decided_by = 'ceo'");
  });
});

describe("rolePrompt 里那句「谁是 CEO」（0047 的装配那一半）", () => {
  const BOSS_GRAPH: OrgGraph = {
    nodes: {
      boss: {
        role_id: "boss",
        can_manage: true,
        reports_to: null,
        model_family: "opus",
      },
      dev: {
        role_id: "dev",
        can_manage: false,
        reports_to: "boss",
        model_family: "claude",
      },
    },
    edges: [],
  };

  it("根叫 boss ⇒ 简报里写的是 boss，而【不是】那个字面量 ceo", async () => {
    // 修前这里是 `?? "ceo"`：简报会告诉一个 agent「CEO（角色 ceo）是唯一的决策者」，
    // 而这张图里没有 ceo 这个人 —— agent 照着喊一句汇报对象，对象不存在。
    const w = await world({ graph: BOSS_GRAPH, ceoRoleId: null });
    w.rt.deps.loadTask("t1"); // 图跟着任务钉进来（不 loadTask 就没有 cacheGraph）
    const p = w.rt.deps.rolePrompt("dev");
    expect(p).toContain("角色 boss");
    expect(p).not.toContain("角色 ceo");
  });

  it("⭐ 判不出【不退回任何名字】，而是把「说不出来」原样写进简报", async () => {
    // 两个根的图 + 不指定 ⇒ resolveCeoRoleId 拒绝。这一条守的是"编一个名字出去"
    // 那条退路：编出来的名字会让 agent 对着一个不存在的同事汇报。
    const forest: OrgGraph = {
      nodes: {
        a: {
          role_id: "a",
          can_manage: true,
          reports_to: null,
          model_family: "opus",
        },
        b: {
          role_id: "b",
          can_manage: true,
          reports_to: null,
          model_family: "opus",
        },
      },
      edges: [],
    };
    const w = await world({ graph: forest, ceoRoleId: null });
    w.rt.deps.loadTask("t1");
    const p = w.rt.deps.rolePrompt("a");
    expect(p).toContain("说不出");
    // 一个名字都没提：既不编根，也不拿 nodes 里第一个凑数
    expect(p).not.toContain("角色 a");
    expect(p).not.toContain("角色 b");
    // 而它【不改变动作】—— 下一跳仍由 hub 判，这句是提示词层的全部职责
    expect(p).toContain("由 hub 按组织图判");
  });

  it("图还没钉（没 loadTask）⇒ 同样是「说不出」那一支，而不是拿最新图顶上", async () => {
    const w = await world({});
    expect(w.rt.deps.rolePrompt("dev")).toContain("说不出");
  });
});

/**
 * ── 岗位书真的进了提示词（O2 动作 1）────────────────────────────────────
 *
 * ⚠ **这一节是 O2 验收 (a) 那条变异的靶子**：把 `runtime.ts` 的 rolePrompt 里
 * 读岗位书那一句（`const charter = readLatestCharter(read(), roleId)`）注释掉，
 * 本节必须至少有一发红。优化设计文档 O2 记着改前实测「这个变异全绿」，
 * 而全绿的成因很具体：`engine/` 里那些字段名的引用是 0 —— 没有任何一发的
 * 断言落在那段提示词的**内容**上，所以删掉整个岗位书只会让提示词变短。
 *
 * 反向也要有：下面每一条「有岗位书」的用例都配一条同世界的「没有岗位书」。
 * 少了反向，"内容出现"与"内容恒出现"不可区分（0045 §9 那个分母同族）。
 *
 * ── 变异实测（本轮跑的，不是推断的）────────────────────────────────────
 * 变异 = 把 `const charter = readLatestCharter(read(), roleId);` 整行换成
 * `const charter: undefined = undefined;`。
 * ⚠ 换而不是**删**，为的是保住 `charter` 这个名字：删掉它会让下面那三处读它的
 * 表达式编译不过，于是一片红报的是"编译器在不在工作"而不是"有没有人判这件事"
 * （0045 §9 那发 G1 与 G1′ 的区别，同一条教训的第三次落地）。
 * 结果 4 发红，逐条记下**红在哪一句**，因为其中一发的红不在主断言上：
 *   · 「逐格出现」红在主断言：`这些格没进提示词: [开发负责人, metric:coverage…]`。
 *   · 「没有岗位书 ⇒ 不编通用的」**主断言是绿的** —— 恒 undefined 的变异
 *     恰好让"没有岗位书"这句话【说得对】，红的是末尾那条反向对照
 *     （`not to contain 没有你的岗位书`）。⇒ **只写主断言的那一发挡不住这个变异**，
 *     这是上面那句"反向也要有"的实测价格，不是风格偏好。
 *   · 「读坏了要抛」红在 `expected [Function] to throw an error`（变异让坏数据根本不被读）。
 *   · 「角色名跟着走」红在 dev 那一行（`to contain 开发负责人`）。
 * 跑完逐字节还原并 sha256 对账（改动只在 runtime.ts，还原后 git diff 只剩本轮该留的行）。
 * 变异脚本在系统临时目录，**不是仓库资产**。
 */
describe("rolePrompt 里的岗位书那一半（O2）", () => {
  it("⭐ 有岗位书 ⇒ 标准/禁止项/决策范围【逐格】出现在提示词里", async () => {
    const w = await world({});
    await seedCharter(w);
    const p = w.rt.deps.rolePrompt("dev");
    // 拼成一条断言：数组只报 Array(n)，而这一发红的时候要点名的是"哪一格没进"。
    const missing = [
      "开发负责人",
      "metric:coverage < 80",
      "不许直接改生产库",
      "选实现方案",
      "不声称未跑过的测试已通过",
      "碰到不可逆动作就升",
    ].filter((s) => !p.includes(s));
    expect("这些格没进提示词: [" + missing.join(", ") + "]").toBe(
      "这些格没进提示词: []",
    );
  });

  it("⭐ 库里这个角色一个版本都没有 ⇒ 明说「没有岗位书」，且不编一份通用的", async () => {
    const w = await world({});
    const p = w.rt.deps.rolePrompt("dev");
    expect(p).toContain("没有你的岗位书");
    expect(p).toContain("如实写进你的汇报");
    // 反向对照（这一句才是上面那发的分母）：同一张世界写一版之后就【不再】是这句话。
    await seedCharter(w);
    expect(w.rt.deps.rolePrompt("dev")).not.toContain("没有你的岗位书");
  });

  it("⭐ 那一版读坏了 ⇒ 【抛】，而不是渲染一句「读坏了」让 agent 照常花钱跑完", async () => {
    /*
     * 这一发钉的是 runtime 里那个刻意不 catch 的选择，所以它必须写明代价与理由：
     * 抛 ⇒ 这一轮整个不跑（CLI 那边 catch 成退出码 1 并打出原因）。
     * 在这里 catch 住、改渲染一句「你的岗位书读坏了」看着更温和，而后果是
     * agent **照常跑完这一轮、真的花钱**，只是没有岗位书，症状只是「这轮质量差」——
     * 把坏数据吸收成正常噪声。两种后果不同的事该有两种结果（readCharterConfig
     * 那句「这与『那一版不存在』是两件事」是同一立场的第一次落地）。
     *
     * 三种读结果在**同一发**里对照，因为它们最容易被人顺手合并成一格：
     *   ① 有 ⇒ 渲染（上面那发）  ② 没有 ⇒ NO_CHARTER_LINE（上面第二发）
     *   ③ 有行但坏 ⇒ 抛（这一发）
     */
    const w = await world({});
    await seedCharter(w);
    // 把 config 改坏成非法 JSON —— 这是「有行而读不出来」，不是「那一版不存在」。
    w.db
      .prepare(
        "UPDATE role_charters SET config = '{broken' WHERE role_id = 'dev'",
      )
      .run();
    expect(() => w.rt.deps.rolePrompt("dev")).toThrow(/不是合法 JSON/u);
    // 而它**不是** NO_CHARTER_LINE 那一支：把"读坏了"说成"没有"会引导人去播种，
    // 而播种会撞上同一行坏数据，或者更糟 —— 盖掉那一版，把证据洗掉。
    expect(() => w.rt.deps.rolePrompt("dev")).not.toThrow(/没有你的岗位书/u);
  });

  it("角色名跟着走：dev 的岗位书不会拼到 director 的提示词上", async () => {
    // 两角色同一张库，只有 dev 有岗位书 ⇒ director 必须还是「没有岗位书」那一支。
    // 这一发防的是 readLatestCharter 的 roleId 绑参写错（写成常量、或读了上一轮的缓存）。
    const w = await world({});
    await seedCharter(w);
    expect(w.rt.deps.rolePrompt("dev")).toContain("开发负责人");
    expect(w.rt.deps.rolePrompt("director")).toContain("没有你的岗位书");
  });
});

/* ═══════════════════════════════════════════════════════════════════
   ⭐ 角色记忆真的进了提示词（O3 动作 1）

   ⚠ **这一节是 O3 验收那条变异的靶子**：把 `renderMemoryBlock` 的返回值写死成空串
   ⇒ 必须红。优化设计文档 O3 记着改前实测「这个变异**全绿**」，而全绿的成因很具体：
   `renderMemoryBlock` 在 `src` 里的运行期消费者是 0（0016 §6 量的就是这件事），
   所以写死它的返回值只会让一个没人调的函数返回空字符串。
   ⇒ 那一发变异要能红，前提必须是【有人调它，且有人断它拼进去的内容】。
   本节配齐了那两条前提；四条路径本身的判据在 memory/prompt.test.ts（纯函数那侧）。

   这一节只判【装配】：读谁、方向、失败怎么办。四格话的内容不在这里重复。
   ═══════════════════════════════════════════════════════════════════ */
describe("rolePrompt 里的记忆那一半（O3）", () => {
  /** 落一条 director 审 dev 产出的审阅决定（= 0060 那个生产者的形状，走真 appendAudit）。 */
  function decideReview(
    w: World,
    o: { reviewer: string; producer: string; note: string; decision?: string },
  ): void {
    appendAudit(
      w.db as never,
      {
        taskId: "t1",
        actorType: "agent",
        actorId: o.reviewer,
        action: "review_decision",
        target: "in_review:" + o.producer + "->" + o.reviewer,
        payload: {
          kind: "ReviewDecided",
          taskId: "t1",
          gate: "in_review:" + o.producer + "->" + o.reviewer,
          decision: o.decision ?? "reject",
          note: o.note,
        },
        createdAt: NOW,
      },
      () => NOW,
    );
  }

  it("⭐ 这个角色判过一次 ⇒ 那次的理由进了它下一轮的提示词", async () => {
    const w = await world({});
    decideReview(w, {
      reviewer: "dev",
      producer: "director",
      note: "缺错误分支，打回",
    });
    const p = w.rt.deps.rolePrompt("dev");
    // 断的是【内容】而不是"某处调用了 renderMemoryBlock"：前者才是变异能吃到的东西。
    expect(p).toContain("缺错误分支，打回");
    expect(p).toContain("不是指令");
    // 反向对照（这一句是上面那发的分母）：换一个从没判过的角色读，
    // 得到的是「还没有可读的历史决定」，而不是同一句话。
    // 少了这一发，「内容出现」与「内容恒出现」不可区分（0045 §9 那个分母同族）。
    expect(w.rt.deps.rolePrompt("blank")).not.toContain("缺错误分支，打回");
    expect(w.rt.deps.rolePrompt("blank")).toContain("还没有可读的历史决定");
  });

  it("⭐ 审阅决定署的是【别人】的名 ⇒ 不进这个角色的提示词（隔离装上了而不是只写在模块里）", async () => {
    /*
     * 这一发钉的是"隔离判据在装配路径上还活着"。role-memory.ts 里那道闸测过一百次，
     * 而它对外零 import 的那些岁月里，模块内的隔离全对 + 装配层传错 owner
     * = dev 的提示词里躺着 CEO 的战略理由，而【没有一发测试会红】。
     */
    const w = await world({});
    decideReview(w, {
      reviewer: "director",
      producer: "dev",
      note: "别人的判定理由",
    });
    expect(w.rt.deps.rolePrompt("dev")).not.toContain("别人的判定理由");
    // 反向：署名人自己读得到（否则上面那条只是"根本没读到任何东西"）。
    expect(w.rt.deps.rolePrompt("director")).toContain("别人的判定理由");
  });

  it("⭐ order=newest 真的生效：库里很长时，提示词带的是【最近的】那条", async () => {
    /*
     * 这一发是 MemoryOrder 那一格存在的唯一证据。没有它，`order: "newest"` 是一个
     * 传进去而没人验的参数 —— 而它的失效方式是【静默且单向】的：默认 ASC 照样返回
     * 一堆看起来完全合理的旧决定，只是永远是最老的那些。
     *
     * 判法：灌 PROMPT_MEMORY_LIMIT + 5 条，最老那条带一个可辨认的串，
     * 最新那条带另一个 ⇒ 提示词里必须只有最新的、没有最老的。
     * 用「有条数不同」判不行（两个方向都给同样的条数）。
     */
    const w = await world({});
    const total = 10 + 5;
    for (let i = 0; i < total; i += 1) {
      decideReview(w, {
        reviewer: "dev",
        producer: "director",
        note:
          i === 0
            ? "最老那条理由"
            : i === total - 1
              ? "最新那条理由"
              : "中间第" + i + "条",
      });
    }
    const p = w.rt.deps.rolePrompt("dev");
    expect(p).toContain("最新那条理由");
    expect(p).not.toContain("最老那条理由");
  });

  it("⭐ 记忆读失败 ⇒ 【抛】，不 catch 成一句「没有历史」", async () => {
    /*
     * 与上面岗位书那一发同一个立场，而这里多一条更硬的理由：
     * memory/prompt.ts 那句"库里确实没有，不是读取失败"是【无条件】说的 ——
     * catch 之后那句话就成了谎。抛出去由 CLI 收成退出码 1，那是唯一的诚实读数。
     *
     * 造失败的办法：把 events 表改名。readRoleMemory 里那句 prepare 会当场抛，
     * 而它是这一支唯一会碰的东西（岗位书读的是 role_charters，不受影响 ⇒
     * 报错里【不该】有岗位书那句，否则这一发红的是别的东西）。
     */
    const w = await world({});
    w.db.exec("ALTER TABLE events RENAME TO events_gone");
    expect(() => w.rt.deps.rolePrompt("dev")).toThrow();
    expect(() => w.rt.deps.rolePrompt("dev")).not.toThrow(/没有你的岗位书/u);
  });

  it("CEO 那一格：战略记忆走的是【自己读自己】，所以它进得了 CEO 的提示词", async () => {
    /*
     * 这一发不是凑数。rolePrompt 现在被【所有】角色共用，而 CEO 那一格有两处特殊：
     *  ① dispatch 对 CEO 席位根本不调 rolePrompt（人类席位，不起子进程）——
     *     所以这条路径今天【在生产里不被走】，它活着是因为 charter-pump / work.ts
     *     那两个调用方按角色名调它。这一格必须说出来，否则会被读成"CEO 每轮都拿到"。
     *  ② strategic 档只在 owner=requester=ceo 时可见。装配层两处都传 roleId，
     *     所以它是【对】的 —— 而这件事只有真跑一遍才知道（写成注释就是许愿）。
     */
    const w = await world({});
    w.db
      .prepare(
        "INSERT INTO approvals (id, task_id, approval_type, summary, parameters, status) " +
          "VALUES ('A-1', 't1', 'strategic', '摘要', '{}', 'pending')",
      )
      .run();
    appendAudit(
      w.db as never,
      {
        taskId: "t1",
        actorType: "human",
        actorId: "ceo",
        action: "approval",
        target: "A-1",
        payload: {
          kind: "ApprovalDecided",
          approvalId: "A-1",
          resume: "approve",
        },
        stateSnapshot: { note: "这条线整个砍掉，明年不做" },
        createdAt: NOW,
      },
      () => NOW,
    );
    const p = w.rt.deps.rolePrompt("ceo");
    expect(p).toContain("这条线整个砍掉，明年不做");
    // 反向：同一条，dev 读不到（CEO 的战略理由进 agent 的 prompt 是本模块的第一红线）。
    expect(w.rt.deps.rolePrompt("dev")).not.toContain("这条线整个砍掉");
  });
});

describe("runtime 跑一轮：真 CLI 桩 + 真记账 + 真留痕", () => {
  it("一轮 pass 之后：状态推进、钱进了 budget_events 与 budgets、会话落 harness_calls", async () => {
    const w = await world({});
    const dispatch = makeDispatch(w.rt.deps);
    const res = await dispatch({
      taskId: "t1",
      nowMs: NOW + 1000,
      maxBudgetUsd: 0.5,
    });
    // 桩 CLI 的决策是 handoff 给 "tech"（图里没有这个角色）⇒ 越权，状态不动。
    // 这一发测的不是判定（dispatch.test.ts 测尽了），是【装配之后账还在不在】。
    expect(res.moved).toBe(false);
    expect(res.costCents).toBe(4); // 0.042 美元 ⇒ 4 美分

    const rec = await w.rt.recordTurn({
      taskId: "t1",
      role: res.role,
      sessionId: res.sessionId,
      costCents: res.costCents,
      ok: true,
      nowMs: NOW + 1000,
    });
    expect(rec.recorded).toBe(true);

    // 三处账必须一致：tasks / budget_events / budgets
    const task = w.db
      .prepare("SELECT consumed_cents FROM tasks WHERE id='t1'")
      .get();
    expect(task?.["consumed_cents"]).toBe(4);
    const be = w.db.prepare("SELECT * FROM budget_events").all();
    expect(be.length).toBe(1);
    expect(be[0]?.["amount_cents"]).toBe(4);
    expect(be[0]?.["scope_type"]).toBe("task");
    expect(be[0]?.["period"]).toBe("per_task");
    // 幂等键【是】本轮那条 events.id。刻意断在 res.stateEventSeq 而不是
    // 「events 表最后一行」：卡片与越权尝试那两行是在记账【之后】写的，所以最后一行
    // 不是记账用的那个 id —— 断成"最后一行"会把这条测试变成对写入顺序的猜测。
    const ids = w.db
      .prepare("SELECT id FROM events ORDER BY id")
      .all()
      .map((r) => Number(r["id"]));
    expect(be[0]?.["source_event"]).not.toBeNull();
    expect(ids).toContain(Number(be[0]?.["source_event"]));
    expect(Number(be[0]?.["source_event"])).toBe(res.stateEventSeq);
    const b = w.db
      .prepare("SELECT * FROM budgets WHERE scope_type='task'")
      .all();
    expect(b.length).toBe(1);
    expect(b[0]?.["consumed_cents"]).toBe(4);
    expect(b[0]?.["limit_cents"]).toBe(1000);

    const hc = w.db.prepare("SELECT * FROM harness_calls").all();
    expect(hc.length).toBe(1);
    expect(hc[0]?.["session_id"]).toBe("sess-1");
    expect(hc[0]?.["cost_cents"]).toBe(4);
    expect(hc[0]?.["exit_code"]).toBe(0);
    // 脱敏：那一列的名字是 redacted，prompt 由 CEO 输入、可能带业务机密。
    expect(String(hc[0]?.["args_redacted"])).not.toContain("做个 AI 笔记应用");

    // 下一轮真的能 resume 到这个会话（§5.9「打回时不从零开始」的落点）
    expect(w.rt.deps.roleSession("t1", "dev")).toBe("sess-1");
  });

  it("同一轮重复记账被幂等键挡下：budgets 不重复扣", async () => {
    const w = await world({});
    const dispatch = makeDispatch(w.rt.deps);
    const res = await dispatch({
      taskId: "t1",
      nowMs: NOW + 1000,
      maxBudgetUsd: 0.5,
    });
    // 幂等键取 res.stateEventSeq，【不是】events 表最后一行：这一轮被越权拦下，
    // 卡片与越权尝试那两行写在记账之后，最后一行是别的行 —— 拿它当键会插进
    // 【第二笔真账】（我第一次就是这么写的，于是这条测试自己造出了它要防的分叉）。
    const seq = res.stateEventSeq;
    if (seq === null) throw new Error("本轮没写下 events，无从谈幂等键");
    // 直接拿同一个 seq 再喂一次钩子（等价于「同一轮重试」）
    await w.q.node(() => {
      const db = w.q.writeConnection();
      // 走的是 runtime 里那条 onCost，不是重抄一遍 SQL
      const hook = w.rt.deps.onCost;
      if (hook === undefined) throw new Error("onCost 没装配");
      // `as never` 抄的是本文件 appendAudit 那几行的同一写法：CostHook 的 db 形参是
      // node:sqlite 的 DatabaseSync，而这里的 World.db 是【刻意收窄】的桩类型
      // （只声明 prepare/exec，见文件头第 49 行）。收窄是对的 —— 测试不该能顺手用
      // 到 14 个它不该碰的方法；代价就是喂给真签名时要过一次强转。
      hook({
        db: db as never,
        taskId: "t1",
        role: "dev",
        seq,
        costCents: 4,
        nowMs: NOW + 2000,
      });
      return null;
    });
    expect(w.db.prepare("SELECT * FROM budget_events").all().length).toBe(1);
    expect(
      w.db.prepare("SELECT consumed_cents FROM budgets").get()?.[
        "consumed_cents"
      ],
    ).toBe(4);
    // tasks 那一列【没有】幂等键可挡（dispatch.ts 的 centsForLeg 那条同源的说明），
    // 所以这一发同时在证明：钩子重复调用只动 budget_events 的去重，不会碰 tasks。
    expect(
      w.db.prepare("SELECT consumed_cents FROM tasks").get()?.[
        "consumed_cents"
      ],
    ).toBe(4);
  });

  it("留痕失败【不冒泡】但报 recorded:false —— 不能让整条命令非零退出而诱导重跑一轮", async () => {
    const w = await world({});
    // harness_calls.task_id 【没有】外键（0001 里那列是裸 TEXT），所以「指向不存在的任务」
    // 造不出失败 —— 会照样插进去。改成关队列：node() 当场抛「已关闭」，
    // 这才是本发要测的形状（写入这一侧失败，而状态与账都已提交）。
    await w.q.close();
    const r = await w.rt.recordTurn({
      taskId: "t1",
      role: "dev",
      sessionId: null,
      costCents: 1,
      ok: true,
      nowMs: NOW,
    });
    expect(r.recorded).toBe(false);
    expect(r.why).toContain("harness_calls");
    // 不抛错这件事本身是断言的重点：抛出去的话驱动方会非零退出，
    // 而使用者看到失败会【重跑整轮】= 再烧一次 token 去补一行日志。
  });

  it("costCents 为负 ⇒ 拒写，而不是给执行日志记一笔退款", async () => {
    const w = await world({});
    const r = await w.rt.recordTurn({
      taskId: "t1",
      role: "dev",
      sessionId: null,
      costCents: -5,
      ok: true,
      nowMs: NOW,
    });
    expect(r.recorded).toBe(false);
    expect(w.db.prepare("SELECT * FROM harness_calls").all().length).toBe(0);
  });

  it("图版本缺失时，dispatch 以「版本缺失」停下而【没有烧一次 token】（装配不给回退）", async () => {
    const w = await world({ graphVersion: 9 });
    const dispatch = makeDispatch(w.rt.deps);
    const res = await dispatch({
      taskId: "t1",
      nowMs: NOW + 1000,
      maxBudgetUsd: 0.5,
    });
    expect(res.moved).toBe(false);
    expect(res.note).toContain("版本 9");
    // 关键：一个 token 都没烧 ⇒ 一条 harness 调用都没发生
    expect(w.db.prepare("SELECT * FROM harness_calls").all().length).toBe(0);
    expect(w.db.prepare("SELECT * FROM budget_events").all().length).toBe(0);
    expect(
      w.db.prepare("SELECT consumed_cents FROM tasks").get()?.[
        "consumed_cents"
      ],
    ).toBe(0);
  });

  it("回调读的是【已提交】的东西：同轮内先写后读会读到旧值（runtime.ts 文件头那条边界）", async () => {
    const w = await world({});
    w.rt.deps.loadTask("t1");
    // 写连接改了状态、还没提交到读侧视野之外？—— WAL 下同一连接的未提交改动
    // 本来就看不见。这一发的作用是：如果有人把回调的读连接换成写连接，
    // 他会看到【未提交】数据，而下面这条断言会红。
    await w.q.node(() => {
      w.q
        .writeConnection()
        .prepare("UPDATE tasks SET title = '改了' WHERE id='t1'")
        .run();
      const inTx = w.q.writeConnection().prepare(LOAD_TASK_SQL).get("t1") as
        | Row
        | undefined;
      expect(inTx?.["title"]).toBe("改了");
      return null;
    });
    // 提交之后，只读连接看得到
    const after = w.rt.deps.loadTask("t1");
    expect(after?.title).toBe("改了");
  });

  /**
   * ── 重试外壳接在【真装配】上的两发（round305，Task 6.1 接线）────────────
   *
   * 判据本身在 turn-retry.test.ts 用注入的假执行器穷尽测了。这两发测的是
   * 【只有真路线才有的东西】：dispatch 的返回形状、三处账、harness_calls 的行数。
   *
   * ⚠ 本机造得出的 started:false 只有 ENOENT 一型（确定性 ⇒ 不重试），
   *   EMFILE / EAGAIN 那一族要把系统资源打满，本轮没有制造它。
   *   ⇒ 下面那发「ENOENT ⇒ 一次都不重试」是今天真机上【唯一真跑得通】的那一支，
   *     而「重试真的不记账」只能靠注入的假执行器构造（见第二发）。
   *   白名单里那五个名字【一个真样本都没有】，登记在台账 round305 §③。
   */
  it("⭐ 二进制不存在 ⇒ 一次都不重试，且账与留痕的形状与接线前逐字相同", async () => {
    const sleeps: number[] = [];
    const warns: string[] = [];
    const w = await world({
      bin: TMP + "/no-such-claude-305",
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onRetryWarn: (m) => warns.push(m),
    });
    const dispatch = makeDispatch(w.rt.deps);
    const res = await dispatch({
      taskId: "t1",
      nowMs: NOW + 1000,
      maxBudgetUsd: 0.5,
    });
    // 确定性失败：退避一次都不该开火。
    expect(sleeps, "ENOENT 是确定性的 ⇒ 判据不该放行").toEqual([]);
    expect(warns).toEqual([]);
    // dispatch 看到的是【一个普通失败轮】—— 重试外壳对它完全透明。
    expect(res.moved).toBe(false);
    expect(res.costCents).toBe(0);
    // 三处账【全空】：进程从未存在 ⇒ 没有钱可记（这是结构性结论，不是「没记到」）。
    expect(w.db.prepare("SELECT * FROM budget_events").all().length).toBe(0);
    expect(
      w.db.prepare("SELECT consumed_cents FROM tasks").get()?.[
        "consumed_cents"
      ],
    ).toBe(0);
    // 审计里【有】这一轮：任务停着必须能答出「哪一轮、为什么」。
    // ⚠ round312 改口（O6 Step B 接线）：原断言是 `evts[0]` 含「角色执行失败」——
    //   接线前 events 里这一族只有 dispatch 自己那一行，位置恰好是 0。现在 gateway 的
    //   harness_call 行在 runTurn 里先落库（id 更小），那一行变成了 dispatch 的在第 1 位。
    //   位置从来就不是判据（判据是「查得到」），所以按【存在性】断原话，
    //   并补 Step B 买到的那一格新事实：gateway 层自己也留了一行 adapter_error。
    const evts = w.db.prepare("SELECT action, payload FROM events").all();
    expect(evts.length).toBeGreaterThan(0);
    expect(
      evts.some((r: Row): boolean =>
        String(r["payload"]).includes("角色执行失败"),
      ),
      "dispatch 的失败轮话术还得在",
    ).toBe(true);
    const gwRows = evts.filter(
      (r: Row): boolean => r["action"] === "harness_call",
    );
    expect(gwRows, "gateway 层对这次「进程从未起来」也要留一行").toHaveLength(
      1,
    );
    expect(String(gwRows[0]?.["payload"])).toContain("adapter_error");
  });

  it("⭐ 瞬时 errno 放行重试时：多烧 4 次 spawn 而【一处账都不多记】（透明性判据）", async () => {
    // 本机造不出 EMFILE，所以这一发注入【假 runTurn】走真 dispatch + 真表。
    // 注入点是 deps 而不是 runtime：deps 就是 dispatch 吃的那排回调（装配形状），
    // 换掉 runTurn 不影响记账与留痕那两条 —— 而那正是这一发要数的东西。
    const w = await world({});
    let misses = 0;
    const warns: string[] = [];
    /** 假执行器：每次都交出「瞬时 errno + 进程从未起来」，让外壳退避到额度用尽。 */
    const alwaysMissed = async (): Promise<RoleRunResult> => {
      misses += 1;
      return {
        ok: false,
        text: "",
        sessionId: null,
        costUsd: 0,
        error: "进程表满了",
        started: false,
        spawnErrno: "EMFILE",
      };
    };
    const deps = {
      ...w.rt.deps,
      runTurn: async (i: RunTurnInput): Promise<TurnOutcome> => {
        const r = await runTurnWithRetry(
          alwaysMissed,
          {
            prompt: i.prompt,
            rolePrompt: i.rolePrompt,
            cwd: TMP,
            maxBudgetUsd: i.maxBudgetUsd,
          },
          {
            sleep: async () => {},
            onRetryWarn: (m) => warns.push(m),
          },
        );
        return {
          ok: r.ok,
          text: r.text,
          costCents: 0,
          sessionId: r.sessionId,
          error: r.error,
        };
      },
    };
    const res = await makeDispatch(deps)({
      taskId: "t1",
      nowMs: NOW + 1000,
      maxBudgetUsd: 0.5,
    });
    expect(misses, "1 次首跑 + 3 次重试").toBe(4);
    expect(warns.length).toBe(3);
    // ⭐ 这一发真正的断言：试了 4 次，而账面【只当发生过 0 次】（进程从未存在）。
    expect(w.db.prepare("SELECT * FROM budget_events").all().length).toBe(0);
    expect(w.db.prepare("SELECT * FROM harness_calls").all().length).toBe(0);
    expect(res.costCents).toBe(0);
    // 留痕那一侧同理：驱动方调一次 recordTurn，它记的是【这一轮】而不是每次尝试。
    const rec = await w.rt.recordTurn({
      taskId: "t1",
      role: res.role,
      sessionId: res.sessionId,
      costCents: res.costCents,
      ok: false,
      nowMs: NOW + 1000,
    });
    expect(rec.recorded).toBe(true);
    const hc = w.db.prepare("SELECT * FROM harness_calls").all();
    expect(hc.length, "一轮一行，重试不额外加行").toBe(1);
    expect(hc[0]?.["session_id"]).toBe(null);
    expect(hc[0]?.["cost_cents"]).toBe(0);
    expect(hc[0]?.["exit_code"]).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════
   ⭐ 岗位书的 harness_defaults 真的走到了 gateway 的授权侧（O6 动作 2 / round312）

   接线之前这一格是【结构上不可能被验】的：runTurn 直调 runRole，gateway 的授权侧
   （grantedSandbox / grantedForbidden）根本没有值可给。接线之后它有了库里的读数
   —— harness_call 那一行的 state_snapshot 里就钉着「当时授权到哪」。

   为什么必须有反向那一发（同 O2 那一节的家规）：主断言只写「有岗位书 ⇒ workspace-write」，
   那么「runtime 恒交 workspace-write、压根没读岗位书」也照样绿。反向那一发把
   同一份判据的【另一个输入】跑一遍，两个读数不同才证明中间那段是真的在搬数据。

   ⚠ 这一族【还没有】的凭据，写在这里而不是不说：
    · 「被重试判据放行那几次尝试不落审计缓冲」——本机造不出瞬时 errno（round305 §③
      同一条），注入假 runTurn 又绕开了这个缓冲（它在 runtime 内部），所以那一格今天
      只有代码形状、没有测试。上面那发「ENOENT 确定性 ⇒ 仍落一行」是它唯一相邻的实测。
    · settle / checkBudget 两个注入槽仍空（钱走 onCost，见 runtime.ts 注释），
      所以本文件不出现「budget_events 来自 gateway」这种断言。
   ═══════════════════════════════════════════════════════════════════ */
describe("runTurn → gateway 的授权侧：岗位书那一格落到审计行（O6 Step B）", () => {
  /** 跑一轮并取出 gateway 落的那一行 harness_call（payload + state_snapshot 都解开）。 */
  async function oneTurn(w: World): Promise<{
    payload: Row;
    snap: Row;
    rows: Row[];
  }> {
    const out = await w.rt.deps.runTurn({
      role: "dev",
      taskId: "t1",
      prompt: "把这件事做完",
      rolePrompt: "你是 dev。",
      resumeSessionId: null,
      maxBudgetUsd: 0.5,
    });
    expect(out.ok, out.error ?? "").toBe(true);
    const rows = w.db
      .prepare(
        "SELECT action, target, payload, state_snapshot FROM events WHERE action='harness_call'",
      )
      .all();
    expect(
      rows,
      "gateway 那一行必须【落到库里】，而不只是在内存 deps 里",
    ).toHaveLength(1);
    return {
      rows,
      payload: JSON.parse(String(rows[0]?.["payload"])) as Row,
      snap: JSON.parse(String(rows[0]?.["state_snapshot"])) as Row,
    };
  }

  it("⭐ 岗位书写了 workspace-write ⇒ 授权侧与请求侧【同一轮】都带着它落到库里", async () => {
    const w = await world({});
    await seedCharter(w, {
      harness_defaults: {
        claude_code: {
          sandbox: "workspace-write",
          forbidden_flags: ["--yolo"],
        },
      },
    });
    const { payload, snap } = await oneTurn(w);
    // 授权侧（被比侧）：这一格是 buildGatewayDeps 从岗位书读出来的那条读数。
    expect(snap["granted_sandbox"]).toBe("workspace-write");
    expect(snap["granted_forbidden"]).toEqual(["--yolo"]);
    // 请求侧：同一份 entry 的生效值。两侧同源这件事要在库里看得出来。
    expect(payload["sandbox"]).toBe("workspace-write");
    expect(snap["forbidden_flags"]).toEqual(["--yolo"]);
    // 这一发同时是「flush 真的落库」的凭据：slot 是同步签名、写库是异步，
    // 缓冲只在 runTurn 自己的 node() 里落 —— 没有这一句，「留痕了」可以是内存里的谎。
    expect(String(payload["status"])).toBe("ok");
    expect(payload["session_id"]).toBe("sess-1");
  });

  it("⭐ 反向对照：没有岗位书 ⇒ 落的是 read-only + 空基线，而不是上面那个值", async () => {
    // 没有 seedCharter：这一发的全部作用是【上一发不是恒真】。
    const w = await world({});
    const { payload, snap } = await oneTurn(w);
    expect(snap["granted_sandbox"]).toBe("read-only");
    expect(snap["granted_forbidden"]).toEqual([]);
    expect(payload["sandbox"]).toBe("read-only");
    // 岗位书缺位时 runtime 明说「没有你的岗位书」，而那一轮【照跑】：
    // 授权按最严档，不是装配期抛（NO_CHARTER_LINE 那条合法现状，见 runtime.ts 注释）。
    expect(w.rt.deps.rolePrompt("dev")).toContain("没有你的岗位书");
  });

  it("同一张库里岗位书按角色走：dev 的档位不会拼到 director 的授权侧", async () => {
    // 与上面 O2 那一发同族，防的是 readLatestCharter 的 roleId 绑参写错。
    // 这一格在 gateway 路线上比在提示词路线上更贵：档位绑错 = 授权放开到岗位书
    // 从未批过的档位，而审计行看起来一切正常。
    const w = await world({});
    await seedCharter(w, {
      harness_defaults: { claude_code: { sandbox: "workspace-write" } },
    });
    const out = await w.rt.deps.runTurn({
      role: "director",
      taskId: "t1",
      prompt: "审一下",
      rolePrompt: "你是 director。",
      resumeSessionId: null,
      maxBudgetUsd: 0.5,
    });
    expect(out.ok, out.error ?? "").toBe(true);
    const row = w.db
      .prepare("SELECT state_snapshot FROM events WHERE action='harness_call'")
      .all()[0];
    const snap = JSON.parse(String(row?.["state_snapshot"])) as Row;
    expect(snap["granted_sandbox"]).toBe("read-only");
    expect(snap["granted_forbidden"]).toEqual([]);
  });
});
