/**
 * 卡片投递那一趟（src/channels/deliver.ts，O12 动作 4）。
 *
 * ── 这一文件在证什么 ──────────────────────────────────────────────────
 * `deliverCard` 从写下那天起【曾经】零生产调用方（round283 之前），而它缺的不是调用点，
 * 是「这张卡送过没有」那个答案。本文件钉的就是那个答案的**四条性质**：
 *  ① 幂等**跨重启**（换新 WriteQueue 指向同一个库文件，仍然不重发）；
 *  ② 顺序是**先抢台账再发**，所以发送失败的卡【带着行】留下、下一轮不再自动推；
 *  ③ 一张卡的失败【不带走】其余的卡（含最难造的那条：外键违例会把 promise 变成 reject）；
 *  ④ 「不可逆」不改变**推不推**，只改变**以什么形态推**（只读形态照样推出去）。
 *
 * ── 为什么每条都要真库真迁移 ─────────────────────────────────────────
 * ①与②的判据住在**DDL** 上：主键 `(approval_id, channel_id)` 才是幂等键，
 * `INSERT OR IGNORE` 的 `changes` 才是「抢到没有」的读数。手搓表测不到「外键违例
 * 会抛而主键违例不抛」这一族差别 —— 而③整条就建立在那条差别上（本轮实测，
 * 见 `RECORD_DELIVERY_SQL` 上面那段）。
 *
 * ── 「模拟重启」为什么是换 WriteQueue 而不是清空内存 ──────────────────
 * 本文件最怕的假绿是：用一个进程内的 Set 当幂等状态，测试里从不清空它，于是
 * 「重启之后重发」这一格**在结构上测不到**。所以 restart() 真的 close 掉队列、
 * 对同一个 path 再 new 一个 —— 那一刻任何只存在于内存里的去重都会失效并当场变红。
 *
 * ── 时钟注入 ─────────────────────────────────────────────────────────
 * `sent_at` 由调用方交进来。用真 Date.now 就只能断言「大概是现在」，
 * 而这一格将来是排障时唯一的时刻证据（日志跨不过重启，见 0009 文件头）。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, expect, it } from "vitest";
import {
  ACTION_RETURN_HINT,
  type Channel,
  type ChannelEnvelope,
  IRREVERSIBLE_HINT,
  type OutboundApprovalCard,
} from "../../src/channels/abstraction.js";
import {
  clearDeliveriesFor,
  runDeliverPass,
  wasDelivered,
} from "../../src/channels/deliver.js";
import { openDb } from "../../src/db/driver.js";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("channels-deliver", import.meta.url);
const T0 = Date.parse("2026-04-05T06:07:08.000Z");
const CH = "fake-deliver";

const queues: Array<{ close(): Promise<void> }> = [];
const dbs: Array<{ close(): void }> = [];
let seq = 0;
mkdirSync(TMP, { recursive: true });

/** 真库 + 真迁移 + 一个 WriteQueue（测试自己那条写连接用于摆夹具）。 */
function fresh(): { path: string; db: DatabaseSync; w: WriteQueue } {
  const path = join(TMP, "deliver-" + ++seq + ".db");
  const db = openDb(path) as unknown as DatabaseSync;
  dbs.push(db);
  migrate(db);
  const w = new WriteQueue(path);
  queues.push(w);
  return { path, db, w };
}

function addTask(db: DatabaseSync, id: string): void {
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
      "VALUES (?, ?, 'IN_PROGRESS', 'dev', 'implement', ?, ?)",
  ).run(id, "投递夹具 " + id, T0, T0);
}

interface InsertCardOpts {
  readonly id: string;
  readonly taskId?: string;
  readonly status?: string;
  readonly parameters?: Record<string, unknown>;
}

/**
 * 直接落一张 pending 卡（不走 createCard）。
 *
 * 绕开建卡路径是刻意的：投递这一趟要处理的是【已经存在】的卡，其中包含【建卡路径
 * 今天不会产出的脏卡】（parameters 不是 JSON、卡片已被删）。那些形状恰恰是③的主角。
 */
