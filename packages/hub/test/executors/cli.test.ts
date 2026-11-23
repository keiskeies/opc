/**
 * CLI 执行器（T6）的行为判据。
 *
 * 两条腿都走：
 *  · 桩工厂腿 —— 四格出口的每一格用【注入的假适配器】精确造形状（spawn 失败、
 *    业务错、gateway 前置拒、全绿），断的是执行器层的分类与重试语义；
 *  · 真适配器腿 —— 真 ClaudeCliAdapter + fake-claude.mjs 桩进程，断的是
 *    config.model → --model、role_prompt → --append-system-prompt、
 *    resume_session_id → --resume 这三条装配链真的到了 argv
 *    （桩文件自己回显，不读源码相信）。
 * 审计判据走真 WriteQueue+迁移（同 run.test.ts 立场）：一次尝试恰好一行
 * executor_run，gateway 的 harness_call 缓冲行同事务落盘。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExecutorKind,
  ExecutorRunRequest,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessEvent,
  HarnessId,
  HarnessRequest,
} from "@opc/contracts";
import { executorRunRequestSchema } from "@opc/contracts";
import { afterAll, describe, expect, it, vi } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import type { RoleRunResult } from "../../src/engine/claude.js";
import type {
  CliExecutorKind,
  CliExecutorOptions,
} from "../../src/executors/cli.js";
import { CliExecutor } from "../../src/executors/cli.js";
import type { HarnessAdapterFactory } from "../../src/harness/harness-runner.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("executors-cli", import.meta.url);
mkdirSync(TMP, { recursive: true });
// 真适配器腿的工作区：gateway 校验 workspace 存在性，指到真目录（与
// test/harness/gateway-runner.test.ts 同一 Windows 说明：/tmp 由 node 归一到当前盘）。
mkdirSync("/tmp", { recursive: true });
const WS = mkdtempSync("/tmp/opc-exec-cli-");
/** argv 回显桩（engine/fixtures）：result 正文里带 {model, systemPrompt, resumed…}。 */
const FAKE = fileURLToPath(
  new URL("../engine/fixtures/fake-claude.mjs", import.meta.url),
);

type AnyDb = {
  prepare: (sql: string) => {
    all: (...a: unknown[]) => Record<string, unknown>[];
    get: (...a: unknown[]) => Record<string, unknown> | undefined;
    run: (...a: unknown[]) => unknown;
  };
  exec: (sql: string) => void;
};

const NOW = Date.UTC(2026, 10, 24);
const queues: WriteQueue[] = [];
let fileSeq = 0;

/** 真库：迁移 + task 行（events.task_id 有 FK，审计行要真 task）。 */
async function newQ(): Promise<{ q: WriteQueue; db: AnyDb }> {
  const path = join(TMP, "cli-" + process.pid + "-" + ++fileSeq + ".db");
  const q = new WriteQueue(path) as WriteQueue;
  queues.push(q);
  const db = (
    q as unknown as { writeConnection: () => AnyDb }
  ).writeConnection();
  migrate(db as never);
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at)" +
      " VALUES ('t1', '任务', 'draft', 'dev', 'start', ?, ?)",
  ).run(NOW, NOW);
  return { q, db };
}

afterAll(async () => {
  for (const q of queues) {
    try {
      await (q as unknown as { close?: () => Promise<void> | void }).close?.();
    } catch {
      /* 关掉失败不影响别的 */
    }
  }
  rmSync(WS, { recursive: true, force: true });
  rmSync(TMP, { recursive: true, force: true });
});

/** 合规请求（CLI 恒带 workspace —— 契约 superRefine 的要求；缺格用例自己删键）。 */
function req(over: Partial<ExecutorRunRequest> = {}): ExecutorRunRequest {
  const kind = (over.kind ?? "claude-cli") as ExecutorKind;
  return executorRunRequestSchema.parse({
    execution_id: over.execution_id ?? "exec:t1:1",
    task_id: over.task_id ?? "t1",
    member_id: over.member_id ?? "m1",
    role_id: over.role_id ?? "dev",
    seq: over.seq ?? 1,
    kind,
    config: over.config ?? { kind },
    model_tier: over.model_tier ?? "execution",
    instruction: over.instruction ?? "把按钮文案改掉",
    role_prompt: over.role_prompt ?? "你是开发工程师",
    workspace: WS,
    max_budget_usd: over.max_budget_usd ?? 0,
    ...(over.bin === undefined ? {} : { bin: over.bin }),
    ...(over.resume_session_id === undefined
      ? {}
      : { resume_session_id: over.resume_session_id }),
    ...(over.timeout_ms === undefined ? {} : { timeout_ms: over.timeout_ms }),
  });
}

