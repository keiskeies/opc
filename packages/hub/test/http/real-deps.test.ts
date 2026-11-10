/**
 * 决策与建任务的真实写入路径（http/real-deps.ts）。
 *
 * ── 这个文件存在的理由：注入点被调用 ≠ 生产里有人实现它 ─────────────────
 * contract.test.ts 数的是【替身】被调用几次。那个计数器在写这个文件之前
 * 已经绿了很久，而生产代码里 `grep -rn "UPDATE approvals" packages/hub/src` 是 0 命中 ——
 * 也就是说「404 不写审计」这条不变量此前只在测试内部成立，
 * 生产路径压根不存在。本文件测的是那份实现本身，跑在【真迁移出来的库】上
 * （同 contract.test.ts / test/budget 的立场：approvals 与 events 的约束
 * —— append-only 触发器、FK、DEFAULT 'pending' —— 只有真 schema 才有）。
 *
 * ── 本文件【测不到】的那一条，先说在这里而不是让别人自己发现 ─────────────
 * makeResumeGraph 真的驱动图（模型被再调用、节点前进）需要 @langchain/langgraph，
 * 本机装不上（0009 §2）。这里能覆盖的是它的【判定与接线】：
 * 给哪个 taskId 建了图、thread_id 传的是什么、选的是 Command 还是 invoke(null)、
 * 外层有没有用事务责任方包住。构造 Command 那一行由注入 makeCommand 替身来验
 * 「走到了这一支」，而不是验「LangGraph 收到 resume 之后做了什么」。
 * 后者【未在本机执行过】，这句在 real-deps.ts 文件头也写着，两处同一口径。
 */
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ResumeValue } from "@opc/contracts";
import type { DomainEvent } from "../../src/events/bus.js";
import { InMemoryEventBus } from "../../src/events/bus.js";
import { migrate } from "../../src/db/migrate.js";
import { chooseResumeInput, hasPendingInterrupt, threadConfig } from "../../src/graph/thread.js";
import {
  applyDecision,
  buildHubDeps,
  CEO_ACTOR,
  insertTask,
  makeResumeGraph,
  STATUS_BY_RESUME,
  type HubWriter,
  type ResumableGraph,
  type TaskGraph,
  type Writer,
} from "../../src/http/real-deps.js";
import { newLocalToken } from "../../src/http/auth.js";

const HUB = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(HUB, ".tmp", "real-deps");

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

const queues: { close: () => Promise<void> }[] = [];
let fileSeq = 0;
const NOW = 1_700_000_000_000;

/**
 * 一份【真 WriteQueue】+ 它的写连接。
 *
 * 为什么测试不再自己 openDb：被测函数收的是队列（applyDecision 的入参类型就是
 * Pick<WriteQueue, "node">），而「自己实现一个 node()、里面不排队」的替身
 * 能让 P1 那类并发缺陷在全测试绿的下面活着。这里用真队列，P1 那条断言才有意义。
 * 断言用的 db 取队列自己的写连接，不再另开一条 —— 两条连接同一库时，
 * 「读不到刚写的那行」会变成夹具问题而不是被测行为。
 */
