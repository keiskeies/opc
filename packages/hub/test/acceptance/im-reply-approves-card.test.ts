/**
 * O12 的验收句逐字走一遍：假频道投卡 → 一次带合法签名的回信 →
 * `GET /approvals` 里那条真的变成 `approved`，且审计行 actor 是绑定的那个角色。
 *
 * ── 规格原话（docs/OPC-OS-功能优化设计.md 的 O12「验收」段）──────────────
 *  「端到端：假频道投卡 → 模拟一次带合法签名的回信 → GET /approvals 里那条
 *   真的变成 approved，且审计行 actor 是绑定的那个角色而不是 system。」
 *
 * ── 本轮之前这条链断在哪，断的【不是】写代码的那一格 ────────────────────
 * 三端今天全在仓库里，缺的是中间那次装配：
 *  · 通道运行时（`channels/abstraction.ts`）写好了，`actorFor` 零注入方；
 *  · 身份读侧（`bindings/im.ts` 的 `makeChannelActorResolver`）写好了，src 零调用方；
 *  · 决策写侧（`engine/approve.ts` 的 `approveCard`）被 HTTP 与 CLI 用着，
 *    而通道层的 `deps.act` 没有任何生产实现方。
 * 所以这条验收今天红的方式不是「逻辑错」，是 `handleOne` 走到 act 那一格
 * 返回 `{kind:"failed", why:"装配未提供 act 落库点"}`。
 * `channels/approval-bridge.ts` 就是那次装配，本文件就是它的第一位读者。
 *
 * ── 全文件最该读的一发是【反空转】那一发，不是主链路 ────────────────────
 * `im_bindings` 的列是 `ceo_role TEXT NOT NULL DEFAULT 'ceo'` +
 * `verified INTEGER DEFAULT 0`（0001_init.sql:249）。抽象层文件头算过：
 * 不看 `verified` 的接线等于造出一条【能批准的冒充通道】，而它今天全部测试会绿。
 * 所以这里【未验证绑定的那一发】比主链路更承重：它要红在 unauthorized，
 * 且卡片保持 pending、一条审批决策审计都不写。
 *
 * ── 审计 actor 那一格：验的是【谁】，不是【是不是人】────────────────────
 * 验收句点名"不是 system"，但两条生产决策路径的 actorId 从来就不是 system
 * （HTTP 写死 `ceo`）。真正会发生的坏写法是【照抄 ceo】—— 于是这里断言的是
 * actor_id === 绑定的那个角色，并额外钉死它既不是 system 也不是 ceo。
 *
 * ── 跑法 ──────────────────────────────────────────────────────────────
 *   npx vitest run packages/hub/test/acceptance/im-reply-approves-card.test.ts
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCard } from "../../src/approvals/cards.js";
import {
  markVerified,
  rebindRole,
  requestBinding,
} from "../../src/bindings/im.js";
import {
  type Channel,
  type ChannelEnvelope,
  createChannelRuntime,
  encodeCardAction,
  type OutboundApprovalCard,
} from "../../src/channels/abstraction.js";
import { makeApprovalBridge } from "../../src/channels/approval-bridge.js";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { InMemoryEventBus } from "../../src/events/bus.js";
import {
  type HubDeps,
  type HubRequest,
  handleRequest,
} from "../../src/http/app.js";
import {
  NonceGuard,
  newLocalToken,
  signedHeaders,
} from "../../src/http/auth.js";
import { LOOPBACK_HOST } from "../../src/http/bind.js";
import { buildHubDeps, insertTask } from "../../src/http/real-deps.js";
import { DRIVER_OFF } from "../fixtures/driver-state.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("acceptance-im-approval", import.meta.url);
const NOW = 1_700_000_000_000;
const TASK_ID = "t-im-1";
/** 绑到 IM 上的那个角色 —— 审计行 actor_id 必须等于它。 */
const ROLE = "director";
const CHANNEL_ID = "feishu-ceo-dm";
const SENDER = "ou_external_9527";

const queues: WriteQueue[] = [];
let fileSeq = 0;

function newQ(name: string): { q: WriteQueue; path: string } {
  const path = join(TMP, name + "-" + process.pid + "-" + ++fileSeq + ".db");
  const q = new WriteQueue(path);
  queues.push(q);
  migrate(q.writeConnection());
  return { q, path };
}

