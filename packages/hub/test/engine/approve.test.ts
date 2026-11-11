/**
 * 人席的写路径（engine/approve.ts）。
 *
 * ── 这一发在测的性质只有一句 ──────────────────────────────────────────
 * 「卡片被点掉」与「任务往前走」是【同一个事实的两半】，不能只落一半。
 * 这正是本仓抓了二十几篇的那一族（0013/0014/0020/0031/0033/0040）在引擎路线上的
 * 最新一格：HUMAN_EDGES 把三条人类出边算好了、humanEdge() 能查出来，而【全仓没人调它】，
 * 于是任务跑到 CHARTER_PENDING 之后永久停住。补上写路径之后，还要证明它写的是【整半】。
 *
 * ── 每条用例对应的失效 ────────────────────────────────────────────────
 *  · 只落卡片不动任务 → 界面上「已批准」而任务原地不动（最贵的那种静默）；
 *  · 重复点击写出两条决策审计 → append-only，回放重建出「批过两次」；
 *  · 卡片属于另一条任务 → 一次批准推进了不该推进的那条；
 *  · 写了 events 没广播 → 活着的 SSE 连接每次批准都撞一个 seq 空洞（0010 §4）；
 *  · 把 assigned_role 抹成 NULL → 批一次就把负责角色清掉一次（node:sqlite 少绑不报错）。
 *
 * 跑法（离线、node v24.14.0）：
 *   PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH \
 *     node --experimental-transform-types --import /tmp/opc-harness/register.mjs \
 *     --test packages/hub/test/engine/approve.test.ts
 */
import { mkdirSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fixtureTmp } from "../fixtures/fixture-dir.js";
import { migrate } from "../../src/db/migrate.js";
import { INSERT_DELEGATION_GRAPH_SQL } from "../../src/org/commit.js";
import { InMemoryEventBus } from "../../src/events/bus.js";
import { insertCard, type NewCardDraft } from "../../src/approvals/cards.js";
import {
  CLAIM_CARD_SQL,
  STATUS_BY_BUTTON,
  approveCard,
  humanSeatHint,
  pendingCards,
} from "../../src/engine/approve.js";
import { STATUS_BY_RESUME } from "../../src/http/real-deps.js";
import { HUMAN_EDGES } from "../../src/engine/dispatch.js";

const TMP = fixtureTmp("engine-approve", import.meta.url);
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

interface World {
  db: Db;
  q: Queue;
  bus: InMemoryEventBus;
  published: { kind: string; seq: number }[];
}

/**
 * 一条停在某人席上的任务 + （可选）一张挂在它上面的待批卡片。
 *
 * @param status 任务状态。人席的三格都传得进来，用来证明【三条出边全部真的走得通】，
 *               而不是只有我顺手测了的那一条。
 */
async function world(o: {
  readonly status: string;
  readonly role?: string;
  readonly withCard?: boolean;
  /** 卡片挂到哪条任务上。给一个不是 't1' 的值 ⇒ 造出「卡片与要推进的任务不是同一条」。 */
  readonly cardTask?: string;
}): Promise<World> {
  const { WriteQueue } = await import("../../src/db/write-queue.js");
  const q = new WriteQueue(TMP + "/a-" + process.pid + "-" + ++fileSeq + ".db") as unknown as Queue;
  queues.push(q);
  const db = q.writeConnection();
  migrate(db as unknown as Parameters<typeof migrate>[0]);
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at, graph_version) " +
      "VALUES ('t1','做个 AI 笔记应用',?,?, 'intake', ?, ?, 1)",
  ).run(o.status, o.role ?? "intake", NOW, NOW);
  // approvals.task_id 有外键（0001），所以「卡片挂在另一条任务上」需要那条任务【真存在】。
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at, graph_version) " +
      "VALUES ('other','另一件事',?, 'intake', 'intake', ?, ?, 1)",
  ).run(o.status, NOW, NOW);
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
  if (o.withCard === true) {
    const draft: NewCardDraft = {
      taskId: o.cardTask ?? "t1",
      approvalType: "charter",
      cardKey: "charter:proposal",
      summary: "章程提案待你签署：三条验收标准已拟",
      parameters: {
        impact_scope: "签了就生效",
        irreversible: true,
        recommendation: "读完再签",
        recommendation_is_not_decision: true,
        timeout_behavior: "escalate",
      },
      evidence_refs: ["events:1#state_snapshot.draft"],
      buttons: ["approve", "reject_with_comment", "defer_deep_review"],
    };
    await q.node(() => {
      insertCard(q.writeConnection() as never, draft, { nowMs: NOW });
      return null;
    });
  }
  const bus = new InMemoryEventBus();
  const published: World["published"] = [];
  const w: World = {
    db,
    q,
    bus,
    published,
  };
  return w;
}

