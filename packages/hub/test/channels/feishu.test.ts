/**
 * `channels/feishu.ts` 的**纯函数与适配器形状** —— 一发真网络请求都不打。
 *
 * ── 为什么现在才补，以及它补的到底是哪一格 ────────────────────────────
 * `feishu.ts` 的文件头与 `FEISHU_SHAPE_EVIDENCE` 各写了一句同一口径的话：
 * 「哪天字段变了，**红的是 `feishu.test.ts`**，报错里就写着去哪核对」。
 * 那句话写下时这个文件**不存在**。所以本篇开工前先纠正一条假主张：那份证据表
 * 当时没有任何读者，形状漂移会一路绿到真发请求那一刻。
 * ⚠ 补上之后它仍然**不是**端到端验证：本文件每一发都用注入的 `fetchImpl`，
 * 一次也没打过 open.feishu.cn（要真凭据）。它钉的是「本文件自己那批纯函数的
 * 判据」与「远端字段名在读侧被怎么用」，r16 那条边界一字未改。
 *
 * ── 与 `serve/im-channels.test.ts` 的分工（别把同一件事测两遍）────────
 * 那一份走的是**装配形状**：env → 通道 → 一轮入站 → 桥 → 库里那一行，
 * 水位/翻页截断/溢出/关机那几格也归它（那里有假远端，能观察第二轮的读数）。
 * 这一份只管**单条消息与单张卡**的对错：一条列表项怎么变成信封、一张卡怎么变成
 * card_json、一个 value 什么时候必须抛。判据不同的证据是：把 `messageToEnvelope`
 * 的 `kind` 改回 `"text"`，两份都红 —— 但红的原因不同（那边是「一条批准被当成
 * 闲聊」，这边是「这条信封的 kind 是什么」），前者要跑一整套装配才能观察到。
 *
 * ── 本篇最承重的一发是【kind 那一发】，不是主链路 ─────────────────────
 * `messageToEnvelope` 曾经把轮询读到的回传标成 `kind:"text"`，而抽象层第①步
 * 把非 `card_action` 判成 `ignored_not_action`，`summarize` 对它刻意什么都不说。
 * 于是轮询那一路【整条空转且不打一行日志】。两个各自正确的决定叠在一起造出来的
 * 洞，只有在这一层能一眼看出来 —— 所以它被写在第一个 describe 里。
 *
 * ── 跑法 ──────────────────────────────────────────────────────────────
 *   npx vitest run packages/hub/test/channels/feishu.test.ts
 */
import { describe, expect, it } from "vitest";
import type {
  NormalizedMessage,
  OutboundApprovalCard,
} from "../../src/channels/abstraction.js";
import {
  encodeCardAction,
  parseCardAction,
} from "../../src/channels/abstraction.js";
import {
  cardActionToEnvelope,
  cardToFeishuJson,
  FEISHU_ACTION_VALUE_KEY,
  FEISHU_DEFAULT_CHANNEL_ID,
  FEISHU_DEFAULT_ORIGIN,
  FEISHU_ENV,
  FEISHU_VALUE_LIMIT,
  FeishuChannel,
  type FeishuFetch,
  type FeishuMessageItem,
  feishuChannelId,
  feishuEnvMissing,
  feishuError,
  listWindow,
  messageToEnvelope,
  parseTokenResponse,
  renderValue,
  valueFor,
} from "../../src/channels/feishu.js";

const NOW = 1_700_000_000_000;
const SEC = Math.floor(NOW / 1000);
const CH = { channelId: "feishu-ceo-dm" };
const APPROVER = "ou_approver_1";
const APP_ID = "cli_test_app";
const SECRET = "super-secret-app-secret";
const APPROVAL_ID = "apr-1";

/** 一条合法回传的文本载荷（发送侧与接收侧共用 `encodeCardAction`）。 */
const PAYLOAD = encodeCardAction({
  approvalId: APPROVAL_ID,
  resume: "approve",
});

/* ═══════════════════ 夹具 ═══════════════════ */

/**
 * 渲染出来的卡片读法。
 *
 * ⚠ 为什么不用 `as any` 一路点下去：`doc.body.elements[2].actions` 那种链上任何一环
 * 写错（比如卡片结构改过而这里没跟着改），`as any` 给的是 undefined，
 * 于是 `expect(actions.every(...)).toBe(true)` 在【空数组】上绿 —— 而空数组正是
 * 「那一环不存在」的读数。这里的每一个读取都会抛，红在真正缺的那一格上。
 */
interface CardDoc {
  schema: string;
  header: { title: { content: string }; template: string };
  /** 正文那一栏的文本（elements[0]）。 */
  detail: string;
  /** 按钮那一组（action 元素）。 */
  actions: {
    text: { content: string };
    type: string;
    disabled: boolean;
    value: Record<string, string>;
  }[];
}

