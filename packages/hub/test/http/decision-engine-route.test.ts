/**
 * CEO 点一次批准，任务【真的往前走一格】—— 默认装配（引擎写路径）的端到端证据。
 *
 * ── 这个文件存在的理由：一条 500 + 一条骗人的 replayed ────────────────
 * 改之前（0043 §1 那份装机探针量到的，跑的是真的 buildHubDeps + 真的装配默认值）：
 *
 *   第一次点批准 : 500 「这个 Hub 入口【没有】接上图运行时（graph_not_wired）」
 *     任务状态   : CHARTER_PENDING        ← 一步没动
 *     卡片状态   : approved               ← 已经批了，append-only，删不掉
 *   再点一次     : 200 {"ok":true,"replayed":true}
 *     任务状态   : CHARTER_PENDING        ← 永远停在这里
 *
 * 那三行是本仓定义为最贵的那一类（0010 §3 / 0041 §12 同一条判据）：
 * **看起来接上了、跑起来必炸、测试全绿** —— 而它比"什么都没发生"多坏一处：
 * 第二次点返回 replayed:true，渲染层按规格 §7.2 把它读成「已经生效了」，
 * 于是【重试这条路在语义上被关掉了】。屏幕先说 500、再说成功，任务从未动过。
 *
 * ── 为什么 http/contract.test.ts 那 207 发【一条都抓不到】它 ──────────
 * 那些用例的 deps 是手搓字面量：recordDecision 是一个自增计数器的替身、
 * resumeGraph 是 `calls.resumed.push(id)`。它们测的是【handler 的分支】
 * （404 不调、重放不调、只有首次调），那部分至今正确，也至今与生产无关。
 * 也就是说这条链坏了很久而 http 那一层一直全绿 —— 因为【被测的那一层不含坏掉的那一半】。
 * 所以这一发的每一条都跑在 buildHubDeps + 真队列 + 真库上，一条写路径替身都不用
 * （替身是这个缺陷的成因，不只是它的遮羞布）。
 *
 * ── 这个文件【不测】的 ──────────────────────────────────────────────
 *  · 卡片渲染 / 点按钮那一下的前端行为 —— 本机没有浏览器（0039）。
 *  · 章程卡【怎么来的】（ensureCharterCard 只在引擎 CLI 那侧）—— 0043 §4 那一格，
 *    本文件从「卡片已经在库里」起步。
 *  · requireScopeDb 那道守卫：它要求写入发生在 WriteQueue 的写事务作用域里，
 *    所以本文件【一律用真队列】—— 手搓一个 node() 会让这一族缺陷重新变成可写出来的。
 *
 * ── 打回不带理由那一条，两道网是【叠着】的，各测各的 ──────────────────
 * contracts 的 superRefine（HTTP 侧 422）与 approveCard 里的 requiresNote（引擎侧
 * note_required）判的是同一件事。HTTP 这一发只能量到上面那道 —— 请求根本到不了写路径。
 * 所以这里断的是 422 + 库里一行没写，【不】断 500：断一个结构上到不了的分支，
 * 等于把"我以为代码在哪"当成"代码在哪"，而那正是本篇开头那个缺陷的成因形状。
 * 下面那条 dep 层的用例补量第二道网（CLI / 桌面直连没有 422 兜着）。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ResumeValue } from "@opc/contracts";
import { fixtureTmp } from "../fixtures/fixture-dir.js";
import { migrate } from "../../src/db/migrate.js";
import { InMemoryEventBus, type DomainEvent } from "../../src/events/bus.js";
import { insertCard } from "../../src/approvals/cards.js";
import { INSERT_DELEGATION_GRAPH_SQL } from "../../src/org/commit.js";
import { newLocalToken, signedHeaders, NonceGuard } from "../../src/http/auth.js";
import { LOOPBACK_HOST } from "../../src/http/bind.js";
import { handleRequest, type HubDeps, type HubRequest } from "../../src/http/app.js";
import { DRIVER_OFF } from "../fixtures/driver-state.js";
import { buildHubDeps, insertTask, type HubWriter } from "../../src/http/real-deps.js";

const TMP = fixtureTmp("decision-engine-route", import.meta.url);
const NOW = 1_700_000_000_000;
const TOKEN = newLocalToken();

type Row = Record<string, unknown>;

const queues: HubWriter[] = [];
let fileSeq = 0;

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});
afterAll(async () => {
  for (const q of queues) {
    try {
      await q.close();
    } catch {
      /* 已关 */
    }
  }
  // 清理在 afterAll 而不是只在 beforeAll：目录名带 pid ⇒ 下一次运行【不会】顺手删它。
  // 少了这一行就是每跑一次漏一份 SQLite 库（fixture-dir.test.ts ④ 那条普查判的就是它，
  // 而它先靠 fixtureTmp 的"pid 已死的兄弟目录"兜底 —— 那是兜底，不是清理）。
  rmSync(TMP, { recursive: true, force: true });
});

