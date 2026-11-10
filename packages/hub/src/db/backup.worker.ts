/**
 * 备份的 worker 入口（0036，计划 Task 6.3 的「备份期间写入不失败」那一半的另一侧）。
 *
 * 这是【入口】而不是普通模块：它被 `new Worker(...)` 直接加载，顶层副作用就是它的全部职责
 * （对照 ./integrity.worker.ts 同一立场，那三条约束在这里一条不改）。
 *
 * ── 为什么要有第二个 worker ──────────────────────────────────────────
 * `node:sqlite` 是同步 API，而 `VACUUM INTO` 是语句不是异步操作。
 * 实测（0036 §0，11.5MB / 5 万行的库）：主线程同步跑一次备份 91ms，
 * 期间那个 5ms 的心跳探针**最大间隔恰好也是 91ms** —— 写队列、心跳、HTTP 全停在那一段里。
 * 挪进 worker 之后同一发的探针最大间隔是 7ms。
 *
 * ── 三条只在这条路上成立的约束（抄 integrity.worker.ts，第 2 条本篇尤其要紧）──
 * 1) **必须挂 parentPort 且判 null 就抛。** 被主线程 import 时静默什么都不做
 *    = 一次备份从未发生而没人报错。
 * 2) **不得 import 任何 `@langchain/*`。** worker 拿到主线程的 execArgv 而【不是】它的模块图；
 *    带框架 import 会让这个入口在缺那几个包时连加载都做不到（本机就缺，0009 §2），
 *    于是「每日备份」这一块的可验证性由 import 图决定。
 *    ⚠ 这一条本篇是**被动守住的**：`backup.ts` 本身不 import 图，所以这里只 import 它。
 *    哪天 backup.ts 顺手 import 了一个认识图的东西，这个入口会跟着一起变重 ——
 *    所以 backup.test.ts 里有一发按 import 语句数的守卫钉住 backup.ts 的模块图。
 * 3) **一切异常都必须变成一条消息回给主线程。** 一条坏消息让主线程判失败，
 *    与一条消息都不发让主线程**永远等**，后者不可接受。
 *
 * ── 为什么过界的是【时刻】而不是【时钟】，以及 onWarning 在这里换了一种活法 ──
 * 函数不能过 postMessage / workerData（结构化克隆当场抛）。所以：
 *  · `onWarning` 在 worker 里【仍然要传】（createBackup 要求它，不传就是编译不过），
 *    但它收到的一切都【攒下来带回主线程】，由主线程那一句 reportBackup 说出去 ——
 *    告警的出口必须只有一个，否则「worker 里自己 console 一下」会变成第二个出口
 *    而没有进任何人的告警面板（详见 warnings 那一栏）；
 *  · `now: () => number` 换成过一个 number（`nowMs`）。
 *    ⚠ 我起初在这里写的是「`createdAtMs` 只能取 worker 自己的墙钟，注入跨不过去」，
 *    而那句**只对一半**：跨不过去的是函数，不是时间。带一个数过来就行，
 *    而【不带】会让备份文件名与调用方的时钟不同源（那才是真会踩的坑，见 nowMs 那一栏）。
 */

import { parentPort, workerData } from "node:worker_threads";
import { createBackup, type BackupRequest, type BackupResult } from "./backup.js";

/** 过界的数据只能是这几个字段。多一个都在主线程那边先拒掉。 */
export type BackupWorkerRequest = {
  readonly dbPath: string;
  readonly backupDir: string;
  readonly keep?: number;
  /**
   * 备份文件名用的【时刻】，不是【时钟】。
   *
   * ⭐ 过不了的边界是【函数】，不是【时间】。本篇 §4 起初写成「注入的时钟跨不过去」，
   * 那句只对一半（0036 §4 里更正）：`now` 的返回值是个 number，number 过克隆没问题。
   * 带一个数过来，就能让「备份文件名里的时刻」与调用方那个（可能是假的）时钟同源 ——
   * 不同源会让「今天备过了吗」在注入时钟下每轮都判「该备」，见 backup.ts 的 nowMs。
   */
  readonly nowMs?: number;
};