function cardDoc(c: OutboundApprovalCard): CardDoc {
  const raw = JSON.parse(cardToFeishuJson(c)) as {
    schema: string;
    header: { title: { content: string }; template: string };
    body: {
      elements: {
        tag: string;
        text?: { content: string };
        actions?: Record<string, never>[];
      }[];
    };
  };
  const div = raw.body.elements.find((e) => e.tag === "div");
  const action = raw.body.elements.find((e) => e.tag === "action");
  if (div?.text?.content === undefined) throw new Error("卡片里没有正文那一栏");
  if (action?.actions === undefined) throw new Error("卡片里没有按钮那一组");
  return {
    schema: raw.schema,
    header: {
      title: { content: raw.header.title.content },
      template: raw.header.template,
    },
    detail: div.text.content,
    actions: action.actions as unknown as CardDoc["actions"],
  };
}

/** 一条能渲染的出站卡。`actionable` 与 `parameters` 那两格每条测试自己覆盖。 */
function card(over: Partial<OutboundApprovalCard> = {}): OutboundApprovalCard {
  return {
    approvalId: APPROVAL_ID,
    taskId: "t-1",
    summary: "本季度预算超支 12%",
    parameters: { impact_scope: "研发预算", irreversible: false },
    evidenceRefs: ["evidence/a.md", "evidence/b.md"],
    recommendation: "先砍非必要实验",
    timeoutBehavior: "auto_reject",
    buttons: ["approve", "reject_with_comment", "defer_deep_review"],
    actionable: true,
    ...over,
  };
}

/** 一条列表项夹具：`body.content` 是【JSON 串套 JSON】，不是裸文本。 */
/**
 * FeishuMessageItem 的 override：每格都允许【显式传 undefined】。
 * 普通 Partial 在 exactOptionalPropertyTypes 下不许 sender?: {…} 里塞 undefined，
 * 而这一篇的用例恰恰要造「缺发送者」这种形状（item({ sender: undefined })）。
 */
type ItemOverride = {
  [K in keyof FeishuMessageItem]?: FeishuMessageItem[K] | undefined;
};

function item(
  over: ItemOverride = {},
): Parameters<typeof messageToEnvelope>[1] {
  const base = {
    message_id: "om_1",
    msg_type: "text",
    create_time: String(SEC),
    sender: { id: APPROVER },
    body: { content: JSON.stringify({ text: PAYLOAD }) },
    ...over,
  };
  // exactOptionalPropertyTypes：显式 undefined 的 override 不能留在字面量里
  // （{ sender: undefined } 不是 FeishuMessageItem）。把它【删掉】才是「缺发送者」的正确形状。
  for (const k of Object.keys(base)) {
    if ((base as Record<string, unknown>)[k] === undefined) {
      delete (base as Record<string, unknown>)[k];
    }
  }
  return base as Parameters<typeof messageToEnvelope>[1];
}

/**
 * 记下 URL 与方法/体的假 fetch。
 *
 * ⚠ token 那一发【由这里默认答好】：`start()` 与 `pollOnce()` 都会先要令牌，
 * 每条测试各写一份 token 体的话，写漏的那条就落到 `FeishuChannel` 那份默认 fetch 上
 * —— 也就是【真打 open.feishu.cn】，症状是一条超时把整个文件带崩，
 * 而没人会先想到成因是夹具少写了一格。要改 token 那一发的答法走 `tokenBody`。
 */
function fakeFetch(
  reply: (url: string) => unknown = () => ({ code: 0, data: { items: [] } }),
  o: { readonly tokenBody?: unknown } = {},
): {
  readonly fetchImpl: FeishuFetch;
  readonly urls: string[];
  /** 只在【正半发】用：判据是 `some(...)` 而不是数组相等 ⇒ 失败时不打体。 */
  bodiesWithSecret(): boolean;
  /**
   * 按 URL 片段取某一发的请求体。
   *
   * ⚠ 只给【不含凭据】的那一发用（今天就是 `/im/v1/messages`：带 app_secret 的
   * 只有 token 那一发）。别拿它写 `expect(bodies).toEqual([...])` —— 比对失败时
   * vitest 把两侧原样打出来，而测试日志也是一处日志。
   */
  bodyOf(urlPart: string): string | undefined;
} {
  const urls: string[] = [];
  const bodies: string[] = [];
  return {
    urls,
    bodiesWithSecret: () => bodies.some((b) => b.includes(SECRET)),
    bodyOf: (part) => {
      const i = urls.findIndex((u) => u.includes(part));
      return i < 0 ? undefined : bodies[i];
    },
    fetchImpl: async (url, init) => {
      urls.push(url);
      bodies.push(init.body ?? "");
      if (url.includes("tenant_access_token")) {
        return {
          status: 200,
          json: async () =>
            o.tokenBody ?? {
              code: 0,
              tenant_access_token: "t-1",
              expire: 3600,
            },
        };
      }
      return { status: 200, json: async () => reply(url) };
    },
  };
}

