/**
 * 「这条想法停在 agent 那一格，而【已经没有人推它了】」—— 读侧判据（0048 §7 那一站）。
 *
 * ── 这一文件测的是【那一行该不该出现】，不是「响应里有没有那个字段」 ──
 * 这一格的失效不是崩溃而是【措辞】：多报 = 在驱动器刚刚重新推起来的时候写着
 * 「不再推了」（看得见的谎），少报 = 0048 整篇要消灭的那个状态原样留着
 * （界面写着「开发中」而没人推）。两个方向都只能靠【造一条长得像而判据不符的行】
 * 才看得见，所以下面几乎每条都配一个反向对照，而对照成立的前提是
 * 同一发里先钉住【正常那一头确实报】（下面注释里写"分母"的地方就是干这个的）。
 *
 * ── 库是真的（真迁移、真外键、真 json_valid 行为）──────────────────
 * 同 today.test.ts 的立场：`json_extract` 对畸形 payload 的行为不是能推理出来的，
 * 是撞出来的（0014）；而这里读的行正是【驱动器自己写的】，
 * 它的 target 与 payload 形状必须与写侧【逐字对上】—— 对不上就是两份抄件，
 * 所以 D 组那一发用 driverCellTarget() 真写一行再让读侧认它（往返）。
 * 真库还顺手挡了两件我第一版写错的事：budgets.id 是 NOT NULL 主键（漏了它抛），
 * events.task_id 有外键而 PRAGMA foreign_keys = ON（先写事件再写任务抛）。
 * 那两条红是【夹具写错】而不是被测代码写错 —— 区别在于它们响在造数据那一步。
 *
 * ── 造数据用裸 SQL 而不是跑一轮驱动器 ────────────────────────────
 * 跑一轮要 CLI（0039），而链断了时报的是造数据失败而不是判据失败。
 * 但【target 与 payload.kind 这两个形状不许手拼】：那正是本文件要守的东西之一，
 * 手拼会让"读侧与写侧同源"那一发变成自我印证。所以那两处 import 写侧的常量与函数；
 * D 组因此还带一条【故意手拼】的反向用例（分隔符换成 /），
 * 它的作用是证明前面那一发不是靠字符串巧合过的。
 *
 * ── 这个文件【不测】的 ──────────────────────────────────────────────
 *  · 驱动器【什么时候】写那一行（何时放弃、重试几次）—— serve/driver-pump 自己的用例。
 *  · 界面怎么画那一格 —— 本机没有浏览器（0039），判据留在 hub 侧也正是为了它可测。
 *  · 「enabled 而 taskLimitCents 为 null」这台机器不存在（夹具文件头那条），
 *    而读侧那一档判据照样单独问：判据是读侧的，不需要一台不存在的机器当分母。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureTmp } from "../fixtures/fixture-dir.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { migrate } from "../../src/db/migrate.js";
import { InMemoryEventBus } from "../../src/events/bus.js";
import { newLocalToken, signedHeaders } from "../../src/http/auth.js";
import { handleRequest, type HubDeps, type HubRequest } from "../../src/http/app.js";
import { LOOPBACK_HOST } from "../../src/http/bind.js";
import { readDriverStatus, type DriverRuntimeState } from "../../src/overview/driver-status.js";
import {
  DRIVER_CLAIM_KIND,
  DRIVER_ELIGIBLE_STATES,
  DRIVER_GAVE_UP_KIND,
  driverCellTarget,
} from "../../src/serve/driver-pump.js";
import { DRIVER_OFF, DRIVER_ON, DRIVER_PUMP_DEAD } from "../fixtures/driver-state.js";

const TMP = fixtureTmp("overview-driver", import.meta.url);
const queues: WriteQueue[] = [];
let fileSeq = 0;

const T0 = 1_700_000_000_000;
const MIN = 60_000;

type Row = Record<string, unknown>;
/**
 * 夹具用的最小连接面。
 *
 * ⚠ run 的返回型【写死了 lastInsertRowid 的形状】而不是 unknown：
 * 我第一版写 `run: (...) => unknown`（"反正只是造数据"），
 * 于是 raw() 里那句 `Number(r.lastInsertRowid)` 是 tsc 的 TS18046
 * （'r' is a unknown）—— 而它【不拦运行】：node --experimental-transform-types
 * 只剥类型不做检查，所以这一发在测试里全绿而类型上是坏的。
 * 本仓的 tsc 程序只 include src/**（packages/hub/tsconfig.json:8），
 * 测试文件【不在任何 tsc 程序里】—— 也就是说"tsc 34 条与基线一致"这句话
 * 从来不覆盖这个文件。所以它是手工按 tsconfig.base 那一套口子单查过一遍的
 * （命令与结论记在 0049 §8）。
 */
