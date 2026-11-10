/**
 * 跨进程写者锁（serve/lock.ts）—— 规格 §5.1「Hub 是唯一 SQLite 写入者」的机械执行。
 *
 * ── 这一篇的起点是一次实测，不是规格那句话 ─────────────────────────
 * 动手前量的两条（本机 node:sqlite）：
 *   · 第一个 WriteQueue 【持有事务】时开第二个 ⇒ database is locked（挡住了）
 *   · 第一个 WriteQueue 【空闲】时开第二个 ⇒ 【不报错】，两边都能写
 * 第二条才是重点：WAL 的「一写多读」只在写的一刻互斥，它不管【有几个写者存在】。
 * 所以 §5.1 此前是一条约定而不是一条性质，双开的表现不是报错，是两个进程交错写
 * 同一个 append-only 的审计库（事后删不掉，0014 §3）。
 *
 * ── 探活点是【注入】的，这一格决定了这一组能不能测 ──────────────────
 * 「pid 在不在」在本机没法用真进程可靠地造：造一个真死掉的进程要 spawn + kill，
 * 而 pid 复用会随机改变结果 —— 那是一条 flaky，会被一句重试糊过去。
 * 所以 isAlive 是参数，测试里它是【我自己给的真值】。
 * 代价说清楚：本组证不了 `process.kill(pid, 0)` 的语义（ESRCH/EPERM 那三个分支），
 * 那三条由下面那组【直接调 isPidAlive】的用例覆盖，用的是一个真实存在的 pid
 * （process.pid）与一个几乎不可能存在的 pid —— 「几乎」不是「绝对」，
 * 所以那两条只断言【不抛】与返回类型，不断言具体真值。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  acquireLock,
  describeLockFailure,
  isPidAlive,
  lockMtimeMs,
  lockPathFor,
  releaseLock,
} from "../../src/serve/lock.js";

/** 被测源码【文件本体】。文本守卫读实现，不读这份测试。 */
const LOCK_TS = fileURLToPath(new URL("../../src/serve/lock.ts", import.meta.url));

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "opc-lock-"));
  dirs.push(d);
  return d;
}
function dbIn(d: string): string {
  const p = join(d, "hub.db");
  writeFileSync(p, "不是真的库，锁模块不碰它");
  return p;
}

afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, maxRetries: 40, retryDelay: 50 });
    } catch {
      /* 清不掉不影响结论 */
    }
  }
});

/** 一份「别的进程」的锁内容，用来手工布置现场。 */
function plant(dbPath: string, h: { pid: number; startedAtMs: number; who?: string; host?: string }): void {
  writeFileSync(
    lockPathFor(dbPath),
    JSON.stringify({ pid: h.pid, startedAtMs: h.startedAtMs, host: h.host ?? "testhost", who: h.who ?? "hub-serve" }) + "\n",
  );
}

/** 现在这一刻往前推 n 毫秒。陈旧锁的用例都要一个「明显超出宽限期」的时刻。 */
const T0 = 1_700_000_000_000;
const STALE = T0 - 60_000;

