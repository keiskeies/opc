import { DatabaseSync } from "node:sqlite";

/**
 * 唯一的 SQLite 入口（规格 §5.6.1：全仓库只有 packages/hub 可以碰 SQLite）。
 * 所有连接必须经 openDb 取得 —— PRAGMA 漏一条，行为就会在不同机器上分叉，
 * 而这类分叉在 WAL + append-only 的审计模型里表现为「本地正常、打包后丢事件」。
 */

/**
 * 批量写事件的分片上限：1000 行/批。
 *
 * 依据：决策记录 docs/decisions/0001-sqlite-driver.md §2.2。实测二分到
 * 4096 行 / 8192 个绑定参数仍成功，但上界从未穷尽 —— 我们只知道下限，
 * 不能把「测过 8192」当成「无限」。1000 留了 4 倍余量，同时让单批事务足够短，
 * 不至于在 Hub 单写者模型里把交互式写拖慢（规格 §6.2）。
 *
 * 禁止一次传数千参数不分片；改动此常量必须同步改决策文档。
 * 由 packages/hub/test/db/driver-preflight.test.ts 守住。
 */
export const BATCH_ROWS = 1000;

/** busy_timeout（毫秒）：Hub 是单写者，出现锁等待通常意味着有旁路进程打开了同一个库。 */
const BUSY_TIMEOUT_MS = 5000;

/**
 * 打开（必要时创建）OPC-OS 的数据库文件，并施加统一 PRAGMA。
 *
 * 只接受真实文件路径：规格 §6.1 的前提是「单个 SQLite 文件」，:memory: 既不能
 * WAL 也不能被 VACUUM INTO 备份，所以在此显式拒绝，而不是让下游拿到一个
 * journal_mode 静默变成 memory 的连接。
 */
export function openDb(path: string): DatabaseSync {
  if (typeof path !== "string" || path.trim() === "") {
    throw new TypeError("openDb 需要一个非空的数据库文件路径");
  }
  if (path === ":memory:" || path.startsWith("file::memory:")) {
    throw new Error(
      "OPC-OS 不使用内存库：规格 §6.1 要求单个可备份的 SQLite 文件，" +
        "而 :memory: 既无 WAL 也不能 VACUUM INTO。测试请用临时文件路径。",
    );
  }

  // 构造函数选项与下方 PRAGMA【故意重复设置】，不是冗余：
  // - node:sqlite 裸构造默认 enableForeignKeyConstraints = true（实测，与 sqlite3 CLI 默认
  //   OFF 相反）。所以只删 PRAGMA 不会改变当前行为 —— 但一旦 Node 改掉默认值，
  //   外键就会静默失效，规格 §6.1 的引用完整性随之失去，且不报错。
  // - busy_timeout 裸构造默认 0（实测），即无等待。两处都设是为了既不依赖默认值，
  //   也不依赖哪个先执行。
  // 相关变异测试结论见 test/db/driver-preflight.test.ts 末尾注释。
  const db = new DatabaseSync(path, {
    // 与下方 PRAGMA 保持一致；两边都设是为避免依赖 node:sqlite 的默认值
    enableForeignKeyConstraints: true,
    timeout: BUSY_TIMEOUT_MS,
  });

  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;"); // = 1：WAL 下的推荐档
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = " + BUSY_TIMEOUT_MS + ";");
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

/** 事务包装：失败必回滚，绝不留下半提交（规格 §6.3 要求 Checkpoint 与 events 同生共死）。 */
export function tx<T>(db: DatabaseSync, body: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = body();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 事务可能已被 SQLite 自身中止，忽略以保留原始错误 */
    }
    throw e;
  }
}
