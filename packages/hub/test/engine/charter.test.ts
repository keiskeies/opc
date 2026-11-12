/**
 * 章程提案那一格（engine/charter.ts）—— §7.2 步骤 1「CEO 收件箱里的第一条」。
 *
 * ── 这一发存在的理由 ──────────────────────────────────────────────────
 * 任务一落地就在 CHARTER_PENDING，而那一格是人类席位：dispatch 连 token 都不烧，
 * 直接回「等人」。批准要有卡片，而【全仓没有任何代码建 charter 卡】。
 * 于是「下发一个想法」之后的真实表现是：收件箱一张卡都没有，永久停住。
 * 本文件测的是补上那一格之后【它有没有做多余的事】和【有没有少做事】。
 *
 * ── 两组断言各自对应一种不可接受 ────────────────────────────────────
 * A. 做多了：起草那一轮顺手推进了状态 —— 那等于 agent 自己批准了自己的章程，
 *    §8.2 第 4 条「不可绕过」当场失效。所以【每一发都断言 status 仍是 CHARTER_PENDING】。
 * B. 做少了：卡建了而钱没记 / 审计有批准请求而 events 没那一行 /
 *    写了 events 没广播（前端撞 seq 空洞）。
 *
 * ── 为什么 runTurn 是【注入的】而不是走真 runtime ────────────────────
 * 这一层要判的是「起草 → 建卡 → 记账 → 广播」这段装配，而不是「能不能起子进程」
 * （后者在 claude.test.ts 与 runtime.test.ts 里各自钉住了）。注入还换来一件
 * 注入式 mock 换不来的东西：能精确造出「跑了一轮但没交出提案」这种
 * 真模型十几次里才出现一次的输出形状，而那正是最需要不建卡的那一发。
 *
 * 跑法（离线、node v24.14.0）：
 *   PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH \
 *     node --experimental-transform-types --import /tmp/opc-harness/register.mjs \
 *     --test packages/hub/test/engine/charter.test.ts
 */
import { mkdirSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fixtureTmp } from "../fixtures/fixture-dir.js";
import { migrate } from "../../src/db/migrate.js";
import { INSERT_DELEGATION_GRAPH_SQL } from "../../src/org/commit.js";
import { InMemoryEventBus } from "../../src/events/bus.js";
import { KIND_TO_ACTION } from "../../src/events/recorder.js";
import { DECISION_MARK } from "../../src/engine/claude.js";
import {
  CHARTER_CARD_KEY,
  buildCharterDraftPrompt,
  ensureCharterCard,
  parseCharterDraft,
} from "../../src/engine/charter.js";

const TMP = fixtureTmp("engine-charter", import.meta.url);
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

/** 一段「模型正常交出提案」的输出。末尾那份结构化决策是 parseDecision 认的形状。 */
function draftText(body = "业务目标：做个 AI 笔记应用\n可量化验收标准：三条\n预算上限：200 美元"): string {
  return (
    body +
    "\n\n" +
    DECISION_MARK +
    "\n" +
    JSON.stringify({ action: "wait", summary: "章程提案已拟好，等 CEO 签署" })
  );
}

interface World {
  db: Db;
  q: Queue;
  bus: InMemoryEventBus;
  published: { kind: string; seq: number }[];
}

async function world(o: {
  readonly status?: string;
  readonly role?: string;
  /** 不写组织图 ⇒ 造「版本缺失」。 */
  readonly writeGraph?: boolean;
  readonly graphVersion?: number;
}): Promise<World> {
  const { WriteQueue } = await import("../../src/db/write-queue.js");
  const q = new WriteQueue(TMP + "/c-" + process.pid + "-" + ++fileSeq + ".db") as unknown as Queue;
  queues.push(q);
  const db = q.writeConnection();
  migrate(db as unknown as Parameters<typeof migrate>[0]);
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at, graph_version) " +
      "VALUES ('t1','做个 AI 笔记应用', ?, ?, 'intake', ?, ?, ?)",
  ).run(o.status ?? "CHARTER_PENDING", o.role ?? "intake", NOW, NOW, o.graphVersion ?? 1);
  if (o.writeGraph !== false) {
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
  }
  const bus = new InMemoryEventBus();
  return { db, q, bus, published: [] };
}

/**
 * 一次 ensureCharterCard。
 *
 * runTurn 是【注入的假执行】（理由见文件头），而 onCost 用的是【真 runtime 的记账钩子】
 * —— 这一发要测的是「建卡之外账落没落」，把钩子换成一个 push 就什么都测不到了。
 */