/** w 直接给 buildHubDeps 用（HubWriter 只多一个 readConnection，队列本身就有）。 */
async function newDb(
  taskId = "task-1",
): Promise<{ db: Db; w: Writer & HubWriter }> {
  const { WriteQueue } = await import("../../src/db/write-queue.js");
  const path = join(TMP, "r-" + process.pid + "-" + ++fileSeq + ".db");
  const q = new WriteQueue(path) as unknown as {
    writeConnection: () => Db;
    close: () => Promise<void>;
    node: Writer["node"];
    readConnection: () => Db;
  };
  queues.push(q);
  const db = q.writeConnection();
  migrate(db as unknown as Parameters<typeof migrate>[0]);
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
      "VALUES (?, ?, 'IN_PROGRESS', 'dev', 'implement', ?, ?)",
  ).run(taskId, "写入路径用的任务", NOW, NOW);
  return { db, w: q as unknown as Writer & HubWriter };
}

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterAll(async () => {
  // 关队列就够了：WriteQueue.close() 负责它自己开的那两条连接（写 + 只读）。
  // 这里不再对 opened 里那两条调 close() —— 那等于替队列关掉它的资源，
  // 队列那边 #closed 还没置上，后续任何调用都会拿到一条已关闭的连接。
  for (const q of queues) {
    try {
      await q.close();
    } catch {
      /* 已关 */
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});

/** 建一张 pending 卡片。status 不传 ⇒ 走 schema 的 DEFAULT 'pending'。 */
function approval(db: Db, id: string, taskId = "task-1", status?: string): void {
  if (status === undefined) {
    db.prepare(
      "INSERT INTO approvals (id, task_id, approval_type, summary, parameters) " +
        "VALUES (?, ?, 'strategic', '一句话摘要', '{}')",
    ).run(id, taskId);
    return;
  }
  db.prepare(
    "INSERT INTO approvals (id, task_id, approval_type, summary, parameters, status) " +
      "VALUES (?, ?, 'strategic', '一句话摘要', '{}', ?)",
  ).run(id, taskId, status);
}

const row = (db: Db, id: string): Row | undefined =>
  db.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
const auditRows = (db: Db, id?: string): Row[] =>
  id === undefined
    ? db.prepare("SELECT * FROM events ORDER BY id").all()
    : db.prepare("SELECT * FROM events WHERE target = ? ORDER BY id").all(id);

/**
 * 取订阅里的下一条，但【必须限时】。
 *
 * 这条不是防御性装饰，是变异测出来的：我第一版直接写 `await it.next()`，
 * 于是把 publish 那一行注释掉（模拟「忘了接线」）之后，本文件不是变红而是【挂住】
 * —— 整整 120 秒被 harness 挪到后台。一条在真实回归下挂住而不报错的测试，
 * 比一条漏测更坏：CI 上看到的是超时，不是「ApprovalDecided 没广播」。
 */
async function nextBounded(
  sub: { [Symbol.asyncIterator](): AsyncIterator<unknown> },
): Promise<unknown> {
  const it = sub[Symbol.asyncIterator]();
  // 取的是 .value：race 赢回来的是 IteratorResult（{value, done}），
  // 直接把它当事件断言的话，断言会去比 {value:…, done:false} 这一层，
  // 于是「收到了」与「收到了什么」混成一个断言 —— 前者恒真。
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("订阅在 2000ms 内没有收到任何事件（= 根本没广播）")),
      2000,
    );
  });
  try {
    const r = (await Promise.race([it.next(), guard])) as IteratorResult<unknown>;
    return r.value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}


/**
 * 广播出口的两种替身。`publish` 现在是【必填】参数（签名处的注释给了理由：
 * 可选参数让「装配时忘了传」变成一个 TS 不响、测试照样绿、只有前端用户看得见的缺陷）。
 * 于是每个调用点都必须【显式】选一个 —— 而「我选择不广播」与「我忘了广播」
 * 在代码上必须长得不一样，这就是这两个名字分开的全部意义。
 *
 * NO_PUBLISH 用在只断言库状态的用例上；publishSpy 用在要断言【不该广播时没广播】的用例上。
 */
const NO_PUBLISH = (): void => {};

function publishSpy(): {
  readonly calls: { e: DomainEvent; seq: number }[];
  readonly fn: (e: DomainEvent, seq: number) => void;
} {
  const calls: { e: DomainEvent; seq: number }[] = [];
  return {
    calls,
    fn: (e: DomainEvent, seq: number): void => {
      calls.push({ e, seq });
    },
  };
}

/* ───────────── ① 决策落库：状态、审计、幂等 ───────────── */

