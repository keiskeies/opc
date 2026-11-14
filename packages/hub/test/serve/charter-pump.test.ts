/**
 * 常驻 Hub 的章程泵（serve/charter-pump.ts）。
 *
 * ── 这一发测的是【节奏】，不是【起草】────────────────────────────────
 * 起草本身（runTurn → 建卡 → 记账 → 广播）由 test/engine/charter.test.ts 那 17 发钉着。
 * 本文件只判四件事，每一件都是「泵」独有的失效方式：
 *  A. 【有界】：一个反复失败的任务不能永远重试。这是本模块存在的全部风险 ——
 *     一个会 spawn 子进程的重试循环，上限坏了就是无限、静默、花钱。
 *     ⚠ 判据一律是【runTurn 被调了几次】，不是【有没有建出卡】：
 *     「上限之后不再花钱」与「上限之后不再重试」不是同一件事。
 *  B. 【不去碰已经有卡的任务】：唯一索引挡得住第二张卡，挡不住第二次烧钱。
 *     charter.test.ts 也在单发层面测过这条，但候选 SQL 里那道 NOT EXISTS
 *     是本模块自己的判据，坏了只有这里能红。
 *  C. 【放弃留得下痕】：到上限的任务会被候选 SQL 过滤掉，从此【不再出现在
 *     任何一轮的报告里】。不在那一刻留一行，故障就从「每轮都在报」变成
 *     「谁都不知道」，而这中间没有任何东西会响。
 *  D. 【索引还在】：0003 那条是表达式索引，认的是字面写法，漂了是静默失效。
 *
 * ── 注入的是【整包 cardDeps】而不是 runTurn 一格 ─────────────────────
 * 与 charter.test.ts 的区别是有意的：泵的注入点必须让「默认那一支」和
 * 「测试这一支」在【同一个位置】分岔。分开注入三格（runTurn 假、rolePrompt 真）
 * 会造出半真装配 —— 为拿一句岗位书而把真 runtime 建起来，
 * 而那意味着这一发测试随时可能真 spawn。
 *
 * ── 广播从【总线】读，不从回调计数 ─────────────────────────────────
 * 泵拿到的就是一个 EventBus，publish 是它自己闭包出来的（源码里那句
 * `(e, seq) => bus.publishPersisted(e, seq)`）。所以这里断的是【它往我给它的那条总线上
 * 发了什么】—— 注入一个假的 publish 计数等于测一个生产里不存在的通道。
 *
 * 跑法（离线、node v24.14.0）：
 *   PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH \
 *     node --experimental-transform-types --import /tmp/opc-harness/register.mjs \
 *     --test packages/hub/test/serve/charter-pump.test.ts
 */
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fixtureTmp } from "../fixtures/fixture-dir.js";
import { migrate } from "../../src/db/migrate.js";
import { INSERT_DELEGATION_GRAPH_SQL } from "../../src/org/commit.js";
import { InMemoryEventBus, type DomainEvent } from "../../src/events/bus.js";
import { DECISION_MARK } from "../../src/engine/claude.js";
import { CHARTER_CARD_KEY, charterCardDraft } from "../../src/engine/charter.js";
import { insertCard } from "../../src/approvals/cards.js";
import {
  CHARTER_ATTEMPTS_SQL,
  CHARTER_BLOCKED_SQL,
  CHARTER_CANDIDATES_SQL,
  CHARTER_GAVE_UP_KIND,
  DEFAULT_CHARTER_MAX_ATTEMPTS,
  PUMP_ACTOR,
  PUMP_GAVE_UP_TARGET,
  pumpCharterCards,
  underTaskBudgetSql,
  type CharterCardDeps,
  type PumpOptions,
  type PumpRoundResult,
} from "../../src/serve/charter-pump.js";

const TMP = fixtureTmp("serve-charter-pump", import.meta.url);
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

/** 一段「模型正常交出提案」的输出（形状与 charter.test.ts 那份同源）。 */
function draftText(): string {
  return (
    "业务目标：做个 AI 笔记应用\n可量化验收标准：三条\n预算上限：200 美元\n\n" +
    DECISION_MARK +
    "\n" +
    JSON.stringify({ action: "wait", summary: "章程提案已拟好，等 CEO 签署" })
  );
}

interface World {
  db: Db;
  q: Queue;
  bus: InMemoryEventBus;
  /** 第几次起草、为【哪条】任务 —— 「上限生效」只能靠这个数出来。 */
  turns: string[];
  /**
   * 换一条总线的同一份世界（turns 与库【共享】）。
   * 用途见「计数来自审计而不是本轮次数」那一发。
   */
  withBus(bus: InMemoryEventBus): World;
}

function makeWorld(db: Db, q: Queue, bus: InMemoryEventBus, turns: string[]): World {
  return {
    db,
    q,
    bus,
    turns,
    withBus: (b) => makeWorld(db, q, b, turns),
  };
}

/**
 * 任务【直接 SQL 插】而不是走 createTask：这一发要的是「有 N 条停在
 * CHARTER_PENDING 的任务」这个【状态】，而不是「建任务那条路对不对」
 * （后者由 http 那一层管）。走 createTask 会让本文件红的时候说不清是谁坏了。
 */
async function world(o: { readonly tasks?: readonly string[]; readonly status?: string } = {}): Promise<World> {
  const { WriteQueue } = await import("../../src/db/write-queue.js");
  const q = new WriteQueue(TMP + "/p-" + process.pid + "-" + ++fileSeq + ".db") as unknown as Queue;
  queues.push(q);
  const db = q.writeConnection();
  migrate(db as unknown as Parameters<typeof migrate>[0]);
  db.prepare(INSERT_DELEGATION_GRAPH_SQL).run(
    "g1",
    1,
    JSON.stringify({
      nodes: {
        ceo: { role_id: "ceo", can_manage: true, reports_to: null, model_family: "opus" },
        intake: { role_id: "intake", can_manage: true, reports_to: "ceo", model_family: "sonnet" },
      },
      edges: [],
    }),
    NOW,
    "ceo",
    "测试用组织图",
  );
  addTasks(db, o.tasks ?? ["t1"], o.status);
  return makeWorld(db, q, new InMemoryEventBus(), []);
}

function addTasks(db: Db, ids: readonly string[], status: string | undefined, base = 0): void {
  ids.forEach((id, i) => {
    db.prepare(
      "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at, graph_version) " +
        "VALUES (?, ?, ?, 'intake', 'intake', ?, ?, 1)",
    ).run(id, "想法 " + id, status ?? "CHARTER_PENDING", NOW + base + i, NOW + base + i);
  });
}

/**
 * 注入的那一套起草回调。
 *
 * 从 prompt 里认任务：buildCharterDraftPrompt 里那句「CEO 的想法：<title>」
 * 是【生产代码写的】，而我这里给每条任务的 title 就是「想法 <id>」。
 * 之所以这样数：ensureCharterCard 传给 runTurn 的入参【没有 taskId】
 * （CharterOptions 里有，CharterDraftOutcome 里没有），而我不想为了让测试数得出来
 * 去改那个已接两条调用方的形状 —— 测试的脚手架不该改生产签名。
 *
 * `ok:false` 那一支刻意用【零花费】：本机最可能的失败正是这一支
 * （CLI 装不上 ⇒ spawn ENOENT ⇒ 一分钱没花），而它也是【最危险】的那一支 ——
 * 留痕一旦坏掉，重试计数就永远是 0，上限就永远不生效（0043 §10）。
 */
