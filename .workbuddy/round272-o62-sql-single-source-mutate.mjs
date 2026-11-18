// round272 O6 动作 2（预算 SQL 收敛成单源）的变异证据（自恢复）。
//
// 三发，各打一条这一轮新立/改写的判据：
//  M1 把 ENSERT_BUDGET_SQL 的调用换回【手抄字面量】（= 退回收敛前的形状）
//     ⇒ 红两条：`r1 的另一半：引擎路线【复用】那条语句` + `r1 取材非空`（语句从 2 条变 3 条）。
//     这一发证明「不许再抄」不是写在注释里的愿望。
//  M2 把扣减那一句删掉（账只声明不扣 = 预算恒不前进）
//     ⇒ 红 `r1 的另一半` 的反向对照 + hub 侧真跑那一发（budgets.consumed_cents 不再等于 4）。
//     这一发证明「runtime 不含字面量」不能靠【删掉记账】白拿。
//  M3 把绑参的 scope 从 "task" 改成 "role"（语句没变而作用域写错 ⇒ 同一件事两个作用域）
//     ⇒ hub 侧红（budgets 那行的 scope_type 变了，而字面量判据一条都看不见 ——
//        它证明收敛只解决【两份 SQL】，不解决【绑参写错】，那一半仍由执行证据守着）。
//
// 用法：node .workbuddy/round272-o62-sql-single-source-mutate.mjs apply M1|M2|M3
//       node .workbuddy/round272-o62-sql-single-source-mutate.mjs revert
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "packages/hub/src/engine/runtime.ts";

const MUTS = {
  M1: [
    "      db.prepare(ENSERT_BUDGET_SQL).run(",
    '      db.prepare("INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, consumed_cents, hard_stop) VALUES (?, ?, ?, ?, ?, 0, 1) ON CONFLICT(scope_type, scope_id, period) DO NOTHING").run(',
  ],
  M2: [
    '      db.prepare(ADD_CONSUMED_SQL).run(o.costCents, "task", o.taskId, "per_task");',
    "      void ADD_CONSUMED_SQL;",
  ],
  M3: [
    '      db.prepare(ADD_CONSUMED_SQL).run(o.costCents, "task", o.taskId, "per_task");',
    '      db.prepare(ADD_CONSUMED_SQL).run(o.costCents, "role", o.taskId, "per_task");',
  ],
};

const origin = (key) => ".workbuddy/round272-o62-orig-" + key + ".ts";

const cmd = process.argv[2];
if (cmd === "apply") {
  const key = process.argv[3];
  const m = MUTS[key];
  if (m === undefined) throw new Error("M1|M2|M3，实到 " + key);
  const src = readFileSync(FILE, "utf8");
  const n = src.split(m[0]).length - 1;
  if (n !== 1) throw new Error(key + " 锚点出现 " + n + " 次，不是恰好一次，拒绝施加");
  writeFileSync(origin(key), src);
  writeFileSync(FILE, src.replace(m[0], m[1]));
  console.log("已施加 " + key);
} else if (cmd === "revert") {
  let any = false;
  for (const key of Object.keys(MUTS)) {
    let orig;
    try {
      orig = readFileSync(origin(key), "utf8");
    } catch {
      continue;
    }
    writeFileSync(FILE, orig);
    if (readFileSync(FILE, "utf8") !== orig) throw new Error(key + " 还原后逐字节核对失败");
    any = true;
    console.log("已还原 " + key + " 并核对一致");
  }
  if (!any) console.log("没有待还原的原件（本轮尚未 apply，或已还原过）");
} else {
  throw new Error("用法: apply M1|M2|M3 | revert");
}
