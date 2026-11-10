/**
 * 完整性检查的 worker 入口（Task 6.2）。
 *
 * 这是【入口】而不是普通模块：它被 `new Worker(...)` 直接加载，
 * 所以顶层副作用是设计而不是疏忽（对照 src/db/driver.ts 那种纯库文件）。
 *
 * ── 为什么必须有第二个线程 ────────────────────────────────────────────
 * `node:sqlite` 是同步 API。规格附录 C.1 那句「大查询会冻结整个 Hub」在
 * integrity_check 上是最直白的形态：全库扫描跑在 Hub 主线程上期间，
 * 写队列、心跳调度、HTTP 全部停摆（计划 Task 6.3 的验收原文就是
 * 「integrity_check 不得在主线程 / UI 进程执行」）。
 * 所以判据本身跑在 worker 里，而 worker 用的是【独立只读连接】——
 * 它不与 WriteQueue 共享任何连接，物理上就抢不到那个单写者。
 *
 * ── 三条只在这条路上成立的约束 ───────────────────────────────────────
 * 1) **入口必须挂 parentPort，且必须判断 null。** `parentPort === null` 意味着
 *    这个文件被【主线程】import 了（比如某个测试直接 import 它想复用里面的函数）。
 *    那种情况下静默什么都不做 = 一次检查从未发生而没人报错。所以显式抛。
 * 2) **不得 import 任何 @langchain/*。** worker 由 `new Worker()` 加载，
 *    拿到的是主线程的 execArgv，但【不是】主线程的模块图；带框架 import 会让这个
 *    入口在缺那几个包时连加载都做不到（本机就缺，见 0009 §2），于是
 *    「完整性检查」这一整块的可验证性由 import 图决定 —— 同 graph/thread.ts 的立场。
 * 3) **一切异常都必须变成一条消息回给主线程。** worker 里抛出未被 postMessage
 *    的东西，主线程只有在挂了 error 事件时才看得见；漏挂就是
 *    「检查消失了、Promise 永远不 resolve」—— 那是本模块最坏的失效形状
 *    （一个永不返回的完整性检查比没有检查更危险，因为它挂在那儿等）。
 */

import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { isPageOk, reportText } from "./page-check.js";

/**
 * 只读连接上的 PRAGMA。
 *
 * 这里【不 import ./pragmas.js 的 applyPragmas】，是刻意的偏离，理由有两条：
 *  - applyPragmas 会执行 `PRAGMA journal_mode = WAL`。那是一条【持久】设置，
 *    在只读连接上对已经是 WAL 的库无害，但对一份【快照文件】
 *    （VACUUM INTO 的产物，journal_mode 是 delete）会当场抛
 *    "attempt to write a readonly database"（实测）。完整性检查要能查快照
 *    —— 计划 Task 6.3 要求「备份文件可被另一连接打开并通过 integrity_check」，
 *    那是同一份代码的消费者。
 *  - foreign_keys 对只读扫描无意义，busy_timeout 有意义（遇到写事务时等而不是抛）。
 *    两者照旧写上，与 pragmas.ts 的取值同源：BUSY_TIMEOUT_MS 抄的是那个 5000。
 * 这条「同一套设置的第二份副本」是明知故犯，代价与判据记在 0018 §3，
 * 那里也写了它该在什么时候被收回（pragmas.ts 加一个 skipJournalMode 参数时）。
 */
const BUSY_TIMEOUT_MS_WORKER = 5000;

/** 与 src/db/integrity.ts 的 IntegrityReport 同形状。这里手写一份而不是 import：
 *  见文件头第 2 条 —— worker 的模块图要尽量小。类型是结构同形的，
 *  主线程那边有断言钉住两侧字段一致（integrity.test.ts ② 节）。 */
