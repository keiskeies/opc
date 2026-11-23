-- 0025_cos_dispatch_rules.sql —— CoS 规则优先分发（T8）
--
-- 只追加表与索引，不回改前序迁移。group_id=NULL 是全局规则；本群规则同优先级优先。
-- 种子时间固定，保证新库在不同机器上逐字节一致；规则本身可停用，但不设历史触发器。

CREATE TABLE cos_dispatch_rules (
  rule_id        TEXT PRIMARY KEY,
  group_id       TEXT NULL REFERENCES groups(group_id),
  keyword        TEXT NOT NULL,
  target_role_id TEXT NOT NULL REFERENCES roles(role_id),
  priority       INTEGER NOT NULL DEFAULT 0,
  enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  CHECK (length(trim(keyword)) > 0)
);

CREATE INDEX idx_cos_dispatch_rules_lookup
  ON cos_dispatch_rules (group_id, enabled, priority DESC);

INSERT INTO cos_dispatch_rules
  (rule_id, group_id, keyword, target_role_id, priority, enabled, created_at, updated_at)
VALUES
  ('cos_rule_project', NULL, '立项', 'product_director', 10, 1, 1763856000000, 1763856000000),
  ('cos_rule_bug',     NULL, 'bug',  'dev',              0, 1, 1763856000000, 1763856000000),
  ('cos_rule_fix',     NULL, '修复', 'dev',              0, 1, 1763856000000, 1763856000000),
  ('cos_rule_test',    NULL, '测试', 'qa',               0, 1, 1763856000000, 1763856000000),
  ('cos_rule_product', NULL, '调研', 'product_director', 0, 1, 1763856000000, 1763856000000),
  ('cos_rule_design',  NULL, '设计', 'designer',         0, 1, 1763856000000, 1763856000000);
