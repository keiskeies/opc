/**
 * 探针（round386，不入库）：预算门那道「分母」今天到底是谁？
 *
 * 三种可能的立场，各自对应的界面文案完全不同：
 *  (A) 分母 = 命令行 --task-limit-cents（app.js 现在那句话的前提，0049 §12 量的）
 *  (B) 分母 = budgets.limit_cents（driver-pump.ts:88 说 round360 之后是这个）
 *  (C) 列优先、命令行只是「库里没有那一行时」的回落（underTaskBudgetSql 的字面形状）
 *
 * 判法：同一份库、同一个命令行数字（500），只改 budgets 那一格，看门与看板怎么动。
 * 改列走的是 PUT /budget 用的【同一条语句】UPSERT_BUDGET_ROW_SQL（它只写 limit 与
 * hard_stop，consumed 由消费侧维护），所以这一发量到的就是「屏幕上点保存」的效果。
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHARTER_CARD_KEY } from "../../packages/hub/src/engine/charter.js";
import { UPSERT_BUDGET_ROW_SQL } from "../../packages/hub/src/http/budget.js";
import { INSERT_DELEGATION_GRAPH_SQL } from "../../packages/hub/src/org/commit.js";
import { readDriverStatus } from "../../packages/hub/src/overview/driver-status.js";
import {
  CHARTER_BLOCKED_SQL,
  CHARTER_CANDIDATES_SQL,
  DEFAULT_CHARTER_MAX_ATTEMPTS,
} from "../../packages/hub/src/serve/charter-pump.js";
import {
  DEFAULT_DRIVER_MAX_ATTEMPTS,
  DRIVER_ELIGIBLE_STATES,
  driverBlockedSql,
  driverCandidatesSql,
} from "../../packages/hub/src/serve/driver-pump.js";

const NOW = 1_700_000_000_000;
const TMP = join(tmpdir(), "opc-round386-" + process.pid);
mkdirSync(TMP, { recursive: true });

const { WriteQueue } = await import("../../packages/hub/src/db/write-queue.js");
const { migrate } = await import("../../packages/hub/src/db/migrate.js");
const q = new WriteQueue(join(TMP, "p.db"));
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
  "探针用组织图",
);
db.prepare(
  "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at, graph_version) " +
    "VALUES ('t1', '想法 t1', 'IN_PROGRESS', 'intake', 'intake', ?, ?, 1)",
).run(NOW, NOW);

/** 消费侧的形状：直接摆出「这一格已经花了多少」+ 当时的上限。 */
function seed(limitCents: number, consumedCents: number): void {
  db.prepare(
    "INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, consumed_cents, hard_stop) " +
      "VALUES ('task|t1|per_task', 'task', 't1', 'per_task', ?, ?, 1) " +
      "ON CONFLICT(scope_type, scope_id, period) DO UPDATE SET limit_cents = excluded.limit_cents," +
      " consumed_cents = excluded.consumed_cents",
  ).run(limitCents, consumedCents);
}

/** 屏幕上那一次保存：PUT /budget 用的就是这条语句（只动 limit 与 hard_stop）。 */
function clickSave(limitCents: number): void {
  const n = UPSERT_BUDGET_ROW_SQL.split("?").length - 1;
  const params = [
    "task|t1|per_task",
    "task",
    "t1",
    "per_task",
    limitCents,
    1,
  ];
  if (n !== params.length) {
    throw new Error("绑参个数与语句不符：" + n + " vs " + params.length);
  }
  db.prepare(UPSERT_BUDGET_ROW_SQL).run(...(params as never[]));
}

const CLI = 500;