/** 一个装到能 `start()` 的通道（默认那份假 fetch 一切答成功，永不碰网络）。 */
function channel(
  over: Partial<ConstructorParameters<typeof FeishuChannel>[0]> = {},
  fetchImpl: FeishuFetch = fakeFetch().fetchImpl,
): FeishuChannel {
  return new FeishuChannel({
    channelId: CH.channelId,
    appId: APP_ID,
    appSecret: SECRET,
    approverOpenId: APPROVER,
    approverChatId: "oc_test_chat",
    onOverflow: () => {},
    now: () => NOW,
    fetchImpl,
    ...over,
  });
}

/* ══════════════ 本篇最承重的一发：轮询那一路的 kind ══════════════ */

describe("⭐ 轮询读到的回传必须标成 card_action（曾经标成 text，整条空转）", () => {
  it("⭐ 一条列表项 → 信封：kind 是 card_action，且运行时那一刀切得开", () => {
    const en = messageToEnvelope(CH, item(), { receivedAtMs: NOW });
    expect(en).not.toBeNull();
    // 这一行是整篇的分量。改成 "text" ⇒ 抽象层第①步把每条批准判成闲聊，
    // 而 summarize 对 ignored_not_action 刻意不说 ⇒ 手机上点了而这边一行日志都没有。
    expect(en?.message.kind).toBe("card_action");
    // 只断 kind 还不够：kind 与载荷【两边都得成立】，否则「标了 card_action 而
    // 载荷解不出」会绿在这一发上，而运行时第②步判的是 failed。
    expect(parseCardAction(en?.message as NormalizedMessage)).toEqual({
      approvalId: APPROVAL_ID,
      resume: "approve",
    });
    expect(en?.message.platform).toBe("feishu");
    expect(en?.message.senderId).toBe(APPROVER);
    // deliveryId 是幂等键的分子：飞书重投同一条消息是常态。
    expect(en?.deliveryId).toBe("om_1");
    expect(en?.receivedAtMs).toBe(NOW);
    // 列表响应里【没有】单聊会话这一维可读，所以留空串而不是编一个。
    expect(en?.message.conversationId).toBe("");
  });

  it("备注带着竖线也不丢：回传文本的第三段之后全是备注", () => {
    const text = encodeCardAction({
      approvalId: APPROVAL_ID,
      resume: "reject_with_comment",
      note: "先问财务|再确认",
    });
    const en = messageToEnvelope(
      CH,
      item({ body: { content: JSON.stringify({ text }) } }),
      { receivedAtMs: NOW },
    );
    expect(parseCardAction(en?.message as NormalizedMessage)).toEqual({
      approvalId: APPROVAL_ID,
      resume: "reject_with_comment",
      note: "先问财务|再确认",
    });
  });

  it("闲聊【根本不入队】，而不是入队让运行时判一次闲聊", () => {
    // 差别是看得见的：闲聊如果入队，每轮 pollAll 都为它记一条 handled，
    // 「取走的每条都必须被判决」那条不变式还成立，但已经不再说明任何事。
    const en = messageToEnvelope(
      CH,
      item({ body: { content: JSON.stringify({ text: "在吗" }) } }),
      { receivedAtMs: NOW },
    );
    expect(en).toBeNull();
  });

  it("机器人自己那张卡（interactive）读不进来：不自激", () => {
    const en = messageToEnvelope(
      CH,
      item({ msg_type: "interactive", body: { content: PAYLOAD } }),
      { receivedAtMs: NOW },
    );
    expect(en).toBeNull();
  });

  it("缺发送者 / 体不是 JSON / 文本为空 ⇒ 全部 null，一条都不入队", () => {
    const cases: Parameters<typeof messageToEnvelope>[1][] = [
      item({ sender: undefined }),
      item({ sender: { id: "" } }),
      item({ body: { content: "not json" } }),
      item({ body: { content: JSON.stringify({ text: "" }) } }),
      item({ body: { content: JSON.stringify("裸字符串") } }),
      item({ body: undefined }),
    ];
    for (const c of cases) {
      expect(messageToEnvelope(CH, c, { receivedAtMs: NOW })).toBeNull();
    }
  });

  it("解不出决定的合法文本（缺 resume 那一段）也不入队", () => {
    const en = messageToEnvelope(
      CH,
      item({
        body: { content: JSON.stringify({ text: "apr-1|not_a_resume" }) },
      }),
      { receivedAtMs: NOW },
    );
    expect(en).toBeNull();
  });
});

