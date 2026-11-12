/**
 * 常驻 Hub 的驱动器（serve/driver-pump.ts）。
 *
 * ── 这一发测的是【节奏与上限】，不是【一轮里发生了什么】────────────────
 * 一轮的内容（dispatch 的边判定、审阅独立性、越权拦）由 engine/dispatch.test.ts 钉着，
 * 「什么时候停」由 engine/driver.test.ts 钉着。本文件只判驱动器【独有】的失效方式：
 *  A. 候选集合是【派生】的 —— 与 dispatch 放 agent 进场用的是同一个谓词，
 *     所以「那格该不该被驱动」不可能有两份答案。
 *  B. ⭐ 认领行的 target 与候选 SQL 里那句 `status || ':' || role` 的【往返】。
 *     那是同一句话的两种写法（TS 拼 + SQL 拼），而挡住漂移的不是注释是这一发：
 *     真写一行再用 SQL 去数它。分隔符、大小写、状态/角色顺序换掉，这一发当场红。
 *  C. 【有界】：同一格试到上限就不再认领。判据一律是【driveTask 被调了几次】而不是
 *     「有没有推进」—— 上限要挡的是花钱，而"没推进"是它的输入不是它的结果。
 *     ⚠ 与章程泵不同，这里的计数【按格】且【只认自己的认领行】：直接抄
 *     CHARTER_ATTEMPTS_SQL（整条任务的 RoleTurnReported）会让手跑几次 hub work
 *     就把自动那条路永久关掉。C 与 D 两组就是在钉这两半。
 *  D. 合法的【重访】重置预算：被打回又回来的一格，之前那些认领不该算进来。
 *  E. 绑参顺序（node:sqlite 绑错【不报错】）+ 那道花钱的门。
 *  F. 认领行【先于】花钱：崩溃那一支也被上限数进去。
 *  G. 与【停滞巡检】的相互作用 —— 这条是量出来而第一版量错的，见 I 组那段。
 *  H. 默认那一支（真子进程 + 真执行日志 + --agent-cwd/--max-budget-usd 真到进程里）。
 *  I. 两处【手抄】：CLAUDE_TURN_CAP_MS（claude.ts 里那个 180_000）与关机等待时长。
 *
 * ── 注入的是【整步 driveTask】而不是 runTurn ──────────────────────────
 * 与章程泵那边（注入 cardDeps 只换掉 spawn 那一格）【不同】，理由写在
 * DriveOptions.driveTask 旁边：本模块的逻辑本体就是那个循环，注到最里面那一格
 * 反而测不到循环。代价照记：H 组之前，「默认那一支」零覆盖 —— 那一组的存在
 * 就是为了不把这句话留在注释里。
 *
 * 跑法（离线、node v24.14.0）：
 *   PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH \
 *     node --experimental-transform-types --import /tmp/opc-harness/register.mjs \
 *     --test packages/hub/test/serve/driver-pump.test.ts
 */
import { mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fixtureTmp } from "../fixtures/fixture-dir.js";
import { migrate } from "../../src/db/migrate.js";
import { INSERT_DELEGATION_GRAPH_SQL } from "../../src/org/commit.js";
import { InMemoryEventBus } from "../../src/events/bus.js";
import { appendAudit } from "../../src/events/recorder.js";
import { requireScopeDb } from "../../src/checkpoint/tx-scope.js";
import { AGENT_EDGES, seatOf } from "../../src/engine/dispatch.js";
import type { AdvanceResult, AdvanceTurnLog } from "../../src/engine/driver.js";
import type { TaskState } from "../../src/graph/status.js";
import {
  DEFAULT_DRIVER_MAX_ATTEMPTS,
  DEFAULT_DRIVER_MAX_TURNS,
  DEFAULT_DRIVER_TASK_LIMIT,
  DRIVER_ACTOR,
  DRIVER_CELL_SEP,
  DRIVER_CLAIM_KIND,
  DRIVER_ELIGIBLE_STATES,
  DRIVER_GAVE_UP_KIND,
  CLAUDE_TURN_CAP_MS,
  driveTasks,
  driverAttemptsSql,
  driverBlockedSql,
  driverCellTarget,
  driverCandidatesSql,
  placeholdersFor,
  worstDriveWaitMs,
  type DriveOptions,
  type DriveRoundResult,
} from "../../src/serve/driver-pump.js";
import { DEFAULT_STALL_THRESHOLD_MS, patrolTasks } from "../../src/heartbeat/patrol.js";
import { TASK_STATES } from "../../src/graph/status.js";

const TMP = fixtureTmp("serve-driver-pump", import.meta.url);
const NOW = 1_700_000_000_000;

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

beforeAll(() => mkdirSync(TMP, { recursive: true }));
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
  bus: InMemoryEventBus;
  /** 第几次推、推的是【哪条】任务 —— 「上限生效」只能靠这个数出来。 */
  calls: { taskId: string; maxTurns: number; budget: number }[];
}

/**
 * 一张够深的组织图：ceo ← manager ← {dev, tech}。
 *
 * 深度不是脚手架细节：0047 那两发探针里，「顶层是谁」这一半【只有深图才踩得到】
 * （汇报深度上限 5，ceo←dev 那种两层图第一次就判得出）。驱动器每次推一条都要过
 * 门 0.5（resolveCeoRoleId），图读不出来 dispatch 直接 stop ⇒ 一轮不跑 ⇒
 * 下面每一发会绿在"根本没推"上。所以这张图是这一组的前置条件，不是装饰。
 */
const GRAPH = JSON.stringify({
  nodes: {
    ceo: { role_id: "ceo", can_manage: true, reports_to: null, model_family: "opus" },
    manager: { role_id: "manager", can_manage: true, reports_to: "ceo", model_family: "opus" },
    dev: { role_id: "dev", can_manage: false, reports_to: "manager", model_family: "opus" },
    tech: { role_id: "tech", can_manage: false, reports_to: "manager", model_family: "opus" },
  },
  edges: [],
});

/**
 * 任务【直接 SQL 插】而不是走 createTask：这一发要的是「有 N 条停在某一格」这个
 * 【状态】，而不是「建任务那条路对不对」。与 charter-pump.test.ts 同一条理由。
 */
async function world(
  o: { readonly tasks?: readonly { id: string; status: string; role: string }[] } = {},
): Promise<World> {
  const { WriteQueue } = await import("../../src/db/write-queue.js");
  const q = new WriteQueue(TMP + "/d-" + process.pid + "-" + ++fileSeq + ".db") as unknown as Queue;
  queues.push(q);
  const db = q.writeConnection();
  migrate(db as unknown as Parameters<typeof migrate>[0]);
  db.prepare(INSERT_DELEGATION_GRAPH_SQL).run("g1", 1, GRAPH, NOW, "ceo", "测试用组织图");
  const tasks = o.tasks ?? [{ id: "t1", status: "IN_PROGRESS", role: "manager" }];
  tasks.forEach((t, i) => {
    db.prepare(
      "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at, graph_version) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
    ).run(t.id, "想法 " + t.id, t.status, t.role, t.role, NOW + i, NOW + i);
  });
  return { db, q, bus: new InMemoryEventBus(), calls: [] };
}

