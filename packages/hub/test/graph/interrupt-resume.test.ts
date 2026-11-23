import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  Annotation,
  Command,
  END,
  interrupt,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { afterAll, describe, expect, it } from "vitest";
import { SqliteWALSaver } from "../../src/checkpoint/saver.js";
import { CHECKPOINT_TABLES } from "../../src/checkpoint/schema.js";
import type { DomainEvent, EventBus } from "../../src/events/bus.js";
import {
  auditedInvoke,
  SuperStepAuditor,
} from "../../src/graph/audit-middleware.js";
import { nodeReplayKey } from "../../src/graph/replay-key.js";
import { EVENTS_DDL_WITH_REPLAY } from "../fixtures/events-ddl.js";

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterAll(() => {
  for (const d of dbs) d.close();
  for (const d of dirs)
    rmSync(d, { recursive: true, maxRetries: 40, retryDelay: 50 });
});

class FakeBus implements EventBus {
  readonly published: number[] = [];
  publishPersisted(_e: DomainEvent, seq: number): void {
    this.published.push(seq);
  }
  latestSeq(): number {
    return this.published.length;
  }
  subscribe(): never {
    throw new Error("不该订阅");
  }
}

function openDb(): { db: DatabaseSync; index: number } {
  const dir = mkdtempSync(join(tmpdir(), "opc-rerun-"));
  dirs.push(dir);
  const db = new DatabaseSync(join(dir, "s.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(EVENTS_DDL_WITH_REPLAY);
  for (const ddl of CHECKPOINT_TABLES) db.exec(ddl);
  dbs.push(db);
  return { db, index: dirs.length - 1 };
}

/** 第二个只读连接：写连接永远看得见自己未提交的写入，据此断言毫无鉴别力。 */
function readRows(index: number, sql: string): Record<string, unknown>[] {
  const other = new DatabaseSync(join(dirs[index] ?? "", "s.db"), {
    readOnly: true,
  });
  try {
    return other.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    other.close();
  }
}
const readCommitted = (index: number): Record<string, unknown>[] =>
  readRows(index, "SELECT id, action, payload FROM events ORDER BY id");

const State = Annotation.Root({
  trail: Annotation<string[]>({ reducer: (a, b) => a.concat(b) }),
});

interface Harness {
  auditor: SuperStepAuditor;
  graph: {
    invoke(input: unknown, cfg: unknown): Promise<Record<string, unknown>>;
  };
  rows: () => Record<string, unknown>[];
  /** 连 state_snapshot / replay_key 一起读（判据 3 的观测面不在 rows 那五列里）。 */
  audit: () => Record<string, unknown>[];
  bus: FakeBus;
  cfg: { configurable: { thread_id: string } };
  calls: () => { approval: number };
}

/**
 * @param writeBeforeInterrupt record 是否发生在 interrupt() 【之前】。
 *   这是本缺陷的唯一触发条件：LangGraph 的 interrupt 靠【重放节点直到 interrupt()
 *   那一行】实现（实测见 0005 §11），所以中断之前写的 events 会被重放写第二遍。
 */
function make(writeBeforeInterrupt: boolean, keyed = false): Harness {
  const { db, index } = openDb();
  const bus = new FakeBus();
  const auditor = new SuperStepAuditor({ db, bus, now: () => 1700000000000 });
  const saver = auditor.instrumentSaver(new SqliteWALSaver(db));
  const runs = { approval: 0 };
  // keyed=false 复刻【缺陷原状】：同一条事件不带重放键。
  // keyed=true 用【生产那一份键源】（src/graph/replay-key.ts），不是测试自己造的键 ——
  // 于是这里绿的是「生产用的那个键真能吞掉重放行」，而不是「随便传个字符串都能吞」。
  const record = () =>
    auditor.recorder.record(
      {
        kind: "TaskStateChanged",
        taskId: "T-RERUN",
        from: "running",
        to: "need_approval",
      },
      keyed ? { replayKey: nodeReplayKey() } : {},
    );
  const graph = new StateGraph(State)
    .addNode("approval", async () => {
      runs.approval += 1;
      if (writeBeforeInterrupt) await record();
      interrupt({ reason: "请批准" });
      if (!writeBeforeInterrupt) await record();
      return { trail: ["resumed"] };
    })
    .addEdge(START, "approval")
    .addEdge("approval", END)
    .compile({ checkpointer: saver }) as unknown as Harness["graph"];
  return {
    auditor,
    graph,
    bus,
    rows: () => readCommitted(index),
    audit: () =>
      readRows(
        index,
        "SELECT id, action, target, payload, state_snapshot, replay_key FROM events ORDER BY id",
      ),
    cfg: { configurable: { thread_id: "rerun-" + index } },
    calls: () => runs,
  };
}

describe("interrupt resume 重放对 events 的影响（当前行为 = 缺陷，见 0005 §11）", () => {
  it("节点在 interrupt() 之前写的 events，resume 后被重放写第二遍", async () => {
    // 【这不是期望行为，是已知缺陷的回归锁。】
    // 期望是「不重复」（计划 Task 0.6 第 4 项），实测【会重复】。测试断言当前的
    // 真实行为，好处是：一旦去重机制落地，本测试立刻变红，逼着来改的人读这条注释，
    // 而不是留一条永远绿着的「测了个寂寞」。
    const h = make(true);
    await h.auditor.invoke(() => h.graph.invoke({ trail: [] }, h.cfg));
    const after1 = h.rows();
    expect(after1.length).toBe(1);

    await h.auditor.invoke(() =>
      h.graph.invoke(new Command({ resume: { decision: "pass" } }), h.cfg),
    );
    const after2 = h.rows();
    expect(after2.length).toBe(2);
    // 两条【逐字相同】才算「重复」：不同 payload 就是两个真实事件，不该去重。
    expect(after2[1]?.payload).toBe(after2[0]?.payload);
    expect(after2[1]?.action).toBe("state_change");
    expect(h.calls().approval).toBe(2); // 节点确实重跑到了 interrupt 那一行
  });

  it("崩溃恢复姿势 invoke(null) 同样重放 ⇒ 也会重复", async () => {
    // 计划原文正是「崩溃恢复（V3）」：进程重启后用 invoke(null) 续跑。
    // V3 只保证【checkpoint】不重跑，不保证【节点内副作用】不重放 —— 两者不是一回事。
    const h = make(true);
    await h.auditor.invoke(() => h.graph.invoke({ trail: [] }, h.cfg));
    expect(h.rows().length).toBe(1);
    await h.auditor.invoke(() => h.graph.invoke(null, h.cfg));
    expect(h.rows().length).toBe(2);
  });

  it("record 在 interrupt() 【之后】就不重复 ⇒ 缺陷边界就在中断之前那半段", async () => {
    // 这条对照把缺陷边界钉死：同一个节点、同一次 resume，差别只是 record 落在
    // interrupt 前还是后。有了它，「所有节点都不许写 events」这种一刀切规避就
    // 站不住 —— 也能用来验证将来的修复是否【过宽】（过宽会误杀合法的第二条事件）。
    const h = make(false);
    await h.auditor.invoke(() => h.graph.invoke({ trail: [] }, h.cfg));
    expect(h.rows().length).toBe(0); // 首次挂起在 interrupt，后半段没跑到
    await h.auditor.invoke(() =>
      h.graph.invoke(new Command({ resume: { decision: "pass" } }), h.cfg),
    );
    // resume 后才执行后半段：恰好一条，不重复。
    expect(h.rows().length).toBe(1);
  });

  it("缺陷 C 的回归锁：真实 auditor.invoke + 真实图 + auditedInvoke 必须能组合", async () => {
    // 【修好后本例应当变绿。】此前它是【红】的：auditedInvoke 内部 recorder.run，
    // SuperStepAuditor.invoke 也 recorder.run，嵌套撞「一次图执行只能有一个事务
    // 责任方」守卫；不嵌套则 SqliteWALSaver.put 报「必须在 txScope() 内调用」。
    // 0.8 的真实图执行【同时需要】两者（saver 要 auditor 建的事务作用域，中断要
    // auditedInvoke 发审批），所以这不是边缘用法，是主路径 —— 三套零件测试各自
    // 全绿却组装不出可用整体，因为 audit-interrupt 用 FakeTx 绕开了真实嵌套。
    const h = make(false); // record 在 interrupt 之后：本例只关心审批，不掺 A 的重复
    const out = await h.auditor.invoke(() =>
      auditedInvoke({
        invoke: () => h.graph.invoke({ trail: [] }, h.cfg),
        recorder: h.auditor.recorder,
        taskId: "T-COMBO",
      }),
    );
    // 中断确实被识别（返回体带 __interrupt__）
    expect(Array.isArray((out as Record<string, unknown>).__interrupt__)).toBe(
      true,
    );
    // 审批落库了，且已提交（只读连接可见）
    const rows = h.rows();
    const approvals = rows.filter((r) => r.action === "approval");
    expect(approvals.length).toBe(1);
    // 关键：审批写进【当前超步事务】，不是另开一个事务 —— 一次 invoke 只有一次提交
    expect(h.auditor.committedSteps).toBe(1);
  });
});

describe("带上重放键之后：中断重放不再写第二行（0005 §11 缺陷 A/B 的修复锁）", () => {
  it("interrupt() 之前写的 events，resume 重放被吞：仍是 1 行，且节点确实重跑过", async () => {
    // 与上面那条「会写第二遍」的差别只有一处：record 带了 replayKey。
    // ⚡ 断言里最要紧的不是行数，是最后一行 calls().approval === 2 ——
    // 它排除掉「其实节点没重跑所以没重复」这个假绿：节点跑到第 2 次、
    // 真的又 record 了一遍，而库里还是 1 行，才是【去重】在起作用。
    const h = make(true, true);
    await h.auditor.invoke(() => h.graph.invoke({ trail: [] }, h.cfg));
    const after1 = h.rows();
    expect(after1.length).toBe(1);
    const firstId = after1[0]?.["id"];

    await h.auditor.invoke(() =>
      h.graph.invoke(new Command({ resume: { decision: "pass" } }), h.cfg),
    );
    const after2 = h.rows();
    expect(after2.length).toBe(1);
    expect(after2[0]?.["id"]).toBe(firstId); // 同【那一行】，不是删了又插
    expect(h.calls().approval).toBe(2);
  });

  it("崩溃恢复姿势 invoke(null) + 重放键 ⇒ 不重复", async () => {
    // 与上面同一条机制的另一入口：计划里的「崩溃恢复（V3）」正是 invoke(null)。
    const h = make(true, true);
    await h.auditor.invoke(() => h.graph.invoke({ trail: [] }, h.cfg));
    expect(h.rows().length).toBe(1);
    await h.auditor.invoke(() => h.graph.invoke(null, h.cfg));
    expect(h.rows().length).toBe(1);
  });

  it("修复不过宽：interrupt() 之后写的那条照样落库", async () => {
    // 上面两条如果靠「interrupt 之前的 record 一律不写」实现，本例会红 ——
    // 那条规避会误杀【合法的第二条】。这里 keyed=true 但写入发生在中断之后，
    // 期望与不传键时【逐字一致】：首次 0 行、resume 后 1 行。
    const h = make(false, true);
    await h.auditor.invoke(() => h.graph.invoke({ trail: [] }, h.cfg));
    expect(h.rows().length).toBe(0);
    await h.auditor.invoke(() =>
      h.graph.invoke(new Command({ resume: { decision: "pass" } }), h.cfg),
    );
    expect(h.rows().length).toBe(1);
  });
});

describe("审批写入点的重放键（崩溃一次多一张待批卡片 —— 0005 §11 的审批侧）", () => {
  /**
   * auditedInvoke 每次都在 invoke 之后补写 ApprovalRequired。崩溃恢复的【正常姿势】
   * 是再 invoke(null) 一次，而节点会重放到 interrupt() 那一行 —— 于是同一个
   * interruptId 会被要求批准第二遍。没有键时库里就多一张【指向同一次中断】的待批卡片，
   * 而收件箱那个数字是【事件累计出来的】（bus.ts 的 ApprovalDecided 注释），
   * 所以表现是「批了一张还剩一张」，且没有任何报错。
   */
  it("同一个 interruptId 再中断一次 ⇒ 审批仍是 1 行", async () => {
    const h = make(false);
    const first = await h.auditor.invoke(() =>
      auditedInvoke({
        invoke: () => h.graph.invoke({ trail: [] }, h.cfg),
        recorder: h.auditor.recorder,
        taskId: "T-APPROVAL-REPLAY",
      }),
    );
    const idsOf = (out: Record<string, unknown>): unknown[] =>
      ((out["__interrupt__"] as { id: string }[]) ?? []).map((i) => i.id);
    const ids1 = idsOf(first as Record<string, unknown>);
    expect(ids1.length).toBe(1);
    expect(h.rows().filter((r) => r.action === "approval").length).toBe(1);

    // 第二次【不 resume】，直接 invoke(null) 续跑：节点重放到 interrupt() 再挂一次。
    const second = await h.auditor.invoke(() =>
      auditedInvoke({
        invoke: () => h.graph.invoke(null, h.cfg),
        recorder: h.auditor.recorder,
        taskId: "T-APPROVAL-REPLAY",
      }),
    );
    const ids2 = idsOf(second as Record<string, unknown>);
    // 前提必须先钉住：两次是【同一个】interruptId。它若不等，下面的「仍 1 行」
    // 就测的是别的东西（而 .workbuddy/probe356-approval-replay-child.mts 量的正是跨进程同值）。
    expect(ids2).toEqual(ids1);
    const approvals = h.rows().filter((r) => r.action === "approval");
    expect(approvals.length).toBe(1);
  });

  it("同一次执行里的【两张不同卡片】都落库 ⇒ 那个键不是常量", async () => {
    // ⚠ 这条必须由【同一个库】承担。第一版我写成「两个任务各开一个库，各断言 1 行」，
    //   拿 replayKey 改成字面常量去变异它【照样全绿】—— 两个库各自吞不掉任何东西，
    //   测了个寂寞。同一个库里放两个【不同】的中断，常量键才会把第二张吞掉。
    const { db, index } = openDb();
    const auditor = new SuperStepAuditor({
      db,
      bus: new FakeBus(),
      now: () => 1700000000000,
    });
    const saver = auditor.instrumentSaver(new SqliteWALSaver(db));
    // 两个并行节点各中断一次 ⇒ 同一次执行里两张卡、两个不同的 interruptId。
    const graph = new StateGraph(State)
      .addNode("a", () => {
        interrupt({ reason: "卡片 A" });
        return {};
      })
      .addNode("b", () => {
        interrupt({ reason: "卡片 B" });
        return {};
      })
      .addEdge(START, "a")
      .addEdge(START, "b")
      .compile({ checkpointer: saver }) as unknown as Harness["graph"];

    const out = await auditor.invoke(() =>
      auditedInvoke({
        invoke: () =>
          graph.invoke(
            { trail: [] },
            { configurable: { thread_id: "two-cards" } },
          ),
        recorder: auditor.recorder,
        taskId: "T-TWO-CARDS",
      }),
    );
    const ids =
      ((out as Record<string, unknown>).__interrupt__ as { id: string }[]) ??
      [];
    expect(new Set(ids.map((x) => x.id)).size).toBe(2); // 前提：真的是两张不同的卡
    const approvals = readCommitted(index).filter(
      (r) => r.action === "approval",
    );
    expect(approvals.length).toBe(2);
  });
});

describe("重放置换的两条副作用：不重发 seq、快照照样有", () => {
  it("被吞掉的那次 record 不广播 ⇒ 总线不会收到重复 seq", async () => {
    // seq 的唯一真相是 events.id（bus.ts 文件头）。recorder 若在 deduplicated 分支
    // 仍旧 push pending，提交后就会把【同一个 seq】广播第二遍 —— 真总线的
    // publishPersisted 对此直接抛（严格递增守卫），于是表现是【每一次 resume
    // 都把 SSE 订阅弄脏一次】：投影层把 link 标 stale 去重拉快照。
    // 这里的 FakeBus 只记 seq，所以断言的是【广播次数与 seq 集合】：
    // 两次 invoke 只广播 1 条，且集合大小 = 1。
    const h = make(true, true);
    await h.auditor.invoke(() => h.graph.invoke({ trail: [] }, h.cfg));
    expect(h.bus.published).toEqual([expect.any(Number)]);
    await h.auditor.invoke(() =>
      h.graph.invoke(new Command({ resume: { decision: "pass" } }), h.cfg),
    );
    expect(h.bus.published.length).toBe(1); // 第二次【一条都没发】
    expect(h.rows().length).toBe(1);
  });

  it("重放行被吞时，库里那一行的快照仍是【决定时】的状态", async () => {
    // 去重返回的是【已有那一行】，所以库里留下的快照必须是第一次写的那份。
    // 这条测的是「别为了去重把新算的快照 UPDATE 上去」—— events 是 append-only，
    // UPDATE 会被触发器挡下来；就算不挡，重放时点的状态也不该冒充第一次的决定时。
    const h = make(true, true);
    await h.auditor.invoke(() => h.graph.invoke({ trail: [] }, h.cfg));
    const first = h.audit()[0];
    await h.auditor.invoke(() =>
      h.graph.invoke(new Command({ resume: { decision: "pass" } }), h.cfg),
    );
    const after = h.audit();
    expect(after.length).toBe(1);
    expect(after[0]?.["id"]).toBe(first?.["id"]);
    expect(after[0]?.["state_snapshot"]).toBe(first?.["state_snapshot"]);
    expect(after[0]?.["payload"]).toBe(first?.["payload"]);
    // ⚠ 这里【不】再断言快照的【方向】（current 落在 from 而不是 to）。
    //   本夹具的 record() 不写快照（列是 NULL），方向判据住在 e2e-linear ⑤ ——
    //   那一条跑的是【生产写入点】company.ts 的 edge()。在这里补一份等于把同一条
    //   判据钉在【测试自己写的 record】上，生产改动照样测不到。
  });

  it("审批那条边也带快照：中断时点的图状态，且不含 __interrupt__ 键", async () => {
    const h = make(false);
    await h.auditor.invoke(() =>
      auditedInvoke({
        invoke: () => h.graph.invoke({ trail: [] }, h.cfg),
        recorder: h.auditor.recorder,
        taskId: "T-APPROVAL-SNAP",
      }),
    );
    const row = h.audit().find((r) => r.action === "approval");
    expect(row).toBeDefined();
    const snapText = String(row?.["state_snapshot"]);
    expect(snapText).not.toBe("null");
    expect(snapText).not.toBe("{}");
    const snap = JSON.parse(snapText) as Record<string, unknown>;
    // __interrupt__ 是 LangGraph 塞进返回体的【控制流】字段，不是任务状态；
    // 它里面装的是 payload 的同一份内容，进快照等于把同一件事存两遍。
    expect(snap).not.toHaveProperty("__interrupt__");
    expect(snap).toHaveProperty("trail");
  });
});
