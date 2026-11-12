/**
 * 章程泵接进常驻 Hub（serve/assemble.ts 那一侧）。
 *
 * ── 为什么单独一个文件而不是塞进 assemble.test.ts ────────────────────
 * 那一份的夹具围绕「起不来时留下了什么」（锁、队列、服务），本文件要的夹具是
 * 「库里有几条停在 CHARTER_PENDING 的任务 + 一份能起草的组织图」。
 * 两件事都要真库，而【真库的形状不同】，混在一个文件里最坏的结果是
 * 后来者为了让自己的夹具过而改掉对方的 world() —— 那会让别人的断言红在无关处。
 *
 * ── 这一组存在的理由：不测它，「泵写完了」是一句假话 ─────────────────
 * charter-pump.test.ts 那 28 发测的是【泵自己】。它可以全绿而【没有任何东西叫它】——
 * 那正是 0016 §4 与本文件 0043 §4 反复抓的那个形状：一个模块有测试、有导出、
 * 零生产调用方。0043 那条批评的就是这个，所以这一次【先接上再写结论】。
 * 本文件判的全是【接上之后才会坏】的事：
 *   A. 默认不开（钱不会因为"模块存在了"就花出去）
 *   B. 开了真的起草、真的建卡（不是只调了一次函数）
 *   C. ⭐ 一轮起草在飞时【巡检照跑】（await 上去就会被 ticker 判成"上一轮没结束"而跳过）
 *   D. 关机等到起草落地（否则一次起草会写进已经关掉的队列与已经还掉的锁）
 *   E. 上限缺失 ⇒ 退 2，且不监听
 *   F. 没配备份目录而泵照开（代码位置判据，见 C 组那一发）
 *   G. 注入 pumpCardDeps 【不算】开泵（不能留第二条绕过显式开关的后门）
 *
 * ── 注入点用哪个，每一发不同，而且是判据 ────────────────────────────
 *  · charterPumpVia 换掉【整趟泵】⇒ 只在 C / D 两发用（那两发要一份【停在半路】的轮次，
 *    而真泵没有可控的停留点）
 *  · pumpCardDeps 只换掉【起子进程】那一步 ⇒ 其余全走真泵（候选 SQL、建卡、审计、放弃判定）
 * 代价照 backupVia 那条口径写清：走 via 的两发【不证】真泵的行为，
 * 那一半在 charter-pump.test.ts；走 cardDeps 的几发【不证】真子进程能起，
 * 那一半在 engine/claude.test.ts。
 *
 * 跑法（离线、node v24.14.0）：
 *   PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH \
 *     node --experimental-transform-types --import /tmp/opc-harness/register.mjs \
 *     --test packages/hub/test/serve/assemble-pump.test.ts
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { openDb } from "../../src/db/driver.js";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import type { HubDeps } from "../../src/http/app.js";
import type { HubServer } from "../../src/http/server.js";
import type { LockAcquire } from "../../src/serve/lock.js";
import { INSERT_DELEGATION_GRAPH_SQL } from "../../src/org/commit.js";
import { DECISION_MARK } from "../../src/engine/claude.js";
import { CHARTER_CARD_KEY } from "../../src/engine/charter.js";
import type { CharterCardDeps, PumpOptions, PumpRoundResult } from "../../src/serve/charter-pump.js";
import {
  boot,
  pumpBoundsOf,
  type BootResult,
  type ServeIo,
} from "../../src/serve/assemble.js";
import type { ServeArgs } from "../../src/serve/config.js";
import { createFakeScheduler } from "../../src/serve/timer.js";
import { EXIT_USAGE } from "../../src/heartbeat/maintenance.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "opc-pump-"));
  dirs.push(d);
  return d;
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

const NOW = Date.parse("2026-03-10T08:00:00Z");
const OK_LOCK: LockAcquire = { ok: true, path: "/virtual/hub.db.lock" };

function ioOf(): { io: ServeIo; log: string[]; warn: string[] } {
  const log: string[] = [];
  const warn: string[] = [];
  return {
    log,
    warn,
    io: {
      log: (m: string): void => {
        log.push(m);
      },
      warn: (m: string): void => {
        warn.push(m);
      },
    },
  };
}

const fakeServer = (): {
  serve(d: HubDeps, p: number, b: unknown): Promise<HubServer>;
  portUsed(): number | null;
} => {
  let used: number | null = null;
  return {
    serve(_d: HubDeps, p: number, _b: unknown): Promise<HubServer> {
      used = p;
      return Promise.resolve({ port: p, close: async (): Promise<void> => {} });
    },
    portUsed: () => used,
  };
};

/**
 * 一份「有几条想法停在等章程」的库，外加一张【起草角色在上面】的组织图。
 *
 * 图必须是真的那一份形状：ensureCharterCard 会按 tasks.graph_version 读图，
 * 起草角色不在图上就返回 org_blocked 而【一分钱不烧】—— 那会让下面每一发
 * 都绿在"起草根本没跑"上。所以这张图不是脚手架细节，是这一组的前置条件。
 *
 * `alsoStalled` 种的是一条【与泵无关】的停滞任务（IN_PROGRESS + 2020 年创建）。
 * C 组要用它数"巡检有没有在起草卡住期间照跑"，而它【不能复用泵那条任务】：
 * CHARTER_PENDING 是不是活跃状态由 patrol 的判据决定，那条任务又被泵自己改动过，
 * 两个事实共用一行的话，红的时候说不清是谁坏了。
 */
