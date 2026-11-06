// 阶段 1：跑到 interrupt 暂停后进程直接退出，用来模拟 CEO 审批前 Hub 崩溃或被手动杀掉。
// 输出单行 JSON 供 test/poc/resume.test.ts 断言，勿改动键名。
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { build } from './graph.mjs';

const dbPath = process.argv[2];
if (!dbPath) { console.error('usage: node poc-run.mjs <db-path> [thread-id]'); process.exit(2); }
const threadId = process.argv[3] ?? ('poc-' + Date.now());

// V5：路径必须走 fromConnString，传给构造函数会抛 this.db.pragma is not a function
const saver = SqliteSaver.fromConnString(dbPath);
const graph = build(saver);
const cfg = { configurable: { thread_id: threadId } };

// V2：interrupt 不抛异常，暂停信息在返回值的 __interrupt__ 数组里
const result = await graph.invoke({ doc: '', trail: [] }, cfg);
const state = await graph.getState(cfg);

console.log(JSON.stringify({
  phase: 'run',
  threadId,
  interrupts: result.__interrupt__ ?? [],
  next: state.next ?? [],
  trail: state.values.trail ?? [],
}));

await saver.close?.();