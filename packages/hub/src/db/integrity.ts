/**
 * 审计完整性校验（Task 6.2，规格 §22.4、§6.3、风险 6；计划 Task 6.2）。
 *
 * 四组检查，各对应一句原话：
 *   ① `PRAGMA integrity_check` —— 「启动时跑」，跑在 worker 里
 *   ② append-only 探针 —— 「尝试篡改 events → 触发器拦截并写安全审计」
 *   ③ 回放确定性 —— 「同一任务两次回放输出一致」（§24 风险 6）
 *   ④ 审计自洽 —— §22.4 那三句（状态变更有事件、门控决定有证据引用、
 *      harness 调用有消耗记录）+ events_fts 与内容表一致
 *
 * ── 为什么①必须在 worker 里 ─────────────────────────────────────────
 * `node:sqlite` 是同步 API（附录 C.1：扫大表的查询会冻结整个 Hub）。
 * 实测 40 000 行 / 15MB 的库上 integrity_check 单发 95ms；规格 §6.5 自己估的是
 * 「一万任务约 2–4GB」，同一发在主线程上就是几十秒的写队列停摆。
 * 所以①走 integrity.worker.ts + 独立只读连接。验收「执行期间写队列仍能提交」
 * 在 integrity.test.ts ① 节是**观测出来的**，不是看代码形状。
 *
 * ── 为什么②的审计必须写在应用层（本轮实测，0018 §1 第 6 条）─────────
 * 我原本打算把「有人试图改 events」记在触发器里。实测否证：
 * `BEFORE UPDATE … BEGIN INSERT INTO 审计表…; SELECT RAISE(ABORT,…); END` 里
 * 那笔 INSERT **不会留下** —— RAISE(ABORT) 回滚整条语句引起的改动，
 * 包括触发器自己写的。也就是说那个最自然的做法会得到一条【永远没有内容】的
 * 安全审计表，而它看起来是装好了的。所以：**应用层捕获被拒的异常，再写审计**。
 *
 * ── ④ 的三种结论，不是两种 ─────────────────────────────────────────
 * §22.4 那三句的宾语在 src 里的写入方数量是实测过的（复算 0018 §9）：
 * `events` / `tasks` / `evidence_bundles` / `budgets` 有写入方；
 * `review_gates` / `harness_calls` 的 INSERT 是【零】。
 * 所以每条规则有 `violated`（查出对不上）/ `ok`（查过且对得上）/
 * `not_observable`（库里这一类是空的，【没有东西可查】）三种。
 * 把 not_observable 混进 ok，会得到一张「全部通过」的报告而它证的是一句零断言 ——
 * 同 0016 §4b「读不到的断言在数据没写进库时照样绿」。空不是通过，是单独一栏。
 */

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import { AUDIT_ACTIONS, type AuditAction } from "../events/recorder.js";
import type { Writer } from "./write-queue.js";
import { isPageOk, reportText } from "./page-check.js";
import { selfWorkerUrl } from "./worker-entry.js";

/**
 * worker 入口地址：把【我自己】的后缀换成 .worker<同后缀>。
 *
 * 三条实测决定的写法（0018 §1 第 4、5 条）写全在 ./worker-entry.ts 里，这里不重述。
 * ⚠ **本节原本是内联那串 `import.meta.url.replace(...)`，并注明「全仓只允许这一处」。**
 * 0036 §2 量的事实是：那条断言只看 `src/db/integrity.ts` 一个文件，
 * 所以「全仓只有一处」当时【没有任何东西守着】。现在推导式收进 worker-entry.ts
 * 由两个 worker（本文件 + backup.ts 那个备份 worker）共用，
 * 「只有一处」改由 test/db/integrity.test.ts ⑦ 扫全部 src 下的 ts 文件守着 ——
 * 含推导式的文件恰好一个，就是 worker-entry.ts。
 */
const WORKER_URL: URL = selfWorkerUrl(import.meta.url);

/** 一次 worker 扫描的等待上限。超时按【失败】处理，不按【没查出问题】处理。 */
export const INTEGRITY_WORKER_TIMEOUT_MS = 120_000;

export const CHECK_NAMES = [
  "page_integrity",
  "append_only",
  "fts_index",
  "action_enum",
  "state_machine_agrees_with_events",
  "gate_evidence_reference",
  "harness_call_recorded",
] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

/**
 * 四种结论，两两之间都不能互相折叠：
 *  - ok              查过了，没问题。
 *  - violated        查过了，查出问题。detail 必须点名具体哪一行。
 *  - not_observable  【库里没有东西可查】。今天 §22.4 那三条就是这个形状
 *                    （表是空的），它【不是】通过 —— 见文件头最后一段。
 *  - could_not_run   【规则自己没跑成】：那条查询抛了。
 *
 * 为什么不能把 could_not_run 并进 not_observable：两者对使用者的意思相反。
 * not_observable 说的是「这个库还很年轻，没有门控决定可核」，是常态；
 * could_not_run 说的是「有东西可核而尺子放不下去」（实测：库截断到 60% 之后，
 * 只读连接上任何一条查询都抛 "database disk image is malformed"，见 0018 §1 第 11 条）。
 * 并进去，一次真损坏就伪装成「本仓当前没有门控 producer」这条人人皆知的常态 ——
 * 而这条常态每天都在报告里出现，没人会多看一眼。
 *
 * 也不能并进 violated：那会让「查询抛了」和「第 137 行不在索引里」共用一个结论，
 * 而前者要修的是连接/文件，后者要修的是数据。
 */
export const CHECK_VERDICTS = ["ok", "violated", "not_observable", "could_not_run"] as const;
export type CheckVerdict = (typeof CHECK_VERDICTS)[number];

export type CheckResult = {
  readonly name: CheckName;
  readonly verdict: CheckVerdict;
  /** violated 时必须指名【具体哪一行】，不能只说「有异常」。 */
  readonly detail: string;
  /** 这一条实际看了多少行。checked = 0 且 verdict = ok 是矛盾的，有断言钉。 */
  readonly checked: number;
};