/** 卡片 id（库里有且仅有一张时用）。 */
function cardId(w: World): string {
  const r = w.db.prepare("SELECT id FROM approvals").get();
  if (r === undefined) throw new Error("这张用例里没有卡片");
  return String(r["id"]);
}

function task(w: World): Row {
  const r = w.db.prepare("SELECT * FROM tasks WHERE id='t1'").get();
  if (r === undefined) throw new Error("任务不在了");
  return r;
}

const run = (w: World, o: { taskId?: string; approvalId?: string; button?: "approve" | "reject_with_comment" | "defer_deep_review"; note?: string }) =>
  approveCard(
    w.q,
    {
      taskId: o.taskId ?? "t1",
      approvalId: o.approvalId ?? cardId(w),
      button: o.button ?? "approve",
      nowMs: NOW + 5000,
      ...(o.note === undefined ? {} : { note: o.note }),
    },
    (e, seq) => {
      w.published.push({ kind: e.kind, seq });
      w.bus.publishPersisted(e, seq);
    },
  );

describe("一次批准 = 卡片决策 + 状态边，同一事务", () => {
  it("CHARTER_PENDING 上点批准 ⇒ 卡片 approved、任务 CHARTER_APPROVED、两条审计", async () => {
    const w = await world({ status: "CHARTER_PENDING", withCard: true });
    const r = await run(w, {});
    expect(r.outcome).toBe("decided");
    expect(r.edgeExists).toBe(true);
    expect(r.from).toBe("CHARTER_PENDING");
    expect(r.to).toBe("CHARTER_APPROVED");
    expect(String(task(w)["status"])).toBe("CHARTER_APPROVED");
    const card = w.db.prepare("SELECT status, decided_by, decided_at, decision_note FROM approvals").get();
    expect(card?.["status"]).toBe("approved");
    // decided_by 存【谁】而不是【决定了什么】（real-deps 同一条口径）
    expect(card?.["decided_by"]).toBe("ceo");
    expect(card?.["decided_at"]).toBe(NOW + 5000);

    // 两条审计：一条决策、一条状态变化。少任何一条都是「半套事实」。
    const evts = w.db.prepare("SELECT action, actor_type, actor_id, target FROM events ORDER BY id").all();
    expect(evts.map((e) => String(e["action"]))).toEqual(["approval", "state_change"]);
    // 人走的边，actor 必须是 human/ceo：写成 agent 的话，回放会答错「这一步是谁推的」
    expect(evts.map((e) => String(e["actor_type"]))).toEqual(["human", "human"]);
    expect(evts.map((e) => String(e["actor_id"]))).toEqual(["ceo", "ceo"]);
  });

  it("三条人类出边【全部】走得通（照 HUMAN_EDGES 逐条扫，防只测我顺手写的那一条）", async () => {
    for (const [from, byDecision] of Object.entries(HUMAN_EDGES)) {
      const to = byDecision?.["approve"]?.["to"];
      if (to === undefined) continue;
      const w = await world({ status: from, withCard: true });
      const r = await run(w, {});
      expect(r.outcome, from + " 应当能批").toBe("decided");
      expect(r.edgeExists, from + " 应当有出边").toBe(true);
      expect(String(task(w)["status"]), from + " 批准后应当到 " + to).toBe(to);
    }
  });

  it("批准后 assigned_role【不被抹掉】（WRITE_EDGE_SQL 会写那一列，少回填一次就清一次）", async () => {
    const w = await world({ status: "CHARTER_PENDING", role: "intake", withCard: true });
    await run(w, {});
    // assigned_role 是 NOT NULL，被抹成 NULL 会当场抛；current_node 才是那个静默的。
    expect(String(task(w)["assigned_role"])).toBe("intake");
    expect(String(task(w)["current_node"])).toBe("intake");
  });

  it("人的一格不烧 token：consumed_cents 前进 0 而不是变成 NULL", async () => {
    const w = await world({ status: "CHARTER_PENDING", withCard: true });
    w.db.prepare("UPDATE tasks SET consumed_cents = 7 WHERE id='t1'").run();
    await run(w, {});
    // COALESCE(...,0)+0 ⇒ 7。写成 NULL 的话界面显示「没花过钱」（dispatch 里同源那条）。
    expect(task(w)["consumed_cents"]).toBe(7);
  });

  it("note 落进 decision_note 与 state_snapshot，不混进 payload", async () => {
    const w = await world({ status: "CHARTER_PENDING", withCard: true });
    await run(w, { note: "验收标准第二条判不了，重写" });
    const card = w.db.prepare("SELECT decision_note FROM approvals").get();
    expect(card?.["decision_note"]).toBe("验收标准第二条判不了，重写");
    const dec = w.db.prepare("SELECT payload, state_snapshot FROM events WHERE action='approval'").get();
    const p = JSON.parse(String(dec?.["payload"])) as Record<string, unknown>;
    expect(p["resume"]).toBe("approve");
    expect(p["note"]).toBeUndefined();
    expect(JSON.parse(String(dec?.["state_snapshot"]))["note"]).toBe("验收标准第二条判不了，重写");
  });
});