/* ══════════════════ 长连接那一路：回传事件 → 信封 ══════════════════ */

describe("cardActionToEnvelope：与轮询共用同一条「什么叫合法」", () => {
  it("合法回传 → 信封：kind / deliveryId(event_id) / conversationId(chat_id)", () => {
    const en = cardActionToEnvelope(
      CH,
      {
        openId: APPROVER,
        value: { [FEISHU_ACTION_VALUE_KEY]: PAYLOAD },
        eventId: "evt-9",
        chatId: "oc_7",
      },
      { receivedAtMs: NOW + 1 },
    );
    expect(en?.message.kind).toBe("card_action");
    expect(en?.deliveryId).toBe("evt-9");
    expect(en?.message.conversationId).toBe("oc_7");
    expect(parseCardAction(en?.message as NormalizedMessage)?.resume).toBe(
      "approve",
    );
  });

  it("没有 event_id ⇒ deliveryId 是 null（退化成 approvalId+resume 去重，仍然安全）", () => {
    const en = cardActionToEnvelope(
      CH,
      { openId: APPROVER, value: { [FEISHU_ACTION_VALUE_KEY]: PAYLOAD } },
      { receivedAtMs: NOW },
    );
    expect(en?.deliveryId).toBeNull();
    expect(en?.message.conversationId).toBe("");
  });

  it("缺 open_id / value 不是串 / 载荷畸形 ⇒ null：一条坏回调不许让整轮 poll 失败", () => {
    const bad: Parameters<typeof cardActionToEnvelope>[1][] = [
      { openId: "", value: { [FEISHU_ACTION_VALUE_KEY]: PAYLOAD } },
      { openId: APPROVER, value: {} },
      { openId: APPROVER, value: { [FEISHU_ACTION_VALUE_KEY]: 42 } },
      { openId: APPROVER, value: { other: PAYLOAD } },
      { openId: APPROVER, value: { [FEISHU_ACTION_VALUE_KEY]: "在吗" } },
    ];
    for (const ev of bad) {
      expect(cardActionToEnvelope(CH, ev, { receivedAtMs: NOW })).toBeNull();
    }
  });
});

/* ══════════════════ 远端读数 → 一句人话 ══════════════════ */

describe("feishuError / parseTokenResponse：报形状，不报备注以外的东西", () => {
  it("code 缺失、非数字、或为 0 ⇒ null（成功与「读不出 code」都不算失败）", () => {
    expect(feishuError(undefined, "取 token")).toBeNull();
    expect(feishuError({}, "取 token")).toBeNull();
    expect(
      feishuError({ code: "0" as unknown as number }, "取 token"),
    ).toBeNull();
    expect(feishuError({ code: 0, msg: "success" }, "取 token")).toBeNull();
  });

  it("code 非 0 ⇒ 一句带 code 与人话的话，msg 缺了也不炸", () => {
    const s = feishuError(
      { code: 99991663, msg: "token expired" },
      "读审批消息",
    );
    expect(s).toContain("读审批消息");
    expect(s).toContain("code=99991663");
    expect(s).toContain("token expired");
    expect(feishuError({ code: 230002 }, "x")).toBe("x：飞书返回 code=230002");
  });

  it("令牌 + 过期时刻：expire 用秒，缺省或非法回落到 3600", () => {
    expect(
      parseTokenResponse(
        { code: 0, tenant_access_token: "t", expire: 100 },
        NOW,
      ),
    ).toEqual({ token: "t", expiresAtMs: NOW + 100_000 });
    expect(
      parseTokenResponse({ code: 0, tenant_access_token: "t" }, NOW)
        .expiresAtMs,
    ).toBe(NOW + 3_600_000);
    expect(
      parseTokenResponse({ code: 0, tenant_access_token: "t", expire: 0 }, NOW)
        .expiresAtMs,
    ).toBe(NOW + 3_600_000);
  });

  it("令牌缺失 ⇒ 抛，且抛的是形状描述", () => {
    expect(() => parseTokenResponse({ code: 0 }, NOW)).toThrow(
      /FEISHU_SHAPE_EVIDENCE 第 1 条/,
    );
    expect(() =>
      parseTokenResponse({ code: 0, tenant_access_token: "" }, NOW),
    ).toThrow();
  });

  it("业务错 ⇒ 抛的那句带 code，且不带请求体里的凭据", () => {
    expect(() =>
      parseTokenResponse({ code: 10003, msg: "app not found" }, NOW),
    ).toThrow(/code=10003/);
  });
});

/* ══════════════════ 渲染：参数那一栏必须说人话 ══════════════════ */