type Db = {
  prepare: (sql: string) => {
    all: (...a: unknown[]) => Row[];
    get: (...a: unknown[]) => Row | undefined;
    run: (...a: unknown[]) => { readonly lastInsertRowid: number | bigint };
  };
};

type World = {
  readonly db: Db;
  readonly deps: HubDeps;
  readonly req: (o: { method: string; path: string }) => HubRequest;
};

/**
 * 一条真库 + 一套真装配。写入用裸 SQL、读取走 deps.db（只读连接）——
 * 与 today.test.ts 同一分工：读侧判据是本题，造数据不是。
 */
function world(): World {
  const path = join(TMP, "driver-" + process.pid + "-" + ++fileSeq + ".db");
  const q = new WriteQueue(path);
  queues.push(q);
  const write = q.writeConnection() as unknown as Db;
  migrate(write as never);
  const read = q.readConnection() as unknown as Db;
  const token = newLocalToken();
  const deps: HubDeps = {
    db: read as never,
    bus: new InMemoryEventBus(),
    token,
    now: () => T0,
    // 这台夹具【开着且在推】：入口那一条要的是"那一发查询真的发出去了"的路径。
    // 选 OFF 的话下面所有 E 组用例会在"形状正常而内容恒空"的早退壳上绿。
    driverState: () => DRIVER_ON,
    recordDecision: async () => true,
    createTask: async () => {},
    resumeGraph: async () => {},
  };
  const req = (o: { method: string; path: string }): HubRequest => ({
    method: o.method,
    path: o.path,
    target: o.path,
    peer: LOOPBACK_HOST,
    headers: signedHeaders(token, { method: o.method, target: o.path, body: "", now: T0 }),
    query: {},
    body: "",
  });
  return { db: write, deps, req };
}

/* ───────────────── 造数据：三个形状各只有一处写法 ───────────────── */

/** 一条任务。默认停在 IN_PROGRESS/dev —— agent 那一格最常见的落点。 */
function task(db: Db, id: string, status = "IN_PROGRESS", role = "dev", at = T0 - 10 * MIN): void {
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at, graph_version, consumed_cents) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)",
  ).run(id, "想法 " + id, status, role, role + "_node", at, at);
}

/**
 * 这一条想法的钱。⚠ id 是 NOT NULL 主键（0001_init.sql:167）而我第一版漏了它；
 * 而 (scope_type, scope_id, period) 上有唯一索引（同一张 0001:175），
 * 所以"再花一分钱"不能靠再 INSERT 一次 —— 那是 spend 的活。
 * 读侧那一发只看 budgets.consumed_cents；tasks.consumed_cents 一起更新是
 * 【照生产的样子】，不是被测的那一格。
 */
function budget(db: Db, taskId: string, limitCents: number, consumedCents: number): void {
  db.prepare(
    "INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, consumed_cents, hard_stop) " +
      "VALUES (?, 'task', ?, 'per_task', ?, ?, 1)",
  ).run("b-" + taskId, taskId, limitCents, consumedCents);
  db.prepare("UPDATE tasks SET consumed_cents = ? WHERE id = ?").run(consumedCents, taskId);
}

/** 只动账面，不动上限（唯一索引那条理由见 budget 上面）。 */
function spend(db: Db, taskId: string, consumedCents: number): void {
  db.prepare("UPDATE budgets SET consumed_cents = ? WHERE scope_type = 'task' AND scope_id = ?").run(
    consumedCents,
    taskId,
  );
  db.prepare("UPDATE tasks SET consumed_cents = ? WHERE id = ?").run(consumedCents, taskId);
}

/**
 * 一行审计。action 用 KIND_TO_ACTION.RoleTurnReported 那个值（"tool_call"）——
 * 与驱动器写认领行/放弃行时用的是【同一个常量映射】。
 * ⚠ task_id 有外键（0001_init.sql:57）且 PRAGMA foreign_keys = ON
 * （pragmas.ts:28），所以调用顺序【必须先 task 后 event】。
 */
function raw(
  db: Db,
  o: {
    readonly taskId: string;
    readonly kind: string;
    readonly target?: string;
    readonly payload?: string;
    readonly at?: number;
  },
): number {
  const r = db
    .prepare(
      "INSERT INTO events (task_id, actor_type, actor_id, action, target, payload, created_at) " +
        "VALUES (?, 'system', 'driver_pump', 'tool_call', ?, ?, ?)",
    )
    .run(o.taskId, o.target ?? "t", o.payload ?? JSON.stringify({ kind: o.kind }), o.at ?? T0);
  return Number(r.lastInsertRowid);
}

