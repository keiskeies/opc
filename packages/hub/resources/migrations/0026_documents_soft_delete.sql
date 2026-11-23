-- 0026_documents_soft_delete.sql —— 文档删除改为可审计软删（T9/T10）
--
-- 0016 文件头写过「文档本体永不删」；实施计划 §3 又登记了 DELETE /documents/:id。
-- 两者不能靠硬删兑现：版本、权限、会议纪要引用都会一起变成孤儿。
-- 因此 DELETE 的语义收敛为软删：正文与版本保留，列表/详情不再出现，审计仍可回放。
ALTER TABLE documents ADD COLUMN deleted_at INTEGER;
CREATE INDEX idx_documents_deleted ON documents(deleted_at);