export const INTEGRITY_FAILURES = [
  "worker_unavailable",
  "worker_timeout",
  "worker_error",
] as const;
export type IntegrityFailure = (typeof INTEGRITY_FAILURES)[number];

export type IntegrityReport = {
  readonly ok: boolean;
  readonly dbPath: string;
  /** "main_thread" 只可能来自显式 opt-in，见 runIntegrityScan。 */
  readonly via: "worker" | "main_thread";
  readonly checks: readonly CheckResult[];
  /**
   * 库里 events 的行数。null = 【数不出来】（连接读不动这份库）。
   * 不是 0 —— 0 的意思是「空库」，那是两件事，理由见 safeCountEvents。
   */
  readonly events: number | null;
  readonly ms: number;
  /** integrity_check 的原始输出（健康时恰为一行 "ok"）。 */
  readonly pageReport: string;
  readonly startedAtMs: number;
  /** 判据自己坏掉的三种情形。有它才分得开「查出问题」与「没法查」（0007 §4 取舍三）。 */
  readonly unavailable?: IntegrityFailure;
};

/** 报告里除 page_integrity 之外的那些检查，来自 auditCoherenceReport 与探针。 */
export type RunOptions = {
  readonly dbPath: string;
  /**
   * 一条【已经打开】的连接，用来跑②③④（它们需要同一条读连接）。
   * 本模块【不在内部开连接】：谁持有连接谁负责关，而 §5.6.1 那条进程边界
   * 也不该被一个校验模块用「我自己 new 一个」绕过。
   */
  readonly db: DatabaseSync;
  /** 探针需要写审计，所以要给写队列。不给就跳过②，并如实记 not_observable。 */
  readonly writer?: Writer;
  readonly onMainThread?: boolean;
  readonly timeoutMs?: number;
  readonly ftsSample?: number;
  readonly now?: () => number;
};

/**
 * 一次完整检查：① worker + ② 探针 + ④ 自洽。
 *
 * `onMainThread` 是【显式 opt-in】而不是自动兜底：
 * worker 起不来时自动退回主线程扫描，等于在【最像出事的时候（环境坏了）】
 * 悄悄违反计划 Task 6.2 的验收「不得在主线程执行」。
 * 所以 worker 失败就如实报 unavailable；要主线程扫必须调用方自己传，
 * 而报告里的 via 会诚实地写 "main_thread"。
 */
export async function runIntegrityScan(
  o: RunOptions,
): Promise<IntegrityReport> {
  const now = o.now ?? Date.now;
  const started = startedAt(o);
  const timeoutMs = o.timeoutMs ?? INTEGRITY_WORKER_TIMEOUT_MS;

  const page =
    o.onMainThread === true
      ? pageViaMainThread(o.db)
      : await pageViaWorker(o.dbPath, timeoutMs);

  const probe: CheckResult =
    o.writer === undefined
      ? {
          name: "append_only",
          verdict: "not_observable",
          detail: "调用方没给写队列，append-only 探针【没有跑】。不是通过。",
          checked: 0,
        }
      : await guardedProbe(o.writer);

  const checks: CheckResult[] = [
    {
      name: "page_integrity",
      verdict: page.ok ? "ok" : "violated",
      detail: page.pageReport.slice(0, 2000),
      checked: 1,
    },
    probe,
    ...auditCoherenceReport({ db: o.db, ...(o.ftsSample === undefined ? {} : { ftsSample: o.ftsSample }) }),
  ];

  return {
    // could_not_run 也拉下 ok。理由与 unavailable 同一条（0007 §4 取舍三）：
    // 「有一格没跑成」的报告不能被人当「全绿」读走。区分二者是 detail 的活，
    // 不是 ok 这个布尔的活。
    ok:
      page.ok &&
      !checks.some(
        (c) => c.verdict === "violated" || c.verdict === "could_not_run",
      ),
    dbPath: o.dbPath,
    via: page.via,
    checks,
    events: safeCountEvents(o.db),
    ms: now() - started,
    pageReport: page.pageReport,
    startedAtMs: started,
    ...(page.unavailable === undefined ? {} : { unavailable: page.unavailable }),
  };
}

function startedAt(o: RunOptions): number {
  return (o.now ?? Date.now)();
}

/**
 * 主线程那一发页面检查。
 *
 * 【必须捕获】PRAGMA 自己的抛错。本轮实测（0018 §1 第 11 条）：把一份库截断到 60%
 * 再用只读连接打开，`PRAGMA integrity_check` 不是返回多行诊断文本，而是【直接抛】
 * "database disk image is malformed"。worker 里那一发有 try/catch 兜着（文件头第 3 条），
 * 主线程这一支原本没有 —— 于是损坏库上 runIntegrityScan({onMainThread:true}) 会
 * 【整体 reject】，调用方拿到的是一个 rejection，与「我 SQL 写错了」长得一模一样。
 * 一个会抛的完整性检查，在出事的时候最容易被当成调用方的 bug 而没人去看那条真损坏的库。
 *
 * 报成 violated（而不是 unavailable）也是想过的：unavailable 说的是【判据自己坏了】，
 * 而这里坏的是被检查的库 —— 抛错本身就是本次检查最重要的发现。原始错误文本进 detail。
 */
function pageViaMainThread(db: DatabaseSync): PageOutcome {
  try {
    const rows = db.prepare("PRAGMA integrity_check").all() as Record<string, string>[];
    return {
      ok: isPageOk(rows),
      pageReport: reportText(rows),
      via: "main_thread",
    };
  } catch (e) {
    return {
      ok: false,
      pageReport:
        "integrity_check 在主线程【直接抛错】而不是返回诊断文本 —— " +
        String(e) +
        "。这份库坏到尺子都放不下去。按 violated 处理：一次【跑不下去】的页面检查" +
        "不能报成没问题，也不能报成「检查坏了」——坏的是被检查的那份库。",
      via: "main_thread",
    };
  }
}

