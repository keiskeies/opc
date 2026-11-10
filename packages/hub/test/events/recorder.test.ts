import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertParamCount } from "../../src/db/write-queue.js";
import type {
  DomainEvent,
  EventBus,
  EventSubscription,
  FeedItem,
} from "../../src/events/bus.js";
import {
  AUDIT_ACTIONS,
  AuditRecorder,
  type AuditRow,
  appendAudit,
  eventParams,
  INSERT_EVENT_SQL,
  KIND_TO_ACTION,
  type RecorderOptions,
  type StepTx,
  serializePayload,
} from "../../src/events/recorder.js";

/* ----------------------------- 测试脚手架 ----------------------------- */

/** 与 0001_init.sql 同构的最小 events 表（NOT NULL 保留，约束要真生效）。 */
const EVENTS_DDL = [
  "CREATE TABLE events (",
  "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  task_id TEXT,",
  "  actor_type TEXT NOT NULL,",
  "  actor_id TEXT NOT NULL,",
  "  action TEXT NOT NULL,",
  "  target TEXT,",
  "  payload TEXT NOT NULL,",
  "  state_snapshot TEXT,",
  "  created_at INTEGER NOT NULL",
  ");",
].join("\n");

let dir: string;
const dbs: DatabaseSync[] = [];
const files: string[] = [];
const openDb = (): DatabaseSync => {
  const file = join(dir, "ev-" + dbs.length + ".db");
  files.push(file);
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(EVENTS_DDL);
  dbs.push(db);
  return db;
};
/**
 * 用【另一个连接】读已提交内容 —— 用来鉴别「是否真的 COMMIT 了」。
 *
 * 为什么必须换连接：SQLite 里一个连接总是看得见自己未提交的写入。拿写连接去
 * rows(db) 断言「事件已落库」，即使 COMMIT 从未发生也照样读到 —— 那个断言对
 * 提交时机毫无区分力。换一个连接，读到的就只是最后一次已提交的快照。
 */
const committed = (index: number): Record<string, unknown>[] => {
  const file = files[index];
  if (file === undefined)
    throw new Error("没有第 " + index + " 个库文件（先 openDb 再取索引）");
  const other = new DatabaseSync(file, { readOnly: true });
  try {
    return other
      .prepare("SELECT id, task_id FROM events ORDER BY id")
      .all() as Record<string, unknown>[];
  } finally {
    other.close();
  }
};

const rows = (db: DatabaseSync): Record<string, unknown>[] =>
  db.prepare("SELECT * FROM events ORDER BY id").all() as Record<
    string,
    unknown
  >[];

/** 假总线：只记 publish 的 seq 与顺序。 */
class FakeBus implements EventBus {
  readonly published: (DomainEvent & { seq: number })[] = [];
  publishPersisted(e: DomainEvent, seq: number): void {
    this.published.push({ ...e, seq });
  }
  subscribe(): EventSubscription {
    return {
      startSeq: undefined,
      dropped: () => 0,
      close: () => {},
      [Symbol.asyncIterator]: () => ({
        next: async () =>
          ({
            value: undefined as never as FeedItem,
            done: true,
          }) as IteratorResult<FeedItem>,
      }),
    };
  }
  latestSeq(): number {
    const last = this.published.at(-1);
    return last ? last.seq : 0;
  }
}

/**
 * 假事务：真实 db + 真实 BEGIN/COMMIT，只用 ALS 模拟作用域。
 * calls 用来断言【时序】—— 顺序错了同事务保证就没了。
 */
class FakeTx implements StepTx {
  readonly calls: string[] = [];
  readonly als = new AsyncLocalStorage<{ db: DatabaseSync }>();
  /** 活动事务标志：与 ALS 作用域【分开】维护，理由见 StepTx.inTx 的注释。 */
  #open = false;
  constructor(readonly conn: DatabaseSync) {}
  async begin(): Promise<void> {
    this.calls.push("begin");
    this.conn.exec("BEGIN IMMEDIATE");
    this.#open = true;
  }
  async commit(): Promise<void> {
    this.calls.push("commit");
    this.conn.exec("COMMIT");
    this.#open = false;
  }
  async rollback(): Promise<void> {
    this.calls.push("rollback");
    try {
      this.conn.exec("ROLLBACK");
    } catch {
      /* 事务可能已被 SQLite 自己中止 */
    }
    this.#open = false;
  }
  scope<T>(fn: () => Promise<T>): Promise<T> {
    return this.als.run({ db: this.conn }, fn);
  }
  inTx(): boolean {
    return this.#open;
  }
  db(): DatabaseSync {
    const s = this.als.getStore();
    if (s === undefined) {
      throw new Error("SCOPE-MISS：FakeTx 作用域里没有连接");
    }
    return s.db;
  }
}