/**
 * 回程只有两种形状，而**这两种之间的分界线是本篇最容易写歪的一处**。
 *
 *  · `"result"` —— createBackup **自己给出了结论**（成或败都算）。原样带回，
 *    主线程那边是一个 fulfilled 的 Promise。
 *  · `"threw"` —— createBackup **抛了**（keep 非法那一种），或者它压根没跑起来。
 *    主线程那边是一个 **rejected** 的 Promise。
 *
 * ⚠ 我第一版把第二种压成了第一种：`reason: "verify_failed"`，理由是「总得给调用方一个 reason」。
 * 那句是错的，而且错过的正是本篇刚记过两次的那个形状（0032 §0 / 0031 §2）：
 * `verify_failed` 的既有语义是【产物落盘了而 integrity_check 不过】，
 * 拿它表示「worker 里抛了一个 TypeError」，读的人会去查那份并不存在的产物，
 * 而真正要改的是调用参数。**一条不对症的 reason 比一次 rejection 更坏** ——
 * rejection 至少把原文完整交到人手上，枚举值会把人支去查错的地方。
 * ⇒ 所以「抛」这一支不带 reason，只带原文；通道也不同（reject 而不是 resolve），
 *   与同步版 `createBackup`「keep 非法 ⇒ 抛」的语义【只差一个通道】，没有偷换。
 *
 * `warnings` 两形状都带：抛之前可能已经告过一条（prune 失败之后 statSync 才炸），
 * 丢掉那一条就是「备份静默失败」—— Task 6.3 明令禁止的那一件。
 */
export type BackupWorkerMessage =
  | {
      readonly kind: "result";
      /** 证明这条消息真的来自 worker 入口（照 integrity 那个 `via === "worker"` 的核对）。 */
      readonly via: "worker";
      readonly result: BackupResult;
      readonly warnings: readonly string[];
      /** worker 内耗时。与主线程看到的总时长差一个冷启动（0036 §0 量到约 95ms）。 */
      readonly ms: number;
    }
  | {
      readonly kind: "threw";
      readonly via: "worker";
      readonly message: string;
      readonly warnings: readonly string[];
    };

const warnings: string[] = [];

/**
 * worker 里 `onWarning` 收到的每一条，攒在这个模块级数组里。
 *
 * ⚠ **这一栏不是装饰，它是本篇唯一一处「差点被静默掉」的地方**。我第一版根本没留这一栏，
 * 而是在 `onWarning` 里直接 `throw`，配的理由是「createBackup 每条告警之后都紧跟一条
 * ok:false 的返回，所以消息不会丢」—— 那句**是假的**，`pruneBackups` 失败那一条就是反例：
 * 它告警之后返回的是 **ok:true**（「备份成功但清理旧备份失败」，那份备份确实可用，
 * 报成失败会让调用方再备一次、目录越堆越厚）。于是那一版会把一份【已经成功】的备份
 * 报成失败，而它看起来比黑洞更安全（黑洞吞掉那一条，抛把它放大成事故）。
 * 两种写法都源于同一句没被验证的前提（0035 §5.1「一句从打算里长出来的断言」的同族：
 * 我打算让它成立，于是它就成立了）。
 * ⇒ 告警必须**原样带回主线程**，由主线程决定怎么说。所以数组在两种形状里都带上，
 *   包括【抛出去】那一种（告警可能发生在抛之前）。
 */