function fakeCardDeps(w: World, o: { readonly ok?: boolean; readonly costCents?: number } = {}): () => CharterCardDeps {
  const ok = o.ok !== false;
  return () => ({
    runTurn: async (i) => {
      w.turns.push(taskIdOfPrompt(i.prompt));
      return {
        ok,
        text: ok ? draftText() : "",
        costCents: o.costCents ?? (ok ? 6 : 0),
        sessionId: null,
        error: ok ? null : "spawn claude ENOENT",
      };
    },
    rolePrompt: (r) => "你是角色 " + r,
  });
}

function taskIdOfPrompt(prompt: string): string {
  const m = /CEO 的想法：想法 (\S+)/u.exec(prompt);
  return m?.[1] ?? "?";
}

/** 跑一趟泵。 */
async function pump(
  w: World,
  o: {
    readonly ok?: boolean;
    readonly costCents?: number;
    /** 那道花钱的门。默认给很大 ⇒ A–H 那 28 发的语义【不被这道门掺和】（I 组才判门）。 */
    readonly taskLimitCents?: number;
  } & Pick<PumpOptions, "maxAttempts" | "taskLimit"> = {},
): Promise<PumpRoundResult> {
  return pumpCharterCards(w.q, w.bus, {
    nowMs: NOW + 1000,
    cardDeps: fakeCardDeps(w, o),
    maxBudgetUsd: 0.5,
    taskLimitCents: o.taskLimitCents ?? 2 ** 40,
    cwd: TMP,
    ...(o.maxAttempts === undefined ? {} : { maxAttempts: o.maxAttempts }),
    ...(o.taskLimit === undefined ? {} : { taskLimit: o.taskLimit }),
  });
}

function rows(w: World, sql: string, ...a: unknown[]): Row[] {
  return w.db.prepare(sql).all(...(a as never[]));
}
function gaveUpRows(w: World): Row[] {
  return rows(
    w,
    "SELECT actor_id, action, target, payload FROM events WHERE payload LIKE ? ORDER BY id",
    "%" + CHARTER_GAVE_UP_KIND + "%",
  );
}
function pendingCards(w: World, taskId: string): number {
  const r = w.db
    .prepare("SELECT COUNT(*) AS c FROM approvals WHERE task_id = ? AND card_key = ? AND status = 'pending'")
    .get(taskId, CHARTER_CARD_KEY) as Row | undefined;
  return Number(r?.["c"] ?? 0);
}
function status(w: World, taskId: string): string {
  return String((w.db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as Row)["status"]);
}
function attempts(w: World, taskId: string): number {
  const r = w.db.prepare(CHARTER_ATTEMPTS_SQL).get(taskId) as Row | undefined;
  return Number(r?.["n"] ?? 0);
}
/**
 * 候选 SQL 的第四个参数是那道【花钱的门】。
 *
 * ⚠ 默认给一个大的（2**40）而不是跟着 pump() 那份 1000：这个 helper 的既有 12 处调用
 * 判的是【候选的形状】（去重、排序、上限），不是门 —— 跟着 1000 会让那些用例
 * 在"任务花过钱"之后语义改变，而那种改变与它们想判的事无关。
 * 判门的用例【显式】传一个小的（I 组），因为那一发的靶心就是门。
 */
function candidates(
  w: World,
  maxAttempts = DEFAULT_CHARTER_MAX_ATTEMPTS,
  limit = 3,
  taskLimitCents = 2 ** 40,
): string[] {
  return (
    w.db
      .prepare(CHARTER_CANDIDATES_SQL)
      .all(CHARTER_CARD_KEY, maxAttempts, taskLimitCents, limit) as Row[]
  ).map((x) => String(x["id"]));
}

/** 被门挡住的那一批（与候选那条共用谓词，见 CHARTER_BLOCKED_SQL 那格）。 */
function blockedRows(w: World, taskLimitCents: number, maxAttempts = DEFAULT_CHARTER_MAX_ATTEMPTS): Row[] {
  return w.db.prepare(CHARTER_BLOCKED_SQL).all(CHARTER_CARD_KEY, maxAttempts, taskLimitCents) as Row[];
}

/**
 * 把一条任务写成"已经花掉 cents 美分"。
 *
 * 写 budgets 而【不是】tasks.consumed_cents —— 门读的是前者，而仓库里有【两个】花费列
 * （见 underTaskBudgetSql 那格）。「到底读哪一列」由下面 I 组那一发专门的对照判，
 * 所以这里不再靠注释说明。写法则跟 addTasks 一样直接走写连接（同一个夹具、同一种同步写）。
 */
function spend(w: World, taskId: string, cents: number): void {
  w.db
    .prepare(
      "INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, consumed_cents, hard_stop) " +
        "VALUES (?, 'task', ?, 'per_task', ?, ?, 1) " +
        "ON CONFLICT(scope_type, scope_id, period) DO UPDATE SET consumed_cents = excluded.consumed_cents",
    )
    .run("task|" + taskId + "|per_task", taskId, cents, cents);
}

/**
 * 真建一张章程卡（不用手写 INSERT：夹具绕开契约校验，就等于绕开 §8.2 第 4 条那道检查，
 * 而 charter.test.ts 那条「两边形状要一致」的判据也就没有对照物了）。
 * async：走的是写队列，不 await 的话调用方下一次读可能还没落库。
 */
async function addCharterCard(w: World, taskId: string): Promise<void> {
  await w.q.node(() =>
    insertCard(
      w.db as never,
      charterCardDraft({
        taskId,
        summary: "已有的一张卡",
        draftText: "业务目标：已存在",
        evidenceRef: "events:1#state_snapshot.draft",
        ceoRoleId: "ceo",
      }),
      { nowMs: NOW },
    ),
  );
}