export type WorkerReport = {
  readonly ok: boolean;
  readonly via: "worker";
  /** integrity_check 那一列的原文。健康时恰是一行 "ok"。 */
  readonly report: string;
  /** 逐条检查的结论。worker 只跑 integrity_check 这一条，所以只有一行。 */
  readonly checks: readonly {
    readonly name: "page_integrity";
    readonly ok: boolean;
    readonly detail: string;
  }[];
  readonly events: number;
  readonly ms: number;
  readonly dbPath: string;
  readonly startedAtMs: number;
};

export type WorkerRequest = {
  readonly dbPath: string;
};

function openReadonly(path: string): DatabaseSync {
  return new DatabaseSync(path, {
    readOnly: true,
    enableForeignKeyConstraints: true,
    timeout: BUSY_TIMEOUT_MS_WORKER,
  });
}

/**
 * 跑一次 `PRAGMA integrity_check`。
 *
 * 判据是【恰有一行且该行 == "ok"】，不是【包含 ok】：
 * 实测损坏库上返回的是多行诊断文本（"*** in database main ***\nTree 2 page 4
 * cell 11: Offset 65173 out of range…"），里面确实【含有】"ok" 这种子串的可能性
 * 由损坏内容自己决定 —— 损坏报告里出现 "ok" 完全可能（文件名、页内容片段）。
 * 用「包含」判过，就是给一个损坏库发通行证。
 */
export function runIntegrityCheck(dbPath: string): WorkerReport {
  const started = Date.now();
  const db = openReadonly(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = " + BUSY_TIMEOUT_MS_WORKER + ";");
    const rows = db.prepare("PRAGMA integrity_check").all() as Record<
      string,
      string
    >[];
    // 判据从 ./page-check.js 取，不在这里重写 —— 这一行就是「两侧同一口径」的
    // 物质基础。口径写两处，就总有其中一处先改，而且改完两边都还是绿的。
    const report = reportText(rows);
    const ok = isPageOk(rows);
    const events = countEvents(db);
    return {
      ok,
      via: "worker",
      report,
      checks: [{ name: "page_integrity", ok, detail: report.slice(0, 2000) }],
      events,
      ms: Date.now() - started,
      dbPath,
      startedAtMs: started,
    };
  } finally {
    db.close();
  }
}

function countEvents(db: DatabaseSync): number {
  const has = db
    .prepare(
      "SELECT count(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'events'",
    )
    .get() as { c: number | bigint };
  if (Number(has.c) === 0) return 0;
  const row = db.prepare("SELECT count(*) AS c FROM events").get() as {
    c: number | bigint;
  };
  return Number(row.c);
}

if (parentPort === null) {
  throw new Error(
    "integrity.worker.ts 被主线程 import 了。它是 worker 入口：顶层副作用就是它的全部职责，" +
      "要复用 runIntegrityCheck 请从 src/db/integrity.ts 走（那里有主线程同步兜底版本）。",
  );
}

const req = workerData as Partial<WorkerRequest> | undefined;
const dbPath = typeof req?.dbPath === "string" ? req.dbPath : "";

if (dbPath === "") {
  parentPort.postMessage({
    ok: false,
    via: "worker",
    report: "worker 没收到 dbPath（workerData = " + JSON.stringify(req) + "）",
    checks: [],
    events: 0,
    ms: 0,
    dbPath: "",
    startedAtMs: Date.now(),
  } satisfies WorkerReport);
} else {
  try {
    parentPort.postMessage(runIntegrityCheck(dbPath));
  } catch (e) {
    // 见文件头第 3 条：worker 侧的异常【必须】以消息形态回去。
    // 一条坏消息让主线程判失败，与一条消息都不发让主线程永远等，
    // 后者才是不可接受的失效。
    parentPort.postMessage({
      ok: false,
      via: "worker",
      report: "worker 内部抛错：" + String(e),
      checks: [],
      events: 0,
      ms: 0,
      dbPath,
      startedAtMs: Date.now(),
    } satisfies WorkerReport);
  }
}
