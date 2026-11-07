import { DatabaseSync } from "node:sqlite";

/**
 * SQLite 连接级 PRAGMA 的【唯一权威源】（规格 §6.1、附录 C 开头那段）。
 *
 * driver.ts 原先内联这四条；写队列、迁移、只读连接出现后又各自需要它们 ——
 * 于是同一个设置有了第二、第三个副本。PRAGMA 副本不一致的表现不是报错，
 * 是「我这台机器 synchronous=NORMAL、别人那台是 FULL」，或「主连接开了外键、
 * 旁路连接没开」—— 后者会让外键约束在最需要它的写入路径上静默失效。
 *
 * 语义提醒：journal_mode 是【持久】的（写进库文件，一条连接设置后对所有连接生效）；
 * synchronous / foreign_keys / busy_timeout 是【连接级】的，每条新连接都必须重设。
 * 这就是为什么它们是代码而非迁移脚本的一部分。实测另有一条硬约束：
 * 事务内执行 PRAGMA journal_mode 会抛
 * "cannot change into wal mode from within a transaction"。
 */

/** busy_timeout（毫秒）：Hub 是单写者，出现锁等待通常意味着有旁路进程打开了同一个库。 */
export const BUSY_TIMEOUT_MS = 5000;

/**
 * 施加到【每条】连接上的 PRAGMA，顺序即原 driver.ts 的顺序，不作改动。
 * 用函数而不是常量数组，是因为 busy_timeout 要拼数值 —— 拼 SQL 的写法集中在这里。
 */
export function applyPragmas(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;"); // = 1：WAL 下的推荐档
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = " + BUSY_TIMEOUT_MS + ";");
}

/**
 * 与 applyPragmas 配套的构造选项。
 *
 * 与 PRAGMA【故意重复设置】，不是冗余：
 * - node:sqlite 裸构造默认 enableForeignKeyConstraints = true（实测，与 sqlite3 CLI
 *   默认 OFF 相反）。所以只删 PRAGMA 不会改变当前行为 —— 但一旦 Node 改掉默认值，
 *   外键就会静默失效，且不报错。
 * - busy_timeout 裸构造默认 0（实测），即无等待。
 * 两处都设是为了既不依赖默认值，也不依赖哪个先执行。变异测试结论见
 * test/db/driver-preflight.test.ts 末尾。
 */
export function pragmaConstructorOptions(): {
  enableForeignKeyConstraints: boolean;
  timeout: number;
} {
  return { enableForeignKeyConstraints: true, timeout: BUSY_TIMEOUT_MS };
}

/** 以只读模式打开一个【已存在】的库文件，并施加同一套 PRAGMA。 */
export function openReadonlyDb(path: string): DatabaseSync {
  // 实测：只读连接上这四条 PRAGMA 都能执行（journal_mode 在已是 WAL 的库上返回 wal，
  // 不会尝试改模式），foreign_keys 对只读连接也无害。所以只读连接也走 applyPragmas ——
  // 「只读连接不需要设置」是错觉：busy_timeout 决定了只读查询遇到写事务时是等还是立刻抛。
  const db = new DatabaseSync(path, {
    readOnly: true,
    enableForeignKeyConstraints: true,
    timeout: BUSY_TIMEOUT_MS,
  });
  try {
    applyPragmas(db);
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}
