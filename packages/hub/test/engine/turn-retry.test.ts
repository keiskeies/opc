/**
 * 角色轮重试外壳（engine/turn-retry.ts）—— 哪些失败被放行、哪些必须一次都不重试。
 *
 * ── 为什么对面是一个【注入的假执行器】而不是真 CLI ──────────────────
 * 这一层要测的是【判据】：started + errno 两格决定放不放行、退避多久、发几条 warn。
 * 判据必须在能枚举的输入上逐条测 —— 而真的那一族里【该重试】的那些（EMFILE / ENFILE /
 * EAGAIN）要把系统资源真打满才出得来，本轮【没有制造它】（round305 台账 §③）。
 * 所以：判据在这里用假 run 穷尽测；真跨进程的那一发在 runtime 那一族里跑的是
 * ENOENT 那一支（不重试 + 对 dispatch 透明），那是本机唯一能真造出来的 started:false。
 * ⚠ 这句话是本文件全部的边界：下面那些"重试了 4 次"的用例证的是【判据与执行器】，
 *   不是【真机会自愈】。白名单里那五个名字一个真样本都没有。
 *
 * ── 与 runtime 那层的分工 ───────────────────────────────────────────
 *  runtime.test.ts「runtime 跑一轮」那一族测装配（SQL、记账、留痕）；
 *  本文件测判据。两边不重复：本文件一条 SQL 都不碰，
 *  「重试期间不多记一笔账」由文件最后那发真 dispatch 的用例钉在【真表】上。
 */
import { describe, expect, it } from "vitest";

import type { RoleRunInput, RoleRunResult } from "../../src/engine/claude.js";
import { SPAWN_TRANSIENT_ERRNOS } from "../../src/engine/claude.js";
import {
  runTurnWithRetry,
  type TurnRetryHooks,
} from "../../src/engine/turn-retry.js";

const INPUT: RoleRunInput = {
  prompt: "把登录模块做完",
  rolePrompt: "你是测试工程师。",
  cwd: ".",
  maxBudgetUsd: 0.5,
};

/** 造一次执行的返回值。默认是「成功」，各发只改自己要的那一格。 */
function result(o: Partial<RoleRunResult>): RoleRunResult {
  return {
    ok: true,
    text: "done",
    sessionId: "sess-1",
    costUsd: 0.04,
    error: null,
    started: true,
    spawnErrno: "",
    ...o,
  };
}

/**
 * 取脚本里第 n 个结果，用完之后【粘在最后一条】上。
 *
 * 为什么粘而不是越界抛：下面多数用例只关心「前 3 次全失败」，第 4 次返回什么
 * 与判据无关。但粘必须是【显式的一格】而不是 `??` 顺手写的 ——
 * results 为空时 `??` 会把 undefined 交出去，那一发的红会落在
 * 「r.ok 是 undefined」而不是「脚本没给结果」，那是本仓归档过的误导形状。
 */
function nth(results: readonly RoleRunResult[], at: number): RoleRunResult {
  const r = results[Math.min(at, results.length - 1)];
  if (r === undefined)
    throw new Error("脚本是空数组：没有任何一次调用的返回值");
  return r;
}

/**
 * 一个【记录一切】的执行器：每次调用返回脚本里的第 n 个结果，
 * 同时把调用次数、sleep 的时长、warn 的文案全部记下来。
 *
 * 为什么 sleep 记时长而不真等：MAX_RETRIES=3 ⇒ 真等要 1+2+4=7 秒，
 * 而区间断言（「delay ≥ 1000」）对「退避根本没生效」没有鉴别力
 * （heartbeat/retry.ts 的 backoffMs 把抖动做成必注入是同一条理由）。
 */