describe("renderValue / cardToFeishuJson：三种「不知道」渲染成三句话", () => {
  it("对象走 JSON 而不是 String()：后者给 [object Object]", () => {
    expect(renderValue({ a: 1 })).toBe('{"a":1}');
    expect(renderValue({})).toBe("{}");
    // null 走 stringify 得到字面量 "null"，比空白诚实。
    expect(renderValue(null)).toBe("null");
    expect(renderValue(undefined)).toBe("undefined");
    expect(renderValue("超支 12%")).toBe('"超支 12%"');
  });

  it("太长按渲染后截断；循环引用回一句「读不出」而不带走整张卡", () => {
    const long = renderValue("x".repeat(200));
    expect(long.length).toBe(120);
    expect(long.endsWith("...")).toBe(true);
    const cyc: Record<string, unknown> = {};
    cyc["self"] = cyc;
    expect(renderValue(cyc)).toBe("[读不出]");
  });

  it("卡片是 schema 2.0，参数排序、三按钮、value 能解回一次决定", () => {
    const doc = cardDoc(card());
    expect(doc.schema).toBe("2.0");
    expect(doc.header.title.content).toContain("本季度预算超支 12%");
    // 键排序：同一条卡片每次渲染出来的文本必须逐字相同，否则「卡片变了」
    // 这个判断会掺进「键序变了」。
    expect(doc.detail).toContain(
      'impact_scope："研发预算"\nirreversible：false',
    );
    expect(doc.detail).toContain("证据：2 条");
    expect(doc.detail).toContain("（推荐，非决定）");
    expect(doc.detail).toContain("超时行为：auto_reject");
    expect(doc.actions.map((a) => a.value[FEISHU_ACTION_VALUE_KEY])).toEqual([
      encodeCardAction({ approvalId: APPROVAL_ID, resume: "approve" }),
      encodeCardAction({
        approvalId: APPROVAL_ID,
        resume: "reject_with_comment",
      }),
      encodeCardAction({
        approvalId: APPROVAL_ID,
        resume: "defer_deep_review",
      }),
    ]);
    // value 里的串必须能被【同一个】parseCardAction 解回来 —— 发送侧与接收侧同协议。
    expect(
      parseCardAction({
        channelId: CH.channelId,
        platform: "feishu",
        senderId: APPROVER,
        conversationId: "",
        text: doc.actions[0]?.value[FEISHU_ACTION_VALUE_KEY] ?? "",
        atBot: false,
        kind: "card_action",
      }),
    ).toEqual({ approvalId: APPROVAL_ID, resume: "approve" });
  });

  it("⭐ 参数不可读 / 没有参数 / 证据的三种读法，各不相同", () => {
    expect(cardDoc(card({ parameters: null })).detail).toContain(
      "参数：不可读（库里那段不是对象）",
    );
    // 证据那一格三档：null=没存过这一行，[]=存了确实没有，n=有条数。
    const nullEv = cardDoc(card({ evidenceRefs: null })).detail;
    const emptyEv = cardDoc(card({ evidenceRefs: [] })).detail;
    expect(nullEv).toContain("证据：没有这一行（没存过）");
    expect(emptyEv).toContain("证据：存了，确实没有");
    // 两条否定断言才是这一发的分量：只断「其中一句在」对「三种读法渲染成同一句」是绿的。
    expect(nullEv).not.toContain("证据：存了，确实没有");
    expect(emptyEv).not.toContain("没存过");
    expect(nullEv).not.toBe(emptyEv);
  });

  it("不可批的卡：正文那行写着理由，按钮 disabled（正文才是真凭据）", () => {
    const doc = cardDoc(
      card({
        actionable: false,
        notActionableReason: "不可逆动作不许在 IM 里批",
      }),
    );
    expect(doc.detail).toContain("本卡不可在这里批：不可逆动作不许在 IM 里批");
    expect(doc.header.template).toBe("grey");
    expect(doc.actions.length).toBe(3);
    expect(doc.actions.every((a) => a.disabled)).toBe(true);
    // ⚠ 射程：disabled 这次没查到原文，所以「批不掉」的真凭据在落库点重判那一遍
    // （approval-bridge.ts）。这一发只钉「这句话确实印在正文里」。
    const ok = cardDoc(card());
    expect(ok.header.template).toBe("blue");
    expect(ok.actions.every((a) => a.disabled)).toBe(false);
  });

  it("推荐与超时缺省时仍各说一句，不留空白", () => {
    const detail = cardDoc(
      card({ recommendation: null, timeoutBehavior: null }),
    ).detail;
    expect(detail).toContain("推荐：无（推荐，非决定）");
    expect(detail).toContain("超时行为：未声明");
  });
});

/* ══════════════════ value 的上限：抛，不截断 ══════════════════ */

