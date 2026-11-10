/**
 * 通道抽象层（src/channels/abstraction.ts，计划 Task 4.5）。
 *
 * ── 这个文件在证什么 ────────────────────────────────────────────────
 * 计划的验收标准是一句话：「飞书实现必须通过抽象层接口测试（**换成 fake channel
 * 全部测试仍通过**）」。那句话的结构是「**同一套断言**跑在多个实现上都得绿」，
 * 所以本文件的主体不是一个测试，是一份**清单**（`CASES`）跑在【两个】fake 上。
 *
 * ── 这份证明的【边界】，写在读到用例之前 ────────────────────────────
 * 清单跑在两个 fake 上全绿，含义只有「抽象层的判据**与实现细节无关**」。
 * 它**不**意味着「飞书接得进来」—— 那需要 fake 与飞书在**表达力**上等价，
 * 而 fake 是我照着自己的接口写的，天然等价（abstraction.ts 文件头那条同族限制）。
 *
 * 所以本文件末尾多做了一件真正有判别力的事，两头发：
 * ① **改动 fake 让它违约**（`pull` 只看不取、`pull` 倒序、无视 `canAct`、`send` 静默丢），
 *    看清单**是否恰好红在管那一维的那一发上**。红对了 ⇒ 那几发确实在守契约，
 *    不是在配合某个 fake 的偶然行为变绿；不红 ⇒ 「换实现也过」这句话是假的。
 * ② **每个旋钮在两个 fake 上都必须真的改变行为**。一个只在 A 上生效、在 B 上被无视的
 *    旋钮，会让「B 那一节也绿」变成假的（B 跑的其实是另一件事）—— 那正是
 *    `supportsActionReturn` 在源码里一度变成装饰的同一个形状，只是发生在夹具这一侧。
 * ⚠ 这两招能测到的仍然只有【fake 能表达的违约】。测不到「飞书给的字段比接口多」。
 *
 * ── 为什么断言写成【清单】而不是两组 it() ────────────────────────────
 * 两个 fake 各写一遍 it() 会漂移（改一处忘另一处），而漂移方向恰好是本篇最怕的那种：
 * 「A 有这条断言、B 没有」在满屏绿灯里看不出来。清单只有一份 `CASES`，
 * 于是「少跑一个 fake」会变成「那一节整体少 N 发」这种在报告上**数得出来**的形状。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACTION_KEY_SEP,
  ACTION_RETURN_HINT,
  boundedPush,
  channelActionKey,
  channelIneligibleReason,
  createChannelRuntime,
  deliverCard,
  encodeCardAction,
  IRREVERSIBLE_HINT,
  outboundCardOf,
  parseCardAction,
  parseParametersObject,
  shutdownChannels,
  type CardAction,
  type Channel,
  type ChannelActRequest,
  type ChannelActVerdict,
  type ChannelActor,
  type ChannelCardSnapshot,
  type ChannelEnvelope,
  type ChannelPollRound,
  type ChannelRuntime,
  type NormalizedMessageKind,
  type OutboundApprovalCard,
} from "../../src/channels/abstraction.js";
import { APPROVAL_BUTTONS } from "@opc/contracts";

const T0 = 1_700_000_000_000;

/* ================================================================== *
 * 两个 fake
 * ================================================================== */

/** 两个 fake 的公共旋钮。名字必须一致（末尾那节元测试就是钉这件事的）。 */
interface FakeOpts {
  readonly id?: string;
  readonly supportsActionReturn?: boolean;
  /** 不给 = 不实现 `canAct`（【规格】§11.2 那种没有平台级限制的通道）。 */
  readonly canAct?: ChannelActVerdict;
  readonly sendThrows?: boolean;
  readonly pullThrows?: boolean;
  readonly closeThrows?: boolean;
  /** 内部队列上限。默认用抽象层那个数，只有溢出那几发故意调小。 */
  readonly queueLimit?: number;
}

/** 可以覆盖的入站字段（`kind` 单独传，避免 Partial 铺开成一堆 `| undefined`）。 */
interface MsgOver {
  readonly senderId?: string;
  readonly conversationId?: string;
  readonly text?: string;
  readonly atBot?: boolean;
  readonly deliveryId?: string | null;
}

interface FakeHandle {
  readonly channel: Channel;
  readonly sent: OutboundApprovalCard[];
  readonly closed: { n: number };
  readonly overflowed: ChannelEnvelope[];
  /** 投一条消息进适配器的**内部**队列（模拟平台推过来）。 */
  inject(kind: NormalizedMessageKind, over?: MsgOver): ChannelEnvelope;
  /** 投一次卡片点击。编码走的是**发送侧同一个** `encodeCardAction`。 */
  injectAction(action: CardAction, over?: MsgOver): ChannelEnvelope;
  /** 还在队列里的条数。「pollAll 之后必须是 0」那一发靠它。 */
  queued(): number;
  /** 旋钮可在用例中途改（「同一个人先被通道拒后被允许」那一发要）。 */
  setCanAct(v: ChannelActVerdict | undefined): void;
}

type Act = ChannelActVerdict | undefined;
type ChannelWithAct = Channel & { canAct?: (a: ChannelActor) => ChannelActVerdict };

function msgOf(
  channelId: string,
  kind: NormalizedMessageKind,
  over: MsgOver,
): NormalizedMessageLike {
  return {
    channelId,
    platform: "fake",
    senderId: over.senderId ?? "u-1",
    conversationId: over.conversationId ?? "c-1",
    text: over.text ?? "",
    atBot: over.atBot ?? false,
    kind,
  };
}

/** 只是给上面那个工厂一个名字，免得 `NormalizedMessage` 这个类型名在两个 fake 里各 import 一遍写法不同。 */
type NormalizedMessageLike = ChannelEnvelope["message"];

/**
 * fake A —— 队列型：一个数组当内部队列，`pull()` **整段换出**（`splice` 一把）。
 * `canAct` 是**闭包**读一个可变变量。
 */
function makeQueueFake(o: FakeOpts = {}): FakeHandle {
  const sent: OutboundApprovalCard[] = [];
  const closed = { n: 0 };
  const overflowed: ChannelEnvelope[] = [];
  const limit = o.queueLimit ?? 256;
  let queue: ChannelEnvelope[] = [];
  let canAct: Act = o.canAct;
  let seq = 0;
  const channel: ChannelWithAct = {
    id: o.id ?? "fake-a",
    platform: "fake",
    async start(): Promise<void> {},
    async close(): Promise<void> {
      if (o.closeThrows === true) throw new Error("close 失败");
      closed.n += 1;
    },
    pull(): readonly ChannelEnvelope[] {
      if (o.pullThrows === true) throw new Error("fetch 抛错");
      // 取走即移除，且保序（契约要求先进先出）。
      return queue.splice(0, queue.length);
    },
    async send(card: OutboundApprovalCard): Promise<void> {
      if (o.sendThrows === true) throw new Error("推送被平台拒了");
      sent.push(card);
    },
    supportsActionReturn: o.supportsActionReturn ?? true,
  };
  const arm = (v: Act): void => {
    canAct = v;
    if (v === undefined) delete channel.canAct;
    else channel.canAct = () => (canAct === undefined ? { ok: true } : canAct);
  };
  arm(canAct);
  const handle: FakeHandle = {
    channel,
    sent,
    closed,
    overflowed,
    queued: () => queue.length,
    setCanAct: arm,
    inject(kind, over = {}) {
      const e: ChannelEnvelope = {
        message: msgOf(channel.id, kind, over),
        // 每条一个不同的到达时刻：「在路上走了多久」那一发要看它能不能穿过边界。
        receivedAtMs: T0 + ++seq,
        deliveryId: over.deliveryId === undefined ? "d-" + seq : over.deliveryId,
      };
      boundedPush(queue, e, (d) => overflowed.push(d), limit);
      return e;
    },
    injectAction(action, over = {}) {
      return handle.inject("card_action", { text: encodeCardAction(action), ...over });
    },
  };
  return handle;
}