async function draft(
  w: World,
  o: { readonly text?: string; readonly ok?: boolean; readonly costCents?: number; readonly error?: string } = {},
): Promise<{
  outcome: string;
  note: string;
  costCents: number;
  calls: { n: number; prompt: string; rolePrompt: string; role: string };
}> {
  const calls = { n: 0, prompt: "", rolePrompt: "", role: "" };
  const { makeRuntime } = await import("../../src/engine/runtime.js");
  const rt = makeRuntime({
    writer: w.q as never,
    bus: w.bus as never,
    maxBudgetUsd: 0.5,
    taskLimitCents: 1000,
    cwd: TMP,
  });
  const onCost = rt.deps.onCost;
  const res = await ensureCharterCard(
    w.q,
    { taskId: "t1", nowMs: NOW + 1000, maxBudgetUsd: 0.5 },
    {
      runTurn: async (i) => {
        calls.n += 1;
        calls.prompt = i.prompt;
        calls.rolePrompt = i.rolePrompt;
        calls.role = i.role;
        return {
          ok: o.ok !== false,
          text: o.text ?? draftText(),
          costCents: o.costCents ?? 6,
          sessionId: "sess-draft",
          error: o.error ?? null,
        };
      },
      rolePrompt: (r) => "你是角色 " + r,
      ...(onCost === undefined ? {} : { onCost }),
      publish: (e, seq) => {
        w.published.push({ kind: e.kind, seq });
        w.bus.publishPersisted(e, seq);
      },
    },
  );
  return { outcome: res.outcome, note: res.note, costCents: res.costCents, calls };
}

function task(w: World): Row {
  const r = w.db.prepare("SELECT * FROM tasks WHERE id='t1'").get();
  if (r === undefined) throw new Error("任务不在了");
  return r;
}