function insertCard(db: DatabaseSync, o: InsertCardOpts): string {
  const taskId = o.taskId ?? "t-" + o.id;
  if (!tasksSeen.has(taskId)) {
    tasksSeen.add(taskId);
    addTask(db, taskId);
  }
  db.prepare(
    "INSERT INTO approvals (id, task_id, approval_type, summary, parameters, recommendation, " +
      "recommendation_source, timeout_behavior, timeout_at, status, decided_by, decided_at, " +
      "decision_note, card_key, created_at, evidence_refs) " +
      "VALUES (?, ?, 'strategic', ?, ?, ?, NULL, 'auto_reject', NULL, ?, NULL, NULL, NULL, NULL, ?, ?)",
  ).run(
    o.id,
    taskId,
    "一次需要 CEO 拍的决定：" + o.id,
    JSON.stringify(
      o.parameters ?? { impact_scope: "测试任务", irreversible: false },
    ),
    "推荐：批准（推荐，非决定）",
    o.status ?? "pending",
    T0,
    JSON.stringify(["task:" + taskId + "/evidence"]),
  );
  return o.id;
}

const tasksSeen = new Set<string>();

/* ------------------------------------------------------------------ *
 * 一条够用的 fake 通道
 * ------------------------------------------------------------------ */

interface FakeDeliverOpts {
  readonly id?: string;
  /** 可变：①②里要在两趟之间改它（回传路断掉 ⇒ 只读形态）。 */
  readonly actionReturn?: boolean;
  /** 交一张卡，返回 true = 这一张【发送失败】（模拟平台拒收）。 */
  readonly reject?: (card: OutboundApprovalCard) => boolean;
  /**
   * 每次 `supportsActionReturn` 被【读】时调一次（第 n 次，从 1 起）。
   *
   * 一张卡读它【两次】：一次在抢台账组参数时，一次在 `deliverCard` 里判形态。
   * 想在「卡已读到、台账那一行还没落笔」的正中间改库（造出「扫描之后卡被删 /
   * 被人批掉」那两条竞态），只有这一条缝 —— 它是那条时间线上唯一的非 SQL 动作。
   * 计数从 1 起、按卡轮流：单卡是 1、2，第二张是 3、4。
   * （第一次我试着在【发送期间】删卡，那一发是假的：删在下一张卡的【读】之前，
   * 读到 null 直接走 skippedNotPending，外键那条路根本没走到 —— 红在
   * `failed.length` 是 0 而不是 1，round283 记了这一发。）
   */
  readonly onActionReturnRead?: (n: number) => void;
  /**
   * 每一次【发送结束】后调一次（成功与失败都算，在抛之前）。
   *
   * 这是时间线上另一条缝：下一张卡的【读】发生在这里之后。所以「本轮扫描之后
   * 那张卡被人批掉了」只有从这里才造得出来 —— 也是 `skippedNotPending`
   * 那一档唯一诚实的产生方式（不靠它就只能永远不测那一档）。
   */
  readonly onSent?: (card: OutboundApprovalCard) => void;
  /** 发送耗时：②/③用它看「是不是真的串行」。 */
  readonly sendMs?: number;
}

interface FakeDeliverHandle {
  readonly channel: Channel;
  readonly sent: OutboundApprovalCard[];
  /** 发送的进出时刻混排在一起 ⇒ 顺序那一发能看出交错。 */
  readonly trace: string[];
  setActionReturn(v: boolean): void;
}

