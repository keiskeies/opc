/**
 * 今日视图那几个数（`overview/today.ts` 的判据 + `GET /today` 这个入口）。
 *
 * ── 这一发测的是【数是怎么算出来的】，不是「有没有返回一个 JSON」 ──────
 * 这一页的每个数都是一次【判定】而不是一次排版（判据为什么住在 hub 侧，
 * 见 today.ts 文件头那段）。所以本文件的用例几乎每条都带一个【反向对照】：
 * 造一条【看起来该算进去而按判据不该算】的行。少了对照，条件写宽写窄都全绿
 * —— 而「条件写宽」在这一页的表现是 CEO 看见一个不存在的进度。
 *
 * ── 库是真的（真迁移、真触发器、真 json_valid 行为）─────────────────
 * 同 test/http/real-deps.test.ts 的立场：approvals / events 的约束只有真 schema 才有。
 * 这里还多一条只有真库才给得出的东西：`json_extract` 对畸形 payload 是【抛】还是返回
 * NULL —— 那不是可以推理出来的，是撞出来的（DECISIONS_SQL 旁边那段）。
 *
 * ── 跑得起来靠的是【不 import 那三个包装不上的东西】──────────────────
 * 本文件从 src 到 test 一条 import 链都不碰 @langchain/*（0009 §2 实测装不上）。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureTmp } from "../fixtures/fixture-dir.js";
import { DRIVER_ON } from "../fixtures/driver-state.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { migrate } from "../../src/db/migrate.js";
import { handleRequest, matchRoute, type HubDeps, type HubRequest } from "../../src/http/app.js";
import { readToday, BLOCKED_STATUSES, CEO_DECISION_STATUSES, DEFAULT_WINDOW_MS } from "../../src/overview/today.js";
import { InMemoryEventBus } from "../../src/events/bus.js";
import { newLocalToken, signedHeaders } from "../../src/http/auth.js";
import { LOOPBACK_HOST } from "../../src/http/bind.js";

const TMP = fixtureTmp("overview-today", import.meta.url);
const queues: WriteQueue[] = [];
let fileSeq = 0;

const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const UNAUTHORIZED = 401;
const LAN_PEER = "192.168.1.7";

type Row = Record<string, unknown>;
type Db = {
  prepare: (sql: string) => {
    all: (...a: unknown[]) => Row[];
    get: (...a: unknown[]) => Row | undefined;
    run: (...a: unknown[]) => unknown;
  };
  exec: (sql: string) => void;
};

interface World {
  readonly db: Db;
  readonly deps: HubDeps;
  readonly req: (o: Partial<HubRequest> & { method: string; path: string }) => HubRequest;
  readonly sign: (m: string, t: string, b?: string) => Record<string, string>;
}

/**
 * 一条真库 + 一套真装配。
 *
 * 写入用【裸 SQL】而不是走产品代码：本文件测的是【读侧判据】，
 * 如果造数据也要靠 dispatch 跑一轮（那要 CLI），测试就变成「跑通整条链」的另一种拼写，
 * 而链断了时报的是造数据失败而不是判据失败。造数据的形状由读侧的判据决定，
 * 这一点在每条用例里都写清了它造的是什么。
 */
async function world(): Promise<World> {
  const path = join(TMP, "today-" + process.pid + "-" + ++fileSeq + ".db");
  const q = new WriteQueue(path);
  queues.push(q);
  const write = q.writeConnection() as unknown as Db;
  migrate(write as never);
  const read = q.readConnection() as unknown as Db;
  const token = newLocalToken();
  /**
   * ⚠ `now` 收的是【一个时刻】不是【一个取值函数】。
   * 第一版在这里写了 `now: () => T0`，于是时间戳头变成 `String(函数)`，
   * 服务端算 skew 时读到 NaN ⇒ 判 malformed_timestamp ⇒ 三条走真请求的用例全 401，
   * 而 401 的文案刻意不区分原因（auth.ts 那段「不给免费预言机」），症状是「莫名其妙全红」。
   * 同一个坑 contract.test.ts 文件头记过一次（签名与头不同源那一族）。
   */
  const sign = (m: string, t: string, b = "") => signedHeaders(token, { method: m, target: t, body: b, now: T0 });
  const deps: HubDeps = {
    db: read as never,
    bus: new InMemoryEventBus(),
    token,
    now: () => T0,
    recordDecision: async () => true,
    createTask: async () => {},
    resumeGraph: async () => {},
    // 这台夹具扮演的是哪一台 Hub（HubDeps.driverState 必填的理由在那边）：⭐ 这里选 ON 而【不是】OFF：ON 才让 today() 真的去发那一发驱动查询，于是下面「顶层键名集合」那一发钉的是【查询跑过之后】的形状，而不是「关着时早退返回的那个空壳」。少这一句选择，键名集合可以在驱动器整块没跑的情况下绿。
    driverState: () => DRIVER_ON,
  };
  return {
    db: write,
    deps,
    sign,
    req: (o) => ({
      query: {},
      body: "",
      ...o,
      target: o.path,
      peer: o.peer ?? LOOPBACK_HOST,
      headers: o.headers ?? sign(o.method, o.path, o.body ?? ""),
    }),
  };
}

