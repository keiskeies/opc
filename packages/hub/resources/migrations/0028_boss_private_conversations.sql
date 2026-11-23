-- 0028_boss_private_conversations.sql —— 老板与成员 1:1 私聊
--
-- 0015 的 member_a/member_b 都直接 REFERENCES members，因此 'boss' 永远插不进去。
-- 本迁移只拆掉这两条成员 FK：group_id 的群 FK、两类会话的形状 CHECK、
-- 私聊归一化与唯一索引全部保留。参与者存在性改由 BEFORE INSERT/UPDATE
-- 触发器守，避免「去掉 FK」同时把悬空 member 也一起放开。
--
-- 为什么先备份 messages/message_reads：driver 的每条连接都 foreign_keys=ON，
-- 而 defer_foreign_keys 不会让 DROP TABLE 父表时立即发生的 NO ACTION 变成可延迟。
-- 先在同一事务里把两张子表复制到 TEMP 表并清空，父表重建后再原样插回；
-- COMMIT 前任何一步失败都会由迁移框架整体 ROLLBACK，消息、游标与会话一起复原。

PRAGMA defer_foreign_keys = ON;

CREATE TEMP TABLE conversations_0028_messages AS SELECT * FROM messages;
CREATE TEMP TABLE conversations_0028_message_reads AS SELECT * FROM message_reads;
DELETE FROM message_reads;
DELETE FROM messages;

CREATE TABLE conversations_new (
  conversation_id TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('group', 'private')),
  group_id        TEXT REFERENCES groups(group_id),
  member_a        TEXT,
  member_b        TEXT,
  title           TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  CHECK (
    (kind = 'group'   AND group_id IS NOT NULL AND member_a IS NULL AND member_b IS NULL)
    OR
    (kind = 'private' AND group_id IS NULL AND member_a IS NOT NULL AND member_b IS NOT NULL
                       AND member_a < member_b)
  )
);

INSERT INTO conversations_new
  (conversation_id, kind, group_id, member_a, member_b, title, created_at)
SELECT conversation_id, kind, group_id, member_a, member_b, title, created_at
FROM conversations;

DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;

CREATE UNIQUE INDEX idx_conv_group ON conversations(group_id) WHERE kind = 'group';
CREATE UNIQUE INDEX idx_conv_pair  ON conversations(member_a, member_b) WHERE kind = 'private';

CREATE TRIGGER conversations_private_insert_participants
BEFORE INSERT ON conversations
WHEN NEW.kind = 'private'
BEGIN
  SELECT RAISE(ABORT, 'CHECK constraint：private 会话必须是老板与真实成员，或两位真实成员')
  WHERE NOT (
    (NEW.member_a = 'boss' AND NEW.member_b <> 'boss'
      AND EXISTS (SELECT 1 FROM members WHERE member_id = NEW.member_b))
    OR
    (NEW.member_b = 'boss' AND NEW.member_a <> 'boss'
      AND EXISTS (SELECT 1 FROM members WHERE member_id = NEW.member_a))
    OR
    (NEW.member_a <> 'boss' AND NEW.member_b <> 'boss'
      AND EXISTS (SELECT 1 FROM members WHERE member_id = NEW.member_a)
      AND EXISTS (SELECT 1 FROM members WHERE member_id = NEW.member_b))
  );
END;

CREATE TRIGGER conversations_private_update_participants
BEFORE UPDATE ON conversations
WHEN NEW.kind = 'private'
BEGIN
  SELECT RAISE(ABORT, 'CHECK constraint：private 会话必须是老板与真实成员，或两位真实成员')
  WHERE NOT (
    (NEW.member_a = 'boss' AND NEW.member_b <> 'boss'
      AND EXISTS (SELECT 1 FROM members WHERE member_id = NEW.member_b))
    OR
    (NEW.member_b = 'boss' AND NEW.member_a <> 'boss'
      AND EXISTS (SELECT 1 FROM members WHERE member_id = NEW.member_a))
    OR
    (NEW.member_a <> 'boss' AND NEW.member_b <> 'boss'
      AND EXISTS (SELECT 1 FROM members WHERE member_id = NEW.member_a)
      AND EXISTS (SELECT 1 FROM members WHERE member_id = NEW.member_b))
  );
END;

INSERT INTO messages SELECT * FROM conversations_0028_messages;
INSERT INTO message_reads SELECT * FROM conversations_0028_message_reads;
DROP TABLE conversations_0028_messages;
DROP TABLE conversations_0028_message_reads;