describe("applyDecision 写库", () => {
  it("approve ⇒ approved + 一条 human/ceo 的 approval 审计，target 是卡片 id", async () => {
    const { db, w } = await newDb();
    approval(db, "a-1");
    const applied = await applyDecision(w, {
      approvalId: "a-1",
      taskId: "task-1",
      resume: "approve",
      nowMs: NOW,
    }, NO_PUBLISH);
    expect(applied).toBe(true);

    const r = row(db, "a-1");
    expect(r?.["status"]).toBe("approved");
    expect(r?.["decided_by"]).toBe("ceo");
    expect(r?.["decided_at"]).toBe(NOW);
    expect(r?.["decision_note"]).toBeNull();

    const events = auditRows(db, "a-1");
    expect(events.length).toBe(1);
    const e = events[0] as Row;
    expect(e["actor_type"]).toBe("human");
    expect(e["actor_id"]).toBe("ceo");
    expect(e["action"]).toBe("approval");
    expect(e["task_id"]).toBe("task-1");
    // target 必须是【卡片 id】而不是 status 值：写成 approved 的话，
    // 同一个人对同一张卡片的多次操作（defer 之后再批）在 target 上就分不开了。
    expect(e["target"]).toBe("a-1");
    expect(JSON.parse(String(e["payload"]))).toEqual({ approvalId: "a-1", resume: "approve" });
    // created_at 用注入的 now，而不是 Date.now()：审计时间戳不可测 = 回放顺序不可复现。
    expect(e["created_at"]).toBe(NOW);
    // 没有备注就【不带快照】，而不是写一个 { note: null }：
    // 后者读起来像「他写了空备注」，而事实是「没备注」。
    expect(e["state_snapshot"]).toBeNull();
  });

  it("reject_with_comment ⇒ rejected，note 进 decided_by 那一行的 decision_note 与快照", async () => {
    const { db, w } = await newDb();
    approval(db, "a-2");
    await applyDecision(w, {
      approvalId: "a-2",
      taskId: "task-1",
      resume: "reject_with_comment",
      note: "缺压测数据",
      nowMs: NOW,
    }, NO_PUBLISH);
    // 计划 Task 2.6：「打回必须填理由且理由进入审计」。两半都要钉住：
    // decision_note 是【人看的地方】，state_snapshot 是【回放读的地方】。
    // 只写前者会让回放视图少掉理由，只写后者会让收件箱点开看不到理由。
    expect(row(db, "a-2")?.["status"]).toBe("rejected");
    expect(row(db, "a-2")?.["decision_note"]).toBe("缺压测数据");
    const e = auditRows(db, "a-2")[0] as Row;
    expect(JSON.parse(String(e["state_snapshot"]))).toEqual({ note: "缺压测数据" });
    // 理由【不在】payload 里：payload 存决策本身（回放按它重建卡片状态），
    // note 是决策的附件。混一起之后，payload 加字段时得先区分哪些属于当时的决策。
    expect(JSON.parse(String(e["payload"]))).toEqual({
      approvalId: "a-2",
      resume: "reject_with_comment",
    });
  });

  it("defer_deep_review ⇒ deferred（三段映射逐条验，不抽查）", async () => {
    const { db, w } = await newDb();
    const expect_status: Record<ResumeValue, string> = {
      approve: "approved",
      reject_with_comment: "rejected",
      defer_deep_review: "deferred",
    };
    for (const [resume, want] of Object.entries(expect_status)) {
      const id = "d-" + resume;
      approval(db, id);
      await applyDecision(w, {
        approvalId: id,
        taskId: "task-1",
        resume: resume as ResumeValue,
        nowMs: NOW,
      }, NO_PUBLISH);
      // 这条断言的意义在于【三个都跑】：STATUS_BY_RESUME 是一张表，
      // 抽查一条的话，另两格写错（approve→approved、reject→approved）照样绿。
      expect(row(db, id)?.["status"]).toBe(want);
      expect(STATUS_BY_RESUME[resume as ResumeValue]).toBe(want);
    }
  });

  it("同一张卡片【第二次】⇒ false，且【不写第二条审计】、状态不被覆盖", async () => {
    // 幂等在这里有两个方向，都要钉：审计不重复（append-only 删不掉），
    // 以及【第一次的决定不被覆盖】—— 后者是本文件里唯一一条
    // 「WHERE status = 'pending'」少写了就会红的断言：
    // 没有那个 WHERE，第二次 approve 会把 rejected 改成 approved，
    // 而卡片在库里的历史 status 是【当前值】，看不出它被改过两次。
    const { db, w } = await newDb();
    approval(db, "a-3");
    const spy = publishSpy();
    const first = await applyDecision(w, {
      approvalId: "a-3",
      taskId: "task-1",
      resume: "reject_with_comment",
      note: "缺数据",
      nowMs: NOW,
    }, spy.fn);
    const second = await applyDecision(w, {
      approvalId: "a-3",
      taskId: "task-1",
      resume: "approve",
      nowMs: NOW + 1000,
    }, spy.fn);
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(row(db, "a-3")?.["status"]).toBe("rejected");
    expect(row(db, "a-3")?.["decided_at"]).toBe(NOW);
    expect(auditRows(db, "a-3").length).toBe(1);
    // 没抢到的那一支【也不许广播】：广播了就等于告诉前端「这张卡刚被批掉」，
    // 而库里那次决策根本没落地。更要紧的是 seq —— 那次写入没消费任何 events.id，
    // 广播出去只能带一个【编出来的】seq，而投影层见到 seq > cursor+1 就标 stale（0010 §4）。
    // 所以「库里没写」与「没发事件」必须是同一件事的两个说法。
    expect(spy.calls.length).toBe(1);
  });

  it("审批【不存在】⇒ false，approvals 与 events 一字未动", async () => {
    // 与 handler 层的 404 用例不同的地方：那里断的是「注入点没被调用」，
    // 这里断的是【写实现自己】也不会凭空写出一条审计。
    // 顺序（先 UPDATE 后 appendAudit）就是这条在守的东西。
    const { db, w } = await newDb();
    const spy = publishSpy();
    const applied = await applyDecision(w, {
      approvalId: "ghost",
      taskId: "task-1",
      resume: "approve",
      nowMs: NOW,
    }, spy.fn);
    expect(applied).toBe(false);
    expect(auditRows(db).length).toBe(0);
    // 同上：一条不存在的卡片的决策，既不留审计也不发事件。
    expect(spy.calls.length).toBe(0);
  });

  it("非 pending 的卡片（deferred）仍可被后续决策覆盖，但【只有 pending 时】算首次", async () => {
    // 把上一例的边界【挪一格】：deferred → approved 是允许的（改后再批），
    // 但它【不算首次】⇒ 不写审计。这条防的是「把 WHERE 改成 status <> 'approved'」
    // 那一类看似合理的收紧：它会让改后再批留下第二条审计，回放出现两次决策。
    const { db, w } = await newDb();
    const spy = publishSpy();
    approval(db, "a-4", "task-1", "deferred");
    const applied = await applyDecision(w, {
      approvalId: "a-4",
      taskId: "task-1",
      resume: "approve",
      nowMs: NOW,
    }, spy.fn);
    expect(applied).toBe(false);
    expect(row(db, "a-4")?.["status"]).toBe("deferred");
    expect(auditRows(db).length).toBe(0);
    expect(spy.calls.length).toBe(0);
  });

  it("两个窗口【同时】各批一张卡片 ⇒ 两支都成功、各留一条审计（P1 的现场）", async () => {
    // 这条测的是【写入形状】而不是业务判定，所以它必须跑在真 WriteQueue 上。
    // 复现的缺陷：第一版 applyDecision 收一条连接、自己 txScope，而 txScope 在
    // BEGIN 与 COMMIT 之间 await ⇒ 第二个 BEGIN 落在第一个事务还没结束时，
    // 实测一支 ok、一支抛「cannot start a transaction within a transaction」，
    // 而且 events 只落了 1 行 —— 那一次点击对 CEO 显示成功、库里什么都没发生。
    //
    // 换成队列之后串行化是队列给的，所以这条同时是【别退回裸连接】的守卫：
    // 若有人把入参改回 DatabaseSync 或塞一个不排队的 Writer 替身，这里立刻红。
    const { db, w } = await newDb();
    approval(db, "c-1");
    approval(db, "c-2");
    const both = await Promise.all([
      applyDecision(w, { approvalId: "c-1", taskId: "task-1", resume: "approve", nowMs: NOW }, NO_PUBLISH),
      applyDecision(w, { approvalId: "c-2", taskId: "task-1", resume: "approve", nowMs: NOW }, NO_PUBLISH),
    ]);
    expect(both).toEqual([true, true]);
    expect(row(db, "c-1")?.["status"]).toBe("approved");
    expect(row(db, "c-2")?.["status"]).toBe("approved");
    // 各留一条：两支都写成 ⇒ 两条审计，一条都不能少（少了就是「点了没记」）。
    expect(auditRows(db).length).toBe(2);
  });

  it("决策【提交之后】广播 ApprovalDecided，seq = 那条审计的 events.id", async () => {
    const { db, w } = await newDb();
    approval(db, "p-1");
    // 广播出口用真总线而不是自记数组：总线会校验 seq 必须严格递增且为正整数
    // （bus.ts publishPersisted），自记数组就把这道校验换掉了 —— 而 seq 错
    // 正是前端标 stale、反复重拉快照的直接成因。
    const bus = new InMemoryEventBus();
    const applied = await applyDecision(
      w,
      { approvalId: "p-1", taskId: "task-1", resume: "approve", nowMs: NOW },
      (e, seq) => bus.publishPersisted(e, seq),
    );
    expect(applied).toBe(true);

    const sub = bus.subscribe(0);
    const first = await nextBounded(sub);
    expect(first).toMatchObject({
      kind: "ApprovalDecided",
      taskId: "task-1",
      interruptId: "p-1",
      decision: "approved",
    });
    // seq 必须【就是】审计行的 id：游标体系只能有一套，否则断线重连必漏事件。
    const auditId = (db.prepare("SELECT id FROM events ORDER BY id").all() as Row[])[0]?.["id"];
    expect((first as { seq: number }).seq).toBe(Number(auditId));
    sub.close();
  });

  it("广播【不能在事务里】发：广播那一刻另一条连接已能读到 approved", async () => {
    // 这条是上一例【证不到】的那一半：上一例只验「广播了、seq 对」，
    // 把 publish 挪进 w.node 里（提交之前）它照样绿 —— 因为同连接看得见未提交的行。
    // 所以判据必须换一个【看得见提交、看不见未提交】的位置：队列的只读连接
    // （WAL 下第二条连接读不到未提交数据，这正是 §5.5 分读连接的目的）。
    // 失效形态不是抽象的：前端收到「已批」就去 GET /tasks，而 GET 走的正是
    // 只读连接 ⇒ 它读到 pending ⇒ 界面弹回「待批」，一次点击看起来像没生效。
    const { db, w } = await newDb();
    approval(db, "p-2");
    const seen: string[] = [];
    await applyDecision(
      w,
      { approvalId: "p-2", taskId: "task-1", resume: "approve", nowMs: NOW },
      () => {
        // 只读连接（WriteQueue 自己开的那第二条）。拿写连接读会【恒过】——
        // 同一条连接看得见自己未提交的行，那就退化成「我读我自己刚写的」，
        // 什么也没证明，而且看起来像一条真断言。
        const r = w
          .readConnection()
          .prepare("SELECT status FROM approvals WHERE id = ?")
          .get("p-2") as unknown as Row;
        seen.push(String(r["status"]));
      },
    );
    expect(seen).toEqual(["approved"]);
  });

  it("同一张卡片【并发】点两次 ⇒ 一支 true 一支 false，审计【只有一条】", async () => {
    // 这条测的是【抢同一行】，上面那条测的是【抢不同的行】，两者不重复：
    // 上面那条挡的是「写入形状会让两次点击互相打架」（P1），
    // 这条挡的是「两次点击都自认为抢到了 ⇒ 留下两条 append-only 决策」。
    //
    // 我原本在这里写了一句更强的话：「串行那条挡不住先 SELECT 再 UPDATE，
    // 只有并发这条会红」。**那句没被证实，已删**。实测过程：我照着写了一版
    // 先查再写的变异，它【编译不过】—— 因为 w.node() 的回调必须全同步
    // （回调里一 await，事务就横跨微任务，见 real-deps.ts 的注释），
    // 队列 + 同步回调这两个前提一叠加，「查完被人插一刀」这个窗口在本形状下【不存在】。
    // 所以 WHERE status = 'pending' 在这里是【纵深防御】而不是唯一闸门：
    // 拿掉它，本文件里【三条】断言会红（含两条串行的），不只有这条。
    // 留着它仍然值：队列前提哪天被改动（比如有人给 node() 加了个 await），
    // 它是最后一道还站在库那一侧的防线。
    const { db, w } = await newDb();
    const spy = publishSpy();
    approval(db, "race-1");
    const both = await Promise.all([
      applyDecision(w, { approvalId: "race-1", taskId: "task-1", resume: "approve", nowMs: NOW }, spy.fn),
      applyDecision(w, {
        approvalId: "race-1",
        taskId: "task-1",
        resume: "reject_with_comment",
        note: "另一只手点了打回",
        nowMs: NOW + 1,
      }, spy.fn),
    ]);
    // 一支赢一支输，且【不是两支都成功】也不是【两支都失败】。
    expect(both.filter((x) => x === true).length).toBe(1);
    expect(both.filter((x) => x === false).length).toBe(1);
    // 广播次数与写入次数【同一个数】：输的那一支连一个字节都不该发出去。
    expect(spy.calls.length).toBe(1);
    // 赢的那一支是什么取决于谁先抢到，所以这里【不断言具体是哪个 resume】——
    // 断言具体值会把一条并发测试变成一条时序测试（慢机器上假红）。
    //
    // 但【落库的那一行必须与那条审计同源】，这条与谁赢无关，能钉死：
    // 从审计的 payload 反推出应得的 status 与 note，再去比库里的行。
    // （我第一版在这里写的是「decision_note 里不得出现打回那句」，
    // 那是【错的断言】：打回赢的时候那一行本来就该有那句 ——
    // 一条在正确实现上会随机器时序随机变红的测试，不是守卫，是噪声源。）
    const r = row(db, "race-1");
    const events = auditRows(db, "race-1");
    expect(events.length).toBe(1);
    const payload = JSON.parse(String((events[0] as Row)["payload"])) as {
      resume: string;
    };
    if (payload.resume === "approve") {
      expect(r?.["status"]).toBe("approved");
      expect(r?.["decision_note"]).toBeNull();
    } else {
      expect(r?.["status"]).toBe("rejected");
      expect(r?.["decision_note"]).toBe("另一只手点了打回");
    }
    // 两条路径都只可能有【一条】审计（上面已断），这才是这条测试真正要的性质：
    // 抢输的那一支不得留下任何 append-only 痕迹。
  });

  it("CEO_ACTOR 是 human/ceo，不是 system/hub", async () => {
    // recorder 的默认 actor 是 { system, hub }（图自己停下来时用它）。
    // CEO 点按钮写成 system 的话，审计里【分不清机器做的事和人做的事】——
    // 而「谁批的」正是这套审计存在的理由（§22.1 的 actor_type 三值就是这个用途）。
    expect(CEO_ACTOR).toEqual({ actorType: "human", actorId: "ceo" });
  });
});

