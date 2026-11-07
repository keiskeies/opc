-- OPC-OS 初始 schema（Task 0.5）
--
-- 本文件的 DDL 由 packages/hub/scripts/extract-appendix-c.mjs 从规格附录 C
-- （docs/OPC-OS-设计文档.md §附录 C）**机械提取**生成，除下方声明的偏离外逐字一致。
-- 之所以用脚本提取而不是手抄：规格 17 张表 3 千多字符，手抄的差异只能靠肉眼发现，
-- 而 schema 差异的表现形式是「本地正常、别人机器上查询报 no such column」。
--
-- 相对附录 C 的偏离（共 2 处，均已实测验证必要性）：
--
-- 1) 删除开头的 4 条 PRAGMA。journal_mode / busy_timeout / synchronous / foreign_keys
--    是【每次连接】要施加的设置，由 src/db/pragmas.ts 与 driver.openDb() 负责，是全仓库
--    唯一权威源。把它们放进一次性迁移脚本会制造错觉：除 journal_mode 外都是连接级设置，
--    写进迁移只对「执行迁移那条连接」生效。另实测：事务内 PRAGMA journal_mode = WAL 会抛
--    'cannot change into wal mode from within a transaction'，而迁移必须整体包事务
--    （否则失败会留下半套表），两者不共存。
--
-- 2) trust_scores.role_id 去掉 REFERENCES role_charters(role_id)。附录 C 原文是
--    'role_id TEXT PRIMARY KEY REFERENCES role_charters(role_id)'，但 role_charters 是
--    【版本化】表，唯一键只有 (id) 与 (role_id, version)（实测 PRAGMA index_list）。
--    SQLite 要求被引用列构成一个列集合完全一致的唯一索引，不支持前缀匹配 —— 于是
--    建表【静默成功】，直到任何写入或 PRAGMA foreign_key_check 才炸：
--      foreign key mismatch - 'trust_scores' referencing 'role_charters'
--    计划 Task 0.5 的验收要求 foreign_key_check 无输出，此处不改就永远红。
--    代价：role_id 的引用完整性不再由数据库保证。它是岗位书角色标识，取值来自
--    role_charters 的查询结果，由应用层维持（Task 1.4 岗位书 CRUD 时补断言）。
--    已在 test/db/schema-0001.test.ts 用反向用例守住：其余 9 个外键仍必须有效。
--
-- 不加 IF NOT EXISTS：幂等由 schema_migrations 版本表保证（见 src/db/migrate.ts）。
-- 这里刻意让重复执行报 'table already exists' —— 版本表说没应用过、库里却有表，
-- 说明 schema 与版本记录已经分叉（有人手动建过表，或版本表被删）。这种时候【必须炸】，
-- 静默跳过等于把分叉留在库里。


-- ========== 任务 ==========
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,                       -- UUID 字符串
  parent_id TEXT REFERENCES tasks(id),
  charter_id TEXT REFERENCES charters(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL,                      -- 状态机枚举（§7.1）
  assigned_role TEXT NOT NULL,
  current_node TEXT NOT NULL,
  budget_cents INTEGER,                      -- 美分
  consumed_cents INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,               -- Unix 毫秒
  updated_at INTEGER NOT NULL,
  state_snapshot TEXT,                       -- JSON 字符串
  graph_checkpoint_id TEXT,
  graph_version INTEGER NOT NULL DEFAULT 1   -- 创建时组织图版本（§18.4）
);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_parent ON tasks(parent_id);

-- ========== 事件日志（append-only） ==========
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT REFERENCES tasks(id),
  actor_type TEXT NOT NULL,                  -- 'agent' | 'human' | 'system'
  actor_id TEXT NOT NULL,                    -- role_id 或 'ceo'
  action TEXT NOT NULL,                      -- §22.1 枚举
  target TEXT,
  payload TEXT NOT NULL,                     -- JSON 字符串
  state_snapshot TEXT,                       -- 决定时的完整状态快照
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_events_task   ON events(task_id, created_at);
CREATE INDEX idx_events_action ON events(action, created_at);

