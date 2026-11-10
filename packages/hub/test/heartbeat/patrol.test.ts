/**
 * Task 6.1　心跳停滞巡检（src/heartbeat/patrol.ts）。
 *
 * ── 这一文件在证什么 ──────────────────────────────────────────────────
 * 计划 Task 6.1 的验收原文：「不允许出现既无事件也无卡片的状态」，
 * 并指定用「遍历所有任务，检查是否有孤儿活跃任务」的巡检测试守。
 * 所以本文件的核心是【三格都要有任务】：
 *   ① 该报的（活跃、沉默、没人等）      → 必须报，并且真的写出事件
 *   ② 不该报的（终态 / 等人 / 刚动过）  → 必须不报，且每格各有一发反向对照
 *   ③ 报过一次的                     → 必须不重复报
 * 只有①的测试会写出一个「什么都不返回就全绿」的实现；只有②的测试会写出一个
 * 「永远返回空」的实现。两半都在，恒真与恒假同时被排掉。
 *
 * ── 为什么夹具用真库真迁移 ──────────────────────────────────────────
 * 判定的三条输入里，两条是【真 schema 的行为】而不是纯逻辑：
 *   · json_extract(payload, '$.kind') —— 内存 sqlite 有没有 JSON1、
 *     载荷形状对不对（recorder 存的是 { ...event }，kind 在里面），只有真库能告。
 *   · 「有没有人在等这张卡」靠 ApprovalRequired / ApprovalDecided 的 target 配对，
 *     那个 target 由 recorder.ts 的 targetOf 决定。手搓表会让配对条件对着
 *     一个不存在的世界成立。
 *
 * ── 时钟全部注入 ───────────────────────────────────────────────────
 * 停滞判定本质是「两个数比大小」。用真 Date.now 就只能靠 sleep 造停滞，
 * 于是测试要么慢、要么靠调阈值自证 —— 后者测的是阈值参数，不是判定。
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/db/driver.js";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { InMemoryEventBus } from "../../src/events/bus.js";
import { appendAudit } from "../../src/events/recorder.js";
import { TASK_STATES } from "../../src/graph/status.js";
import {
  DEFAULT_STALL_THRESHOLD_MS,
  HEARTBEAT_INTERVAL_MS,
  HUMAN_HOLD_STATES,
  PATROL_VERDICTS,
  TERMINAL_STATES,
  WATCHED_STATES,
  judgeTask,
  patrolTasks,
  recordStalls,
  runPatrol,
  stalledTasks,
  type TaskSignals,
} from "../../src/heartbeat/patrol.js";

const HUB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TMP = join(HUB, ".tmp", "heartbeat");

const T0 = Date.parse("2026-11-10T00:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

const opened: { close(): void }[] = [];
let seq = 0;

type Fix = {
  path: string;
  db: ReturnType<typeof openDb>;
  q: WriteQueue;
};

function fresh(): Fix {
  const path = join(TMP, "hb-" + process.pid + "-" + ++seq + ".db");
  const db = openDb(path);
  opened.push(db);
  migrate(db as never);
  return { path, db, q: new WriteQueue(path) };
}

function addTask(
  db: ReturnType<typeof openDb>,
  id: string,
  status: string,
  createdAt: number,
  node = "implement",
): void {
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
      "VALUES (?, ?, ?, 'dev', ?, ?, ?)",
  ).run(id, "心跳夹具 " + id, status, node, createdAt, createdAt);
}

/**
 * 写一条事件。kind 必须进 payload —— patrol 的停滞时钟与卡片配对都靠
 * json_extract(payload, '$.kind')，而 recorder.record 存的就是 { ...e }。
 * 这里直写 appendAudit 而不走 recorder.record：后者要求超步事务作用域（图那侧的事），
 * 巡检也不走那条路，夹具与被测代码必须走【同一条】写路径，否则测的是两个世界。
 */
function ev(
  db: ReturnType<typeof openDb>,
  taskId: string,
  kind: string,
  at: number,
  extra: Record<string, unknown> = {},
): void {
  appendAudit(
    db,
    {
      actorType: "system",
      actorId: "hub",
      taskId,
      action: kind === "HeartbeatStalled" ? "escalation" : "state_change",
      target: (extra["target"] as string | undefined) ?? (extra["node"] as string | undefined) ?? null,
      payload: { kind, taskId, ...extra },
      createdAt: at,
    },
    () => at,
  );
}

