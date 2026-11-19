/**
 * `budgets.hard_stop` 的【读方】（O7 动作 3）。
 *
 * ── 这一格为什么以前不存在 ──────────────────────────────────────────
 * `charter-pump.ts` 的注释曾写着「那列今天全仓【没有任何代码能写成 0】，
 * 所以把它写进判据会得到一条【造不出红】的判据」。那句话当时的推理是对的
 * （三条 INSERT 都写字面量 1），错的只是它没给自己留到期日：
 * `PUT /budget`（http/budget.ts 的 UPSERT）后来能把那列写成 0，
 * 于是「写侧有了而读侧没有」成了新的最坏形状 —— 界面上有一个开关，
 * 拨下去【什么都不发生】，而 GET /budget 还会把新值读回来显示成"已生效"。
 * O7 原文点的正是这一格：「当前形状（恒 1 + 没人读 + 读它就能造出恒真判据）
 * 是三种里最坏的」。
 *
 * ── 本文件判的是【门的两个方向各有人看】────────────────────────────
 *  · hard_stop = 1（缺省）⇒ 超预算不进候选、进 blocked —— 这条 A–I 组早已钉着，
 *    本文件只重钉一次，它的作用是当【分母】：没有它，下面那条"= 0 会放行"
 *    与「门整个不在」不可区分。
 *  · hard_stop = 0 ⇒ 超预算【照样进候选】且【不进 blocked】。
 *    注意它放行的是【再花一次钱的机会】，不是把预算抹掉：consumed 照记，
 *    silentOverBudgets 那条报警照报 —— 本文件不改那一侧，也不在这里声称它改了。
 *  · 无 budgets 行 ⇒ 进候选（缺省必须读成 1，读成 0 就变成
 *    「没配预算 = 随便花」，那是反向语义）。
 *
 * ── ⭐ 那一发防【括号】的用例是本文件存在的一半理由 ────────────────
 * 谓词现在是 `consumed < ? OR hard_stop = 0`，而四个使用点里两个是【裸拼】的
 * （`AND <谓词> ORDER BY`）。SQLite 里 AND 比 OR 紧，摘掉最外层括号会把整条
 * WHERE 劈成 `(状态 ∧ 卡 ∧ 钱) ∨ (hard_stop = 0)` ⇒ 任何 hard_stop = 0 的格子里
 * 【连状态都不判】就进候选。那种坏法不会报错、不会让任何一条现有用例红
 * （现有夹具的 hard_stop 恒为 1，那半截 OR 恒假），所以这里造一条
 * 「hard_stop = 0 而状态根本不该被驱动」的任务，判它【不许】进候选。
 *
 * 跑法：npx vitest run packages/hub/test/budget/hard-stop-gate.test.ts
 */
import { mkdirSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import type { WriteQueue } from "../../src/db/write-queue.js";
import { CHARTER_CARD_KEY } from "../../src/engine/charter.js";
import { DECISION_MARK } from "../../src/engine/claude.js";
import { InMemoryEventBus } from "../../src/events/bus.js";
import { INSERT_DELEGATION_GRAPH_SQL } from "../../src/org/commit.js";
import { readDriverStatus } from "../../src/overview/driver-status.js";
import {
  CHARTER_BLOCKED_SQL,
  CHARTER_CANDIDATES_SQL,
  type CharterCardDeps,
  DEFAULT_CHARTER_MAX_ATTEMPTS,
  type PumpRoundResult,
  pumpCharterCards,
  underTaskBudgetSql,
} from "../../src/serve/charter-pump.js";
import {
  DEFAULT_DRIVER_MAX_ATTEMPTS,
  DRIVER_ELIGIBLE_STATES,
  driverBlockedSql,
  driverCandidatesSql,
} from "../../src/serve/driver-pump.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("budget-hard-stop", import.meta.url);
const NOW = 1_700_000_000_000;

type Row = Record<string, unknown>;

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
  // fixtureTmp 的目录名带 pid ⇒ 下一次运行【不会】顺手删它（那正是它消掉竞态的方式），
  // 所以漏了这里就漏一份 SQLite 库 —— fixture-dir 守卫扫的就是这一格。
  rmSync(TMP, { recursive: true, force: true });
});