/**
 * 可控桩适配器：takeRun 恒交 preset；事件流按 emit 决定发不发
 * （emit=false 模拟「一帧没发」—— 与 spawn ENOENT 时真适配器的形状一致）。
 */
class StubAdapter implements HarnessAdapter {
  readonly id: HarnessId;
  readonly capabilities: HarnessCapabilities;
  #run: RoleRunResult | null;
  #emit: boolean;
  readonly seen: { reqs: HarnessRequest[]; resumed: string[] } = {
    reqs: [],
    resumed: [],
  };

  constructor(
    id: HarnessId,
    caps: HarnessCapabilities,
    run: RoleRunResult | null,
    emit: boolean,
  ) {
    this.id = id;
    this.capabilities = caps;
    this.#run = run;
    this.#emit = emit;
  }

  takeRun(): RoleRunResult | null {
    const r = this.#run;
    this.#run = null;
    return r;
  }

  seedResumeRequest(_req: HarnessRequest): void {}

  execute(r: HarnessRequest): AsyncIterable<HarnessEvent> {
    this.seen.reqs.push(r);
    return this.#stream();
  }

  resume(sessionId: string): AsyncIterable<HarnessEvent> {
    this.seen.resumed.push(sessionId);
    return this.#stream();
  }

  getCost(): Promise<never> {
    return Promise.reject(new Error("stub 无会话账"));
  }

  async *#stream(): AsyncGenerator<HarnessEvent> {
    const r = this.#run;
    if (!this.#emit || r === null) return;
    if (r.sessionId !== null) {
      yield { kind: "session_started", sessionId: r.sessionId };
    }
    yield {
      kind: "usage",
      cost: {
        spentCents: Math.round(r.costUsd * 100),
        remainingCents: null,
        // token 两格在 CostReport（transform 输出）里是必填格、值可为 undefined ——
        // 桩与 claude.ts #costOf 同形：属性在场、值 undefined 才是「没记到」。
        inputTokens: undefined,
        outputTokens: undefined,
        source: "harness",
      },
    };
    yield {
      kind: "finished",
      exitCode: r.ok ? 0 : 1,
      outcome: {
        harnessId: this.id,
        harnessVersion: "stub",
        modelFamily: "unknown",
        output: r.text,
        diffHash: null,
        structured: undefined,
      },
    };
  }
}

const CLAUDE_CAPS: HarnessCapabilities = {
  budgetHardCap: true,
  toolApproval: false,
  resume: true,
  structuredOutput: false,
};
const NO_HARD_CAP: HarnessCapabilities = {
  budgetHardCap: false,
  toolApproval: true,
  resume: true,
  structuredOutput: false,
};

function okRunResult(text = "第一行摘要\n第二行"): RoleRunResult {
  return {
    ok: true,
    text,
    sessionId: "sess-9",
    costUsd: 0.04,
    error: null,
    started: true,
    spawnErrno: "",
  };
}

/**
 * 桩工厂：记录被造次数。⚠ runHarnessDetailed 在 callHarness【之前】造适配器
 * （前置拒也在工厂之后才发生），所以「前置拒」的判据是 execute 未被调
 * （seen.reqs 空），不是工厂未被调。
 */
function stubFactory(
  id: HarnessId,
  caps: HarnessCapabilities,
  run: RoleRunResult | null,
  emit: boolean,
): {
  factory: HarnessAdapterFactory;
  made: () => number;
  last: () => StubAdapter;
} {
  let n = 0;
  let last: StubAdapter | null = null;
  const factory: HarnessAdapterFactory = () => {
    n += 1;
    last = new StubAdapter(id, caps, run, emit);
    return last;
  };
  return {
    factory,
    made: () => n,
    last: () => {
      if (last === null) throw new Error("工厂从未被调用");
      return last;
    },
  };
}