/**
 * 取干总线里已发布的事件。
 * 取法（先读 latestSeq 再按个数取，而不是迭代到 done）与不会挂住的理由
 * 抄自 test/budget/tracker.test.ts 那个同名函数 —— 订阅是 AsyncIterable，
 * 迭代到 done 会永远等下一条。
 */
async function feed(bus: InMemoryEventBus): Promise<DomainEvent[]> {
  const owed = bus.latestSeq();
  const sub = bus.subscribe(0);
  const it = sub[Symbol.asyncIterator]();
  const got: DomainEvent[] = [];
  for (let i = 0; i < owed; i++) {
    const step = await it.next();
    if (step.done === true) break;
    got.push(step.value);
  }
  sub.close();
  return got;
}

type Harness = {
  deps: HubDeps;
  queue: HubWriter;
  bus: InMemoryEventBus;
  db: DatabaseSync;
  taskId: string;
  cardId: string;
  req: (o: { method: string; path: string; body?: string }) => HubRequest;
};

/**
 * 一份【默认装配】的 Hub：调 buildHubDeps 而【不传 graphFor】。
 *
 * 不传那一格就是这一整个文件的核心 —— 它是 assemble.ts 在生产里走的那一条。
 * 0043 之前那一行是 `o.graphFor ?? unavailableGraphFor(dbPath)`，
 * 也就是「不传」恰好等于「装一个被 CEO 点到就抛的工厂」。
 *
 * ⚠ 这里【刻意不注入任何东西来让事情变顺利】。旧的那一发正是这么坏的：
 * 测试里给 resumeGraph 一个 `push(id)` 的替身，于是生产那个抛
 * 永远不出现在被测路径上，而测试绿灯了不知多久。
 */
