/**
 * Channel 抽象层（计划 Task 4.5，【规格】§11.3 + §11.4）。
 *
 * ── 这一篇要挡住的那一件事 ────────────────────────────────────────────
 * 【规格】§11.3 原文只有一句：「**不要为每个 IM 平台写独立业务逻辑。**」
 * 这句话很容易被「达成」成表面样子：写一个 `interface Channel { send(x) }`，
 * 让飞书实现它，然后宣布抽象层完成。那个形状**什么都没抽象** ——
 * 因为业务逻辑（这张卡能不能在这条通道上批、点了之后走哪条写路径、
 * 重投要不要再记一条审计）仍然住在每个适配器里，只是换了个位置。
 *
 * 所以这一层的判据不是「有没有一个 interface」，而是这三条：
 *  ① 入站归一化：适配器只交 `NormalizedMessage`（平台 / 发送者 / 会话 / 文本 /
 *     是否 @机器人 / 消息类型），**平台原生结构不许穿过这条边界**。
 *  ② 出站归一化：业务侧只看见 `ApprovalCard`，**没有平台字样的字段**。
 *     渲染成飞书卡片是飞书适配器自己的事。
 *  ③ **策略在归一化之后、适配器之前**：能不能批（§11.4 不可逆不许在 IM 批）、
 *     重投幂等、失败怎么报 —— 全部在 `handleInbound` 这一层做完，
 *     适配器拿到的已经是「一个被批准的、去重过的决定」。
 *
 * 三条里 ③ 才是本体。① ② 只是数据形状；③ 保证的是「换平台换不掉策略」。
 * 有一条测试专门钉它：把 fake channel 换成另一个 fake，
 * 不可逆仍然被拒、重投仍然只算一次 —— 那两个 fake 之间没有共享一行策略代码。
 *
 * ── 为什么本期只有 fake，没有飞书 ─────────────────────────────────────
 * 计划 Task 4.5 自己写着：「**但本期不实现企微 / QQ**（反过度设计：
 * 抽象层由一实现验证，不做二实现）」，而 Task 4.4 那个唯一的真实现要
 * `@larksuiteoapi/node-sdk`，本机离线装不上（同 0009 §2 那族：缺依赖就是缺）。
 *
 * ⚠ 所以本篇的强度必须说准，否则这一节就成了自我表扬：
 * **一个 fake 验证不了抽象层的「可实现性」。** 它只能验证抽象层的
 * **一致性**（同一套判据在不同实现上都成立）与**完备性**（一个通道需要的东西
 * 接口里都有，缺一样 fake 就写不出来）。真正会被飞书推翻的那部分是
 * **表达力** —— 比如飞书卡片回调把签名放在 header 而 QQ 放在 body，
 * `ChannelEnvelope` 这个形状就可能在接入那天发现不够用。
 * 那种失败**今天不可能被发现**，记在这里而不是等那天解释。
 * 换句话说：Task 4.5 的验收标准是「换成 fake channel 全部测试仍通过」，
 * 这个标准**我达成了**，而它比「飞书接得进来」弱，两者不是一回事。
 */

import {
  APPROVAL_BUTTONS,
  APPROVAL_STATUS_PENDING,
  type ResumeValue,
  RESUME_VALUES,
} from "@opc/contracts";
// 只 import 一个纯谓词。为什么 channels 会 import 一个 http/ 下的模块，
// 理由与代价都写在 `channelIneligibleReason` 上面那段（不要在这里再讲一遍）。
import { isIrreversibleApproval } from "../http/tokens.js";

/**
 * 幂等键的分隔符。用 `|` 之类**可打印**字符是错的：approvalId / senderId
 * 都是外部可控字符串，`"a|b" + "|" + "c"` 与 `"a" + "|" + "b|c"` 会撞成同一个键，
 * 而撞键的后果是**第二次点击被判 duplicate**（一个决定被吞）。
 * NUL 不可能出现在这些字段里（它们全是 base64url / UUID / 平台 id），
 * 而且一旦有人塞进来，键会带上一个肉眼看不见的字符 —— 那条测试
 * （channel.test.ts 的「分隔符注入」那发）会当场红，而不是安静地合并两个动作。
 */
export const ACTION_KEY_SEP = String.fromCharCode(0);

/**
 * 归一化入站消息（【规格】§11.3 那张列表的逐字翻译）。
 *
 * ⚠ 六个字段里**没有** `text` 之外的任何平台原生字段。这一格是整个抽象层的
 * 承重墙：只要允许一个 `raw?: unknown` 或者 `feishuCard?: …` 溜进来，
 * 业务逻辑就会「先试 raw、没有再退回 text」，而那条分支一旦写下，
 * §11.3 那句话就作废了 —— 且作废的方式是**安静**的（每个平台各自跑得对）。
 * 平台原生数据必须留在适配器内部，**在这一层边界之外**。
 */
export interface NormalizedMessage {
  /**
   * 通道实例 id，不是平台名。
   *
   * 用实例而不是平台：同一台 Hub 上接两个飞书应用（一个给 CEO 私聊、
   * 一个给决策群）是真实需求，而「这条消息从哪个通道来」在两个场景里的答案不同。
   * 平台名单独一个字段 `platform`，它只用于人读与审计标签。
   */
  readonly channelId: string;
  readonly platform: ChannelPlatform;
  /** 发送者在这个平台上的 id。不是我们内部的角色 id —— 那个要靠绑定表换。 */
  readonly senderId: string;
  /** 会话 id（私聊、群聊各一个）。审批卡片的回投地址由它决定。 */
  readonly conversationId: string;
  readonly text: string;
  /** 群聊里是否 @ 了机器人。【规格】§11.2 给 QQ 的定位就是「@机器人查状态」。 */
  readonly atBot: boolean;
  readonly kind: NormalizedMessageKind;
}

export type ChannelPlatform = "feishu" | "wecom" | "qq" | "fake";

/**
 * 消息类型。**刻意不收 `image` / `file` 这类平台能力**。
 *
 * 理由不是省事：一旦收进来，业务侧就必须回答「图片消息要不要建卡」这类问题，
 * 而那个答案在三个平台上都不一样（飞书能下载、QQ 有条数限制、企微另说）。
 * 于是抽象层当场退化成「按平台分支」。
 * 今天只有两种：能承载审批决策的、与不能的。
 */
export type NormalizedMessageKind = "text" | "card_action";

/**
 * 用户在卡片上点了一次按钮。这是 `card_action` 那类消息的载荷。
 *
 * `resume` 直接采用 contracts 的 `RESUME_VALUES` 而**不在这里另列一份**。
 * 这一格值得单独说：IM 卡片最自然的写法是自己定义一套
 * `"approve" | "reject" | "later"`，再写一张到 resume 的映射表。
 * 那张映射表就是 bug 现场 —— 加第四个按钮时改了这边忘了那边，
 * 而症状是**那个按钮点下去变成另一个动作**（不是报错）。
 * 用同一个联合类型之后，「少映射一个值」在编译期就过不去。
 */