type PageOutcome = {
  readonly ok: boolean;
  readonly pageReport: string;
  readonly via: "worker" | "main_thread";
  readonly unavailable?: IntegrityFailure;
};

async function pageViaWorker(
  dbPath: string,
  timeoutMs: number,
): Promise<PageOutcome> {
  const got = await runInWorker(dbPath, timeoutMs);
  if (got === null) {
    return {
      ok: false,
      pageReport:
        "worker 在 " +
        timeoutMs +
        "ms 内没有回消息。按失败处理：一次【没跑完】的完整性检查不能算通过。",
      via: "worker",
      unavailable: "worker_timeout",
    };
  }
  if ("failure" in got) {
    return {
      ok: false,
      pageReport: got.message,
      via: "worker",
      unavailable: got.failure,
    };
  }
  return {
    ok: got.ok === true && got.via === "worker",
    pageReport: got.report,
    via: "worker",
  };
}

type WorkerOk = import("./integrity.worker.js").WorkerReport;
type WorkerBad = { readonly failure: IntegrityFailure; readonly message: string };

function runInWorker(
  dbPath: string,
  timeoutMs: number,
): Promise<WorkerOk | WorkerBad | null> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(WORKER_URL, { workerData: { dbPath } });
    } catch (e) {
      // 入口不存在 / 加载失败。这一条【不】自动退回主线程（见 runIntegrityScan）。
      resolve({
        failure: "worker_unavailable",
        message:
          "worker 起不来：" +
          String(e) +
          "。试过的位置 " +
          fileURLToPath(WORKER_URL) +
          "。要临时在主线程扫，显式传 onMainThread: true。",
      });
      return;
    }
    let settled = false;
    const finish = (v: WorkerOk | WorkerBad | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 正常路径上 worker 跑完 postMessage 就自己退出了（没有常驻句柄）。
      // 这里仍显式 terminate，是因为【超时那一支】它可能正卡在扫描中间，
      // 不 terminate 就是一个永不结束的线程。
      void worker.terminate();
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    worker.once("message", (m) => finish(m as WorkerOk));
    worker.once("error", (e) =>
      finish({ failure: "worker_error", message: String(e) }),
    );
  });
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

/**
 * 报告里 events 那一格用的版本：读不出来就报 null。
 *
 * 这是同一类洞的【第三处】（前两处是页面检查与自洽规则，见 pageViaMainThread
 * 与 guarded）：损坏库上连 `SELECT count(*) FROM events` 都会抛
 * "database disk image is malformed"（实测，0018 §1 第 11 条），
 * 而我补完前两处之后，runIntegrityScan 仍然在这第三处 reject ——
 * 一条修完主路径、却被计数行漏掉的抛错。
 *
 * 为什么是 null 而不是 0 或 -1：
 *  - 0 是【真值】，意思是「库里一行事件都没有」。用 0 表示「数不出来」，
 *    就把一份读不动的库报成一份空库 —— 而空库正是最不该被误报的状态
 *    （它会顺带让好几条检查变成 not_observable）。
 *  - -1 是个魔法数，谁拿去做算术都不会报错。
 * null 逼调用方处理，这与 IntegrityReport.unavailable 的处理方式一致。
 */
function safeCountEvents(db: DatabaseSync): number | null {
  try {
    return countEvents(db);
  } catch {
    return null;
  }
}

/* ── ② append-only 探针 ─────────────────────────────────────────────── */

export const PROBE_OUTCOMES = [
  "rejected_as_expected",
  "append_only_broken",
  "probe_reached_no_row",
  "no_row_to_probe",
] as const;
export type ProbeOutcome = (typeof PROBE_OUTCOMES)[number];

export type AppendOnlyProbeResult = {
  readonly outcome: ProbeOutcome;
  readonly verdict: CheckVerdict;
  readonly detail: string;
  /** 探针写的那条安全审计事件的 id。只有【真的被拦下】时才有。 */
  readonly auditEventId?: number;
  readonly probedEventId?: number;
};

/** 两条【真语句】。只有真去改，才会真撞触发器。 */
const PROBE_UPDATE_SQL = "UPDATE events SET payload = ? WHERE id = ?";
const PROBE_DELETE_SQL = "DELETE FROM events WHERE id = ?";

/** 触发器 RAISE 的原文片段。判「是触发器拒的」而不是「随便什么错拒的」靠它。 */
const TRIGGER_TEXT = "append-only";

const PROBE_MARKER = JSON.stringify({
  probe: "append_only",
  must_never_appear: true,
});

/** 做这件事的是进程，不是某个角色。 */
export const INTEGRITY_PROBE_ACTOR = {
  actorType: "system",
  actorId: "hub-integrity",
} as const;

/**
 * payload.kind。§22.1 那 10 个 action 里没有「自检」，加第 11 个值属改规格
 * （同 org/commit.ts、charter/store.ts 那两处判定），所以 action 复用
 * `unauthorized_attempt`，靠 payload.kind 区分。
 */
export const APPEND_ONLY_PROBE_KIND = "append_only_probe";

/**
 * ② 真去撞一次 append-only。
 *
 * 走 Writer（单写者队列）而不是旁路连接：探针的目的是验【触发器在不在】，
 * 不是验 SQLite 的并发拒绝。旁路连接会让「busy_timeout 到期报 database is locked」
 * 被当成「append-only 生效了」—— 两种拒绝的错误文本不同，
 * 而一个只判「抛没抛」的探针分不出来（下面 rejectedByTrigger 就是那条判据）。
 *
 * 四条结论：
 *  - rejected_as_expected：UPDATE 与 DELETE 都被拒且那一行未变 ⇒ 写审计。
 *  - append_only_broken：任何一条真改动了行。本模块【不会】试图把改坏的那行补回去 ——
 *    能改坏它的那一层也能删掉补回去的记录；能做的只有如实报 + 判失败。
 *  - probe_reached_no_row：语句一行都没匹配到 ⇒ 触发器压根没被触发，这一条没验成。
 *  - no_row_to_probe：空库，没有东西可撞 ⇒ not_observable。
 */
