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
import { fixtureTmp } from "../fixtures/fixture-dir.js";
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
  PATROL_SQL,
  PATROL_VERDICTS,
  TERMINAL_STATES,
  WATCHED_STATES,
  judgeTask,
  kindOf,
  patrolTasks,
  recordStalls,
  runPatrol,
  stalledTasks,
  type TaskSignals,
} from "../../src/heartbeat/patrol.js";

const HUB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TMP = fixtureTmp("heartbeat", import.meta.url);

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

describe("⑤ 一趟巡检的开销必须是【索引区间扫】（Task 6.4「心跳不得阻塞写队列」）", () => {
  /**
   * 这一节【不断言毫秒数】。断言「< 100 ms」的基准测试在 CI 上会因一次并发编译而红，
   * 而被红逼出来的一次阈值放宽，正好把要防的那件事永久放掉。
   *
   * 断言的是【形状】：SQL 计划里必须有SEARCH 走 idx_events_task_kind_created，
   * 且不能出现「SCAN e」（全表扫 events）。形状与机器快慢无关，
   * 而它 precisely 抓住回归：有人改 PATROL_SQL 让 kind 谓词不再能被索引覆盖时，
   * 计划当场变 SCAN，而【10 万行以下的耗时看不出来】—— 那正是这类退化
   * 能活到生产的唯一原因。
   *
   * 为什么这条性质值得单独一节：patrol 跑在 Hub 主线程上，而 node:sqlite 是同步 API。
   * 加索引前实测一趟 413 ms（10 万事件 / 50 个活跃任务，9 趟中位；同一份库摘掉索引对照），
   * 期间【写队列、HTTP、SSE 全停】；加了之后 0.28 ms。
   * 索引在 0003_patrol_event_index.sql。它自己的写侧代价【不写在这里】：
   * 那个百分比在复算里被发现【方差比样本数大】（三次运行 +20%/+35%/+43%，梯度里 +6%~+93%），
   * 稳的只有「不为零、几十个百分点」，写法与理由在那份 DDL 文件头。
   */
  const INDEX = "idx_events_task_kind_created";

  it("迁移之后这条索引【在】（少了它下面两条断言无从谈起）", () => {
    const { db } = fresh();
    const names = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toContain(INDEX);
    // 反向对照：既有那两条 0001 的索引必须还在。
    // 「加了一条新索引顺手把旧的删了」也能让上面那条绿，而巡检的第一个子查询
    // 靠的是 idx_events_task —— 删掉它，plan 会变 SCAN 而索引名断言照绿。
    expect(names).toContain("idx_events_task");
    expect(names).toContain("idx_events_action");
  });

  it("计划里 SEARCH 走了那条覆盖索引，且没有 SCAN events", () => {
    const { db } = fresh();
    const plan = (db.prepare("EXPLAIN QUERY PLAN " + PATROL_SQL).all() as { detail: string }[]).map(
      (r) => String(r.detail),
    );
    const text = plan.join("\n");
    expect(text).toContain(INDEX);
    // COVERING 这一词也要核：非覆盖索引会退化成「索引定位 + 逐行回表取 payload」，
    // 那种计划里索引名照样出现，而耗时是覆盖索引的两个数量级。
    expect(text).toContain("COVERING INDEX " + INDEX);
    expect(text.includes("SCAN e")).toBe(false);
    // 反向对照：EXPLAIN 真的会写出这两种词，所以上面两条不是恒真/恒假的空断言。
    // 拿一条【故意不带 kind 谓词】的 SQL 去 EXPLAIN，就该看到 SCAN e。
    const bad = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT t.id, (SELECT max(e.created_at) FROM events e " +
          "WHERE e.task_id = t.id) x FROM tasks t",
      )
      .all() as { detail: string }[];
    expect(bad.map((r) => String(r.detail)).join("\n")).toContain("USING COVERING INDEX idx_events_task");
  });

  it("四个探测里【恰好三个】走那条索引，而第四个走 idx_events_task 不是漏配", () => {
    /**
     * 这条断言的存在理由：0003 文件头原本写着「非部分那份 4 个探测【全部】走它」，
     * 而那次对照一次差了【两个】变量（索引类型 + 列清单里有没有 created_at），
     * 等列清单之下两者覆盖面【相同】。已撤回，见 0019 §1 第 14 条与 §5 第 20 条。
     * 现在这一格不再由任何人【声称】，包括我 —— 它是断言。
     *
     * 不断言毫秒数（理由见本节文件头那段），断的是【逐条 SEARCH 走哪条索引】——
     * 那个数与机器无关，而它正是「索引有没有被用上」这件事的可观察形态。
     */
    const { db } = fresh();
    const probes = (sql: string) =>
      (db.prepare("EXPLAIN QUERY PLAN " + sql).all() as { detail: string }[])
        .map((r) => String(r.detail))
        .filter((d) => /\bSEARCH (e|r|d) USING\b/u.test(d));
    const plan = probes(PATROL_SQL);
    // 前提检查：计划里得有【四个】events 探测。少一个的话下面那个 3/4 比的是
    // 别的东西（比如「SQL 被人改短了」），而那条断言照样可能绿。
    expect(plan).toHaveLength(4);
    expect(plan.filter((d) => d.includes(INDEX))).toHaveLength(3);
    const stray = plan.filter((d) => !d.includes(INDEX));
    expect(stray).toHaveLength(1);
    // 那唯一没配上的是 last_real_event_at 那一发，它退到 idx_events_task。
    expect(stray[0]).toContain("idx_events_task ");

    // 覆盖面不是选型的理由：等列清单之下，部分索引配上【同样三个】。
    // 这一发是那条撤回的直接产物 —— 少了它，「非部分覆盖面更宽」这句话
    // 还可以被重新写出来，而它已经在同一份库上被证伪过一次。
    db.exec("DROP INDEX " + INDEX);
    db.exec(
      "CREATE INDEX " + INDEX + " ON events(task_id, " +
      "CASE WHEN json_valid(payload) THEN json_extract(payload, '$.kind') END, created_at) " +
      "WHERE CASE WHEN json_valid(payload) THEN json_extract(payload, '$.kind') END IS NOT NULL",
    );
    expect(probes(PATROL_SQL)).toEqual(plan);
  });

  it("第四个探测靠 max(created_at) 的索引序【提前收尾】—— 尾部是心跳事件时才退化", () => {
    /**
     * 上面那条只说「它走 idx_events_task」，没说【为什么这不算退化】。
     * 这句解释的分量在这里：它不是「看着应该挺快」，是一组【差一个变量】的对照。
     *
     * 两侧行数、created_at 分布、索引集合、SQL 全部相同，只差【尾部那批的 kind】：
     *   T_real  尾部是真实事件   → 从最新往旧走，第一条就停
     *   T_stall 尾部是心跳事件   → 把尾部那批全扫完才找到真实事件
     * 机制：idx_events_task 是 (task_id, created_at)，max(created_at) 因此天然有序。
     *
     * 为什么这一格值得单独测：它回答了「巡检自己写的事件会不会拖慢巡检」——
     * 会，每轮多扫一轮心跳事件。而去重语义保证那种行最多一个间隔一条
     *（§2 那张双向表），所以它是有界的。以后若有人「顺手」把这一发掰到
     * 0003 那条索引上（等值定位，看起来总是更快），得先来回答这一发。
     */
    const { db } = fresh();
    const N = 500;
    for (const id of ["T_real", "T_stall"]) {
      addTask(db, id, "IN_PROGRESS", T0 - HOUR);
      for (let i = 0; i < N; i++) ev(db, id, "TaskStateChanged", T0 - HOUR + i);
      // 唯一的那个变量：尾部 N 条的 kind。
      const tail = id === "T_stall" ? "HeartbeatStalled" : "TaskStateChanged";
      for (let i = 0; i < N; i++) ev(db, id, tail, T0 + i);
    }
    // 就是 PATROL_SQL 里那一发（第一个子查询），单独拿出来才能归因到它自己身上。
    const stmt = db.prepare(
      "SELECT max(e.created_at) FROM events e WHERE e.task_id = ? AND " +
        kindOf("e") + " IS NOT NULL AND " + kindOf("e") + " <> 'HeartbeatStalled'",
    );
    const median = (xs: number[]): number =>
      [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? Number.NaN;
    const timed = (id: string): number =>
      median(
        Array.from({ length: 7 }, () => {
          const s = performance.now();
          stmt.all(id);
          return performance.now() - s;
        }),
      );
    // 交替测：两侧库里数据不变，交替只是去掉「先测的那侧承担热身」这件事。
    const real: number[] = [];
    const stall: number[] = [];
    for (let k = 0; k < 3; k++) {
      real.push(timed("T_real"));
      stall.push(timed("T_stall"));
    }
    const realMs = Math.min(...real);
    const stallMs = Math.min(...stall);
    process.stdout.write(
      "\n[0003] 第四个探测：尾部是真实事件 " + realMs.toFixed(3) + "ms / 尾部是心跳事件 " +
        stallMs.toFixed(3) + "ms\n",
    );
    // 判据取 3×（本机 500 行那一档实测 20× 量级）：这一发要抓的是【那条索引被删或改名】
    // 之后这一发退化成全任务扫 —— 那时两侧【同量级变慢】而比值塌到 1 附近。
    // 不断言 stallMs 的绝对值：绝对毫秒随库漂（0019 §1 第 10 条那条撤回的教训）。
    expect(stallMs).toBeGreaterThan(realMs * 3);
    // 前提：快的那侧【确实走了索引序】。删掉 idx_events_task 之后它必须变慢到
    // 与慢的那侧同量级 —— 否则上面的比值可能只是「两侧都很快」凑出来的。
    db.exec("DROP INDEX idx_events_task");
    expect(timed("T_real")).toBeGreaterThan(realMs * 3);
  });

  it("kind 为 NULL 的脏行【不算】真实事件（索引下推没把边界吃掉）", () => {
    // 这一发守的是「加了索引之后结果还是对的」。索引带来的最常见错误不是慢，
    // 是【少行】：谓词被下推进索引之后，边界值（kind 为 NULL 的脏行）容易被一起吃掉。
    const { db } = fresh();
    addTask(db, "T-a", "IN_PROGRESS", T0 - HOUR);
    ev(db, "T-a", "TaskStateChanged", T0 - HOUR);
    // 没有 kind 的脏行：它【不该】被当成真实事件（patrol.ts 的 SQL 显式判 IS NOT NULL）
    db.prepare(
      "INSERT INTO events (task_id, actor_type, actor_id, action, payload, state_snapshot, created_at) " +
        "VALUES ('T-a', 'system', 'hub', 'state_change', '{}', '{}', ?)",
    ).run(T0 - 1000);
    const rows = db.prepare(PATROL_SQL).all() as { id: string; last_real_event_at: number | null }[];
    expect(rows.map((r) => r.id)).toEqual(["T-a"]);
    expect(Number(rows[0]?.last_real_event_at)).toBe(T0 - HOUR);
  });
  it("payload 不是合法 JSON 的行【不让整轮巡检抛错】（kindOf 那层守卫）", () => {
    /**
     * 这一发守的失效形状是「一行毫不相干的脏数据 ⇒ 所有任务的停滞检测永久失效」。
     * json_extract 对畸形 payload 是【抛错】而不是返回 NULL（本仓量过两次：0014 §2、
     * policy/auto-approve.ts 的 MALFORMED_PAYLOAD_PROBE_SQL 注释）。
     * 而那种行【写得进】events —— payload 只有 NOT NULL，没有 json_valid 检查，
     * 所以旁路 INSERT（人工修数据、迁移脚本、导入工具）就能留下它。
     * 没有守卫时实测就是 db.prepare(PATROL_SQL).all() 抛 "malformed JSON"，
     * 一行结果都没有，而报错里既没有那行的 id 也没有 task_id。
     */
    const { db } = fresh();
    addTask(db, "T-clean", "IN_PROGRESS", T0 - HOUR);
    ev(db, "T-clean", "TaskStateChanged", T0 - HOUR);
    addTask(db, "T-dirty", "IN_PROGRESS", T0 - HOUR);
    db.prepare(
      "INSERT INTO events (task_id, actor_type, actor_id, action, payload, state_snapshot, created_at) " +
        "VALUES ('T-dirty', 'system', 'hub', 'state_change', ?, '{}', ?)",
    ).run("坏掉的不是JSON", T0 - 60_000);

    const rows = db.prepare(PATROL_SQL).all() as Array<{
      id: string;
      last_real_event_at: number | null;
    }>;
    // 健康任务【照常】出结果：脏行不能把它一起拖倒
    const clean = rows.find((r) => r.id === "T-clean");
    expect(Number(clean?.last_real_event_at)).toBe(T0 - HOUR);
    // 脏行按 kindOf 的语义得 NULL ⇒ 「没有真实事件」，于是它落在 never_started/recent
    // 那一格而不是被当成一次活动。这里断言的是【不是 T-clean 那种时间戳】，
    // 因为「守卫把坏行变成 NULL」与「守卫把坏行变成 0」是两种不同的错。
    const dirty = rows.find((r) => r.id === "T-dirty");
    expect(dirty?.last_real_event_at).toBeNull();

    // 反向对照（DDL 与 kindOf 注释都承诺了这一发）：把守卫拿掉，同样的数据必须抛。
    // 不写这一发的话，上面那些断言在一个【从来没有坏行】的世界里也能过 ——
    // 而这条用例的全部意义就是坏行存在时的情形。
    const unguarded = PATROL_SQL.replace(
      /\(CASE WHEN json_valid\(([a-z])\.payload\) THEN json_extract\(\1\.payload, '\$\.kind'\) END\)/gu,
      "json_extract($1.payload, '$.kind')",
    );
    expect(unguarded).not.toContain("json_valid");
    expect(() => db.prepare(unguarded).all()).toThrow(/malformed JSON/u);
  });

  it("有畸形 payload 行时，那条表达式索引【仍然建得起来】（升级不能因脏行失败）", () => {
    /**
     * 0003 那份 DDL 用 CASE WHEN json_valid(...) 而不直接用 json_extract 的【第一条】理由：
     * 索引要物化整个表达式，老库里有一行坏 payload 时，
     * CREATE INDEX ... json_extract(payload,'$.kind') 会报 "malformed JSON"
     * ⇒ 整个 0003 迁移失败 ⇒ 【升级做不完】。
     * 这一格只能这样测：先在【没有这条索引】的库上写下坏行，再执行 DDL 里那句表达式。
     * 顺序反过来（先有索引）根本写不进坏行，测试就会变成恒真。
     */
    const { db } = fresh();
    db.exec("DROP INDEX idx_events_task_kind_created");
    db.prepare(
      "INSERT INTO events (task_id, actor_type, actor_id, action, payload, state_snapshot, created_at) " +
        "VALUES (NULL, 'system', 'hub', 'state_change', '坏掉的', '{}', 1)",
    ).run();
    // 未守卫版：同一个库上必然失败 —— 这一发证明上面那句 INSERT 真的写下了一行坏数据
    expect(() =>
      db.exec(
        "CREATE INDEX ix_unguarded ON events(task_id, json_extract(payload, '$.kind'), created_at)",
      ),
    ).toThrow(/malformed JSON/u);
    // 守卫版：与 0003 里的表达式逐字一致
    expect(() =>
      db.exec(
        "CREATE INDEX ix_guarded ON events(task_id, CASE WHEN json_valid(payload) " +
          "THEN json_extract(payload, '$.kind') END, created_at)",
      ),
    ).not.toThrow();
    // 而且写语义没变：有索引之后坏 payload 仍然【写得进去】。
    // 这条守的是「一条读侧优化不许悄悄改写路径的契约」（append-only 审计库）。
    expect(() =>
      db
        .prepare(
          "INSERT INTO events (task_id, actor_type, actor_id, action, payload, state_snapshot, created_at) " +
            "VALUES (NULL, 'system', 'hub', 'state_change', '又是坏的', '{}', 2)",
        )
        .run(),
    ).not.toThrow();
  });

  it("DDL 里的索引表达式与 patrol.ts 的 kindOf【逐字同源】（漂移会让索引静默失效）", () => {
    /**
     * 表达式索引匹配的是【字面表达式】。两侧一旦漂移（比如 patrol 侧改成
     * json_valid(payload)=1，或去掉 CASE 换成 IIF），SQLite 只是【不再选这条索引】——
     * 不报错、不变红，生产静默退回 413 ms。上面那条 EXPLAIN 用例能抓到它，
     * 但它抓不到「DDL 被人改写而测试里那条手写 DDL 也跟着改」这种情形，
     * 所以这里直接把 DDL 文本拿来比。
     */
    const ddl = readFileSync(
      join(HUB, "resources", "migrations", "0003_patrol_event_index.sql"),
      "utf8",
    );
    // 与 patrol.ts 里那个【同一个函数】的产物比对，不在测试里重写一遍表达式。
    // 去掉外层那对括号：patrol.ts 拼进 SQL 时需要它们（表达式要和 <> / = 抢优先级），
    // 而 DDL 的索引列列表本身就是括号分界的，写第二对是噪声。
    // 括号之外必须【逐字相同】—— 索引匹配的是字面表达式，差一个空格都可能不被选中。
    const expr = kindOf("e")
      .replace(/e\.payload/gu, "payload")
      .replace(/^\(/u, "")
      .replace(/\)$/u, "");
    expect(expr).toContain("json_valid(payload)");
    const ddlCode = ddl
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join(" ")
      .replace(/\s+/gu, "");
    expect(ddlCode).toContain(expr.replace(/\s+/gu, ""));
    // 反向对照：DDL 的【可执行部分】里，json_extract(payload 只能出现一次，
    // 且永远是紧跟在 CASE WHEN json_valid(payload) THEN 后面的那一处。
    // 少这一发的话，「有人在 CREATE INDEX 里另加了一条未守卫的表达式」看不出来，
    // 而那条索引在脏行库上会让迁移失败（上面那条用例测的正是这个失效）。
    const bare = [...ddlCode.matchAll(/json_extract\(payload/gu)];
    expect(bare).toHaveLength(1);
    expect(ddlCode).toContain("json_valid(payload)THENjson_extract(payload,'$.kind')END");
    // 而注释里【确实】多处写着未守卫的那个写法（那几段在解释为什么不能用它）——
    // 整份文件里的出现次数必须【严格多于】可执行部分那 1 次，否则说明「按行滤注释」
    // 这一步没滤掉任何东西，上面那条「恰好 1 次」是它自己造出来的假象。
    // （0018 §6 第 4 条记过同一族坑：门禁扫到注释 ⇒ 代码是干净而测试是红的。）
    const raw = [...ddl.matchAll(/json_extract\(payload/gu)];
    expect(raw.length).toBeGreaterThan(bare.length);
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
