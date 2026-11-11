/**
 * 引擎路线的命令行入口（engine/work.ts + engine/hub-work.ts）。
 *
 * ── 这一发测的是【能不能真的用起来】，不是那三个模块的内部判定 ────────
 * dispatch / charter / approve 各自有自己的测试文件，那些测的是判定逻辑。
 * 本文件测的是把它们接起来之后那条【人走的路径】：一条命令推进、一条命令批准，
 * 中间那个「下发想法 → 读到提案 → 签下去 → 任务动起来」的链条真的通。
 * 之所以要有这一发：本仓抓了二十几篇的都是「模块写完、测试全绿、没有任何运行时
 * 路径走到它」（0013/0014/0020/0031/0032/0033/0040）。三个模块单测各自绿，
 * 【接起来能用】不是同一件事 —— 那一格今天由本文件补。
 *
 * ── 为什么走 runEngineCli 而不是直接调 cmdWork ───────────────────────
 * 直接调函数会跳过参数解析、未知子命令、退出码、以及【入口块不在测试里跑副作用】
 * 这四样，而那四样正是 CLI 的全部失效面（V13 的验收对象就是「命令行退出码」）。
 * 起真子进程那一头用现成夹具（fixtures/fake-claude.mjs，真的可执行文件、
 * 真的 spawn），所以这一发连「CLI 找不找得到」也是真的。
 *
 * 跑法（离线、node v24.14.0）：
 *   PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH \
 *     node --experimental-transform-types --import /tmp/opc-harness/register.mjs \
 *     --test packages/hub/test/engine/work.test.ts
 */
import { mkdirSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fixtureTmp } from "../fixtures/fixture-dir.js";
import { migrate } from "../../src/db/migrate.js";
import { INSERT_DELEGATION_GRAPH_SQL } from "../../src/org/commit.js";
import { KIND_TO_ACTION } from "../../src/events/recorder.js";
import { runEngineCli } from "../../src/engine/hub-work.js";
import { DECIDE_USAGE, WORK_USAGE, parseDecideArgs, parseWorkArgs } from "../../src/engine/work.js";

const TMP = fixtureTmp("engine-work", import.meta.url);
const FAKE_CLI = new URL("./fixtures/fake-claude.mjs", import.meta.url).pathname;
const NOW = 1_700_000_000_000;

type Row = Record<string, unknown>;
type Db = {
  prepare: (sql: string) => {
    all: (...a: unknown[]) => Row[];
    get: (...a: unknown[]) => Row | undefined;
    run: (...a: unknown[]) => unknown;
  };
  exec: (sql: string) => void;
};
type Queue = {
  node: <T>(fn: () => Promise<T> | T) => Promise<T>;
  readConnection: () => Db;
  writeConnection: () => Db;
  close: () => Promise<void>;
};

const queues: Queue[] = [];
let fileSeq = 0;