interface World {
  db: DatabaseSync;
  q: WriteQueue;
  bus: InMemoryEventBus;
  /** 起草真被调了几次、各为哪条任务 —— 「放行」只能靠这个数出来。 */
  turns: string[];
}

/**
 * 一条 hard_stop=0 的格子能不能进候选，判的是【状态 + 卡 + 钱】三件事，
 * 所以夹具要能分别摆出这三样的每一种。任务直接 SQL 插（同 charter-pump.test.ts
 * 的立场：这一发要的是【状态】，不是「建任务那条路对不对」）。
 */
async function world(
  o: { readonly tasks?: readonly { id: string; status: string }[] } = {},
): Promise<World> {
  const { WriteQueue } = await import("../../src/db/write-queue.js");
  const q = new WriteQueue(
    TMP + "/hs-" + process.pid + "-" + ++fileSeq + ".db",
  );
  queues.push(q);
  const db = q.writeConnection();
  migrate(db);
  db.prepare(INSERT_DELEGATION_GRAPH_SQL).run(
    "g1",
    1,
    JSON.stringify({
      nodes: {
        ceo: {
          role_id: "ceo",
          can_manage: true,
          reports_to: null,
          model_family: "opus",
        },
        intake: {
          role_id: "intake",
          can_manage: true,
          reports_to: "ceo",
          model_family: "sonnet",
        },
      },
      edges: [],
    }),
    NOW,
    "测试用组织图",
  );
  for (const t of o.tasks ?? [{ id: "t1", status: "CHARTER_PENDING" }]) {
    db.prepare(
      "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at, graph_version) " +
        "VALUES (?, ?, ?, 'intake', 'intake', ?, ?, 1)",
    ).run(t.id, "想法 " + t.id, t.status, NOW, NOW);
  }
  return { db, q, bus: new InMemoryEventBus(), turns: [] };
}

/**
 * 「这条任务已经花掉 cents 美分，而这一格许不许硬停」。
 *
 * 走的是与 PUT /budget 同一条列形状（scope_type='task' / period='per_task'），
 * 但【直接写】而不是打那条 HTTP：本文件判的是读侧，写侧由 budget-route.test.ts 钉。
 */
function spend(
  w: World,
  taskId: string,
  cents: number,
  hardStop: boolean,
): void {
  w.db
    .prepare(
      "INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, consumed_cents, hard_stop) " +
        "VALUES (?, 'task', ?, 'per_task', ?, ?, ?) " +
        "ON CONFLICT(scope_type, scope_id, period) DO UPDATE " +
        "SET consumed_cents = excluded.consumed_cents, hard_stop = excluded.hard_stop",
    )
    .run(
      "task|" + taskId + "|per_task",
      taskId,
      cents,
      cents,
      hardStop ? 1 : 0,
    );
}

/** 章程泵那一侧的候选名单（绑参顺序 = SQL 里 ? 的顺序：card_key, attempts, 门, limit）。 */
function candidates(w: World, taskLimitCents: number): string[] {
  return (
    w.db
      .prepare(CHARTER_CANDIDATES_SQL)
      .all(
        CHARTER_CARD_KEY,
        DEFAULT_CHARTER_MAX_ATTEMPTS,
        taskLimitCents,
        5,
      ) as Row[]
  ).map((x) => String(x["id"]));
}

function blocked(w: World, taskLimitCents: number): string[] {
  return (
    w.db
      .prepare(CHARTER_BLOCKED_SQL)
      .all(
        CHARTER_CARD_KEY,
        DEFAULT_CHARTER_MAX_ATTEMPTS,
        taskLimitCents,
      ) as Row[]
  ).map((x) => String(x["id"]));
}