/**
 * fake B —— 分批型：**完全不同的实现**，不是给 A 换个名字。
 *
 * 与 A 的真实差别：内部是「一段一段的批次」（模拟长连接每次回调 append 一段），
 * `pull()` 逐个 `shift` 而不是 `splice`，溢出检查**跨批次**做（队列是二维的），
 * `canAct` 写成**方法**，`send` 序列化再解回来（不走同一条对象引用），
 * 而且**拿不到平台投递 id**（`deliveryId: null`，有些平台确实不给）——
 * 最后这一条是有意的：它逼着幂等判据落在 `channelActionKey` 而不是 `deliveryId` 上，
 * 于是「只用 deliveryId 去重」那种写法会在 B 这一节当场塌掉。
 */
function makeBatchFake(o: FakeOpts = {}): FakeHandle {
  const batches: ChannelEnvelope[][] = [];
  const sent: OutboundApprovalCard[] = [];
  const closed = { n: 0 };
  const overflowed: ChannelEnvelope[] = [];
  const limit = o.queueLimit ?? 256;
  let seq = 0;
  let verdict: Act = o.canAct;
  const channel: ChannelWithAct = {
    id: o.id ?? "fake-b",
    platform: "fake",
    async start(): Promise<void> {},
    async close(): Promise<void> {
      if (o.closeThrows === true) throw new Error("关不掉");
      closed.n += 1;
    },
    pull(): readonly ChannelEnvelope[] {
      if (o.pullThrows === true) throw new Error("长连接断了");
      const out: ChannelEnvelope[] = [];
      for (;;) {
        const head = batches[0];
        if (head === undefined) break;
        const e = head.shift();
        if (e === undefined) {
          batches.shift();
          continue;
        }
        out.push(e);
      }
      return out;
    },
    async send(card: OutboundApprovalCard): Promise<void> {
      if (o.sendThrows === true) throw new Error("403");
      const raw = JSON.stringify(card);
      sent.push(JSON.parse(raw) as OutboundApprovalCard);
    },
    supportsActionReturn: o.supportsActionReturn ?? true,
  };
  const arm = (v: Act): void => {
    verdict = v;
    if (v === undefined) delete channel.canAct;
    else
      channel.canAct = (): ChannelActVerdict => (verdict === undefined ? { ok: true } : verdict);
  };
  arm(o.canAct);
  const handle: FakeHandle = {
    channel,
    sent,
    closed,
    overflowed,
    queued: () => batches.reduce((n, b) => n + b.length, 0),
    setCanAct: arm,
    inject(kind, over = {}) {
      const e: ChannelEnvelope = {
        message: msgOf(channel.id, kind, over),
        receivedAtMs: T0 + ++seq,
        deliveryId: over.deliveryId ?? null,
      };
      const tail = batches[batches.length - 1];
      if (tail === undefined || tail.length >= 4) batches.push([]);
      (batches[batches.length - 1] as ChannelEnvelope[]).push(e);
      // B 的溢出跨批次算（A 是平坦数组，这是两处 fake 之间一处真实的实现差异）。
      for (;;) {
        let total = 0;
        for (const b of batches) total += b.length;
        if (total <= limit) break;
        const head = batches[0];
        const dropped = head?.shift();
        if (head !== undefined && head.length === 0) batches.shift();
        if (dropped === undefined) break;
        overflowed.push(dropped);
      }
      return e;
    },
    injectAction(action, over = {}) {
      return handle.inject("card_action", { text: encodeCardAction(action), ...over });
    },
  };
  return handle;
}

type MakeFake = (o?: FakeOpts) => FakeHandle;

const FAKES: readonly (readonly [string, MakeFake])[] = [
  ["队列型 fake A", makeQueueFake],
  ["分批型 fake B", makeBatchFake],
];

/* ================================================================== *
 * 运行时夹具
 * ================================================================== */

/**
 * 一张【可逆】的卡。默认值必须偏「可逆」，理由与 tokens.test.ts 同一条：
 * 否则每一发「点击成功」的用例都会先撞上 §11.4 那一挡，成功那一格根本没被执行过。
 */
function snap(over: Partial<ChannelCardSnapshot> = {}): ChannelCardSnapshot {
  return {
    approvalId: "a-1",
    taskId: "t-1",
    summary: "要不要给这个任务追加 200 美元预算",
    approvalType: "budget_override",
    status: "pending",
    parametersJson: '{"irreversible": false, "impact_scope": "staging"}',
    evidenceRefs: null,
    recommendation: "建议批准",
    timeoutBehavior: "auto_reject",
    ...over,
  };
}

type ActResult = { readonly ok: true; readonly replayed?: boolean } | { readonly ok: false; readonly why: string };

interface RuntimeHandle {
  readonly rt: ChannelRuntime;
  readonly cards: Map<string, ChannelCardSnapshot>;
  /** act 的**每一次**调用（含随后抛错/失败的那几次）。0 = 什么都没落成。 */
  readonly calls: ChannelActRequest[];
  readonly loadCalls: string[];
  readonly fake: FakeHandle;
  throwNextAct(): void;
  failNextAct(why: string): void;
}

function runtime(
  make: MakeFake,
  o: {
    readonly cards?: readonly ChannelCardSnapshot[];
    /** false = 不注入 `actorFor`，也就是【默认拒绝】那条路径。 */
    readonly authorized?: boolean;
    readonly withAct?: boolean;
    readonly fake?: FakeOpts;
    readonly actResult?: (req: ChannelActRequest) => ActResult;
  } = {},
): RuntimeHandle {
  const cards = new Map<string, ChannelCardSnapshot>();
  for (const c of o.cards ?? [snap()]) cards.set(c.approvalId, c);
  const calls: ChannelActRequest[] = [];
  const loadCalls: string[] = [];
  let failWhy: string | null = null;
  let doThrow = false;
  const rt = createChannelRuntime({
    deps: {
      now: () => T0,
      loadCard(id: string): ChannelCardSnapshot | null {
        loadCalls.push(id);
        return cards.get(id) ?? null;
      },
      ...(o.withAct === false
        ? {}
        : {
            act(req: ChannelActRequest): ActResult {
              calls.push(req);
              if (doThrow) {
                doThrow = false;
                throw new Error("SQLITE_BUSY");
              }
              if (failWhy !== null) {
                const why = failWhy;
                failWhy = null;
                return { ok: false, why };
              }
              return o.actResult === undefined ? { ok: true } : o.actResult(req);
            },
          }),
    },
    ...(o.authorized === false
      ? {}
      : {
          actorFor: (a: ChannelActor): ChannelActor => ({
            senderId: a.senderId,
            channelId: a.channelId,
          }),
        }),
  });
  const fake = make(o.fake);
  rt.register(fake.channel);
  return {
    rt,
    cards,
    calls,
    loadCalls,
    fake,
    throwNextAct: () => {
      doThrow = true;
    },
    failNextAct: (why: string) => {
      failWhy = why;
    },
  };
}

