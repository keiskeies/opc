/**
 * gateway-runner 的三态映射测试（2026-11，Step A）。
 *
 * runner 的全部判据是那张四格出口表（gateway-runner.ts 文件头）：
 *   gateway 拒（适配器没跑）/ 进程没起 / 起了但业务错 / 全绿。
 * 前两格的关键在【不可重试性】：安全拒与 ENOENT 都必须让
 * retryableWithoutCost(结果) === false —— 前者靠 spawnErrno 空串，
 * 后者靠 ENOENT 不在瞬时白名单上。这一族用【真桩进程 + 真 gateway】跑，
 * 不用 mock runRole：判据的价值恰在跨真接缝不破。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessRequest, HarnessRequestInput } from "@opc/contracts";
import { harnessRequestSchema } from "@opc/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { retryableWithoutCost } from "../../src/engine/claude.js";
import type { AuditRow } from "../../src/events/recorder.js";
import type { HarnessCallPayload } from "../../src/harness/gateway.js";
import {
  buildGatewayDeps,
  runViaGateway,
} from "../../src/harness/gateway-runner.js";

// 本文件在 test/harness/ 下（适配器测试在它的 adapters/ 子目录里，相对深度差一层）。
const BIN = fileURLToPath(
  new URL("./fixtures/spy-claude.mjs", import.meta.url),
);
/** 与适配器测试同一 Windows 说明：gateway 要 / 开头，node 把它归一到当前盘。 */
mkdirSync("/tmp", { recursive: true });
const WS = mkdtempSync("/tmp/opc-stepA-rn-");
const MARK = join(WS, "ran.marker");

beforeAll(() => {
  // 桩的控制面走环境变量（runRole 原样透传 process.env，这是既有形状）。
  // SPY_MARK 必须【设上】：「安全拒 ⇒ 桩没被执行」那几发断的是这个文件不在，
  // 不设的话文件永远不会出现，断言恒真（恒过的判据 = 没有判据）。
  process.env["SPY_MARK"] = MARK;
});
afterAll(() => {
  rmSync(WS, { recursive: true, force: true });
  delete process.env["SPY_MARK"];
});

function req(over: Partial<HarnessRequestInput> = {}): HarnessRequest {
  return harnessRequestSchema.parse({
    task_id: "t-rn",
    role_id: "dev",
    instruction: "把这件事做完",
    workspace: WS,
    sandbox: "read-only",
    approval_policy: "never",
    allowed_tools: ["Read"],
    forbidden_flags: ["--dangerously-skip-permissions"],
    requested_args: [],
    max_budget_usd: 0.5,
    ...over,
  });
}

function deps(over: Partial<Parameters<typeof runViaGateway>[2]> = {}) {
  const rows: AuditRow[] = [];
  return {
    rows,
    d: {
      audit: (row: AuditRow): number => {
        rows.push(row);
        return rows.length;
      },
      charterHarnessDefaults: {},
      ...over,
    },
  };
}

const OPTS = { bin: BIN, timeoutMs: 20_000 };

/**
 * 抓异常并原样交出（断言消息内容用）。与 roles/charter.test.ts 同名同形 helper 一致 ——
 * 不用 `toThrow(/re/)` 是因为那只能证「匹配上了」，证不了「消息里有点名的键名」，
 * 而点名键名正是下面那几发的全部价值（读者是「库里存了一份坏岗位书」的人）。
 */
function grab(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("期望抛错，但函数正常返回了");
}