function verdictOf(path: string, id: string, now: number, threshold?: number) {
  const db = openDb(path);
  opened.push(db);
  const hit = patrolTasks(db, { now: () => now, ...(threshold === undefined ? {} : { thresholdMs: threshold }) }).find(
    (j) => j.id === id,
  );
  if (hit === undefined) throw new Error("巡检没看到这个任务：" + id);
  return hit;
}

afterAll(async () => {
  for (const o of opened) {
    try {
      o.close();
    } catch {
      /* 已关 */
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});

mkdirSync(TMP, { recursive: true });

describe("① 判定函数本身：六种结论各有一格，且互相是分开的", () => {
  const base: TaskSignals = {
    id: "T",
    status: "IN_PROGRESS",
    currentNode: "implement",
    createdAtMs: T0,
    lastRealEventAtMs: T0,
    lastStallAtMs: null,
    awaitingApproval: false,
  };
  const at = (ms: number) => T0 + ms;

  it("活跃 + 沉默超阈值 + 没人等 = stalled", () => {
    expect(judgeTask(base, at(DEFAULT_STALL_THRESHOLD_MS + 1)).verdict).toBe("stalled");
  });

  it("恰好等于阈值不算停滞（边界是「超过」）", () => {
    expect(judgeTask(base, at(DEFAULT_STALL_THRESHOLD_MS)).verdict).toBe("recent");
  });

  it("终态不报，哪怕沉默了一百年", () => {
    for (const s of TERMINAL_STATES) {
      expect(judgeTask({ ...base, status: s }, at(100 * 365 * 24 * HOUR)).verdict).toBe("terminal");
    }
  });

  it("「球在人那边」的三个状态不报", () => {
    for (const s of HUMAN_HOLD_STATES) {
      expect(judgeTask({ ...base, status: s }, at(100 * HOUR)).verdict).toBe("human_hold");
    }
  });

  it("挂着未决审批卡片的任务【永远】不报 —— 催办是 timeout_at 的活，不是心跳的活", () => {
    const held = { ...base, awaitingApproval: true };
    expect(judgeTask(held, at(HOUR)).verdict).toBe("human_hold");
    // 反向对照：把 awaitingApproval 整个删掉，同一任务必须是 stalled。
    // 少了这一发，「永远免检」与「分支写错位置导致永不生效」看不出差别。
    expect(judgeTask({ ...held, awaitingApproval: false }, at(HOUR)).verdict).toBe("stalled");
    // 挂了一百年也不报：这条是【选了】的口径（见 patrol.ts 里 timeout_at 那段），
    // 不是漏写。真被忘掉一张卡片今天报不出来 —— 代价记在 patrol.ts 注释与 0019。
    expect(judgeTask(held, at(100 * 365 * 24 * HOUR)).verdict).toBe("human_hold");
  });

  it("【从未跑过】的新任务不被当成停滞（null 不能当 0）", () => {
    const born: TaskSignals = { ...base, lastRealEventAtMs: null, createdAtMs: T0 };
    expect(judgeTask(born, at(10 * MIN)).verdict).toBe("never_started");
    // 反向对照：若实现把 null 折成 0，第一行就会是 stalled（1970 年起的沉默）。
    // 这里再把 created_at 也摆老，确认老任务确实会被报 —— 排除「恒不报」。
    expect(judgeTask({ ...born, createdAtMs: at(-10 * HOUR) }, at(0)).verdict).toBe("stalled");
  });

  it("报过一次就不再报（去重），且【新建后从未动过】的那一类也去重", () => {
    const real = T0;
    const flagged: TaskSignals = {
      ...base,
      lastRealEventAtMs: real,
      lastStallAtMs: real + DEFAULT_STALL_THRESHOLD_MS + 1000,
    };
    expect(judgeTask(flagged, at(DEFAULT_STALL_THRESHOLD_MS * 3)).verdict).toBe("already_flagged");

    // 这一发是本轮写实现时【当场抓到】的洞：去重基准若用 lastRealEventAtMs，
    // 「一出生就没动过、已被报过一次」的任务永远匹配不上，每轮都重写一条事件。
    const neverMoved: TaskSignals = {
      ...base,
      lastRealEventAtMs: null,
      createdAtMs: T0,
      lastStallAtMs: T0 + DEFAULT_STALL_THRESHOLD_MS + 5,
    };
    expect(judgeTask(neverMoved, at(DEFAULT_STALL_THRESHOLD_MS * 4)).verdict).toBe("already_flagged");
  });

  it("真实事件一到，上一轮的报告作废（停滞时钟重新起算）", () => {
    const recovered: TaskSignals = {
      ...base,
      lastRealEventAtMs: at(DEFAULT_STALL_THRESHOLD_MS * 3),
      lastStallAtMs: at(MIN),
    };
    expect(judgeTask(recovered, at(DEFAULT_STALL_THRESHOLD_MS * 3 + MIN)).verdict).toBe("recent");
  });

  it("心跳事件【不】把停滞时钟归零 —— 判据读的是 lastStall 与起点，不是 max(两者)", () => {
    // 报过之后仍判 already_flagged 而不是 recent，说明心跳事件没被算进「最后动作」。
    // 若算进去了，这里会先算出 silentFor≈0 走 recent 分支之外的路；
    // 而真正会被这行抓住的是：实现若用 max(real, stall) 当起点，
    // 一张已报过的卡片会退回 recent，CEO 再也看不到「已停滞多久」在涨。
    const j = judgeTask(
      { ...base, lastRealEventAtMs: T0, lastStallAtMs: at(DEFAULT_STALL_THRESHOLD_MS + 1) },
      at(DEFAULT_STALL_THRESHOLD_MS * 5),
    );
    expect(j.verdict).toBe("already_flagged");
    // 时长仍然从【真实事件】起算，不是从心跳事件起算。这一条才是那条病的正面证据。
    expect(j.silentForMs).toBe(DEFAULT_STALL_THRESHOLD_MS * 5);
  });

  it("六种结论都被真观察到（防枚举少一种而测试静默少测）", () => {
    const seen = new Set<string>();
    const probes: TaskSignals[] = [
      base,
      { ...base, status: "ARCHIVED" },
      { ...base, status: "ESCALATED_TO_CEO" },
      { ...base, lastRealEventAtMs: null },
      { ...base, awaitingApproval: true },
      { ...base, lastStallAtMs: T0 + 1 },
    ];
    // 两个时刻各管一半：阈值内（阈值是 30 分钟，10 分钟在里）与远超阈值。
    // 第一版取的是 1 小时与 100 小时 —— 两个【都在】阈值外，于是 recent 与
    // never_started 这两格根本没被观察到，集合少两格。
    for (const p of probes) {
      for (const now of [T0 + 10 * MIN, T0 + 100 * HOUR]) {
        seen.add(judgeTask(p, now).verdict);
      }
    }
    expect([...seen].sort()).toEqual([...PATROL_VERDICTS].sort());
    // 逐格点名。上一行只比【集合】，所以「stalled 这一格其实靠 never_started 的那次
    // 调用凑出来」这类重叠它看不出来；这一格必须能被单独复现。
    expect(judgeTask(base, at(DEFAULT_STALL_THRESHOLD_MS + 1)).verdict).toBe("stalled");
    expect(judgeTask({ ...base, lastRealEventAtMs: null }, at(10 * MIN)).verdict).toBe("never_started");
  });

  it("被盯的活跃状态 = 全部状态 - 终态 - 等人态（从枚举派生，不手写清单）", () => {
    expect(WATCHED_STATES.length + TERMINAL_STATES.length + HUMAN_HOLD_STATES.length).toBe(
      TASK_STATES.length,
    );
    // 反向对照：手写清单少一个状态时，这一格会红。自环不可能被算成活跃。
    expect(WATCHED_STATES).toContain("IN_PROGRESS");
    expect(WATCHED_STATES).not.toContain("ARCHIVED");
    expect(WATCHED_STATES).not.toContain("BUDGET_PAUSED");
  });

  it("默认节奏对得上规格 §7.3（15 分钟一轮，阈值两个间隔）", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(15 * 60_000);
    expect(DEFAULT_STALL_THRESHOLD_MS).toBe(2 * HEARTBEAT_INTERVAL_MS);
  });
});

describe("② 真库巡检：SQL 读出来的信号与判定一致", () => {
  let fix: Fix;
  beforeEach(async () => {
    fix = fresh();
  });

  it("四格任务同时存在时，只有该报的那格被报", () => {
    const { db } = fix;
    addTask(db, "T-stall", "IN_PROGRESS", T0 - 10 * HOUR);
    ev(db, "T-stall", "TaskStateChanged", T0 - 10 * HOUR, { to: "IN_PROGRESS" });
    addTask(db, "T-delivered", "DELIVERED", T0 - 10 * HOUR);
    ev(db, "T-delivered", "TaskStateChanged", T0 - 10 * HOUR, { to: "DELIVERED" });
    addTask(db, "T-fresh", "IN_PROGRESS", T0 - 10 * MIN);
    ev(db, "T-fresh", "TaskStateChanged", T0 - 10 * MIN, { to: "IN_PROGRESS" });
    addTask(db, "T-ceo", "ESCALATED_TO_CEO", T0 - 10 * HOUR);
    ev(db, "T-ceo", "TaskStateChanged", T0 - 10 * HOUR, { to: "ESCALATED_TO_CEO" });

    const js = patrolTasks(db, { now: () => T0 });
    const by = new Map(js.map((j) => [j.id, j.verdict]));
    expect(js).toHaveLength(4);
    expect(by.get("T-stall")).toBe("stalled");
    expect(by.get("T-delivered")).toBe("terminal");
    expect(by.get("T-fresh")).toBe("recent");
    expect(by.get("T-ceo")).toBe("human_hold");
    expect(stalledTasks(js).map((j) => j.id)).toEqual(["T-stall"]);
  });

  it("心跳事件不推进停滞时钟：只有一条 HeartbeatStalled 的老任务仍被去重，而不是变 recent", () => {
    const { db } = fix;
    addTask(db, "T1", "IN_PROGRESS", T0 - 10 * HOUR);
    ev(db, "T1", "TaskStateChanged", T0 - 10 * HOUR, { to: "IN_PROGRESS" });
    // 上一轮巡检报过（时间戳在真实事件之后）
    ev(db, "T1", "HeartbeatStalled", T0 - HOUR, { node: "implement" });
    const j = verdictOf(fix.path, "T1", T0);
    expect(j.verdict).toBe("already_flagged");
    // 关键：时长不是 1 小时（那说明心跳事件被当成了「最后动作」）
    expect(j.silentForMs).toBe(10 * HOUR);
  });

  it("未决审批卡片由事件配对得出：只有 ApprovalRequired 时算「等人」", () => {
    const { db } = fix;
    addTask(db, "T1", "IN_PROGRESS", T0 - 10 * HOUR);
    ev(db, "T1", "TaskStateChanged", T0 - 10 * HOUR, { to: "IN_PROGRESS" });
    ev(db, "T1", "ApprovalRequired", T0 - 5 * HOUR, { target: "INT-7", node: "review" });

    expect(verdictOf(fix.path, "T1", T0).verdict).toBe("human_hold");
    expect(verdictOf(fix.path, "T1", T0).awaitingApproval).toBe(true);
  });

  it("同一 target 上有 ApprovalDecided ⇒ 不再算等人", () => {
    const { db } = fix;
    addTask(db, "T1", "IN_PROGRESS", T0 - 10 * HOUR);
    ev(db, "T1", "TaskStateChanged", T0 - 10 * HOUR, { to: "IN_PROGRESS" });
    ev(db, "T1", "ApprovalRequired", T0 - 5 * HOUR, { target: "INT-7", node: "review" });
    ev(db, "T1", "ApprovalDecided", T0 - 4 * HOUR, { target: "INT-7", node: "review" });

    const j = verdictOf(fix.path, "T1", T0);
    expect(j.awaitingApproval).toBe(false);
    expect(j.verdict).toBe("stalled");
  });

  it("反向对照：载荷里【没有 kind】的事件不会被 json_extract 当成心跳", () => {
    const { db } = fix;
    addTask(db, "T1", "IN_PROGRESS", T0 - 10 * HOUR);
    // 故意写一条 kind 缺失的脏行：它必须被算作【真实事件】（<> 'HeartbeatStalled' 为真需非 NULL）
    appendAudit(
      db,
      { actorType: "system", actorId: "hub", taskId: "T1", action: "state_change", payload: { note: "没有 kind" }, createdAt: T0 - HOUR },
      () => T0 - HOUR,
    );
    const j = verdictOf(fix.path, "T1", T0);
    // 这一发暴露 SQL 的一个真洞：json_extract 对缺 kind 返回 NULL，
    // 而 NULL <> 'x' 在 SQL 里是 NULL（不是 true）⇒ 该行被【悄悄剔除】出停滞时钟。
    // 若实现没兜住，这里会读成「10 小时没动静」= stalled。
    expect(j.lastRealEventAtMs).toBeNull();
    expect(j.verdict).toBe("stalled");
  });

  it("空库：一条判定都不产，也不抛", () => {
    expect(patrolTasks(fix.db, { now: () => T0 })).toEqual([]);
  });
});

describe("③ 记事件：绝不静默，且写进去的就是投影卡片要读的那条", () => {
  let fix: Fix;
  beforeEach(async () => {
    fix = fresh();
  });

  it("停滞被写成一行 events，并广播出去", async () => {
    const { db, q } = fix;
    addTask(db, "T1", "IN_PROGRESS", T0 - 10 * HOUR);
    ev(db, "T1", "TaskStateChanged", T0 - 10 * HOUR, { to: "IN_PROGRESS" });
    const bus = new InMemoryEventBus();
    // 先订再看：总线只在【publish 那一刻】投递给当时的订阅者，
    // 事后 subscribe() 不带游标就是「只收未来」—— 那条 await 会永远挂着。
    // （第一版就是这么写的，整个测试文件挂在 240s 超时上。）
    const sub = bus.subscribe();

    const r = await runPatrol(q.readConnection(), q, bus, { now: () => T0 });
    expect(r.stalled).toBe(1);
    expect(r.recorded).toEqual([{ taskId: "T1", seq: expect.any(Number) }]);

    const rows = db
      .prepare("SELECT action, actor_type, actor_id, target, payload FROM events WHERE action = 'escalation'")
      .all() as Array<{ action: string; actor_type: string; actor_id: string; target: string; payload: string }>;
    expect(rows).toHaveLength(1);
    const row = rows[0] as { actor_type: string; actor_id: string; target: string; payload: string };
    expect(row.actor_type).toBe("system");
    expect(row.actor_id).toBe("heartbeat");
    // target 是节点名：与 recorder.targetOf 对 HeartbeatStalled 的口径一致
    expect(row.target).toBe("implement");
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    expect(payload["kind"]).toBe("HeartbeatStalled");
    expect(payload["taskId"]).toBe("T1");
    expect(payload["silentForMs"]).toBe(10 * HOUR);

    const first = await sub[Symbol.asyncIterator]().next();
    expect(first.value).toMatchObject({ kind: "HeartbeatStalled", taskId: "T1", node: "implement" });
    sub.close();
  });

  it("第二轮巡检【不再】为同一任务写事件（真库跑一遍，不是只测纯函数）", async () => {
    const { db, q } = fix;
    addTask(db, "T1", "IN_PROGRESS", T0 - 10 * HOUR);
    ev(db, "T1", "TaskStateChanged", T0 - 10 * HOUR, { to: "IN_PROGRESS" });
    const bus = new InMemoryEventBus();

    await runPatrol(q.readConnection(), q, bus, { now: () => T0 });
    const after1 = (db.prepare("SELECT count(*) AS c FROM events WHERE action = 'escalation'").get() as { c: number | bigint }).c;
    // now 往前推：阈值依旧超着，而上一轮的心跳事件就在 T0
    await runPatrol(q.readConnection(), q, bus, { now: () => T0 + 100 * HOUR });
    const after2 = (db.prepare("SELECT count(*) AS c FROM events WHERE action = 'escalation'").get() as { c: number | bigint }).c;

    expect(Number(after1)).toBe(1);
    expect(Number(after2)).toBe(1);
  });

  it("任务一有真实动作，下一轮就重新计时（不会永远沉默）", async () => {
    const { db, q } = fix;
    addTask(db, "T1", "IN_PROGRESS", T0 - 10 * HOUR);
    ev(db, "T1", "TaskStateChanged", T0 - 10 * HOUR, { to: "IN_PROGRESS" });
    const bus = new InMemoryEventBus();
    await runPatrol(q.readConnection(), q, bus, { now: () => T0 });

    // 任务动了（用比心跳更晚的时间戳写一条真实事件）
    ev(db, "T1", "TaskStateChanged", T0 + HOUR, { to: "IN_PROGRESS" });
    const r = await runPatrol(q.readConnection(), q, bus, { now: () => T0 + 100 * HOUR });
    expect(r.stalled).toBe(1);
    const c = (db.prepare("SELECT count(*) AS c FROM events WHERE action = 'escalation'").get() as { c: number | bigint }).c;
    expect(Number(c)).toBe(2);
  });

  it("写入失败必须带 taskId 回来，而不是静默少一条", async () => {
    const { db, q } = fix;
    addTask(db, "T1", "IN_PROGRESS", T0 - 10 * HOUR);
    ev(db, "T1", "TaskStateChanged", T0 - 10 * HOUR, { to: "IN_PROGRESS" });
    const js = stalledTasks(patrolTasks(db, { now: () => T0 }));
    expect(js).toHaveLength(1);

    await q.close();
    const bus = new InMemoryEventBus();
    const res = await recordStalls(q, bus, js, () => T0);
    expect(res).toHaveLength(1);
    const one = res[0] as { taskId: string; seq: number | null; error?: string };
    expect(one.taskId).toBe("T1");
    expect(one.seq).toBeNull();
    expect(one.error).toBeTruthy();
  });

  it("巡检【不】改 tasks.status（停滞不是状态跃迁）", async () => {
    const { db, q } = fix;
    addTask(db, "T1", "IN_PROGRESS", T0 - 10 * HOUR);
    ev(db, "T1", "TaskStateChanged", T0 - 10 * HOUR, { to: "IN_PROGRESS" });
    await runPatrol(q.readConnection(), q, new InMemoryEventBus(), { now: () => T0 });
    const row = db.prepare("SELECT status FROM tasks WHERE id = 'T1'").get() as { status: string };
    expect(row.status).toBe("IN_PROGRESS");
  });

  it("巡检【不】往 approvals 插卡片行", async () => {
    const { db, q } = fix;
    addTask(db, "T1", "IN_PROGRESS", T0 - 10 * HOUR);
    ev(db, "T1", "TaskStateChanged", T0 - 10 * HOUR, { to: "IN_PROGRESS" });
    await runPatrol(q.readConnection(), q, new InMemoryEventBus(), { now: () => T0 });
    const c = (db.prepare("SELECT count(*) AS c FROM approvals").get() as { c: number | bigint }).c;
    expect(Number(c)).toBe(0);
  });
});

describe("④ 分层：巡检不该把图运行时拖进来", () => {
  it("patrol.ts 不 import graph/ 与 checkpoint 之外的图相关东西", () => {
    // 读源码而不是「跑一下看会不会炸」：@langchain 在本机装不上，
    // 导入图模块会表现为模块找不到，而那与「分层不对」不是同一件事（0009 §2）。
    const src = codeOnly(readSrc());
    expect(src.includes('from "../graph/status.js"')).toBe(true);
    expect(src.includes('from "../graph/company.js"')).toBe(false);
    expect(src.includes('from "../checkpoint/saver.js"')).toBe(false);
    expect(src.includes("@langchain")).toBe(false);
    // 反向对照，防「剥光注释后整串为空」这种恒真：真 import 至少 5 条
    const imported = [...src.matchAll(/from\s+"([^"]+)"/gu)].map((m) => m[1] ?? "");
    expect(imported.length).toBeGreaterThanOrEqual(5);
    // 而【注释里】确实写着 @langchain —— 这一发钉住「为什么必须先剥注释」。
    // 0018 §6 第 4 条记过一次（backup.ts 头注释里就有 @langchain/*），本轮原地重犯一次。
    expect(readSrc().includes("@langchain")).toBe(true);
  });

  it("模块里没有 setInterval / setTimeout（定时由调用方驱动）", () => {
    const src = codeOnly(readSrc());
    expect(src.includes("setInterval")).toBe(false);
    expect(src.includes("setTimeout")).toBe(false);
    // 反向对照：注释里【有】这个词（那句「故意不 setInterval」），所以不剥注释的写法必红。
    expect(readSrc().includes("setInterval")).toBe(true);
  });
});

function readSrc(): string {
  return readFileSync(join(HUB, "src", "heartbeat", "patrol.ts"), "utf8");
}

/** 剥注释。依赖与定时器的门禁只能看【可执行代码】，否则测的是文笔（0018 §6 第 4 条）。 */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "");
}