function dbWithCharterTasks(ids: readonly string[], alsoStalled?: string): string {
  const path = join(tmp(), "hub.db");
  const dbh: DatabaseSync = openDb(path);
  migrate(dbh as never);
  dbh
    .prepare(INSERT_DELEGATION_GRAPH_SQL)
    .run(
      "g1",
      1,
      JSON.stringify({
        nodes: {
          ceo: { role_id: "ceo", can_manage: true, reports_to: null, model_family: "opus" },
          intake: { role_id: "intake", can_manage: true, reports_to: "ceo", model_family: "sonnet" },
        },
        edges: [],
      }),
      NOW,
      "ceo",
      "测试用组织图",
    );
  const ins = dbh.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at, graph_version) " +
      "VALUES (?, ?, 'CHARTER_PENDING', 'intake', 'intake', ?, ?, 1)",
  );
  ids.forEach((id, i) => ins.run(id, "想法 " + id, NOW + i, NOW + i));
  if (alsoStalled !== undefined) {
    dbh
      .prepare(
        "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at, graph_version) " +
          "VALUES (?, '停滞夹具', 'IN_PROGRESS', 'intake', 'intake', ?, ?, 1)",
      )
      .run(alsoStalled, Date.parse("2020-01-01T00:00:00Z"), Date.parse("2020-01-01T00:00:00Z"));
  }
  dbh.close();
  return path;
}

/**
 * 一份不 spawn 的起草回调。ok:true 那一支交出的文本要能被 parseCharterDraft 认出来，
 * 否则"起草成功"会变成"跑了而没建出卡"，而本组要断的正是【卡进了收件箱】。
 */
function cardDeps(calls: string[], o: { readonly ok?: boolean } = {}): () => CharterCardDeps {
  const ok = o.ok !== false;
  return () => ({
    runTurn: async (i) => {
      const m = /CEO 的想法：想法 (\S+)/u.exec(i.prompt);
      calls.push(m?.[1] ?? "?");
      return {
        ok,
        text: ok
          ? "业务目标：做个 AI 笔记应用\n可量化验收标准：三条\n预算上限：200 美元\n\n" +
            DECISION_MARK +
            "\n" +
            JSON.stringify({ action: "wait", summary: "章程提案已拟好，等 CEO 签署" })
          : "",
        costCents: ok ? 6 : 0,
        sessionId: null,
        error: ok ? null : "spawn claude ENOENT（夹具）",
      };
    },
    rolePrompt: (r): string => "你是角色 " + r,
  });
}

const pendingCards = (path: string): number => {
  const dbh = openDb(path);
  try {
    return Number(
      (
        dbh
          .prepare("SELECT COUNT(*) AS n FROM approvals WHERE card_key = ?")
          .get(CHARTER_CARD_KEY) as { n: number | bigint }
      ).n,
    );
  } finally {
    dbh.close();
  }
};

/** 审计里那些轮的 created_at（去重后）。F 组用它判「时刻有没有被钉在启动那一刻」。 */
const turnTimes = (path: string): number[] => {
  const dbh = openDb(path);
  try {
    const rows = dbh
      .prepare(
        "SELECT DISTINCT created_at AS t FROM events " +
          "WHERE json_extract(payload, '$.kind') = 'RoleTurnReported' ORDER BY t",
      )
      .all() as { t: number | bigint }[];
    return rows.map((r) => Number(r.t));
  } finally {
    dbh.close();
  }
};

/** 事后种一条【一定会被判停滞】的任务：活跃状态 + 2020 年创建 + 零事件。 */
function plantStalledTask(path: string, id: string): void {
  const dbh = openDb(path);
  try {
    dbh
      .prepare(
        "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at, graph_version) " +
          "VALUES (?, '停滞夹具二号', 'IN_PROGRESS', 'intake', 'intake', ?, ?, 1)",
      )
      .run(id, Date.parse("2020-01-01T00:00:00Z"), Date.parse("2020-01-01T00:00:00Z"));
  } finally {
    dbh.close();
  }
}

/** 读装配源码本身（形状守卫用）。路径按测试文件的相对位置算，不写死绝对路径。 */
function s_of_assemble(): string {
  return readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "serve", "assemble.ts"),
    "utf8",
  );
}

const happens = async (cond: () => boolean, ms = 4000): Promise<boolean> => {
  const until = Date.now() + ms;
  for (;;) {
    if (cond()) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => {
      setTimeout(r, 5);
    });
  }
};

const needOk = (r: BootResult): Extract<BootResult, { ok: true }> => {
  if (!r.ok) throw new Error("前置失败：" + r.message);
  return r;
};
const needErr = (r: BootResult): Extract<BootResult, { ok: false }> => {
  if (r.ok) throw new Error("本该失败却起来了");
  return r;
};