function task(db: Db, id: string, status: string, at = T0): void {
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at, graph_version) " +
      "VALUES (?, ?, ?, 'intake', 'intake', ?, ?, 1)",
  ).run(id, "任务 " + id, status, at, at);
}

/** 一行审计。payload 收【字符串】，好让用例能塞一条非法 JSON。 */
function audit(
  db: Db,
  o: {
    readonly action: string;
    readonly payload: string;
    readonly actorType?: string;
    readonly taskId?: string;
    readonly at?: number;
    readonly target?: string;
  },
): void {
  db.prepare(
    "INSERT INTO events (task_id, actor_type, actor_id, action, target, payload, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    o.taskId ?? null,
    o.actorType ?? "system",
    o.actorType === "human" ? "ceo" : "hub",
    o.action,
    o.target ?? "t",
    o.payload,
    o.at ?? T0,
  );
}

const stateChange = (to: string): string => JSON.stringify({ kind: "TaskStateChanged", from: "X", to });const card = (): string => JSON.stringify({ kind: "ApprovalRequired", approval_type: "strategic", summary: "s" });

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
  rmSync(TMP, { recursive: true, force: true });
});

/* ═══════════════ ① 判据：完成数 ═══════════════ */

describe("① delivered_in_window：完成这件事只能由【那次跃迁的时刻】回答", () => {
  it("窗口内一次 →DELIVERED ⇒ 1", async () => {
    const w = await world();
    task(w.db, "t1", "DELIVERED");
    audit(w.db, { action: "state_change", payload: stateChange("DELIVERED"), taskId: "t1", at: T0 - HOUR });
    expect(readToday(w.db, { nowMs: T0 }).delivered_in_window).toBe(1);
  });

  it("【窗口外】的完成不算今天的：updated_at 也一样新，而它答的不是这一问", async () => {
    const w = await world();
    // 五十天前交付、昨天被人动了一下别的东西（比如预算列被加了一下）。
    // 按 updated_at 数会得到「今天完成 1 个」—— 这一格存在的全部理由就是这个反例。
    task(w.db, "t1", "DELIVERED", T0 - 50 * 24 * HOUR);
    audit(w.db, { action: "state_change", payload: stateChange("DELIVERED"), taskId: "t1", at: T0 - 50 * 24 * HOUR });
    expect(readToday(w.db, { nowMs: T0 }).delivered_in_window).toBe(0);
  });

  it("同一条任务被退回又交付 ⇒ 【两次跃迁都在窗口内 ⇒ 2】而不是按任务去重成 1？不 —— 按任务去重", async () => {
    const w = await world();
    task(w.db, "t1", "DELIVERED");
    audit(w.db, { action: "state_change", payload: stateChange("DELIVERED"), taskId: "t1", at: T0 - 3 * HOUR });
    audit(w.db, { action: "state_change", payload: stateChange("REJECTED_DOWNWARD"), taskId: "t1", at: T0 - 2 * HOUR });
    audit(w.db, { action: "state_change", payload: stateChange("DELIVERED"), taskId: "t1", at: T0 - 1 * HOUR });
    // 这一格问的是「今天【交付了几件事】」，不是「今天发生了几次交付动作」。
    // COUNT(DISTINCT task_id) 因此是判据本身；写成 COUNT(*) 时这一发红。
    // 反过来一个「只交付过一次」的正常任务在上面两条用例里都看不出区别。
    expect(readToday(w.db, { nowMs: T0 }).delivered_in_window).toBe(1);
  });

  it("payload 里没有 to 的行不算数（而【不是】整个请求 500）", async () => {
    const w = await world();
    // events.task_id 有外键（实跑撞出来的：先插事件后插任务 ⇒ FOREIGN KEY constraint failed）。
    task(w.db, "t0", "IN_PROGRESS");
    task(w.db, "t1", "DELIVERED");
    audit(w.db, { action: "state_change", payload: JSON.stringify({ kind: "TaskStateChanged" }), taskId: "t0", at: T0 - HOUR });
    audit(w.db, { action: "state_change", payload: stateChange("DELIVERED"), taskId: "t1", at: T0 - HOUR });
    expect(readToday(w.db, { nowMs: T0 }).delivered_in_window).toBe(1);
  });

  it("⭐ 【非任务的】state_change 不算交付：org / charter / budget-sync 都用同一个 action 值而 taskId 为 null", async () => {
    const w = await world();
    // 三个真生产者的形状（org/commit.ts 的 org_graph_changed 等）。
    // 今天的挡箭牌是 payload.kind：那三家的 payload 里没有 `to`。
    //
    // ⚠ 这一发的夹具【第一版是废的】，而屏幕上看不出来：我当时让那条组织级行
    //   taskId=null，于是即使把 kind 那道门拆掉，COUNT(DISTINCT task_id) 也照样
    //   因为 NULL 而不计数 ⇒ 断言以【另一个理由】成立 ⇒ 变异跑下去仍然全绿。
    //   两个各自够用的判据叠在一起，测出来的是"至少有一个还在"，不是"我要测的那个在"。
    //   现在这条行【带上一个真任务】：唯一能挡住它的就只剩 kind。
    task(w.db, "t-org", "IN_PROGRESS");
    audit(w.db, {
      action: "state_change",
      payload: JSON.stringify({ kind: "org_graph_changed", to: "DELIVERED", graph_version: 7 }),
      taskId: "t-org",
      at: T0 - HOUR,
    });
    const v = readToday(w.db, { nowMs: T0 });
    expect(v.delivered_in_window).toBe(0);
    // kind 挡在了前面 ⇒ 缺口探测器保持静默（它只在真有东西被丢掉时说话，
    // 每次都念一遍的口径会被忽略 —— 同文件尾那三条 note 的写法）。
    expect(v.notes.join("\n")).not.toContain("不属于任何任务的交付");
  });
});