describe("重复点击与错卡片：一条都不写", () => {
  it("第二次批准同一张卡 ⇒ already_decided，且 events 行数【不变】（append-only，写下去删不掉）", async () => {
    const w = await world({ status: "CHARTER_PENDING", withCard: true });
    const first = await run(w, {});
    expect(first.outcome).toBe("decided");
    const before = w.db.prepare("SELECT count(*) AS c FROM events").get();
    const second = await run(w, {});
    expect(second.outcome).toBe("already_decided");
    const after = w.db.prepare("SELECT count(*) AS c FROM events").get();
    expect(after?.["c"]).toBe(before?.["c"]);
    // 任务也没有再走一遍那条边（第二次连状态都变了，守卫也会挡，但根本不该走到那里）
    expect(String(task(w)["status"])).toBe("CHARTER_APPROVED");
    // 第二次【没有】广播任何东西：广播一条库里不存在的决策 = 前端角标 +1
    expect(w.published.length).toBe(2);
  });

  it("卡片挂在另一条任务上 ⇒ 不写任何东西，也不推进这条任务", async () => {
    const w = await world({ status: "CHARTER_PENDING", withCard: true, cardTask: "other" });
    const r = await run(w, {});
    expect(r.outcome).toBe("card_belongs_to_other_task");
    expect(w.db.prepare("SELECT count(*) AS c FROM events").get()?.["c"]).toBe(0);
    expect(String(task(w)["status"])).toBe("CHARTER_PENDING");
    expect(w.db.prepare("SELECT status FROM approvals").get()?.["status"]).toBe("pending");
  });

  it("卡片不存在 ⇒ card_missing，零写入（404 不产生审计：同 applyDecision 那条不变量）", async () => {
    const w = await world({ status: "CHARTER_PENDING", withCard: false });
    const r = await run(w, { approvalId: "没这张卡" });
    expect(r.outcome).toBe("card_missing");
    expect(w.db.prepare("SELECT count(*) AS c FROM events").get()?.["c"]).toBe(0);
  });

  it("卡片在而任务不在了 ⇒ task_missing，不留下【批掉了却推不动】的批准记录", async () => {
    const w = await world({ status: "CHARTER_PENDING", withCard: true });
    // approvals.task_id 有外键，所以这个状态【正常写入构造不出来】—— 它来自
    // 「foreign_keys=OFF 的连接」或「只恢复了半个库的备份」。这一发先把 FK 关掉造出那个
    // 残局，再来验 approveCard 会不会跟着一起把卡片批掉。留着这条分支的理由是：
    // 批掉一张指向虚空的任务的卡片 = 留下一条【永远推不动任何东西】的批准记录，
    // 而它看起来是「CEO 已经处理过了」。
    w.db.exec("PRAGMA foreign_keys = OFF;");
    w.db.prepare("DELETE FROM tasks WHERE id='t1'").run();
    const r = await run(w, {});
    expect(r.outcome).toBe("task_missing");
    expect(w.db.prepare("SELECT status FROM approvals").get()?.["status"]).toBe("pending");
    expect(w.db.prepare("SELECT count(*) AS c FROM events").get()?.["c"]).toBe(0);
  });
});