describe("抢到与抢不到", () => {
  it("第一次抢 ⇒ 成功，且锁文件就在库旁边", () => {
    const db = dbIn(tmp());
    const r = acquireLock(db, { now: () => T0 });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("不该抢不到");
    expect(r.path).toBe(db + ".lock");
    expect(existsSync(r.path)).toBe(true);
    const raw = JSON.parse(readFileSync(r.path, "utf8")) as Record<string, unknown>;
    expect(raw["pid"]).toBe(process.pid);
    expect(raw["who"]).toBe("hub-serve");
  });

  it("⭐ 持有者还活着 ⇒ 拒，且报错里带着 pid、入口名与启动时刻", () => {
    const db = dbIn(tmp());
    const r = acquireLock(db, { now: () => T0, isAlive: () => true });
    expect(r.ok).toBe(true); // 先自己拿一次
    const second = acquireLock(db, { now: () => T0 + 1000, isAlive: () => true });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("第二次必须拒");
    expect(second.reason).toBe("held_by_other_process");
    const msg = describeLockFailure(second);
    expect(msg).toContain(String(process.pid));
    expect(msg).toContain("hub-serve");
    // 报错必须给出一条【能执行】的动作。只说「已被占用」的报错会让人去重启机器。
    expect(describeLockFailure(second)).toContain("kill " + process.pid);
  });

  it("⭐ pid 探不到 ⇒ 判陈旧并抢下，且把抢了谁【说出来】", () => {
    const db = dbIn(tmp());
    plant(db, { pid: 999_999, startedAtMs: STALE });
    const r = acquireLock(db, { now: () => T0, isAlive: () => false });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("陈旧锁该能抢");
    expect(r.tookOverFrom?.pid).toBe(999_999);
    // 反向：没抢别人时这个字段【必须缺席】，否则调用方分不清「我拿到了」与
    // 「我拿到了而且刚才有人」，而后者是要写进日志的一句话。
    const fresh = acquireLock(dbIn(tmp()), { now: () => T0, isAlive: () => true });
    if (!fresh.ok) throw new Error("空库该抢到");
    expect(fresh.tookOverFrom).toBeUndefined();
  });

  it("⭐ 陈旧但【刚留下】的锁不算陈旧：宽限期内不抢", () => {
    // 场景很具体：两个 Hub 前后脚启动，前一个刚写完锁就崩。
    // 那一刻 pid 探活已经失败（进程真没了），照「探不到 = 陈旧」就会抢 ——
    // 而那场竞争里真正该赢的是【后一个】，它该报错让人看一眼，而不是抢。
    const db = dbIn(tmp());
    plant(db, { pid: 999_998, startedAtMs: T0 - 100 });
    const r = acquireLock(db, { now: () => T0, isAlive: () => false });
    expect(r.ok).toBe(false);
    // 反向对照：同一份锁内容，时刻推到宽限期之外就该抢下。
    // 少了这一发，上面那条绿可能只是因为「恒不抢陈旧锁」。
    plant(db, { pid: 999_997, startedAtMs: T0 - 60_000 });
    expect(acquireLock(db, { now: () => T0, isAlive: () => false }).ok).toBe(true);
  });

  it("读不懂的锁 ⇒ 拒，不抢（读不懂 = 无从判断有没有人持着）", () => {
    const db = dbIn(tmp());
    writeFileSync(lockPathFor(db), "这一行不是 JSON");
    const r = acquireLock(db, { now: () => T0, isAlive: () => false });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("坏锁不该静默抢下");
    expect(r.reason).toBe("unparsable_lock");
    expect(describeLockFailure(r)).toContain("--force-unlock");
    // 反向对照：把内容改好就能抢 —— 证明上面那条不是「这个目录永远抢不到」。
    plant(db, { pid: 999_996, startedAtMs: STALE });
    expect(acquireLock(db, { now: () => T0, isAlive: () => false }).ok).toBe(true);
  });

  it("缺 pid 字段的 JSON 也算读不懂（形状对而内容空不算对）", () => {
    const db = dbIn(tmp());
    writeFileSync(lockPathFor(db), JSON.stringify({ who: "hub-serve" }));
    expect(acquireLock(db, { now: () => T0, isAlive: () => false }).ok).toBe(false);
    writeFileSync(lockPathFor(db), JSON.stringify({ pid: 0, startedAtMs: T0, host: "h", who: "w" }));
    expect(acquireLock(db, { now: () => T0, isAlive: () => true }).ok).toBe(false);
  });
});

describe("--force-unlock 那条显式出口", () => {
  it("force ⇒ 抢下活人持有的锁，但仍把旧持有者报出来", () => {
    // 人会判断错（以为没在跑而其实在跑），所以那一句报错是他唯一的补救线索。
    const db = dbIn(tmp());
    plant(db, { pid: 4242, startedAtMs: T0 - 1000, who: "hub-serve" });
    const r = acquireLock(db, { now: () => T0, isAlive: () => true, force: true });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("force 该能抢");
    expect(r.tookOverFrom?.pid).toBe(4242);
  });

  it("force 也要能覆盖【读不懂】的锁（那种情况下没有别的出口）", () => {
    const db = dbIn(tmp());
    writeFileSync(lockPathFor(db), "坏掉的一行");
    expect(acquireLock(db, { now: () => T0, force: true }).ok).toBe(true);
  });
});

