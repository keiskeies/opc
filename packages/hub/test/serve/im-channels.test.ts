/**
 * `serve/im-channels.ts` 的分母 —— 装配点自己那四发承重判据。
 *
 * ── 为什么要有这个文件（O12 动作 2 的后一半）────────────────────────
 * `channels/approval-bridge.ts` 有 12 发验收测试（acceptance/im-reply-approves-card），
 * `channels/abstraction.ts` 有抽象层契约清单，而**装配那一步此前一发都没有**。
 * 装配点坏了的样子不是逻辑错，是「那条链在生产里不存在」：
 * `dead-modules` 能报「模块走不到」，但它在 round281 之后**不再覆盖**这两个模块
 * （基线条目按设计摘除了），所以从今天起「链断在装配层」只能由本文件抓住。
 * 见 approval-bridge.ts 文件头那句同一口径的话：删掉 im-channels 里那一次
 * `makeApprovalBridge` 调用，它自己的测试一发都不会红 —— 除了这里。
 *
 * ── 四发最承重的（装配点文件头列的那四格，这里逐个有活的分母）─────────
 *  ① env 缺三项 ⇒ `absent` 而【Hub 照起】：不抛，且缺的是【名字】不是值；
 *  ② 通道起不来 ⇒ `pollRound` 不抛而说一次，且每一轮真的再试一次；
 *  ③ 溢出必须说话（计划 Task 4.4 明令不得静默吞审批）；
 *  ④ 取走必须判决 ⇒ `got !== handled.length` 这一发【伪造 pollAll】打红，
 *     运行时一行代码都不用动（它是被替换的那个属性，不是被模仿的行为）。
 *
 * ── 写这一篇时抓到的一件事（比那四发更值钱）─────────────────────────
 * `messageToEnvelope` 把轮询读到的回传标成 `kind:"text"`，而抽象层第①步是
 * `msg.kind !== "card_action"` ⇒ `ignored_not_action`，而 `summarize` 对
 * `ignored_not_action` 刻意【什么都不说】（防噪音那条口径）。两个各自正确的决定
 * 叠起来 = 审批人从手机点了批准，Hub 一行日志不打，卡片永远 pending。
 * ⇒ 那一格现在有名字了（「轮询读到的回传算 card_action」那一发），
 * 而它是本篇【唯一先红后绿】的一发：先按装配点当时的样子跑，它红在
 * `ignored_not_action` 上。写测试这一格把一条真 bug 从「从没跑通过」变成了
 * 「跑通了且钉住了」—— 这也反过来证明 r16 那句射程修正说对了：
 * 那 12 发验收走的是【假通道】，所以轮询那一路空转它们全看不见。
 *
 * ── 假远端为什么按【时间窗】过滤（而不是无脑回同一份列表）──────────────
 * 水位这件事唯一的可观测产出就是【下一次问远端时那个 start_time】。假远端如果无视
 * 窗口照旧返回整份列表，「不重播上一轮」「失败之后会补读」这两发就只能断言一个测试
 * 自己造的数组 —— 那是【把结论写进夹具】。窗口在这里生效之后，那两发红在真读数上。
 *
 * ── 真链路与假链路的分界（别把这里读成「真飞书通了」）─────────────────
 * `fetchImpl` 是注入的：本文件证明的是【装配形状对】—— env → 通道 → 一轮入站 →
 * 桥 → 库里那一行真的变了。真飞书接口在本机一次也没打通过（要真凭据），
 * r16 那条主张改的就是这条边界，别拿这里的绿去宣布它绿了。
 *
 * ── 跑法 ──────────────────────────────────────────────────────────────
 *   npx vitest run packages/hub/test/serve/im-channels.test.ts
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCard } from "../../src/approvals/cards.js";
import { markVerified, requestBinding } from "../../src/bindings/im.js";
import { CHANNEL_QUEUE_LIMIT } from "../../src/channels/abstraction.js";
import {
  FEISHU_DEFAULT_CHANNEL_ID,
  FEISHU_ENV,
  type FeishuCardActionEvent,
  type FeishuFetch,
  type FeishuLongConnection,
  type FeishuMessageItem,
} from "../../src/channels/feishu.js";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { insertTask } from "../../src/http/real-deps.js";
import {
  type AssembleImOptions,
  assembleImChannels,
  type ImAssembly,
  type ImBundle,
  imBannerOf,
  imEnvMissing,
  summarize,
} from "../../src/serve/im-channels.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("serve-im-channels", import.meta.url);
const NOW = 1_700_000_000_000;
/** 飞书的 create_time 是【秒】，而注入的 `now` 是毫秒 ⇒ 基准单独算一份。 */
const SEC = Math.floor(NOW / 1000);
const TASK_ID = "t-imch-1";
const ROLE = "director";
const APPROVER = "ou_approver_1";
const SECRET = "super-secret-app-secret";
const APP_ID = "cli_test_app";
const CHAT_ID = "oc_test_chat";

const queues: WriteQueue[] = [];
let fileSeq = 0;

/** 齐配置的一份 env（三项必填全给，chat_id 也给 ⇒ `canPoll` 为真）。 */
function envFull(over: Record<string, string | undefined> = {}) {
  return {
    [FEISHU_ENV.appId]: APP_ID,
    [FEISHU_ENV.appSecret]: SECRET,
    [FEISHU_ENV.approverOpenId]: APPROVER,
    [FEISHU_ENV.approverChatId]: CHAT_ID,
    ...over,
  } as Record<string, string>;
}

/* ═══════════════ 假远端：认时间窗，且【不记 body】 ═══════════════ */

/**
 * 注入给通道的那一份假 fetch。
 *
 * ⚠ 刻意【不记请求 body】：断言失败时 vitest 会把比对的两侧原样打进日志，
 * 而 token 那一发的 body 里就是 `app_secret`。测试日志也是一处日志
 * （本仓口径：错误串与日志里不许出现密钥，见 `channels/feishu.ts` 的 `#tokenOf`）。
 * 要看「有没有带授权头」时，比的是【当场拒绝那一发】而不是事后翻记录。
 */