beforeAll(() => mkdirSync(TMP, { recursive: true }));
afterAll(async () => {
  for (const q of queues) {
    try {
      await q.close();
    } catch {
      /* 已关 */
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});

interface World {
  /** 库文件路径（CLI 参数要用它，所以这一发从一开始就把【真库文件】当坐标）。 */
  dbPath: string;
  db: Db;
  q: Queue;
  out: string;
  err: string;
}

/**
 * 一条停在 CHARTER_PENDING 的任务 + 组织图 v1（intake + ceo）。
 *
 * 任务【直接 INSERT】而不是走命令建：hub work 刻意不建任务（建任务那条路要把
 * graph_version 与 INSERT 放在同一事务里取，§18.4），而本文件要测的是
 * work/decide 那两发，不该顺手把「不建任务」这条边界演成「其实能建」。
 */
async function world(o: { readonly status?: string; readonly withCard?: boolean } = {}): Promise<World> {
  const { WriteQueue } = await import("../../src/db/write-queue.js");
  const dbPath = TMP + "/w-" + process.pid + "-" + ++fileSeq + ".db";
  const q = new WriteQueue(dbPath) as unknown as Queue;
  queues.push(q);
  const db = q.writeConnection();
  migrate(db as unknown as Parameters<typeof migrate>[0]);
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at, graph_version) " +
      "VALUES ('t1','做个 AI 笔记应用', ?, 'intake', 'intake', ?, ?, 1)",
  ).run(o.status ?? "CHARTER_PENDING", NOW, NOW);
  db.prepare(INSERT_DELEGATION_GRAPH_SQL).run(
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
  if (o.withCard === true) {
    const { createCard } = await import("../../src/approvals/cards.js");
    await createCard(
      q as never,
      {
        taskId: "t1",
        approvalType: "escalation",
        cardKey: "extra:card",
        summary: "另一件等你批的事",
        parameters: {
          impact_scope: "x",
          irreversible: false,
          recommendation: "y",
          recommendation_is_not_decision: true,
          timeout_behavior: "escalate",
        },
        evidence_refs: ["task:t1/evidence"],
        buttons: ["approve", "reject_with_comment", "defer_deep_review"],
      },
      { nowMs: NOW },
    );
  }
  const w: World = { dbPath, db, q, out: "", err: "" };
  return w;
}

/** 走真入口跑一发（io 收成字符串，好断言【人看见的那一行】）。 */
async function cli(w: World, argv: readonly string[]): Promise<number> {
  const r = await runEngineCli(argv, {
    write: (t) => {
      w.out += t;
    },
    error: (t) => {
      w.err += t;
    },
  });
  return r.code;
}

/** work 那一发的固定参数（两个上限【必填】，所以每次都得带 —— 少一个就是另一发用例）。 */
function workArgv(w: World, extra: readonly string[] = []): string[] {
  return ["work", "--db", w.dbPath, "--task", "t1", "--max-budget-usd", "0.5", "--task-limit-cents", "1000", "--bin", FAKE_CLI, ...extra];
}
function decideArgv(w: World, extra: readonly string[] = []): string[] {
  return ["decide", "--db", w.dbPath, "--task", "t1", ...extra];
}

function task(w: World): Row {
  const r = w.db.prepare("SELECT * FROM tasks WHERE id='t1'").get();
  if (r === undefined) throw new Error("任务不在了");
  return r;
}

describe("parseWorkArgs：两个上限不给默认值", () => {
  const base = ["--db", "d.db", "--task", "t1", "--max-budget-usd", "0.5", "--task-limit-cents", "500"];
  it("齐了 ⇒ ok，--max-turns 缺省 12", () => {
    const p = parseWorkArgs(base);
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.args.maxTurns).toBe(12);
  });
  it("少一个上限 ⇒ 那条错误点名【缺的是哪一个】，而不是泛泛一句缺参数", () => {
    const p = parseWorkArgs(base.filter((x) => x !== "--task-limit-cents" && x !== "500"));
    expect(!p.ok && p.error).toContain("--task-limit-cents");
  });
  it("--max-turns 0 红（正整数），而不是静默变成「跑 0 轮」", () => {
    const p = parseWorkArgs([...base, "--max-turns", "0"]);
    expect(!p.ok && p.error).toContain("--max-turns");
  });
  it("--task-limit-cents 12.5 红（§6.1 禁浮点金额）", () => {
    const p = parseWorkArgs([...base.slice(0, 6), "--task-limit-cents", "12.5"]);
    expect(p.ok).toBe(false);
  });
  it("写了 --max-budget-usd 但【忘填值】时报的是缺参数，不是「必须是正数，实到 0」", () => {
    // Number("") === 0：那一发会把人指到自己【没写错】的那个数字上去。
    const p = parseWorkArgs(["--db", "d.db", "--task", "t1", "--max-budget-usd", "--task-limit-cents", "500"]);
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.error).toContain("--max-budget-usd");
      expect(p.error).not.toContain("实到 0");
    }
  });
  it("不认识的参数红，而不是被忽略", () => {
    const p = parseWorkArgs([...base, "--max-turn", "3"]);
    // 少打一个 s 的那种拼错：如果当成未知参数放行，她的 --max-turns 3 等于没写，
    // 默认 12 轮照跑，而她会以为上限是 3。
    expect(p.ok).toBe(false);
  });
});