function readings(): string {
  const cc = (
    db
      .prepare(CHARTER_CANDIDATES_SQL)
      .all(CHARTER_CARD_KEY, DEFAULT_CHARTER_MAX_ATTEMPTS, CLI, 5) as {
      id: string;
    }[]
  ).map((x) => x.id);
  const cb = (
    db
      .prepare(CHARTER_BLOCKED_SQL)
      .all(CHARTER_CARD_KEY, DEFAULT_CHARTER_MAX_ATTEMPTS, CLI) as { id: string }[]
  ).map((x) => x.id);
  const dc = (
    db
      .prepare(driverCandidatesSql(DRIVER_ELIGIBLE_STATES))
      .all(
        ...(
          [
            ...DRIVER_ELIGIBLE_STATES,
            DEFAULT_DRIVER_MAX_ATTEMPTS,
            CLI,
            5,
          ] as never[]
        ),
      ) as { id: string }[]
  ).map((x) => x.id);
  const db_ = (
    db
      .prepare(driverBlockedSql(DRIVER_ELIGIBLE_STATES))
      .all(
        ...(
          [
            ...DRIVER_ELIGIBLE_STATES,
            DEFAULT_DRIVER_MAX_ATTEMPTS,
            CLI,
          ] as never[]
        ),
      ) as { id: string }[]
  ).map((x) => x.id);
  const st = readDriverStatus(db as never, {
    enabled: true,
    pumping: true,
    taskLimitCents: CLI,
  });
  return (
    "章程候选=" +
    JSON.stringify(cc) +
    " 章程挡下=" +
    JSON.stringify(cb) +
    " 驱动候选=" +
    JSON.stringify(dc) +
    " 驱动挡下=" +
    JSON.stringify(db_) +
    " 看板=" +
    JSON.stringify(st.stopped.map((s) => [s.task_id, s.cause]))
  );
}

const out: string[] = [];

// ① 库里没有那一格 ⇒ 命令行才是分母（consumed 也无从记起，恒 0）。
out.push("① 无预算行（CLI=500）              ：" + readings());

// ② 有行、上限与命令行一致、已花超 ⇒ 该挡（这是下面那发的分母）。
seed(500, 900);
out.push("② limit=500 consumed=900           ：" + readings());

// ③ ⭐ 决定性的一发：只把【那一列】抬到 5000，命令行一个字没动。
//    (A) 成立 ⇒ 与 ② 一模一样；(B)/(C) 成立 ⇒ 门开 + 看板那行消失。
clickSave(5000);
out.push("③ 保存成 limit=5000（CLI 仍 500）   ：" + readings());

// ④ 反向：列比命令行【小】⇒ 命令行说还许花、列说不许。赢家是列吗？
clickSave(100);
db.prepare(
  "UPDATE budgets SET consumed_cents = 200 WHERE scope_type='task' AND scope_id='t1'",
).run();
out.push("④ limit=100 consumed=200           ：" + readings());

// ⑤ 命令行抬到 9999 也救不回来？（列留 100）
const stHigh = readDriverStatus(db as never, {
  enabled: true,
  pumping: true,
  taskLimitCents: 9999,
});
const dcHigh = (
  db
    .prepare(driverCandidatesSql(DRIVER_ELIGIBLE_STATES))
    .all(
      ...(
        [
          ...DRIVER_ELIGIBLE_STATES,
          DEFAULT_DRIVER_MAX_ATTEMPTS,
          9999,
          5,
        ] as never[]
      ),
    ) as { id: string }[]
).map((x) => x.id);
out.push(
  "⑤ 列=100 而命令行 9999：驱动候选=" +
    JSON.stringify(dcHigh) +
    " 看板=" +
    JSON.stringify(stHigh.stopped.map((s) => [s.task_id, s.cause])),
);

// ⑥ 那一行整个删掉 ⇒ 回落到命令行（9999 之下）⇒ 该放行。
db.prepare(
  "DELETE FROM budgets WHERE scope_type='task' AND scope_id='t1'",
).run();
const dcGone = (
  db
    .prepare(driverCandidatesSql(DRIVER_ELIGIBLE_STATES))
    .all(
      ...(
        [
          ...DRIVER_ELIGIBLE_STATES,
          DEFAULT_DRIVER_MAX_ATTEMPTS,
          9999,
          5,
        ] as never[]
      ),
    ) as { id: string }[]
).map((x) => x.id);
out.push("⑥ 删掉那一行（CLI=9999）：驱动候选=" + JSON.stringify(dcGone));

