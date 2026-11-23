-- 0012_assets.sql —— 二进制资产表（D13 头像 / 附件 / 导入原件）
--
-- 为什么落 BLOB 而不是文件系统（实施计划 A7）：规格 §6.1 的前提是
-- 「单个可备份的 SQLite 文件」。头像一旦落盘，VACUUM INTO 备份就漏掉它，
-- 备份模型被撕成「库 + 目录」两半，而「本地正常、换机丢文件」正是 0001 文件头
-- 警告的那类分叉。
--
-- sha256 建唯一索引：头像重复上传、同一文档反复导入时按内容去重，
-- 同一字节只存一份。索引是 UNIQUE，插入方负责先查后插或 ON CONFLICT DO NOTHING。
--
-- purpose 用 CHECK 收口（avatar/attachment/import-source）：资产表是共享底座，
-- 不限枚举会变成什么都能塞的垃圾场；新增用途要回到这条 CHECK 上改，改就有 diff 可审。

CREATE TABLE assets (
  asset_id   TEXT PRIMARY KEY,
  purpose    TEXT NOT NULL CHECK (purpose IN ('avatar', 'attachment', 'import-source')),
  mime       TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256     TEXT NOT NULL,
  data       BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_assets_sha ON assets(sha256);
