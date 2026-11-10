/**
 * Task 5.1 的 Gateway 测试（计划原话：「用 fake adapter 跑通 Gateway 全部逻辑
 * （**不依赖任何真实 CLI**）；`capabilities` 与实际调用不符时**报错而非静默降级**」）。
 *
 * ── 为什么这里必须是一个 fake adapter 而不是「等接上真 SDK 再测」──────────
 * Gateway 的全部判据（能力闸门、四层防护、预算、审计装配）都与 harness 是谁无关，
 * 而接上真 SDK 之后这些判据**一个都不能测**：真 CLI 会真的执行动作，
 * 于是「传 --yolo 要被拒」这类用例在真适配器上是一次越权执行。
 * 所以顺序只能是：先用 fake 把判定层钉死，再接真适配器（Task 5.5），
 * 真适配器接上时这些用例【一条都不改】—— 那才是分层分对了的证据。
 *
 * ── 这个文件里最值钱的是 fakeAdapter 那 20 行 ─────────────────────────
 * 它可以【任意形状】地发事件：不发 finished、发两个 session、结果里塞 structured、
 * 声明与行为不符。真实适配器不会配合演这些，而恰恰这些是审计真假的边界。
 *
 * ⚠ 有一件事这里【测不出来】，写在文件末尾那条 describe 里而不是藏起来：
 * 「审批被拒 ⇒ 动作没发生」。fake 适配器可以被写成【拒了照跑】，
 * 但真实 harness 会不会在被问之后就停下来，是它那侧的语义，离线状态无从核验。
 */