function makeDeliverFake(o: FakeDeliverOpts = {}): FakeDeliverHandle {
  const sent: OutboundApprovalCard[] = [];
  const trace: string[] = [];
  let actionReturn = o.actionReturn ?? true;
  let reads = 0;
  const channel: Channel = {
    id: o.id ?? CH,
    platform: "fake",
    async start(): Promise<void> {},
    async close(): Promise<void> {},
    pull(): readonly ChannelEnvelope[] {
      return [];
    },
    async send(card: OutboundApprovalCard): Promise<void> {
      trace.push(">" + card.approvalId);
      if (o.sendMs) await new Promise((r) => setTimeout(r, o.sendMs));
      trace.push("<" + card.approvalId);
      o.onSent?.(card);
      if (o.reject?.(card) === true)
        throw new Error("平台拒收 " + card.approvalId);
      sent.push(card);
    },
    get supportsActionReturn(): boolean {
      reads += 1;
      o.onActionReturnRead?.(reads);
      return actionReturn;
    },
  };
  return {
    channel,
    sent,
    trace,
    setActionReturn: (v: boolean) => {
      actionReturn = v;
    },
  };
}

function pass(
  w: WriteQueue,
  fake: FakeDeliverHandle,
  over: { nowMs?: number; channelId?: string } = {},
) {
  return runDeliverPass({
    w,
    channels: [fake.channel],
    nowMs: over.nowMs ?? T0,
    channelId: over.channelId ?? fake.channel.id,
  });
}

function ledgerRows(db: DatabaseSync): Array<Record<string, unknown>> {
  return db
    .prepare(
      "SELECT approval_id, channel_id, sent_at, action_return FROM card_deliveries",
    )
    .all() as Array<Record<string, unknown>>;
}

/** 关掉旧队列、对同一个文件再开一个：内存里的任何去重都会在这一步失效。 */
async function restart(old: WriteQueue, path: string): Promise<WriteQueue> {
  await old.close();
  const w = new WriteQueue(path);
  queues.push(w);
  return w;
}