/** 一条 CHARTER_PENDING 的任务 —— `approveCard` 的 stale_card 判据对它放行。 */
async function seedTask(q: WriteQueue): Promise<void> {
  await insertTask(q, {
    id: TASK_ID,
    title: "上线支付模块",
    assignedRole: ROLE,
    nowMs: NOW,
  });
}

/**
 * 一张**可逆**的待批卡。
 *
 * `budget_override` + `irreversible: false` 两格都得给：
 *  · 类型选 `irreversible_action` 会被通道层当场拒（O11「不可逆不许在 IM 批」）；
 *  · `parameters.irreversible` 缺省【也算不可逆】—— `isIrreversibleApproval`
 *    在「读不出参数」那一支一律偏严（误判成可逆的代价是开出一条不该开的通道）。
 * parameters 那五键是 `cards.ts` 的 §9.2 契约要求的，少一键建卡就抛。
 */
async function seedCard(
  q: WriteQueue,
  irreversible = false,
  cardKey?: string,
): Promise<string> {
  const r = await createCard(
    q,
    {
      taskId: TASK_ID,
      approvalType: "budget_override",
      summary: "本季度预算超支 12%，请求追加",
      parameters: {
        impact_scope: "本季度研发预算",
        irreversible,
        recommendation: "推荐：先砍非必要实验（推荐，非决定）",
        recommendation_is_not_decision: true,
        timeout_behavior: "auto_reject",
      },
      evidence_refs: ["evidence/burn-down-11.md"],
      buttons: ["approve", "reject_with_comment", "defer_deep_review"],
      ...(cardKey === undefined ? {} : { cardKey }),
    },
    { nowMs: NOW },
  );
  return r.result.approvalId;
}

/** 申请 + 校验一条绑定。返回时 `verified = 1`。 */
async function bindVerified(
  q: WriteQueue,
  senderId = SENDER,
  role = ROLE,
): Promise<void> {
  const r = await requestBinding(q, {
    platform: "feishu",
    externalUserId: senderId,
    role,
    nowMs: NOW,
  });
  if (r.kind !== "requested") {
    throw new Error("requestBinding 预期 requested，实到 " + r.kind);
  }
  const v = await markVerified(q, {
    platform: "feishu",
    externalUserId: senderId,
    verifiedBy: "ceo",
    nowMs: NOW + 1,
  });
  if (v.kind !== "verified") {
    throw new Error("markVerified 预期 verified，实到 " + v.kind);
  }
}

/** 只申请、**不校验** —— 反空转那一发的起点。 */
async function bindPending(q: WriteQueue): Promise<void> {
  const r = await requestBinding(q, {
    platform: "feishu",
    externalUserId: SENDER,
    role: ROLE,
    nowMs: NOW,
  });
  if (r.kind !== "requested") {
    throw new Error("requestBinding 预期 requested，实到 " + r.kind);
  }
}

/** 一次点击产生的那条入站信封。`text` 就是回传的卡片动作载荷。 */
function clickEnvelope(approvalId: string, senderId = SENDER): ChannelEnvelope {
  return {
    message: {
      channelId: CHANNEL_ID,
      platform: "feishu",
      senderId,
      conversationId: "cid-1",
      text: encodeCardAction({ approvalId, resume: "approve" }),
      atBot: false,
      kind: "card_action",
    },
    receivedAtMs: NOW + 5_000,
    deliveryId: "msg-1",
  };
}

/** 只投这些消息的假通道。`supportsActionReturn` 给 true：这是「能回传」的平台。 */
function fakeChannel(
  envelopes: ChannelEnvelope[],
  source?: { queue: ChannelEnvelope[] },
): Channel {
  // 给了 `source` 就投它那份队列（外头可以往里追加，同一条通道跨多轮 poll）。
  const box = source ?? { queue: [...envelopes] };
  return {
    id: CHANNEL_ID,
    platform: "feishu",
    supportsActionReturn: true,
    async start(): Promise<void> {},
    async close(): Promise<void> {},
    pull(): readonly ChannelEnvelope[] {
      const out = box.queue;
      box.queue = [];
      return out;
    },
    async send(_card: OutboundApprovalCard): Promise<void> {},
  };
}

