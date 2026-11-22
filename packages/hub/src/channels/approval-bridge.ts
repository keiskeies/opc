/**
 * IM 审批的装配桥（O12 动作 1）：把通道运行时与「身份」「决策」两端接起来。
 *
 * ── 这个文件存在的唯一理由 ────────────────────────────────────────────
 * 两端都在仓库里，中间那一格装配不在：
 *  · 身份端 `bindings/im.ts` 的 `makeChannelActorResolver` 写好了，~~src 里零调用方~~
 *    （round280 时如此，本文件就是它的第一位读者）；
 *  · 决策端 `engine/approve.ts` 的 `approveCard` 被 HTTP 与 CLI 用着，
 *    但通道层的 `deps.act` 没有任何生产实现方 —— `handleOne` 走到那一格
 *    只会返回 `{kind:"failed", why:"装配未提供 act 落库点"}`。
 * `channels/abstraction.ts` 文件头把这件事写得很清楚：那一层刻意不认识库、
 * 不认识 bindings、不认识 approvals，所以装配点必须在【别处】。别处就是这个文件。
 *
 * ⚠ 而【本文件不是装配的全部】，这一格要说死：桥交出三格，而"在常驻进程里造出它"
 * 是另一格 —— 那一格在 round281 之前全仓没有，现在是 `serve/im-channels.ts`
 * （它再被 `serve/assemble.ts` 的 `boot()` 调用）。
 * 也就是说这个文件对 `boot` 是【不可达的下游】：删掉 `im-channels.ts` 里那一发调用，
 * 本文件立刻重新变成"从任何生产入口走不到"，而它自己的测试一条都不会红
 * （那些测试自己造桥）。`dead-modules` 的基线在 round281 摘掉了本模块那两条条目，
 * 那正是"没有守卫再替你守着这条链"的代价 —— 链断的时候由 im-channels 的用例红。
 *
 * ── `verified` 那一格为什么【不在这里】判 ─────────────────────────────
 * `im_bindings` 的表头是 `ceo_role TEXT NOT NULL DEFAULT 'ceo'`（0001_init.sql）。
 * 抽象层文件头算过它的后果：不看 `verified` 的 `actorFor` 等于宣布
 * 「任何有人替他插过一行绑定的 IM 账号，默认就是 CEO」，而那条绑定验没验过完全不看。
 * 那不是缺口，是一条能批准的冒充通道，且它今天全部测试会绿。
 * 回答那一格的是 `resolveBinding`：它【只有一个入口】，没有 `includeUnverified`
 * 开关，未验证的那一行走 `pending_verification` 那一支 —— 看得见，但不能当身份。
 * 所以桥不复制那条判据（复制 = 造第二个事实源，两处各判一次迟早漂，
 * 与 round272 那族「同一件事两处各判而口径不同」同形），桥只做一件事：
 * 【把它接上】。抽象层文件头那句「`makeChannelActorResolver` 那句话目前是一个答案
 * 而没有读者」—— 这个文件就是那个读者。
 *
 * ── 审计 actor：为什么写的是绑定角色而不是照抄 HTTP 那条路的 ceo ────────
 * O12 验收句要的正是这一格：「审计行 actor 是绑定的那个角色」。
 * 注意它防的【不是 system】—— 两条生产决策路径的 actorId 从来都不是 system
 * （HTTP 写死 `ceo`；建卡那条才是 `system/hub`，而它只是【请求】不是决定）。
 * 它防的是【照抄】：`applyDecision` 与 `approveCard` 都硬编码 `ceo`，
 * 接线的人最省事的写法就是跟着写死，而那时「手机上谁点的」从落库那一刻起就消失了。
 * `im_bindings` 存在的理由就是回答「这个外部账号是哪个角色」，答案必须走到审计行；
 * 走不到的话，那张表就只是一张只读得见的表。
 * ⚠ 射程：actorId 换，actorType 不换（仍是 `human`）。
 * 这一格换的是【谁】，不是【是不是人】。
 *
 * ── 事件 payload 里为什么【不】加通道来源 ─────────────────────────────
 * 抽象层 `deps.act` 的注释立了一条家规：审计只许有一条事实源，
 * 来源（哪条通道）该进【那一行】的 payload，不许新加一行。
 * 加 payload 字段要过 `events/recorder.ts` 的 payload 契约与回放断言，
 * 那是另一件事，不该借接线顺手做。`ChannelActRequest.viaChannelId` 原样留在边界上，
 * 桥这一层不消费它 —— 那是【登记过的余量】，不是遗漏。
 */
