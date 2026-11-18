/**
 * IM 审批通道的**装配点**（O12 动作 2 的后一半）。
 *
 * ── 这个文件存在的唯一理由 ────────────────────────────────────────────
 * `channels/approval-bridge.ts`（round280）把 `actorFor` / `loadCard` / `act` 三格装配好了，
 * `channels/feishu.ts`（本轮）把远端接上了，而**两者中间那次「在常驻进程里造出来」的动作
 * 此前全仓没有**。抽象层文件头等的就是这一行：「谁调、什么时候调、失败怎么办，都归调用方
 * （今天是 `serve/assemble.ts`）」。没有这一段，前面两半在用户那边的读数仍然是 0 ——
 * 与 O12 现状那句「有实现 + 有测试 + 零调用方」是同一个形状，只是这一格缺的是**通电**。
 *
 * ── 为什么单独成模块而不内联进 boot（与 `bindForAssembly` / `pumpBoundsOf` 同一条理由）─
 * 内联在 boot 里的判据，它的**坏那一支可能根本没有活的分母**：boot 要真库、真锁、真 server
 * 才跑得起来，而「env 缺三项 ⇒ 不接通道而 Hub 照起」这一发用 boot 判一次要付一整套装配。
 * 抽出来之后「没配 ⇒ absent」「起不来 ⇒ Hub 不跟着一死」「溢出要说」「取走必须判决」四发
 * 都用一份假 env 加一个假 writer 就能打红。**判据住在纯函数里，boot 只剩说什么话。**
 *
 * ── 三条不是显然的判断（各自都想过反面）────────────────────────────────
 * ① **通道起不来 ⇒ Hub 照起。**
 *    `Channel.start` 那格写的是「失败必须抛，不许内部吞」，而吞与不吞的**处置权在编排层**，
 *    这一层就是那一层。让 boot 失败的后果是：看板打不开、任务一步不动、心跳不跑 ——
 *    而真相只是「手机上批不了，去桌面批」。一个单用户产品的 Hub 应该继续服务，只在这一个
 *    动作上报错（同 `unavailableGraphFor` 那条决定：抛在**这个动作**上，不抛在**进程**上）。
 *    ⚠ 不吞的另一半是那一句必须说出来，见 `pushError`。
 * ② **每一轮入站走派发，不 await 在心跳 job 里。**
 *    与章程泵 / 驱动器同一条纪律，而这里的量级不同：`pollOnce` 里是【一发或多发】
 *    外网 HTTP。⚡ 那一发今天有自设截止（`FEISHU_FETCH_TIMEOUT_MS`，见文件头③），
 *    但【派发这一条不许改回 await】—— 一发有上限不等于一轮有上限（一轮最多
 *    取 token + N 页读 + 发卡相加，可越过心跳下界），而且那份截止依赖注入实现
 *    读 `init.signal`，那条约定【没有机器判据】。
 *    一次挂在半路的请求会把心跳 job 卡住，于是 ticker 走 timer.ts 那条
 *    「上一轮心跳还没结束，本轮【跳过】」⇒ **停滞检测与每日备份被一次飞书请求停掉**，
 *    且不计 consecutiveFailures、不触发 onFatal、不退进程 —— 0044 量过的那个完全静默的
 *    形状换了个凶手。⇒ 并发由 `imWatch` 挡，关机后的新活由 `beginCancel` 挡，
 *    在飞的那一发由 `settle` 等（否则一次入站会写进一个已经关掉的队列）。
 * ③ **入站只能从 `runtime.pollAll()` 进。**
 *    本模块**不自己 drain 适配器队列**。抽象层那条「取走的每一条都必须被判决」（`got` 与
 *    `handled.length` 必须相等）是它自己实现并且自己被测过的；装配层另写一遍 drain 就是
 *    造出第二条入站路径 —— 正是 `Channel` 接口头那段（「第二条路径的存在本身就是 §11.4 的
 *    漏洞」）反对的事，只不过这次的第二条路径在**编排层**而不在适配器里。
 *    所以这里只做 pollAll 做不到的那一半：**先让适配器读一次远端**（pollAll 只 drain 队列，
 *    它不知道要去问飞书），再把判决读出来报一声。
 *
 * ── 三件边界：一件已接、两件仍没做 ────────────────────────────────────
 * ① **发卡（`deliverCard`）从 round283 起【已经接上】**。它此前一直零生产调用方，缺的不是
 *    调用点而是「这张卡送过没有」那个答案 —— 迁移 0009 那张 `card_deliveries` 补的就是那一格，
 *    `channels/deliver.ts` 是它的第一个写方，`pollRound()` 每轮心跳派一次。
 *    ⚠ 接上之后仍然要读准它的射程：台账只记【成功】的投递，失败的尝试不留行（0009 文件头），
 *    而「发失败」的卡带着那一行留下 ⇒ 不会自动重试，重推是 `clearDeliveriesFor` 那一次
 *    **显式**的人工动作。所以「卡自己会长到手机上」这句话仍然只对第一次成立。
 * ② `knownRoles` **不注入**，与 `http/bindings.ts` 那条同一条口径：角色存在性的判据要
 *    装配方给一个集合，而那个集合该由谁产生是组织图那一格的事（0030 §8 登记的缺口）。
 *    这里给一个"看着像"的集合会比不给更坏：它会悄悄把组织图之后新增的角色判成不存在。
 *    **两边都不判**才是与写侧一致的答案。
 * ③ 那发 HTTP 的超时【已经有默认值了】：`FeishuChannel` 给每一发（取 token / 读消息 /
 *    发卡）挂一个 `AbortSignal.timeout(FEISHU_FETCH_TIMEOUT_MS)`，注入实现读 `init.signal`
 *    就能拿到同一个截止。⚠ 射程要说准：适配器**一定交出**信号，但**管不住注入实现读不读**
 *    —— 一份忽略 signal 的假 fetch 或真 SDK 会让这一格在结构上失效，
 *    所以真凭据在 `feishu-http.test.ts` 那两发（真 socket 不答，打在默认实现上）。
 *    ⚠ 发卡接上之后一轮心跳里【有两类】外网调用（读回传 + 推卡片）共用同一条 watch；
 *    超时把「永远不结束」这一半治了，没治「两类互相挡」—— 那一格仍是同一条 watch 的形状。
 */

