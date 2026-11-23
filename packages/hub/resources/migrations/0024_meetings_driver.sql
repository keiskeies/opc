-- 0024_meetings_driver.sql —— 会议开场时间与当前发言轮次（T7）
--
-- 迁移只追加不回改：老库没有真实会议机制，opened_at=0 表示「历史行没有开场时刻」；
-- 新会议由服务层写 nowMs，不能把 created_at 冒充开场时间。
ALTER TABLE meetings ADD COLUMN opened_at INTEGER NOT NULL DEFAULT 0;

-- 下一发言人是会议的推进游标：开放会议非空，散会/取消后由服务层清空。
-- 外键只保证成员存在，是否在场、是否在职由服务层在每次推进时校验。
ALTER TABLE meetings ADD COLUMN next_speaker_member_id TEXT REFERENCES members(member_id);

-- 老行只要 participants 是合法非空数组，就拿它当开场顺序；不要静默接受 NULL。
-- 没有 moderator 的老行仍保持 next=NULL，服务层会把「无轮次」说清楚，而不是伪造一个发言人。
UPDATE meetings
   SET speaking_order_json = participants
 WHERE speaking_order_json IS NULL
   AND json_valid(participants)
   AND json_type(participants) = 'array'
   AND json_array_length(participants) > 0;
UPDATE meetings
   SET next_speaker_member_id = moderator_member_id
 WHERE status = 'open'
   AND next_speaker_member_id IS NULL
   AND moderator_member_id IS NOT NULL;