/**
 * 默认造一个 TaskStateChanged，再整体覆盖字段。
 *
 * 参数类型【不能】写 Partial<DomainEvent>：TS 会把 union 拆成各分支可选字段的
 * 交叉形状（kind 变成 "TaskStateChanged" | "ReviewDecided"，同时要求 from/to），
 * 那种形状在运行时根本不存在。这里刻意放宽到 kind + 任意字段，代价是漏字段
 * 不会在编译期报错 —— 换来的是断言全部打在【真实落库的列】上，比类型体操更值。
 */
/** 一条合法审计行，供参数自检用例复用。 */ const ROW_OK: AuditRow = {
  taskId: "T-X",
  actorType: "agent",
  actorId: "producer",
  action: "state_change",
  target: "draft->review",
  payload: { a: 1 },
};
const evt = (
  over: { kind?: DomainEvent["kind"] } & Record<string, unknown> = {},
): DomainEvent =>
  ({
    kind: "TaskStateChanged",
    taskId: "T-9",
    from: "draft",
    to: "review",
    ...over,
  }) as DomainEvent;

const make = (db: DatabaseSync, over: Partial<RecorderOptions> = {}) => {
  const tx = new FakeTx(db);
  const bus = new FakeBus();
  const clock = 1700000000000;
  const rec = new AuditRecorder({
    tx,
    bus,
    now: () => clock,
    actor: { actorType: "agent", actorId: "producer" },
    ...over,
  });
  return { tx, bus, rec };
};

/* -------------------------- serializePayload -------------------------- */

describe("payload 序列化（events.payload NOT NULL 且必须是合法 JSON）", () => {
  it("普通对象转 JSON 字符串", () => {
    expect(serializePayload({ a: 1 })).toBe('{"a":1}');
  });

  it("undefined 落成 null 字面量：NOT NULL 列不能塞 JS 的 null", () => {
    // 为什么不能干脆不写：payload 声明 NOT NULL，而回放视图一律 JSON.parse(payload)。
    expect(serializePayload(undefined)).toBe("null");
    expect(serializePayload(null)).toBe("null");
  });

  it("裸文本必须被拒（回放会炸），合法 JSON 字符串原样通过", () => {
    expect(() => serializePayload("已完成")).toThrow(/JSON/);
    expect(serializePayload('{"ok":true}')).toBe('{"ok":true}');
  });

  it("循环引用当场抛错，不退化成字符串", () => {
    const cyc: Record<string, unknown> = { name: "root" };
    cyc.self = cyc;
    // 断消息：包装后的措辞讲清「宁可抛错也不写伪证」。裸 TypeError 也能让
    // toThrow() 通过 —— 只断「抛不抛」就把这条规则的表达丢了。
    expect(() => serializePayload(cyc)).toThrow(/无法序列化成 JSON/);
  });

  it("JSON.stringify 结果为 undefined 的类型也落成 null 字面量", () => {
    // JSON.stringify(Symbol()) 与函数都返回 undefined（不是字符串）。不兜底就会
    // 把 JS 的字面量 undefined 送进 NOT NULL 的 JSON 列 —— 那不是合法 JSON。
    expect(serializePayload(Symbol("x"))).toBe("null");
    expect(serializePayload(() => 1)).toBe("null");
    // 且必须【能被 parse 回来】才算数
    expect(JSON.parse(serializePayload(Symbol("y")))).toBeNull();
  });
});

/* ----------------------------- SQL 组装 ------------------------------- */