async function hub(opts: {
  /** 任务的起始状态。默认 CHARTER_PENDING（CEO 下发想法之后落的那一格）。 */
  readonly status?: string;
  /** true ⇒ 交一个图工厂，走【图那条路线】（最后一条用例）。 */
  readonly graphFor?: (taskId: string) => never;
}): Promise<Harness> {
  const { WriteQueue } = await import("../../src/db/write-queue.js");
  const path = join(TMP, "d-" + process.pid + "-" + ++fileSeq + ".db");
  const q = new WriteQueue(path) as unknown as HubWriter;
  queues.push(q);
  migrate(q.writeConnection() as unknown as Parameters<typeof migrate>[0]);

  // 一张最简组织图（ceo + intake）。approveCard 自己不查图，带上它是因为真库里
  // graph_version 指向一个真实存在的版本 —— 夹具与生产的差别只该是被测那一处。
  await q.node(() => {
    (q.writeConnection() as unknown as DatabaseSync)
      .prepare(INSERT_DELEGATION_GRAPH_SQL)
      .run(
        "g-" + fileSeq,
        1,
        JSON.stringify({
          nodes: {
            ceo: { role_id: "ceo", reports_to: null, can_manage: true, model_family: "opus" },
            intake: { role_id: "intake", reports_to: "ceo", can_manage: false, model_family: "opus" },
          },
        }),
        NOW,
        "fixture",
        "夹具图",
      );
  });

  const taskId = "task-" + fileSeq;
  await insertTask(q, { id: taskId, title: "做一个登录模块", assignedRole: "intake", nowMs: NOW });
  if (opts.status !== undefined && opts.status !== "CHARTER_PENDING") {
    await q.node(() => {
      (q.writeConnection() as unknown as DatabaseSync)
        .prepare("UPDATE tasks SET status = ? WHERE id = ?")
        .run(opts.status, taskId);
    });
  }

  // 卡片走【真的 insertCard】而不是手搓 INSERT：手搓会绕过契约校验，
  // 于是「这张卡长得像收件箱会显示的那张」这件事没人证明（cards.ts 文件头第 ② 条）。
  const cardId = await q.node(() =>
    insertCard(
      q.writeConnection() as unknown as Parameters<typeof insertCard>[0],
      {
        taskId,
        approvalType: "charter",
        cardKey: "charter:proposal",
        summary: "章程提案待你签署：做一个登录模块",
        parameters: {
          impact_scope: "签了就生效",
          irreversible: true,
          recommendation: "读完再签",
          recommendation_is_not_decision: true,
          timeout_behavior: "escalate",
        },
        evidence_refs: ["events:1"],
        buttons: ["approve", "reject_with_comment", "defer_deep_review"],
      },
      { nowMs: NOW },
    ).approvalId,
  );

  const bus = new InMemoryEventBus();
  const deps = buildHubDeps({
    queue: q,
    bus,
    token: TOKEN,
    ...(opts.graphFor === undefined ? {} : { graphFor: opts.graphFor as never }),
    now: () => NOW,
    // 这一文件测的是【决策写路径】选哪条路线，不跑心跳 ⇒ 这台夹具【没在推】。
    driverState: () => DRIVER_OFF,
    nonces: new NonceGuard(),
  });

  const req = (o: { method: string; path: string; body?: string }): HubRequest => {
    const body = o.body ?? "";
    return {
      method: o.method,
      path: o.path,
      target: o.path,
      query: {},
      peer: LOOPBACK_HOST,
      body,
      headers: signedHeaders(TOKEN, { method: o.method, target: o.path, body, now: NOW }),
    };
  };
  return { deps, queue: q, bus, db: q.readConnection(), taskId, cardId, req };
};

const statusOf = async (h: Harness): Promise<string> => {
  const r = await h.queue.node(() =>
    (h.queue.readConnection() as unknown as DatabaseSync)
      .prepare("SELECT status FROM tasks WHERE id = ?")
      .get(h.taskId),
  );
  return String((r as Row | undefined)?.["status"]);
};
const cardState = async (h: Harness): Promise<string> => {
  const r = await h.queue.node(() =>
    (h.queue.readConnection() as unknown as DatabaseSync)
      .prepare("SELECT status FROM approvals WHERE id = ?")
      .get(h.cardId),
  );
  return String((r as Row | undefined)?.["status"]);
};
const oneRow = async <T,>(h: Harness, sql: string, ...p: unknown[]): Promise<T> =>
  (await h.queue.node(() =>
    (h.queue.readConnection() as unknown as DatabaseSync).prepare(sql).get(...p),
  )) as T;

const decideBody = (resume: ResumeValue, note?: string): string =>
  JSON.stringify({ resume, ...(note === undefined ? {} : { note }) });