/** 一条 AdvanceResult（只填 driveTasks 真读的那四格：turns / stopped / totalCostCents / status）。 */
function adv(o: {
  readonly stopped?: AdvanceResult["stopped"];
  readonly status?: string;
  readonly costCents?: number;
  readonly turns?: number;
  readonly note?: string;
}): AdvanceResult {
  const logs: AdvanceTurnLog[] = [];
  for (let i = 0; i < (o.turns ?? 1); i++) {
    logs.push({
      turn: i + 1,
      res: {
        taskId: "t1",
        role: "manager",
        moved: true,
        seat: "agent",
        note: o.note ?? "干了点活",
        costCents: o.costCents ?? 4,
        sessionId: null,
        stateEventSeq: null,
        card: null,
      },
      recorded: true,
      why: "已留痕",
    });
  }
  return {
    taskId: "t1",
    turns: logs,
    stopped: o.stopped ?? "stalled",
    totalCostCents: o.costCents ?? 4,
    status: o.status ?? "IN_PROGRESS",
  };
}

/**
 * 跑一趟驱动。
 *
 * `moveto` 给了就在推完之后【真的改那一格】（写一条 TaskStateChanged 并把 tasks.status
 * 挪过去）—— D 组要用它造「被推走又被打回」那种合法重访，而那必须留下状态边，
 * 因为 marker 判的就是那条边。直接 UPDATE 而不写边 = 造出一个库里不存在的形状，
 * 那一发就会绿在一个假前提上。
 */
async function drive(
  w: World,
  o: {
    readonly nowMs?: number;
    readonly ok?: boolean;
    readonly throwWith?: string;
    readonly moveto?: { status: string; role: string };
    readonly stopped?: AdvanceResult["stopped"];
    readonly costCents?: number;
    readonly taskLimitCents?: number;
    /** 不注入 ⇒ 走默认那一支（真 runtime + 真子进程）。只 H 组用。 */
    readonly real?: boolean;
    readonly bin?: string;
    readonly cwd?: string;
  } & Pick<DriveOptions, "maxAttempts" | "taskLimit" | "maxTurns"> = {},
): Promise<DriveRoundResult> {
  const nowMs = o.nowMs ?? NOW + 1000;
  const calls = w.calls;
  return driveTasks(w.q, w.bus, {
    nowMs,
    maxBudgetUsd: 0.5,
    taskLimitCents: o.taskLimitCents ?? 2 ** 40,
    cwd: o.cwd ?? TMP,
    ...(o.bin === undefined ? {} : { bin: o.bin }),
    ...(o.real === true
      ? {}
      : {
          driveTask: async (taskId: string, budget: number, maxTurns: number) => {
            calls.push({ taskId, budget, maxTurns });
            if (o.throwWith !== undefined) throw new Error(o.throwWith);
            if (o.moveto !== undefined) await moveTo(w, taskId, o.moveto.status, o.moveto.role, nowMs);
            return adv({ stopped: o.stopped, costCents: o.costCents ?? 4, status: o.moveto?.status });
          },
        }),
    ...(o.maxAttempts === undefined ? {} : { maxAttempts: o.maxAttempts }),
    ...(o.taskLimit === undefined ? {} : { taskLimit: o.taskLimit }),
    ...(o.maxTurns === undefined ? {} : { maxTurns: o.maxTurns }),
  });
}

/** 把任务挪到另一格并【写下那条状态边】（marker 判的就是它）。 */
async function moveTo(w: World, taskId: string, status: string, role: string, nowMs: number): Promise<void> {
  await w.q.node(() => {
    const db = requireScopeDb("test.driver-pump.moveTo");
    appendAudit(
      db,
      {
        taskId,
        actorType: "agent",
        actorId: role,
        action: "state_change",
        target: status,
        payload: { kind: "TaskStateChanged", taskId, to: status, summary: "测试造的边" },
        createdAt: nowMs,
      },
      () => nowMs,
    );
    db.prepare("UPDATE tasks SET status = ?, assigned_role = ?, current_node = ? WHERE id = ?").run(
      status,
      role,
      role,
      taskId,
    );
    return null;
  });
}

function rows(w: World, sql: string, ...a: unknown[]): Row[] {
  return w.db.prepare(sql).all(...(a as never[]));
}
function status(w: World, taskId: string): string {
  return String((w.db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as Row)["status"]);
}
/** 驱动器自己写的行，按 kind 取。 */
function driverRows(w: World, kind: string): Row[] {
  return rows(
    w,
    "SELECT id, actor_type, actor_id, action, target, payload, created_at FROM events " +
      "WHERE json_extract(payload, '$.kind') = ? ORDER BY id",
    kind,
  );
}
/**
 * 候选 SQL 单独跑一次（判"下一轮还会不会推它"，不花任何钱）。
 *
 * ⚠ limit 【写死成 20 而没有参数位】：这一发要判的是"哪些任务在候选里"，
 * 而一轮推几条是【 driveTasks 那一侧】的事（E 组用 r.driven 的长度判它）。
 * 这里要是也开一个 limit 参数，"这格还会不会被推"就和"这一轮排到第几条"混进
 * 同一发判据 —— 而后者会因为 updated_at 相等而不确定（同毫秒），前者不该不确定。
 * 预算同理固定成极大值：这一发只问"还有没有路"，不问"还有没有钱"（E 组问钱）。
 */
function candidates(w: World, maxAttempts = DEFAULT_DRIVER_MAX_ATTEMPTS): string[] {
  return (
    w.db
      .prepare(driverCandidatesSql(DRIVER_ELIGIBLE_STATES))
      .all(...DRIVER_ELIGIBLE_STATES, maxAttempts, 2 ** 40, 20) as Row[]
  ).map((x) => String(x["id"]));
}
/** 这条任务在【当前这一格】被认领了几次（用生产那份 SQL，不是另写一份）。 */
function claimCount(w: World, taskId: string): number {
  const r = w.db
    .prepare("SELECT " + driverAttemptsSql("t") + " AS n FROM tasks t WHERE t.id = ?")
    .get(taskId) as Row | undefined;
  return Number(r?.["n"] ?? 0);
}
/** 花掉的预算写进 budgets（那道门读的那一列）。 */
function spend(w: World, taskId: string, cents: number): void {
  w.db
    .prepare(
      "INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, consumed_cents, hard_stop) " +
        "VALUES (?, 'task', ?, 'per_task', ?, ?, 1) " +
        "ON CONFLICT(scope_type, scope_id, period) DO UPDATE SET consumed_cents = excluded.consumed_cents",
    )
    .run("task|" + taskId + "|per_task", taskId, cents, cents);
}

/* ──────────────────────────────────────────────────────────────────────────
 * A. 候选集合是【派生】的
 * ────────────────────────────────────────────────────────────────────────── */