describe("events 插入语句与参数", () => {
  it("INSERT_EVENT_SQL：8 个匿名问号、单语句", () => {
    expect((INSERT_EVENT_SQL.match(/\?/gu) ?? []).length).toBe(8);
    expect(INSERT_EVENT_SQL.includes(";")).toBe(false);
    expect(INSERT_EVENT_SQL.startsWith("INSERT INTO events")).toBe(true);
  });

  it("eventParams 长度必须等于占位符数（少绑会被 SQLite 静默写成 NULL）", () => {
    const row: AuditRow = {
      taskId: "T-1",
      actorType: "agent",
      actorId: "producer",
      action: "state_change",
      target: "draft->review",
      payload: { from: "draft" },
      createdAt: 123,
    };
    const p = eventParams(row, () => 999);
    expect(p.length).toBe(8);
    expect(p[0]).toBe("T-1");
    expect(p[1]).toBe("agent");
    expect(p[2]).toBe("producer");
    expect(p[3]).toBe("state_change");
    expect(p[4]).toBe("draft->review");
    expect(p[5]).toBe('{"from":"draft"}');
    expect(p[6]).toBeNull();
    expect(p[7]).toBe(123);
    // 不写 createdAt 才合法：exactOptionalPropertyTypes 下 `createdAt: undefined` 会被拒
    const noCreated: AuditRow = {
      taskId: "T-1",
      actorType: "agent",
      actorId: "producer",
      action: "state_change",
      target: "draft->review",
      payload: { from: "draft" },
    };
    expect(eventParams(noCreated, () => 42)[7]).toBe(42);
  });

  it("kind 到 action 的映射覆盖全部 8 个 kind，且值都在 §22.1 枚举内", () => {
    // 6 → 7：实现侧加了 ApprovalDecided（CEO 批完一张卡片这件事，规格 §5.8 那张
    // 六行表里【没有】）。改这个数是【有意偏离规格】的一处，偏离的理由、
    // 丢掉的东西与「为什么不能靠随后的 TaskStateChanged 代替」记在
    // docs/decisions/0010；这一行不是把守卫改松，它仍然要求【逐个 kind】有 action。
    //
    // 7 → 8：Task 4.1 加 ApprovalTokenRedeemed。⚠ 这一次改数的【理由不是「要加个 kind」】，
    // 值得单独记一句，因为「把常量 +1」这个动作本身是零成本的：
    // redeemToken 必须留一行 events（im_tokens 没有 used_at 那一列），
    // 而 events.id 就是 SSE 的 seq —— 写了不 publish 就是【消费了一个 seq 而没送出去】，
    // 活着的订阅会撞见空洞并把 link 标成 stale（0010 §4）。
    // 也就是说【每一次远程批准都会把连接标脏一次】。
    // 所以「加这个 kind」不是想让界面看到什么，是【那一行 events 逼出来的】：
    // 要么广播它，要么不写它，而「不写」会让凭据消费查无此刻。
    // 记这一条是因为将来有人问「这个 kind 有谁在渲染吗？没有就删了吧」——
    // 答案是【没有消费者，而它仍然不能删】。
    const kinds = Object.keys(KIND_TO_ACTION);
    expect(kinds.length).toBe(8);
    for (const k of kinds) {
      const action = KIND_TO_ACTION[k as keyof typeof KIND_TO_ACTION];
      expect((AUDIT_ACTIONS as readonly string[]).includes(action)).toBe(true);
    }
    expect(KIND_TO_ACTION.TaskStateChanged).toBe("state_change");
    expect(KIND_TO_ACTION.ReviewDecided).toBe("review_decision");
    expect(KIND_TO_ACTION.ApprovalRequired).toBe("approval");
    // 【两条 approval 类事件共用一个 action】，这是刻意的而不是偷懒：
    // §22.1 的枚举里只有一个 approval 值，而 events.action 是 append-only 枚举，
    // 不能为了实现方便加第 11 个值。二者在【库里的区分】靠 actor_type：
    // ApprovalRequired 是 system/hub（图停下来），ApprovalDecided 是 human/ceo（人点了）。
    expect(KIND_TO_ACTION.ApprovalDecided).toBe("approval");
    // 第三条共用 'approval' 的。三条共用一个 action 而库里的区分靠 payload.kind，
    // 于是【role-memory 那道「只把决定当记忆」的过滤必须逐条认领 kinds】——
    // 它漏认一条的后果不是崩，是那条事件被当成一次伪决定进 few-shot，静默且长期。
    // 这条耦合在 tokens.ts / role-memory.ts 两边各写了注释，而注释挡不住漏；
    // 真正挡着的是 memory/role-memory.test.ts 里那条专门喂 ApprovalTokenRedeemed 的用例。
    expect(KIND_TO_ACTION.ApprovalTokenRedeemed).toBe("approval");
    expect(KIND_TO_ACTION.BudgetPaused).toBe("budget_consume");
    expect(KIND_TO_ACTION.MeetingSummaryReady).toBe("meeting");
    expect(KIND_TO_ACTION.HeartbeatStalled).toBe("escalation");
  });

  it("每类事件的 target 取自该事件最有信息量的字段", async () => {
    const db = openDb();
    const { rec, tx } = make(db);
    await tx.begin();
    await tx.scope(async () => {
      await rec.record(evt({ from: "draft", to: "review" }), { taskId: "T1" });
      await rec.record(
        evt({
          kind: "ReviewDecided",
          taskId: "T1",
          gate: "qa-gate",
          decision: "pass",
        }),
      );
      await rec.record(
        evt({
          kind: "ApprovalRequired",
          taskId: "T1",
          interruptId: "int-7",
          payload: {},
        }),
      );
      await rec.record(
        evt({ kind: "BudgetPaused", taskId: "T1", spentUsdCents: 950 }),
      );
      await rec.record(
        evt({ kind: "MeetingSummaryReady", taskId: "T1", meetingId: "m-3" }),
      );
      await rec.record(
        evt({ kind: "HeartbeatStalled", taskId: "T1", node: "developer" }),
      );
    });
    await tx.commit();
    expect(rows(db).map((r) => String(r.target))).toEqual([
      "draft->review",
      "qa-gate",
      "int-7",
      "T1",
      "m-3",
      "developer",
    ]);
    expect(rows(db).map((r) => String(r.action))).toEqual([
      "state_change",
      "review_decision",
      "approval",
      "budget_consume",
      "meeting",
      "escalation",
    ]);
  });
});