/** 一次【进入某一格】的状态边 —— driverCellMarkerSql 找的那个锚点。 */
function entered(db: Db, id: string, to: string, at = T0 - 5 * MIN): number {
  return raw(db, {
    taskId: id,
    kind: "TaskStateChanged",
    payload: JSON.stringify({ kind: "TaskStateChanged", from: "CHARTER_APPROVED", to }),
    at,
  });
}

/**
 * 一行【认领】。target 走【写侧那个函数】（driverCellTarget），
 * 所以它不需要手拼就天然是驱动器会写出来的那个形状。
 * 认领行今天没有读者（0048 §7 那一格只问到顶没到顶），它在这里出现是为了
 * 造出"驱动器试过而没放弃"那一档 —— 见 B 组第二条。
 */
function claim(db: Db, id: string, state: string, role: string, attempt: number, at = T0 - 3 * MIN): number {
  return raw(db, {
    taskId: id,
    kind: DRIVER_CLAIM_KIND,
    target: driverCellTarget(state, role),
    payload: JSON.stringify({ kind: DRIVER_CLAIM_KIND, state, role, attempt, max_attempts: 3 }),
    at,
  });
}

/** 一行【放弃】。同上，target 与 kind 都来自写侧。 */
function gaveUp(
  db: Db,
  id: string,
  state: string,
  role: string,
  o: { readonly attempts?: number; readonly max?: number; readonly at?: number; readonly payload?: string } = {},
): number {
  return raw(db, {
    taskId: id,
    kind: DRIVER_GAVE_UP_KIND,
    target: driverCellTarget(state, role),
    payload:
      o.payload ??
      JSON.stringify({ kind: DRIVER_GAVE_UP_KIND, state, role, attempts: o.attempts ?? 3, max_attempts: o.max ?? 3 }),
    at: o.at ?? T0 - 2 * MIN,
  });
}

const causesOf = (s: ReturnType<typeof readDriverStatus>): Record<string, string> =>
  Object.fromEntries(s.stopped.map((t) => [t.task_id, t.cause]));

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterAll(async () => {
  for (const q of queues) {
    try {
      await q.close();
    } catch {
      /* 已关 */
    }
  }
  // 清理在 afterAll 而不只在 beforeAll（目录名带 pid，下一次运行不会顺手删它）。
  rmSync(TMP, { recursive: true, force: true });
});

/* ═══════════════ A 机器级那三格 ═══════════════ */

describe("A 机器级：驱动器【没开】时必须说出来，而不是画一张空名单", () => {
  it("⭐ 同一份库，OFF 与 ON 给出的【不是一屏】（空名单 ≠ 一切正常）", () => {
    const w = world();
    task(w.db, "a1");
    entered(w.db, "a1", "IN_PROGRESS");
    claim(w.db, "a1", "IN_PROGRESS", "dev", 3);
    gaveUp(w.db, "a1", "IN_PROGRESS", "dev");

    const on = readDriverStatus(w.db as never, DRIVER_ON);
    const off = readDriverStatus(w.db as never, DRIVER_OFF);
    // 这一发是整节的分母：库里【确实有】一条被放弃的任务，
    // 所以 OFF 时报空不是因为没东西，而是因为那一台【不答这一问】。
    expect(on.stopped.map((t) => t.task_id)).toEqual(["a1"]);
    expect(off.stopped).toEqual([]);
    // 两次的【机器级那一格】必须不同 —— 界面靠它决定是画名单还是画那句话。
    expect(off.enabled).toBe(false);
    expect(on.enabled).toBe(true);
  });

  it("⭐ 心跳停了（HTTP 仍在服务）⇒ pumping=false，而【不伪装成没开】", () => {
    const w = world();
    task(w.db, "a2");
    entered(w.db, "a2", "IN_PROGRESS");
    gaveUp(w.db, "a2", "IN_PROGRESS", "dev");
    const s = readDriverStatus(w.db as never, DRIVER_PUMP_DEAD);
    expect(s.enabled).toBe(true); // 它【确实】被开过
    expect(s.pumping).toBe(false); // 而它【现在】不在推
    expect(s.stopped).toEqual([]);
    // enabled 与 pumping 必须是【两个字段】而不是一个：合成一个的话
    // "开过而停了"与"从没开"在界面上同形，而那两件事的下一步完全不同
    // （一个去看 Hub 的日志，一个去开 --driver-pump）。
  });

  it("task_limit_cents 跟着机器走：OFF 时是 null 而【不是 0】", () => {
    const w = world();
    expect(readDriverStatus(w.db as never, DRIVER_OFF).task_limit_cents).toBeNull();
    expect(readDriverStatus(w.db as never, DRIVER_ON).task_limit_cents).toBe(500);
    // 0 与 null 相反：前者是「一分钱都不许花」，后者是「没有上限这个数」。
    expect(readDriverStatus(w.db as never, DRIVER_OFF).task_limit_cents).not.toBe(0);
  });

  it("⭐ 关着时【一条查询都不发】（真分支，而不是注释里声称被尊重的性质）", () => {
    // 测法：拿一个【被读就抛】的连接替身。ON 走查询 ⇒ 抛；OFF / 停了 ⇒ 不抛。
    const boom = {
      prepare(): never {
        throw new Error("这条连接被读了");
      },
    } as never;
    expect(() => readDriverStatus(boom, DRIVER_OFF)).not.toThrow();
    expect(() => readDriverStatus(boom, DRIVER_PUMP_DEAD)).not.toThrow();
    expect(() => readDriverStatus(boom, DRIVER_ON)).toThrow(/被读了/u);
  });

  it("对外形状是 snake_case（注入侧那个 camelCase 名字不许出现在响应里）", () => {
    const w = world();
    const s = readDriverStatus(w.db as never, DRIVER_ON) as unknown as Record<string, unknown>;
    expect(s["task_limit_cents"]).toBe(500);
    expect(s["taskLimitCents"]).toBeUndefined();
    expect(Object.keys(s).sort()).toEqual(["enabled", "pumping", "stopped", "task_limit_cents"]);
  });
});