import type {
  CostReport,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessEvent,
  HarnessId,
  HarnessRequest,
  HarnessRequestInput,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from "@opc/contracts";
import { harnessRequestSchema } from "@opc/contracts";
import type { AuditRow } from "../../src/events/recorder.js";
import {
  capabilityGap,
  callHarness,
  type GatewayDeps,
  type GatewayOutcome,
  type HarnessAttemptPayload,
  type HarnessCallPayload,
  pathArg,
} from "../../src/harness/gateway.js";
import { describe, expect, it } from "vitest";

/* ═════════════════ fake 适配器与 deps ═════════════════ */

const FULL_CAPS: HarnessCapabilities = {
  budgetHardCap: true,
  toolApproval: true,
  resume: true,
  structuredOutput: true,
};

function req(over: Partial<HarnessRequestInput> = {}): HarnessRequest {
  return harnessRequestSchema.parse({
    task_id: "task-1",
    role_id: "dev",
    instruction: "把 flaky 测试修掉",
    workspace: "/repo",
    sandbox: "workspace-write",
    approval_policy: "never",
    allowed_tools: ["Read", "Bash", "Write"],
    forbidden_flags: ["--dangerously-skip-permissions", "--no-sandbox", "--yolo"],
    requested_args: ["--sandbox", "workspace-write"],
    max_budget_usd: 1,
    ...over,
  });
}

const COST: CostReport = {
  spentCents: 120,
  remainingCents: 380,
  inputTokens: 10,
  outputTokens: 20,
  source: "harness",
};

function finished(exitCode: number | null = 0): HarnessEvent {
  return {
    kind: "finished",
    exitCode,
    outcome: {
      harnessId: "fake",
      harnessVersion: "9.9.9",
      modelFamily: "claude",
      output: "改完了",
      diffHash: "a".repeat(64),
    },
  };
}

const SESSION: HarnessEvent = { kind: "session_started", sessionId: "sess-1" };

/**
 * 一个可控的 fake 适配器。`events` 是**它打算发**的序列；`onApproval` 被存下来，
 * 这样测试可以扮演 harness 去问审批（真实 SDK 就是在动手前问这一步）。
 */
function fakeAdapter(
  events: HarnessEvent[],
  o: {
    caps?: Partial<HarnessCapabilities>;
    id?: HarnessId;
    /** 记录收到过的审批请求（真实适配器的行为，不是 Gateway 的）。 */
    asked?: ToolApprovalRequest[];
    /** 拒了还照跑吗（各家语义不同，所以做成开关而不是断言）。 */
    proceedAfterDenial?: boolean;
  } = {},
): HarnessAdapter & { resumeArgs: string[]; lastHandler: unknown } {
  const caps: HarnessCapabilities = { ...FULL_CAPS, ...(o.caps ?? {}) };
  const adapter: HarnessAdapter & { resumeArgs: string[]; lastHandler: unknown } = {
    id: (o.id ?? "codex") as HarnessId,
    capabilities: caps,
    resumeArgs: [],
    lastHandler: null,
    execute: (rq, onApproval) => {
      adapter.lastHandler = onApproval;
      return stream(events, onApproval, o);
    },
    resume: (sessionId, onApproval) => {
      adapter.resumeArgs.push(sessionId);
      adapter.lastHandler = onApproval;
      return stream(events, onApproval, o);
    },
    getCost: async () => COST,
  };
  return adapter;
}

async function* stream(
  events: HarnessEvent[],
  onApproval: (r: ToolApprovalRequest) => Promise<ToolApprovalDecision>,
  o: { asked?: ToolApprovalRequest[]; proceedAfterDenial?: boolean },
): AsyncGenerator<HarnessEvent> {
  for (const ev of events) {
    // 模拟「有审批回调的 harness」：不可逆那几发先问再动。
    if (ev.kind === "tool_call" && o.asked !== undefined) {
      const r: ToolApprovalRequest = { tool: ev.tool, args: ev.redactedArgs, reason: "fake 问你" };
      o.asked.push(r);
      const d = await onApproval(r);
      if (!d.approved && o.proceedAfterDenial !== true) continue; // 老实的 harness：不动手
    }
    yield ev;
  }
}

/** 收集审计行的 deps。`audit` 是**必填**那一格的最小实现。 */
function deps(over: Partial<GatewayDeps> = {}): GatewayDeps & { rows: AuditRow[] } {
  const rows: AuditRow[] = [];
  return {
    rows,
    audit: (row: AuditRow): number => {
      rows.push(row);
      return rows.length;
    },
    grantedSandbox: "workspace-write",
    grantedForbidden: ["--dangerously-skip-permissions", "--no-sandbox", "--yolo"],
    ...over,
  };
}

function calls(d: { rows: AuditRow[] }): HarnessCallPayload[] {
  return d.rows
    .filter((r: AuditRow): boolean => r.action === "harness_call")
    .map((r: AuditRow): HarnessCallPayload => r.payload as HarnessCallPayload);
}
function attempts(d: { rows: AuditRow[] }): HarnessAttemptPayload[] {
  return d.rows
    .filter((r: AuditRow): boolean => r.action === "unauthorized_attempt")
    .map((r: AuditRow): HarnessAttemptPayload => r.payload as HarnessAttemptPayload);
}
function okOf(g: GatewayOutcome): void {
  expect(g.ok).toBe(true);
}

/* ═════════════════ 0. 能力闸门（计划点名的那一条） ═════════════════ */

describe("能力声明不符 ⇒ 拒绝调用，不是降级执行", () => {
  it("策略要审批而适配器没有 ⇒ capability_gap，且【一次调用都没发生】", async () => {
    let executed = false;
    const adapter: HarnessAdapter = {
      id: "codex",
      capabilities: { ...FULL_CAPS, toolApproval: false },
      execute: () => {
        executed = true;
        return stream([SESSION, finished()], async () => ({ approved: true }), {});
      },
      resume: () => stream([], async () => ({ approved: true }), {}),
      getCost: async () => COST,
    };
    const g = await callHarness(adapter, req({ approval_policy: "on-request" }), deps());
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("capability_gap");
    // 这条断言才是「不是静默降级」的机器证明：光看返回码分不清「拒了」与「拒了但照跑」。
    expect(executed).toBe(false);
  });

  it("四个缺口逐个点名，不是一句「能力不符」", () => {
    const gaps = capabilityGap(
      req({
        approval_policy: "on-request",
        max_budget_usd: 5,
        resume_session_id: "s1",
        output_schema: "TestReport",
      }),
      { budgetHardCap: false, toolApproval: false, resume: false, structuredOutput: false },
    );
    expect(gaps.length).toBe(4);
    expect(gaps.join("\n")).toContain("approval_policy=on-request");
    expect(gaps.join("\n")).toContain("budgetHardCap=false");
    expect(gaps.join("\n")).toContain("resume=false");
    expect(gaps.join("\n")).toContain("TestReport");
  });

  it("不要求的项不算缺口：不恢复就别要求 resume 能力", () => {
    expect(
      capabilityGap(req(), { budgetHardCap: true, toolApproval: false, resume: false, structuredOutput: false })
        .length,
    ).toBe(0);
  });

  it("approval_policy=never + 无审批能力 ⇒ 闸门放行（车间内自主，§12.8）", () => {
    // 但注意这【不等于】不可逆调用会被放行：needsApproval 刻意不看 approval_policy。
    // 那一层在下面的「never 也照样要审批」那条用例里钉。
    expect(capabilityGap(req({ approval_policy: "never" }), { ...FULL_CAPS, toolApproval: false }).length).toBe(0);
  });

  it("⭐ 声明 structuredOutput=false 却在结果里塞 structured ⇒ 不采信结果", async () => {
    const a = fakeAdapter(
      [
        SESSION,
        {
          kind: "finished",
          exitCode: 0,
          outcome: {
            harnessId: "fake",
            harnessVersion: "1",
            modelFamily: "claude",
            output: "x",
            diffHash: null,
            structured: { ok: true },
          },
        },
      ],
      { caps: { structuredOutput: false } },
    );
    const g = await callHarness(a, req(), deps());
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("capability_gap");
  });
});

/* ═════════════════ 0.5 预算闸门 ═════════════════ */

describe("预算闸门（§12.5 调用前拒）", () => {
  it("额度已用完 ⇒ 拒，且不碰适配器", async () => {
    let executed = false;
    const a = fakeAdapter([SESSION, finished()]);
    const real = a.execute.bind(a);
    const g = await callHarness(
      { ...a, execute: (rq, h) => ((executed = true), real(rq, h)) },
      req(),
      deps({ checkBudget: () => ({ over: true, spentCents: 1000, limitCents: 1000 }) }),
    );
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("budget_exceeded");
    expect(executed).toBe(false);
  });

  it("请求上限超总上限 ⇒ budget_exceeded，且报错说清是【配置错】而不是【额度用尽】", async () => {
    // 这一条钉的是我自己写过的「算了不用」：wantedCents 算出来而判据只看 b.over，
    // 于是「max_budget 写成 $20 而总额度只有 $10」这种配置错误在额度尚有余量时能放行。
    const g = await callHarness(fakeAdapter([SESSION, finished()]), req({ max_budget_usd: 20 }), deps({
      checkBudget: () => ({ over: false, spentCents: 100, limitCents: 1000 }),
    }));
    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.code).toBe("budget_exceeded");
      expect(g.reason).toContain("本身就超出总上限");
    }
  });

  it("无预算声明（undefined）⇒ 不拦", async () => {
    const g = await callHarness(fakeAdapter([SESSION, finished()]), req(), deps({ checkBudget: () => undefined }));
    okOf(g);
  });
});