describe("A. 候选集合派生自边表，而不是抄一份名单", () => {
  it("⭐ 派生集合【恰好等于】「dispatch 会放 agent 进去」那些格", () => {
    // 这一发钉的是【同一性】而不是内容：驱动器问的是 seatOf，dispatch 问的也是 seatOf，
    // 所以「这条边能走」与「这格会被驱动」在编译期就是同一件事。
    // 抄一份名单的坏法在这里是构造不出来的 —— 名单必须逐格等于派生结果。
    const derived = TASK_STATES.filter((s) => seatOf(s) === "agent");
    expect([...DRIVER_ELIGIBLE_STATES].sort()).toEqual([...derived].sort());
  });

  it("每一格都真有一条 agent 出边（派生的定义，反向也判）", () => {
    for (const s of DRIVER_ELIGIBLE_STATES) {
      expect(Object.keys(AGENT_EDGES[s] ?? {}).length).toBeGreaterThan(0);
    }
    for (const s of TASK_STATES) {
      const hasEdge = Object.keys(AGENT_EDGES[s] ?? {}).length > 0;
      expect(DRIVER_ELIGIBLE_STATES.includes(s)).toBe(hasEdge);
    }
  });

  it("⭐ MEETING_REQUIRED / BLOCKED【结构性地】进不了候选：不是被名单排除，是没有可走的路", async () => {
    // 0047 §7 末尾那条括号里量过的事实。这一发把它钉在【行为】上：
    // 库里真停着这两格的任务 ⇒ 一次都不推、一次都不认领。
    // （边表给它们加上出边的那天，这一发会红并逼改的人回来看 0046 §6 第 4 条。）
    const w = await world({
      tasks: [
        { id: "t1", status: "MEETING_REQUIRED", role: "manager" },
        { id: "t2", status: "BLOCKED", role: "manager" },
        { id: "t3", status: "CHARTER_PENDING", role: "manager" },
        { id: "t4", status: "ESCALATED_TO_CEO", role: "ceo" },
        { id: "t5", status: "FINAL_REVIEW", role: "ceo" },
      ],
    });
    const r = await drive(w);
    expect(r.driven).toHaveLength(0);
    expect(w.calls).toHaveLength(0);
    expect(driverRows(w, DRIVER_CLAIM_KIND)).toHaveLength(0);
  });

  it("⭐ BUDGET_PAUSED【在】候选里，而那是 0047 §7 选定的 (A)：花钱让角色自己说 blocked", async () => {
    // 这一发是【决定】而不是事实，所以它得能被红。
    // 派生结果包含它（有一条 blocked → ESCALATED_TO_CEO 的 agent 出边），
    // 而 (B)（hub 免钱直接走那条边）会把这一发变成"它不在候选里"或直接跳过它。
    // 今天【没有任何代码写那个状态】（0041 §7），所以这一发在真库里没有分母 ——
    // 这里造的是"如果有了，驱动器的做法是这个"。（诚实：这一发不证明今天有任务在那格。）
    expect(DRIVER_ELIGIBLE_STATES).toContain("BUDGET_PAUSED");
    const w = await world({ tasks: [{ id: "t1", status: "BUDGET_PAUSED", role: "manager" }] });
    const r = await drive(w);
    expect(w.calls.map((c) => c.taskId)).toEqual(["t1"]);
    expect(r.driven[0]?.state).toBe("BUDGET_PAUSED");
  });

  it("候选 SQL 用的是【绑定占位符】而不是拼进 SQL 的状态字面量", () => {
    // 值出自派生集合。拼字符串在派生集合出现意外名字时会变成【语法错误】或更糟
    // （一句恒真条件）；绑定的话同样的错误只是筛不出东西。
    const sql = driverCandidatesSql(["IN_PROGRESS", "IN_REVIEW"]);
    expect(sql).toContain("IN (?, ?)");
    expect(sql).not.toContain("'IN_PROGRESS'");
    expect(placeholdersFor(1)).toBe("?");
    expect(placeholdersFor(3)).toBe("?, ?, ?");
  });

  it("空状态集合【抛】而不是拼出 `IN ()`", () => {
    // `IN ()` 是 SQLite 语法错误，而把它换成"返回恒空候选"更坏：
    // 那看起来像"今天没有可驱动的任务"，而真相是配置/边表坏了。
    // 正则而不是字面量比较：toThrow(字符串) 判的是【包含】，而包含挡不住
    // 原句哪天被改写成"...必须至少要有 1 格..."这种同样能过的写法之外的漂移方向。
    expect(() => placeholdersFor(0)).toThrow(/至少要有 1 格/u);
    expect(() => driverCandidatesSql([])).toThrow(/至少要有 1 格/u);
    expect(() => driverBlockedSql([])).toThrow(/至少要有 1 格/u);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * B. ⭐ 认领行的 target 与 SQL 里那句拼接的【往返】
 *
 * driverCellTarget 是 TS 侧的 `state + ":" + role`，driverAttemptsSql 里是
 * `t.status || ':' || t.assigned_role` —— 【同一句话的两种写法】。
 * 我没有办法把它们合成一份（一行审计的 target 只在写的时候知道，计数只能在读时按列拼），
 * 所以挡住漂移的必须是这一发：真写一行，再让 SQL 去数它。
 * ────────────────────────────────────────────────────────────────────────── */
describe("B. 认领行的 target 能被候选 SQL 数回来（两份抄件的往返判据）", () => {
  it("⭐ 真写一行 ⇒ SQL 数出 1，且 target 逐字等于 SQL 那句拼出来的值", async () => {
    const w = await world();
    await drive(w);
    const claims = driverRows(w, DRIVER_CLAIM_KIND);
    expect(claims).toHaveLength(1);
    // ① TS 侧拼的 target
    expect(String(claims[0]?.["target"])).toBe(driverCellTarget("IN_PROGRESS", "manager"));
    // ② SQL 侧拼的同一个值 —— 这两句【必须同值】，而这一发就是让它们不可能不同值。
    const sqlSide = w.db
      .prepare("SELECT status || '" + DRIVER_CELL_SEP + "' || assigned_role AS t FROM tasks WHERE id = 't1'")
      .get() as Row;
    expect(String(sqlSide["t"])).toBe(String(claims[0]?.["target"]));
    // ③ 数得回来。少了这一句，上面两条只证明"两边写了同一个字符串"，不证明数得到。
    expect(claimCount(w, "t1")).toBe(1);
    expect(candidates(w)).toContain("t1");
  });

  it("角色【不同】就不算同一格：换人 ⇒ 认领预算重新开始（打回换了人正是'这次可能不一样'）", async () => {
    const w = await world();
    await drive(w);
    expect(claimCount(w, "t1")).toBe(1);
    // 同一格而换了负责角色（打回后重派）。target 不带角色的实现会数出 2 ⇒ 这一发红。
    await moveTo(w, "t1", "IN_PROGRESS", "dev", NOW + 5000);
    expect(claimCount(w, "t1")).toBe(0);
  });

  it("target 的形状是【状态:角色】而不是【角色:状态】", () => {
    // 顺序不是排版：候选 SQL 那边是 status || ':' || assigned_role，
    // 而 driverCellTarget 的两个参数都是 string，TS 分不出来。
    expect(driverCellTarget("IN_PROGRESS", "dev")).toBe("IN_PROGRESS:dev");
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * C. 有界：同一格试到上限就不再推
 * ────────────────────────────────────────────────────────────────────────── */
describe("C. 同一格试到上限 ⇒ 一次都不再推，并且【说话】", () => {
  it("⭐ 第 N+1 轮【一次 driveTask 都不调】—— 那一次真金白银被子进程挡住了", async () => {
    const w = await world();
    await drive(w, { maxAttempts: 2 }); // 认领 1
    expect(w.calls).toHaveLength(1);
    await drive(w, { maxAttempts: 2, nowMs: NOW + 2000 }); // 认领 2 ⇒ 到顶 ⇒ 判放弃
    expect(w.calls).toHaveLength(2);
    // 第三轮：候选 SQL 已经把它滤掉 ⇒ 一次都不推。
    // ⚠ 断的是【调用次数没涨】而不是"结果里没它"：后者在"推进了但没记上"那种坏法下会绿。
    const r3 = await drive(w, { maxAttempts: 2, nowMs: NOW + 3000 });
    expect(w.calls).toHaveLength(2);
    expect(r3.driven).toHaveLength(0);
    expect(candidates(w, 2)).toEqual([]);
  });

  it("到顶那一轮留下【一行】DriverTurnAbandoned，内容是【那一格】而不是别的格", async () => {
    const w = await world();
    await drive(w, { maxAttempts: 1 });
    const gone = driverRows(w, DRIVER_GAVE_UP_KIND);
    expect(gone).toHaveLength(1);
    const p = JSON.parse(String(gone[0]?.["payload"])) as Record<string, unknown>;
    expect(p["state"]).toBe("IN_PROGRESS");
    expect(p["role"]).toBe("manager");
    expect(Number(p["attempts"])).toBe(1);
    expect(Number(p["max_attempts"])).toBe(1);
    expect(String(gone[0]?.["target"])).toBe(driverCellTarget("IN_PROGRESS", "manager"));
  });

  it("⭐ 放弃那一行的 actor 是【system / driver_pump】而绝不是 agent/角色名", async () => {
    // 0047 花整篇消灭的那行 `actor_type='agent', actor_id='ceo'` 的复刻：
    // 认领/放弃是【决定叫谁干活】这件事，不是【干活】。写成 agent 就是往
    // append-only 库里写一句"某个角色跑了一轮"而那个角色什么都没被叫起来。
    const w = await world();
    await drive(w, { maxAttempts: 1 });
    const all = [...driverRows(w, DRIVER_CLAIM_KIND), ...driverRows(w, DRIVER_GAVE_UP_KIND)];
    expect(all.length).toBeGreaterThanOrEqual(2);
    for (const row of all) {
      expect(String(row["actor_type"])).toBe(DRIVER_ACTOR.actorType);
      expect(String(row["actor_id"])).toBe(DRIVER_ACTOR.actorId);
      expect(String(row["actor_id"])).not.toBe("manager");
    }
    // action 复用 §22.1 里那个既有的 'tool_call'（十个值是 append-only 枚举，不开第 11 个）。
    expect(String(all[0]?.["action"])).toBe("tool_call");
  });

  it("放弃之后【再来一条合法重访】⇒ 它重新可驱动（上限不是终身制）", async () => {
    const w = await world();
    await drive(w, { maxAttempts: 1 });
    expect(candidates(w, 1)).toEqual([]);
    await moveTo(w, "t1", "IN_PROGRESS", "manager", NOW + 9000);
    expect(candidates(w, 1)).toEqual(["t1"]);
  });

  it("⭐ 任务被推走了就【不该】判放弃：先判还在不在那一格，再数次数", async () => {
    // 顺序是判据：任务离开那一格之后，driverAttemptsSql 数的是【新格】的次数
    // （新 marker ⇒ 认领为零），"次数不到上限"会替它说话而掩盖真正的理由
    // （真正的理由是"这一格已经被离开了，试到上限这件事不再成立"）。
    // 把两道判断调换顺序，这一发会留下一行假放弃记录 ⇒ 红。
    const w = await world();
    await drive(w, { maxAttempts: 1, moveto: { status: "IN_REVIEW", role: "tech" } });
    expect(status(w, "t1")).toBe("IN_REVIEW");
    expect(driverRows(w, DRIVER_GAVE_UP_KIND)).toHaveLength(0);
    expect(driverRows(w, DRIVER_CLAIM_KIND)).toHaveLength(1);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * D. 合法的【重访】重置按格预算（marker 那一半）
 * ────────────────────────────────────────────────────────────────────────── */
describe("D. marker：只有【这一次来到这一格之后】的认领才算数", () => {
  it("⭐ 被打回又回来的那一格，之前那些认领【不算进来】", async () => {
    // 少了条件 ②，一条被来回打三回的任务会在第三次之后【永久不可驱动】，
    // 而界面上一句提示都没有。上限本该挡"反复花钱而没推进"，那样它会变成
    // "推进过的事也算错过"。
    const w = await world();
    await drive(w, { maxAttempts: 2 }); // 认领 #1
    expect(claimCount(w, "t1")).toBe(1);
    // 被推走 ⇒ 又被打回【同一格】（新的状态边 = 新的 marker）
    await moveTo(w, "t1", "IN_PROGRESS", "manager", NOW + 2000);
    expect(claimCount(w, "t1")).toBe(0);
    // 第二轮：认领 #2，但落在新 marker 之后 ⇒ 这一格的计数仍是 1 ⇒ 【不该】判放弃。
    const r = await drive(w, { maxAttempts: 2, nowMs: NOW + 3000 });
    expect(r.driven.some((d) => d.outcome === "gave_up")).toBe(false);
    expect(driverRows(w, DRIVER_GAVE_UP_KIND)).toHaveLength(0);
    expect(driverRows(w, DRIVER_CLAIM_KIND)).toHaveLength(2); // 总共两次，各自在一格里
  });

  it("⭐ marker 用【插入序 id】而不是 created_at：同一毫秒写的两条也算得对", async () => {
    // 生产里同一轮心跳的认领行与状态边【共享同一个 nowMs】，所以"同毫秒"是常态而不是边缘。
    // 先写状态边、后写认领行 ⇒ 按 id 判：认领在"进入这一格"之后 ⇒ 算 1 次。
    // 换成 created_at 比：T > T 为假 ⇒ 数出 0 ⇒ 上限永远不生效 ⇒ 无限重试。
    const w = await world();
    await moveTo(w, "t1", "IN_PROGRESS", "manager", NOW + 1000); // marker，created_at = NOW+1000
    await drive(w, { nowMs: NOW + 1000 }); // 认领行【同一个毫秒】而 id 更大
    const claims = driverRows(w, DRIVER_CLAIM_KIND);
    const markerId = Number(
      (rows(w, "SELECT id FROM events WHERE json_extract(payload,'$.kind') = 'TaskStateChanged' ORDER BY id")[0]?.[
        "id"
      ] ?? 0) as number,
    );
    expect(Number(claims[0]?.["id"])).toBeGreaterThan(markerId); // 判据依赖的形状
    expect(Number(claims[0]?.["created_at"])).toBe(NOW + 1000); // 时间上【分不出来】
    expect(claimCount(w, "t1")).toBe(1); // ← 这一句才是靶心
  });

  it("状态边【指向另一格】时不当 marker（否则一次无关跃迁会把认领预算清零）", async () => {
    const w = await world();
    // 一条 to='IN_REVIEW' 的边，而任务此刻在 IN_PROGRESS ⇒ 不该成为这一格的 marker。
    await moveTo(w, "t1", "IN_REVIEW", "tech", NOW + 1000);
    await moveTo(w, "t1", "IN_PROGRESS", "manager", NOW + 2000);
    expect(claimCount(w, "t1")).toBe(0);
    await drive(w, { nowMs: NOW + 3000 });
    expect(claimCount(w, "t1")).toBe(1);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * E. 绑参顺序 + 那道花钱的门
 * ────────────────────────────────────────────────────────────────────────── */
describe("E. 绑参顺序与那道花钱的门", () => {
  it("⭐ taskLimit=1 而 taskLimitCents 极大 ⇒ 门【还是门】，一轮只推一条", async () => {
    // node:sqlite 绑错顺序【不抛】。错绑一份，SQL 仍然合法，而表现是
    // "一轮最多推 3 条"被当成"上限 3 美分" ⇒ 驱动器几乎永远不推而一声不响。
    // 形状取【上限极大而 taskLimit=1】：门要是被 limit 顶掉就一条都推不出来。
    const w = await world({
      tasks: [
        { id: "t1", status: "IN_PROGRESS", role: "manager" },
        { id: "t2", status: "IN_PROGRESS", role: "dev" },
      ],
    });
    const r = await drive(w, { taskLimit: 1, taskLimitCents: 100_000_000 });
    expect(r.driven).toHaveLength(1);
    expect(w.calls).toHaveLength(1);
  });

  it("⭐ 已花到上限的任务【不进候选】：一次都不推", async () => {
    const w = await world();
    spend(w, "t1", 150);
    const r = await drive(w, { taskLimitCents: 100 });
    expect(r.driven).toHaveLength(0);
    expect(w.calls).toHaveLength(0);
  });

  it("刚好等于上限也挡，少一分放行（>= 与 > 的分界不能糊）", async () => {
    const w = await world();
    spend(w, "t1", 100);
    expect((await drive(w, { taskLimitCents: 100 })).driven).toHaveLength(0);
    const w2 = await world();
    spend(w2, "t1", 99);
    expect((await drive(w2, { taskLimitCents: 100 })).driven).toHaveLength(1);
  });

  it("⭐ 被挡住的那条进 blocked，而且【穿过候选为空的早退】", async () => {
    // 被门挡住的任务【按定义不在候选里】，所以"候选为空 ⇒ 立刻 return"那句一旦先跑，
    // blocked 永远是空数组，而"系统因为没钱而不再推这条想法"就与"驱动器没开"同屏。
    const w = await world();
    spend(w, "t1", 150);
    const r = await drive(w, { taskLimitCents: 100 });
    expect(r.driven).toHaveLength(0);
    expect(r.blocked).toEqual([{ taskId: "t1", title: "想法 t1", consumedCents: 150 }]);
  });

  it("blocked 只数【本该成为候选而因为钱没成为候选】那批", async () => {
    const w = await world({
      tasks: [
        { id: "t1", status: "IN_PROGRESS", role: "manager" }, // 超限 ⇒ 该进
        { id: "t2", status: "IN_PROGRESS", role: "dev" }, // 正常候选
        { id: "t3", status: "MEETING_REQUIRED", role: "manager" }, // 不归驱动器管
        { id: "t4", status: "IN_PROGRESS", role: "tech" }, // 试到上限 ⇒ 也不进
      ],
    });
    spend(w, "t1", 150);
    await drive(w, { maxAttempts: 1, taskLimitCents: 100, nowMs: NOW + 1000 }); // t4 认领一次就到顶
    const r = await drive(w, { maxAttempts: 1, taskLimitCents: 100, nowMs: NOW + 2000 });
    expect(r.blocked.map((b) => b.taskId)).toEqual(["t1"]);
  });

  it("候选与 blocked 读的是【同一个】预算谓词常量（同源，不是两份抄本）", () => {
    // 抄本漂了的表现有两种，都坏：门挡了而 blocked 数不到（沉默），或反过来（谎报）。
    const cand = driverCandidatesSql(["IN_PROGRESS"]);
    const blocked = driverBlockedSql(["IN_PROGRESS"]);
    const budget = "b.period = 'per_task'";
    expect(cand).toContain(budget);
    expect(blocked).toContain(budget);
    expect(blocked).toContain("NOT ("); // 同一谓词取反，不是另写一份比较
    expect(cand.match(/\?/g)?.length).toBe(4); // 状态外：attempts / 预算 / limit
  });

  it("一轮最多推 taskLimit 条（默认 " + DEFAULT_DRIVER_TASK_LIMIT + "）", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      id: "t" + i,
      status: "IN_PROGRESS",
      role: i % 2 === 0 ? "manager" : "dev",
    }));
    const w = await world({ tasks: many });
    const r = await drive(w);
    expect(r.driven).toHaveLength(DEFAULT_DRIVER_TASK_LIMIT);
  });

  it("最久没动的先推（ORDER BY updated_at，且【确定序】⇒ 不会互相饿死）", async () => {
    const w = await world({
      tasks: [
        { id: "newer", status: "IN_PROGRESS", role: "manager" },
        { id: "older", status: "IN_PROGRESS", role: "dev" },
      ],
    });
    w.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = 'older'").run(NOW - 100_000);
    const r = await drive(w, { taskLimit: 1 });
    expect(r.driven.map((d) => d.taskId)).toEqual(["older"]);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * F. 先认领后花钱（崩溃那一支也被上限数进去）
 * ────────────────────────────────────────────────────────────────────────── */
describe("F. 认领行【先于】花钱：崩溃循环正是上限要挡的那种", () => {
  it("⭐ driveTask 抛了 ⇒ 认领行【还在】，所以下一轮数得到这一次", async () => {
    // "跑完再记"的记法会【恰好漏掉全部崩溃】—— 起了子进程而没活到写结论的那些次
    // 正是需要上限的那些次，于是上限看起来在而永远数不到它们。
    const w = await world();
    const r = await drive(w, { throwWith: "spawn claude ENOENT" });
    expect(r.driven[0]?.outcome).toBe("threw");
    expect(driverRows(w, DRIVER_CLAIM_KIND)).toHaveLength(1);
    expect(claimCount(w, "t1")).toBe(1);
  });

  it("抛的那一支【不谎报花费】：note 说的是拿不到，而不是 0", async () => {
    // advance 抛的时候钱可能已经花了，而那个数在它内部的累加器里，抛错拿不到。
    // 写 0 会是"一句听起来像结论的谎"。
    const w = await world();
    const r = await drive(w, { throwWith: "子进程被 SIGKILL" });
    const note = String(r.driven[0]?.note);
    expect(note).toContain("可能已经花掉钱");
    expect(note).toContain("harness_calls");
    expect(note).toContain("spawn" === "spawn" ? "子进程被 SIGKILL" : "");
  });

  it("一条抛了【不牵连】同轮其它任务（逐条各自不牵连）", async () => {
    const w = await world({
      tasks: [
        { id: "t1", status: "IN_PROGRESS", role: "manager" },
        { id: "t2", status: "IN_PROGRESS", role: "dev" },
      ],
    });
    let n = 0;
    const prev = w.calls;
    const r = await driveTasks(w.q, w.bus, {
      nowMs: NOW + 1000,
      maxBudgetUsd: 0.5,
      taskLimitCents: 2 ** 40,
      cwd: TMP,
      driveTask: async (taskId: string) => {
        prev.push({ taskId, budget: 0.5, maxTurns: 12 });
        n += 1;
        if (n === 1) throw new Error("第一条推炸了");
        return adv({});
      },
    });
    expect(r.driven.map((d) => d.outcome)).toEqual(["threw", "driven"]);
    // 整轮【没有】抛到调用方 —— 抛上去会变成心跳失败计数，连番之后停掉整条心跳（含巡检与备份）。
    expect(r.abandoned).toEqual([]);
  });

  it("三条上限参数坏掉 ⇒ 在任何读写【之前】抛，而不是静默什么都不做", async () => {
    // maxAttempts=0 会让候选恒空，表现是"驱动器在跑而永远无事可做"，
    // 那不是配置错该有的样子。
    const w = await world();
    for (const bad of [{ maxAttempts: 0 }, { taskLimit: 0 }, { maxTurns: 0 }] as const) {
      await expect(
        driveTasks(w.q, w.bus, {
          nowMs: NOW,
          maxBudgetUsd: 0.5,
          taskLimitCents: 100,
          cwd: TMP,
          ...bad,
        }),
      ).rejects.toThrow(/>= 1 的整数/u);
    }
    expect(driverRows(w, DRIVER_CLAIM_KIND)).toHaveLength(0);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * G. 停机原因怎么说
 * ────────────────────────────────────────────────────────────────────────── */
describe("G. 停机原因说人话，而且不说「再去敲 hub work」", () => {
  it("停在人类席位 ⇒ 说清下一次点击在谁手上", async () => {
    const w = await world();
    const r = await drive(w, { stopped: "human_seat", status: "CHARTER_PENDING" });
    expect(r.driven[0]?.note).toContain("人类席位");
    expect(r.driven[0]?.note).toContain("点击");
  });

  it("⭐ 四条停机分支【没有一条】教人再敲 hub work", async () => {
    // 那是引擎里 describeAdvance 给 stalled 写的那句补救话，而它出现在自动路径上
    // 正是 0043 抓过的那类「报错教的那一步跑不起来」—— 驱动器存在的全部理由
    // 就是没有人再敲那条命令。
    const stops: AdvanceResult["stopped"][] = ["human_seat", "stalled", "limit", "gone"];
    for (const stopped of stops) {
      const w = await world();
      const r = await drive(w, { stopped });
      const note = String(r.driven[0]?.note ?? "");
      expect(note.length).toBeGreaterThan(0);
      expect(note).not.toContain("hub work");
      expect(note).not.toContain("hub:engine");
    }
  });

  it("一轮都没跑起来 ⇒ 说「一轮都没跑起来」而不是编一个状态", async () => {
    const w = await world();
    const r = await driveTasks(w.q, w.bus, {
      nowMs: NOW + 1000,
      maxBudgetUsd: 0.5,
      taskLimitCents: 2 ** 40,
      cwd: TMP,
      driveTask: async () => adv({ turns: 0 }),
    });
    expect(r.driven[0]?.note).toContain("一轮都没跑起来");
    expect(r.driven[0]?.turns).toBe(0);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * H. 与【停滞巡检】的相互作用 —— 这一组是量出来而第一版量错的
 *
 * 我第一版在三处写着「认领行把计时器一直拨着 ⇒ 巡检【永远不会】报这一格」，
 * 那是【读了一遍 PATROL_SQL 就下的结论而没跑一遍】。跑完（本组两发）：
 *   · 还在试的那几轮 ⇒ 认领行确实把 last_real_event_at 拨着，巡检看不见（真的盲区）；
 *   · 放弃之后 ⇒ 认领行不再产生 ⇒ 计时器开始变老 ⇒ 约一个阈值之后巡检【会】报它。
 * 所以正确的说法是【两个时段】，而"io.warn 必须响"这条结论不变、理由要换准
 * （当场 vs 延后约半小时；不依赖心跳还活着；说得出成因）。
 * 这两发留着，是因为那句话说错的方向很坏：它会让人以为巡检坏了并去改巡检。
 *
 * ⚠ 这一组一律用【patrolTasks】（只判不写）而不是 runPatrol。第一次我把两发串在
 * 同一个库里跑，第二发量到的是 already_flagged 而不是 stalled —— 因为第一发的
 * runPatrol 自己写了 HeartbeatStalled，而巡检的去重判据正是「最后一次心跳事件
 * 晚于最后一次真实事件」。也就是说【测试自己踩中了被测的那个去重】，
 * 那种绿与那种红都不说明驱动器的事。所以每发一个【新库】，并且判据取只读那一发；
 * 生产里"报过之后就闭嘴"这件事由 patrol.test.ts 自己钉着，不在这里重复。
 * ────────────────────────────────────────────────────────────────────────── */
describe("H. 与停滞巡检的相互作用：认领行只在【还在试的那几轮】里挡着巡检", () => {
  /** 只判不写（见上面那段）。返回 t1 那一格的结论。 */
  function verdict(w: World, now: number): { verdict: string; silentForMs: number } {
    const js = patrolTasks(w.q.readConnection(), { now: () => now });
    const j = js.find((x) => x.id === "t1");
    if (j === undefined) throw new Error("巡检结果里没有 t1：" + JSON.stringify(js));
    return { verdict: String(j.verdict), silentForMs: j.silentForMs };
  }
  /** 把任务挪到"四十分钟没动静"那一档（阈值 30 分钟 ⇒ 没有认领行时它【该】被判停滞）。 */
  function aged(w: World): void {
    w.db.prepare("UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = 't1'").run(NOW - 40 * 60_000, NOW - 40 * 60_000);
  }

  it("⭐ 还在试：刚写完认领行的那一刻，巡检判它【不停滞】（被自己的认领行挡着）", async () => {
    const w = await world();
    aged(w);
    // 先立住分母：没有认领行的话这一格【就是】停滞。少了这一句，
    // 下面那句 "recent" 可以绿在"任务本来就不该被报"上（比如状态不在 WATCHED_STATES 里）。
    expect(verdict(w, NOW).verdict).toBe("stalled");
    await drive(w, { nowMs: NOW });
    // 同一时刻再巡：那一行认领把 last_real_event_at 推到 NOW ⇒ 不再停滞。
    // 这就是那个【真实存在的盲区】：驱动器连着试三次的这半小时里，巡检一句都不说。
    const after = verdict(w, NOW);
    expect(after.verdict).toBe("recent");
    expect(after.silentForMs).toBe(0);
  });

  it("⭐ 放弃之后：认领行停笔 ⇒ 约一个阈值之后巡检【会】自己报这一格", async () => {
    const w = await world();
    aged(w);
    await drive(w, { maxAttempts: 1, nowMs: NOW });
    expect(driverRows(w, DRIVER_GAVE_UP_KIND)).toHaveLength(1);
    // 放弃那一刻及其后一小会儿：不报（放弃行本身也是"带 kind 的一行"，把计时器拨着）。
    expect(verdict(w, NOW + 60_000).verdict).toBe("recent");
    // 阈值之后：报。这就是"那一格对巡检永远沉默"这个说法【错】的证据。
    const last = driverRows(w, DRIVER_GAVE_UP_KIND)[0] as Row;
    const later = verdict(w, Number(last["created_at"]) + DEFAULT_STALL_THRESHOLD_MS + 60_000);
    expect(later.verdict).toBe("stalled");
    // 时长从【放弃那一行】起算而不是从任务创建起算 —— 也就是"从系统最后一次开口"起算。
    expect(later.silentForMs).toBe(DEFAULT_STALL_THRESHOLD_MS + 60_000);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * I. 两处【手抄】：claude.ts 的 180_000 与关机等待时长
 * ────────────────────────────────────────────────────────────────────────── */
describe("I. 手抄的数字有对照物（漂了会红，而不是靠注释）", () => {
  it("⭐ CLAUDE_TURN_CAP_MS == claude.ts 里那个 SIGKILL 字面量", () => {
    // claude.ts 那一格是内部实现默认值（`i.timeoutMs ?? 180_000`）而没导出常量，
    // 所以这一格【是】一处手抄。挡住它的不是注释而是这一发：去源码文本里数那个字面量。
    // 漂的最坏后果是关机横幅承诺的等待时间比真的短 —— 而那句话存在的唯一理由
    // 就是别让人误判成死锁去 kill -9。
    const src = readFileSync(new URL("../../src/engine/claude.ts", import.meta.url), "utf8");
    const hits = [...src.matchAll(/timeoutMs\s*\?\?\s*([\d_]+)/gu)].map((m) => Number(String(m[1]).replace(/_/gu, "")));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toBe(CLAUDE_TURN_CAP_MS);
  });

  it("最坏等待 = taskLimit × maxTurns × 单格上限，从【配置】算而不是写死", () => {
    // 0044 那一版抄的是"最坏 180 秒"（章程泵的数字），差一个数量级。
    // 一句偏小的等待承诺会让人在第四分钟判定死锁并 kill -9 —— 那句话会变成
    // 它自己要防的那件事的引线。
    expect(worstDriveWaitMs({ taskLimit: 1, maxTurns: 1 })).toBe("3 分钟");
    expect(worstDriveWaitMs({ taskLimit: 3, maxTurns: 12 })).toBe("1 小时 48 分");
    expect(worstDriveWaitMs({ taskLimit: 2, maxTurns: 10 })).toBe("1 小时");
    // ⭐ 默认那一档【逐字】钉住横幅会说的那句。
    // 我第一版在这里写的是 "3 小时 12 分"，而那是我【从注释里抄来的数字】不是算出来的：
    // 3 × 12 × 180 秒 = 6480 秒 = 1 小时 48 分。同一句错话还写在 assemble.ts 两处注释里
    // （已改）。这发断言留着的价值正在这里 —— 它挡的正是"横幅里的等待承诺偏小/偏大"，
    // 而我自己的第一版就是被它抓出来的。
    expect(worstDriveWaitMs({ taskLimit: DEFAULT_DRIVER_TASK_LIMIT, maxTurns: DEFAULT_DRIVER_MAX_TURNS })).toBe(
      "1 小时 48 分",
    );
    // 顺带把"三个乘数真的来自配置"钉住：改任一默认值 ⇒ 这一发红，逼改的人重看横幅那句。
    expect(DEFAULT_DRIVER_TASK_LIMIT * DEFAULT_DRIVER_MAX_TURNS * CLAUDE_TURN_CAP_MS).toBe(6_480_000);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * J. 默认那一支：真子进程 + 真执行日志 + 那三个必填参数【真的到了进程里】
 *
 * 与 charter-pump.test.ts H 组同一条存在理由：注入 driveTask 的那几十发【全部】
 * 绕开了 defaultDriver（makeRuntime + o.bin + 真 recordTurn）。0044 量过那两发变异：
 *   · 把 bin 透传那行删掉 ⇒ 全绿；
 *   · 把默认那一支的 recordTurn 换成 noRecorder ⇒ 全绿。
 * 所以这一组不能省。断言一律断【内容出自桩说的那句话】—— 那样"起的是别人"必红，
 * ⚠ 而起的是别人时这一发会【真发出一次 API 调用】：这句话只有坏掉那天才会被读到，
 * 而那时它正是最该被读到的东西。
 * ────────────────────────────────────────────────────────────────────────── */
const FAKE_CLI = new URL("../engine/fixtures/fake-claude.mjs", import.meta.url).pathname;

/** 桩那一侧的行为开关（claude.ts 是 `env: process.env` 原样透传，所以写在本进程上）。 */
async function withFakeMode<T>(mode: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env["FAKE_CLAUDE_MODE"];
  process.env["FAKE_CLAUDE_MODE"] = mode;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env["FAKE_CLAUDE_MODE"];
    else process.env["FAKE_CLAUDE_MODE"] = prev;
  }
}

describe("J. 默认那一支（真 runtime + 真子进程 + 真执行日志）", () => {
  it("⭐ 真起子进程 ⇒ 状态边真的落库、账记上、执行日志两行、认领行先写", async () => {
    const w = await world({ tasks: [{ id: "t1", status: "DECOMPOSING", role: "manager" }] });
    const agentCwd = TMP + "/agent-cwd-probe";
    mkdirSync(agentCwd, { recursive: true });
    const r = await withFakeMode("cwd", () =>
      drive(w, { real: true, bin: FAKE_CLI, cwd: agentCwd }),
    );
    expect(r.driven[0]?.outcome).toBe("driven");
    // 桩回的是 handoff→tech，而 tech 是 manager 的下级 ⇒ 这条边合法 ⇒ 任务真的往前一格。
    expect(status(w, "t1")).toBe("IN_PROGRESS");
    // ⭐ 这一句是这一发的心脏，也是它不恒绿的全部理由：那串 cwd 只存在于
    // 【那个 .mjs 文件里的 process.cwd()】。审计里读到它 ⇒ 起的一定是它，
    // 而 --agent-cwd 真的透到了 spawn（少传时子进程会继承 Hub 自己的目录 ⇒ 红）。
    //
    // 判的是【抽出来逐字相等】而不是【包含】。第一版写的是 toContain(realpath(agentCwd))
    // + not.toContain(realpath(process.cwd()))，第二半【结构上不可能通过】就红了：
    // 工作目录在 packages/hub/.tmp/ 下面，而它【就在仓库目录里面】，
    // 于是子进程那串路径必然以 Hub 自己的 cwd 为前缀。
    // 换成精确值比较之后两半都成立，而且判得更死：等于【就是那个目录】，
    // 而不是"以某个目录开头"（少传 --agent-cwd 时子进程继承 Hub 的 cwd，
    // 那正是这一发要抓的坏法，而它恰好【过】前缀版那发）。
    const edge = rows(w, "SELECT id, payload FROM events WHERE action = 'state_change' ORDER BY id")[0] as Row;
    const p = JSON.parse(String(edge["payload"])) as Record<string, unknown>;
    const summary = String(p["summary"]);
    const echoed = /cwd=(\S+) budget=(\S+)/u.exec(summary);
    if (echoed === null) throw new Error("summary 里没有桩回显的那一对值：" + summary);
    const echoedCwd = echoed[1] ?? "";
    const echoedBudget = echoed[2] ?? "";
    expect(echoedCwd).toBe(realpathSync(agentCwd));
    expect(echoedCwd).not.toBe(realpathSync(process.cwd()));
    // 那三个必填里【预算】也有回声：桩把收到的 --max-budget-usd 回显进同一句 summary。
    // 少那一个参数时【一切照常跑通】，只是那个上限从此不存在了 —— 只能靠回声判。
    // （桩在参数缺失时写的是 "(缺)"，所以这一发同时挡住"参数名换了写法"。）
    expect(echoedBudget).toBe("0.5");
    // 桩报 0.042 美元 = 4 美分/轮，走真的 usdToCents 与真的 onCost 记账。
    // ⚠ 读回来的是【8】而不是 4：这一格真的跑了【两轮】（manager 交棒给 tech，
    // tech 那一轮自交被拦 ⇒ stalled）。而 8 本身就是"第二次 spawn 真的发生了"的
    // 第二个物证 —— 少起一发是 4。
    const t = w.db.prepare("SELECT consumed_cents FROM tasks WHERE id = 't1'").get() as Row;
    expect(Number(t["consumed_cents"])).toBe(8);
    // ⭐ 执行日志那【两】行是【真 recordTurn】写的（默认那一支的 recordTurn 走 runtime）。
    //
    // ⚠ 两行的 agent_role 【都是 tech】，而不是我以为的"第一行 manager、第二行 tech"。
    // 这是【量出来而第一版写错】的一格：recordTurn 收的是 DispatchResult.role，
    // 而 dispatch 返回的 role 是【落点角色】（plan.role）而不是【这一轮被叫起来干活的
    // 那个角色】—— 于是 manager 那一轮的账记在 tech 名下。
    // 我【没有】改实现：那是 harness_calls 现成的口径，改它要连带改这一列的既有语义
    // 与其它引用面，不该混进本篇。但它【不能只留在注释里】 —— 所以这一发行留着，
    // 让「这一列是谁跑的」这个直觉错误在这里被读到，而不是在一个查账的人身上发生（0048 记账）。
    const hc = rows(
      w,
      "SELECT agent_role, harness, exit_code, cost_cents, args_redacted FROM harness_calls ORDER BY id",
    );
    expect(hc).toHaveLength(2);
    for (const h of hc) {
      expect(String(h["agent_role"])).toBe("tech"); // ← 落点角色，理由见上面那段
      expect(String(h["harness"])).toBe("claude-code");
      expect(Number(h["exit_code"])).toBe(0);
      expect(Number(h["cost_cents"])).toBe(4);
      expect(String(h["args_redacted"])).toContain('"budget_usd":0.5');
    }
    // 认领行【先于】那一轮：id 比状态边小。
    const claimId = Number((driverRows(w, DRIVER_CLAIM_KIND)[0] as Row)["id"]);
    expect(claimId).toBeLessThan(Number(edge["id"]));
  });

  it("⭐ maxTurns=1 真的掐住那一趟（不是写死 12）：stopped=limit + 执行日志【只一行】", async () => {
    // maxTurns 不透到子进程（它是 advance 循环的参数），所以桩那一侧【看不到】它，
    // 不能靠回声判。能读回来的有两样，这一发把两样都读：stopped 那一格是 "limit"，
    // 以及 harness_calls 的【行数】—— 行数是子进程真的只起了 1 次的物证。
    // 只断前者的话，"循环跑了两轮而第二轮没留痕"那种坏法会绿。
    const w = await world({ tasks: [{ id: "t1", status: "DECOMPOSING", role: "manager" }] });
    const r = await withFakeMode("cwd", () => drive(w, { real: true, bin: FAKE_CLI, maxTurns: 1 }));
    expect(r.driven[0]?.stopped).toBe("limit");
    expect(Number(r.driven[0]?.turns)).toBe(1);
    expect(rows(w, "SELECT id FROM harness_calls")).toHaveLength(1);
    // 同一张图、同一个桩、只把 maxTurns 换回默认 ⇒ 两行。
    // 这一对比才是"maxTurns 真的进了那一趟"的证据；单独断 1 行只证明"跑了一轮"。
    const w2 = await world({ tasks: [{ id: "t1", status: "DECOMPOSING", role: "manager" }] });
    await withFakeMode("cwd", () => drive(w2, { real: true, bin: FAKE_CLI }));
    expect(rows(w2, "SELECT id FROM harness_calls")).toHaveLength(2);
  });

  it("真子进程【输出不是 JSON】⇒ 尝试计数【还在涨】（上限的地基）", async () => {
    // 本机最可能的失败正是这一支（CLI 装不上 / 版本不对 ⇒ 输出不可解析），
    // 而它【最危险】：留痕一坏，计数永远 0 ⇒ 上限永远不生效 ⇒
    // 每个心跳重新起一个注定失败的子进程，无限、静默、不产生账单。
    const w = await world();
    const r = await withFakeMode("garbage", () => drive(w, { real: true, bin: FAKE_CLI }));
    expect(r.driven[0]?.outcome).toBe("driven"); // advance 自己把失败轮收成 stalled
    expect(claimCount(w, "t1")).toBe(1);
    // ⭐ 执行日志那一行【在】，而这一发判的就是这个"在"。
    //
    // 我原来给它写的是 exit_code === 1，理由是"那一轮失败了"。量出来是【0】而 0 是对的：
    // recordTurn 收到的 ok 是 `res.seat === "agent"`，判的是【这一格坐的是谁】，
    // 不是【这一轮有没有成功】。于是 harness_calls.exit_code 今天表达的是
    // 「这一发落在 agent 席上」，而 CLI 的退出码被 claude.ts 折进 ok 之后
    // 再没有第二个出口 —— 想按 exit_code 筛失败轮的人会筛不到（失败在事件的 note 里）。
    // 我没改它（同一篇里改两处既有审计语义的账不该混在一起，且 §12.7 第 4 层那一问
    // 「调过没有、花了多少」不受影响），但把这一格记进 0048。
    const hc = rows(w, "SELECT exit_code, cost_cents, args_redacted FROM harness_calls ORDER BY id");
    expect(hc).toHaveLength(1);
    expect(Number(hc[0]?.["exit_code"])).toBe(0);
    // 钱那一半仍然对：桩那一条【没给】total_cost_usd ⇒ 0。而"失败而照样有账单"
    // 那一发在 engine 层（fake-claude 的 nonzero 模式，0.042 美元）已经钉着。
    expect(Number(hc[0]?.["cost_cents"])).toBe(0);
    // 失败那一轮【不留状态边】：库里没有 state_change ⇒ 没有"钱花了而链半截"那种形状。
    expect(rows(w, "SELECT id FROM events WHERE action = 'state_change'")).toHaveLength(0);
    expect(status(w, "t1")).toBe("IN_PROGRESS");
    // note 说的是【读不懂输出】而不是编一个原因（那一条真在桩的原文里）。
    expect(String(r.driven[0]?.note)).toContain("CLI 输出不是预期的 JSON");
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * K. 无事可做那一轮【一分钱都不花】
 * ────────────────────────────────────────────────────────────────────────── */
describe("K. 空库与满库两条早退", () => {
  it("库里没有可驱动的任务 ⇒ 一次都不推，整轮是【零花费】", async () => {
    const w = await world();
    w.db.prepare("UPDATE tasks SET status = 'DELIVERED' WHERE id = 't1'").run();
    const r = await drive(w);
    expect(r).toEqual({ driven: [], costCents: 0, abandoned: [], blocked: [] });
    expect(w.calls).toHaveLength(0);
    expect(driverRows(w, DRIVER_CLAIM_KIND)).toHaveLength(0);
  });

  it("总花费是各条累加，而【blocked 的那些不算进去】（它们一分没花）", async () => {
    const w = await world({
      tasks: [
        { id: "t1", status: "IN_PROGRESS", role: "manager" },
        { id: "t2", status: "IN_PROGRESS", role: "dev" },
      ],
    });
    spend(w, "t2", 500);
    const r = await drive(w, { taskLimitCents: 100, costCents: 7 });
    expect(r.costCents).toBe(7);
    expect(r.driven.map((d) => d.costCents)).toEqual([7]);
    expect(r.blocked.map((b) => b.taskId)).toEqual(["t2"]);
  });
});