/** 一份「泵开着且三格齐全」的 args。目录用真的临时目录 —— 那一句警告不该由本组触发。 */
const pumpArgs = (path: string, extra: Partial<ServeArgs> = {}): ServeArgs =>
  ({
    dbPath: path,
    port: 8787,
    heartbeatMs: 60_000,
    noBackup: true,
    charterPump: true,
    maxBudgetUsd: 0.5,
    taskLimitCents: 500,
    agentCwd: tmp(),
    ...extra,
  }) as ServeArgs;

describe("A 组：默认不开 = 一分钱不花", () => {
  it("⭐ 库里有条卡在等章程的任务而【没开泵】⇒ 三个心跳之后 runTurn 零次", async () => {
    const path = dbWithCharterTasks(["t1"]);
    const calls: string[] = [];
    const s = createFakeScheduler(NOW);
    const { io } = ioOf();
    const r = needOk(
      await boot(
        { ...pumpArgs(path), charterPump: undefined, maxBudgetUsd: undefined } as ServeArgs,
        io,
        { acquire: () => OK_LOCK, serve: fakeServer().serve, scheduler: s, now: () => s.now(), pumpCardDeps: cardDeps(calls) },
      ),
    );
    s.advance(3 * 60_000);
    await r.heartbeat.tick();
    expect(await happens(() => false, 30)).toBe(false);
    expect(calls).toEqual([]);
    expect(pendingCards(path)).toBe(0);
    await r.shutdown();
  });

  it("⭐ 只注入 pumpCardDeps 而 args 里没开泵 ⇒ 注入【不算】开关", async () => {
    // 这一发防的是我自己会犯的那种错：为了让测试方便而让"注入了假起草"就等于开泵。
    // 那条后门一旦存在，--charter-pump 那条「必须显式」的立场就只是文档了：
    // 任何一层装配（Electron 主进程、将来的某个组合根）都能不带开关地把花钱的那条路打开。
    const path = dbWithCharterTasks(["t1"]);
    const calls: string[] = [];
    const s = createFakeScheduler(NOW);
    const { io, warn } = ioOf();
    const r = needOk(
      await boot({ ...pumpArgs(path), charterPump: undefined } as ServeArgs, io, {
        acquire: () => OK_LOCK,
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
        pumpCardDeps: cardDeps(calls),
        pumpMaxAttempts: 1,
      }),
    );
    await r.heartbeat.tick();
    expect(calls).toEqual([]);
    expect(warn.join(" ")).not.toContain("章程泵【已开】");
    await r.shutdown();
  });
});

describe("B 组：开了就真的建卡", () => {
  it("⭐ 泵开着 ⇒ 那条任务被起草，收件箱里【多出一张章程卡】", async () => {
    const path = dbWithCharterTasks(["t1"]);
    const calls: string[] = [];
    const s = createFakeScheduler(NOW);
    const { io, log } = ioOf();
    const r = needOk(
      await boot(pumpArgs(path), io, {
        acquire: () => OK_LOCK,
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
        pumpCardDeps: cardDeps(calls),
      }),
    );
    expect(await happens(() => calls.length === 1)).toBe(true);
    // 断【卡进了 approvals】而不是【runTurn 被调过】：后者只证明跑了一轮，
    // 而这条链的产物是【CEO 收件箱里有一张能点的卡】。
    expect(await happens(() => pendingCards(path) === 1)).toBe(true);
    expect(calls).toEqual(["t1"]);
    expect(log.join(" ")).toContain("等批");
    await r.shutdown();
  });

  it("⭐ 启动横幅说出【开了、上限是多少】，且那句「本入口不起草章程卡」不再出现", async () => {
    const path = dbWithCharterTasks(["t1"]);
    const calls: string[] = [];
    const s = createFakeScheduler(NOW);
    const { io, warn } = ioOf();
    const r = needOk(
      await boot(pumpArgs(path), io, {
        acquire: () => OK_LOCK,
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
        pumpCardDeps: cardDeps(calls),
      }),
    );
    const all = warn.join("\n");
    expect(all).toContain("章程泵【已开】");
    expect(all).toContain("0.5 美元");
    expect(all).toContain("500 美分");
    // 同一份日志里不能既说「不起草章程卡」又说「泵已开」—— 见源码里那句按 pumpOn 取措辞。
    expect(all).not.toContain("本入口【不跑角色也不起草章程卡】");
    expect(all).toContain("章程卡【由泵起草】");
    await r.shutdown();
  });

  it("⭐ 每一轮的 nowMs 取【本轮那一刻】：两轮起草的审计时刻不能相同", async () => {
    // 这一发测的是一个【看起来无害而后果具体】的写法：把 nowMs 定在启动那一刻。
    // 那样的话失败轮的 created_at 全部相等 ⇒ 事后读 events 时"这是第几次"看不出来，
    // 而那个数字正是重试上限的判据本身（charter-pump.ts 文件头那条）。
    const path = dbWithCharterTasks(["t1", "t2"]);
    const calls: string[] = [];
    const s = createFakeScheduler(NOW);
    const { io } = ioOf();
    const r = needOk(
      await boot(pumpArgs(path), io, {
        acquire: () => OK_LOCK,
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
        // ok:false ⇒ 走【留痕的那一支】（成功轮的 created_at 是卡片的，不是这一发要的）
        pumpCardDeps: cardDeps(calls, { ok: false }),
      }),
    );
    expect(await happens(() => calls.length === 2)).toBe(true);
    s.advance(60_000);
    expect(await happens(() => calls.length === 4)).toBe(true);
    const times = turnTimes(path);
    expect(times.length).toBeGreaterThan(1);
    // 反向对照：真钉死在启动那一刻时这里只有一个值。上面那条断言单独不够 ——
    // 它可能被"两轮起草撞在同一毫秒"满足，所以再判这些时刻【都晚于启动时刻】。
    expect(times.every((t) => t >= NOW)).toBe(true);
    await r.shutdown();
  });
});