-- 强制 append-only：禁止 UPDATE 和 DELETE（node:sqlite 实测：UPDATE/DELETE 均被成功拦截）
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events table is append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events table is append-only'); END;

-- 全文搜索（替代 PG 全文索引）
-- ⚠ 分词器必须显式指定：默认 unicode61 对中文连续串按"整串一词"处理，
--   实测检索『覆盖率』命中 0；trigram 实测命中 1。见 C.3。
CREATE VIRTUAL TABLE events_fts USING fts5(
  payload,
  content='events',
  content_rowid='id',
  tokenize = 'trigram'
);
CREATE TRIGGER events_fts_insert AFTER INSERT ON events
BEGIN INSERT INTO events_fts(rowid, payload) VALUES (new.id, new.payload); END;

-- 删除/更新事件表时同步 FTS（external content 表必须手工维护）
CREATE TRIGGER events_fts_ad AFTER DELETE ON events
BEGIN INSERT INTO events_fts(events_fts, rowid, payload) VALUES('delete', old.id, old.payload); END;
CREATE TRIGGER events_fts_au AFTER UPDATE ON events
BEGIN
  INSERT INTO events_fts(events_fts, rowid, payload) VALUES('delete', old.id, old.payload);
  INSERT INTO events_fts(events_fts, rowid, payload) VALUES('insert', new.id, new.payload);
END;
-- 注：events 上的 no_update/no_delete 触发器会先 RAISE(ABORT)，
--     因此这两个同步触发器实际是为"未来若放宽约束"预留，正常运行期不会被触发。

-- ========== 证据包 ==========
CREATE TABLE evidence_bundles (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  producer_role TEXT NOT NULL,
  bundle_type TEXT NOT NULL,                 -- 'prd'|'tech_plan'|'code_diff'|'test_report'|'content_package'
  artifacts TEXT NOT NULL,                   -- JSON: 文件路径 / sha256 / 外部链接
  self_check TEXT,                           -- JSON（标注“自检，非独立验证”）
  created_at INTEGER NOT NULL
);

-- ========== 审阅门控 ==========
CREATE TABLE review_gates (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  gate_type TEXT NOT NULL,                   -- 'product_to_tech'|'tech_to_dev'|'dev_to_test'|'test_upward'…
  reviewer_role TEXT NOT NULL,
  reviewer_model_family TEXT,                -- §24 风险1：审阅共谋分析
  evidence_bundle_id TEXT REFERENCES evidence_bundles(id),
  decision TEXT,                             -- 'approved'|'rejected'|'conditional'|'escalated'
  decision_reason TEXT,
  conditions TEXT,                           -- JSON 数组（有条件通过的条件清单）
  round_no INTEGER,
  decided_at INTEGER
);
CREATE INDEX idx_gates_task ON review_gates(task_id);

-- ========== CEO 审批收件箱 ==========
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  approval_type TEXT NOT NULL,               -- 'charter'|'strategic'|'irreversible_action'|'budget_override'|'meeting_escalation'
  summary TEXT NOT NULL,                     -- 一行摘要
  parameters TEXT NOT NULL,                  -- JSON: 金额/影响范围/不可逆性标记
  recommendation TEXT,                       -- 标注“推荐，非决定”
  recommendation_source TEXT,
  timeout_behavior TEXT,                     -- 'auto_approve'|'auto_reject'|'escalate'
  timeout_at INTEGER,
  status TEXT DEFAULT 'pending',             -- 'pending'|'approved'|'rejected'|'deferred'
  decided_by TEXT,
  decided_at INTEGER,
  decision_note TEXT
);
CREATE INDEX idx_approvals_status ON approvals(status, timeout_at);

-- ========== 岗位书（版本化） ==========
CREATE TABLE role_charters (
  id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  config TEXT NOT NULL,                      -- 完整岗位书 YAML 的 JSON 表示
  effective_from INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  UNIQUE(role_id, version)
);