export async function probeAppendOnly(o: {
  readonly writer: Writer;
}): Promise<AppendOnlyProbeResult> {
  return o.writer.node(() => {
    const db = requireScopeDb("probeAppendOnly");
    const row = db
      .prepare("SELECT id, payload FROM events ORDER BY id DESC LIMIT 1")
      .get() as { id: number | bigint; payload: string } | undefined;
    if (row === undefined) {
      return {
        outcome: "no_row_to_probe",
        verdict: "not_observable",
        detail:
          "events 是空的，没有行可以撞触发器。append-only 【没有被证明过】—— " +
          "这一格不是通过。",
      };
    }
    const id = Number(row.id);
    const before = row.payload;

    // Number() 是必要的而不是装饰：类型上 run().changes 是 number | bigint，
    // 而判据要的是可与 0 比较的数。
    const update = rejectedByTrigger(
      () => Number(db.prepare(PROBE_UPDATE_SQL).run(PROBE_MARKER, id).changes),
    );
    const del = rejectedByTrigger(
      () => Number(db.prepare(PROBE_DELETE_SQL).run(id).changes),
    );
    const after = db
      .prepare("SELECT payload FROM events WHERE id = ?")
      .get(id) as { payload: string } | undefined;

    if (update.kind === "matched_nothing" || del.kind === "matched_nothing") {
      // 与 append_only_broken 分开报：那两种读法要做的下一步不同。
      // 这一支最常见的成因是【探针自己的 SQL 不对】（本轮实测踩过），
      // 报成「append-only 坏了」会把人送去查触发器，而该查的是这条语句。
      return {
        outcome: "probe_reached_no_row",
        verdict: "violated",
        detail:
          "探针的语句【一行都没匹配到】（UPDATE: " +
          describe(update) +
          "，DELETE: " +
          describe(del) +
          "），所以触发器根本没被触发 —— 这一条【没有验成】。" +
          "刚从 SELECT 里读到过 events.id = " +
          id +
          "，两发语句之间它就不在了：要么有旁路连接在改库（§5.5 那个单写者前提已经不成立），" +
          "要么探针自己的 SQL 与那行不对得上。两种都不是「append-only 正常」。",
      };
    }

    if (
      update.kind !== "rejected" ||
      del.kind !== "rejected" ||
      after?.payload !== before
    ) {
      return {
        outcome: "append_only_broken",
        verdict: "violated",
        detail:
          "append-only 【没有挡住】 events.id = " +
          id +
          "（UPDATE: " +
          describe(update) +
          "，DELETE: " +
          describe(del) +
          "，内容不变 = " +
          (after?.payload === before) +
          "）。规格 §6.3 那两条 BEFORE 触发器不在这一份库里，或被人放宽过。" +
          "审计表从这一刻起不再可信。",
      };
    }

    // 被拒之后才写审计。文件头那段实测说的就是这一行必须在【捕获之后】：
    // 放进触发器里写，RAISE(ABORT) 会把它一起回滚掉。
    const auditId = writeProbeAudit(db, id);
    return {
      outcome: "rejected_as_expected",
      verdict: "ok",
      detail:
        "对 events.id = " +
        id +
        " 试过 UPDATE 与 DELETE，两条都被触发器拒下（原文含「" +
        TRIGGER_TEXT +
        "」），那一行内容未变，安全审计已落库（events.id = " +
        auditId +
        "）。",
      auditEventId: auditId,
      probedEventId: id,
    };
  });
}

type Rejection =
  | { readonly kind: "rejected" }
  | { readonly kind: "allowed"; readonly changes: number }
  | { readonly kind: "matched_nothing" }
  | { readonly kind: "other_error"; readonly message: string };

/**
 * 跑一件事，回答【它是不是被触发器拒的】。
 *
 * 四种结局而不是布尔，每一支都对应一种【会被布尔折叠掉的真实失效】：
 *  - rejected：错误文本里有触发器那句原文。这才是「约束在」。
 *  - allowed：真改动了行（changes >= 1）。触发器不在或被放宽 —— 正主要抓的那个。
 *  - matched_nothing：语句成功但 changes = 0。这不是「约束在」也不是「约束坏了」，
 *    而是【压根没撞上它】：实测 `UPDATE events SET payload=? WHERE id=999` 的
 *    changes 是 0 且【不报错】—— 触发器只对真被改动的行触发。
 *    把它算成「挡住了」，就是给一条【从来没执行过 UPDATE】的探针发通过；
 *    而这一支本轮我自己踩了一次（探针的 SQL 少绑一个参数，changes 0，
 *    我当场读成「append-only 没挡住」）。见 0018 §6。
 *  - other_error：`no such table` / `database is locked` / 绑定错。把这两种
 *    「约束根本不在」的情形折叠成「挡住了」是最坏的读法，所以一律【抛】。
 *    抛错会连带回滚探针所在的 node() 事务，探针那条审计也一起没了 —— 那是
 *    正确方向：一次【没验成】的探针不该留下一条看起来验过了的记录。
 */
function rejectedByTrigger(attempt: () => number): Rejection {
  try {
    const changes = attempt();
    return changes >= 1
      ? { kind: "allowed", changes }
      : { kind: "matched_nothing" };
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    if (!msg.includes(TRIGGER_TEXT)) {
      throw new Error(
        "append-only 探针撞到的是【另一种】失败，不能当成「触发器挡住了」：" +
          msg +
          "。先修这一条再读完整性报告。",
      );
    }
    return { kind: "rejected" };
  }
}

function describe(r: Rejection): string {
  switch (r.kind) {
    case "rejected":
      return "被触发器拒下";
    case "allowed":
      return "竟然放行了（真改了 " + r.changes + " 行）";
    case "matched_nothing":
      return "成功但【一行都没匹配到】，触发器压根没被触发";
    case "other_error":
      return "撞到别的错：" + r.message;
  }
}