/* ═══════════════ ②′ 判据：活跃数 + 随响应发出的清单 ═══════════════ */

describe("②′ active_tasks 是【排除式】定义的，而 blocked_statuses 随响应发出", () => {
  it("只有两个终点不算活跃（排除式定义：新增中间态会自动被算进来，这里数得到四个进行中）", async () => {
    const w = await world();
    for (const s of ["DELIVERED", "ARCHIVED"]) task(w.db, "done-" + s, s);
    for (const s of ["CHARTER_PENDING", "IN_PROGRESS", "IN_REVIEW", "ESCALATED_TO_CEO"]) {
      task(w.db, "live-" + s, s);
    }
    expect(readToday(w.db, { nowMs: T0 }).active_tasks).toBe(4);
    // ⚠ 用例名里那句「新增中间态自动被算进来」是【排除式的推论】，不是这一发测到的：
    //   要真测它，得往边表里加一个状态再跑 —— 那是改规格（§7.1 的枚举），不在射程内。
    //   这一发只测到「四个已知进行中态都计入 + 两个终点都不计入」。
  });

  it("已交付【不是】活跃：§16.3 那一格问的是「有多少活正在跑」", async () => {
    const w = await world();
    task(w.db, "t1", "DELIVERED");
    expect(readToday(w.db, { nowMs: T0 }).active_tasks).toBe(0);
    // 反向对照：同一张任务退回一格就变活跃（不是"永远算完"）。
    task(w.db, "t2", "FINAL_REVIEW");
    expect(readToday(w.db, { nowMs: T0 }).active_tasks).toBe(1);
  });

  it("⭐ blocked_statuses 与 blocked_tasks 出自【同一处】：界面无需自己抄清单", async () => {
    const w = await world();
    task(w.db, "b1", "BLOCKED");
    const v = readToday(w.db, { nowMs: T0 });
    expect(v.blocked_statuses).toEqual([...BLOCKED_STATUSES]);
    expect(v.blocked_tasks).toBe(1);
    // 这一发看着像废话（两个值都来自同一个常量），但它钉的是【接口的形状】：
    // 看板页（§16.4「需要我注意」）靠这个数组挑任务。哪一天有人嫌它冗余、
    // 把它从响应里"优化"掉，界面就只能自己写一份字面量清单，
    // 而那份抄件与 hub 侧的漂移【没有任何测试看得见】（变异跑在 hub，看不见 web）。
    // 同 pendingTotal / effective_limit 那条「分母由服务端给」（0013 §5）。
    const body = (await handleRequest(w.deps, w.req({ method: "GET", path: "/today" }))).body as Record<string, unknown>;
    expect(body["blocked_statuses"]).toEqual([...BLOCKED_STATUSES]);
  });

  it("⭐ attention ⊇ blocked，且【多出来的那一档】就是升级到 CEO —— 不是把两个列表拼错方向", async () => {
    const w = await world();
    const v = readToday(w.db, { nowMs: T0 });
    // 子集关系是判据本身：漏掉阻塞态 ⇒ 看板说"不需要你注意"而首页说"它阻塞着"。
    for (const s of v.blocked_statuses) expect(v.attention_statuses, s).toContain(s);
    expect(v.attention_statuses).toContain("ESCALATED_TO_CEO");
    // 反向对照：一个【既不是阻塞也不是升级】的进行中状态不许混进来，
    // 否则「需要我注意」这一列会退化成"所有任务"，那个过滤器就白做了。
    expect(v.attention_statuses).not.toContain("IN_PROGRESS");
    expect(v.attention_statuses.length).toBe(v.blocked_statuses.length + 1);
  });

  it("⭐ 「需要我注意」那一列 与 「标琥珀」是【两个集合】，交集非空而不相等（§19.2 那条硬约束）", async () => {
    const w = await world();
    const v = readToday(w.db, { nowMs: T0 });
    // 这一发钉的是本仓踩过的一次真实误并（0042 §3）：第一版把两个概念做成一个字段，
    // 于是看板上 BUDGET_PAUSED 那张卡被涂琥珀，而规格里它【四处】明写非琥珀：
    //   §6 事件表 BudgetPaused →「非琥珀色卡片 + 日消耗条变红」
    //   §7.4 →「非琥珀色的『预算暂停』卡片（这是运营事件，不是战略决策）」
    //   §21.3 →「预算暂停 → 审批收件箱出现非琥珀色卡片（§7.4）」
    //   附录 D 术语表 →「在收件箱生成非琥珀色卡片」
    // 而它【又确实该进】「需要我注意」那一列 —— §7.4 那三个按钮（追加预算 /
    // 维持暂停 / 终止任务）全是 CEO 按的。⇒ 两个集合不等价，不能派生。
    expect(v.attention_statuses).toContain("BUDGET_PAUSED");
    expect(v.ceo_decision_statuses).not.toContain("BUDGET_PAUSED");
    // 差集恰好是那两个阻塞态（不是"差一堆"，也不是"差零个"）：
    expect(v.attention_statuses.filter((s) => !v.ceo_decision_statuses.includes(s))).toEqual([
      "BUDGET_PAUSED",
      "BLOCKED",
    ]);
    // 交集非空：升级到 CEO 两边都在（少这一发，"两个完全不相干的清单"也能全绿）。
    expect(v.ceo_decision_statuses).toContain("ESCALATED_TO_CEO");
    // 琥珀那一侧今天【只有一档】。这条断言是给人看的护栏：往里加状态就是
    // 在稀释「琥珀出现处就是需要你动手的地方」这句承诺，必须是有意识地加。
    expect(v.ceo_decision_statuses).toEqual([...CEO_DECISION_STATUSES]);
    expect(v.ceo_decision_statuses.length).toBe(1);
    // ⚠ BLOCKED 也不琥珀：§7.3 那个由心跳追问生成的「异常」卡片明写
    //   「标记为『信息性』，非琥珀色决策卡」。
    expect(v.ceo_decision_statuses).not.toContain("BLOCKED");
    // 它【不推自边表】这件事本身也在这一发里：BUDGET_PAUSED 在 §7.1 只有一条出边
    // （→ESCALATED_TO_CEO），按"下一步等谁"推必然推出琥珀 ⇒ 那份清单是【规格断言】
    // 而不是边表定理，所以它只能抄在常量里，而这一发是它唯一的守卫。
    const { legalTransitionsFrom } = await import("../../src/graph/status.js");
    expect(legalTransitionsFrom("BUDGET_PAUSED")).toEqual(["ESCALATED_TO_CEO"]);
    // 过 HTTP 这一层也不能丢字段（同 blocked_statuses 那一条的理由）。
    const body = (await handleRequest(w.deps, w.req({ method: "GET", path: "/today" }))).body as Record<string, unknown>;
    expect(body["ceo_decision_statuses"]).toEqual([...CEO_DECISION_STATUSES]);
  });

  it("⭐ 「运营事件」那一档与 role-memory 那个「非战略」表【不是同一条轴】", async () => {
    const w = await world();
    const { OPERATIONAL_APPROVAL_TYPES } = await import("../../src/approvals/cards.js");
    const { NON_STRATEGIC_APPROVAL_TYPES } = await import("../../src/memory/role-memory.js");
    const v = readToday(w.db, { nowMs: T0 });
    expect(v.operational_approval_types).toEqual([...OPERATIONAL_APPROVAL_TYPES]);
    // 两张表都叫"非战略"，轴却不同：那边问「能不能进 dev 的角色记忆桶」（可见性），
    // 这边问「这张卡现在要不要惊动 CEO」（§19.2 的琥珀）。
    // 数字对不上不是疏漏，而是这条断言存在的意义 —— 复用会静默串色：
    // 哪天有人往 role-memory 那张表里加一格（让 dev 少一段提示词），收件箱颜色跟着变。
    expect(OPERATIONAL_APPROVAL_TYPES.length).not.toBe(NON_STRATEGIC_APPROVAL_TYPES.length);
    // 具体那个反例：charter 在【那边】是"非战略"，而 §7.2 步骤 1 里 CEO 就是要
    // 展开章程卡片点「批准章程」⇒ 在【这边】它必须是决策卡（琥珀）。
    expect(NON_STRATEGIC_APPROVAL_TYPES).toContain("charter");
    expect(OPERATIONAL_APPROVAL_TYPES).not.toContain("charter");
    // 反向：budget_override 两边都在，但这是交集不是同源（上面那条长度断言已经排除了同源）。
    expect(NON_STRATEGIC_APPROVAL_TYPES).toContain("budget_override");
  });

  it("活跃与阻塞【不是互补的】：既非阻塞也非终点的状态大量存在，两个数各说各的", async () => {
    const w = await world();
    task(w.db, "t1", "IN_PROGRESS"); // 活跃、不阻塞
    task(w.db, "b1", "BLOCKED"); // 活跃、且阻塞
    const v = readToday(w.db, { nowMs: T0 });
    // 如果界面把这两个数当成互补（"活跃 - 阻塞 = 健康的"），这里就是那个误读的反例。
    expect(v.active_tasks).toBe(2);
    expect(v.blocked_tasks).toBe(1);
    expect(v.active_tasks - v.blocked_tasks).toBe(1);
  });
});