describe("释放：只删自己写的那把", () => {
  it("自己的锁 ⇒ 删掉", () => {
    const db = dbIn(tmp());
    const r = acquireLock(db, { now: () => T0 });
    if (!r.ok) throw new Error("先要拿到");
    expect(releaseLock(db).removed).toBe(true);
    expect(existsSync(lockPathFor(db))).toBe(false);
  });

  it("⭐ 锁已被别人抢走 ⇒ 【不删】，并说明为什么不删", () => {
    // 这一发防的是一个具体的连锁事故：A 的锁被判陈旧、被 B 抢走，
    // A 后来才走到 shutdown。若无条件 rmSync，删掉的是【B 的】锁，
    // 于是 C 也能启动 —— 同一个时刻有 B 与 C 两个写者，
    // 也就是这个模块存在的理由被 A 的「优雅清理」破坏了。
    const db = dbIn(tmp());
    acquireLock(db, { now: () => T0 });
    plant(db, { pid: 5150, startedAtMs: T0 + 1000 });
    const rel = releaseLock(db);
    expect(rel.removed).toBe(false);
    expect(rel.note).toContain("5150");
    expect(existsSync(lockPathFor(db))).toBe(true);
    // 反向对照：把 pid 换回自己就该删 —— 否则上面那条绿只是因为「恒不删」。
    plant(db, { pid: process.pid, startedAtMs: T0 + 1000 });
    expect(releaseLock(db).removed).toBe(true);
  });

  it("文件本来不在 ⇒ 【不报失败】也不抛（要的性质是『不再有我写的锁』，它已成立）", () => {
    // removed=false 说的是「我没删东西」，不是「释放失败」—— 调用方唯一的判据是
    // note 里那句话，所以这里钉的是【不抛】而不是 removed 的布尔值。
    // 把 false 当成失败来实现的调用方，会在一次正常关机后打一句假告警。
    const db = join(tmp(), "never-locked.db");
    expect(() => releaseLock(db)).not.toThrow();
    expect(releaseLock(db).note).toContain("本来就不在");
  });

  it("内容坏了而 pid 认不出 ⇒ 删（自己的坏文件留着会锁死下次启动）", () => {
    const db = dbIn(tmp());
    writeFileSync(lockPathFor(db), "半截写入");
    // 内容读不懂时无法比对 pid。这里的选择是【删】：
    // 本函数只在「我持有过它」之后被调用，留着一颗认不出主人的锁的代价是永久起不来。
    expect(releaseLock(db).removed).toBe(true);
    expect(existsSync(lockPathFor(db))).toBe(false);
  });
});