interface Harness {
  readonly q: WriteQueue;
  readonly bus: InMemoryEventBus;
  readonly deps: HubDeps;
  readonly req: (o: {
    method: string;
    path: string;
    query?: Readonly<Record<string, string | undefined>>;
    body?: string;
  }) => HubRequest;
  readonly bridge: ReturnType<typeof makeApprovalBridge>;
  /** 同一轮里投这些信封，交出那条通道的判决种类。 */
  readonly pollOnce: (envelopes: ChannelEnvelope[]) => Promise<string[]>;
  /**
   * 对【同一个 runtime】再 poll 一轮。
   *
   * 幂等键（`seen`）住在 runtime 里，所以「同一条重投」这类判据只有跨 poll 复用
   * 同一个 runtime 才测得到。每次 poll 新建 runtime 的写法对「重复投递」是绿的
   * —— 那正是它要防的那件事。
   */
  readonly poll: () => Promise<string[]>;
}

function harness(name: string): Harness {
  const { q, path } = newQ(name);
  const bus = new InMemoryEventBus();
  const token = newLocalToken();
  const backupDir = join(TMP, "backup-" + name);
  mkdirSync(backupDir, { recursive: true });
  const deps = buildHubDeps({
    queue: q,
    bus,
    token,
    now: () => NOW,
    driverState: () => DRIVER_OFF,
    nonces: new NonceGuard(),
    orgDbPath: path,
    orgBackupDir: backupDir,
  });
  const bridge = makeApprovalBridge({
    w: q,
    registry: [{ channelId: CHANNEL_ID, platform: "feishu" }],
    publish: (e, seq) => bus.publishPersisted(e, seq),
  });
  const source = { queue: [] as ChannelEnvelope[] };
  const rt = createChannelRuntime({
    deps: { now: () => NOW, loadCard: bridge.loadCard, act: bridge.act },
    actorFor: bridge.actorFor,
  });
  rt.register(fakeChannel([], source));
  const poll = async (): Promise<string[]> => {
    const rounds = await rt.pollAll();
    expect(rounds.length).toBe(1);
    const round = rounds[0] as {
      handled: readonly { verdict: { kind: string } }[];
      got: number;
    };
    // 「取走了却没判决」在任何一发里都会当场红（抽象层那条同构断言）。
    expect(round.handled.length).toBe(round.got);
    return round.handled.map((x) => x.verdict.kind);
  };
  return {
    q,
    bus,
    deps,
    bridge,
    poll,
    pollOnce: async (envelopes) => {
      source.queue.push(...envelopes);
      return poll();
    },
    req: (o) => {
      // 签名签【含 query 的 target】，路由看【剥过 query 的 path】（auth.ts 的
      // canonicalString）。这里如果只签 path，带 query 的请求恒 401 —— 而契约层
      // 看不见（contract.test.ts 文件头记的正是这发）。
      const q2 = o.query ?? {};
      const qs = Object.entries(q2)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => k + "=" + (v as string))
        .join("&");
      const target = o.path + (qs === "" ? "" : "?" + qs);
      const body = o.body ?? "";
      return {
        method: o.method,
        path: o.path,
        target,
        query: q2,
        peer: LOOPBACK_HOST,
        body,
        headers: signedHeaders(token, {
          method: o.method,
          target,
          body,
          now: NOW,
        }),
      };
    },
  };
}

/**
 * 从 `GET /approvals` 的响应里找那张卡。
 *
 * ⚠ `status` 必须【指名】。这个端点默认只列 pending（approvals/query.ts），
 * 所以「批准之后再看一眼」如果走默认那一页，读到的会是【空列表】——
 * 于是 `expect(card).toBeNull()` 那种断言在「批准成功了」与「压根没批」上
 * 都给绿，正好把这条验收句最该分开的那两种世界合上了。
 */
async function cardViaHttp(
  h: Harness,
  approvalId: string,
  status: "pending" | "approved",
): Promise<Record<string, unknown> | null> {
  const res = await handleRequest(
    h.deps,
    h.req({ method: "GET", path: "/approvals", query: { status } }),
  );
  expect(res.status).toBe(200);
  const body = res.body as { approvals: Record<string, unknown>[] };
  return body.approvals.find((a) => a["id"] === approvalId) ?? null;
}