describe("parseDecideArgs：三颗按钮的取值与那句必填的理由", () => {
  const base = ["--db", "d.db", "--task", "t1"];
  it("--button 拼错一个字母红，而不是把「undefined」写进卡片状态列", () => {
    const p = parseDecideArgs([...base, "--button", "aproved"]);
    expect(!p.ok && p.error).toContain("approve");
  });
  it("reject_with_comment 不带 --note 红，而且退出码那一支是【参数错】", () => {
    const p = parseDecideArgs([...base, "--button", "reject_with_comment"]);
    expect(!p.ok && p.error).toContain("--note");
  });
  it("approve 不需要 --note", () => {
    expect(parseDecideArgs([...base, "--button", "approve"]).ok).toBe(true);
  });
  it("--note 空串 ≠ 有理由（Number('')===0 那一族的另一面）", () => {
    const p = parseDecideArgs([...base, "--button", "reject_with_comment", "--note", ""]);
    expect(p.ok).toBe(false);
  });
});

describe("入口的分发与退出码", () => {
  it("--help 走 stdout 而退出 0（脚本里 `hub work --help` 不该被判成失败）", async () => {
    const w = await world({});
    const code = await cli(w, ["--help"]);
    expect(code).toBe(0);
    expect(w.out).toContain("hub work");
    expect(w.out).toContain("hub decide");
    expect(w.err).toBe("");
  });
  it("什么都没敲 ⇒ 用法在 stderr 且退出 2（打错了，不是在问）", async () => {
    const w = await world({});
    expect(await cli(w, [])).toBe(2);
    expect(w.err).toContain("hub work");
    expect(w.out).toBe("");
  });
  it("未知子命令退出 2，并把【有哪两条】打出来", async () => {
    const w = await world({});
    expect(await cli(w, ["run", "--db", "x"])).toBe(2);
    expect(w.err).toContain("没有 [run]");
  });
  it("库文件不存在 ⇒ 2 且说的是【这个文件不存在】，不是 SQLite 那句原话", async () => {
    const w = await world({});
    const code = await cli(w, [
      "work",
      "--db",
      TMP + "/nope-" + process.pid + ".db",
      "--task",
      "t1",
      "--max-budget-usd",
      "1",
      "--task-limit-cents",
      "100",
    ]);
    expect(code).toBe(2);
    expect(w.err).toContain("数据库文件不存在");
  });
  it("守卫抛出来的那句话进 stderr 而【不是一段 stack】，码 1", async () => {
    // 造一次真抛：库里把 tasks 表改名，dispatch 的 loadTask 会撞 SQL 错。
    const w = await world({ status: "IN_PROGRESS" });
    w.db.exec("ALTER TABLE tasks RENAME TO tasks_gone");
    const code = await cli(w, workArgv(w));
    expect(code).toBe(1);
    expect(w.err).toContain("执行失败：");
    expect(w.err).not.toContain("    at ");
  });
});