/* ---------------------------- appendAudit ----------------------------- */

describe("appendAudit：在当前事务里写一行", () => {
  it("返回自增 id，各列落库正确", () => {
    const db = openDb();
    db.exec("BEGIN IMMEDIATE");
    const id = appendAudit(
      db,
      {
        taskId: "T-1",
        actorType: "human",
        actorId: "ceo",
        action: "approval",
        target: "int-1",
        payload: { approved: true },
        createdAt: 555,
      },
      () => 111,
    );
    db.exec("COMMIT");
    expect(id).toBe(1);
    expect(rows(db)[0]).toMatchObject({
      task_id: "T-1",
      actor_type: "human",
      actor_id: "ceo",
      action: "approval",
      payload: '{"approved":true}',
      created_at: 555,
    });
  });

  it("taskId / target / state_snapshot 允许 NULL（系统级事件不挂任务）", () => {
    const db = openDb();
    db.exec("BEGIN IMMEDIATE");
    appendAudit(
      db,
      {
        taskId: null,
        actorType: "system",
        actorId: "hub",
        action: "tool_call",
        target: null,
        payload: null,
      },
      () => 777,
    );
    db.exec("COMMIT");
    expect(rows(db)[0]).toMatchObject({
      task_id: null,
      target: null,
      state_snapshot: null,
      created_at: 777,
    });
  });

  it("actor_id 为空或纯空白必须被拒：审计缺了「谁干的」就无法问责", () => {
    const db = openDb();
    db.exec("BEGIN IMMEDIATE");
    for (const bad of ["", "   ", "\t"]) {
      expect(() =>
        appendAudit(db, { ...ROW_OK, actorId: bad }, () => 1700000000000),
      ).toThrow(/actor_id/);
    }
    // 一行都没落才算守住：审计库里留下一条匿名事件比抛错更糟 —— append-only
    // 触发器挡住 UPDATE/DELETE，脏行只能永远留在库里。
    expect(rows(db).length).toBe(0);
    // undefined 走同一条守卫（AuditRow 里 actorId 必填，这里绕给运行期看）
    const noActor = { ...ROW_OK } as Record<string, unknown>;
    delete noActor.actorId;
    expect(() =>
      appendAudit(db, noActor as unknown as AuditRow, () => 1700000000000),
    ).toThrow(/actor_id/);
    db.exec("ROLLBACK");
    expect(rows(db).length).toBe(0);
  });

  it("非法 action 必须被拒（枚举一旦污染就无法回收）", () => {
    const db = openDb();
    db.exec("BEGIN IMMEDIATE");
    expect(() =>
      appendAudit(
        db,
        {
          taskId: null,
          actorType: "system",
          actorId: "hub",
          action: "随便写" as never,
          target: null,
          payload: {},
        },
        () => 1,
      ),
    ).toThrow(/action/);
    db.exec("ROLLBACK");
  });
});

/* --------------------- 同一事务与回滚（规格 §6.3） --------------------- */