/* ───────────── ② 建任务 ───────────── */

describe("insertTask", () => {
  it("落一行 CHARTER_PENDING / intake，时间戳用注入的 now", async () => {
    const { db, w } = await newDb("other-task");
    await insertTask(w, {
      id: "t-new",
      title: "做一个内部看板",
      assignedRole: "intake",
      nowMs: NOW,
    });
    const r = db.prepare("SELECT * FROM tasks WHERE id = ?").get("t-new") as Row;
    expect(r["status"]).toBe("CHARTER_PENDING");
    expect(r["current_node"]).toBe("intake");
    expect(r["assigned_role"]).toBe("intake");
    expect(r["parent_id"]).toBeNull();
    expect(r["created_at"]).toBe(NOW);
    expect(r["updated_at"]).toBe(NOW);
    // 建任务【不写审计】：CHARTER_PENDING 是初始状态不是跃迁（company.ts 的 intake
    // 注释），第一条边由 charter 节点写、自带审计。这里钉的是「别顺手加一条」。
    expect(auditRows(db).length).toBe(0);
  });

  it("parent_id 不存在 ⇒ 抛（FK 挡住），且不留下半行", async () => {
    const { db, w } = await newDb();
    await expect(
      insertTask(w, {
        id: "orphan",
        title: "孤儿",
        parentId: "no-such-parent",
        assignedRole: "intake",
        nowMs: NOW,
      }),
    ).rejects.toThrow(/FOREIGN KEY|foreign key/u);
    expect(db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE id = ?").get("orphan")).toEqual({
      c: 0,
    });
  });

  it("parent_id 存在 ⇒ 落库（FK 不误伤正当用法）", async () => {
    const { db, w } = await newDb();
    await insertTask(w, {
      id: "child",
      title: "子任务",
      parentId: "task-1",
      assignedRole: "intake",
      nowMs: NOW,
    });
    expect(
      (db.prepare("SELECT parent_id FROM tasks WHERE id = ?").get("child") as Row)["parent_id"],
    ).toBe("task-1");
  });

  it("【完整想法落库后查不到】—— 把这条缺口写成断言而不是误会", async () => {
    // titleOf 折首行 + 截断（app.ts），截断处留省略号。
    // 我没加审计事件存全文：AUDIT_ACTIONS 十个值没有一个语义是「登记任务」，
    // 而 events.action 是 append-only 枚举，加值 = 改规格 §22.1。
    // 所以全文确实【只存在于那一次 HTTP 请求里】。这条断言不测任何功能，
    // 它测的是「这个缺口还在」—— 下一个人若以为某处存了全文，这里会告诉他没有。
    const { db, w } = await newDb();
    const long = "首行标题\n" + "x".repeat(5000);
    await insertTask(w, {
      id: "t-long",
      title: long.split("\n")[0] as string,
      assignedRole: "intake",
      nowMs: NOW,
    });
    const r = db.prepare("SELECT title FROM tasks WHERE id = ?").get("t-long") as Row;
    expect(String(r["title"])).toBe("首行标题");
    const hits = db
      .prepare("SELECT COUNT(*) AS c FROM events WHERE payload LIKE ?")
      .all("%" + "x".repeat(100) + "%") as { c: number }[];
    expect(hits[0]?.c).toBe(0);
  });
});