-- ========== 委派 / 组织图（版本化，§18.4） ==========
CREATE TABLE delegation_graphs (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  graph_json TEXT NOT NULL,                  -- nodes + edges + gates 完整序列化
  effective_from INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  change_summary TEXT,
  UNIQUE(version)
);

-- ========== 预算（三级） ==========
CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,                  -- 'company'|'role'|'task'
  scope_id TEXT NOT NULL,
  period TEXT NOT NULL,                      -- 'daily'|'monthly'|'per_task'
  limit_cents INTEGER NOT NULL,
  consumed_cents INTEGER DEFAULT 0,
  hard_stop INTEGER DEFAULT 1
);
CREATE UNIQUE INDEX idx_budgets_scope ON budgets(scope_type, scope_id, period);

-- ========== 信任积分（§4.4） ==========
CREATE TABLE trust_scores (
  role_id TEXT NOT NULL,
  current REAL NOT NULL,
  history_window INTEGER NOT NULL DEFAULT 50,
  components TEXT NOT NULL,                  -- JSON
  pending_change_id TEXT,                    -- 待 CEO 批准的调整建议
  updated_at INTEGER NOT NULL
);

-- ========== 章程 ==========
CREATE TABLE charters (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  business_goal TEXT NOT NULL,
  success_criteria TEXT NOT NULL,            -- JSON 数组：3 条可量化标准
  budget_cents INTEGER,
  deadline INTEGER,
  initial_roles TEXT,                        -- JSON
  approved_by TEXT, approved_at INTEGER
);

-- ========== 会议（§10） ==========
CREATE TABLE meetings (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  meeting_type TEXT NOT NULL,                -- 'review'|'debate'|'decision'
  participants TEXT NOT NULL,                -- JSON
  convergence_score REAL,                    -- 辩论会收敛度
  consensus TEXT, divergences TEXT,          -- JSON
  escalation_path TEXT,
  created_at INTEGER NOT NULL
);

-- ========== 文件制品索引（§6.4） ==========
CREATE TABLE artifacts_meta (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  kind TEXT NOT NULL,                        -- 'prd'|'code_diff'|'test_report'|'content_package'
  rel_path TEXT NOT NULL,                    -- artifacts/{task_id}/{kind}/{bundle_id}.*
  sha256 TEXT NOT NULL,
  size_bytes INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_artifacts_task ON artifacts_meta(task_id, kind);

-- ========== Skills 挂载记录（§14.3） ==========
CREATE TABLE skill_mounts (
  id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,                    -- 如 'leijun-skill-v2'
  skill_version TEXT NOT NULL,
  source TEXT,                               -- 来源与蒸馏者
  honesty_boundaries TEXT,                   -- JSON：诚实边界
  mounted_from INTEGER NOT NULL, mounted_to INTEGER,
  mounted_by TEXT NOT NULL                   -- 只有 CEO 可挂载/卸载
);

-- ========== Harness 调用（§12.7 第4层） ==========
CREATE TABLE harness_calls (
  id TEXT PRIMARY KEY,
  task_id TEXT, agent_role TEXT NOT NULL,
  harness TEXT NOT NULL, harness_version TEXT NOT NULL,
  args_redacted TEXT NOT NULL,               -- 脱敏后参数
  session_id TEXT, exit_code INTEGER,
  diff_sha256 TEXT, cost_cents INTEGER,
  verified_by_gate TEXT,                     -- 对应测试门控 id
  created_at INTEGER NOT NULL
);

-- ========== IM 通道（§11.3） ==========
CREATE TABLE im_bindings (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,                    -- 'feishu'|'wecom'|'qq'
  external_user_id TEXT NOT NULL,
  ceo_role TEXT NOT NULL DEFAULT 'ceo',
  verified INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE im_tokens (
  token TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL, used INTEGER DEFAULT 0
);

-- ========== 预算/凭证分离（§20.4） ==========
CREATE TABLE secrets (
  key TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,                  -- 加密 at rest，仅 Hub 层可读
  created_at INTEGER NOT NULL
);