export interface CardAction {
  /** 我们发出去的那张卡片的 id（= approvals.id）。平台回传的卡片实例 id 不外露。 */
  readonly approvalId: string;
  readonly resume: ResumeValue;
  /** reject_with_comment 的备注。平台侧没有输入框时为 undefined。 */
  readonly note?: string;
}

/**
 * 一次入站的信封：归一化消息 + **适配器必须一起交上来的东西**。
 *
 * `receivedAtMs` 为什么强制由适配器给而不让这里 `Date.now()`：
 * 「Hub 离线期间到达的回调在恢复后能被处理或有明确丢失告警，不得静默吞掉审批」
 * 是计划 Task 4.4 写死的验收标准。要判断「这条消息在路上走了多久」，
 * 必须知道**到达时刻**。这里自己取时钟的话，队列积压与离线重投
 * 都会被打成「刚刚到达」，那条验收标准在代码上**无处可表**。
 */
export interface ChannelEnvelope {
  readonly message: NormalizedMessage;
  readonly receivedAtMs: number;
  /** 平台侧的消息 id，用于幂等（见 deliveryKey）。没有的话必须给 null，不许省。 */
  readonly deliveryId: string | null;
}

/* ------------------------------------------------------------------ *
 * 出站
 * ------------------------------------------------------------------ */

/**
 * 归一化出站审批卡片（【规格】§11.3「各平台适配器负责渲染」的那一侧）。
 *
 * ── 一个诚实的命名更正 ──────────────────────────────────────────────
 * 规格与计划都把出站归一化写作 `ApprovalCard`。这个名字**在本仓已经被占用**：
 * `hub/src/approvals/cards.ts` 的 `createCard` 建的是**数据库里那一行**，
 * `contracts` 的 `approvalCardDraftSchema` 是**建卡输入**。再加第三个 `ApprovalCard`
 * 会得到三个同名不同物的东西，而「同名不同物」是本仓在
 * `substituteTaskId`（0013 §10.1）、`readTasks`（0015 §1）上反复付过学费的形状。
 * 所以这里叫 `OutboundApprovalCard`，并在下面那条断言里把「它就是 §11.3
 * 说的那个东西」写死。命名换了而要求没换：三行 + 三按钮，逐字来自 §9.2。
 */
export interface OutboundApprovalCard {
  /** = approvals.id。回投时要靠它认卡。 */
  readonly approvalId: string;
  readonly taskId: string;
  /** §9.2 第一行。 */
  readonly summary: string;
  /**
   * §9.2 第二行的各栏。**原始键值**，不是类型化对象，且可以为 null。
   *
   * 为什么不收窄成 `ApprovalCardDraft["parameters"]`：那一格是**建卡时**的契约，
   * 而卡片行进库之后，parameters 是一段【当时写下的】JSON 文本
   * （0026 §2 那条「reason 进 payload」的决定让 parameters 变成自由形状的地方）。
   * 在这里假装它还是那个四键对象，等于让渲染层在脏数据上拿到一个类型上保证存在
   * 而运行时不存在的字段 —— 那一发的坏法是 `parameters.amount_cents.toFixed()`
   * 之类的东西在渲染时抛，而抛的位置离真正的成因隔了整个事件链。
   */
  readonly parameters: Record<string, unknown> | null;
  /** §9.2 第三行。**null = 我们没存这一行**，与 `[]`（存了，确实没有）不同。 */
  readonly evidenceRefs: readonly string[] | null;
  /** 「推荐，非决定」那一栏。 */
  readonly recommendation: string | null;
  readonly timeoutBehavior: string | null;
  /** 三按钮。**没有第四个按钮的位置**，理由见 APPROVAL_BUTTONS 的注释。 */
  readonly buttons: readonly ResumeValue[];
  /**
   * 这张卡**能不能在这条通道上被批**。
   *
   * 注意这里放的是**结论**（一个 boolean + 一句人话），不是原始字段。
   * 如果把它留给适配器自己判（「适配器看一下 irreversible 字段就知道该不该禁用」），
   * §11.4 那条策略就会被实现 N 次，而只要有一次写成「解析失败 ⇒ 当可逆」，
   * 那条策略就漏了 —— 且漏的方式是安静。判据只在 `channelIneligibleReason` 一处。
   */
  readonly actionable: boolean;
  readonly notActionableReason?: string;
}

/* ------------------------------------------------------------------ *
 * 通道接口
 * ------------------------------------------------------------------ */

/**
 * 一个通道要做的事 —— 而且**只有这些**。
 *
 * ⚠ 这里刻意**没有** `onMessage` / `subscribe` / 事件回调。
 * 那是最自然的写法（通道自己长连接、收到就 push 给注册的回调），
 * 而它会造出一个**第二条入站路径**：一条从 `handleInbound` 进（有策略、有幂等、
 * 有审计），一条从回调进（什么都没有，因为它在通道内部，策略层看不见）。
 * 第二条路径的存在本身就是 §11.4 的漏洞，而它的症状与 0026 §1 那格同形：
 * 「飞书那边点了，卡片批掉了，而审计里没有那次点击」。
 * 所以入站**只能**由调用方拉（`pull()`），谁调、什么时候调、失败怎么办，
 * 都归调用方（今天是 `serve/assemble.ts`，将来是巡检那一带）。
 *
 * 这条立场是有代价的：长连接平台（飞书）天然是 push 模型，
 * 适配器内部必然要维护一个队列。**那个队列是适配器私有的**，
 * 不是接口的一部分 —— 这正是「平台差异留在适配器里」的具体含义。
 */
