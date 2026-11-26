/**
 * CodexCliAdapter 的契约测试（2026-11，执行器七件套 T6）。
 *
 * 对面是【注入的 Codex 构造器桩】而不是真 SDK：本文件要钉的是形状翻译
 * （ThreadEvent 流 → HarnessEvent 流、词表翻译、三态接缝、capability_gap 拒），
 * 这些全在翻译层，真链路那半段离线拿不到（立场与 gateway.ts「Task 5.5 之前
 * 不装作测过 SDK」同源）。桩的注入缝（codexCtor）是默认装载器的对偶：真装载器
 * 只多一个 dynamic import，两条路共用 #threadOptionsFor / #stream 的全部逻辑。
 *
 * 判据清单：
 *  ① 事件流形状：session_started（thread.started 到）→ tool_call（item 逐发、
 *     按 item.id 恰好一次）→ usage（token 真读数 + spentCents 0 的口径塌缩）→
 *     finished（exitCode:null）；finished 唯一且最后；
 *  ② 词表翻译逐格：command_execution⇒Bash、mcp⇒mcp__srv__tool、file_change⇒
 *     【每文件一发】Edit（pathArg 拿到真 path 的凭据）、web_search⇒WebSearch、
 *     其余⇒不发；
 *  ③ 能力逐格 + capability_gap：max_budget_usd>0、on-request、output_schema
 *     三发必须红，且桩一次都没被构造（声明即判据的机器凭据）；
 *  ④ 三态：turn.completed 成功 / turn.failed started:true / runStreamed 抛
 *     started:false+errno / 中途抛 started:true / 流尽无终态；takeRun 取走即清；
 *  ⑤ resume 路线 thread.id 早读数 ⇒ session_started 在 runStreamed 之前，
 *     thread.started 靠 emitted 标志去重；
 *  ⑥ 越权中断：gateway 观测到未授权 tool_call ⇒ .return() 我们的生成器，
 *     桩必须证「turn.completed 那帧从未被消费」+ finally 落了 started:true。
 */
import type {
  ApprovalHandler,
  HarnessEvent,
  HarnessRequest,
  HarnessRequestInput,
} from "@opc/contracts";
import { harnessRequestSchema } from "@opc/contracts";
import { describe, expect, it } from "vitest";
import type { AuditRow } from "../../../src/events/recorder.js";
import type {
  CodexCtorLite,
  CodexEventLite,
  CodexItemLite,
  CodexLikeLite,
  CodexThreadLite,
  CodexThreadOptionsLite,
} from "../../../src/harness/adapters/codex.js";
import {
  CodexCliAdapter,
  codexApprovalModeFor,
  codexSandboxModeFor,
  codexToolCallsFor,
} from "../../../src/harness/adapters/codex.js";
import type { GatewayDeps } from "../../../src/harness/gateway.js";
import { callHarness } from "../../../src/harness/gateway.js";

const WS = "/tmp/opc-codex-test-ws";
const APPROVE_ALL: ApprovalHandler = async () => ({ approved: true });

/** turn.completed 的五格 Usage（逐字同形于 0.167.0 的 d.ts）。 */
const USAGE = {
  input_tokens: 500,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 40,
  reasoning_output_tokens: 0,
};