describe("runViaGateway —— 出口表", () => {
  it("全绿：ok:true + text + sessionId + 美分→美元一处换算", async () => {
    const { d } = deps();
    const r = await runViaGateway(OPTS, req(), d);
    expect(r.ok, String(r.error)).toBe(true);
    expect(r.sessionId).toBe("sess-1");
    // 桩报 0.042 美元 → 适配器 4 美分 → runner 除回 0.04。
    // 半美分精度损失是【记账口径】的既定代价（CostReport 用美分的理由），钉死它。
    expect(r.costUsd).toBeCloseTo(0.04, 10);
    expect(r.started).toBe(true);
    expect(r.spawnErrno).toBe("");
    expect(r.text).toContain("桩的汇报");
  });

  it("forbidden_flags 命中 ⇒ ok:false、started:false、spawnErrno 空串【且桩没被执行】", async () => {
    rmSync(MARK, { force: true });
    const { d, rows } = deps();
    const r = await runViaGateway(
      OPTS,
      req({ requested_args: ["--dangerously-skip-permissions"] }),
      d,
    );
    expect(r.ok).toBe(false);
    expect(r.started).toBe(false);
    expect(r.spawnErrno).toBe("");
    // 空串的语义是【没有过 spawn 尝试】，同时它是判据的输入：
    expect(retryableWithoutCost(r), "安全拒必须不可自动重试").toBe(false);
    // 盘上证据：拒绝发生在进程之前。
    expect(existsSync(MARK), "安全拒时桩不得被执行").toBe(false);
    expect(
      rows.some((x: AuditRow): boolean => x.action === "unauthorized_attempt"),
    ).toBe(true);
  });

  it("预算 checkBudget 报 over ⇒ 同样不可重试、桩不执行、账不落 settle", async () => {
    rmSync(MARK, { force: true });
    let settled = 0;
    const { d } = deps({
      checkBudget: () => ({ over: true, spentCents: 500, limitCents: 500 }),
      settle: () => {
        settled += 1;
      },
    });
    const r = await runViaGateway(OPTS, req(), d);
    expect(r.ok).toBe(false);
    expect(r.error ?? "").toContain("budget_exceeded");
    expect(retryableWithoutCost(r)).toBe(false);
    expect(existsSync(MARK), "预算拒时桩不得被执行").toBe(false);
    expect(settled).toBe(0);
  });

  it("grantedSandbox 缺省 read-only：岗位书没写那一格 ⇒ 请求 workspace-write 被拒", async () => {
    const { d } = deps();
    const r = await runViaGateway(OPTS, req({ sandbox: "workspace-write" }), d);
    expect(r.ok).toBe(false);
    expect(r.error ?? "").toContain("safety_blocked");
    expect(retryableWithoutCost(r)).toBe(false);
  });

  it("started:false + ENOENT 透出 ⇒ 三态里「进程没起」可分，且 ENOENT 确定性 ⇒ 不放行", async () => {
    const { d } = deps();
    const r = await runViaGateway(
      { bin: join(WS, "no-such-claude"), timeoutMs: 5000 },
      req(),
      d,
    );
    expect(r.ok).toBe(false);
    expect(r.started).toBe(false);
    expect(r.spawnErrno).toBe("ENOENT");
    expect(
      retryableWithoutCost(r),
      "确定性失败不该重试（claude.ts 白名单判）",
    ).toBe(false);
  });

  it("起了进程但 gateway 仍拒（CLI 没给会话）⇒ started:true 可分，不可重试", async () => {
    process.env["SPY_MODE"] = "nosession";
    try {
      const { d } = deps();
      const r = await runViaGateway(OPTS, req(), d);
      expect(r.ok).toBe(false);
      expect(r.error ?? "").toContain("no_session");
      expect(r.started, "进程起过：与「gateway 拒于进程之前」必须可分").toBe(
        true,
      );
      expect(retryableWithoutCost(r)).toBe(false);
    } finally {
      delete process.env["SPY_MODE"];
    }
  });

  it("CLI 业务错 ⇒ ok:false、started:true、账透出而不是抹零", async () => {
    process.env["SPY_MODE"] = "error";
    try {
      const { d, rows } = deps();
      const r = await runViaGateway(OPTS, req(), d);
      expect(r.ok).toBe(false);
      expect(r.started).toBe(true);
      expect(r.costUsd).toBeCloseTo(0.04, 10);
      // 审计侧的美分账【也】钉住：harness_call.spent_cents 来自适配器 usage 事件的
      // 美分换算（不是 runner 透传的那份美元）。变异机 M3 实测「只钉 costUsd」时
      // 换算刀打不红这一发 —— 两条账各钉一条，换算段才真被覆盖。
      const calls = rows
        .filter((x: AuditRow): boolean => x.action === "harness_call")
        .map(
          (x: AuditRow): HarnessCallPayload => x.payload as HarnessCallPayload,
        );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.spent_cents).toBe(4);
      expect(retryableWithoutCost(r), "起过进程就不可自动重试").toBe(false);
    } finally {
      delete process.env["SPY_MODE"];
    }
  });

  it("settle 注入槽：全绿且花了钱 ⇒ runner 原样转交（落哪个事务是 Step B 的事）", async () => {
    const seen: { spentCents: number }[] = [];
    const { d } = deps({
      settle: (o: { spentCents: number }): void => {
        seen.push(o);
      },
    });
    const r = await runViaGateway(OPTS, req(), d);
    expect(r.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.spentCents).toBe(4);
  });
});