describe("A. 有界：一个反复失败的任务不能永远重试", () => {
  /**
   * ⭐ 这一发是本文件存在的理由。断的不是「第 4 轮没建卡」（那可能只是恰好没数据），
   * 而是【第 4 轮连一次 runTurn 都没调】—— 那一次真金白银的 spawn 被挡住了。
   */
  it("连续失败到上限 ⇒ 下一轮【一次都不再起草】", async () => {
    const w = await world({});
    await pump(w, { ok: false, maxAttempts: 3 });
    await pump(w, { ok: false, maxAttempts: 3 });
    expect(w.turns).toEqual(["t1", "t1"]);
    expect(attempts(w, "t1")).toBe(2);

    // 第三次用完上限
    await pump(w, { ok: false, maxAttempts: 3 });
    expect(w.turns).toHaveLength(3);
    expect(attempts(w, "t1")).toBe(3);

    // 第四次：候选 SQL 就该把它滤掉
    const r4 = await pump(w, { ok: false, maxAttempts: 3 });
    expect(w.turns).toHaveLength(3);
    expect(r4.cards.filter((c) => c.outcome === "drafted" || c.outcome === "attempted")).toHaveLength(0);
    expect(r4.costCents).toBe(0);
  });

  it("⭐ 计数来自【审计】而不是本轮次数 —— 换一条总线（≈ Hub 重启）也不清零", async () => {
    // 这一发防的实现是【用模块内的变量数轮次】：那种实现单测能过，
    // 而 Hub 重启一次就前功尽弃（而 Hub 天天重启）。
    const w = await world({});
    for (let i = 0; i < 3; i++) await pump(w, { ok: false, maxAttempts: 3 });
    expect(w.turns).toHaveLength(3);

    const w2 = w.withBus(new InMemoryEventBus());
    const r = await pump(w2, { ok: false, maxAttempts: 3 });
    expect(w2.turns).toHaveLength(3); // 一次都没多
    expect(r.cards.filter((c) => c.outcome === "attempted")).toHaveLength(0);
  });

  it("maxAttempts / taskLimit 不是 >= 1 的整数 ⇒ 在任何读写之前抛", async () => {
    const w = await world({});
    await expect(pump(w, { maxAttempts: 0 })).rejects.toThrow(/整数/u);
    await expect(pump(w, { taskLimit: 0 })).rejects.toThrow(/整数/u);
    // 抛之前什么都没发生：一个 token 都没烧，一行审计都没写
    expect(w.turns).toHaveLength(0);
    expect(rows(w, "SELECT 1 AS x FROM events")).toHaveLength(0);
  });

  it("⭐ 候选 SQL 里那句 attempts < 上限 是承重的：少了它本轮就多花一次钱", async () => {
    // maxAttempts=1 ⇒ 第一轮用完，第二轮必须一次子进程都不起。
    // 这一发与 A 组第一发的分别是【两处】上限判据：SQL 里那一处挡【本轮的 spawn】，
    // 而「判放弃」那一处只挡下一轮 —— 删掉前者，测试会红在 spawn 次数上。
    const w = await world({});
    await pump(w, { ok: false, maxAttempts: 1 });
    expect(w.turns).toHaveLength(1);
    await pump(w, { ok: false, maxAttempts: 1 });
    expect(w.turns).toHaveLength(1);
  });
});

describe("B. 不去碰已经有卡的任务", () => {
  it("成功起草之后再来一轮 ⇒ 一次都不起草，卡片仍是一张", async () => {
    const w = await world({});
    const r1 = await pump(w);
    expect(r1.cards.map((c) => c.outcome)).toEqual(["drafted"]);
    expect(pendingCards(w, "t1")).toBe(1);
    const r2 = await pump(w);
    expect(r2.cards).toHaveLength(0);
    expect(w.turns).toHaveLength(1);
    expect(pendingCards(w, "t1")).toBe(1);
  });

  it("一张卡被批掉【而任务推进了】⇒ 泵不再管它", async () => {
    const w = await world({});
    await pump(w);
    // 手工模拟推进（决策写路径由 decision-engine-route.test.ts 管，这里不重测）
    w.db.prepare("UPDATE approvals SET status = 'approved' WHERE task_id = 't1'").run();
    w.db.prepare("UPDATE tasks SET status = 'CHARTER_APPROVED' WHERE id = 't1'").run();
    const r = await pump(w);
    expect(r.cards).toHaveLength(0);
    expect(w.turns).toHaveLength(1);
  });

  it("⭐ 卡被批掉而任务【没推进】⇒ 泵【不再起草】：唯一索引不放行第二行", async () => {
    // 这一发写的期望与初版【相反】，而相反的那一版才是对的 —— 记下来防它被改回去：
    // idx_approvals_card_identity 是 (task_id, card_key) 上的唯一索引，【不带 status 条件】
    // （0004），所以一个任务在 charter:proposal 这个 key 上【一辈子只能有一行】。
    // 初版按 status='pending' 筛候选，于是这种任务会进候选 ⇒ 那道前置检查也只查
    // pending ⇒ 起子进程、烧一轮 token ⇒ insertCard 撞索引 ⇒ already_pending。
    // 【烧掉的钱换回一句"已经有了"】。判据必须与 DDL 的约束同一个形状。
    const w = await world({});
    await pump(w);
    w.db.prepare("UPDATE approvals SET status = 'approved' WHERE task_id = 't1'").run();
    const r = await pump(w);
    expect(r.cards).toHaveLength(0);
    expect(w.turns).toHaveLength(1); // 一次都没多：一分钱不烧
    expect(candidates(w, 3, 5)).toEqual([]);
  });

  it("⭐ 卡被【退回】也一样不起子进程（这条链的缺口登记在源码里，不在这里假装补上）", async () => {
    // CEO 退回一份章程之后，任务仍停在 CHARTER_PENDING 而泵不可能再建第二张卡。
    // 这一发【钉的是这个现状】而不是"退回后能重新起草"—— 后者要 card_key 带轮次
    // 且 [规格] §7.1 补一条 reject 出边，那是边与 key 一起改的一件事。
    // 写成断言而不是注释，是因为将来真补那一格时，这一发会红并要求改的人
    // 【看见】自己改的是一条被钉住的行为，而不是顺手放宽一个筛选条件。
    const w = await world({});
    await pump(w);
    w.db.prepare("UPDATE approvals SET status = 'rejected' WHERE task_id = 't1'").run();
    const r = await pump(w);
    expect(r.cards).toHaveLength(0);
    expect(w.turns).toHaveLength(1);
    expect(status(w, "t1")).toBe("CHARTER_PENDING");
  });

  it("一轮里多条候选：只有没卡的被起草，taskLimit 挡在剩下的前面", async () => {
    const w = await world({ tasks: ["t1", "t2", "t3", "t4"] });
    await addCharterCard(w, "t1");
    const r = await pump(w, { taskLimit: 2 });
    expect(r.cards.map((c) => c.outcome)).toEqual(["drafted", "drafted"]);
    expect(w.turns).toEqual(["t2", "t3"]);
    // t4 没轮到（不是被跳过，是本轮没排上）：下一轮它是候选
    expect(candidates(w, 3, 5)).toEqual(["t4"]);
  });

  it("ORDER BY created_at：最老的想法先补（不确定排序 + limit 会饿死后来的）", async () => {
    const w = await world({});
    // 时间【与 id 顺序相反】，否则这一发测的是插入顺序而不是排序。
    w.db.prepare("UPDATE tasks SET created_at = ? WHERE id = 't1'").run(NOW + 30);
    addTasks(w.db, ["t2"], undefined, 20);
    addTasks(w.db, ["t3"], undefined, 10);
    expect(candidates(w, 3, 2)).toEqual(["t3", "t2"]);
  });
});