export interface Channel {
  readonly id: string;
  readonly platform: ChannelPlatform;
  /** 启动（建立连接 / 登录）。失败必须抛，不许内部吞。 */
  start(): Promise<void>;
  /** 关停。实现必须**幂等**：重复 close 不抛（见 shutdown 的注释）。 */
  close(): Promise<void>;
  /**
   * 取走当前待处理的入站消息。**取走即从适配器内部队列移除**。
   *
   * 返回顺序必须是**到达顺序**（先进先出）。乱序交付会让「同一条重投只算一次」
   * 这种判据变得看运气 —— fake 那一发专门测这个。
   */
  pull(): readonly ChannelEnvelope[];
  /** 送出一张卡。失败要抛（由通道编排层决定怎么报）。 */
  send(card: OutboundApprovalCard): Promise<void>;
  /**
   * 卡片在**这个**平台上的可执行性。
   *
   * 「可执行」= 这张卡允许被这个人在这条通道上批。
   *
   * ⚠ 为什么它是**可选**的（`canAct?`）：§11.2 白纸黑字写着
   * **QQ 是「只读查询通道」，不适合作审批主通道** —— 那是一条**平台属性**，
   * 而不是这条消息的属性。如果只有 `decideRemoteEligibility`（逐条判可逆），
   * 一个**可逆**的审批就会**合法地**从 QQ 被批掉，
   * 而那条规则在代码上**不存在**（没有任何一行写着「QQ 不能批」）。
   * 更糟的是它**测不出来**：写 fake channel 的人只会实现策略那一半。
   * 所以这里给第二条判据留出位置，并由 fake 的一个
   * 「策略说可以、通道说不行」的档位把它**跑出真分母**。
   */
  readonly canAct?: (actor: ChannelActor) => ChannelActVerdict;
  /**
   * 这条通道**支不支持把一次点击回传成一次决定**。
   *
   * 与 `canAct` 的区别：`canAct` 问的是「这个人此刻能不能批」，
   * 这一格问的是「这个平台有没有回传能力」。QQ 的「以被动回复为主、
   * 主动消息有条数限制」（§11.2）是后者的实例：卡片可以推过去，
   * 但把点下去的按钮收回来的那条路**不可靠**。
   *
   * 为什么单独一格而不并进 `canAct`：两者坏了的样子完全不同。
   * 「人没权限」应该让人去别处点；「平台不回传」应该让**卡片根本不要带按钮**
   * （带一个点了没人收的按钮，比不给按钮更坏：人会一直点，
   * 而每一次都石沉大海 —— 那是 0025 §3 那族「看起来接上了」的形状）。
   */
  readonly supportsActionReturn: boolean;
}

/**
 * 一个通道内部队列的上限。
 *
 * 为什么这个数在**抽象层**而不是每个适配器各写一个：它决定的是
 * 「Hub 处理不过来的时候，审批消息是留着还是丢」。留着的代价是内存，
 * 丢的代价是【一个 CEO 点了批准而永远没人收到】—— 后者是 §11.4 与
 * 计划 Task 4.4 那句「不得静默吞掉审批」直接禁止的事。
 * 所以这一格的关键不是那个数是多少，而是**溢出必须有一个可数的计数**
 * （见 `boundedPush`）。
 */
export const CHANNEL_QUEUE_LIMIT = 256;

/**
 * 适配器内部队列的**入队**实现。放在抽象层是因为溢出这件事**每个适配器都会写错**：
 * 最自然的写法是 `if (q.length < LIMIT) q.push(x)`，那是**静默丢弃** ——
 * 队列满了，消息没了，没有任何一处知道少了东西。
 *
 * 这里要求调用方**必须**拿到一个计数，而计数必须由调用方上报
 * （`onOverflow` 是必填参数，不是可选回调）。可选回调等于没有回调：
 * 少传一次就静默了，而本篇整层的立场是「少一层检查就少一道防线」。
 *
 * 丢的是**最老的一条**而不是最新的一条，理由与收件箱排序同源（0026 §6.3）：
 * 最新那一条最可能还在界面上被盯着，人看到「已发送」而实际没排队是双倍误导；
 * 而最老那条已经等了很久，它大概率已经没人在等了。
 * ⚠ 这个取舍**是可争议的**，而我把它写成可争议的而不是正确的：
 * 真正的答案是「都不该丢」，而做不到这件事的前提是 Hub 处理能力有上界。
 */
export function boundedPush(
  q: ChannelEnvelope[],
  e: ChannelEnvelope,
  onOverflow: (dropped: ChannelEnvelope) => void,
  limit: number = CHANNEL_QUEUE_LIMIT,
): boolean {
  if (q.length >= limit) {
    const dropped = q.shift();
    if (dropped !== undefined) onOverflow(dropped);
  }
  q.push(e);
  return q.length <= limit;
}

/* ------------------------------------------------------------------ *
 * 策略
 * ------------------------------------------------------------------ */

/**
 * 「这条审批能不能走 IM」（【规格】§11.4 第二条）。
 *
 * 返回 `null` = 可以；返回一句人话 = 不可以，那句话直接给到用户。
 *
 * ── 判据【不在这里】，在 tokens.ts 的 isIrreversibleApproval ──────────
 * 这一度让我写出一个**重复的判据**：第一版在这里照 §11.4 又写了一遍三档
 * （类型标记 / 卡片声明 / 判不出算不可逆），注释里写着「与 tokens 那边逐字同构，
 * 由一发双源对账钉住」。写完重读才发现那句话**站不住**：
 * 对账只能对「两边今天对同一批输入给同结论」，对不了「其中一边的规则被改了」。
 * 加一档（比如「金额超过 X 也不许远程」）只改一边的话，
 * 只要新那一档在对照表里没有样本，**对账照绿** —— 那是一条恒绿的守卫的形状
 * （0007 §1 那一族，0013 §5 那条「零判别力」是同族）。
 * 而 §11.4 这一条在代码上本来就是**同一条规则**（「这张卡允不允许被远程批」），
 * 不是两条长得像的规则。两条规则才需要对账，一条规则需要的是**一次实现**。
 *
 * 所以这里**调用** tokens.ts 那个函数。它要的输入是
 * `(approval_type, parameters 原始 JSON)` —— 也就是**库里的形状**。
 * 我原本以为这是个障碍（「通道层不该去读库」），实际不是：
 * `ChannelCardSnapshot` 本来就是调用方从库里读出来交进来的，
 * 让它带**原始 JSON 而不是解析后的对象**，通道层仍然一行 SQL 都不写，
 * 而「解析失败 ⇒ 判不可逆」那条 fail-closed 判据**天然留住了**。
 * 反过来说，如果这里交进来的是解析好的对象，那条判据**在物理上无法表达** ——
 * 解析失败在通道边界上已经被抹平了，剩下一个 `{}`，而 `{}` 看上去像「可逆」。
 * 那一刻脏 JSON 恰好给最危险的那张卡开出通道，且零报错（tokens.ts 文件头原话）。
 */
export function channelIneligibleReason(snap: ChannelCardSnapshot): string | null {
  if (isIrreversibleApproval(snap.approvalType, snap.parametersJson)) return IRREVERSIBLE_HINT;
  return null;
}

/**
 * 报错文案。**必须说清去哪做**，因为这条拒绝的修法不是「重试」。
 * 只说「不允许」的话，用户会点第二次，第三次，然后把卡片丢掉 ——
 * 那一格的后果不是报错，是【这张卡永远没人处理】。
 */
export const IRREVERSIBLE_HINT =
  "不可逆操作不允许在 IM 里批准，请在桌面端或移动端确认。";

