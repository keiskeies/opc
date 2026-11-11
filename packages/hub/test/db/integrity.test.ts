/**
 * Task 6.2　完整性检查（src/db/integrity.ts + integrity.worker.ts + page-check.ts）。
 *
 * ── 这一文件在证什么 ──────────────────────────────────────────────────
 * 计划 Task 6.2 的验收原文两条：
 *   ①「integrity_check 不得在主线程 / UI 进程执行」→ ① 节
 *   ②「检查结果写入审计并可在 /integrity 读出」→ 路由那半截在 http 层，本文件只管
 *     【探针真的写了审计】这一半（④ 节），路由接线由 http 那边的测试覆盖。
 * 规格 §22.4 那三句审计自洽 → ⑤ 节。
 *
 * ── 本文件最重要的一件事：每一条 ok 都配一发反向对照 ──────────────────
 * 完整性检查是最容易写出【恒真】的那类代码：判据不看内容（只数行数）、
 * 探针没真撞（SQL 参数少绑一个）、抽样对所有行问同一个问题 —— 三种都恒绿。
 * 0006 §7 第 55、56 条量的就是「守卫自己没被守卫过」。所以这里每一格 ok
 * 后面都跟一发【必须变红】的对照，并且那一发也写成了断言。
 *
 * ── 四种结论，本文件把四种都造出来过（这是 ⑥ 节存在的理由）──────────
 *  ok / violated / not_observable / could_not_run。
 * 后两种分开是因为实测：`DROP TABLE events` 而留着 external-content 的 events_fts
 * 之后，`PRAGMA integrity_check` 仍然报 "ok"，而自洽规则的每一条 SELECT 都抛
 * "no such table"。那不是「库里没东西可查」（not_observable 的常态），
 * 也不是「某一行有问题」（violated）—— 是【尺子放不下去】。
 *
 * ── 夹具用真迁移库 ───────────────────────────────────────────────────
 * 与 backup.test.ts 同一条理由：这里要验的东西（触发器、FTS、外键）
 * 全是【真 schema 的行为】，手搓表会让检查项对着一个不存在的世界给出漂亮结论。
 */
import { mkdirSync, rmSync, copyFileSync, openSync, ftruncateSync, fstatSync, closeSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureTmp } from "../fixtures/fixture-dir.js";
import { openDb } from "../../src/db/driver.js";
import { openSnapshotReadonlyDb } from "../../src/db/pragmas.js";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import {
  APPEND_ONLY_PROBE_KIND,
  CHECK_NAMES,
  CHECK_VERDICTS,
  INTEGRITY_PROBE_ACTOR,
  auditCoherenceReport,
  pageIntegrityBroken,
  probeAppendOnly,
  replayFingerprint,
  runIntegrityScan,
  type CheckResult,
} from "../../src/db/integrity.js";
import { isPageOk, reportText } from "../../src/db/page-check.js";

const HUB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TMP = fixtureTmp("integrity", import.meta.url);

const opened: { close(): void }[] = [];
let seq = 0;

/** 跑过迁移、带 N 条事件的库。 */
function migratedDb(events: number): { path: string; db: ReturnType<typeof openDb> } {
  const path = join(TMP, "ig-" + process.pid + "-" + ++seq + ".db");
  const db = openDb(path);
  opened.push(db);
  migrate(db as never);
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
      "VALUES ('T-1', '完整性夹具', 'IN_PROGRESS', 'dev', 'implement', ?, ?)",
  ).run(1_700_000_000_000, 1_700_000_000_000);
  insertEvents(db, events, "T-1");
  return { path, db };
}

/**
 * payload 必须【每行都不同】。这一句是夹具的要点而不是装饰：
 * fts_index 那条要量【区分度】，同模板整齐 payload 会让整批样本的探针片段撞在一起，
 * 于是检查自己判 not_observable（⑤ 节有一条专门用整齐 payload 测这件事）。
 */
function insertEvents(
  db: ReturnType<typeof openDb>,
  n: number,
  taskId: string,
  startAt = 0,
  status = "IN_PROGRESS",
): void {
  const ins = db.prepare(
    "INSERT INTO events (task_id, actor_type, actor_id, action, payload, state_snapshot, created_at) " +
      "VALUES (?, 'system', 'hub', 'state_change', ?, '{}', ?)",
  );
  for (let i = startAt; i < startAt + n; i++) {
    ins.run(
      taskId,
      JSON.stringify({ i, to: status, note: "第" + i + "号事件的独有正文" + i }),
      1_700_000_000_000 + i,
    );
  }
}

/**
 * 把 append-only 与它的 FTS 同步触发器一起拆掉。
 * 拆【四条】而不是两条是实测出来的（0018 §1 第 12 条）：events_fts_au 活着时
 * UPDATE events 会以一个光秃秃的 "SQL logic error" 失败，看起来像别的错。
 */
function stripAppendOnly(db: ReturnType<typeof openDb>): void {
  for (const t of [
    "events_no_update",
    "events_no_delete",
    "events_fts_au",
    "events_fts_ad",
  ]) {
    db.exec("DROP TRIGGER " + t);
  }
}

function countRows(db: ReturnType<typeof openDb>, table: string): number {
  const row = db.prepare("SELECT count(*) AS c FROM " + table).get() as {
    c: number | bigint;
  };
  return Number(row.c);
}

function resultByName(checks: readonly CheckResult[], name: string): CheckResult {
  const hit = checks.find((c) => c.name === name);
  if (hit === undefined) throw new Error("报告里没有这一条：" + name);
  return hit;
}

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  for (const c of opened) {
    try {
      c.close();
    } catch {
      /* 已经关了 */
    }
  }
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 留给下次 */
  }
});