describe("F 组：代码位置判据（这一段最容易【看起来接好了而其实没接】）", () => {
  it("⭐ 没配 --backup-dir ⇒ 泵【照样开】（备份那段 return 在前面的话，这一发红）", async () => {
    // 本机唯一在跑的形状就是「没配备份目录」。如果派发那一段落在
    // `if (backupDir === undefined) return` 之后，这一发的现象是：
    // 命令行写了 --charter-pump、横幅说"已开"、而收件箱永远是空的 ——
    // 一个【配置写了而没生效】的形状，且症状与"从没打算开泵"完全一样。
    const path = dbWithCharterTasks(["t1"]);
    const calls: string[] = [];
    const s = createFakeScheduler(NOW);
    const { io, warn } = ioOf();
    expect(warn.join(" ")).toBe("");
    const r = needOk(
      await boot(pumpArgs(path), io, {
        acquire: () => OK_LOCK,
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
        pumpCardDeps: cardDeps(calls),
      }),
    );
    expect(await happens(() => calls.length === 1)).toBe(true);
    await r.shutdown();
  });
});

describe("C 组：一次起草不得让巡检停摆（本篇最容易被【改对】改坏的一处）", () => {
  it("⭐ 一轮起草卡在半路时，下一次心跳【巡检照跑、泵不排队第二份】", async () => {
    // 这一发是本文件存在的理由之一。把派发写成 await（看着更"正确"：
    // "一轮的心跳里做的事，当然该等它做完"）会得到的形状是：
    //   起草最坏 180s（claude.ts:85 那个 SIGKILL）> 心跳下界 60s
    //   ⇒ ticker 走 timer.ts:335「上一轮还没结束，本轮【跳过】」
    //   ⇒ 停滞检测与每日备份被一次起草停掉，且不计失败、不触发 onFatal、不退进程。
    // 三条判据一起用，各自挡一种「看起来也测到了」：
    //  ① skipped === 0 且 warn 里没有「上一轮心跳还没结束」⇒ 那一轮【真的跑了】而不是被跳过
    //     （await 写法下这里必红：inFlight 还挂在起草上。）
    //  ② 巡检【又报了一次停滞】⇒ 不是"job 提前 return 所以什么都没做"。
    //     那条停滞任务是【第一轮之后】才种进去的，只有第二轮巡检看得见它 ——
    //     这样"第一轮顺手报过一次"就没法把这一发糊过去。
    //  ③ 泵那边 calls 仍是 1 ⇒ 挡住第二份起草的是【in_flight 那道门】，
    //     不是靠 ticker 的跳过顺手挡掉的（两件事必须各自有守卫，0036 §5 同族）。
    const path = dbWithCharterTasks(["t1"]);
    const s = createFakeScheduler(NOW);
    const { io, warn } = ioOf();
    let release: (() => void) | null = null;
    let calls = 0;
    const held = new Promise<void>((res) => {
      release = () => {
        res();
      };
    });
    const r = needOk(
      await boot(pumpArgs(path), io, {
        acquire: () => OK_LOCK,
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
        charterPumpVia: (): Promise<PumpRoundResult> => {
          calls++;
          return held.then(() => ({ cards: [], costCents: 0, abandoned: [], turns: [] }));
        },
      }),
    );
    expect(await happens(() => calls === 1)).toBe(true);
    /**
     * 等第一轮的 job 【整个返回】，而等的信号是【一个真宏任务边界】。
     *
     * 我先前在这里等的是「看见一句停滞 warn」—— 那一等【永远等不到】，
     * 因为第一轮根本【没有】停滞：库里的任务全停在 CHARTER_PENDING，而那不是活跃状态。
     * 红的方式是 happens 超时，而我第一反应是"巡检坏了"，真相是【我在等一件不会发生的事】。
     * ⇒ 等一个【由被测代码决定何时发生】的信号，永远优于等一个我觉得它该发生的信号。
     *
     * 为什么这里必须是宏任务而不是再 await 一次微任务：ticker 用
     * Promise.resolve().then(job)，而 job 里穿过一次同步 SQLite 与一次动态 import，
     * 链长是实现细节（本文件上面 happens 那段写的就是这件事）。
     * 不等就 advance 的话，自动那一轮与我这一发撞在同一轮里，skipped 变 1，
     * 而那个 1 是夹具造的 —— 一个假红会把人推去【放宽断言】，那是最坏的修法。
     */
    await new Promise((res) => {
      setTimeout(res, 10);
    });
    plantStalledTask(path, "T-STALL-2");
    const before = stallWarnCount(warn);
    // 起草【还挂着】的时候过第二个心跳。只 advance，不另手动 tick()：
    // advance 自己就会叫那一轮，再手动叫一次就是【同一轮里两个 tick】。
    s.advance(60_000);
    // 巡检在起草卡住期间照跑：那条二号停滞只有这一轮能看见。
    expect(await happens(() => stallWarnCount(warn) > before)).toBe(true);
    expect(r.heartbeat.skipped).toBe(0);
    expect(warn.join(" ")).not.toContain("上一轮心跳还没结束");
    // 而泵那一侧给出的是【在飞】那一道门，不是"又派了一份"。
    expect(calls).toBe(1);
    expect(warn.join(" ")).toContain("上一轮起草还在飞");
    release?.();
    await r.shutdown();
  });

  it("⭐ 到上限那一轮 ⇒【⭐ 章程泵不再试】那句必须响，且审计里留下放弃行", async () => {
    // 这一发补的是一个【拆掉不红】的洞：我先写完 reportPumpRound 里 gave_up 那一段，
    // 然后做变异 W10（把那句换成一句中性的"本轮结束"）⇒ 全组【照样全绿】。
    // 也就是说"最贵那一格有人被通知到"这句话当时【没有任何判据】，
    // 而那一句存在的理由正是它自己的注释写的：
    // 「CEO 必须知道而系统不会自己解决」—— 一个想法停在那儿，没人起草，泵也不试了。
    // 判据两条一起：日志里有那句（人看得见）+ 审计里有那行（事后查得到）。
    const path = dbWithCharterTasks(["t1"]);
    const calls: string[] = [];
    const s = createFakeScheduler(NOW);
    const { io, warn } = ioOf();
    const r = needOk(
      await boot(pumpArgs(path), io, {
        acquire: () => OK_LOCK,
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
        // 真泵 + 只换掉起子进程那一格；maxAttempts=1 ⇒ 本轮用完最后一次，当场判放弃。
        pumpCardDeps: cardDeps(calls, { ok: false }),
        pumpMaxAttempts: 1,
      }),
    );
    expect(await happens(() => warn.join("\n").includes("【不再试】"))).toBe(true);
    // 那句必须是【警告】而不是 log：它是唯一一种"系统不会再自己往下走"的结论。
    expect(warn.join("\n")).toContain("系统不会自己解决");
    const dbh = openDb(path);
    try {
      expect(
        Number(
          (
            dbh
              .prepare("SELECT COUNT(*) AS n FROM events WHERE json_extract(payload, '$.kind') = ?")
              .get("CharterDraftAbandoned") as { n: number | bigint }
          ).n,
        ),
      ).toBe(1);
    } finally {
      dbh.close();
    }
    await r.shutdown();
  });

  /**
   * ⭐ 这一发是【源码形状】守卫，而不是行为用例 —— 理由要读完。
   *
   * 变异 W4（把 giveUp 里的 pumpWatch.beginCancel() 挪到第一个 await 之后）
   * 在本组【打不红】，而我没把它当成"这条守卫没用"或"再想个办法撞进去"：
   * 那个缝在本进程里【构造不出来】，原因是结构性的而不是运气性的：
   *   · 要红，需要「一个 job 停在派发那一行之前」× 「giveUp 已经跑到 settle 之后」同时成立；
   *   · job 从 runPatrol 到派发之间只有【一个微任务】，中间没有任何可被我按住的 await
   *     （patrol 是同步 SQLite，pumpSettings 是启动时算好的 —— 就是为了不跨 await 拿函数）；
   *   · 让备份在飞把 settle 拖慢也不行：备份派发在泵派发【之后】，同一轮里
   *     备份在飞就意味着泵这一步已经过去了，而 ticker 又不允许两轮同时在飞。
   * ⇒ 剩下的唯一诚实做法是把这条性质钉在【源码形状】上，并说清它证不了什么：
   *   它证不了「缝里真被挡住」（那需要真信号 + 真并发，同 timer.ts 那条
   *   「不得含 setInterval」的选择、以及本仓 assemble.test.ts 那条【判定→派发零 await】
   *   守卫的同一取舍）。它挡的是【把这一行往下挪】这个具体动作，而那正是它要防的错法。
   */
  it("⭐ giveUp 里【两道 beginCancel 都在任何 await 之前】（源码形状守卫）", () => {
    const raw = s_of_assemble();
    // 先滤掉注释：区间【上方】那段解释这件事的注释里就含 beginCancel 字样，
    // 不滤会把终点匹配到注释里 ⇒ 区间被切成两行 ⇒ 判据白过（assemble.test.ts 踩过）。
    const src = raw
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
      })
      .join("\n");
    const START = "const giveUpInner = async (): Promise<void> => {";
    const a = src.indexOf(START);
    expect(a, "giveUpInner 找不到：清理出口被改名或拆开了，这一发要跟着改").toBeGreaterThan(-1);
    const region = src.slice(a, a + 900);
    const firstAwait = region.search(/\bawait\b/);
    expect(firstAwait).toBeGreaterThan(-1);
    for (const must of ["backupWatch.beginCancel()", "pumpWatch.beginCancel()"]) {
      const at = region.indexOf(must);
      expect(at, "清理路径里少了 " + must + "：关机之后【还能派新活】").toBeGreaterThan(-1);
      expect(
        at < firstAwait,
        must + " 落在了第一个 await【之后】：那条缝里一次关机能插进来，而泵会在队列关闭后写库",
      ).toBe(true);
    }
    /**
     * 反向对照：把同一份文本【自己改坏】，跑【同一个判据】，要求它现在判红。
     *
     * 我原先在这里写的是「firstAwait 必须早于 settle 那一行」—— 一条【恒假】的话，
     * 因为区间里第一个 await 就是 settle 本身，红在 136 < 136。
     * 那一次红是有价值的：它说明我那条"反向对照"根本没在对照任何事，
     * 只是把另一处事实复述了一遍。真正的对照是【构造一个坏形状看它响不响】：
     * 没有这一步，"beginCancel 在 await 之前"可能只是因为我把区间切错了
     * （切错时区间里没有 await，search 返回 -1，上面每一发都会白过）。
     */
    const brokenRegion = region.replace(
      "    pumpWatch.beginCancel();",
      "    await Promise.resolve();\n    pumpWatch.beginCancel();",
    );
    expect(brokenRegion).not.toBe(region); // 替换【必须打上】，否则这一发是恒真的
    const brokenFirstAwait = brokenRegion.search(/\bawait\b/);
    expect(
      brokenRegion.indexOf("pumpWatch.beginCancel()") < brokenFirstAwait,
      "反向对照失效：把 beginCancel 挪到 await 之后，这个判据仍然判它合规",
    ).toBe(false);
  });

  it("⭐ 泵一整轮抛 ⇒ 说一句【本轮没有结论】，而心跳【不因此计一次失败】", async () => {
    // 与「一张卡起草失败」是两层不同的东西：那一层由泵自己记审计。
    // 这一层要的是：坏的是泵本身（候选 SQL 都跑不了）时，人看得见这句话，
    // 而【停滞检测不该被它连坐】—— 所以 consecutiveFailures 必须是 0。
    const path = dbWithCharterTasks(["t1"]);
    const s = createFakeScheduler(NOW);
    const { io, warn } = ioOf();
    const r = needOk(
      await boot(pumpArgs(path), io, {
        acquire: () => OK_LOCK,
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
        charterPumpVia: (): Promise<PumpRoundResult> => Promise.reject(new Error("no such table: tasks（夹具）")),
      }),
    );
    expect(await happens(() => warn.join(" ").includes("本轮没有结论"))).toBe(true);
    expect(warn.join(" ")).toContain("no such table: tasks（夹具）");
    expect(r.heartbeat.consecutiveFailures).toBe(0);
    expect(r.heartbeat.stopped).toBe(false);
    await r.shutdown();
  });
});