/**
 * 幂等键。
 *
 * 【规格】§11.2 那句「飞书会重投」是这一格存在的全部理由。
 * 判据的**层级**是选过的，而选错一层不会报错：
 *  - 只用 `deliveryId` ⇒ 平台重投挡住了；**我们自己重试 send** 挡不住。
 *  - 只用 (通道, 会话, 卡, 动作) ⇒ 两种都挡住了，但**同一个人真的点了两次**
 *    （第一次没等到回音，又点一次）也被吞掉。
 *
 * 后者是可接受的，而且比看上去准：`resume` 这个动作本身就是幂等的
 * （`applyDecision` 用条件 UPDATE，第二次抢不到 ⇒ `replayed: true`），
 * 所以「第二次点击」在业务上本来就该是 no-op。
 * 而前者不可接受：一次真实的重复决策在 append-only 审计里是**两行**，
 * 回放时同一张卡批过两次（0010 §4 记的正是这个形状）。
 *
 * 所以 key 里带 `approvalId` + `resume`，**不依赖平台给不给 deliveryId**。
 * `deliveryId` 只进 `channelDeliveryKey`，作为**额外一层**（有就更细），
 * 而不是作为**唯一一层**（没有就整条判据消失）。
 */
export function channelActionKey(e: ChannelEnvelope, action: CardAction): string {
  return [
    e.message.channelId,
    e.message.conversationId,
    e.message.senderId,
    action.approvalId,
    action.resume,
  ].join(ACTION_KEY_SEP);
}

/** 平台投递去重（可选的那一层）。 */
export function channelDeliveryKey(e: ChannelEnvelope): string | null {
  return e.deliveryId === null ? null : e.message.channelId + ACTION_KEY_SEP + e.deliveryId;
}

/* ------------------------------------------------------------------ *
 * 编排
 * ------------------------------------------------------------------ */

/**
 * 通道运行时：注册、拉取、判定、去重。
 *
 * 它**不写库、不发 HTTP**。落库只能通过注入的 `act`。
 * 这不是洁癖而是这一层的**测试面**：所有写动作都通过注入出去，
 * 所以「拒了到底有没有写库」这类断言可以写成「那个回调有没有被调用」，
 * 而不是去数 `events` 表行数（0026 §2 同一条理由：有真事件在飞的时候，
 * 数行数是在噪声上找信号）。
 *
 * ⚠ 本模块**确实** import 了 `http/tokens.ts`，而只 import 一个纯谓词
 * （`isIrreversibleApproval`，两个字符串进、一个布尔出，不碰 db）。
 * 上面那句「不写库」说的是**运行时行为**，不是 import 图上没有那个模块 ——
 * 之所以值得单独交代：读这一层的人会合理假设「channels 不该依赖 http」，
 * 而那条假设今天已经不成立。选它的理由写在 `channelIneligibleReason` 上面
 * （一条规则只实现一次），代价是这条依赖边；如果哪天要解开，
 * 正解是把那个谓词提到一个两边都依赖的中立模块，**不是**在 channels 里再写一遍。
 */
export interface ChannelRuntimeDeps {
  readonly now: () => number;
  /** 拿一张卡片的当前状态。返回 null = 这张卡不存在（或已不可见）。 */
  readonly loadCard: (approvalId: string) => ChannelCardSnapshot | null;
  /**
   * 把一次已批准的点击落成一次决定。**这一层不认识 approvals，也不认识 HTTP。**
   *
   * ⚠ 【审计不在这里】，是 `act` 实现方的责任，而这一点一度让我写出一个**双重审计**：
   * 第一版这里有一个 `deps.audit` 回调，运行时在 act 成功之后调它记一条
   * 「这条决定是从 IM 进来的」。看上去只是补一个来源标签，实际是**同一件事记两行**——
   * `act` 的实现必然走 `applyDecision`，而那条路径已经在同事务里写了
   * 一条 `ApprovalDecided`（含 actor）。多出来的那一行不是补充信息，是**第二个事实源**：
   * 它会与真那条在时间、在 actor、在有没有写成功上各自漂移，
   * 而审计库是 append-only 的 —— 漂了改不掉（0010 §4 同一条）。
   * 来源（哪条通道）该进的是**那一行**的 payload，不是新加一行。
   * 所以这里刻意不给 audit 口子，并在 `ChannelActRequest.viaChannelId` 上
   * 把「来源」交给实现方自己去落到那一行里。
   *
   * 同理，**不要**在这里记 `ApprovalTokenRedeemed`：那个 kind 说的是
   * 「一张凭据被消费掉了，而决定可能随后发生、也可能永远不发生」
   * （role-memory.ts 正是按这句话把它从记忆里过滤掉的）。
   * IM 这条路上**没有票**，记它就是造一条没发生过的凭据消费记录，
   * 而且它会被那道过滤器**当成非决定**丢掉 —— 一个既虚假又隐形的双重错误。
   */
  readonly act?: (o: ChannelActRequest) => Promise<ChannelActResult> | ChannelActResult;
}

/** 运行时给一次入站的判决。 */
export type ChannelVerdict =
  | {
      readonly kind: "acted";
      readonly approvalId: string;
      readonly resume: ResumeValue;
      /** 来自 act：这一次抢到了没有。false = 有别人先批了，本层**不**把它算成失败。 */
      readonly replayed?: boolean;
    }
  | { readonly kind: "ignored_not_action" }
  | { readonly kind: "duplicate"; readonly key: string }
  /** 卡片不在库里。修法：检查同步延迟 / 等建卡方接上。 */
  | { readonly kind: "card_missing"; readonly approvalId: string }
  /**
   * 卡片在库里而**已经不是待批**。与 card_missing 分开，因为修法不同：
   * 这一条的修法是「什么都不用做，已经有人批过了」。混在一起的代价见
   * handleInbound 第⑤步那段（那是我这次写的一发，最初两格是合成一发的）。
   */
  | { readonly kind: "card_decided"; readonly approvalId: string; readonly status: string }
  | { readonly kind: "not_actionable"; readonly reason: string }
  /** 通道本身不许承载决定（`canAct` 那一格）。 */
  | { readonly kind: "channel_refused"; readonly reason: string }
  | { readonly kind: "unauthorized"; readonly senderId: string }
  | { readonly kind: "failed"; readonly why: string };

/** 一轮 pollAll 里，一条消息的判决。 */
export interface ChannelHandled {
  readonly key: string;
  readonly verdict: ChannelVerdict;
}

/**
 * 一轮 pollAll 的产出。
 *
 * `got` 与 `handled.length` **必须相等**，而把它们分成两个字段而不是只留一个，
 * 是为了让「取走了却没处理」这件事在**数据上可见**：
 * 只报 handled.length 的话，一个把消息取走又丢掉的实现会报出一个自洽的数字；
 * 两个都在，那一发测试就能直接比它们（见 channel.test.ts「取走的每条都必须被判决」）。
 */
export interface ChannelPollRound {
  readonly channelId: string;
  readonly got: number;
  readonly handled: readonly ChannelHandled[];
  /** `pull()` 自己抛了。与「本轮 0 条」是两个事实，不能合并。 */
  readonly failedOpen: boolean;
}