describe("hub work 停在章程那一格：起草 + 建卡 + 把下一步打成一条能照抄的命令", () => {
  it("CHARTER_PENDING ⇒ 起一轮起草、建出一张 charter 卡、任务【原地不动】、退出 0", async () => {
    const w = await world({});
    const code = await cli(w, workArgv(w));
    expect(code).toBe(0);
    expect(String(task(w)["status"])).toBe("CHARTER_PENDING");
    const cards = w.db.prepare("SELECT * FROM approvals").all();
    expect(cards.length).toBe(1);
    expect(cards[0]?.["approval_type"]).toBe("charter");
    // 真的花了钱（假 CLI 报 0.042 美元 = 4 美分），而且落在了 tasks.consumed_cents 上
    expect(Number(task(w)["consumed_cents"])).toBe(4);
    expect(w.out).toContain("hub decide");
  });

  it("提示句里那条命令【照抄就能跑】：库路径、任务、卡片 id、按钮四样都在", async () => {
    const w = await world({});
    await cli(w, workArgv(w));
    const id = String(w.db.prepare("SELECT id FROM approvals").get()?.["id"] ?? "");
    expect(id.length).toBeGreaterThan(10);
    // 这不只是「文案里有个 id」：下面真的拿这一行去跑 decide。
    const line = w.out.split("\n").find((l) => l.includes("hub decide")) ?? "";
    expect(line).toContain(w.dbPath);
    expect(line).toContain(id);
    expect(line).toContain("--button approve");
  });

  it("再敲一次 hub work【不重烧一次起草】，而且仍然退出 0", async () => {
    const w = await world({});
    await cli(w, workArgv(w));
    const calls = Number(w.db.prepare("SELECT count(*) AS c FROM harness_calls").get()?.["c"]);
    w.out = "";
    const code = await cli(w, workArgv(w));
    expect(code).toBe(0);
    expect(Number(w.db.prepare("SELECT count(*) AS c FROM approvals").get()?.["c"])).toBe(1);
    // 执行日志没有第二条：唯一索引挡得住第二张卡，挡不住第二次烧钱，这一条钉的是后者
    expect(Number(w.db.prepare("SELECT count(*) AS c FROM harness_calls").get()?.["c"])).toBe(calls);
    expect(w.out).toContain("已经有一张待批的章程卡");
  });

  it("任务不存在 ⇒ 2，并且【不建库不建任务】", async () => {
    const w = await world({});
    const code = await cli(w, workArgv(w, ["--task", "ghost"]));
    expect(code).toBe(2);
    expect(w.err).toContain("任务不存在");
    expect(w.db.prepare("SELECT count(*) AS c FROM tasks").get()?.["c"]).toBe(1);
  });
});

