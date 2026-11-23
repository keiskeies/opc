-- 0021_rhythm.sql —— 节奏事件与每日调研（D15 / 上游 §2.10）
--
-- ── 节奏事件是什么 ─────────────────────────────────────────────────
-- 团队生活的【周期性容器】：冲刺计划会、每日站会摘要、评审、回顾。
-- 每条 rhythm_events 是一次已发生的节奏实例（不是 cron 定义 —— 定义在代码侧的
-- 调度表里，本表只记【发生过】的实例与产出物）。digest_doc_id 指向自动沉淀的
-- 摘要文档（站会摘要/回顾纪要落文档中心，D12「自动沉淀」的落点之一）。
--
-- ── 为什么不在 DDL 存 cron ────────────────────────────────────────
-- 本仓无调度守护进程的独立配置层；节奏触发挂在 Hub 启动的轻量 tick（与 heartbeat
-- patrol 同一形状，engine/patrol.ts 已验证该模式）。把 cron 字符串落表会制造
-- 「表里有定义但没人读」的第二口径 —— zero-producer 守卫对这类行的态度是红的。
--
-- ── research_cards 的 day ─────────────────────────────────────────
-- day 用 'YYYY-MM-DD' 文本（本地日界语义属于业务，Unix 毫秒留给时间戳列），
-- UNIQUE(day, url)：同一天同一来源的调研卡只落一张（PM 调研一天一次，重复抓取
-- 幂等）。source/url 可空由 CHECK 兜住：手记卡可以没有 URL，抓来的必须有。

CREATE TABLE rhythm_events (
  event_id      TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN
                ('sprint_planning', 'standup', 'review', 'retro')),
  group_id      TEXT REFERENCES groups(group_id),
  at            INTEGER NOT NULL,
  digest_doc_id TEXT REFERENCES documents(doc_id),
  payload_json  TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_rhythm_at ON rhythm_events(at);

CREATE TABLE research_cards (
  card_id   TEXT PRIMARY KEY,
  day       TEXT NOT NULL,                       -- 'YYYY-MM-DD'
  source    TEXT NOT NULL,
  title     TEXT NOT NULL,
  summary   TEXT NOT NULL DEFAULT '',
  url       TEXT,
  created_at INTEGER NOT NULL,
  CHECK (url IS NOT NULL OR source = 'manual')
);
CREATE UNIQUE INDEX idx_research_day_url ON research_cards(day, url) WHERE url IS NOT NULL;
CREATE INDEX idx_research_day ON research_cards(day);
