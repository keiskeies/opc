/**
 * 执行器地基（types.ts）的直测（T6）。
 *
 * run.test.ts 从路由器侧间接经过 okRun/errRun/auditExecutorRun，registry.test.ts
 * 只吃 kind —— 这个文件把地基自身的判据收拢：
 *  · firstNonEmptyLine：全空必须落占位句而不是空串（编一句「完成了任务」是谎）；
 *  · executorRunPayload：ok/err 两支的格子集合逐字钉住（成功支不许出现 code，
 *    失败支的 retry 必须在 —— payload 是 events 单行自解释的全部材料）；
 *  · okRun/errRun：runContext 五格原样透传 + note 缺省空串 + 可选格「缺 = 不写键」
 *    （写 undefined 键过不了 strict schema 的 round-trip 预期）；
 *  · buildToolArgs / asExecutorFailureCode：收口判据的边界；
 *  · auditExecutorRun 落库列形状 + auditExecutorRunViaWriter 的「失败大声」语义
 *    （走真 WriteQueue + 真迁移，同 run.test.ts 的立场）。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  EXECUTOR_FAILURE_CODES,
  type ExecutorFailureCode,
  type ExecutorRunOutcome,
  type ExecutorRunRequest,
  executorRunDoneSchema,
  executorRunErrorSchema,
  executorRunRequestSchema,
} from "@opc/contracts";
import { afterAll, describe, expect, it, vi } from "vitest";
import { requireScopeDb } from "../../src/checkpoint/tx-scope.js";
import { migrate } from "../../src/db/migrate.js";
import type { Writer } from "../../src/db/write-queue.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import type { AuditRow } from "../../src/events/recorder.js";
import {
  asExecutorFailureCode,
  auditExecutorRun,
  auditExecutorRunViaWriter,
  buildToolArgs,
  EXECUTOR_RUN_PAYLOAD_KIND,
  errRun,
  executorRunPayload,
  firstNonEmptyLine,
  okRun,
} from "../../src/executors/types.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("executors-types", import.meta.url);
mkdirSync(TMP, { recursive: true });

const NOW = Date.UTC(2026, 10, 23);
const queues: WriteQueue[] = [];
let fileSeq = 0;

type AnyDb = {
  prepare: (sql: string) => {
    all: (...a: unknown[]) => Record<string, unknown>[];
    get: (...a: unknown[]) => Record<string, unknown> | undefined;
    run: (...a: unknown[]) => unknown;
  };
  exec: (sql: string) => void;
};

/** 真库：迁移 + 一条 task（events.task_id 有 FK，审计必须挂真 task）。 */
async function newQ(): Promise<{ q: WriteQueue; db: AnyDb }> {
  const path = join(TMP, "ty-" + process.pid + "-" + ++fileSeq + ".db");
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
  rmSync(TMP, { recursive: true, force: true });
});

/** 过 schema 的请求夹具（parse 兜底：夹具本身不合法就直接炸，不带病进断言）。 */
function req(over: Record<string, unknown> = {}): ExecutorRunRequest {
  return executorRunRequestSchema.parse({
    execution_id: "e1",
    task_id: "t1",
    member_id: "m1",
    role_id: "dev",
    seq: 1,
    kind: "claude-cli",
    config: { kind: "claude-cli" },
    model_tier: "execution",
    instruction: "把按钮文案改掉",
    workspace: "D:/work/repo",
    ...over,
  });
}

describe("firstNonEmptyLine", () => {
  it("取第一段非空行并 trim 首尾空白", () => {
    expect(firstNonEmptyLine("  第一行  \n第二行")).toBe("第一行");
    // 前导空行跳过（只读流式输出常见：首帧空 chunk）
    expect(firstNonEmptyLine("\n\n真实内容在第三行\n尾巴")).toBe(
      "真实内容在第三行",
    );
  });

  it("行内空格保留、行尾空白去掉：原样是立场，修剪到词是越权", () => {
    expect(firstNonEmptyLine("a b   c  ")).toBe("a b   c");
  });

  it("CRLF 残留 \\r 属空白被 trim 吃掉（Windows 子进程输出直灌场景）", () => {
    expect(firstNonEmptyLine("行一\r\n行二")).toBe("行一");
  });

  it("全空 → 占位句：空串会让 summary 撞契约 min(1)，编一句人话是谎", () => {
    expect(firstNonEmptyLine("")).toBe("（无输出摘要）");
    expect(firstNonEmptyLine("\n \t 　 \n")).toBe("（无输出摘要）");
    expect(firstNonEmptyLine("   ")).toBe("（无输出摘要）");
  });

  it("返回值过 summary min(1)：占位句存在的意义就是让 ok 支永远拼得出合法回执", () => {
    const parsed = executorRunDoneSchema.parse({
      ...runContext("claude-cli"),
      ok: true,
      text: "",
      summary: firstNonEmptyLine(""),
    });
    expect(parsed.summary.length).toBeGreaterThan(0);
  });
});

