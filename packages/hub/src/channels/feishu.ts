/**
 * 飞书通道适配器（O12 动作 2）—— 全仓第一个真的 IM 适配器。
 *
 * ── 它补的是哪一格 ────────────────────────────────────────────────────
 * `abstraction.ts` 1001 行把策略、幂等、身份编排全写完了，而它「对外零 import」的
 * 原因是【没有任何一个真的适配器文件】；`approval-bridge.ts`（round280）把两端接上了，
 * 而它自己从任何生产入口走不到。这个文件是那两格共同缺的读者。
 * ⚠ 上面那两句是【本篇开工之前】的现状，留着是因为它们是本篇存在的理由；
 * 本篇之后（round281）这两格都由 `serve/im-channels.ts` + `serve/assemble.ts` 的 `boot()`
 * 补上了 —— 也就是说本文件现在【在生产路径上】，它抛出的每一个错都会打到某个人的终端上。
 *
 * ── 出站 / 入站为什么不对称 ────────────────────────────────────────────
 * 出站发一张真交互卡（三个按钮，`value` 里带 `encodeCardAction` 那条共用文本协议），
 * 这一段【不依赖】任何回调路线能否跑通，现在就能用。
 * 入站【只走轮询】：Hub 的 HTTP 面按 0031 只绑回环（`bind.ts`），
 * 于是飞书能摸到的回调地址【物理上不存在】。所以卡片回传走
 * 「事件订阅开长连接推给 SDK ⇒ 适配器私有队列 ⇒ `pull()` 被心跳拉走」，
 * 而长连接没接时退回 `im_message_read` 轮询 —— 每条都读得回，代价是延迟。
 * ⚠ `supportsActionReturn` 因此【不是常量】：两条路都断时它必须是 false，
 * 让卡片以只读形态出去（`deliverCard` 会挂上 `ACTION_RETURN_HINT`）。
 * 发一张带按钮而没人收的卡，比发一张只读卡坏得多（0025 §3 那个形状）。
 *
 * ── 为什么没有 `onMessage`，队列是私有的 ───────────────────────────────
 * `abstraction.ts` 文件头把这条立场写死了：回调式入站会造出【第二条入站路径】
 * —— 一条从 `handleInbound` 进（有策略、有幂等、有审计），一条从回调进（什么都没有）。
 * 所以这里的推送只往 `#queue` 里放，出队只有 `pull()` 一个口子。
 * 入队走 `boundedPush`（溢出必须计数、且必须上报 —— `onOverflow` 是必填的）。
 *
 * ── 远端形状【实测】，本文件里的字段名不背 ──────────────────────────────
 * `FEISHU_SHAPE_EVIDENCE` 那一段是 2026-11-17 对 open.feishu.cn 逐条查证的读数，
 * 每条带官方 URL。写下来是因为本仓最贵的那一族就是「当年对的读数被当成今天的」：
 * 哪天某条路径或字段变了，红的是 `feishu.test.ts`，报错里就写着去哪核对。
 * 它【不是】端到端验证 —— 没有任何一发真打过飞书。
 *
 * ── 没做的一件，与一件已做的更正 ──────────────────────────────────────
 * ① 没接飞书官方 SDK（`@larksuiteoapi/node-sdk` 能装，round278 实测）。
 *    轮询那半边四个 HTTP 调用用不到它；接进来买到的只有长连接，
 *    而那一样归装配方注入（`longConnection` 那一格）。⇒ 运行时依赖仍是零。
 * ② ⚠ 这里原本登记的是「没有发卡的生产触发点：`deliverCard` 在 src 里今天
 *    【仍然】零调用方」—— 那句随 round283（O12 动作 4）过期：`serve/im-channels.ts`
 *    每一轮心跳在判完回传之后调 `runDeliverPass`，它经 `channels/deliver.ts`
 *    发这一张卡，幂等由库里的 `card_deliveries` 挡（跨重启）。
 *    仍然真的那条是：【真飞书接口在本机一次也没打通过】，本文件全部绿都绿在
 *    注入的 `fetchImpl` 上 —— 射程见 `FEISHU_SHAPE_EVIDENCE` 与 r16/r17。
 */
import type { ResumeValue } from "@opc/contracts";
import type {
  Channel,
  ChannelActor,
  ChannelActVerdict,
  ChannelEnvelope,
  NormalizedMessage,
  OutboundApprovalCard,
} from "./abstraction.js";
import {
  boundedPush,
  CHANNEL_QUEUE_LIMIT,
  encodeCardAction,
  parseCardAction,
} from "./abstraction.js";

/** 注入的那一小片 fetch。口径同 `desktop/src/main/signed-fetch.ts`：只留真用到的成员。 */
export interface FeishuFetchResponse {
  readonly status: number;
  json(): Promise<unknown>;
}
export interface FeishuFetchInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  /**
   * 这一发的截止信号。**适配器每一发都交出一个真的**，注入实现必须读它。
   *
   * 为什么信号由【这里】造而不是由 `defaultFetch` 造：那样注入方（接真 SDK 那一条）
   * 才看得见同一个截止，而不是各加各的、或谁都没加。代价也要说出来 ——
   * ⚠ 注入实现若【不读】 `signal`，超时那一格在结构上就测不到，假 fetch 一路绿。
   *    ⇒ 真凭据在两处：`feishu-http.test.ts` 那两发【真 socket 不答】打在 `defaultFetch` 上，
   *      以及下面那几发钉「每一次 `#fetch` 都带着一个会自己到点的 signal」。
   */
  readonly signal?: AbortSignal;
}
export type FeishuFetch = (
  url: string,
  init: FeishuFetchInit,
) => Promise<FeishuFetchResponse>;

