/**
 * 「CEO 说不」之后，这个问题必须【再被问一次】—— 而不是永远不再被问。
 *
 * ── 这一发测的是整条链，不是任何一个函数 ────────────────────────────
 * 三个模块各自都对，合起来把任务锁死：
 *   · `approvals` 的去重键（0004 的索引 + 0006 的收窄）管「同一个决定能不能再建一张卡」；
 *   · `planEdge` 的同源审阅那一拦管「这一轮能不能推进」，它不看收件箱里有没有卡；
 *   · `HUMAN_EDGES` 只有 approve 一条出边 ⇒ 退回不推进任务（那是登记过的规格缺口）。
 * 三者单独测都绿：索引测它挡得住（cards.test.ts ②）、门控测它拦得对
 * （dispatch.test.ts 的 reviewGate 那一组）、状态机测 reject 没有出边（status-machine）。
 * 而【它们交集处】那个状态 —— 门还拦着、键已用掉、收件箱空着 —— 谁都不负责。
 *
 * ── 它在真实运行里长什么样（0006 之前，实测）────────────────────────
 *   一条任务停在 IN_REVIEW/director，dev 与 director 同模型家族（今天全仓就是这一个家族）
 *   ⇒ 门 3 拦，建一张 same-family-review 卡。CEO 按【退回】：
 *     · 卡片变 rejected，任务原地（reject 没有出边）；
 *     · 下一轮 dispatch 判同族【仍然拦】⇒ 去建同一张键 ⇒ 撞唯一索引 ⇒ 一张卡都不建；
 *     · pendingCards = 0 —— 收件箱里没有任何东西可点；
 *     · 而那一轮的 note 仍然写着「（已建卡）」；
 *     · IN_REVIEW 在 DRIVER_ELIGIBLE_STATES 里 ⇒ 驱动器每个心跳自动重跑，
 *       每一轮起一个真子进程、真烧 token、写三条 events，直到那一格的尝试上限。
 *   ⇒ 「CEO 说了不」被实现成「这个问题永远不再被问」，出路只剩手工 UPDATE approvals。
 *
 * 这条链上的钱是【自动】花的，所以它不是"某个界面少个按钮"。
 */
import { mkdirSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { OrgGraph } from "@opc/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { approveCard, pendingCards } from "../../src/engine/approve.js";
import { ensureCharterCard } from "../../src/engine/charter.js";
import {
  makeDispatch,
  type RunTurnInput,
  type TurnOutcome,
} from "../../src/engine/dispatch.js";
import { makeRuntime } from "../../src/engine/runtime.js";
import { type EventBus, InMemoryEventBus } from "../../src/events/bus.js";
import { insertTask } from "../../src/http/real-deps.js";
import { INSERT_DELEGATION_GRAPH_SQL } from "../../src/org/commit.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("acceptance-rejected-waiver", import.meta.url);
const NOW = 1_700_000_000_000;
const CEO = "ceo";
const TASK_ID = "t-waiver-1";

type Row = Record<string, unknown>;

const said = (o: Record<string, unknown>) =>
  "干完了。\n\n<<<OPC_DECISION>>>\n" + JSON.stringify(o);

/**
 * 汇报树与家族取值都沿用 idea-to-delivered.test.ts 那张图的口径：
 * 四层（intake / director / dev）是【到顶】那条路能走完的最小形状，
 * 而全家同一个 model_family 是【今天的真实配置】—— 正是它让同源那一拦恒命中。
 *
 * ── edges 里为什么必须有 dev → director 这一条 ─────────────────────
 * 本发的对象是【同源豁免卡】：断言「收件箱里恰好一张卡，键是
 * `same-family-review:dev->director`」，以及「退回之后下一轮还建」「批过之后不再建」。
 * §8.2 第 3 条接进 dispatch 之后，审阅那一维变成【两个独立的判定、各一张卡】：
 * 家族相同 ⇒ 一张 same-family-review（点一次批准能过）；产出方没有带门控的出边 ⇒
 * 一张 review-blocked（点批准没用，得改图）。夹具若留着 `edges: []`，
 * 每一轮就是【两张 pending】，而这三发问的都是「那张豁免卡怎么样了」——
 * 它们会在一张与本发无关的第二张卡上变红。
 *
 * 所以补这条边是把【本发要的那个前提】写进夹具：「这一格只欠同源那一个决定」。
 * ⚠ 不许改成「断言里多容忍一张卡」：那等于把「一格至多欠一个决定」这条
 *   0041 §5 / 0046 §7 登记的不变量在验收里放弃掉。
 * 反向证据由这条边自己提供：把 review_gate 抹掉，第一条断言当场变成两张卡。
 */
function graphOf(family: string): OrgGraph {
  const node = (
    roleId: string,
    reportsTo: string | null,
    canManage: boolean,
  ): OrgGraph["nodes"][string] => ({
    role_id: roleId,
    can_manage: canManage,
    reports_to: reportsTo,
    model_family: family,
  });
  return {
    nodes: {
      ceo: node(CEO, null, true),
      intake: node("intake", CEO, true),
      director: node("director", "intake", true),
      dev: node("dev", "director", false),
    },
    edges: [{ from: "dev", to: "director", review_gate: true }],
  };
}

const queues: WriteQueue[] = [];
let fileSeq = 0;

interface World {
  readonly db: DatabaseSync;
  readonly q: WriteQueue;
  readonly status: () => string;
  readonly dispatchOnce: () => Promise<{
    moved: boolean;
    card: boolean;
    note: string;
  }>;
  /** 一路只点 approve，直到出现某张 key 前缀匹配的卡；返回它的 id。 */
  readonly clickUntilCardWith: (prefix: string) => Promise<string>;
  readonly rows: () => { id: string; key: string | null; status: string }[];
}

async function world(): Promise<World> {
  const q = new WriteQueue(TMP + "/w-" + process.pid + "-" + ++fileSeq + ".db");
  queues.push(q);
  const db = q.writeConnection();
  migrate(db);
  db.prepare(INSERT_DELEGATION_GRAPH_SQL).run(
    "g1",
    1,
    JSON.stringify(graphOf("claude")),
    NOW,
    CEO,
    "退回豁免卡这一发用的组织图",
  );
  // 与 idea-to-delivered 同一条立场：建任务【必须】走生产入口 insertTask，
  // 手搓一行会让"人席那道门"这一维整个测不到。
  await insertTask(q, {
    id: TASK_ID,
    title: "做个 AI 笔记应用",
    assignedRole: "intake",
    nowMs: NOW,
  });

  const bus = new InMemoryEventBus();
  const recordingBus: EventBus = bus;
  const rt = makeRuntime({
    writer: q,
    bus: recordingBus,
    maxBudgetUsd: 0.5,
    taskLimitCents: 100_000,
    cwd: TMP,
    evidenceRoot: TMP + "/artifacts",
    ceoRoleId: CEO,
    nowMs: () => NOW,
  });
  const status = () =>
    String(
      (db.prepare("SELECT status FROM tasks WHERE id = ?").get(TASK_ID) as Row)[
        "status"
      ],
    );
  const lineFor = (s: string): Record<string, unknown> => {
    if (s === "CHARTER_APPROVED")
      return { action: "pass", summary: "章程已签，这件事拆给 dev" };
    if (s === "DECOMPOSING")
      return { action: "handoff", to_role: "dev", summary: "先做最小可用版" };
    if (s === "IN_PROGRESS")
      return { action: "pass", summary: "写完了，覆盖率 92%，3 个 P2 待后续" };
    if (s === "IN_REVIEW")
      return { action: "pass", summary: "独立审过了，可上线" };
    throw new Error(
      "走到一条这一发没预期的格子：" + s + "（别用默认台词糊过去）",
    );
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
  const rows = (): { id: string; key: string | null; status: string }[] =>
    (
      db
        .prepare(
          "SELECT id, card_key, status FROM approvals WHERE task_id = ? ORDER BY created_at, id",
        )
        .all(TASK_ID) as Row[]
    ).map((r) => ({
      id: String(r["id"]),
      key: r["card_key"] === null ? null : String(r["card_key"]),
      status: String(r["status"]),
    }));

  // 章程卡由【生产写入方】起草（同 idea-to-delivered：不是手搓一张）。
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
      ...(rt.deps.onCost === undefined ? {} : { onCost: rt.deps.onCost }),
      publish: (e, seq) => recordingBus.publishPersisted(e, seq),
    },
  );
  if (charter.outcome !== "drafted") {
    throw new Error(
      "章程卡没起草出来（outcome=" + charter.outcome + "），后面每一步都会假红",
    );
  }

  const dispatchOnce = async () => {
    say = lineFor(status());
    const r = await dispatch({
      taskId: TASK_ID,
      nowMs: NOW + 5000,
      maxBudgetUsd: 0.5,
    });
    return { moved: r.moved, card: r.card !== null, note: r.note };
  };
  const clickUntilCardWith = async (prefix: string): Promise<string> => {
    for (let i = 0; i < 20; i++) {
      const pend = pendingCards(q, TASK_ID);
      if (pend.length > 0) {
        const hit = rows().find(
          (r) => (r.key ?? "").startsWith(prefix) && r.status === "pending",
        );
        if (hit !== undefined) return hit.id;
        const only = String((pend[0] as unknown as Row)["id"]);
        const r = await approveCard(
          q,
          {
            taskId: TASK_ID,
            approvalId: only,
            button: "approve",
            nowMs: NOW + 1000 + i,
          },
          (e, seq) => recordingBus.publishPersisted(e, seq),
        );
        expect(r.outcome, "点不掉那张卡：" + r.note).toBe("decided");
        continue;
      }
      await dispatchOnce();
    }
    throw new Error(
      "跑了 20 步没有出现前缀为 [" + prefix + "] 的待批卡 —— 这一发的探针失效",
    );
  };

  return { db, q, status, dispatchOnce, clickUntilCardWith, rows };
}

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