const CLICK: CardAction = { approvalId: "a-1", resume: "approve" };

/** 跑一轮 pollAll，取那条通道的判决种类。 */
async function verdictsOf(h: RuntimeHandle): Promise<string[]> {
  const rounds: readonly ChannelPollRound[] = await h.rt.pollAll();
  expect(rounds.length).toBe(1);
  const round = rounds[0] as ChannelPollRound;
  // 每一轮都自报这两个数相等，于是「取走了却没判决」在**任何**用例里都会当场红，
  // 而不只在专门测它的那一发里红。
  expect(round.handled.length).toBe(round.got);
  return round.handled.map((x) => x.verdict.kind);
}

/** 跑一轮取【唯一】那条判决（要看 kind 之外的字段时用）。 */
async function oneRound(h: RuntimeHandle): Promise<ChannelPollRound> {
  const rounds: readonly ChannelPollRound[] = await h.rt.pollAll();
  expect(rounds.length).toBe(1);
  return rounds[0] as ChannelPollRound;
}

interface Case {
  readonly name: string;
  readonly run: (make: MakeFake) => void | Promise<void>;
}

/**
 * 判据的**分层顺序**写在 abstraction.ts 的 handleOne 里，每格都有注释讲清「放错位置会怎样」。
 * 本清单的发序就是那个顺序：① 是不是动作 → ② 身份 → ③ 通道许可 → ④ 幂等 →
 * ⑤ 卡片状态与可逆性 → ⑥ 落库。每格尽量配一发「**放错位置就红**」的断言
 * （典型手法：同一件事做两次，第一次被拒、第二次必须仍算数），
 * 而不是只测「这一格能挡住」—— 后者对顺序错完全无感。
 */