describe("① 页面检查必须离开主线程（Task 6.2 的验收原文）", () => {
  it("默认路径走 worker：报告里 via = worker，且扫描期间主线程仍在推进", async () => {
    /*
     * 【怎么测「没冻结」】。不看代码形状（「是不是 new Worker」），那样改了实现就测不到。
     * 做法：主线程挂一个 1ms 的 setInterval，await 期间数它跑了多少次。
     * 上一轮我在 backup.test.ts 里对【同步】的 createBackup 写过同一条断言，
     * 那次它【永远不可能 > 0】—— 同步调用期间定时器本来就不该跑，断言恒假。
     * 这一发不同：runIntegrityScan 是 async 且真的把判据交给另一个线程，
     * 所以「定时器在扫描期间持续推进」是一个【能红的】判据。
     *
     * 库要够大才测得到：实测 13 万事件时 integrity_check 在主线程要 341ms
     * （20 万 543ms，2 万 51ms，见 0018 §1 第 10 条）。13 万用倍数扩张 1.1 秒造出来。
     * 这个规模不是随手取的：§6.5 的量级估算是十万任务，2–4GB。
     */
    const { path, db } = migratedDb(4_000);
    // 只能【INSERT】。第一版先 UPDATE 一行去撑大 payload，当场被自家触发器拒下 ——
    // 一个测「完整性检查不冻结主线程」的夹具死在 append-only 上，这个错值得留着记：
    // 在这套 schema 里，任何「改一下已有行」的夹具写法都是错的，没有例外。
    //
    // 5 次翻倍 = 4000 × 32 = 128_000 行。这里要有个数量级自觉：翻倍是【指数】，
    // 上一版手滑写了 15 次，那是 4000 × 32768 = 1.3 亿行，直接把测试跑到天荒地老。
    for (let k = 0; k < 5; k++) {
      db.exec(
        "INSERT INTO events (task_id, actor_type, actor_id, action, payload, state_snapshot, created_at) " +
          "SELECT task_id, actor_type, actor_id, action, " +
          "json_set(payload, '$.pad', '撑大页面规模的一串文本，' || id), '{}', created_at + id FROM events",
      );
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const rows = Number(
      (db.prepare("SELECT count(*) AS c FROM events").get() as { c: number | bigint }).c,
    );
    expect(rows).toBeGreaterThan(100_000);

    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 1);
    const q = new WriteQueue(path);
    try {
      const scan = runIntegrityScan({ dbPath: path, db: q.readConnection() });
      // 扫描期间照常排写入。这条比定时器更硬：它证的是【Hub 还能干活】，
      // 而 Hub 的活就是写审计。
      const wrote = q.tx([
        [
          // 用 tool_call 而不是 state_change：state_change 的 payload 带 to 才算对账一致，
          // 这里只是要证「扫描期间还能写审计」，不想顺手改掉状态机的结论。
          "INSERT INTO events (task_id, actor_type, actor_id, action, payload, state_snapshot, created_at) " +
            "VALUES ('T-1','system','hub','tool_call','{\"during\":\"scan\"}','{}',?)",
          [1_750_000_000_000],
        ],
      ]);
      const res = await scan;
      await wrote;
      clearInterval(timer);

      expect(res.via).toBe("worker");
      expect(res.ok).toBe(true);
      // 反向对照之一：若判据其实跑在主线程上，这里 ticks 会是 0（同步扫描期间
      // 定时器不可能推进），这一发就红。
      expect(ticks, "扫描期间主线程定时器一次都没推进 ⇒ 判据多半还在主线程上").toBeGreaterThan(0);
      // 反向对照之二：若扫描占了写队列，这条 INSERT 会失败或排在扫描之后。
      const during = await q.read(
        "SELECT count(*) AS c FROM events WHERE json_extract(payload, '$.during') = 'scan'",
      );
      expect(Number((during[0] as { c: number | bigint }).c)).toBe(1);
    } finally {
      clearInterval(timer);
      await q.close();
    }
  });

  it("worker 与主线程【判据同源】：同一个库两侧结论一致，字段一致", async () => {
    const { path, db } = migratedDb(30);
    const q = new WriteQueue(path);
    try {
      const viaWorker = await runIntegrityScan({ dbPath: path, db: q.readConnection() });
      const viaMain = await runIntegrityScan({
        dbPath: path,
        db: q.readConnection(),
        onMainThread: true,
      });
      expect(viaWorker.via).toBe("worker");
      // onMainThread 必须是【显式】才生效，且报告里诚实写下它走了主线程。
      expect(viaMain.via).toBe("main_thread");
      expect(viaWorker.ok).toBe(viaMain.ok);
      expect(viaWorker.pageReport).toBe(viaMain.pageReport);
      expect(viaWorker.checks.map((c) => c.name)).toEqual(viaMain.checks.map((c) => c.name));
      // 字段集合一致：worker 那边是手写的一份类型（模块图要小），
      // 没有这发断言，两侧字段可以各自演化而谁都不报错。
      const keysOf = (r: object): string[] => Object.keys(r).sort();
      expect(keysOf(viaWorker)).toEqual(keysOf(viaMain));
      expect(viaWorker.dbPath).toBe(path);
      expect(db).toBeDefined();
    } finally {
      q.close();
    }
  });

  it("worker 起不来时报 unavailable，【不】自动退回主线程", async () => {
    /*
     * 这一发测的是【没有静默兜底】。worker 失败时自动改走主线程扫描，
     * 等于在「环境坏了」这一刻悄悄违反验收 —— 而报告里看起来完全正常。
     * 造不出「worker 入口不存在」（入口由 import.meta.url 推导，恒存在），
     * 所以这里测的是可达的那一半：一个【不存在的路径】交给 worker。
     */
    const { db } = migratedDb(3);
    const missing = join(TMP, "这份文件不存在-" + ++seq + ".db");
    expect(existsSync(missing)).toBe(false);
    const res = await runIntegrityScan({ dbPath: missing, db, timeoutMs: 5_000 });
    expect(res.via).toBe("worker");
    expect(res.ok).toBe(false);
    // 关键是【没有】变成 main_thread。
    expect(res.via).not.toBe("main_thread");
    expect(resultByName(res.checks, "page_integrity").verdict).toBe("violated");
  });

  it("超时按失败处理，而不是按「没查出问题」处理", async () => {
    const { path, db } = migratedDb(200);
    const res = await runIntegrityScan({ dbPath: path, db, timeoutMs: 0 });
    expect(res.ok).toBe(false);
    expect(res.unavailable).toBe("worker_timeout");
    // 反向对照：unavailable 的报告不能同时是 ok。
    expect(res.ok).toBe(false);
    /*
     * ⚠ 0038 改了这一发的结论：原本断 `violated`，而那是本篇那个缺陷的形状 ——
     * 「检查没跑成」和「查出损坏」共用一个词，于是 pageIntegrityBroken 在这里返回 true，
     * `pnpm hub:serve` 会【拒绝启动】并把人指向 restore.md（第 3 步：覆盖现网库）。
     * 一台库完全健康的机器不该因为一次 worker 超时被引导去覆盖自己的库。
     * 现在这一格是 could_not_run（本模块既有词汇），它：
     *  · 仍然拉下 res.ok（上面那两条断言不变 ⇒ 「没跑成不算通过」这条验收一字未改）；
     *  · 【不】再拉启动闸门（下面那条 pageIntegrityBroken === false 就是这个取舍的锁）。
     * ⚠ 别把它读成「超时不再算失败了」：失败仍然失败，只是失败的【修法】不同 ——
     *   violated 的修法是恢复数据，could_not_run 的修法是修这台机器上的检查通路。
     */
    const page = resultByName(res.checks, "page_integrity");
    expect(page.verdict).toBe("could_not_run");
    // 这一发是本节改动的【落点】：闸门必须放开，而它只可能因为 verdict 变了才放开。
    expect(pageIntegrityBroken(res)).toBe(false);
    // 而且它得【响一声】—— 见 assemble.ts / maintenance.ts 各自那发接线用例。
    // 这里断 checked：仪器故障时它是 0（一次都没查），不能长得像「查过一条并报出问题」。
    expect(page.checked).toBe(0);
  });

  it("⭐ 仪器故障（worker_timeout）⇒ could_not_run 且不拉闸门；真损坏【仍然】拉", async () => {
    /*
     * 这一发要钉的是 0038 那条映射【两个方向】都成立：
     *  · 仪器故障（这里造得出的是 worker_timeout）⇒ could_not_run，拉下 ok 但【不】拉闸门；
     *  · 真损坏 ⇒ 仍然是 violated，闸门【照拉】。
     * 两个方向必须写在同一发里，否则「把闸门改成永远 false」能绿掉其中一半 ——
     * 而那一半恰恰是本篇改动的落点。
     *
     * ⚠ INTEGRITY_FAILURES 那三种（worker_unavailable / worker_timeout / worker_error）
     *   这一发【只造得出 timeout 一种】，别把它读成「三种都验过了」：
     *    · worker_error：只能来自 worker 的 error 事件（加载期失败），而入口恒存在 ⇒ 造不出。
     *    · worker_unavailable：new Worker 构造期抛，而入口由 import.meta.url 推出、恒在 ⇒ 造不出
     *      （0036 §7 那条「worker_unavailable 那一支没有用例」的登记仍然有效）。
     *    · 把 dbPath 指向【打不开的东西】（不存在的文件 / 一个目录）不是这两支 ——
     *      worker 起得来、是它开库时抛，而它自带 try/catch ⇒ 回一条 ok:false 的消息、
     *      unavailable 是 undefined ⇒ 那走的是 violated（见下面专门那一发），不是仪器故障。
     *   ⇒ 三条共用的是【同一段映射代码】（pageCheckCell 里 `unavailable !== undefined`
     *     那一个判断），timeout 打中它 = 那一段被执行过；剩下两条是【够不到那段代码的上游】，
     *     不是映射没测到。区别记在这里，免得将来有人以为「补个 unavailable 的用例」能变严。
     */
    const { path, db } = migratedDb(50);
    const res = await runIntegrityScan({ dbPath: path, db, timeoutMs: 0 });
    expect(res.unavailable).toBe("worker_timeout");
    expect(resultByName(res.checks, "page_integrity").verdict).toBe("could_not_run");
    expect(pageIntegrityBroken(res)).toBe(false);
    expect(res.ok).toBe(false);

    // 反向对照（⭐ 这一发才是「不是恒绿」的证据）：同一份检查在【真损坏】的库上
    // 必须【仍然】判 violated 并拉闸门。少了这一发，上面那两条可以靠
    // 「把 pageIntegrityBroken 改成永远 false」蒙绿。
    // 夹具用本文件自己那套【截断】写法（下面那发大的也用它），不新抄一份
    // corruptWholePages —— maintenance.test.ts 与 assemble.test.ts 各已有一份，
    // 再加第三份就是本篇正在修的那个形状（同一判据写多处）。
    // ⚠ 行数必须是【千级】：我第一版用上面那份 50 行的库截一半，
    //   integrity_check 回的是 "ok" —— 截掉的那一半没有引用页，
    //   于是这一发会变成一条「夹具根本没坏」的恒绿。那正是 0018 §1 第 11 条
    //   与本页多条夹具反复撞的那格：造损坏要造到【尺子真的落不下去】为止。
    const many = migratedDb(3_000);
    const broken = join(TMP, "损坏-" + ++seq + ".db");
    copyFileSync(many.path, broken);
    const fd = openSync(broken, "r+");
    ftruncateSync(fd, Math.floor(fstatSync(fd).size * 0.5));
    closeSync(fd);
    const r2 = await runIntegrityScan({ dbPath: broken, db, timeoutMs: 10_000 });
    expect(r2.unavailable, "损坏库上的检查必须【跑成】，否则这一发测的是别的东西").toBeUndefined();
    expect(resultByName(r2.checks, "page_integrity").verdict).toBe("violated");
    expect(pageIntegrityBroken(r2)).toBe(true);
    expect(resultByName(r2.checks, "page_integrity").checked).toBe(1);
  });

  it("库开不了（worker 起来了而它读不动这份库）⇒ 仍是 violated，不是仪器故障", async () => {
    /*
     * 这一发守的是映射【另一侧】的界线，而它最容易被改错：
     * integrity.worker.ts 自带 try/catch，开库抛错会变成一条 ok:false 的【消息】
     * 回主线程 ⇒ 主线程看到的 unavailable 是 undefined，判据【跑成了】，
     * 它的结论是「这份库我读不动」⇒ 那是被检查对象的结论，走 violated。
     * 如果哪天有人「顺手」把这条也改成 could_not_run，启动闸门就再也不拦损坏库了。
     */
    const { db } = migratedDb(5);
    const dirPath = join(TMP, "这是个目录-" + ++seq);
    mkdirSync(dirPath);
    const res = await runIntegrityScan({ dbPath: dirPath, db, timeoutMs: 10_000 });
    expect(res.via).toBe("worker");
    expect(res.unavailable, "worker 自己 catch 掉的抛错不是仪器故障").toBeUndefined();
    expect(resultByName(res.checks, "page_integrity").verdict).toBe("violated");
    expect(pageIntegrityBroken(res)).toBe(true);
    expect(resultByName(res.checks, "page_integrity").checked).toBe(1);
  });
});