/* ═══════════════ ② 判据：阻塞数 ═══════════════ */

describe("② blocked_tasks：用【当前状态】而不是窗口内发生", () => {
  it("三个阻塞态各一条 ⇒ 3；一件三天前就卡着的事今天仍然算", async () => {
    const w = await world();
    task(w.db, "b1", "BUDGET_PAUSED", T0 - 72 * HOUR);
    task(w.db, "b2", "BLOCKED", T0 - 72 * HOUR);
    task(w.db, "b3", "BUDGET_PAUSED", T0);
    expect(readToday(w.db, { nowMs: T0 }).blocked_tasks).toBe(3);
  });

  it("【不是】阻塞的状态一个都不算：IN_REVIEW / MEETING_REQUIRED / ESCALATED_TO_CEO 都不是「阻塞」", async () => {
    const w = await world();
    // MEETING_REQUIRED 的出边也是空数组（status.ts 明写「规格未给出路」），
    // 把它并进来等于替【规格】§10.1 决定「辩论会卡住算不算阻塞」—— 那不在射程内。
    // 这一发是 BLOCKED_STATUSES 的【反向对照】：抄宽了在这里红。
    for (const s of ["IN_REVIEW", "MEETING_REQUIRED", "ESCALATED_TO_CEO", "FINAL_REVIEW", "DELIVERED"]) {
      task(w.db, "n-" + s, s);
    }
    expect(readToday(w.db, { nowMs: T0 }).blocked_tasks).toBe(0);
  });

  it("界面那份「阻塞」清单与边表里的死路【不冲突也不越界】", async () => {
    const { BLOCKED, legalTransitionsFrom, TASK_STATES } = await import("../../src/graph/status.js");
    void BLOCKED;
    const deadEnds = TASK_STATES.filter((s) => legalTransitionsFrom(s).length === 0);
    // BLOCKED_STATUSES 里每个状态都必须真实存在（拼错一个枚举值不会编译期响，
    // 只会让那一格永远数到 0 —— 界面于是显示「没有阻塞的事」）。
    for (const s of BLOCKED_STATUSES) expect(TASK_STATES, s).toContain(s);
    // 反向：每一个「agent 走不动而等人」的阻塞态都在清单里。
    for (const s of ["BUDGET_PAUSED", "BLOCKED"]) expect(BLOCKED_STATUSES, s).toContain(s);
    // MEETING_REQUIRED 是【刻意】不在里面的那条（上面那个反例讲的就是它）。
    expect(deadEnds).toContain("MEETING_REQUIRED");
    expect(BLOCKED_STATUSES).not.toContain("MEETING_REQUIRED");
  });
});