interface FakeRemote {
  readonly fetchImpl: FeishuFetch;
  /** 列表接口每一次被问到的 URL（水位那几发读它里面的 start_time）。 */
  readonly listUrls: string[];
  tokenCalls(): number;
  listCalls(): number;
  /** 往会话里放一条消息（所有测试各有一条自己的会话）。 */
  add(item: FeishuMessageItem): void;
  /** 接下来那一次列表请求回一个业务错（模拟「这一轮读远端失败」）。 */
  failList(code?: number): void;
  /** 接下来 n 次列表请求都回「还有下一页」，且 page_token 恒为同一个。 */
  loopPages(n: number): void;
  /**
   * 让列表接口【永远】回「还有下一页 + 同一个 page_token」，并带上这些条目。
   * 第二次的标记与第一次相同 ⇒ 触发翻页守卫 ⇒ 这一轮被【截断】。
   */
  stallAfter(items: readonly FeishuMessageItem[]): void;
  /** token 接口回什么。netError = 请求根本没走通。 */
  tokenMode: "ok" | "http500" | "netError";
  /**
   * 发卡（`POST /im/v1/messages`）被打了几次 —— 幂等那一格唯一的可观测产出。
   *
   * ⚠ 与 `listUrls` 同一条纪律：只数【次数】，不记 body。卡片正文本身没秘密，
   * 但"记了 body"迟早被人拿去 `toEqual` 一份录下来的请求，而断言失败时 vitest
   * 会把两侧原样打进日志（本仓口径，见文件头与 `channels/feishu.ts` 的 `#tokenOf`）。
   */
  sendCalls(): number;
  /** 接下来那一次发卡回一个业务错（模拟「推送被平台拒了」）。 */
  failSend(code?: number): void;
}

function fakeRemote(): FakeRemote {
  const listUrls: string[] = [];
  const items: FeishuMessageItem[] = [];
  let tokenSeen = 0;
  let sendSeen = 0;
  let sendFailCode: number | null = null;
  let failCode: number | null = null;
  let pageLoops = 0;
  let stallItems: FeishuMessageItem[] | null = null;
  const isToken = (u: string): boolean => u.includes("tenant_access_token");
  const r: FakeRemote = {
    listUrls,
    tokenMode: "ok",
    add: (item) => {
      items.push(item);
    },
    failList: (code = 99991663) => {
      failCode = code;
    },
    loopPages: (n) => {
      pageLoops = n;
    },
    stallAfter: (its) => {
      stallItems = [...its];
    },
    tokenCalls: () => tokenSeen,
    listCalls: () => listUrls.length,
    sendCalls: () => sendSeen,
    failSend: (code = 230002) => {
      sendFailCode = code;
    },
    fetchImpl: async (url, init) => {
      if (isToken(url)) {
        tokenSeen += 1;
        if (r.tokenMode === "netError")
          throw new Error("getaddrinfo ENOTFOUND");
        if (r.tokenMode === "http500")
          return { status: 500, json: async () => ({}) };
        return {
          status: 200,
          json: async () => ({
            code: 0,
            tenant_access_token: "t-1",
            expire: 3600,
          }),
        };
      }
      // ── 授权头：三条路（token 之后）共用同一道门 ──
      // 原来这一句只挡列表那一条，POST 要自己再写一遍 —— 那就是两份手抄，
      // 而其中一份被改掉时「没带 token 也照发」这个坏形状会悄悄通过。
      if (!init.headers["authorization"]?.startsWith("Bearer ")) {
        return {
          status: 401,
          json: async () => ({ code: 99991661, msg: "no token" }),
        };
      }
      // ── 发卡：POST /im/v1/messages。⚠ 必须在 listUrls 之前分流 ──
      // 水位那几发读的是 listUrls 里最后一条 URL 的 start_time；把 POST 也算进去
      // 会让「下一次窗口」读到一张卡的 URL（上面根本没有 start_time）⇒ Number(null)=NaN，
      // 于是那几发会红在一个与它要判的事无关的地方。
      if (init.method === "POST") {
        sendSeen += 1;
        if (sendFailCode !== null) {
          const code = sendFailCode;
          sendFailCode = null;
          return {
            status: 200,
            json: async () => ({ code, msg: "平台不收这张卡" }),
          };
        }
        return {
          status: 200,
          json: async () => ({ code: 0, data: { message_id: "om-1" } }),
        };
      }
      listUrls.push(url);
      if (failCode !== null) {
        const code = failCode;
        failCode = null;
        return {
          status: 200,
          json: async () => ({ code, msg: "远端说不上话" }),
        };
      }
      if (stallItems !== null) {
        // 每次都回同一份 has_more + 同一个 page_token ⇒ 第二次被守卫截断。
        const its = stallItems;
        return {
          status: 200,
          json: async () => ({
            code: 0,
            data: { items: its, has_more: true, page_token: "p1" },
          }),
        };
      }
      if (pageLoops > 0) {
        // 每次都把它减一 ⇒ 坏守卫的写法会在若干次之后【干净地结束】而不是挂死 180s，
        // 于是这一发比的是「问了几次」：守卫在 ⇒ 2 次；守卫没了 ⇒ n+1 次。
        pageLoops -= 1;
        return {
          status: 200,
          json: async () => ({
            code: 0,
            data: { items: [], has_more: true, page_token: "p1" },
          }),
        };
      }
      const q = new URLSearchParams(url.slice(url.indexOf("?") + 1));
      const start = Number(q.get("start_time"));
      const end = Number(q.get("end_time"));
      const win = items.filter((it) => {
        const c = Number(it.create_time ?? "-1");
        return c >= start && c <= end;
      });
      return {
        status: 200,
        json: async () => ({ code: 0, data: { items: win } }),
      };
    },
  };
  return r;
}

/** 审批人在单聊里点了一次「批准」= 一条 text 消息，正文就是那个载荷。 */
function clickItem(
  approvalId: string,
  o: { at?: number; sender?: string } = {},
): FeishuMessageItem {
  return textItem(approvalId + "|approve", o.at ?? SEC, o.sender ?? APPROVER);
}

/** 会话里的一条任意文本（闲聊、或解不出一次的坏载荷）。 */
function textItem(
  text: string,
  at: number,
  sender = APPROVER,
): FeishuMessageItem {
  return {
    message_id: "msg-" + at + "-" + text.length,
    msg_type: "text",
    create_time: String(at),
    body: { content: JSON.stringify({ text }) },
    sender: { id: sender },
  };
}

/* ═════════════════════════ 真库夹具 ═════════════════════════ */