/* ═════════════════ 1–3 前置四层（计划点名的绕过尝试） ═════════════════ */

describe("调用前的四层：越权尝试必须【留下审计】而不只是返回拒", () => {
  it("参数里带 --yolo ⇒ 拒 + 一行 unauthorized_attempt（stage=pre_call）", async () => {
    const d = deps();
    const g = await callHarness(fakeAdapter([SESSION, finished()]), req({ requested_args: ["--yolo"] }), d);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("safety_blocked");
    const at = attempts(d);
    expect(at.length).toBe(1);
    expect(at[0]!.kind).toBe("forbidden_flag");
    expect(at[0]!.stage).toBe("pre_call");
    // 越权行的 target 必须是【被拦的那个对象】而不是 "gateway"（同 author-reviewer 的立场）。
    expect(at[0]!.detail?.["hits"]).toEqual([{ arg: "--yolo", flag: "yolo" }]);
  });

  it("运行时缩短禁止项 ⇒ 拒，且被移除的条目进审计 detail", async () => {
    const d = deps();
    const g = await callHarness(
      fakeAdapter([SESSION, finished()]),
      req({ forbidden_flags: ["--yolo"] }), // 基线三条里只交了一条
      d,
    );
    expect(g.ok).toBe(false);
    expect(attempts(d)[0]!.kind).toBe("forbidden_flag");
    // 被移除的两条要逐条点名（只说「缩短了三条里的两条」而不知道是哪两条，没法修）。
    expect((attempts(d)[0]!.detail?.["removed_flags"] as string[]).sort()).toEqual(
      ["dangerously-skip-permissions", "no-sandbox"].sort(),
    );
  });

  it("沙箱提级（授权 read-only 而请求 workspace-write）⇒ 拒", async () => {
    const g = await callHarness(
      fakeAdapter([SESSION, finished()]),
      req({ sandbox: "workspace-write" }),
      deps({ grantedSandbox: "read-only" }),
    );
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("safety_blocked");
  });

  it("⭐ 提级判据【不是自比】：同一次请求在授权档位不同时结论相反", async () => {
    // 我第一版写的是 sandboxTierBlock(req.sandbox, req.sandbox) —— 永远 ok，
    // 而【没有任何用例能让它红】：所有断言都只喂一个档位。
    // 所以这一条必须把【同一个请求】在两个授权档位下各跑一次，要求一个过一个拒。
    const r = req({ sandbox: "workspace-write" });
    const raised = await callHarness(fakeAdapter([SESSION, finished()]), r, deps({ grantedSandbox: "read-only" }));
    const allowed = await callHarness(fakeAdapter([SESSION, finished()]), r, deps({ grantedSandbox: "workspace-write" }));
    expect(raised.ok).toBe(false);
    expect(allowed.ok).toBe(true);
  });

  it("降档放行（§12.5 缺陷修复：read-only 分析 → workspace-write 修复 = 两次调用）", async () => {
    const g = await callHarness(
      fakeAdapter([SESSION, finished()]),
      req({ sandbox: "read-only" }),
      deps({ grantedSandbox: "workspace-write" }),
    );
    okOf(g);
  });

  it("相对路径工作区 ⇒ 拒（同一条岗位书在两个 cwd 下意味着两个可写范围）", async () => {
    const g = await callHarness(fakeAdapter([SESSION, finished()]), req({ workspace: "repo" }), deps());
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("safety_blocked");
  });
});