// ⑦ 「带更高的 --task-limit-cents 重启」这一句所依赖的机制：下一笔钱记账时
//    runtime 会跑 ENSERT_BUDGET_SQL（ON CONFLICT DO NOTHING）把【新的命令行数】写进去。
//    那一行已经存在 ⇒ 新数字进得去吗？
const { ENSERT_BUDGET_SQL } = await import(
  "../../packages/hub/src/budget/tracker.js"
);
seed(100, 200);
db.prepare(ENSERT_BUDGET_SQL).run(
  "task|t1|per_task",
  "task",
  "t1",
  "per_task",
  9999,
);
const after = db
  .prepare(
    "SELECT limit_cents FROM budgets WHERE scope_type='task' AND scope_id='t1' AND period='per_task'",
  )
  .get() as { limit_cents: number };
out.push(
  "⑦ 那一行已在（limit=100）而命令行 9999 记账 ⇒ limit_cents 实到=" +
    after.limit_cents +
    "（9999 = 重启真换掉分母；100 = 那一行不吃命令行）",
);
// ⑦b 反过来：那一行【没有】时，同一发 ENSERT 会怎么写？
db.prepare(
  "DELETE FROM budgets WHERE scope_type='task' AND scope_id='t1'",
).run();
db.prepare(ENSERT_BUDGET_SQL).run(
  "task|t1|per_task",
  "task",
  "t1",
  "per_task",
  9999,
);
const fresh = db
  .prepare(
    "SELECT limit_cents FROM budgets WHERE scope_type='task' AND scope_id='t1' AND period='per_task'",
  )
  .get() as { limit_cents: number };
out.push(
  "⑦b 无那一行时同一发 ENSERT ⇒ limit_cents 实到=" + fresh.limit_cents,
);

// ⑧ 边界：--task-limit-cents 的校验是 /^\d+$/ ⇒ 0 过得了。CLI=0 而【没有】那一行时，
//    门会不会报 no_budget？会 ⇒ 界面上那句话不许断言「那一行一定存在」。
db.prepare(
  "DELETE FROM budgets WHERE scope_type='task' AND scope_id='t1'",
).run();
const stZero = readDriverStatus(db as never, {
  enabled: true,
  pumping: true,
  taskLimitCents: 0,
});
out.push(
  "⑧ 无那一行而 CLI=0：看板=" +
    JSON.stringify(stZero.stopped.map((s) => [s.task_id, s.cause])) +
    "（[] = 不报；[t1,no_budget] = 存在【没有那一行】的 no_budget）",
);

// ⑨ 界面上那句新话所依赖的那一步：【没有那一格】时，去预算页新增一行能不能开门？
//    （CLI=0 那一支是唯一「没有那一行也会报 no_budget」的形状，必须单独量。）
db.prepare(
  "DELETE FROM budgets WHERE scope_type='task' AND scope_id='t1'",
).run();
const before9 = readDriverStatus(db as never, {
  enabled: true,
  pumping: true,
  taskLimitCents: 0,
});
clickSave(5000); // 与 POST /budget 同一条语句：新增一行 task|t1|per_task
const after9 = readDriverStatus(db as never, {
  enabled: true,
  pumping: true,
  taskLimitCents: 0,
});
out.push(
  "⑨ CLI=0 且无那一格：改之前看板=" +
    JSON.stringify(before9.stopped.map((s) => [s.task_id, s.cause])) +
    " → 新增 task/t1/per_task=5000 之后=" +
    JSON.stringify(after9.stopped.map((s) => [s.task_id, s.cause])),
);

console.log(out.join("\n"));
await q.close();
rmSync(TMP, { recursive: true, force: true });