async function newQ(name: string): Promise<WriteQueue> {
  const path = join(TMP, name + "-" + process.pid + "-" + ++fileSeq + ".db");
  const q = new WriteQueue(path);
  queues.push(q);
  migrate(q.writeConnection());
  await insertTask(q, {
    id: TASK_ID,
    title: "上线支付模块",
    assignedRole: ROLE,
    nowMs: NOW,
  });
  return q;
}

/** 一张【可逆】的待批卡 + 一条已验证的绑定（与 acceptance 那篇同一条口径）。 */
async function seedVerifiedCard(q: WriteQueue): Promise<string> {
  const r = await createCard(
    q,
    {
      taskId: TASK_ID,
      approvalType: "budget_override",
      summary: "本季度预算超支 12%，请求追加",
      parameters: {
        impact_scope: "本季度研发预算",
        irreversible: false,
        recommendation: "推荐：先砍非必要实验（推荐，非决定）",
        recommendation_is_not_decision: true,
        timeout_behavior: "auto_reject",
      },
      evidence_refs: ["evidence/burn-down-11.md"],
      buttons: ["approve", "reject_with_comment", "defer_deep_review"],
    },
    { nowMs: NOW },
  );
  const approvalId = r.result.approvalId;
  await requestBinding(q, {
    platform: "feishu",
    externalUserId: APPROVER,
    role: ROLE,
    nowMs: NOW,
  });
  await markVerified(q, {
    platform: "feishu",
    externalUserId: APPROVER,
    verifiedBy: "ceo",
    nowMs: NOW + 1,
  });
  return approvalId;
}

function cardStatus(q: WriteQueue, approvalId: string): string | undefined {
  const row = q
    .readConnection()
    .prepare("SELECT status FROM approvals WHERE id = ?")
    .get(approvalId) as { status?: string } | undefined;
  return row?.status;
}

/**
 * 【决策】那一条审计的 actor。
 *
 * ⚠ 必须滤掉 `hub`：`createCard` 自己就往 `events` 写一条 `action='approval'`
 * 的建行（actor_type=hub / actor_id=hub），所以「一条决策审计都不写」如果按
 * `action='approval'` 数，会在【建卡成功而什么都没批】上红。acceptance 那篇
 * 同一条断言写的就是 `actor_id !== 'hub'` —— 这里第一版漏了那一格，
 * 红出来的读数是 `["hub"]`，正好把「建行」与「决策」两种 approval 审计分开。
 */
function decidedActors(q: WriteQueue, approvalId: string): string[] {
  return (
    q
      .readConnection()
      .prepare(
        "SELECT actor_id FROM events WHERE target = ? AND action = 'approval' AND actor_id <> 'hub' ORDER BY id",
      )
      .all(approvalId) as { actor_id: string }[]
  ).map((x) => x.actor_id);
}

interface FakeLong extends FeishuLongConnection {
  /** 通道在 start() 里注册进来的那个处理器（长连接那一路的入口）。 */
  emit(ev: FeishuCardActionEvent): void;
  starts: number;
  stops: number;
  registered: number;
  /** 设了它 ⇒ stop() 抛这个（关停失败那一发）。 */
  stopThrows: string | null;
}

function fakeLong(): FakeLong {
  let handler: ((ev: FeishuCardActionEvent) => void) | null = null;
  const l = {
    starts: 0,
    stops: 0,
    registered: 0,
    stopThrows: null as string | null,
    onCardAction(h: (ev: FeishuCardActionEvent) => void): void {
      handler = h;
      l.registered += 1;
    },
    async start(): Promise<void> {
      l.starts += 1;
    },
    stop(): void {
      l.stops += 1;
      if (l.stopThrows !== null) throw new Error(l.stopThrows);
    },
    emit(ev: FeishuCardActionEvent): void {
      if (handler === null) throw new Error("通道还没在 start() 里注册处理器");
      handler(ev);
    },
  };
  return l;
}

interface Harness {
  readonly q: WriteQueue;
  readonly remote: FakeRemote;
  readonly assembly: Extract<ImAssembly, { kind: "present" }>;
  readonly bundle: ImBundle;
  readonly long: FakeLong;
}

async function harness(
  name: string,
  o: {
    env?: Record<string, string | undefined>;
    tokenMode?: "ok" | "http500" | "netError";
    long?: boolean;
  } = {},
): Promise<Harness> {
  const q = await newQ(name);
  const remote = fakeRemote();
  if (o.tokenMode !== undefined) remote.tokenMode = o.tokenMode;
  const long = fakeLong();
  const opts: AssembleImOptions = {
    w: q,
    publish: () => {},
    env: envFull(o.env ?? {}),
    now: () => NOW,
    fetchImpl: remote.fetchImpl,
    ...(o.long === true ? { longConnection: long } : {}),
  };
  const assembly = assembleImChannels(opts);
  if (assembly.kind !== "present") {
    throw new Error(
      "夹具预期装配成功，实到 absent：" + assembly.missing.join(","),
    );
  }
  return { q, remote, assembly, bundle: assembly.bundle, long };
}

/** 下一次列表请求里的 start_time —— 水位唯一的可观测产出。 */
function nextWindowStart(remote: FakeRemote): number {
  const last = remote.listUrls[remote.listUrls.length - 1] ?? "";
  const q = new URLSearchParams(last.slice(last.indexOf("?") + 1));
  return Number(q.get("start_time"));
}

const kindsOf = (rep: {
  rounds: readonly { handled: readonly { verdict: { kind: string } }[] }[];
}): string[] => rep.rounds[0]?.handled.map((x) => x.verdict.kind) ?? [];

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

/* ══════════════════ ① 没配 ⇒ absent，而 Hub 照起 ══════════════════ */

