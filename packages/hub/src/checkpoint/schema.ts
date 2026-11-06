/**
 * LangGraph Checkpoint 表结构。
 *
 * 列名、列序、主键与官方 @langchain/langgraph-checkpoint-sqlite 1.1.0 完全一致
 * —— 规格里§C.1「自建同名表结构以保持可迁移性」指的就是这件事：将来改判回 D6-b
 * 时，同一份库文件能被官方 Saver 直接读写，不必迁数据。
 *
 * 这份常量是【唯一权威】：Task 0.5 的迁移必须 import 它，不得另抄一份（V18）。
 * Saver 构造时也用它做 IF NOT EXISTS 兜底，故建库顺序不影响可用性。
 */
export const CHECKPOINT_TABLES: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS checkpoints (\n" +
    "  thread_id TEXT NOT NULL,\n" +
    "  checkpoint_ns TEXT NOT NULL DEFAULT '',\n" +
    "  checkpoint_id TEXT NOT NULL,\n" +
    "  parent_checkpoint_id TEXT,\n" +
    "  type TEXT,\n" +
    "  checkpoint BLOB,\n" +
    "  metadata BLOB,\n" +
    "  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)\n" +
    ")",
  "CREATE TABLE IF NOT EXISTS writes (\n" +
    "  thread_id TEXT NOT NULL,\n" +
    "  checkpoint_ns TEXT NOT NULL DEFAULT '',\n" +
    "  checkpoint_id TEXT NOT NULL,\n" +
    "  task_id TEXT NOT NULL,\n" +
    "  task_path TEXT NOT NULL DEFAULT '',\n" +
    "  idx INTEGER NOT NULL,\n" +
    "  channel TEXT NOT NULL,\n" +
    "  type TEXT,\n" +
    "  value BLOB,\n" +
    "  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)\n" +
    ")",
  /*
   * 刻意【不建】(thread_id, ns, checkpoint_id, task_path, task_id, idx) 这条索引。
   *
   * 理由（实测，非推断）：按 V17 排序必须在内存里用官方 compareWritesSortKeys 做
   * （基类注释禁止用 < / localeCompare，SQL 的 BINARY  collation 也只做码元序）。
   * 一旦建了这条索引，SQLite 会选它做扫描索引，于是「不带 ORDER BY 的 SELECT」碰巧
   * 返回正确顺序 —— 实现里漏掉内存排序时测试照样绿，偶然性掩盖了真实 bug。
   * 删掉后无 ORDER BY 返回主键序（实测 chA,chB,chC），与框架序不同，缺陷立刻暴露。
   * 查询本身也不需要它：取某 checkpoint 的全部 writes，主键前缀已经覆盖。
   */
];