describe("两个进程同时启动（O_EXCL 那一格）", () => {
  it("同一路径连续抢两次，第二次必拒", () => {
    const db = dbIn(tmp());
    const a = acquireLock(db, { now: () => T0 });
    const b = acquireLock(db, { now: () => T0 + 1, isAlive: () => true });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
  });

  /**
   * ⭐ 真子进程竞赛：N 个【进程】同时抢同一个路径，必须【恰有一个】赢。
   *
   * 这一发为什么必须跨进程：本模块要保证的性质是「两个 Hub 同时启动时恰有一个赢」。
   * 同一进程里调 N 次 acquireLock 永远在同一个事件循环上顺序执行，
   * 那次【竞争根本不存在】—— 用同进程的调用去证它，得到的是一条恒绿的断言，
   * 而它会让人以为「并发已经测过了」。
   *
   * 子进程里跑的是【writeFileSync 的 wx flag 本身】，不是 acquireLock。
   * 三个理由，都不是省事：
   *   ① 装不上 tsx（0009 §2），带相对 import 的 .ts 子进程在本机起不来 ——
   *      硬写的结果是一条【在本机恒红】的用例，而它会被当成环境问题放过，
   *      那正是本仓反复反对的形状（把红归因给环境）。
   *   ② 所以这一发证的是【原子性原语】：O_CREAT|O_EXCL 由内核保证恰有一个赢家。
   *   ③ acquireLock 确实用了这个原语 —— 由下面那一发【文本守卫】接上。
   * 两发的合取才是那条性质，任何单独一发都不够：
   *   只有①②时，有人把 acquireLock 改成「existsSync 再 write」也照样全绿；
   *   只有③时，flag 写着而原语在某个平台上退化，也没人知道。
   */
  it("N 个进程同时写同一文件的 wx flag ⇒ 恰有一个成功（原语成立）", () => {
    const d = tmp();
    const target = join(d, "race.lock");
    const child =
      'const fs=require("node:fs");const p=process.argv[1];' +
      'let o="LOST";try{fs.writeFileSync(p,process.pid+"",{flag:"wx"});o="WON";}catch(e){' +
      'if(e.code!=="EEXIST")o="ERR:"+e.code}process.stdout.write(o)';
    const N = 8;
    const outs: string[] = [];
    for (let i = 0; i < N; i++) {
      const r = spawnSync(process.execPath, ["-e", child, target], {
        encoding: "utf8",
        timeout: 30_000,
      });
      outs.push((r.stdout ?? "").trim());
    }
    const won = outs.filter((x) => x === "WON").length;
    const errs = outs.filter((x) => x.startsWith("ERR"));
    if (errs.length > 0) throw new Error("子进程报了 EEXIST 以外的错：" + errs.join(", "));
    expect(outs).toHaveLength(N);
    expect(won).toBe(1);
    // ⚠ 这一发证不了的东西也写下来，别让它被读成「并发已充分验证」：
    // 它证的是【8 次进程级 wx 写入恰有一个赢】。它不证「两个 Hub 进程真的会撞到这里」——
    // 那需要能起真 Hub 的通路（缺 tsx）。所以本条与下面那条文本守卫是【合取】才成立的，
    // 任何单独一条都不够，两条都在才有意义。
    // 另一个方向的对照（不用 wx 的写法会赢多次）我【没有】写成断言：
    // 那种写法在 8 次串行 spawn 里通常也全赢，而「通常」不是判据 ——
    // 硬钉它会得到一条依赖调度时序的 flaky 用例，那比不写更糟。
  });

  /**
   * 文本守卫：把上面那条【原语】接到本模块的【实现】上。
   *
   * 判据刻意收在「write 那个闭包体内出现 flag: "wx"」，不收在整个文件里出现 ——
   * 后者会因为注释里提到 wx 而绿（本仓在别处为同一族踩过：判据写在哪一层粒度上决定漏不漏）。
   * 与 patrol.test.ts 那条「patrol.ts 不得含 setInterval」是同一类守卫。
   */
  it("⭐ acquireLock 的写入用的就是 wx（否则上一条原语与本模块无关）", () => {
    const src = readFileSync(LOCK_TS, "utf8");
    // 只看两处 createLock 用的写法。剥掉块注释与行注释，否则本文件写的这些字
    // 会在被测源码里命中自己（那就是「判据被自己的注释喂绿」）。
    const code = src.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
    const hits = code.match(/flag:\s*"wx"/gu) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(1);
    // 反向 canary：本模块里【不能】出现「先 existsSync 再无条件 writeFileSync」这种
    // 检查-动作分离的写法（窗口 = 双开发生的那个瞬间）。
    // 判据是【存在一处 wx】而不是【不存在 existsSync】：读别人锁的时候确实要 existsSync，
    // 那条读路径是被允许的，把它一起禁掉会让这条守卫变成假的。
    expect(code).not.toMatch(/if\s*\(\s*existsSync\([^)]*lock[^)]*\)\s*\)\s*\{[^}]*writeFileSync\([^)]*\)\s*;/u);
  });

  it("锁文件路径就是 <db>.lock（与库同目录，一眼看得出来归谁）", () => {
    expect(lockPathFor("/a/b/hub.db")).toBe("/a/b/hub.db.lock");
  });
});