/* ═════════════════ 4. 事件流里的逐次判定 ═════════════════ */

describe("逐次工具调用", () => {
  it("⭐ 白名单外的工具 ⇒ 记一行 tool_not_allowed 且【整次调用被中止】", async () => {
    const d = deps();
    const g = await callHarness(
      fakeAdapter([SESSION, { kind: "tool_call", tool: "NotebookEdit", redactedArgs: {} }, finished()], {
        // 没有 asked：模拟一个【不问就动】的适配器，于是事件流那一路是唯一的观测点
      }),
      req(),
      d,
    );
    // 中止而不是「记一笔然后成功返回」：继续消费的话，这次调用会带着【越权动作的产物】
    // （工作区外那个文件、被推上去那个分支）以 ok:true 回来，
    // 于是门控与审阅拿到的是一份被污染而看起来正常的产出 —— 污染会往下游走，失败不会。
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("violation_aborted");
    expect(attempts(d).length).toBe(1);
    expect(attempts(d)[0]!.kind).toBe("tool_not_allowed");
    expect(attempts(d)[0]!.stage).toBe("event_stream");
    // 中止也要留痕：这次调用【确实跑过一段】。
    expect(calls(d).length).toBe(1);
    expect(calls(d)[0]!.status).toBe("blocked");
    expect(calls(d)[0]!.blocked_attempts).toBe(1);
    // finished 那一发【没有】被消费 —— 产出因此不完整，而这是刻意的。
    expect(calls(d)[0]!.harness_version).toBe("unknown");
  });

  it("写目标越出工作区 ⇒ workspace_escape 且中止", async () => {
    const d = deps();
    const g = await callHarness(
      fakeAdapter([
        SESSION,
        { kind: "tool_call", tool: "Write", redactedArgs: { file_path: "/etc/passwd" } },
        finished(),
      ]),
      req(),
      d,
    );
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("violation_aborted");
    expect(attempts(d)[0]!.kind).toBe("workspace_escape");
  });

  it("pathArg 认 path / file_path / target 三种键，取不到就是 undefined", () => {
    expect(pathArg({ path: "/a" })).toBe("/a");
    expect(pathArg({ file_path: "/a" })).toBe("/a");
    expect(pathArg({ target: "/a" })).toBe("/a");
    expect(pathArg({ command: "ls" })).toBeUndefined();
    expect(pathArg(null)).toBeUndefined();
    expect(pathArg("/a")).toBeUndefined();
  });

  it("⭐ 一次不可逆调用【只问一次人】（回调 + 事件流两条路共享判定）", async () => {
    const asked: ToolApprovalRequest[] = [];
    const d = deps();
    let approvalsAskedToHuman = 0;
    const g = await callHarness(
      fakeAdapter([SESSION, { kind: "tool_call", tool: "Bash", redactedArgs: { command: "rm -rf build" } }, finished()], {
        asked,
      }),
      req(),
      d,
      () => {
        approvalsAskedToHuman += 1;
        return { approved: true, decidedBy: "ceo" };
      },
    );
    okOf(g);
    expect(asked.length).toBe(1); // 假适配器问了一次（回调那一路）
    // 人类被问的次数必须是 1，不是 2：事件流那一路复用同一个判定。
    expect(approvalsAskedToHuman).toBe(1);
    if (g.ok) {
      const p = calls(d)[0]!;
      expect(p.approvals.length).toBe(1);
      expect(p.approvals[0]).toEqual({ tool: "Bash", approved: true, decided_by: "ceo" });
    }
  });

  it("⭐ 不问就动的适配器 ⇒ approval_too_late，而【绝不问人】", async () => {
    // 这条是本文件里我认为最重要的一条：事后推一张审批卡片会留下一条
    // 「有人批准了这次 rm -rf」的审计记录，而那次 rm -rf 在他看到之前就跑完了。
    // 记录本身是真的，它表达的含义（有人事前把关过）是假的。
    const d = deps();
    let humanAsked = 0;
    const g = await callHarness(
      fakeAdapter([SESSION, { kind: "tool_call", tool: "Bash", redactedArgs: { command: "rm -rf build" } }, finished()]),
      req(),
      d,
      () => {
        humanAsked += 1;
        return { approved: true, decidedBy: "ceo" };
      },
    );
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("violation_aborted");
    expect(humanAsked).toBe(0);
    expect(attempts(d)[0]!.kind).toBe("approval_too_late");
    // 【没有】一条 approved:true —— 这一格是那条「事后追认=假记录」立场的落点。
    expect(calls(d)[0]!.approvals.length).toBe(0);
  });

  it("⭐ 中止真的触发适配器的清理钩子（这才是「能挡住后续」的全部依据）", async () => {
    // 「中止能挡住后面还没发生的动作」这句话的可验证那一半：
    // for-await 里 return 会调用异步迭代器的 return()，于是生成器 finally 跑起来。
    // 真实适配器就在这个 finally 里放 SDK 的 cancel/abort。这一条只证【钩子会被叫到】，
    // 不证【各家 SDK 真会因此停住正在跑的动作】—— 那半截在 §「证不了的」里。
    let cleaned = 0;
    async function* gen(): AsyncGenerator<HarnessEvent> {
      try {
        yield SESSION;
        yield { kind: "tool_call", tool: "NotebookEdit", redactedArgs: {} };
        yield finished(); // 越权之后这一发【不该】被消费
      } finally {
        cleaned += 1;
      }
    }
    const adapter: HarnessAdapter = {
      id: "codex",
      capabilities: FULL_CAPS,
      execute: () => gen(),
      resume: () => gen(),
      getCost: async () => COST,
    };
    const d = deps();
    const g = await callHarness(adapter, req(), d);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("violation_aborted");
    expect(cleaned).toBe(1); // finally 跑了一次
    // finished 没被消费 ⇒ 没有 ExecutionResult，产出确实不完整。
    if (!g.ok) expect("result" in g).toBe(false);
  });

  it("审批被拒 ⇒ 记 approval_denied；适配器拒了照跑 ⇒ 多一行 proceeded_after_verdict", async () => {
    const d = deps();
    const g = await callHarness(
      fakeAdapter([SESSION, { kind: "tool_call", tool: "Bash", redactedArgs: { command: "rm -rf build" } }, finished()], {
        asked: [],
        proceedAfterDenial: true,
      }),
      req(),
      d,
      () => ({ approved: false, decidedBy: "ceo", note: "等测试" }),
    );
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("violation_aborted");
    const at = attempts(d);
    expect(at.length).toBe(2);
    expect(at[0]!.kind).toBe("approval_denied");
    expect(at[0]!.stage).toBe("handler");
    // 第二行讲的是【另一件事】：我们拒了而它照做。两行不矛盾，也不该合并。
    expect(at[1]!.stage).toBe("event_stream");
    expect(at[1]!.detail?.["proceeded_after_verdict"]).toBe(true);
    // blocked_attempts 那个数【不翻倍】：口径是「几个不同的动作」，不是「几行审计」。
    expect(calls(d)[0]!.blocked_attempts).toBe(1);
  });

  it("⭐ approval_policy=never 也挡不住不可逆调用的审批（§12.8 的边界）", async () => {
    const d = deps();
    const g = await callHarness(
      fakeAdapter([SESSION, { kind: "tool_call", tool: "Bash", redactedArgs: { command: "rm -rf build" } }, finished()]),
      req({ approval_policy: "never" }),
      d,
    ); // 没有 onApproval
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("violation_aborted");
    // 「这个 harness 配了 never」不是「这次 rm -rf 可以批」的理由：
    // never 管的是车间内逐工具噪音，不可逆落在向上交接的边界之外。
    expect(attempts(d)[0]!.kind).toBe("approval_too_late");
  });

  it("缺审批回调 ⇒ approval_handler_missing 而不是 approval_denied", async () => {
    // 两个码必须分开：一个是缺陷（装配漏传参数），一个是正常业务结果（有人审过说不了）。
    const asked: ToolApprovalRequest[] = [];
    const d = deps();
    const g = await callHarness(
      fakeAdapter([SESSION, { kind: "tool_call", tool: "Bash", redactedArgs: { command: "rm -rf build" } }, finished()], {
        asked,
      }),
      req(),
      d,
      // 故意不传 onApproval
    );
    okOf(g);
    expect(asked.length).toBe(1);
    const at = attempts(d);
    expect(at.some((a: HarnessAttemptPayload): boolean => a.kind === "approval_handler_missing")).toBe(true);
  });

  it("只读工具不审批、不记账（ approvals 那一格只装真的问过人的）", async () => {
    const asked: ToolApprovalRequest[] = [];
    const d = deps();
    const g = await callHarness(
      fakeAdapter([SESSION, { kind: "tool_call", tool: "Bash", redactedArgs: { command: "git status" } }, finished()], {
        asked,
      }),
      req(),
      d,
    );
    okOf(g);
    if (g.ok) expect(calls(d)[0]!.approvals.length).toBe(0);
  });
});