describe("同一事务：节点失败则该节点 events 增量为 0", () => {
  it("事务回滚后 events 行数增量为 0", async () => {
    const db = openDb();
    const { rec, bus } = make(db);
    let boom = false;
    try {
      await rec.run(async () => {
        await rec.record(evt());
        throw new Error("节点炸了");
      });
    } catch {
      boom = true;
    }
    expect(boom).toBe(true);
    expect(rows(db).length).toBe(0);
    // 幽灵事件：库里没有、前端却收到投影，是最难查的一类不一致
    expect(bus.published.length).toBe(0);
  });

  it("失败只回滚【当前超步】，上一超步已提交的事件保留", async () => {
    const db = openDb();
    const { rec, tx } = make(db);
    await tx.begin();
    await tx.scope(async () => {
      await rec.record(evt({ taskId: "T-A" }));
    });
    await tx.commit();
    expect(rows(db).length).toBe(1);
    await tx.begin();
    let caught = false;
    try {
      await tx.scope(async () => {
        await rec.record(evt({ taskId: "T-B" }));
        throw new Error("第二个超步炸了");
      });
    } catch {
      caught = true;
      await tx.rollback();
    }
    expect(caught).toBe(true);
    expect(rows(db).length).toBe(1);
    expect(rows(db)[0]?.task_id).toBe("T-A");
  });

  it("record 在事务外调用必须抛错（不许静默 autocommit）", async () => {
    const db = openDb();
    const { rec } = make(db);
    // 只认第一道守卫【独有】的词 autocommit。第二道守卫的消息里同样含 onStepStart，
    // 这里若认 onStepStart，删掉第一道守卫后第二道会用同一关键词顶上 —— 变异 M10 就是这么存活的。
    await expect(rec.record(evt())).rejects.toThrow(/autocommit/);
    expect(rows(db).length).toBe(0);
  });

  it("广播必须在 COMMIT 【完成之后】（探针打在 commit 前后，不是返回之后）", async () => {
    // 只在 onStepStart() 返回之后断言是【没用】的：把 flush 挪到 commit 之前，返回后
    // 看起来一模一样，但中途广播出去的 seq 指向一个尚未提交、甚至会被回滚的行 ——
    // 前端按游标去 REST 取取不到，而游标已前进，永不自我纠正。
    const db = openDb();
    const { rec, bus, tx } = make(db);
    const real = tx.commit.bind(tx);
    const snaps: number[] = [];
    tx.commit = async () => {
      snaps.push(bus.published.length); // 真实 COMMIT 之前
      await real();
      snaps.push(bus.published.length); // COMMIT 完成、recorder 尚未 flush
    };
    await rec.run(async () => {
      await rec.record(evt({ taskId: "T1" }));
      await rec.onStepStart(); // 第 1 次 commit
      await rec.record(evt({ taskId: "T2" }));
    }); // run 收尾第 2 次 commit
    // 第 1 次 [0,0]：提交前后都没广播。第 2 次 [1,1]：T1 已广播、T2 仍未广播。
    // flush 若在 onStepStart 里被提前 => 变 [1,x,2,x]；若在 run 收尾被提前 => 第 2 次变 [2,2]。
    expect(snaps).toEqual([0, 0, 1, 1]);
    expect(bus.published.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("事务活动但不在作用域内：record 被拒，而收尾仍能提交（两个谓词不可合并）", async () => {
    const db = openDb();
    const { rec, tx } = make(db);
    await tx.begin(); // 事务是活动的，但 ALS 作用域没开
    expect(tx.inTx()).toBe(true);
    // 这一段命中【第二道】守卫（事务活动、作用域缺失）：inTx() 放行，db() 拦下。
    // recorder 对这种状态有自己的措辞，所以这里认「作用域丢失」；
    // 上一段（无事务）认「onStepStart」。两条措辞互斥 —— 删掉任一道守卫，对应那条就红。
    await expect(rec.record(evt())).rejects.toThrow(/丢失了事务作用域/);
    // 收尾路径（scope 之外）必须仍能 commit。若 inTx() 被实现成「在不在作用域里」，
    // 这里会被静默跳过，事件永远不落 —— 不报错、不崩溃，只是数据不见了。
    await tx.commit();
    expect(tx.inTx()).toBe(false);
    await tx.begin();
    await tx.scope(async () => {
      await rec.record(evt({ taskId: "T-C" }));
    });
    await tx.commit();
    expect(rows(db).map((x) => x.task_id)).toEqual(["T-C"]);
  });

  it("run 嵌套 run 直接拒绝（谁负责 COMMIT 不能有两个答案）", async () => {
    const db = openDb();
    const { rec } = make(db);
    await expect(
      rec.run(async () => {
        await rec.run(async () => await rec.record(evt()));
      }),
    ).rejects.toThrow(/嵌套/);
  });

  it("时序：成功是 begin 到 commit，异常是 begin 到 rollback", async () => {
    const a = make(openDb());
    await a.rec.run(async () => {
      await a.rec.record(evt());
    });
    expect(a.tx.calls).toEqual(["begin", "commit"]);
    const b = make(openDb());
    await expect(
      b.rec.run(async () => {
        await b.rec.record(evt());
        throw new Error("x");
      }),
    ).rejects.toThrow("x");
    expect(b.tx.calls).toEqual(["begin", "rollback"]);
  });
});

/* --------------------------- 提交后才发布 ------------------------------ */

describe("seq = events.id，且只在提交后广播", () => {
  it("record 返回的 id 与总线收到的 seq 相同（游标体系只有一套）", async () => {
    const db = openDb();
    const { rec, bus } = make(db);
    let id = 0;
    await rec.run(async () => {
      id = await rec.record(evt());
      expect(bus.published.length).toBe(0); // 提交前不得广播
    });
    expect(id).toBe(1);
    expect(bus.latestSeq()).toBe(1);
    expect(bus.published[0]?.seq).toBe(id);
  });

  it("onStepStart 提交【上一超步】并在那一刻广播，作用域跨事务边界不变", async () => {
    // 这是「按超步滚动事务」机制的唯一定义性测试（0003 §3.2、规格 §6.3）：
    // 上一超步必须在新超步开始时就已提交，否则崩溃恢复会重放整段 invoke。
    const db = openDb();
    const { rec, bus } = make(db);
    const dbIndex = dbs.length - 1;
    await rec.run(async () => {
      await rec.record(evt({ taskId: "T1" }));
      expect(bus.published.length).toBe(0);
      // 换连接读：此刻应【读不到】—— 还没提交
      expect(committed(dbIndex).length).toBe(0);

      await rec.onStepStart();

      // 提交的那一刻才广播（不是 record 时，也不是 run 收尾时）
      expect(bus.published.map((e) => e.seq)).toEqual([1]);
      // 换连接读得到 = 真的 COMMIT 了，不是「写连接自己看得见自己」
      expect(committed(dbIndex).map((x) => x.task_id)).toEqual(["T1"]);

      // ALS 作用域跨事务边界【保持不变】：commit + begin 之后节点仍能 record。
      // 「事务滚动」与「作用域滚动」是两件事（decisions/0005）。
      const second = await rec.record(evt({ taskId: "T2" }));
      expect(second).toBe(2); // AUTOINCREMENT 连续 => seq 与 id 始终同一套
      expect(bus.published.length).toBe(1); // 第二条还没提交
      expect(committed(dbIndex).map((x) => x.task_id)).toEqual(["T1"]);
    });
    expect(bus.published.map((e) => e.seq)).toEqual([1, 2]);
    expect(committed(dbIndex).map((x) => x.task_id)).toEqual(["T1", "T2"]);
  });

  it("上一超步已提交、当前超步失败：已提交的那条不回退", async () => {
    const db = openDb();
    const { rec, bus } = make(db);
    const dbIndex = dbs.length - 1;
    await expect(
      rec.run(async () => {
        await rec.record(evt({ taskId: "T-KEEP" }));
        await rec.onStepStart(); // 第一个超步落地
        await rec.record(evt({ taskId: "T-LOST" }));
        throw new Error("第二个超步炸了");
      }),
    ).rejects.toThrow("第二个超步炸了");
    // 只回滚当前超步：已提交的留在库里，被丢弃的那批整批消失
    expect(committed(dbIndex).map((x) => x.task_id)).toEqual(["T-KEEP"]);
    expect(bus.published.map((e) => e.seq)).toEqual([1]); // 只广播已提交那条
  });

  it("多条事件的 seq 严格递增且与库中 id 逐条一致", async () => {
    const db = openDb();
    const { rec, bus } = make(db);
    await rec.run(async () => {
      await rec.record(evt({ taskId: "T1" }));
      await rec.record(evt({ taskId: "T2" }));
      await rec.record(evt({ taskId: "T3" }));
    });
    expect(bus.published.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(rows(db).map((r) => Number(r.id))).toEqual([1, 2, 3]);
  });

  it("跨超步回滚后总线一条都不发", async () => {
    const db = openDb();
    const { rec, bus } = make(db);
    await expect(
      rec.run(async () => {
        await rec.onStepStart();
        await rec.record(evt({ taskId: "T1" }));
        await rec.record(evt({ taskId: "T2" }));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(bus.published.length).toBe(0);
    expect(rows(db).length).toBe(0);
  });

  it("广播失败不能污染已提交的事务（前端断了不该让审计写入失败）", async () => {
    const db = openDb();
    const tx = new FakeTx(db);
    const bus = new FakeBus();
    bus.publishPersisted = (): never => {
      throw new Error("SSE 写失败");
    };
    const rec = new AuditRecorder({ tx, bus, now: () => 1 });
    await rec.run(async () => {
      await rec.record(evt());
    });
    expect(rows(db).length).toBe(1);
  });

  // 前提断言（0007 §4.1）：「catch 把失败交给 onBroadcastError」此前只写在 recorder.ts 的注释里
  // （默认必须可见而不是静默）。变异实测：ME 删掉 this.#onBroadcastError(e) 这一行、MF 把参数改成
  // undefined，补这两条之前【32 条测试全绿】—— 即【广播失败必须可见】没有任何断言守着。
  it("广播失败必须原样交给 onBroadcastError（可见性不许被静默替换）", async () => {
    const db = openDb();
    const tx = new FakeTx(db);
    const bus = new FakeBus();
    const boom = new Error("SSE 写失败");
    bus.publishPersisted = (): never => {
      throw boom;
    };
    const seen: unknown[] = [];
    const rec = new AuditRecorder({
      tx,
      bus,
      now: () => 1,
      onBroadcastError: (e) => {
        seen.push(e);
      },
    });
    await rec.run(async () => {
      await rec.record(evt());
      await rec.record(evt({ taskId: "T-10" }));
    });
    // 两条事件 ⇒ 两次广播失败 ⇒ 回调必须被调用两次（删掉 catch 里的调用 ⇒ 0 次）
    expect(seen.length, "每条广播失败都必须上报，不得静默丢弃").toBe(2);
    // 必须原样交出异常（改传 undefined 或换成包装类型 ⇒ 这条红）
    expect(seen[0]).toBe(boom);
    expect(seen[1]).toBe(boom);
    // 可见性不以牺牲审计为代价：两行仍必须落库
    expect(rows(db).length).toBe(2);
  });

  // 前提断言（0007 §4.1）：recorder.ts 注释写着「默认必须【可见】而不是静默」。变异实测：把默认
  // 回调换成【合法的静默函数】（((e) => { void e; })，tsc 与 biome 都过、不会崩），补这两条之前
  // 【255 条测试全绿】—— 也就是【默认可见】只存在于注释里，不在任何断言里。
  // 为什么值得锁：调用方【不传】onBroadcastError 才是常态（CLI、Electron 主进程都不传）；默认一旦
  // 变静默，前端断连造成的进度丢失就没有任何人在任何地方看到，而且不会有任何测试变红。
  it("不传 onBroadcastError 时默认出口必须真的可见（原异常要出得来）", async () => {
    const db = openDb();
    const tx = new FakeTx(db);
    const bus = new FakeBus();
    const boom = new Error("SSE 写失败");
    bus.publishPersisted = (): never => {
      throw boom;
    };
    /* 只 spy 不替换实现：要验的就是【默认实现本身】有没有在做事 */
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const rec = new AuditRecorder({ tx, bus, now: () => 1 }); // 故意不传 onBroadcastError
      await rec.run(async () => {
        await rec.record(evt());
      });
      expect(
        spy,
        "默认若是静默 ⇒ 前端断连造成的进度丢失无人可见",
      ).toHaveBeenCalledTimes(1);
      const args = spy.mock.calls[0] ?? [];
      /* 原异常必须出得来：只留一句笼统提示，排障时无从知道为什么失败 */
      expect(
        args.some((a) => a === boom),
        "默认出口必须带上原异常本体",
      ).toBe(true);
      /* 还要同时给人话说明（含关键词即可，不锁死整句文案，便于以后改措辞） */
      expect(
        args.some((a) => typeof a === "string" && a.includes("投影广播失败")),
        "必须给出人话说明",
      ).toBe(true);
      // 可见性不以牺牲审计为代价
      expect(rows(db).length).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("payload 存【完整事件】含 kind：只存 kind 或只存字段都无法回放", async () => {
    const db = openDb();
    const { rec } = make(db);
    await rec.run(async () => {
      await rec.record(
        evt({
          kind: "ReviewDecided",
          taskId: "T7",
          gate: "qa",
          decision: "reject",
        }),
      );
    });
    const payload = JSON.parse(String(rows(db)[0]?.payload));
    expect(payload.kind).toBe("ReviewDecided"); // 丢 kind：回放不知道是哪一类事件
    expect(payload).toMatchObject({
      taskId: "T7",
      gate: "qa",
      decision: "reject",
    }); // 丢字段：不知道评了哪个门
  });

  it("占位符与参数个数不符必须当场抛（node:sqlite 少绑不报错、直接写 NULL）", () => {
    // appendAudit 内必须调用 assertParamCount：events 有多个可空列，少绑一个参数
    // 会静默写出「事件记了但没关联任务」的行，审计回放看不出异常。
    expect(() =>
      assertParamCount(
        "INSERT INTO events (task_id) VALUES (?)",
        eventParams(ROW_OK, () => 1),
      ),
    ).toThrow(/占位符与参数个数不符/);
    // 反过来（参数比占位符少）也必须抛
    expect(() => assertParamCount(INSERT_EVENT_SQL, ["a"])).toThrow(
      /占位符与参数个数不符/,
    );
  });

  it("首次 onStepStart 且事务里还没有写入：不产生空的 commit+begin 往返", async () => {
    // run 已 begin；第一个超步边界若机械地 commit+begin，就是一次纯开销的空事务。
    // 更重要的是语义：第一个超步的 checkpoint 与它的事件必须留在同一个事务里。
    const db = openDb();
    const { rec, tx } = make(db);
    await rec.run(async () => {
      await rec.onStepStart();
      await rec.record(evt({ taskId: "T1" }));
      expect(tx.calls).toEqual(["begin"]);
    });
    expect(tx.calls).toEqual(["begin", "commit"]);
    expect(rows(db).length).toBe(1);
  });

  it("run 失败后攒着的事件必须清空：下一次 run 不能广播已回滚的事件", async () => {
    const db = openDb();
    const { rec, bus } = make(db);
    await expect(
      rec.run(async () => {
        await rec.record(evt({ taskId: "T-GONE" }));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(bus.published.length).toBe(0);
    await rec.run(async () => {
      await rec.record(evt({ taskId: "T-OK" }));
    });
    // 只广播这一条。若 #pending 没被清空，这里会多出一条【指向不存在的行】的
    // 幽灵事件：前端收到 seq，按游标去 REST 取，取不到 —— 且永远不会自我纠正。
    expect(bus.published.length).toBe(1);
    expect(bus.published[0]?.seq).toBe(Number(rows(db)[0]?.id)); // seq 恒等于库中 id
  });

  it("不传 actor 时默认 system / hub（不能假装是某个 agent 写的）", async () => {
    const db = openDb();
    const rec = new AuditRecorder({
      tx: new FakeTx(db),
      bus: new FakeBus(),
      now: () => 1,
    });
    await rec.run(async () => {
      await rec.record(evt());
    });
    expect(rows(db)[0]).toMatchObject({
      actor_type: "system",
      actor_id: "hub",
    });
  });

  it("extra 可覆盖 actor 与 state_snapshot（回放要能还原决策时状态）", async () => {
    const db = openDb();
    const { rec } = make(db);
    await rec.run(async () => {
      await rec.record(evt(), {
        actorType: "human",
        actorId: "ceo",
        stateSnapshot: { status: "review", consumed_cents: 12 },
      });
    });
    const r = rows(db)[0];
    expect(r?.actor_type).toBe("human");
    expect(JSON.parse(String(r?.state_snapshot))).toEqual({
      status: "review",
      consumed_cents: 12,
    });
  });
});

/* ------------------------------- 清理 -------------------------------- */

beforeAll(() => {
  dir = join(tmpdir(), "opc-audit-" + process.pid + "-" + Date.now());
  mkdirSync(dir, { recursive: true });
});

afterAll(() => {
  // 裸调用：包 try/catch 会让「连接没关」伪装成 Windows 上的 EPERM
  for (const d of dbs) d.close();
  rmSync(dir, { recursive: true, maxRetries: 40, retryDelay: 50 });
});