describe("① env 没配 ⇒ absent：不抛、说得出缺哪三个名字、且【不说】值", () => {
  it("空 env ⇒ absent，missing 是三项的【名字】，横幅用 log 不用 warn", () => {
    const r = assembleImChannels({
      w: null as never,
      publish: () => {},
      env: {},
    });
    expect(r.kind).toBe("absent");
    if (r.kind !== "absent") return;
    expect(r.missing).toEqual([
      FEISHU_ENV.appId,
      FEISHU_ENV.appSecret,
      FEISHU_ENV.approverOpenId,
    ]);
    const b = imBannerOf(r);
    // 没配 IM 是常态不是故障 ⇒ log。抬成 warn 的那台机器上 warn 天天响，
    // 于是真该听的（「审批人点了而这边落不下去」）跟着被静音。
    expect(b.warn).toBe(false);
    for (const name of r.missing) expect(b.line).toContain(name);
    // 「怎么接」也要说得出：运营者的排查方向应该是少设了变量，不是飞书应用坏了。
    expect(b.line).toContain(FEISHU_ENV.approverChatId);
  });

  it("空白算没给（与 bind() 同一条口径），且不因为 chat_id 缺失而判缺", () => {
    expect(
      imEnvMissing({
        [FEISHU_ENV.appId]: "cli",
        [FEISHU_ENV.appSecret]: "   ",
        [FEISHU_ENV.approverOpenId]: "ou_1",
      }),
    ).toEqual([FEISHU_ENV.appSecret]);
    // chat_id 刻意【不在】必填名单里：缺它是「只出不进」，不是「装不起来」。
    expect(
      imEnvMissing(envFull({ [FEISHU_ENV.approverChatId]: undefined })),
    ).toEqual([]);
  });

  it("横幅里不出现凭据的值（要打印的话只能有名字）", () => {
    const b = imBannerOf({ kind: "absent", missing: imEnvMissing({}) });
    expect(b.line).not.toContain(SECRET);
    expect(b.line).not.toContain(APP_ID);
  });
});

/* ══════════════════ 装配形状：id / registry / 横幅 ══════════════════ */

describe("② 装配出来的那一套：id 只有一处回答，registry 从实例上读", () => {
  it("channelId 自定义生效，且 registry 跟着实例走（不是字面量）", async () => {
    const h = await harness("custom-id", {
      env: { [FEISHU_ENV.channelId]: "feishu-cfo-dm" },
    });
    expect(h.bundle.channels.map((c) => c.id)).toEqual(["feishu-cfo-dm"]);
    expect(h.bundle.registry).toEqual([
      { channelId: "feishu-cfo-dm", platform: "feishu" },
    ]);
    // 运行时里那条通道与实例是同一个对象：只改 registry 而不改实例会在这里露馅。
    expect(h.bundle.runtime.channels().map((c) => c.id)).toEqual([
      "feishu-cfo-dm",
    ]);
  });

  it("⭐ channelId 给了空白 ⇒ 回落缺省，而不是注册一条【没有名字】的通道", async () => {
    // `?? 默认值` 只挡【没给】。`OPC_FEISHU_CHANNEL_ID=" "` 那一版会造出一条
    // id 为空串的通道：它照样注册、照样进 registry、照样进每一行日志，
    // 症状是「日志里通道没有名字」，而成因是那次 export 多敲了个空格。
    const h = await harness("blank-id", {
      env: { [FEISHU_ENV.channelId]: "   " },
    });
    expect(h.bundle.channels[0]?.id).toBe(FEISHU_DEFAULT_CHANNEL_ID);
    expect(h.bundle.registry[0]?.channelId).toBe(FEISHU_DEFAULT_CHANNEL_ID);
  });

  it("配齐 ⇒ 横幅是 log，并把「只会推一次」里包含失败那一次当面说出来", async () => {
    const h = await harness("banner-full");
    const b = imBannerOf(h.assembly);
    expect(b.warn).toBe(false);
    expect(b.line).toContain(FEISHU_DEFAULT_CHANNEL_ID);
    // 配齐而只说「已装配」会让运营者以为手机上会自己长出卡来 —— 而现在真的会长，
    // 于是这句话的【重心换了】：要当面说的是「一张卡只推一次，而失败也算那一次」，
    // 否则第一次推送失败之后那张卡永远不再自己动，而屏幕上一个字都没说。
    expect(b.line).toContain("card_deliveries");
    expect(b.line).toContain("clearDeliveriesFor");
  });

  it("缺 chat_id ⇒ canPoll=false，横幅抬成 warn，且【根本不去读会话】", async () => {
    const h = await harness("no-chat", {
      env: { [FEISHU_ENV.approverChatId]: undefined },
    });
    expect(h.bundle.channels[0]?.canPoll).toBe(false);
    const b = imBannerOf(h.assembly);
    expect(b.warn).toBe(true);
    expect(b.line).toContain(FEISHU_ENV.approverChatId);
    const rep = await h.bundle.pollRound();
    expect(rep.reads).toEqual([
      { channelId: FEISHU_DEFAULT_CHANNEL_ID, read: 0, error: null },
    ]);
    // 一次会话消息都不该去读（token 那一发是 start() 的本职：卡还要推得出去）。
    expect(h.remote.listCalls()).toBe(0);
    // 而「读不到回传」必须落到 supportsActionReturn 上：轮询跑不起来 ⇒ 卡片以
    // 只读形态出去，而不是发一张带按钮而永远没人收的卡（0025 §3 那个形状）。
    expect(h.bundle.channels[0]?.supportsActionReturn).toBe(false);
  });

  it("通道表为空 ⇒ 横幅仍然说话（不该发生的形状不许当没事）", () => {
    const fake = {
      kind: "present",
      bundle: { channels: [] },
    } as unknown as ImAssembly;
    const b = imBannerOf(fake);
    expect(b.warn).toBe(true);
    expect(b.line).toContain("不该发生");
  });
});

/* ══════════════════ ③ 通道起不来 ⇒ Hub 不跟着一死 ══════════════════ */