export const FEISHU_DEFAULT_ORIGIN = "https://open.feishu.cn";

/** 一条实例的必填项。`appId` / `appSecret` 建议走 env，别写进配置文件。 */
export interface FeishuConfig {
  /** 通道实例 id（不是平台名）。两个飞书应用各一条时靠它区分。 */
  readonly channelId: string;
  readonly appId: string;
  readonly appSecret: string;
  /** 审批卡推给谁 —— 一个 open_id。 */
  readonly approverOpenId: string;
  /**
   * 审批人与机器人的**单聊 chat_id**（`oc_…`）。轮询读的就是这一条会话。
   *
   * ⚠ 为什么必填而不自己去查：`im/v1/chats` 那个列表返回的是【机器人所在的群聊】，
   * 里面没有「某个 open_id 的单聊」这一维 —— 我第一版写了 `items[].user_id === openId`
   * 去挑，那个字段在那条响应里【没有文档依据】（2026-11-17 查证时这条端点的响应
   * 里读不到它）。宁可让运营者填一次并在这里明说缺它，
   * 也不拿一个猜出来的字段做「读得到审批」的前提。
   * 拿它的一次机会：审批人先给机器人发一条消息，那条事件里就带着 chat_id。
   */
  readonly approverChatId?: string;
  /** 可以指国际版 `https://open.larksuite.com`。 */
  readonly origin?: string;
  /**
   * 长连接的注入点。生产上交给 `@larksuiteoapi/node-sdk` 的 `wsClient`，
   * 测试里交一个假对象。**可选**：不接也不许静默 —— 那时轮询是唯一回传路，
   * 而连轮询都跑不起来（缺 chat_id / 远端报错）就是 `supportsActionReturn === false`，
   * 卡片自己变成只读。
   */
  readonly longConnection?: FeishuLongConnection;
  /** 溢出回调。必填：静默丢一条审批是【计划 Task 4.4】明令禁止的事。 */
  readonly onOverflow: (dropped: ChannelEnvelope) => void;
  readonly now?: () => number;
  readonly fetchImpl?: FeishuFetch;
  /**
   * 每一发外网 HTTP 的自设截止（毫秒）。缺省 `FEISHU_FETCH_TIMEOUT_MS`。
   *
   * 为什么它是可配的，而不是把常量写死在调用点：测试要能在几十毫秒内看到「超时那一发
   * 确实超时」，而真等 10 秒的那一发没人会跑第二次 —— 一个跑不动的判据等于没有判据。
   * 交 0 / 负数 / 非有限数 ⇒ 回落到缺省值，**不**当成「关掉超时」：那正好是这一格
   * 存在的全部理由要防的那件事。
   */
  readonly fetchTimeoutMs?: number;
}

/**
 * 一发外网 HTTP 的自设截止。
 *
 * ── 为什么必须有 ────────────────────────────────────────────────────────
 * 心跳那一轮对 IM 走的是【派发】而不是 await（`serve/im-channels.ts` 文件头③）：
 * 一次挂在半路的外网请求如果 await 在心跳 job 里，就会走 `timer.ts` 那条
 * 「上一轮还没结束，本轮跳过」⇒ 停滞检测与每日备份被一次飞书请求停掉，不计
 * `consecutiveFailures`、不触发 `onFatal`、不退进程（0044 量过的那个静默形状换了凶手）。
 * 派发把「冻结心跳」这一半治了，但没治「这个 watch 永远不结束」：那一格占着的是一份
 * 连接 + 一份未结的 promise，而关机 `settle` 等的就是它。⇒ 超时是【一定会结束】那一半。
 *
 * ── 这个数是什么口径（别读成「一轮的上限」）──────────────────────────
 * 它是【一发】的上限。一轮最多 = 1 次取 token + N 页读消息 + 1 次发卡，所以一轮的
 * 上限随页数走，10s × N 页可以超过心跳下界 `HEARTBEAT_FLOOR_MS`（60s）。
 * 这一点可接受，正是因为上面那条派发：超轮只占住 watch 与后面的轮次，不冻结心跳。
 * 10s 这个取值是【拍的】，不是量出来的 —— 本机从未真打过飞书，没有可量的东西；
 * 它的判据只有一条：比任何合理的正常应答都宽，比「人愿意等一句『收不到』」的耐心短。
 */
export const FEISHU_FETCH_TIMEOUT_MS = 10_000;

export interface FeishuLongConnection {
  /**
   * 【注册】卡片回传的处理器，不是「事件落到这里」。
   *
   * 为什么是这个形状而不是 `onCardAction(ev)`：SDK 那侧的长连接是「先建 client，
   * 再把 dispatcher 交给 `wsClient.start({eventDispatcher})`」，而这里反过来 ——
   * 长连接对象作为 `FeishuConfig` 的一部分，在 `FeishuChannel` 构造【之前】就存在了，
   * 处理器（也就是本通道自己）那时还没诞生。所以只能由通道在 `start()` 里回头注册。
   * 调两次 = 注册两次，实现方要自己去重（本通道只在 `start()` 调一次，而 `start()`
   * 失败可重入，这条约束因此是真的会被撞到的）。
   *
   * 参数是【飞书原生事件】：归一化由本文件负责，SDK 的原生结构不许越界。
   */
  onCardAction(handler: (ev: FeishuCardActionEvent) => void): void;
  start(): Promise<void>;
  stop(): void;
}

/* ------------------------------------------------------------------ *
 * 远端形状（实测，见文件头）
 * ------------------------------------------------------------------ */

/** 所有飞书业务响应共用的信封：`code === 0` 才算成。 */
export interface FeishuEnvelope {
  readonly code?: number;
  readonly msg?: string;
}

