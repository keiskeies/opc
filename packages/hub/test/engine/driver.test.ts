/**
 * 驱动循环（engine/driver.ts）—— 它测的只有一件事：【什么时候停】。
 *
 * ── 为什么这一层值得单独一发 ─────────────────────────────────────────
 * 循环本身没有判定（判定全在 dispatch），它有的是【停止条件】，而停止条件写错的
 * 表现不是崩，是【花光预算】：「不动也继续跑」意味着每一轮真烧一次 claude -p，
 * 状态原地不动，直到任务预算烧穿。这类缺陷在单次调用的测试里永远绿，
 * 因为一次调用只跑一轮。
 *
 * ── 为什么 dispatch 是假的了还能算测到东西 ──────────────────────────
 * 因为这一层的【全部】逻辑就是「看见什么信号就停」。dispatch 的判定在
 * dispatch.test.ts 里测（49 发），真 SQL 在 runtime.test.ts 里测（13 发）。
 * 这里要的是能精确造出「连续三轮都 moved」这种在真系统里要跑八条边才出现的形状，
 * 而不是为了凑形状去搭一张真组织图 —— 那样红的时候分不清是循环错了还是图错了。
 *
 * 但留痕那一半【是真的】（走真 recordTurn + 真库），因为「留痕失败不中断循环」
 * 是一条只有真失败才能证明的性质。
 */
import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fixtureTmp } from "../fixtures/fixture-dir.js";
import { makeDispatch, type DispatchResult } from "../../src/engine/dispatch.js";
import { advance, describeAdvance } from "../../src/engine/driver.js";
import type { EngineRuntime } from "../../src/engine/runtime.js";

const TMP = fixtureTmp("engine-driver", import.meta.url);
const NOW = 1_700_000_000_000;

beforeAll(() => mkdirSync(TMP, { recursive: true }));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function result(o: Partial<DispatchResult> & { status: string }): DispatchResult {
  return {
    taskId: "t1",
    role: "dev",
    moved: true,
    seat: "agent",
    note: "ok",
    costCents: 4,
    sessionId: null,
    stateEventSeq: null,
    card: null,
    ...o,
  } as DispatchResult;
}

/** 一个假的 runtime：只留 advance 真用到的那两样（recordTurn / deps.loadTask）。 */
function fakeRt(o: {
  readonly exists?: boolean;
  /** 造「留痕失败」：真 runtime 是【内部捕获并返回 recorded:false】，
   * 所以这里也返回 false 而不是抛 —— 驱动方【没有】try/catch，
   * 让它抛的话测的就是一个真系统里不存在的形状。 */
  readonly recordFails?: boolean;
}): {
  rt: EngineRuntime;
  recorded: { cents: number; role: string }[];
  loads: { n: number };
} {
  const recorded: { cents: number; role: string }[] = [];
  const loads = { n: 0 };
  const rt = {
    recordTurn: async (x: { taskId: string; role: string; costCents: number }): Promise<{
      recorded: boolean;
      why: string;
    }> => {
      if (o.recordFails === true) {
        return { recorded: false, why: "harness_calls 写入失败：库被占了" };
      }
      recorded.push({ cents: x.costCents, role: x.role });
      return { recorded: true, why: "已留痕" };
    },
    deps: {
      loadTask: () => {
        loads.n += 1;
        if (o.exists === false) return null;
        return { id: "t1", title: "x", status: "IN_PROGRESS", role: "dev", graphVersion: 1 };
      },
    },
  } as unknown as EngineRuntime;
  return { rt, recorded, loads };
}

/** 按脚本一轮轮返回结果的假 dispatch。 */
function scripted(...rs: DispatchResult[]): {
  fn: () => Promise<DispatchResult>;
  calls: { n: number };
} {
  const calls = { n: 0 };
  return {
    fn: async () => {
      const i = calls.n;
      calls.n += 1;
      const r = rs[Math.min(i, rs.length - 1)] as DispatchResult;
      return r;
    },
    calls,
  };
}