/* ═══════════════ B 到顶那一档 ═══════════════ */

describe("B 到顶那一档：三个条件缺一个就会【在不该说的时候说】", () => {
  it("常规：进入这一格 + 认领 + 放弃 ⇒ at_limit，数字来自那一行", () => {
    const w = world();
    task(w.db, "b1");
    entered(w.db, "b1", "IN_PROGRESS");
    claim(w.db, "b1", "IN_PROGRESS", "dev", 3);
    gaveUp(w.db, "b1", "IN_PROGRESS", "dev", { attempts: 3, max: 3 });
    const s = readDriverStatus(w.db as never, DRIVER_ON);
    expect(causesOf(s)).toEqual({ b1: "at_limit" });
    expect(s.stopped[0]?.attempts).toBe(3);
    expect(s.stopped[0]?.max_attempts).toBe(3);
    expect(s.stopped[0]?.state).toBe("IN_PROGRESS");
    expect(s.stopped[0]?.role).toBe("dev");
  });

  it("⭐ 只有认领而【没有放弃行】⇒ 不报（还在试的那几轮不该被说成放弃）", () => {
    const w = world();
    task(w.db, "b2");
    entered(w.db, "b2", "IN_PROGRESS");
    claim(w.db, "b2", "IN_PROGRESS", "dev", 1);
    expect(readDriverStatus(w.db as never, DRIVER_ON).stopped).toEqual([]);
    // 分母：同一格补上放弃行就报 ⇒ 上面那句真的是"缺那一行"而不是"这一发根本不通"。
    gaveUp(w.db, "b2", "IN_PROGRESS", "dev");
    expect(causesOf(readDriverStatus(w.db as never, DRIVER_ON))).toEqual({ b2: "at_limit" });
  });

  it("⭐ 打回重访：上一次那行放弃【不算这一次】（driverCellMarkerSql 那一发）", () => {
    // 整组里最值钱的一发。少了 marker，这一条任务会在【刚刚被重新推起来】的时候
    // 仍然写着「不再推了」—— 那比不显示更坏，因为那是一个看得见的谎。
    const w = world();
    task(w.db, "b3");
    entered(w.db, "b3", "IN_PROGRESS", T0 - 60 * MIN);
    claim(w.db, "b3", "IN_PROGRESS", "dev", 3, T0 - 59 * MIN);
    gaveUp(w.db, "b3", "IN_PROGRESS", "dev", { at: T0 - 58 * MIN });
    expect(causesOf(readDriverStatus(w.db as never, DRIVER_ON))).toEqual({ b3: "at_limit" });
    // 打回：离开这一格，再回来（新的锚点，id 更大）。库里那一行放弃记录【一行都没删】
    // —— 语义靠"它落在锚点之前"，不靠任何清理动作。
    entered(w.db, "b3", "REJECTED_DOWNWARD", T0 - 20 * MIN);
    entered(w.db, "b3", "IN_PROGRESS", T0 - 10 * MIN);
    expect(readDriverStatus(w.db as never, DRIVER_ON).stopped).toEqual([]);
    // 分母：重访之后驱动器再来一轮又到顶 ⇒ 立刻重新报。
    gaveUp(w.db, "b3", "IN_PROGRESS", "dev", { at: T0 - MIN });
    expect(causesOf(readDriverStatus(w.db as never, DRIVER_ON))).toEqual({ b3: "at_limit" });
  });

  it("⭐ 换了人：上一手 dev 试到上限，不算到 manager 头上", () => {
    const w = world();
    task(w.db, "b4", "IN_PROGRESS", "manager");
    entered(w.db, "b4", "IN_PROGRESS");
    gaveUp(w.db, "b4", "IN_PROGRESS", "dev");
    expect(readDriverStatus(w.db as never, DRIVER_ON).stopped).toEqual([]);
    // 正向对照：同一格同一时刻写成 manager 就报 ⇒ 挡住的确实是【角色】那一轴。
    gaveUp(w.db, "b4", "IN_PROGRESS", "manager", { at: T0 - MIN });
    expect(causesOf(readDriverStatus(w.db as never, DRIVER_ON))).toEqual({ b4: "at_limit" });
  });

  it("⭐ 换了格子：上一格试到上限，不算到当前格头上", () => {
    // 与上一条是 target 的两根轴（状态 / 角色），各钉各的 —— 合起来才是那句
    // "任务换格子之后旧放弃行【自动】不再算数，不需要任何清理动作"。
    const w = world();
    task(w.db, "b5", "IN_REVIEW", "dev");
    entered(w.db, "b5", "IN_REVIEW");
    gaveUp(w.db, "b5", "IN_PROGRESS", "dev");
    expect(readDriverStatus(w.db as never, DRIVER_ON).stopped).toEqual([]);
    gaveUp(w.db, "b5", "IN_REVIEW", "dev", { at: T0 - MIN });
    expect(causesOf(readDriverStatus(w.db as never, DRIVER_ON))).toEqual({ b5: "at_limit" });
  });

  it("不在候选集合里的状态即使有放弃行也不报（候选集与驱动器同源）", () => {
    const w = world();
    for (const st of ["DELIVERED", "ARCHIVED", "CHARTER_PENDING", "ESCALATED_TO_CEO", "BLOCKED"]) {
      task(w.db, "b6-" + st, st, "dev");
      entered(w.db, "b6-" + st, st);
      gaveUp(w.db, "b6-" + st, st, "dev");
    }
    expect(readDriverStatus(w.db as never, DRIVER_ON).stopped).toEqual([]);
  });

  it("⭐ 派生集合里【每一格】都报（一格一格过，而不是随便挑一格）", () => {
    // 这一发钉的是 STOPPED_SQL 那个 IN 列表的【每一个位子】。
    // 它不是顺手写的：绑参顺序错一次（上限与状态换位的那一版，见 driver-status.ts 那段）
    // 会让 IN 列表变成 (500, 第1格…第N-1格) —— 少的是【最后一格】BUDGET_PAUSED，
    // 而"挑一格当分母"的写法恰好挑得到还活着的那几格，于是【照绿】。
    // 逐格过之后，少任何一格都在这里红，红话直接说出是哪一格。
    const w = world();
    expect(DRIVER_ELIGIBLE_STATES.length).toBeGreaterThan(1); // 只有一格时这一发退化成上面那条
    const expected: Record<string, string> = {};
    for (const st of DRIVER_ELIGIBLE_STATES) {
      const id = "b7-" + st;
      task(w.db, id, st, "dev");
      entered(w.db, id, st);
      gaveUp(w.db, id, st, "dev");
      expected[id] = "at_limit";
    }
    expect(causesOf(readDriverStatus(w.db as never, DRIVER_ON))).toEqual(expected);
  });

  it("⭐ 坏 payload 的那一行被跳过而【不抛】（库里躺着外部改过的行不该炸看板）", () => {
    const w = world();
    task(w.db, "b8");
    entered(w.db, "b8", "IN_PROGRESS");
    gaveUp(w.db, "b8", "IN_PROGRESS", "dev", { payload: "{不是 JSON" });
    expect(() => readDriverStatus(w.db as never, DRIVER_ON)).not.toThrow();
    expect(readDriverStatus(w.db as never, DRIVER_ON).stopped).toEqual([]);
    // 同一条任务再写一行【合法的】⇒ 照常报（坏行没把整发查询带走）。
    gaveUp(w.db, "b8", "IN_PROGRESS", "dev", { at: T0 - MIN });
    expect(causesOf(readDriverStatus(w.db as never, DRIVER_ON))).toEqual({ b8: "at_limit" });
  });

  it("⭐ 同一格【两行】放弃记录：数字与时刻都取自 id 最大那一行", () => {
    // 钉的是 gaveUpSubquery 里那句 ORDER BY <别名>.id DESC LIMIT 1。
    // ⚠ 【两行之间不许插状态边】—— 我第一版在里面插了一次打回重访，
    // 于是旧那一行【已经被 marker 排除】，那一发 ORDER BY 根本没有两个候选，
    // 拆掉它测试照绿（变异实验里量到的，见 0049 §9）。
    // 两行同一格同一 marker 今天【驱动器自己写不出来】（到顶之后候选 SQL 就把它滤掉了），
    // 它与 b8 那条坏 payload 是同一类防线：append-only 的库里躺着【别人写的行】
    // （人工补录、第二个驱动器、外部脚本），读侧不许因此给出自相矛盾的一句话。
    const w = world();
    task(w.db, "b9");
    entered(w.db, "b9", "IN_PROGRESS", T0 - 60 * MIN);
    gaveUp(w.db, "b9", "IN_PROGRESS", "dev", { attempts: 3, max: 3, at: T0 - 40 * MIN });
    gaveUp(w.db, "b9", "IN_PROGRESS", "dev", { attempts: 5, max: 5, at: T0 - 5 * MIN });
    const s = readDriverStatus(w.db as never, DRIVER_ON);
    expect(s.stopped).toHaveLength(1); // 一行任务，而不是"两个属性来自两行"
    expect(s.stopped[0]?.attempts).toBe(5);
    expect(s.stopped[0]?.max_attempts).toBe(5);
    expect(s.stopped[0]?.since_ms).toBe(T0 - 5 * MIN);
  });

  it("⭐ 两行放弃记录而【时刻是倒着的】（时钟回拨过）：按 id 取，不按时间取", () => {
    // 这一发钉的不是【有没有 ORDER BY】（那是上一发 b9 的活，实测拆掉 ORDER BY 红的是 b9
    // 而这一发照绿 —— 我本来给它写的注释是"这一发才真正咬住 ORDER BY"，
    // 那是【没量就写的】，量完是错的，见 0049 §9），钉的是【按哪一列排】：
    // 万一有人把 ORDER BY 写成 created_at DESC（"取最近那次放弃"读起来完全合理），
    // b9 抓不到它（那一发里两个序恰好同向），这一发抓得到。
    // appendAudit 的 created_at 是【调用方给的】（驱动器的 o.nowMs），
    // NTP 回调 / 手动改表 / 跨重启都能让 id 大那一行的时刻反而更小 ——
    // 那一刻按时间取会把「第几次」与「什么时候」来自两行不同的记录拼成一句话，
    // 而界面把它们排成同一件事的两个属性（「第 3/3 次，40 分钟前停的」）。
    // 取 id 而不是取时间这条规矩本身在 driverCellMarkerSql 那边已经立过（同一句理由）。
    const w = world();
    task(w.db, "b12");
    entered(w.db, "b12", "IN_PROGRESS", T0 - 60 * MIN);
    gaveUp(w.db, "b12", "IN_PROGRESS", "dev", { attempts: 3, max: 3, at: T0 - 5 * MIN }); // 先写、时刻新
    gaveUp(w.db, "b12", "IN_PROGRESS", "dev", { attempts: 7, max: 7, at: T0 - 40 * MIN }); // 后写、时刻旧
    const s = readDriverStatus(w.db as never, DRIVER_ON);
    expect(s.stopped).toHaveLength(1);
    expect(s.stopped[0]?.attempts).toBe(7); // id 最大那一行的数字
    expect(s.stopped[0]?.since_ms).toBe(T0 - 40 * MIN); // 同一行的时刻（更早，而对）
    // 反向钉：不许出现「7/7 配 5 分钟前」那种两行拼出来的一句话。
    expect(s.stopped[0]?.since_ms).not.toBe(T0 - 5 * MIN);
  });

  it("since_ms 是【那一行的时刻】而不是任务的 updated_at", () => {
    // 这一格问的是"从什么时候起没人推了"。不推进的那一轮【不写 tasks 行】
    // （driver-pump 文件头那条），所以 updated_at 会停在更早的时刻 —— 用它会把
    // "十分钟之前停的"说成"一个半小时之前停的"，而那正是决定要不要人工看一眼的数。
    const w = world();
    task(w.db, "b10", "IN_PROGRESS", "dev", T0 - 90 * MIN);
    entered(w.db, "b10", "IN_PROGRESS", T0 - 80 * MIN);
    gaveUp(w.db, "b10", "IN_PROGRESS", "dev", { at: T0 - MIN });
    const row = readDriverStatus(w.db as never, DRIVER_ON).stopped[0];
    expect(row?.since_ms).toBe(T0 - MIN);
    expect(row?.since_ms).not.toBe(T0 - 90 * MIN);
  });

  it("payload 里的数字写成字符串（外部改过库）⇒ 出来仍是 number", () => {
    const w = world();
    task(w.db, "b11");
    entered(w.db, "b11", "IN_PROGRESS");
    gaveUp(w.db, "b11", "IN_PROGRESS", "dev", {
      payload: JSON.stringify({ kind: DRIVER_GAVE_UP_KIND, attempts: "4", max_attempts: "4" }),
    });
    const row = readDriverStatus(w.db as never, DRIVER_ON).stopped[0];
    expect(row?.attempts).toBe(4);
    expect(typeof row?.attempts).toBe("number");
    // 界面那句是 attempts + "/" + max_attempts；字符串会拼出 "44" 这种东西，
    // 而 44/44 与 4/4 在"要不要再给它一次机会"上是两个相反的答案。
    expect(`${row?.attempts}/${row?.max_attempts}`).toBe("4/4");
  });
});