import type {
  ChannelPollRound,
  ChannelRuntime,
  ChannelVerdict,
} from "../channels/abstraction.js";
import { createChannelRuntime } from "../channels/abstraction.js";
import {
  type ChannelRegistry,
  makeApprovalBridge,
} from "../channels/approval-bridge.js";
import {
  type DeliverFailure,
  type DeliverPassOutcome,
  runDeliverPass,
} from "../channels/deliver.js";
import {
  FEISHU_ENV,
  FeishuChannel,
  type FeishuFetch,
  type FeishuLongConnection,
  feishuChannelId,
  feishuEnvMissing,
} from "../channels/feishu.js";
import type { HubWriter } from "../db/write-queue.js";
import type { DomainEvent } from "../events/bus.js";

/** 装出来的那一套：运行时要注入的三格 + 真通道实例 + 生命周期。 */
export interface ImBundle {
  readonly runtime: ChannelRuntime;
  /** 这一台造出来的通道实例（今天只有一种适配器，所以类型是具体的）。 */
  readonly channels: readonly FeishuChannel[];
  /** 注册进运行时的通道表，交给桥做平台判定。 */
  readonly registry: readonly ChannelRegistry[];
  /**
   * 一轮完整的往返：起（幂等）→ 每条通道读一次远端 → 把队列交给运行时判决 → 推没送过的卡。
   *
   * ⚠ **不抛**。抛上来的后果不是「这一轮没做成」而是「watch 里的 rejection 被吞掉」
   * （`createInFlightWatch.start` 为了让 settle 永不 reject 会 `.catch` 掉），于是
   * "IM 一整轮没跑"这件事真的静默了 —— 而那是本仓认定最贵的一类失效。
   * 所有失败都在这里翻成 `notes`。
   *
   * ⚠ 四件事的顺序（start → read → judge → deliver）在函数体里，**不在调用方**：
   * 拆给调用方管的话，"忘了先 start" 与 "read 之前先 judge" 两种写法都编译得过，
   * 而后果分别是「永远收不到」与「队列永远是空的」。
   * ⚠ 最后那一格（deliver）必须在 judge 【之后】：反了会把审批人刚在手机上批掉的那张卡
   * 在同一轮里再推一次 —— 而那正是台账整张表要防的形状，只是换在一个更隐蔽的时刻发生。
   */
  pollRound(): Promise<ImRoundReport>;
  /** 关通道。一条坏通道不许带走其余（`shutdownChannels` 的口径）。 */
  closeAll(): Promise<readonly string[]>;
  /** 已经说过话的错误（去重用，见 `pushError`）。给测试读，不是给运行时报的。 */
  errorsSaid(): readonly string[];
}

/** 一句话该用哪个喇叭。判据只在本模块，见 `summarize`。 */
export type ImNoteLevel = "log" | "warn";

export interface ImNote {
  readonly level: ImNoteLevel;
  readonly text: string;
}

