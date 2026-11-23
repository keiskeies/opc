/**
 * QoderCliAdapter 的契约测试（2026-11，执行器七件套 T6）。
 *
 * 对面是【注入的 query 桩】而不是真 SDK：本文件要钉的是形状翻译（消息流 →
 * 事件流、Credits → 美分、三态接缝、capability_gap 拒），这些全在翻译层，
 * SDK 真链路那半段离线拿不到（立场与 gateway.ts「Task 5.5 之前不装作测过 SDK」
 * 同源）。桩的注入缝（queryFn）就是默认装载器的对偶：真装载器只多一个
 * dynamic import，两条路共用 #optionsFor / #stream 的全部逻辑。
 * claude-adapter.test.ts 走真子进程是因为那一家的接缝在 spawn argv；
 * 这一家的接缝在消息形状，桩注入才是承重测法。
 *
 * 判据清单：
 *  ① 事件流形状：session_started（init 到）→ tool_call（tool_use 逐发）→
 *     usage（含 token 真读数）→ finished（exitCode:null）；finished 唯一且最后；
 *  ② 能力逐格 + capability_gap：max_budget_usd>0 与 output_schema 两发必须红，
 *     且桩一次都没被调（声明即判据的机器凭据）；
 *  ③ on-request ⇒ canUseTool 桥：放行/拒绝两向 + args 两路同形（判定缓存键的凭据）；
 *  ④ 三态：result 成功 / result 失败 started:true / 首帧前抛 started:false+errno /
 *     中途抛 started:true / 流尽无 result；takeRun 取走即清；
 *  ⑤ session 两路兜底与【不发】session_started 的那格；
 *  ⑥ 越权中断：gateway 观测到未授权 tool_call ⇒ .return() 我们的生成器，
 *     桩必须证「result 那帧从未被消费」+ finally 落了 started:true。
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
  QoderCanUseToolLite,
  QoderQueryOptionsLite,
  QoderSdkMessageLite,
} from "../../../src/harness/adapters/qoder.js";
import {
  qoderModelFamilyOf,
  qoderPermissionModeFor,
  QoderCliAdapter,
} from "../../../src/harness/adapters/qoder.js";
import type { GatewayDeps } from "../../../src/harness/gateway.js";
import { callHarness } from "../../../src/harness/gateway.js";

const WS = "/tmp/opc-qoder-test-ws";
const APPROVE_ALL: ApprovalHandler = async () => ({ approved: true });

function req(over: Partial<HarnessRequestInput> = {}): HarnessRequest {
  return harnessRequestSchema.parse({
    task_id: "t-qoder",
    role_id: "dev",
    instruction: "把这件事做完",
    workspace: WS,
    sandbox: "read-only",
    approval_policy: "never",
    allowed_tools: ["Read", "Edit", "Bash"],
    forbidden_flags: ["--dangerously-skip-permissions"],
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
    grantedForbidden: ["--dangerously-skip-permissions"],
  };
}

/** 成功一轮的最小消息流：init → assistant(text+tool_use) → result。 */
function successMsgs(): QoderSdkMessageLite[] {
  return [
    {
      type: "system",
      subtype: "init",
      session_id: "sess-1",
      qodercli_version: "1.0.59-test",
      model: "qoder-cli",
    },
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "先读一下。" },
          { type: "tool_use", id: "tu-1", name: "Read", input: { path: WS + "/a.ts" } },
        ],
      },
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "读完了。",
      total_credits: 0.042,
      usage: { input_tokens: 1200, output_tokens: 88 },
    },
  ];
}

function stubMsgs(msgs: QoderSdkMessageLite[]) {
  const calls: Array<{ prompt: string; options: QoderQueryOptionsLite }> = [];
  const fn = (params: {
    prompt: string;
    options?: QoderQueryOptionsLite;
  }): AsyncIterable<QoderSdkMessageLite> => {
    calls.push({ prompt: params.prompt, options: params.options ?? {} });
    return (async function* (): AsyncGenerator<QoderSdkMessageLite> {
      for (const m of msgs) yield m;
    })();
  };
  return { fn, calls };
}

