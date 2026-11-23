-- 0014_groups.sql —— 群 = 一个任务（D2/D6）
--
-- ── 群是什么（上游 §2.2）──────────────────────────────────────────────
-- 一个群对应一个任务（老板的一句话、一个目标），群里有特助（cos_member_id，建群即自动拉入）
-- 与若干成员。任务可以后立项：建群时 task_id 为 NULL，老板说「立项」且特助规则命中后回填。
--
-- ── 为什么 cos_member_id 直接挂在 groups 上 ────────────────────────
-- D6：特助是【系统内置席位】，每个群恰好一个，且分发/升级链（D16）每次都要读它。
-- 放进 group_members 的一个 seat='cos' 行要靠「查 seat 列」找特助，
-- 「恰好一个」这个不变量在表上表达不出来（部分唯一索引只能保证≤1，不能保证=1）。
-- 独立列 + FK：NOT NULL 由应用层在建群事务里保证（特助成员先建、群后建，同一事务）。
-- 这里留 NULL 可空是因为迁移对既有库运行，而既有库不可能有群——真正的
-- 「建群必带特助」不变量在 store 层事务里守（src/groups/service.ts），DDL 提供 FK 形状。
--
-- ── task_id 可空的代价 ─────────────────────────────────────────────
-- 「群=任务」是 1:1 语义，但立项前群先存在，所以 FK 可空且【不加唯一索引】
-- （同一任务不重复开群由应用层查重；若加 UNIQUE(task_id)，NULL 参与唯一性的
-- SQLite 行为是「多个 NULL 互不冲突」，恰好表达不了「一个任务最多一个群」之外的任何约束，
-- 反而给未来的迁移留下「改索引时忘了 NULL 语义」的坑）。

CREATE TABLE groups (
  group_id       TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  goal           TEXT NOT NULL DEFAULT '',
  task_id        TEXT REFERENCES tasks(id),
  cos_member_id  TEXT REFERENCES members(member_id),
  status         TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_groups_task ON groups(task_id);

-- 任职关系（群 ↔ 成员，多对多）
CREATE TABLE group_members (
  group_id  TEXT NOT NULL REFERENCES groups(group_id),
  member_id TEXT NOT NULL REFERENCES members(member_id),
  role_id   TEXT NOT NULL REFERENCES roles(role_id),   -- 任职岗位（可与成员默认岗位不同：兼任）
  seat      TEXT NOT NULL CHECK (seat IN ('cos', 'member')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, member_id)
);
CREATE INDEX idx_group_members_member ON group_members(member_id);