/** 一轮入站的产出。`rounds` 直接是运行时的判决，不重新统计。 */
export interface ImRoundReport {
  /** 每条通道「读远端」这一步的读数（抛错的那些在这里报，不抛）。 */
  readonly reads: readonly {
    readonly channelId: string;
    readonly read: number;
    readonly error: string | null;
  }[];
  readonly rounds: readonly ChannelPollRound[];
  /**
   * 一轮发卡（O12 动作 4）。⚠ 它排在 `rounds` 【之后】，不是随手加的最后一格：
   * 先判回传、再扫 pending，否则审批人上一轮在手机上批掉的那张卡会在同一轮里被再推一次。
   */
  readonly deliver: ImDeliverReport;
  readonly notes: readonly ImNote[];
}

export interface AssembleImOptions {
  readonly w: HubWriter;
  /** 决策事件的广播出口。必填（桥的理由同 `makeApprovalBridge`：不广播就是造 seq 洞）。 */
  readonly publish: (e: DomainEvent, seq: number) => void;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  /** 时钟注入点，与 `BootOverrides.now` 同一个。 */
  readonly now?: () => number;
  /**
   * 那一发 HTTP 的实现。装配方【应当】显式交出，不给才落到 `FeishuChannel` 里那份默认 fetch。
   * 为什么不在这层给默认值：
   *  ① 与 `desktop/src/main/signed-fetch.ts` 文件头同一条立场 —— 一个没人调的默认值
   *    会把「忘了传」变成「第一次真发请求时才发现」；
   *  ② 测试必须传：不传就会真打外网。
   * ⚠ 交出实现的一方【必须读 `init.signal`】。适配器每一发都挂了一个会自己到点的
   *    `AbortSignal.timeout`（`FEISHU_FETCH_TIMEOUT_MS`），而它管不住注入实现读不读 ——
   *    不读就是「看起来有超时而实际一个都没生效」，且没有任何一发会红。
   *    心跳那一轮走派发（文件头③），一次永不返回的外网请求会让这一条 watch 永远不结。
   */
  readonly fetchImpl?: FeishuFetch;
  /** 长连接的注入点（生产上交给 `@larksuiteoapi/node-sdk`，测试里交假对象）。 */
  readonly longConnection?: FeishuLongConnection;
}

/**
 * 一轮发卡的读数。四档互斥：要么真推了一趟，要么这一格根本没推。
 *
 * 为什么把「没推」做成三个不同的档而不是一句 `null`：
 * 「装配了多条通道所以不猜路由」「这一轮通道没起来」「整轮抛错」是三件要改在不同地方的事 ——
 * 一张路由表 / 一次 token 或网络 / 一条库错误。合成一个 null 就得靠日志文本分辨它们。
 * ⚠ 三档都【必须】说话（走 `pushError`）：一轮没推而屏幕上什么都不说，
 * 与「从没打算发卡」逐字相同 —— 那是本模块文件头①反对的那个症状。
 */
export type ImDeliverReport =
  | {
      readonly kind: "pushed";
      readonly channelId: string;
      readonly delivered: number;
      readonly alreadySent: number;
      readonly skippedNotPending: number;
      readonly failed: readonly DeliverFailure[];
      readonly notes: readonly ImNote[];
    }
  | { readonly kind: "not_routed"; readonly why: string }
  | { readonly kind: "not_started"; readonly why: string }
  | { readonly kind: "threw"; readonly why: string };

/**
 * 一趟发卡 → 零到几句人话。
 *
 * ── 为什么 `failed` 那句【不需要】去重 ──────────────────────────────
 * 本模块其他地方每条错误都要过 `pushError` 那张去重表（一条持续失败的远端会每天说
 * 1440 遍同一句话）。发卡这一档结构上不会重演：投递失败时台账那一行【留着】
 * （`deliver.ts` 文件头那条不对称），下一轮它读作 `alreadySent` ⇒ 同一条失败
 * 只会说一次。所以这里直接返回，不进 `said` —— 进了反而会挡掉同一张卡
 * 后来真正第二次失败的那一句（不同原因该说两遍，同 `pushError` 的口径）。
 */
export function summarizeDeliver(p: DeliverPassOutcome): readonly ImNote[] {
  const out: ImNote[] = [];
  if (p.delivered > 0) {
    out.push({
      level: "log",
      text:
        "本轮推给审批人 " +
        p.delivered +
        " 张卡（已推过的由台账挡着，不重发）。",
    });
  }
  if (p.failed.length > 0) {
    const list = p.failed
      .map((f) => f.approvalId + "（" + f.why + "）")
      .join("、");
    out.push({
      level: "warn",
      text:
        "发卡失败 " +
        p.failed.length +
        " 张：" +
        list +
        "\n  · 这一句【只说一次】：台账那一行已经落了，下一轮这些卡读作「已推过」而【不会再自动重试】。" +
        "要重推是人工决定 —— `clearDeliveriesFor(w, approvalId)` 清掉台账行，下一轮当新卡再推。\n" +
        "  · 台账读得出「我们抢过这一对」，读不出「审批人收到没有」：抢在发之前 ⇒ " +
        "成功与失败那两种在库里【都是同一行】（deliver.ts 文件头那条不对称换来的人工重试）。" +
        "所以「这一张到底到没到人手里」只有日志说过，而日志跨不过重启（0009 文件头那条射程边界）。",
    });
  }
  return out;
}