import { evidenceRefsOf } from "../approvals/query.js";
import {
  makeChannelActorResolver,
  type ResolveResult,
  resolveBinding,
} from "../bindings/im.js";
import { assertSingleStatement, type HubWriter } from "../db/write-queue.js";
import { approveCard } from "../engine/approve.js";
import type { DomainEvent } from "../events/bus.js";
import { isIrreversibleApproval } from "../http/tokens.js";
import {
  type ChannelActor,
  type ChannelActRequest,
  type ChannelActResult,
  type ChannelCardSnapshot,
  IRREVERSIBLE_HINT,
} from "./abstraction.js";

/** 一条绑定 = 一条通道实例。`registry` 里查不到的 channelId ⇒ 拒（不猜平台）。 */
export type ChannelRegistry = Readonly<{
  channelId: string;
  platform: string;
}>;

export interface BridgeDeps {
  readonly w: HubWriter;
  readonly registry: readonly ChannelRegistry[];
  /** 事件广播出口。必填，理由见 `makeApprovalBridge`。 */
  readonly publish: (e: DomainEvent, seq: number) => void;
  readonly knownRoles?: ReadonlySet<string>;
  /** 观测点：身份判定的每一次结果交给它（装配方拿去记日志）。不是判据。 */
  readonly onResolve?: (senderId: string, r: ResolveResult) => void;
}

/** 注给 `createChannelRuntime` 的那三格。一次装配，三处注入。 */
export interface ApprovalBridge {
  readonly actorFor: (actor: ChannelActor) => ChannelActor | null;
  readonly loadCard: (approvalId: string) => ChannelCardSnapshot | null;
  readonly act: (req: ChannelActRequest) => Promise<ChannelActResult>;
}

/**
 * `senderId + channelId` → 绑定的角色；未验证 / 没登记 / 撞平台 ⇒ null。
 *
 * 为什么不从 `actorFor` 的输出直接拿角色：抽象层文件头写明 `ChannelActor`
 * 【刻意不携带角色】（0028 钉的「运行时不自己造身份」，扩那个类型会造出一层
 * 跨层隐式信任）。所以决策那一刻角色【重查一次】。
 * 重查不是浪费：`rebind` 会把 verified 清回 0 —— 点击在路上走的时候被撤权，
 * 第二次查到 null ⇒ 批不掉。这是这条链唯一一处「撤权当场生效」的位置。
 */
export function makeBoundRoleReader(
  w: HubWriter,
  o: {
    readonly registry: readonly ChannelRegistry[];
    readonly knownRoles?: ReadonlySet<string>;
  },
): (senderId: string, channelId: string) => string | null {
  const byId = new Map(
    o.registry.map((c) => [c.channelId, c.platform] as const),
  );
  const read = w.readConnection();
  return (senderId, channelId) => {
    const platform = byId.get(channelId);
    // ⭐ 问不到 ⇒ 拒，不猜。理由与 `makeChannelActorResolver` 文件头同源：
    // 一个 runtime 注册多条通道时，猜平台会让 A 平台的账号去 B 平台那张表里查，
    // 两边外部 id 撞车（都是手机号）时就是【拿错角色】，且全绿。
    if (platform === undefined) return null;
    const r = resolveBinding(read, {
      platform,
      externalUserId: senderId,
      ...(o.knownRoles === undefined ? {} : { knownRoles: o.knownRoles }),
    });
    return r.kind === "resolved" ? r.binding.role : null;
  };
}