/* ═══════════════ ③ 判据：三类决策 ═══════════════ */

describe("③ 决策三格：判据各自挑过，其中一格【不能】靠 payload.kind", () => {
  it("自动通过 / 进入人工 / 人已决定 各自数各自的", async () => {
    const w = await world();
    audit(w.db, {
      action: "approval",
      payload: JSON.stringify({ auto_approved_by: "policy-engine", rule: "read_only" }),
      at: T0 - HOUR,
    });
    audit(w.db, { action: "approval", payload: card(), at: T0 - HOUR });
    audit(w.db, { action: "approval", payload: JSON.stringify({ approvalId: "a1", resume: "approve" }), actorType: "human", at: T0 - HOUR });
    const d = readToday(w.db, { nowMs: T0 }).decisions;
    expect(d.auto_approved_in_window).toBe(1);
    expect(d.to_human_in_window).toBe(1);
    expect(d.human_decided_in_window).toBe(1);
  });

  it("⭐ 决策那条的 payload【没有 kind】—— 按 kind 数会静默得到 0（0041 §10 那一坑）", async () => {
    const w = await world();
    // 真形状：applyDecision 落的是 {approvalId, resume}。这里【故意】不带 kind。
    audit(w.db, { action: "approval", payload: JSON.stringify({ approvalId: "a1", resume: "approve" }), actorType: "human" });
    const raw = w.db.prepare("SELECT payload FROM events").get();
    expect(JSON.parse(String(raw?.["payload"]))["kind"]).toBeUndefined();
    // 判据是 actor_type，所以它数得到 1。写成 json_extract(payload,'$.kind') 的话这里 0。
    expect(readToday(w.db, { nowMs: T0 }).decisions.human_decided_in_window).toBe(1);
  });

  it("「提到了 auto_approved_by 这几个字」的行【不算】自动通过（LIKE 那一族的反例）", async () => {
    const w = await world();
    audit(w.db, { action: "approval", payload: JSON.stringify({ error: "auto_approved_by 这一列不可用" }) });
    expect(readToday(w.db, { nowMs: T0 }).decisions.auto_approved_in_window).toBe(0);
  });

  it("非 approval 的 action 一律不进这三格（人工的一次 review_decision 不算批了张卡）", async () => {
    const w = await world();
    audit(w.db, { action: "review_decision", payload: JSON.stringify({ approvalId: "a1" }), actorType: "human" });
    const d = readToday(w.db, { nowMs: T0 }).decisions;
    expect(d.human_decided_in_window).toBe(0);
    expect(d.to_human_in_window).toBe(0);
  });

  it("⭐ 窗口里有【一条坏 payload】时：照常出数 + 把坏行数说出来，而不是整个首页 500", async () => {
    const w = await world();
    // 两条坏行，各钉【一道不同的】json_valid 门：
    //  · state_change 那条走 DELIVERED_SQL（它根本不进决策那三格的筛选，
    //    但那条 SQL 里的 json_extract 照样会对它求值）；
    //  · approval 那条走 DECISIONS_SQL。
    // 第一版只造了前者，于是我把 DECISIONS_SQL 的 json_valid 拆掉之后【全绿】
    // —— 那一道门当时没被任何输入摸到。SQLite 的 CASE 不保证短路，
    // "坏行不会走到那一支"这个直觉在 SQL 里不成立（实测抛 malformed JSON）。
    audit(w.db, { action: "state_change", payload: "{not json", at: T0 - HOUR });
    audit(w.db, { action: "approval", payload: "not json either", at: T0 - HOUR });
    audit(w.db, { action: "approval", payload: card(), at: T0 - HOUR });
    const v = readToday(w.db, { nowMs: T0 });
    expect(v.decisions.to_human_in_window).toBe(1);
    expect(v.notes.join("\n")).toContain("2 条 events 的 payload 不是合法 JSON");
  });
});