/** env 齐了没有 —— 与 `channels/feishu.ts` 的必填三项【同一个函数】，不另写一份。 */
export function imEnvMissing(
  env: Readonly<NodeJS.ProcessEnv>,
): readonly string[] {
  return feishuEnvMissing(env);
}

/**
 * 装一条（今天只有一条）飞书审批通道。
 *
 * 缺 env ⇒ `{kind:"absent", missing}` 而**不抛**：`hub serve` 的入口约定是
 * 「所有失败翻成 {ok:false}」，而没配 IM 是**常态**不是故障。抛一次会让「不接 IM」
 * 那一档需要一个开关；返回缺什么，调用方打一行真话然后照跑。
 */
export function assembleImChannels(o: AssembleImOptions): ImAssembly {
  const missing = imEnvMissing(o.env);
  if (missing.length > 0) return { kind: "absent", missing };

  /**
   * 错误去重表 + 待说话队列。
   *
   * 为什么必须有去重：心跳下界 60 秒 ⇒ 一条持续失败的远端会每天说 1440 遍同一句话。
   * 那不是提醒是**噪音**，而噪音的实际后果（O13 那条同族）是人把终端静音，于是那句
   * 真该听的（「审批人点了而这边落不下去」）也一起被静音。
   * ⚠ 去重【只作用于错误类】，不作用于每轮的入站汇总 —— 后者每轮都是关于这一轮的真话，
   * 文本相同不代表事情相同（两轮各批掉一张不同的卡，汇总文本是一模一样的）。
   * 口径再说准一点：这里去重的是【同一句错误】，不是【同一类错误】。所以
   * 「同一张卡两次失败而 why 不同」会说两遍 —— 那是偏吵的方向，而偏吵是有意的：
   * 把 why 归一化成"种类"要造一份错误分类表，那份表本身会长歪。
   */
  const said = new Set<string>();
  let pending: ImNote[] = [];
  const pushError = (s: string): void => {
    if (said.has(s)) return;
    said.add(s);
    pending.push({ level: "warn", text: s });
  };

  const channel = new FeishuChannel({
    // channelId 是【可不配】的一项，而「缺省是什么 + 空白算不算没给」只有【一处】回答
    // （适配器那份）。这里再写一份字面量或再写一遍 `?? 默认值` 就会有两个答案：
    // 有人改了缺省值之后，装配点仍然给出旧 id，而 registry 那张表是从实例上读的 ——
    // 于是它跟着错下去且全绿。
    channelId: feishuChannelId(o.env),
    appId: (o.env[FEISHU_ENV.appId] ?? "").trim(),
    appSecret: (o.env[FEISHU_ENV.appSecret] ?? "").trim(),
    approverOpenId: (o.env[FEISHU_ENV.approverOpenId] ?? "").trim(),
    ...bind(o.env, FEISHU_ENV.approverChatId, "approverChatId"),
    ...bind(o.env, FEISHU_ENV.origin, "origin"),
    ...(o.longConnection === undefined
      ? {}
      : { longConnection: o.longConnection }),
    ...(o.fetchImpl === undefined ? {} : { fetchImpl: o.fetchImpl }),
    ...(o.now === undefined ? {} : { now: o.now }),
    onOverflow: (dropped) => {
      // 溢出必须说话：计划 Task 4.4 明令「不得静默吞掉审批」，而这里丢掉的那一条是一个
      // 审批人真的点过的批准。丢最老那条（`boundedPush` 的口径）意味着它已经排了 256 条
      // —— 那仍然是一条不该 quietly 消失的决定。
      pushError(
        "IM 通道 " +
          dropped.message.channelId +
          " 的入站队列满了（上限 256 条），丢掉最老的一条。" +
          "被丢那条的发送者 " +
          dropped.message.senderId +
          "，而库里【没有任何记录】" +
          "（该通道的处理速度跟不上到达速度 —— 先看是不是心跳间隔太长）。",
      );
    },
  });
  const channels: readonly FeishuChannel[] = [channel];
  /**
   * 注册表**从实例上读**，不另写一份字面量。
   *
   * 桥拿它做「channelId → 平台」的映射，而平台判错的后果在 `makeBoundRoleReader` 的注释里
   * 写着：两条通道共用一份平台猜测时，A 平台的账号会去 B 平台那张表里查，外部 id 撞车
   * （两边都是手机号）时就是**拿错角色**，且全绿。写
   * `[{channelId:"feishu-ceo-dm", platform:"feishu"}]` 今天为真，而它不会在有人把
   * channelId 改成 env 可配之后变红 —— 读实例会。
   */
  const registry: readonly ChannelRegistry[] = channels.map((c) => ({
    channelId: c.id,
    platform: c.platform,
  }));

  const bridge = makeApprovalBridge({ w: o.w, registry, publish: o.publish });
  const runtime = createChannelRuntime({
    deps: {
      now: o.now ?? (() => Date.now()),
      loadCard: bridge.loadCard,
      act: bridge.act,
    },
    actorFor: bridge.actorFor,
  });
  for (const c of channels) runtime.register(c);

  /**
   * 起来过的通道 id。
   *
   * 一个 Set 而不是一个 boolean：一Set 让「这一条起不来而下一条照起」与
   * 「下一轮再试一次没起来的那条」两件事都能表达，而 boolean 只能表达后者的一半。
   * 重试是**有意的**：一次 token 请求的代价比"永久放弃"便宜，而"永久放弃"的失效面是
   * 一台 Hub 从此再也收不到审批而屏幕上什么都不说。
   */
  const started = new Set<string>();

  /**
   * 一轮发卡（O12 动作 4）。**不抛**，理由与 `pollRound` 同一条：watch 会吞 rejection。
   *
   * ── 为什么【不】对每条通道各推一遍 ────────────────────────────────
   * 库里没有任何一列说「这张卡走哪条通道」，所以多条通道时"对每条都发"是一个
   * **造出来的**语义（同一张卡推给同一个人的两个入口）。`runDeliverPass` 因此只收一条
   * `channelId`，而这一层也不替它猜：**多于一条就干脆不推，并把不推的理由说出来**。
   * 那比"每轮推 N 遍"诚实 —— 症状从「审批人手机上同一张卡出现两次」变成
   * 「屏幕上有一句『发卡停住了：路由没有依据』」，而后者指对了要改的东西（一张路由表）。
   * 今天 `channels` 恒为一条，所以这一支没有活的分母；它防的是"加第二条通道那天"。
   *
   * ── 为什么排在入站判决【之后】──────────────────────────────────────
   * 反过来的话，审批人上一轮在手机上批掉的那张卡会在同一轮里被再推一次 ——
   * 那张卡已经在库里是 approved，`runDeliverPass` 只扫 pending，所以正确顺序是
   * **先判回传、再扫 pending**。顺序在本函数体内，不在调用方（同 start→read→judge）。
   */
  async function deliverRound(): Promise<ImDeliverReport> {
    const c = channels.length === 1 ? channels[0] : undefined;
    if (c === undefined) {
      const why =
        "本轮【没有推任何卡】：装配了 " +
        channels.length +
        " 条通道，而库里没有任何一列说「这张卡走哪条通道」" +
        "⇒ 对每条都发等于把同一张卡推给同一个人的多个入口，那是造出来的语义。" +
        "要接多条通道需要先有一张路由表（见 channels/deliver.ts 的 channelId 那一栏）。";
      pushError(why);
      return { kind: "not_routed", why };
    }
    // 这一轮没起来的通道不推。不挡的话 `send` 会在【每张卡】上抛一次，
    // 于是那一句「发卡失败 N 张」把成因（token 都没拿到）说成了逐张的问题，
    // 而台账会替每一张卡落下「抢到了而没送到」那一行 —— 一批本来根本不该试的卡
    // 从此不再自动推，要人一张张清。上面那条 start 失败的 warn 已经把真因说过了。
    if (!started.has(c.id)) {
      const why =
        "本轮【没有推任何卡】：通道 " +
        c.id +
        " 这一轮没起来（原因在上面那一句里说过）。" +
        "台账【一行都没写】⇒ 起来之后的那一轮会照常推，一张都不会漏。";
      pushError(why);
      return { kind: "not_started", why };
    }
    try {
      const pass = await runDeliverPass({
        w: o.w,
        channels,
        channelId: c.id,
        nowMs: (o.now ?? (() => Date.now()))(),
      });
      const notes = summarizeDeliver(pass);
      pending.push(...notes);
      return { kind: "pushed", channelId: c.id, ...pass, notes };
    } catch (e) {
      // runDeliverPass 只在该抛的时候抛：通道没注册（这里不可能）与外键之外的库错。
      // 后者每轮都会重演 ⇒ 走 pushError 去重，理由与「读远端失败」那一条一模一样。
      const why =
        "发卡那一趟【整轮抛错】（" +
        String(e) +
        "）⇒ 本轮【没有推任何卡】，而台账【没有】写坏：抢台账是逐张一事务，" +
        "抛在哪一张上就只有那一张没落地。手机上现在收不到任何新卡，" +
        "已推出去的照旧能批。";
      pushError(why);
      return { kind: "threw", why };
    }
  }

  const bundle: ImBundle = {
    runtime,
    channels,
    registry,
    async pollRound(): Promise<ImRoundReport> {
      const reads: {
        channelId: string;
        read: number;
        error: string | null;
      }[] = [];
      for (const c of channels) {
        if (!started.has(c.id)) {
          try {
            await c.start();
            started.add(c.id);
          } catch (e) {
            pushError(
              "IM 通道 " +
                c.id +
                " 起不来（" +
                String(e) +
                "）⇒ 手机上【这一轮】收不到卡、" +
                "点了也没有回传。Hub 其余部分照跑，审批请在桌面端做。" +
                "\n→ 每一轮入站都会重试一次，而这一句同一原因【只说一次】。",
            );
            reads.push({
              channelId: c.id,
              read: 0,
              error: "start 失败（原因已单独说过）",
            });
            continue;
          }
        }
        try {
          reads.push({
            channelId: c.id,
            read: await c.pollOnce(),
            error: null,
          });
        } catch (e) {
          reads.push({ channelId: c.id, read: 0, error: String(e) });
          pushError(
            "IM 通道 " +
              c.id +
              " 本轮读远端失败（" +
              String(e) +
              "）。" +
              "⚠ 「读数 0」与「坏了」是两个事实：水位【没有】推进，所以恢复之后会补读，" +
              "而这段时间里手机上点了的按钮【还没收到】。",
          );
        }
      }
      const rounds = await runtime.pollAll();
      pending.push(...summarize(rounds));
      const deliver = await deliverRound();
      /**
       * 一次性带走：返回之后 `pending` 必须是空的。
       *
       * 不排空的话这一格变成跨轮累积 —— 第 1 轮那句「批掉 1 张」会在第 2、3、… 轮的
       * 终端上重播，而它说的是第 1 轮。那种重复比噪音更坏：它让人以为这一轮真的
       * 又批掉了一张卡。 notes 的语义是【这一轮要说的话】，不是【攒着的话】。
       */
      const notes = pending;
      pending = [];
      return { reads, rounds, deliver, notes };
    },
    async closeAll(): Promise<readonly string[]> {
      const failed: string[] = [];
      for (const c of channels) {
        try {
          await c.close();
          started.delete(c.id);
        } catch (e) {
          // 带上原因：调用方那句「关停失败」的下一句是「可能还有一条连接在收消息」，
          // 而排查方向完全取决于这一格是「网络断了」还是「SDK 根本没提供 stop」。
          failed.push(c.id + "（" + String(e) + "）");
        }
      }
      return failed;
    },
    errorsSaid(): readonly string[] {
      return [...said];
    },
  };
  /**
   * `notes` 不在接口上另开一个"随时可取"的读取口，而是由 `pollRound` 的返回值一次性带走。
   * 留一个随时可读的口子会让「这一轮的 notes」变成「上次谁取了什么」，
   * 而两个调用方各取一次会得到两条互补的半截真话。
   *
   * ⚠ `closeAll` 的失败【不走 notes】：关停那一档在 boot 的清理路径上，
   * 而清理路径只把 notes 打出来就已经太晚了 —— 它由调用方（`assemble.ts` 的 shutdown）
   * 直接 io.warn，见 `ImBundle.closeAll` 的返回值。
   */
  return { kind: "present", bundle };
}