/**
 * 写那条安全审计。8 列全绑（与 events/recorder.ts 的 INSERT_EVENT_SQL 同形状）——
 * 少绑一列在可空列上【不报错】只写 NULL，而审计库里那类错最贵。
 */
function writeProbeAudit(db: DatabaseSync, probedId: number): number {
  const at = Date.now();
  const info = db
    .prepare(
      "INSERT INTO events (task_id, actor_type, actor_id, action, target, payload, " +
        "state_snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      null,
      INTEGRITY_PROBE_ACTOR.actorType,
      INTEGRITY_PROBE_ACTOR.actorId,
      "unauthorized_attempt" satisfies AuditAction,
      String(probedId),
      JSON.stringify({
        kind: APPEND_ONLY_PROBE_KIND,
        probed_event_id: probedId,
        update_rejected: true,
        delete_rejected: true,
        probe_started_at_ms: at,
      }),
      JSON.stringify({ probed_event_id: probedId }),
      at,
    );
  return Number(info.lastInsertRowid);
}

/**
 * 探针抛错 ⇒ append_only 这一格判 could_not_run，其余各条照常。
 *
 * 探针确实会抛：rejectedByTrigger 撞到【非触发器】的错时是刻意抛的
 * （见那里的注释 —— "no such table" / "database is locked" 不能被读成「挡住了」）。
 * 那种抛错是重要信息，但它属于【这一格】，不该把整份报告一起带走。
 */
async function guardedProbe(writer: Writer): Promise<CheckResult> {
  try {
    return toCheck(await probeAppendOnly({ writer }));
  } catch (e) {
    return {
      name: "append_only",
      verdict: "could_not_run",
      detail:
        "append-only 探针【抛出来了】—— " +
        String(e).slice(0, 400) +
        "。这一格【没有结论】：既没说触发器在，也没说它不在。" +
        "最常见的两种成因是探针语句撞到了非触发器的错（见 rejectedByTrigger），" +
        "以及这份库连读都读不动。",
      checked: 0,
    };
  }
}

function toCheck(r: AppendOnlyProbeResult): CheckResult {
  return {
    name: "append_only",
    verdict: r.verdict,
    detail: r.detail,
    // 只有【压根没行可撞】才算「一行都没看」。撞了但没撞上触发器
    // （probe_reached_no_row）算看过一行 —— 它看了、并且看出了不对。
    checked: r.outcome === "no_row_to_probe" ? 0 : 1,
  };
}

/* ── ③ 回放确定性 ───────────────────────────────────────────────────── */

/** 进指纹的列。少一列就意味着「那一列不稳定也不会被发现」。 */
const FINGERPRINT_COLS = [
  "id",
  "action",
  "actor_type",
  "actor_id",
  "target",
  "payload",
  "state_snapshot",
  "created_at",
] as const;

/**
 * 一个任务的回放指纹：按 events.id 升序，把回放用到的列规范化后串起来取 sha256。
 *
 * 为什么不直接「调两次 buildReplayView 比返回值」：
 *  - buildReplayView 是分页的，两次调用可能拿到不同页而内容相同；
 *  - 它内部还有 payload 解析降级那一层，降级路径的输出不是字节。
 * 所以钉的是【指纹】。
 *
 * ⚠ 「两次指纹相同」是个【很容易恒真】的判据：指纹实现只要不看内容
 * （只算行数、或对同一个 db 缓存）就永远相等。所以 ③ 节配两发反向对照：
 * 换任务必须不同、同一任务再写一条之后必须不同。
 */
export function replayFingerprint(
  db: DatabaseSync,
  o: { readonly taskId: string; readonly limit?: number },
): { readonly fingerprint: string; readonly rows: number } {
  const limit = o.limit ?? 100_000;
  const rows = db
    .prepare(
      "SELECT id, action, actor_type, actor_id, target, payload, state_snapshot, created_at " +
        "FROM events WHERE task_id = ? ORDER BY id ASC LIMIT ?",
    )
    .all(o.taskId, limit) as Record<string, unknown>[];
  const h = createHash("sha256");
  for (const r of rows) {
    for (const col of FINGERPRINT_COLS) {
      const v = r[col];
      h.update(col + "=" + (v === null || v === undefined ? "∅" : String(v)) + ";");
    }
    h.update("\n");
  }
  return { fingerprint: h.digest("hex"), rows: rows.length };
}

/* ── ④ §22.4 审计自洽 ───────────────────────────────────────────────── */

export const DEFAULT_FTS_SAMPLE = 200;

export type CoherenceInput = {
  readonly db: DatabaseSync;
  /**
   * events_fts 一致性抽检行数。0 = 显式关掉（结论记 not_observable）。
   *
   * 为什么抽样而不是全表：这一条逐行发一次 MATCH，全表就是 N 次查询，
   * 而 §6.5 的量级是十万行。抽样能抓到「索引整体坏掉 / shadow 表没了 /
   * 索引停在旧版本」这些形态（实测：往索引里直写一次 delete，抽 200 行就点名那一行），
   * 代价是【单行漂移可能落在样本外】—— 这条口径写进 detail。
   */
  readonly ftsSample?: number;
};

/**
 * ④ 的全部规则。三条 not_observable 不是兜底文案，是实测的写入方状态
 * （review_gates / harness_calls 在 src 里零 INSERT，0016 §1 第 1 条 + 0018 §9）。
 */
export function auditCoherenceReport(o: CoherenceInput): readonly CheckResult[] {
  const sample = o.ftsSample ?? DEFAULT_FTS_SAMPLE;
  return [
    guarded("action_enum", () => actionEnumCheck(o.db)),
    guarded("state_machine_agrees_with_events", () => stateMachineAgreement(o.db)),
    guarded("gate_evidence_reference", () => gateEvidenceCheck(o.db)),
    guarded("harness_call_recorded", () => harnessCallCheck(o.db)),
    guarded("fts_index", () => ftsIndexCoherence(o.db, sample)),
  ];
}