function auditRows(q: WriteQueue, target: string): Record<string, unknown>[] {
  return q
    .readConnection()
    .prepare(
      "SELECT actor_type, actor_id, action FROM events WHERE target = ? ORDER BY id",
    )
    .all(target) as Record<string, unknown>[];
}

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

/* ══════════════════════ 主链路：验收句逐字 ══════════════════════ */

describe("O12 验收句：假频道投卡 → 合法回信 → GET /approvals 真的 approved", () => {
  it("⭐ 回信落成决策：卡片 approved，且审计行 actor 是绑定的那个角色", async () => {
    const h = harness("main");
    await seedTask(h.q);
    const approvalId = await seedCard(h.q);
    await bindVerified(h.q);

    const verdicts = await h.pollOnce([clickEnvelope(approvalId)]);
    expect(verdicts).toEqual(["acted"]);

    // ── 验收句的前半：`GET /approvals` 里那条【真的】变了 ──
    // 读的是真 HTTP 层（buildHubDeps + handleRequest），不是测试自己写的读法。
    // 两个页面都看：只说「approved 页里有它」对「从没待过批」是绿的，
    // 只说「pending 页里没它」对「被超时器判掉了」也是绿的。两条一起才是「批掉了」。
    const card = await cardViaHttp(h, approvalId, "approved");
    expect(card).not.toBeNull();
    expect(card?.["status"]).toBe("approved");
    expect(await cardViaHttp(h, approvalId, "pending")).toBeNull();

    // ── 验收句的后半：审计行 actor 是【绑定的那个角色】 ──
    // 建卡那条审计（actor=system/hub）与决策那一条在这里必须分得开，
    // 所以按 target 取全部行、按 action 定位那一条决策，而不是「取第一行」。
    const rows = auditRows(h.q, approvalId);
    const decided = rows.filter((r) => r["action"] === "approval").pop();
    expect(decided).toBeDefined();
    expect(decided?.["actor_id"]).toBe(ROLE);
    // ⚠ 这两条否定断言才是这一发的分量：验收句写的是「不是 system」，
    // 而两条生产决策路径真正会照抄的是 `ceo`。只断言「不是 system」的测试
    // 对「照抄 ceo」是绿的。
    expect(decided?.["actor_id"]).not.toBe("system");
    expect(decided?.["actor_id"]).not.toBe("ceo");
    // actorType 不换：这一格换的是【谁】，不是【是不是人】。
    expect(decided?.["actor_type"]).toBe("human");
  });

  it("状态边那条审计与决策那条同源：两行署同一个名", async () => {
    const h = harness("edge-actor");
    await seedTask(h.q);
    const approvalId = await seedCard(h.q);
    await bindVerified(h.q);

    await h.pollOnce([clickEnvelope(approvalId)]);
    // CHARTER_PENDING --approve--> CHARTER_APPROVED 那条边也有一条审计，
    // 它的 target 是【目标状态】而不是卡片 id，所以按 action 取。
    const rows = h.q
      .readConnection()
      .prepare(
        "SELECT actor_type, actor_id, action FROM events WHERE action = 'state_change'",
      )
      .all() as Record<string, unknown>[];
    expect(rows.length).toBe(1);
    expect(rows[0]?.["actor_id"]).toBe(ROLE);
    expect(rows[0]?.["actor_type"]).toBe("human");
  });

  it("批准广播到真总线：两条事件都出得来，游标与 events.id 可比", async () => {
    const h = harness("broadcast");
    await seedTask(h.q);
    const approvalId = await seedCard(h.q);
    await bindVerified(h.q);

    const before = h.bus.latestSeq();
    const sub = h.bus.subscribe(before);
    await h.pollOnce([clickEnvelope(approvalId)]);
    const it = sub[Symbol.asyncIterator]();
    const got: { kind: string; seq: number }[] = [];
    for (let i = 0; i < 2; i++) {
      const v = await it.next();
      if (v.done) throw new Error("第 " + (i + 1) + " 条之前流被关掉了");
      got.push({ kind: v.value.kind, seq: v.value.seq });
    }
    sub.close();
    // 决策 + 状态边 = 两条。总线如果没接上，这一发读到的是超时/关闭，
    // 而 SSE 那边读到的就是 seq 空洞（症状是「每次批准把连接标脏一次」）。
    expect(got.map((x) => x.kind)).toEqual([
      "ApprovalDecided",
      "TaskStateChanged",
    ]);
    // ⚠ 承重的是这一句，不是上面那句：总线那个号【就是】events 表里对应那行的 id。
    // 前端续订用的游标是 REST 给的 events.id，总线另发一套号时两个游标不可比，
    // 表现是「偶尔少一条」—— 而只断言 kind 的测试对它全绿。
    for (const x of got) {
      const row = h.q
        .readConnection()
        .prepare("SELECT action FROM events WHERE id = ?")
        .get(x.seq) as Record<string, unknown> | undefined;
      expect(row, "seq " + x.seq + " 在 events 表里没有那一行").toBeDefined();
      expect(row?.["action"]).toBe(
        x.kind === "ApprovalDecided" ? "approval" : "state_change",
      );
    }
    // 游标起点是订阅那一刻的 latestSeq ⇒ 一条不该丢。dropped() 非零意味着
    // 桥接这一路【消费了 seq 而没送出去】，那正是 0010 §4 量过的失效形状。
    expect(sub.dropped()).toBe(0);
  });

  it("同一条重投只算一次：第二次判 duplicate，决策审计只有一条", async () => {
    const h = harness("replay");
    await seedTask(h.q);
    const approvalId = await seedCard(h.q);
    await bindVerified(h.q);

    const e = clickEnvelope(approvalId);
    expect(await h.pollOnce([e])).toEqual(["acted"]);
    expect(await h.pollOnce([e])).toEqual(["duplicate"]);

    const rows = auditRows(h.q, approvalId).filter(
      (r) => r["action"] === "approval",
    );
    expect(rows.filter((r) => r["actor_id"] === ROLE)).toHaveLength(1);
    const card = h.q
      .readConnection()
      .prepare("SELECT status FROM approvals WHERE id = ?")
      .get(approvalId) as Record<string, unknown>;
    expect(card["status"]).toBe("approved");
  });
});