export type ImAssembly =
  | { readonly kind: "absent"; readonly missing: readonly string[] }
  | { readonly kind: "present"; readonly bundle: ImBundle };

/**
 * 可选 env → `{键: 值}` 或 `{}`。
 *
 * 两处走同一个函数而不是各 trim 各判空：少一种"一个 trim 了另一个没有"的漂移。
 * 空白必须算没给，否则 `approverChatId: " "` 会被当成【给了】⇒ 每轮拿一个空格去问远端
 * 要消息 ⇒ 每轮一条 error，而没人会想到成因是那个空格。
 * ⚠ 判空这件事在适配器里还有一遍（`FeishuChannel.canPoll` 自己读 cfg 时也 trim），
 * 那不是两条判据而是【同一判据的两个入口】（配置期 / 运行期）：cfg 那一格是可选手写
 * 传入的，所以运行期那一遍不能省，而两边取值必须一致。
 */
function bind(
  env: Readonly<NodeJS.ProcessEnv>,
  key: string,
  cfgKey: "approverChatId" | "origin",
): Partial<
  Pick<
    ConstructorParameters<typeof FeishuChannel>[0],
    "approverChatId" | "origin"
  >
> {
  const v = (env[key] ?? "").trim();
  // exactOptionalPropertyTypes: true ⇒ 不能给 `{approverChatId: undefined}`，
  // 只能返回一个【没有这个键】的对象。这一格不是挑剔：给了 undefined 键
  // 会让 FeishuConfig 上那个可选键存在而值为 undefined，`?? ""` 那一半就白写了。
  return v === "" ? {} : ({ [cfgKey]: v } as Record<string, string>);
}