/** `loadCard` 读的那一条 SQL。SELECT，单语句，家规同全仓。 */
export const LOAD_CARD_SNAPSHOT_SQL =
  "SELECT task_id, approval_type, summary, status, parameters, evidence_refs, " +
  "recommendation, timeout_behavior FROM approvals WHERE id = ?";

/**
 * 直读 `approvals` 那一行。列名逐字出自 `approvals/cards.ts` 的 INSERT。
 *
 * 不复用 `approvals/query.ts` 的 `listApprovals`：那条是【列表】路径
 * （带分页、影子判定，`ApprovalView` 的形状是给 HTTP 的），
 * 桥要的是抽象层那九个字段。绕道列表层换来的是多一层要维护的形状转换，
 * 而这一格没有任何判定可复用。
 */
export function loadCardSnapshot(
  w: HubWriter,
): (approvalId: string) => ChannelCardSnapshot | null {
  const read = w.readConnection();
  assertSingleStatement(LOAD_CARD_SNAPSHOT_SQL);
  return (approvalId) => {
    const row = read.prepare(LOAD_CARD_SNAPSHOT_SQL).get(approvalId) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return null;
    const text = (k: string): string | null =>
      row[k] === null || row[k] === undefined ? null : String(row[k]);
    return {
      approvalId,
      taskId: text("task_id") ?? "",
      summary: text("summary") ?? "",
      approvalType: text("approval_type") ?? "",
      status: text("status") ?? "",
      parametersJson: text("parameters"),
      evidenceRefs: evidenceRefsOf(row["evidence_refs"]),
      recommendation: text("recommendation"),
      timeoutBehavior: text("timeout_behavior"),
    };
  };
}

/**
 * 把一次通道回投落成一次决策。
 *
 * 判序【必须】是 角色 → 可逆性 → 决策，两格都在落库【之前】：
 *  · 角色放最前 —— 反过来的话一个没有身份的 senderId 会先把卡片批掉再被拒，
 *    那比「批不掉」坏得多（决定已经落库了）。
 *  · 可逆性这一格【不是重复抽象层那一遍】，理由见下面那条 ⚠。
 */
