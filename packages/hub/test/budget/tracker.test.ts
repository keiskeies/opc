/**
 * Task 1.6 验收：预算护栏（规格 §7.4 / §21 / §6.1）。
 *
 * 三条各自独立、且各自对应一种真实事故：
 *  1) 幂等 —— 崩溃重启会重放同一条消费上报。若不幂等，重启一次扣一次，
 *     预算会在几次重启后凭空耗尽，而账面「对得上」（每一笔都有事件）。
 *  2) 整数美分 —— 浮点累计在一万次之后让【是否超预算】这个边界判定随误差翻转。
 *  3) 突破 ⇒ 暂停而非杀任务 —— 已完成的产出是真实成本，杀任务把它一起丢掉；
 *     而预算突破的语义是「需要人决定要不要继续花」，不是「这条作废」。
 *
 * 跑在真迁移出来的 schema 上（同 test/db/schema-0001.test.ts 的立场）：
 * 自造简化表只能证明「我写的表能用」，证明不了「迁移出来的那张表能用」。
 *
 * ⚠ 事务与作用域必须由【recorder.run()】负责，不能在测试里自己 BEGIN：
 * 本文件第一版就是这么写的 —— 自己 BEGIN + 自己另起一个 AsyncLocalStorage，
 * 于是 recorder 那边 inTx() 是 true 而 db() 抛 SCOPE-MISS（两个 ALS 实例不是
 * 同一个 store）。那条坑正好是 recorder.ts 里 StepTx 注释讲的「两个谓词不能合并」
 * 的镜像：光有活动事务不够，连接必须在【同一个】作用域里取得。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertCents,
  BUDGET_PERIODS,
  BUDGET_SCOPES,
  type BudgetPeriod,
  type BudgetScope,
  BudgetTracker,
  type ConsumeInput,
} from "../../src/budget/tracker.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";
import type { StepTx } from "../../src/events/recorder.js";
import { AuditRecorder } from "../../src/events/recorder.js";
import { InMemoryEventBus } from "../../src/events/bus.js";
import type { DomainEvent } from "../../src/events/bus.js";
import { migrate } from "../../src/db/migrate.js";

const TMP = fixtureTmp("budget", import.meta.url);

/**
 * 连接的结构类型（同 test/db/schema-0001.test.ts 的做法）。
 * 不在断言里到处 as never，也不把 node:sqlite 的具体类型漏进测试逻辑。
 */
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

const opened: Db[] = [];
let seq = 0;

const num = (row: Row | undefined, key: string): number => {
  if (row === undefined) throw new Error("查询应当有行，实无：" + key);
  return Number(row[key]);
};

/**
 * 从 events 表【现场取】一个没用过的 id 当幂等键。
 *
 * 不传 1、2、3 这种小常数：recorder 自己也会往 events 里写行，硬编码迟早撞上真实
 * id，而表现是「某一轮开始幂等命中」—— 一个和预算逻辑毫无关系的偶发失败。
 */
function makeEid(db: Db): () => number {
  let local = Number(
    Object.values(db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM events").get() ?? {})[0],
  );
  return () => {
    const head = Number(
      Object.values(
        db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM events").get() ?? {},
      )[0],
    );
    local = Math.max(head, local) + 1;
    return local;
  };
}

/**
 * 建一个任务行。
 *
 * 【必须真建】不能省：events.task_id 上有 REFERENCES tasks(id)，而 pragmas.ts 开着
 * 外键。省掉的话 BudgetPaused 那条 INSERT 直接 FOREIGN KEY failed —— 整个用例测的
 * 就不是预算了。传真实存在过的状态名（'IN_PROGRESS'）而不是随手编一个：这一层将来
 * 若加状态 CHECK，编的值会先在这里炸，而炸的位置会让人误以为是预算模块的问题。
 */
function seedTask(db: Db, taskId: string, role = "dev"): void {
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
      "VALUES (?, ?, 'IN_PROGRESS', ?, 'implement', ?, ?)",
  ).run(taskId, "预算用例用的任务", role, 1_700_000_000_000, 1_700_000_000_000);
}