function executorWith(
  q: WriteQueue,
  kind: CliExecutorKind,
  factory: HarnessAdapterFactory,
  harnessId: HarnessId,
  gateway?: CliExecutorOptions["gateway"],
): CliExecutor {
  return new CliExecutor({
    writer: q,
    gateway: gateway ?? { audit: () => 0, charterHarnessDefaults: {} },
    // 计算键的字面量在 Partial<Record<CliExecutorKind,…>> 下推不出单键形状，
    // 这里断一次形（kind 已是 CliExecutorKind，值形状由参数类型保证）。
    // 断的是【非 undefined 那一支】：exactOptionalPropertyTypes 下
    // CliExecutorOptions["adapters"] 整型含 undefined，直接传会把「键存在但值未给」
    // 当成合法形状，而非空对象在这里就该红。
    adapters: {
      [kind]: { factory, harnessId },
    } as NonNullable<CliExecutorOptions["adapters"]>,
  });
}

function rowsWithKind(db: AnyDb, kind: string): Record<string, unknown>[] {
  return db
    .prepare("SELECT id, action, target, payload FROM events ORDER BY id")
    .all()
    .filter((r) => {
      const p = JSON.parse(String(r.payload)) as { kind?: string };
      return p.kind === kind;
    });
}

/** gateway 那一路的行按 action 认领（harness_call / unauthorized_attempt）。 */
function rowsWithAction(db: AnyDb, action: string): Record<string, unknown>[] {
  return db
    .prepare("SELECT id, action, target, payload FROM events ORDER BY id")
    .all()
    .filter((r) => String(r["action"]) === action);
}