function req(over: Partial<HarnessRequestInput> = {}): HarnessRequest {
  return harnessRequestSchema.parse({
    task_id: "t-codex",
    role_id: "dev",
    instruction: "把这件事做完",
    workspace: WS,
    sandbox: "read-only",
    approval_policy: "never",
    allowed_tools: ["Read", "Edit", "Bash", "WebSearch"],
    forbidden_flags: ["--dangerously-bypass-approvals-and-sandbox"],
    requested_args: [],
    max_budget_usd: 0,
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
    grantedForbidden: ["--dangerously-bypass-approvals-and-sandbox"],
  };
}

// ── 事件/条目小构造器 ────────────────────────────────────────────────

function msgItem(id: string, text: string): CodexItemLite {
  return { id, type: "agent_message", text };
}
function cmdItem(id: string, command: string): CodexItemLite {
  return { id, type: "command_execution", command };
}
function itemEv(
  type: "item.started" | "item.updated" | "item.completed",
  item: CodexItemLite,
): CodexEventLite {
  return { type, item };
}
async function* evs(list: CodexEventLite[]): AsyncGenerator<CodexEventLite> {
  for (const e of list) yield e;
}

/** 成功一轮的最小事件流：started → message+command → turn.completed。 */
function successEvents(): () => AsyncIterable<CodexEventLite> {
  return () =>
    evs([
      { type: "thread.started", thread_id: "th-1" },
      itemEv("item.completed", msgItem("i-1", "完成了。")),
      itemEv("item.completed", cmdItem("i-2", "ls")),
      { type: "turn.completed", usage: USAGE },
    ]);
}

interface StubRec {
  ctor: Array<Record<string, unknown> | undefined>;
  start: CodexThreadOptionsLite[];
  resume: Array<{ id: string; opts?: CodexThreadOptionsLite | undefined }>;
  run: Array<{ input: string; turnOptions?: Record<string, unknown> }>;
}

/**
 * Codex 构造器桩：startThread 的线程 id 是 null（首轮后才有的形状），
 * resumeThread(id) 的线程 id【立即】是 id —— 这两格差距就是 ⑤ 的测试素材。
 */
function stubCodex(
  factory: () => AsyncIterable<CodexEventLite>,
  cfg: { throwRun?: unknown } = {},
): { ctor: CodexCtorLite; rec: StubRec } {
  const rec: StubRec = { ctor: [], start: [], resume: [], run: [] };
  function makeThread(id: string | null): CodexThreadLite {
    return {
      get id(): string | null {
        return id;
      },
      async runStreamed(
        input: string,
        turnOptions?: Record<string, unknown>,
      ): Promise<{ events: AsyncIterable<CodexEventLite> }> {
        rec.run.push({
          input,
          ...(turnOptions !== undefined ? { turnOptions } : {}),
        });
        if (cfg.throwRun !== undefined) throw cfg.throwRun;
        return { events: factory() };
      },
    };
  }
  class StubCodex implements CodexLikeLite {
    constructor(options?: Record<string, unknown>) {
      rec.ctor.push(options);
    }
    startThread(options?: CodexThreadOptionsLite): CodexThreadLite {
      rec.start.push(options ?? {});
      return makeThread(null);
    }
    resumeThread(
      id: string,
      options?: CodexThreadOptionsLite,
    ): CodexThreadLite {
      rec.resume.push({ id, opts: options });
      return makeThread(id);
    }
  }
  return { ctor: StubCodex, rec };
}

async function collect(
  stream: AsyncIterable<HarnessEvent>,
): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

function errWithCode(msg: string, code?: string): Error {
  const e: Error & { code?: string } = new Error(msg);
  if (code !== undefined) e.code = code;
  return e;
}

// ── 映射逐格 ─────────────────────────────────────────────────────────

describe("codexSandboxModeFor / codexApprovalModeFor —— 映射逐格", () => {
  it("沙箱三档逐字直通，danger⇒danger-full-access", () => {
    expect(codexSandboxModeFor(req())).toBe("read-only");
    expect(codexSandboxModeFor(req({ sandbox: "workspace-write" }))).toBe(
      "workspace-write",
    );
    expect(codexSandboxModeFor(req({ sandbox: "danger" }))).toBe(
      "danger-full-access",
    );
  });

  it("审批策略直通：never/on-request 原词返回（直通参数不是直通能力）", () => {
    expect(codexApprovalModeFor("never")).toBe("never");
    expect(codexApprovalModeFor("on-request")).toBe("on-request");
  });
});

describe("codexToolCallsFor —— 词表翻译逐格", () => {
  it("command_execution⇒Bash{command}；缺 command 给空串不缺席", () => {
    expect(codexToolCallsFor(cmdItem("i-1", "rm -rf /"))).toEqual([
      { tool: "Bash", args: { command: "rm -rf /" } },
    ]);
    expect(codexToolCallsFor({ id: "i-2", type: "command_execution" })).toEqual(
      [{ tool: "Bash", args: { command: "" } }],
    );
  });

  it("mcp_tool_call⇒mcp__server__tool；缺格用 unknown 顶名不顶判据", () => {
    expect(
      codexToolCallsFor({
        id: "i-1",
        type: "mcp_tool_call",
        server: "jira",
        tool: "create_issue",
        arguments: { title: "x" },
      }),
    ).toEqual([{ tool: "mcp__jira__create_issue", args: { title: "x" } }]);
    expect(codexToolCallsFor({ id: "i-2", type: "mcp_tool_call" })).toEqual([
      { tool: "mcp__unknown__unknown", args: null },
    ]);
  });

  it("file_change⇒每文件一发 Edit（pathArg 拿到真 path 的凭据）", () => {
    const out = codexToolCallsFor({
      id: "i-1",
      type: "file_change",
      changes: [
        { path: WS + "/a.ts", kind: "update" },
        { path: WS + "/b.ts", kind: "add" },
      ],
    });
    expect(out).toEqual([
      { tool: "Edit", args: { path: WS + "/a.ts", kind: "update" } },
      { tool: "Edit", args: { path: WS + "/b.ts", kind: "add" } },
    ]);
    expect(codexToolCallsFor({ id: "i-2", type: "file_change" })).toEqual([]);
  });

  it("web_search⇒WebSearch；agent_message/todo/error 不发工具", () => {
    expect(
      codexToolCallsFor({ id: "i-1", type: "web_search", query: "codex sdk" }),
    ).toEqual([{ tool: "WebSearch", args: { query: "codex sdk" } }]);
    expect(codexToolCallsFor(msgItem("i-2", "想想"))).toEqual([]);
    expect(codexToolCallsFor({ id: "i-3", type: "todo_list" })).toEqual([]);
    expect(
      codexToolCallsFor({ id: "i-4", type: "error", message: "炸了" }),
    ).toEqual([]);
  });
});

// ── 流形状 / 三态 / 装配 ─────────────────────────────────────────────

describe("CodexCliAdapter × execute —— 流形状与三态", () => {
  it("成功一轮：四段事件顺序、tool_call 译成 Bash、usage 带 token 真读数", async () => {
    const a = new CodexCliAdapter({
      codexCtor: stubCodex(successEvents()).ctor,
    });
    const ev = await collect(a.execute(req(), APPROVE_ALL));
    expect(ev.map((e: HarnessEvent): string => e.kind)).toEqual([
      "session_started",
      "tool_call",
      "usage",
      "finished",
    ]);
    const tc = ev[1];
    if (tc?.kind !== "tool_call") throw new Error("应有一条 tool_call");
    expect(tc.tool).toBe("Bash");
    expect(tc.redactedArgs).toEqual({ command: "ls" });
    const us = ev[2];
    if (us?.kind !== "usage") throw new Error("应有 usage");
    // spentCents=0 的口径塌缩：这台 harness 报 token 不报钱（文件头 #costFromUsage）。
    expect(us.cost.spentCents).toBe(0);
    expect(us.cost.inputTokens).toBe(500);
    expect(us.cost.outputTokens).toBe(40);
    expect(us.cost.source).toBe("harness");
  });

  it("finished 唯一且最后：exitCode null（SDK 路线没有退出码），output 来自 agent_message", async () => {
    const a = new CodexCliAdapter({
      codexCtor: stubCodex(successEvents()).ctor,
    });
    const ev = await collect(a.execute(req(), APPROVE_ALL));
    const fins = ev.filter((e: HarnessEvent): boolean => e.kind === "finished");
    expect(fins).toHaveLength(1);
    const fin = fins[0];
    if (fin?.kind !== "finished") throw new Error("finished 应在");
    expect(fin.exitCode).toBeNull();
    expect(fin.outcome.harnessId).toBe("codex");
    expect(fin.outcome.output).toBe("完成了。");
    // 版本：SDK 事件流没有版本格 ⇒ 不给 option 就是 unknown（不编 CLI 版本）。
    expect(fin.outcome.harnessVersion).toBe("unknown");
    // 模型家族【继承形状】：事件流里没有模型格，只能继承请求期望，皆空 ⇒ unknown。
    expect(fin.outcome.modelFamily).toBe("unknown");
  });

  it("版本 option 覆盖 unknown；model_family 请求值原样继承", async () => {
    const a = new CodexCliAdapter({
      codexCtor: stubCodex(successEvents()).ctor,
      version: "0.167.0-test",
    });
    const ev = await collect(
      a.execute(req({ model_family: "gpt-5" }), APPROVE_ALL),
    );
    const fin = ev[ev.length - 1];
    if (fin?.kind !== "finished") throw new Error("finished 应在");
    expect(fin.outcome.harnessVersion).toBe("0.167.0-test");
    expect(fin.outcome.modelFamily).toBe("gpt-5");
  });

  it("takeRun 成功形状 + 取走即清 + instruction 原样进 runStreamed", async () => {
    const s = stubCodex(successEvents());
    const a = new CodexCliAdapter({
      codexCtor: s.ctor,
      codexOptions: { apiKey: "k-1" },
    });
    await collect(a.execute(req(), APPROVE_ALL));
    const run = a.takeRun();
    expect(run).not.toBeNull();
    expect(run?.ok).toBe(true);
    expect(run?.text).toBe("完成了。");
    expect(run?.sessionId).toBe("th-1");
    expect(run?.costUsd).toBe(0);
    expect(run?.error).toBeNull();
    expect(run?.started).toBe(true);
    expect(run?.spawnErrno).toBe("");
    expect(a.takeRun()).toBeNull();
    // 装配凭据：构造器收到 codexOptions，runStreamed 收到 instruction 原文。
    expect(s.rec.ctor).toEqual([{ apiKey: "k-1" }]);
    expect(s.rec.run[0]?.input).toBe("把这件事做完");
  });

  it("线程装配逐格：档位/工作区直通，skipGitRepoCheck 只随 danger，model 不映射", async () => {
    const s1 = stubCodex(successEvents());
    await collect(
      new CodexCliAdapter({ codexCtor: s1.ctor }).execute(req(), APPROVE_ALL),
    );
    expect(s1.rec.start[0]).toEqual({
      sandboxMode: "read-only",
      workingDirectory: WS,
      approvalPolicy: "never",
    });
    const s2 = stubCodex(successEvents());
    await collect(
      new CodexCliAdapter({ codexCtor: s2.ctor }).execute(
        req({ sandbox: "danger" }),
        APPROVE_ALL,
      ),
    );
    expect(s2.rec.start[0]).toEqual({
      sandboxMode: "danger-full-access",
      workingDirectory: WS,
      skipGitRepoCheck: true,
      approvalPolicy: "never",
    });
    const s3 = stubCodex(successEvents());
    await collect(
      new CodexCliAdapter({ codexCtor: s3.ctor }).execute(
        req({ sandbox: "workspace-write" }),
        APPROVE_ALL,
      ),
    );
    expect(s3.rec.start[0]?.skipGitRepoCheck).toBeUndefined();
    expect(s3.rec.start[0]?.model).toBeUndefined();
  });

  it("mcp 参数脱敏在适配器做：token 值整格替换，判定缓存两路同形", async () => {
    const a = new CodexCliAdapter({
      codexCtor: stubCodex(() =>
        evs([
          { type: "thread.started", thread_id: "th-1" },
          itemEv("item.started", {
            id: "i-1",
            type: "mcp_tool_call",
            server: "jira",
            tool: "create_issue",
            arguments: { title: "x", token: "sekret" },
          }),
          { type: "turn.completed", usage: USAGE },
        ]),
      ).ctor,
    });
    const ev = await collect(a.execute(req(), APPROVE_ALL));
    const tc = ev[1];
    if (tc?.kind !== "tool_call") throw new Error("应有 tool_call");
    expect(tc.tool).toBe("mcp__jira__create_issue");
    expect(tc.redactedArgs).toEqual({ title: "x", token: "[redacted]" });
  });

  it("file_change 每文件一发进事件流（越界检查拿到具体 path）", async () => {
    const a = new CodexCliAdapter({
      codexCtor: stubCodex(() =>
        evs([
          { type: "thread.started", thread_id: "th-1" },
          itemEv("item.started", {
            id: "i-1",
            type: "file_change",
            changes: [
              { path: WS + "/a.ts", kind: "update" },
              { path: WS + "/b.ts", kind: "add" },
            ],
          }),
          { type: "turn.completed", usage: USAGE },
        ]),
      ).ctor,
    });
    const ev = await collect(a.execute(req(), APPROVE_ALL));
    const tcs = ev.filter((e: HarnessEvent): boolean => e.kind === "tool_call");
    expect(tcs).toHaveLength(2);
    const args0 = (tcs[0] as { redactedArgs: unknown }).redactedArgs;
    expect(args0).toEqual({ path: WS + "/a.ts", kind: "update" });
  });

  it("同 item.id 反复通报（started+updated+completed）⇒ tool_call 恰好一发", async () => {
    const item = cmdItem("i-1", "git status");
    const a = new CodexCliAdapter({
      codexCtor: stubCodex(() =>
        evs([
          { type: "thread.started", thread_id: "th-1" },
          itemEv("item.started", item),
          itemEv("item.updated", item),
          itemEv("item.completed", item),
          { type: "turn.completed", usage: USAGE },
        ]),
      ).ctor,
    });
    const ev = await collect(a.execute(req(), APPROVE_ALL));
    expect(
      ev.filter((e: HarnessEvent): boolean => e.kind === "tool_call"),
    ).toHaveLength(1);
  });

  it("thread.started 没带 id ⇒【不发】session_started，sessionId 是 null 不是编的", async () => {
    const a = new CodexCliAdapter({
      codexCtor: stubCodex(() =>
        evs([
          { type: "thread.started" },
          { type: "turn.completed", usage: USAGE },
        ]),
      ).ctor,
    });
    const ev = await collect(a.execute(req(), APPROVE_ALL));
    expect(
      ev.filter((e: HarnessEvent): boolean => e.kind === "session_started"),
    ).toHaveLength(0);
    expect(a.takeRun()?.sessionId).toBeNull();
  });

  it("resume 路线：thread.id 早读数 ⇒ session_started 在事件流之前，且全程恰好一发", async () => {
    // 真 SDK 的 resume 路线里 thread.started 报的就是被续的那个 id —— 桩如实同形
    //（若两家给的 id 会不一致，那是 SDK 自己的 bug，不是本适配器要兜的形状）。
    const s = stubCodex(() =>
      evs([
        { type: "thread.started", thread_id: "th-9" },
        itemEv("item.completed", msgItem("i-1", "续上了。")),
        { type: "turn.completed", usage: USAGE },
      ]),
    );
    const a = new CodexCliAdapter({ codexCtor: s.ctor });
    const ev = await collect(
      a.execute(req({ resume_session_id: "th-9" }), APPROVE_ALL),
    );
    expect(ev[0]?.kind).toBe("session_started");
    if (ev[0]?.kind === "session_started") {
      expect(ev[0].sessionId).toBe("th-9");
    }
    expect(
      ev.filter((e: HarnessEvent): boolean => e.kind === "session_started"),
    ).toHaveLength(1);
    expect(s.rec.resume).toHaveLength(1);
    expect(s.rec.resume[0]?.id).toBe("th-9");
    expect(s.rec.start).toHaveLength(0);
    expect(a.takeRun()?.sessionId).toBe("th-9");
  });

  it("resume() 没有 seedResumeRequest ⇒ 抛，而不是编一个默认工作区", () => {
    const a = new CodexCliAdapter({
      codexCtor: stubCodex(successEvents()).ctor,
    });
    expect(() => a.resume("th-1", APPROVE_ALL)).toThrow(/seedResumeRequest/);
  });

  it("getCost 如实抛：SDK 路线没有跨调用会话账，返回全零会是假话", async () => {
    const a = new CodexCliAdapter({
      codexCtor: stubCodex(successEvents()).ctor,
    });
    await expect(a.getCost("th-1")).rejects.toThrow(/会话账/);
  });

  it("turn.failed ⇒ finished 照发、takeRun ok:false started:true、错误文案带原文", async () => {
    const s = stubCodex(() =>
      evs([
        { type: "thread.started", thread_id: "th-1" },
        itemEv("item.completed", msgItem("i-1", "先做了一半。")),
        { type: "turn.failed", error: { message: "额度用尽" } },
        { type: "turn.completed", usage: USAGE },
      ]),
    );
    const a = new CodexCliAdapter({ codexCtor: s.ctor });
    const ev = await collect(a.execute(req(), APPROVE_ALL));
    const last = ev[ev.length - 1];
    expect(last?.kind).toBe("finished");
    // turn.failed 后 break：turn.completed 那帧不该被消费。
    const run = a.takeRun();
    expect(run?.ok).toBe(false);
    expect(run?.started).toBe(true);
    expect(run?.spawnErrno).toBe("");
    expect(run?.error).toContain("额度用尽");
    expect(run?.text).toBe("先做了一半。");
  });

  it("runStreamed 首帧前抛 ⇒ started:false + errno 透出（重试白名单那一族）", async () => {
    const a = new CodexCliAdapter({
      codexCtor: stubCodex(successEvents(), {
        throwRun: errWithCode("codex 二进制缺失", "ENOENT"),
      }).ctor,
    });
    const ev = await collect(a.execute(req(), APPROVE_ALL));
    expect(ev.map((e: HarnessEvent): string => e.kind)).toEqual([
      "usage",
      "finished",
    ]);
    const run = a.takeRun();
    expect(run?.ok).toBe(false);
    expect(run?.started).toBe(false);
    expect(run?.spawnErrno).toBe("ENOENT");
    expect(run?.error).toContain("codex 二进制缺失");
  });

  it("事件流中途抛 ⇒ started:true、errno 空（线程起过就不可自动重试）", async () => {
    const a = new CodexCliAdapter({
      codexCtor: stubCodex(() =>
        (async function* (): AsyncGenerator<CodexEventLite> {
          yield { type: "thread.started", thread_id: "th-1" };
          throw errWithCode("流断了");
        })(),
      ).ctor,
    });
    await collect(a.execute(req(), APPROVE_ALL));
    const run = a.takeRun();
    expect(run?.ok).toBe(false);
    expect(run?.started).toBe(true);
    expect(run?.spawnErrno).toBe("");
    expect(run?.error).toContain("流断了");
  });

  it("流尽而无终态帧 ⇒ ok:false + 点名「没有 turn.completed」，不编空成功", async () => {
    const a = new CodexCliAdapter({
      codexCtor: stubCodex(() =>
        evs([
          { type: "thread.started", thread_id: "th-1" },
          itemEv("item.completed", msgItem("i-1", "只到一半")),
        ]),
      ).ctor,
    });
    await collect(a.execute(req(), APPROVE_ALL));
    const run = a.takeRun();
    expect(run?.ok).toBe(false);
    expect(run?.started).toBe(true);
    expect(run?.error).toContain("没有 turn.completed");
  });
});

// ── × callHarness：声明即判据 ────────────────────────────────────────

describe("CodexCliAdapter × callHarness —— 声明即判据", () => {
  it("能力逐格如实声明（谎报任一格 ⇒ 本发与下面几发一起红）", () => {
    const a = new CodexCliAdapter({
      codexCtor: stubCodex(successEvents()).ctor,
    });
    expect(a.capabilities).toEqual({
      budgetHardCap: false,
      toolApproval: false,
      resume: true,
      structuredOutput: false,
    });
  });

  it("带 USD 硬顶的请求 ⇒ capability_gap 拒且桩一次都没被构造（SDK 没有预算参数）", async () => {
    const s = stubCodex(successEvents());
    const g = await callHarness(
      new CodexCliAdapter({ codexCtor: s.ctor }),
      req({ max_budget_usd: 0.5 }),
      deps(),
    );
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("capability_gap");
    expect(s.rec.ctor).toHaveLength(0);
    expect(s.rec.start).toHaveLength(0);
  });

  it("on-request ⇒ capability_gap（审批弹问在 CLI 侧，进程内回调不存在就是不存在）", async () => {
    const s = stubCodex(successEvents());
    const g = await callHarness(
      new CodexCliAdapter({ codexCtor: s.ctor }),
      req({ approval_policy: "on-request" }),
      deps(),
    );
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("capability_gap");
    expect(s.rec.ctor).toHaveLength(0);
  });

  it("output_schema ⇒ capability_gap（声明 structuredOutput=false 的返回侧同样成立）", async () => {
    const s = stubCodex(successEvents());
    const g = await callHarness(
      new CodexCliAdapter({ codexCtor: s.ctor }),
      req({ output_schema: "plan.v1" }),
      deps(),
    );
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("capability_gap");
    expect(s.rec.ctor).toHaveLength(0);
  });

  it("never 档成功落账：prevention=observed_only（这一家没有否决权，审计如实写）", async () => {
    const a = new CodexCliAdapter({
      codexCtor: stubCodex(successEvents()).ctor,
    });
    const d = deps();
    const g = await callHarness(a, req(), d);
    expect(g.ok).toBe(true);
    if (g.ok) {
      expect(g.result.sessionId).toBe("th-1");
      expect(g.result.cost.spentCents).toBe(0);
      expect(g.result.exitCode).toBeNull();
      expect(g.result.harnessVersion).toBe("unknown");
    }
    const callRow = d.rows.find(
      (r: AuditRow): boolean => r.action === "harness_call",
    );
    expect(callRow).toBeDefined();
    const p = callRow?.payload as Record<string, unknown>;
    expect(p["status"]).toBe("ok");
    expect(p["prevention"]).toBe("observed_only");
    expect(p["harness_id"]).toBe("codex");
    expect(p["spent_cents"]).toBe(0);
    expect(p["cost_source"]).toBe("harness");
    expect(p["exit_code"]).toBeNull();
    expect(p["blocked_attempts"]).toBe(0);
    expect(p["model_family"]).toBe("unknown");
  });

  it("不可逆 command 越权 ⇒ violation_aborted，且 turn.completed 从未被消费 + finally 落 started:true", async () => {
    let pulledAfterItem = false;
    const s = stubCodex(() =>
      (async function* (): AsyncGenerator<CodexEventLite> {
        yield { type: "thread.started", thread_id: "th-1" };
        yield itemEv("item.started", cmdItem("i-1", "rm -rf /"));
        // 消费方在 tool_call 之后【再来要】才会走到这一行；gateway 中断时
        // 生成器被 .return()，这个标志必须保持 false（宁停不污的适配器侧凭据）。
        pulledAfterItem = true;
        yield { type: "turn.completed", usage: USAGE };
      })(),
    );
    const a = new CodexCliAdapter({ codexCtor: s.ctor });
    const g = await callHarness(a, req(), deps());
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("violation_aborted");
    expect(pulledAfterItem).toBe(false);
    const run = a.takeRun();
    expect(run).not.toBeNull();
    expect(run?.ok).toBe(false);
    expect(run?.started).toBe(true);
    expect(run?.error).toContain("没有 turn.completed");
  });

  it("白名单外的 tool_call 单独判 blocked（gateway 第 1 层在这一家同样可达）", async () => {
    const a = new CodexCliAdapter({
      codexCtor: stubCodex(() =>
        evs([
          { type: "thread.started", thread_id: "th-1" },
          itemEv("item.completed", cmdItem("i-1", "git push --force")),
          { type: "turn.completed", usage: USAGE },
        ]),
      ).ctor,
    });
    const d = deps();
    // 这一发判的是第 1 层：allowed_tools 只留 Read，command 译出的 Bash 不在名单上。
    const g = await callHarness(a, req({ allowed_tools: ["Read"] }), d);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("violation_aborted");
    const callRow = d.rows.find(
      (r: AuditRow): boolean => r.action === "harness_call",
    );
    expect(callRow).toBeDefined();
    const p = callRow?.payload as Record<string, unknown>;
    expect(p["status"]).toBe("blocked");
    expect(p["blocked_attempts"]).toBe(1);
    expect(
      d.rows.some(
        (r: AuditRow): boolean => r.action === "unauthorized_attempt",
      ),
    ).toBe(true);
  });
});