/**
 * 一轮判决 → 零到几句人话。**每轮都重新说**，不去重（见 `pushError` 那条）。
 *
 * ── 为什么是【每轮一句汇总】而不是【每条判决一句】──────────────────────
 * `ignored_not_action` 是 IM 里的闲聊、@、贴图（审批人先回一句「在吗」）。逐条打日志会把
 * 真错淹掉 —— 那是 abstraction.ts 第①步那条「所有告警都响等于没有告警」在编排层的复发。
 * 所以：
 *  · `ignored_not_action` / `duplicate` **完全不说**（正常噪声，重投是飞书的常态）；
 *  · `acted` 单独是 log（好消息，且是这一层存在的目的）；
 *  · `unauthorized` / `failed` / `channel_refused` 把整句抬成 warn（每一个都指向一个动作）；
 *  · `card_missing` / `card_decided` / `not_actionable` 只进尾巴塞，保持 log ——
 *    它们每一轮都会重新判一次（重投的那一条每轮都会说"已经有人批过"），抬成 warn
 *    等于给自己造一条每 60 秒响一次的告警。
 *
 * ── `got !== handled.length` 必须能说出来 ─────────────────────────────
 * 运行时那条「取走的每条都必须被判决」是它自己被测过的性质，本函数读的是它的【产出】。
 * 这里再判一次**不是**重复判据，而是【唯一能把它变成人话的位置】：运行时只交出数据，
 * 而「一个数量正确的销毁证明」在日志上什么都不写。真红的那一发在 im-channels.test.ts
 * （伪造一个 pollAll 给出不等的轮次，不必动运行时一行代码）。
 */