describe("C. 「不再试了」这件事留得下痕", () => {
  /**
   * ⭐ 这一组防的是【沉默】。候选 SQL 用 attempts < 上限 过滤，
   * 一个到上限的任务会【从候选里消失】。不在它消失的那一刻留一行，
   * 它就从此不出现在任何一轮的报告里 —— 而「每轮都在报的故障」与
   * 「谁都不知道的沉默」之间，没有任何东西会响。
   */
  it("用完上限那一轮 ⇒ 留一行 CharterDraftAbandoned，且【不广播】", async () => {
    const w = await world({});
    const r = await pump(w, { ok: false, maxAttempts: 1 });
    expect(r.abandoned).toEqual(["t1"]);
    const g = gaveUpRows(w);
    expect(g).toHaveLength(1);
    expect(String(g[0]?.["actor_id"])).toBe(PUMP_ACTOR.actorId);
    expect(String(g[0]?.["target"])).toBe(PUMP_GAVE_UP_TARGET);
    const p = JSON.parse(String(g[0]?.["payload"])) as Record<string, unknown>;
    expect(p["kind"]).toBe(CHARTER_GAVE_UP_KIND);
    expect(p["attempts"]).toBe(1);
    expect(p["max_attempts"]).toBe(1);
    // 【不广播】：它不是 DomainEvent 的一个 kind（源码那段的三条理由）。
    // ⚠ 理由【不是】"发出去前端解不出来" —— 那是假的，实测过：feedItemSchema 的
    //   kind 是 z.string().min(1) 且 .passthrough()，联合外的 kind 通得过校验，
    //   而 web 投影的 switch 未命中落 default「只推进 cursor」⇒ 真后果是【一条被静默丢弃的帧】，
    //   比报错更难发现。完整论证在 charter-pump.ts 那条 ② 旁边（0044 §6）。
    //   这里这条断言判的仍然是【总线上不该有它】，与理由对错无关，所以它一直有效。
    // 总线上的每一条都必须能在 events 里对上号。
    expect(await drained(w)).toEqual(["RoleTurnReported"]);
    // 而且它不改状态：任务哪儿也没去
    expect(status(w, "t1")).toBe("CHARTER_PENDING");
  });

  it("⭐ 放弃那一行【不被算成一次尝试】—— 否则上限自己数自己", async () => {
    // 计数 SQL 认的是 RoleTurnReported，放弃行是 CharterDraftAbandoned。
    // 有人把放弃行也写成 RoleTurnReported 的话这一发会红 —— 那时
    // attempts 会是 maxAttempts + 1，「第几次」这个数字就再也不能信了，
    // 而它错的方向恰好是【更早放弃】，最难往回查。
    const w = await world({});
    await pump(w, { ok: false, maxAttempts: 1 });
    expect(attempts(w, "t1")).toBe(1);
    expect(gaveUpRows(w)).toHaveLength(1);
  });

  it("⭐ 放弃【只留一行】：后续轮次不重复写", async () => {
    // 到上限之后它不再是候选 ⇒ 那个循环再也看不见它 ⇒ 天然只写一次。
    // 这一发钉的是"别为了'提醒得勤一点'去放宽候选 SQL"：append-only 表上
    // 每 60 秒一行同样的噪音，结局是巡检真要有事时报的东西也没人看（0016 §1 同族）。
    const w = await world({});
    await pump(w, { ok: false, maxAttempts: 1 });
    await pump(w, { ok: false, maxAttempts: 1 });
    await pump(w, { ok: false, maxAttempts: 1 });
    expect(gaveUpRows(w)).toHaveLength(1);
    expect(w.turns).toHaveLength(1);
  });

  it("还没到上限 ⇒ 不留放弃行（否则「试过没成」和「不再试了」在库里长一样）", async () => {
    const w = await world({});
    await pump(w, { ok: false, maxAttempts: 3 });
    expect(gaveUpRows(w)).toHaveLength(0);
  });

  it("起草【成功】那一轮不留放弃行 —— 即便此前已试过几次", async () => {
    const w = await world({});
    await pump(w, { ok: false, maxAttempts: 2 });
    const r = await pump(w, { ok: true, maxAttempts: 2 });
    expect(r.abandoned).toEqual([]);
    expect(gaveUpRows(w)).toHaveLength(0);
    expect(pendingCards(w, "t1")).toBe(1);
  });

  it("⭐【花过钱的失败】也算尝试：上限管的是次数，不是「有没有花出钱」", async () => {
    // 这一发管住一个看起来很合理的"优化"：「失败而没花钱的那些不算次数」。
    // 算错的方向是【多试几次】—— 而每一次都是真 spawn、真可能真花钱。
    const w = await world({});
    const r1 = await pump(w, { ok: false, costCents: 4, maxAttempts: 2 });
    const r2 = await pump(w, { ok: false, costCents: 4, maxAttempts: 2 });
    expect(w.turns).toHaveLength(2);
    // ⚠ 放弃发生在【用完最后一次的那一轮】（r2），不是它的下一轮：
    // 下一轮它已经不是候选，那个循环再也看不见它。这正是「本轮之后再数一遍」
    // 那句注释在说的东西 —— 写成 r3.abandoned 会永远得到空数组。
    expect(r1.abandoned).toEqual([]);
    expect(r2.abandoned).toEqual(["t1"]);
    const r3 = await pump(w, { ok: false, costCents: 4, maxAttempts: 2 });
    expect(r3.abandoned).toEqual([]);
    expect(w.turns).toHaveLength(2); // 第三轮一次都没起
    // 账仍然是真账：两次各 4 美分，落进 tasks.consumed_cents
    expect(Number((w.db.prepare("SELECT consumed_cents FROM tasks").get() as Row)["consumed_cents"])).toBe(8);
  });
});

describe("D. 那个表达式索引【还在被用上】", () => {
  /**
   * ⚠ 表达式索引静默失效的表现是【每轮一次 events 全表扫】，除了变慢没有任何症状。
   * 只能这样钉（perf-thresholds.test.ts 同族）。
   */
  it("计数那条 SQL 的计划里有 idx_events_task_kind_created", async () => {
    const w = await world({});
    const plan = (w.db.prepare("EXPLAIN QUERY PLAN " + CHARTER_ATTEMPTS_SQL).all("t1") as Row[])
      .map((r) => String(r["detail"]))
      .join("\n");
    expect(plan).toContain("idx_events_task_kind_created");
  });

  it("候选那条 SQL 里的 kind 表达式与 patrol 的 kindOf【同源】，不是又抄了一份", () => {
    // kindOf 收别名前缀，而表达式索引认的是【解析后的列引用】——
    // 加不加别名都能匹配，所以索引计划那一发挡不住"有人把两处写法改散了"。
    // 这里钉的是【两处用的是同一个 kindOf】：都带 `p.` 前缀，且没有裸 payload 那一份。
    expect(CHARTER_CANDIDATES_SQL).toContain("json_valid(p.payload)");
    expect(CHARTER_CANDIDATES_SQL).toContain("json_extract(p.payload, '$.kind')");
    expect(CHARTER_ATTEMPTS_SQL).toContain("json_valid(p.payload)");
    expect(CHARTER_ATTEMPTS_SQL).not.toMatch(/json_valid\(payload\)/u);
    expect(CHARTER_CANDIDATES_SQL).not.toMatch(/json_valid\(e\.payload\)/u);
  });

  it("索引【真被删掉】时计划里没有那个名字（反向对照：上面那发不是恒绿）", async () => {
    const w = await world({});
    w.db.exec("DROP INDEX idx_events_task_kind_created");
    const plan = (w.db.prepare("EXPLAIN QUERY PLAN " + CHARTER_ATTEMPTS_SQL).all("t1") as Row[])
      .map((r) => String(r["detail"]))
      .join("\n");
    expect(plan).not.toContain("idx_events_task_kind_created");
  });
});

