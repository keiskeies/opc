import type { DatabaseSync } from "node:sqlite";
import { currentScope, txScope } from "../checkpoint/tx-scope.js";
import { openDb } from "./driver.js";
import { openReadonlyDb } from "./pragmas.js";

/**
 * Task 0.5　单写者写队列（规格 §5.5、附录 C.2）。
 *
 * Hub 进程内只有一个写者：WAL 允许多读单写，但【并发写】时第二个连接要么等
 * busy_timeout 要么拿 SQLITE_BUSY，而审计库丢一条事件是不可逆的数据损失。
 * 所以写全部排进一条串行链。
 *
 * ── 相对规格附录 C.2 参考实现的偏离（四处，均有实测依据）──────────────
 * 1) 不自己 new DatabaseSync，改用 driver.openDb()。否则「那 4 条 PRAGMA」就有了
 *    第二个权威源，两处不一致的表现是「这台机器 synchronous=NORMAL、那台 FULL」或
 *    「主连接外键 ON、旁路连接 OFF」—— 后者不报错，只是约束没了。
 * 2) 不用 JSON.stringify 打包 stmts（规格 C.2 那么写）。实测该做法破坏参数类型：
 *      Uint8Array → {"0":0,"1":255,…} → run() 报 "Unknown named parameter '0'"
 *      BigInt     → 直接抛 "Do not know how to serialize a BigInt"
 *      Date       → 退化成 ISO 字符串
 *    checkpoint saver 写的正是 BLOB。照抄会做出「测试全绿、生产写不进 checkpoint」。
 * 3) 失败不污染队列。若图省事把 tail 写成可能被 reject 的 promise，此后每次提交都会
 *    继承第一次的失败 —— 实测表现为 "cannot start a transaction within a
 *    transaction"（外层事务再也没提交），且所有报错都指向一个早已解决的假原因。
 *    见 #enqueue：tail 必须吞掉结果与错误，只把 run 本身交给调用方。
 * 4) 自己校验占位符与参数个数（见 assertParamCount）。规格 C.2 不做这件事，因为它
 *    连 stmts 都是 JSON 字符串、根本没机会看参数。
 */

/** 一条待执行语句：SQL + 位置参数。 */
export type Stmt = [sql: string, params: unknown[]];

const SQ = String.fromCharCode(39); // 单引号
const DQ = String.fromCharCode(34); // 双引号
const BQ = String.fromCharCode(96); // 反引号：SQLite 兼容 MySQL 的标识符引用

/**
 * 去掉字符串字面量、引号标识符与注释，只留 SQL 骨架（这些区域一律替换成空格）。
 *
 * 为什么不能直接扫原文：附录 C 的触发器体写着 RAISE(ABORT, 'events table is append-only')，
 * 字符串里可能含分号；注释里的分号也不该计数。
 * 为什么替换成空格而不是 ? ：下面要数占位符 ?，用 ? 做替换符会凭空造出占位符。
 * 这是「同一个骨架函数服务两个目的」时最容易踩的坑。
 */
function skeleton(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === SQ || c === DQ || c === BQ) {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2; // 连续两个引号是内嵌转义
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      // 未闭合的引号：剩余全部视为字符串内容，交由 SQLite 自己报语法错
      i = j;
      out += " ";
      continue;
    }
    if (c === "-" && next === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = sql.indexOf("*/" as string, i + 2);
      i = end < 0 ? sql.length : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * 校验单条语句。
 *
 * 依据（实测）：node:sqlite 的 prepare() 接受含分号的多语句字符串【且不报错】，
 * 但只执行第一条 —— "INSERT INTO a …; INSERT INTO b …" 会让 b 永远是 0 行。
 * 在审计库里这就是「事件写了、预算没累计」的直接来源，而且是静默的。
 * 所以宁可在这里抛错，逼调用方把语句拆开写进 stmts 数组 —— 顺序与事务边界由数组
 * 表达，不藏进字符串。
 */
export function assertSingleStatement(sql: string): void {
  const body = skeleton(sql).trim().replace(/;+$/u, "");
  if (body.includes(";")) {
    throw new Error(
      "写队列的每条 stmt 必须是单条 SQL 语句，实到多条：[" +
        sql.slice(0, 60) +
        "…]. 分号请改成数组里的独立条目 —— 顺序与事务边界都由数组表达，不要藏进字符串里" +
        "（prepare() 会静默丢弃第二条之后的语句）。",
    );
  }
}

/** SQL 里出现的参数风格。混合或显式索引时不做计数校验 —— 宁可不校验，也不误伤。 */
interface BindShape {
  anonymous: number;
  indexedMax: number;
  otherStyle: boolean;
}

function scanPlaceholders(sql: string): BindShape {
  const body = skeleton(sql);
  let anonymous = 0;
  let indexedMax = 0;
  let otherStyle = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === undefined) continue;
    if (c === "?") {
      let j = i + 1;
      let digits = "";
      while (j < body.length) {
        const d = body[j];
        if (d !== undefined && d >= "0" && d <= "9") {
          digits += d;
          j++;
          continue;
        }
        break;
      }
      if (digits !== "") {
        // ?NNN 显式索引：?1 与 ?1 只消耗一个位置参数（实测绑 1 个参数写入两列）
        indexedMax = Math.max(indexedMax, Number(digits));
      } else if (/[A-Za-z_]/u.test(body[j] ?? "")) {
        otherStyle = true; // ?AAA：Tcl 变量风格，不计数
      } else {
        anonymous++;
      }
      i = j - 1;
      continue;
    }
    if (c === ":" && body[i + 1] === ":") {
      // 跳过第二个冒号。注意：双冒号【不是】SQLite 的类型转换写法（实测报
      // "unrecognized token"，那是 PostgreSQL 方言）。这里唯一的作用是别把 a::b
      // 的第二个冒号当成命名参数 —— 一旦置了 otherStyle，assertParamCount 会整个
      // return，少绑校验就此静默失效，比误拦严重得多。
      i++;
      continue;
    }
    if (c === ":" || c === "@" || c === "$") {
      if (/[A-Za-z_]/u.test(body[i + 1] ?? "")) otherStyle = true; // 命名参数
    }
  }
  return { anonymous, indexedMax, otherStyle };
}