describe("hub decide：收件箱里那一次点击真的把任务推走", () => {
  it("单张待批卡 ⇒ 不填 --card 也办得对，任务 CHARTER_PENDING → CHARTER_APPROVED", async () => {
    const w = await world({});
    await cli(w, workArgv(w));
    w.out = "";
    const code = await cli(w, decideArgv(w, ["--button", "approve"]));
    expect(code).toBe(0);
    expect(String(task(w)["status"])).toBe("CHARTER_APPROVED");
    expect(w.db.prepare("SELECT status FROM approvals").get()?.["status"]).toBe("approved");
    expect(w.out).toContain("CHARTER_PENDING → CHARTER_APPROVED");
  });

  it("负责角色【不被那颗按钮顺手改掉】（current_node 与 assigned_role 原值回填）", async () => {
    const w = await world({});
    await cli(w, workArgv(w));
    await cli(w, decideArgv(w, ["--button", "approve"]));
    expect(String(task(w)["assigned_role"])).toBe("intake");
    expect(String(task(w)["current_node"])).toBe("intake");
    // 人的一格不烧 token：钱是起草那一轮的花费，批准不叠加
    expect(Number(task(w)["consumed_cents"])).toBe(4);
  });

  it("决策与状态边【同一事务】：审计里两条都在，都是 human/ceo", async () => {
    const w = await world({});
    await cli(w, workArgv(w));
    await cli(w, decideArgv(w, ["--button", "approve"]));
    const rows = w.db
      .prepare("SELECT action, actor_type, actor_id, target, payload FROM events ORDER BY id")
      .all();
    /**
     * 按【署名 + target】筛，【不是】按 payload.kind —— 而我一开始写的是后者，
     * 于是这一发数出「0 条决策审计」而其实库里有一条好好的决策。原因值得记下来：
     * 「建了一张卡」与「点了这张卡」在库里【共用 action='approval'】（§22.1 那个枚举
     * 不开第 11 个值），而决策那条的 payload 是 {approvalId, resume} —— 【没有 kind】。
     * bus.ts 注释里那句「它在库里的身份靠 payload.kind」说的只是 ApprovalTokenRedeemed
     * 那一条【写进事件形状里】的 kind，不是所有共用 'approval' 的行都带 kind。
     * applyDecision（http 那条路）落的 payload 同样不带 kind，所以这不是引擎路线
     * 少写了一格：是【库里今天没有「这条 approval 是请求还是决策」这个事实的机器可读列】。
     * 能区分两者的只有 actor（system/hub vs human/ceo）与 target。这一发因此断这两样，
     * 而那个缺失本身登记在 0041（读侧「按 payload.kind 分辨」的写法会静默数到 0）。
     */
    const decided = rows.filter(
      (r) => String(r["action"]) === "approval" && String(r["actor_type"]) === "human",
    );
    expect(decided.length).toBe(1);
    expect(String(decided[0]?.["actor_id"])).toBe("ceo");
    // 卡片那条【还在】，而且 target 指向同一张卡：一次点击挂在正确的卡片上
    const asked = rows.filter(
      (r) => String(r["action"]) === "approval" && String(r["actor_type"]) === "system",
    );
    expect(asked.length).toBe(1);
    expect(String(asked[0]?.["target"])).toBe(String(w.db.prepare("SELECT id FROM approvals").get()?.["id"]));
    expect(String(decided[0]?.["target"])).toBe(String(asked[0]?.["target"]));
    // 决策那句理由落在 state_snapshot 而不是 payload（applyDecision 同一条边界）
    const snap = JSON.parse(String(decided[0]?.["payload"])) as Record<string, unknown>;
    expect(snap["resume"]).toBe("approve");

    const moved = rows.filter((r) => String(r["action"]) === "state_change");
    expect(moved.length).toBe(1);
    expect(String(moved[0]?.["actor_type"])).toBe("human");
    // 人推的那一步署人名而不是 agent：§12.7 第 2 层问的就是「这一步是谁推的」
    expect(String(moved[0]?.["actor_id"])).toBe("ceo");
  });

  it("【没有待批卡片】时红在 2，并说清下一步该干嘛（不是让人去排查这个进程）", async () => {
    const w = await world({ status: "CHARTER_PENDING" });
    const code = await cli(w, decideArgv(w, ["--button", "approve"]));
    expect(code).toBe(2);
    expect(w.err).toContain("没有待批的卡片");
    expect(w.err).toContain("hub work");
  });

  it("两张待批卡 ⇒ 【不替 CEO 猜】办哪一张，把 id 列出来让她指", async () => {
    const w = await world({ withCard: true });
    await cli(w, workArgv(w));
    expect(w.db.prepare("SELECT count(*) AS c FROM approvals WHERE status = 'pending'").get()?.["c"]).toBe(2);
    w.err = "";
    const code = await cli(w, decideArgv(w, ["--button", "approve"]));
    expect(code).toBe(2);
    expect(w.err).toContain("不能替你猜");
    // 一张都没被办掉：猜错的代价是一次【不可逆的】批准
    expect(w.db.prepare("SELECT count(*) AS c FROM approvals WHERE status = 'pending'").get()?.["c"]).toBe(2);
  });

  it("--card 指着一条不相干的 id ⇒ 红，并把【此刻该打的那几个 id】打出来", async () => {
    const w = await world({});
    await cli(w, workArgv(w));
    w.err = "";
    const code = await cli(w, decideArgv(w, ["--card", "not-a-card", "--button", "approve"]));
    expect(code).toBe(2);
    expect(w.err).toContain("not-a-card");
    const real = String(w.db.prepare("SELECT id FROM approvals").get()?.["id"]);
    expect(w.err).toContain(real);
    expect(String(task(w)["status"])).toBe("CHARTER_PENDING");
  });

  it("批过之后再批一次 ⇒ already_decided，【零新审计】（append-only 里不能说「又决定了一次」）", async () => {
    const w = await world({});
    await cli(w, workArgv(w));
    await cli(w, decideArgv(w, ["--button", "approve"]));
    const before = Number(w.db.prepare("SELECT count(*) AS c FROM events").get()?.["c"]);
    w.out = "";
    const code = await cli(w, decideArgv(w, ["--button", "approve"]));
    expect(code).toBe(2);
    // 卡片此刻已经不是 pending，所以红在 CLI 那一层（列不出待批卡），
    // 而不是进到 approveCard 里去撞 already_decided —— 两支都不写，这一条断的是【不写】。
    expect(Number(w.db.prepare("SELECT count(*) AS c FROM events").get()?.["c"])).toBe(before);
    expect(String(task(w)["status"])).toBe("CHARTER_APPROVED");
  });

  it("defer_deep_review ⇒ 卡片 deferred 而【任务原地】，输出里明说没有出边", async () => {
    const w = await world({});
    await cli(w, workArgv(w));
    w.out = "";
    const code = await cli(w, decideArgv(w, ["--button", "defer_deep_review"]));
    expect(code).toBe(0);
    expect(w.db.prepare("SELECT status FROM approvals").get()?.["status"]).toBe("deferred");
    expect(String(task(w)["status"])).toBe("CHARTER_PENDING");
    expect(w.out).toContain("没有");
    // 「卡片记掉了而任务没动」是一次【成立】的点击，不是失败：重跑只会撞已决策
    expect(w.out).not.toContain("CHARTER_PENDING → ");
  });
});

