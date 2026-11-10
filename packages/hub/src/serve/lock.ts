/**
 * 跨进程的「唯一 SQLite 写入者」锁（规格 §5.1）。
 *
 * ── 这一篇是被一次实测逼出来的，不是照抄规格 ─────────────────────────
 * 写之前先量了一遍（本机 node:sqlite，脚本形状与结论都记在 0025 §2）：
 *   · 第一个 WriteQueue 持有事务时开第二个 ⇒ 【database is locked】（挡住了）
 *   · 第一个 WriteQueue 【空闲】时开第二个 ⇒ 【不报错】，两边都能写
 * 第二条是重点。WAL 的「一写多读」只在【写的一刻】互斥，它不管「有几个写者存在」。
 * 于是 §5.1 那句「Hub 是唯一 SQLite 写入者」在此前的实现里是一条【约定】，
 * 不是一条【性质】：双开的表现不是报错，是两个进程交错写同一个库，
 * 而 events 是 append-only —— 交错写出来的东西【删不掉】（0014 §3 那条
 * 「脏了的审计库删不掉」说的正是同一件事）。
 *
 * ── 为什么用锁文件而不是 sqlite 的 BEGIN IMMEDIATE ────────────────────
 * 用数据库自己做锁是更「正统」的做法（拿一把真正的写锁不放），我否掉了：
 *  1. 常驻进程持有写锁不放，会让 `hub:maintenance` 与备份这类【合法的旁路读】
 *     之外的一切写操作在启动期就锁死，而维护流程恰恰要写停滞事件；
 *  2. 更关键的是它给不出【人话】。数据库层的报错是 `database is locked`，
 *     它不会告诉你是哪个 pid 在持；而双开这件事唯一有用的信息就是
 *     「另一个 Hub 的 pid 与它启动的时刻」。锁文件里正好写得下这两样。
 *
 * 代价说清楚：锁文件是【建议锁】，它拦不住不守约的写入方（比如有人手写脚本
 * 直接 openDb）。它把「意外双开」变成一次响亮的启动失败，把「故意绕过」留给
 * SQLite 那一层的互斥兜底。这个边界写在这里，别让读代码的人以为它比实际更强。
 *
 * ── 陈旧锁的处理：响亮地抢，不静默地抢 ────────────────────────────────
 * 进程被 kill -9 / 断电 ⇒ 锁文件留下来 ⇒ 下次启动永久失败，这是所有 pid 文件
 * 的经典死法。判据用 `process.kill(pid, 0)` 探活：
 *   · ESRCH（没有这个进程）⇒ 判定为陈旧，可以抢，但【必须把抢了什么说出来】
 *   · EPERM（进程在而不属于我）⇒ 进程【在】，不算陈旧
 *   · 成功 ⇒ 进程在
 * pid 会复用（本机跑几天后 pid 撞上是很正常的），所以「探活说在」有可能误判；
 * 误判的方向是【拒绝启动】，而拒绝启动带着一句「如果你确认没有，加 --force-unlock」
 * —— 保守方向的那一侧永远留一个显式出口，不然锁就变成砖。
 */
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";

/** 锁文件相对库文件的名字。<db> 与 <db>.lock 同目录，一眼看得出来归谁。 */
export const LOCK_SUFFIX = ".lock";

export function lockPathFor(dbPath: string): string {
  return dbPath + LOCK_SUFFIX;
}

export type LockHolder = {
  readonly pid: number;
  readonly startedAtMs: number;
  readonly host: string;
  /** 写这把锁的入口名。写进去是为了报错时能说「是 hub:serve 还是 hub:maintenance」。 */
  readonly who: string;
};

export type LockAcquire =
  | { readonly ok: true; readonly path: string; readonly tookOverFrom?: LockHolder | undefined }
  | { readonly ok: false; readonly path: string; readonly holder: LockHolder | null; readonly reason: LockNotAcquiredReason };

export type LockNotAcquiredReason = "held_by_other_process" | "unparsable_lock" | "forced_but_absent";