/** `auth/v3/tenant_access_token/internal` 的成功响应。 */
export interface FeishuTokenResponse extends FeishuEnvelope {
  readonly tenant_access_token?: string;
  readonly expire?: number;
}

/** `im/v1/messages` 列表项里本适配器真读的四个字段。 */
export interface FeishuMessageItem {
  readonly message_id?: string;
  readonly msg_type?: string;
  readonly create_time?: string;
  readonly body?: { readonly content?: string };
  readonly sender?: { readonly id?: string };
}

export interface FeishuListMessagesResponse extends FeishuEnvelope {
  readonly data?: {
    readonly items?: readonly FeishuMessageItem[];
    readonly has_more?: boolean;
    readonly page_token?: string;
  };
}

/** 回传 event 里操作人与按钮数据的位置（`event.operator.open_id` / `event.action.value`）。 */
export interface FeishuCardActionEvent {
  readonly openId: string;
  /** 按钮的 `value`（那份 key-value）。 */
  readonly value: Readonly<Record<string, unknown>>;
  /** `header.event_id` —— 幂等键读它。没有就给 null，退化成靠 approvalId+resume 去重。 */
  readonly eventId?: string;
  /** `event.context.open_chat_id`：入站信封的 conversationId 读它。 */
  readonly chatId?: string;
}

/** 按钮 `value` 里那一份应用自定义数据。文档只保证「key-value 形式、key 是字符串」。 */
export const FEISHU_ACTION_VALUE_KEY = "opc";
/**
 * 自设的 `value` 长度上限。
 *
 * ⚠ **这不是飞书文档给的数** —— 2026-11-17 查证时按钮那一页只写了
 * 「仅支持 key-value 形式的 JSON 结构，且 key 为 String 类型」，**没有**公布长度上限。
 * 那一段的 `action.value` 类型也只写 `string | object`。所以这是一个【自设护栏】，
 * 它的作用是「别把 approvalId 长成一个把 content 撑爆的东西」，不是复刻某条远端规则。
 * 我第一版把它写成「实测 400，超限报 code=200684」—— 那句话没有任何实测撑着，删了。
 * 真要撞远端的真实上限，只有真发一张卡才知道，而那属于 Task 4.7 的沙箱手工验证。
 */
export const FEISHU_VALUE_LIMIT = 400;

/** 事件类型字符串：卡片回传。 */
export const FEISHU_CARD_ACTION_EVENT = "card.action.trigger";
/** URL 校验那一种回调。 */
export const FEISHU_URL_VERIFICATION = "url_verification";

/**
 * 逐条查证于 2026-11-17（open.feishu.cn 官方文档，35 次抓取里的读数）。
 * 每条后面的路径 / 字段名就是本文件用到的那些。
 * ⚠ 这一份是【形状】的证据，**不是端到端的证据** —— 没有任何一发真打过飞书。
 * 记下它是因为本仓最贵的那一族就是「当年对的读数被当成今天的」：
 * 哪天字段变了，红的是 `feishu.test.ts`，报错里就写着去哪核对。
 */
export const FEISHU_SHAPE_EVIDENCE: readonly string[] = [
  "取 token：POST {origin}/open-apis/auth/v3/tenant_access_token/internal，体 app_id+app_secret，返回 {code,msg,tenant_access_token,expire}（expire 单位秒）。国际版主机 open.larksuite.com 已确认是 Lark 开放平台主机，但【同一路径在它上面没读到原文】⇒ 按未证实处理",
  "发消息：POST /open-apis/im/v1/messages?receive_id_type=open_id|union_id|user_id|email|chat_id，体 receive_id + msg_type=interactive + content（interactive 时是【JSON 串套在 JSON 里】），响应 data.message_id / chat_id / create_time",
  "读消息：GET /open-apis/im/v1/messages?container_id_type=chat&container_id=oc_xxx&sort_type=ByCreateTimeAsc|ByCreateTimeDesc&page_size=1..50(默认20)&start_time&end_time&page_token（时间是【秒】）。⚠ 参数名是 sort_type，取值带 Time；排序【没有】 sort_desc 这个参数",
  "列表项字段：message_id / chat_id / msg_type / create_time / sender.id（配合 sender.id_type==open_id）/ body.content（text 消息时是 JSON.stringify({text})，不是裸文本）",
  '卡片 2.0：顶层 {schema:"2.0", config, card_link, header, body}，元素在 body.elements；header 有 title/subtitle/template/…；按钮 {tag:"button", text, …}，应用自定义数据在 value（key-value JSON，key 是字符串；【长度上限未公布】）',
  '事件封装：{schema:"2.0", header:{event_id, event_type, create_time, token}, event:{…}}；卡片回传的 event_type 是 card.action.trigger',
  '回传里：操作人 event.operator.open_id；按钮数据 event.action.value（另有 event.action.tag=="button" / name / form_value）；上下文 event.context.open_message_id / open_chat_id；event.token 是更新卡片的凭据（30 分钟、最多更新 2 次）',
  "回传必须 3 秒内 HTTP 200，可回 {toast:{type,content}} 与/或 {card:{type,data}}，两者都不回 = 卡片不变",
  'URL 校验：{type:"url_verification", challenge, token} ⇒ 1 秒内原样回 {challenge}（HTTP 200，不套 data）',
  "加密：AES-256-CBC；key = sha256(encrypt_key) 摘要，密文 = base64(iv + 密文) ⇒ IV = base64 解码后的【前 16 字节】。签名 = sha256_hex(timestamp + nonce + encrypt_key + 原始 body)，头 X-Lark-Request-Timestamp / -Nonce / X-Lark-Signature",
  "长连接：npm 包 @larksuiteoapi/node-sdk（需 ≥1.24.0），new Lark.WSClient({appId, appSecret}) + wsClient.start({eventDispatcher})；长连接模式下【不需要】自己做解密与验签",
];