describe("prevention 那一格：挡住的是【拦下了】还是【只看见了】", () => {
  it("具备审批能力 + 策略要求问 ⇒ enforced", async () => {
    const d = deps();
    await callHarness(
      fakeAdapter([SESSION, finished()], { caps: { toolApproval: true } }),
      req({ approval_policy: "on-request" }),
      d,
    );
    expect(calls(d)[0]!.prevention).toBe("enforced");
  });

  it("⭐ 适配器不会问 ⇒ observed_only，哪怕它整场一次否决权都没有", async () => {
    // 这一格存在的全部理由：`status: "blocked"` 读起来像「拦住了」。
    // 而在这台适配器上事件流里那些 tool_call 全是事后通报，
    // 把那种行读成「防住了一次」就是 §12.7 第四层最怕的失真：审计存在、数字对、含义是假的。
    const d = deps();
    await callHarness(
      fakeAdapter([SESSION, finished()], { caps: { toolApproval: false } }),
      req({ approval_policy: "never" }),
      d,
    );
    expect(calls(d)[0]!.prevention).toBe("observed_only");
  });

  it("策略是 never 时【不算】enforced —— 能问不代表会问（判据是能力 ∧ 策略）", async () => {
    // 只判能力会得到一个更乐观的值，而 approval_policy=never 恰恰是「这家不会问」的声明。
    const d = deps();
    await callHarness(fakeAdapter([SESSION, finished()], { caps: { toolApproval: true } }), req({ approval_policy: "never" }), d);
    expect(calls(d)[0]!.prevention).toBe("observed_only");
  });
});