async function collect(
  it: AsyncIterable<HarnessEvent>,
): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

describe("qoderPermissionModeFor / qoderModelFamilyOf —— 映射逐格", () => {
  it("on-request⇒default（问人）；never+read-only⇒plan；never+写档⇒bypass", () => {
    expect(
      qoderPermissionModeFor(req({ approval_policy: "on-request" })),
    ).toBe("default");
    expect(qoderPermissionModeFor(req())).toBe("plan");
    expect(
      qoderPermissionModeFor(req({ sandbox: "workspace-write" })),
    ).toBe("bypassPermissions");
    expect(qoderPermissionModeFor(req({ sandbox: "danger" }))).toBe(
      "bypassPermissions",
    );
    // on-request 压过沙箱档：read-only 也要问人（档位只管【能碰什么】）。
    expect(
      qoderPermissionModeFor(
        req({ sandbox: "read-only", approval_policy: "on-request" }),
      ),
    ).toBe("default");
  });

  it("家族识别认 claude/gpt/o 系列/qwen，认不出 ⇒ unknown 不猜", () => {
    expect(qoderModelFamilyOf("claude-sonnet-4.5")).toBe("claude");
    expect(qoderModelFamilyOf("gpt-5-codex")).toBe("gpt");
    expect(qoderModelFamilyOf("o3-mini")).toBe("gpt");
    expect(qoderModelFamilyOf("QWEN-MAX")).toBe("qwen");
    expect(qoderModelFamilyOf("some-new-model")).toBe("unknown");
    expect(qoderModelFamilyOf(undefined)).toBe("unknown");
  });
});

