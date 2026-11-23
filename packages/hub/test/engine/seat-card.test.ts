/**
 * 任务落到【人席】时那张卡（engine/seat-card.ts + 两处接线）。
 *
 * ── 这个文件测的性质只有一句 ─────────────────────────────────────────
 * 状态机把任务停在「等人」那一格时，那个人手上【必须有一个入口】。
 * 入口在这套系统里只有一种形态：一张 pending 的卡片 —— 它的 id 是
 * `POST /approvals/:id/decide` 的路径段，也是 approveCard 的认领键。
 * 0046 §1 量到的是：dispatch 与 approveCard 都合法地把任务推到人席，而两处都
 * 只写状态边 ⇒ 卡片数 0 ⇒「状态说等人、人没有按钮」。本文件每一条断言都在钉
 * 「那一格有一张能点的卡，而且点得动」。
 *
 * ── 为什么 dispatch 那一侧的接线也放这儿 ────────────────────────────
 * 判据、卡片键的身份规则、CHARTER_PENDING 为什么排除，三条理由都长在 seat-card.ts
 * 里；把「落到人席要补卡」的断言拆到 dispatch.test.ts 会让理由与它的证据分家。
 * dispatch.test.ts 问的是【门】（谁能推进、推进到哪、少花一分钱没有），
 * 这里问的是【推进之后收件箱里有没有东西】。同一写路径，两个问题。
 *
 * ── 断言不只问「有没有卡」，还问「这张卡点下去走到哪」────────────────
 * 只断言 approvals 的行数会让两类假绿活下来：
 *  · 卡建出来了而它指着一条没有出边的格子 ⇒ 收件箱有东西、点下去不动；
 *  · 卡片键派生自状态名 ⇒ 第二次到达撞键不建卡 ⇒ 第一次之后那一格又空了。
 * 所以有那条【只点卡片、从 ESCALATED_TO_CEO 一路点到 DELIVERED】的金色路径用例
 * （每一跳的卡片都是上一跳的产物，中途没有任何夹具替我建卡），
 * 以及「同一格第二次到达 ⇒ 新键 ⇒ 新卡」那条。
 *
 * ── 为什么这里不用 `as never` 把类型糊过去 ──────────────────────────
 * approve.test.ts 那套 Db/Queue 替身类型是为了测「类型窄的调用方也能用」，
 * 而这里要的恰好相反：WriteQueue / HubWriter / DatabaseSync 全是真类型，
 * 因为补卡这一发最容易写错的正是「把另一条连接当事务内那条传进去」——
 * 那在替身类型上编译照过，在真库上是一次静默的 autocommit。见下面那两条作用域守卫用例。
 *
 * 跑法（离线、node v24.14.0）：
 *   PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH \
 *     node --experimental-transform-types --import /tmp/opc-harness/register.mjs \
 *     --test packages/hub/test/engine/seat-card.test.ts
 */
import { mkdirSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { OrgGraph } from "@opc/contracts";
import { fixtureTmp } from "../fixtures/fixture-dir.js";
import { gateDepsFrom } from "../fixtures/gate-deps.js";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { INSERT_DELEGATION_GRAPH_SQL } from "../../src/org/commit.js";
import { InMemoryEventBus } from "../../src/events/bus.js";
import { insertCard, type NewCardDraft } from "../../src/approvals/cards.js";
import { approveCard, pendingCards } from "../../src/engine/approve.js";
import {
  HUMAN_EDGES,
  makeDispatch,
  type DispatchResult,
  type TurnOutcome,
} from "../../src/engine/dispatch.js";
import {
  SEAT_CARD_KEY_PREFIX,
  mintSeatCard,
  needsSeatCard,
  seatCardKey,
} from "../../src/engine/seat-card.js";
import type { TaskState } from "../../src/graph/status.js";

const TMP = fixtureTmp("engine-seat-card", import.meta.url);
const NOW = 1_700_000_000_000;
const CEO = "ceo";

type Row = Record<string, unknown>;

/**
 * 三格组织图：ceo → director → dev。
 * 三格是【到顶】这条路的最小图：director 的上级是 ceo ⇒ IN_REVIEW + pass 走
 * planEdge 的 topmost 那一支直接升 ESCALATED_TO_CEO（【规格】§7.2 步骤 8），
 * 而那正是 0046 §1 探针量到「卡片数 = 0」的那一发。
 *
 * ── 那条 `edges` 为什么以前是空的、现在不是 ─────────────────────────
 * 本文件的判据是「落到人席要有一张能点的卡」，与委派边无关，所以夹具一直写 `edges: []`。
 * §8.2 第 3 条接进 dispatch 之后，判据 3（`selfReviewEdgeBlock`）也读这张图：
 * 产出方 dev 没有一条 `review_gate=true` 的出边 ⇒ 每一次 director 审阅都被拦、
 * 任务不跃迁 ⇒ 本文件那几发「跃迁到人席」的用例整个失去对象。
 * 补这条边的口径是【夹具本来缺这条不变量的载体】，不是把断言改成放行：
 * 「IN_REVIEW + pass 到顶」这个前提在今天的生产语义下【就包含】「dev 有一条带门控的
 * 出边」，以前它能成立恰恰是因为那一维没接上（接线前的假绿面）。
 * ⚠ review_gate 这个名字写错不会报错、只会静默变成「这条边没门控」
 *   （门控层的字段叫 gate，由 dispatch 的 reviewerEdges 负责改名），所以下面
 *   「到顶那一发」必须真跃迁 —— 那才是这条边写对了的证据，而不是这份夹具断言。
 */
const GRAPH: OrgGraph = {
  nodes: {
    ceo: { role_id: CEO, can_manage: true, reports_to: null, model_family: "opus" },
    director: { role_id: "director", can_manage: true, reports_to: CEO, model_family: "sonnet" },
    dev: { role_id: "dev", can_manage: false, reports_to: "director", model_family: "claude" },
  },
  edges: [{ from: "dev", to: "director", review_gate: true }],
};

const queues: WriteQueue[] = [];
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
  readonly q: WriteQueue;
  readonly db: DatabaseSync;
}

