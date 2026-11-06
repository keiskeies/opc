import type { DatabaseSync } from "node:sqlite";
import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ChannelVersions,
  Checkpoint,
  CheckpointListOptions,
  CheckpointMetadata,
  CheckpointPendingWrite,
  CheckpointTuple,
  PendingWrite,
} from "@langchain/langgraph-checkpoint";
import {
  BaseCheckpointSaver,
  compareWritesSortKeys,
  copyCheckpoint,
  WRITES_IDX_MAP,
  writesSortKey,
} from "@langchain/langgraph-checkpoint";
import { CHECKPOINT_TABLES } from "./schema.js";
import { currentScope, requireScopeDb } from "./tx-scope.js";

/**
 * 自研 Checkpoint Saver（规格 §5.6 D6-a；事务作用域判定见 decisions/0003）。
 *
 * 与官方 SqliteWALSaver 的三点差异，都是本项目的需求而非疏忽：
 *   1. 复用外部连接，不自己开库 —— 库文件只有一个，WAL 也只允许一个写者。
 *   2. put / putWrites 强制在 txScope() 内调用，让 Checkpoint 与 events 落进同一事务
 *      （规格 §6.3）。事务外调用【抛错】而不是静默自提：静默自提会让原子性在最常见
 *      路径上悄悄失效，且没有任何报错线索。
 *   3. 写方法必须走作用域连接，读方法走构造时那条连接（Hub 单写者，两者实为同一条）。
 */

interface RowShape {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  type: string | null;
  checkpoint: Uint8Array;
  metadata: Uint8Array | null;
}

interface WriteRow {
  task_id: string;
  channel: string;
  type: string | null;
  value: Uint8Array | null;
  task_path: string;
  idx: number;
}

/**
 * 复刻框架对存储键的防护（MemorySaver 的 assertSafeStorageKey）。
 *
 * Saver 读回的 pendingWrites 会被组装进 JS 对象图，未净化的键 —— 尤其 __proto__ ——
 * 在对象语义下就是原型污染。SQLite 本身不在乎 task_id='__proto__'，危险发生在读回之后，
 * 所以这道校验必须留在 Saver 里，不能指望上层。
 */
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function assertSafeKey(
  field: string,
  value: string | undefined,
  allowEmpty = false,
): void {
  if (value === undefined) {
    throw new Error(
      "SqliteWALSaver：configurable 缺少必需的 " + field + " 字段。",
    );
  }
  if (!allowEmpty && value === "") {
    throw new Error('SqliteWALSaver："' + field + '" 不能是空字符串。');
  }
  if (typeof value !== "string") {
    throw new Error("SqliteWALSaver：" + field + " 必须是字符串。");
  }
  if (RESERVED_KEYS.has(value)) {
    throw new Error(
      'SqliteWALSaver：键 "' +
        field +
        '" 的值 "' +
        value +
        '" 被保留，会造成原型污染。',
    );
  }
}

export class SqliteWALSaver extends BaseCheckpointSaver {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    super();
    this.db = db;
    for (const ddl of CHECKPOINT_TABLES) this.db.exec(ddl);
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id as string | undefined;
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
    const checkpointId = config.configurable?.checkpoint_id as
      | string
      | undefined;
    if (threadId === undefined) {
      throw new Error("SqliteWALSaver.getTuple：configurable 缺少 thread_id。");
    }

    const sql =
      checkpointId === undefined
        ? "SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata\n" +
          "  FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ?\n" +
          "  ORDER BY checkpoint_id DESC LIMIT 1"
        : "SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata\n" +
          "  FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?";
    const params =
      checkpointId === undefined
        ? [threadId, ns]
        : [threadId, ns, checkpointId];
    const row = this.db.prepare(sql).get(...params) as RowShape | undefined;
    if (row === undefined) return undefined;

    const resolved: RunnableConfig = {
      configurable: {
        thread_id: row.thread_id,
        checkpoint_ns: row.checkpoint_ns,
        checkpoint_id: row.checkpoint_id,
      },
    };

    const checkpoint = (await this.serde.loadsTyped(
      row.type ?? "json",
      row.checkpoint,
    )) as Checkpoint;

    const writes = this.db
      .prepare(
        "SELECT task_id, channel, type, value, task_path, idx FROM writes\n" +
          "  WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?",
      )
      .all(
        row.thread_id,
        row.checkpoint_ns,
        row.checkpoint_id,
      ) as unknown as WriteRow[];