const CASES: readonly Case[] = [
  {
    name: "普通文本消息 ⇒ 不处理，且【不报错】、不进幂等表、不碰库",
    run: async (make) => {
      const h = runtime(make);
      h.fake.inject("text", { text: "今天开会吗", atBot: true });
      const round = await oneRound(h);
      expect(round.handled.map((x) => x.verdict.kind)).toEqual(["ignored_not_action"]);
      // 「不报错」的具体形态：没有 failed，没有键，没有库读。
      expect(h.rt.seenCount()).toBe(0);
      expect(h.loadCalls).toEqual([]);
      expect(h.calls).toEqual([]);
    },
  },
  {
    name: "⭐ 未授权 ⇒ 拒，且【连库都没读】（身份在任何库读之前）",
    run: async (make) => {
      const h = runtime(make, { authorized: false });
      h.fake.injectAction(CLICK);
      expect(await verdictsOf(h)).toEqual(["unauthorized"]);
      // 这一发盯的是【顺序】而不是结果：把鉴权挪到 loadCard 之后，判决仍是
      // unauthorized（一模一样绿），而任何拿到卡片 id 的人都能让 Hub 为每次点击
      // 做一次库读。只有断言 loadCalls 才挡得住那个写法。
      expect(h.loadCalls).toEqual([]);
      expect(h.calls).toEqual([]);
    },
  },
  {
    name: "⭐ canAct 说不行 ⇒ 通道拒；而【键没被占住】，撤掉限制后同一次点击仍算数",
    run: async (make) => {
      // 【规格】§11.2：QQ 是只读通道。而这张卡【可逆】—— 也就是说
      // 「逐条判可逆」那一条会放行它，只有通道级判据挡得住。
      const h = runtime(make, { fake: { canAct: { ok: false, reason: "本通道只读" } } });
      h.fake.injectAction(CLICK);
      expect(await verdictsOf(h)).toEqual(["channel_refused"]);
      expect(h.calls).toEqual([]);
      // 第二半才是这一发的正文：撤掉通道限制，**同一次点击**必须能落成。
      // canAct 若放在记键之后，这里会是 duplicate ⇒ 他的决定被吞掉，
      // 而他看到的是「已经处理过了」。QQ 只读 + 飞书可批正是会同时存在的配置。
      h.fake.setCanAct(undefined);
      h.fake.injectAction(CLICK);
      expect(await verdictsOf(h)).toEqual(["acted"]);
      expect(h.calls.length).toBe(1);
    },
  },
  {
    name: "⭐ 同一次点击投递两次 ⇒ 恰好落一次（平台重投与自己重试共用一层）",
    run: async (make) => {
      // A 给两条不同的 deliveryId，B 两条都是 null（那个平台拿不到）——
      // 两种都必须挡住，因为幂等【不许】建立在 deliveryId 上（没有它整条判据消失）。
      const h = runtime(make);
      h.fake.injectAction(CLICK, { deliveryId: "same" });
      h.fake.injectAction(CLICK, { deliveryId: "same" });
      expect(await verdictsOf(h)).toEqual(["acted", "duplicate"]);
      expect(h.calls.length).toBe(1);
    },
  },
  {
    name: "⭐ 落库抛错 ⇒ 键【还回去】，重试能落成（一次抖动不许永久吃掉一个决定）",
    run: async (make) => {
      const h = runtime(make);
      h.fake.injectAction(CLICK);
      h.throwNextAct();
      expect(await verdictsOf(h)).toEqual(["failed"]);
      // 撤销那把键是 handleOne 里最不直观的一格，这一发就是它的守卫：
      // 键没还 ⇒ 下面这发变 duplicate ⇒ 决定永久丢失，症状是「点了说处理过了」。
      expect(h.rt.seenCount()).toBe(0);
      h.fake.injectAction(CLICK);
      expect(await verdictsOf(h)).toEqual(["acted"]);
      expect(h.calls.length).toBe(2);
    },
  },
  {
    name: "⭐ act 返回业务失败 ⇒ 同样还键（抛错与 ok:false 必须同处理）",
    run: async (make) => {
      const h = runtime(make);
      h.fake.injectAction(CLICK);
      h.failNextAct("并发下没抢到");
      expect(await verdictsOf(h)).toEqual(["failed"]);
      expect(h.rt.seenCount()).toBe(0);
      h.fake.injectAction(CLICK);
      expect(await verdictsOf(h)).toEqual(["acted"]);
    },
  },
  {
    name: "装配忘记注入 act ⇒ failed，而键【不留】",
    run: async (make) => {
      // 价值全在第二半：装配错误的后果不该由 CEO 承担。不删键的话，
      // 「忘记注入 act」这个纯装配问题会让修好之前那一次点击被永久吃掉。
      const h = runtime(make, { withAct: false });
      h.fake.injectAction(CLICK);
      expect(await verdictsOf(h)).toEqual(["failed"]);
      expect(h.rt.seenCount()).toBe(0);
    },
  },
  {
    name: "⭐ 卡片不存在 ⇒ card_missing 且【不记键】（延迟建卡之后那次点击仍算数）",
    run: async (make) => {
      const h = runtime(make, { cards: [] });
      h.fake.injectAction(CLICK);
      expect(await verdictsOf(h)).toEqual(["card_missing"]);
      expect(h.rt.seenCount()).toBe(0);
      h.cards.set("a-1", snap());
      h.fake.injectAction(CLICK);
      expect(await verdictsOf(h)).toEqual(["acted"]);
    },
  },
  {
    name: "⭐ 卡片已决策 ⇒ card_decided，与 card_missing 【分开】",
    run: async (make) => {
      // 两格合成一发的写法短两行，而界面只能说「找不到这张卡」。
      // 用户看到的是【一张他从没见过的卡片消失了】，真相是【这张卡已经被批过了】——
      // 前者该去查同步延迟，后者该安心。tokens.ts 那边同口径（404 与 409 分开）。
      const h = runtime(make, { cards: [snap({ status: "approved" })] });
      h.fake.injectAction(CLICK);
      const round = await oneRound(h);
      const v = round.handled[0]?.verdict;
      expect(v?.kind).toBe("card_decided");
      expect(v && v.kind === "card_decided" ? v.status : null).toBe("approved");
      expect(h.calls).toEqual([]);
    },
  },
  {
    name: "⭐ 不可逆的卡 ⇒ not_actionable，而文案说清【去哪做】",
    run: async (make) => {
      const h = runtime(make, { cards: [snap({ parametersJson: '{"irreversible": true}' })] });
      h.fake.injectAction(CLICK);
      const round = await oneRound(h);
      const v = round.handled[0]?.verdict;
      expect(v?.kind).toBe("not_actionable");
      // 只说「不允许」会让人点第二遍、第三遍，然后把卡片丢掉 ——
      // 那一格的后果不是报错，是【这张卡永远没人处理】。
      expect(v && v.kind === "not_actionable" ? v.reason : "").toBe(IRREVERSIBLE_HINT);
      expect(IRREVERSIBLE_HINT).toMatch(/桌面端/u);
      expect(h.calls).toEqual([]);
    },
  },
  {
    name: "⭐ parameters 是脏 JSON ⇒ 同样 not_actionable（判不出 ⇒ 多挡，穿过通道边界仍然成立）",
    run: async (make) => {
      // 这一发是 `ChannelCardSnapshot` 带【原始 JSON 文本】而不是解析后对象的唯一守卫。
      // 换成对象的话，「解析失败」在边界上已被抹平成 `{}`，而 `{}` 看上去像「可逆」——
      // 那一刻一条脏 JSON 恰好给最危险的那张卡开出 IM 通道，且零报错。
      const h = runtime(make, { cards: [snap({ parametersJson: "{不是 JSON" })] });
      h.fake.injectAction(CLICK);
      expect(await verdictsOf(h)).toEqual(["not_actionable"]);
      expect(h.calls).toEqual([]);
      // 反向对照：干净的可逆参数必须放行，否则上面那条只是「恒拒」。
      const ok = runtime(make);
      ok.fake.injectAction(CLICK);
      expect(await verdictsOf(ok)).toEqual(["acted"]);
    },
  },
  {
    name: "⭐ pollAll 取走的【每一条】都必须被判决（数量正确的销毁证明不算过）",
    run: async (make) => {
      const h = runtime(make, {
        cards: [
          snap({ approvalId: "a-1" }),
          snap({ approvalId: "a-2" }),
          snap({ approvalId: "a-3" }),
        ],
      });
      h.fake.injectAction({ approvalId: "a-1", resume: "approve" });
      h.fake.injectAction({ approvalId: "a-2", resume: "reject_with_comment", note: "先看成本" });
      h.fake.injectAction({ approvalId: "a-3", resume: "defer_deep_review" });
      const round = await oneRound(h);
      // 三个数一起看才杀得掉那一发坏写法（`got: c.pull().length`，取走又不处理）：
      // got 与 handled.length 单独看都自洽，队列清空才证明「取走」这件事真的发生了。
      expect(round.got).toBe(3);
      expect(round.handled.length).toBe(3);
      expect(h.fake.queued()).toBe(0);
      expect(round.handled.map((x) => (x.verdict.kind === "acted" ? x.verdict.approvalId : "?"))).toEqual([
        "a-1",
        "a-2",
        "a-3",
      ]);
      expect(h.calls.map((c) => c.approvalId)).toEqual(["a-1", "a-2", "a-3"]);
      expect(h.calls.map((c) => c.resume)).toEqual(["approve", "reject_with_comment", "defer_deep_review"]);
      // note 也必须穿过边界（reject 无理由 = 产出方拿到「被拒了，为什么不知道」）。
      expect(h.calls[1]?.note).toBe("先看成本");
    },
  },
  {
    name: "⭐ pull 必须按【到达顺序】交出（清单靠顺序断言，乱序会红）",
    run: async (make) => {
      const h = runtime(make, {
        cards: [snap({ approvalId: "a-1" }), snap({ approvalId: "a-2" })],
      });
      h.fake.injectAction({ approvalId: "a-1", resume: "approve" });
      h.fake.injectAction({ approvalId: "a-2", resume: "approve" });
      // 这一发同时在钉 fake 自己：下面那个违约实验（pull 倒序）红的就是这一发，
      // 而它红在【fake 违约】而不是【判据有洞】上 —— 那正是清单可信的证据。
      expect(await verdictsOf(h)).toEqual(["acted", "acted"]);
      expect(h.calls.map((c) => c.approvalId)).toEqual(["a-1", "a-2"]);
    },
  },
  {
    name: "⭐ 一条通道 pull 抛错 ⇒ 另一条照常处理（坏通道不许带走好通道）",
    run: async (make) => {
      const h = runtime(make, { fake: { pullThrows: true, id: "broken" } });
      const healthy = make({ id: "healthy" });
      h.rt.register(healthy.channel);
      healthy.injectAction(CLICK);
      const rounds = await h.rt.pollAll();
      expect(rounds.length).toBe(2);
      const broken = rounds.find((r) => r.channelId === "broken");
      const fine = rounds.find((r) => r.channelId === "healthy");
      // 0 与「坏了」必须是两个事实：合成一个（只报 got: 0）之后，
      // 巡检日志里「本轮 0 条」与「这个通道炸了」长得一模一样。
      expect(broken?.failedOpen).toBe(true);
      expect(fine?.failedOpen).toBe(false);
      expect(fine?.handled.map((x) => x.verdict.kind)).toEqual(["acted"]);
    },
  },
  {
    name: "⭐ receivedAtMs 原样送到 act（离线/积压的「在路上走了多久」不许被时钟顶掉）",
    run: async (make) => {
      const h = runtime(make);
      const e = h.fake.injectAction(CLICK);
      // 这里自己取 Date.now() 的话，队列积压与离线重投都会被打成「刚刚到达」，
      // 而计划 Task 4.4 那句「离线期间到达的回调…不得静默吞掉审批」在代码上无处可表。
      await h.rt.handleInbound(h.fake.channel, { ...e, receivedAtMs: e.receivedAtMs + 86_400_000 });
      expect(h.calls[0]?.receivedAtMs).toBe(e.receivedAtMs + 86_400_000);
    },
  },
  {
    name: "⭐ 幂等键对分隔符注入免疫（用可打印字符能被拼出同一个键）",
    run: async (make) => {
      // 两条消息的字段里带 `|`。如果键是用 `|` join 出来的，二者会撞成同一个键，
      // 后果是**第二次的决定被当成重复而吞掉**（不报错）。
      const h = runtime(make, { cards: [snap({ approvalId: "a-1" }), snap({ approvalId: "a-2" })] });
      h.fake.injectAction({ approvalId: "a-1", resume: "approve" }, { conversationId: "x|y", senderId: "z" });
      h.fake.injectAction({ approvalId: "a-2", resume: "approve" }, { conversationId: "x", senderId: "y|z" });
      const round = await oneRound(h);
      expect(round.handled.map((x) => x.verdict.kind)).toEqual(["acted", "acted"]);
      // 只测行为的话，「两条恰好因为 approvalId 不同而没撞」会溜过去，所以直接钉键本身：
      // 下面这两条除了拼接方式之外**完全等价**，撞键的写法会让它们相等。
      const key = (senderId: string, conversationId: string): string =>
        channelActionKey(
          {
            message: { channelId: "c", platform: "fake", senderId, conversationId, text: "", atBot: false, kind: "card_action" },
            receivedAtMs: T0,
            deliveryId: null,
          },
          { approvalId: "a", resume: "approve" },
        );
      expect(key("y|z", "x")).not.toBe(key("z", "x|y"));
      // 反向：键里用的必须真是那个不可打印分隔符，而且是 5 段（少一段就是少一个维度）。
      expect(key("s", "c").split(ACTION_KEY_SEP).length).toBe(5);
    },
  },
  {
    name: "⭐ 畸形 card_action 载荷 ⇒ failed 而【不抛】（一条坏消息不许带走整轮 poll）",
    run: async (make) => {
      const h = runtime(make);
      h.fake.inject("card_action", { text: "a-1|不是按钮值" });
      h.fake.injectAction(CLICK);
      const round = await oneRound(h);
      expect(round.handled.map((x) => x.verdict.kind)).toEqual(["failed", "acted"]);
      expect(round.failedOpen).toBe(false);
      expect(h.calls.length).toBe(1);
    },
  },
  {
    name: "note 里带分隔符也取得回来（发送侧与接收侧共用同一个编码器）",
    run: async (make) => {
      const note = "先跟财务对一下|然后走 B 方案";
      const h = runtime(make);
      h.fake.injectAction({ approvalId: "a-1", resume: "reject_with_comment", note });
      expect(await verdictsOf(h)).toEqual(["acted"]);
      expect(h.calls[0]?.note).toBe(note);
    },
  },
  {
    name: "⭐ act 的 replayed 必须传出去（抢输了一次不是失败，也不是第二次决定）",
    run: async (make) => {
      // 顺手钉掉一个可能的装饰字段：运行时若把 replayed 吞了，上面所有断言照绿，
      // 而界面会把「别人已经批了」报成一次失败。
      const h = runtime(make, { actResult: () => ({ ok: true, replayed: true }) });
      h.fake.injectAction(CLICK);
      const round = await oneRound(h);
      const v = round.handled[0]?.verdict;
      expect(v?.kind).toBe("acted");
      expect(v && v.kind === "acted" ? v.replayed : null).toBe(true);
    },
  },
  {
    name: "⭐ 两个【不同实例】抢同一个 id ⇒ 抛；同一实例重复注册 ⇒ 放行",
    run: (make) => {
      const h = runtime(make, { fake: { id: "dup" } });
      // 覆盖成法的后果是「安静的孤儿连接」：先那个通道的长连接还活着而没人取它的消息。
      expect(() => h.rt.register(make({ id: "dup" }).channel)).toThrow(/id 冲突/u);
      // 同对象放行不是随手加的宽松：热重载与测试装配都拿同一实例注册两次，
      // 那种情况造不出孤儿。判据要精确命中坏形状（**不同**实例抢同一 id）。
      const first = h.fake.channel;
      expect(() => h.rt.register(first)).not.toThrow();
      expect(h.rt.channels().length).toBe(1);
    },
  },
  {
    name: "⭐ shutdownChannels：一个关不掉不许带走其余（关机后还有连接在收消息）",
    async run(make) {
      const bad = make({ closeThrows: true, id: "bad" });
      const good = make({ id: "good" });
      const failed = await shutdownChannels([bad.channel, good.channel]);
      expect(failed).toEqual(["bad"]);
      // 坏的那个没被当成关掉（否则「已经全部关停」这句话是假的）。
      expect(bad.closed.n).toBe(0);
      expect(good.closed.n).toBe(1);
      // 幂等：重复关停不抛，否则退避重试会先把关停流程炸掉。
      expect(await shutdownChannels([good.channel])).toEqual([]);
      expect(good.closed.n).toBe(2);
    },
  },
  {
    name: "⭐ 出站卡片：三行 + 三按钮齐全，而 evidenceRefs 的 null 与 [] 不是一回事",
    run: () => {
      const card = outboundCardOf(snap({ evidenceRefs: null }));
      // 按钮不是调用方传进来的：让调用方传就会出现「卡片上只有两个按钮」这种
      // 能编译也能发出去的东西，而 §9.2 那句「三按钮」就只剩注释在守。
      expect(card.buttons).toBe(APPROVAL_BUTTONS);
      expect(card.summary.length).toBeGreaterThan(0);
      expect(card.actionable).toBe(true);
      // 可批的时候【整个键不存在】而不是 `reason: undefined`（exactOptionalPropertyTypes）。
      expect("notActionableReason" in card).toBe(false);
      // null = 我们没存「这张卡靠哪份证据建」那条边；[] = 存了，确实没有。
      // 抹平成 [] 会渲染出「证据：无」，那是把【系统的缺口】说成【产出方没交东西】，
      // 而后者会被当成一次追责依据。
      expect(card.evidenceRefs).toBeNull();
      expect(outboundCardOf(snap({ evidenceRefs: [] })).evidenceRefs).toEqual([]);
      // 参数解析失败只影响渲染，不影响可批性判据（两次解析不会漂出安全问题）。
      expect(parseParametersObject("{坏")).toBeNull();
      expect(parseParametersObject("[1,2]")).toBeNull();
      expect(parseParametersObject(null)).toBeNull();
      expect(outboundCardOf(snap({ parametersJson: "{坏" })).parameters).toBeNull();
    },
  },
  {
    name: "⭐ 收不到回传的通道 ⇒ 卡片降级成只读，而【不是干脆不发】",
    run: async (make) => {
      const fake = make({ supportsActionReturn: false });
      const r = await deliverCard(fake.channel, snap());
      expect(r.kind).toBe("sent");
      const card = r.kind === "sent" ? r.card : null;
      expect(card?.actionable).toBe(false);
      expect(card?.notActionableReason).toBe(ACTION_RETURN_HINT);
      // 三行三按钮不能因为只读就少：不发的那张卡在主界面上是【不存在】，
      // 而 CEO 需要看到的是「这件事在等你，只是不能在这里点」。
      expect(card?.buttons).toBe(APPROVAL_BUTTONS);
      expect(fake.sent.length).toBe(1);
    },
  },
  {
    name: "⭐ deliverCard 不许盖掉更强的理由（不可逆 > 收不到回传）",
    async run(make) {
      const ro = make({ supportsActionReturn: false }).channel;
      const bad = snap({ parametersJson: '{"irreversible": true}' });
      // 先单独钉住「这条卡本身就已经不可批」，否则下面那条断言可能只是在比两条 null。
      expect(channelIneligibleReason(bad)).toBe(IRREVERSIBLE_HINT);
      // 两条理由同时成立时报哪一条，取决于【哪条是真约束】而不取决于实现顺序：
      // 报「这个通道收不到回传」会把人支到桌面端**再点一次**，
      // 而那张卡在桌面端也不能一键批。
      const r = await deliverCard(ro, bad);
      const card = r.kind === "sent" ? r.card : null;
      expect(card?.actionable).toBe(false);
      expect(card?.notActionableReason).toBe(IRREVERSIBLE_HINT);
    },
  },
  {
    name: "⭐ 发送失败报成判决而【不抛】（抛出会带走那一轮剩下的卡片）",
    run: async (make) => {
      const fake = make({ sendThrows: true });
      const r = await deliverCard(fake.channel, snap());
      expect(r.kind).toBe("send_failed");
      // 只断言「带回了一句人话」而**不断言内容**：两个 fake 抛的是不同的错
      // （A 抛「推送被平台拒了」，B 抛「403」），写死任何一边都会让这一发
      // 变成「只有那个 fake 能过」的假守卫 —— 那正是本文件最怕的形状。
      // 内容那一维由旋钮自检那节管（它逐 fake 检查 sendThrows 确实改变了结果）。
      expect(r.kind === "send_failed" ? r.why.length : 0).toBeGreaterThan(0);
      expect(fake.sent).toEqual([]);
      // 卡片在库里仍是 pending，而调用方拿到了一个可以重试/告警的值 ——
      // 抛出去的话，那一轮剩下的卡片全发不出去（同 pollAll 那条「一条坏通道带走全部」）。
    },
  },
  {
    name: "适配器队列溢出 ⇒ 丢最老的，而【必须留下计数】（静默丢弃 = 静默吞掉审批）",
    run: (make) => {
      const fake = make({ queueLimit: 2 });
      fake.injectAction({ approvalId: "a-1", resume: "approve" });
      fake.injectAction({ approvalId: "a-2", resume: "approve" });
      fake.injectAction({ approvalId: "a-3", resume: "approve" });
      expect(fake.queued()).toBe(2);
      // 有计数是这一格唯一的要求；丢哪一条是可争议的取舍（见 boundedPush 上面那段）。
      expect(fake.overflowed.length).toBe(1);
      expect(fake.overflowed[0]?.message.text).toBe("a-1|approve");
    },
  },
  {
    name: "parseCardAction 的取舍：多余段并进 note，缺段/未知取值 ⇒ null 而【不抛】",
    run: () => {
      const base = { channelId: "c", platform: "fake", senderId: "s", conversationId: "x", atBot: false, kind: "card_action" } as const;
      const parse = (text: string) => parseCardAction({ ...base, text });
      expect(parse("a-1|approve")).toEqual({ approvalId: "a-1", resume: "approve" });
      expect(parse("a-1|approve|备注一|备注二")?.note).toBe("备注一|备注二");
      // 未知取值 ⇒ null。这一档挡住的是「平台回传了一个我们没定义的按钮」，
      // 那种情况判成 approve 与判成 reject 都是编造，只能判成「不认识」。
      expect(parse("a-1|approve_all")).toBeNull();
      expect(parse("|approve")).toBeNull();
      expect(parse("只有半截")).toBeNull();
      expect(parse("a-1|")).toBeNull();
      // 编解码成对：只测解码的话，编码器改坏了（少写一段）测试仍然绿。
      expect(parseCardAction({ ...base, text: encodeCardAction({ approvalId: "a", resume: "defer_deep_review" }) })).toEqual({
        approvalId: "a",
        resume: "defer_deep_review",
      });
    },
  },
  {
    name: "⭐ 运行时【不自己造身份】：actorFor 只拿到消息里那两个字段",
    run: (make) => {
      // 这一发的起因是【一处我写错的事实】：我原本在 ChannelActor 上面写道
      // 「IM 账号 → 角色的绑定表今天不存在」。实测**表在**
      // resources/migrations/0001_init.sql 的 im_bindings，只是**全仓读写方 0 处**。
      // 而那张表带着一个陷阱：`ceo_role TEXT NOT NULL DEFAULT 'ceo'` 配
      // `verified INTEGER DEFAULT 0` —— 「把 actorFor 直接接到那张表上」这一行代码
      // 今天会造出「谁替人插一行绑定，那个账号默认就是 CEO，而有没有验过不看」。
      // 那一发在所有测试里都绿，因为 fake 的假定正是「这个人就是 CEO」。
      //
      // 本层不碰库，所以这里**不去测那张表**（那是装配方的责任），只钉住本层
      // 能负责的那一半：**运行时绝不自己造身份**，穿过去的只有消息里那两个字段。
      const seen: ChannelActor[] = [];
      const rt = createChannelRuntime({
        deps: { now: () => T0, loadCard: () => snap() },
        actorFor: (a) => {
          seen.push(a);
          return { senderId: a.senderId, channelId: a.channelId };
        },
      });
      const fake = make({ id: "who" });
      rt.register(fake.channel);
      fake.injectAction(CLICK, { senderId: "ext-88", conversationId: "conv-7" });
      return rt.pollAll().then(() => {
        // 变异跑过：把 actorFor 的入参换成任何常量（含 `'ceo'`、空 senderId）这里就红。
        expect(seen.length).toBe(1);
        expect(seen[0]).toEqual({ senderId: "ext-88", channelId: "who" });
      });
    },
  },
];