describe("② 页面判据本身（page-check.ts，两侧共用那一份）", () => {
  it("健康库：恰一行且为 ok", async () => {
    const { path } = migratedDb(20);
    const ro = openSnapshotReadonlyDb(path);
    try {
      const rows = ro.prepare("PRAGMA integrity_check").all() as Record<string, string>[];
      expect(rows).toHaveLength(1);
      expect(isPageOk(rows)).toBe(true);
      expect(reportText(rows)).toBe("ok");
    } finally {
      ro.close();
    }
  });

  it("「包含 ok」不算通过：多行诊断必须判失败", () => {
    // 这是判据的单测，不是 SQLite 的行为测试 —— 损坏库返回什么由 SQLite 决定，
    // 而【我怎么解读它】是我的判据。所以直接喂行。
    const corrupt = [{ integrity_check: "*** in database main ***" }, { integrity_check: "Tree 2 page 4: looks ok-ish" }];
    expect(isPageOk(corrupt)).toBe(false);
    expect(reportText(corrupt)).toContain("in database main");
    // 反向对照：同一份数据里【确实含有】子串 "ok"，
    // 所以「用 includes 判」会放过去 —— 这一发就是那条错的判据的反例。
    expect(reportText(corrupt)).toContain("ok");
    expect(isPageOk([{ integrity_check: "ok" }, { integrity_check: "ok" }])).toBe(false);
    expect(isPageOk([])).toBe(false);
  });

  it("主线程那一支【捕获】PRAGMA 的抛错：损坏库要出报告，不是出一个 rejection", async () => {
    /*
     * 实测（0018 §1 第 11 条）：只读连接上对一份截断的库跑 integrity_check
     * 不是返回多行诊断，而是【直接抛】"database disk image is malformed"。
     * 原本主线程那一支没有 try/catch，于是 runIntegrityScan({onMainThread:true})
     * 在损坏库上整体 reject —— 调用方拿到的 rejection 与「我 SQL 写错了」同形，
     * 而它其实是在喊「这份库坏了，先去救库」。
     * 这一发就是这个回归的锁：断言 await【不】抛，且 page_integrity 判 violated。
     */
    const { path } = migratedDb(3_000);
    const cut = join(TMP, "截断-" + ++seq + ".db");
    copyFileSync(path, cut);
    const fd = openSync(cut, "r+");
    ftruncateSync(fd, Math.floor(fstatSync(fd).size * 0.5));
    closeSync(fd);

    // 先确认真的坏到「连打开都抛」—— 否则这一发测不到捕获。
    let openThrows = false;
    try {
      const x = openSnapshotReadonlyDb(cut);
      x.close();
    } catch {
      openThrows = true;
    }
    expect(openThrows, "夹具没造出「打不开」的库，这一发测不到捕获").toBe(true);

    // 默认那一支【不抛】—— 第一版我在这里断言 rejects，写反了：
    // 打不开的是 dbPath 指的【文件】，而文件是 worker 去开的，worker 自带 try/catch
    // （它文件头第 3 条：一条坏消息胜过一条消息都不发）。所以默认路径本来就出报告。
    // 抄下真实形状：ok:false + unavailable = worker_error。
    const healthy = openSnapshotReadonlyDb(path);
    opened.push(healthy);
    const viaWorker = await runIntegrityScan({ dbPath: cut, db: healthy });
    expect(viaWorker.ok).toBe(false);
    expect(viaWorker.via).toBe("worker");
    // unavailable 是【没有】值的，这一句把这条界线钉住：
    // unavailable 说的是【判据自己坏了】（起不来 / 超时 / worker 崩了）。
    // 而这里判据【跑成了】，它跑出来的是「这份库我读不动」——
    // 那是本次检查的【结论】，走 violated 那条路，不是仪器故障。
    // （worker_error 只会来自 worker 的 error 事件，即加载失败那种。）
    expect(viaWorker.unavailable).toBeUndefined();
    expect(resultByName(viaWorker.checks, "page_integrity").detail).toContain("malformed");
    expect(resultByName(viaWorker.checks, "page_integrity").verdict).toBe("violated");

    // 而【主线程这一支 + 连接已经开着、文件随后被截断】也必须出报告。
    // 这就是 P1 形态：Hub 跑着，另一个进程（同步盘 / 误操作的 cp）把文件截了。
    const live = openSnapshotReadonlyDb(path);
    opened.push(live);
    const victim = join(TMP, "底切-" + ++seq + ".db");
    copyFileSync(path, victim);
    const live2 = openSnapshotReadonlyDb(victim);
    const fd2 = openSync(victim, "r+");
    ftruncateSync(fd2, Math.floor(fstatSync(fd2).size * 0.5));
    closeSync(fd2);
    try {
      const res = await runIntegrityScan({
        dbPath: victim,
        db: live2,
        onMainThread: true,
      });
      expect(res.ok).toBe(false);
      // 不是「检查自己坏了」：坏的是库，所以走 violated 而不是 unavailable。
      expect(res.unavailable).toBeUndefined();
      expect(resultByName(res.checks, "page_integrity").verdict).toBe("violated");
      expect(resultByName(res.checks, "page_integrity").detail).toContain("直接抛错");
    } finally {
      live2.close();
      live.close();
    }
  });
});

