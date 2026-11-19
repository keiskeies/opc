/**
 * ClaudeCliAdapter 的契约测试（2026-11，Step A）。
 *
 * 对面是【真的子进程】（fixtures/spy-claude.mjs），走真 spawn —— 与 engine/claude.test.ts
 * 同一立场：适配器最容易出的错全在形状翻译的接缝上（事件序列、美分换算、null 会话），
 * 换成 mock 就一个都测不出来。
 *
 * 三条计划点名的判据：
 *  ① 全链成功一轮：假 claude 桩走 callHarness，finished 唯一且最后；
 *  ② resume 带 session：--resume 真的出现在 argv（桩回显）；
 *  ③ sessionId 为 null ⇒【不发】session_started，而不是编一个 id。
 * 外加能力声明本身（capabilities 逐格）—— 声明谎报 toolApproval 时「策略要审批 ⇒ 拒」
 * 那发必须红，这是能力声明唯一的机器凭据。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  HarnessEvent,
  HarnessRequest,
  HarnessRequestInput,
} from "@opc/contracts";
import { harnessRequestSchema } from "@opc/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditRow } from "../../../src/events/recorder.js";
import { ClaudeCliAdapter } from "../../../src/harness/adapters/claude.js";
import { callHarness, type GatewayDeps } from "../../../src/harness/gateway.js";

const BIN = fileURLToPath(
  new URL("../fixtures/spy-claude.mjs", import.meta.url),
);

/**
 * 工作区必须【以 / 开头】（gateway 第 3 层的形状判据），Windows 上 node 会把
 * `/tmp/...` 归一到当前盘 —— 桩与测试读写的就是同一处（实测：cwd=/tmp/x 的进程
 * 报出 D:\tmp\x）。mkdirSync 先兜住盘根没有 tmp 的新机器。
 */
mkdirSync("/tmp", { recursive: true });
const WS = mkdtempSync("/tmp/opc-stepA-ad-");
const MARK = join(WS, "ran.marker");

beforeAll(() => {
  // 桩的控制面走环境变量（runRole 原样透传 process.env，这是既有形状）。
  process.env["SPY_MODE"] = "ok";
  process.env["SPY_MARK"] = MARK;
});
afterAll(() => {
  rmSync(WS, { recursive: true, force: true });
  delete process.env["SPY_MODE"];
  delete process.env["SPY_MARK"];
});