/* ───────────── ③ 恢复选路：判定与接线（不含真图执行） ───────────── */

describe("threadConfig / 恢复判定", () => {
  it("thread_id 恒等于 task_id，且没有第二个入口", () => {
    expect(threadConfig("t-9")).toEqual({ configurable: { thread_id: "t-9" } });
  });

  it("chooseResumeInput 两支都验（不抽查）", () => {
    expect(chooseResumeInput(true)).toBe("command");
    expect(chooseResumeInput(false)).toBe("invoke-null");
  });

  it("hasPendingInterrupt：空数组 = 无中断，非空 = 有", () => {
    expect(hasPendingInterrupt({ interrupts: [] })).toBe(false);
    expect(hasPendingInterrupt({ interrupts: [{ id: "i" }] })).toBe(true);
    // getState 还没跑到任何超步时可能压根没有这个键 ⇒ 视为无中断（走 invoke(null)）。
    expect(hasPendingInterrupt({})).toBe(false);
  });

  it("形状不认识就【抛】，不静默当成「没有中断」", () => {
    // 静默 false 的后果：批准之后走 invoke(null) ⇒ 只推进一个空超步，
    // events 不增、节点不跑、HTTP 返回 200、卡片显示已批准。
    // 这一条与 audit-middleware.ts 的 detectInterrupts 同一条立场。
    expect(() => hasPendingInterrupt(null)).toThrow(/不是对象/u);
    expect(() => hasPendingInterrupt("[]")).toThrow(/不是对象/u);
    expect(() => hasPendingInterrupt({ interrupts: { 0: { id: "i" } } })).toThrow(/不是数组/u);
  });
});