describe("整条链：下发想法 → 起草 → 签署 → 任务动起来", () => {
  /**
   * 这一发是本文件存在的理由。
   *
   * 三个模块各自的测试全绿时，这条链【依然是断的】：dispatch 停在人席、
   * charter 建卡、approve 推状态，三处判定都对，而没有任何运行时路径把三者接起来
   * （HUMAN_EDGES 写完至今零生产调用方就是这一族的实证）。所以这里断的是
   * 【两次命令之后的库状态】，不猜中间任何一步。
   */
  it("两次 CLI 调用之后：任务在 CHARTER_APPROVED、卡片 approved、审计链完整", async () => {
    const w = await world({});
    expect(await cli(w, workArgv(w))).toBe(0);
    expect(String(task(w)["status"])).toBe("CHARTER_PENDING"); // 起草不推进状态
    expect(await cli(w, decideArgv(w, ["--button", "approve"]))).toBe(0);

    expect(String(task(w)["status"])).toBe("CHARTER_APPROVED");
    const cards = w.db.prepare("SELECT * FROM approvals").all();
    expect(cards.length).toBe(1);
    expect(cards[0]?.["status"]).toBe("approved");
    expect(cards[0]?.["approval_type"]).toBe("charter");

    const actions = w.db.prepare("SELECT action FROM events ORDER BY id").all().map((x) => String(x["action"]));
    // 数组里 'approval' 出现【两次】不是笔误：卡片那条（ApprovalRequired）与点击那条
    // （ApprovalDecided）共用同一个 action 值（§22.1 的枚举不开第 11 个值），
    // 所以这条断言能钉住的是【顺序 + 条数 + 没有多余的状态变化】，
    // 「哪条是请求、哪条是决策」由上面那发（按 actor / target 筛）钉。
    expect(actions).toEqual([
      KIND_TO_ACTION.RoleTurnReported, // 起草那一轮（钱与提案原文）
      KIND_TO_ACTION.ApprovalRequired, // 那张卡
      KIND_TO_ACTION.ApprovalDecided, // 那次点击
      "state_change", // CHARTER_PENDING → CHARTER_APPROVED
    ]);
    expect(actions.filter((x) => x === "approval").length).toBe(2);
    // 账：起草那一轮 4 美分，批准 0；budgets / budget_events / tasks 三处同一个数
    expect(Number(task(w)["consumed_cents"])).toBe(4);
    expect(Number(w.db.prepare("SELECT consumed_cents FROM budgets").get()?.["consumed_cents"])).toBe(4);
    expect(w.db.prepare("SELECT count(*) AS c FROM budget_events").get()?.["c"]).toBe(1);
  });
});

describe("用法文本本身（打错命令的人唯一会读的东西）", () => {
  it("WORK_USAGE 里嵌了 DECIDE_USAGE，两段都在", () => {
    expect(WORK_USAGE).toContain("hub work");
    expect(WORK_USAGE).toContain("hub decide");
    expect(DECIDE_USAGE).toContain("--button");
  });
  it("用法里明写着【本命令不建任务】这条边界，而不是只写在源码注释里", () => {
    expect(WORK_USAGE).toContain("不建任务");
  });
  it("DECIDE_USAGE 明说另两颗按钮推不动任务（不是让人点了才知道）", () => {
    expect(DECIDE_USAGE).toContain("只有 approve");
  });
});