describe("QoderCliAdapter —— 事件流的形状", () => {
  it("全链成功一轮：session_started→tool_call→usage→finished，finished 唯一且最后", async () => {
    const { fn, calls } = stubMsgs(successMsgs());
    const a = new QoderCliAdapter({ queryFn: fn });
    const evs = await collect(a.execute(req(), APPROVE_ALL));
    expect(evs.map((e: HarnessEvent): string => e.kind)).toEqual([
      "session_started",
      "tool_call",
      "usage",
      "finished",
    ]);
    expect(
      evs.filter((e: HarnessEvent): boolean => e.kind === "finished"),
    ).toHaveLength(1);
    const fin = evs[3];
    expect(fin?.kind === "finished" ? fin.exitCode : 0).toBeNull();
    expect(fin?.kind === "finished" ? fin.outcome.output : "").toBe("读完了。");
    // Credits→美分口径塌缩：0.042 ⇒ 4；token 两格带真读数（不是 undefined）。
    const usage = evs[2];
    if (usage?.kind !== "usage") throw new Error("usage 不在第二位之后");
    expect(usage.cost.spentCents).toBe(4);
    expect(usage.cost.inputTokens).toBe(1200);
    expect(usage.cost.outputTokens).toBe(88);
    expect(usage.cost.source).toBe("harness");
    // tool_call 带脱敏后的参数（Read 的 path 不是密钥键，原样保留）。
    const tc = evs[1];
    expect(tc?.kind === "tool_call" ? tc.tool : "").toBe("Read");
    expect(tc?.kind === "tool_call" ? tc.redactedArgs : null).toEqual({
      path: WS + "/a.ts",
    });
    // 版本读 init 的 qodercli_version（没有装配期 version 时）。
    expect(
      fin?.kind === "finished" ? fin.outcome.harnessVersion : "",
    ).toBe("1.0.59-test");
    // takeRun 取走一次即清空。
    const run = a.takeRun();
    expect(run?.ok).toBe(true);
    expect(a.takeRun()).toBeNull();
    // prompt 原样进 query；会话 id 落进 run。
    expect(calls[0]?.prompt).toBe("把这件事做完");
    expect(run?.sessionId).toBe("sess-1");
  });

  it("装配形状：bypass 与 skip 格并给；on-request 不预授权；forbiddenFlags 不进 SDK；auth 缺省 qodercli", async () => {
    const { fn, calls } = stubMsgs(successMsgs());
    const a = new QoderCliAdapter({ queryFn: fn });
    await collect(a.execute(req({ sandbox: "workspace-write" }), APPROVE_ALL));
    const o = calls[0]?.options as QoderQueryOptionsLite;
    expect(o.permissionMode).toBe("bypassPermissions");
    expect(o.allowDangerouslySkipPermissions).toBe(true);
    expect(o.auth).toEqual({ type: "qodercli" });
    // never 档 allowedTools 照传（那时 SDK 的预授权与我们的判定同向）。
    expect(o.allowedTools).toEqual(["Read", "Edit", "Bash"]);
    // disallowedTools 压根不在消费面上：CLI 开关串映射不到 SDK 工具格，
    // 「看起来接了线」的装饰比不接更糟（执法点在 gateway 的 requestedArgs）。
    expect("disallowedTools" in o).toBe(false);

    const r2 = stubMsgs(successMsgs());
    const a2 = new QoderCliAdapter({ queryFn: r2.fn });
    await collect(
      a2.execute(
        req({ approval_policy: "on-request", sandbox: "workspace-write" }),
        APPROVE_ALL,
      ),
    );
    const o2 = r2.calls[0]?.options as QoderQueryOptionsLite & {
      canUseTool?: unknown;
      resume?: string;
    };
    // on-request ⇒ 不预授权（每一发走 canUseTool 进第 3 层）+ 回调在场。
    expect(o2.allowedTools).toBeUndefined();
    expect(typeof o2.canUseTool).toBe("function");
    expect(o2.allowDangerouslySkipPermissions).toBeUndefined();
    expect(o2.resume).toBeUndefined();

    const r3 = stubMsgs(successMsgs());
    const a3 = new QoderCliAdapter({ queryFn: r3.fn });
    await collect(a3.execute(req({ resume_session_id: "sess-old" }), APPROVE_ALL));
    // resume 就在 QoderQueryOptionsLite 上，无需 cast：?. 从 calls[0] 一路传到
    // resume，整条链都是可选的（cast 之后再接点号才会撞 unsafe-chaining）。
    expect(r3.calls[0]?.options.resume).toBe("sess-old");
  });

  it("plan 档不并给 skip 对（read-only 的放开形状是规划而不是旁路。", async () => {
    const { fn, calls } = stubMsgs(successMsgs());
    const a = new QoderCliAdapter({ queryFn: fn });
    await collect(a.execute(req(), APPROVE_ALL));
    const o = calls[0]?.options as QoderQueryOptionsLite;
    expect(o.permissionMode).toBe("plan");
    expect(o.allowDangerouslySkipPermissions).toBeUndefined();
  });

  it("credits 兜底：total_credits 缺 ⇒ usage.credits；两格都缺 ⇒ 0 且来源仍 harness", async () => {
    const m = successMsgs();
    m[2] = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
      usage: { input_tokens: 10, output_tokens: 2, credits: 0.07 },
    };
    const a = new QoderCliAdapter({ queryFn: stubMsgs(m).fn });
    const evs = await collect(a.execute(req(), APPROVE_ALL));
    const usage = evs.find((e: HarnessEvent): boolean => e.kind === "usage");
    expect(usage?.kind === "usage" ? usage.cost.spentCents : -1).toBe(7);

    const m2 = successMsgs();
    m2[2] = { type: "result", subtype: "success", is_error: false, result: "ok" };
    const a2 = new QoderCliAdapter({ queryFn: stubMsgs(m2).fn });
    const evs2 = await collect(a2.execute(req(), APPROVE_ALL));
    const u2 = evs2.find((e: HarnessEvent): boolean => e.kind === "usage");
    if (u2?.kind !== "usage") throw new Error("usage 缺失");
    expect(u2.cost.spentCents).toBe(0);
    // token【没读到】⇒ undefined 而不是 0（契约点名的假话形状）。
    expect(u2.cost.inputTokens).toBeUndefined();
  });

  it("init 没给 session 而 result 兜到 ⇒ session_started 补发在 usage 之前", async () => {
    const m: QoderSdkMessageLite[] = [
      { type: "system", subtype: "init", qodercli_version: "1.0.59-test" },
      { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "sess-late" },
    ];
    const a = new QoderCliAdapter({ queryFn: stubMsgs(m).fn });
    const evs = await collect(a.execute(req(), APPROVE_ALL));
    expect(evs.map((e: HarnessEvent): string => e.kind)).toEqual([
      "session_started",
      "usage",
      "finished",
    ]);
    expect(evs[0]?.kind === "session_started" ? evs[0].sessionId : "").toBe(
      "sess-late",
    );
  });

  it("两路都没有 session ⇒【不发】session_started，takeRun.sessionId 是 null 不是编的", async () => {
    const m: QoderSdkMessageLite[] = [
      { type: "system", subtype: "init", qodercli_version: "1.0.59-test" },
      { type: "result", subtype: "success", is_error: false, result: "ok" },
    ];
    const a = new QoderCliAdapter({ queryFn: stubMsgs(m).fn });
    const evs = await collect(a.execute(req(), APPROVE_ALL));
    expect(evs.map((e: HarnessEvent): string => e.kind)).toEqual([
      "usage",
      "finished",
    ]);
    expect(a.takeRun()?.sessionId).toBeNull();
  });

  it("模型家族：init.model 是真读数；认不出时继承请求期望，两者皆空 ⇒ unknown", async () => {
    const m = successMsgs();
    // noUncheckedIndexedAccess 下 m[0] 可能缺位，展开前判掉：
    // { ...m[0] } 的 m[0] 若含 undefined，展平出来 type 会变成可选 ⇒ 落不回 Lite。
    const init = m[0];
    if (init === undefined) throw new Error("successMsgs 缺 init 帧");
    m[0] = { ...init, model: "claude-sonnet-4.5" };
    const a = new QoderCliAdapter({ queryFn: stubMsgs(m).fn });
    const evs = await collect(a.execute(req(), APPROVE_ALL));
    const fin = evs[3];
    expect(fin?.kind === "finished" ? fin.outcome.modelFamily : "").toBe("claude");

    const a2 = new QoderCliAdapter({ queryFn: stubMsgs(successMsgs()).fn });
    const evs2 = await collect(
      a2.execute(req({ model_family: "gpt" }), APPROVE_ALL),
    );
    const fin2 = evs2[3];
    expect(fin2?.kind === "finished" ? fin2.outcome.modelFamily : "").toBe("gpt");
  });

  it("版本优先级：装配期 version > init 读数 > unknown", async () => {
    const a = new QoderCliAdapter({
      queryFn: stubMsgs(successMsgs()).fn,
      version: "9.9.9-opt",
    });
    const evs = await collect(a.execute(req(), APPROVE_ALL));
    expect(
      evs[3]?.kind === "finished" ? evs[3].outcome.harnessVersion : "",
    ).toBe("9.9.9-opt");

    const m = successMsgs();
    m[0] = { type: "system", subtype: "init", session_id: "s" };
    const a2 = new QoderCliAdapter({ queryFn: stubMsgs(m).fn });
    const evs2 = await collect(a2.execute(req(), APPROVE_ALL));
    expect(
      evs2[3]?.kind === "finished" ? evs2[3].outcome.harnessVersion : "",
    ).toBe("unknown");
  });
});

