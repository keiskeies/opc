/**
 * 事件批量写（Task 6.4「事件写入必须走批量事务」，规格 V9）。
 *
 * ── 为什么需要它 ───────────────────────────────────────────────────
 * 巡检一轮可能判出几十个停滞任务，回放标注、日报、迁移回填都要成批写 events。
 * 逐条一个事务的代价是【每条一次 BEGIN IMMEDIATE + 一次 fsync】，
 * 而 SQLite 的开销几乎全在 fsync 上。
 *
 * ── 分片：BATCH_ROWS 那一格【不是】性能调优 ─────────────────────────
 * 分片上限来自 driver.ts 的 BATCH_ROWS（1000），依据是 0001 §2.2 的实测：
 * 二分测到 4096 行 / 8192 个绑定参数仍成功，但【上界从未穷尽】。
 * 所以这里分片是为了避开一个只知道下界的限制，不是为了跑得快。
 * 把分片大小当性能参数调大，是拿一条未穷尽的边界换基准测试上好看的数字。
 *
 * ── 分片之间【不是原子的】，这一点写在显眼处 ────────────────────────
 * 2000 行 ⇒ 两个事务。第一个成功、第二个失败 ⇒ 库里留下前 1000 行。
 * 为什么不为了「全有或全无」把上限抬到装得下全部：那正是上面那条边界。
 * append-only 的语义在这里帮了忙：重试同一批会写出【重复行】，
 * 但不会写出半条事件或损坏的库。「重复行」是可以事后按 payload 认出来的，
 * 半条事件不行。需要「这批必须整体可见」的调用方（超步事务里的
 * checkpoint + events，规格 §6.3）本来就不该走这里 —— 它走 WriteQueue.node()
 * 由 recorder 在同一个超步事务里写。两条路各管各的场景。
 */

import type { DatabaseSync } from "node:sqlite";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import { BATCH_ROWS } from "../db/driver.js";
import { assertParamCount, assertSingleStatement, type Writer } from "../db/write-queue.js";
import { INSERT_EVENT_SQL, eventParams, type AuditRow } from "./recorder.js";

export type BatchResult = {
  readonly written: number;
  /** 每个分片写了多少行。长度 = 分片数，用来核验「分片数对不对」。 */
  readonly shards: readonly number[];
};

/**
 * 把行编成分片。纯函数、单独测：分片边界（正好 1000、1001、0）是这类代码
 * 最容易错也最不容易被发现的地方 —— 错一格的表现是「最后一批少一条」
 * 或「多一个空事务」，两者都不报错。
 */
export function shard<T>(
  rows: readonly T[],
  size = BATCH_ROWS,
): readonly (readonly T[])[] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error("分片大小必须是 ≥1 的整数，收到 " + String(size));
  }
  if (rows.length === 0) return [];
  const out: (readonly T[])[] = [];
  for (let i = 0; i < rows.length; i += size) {
    out.push(rows.slice(i, i + size));
  }
  return out;
}

/**
 * 一批行 ⇒ 每个分片一个事务。
 *
 * 校验在【入队之前】对整批做完：参数写错是最高频错误，
 * 让它在一半已经落库之后才报，等于把一次笔误变成一次部分写入。
 *
 * 分片内部走 writer.node（一个已开好的事务作用域，一批语句跑完才 COMMIT）。
 * 【不用】writer.tx(stmts)：那个形状要把每条语句连同参数摊平成数组交回去，
 * 看着更「纯」，但它逼调用方自己 prepare —— 而 prepare 一条语句一次和
 * 复用一条 prepared statement 差着解析开销，批量写正是那类开销会被放大 N 倍的地方。
 */
export async function appendAuditBatch(
  writer: Writer,
  rows: readonly AuditRow[],
  now?: () => number,
  shardSize = BATCH_ROWS,
): Promise<BatchResult> {
  const clock = now ?? Date.now;
  const params = rows.map((r) => {
    // 与 appendAudit 同一对自检，一行都不省：少绑参数在可空列上【不报错】，
    // 直接写 NULL —— 审计库最危险的失效方向（recorder.ts 原话）。
    assertSingleStatement(INSERT_EVENT_SQL);
    const p = eventParams(r, clock);
    assertParamCount(INSERT_EVENT_SQL, p);
    return p;
  });

  const shards: number[] = [];
  for (const group of shard(params, shardSize)) {
    await writer.node(() => {
      const db: DatabaseSync = requireScopeDb("事件批量写");
      const stmt = db.prepare(INSERT_EVENT_SQL);
      for (const p of group) stmt.run(...(p as never[]));
    });
    shards.push(group.length);
  }
  return { written: rows.length, shards };
}