export interface AcquireLockOptions {
  /** 持锁者自述。默认 hub-serve。 */
  readonly who?: string;
  readonly now?: () => number;
  /**
   * 显式抢锁。用于「锁文件说有人，而我确认没有」（pid 复用误判、跨机挂载）。
   * 不给 ⇒ 只探活，探不出活人才抢。
   */
  readonly force?: boolean;
  /** 探活点。测试用它把「pid 在不在」这件事变成注入，而不是等一台机器真死掉。 */
  readonly isAlive?: (pid: number) => boolean;
  readonly host?: string;
}

/**
 * 探活。`process.kill(pid, 0)` 不发信号，只做权限与存在性检查：
 * 成功 = 在；ESRCH = 不在；EPERM = 在但不是我的进程（本机单用户下很少见，
 * 而它的正确读法是【在】—— 「不归我」不等于「不存在」，据此抢锁会抢掉别人正持有的）。
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    // 意料之外的错误码 ⇒ 当成【在】。判错的代价不对称：
    // 当成在 = 拒绝启动 + 一句带出口的报错；当成不在 = 双开，交错写进 append-only 的库。
    return true;
  }
}

/**
 * 锁文件里的内容。写法上刻意用 JSON 而不是「一行 pid」：
 * 只写 pid 的话，报错只能问「这个 pid 还在吗」，而 pid 复用时会得出一个自信的错答。
 * 带上启动时刻与主机名之后，那句报错可以说「pid 1234 于 03:12 在 mac-a 上启动」，
 * 人一眼就能判断那是不是他半小时前忘了关的那个。
 */
function encode(h: LockHolder): string {
  return JSON.stringify(h) + "\n";
}

function decode(raw: string): LockHolder | null {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const pid = Number(o["pid"]);
    const startedAtMs = Number(o["startedAtMs"]);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (!Number.isFinite(startedAtMs)) return null;
    return {
      pid,
      startedAtMs,
      host: typeof o["host"] === "string" ? o["host"] : "unknown",
      who: typeof o["who"] === "string" ? o["who"] : "unknown",
    };
  } catch {
    return null;
  }
}

/** 文件是不是【今天刚留的】。见调用点注释里的「半截锁」那一格。 */
const LOCK_WRITE_GRACE_MS = 5_000;

/**
 * 抢锁。成功返回 ok:true（并带上被抢掉的陈旧持有者，供调用方说出来）；
 * 失败返回持有者信息，报错由调用方组装（本文件不认识 io）。
 *
 * 关键实现细节：用 `writeFileSync(..., { flag: "wx" })`。`wx` 是 O_CREAT|O_EXCL ——
 * 【内核层面】的「不存在才创建」，所以两个进程同时启动时恰有一个成功。
 * 先 existsSync 再 writeFileSync 的写法我否掉了：那两步之间有窗口，
 * 而双开恰恰发生在两个进程几乎同时启动的时候 —— 检查与动作之间的窗口
 * 是本仓反复撞的那一族（同 assertSingleStatement 之前「先 split 再判」的写法）。
 */
export function acquireLock(
  dbPath: string,
  o: AcquireLockOptions = {},
): LockAcquire {
  const path = lockPathFor(dbPath);
  const now = o.now ?? Date.now;
  const alive = o.isAlive ?? isPidAlive;
  const who = o.who ?? "hub-serve";
  const holder: LockHolder = {
    pid: process.pid,
    startedAtMs: now(),
    host: o.host ?? hostname(),
    who,
  };

  const write = (): void => {
    writeFileSync(path, encode(holder), { flag: "wx" });
  };

  try {
    write();
    return { ok: true, path };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== "EEXIST") throw e; // ENOENT/EACCES 之类是真故障，不吞
  }

  // 到这里：文件已存在。三种可能 —— 别人正持着 / 上次没清掉的陈旧锁 / 内容坏了。
  const raw = readExisting(path);
  const prev = raw === null ? null : decode(raw);

  if (o.force === true) {
    // 显式抢：把旧文件换掉。旧持有者【照旧报出来】，因为 --force 的常见场景是
    // 「我确认没有别的 Hub」，而人确认错的时候，那句报错是他唯一的补救线索。
    removeOwn(path);
    writeFileSync(path, encode(holder));
    return { ok: true, path, ...(prev === null ? {} : { tookOverFrom: prev }) };
  }

  if (prev === null) {
    return { ok: false, path, holder: null, reason: "unparsable_lock" };
  }
  if (alive(prev.pid)) {
    return { ok: false, path, holder: prev, reason: "held_by_other_process" };
  }

  // 陈旧锁。但「文件留下的那一刻进程可能正在死」：两个 Hub 前后脚启动时，
  // 前一个刚写完锁就崩，后一个在几毫秒内来抢 —— 那一刻 pid 探活可能已经失败
  // （进程已没了）而文件确实是刚留的。所以再要一个宽限期：
  // 【刚】留下的锁不当陈旧处理，让调用方重试或报错，而不是抢。
  const age = now() - prev.startedAtMs;
  if (age >= 0 && age < LOCK_WRITE_GRACE_MS) {
    return { ok: false, path, holder: prev, reason: "held_by_other_process" };
  }
  removeOwn(path);
  writeFileSync(path, encode(holder));
  return { ok: true, path, tookOverFrom: prev };
}