/* ═══════════════ ④ 预算：给有判据的那两半 ═══════════════ */

describe("④ 预算：窗口内消耗是准数，而【按天的上限】这个数在库里不存在", () => {
  it("budget_events 带时刻 ⇒ 窗口内那格是准的；窗口外不计", async () => {
    const w = await world();
    task(w.db, "t1", "IN_PROGRESS");
    db_budget(w.db, "task|t1|per_task", "t1", 5000, 0);
    spend(w.db, 1, "t1", 300, T0 - 2 * HOUR);
    spend(w.db, 2, "t1", 200, T0 - 40 * 24 * HOUR); // 窗口外
    const b = readToday(w.db, { nowMs: T0 }).budget;
    expect(b.consumed_in_window_cents).toBe(300);
    // 累计那格读的是 budgets 表（单调不减），与窗口无关 ⇒ 500。
    // 两个数【本来就该不同】，界面上它们是两句话：「今天花了」与「总共花了」。
    expect(b.consumed_total_cents).toBe(500);
  });

  it("【空库】：三个数都是 0 而不是 null，而且 notes 说清「没设限 ≠ 上限是 0」", async () => {
    const w = await world();
    const v = readToday(w.db, { nowMs: T0 });
    expect(v.budget.consumed_in_window_cents).toBe(0);
    expect(v.budget.consumed_total_cents).toBe(0);
    expect(v.budget.declared_task_limits_cents).toBe(0);
    expect(JSON.stringify(v.budget)).not.toContain("null");
    // SUM 过零行给的是 SQL 的 NULL（本轮真撞过：第一版透传，空库上一片 null）。
    expect(JSON.stringify(v.decisions)).not.toContain("null");
    expect(v.notes.join("\n")).toContain("没设限");
  });

  it("已超限而【警报已哑】的格子数会被说出来（0015 文件头 ② 那一格唯一可见的地方）", async () => {
    const w = await world();
    task(w.db, "t1", "IN_PROGRESS");
    db_budget(w.db, "task|t1|per_task", "t1", 100, 400); // 上限被调到已消费之下
    const v = readToday(w.db, { nowMs: T0 });
    expect(v.budget.silent_over_scopes).toBe(1);
    expect(v.notes.join("\n")).toContain("警报");
  });
});

