/**
 * 「worker 入口的兄弟 import 在**线程**里解析不了」这件事的**子进程夹具**（0037）。
 *
 * ── 为什么必须有子进程，而主线程里跑一遍不算 ─────────────────────────
 * 本仓跑测试的方式是 `node --experimental-transform-types --import <钩子>`。
 * 那条 `--import` **在 process.execArgv 里**，而 worker 线程默认继承 execArgv
 * ⇒ **钩子在 worker 里也生效**。于是「后备份走 worker」这类用例在两种世界里的读数
 * 一模一样：① 生产代码自己把解析能力递给了线程；② 生产代码什么都没递、
 * 靠 test runner 那条 `--import` 替它兜着。
 * ② 就是 0037 那个缺陷：**跑产品的那条路（tsx）不做这件事**，
 * 而 `serve` 的启动闸门把「页面检查没跑成」判成损坏 ⇒ 直接拒绝启动。
 * ⇒ 判据必须**在一条不含那条 `--import` 的命令行上**跑，否则它测的是 runner。
 *
 * ── 下面这份钩子是生产那份的【一份刻意副本】，理由是它测的不是生产那份 ──
 * 它只服务一件事：让**本进程的主线程**能 `import("./…/backup.js")` → `backup.ts`。
 * 若改成 import 生产那份（`worker-entry.ts` 的 installer），
 * 「生产那份坏了」与「主线程连 src 都读不到」会塌成同一次崩溃，
 * 读不出是哪一侧坏的 —— 而本篇要的读数恰恰是【线程那一侧有没有通】。
 * ⚠ 代价如实说：这份副本**不校验**生产那份的内容。生产那份由
 *   `worker-entry.test.ts` ②（直接把生产那份钩子喂说明符）+ ③（本夹具，生产入口真起线程）
 *   钉住。「两处钩子逻辑会漂」这件事由 ③ 兜 —— 漂了就是生产 worker 起不来，本夹具当场红。
 *   **没有**加「两份逐字比对」那种断言：要比对就得把生产那份当字符串读进来，
 *   而它是 data: URL，比对退化成比字符串（内容等价而写法不同时红，是噪音）。
 *
 * ── 五行读数各是什么 ────────────────────────────────────────────────
 *  `EXECARGV` 本进程的 execArgv。断言里含 `--experimental-transform-types`
 *          而**不含** `--import` —— 这一行是整个夹具成立的前提，
 *          它红了说明有人给 spawn 加了 --import（那等于把判据退回测 runner）。
 *  `NODEOPTS` execArgv 之外的【第二条】污染通路（见下面那一段的 ⚠）。
 *  `BACKUP` / `PAGE` 走**生产入口**（`createBackupOffLoop` / `runIntegrityScan`）。
 *          线程唯一的钩子来源就是生产代码那一层【入口包装】（`wrappedWorkerUrl`）——
 *          不是 execArgv：第一版走的是「父线程把钩子递进 new Worker({execArgv})」，
 *          那一版是错的（显式传 execArgv 会触发一道不传就没有的校验，
 *          在 `node --test` 那条命令下当场抛 ERR_WORKER_INVALID_EXEC_ARGV），
 *          理由与实测都在 worker-entry.ts 文件头。
 *  `CANARY` 同一个入口，但【不包那一层】直接起 = 缺陷修好之前的形状。它【必须仍然坏】：
 *          它要是哪天绿了，说明 Node 自己开始在线程里做 .js → .ts 映射，
 *          那本篇那条钩子就是多余的，该删的是生产代码而不是把这条用例放宽
 *          （0036 §7「恒绿的判据比没有判据更糟」的同一条，方向反过来同样成立）。
 *          ⚠ 它刻意【不传 execArgv】—— 传了测的就不是「没修」而是【另一发缺陷】
 *            （那道校验会让它【永远坏】，于是它谁也证不了）。
 */
import { register } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

/* 这份钩子只在【本线程】注册。register() 不跨线程 —— 实测（0037 §1），
   也正因如此，下面那些 worker 拿不拿得到解析能力，只由生产代码决定。 */