describe("广播：本轮写下的每条都发，且在提交之后", () => {
  it("决策 + 状态变化两条【都】广播，seq 与落库的 events.id 逐条对齐", async () => {
    const w = await world({ status: "CHARTER_PENDING", withCard: true });
    const r = await run(w, {});
    expect(w.published.map((p) => p.kind)).toEqual(["ApprovalDecided", "TaskStateChanged"]);
    const ids = w.db.prepare("SELECT id FROM events ORDER BY id").all().map((x) => Number(x["id"]));
    // 【空洞】是这里要防的东西：ids 里每个都出现在 published 里，一个不漏
    expect(w.published.map((p) => p.seq).sort((a, b) => a - b)).toEqual(ids);
    // 总线真的收到了（不是只收了个数组）：订阅者从 0 开始能读到两条
    expect(w.bus.latestSeq()).toBe(ids[ids.length - 1]);
    expect(r.published.length).toBe(2);
  });

  it("没抢到卡片的那一支【一条都不广播】（发一条库里没有的决策 = 前端多一个点不开的角标）", async () => {
    const w = await world({ status: "CHARTER_PENDING", withCard: true });
    await run(w, {});
    w.published.length = 0;
    await run(w, {});
    expect(w.published.length).toBe(0);
  });
});

describe("没有出边的那两颗按钮：卡片记掉而任务不动，并且【说出来】", () => {
  it("reject_with_comment ⇒ 卡片 rejected、任务原地、edgeExists=false 且那句 note 说清为什么", async () => {
    const w = await world({ status: "CHARTER_PENDING", withCard: true });
    // 带 --note：reject_with_comment 不带理由在【开事务之前】就被拦下（见下面那一发），
    // 而这一发要测的是「没有出边」那一支，不该被前置检查抢先。
    const r = await run(w, { button: "reject_with_comment", note: "验收标准第二条判不了真假，重写" });
    expect(r.edgeExists).toBe(false);
    expect(r.cardStatus).toBe("rejected");
    expect(String(task(w)["status"])).toBe("CHARTER_PENDING");
    expect(r.note).toContain("没有");
    // 只有决策那一条审计（没有状态变化那条）：广播与写入仍然逐条对齐
    expect(w.published.map((p) => p.kind)).toEqual(["ApprovalDecided"]);
    expect(w.db.prepare("SELECT count(*) AS c FROM events").get()?.["c"]).toBe(1);
  });

  it("打回而【没给理由】⇒ note_required，且【一次写连接都没碰到】", async () => {
    const w = await world({ status: "CHARTER_PENDING", withCard: true });
    const r = await run(w, { button: "reject_with_comment" });
    expect(r.outcome).toBe("note_required");
    expect(r.published.length).toBe(0);
    expect(w.published.length).toBe(0);
    // 卡片仍然 pending、任务仍然原位、审计零行：请求不成立不该留下任何痕迹
    expect(w.db.prepare("SELECT status FROM approvals").get()?.["status"]).toBe("pending");
    expect(String(task(w)["status"])).toBe("CHARTER_PENDING");
    expect(w.db.prepare("SELECT count(*) AS c FROM events").get()?.["c"]).toBe(0);
  });

  it("纯空白的理由与【没给理由】算同一件事（不能悄悄存成 NULL）", async () => {
    const w = await world({ status: "CHARTER_PENDING", withCard: true });
    const r = await run(w, { button: "reject_with_comment", note: "   " });
    expect(r.outcome).toBe("note_required");
    expect(w.db.prepare("SELECT count(*) AS c FROM approvals WHERE status = 'rejected'").get()?.["c"]).toBe(0);
  });

  it("approve 带不带 note 都成立（理由不是它的必填项）", async () => {
    const w = await world({ status: "CHARTER_PENDING", withCard: true });
    const r = await run(w, { button: "approve" });
    expect(r.outcome).toBe("decided");
    expect(String(task(w)["status"])).toBe("CHARTER_APPROVED");
  });

  it("defer_deep_review ⇒ deferred（与 http 那张表同值，两份不许漂移）", async () => {
    const w = await world({ status: "CHARTER_PENDING", withCard: true });
    const r = await run(w, { button: "defer_deep_review" });
    expect(r.cardStatus).toBe("deferred");
    // 两份「按钮 → 卡片状态」的映射在两个模块里（http 那张绑着图恢复，这边只留前半截）。
    // 同值是【必须钉住】的：漂移的表现是「同一个按钮在两条路上把卡片落成不同状态」，
    // 而收件箱按 status 过滤待批，两种都算「已处理」，看不出来。
    expect(STATUS_BY_BUTTON).toEqual(STATUS_BY_RESUME);
  });

  it("认领卡片那条 SQL 与 http 那份【逐字相同】（两份文本漂移的代价见 approve.ts 注释）", () => {
    expect(CLAIM_CARD_SQL).toBe("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = ?");
  });
});