/* ══════════════════ 反空转：未验证的绑定不算身份 ══════════════════ */

describe("⭐ 反空转：`verified = 0` 那一行【不算身份】", () => {
  it("pending 绑定 → 回信判 unauthorized，卡片仍 pending，一条决策审计都不写", async () => {
    const h = harness("pending-binding");
    await seedTask(h.q);
    const approvalId = await seedCard(h.q);
    // 只申请、不校验：`ceo_role` 默认 'ceo'、`verified` 默认 0 的那一行就是攻击面。
    await bindPending(h.q);

    const verdicts = await h.pollOnce([clickEnvelope(approvalId)]);
    expect(verdicts).toEqual(["unauthorized"]);

    const card = await cardViaHttp(h, approvalId, "pending");
    expect(card?.["status"]).toBe("pending");
    // 建卡那条 system/hub 审计在；决策那一条【不存在】。
    const decided = auditRows(h.q, approvalId).filter(
      (r) => r["action"] === "approval" && r["actor_id"] !== "hub",
    );
    expect(decided).toEqual([]);
  });

  it("channelId 没登记 → 判 unauthorized：拿不到平台就不猜", async () => {
    const h = harness("unknown-channel");
    await seedTask(h.q);
    const approvalId = await seedCard(h.q);
    await bindVerified(h.q);

    // 同一条已验证绑定，换一条没登记的通道实例 ⇒ 拒。
    // 猜平台的坏法要的是「两个平台外部 id 撞车」那种形状才测得出，
    // 而这条判据把那一族整个挡在门外。
    const bridge = makeApprovalBridge({
      w: h.q,
      registry: [{ channelId: "some-other-channel", platform: "feishu" }],
      publish: () => {},
    });
    expect(
      bridge.actorFor({ senderId: SENDER, channelId: CHANNEL_ID }),
    ).toBeNull();

    const rt = createChannelRuntime({
      deps: { now: () => NOW, loadCard: bridge.loadCard, act: bridge.act },
      actorFor: bridge.actorFor,
    });
    rt.register(fakeChannel([clickEnvelope(approvalId)]));
    const rounds = await rt.pollAll();
    const kinds = (
      rounds[0] as { handled: readonly { verdict: { kind: string } }[] }
    ).handled.map((x) => x.verdict.kind);
    expect(kinds).toEqual(["unauthorized"]);

    const card = await cardViaHttp(h, approvalId, "pending");
    expect(card?.["status"]).toBe("pending");
  });

  it("⭐ 直调 act 也认 verified：pending 绑定【绕开通道层】同样批不掉", async () => {
    // 这一发是变异 M2 教出来的，不是先想出来再写的。
    // 上面那发 pending 绑定走的是【运行时】：那里第一道门是 `actorFor`，
    // 而 `actorFor` 用的是 `makeChannelActorResolver` ⇒ 未验证在进 act 之前就被挡掉了。
    // 于是「桥自己的角色读取器不看 verified」这个坏法【那一发抓不到】——
    // M2 把 `makeBoundRoleReader` 换成裸 SELECT ceo_role 之后，10 发全绿。
    // 绕开通道层直调 act 才是那一格的射程：这条链上【唯一】的身份判据必须两处都是同一条。
    const h = harness("pending-direct-act");
    await seedTask(h.q);
    const approvalId = await seedCard(h.q);
    await bindPending(h.q);

    const r = await h.bridge.act({
      approvalId,
      taskId: TASK_ID,
      resume: "approve",
      actor: { senderId: SENDER, channelId: CHANNEL_ID },
      viaChannelId: CHANNEL_ID,
      receivedAtMs: NOW + 5_000,
    });
    expect(r.ok).toBe(false);
    const card = await cardViaHttp(h, approvalId, "pending");
    expect(card?.["status"]).toBe("pending");
    const decided = auditRows(h.q, approvalId).filter(
      (r2) => r2["action"] === "approval" && r2["actor_id"] !== "hub",
    );
    expect(decided).toEqual([]);
  });

  /* ═══════════ 0046 §6-2：桥 act 给「请求不成立」带状态码提示 ═══════════ */

  it("⭐ 打回而没给理由 ⇒ {ok:false, statusHint:422}，且什么都没写", async () => {
    const h = harness("status-hint-note");
    await seedTask(h.q);
    const approvalId = await seedCard(h.q);
    await bindVerified(h.q);

    const r = await h.bridge.act({
      approvalId,
      taskId: TASK_ID,
      resume: "reject_with_comment",
      actor: { senderId: SENDER, channelId: CHANNEL_ID },
      viaChannelId: CHANNEL_ID,
      receivedAtMs: NOW + 5_000,
      // 刻意不带 note：打回必须带理由（approve.ts 那条 requiresNote）。
    });
    expect(r).toEqual({ ok: false, statusHint: 422, why: expect.any(String) });
    // 没写任何东西：卡片仍 pending、决策审计一条都没有。
    const card = await cardViaHttp(h, approvalId, "pending");
    expect(card?.["status"]).toBe("pending");
  });

  it("⭐ 点到过期卡 ⇒ {ok:false, statusHint:409}", async () => {
    const h = harness("status-hint-stale");
    await seedTask(h.q);
    await bindVerified(h.q);
    // stale_card 判据（approve.ts:363）是「当前这一格【有】自己的卡，而你点的不是
    // 那张」：own.length > 0 && !isOwn。所以构造要两张：
    //   · 当前格的 own 卡（seat:FINAL_REVIEW:…）—— 让 own 非空；
    //   · 一张旧格的卡（seat:ESCALATED_TO_CEO:…）—— 点它 ⇒ 不是 own ⇒ stale。
    // 只有一张旧卡（own 空）时反过来【不】 stale：那格没有自己的卡，沿用旧行为
    // （approve.ts:359 注释：「空 = 这一格没有自己的卡…⇒ 调用方沿用旧行为」）。
    const ownApproval = await seedCard(h.q, false, "seat:FINAL_REVIEW:1");
    const staleApproval = await seedCard(h.q, false, "seat:ESCALATED_TO_CEO:2");
    // 任务当前停在 FINAL_REVIEW（与 own 卡同格，与 stale 卡不同格）。
    h.q
      .writeConnection()
      .prepare("UPDATE tasks SET status = ? WHERE id = ?")
      .run("FINAL_REVIEW", TASK_ID);

    // 先点 stale 卡：此刻 from=FINAL_REVIEW、own=FINAL_REVIEW 卡、点的是 ESCALATED
    // 旧卡 ⇒ 不是 own ⇒ stale（先点 own 会推进任务状态，把 from 推走，就测不到了）。
    const rStale = await h.bridge.act({
      approvalId: staleApproval,
      taskId: TASK_ID,
      resume: "approve",
      actor: { senderId: SENDER, channelId: CHANNEL_ID },
      viaChannelId: CHANNEL_ID,
      receivedAtMs: NOW + 5_000,
    });
    expect(rStale).toEqual({
      ok: false,
      statusHint: 409,
      why: expect.any(String),
    });

    // 分母：当前格的 own 卡能批（证明是「sale 卡批不动」而不是「批什么都不行」）。
    const rOwn = await h.bridge.act({
      approvalId: ownApproval,
      taskId: TASK_ID,
      resume: "approve",
      actor: { senderId: SENDER, channelId: CHANNEL_ID },
      viaChannelId: CHANNEL_ID,
      receivedAtMs: NOW + 5_000,
    });
    expect(rOwn).toEqual({ ok: true });
  });

  it("⭐ 反向对照：正常批准不带 statusHint（decided 保持 {ok:true}）", async () => {
    const h = harness("status-hint-ok");
    await seedTask(h.q);
    const approvalId = await seedCard(h.q);
    await bindVerified(h.q);

    const r = await h.bridge.act({
      approvalId,
      taskId: TASK_ID,
      resume: "approve",
      actor: { senderId: SENDER, channelId: CHANNEL_ID },
      viaChannelId: CHANNEL_ID,
      receivedAtMs: NOW + 5_000,
    });
    expect(r).toEqual({ ok: true });
  });

  it("决策落库前重查角色：rebind 撤掉校验的那一刻，回信批不掉", async () => {
    const h = harness("revoke");
    await seedTask(h.q);
    const approvalId = await seedCard(h.q);
    await bindVerified(h.q);

    const bridge = makeApprovalBridge({
      w: h.q,
      registry: [{ channelId: CHANNEL_ID, platform: "feishu" }],
      publish: () => {},
    });
    // 点击在路上：actorFor 那一刻还是已验证的。
    expect(
      bridge.actorFor({ senderId: SENDER, channelId: CHANNEL_ID }),
    ).not.toBeNull();
    // 路上被撤 —— rebind 会把 verified 清回 0（生产路径，不是测试手改库）。
    const rb = await rebindRole(h.q, {
      platform: "feishu",
      externalUserId: SENDER,
      role: ROLE,
    });
    expect(rb.kind).toBe("rebound");

    const r = await bridge.act({
      approvalId,
      taskId: TASK_ID,
      resume: "approve",
      actor: { senderId: SENDER, channelId: CHANNEL_ID },
      viaChannelId: CHANNEL_ID,
      receivedAtMs: NOW + 5_000,
    });
    expect(r.ok).toBe(false);

    const card = await cardViaHttp(h, approvalId, "pending");
    expect(card?.["status"]).toBe("pending");
  });
});

