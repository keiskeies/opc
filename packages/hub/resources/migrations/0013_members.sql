-- 0013_members.sql —— 成员四件套：persona + skills + executors + 档位（D3/D4/D7/D13）
--
-- ── 成员是什么（上游 §2.3）──────────────────────────────────────────
-- 成员 = 人格（persona_json）+ 技能（member_skills）+ 执行器（member_executors，多挂按 seq 优先级）
--        + 模型档位（model_tier）+ 真人感（avatar/voice/tone，D13）。
-- 成员是【可复用资产】：同一成员可同时坐进多个群（D2「群=任务、成员是同事」），
-- 所以成员表独立于 group_members 任职关系存在。
--
-- ── 为什么另开 member_skills 而不是复用 skill_mounts ────────────────
-- skill_mounts（0001，规格 §14.3）是【角色级挂载治理台账】：带 mounted_from/to 时间区间、
-- mounted_by 审计、honesty_boundaries ——它回答「这个技能在某角色上何时挂何时卸」。
-- member_skills 回答「这个成员入职时带了哪些技能」，是集合不是台账：
-- 塞进 skill_mounts 会让每条成员技能都必须伪造 from/to/by 三列，
-- 而「谁挂的」在招聘场景里就是招聘本身（hire_events 已经记了这件事）。
-- 两表的 skill_id 是同一个词表（如 'leijun-skill-v2'），由应用层对齐；
-- 不做外键：skills 本身尚未成表（技能包是文件形态），无列可指。
--
-- ── 执行器为什么是独立表而不是 members.executors_json ────────────────────
-- D4 把「执行器多选 + 优先级」定为一等概念：七种执行器（claude-cli/codex-cli/qoder-cli/
-- platform-webhook/builtin-plugin/pure-model/human）全部可实现，且执行器决策【可编辑】
-- （招聘页与成员详情页都要增删改单个执行器）。JSON 列改一项要整列覆写，
-- 「编辑执行器」在 JSON 上无法加约束（seq 唯一、kind 枚举、config 必填形状），
-- 表形态每条执行器一行，PATCH 单行、DELETE 单行，约束全部落在 DDL。
--
-- ── hire_events 为什么 append-only ─────────────────────────────────
-- 「这个成员怎么被招进来的、中途改过什么」是人才市场与审计的共同事实源；
-- 上游 D4 的「执行器决策可改」要求改动作有历史。触发器禁改禁删，同 events 的立场。

CREATE TABLE members (
  member_id       TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  role_id         TEXT NOT NULL REFERENCES roles(role_id),
  persona_json    TEXT NOT NULL,                  -- 人格：语气/口头禅/立场/诚实边界（D13）
  model_tier      TEXT NOT NULL CHECK (model_tier IN ('management', 'execution')),
  avatar_asset_id TEXT REFERENCES assets(asset_id),
  -- 头像种子（D13）：asset_id 是【本机 BLOB】，人才市场蓝图不许带二进制
  -- （0020 文件头），所以种子必须独立成列而不是「没 asset 时从 asset 推」。
  -- 空串 = 没种子，前端按名字回落（首字母/默认图形）—— 这一列 NOT NULL DEFAULT ''
  -- 把「可以没有种子」表达成数据而不是可空性，读侧少一个 null 分支。
  avatar_seed     TEXT NOT NULL DEFAULT '',
  voice_json      TEXT,                           -- TTS 声音映射（D13，可空=用默认音）
  tone            TEXT NOT NULL DEFAULT 'neutral',-- 语气标签（真人感，前端渲染与 TTS 共用）
  status          TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  hired_at        INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_members_role ON members(role_id);

CREATE TABLE member_skills (
  member_id TEXT NOT NULL REFERENCES members(member_id),
  skill_id  TEXT NOT NULL,
  name      TEXT NOT NULL,
  note      TEXT,
  PRIMARY KEY (member_id, skill_id)
);

CREATE TABLE member_executors (
  member_id   TEXT NOT NULL REFERENCES members(member_id),
  seq         INTEGER NOT NULL,                   -- 优先级：数字小者优先（D4「多挂排序」）
  kind        TEXT NOT NULL CHECK (kind IN
              ('claude-cli', 'codex-cli', 'qoder-cli',
               'platform-webhook', 'builtin-plugin', 'pure-model', 'human')),
  config_json TEXT NOT NULL DEFAULT '{}',         -- 执行器私有配置（端点/插件 id/模型名…）
  enabled     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (member_id, seq)
);

-- 执行器 kind 的枚举判据与 contracts/src/member.ts 的 EXECUTOR_KINDS 同词表，
-- 守卫 test 两侧逐字比对（防止「DDL 收了第 8 种而执行器 registry 没有」或反之）。

CREATE TABLE hire_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id  TEXT NOT NULL REFERENCES members(member_id),
  action     TEXT NOT NULL CHECK (action IN
             ('hired', 'role_changed', 'skills_changed', 'executors_changed',
              'persona_changed', 'archived', 'restored')),
  from_json  TEXT,                                -- 变更前快照（hired 时为 NULL）
  to_json    TEXT NOT NULL,                       -- 变更后快照
  at         INTEGER NOT NULL
);
CREATE INDEX idx_hire_events_member ON hire_events(member_id, id);

CREATE TRIGGER hire_events_no_update BEFORE UPDATE ON hire_events
BEGIN
  SELECT RAISE(ABORT, 'hire_events 是 append-only 台账：写错就补一条纠正事件，不改历史');
END;
CREATE TRIGGER hire_events_no_delete BEFORE DELETE ON hire_events
BEGIN
  SELECT RAISE(ABORT, 'hire_events 是 append-only 台账：招聘与变更历史不可抹除');
END;