/** 真 schema + 真 recorder + 真事务：同事务这一维只能靠真事务验。 */
async function make(): Promise<{
  db: Db;
  tracker: BudgetTracker;
  recorder: AuditRecorder;
  bus: InMemoryEventBus;
  eid: () => number;
  actions: () => string[];
}> {
  const { openDb } = await import("../../src/db/driver.js");
  const file = join(TMP, "b-" + process.pid + "-" + ++seq + ".db");
  const db = openDb(file) as unknown as Db;
  opened.push(db);
  migrate(db);

  const als = new AsyncLocalStorage<{ db: DatabaseSync }>();
  let open = false;
  const tx: StepTx = {
    begin: async () => {
      db.exec("BEGIN IMMEDIATE");
      open = true;
    },
    commit: async () => {
      db.exec("COMMIT");
      open = false;
    },
    rollback: async () => {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* 事务已被 SQLite 自身中止 */
      }
      open = false;
    },
    scope: <T,>(fn: () => Promise<T>): Promise<T> => als.run({ db }, fn),
    inTx: () => open,
    db: () => {
      const s = als.getStore();
      if (s === undefined) throw new Error("SCOPE-MISS");
      return s.db;
    },
  };
  // 【真总线】而不是手写假总线：BudgetPaused 走 recorder → publishPersisted 这条真实
  // 投影路径，而真总线对 seq 严格递增有硬校验（bus.ts）。假总线会把这条校验整条跳过，
  // 于是「预算事件带了个假的 seq」这种真 bug 在测试里全绿，而它在生产上的表现是
  // 断线重连时游标不可比 —— 偶尔少一条，最难查那一类。
  const bus = new InMemoryEventBus();
  const recorder = new AuditRecorder({
    tx,
    bus,
    now: () => 1_700_000_000_000,
    // 投影失败在本文件里必须炸：悄悄吞掉会让「事件到底发没发」不可断言
    onBroadcastError: (e) => {
      throw e;
    },
  });
  const tracker = new BudgetTracker({
    db: db as unknown as DatabaseSync,
    recorder,
    now: () => 1_700_000_000_000,
  });
  // 本文件所有 consume 默认挂在 T-1 上，其余任务 id 由用例自己点名
  for (const t of ["T-1", "T-K", "T-F", "T-BULK", "T-D", "T-R", "T-E", "T-X", "T-P", "T-L"])
    seedTask(db, t);

  return {
    db,
    tracker,
    recorder,
    bus,
    eid: makeEid(db),
    actions: () => (db.prepare("SELECT action FROM events ORDER BY id").all() as Row[]).map(
      (r) => String(r["action"]),
    ),
  };
}

/**
 * 把总线里已发布的事件全部取出来。
 *
 * 为什么这样取不会挂住：subscribe(fromSeq) 在【构造时】就把环形里的存量同步
 * deliver 进队列（bus.ts 的 subscribe），所以接下来 latestSeq 次 next() 每一次都
 * 命中非空队列、立即 resolve，不会走到「等下一条」那条不 resolve 的分支。
 * 反过来用 for-await 不行 —— 取干之后它会继续等下一条，那条订阅永远挂着。
 */
async function feed(bus: InMemoryEventBus): Promise<DomainEvent[]> {
  const owed = bus.latestSeq();
  const sub = bus.subscribe(0);
  const it = sub[Symbol.asyncIterator]();
  const got: DomainEvent[] = [];
  for (let i = 0; i < owed; i++) {
    const step = await it.next();
    if (step.done === true) break;
    got.push(step.value);
  }
  sub.close();
  return got;
}

const pausedOnly = (events: readonly DomainEvent[]): DomainEvent[] =>
  events.filter((e) => e.kind === "BudgetPaused");

const consumedOf = (db: Db, scopeId: string, period: string): number =>
  num(
    db
      .prepare(
        "SELECT consumed_cents FROM budgets WHERE scope_id = ? AND period = ?",
      )
      .get(scopeId, period),
    "consumed_cents",
  );