/**
 * 校验「匿名 ? 的个数 == 传入参数个数」。
 *
 * 为什么必须由我们自己校验（实测）：node:sqlite 对【少绑】参数在可空列上
 * 【不报错】，直接写 NULL —— INSERT INTO p (a,b) VALUES (?,?) 只绑一个值，
 * 结果 {"a":"只有这一个","b":null}。多绑才会抛 "column index out of range"。
 * 也就是说最危险的方向（少绑）没有任何保护。
 *
 * 这在审计库里不是洁癖：events 的 task_id / target / state_snapshot 都是可空列，
 * 少绑一个参数就静默写出「事件记了但没关联任务」，审计回放看不出异常，
 * 因为 NULL 是完全合法的值。抛错永远好过写出一个合法但错误的行。
 */
export function assertParamCount(
  sql: string,
  params: readonly unknown[],
): void {
  const shape = scanPlaceholders(sql);
  if (shape.otherStyle || shape.indexedMax > 0) return; // 不是纯匿名风格，不猜
  if (params.length === shape.anonymous) return;
  throw new Error(
    "SQL 占位符与参数个数不符：匿名 ? 有 " +
      shape.anonymous +
      " 个，实传 " +
      params.length +
      " 个 —— [" +
      sql.slice(0, 60) +
      "…]. node:sqlite 在【少绑】时不报错、直接写 NULL，而 events 里多个列可空，" +
      "结果是合法但错误的行。宁可抛错。",
  );
}

const SETTLED = () => {};

/**
 * 写入方 = 【单写者队列】，不是一条连接。形状取 Pick 而不是直接收 WriteQueue：
 * 用到的只有 node() 这一个方法，而测试要能塞一份不碰磁盘的替身
 * （真 WriteQueue 的构造函数吃的是【路径】并当场 openDb，测试里为每条断言开一个库
 * 会让失败信息变成「哪个临时文件」而不是「哪个断言」）。
 *
 * Pick 的代价说清楚：它挡不住「自己实现一个 node()，里面不排队」——
 * 那种替身能让并发缺陷在全测试绿的下面隐身。挡的方式不是类型，
 * 是 real-deps.test.ts 里那条【两次并发决策都成功、各自一行审计】的断言。
 *
 * ── 这个类型【原来】定义在 http/real-deps.ts，搬到这里是因为依赖方向 ────
 * 第二个使用方是 org/commit.ts（组织变更的版本化提交）。它 import 一个 http 模块
 * 才能拿到「怎么排队写库」这个类型，等于说成「组织功能属于 HTTP 层」；
 * 而桌面端走 IPC 同样要提交组织变更，那时它该 import 的是 org/，
 * 不该被迫拖进一个 http 模块。类型描述的是【队列】，所以它和队列住一起。
 * real-deps.ts 那边留一条 re-export：已有调用方一字不改，
 * 而定义只有一处（不留两份 Pick，否则一处收紧一处没跟上）。
 */
export type Writer = Pick<WriteQueue, "node">;

/** 装配入口用的写入方：比 Writer 多一个只读连接（理由见 real-deps.ts 的 HubDeps 装配）。 */
export type HubWriter = Pick<WriteQueue, "node" | "readConnection">;