describe("valueFor：超上限抛错，因为截断会静默改短一句备注", () => {
  it("正常 approvalId ⇒ {opc: 'id|resume'}", () => {
    expect(valueFor(APPROVAL_ID, "approve")).toEqual({
      [FEISHU_ACTION_VALUE_KEY]: PAYLOAD,
    });
  });

  it("⭐ approvalId 太长 ⇒ 抛，且抛的不是被截断的东西", () => {
    // 截断会怎样：parseCardAction 把第三段之后【全部】当备注 ⇒ 得到一条
    // 「备注被静默改短」的驳回，而备注是审计里那句人话。
    expect(() =>
      valueFor("apr-".padEnd(FEISHU_VALUE_LIMIT, "x"), "approve"),
    ).toThrow(/不截断/);
  });

  it("上限自述是【自设护栏】，不是远端规则：改动它必须同时改注释", () => {
    // 这一发不给判据，只把「这个数字有出处」钉在测试里：查不到官方上限，
    // 所以任何把它当远端规则来调的改动都该撞到这里那句注释。
    expect(FEISHU_VALUE_LIMIT).toBe(400);
    const json = JSON.stringify(valueFor(APPROVAL_ID, "approve"));
    expect(json.length).toBeLessThanOrEqual(FEISHU_VALUE_LIMIT);
  });
});

/* ══════════════════ 时间窗与 env 读法 ══════════════════ */

describe("listWindow / feishuChannelId / feishuEnvMissing", () => {
  it("⭐ start_time 严格晚于水位：等于就会每轮重读上一秒那一批", () => {
    // 等号的代价：重投在抽象层算成一次「重复」判决，每轮刷一条噪音，
    // 真正的重复（飞书重投回调）就再也看不见了。
    expect(listWindow(1000, 2000_000, 3600)).toEqual({
      start_time: 1001,
      end_time: 2000,
    });
  });

  it("水位 0（还没读过）⇒ 只回看一个窗口，不从头翻会话", () => {
    expect(listWindow(0, NOW, 3600)).toEqual({
      start_time: SEC - 3600 + 1,
      end_time: SEC,
    });
  });

  it("通道 id：没给或【给了但为空】都回落到唯一那份缺省值", () => {
    // `??` 只挡没给，挡不住 " "，而空串 id 会一路注册进运行时并印进每行日志。
    expect(feishuChannelId({})).toBe(FEISHU_DEFAULT_CHANNEL_ID);
    expect(feishuChannelId({ [FEISHU_ENV.channelId]: "  " })).toBe(
      FEISHU_DEFAULT_CHANNEL_ID,
    );
    expect(feishuChannelId({ [FEISHU_ENV.channelId]: " feishu-2 " })).toBe(
      "feishu-2",
    );
  });

  it("缺 env 报的是【名字】，且空白算没给", () => {
    expect(feishuEnvMissing({})).toEqual([
      FEISHU_ENV.appId,
      FEISHU_ENV.appSecret,
      FEISHU_ENV.approverOpenId,
    ]);
    expect(
      feishuEnvMissing({
        [FEISHU_ENV.appId]: "x",
        [FEISHU_ENV.appSecret]: " ",
        [FEISHU_ENV.approverOpenId]: "y",
      }),
    ).toEqual([FEISHU_ENV.appSecret]);
    // 可选那三项【不在】名单里：缺 chat_id 是「只出不进」，不是「装不起来」。
    expect(feishuEnvMissing({})).not.toContain(FEISHU_ENV.approverChatId);
    expect(feishuEnvMissing({})).not.toContain(FEISHU_ENV.channelId);
  });
});

/* ══════════════════ 适配器：状态机那一小片 ══════════════════ */