/** 一条停在某格上的任务 + 一张组织图。库文件按用例分（同 dispatch.test.ts 的理由）。 */
function openWorld(status: string, role = CEO): World {
  const q = new WriteQueue(TMP + "/s-" + process.pid + "-" + ++fileSeq + ".db");
  queues.push(q);
  const db = q.writeConnection();
  migrate(db);
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at, graph_version) " +
      "VALUES ('t1', '做个 AI 笔记应用', ?, ?, ?, ?, ?, 1)",
  ).run(status, role, role, NOW, NOW);
  db.prepare(INSERT_DELEGATION_GRAPH_SQL).run("g1", 1, JSON.stringify(GRAPH), NOW, CEO, "测试用组织图");
  return { q, db };
}

/**
 * `SELECT *` 而不是点列：`approvals` 表里【没有 buttons 这一列】。
 * 三颗按钮由 channels/abstraction.ts 从 APPROVAL_BUTTONS 现生成，落库前由
 * contracts 那条 `.length(3)` + z.enum 判（insertCard 里的 safeParse）——
 * 所以「按钮词表写错」的证据是【建卡当场抛】，本文件那条 created:true
 * 就是它的正向断言，写错按钮名会让那一发变红。
 *
 * ⚠ 排序用 rowid 而【不是】id：id 是 randomUUID() 发的 TEXT 主键，
 * `ORDER BY id` 排的是【字典序】，与插入顺序无关。我第一版写的是 id，
 * 「第二次到达 ⇒ 两个键」那条用例【碰巧】绿过一次 —— 那是本仓最讨厌的一种绿：
 * 断言的是顺序，而顺序来自随机数。rowid 才是插入顺序。
 */
function cardsIn(db: DatabaseSync): Row[] {
  return db.prepare("SELECT * FROM approvals ORDER BY rowid").all();
}

/** events 表里【真实存在】的 seq 集合。与广播集合比对就是「有没有洞」。 */
function seqsIn(db: DatabaseSync): number[] {
  return (db.prepare("SELECT id FROM events ORDER BY id").all() as Row[]).map((r) => Number(r["id"]));
}

function statusOf(db: DatabaseSync): string {
  return String(db.prepare("SELECT status FROM tasks WHERE id='t1'").get()?.["status"]);
}

/* ═══════════════════ needsSeatCard：哪些格子要卡 ═══════════════════ */

describe("needsSeatCard —— 从 HUMAN_EDGES 派生，不手抄名单", () => {
  it("HUMAN_EDGES 里除 CHARTER_PENDING 之外【每一格】都要卡（表扫描，防只测我顺手写的那两条）", () => {
    const seats = Object.keys(HUMAN_EDGES).filter((s) => s !== "CHARTER_PENDING");
    // 分母。这条断言存在的全部理由：名单要是哪天变空，下面那条循环【恒真】。
    expect(seats).toEqual(["ESCALATED_TO_CEO", "FINAL_REVIEW"]);
    for (const s of seats) expect(needsSeatCard(s as TaskState), s + " 是人席，应当要卡").toBe(true);
  });

  it("CHARTER_PENDING【排除】：那张卡的生产者是 charter.ts / 章程泵，再建一张就是同一件事两张卡", () => {
    expect(needsSeatCard("CHARTER_PENDING")).toBe(false);
  });

  it("agent 席位不建卡（人不该被叫起来，token 也不该在那儿等）", () => {
    for (const s of ["CHARTER_APPROVED", "DECOMPOSING", "IN_PROGRESS", "IN_REVIEW", "BUDGET_PAUSED"] as const) {
      expect(needsSeatCard(s), s + " 由 agent 推进").toBe(false);
    }
  });

  it("两张表都没有出边的【死路】不建卡：给它一张 approve 卡等于假装它有出路", () => {
    for (const s of ["MEETING_REQUIRED", "BLOCKED", "APPROVED_UPWARD", "DELIVERED", "ARCHIVED"] as const) {
      expect(needsSeatCard(s), s + " 没有人类出边，不该假装能批").toBe(false);
    }
  });
});

describe("seatCardKey —— 一次到达一个身份", () => {
  it("键里带着那一条状态边的 seq", () => {
    expect(SEAT_CARD_KEY_PREFIX).toBe("seat");
    expect(seatCardKey("FINAL_REVIEW", 42)).toBe("seat:FINAL_REVIEW:42");
  });
  it("同一格两次到达 ⇒ 两个键（键里【只有状态名】的那版实现第二次会撞键不建卡）", () => {
    expect(seatCardKey("ESCALATED_TO_CEO", 7)).not.toBe(seatCardKey("ESCALATED_TO_CEO", 8));
  });
});

/* ═══════════════════ mintSeatCard：卡片 + 审计的形状 ═══════════════════ */

/** 在调用方的事务里补一张卡（两个生产调用方就是这个形状：node() 内、事务内）。 */
function mint(
  w: World,
  o: { status: TaskState; arrivalSeq: number; why?: string; db?: DatabaseSync },
) {
  return w.q.node(() =>
    mintSeatCard(o.db ?? w.db, {
      taskId: "t1",
      status: o.status,
      arrivalSeq: o.arrivalSeq,
      why: o.why ?? "审阅通过且已到组织顶层，升到 CEO：覆盖率 92%，3 个 P2 缺陷",
      nowMs: NOW,
    }),
  );
}