describe("③ 回放确定性", () => {
  it("同一任务两次指纹相同 —— 并且这条判据【不是恒真】", () => {
    const { db } = migratedDb(40);
    const a = replayFingerprint(db, { taskId: "T-1" });
    const b = replayFingerprint(db, { taskId: "T-1" });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.rows).toBe(40);

    /*
     * 反向对照两条。少了它们，「两次相等」这个判据在指纹实现退化成
     * 「只数行数」或「按 db 缓存」时【永远成立】—— 那才是本节最怕的形状。
     */
    // 1) 换任务 ⇒ 必须不同。空任务与满任务的指纹不能一样。
    db.prepare(
      "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
        "VALUES ('T-2', '另一个任务', 'IN_PROGRESS', 'qa', 'test', ?, ?)",
    ).run(1_700_000_000_000, 1_700_000_000_000);
    const t2 = replayFingerprint(db, { taskId: "T-2" });
    expect(t2.rows).toBe(0);
    expect(t2.fingerprint).not.toBe(a.fingerprint);

    // 2) 同一任务再写一条 ⇒ 必须不同。
    insertEvents(db, 1, "T-1", 40);
    const c = replayFingerprint(db, { taskId: "T-1" });
    expect(c.rows).toBe(41);
    expect(c.fingerprint).not.toBe(a.fingerprint);

    // 3) 内容变了而行数没变，也必须不同（防止指纹只看行数）。
    const { db: d2 } = migratedDb(10);
    const f1 = replayFingerprint(d2, { taskId: "T-1" });
    const { db: d3 } = migratedDb(10);
    d3.exec("DROP TRIGGER events_no_update");
    d3.exec("DROP TRIGGER events_no_delete");
    d3.exec("DROP TRIGGER events_fts_au");
    d3.exec("DROP TRIGGER events_fts_ad");
    d3.exec("UPDATE events SET payload = json_set(payload, '$.note', '被人改过的一行') WHERE id = 3");
    const f2 = replayFingerprint(d3, { taskId: "T-1" });
    expect(f2.rows).toBe(f1.rows);
    expect(f2.fingerprint).not.toBe(f1.fingerprint);
  });

  it("limit 截断会改变指纹，所以「指纹相等」不等于「全库一致」", () => {
    // 明说这一条【测不到】的东西：分页调用方传了 limit，两次拿到不同页时
    // 指纹会不同而内容其实一致。所以本模块钉的是「同参数同库必同指纹」，
    // 不是「任何两次回放一致」。写出来是为了不让下一位以为这条覆盖了后者。
    const { db } = migratedDb(50);
    const first20 = replayFingerprint(db, { taskId: "T-1", limit: 20 });
    const first30 = replayFingerprint(db, { taskId: "T-1", limit: 30 });
    expect(first20.rows).toBe(20);
    expect(first30.rows).toBe(30);
    expect(first20.fingerprint).not.toBe(first30.fingerprint);
  });
});

