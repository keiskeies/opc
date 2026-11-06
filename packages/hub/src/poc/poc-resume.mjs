// 阶段 2：全新进程、重新打开同一个 DB 文件、重建 saver 与图，从 Checkpoint 恢复并 resume。
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { Command } from '@langchain/langgraph';
import { build } from './graph.mjs';

const dbPath = process.argv[2];
const threadId = process.argv[3];
const resumeValue = process.argv[4] ?? 'approved-after-kill';
if (!dbPath || !threadId) { console.error('usage: node poc-resume.mjs <db-path> <thread-id> [resume]'); process.exit(2); }

const saver = SqliteSaver.fromConnString(dbPath);
const graph = build(saver);
const cfg = { configurable: { thread_id: threadId } };

const before = await graph.getState(cfg);   // V3：重启后 next / values 完整恢复
const done = await graph.invoke(new Command({ resume: resumeValue }), cfg);

console.log(JSON.stringify({
  phase: 'resume',
  threadId,
  resumedNext: before.next ?? [],
  resumedTrail: before.values.trail ?? [],
  finalTrail: done.trail ?? [],
}));

await saver.close?.();