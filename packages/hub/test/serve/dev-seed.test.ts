/**
 * dev:seed 的种子核心（serve/dev-seed.ts）。
 *
 * ── 这一发钉的是「演示数据让界面好看」这句话的【五个前提】──────────────
 *  A. 幂等：跑两次 delegation_graphs 行数不变。判据坏了的症状是
 *     第二次 add_node 撞 role_exists 半途而废，库里留下种了一半的树 ——
 *     比空库更难查，而它只在「有人跑第二遍」这条最自然的路上出现。
 *  B. 种出来的组织图【能被读回】：走 readLatestGraph（GET /org 的同一读法）。
 *     写进去读不出 = 组织图页照样空着，而种子的全部意义是那一页有东西。
 *  C. 种出来的任务里【确实有一条】状态落在 CEO_DECISION_STATUSES 里 ——
 *     清单从 today.ts 的导出读而不是测试里抄一份，抄件漂了这句话就悄悄变假。
 *  D. 收件箱有卡：approvals 里有 2 张 status='pending' 的卡（今日页「待你决策」
 *     读的就是这个数）。幂等是【两层】的：currentGraphVersion 短路之外，
 *     卡自身还靠 createCard 的 (task_id, card_key) 去重键 —— 第二发把图行删掉
 *     绕过短路重跑，卡数必须【纹丝不动】，否则「两层都在」是句空话。
 *  E. 今日页「已声明上限合计」有数：直接调 readToday（GET /today 的同一聚合），
 *     断言它的 budget.declared_scopes >= 1。读侧口径（只算 task|per_task）
 *     有测试钉着不许动，种子必须supply得上一行任务级预算。
 *
 * ── 库是临时的，绝不碰 .opc-os/dev.db ──────────────────────────────
 * 真 dev 库正被 dev 进程占着；夹具走 fixtureTmp + WriteQueue(临时文件) + migrate，
 * 与 charter-pump.test.ts 同一夹具体系。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APPROVAL_TYPES } from "../../src/approvals/cards.js";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { isIrreversibleApproval } from "../../src/http/tokens.js";
import { readLatestGraph } from "../../src/org/commit.js";
import { CEO_DECISION_STATUSES, readToday } from "../../src/overview/today.js";
import {
  DEMO_BUDGETS,
  DEMO_CARDS,
  DEMO_ORG_NODES,
  DEMO_TASKS,
  seedDemoOrg,
} from "../../src/serve/dev-seed.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("serve-dev-seed", import.meta.url);
const NOW = 1_700_000_000_000;

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

function freshQueue(): WriteQueue {
  const q = new WriteQueue(
    join(TMP, "seed-" + process.pid + "-" + ++fileSeq + ".db"),
  );
  queues.push(q);
  migrate(q.writeConnection());
  return q;
}

describe("dev-seed", () => {
  it("跑两次：第二次整体跳过，delegation_graphs 行数不变", async () => {
    const q = freshQueue();
    const db = q.readConnection();
    const countGraphs = (): number =>
      (
        db.prepare("SELECT COUNT(*) AS n FROM delegation_graphs").get() as {
          n: number;
        }
      ).n;

    const first = await seedDemoOrg(q, { nowMs: NOW });
    expect(first.skipped).toBe(false);
    const rowsAfterFirst = countGraphs();
    expect(rowsAfterFirst).toBe(DEMO_ORG_NODES.length);

    const second = await seedDemoOrg(q, { nowMs: NOW + 1000 });
    expect(second.skipped).toBe(true);
    // 跳过要说得出【为什么】—— 入口打印「种了什么/跳过什么」靠的就是这句。
    expect(second.message).toContain("已种过");
    expect(countGraphs()).toBe(rowsAfterFirst);
    // 任务与预算也不许叠行。
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n,
    ).toBe(DEMO_TASKS.length);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM budgets").get() as { n: number })
        .n,
    ).toBe(DEMO_BUDGETS.length);
    // 审批卡也不许叠行（第一层幂等：整体短路）。第二层（去重键）单独一发钉，见下。
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'",
          )
          .get() as { n: number }
      ).n,
    ).toBe(DEMO_CARDS.length);
  });

  it("种出来的组织图能被 readLatestGraph 读回，节点与汇报树逐一对上", async () => {
    const q = freshQueue();
    await seedDemoOrg(q, { nowMs: NOW });
    const latest = readLatestGraph(q.readConnection());
    if (latest === null)
      throw new Error("readLatestGraph 读回了 null：种子写进去的图读不出");
    const nodes = latest.graph.nodes;
    expect(Object.keys(nodes).sort()).toEqual(
      DEMO_ORG_NODES.map((n) => n.role_id).sort(),
    );
    for (const spec of DEMO_ORG_NODES) {
      expect(nodes[spec.role_id]).toMatchObject({
        role_id: spec.role_id,
        can_manage: spec.can_manage,
        reports_to: spec.reports_to,
        model_family: spec.model_family,
      });
    }
    expect(latest.version).toBe(DEMO_ORG_NODES.length);
  });

  it("任务状态散在不同状态，且至少一条落在 CEO_DECISION_STATUSES（清单从 today.ts 读）", async () => {
    const q = freshQueue();
    await seedDemoOrg(q, { nowMs: NOW });
    const rows = q
      .readConnection()
      .prepare("SELECT id, status FROM tasks ORDER BY id")
      .all() as { id: string; status: string }[];
    expect(rows).toHaveLength(DEMO_TASKS.length);

    // 各列各层级有卡：状态不许全挤一个值。
    const statuses = new Set(rows.map((r) => r.status));
    expect(statuses.size).toBeGreaterThan(1);
    // 「需要你决策」那一列有东西 —— 判据用 today.ts 的导出，测试里不抄清单。
    const decision = rows.filter((r) =>
      CEO_DECISION_STATUSES.includes(r.status),
    );
    expect(decision.length).toBeGreaterThanOrEqual(1);
    // 种下去的每个状态都真落库了（防止期望与实插各说一半）。
    for (const t of DEMO_TASKS) {
      const row = rows.find((r) => r.id === t.id);
      expect(row?.status).toBe(t.status);
    }
  });

  it("预算行：company + 2 个 role + 1 条任务级 per_task，进度比值有区分度", async () => {
    const q = freshQueue();
    await seedDemoOrg(q, { nowMs: NOW });
    const rows = q
      .readConnection()
      .prepare(
        "SELECT scope_type, scope_id, period, limit_cents, consumed_cents FROM budgets ORDER BY id",
      )
      .all() as Record<string, unknown>[];
    expect(rows).toHaveLength(DEMO_BUDGETS.length);
    expect(rows.map((r) => r["scope_type"]).sort()).toEqual([
      "company",
      "role",
      "role",
      "task",
    ]);
    // 进度条要有区分度：至少存在一对 consumed/limit 比值不同的行。
    const ratios = rows.map(
      (r) => Number(r["consumed_cents"]) / Number(r["limit_cents"]),
    );
    expect(new Set(ratios).size).toBeGreaterThan(1);
  });

  it("收件箱：种完有 2 张 pending 审批卡，挂在已种任务上且全部可逆", async () => {
    const q = freshQueue();
    const first = await seedDemoOrg(q, { nowMs: NOW });
    expect(first.approvalIds).toHaveLength(DEMO_CARDS.length);
    const db = q.readConnection();
    const rows = db
      .prepare(
        "SELECT id, task_id, approval_type, parameters FROM approvals " +
          "WHERE status = 'pending' ORDER BY created_at, id",
      )
      .all() as {
      id: string;
      task_id: string;
      approval_type: string;
      parameters: string;
    }[];
    // 今日页「待你决策」读的就是这个数（GET /approvals 的 pending 计数）。
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      // 卡必须挂在已种的任务上（外键本就钉着，这里再对上种子的 id 清单）。
      expect(DEMO_TASKS.map((t) => t.id)).toContain(r.task_id);
      // 类型取自 cards.ts 的枚举 —— 抄一份候选清单漂了就假绿，读导出。
      expect(APPROVAL_TYPES).toContain(r.approval_type);
      // ⚠ O11 的演示侧镜像：演示卡必须【可逆】—— 用 tokens.ts 那个【真判据】验，
      // 而不是在测试里复述它的三档规则。判成不可逆 = IM 侧不许批 = 「点批准」演示断链。
      expect(isIrreversibleApproval(r.approval_type, r.parameters)).toBe(false);
    }
    // 一张卡一条 ApprovalRequired 审计（createCard 的同事务不变量，种子没绕开它）。
    const audits = db
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE action = 'approval' " +
          "AND json_valid(payload) = 1 AND json_extract(payload, '$.kind') = 'ApprovalRequired'",
      )
      .get() as { n: number };
    expect(audits.n).toBe(2);
  });

  it("幂等第二层：删掉组织图行绕过整体短路重跑，审批卡靠去重键仍不翻倍", async () => {
    const q = freshQueue();
    await seedDemoOrg(q, { nowMs: NOW });
    const db = q.readConnection();
    const pending = (): number =>
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'",
          )
          .get() as { n: number }
      ).n;
    expect(pending()).toBe(DEMO_CARDS.length);

    // 模拟「短路判据被绕过」：把 delegation_graphs 清空后重跑。
    // 删行走写连接（readConnection 物理只读），下一次 seedDemoOrg 的 currentGraphVersion
    // 读同一张表 ⇒ 短路不再成立，add_node 会逐格重来（行已清空，不撞 role_exists）。
    q.writeConnection().exec("DELETE FROM delegation_graphs");
    const again = await seedDemoOrg(q, { nowMs: NOW + 60_000 });
    expect(again.skipped).toBe(false); // 短路确实被绕过了 —— 这一发走的正是去重键那条防线
    // createCard 撞 (task_id, card_key) 的 partial unique index ⇒ created:false。
    expect(again.approvalIds).toHaveLength(0);
    // 卡【一张都没多】——「两层幂等都在」钉在这里：只有短路一层时这一发会翻倍。
    expect(pending()).toBe(DEMO_CARDS.length);
    // 预算行也不叠（INSERT ... DO NOTHING），任务级那条还在。
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM budgets").get() as { n: number })
        .n,
    ).toBe(DEMO_BUDGETS.length);
  });

  it("今日页预算口径：readToday 的任务级聚合数出 declared_scopes >= 1", async () => {
    const q = freshQueue();
    await seedDemoOrg(q, { nowMs: NOW });
    // 直接调 GET /today 的同一个聚合函数，不自己重写 BUDGET_SUM_SQL ——
    // 种子的目标就是让【这个函数】的 declared_scopes 离开 0。
    const view = readToday(q.readConnection(), { nowMs: NOW });
    expect(view.budget.declared_scopes).toBeGreaterThanOrEqual(1);
    // 且只数任务级：合计必须恰好等于种下去的 task|per_task 行，
    // company/role 那三条不许混进来（那是读侧口径，这里钉的是种子喂对了行）。
    const taskLevel = DEMO_BUDGETS.filter(
      (b) => b.scope === "task" && b.period === "per_task",
    );
    expect(taskLevel.reduce((s, b) => s + b.limitCents, 0)).toBe(
      view.budget.declared_task_limits_cents,
    );
  });
});