const budgetRows = (db: Db, scopeId: string): Row[] =>
  db.prepare("SELECT id, scope_type, period, limit_cents FROM budgets WHERE scope_id = ?").all(
    scopeId,
  );

const budgetEventRows = (db: Db, sourceEvent: number): Row[] =>
  db.prepare("SELECT source_event, amount_cents FROM budget_events WHERE source_event = ?").all(
    sourceEvent,
  );

/** consume 的默认入参：只补默认值，不改任何语义。 */
const give = (
  over: Partial<ConsumeInput> & Pick<ConsumeInput, "scope" | "scopeId" | "sourceEvent">,
): ConsumeInput => ({
  period: "per_task",
  amountCents: 100,
  taskId: "T-1",
  ...over,
});

const limit = (
  tracker: BudgetTracker,
  scope: BudgetScope,
  scopeId: string,
  period: BudgetPeriod,
  limitCents: number,
): void => tracker.declareLimit({ scope, scopeId, period, limitCents });

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  for (const db of opened) {
    try {
      db.close();
    } catch {
      /* 已关 */
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});

describe("作用域与周期的取值口径", () => {
  it("三级作用域与三种周期，逐字对齐 budgets 的注释", () => {
    // 这两个常量是 budgets.scope_type / period 的唯一定义处。拼错的代价不是报错，
    // 而是【写出一个没人会读的作用域】：limit 声明在 "rol" 上、消费写在 "role" 上，
    // 于是护栏对所有真实消费都不生效，而且全程不报错。
    expect(BUDGET_SCOPES).toEqual(["company", "role", "task"]);
    expect(BUDGET_PERIODS).toEqual(["daily", "monthly", "per_task"]);
  });
});

describe("三级作用域各自突破", () => {
  const three: {
    scope: BudgetScope;
    scopeId: string;
    period: BudgetPeriod;
  }[] = [
    { scope: "company", scopeId: "opc", period: "daily" },
    { scope: "role", scopeId: "dev", period: "daily" },
    { scope: "task", scopeId: "T-1", period: "per_task" },
  ];

  for (const t of three) {
    it(t.scope + "/" + t.period + " 突破 → 发 BudgetPaused 且【只发一次】", async () => {
      const { db, tracker, recorder, bus, eid } = await make();
      await recorder.run(async () => {
        limit(tracker, t.scope, t.scopeId, t.period, 1000);
        expect(
          (
            await tracker.consume(
              give({ ...t, scopeId: t.scopeId, sourceEvent: eid(), amountCents: 600 }),
            )
          ).breached,
        ).toBe(false);

        const second = await tracker.consume(
          give({ ...t, scopeId: t.scopeId, sourceEvent: eid(), amountCents: 500 }),
        );
        expect(second.breached).toBe(true);
        expect(second.over).toBe(true);
        expect(second.consumedCents).toBe(1100);

        // 第三笔：【已经】超着 ⇒ 不再重复发事件。否则 CEO 收件箱被同一条超限刷满。
        const third = await tracker.consume(
          give({ ...t, scopeId: t.scopeId, sourceEvent: eid(), amountCents: 100 }),
        );
        expect(third.breached).toBe(false);
        expect(third.over).toBe(true);
      });

      const paused = pausedOnly(await feed(bus));
      expect(paused.length).toBe(1);
      const p = paused[0];
      if (p?.kind !== "BudgetPaused") throw new Error("应有 BudgetPaused");
      // 事件必须能指回任务：CEO 收到卡片要回得去（BudgetPaused.taskId 是必填的）
      expect(p.taskId).toBe("T-1");
      expect(p.spentUsdCents).toBe(1100);
      expect(tracker.limitCents(t.scope, t.scopeId, t.period)).toBe(1000);
      expect(consumedOf(db, t.scopeId, t.period)).toBe(1200);
    });
  }

  it("审计里出现的是 budget_consume，没有任何【任务终止】语义的动作（§7.4 暂停而非杀）", async () => {
    // 图行为在 Phase 2 接入，这里钉的是【审计侧】的口径：预算模块不得发出带终止
    // 语义的动作。kind → action 的映射在 recorder 的 KIND_TO_ACTION 里
    // （BudgetPaused → "budget_consume"），不在预算模块里 —— 本文件第一版断言的
    // 是 "budget_paused"，那是把事件 kind 当成了 events.action，两者不是同一套枚举。
    const { tracker, recorder, eid, actions } = await make();
    await recorder.run(async () => {
      limit(tracker, "task", "T-K", "per_task", 100);
      await tracker.consume(
        give({
          scope: "task",
          scopeId: "T-K",
          sourceEvent: eid(),
          taskId: "T-K",
          amountCents: 150,
        }),
      );
    });
    expect(actions()).toEqual(["budget_consume"]);
  });
});