/**
 * 只读已有内容；文件在两次调用之间被删掉（别人刚好释放）⇒ 返回 null。
 * 单列一个函数是因为「读不到」有两种：不存在（null）与读失败（抛）。
 * 抛出去是对的：EACCES 意味着磁盘/权限出问题了，那不是「没人持锁」。
 */
function readExisting(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * 释放。只删【自己写的那把】—— 比对 pid。
 *
 * 这一格不是防御性编程，是修一个具体的连锁事故：进程 A 的锁被判陈旧、被 B 抢走，
 * A 后来才走到 shutdown，若无条件 rmSync 就删掉了【B 的】锁；
 * 于是 C 也能启动，同一时刻有 B 与 C 两个写者 —— 也就是这个模块要防的那件事。
 * 文件已经不在了（ENOENT）算成功：要的性质是「不再有我写的锁」，它已经成立。
 * 内容读不出来（坏了/半截）也删：那是我自己留下的文件，留着只会把下次启动锁死。
 */
export function releaseLock(
  dbPath: string,
  o: { readonly now?: () => number } = {},
): { readonly removed: boolean; readonly note: string } {
  void o;
  const path = lockPathFor(dbPath);
  if (!existsSync(path)) return { removed: false, note: "锁文件本来就不在（可能已被清理）" };
  const raw = readExisting(path);
  const prev = raw === null ? null : decode(raw);
  if (prev !== null && prev.pid !== process.pid) {
    return {
      removed: false,
      note:
        "锁文件现在归 pid " +
        prev.pid +
        "（" +
        prev.who +
        "），本进程【不】删它。" +
        "出现这一格说明本进程的锁曾被判陈旧并被别人抢走：请查是否发生了双开。",
    };
  }
  removeOwn(path);
  return { removed: true, note: "锁已释放" };
}

function removeOwn(path: string): void {
  try {
    rmSync(path);
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") throw e;
  }
}

/**
 * 一句人话的拒绝理由。放在这里而不是调用方，是因为 serve 与维护入口都要说这句话，
 * 两处的字不一样就会有一处的信息更少（而信息更少的那一处恰好是出事时有人读的那处）。
 */
export function describeLockFailure(x: Extract<LockAcquire, { ok: false }>): string {
  const at = (ms: number): string => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
  if (x.holder === null) {
    return (
      "锁文件读不出内容：" +
      x.path +
      "。\n刻意不抢一把读不懂的锁：读不懂 ⇒ 无从判断有没有人正持着它，" +
      "而误判的方向是两个写者交错写同一个库。\n" +
      "确认没有别的 Hub 在跑之后，删掉那个文件或加 --force-unlock 再来。"
    );
  }
  return (
    "另一个进程已经持有这个库：" +
    x.path +
    "\n  · pid " +
    x.holder.pid +
    "，入口 " +
    x.holder.who +
    "，主机 " +
    x.holder.host +
    "，启动于 " +
    at(x.holder.startedAtMs) +
    " UTC" +
    "\n规格 §5.1 要求 SQLite 只有【一个】写入者：同时跑两个不会报错，" +
    "而是交错写进同一个 append-only 的审计库，事后删不掉。\n" +
    "→ 先停掉那一个（kill " +
    x.holder.pid +
    "）。确认它已经不在了而这条报错仍在，加 --force-unlock。"
  );
}

/** 锁文件的 mtime，用于报错里那句「文件最后被写于…」。拿不到就返回 null，不编。 */
export function lockMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