/* ═════════════════ 审计那一行 ═════════════════ */

describe("harness_call 那一行：§12.7 第四层那七项一项都不许缺", () => {
  it("七个点名项全在，且缺值的写 null 而不是省键", async () => {
    const d = deps();
    const g = await callHarness(fakeAdapter([SESSION, { kind: "usage", cost: COST }, finished()]), req(), d);
    okOf(g);
    const p = calls(d)[0]!;
    for (const k of [
      "harness_id",
      "harness_version",
      "redacted_args",
      "session_id",
      "exit_code",
      "diff_hash",
      "spent_cents",
    ] as const) {
      expect(k in p, "缺项 " + k).toBe(true);
    }
    expect(p.session_id).toBe("sess-1");
    expect(p.spent_cents).toBe(120);
    expect(p.cost_source).toBe("harness");
    // 快照里必须能看到【当时的授权范围】：只有参数重放不出当时授到哪。
    const snap = d.rows.find((r: AuditRow): boolean => r.action === "harness_call")!.stateSnapshot as Record<
      string,
      unknown
    >;
    expect(snap["granted_sandbox"]).toBe("workspace-write");
    expect(snap["granted_forbidden"]).toContain("--yolo");
  });

  it("SDK 路径没有退出码 ⇒ null，而不是编一个 0", async () => {
    const d = deps();
    await callHarness(fakeAdapter([SESSION, finished(null)]), req(), d);
    const p = calls(d)[0]!;
    expect(p.exit_code).toBeNull();
    // 0 会被读成「进程正常退出」，而真相是【没有进程】。两者必须可区分。
    expect("exit_code" in p).toBe(true);
  });

  it("⭐ 密钥不会原样进审计（redacted_args 走的是命令行形状那条路）", async () => {
    const d = deps();
    await callHarness(
      fakeAdapter([SESSION, finished()]),
      req({ requested_args: ["--sandbox", "workspace-write", "--token", "sk-live-secret"] }),
      d,
    );
    const p = calls(d)[0]!;
    expect(JSON.stringify(p.redacted_args)).not.toContain("sk-live-secret");
    expect(p.redacted_args).toContain("[redacted]");
  });

  it("适配器没发 usage ⇒ 消耗记 0 而 source 是 estimated，不是 harness", async () => {
    // 否则审计里会出现一条「harness 报了 0 美分」的假话：那个 0 是【我们】填的默认。
    const d = deps();
    await callHarness(fakeAdapter([SESSION, finished()]), req(), d);
    const p = calls(d)[0]!;
    expect(p.spent_cents).toBe(0);
    expect(p.cost_source).toBe("estimated");
  });

  it("每个出口都落恰好一行 harness_call（成功 / 适配器坏了 / 被拦）", async () => {
    const ok = deps();
    await callHarness(fakeAdapter([SESSION, finished()]), req(), ok);
    expect(calls(ok).length).toBe(1);

    const broken = deps();
    await callHarness(fakeAdapter([SESSION]), req(), broken); // 没发 finished
    expect(calls(broken).length).toBe(1);
    expect(calls(broken)[0]!.status).toBe("adapter_error");

    const blocked = deps();
    await callHarness(fakeAdapter([SESSION, finished()]), req({ requested_args: ["--yolo"] }), blocked);
    // 前置四层命中时【不写】harness_call：那次调用根本没发生，写一条 status=blocked
    // 会让回放页以为有个会话跑过。它留的是 unauthorized_attempt 那一行。
    expect(calls(blocked).length).toBe(0);
    expect(attempts(blocked).length).toBe(1);
  });
});

/* ═════════════════ 适配器异常（不编结果） ═════════════════ */