describe("D 组：关机等到起草落地", () => {
  it("⭐ 起草在飞时 shutdown ⇒ 【等它落地才关队列】，并先说一声在等什么", async () => {
    // 不等会怎样：泵的每一笔写入都走 q.node(...)，而 giveUp 后面就是 queue.close()
    // 与 releaseLock ⇒ 一次起草会写进一个【已关的队列 / 已还的锁】，
    // 那期间另一个 Hub 可以起开并写同一个库（与备份那一条 ① 是同一个事故）。
    const path = dbWithCharterTasks(["t1"]);
    const s = createFakeScheduler(NOW);
    const { io, warn } = ioOf();
    let release: (() => void) | null = null;
    let calls = 0;
    let closed = false;
    const real = new WriteQueue(path);
    const orig = real.close.bind(real);
    real.close = (async (): Promise<void> => {
      closed = true;
      await orig();
    }) as typeof real.close;
    const r = needOk(
      await boot(pumpArgs(path), io, {
        acquire: () => OK_LOCK,
        // 注入队列【不是】为了省事：这一发要读的正是「close 有没有在起草落地之前被叫」。
        openQueue: () => real,
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
        charterPumpVia: (): Promise<PumpRoundResult> => {
          calls++;
          return new Promise<PumpRoundResult>((res) => {
            release = () => {
              res({ cards: [], costCents: 0, abandoned: [], turns: [] });
            };
          });
        },
      }),
    );
    // 「确实有一份在飞」这条前置【必须真的断言】。
    // 我先前在这里写的是 happens(() => ... || true) —— 一个恒真的等，
    // 那种写法在"泵压根没被派发"的世界里照样绿，而那正是这一发要抓的坏。
    expect(await happens(() => calls === 1)).toBe(true);
    const shutting = r.shutdown();
    // 「在等什么」必须说出来：一句承诺了六步停止顺序的横幅后面藏着最坏三分钟，
    // 读的人会以为进程卡死而去 kill -9 —— 那一步才会真留下没关的连接与半个事务。
    expect(await happens(() => warn.join(" ").includes("等它落地再关队列"))).toBe(true);
    // 起草还没放行 ⇒ 队列【不许】被关。
    await new Promise((res) => setTimeout(res, 20));
    expect(closed).toBe(false);
    release?.();
    await shutting;
    expect(closed).toBe(true);
  });
});