describe("advance 的停止条件", () => {
  it("角色说 wait（moved:false）⇒ 【第二轮不再烧钱】：这是防「拿钱买 wait」那条判据", async () => {
    const { rt } = fakeRt({});
    const d = scripted(result({ status: "IN_PROGRESS", moved: false, costCents: 7 }));
    const r = await advance(rt, () => d.fn(), { taskId: "t1", maxBudgetUsd: 0.5 });
    expect(r.stopped).toBe("stalled");
    expect(d.calls.n).toBe(1); // 关键：只跑了一轮
    expect(r.totalCostCents).toBe(7);
  });

  it("人坐的格子 ⇒ 立刻停，并且【报 human_seat】而不是「跑完了」", async () => {
    const { rt } = fakeRt({});
    const d = scripted(result({ status: "FINAL_REVIEW", seat: "human", moved: false, costCents: 0 }));
    const r = await advance(rt, () => d.fn(), { taskId: "t1", maxBudgetUsd: 0.5 });
    expect(r.stopped).toBe("human_seat");
    expect(d.calls.n).toBe(1);
  });

  it("连续推进时【不会】提前停；撞上限时如实报 limit 而不是停在成功的样子", async () => {
    const { rt } = fakeRt({});
    const d = scripted(result({ status: "IN_PROGRESS" }));
    const r = await advance(rt, () => d.fn(), { taskId: "t1", maxBudgetUsd: 0.5, maxTurns: 3 });
    expect(d.calls.n).toBe(3);
    expect(r.stopped).toBe("limit");
    // 三轮各 4 美分 ⇒ 12。这个数是「循环真的跑了三轮」的独立证据
    expect(r.totalCostCents).toBe(12);
    expect(r.turns.map((t) => t.turn)).toEqual([1, 2, 3]);
  });

  it("maxTurns=0 / 负数 / 小数 ⇒ 当场抛，而不是返回一个【看起来跑完了】的空结果", async () => {
    const { rt } = fakeRt({});
    const d = scripted(result({ status: "IN_PROGRESS" }));
    for (const bad of [0, -1, 2.5, Number.NaN]) {
      await expect(
        advance(rt, () => d.fn(), { taskId: "t1", maxBudgetUsd: 0.5, maxTurns: bad }),
      ).rejects.toThrow(/maxTurns/);
    }
    // 一次都没被调到：抛在循环之前
    expect(d.calls.n).toBe(0);
  });

  it("任务不在库里 ⇒ gone，且【一次 dispatch 都不调】（不为一件不存在的事烧 token）", async () => {
    const { rt, loads } = fakeRt({ exists: false });
    const d = scripted(result({ status: "IN_PROGRESS" }));
    const r = await advance(rt, () => d.fn(), { taskId: "t1", maxBudgetUsd: 0.5 });
    expect(r.stopped).toBe("gone");
    expect(r.turns.length).toBe(0);
    expect(d.calls.n).toBe(0);
    expect(loads.n).toBe(1);
  });

  it("留痕写不进去【不中断循环】，但那一轮标 recorded:false（不能让 CEO 重跑整轮补日志）", async () => {
    const { rt } = fakeRt({ recordFails: true });
    const d = scripted(
      result({ status: "IN_PROGRESS" }),
      result({ status: "IN_REVIEW", moved: false }),
    );
    const r = await advance(rt, () => d.fn(), { taskId: "t1", maxBudgetUsd: 0.5 });
    expect(r.turns.length).toBe(2);
    expect(r.turns.every((t) => t.recorded === false)).toBe(true);
    expect(r.turns[0]?.why).toContain("harness_calls");
    // 钱照算：留痕失败不等于这轮没花钱（真 CLI 真花了）
    expect(r.totalCostCents).toBe(8);
  });

  it("留痕用的是【这一轮 dispatch 交回来的角色】，不是第一轮的：缓存那份快照会让" +
     "director 的会话挂在 dev 名下", async () => {
    const { rt, recorded } = fakeRt({});
    const d = scripted(
      result({ status: "IN_PROGRESS", role: "dev" }),
      result({ status: "IN_REVIEW", role: "director" }),
      result({ status: "IN_REVIEW", role: "director", moved: false }),
    );
    await advance(rt, () => d.fn(), { taskId: "t1", maxBudgetUsd: 0.5 });
    // 三轮分别是 dev / director / director。第一轮之后还把 role 当成 dev 的话，
    // 症状是 harness_calls 里 director 的会话记在 dev 名下 —— 而 roleSession
    // 按 (task, role) 查，于是下一轮 director 拿不到自己的会话，永久从零开始。
    expect(recorded.map((r) => r.role)).toEqual(["dev", "director", "director"]);
  });

  it("onTurn 每轮都被调到，带着那一轮完整的 res（CLI 打进度靠它）", async () => {
    const { rt } = fakeRt({});
    const seen: number[] = [];
    const d = scripted(
      result({ status: "IN_PROGRESS" }),
      result({ status: "IN_REVIEW", moved: false }),
    );
    await advance(rt, () => d.fn(), {
      taskId: "t1",
      maxBudgetUsd: 0.5,
      onTurn: (t) => seen.push(t.turn),
    });
    expect(seen).toEqual([1, 2]);
  });
});