export function makeChannelAct(d: {
  readonly w: HubWriter;
  readonly publish: (e: DomainEvent, seq: number) => void;
  readonly roleOf: (senderId: string, channelId: string) => string | null;
  /** 决策落库的时钟。**默认 `req.receivedAtMs`**（点击到达时刻，不是落库时刻）。 */
  readonly nowMs?: (req: ChannelActRequest) => number;
}): (req: ChannelActRequest) => Promise<ChannelActResult> {
  const cardOf = loadCardSnapshot(d.w);
  return async (req) => {
    const role = d.roleOf(req.actor.senderId, req.actor.channelId);
    if (role === null) {
      return { ok: false, why: "该外部账号没有已验证的绑定身份，决策不落库" };
    }
    // ⭐ O11「不可逆不许在 IM 里批」的【落库点】防线。
    // 抽象层已经在 `handleOne` 里判过一遍（`channelIneligibleReason` ⇒ not_actionable），
    // 所以只走运行时的调用方【看起来】不需要这一遍。但 `act` 是这个模块的导出，
    // 抽象层文件头明写 `deps.act` 由装配方提供、任何装配方都能直接调它 ——
    // 把 O11 寄在「调用方先过了那道门」上，等于把不可逆防线寄在调用顺序上。
    // 与 `APPROVE_CARD_CALLERS` 那条登记同源：新调用方必须【自带】凭据论证，
    // 而不是引用别人路上有的一道门。这一格就是这个调用方自带的那一份。
    // 判据仍是 tokens.ts 那一个函数（同一个 `isIrreversibleApproval`，不抄第二份），
    // 读的是【此刻库里那一行】而不是调用方早前拿到的快照 —— 与角色那格同一个理由：
    // 点击在路上被改判成不可逆，也要当场生效。
    // 卡片读不到（null）【不在这里判】：那一格的判据住在 `approveCard`
    // （stale_card / not_found），在这里重判就是造第二个事实源。
    const snap = cardOf(req.approvalId);
    if (
      snap !== null &&
      isIrreversibleApproval(snap.approvalType, snap.parametersJson)
    ) {
      return { ok: false, why: IRREVERSIBLE_HINT };
    }
    const r = await approveCard(
      d.w,
      {
        taskId: req.taskId,
        approvalId: req.approvalId,
        // CardButton 与 ResumeValue 是同一个三值并集的两个名字，不需要转换：
        // approve.test.ts 那条 STATUS_BY_BUTTON toEqual STATUS_BY_RESUME 钉着同步；
        // 值本身在更外面一层由 parseCardAction 的 isResumeValue 判过。
        button: req.resume,
        nowMs: (d.nowMs ?? ((x) => x.receivedAtMs))(req),
        ...(req.note === undefined ? {} : { note: req.note }),
        actorId: role,
      },
      d.publish,
    );
    if (r.outcome === "decided") return { ok: true };
    if (r.outcome === "already_decided") return { ok: true, replayed: true };
    // 0046 §6-2：这两种是【调用方请求不成立】，不是服务端一致性坏 ——
    // 打回没带理由 / 豁免卡批准没带理由 ⇒ 422，点到过期卡 ⇒ 409。
    // 其余 outcome（card_missing / task_missing / card_belongs_to_other_task…）
    // 是服务器状态问题，保持原样（只给 why，不给 statusHint）⇒ 消费方按 500 处理。
    if (r.outcome === "note_required" || r.outcome === "waiver_note_required") {
      return { ok: false, why: r.note, statusHint: 422 };
    }
    if (r.outcome === "stale_card") {
      return { ok: false, why: r.note, statusHint: 409 };
    }
    return { ok: false, why: r.note };
  };
}

/**
 * 一次装配交出运行时要的那三格。
 *
 * `actorFor` 直接就是 `makeChannelActorResolver` 的产物 —— 这条链的【全部】
 * 新代码只有「把两边对上」这件事，身份判据一行都没重写。这正是 O12 动作 1
 * 的原话：「先接桥，它两端都在仓库里」。
 *
 * ⚠ `publish` 是【必填】的，且这里刻意不给 `() => {}` 默认值。
 * 理由与 `real-deps.ts` 里那条一模一样：决策落库而不广播 ⇒ `events.id` 已被消费
 * 而没送出去 ⇒ 活着的 SSE 订阅看见一个 seq 空洞，投影层把它读成「链路降级」。
 * 「忘了广播」的症状不是少一条更新，是每次批准都把连接标脏一次。
 * 所以装配方必须【显式】交出一个函数（不广播就自己写一个空函数并注明理由），
 * 「我选择不广播」与「我忘了」在代码上必须长得不一样。
 */
export function makeApprovalBridge(d: BridgeDeps): ApprovalBridge {
  const w = d.w;
  const byId = new Map(
    d.registry.map((c) => [c.channelId, c.platform] as const),
  );
  return {
    actorFor: makeChannelActorResolver(w.readConnection(), {
      platformOfChannel: (channelId) => byId.get(channelId) ?? null,
      ...(d.knownRoles === undefined ? {} : { knownRoles: d.knownRoles }),
      ...(d.onResolve === undefined ? {} : { onResolve: d.onResolve }),
    }),
    loadCard: loadCardSnapshot(w),
    act: makeChannelAct({
      w,
      publish: d.publish,
      roleOf: makeBoundRoleReader(w, {
        registry: d.registry,
        ...(d.knownRoles === undefined ? {} : { knownRoles: d.knownRoles }),
      }),
    }),
  };
}