/** 判别联合两支共用的五格上下文（与请求夹具同值，round-trip 断言用）。 */
function runContext(kind: ExecutorRunRequest["kind"]) {
  return {
    execution_id: "e1",
    task_id: "t1",
    member_id: "m1",
    seq: 1,
    kind,
  };
}

describe("executorRunPayload", () => {
  it("ok 支：格子集合恰好 = 认领键 + 五格上下文 + ok/summary（+给了才有的可选格）", () => {
    const out = okRun(req(), {
      text: "正文不进 payload",
      summary: "改了按钮文案",
      cost_cents: 7,
      session_id: "sess-9",
    });
    const p = executorRunPayload(out);
    expect(p).toEqual({
      kind: EXECUTOR_RUN_PAYLOAD_KIND,
      execution_id: "e1",
      task_id: "t1",
      member_id: "m1",
      seq: 1,
      kind_of_executor: "claude-cli",
      ok: true,
      summary: "改了按钮文案",
      cost_cents: 7,
      session_id: "sess-9",
    });
    // 成功支不许出现失败格：「缺格」与「码为 null」在回放里必须同形（见 types.ts 注释）
    expect("code" in p).toBe(false);
    expect("message" in p).toBe(false);
    expect("retry_next_executor" in p).toBe(false);
    // text 是执行产物，审计单行不背正文
    expect("text" in p).toBe(false);
  });

  it("err 支：code/message/retry 三格必在；card_id 不进 err 支（结构上就没有）", () => {
    const out = errRun(req(), {
      code: "cli_spawn_failed",
      message: "CLI 没装",
      retry_next_executor: true,
      spawn_errno: "ENOENT",
    });
    const p = executorRunPayload(out);
    expect(p).toEqual({
      kind: EXECUTOR_RUN_PAYLOAD_KIND,
      execution_id: "e1",
      task_id: "t1",
      member_id: "m1",
      seq: 1,
      kind_of_executor: "claude-cli",
      ok: false,
      code: "cli_spawn_failed",
      message: "CLI 没装",
      retry_next_executor: true,
      spawn_errno: "ENOENT",
    });
    expect("card_id" in p).toBe(false);
    expect("summary" in p).toBe(false);
  });

  it("可选格「没给 = 键不存在」：JSON 序列化后两分支的读侧判据不被 undefined 污染", () => {
    const okP = executorRunPayload(okRun(req(), { text: "x", summary: "s" }));
    const errP = executorRunPayload(
      errRun(req(), {
        code: "decision_missing",
        message: "没出决策块",
        retry_next_executor: false,
      }),
    );
    for (const p of [okP, errP]) {
      const round = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
      expect(round).toEqual(p);
    }
    expect("cost_cents" in okP).toBe(false);
    expect("session_id" in okP).toBe(false);
    expect("cost_cents" in errP).toBe(false);
    expect("spawn_errno" in errP).toBe(false);
  });
});

describe("okRun / errRun 构造器", () => {
  it("okRun：runContext 五格原样透传 + note 缺省空串 + 过 strict round-trip", () => {
    const out = okRun(req({ seq: 3 }), { text: "正文", summary: "干完" });
    expect(out.execution_id).toBe("e1");
    expect(out.task_id).toBe("t1");
    expect(out.member_id).toBe("m1");
    expect(out.seq).toBe(3);
    expect(out.kind).toBe("claude-cli");
    expect(out.note).toBe("");
    expect(executorRunDoneSchema.parse(out)).toEqual(out);
  });

  it("okRun：card_id / harness_result 给了才带（human 卡与 CLI 原始回执两个出口）", () => {
    const out = okRun(req(), {
      text: "x",
      summary: "s",
      card_id: "c-1",
      harness_result: { exit_code: 0 },
    });
    expect(out.card_id).toBe("c-1");
    expect(out.harness_result).toEqual({ exit_code: 0 });
    expect(executorRunDoneSchema.parse(out)).toEqual(out);
  });

  it("errRun：retry 由调用点显式给 + spawn_errno 给了才带 + 过 strict round-trip", () => {
    const out = errRun(req({ seq: 2 }), {
      code: "cli_spawn_failed",
      message: "没起来",
      retry_next_executor: false,
      spawn_errno: "EPERM",
      cost_cents: 0,
    });
    expect(out.ok).toBe(false);
    expect(out.seq).toBe(2);
    expect(out.retry_next_executor).toBe(false);
    expect(out.spawn_errno).toBe("EPERM");
    // cost_cents=0 是合法读数（跑了没花钱），不能被当「没给」抹掉
    expect(out.cost_cents).toBe(0);
    expect(executorRunErrorSchema.parse(out)).toEqual(out);
    const bare = errRun(req(), {
      code: "executor_error",
      message: "炸了",
      retry_next_executor: true,
    });
    expect("spawn_errno" in bare).toBe(false);
    expect("cost_cents" in bare).toBe(false);
  });
});