export class WriteQueue {
  #write: DatabaseSync;
  #read: DatabaseSync;
  /** 串行链。tail 本身【永不 reject】，见类注释第 3 条。 */
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(dbPath: string) {
    this.#write = openDb(dbPath);
    // 读走独立连接（规格 §5.5）：读不该被写队列排队拖住，也不该看到未提交数据。
    // 只读连接物理上写不进去，而不是靠「谁都记得 read 只用来查」。
    // 顺序有意义：写连接先开、库已是 WAL，只读连接上的 journal_mode PRAGMA
    // 才不需要去改日志模式（在事务里改 WAL 会报 "cannot change into wal mode…"）。
    this.#read = openReadonlyDb(dbPath);
  }

  /** 串行化入口。job 抛错只拒绝它自己的调用方，不影响后续。 */
  #enqueue<T>(job: () => Promise<T> | T): Promise<T> {
    const run = this.#tail.then(job, job);
    // tail 吞掉结果与错误：一次失败绝不能让整条链变 rejected
    this.#tail = run.then(SETTLED, SETTLED);
    return run as Promise<T>;
  }

  /**
   * async API 的参数校验错误一律以 rejection 呈现，【不】同步抛。
   *
   * 理由：tx() 的返回类型是 Promise<void>，调用方自然写 .catch() 或 try/await。
   * 若校验在入队前同步 throw，.catch() 接不住，错误会变成未捕获异常 ——
   * 而「参数写错」恰恰是最高频、最该被看见的那类错误。
   * （#assertOpen 与两个 *Connection() 是同步 API，同步抛是对的。）
   */
  #rejected(e: unknown): Promise<never> {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }

  /**
   * 一组语句在一个事务里提交（BEGIN IMMEDIATE … COMMIT）。
   *
   * 用途就是 §6.3 那类「缺一则审计回放出现状态变了但没日志」的组合写：
   * checkpoint + events + 预算累计。任何一条失败 → 整笔回滚 → 错误上抛。
   */
  tx(stmts: readonly Stmt[]): Promise<void> {
    try {
      this.#assertOpen();
      for (const [sql, params] of stmts) {
        assertSingleStatement(sql);
        assertParamCount(sql, params);
      }
    } catch (e) {
      return this.#rejected(e);
    }
    return this.#enqueue(async () => {
      await txScope(this.#write, async () => {
        for (const [sql, params] of stmts) {
          this.#write.prepare(sql).run(...(params as never[]));
        }
      });
    });
  }

  /**
   * 在写队列的事务里跑任意回调：checkpoint saver 之类需要多条语句、中间还要 await
   * （算 sha256、等门控判定）的调用方用它。
   *
   * 回调里 requireScopeDb() 拿到的就是这条写连接，因此 saver 写的 checkpoint 与
   * 调用方写的事件在同一事务里（0.4b 的 SqliteWALSaver 依赖这点）。
   */
  node<T>(fn: () => Promise<T> | T): Promise<T> {
    try {
      this.#assertOpen();
    } catch (e) {
      return this.#rejected(e);
    }
    // 嵌套必须【立刻】拒绝、不入队：外层已经占住队列，内层排它后面等它 ——
    // 那是死锁，而不是一个看得见的错误。ALS 里已有作用域 == 嵌套。
    if (currentScope()) {
      return this.#rejected(
        new Error(
          "WriteQueue 嵌套调用：已在一个 tx()/node() 内部。嵌套意味着外层事务被当成了另一个" +
            "提交点 —— 静默复用会让「谁负责 COMMIT」变成谜，直接失败更安全。",
        ),
      );
    }
    return this.#enqueue(() => txScope(this.#write, async () => await fn()));
  }

  /** 只读查询：独立连接、绑定参数、不进写队列。 */
  async read<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.#assertOpen();
    assertSingleStatement(sql);
    assertParamCount(sql, params);
    return this.#read.prepare(sql).all(...(params as never[])) as T[];
  }

  /** 给测试与备份路径用（VACUUM INTO 是唯一的在线备份手段，见附录 C.2）。 */
  writeConnection(): DatabaseSync {
    this.#assertOpen();
    return this.#write;
  }

  /** 只读连接。物理只读：拿它写会报 "attempt to write a readonly database"。 */
  readConnection(): DatabaseSync {
    this.#assertOpen();
    return this.#read;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("WriteQueue 已关闭");
  }

  /** 等队列排空后关闭两条连接。 */
  async close(): Promise<void> {
    if (this.#closed) return;
    await this.#tail;
    this.#closed = true;
    try {
      this.#read.close();
    } finally {
      this.#write.close();
    }
  }
}