describe("④ append-only 探针：真去撞，四种结局都要能分辨", () => {
  it("健康库：UPDATE 与 DELETE 都被挡下，并写下一条安全审计", async () => {
    const { path, db } = migratedDb(12);
    const q = new WriteQueue(path);
    try {
      const before = Number(
        (db.prepare("SELECT count(*) AS c FROM events").get() as { c: number | bigint }).c,
      );
      const r = await probeAppendOnly({ writer: q });
      expect(r.outcome).toBe("rejected_as_expected");
      expect(r.verdict).toBe("ok");
      expect(r.probedEventId).toBeGreaterThan(0);
      expect(r.auditEventId).toBeGreaterThan(0);

      // 审计真的落库了（Task 6.2 验收②的【写入】那一半）。
      const audit = db
        .prepare("SELECT task_id, actor_type, actor_id, action, payload FROM events WHERE id = ?")
        .get(r.auditEventId as number) as
        | { task_id: string | null; actor_type: string; actor_id: string; action: string; payload: string }
        | undefined;
      expect(audit).toBeDefined();
      expect(audit?.actorId ?? audit?.actor_id).toBe(INTEGRITY_PROBE_ACTOR.actorId);
      expect(audit?.action).toBe("unauthorized_attempt");
      expect(JSON.parse(String(audit?.payload))["kind"]).toBe(APPEND_ONLY_PROBE_KIND);
      // 反向对照：探针【没有】改动被撞的那一行。
      const after = Number(
        (db.prepare("SELECT count(*) AS c FROM events").get() as { c: number | bigint }).c,
      );
      expect(after).toBe(before + 1); // 只多了那条审计
      expect(r.detail).toContain(String(r.probedEventId));
    } finally {
      q.close();
    }
  });

  it("空库：not_observable，而不是「通过」", async () => {
    const path = join(TMP, "空库-" + ++seq + ".db");
    const db = openDb(path);
    opened.push(db);
    migrate(db as never);
    const q = new WriteQueue(path);
    try {
      const r = await probeAppendOnly({ writer: q });
      expect(r.outcome).toBe("no_row_to_probe");
      expect(r.verdict).toBe("not_observable");
      expect(r.auditEventId).toBeUndefined();
    } finally {
      q.close();
    }
  });

  it("触发器真的被拆掉 ⇒ append_only_broken（这一发必须红）", async () => {
    const { path, db } = migratedDb(10);
    /*
     * 拆触发器要拆【四条】而不是两条，这是实测出来的（0018 §1 第 12 条）：
     * events_fts_au（external-content 的 FTS 同步触发器）活着的时候，
     * UPDATE events 会以一个光秃秃的 "SQL logic error" 失败 —— 探针会把它
     * 读成 other_error 并抛。那看起来像「append-only 坏了」，实际上是
     * 【一次不完整的 schema 改动】。所以这里按真实世界「有人整块拿掉 append-only 语义」
     * 的样子把四条一起拆，才是 append_only_broken 的正身。
     */
    for (const t of ["events_no_update", "events_no_delete", "events_fts_au", "events_fts_ad"]) {
      db.exec("DROP TRIGGER " + t);
    }
    const q = new WriteQueue(path);
    try {
      const r = await probeAppendOnly({ writer: q });
      expect(r.outcome).toBe("append_only_broken");
      expect(r.verdict).toBe("violated");
      // 没被挡下就不该留下那条「已拦下」的审计。
      expect(r.auditEventId).toBeUndefined();
      expect(r.detail).toContain("没有挡住");
    } finally {
      q.close();
    }
  });

  it("触发器被换成 RAISE(IGNORE) ⇒ probe_reached_no_row，而不是 append_only_broken", async () => {
    /*
     * 四种结局里最容易被折叠掉的那一种，而且它有【现实的来路】：
     * 有人嫌 append-only 触发器太吵，把它换成 RAISE(IGNORE)（"先让它别报"）。
     * 实测这样 UPDATE 的 changes 是 0 且【不报错】（0018 §1 第 13 条）——
     * 于是一个「只看抛没抛」的探针会报「挡住了」，而真相是那行压根没被改动过、
     * 也压根没被约束检查过。这一格报 violated（没验成），并在 detail 里
     * 指名「该查的是探针的语句还是有人在改库」，不是让人去查触发器在不在。
     */
    const { path, db } = migratedDb(10);
    db.exec("DROP TRIGGER events_no_update; DROP TRIGGER events_no_delete;");
    db.exec("CREATE TRIGGER swallow_u BEFORE UPDATE ON events BEGIN SELECT RAISE(IGNORE); END;");
    db.exec("CREATE TRIGGER swallow_d BEFORE DELETE ON events BEGIN SELECT RAISE(IGNORE); END;");
    const q = new WriteQueue(path);
    try {
      const r = await probeAppendOnly({ writer: q });
      expect(r.outcome).toBe("probe_reached_no_row");
      expect(r.verdict).toBe("violated");
      // 关键区分：这一种【不是】「没挡住」，两种读法下一步动作不同。
      expect(r.outcome).not.toBe("append_only_broken");
      expect(r.detail).toContain("一行都没匹配到");
    } finally {
      q.close();
    }
  });

  it("撞到非触发器的错 ⇒ 抛出来，绝不读成「挡住了」", async () => {
    // events 表整张不见 ⇒ 探针的 SELECT 就先抛。
    const path = join(TMP, "无表-" + ++seq + ".db");
    const db = openDb(path);
    opened.push(db);
    migrate(db as never);
    db.exec("DROP TRIGGER events_no_update; DROP TRIGGER events_no_delete;");
    db.exec("DROP TABLE events");
    const q = new WriteQueue(path);
    try {
      await expect(probeAppendOnly({ writer: q })).rejects.toThrow();
    } finally {
      q.close();
    }
  });
});