/* ================================================================== *
 * 驱动器：同一份清单跑在两个 fake 上
 * ================================================================== */

for (const [label, make] of FAKES) {
  describe(`抽象层契约 —— ${label}`, () => {
    for (const c of CASES) it(c.name, () => c.run(make));
  });
}

/**
 * 清单条数。**写死是故意的摩擦**（同 `test/arch/migrate.test.ts` 里那张迁移版本表）：
 * 删一条用例必须顺手改这里，而改这一格会逼人去看一眼「这条用例为什么在两个 fake 上不再成立」。
 * 它不测任何行为，只让「清单缩水」这件事不可能静默发生。
 */
const CASE_COUNT = 28;

/** 上面那两个 describe 的自检。 */
it("⭐ 两个 fake 跑的是【同一份】清单，而清单条数被钉住", () => {
  expect(FAKES.length).toBe(2);
  expect(CASES.length).toBe(CASE_COUNT);
  // 重名的两条会互相掩盖（第二发跑的是第一发的名字，红的时候指不出是谁）。
  expect(new Set(CASES.map((c) => c.name)).size).toBe(CASES.length);
});

/*
 * 清单里那一发「不自己造身份」只覆盖了**跑到的那条路径**，所以再配一条源码层面的。
 * 两条的分工与 tokens.test.ts 那一对完全一样：一条测行为（能跑到的部分），
 * 一条测形状（跑不到也能挡 —— 比如「今天没有任何用例走到那条查表代码」这种情况）。
 */