/* ------------------------------------------------------------------ *
 * 纯函数
 * ------------------------------------------------------------------ */

/**
 * 一条【已知的失败读数】→ 一句人话；成功或读不出 code ⇒ null。
 *
 * ⚠ 它【不抛】，也不该抛：`fetchImpl` 抛的是【没读到 code】的那种失败，
 * 而「远端说 99991663（token 过期）」与「远端根本没答」是两种不同的处置
 * —— 前者该重取 token 再试，后者只能把本轮报成失败。混成一种就会写成
 * 「任何错都重试」，那一发的代价是把一次配额打爆。
 * 另：错误串里【绝不出现请求体】—— 取 token 那一条的体里有 app_secret。
 */
export function feishuError(
  body: FeishuEnvelope | null | undefined,
  what: string,
): string | null {
  const code = body?.code;
  if (typeof code !== "number") return null;
  if (code === 0) return null;
  return (
    what +
    "：飞书返回 code=" +
    code +
    (body?.msg === undefined ? "" : " msg=" + body.msg)
  );
}

/**
 * 参数值 → 一栏文本。
 *
 * `JSON.stringify` 而不是 `String(v)`：后者对 `{}` 给 `[object Object]`，
 * 那是「参数那一栏显示了一行没有信息的东西」—— 而这张卡的全部用途就是让人
 * 看清参数。`null` 走 stringify 会得到字面量 "null"，比空白诚实。
 * 截断是按【渲染后】的长度算的，参数再长也不该把整张卡撑爆。
 */
export function renderValue(v: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    // 循环引用那一种：参数是库里的一段自由 JSON，今天不会循环，
    // 但渲染层抛出去会带走整张卡（`deliverCard` 会报 send_failed），不值。
    return "[读不出]";
  }
  return s.length > 120 ? s.slice(0, 117) + "..." : s;
}

/** token 响应 → 令牌 + 过期时刻。形状不对 ⇒ 抛（抛的是形状描述，不含密钥）。 */
export function parseTokenResponse(
  body: FeishuTokenResponse,
  nowMs: number,
): { readonly token: string; readonly expiresAtMs: number } {
  const err = feishuError(body, "取 tenant_access_token 失败");
  if (err !== null) throw new Error(err);
  const token = body.tenant_access_token;
  const expire = body.expire;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(
      "tenant_access_token 响应里没有令牌（FEISHU_SHAPE_EVIDENCE 第 1 条）",
    );
  }
  const seconds = typeof expire === "number" && expire > 0 ? expire : 3600;
  return { token, expiresAtMs: nowMs + seconds * 1000 };
}

/** 出站卡片 → 飞书 card_json。三行三按钮的结构要求在 `outboundCardOf` 那一层，这里只渲染。 */
export function cardToFeishuJson(card: OutboundApprovalCard): string {
  const detail: string[] = [];
  if (card.parameters === null) {
    // 「参数不可读」与「没有参数」是两种不同的无知，别渲染成同一个空表。
    detail.push("参数：不可读（库里那段不是对象）");
  } else {
    const keys = Object.keys(card.parameters).sort();
    for (const k of keys)
      detail.push(k + "：" + renderValue(card.parameters[k]));
  }
  detail.push(
    card.evidenceRefs === null
      ? "证据：没有这一行（没存过）"
      : card.evidenceRefs.length === 0
        ? "证据：存了，确实没有"
        : "证据：" + card.evidenceRefs.length + " 条",
  );
  detail.push("推荐：" + (card.recommendation ?? "无") + "（推荐，非决定）");
  detail.push("超时行为：" + (card.timeoutBehavior ?? "未声明"));
  if (!card.actionable) {
    detail.push("本卡不可在这里批：" + (card.notActionableReason ?? "未说明"));
  }

  const buttons = card.buttons.map((resume) => ({
    tag: "button",
    text: { tag: "plain_text", content: BUTTON_LABELS[resume] ?? resume },
    // ⚠ 查证到的只有 `tag` / `text` / `value` 这三格。下面 `type` 与 `disabled`
    // 是卡片按钮的常规属性，而本次【没有逐条读到原文】⇒ 标成未证实而不是当成依据。
    // 所以「这张卡不能在这里批」这句话的真凭据不是 disabled：它写在正文那一行
    // （上面 detail.push），而最硬的一道在【落库点】—— `act` 落库前重读那一行
    // 并重判可逆性（approval-bridge.ts）。就算 disabled 这个词根本不生效、
    // 人真点下去了，不可逆那张卡仍然批不掉。
    type:
      resume === "approve"
        ? "primary"
        : resume === "reject_with_comment"
          ? "danger"
          : "default",
    disabled: !card.actionable,
    value: valueFor(card.approvalId, resume),
  }));

  const doc = {
    schema: "2.0",
    header: {
      title: { tag: "plain_text", content: "等你批：" + card.summary },
      template: card.actionable ? "blue" : "grey",
    },
    body: {
      elements: [
        { tag: "div", text: { tag: "lark_md", content: detail.join("\n") } },
        { tag: "hr" },
        { tag: "action", actions: buttons },
      ],
    },
  };
  return JSON.stringify(doc);
}

const BUTTON_LABELS: Readonly<Record<string, string>> = {
  approve: "批准",
  reject_with_comment: "驳回并留言",
  defer_deep_review: "先放着，细看",
};

/**
 * 按钮 value。超过自设上限 ⇒ 抛，**不截断**。
 *
 * 为什么不能截断：`parseCardAction` 把第三段之后全部当备注，
 * 截掉尾巴会得到一条【备注被静默改短】的驳回 —— 而备注是审计里那句人话。
 * 抛的代价只是「这一张卡发不出去」，比送出一条残缺的驳回便宜。
 * ⚠ 上限本身是自设护栏，不是远端规则，见 `FEISHU_VALUE_LIMIT` 那段。
 */
