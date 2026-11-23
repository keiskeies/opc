-- 0016_documents.sql —— 文档中心（D12 / 上游 §2.8）
--
-- ── 四形态一正文（实施计划 A6）──────────────────────────────────────
-- kind ∈ (doc / sheet / markdown / mindmap)，但正文只有一列 body_text：
-- markdown 存 markdown，sheet 存表格的 JSON 序列化，mindmap 存树形 JSON 序列化。
-- 为什么不做四列/四张表：版本、30 天保留、三级权限、水印、全文检索、导入导出
-- 这四件事对四种形态【完全同构】。拆四套等于把六个机制写四遍，
-- 而「改一处忘三处」在文档中心这种面上是必然发生的。
-- 代价：body_text 的内部形状由 (kind, mime) 联合判别，编辑器负责按 kind 选解析器。
--
-- ── 版本表为什么独立存全量正文而不是 diff ─────────────────────────
-- 30 天保留 + 「还原到任意版本」（D12）。diff 存储要还原就必须重放链，
-- 而重放链上任一版本被保留期裁掉，更早版本就永久不可还原 —— 保留期裁剪与
-- diff 链是互相拆台的两个设计。全量快照的代价是体积，换来的是
-- 「裁掉任何一段都不影响另一段可还原」，对这个规模（文本文档）是正确取舍。
--
-- ── 30 天保留落在哪 ───────────────────────────────────────────────
-- 不在这里建触发器，由节奏维护任务（0021_rhythm 那条线的 store）定期删
-- created_at < now - 30d 的 document_versions 行。文档本体（documents）永不删。
-- 触发器做不了这件事：触发器只在写时触发，而「过期」需要时间流逝；
-- 写时顺带清理会让每次保存的耗时随历史长度增长。
--
-- ── 三级权限（owner > editor > reader）─────────────────────────────
-- grantee 三类取值：'boss'、member_id、'group:<group_id>'（群内共享）。
-- 判定顺序在 src/documents/service.ts：显式个人条目 > 群条目 > 默认（群文档 reader、
-- 私有文档 owner-only）。owner 用列而非权限行：每个文档恰好一个 owner，
-- 且 owner 随 origin/import 路径而变（导入文档的 owner 是导入者），
-- 放进权限表会让「谁是 owner」与「谁有 owner 档权限」两件事可分叉。
--
-- ── 水印（D12）────────────────────────────────────────────────────
-- watermark_profile 是可空标签（'none'|'internal'|'confidential'），
-- 渲染层据此叠水印；不透明化（真在字节里烙水印）超出范围，此处只做呈现与策略标记。

CREATE TABLE documents (
  doc_id          TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('doc', 'sheet', 'markdown', 'mindmap')),
  title           TEXT NOT NULL,
  group_id        TEXT REFERENCES groups(group_id),
  task_id         TEXT REFERENCES tasks(id),
  owner           TEXT NOT NULL,                       -- 'boss' | member_id
  body_text       TEXT NOT NULL DEFAULT '',
  mime            TEXT NOT NULL DEFAULT 'text/markdown',
  watermark_profile TEXT NOT NULL DEFAULT 'none' CHECK (watermark_profile IN
                    ('none', 'internal', 'confidential')),
  origin          TEXT NOT NULL CHECK (origin IN ('created', 'imported', 'auto')),
  template_id     TEXT,                                -- 建自哪张模板（可空；不成 FK：模板可被删）
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_documents_group ON documents(group_id);
CREATE INDEX idx_documents_task ON documents(task_id);

CREATE TABLE document_versions (
  version_id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id     TEXT NOT NULL REFERENCES documents(doc_id),
  seq        INTEGER NOT NULL,                         -- 文档内第几版，从 1 递增
  body_text  TEXT NOT NULL,
  author     TEXT NOT NULL,                            -- 'boss' | member_id | 'system'
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_docver_seq ON document_versions(doc_id, seq);
CREATE INDEX idx_docver_created ON document_versions(created_at);

CREATE TABLE document_permissions (
  doc_id  TEXT NOT NULL REFERENCES documents(doc_id),
  grantee TEXT NOT NULL,                               -- 'boss' | member_id | 'group:<id>'
  tier    TEXT NOT NULL CHECK (tier IN ('owner', 'editor', 'reader')),
  PRIMARY KEY (doc_id, grantee)
);

CREATE TABLE document_templates (
  template_id TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('doc', 'sheet', 'markdown', 'mindmap')),
  body_text   TEXT NOT NULL,
  builtin     INTEGER NOT NULL DEFAULT 0
);
-- 内置模板禁删（同 roles 的立场：内置资产随迁移而来，删了公司就少一批标准件）。
CREATE TRIGGER doc_templates_builtin_no_delete BEFORE DELETE ON document_templates
WHEN old.builtin = 1
BEGIN
  SELECT RAISE(ABORT, '内置文档模板不可删除（D12）');
END;

-- 种子：四张内置模板（周报 / 复盘 / PRD / 会议纪要）。
-- 时间用固定 epoch 1763856000000（迁移必须逐字节可重放，理由见 0011 文件头）。
INSERT INTO document_templates (template_id, name, kind, body_text, builtin) VALUES
  ('tpl_weekly', '周报', 'markdown',
   '# 周报（{{week}}）

## 本周完成
-

## 进行中与风险
-

## 下周计划
-
', 1),
  ('tpl_retro', '复盘', 'markdown',
   '# 复盘（{{topic}}）

## 目标与结果
- 原定目标：
- 实际结果：

## 做得好的
-

## 问题与根因
-

## 下一步行动（负责人 / 截止）
-
', 1),
  ('tpl_prd', 'PRD', 'doc',
   '# {{title}}

## 背景与问题
## 目标与非目标
## 用户与场景
## 功能需求
## 交互与边界情况
## 衡量指标
## 里程碑
', 1),
  ('tpl_meeting', '会议纪要', 'markdown',
   '# 会议纪要（{{topic}}）

- 主持：
- 参会：

## 议题
## 发言要点
## 结论
- 决定：
- 负责人：
- 截止：
', 1);

-- 文档全文检索（形状逐字对齐 0001 events_fts / 0015 messages_fts）
CREATE VIRTUAL TABLE documents_fts USING fts5(
  title,
  body_text,
  content='documents',
  content_rowid='rowid',
  tokenize = 'trigram'
);
CREATE TRIGGER documents_fts_insert AFTER INSERT ON documents
BEGIN
  INSERT INTO documents_fts(rowid, title, body_text) VALUES (new.rowid, new.title, new.body_text);
END;
CREATE TRIGGER documents_fts_ad AFTER DELETE ON documents
BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, body_text)
  VALUES('delete', old.rowid, old.title, old.body_text);
END;
CREATE TRIGGER documents_fts_au AFTER UPDATE ON documents
BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, body_text)
  VALUES('delete', old.rowid, old.title, old.body_text);
  INSERT INTO documents_fts(rowid, title, body_text) VALUES (new.rowid, new.title, new.body_text);
END;