describe("QoderCliAdapter —— canUseTool 桥", () => {
  it("放行/拒绝两向 + args 两路同形（判定缓存键的凭据）", async () => {
    // 持有槽用对象而不是裸 let：裸 let 的控制流分析只看 CFG 里的赋值
    // （= 只有初始化 null），回调里的写入不接入流程图 ⇒ 判 null 后收窄成 never。
    const captured: { fn: QoderCanUseToolLite | null } = { fn: null };
    const fn = (params: {
      prompt: string;
      options?: QoderQueryOptionsLite;
    }): AsyncIterable<QoderSdkMessageLite> => {
      captured.fn =
        (params.options as { canUseTool?: QoderCanUseToolLite }).canUseTool ?? null;
      return (async function* (): AsyncGenerator<QoderSdkMessageLite> {
        yield* successMsgs();
      })();
    };
    const seen: Array<{ tool: string; args: unknown; reason: string }> = [];
    const handler: ApprovalHandler = async (r) => {
      seen.push({ tool: r.tool, args: r.args, reason: r.reason });
      return { approved: true };
    };
    const a = new QoderCliAdapter({ queryFn: fn });
    await collect(
      a.execute(req({ approval_policy: "on-request" }), handler),
    );
    if (captured.fn === null) throw new Error("canUseTool 没装配");
    const allow = await captured.fn(
      "Bash",
      { command: "ls", token: "sk-abc" },
      { toolUseID: "tu-9" },
    );
    expect(allow.behavior).toBe("allow");
    expect(seen[0]?.tool).toBe("Bash");
    // 审批侧拿到的 args 是【脱敏后】形状（token 整值替换）——
    // 与事件流那一发的 redactedArgs 同形，gateway 的 verdictKey 才能合成一个键。
    expect(seen[0]?.args).toEqual({ command: "ls", token: "[redacted]" });
    expect(seen[0]?.reason).toContain("tu-9");

    const denyHandler: ApprovalHandler = async () => ({
      approved: false,
      decidedBy: "测试员",
      note: "这个不许",
    });
    const a2 = new QoderCliAdapter({ queryFn: fn });
    await collect(
      a2.execute(req({ approval_policy: "on-request" }), denyHandler),
    );
    if (captured.fn === null) throw new Error("canUseTool 没装配");
    const deny = await captured.fn(
      "Bash",
      { command: "ls" },
      { toolUseID: "tu-10" },
    );
    expect(deny.behavior).toBe("deny");
    // deny message 进模型可见面：「谁拒的」必须在（decidedBy）而不是空话。
    expect(deny.behavior === "deny" ? deny.message : "").toContain("测试员");
    expect(deny.behavior === "deny" ? deny.message : "").toContain("这个不许");
  });

  it("never 档压根不装 canUseTool（没人来批 ⇒ 不存在该问的问题）", async () => {
    let opts: QoderQueryOptionsLite | null = null;
    const fn = (params: {
      prompt: string;
      options?: QoderQueryOptionsLite;
    }): AsyncIterable<QoderSdkMessageLite> => {
      opts = params.options ?? {};
      return (async function* (): AsyncGenerator<QoderSdkMessageLite> {
        yield* successMsgs();
      })();
    };
    const a = new QoderCliAdapter({ queryFn: fn });
    await collect(a.execute(req(), APPROVE_ALL));
    expect(
      (opts as unknown as { canUseTool?: unknown })?.canUseTool === undefined,
    ).toBe(true);
  });
});