function db_budget(db: Db, id: string, scopeId: string, limitCents: number, consumed: number): void {
  db.prepare(
    "INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, consumed_cents, hard_stop) " +
      "VALUES (?, 'task', ?, 'per_task', ?, ?, 1)",
  ).run(id, scopeId, limitCents, consumed);
}

/**
 * 一笔真实消费。
 *
 * ⚠ 【必须两张表一起写】，因为生产就是一个事务里干的（budget/tracker.ts：
 * 一行 budget_events + 一句 `UPDATE budgets SET consumed_cents = consumed_cents + ?`）。
 * 只写流水那张的话，本文件第一版就红在这里：`consumed_total_cents` 读的是
 * budgets.consumed_cents，夹具没碰它 ⇒ 永远是 0 ⇒ 「累计」那格看起来是"没花过钱"。
 * 那个症状在真库里对应的是「只有人手工插过 budget_events 而没走 tracker」，
 * 而 tracker 是唯一写侧 —— 所以这里补的是【夹具失真】，不是判据。
 */
function spend(db: Db, sourceEvent: number, taskId: string, cents: number, at: number): void {
  db.prepare(
    "INSERT INTO budget_events (source_event, scope_type, scope_id, period, amount_cents, task_id, created_at) " +
      "VALUES (?, 'task', ?, 'per_task', ?, ?, ?)",
  ).run(sourceEvent, taskId, cents, taskId, at);
  db.prepare("UPDATE budgets SET consumed_cents = consumed_cents + ? WHERE id = ?").run(cents, "task|" + taskId + "|per_task");
}

/* ═══════════════ ⑤ 窗口与端点 ═══════════════ */