describe("① 同源豁免卡被【退回】之后，问题必须再被问一次", () => {
  it("退回 ⇒ 任务原地（规格缺口）而【不是】永远没人再问", async () => {
    const w = await world();
    const waiverId = await w.clickUntilCardWith("same-family-review:");
    expect(w.status(), "豁免卡应当出现在审阅那一格上").toBe("IN_REVIEW");
    const before = w.rows();

    const rej = await approveCard(
      w.q,
      {
        taskId: TASK_ID,
        approvalId: waiverId,
        button: "reject_with_comment",
        note: "同家族不能算独立审阅，去接第二个模型家族",
        nowMs: NOW + 9000,
      },
      () => {},
    );
    // reject 在 HUMAN_EDGES 里没有出边 ⇒ 卡片决策成功而任务不动。
    // 这一格钉的是【现状】（0041 §7 登记的规格缺口），不是"退回该把任务推去哪"。
    expect(rej.outcome).toBe("decided");
    expect(
      rej.edgeExists,
      "reject 今天没有出边 —— 若哪天补了，这一发会红并逼改的人重读本篇",
    ).toBe(false);
    expect(w.status()).toBe("IN_REVIEW");

    // ── 承重的那一步：下一轮必须【重新建卡】 ─────────────────────────
    const next = await w.dispatchOnce();
    expect(next.moved, "同源那一拦仍然成立 ⇒ 这一轮不该推进").toBe(false);
    expect(
      next.card,
      "门还拦着就必须再问一次：0006 之前这里是 false（键被 rejected 那一行烧掉）",
    ).toBe(true);
    const pend = w.rows().filter((r) => r.status === "pending");
    expect(
      pend.map((r) => r.key),
      "收件箱里必须有【一张】新的同源豁免卡",
    ).toEqual(["same-family-review:dev->director"]);
    // 旧的那条【还在】：它是「CEO 说过一次不」的唯一记录，不能被覆盖掉。
    expect(w.rows().filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(w.rows().length).toBe(before.length + 1);
  });

  it("反向对照：新那张卡【还挂着】时，第二次不重复建（0006 只收窄了已决策那一半）", async () => {
    const w = await world();
    const waiverId = await w.clickUntilCardWith("same-family-review:");
    await approveCard(
      w.q,
      {
        taskId: TASK_ID,
        approvalId: waiverId,
        button: "reject_with_comment",
        note: "同家族不能算独立审阅",
        nowMs: NOW + 9000,
      },
      () => {},
    );
    const first = await w.dispatchOnce();
    expect(first.card).toBe(true);
    // 再来一轮：pending 那张卡占着键 ⇒ 撞去重 ⇒ 一条卡片事件都不写
    //（这是 0004 索引存在的理由本身，收窄之后【必须】照旧成立）。
    const second = await w.dispatchOnce();
    expect(
      second.card,
      "已经有一张待批的卡 ⇒ 不该再建一张、也不该广播第二次",
    ).toBe(false);
    expect(w.rows().filter((r) => r.status === "pending")).toHaveLength(1);
  });

  it("批准仍然终结这件事：批过之后同族审阅不再建【豁免】卡（门 4 另算）", async () => {
    /*
     * 第三发挡的是"为了让退回能重问，把索引改成【什么都不挡】"那种改法：
     * 那种改法下这一发红 —— 批过的键会被再建一张卡，收件箱永远清不掉。
     *
     * round359 语义变更（门 4 全量拦）：批掉豁免卡之后，「下一轮不再建卡」这句话
     * **不再整体成立** —— 门 3 放行了，但门 4 会建一张 gate-blocked 卡。
     * 本发相应收窄，只钉它原本要钉的那一格：**同族豁免卡**的键不再重复出现。
     * 这与回退重问那一发同源 —— 0006 只收窄了「已决策」那一半，而豁免卡
     * 批过之后不重建是同一个去重键的另一半。门 4 的卡是不同键族的另一件事，
     * 由 idea-to-delivered / gate 测试钉，不在本发的射程内。
     */
    const w = await world();
    const waiverId = await w.clickUntilCardWith("same-family-review:");
    // 批准豁免卡必须带理由（waiver_note_required 那一支）：先验证空理由被拦下，
    // 再带理由批掉 —— 否则这一发等于偷偷放宽了「豁免 = CEO 一句话」的那个凭据。
    const refused = await approveCard(
      w.q,
      {
        taskId: TASK_ID,
        approvalId: waiverId,
        button: "approve",
        nowMs: NOW + 8000,
      },
      () => {},
    );
    expect(refused.outcome, "空理由的豁免批准必须被拦下，那张卡保持待批").toBe(
      "waiver_note_required",
    );
    expect(
      w.rows().filter((r) => r.status === "pending").length,
      "被拦下的批准不该认领卡片 ⇒ 那张豁免卡还挂着",
    ).toBeGreaterThanOrEqual(1);
    const ok = await approveCard(
      w.q,
      {
        taskId: TASK_ID,
        approvalId: waiverId,
        button: "approve",
        note: "接受同源审阅风险：这台机器只有一个模型家族，人工复核这一份",
        nowMs: NOW + 9000,
      },
      () => {},
    );
    expect(ok.outcome).toBe("decided");
    // 批过 ⇒ 下一轮门 3 放行。产生门 4 的 gate-blocked 卡（在代码里不读它的
    // 返回值 —— 卡面形状由下面 rows() 那两发断言，读过反而会忽略「没推进」本身）。
    await w.dispatchOnce();
    // 批过 ⇒ 门 3 放行 ⇒ 不再建【豁免】卡（这是本发钉的那一格）。
    expect(
      w
        .rows()
        .filter(
          (r) =>
            r.status === "pending" && (r.key ?? "").startsWith("same-family"),
        ),
    ).toEqual([]);
    // 但门 4 全量拦还在：同一条任务上会建 gate-blocked 卡（键族不同，点不掉，
    // 与豁免卡是两个独立的问题）。这一发明确说它【不算】本发要钉的东西 ——
    // 免得下一任读代码把「出现了 gate-blocked 卡」读成「豁免批准失败了」。
    const gates = w
      .rows()
      .filter(
        (r) =>
          r.status === "pending" && (r.key ?? "").startsWith("gate-blocked:"),
      );
    expect(
      gates.length,
      "门 4 的 gate-blocked 卡与豁免卡同屏出现是【设计如此】，不是本发回归",
    ).toBe(1);
  });
});