/* ═══════════════ C 被钱挡住那一档 ═══════════════ */

describe("C 「被钱挡住」与「试到上限」是两档，下一步动作不同", () => {
  it("花到上限而【没有放弃行】⇒ no_budget，而不是 at_limit", () => {
    const w = world();
    task(w.db, "c1");
    entered(w.db, "c1", "IN_PROGRESS");
    budget(w.db, "c1", 500, 500); // DRIVER_ON 的上限就是 500
    const s = readDriverStatus(w.db as never, DRIVER_ON);
    expect(causesOf(s)).toEqual({ c1: "no_budget" });
    expect(s.stopped[0]?.attempts).toBeNull(); // 那一行不存在 ⇒ 不许编一个数
    expect(s.stopped[0]?.max_attempts).toBeNull();
  });

  it("⭐ 上限还差一分钱 ⇒ 什么都不报（门开着 = 下一心跳会被推）", () => {
    const w = world();
    task(w.db, "c2");
    entered(w.db, "c2", "IN_PROGRESS");
    budget(w.db, "c2", 500, 499);
    expect(readDriverStatus(w.db as never, DRIVER_ON).stopped).toEqual([]);
    // 分母：同一份夹具再花一分钱就报 ⇒ 上面那句是"差一分钱"而不是"这一档没接通"。
    spend(w.db, "c2", 500);
    expect(causesOf(readDriverStatus(w.db as never, DRIVER_ON))).toEqual({ c2: "no_budget" });
  });

  it("⭐ 分母不知道（taskLimitCents=null）⇒ 【不许】报「被钱挡住」", () => {
    // 不是"保守起见别说"的谨慎，是算术：NOT(x < NULL) 是 NULL，
    // 那一列回来的是 null ⇒ 判 `=== 1` 落空。而落空的方向【必须】是不说话。
    const w = world();
    task(w.db, "c3");
    entered(w.db, "c3", "IN_PROGRESS");
    budget(w.db, "c3", 500, 500); // 库里看是超了
    const unknown: DriverRuntimeState = { enabled: true, pumping: true, taskLimitCents: null };
    expect(readDriverStatus(w.db as never, unknown).stopped).toEqual([]);
    // 分母：同一个库同一刻，把上限告诉它就报 ⇒ 上一句真的是"因为不知道"。
    expect(causesOf(readDriverStatus(w.db as never, DRIVER_ON))).toEqual({ c3: "no_budget" });
  });

  it("⭐ 到顶那一档【优先于】钱：两个条件同时成立时说是到顶", () => {
    // 钱那一档的下一步是"追加预算"，到顶那一档的下一步是"看为什么推不动"。
    // 同一条任务上两句都说等于什么都没说；而"推过了而没推动"是比
    // "没让它推"更强的事实 —— 前者追加预算也解决不了。
    const w = world();
    task(w.db, "c4");
    entered(w.db, "c4", "IN_PROGRESS");
    budget(w.db, "c4", 500, 900);
    gaveUp(w.db, "c4", "IN_PROGRESS", "dev");
    expect(causesOf(readDriverStatus(w.db as never, DRIVER_ON))).toEqual({ c4: "at_limit" });
  });
});