export function valueFor(
  approvalId: string,
  resume: ResumeValue,
): Record<string, string> {
  const value = {
    [FEISHU_ACTION_VALUE_KEY]: encodeCardAction({ approvalId, resume }),
  };
  const json = JSON.stringify(value);
  if (json.length > FEISHU_VALUE_LIMIT) {
    throw new Error(
      "按钮 value 序列化后 " +
        json.length +
        " 字符，超过自设上限 " +
        FEISHU_VALUE_LIMIT +
        "（approvalId 太长，不截断）",
    );
  }
  return value;
}

/**
 * 一次回传事件 → 入站信封。解不出来 ⇒ null（一条畸形回调不该让整轮 poll 失败）。
 *
 * `deliveryId` 用 event_id：`abstraction.ts` 的幂等键读的是它，
 * 而飞书对同一条回调重投是常态而不是异常。没有 event_id 时给 null，
 * 那一发就退化成「靠 `seen` 的 approvalId+resume 去重」，仍然安全。
 */
export function cardActionToEnvelope(
  cfg: { channelId: string },
  ev: FeishuCardActionEvent,
  opts: { readonly receivedAtMs: number },
): ChannelEnvelope | null {
  if (typeof ev.openId !== "string" || ev.openId.length === 0) return null;
  const raw = ev.value?.[FEISHU_ACTION_VALUE_KEY];
  if (typeof raw !== "string") return null;
  const message: NormalizedMessage = {
    channelId: cfg.channelId,
    platform: "feishu",
    senderId: ev.openId,
    // `event.context.open_chat_id`。没有就留空串：这一格在抽象层只用于
    // 人读与审计标签，而【编一个】会让「这条消息从哪条会话来」变成假的。
    conversationId: typeof ev.chatId === "string" ? ev.chatId : "",
    text: raw,
    atBot: false,
    kind: "card_action",
  };
  // ⚠ 边界上【自己先解一遍】，而不是把原始串塞进队列等运行时判。
  // 运行时那一道（`handleOne` 里的 `parseCardAction`）当然还在，但它判不出来时报的是
  // `{kind:"failed"}` —— 一条被改过的按钮 value 会每轮刷一条失败判决，
  // 真正的失败（装配缺 act）就淹在噪音里。所以这里挡畸形载荷用的
  // 【就是同一个 `parseCardAction`】：两侧共用一条判据 ⇒ 漂不出两种「什么叫合法」。
  if (parseCardAction(message) === null) return null;
  return {
    message,
    receivedAtMs: opts.receivedAtMs,
    // event_id 是幂等键的分子：飞书重投同一条回调是常态而不是异常。
    // 没有 ⇒ null，那一发退化成靠 `seen` 的 approvalId+resume 去重，仍然安全。
    deliveryId:
      typeof ev.eventId === "string" && ev.eventId.length > 0
        ? ev.eventId
        : null,
  };
}

/**
 * 列表项 → 入站信封。只认 `msg_type === "text"`，其余一律 null。
 *
 * ⚠ 不猜发送者：列表项【没有】sender_type，而它恰好看不到机器人自己那几条 ——
 * 机器人自己发的卡也是 text 之外的 interactive，所以今天不会自激；
 * 但真正挡住自激的是「只有解得出一次决定的文本才被收下」，
 * 而不是任何对发送者的猜测。
 *
 * ⚠ 与 `cardActionToEnvelope` 共用【同一个】`parseCardAction` 闸门，因此命中这条的
 * 文本【就是】一次卡片回传 —— 所以 `kind` 必须是 `card_action`。
 * 这条曾经写死成 `"text"`，于是轮询那一路【整条是空转的】：运行时第①步
 * （`msg.kind !== "card_action"` ⇒ `ignored_not_action`）把每一条批准都判成闲聊，
 * 而 `summarize` 对 `ignored_not_action` 刻意【什么都不说】（防噪音那条口径）。
 * 两个各自正确的决定叠在一起 = 审批人从手机点了批准，Hub 一行日志都不打。
 * ⇒ 判据就是下面那一道 `parseCardAction`，而把它钉住的是 `feishu.test.ts`
 * 里「轮询命中的那条信封 kind 必须是 card_action」那一发。
 */
export function messageToEnvelope(
  cfg: { channelId: string },
  item: FeishuMessageItem,
  opts: { readonly receivedAtMs: number },
): ChannelEnvelope | null {
  if (item.msg_type !== undefined && item.msg_type !== "text") return null;
  const sender = item.sender?.id;
  if (typeof sender !== "string" || sender.length === 0) return null;
  const content = item.body?.content;
  if (typeof content !== "string") return null;
  let text: unknown;
  try {
    text = JSON.parse(content);
  } catch {
    return null;
  }
  const t =
    typeof text === "object" && text !== null
      ? (text as { readonly text?: unknown }).text
      : undefined;
  if (typeof t !== "string" || t.length === 0) return null;
  const message: NormalizedMessage = {
    channelId: cfg.channelId,
    platform: "feishu",
    senderId: sender,
    conversationId: "",
    text: t,
    atBot: false,
    kind: "card_action",
  };
  // 解不出一次决定 ⇒ 【根本不入队】，而不是入队让运行时判一次闲聊。
  // 两边共用同一个 parseCardAction（与长连接那一路同一条判据），所以「什么叫合法」
  // 漂不出两种；而入队那一半的差别是【看得见的】：闲聊如果入队，
  // 每一轮 pollAll 都会为它记一条 handled，`got` 与 `handled` 于是每轮一起涨，
  // 「取走的每条都必须被判决」那条不变式仍然成立 —— 成立着，但已经不再说明任何事。
  return parseCardAction(message) === null
    ? null
    : {
        message,
        receivedAtMs: opts.receivedAtMs,
        deliveryId:
          typeof item.message_id === "string" ? item.message_id : null,
      };
}