const CHANNELS_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "channels", "abstraction.ts"),
  "utf8",
);

it("⭐ 源码层面：通道层【不自己造角色、不碰库】", () => {
  const code = CHANNELS_SRC.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
  // 反向对照：剥注释【确实剥到了东西】，否则这条扫描可能只是在比原文，
  // 而一个读错路径读到空串的 readFileSync 会让下面三条绿得非常好看了当门禁。
  expect(code.length).toBeLessThan(CHANNELS_SRC.length - 500);
  // 角色字面量。拦的就是 im_bindings 那个 `DEFAULT 'ceo'` 诱导出来的写法。
  expect(code).not.toMatch(/["'`]ceo["'`]/iu);
  // SQL 按【语句形状】拦而不是按动词：`\bDELETE\b` 会撞上 `seen.delete(key)`
  // （Set 的方法名），第一版就是这么误报的 —— 一条会因无关代码变红的守卫
  // 下一次就会被放宽成「算了不拦了」，那才是它真正的失效方式。
  expect(code).not.toMatch(/\bSELECT\b[\s\S]{0,80}\bFROM\b/iu);
  expect(code).not.toMatch(/\bUPDATE\b[\s\S]{0,60}\bSET\b/iu);
  expect(code).not.toMatch(/\bINSERT\s+INTO\b/iu);
  expect(code).not.toMatch(/\bDELETE\s+FROM\b/iu);
  expect(code).not.toMatch(/node:sqlite|\.\.\/db\//u);
  // 反向：它【确实】读了一条规则。少了这条正向对照，上面三条会因为
  // 「这个文件什么都不碰」而全绿 —— 那是同一条判据的失效方向（0027 §2）。
  expect(code).toMatch(/isIrreversibleApproval/u);
});

/* ================================================================== *
 * 违约实验：改坏 fake，看清单是否恰好红在管那一维的那一发
 * ================================================================== */

/*
 * 这一节是本文件唯一有**判别力**的部分。上面两个 describe 全绿只说明
 * 「判据与这两个实现无关」；这里才回答「那两份绿是不是因为清单本身没有分母」。
 * 手法与 0027 §2/§4 同族：**不信任自己刚写出来的绿灯，去改坏被测试的东西**。
 *
 * 实现方式是「造一个违约的 fake，把整份清单跑一遍，收集哪些用例抛了」。
 * 用【收集红的名字】而不是【断言全绿/全红】，是因为一张期望表
 * 只对得上一种破坏（把整份清单跑红是另一种破坏）。
 */

/**
 * `pull()` 只看不取 —— 适配器作者最容易犯的错（以为 pull 是 peek）。
 * spread 保留 `canAct` 等其余成员（它们都是自有属性），所以只改这一维。
 */
function sabotagePeek(inner: FakeHandle): Channel {
  return { ...inner.channel, pull: () => [] };
}

/** `pull()` 倒序交出（LIFO）。 */
function sabotageReverse(inner: FakeHandle): Channel {
  // 先让真实现取走（保持「取走即移除」的语义），再把交出的**顺序**倒过来。
  // 直接在假 pull 里 reverse 内部队列会连「取走」这一维一起改掉，
  // 那样这一发违约就同时破坏了两条契约，红的时候指不出是哪一条。
  return { ...inner.channel, pull: () => [...inner.channel.pull()].reverse() };
}

/** 无视 `canAct`，永远说可以（【规格】§11.2 那条「QQ 只读」在实现里被漏掉）。 */
function sabotageIgnoreCanAct(inner: FakeHandle): Channel {
  return { ...inner.channel, canAct: () => ({ ok: true }) };
}

/** `send` 静默丢（不发也不抛）。 */
function sabotageSilentSend(inner: FakeHandle): Channel {
  return { ...inner.channel, send: async () => {} };
}

interface SabotageCase {
  readonly name: string;
  readonly break: (inner: FakeHandle) => Channel;
  /**
   * 违约之后**必须**有红的用例名（子串匹配）。
   * 空数组 = 已知测不到，那就必须写明为什么测不到、以及真正的修法在哪一篇。
   */
  readonly mustBreakContaining: readonly string[];
}

const SABOTAGE: readonly SabotageCase[] = [
  {
    name: "pull 只看不取",
    break: sabotagePeek,
    // 这一发违约**必须**被抓住。源码里那一发坏写法（`got: c.pull().length`）
    // 正是这个形状，而它是本篇代价最高的一格；抓不住就等于计划 Task 4.4
    // 那句「不得静默吞掉审批」在测试上没有落点。
    mustBreakContaining: ["取走的【每一条】"],
  },
  {
    name: "pull 倒序",
    break: sabotageReverse,
    // 顺序这一维只在「按到达顺序判决」那一发上可见。
    mustBreakContaining: ["到达顺序"],
  },
  {
    name: "实现无视 canAct",
    break: sabotageIgnoreCanAct,
    mustBreakContaining: ["canAct 说不行"],
  },
  {
    name: "send 静默丢",
    break: sabotageSilentSend,
    // 会红，而**红的原因值得记清**：抓住它的不是抽象层，是 fake 自己那份
    // 「实际发出去了什么」的日志（`fake.sent`）。抽象层这边 `deliverCard` 照样报
    // `{kind:"sent"}` —— 那是一句**谎**，而抽象层拿不到任何信号（send 不抛 ⇒ 无信息）。
    // 真要挡住它，得让 `send` 交出**平台回执 id 并落库**（计划 Task 4.4 的活）。
    // 这一格不删、不改空表：删了会让后来的人以为「send 的可靠性有人管」。
    mustBreakContaining: ["卡片降级成只读"],
  },
];

describe("违约实验：把 fake 改坏，清单必须恰好红在管那一维的那一发", () => {
  for (const s of SABOTAGE) {
    it(`违约「${s.name}」${s.mustBreakContaining.length === 0 ? "【已知测不到，缺口见注释】" : "会被清单抓住"}`, async () => {
      const broken: string[] = [];
      for (const [, make] of FAKES) {
        for (const c of CASES) {
          const brokenMaker: MakeFake = (o) => {
            const inner = make(o);
            return { ...inner, channel: s.break(inner) };
          };
          try {
            await c.run(brokenMaker);
          } catch {
            broken.push(c.name);
          }
        }
      }
      for (const want of s.mustBreakContaining) {
        // 断言的是「**有**红、而且红在预期的那一发上」，不是红的**数量** ——
        // 数量随清单增长，把它写死就是把一次重构变成一次考古（0027 §4 那个「3 红」）。
        expect(
          broken.some((n) => n.includes(want)),
          `违约「${s.name}」本该让用例「${want}」红，实际红的是：` + JSON.stringify(broken),
        ).toBe(true);
      }
      if (s.mustBreakContaining.length > 0) {
        // 反向自检：这一发违约**确实**搞坏了东西。
        // 没有这一句，一张「期望表写空 + 什么都不红」的假表也能全绿。
        expect(broken.length).toBeGreaterThan(0);
      }
    });
  }
});

/* ================================================================== *
 * 旋钮自检：每个旋钮在【两个】fake 上都必须真的改变行为
 * ================================================================== */

/*
 * 为什么单独一节：两个 fake 的旋钮**同名**，而「同名」不等于「同效」。
 * 一个只在 A 上生效、在 B 上被无视的旋钮，会让「B 那一节也全绿」变成假的
 * （B 跑的其实是另一件事，而报告上看不出来）。
 * 那正是 `supportsActionReturn` 在源码里一度变成装饰的同一个形状，
 * 只是发生在夹具这一侧 —— 夹具里的装饰品比源码里的更难发现，
 * 因为它红的时候看起来像夹具的 bug，于是有人会把断言删掉。
 */
describe("两个 fake 的旋钮一一对应，而且每个都真的承重", () => {
  /** 每一项返回「旋钮有没有改变可观测行为」。false = 这个旋钮在这个 fake 上是装饰品。 */
  const KNOBS: readonly (readonly [string, (make: MakeFake) => void | Promise<void>])[] = [
    [
      "canAct=false 挡住一次可逆审批",
      async (make) => {
        const blocked = runtime(make, { fake: { canAct: { ok: false, reason: "只读" } } });
        blocked.fake.injectAction(CLICK);
        const open = runtime(make);
        open.fake.injectAction(CLICK);
        expect(await verdictsOf(blocked)).toEqual(["channel_refused"]);
        expect(await verdictsOf(open)).toEqual(["acted"]);
      },
    ],
    [
      "supportsActionReturn=false 让卡片变只读",
      async (make) => {
        const ro = await deliverCard(make({ supportsActionReturn: false }).channel, snap());
        const rw = await deliverCard(make().channel, snap());
        expect(ro.kind === "sent" ? ro.card.actionable : null).toBe(false);
        expect(rw.kind === "sent" ? rw.card.actionable : null).toBe(true);
      },
    ],
    [
      "sendThrows=true 让 deliverCard 报 send_failed",
      async (make) => {
        expect((await deliverCard(make({ sendThrows: true }).channel, snap())).kind).toBe("send_failed");
        expect((await deliverCard(make().channel, snap())).kind).toBe("sent");
      },
    ],
    [
      "pullThrows=true 让那一轮标 failedOpen",
      async (make) => {
        const bad = await runtime(make, { fake: { pullThrows: true } }).rt.pollAll();
        const fine = await runtime(make).rt.pollAll();
        expect(bad[0]?.failedOpen).toBe(true);
        expect(fine[0]?.failedOpen).toBe(false);
      },
    ],
    [
      "closeThrows=true 让 shutdownChannels 报出这一条",
      async (make) => {
        expect(await shutdownChannels([make({ closeThrows: true }).channel])).toHaveLength(1);
        expect(await shutdownChannels([make().channel])).toEqual([]);
      },
    ],
    [
      "queueLimit 真的截断队列并留下计数",
      (make) => {
        const f = make({ queueLimit: 1 });
        f.injectAction({ approvalId: "a-1", resume: "approve" });
        f.injectAction({ approvalId: "a-2", resume: "approve" });
        expect(f.queued()).toBe(1);
        expect(f.overflowed.map((e) => e.message.text)).toEqual(["a-1|approve"]);
      },
    ],
    [
      "id 旋钮改的是通道 id",
      (make) => {
        expect(make({ id: "knob-id" }).channel.id).toBe("knob-id");
      },
    ],
  ];

  for (const [label, check] of KNOBS) {
    it(`旋钮「${label}」在两个 fake 上都生效`, async () => {
      for (const [fakeLabel, make] of FAKES) {
        // 断言消息里带上 fake 名：一个旋钮只在一个 fake 上生效时，
        // 「两个 fake 都绿」是假的，而这一红会指名是哪一个在骗人。
        try {
          await check(make);
        } catch (e) {
          throw new Error(`旋钮「${label}」在 ${fakeLabel} 上不生效（装饰品）：` + String(e));
        }
      }
    });
  }

  it("⭐ 两个 fake 的 pull / deliveryId 语义确实不同（否则『换实现也过』只是同一份代码跑两遍）", () => {
    // 这一发是**自我拆台**的那一类：如果哪天有人把 B 改成 A 的复制品，
    // 上面那两个 describe 会一起绿得更好看，而「换实现也过」这句话同时作废。
    // 所以直接钉住两处真实的实现差异。
    const a = makeQueueFake();
    const b = makeBatchFake();
    for (let i = 0; i < 5; i++) {
      a.injectAction({ approvalId: "a" + i, resume: "approve" });
      b.injectAction({ approvalId: "a" + i, resume: "approve" });
    }
    expect(a.queued()).toBe(5);
    expect(b.queued()).toBe(5);
    // 两个 fake 的 pull 都得把 5 条**全部**交出并清空（B 那 5 条分布在 2 个批次里，
    // 所以这一发同时钉住「二维队列没有把跨批次的消息落下」—— 那是 B 独有的风险面）。
    expect([...a.channel.pull()].length).toBe(5);
    expect([...b.channel.pull()].length).toBe(5);
    expect(a.queued()).toBe(0);
    expect(b.queued()).toBe(0);
    // B 拿不到平台投递 id（有些平台确实不给）。这一维逼着幂等判据落在
    // channelActionKey 上而不是 deliveryId 上 —— 于是「只用 deliveryId 去重」
    // 那种写法会在 B 那一节当场塌掉，而不是两边都绿。
    // 取在 pull 之后：这两次 inject 是**这里**唯一的用途，队列现在是空的，
    // 所以下面两行读到的 deliveryId 一定来自刚投的这条，而不是被前面那 5 条混进来。
    expect(a.inject("text").deliveryId).not.toBeNull();
    expect(b.inject("text").deliveryId).toBeNull();
  });
});