describe("默认装配下 CEO 点批准：任务真的走了一条边（0043）", () => {
  it("⭐ approve 一张 CHARTER_PENDING 的章程卡 ⇒ 200 + 任务到 CHARTER_APPROVED", async () => {
    const h = await hub({});
    const body = decideBody("approve");
    const res = await handleRequest(
      h.deps,
      h.req({ method: "POST", path: "/approvals/" + h.cardId, body }),
    );
    // 这一发是整篇的靶心：旧实现这里是 500，而且卡片已经落库成 approved。
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, replayed: false });
    expect(await statusOf(h)).toBe("CHARTER_APPROVED");
    expect(await cardState(h)).toBe("approved");
  });

  it("⭐ 暂缓那颗按钮：卡片记掉而任务不动 —— 而这【不该】被报成一次失败", async () => {
    // HUMAN_EDGES 只有 approve 一条出边（dispatch.ts:136），所以 defer 的
    // 「卡片记掉 + 任务原地」是【规格的现状】，不是这一发的坏。
    // 它在这里被钉住，是因为这条路径【曾经】的落法是 500 —— 一个合法的
    // 决策换来一个看着像失败的答复，正是本篇在修的那个形状。
    const h = await hub({});
    const res = await handleRequest(
      h.deps,
      h.req({ method: "POST", path: "/approvals/" + h.cardId, body: decideBody("defer_deep_review") }),
    );
    expect(res.status).toBe(200);
    expect(await cardState(h)).toBe("deferred");
    expect(await statusOf(h)).toBe("CHARTER_PENDING");
  });

  it("⭐ 第二次点仍是 200 + replayed:true —— 而这一回【任务确实已经动了】", async () => {
    // 同一个 HTTP 答复（200 replayed）在修复前后【含义相反】：
    // 修复前 = 重放了一次什么都没发生的决策；修复后 = 那一次确实推进过。
    // 所以断言必须同时看 HTTP 与库 —— 只看任何一边都会假绿。
    const h = await hub({});
    const body = decideBody("approve");
    await handleRequest(h.deps, h.req({ method: "POST", path: "/approvals/" + h.cardId, body }));
    const second = await handleRequest(
      h.deps,
      h.req({ method: "POST", path: "/approvals/" + h.cardId, body }),
    );
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ok: true, replayed: true });
    expect(await statusOf(h)).toBe("CHARTER_APPROVED");
    // append-only：两次点击只该留下一条决策审计，不许"批过两次"。
    const n = await oneRow<Row>(
      h,
      "SELECT COUNT(*) AS n FROM events WHERE action = 'approval' AND target = ?",
      h.cardId,
    );
    expect(Number(n["n"])).toBe(1);
  });

  it("⭐ 状态边广播出去了（不广播 = 每次批准把 SSE 连接标脏一次，0010 §4）", async () => {
    const h = await hub({});
    await handleRequest(
      h.deps,
      h.req({ method: "POST", path: "/approvals/" + h.cardId, body: decideBody("approve") }),
    );
    const got = await feed(h.bus);
    const kinds = got.map((e) => e.kind);
    expect(kinds).toContain("ApprovalDecided");
    // ⭐ 这一条是引擎路线【新增】的那半：旧路线只发 ApprovalDecided，
    // 任务没动所以没有 TaskStateChanged —— 而"没发"当时看起来完全正常。
    expect(kinds).toContain("TaskStateChanged");
    // seq 必须【严格递增】：投影层把空洞读成「链路降级」。
    const seqs = got.map((e) => (e as { seq?: number }).seq).filter((s) => s !== undefined);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]! > seqs[i - 1]!, "seq 乱序：" + JSON.stringify(seqs)).toBe(true);
    }
  });

  it("⭐ 负责角色不许被抹成 NULL（node:sqlite 少绑参数不报错，直接写 NULL）", async () => {
    const h = await hub({});
    await handleRequest(
      h.deps,
      h.req({ method: "POST", path: "/approvals/" + h.cardId, body: decideBody("approve") }),
    );
    const row = await oneRow<Row>(
      h,
      "SELECT assigned_role, current_node FROM tasks WHERE id = ?",
      h.taskId,
    );
    expect(row["assigned_role"]).toBe("intake");
    expect(row["current_node"]).toBe("intake");
  });

  it("打回带理由 ⇒ 卡片 rejected + 理由落库，任务不动（没有那条出边）", async () => {
    const h = await hub({});
    const res = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/approvals/" + h.cardId,
        body: decideBody("reject_with_comment", "验收口径那一栏没写清楚"),
      }),
    );
    expect(res.status).toBe(200);
    expect(await cardState(h)).toBe("rejected");
    expect(await statusOf(h)).toBe("CHARTER_PENDING");
    // 理由必须落库：append-only 的事后补不进去，那是 requiresNote 那条必填判据的全部理由。
    const note = await oneRow<Row>(h, "SELECT decision_note FROM approvals WHERE id = ?", h.cardId);
    expect(String(note["decision_note"])).toContain("验收口径");
  });

  it("⭐ 打回【不带】理由 ⇒ 422（契约那道网），库里一行都没写", async () => {
    const h = await hub({});
    const res = await handleRequest(
      h.deps,
      h.req({ method: "POST", path: "/approvals/" + h.cardId, body: decideBody("reject_with_comment") }),
    );
    // 状态码本身是断言的一半：422 = 【这次请求不成立】，不是 500（我坏了），
    // 也不是 200 + replayed（把"你没给理由"说成"已经有人决定过了"，
    // 那是 app.ts 末尾 `replayed: !applied` 会顺手编出来的谎）。
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain("note");
    expect(await cardState(h)).toBe("pending");
    expect(await statusOf(h)).toBe("CHARTER_PENDING");
    const n = await oneRow<Row>(h, "SELECT COUNT(*) AS n FROM events WHERE target = ?", h.cardId);
    expect(Number(n["n"])).toBe(0);
  });

  it("⭐ 第二道网：直连 recordDecision 不带理由 ⇒ 抛 + 什么都没写（CLI/桌面那侧没有 422）", async () => {
    // approveCard 有六条 outcome，decideWithEngineEdge 那道 boolean 缝只映射得到两条，
    // 所以 note_required 只能【抛】。这一发测的是 boolean 这道缝的取舍本身：
    // 咽进 false 会换来一个语义错误但形状正常的答复；抛出来才有人看得见。
    // 走 dep 层而不走 HTTP，是因为上面那条 422 已经把请求挡在写路径之外了 ——
    // CLI 与桌面直连没有 superRefine 兜着，那条分支唯一的使用者在那边。
    const h = await hub({});
    await expect(
      h.deps.recordDecision({ approvalId: h.cardId, taskId: h.taskId, resume: "reject_with_comment" }),
    ).rejects.toThrow(/--note/);
    expect(await cardState(h)).toBe("pending");
    expect(await statusOf(h)).toBe("CHARTER_PENDING");
    const n = await oneRow<Row>(h, "SELECT COUNT(*) AS n FROM events WHERE target = ?", h.cardId);
    expect(Number(n["n"])).toBe(0);
  });

  it("⭐ 图那条路线【没被删掉】：给了 graphFor 就还是 applyDecision + resume", async () => {
    // 旧那句 `?? unavailableGraphFor(dbPath)` 坏在把一条本机跑不通的路线当默认；
    // 修法不是删掉它（0010 §3 那笔账挂着 CEO，图修好了要能装回去），是让它不再默认。
    // 所以这一发显式交一个工厂，断言走的还是老契约：卡片被认领、任务【不动】、
    // 恢复被调用一次。任务不动在这一发里是【期望】，不是缺陷 ——
    // 它钉的是"两条路线各自的行为都还在"。
    const h = await hub({});
    const resumed: unknown[] = [];
    const depsWithGraph = buildHubDeps({
      queue: h.queue,
      bus: new InMemoryEventBus(),
      token: TOKEN,
      graphFor: () =>
        ({
          graph: {
            // 没有 pending interrupt ⇒ chooseResumeInput 选 invoke(null) 那一支。
            getState: async () => ({ interrupts: [] }),
            invoke: async (input: unknown) => {
              resumed.push(input);
              return {};
            },
          },
          invoke: async (fn: () => unknown) => fn(),
        }) as never,
      now: () => NOW,
      // 这一处是【给了图】那一支，同样不跑心跳 ⇒ 这台夹具【没在推】。
      driverState: () => DRIVER_OFF,
      nonces: new NonceGuard(),
    });
    const res = await handleRequest(
      depsWithGraph,
      h.req({ method: "POST", path: "/approvals/" + h.cardId, body: decideBody("approve") }),
    );
    expect(res.status).toBe(200);
    expect(await cardState(h)).toBe("approved");
    expect(await statusOf(h)).toBe("CHARTER_PENDING");
    expect(resumed).toEqual([null]); // 走到的是 invoke(null)，不是 Command
  });
});