describe("E 组 / 纯函数：上限缺失时不能起", () => {
  it("⭐ pumpBoundsOf：没开泵与开了而配置坏是【两种结论】", () => {
    // 合成一种（比如 `Pick<...> | null`）之后调用方得自己再判一次 charterPump，
    // 那就是【两个来源判同一件事】—— 本文件与 0043 §4 都为此付过钱。
    const off = pumpBoundsOf({ charterPump: undefined } as ServeArgs);
    expect(off).toEqual({ ok: false, reason: "not_pumped" });
    const bad = pumpBoundsOf({ charterPump: true } as ServeArgs);
    expect(bad.ok).toBe(false);
    if (bad.ok === false && bad.reason === "invalid") {
      expect(bad.bad.length).toBe(3);
    } else {
      throw new Error("三格全缺时必须给出 invalid 与三条原因");
    }
  });

  it("每一格单独坏 ⇒ 只点名那一格（三条一起报会让人以为自己三处都写错了）", () => {
    const full = { charterPump: true, maxBudgetUsd: 0.5, taskLimitCents: 500, agentCwd: "/tmp/w" };
    expect(pumpBoundsOf(full as ServeArgs).ok).toBe(true);
    const one = (drop: string): string => {
      const a = { ...full } as Record<string, unknown>;
      delete a[drop];
      const r = pumpBoundsOf(a as ServeArgs);
      if (r.ok === false && r.reason === "invalid") {
        expect(r.bad.length).toBe(1);
        return r.bad[0] as string;
      }
      throw new Error("应该只有这一格坏");
    };
    expect(one("maxBudgetUsd")).toContain("--max-budget-usd");
    expect(one("taskLimitCents")).toContain("--task-limit-cents");
    expect(one("agentCwd")).toContain("--agent-cwd");
    // 形状判据：Infinity 是「没有上限的上限」，小数美分不是整数。
    const inf = pumpBoundsOf({ ...full, maxBudgetUsd: Number.POSITIVE_INFINITY } as ServeArgs);
    expect(inf.ok).toBe(false);
    expect(pumpBoundsOf({ ...full, taskLimitCents: 500.5 } as ServeArgs).ok).toBe(false);
    expect(pumpBoundsOf({ ...full, agentCwd: "   " } as ServeArgs).ok).toBe(false);
    // 0 是【允许】的（有人要把上限设成"一分都不许花"来验证形状）。
    expect(pumpBoundsOf({ ...full, maxBudgetUsd: 0 } as ServeArgs).ok).toBe(true);
  });

  it("⭐ boot 那一发：泵开着而缺上限 ⇒ 退 2，且【不监听】", async () => {
    const path = dbWithCharterTasks(["t1"]);
    const { io, warn } = ioOf();
    const srv = fakeServer();
    const r = needErr(
      await boot(
        { ...pumpArgs(path), maxBudgetUsd: undefined } as ServeArgs,
        io,
        { acquire: () => OK_LOCK, serve: srv.serve },
      ),
    );
    expect(r.code).toBe(EXIT_USAGE);
    // 判的是【返回值 r.message】而不是 io.warn —— boot 的契约是「不抛、失败翻成
    // {ok:false, code, message}」，把 message 说出来的是【入口】(runServeCli)，
    // 而这一发直接调 boot。断错通道会得到一句"warn 里没有"的红，
    // 那次红会教人去做【错的那件修法】（往 boot 里加一句 warn，于是同一句话两处说）。
    expect(r.message).toContain("--max-budget-usd");
    expect(r.message).toContain("不能起");
    // 走到 boot 说明 args 是直接构造的（Electron 那条路），这一发证明这一层【也有】判据。
    expect(srv.portUsed()).toBeNull();
  });

  it("--agent-cwd 指向不存在的目录 ⇒ 【警告而照开】，不是拒启动", async () => {
    // 判"致命"看着更严，实际少说话：真那一发会在审计里留下【每一次为什么没成】的原文，
    // 并且试到上限自己停（会收敛）；拒启动只留下一句"目录不存在"。
    const path = dbWithCharterTasks(["t1"]);
    const calls: string[] = [];
    const s = createFakeScheduler(NOW);
    const { io, warn } = ioOf();
    const r = needOk(
      await boot(pumpArgs(path, { agentCwd: join(tmp(), "没有这个目录") }), io, {
        acquire: () => OK_LOCK,
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
        pumpCardDeps: cardDeps(calls),
      }),
    );
    expect(warn.join(" ")).toContain("【不存在】");
    expect(await happens(() => calls.length === 1)).toBe(true);
    await r.shutdown();
  });
});