export function summarize(
  rounds: readonly ChannelPollRound[],
): readonly ImNote[] {
  const out: ImNote[] = [];
  for (const r of rounds) {
    if (r.failedOpen) {
      out.push({
        level: "warn",
        text:
          "IM 通道 " +
          r.channelId +
          " 本轮取消息时抛错（pollAll 已就地隔离，其余通道不受影响）。",
      });
      continue;
    }
    if (r.got === 0) continue;
    if (r.got !== r.handled.length) {
      out.push({
        level: "warn",
        text:
          "IM 通道 " +
          r.channelId +
          " 本轮取走 " +
          r.got +
          " 条而只判决了 " +
          r.handled.length +
          " 条 ⇒ **有消息被取走而没有落任何判决**。那是「数量正确的销毁证明」那个形状，" +
          "要查 runtime.pollAll 而不是查远端。",
      });
      continue;
    }
    const n = countBy(r.handled.map((h) => h.verdict));
    const head = [];
    let warn = false;
    if (n.acted > 0) head.push("批掉 " + n.acted);
    if (n.unauthorized > 0) {
      head.push("没有绑定的账号点了 " + n.unauthorized);
      warn = true;
    }
    if (n.failed > 0) {
      head.push("判决失败 " + n.failed);
      warn = true;
    }
    if (n.channelRefused > 0) {
      head.push("通道自己拒绝 " + n.channelRefused);
      warn = true;
    }
    const tail: string[] = [];
    if (n.cardMissing > 0) tail.push("卡不在库里 " + n.cardMissing);
    if (n.cardDecided > 0) tail.push("已经有人批过 " + n.cardDecided);
    if (n.notActionable > 0)
      tail.push("按策略不许在这条通道批 " + n.notActionable);
    if (head.length === 0 && tail.length === 0) continue; // 全是闲聊与重投 ⇒ 什么都不说。
    out.push({
      level: warn ? "warn" : "log",
      text:
        "IM 通道 " +
        r.channelId +
        " 本轮入站 " +
        r.got +
        " 条：" +
        (head.length > 0 ? head.join("、") : "没有一条落成决策") +
        (tail.length > 0 ? "（另有 " + tail.join("、") + "）" : ""),
    });
  }
  return out;
}