/**
 * 一条规则抛错 ⇒ 该条判 could_not_run，其余规则照常出结论。
 *
 * 不加这层会发生什么（本轮实测到的形状）：一份截断到 60% 的库，
 * 页面检查已经如实报了 violated，紧接着自洽规则里第一条 SELECT 也抛，
 * 异常一路冲出 runIntegrityScan —— 于是【调用方拿到一个 rejection，一份报告都没有】。
 * 一个在损坏库上抛错的完整性检查，比没有检查更糟：它把「库坏了」这条信息
 * 伪装成「检查模块有 bug」，而收到 bug 的人下一步去做的是提 issue，不是去救库。
 *
 * 只捕这一层能捕的：SQLite 的抛错都是普通 Error。不捕 AbortError 之类
 * 调用方自己的取消信号 —— 所以判据是「抛了就报 could_not_run」，
 * 而不是「只报我认识的那几种错」。要取消请走 worker terminate。
 */
function guarded(name: CheckName, run: () => CheckResult): CheckResult {
  try {
    return run();
  } catch (e) {
    return {
      name,
      verdict: "could_not_run",
      detail:
        "这条规则【没能跑成】：查询抛了 —— " +
        String(e).slice(0, 400) +
        "。这不是「查出问题」，也不是「库里没有东西可查」：先修连接或库文件，" +
        "再读这一格。整个报告里其余各条仍然算数。",
      checked: 0,
    };
  }
}

/** events.action 必须全在 §22.1 那 10 个值里。 */
function actionEnumCheck(db: DatabaseSync): CheckResult {
  const name: CheckName = "action_enum";
  if (countEvents(db) === 0) {
    return {
      name,
      verdict: "not_observable",
      detail: "events 是空的，没有任何 action 可核。",
      checked: 0,
    };
  }
  const allowed = new Set<string>(AUDIT_ACTIONS);
  const rows = db
    .prepare("SELECT DISTINCT action FROM events")
    .all() as { action: string }[];
  const bad = rows.map((r) => r.action).filter((a) => !allowed.has(a));
  if (bad.length > 0) {
    return {
      name,
      verdict: "violated",
      detail:
        "出现了 §22.1 枚举之外的 action：" +
        bad.join(", ") +
        "。append-only 表里这一格【改不回来】，所以修法是登记进枚举、" +
        "或接受历史里有它，不是回头改数据 —— 改 events 要先把那两条触发器拆掉，" +
        "而那正是本文件守的东西。",
      checked: rows.length,
    };
  }
  return {
    name,
    verdict: "ok",
    detail: "全部 " + rows.length + " 种 action 都在 §22.1 那 10 个值里。",
    checked: rows.length,
  };
}

/**
 * 「每个状态变更都有对应事件」的可观测形式：
 * 有 state_change 事件的任务，其【最后一条 state_change 的 payload.to】
 * 必须等于 tasks.status。不等 ⇒ 有一侧写了、另一侧没写（§6.3 防的就是这个）。
 *
 * 为什么不做反向（「每个 status 变更都得有事件」的直接版）：
 * 任务创建时写 status 而【不写】state_change（创建不是一次跃迁，见
 * http/real-deps.ts 的 INSERT_TASK_SQL 与 events/recorder.ts 的 KIND_TO_ACTION），
 * 反向判会把每一次正常创建报成违规。所以「没有 state_change 的任务数」在 detail 里
 * 作为**事实**报出，不下违规结论。
 */
function stateMachineAgreement(db: DatabaseSync): CheckResult {
  const name: CheckName = "state_machine_agrees_with_events";
  const tasks = db
    .prepare("SELECT count(*) AS c FROM tasks")
    .get() as { c: number | bigint };
  if (Number(tasks.c) === 0) {
    return {
      name,
      verdict: "not_observable",
      detail: "tasks 是空的，状态机与事件日志的对账没有对象。",
      checked: 0,
    };
  }
  const rows = db
    .prepare(
      "SELECT t.id AS id, t.status AS status, " +
        "(SELECT e.payload FROM events e WHERE e.task_id = t.id AND e.action = 'state_change' " +
        "ORDER BY e.id DESC LIMIT 1) AS last_state_change " +
        "FROM tasks t",
    )
    .all() as { id: string; status: string; last_state_change: string | null }[];
  const mismatched: string[] = [];
  let withEvents = 0;
  for (const r of rows) {
    if (r.last_state_change === null) continue;
    withEvents++;
    let to: unknown;
    try {
      to = (JSON.parse(r.last_state_change) as Record<string, unknown>)["to"];
    } catch {
      mismatched.push(r.id + "（最后一条 state_change 的 payload 不是合法 JSON）");
      continue;
    }
    if (to !== r.status) {
      mismatched.push(
        r.id + "（事件说 " + String(to) + "，tasks.status 是 " + r.status + "）",
      );
    }
  }
  const without = rows.length - withEvents;
  if (mismatched.length > 0) {
    return {
      name,
      verdict: "violated",
      detail:
        withEvents +
        " 个任务有 state_change 事件，其中 " +
        mismatched.length +
        " 个的最后一条与 tasks.status 不一致：" +
        mismatched.slice(0, 5).join(" ; ") +
        "。要么状态改了没写事件，要么写了事件没改表 —— 两种都是 §6.3 说的" +
        "「状态变了但没日志」。",
      checked: withEvents,
    };
  }
  return {
    name,
    verdict: withEvents === 0 ? "not_observable" : "ok",
    detail:
      withEvents === 0
        ? "库里有 " +
          rows.length +
          " 个任务，而其中【没有任何一个】有 state_change 事件 —— 对账【没有发生过】，" +
          "不是通过。（图没接进生产路径时就是这个形状，见 0017 §1 第 1 条）"
        : withEvents +
          " 个任务对账一致；另有 " +
          without +
          " 个任务没有 state_change 事件（任务创建不是一次状态跃迁，那不是违规，" +
          "但那一类任务的 status 此刻【无从对账】）。",
    checked: withEvents,
  };
}

