import { DatabaseSync } from "node:sqlite";
import { applyPragmas, pragmaConstructorOptions } from "./pragmas.js";

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

  // PRAGMA 与构造选项都来自 ./pragmas.ts —— 全仓库唯一权威源。
  // 为什么要抽出去：写队列（写连接 + 只读连接）、迁移都要同一套设置。留下副本就等于
  // 允许「主连接外键 ON、旁路连接外键 OFF」这种最难查的分叉：外键约束恰好只在某条
  // 写入路径上静默失效，不报错。两处重复设置（构造选项 + PRAGMA）的理由见 pragmas.ts。
  const db = new DatabaseSync(path, pragmaConstructorOptions());

  try {
    applyPragmas(db);
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