describe("E. 不牵连：一张坏了不影响同轮另外几张", () => {
  it("⭐ 某一张起草【直接抛】⇒ 同轮另外那张照样补，整轮不抛", async () => {
    // 抛到 ticker 那一层会变成「心跳失败计数 +1」，连番几次停掉的是【整条心跳】
    // （含巡检与备份）。一张卡起草不动不该让停滞检测从此不再运行。
    const w = await world({ tasks: ["t1", "t2"] });
    let n = 0;
    const deps = (): CharterCardDeps => ({
      runTurn: async () => {
        n += 1;
        if (n === 1) throw new Error("子进程没起来");
        return { ok: true, text: draftText(), costCents: 6, sessionId: null, error: null };
      },
      rolePrompt: (r) => "你是角色 " + r,
    });
    const r = await pumpCharterCards(w.q, w.bus, {
      nowMs: NOW + 1000,
      cardDeps: deps,
      maxBudgetUsd: 0.5,
      taskLimitCents: 1000,
      cwd: TMP,
    });
    expect(r.cards).toHaveLength(2);
    expect(r.cards[0]?.outcome).toBe("attempted");
    expect(r.cards[0]?.note).toContain("子进程没起来");
    expect(r.cards[1]?.outcome).toBe("drafted");
    expect(pendingCards(w, "t2")).toBe(1);
  });

  it("任务不在 CHARTER_PENDING ⇒ 不进候选（别的格子不归泵管）", async () => {
    const w = await world({ status: "IN_PROGRESS" });
    const r = await pump(w);
    expect(r.cards).toHaveLength(0);
    expect(w.turns).toHaveLength(0);
  });

  it("起草角色【不在组织图上】⇒ org_blocked 归到 skipped：不计尝试、不留放弃行", async () => {
    // 组织图缺失是【配置问题】，重试一万次也不会好。把它计入上限，
    // 表现是"CEO 加了角色之后这条任务已经被告终"，而那件事没人能想到。
    const w = await world({});
    w.db.prepare("UPDATE tasks SET assigned_role = 'ghost' WHERE id = 't1'").run();
    let recorded = 0;
    const r = await pumpCharterCards(w.q, w.bus, {
      nowMs: NOW + 1000,
      cardDeps: fakeCardDeps(w),
      recordTurn: async () => {
        recorded += 1;
        return { recorded: true, why: "" };
      },
      maxBudgetUsd: 0.5,
      taskLimitCents: 1000,
      cwd: TMP,
      maxAttempts: 1,
    });
    expect(r.cards.map((c) => c.outcome)).toEqual(["skipped"]);
    expect(r.abandoned).toEqual([]);
    expect(gaveUpRows(w)).toHaveLength(0);
    expect(w.turns).toHaveLength(0);
    // ⭐ 一次都没跑 ⇒ 执行日志【一条都不记】。少这一句断言的话，
    // 「没跑一轮也记一笔」那种实现（变异 M19）在本文件里全绿 ——
    // 而它把 §12.7 第 4 层那本「每次调用都留痕」的账整个作废。
    expect(recorded).toBe(0);
    expect(r.turns).toHaveLength(0);
    // 下一轮它【仍然是候选】：CEO 补上角色之后泵会自己接着干
    expect(candidates(w, 3, 5)).toEqual(["t1"]);
  });

  /**
   * ⭐ 并发里别人抢先建了卡 ⇒ already_pending 归到 skipped，且【不记执行日志】。
   *
   * 这一发是补出来的，不是顺手写的：变异 M18（把 already_pending 也算成"跑过一轮"）
   * 在初版 27 发之下【全绿】—— 也就是说那句"在执行日志里造一笔没发生过的调用"
   * 我当时【没有判据】。原因：候选 SQL 现在要求【一张卡都没有】，
   * 而 already_pending 需要【已有一张 pending 卡】，两者正常情况下互斥，
   * 所以这个分支【只能靠并发】到达。造法：让假的 runTurn 在自己那一轮里
   * 【替另一个写入方把卡建掉】—— 那正是"另一个进程同时起草同一件事"的形状。
   */
  it("⭐ 起草途中别人抢先建了卡 ⇒ already_pending：钱已花、卡不重复、执行日志不记", async () => {
    const w = await world({});
    let recorded = 0;
    const deps = (): CharterCardDeps => ({
      runTurn: async () => {
        // 模拟另一个写入方在我这一轮期间建好了同一张卡
        w.db
          .prepare(
            "INSERT INTO approvals (id, task_id, approval_type, card_key, summary, parameters, " +
              "recommendation, recommendation_source, timeout_behavior, status, created_at) " +
              "VALUES ('a-race','t1','charter',?, '别人建的', '{}', '', '', 'escalate', 'pending', ?)",
          )
          .run(CHARTER_CARD_KEY, NOW);
        return { ok: true, text: draftText(), costCents: 6, sessionId: null, error: null };
      },
      rolePrompt: (r) => "你是角色 " + r,
    });
    const r = await pumpCharterCards(w.q, w.bus, {
      nowMs: NOW + 1000,
      cardDeps: deps,
      recordTurn: async () => {
        recorded += 1;
        return { recorded: true, why: "" };
      },
      maxBudgetUsd: 0.5,
      taskLimitCents: 1000,
      cwd: TMP,
    });
    expect(r.cards.map((c) => c.outcome)).toEqual(["skipped"]);
    // 只有一张卡：唯一索引挡住了第二张（0014 §3：那张错的卡片删不掉，所以只能挡住）
    expect(pendingCards(w, "t1")).toBe(1);
    // 钱【照记】：token 真花了（charter.ts 那两支都调 bill）
    expect(Number((w.db.prepare("SELECT consumed_cents FROM tasks").get() as Row)["consumed_cents"])).toBe(6);
    // 而执行日志【不记】—— already_pending 有两支而返回值分不开（一支真起了子进程、
    // 一支没有），宁可少一行也不在执行日志里造出一笔说不清是否发生过的调用。
    expect(recorded).toBe(0);
    expect(r.turns).toHaveLength(0);
  });
});

describe("F. 广播与 seq", () => {
  it("起草成功那一轮：总线收到的与 events.id 逐条对齐，最大 seq 不落空", async () => {
    const w = await world({});
    await pump(w);
    const ids = rows(w, "SELECT id FROM events ORDER BY id").map((x) => Number(x["id"]));
    const got = await drainedWithSeq(w);
    expect(got.map((g) => g.seq)).toEqual(ids);
    expect(w.bus.latestSeq()).toBe(ids[ids.length - 1]);
  });

  it("零花费的失败轮【也广播】（写了 events 就得发，0010 §4 那条 seq 空洞）", async () => {
    const w = await world({});
    await pump(w, { ok: false, maxAttempts: 3 });
    const ids = rows(w, "SELECT id FROM events ORDER BY id").map((x) => Number(x["id"]));
    expect(ids).toHaveLength(1);
    expect((await drainedWithSeq(w)).map((g) => g.seq)).toEqual(ids);
  });
});

