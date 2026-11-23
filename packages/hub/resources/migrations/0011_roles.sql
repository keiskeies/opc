-- 0011_roles.sql —— 可配置角色表（design-2026-11-23-群角色上层.md D9/D11）
--
-- ── 这一条立的是什么 ────────────────────────────────────────────────
-- 上游 D9：角色从「写死在 COMPANY_NODES 的七个节点」变成「一张可配置的表」。
-- 表里装着完整公司树（boss/特助/产品/技术/设计/开发/测试/运营 + 财务/人事/法务/市场/销售
-- 全部激活），内置行不可删，自定义行在无人任职时可删。
--
-- ── 为什么不复用 role_charters ──────────────────────────────────────
-- role_charters 是【版本化岗位书】（唯一键 (role_id, version)），它回答「这个岗位的
-- charter 历史上改过几版」；roles 回答「公司现在的组织架构里有什么岗位、谁向谁汇报」。
-- 两者键形都不同（前者复合作主键，后者 role_id 单主键），硬塞一张表会让 0001 就记过的
-- 「trust_scores 外键无法指向复合唯一键」坑（0001 偏离说明 2）再踩一遍：
-- group_members/members 要引用 roles(role_id) 单列，必须存在一个恰好是 (role_id)
-- 的单列唯一索引，role_charters 给不了。
--
-- ── builtin 不可删的判据为什么落在触发器 ────────────────────────────────
-- 「内置角色不可删」（D9）若只写在应用层，任何一条绕过服务层的 INSERT/DELETE
-- （测试脚手架、未来脚本）都能静默删掉 boss。与 0010 同一立场：注释与校验拦不住的
-- 东西，不要只用注释与校验拦。触发器只挡 DELETE 与 kind 列的 UPDATE ——
-- builtin 行的 name/charter 仍可改（岗位书要迭代），但行本身与「它是内置的」这个事实焊死。
--
-- ── 种子为什么用固定 epoch 而不是 strftime('now') ─────────────────
-- 迁移必须逐字节可重放（同库重跑靠版本表跳过，但新库在任意机器跑出的行必须逐字一致，
-- 否则 schema 快照类测试跨机分叉）。Date.now 类的非确定值只进 schema_migrations.applied_at。
-- 种子时间取 2026-11-23T00:00:00Z = 1763856000000 毫秒。

CREATE TABLE roles (
  role_id      TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('builtin', 'custom')),
  category     TEXT NOT NULL,                    -- 职能分类（executive/product/engineering/design/support）
  reports_to   TEXT REFERENCES roles(role_id),   -- 公司树（D9：设计挂产品总监下）
  model_tier   TEXT NOT NULL CHECK (model_tier IN ('management', 'execution')),
  charter_json TEXT,                             -- 内嵌默认 charter（可空：纯汇报节点不带岗位书）
  avatar_seed  TEXT NOT NULL DEFAULT '',         -- 头像生成种子（真人感，D13）
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_roles_reports ON roles(reports_to);

-- 内置行禁删、禁改 kind。custom 行两个都不挡（D9：自定义可删，任职检查归应用层，
-- 因为「已卸任」要查 group_members，那是另一张表，触发器里跨表查会制造迁移顺序耦合）。
CREATE TRIGGER roles_builtin_no_delete BEFORE DELETE ON roles
WHEN old.kind = 'builtin'
BEGIN
  SELECT RAISE(ABORT, '内置角色不可删除（D9）：builtin 行随迁移而来，删除等于把公司树凿穿');
END;
CREATE TRIGGER roles_builtin_no_rekind BEFORE UPDATE OF kind ON roles
WHEN old.kind = 'builtin' AND new.kind <> old.kind
BEGIN
  SELECT RAISE(ABORT, '内置角色不可降级为 custom（D9）');
END;

-- ========== 种子：完整公司树（D9「全激活」，D11 语义 role_id） ==========
-- boss 是【人类锚点】（D1：老板不执行）；cos 即特助（D6/D16：规则优先分发 + @老板升级链终点）。
INSERT INTO roles (role_id, name, kind, category, reports_to, model_tier, charter_json, avatar_seed, created_at, updated_at) VALUES
  ('boss',             '老板',      'builtin', 'executive',   NULL,              'management', NULL, 'boss',             1763856000000, 1763856000000),
  ('cos',              '特助',      'builtin', 'executive',   'boss',            'management', NULL, 'cos',              1763856000000, 1763856000000),
  ('product_director', '产品总监',  'builtin', 'product',     'cos',             'management', NULL, 'product_director', 1763856000000, 1763856000000),
  ('tech_director',    '技术总监',  'builtin', 'engineering', 'cos',             'management', NULL, 'tech_director',    1763856000000, 1763856000000),
  ('dev',              '开发工程师', 'builtin', 'engineering', 'tech_director',   'execution',  NULL, 'dev',              1763856000000, 1763856000000),
  ('qa',               '测试工程师', 'builtin', 'engineering', 'tech_director',   'execution',  NULL, 'qa',               1763856000000, 1763856000000),
  ('designer',         '设计师',    'builtin', 'design',      'product_director','execution',  NULL, 'designer',         1763856000000, 1763856000000),
  ('ops',              '运营',      'builtin', 'product',     'product_director','execution',  NULL, 'ops',              1763856000000, 1763856000000),
  ('finance',          '财务',      'builtin', 'support',     'boss',            'execution',  NULL, 'finance',          1763856000000, 1763856000000),
  ('hr',               '人事',      'builtin', 'support',     'boss',            'execution',  NULL, 'hr',               1763856000000, 1763856000000),
  ('legal',            '法务',      'builtin', 'support',     'boss',            'execution',  NULL, 'legal',            1763856000000, 1763856000000),
  ('marketing',        '市场',      'builtin', 'support',     'boss',            'execution',  NULL, 'marketing',        1763856000000, 1763856000000),
  ('sales',            '销售',      'builtin', 'support',     'boss',            'execution',  NULL, 'sales',            1763856000000, 1763856000000);