const MAIN_THREAD_HOOK = `import { existsSync } from "node:fs";
import { dirname, resolve as presolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, next) {
  const parent = context.parentURL;
  if (
    typeof specifier === "string" &&
    specifier.startsWith(".") &&
    specifier.endsWith(".js") &&
    typeof parent === "string" &&
    parent.startsWith("file:")
  ) {
    const asTs = presolve(dirname(fileURLToPath(parent)), specifier.slice(0, -3) + ".ts");
    if (existsSync(asTs)) {
      return { url: pathToFileURL(asTs).href, shortCircuit: true, format: "module-typescript" };
    }
  }
  return next(specifier, context);
}
`;
register("data:text/javascript," + encodeURIComponent(MAIN_THREAD_HOOK));

/** src/db 的绝对目录：由本文件位置算，不写死（写死挪个目录就悄悄失效）。 */
const DB_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", "db");

/* 五行读数里的头两行。两个都要打：
   · EXECARGV —— 本进程的 execArgv。测试断它含 --experimental-transform-types 而【不含 --import】。
   · NODEOPTS —— process.env.NODE_OPTIONS。它是 execArgv 之外的【第二条】把钩子塞进
     worker 线程的路（实测：NODE_OPTIONS="--import <钩子>" 时，即使生产代码什么都不递，
     worker 也照样起得来）。而它【不会出现在 execArgv 里】，
     所以只断 execArgv 的那一发在一个被 NODE_OPTIONS 污染的环境里会【假绿】。
     ⚠ 这里只【报】不【清】：运行时 delete process.env.NODE_OPTIONS 挡不住 worker 继承
     （实测删了照样起得来 —— Node 在启动时就把那份配置读进去了）。
     能做的只有把污染【照亮】，不能假装清理过了。 */
console.log("EXECARGV " + JSON.stringify(process.execArgv));
console.log("NODEOPTS " + JSON.stringify(process.env.NODE_OPTIONS ?? null));

const dir = mkdtempSync(join(tmpdir(), "opc-worker-hook-"));
const dbPath = join(dir, "hub.db");
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = wal;");
db.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, payload TEXT)");
db.prepare("INSERT INTO events (payload) VALUES (?)").run("hook-fixture");

const backupMod = await import(pathToFileURL(join(DB_SRC, "backup.ts")).href);
const integrityMod = await import(pathToFileURL(join(DB_SRC, "integrity.ts")).href);

/* ── 走生产入口：线程的解析能力只能由生产代码递进来 ── */
const b = await backupMod.createBackupOffLoop({
  dbPath,
  backupDir: join(dir, "b"),
  nowMs: 1_700_000_000_000,
});
console.log("BACKUP " + (b.ran ? "ran=true ok=" + b.result.ok : "ran=false " + b.failure));

const r = await integrityMod.runIntegrityScan({ dbPath, db });
db.close();
console.log(
  "PAGE " +
    r.checks[0]?.verdict +
    " 拒绝启动=" +
    integrityMod.pageIntegrityBroken(r) +
    " via=" +
    r.via,
);

/* ── CANARY：直接起真入口、不包那一层 ⇒ 缺陷没修之前那个形状 ──
   拿 backup 那个入口来跑（它 import ./backup.js，且 backup.ts 自己还有传递图）。
   期望它【必须仍然坏】，而且坏在【兄弟模块解析不了】这一句上，而不是别的错。
   ⚠ 这里刻意【不传 execArgv】。第一版写的是 `execArgv: [...process.execArgv]`，
     那测的不是「没修」而是【另一发缺陷】：显式传 execArgv 会触发一道不传就没有的
     校验（ERR_WORKER_INVALID_EXEC_ARGV），于是它【永远坏】、也就永远证不了任何事。
     不传才是修之前那行 `new Worker(WORKER_URL, { workerData })` 的字面形状。 */
const preFix = await new Promise((res) => {
  const w = new Worker(pathToFileURL(join(DB_SRC, "backup.worker.ts")), {
    workerData: { dbPath, backupDir: join(dir, "c"), nowMs: 1_700_000_000_000 },
  });
  w.once("message", (m) => {
    void w.terminate();
    res("LOADED kind=" + m.kind);
  });
  w.once("error", (e) => {
    void w.terminate();
    res("THREW " + String(e).slice(0, 200));
  });
});
console.log("CANARY " + preFix);