describe("适配器异常 ⇒ 拒而不编一个看起来合法的结果", () => {
  it("没发 finished ⇒ no_result", async () => {
    const d = deps();
    const g = await callHarness(fakeAdapter([SESSION]), req(), d);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("no_result");
  });

  it("没发 session_started ⇒ no_session（恢复要接回去，审计要指得回）", async () => {
    const g = await callHarness(fakeAdapter([finished()]), req(), deps());
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("no_session");
  });

  it("两个 session_started ⇒ duplicate_session_event，且不取后者", async () => {
    const d = deps();
    const g = await callHarness(
      fakeAdapter([SESSION, { kind: "session_started", sessionId: "sess-2" }, finished()], {}),
      req(),
      d,
    );
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("duplicate_session_event");
    // 「以最后一个为准」会让审计里那一格指向一个没人知道的会话。
    expect(calls(d)[0]!.session_id).toBe("sess-1");
  });

  it("finished 之后还有事件 ⇒ event_after_finish（与 no_result 是两个码）", async () => {
    // 用 usage 而不是第二个 session_started 当「事后那一发」：后者会先撞上
    // duplicate_session_event 那条判据，于是这条用例测的其实是另一件事（我第一版就是这样）。
    const g = await callHarness(
      fakeAdapter([SESSION, finished(), { kind: "usage", cost: COST }]),
      req(),
      deps(),
    );
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("event_after_finish");
  });

  it("结果不合 schema ⇒ invalid_result 而【仍然留痕】（它确实跑过了）", async () => {
    const d = deps();
    const g = await callHarness(
      fakeAdapter([
        SESSION,
        {
          kind: "finished",
          exitCode: 0,
          outcome: {
            harnessId: "fake",
            modelFamily: "claude",
            output: "x",
            diffHash: null,
            harnessVersion: "", // 自报版本为空串，过不了 executionResultSchema 的 min(1)
          },
        },
      ]),
      req(),
      d,
    );
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("invalid_result");
    expect(calls(d).length).toBe(1);
  });
});

/* ═════════════════ resume / settle / 返回装配 ═════════════════ */

describe("恢复与消耗上报", () => {
  it("请求带 resume_session_id ⇒ 走 adapter.resume 而不是 execute", async () => {
    const a = fakeAdapter([SESSION, finished()], { caps: { resume: true } });
    const g = await callHarness(a, req({ resume_session_id: "sess-old" }), deps());
    okOf(g);
    expect(a.resumeArgs).toEqual(["sess-old"]);
  });

  it("settle 的幂等键【不含随机值】：同一个逻辑调用重复上报只扣一次", async () => {
    const g = await callHarness(fakeAdapter([SESSION, { kind: "usage", cost: COST }, finished()]), req(), deps());
    okOf(g);
    if (g.ok) expect(g.settleIdempotencyKey).toBe("harness:task-1:dev:sess-1");
    // 键里含 taskId + roleId + sessionId，所以同一会话的重复上报同键；
    // randomUUID 会让每次重试都是新键，等于没有幂等。
  });

  it("settle 只在真的有消耗时被调（0 不上报，免得留一条假的消费）", async () => {
    let settled = 0;
    await callHarness(fakeAdapter([SESSION, finished()]), req(), deps({ settle: () => void (settled += 1) }));
    expect(settled).toBe(0);
    await callHarness(
      fakeAdapter([SESSION, { kind: "usage", cost: COST }, finished()]),
      req(),
      deps({ settle: () => void (settled += 1) }),
    );
    expect(settled).toBe(1);
  });

  it("结果由 Gateway 装配：sessionId 来自 session_started、taskId 来自请求", async () => {
    // 装配那一半必须用【一次干净的调用】测：越权那一路现在会被中止，
    // 而中止就没有 ExecutionResult（这正是上面那几条用例的断言）。
    const g = await callHarness(
      // 用一条【只读】的工具调用：`Read` + `{path:...}` 会被 §9.1 那张表判成
      // 「认不出 ⇒ 默认不可逆」（见 safety.test.ts 那条 ⭐ 用例），于是这条装配用例
      // 测的会变成审批而不是装配。`git status` 是表里的只读项。
      fakeAdapter([SESSION, { kind: "tool_call", tool: "Bash", redactedArgs: { command: "git status" } }, finished()]),
      req(),
      deps(),
    );
    okOf(g);
    if (g.ok) {
      expect(g.result.blockedAttempts).toBe(0);
      expect(g.result.sessionId).toBe("sess-1");
      expect(g.result.taskId).toBe("task-1"); // 来自请求，不来自适配器
      expect(g.result.cost.spentCents).toBe(0);
      expect(g.result.harnessVersion).toBe("9.9.9"); // 这一格才是适配器给的
    }
  });

  it("audit 抛错 ⇒ 往上冒，不当成功（留痕失败不能算跑成）", async () => {
    await expect(
      callHarness(fakeAdapter([SESSION, finished()]), req(), {
        audit: (): number => {
          throw new Error("库不可写");
        },
        grantedSandbox: "workspace-write",
        grantedForbidden: ["--yolo"],
      }),
    ).rejects.toThrow("库不可写");
  });
});