describe("整数美分（§6.1 禁浮点）", () => {
  it("小数 / NaN / ±Infinity / 超安全整数 → 一律拒绝", () => {
    for (const bad of [
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      2 ** 53,
      -1,
    ]) {
      expect(() => assertCents(bad, "amount_cents"), String(bad)).toThrow();
    }
  });

  it("0 与安全整数上界都收", () => {
    expect(() => assertCents(0, "x")).not.toThrow();
    expect(() => assertCents(Number.MAX_SAFE_INTEGER, "x")).not.toThrow();
  });

  it("负数的报错单独点名「不得为负」（负数扣减 = 凭空增加额度）", () => {
    expect(() => assertCents(-5, "limit_cents")).toThrow(/不得为负/u);
  });

  it("小数在 consume 入口被拒（表里没有列能拦住浮点，只能在这里拦）", async () => {
    const { tracker, recorder, eid } = await make();
    await recorder.run(async () => {
      limit(tracker, "task", "T-F", "per_task", 1000);
      await expect(
        tracker.consume(
          give({ scope: "task", scopeId: "T-F", sourceEvent: eid(), amountCents: 0.5 }),
        ),
      ).rejects.toThrow(/整数美分/u);
    });
  });

  it("累计一万笔「一分」正好是一百分（浮点口径在这里会漂）", async () => {
    const { db, tracker, recorder, eid } = await make();
    await recorder.run(async () => {
      limit(tracker, "company", "opc", "monthly", 10_000_000);
      for (let i = 0; i < 10_000; i++) {
        await tracker.consume(
          give({
            scope: "company",
            scopeId: "opc",
            period: "monthly",
            sourceEvent: eid(),
            amountCents: 1,
            taskId: "T-BULK",
          }),
        );
      }
    });
    expect(consumedOf(db, "opc", "monthly")).toBe(10_000);
  });
});