describe("⑤ §22.4 审计自洽：三条规则 + FTS + 枚举", () => {
  it("健康库：action 枚举一致，状态机与事件对账一致", () => {
    const { db } = migratedDb(15);
    db.exec("DROP TRIGGER events_no_update; DROP TRIGGER events_no_delete;");
    db.exec("DROP TRIGGER events_fts_au; DROP TRIGGER events_fts_ad;");
    db.exec("UPDATE events SET payload = json_set(payload, '$.to', 'IN_PROGRESS') WHERE id = 5");
    db.exec("UPDATE events SET action = 'state_change' WHERE id = 5");
    const checks = auditCoherenceReport({ db });
    expect(resultByName(checks, "action_enum").verdict).toBe("ok");
    expect(resultByName(checks, "state_machine_agrees_with_events").verdict).toBe("ok");
    expect(resultByName(checks, "fts_index").verdict).toBe("ok");
    // checked = 0 而 verdict = ok 是矛盾的（类型上允许，语义上是假绿），逐条拦。
    for (const c of checks) {
      if (c.verdict === "ok") expect(c.checked, c.name).toBeGreaterThan(0);
    }
  });

  it("库里有 §22.1 之外的 action ⇒ violated，并且 detail 说出是哪一个", () => {
    const { db } = migratedDb(5);
    db.prepare(
      "INSERT INTO events (task_id, actor_type, actor_id, action, payload, state_snapshot, created_at) " +
        "VALUES ('T-1','system','hub','totely_made_up_action','{}','{}',?)",
    ).run(1_750_000_000_000);
    const c = resultByName(auditCoherenceReport({ db }), "action_enum");
    expect(c.verdict).toBe("violated");
    expect(c.detail).toContain("totely_made_up_action");
    // 反向对照：把那一行去掉（换新库）就不再 violated。
    const { db: clean } = migratedDb(5);
    expect(resultByName(auditCoherenceReport({ db: clean }), "action_enum").verdict).toBe("ok");
  });

  it("改了 tasks.status 而没写事件 ⇒ violated（§6.3 那个形状）", () => {
    const { db } = migratedDb(8);
    // 先给一个合法的 state_change（to = 当前 status），再把表里的 status 改掉。
    db.exec("DROP TRIGGER events_no_update; DROP TRIGGER events_no_delete;");
    db.exec("DROP TRIGGER events_fts_au; DROP TRIGGER events_fts_ad;");
    db.prepare(
      "INSERT INTO events (task_id, actor_type, actor_id, action, payload, state_snapshot, created_at) " +
        "VALUES ('T-1','system','hub','state_change','{\"to\":\"IN_PROGRESS\"}','{}',?)",
    ).run(1_750_000_000_000);
    db.exec("UPDATE tasks SET status = 'DONE' WHERE id = 'T-1'");
    const c = resultByName(auditCoherenceReport({ db }), "state_machine_agrees_with_events");
    expect(c.verdict).toBe("violated");
    expect(c.detail).toContain("T-1");
    expect(c.detail).toContain("DONE");
  });

  it("没有任何任务有 state_change 事件 ⇒ not_observable（不是通过）", () => {
    // 这就是图没接进生产路径时【今天】的形状（0017 §1 第 1 条）。
    // 夹具的事件用的正是 action='state_change'，所以它【不能】当这一发的样本 ——
    // 拿一个有 state_change 的库去断言 not_observable，只会逼我把断言写成
    // 「ok 或 not_observable 都算过」（第一版就是这样，那等于没断言）。
    const path = join(TMP, "无状态事件-" + ++seq + ".db");
    const d = openDb(path);
    opened.push(d);
    migrate(d as never);
    d.prepare(
      "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
        "VALUES ('T-9','只有任务','IN_PROGRESS','dev','implement',?,?)",
    ).run(1, 1);
    d.prepare(
      "INSERT INTO events (task_id, actor_type, actor_id, action, payload, state_snapshot, created_at) " +
        "VALUES ('T-9','system','hub','task_created','{}','{}',?)",
    ).run(1);
    const c2 = resultByName(auditCoherenceReport({ db: d }), "state_machine_agrees_with_events");
    expect(c2.verdict).toBe("not_observable");
    expect(c2.checked).toBe(0);
    expect(c2.detail).toContain("没有发生过");
  });

  it("review_gates / harness_calls 为空 ⇒ not_observable，并说清为什么", () => {
    const { db } = migratedDb(5);
    const gate = resultByName(auditCoherenceReport({ db }), "gate_evidence_reference");
    const harness = resultByName(auditCoherenceReport({ db }), "harness_call_recorded");
    expect(gate.verdict).toBe("not_observable");
    expect(harness.verdict).toBe("not_observable");
    // 这一条不是兜底文案，是【实测的写入方状态】：src 里零 INSERT。
    // 如果哪天有人接上了 producer，这两条文案里的「零 INSERT」就过期，本发变红。
    expect(gate.detail).toContain("INSERT");
    expect(gate.checked).toBe(0);
  });

  it("接上门控与 harness 之后：两条规则真的能跑出 ok 与 violated", () => {
    const { db } = migratedDb(5);
    db.prepare(
      "INSERT INTO evidence_bundles (id, task_id, producer_role, bundle_type, artifacts, self_check, created_at) " +
        "VALUES ('E-1','T-1','qa','test_report','[]','{}',1)",
    ).run();
    db.prepare(
      "INSERT INTO review_gates (id, task_id, gate_type, reviewer_role, evidence_bundle_id, decision, decided_at) " +
        "VALUES ('G-1','T-1','tech_to_dev','qa','E-1','approved',1)",
    ).run();
    db.prepare(
      "INSERT INTO harness_calls (id, task_id, agent_role, harness, harness_version, args_redacted, cost_cents, created_at) " +
        "VALUES ('H-1','T-1','dev','claude','1','{}',5,1)",
    ).run();
    db.prepare(
      "INSERT INTO budget_events (source_event, scope_type, scope_id, period, amount_cents, task_id, created_at) " +
        "VALUES (1,'task','T-1','per_task',5,'T-1',1)",
    ).run();
    const checks = auditCoherenceReport({ db });
    expect(resultByName(checks, "gate_evidence_reference").verdict).toBe("ok");
    expect(resultByName(checks, "harness_call_recorded").verdict).toBe("ok");

    // 现在把引用打断：证据包引用置空 + 花掉的钱不进预算账。
    db.exec("DROP TRIGGER events_no_update; DROP TRIGGER events_no_delete;");
    db.prepare("UPDATE review_gates SET evidence_bundle_id = NULL WHERE id = 'G-1'").run();
    db.prepare(
      "INSERT INTO harness_calls (id, task_id, agent_role, harness, harness_version, args_redacted, cost_cents, created_at) " +
        "VALUES ('H-2','T-1','dev','claude','1','{}',9,2)",
    ).run();
    db.exec("DELETE FROM budget_events");
    const after = auditCoherenceReport({ db });
    expect(resultByName(after, "gate_evidence_reference").verdict).toBe("violated");
    expect(resultByName(after, "gate_evidence_reference").detail).toContain("G-1");
    expect(resultByName(after, "harness_call_recorded").verdict).toBe("violated");
    expect(resultByName(after, "harness_call_recorded").detail).toContain("H-2");
  });

  it("FTS 索引分叉：两条内置尺子都说 ok，本检查点名那一行", () => {
    /*
     * 本轮最值钱的一条实测（0018 §1 第 8 条）：往 external-content 的 FTS 里
     * 直写一次 'delete'，`PRAGMA integrity_check` 报 "ok"，
     * `INSERT INTO events_fts(events_fts) VALUES('integrity-check')` 也干净跑完，
     * 而那一行【从检索里消失了】。SQLite 自带的两把尺子都量不出这种漂移。
     * 所以本条检查必须自己逐行问「你还在吗」，而且问的是【自己那一段】。
     */
    const { db } = migratedDb(60);
    expect(JSON.stringify(db.prepare("PRAGMA integrity_check").all())).toContain("ok");
    db.prepare("INSERT INTO events_fts(events_fts) VALUES('integrity-check')").run();

    const victim = db
      .prepare("SELECT id, payload FROM events ORDER BY id LIMIT 1 OFFSET 37")
      .get() as { id: number; payload: string };
    db.prepare("INSERT INTO events_fts(events_fts, rowid, payload) VALUES('delete', ?, ?)").run(
      victim.id,
      victim.payload,
    );
    // 反向对照：索引里真的没有它了（不是我的检查误报）。
    const gone = db
      .prepare("SELECT rowid AS rid FROM events_fts WHERE events_fts MATCH ?")
      .all('"独有正文37"') as { rid: number | bigint }[];
    expect(gone.some((x) => Number(x.rid) === Number(victim.id))).toBe(false);

    const c = resultByName(auditCoherenceReport({ db }), "fts_index");
    expect(c.verdict).toBe("violated");
    // 必须点名到【具体哪一行】，不能只说「有分叉」。
    expect(c.detail).toContain(String(victim.id));
    // 而且分叉之后内置尺子仍然说 ok —— 这一发就是「为什么不能只跑 integrity_check」。
    expect(JSON.stringify(db.prepare("PRAGMA integrity_check").all())).toContain("ok");
  });

  it("payload 整齐划一也照样点名分叉行（命中判定问的是 rowid 归属）", () => {
    /*
     * 这一发是【删掉一段我自己写的代码】的理由，留着是为了不让它长回来。
     * 我一度认为：所有行 payload 一样 ⇒ 每行问的是同一个问题 ⇒ 检查恒真，
     * 于是加了一道「样本探针重复过半就判 not_observable」的区分度自检。
     * 实测证伪（/tmp/iguni.mjs）：200 行 payload 完全一样的库里人为删掉索引里
     * 第 57 行，检查【照样点名 57】—— 因为命中判定问的是
     * 「这一行的 rowid 在不在结果里」，不是「结果非空」。
     * 归属判定本来就堵住了那个洞；多出来的那道判据唯一的实际效果，
     * 是把一份【完全正常】的整齐数据报告搅成 not_observable（它当场就演了这一出）。
     * 一条只在健康数据上改变结论的判据，是噪音而不是防线。
     */
    const path = join(TMP, "整齐 payload-" + ++seq + ".db");
    const db = openDb(path);
    opened.push(db);
    migrate(db as never);
    db.prepare(
      "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
        "VALUES ('T-1','整齐','IN_PROGRESS','dev','implement',1,1)",
    ).run();
    const ins = db.prepare(
      "INSERT INTO events (task_id, actor_type, actor_id, action, payload, state_snapshot, created_at) " +
        "VALUES ('T-1','system','hub','tool_call',?,'{}',?)",
    );
    const SAME = '{"same":"每字节都一样的正文"}';
    for (let i = 0; i < 200; i++) ins.run(SAME, 1_700_000_000_000 + i);
    // 先证明整齐本身【不】让检查失效。
    expect(resultByName(auditCoherenceReport({ db }), "fts_index").verdict).toBe("ok");
    // 再打断其中一行 —— 必须仍然点得到。
    const victim = db
      .prepare("SELECT id, payload FROM events ORDER BY id LIMIT 1 OFFSET 56")
      .get() as { id: number; payload: string };
    db
      .prepare("INSERT INTO events_fts(events_fts, rowid, payload) VALUES('delete', ?, ?)")
      .run(victim.id, victim.payload);
    const c = resultByName(auditCoherenceReport({ db }), "fts_index");
    expect(c.verdict).toBe("violated");
    expect(c.detail).toContain(String(victim.id));
  });

  it("ftsSample = 0 是【显式关掉】，结论记 not_observable", () => {
    const { db } = migratedDb(30);
    const c = resultByName(auditCoherenceReport({ db, ftsSample: 0 }), "fts_index");
    expect(c.verdict).toBe("not_observable");
    expect(c.detail).toContain("显式关掉");
    expect(c.checked).toBe(0);
  });
});