describe("H 组：花钱的门挡住时【终端上要有声音】", () => {
  /**
   * ⚠ 这一组判的不是【门】（那是 charter-pump.test.ts I 组的四发），
   * 而是【门挡了之后有没有人知道】。这两件事分开是因为它们会【各自单独坏】：
   * 泵可以正确地不花钱、正确地不建卡、正确地写库，而那个人看到的画面
   * 与「泵根本没开」【完全一样】—— 收件箱空的、任务不动、终端安静。
   * 本仓给这一族起过名字（0044 §8 的 W10：「一条系统不再自己解决的事实只在库里
   * 而不在终端上，等于只有 grep 得动它的人才知道」），而门这一格比那一格更糟：
   * gave_up 三次就完，门【只要不追加预算就一直挡着】。
   */
  it("⭐ 超限的任务【不起子进程】而那句理由【说出来了】", async () => {
    const path = dbWithCharterTasks(["t1"]);
    spendIn(path, "t1", 150);
    const calls: string[] = [];
    const s = createFakeScheduler(NOW);
    const { io, warn } = ioOf();
    const r = needOk(
      await boot(pumpArgs(path, { taskLimitCents: 100 }), io, {
        acquire: () => OK_LOCK,
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
        pumpCardDeps: cardDeps(calls),
      }),
    );
    s.advance(60_000);
    await r.heartbeat.tick();
    expect(await happens(() => warn.join("\n").includes("花钱的门关着"))).toBe(true);
    // 三样一起断，缺一样都可能是"巧合地绿"：
    //  ① 一次都没起草（门真的挡住了）
    expect(calls).toEqual([]);
    //  ② 卡没建出来（挡的结果落在收件箱上）
    expect(pendingCards(path)).toBe(0);
    //  ③ 那句话带【该干嘛】—— 只说"没钱"而不说能做什么，下一步仍然是查代码
    const line = warn.join("\n");
    expect(line).toContain("追加预算");
    expect(line).toContain("想法 t1");
    expect(line).toContain("150");
    await r.shutdown();
  });

  it("⭐ 同一条任务【只说一次】：每心跳重复说等于把信号淹掉", async () => {
    // 泵每 60 秒一轮，而一条超限的想法会【永远】被挡 ⇒ 不说会沉默，
    // 每轮都说会一天 1440 句 —— 后者的真实后果是这个人把终端静音，
    // 于是那句只说一次的「不再试了」（gave_up）也一起被静音。
    const path = dbWithCharterTasks(["t1"]);
    spendIn(path, "t1", 150);
    const calls: string[] = [];
    const s = createFakeScheduler(NOW);
    const { io, warn } = ioOf();
    const r = needOk(
      await boot(pumpArgs(path, { taskLimitCents: 100 }), io, {
        acquire: () => OK_LOCK,
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
        pumpCardDeps: cardDeps(calls),
      }),
    );
    for (let i = 0; i < 5; i++) {
      s.advance(60_000);
      await r.heartbeat.tick();
    }
    expect(await happens(() => warn.join("\n").includes("花钱的门关着"))).toBe(true);
    const said = warn.filter((m) => m.includes("花钱的门关着")).length;
    expect(said).toBe(1);
    // 反向对照：确实跑了 5 轮（否则"只说一次"可能只是"只跑了一次"）。
    // 这一句是这一发的分母 —— 少了它，去重与早退不可区分。
    expect(s.now()).toBeGreaterThan(NOW + 4 * 60_000);
    expect(calls).toEqual([]);
    await r.shutdown();
  });

  it("⭐【没超限】时不说这句话（反向对照：上面两发不是恒绿）", async () => {
    const path = dbWithCharterTasks(["t1"]);
    const calls: string[] = [];
    const s = createFakeScheduler(NOW);
    const { io, warn } = ioOf();
    const r = needOk(
      await boot(pumpArgs(path, { taskLimitCents: 100_000 }), io, {
        acquire: () => OK_LOCK,
        serve: fakeServer().serve,
        scheduler: s,
        now: () => s.now(),
        pumpCardDeps: cardDeps(calls),
      }),
    );
    s.advance(60_000);
    await r.heartbeat.tick();
    expect(await happens(() => calls.length === 1)).toBe(true);
    expect(warn.join("\n")).not.toContain("花钱的门关着");
    await r.shutdown();
  });
});

