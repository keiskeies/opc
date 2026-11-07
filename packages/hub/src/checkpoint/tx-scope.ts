import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";

/**
 * 事务作用域（规格 §6.3，判定见 docs/decisions/0003-checkpoint-transaction-scope.md）。
 *
 * 0.4a 探针实测：LangGraph 在框架层调用 Saver 的 put / putWrites 时，ALS 上下文存活，
 * 且拿到的就是作用域内那条连接 —— 所以「Checkpoint 与 events 同一事务」能成立。
 *
 * 粒度：每个超步一个事务，不是每次 invoke 一个（0003 §3.2）。整图一个事务会叠加
 * V11「重复 invoke 重放已完成节点」废掉崩溃恢复，还会把库级写锁按住整张图的时长。
 */

export interface TxScope {
  readonly db: DatabaseSync;
}

const storage = new AsyncLocalStorage<TxScope>();

/** 当前作用域；不在作用域内返回 undefined（给需要区分场景的调用方）。 */
export function currentScope(): TxScope | undefined {
  return storage.getStore();
}

/**
 * 取当前作用域的连接；不在作用域内【抛错】而不是静默自开短事务。
 *
 * 静默自提是最危险的失效模式：调用方以为自己在事务里，实际每条语句各自 autocommit，
 * §6.3 的原子性在最常见路径上悄悄失效，而且不会有任何报错。宁可当场炸。
 *
 * @param caller 报错信息里出现的方法名，方便定位是谁在事务外写库。
 */
export function requireScopeDb(caller: string): DatabaseSync {
  const scope = storage.getStore();
  if (!scope) {
    throw new Error(
      caller +
        "：必须在 txScope() 内调用。Checkpoint 与 events 需要同一事务提交（规格 §6.3、" +
        "docs/decisions/0003-checkpoint-transaction-scope.md §6.2）。" +
        "确实要在事务外写，请显式再开一层 txScope()，不要把静默自提当默认。",
    );
  }
  return scope.db;
}

/**
 * 只建立事务【作用域】，不开事务：把 db 作为 ALS 帧内容交给 body。
 *
 * 为什么要把「建帧」与「开事务」拆成两个原语：LangGraph 一次 invoke 里，ALS 帧必须
 * 覆盖整个 invoke ——实测依据与完整推理见 docs/decisions/0005-event-bus-and-audit.md。
 * 一句话版本：
 * saver 在每次 put / putWrites 里都要 requireScopeDb()，而相邻两个超步事务之间也存在
 * 这种调用。若帧与事务同生共死，两次 COMMIT 之间就会出现「saver 需要连接但没有帧」
 * 的空窗，报「必须在 txScope() 内调用」。
 *
 * 反过来也成立：事务按超步滚动、帧按 invoke 存续，两者粒度不同，不能互相代替。
 * 这就是 recorder 的 StepTx 把 inTx() 与 db() 分成两个谓词的根本原因。
 *
 * 危险提示：这个原语【不开事务】。单独用它写库就是 autocommit —— 只有超步协调器
 * 这种自己管事务生命周期的调用方该用，业务代码请用 txScope()。
 */
export function scopeFrame<T>(
  db: DatabaseSync,
  body: () => Promise<T>,
): Promise<T> {
  return storage.run({ db }, body);
}

/**
 * 在 db 上开一个事务，并把这条连接作为作用域内容交给 body。
 *
 * 嵌套调用会直接撞 SQLite 的「cannot start a transaction within a transaction」——
 * 这是故意保留的 fail-fast：嵌套意味着外层忘记提交，或者有人在框架回调里偷偷再开一层。
 * 与其静默复用外层事务（提交时机就说不清了），不如让它显式失败。
 */ export async function txScope<T>(
  db: DatabaseSync,
  body: () => Promise<T>,
): Promise<T> {
  db.exec("BEGIN IMMEDIATE");
  return storage.run({ db }, async () => {
    try {
      const result = await body();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 事务可能已被 SQLite 自己中止（如 SQLITE_FULL），此时 ROLLBACK 也会抛；
        // 绝不能让它盖掉原始异常 —— 原始异常才是排查线索。
      }
      throw error;
    }
  });
}