describe("幂等：同一预算事件重复上报不重复扣减", () => {
  it("同一 sourceEvent 报两次 → 只扣一次", async () => {
    const { db, tracker, recorder, eid } = await make();
    await recorder.run(async () => {
      limit(tracker, "task", "T-D", "per_task", 1000);
      const id = eid();
      const first = await tracker.consume(
        give({ scope: "task", scopeId: "T-D", sourceEvent: id, amountCents: 300 }),
      );
      expect(first.applied).toBe(true);
      expect(first.consumedCents).toBe(300);

      const again = await tracker.consume(
        give({ scope: "task", scopeId: "T-D", sourceEvent: id, amountCents: 300 }),
      );
      expect(again.applied).toBe(false);
      expect(again.consumedCents).toBe(300); // 没有变成 600
      expect(again.duplicateOf).toBe(id);
      expect(consumedOf(db, "T-D", "per_task")).toBe(300);
    });
  });

  it("跨【事务】重放同一条也不重复扣（崩溃重启的真实形状）", async () => {
    const { db, tracker, recorder, eid } = await make();
    let id = 0;
    await recorder.run(async () => {
      limit(tracker, "role", "dev", "daily", 5000);
      id = eid();
      await tracker.consume(
        give({
          scope: "role",
          scopeId: "dev",
          period: "daily",
          sourceEvent: id,
          amountCents: 400,
          taskId: "T-R",
        }),
      );
    });
    // 第二个超步事务：模拟重启后重放同一条上报
    await recorder.run(async () => {
      const r = await tracker.consume(
        give({
          scope: "role",
          scopeId: "dev",
          period: "daily",
          sourceEvent: id,
          amountCents: 400,
          taskId: "T-R",
        }),
      );
      expect(r.applied).toBe(false);
      expect(r.consumedCents).toBe(400);
    });
    expect(consumedOf(db, "dev", "daily")).toBe(400);
  });

  it("重复上报【不多发】审计：一暂停一笔钱", async () => {
    const { tracker, recorder, bus, eid } = await make();
    let id = 0;
    await recorder.run(async () => {
      limit(tracker, "task", "T-E", "per_task", 100);
      id = eid();
      await tracker.consume(
        give({ scope: "task", scopeId: "T-E", sourceEvent: id, amountCents: 200 }),
      );
      const dup = await tracker.consume(
        give({ scope: "task", scopeId: "T-E", sourceEvent: id, amountCents: 200 }),
      );
      expect(dup.applied).toBe(false);
      expect(dup.breached).toBe(false); // 重复上报不得再触发一次暂停
    });
    expect(pausedOnly(await feed(bus)).length).toBe(1);
  });

  it("回滚的事务【不留】幂等记录，于是重放那一笔能成功", async () => {
    // 这一条管幂等键的另一个方向：键若比数据活得更久，就会出现
    // 「事件说扣过了、账上却没扣」—— 比重复扣更坏（钱花了没记账，且无法重试）。
    const { db, tracker, recorder, eid } = await make();
    let id = 0;
    await recorder.run(async () => {
      limit(tracker, "task", "T-X", "per_task", 1000);
      id = eid();
    });
    await expect(
      recorder.run(async () => {
        await tracker.consume(
          give({ scope: "task", scopeId: "T-X", sourceEvent: id, amountCents: 200 }),
        );
        throw new Error("BOOM-中途失败");
      }),
    ).rejects.toThrow(/BOOM/u);

    expect(budgetEventRows(db, id).length).toBe(0);
    expect(consumedOf(db, "T-X", "per_task")).toBe(0);

    await recorder.run(async () => {
      const r = await tracker.consume(
        give({ scope: "task", scopeId: "T-X", sourceEvent: id, amountCents: 200 }),
      );
      expect(r.applied).toBe(true);
      expect(r.consumedCents).toBe(200);
    });
  });

  it("作用域没声明时，consume 抛错且【不烧掉】幂等键", async () => {
    // 校验若排在幂等插入之后，失败会把 source_event 永久占位：此后同一条上报每次
    // 都被判成「已处理」，那一笔钱【永远记不上账】。这是本文件里唯一一条
    // 「失败得干净」的性质，而它只能靠先校验来保证。
    const { db, tracker, recorder, eid } = await make();
    await recorder.run(async () => {
      const id = eid();
      await expect(
        tracker.consume(give({ scope: "role", scopeId: "ghost", sourceEvent: id })),
      ).rejects.toThrow(/declareLimit/u);
      // 键没被占：插入未发生
      expect(budgetEventRows(db, id).length).toBe(0);
    });
  });

  it("sourceEvent 非正 / 非整数 → 抛错（幂等键不可用时宁可炸，不能默默多扣）", async () => {
    const { db, tracker, recorder, eid } = await make();
    await recorder.run(async () => {
      limit(tracker, "task", "T-P", "per_task", 10_000);
      // 写【字面量】而不是「合法 id + 偏移」：本文件第一版写的是 base + bad，
      // 而 base + 0 恰好是一个完全合法的 events.id —— 那一轮 consume 堂堂成功，
      // 用例却报「promise 没 reject」，看着像实现有问题。非法值就直接写非法值。
      const bad: number[] = [
        0,
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
      ];
      for (const v of bad) {
        await expect(
          tracker.consume(give({ scope: "task", scopeId: "T-P", sourceEvent: v })),
        ).rejects.toThrow(/events\.id/u);
      }
      // 非法值【不留行】：校验排在插入之前，所以一条 budget_events 都不该有
      expect(
        db.prepare("SELECT source_event FROM budget_events").all().length,
      ).toBe(0);
      // 同时确认合法值仍然走得通（防止上面那圈把整条路径写死了）
      expect(
        (
          await tracker.consume(
            give({ scope: "task", scopeId: "T-P", sourceEvent: eid(), amountCents: 5 }),
          )
        ).applied,
      ).toBe(true);
    });
  });
});