/* ══════════════════ 装配的接线形状（不是逻辑，是【接没接上】）══════════════════ */

describe("桥接装配本身：判序是 角色 → 决策，loadCard 读的是库里那一行", () => {
  it("⭐ 没有身份时【不落库】：act 单独调用也拒，卡片保持 pending", async () => {
    // 判序反过来的坏形状：act 先批卡、再判身份 ⇒ 一个没身份的人先把卡批掉了。
    // 这一发绕开通道层直接调 act，钉的是【桥自己】的判序，
    // 而不是「通道层在前面挡了一道」（那一格由 channel.test.ts 的清单管）。
    const h = harness("act-no-identity");
    await seedTask(h.q);
    const approvalId = await seedCard(h.q);
    const bridge = makeApprovalBridge({
      w: h.q,
      registry: [{ channelId: CHANNEL_ID, platform: "feishu" }],
      publish: () => {},
    });
    const r = await bridge.act({
      approvalId,
      taskId: TASK_ID,
      resume: "approve",
      actor: { senderId: "ou_nobody", channelId: CHANNEL_ID },
      viaChannelId: CHANNEL_ID,
      receivedAtMs: NOW + 5_000,
    });
    expect(r.ok).toBe(false);
    const card = h.q
      .readConnection()
      .prepare("SELECT status FROM approvals WHERE id = ?")
      .get(approvalId) as Record<string, unknown>;
    expect(card["status"]).toBe("pending");
  });

  it("loadCard 读的是库里那一行：脏 parameters 不抛，「读不到」与「没有」分得开", async () => {
    const h = harness("loadcard-dirty");
    await seedTask(h.q);
    const approvalId = await seedCard(h.q);
    // 把 parameters 改成非法 JSON —— 渲染路径上「读不到」与「没有」必须是两回事。
    // 夹具直写走 writeConnection()（超时器那条测试的同款写法），不套 node()。
    h.q
      .writeConnection()
      .prepare("UPDATE approvals SET parameters = ? WHERE id = ?")
      .run("{不是 JSON", approvalId);
    const bridge = makeApprovalBridge({
      w: h.q,
      registry: [{ channelId: CHANNEL_ID, platform: "feishu" }],
      publish: () => {},
    });
    const snap = bridge.loadCard(approvalId);
    expect(snap).not.toBeNull();
    expect(snap?.parametersJson).toBe("{不是 JSON");
    expect(snap?.status).toBe("pending");
    expect(snap?.evidenceRefs).toEqual(["evidence/burn-down-11.md"]);
    expect(bridge.loadCard("不存在的卡")).toBeNull();
  });

  it("⭐ 不可逆卡在【落库点】也被拒：直调 act 批不掉，卡片保持 pending", async () => {
    // O11「不可逆不许在 IM 里批」今天有【两道】门，这一发钉的是第二道：
    //  · 第一道在抽象层 `handleOne`（channelIneligibleReason ⇒ not_actionable），
    //    它管的是【走运行时的调用方】；
    //  · 第二道在桥的 `act` 落库前 —— 因为 `act` 是本模块的导出，装配方可以直调它。
    // 只测第一道的写法对「第二道被摘掉」是全绿的（变异 M3 就是摘它）。
    // 所以这里【绕开运行时】直接调 act，且给一个【已验证的绑定】：
    // 身份那一格是过的，挡它的只许是可逆性那一格。
    const h = harness("irreversible-direct-act");
    await seedTask(h.q);
    const approvalId = await seedCard(h.q, true);
    await bindVerified(h.q);

    // 先证第一道门也在（不然这一发会被读成「运行时那条不判不可逆」）。
    expect(await h.pollOnce([clickEnvelope(approvalId)])).toEqual([
      "not_actionable",
    ]);

    const r = await h.bridge.act({
      approvalId,
      taskId: TASK_ID,
      resume: "approve",
      actor: { senderId: SENDER, channelId: CHANNEL_ID },
      viaChannelId: CHANNEL_ID,
      receivedAtMs: NOW + 5_000,
    });
    expect(r.ok).toBe(false);
    const card = await cardViaHttp(h, approvalId, "pending");
    expect(card?.["status"]).toBe("pending");
    // 一条决策审计都不写：拒绝必须是【什么都没发生】，不是「发生了但回滚」。
    const decided = auditRows(h.q, approvalId).filter(
      (r2) => r2["action"] === "approval" && r2["actor_id"] !== "hub",
    );
    expect(decided).toEqual([]);
  });

  it("⭐ 角色不是写死的：换一个绑定的发送者，审计 actor 跟着换", async () => {
    // 这一发管的是「接线的人照抄 `ceo`」与「接线的人把角色写死成任何一个值」
    // 两种坏法 —— 前者是 HTTP 那条路上现成的形状，后者是更省事的写法。
    // 主链路那一发只用了 `director` 一个角色，写死它也能绿；
    // 这里【同一条通道、两个已验证绑定、两个不同角色】，写死哪一个都会红另一发。
    const h = harness("role-swap");
    await seedTask(h.q);
    const approvalId = await seedCard(h.q);
    const OTHER = "product";
    const OTHER_SENDER = "ou_external_1101";
    await bindVerified(h.q, SENDER, ROLE);
    await bindVerified(h.q, OTHER_SENDER, OTHER);

    expect(await h.pollOnce([clickEnvelope(approvalId, OTHER_SENDER)])).toEqual(
      ["acted"],
    );
    const decided = auditRows(h.q, approvalId)
      .filter((r) => r["action"] === "approval")
      .pop();
    expect(decided?.["actor_id"]).toBe(OTHER);
    expect(decided?.["actor_id"]).not.toBe(ROLE);
  });
});
