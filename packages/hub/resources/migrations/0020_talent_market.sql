-- 0020_talent_market.sql —— 人才市场（D3 三入口 / 上游 §2.3）
--
-- ── 一个 item 是什么 ───────────────────────────────────────────────
-- 人才市场条目 = 一份【可移植的成员档案】（payload_json 里是完整 MemberCard：
-- persona + skills + executors + tier + avatar 种子）。三入口共用同一形状：
--   builtin   —— 随迁移 seed 的模板人才（产品/技术/设计/测试各一，开箱可聘）
--   published —— 从本机成员导出后挂牌（导出动作 = GET /talent/:id/export 产出 payload_json）
--   imported  —— 从他机导入（POST /talent/import 消费 payload_json 并落本表）
-- 一个形状三来源，导入导出互逆：导出的字节重新导入必须还原出等价档案，
-- 这条往返测试（talent round-trip）在 test/talent/service.test.ts 里守。
--
-- ── 为什么不直接引用 members ───────────────────────────────────────
-- 市场条目必须【脱离本机成员独立存在】：导出的档案里若含本机 member_id 外键，
-- 换一台机器导入就全断。payload_json 是自足文档，member_id 在导入时【重新生成】。
-- 这也是 avatar 用种子（avatar_seed）而不是 asset_id 的原因：BLOB 不进 payload，
-- 导入方按种子重新生成头像资产。
--
-- ── builtin 禁删 ───────────────────────────────────────────────────
-- 同 roles / document_templates 的立场：内置模板删了就少一批标准件。
-- published/imported 可下架（DELETE），下架不碰已按它入职的成员（入职即独立）。

CREATE TABLE talent_market (
  item_id      TEXT PRIMARY KEY,
  source       TEXT NOT NULL CHECK (source IN ('builtin', 'imported', 'published')),
  name         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  published_at INTEGER NOT NULL
);

CREATE TRIGGER talent_builtin_no_delete BEFORE DELETE ON talent_market
WHEN old.source = 'builtin'
BEGIN
  SELECT RAISE(ABORT, '内置人才模板不可下架（D3）：builtin 条目随迁移而来');
END;

-- 种子时间固定 epoch（理由见 0011 文件头）。payload 的 persona 故意留最小可用集，
-- 语气/立场在招聘页可改 —— 市场条目是【起点】，不是牢笼。
--
-- ⚠ executor 的 config 里【必须带 kind】：contracts 的 executorConfigSchema 是按
-- kind 判别的判别联合（member.ts 文件头那条理由），读侧守门拿【同一份 schema】
-- parse 每一行 payload —— 种子少写这个键，人才市场页一打开就在第一行 builtin 上抛，
-- 「内置模板不可删」保住的条目反而永远列不出来。种子字节必须过契约，
-- 这条由 test/talent/service.test.ts 的「builtin 种子逐条过 talentPayloadSchema」钉住。
INSERT INTO talent_market (item_id, source, name, payload_json, published_at) VALUES
  ('talent_pm', 'builtin', '产品经理·模板',
   '{"name":"产品经理","role_id":"product_director","model_tier":"management","avatar_seed":"talent_pm","tone":"steady","persona":{"style":"结论先行，先问为什么再问怎么做","values":["用户价值优先","可验证的里程碑"],"honesty":"不确定就说不确定"},"skills":[{"skill_id":"pm-prd-v1","name":"PRD 撰写"}],"executors":[{"seq":1,"kind":"pure-model","config":{"kind":"pure-model"}},{"seq":2,"kind":"human","config":{"kind":"human"}}]}',
   1763856000000),
  ('talent_eng', 'builtin', '全栈工程师·模板',
   '{"name":"全栈工程师","role_id":"dev","model_tier":"execution","avatar_seed":"talent_eng","tone":"direct","persona":{"style":"先读代码再改代码，改动必带测试","values":["最小改动","测试即文档"],"honesty":"跑过的才叫能跑"},"skills":[{"skill_id":"eng-fullstack-v1","name":"全栈开发"}],"executors":[{"seq":1,"kind":"claude-cli","config":{"kind":"claude-cli"}},{"seq":2,"kind":"codex-cli","config":{"kind":"codex-cli"}}]}',
   1763856000000),
  ('talent_design', 'builtin', '设计师·模板',
   '{"name":"设计师","role_id":"designer","model_tier":"execution","avatar_seed":"talent_design","tone":"warm","persona":{"style":"先给方案再解释，方案至少两个","values":["克制的视觉","可用性优先"],"honesty":"审美是主观的，会说明依据"},"skills":[{"skill_id":"design-ui-v1","name":"界面设计"}],"executors":[{"seq":1,"kind":"pure-model","config":{"kind":"pure-model"}}]}',
   1763856000000),
  ('talent_qa', 'builtin', '测试工程师·模板',
   '{"name":"测试工程师","role_id":"qa","model_tier":"execution","avatar_seed":"talent_qa","tone":"precise","persona":{"style":"复现步骤精确到点击","values":["没有复现就没有 bug"],"honesty":"没覆盖到的会明说"},"skills":[{"skill_id":"qa-e2e-v1","name":"端到端测试"}],"executors":[{"seq":1,"kind":"qoder-cli","config":{"kind":"qoder-cli"}},{"seq":2,"kind":"pure-model","config":{"kind":"pure-model"}}]}',
   1763856000000);