describe("CliExecutor 四格出口", () => {
  it("全绿：summary=首行、cost_cents=gateway 整数美分、session_id、harness_result 原样", async () => {
    const { q, db } = await newQ();
    const s = stubFactory("claude-code", CLAUDE_CAPS, okRunResult(), true);
    const out = await executorWith(
      q,
      "claude-cli",
      s.factory,
      "claude-code",
    ).run(req());
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.summary).toBe("第一行摘要");
    expect(out.cost_cents).toBe(4);
    expect(out.session_id).toBe("sess-9");
    const hr = out.harness_result as Record<string, unknown> | undefined;
    expect(hr?.["harnessId"]).toBe("claude-code");
    // 审计：恰好一行 executor_run + gateway 的 harness_call 缓冲行同库落盘。
    const er = rowsWithKind(db, "executor_run");
    expect(er).toHaveLength(1);
    const p = JSON.parse(String(er[0]?.["payload"])) as Record<string, unknown>;
    expect(p["execution_id"]).toBe("exec:t1:1");
    expect(p["ok"]).toBe(true);
    expect(String(er[0]?.["target"])).toBe("executor:exec:t1:1:1");
    // gateway 行的认领键是 action（与 gateway-runner.test.ts 同一口径），
    // executor_run 的认领键是 payload.kind —— 两种形状各查各的。
    expect(rowsWithAction(db, "harness_call").length).toBeGreaterThanOrEqual(1);
  });

  it("起了进程但业务错：cli_failed、retry=true、账单不抹零", async () => {
    const { q, db } = await newQ();
    const run = {
      ...okRunResult(),
      ok: false,
      error: "CLI is_error",
      costUsd: 0.04,
    };
    const s = stubFactory("claude-code", CLAUDE_CAPS, run, true);
    const out = await executorWith(
      q,
      "claude-cli",
      s.factory,
      "claude-code",
    ).run(req());
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("cli_failed");
    expect(out.retry_next_executor).toBe(true);
    expect(out.cost_cents).toBe(4);
    expect(rowsWithKind(db, "executor_run")).toHaveLength(1);
  });

  it("spawn ENOENT：cli_spawn_failed、retry=false、spawn_errno 透出", async () => {
    const { q, db } = await newQ();
    const run: RoleRunResult = {
      ok: false,
      text: "",
      sessionId: null,
      costUsd: 0,
      error: "spawn claude ENOENT",
      started: false,
      spawnErrno: "ENOENT",
    };
    // 一帧不发 ⇒ gateway 以 no_session 拒 —— 执行器必须靠 spawnErrno 认这是
    // spawn 失败而不是安全拒（判序修复的核心用例）。
    const s = stubFactory("claude-code", CLAUDE_CAPS, run, false);
    const out = await executorWith(
      q,
      "claude-cli",
      s.factory,
      "claude-code",
    ).run(req());
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("cli_spawn_failed");
    expect(out.retry_next_executor).toBe(false);
    expect(out.spawn_errno).toBe("ENOENT");
    expect(rowsWithKind(db, "executor_run")).toHaveLength(1);
  });

  it("spawn EMFILE（资源型瞬时）：cli_spawn_failed、retry=true", async () => {
    const { q } = await newQ();
    const run: RoleRunResult = {
      ok: false,
      text: "",
      sessionId: null,
      costUsd: 0,
      error: "spawn EMFILE",
      started: false,
      spawnErrno: "EMFILE",
    };
    const s = stubFactory("claude-code", CLAUDE_CAPS, run, false);
    const out = await executorWith(
      q,
      "claude-cli",
      s.factory,
      "claude-code",
    ).run(req());
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("cli_spawn_failed");
    expect(out.retry_next_executor).toBe(true);
  });

  it("gateway 前置拒（qoder 带预算硬顶 ⇒ capability_gap）：gateway_refused、retry=false、execute 从未发生", async () => {
    const { q, db } = await newQ();
    const s = stubFactory("qoder", NO_HARD_CAP, null, false);
    const out = await executorWith(q, "qoder-cli", s.factory, "qoder").run(
      req({ kind: "qoder-cli", max_budget_usd: 5 }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("gateway_refused");
    expect(out.retry_next_executor).toBe(false);
    expect(out.spawn_errno).toBeUndefined();
    // 前置拒发生在 execute 之前（工厂会先被造 —— harness-runner 的形状）。
    expect(s.last().seen.reqs).toHaveLength(0);
    expect(s.last().seen.resumed).toHaveLength(0);
    // 前置拒的账：executor_run 一行照落（被拒也是尝试）。
    expect(rowsWithKind(db, "executor_run")).toHaveLength(1);
  });

  it("缺授权装配（buildGatewayDeps 抛）：executor_error、retry=true、原话进 message", async () => {
    const { q } = await newQ();
    const out = await new CliExecutor({
      writer: q,
      // 既无 charterHarnessDefaults 也无显式授权 ⇒ buildGatewayDeps 装配期抛。
      gateway: { audit: () => 0 },
    }).run(req());
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("executor_error");
    expect(out.retry_next_executor).toBe(true);
    expect(out.message).toContain("buildGatewayDeps");
  });

  it("工厂抛（装配错适配器）：executor_error、retry=true", async () => {
    const { q } = await newQ();
    const boom: HarnessAdapterFactory = () => {
      throw new Error("装配炸了");
    };
    const out = await executorWith(q, "claude-cli", boom, "claude-code").run(
      req(),
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("executor_error");
    expect(out.message).toContain("装配炸了");
  });

  it("缺 workspace：executor_error、retry=false（拒绝兜底开整仓读权限）", async () => {
    const { q } = await newQ();
    const s = stubFactory("claude-code", CLAUDE_CAPS, okRunResult(), true);
    const noWs = { ...req() } as Record<string, unknown>;
    delete noWs["workspace"];
    const out = await executorWith(
      q,
      "claude-cli",
      s.factory,
      "claude-code",
    ).run(noWs as unknown as ExecutorRunRequest);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code).toBe("executor_error");
    expect(out.retry_next_executor).toBe(false);
    expect(s.made()).toBe(0);
  });

  it("非 CLI kind 派进来：executor_error、retry=false、工厂不被碰", async () => {
    const { q } = await newQ();
    const s = stubFactory("claude-code", CLAUDE_CAPS, okRunResult(), true);
    const out = await executorWith(
      q,
      "claude-cli",
      s.factory,
      "claude-code",
    ).run(req({ kind: "human", config: { kind: "human" } }));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.retry_next_executor).toBe(false);
    expect(s.made()).toBe(0);
  });

  it("resume_session_id：gateway 走 adapter.resume 缝", async () => {
    const { q } = await newQ();
    const s = stubFactory("claude-code", CLAUDE_CAPS, okRunResult(), true);
    const out = await executorWith(
      q,
      "claude-cli",
      s.factory,
      "claude-code",
    ).run(req({ resume_session_id: "sess-R" }));
    expect(out.ok).toBe(true);
    expect(s.last().seen.resumed).toEqual(["sess-R"]);
  });

  it("qoder 的 role_prompt 前缀进 instruction（无 system prompt 槽的补偿）", async () => {
    const { q } = await newQ();
    const s = stubFactory("qoder", NO_HARD_CAP, okRunResult(), true);
    const out = await executorWith(q, "qoder-cli", s.factory, "qoder").run(
      req({ kind: "qoder-cli", role_prompt: "你是设计师" }),
    );
    expect(out.ok).toBe(true);
    const seen = s.last().seen.reqs[0] as HarnessRequest | undefined;
    if (seen === undefined) throw new Error("execute 没被调用");
    expect(seen.instruction.startsWith("你是设计师\n\n")).toBe(true);
  });

  it("审计写不进去 ⇒ 执行结论照常返回，console.error 大声记", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deadWriter = {
      node: async (): Promise<never> => {
        throw new Error("写队列死了");
      },
    } as unknown as WriteQueue;
    const s = stubFactory("claude-code", CLAUDE_CAPS, okRunResult(), true);
    const ex = new CliExecutor({
      writer: deadWriter,
      gateway: { audit: () => 0, charterHarnessDefaults: {} },
      adapters: {
        "claude-cli": { factory: s.factory, harnessId: "claude-code" },
      },
    });
    const out = await ex.run(req());
    expect(out.ok).toBe(true);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0]?.[0])).toContain("审计落盘失败");
    errSpy.mockRestore();
  });
});