describe("⑥ could_not_run：有东西可查而尺子放不下去", () => {
  it("DROP TABLE events 而留着 events_fts：页面检查仍报 ok，自洽规则全部 could_not_run", () => {
    /*
     * 第四种结论【为什么不能省】，就在这一发里：
     * `PRAGMA integrity_check` 对这份库报 "ok"（实测），
     * 而每一条自洽规则的 SELECT 都抛 "no such table: events"。
     * 如果 could_not_run 并进 not_observable，这份报告读起来就是
     * 「events 空着、没有可核对的」—— 与本仓今天那条人尽皆知的常态同形，
     * 而真相是审计表整张没了。并进 violated 也不对：要修的是 schema 不是某一行数据。
     */
    const { db } = migratedDb(20);
    db.exec("DROP TRIGGER events_no_update; DROP TRIGGER events_no_delete;");
    db.exec("DROP TABLE events");
    // 前提：内置尺子说没问题。少了这一句，这一发就退化成「看哪个都该红」。
    expect(JSON.stringify(db.prepare("PRAGMA integrity_check").all())).toContain("ok");

    const checks = auditCoherenceReport({ db });
    const notRun = checks.filter((c) => c.verdict === "could_not_run");
    expect(notRun.length).toBeGreaterThan(0);
    for (const c of notRun) {
      expect(c.checked).toBe(0);
      expect(c.detail).toContain("没能跑成");
      // 而且它【不是】 not_observable —— 这两个词差之毫厘，语义相反。
      expect(c.verdict).not.toBe("not_observable");
    }
    // 一条规则抛错不能把其余规则一起带走（guarded 那一层的存在理由）。
    expect(checks.length).toBe(CHECK_NAMES.length - 2); // 页面检查与探针不在这里
  });

  it("could_not_run 会拉下整份报告的 ok", async () => {
    const { path, db } = migratedDb(20);
    db.exec("DROP TRIGGER events_no_update; DROP TRIGGER events_no_delete;");
    db.exec("DROP TABLE events");
    const q = new WriteQueue(path);
    try {
      const res = await runIntegrityScan({
        dbPath: path,
        db: q.readConnection(),
        onMainThread: true,
      });
      expect(res.ok).toBe(false);
      expect(res.checks.some((c) => c.verdict === "could_not_run")).toBe(true);
    } finally {
      q.close();
    }
  });

  it("探针抛错也只影响【那一格】，报告照样产出", async () => {
    const { path, db } = migratedDb(20);
    db.exec("DROP TRIGGER events_no_update; DROP TRIGGER events_no_delete;");
    db.exec("DROP TABLE events");
    const q = new WriteQueue(path);
    try {
      const res = await runIntegrityScan({
        dbPath: path,
        db,
        writer: q,
        onMainThread: true,
      });
      expect(resultByName(res.checks, "append_only").verdict).toBe("could_not_run");
      // 报告是【一份完整的报告】而不是一个 rejection：格数一条不少。
      expect(res.checks).toHaveLength(CHECK_NAMES.length);
    } finally {
      q.close();
    }
  });
});