/**
 * 驱动器那两条 SQL 的绑参：状态 × N + attempts 上限 + 花钱的门（+ LIMIT）。
 *
 * ⚠ 个数自己数：node:sqlite 少绑一个不报「你少绑了」，它报 `datatype mismatch`
 * 或者更糟——按位置把数字绑到状态那一格上（见 driver-status.ts 那段
 * 「全绿了一整个下午」）。所以这里把期望个数写成【显式的】，
 * 一旦 SQL 加了 ? 而调用点没跟着改，这一发先红在造数据那一步。
 */
function driveParams(
  w: World,
  sql: string,
  taskLimitCents: number,
  withLimit: boolean,
): Row[] {
  const params: unknown[] = [
    ...DRIVER_ELIGIBLE_STATES,
    DEFAULT_DRIVER_MAX_ATTEMPTS,
    taskLimitCents,
  ];
  if (withLimit) params.push(5);
  if (sql.split("?").length - 1 !== params.length) {
    throw new Error(
      "驱动器 SQL 的 ? 个数与测试绑参不符：SQL 里 " +
        String(sql.split("?").length - 1) +
        " 个，测试准备 " +
        String(params.length) +
        " 个",
    );
  }
  return w.db.prepare(sql).all(...(params as never[])) as Row[];
}

function driverCandidates(w: World, taskLimitCents: number): string[] {
  return driveParams(
    w,
    driverCandidatesSql(DRIVER_ELIGIBLE_STATES),
    taskLimitCents,
    true,
  ).map((x) => String(x["id"]));
}

function driverBlocked(w: World, taskLimitCents: number): string[] {
  return driveParams(
    w,
    driverBlockedSql(DRIVER_ELIGIBLE_STATES),
    taskLimitCents,
    false,
  ).map((x) => String(x["id"]));
}

function draftText(): string {
  return (
    "业务目标：做个 AI 笔记应用\n可量化验收标准：三条\n预算上限：200 美元\n\n" +
    DECISION_MARK +
    "\n" +
    JSON.stringify({ action: "wait", summary: "章程提案已拟好，等 CEO 签署" })
  );
}

/** 不 spawn 的起草回调：这一发要判的是【门放不放行】，不是适配器起不起得来。 */
function fakeCardDeps(w: World): () => CharterCardDeps {
  return () => ({
    runTurn: async (i) => {
      const id = /想法 (\S+)/u.exec(i.prompt)?.[1] ?? "?";
      w.turns.push(id);
      return {
        ok: true,
        text: draftText(),
        costCents: 6,
        sessionId: null,
        error: null,
      };
    },
    rolePrompt: (r) => "你是角色 " + r,
  });
}

async function pump(
  w: World,
  taskLimitCents: number,
): Promise<PumpRoundResult> {
  return pumpCharterCards(w.q, w.bus, {
    nowMs: NOW + 1000,
    cardDeps: fakeCardDeps(w),
    maxBudgetUsd: 0.5,
    taskLimitCents,
    cwd: TMP,
  });
}