/** §22.4 第 2 句：每个门控决定都有对应证据包引用。 */
function gateEvidenceCheck(db: DatabaseSync): CheckResult {
  const name: CheckName = "gate_evidence_reference";
  const missing = missingTables(db, ["review_gates", "evidence_bundles"]);
  if (missing.length > 0) {
    return {
      name,
      verdict: "not_observable",
      detail: "这些表不在这一份库里：" + missing.join(", ") + "（未跑过迁移？）。",
      checked: 0,
    };
  }
  const gates = db
    .prepare("SELECT count(*) AS c FROM review_gates")
    .get() as { c: number | bigint };
  if (Number(gates.c) === 0) {
    return {
      name,
      verdict: "not_observable",
      detail:
        "review_gates 是空的。src 里【没有任何 INSERT INTO review_gates】" +
        "（0016 §1 第 1 条复算过），所以「每个门控决定都有证据包引用」在生产运行期" +
        "【无从校验】。不是通过。",
      checked: 0,
    };
  }
  const rows = db
    .prepare(
      "SELECT g.id AS id, g.evidence_bundle_id AS ev, " +
        "(SELECT count(*) FROM evidence_bundles b WHERE b.id = g.evidence_bundle_id) AS found " +
        "FROM review_gates g",
    )
    .all() as { id: string; ev: string | null; found: number | bigint }[];
  const bad = rows.filter(
    (r) => r.ev === null || r.ev === "" || Number(r.found) === 0,
  );
  if (bad.length > 0) {
    return {
      name,
      verdict: "violated",
      detail:
        bad.length +
        " / " +
        rows.length +
        " 条门控决定没有可解析的证据包引用（前几条：" +
        bad.slice(0, 5).map((r) => r.id + "→" + String(r.ev)).join(", ") +
        "）。§22.4 要求每个门控决定都有证据；没有引用的那一行事后无法复核，" +
        "而审阅共谋（§24 风险 1）正是靠这些引用才能被分析。",
      checked: rows.length,
    };
  }
  return {
    name,
    verdict: "ok",
    detail: rows.length + " 条门控决定都有指向 evidence_bundles 的引用。",
    checked: rows.length,
  };
}

/** §22.4 第 3 句：每条 harness 调用都有对应消耗记录。 */
function harnessCallCheck(db: DatabaseSync): CheckResult {
  const name: CheckName = "harness_call_recorded";
  const missing = missingTables(db, ["harness_calls", "budget_events"]);
  if (missing.length > 0) {
    return {
      name,
      verdict: "not_observable",
      detail: "这些表不在这一份库里：" + missing.join(", ") + "。",
      checked: 0,
    };
  }
  const calls = db
    .prepare("SELECT count(*) AS c FROM harness_calls")
    .get() as { c: number | bigint };
  if (Number(calls.c) === 0) {
    return {
      name,
      verdict: "not_observable",
      detail:
        "harness_calls 是空的（src 里零 INSERT，0018 §9 复算）。" +
        "「每条 harness 调用都有对应消耗记录」这一条【没有对象】。不是通过。",
      checked: 0,
    };
  }
  const rows = db
    .prepare(
      "SELECT h.id AS id, h.task_id AS task_id, h.cost_cents AS cost, " +
        "(SELECT count(*) FROM budget_events b WHERE h.task_id IS NOT NULL " +
        " AND b.task_id = h.task_id) AS budget_rows " +
        "FROM harness_calls h",
    )
    .all() as { id: string; task_id: string | null; cost: number | bigint | null; budget_rows: number | bigint }[];
  const unrecorded = rows.filter(
    (r) => Number(r.cost ?? 0) > 0 && Number(r.budget_rows) === 0,
  );
  if (unrecorded.length > 0) {
    return {
      name,
      verdict: "violated",
      detail:
        unrecorded.length +
        " / " +
        rows.length +
        " 条 harness 调用有花费但那个任务在 budget_events 里【一行都没有】：" +
        unrecorded.slice(0, 5).map((r) => r.id).join(", ") +
        "。花掉的钱没进预算账，预算突破就不会被触发（§9 那一整条防线）。",
      checked: rows.length,
    };
  }
  return {
    name,
    verdict: "ok",
    detail:
      rows.length +
      " 条 harness 调用，凡有花费的那几条评论上都能在 budget_events 里找到对应任务行。",
    checked: rows.length,
  };
}

function missingTables(db: DatabaseSync, names: readonly string[]): string[] {
  const q = db.prepare(
    "SELECT count(*) AS c FROM sqlite_master WHERE type = 'table' AND name = ?",
  );
  return names.filter((n) => {
    const r = q.get(n) as { c: number | bigint };
    return Number(r.c) === 0;
  });
}

/**
 * events_fts 与 events 的一致性抽检。
 *
 * 判据形状来自实测（0018 §1 第 8 条）：用 `INSERT INTO events_fts … 'delete'`
 * 造出的分叉，【PRAGMA integrity_check 报 ok、events_fts('integrity-check') 也报 ok】
 * —— SQLite 自带的两把完整性尺子都量不出 external-content 表与内容表的漂移。
 * 只能自己做：对每一行，从它【自己的】payload 里取一段 trigram，问索引「你还在吗」。
 * 用自己那一段是关键：用固定关键词搜全表，坏掉的索引照样命中别的行，于是永远「一致」。
 */