/**
 * 一次查询窗口。`start_time` 必须**严格晚于** watermark，否则每轮都会把
 * 上一次那一秒的消息重新读回来 —— 而重投在抽象层会算成一次「重复」判决，
 * 每轮刷一条噪音，真正的重复（飞书重投同一条回调）就再也看不见了。
 */
export function listWindow(
  watermarkSec: number,
  nowMs: number,
  limitSec: number,
): { readonly start_time: number; readonly end_time: number } {
  const nowSec = Math.floor(nowMs / 1000);
  const start = watermarkSec > 0 ? watermarkSec : nowSec - limitSec;
  return { start_time: start + 1, end_time: nowSec };
}

/* ------------------------------------------------------------------ *
 * 适配器
 * ------------------------------------------------------------------ */

export class FeishuChannel implements Channel {
  readonly id: string;
  readonly platform = "feishu" as const;
  readonly #cfg: FeishuConfig;
  readonly #fetch: FeishuFetch;
  readonly #fetchTimeoutMs: number;
  readonly #now: () => number;
  readonly #queue: ChannelEnvelope[] = [];
  readonly #seenDeliveryIds = new Set<string>();
  #token: { token: string; expiresAtMs: number } | null = null;
  /** 已读到的最新一条的 create_time（秒）。0 = 还没读过，第一轮只回看一个窗口。 */
  #watermarkSec = 0;
  /** 长连接是否真的起来了。`supportsActionReturn` 读它。 */
  #pushLive = false;
  #closed = false;

  /** 溢出的条数。装配方拿去打日志或进 today 那一页。 */
  overflowCount = 0;

  constructor(cfg: FeishuConfig) {
    this.id = cfg.channelId;
    this.#cfg = cfg;
    this.#fetch = cfg.fetchImpl ?? defaultFetch;
    const t = cfg.fetchTimeoutMs;
    const usable = t !== undefined && Number.isFinite(t) && t > 0;
    this.#fetchTimeoutMs = usable ? t : FEISHU_FETCH_TIMEOUT_MS;
    this.#now = cfg.now ?? (() => Date.now());
  }

  /** 轮询这一路能不能跑（缺 chat_id 就是不能）。`pollOnce` 与装配方都读它。 */
  get canPoll(): boolean {
    return (this.#cfg.approverChatId ?? "").trim() !== "";
  }

  /**
   * 失败必须抛（`Channel` 那格的约定）：一条连 token 都取不到的通道不能算「起来了」，
   * 而把它当起来了的后果是【卡片发不出去而没人知道】。
   *
   * ⚠ 缺 `approverChatId` 【不在这里抛】。那是「读不到回传」而不是「起不来」：
   * 出站发卡仍然完全可用，而读不到这件事由 `supportsActionReturn === false`
   * 说得出、也看得见（卡片自己变成只读）。在这里抛会让
   * 「只想先把卡推出去」这一档跑不起来，而那一档是本轮唯一真能跑通的一档。
   */
  async start(): Promise<void> {
    const c = this.#cfg;
    if (c.appId.trim() === "" || c.appSecret.trim() === "") {
      throw new Error("飞书通道缺 appId / appSecret（该通道不启动）");
    }
    if (c.approverOpenId.trim() === "") {
      throw new Error("飞书通道缺 approverOpenId：不知道该把卡推给谁");
    }
    await this.#tokenOf();
    if (c.longConnection !== undefined) {
      c.longConnection.onCardAction((ev) =>
        this.#enqueue(
          cardActionToEnvelope({ channelId: this.id }, ev, {
            receivedAtMs: this.#now(),
          }),
        ),
      );
      await c.longConnection.start();
      this.#pushLive = true;
    }
  }