/**
 * 一张卡片在通道层的样子 —— **字段与 `approvals` 那一行一一对应**。
 *
 * ⚠ `parametersJson` 是**原始 JSON 文本**而不是解析后的对象，这不是偷懒而是必须：
 * §11.4 那条判据最重要的一档是「**解析不出来 ⇒ 按不可逆处理**」
 * （tokens.ts 的 isIrreversibleApproval 第③条，那一档的全部意义就在这）。
 * 如果通道层拿到的是解析后的对象，「解析失败」这件事**在边界上已经被抹平**，
 * 剩下一个 `{}` 或 `null`，看上去与「没带 irreversible 标记」一模一样，
 * 而后者是可逆的 —— 那一刻一条脏 JSON 就恰好给最危险的那张卡开出了 IM 通道，
 * 且零报错。让文本穿过边界，那条判据才有物理载体。
 *
 * ⚠ `evidenceRefs` **可空，而原因是缺陷不是设计**：【规格】§9.2 那个「三行固定」的
 * 第三行是证据链接，而**一张卡片指不回它是靠哪份证据建的**（实测，别信我这段话，
 * 自己跑一遍 `PRAGMA table_info(approvals)`）：
 *   · `approvals` 一共 15 列，**没有一列与证据相关**，也没有指向证据包的外键；
 *   · 证据本身**在库里** —— `evidence_bundles.artifacts`（路径 / sha256 / 外链）与
 *     0002 补的 `claims`（逐条主张的 `evidence_refs`）。`review_gates` 还有一条
 *     `evidence_bundle_id` 指向它。**缺的不是数据，是【卡片 → 哪份证据】那条边**；
 *   · 所以想给卡片补上第三行，只能按 `task_id` 猜「大概是那个 bundle」，
 *     而一个任务上 bundle 是按 (bundle_type × 轮次) 多份的 —— 猜出来的那一份
 *     可能不是当初升级决策依据的那一份。
 *
 * 这件事**本模块补不了**：加那条边是一次迁移 + 一个「谁在建卡时负责写下它」的
 * 决定（建卡方 `createCard` 的调用点今天是零，0026 §1），都超出「通道抽象层」这一篇。
 * 本篇只做一件在范围内的事：**把它留成类型上可见的形状**（`| null`），
 * 而不是塞一个 `[]` 把它抹平 —— `[]` 会让适配器渲染出「证据：无」，
 * 那是把【我们没存这条边】说成【这张卡没有证据】，对 CEO 是两个完全不同的结论：
 * 前者是系统的缺口，后者是那个任务的产出方没交东西，**后者会被当成一次追责依据**。
 */
export interface ChannelCardSnapshot {
  readonly approvalId: string;
  readonly taskId: string;
  readonly summary: string;
  readonly approvalType: string;
  readonly status: string;
  readonly parametersJson: string | null;
  readonly evidenceRefs: readonly string[] | null;
  readonly recommendation: string | null;
  readonly timeoutBehavior: string | null;
}

/**
 * 谁在点。
 *
 * ── 更正一处我原先写错的事实（别信下面这段的第一版）──────────────────
 * 我原本在这里写的是「那张绑定表**今天不存在**，`roles/` 里没有 IM 账号这一列」。
 * **那句是错的**，而且错的方向很坏：它把一个「表在、读写方为 0」的缺口
 * 说成了「表都不在」，后者听起来像「这事要从头设计」，前者才是真相 ——
 * 一张 0001 就建好的表在等它的读写方（同 0027 §0 那张 `im_tokens` 零写入方）。
 * 实测（`grep -rn im_bindings`，src 与 test 全仓）：
 *   · 表**在** `resources/migrations/0001_init.sql:249`，列是
 *     `id / platform / external_user_id / ceo_role / verified / created_at`；
 *   · 读写方 **0 处** —— 全仓没有任何一条 SQL 碰过它。
 *
 * ⚠ 而这张表的默认值本身是一个陷阱，所以判据仍然写在这里：
 * `ceo_role TEXT NOT NULL DEFAULT 'ceo'` —— **每一行绑定默认就指向 CEO 角色**，
 * 而 `verified INTEGER DEFAULT 0` 默认是「没验过」。
 * 于是「把 `actorFor` 直接接到这张表上」这一行代码今天会造出：
 * 任何一个在这个平台上发过消息、且有人替他插过一行绑定的账号，
 * **默认就是 CEO**，而那行绑定有没有被验证过完全不看。
 * 这不是待补的缺口，是**一条能批准的冒充通道**，而且它今天全部测试都会绿。
 * 所以本层的判据写成：`actorFor` 返回 null ⇒ 未授权 ⇒ 拒，**默认就是 null**；
 * 接这张表的那个人必须自己回答「`verified = 0` 的行算不算数」。
 * 缺的是生产者与那次校验，不是判据，更不是那张表。
 */
export interface ChannelActor {
  readonly senderId: string;
  readonly channelId: string;
}

export type ChannelActVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface ChannelActRequest {
  readonly approvalId: string;
  readonly taskId: string;
  readonly resume: ResumeValue;
  readonly note?: string;
  readonly actor: ChannelActor;
  readonly viaChannelId: string;
  readonly receivedAtMs: number;
}

export type ChannelActResult =
  | { readonly ok: true; readonly replayed?: boolean }
  | { readonly ok: false; readonly why: string };

/**
 * 通道实例的运行时容器。
 */
export interface ChannelRuntime {
  readonly deps: ChannelRuntimeDeps;
  register(channel: Channel): void;
  channels(): readonly Channel[];
  /**
   * 拉一遍所有通道，交出**每一轮的完整判决**（见 `ChannelPollRound`）。
   *
   * ⚠ 返回的不是「每条通道取到几条」一个数字。这个数字曾经是本函数的全部产出，
   * 而那个写法有一个致命的洞：`got: c.pull().length` **取走了消息又不处理**，
   * 于是每一轮 poll 都在制造一个「数量正确的销毁证明」。
   * 保留 `got` 而把 `handled` 一起交出去，就是为了让两者可以互相质疑。
   */
  pollAll(): Promise<readonly ChannelPollRound[]>;
  /** 处理一条入站。 */
  handleInbound(channel: Channel, e: ChannelEnvelope): Promise<ChannelVerdict>;
  /** 已见过的动作键数量（幂等表的大小，也是内存增长的可观测点）。 */
  seenCount(): number;
  seenKeys(): readonly string[];
}

export interface CreateChannelRuntime {
  readonly deps: ChannelRuntimeDeps;
  /**
   * 发送者 → 内部角色的解析。**必须显式注入**，见 ChannelActor 上面那段。
   * 不传 = 所有入站都判未授权（安全默认）。
   */
  readonly actorFor?: (actor: ChannelActor) => ChannelActor | null;
}

/**
 * 造一个运行时。
 */