export function ftsIndexCoherence(
  db: DatabaseSync,
  sample: number,
): CheckResult {
  const name: CheckName = "fts_index";
  const hasFts = db
    .prepare("SELECT count(*) AS c FROM sqlite_master WHERE name = 'events_fts'")
    .get() as { c: number | bigint };
  if (Number(hasFts.c) === 0) {
    return {
      name,
      verdict: "not_observable",
      detail: "这份库里没有 events_fts（未跑迁移，或被删过）。检索一致性无从检查。",
      checked: 0,
    };
  }
  if (sample <= 0) {
    return {
      name,
      verdict: "not_observable",
      detail: "ftsSample <= 0，这一条被显式关掉。不是通过。",
      checked: 0,
    };
  }
  const rows = db
    .prepare("SELECT id, payload FROM events ORDER BY id LIMIT ?")
    .all(sample) as { id: number | bigint; payload: string }[];
  if (rows.length === 0) {
    return {
      name,
      verdict: "not_observable",
      detail: "events 是空的，索引没有可对照的行。",
      checked: 0,
    };
  }
  const hits = db.prepare(
    "SELECT rowid AS rid FROM events_fts WHERE events_fts MATCH ?",
  );
  const missing: number[] = [];
  let scanned = 0;
  for (const r of rows) {
    const tri = trigramOf(String(r.payload), Number(r.id));
    if (tri === null) continue;
    scanned++;
    const ids = hits.all('"' + tri.replaceAll('"', '""') + '"') as {
      rid: number | bigint;
    }[];
    if (!ids.some((x) => Number(x.rid) === Number(r.id))) missing.push(Number(r.id));
  }
  if (scanned === 0) {
    return {
      name,
      verdict: "not_observable",
      detail:
        "抽到的 " +
        rows.length +
        " 行 payload 全都短于 5 个码位，取不出一段 trigram。" +
        "这一条【没有跑成】，不是通过。",
      checked: 0,
    };
  }
  if (missing.length > 0) {
    return {
      name,
      verdict: "violated",
      detail:
        "索引里找不到这些事件行：" +
        missing.slice(0, 10).join(", ") +
        "（抽了 " +
        scanned +
        " 行）。events_fts 与 events 已分叉：检索会【静默少结果】—— " +
        "回放搜索报「没有相关事件」而真相是命中行不在索引里。" +
        "重建口径见 scripts/rebuild-fts.md。",
      checked: scanned,
    };
  }
  return {
    name,
    verdict: "ok",
    detail:
      "抽 " +
      scanned +
      " 行，每行用自己 payload 的一段 trigram 回查索引，全部命中。" +
      "（口径：抽样，单行漂移可能落在样本外）",
    checked: scanned,
  };
}

/**
 * 取一行 payload 的一段 trigram；取不出返回 null（这一行跳过）。
 *
 * 【窗口按行 id 错开】而不是固定取某一段，理由实测过（见上面区分度自检那段）：
 * 本仓 payload 是 JSON，键名在行与行之间一样，所以固定偏移取到的片段
 * 在所有行里【是同一段】—— 那会让本条检查退化成「索引里有没有这一段」，
 * 坏掉的索引命中别的行照样报 ok。第一版就是固定取 `[2,5)`，文件头还写着
 * 「避开 `{"` 前缀」就完事了；避开前缀不等于避开【所有行都一样的那一段】。
 *
 * 按 id 错开是伪随机但【确定性】的：同一个库两次跑取到的窗口一样，
 * 于是这一条检查的输出可复现（Task 6.5 那一周要巡检这一条）。
 * 从下标 2 起步仍然保留：`{"` 那两段没有信息量。
 *
 * ⚠ 这一层【不是】本条检查成立的唯一理由，实测过：200 行 payload 完全一样的库里
 * 人为删掉索引里第 57 行，本条照样点名 57（见 integrity.test.ts ⑤）。因为命中判定
 * 问的是「这一行的 rowid 在不在结果里」，不是「结果非空」。
 * 本节曾经加过一道「样本里探针片段重复过半就判 not_observable」的【区分度自检】，
 * 那次实测把它证伪了 —— 归属判定已经堵住了那个洞，多出来的那道判据只会把
 * 一份【正常】的整齐数据报告搅成 not_observable。删之。
 */
/**
 * 「这份库的【页面】坏了」的唯一判据。
 *
 * 提出来成函数之前，它两行内联在 heartbeat/maintenance.ts 里，只有备份那一处用。
 * 提出来不是因为复用方便（复用只是表象），是因为**第二个使用者的方向相反**：
 * 备份那处的用法是「不过 ⇒ 别写备份」，而 `pnpm hub:serve` 启动那处的用法是
 * 「不过 ⇒ 拒绝启动」。两处各写一份的话，改一处就会得到
 * 「备份拦住了而 Hub 照样带伤起来」—— 两边各自都自洽、各自都绿。
 * 与 0022 §3 为 `preventionFor`、0024 §3 为 `isExternalSourceRef` 写的理由同一条。
 *
 * 判据只看 page_integrity 那一条，**不看整份报告的 ok**。这不是宽松，是量出来的：
 * `ok` 会被 `could_not_run` 与 `not_observable` 拉下来（实测：一个没有任何门控决定
 * 的合法新库，因为「没有 gate_decision 可核」而 ok = false）。
 * 用 ok 当启动闸会【把一大半真实启动挡在门外】，而拦下的理由与「文件坏了」毫无关系 ——
 * 「没有东西可核」与「库损坏」是两件事，后者绝不该拦启动，前者绝不该放行损坏。
 *
 * `verdict === "not_observable"` / `"could_not_run"` 都【不算】损坏：
 * 那两格说的是「这条判据没跑成」。据此拒绝启动，等于让一次 worker 起不来
 * 变成整台机器不可用；而它该做的（响一声、指路）由调用方在别处做。
 */
export function pageIntegrityBroken(report: Pick<IntegrityReport, "checks">): boolean {
  const page = report.checks.find((c) => c.name === "page_integrity");
  return page !== undefined && page.verdict === "violated";
}

function trigramOf(payload: string, id: number): string | null {
  const chars = [...payload];
  if (chars.length < 5) return null;
  const span = chars.length - 2 - 3 + 1; // 可选起点个数
  if (span <= 1) {
    const tri = chars.slice(2, 5).join("");
    return [...tri].length === 3 ? tri : null;
  }
  const offset = 2 + (Math.abs(Number.isFinite(id) ? id : 0) % span);
  const tri = chars.slice(offset, offset + 3).join("");
  return [...tri].length === 3 ? tri : null;
}