function harness(results: readonly RoleRunResult[]): {
  calls: number;
  sleeps: number[];
  warns: string[];
  run: (i: RoleRunInput) => Promise<RoleRunResult>;
  hooks: TurnRetryHooks;
} {
  const h = {
    calls: 0,
    sleeps: [] as number[],
    warns: [] as string[],
    run: async (i: RoleRunInput): Promise<RoleRunResult> => {
      h.calls += 1;
      // 记录【传进去的输入】是不是同一个对象：重试必须复用同一份输入，
      // 若哪天有人给每次尝试换一个新 session/prompt，这里能看出来。
      expect(i).toBe(INPUT);
      return nth(results, h.calls - 1);
    },
    hooks: {
      sleep: async (ms: number): Promise<void> => {
        h.sleeps.push(ms);
      },
      onRetryWarn: (m: string): void => {
        h.warns.push(m);
      },
    } satisfies TurnRetryHooks,
  };
  return h;
}

/** 名单【本体】的字面量副本。改名单必须同时改这里 —— 见下面的逐字比对。 */
const EXPECTED_TRANSIENT = [
  "EAGAIN",
  "EMFILE",
  "ENFILE",
  "ECONNRESET",
  "EPIPE",
];

describe("runTurnWithRetry —— 只重试结构上零花费的失败", () => {
  it("瞬时 errno + 进程从未起来 ⇒ 退避重试，退避序列是 1s/2s/4s，额度用尽后交出最后那次", async () => {
    const h = harness([
      result({
        ok: false,
        text: "",
        started: false,
        spawnErrno: "EMFILE",
        costUsd: 0,
        error: "起不来",
      }),
    ]);
    const r = await runTurnWithRetry(h.run, INPUT, h.hooks);
    // 1 次首跑 + 3 次重试 = 4。上界由 withRetry 的 1 + MAX_RETRIES 保证。
    expect(h.calls).toBe(4);
    expect(h.sleeps).toEqual([1000, 2000, 4000]);
    expect(h.warns.length).toBe(3);
    // 交出的是【最后那一次的 result】，dispatch 因此看不出任何形状差异。
    expect(r.ok).toBe(false);
    expect(r.error).toBe("起不来");
    expect(r.started).toBe(false);
  });

  it("⭐ 确定性失败（ENOENT：二进制不存在）⇒ 一次都不重试", async () => {
    // 这一发是【今天真机上唯一会真的发生】的那一支：本机可复现的 started:false 全是它。
    const h = harness([
      result({
        ok: false,
        started: false,
        spawnErrno: "ENOENT",
        costUsd: 0,
        error: "没有这个二进制",
      }),
    ]);
    const r = await runTurnWithRetry(h.run, INPUT, h.hooks);
    expect(h.calls, "ENOENT 是确定性的：重试第 4 次与第 1 次一模一样").toBe(1);
    expect(h.sleeps).toEqual([]);
    expect(h.warns).toEqual([]);
    expect(r.error).toBe("没有这个二进制");
  });

  it("⭐ 花了钱的失败 ⇒ 一次都不重试（判据不看「有没有记到钱」，看「起过进程没有」）", async () => {
    // started:true + costUsd>0 = CLI 真跑起来了而报了业务错，钱真花了。
    // 这一族今天【不】重试；将来若要接，必须先改成每次尝试各自记账（turn-retry 文件头）。
    const h = harness([
      result({
        ok: false,
        started: true,
        costUsd: 0.31,
        error: "budget exceeded",
      }),
    ]);
    await runTurnWithRetry(h.run, INPUT, h.hooks);
    expect(h.calls, "重试一次 = 再花一次钱").toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  /**
   * ⭐ 这一发是【照着头脑里的变异推出来的】，机器随后确认了它承重。
   *
   * 推演过程（写在台账 round305 §⑥）：M1 要把 retryableWithoutCost 里的 `r.started`
   * 整格抹掉，判据退化成「只看 errno 名单」。先把现有 10 发在【抹掉之后】各读一遍：
   * 每一发 started:true 的失败，它的 spawnErrno 恰好【全是空串】⇒ 名单那一半先把它们
   * 挡住了 ⇒ 【十条一发都不红】。「两条都要成立」里的第一条一次都没单独被要求过。
   * 所以补了下面这一发，然后才第一次跑那台机器 ⇒ 实测 M1 红在这里（7/7）。
   * ⚠ 别把这一发读成「变异机跑出了它」：机器【验证】了它承重，发现它的是读判据。
   *   两者的差别很重要 —— 前者说明测试够，后者说明【原来那一版不够】。
   *
   * 补上的一发形状是【两条各站一边】：errno 在瞬时名单上（第二条成立）而进程起过
   * （第一条不成立）⇒ 结论必须是不重试。
   * ⚠ 这一型真机【造不出来】：本机实测 started:true 的失败全是 CLI 业务错，
   *   errno 恒空。它钉的是【判据的形状】，不是「真机会长这样」。
   */
  it("⭐ 起过进程 + 瞬时 errno ⇒ 仍不重试（两条都要成立，名单不能单独放行）", async () => {
    const h = harness([
      result({
        ok: false,
        started: true,
        spawnErrno: "EMFILE",
        costUsd: 0.31,
        error: "起来之后 fd 断了",
      }),
    ]);
    const r = await runTurnWithRetry(h.run, INPUT, h.hooks);
    expect(h.calls, "起过进程 = 可能花了钱，与 errno 瞬不瞬时无关").toBe(1);
    expect(h.sleeps).toEqual([]);
    expect(h.warns).toEqual([]);
    expect(r.error).toBe("起来之后 fd 断了");
  });

  it("⭐ 「没记到钱」不等于「没花钱」：超时那一支 costUsd=0 而 started=true ⇒ 不重试", async () => {
    // 被 SIGKILL 的进程没机会报账 ⇒ 那个 0 的含义是【未知】。
    // 如果判据写成 costUsd === 0，这一发会被放行重试，而它可能已经烧了几十万 token。
    const h = harness([
      result({
        ok: false,
        text: "",
        started: true,
        spawnErrno: "",
        costUsd: 0,
        error: "执行超时，已杀死该角色进程",
      }),
    ]);
    const r = await runTurnWithRetry(h.run, INPUT, h.hooks);
    expect(h.calls, "超时的成本是【未知】而不是零").toBe(1);
    expect(r.error).toMatch(/超时/);
  });

  it("名单外的 errno 一律不放行（白名单而不是黑名单）", async () => {
    // 逐个试：认错的代价不对称 —— 漏一个瞬时错 = 少重试一次（今天的行为，无损），
    // 多放一个确定性错 = 每轮白等 1+2+4 秒并多三条 warn。
    for (const errno of [
      "EPERM",
      "EACCES",
      "EFTYPE",
      "EISDIR",
      "ENOEXEC",
      "",
    ]) {
      const h = harness([
        result({
          ok: false,
          started: false,
          spawnErrno: errno,
          costUsd: 0,
          error: "起不来",
        }),
      ]);
      await runTurnWithRetry(h.run, INPUT, h.hooks);
      expect(h.calls, "errno=" + errno + " 不在瞬时表上，不该重试").toBe(1);
    }
  });

  it("⭐ 瞬时名单逐字钉住：名单与测试的字面量必须同时改", async () => {
    // 若下面的循环改成遍历模块导出的那份名单，期望值会跟着名单一起变 ——
    // 那等于把「有人偷偷往名单里塞 ENOENT」这件事测不出来（同一处理见
    // test-inventory.test.ts 的 IGNORED_DIRS 那一层）。
    expect([...SPAWN_TRANSIENT_ERRNOS].sort()).toEqual(
      [...EXPECTED_TRANSIENT].sort(),
    );
    // 反向 canary：ENOENT【不能】在名单里。它是本机唯一真造得出来的那一型，
    // 一旦有人把它塞进去，每次装配错 bin 都会白烧 4 次 spawn + 7 秒退避。
    expect(SPAWN_TRANSIENT_ERRNOS).not.toContain("ENOENT");
    // 逐个名字真的放行（不只比字符串相等）：名单被改成恒放行也要红。
    for (const errno of EXPECTED_TRANSIENT) {
      const h = harness([
        result({
          ok: false,
          started: false,
          spawnErrno: errno,
          costUsd: 0,
          error: "起不来",
        }),
      ]);
      await runTurnWithRetry(h.run, INPUT, h.hooks);
      expect(h.calls, errno + " 在名单上 ⇒ 必须放行重试").toBe(4);
    }
  });

  it("成功 ⇒ 一次调用、零 sleep、零 warn（正常返回绝不重试）", async () => {
    const h = harness([result({})]);
    const r = await runTurnWithRetry(h.run, INPUT, h.hooks);
    expect(h.calls).toBe(1);
    expect(h.sleeps).toEqual([]);
    expect(h.warns).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("中途起来 ⇒ 立刻交出去，不多跑一次", async () => {
    const h = harness([
      result({
        ok: false,
        started: false,
        spawnErrno: "EMFILE",
        costUsd: 0,
        error: "fd 用完",
      }),
      result({
        ok: false,
        started: false,
        spawnErrno: "EMFILE",
        costUsd: 0,
        error: "还没缓过来",
      }),
      result({
        ok: true,
        text: "这轮成了",
        sessionId: "sess-9",
        costUsd: 0.02,
      }),
    ]);
    const r = await runTurnWithRetry(h.run, INPUT, h.hooks);
    expect(h.calls).toBe(3);
    expect(h.sleeps).toEqual([1000, 2000]);
    expect(r.text).toBe("这轮成了");
    expect(r.sessionId).toBe("sess-9");
  });

  it("⭐ 执行器自己 reject ⇒ 原样抛回，不包成失败轮也不重试", async () => {
    // 实测本机：bin 指着一个普通文件时 node 从 spawn() 【同步】抛 EFTYPE，
    // 被 Promise 构造器吞成 rejection（见 claude.ts 的 spawnErrno 注释）。
    // 那是【装配错 bin】= 确定性 bug。把它转成正常失败轮会把「hub 起不来」
    // 降级成「任务一直失败」—— 更难查的方向。今天保持响亮崩溃。
    const boom = Object.assign(new Error("同步抛出"), { code: "EFTYPE" });
    let calls = 0;
    const warns: string[] = [];
    await expect(
      runTurnWithRetry(
        async (): Promise<RoleRunResult> => {
          calls += 1;
          throw boom;
        },
        INPUT,
        { sleep: async () => {}, onRetryWarn: (m) => warns.push(m) },
      ),
    ).rejects.toBe(boom);
    expect(calls, "确定性装配错误不该退避 4 次").toBe(1);
    expect(warns).toEqual([]);
  });

  it("warn 只说坐标：第几次、errno、退避多久，一个字的 prompt / stderr 都不带", async () => {
    // 这一条会进 stderr/日志，而【日志也是一处日志】（O11 那条「错误字符串里不许
    // 出现请求体」同口径）。prompt 由 CEO 输入，可能带业务机密。
    const h = harness([
      result({
        ok: false,
        started: false,
        spawnErrno: "EMFILE",
        costUsd: 0,
        error: "stderr 里有一串机密：hunter2",
      }),
    ]);
    await runTurnWithRetry(h.run, INPUT, h.hooks);
    expect(h.warns.length).toBe(3);
    for (const w of h.warns) {
      expect(w).toContain("EMFILE");
      expect(w).not.toContain("hunter2");
      expect(w).not.toContain("把登录模块做完");
      expect(w).not.toContain("你是测试工程师");
    }
    expect(h.warns[0]).toContain("重试 1");
    expect(h.warns[2]).toContain("重试 3");
  });
});
