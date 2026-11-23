-- 0015_conversations.sql —— 会话与消息（D2/D5）
--
-- ── 会话两类（上游 §2.5）────────────────────────────────────────────
-- kind='group'：群会话，每个群恰好一条（唯一索引保证）。
-- kind='private'：成员两两私聊，跨群可读（D5：私聊跟【人】走，不跟群走）。
--
-- ── 私聊键的归一化为什么用 CHECK (member_a < member_b) ─────────────
-- (a,b) 与 (b,a) 是同一条私聊。创建时排序归一（member_a 恒取字典序小者）+
-- 部分唯一索引让数据库兜底。光靠应用层排序，任何一条旁路写入都能开出第二条私聊线，
-- 前端会把同一个人的私聊渲染成两个会话条目 —— 这正是 D5「跨群可读」想消灭的体验。
-- CHECK 让「归一化」成为库级不变量：插 (b,a) 直接炸，而不是安静地长出平行会话。
--
-- ── seq_in_conv 与 events.id 的关系 ────────────────────────────────
-- events.id（= seq）是【全库】广播游标；seq_in_conv 是【会话内】翻页游标。
-- 两者各司其职：SSE 增量按 events.id 续订（跨会话不漏不重），会话上拉历史按
-- (conversation_id, seq_in_conv) 翻页（不需要认识全局游标）。
-- 不用 created_at 翻页：毫秒可撞，撞了翻页就丢消息。
--
-- ── 作者三态（author_kind）─────────────────────────────────────────
-- 消息可能来自：成员（AI 同事）、老板（人类）、系统（特助播发的节奏事件/入群通知）。
-- sender_member_id 仅对成员消息非空；老板与系统消息留 NULL，author_kind 判别。
-- 这是渲染层「气泡靠左靠右、头像取谁的」的唯一判据。
--
-- ── mentions_json 与 unread ────────────────────────────────────────
-- mentions_json 记被 @ 的 member_id 数组（@老板 记特殊值 '@boss'，D16 升级链入口）。
-- 未读数由 message_reads 推导（游标之后的消息计数），不另设计数器列 ——
-- 计数器与消息表不一致时，红点比没有红点更糟。

CREATE TABLE conversations (
  conversation_id TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('group', 'private')),
  group_id        TEXT REFERENCES groups(group_id),
  member_a        TEXT REFERENCES members(member_id),
  member_b        TEXT REFERENCES members(member_id),
  title           TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  CHECK (
    (kind = 'group'   AND group_id IS NOT NULL AND member_a IS NULL AND member_b IS NULL)
    OR
    (kind = 'private' AND group_id IS NULL AND member_a IS NOT NULL AND member_b IS NOT NULL
                       AND member_a < member_b)
  )
);
CREATE UNIQUE INDEX idx_conv_group ON conversations(group_id) WHERE kind = 'group';
CREATE UNIQUE INDEX idx_conv_pair  ON conversations(member_a, member_b) WHERE kind = 'private';

CREATE TABLE messages (
  message_id       TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(conversation_id),
  sender_member_id TEXT REFERENCES members(member_id),
  author_kind      TEXT NOT NULL CHECK (author_kind IN ('member', 'boss', 'system')),
  body             TEXT NOT NULL,
  mentions_json    TEXT NOT NULL DEFAULT '[]',    -- JSON 数组：member_id 或 '@boss'
  reply_to         TEXT REFERENCES messages(message_id),
  kind             TEXT NOT NULL DEFAULT 'text' CHECK (kind IN
                   ('text', 'system', 'meeting_card', 'backlog_card', 'doc_card')),
  seq_in_conv      INTEGER NOT NULL,
  created_at       INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_messages_conv_seq ON messages(conversation_id, seq_in_conv);
CREATE INDEX idx_messages_created ON messages(created_at);

CREATE TABLE message_reads (
  conversation_id   TEXT NOT NULL REFERENCES conversations(conversation_id),
  reader            TEXT NOT NULL,                -- 老板恒为 'boss'；成员为 member_id
  last_seq_in_conv  INTEGER NOT NULL DEFAULT 0,
  read_at           INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, reader)
);

-- 消息全文检索（全局搜索面，上游 §2.7 顶栏搜索）：external-content FTS5，
-- 形状逐字对齐 0001 的 events_fts（trigram 分词，中文子串可搜）。
CREATE VIRTUAL TABLE messages_fts USING fts5(
  body,
  content='messages',
  content_rowid='rowid',
  tokenize = 'trigram'
);
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages
BEGIN INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body); END;
CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages
BEGIN INSERT INTO messages_fts(messages_fts, rowid, body) VALUES('delete', old.rowid, old.body); END;
CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES('delete', old.rowid, old.body);
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES('insert', new.rowid, new.body);
END;