/* ═══════════════ D 读写同源 ═══════════════ */

describe("D 与驱动器同源：target 与 kind 必须逐字对上", () => {
  it("⭐ 用写侧的函数造一行 ⇒ 读侧认它；手拼一个「像的」⇒ 不认", () => {
    const w = world();
    task(w.db, "d1", "DECOMPOSING", "manager");
    entered(w.db, "d1", "DECOMPOSING");
    // target 走 driverCellTarget()、kind 走 DRIVER_GAVE_UP_KIND ——
    // 都是【驱动器写那一行时用的同一批东西】。
    gaveUp(w.db, "d1", "DECOMPOSING", "manager");
    // 手拼那一行：分隔符换成 /，形状"看起来一样"。先建任务（外键），再写事件。
    task(w.db, "d2", "DECOMPOSING", "manager");
    raw(w.db, {
      taskId: "d2",
      kind: DRIVER_GAVE_UP_KIND,
      target: "DECOMPOSING/manager",
      payload: JSON.stringify({ kind: DRIVER_GAVE_UP_KIND, attempts: 3, max_attempts: 3 }),
    });
    expect(causesOf(readDriverStatus(w.db as never, DRIVER_ON))).toEqual({ d1: "at_limit" });
    // 这一发的作用是【证明上面那一发不是靠字符串巧合过的】：
    // 换分隔符必须【同时】改到写侧与读侧才对得上（DRIVER_CELL_SEP 两侧共用）。
  });

  it("payload.kind 换成别的值 ⇒ 不认（读的不是「任意一行放弃形状」）", () => {
    const w = world();
    task(w.db, "d3");
    entered(w.db, "d3", "IN_PROGRESS");
    // 同一格里另一个泵写的放弃行（charter-pump 那一族），形状极像而归属不同。
    gaveUp(w.db, "d3", "IN_PROGRESS", "dev", {
      payload: JSON.stringify({ kind: "CharterDraftAbandoned", attempts: 3, max_attempts: 3 }),
    });
    expect(readDriverStatus(w.db as never, DRIVER_ON).stopped).toEqual([]);
    gaveUp(w.db, "d3", "IN_PROGRESS", "dev", { at: T0 - MIN });
    expect(causesOf(readDriverStatus(w.db as never, DRIVER_ON))).toEqual({ d3: "at_limit" });
  });
});