describe("G. 执行日志（recordTurn）", () => {
  it("跑了一轮 ⇒ 记一笔；没跑一轮 ⇒ 【不造】一笔", async () => {
    const w = await world({});
    const seen: { taskId: string; ok: boolean; costCents: number; role: string }[] = [];
    const r = await pumpCharterCards(w.q, w.bus, {
      nowMs: NOW + 1000,
      cardDeps: fakeCardDeps(w),
      recordTurn: async (i) => {
        seen.push({ taskId: i.taskId, ok: i.ok, costCents: i.costCents, role: i.role });
        return { recorded: true, why: "" };
      },
      maxBudgetUsd: 0.5,
      taskLimitCents: 1000,
      cwd: TMP,
    });
    expect(seen).toEqual([{ taskId: "t1", ok: true, costCents: 6, role: "intake" }]);
    expect(r.turns).toEqual([{ taskId: "t1", recorded: true, why: "" }]);

    // 第二轮已有卡 ⇒ 一次都没跑 ⇒ 一条都不记。
    // 「在执行日志里造出一笔没发生过的调用」比「少一行」糟得多：
    // §12.7 第 4 层要的就是「每次调用都留痕」，多一行假的等于把这本账作废。
    const r2 = await pumpCharterCards(w.q, w.bus, {
      nowMs: NOW + 2000,
      cardDeps: fakeCardDeps(w),
      recordTurn: async () => {
        seen.push({ taskId: "SHOULD-NOT-HAPPEN", ok: true, costCents: 0, role: "" });
        return { recorded: true, why: "" };
      },
      maxBudgetUsd: 0.5,
      taskLimitCents: 1000,
      cwd: TMP,
    });
    expect(seen).toHaveLength(1);
    expect(r2.turns).toHaveLength(0);
  });

  it("recordTurn 抛了 ⇒ 不把整轮泵带走，结论带在 turns 里", async () => {
    const w = await world({});
    const r = await pumpCharterCards(w.q, w.bus, {
      nowMs: NOW + 1000,
      cardDeps: fakeCardDeps(w),
      recordTurn: async () => {
        throw new Error("库锁");
      },
      maxBudgetUsd: 0.5,
      taskLimitCents: 1000,
      cwd: TMP,
    });
    expect(r.cards).toHaveLength(1);
    expect(r.cards[0]?.outcome).toBe("drafted");
    expect(r.turns[0]?.recorded).toBe(false);
    expect(r.turns[0]?.why).toContain("库锁");
    // 卡照样在：执行日志少一行不该让起草这件事作废
    expect(pendingCards(w, "t1")).toBe(1);
  });

  it("注入了假起草而没注入 recordTurn ⇒ 明说【没有写入方】，而不是回退去建真 runtime", async () => {
    // 回退等于"为了让测试不花钱而注入一份假的，结果真 runtime 还是被建起来了"，
    // 注入点就白给了一半（见源码 engineOf 那一段）。
    const w = await world({});
    const r = await pump(w);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]?.recorded).toBe(false);
    expect(r.turns[0]?.why).toContain("没有提供执行日志的写入方");
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * H. 【默认那一支】—— 生产真正走的那条路，真 spawn 一个子进程
 *
 * 为什么这一组必须存在，而它是本篇最后加上的：A–G 那 28 发【全部】注入 cardDeps，
 * 也就是全部绕开了 engineOf 的默认分支（makeRuntime + o.bin + 真 recordTurn）。
 * 这不是猜的，是量出来的两发变异（0044 §9.2 第 1 条原来的说法在这里被推翻）：
 *   · 把 `...(o.bin === undefined ? {} : { bin: o.bin })` 整行删掉 ⇒ 43 发全绿；
 *   · 把默认那一支的 `recordTurn: () => runtime().recordTurn` 换成 noRecorder ⇒ 43 发全绿。
 * 后者的后果是【执行日志永远少一行而卡照样建出来】，前者的后果是【生产永远 spawn 真 claude】。
 *
 * ⚠ 顺带更正 0044 §9.2 第 1 条那句话：「真子进程那条路本机没验过」对**泵**成立、
 *   对**CLI 那条路**不成立 —— engine/work.test.ts:265 早就用同一份桩 CLI 真跑通过
 *   `hub work` 整条链。所以缺的一直只是"泵自己这一侧的默认分支"，范围比我写的小。
 *
 * ⚠ 这一组换掉了一条我原本想写的断言。我起初打算断「没抛」——那是一条【恒绿】的断言：
 *   删掉 bin 透传之后，本机 PATH 上真有 claude（实测 /Users/cjm/.nvm/.../v22.12.0/bin/claude），
 *   它照样起得来、照样不抛。所以断言一律断【内容出自桩说的那句话】：
 *   那样一来"起的是别人"必红。**而起的是别人时，这一发会从一次测试里真发出一次 API 调用** ——
 *   这句话写在这里，是因为它只有在坏掉的那天才会被人读到，而那时它正是最该被读到的东西。
 *
 * 桩是 test/engine/fixtures/fake-claude.mjs（真可执行 + shebang，非 mock；
 * 它的存在理由与"为什么不能是 mock"写在那个文件头与 work.test.ts 里，不在这里重述）。
 * ────────────────────────────────────────────────────────────────────────── */
const FAKE_CLI = fileURLToPath(new URL("../engine/fixtures/fake-claude.mjs", import.meta.url));

/**
 * 跑一趟【不注入 cardDeps】的泵 —— 这一句就是这一组的全部意义。
 * A–G 用的是 pump()，那一格永远有假回调；这里刻意一格都不给。
 */
async function pumpReal(w: World, o: { readonly maxAttempts?: number } = {}): Promise<PumpRoundResult> {
  return pumpCharterCards(w.q, w.bus, {
    nowMs: NOW + 1000,
    maxBudgetUsd: 0.5,
    taskLimitCents: 1000,
    cwd: TMP,
    bin: FAKE_CLI,
    ...(o.maxAttempts === undefined ? {} : { maxAttempts: o.maxAttempts }),
  });
}

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

function harnessCalls(w: World): Row[] {
  return rows(
    w,
    "SELECT agent_role, harness, exit_code, cost_cents, session_id, args_redacted " +
      "FROM harness_calls ORDER BY created_at, id",
  );
}

describe("H. 默认那一支（makeRuntime + 真子进程 + 真执行日志）", () => {
  it("⭐ 真起一个子进程 ⇒ 卡的内容出自【桩说的话】，账与执行日志各一行", async () => {
    const w = await world({});
    const r = await pumpReal(w);
    expect(r.cards[0]?.outcome).toBe("drafted");
    expect(pendingCards(w, "t1")).toBe(1);

    const card = rows(w, "SELECT summary, parameters FROM approvals WHERE task_id = 't1'")[0] as Row;
    // ⭐ 这一句是这一发的心脏，也是它不恒绿的全部理由：
    // "方案已成型，交技术总监审阅" 只存在于【那个 .mjs 文件里】。
    // 卡片上是这句话 ⇒ 起的一定是它 ⇒ o.bin 真的透到了 spawn(argv)。
    expect(String(card["summary"])).toContain("方案已成型，交技术总监审阅");
    // 命令行上那个美元硬顶【到了子进程手里】：桩把收到的 --max-budget-usd 回显进正文，
    // 正文折进卡片第二行（impact_scope）。判"上限没到子进程"只能靠回声 ——
    // 少这一个参数时【一切照常跑通】，只是那个上限从此不存在了。
    // ⚠ 断的是【解出 JSON 之后】的那一行，不是原始字符串里的 `"budget":"0.5"`：
    //   impact_scope 本身是被 JSON 转义过的，原始串里那个形状是 `\"budget\":\"0.5\"`，
    //   照着字面断会红在一个纯粹的转义上（第一次跑就是这么红的）。
    const params = JSON.parse(String(card["parameters"])) as { impact_scope?: string };
    expect(String(params["impact_scope"])).toContain('"budget":"0.5"');

    // 桩报 0.042 美元 = 4 美分。走的是真的 usdToCents 与真的 bill()。
    const t = w.db.prepare("SELECT consumed_cents FROM tasks WHERE id = 't1'").get() as Row;
    expect(Number(t["consumed_cents"])).toBe(4);

    // ⭐ 执行日志那一行是【真 recordTurn】写的（默认那一支的 recordTurn 走 runtime）。
    // 这一发在 P2 变异（换成 noRecorder）下红 —— 而那一个坏掉的形状是
    // "卡建出来了、账也记了、执行日志永远少一行"，正是 §12.7 第 4 层要防的那一格。
    const hc = harnessCalls(w);
    expect(hc).toHaveLength(1);
    expect(String(hc[0]?.["agent_role"])).toBe("intake");
    expect(String(hc[0]?.["harness"])).toBe("claude-code");
    expect(Number(hc[0]?.["exit_code"])).toBe(0);
    expect(Number(hc[0]?.["cost_cents"])).toBe(4);
    // 桩明明回了 session_id=sess-1，而这一列是 null —— 那是【现状】不是这一发的坏：
    // CharterResult 不带 sessionId（0044 §9.2 第 2 条）。它跟着 0044 §9.1 那条
    // 「把缺口钉成现状」的口径走：补上的那天这一发红，逼改的人看见自己在改什么。
    expect(hc[0]?.["session_id"]).toBeNull();
  });

  it("⭐ 真子进程【失败且零花费】⇒ 卡不建，但执行日志与尝试计数【都还在】", async () => {
    // 这一发测的是 0044 §1 那条依赖在【默认分支】上成立：
    // 本机最可能的失败正是"子进程起来了而输出不是预期 JSON"（等价于装不上 / ENOENT），
    // 它一分钱不花 ⇒ 一旦这种轮次不写审计，attempts 永远数出 0 ⇒ 上限永远不生效 ⇒
    // 【每个心跳重新起一个注定失败的子进程，无限、静默、不产生账单】。
    // A 组已在注入那一支上钉过同一件事，这里钉的是【真 spawn 那一支】——
    // 两条分支写审计的路径是同一段代码，但"同一段代码"这件事本身正是需要一发的东西。
    const w = await world({});
    const r = await withFakeMode("garbage", () => pumpReal(w));
    expect(r.cards[0]?.outcome).toBe("attempted");
    expect(pendingCards(w, "t1")).toBe(0);

    // 尝试计数 +1：这条是"上限有界"的地基。
    expect(attempts(w, "t1")).toBe(1);
    // 执行日志一行，exit_code=1、cost=0 —— 失败的一轮同样发生过（§12.7 第 4 层）。
    const hc = harnessCalls(w);
    expect(hc).toHaveLength(1);
    expect(Number(hc[0]?.["exit_code"])).toBe(1);
    expect(Number(hc[0]?.["cost_cents"])).toBe(0);
    // 失败原文进结论：一个人只看库会以为"什么都没发生"，看终端才拿得到原因。
    expect(r.cards[0]?.note).toContain("CLI 输出不是预期的 JSON");
  });

  it("⭐ 必填的 --agent-cwd【真的】到了子进程的工作目录", async () => {
    // 这一发是补的一格，不是我一开始想到的那一格。查之前我以为"cwd 传没传"由
    // claude.test.ts 覆盖着 —— 那里确实每发都带 cwd: HERE，而【没有一发读回来】：
    // 它验的是 argv 上的 --max-budget-usd 与 stdin 上的 prompt，cwd 只被【传】没被【判】。
    // ⇒ "参数一直在传"与"参数到了"是两件事，而我在读到子进程的 process.cwd() 之前分不清。
    //
    // 为什么这一格值得单独一发而不是顺手加在上面那条里：--agent-cwd 是泵的【三个必填同伴】
    // 之一，而它存在的理由是"猜一个目录等于猜它能看见哪些文件"（0044 §5）。
    // 少了这一发，那三个必填里【预算】有回声判据（上面那条），【目录】一个都没有 ——
    // 最坏的表现是角色在【Hub 自己的目录】里干活而配置的人以为在别处，那不会红。
    const w = await world({});
    // ⚠ 一个【专门的、与父进程 cwd 与 TMP 都不同】的目录。用 TMP 会让这一发在
    //   "子进程继承了父进程 cwd"那种坏法下【可能】恰好绿（父进程 cwd 就是仓库根，
    //   而 TMP 在它外面，所以今天不会假绿 —— 但把不发红的运气写成判据是错的）。
    const agentCwd = TMP + "/agent-cwd-probe";
    mkdirSync(agentCwd, { recursive: true });
    const r = await pumpCharterCards(w.q, w.bus, {
      nowMs: NOW + 1000,
      maxBudgetUsd: 0.5,
      taskLimitCents: 1000,
      cwd: agentCwd,
      bin: FAKE_CLI,
    });
    expect(r.cards[0]?.outcome).toBe("drafted");

    const card = rows(w, "SELECT parameters FROM approvals WHERE task_id = 't1'")[0] as Row;
    const params = JSON.parse(String(card["parameters"])) as { impact_scope?: string };
    const scope = String(params["impact_scope"]);
    // realpath 而不是原样比：macOS 的 tmp 在 /tmp -> /private/tmp 那条软链下面，
    // 子进程的 process.cwd() 报的是【物理路径】。直接比会红在符号链接上而不是红在判据上。
    // ⚠ 这一格留个诚实的边角：realpath 意味着"同一个目录经由另一条路径进来"时这一发
    //   分不出来 —— 而那正是这一发要防的坏法（防的是"根本没传"，不是"传了个等价别名"）。
    expect(scope).toContain(JSON.stringify(realpathSync(agentCwd)));
    // 反向对照的判据在这一发里是【同一条断言的形状】：父进程 cwd 是仓库根，
    // 与 agentCwd 不同 ⇒ 一旦 cwd 没透传、子进程继承了父进程的，这句就会红。
    expect(scope).not.toContain(JSON.stringify(process.cwd()));
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * I. 那道【花钱的门】：--task-limit-cents 在起子进程之前真的挡人
 *
 * 这一组补的是一个【已经上线的缺陷】，不是防御性用例。0044 那一版里泵拿着这个
 * 必填参数而【一次都没读它】就去 spawn。量出来的原话（0045 §1）：
 *   一条已花 500 美分而上限 100 的任务 ⇒ 「t1:drafted」，consumed 涨到 504。
 * 0041 §7 早就写了「任务级上限今天是一句声明，不是一道闸」，而我把那句读成了
 * "以后再接"，接的时候【没有回去看它】—— 于是"必填"只保证了命令行上写着这个参数。
 *
 * 这一组有四发不是凑数，各挡一种【互相独立】的坏法：
 *   ① 门本身（不挡 ⇒ 花钱）
 *   ② 门与 taskLimit 的绑参顺序（node:sqlite 绑错【不报错】，只是把 limit 当成上限）
 *   ③ 门读哪一列（读错列 ⇒ 门永远开着一半：界面说超了而门不挡，或反之）
 *   ④ "被挡住了"这件事【说出来】（不说 ⇒ 与"泵没开"同一个画面）
 * 尤其 ④：前三发全过的实现仍然可以是【静默的】—— 它正确地不花钱，而那个人
 * 看到的现象与"这个参数从没生效"完全相同。
 * ────────────────────────────────────────────────────────────────────────── */
describe("I. 花钱的门：到上限就不再为这条任务起子进程", () => {
  it("⭐ 已花到上限的任务【不进候选】：一次 spawn 都不起", async () => {
    const w = await world({});
    spend(w, "t1", 150);
    const r = await pump(w, { taskLimitCents: 100 });
    // 断的是【一次都没起草】而不是"没建出卡"—— 与 A 组同一条理由：
    // 「不花钱」与「不重试」不是同一件事，而这里要防的就是花钱。
    expect(r.cards).toHaveLength(0);
    expect(pendingCards(w, "t1")).toBe(0);
    expect(attempts(w, "t1")).toBe(0);
  });

  it("⭐ 刚好等于上限也挡（§7.4 说的是「达到阈值」，达到就是达到）", async () => {
    const w = await world({});
    spend(w, "t1", 100);
    expect((await pump(w, { taskLimitCents: 100 })).cards).toHaveLength(0);
    // 反向对照：少一分钱就放行。少了这一句，"恰好相等"这一发与"门整个不在"不可区分。
    const w2 = await world({});
    spend(w2, "t1", 99);
    expect((await pump(w2, { taskLimitCents: 100 })).cards[0]?.outcome).toBe("drafted");
  });

  it("⭐ taskLimit=1 时门【还是门】：两个相邻的整数没被绑串", async () => {
    // node:sqlite 绑错顺序【不抛】。少绑/错绑一份，SQL 仍然合法，
    // 而表现是"一轮最多补 3 张"被当成"上限 3 美分" —— 于是泵【几乎永远不起子进程】
    // 而一声不响。这一发的形状是【上限极大而 taskLimit=1】：
    // 门要是被 limit 顶掉，就会看到 0 张卡（3 美分 < 一轮的 4 美分花费）。
    const w = await world({ tasks: ["t1", "t2"] });
    const r = await pump(w, { taskLimitCents: 100_000_000, taskLimit: 1 });
    expect(r.cards).toHaveLength(1);
    expect(r.cards[0]?.outcome).toBe("drafted");
  });

  it("⭐ 门读的是【界面那条预算条读的同一列】，不是另一份花费", async () => {
    // 仓库里有【两个】花费列：LEDGER_SQL 写 tasks.consumed_cents，
    // ADD_TASK_BUDGET_SQL 写 budgets.consumed_cents（真跑一轮两处都加，实测都等于 4）。
    // 门读哪一列不是风格问题：overview/today.ts 那条预算条求和的是 budgets，
    // 而 §7.4 那张卡要显示「已消耗 / 上限」—— 门与界面读不同列，就会出现
    // "条说它超了而门不挡"（或反过来），而这两句都是【真话】。
    const w = await world({});
    // 只写【另一列】：门必须【看不见】它，否则说明门读错了列（或读了两列）。
    w.db.prepare("UPDATE tasks SET consumed_cents = 900 WHERE id = 't1'").run();
    const r = await pump(w, { taskLimitCents: 100 });
    expect(r.cards[0]?.outcome).toBe("drafted");
    expect(r.blocked).toHaveLength(0);
  });

  it("⭐ 被挡住的那条【在 blocked 里】，而且【穿过候选为空的早退】", async () => {
    // 这是本组最容易写错的一格：一条被门挡住的任务【按定义就不在候选里】，
    // 所以"候选为空 ⇒ 立刻 return"那一句一旦先跑，blocked 就永远是空数组，
    // 而这一发会红在【顺序】上而不是红在判据上 —— 我自己先踩了一次，
    // 那次红恰好证明了这一发有分辨力。
    const w = await world({});
    spend(w, "t1", 150);
    const r = await pump(w, { taskLimitCents: 100 });
    expect(r.cards).toHaveLength(0); // 整轮无事可做 ⇒ 走的就是那条早退
    expect(r.blocked).toEqual([{ taskId: "t1", title: "想法 t1", consumedCents: 150 }]);
  });

  it("⭐ blocked 数的正是【本来会成为候选而因为钱没成为候选】那批", async () => {
    // 三种"没被起草"必须【只有第三种】进 blocked，否则这句话会把人指向错的方向：
    //   已有卡的（那一格已经有东西在回答）、状态不对的（不归泵管）、超限的（这才是要说的）。
    const w = await world({ tasks: ["t1", "t2", "t3", "t4"], status: "CHARTER_PENDING" });
    spend(w, "t1", 150); // 超限 ⇒ 该进 blocked
    await addCharterCard(w, "t2"); // 已有卡 ⇒ 不该进
    w.db.prepare("UPDATE tasks SET status = 'IN_PROGRESS' WHERE id = 't3'").run(); // 不归泵管 ⇒ 不该进
    // t4 什么都没做 ⇒ 它是正常候选，会被起草，也不该在 blocked 里
    const r = await pump(w, { taskLimitCents: 100 });
    expect(r.blocked.map((b) => b.taskId)).toEqual(["t1"]);
    expect(r.cards.map((c) => c.taskId)).toEqual(["t4"]);
    // 同源判据的直接证据：与候选 SQL 用【同一个谓词常量】，不是又抄了一份字面。
    // 抄本漂了的表现是"门挡了而 blocked 数不到"= 沉默，或反之 = 谎报。
    expect(CHARTER_BLOCKED_SQL).toContain(underTaskBudgetSql("t"));
    expect(CHARTER_CANDIDATES_SQL).toContain(underTaskBudgetSql("t"));
    // 再问一次【还是它】：这一格要说的是"这句话每轮都在"，而不是"说过一次就销案"。
    // （assemble 那一侧的去重是【终端】的去重，不是【事实】的销案 —— 见 pumpBudgetWarned。）
    expect((blockedRows(w, 100) as Row[]).map((b) => String(b["id"]))).toEqual(["t1"]);
  });

  it("没花钱过的任务【不受门影响】（门不在时也要放行 ⇒ 反向对照）", async () => {
    const w = await world({});
    const r = await pump(w, { taskLimitCents: 1 });
    // 上限 1 美分而任务一分没花 ⇒ 0 < 1 成立 ⇒ 放行。
    // 这一发防的是【写反的比较号】：写成 consumed > 0 会让【每条新任务】都被挡住，
    // 而那与"泵坏了"在收件箱上完全一样（空的），且永远不花一分钱 ⇒ 永不出账单。
    expect(r.cards[0]?.outcome).toBe("drafted");
    expect(r.blocked).toHaveLength(0);
  });
});

/**
 * 把总线上已有的事件读完。
 *
 * 照 decision-engine-route.test.ts 那个 feed 的形状：先取 latestSeq 再 subscribe(0)，
 * 迭代【 owed 次】后 close。迭代到 done 会挂着不走（异步可迭代对象在空队列上不结束）。
 */
async function drainedWithSeq(w: World): Promise<{ kind: string; seq: number }[]> {
  const owed = w.bus.latestSeq();
  const sub = w.bus.subscribe(0);
  const it = sub[Symbol.asyncIterator]();
  const got: { kind: string; seq: number }[] = [];
  for (let i = 0; i < owed; i++) {
    const step = await it.next();
    if (step.done === true) break;
    const e = step.value as DomainEvent & { seq?: number };
    got.push({ kind: e.kind, seq: e.seq ?? -1 });
  }
  sub.close();
  return got;
}
async function drained(w: World): Promise<string[]> {
  return (await drainedWithSeq(w)).map((g) => g.kind);
}
