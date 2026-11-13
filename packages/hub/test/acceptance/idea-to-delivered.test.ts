/**
 * 一条想法从【下发】走到【交付】—— 引擎路线上的端到端一发（规格 Phase 0 的验收口径）。
 *
 * ── 规格原话（docs/OPC-OS-设计文档.md:1676）────────────────────────────
 *  「从 Phase 0 的「最小可运行图」开始：**想法 → 章程 → 产品拆解 → 技术拆解 → 开发 →
 *   测试 → 上报（线性无分支）**，用预设岗位书模板跑通一个端到端测试任务」
 *
 * ── 为什么还要再写一发，而现有那些绿不发不算 ──────────────────────────
 * 每一段各自都有测试，而且绿得挺好：seat-card.test.ts 有一条「只点卡片，从
 * ESCALATED_TO_CEO 一路点到 DELIVERED」（**起点是 CEO 那格**，前半段是夹具直接
 * 把任务摆在 IN_REVIEW 上），dispatch.test.ts 问的是【单轮的门】，driver-pump.test.ts
 * 问的是【谁去敲回车】。而**全仓没有任何一发**从 CHARTER_PENDING（CEO 刚下发完
 * 那一格）开始、中途不摆位置、一路走到 DELIVERED。
 * 分段各自的绿盖不住的那类失效是【接缝】：CHARTER_APPROVED 那一格的负责人是谁、
 * 谁有权在 DECOMPOSING 那一格把活儿交下去、审阅通过之后下一格归谁 ——
 * 每一格单独看都自洽，接起来可能走到一半没人接手。本篇探针实测到的正是这种：
 * 任务一落地如果把 assigned_role 写成 ceo，第二发 dispatch 就被【人类席位】那道门
 * 挡死，而 dispatch/approve/driver 三边各自全绿。
 *
 * ── 这一发用的是【真装配】，不是我把函数换成希望它长的样子 ────────────
 *  · 任务由 real-deps.insertTask 建（生产唯一建任务入口，graph_version 与 INSERT 同事务）
 *  · 章程卡由 engine/charter.ensureCharterCard 起草（不是手搓一张卡）
 *  · dispatch 的 deps 出自 engine/runtime.makeRuntime —— loadTask / lastProducer /
 *    rejectionCount / ceoApproved / modelFamily / onCost **全是生产 SQL**，
 *    只替换 runTurn 那一格（导演出每一轮的嘴）
 *  · 每一轮之后按 driver.ts:76 那个形状调 rt.recordTurn（漏调的话 harness_calls 会空，
 *    而 0048 §4 记过那一列的口径，这里顺手钉住）
 *  · CEO 那几步走的是 engine/approve.approveCard —— 收件箱里那张卡被点掉的同一条写路径
 *
 * ── 两发的差别是【审阅独立性】，而它改变的是你要点几次 ────────────────
 * A 发：各角色分属不同模型家族 ⇒ 审阅直接通过 ⇒ CEO 点 **3** 次。
 * B 发：全家同一家族（**今天的真实配置**：组织节点不写 model_family 就都是空/同族，
 *       0041 §5 记的那件事）⇒ reviewGate 拦一次、CEO 点一张同源豁免卡 ⇒ **4** 次。
 * 两发都到 DELIVERED。把这个数字钉住是因为「一人公司」的卖点就是**你只点几下**，
 * 而那几下今天是几个，之前只能靠我口算。
 *
 * 跑法（离线、node v24.14.0）：
 *   PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH \
 *     node --experimental-transform-types --import /tmp/opc-harness/register.mjs \
 *     --test packages/hub/test/acceptance/idea-to-delivered.test.ts
 */
import { mkdirSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { OrgGraph } from "@opc/contracts";
import { fixtureTmp } from "../fixtures/fixture-dir.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { migrate } from "../../src/db/migrate.js";
import { INSERT_DELEGATION_GRAPH_SQL } from "../../src/org/commit.js";
import { InMemoryEventBus, type EventBus } from "../../src/events/bus.js";
import { makeRuntime } from "../../src/engine/runtime.js";
import { makeDispatch, type RunTurnInput, type TurnOutcome } from "../../src/engine/dispatch.js";
import { ensureCharterCard } from "../../src/engine/charter.js";
import { approveCard, pendingCards } from "../../src/engine/approve.js";
import { insertTask } from "../../src/http/real-deps.js";

const TMP = fixtureTmp("acceptance-idea-to-delivered", import.meta.url);
const NOW = 1_700_000_000_000;
const CEO = "ceo";
const TASK_ID = "t-idea-1";
const IDEA_TITLE = "做个 AI 笔记应用";

type Row = Record<string, unknown>;

/**
 * 汇报树：ceo ← intake ← director ← dev。
 *
 * 为什么不是 ceo ← director ← dev 那套两层的：任务一落地归 intake（real-deps 的
 * createTask 把 assignedRole 写成 intakeRole，而章程就是 intake 起草的），
 * 两层图里 intake 是【叶子】⇒ DECOMPOSING 那一格 handoff 给 dev 会撞
 * handoffGate 的 not_downstream。探针实测踩过一次，这张图是那次踩完定的。
 *
 * 深度三层（intake / director / dev）是【到顶】这条路能走完的最小形状：
 * director 通过之后还有 intake 要接手，intake 通过之后上级才是 CEO 本人 ——
 * 于是 planEdge 的 topmost 分支与「上级是 CEO 本人」那条分支【各走一次】，
 * 两条都在轨迹里留下格子。少一层就只测到其中一条。
 */
function graphOf(families: Record<string, string>): OrgGraph {
  const node = (roleId: string, reportsTo: string | null, canManage: boolean): OrgGraph["nodes"][string] => ({
    role_id: roleId,
    can_manage: canManage,
    reports_to: reportsTo,
    model_family: families[roleId] ?? "",
  });
  return {
    nodes: {
      ceo: node(CEO, null, true),
      intake: node("intake", CEO, true),
      director: node("director", "intake", true),
      dev: node("dev", "director", false),
    },
    edges: [],
  };
}

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

/** 角色吐出来的那段文字里，决策块之外的部分是【给人看的正文】。 */
const said = (o: Record<string, unknown>) => "干完了。\n\n<<<OPC_DECISION>>>\n" + JSON.stringify(o);

interface World {
  readonly q: WriteQueue;
  readonly db: DatabaseSync;
  /** 广播到的 seq → 事件 kind（与 events 表对账用）。 */
  readonly broadcast: Map<number, string>;
  /** 走完全程。返回轨迹与 CEO 点了几次。 */
  readonly walk: () => Promise<{ readonly trail: string[]; readonly clicks: string[]; readonly rounds: number }>;
}

/**
 * 建世界 + 走完全程。
 *
 * @param families 每个角色的模型家族。空串/同值 ⇒ 触发同源审阅（今天的真实配置）。
 */
async function world(families: Record<string, string>): Promise<World> {
  const q = new WriteQueue(TMP + "/w-" + process.pid + "-" + ++fileSeq + ".db");
  queues.push(q);
  const db = q.writeConnection();
  migrate(db);
  db.prepare(INSERT_DELEGATION_GRAPH_SQL).run(
    "g1",
    1,
    JSON.stringify(graphOf(families)),
    NOW,
    CEO,
    "端到端这一发用的组织图",
  );
  // 生产唯一的建任务入口。探针实测：这一发的第一步如果用裸 INSERT 而把
  // assigned_role 写成 ceo，第二轮 dispatch 就被人类席位那道门挡死，
  // 而三边各自的测试全绿 —— 所以这里【必须】走 insertTask 而不是我自己摆一行。
  await insertTask(q, {
    id: TASK_ID,
    title: IDEA_TITLE,
    assignedRole: "intake",
    nowMs: NOW,
  });

  const bus = new InMemoryEventBus();
  /**
   * 广播记录。**不是**把总线换成桩 —— 每一发都原样转给真 InMemoryEventBus，
   * 所以总线自己那两条守卫（seq 必须严格递增、订阅者收得到）照旧参与，
   * 这一层只是【顺手抄一份 seq】，好和 events 表里那一份对账。
   *
   * 为什么不直接 for-await 那个订阅：订阅是一条【活着的流】，队列空而没 close 时
   * next() 会一直等（bus.ts:256），在一发同步推进的测试里那样会挂住。
   */
  const broadcast = new Map<number, string>();
  const recordingBus: EventBus = {
    publishPersisted: (e, seq) => {
      broadcast.set(seq, e.kind);
      bus.publishPersisted(e, seq);
    },
    subscribe: (fromSeq) => bus.subscribe(fromSeq),
    latestSeq: () => bus.latestSeq(),
  };

  const rt = makeRuntime({
    writer: q,
    bus: recordingBus,
    maxBudgetUsd: 0.5,
    taskLimitCents: 100_000,
    cwd: TMP,
    ceoRoleId: CEO,
    nowMs: () => NOW,
  });

  const status = () =>
    String((db.prepare("SELECT status FROM tasks WHERE id = ?").get(TASK_ID) as Row)["status"]);
  const roleAt = () =>
    String(
      (db.prepare("SELECT assigned_role FROM tasks WHERE id = ?").get(TASK_ID) as Row)["assigned_role"],
    );

  /**
   * 每一格该说什么。**只有台词是我导演的**，其余全是生产代码在判。
   * 找不到台词 ⇒ 抛，而不是给一句"没台词"的默认：默认值会把「走进了一格我们
   * 没预料到的路」伪装成「这一轮没推进」，而这一发要测的恰恰是路走对了没有。
   */
  const lineFor = (s: string): Record<string, unknown> => {
    if (s === "CHARTER_APPROVED") return { action: "pass", summary: "章程已签，这件事拆给 dev" };
    if (s === "DECOMPOSING") return { action: "handoff", to_role: "dev", summary: "先做最小可用版" };
    if (s === "IN_PROGRESS") return { action: "pass", summary: "写完了，覆盖率 92%，3 个 P2 待后续" };
    if (s === "IN_REVIEW") return { action: "pass", summary: "独立审过了，可上线" };
    throw new Error("走到一条这一发没预期的格子：" + s + "（不该继续，别用默认台词糊过去）");
  };
  let say: Record<string, unknown> = { action: "pass", summary: "(还没轮到)" };

  const dispatch = makeDispatch({
    ...rt.deps,
    runTurn: async (_i: RunTurnInput): Promise<TurnOutcome> => ({
      ok: true,
      text: said(say),
      costCents: 4,
      sessionId: "sess-1",
      error: null,
    }),
  });

  const walk = async () => {
    // ── 第 0 步：章程卡由【生产写入方】起草，不是我手搓一张 ──────────
    const charter = await ensureCharterCard(
      q,
      { taskId: TASK_ID, nowMs: NOW, maxBudgetUsd: 0.5 },
      {
        runTurn: async () => ({
          ok: true,
          text: said({ action: "pass", summary: "章程五栏拟好" }),
          costCents: 3,
          sessionId: "sess-0",
          error: null,
        }),
        rolePrompt: (roleId: string) => "你是 " + roleId + "。",
        ceoRoleId: CEO,
        // 与 runtime 给 dispatch 的那一份【同一个函数】：同一套金额校验、同一个
        // source_event 幂等键、同一句 UPDATE。不传的话章程那一轮花的钱不落账
        // —— 我第一发就是这么漏的（少 3 美分，而两侧各自全绿）。
        ...(rt.deps.onCost === undefined ? {} : { onCost: rt.deps.onCost }),
        publish: (e, seq) => {
          recordingBus.publishPersisted(e, seq);
        },
      },
    );
    if (charter.outcome !== "drafted") {
      throw new Error("章程卡没起草出来（outcome=" + charter.outcome + "），下面每一步都会假红");
    }

    const cells: string[] = [];
    /** 只在【格子真的换了】时记一笔。豁免那一跳不换格子，它由 clicks 表达。 */
    const push = () => {
      const cell = status() + "/" + roleAt();
      if (cells[cells.length - 1] !== cell) cells.push(cell);
    };
    push();
    const clicks: string[] = [];
    let rounds = 0;

    // 「看见卡就点，没卡才让 agent 跑一轮」—— 这就是 CEO 那一侧的全部操作，
    // 也正是 --driver-pump 在服务端做的事。循环上限 20：真退化成交替踢皮球时
    // 这一发会以断言失败收场，而不是悄悄跑到天荒地老。
    for (let i = 0; i < 20; i++) {
      if (status() === "DELIVERED") break;
      const pending = pendingCards(q, TASK_ID);
      if (pending.length > 0) {
        // 一格【至多欠一个决定】。多于一个就是 0041 §5 / 0046 §7 那两格登记的
        // 「收件箱里同一条任务两张 pending」的形状，那种情况下点哪张都不对。
        expect(pending.length, "第 " + i + " 步：收件箱里同一条任务欠了 " + pending.length + " 个决定").toBe(1);
        const r = await approveCard(
          q,
          { taskId: TASK_ID, approvalId: onlyCardId(pending), button: "approve", nowMs: NOW + 1000 + clicks.length },
          (e, seq) => {
            recordingBus.publishPersisted(e, seq);
          },
        );
        expect(r.outcome, "点不掉那张卡：" + r.note).toBe("decided");
        clicks.push(r.from + "→" + r.to);
        push();
        // 「建了一张点不动的卡」比「收件箱空着」更难查（seat-card 那条金色路径同一条理由）
        if (r.to !== "IN_REVIEW") expect(r.edgeExists, "卡片指着一条没有出边的格子：" + r.to).toBe(true);
        continue;
      }
      say = lineFor(status());
      const r = await dispatch({ taskId: TASK_ID, nowMs: NOW + 2000 + rounds, maxBudgetUsd: 0.5 });
      // 与 driver.ts:76 同一形状。不调它 = 真花掉的 token 在执行日志里消失。
      await rt.recordTurn({
        taskId: r.taskId,
        role: r.role,
        sessionId: r.sessionId,
        costCents: r.costCents,
        ok: r.seat === "agent",
        nowMs: NOW + 2000 + rounds,
      });
      rounds += 1;
      // 每轮【要么状态推进，要么交到人手上】。不能要求"必然推进"：
      // 同源审阅那一拦就是不推进而建一张豁免卡（那张卡的 impact 字段自己写着它买的是
      // 「下一轮的审阅放行」，判据住在规格 §8.2 第 1 条 / §24 风险 1），
      // 那种没推进是【设计如此】。而"既没推进也没建卡"才是真的空转 —— 那一格
      // 是本发要抓的：钱花了而屏幕上什么都没有（0050 §6.1 那一族）。
      if (!r.moved && r.card === null) {
        throw new Error(
          "第 " + rounds + " 轮【既没推进也没建卡】 状态=" + status() + "/" + roleAt() + " note=" + r.note,
        );
      }
      push();
    }
    const trail = cells;
    return { trail, clicks, rounds };
  };

  return { q, db, broadcast, walk };
}

/**
 * 收件箱里那一张卡的 id。上面那发断言已经判过「恰好 1 张」，这里再判一次不是因为不信它，
 * 而是因为 `pending[0]` 的类型是 `CardRow | undefined`（noUncheckedIndexedAccess），
 * 而 `!` 会把「这里为什么安全」交给读者脑补。
 */
function onlyCardId(pending: readonly { readonly id: string }[]): string {
  const first = pending[0];
  if (first === undefined) throw new Error("收件箱刚被读成非空而下一句就空了（同一事务内不该可能）");
  return first.id;
}

/** 事件表里真实存在的 seq 集合，与总线上收到的集合比对 ⇒ 有没有洞。 */
function eventSeqs(db: DatabaseSync): number[] {
  return (db.prepare("SELECT id FROM events ORDER BY id").all() as Row[]).map((r) => Number(r["id"]));
}

describe("⭐ 一条想法从下发走到交付（引擎路线上的端到端）", () => {
  it("A 发：各角色分属不同模型家族 ⇒ 3 次点击、5 轮 agent 走到 DELIVERED", async () => {
    const w = await world({
      ceo: "opus",
      intake: "opus",
      director: "sonnet",
      dev: "claude",
    });
    const { trail, clicks, rounds } = await w.walk();

    // ── 轨迹钉成【具体格子】而不是"最后到了 DELIVERED" ────────────────
    // 只断终点会放过一整类失效：中间绕了一格、或者某一步由夹具替我摆过去的。
    // 每一格都认得出来是谁在那儿干活，这条轨迹才是「各个 agent 吭哧吭哧干活」这件事的证据。
    expect(trail).toEqual([
      "CHARTER_PENDING/intake",
      "CHARTER_APPROVED/intake",
      "DECOMPOSING/intake",
      "IN_PROGRESS/dev",
      "IN_REVIEW/director",
      "IN_PROGRESS/intake",
      "ESCALATED_TO_CEO/intake",
      "FINAL_REVIEW/intake",
      "DELIVERED/intake",
    ]);
    // 五轮 agent：拆解那格、交活儿那格、dev 交产出、director 审、intake 再往上报
    expect(rounds).toBe(5);
    // 你（CEO）一共只点三下：签章程、批上线、终审放行。
    expect(clicks).toEqual([
      "CHARTER_PENDING→CHARTER_APPROVED",
      "ESCALATED_TO_CEO→FINAL_REVIEW",
      "FINAL_REVIEW→DELIVERED",
    ]);

    // 负责角色【从来没有】变成 ceo —— 0047 §1 / 0050 §6.3 那条不变量：
    // 一次「升给 CEO 看」不是一次组织分配。approveCard 原值回填，写错就永久留着。
    expect(role(w.db)).toBe("intake");

    // 交付之后【不欠任何决定】：收件箱为空才是「真的走完了」，
    // 否则屏幕上会留一张永远点不掉的卡。
    expect(pendingCards(w.q, TASK_ID).length).toBe(0);

    // ── 钱与账：这条路上真的花过钱，而钱落在【库里】而不只在进程里 ────
    const budget = w.db
      .prepare("SELECT scope_type, limit_cents, consumed_cents FROM budgets WHERE scope_id = ?")
      .get(TASK_ID) as Row;
    expect(String(budget["scope_type"])).toBe("task");
    // 5 轮 × 4 美分 + 章程那一发 3 美分 = 23。钉死这个数字的理由同 0050 §6.7：
    // 「有钱被记上」本身没有内容，多了少了都可能是别的东西在补。
    expect(Number(budget["consumed_cents"])).toBe(23);

    // 每一轮都在执行日志里留痕（§12.7 第 4 层）。漏调 recordTurn 的话这里是 0，
    // 而 dispatch 与 approve 两侧各自的测试全绿。
    const calls = w.db
      .prepare("SELECT COUNT(*) AS n FROM harness_calls WHERE task_id = ?")
      .get(TASK_ID) as Row;
    expect(Number(calls["n"])).toBe(5);

    // 留痕【归在谁名下】。这一列的口径是 0048 §4.1 量出来的，不是「谁被叫去干活」：
    // 它等于「这一轮跑完之后 tasks.assigned_role 的值」—— 换人时是接手人，
    // 不换人时（升到 CEO 那两支持的是产出方自己）就是产出方。
    // 只断条数挡不住"角色记错"：五条全记成 dev 也是 5 条，而查账的人据此会以为
    // 每一格都是 dev 在干活。按 created_at 排序而不是按 id —— id 是 randomUUID，
    // 我在探针里看到它【碰巧】和插入顺序一致，那不可依赖（每轮的 nowMs 是错开的）。
    const owners = (
      w.db
        .prepare(
          "SELECT agent_role FROM harness_calls WHERE task_id = ? ORDER BY created_at, rowid",
        )
        .all(TASK_ID) as Row[]
    ).map((r) => String(r["agent_role"]));
    expect(owners).toEqual([
      "intake", // 拆章程之后仍是 intake 持有
      "dev", // intake 交棒 ⇒ 记账跟着【接手人】
      "director", // dev 交产出 ⇒ 升给审阅者
      "intake", // director 通过 ⇒ 活儿回到 intake（planEdge 的非顶层分支）
      "intake", // intake 再上报 ⇒ 上级是 CEO ⇒ 这一支记的是【产出方自己】
    ]);

    // 状态边一条不少：9 个格子 = 8 跳，加上自动补的那两格
    //（EVIDENCE_SUBMITTED → IN_REVIEW 在 dev 那一轮里自动补，§7.1 它只有一个出口）
    const edges = w.db
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND action = 'state_change' " +
          "AND json_valid(payload) = 1 AND json_extract(payload, '$.kind') = 'TaskStateChanged'",
      )
      .get(TASK_ID) as Row;
    // 11 条，逐格对得上（每条都是一个真实发生过的跃迁，含 hub 自动补的那几格）：
    //   1 CHARTER_PENDING→CHARTER_APPROVED   （CEO 签章程）
    //   2 CHARTER_APPROVED→DECOMPOSING       （intake 开始拆）
    //   3 DECOMPOSING→IN_PROGRESS            （交给 dev）
    //   4 IN_PROGRESS→EVIDENCE_SUBMITTED     （dev 交产出）
    //   5 EVIDENCE_SUBMITTED→IN_REVIEW       （hub 自动，§7.1 它只有一个出口）
    //   6 IN_REVIEW→IN_PROGRESS              （director 通过，活儿回到 intake 手上）
    //   7 IN_PROGRESS→EVIDENCE_SUBMITTED     （intake 再交一次）
    //   8 EVIDENCE_SUBMITTED→IN_REVIEW       （hub 自动，同上）
    //   9 IN_REVIEW→ESCALATED_TO_CEO         （intake 的上级是 CEO 本人 ⇒ 升上去）
    //  10 ESCALATED_TO_CEO→FINAL_REVIEW      （CEO 批上线）
    //  11 FINAL_REVIEW→DELIVERED             （CEO 终审放行）
    // EVIDENCE_SUBMITTED 出现【两次】不是绕路：dev 与 intake 各自交了一次产出。
    expect(Number(edges["n"])).toBe(11);

    // 每一个落库的 seq 都被广播过（写库而不广播 = 活连接上每次批准撞一个空洞）。
    // 判据是【两个集合相等】而不是"广播数 > 0"：后者在一条都没广播时也成立不了，
    // 但它挡不住"广播了三条而库里有九条"这种少广播的形状。
    expect([...w.broadcast.keys()].sort((a, b) => a - b)).toEqual(eventSeqs(w.db));
  });

  it("B 发：全家同一模型家族（今天的真实配置）⇒ 多一次同源豁免，CEO 点 4 次", async () => {
    const w = await world({
      ceo: "opus",
      intake: "opus",
      director: "opus",
      dev: "opus",
    });
    const { trail, clicks, rounds } = await w.walk();

    // 与 A 发唯一的差别：director 那一审被 reviewGate 拦一次（产出方 dev 与审阅者
    // director 同族，§24 风险 1），CEO 点一张【同源豁免】卡。
    //
    // ⚠ 而轨迹【和 A 发一模一样】，九格不少不多 —— 这不是断言写松了，这正是那一跳的性质：
    // 豁免卡买的是「下一轮的审阅放行」，它【不推进状态】（点击记在 clicks 里，
    // 那才是它有信息量的地方：多出来的是【你的一次点击】，不是一格状态）。
    // 所以 A/B 两发的差别只在 clicks（3 → 4）与 rounds（5 → 6）上，而轨迹相同。
    // 如果哪天豁免改成顺手推一格，这条 toEqual 会红 —— 那是【该红】的：
    // 那意味着「同源审阅那一拦不再只是拦一次」，而它是规格 §8.2 第 1 条
    // （作者不给自己打分）那条设计的整个前提。
    expect(trail).toEqual([
      "CHARTER_PENDING/intake",
      "CHARTER_APPROVED/intake",
      "DECOMPOSING/intake",
      "IN_PROGRESS/dev",
      "IN_REVIEW/director",
      "IN_PROGRESS/intake",
      "ESCALATED_TO_CEO/intake",
      "FINAL_REVIEW/intake",
      "DELIVERED/intake",
    ]);
    expect(clicks).toEqual([
      "CHARTER_PENDING→CHARTER_APPROVED",
      // 豁免卡：批了而任务【不动】（它买的是「下一轮的审阅放行」，不是一格状态）
      "IN_REVIEW→IN_REVIEW",
      "ESCALATED_TO_CEO→FINAL_REVIEW",
      "FINAL_REVIEW→DELIVERED",
    ]);
    expect(rounds).toBe(6);
    expect(pendingCards(w.q, TASK_ID).length).toBe(0);

    // 6 轮 × 4 + 章程 3 = 27
    const budget = w.db.prepare("SELECT consumed_cents FROM budgets WHERE scope_id = ?").get(TASK_ID) as Row;
    expect(Number(budget["consumed_cents"])).toBe(27);

    // 状态边【与 A 发逐条相同】= 11 条。这是上面那句「轨迹相同」的另一半证据：
    // 同源豁免那一跳连一条状态边都不写（它只往收件箱里放一张卡）。
    // 我第一版把这里的数外推成 13（以为多一次豁免就多一条边），实测 11 ⇒ 断在这里。
    const edges = w.db
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND action = 'state_change' " +
          "AND json_valid(payload) = 1 AND json_extract(payload, '$.kind') = 'TaskStateChanged'",
      )
      .get(TASK_ID) as Row;
    expect(Number(edges["n"])).toBe(11);

    // 6 轮 ⇒ 6 行留痕。A 发还另外断了【归在谁名下】，这里刻意不重复那份断言：
    // 豁免那一轮多出来的是【同一个角色的第二轮】，角色序列与 A 不同源，
    // 抄一份五格名单过来会把「B 只是多一次点击」这件事说成一件我没证的事。
    const calls = w.db
      .prepare("SELECT COUNT(*) AS n FROM harness_calls WHERE task_id = ?")
      .get(TASK_ID) as Row;
    expect(Number(calls["n"])).toBe(6);
  });
});

function role(db: DatabaseSync): string {
  return String(
    (db.prepare("SELECT assigned_role FROM tasks WHERE id = ?").get(TASK_ID) as Row)["assigned_role"],
  );
}