/** 一个记账用的假图：记录每次调用的坐标与输入，返回可控的 interrupts。 */
function fakeGraph(state: Record<string, unknown>): {
  graph: ResumableGraph;
  calls: { state: unknown[]; inputs: unknown[]; configs: unknown[] };
} {
  const calls: { state: unknown[]; inputs: unknown[]; configs: unknown[] } = {
    state: [],
    inputs: [],
    configs: [],
  };
  return {
    calls,
    graph: {
      getState: async (cfg) => {
        calls.configs.push(cfg);
        calls.state.push(state);
        return state;
      },
      invoke: async (input, cfg) => {
        calls.inputs.push(input);
        calls.configs.push(cfg);
        return {};
      },
    },
  };
}

describe("makeResumeGraph 的接线", () => {
  it("按【这个 taskId】取图，thread_config 用的也是它", async () => {
    // 这条是【那条 bug 的钉子】：buildCompanyGraph 把 taskId 烧进节点体，
    // 所以一张编译好的图只服务一条任务。若装配方图省事共享一张图，
    // checkpoint 按 B 的 thread_id 读写（看着完全正常）、节点里的
    // INSERT/UPDATE 与审计 task_id 全落在 A 上 —— 两处各自都自洽。
    // 现在 graphFor 是按任务调的，且这条断言钉住【它收到的是哪个 id】。
    const seen: string[] = [];
    const g = fakeGraph({ interrupts: [{ id: "i-1" }] });
    const resume = makeResumeGraph({
      graphFor: (taskId) => {
        seen.push(taskId);
        return { graph: g.graph, invoke: async (fn) => await fn() };
      },
      makeCommand: () => ({ __command: true }),
    });
    await resume("task-B");
    expect(seen).toEqual(["task-B"]);
    expect(g.calls.configs).toEqual([
      { configurable: { thread_id: "task-B" } },
      { configurable: { thread_id: "task-B" } },
    ]);
  });

  it("有中断 ⇒ 喂 Command 替身；无中断 ⇒ 喂 null", async () => {
    const withInterrupt = fakeGraph({ interrupts: [{ id: "i" }] });
    const made: unknown[] = [];
    await makeResumeGraph({
      graphFor: (): TaskGraph => ({
        graph: withInterrupt.graph,
        invoke: async (fn) => await fn(),
      }),
      makeCommand: (resume) => {
        made.push(resume);
        return { __command: true };
      },
    })("t-1");
    expect(made).toEqual([null]);
    expect(withInterrupt.calls.inputs).toEqual([{ __command: true }]);

    const idle = fakeGraph({ interrupts: [] });
    await makeResumeGraph({
      graphFor: (): TaskGraph => ({
        graph: idle.graph,
        invoke: async (fn) => await fn(),
      }),
      makeCommand: () => {
        throw new Error("无中断时不该构造 Command");
      },
    })("t-2");
    expect(idle.calls.inputs).toEqual([null]);
  });

  it("graph.invoke 被【事务责任方】包住，而不是裸调", async () => {
    // recorder.record() 要求处在超步事务作用域内，那个事务由 auditor.invoke
    // (= recorder.run) 开。裸调图会撞上「record() 丢失了事务作用域」。
    // 这条断言的形状：外层进出有序 —— invoke 开始 ⇒ graph.invoke ⇒ 外层结束。
    const trace: string[] = [];
    const g = fakeGraph({ interrupts: [] });
    const graph: ResumableGraph = {
      getState: g.graph.getState,
      invoke: async (input, cfg) => {
        trace.push("graph.invoke");
        return g.graph.invoke(input, cfg);
      },
    };
    await makeResumeGraph({
      graphFor: (): TaskGraph => ({
        graph,
        invoke: async (fn) => {
          trace.push("runner:begin");
          const out = await fn();
          trace.push("runner:end");
          return out;
        },
      }),
    })("t-3");
    expect(trace).toEqual(["runner:begin", "graph.invoke", "runner:end"]);
  });

  it("getState 形状不对 ⇒ 在【调图之前】就抛（不拿错输入去跑图）", async () => {
    // 「先抛」比「跑下去再炸」便宜：跑下去会真的发起模型调用（计费），
    // 而且用的是一个选错的输入。
    const g = fakeGraph({ interrupts: "坏形状" });
    let invoked = 0;
    await expect(
      makeResumeGraph({
        graphFor: (): TaskGraph => ({
          graph: {
            getState: g.graph.getState,
            invoke: async (i, c) => {
              invoked += 1;
              return g.graph.invoke(i, c);
            },
          },
          invoke: async (fn) => await fn(),
        }),
      })("t-4"),
    ).rejects.toThrow(/不是数组/u);
    expect(invoked).toBe(0);
  });
});