describe("CliExecutor 真适配器腿（fake-claude.mjs 的 argv 回显）", () => {
  /** 桩把收到的 argv 关键格回显成 JSON 塞在正文首段。 */
  function echoOf(output: string): Record<string, string | boolean> {
    return JSON.parse(
      output.slice(output.indexOf("{"), output.indexOf("}") + 1),
    ) as Record<string, string | boolean>;
  }

  it("config.model → --model、role_prompt → --append-system-prompt、resume → --resume 全到 argv", async () => {
    const { q } = await newQ();
    const ex = new CliExecutor({
      writer: q,
      gateway: { audit: () => 0, charterHarnessDefaults: {} },
    });
    const out = await ex.run(
      req({
        role_prompt: "你是资深前端",
        bin: FAKE,
        resume_session_id: "sess-R",
        config: { kind: "claude-cli", model: "fake-model-9" },
      }),
    );
    expect(out.ok, out.ok === false ? out.message : "").toBe(true);
    if (!out.ok) throw new Error("unreachable");
    // fake-claude 的 result 首行是固定话术（诚实摘要读的就是这一行）。
    expect(out.summary).toBe("这是员工的一轮汇报。");
    // 账单：0.042 美元 → 适配器 4 美分 → gateway 整数美分原样进回执（不回乘浮点）。
    expect(out.cost_cents).toBe(4);
    const hr = out.harness_result as Record<string, unknown>;
    const echo = echoOf(String(hr["output"]));
    expect(echo["model"]).toBe("fake-model-9");
    expect(echo["systemPrompt"]).toBe("你是资深前端");
    expect(echo["resumeFlag"]).toBe(true);
    expect(echo["resumed"]).toBe("sess-R");
    // 工作区真的到了子进程（读的是子进程自己的 cwd）。
    // 归一比较：WS 是 /tmp 写法，子进程报回的是 Windows 原生形（D:\tmp\…），
    // realpathSync 把两边落到同一个真路径上（gateway 也校验过它存在）。
    expect(String(echo["cwd"])).toBe(realpathSync(WS));
  }, 30_000);

  it("role_prompt 为空 ⇒ --append-system-prompt 值为空回显", async () => {
    const { q } = await newQ();
    const ex = new CliExecutor({
      writer: q,
      gateway: { audit: () => 0, charterHarnessDefaults: {} },
    });
    const out = await ex.run(req({ role_prompt: "", bin: FAKE }));
    expect(out.ok).toBe(true);
    // 判别联合收窄（与上一发同一形状）：不 throw 一把，下面读不到 harness_result。
    if (!out.ok) throw new Error("unreachable");
    const hr = out.harness_result as Record<string, unknown>;
    const echo = echoOf(String(hr["output"]));
    expect(echo["systemPrompt"]).toBe("");
  }, 30_000);
});