describe("QoderCliAdapter —— 三态与失败形状", () => {
  it("result 业务失败 ⇒ finished 照发、takeRun ok:false started:true、账单保留", async () => {
    const m: QoderSdkMessageLite[] = [
      { type: "system", subtype: "init", session_id: "sess-1" },
      {
        type: "result",
        subtype: "error_during_execution",
        errors: ["上下文超限"],
        total_credits: 0.03,
      },
    ];
    const a = new QoderCliAdapter({ queryFn: stubMsgs(m).fn });
    const evs = await collect(a.execute(req(), APPROVE_ALL));
    expect(evs.map((e: HarnessEvent): string => e.kind)).toEqual([
      "session_started",
      "usage",
      "finished",
    ]);
    const run = a.takeRun();
    expect(run?.ok).toBe(false);
    expect(run?.started).toBe(true); // 会话真存在过，钱可能真花了
    expect(run?.error).toContain("上下文超限");
    expect(run?.costUsd).toBeCloseTo(0.03);
  });

  it("首帧前抛 ⇒ started:false + errno 透出（可进重试白名单的那一族）", async () => {
    const fn = (): AsyncIterable<QoderSdkMessageLite> => {
      throw Object.assign(new Error("daemon 起不来"), { code: "ENOENT" });
    };
    const a = new QoderCliAdapter({ queryFn: fn });
    const evs = await collect(a.execute(req(), APPROVE_ALL));
    expect(evs.map((e: HarnessEvent): string => e.kind)).toEqual([
      "usage",
      "finished",
    ]);
    const run = a.takeRun();
    expect(run?.started).toBe(false);
    expect(run?.spawnErrno).toBe("ENOENT");
    expect(run?.error).toContain("daemon 起不来");
  });

  it("中途抛 ⇒ started:true、errno 空（起过会话就不可自动重试）", async () => {
    const fn = (): AsyncIterable<QoderSdkMessageLite> =>
      (async function* (): AsyncGenerator<QoderSdkMessageLite> {
        yield { type: "system", subtype: "init", session_id: "sess-1" };
        throw new Error("连接被掐");
      })();
    const a = new QoderCliAdapter({ queryFn: fn });
    await collect(a.execute(req(), APPROVE_ALL));
    const run = a.takeRun();
    expect(run?.started).toBe(true);
    expect(run?.spawnErrno).toBe("");
    expect(run?.error).toContain("连接被掐");
  });

  it("流尽而无 result ⇒ ok:false + 点名「没有 result」，不编空成功", async () => {
    const m: QoderSdkMessageLite[] = [
      { type: "system", subtype: "init", session_id: "sess-1" },
    ];
    const a = new QoderCliAdapter({ queryFn: stubMsgs(m).fn });
    await collect(a.execute(req(), APPROVE_ALL));
    const run = a.takeRun();
    expect(run?.ok).toBe(false);
    expect(run?.error).toContain("没有 result");
  });

  it("resume 没有 seedResumeRequest ⇒ 抛，而不是编一个默认工作区", () => {
    const a = new QoderCliAdapter({ queryFn: stubMsgs(successMsgs()).fn });
    expect(() => a.resume("sess-x", APPROVE_ALL)).toThrow(
      /seedResumeRequest/,
    );
  });

  it("getCost 如实抛：SDK 路线没有跨调用会话账，返回全零会是假话", async () => {
    const a = new QoderCliAdapter({ queryFn: stubMsgs(successMsgs()).fn });
    await expect(a.getCost("sess-1")).rejects.toThrow(/会话账/);
  });
});