describe("必须在超步事务内（文件头那条不变量的可执行版本）", () => {
  it("事务外 consume → 抛错并点名 recorder.run()", async () => {
    // 不拦会留下什么：非突破的那笔消费不写事件，于是在事务外调用一样「成功」，
    // consumed_cents 就在节点失败回滚之后照样前进了一格 —— 为一次没有发生的工作
    // 付了钱，而幂等键让重放无法纠正它。全程不报错才是这条最贵的地方。
    const { tracker, eid } = await make();
    await expect(
      tracker.consume(
        give({ scope: "task", scopeId: "T-OUT", sourceEvent: eid() }),
      ),
    ).rejects.toThrow(/recorder\.run/u);
  });

  it("事务外 declareLimit 不在禁止之列（启动期声明限额，本就不属于任何超步）", async () => {
    const { db, tracker } = await make();
    expect(() => limit(tracker, "task", "T-BOOT", "per_task", 50)).not.toThrow();
    expect(budgetRows(db, "T-BOOT").length).toBe(1);
  });
});

describe("缺上限时的立场", () => {
  it("没声明过预算就问上限 → 抛错，不默认无限额度", async () => {
    // 默认无限意味着护栏对这条作用域【不存在】，而它存在的意义正是拦突破。
    const { tracker } = await make();
    expect(() => tracker.limitCents("role", "undeclared", "daily")).toThrow(
      /没有声明预算上限/u,
    );
  });

  it("重复 declareLimit 不清空已消费量，也不改上限", async () => {
    // ON CONFLICT DO NOTHING：重复声明（比如每次启动都跑一遍初始化）若走 UPDATE，
    // 重启一次就把 consumed 抹成 0 或把上限顶高 —— 预算护栏在最需要它的时刻失效。
    const { db, tracker, recorder, eid } = await make();
    await recorder.run(async () => {
      limit(tracker, "task", "T-L", "per_task", 1000);
      await tracker.consume(
        give({ scope: "task", scopeId: "T-L", sourceEvent: eid(), amountCents: 400 }),
      );
      tracker.declareLimit({
        scope: "task",
        scopeId: "T-L",
        period: "per_task",
        limitCents: 9999,
      });
      expect(tracker.limitCents("task", "T-L", "per_task")).toBe(1000);
    });
    expect(consumedOf(db, "T-L", "per_task")).toBe(400);
  });

  it("id 由三段拼接 ⇒ 同一作用域只有一行（随机 UUID 会让重复声明产生多行）", async () => {
    const { db, tracker } = await make();
    for (const _ of [1, 2, 3]) {
      limit(tracker, "role", "dev2", "daily", 500);
    }
    const rows = budgetRows(db, "dev2");
    expect(rows.length).toBe(1);
    expect(rows[0]?.["id"]).toBe("role|dev2|daily");
  });

  it("同一作用域换周期是【另一行】：per_task 的额度不被 daily 的花费吃掉", async () => {
    // 三级作用域 × 三种周期若塌成一格，任务级预算会被公司日预算覆盖，
    // 于是「单个任务最多花多少」这句话在库里问不出来。
    const { db, tracker } = await make();
    limit(tracker, "task", "T-M", "per_task", 100);
    limit(tracker, "task", "T-M", "daily", 900);
    const rows = budgetRows(db, "T-M");
    expect(rows.length).toBe(2);
    expect(rows.map((r) => String(r["period"])).sort()).toEqual([
      "daily",
      "per_task",
    ]);
    expect(tracker.limitCents("task", "T-M", "per_task")).toBe(100);
    expect(tracker.limitCents("task", "T-M", "daily")).toBe(900);
    void db;
  });
});