describe("describeAdvance 那句收尾", () => {
  it("人席那一支说的是【去点按钮】，不是「失败了」", async () => {
    const { rt } = fakeRt({});
    const d = scripted(result({ status: "FINAL_REVIEW", seat: "human", moved: false, note: "等人不等 agent" }));
    const r = await advance(rt, () => d.fn(), { taskId: "t1", maxBudgetUsd: 0.5 });
    const s = describeAdvance(r, null);
    expect(s).toContain("FINAL_REVIEW");
    expect(s).toContain("审批收件箱");
    expect(s).toContain("等人不等 agent"); // 最后一轮的 note 要带出来，否则那句收尾是空话
  });

  it("stalled 那一支给出【可执行的下一步】（再推一次），而不是只报停", async () => {
    const { rt } = fakeRt({});
    const d = scripted(result({ status: "IN_PROGRESS", moved: false, note: "等 CI 跑完" }));
    const r = await advance(rt, () => d.fn(), { taskId: "t1", maxBudgetUsd: 0.5 });
    const s = describeAdvance(r, { id: "t1", title: "x", status: "IN_PROGRESS", role: "dev", graphVersion: 1 });
    expect(s).toContain("hub work");
    expect(s).toContain("负责角色：dev");
  });
});

/* ─────────────── 一条真链：runtime + dispatch + advance ───────────────
   上面全是假 dispatch。这一发换成真 makeDispatch + 桩 CLI，图的是测
   「三者拼起来能不能跑通一次」—— 拼装本身出错（回调喂错、参数漏一个）
   在两边的单元测试里都看不见。 */
describe("advance + 真 dispatch（桩 CLI，真库）", () => {
  it("真装配跑一轮：停在 stalled，钱与状态都落库", async () => {
    const { migrate } = await import("../../src/db/migrate.js");
    const { WriteQueue } = await import("../../src/db/write-queue.js");
    const { INSERT_DELEGATION_GRAPH_SQL } = await import("../../src/org/commit.js");
    const { InMemoryEventBus } = await import("../../src/events/bus.js");
    const { makeRuntime } = await import("../../src/engine/runtime.js");
    type Db = ReturnType<WriteQueue["writeConnection"]>;
    const q = new WriteQueue(TMP + "/chain.db");
    const db = q.writeConnection() as unknown as Db;
    migrate(db as unknown as Parameters<typeof migrate>[0]);
    db.prepare(
      "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at, graph_version) " +
        "VALUES ('t1','x','IN_PROGRESS','dev','intake',?, ?, 1)",
    ).run(NOW, NOW);
    db.prepare(INSERT_DELEGATION_GRAPH_SQL).run(
      "g1",
      1,
      JSON.stringify({
        nodes: {
          ceo: { role_id: "ceo", can_manage: true, reports_to: null, model_family: "opus" },
          director: { role_id: "director", can_manage: true, reports_to: "ceo", model_family: "sonnet" },
          dev: { role_id: "dev", can_manage: false, reports_to: "director", model_family: "claude" },
        },
        edges: [{ from: "dev", to: "director", review_gate: true }],
      }),
      NOW,
      "ceo",
      "g",
    );
    const rt = makeRuntime({
      writer: q,
      bus: new InMemoryEventBus(),
      maxBudgetUsd: 0.5,
      taskLimitCents: 1000,
      cwd: TMP,
      bin: fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url)),
    });
    const dispatch = makeDispatch(rt.deps);
    const r = await advance(rt, (o) => dispatch(o), { taskId: "t1", maxBudgetUsd: 0.5, maxTurns: 4 });

    // 桩 CLI 交给 "tech"，图里没这个角色 ⇒ 越权 ⇒ 不动 ⇒ stalled，且【只跑一轮】
    expect(r.stopped).toBe("stalled");
    expect(r.turns.length).toBe(1);
    expect(r.totalCostCents).toBe(4);
    // 留痕真的落库了（这条是假 runtime 测不出来的那一半）
    const hc = db.prepare("SELECT * FROM harness_calls").all() as Record<string, unknown>[];
    expect(hc.length).toBe(1);
    expect(r.turns[0]?.recorded).toBe(true);
    // 账也落了：budget_events 一行 + tasks 那一列前进
    expect((db.prepare("SELECT count(*) AS c FROM budget_events").get() as { c: number }).c).toBe(1);
    expect(
      (db.prepare("SELECT consumed_cents AS c FROM tasks WHERE id='t1'").get() as { c: number }).c,
    ).toBe(4);
    await q.close();
  });
});
