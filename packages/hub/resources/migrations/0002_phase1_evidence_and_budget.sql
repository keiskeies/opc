-- Phase 1 的表扩展（计划 Task 1.1 / 1.6）
--
-- 为什么需要第二个迁移而不是改 0001_init.sql：0001 由 scripts/extract-appendix-c.mjs
-- 从规格附录 C 机械提取（文件头写明），改它就等于让「这份 DDL 逐字取自规格」这句
-- 声明变成假话；而 events / tasks 这些表在已有部署的库里【已经存在】，改 0001 对
-- 老库零作用（版本表说 0001 已应用，永远不会重跑）。扩展只能往后加。
--
-- 全部语句只用 ALTER TABLE ADD COLUMN / CREATE TABLE，不用 DROP / RENAME：
-- SQLite 的 ALTER 能力有限是事实，但更重要的是这个仓库的立场 —— 审计库 append-only，
-- 任何「删列 / 改名」都会让历史回放到一个不存在的字段上。
--
-- 不含 PRAGMA：连接级设置归 src/db/pragmas.ts（test/db/migrate.test.ts 有一条守卫专门
-- 拦这个，报错直接点名那个文件）。

-- ========== 证据包（Task 1.1）==========
--
-- 0001 的 evidence_bundles 只有 (id, task_id, producer_role, bundle_type, artifacts,
-- self_check, created_at)。门控要判的两件事【没有列可存】：
--   ① 产出方的模型家族 —— §24 风险 1 的「审阅方与产出方不得同家族」要读它，
--      review_gates.reviewer_model_family 有列，产出方却没有 ⇒ 这条判定无从执行；
--   ② claims（每条主张及其 evidence_refs）—— §8.2 第 2 条「通过必须附可验证证据」
--      的可判定形态就是它，只存 artifacts 的话「主张有没有依据」这句话在库里问不出来。
ALTER TABLE evidence_bundles ADD COLUMN model_family TEXT;
ALTER TABLE evidence_bundles ADD COLUMN claims TEXT;
ALTER TABLE evidence_bundles ADD COLUMN honesty_boundaries TEXT;

-- ========== 预算事件的幂等（Task 1.6）==========
--
-- 计划 Task 1.6 的 Test 项写着「同一预算事件的重复上报【不重复扣减】」。
-- 光靠 budgets.consumed_cents 做不到：UPDATE consumed_cents = consumed_cents + ?
-- 是【非幂等】的，同一条消费上报两次就扣两倍，而崩溃重启恰好会重放上报（0005 §11 的
-- 那条重放缺陷就是这个形状）。所以幂等必须有一个【唯一键】来承载 —— 这就是这张表。
--
-- source_event 唯一 = 幂等键。取值是 events.id（seq），不是自造 UUID：seq 由
-- events.id 派生（0005 §3），重放同一条审计行拿到的是同一个 seq，而自造 UUID
-- 在重放时会生成新的那个，幂等键当场失效。
CREATE TABLE budget_events (
  source_event INTEGER PRIMARY KEY,             -- events.id；重复上报被主键挡下
  scope_type TEXT NOT NULL,                     -- 'role' | 'task' | 'company'（§21.1 三级）
  scope_id TEXT NOT NULL,
  period TEXT NOT NULL,                         -- 'daily' | 'monthly' | 'per_task'
  amount_cents INTEGER NOT NULL,                -- 美分，整数（§6.1 禁浮点）
  task_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_budget_events_scope ON budget_events(scope_type, scope_id, period);