/* ═══════════════ E 入口 ═══════════════ */

describe("E GET /today 的入口", () => {
  it("driver 那一格真的在响应里，且内容取自 deps.driverState()【这一刻】", async () => {
    const w = world();
    task(w.db, "e1");
    entered(w.db, "e1", "IN_PROGRESS");
    gaveUp(w.db, "e1", "IN_PROGRESS", "dev");
    const r = await handleRequest(w.deps, w.req({ method: "GET", path: "/today" }));
    expect(r.status).toBe(200);
    const drv = (r.body as Record<string, unknown>)["driver"] as Record<string, unknown>;
    expect(drv["enabled"]).toBe(true);
    expect((drv["stopped"] as Row[]).map((x) => x["task_id"])).toEqual(["e1"]);
    // 同一份库同一刻，deps 换一台没开的机器 ⇒ 那一格必须跟着变（不是装配时算死的）。
    // 这一发挡的是"把 driverState() 在闭包里调一次存成常量"那种写法 ——
    // 它在测试里全绿而 onFatal 之后开始撒谎（0048 变异实验 M8 同一形状）。
    const off: HubDeps = { ...w.deps, driverState: () => DRIVER_OFF };
    const r2 = await handleRequest(off, w.req({ method: "GET", path: "/today" }));
    const drv2 = (r2.body as Record<string, unknown>)["driver"] as Record<string, unknown>;
    expect(drv2["enabled"]).toBe(false);
    expect(drv2["stopped"]).toEqual([]);
  });

  it("⭐ 多读这一格【不污染】今日视图其余的数", async () => {
    // 加一整块读路径进来，最容易的副作用是把别处的数改掉（多绑一个参数、
    // 多开一次事务、把某条 SQL 的 ORDER BY 顶掉）。这一发钉的是"只有 driver 那一格变了"。
    const w = world();
    task(w.db, "e2");
    const before = (await handleRequest(w.deps, w.req({ method: "GET", path: "/today" })))
      .body as Record<string, unknown>;
    gaveUp(w.db, "e2", "IN_PROGRESS", "dev");
    const after = (await handleRequest(w.deps, w.req({ method: "GET", path: "/today" })))
      .body as Record<string, unknown>;
    // 驱动那一格【该】变（分母：这一发不是"什么都没发生"）。
    expect((after["driver"] as Record<string, unknown>)["stopped"]).not.toEqual(
      (before["driver"] as Record<string, unknown>)["stopped"],
    );
    for (const k of Object.keys(before)) {
      if (k === "driver") continue;
      expect(JSON.stringify(after[k]), "不该变的键变了：" + k).toBe(JSON.stringify(before[k]));
    }
  });
});