describe("pendingCards 与那句人席提示", () => {
  it("只数 pending：批掉的那张不再算「还欠你一个决定」", async () => {
    const w = await world({ status: "CHARTER_PENDING", withCard: true });
    expect(pendingCards(w.q, "t1").length).toBe(1);
    await run(w, {});
    // 这个数读错的话，界面会长期说一件不成立的事（收件箱角标永远不减）
    expect(pendingCards(w.q, "t1").length).toBe(0);
  });

  it("pendingCards 交出的是【这张卡的身份】，收件箱要点开它", async () => {
    const w = await world({ status: "CHARTER_PENDING", withCard: true });
    const rows = pendingCards(w.q, "t1");
    expect(rows[0]?.approvalType).toBe("charter");
    expect(rows[0]?.cardKey).toBe("charter:proposal");
    expect(rows[0]?.taskId).toBe("t1");
    expect(rows[0]?.id.length).toBeGreaterThan(10);
  });

  it("提示句说的是【去点哪、点了会到哪】，而不是「等人」", () => {
    const s = humanSeatHint("CHARTER_PENDING");
    expect(s).toContain("CHARTER_APPROVED");
    expect(s).toContain("批准");
    // MEETING_REQUIRED / BLOCKED 在 §7.1 里【没有】出边 —— 提示句必须说实话，
    // 不能说「去点批准」（那样 CEO 会去点一颗点了也没用的按钮）
    const dead = humanSeatHint("MEETING_REQUIRED");
    expect(dead).toContain("出边");
    expect(dead).toContain("死路");
    expect(dead).not.toContain("批准后进入");
    // agent 那一格不该被人当成人席去点
    expect(humanSeatHint("IN_PROGRESS")).toContain("agent");
  });
});