  /** 幂等：重复 close 不抛（`shutdownChannels` 依赖这一条）。 */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#pushLive = false;
    this.#cfg.longConnection?.stop();
  }

  pull(): readonly ChannelEnvelope[] {
    if (this.#closed) return [];
    const out = this.#queue.slice();
    this.#queue.length = 0;
    return out;
  }

  async send(card: OutboundApprovalCard): Promise<void> {
    const content = cardToFeishuJson(card);
    const body = {
      receive_id: this.#cfg.approverOpenId,
      msg_type: "interactive",
      content,
    };
    const r = await this.#call(
      "POST",
      "/open-apis/im/v1/messages?receive_id_type=open_id",
      body,
    );
    const err = feishuError(r, "发审批卡失败");
    if (err !== null) throw new Error(err);
  }

  /** 审批人此刻能不能在这条通道上点。只认那一个 open_id，其余只读。 */
  readonly canAct = (actor: ChannelActor): ChannelActVerdict =>
    actor.senderId === this.#cfg.approverOpenId
      ? { ok: true }
      : {
          ok: false,
          reason: "这条通道只把审批卡推给指定审批人，你的账号点不动",
        };

  /**
   * 两条回传路【都】断了就是 false —— 那一刻卡片必须以只读形态出去。
   *
   * 轮询那一半读的是【最近一整轮是否跑完】，不是「有人调过它」：
   * `#pollHealthy` 在每轮开头置 false、末尾才置 true，中途任何一次偏离
   * （取 token 失败 / 缺 chat_id / 列表报错）都让它留在 false。
   * ⇒ 「读不回传」会把卡片打成只读，而不是继续发一张带按钮而永远没人收的卡
   * （0025 §3 那个形状）。
   * ⚠ 初值刻意是 false：还没读过一轮 = 【不知道】回传路通不通，
   * 而这一格的两个坏样子不对称 —— 少一个按钮只是要人去桌面点一下，
   * 多发一张没人收的卡是「点了而石沉大海」。所以未知按只读算。
   * 代价说清楚：启动后、首轮心跳之前的那一张卡会是只读卡。
   * ⚠ 射程：它判的是【读不回传】，不判【发不出去】。
   * 发失败由 `deliverCard` 报成 `send_failed`，那是另一条路。
   */
  get supportsActionReturn(): boolean {
    return !this.#closed && (this.#pushLive || this.#pollHealthy);
  }

  #pollHealthy = false;

  /**
   * 读一轮：拉私聊里的新 text 消息，能解成一次决定的进队列，其余忽略。
   *
   * 远端失败 ⇒ 抛，由调用方按「一条坏通道不带走其余」处置（同 `pollAll` 的 failedOpen）。
   * 这里不吞：吞掉的后果是水位不推进而没人知道，症状与「审批人根本没点」同形。
   */
  async pollOnce(): Promise<number> {
    if (this.#closed) return 0;
    this.#pollHealthy = false;
    const chatId = (this.#cfg.approverChatId ?? "").trim();
    // 缺 chat_id ⇒ 这一路根本没跑。不抛：那是配置事实而不是故障，每跳抛一次
    // 会把心跳打成噪音；诚实的出口是 `supportsActionReturn` 保持 false。
    if (chatId === "") return 0;
    const w = listWindow(this.#watermarkSec, this.#now(), DEFAULT_LOOKBACK_SEC);
    // ⚠ `sort_type` 的取值带 Time（`ByCreateTimeAsc`），而且【没有 sort_desc 这个参数】。
    // 我第一版写的 `ByTimeAsc&sort_desc=false` 两头都不对：前者不是文档里的取值，
    // 后者是个不存在的参数（远端多半默默忽略，于是排序按默认走，而默认是倒序）。
    const q =
      "container_id_type=chat&container_id=" +
      encodeURIComponent(chatId) +
      "&sort_type=ByCreateTimeAsc&page_size=50" +
      "&start_time=" +
      w.start_time +
      "&end_time=" +
      w.end_time;
    let got = 0;
    /**
     * 本轮【候选】水位：先记在局部，只有【整轮读完】才提交给 `#watermarkSec`。
     *
     * 什么时候才会用上这一格（说准，别夸大）：翻页被下面那条守卫【截断】的时候。
     * 按 `ByCreateTimeAsc` 升序读，截断掉的页是【更新】的一批，而候选水位只到
     * 已读页的最新那条 ⇒ 截断本身并不跳读，这一格看起来是多余的。
     * 它防的是【本文件上面已经记过一次的那个远端行为】：sort_type 如果被默默忽略，
     * 排序按默认走而【默认是倒序】。倒序 + 截断这两件事凑在一起时，边读边推的水位
     * 会落在【没读的那些】之上 —— 而那些是更【旧】的消息，从此永久落在窗口之外。
     * 一条从没被读到的批准，症状与「审批人根本没点」同形，且永远不会自己好。
     *
     * ⇒ 这是一个【复合条件】的防线，不是当下正在发生的 bug；它的代价写清楚了再留：
     * 截断那一轮不推进水位 ⇒ 下一轮把同一批重新问一遍，`#seenDeliveryIds` 与运行时的
     * 幂等表会把重复挡在判决之前，所以代价只多一次 HTTP，不产生第二次决策。
     * 本仓在这条轴上的一贯取向是「宁重读不跳读」（同 tokens.ts 的宁吵不吞）。
     */
    let candidateSec = this.#watermarkSec;
    let readComplete = false;
    let pageToken: string | undefined;
    for (;;) {
      const url =
        "/open-apis/im/v1/messages?" +
        q +
        (pageToken === undefined
          ? ""
          : "&page_token=" + encodeURIComponent(pageToken));
      const res = (await this.#call(
        "GET",
        url,
        undefined,
      )) as FeishuListMessagesResponse;
      const err = feishuError(res, "读审批私聊消息失败");
      if (err !== null) throw new Error(err);
      for (const item of res.data?.items ?? []) {
        const created = Number(item.create_time);
        // 水位对【每一条】推进，不只是进队列的那些。
        // ⚠ 只推进被收下的那条会让窗口一直停在旧位置：会话里最新那条如果是
        // 一句闲聊，窗口就永远不会越过它，于是每一轮都要把那一整段重新读一遍
        // （翻页因此越翻越多）。它【不是】正确性问题（重读被 deliveryId 挡住了），
        // 但它是【成本】，而成本这条路最后长成的样子是「心跳越来越慢」。
        if (Number.isFinite(created) && created > candidateSec) {
          candidateSec = created;
        }
        const en = messageToEnvelope({ channelId: this.id }, item, {
          receivedAtMs: this.#now(),
        });
        if (en !== null && this.#enqueue(en)) got += 1;
      }
      if (res.data?.has_more !== true) {
        readComplete = true;
        break;
      }
      const next = res.data?.page_token;
      // 翻页标记没变 ⇒ 再问一次也是同一页，停下来（宁可少读也不许自旋）。
      // ⚠ 这一支【不提交水位】，理由见上面 `readComplete` 那段。
      if (typeof next !== "string" || next === pageToken) break;
      pageToken = next;
    }
    if (readComplete) this.#watermarkSec = candidateSec;
    this.#pollHealthy = true;
    return got;
  }

  /** 入队 + 去重。返回 false = 这条见过或为空，没进队列。 */
  #enqueue(en: ChannelEnvelope | null): boolean {
    if (en === null) return false;
    if (en.deliveryId !== null) {
      if (this.#seenDeliveryIds.has(en.deliveryId)) return false;
      this.#seenDeliveryIds.add(en.deliveryId);
    }
    boundedPush(
      this.#queue,
      en,
      (dropped) => {
        this.overflowCount += 1;
        this.#cfg.onOverflow(dropped);
      },
      CHANNEL_QUEUE_LIMIT,
    );
    return true;
  }

  async #tokenOf(): Promise<string> {
    const now = this.#now();
    // 提前 60s 过期：贴着过期点发出去的那一发会撞 code=99991663，
    // 而那一发的症状是「卡片偶尔发不出去」。
    if (this.#token !== null && this.#token.expiresAtMs > now + 60_000) {
      return this.#token.token;
    }
    const url =
      (this.#cfg.origin ?? FEISHU_DEFAULT_ORIGIN) +
      "/open-apis/auth/v3/tenant_access_token/internal";
    let res: FeishuFetchResponse;
    try {
      res = await this.#fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          app_id: this.#cfg.appId,
          app_secret: this.#cfg.appSecret,
        }),
        signal: AbortSignal.timeout(this.#fetchTimeoutMs),
      });
    } catch (e) {
      // 只带异常自身，绝不带 body：那里面有 app_secret。
      throw new Error("取 tenant_access_token 时请求没走通：" + String(e));
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error("取 tenant_access_token 返回 HTTP " + res.status);
    }
    const parsed = (await res.json()) as FeishuTokenResponse;
    this.#token = parseTokenResponse(parsed, now);
    return this.#token.token;
  }

  async #call(
    method: "GET" | "POST",
    path: string,
    body: Record<string, unknown> | undefined,
  ): Promise<FeishuEnvelope> {
    const token = await this.#tokenOf();
    const url = (this.#cfg.origin ?? FEISHU_DEFAULT_ORIGIN) + path;
    const init: FeishuFetchInit = {
      method,
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json; charset=utf-8",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.#fetchTimeoutMs),
    };
    const res = await this.#fetch(url, init);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(path + " 返回 HTTP " + res.status);
    }
    return (await res.json()) as FeishuEnvelope;
  }
}