export function createChannelRuntime(o: CreateChannelRuntime): ChannelRuntime {
  const byId = new Map<string, Channel>();
  // 幂等表用一个 Set 而不是 LRU。
  //
  // ⚠ 这是一个**已知的内存增长点**，而它今天没有被挡住，理由写在这里而不是等出事再解释：
  // 每一个「唯一的一次点击」永久占一条记录。按 CEO 一天 50 次点击 × 365 天
  // ≈ 1.8 万条 / 年，量级无害；但如果将来接了群聊里所有人都能点的场景，
  // 这一格会变成「Hub 长跑之后越来越胖，且重启前不会缩」。
  // 正确的修法不是 LRU —— **LRU 会静默打开重放的门**（被逐出的那条重投就能重放），
  // 那正是本层要防的东西。正解是加 TTL 并让 TTL **不小于**卡片的可决策窗口
  // （卡片已决策之后，重放本来就被条件 UPDATE 挡掉了，那时这条记录才可以丢）。
  // 今天不做，因为卡片今天没有「多久之后重放必然无害」这个数（超时行为没有执行者，0026 §3）。
  const seen = new Set<string>();

  /**
   * 判决本体。写成【函数】而不是对象方法，是为了让 pollAll 能直接调它 ——
   * 如果只有 `this.handleInbound(...)`，pollAll 就得引用返回对象自己，
   * 而那个 self-reference 在对象字面量里要用一个中间变量绕，
   * 绕的方式有一种（先构造对象再补方法）会让「方法里的 this」变成运行期才成立的东西。
   */
  async function handleOne(channel: Channel, e: ChannelEnvelope): Promise<ChannelVerdict> {
    const msg = e.message;
    // ① 不是卡片动作 ⇒ 直接不处理。**不报错**。
    //
    // 为什么不报错：IM 里绝大多数消息是闲聊、@、贴图。把「不能承载审批」
    // 做成一个错误，唯一的下游效果是日志被刷满，而刷满的日志会把**真错**淹掉。
    // 「所有告警都响」等于「没有告警」（0019 §5 那条同族）。
    if (msg.kind !== "card_action") return { kind: "ignored_not_action" };

    const action = parseCardAction(msg);
    if (action === null) return { kind: "failed", why: "card_action 载荷不完整" };

    // ② 身份。放在最前面，在**任何**库读之前。
    //
    // 为什么在 loadCard 之前：一个未授权的人可以靠「发无数张卡片的 id 过来」
    // 让 Hub 为每一次点击做一次库读。放在前面之后，未授权的成本是零。
    // （这不是防 DoS 的主要手段 —— 那是 §20 网络边界的事 ——
    //  但「先鉴权再查库」是一条不需要成本就该守的顺序，而反过来的写法
    //  在 code review 里几乎不可能被看出来。）
    const actor = o.actorFor?.({ senderId: msg.senderId, channelId: msg.channelId });
    if (actor === null || actor === undefined) {
      return { kind: "unauthorized", senderId: msg.senderId };
    }

    // ③ 通道本身的许可（平台属性）。在幂等表**之前**。
    //
    // 顺序在这里是承重的，而且错法是**静默的**：如果把 canAct 放在
    // 记键之后，一条被通道拒掉的点击会**占住那个键**，于是这个人
    // 换到允许的通道（桌面、或另一个 IM）去点同一张卡 ⇒ 被判 duplicate ⇒
    // **他的决定被吞掉，而他看到的是「已经处理过了」**。
    // 这一条不是假想的：QQ 只读 + 飞书可批是 §11.2 明确会同时存在的配置。
    const verdict = channel.canAct?.(actor);
    if (verdict !== undefined && verdict.ok !== true) {
      return { kind: "channel_refused", reason: verdict.reason };
    }

    // ④ 幂等。
    const key = channelActionKey(e, action);
    if (seen.has(key)) return { kind: "duplicate", key };

    // ⑤ 卡片状态 + §11.4 可逆性。
    const card = o.deps.loadCard(action.approvalId);
    if (card === null) {
      // 卡片不存在 ⇒ **不记键**。这张卡哪天存在（延迟建卡、旁路写入），
      // 那一次点击仍然该被处理；记了键就变成「永远处理不了」。
      return { kind: "card_missing", approvalId: action.approvalId };
    }
    if (card.status !== APPROVAL_STATUS_PENDING) {
      // 已经决策过。**不能**复用上面对「卡片不存在」的那个判决 ——
      // 我把两种「loadCard 给不出可决策的卡」合成一个 card_missing 写过一版，
      // 短了两行，而代价是界面只能说「找不到这张卡」。
      // 那时用户看到的是【一张他从没见过的卡片消失了】，而真相是
      // 【这张卡已经被批过了】—— 两种情形的修法完全不同：
      // 前者该去检查是不是同步延迟，后者该安心。
      // tokens.ts 那边把同一个分歧写得更狠（404 与 409 分开，「你点晚了」不是
      // 「你参数错了」），这里是同一条口径的 IM 版本。
      // 与上面那格一样**不记键**：重放本来就被 applyDecision 的条件 UPDATE
      // 挡住（`replayed: true`），而把「已经批过」报成一个明确判决，
      // 比把它压进一次静默去重要有用。
      return { kind: "card_decided", approvalId: action.approvalId, status: card.status };
    }
    const ineligible = channelIneligibleReason(card);
    if (ineligible !== null) {
      return { kind: "not_actionable", reason: ineligible };
    }

    // ⑥ 记键。放在**所有校验之后、真正落库之前**。
    //
    // 为什么不放最前（那样更省事）：任何一次**失败**都会永久吃掉这个动作，
    // 用户重试点同一张卡 ⇒ duplicate ⇒ **一个决定被一次网络抖动吃掉**。
    // 为什么不放最后（落库成功之后）：落库成功而记键之前崩了，
    // 重投会**再落一次** —— 但那条路径上 approvals 的条件 UPDATE 会挡写入，
    // 只多一条审计行（吵）；而放前面的坏法是吞掉一个决定（吞）。
    // 本仓的一贯取向：宁吵不吞（0026 §5、tokens.ts 文件头那条同族选择）。
    seen.add(key);

    if (o.deps.act === undefined) {
      // 没有落库点 ⇒ **撤销那把键**，理由与下面 catch 那一支完全相同：
      // 这一发没有落成，而键留着会让「装配补好之后有人重试」被判 duplicate。
      // 第一版这里直接 return 而没有删键，于是「忘记注入 act」这个装配错误
      // 的**全部后果**是：CEO 在装配修好之前的那一次点击被永久吃掉。
      seen.delete(key);
      return { kind: "failed", why: "装配未提供 act 落库点" };
    }
    const req: ChannelActRequest = {
      approvalId: action.approvalId,
      taskId: card.taskId,
      resume: action.resume,
      ...(action.note === undefined ? {} : { note: action.note }),
      actor,
      viaChannelId: msg.channelId,
      receivedAtMs: e.receivedAtMs,
    };
    try {
      const r = await o.deps.act(req);
      if (r.ok !== true) {
        // 与抛错同一处理：没落成就得把键还回去，否则「act 返回一个业务失败」
        // 会变成一次永久性的决定丢失。
        seen.delete(key);
        return { kind: "failed", why: r.why };
      }
      return {
        kind: "acted",
        approvalId: action.approvalId,
        resume: action.resume,
        ...(r.replayed === undefined ? {} : { replayed: r.replayed }),
      };
    } catch (err) {
      // 落库抛错 ⇒ **撤销那把键**。
      //
      // 这一行是整个幂等表里最不直观的一格，所以写清：抛错意味着
      // 「这一次没有落成」，而键还在 ⇒ 用户重试被判 duplicate ⇒
      // **一次数据库抖动永久吃掉一个决定**，且症状是「我点了说已经处理过了」。
      // 反过来「不撤销」的写法有一个听上去成立的理由：
      // 「防止一次失败的重试风暴把库打穿」。那个理由在**这条**通路上不成立 ——
      // 决定是幂等的（条件 UPDATE），重试的代价最多一次 UPDATE，
      // 而限流是网络边界的事，不该由一张审批的去重表兼职。
      seen.delete(key);
      return { kind: "failed", why: String(err) };
    }
  }

  return {
    deps: o.deps,
    register(channel: Channel): void {
      const existing = byId.get(channel.id);
      if (existing !== undefined && existing !== channel) {
        // 两个通道抢同一个 id：拒。
        //
        // 为什么这是**抛错**而不是「后者覆盖前者」：覆盖之后，第一个通道的长连接
        // 还活着（它的 pull 还能取到消息），而注册表里已经没人引用它了 ——
        // 于是它的消息**永远不会被处理，也永远不会有人知道**。
        // 「安静的孤儿连接」是 0025 §3 那一族。
        //
        // ⚠ 同对象重复注册**放行**（上面那个 `existing !== channel` 的判据）。
        // 那一格不是随手加的宽松：装配层热重载、以及测试里「先注册再复用同一个假通道」
        // 都会拿**同一个实例**注册两次，那种情况下什么都没坏（不会有孤儿，
        // Map 里就是那一个），而拒它会让每一次测试装配都得记得先清表。
        // 判据要精确命中那个坏形状（**不同**实例抢同一个 id），不要顺手扩大到「重复注册」。
        throw new Error(
          "通道 id 冲突：" +
            channel.id +
            "。两个【不同的】通道共用一个 id 会让先注册的那个变成孤儿" +
            "（连接还活着而没人取它的消息），那没有任何症状。",
        );
      }
      byId.set(channel.id, channel);
    },
    channels(): readonly Channel[] {
      return [...byId.values()];
    },
    async pollAll() {
      const out: ChannelPollRound[] = [];
      for (const c of byId.values()) {
        // 一条通道抛错【不能】带走其余通道。
        //
        // 第一版这里没包 try —— 一个飞书适配器在 fetch 里抛，会让整轮 pollAll 抛出，
        // 于是 QQ、企微这些**健康的通道**这一轮也拿不到消息。
        // 而巡检是周期性的，下一轮再抛一次 ⇒ **一条坏通道让所有通道静默停摆**，
        // 症状是「手机推送最近不来了」而不是「某个通道报错了」。
        let envelopes: readonly ChannelEnvelope[];
        try {
          envelopes = c.pull();
        } catch (e) {
          out.push({ channelId: c.id, got: 0, handled: [], failedOpen: true });
          // 抛错必须被留下，而不是塞进 got: 0（0 与「坏了」是两个事实）。
          console.error("[channel] pull 失败 " + c.id + "：" + String(e));
          continue;
        }
        const handled: ChannelHandled[] = [];
        for (const e of envelopes) {
          // ⚠ **取回来的每一条都必须被处理**。这一行是本模块最贵的一格，
          // 而它写成的形式是「显然对」的那种，所以把它被写错的样子记下来：
          // 我的第一版是 `out.push({channelId: c.id, got: c.pull().length})` ——
          // 一个「本轮取到几条」的观测点，短得看不出问题，而 `pull()` 的语义是
          // **取走即从适配器队列移除**（见 Channel.pull 的注释）。
          // 两者合起来的后果是：**每一条审批消息都在每一轮 poll 里被取出并丢掉**，
          // 不报错、不计数、卡片永远停在 pending，而日志里那一行还写着
          // 「本轮取到 3 条」—— 一个数量正确的**销毁证明**。
          // 这正是计划 Task 4.4 那句「不得静默吞掉审批」字面禁止的事。
          // 修法没有第二种：取走就必须交给 handleOne。
          // 而它【必须】能被测试发现 —— 所以判决要带出去，而不是只留一个 got 数字。
          handled.push({ key: channelEnvelopeKey(e), verdict: await handleOne(c, e) });
        }
        out.push({ channelId: c.id, got: envelopes.length, handled, failedOpen: false });
      }
      return out;
    },
    seenCount(): number {
      return seen.size;
    },
    seenKeys(): readonly string[] {
      return [...seen];
    },
    handleInbound: handleOne,
  };
}