describe("budgets.hard_stop = 0 让花钱的门放行（O7 动作 3 的读方）", () => {
  it("⭐ 超预算 + hard_stop=1 ⇒ 不进候选【且】进 blocked（这是下面几条的分母）", async () => {
    const w = await world();
    spend(w, "t1", 150, true);
    expect(candidates(w, 100)).toEqual([]);
    expect(blocked(w, 100)).toEqual(["t1"]);
  });

  it("⭐ 超预算 + hard_stop=0 ⇒ 进候选【且】不进 blocked", async () => {
    const w = await world();
    spend(w, "t1", 150, false);
    expect(candidates(w, 100)).toEqual(["t1"]);
    // 放行之后它就不该再出现在"被钱挡住"那一档 —— 否则界面上会同时说
    // 「它在跑」和「它因为没钱没在跑」，两句都是真话而互相打脸。
    expect(blocked(w, 100)).toEqual([]);
  });

  it("⭐ 放行是真的【起了子进程】：跑一轮泵 ⇒ 起草发生、钱真花出去", async () => {
    // 上面那两条判的是 SQL 判据，这一发判的是【后果】：
    // 「门放行」如果只停在候选名单上而泵那一侧另有第二道门，CEO 看到的仍然是零。
    const w = await world();
    spend(w, "t1", 150, false);
    const r = await pump(w, 100);
    expect(r.cards.map((c) => [c.taskId, c.outcome])).toEqual([
      ["t1", "drafted"],
    ]);
    expect(w.turns).toEqual(["t1"]);
    expect(r.costCents).toBe(6);
    expect(r.blocked).toHaveLength(0);
  });

  it("⭐ 同一份钱、同一道门，只差 hard_stop ⇒ 一个起草一个被挡（对照）", async () => {
    // 两条并排跑：这一发的价值全在【只有 hard_stop 不同】。
    // 分开写两个 it 也能过，但那时"钱不一样"或"上限不一样"就没人负责排除了。
    const on = await world();
    const off = await world();
    spend(on, "t1", 150, true);
    spend(off, "t1", 150, false);
    const rOn = await pump(on, 100);
    const rOff = await pump(off, 100);
    expect(rOn.cards).toHaveLength(0);
    expect(rOn.blocked.map((b) => b.taskId)).toEqual(["t1"]);
    expect(rOff.cards.map((c) => c.outcome)).toEqual(["drafted"]);
    // 被挡的那一条【一分没花】—— 这是门原本的价值，hard_stop=0 不该把它反过来变成
    // 「被挡着还先扣一笔」。
    expect(rOn.costCents).toBe(0);
  });

  it("⭐ 没有预算行 ⇒ 照旧放行（缺省读成 1，不读成 0）", async () => {
    // 缺省读成 0 的写法是 `COALESCE(hard_stop, 0) = 0`，它【看起来更像保险】：
    // 「没配预算就让它过」。但那等于「不给一条任务配预算 ⇒ 它永远不受预算管」，
    // 方向与 O7 整篇相反，而且它会让今天所有没配 budgets 行的存量任务静默脱离门控。
    const w = await world();
    expect(candidates(w, 100)).toEqual(["t1"]);
    expect(blocked(w, 100)).toEqual([]);
  });

  it("⭐⭐ hard_stop=0 而【状态根本不该被驱动】⇒ 仍不许进候选（挡的是被摘掉的括号）", async () => {
    // 谓词是 `(consumed < ? OR hard_stop = 0)`。摘掉最外层括号之后，
    // `… AND (consumed < ? OR hard_stop = 0)` 在 SQLite 里结合成
    // `(… AND consumed < ?) OR hard_stop = 0` —— 于是这条停在 IN_REVIEW 的任务
    // 会因为【它的预算格写着不许硬停】而进【章程泵】的候选，
    // 而章程泵只该管 CHARTER_PENDING。
    // 现有 A–I 组全部用 hard_stop=1 的夹具，那半截 OR 恒假，
    // 摘括号之后【一条都不红】：这一发是本文件唯一能看见那个改动的地方。
    const w = await world({ tasks: [{ id: "t9", status: "IN_REVIEW" }] });
    spend(w, "t9", 150, false);
    expect(candidates(w, 100)).toEqual([]);
    // 同一条任务改成泵管的状态就放行 —— 证明上面那条红读的是【状态】而不是别的什么。
    const ok = await world({
      tasks: [{ id: "t9", status: "CHARTER_PENDING" }],
    });
    spend(ok, "t9", 150, false);
    expect(candidates(ok, 100)).toEqual(["t9"]);
  });

  it("⭐ 候选侧与阻塞侧【同源】：任何 hard_stop 取值下两档恰好互补", async () => {
    // 同源靠 import 判过一次（charter-pump.test.ts 那句 toContain），那一发读的是【源码】。
    // 这一发读的是【行为】：同一条任务在两个谓词下必须【恰好进其中一档】，
    // 两个都进 = 谎报，两个都不进 = 沉默（"因为没钱不理它"这件事消失了）。
    // 四种形状各来一条：有行没行 × hard_stop 两值，再叠一条"已有卡"的排除。
    const w = await world({
      tasks: [
        { id: "a", status: "CHARTER_PENDING" }, // 无预算行
        { id: "b", status: "CHARTER_PENDING" }, // 超限 + 硬停
        { id: "c", status: "CHARTER_PENDING" }, // 超限 + 不硬停
        { id: "d", status: "IN_REVIEW" }, // 不归泵管
      ],
    });
    spend(w, "b", 150, true);
    spend(w, "c", 150, false);
    const cands = candidates(w, 100);
    const blk = blocked(w, 100);
    expect(cands.sort()).toEqual(["a", "c"]);
    expect(blk).toEqual(["b"]);
    // 互补：候选 ∩ blocked = ∅，候选 ∪ blocked = 全部【本该成为候选】的任务。
    expect(cands.filter((x) => blk.includes(x))).toEqual([]);
    expect([...cands, ...blk].sort()).toEqual(["a", "b", "c"]);
  });

  it("⭐ 驱动器那一支同样读 hard_stop（同一个谓词的另一个读者）", async () => {
    // 门是【一个函数四个读者】。只让章程泵读它，界面上的"被钱挡住"与驱动器
    // 实际推不推就会分叉 —— 0045 那一族说的正是"屏幕上那句话指向做不了的下一步"。
    const on = await world({ tasks: [{ id: "t1", status: "IN_PROGRESS" }] });
    const off = await world({ tasks: [{ id: "t1", status: "IN_PROGRESS" }] });
    spend(on, "t1", 900, true);
    spend(off, "t1", 900, false);
    expect(driverCandidates(on, 500)).toEqual([]);
    expect(driverBlocked(on, 500)).toEqual(["t1"]);
    expect(driverCandidates(off, 500)).toEqual(["t1"]);
    expect(driverBlocked(off, 500)).toEqual([]);
  });

  it("⭐ 看板那一格：hard_stop=0 之后不再报 no_budget（读侧三档的第三档）", async () => {
    // driver-status 把"停在 agent 格而没在动"分成 at_limit / no_budget 两档，
    // 判据就是同一个 underTaskBudgetSql。hard_stop=0 ⇒ 钱不再挡它 ⇒ 那一档该消失。
    // 留着不删的反面是：CEO 放开预算之后，界面仍然写着「因为没钱停着」。
    const on = await world({ tasks: [{ id: "t1", status: "IN_PROGRESS" }] });
    const off = await world({ tasks: [{ id: "t1", status: "IN_PROGRESS" }] });
    spend(on, "t1", 900, true);
    spend(off, "t1", 900, false);
    const state = { enabled: true, pumping: true, taskLimitCents: 500 };
    expect(
      readDriverStatus(on.db as never, state).stopped.map((s) => [
        s.task_id,
        s.cause,
      ]),
    ).toEqual([["t1", "no_budget"]]);
    expect(readDriverStatus(off.db as never, state).stopped).toEqual([]);
  });

  it("谓词仍是【一条 ?】：加 hard_stop 不许偷加绑参", async () => {
    // 四个使用点各自写死了绑参顺序与个数（node:sqlite 绑错顺序【不抛】，
    // 见 driver-status.ts 那段"全绿了一整个下午"）。多一个 ? 而不改调用点，
    // 表现是数字被当成状态去比 —— 所以这一发守的是【形状】，不是行为。
    expect(underTaskBudgetSql("t").split("?").length - 1).toBe(1);
  });
});
