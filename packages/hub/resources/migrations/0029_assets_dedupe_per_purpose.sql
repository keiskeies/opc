-- 0029_assets_dedupe_per_purpose.sql —— 去重键补上 purpose 这一维
--
-- 0012 文件头写的是「头像重复上传、同一文档反复导入时按内容去重」——那是【两个动作】，
-- 而 idx_assets_sha 实现的是「同一字节在全表一辈子只存一份」，比那句话宽一整维。
-- 失效需要一份跨用途重传的字节，实测链（真库，round389 探针）：
--   putAsset(purpose=attachment, bytes=X)  ⇒ created:true
--   putAsset(purpose=avatar,     bytes=X)  ⇒ created:false，拿回那条 attachment 行
--   绑头像（http/people.ts 的 AVATAR_ASSET_SQL 只收 purpose='avatar'）⇒ 必拒：
--   「头像资产 [x] 不存在或不是图片资产（purpose 必须是 avatar）」
-- 上传方拿到的是 201 和一个合法 asset_id，屏幕上没有任何一步能补救：
-- 换个文件名重传是唯一出路，而界面不会这么说。方向 B（先头像后附件）更安静 ——
-- 附件拿到那条 avatar 行，mime 还是第一次上传时那个，两边都不报错。
--
-- 键换成 (sha256, purpose)：0012 那句「同一字节只存一份」在【同一用途内】照旧成立，
-- 而用途不再被别的用途抢键。去重（同用途重复上传不占两份 BLOB）与用途隔离
--（头像字节不能是附件字节，members/service.ts 文件头那条渲染事故理由）各归各的键，
-- 不再共用一根索引 —— 这正是原来谁都不负责的那个交集。
--
-- 不搬迁任何行：现有行 sha256 全表唯一，加一维之后仍唯一，DROP/CREATE 是纯索引操作。

DROP INDEX IF EXISTS idx_assets_sha;
CREATE UNIQUE INDEX idx_assets_sha_purpose ON assets(sha256, purpose);