/**
 * 一条信封的稳定标识，只为让测试能对上「哪条消息得到哪个判决」。
 * 不参与任何判据（幂等用的是 channelActionKey，那是另一回事）。
 */
export function channelEnvelopeKey(e: ChannelEnvelope): string {
  return (
    e.message.channelId +
    ACTION_KEY_SEP +
    (e.deliveryId ?? "") +
    ACTION_KEY_SEP +
    e.message.text
  );
}

/**
 * 把一条 `card_action` 的文本载荷解成 CardAction。
 *
 * 为什么要有这个函数而不让适配器直接交出 CardAction：
 * 归一化的边界在 ①（NormalizedMessage），如果 card_action 的载荷是
 * 「每个平台自己的卡片回调结构」，那 §11.3 那句「不感知平台差异」当场作废。
 * 所以载荷的**编码格式**也必须是归一化协议的一部分 —— 这里是
 * `approvalId|resume[|note]`（见 `encodeCardAction`）。
 *
 * 真实实现里这一格会由适配器解成这个结构；本仓把它写成**共用的文本协议**
 * 是因为它是今天唯一能让 fake 与未来飞书共用同一判据的形状。
 * 解析不出来 ⇒ 返回 null 而**不抛**：一条畸形消息不该让整轮 poll 失败。
 */
export function parseCardAction(msg: NormalizedMessage): CardAction | null {
  const parts = msg.text.split("|");
  if (parts.length < 2) return null;
  const approvalId = parts[0] ?? "";
  const resume = parts[1] ?? "";
  if (approvalId.length === 0) return null;
  if (!isResumeValue(resume)) return null;
  const note = parts.slice(2).join("|").trim();
  return {
    approvalId,
    resume,
    ...(note.length > 0 ? { note } : {}),
  };
}

/** 编码。放在这一层是因为**发送侧与接收侧必须同协议**，两处一份就会漂移。 */
export function encodeCardAction(a: CardAction): string {
  const note = a.note === undefined || a.note.length === 0 ? "" : "|" + a.note;
  return a.approvalId + "|" + a.resume + note;
}