describe("FeishuChannel 的读数：未知按只读算，凭据不进错误串", () => {
  it("⭐ 错误串里没有 app_secret，而请求体【确实带着】它（正半发防假绿）", async () => {
    // 正半发用 `some(...)` 而不是数组相等：断言失败时 vitest 会把比对的两侧原样打出来，
    // 而这一发的体里就是 app_secret。测试日志也是一处日志。
    const ok = fakeFetch();
    expect(ok.bodiesWithSecret()).toBe(false);
    await channel({}, ok.fetchImpl).start();
    expect(ok.bodiesWithSecret()).toBe(true);

    // 反半发：远端答 500 时那句必须说得出是哪个接口，且不含凭据。
    const f = fakeFetch();
    const http500: FeishuFetch = async (url, init) => {
      const r = await f.fetchImpl(url, init);
      return url.includes("tenant_access_token")
        ? { status: 500, json: async () => ({}) }
        : r;
    };
    const err = await channel({}, http500)
      .start()
      .then(
        () => null,
        (e: unknown) => String(e),
      );
    expect(err).toContain("500");
    expect(err).not.toContain(SECRET);
    expect(f.bodiesWithSecret()).toBe(true);

    // 答 200 而体里没有令牌 ⇒ 抛的是形状描述，同样不含凭据。
    const err2 = await channel(
      {},
      fakeFetch(() => ({}), { tokenBody: { code: 0 } }).fetchImpl,
    )
      .start()
      .then(
        () => null,
        (e: unknown) => String(e),
      );
    expect(err2).toContain("FEISHU_SHAPE_EVIDENCE");
    expect(err2).not.toContain(SECRET);

    // 请求【根本没走通】那一支：那句只准带异常自身。
    // 这一发不是凑数的：上一支走的是「答了而形状不对」，这一支走的是 catch 里那句
    // —— 有人把「绝不带 body」改成 `+ String(init.body)` 调试时，只有这一支挡得住。
    const netErr: FeishuFetch = async (url, init) => {
      const r = await f.fetchImpl(url, init);
      if (url.includes("tenant_access_token")) {
        throw new Error("getaddrinfo ENOTFOUND open.feishu.cn");
      }
      return r;
    };
    const err3 = await channel({}, netErr)
      .start()
      .then(
        () => null,
        (e: unknown) => String(e),
      );
    expect(err3).toContain("请求没走通");
    expect(err3).toContain("ENOTFOUND");
    expect(err3).not.toContain(SECRET);
    expect(err3).not.toContain(APP_ID);
  });

  it("缺必填 ⇒ start 抛（连 token 都取不到的通道不能算起来了）", async () => {
    const empty = (over: Record<string, string>) =>
      new FeishuChannel({
        channelId: CH.channelId,
        appId: APP_ID,
        appSecret: SECRET,
        approverOpenId: APPROVER,
        onOverflow: () => {},
        fetchImpl: fakeFetch().fetchImpl,
        ...over,
      });
    await expect(empty({ appId: " " }).start()).rejects.toThrow(/appId/);
    await expect(empty({ approverOpenId: "" }).start()).rejects.toThrow(
      /approverOpenId/,
    );
  });

  it("缺 chat_id ⇒ 起得来、canPoll 假、pollOnce 回 0 而不抛", async () => {
    const f = fakeFetch(() => ({ code: 0, data: { items: [] } }));
    const c = channel({ approverChatId: "  " }, f.fetchImpl);
    await c.start();
    expect(c.canPoll).toBe(false);
    expect(await c.pollOnce()).toBe(0);
    // 只起了 token，压根没去读会话。
    expect(f.urls.filter((u) => u.includes("/im/v1/messages"))).toEqual([]);
  });

  it("supportsActionReturn：没读过一轮之前是未知 ⇒ 按只读算", async () => {
    const f = fakeFetch(() => ({ code: 0, data: { items: [] } }));
    const c = channel({}, f.fetchImpl);
    // 起得来不等于回传路通：这一格判的是【读不回传】，不判【发不出去】。
    expect(c.supportsActionReturn).toBe(false);
    await c.start();
    expect(c.supportsActionReturn).toBe(false);
    expect(await c.pollOnce()).toBe(0);
    // 一整轮跑完（哪怕一条没有）才算路通。
    expect(c.supportsActionReturn).toBe(true);
    expect(c.canAct({ senderId: APPROVER, channelId: CH.channelId }).ok).toBe(
      true,
    );
    expect(c.canAct({ senderId: "ou_other", channelId: CH.channelId }).ok).toBe(
      false,
    );
  });

  it("轮询中途失败 ⇒ supportsActionReturn 留在 false，卡片自己变只读", async () => {
    let n = 0;
    const flaky: FeishuFetch = async (url, _init) => {
      if (url.includes("tenant_access_token")) {
        return {
          status: 200,
          json: async () => ({
            code: 0,
            tenant_access_token: "t",
            expire: 3600,
          }),
        };
      }
      n += 1;
      if (n === 1) {
        return {
          status: 200,
          json: async () => ({ code: 0, data: { items: [] } }),
        };
      }
      return {
        status: 200,
        json: async () => ({ code: 230002, msg: "bot not in chat" }),
      };
    };
    const c = channel({}, flaky);
    await c.start();
    await c.pollOnce();
    expect(c.supportsActionReturn).toBe(true);
    // 第二轮远端报错：这一轮【偏离过一次】就够，因为「能不能点」不能靠上一轮的读数。
    await expect(c.pollOnce()).rejects.toThrow(/code=230002/);
    expect(c.supportsActionReturn).toBe(false);
  });

  it("关机幂等，之后 pull 空、不再声称能收回传", async () => {
    let stops = 0;
    const c = channel({
      longConnection: {
        onCardAction: () => {},
        start: async () => {},
        stop: () => {
          stops += 1;
        },
      },
    });
    await c.start();
    expect(c.supportsActionReturn).toBe(true);
    await c.close();
    await c.close();
    expect(stops).toBe(1);
    expect(c.pull()).toEqual([]);
    expect(c.supportsActionReturn).toBe(false);
  });

  it("发卡：body 是 receive_id + interactive + 套了一层 JSON 的 content", async () => {
    const f = fakeFetch(() => ({ code: 0, data: { message_id: "om_new" } }));
    const c = channel({}, f.fetchImpl);
    await c.start();
    await c.send(card());
    const url = f.urls.find((u) => u.includes("/im/v1/messages")) ?? "";
    expect(url).toContain("receive_id_type=open_id");
    const body = JSON.parse(f.bodyOf("/im/v1/messages") ?? "") as Record<
      string,
      unknown
    >;
    expect(body["receive_id"]).toBe(APPROVER);
    expect(body["msg_type"]).toBe("interactive");
    // content 是【JSON 串套在 JSON 里】—— 直接给对象是这一族最常见的写错方式。
    expect(typeof body["content"]).toBe("string");
    expect(JSON.parse(body["content"] as string).schema).toBe("2.0");
  });

  it("远端说业务错 ⇒ send 抛（吞掉的后果是「卡片发不出去而没人知道」）", async () => {
    const f: FeishuFetch = async (url) => ({
      status: 200,
      json: async () =>
        url.includes("tenant_access_token")
          ? { code: 0, tenant_access_token: "t", expire: 3600 }
          : { code: 230001, msg: "no permission" },
    });
    const c = channel({}, f);
    await c.start();
    await expect(c.send(card())).rejects.toThrow(/发审批卡失败.*code=230001/);
  });

  it("缺省主机与平台名：origin 可指国际版，platform 恒为 feishu", () => {
    expect(FEISHU_DEFAULT_ORIGIN).toBe("https://open.feishu.cn");
    expect(channel().platform).toBe("feishu");
    expect(channel({ channelId: "c-9" }).id).toBe("c-9");
  });
});