describe("mintSeatCard —— 一张卡 + 一条审计 + 一个可广播的 seq", () => {
  it("建成：卡片 pending、类型 escalation、审计署名 system/hub、seq 就是那条审计行", async () => {
    const w = openWorld("ESCALATED_TO_CEO");
    const r = await mint(w, { status: "ESCALATED_TO_CEO", arrivalSeq: 1 });
    expect(r.created).toBe(true);
    expect(r.event).not.toBeNull();
    expect(r.seq).not.toBeNull();

    const cards = cardsIn(w.db);
    expect(cards.length).toBe(1);
    expect(cards[0]?.["status"]).toBe("pending");
    expect(cards[0]?.["approval_type"]).toBe("escalation");
    expect(String(cards[0]?.["card_key"])).toBe("seat:ESCALATED_TO_CEO:1");
    // 摘要带着【那一句为什么】：CEO 在收件箱里要在几秒内决定，光说"等你批"不可决策
    expect(String(cards[0]?.["summary"])).toContain("覆盖率 92%");
    // 推荐必须自证是推荐（§9.2 那个字面量字段），且【不】伪装成有出处
    const params = JSON.parse(String(cards[0]?.["parameters"])) as Record<string, unknown>;
    expect(params["recommendation_is_not_decision"]).toBe(true);
    // ⚠ 升级原因由【状态机 + 组织树】定（顶层审阅通过），不由 agent 给自己定性
    expect(JSON.stringify(params["escalation"])).toContain("outside_decision_scope");

    const evts = w.db.prepare("SELECT action, actor_type, actor_id, target, payload FROM events").all() as Row[];
    expect(evts.length).toBe(1);
    expect(evts[0]?.["action"]).toBe("approval");
    // 署名 system/hub：卡片是【系统提出的一次请求】，署人名会污染 role-memory 的分桶依据
    expect(evts[0]?.["actor_type"]).toBe("system");
    expect(evts[0]?.["actor_id"]).toBe("hub");
    // target = 卡片 id：「这张卡被要求批准」与「这张卡被批掉」要在 target 上 join 得起来
    expect(evts[0]?.["target"]).toBe(cards[0]?.["id"]);
    // payload 是【内层那份】（approval_type / summary / evidence_refs 在顶层），不是 {...evt}
    const p = JSON.parse(String(evts[0]?.["payload"])) as Record<string, unknown>;
    expect(p["kind"]).toBe("ApprovalRequired");
    expect(p["approval_type"]).toBe("escalation");
    expect(Array.isArray(p["evidence_refs"])).toBe(true);
    // seq 与 event 是一对：它必须等于那条审计行的 id，否则广播出去的是个假坐标
    expect(r.seq).toBe(seqsIn(w.db)[0]);
  });

  it("不需要卡的格子 ⇒ created:false 且【一条都不写】（卡片表与事件表都空）", async () => {
    const w = openWorld("IN_PROGRESS", "dev");
    const r = await mint(w, { status: "IN_PROGRESS", arrivalSeq: 1 });
    expect(r.created).toBe(false);
    expect(r.event).toBeNull();
    expect(r.seq).toBeNull();
    expect(cardsIn(w.db).length).toBe(0);
    expect(seqsIn(w.db).length).toBe(0);
  });

  it("撞去重键 ⇒ created:false，且【不写第二条审计】（写了就是审计里多一次没发生的批准请求）", async () => {
    const w = openWorld("ESCALATED_TO_CEO");
    const first = await mint(w, { status: "ESCALATED_TO_CEO", arrivalSeq: 5, why: "第一次到达" });
    const before = seqsIn(w.db).length;
    const second = await mint(w, { status: "ESCALATED_TO_CEO", arrivalSeq: 5, why: "同一个到达重放" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.event).toBeNull();
    // seq 与 event 在类型上是一对：没建成时【两个都是 null】。
    // 只把 event 置 null 而 seq 留个数字，调用方会广播一条库里不存在的事件。
    expect(second.seq).toBeNull();
    expect(second.note).toContain("已经有一张卡");
    expect(cardsIn(w.db).length).toBe(1);
    expect(seqsIn(w.db).length).toBe(before);
  });

  it("同一格【第二次真到达】（另一个 seq）⇒ 新键新卡：§8.3 允许同一任务多次升级", async () => {
    const w = openWorld("ESCALATED_TO_CEO");
    await mint(w, { status: "ESCALATED_TO_CEO", arrivalSeq: 1, why: "第一次升级" });
    await mint(w, { status: "ESCALATED_TO_CEO", arrivalSeq: 2, why: "第二次升级（另一轮，另一个问题）" });
    const cards = cardsIn(w.db);
    expect(cards.length).toBe(2);
    expect(cards.map((c) => String(c["card_key"]))).toEqual([
      "seat:ESCALATED_TO_CEO:1",
      "seat:ESCALATED_TO_CEO:2",
    ]);
  });
});

/* ═══════════ mintSeatCard 必须长在调用方的事务里（作用域守卫）═══════════ */

describe("mintSeatCard 的事务作用域守卫", () => {
  /**
   * 这一组用例存在的理由，是给 seat-card.ts 文件头那句「必须在调用方的事务里」
   * 【一个能红的断言】。在那句只是注释的时候，违反它的表现是：
   * 卡片 autocommit 了、状态边回滚了 ⇒ 收件箱里躺着一张【指向 agent 席位】的卡，
   * CEO 点下去拿到「这一格没有出边」，而全程没有任何报错。
   */
  it("事务外直接调 ⇒ 抛（而不是悄悄 autocommit 一张卡）", () => {
    const w = openWorld("FINAL_REVIEW");
    expect(() =>
      mintSeatCard(w.db, {
        taskId: "t1",
        status: "FINAL_REVIEW",
        arrivalSeq: 1,
        why: "事务外",
        nowMs: NOW,
      }),
    ).toThrow(/事务/u);
    // 抛在【建卡之前】：一张都没留下
    expect(cardsIn(w.db).length).toBe(0);
    expect(seqsIn(w.db).length).toBe(0);
  });

  it("事务内但传的是【另一条连接】⇒ 抛（那条连接不在这笔事务里，写下去会立刻 autocommit）", async () => {
    const w = openWorld("FINAL_REVIEW");
    const other = new WriteQueue(TMP + "/foreign-" + process.pid + "-" + ++fileSeq + ".db");
    queues.push(other);
    // 那条库上要有同名任务，否则这一发会先撞 FK，测到的就不是作用域守卫了。
    const odb = other.writeConnection();
    migrate(odb);
    odb
      .prepare(
        "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at, graph_version) " +
          "VALUES ('t1', '另一本库上的同名任务', 'FINAL_REVIEW', 'ceo', 'ceo', ?, ?, 1)",
      )
      .run(NOW, NOW);
    await expect(mint(w, { status: "FINAL_REVIEW", arrivalSeq: 1, db: odb })).rejects.toThrow(/事务/u);
    // 两本库【都】干干净净：外键那条路也不该留下一张卡
    expect(cardsIn(w.db).length).toBe(0);
    expect(cardsIn(odb).length).toBe(0);
  });
});

/* ═══════════════════ dispatch 落人席 ⇒ 同事务补卡 ═══════════════════ */

const turn = (text: string, over: Partial<TurnOutcome> = {}): TurnOutcome => ({
  ok: true,
  text,
  costCents: 4,
  sessionId: "sess-1",
  error: null,
  ...over,
});
const said = (o: Record<string, unknown>) => "干完了。\n\n<<<OPC_DECISION>>>\n" + JSON.stringify(o);

interface RunWorld extends World {
  readonly res: DispatchResult;
  readonly published: { kind: string; seq: number }[];
}

async function runDispatch(o: {
  readonly status: string;
  readonly role: string;
  readonly turn: TurnOutcome;
  readonly lastProducer?: string | null;
}): Promise<RunWorld> {
  const w = openWorld(o.status, o.role);
  const published: { kind: string; seq: number }[] = [];
  const bus = new InMemoryEventBus();
  // 订阅建在 dispatch 之前：站在「实时在线」那个位置上，才看得见有没有洞。
  bus.subscribe(0);
  const dispatch = makeDispatch({
    writer: w.q,
    ...gateDepsFrom(w.db, TMP + "/artifacts"),
    loadTask: (id) => {
      const r = w.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
      if (r === undefined) return null;
      return {
        id: String(r["id"]),
        title: String(r["title"]),
        status: String(r["status"]) as TaskState,
        role: String(r["assigned_role"]),
        graphVersion: Number(r["graph_version"]),
      };
    },
    modelFamily: (roleId) => String(GRAPH.nodes[roleId]?.["model_family"] ?? ""),
    rolePrompt: (roleId) => "你是 " + roleId + "。",
    roleSession: () => null,
    runTurn: async () => o.turn,
    recentSummaries: () => [],
    lastProducer: () => o.lastProducer ?? null,
    rejectionCount: () => 0,
    ceoApproved: () => false,
    publish: (e, seq) => {
      published.push({ kind: e.kind, seq });
      bus.publishPersisted(e, seq);
    },
  });
  const res = await dispatch({ taskId: "t1", nowMs: NOW, maxBudgetUsd: 0.5 });
  return { ...w, res, published };
}

/** 到顶那一发（【规格】§7.2 步骤 8）：IN_REVIEW + 独立审阅通过 + pass。 */
const topPass = {
  status: "IN_REVIEW",
  role: "director",
  lastProducer: "dev",
  turn: turn(said({ action: "pass", summary: "覆盖率 92%，3 个 P2 缺陷待后续迭代" })),
} as const;

describe("dispatch 把人席当终点时 —— 门 4 全量拦下，补卡机制改由 approveCard 侧承担", () => {
  /**
   * round359 语义变更（CEO 拍板「门 4 全量拦」，CEO 简报 B9 那一格）：
   * IN_REVIEW + pass 在门 1/2/3 全过后被门 4 拦（role_charters 0 行 ⇒ 空标准 ⇒ reject）。
   * 于是【dispatch 到顶部人席】这条引擎路线到不了 ESCALATED_TO_CEO —— 补卡机制
   * 的 dispatch 入口死了，但机制本身没死：approveCard 批卡落人席时补下一张
   * （本篇下半部分那些用例，仍全绿）。这一组断言钉的是被拦那轮的正确形状：
   * 不跃迁、不补 seat 卡、只建 gate-blocked 卡、账两行（evidence_bundles + review_gates）
   * + 一条门控审计。若哪天 CEO 拍板放开（接一个读引擎审阅真实事实的评估器），
   * 这一组要随门 4 一起改回原来的形状 —— 那件事记在台账 round359。
   */
  it("IN_REVIEW + pass 且已到顶层 ⇒ 被门 4 拦：停在 IN_REVIEW、moved=false、只在 gate-blocked 族建卡", async () => {
    const { db, res } = await runDispatch({ ...topPass });
    expect(res.status).toBe("IN_REVIEW");
    expect(res.moved).toBe(false);
    // 全量拦下【不】补 seat 卡 —— 那张卡指向 ESCALATED_TO_CEO，而任务从没到过那一格。
    const cards = cardsIn(db);
    expect(cards.length).toBe(1);
    expect(String(cards[0]?.["card_key"])).toContain("gate-blocked:");
    // 摘要要点名：谁（产出方）、为什么（没通过门控）、证据包 sha（可指认）
    expect(String(cards[0]?.["summary"])).toContain("[dev] 的产出没有通过 §8.2 门控");
    expect(res.card).not.toBeNull();
    expect(res.card?.kind).toBe("ApprovalRequired");
    // 门控的账两行 + 一条审计，evidence 引用在 —— §22.4「每个门控决定都有证据包引用」从此可校验
    const rg = db.prepare("SELECT gate_type, decision, round_no FROM review_gates").all() as Row[];
    expect(rg.length).toBe(1);
    expect(String(rg[0]?.["gate_type"])).toBe("engine_review");
    expect(String(rg[0]?.["decision"])).toBe("rejected");
    expect(statusOf(db)).toBe("IN_REVIEW");
  });

  it("gate-blocked 卡【点得动】但【不推进】：批准只是把它记下来（这一族卡的按钮不是跃迁钮）", async () => {
    const { q, db } = await runDispatch({ ...topPass, turn: turn(said({ action: "pass", summary: "全绿" })) });
    const pending = pendingCards(q, "t1");
    expect(pending.length).toBe(1);
    expect(String(pending[0]?.cardKey)).toContain("gate-blocked:");
    const cardsBefore = cardsIn(db).length;
    const r = await approveCard(
      q,
      { taskId: "t1", approvalId: (pending[0] as { id: string }).id, button: "approve", nowMs: NOW + 1000 },
      () => {},
    );
    // outcome=decided（按钮有效、审计记下这次批准），但任务【不】推进 ——
    // dispatch.ts 门 4 那张卡的文件头原文：「批准这张卡不会推进任务」。
    expect(r.outcome).toBe("decided");
    expect(statusOf(db)).toBe("IN_REVIEW");
    // 卡被认领掉（不再是 pending），也不会因此补一张 seat 卡 —— 任务没有动，没有新人席
    expect(pendingCards(q, "t1").length).toBe(0);
    expect(cardsIn(db).length).toBe(cardsBefore);
  });

  it("本轮【每一个消费掉的 seq】都被广播（被拦那轮：gate 审计一条 + 卡一条，无状态边）", async () => {
    const { db, published } = await runDispatch({ ...topPass, turn: turn(said({ action: "pass", summary: "全绿" })) });
    const inDb = seqsIn(db);
    expect(published.length).toBe(inDb.length);
    expect(published.map((p) => p.seq)).toEqual(inDb);
    expect(published.some((p) => p.kind === "ApprovalRequired")).toBe(true);
    // 没有状态边 ⇒ 广播里不该有 TaskStateChanged（那一类只在不跃迁的 wait/驳回轮之外出现）
    expect(published.some((p) => p.kind === "TaskStateChanged")).toBe(false);
    // 门控审计行确实广播了（RoleTurnReported 带 gate_decision）
    expect(published.some((p) => p.kind === "RoleTurnReported")).toBe(true);
    const approvalSeq = (db.prepare("SELECT id FROM events WHERE action='approval'").all() as Row[]).map((r) =>
      Number(r["id"]),
    );
    expect(published.find((p) => p.kind === "ApprovalRequired")?.seq).toEqual(approvalSeq[0]);
    expect(new Set(published.map((p) => p.seq)).size).toBe(published.length);
  });

  it("补卡排在记账钩子【之后】：被拦那轮的账挂 gate 审计行，不挂卡片行", async () => {
    const w = openWorld("IN_REVIEW", "director");
    const cost: { seq: number; cents: number }[] = [];
    const dispatch = makeDispatch({
      writer: w.q,
      ...gateDepsFrom(w.db, TMP + "/artifacts"),
      loadTask: (id) => {
        const r = w.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
        if (r === undefined) return null;
        return {
          id: String(r["id"]),
          title: String(r["title"]),
          status: String(r["status"]) as TaskState,
          role: String(r["assigned_role"]),
          graphVersion: Number(r["graph_version"]),
        };
      },
      modelFamily: (roleId) => String(GRAPH.nodes[roleId]?.["model_family"] ?? ""),
      rolePrompt: (r) => "你是 " + r + "。",
      roleSession: () => null,
      runTurn: async () => turn(said({ action: "pass", summary: "全绿" })),
      recentSummaries: () => [],
      lastProducer: () => "dev",
      rejectionCount: () => 0,
      ceoApproved: () => false,
      onCost: (c) => cost.push({ seq: c.seq, cents: c.costCents }),
      publish: () => {},
    });
    const res = await dispatch({ taskId: "t1", nowMs: NOW, maxBudgetUsd: 0.5 });
    // 被拦 ⇒ 状态没动；stateEventSeq 装的是【本轮最后写下的那条 seq】—— 门控审计行
    //（探针实测 = 2：tool_call 执行 + tool_call 门控审计 + approval 卡）。onCost 的 seq 就是它。
    expect(res.status).toBe("IN_REVIEW");
    expect(cost.length).toBe(1);
    const gateEvents = (w.db.prepare("SELECT id FROM events WHERE action='tool_call' ORDER BY id").all() as Row[]).map((r) =>
      Number(r["id"]),
    );
    expect(gateEvents.length).toBeGreaterThan(0);
    expect(res.stateEventSeq).toBe(gateEvents[gateEvents.length - 1]);
    expect((cost[0] as { seq: number }).seq).toBe(res.stateEventSeq);
  });

  it("chain 的【中间那一格】不是人席 ⇒ 不补卡（IN_PROGRESS → EVIDENCE_SUBMITTED → IN_REVIEW）", async () => {
    const { db, res } = await runDispatch({
      status: "IN_PROGRESS",
      role: "dev",
      turn: turn(said({ action: "pass", summary: "登录模块写完" })),
    });
    expect(res.status).toBe("IN_REVIEW");
    expect(cardsIn(db).length).toBe(0);
  });

  it("没跃迁 ⇒ 不补卡（wait 那一支任务还在 agent 席，收件箱不该多一张）", async () => {
    const { db, res } = await runDispatch({
      status: "IN_PROGRESS",
      role: "dev",
      turn: turn(said({ action: "wait", summary: "等 CI 跑完" })),
    });
    expect(res.moved).toBe(false);
    expect(cardsIn(db).length).toBe(0);
  });

  it("越权交接那张拦截卡与补卡【互斥】：没跃迁那一支只有拦截卡一张", async () => {
    const { db, res } = await runDispatch({
      status: "IN_PROGRESS",
      role: "dev",
      turn: turn(said({ action: "handoff", to_role: "ceo", summary: "直接甩给 CEO" })),
    });
    expect(res.moved).toBe(false);
    const cards = cardsIn(db);
    expect(cards.length).toBe(1);
    expect(String(cards[0]?.["card_key"])).not.toContain(SEAT_CARD_KEY_PREFIX);
  });

  /**
   * round359 语义变更后【删除】了原来的「状态边守卫抛 ⇒ 补的卡一起回滚」：
   *
   * 原测点的保护对象是「dispatch 补卡与状态边同一事务、守卫抛时一起回滚」。
   * 全量拦下 IN_REVIEW + pass 被门 4 拦成 move:false —— dispatch 不再写状态边，
   * 那个守卫（WRITE_EDGE_SQL 的 AND status=?）在这一轮根本不触发；
   * 实测（round359 probe）外部挪走任务后 dispatch 正常 resolved，不抛。
   * 所以「守卫抛 ⇒ 补卡回滚」的对象没了，留着会是一发【结构上不可能红的回归锁】
   * （异侧同源，0046 §9 那一类）。dispatch 侧的同类原子性保护由 approveCard
   * （approve.ts 那条守卫式 UPDATE + stale_card）与 approve.test.ts 承担。
   *
   * 替代测点（保留原意图中仍成立的那一半）：「被拦轮对任务行【零写入】」——
   * 外部把任务挪走，被拦轮不碰它、不产生指向错格子的卡。下面这一发。
   */
  it("被拦轮对任务行零写入：外部挪走任务时，不写状态边、不留指向错格子的卡", async () => {
    // runTurn 期间 CEO 把任务挪走（loadTask 读到缓存旧状态，库里已变）。
    // 被拦轮 move:false ⇒ 不写状态边 ⇒ 不抛；任务停在外部设置的 BLOCKED，
    // 而 gate 卡与账照常落（它们不碰任务行，互相独立）。
    const w = openWorld("IN_REVIEW", "director");
    const dispatch = makeDispatch({
      writer: w.q,
      ...gateDepsFrom(w.db, TMP + "/artifacts"),
      loadTask: () => ({ id: "t1", title: "x", status: "IN_REVIEW", role: "director", graphVersion: 1 }),
      modelFamily: (r) => String(GRAPH.nodes[r]?.["model_family"] ?? ""),
      rolePrompt: () => "",
      roleSession: () => null,
      runTurn: async () => {
        w.db.prepare("UPDATE tasks SET status='BLOCKED' WHERE id='t1'").run();
        return turn(said({ action: "pass", summary: "全绿" }));
      },
      recentSummaries: () => [],
      lastProducer: () => "dev",
      rejectionCount: () => 0,
      ceoApproved: () => false,
      publish: () => {},
    });
    const res = await dispatch({ taskId: "t1", nowMs: NOW, maxBudgetUsd: 0.5 });
    // 不抛、不跃迁：被拦轮对状态零主张 —— 任务停在外部设置的 BLOCKED
    expect(res.moved).toBe(false);
    expect(statusOf(w.db)).toBe("BLOCKED");
    // gate 卡指向【当前格】，不是指向一个从未到达的 ESCALATED_TO_CEO
    const cards = cardsIn(w.db);
    expect(cards.length).toBe(1);
    expect(String(cards[0]?.["card_key"])).toContain("gate-blocked:");
    expect(String(cards[0]?.["card_key"])).not.toContain("seat:");
  });
});

/* ═══════════ 一条任务上两张待批卡：过期那张不能推进当前格（0046 §5）═══════════ */

describe("点【过期那张】不能推进当前这一格", () => {
  /**
   * 0046 §5 那发探针的形状：dev 试一条越权边被拦下 ⇒ 一张拦截卡留在任务上；
   * 任务随后合法升到 ESCALATED_TO_CEO ⇒ 又多一张席位卡。两张都 pending。
   *
   * 探针在补判据【之前】量到的原话：
   *   pending 卡 = 2 ["handoff-block:dev->dev", "seat:ESCALATED_TO_CEO:4"]
   *   点【旧的那张】⇒ outcome=decided，ESCALATED_TO_CEO → FINAL_REVIEW
   * 也就是说 approveCard 只判「卡片属于这条任务 + 是 pending」，不判它属于【哪一格】。
   * 后果是 CEO 回答 A 问题而任务按 B 问题动，且审计里留下一条她没做过的批准。
   */
  /**
   * round359 适配：第二跳不再走 dispatch。全量拦下 IN_REVIEW + pass 被门 4 拦，
   * 任务到不了 ESCALATED_TO_CEO（dispatch 侧到人席的路死了，见上方 describe 注释）。
   * 但这族测试测的是 approveCard 的两卡判据（点旧卡 ≠ 推进当前格），不是门 4 ——
   * 所以「第二张卡存在」这一格改由【直接构造】提供：手动 UPDATE 任务到 CEO 席 +
   * 走真 insertCard 插一张键带状态边 seq 的 seat 卡（与 worldWithCard 同一条写入口径）。
   * 若哪天 CEO 拍板放开门 4（接真实评估器），再把它改回 dispatch 第二跳。
   */
  async function twoPendingCards(): Promise<RunWorld> {
    const w = await runDispatch({
      status: "IN_PROGRESS",
      role: "dev",
      turn: turn(said({ action: "handoff", to_role: "dev", summary: "自己交自己" })),
    });
    expect(cardsIn(w.db).length).toBe(1);
    // 构造任务真的升到 CEO 那一格：状态 + 一条状态边事件（seat 卡的键要带它的 seq）
    w.db
      .prepare("UPDATE tasks SET status='ESCALATED_TO_CEO', assigned_role='ceo', current_node='ceo' WHERE id='t1'")
      .run();
    const stSeq = await w.q.node(() => {
      const info = w.db
        .prepare(
          "INSERT INTO events (task_id, actor_type, actor_id, action, target, payload, created_at) VALUES (?, 'system', 'hub', 'state_change', 'ESCALATED_TO_CEO', ?, ?)",
        )
        .run("t1", JSON.stringify({ kind: "TaskStateChanged", taskId: "t1", from: "IN_REVIEW", to: "ESCALATED_TO_CEO" }), NOW + 1);
      return Number(info.lastInsertRowid);
    });
    await w.q.node(() => {
      insertCard(
        w.db,
        {
          taskId: "t1",
          approvalType: "escalation",
          cardKey: "seat:ESCALATED_TO_CEO:" + String(stSeq),
          summary: "席位卡：CEO 该拍板（测试构造的第二张）",
          parameters: {
            impact_scope: "这一跳的下一步",
            irreversible: true,
            recommendation: "测试构造的席位卡，点批准即前进",
            recommendation_is_not_decision: true,
            timeout_behavior: "escalate",
          },
          evidence_refs: ["events:" + String(stSeq) + "#state_snapshot"],
          buttons: ["approve", "reject_with_comment", "defer_deep_review"],
        },
        { nowMs: NOW + 1 },
      );
      return null;
    });
    // 语义自检：这个形状必须是「一张拦截卡 + 一张 seat 卡、任务在 CEO 席」。
    const keys = pendingCards(w.q, "t1").map((p) => String(p.cardKey)).sort();
    expect(keys).toContain("handoff-block:dev->dev");
    expect(keys.filter((k) => k.startsWith("seat:ESCALATED_TO_CEO:")).length).toBe(1);
    return { ...w, res: { taskId: "t1", status: "ESCALATED_TO_CEO", moved: false, seat: "human", note: "", costCents: 0, sessionId: "", stateEventSeq: stSeq, card: null } as never, published: w.published };
  }

  it("分母：任务升到 CEO 之后【确实】同时有两张 pending（没有这个形状，下面两条都是空判）", async () => {
    const { q, db } = await twoPendingCards();
    const pend = pendingCards(q, "t1");
    expect(pend.length).toBe(2);
    const keys = pend.map((p) => String(p.cardKey)).sort();
    expect(keys).toContain("handoff-block:dev->dev");
    expect(keys.filter((k) => k.startsWith("seat:ESCALATED_TO_CEO:")).length).toBe(1);
    expect(statusOf(db)).toBe("ESCALATED_TO_CEO");
  });

  it("点【旧的那张】拦截卡 ⇒ stale_card、状态不动、一条都不写、真正在等的那张还在", async () => {
    const { q, db } = await twoPendingCards();
    const pend = pendingCards(q, "t1");
    const stale = pend.find((p) => String(p.cardKey).startsWith("handoff-block:"));
    expect(stale).toBeDefined();
    const cardsBefore = cardsIn(db).length;
    const seqsBefore = seqsIn(db).length;

    const r = await approveCard(
      q,
      { taskId: "t1", approvalId: String(stale?.id), button: "approve", nowMs: NOW + 10 },
      () => {},
    );
    expect(r.outcome).toBe("stale_card");
    expect(r.edgeExists).toBe(false);
    // 探针里这一发是 "decided" + ESCALATED_TO_CEO → FINAL_REVIEW。现在它必须原地不动。
    expect(statusOf(db)).toBe("ESCALATED_TO_CEO");
    // 一条都没写：卡片没被认领、审计没有那条她没做过的批准
    expect(cardsIn(db).length).toBe(cardsBefore);
    expect(seqsIn(db).length).toBe(seqsBefore);
    expect(String(stale?.id)).not.toBe("");
    // 旧卡【仍然 pending】：它没有被顺手关掉（关掉 = 替 CEO 做了一个她没做的决定）
    expect(pendingCards(q, "t1").map((p) => String(p.cardKey))).toContain(String(stale?.cardKey));
    // 那句人话要点名【该点哪张】，否则 CEO 只知道"不行"而下一步还是点同一张
    expect(r.note).toContain("seat:ESCALATED_TO_CEO:");
  });

  it("点【当前格那张】⇒ 照常推进（判据不是【收件箱只许一张卡】）", async () => {
    const { q, db } = await twoPendingCards();
    const pend = pendingCards(q, "t1");
    const own = pend.find((p) => String(p.cardKey).startsWith("seat:ESCALATED_TO_CEO:"));
    expect(own).toBeDefined();
    const r = await approveCard(q, { taskId: "t1", approvalId: String(own?.id), button: "approve", nowMs: NOW + 10 }, () => {});
    expect(r.outcome).toBe("decided");
    expect(r.to).toBe("FINAL_REVIEW");
    expect(statusOf(db)).toBe("FINAL_REVIEW");
  });

  it("过期那张仍然可以【打回 / 暂缓】：挡掉 approve 而不挡 reject，否则它永远挂在待批数里", async () => {
    const { q, db } = await twoPendingCards();
    const pend = pendingCards(q, "t1");
    const stale = pend.find((p) => String(p.cardKey).startsWith("handoff-block:"));
    const r = await approveCard(
      q,
      {
        taskId: "t1",
        approvalId: String(stale?.id),
        button: "reject_with_comment",
        note: "这次越权我不批，先记下",
        nowMs: NOW + 10,
      },
      () => {},
    );
    expect(r.outcome).toBe("decided");
    expect(r.edgeExists).toBe(false);
    expect(statusOf(db)).toBe("ESCALATED_TO_CEO");
    // 它从此不再是 pending ⇒ 待批数减一（收件箱能减法，才是"一人公司"看得懂的清单）
    const after = pendingCards(q, "t1");
    expect(after.length).toBe(1);
    expect(String(after[0]?.cardKey)).toContain("seat:ESCALATED_TO_CEO:");
  });

  it("当前格【没有】自己的卡时不挡（补卡之前落库的存量任务不能被判成永久批不动）", async () => {
    // 存量形状：任务停在人席、手上只有一张"别的来源"的卡（这里拿拦截卡当替身）。
    const { q, db } = await runDispatch({
      status: "IN_PROGRESS",
      role: "dev",
      turn: turn(said({ action: "handoff", to_role: "dev", summary: "自己交自己" })),
    });
    db.prepare("UPDATE tasks SET status='ESCALATED_TO_CEO' WHERE id='t1'").run();
    const pend = pendingCards(q, "t1");
    expect(pend.length).toBe(1);
    const r = await approveCard(q, { taskId: "t1", approvalId: (pend[0] as { id: string }).id, button: "approve", nowMs: NOW + 10 }, () => {});
    // 沿用旧行为：能推进。白名单写法在这一发上会变成 stale_card ⇒ 那张卡既推不动也批不掉，
    // 而"CEO 看着一张待批卡而一个按钮都点不动"正是本篇在修的那个症状的镜像。
    expect(r.outcome).toBe("decided");
    expect(r.to).toBe("FINAL_REVIEW");
  });

  it("CHARTER_PENDING 那一格认的是 charter.ts 的键（本模块不生产它，判据得跟着它定义）", async () => {
    const w = await worldWithCard("CHARTER_PENDING");
    const pend = pendingCards(w.q, "t1");
    const r = await approveCard(w.q, { taskId: "t1", approvalId: (pend[0] as { id: string }).id, button: "approve", nowMs: NOW + 10 }, () => {});
    expect(r.outcome, "charter:proposal 就是那一格自己的入口卡").toBe("decided");
  });
});


/** 一张挂在任务上的【待批卡】（收件箱里那张的替身：真 insertCard，不是手写 INSERT）。 */
/* ═══════════════════ approveCard 落人席 ⇒ 同事务补下一张 ═══════════════════ */

async function worldWithCard(status: string, role = CEO): Promise<World> {
  const w = openWorld(status, role);
  const draft: NewCardDraft = {
    taskId: "t1",
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
  await w.q.node(() => {
    insertCard(w.db, draft, { nowMs: NOW });
    return null;
  });
  return w;
}

describe("approveCard 落到人席时补下一张（否则「批过一步就再也点不动」）", () => {
  it("ESCALATED_TO_CEO 上点批准 ⇒ FINAL_REVIEW + 【新的一张】终审卡，键带着那条状态边的 seq", async () => {
    const w = await worldWithCard("ESCALATED_TO_CEO");
    const before = pendingCards(w.q, "t1");
    const r = await approveCard(
      w.q,
      { taskId: "t1", approvalId: (before[0] as { id: string }).id, button: "approve", nowMs: NOW + 1000 },
      () => {},
    );
    expect(r.to).toBe("FINAL_REVIEW");
    const after = pendingCards(w.q, "t1");
    // 「已批掉的那张」不算欠的决定：这张表要能答「还欠几个」（0026 §9 那一族）
    expect(after.length).toBe(1);
    expect((after[0] as { id: string }).id).not.toBe((before[0] as { id: string }).id);
    const row = w.db.prepare("SELECT card_key, summary FROM approvals WHERE id = ?").get((after[0] as { id: string }).id) as Row;
    expect(String(row["card_key"])).toContain("seat:FINAL_REVIEW:");
    // 键的身份 = 【刚才那条状态边】的 seq，不是决策那条
    const stateSeq = Number(
      ((w.db.prepare("SELECT id FROM events WHERE action='state_change'").all() as Row[])[0] as Row)["id"],
    );
    expect(String(row["card_key"])).toBe("seat:FINAL_REVIEW:" + String(stateSeq));
  });

  it("CHARTER_PENDING 上点批准 ⇒ 落 CHARTER_APPROVED（agent 席）⇒ 【不】补卡", async () => {
    const w = await worldWithCard("CHARTER_PENDING");
    const before = pendingCards(w.q, "t1");
    await approveCard(w.q, { taskId: "t1", approvalId: (before[0] as { id: string }).id, button: "approve", nowMs: NOW + 1000 }, () => {});
    expect(statusOf(w.db)).toBe("CHARTER_APPROVED");
    // 只有被批掉的那一张，没有第二张
    expect(cardsIn(w.db).length).toBe(1);
  });

  it("⭐ 只点卡片，从 ESCALATED_TO_CEO 一路点到 DELIVERED（金色路径，中途没有夹具替我建卡）", async () => {
    // round359 适配：入口不再用 dispatch —— 全量拦下 IN_REVIEW + pass 出不了
    // ESCALATED_TO_CEO 那一格（见上方 describe 注释）。金色路径测的是
    // 【approveCard 批卡 → 补下一张】整条链，起点改为直接构造
    // 「任务在 CEO 席 + 一张键带状态边 seq 的 seat 卡」（与 twoPendingCards 同一条构造路）。
    const w = openWorld("ESCALATED_TO_CEO", CEO);
    const stSeq = await w.q.node(() => {
      const info = w.db
        .prepare(
          "INSERT INTO events (task_id, actor_type, actor_id, action, target, payload, created_at) VALUES (?, 'system', 'hub', 'state_change', 'ESCALATED_TO_CEO', ?, ?)",
        )
        .run("t1", JSON.stringify({ kind: "TaskStateChanged", taskId: "t1", from: "IN_REVIEW", to: "ESCALATED_TO_CEO" }), NOW);
      return Number(info.lastInsertRowid);
    });
    await w.q.node(() => {
      insertCard(
        w.db,
        {
          taskId: "t1",
          approvalType: "escalation",
          cardKey: "seat:ESCALATED_TO_CEO:" + String(stSeq),
          summary: "席位卡：CEO 该拍板",
          parameters: {
            impact_scope: "这一跳的下一步",
            irreversible: true,
            recommendation: "测试构造的席位卡，点批准即前进",
            recommendation_is_not_decision: true,
            timeout_behavior: "escalate",
          },
          evidence_refs: ["events:" + String(stSeq) + "#state_snapshot"],
          buttons: ["approve", "reject_with_comment", "defer_deep_review"],
        },
        { nowMs: NOW },
      );
      return null;
    });
    const { q, db } = w;
    const clicks: string[] = [];
    // 至多两次；循环上限给到 4 是为了让「永远点不完」这一支以断言失败收场而不是悄悄通过。
    for (let i = 0; i < 4; i++) {
      const pending = pendingCards(q, "t1");
      if (pending.length === 0) break;
      expect(pending.length, "每一格只欠一个决定").toBe(1);
      const r = await approveCard(
        q,
        { taskId: "t1", approvalId: (pending[0] as { id: string }).id, button: "approve", nowMs: NOW + 1000 * (i + 1) },
        () => {},
      );
      expect(r.outcome).toBe("decided");
      // 建了一张点不动的卡 = 收件箱有东西而任务推不动，这比收件箱空更难查
      expect(r.edgeExists, "卡片指着一条没有出边的格子").toBe(true);
      clicks.push(r.from + "→" + r.to);
    }
    expect(clicks).toEqual(["ESCALATED_TO_CEO→FINAL_REVIEW", "FINAL_REVIEW→DELIVERED"]);
    expect(statusOf(db)).toBe("DELIVERED");
    // DELIVERED 是终点：收件箱为空 = 真的没有欠的决定
    expect(pendingCards(q, "t1").length).toBe(0);
    // 两张：dispatch 补的升级卡 + 批准时补的终审卡（两张都被批掉了）
    expect(cardsIn(db).length).toBe(2);
  });

  it("打回那一颗按钮 ⇒ 卡片记掉、任务不动、【不】补新卡（没有出边就不假装下一格存在）", async () => {
    const w = await worldWithCard("ESCALATED_TO_CEO");
    const before = pendingCards(w.q, "t1");
    const r = await approveCard(
      w.q,
      {
        taskId: "t1",
        approvalId: (before[0] as { id: string }).id,
        button: "reject_with_comment",
        note: "清单里那三条先补两条",
        nowMs: NOW + 1000,
      },
      () => {},
    );
    expect(r.edgeExists).toBe(false);
    expect(statusOf(w.db)).toBe("ESCALATED_TO_CEO");
    // 只有一张（被打回的那张）。补一张新卡的话，收件箱会「永远有一张在等」而任务原地不动。
    expect(cardsIn(w.db).length).toBe(1);
    expect(pendingCards(w.q, "t1").length).toBe(0);
  });
});