describe("⑤ 窗口与 GET /today 这个入口", () => {
  it("window_ms 被【报回来】而不是静默用掉：越界的值钳到上限并如实写出", async () => {
    const w = await world();
    expect(readToday(w.db, { nowMs: T0, windowMs: 1000 }).window_ms).toBe(1000);
    expect(readToday(w.db, { nowMs: T0, windowMs: 999_999_999_999 }).window_ms).toBeLessThanOrEqual(
      90 * DEFAULT_WINDOW_MS,
    );
    // 0 / 负数 / 小数都不能把窗口变成「看不见任何东西」—— 那比报一个错更坏。
    expect(readToday(w.db, { nowMs: T0, windowMs: 0 }).window_ms).toBe(1);
    expect(readToday(w.db, { nowMs: T0, windowMs: -5 }).window_ms).toBe(1);
  });

  it("matchRoute：/today 只有一段字面，POST 打不到，/today/x 是 404", () => {
    expect(matchRoute("GET", "/today")?.kind).toBe("today");
    expect(matchRoute("GET", "/today")?.endpoint).toBe("GET /today");
    expect(matchRoute("POST", "/today")).toBeNull();
    expect(matchRoute("GET", "/today/anything")).toBeNull();
    expect(matchRoute("GET", "/today/")).toBeNull();
    // 既有路由没被它抢走（同 org-route 那发的理由）。
    expect(matchRoute("GET", "/tasks")?.kind).toBe("list_tasks");
    expect(matchRoute("GET", "/tasks/t1")?.kind).toBe("get_task");
  });

  it("真请求走一遍：200、形状齐、notes 一路带到调用方", async () => {
    const w = await world();
    task(w.db, "t1", "BLOCKED");
    const r = await handleRequest(w.deps, w.req({ method: "GET", path: "/today" }));
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect(body["blocked_tasks"]).toBe(1);
    expect(body["as_of_ms"]).toBe(T0);
    // notes 是这个端点唯一容易被「顺手优化」掉的字段（它看着像日志噪音，而它是口径本体）。
    expect(Array.isArray(body["notes"])).toBe(true);
    expect((body["notes"] as string[]).join("\n")).toContain("策略引擎");
    expect(JSON.stringify(body)).not.toContain("NaN");
    // ⭐ 顶层 + budget 的【键名集合】逐字钉住。
    // 为什么不是"每个字段各写一条 expect"：这一发是被变异测试逼出来的 ——
    // 我拿"漏接 operational_approval_types"去试新加的那条断言，结果【全绿】，
    // 因为那一条只走 readToday()（不经 HTTP），而这一发只点了三个字段。
    // 逐个点名的写法永远追不上字段的增长：加第 N+1 个字段的人不会想起来补第 N+1 条。
    // 钉键名集合就不需要人记得 —— 少一个字段、多一个字段、改个名，都在这里红，
    // 而红的时候报的是【具体哪个键】。这是「比较型断言要有分辨力」（0016 §1）
    // 在响应形状上的用法：分辨力不靠覆盖全，靠【分母来自集合本身】。
    expect(Object.keys(body).sort()).toEqual(
      [
        "as_of_ms",
        "window_ms",
        "delivered_in_window",
        "blocked_tasks",
        "active_tasks",
        "blocked_statuses",
        "attention_statuses",
        "ceo_decision_statuses",
        "operational_approval_types",
        "budget",
        "decisions",
        // 0048 §7 那一站：驱动器那一格。加它的时候【这一发当场红】，报的就是这一格 ——
        // 这正是这一发存在的理由：逐个字段点名的写法永远追不上字段的增长，
        // 而"少发一个字段"（或者"多发了一个没人 review 过的字段"）都在这里响。
        "driver",
        "notes",
      ].sort(),
    );
    // ⭐ driver 那一格【不能是 undefined / 空壳】：夹具这台是 DRIVER_ON，
    // 所以这一发同时钉住"读侧真的跑了那一发查询"（关着时 readDriverStatus 早退，
    // 形状上仍然有 driver 这个键而内容恒空 —— 那种退化只有配上 ON 的分母才看得见）。
    const drv = body["driver"] as Record<string, unknown>;
    expect(drv["enabled"]).toBe(true);
    expect(drv["pumping"]).toBe(true);
    // ⚠ 这一格【只写 snake_case 那一个名字】，不写成 `a ?? b` 两头都认。
    // 我第一版就是那么写的（"防命名不确定"），而那是把守卫写成装饰：
    // 两头都认的断言在任何一侧命名变了之后仍然绿，
    // 于是「对外口径破了」这件事恰好没人能看见（口径本身在 today.ts 文件头写着）。
    expect(drv["task_limit_cents"]).toBe(500);
    expect(drv["taskLimitCents"]).toBeUndefined();
    expect(Array.isArray(drv["stopped"])).toBe(true);
    expect(Object.keys(body["budget"] as Record<string, unknown>).sort()).toEqual(
      [
        "consumed_in_window_cents",
        "consumed_total_cents",
        "declared_task_limits_cents",
        "declared_scopes",
        "silent_over_scopes",
      ].sort(),
    );
    expect(Object.keys(body["decisions"] as Record<string, unknown>).sort()).toEqual(
      ["auto_approved_in_window", "to_human_in_window", "human_decided_in_window"].sort(),
    );
  });

  it("?window_ms=abc ⇒ 422 而【不是】悄悄按默认窗口出数", async () => {
    const w = await world();
    const r = await handleRequest(w.deps, w.req({ method: "GET", path: "/today", query: { window_ms: "abc" } }));
    expect(r.status).toBe(422);
    expect(String((r.body as Record<string, unknown>)["error"])).toContain("window_ms");
  });

  it("⭐ 新端点【没有】被顺手加进远程 token 白名单：带票打 /today ⇒ 拒，不带票的同一份签名 ⇒ 200", async () => {
    const w = await world();
    // 【规格】§20.3 授权走出本机的只有「审批」这一件事，读看板不在其中。
    // remoteTokenAuth 的白名单是 `hit.kind !== "decide"` 一句写的 ——
    // 加一条路由时【不会】有任何编译错误或提示逼改动者回来看这里，
    // 而「把白名单从只有 decide 放宽到审批类路由」这个动作（读远程收件箱时很自然）
    // 会把 /today 一起送出去：远程能读到「今天花了多少钱、有几件事在等 CEO」。
    //
    // ⚠ 我第一版在这里写的是「非回环对端 ⇒ 401」，实跑 200 —— 那句话是【错的】：
    //   HMAC 不看 peer（密钥在不在内存里才是判据，来源 IP 不是）。
    //   tokens-route.test.ts:443 早就把这件事记下来了：远程只要持有本机密钥、
    //   【不带票】就能读所有读端点。所以"远程读不到"从来不是 peer 挡的。
    //   这一发因此改测【真判据】：挡住带票远程请求的是 token 白名单那一支，
    //   而不是「HMAC 反正会失败」。分辨两者的办法只有一种 —— 配一份真签名，
    //   让「交回 HMAC」那条歧路真的能走通（同 tokens-route 那两发的写法）。
    const withTicket = await handleRequest(
      w.deps,
      w.req({
        method: "GET",
        path: "/today",
        peer: LAN_PEER,
        headers: { ...w.sign("GET", "/today"), "x-opc-approval-token": "anything" },
      }),
    );
    expect(withTicket.status).toBe(UNAUTHORIZED);
    // 反向对照：同一份签名、同一个 peer，只把票头拿掉 ⇒ 200。
    // 少了这一发，上面那个 401 可能只是「远程签名验不过」，那条判据就变成恒绿装饰。
    const noTicket = await handleRequest(
      w.deps,
      w.req({ method: "GET", path: "/today", peer: LAN_PEER, headers: w.sign("GET", "/today") }),
    );
    expect(noTicket.status).toBe(200);
  });

  it("拼错路径得到的是 404 而【不是】today（路径段字面必须逐字对）", async () => {
    const w = await world();
    const r = await handleRequest(w.deps, w.req({ method: "GET", path: "/todya" }));
    expect(r.status).toBe(404);
  });
});