/* ══════════════════ 形状证据的读者 ══════════════════ */

describe("FEISHU_SHAPE_EVIDENCE 有读者（那份表当初写了却一个读者都没有）", () => {
  it("证据表里那三条被读侧真用的读数，逐条对得上代码里的字面量", async () => {
    const mod = await import("../../src/channels/feishu.js");
    const text = mod.FEISHU_SHAPE_EVIDENCE.join("\n");
    // 列表：参数名是 sort_type 且取值带 Time。⚠ 这里刻意【不】钉证据表的中文措辞
    // （「没有 sort_desc 这个参数」那句）—— 那段是给人读的读数，改措辞不该红；
    // 真正被代码用的是参数名与取值，而它们由下面那一发（真发出去的那个 URL）钉。
    expect(text).toContain("sort_type=ByCreateTimeAsc");
    expect(text).toContain("参数名是 sort_type");
    // 时间与 text 消息体的形状：本文件的夹具就是照这两条写的。
    expect(text).toContain("时间是【秒】");
    expect(text).toContain("JSON.stringify({text})");
    // token 那一条的 expire 单位，parseTokenResponse 读的就是它。
    expect(text).toContain("expire 单位秒");
    // ⚠ 这一句是那张表自己的边界，别让它被读成端到端验证。
    expect(text).toContain("长连接模式下【不需要】自己做解密与验签");
  });

  it("轮询那一发真的按证据表里的参数名去问远端", async () => {
    const f = fakeFetch();
    const c = channel({ approverChatId: "oc_abc" }, f.fetchImpl);
    await c.start();
    await c.pollOnce();
    const url = f.urls.find((u) => u.includes("/im/v1/messages")) ?? "";
    expect(url).toContain("container_id_type=chat");
    expect(url).toContain("container_id=oc_abc");
    expect(url).toContain("sort_type=ByCreateTimeAsc");
    expect(url).not.toContain("sort_desc");
  });

  it("⭐ chat_id 过编码：它是运营者手填的，不能拿它往查询串里塞参数", async () => {
    // 不编码会怎样：一个填成 `oc_x&sort_type=ByCreateTimeDesc` 的 chat_id 会
    // 改掉这一发的排序，而这件事在日志上完全看不出来（URL 只有一位数不同）。
    const f = fakeFetch();
    const c = channel({ approverChatId: "oc a&b" }, f.fetchImpl);
    await c.start();
    await c.pollOnce();
    const url = f.urls.find((u) => u.includes("/im/v1/messages")) ?? "";
    expect(url).toContain("container_id=oc%20a%26b");
    expect(url.split("container_id=")[1]?.split("&")[0]).toBe("oc%20a%26b");
  });

  it("按钮标签三份齐（卡片上【没有第四个按钮的位置】）", () => {
    const labels = cardDoc(card()).actions.map((a) => a.text.content);
    expect(labels).toEqual(["批准", "驳回并留言", "先放着，细看"]);
  });
});
