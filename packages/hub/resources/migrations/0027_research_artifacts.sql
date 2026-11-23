-- Close the research-to-document-to-backlog loop without weakening the
-- day/URL idempotency rule from 0021. Existing cards remain valid and receive
-- nullable links; no historical timestamp or association is invented.
ALTER TABLE research_cards ADD COLUMN group_id TEXT REFERENCES groups(group_id);
ALTER TABLE research_cards ADD COLUMN backlog_item_id TEXT REFERENCES backlog_items(id);
ALTER TABLE research_cards ADD COLUMN doc_id TEXT REFERENCES documents(doc_id);
CREATE INDEX idx_research_group ON research_cards(group_id, day);
CREATE INDEX idx_research_backlog ON research_cards(backlog_item_id);