describe("buildGatewayDeps —— 装配期纪律", () => {
  const audit = (): number => 1;
  it("岗位书完全没接（undefined）⇒ 装配期抛，而不是运行期静默放行", () => {
    expect(() => buildGatewayDeps({ audit })).toThrow(/charterHarnessDefaults/);
  });
  it("岗位书接了但没写 claude-code 那一格 ⇒ 缺省 read-only + 空基线", () => {
    const g = buildGatewayDeps({ audit, charterHarnessDefaults: {} });
    expect(g.grantedSandbox).toBe("read-only");
    expect(g.grantedForbidden).toEqual([]);
  });
  it("岗位书写了 claude_code 那一格（下划线别名）⇒ 逐字读进来", () => {
    const g = buildGatewayDeps({
      audit,
      charterHarnessDefaults: {
        claude_code: {
          sandbox: "workspace-write",
          forbidden_flags: ["--yolo"],
        },
      },
    });
    expect(g.grantedSandbox).toBe("workspace-write");
    expect(g.grantedForbidden).toEqual(["--yolo"]);
  });

  /*
   * ⭐ 读取期也判【键】—— 这一组钉的是 round331 那处判据的第二个执行点。
   *
   * 为什么写入期那一遍（charterSchema）不够：它只挡【从那一刻之后】的写入，
   * 而这里的入参是【库里已经存着的那一份】—— charter/store.ts 的 readCharterConfig
   * 明写着「不重解析」（代价写在该函数文件头），本仓【没有迁移器】。
   * ⇒ 「今天加一条写入期判据」对昨天存下的那份岗位书一个字都改不动，
   *   而这一格失效方向是【开】：forbidden_flags 落回 [] = 禁令消失而全绿。
   */
  it("⭐ 库里那份的键名拼错 ⇒ 装配期抛，而不是带着空禁令跑起来", () => {
    // 反着读一遍这发的意义：如果这里【不抛】，得到的正是 g.grantedForbidden = []
    // —— 与「岗位书什么都没写」在数据上完全相同（下面那发就是这个对照）。
    // 那种「配了而读不到」的形状，本仓已经在夹具注释里写过一次警告
    // （charter/prompt.test.ts 那格键名注释），而警告不是判据。
    expect(() =>
      buildGatewayDeps({
        audit,
        charterHarnessDefaults: {
          claudecode: {
            sandbox: "workspace-write",
            forbidden_flags: ["--yolo"],
          },
        },
      }),
    ).toThrow(/读不出【该用哪一格】/u);
  });

  it("⭐ 报错点名那个键名与合法键集（历史数据要能照着改）", () => {
    // 这一发的读者是「库里存了一份坏岗位书」的人：他看不到 YAML 编辑器，
    // 只看得到这条抛错。不点名键名他就只能猜。
    const e = grab(() =>
      buildGatewayDeps({
        audit,
        charterHarnessDefaults: { claudecode: { sandbox: "read-only" } },
      }),
    );
    expect(String(e)).toContain("claudecode");
    expect(String(e)).toContain("claude_code");
    // 还要给修法：历史数据的修法是【新存一版】，不是放宽判据。
    expect(String(e)).toContain("新存一版岗位书");
  });

  it("⭐ 库里那份同一家写了两种写法 ⇒ 同样抛（生效格由顺序决定 = 不可接受）", () => {
    expect(() =>
      buildGatewayDeps({
        audit,
        charterHarnessDefaults: {
          "claude-code": { forbidden_flags: ["--yolo"] },
          claude_code: { sandbox: "workspace-write" },
        },
      }),
    ).toThrow(/两种写法/u);
  });

  it("⭐ 反向对照：合法键 + 只有 codex 那一格 ⇒ 照旧读成 read-only + 空基线", () => {
    // 没有这一发，上面三发红的可能是「任何 harness_defaults 都抛」（恒真判据）。
    // codex 合法而今天无人读（见 harness.ts 的 ⚠⚠ 那段）⇒ 读取期【不】因为它抛：
    // 它是合法键，只是这一家还没接适配器。拒它等于替路由做它还没做的决定。
    const g = buildGatewayDeps({
      audit,
      charterHarnessDefaults: { codex: { sandbox: "danger" } },
    });
    expect(g.grantedSandbox).toBe("read-only");
    expect(g.grantedForbidden).toEqual([]);
  });

  it("⭐ 显式授权格【不能】绕过键判据（它是被比侧，不是免检侧）", () => {
    // buildGatewayDeps 的 explicit 分支让调用方直接交 grantedSandbox/grantedForbidden。
    // 若键判据只看岗位书那一侧，一份写坏的岗位书 + 一个显式档位就能带着【岗位书里
    // 那条没人读到的禁令】继续跑 —— 而审计会显示「有授权档位」，看起来完全正常。
    // 判在函数最前面（早于 explicit 分支取值）⇒ 坏的那一格无论如何都要先说话。
    expect(() =>
      buildGatewayDeps({
        audit,
        charterHarnessDefaults: { claudecode: { forbidden_flags: ["--yolo"] } },
        grantedSandbox: "read-only",
        grantedForbidden: [],
      }),
    ).toThrow(/读不出【该用哪一格】/u);
  });
});
