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

/**
 * `PRAGMA user_version` 里「这个库是**桩路线**建的」那个标记值。
 *
 * ── 为什么占的是 user_version ───────────────────────────────────────
 * 需要一个**随库文件走**、**读它不需要写权限**、且**加它不需要迁移**的槽位。
 * 满足的只有这一格：`PRAGMA user_version` 是 SQLite 留给应用自定义的 4 字节整数，
 * 存在库文件头里，`openReadonlyDb` 读得到（实测）。本仓此前**全仓零处**引用它
 * （`grep -rn user_version packages/hub` 只命中本文件），所以这一格是空的。
 *
 * ⚠ 反过来讲：从现在起这个槽位**被占了**，而且占它的是【路线归属】而不是【schema 版本】。
 * SQLite 社区最常见的用法是拿它存迁移条数 —— **本仓不要那么用**，理由是那两个语义
 * 会互相伪装：迁移条数会随迁移增加，而标记必须恒定。真要给 schema 记版本，
 * `schema_versions` 表早就在了（0004 那条）。
 * 这一条由 `packages/hub/test/cli/stub-write-guard.test.ts` 钉着：
 * 值必须 > 10_000（大到不可能是迁移条数），且除本文件外全仓不许再有人写它。
 *
 * ── 为什么是这个【形状】的判据，而不是「库里有没有 tasks 行」────────
 * 设计文档（docs/OPC-OS-功能优化设计.md O1-1）原本写的是后者。它**不成立**：
 * 一条全新的真库被误指给桩时，`count(tasks) === 0` ⇒ 守卫放行 ⇒ 桩把生产库
 * **当成自己的演示库收养**。那正是这条守卫存在的理由，却在最有价值的那一发上绿。
 * 「有没有 tasks 行」判的是【这个库现在有没有内容】，而要看的是【这个库是谁的】。
 */
export const STUB_DB_MARKER = 9_000_001;

/** 读 `user_version`（任何连接都能读，包括只读的）。 */
export function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as {
    user_version?: number | bigint;
  };
  // node:sqlite 把整数列返回 number 还是 bigint 取决于值域，两种都要能收下：
  // 判据在这里如果写成 `as number`，将来标记值变大就会**恒不等**，
  // 于是每个合法的演示库都被拒 —— 而那条红读起来像「守卫生效了」。
  const v = row.user_version;
  return typeof v === "bigint" ? Number(v) : (v ?? 0);
}

/** 打桩路线的归属标记。调用方负责确认这个库**确实是本次新建的**。 */
export function markStubDb(db: DatabaseSync): void {
  db.exec("PRAGMA user_version = " + STUB_DB_MARKER + ";");
}

/**
 * 以只读模式打开一个【已存在】的库文件，并施加同一套 PRAGMA。
 */
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

/**
 * 以只读模式打开一个【快照文件】—— VACUUM INTO 的产物、或刚从备份恢复出来的那份。
 *
 * 为什么不复用 openReadonlyDb（这件事值得一个函数而不是一个 if）：
 * 实测 VACUUM INTO 产物的 journal_mode 是 **delete**（不是 wal —— 快照是单文件，
 * 没有 -wal 可挂）。而 journal_mode 是【持久】设置：在只读连接上把它改成 WAL
 * 需要写库文件头，当场抛 "attempt to write a readonly database"（实测）。
 * 也就是说 openReadonlyDb 拿一份合法备份去打开会【直接失败】，
 * 失败信息还指向「只读连接不能改模式」这个看起来像调用方用错了 API 的方向。
 *
 * 这里跳过 journal_mode，另外三条照旧施加，理由与上面同源：
 * synchronous / foreign_keys / busy_timeout 是连接级的，跳过它们就是让这条连接
 * 与全仓其他连接行为不一致；而 journal_mode 恰恰是唯一一条【不该由校验者改】的 ——
 * 校验一份快照的时候改动它，等于校验动作本身修改了被校验对象。
 *
 * 快照被 hub 接管跑生产时，走的是 driver.openDb()，那条路会把 journal_mode 设回 WAL。
 * 所以「恢复出来的库先是 delete 模式」不是缺陷，是「还没人按生产方式打开它」。
 */
export function openSnapshotReadonlyDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path, {
    readOnly: true,
    enableForeignKeyConstraints: true,
    timeout: BUSY_TIMEOUT_MS,
  });
  try {
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = " + BUSY_TIMEOUT_MS + ";");
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}