/* ═════════════════ toolSightings（§13.3 第 1 层的观测源）═════════════════ */

describe("toolSightings：第 1 层『搜过没有』的那个数的来源", () => {
  const WS = (args: unknown): HarnessEvent => ({
    kind: "tool_call",
    tool: "WebSearch",
    redactedArgs: args,
  });

  it("⭐ 同一发工具被 ask 一次又被通报一次 ⇒ 只算一次", () => {
    // 这是本组最该有的一发。判定缓存的键是【工具 + 参数】，观测必须用同一个单位，
    // 否则「一次老实的搜索」会被数成两次，而那个数字会进第 1 层的判据。
    const asked: ToolApprovalRequest[] = [];
    return callHarness(
      fakeAdapter([SESSION, WS({ query: "x" }), WS({ query: "x" }), finished()], { asked }),
      req({ allowed_tools: ["Read", "WebSearch"] }),
      deps(),
      async () => ({ approved: true }),
    ).then((g) => {
      if (!g.ok) throw new Error("不应被拒：" + g.code);
      expect(g.toolSightings.length).toBe(1);
      // 而两个位置都留着（「问过我们」与「通报了」不是同一件事，0021 §2 那一族）。
      expect([...(g.toolSightings[0]?.stages ?? [])].sort()).toEqual([
        "event_stream",
        "handler",
      ]);
    });
  });

  it("不同参数的同一工具 ⇒ 算两次（否则第一次会替第二次放行）", async () => {
    const g = await callHarness(
      fakeAdapter([SESSION, WS({ query: "a" }), WS({ query: "b" }), finished()]),
      req({ allowed_tools: ["Read", "WebSearch"] }),
      deps(),
    );
    if (!g.ok) throw new Error("不应被拒：" + g.code);
    expect(g.toolSightings.length).toBe(2);
  });

  it("被拒那条路也带它 ⇒ 「看不见」这件事在两个出口都可读", async () => {
    const g = await callHarness(
      fakeAdapter([SESSION, { kind: "tool_call", tool: "Bash", redactedArgs: {} }, finished()]),
      req(), // 白名单里没有 Bash ⇒ 观测到一次未授权 ⇒ 中止
      deps(),
    );
    expect(g.ok).toBe(false);
    if (g.ok) return;
    // 中止前那一次是真的发生过，所以它在。
    expect(g.toolSightings.map((s) => s.tool)).toEqual(["Bash"]);
  });

  it("调用压根没开始（能力不符）⇒ 空数组，而不是 undefined", async () => {
    const g = await callHarness(
      fakeAdapter([SESSION, finished()], { caps: { toolApproval: false } }),
      req({ approval_policy: "on-request" }),
      deps(),
    );
    expect(g.ok).toBe(false);
    if (g.ok) return;
    // 空数组与「没这一格」在观测层是两个值（silent 的判据读的就是长度）。
    expect(g.toolSightings).toEqual([]);
  });

  it("⭐ 前置那四层命中的那次【不算】一次工具调用", async () => {
    // 这一发断言的是**出口的形状**（前置拒 ⇒ 观测为空），而不是源码里那句
    // `if (stage !== "pre_call")` —— 那句今天走不到（toolVerdict 只有两个调用点，
    // 传的都是 handler / event_stream），所以它红不了也绿不出什么。
    // 真正的防法是这一发：如果将来有人在前置那条路上也记观测（那是最省事的写法），
    // 这里当场红。源码里那句守卫只是让那种写法**多一道**兜底。
    const g = await callHarness(
      fakeAdapter([SESSION, finished()]),
      req({ forbidden_flags: ["--yolo", "--dangerously-skip-permissions"] }),
      deps(),
    );
    expect(g.ok).toBe(false);
    if (g.ok) return;
    expect(g.toolSightings).toEqual([]);
  });
});

/* ═════════════════ 测不出来的那件事 ═════════════════ */

describe("这一层证不了的（写在这里而不是等人踩）", () => {
  it("「审批被拒 ⇒ 动作没发生」在本文件里是【假设】而不是结论", () => {
    // fake 适配器可以被写成拒了照跑（上面就有一条那样的用例），也可以被写成老实不动手。
    // 真实 harness 是哪一种，是它那侧的语义，离线状态【无从核验】——
    // 所以 approvals 那一格里混着「拦住了」与「拒了但它照做」两种，靠
    // unauthorized_attempt.detail.proceeded_after_verdict 才能分开。
    // 这条断言本身没有信息量，它的全部作用是让这个缺口在测试文件里也留一行字，
    // 而不是只在源码注释里（下一个来加 harness 的人第一个读的是测试）。修法：Task 5.5 接真 SDK。
    expect(true).toBe(true);
  });
});