afterAll(async () => {
  for (const q of queues) {
    try {
      await q.close();
    } catch {
      /* 已关 */
    }
  }
  for (const d of dbs) {
    try {
      d.close();
    } catch {
      /* 已关 */
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});

/* ================================================================== *
 * ① 幂等：台账那一行是唯一事实源
 * ================================================================== */

it("首趟把没送过的 pending 卡推出去，并落一行台账", async () => {
  const { db, w } = fresh();
  insertCard(db, { id: "a-1" });
  const fake = makeDeliverFake();
  const r = await pass(w, fake);
  expect(r).toEqual({
    delivered: 1,
    alreadySent: 0,
    skippedNotPending: 0,
    failed: [],
  });
  expect(fake.sent.map((c) => c.approvalId)).toEqual(["a-1"]);
  expect(ledgerRows(db)).toEqual([
    { approval_id: "a-1", channel_id: CH, sent_at: T0, action_return: 1 },
  ]);
});

it("幂等跨重启：换了 WriteQueue 仍然不重发", async () => {
  const { path, db, w } = fresh();
  insertCard(db, { id: "b-1" });
  insertCard(db, { id: "b-2" });
  const fake1 = makeDeliverFake();
  expect((await pass(w, fake1)).delivered).toBe(2);

  // 「重启」：新队列 = 新进程。幂等状态如果只活在内存里，这一发就红了。
  const w2 = await restart(w, path);
  const fake2 = makeDeliverFake();
  const r = await pass(w2, fake2);
  expect(r.delivered).toBe(0);
  expect(r.alreadySent).toBe(2);
  expect(fake2.sent).toEqual([]);
  expect(ledgerRows(db).length).toBe(2);
});

it("台账按通道分开：换一条通道算一次新的投递", async () => {
  const { db, w } = fresh();
  insertCard(db, { id: "c-1" });
  const a = makeDeliverFake({ id: "ch-a" });
  await pass(w, a, { channelId: "ch-a" });
  const b = makeDeliverFake({ id: "ch-b" });
  const r = await pass(w, b, { channelId: "ch-b" });
  expect(r.delivered).toBe(1);
  expect(b.sent.map((c) => c.approvalId)).toEqual(["c-1"]);
  expect(ledgerRows(db).length).toBe(2);
});

it("wasDelivered 读得出「我们以为送过」，排障那一问有答案", async () => {
  const { db, w } = fresh();
  insertCard(db, { id: "d-1" });
  const read = w.readConnection();
  expect(wasDelivered(read, "d-1", CH)).toBe(false);
  await pass(w, makeDeliverFake());
  expect(wasDelivered(read, "d-1", CH)).toBe(true);
  // 另一条通道没送过 —— 主键是二元组，读侧也必须是二元组。
  expect(wasDelivered(read, "d-1", "别的通道")).toBe(false);
});

it("clearDeliveriesFor 是显式重推：清掉之后下一轮当新卡再推", async () => {
  const { db, w } = fresh();
  insertCard(db, { id: "e-1" });
  const fake = makeDeliverFake();
  await pass(w, fake);
  await clearDeliveriesFor(w, "e-1");
  expect(wasDelivered(w.readConnection(), "e-1", CH)).toBe(false);
  const r = await pass(w, fake);
  expect(r.delivered).toBe(1);
  expect(fake.sent.length).toBe(2);
});

/* ================================================================== *
 * ② 顺序：先抢台账，再发
 * ================================================================== */

it("发送失败的卡【带着台账行】留下，下一轮不再自动推", async () => {
  const { db, w } = fresh();
  insertCard(db, { id: "f-1" });
  // 第一次必失败。若顺序是「先发再插」，这里不会有任何行 ⇒ 下一轮再发一次 ⇒ 重复卡。
  const fake = makeDeliverFake({ reject: () => true });
  const first = await pass(w, fake);
  expect(first.failed).toEqual([
    { approvalId: "f-1", channelId: CH, why: "Error: 平台拒收 f-1" },
  ]);
  expect(first.delivered).toBe(0);
  expect(ledgerRows(db).length).toBe(1);

  // 换一条好通道（同 id，改旋钮）也不会自动补推：重试是**人工**决定。
  const good = makeDeliverFake();
  const second = await pass(w, good);
  expect(second.alreadySent).toBe(1);
  expect(good.sent).toEqual([]);
});

it("抢在发送之前 ⇒ 台账里的行与「送出去的卡」一一对应", async () => {
  const { db, w } = fresh();
  insertCard(db, { id: "g-1" });
  insertCard(db, { id: "g-2" });
  const fake = makeDeliverFake({ reject: (c) => c.approvalId === "g-2" });
  const r = await pass(w, fake);
  expect(r.delivered).toBe(1);
  expect(r.failed.map((f) => f.approvalId)).toEqual(["g-2"]);
  // 两行都在（g-2 那行是「试过而没成」的记号），而真送出去的只有一张。
  expect(ledgerRows(db).length).toBe(2);
  expect(fake.sent.map((c) => c.approvalId)).toEqual(["g-1"]);
});

it("一张卡失败不带走其余，且发送是串行的", async () => {
  const { db, w } = fresh();
  for (const id of ["h-1", "h-2", "h-3"]) insertCard(db, { id });
  const fake = makeDeliverFake({
    reject: (c) => c.approvalId === "h-2",
    sendMs: 4,
  });
  const r = await pass(w, fake);
  expect(r.delivered).toBe(2);
  expect(r.failed.length).toBe(1);
  expect(fake.sent.map((c) => c.approvalId)).toEqual(["h-1", "h-3"]);
  // 并发（Promise.all）会让 ">" 交错出现；串行必须是严格的一进一出。
  expect(fake.trace).toEqual([">h-1", "<h-1", ">h-2", "<h-2", ">h-3", "<h-3"]);
});

it("扫描之后卡被人删掉 ⇒ 记为失败、不抛出去、也不带走其余", async () => {
  const { db, w } = fresh();
  insertCard(db, { id: "i-1" });
  insertCard(db, { id: "i-2" });
  // 读第 3 次 = 第二张卡【抢台账】那一刻（第一张卡占掉 1、2 两次读）。
  // 在那里删掉 i-2 的卡片行 ⇒ 紧接着的那条 INSERT 撞外键。
  // 实测依据：`INSERT OR IGNORE` 只吞主键那一类，外键违例**会抛**（round283 探针），
  // 所以 claimDelivery 的 promise 会 reject —— 这一发钉的是「它被接住了」。
  const fake = makeDeliverFake({
    onActionReturnRead: (n) => {
      if (n === 3) db.prepare("DELETE FROM approvals WHERE id = 'i-2'").run();
    },
  });
  const r = await pass(w, fake);
  expect(r.delivered).toBe(1);
  expect(r.failed.length).toBe(1);
  expect(r.failed[0]?.approvalId).toBe("i-2");
  // 这一发的重点不是措辞，是「为什么它落在 failed 而不是让整轮 reject」。
  expect(String(r.failed[0]?.why)).toMatch(/FOREIGN KEY/);
  // 与「发送失败」相反：那次 INSERT 随事务回滚了，台账里【没有】i-2。
  expect(ledgerRows(db).map((x) => x.approval_id)).toEqual(["i-1"]);
});

it("扫描之后卡被人批掉 ⇒ 计入 skippedNotPending，不推也不落行", async () => {
  const { db, w } = fresh();
  insertCard(db, { id: "i2-a" });
  insertCard(db, { id: "i2-b" });
  // 第一张送出去之后，第二张在【这一轮里】被别人批掉了（模拟并发审批）。
  const fake = makeDeliverFake({
    onSent: (card) => {
      if (card.approvalId === "i2-a")
        db.prepare(
          "UPDATE approvals SET status = 'approved' WHERE id = 'i2-b'",
        ).run();
    },
  });
  const r = await pass(w, fake);
  expect(r.delivered).toBe(1);
  expect(r.skippedNotPending).toBe(1);
  expect(r.failed).toEqual([]);
  expect(fake.sent.map((c) => c.approvalId)).toEqual(["i2-a"]);
  expect(ledgerRows(db).map((x) => x.approval_id)).toEqual(["i2-a"]);
});

/* ================================================================== *
 * ③ 形态：推什么、什么时候只读
 * ================================================================== */

it("回传路没通 ⇒ 以只读形态推，台账记下那一刻的判定", async () => {
  const { db, w } = fresh();
  insertCard(db, { id: "j-1" });
  const fake = makeDeliverFake({ actionReturn: false });
  const r = await pass(w, fake);
  expect(r.delivered).toBe(1);
  const card = fake.sent[0] as OutboundApprovalCard;
  expect(card.actionable).toBe(false);
  expect(card.notActionableReason).toBe(ACTION_RETURN_HINT);
  expect(ledgerRows(db)[0]?.action_return).toBe(0);
});

it("不可逆卡照样推出去（只读），不发从来不是选项", async () => {
  const { db, w } = fresh();
  insertCard(db, {
    id: "k-1",
    parameters: { impact_scope: "删库", irreversible: true },
  });
  const fake = makeDeliverFake();
  const r = await pass(w, fake);
  expect(r.delivered).toBe(1);
  const card = fake.sent[0] as OutboundApprovalCard;
  expect(card.actionable).toBe(false);
  expect(card.notActionableReason).toBe(IRREVERSIBLE_HINT);
  // 台账照样有这一行 —— 「推不出去」与「推得出但不能点」在台账上是同一件真事。
  expect(ledgerRows(db).length).toBe(1);
});

it("只扫 pending：已批掉的卡不推、也不落行", async () => {
  const { db, w } = fresh();
  insertCard(db, { id: "l-1", status: "approved" });
  insertCard(db, { id: "l-2", status: "pending" });
  const fake = makeDeliverFake();
  const r = await pass(w, fake);
  expect(r).toEqual({
    delivered: 1,
    alreadySent: 0,
    skippedNotPending: 0,
    failed: [],
  });
  expect(fake.sent.map((c) => c.approvalId)).toEqual(["l-2"]);
  expect(ledgerRows(db).map((x) => x.approval_id)).toEqual(["l-2"]);
});

it("四档互斥且互补：每一种结局各数一次", async () => {
  const { db, w } = fresh();
  insertCard(db, { id: "m-ok" });
  insertCard(db, { id: "m-gone" });
  insertCard(db, { id: "m-sent" });
  // 已投过的一张：直接落行，不走投递（模拟上一轮的遗留）。
  // 顺序有意义：先有卡再有台账行 —— 外键不带 CASCADE，倒过来这一发直接抛。
  db.prepare(
    "INSERT INTO card_deliveries (approval_id, channel_id, sent_at, action_return) " +
      "VALUES ('m-sent', ?, ?, 1)",
  ).run(CH, T0 - 1000);
  insertCard(db, { id: "m-bad" });
  // 非 pending 的一张：压根不该被扫到（它不进分母）。
  insertCard(db, { id: "m-rejected", status: "rejected" });
  const scanned = (
    db
      .prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'")
      .get() as {
      n: number;
    }
  ).n;
  const fake = makeDeliverFake({
    reject: (c) => c.approvalId === "m-bad",
    // 第一张送出去之后，m-gone 在【这一轮里】被人批掉 ⇒ 它进 skipped 那一档。
    onSent: (card) => {
      if (card.approvalId === "m-ok")
        db.prepare(
          "UPDATE approvals SET status = 'approved' WHERE id = 'm-gone'",
        ).run();
    },
  });
  const r = await pass(w, fake);
  expect(r).toEqual({
    delivered: 1,
    alreadySent: 1,
    skippedNotPending: 1,
    failed: [
      { approvalId: "m-bad", channelId: CH, why: "Error: 平台拒收 m-bad" },
    ],
  });
  // 文件头那句「四档之和 = 本轮扫到的 pending 数」的机器判据。
  // ⚠ 分母取【扫描那一刻】的读数，不是趟末：中途被批掉的那张在趟末已经不是 pending，
  // 用趟末的数会少一张，于是这条不变量在唯一一条真竞态上恰好不成立 —— 而那正是
  // 「四档互补」这句话最需要成立的地方。
  expect(
    r.delivered + r.alreadySent + r.skippedNotPending + r.failed.length,
  ).toBe(scanned);
});

/* ================================================================== *
 * ④ 装配错法的形状
 * ================================================================== */

it("交进一条没注册的通道 id ⇒ 抛，而不是读成「本轮没有要发的卡」", async () => {
  const { db, w } = fresh();
  insertCard(db, { id: "n-1" });
  const fake = makeDeliverFake();
  await expect(pass(w, fake, { channelId: "ch-不存在" })).rejects.toThrow(
    /本轮【没有】投任何卡/,
  );
  // 抛之前一张都没发：宁可这一轮什么都不做，也不要「看起来发了」。
  expect(fake.sent).toEqual([]);
  expect(ledgerRows(db)).toEqual([]);
});

it("没有 pending 卡 ⇒ 四个零，一次外网调用都不发", async () => {
  const { w } = fresh();
  const fake = makeDeliverFake();
  const r = await pass(w, fake);
  expect(r).toEqual({
    delivered: 0,
    alreadySent: 0,
    skippedNotPending: 0,
    failed: [],
  });
  expect(fake.trace).toEqual([]);
});

it("parameters 是一段脏 JSON 也照样推：渲染层负责说「参数不可读」", async () => {
  const { db, w } = fresh();
  insertCard(db, { id: "o-1" });
  db.prepare(
    "UPDATE approvals SET parameters = '{ 这不是 JSON' WHERE id = 'o-1'",
  ).run();
  const fake = makeDeliverFake();
  const r = await pass(w, fake);
  expect(r.delivered).toBe(1);
  // null 而不是 {}：一张参数空白的卡读起来像「没有参数」，那是两种不同的无知。
  expect(fake.sent[0]?.parameters).toBeNull();
});