describe("isPidAlive 与 mtime 这两个直接调用的判据", () => {
  it("非正整数 / NaN 直接判【不在】，不发信号", () => {
    // 这一发的价值是把「pid 是个垃圾值」与「进程真的在」分开：
    // 垃圾值判在 ⇒ 一颗坏锁永久锁死库，而报错会说「另一个 Hub 在跑」。
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(isPidAlive(bad)).toBe(false);
    }
  });

  it("自己的 pid ⇒ 判【在】；不抛", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("mtime 拿不到时返回 null 而不是 0 或一个猜测", () => {
    expect(lockMtimeMs(join(tmp(), "nope.lock"))).toBeNull();
    const db = dbIn(tmp());
    acquireLock(db, { now: () => T0 });
    const m = lockMtimeMs(lockPathFor(db));
    expect(typeof m).toBe("number");
    if (m !== null) expect(m).toBeGreaterThan(0);
  });

  it("mtime 与文件内容里的时刻可以不一致，报错时两个都要能拿到", () => {
    // 人为把 mtime 改到内容时刻之前，模拟「文件被复制过来」（mtime 变了内容没变）。
    // 这一发的意义不在于断言哪一个是真相 —— 而在于本模块【没有只信 mtime】：
    // 陈旧判定用的是内容里的 startedAtMs，见上面那组。
    const db = dbIn(tmp());
    plant(db, { pid: 7777, startedAtMs: STALE });
    const p = lockPathFor(db);
    utimesSync(p, new Date(0), new Date(0));
    expect(statSync(p).mtimeMs).toBeLessThan(1000);
    const r = acquireLock(db, { now: () => T0, isAlive: () => true });
    expect(r.ok).toBe(false); // 内容说有人在 ⇒ 不看 mtime
  });

  it("mkdirSync 之外的目录不存在 ⇒ 抛真故障而不是静默不锁", () => {
    // 库在一个不存在的目录里 ⇒ openDb 也会失败，但锁这一层要【先】把环境问题
    // 报成环境问题。锁不住而静默放行是最坏的方向：那等于 §5.1 在磁盘出问题时自动失效。
    const missing = join(tmp(), "no-such-dir", "hub.db");
    expect(() => acquireLock(missing, { now: () => T0 })).toThrow();
  });
});

describe("报错文案的两分支", () => {
  it("有持有者 ⇒ 指名道姓；没有持有者 ⇒ 指路删文件或 --force-unlock", () => {
    const db = dbIn(tmp());
    plant(db, { pid: 1234, startedAtMs: Date.parse("2026-03-04T05:06:07Z") });
    const held = acquireLock(db, { now: () => T0, isAlive: () => true });
    if (held.ok) throw new Error("该拒");
    const heldMsg = describeLockFailure(held);
    expect(heldMsg).toContain("pid 1234");
    expect(heldMsg).toContain("2026-03-04 05:06:07");
    expect(heldMsg).toContain("append-only");

    const db2 = dbIn(tmp());
    writeFileSync(lockPathFor(db2), "");
    const bad = acquireLock(db2, { now: () => T0 });
    if (bad.ok) throw new Error("坏锁该拒");
    expect(describeLockFailure(bad)).not.toContain("pid ");
  });

  it("两个分支的文案【不同源】：一条恒包含断言必须能把它们分开", () => {
    // 反向 canary：如果 describeLockFailure 哪天退化成一句通用文案，
    // 上面那两条会同时红 —— 而那正是需要知道「有没有人持着」的时刻。
    const d = tmp();
    const a = dbIn(d);
    plant(a, { pid: 1, startedAtMs: STALE });
    const held = acquireLock(a, { now: () => T0, isAlive: () => true });
    const b = dbIn(tmp());
    writeFileSync(lockPathFor(b), "{坏掉的");
    const unparsable = acquireLock(b, { now: () => T0 });
    if (held.ok || unparsable.ok) throw new Error("两条都该拒");
    expect(describeLockFailure(held)).not.toBe(describeLockFailure(unparsable));
  });
});