/**
 * 事后给某条任务种一笔【已花掉的钱】（写 budgets，也就是门与今日视图那条预算条
 * 共用的那一列）。真路径下 budgets 与 tasks.consumed_cents 由同一轮一起写，
 * 所以这里只写一处不会与生产不一致 —— 而【门读哪一列】由 charter-pump.test.ts
 * I 组那发专门的对照判，不在这里重复。
 */
function spendIn(path: string, taskId: string, cents: number): void {
  const dbh = openDb(path);
  try {
    dbh
      .prepare(
        "INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, consumed_cents, hard_stop) " +
          "VALUES (?, 'task', ?, 'per_task', ?, ?, 1) " +
          "ON CONFLICT(scope_type, scope_id, period) DO UPDATE SET consumed_cents = excluded.consumed_cents",
      )
      .run("task|" + taskId + "|per_task", taskId, cents, cents);
  } finally {
    dbh.close();
  }
}

/**
 * 「巡检报过停滞」的计数。
 *
 * 为什么不直接数日志里那句「巡检：本轮新增停滞」出现几次就能判：
 * 停滞判定只对【活跃状态且很久没动过】的任务成立，而泵建卡之后那条任务可能
 * 被别的读法改动 updated_at。所以这一组用一条【专门种的停滞任务】，
 * 与泵的那条任务分开 —— 两个事实共用一行的话，红的时候分不清是谁坏了。
 */
function stallWarnCount(warn: readonly string[]): number {
  return warn.filter((m) => m.includes("巡检：本轮新增停滞")).length;
}
const stalledWarned = (warn: readonly string[]): boolean => stallWarnCount(warn) > 0;