describe("起草那一轮【不推进状态】：agent 只起草，CEO 才签", () => {
  it("建卡之后任务仍在 CHARTER_PENDING（这条断言在【每一条】用例上都要成立）", async () => {
    const w = await world({});
    const r = await draft(w);
    expect(r.outcome).toBe("drafted");
    expect(String(task(w)["status"])).toBe("CHARTER_PENDING");
    // 也没有多写一条状态变化审计：有的只是「跑了一轮」+「有件事要批」
    const actions = w.db.prepare("SELECT action FROM events ORDER BY id").all().map((x) => String(x["action"]));
    expect(actions).toEqual([KIND_TO_ACTION.RoleTurnReported, KIND_TO_ACTION.ApprovalRequired]);
    expect(actions).not.toContain("state_change");
  });

  it("卡片是 charter 类、带去重键、三个按钮、推荐标志位为 true", async () => {
    const w = await world({});
    await draft(w);
    const c = w.db.prepare("SELECT * FROM approvals").get();
    expect(c?.["approval_type"]).toBe("charter");
    expect(c?.["card_key"]).toBe(CHARTER_CARD_KEY);
    expect(c?.["status"]).toBe("pending");
    const p = JSON.parse(String(c?.["parameters"])) as Record<string, unknown>;
    expect(p["recommendation_is_not_decision"]).toBe(true);
    // 章程是授权本身 ⇒ 标不可逆，让收件箱把它排在「要真读一遍」那一档
    expect(p["irreversible"]).toBe(true);
    // 超时不能自动批准：被授权的那套系统不能自己批授权
    expect(p["timeout_behavior"]).toBe("escalate");
    // 提案原文进了卡片第一屏能看见的那一行（契约只收字符串，所以原文折在这里）
    expect(String(p["impact_scope"])).toContain("业务目标");
    // 【evidence_refs 不在 approvals 表上】—— 它没有列，落库的位置是那条
    // ApprovalRequired 审计的 payload（cards.ts 只把 summary/parameters 拆成列）。
    // 断在这里而不是去 approvals 找一个不存在的列：这一格读错地方，
    // 下一条用例（「指针解得开」）就无从谈起。
    const card = w.db
      .prepare("SELECT payload FROM events WHERE action = ? ORDER BY id DESC LIMIT 1")
      .get(KIND_TO_ACTION.ApprovalRequired) as Row | undefined;
    const cp = JSON.parse(String(card?.["payload"])) as Record<string, unknown>;
    const refs = cp["evidence_refs"] as string[];
    expect(Array.isArray(refs) ? refs.length : 0).toBe(1);
    expect(refs[0]).toMatch(/^events:\d+#state_snapshot\.draft$/u);
  });

  it("证据指针【解得开】：它指着的那条审计的 state_snapshot 里就是提案原文", async () => {
    const w = await world({});
    await draft(w);
    const card = w.db
      .prepare("SELECT payload FROM events WHERE action = ? ORDER BY id DESC LIMIT 1")
      .get(KIND_TO_ACTION.ApprovalRequired) as Row | undefined;
    const cp = JSON.parse(String(card?.["payload"])) as Record<string, unknown>;
    const ref = String((cp["evidence_refs"] as string[])[0] ?? "");
    const m = /^events:(\d+)#/u.exec(ref);
    expect(m).not.toBeNull();
    const row = w.db.prepare("SELECT state_snapshot FROM events WHERE id = ?").get(Number(m?.[1]));
    expect(row).toBeDefined();
    const snap = JSON.parse(String(row?.["state_snapshot"])) as Record<string, unknown>;
    expect(String(snap["draft"])).toContain("业务目标：做个 AI 笔记应用");
  });
});

describe("去重：不为一张已存在的卡再烧一次 token", () => {
  it("第二次调用 ⇒ already_pending 且【runTurn 一次都没被调】", async () => {
    const w = await world({});
    const a = await draft(w);
    expect(a.outcome).toBe("drafted");
    expect(a.calls.n).toBe(1);
    const b = await draft(w);
    expect(b.outcome).toBe("already_pending");
    // 这是这一发的核心断言：唯一索引只挡【第二张卡】，挡不住【第二次烧钱】。
    expect(b.calls.n).toBe(0);
    expect(w.db.prepare("SELECT count(*) AS c FROM approvals").get()?.["c"]).toBe(1);
    // 第二次连一条事件都没写 ⇒ 收件箱角标不会 +2
    expect(w.db.prepare("SELECT count(*) AS c FROM events").get()?.["c"]).toBe(2);
  });
});

describe("前置不满足时【一个 token 都不烧】", () => {
  it("任务不在 CHARTER_PENDING ⇒ 不起角色、不建卡", async () => {
    const w = await world({ status: "IN_PROGRESS" });
    const r = await draft(w);
    expect(r.outcome).toBe("not_charter_pending");
    expect(r.calls.n).toBe(0);
    expect(w.db.prepare("SELECT count(*) AS c FROM approvals").get()?.["c"]).toBe(0);
  });

  it("任务不存在 ⇒ task_missing，不起角色", async () => {
    const w = await world({});
    w.db.prepare("DELETE FROM tasks WHERE id='t1'").run();
    const r = await draft(w);
    expect(r.outcome).toBe("task_missing");
    expect(r.calls.n).toBe(0);
  });

  it("组织图版本缺失 ⇒ org_blocked，并且【不回退到最新图】（§18.4）", async () => {
    const w = await world({ graphVersion: 9, writeGraph: true });
    const r = await draft(w);
    expect(r.outcome).toBe("org_blocked");
    expect(r.note).toContain("版本 9");
    expect(r.calls.n).toBe(0);
  });

  it("起草角色不在组织图上 ⇒ org_blocked，解法写在话里（加角色，不是放行）", async () => {
    const w = await world({ role: "ghost" });
    const r = await draft(w);
    expect(r.outcome).toBe("org_blocked");
    expect(r.note).toContain("ghost");
    expect(r.note).toContain("组织图");
    expect(r.calls.n).toBe(0);
  });
});

describe("那一轮没交出提案：钱照记，【卡不建】", () => {
  it("输出里没有结构化决策 ⇒ no_draft、零卡片、6 美分照落账", async () => {
    const w = await world({});
    const r = await draft(w, { text: "我觉得这个想法挺好的，可以再聊聊。" });
    expect(r.outcome).toBe("no_draft");
    expect(w.db.prepare("SELECT count(*) AS c FROM approvals").get()?.["c"]).toBe(0);
    // 真花了钱 ⇒ 必须落账。「卡没建就当没发生」会让账面比实际乐观
    expect(r.costCents).toBe(6);
    expect(w.db.prepare("SELECT amount_cents FROM budget_events").get()?.["amount_cents"]).toBe(6);
    expect(Number(task(w)["consumed_cents"])).toBe(6);
    // 而且审计里有这一轮（回放要答得出「这段时间花了钱而任务没动」）
    expect(w.db.prepare("SELECT action FROM events").all().map((x) => String(x["action"]))).toEqual([
      KIND_TO_ACTION.RoleTurnReported,
    ]);
  });

  it("执行失败（ok:false）⇒ 同样 no_draft + 钱照记", async () => {
    const w = await world({});
    const r = await draft(w, { ok: false, text: "", error: "CLI 超时" });
    expect(r.outcome).toBe("no_draft");
    expect(r.note).toContain("CLI 超时");
    expect(w.db.prepare("SELECT consumed_cents FROM tasks").get()?.["consumed_cents"]).toBe(6);
  });

  /**
   * ⚠ 这一发【把上一版的断言掉个个儿】。上一版写的是
   * 「零成本的失败轮不写 events（不为一个空事实消费一个 seq）」，
   * 标题那句理由听起来是对的 —— 一条空事实凭什么占一个 seq。
   * 它错在把【留痕】和【结账】当成同一件事：外层那句 `if (cost > 0)`
   * 同时管着「该不该记账」（该，没花钱就什么都不该加）和
   * 「该不该留痕」（【不该跟着钱走】—— 这一轮发生过、失败了，与花没花钱无关）。
   *
   * 漏掉的正好是【零花费的失败】：claude CLI 起不来 / spawn ENOENT / 权限不对
   * 那些情况 costCents 恒为 0，实测（0043 §10）events 表【零行】。
   * 也就是「intake 试过了、失败了、什么都没留下」。
   *
   * 为什么现在要翻：常驻 Hub 要把「补一张章程卡」挂到心跳上，而重试必须有界；
   * 有界要能数「这是第几次」，而【没有痕迹就没有计数】⇒ 一个零花费的失败
   * （本机正是这一格：CLI 装不上）会让泵每个心跳重新起一次子进程，
   * 无限、静默、且事后看不出来。这一格不修，泵就不该上。
   *
   * 「不消费 seq」那句顾虑本身不成立：seq 不是稀缺资源，
   * 【发生过而没记】才是。而且这一行 action='tool_call'，
   * MEMORY_ROWS_SQL 只捞 ('approval','review_decision') ⇒
   * 它【不会】进任何角色的 few-shot（bus.ts 那段早就写明这是想要的）。
   */
  it("⭐ 零成本的失败轮【照样留痕】—— 重试要有界，就得先数得出", async () => {
    const w = await world({});
    const r = await draft(w, { ok: false, text: "", costCents: 0, error: "压根没起来" });
    expect(r.outcome).toBe("no_draft");
    const rows = w.db.prepare("SELECT action, payload FROM events").all();
    expect(rows.map((x) => String(x["action"]))).toEqual([KIND_TO_ACTION.RoleTurnReported]);
    // 留痕而【不记账】：两条判据各走各的，这一发同时断两面。
    expect(Number(task(w)["consumed_cents"])).toBe(0);
    expect(w.db.prepare("SELECT count(*) AS c FROM budget_events").get()?.["c"]).toBe(0);
    // 事件里带着那句失败原因（回放要答得出「这一格试过而没成」），并且明说没花钱。
    const payload = JSON.parse(String(rows[0]?.["payload"])) as Record<string, unknown>;
    expect(String(payload["note"])).toContain("压根没起来");
    expect(String(payload["note"])).toContain("没花钱");
    expect(payload["costCents"]).toBe(0);
    // 写了 events 就必须广播（少一条就是活连接上的 seq 空洞，0010 §4）。
    expect(w.published.map((p) => p.kind)).toEqual(["RoleTurnReported"]);
    // 卡仍然不建 —— 这一格从来没被放宽过。
    expect(w.db.prepare("SELECT count(*) AS c FROM approvals").get()?.["c"]).toBe(0);
  });

  it("⭐ 连续两次零成本失败 ⇒ 审计里两条，数得出「这是第二次」", async () => {
    // 上面那一发证「有一行」，这一发证「能数」—— 泵的尝试上限靠的就是这个计数。
    // 少了这一发，「写了一行」可能是【每次覆盖同一行】那种实现，照样绿灯。
    const w = await world({});
    await draft(w, { ok: false, text: "", costCents: 0, error: "第一次" });
    await draft(w, { ok: false, text: "", costCents: 0, error: "第二次" });
    const notes = w.db
      .prepare("SELECT payload FROM events ORDER BY id")
      .all()
      .map((x) => String((JSON.parse(String(x["payload"])) as Record<string, unknown>)["note"]));
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("第一次");
    expect(notes[1]).toContain("第二次");
  });
});

describe("广播：本轮消费了 seq 的每一行都发出去", () => {
  it("drafted 那一发：留痕 + 卡片两条都广播，seq 与 events.id 逐条对齐", async () => {
    const w = await world({});
    await draft(w);
    const ids = w.db.prepare("SELECT id FROM events ORDER BY id").all().map((x) => Number(x["id"]));
    expect(w.published.map((p) => p.seq).sort((a, b) => a - b)).toEqual(ids);
    // 【洞】是这一发的重点：总线收到的最大 seq 就是最后一行 events.id，
    // 中间的都发过 ⇒ 活着的 SSE 订阅不会把链路标成 stale（0010 §4）。
    expect(w.bus.latestSeq()).toBe(ids[ids.length - 1]);
    expect(w.published.map((p) => p.kind)).toEqual(["RoleTurnReported", "ApprovalRequired"]);
  });
});

describe("卡片审计那一行的 payload 形状【与 createCard 一致】", () => {
  /**
   * 这一发是【跨生产者】的，不是测 charter.ts 自己。
   *
   * 起因：charter.ts 初版把卡片审计的 payload 写成 {...evt}（字段嵌一层），
   * 而 createCard（http / 巡检 / 远程那条路）写的是 evt.payload（字段在顶层），
   * 后者被 cards.test.ts:438 钉住。dispatch.ts 的建卡处【也是】前者 ——
   * 也就是说引擎建的两类卡片审计与 HTTP 建的那一类在库里【形状不同】，
   * 而共用的是 payload.kind，所以 role-memory 那个判别式一直【看起来是对的】：
   * 共用部分掩盖了不共用部分，这一族里最难查的那种分叉。
   *
   * 断言方式因此刻意是【两边都建一张真卡，逐键比】，而不是把期望形状抄进这里：
   * 抄一份期望值的话，两边一起改错它照样绿（本仓抓过多次的那种绿）。
   */
  it("engine 建的卡与 createCard 建的卡，审计 payload 的【键集合】完全相同", async () => {
    const w = await world({});
    await draft(w);
    const engineRow = w.db
      .prepare("SELECT payload FROM events WHERE action = ? ORDER BY id DESC LIMIT 1")
      .get(KIND_TO_ACTION.ApprovalRequired) as Row | undefined;
    const engineKeys = Object.keys(JSON.parse(String(engineRow?.["payload"])) as Record<string, unknown>).sort();

    const { createCard } = await import("../../src/approvals/cards.js");
    const res = await createCard(
      w.q,
      {
        taskId: "t1",
        approvalType: "escalation",
        cardKey: "shape:baseline",
        summary: "对照用卡片",
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
      { nowMs: NOW + 2000 },
    );
    expect(res.result.created).toBe(true);
    const httpRow = w.db
      .prepare("SELECT payload FROM events WHERE action = ? AND target = ?")
      .get(KIND_TO_ACTION.ApprovalRequired, res.result.approvalId) as Row | undefined;
    const httpKeys = Object.keys(JSON.parse(String(httpRow?.["payload"])) as Record<string, unknown>).sort();

    expect(engineKeys).toEqual(httpKeys);
    // 再钉一层【顶层键】而不是整份 JSON：两份的内容本来就该不同
    // （charter vs escalation、各自的 summary），能漂移的是【形状】。
    const e = JSON.parse(String(engineRow?.["payload"])) as Record<string, unknown>;
    expect(typeof e["approval_type"]).toBe("string");
    expect(typeof e["summary"]).toBe("string");
    expect(Array.isArray(e["evidence_refs"])).toBe(true);
  });
});

describe("简报本身：CEO 的想法要送到角色手上", () => {
  it("prompt 里有任务标题、五栏的要求、以及「不要替 CEO 写验收标准」", async () => {
    const w = await world({});
    const r = await draft(w);
    expect(r.calls.prompt).toContain("做个 AI 笔记应用");
    expect(r.calls.prompt).toContain("可量化验收标准");
    expect(r.calls.prompt).toContain("不要替");
    // 身份走 rolePrompt 那一格（→ --append-system-prompt），不拼进简报
    expect(r.calls.rolePrompt).toContain("intake");
  });

  it("buildCharterDraftPrompt 不会把角色名拼成 undefined", () => {
    const s = buildCharterDraftPrompt({ title: "T", role: "intake", ceoRoleId: "ceo" });
    expect(s).not.toContain("undefined");
    expect(s).toContain("T");
  });
});

describe("parseCharterDraft：只有结构化决策在的时候才算有提案", () => {
  it("取不到 ⇒ null；取到了 summary 是那句摘要", () => {
    expect(parseCharterDraft("随便说点什么")).toBeNull();
    expect(parseCharterDraft(DECISION_MARK + "\n{\"action\":\"wait\"}")).toBeNull(); // 没有 summary
    expect(parseCharterDraft(DECISION_MARK + "\n{\"action\":\"wait\",\"summary\":\"   \"}")).toBeNull();
    const d = parseCharterDraft(draftText());
    expect(d?.summary).toBe("章程提案已拟好，等 CEO 签署");
    expect(d?.text).toContain("业务目标");
  });
});