    const pendingWrites = await this.sortAndHydrate(writes);

    // 逐条展开而不是「先声明空对象再 if 赋值」：exactOptionalPropertyTypes 下，
    // 可选字段只在真有值时才出现在对象里（而不是被赋成 undefined）。
    const metadata: CheckpointMetadata | undefined =
      row.metadata !== null
        ? ((await this.serde.loadsTyped(
            row.type ?? "json",
            row.metadata,
          )) as CheckpointMetadata)
        : undefined;
    const parentConfig: RunnableConfig | undefined =
      row.parent_checkpoint_id !== null
        ? {
            configurable: {
              thread_id: row.thread_id,
              checkpoint_ns: row.checkpoint_ns,
              checkpoint_id: row.parent_checkpoint_id,
            },
          }
        : undefined;

    return {
      config: resolved,
      checkpoint,
      ...(metadata !== undefined ? { metadata } : {}),
      ...(parentConfig !== undefined ? { parentConfig } : {}),
      pendingWrites,
    };
  }

  /**
   * 排序是正确性要求，不是锦上添花：V17 记载基类明确要求 pendingWrites 按
   * writesSortKey(task_path, task_id, idx) 返回，顺序敏感的 reducer 靠这个顺序重放，
   * 乱序会重建出不同的值。而 writes 表主键是 (thread_id, ns, checkpoint_id, task_id,
   * idx) —— 主键自然序里没有 task_path，靠 SQL 排序拿不到框架要的序。
   *
   * 比较器必须用官方 compareWritesSortKeys：它按 Unicode 码点比（对齐 Python str 序），
   * 基类注释明确写着「不要用 < 或 localeCompare」。
   */
  private async sortAndHydrate(
    writes: WriteRow[],
  ): Promise<CheckpointPendingWrite[]> {
    const keyed = writes.map((w) => ({
      key: writesSortKey(w.task_path ?? "", w.task_id, w.idx ?? 0),
      row: w,
    }));
    keyed.sort((a, b) => compareWritesSortKeys(a.key, b.key));

    const out: CheckpointPendingWrite[] = [];
    for (const item of keyed) {
      const value = await this.serde.loadsTyped(
        item.row.type ?? "json",
        item.row.value ?? "",
      );
      out.push([item.row.task_id, item.row.channel, value]);
    }
    return out;
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const threadId = config.configurable?.thread_id as string | undefined;
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
    if (threadId === undefined) {
      throw new Error("SqliteWALSaver.list：configurable 缺少 thread_id。");
    }
    const { limit, before, filter } = options ?? {};
    if (filter !== undefined && Object.keys(filter).length > 0) {
      throw new Error(
        "SqliteWALSaver.list：metadata 过滤（filter）尚未实现。宁可抛错，也不能让调用方以为过滤生效了却拿到全量数据。",
      );
    }

    const where = ["thread_id = ?", "checkpoint_ns = ?"];
    const params: (string | number)[] = [threadId, ns];
    const beforeId = before?.configurable?.checkpoint_id as string | undefined;
    if (beforeId !== undefined) {
      // checkpoint_id 是 uuid6，时间单调，字典序即时间序；uuid4 会退化，届时改按 ts 排
      where.push("checkpoint_id < ?");
      params.push(beforeId);
    }
    let sql =
      "SELECT checkpoint_id FROM checkpoints WHERE " +
      where.join(" AND ") +
      " ORDER BY checkpoint_id DESC";
    if (limit !== undefined) {
      sql += " LIMIT " + Number.parseInt(String(limit), 10);
    }
    const ids = (
      this.db.prepare(sql).all(...params) as unknown as {
        checkpoint_id: string;
      }[]
    ).map((r) => r.checkpoint_id);

    for (const id of ids) {
      const tuple = await this.getTuple({
        configurable: {
          thread_id: threadId,
          checkpoint_ns: ns,
          checkpoint_id: id,
        },
      });
      if (tuple !== undefined) yield tuple;
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    // 形参对齐基类的四参数签名（V6：以基类为准，不照抄官方 SqliteSaver 的三参数）。
    // 下划线前缀=故意不用：MemorySaver 自己也忽略它（V20），channel_versions 本就在
    // checkpoint 载荷里。契约测试因此【不得】断言 newVersions 被持久化。
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const db = requireScopeDb("SqliteWALSaver.put");
    const threadId = config.configurable?.thread_id as string | undefined;
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
    const parentId = config.configurable?.checkpoint_id as string | undefined;
    assertSafeKey("thread_id", threadId);
    assertSafeKey("checkpoint_ns", ns, true);
    assertSafeKey("checkpoint_id", checkpoint?.id);

    const prepared = copyCheckpoint(checkpoint);
    const [[typeC, blobC], [, blobM]] = await Promise.all([
      this.serde.dumpsTyped(prepared),
      this.serde.dumpsTyped(metadata),
    ]);

    db.prepare(
      "INSERT OR REPLACE INTO checkpoints\n" +
        "  (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)\n" +
        "  VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      threadId ?? null,
      ns,
      checkpoint.id,
      parentId ?? null,
      typeC,
      blobC,
      blobM,
    );

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: ns,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath?: string,
  ): Promise<void> {
    const db = requireScopeDb("SqliteWALSaver.putWrites");
    const threadId = config.configurable?.thread_id as string | undefined;
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
    const checkpointId = config.configurable?.checkpoint_id as
      | string
      | undefined;
    assertSafeKey("thread_id", threadId);
    assertSafeKey("checkpoint_ns", ns, true);
    assertSafeKey("checkpoint_id", checkpointId);
    assertSafeKey("task_id", taskId);

    /**
     * 冲突策略按通道分裂，且必须与官方和 MemorySaver 完全一致（实测基线）：
     *   - 特殊通道：INSERT OR REPLACE —— 同一个 task 重试后要覆盖旧的错误/中断记录
     *   - 普通通道：INSERT OR IGNORE —— 重放时先到先得，后到丢弃
     * 写反的后果不是报错而是静默重建出不同的状态，最难查的那类 bug。
     */
    const allSpecial =
      writes.length > 0 &&
      writes.every(
        ([channel]) =>
          (WRITES_IDX_MAP as Record<string, number>)[channel] !== undefined,
      );
    const stmt = db.prepare(
      "INSERT " +
        (allSpecial ? "OR REPLACE" : "OR IGNORE") +
        " INTO writes\n" +
        "  (thread_id, checkpoint_ns, checkpoint_id, task_id, task_path, idx, channel, type, value)\n" +
        "  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );

    for (let idx = 0; idx < writes.length; idx++) {
      const write = writes[idx];
      if (write === undefined) continue;
      const [channel, value] = write;
      const [type, blob] = await this.serde.dumpsTyped(value);
      // 特殊通道（__error__=-1、__scheduled__=-2、__interrupt__=-3、__resume__=-4）用固定
      // 负数，普通通道用数组下标。用 ?? 而非 ||：实测 WRITES_IDX_MAP 只有这四个负值，
      // 当前【没有可达输入能让两者分叉】（变异测试里 || 版本被判等价变异）。?? 表达的是
      // 「仅当通道不在表里才取默认下标」这一意图；若将来框架给某通道分配 idx=0，|| 就会
      // 静默退化。用 ?? 把这个未来分歧挡掉，别把它当注释里的既有 bug 读。
      const mapped = (WRITES_IDX_MAP as Record<string, number>)[channel] ?? idx;
      stmt.run(
        threadId ?? null,
        ns,
        checkpointId ?? null,
        taskId,
        taskPath ?? "",
        mapped,
        channel,
        type,
        blob,
      );
    }
  }

  /**
   * 允许在事务作用域内外调用：作用域内复用外层事务，作用域外自己开短事务。
   * 与 put 不同，deleteThread 是 Hub 的管理操作（清理已完成线程），不是框架每超步
   * 调用的写路径，没有「必须与 events 同事务」的约束。
   */
  async deleteThread(threadId: string): Promise<void> {
    assertSafeKey("thread_id", threadId);
    const scope = currentScope();
    if (scope !== undefined) {
      this.deleteFrom(scope.db, threadId);
      return;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.deleteFrom(this.db, threadId);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* 事务可能已被 SQLite 自身中止 */
      }
      throw error;
    }
  }

  private deleteFrom(db: DatabaseSync, threadId: string): void {
    // 先删 writes 再删 checkpoints：中途崩溃只会留下孤儿 writes，
    // 而 getTuple 以 checkpoints 为入口，孤儿 writes 读不到、不影响正确性。
    db.prepare("DELETE FROM writes WHERE thread_id = ?").run(threadId);
    db.prepare("DELETE FROM checkpoints WHERE thread_id = ?").run(threadId);
  }
}