describe("buildToolArgs", () => {
  it("role_prompt 空串 → 不带键；非空才带 —— 其余内部字段一律不进 args", () => {
    const bare = buildToolArgs(req()); // role_prompt 缺省 parse 成 ""
    expect(bare).toEqual({ instruction: "把按钮文案改掉" });
    const withRole = buildToolArgs(req({ role_prompt: "你是开发工程师" }));
    expect(withRole).toEqual({
      instruction: "把按钮文案改掉",
      role_prompt: "你是开发工程师",
    });
    // 成员档案/预算/路由信息不进外部工具的视野（归因边界）
    expect("member_id" in withRole).toBe(false);
    expect("max_budget_usd" in withRole).toBe(false);
    expect("workspace" in withRole).toBe(false);
  });
});

describe("asExecutorFailureCode", () => {
  it("枚举 16 格逐字透传（词表来自契约，这里不重抄名单）", () => {
    for (const code of EXECUTOR_FAILURE_CODES) {
      expect(asExecutorFailureCode(code)).toBe(code);
    }
  });

  it("判不过一律退 executor_error：大小写、前后空格、空串都算判不过", () => {
    expect(asExecutorFailureCode("cli_timeout")).toBe("executor_error");
    expect(asExecutorFailureCode("")).toBe("executor_error");
    expect(asExecutorFailureCode("CLI_FAILED")).toBe("executor_error");
    expect(asExecutorFailureCode(" executor_error")).toBe("executor_error");
  });

  it("退化值本身在枚举里（透传判据自反，兜底值不会兜出一个非法码）", () => {
    expect(asExecutorFailureCode("executor_error")).toBe("executor_error");
    const check: ExecutorFailureCode = asExecutorFailureCode("x");
    expect(check).toBe("executor_error");
  });
});

describe("auditExecutorRun（真库落行）", () => {
  it("列形状：tool_call/system/executors + target 含 execution 与 seq + payload 自解释", async () => {
    const { q, db } = await newQ();
    const outcome: ExecutorRunOutcome = errRun(req(), {
      code: "cli_failed",
      message: "非零退出",
      retry_next_executor: true,
    });
    const seq = await q.node(() =>
      auditExecutorRun(requireScopeDb("types.test"), outcome, NOW),
    );
    const rows = db
      .prepare(
        "SELECT id, task_id, actor_type, actor_id, action, target, payload, created_at" +
          " FROM events ORDER BY id",
      )
      .all();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error("events 应有恰好一行");
    expect(seq).toBe(row.id);
    expect(row.task_id).toBe("t1");
    expect(row.actor_type).toBe("system");
    expect(row.actor_id).toBe("executors");
    expect(row.action).toBe("tool_call");
    expect(row.target).toBe("executor:e1:1");
    expect(row.created_at).toBe(NOW);
    expect(JSON.parse(String(row.payload))).toEqual({
      kind: EXECUTOR_RUN_PAYLOAD_KIND,
      execution_id: "e1",
      task_id: "t1",
      member_id: "m1",
      seq: 1,
      kind_of_executor: "claude-cli",
      ok: false,
      code: "cli_failed",
      message: "非零退出",
      retry_next_executor: true,
    });
  });
});

describe("auditExecutorRunViaWriter（装配侧收口）", () => {
  it("成功腿：extraRows 与 executor_run 同一队列落库，顺序 = 缓冲行在前", async () => {
    const { q, db } = await newQ();
    const extra: AuditRow = {
      taskId: "t1",
      actorType: "system",
      actorId: "gateway",
      action: "tool_call",
      target: "gateway:probe",
      payload: { kind: "harness_call" },
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await auditExecutorRunViaWriter(
      q,
      okRun(req(), { text: "x", summary: "干完" }),
      "claude-cli",
      [extra],
    );
    const actors = db
      .prepare("SELECT actor_id FROM events ORDER BY id")
      .all()
      .map((r) => String(r.actor_id));
    expect(actors).toEqual(["gateway", "executors"]);
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("失败腿：重抛被吞、console.error 恰好一发且点名 caller/execution/seq/原因", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = {
      node: async () => {
        throw new Error("队列已关闭");
      },
    } as unknown as Writer;
    // 不 catch 直接 await：auditExecutorRunViaWriter 若重抛，这发用例当场红
    await auditExecutorRunViaWriter(
      boom,
      okRun(req({ execution_id: "e9", seq: 2 }), { text: "x", summary: "s" }),
      "qoder-cli",
    );
    expect(errSpy).toHaveBeenCalledTimes(1);
    const msg = String(errSpy.mock.calls[0]?.[0]);
    expect(msg).toContain("审计落盘失败");
    expect(msg).toContain("qoder-cli");
    expect(msg).toContain("e9");
    expect(msg).toContain("seq=2");
    expect(msg).toContain("队列已关闭");
    errSpy.mockRestore();
  });

  it("失败腿：抛非 Error 时原样 String() 进日志，不吞成 undefined", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const weird = {
      node: async () => {
        throw "字符串故障";
      },
    } as unknown as Writer;
    await auditExecutorRunViaWriter(
      weird,
      errRun(req(), {
        code: "executor_error",
        message: "m",
        retry_next_executor: false,
      }),
      "human",
    );
    expect(String(errSpy.mock.calls[0]?.[0])).toContain("字符串故障");
    errSpy.mockRestore();
  });
});