describe("QoderCliAdapter × callHarness —— 声明即判据", () => {
  it("能力逐格如实声明（谎报任一格 ⇒ 本发与下面几发一起红）", () => {
    const a = new QoderCliAdapter({ queryFn: stubMsgs(successMsgs()).fn });
    expect(a.capabilities).toEqual({
      budgetHardCap: false,
      toolApproval: true,
      resume: true,
      structuredOutput: false,
    });
    expect(a.id).toBe("qoder");
  });

  it("带 USD 硬顶的请求 ⇒ capability_gap 拒且桩一次都没被调（SDK 没有预算参数）", async () => {
    let called = 0;
    const fn = (): AsyncIterable<QoderSdkMessageLite> => {
      called += 1;
      return (async function* (): AsyncGenerator<QoderSdkMessageLite> {
        yield* successMsgs();
      })();
    };
    const a = new QoderCliAdapter({ queryFn: fn });
    const g = await callHarness(a, req({ max_budget_usd: 0.5 }), deps());
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("capability_gap");
    expect(called).toBe(0);
  });

  it("output_schema ⇒ capability_gap（声明 structuredOutput=false 的返回侧同样成立）", async () => {
    const a = new QoderCliAdapter({ queryFn: stubMsgs(successMsgs()).fn });
    const g = await callHarness(a, req({ output_schema: "decision" }), deps());
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("capability_gap");
  });

  it("on-request 发得出去（qoder 真能问人），审计行的 prevention 落 enforced", async () => {
    const a = new QoderCliAdapter({ queryFn: stubMsgs(successMsgs()).fn });
    const d = deps();
    const g = await callHarness(
      a,
      req({ approval_policy: "on-request" }),
      d,
    );
    expect(g.ok, g.ok ? "" : g.reason).toBe(true);
    const row = d.rows[0];
    const p = row?.payload as Record<string, unknown>;
    expect(p["prevention"]).toBe("enforced");
    expect(p["harness_id"]).toBe("qoder");
    expect(p["status"]).toBe("ok");
  });

  it("never 档 prevention 落 observed_only（同一次成功，两家的否决权差别在审计里可见）", async () => {
    const a = new QoderCliAdapter({ queryFn: stubMsgs(successMsgs()).fn });
    const d = deps();
    const g = await callHarness(a, req(), d);
    expect(g.ok).toBe(true);
    const p = d.rows[0]?.payload as Record<string, unknown>;
    expect(p["prevention"]).toBe("observed_only");
    if (g.ok) {
      expect(g.result.sessionId).toBe("sess-1");
      expect(g.result.cost.spentCents).toBe(4);
      expect(g.result.exitCode).toBeNull();
      expect(g.result.harnessVersion).toBe("1.0.59-test");
    }
  });

  it("未授权 tool_call ⇒ violation_aborted，且 result 那帧从未被消费 + finally 落 started:true", async () => {
    let pulledAfterTool = false;
    const fn = (): AsyncIterable<QoderSdkMessageLite> =>
      (async function* (): AsyncGenerator<QoderSdkMessageLite> {
        yield { type: "system", subtype: "init", session_id: "sess-1" };
        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "tu-1",
                name: "Bash",
                input: { command: "rm -rf /" },
              },
            ],
          },
        };
        // 消费方在 tool_call 之后【再来要】才会走到这一行；gateway 中断时
        // 生成器被 .return()，这个标志必须保持 false（宁停不污的适配器侧凭据）。
        pulledAfterTool = true;
        yield { type: "result", subtype: "success", is_error: false, result: "不该被消费" };
      })();
    const a = new QoderCliAdapter({ queryFn: fn });
    const g = await callHarness(
      a,
      req({ allowed_tools: ["Read"] }),
      deps(),
    );
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("violation_aborted");
    expect(pulledAfterTool).toBe(false);
    const run = a.takeRun();
    expect(run).not.toBeNull();
    expect(run?.ok).toBe(false);
    expect(run?.started).toBe(true);
    expect(run?.error).toContain("没有 result");
  });

  it("白名单外的 tool_call 单独判 blocked（gateway 第 1 层在这一家同样可达）", async () => {
    const m: QoderSdkMessageLite[] = [
      { type: "system", subtype: "init", session_id: "sess-1" },
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "tu-1", name: "NotebookEdit", input: {} },
          ],
        },
      },
      { type: "result", subtype: "success", is_error: false, result: "ok" },
    ];
    const a = new QoderCliAdapter({ queryFn: stubMsgs(m).fn });
    const d = deps();
    const g = await callHarness(a, req({ allowed_tools: ["Read"] }), d);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("violation_aborted");
    // violation_aborted 会先落一行 unauthorized_attempt（那是「观测到越权」的账），
    // 再落 harness_call 汇总行（status/blocked_attempts 在汇总行上，不在 attempt 行上）。
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

  it("tool_use 同一 id 重复通报 ⇒ 判定恰好一次（第二发被 emitted 吞掉）", async () => {
    const block = { type: "tool_use", id: "tu-1", name: "NotebookEdit", input: {} };
    const m: QoderSdkMessageLite[] = [
      { type: "system", subtype: "init", session_id: "sess-1" },
      { type: "assistant", message: { content: [block] } },
      { type: "assistant", message: { content: [block] } },
      { type: "result", subtype: "success", is_error: false, result: "ok" },
    ];
    const a = new QoderCliAdapter({ queryFn: stubMsgs(m).fn });
    const evs = await collect(a.execute(req(), APPROVE_ALL));
    const tcs = evs.filter(
      (e: HarnessEvent): boolean => e.kind === "tool_call",
    );
    expect(tcs).toHaveLength(1);
  });
});
