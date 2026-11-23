-- 0017_meetings_real.sql —— 真实会议（D8 / 上游 §2.4）
--
-- ── 为什么不另起炉灶 ───────────────────────────────────────────────
-- 0001 已有 meetings（规格 §10：review/debate/decision 三类，带收敛度与共识 JSON）。
-- 上游 D8 要的「真实会议」是它的【上层呈现与推进方式】（发言序列 + 主持 + 结论三件套），
-- 不是另一个领域对象。开第二张表等于让「有几场会」这个问题有两个答案 ——
-- 这正是 dead-modules 与 zero-producer 这对守卫合谋消灭的形状。
-- 本文件用 ALTER TABLE 扩列（0002/0004/0005/0010 的既有惯例：没有一次重建表），
-- 0001 的原列语义不动：meeting_type 继续分三类，新增列填充实会议机制。
--
-- ── 结论三件套为什么 CHECK 绑在 concluded 状态上 ──────────────────
-- 上游 §2.4：会议必须以（决定 decision + 负责人 owner + 截止 deadline）收尾，
-- 缺一不算开完。CHECK(status <> 'concluded' OR 三列全非空) 让「凑合收尾」在 DDL 层失败。
-- 代价：应用层要一次 UPDATE 同时写四列；这正是要的原子性 ——
-- 分两次写（先填三件套后置 concluded）本来也该在一个事务里。
--
-- ── 发言序列的形状 ─────────────────────────────────────────────────
-- speaking_order_json 是 member_id 数组（开场时的既定顺序）；实际发言落 meeting_turns
-- 逐行。两者可分叉（主持临场指定下一位，D8），分叉是【合法且预期】的，
-- 所以 turn_seq 只对自己单调，不与 order 对齐；回放以 turns 为准，order 只是初始脚本。
--
-- ── 会议与消息的边界 ─────────────────────────────────────────────────
-- 会议【不】往 messages 里灌水：发言回合是结构化事实（谁/第几轮/内容），
-- 群会话里只出现一张 meeting_card 消息（messages.kind 已备此值）作为入口指针。
-- 理由与实施计划 A2 同源：会话流是时间线，会议是子结构；混写会让未读数与翻页
-- 被一场会刷爆。

ALTER TABLE meetings ADD COLUMN group_id TEXT REFERENCES groups(group_id);
ALTER TABLE meetings ADD COLUMN moderator_member_id TEXT REFERENCES members(member_id);
ALTER TABLE meetings ADD COLUMN speaking_order_json TEXT;   -- 开场发言顺序（member_id 数组）
ALTER TABLE meetings ADD COLUMN status TEXT NOT NULL DEFAULT 'open' CHECK (status IN
  ('open', 'concluded', 'cancelled'));
-- 结论三件套的落列顺序是承重的：SQLite 的列级 CHECK 只能引用【已存在】的列，
-- 所以带判据的 decision 必须排在 owner/deadline 之后（实测：反序在 ALTER 当场报
-- "no such column"）。三列各自可空，约束整体挂在 decision 上 ——
-- 「concluded ⇒ 三列全非空」是一条跨列不变量，放哪一列都是表达，放最后出现的
-- 那一列是唯一能成立的放法。
ALTER TABLE meetings ADD COLUMN owner_member_id TEXT REFERENCES members(member_id);
ALTER TABLE meetings ADD COLUMN deadline_at INTEGER;
ALTER TABLE meetings ADD COLUMN decision TEXT CHECK (
  status <> 'concluded'
  OR (decision IS NOT NULL AND owner_member_id IS NOT NULL AND deadline_at IS NOT NULL)
);
ALTER TABLE meetings ADD COLUMN summary_doc_id TEXT REFERENCES documents(doc_id);
ALTER TABLE meetings ADD COLUMN concluded_at INTEGER;

CREATE INDEX idx_meetings_group ON meetings(group_id);

-- 发言回合（异步回合制，实施计划 A9：时序正确即达标，不追求同毫秒并发）
CREATE TABLE meeting_turns (
  turn_id           INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id        TEXT NOT NULL REFERENCES meetings(id),
  speaker_member_id TEXT NOT NULL REFERENCES members(member_id),
  content           TEXT NOT NULL,
  turn_seq          INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_meeting_turns_seq ON meeting_turns(meeting_id, turn_seq);