/**
 * 正向穷尽守卫（同 tokenHttpStatus / KIND_TO_ACTION 那个手法）。
 *
 * ⚠ 为什么这里需要它而 switch 里也需要：这一格的调用点在**适配器**里
 * （渲染按钮时用它过滤平台不支持的动作）。没有这个函数，
 * 适配器会写 `resume as ResumeValue`，而那一刻类型检查就没了。
 */
export function isResumeValue(v: string): v is ResumeValue {
  return (RESUME_VALUES as readonly string[]).includes(v);
}

/**
 * 卡片快照 → 出站卡片。**三行 + 三按钮的结构性要求在这里落地**。
 *
 * `buttons` 不是从入参读的，是**从 APPROVAL_BUTTONS 生成的** ——
 * 如果让调用方传，就出现「卡片上只有两个按钮」这种能编译过也能发出去的东西。
 * 数量与取值逐字对齐【规格】§9.2 与 gates.ts 那条 APPROVAL_BUTTONS。
 *
 * ⚠ 这里**不重新判可逆性**，只把调用方算好的结论搬过来（`opts.ineligible`）。
 * 判据在 `channelIneligibleReason` 一处；渲染处再判一遍就是第二条路径。
 */
export function outboundCardOf(
  snap: ChannelCardSnapshot,
  opts?: { readonly ineligible?: string | null },
): OutboundApprovalCard {
  const reason = opts?.ineligible ?? null;
  return {
    approvalId: snap.approvalId,
    taskId: snap.taskId,
    summary: snap.summary,
    // 解析失败 ⇒ null。适配器**必须**把 null 渲染成「参数不可读」而不是空表：
    // 一张参数空白的卡看起来像「没有参数」，那是两种不同的无知
    // （同 §8.2 那条「把『没有』和『为空』混起来」）。
    parameters: parseParametersObject(snap.parametersJson),
    evidenceRefs: snap.evidenceRefs,
    recommendation: snap.recommendation,
    timeoutBehavior: snap.timeoutBehavior,
    buttons: APPROVAL_BUTTONS,
    actionable: reason === null,
    ...(reason === null ? {} : { notActionableReason: reason }),
  };
}

/**
 * 尽力解析 parameters，只为**渲染**。解析不出来给 null。
 *
 * 与 `channelIneligibleReason` 里那次解析**不冲突也不重复**：
 * 那一次判的是「能不能批」，走的是 tokens.ts 的判据（解析失败 ⇒ 不可逆）；
 * 这一次判的是「参数那一栏显示什么」。两次解析对同一份文本，
 * **不可能漂移出安全问题** —— 因为最坏情况是「卡片不可批而参数显示为空」，
 * 两个坏加在一起仍是安全的方向。
 */
export function parseParametersObject(
  json: string | null,
): Record<string, unknown> | null {
  if (json === null || json.trim() === "") return null;
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
    return v as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 「这条通道收得到点击回传吗」为否时，卡片上那句话的文案。
 *
 * 为什么是「降级成只读」而**不是「干脆不发」**：不发的那张卡在主界面上是
 * 【不存在】，而 CEO 需要看到的是「这件事在等你，只是不能在这里点」。
 * 三行照样齐全（§9.2），只是按钮不可点 —— 与「这张卡没有按钮」是两个结论
 * （同 evidenceRefs 那条 `null` 与 `[]` 的分别）。
 */
export const ACTION_RETURN_HINT =
  "这个通道收不到按钮的回传，本卡只读；请到桌面端或移动端批准。";

/** `deliverCard` 的结果。 */
export type ChannelDeliverOutcome =
  | { readonly kind: "sent"; readonly card: OutboundApprovalCard }
  | { readonly kind: "send_failed"; readonly why: string };

/**
 * 把一张卡片送上一条通道。**这是 `supportsActionReturn` 与 `Channel.send` 唯一的读者。**
 *
 * ── 为什么要有这个函数（它一开始不在计划里）──────────────────────────
 * 写完 `Channel` 之后重读一遍，发现 `supportsActionReturn` 这一格**没有任何代码读它**，
 * 而 `send` 也没有任何调用点。一个没人读的属性就是一件**装饰**：
 * 它能编译、能被 fake 如实设置、能全部测试通过，而它的有无不改变任何行为 ——
 * 那正是 0027 §2 那条「自称结构守卫而实际测不到它声称的那件事」的形状，
 * 只是发生在**源码**里而不是测试里。装饰的属性比没有属性更糟：读代码的人会以为那条限制生效了。
 *
 * 所以补这一格，而不是把那个属性删掉。删掉确实更短，而 §11.2 那条
 * 「QQ 主动消息有条数限制、以被动回复为主」是**真实存在的平台差异**，
 * 它需要代码上的落点；缺的从来不是那条事实，是读它的那行代码。
 *
 * 编排放在这里的另一件事：**发送失败不许抛出去**。
 * `Channel.send` 那格的注释写的是「失败要抛，由通道编排层决定怎么报」，
 * 而这里就是那一层。往上抛的后果不是报错而是**少一张卡**：
 * 抛到 poll 循环里 ⇒ 那一轮剩下的卡片发不出去（同 pollAll 那条「一条坏通道带走全部」），
 * 而卡片在库里仍是 pending，没有任何地方记「送出去过而失败了」。
 * 报成一个判决值，调用方就能选择重试 / 告警 / 转桌面端推送。
 */
export async function deliverCard(
  channel: Channel,
  snap: ChannelCardSnapshot,
  opts?: { readonly ineligible?: string | null },
): Promise<ChannelDeliverOutcome> {
  // 可逆性那一档**不在这里重算**（判据只在 channelIneligibleReason 一处），
  // 这里做的是在它**之上**再叠一条与卡片内容无关的通道属性：
  // 一张本来可批的卡，走在收不到回传的通道上，就必须以只读的形态出去。
  const declared = opts?.ineligible ?? channelIneligibleReason(snap);
  const reason =
    channel.supportsActionReturn === true ? declared : (declared ?? ACTION_RETURN_HINT);
  const card = outboundCardOf(snap, { ineligible: reason });
  try {
    await channel.send(card);
  } catch (e) {
    return { kind: "send_failed", why: String(e) };
  }
  return { kind: "sent", card };
}

/**
 * 关停所有通道，**一个失败不许带走其余**。
 *
 * 与 pollAll 那条同形而方向相反（一个是进、一个是出），
 * 也共享同一条坏法：`Promise.all(ch.map(close))` 在第一个 reject 时整批失败，
 * 于是其余通道的连接**留在原地的没人知道** —— 关机之后还有连接在收消息，
 * 而消息落在一个已经关掉的 Hub 上。那种孤儿比不关机更难查。
 */
export async function shutdownChannels(
  channels: readonly Channel[],
  onError: (channelId: string, e: unknown) => void = () => {},
): Promise<readonly string[]> {
  const failed: string[] = [];
  for (const c of channels) {
    try {
      await c.close();
    } catch (e) {
      failed.push(c.id);
      onError(c.id, e);
    }
  }
  return failed;
}