/** 九种判决 → 七个计数。`ignored_not_action` 与 `duplicate` 不数（见 summarize 那条）。 */
function countBy(verdicts: readonly ChannelVerdict[]) {
  let acted = 0;
  let unauthorized = 0;
  let failed = 0;
  let cardMissing = 0;
  let cardDecided = 0;
  let notActionable = 0;
  let channelRefused = 0;
  for (const v of verdicts) {
    switch (v.kind) {
      case "acted":
        acted += 1;
        break;
      case "unauthorized":
        unauthorized += 1;
        break;
      case "failed":
        failed += 1;
        break;
      case "card_missing":
        cardMissing += 1;
        break;
      case "card_decided":
        cardDecided += 1;
        break;
      case "not_actionable":
        notActionable += 1;
        break;
      case "channel_refused":
        channelRefused += 1;
        break;
      default:
        break;
    }
  }
  return {
    acted,
    unauthorized,
    failed,
    cardMissing,
    cardDecided,
    notActionable,
    channelRefused,
  };
}

/** 横幅那一句话，外加「该用 log 还是 warn」。判据只在这一处。 */
export interface ImBanner {
  readonly line: string;
  /** true ⇒ 这一台**少了**一件本来能有的能力，该用 `io.warn` 说。 */
  readonly warn: boolean;
}

/**
 * 启动横幅里那句「IM 通道的状态」。
 *
 * 四种形状各说一句，而**每一句都要说**：
 *  · 没配 ⇒ 说缺哪几个 env 名字。不说的那台机器上，人只知道「手机上没有卡」，
 *    而排查方向会是「飞书应用没配好」，真相是启动命令少设了三个变量。
 *    这一档用 log 不用 warn：没配 IM 是常态，不是少了什么该修的东西。
 *  · 配了而缺 `approverChatId` ⇒ 说「只出不进」，且这一档是 warn。
 *    它承重：卡会推到手机上，而回传那一路读不到。`supportsActionReturn === false`
 *    已经把卡变成只读形态（按钮根本不给），那句横幅是给运营者的成因说明。
 *  · 配齐 ⇒ 说通道 id，并把**发卡已经接上、但它只做一次**这件事说出来（见 `ImBundle.pollRound`
 *    最后那一格）。配齐而只说「已装配」会让运营者以为手机上会自己长出卡来 —— 现在它确实会长，
 *    所以这句换成另一件事：一张卡只推一次，失败的不自动重试。
 *  · 装配出来的通道表是空的 ⇒ 那是个不该发生的形状，仍然要说而不是当没事。
 */
export function imBannerOf(r: ImAssembly): ImBanner {
  if (r.kind === "absent") {
    return {
      warn: false,
      line:
        "IM 审批通道【没接】：env 里缺 " +
        r.missing.join("、") +
        "。\n" +
        "  · 现在：审批人在手机上收不到卡，审批请在桌面端做。其余一切照常。\n" +
        "  · 要接：设齐 " +
        FEISHU_ENV.appId +
        " / " +
        FEISHU_ENV.appSecret +
        " / " +
        FEISHU_ENV.approverOpenId +
        "（可选 " +
        FEISHU_ENV.approverChatId +
        "、" +
        FEISHU_ENV.channelId +
        "、" +
        FEISHU_ENV.origin +
        "）之后重启。",
    };
  }
  const c = r.bundle.channels[0];
  if (c === undefined) {
    return {
      warn: true,
      line: "IM 审批通道：装配出来的通道表是空的（不该发生，请查装配点）。",
    };
  }
  if (!c.canPoll) {
    return {
      warn: true,
      line:
        "IM 审批通道已装配：" +
        c.id +
        "（平台 " +
        c.platform +
        "），但【读不到点击回传】。\n" +
        "  · 缺 " +
        FEISHU_ENV.approverChatId +
        " ⇒ 每张卡都以【只读】形态出去（按钮点了没人收，所以干脆不给按钮）。\n" +
        "  · 拿 chat_id 的一次机会：让审批人先给机器人发一条消息，那条事件里带着它。",
    };
  }
  return {
    warn: false,
    line:
      "IM 审批通道已装配：" +
      c.id +
      "（平台 " +
      c.platform +
      "）；回传走每轮心跳读一次审批人单聊" +
      "（长连接只在装配方注入 @larksuiteoapi/node-sdk 那份时才开）。\n" +
      "  · 发卡已接上：每轮心跳在判完回传【之后】扫一遍 pending，把没推过的推上这一条通道。" +
      "幂等靠库里的 card_deliveries（跨重启），所以一张卡只会推一次。\n" +
      "  · ⚠ 而「只会推一次」包含失败那一次：推送失败时台账那一行【留着】，" +
      "所以那张卡【不会自动重试】，要人显式清台账（`clearDeliveriesFor`）。" +
      "这是有意的取舍 —— 宁可看得见一次漏推，不要看不见一轮轰炸。",
  };
}
