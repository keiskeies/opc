/**
 * 测试夹具：手搓的 events 表 + 0010 那条重放去重索引。
 *
 * ── 为什么要抽这一份 ──────────────────────────────────────────────
 * 同一张最小 events 表原先在 4 个测试文件里各抄一份（events/recorder.test.ts、
 * graph/audit-interrupt.test.ts、graph/interrupt-resume.test.ts、graph/step-tx.test.ts）。
 * 0010 给 events 加了 replay_key 那一列之后，「抄了几份」这件事从风格问题变成正确性问题：
 * 带重放键的 INSERT 指着一个【不存在的列】，报的是 "no such column: replay_key"，
 * 症状指向 recorder 坏了，而不是「这个夹具没跟上迁移」。列加一次要改四处，
 * 而漏掉的那一处不会自己说「我少了东西」—— 它只是【少一个用例覆盖】。
 *
 * ── 为什么索引与表【分开两个常量】而不是并成一个 ──────────────────
 * 表是每条用例都要的；索引只有去重语义相关的用例真正依赖。分成两个常量后
 * 每个 harness 自己决定要不要那条索引，而「要不要」这件事在代码里看得见。
 * 但默认建议是【两个都要】：生产库有那条索引，测试库没有它，就意味着
 * 「唯一索引把超步事务打回」这条失效路径在测试里永远不会发生。
 *
 * ── 与真实迁移的关系 ──────────────────────────────────────────────
 * 表体与 0001_init.sql 的 events 同构（NOT NULL 一律保留，约束要真生效），
 * 少了 events_fts 与那两条 append-only 触发器 —— 那些是 schema-0001.test.ts
 * 与 driver-preflight.test.ts 的判据对象，混进来只会让每次审计测试都顺带测 FTS。
 * 索引体与 0010_interrupt_replay_dedup.sql 逐字一致。
 *
 * ⚠ 真正的库请用 migrate()。这个夹具只服务【必须手搓表】的场景：
 * 崩溃子进程与超步事务测试要一张【只有这几张表】的库，好让「events 增量为 0」
 * 这类断言不被别的表干扰。
 */

/** events 表（与 0001_init.sql 同构 + 0010 的 replay_key）。 */
export const EVENTS_TABLE_DDL = [
  "CREATE TABLE events (",
  "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  task_id TEXT,",
  "  actor_type TEXT NOT NULL,",
  "  actor_id TEXT NOT NULL,",
  "  action TEXT NOT NULL,",
  "  target TEXT,",
  "  payload TEXT NOT NULL,",
  "  state_snapshot TEXT,",
  "  created_at INTEGER NOT NULL,",
  "  replay_key TEXT",
  ")",
].join("\n");

/** 0010 的中断重放去重索引（表达式与迁移文件逐字一致）。 */
export const EVENTS_REPLAY_INDEX_DDL =
  "CREATE UNIQUE INDEX idx_events_replay_key_once " +
  "ON events (action, target, replay_key) WHERE replay_key IS NOT NULL";

/** 表 + 索引：与迁移后的生产库在【审计写入这件事】上等形状。 */
export const EVENTS_DDL_WITH_REPLAY =
  EVENTS_TABLE_DDL + ";\n" + EVENTS_REPLAY_INDEX_DDL + ";";