/* ───────────── ④ 装配：HubDeps 的生产来源 ───────────── */

describe("buildHubDeps", () => {
  it("装配出来的三个注入点【真的写库】（不是替身）", async () => {
    // 这条是本文件的收口：前面各例测的是零件，这一条测的是
    // 「HTTP 层调 deps.recordDecision 之后，库里【确实】多了那一行审批与那条审计」。
    // 写这个文件之前，HubDeps 的唯一来源是两个测试文件里的手搓字面量。
    const { db, w } = await newDb();
    approval(db, "w-1");
    const g = fakeGraph({ interrupts: [{ id: "i" }] });
    const deps = buildHubDeps({
      queue: w,
      bus: new InMemoryEventBus(),
      token: newLocalToken(),
      graphFor: (): TaskGraph => ({ graph: g.graph, invoke: async (fn) => await fn() }),
      now: () => NOW,
      makeCommand: () => ({ __command: true }),
    });

    expect(
      await deps.recordDecision({ approvalId: "w-1", taskId: "task-1", resume: "approve" }),
    ).toBe(true);
    expect(row(db, "w-1")?.["status"]).toBe("approved");
    expect(auditRows(db, "w-1").length).toBe(1);

    await deps.createTask({ id: "w-task", title: "从装配入口建的", nowMs: NOW });
    expect(
      (db.prepare("SELECT status FROM tasks WHERE id = ?").get("w-task") as Row)["status"],
    ).toBe("CHARTER_PENDING");
    // intakeRole 的默认值与图里 intake 节点同一口径；传了就听传的。
    expect(
      (db.prepare("SELECT assigned_role FROM tasks WHERE id = ?").get("w-task") as Row)[
        "assigned_role"
      ],
    ).toBe("intake");

    await deps.resumeGraph("task-1");
    expect(g.calls.inputs).toEqual([{ __command: true }]);
  });

  it("now 注入贯穿【审批时间戳与审计 created_at】（同一个值）", async () => {
    // 两处时间戳必须同源。各调一次 Date.now() 的话，同一毫秒边界上会出现
    // decided_at 与审计 created_at 差 1ms，回放按 created_at 排完序再去 join
    // approvals 就会得出「审计早于决策」这种无从解释的顺序。
    let tick = 1_600_000_000_000;
    const { db, w } = await newDb();
    approval(db, "w-2");
    const deps = buildHubDeps({
      queue: w,
      bus: new InMemoryEventBus(),
      token: newLocalToken(),
      graphFor: () => ({ graph: fakeGraph({}).graph, invoke: async (fn) => await fn() }),
      now: () => ++tick,
    });
    await deps.recordDecision({ approvalId: "w-2", taskId: "task-1", resume: "approve" });
    const decided = row(db, "w-2")?.["decided_at"];
    const created = auditRows(db, "w-2")[0]?.["created_at"];
    expect(decided).toBe(created);
  });
});