function backupOffLoop(req: BackupWorkerRequest): BackupWorkerMessage {
  const started = Date.now();
  // 局部常量：闭包里读 req.nowMs 时 TS 不带外面的收窄，只能先把值取出来
  // （取出来之后【不需要】断言，这比写 `as number` 少一处会骗人的地方）。
  const injectedMs = req.nowMs;
  const request: BackupRequest = {
    dbPath: req.dbPath,
    backupDir: req.backupDir,
    // 收集而不是丢弃，也不抛。理由见 warnings 那一栏的注释。
    onWarning: (message: string): void => {
      warnings.push(message);
    },
    ...(req.keep === undefined ? {} : { keep: req.keep }),
    // 注入的时刻（如果有）。没有就落回 worker 自己的墙钟 —— 那是【没被注入】而不是
    // 「注入被忽略」：调用方要的是「我用给我的那个时钟给文件命名」，
    // 而它没给时钟时，worker 的 Date.now 与主线程的是同一个系统时钟。
    ...(injectedMs === undefined ? {} : { now: (): number => injectedMs }),
  };
  return {
    kind: "result",
    via: "worker",
    result: createBackup(request),
    warnings,
    ms: Date.now() - started,
  };
}

if (parentPort === null) {
  throw new Error(
    "backup.worker.ts 被主线程 import 了。它是 worker 入口：顶层副作用就是它的全部职责。" +
      "要备份请直接调 src/db/backup.ts 的 createBackup（同步版，就在主线程上跑）" +
      "或 createBackupOffLoop（本版的那个 worker 入口）。",
  );
}

const req = workerData as Partial<BackupWorkerRequest> | undefined;

/**
 * 参数不合法 ⇒ **抛**，而不是编一个 `reason` 回给主线程。
 *
 * 我第一版回的是 `reason: "source_missing"`，而那一栏的语义是「源库文件不存在」
 * （backup.ts 里就那一处产生它）。拿它表示「主线程忘了传 dbPath」是一句
 * **不对症的报错**（0032 §0 那条：照它改完照旧触发）—— 看到 source_missing 的人
 * 会去查库文件在不在，而真正坏的是调用点。
 * `vacuum_failed` 同理：worker 内部抛错不等于 VACUUM 失败过。
 *
 * 这两种情形在主线程那边【结构上不可达】（workerData 由 createBackupOffLoop 从
 * 强类型入参拼出来），所以它们属于「装配写错了」而不是「备份失败了」：
 * 抛出去让 worker 的 error 事件把它归到 worker_error 那一类，
 * 那里才是它该住的地方。与 0031 §0 那种「分支写着但今天不可达」的区别是：
 * 那边的分支是【判决形状】的一部分（漏一个 kind 会静默当成功），
 * 这边只是一句装配自检，不需要占用一条业务失败码。
 */
if (typeof req?.dbPath !== "string" || req.dbPath === "") {
  throw new TypeError("backup.worker 没收到 dbPath（workerData = " + JSON.stringify(req) + "）");
}
if (typeof req.backupDir !== "string" || req.backupDir === "") {
  throw new TypeError(
    "backup.worker 没收到 backupDir（workerData = " + JSON.stringify(req) + "）",
  );
}

try {
  parentPort.postMessage(
    // 三个可选字段一个都不能在这一次拼装里漏掉：漏掉【不报错】，
    // 表现是「调用方注入了时刻而文件名用的是墙钟」—— 与 §4 那条「悄悄丢掉」
    // 是同一件事，只是换到了 worker 这一侧的拼装上。所以下面三行是
    // 【整个 req】原样递进去（dbPath / backupDir 已在上面收窄成 string），
    // 而不是逐字段挑一遍 —— 挑字段这件事本身就是漏字段的形状。
    backupOffLoop({ ...req, dbPath: req.dbPath, backupDir: req.backupDir }),
  );
} catch (e) {
  // 文件头第 3 条：异常必须以消息形态回去（一条消息都不发 = 主线程永远等）。
  // 但**不把它压成一条 BackupResult** —— 见 BackupWorkerMessage 那一栏：
  // 编一个 reason 会把人支去查一个并不存在的产物。原文 + 攒下的告警，走 "threw" 那一支，
  // 由主线程 reject 出去（与同步版「keep 非法 ⇒ 抛」只差一个通道）。
  parentPort.postMessage({
    kind: "threw",
    via: "worker",
    message: "worker 内部抛错：" + String(e),
    warnings,
  } satisfies BackupWorkerMessage);
}