describe("③ 通道起不来：不抛、说一次、每轮真的重试", () => {
  it("token 请求根本没走通 ⇒ pollRound 不抛，说得出「收不到」与「没推卡」两句且给出处置方向", async () => {
    const h = await harness("start-fail", { tokenMode: "netError" });
    const rep = await h.bundle.pollRound();
    expect(rep.reads[0]?.read).toBe(0);
    expect(rep.reads[0]?.error).toContain("start 失败");
    // ⚠ 从 round283 起这里是【两句】：起不来本身 + 发卡那一趟因此没跑。
    // 少第二句会开出一个真缺口：屏幕上只有「读不到回传」，而运营者据此以为
    // 卡还在往外推 —— 那时症状是「审批人手机上一张新卡都没来过」，
    // 与「从没打算接 IM」逐字相同（本模块文件头①反对的正是这个）。
    expect(rep.notes).toHaveLength(2);
    for (const n of rep.notes) expect(n.level).toBe("warn");
    expect(rep.notes[0]?.text).toContain("桌面");
    expect(rep.deliver.kind).toBe("not_started");
    expect(rep.notes[1]?.text).toContain("台账【一行都没写】");
    for (const n of rep.notes) expect(n.text).not.toContain(SECRET);
    // 起不来 ⇒ 运行时那一轮仍然照跑（交出 got 0 的一条轮次，而不是抛）。
    expect(rep.rounds).toHaveLength(1);
  });

  it("⭐ 同一句错误只说一次，而重试【每轮都真的发生】", async () => {
    const h = await harness("retry", { tokenMode: "http500" });
    expect((await h.bundle.pollRound()).notes).toHaveLength(2);
    const afterFirst = h.remote.tokenCalls();
    // 两句都过 pushError：去重之后第二轮【一句都不说】，而重试照旧发生。
    expect((await h.bundle.pollRound()).notes).toEqual([]);
    // 去重不等于放弃：token 又被打了一次。少了这一句，
    // 「说一次然后永久放弃」与「说一次并且继续试」在日志上不可区分，
    // 而前者的失效面是「这台 Hub 从此再也收不到审批而屏幕上什么都不说」。
    expect(h.remote.tokenCalls()).toBeGreaterThan(afterFirst);
    // 两句【不同】的话各说一次（起不来 + 因此没推卡），去重表里就是两条。
    // 这里要是写成 1，等于承诺「发卡那一趟不单独说话」—— 而那正是上面
    // ③ 第一发反对的那个症状。
    expect(h.bundle.errorsSaid()).toHaveLength(2);
  });

  it("⭐ 读远端失败 ⇒ 读数 0 而那句说清「水位没推进」，且【真的】会补读", async () => {
    const h = await harness("read-fail");
    const approvalId = await seedVerifiedCard(h.q);
    // 这一条落在【本轮窗口内】，而这一轮读远端失败。
    h.remote.add(clickItem(approvalId, { at: SEC - 30 }));
    h.remote.failList();
    const rep = await h.bundle.pollRound();
    expect(rep.reads[0]?.error).toContain("99991663");
    expect(rep.notes[0]?.level).toBe("warn");
    // 「读数 0」会被读成「审批人没点」，而真相是「点了而这边没收到」—— 话上必须分得开。
    expect(rep.notes[0]?.text).toContain("水位");
    expect(cardStatus(h.q, approvalId)).toBe("pending");
    // ⚠ 那句承诺【真的】兑现：下一轮窗口仍覆盖那一条，于是它被补读并批掉。
    // 失败时也推进水位的写法在这里红 —— 而且红的是【卡片还是 pending】，
    // 不是某句文案（把承诺写进错误串而不兑现，比不写更坏）。
    const rep2 = await h.bundle.pollRound();
    expect(rep2.reads[0]?.read).toBe(1);
    expect(kindsOf(rep2)).toEqual(["acted"]);
    expect(cardStatus(h.q, approvalId)).toBe("approved");
  });

  it("长连接只在装配方注入时才开（没注入 ⇒ 压根不碰它）", async () => {
    const h = await harness("with-long", { long: true });
    await h.bundle.pollRound();
    expect(h.long.starts).toBe(1);
    expect(h.long.registered).toBe(1);
    const h2 = await harness("without-long");
    await h2.bundle.pollRound();
    expect(h2.long.starts).toBe(0);
    expect(h2.long.registered).toBe(0);
  });
});

/* ═══════════ 发卡那一趟（round283，O12 动作 4）：装配点上的四件事 ═══════════ */

/**
 * 这里只测【装配那一格】，不重跑 `test/channels/deliver.test.ts` 那 17 发。
 *
 * 分工是清楚的：台账语义、幂等、FK、四档计数由那一文件（真库 + 假通道）判；
 * 这里判的是【只有装配层才答得出的那四件事】—— 用哪条通道、什么时候排、
 * 用真适配器发、以及卡片形态那一刻的判定从哪儿来。
 * 把台账那几发在这里重跑一遍会开出一个坏东西：两份分母，改一处另一处照绿。
 */