const DEFAULT_LOOKBACK_SEC = 3600;

/**
 * 默认实现。刻意【不是】装配的默认值 —— 生产装配必须显式交出 `fetchImpl`
 * 或明确接受这一份，理由同 `signed-fetch.ts` 文件头那条：
 * 一个没人调的默认值把「忘了传」变成「运行时才发现」。
 */
async function defaultFetch(
  url: string,
  init: FeishuFetchInit,
): Promise<FeishuFetchResponse> {
  const res = await fetch(url, init);
  return { status: res.status, json: () => res.json() as Promise<unknown> };
}

/* ------------------------------------------------------------------ *
 * 装配点
 * ------------------------------------------------------------------ */

/** env 只读名字，值绝不进任何字符串。 */
export const FEISHU_ENV = {
  appId: "OPC_FEISHU_APP_ID",
  appSecret: "OPC_FEISHU_APP_SECRET",
  approverOpenId: "OPC_FEISHU_APPROVER_OPEN_ID",
  /**
   * 单聊 chat_id —— 【可选】，且刻意【不在】`feishuEnvMissing` 的名单里。
   *
   * 缺它不是「装不起来」而是「只出不进」：卡照样推到手机上，但读不到点击回传，
   * 于是 `supportsActionReturn === false`，`deliverCard` 会把每一张发出去的卡
   * 变成只读形态。那是诚实的形状，比「装上了而点了没反应」好得多，
   * 也比「缺它就拒绝启动」少了唯一一档真能跑通的用法（先把卡推出去）。
   */
  approverChatId: "OPC_FEISHU_APPROVER_CHAT_ID",
  channelId: "OPC_FEISHU_CHANNEL_ID",
  origin: "OPC_FEISHU_ORIGIN",
} as const;

export const FEISHU_DEFAULT_CHANNEL_ID = "feishu-ceo-dm";

/**
 * 这条通道实例叫什么 —— 【只有这一处】回答这个问题。
 *
 * 为什么要有这个函数而不是各装配点自己 `?? 默认值`：`??` 只挡【没给】，
 * 挡不住 `OPC_FEISHU_CHANNEL_ID=" "` 这种「给了但为空」，而空串 id 会
 * 一路注册进运行时、注册进通道表、印进每一行日志 —— 症状是「日志里通道没有名字」，
 * 成因是那次 export 多敲了一个空格。装配层对其它可选 env 的口径本来就是【空白算没给】
 * （见 `serve/im-channels.ts` 的 `bind`），唯独 id 这一格漏了，所以补在这儿而不是补在调用方。
 *
 * ⚠ 装配点（`serve/im-channels.ts`）必须走这里，别自己写 `?? 默认值`。
 * 各自写一遍的后果与「默认值写两份」同一条：有人改了缺省值或改了判空口径，
 * 另一份不会变红，而 registry 那张表是从实例上读的 —— 它跟着错下去且全绿。
 */
export function feishuChannelId(env: Readonly<NodeJS.ProcessEnv>): string {
  const v = (env[FEISHU_ENV.channelId] ?? "").trim();
  return v === "" ? FEISHU_DEFAULT_CHANNEL_ID : v;
}

/** 一条通道的必填 env 齐了没有。缺哪几个名字（名字，不是值）。 */
export function feishuEnvMissing(
  env: Readonly<NodeJS.ProcessEnv>,
): readonly string[] {
  const need = [
    FEISHU_ENV.appId,
    FEISHU_ENV.appSecret,
    FEISHU_ENV.approverOpenId,
  ];
  return need.filter((k) => (env[k] ?? "").trim() === "");
}
