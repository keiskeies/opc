-- 0018_backlog.sql —— 任务管理面板（D10 / 上游 §2.6）
--
-- ── backlog 与 tasks 的关系 ────────────────────────────────────────
-- tasks（0001）是【执行态】：进入状态机、有图谱节点、花预算。
-- backlog_items 是【意图态】：还没立项（task_id NULL）、或立项后拆出的子项（task_id 回填）。
-- 面板的六操作（取消/移动/延期/优先级/拆分/合并）全是对本行的 UPDATE/INSERT：
--   取消   → state='cancelled'（软删，历史保留）
--   移动   → 改 group_id（跨群挪）
--   延期   → 改 due_at
--   优先级 → 改 priority（小者先，允许负数=加急）
--   拆分   → 新行 parent_id 指回原件
--   合并   → 本行 state='cancelled' + merged_into 指向目标行（【原件保留】，合并可追溯）
-- 为什么拆/合不删原件：面板是老板的记忆外化，「上周那条被合到哪了」必须答得出。
--
-- ── state 与 tasks.status 为什么词表不同 ──────────────────────────
-- backlog 没有执行语义（不进图谱、不过审阅门控），词表是看板列
-- （backlog/scheduled/doing/done/cancelled）。与 tasks 的 §7.1 状态机强行同词表
-- 会让面板的「拖一列」触发执行态校验，这是把两层治理（上游 §3）焊死在第一层上。
-- 衔接点只有一个：backlog 项立项 ⇒ 建 task 并回填 task_id，之后状态各自演进。

CREATE TABLE backlog_items (
  id         TEXT PRIMARY KEY,
  group_id   TEXT REFERENCES groups(group_id),
  task_id    TEXT REFERENCES tasks(id),
  title      TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  state      TEXT NOT NULL CHECK (state IN
             ('backlog', 'scheduled', 'doing', 'done', 'cancelled')),
  priority   INTEGER NOT NULL DEFAULT 0,
  due_at     INTEGER,
  parent_id  TEXT REFERENCES backlog_items(id),
  merged_into TEXT REFERENCES backlog_items(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- 合并目标只在取消时存在：「活着但已合到别处」的面板项无法渲染（该显示它还是显示目标？）
  CHECK (merged_into IS NULL OR state = 'cancelled')
);
CREATE INDEX idx_backlog_group ON backlog_items(group_id, state);
CREATE INDEX idx_backlog_due ON backlog_items(due_at);