describe("一轮心跳真的把卡推出去（round283，O12 动作 4）", () => {
  /** 台账今天有几行 —— 「推没推」唯一的库内证据（外网上发了多少次另说）。 */
  function ledger(q: WriteQueue, approvalId: string): number {
    const row = q
      .readConnection()
      .prepare(
        "SELECT COUNT(*) AS n FROM card_deliveries WHERE approval_id = ?",
      )
      .get(approvalId) as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  it("⭐ pending 卡经装配点真的发出去，并落一行台账", async () => {
    const h = await harness("deliver-push");
    const approvalId = await seedVerifiedCard(h.q);
    const rep = await h.bundle.pollRound();
    expect(rep.deliver.kind).toBe("pushed");
    if (rep.deliver.kind !== "pushed") return;
    expect(rep.deliver.channelId).toBe(FEISHU_DEFAULT_CHANNEL_ID);
    expect(rep.deliver.delivered).toBe(1);
    // 真飞书适配器 + 注入 fetch ⇒ POST 真的到了"远端"。这一发证明的是【装配形状对】，
    // 不是「真飞书通了」—— 那条边界写在文件头，r16 改的就是它。
    expect(h.remote.sendCalls()).toBe(1);
    expect(ledger(h.q, approvalId)).toBe(1);
    expect(rep.notes.some((n) => n.text.includes("推给审批人 1"))).toBe(true);
  });

  it("⭐ 台账跨轮生效：第二轮一次都不发，屏幕上也不重复那句话", async () => {
    const h = await harness("deliver-once");
    await seedVerifiedCard(h.q);
    const first = await h.bundle.pollRound();
    expect(first.deliver.kind === "pushed" && first.deliver.delivered).toBe(1);
    const afterFirst = h.remote.sendCalls();
    const second = await h.bundle.pollRound();
    expect(second.deliver.kind === "pushed" && second.deliver.delivered).toBe(
      0,
    );
    expect(second.deliver.kind === "pushed" && second.deliver.alreadySent).toBe(
      1,
    );
    // 幂等必须落在【外网调用次数】上，而不是只落在读数上：
    // 台账挡不住 send 的话，屏幕上那句「本轮推给审批人 0 张」照样说得体面，
    // 而审批人每 60 秒收到一张重复卡 —— 那比不推更坏（它把人训练成忽略这张卡）。
    expect(h.remote.sendCalls()).toBe(afterFirst);
    expect(second.notes).toEqual([]);
  });

  it("⭐ 发卡排在判决【之后】：同一轮里刚批掉的卡不会被推出去", async () => {
    const h = await harness("deliver-after-judge");
    const approvalId = await seedVerifiedCard(h.q);
    // 这一条【落在本轮窗口内】—— 所以"先扫 pending 再判回传"那个坏顺序会真的推它。
    h.remote.add(clickItem(approvalId, { at: SEC }));
    const rep = await h.bundle.pollRound();
    expect(kindsOf(rep)).toEqual(["acted"]);
    expect(cardStatus(h.q, approvalId)).toBe("approved");
    expect(rep.deliver.kind === "pushed" && rep.deliver.delivered).toBe(0);
    // 读 0 而不是 skippedNotPending 1：`PENDING_APPROVAL_IDS_SQL` 扫的时候那张卡
    // 【已经】是 approved 了（判决在它之前）。skippedNotPending 那一档管的是
    // 扫描与逐张读之间的那条竞态，与这里的顺序无关 —— 把两档混起来写，
    // 这一发对"顺序对了但逐张读丢了"就变瞎。
    expect(rep.deliver.kind === "pushed" && rep.deliver.skippedNotPending).toBe(
      0,
    );
    expect(h.remote.sendCalls()).toBe(0);
    expect(ledger(h.q, approvalId)).toBe(0);
    /**
     * ⚠ 这一发的分母是【真造出来的】，不是嘴上说的。
     *
     * `supportsActionReturn` 是一张卡在 `claimDelivery` 组参数时读一次的 getter，
     * 于是它是「卡已读到、台账那一行还没落笔」这条时间线上唯一的非 SQL 动作。
     * 把 `deliverRound()` 挪到 `runtime.pollAll()` 之前，这一发就在
     * `sendCalls()).toBe(0)` 上红 —— 那条改动的症状正是「审批人上一轮在手机上
     * 批掉的卡，这一轮又收到一次」，而那一句台账答不出来（库里那一行照旧）。
     */
    expect(h.bundle.channels[0]?.supportsActionReturn).toBe(true);
  });

  it("推送被平台拒了 ⇒ 台账那一行【留着】，且那一组只说一次、说清怎么重推", async () => {
    const h = await harness("deliver-fail");
    const approvalId = await seedVerifiedCard(h.q);
    h.remote.failSend();
    const rep = await h.bundle.pollRound();
    expect(rep.deliver.kind === "pushed" && rep.deliver.delivered).toBe(0);
    expect(rep.deliver.kind === "pushed" && rep.deliver.failed).toHaveLength(1);
    const warn = rep.notes.filter((n) => n.level === "warn");
    expect(warn).toHaveLength(1);
    expect(warn[0]?.text).toContain("发卡失败 1 张");
    expect(warn[0]?.text).toContain("clearDeliveriesFor");
    expect(warn[0]?.text).not.toContain(SECRET);
    // 这一行是「不自动重试」的全部依据 —— 它若被抹掉，那句「只说一次」就成了谎。
    expect(ledger(h.q, approvalId)).toBe(1);
    const second = await h.bundle.pollRound();
    expect(second.notes).toEqual([]);
    expect(h.remote.sendCalls()).toBe(1);
  });
});

/* ══════════════════ ④ 真链路：一轮入站真的落成决策 ══════════════════ */

describe("④ 装配通了：env → 通道 → 一轮入站 → 桥 → 库里那一行真的变了", () => {
  it("⭐ 审批人单聊里那条批准文本，经装配点把卡批掉", async () => {
    const h = await harness("e2e");
    const approvalId = await seedVerifiedCard(h.q);
    h.remote.add(clickItem(approvalId));
    const rep = await h.bundle.pollRound();
    expect(rep.reads[0]?.read).toBe(1);
    expect(kindsOf(rep)).toEqual(["acted"]);
    expect(rep.notes).toHaveLength(1);
    expect(rep.notes[0]?.level).toBe("log");
    expect(rep.notes[0]?.text).toContain("批掉 1");
    // 落在【库里】，不是落在测试自己造的读数上。
    expect(cardStatus(h.q, approvalId)).toBe("approved");
    const actors = decidedActors(h.q, approvalId);
    expect(actors).toContain(ROLE);
    expect(actors).not.toContain("system");
    expect(actors).not.toContain("ceo");
    // 一轮跑完 ⇒ 回传那一路【确实】活着（supportsActionReturn 的 true 这一支）。
    expect(h.bundle.channels[0]?.supportsActionReturn).toBe(true);
  });

  it("⭐ 轮询读到的回传算 card_action：kind 写错会让整条审批路静默空转", async () => {
    // 本篇唯一先红后绿的那一发。写它之前，轮询那一路【一次也没真的批准过】：
    // 抽象层把 kind !== "card_action" 判成闲聊，而 summarize 对闲聊刻意不说任何话
    // ⇒ 审批人点了批准，终端一行都不打，卡片永远 pending。
    // 这里让【卡不在库里】，于是判决必须是 card_missing 而不是 ignored_not_action：
    // 「走到了第⑤步」与「在第①步就被当闲聊扔掉」在这两发红点上分得清清楚楚。
    const h = await harness("kind");
    await seedVerifiedCard(h.q);
    h.remote.add(clickItem("ap_not_in_db", { at: SEC - 1 }));
    const rep = await h.bundle.pollRound();
    expect(kindsOf(rep)).toEqual(["card_missing"]);
    expect(kindsOf(rep)).not.toContain("ignored_not_action");
  });

  it("⭐ 第二轮不重播上一轮的话，也不重读上一轮的消息", async () => {
    const h = await harness("drain");
    const approvalId = await seedVerifiedCard(h.q);
    h.remote.add(clickItem(approvalId));
    const first = await h.bundle.pollRound();
    expect(first.notes).toHaveLength(1);
    const second = await h.bundle.pollRound();
    // 假远端按窗口过滤 ⇒ 水位没推进的话，这一发 read 会是 1 而判决是 duplicate。
    expect(second.reads[0]?.read).toBe(0);
    // notes 是【一次性带走】的：不排空 pending 的话这一发会再打印一次「批掉 1」，
    // 那比噪音更坏 —— 它让人以为这一轮【又】批掉了一张卡。
    expect(second.notes).toEqual([]);
    // 下一次窗口从【水位 + 1】开始：贴着水位问会把上一秒那条重新读回来。
    expect(nextWindowStart(h.remote)).toBe(SEC + 1);
  });

  it("⭐ 闲聊与坏载荷不入队，而水位【照它们推进】", async () => {
    // ⚠ 顺序是这一发唯一的分量所在：批准在【前】(SEC-7)，闲聊在【后】(SEC-6)。
    // 反过来排（闲聊在前）时，「只推进被收下的那条」这个坏写法会推进到同一个
    // 时间戳上 ⇒ 这一发【全绿】。我第一版就是这么排的，M4 因此逃掉了 ——
    // 判据要能区分，夹具就得让两种写法给出不同的读数（这条是写完变异才补对的）。
    const h = await harness("chitchat");
    const approvalId = await seedVerifiedCard(h.q);
    h.remote.add(clickItem(approvalId, { at: SEC - 7 }));
    h.remote.add(textItem("在吗", SEC - 6));
    h.remote.add(textItem("ap_x|maybe", SEC - 6));
    const rep = await h.bundle.pollRound();
    // 三条里只有一条真的入队：闲聊与解不出载荷的文本【根本不入队】。
    expect(rep.reads[0]?.read).toBe(1);
    expect(rep.rounds[0]?.got).toBe(1);
    expect(kindsOf(rep)).toEqual(["acted"]);
    // 水位推到【最新那一条】（那两句闲聊），而不是停在「最新被收下的那条」。
    // ⚠ 只能从【下一次】请求的窗口里读出来，所以必须再跑一轮：本轮 URL 里的
    // start_time 是推进之前算的。正确 ⇒ SEC-6 那条把窗口推到 SEC-5；
    // 「只推进被收下的那条」⇒ 停在 SEC-7 ⇒ 这一发红。
    await h.bundle.pollRound();
    expect(nextWindowStart(h.remote)).toBe(SEC - 5);
  });

  it("⭐ 翻页被截断的那一轮【不推进水位】：不许把没读到的那些跳过去", async () => {
    // 守卫让这一轮只读到第一页。边读边推的水位会落进【没读到的那些】里 ——
    // 而远端如果默默忽略 sort_type（本文件上面记过：默认是倒序），没读的那些
    // 是更【旧】的消息，从此永久落在窗口之外，且永远不会自己好。
    const h = await harness("stall");
    const approvalId = await seedVerifiedCard(h.q);
    h.remote.stallAfter([clickItem(approvalId, { at: SEC - 3 })]);
    const rep = await h.bundle.pollRound();
    // 这一轮仍然算「读成功」：读到的那一条照批，读数照报。
    expect(rep.reads[0]?.read).toBe(1);
    expect(kindsOf(rep)).toEqual(["acted"]);
    const firstWindow = nextWindowStart(h.remote);
    // 而下一轮的窗口【停在原地】：宁可重读一遍（deliveryId 会挡住重复），
    // 也不拿一次翻页坏掉换一条永久的黑洞。
    // 比的是「与上一轮同一个值」而不是某个绝对秒数 —— 那个值由回看窗口算出来，
    // 写死它等于把 DEFAULT_LOOKBACK_SEC 抄进测试里，改常量时这一发会红在算错的期望上。
    h.remote.stallAfter([]);
    await h.bundle.pollRound();
    expect(nextWindowStart(h.remote)).toBe(firstWindow);
  });

  it("没绑定的账号点了 ⇒ warn 且【不动库】：装配没把身份判据接丢", async () => {
    const h = await harness("unauth");
    const approvalId = await seedVerifiedCard(h.q);
    h.remote.add(clickItem(approvalId, { sender: "ou_stranger" }));
    const rep = await h.bundle.pollRound();
    // 判序是【身份在通道许可之前】（抽象层第②步）。装配层把它接丢的写法是
    // 「actorFor 换成恒等函数」⇒ 那一改这一发会变 acted，而不是换个判决种类。
    expect(kindsOf(rep)).toEqual(["unauthorized"]);
    expect(rep.notes[0]?.level).toBe("warn");
    expect(cardStatus(h.q, approvalId)).toBe("pending");
    expect(decidedActors(h.q, approvalId)).toEqual([]);
  });

  it("⭐ token 只取一次：一轮里多次远端调用共用同一份令牌", async () => {
    const h = await harness("token-cache");
    const approvalId = await seedVerifiedCard(h.q);
    h.remote.add(clickItem(approvalId));
    await h.bundle.pollRound();
    // start() 一次 + 列表若干次，而 token 请求只有 start 那一次。
    // 每发都取一次令牌在飞书那边是限流自杀，症状则是「偶尔读不到消息」。
    expect(h.remote.tokenCalls()).toBe(1);
    expect(h.remote.listCalls()).toBeGreaterThan(0);
  });

  it("翻页标记没变 ⇒ 停下来（宁可少读也不许自旋）", async () => {
    const h = await harness("pages");
    h.remote.loopPages(5);
    const rep = await h.bundle.pollRound();
    expect(rep.reads[0]?.read).toBe(0);
    // 守卫在 ⇒ 第一页 + 一次「标记没变」= 2 次；守卫没了 ⇒ 6 次。
    // 假远端自己会收敛，所以摘掉守卫是【干净地红在这一发】而不是挂死到超时。
    expect(h.remote.listCalls()).toBe(2);
  });

  it("审批人自己的账号点得动，别人的点不动（canAct 只认那一个 open_id）", async () => {
    const h = await harness("can-act");
    const c = h.bundle.channels[0];
    if (c === undefined) throw new Error("夹具装配出来的通道表是空的");
    expect(c.canAct({ senderId: APPROVER, channelId: c.id }).ok).toBe(true);
    const other = c.canAct({ senderId: "ou_stranger", channelId: c.id });
    expect(other.ok).toBe(false);
    if (other.ok) throw new Error("上面那句已经判过 false，不该走到这里");
    // 那句人话是给用户看的，必须说清「为什么点不动」而不是笼统一句「没权限」。
    expect(other.reason).toContain("审批人");
  });
});

/* ══════════════════ ⑤ 取走必须判决：数量不等要能说话 ══════════════════ */

describe("⑤ 一轮判决 → 人话", () => {
  it("⭐ got 与 handled 不等 ⇒ 红在那句「有消息被取走而没有落任何判决」", async () => {
    const h = await harness("destroy-cert");
    // 伪造 pollAll 的产出：取走 3 条只判决 1 条。运行时一行代码都不用动 ——
    // 装配层读的是它的【产出】，而「一个数量正确的销毁证明」在日志上本来什么都不写。
    const rt = h.bundle.runtime as unknown as { pollAll(): Promise<never> };
    rt.pollAll = async () =>
      [
        {
          channelId: FEISHU_DEFAULT_CHANNEL_ID,
          got: 3,
          handled: [{ key: "k", verdict: { kind: "ignored_not_action" } }],
          failedOpen: false,
        },
      ] as never;
    const rep = await h.bundle.pollRound();
    expect(rep.notes).toHaveLength(1);
    expect(rep.notes[0]?.level).toBe("warn");
    expect(rep.notes[0]?.text).toContain("3");
    expect(rep.notes[0]?.text).toContain("runtime.pollAll");
  });

  it("failedOpen 一句话；全是闲聊与重投则【什么都不说】", () => {
    const open = summarize([
      { channelId: "c1", got: 0, handled: [], failedOpen: true },
    ]);
    expect(open).toHaveLength(1);
    expect(open[0]?.level).toBe("warn");
    // 闲聊与重投完全不说：逐条打日志会把真错淹掉（0019 §5 那条同族）。
    expect(
      summarize([
        {
          channelId: "c1",
          got: 2,
          handled: [
            { key: "k1", verdict: { kind: "ignored_not_action" } },
            { key: "k2", verdict: { kind: "duplicate", key: "k2" } },
          ],
          failedOpen: false,
        },
      ]),
    ).toEqual([]);
    // 而「已经有人批过」进尾巴塞、保持 log：它每轮都会重判一次，
    // 抬成 warn 等于给自己造一条每 60 秒响一次的告警。
    const tail = summarize([
      {
        channelId: "c1",
        got: 1,
        handled: [
          {
            key: "k",
            verdict: {
              kind: "card_decided",
              approvalId: "a",
              status: "approved",
            },
          },
        ],
        failedOpen: false,
      },
    ]);
    expect(tail).toHaveLength(1);
    expect(tail[0]?.level).toBe("log");
    expect(tail[0]?.text).toContain("已经有人批过");
  });

  it("⭐ 错误去重按【同一句】，换一种原因必须再说一遍", async () => {
    const h = await harness("dedup");
    h.remote.failList(99991663);
    expect((await h.bundle.pollRound()).notes).toHaveLength(1);
    h.remote.failList(99991663);
    // 同一句 ⇒ 安静（心跳下界 60 秒 ⇒ 不去重就是每天 1440 遍同一句话）。
    expect((await h.bundle.pollRound()).notes).toEqual([]);
    // 换 code ⇒ 必须再说。按「种类」归一化要一份错误分类表，而那份表会长歪，
    // 所以口径是整句去重 —— 代价（偏吵）写在装配点的 pushError 上。
    h.remote.failList(234001);
    const c = await h.bundle.pollRound();
    expect(c.notes).toHaveLength(1);
    expect(c.notes[0]?.text).toContain("234001");
    expect(h.bundle.errorsSaid()).toHaveLength(2);
  });
});

/* ══════════════════ ⑥ 溢出必须说话 + 关停不带走其余 ══════════════════ */

describe("⑥ 溢出与关停", () => {
  it("⭐ 入站队列满了 ⇒ 说话，且那句自己承认「库里没有任何记录」", async () => {
    const h = await harness("overflow", { long: true });
    await h.bundle.pollRound(); // 让 start() 跑掉，长连接处理器就位
    // 灌到溢出：限流之外再多一条 ⇒ 丢【最老】那条，而它是一条真的点过的批准。
    for (let i = 0; i <= CHANNEL_QUEUE_LIMIT; i++) {
      h.long.emit({
        openId: APPROVER,
        value: { opc: "card-x|approve" },
        eventId: "ev-" + i,
      });
    }
    const rep = await h.bundle.pollRound();
    const note = rep.notes.find((n) => n.text.includes("队列满了"));
    expect(note).toBeDefined();
    expect(note?.level).toBe("warn");
    // 那句要诚实到能被拿去排查：被丢那条是谁 + 库里没有它的记录。
    expect(note?.text).toContain(APPROVER);
    expect(note?.text).toContain("没有任何记录");
    // 同一句只说一次：再灌一条（队列已被上一轮排空）不再重复那条 warn。
    h.long.emit({
      openId: APPROVER,
      value: { opc: "card-x|approve" },
      eventId: "ev-again",
    });
    const rep2 = await h.bundle.pollRound();
    expect(rep2.notes.filter((n) => n.text.includes("队列满了"))).toEqual([]);
  });

  it("closeAll 幂等，且关停失败【带上原因】交回调用方（不走 notes）", async () => {
    const h = await harness("close", { long: true });
    await h.bundle.pollRound();
    expect(await h.bundle.closeAll()).toEqual([]);
    expect(h.long.stops).toBe(1);
    // 幂等：重复关不抛（boot 的清理路径会撞第二次 close）。
    expect(await h.bundle.closeAll()).toEqual([]);
    expect(h.long.stops).toBe(1);
    // 坏通道：返回值带通道 id 与原因，让调用方那句「可能还有连接在收消息」有的放矢。
    const h2 = await harness("close-fail", { long: true });
    await h2.bundle.pollRound();
    h2.long.stopThrows = "sdk stop not implemented";
    const failed = await h2.bundle.closeAll();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain(FEISHU_DEFAULT_CHANNEL_ID);
    expect(failed[0]).toContain("sdk stop not implemented");
    expect(failed[0]).not.toContain(SECRET);
  });

  it("关掉之后 pull 交出空：已关的通道不许再被判决出东西", async () => {
    const h = await harness("closed-pull", { long: true });
    await h.bundle.pollRound();
    h.long.emit({
      openId: APPROVER,
      value: { opc: "card-y|approve" },
      eventId: "ev-y",
    });
    await h.bundle.closeAll();
    expect(h.bundle.runtime.channels()[0]?.pull()).toEqual([]);
    // 关掉之后 supportsActionReturn 必须回落 false：
    // 否则关停窗口里发出去的卡还带着按钮，而点了永远没人收。
    expect(h.bundle.channels[0]?.supportsActionReturn).toBe(false);
  });
});