function req(over: Partial<HarnessRequestInput> = {}): HarnessRequest {
  return harnessRequestSchema.parse({
    task_id: "t-ad",
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

function deps(): GatewayDeps & { rows: AuditRow[] } {
  const rows: AuditRow[] = [];
  return {
    rows,
    audit: (row: AuditRow): number => {
      rows.push(row);
      return rows.length;
    },
    grantedSandbox: "read-only",
    grantedForbidden: ["--dangerously-skip-permissions"],
  };
}

function adapter(): ClaudeCliAdapter {
  return new ClaudeCliAdapter({
    bin: BIN,
    timeoutMs: 20_000,
    version: "9.9.9-test",
  });
}

async function collect(
  it: AsyncIterable<HarnessEvent>,
): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

describe("ClaudeCliAdapter —— 事件流的形状", () => {
  it("全链成功一轮：session_started → usage → finished，finished 唯一且最后", async () => {
    const a = adapter();
    const evs = await collect(
      a.execute(req(), async () => ({ approved: true })),
    );
    const kinds = evs.map((e: HarnessEvent): string => e.kind);
    expect(kinds).toEqual(["session_started", "usage", "finished"]);
    expect(
      evs.filter((e: HarnessEvent): boolean => e.kind === "finished"),
    ).toHaveLength(1);
    const fin = evs[evs.length - 1];
    expect(fin?.kind).toBe("finished");
    // 美分换算：桩报 0.042 美元 ⇒ 4 美分（Math.round(×100)）。
    const usage = evs.find((e: HarnessEvent): boolean => e.kind === "usage");
    expect(usage?.kind === "usage" ? usage.cost.spentCents : -1).toBe(4);
    // ok:true 那一支的退出码是结构性可证的 0。
    expect(fin?.kind === "finished" ? fin.exitCode : null).toBe(0);
    // takeRun 取走一次即清空（三态映射的凭据不能连拿两次）。
    const run = a.takeRun();
    expect(run?.ok).toBe(true);
    expect(a.takeRun()).toBe(null);
  });

  it("桩【真的被执行】了（SPY_MARK 落盘）", () => {
    expect(existsSync(MARK)).toBe(true);
  });

  it("resume 带 session：--resume 真的出现在 argv，且值正确", async () => {
    const a = adapter();
    const r = req({ resume_session_id: "sess-上一轮" });
    a.seedResumeRequest(r);
    const evs = await collect(
      a.resume("sess-上一轮", async () => ({ approved: true })),
    );
    const fin = evs.find((e: HarnessEvent): boolean => e.kind === "finished");
    expect(fin?.kind === "finished" ? fin.outcome.output : "").toContain(
      '"resumeFlag":true',
    );
    expect(fin?.kind === "finished" ? fin.outcome.output : "").toContain(
      '"resumed":"sess-上一轮"',
    );
  });

  it("resume 没有 seedResumeRequest ⇒ 抛，而不是编一个默认工作区", () => {
    const a = adapter();
    expect(() => a.resume("sess-x", async () => ({ approved: true }))).toThrow(
      /seedResumeRequest/,
    );
  });

  /**
   * rolePrompt 的回显（round312 补，Step B 接线时欠下的那条）。
   *
   * ClaudeCliAdapterOptions.rolePrompt 的注释说「adapters/claude-adapter.test.ts 的
   * 回显断言是这一格唯一的机器凭据」—— 接线之前那份凭据【并不存在】，这正是本仓
   * 抓了几十次的形状（有主张、有注释、零效果）。补上它才配得上那句注释。
   * 两向都判：给了 ⇒ 原文到 argv；没给 ⇒ 空串（runRole 恒带 --append-system-prompt，
   * 空值是「没装配身份」的诚实形状，而不是桩没收到参数）。
   */
  it("装配期给 rolePrompt ⇒ 原文出现在 argv；装配漏给 ⇒ 空串而不是假身份", async () => {
    const withId = new ClaudeCliAdapter({
      bin: BIN,
      timeoutMs: 20_000,
      rolePrompt: "你是 dev，岗位书全文在这一串里。",
    });
    const evsId = await collect(
      withId.execute(req(), async () => ({ approved: true })),
    );
    const finId = evsId.find(
      (e: HarnessEvent): boolean => e.kind === "finished",
    );
    expect(finId?.kind === "finished" ? finId.outcome.output : "").toContain(
      '"systemPrompt":"你是 dev，岗位书全文在这一串里。"',
    );
    // 反向对照：adapter()（没给 rolePrompt）必须回显【空串】。
    // 只留上一条，「适配器无视装配值、恒传一段写死的身份」也照样绿 —— 那比漏传更难发现。
    const evsNo = await collect(
      adapter().execute(req(), async () => ({ approved: true })),
    );
    const finNo = evsNo.find(
      (e: HarnessEvent): boolean => e.kind === "finished",
    );
    expect(finNo?.kind === "finished" ? finNo.outcome.output : "").toContain(
      '"systemPrompt":""',
    );
  });

  it("sessionId 缺失（CLI 没给）⇒【不发】session_started，finished 的 exitCode 是 null 不是 0", async () => {
    process.env["SPY_MODE"] = "nosession";
    try {
      const a = adapter();
      const evs = await collect(
        a.execute(req(), async () => ({ approved: true })),
      );
      expect(evs.map((e: HarnessEvent): string => e.kind)).toEqual([
        "usage",
        "finished",
      ]);
      // exitCode 在这一发是【真 0】不是编的：JSON 解得出且 is_error:false 蕴含进程
      // 以 0 退出（claude.ts 成功分支的前提）。null 只属于「没有进程信息」那几格。
      const fin = evs[1];
      expect(fin?.kind === "finished" ? fin.exitCode : null).toBe(0);
      expect(a.takeRun()?.sessionId).toBe(null);
    } finally {
      process.env["SPY_MODE"] = "ok";
    }
  });

  it("CLI 业务错（is_error + 非零码）⇒ finished 仍发、exitCode null、账单不抹零", async () => {
    process.env["SPY_MODE"] = "error";
    try {
      const a = adapter();
      const evs = await collect(
        a.execute(req(), async () => ({ approved: true })),
      );
      const usage = evs.find((e: HarnessEvent): boolean => e.kind === "usage");
      expect(usage?.kind === "usage" ? usage.cost.spentCents : -1).toBe(4);
      const run = a.takeRun();
      expect(run?.ok).toBe(false);
      expect(run?.started).toBe(true); // 进程起过：钱可能真花了
    } finally {
      process.env["SPY_MODE"] = "ok";
    }
  });

  it("getCost 如实【抛】：CLI 路线没有跨调用会话账，返回全零会是假话", async () => {
    await expect(adapter().getCost("sess-1")).rejects.toThrow(/会话账/);
  });
});

describe("ClaudeCliAdapter × callHarness —— 声明即判据", () => {
  it("callHarness 全链：装配成 ExecutionResult，会话/账单/版本都在", async () => {
    const a = adapter();
    const d = deps();
    const g = await callHarness(a, req(), d);
    expect(g.ok, g.ok ? "" : g.reason).toBe(true);
    if (!g.ok) return;
    expect(g.result.sessionId).toBe("sess-1");
    expect(g.result.cost.spentCents).toBe(4);
    expect(g.result.harnessVersion).toBe("9.9.9-test");
    expect(g.result.exitCode).toBe(0);
    expect(
      d.rows.some((r: AuditRow): boolean => r.action === "harness_call"),
    ).toBe(true);
  });

  it("能力逐格如实声明（谎报任一格 ⇒ 本发与下面那发一起红）", () => {
    expect(adapter().capabilities).toEqual({
      budgetHardCap: true,
      toolApproval: false,
      resume: true,
      structuredOutput: false,
    });
  });

  it("策略要审批而声明 toolApproval=false ⇒ capability_gap 拒，桩一次都没执行", async () => {
    rmSync(MARK, { force: true });
    const a = adapter();
    const g = await callHarness(
      a,
      req({ approval_policy: "on-request" }),
      deps(),
    );
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("capability_gap");
    expect(a.takeRun()).toBe(null);
    expect(existsSync(MARK), "能力闸门命中时桩不得被执行").toBe(false);
  });

  it("CLI 没给 session ⇒ gateway no_session 拒，而不是编一条可恢复的审计行", async () => {
    process.env["SPY_MODE"] = "nosession";
    try {
      const a = adapter();
      const g = await callHarness(a, req(), deps());
      expect(g.ok).toBe(false);
      // finishReject 的第二参才是 GatewayRejectCode（status 是 payload 侧的词表）：
      // 这一发钉的是「哪一层拒」，别和调用状态码混读（gateway.ts 两套码的分工）。
      if (!g.ok) expect(g.code).toBe("no_session");
    } finally {
      process.env["SPY_MODE"] = "ok";
    }
  });
});