describe("⑦ 结论集合本身", () => {
  it("四种结论都被本文件真的造出来过", () => {
    /*
     * 这一发【不读枚举】，它读的是【观察到的结论】。
     * 第一版这里写的是「把四个字面量塞进 Set 再比长度」—— 那恒真，
     * 枚举少一种它照样绿（字面量是我自己抄的）。现在改成把每条规则的
     * 真实返回值收集起来：少造出一种，这里就红。
     */
    const seen = new Set<string>();
    const healthy = migratedDb(30);
    for (const c of auditCoherenceReport({ db: healthy.db })) seen.add(c.verdict);
    const empty = openDb(join(TMP, "空-" + ++seq + ".db"));
    opened.push(empty);
    migrate(empty as never);
    for (const c of auditCoherenceReport({ db: empty })) seen.add(c.verdict);
    const broken = migratedDb(20);
    broken.db.exec("DROP TRIGGER events_no_update; DROP TRIGGER events_no_delete;");
    broken.db.exec("DROP TABLE events");
    for (const c of auditCoherenceReport({ db: broken.db })) seen.add(c.verdict);
    const diverged = migratedDb(60);
    const v = diverged.db
      .prepare("SELECT id, payload FROM events ORDER BY id LIMIT 1 OFFSET 3")
      .get() as { id: number; payload: string };
    diverged.db
      .prepare("INSERT INTO events_fts(events_fts, rowid, payload) VALUES('delete', ?, ?)")
      .run(v.id, v.payload);
    for (const c of auditCoherenceReport({ db: diverged.db })) seen.add(c.verdict);

    // 观察到的必须是枚举的【子集】，且四种里至少有三种真出现过。
    // 说「至少三种」而不是四种：ok / violated / not_observable / could_not_run
    // 里 could_not_run 只在 broken 那份库里出现，其余三条来自 healthy / empty / diverged。
    for (const v2 of seen) expect(CHECK_VERDICTS as readonly string[]).toContain(v2);
    expect(seen.size).toBeGreaterThanOrEqual(3);
    expect(seen.has("could_not_run")).toBe(true);
    expect(CHECK_VERDICTS).toHaveLength(4);
  });

  it("worker 入口的推导式全仓只出现在一处", () => {
    // worker 入口靠剥掉自己扩展名再拼 .worker<同扩展名> 得到，
    // 这样源码态（.ts）与构建产物（.js）都能解析。
    // 这个技巧【只能有一处】：第二处出现就意味着有人在别处猜扩展名。
    //
    // ⚠ **这一发原来只读 src/db/integrity.ts 一个文件**，而它旁边的注释写的是
    // 「全仓只允许这一处」—— 一条声称管全仓的不变量，配一条只看一个文件的断言，
    // 第二处出现在任何别的文件里它都看不见。0036 §2 加第二个 worker 入口（备份）时
    // 量的就是这件事；修法不是「再补一发只看 backup.ts 的断言」（那只是把同一个洞
    // 复制两份，而两份都会漏第三个文件），是把射程换成【真的全仓】。
    //
    // ⚠⚠ 换成全仓之后【第一次跑就红，而红的是注释】：原来的判据是
    // `/import\.meta\.url\.replace/`，而我在 integrity.ts 里留了一段话记录
    // 「本节原本是内联那串 import.meta.url.replace(...)」—— 那段话本身就含这几个字。
    // 更难看的是同一发**在另一个方向上本来就不成立**：推导式搬进 worker-entry.ts 之后，
    // 那里那一行写的是 `callerUrl.replace(CALLER_EXT, ".worker.$1")`，
    // **不含 import.meta.url**，所以那个正则【匹配不到真正的代码】。
    // 一个既看不见目标、又看得见散文的判据，只要有人把那段注释删掉，
    // 就会「绿」成【全仓零处推导式】的样子 —— 而那正是它最想抓的情形。
    // ⇒ 判据不能拿【当年那行代码的字面】当特征，要拿【这件事的形状】当特征：
    //   同一行里既有一次 .replace( 调用、又有一个 .worker. 那个替换目标。
    // 这是「判据写在名字里、射程写在实现里」（0036 §2）之外同一发上的第二个坑：
    // **把判据搬进新射程时，特征是照着旧代码写的，而旧代码正是被搬走的那个东西。**
    const deriveLine = (line: string): boolean =>
      line.includes(".replace(") && line.includes(".worker.");

    // 判据自己的正向自检。缺了它，上面那个谓词写成恒 false 也能靠「hits 恰好为空」
    // 在这一发里蒙过一次（`toEqual([])` 会红，但下一次有人把 expect 也顺手放宽就绿了）；
    // 更直接的理由是：这一发要守的是【有没有第二处】，而它自己必须先证明
    // 「第二处如果存在，我认得出来」。
    expect(
      deriveLine('  const W = new URL(import.meta.url.replace(/x/u, ".worker.$1"));'),
      "判据必须认得出「有人把推导式重新内联回来」那一行",
    ).toBe(true);
    // 反向对照：一句提到这件事的散文不许命中（本篇撞的就是它）。
    expect(
      deriveLine(" * 本节原本是内联那串 import.meta.url.replace(...)，注明全仓只允许一处"),
      "判据不许把历史叙述当成第二处推导式",
    ).toBe(false);
    const srcDir = join(HUB, "src");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        // 与 doc-refs.ts 同一份跳过口径：dist 是产物（里面【必然】有 .js 版的推导式，
        // 那是同一次编译的复制品而不是「第二处有人猜扩展名」，数它会恒红）。
        if (e.name === "node_modules" || e.name === "dist" || e.name === ".tmp") continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts")) files.push(p);
      }
    };
    walk(srcDir);
    // 装配自检（0006 §7 第 21、22 条）：扫不到文件就等于「零处推导式」，
    // 而那是【判据坏了】伪装成【不变量成立】。src 下今天有几十个 ts 文件，20 是下限。
    expect(files.length).toBeGreaterThanOrEqual(20);

    const hits = files
      .map((f) => ({
        rel: relative(HUB, f).replace(/\\/gu, "/"),
        n: readFileSync(f, "utf8")
          .split("\n")
          .filter((line) => deriveLine(line)).length,
      }))
      .filter((r) => r.n > 0);
    // 【恰好一个文件】含它，而那个文件必须是 worker-entry.ts ——
    // 只断言「总数 1」是不够的：有人把推导式从 worker-entry.ts 抄进 backup.ts 之后
    // 删掉原来那份，总数还是 1，而「只有一处」已经从【结构上】退化成【今天碰巧】。
    expect(hits.map((h) => h.rel)).toEqual(["src/db/worker-entry.ts"]);
    expect(hits[0]?.n).toBe(1);

    // 两个消费者各【调用一次】那个共用函数。为什么这条要单独钉：
    // 上面那条只保证「推导式在一处」，它【不保证任何人真的在用】——
    // 有人把 backup.ts 那行调用删掉、改回内联，上面那条会红（因为内联就是第二处），
    // 而有人改成写死路径时上面那条【不红】（写死路径里没有 .replace）。
    // 这一发堵的就是那一支：调用次数从 1 变 0，或变成 2（自己又推一次），都红。
    for (const consumer of ["src/db/integrity.ts", "src/db/backup.ts"]) {
      const text = readFileSync(join(HUB, consumer), "utf8");
      const calls = (text.match(/selfWorkerUrl\(/gu) ?? []).length;
      expect(calls, consumer).toBe(1);
    }

    // 拼回去的时候要【补回那个点】。第一版写成 ".worker$1"，
    // 于是解析出 integrity.workerts —— 而 worker 起不来是【有兜底分支】的
    // （报 worker_unavailable / worker_error），所以这个洞不会让任何东西变红：
    // 全部「走 worker」的用例其实都走的是失败分支，而它们照样绿。
    // 这一发就是那个洞的锁。断言的对象跟着推导式一起搬到 worker-entry.ts。
    expect(readFileSync(join(HUB, "src", "db", "worker-entry.ts"), "utf8")).toContain(
      '".worker.$1"',
    );
  });
});
