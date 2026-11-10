/**
 * Hub 的 HTTP 处理层（计划 Task 2.1，规格 §5.8）。
 *
 * ── 一处对计划的偏离，先记在这里 ──────────────────────────────────────
 * 计划写的是「src/http/app.ts（Hono）」。这一版【不用 Hono】，改用
 * 框架无关的处理函数 + node:http。理由不是偏好，是两条能验证的事实：
 *  ① 本机 pnpm install 跑不起来（离线），hono 装不上 —— 那么 app.ts 里的每一行
 *    都无法运行、无法测试、也无法通过 tsc（模块找不到）。
 *  ② 更根本的：本文件真正的风险【不在传输】。路由分发、鉴权门、状态码口径、
 *    「404 不写审计」这些才是会出错并造成损失的地方，而它们与用哪个框架无关。
 *    把不可验证的部分（框架胶水）与可验证的部分（判定）分开，
 *    前者等依赖到位时补三十行适配即可，后者现在就能被单测穷尽。
 *
 * 反面做法我也考虑过：照计划写一份 Hono 版，报「已实现，但本机测不了」。
 * 那等于交出一份【没人跑过】的路由代码 —— 而它上面挂着鉴权。
 *
 * 处理函数的形状刻意取「纯的数据进、数据出」（HubRequest → HubResponse），
 * 不接任何框架的 Context。接进来就得先有那个框架。
 * 副作用只集中在【一个】注入点（deps.recordDecision），测试用计数器替它，
 * 生产用真 recorder —— 见下面那条「404 不写审计」的断言为什么能成立。
 */

import { createHash, randomUUID } from "node:crypto";
import {
  approvalDecisionRequestSchema,
  approvalOutcome,
  createTaskRequestSchema,
  HTTP_CONFLICT,
  HTTP_NOT_FOUND,
  HTTP_NOT_IMPLEMENTED,
  HTTP_FORBIDDEN,
  HTTP_UNAUTHORIZED,
  HTTP_UNPROCESSABLE,
  isImplemented,
  type ApiEndpoint,
  type ApprovalDecisionRequest,
  type ResumeValue,
  type TaskView,
  taskViewSchema,
} from "@opc/contracts";
import type { DatabaseSync } from "node:sqlite";
import type { EventBus } from "../events/bus.js";
import { legalTransitionsFrom, type TaskState } from "../graph/status.js";
import { listApprovals as listApprovalsFrom } from "../approvals/query.js";
// IM 绑定的四条路由**不写在下面那个 switch 附近**，单独住 http/bindings.ts。
// 那不是为了分文件整洁：test/bindings/im.test.ts 有一条守卫扫 src，
// 断言 `im_bindings` 这四个字只出现在 bindings/im.ts 一个文件里。
// 若把这四个 handler 写在 app.ts，要么我在那里手搓 SQL（绕过那一整列被测试穷尽的预检），
// 要么天天跟那条守卫打架。分开之后，「HTTP 层不碰那张表」是一句机器守着的话。
import {
  listBindingsRoute,
  rebindBindingRoute,
  requestBindingRoute,
  verifyBindingRoute,
} from "./bindings.js";
import { ResumeStream, type SnapshotSource } from "./sse.js";
import { buildReplayView } from "../replay/query.js";
import { verifyRequest, type VerifyInput } from "./auth.js";
import { isLoopbackAddress } from "./bind.js";
// 【type-only import】。这一条边界值得说：tokenHttpStatus 的实现【不在】tokens.ts 而在下面，
// 于是 app.ts 只从那边拿一个类型，运行期仍然不 import tokens.ts
// （那边带 node:crypto 与 db/write-queue）。contract.test.ts 手搓 deps 时能构造出
// 一个假 reason 而不是被迫把整个 token 存储拖进测试。
import type { TokenIssueReject, TokenRejectReason } from "./tokens.js";
// 【又一个 type-only import】，动机与上面 tokens.ts 那一条【不一样】，值得分开说：
// 那边是「实现在本文件，所以只要类型」；这边是「实现真在 db/write-queue.js，
// 但 app.ts 只把它当【注入点的形状】，一次运行期调用都不发」——
// 真正的 node() 调用全在 http/bindings.ts 里。
// 所以这条 import 在产物里是 0 字节，而 contract.test.ts 手搓 deps 时
// 仍然不必把整个写队列拖进测试（不传 bindingWriter ⇒ 三条写路由 501，那正是测的分支）。
import type { Writer } from "../db/write-queue.js";

export interface HubRequest {
  readonly method: string;
  /**
   * 路径，不含 query（? 之前的部分）。给路由用。
   * 【不做 percent 解码】—— 这句是陈述现状，不是设计优点：
   * 现在 path 段里的 id 全部由服务端生成（randomUUID），
   * 但「不编码就等价于编码」这件事【本仓没有任何测试覆盖】，别当成已验证性质。
   * 哪天路径里要塞用户可控的 id（比如按 slug 取任务），这里必须补解码，
   * 而且要补在【路由侧】而不是鉴权侧 —— 鉴权签的是原始 target，解码后签名必错。
   */
  readonly path: string;
  /**
   * 原始请求目标：路径 + 原样的 query，未解码、未排序。给【鉴权】用。
   *
   * 为什么不能拿 path 去签名（这一条是真 socket 上撞出来的，见 auth.ts 的 canonicalString）：
   * 客户端手上只有自己准备发出的那串字节，服务端手上是剥过 query 又解码过的路径，
   * 两者对 `/events?cursor=17` 永远算不出同一个串 ⇒ 带 query 的请求恒 401
   * ⇒ 断线重连整条路是死的。而 contract 层的单测看不见：那里 path 与签名的 path
   * 是同一个人写的同一个值。
   * 所以【鉴权看 target，路由看 path】，两份各归各的，不做「统一成一个」。
   */
  readonly target: string;
  readonly query: Readonly<Record<string, string | undefined>>;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
  /**
   * 对端地址（`req.socket.remoteAddress`）。**必填**，而且刻意不给默认值。
   *
   * 为什么要有这一维：桌面端那套 HMAC 凭据是【本机密钥】，它出不了这台机器。
   * 一旦 Hub 绑了非回环地址，同一网段里任何人都能【拿到那个签名的形状】——
   * 不，他们连密钥都拿不到，所以签不出来；但反过来的问题更要紧：
   * **鉴权层必须能区分「这台机器上的进程」与「别的机器」**，
   * 因为一次性审批 token（Task 4.1，http/tokens.ts）只对后者生效，
   * 而它带来的限制（【规格】§11.4 不可逆一律拒批）不该落到桌面端头上。
   *
   * 为什么【必填】而不是 `peer?` + 「缺省当回环」：那正是我在 bind.ts 文件头批评过的形状
   * —— 把安全性质交给默认值维持。`peer?` 的失效方式是：下一个写调用方的人忘了传，
   * TS 不响，而症状是【远程请求被当成本机请求】，也就是那套限制静默消失。
   * 必填让「这条请求来自哪」成为每个构造点都必须回答的问题。
   * 传输层之外唯一合理的填法是回环常量（测试夹具就是这么填的）。
   */
  readonly peer: string;
}

export interface HubResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** SSE 用：帧流。存在时 body 被忽略。 */
  readonly stream?: AsyncIterable<unknown>;
  /**
   * SSE 用：连接没了【立刻】回收。传输层在 res 的 close/error 上调它。
   *
   * 为什么光有 stream 不够（真 socket 上验出来的）：frames() 的 finally 只在
   * 生成器自己执行时才会跑，而长连接上它一直睡在 await 上 —— 连接断了没人叫醒它，
   * 订阅就一直挂着，直到【下一条无关事件】把它冲走。CEO 盯着看板不动时可能几小时
   * 没有事件，于是每个关掉的标签页漏一条订阅。§5.8 要的是「断开即回收」。
   * 回收动作本身仍只有一份（ResumeStream.close，它再调 Subscription.close），
   * 这里只是把【发起权】交给唯一知道连接状态的那一层。
   */
  readonly onClose?: () => void;
}

export interface HubDeps {
  readonly db: DatabaseSync;
  readonly bus: EventBus;
  readonly token: string;
  readonly now: () => number;
  readonly nonces?: VerifyInput["nonces"];
  /**
   * 把一条 CEO 决策写进 approvals 与 events。【唯一的写路径】。
   * 返回 true = 该 approval 存在且此前是 pending（已就地落库）；
   * 返回 false = 不存在或已决策过（不落库）。
   * 之所以由外部注入而不是在这里直接写库：「404 不产生审计事件」这条不变量的
   * 可测形态就是「这个回调有没有被调用」。写库散在 handler 里时，那条断言只能
   * 去数 events 表的行数，而那在有其它事件在飞的真实总线上是噪声。
   */
  readonly recordDecision: (o: {
    readonly approvalId: string;
    readonly taskId: string;
    readonly resume: ResumeValue;
    readonly note?: string;
  }) => Promise<boolean>;
  /** 新任务落库 + 建第一个节点。同样是为了让 handler 本身可测。 */
  readonly createTask: (o: {
    readonly id: string;
    readonly title: string;
    readonly parentId?: string;
    readonly nowMs: number;
  }) => Promise<void>;
  /**
   * 决策落库【之后】让这一条图接着跑（计划 Task 2.6 第一条 Test：
   * 「批准后 Hub 图恢复执行」，规格 §5.8 结尾那句「CEO 在手机上批准战略提案时，
   * Hub 恢复该图的执行并广播 TaskStateChanged」）。
   *
   * 第三个注入点是【后来加的】，形状偏离记在 http/real-deps.ts 文件头。
   * 关键在【顺序】：决策与审计先提交，图后跑。反过来（先跑图再记审计）会留下
   * 「图前进了、审计里没有那次批准」—— 而 events 是事实源（§5.8），
   * 那种缺口在回放里表现为「任务动了但没人让它动」。
   *
   * 失败【不吞】，让它冒到 500：卡片确实已批准（库已提交），而图没动 ——
   * 「200 + 什么都不动」是本仓认定最贵的失效形状（同一判据见 sse.ts 的 cursor 那条）。
   * 代价写在 real-deps.ts 的 makeResumeGraph 注释里，含当前唯一的补救路径。
   */
  readonly resumeGraph: (taskId: string) => Promise<void>;
  /**
   * 一次性审批 token 的兑换点（Task 4.1，实现见 http/tokens.ts + real-deps.ts 那个包装）。
   *
   * 【为什么又是一个注入点而不是在这里直接查库】—— 与 recordDecision 同一条理由，
   * 而且这里还多一条更硬的理由：兑换要【写】（UPDATE im_tokens + 一条审计），
   * 而 deps.db 是【只读连接】（real-deps.ts 的 buildHubDeps 给的是 queue.readConnection()）。
   * 在这里直接 db.prepare(...).run() 会【绕开单写者队列】—— 那正是 0010 §2 实测过的
   * P1/P2 那族故障（同连接重入 ⇒ cannot start a transaction within a transaction，
   * 或者更糟：与超步事务互踩）。所以写必须走 Writer，而 Writer 在 app.ts 这一层不可见。
   *
   * ⚠ 最后那半句在 0031 之后【只对了运行时】：下面 bindingWriter 那一条让
   * app.ts 以【type-only】的方式看见 Writer（编译期有类型，运行期不 import
   * db/write-queue.js，与文件头 tokens.ts 那一条同一个手法与同一个理由）。
   * 原文留着，因为那句论证的【P1/P2 那一半】照旧成立，而且正是它决定了
   * bindingWriter 收队列而不是连接。
   *
   * 【可选】而不是必填，是因为它今天【还没有生产者】：签票的地方（图里升级那一刻）
   * 与建卡一样没有接线（0026 §1 那格同一件事）。必填会逼装配方传一个假实现，
   * 那比缺一个真实现更糟 —— 见 0026 §9 撤掉 isPendingStatus 时记的那个形状。
   * 缺它时的行为写在 remoteDecision() 里：明确拒绝，而不是退回 HMAC。
   *
   * ⚠ reason 的类型是【TokenRejectReason 而不是 string】，这一格比看着像的更要紧。
   * 原来是 string，那时下面 remoteTokenAuth 里的 401/403 判定只能写成一次字符串比较，
   * 而【新加一条 reason 的人不会被告知要去登记状态码】—— 那正是 tokenHttpStatus
   * 文件头写的那个错。收窄成联合之后，reason 从 tokens.ts 到 real-deps 的包装到这里
   * 全程同源，编译器能说出「这里收到的只可能是这六种」。
   * 代价：装配方（含测试里手搓的假 dep）必须用那个联合，不能再随手回一个自造字符串 ——
   * 而那个「随手回一个自造字符串」恰恰是这一格想拦的动作。
   */
  readonly redeemApprovalToken?: (o: {
    readonly token: string;
    readonly approvalId: string;
  }) => Promise<
    { readonly ok: true; readonly taskId: string } | { readonly ok: false; readonly reason: TokenRejectReason }
  >;
  /**
   * 签一张一次性审批 token（Task 4.1 的另一半：兑换的【对面】）。
   *
   * 与 redeem 同为可选、同走 Writer（签发也写库），理由不再重抄。
   * 真正的区别只有一条，而它决定了这条注入点存在与否：
   * 【签发只允许回环对端调用】。见 app.ts 的 mintToken handler 里那道 gate ——
   * 那边写清了为什么「远程端自己签自己的票」会把一次性 token 这套东西整体作废。
   *
   * 缺它时 mintToken 回 501 而【不是】404 也不是 500：
   * 501 说的是「服务端还没接」，那正是事实（见下面那段「501 此刻没有活的分母」——
   * 这一格是那句话【不再成立】的第一例，原文按口径留着）。
   */
  readonly issueApprovalToken?: (o: {
    readonly approvalId: string;
    readonly nowMs: number;
  }) => Promise<
    | { readonly ok: true; readonly token: string; readonly expiresAt: number }
    | { readonly ok: false; readonly reason: TokenIssueReject }
  >;
  /**
   * IM 身份绑定的**写路径**（0031，http/bindings.ts）。
   *
   * 收的是 WriteQueue 的 `node` 那一格而不是连接：绑定是【写】，
   * 而 deps.db 是只读连接（real-deps.ts 的装配注释）。在 handler 里
   * 直接拿 db 写会绕开单写者队列 —— 0010 §2 那发 P1 实测过的形状。
   *
   * 可选，缺省时三条写路由回 501。这个「可选」与 issueApprovalToken 同源：
   * 契约先行，装配后补，而 501 让「没接」是一句【说得清修法】的话
   * （接上 buildHubDeps 就行），不是一句「路由不存在」。
   */
  readonly bindingWriter?: Writer;
  /**
   * 「谁有权校验一个 IM 身份」在**这台 Hub 上**的名字（0031）。
   *
   * ⚠ 它是【署名来源】，不是【鉴权】。这一点必须写准，因为两处都叫得出
   * 「校验人」这三个字而含义不同：
   *  · 鉴权（这发请求能不能进来）由 HMAC + 回环门决定，与这个值无关；
   *  · 这个值只决定【写进 verified_by 那一格的是谁】—— 出了事库里问得到人。
   * 0030 §9 登记的那格「谁有权校验」到现在仍然没有答案，本字段是它的
   * 【一半】：它让那次校验有主语，而主语是启动命令里一个看得见的参数，
   * 不是「谁签得出动就谁说了算」。真正的授权模型（多管理员？轮换？）
   * 仍然在那一格。
   *
   * 为什么【不给默认值】：默认一个名字（'ceo' 是最顺手的那个）会让
   * verified_by 变成一句永远填得上而与事实无关的话，
   * 而 0030 §4 那条 DDL 判据存在的全部理由就是「那次校验要有真署名」。
   * 缺它 ⇒ verify 路由 501，症状指向唯一正确的修法（启动时带 --ceo）。
   */
  readonly bindingVerifier?: string;
}

const MAX_TITLE_CHARS = 200;

/** 把一条想法折成任务标题：取首行、截断。见 titleOf 的注释。 */
export function titleOf(idea: string): string {
  const firstLine = idea.trim().split("\n")[0] as string;
  if (firstLine.length <= MAX_TITLE_CHARS) return firstLine;
  // 截断【必须留下痕迹】。悄悄截断的话，看板上的标题看着就是完整的，
  // 而 CEO 会以为那条想法只有前 200 个字符 —— 他据以点头的是一个他不曾拥有的东西。
  return firstLine.slice(0, MAX_TITLE_CHARS - 1) + "…";
}

/**
 * 路由分发。
 *
 * 内部异常统一翻成 500 —— 但【只有这里】catch，且报错原文往上带。
 * 不 catch 的后果是让异常逃到 node:http，客户端看到「连接被重置」而不是一个能读的错误；
 * 而 catch 得太粗（只回一句「内部错误」）会把上面 taskViewSafe 那条
 * 「契约与库不一致，必须当场响」的意图吃掉 —— 所以 500 的 body 里带原文，
 * 本机回环上没有信息泄漏可言，而这台机器上坐着的就是唯一要修它的人。
 */
export async function handleRequest(
  deps: HubDeps,
  req: HubRequest,
): Promise<HubResponse> {
  try {
    return await route(deps, req);
  } catch (e) {
    return json(500, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

async function route(
  deps: HubDeps,
  req: HubRequest,
): Promise<HubResponse> {
  const method = req.method.toUpperCase();

  // 【鉴权在路由之前】。这一版最初是先匹路由、匹不上先回 404，理由写的是
  // 「404 不暴露信息、先答它最省」。那个理由是错的，两处都错：
  //  ① 省的是错那一侧的成本。扫端点的人【签不出名】，他在 missing_header 那一步
  //    就零成本被弹掉了，根本走不到 HMAC；付 HMAC 的只有「签名正确但路径写错」
  //    的合法调用方，而那本来就是他自己的请求。
  //  ② 而先匹路由【确实】泄漏：未授权者拿 401 / 404 / 501 三种答复就能枚举出
  //    「哪些路径存在、其中哪些已实现」。501 尤其漏 —— 它等于把
  //    UNIMPLEMENTED_ENDPOINTS 念给他听（本机的端点清单本来就在 contracts 里公开，
  //    所以危害有限，但没必要主动多说一遍）。
  // 现在未授权者无论问什么，看到的都只有一种形状。
  //
  // ⚠ 但【Task 4.1 之后这一句要重读】：形状仍然只有一种（401 unauthorized，
  // 连 reason 都不带），而**判据分成了两条**。分岔点在 peer 上：
  //   · 回环对端 ⇒ 还是那一发 HMAC（桌面端拿得到密钥，它是【本机进程】）。
  //   · 非回环对端 ⇒ HMAC【结构上不可能通过】（密钥不落盘、只在内存里，
  //     auth.ts 文件头），所以走【一次性 token】。而它【只覆盖一条路由】：
  //     POST /approvals/:id。别的端点在远程一律 401 —— 不是「没做」，是
  //     【规格】§20.3 只授权了「审批」这一件事出本机，读回放/看板没有那条授权。
  // 这条分岔的**方向**要说清楚：它是【收紧】不是放宽 —— 改动之前非回环对端
  // 根本连不上（只绑回环），所以不存在「原来能用现在不能用」。
  // 两条凭据按【对端在哪】分派，不按先后试。
  // ⚠ 「先 token 后 HMAC」这个顺序是刻意的，反过来（HMAC 失败再试 token）读起来
  //   更像「多重尝试」，而它的失效方向是错的 —— 一旦 HMAC 因为时钟偏移
  //   （MAX_CLOCK_SKEW_MS）偶然通过，一个远程请求就拿到了【本机】那套
  //   【不受 §11.4 不可逆限制】的权限。凭据不是候选列表，是两条互斥的路。
  const gate = isLoopbackAddress(req.peer)
    ? null
    : await remoteTokenAuth(deps, method, req.path, req);
  // 三种取值各走各的：
  //  · HubResponse ⇒ token 拒了，原样回那个响应（401 或 403）。
  //  · TOKEN_PASS  ⇒ token 有效，【跳过 HMAC】直接进路由。
  //                  不能再跑 HMAC：远程签不出名（密钥不落盘），跑了必然 401，
  //                  而此刻票已经烧掉了 —— 症状会是「票没了、决策也没做」。
  //  · null        ⇒ 这条请求不由 token 管辖（回环对端，或远程但没带票），走 HMAC。
  if (gate !== null && gate !== TOKEN_PASS) return gate;
  if (gate === null) {
    const auth = verifyRequest({
      token: deps.token,
      method,
      // 【target 不是 path】：鉴权签原始请求目标，路由才用剥过 query 的 path。
      // 见 HubRequest.target 的注释 —— 换成 req.path 编译器不会响，
      // 响的是「所有带 query 的请求 401」。
      target: req.target,
      body: req.body,
      headers: req.headers,
      now: deps.now(),
      ...(deps.nonces === undefined ? {} : { nonces: deps.nonces }),
    });
    if (auth.ok !== true) {
      // 报错【不区分】是缺头、时间戳过期还是签名不对，只回一句 "unauthorized"。
      // 区分它们等于给攻击者一台免费的「你差哪一步」预言机；
      // 而真用户在本地拿不到签名材料 ⇒ 一次就错，不需要看细节。
      return json(HTTP_UNAUTHORIZED, { error: "unauthorized" });
    }
  }
  return dispatch(deps, method, req);
}

/**
 * 鉴权【之后】的分发。桌面端与远程端在各自通过自己的凭据之后都走进这里，
 * 走的是同一个函数、同一组 handler —— 这条「一条写路径」的性质就是
 * 计划 Task 4.1 那条「不得有第二条更弱的通道」的落地形态。
 *
 * 把它从 route() 里拆出来【不是】为了整洁：如果远程那一支自己复制一份 switch，
 * 下次给某个 handler 加一条判据（比如 decide 里那个 approvalOutcome 判别式）时，
 * 只有桌面端那一半会被改到，而两份 switch 的 diff 看起来【都还是合法的】。
 * 拆成"只有一个 dispatch"之后，那种漂移在结构上写不出来。
 */
async function dispatch(
  deps: HubDeps,
  method: string,
  req: HubRequest,
): Promise<HubResponse> {
  const routeHit = matchRoute(method, req.path);
  if (routeHit === null) return json(HTTP_NOT_FOUND, { error: "no such route" });
  // 501 这一支【此刻没有活的分母】：UNIMPLEMENTED_ENDPOINTS 在 Task 3.4 之后是空的
  // （GET /replay/:taskId 是它唯一一项，现已落地）。
  // 分支【保留】而不是删掉，两个理由：
  //  ① 它是「契约先行」这条做法的落地端 —— 契约里有、服务端还没做，靠它回一个
  //     与 404 可区分的答复。删掉之后再加契约先行的端点，会得到一个 404，
  //     而 404 把调用方支去检查自己的参数（这条口径见 contracts/api.ts 的状态码注释）。
  //  ② 判据本身被 isImplemented501() 抽出来单独测了（contract.test.ts 那条
  //     「状态码口径」）。一个【永不被触发的分支 + 一条恒真的判据】才是真绿，
  //     而「恒真的判据」正是本仓反复抓的那类东西（0007 §4.1）。
  if (!isImplemented(routeHit.endpoint)) {
    return json(HTTP_NOT_IMPLEMENTED, {
      error: notImplementedMessage(routeHit.endpoint),
    });
  }

  switch (routeHit.kind) {
    case "create_task":
      return createTask(deps, req);
    case "list_tasks":
      return listTasks(deps);
    case "get_task":
      return getTask(deps, routeHit.id);
    case "list_approvals":
      return listApprovals(deps, req);
    case "decide":
      return decide(deps, routeHit.id, req.body);
    case "mint_token":
      return mintToken(deps, routeHit.id, req);
    case "events":
      return events(deps, req);
    case "replay":
      return replay(deps, routeHit.id, req.query);
    case "list_bindings":
      return listBindingsRoute(deps, req);
    case "request_binding":
      return requestBindingRoute(deps, req);
    case "verify_binding":
      return verifyBindingRoute(deps, req);
    case "rebind_binding":
      return rebindBindingRoute(deps, req);
    default: {
      // 走到这里意味着【有人加了一种 Route 却没在这里加分支】。
      //
      // ★ 这一段本轮被 tsc 逼着重写过，因为原来那版是【反向】的穷尽守卫。
      //   原文写的是 `const where: string = routeHit.kind`，注释声称本行的作用是
      //   『让上面的 switch 保持穷尽』。实测正好相反：
      //    - Route 联合里【有一种没写 case】时，default 里的 routeHit 是那一型，
      //      .kind 合法 ⇒ 编译通过；
      //    - 全部 kind 都写了 case 之后（本轮给 replay 补上分支就触发了这一格），
      //      routeHit 收窄成 never ⇒ 读 .kind 报 TS2339。
      //   也就是说它【只在漏分支时不报错】—— 与它自己注释里写的那个用途完全相反，
      //   而它一直「正常编译」恰恰是因为 replay 一直没有分支。
      //   Task 3.4 把最后一个 kind 补上，它当场编译不过 —— 症状看着像「我把代码改坏了」，
      //   真相是守卫一直是反的。
      //
      // 正向写法是赋值给 never：漏分支 ⇒ 这一行编译不过；分支齐全 ⇒ 通过。
      // 运行期仍然抛，因为「编译期守卫」挡的是【加 kind 的人】，
      // 挡不了运行时从别处（未来某次重构）流进来的意外值。
      // 抛的形态与代价沿用原注释的判断：
      //  - 回 501：读起来像「还没实现」，而实现【就在同一个文件里】——
      //    前端会一直等效地等一个已经存在的东西，这条线索指向错误的方向；
      //  - return undefined：类型上不允许，而 TS 现在能报这一条恰恰因为分支写全了；
      //  - 抛：运行期一次带原文的 500，指向唯一的成因。
      const impossible: never = routeHit;
      throw new Error(
        "matchRoute 返回了一个 handleRequest 没有分支的 Route：" +
          JSON.stringify(impossible) +
          "。它能在类型上走到这里，说明 Route 加了一种 kind 而 switch 没跟上" +
          "（正常情况下上面的 never 赋值会在编译期就拦住）。" +
          "补分支，而不是把它从 IMPLEMENTED_ENDPOINTS 里删掉 —— 后者会把" +
          "「已经做好的东西」伪装成「还没做」。",
      );
    }
  }
}

export type Route =
  | { kind: "create_task"; endpoint: "POST /tasks"; id?: undefined }
  | { kind: "list_tasks"; endpoint: "GET /tasks"; id?: undefined }
  | { kind: "get_task"; endpoint: "GET /tasks/:id"; id: string }
  | { kind: "list_approvals"; endpoint: "GET /approvals"; id?: undefined }
  | { kind: "decide"; endpoint: "POST /approvals/:interruptId"; id: string }
  | {
      kind: "mint_token";
      endpoint: "POST /approvals/:interruptId/token";
      id: string;
    }
  | { kind: "events"; endpoint: "GET /events"; id?: undefined }
  | { kind: "replay"; endpoint: "GET /replay/:taskId"; id: string }
  /**
   * IM 身份绑定那四条（0031）。**四条都没有 id 段** —— 这个形状是刻意的，
   * 而它挡的是一发看着最自然的改动：把 verify 做成 `POST /bindings/:id/verify`。
   * 那需要 id 先进 URL，而 id 是【我们内部】的主键；im.ts 那三个写入口
   * 收的身份是 (platform, external_user_id) —— 也就是【平台侧那个人】。
   * 用 id 定行意味着调用方要先知道我们这边的主键，
   * 而那一步没有来源（GET /bindings 给得出，于是 list → id → verify 变成一条
   * 「先扫全表再点一行」的流程；用身份定行则天然是一步，
   * 且与那条 UNIQUE 索引同一组键）。这是选形状的理由，不是「以后不能改」。
   */
  | { kind: "list_bindings"; endpoint: "GET /bindings"; id?: undefined }
  | { kind: "request_binding"; endpoint: "POST /bindings"; id?: undefined }
  | { kind: "verify_binding"; endpoint: "POST /bindings/verify"; id?: undefined }
  | { kind: "rebind_binding"; endpoint: "POST /bindings/rebind"; id?: undefined };

/**
 * 手写匹配而不是引一个路由器：五条形，而引库又要装依赖（见文件头）。
 *
 * 三处细节，每处对应一种真实故障：
 *  - 【只剥掉前导斜杠产生的那一段，不剥中间的】。上一版在这里写了
 *    .filter(s => s !== "")，那会让 /tasks//abc 匹配成 id="abc" —— 于是
 *    「id 段必须非空」那条判断变成永远走不到的死代码，而它想防的恰恰是
 *    拿空串去查库、查不到、报 404「task not found」这种把 URL 写错伪装成
 *    资源不存在的误导。现在 /tasks/ 与 /tasks//abc 都判不匹配。
 *  - id 段【必须非空】（见上）。
 *  - 路径段【不做 decode】：approval id 是我们自己发的 UUID，不需要百分号解码；
 *    而一旦解码，"%2e%2e" 这类输入就会带着解码后的形状进入后续处理，
 *    多一处需要考虑注入的地方。不需要就别开这条路。
 *  - 【方法不匹配时不自动报 405】：那是「用错方法」与「路径不存在」的区分，
 *    值得做，但要先把每个路径的方法全集列出来（一处新清单 = 一处新漂移点），
 *    留给真接传输层时一起做，见文件头那条偏离说明。
 */
export function matchRoute(method: string, path: string): Route | null {
  const raw = path.split("/");
  // "/tasks" → ["", "tasks"]：只有第 0 段是斜杠产物，必须剥掉。
  const segs = raw[0] === "" ? raw.slice(1) : raw;
  const id = (seg: string | undefined): string | null =>
    seg === undefined || seg === "" ? null : seg;

  if (method === "POST" && segs.length === 1 && segs[0] === "tasks") {
    return { kind: "create_task", endpoint: "POST /tasks" };
  }
  if (method === "GET" && segs.length === 1 && segs[0] === "tasks") {
    return { kind: "list_tasks", endpoint: "GET /tasks" };
  }
  if (method === "GET" && segs.length === 2 && segs[0] === "tasks") {
    const t = id(segs[1]);
    if (t === null) return null;
    return { kind: "get_task", endpoint: "GET /tasks/:id", id: t };
  }
  if (method === "GET" && segs.length === 1 && segs[0] === "approvals") {
    return { kind: "list_approvals", endpoint: "GET /approvals" };
  }
  if (method === "POST" && segs.length === 2 && segs[0] === "approvals") {
    const a = id(segs[1]);
    if (a === null) return null;
    return { kind: "decide", endpoint: "POST /approvals/:interruptId", id: a };
  }
  // 【三段】那条：签票。放在两段那条【之后】，但顺序在这里【不承重】——
  // 两条靠 segs.length 就已经互斥（2 与 3），谁先谁后都得同一个答案。
  // 写在这句旁边只是为了让下一个读的人不必自己去数段数。
  if (
    method === "POST" &&
    segs.length === 3 &&
    segs[0] === "approvals" &&
    segs[2] === "token"
  ) {
    const a = id(segs[1]);
    if (a === null) return null;
    return { kind: "mint_token", endpoint: "POST /approvals/:interruptId/token", id: a };
  }
  if (method === "GET" && segs.length === 1 && segs[0] === "events") {
    return { kind: "events", endpoint: "GET /events" };
  }
  if (method === "GET" && segs.length === 2 && segs[0] === "replay") {
    const r = id(segs[1]);
    if (r === null) return null;
    return { kind: "replay", endpoint: "GET /replay/:taskId", id: r };
  }
  /*
   * 绑定那四条（0031）。三条动作共用【同一段前缀】，所以这里必须点名第二段的
   * 字面值（verify / rebind），而不是「bindings 后面的那一段当 id」。
   *
   * 差别在【没有 id 这一段】的时候才显出来：写成 `{ kind: "verify_binding", id: segs[1] }`
   * 的话，`POST /bindings/anything` 会匹配成功并把 anything 当 id 带下去，
   * 而 handler 那边根本不读它 ⇒ 拼错一个字母（`/bindings/verfy`）得到的是 404 之外的
   * 某个体面答复，指向错误方向。现在它是 null ⇒ 404「no such route」，那正是事实。
   * 同 approvals/:id/token 那条【靠字面段而不是靠位置】的写法。
   */
  if (method === "GET" && segs.length === 1 && segs[0] === "bindings") {
    return { kind: "list_bindings", endpoint: "GET /bindings" };
  }
  if (method === "POST" && segs.length === 1 && segs[0] === "bindings") {
    return { kind: "request_binding", endpoint: "POST /bindings" };
  }
  if (method === "POST" && segs.length === 2 && segs[0] === "bindings") {
    if (segs[1] === "verify") return { kind: "verify_binding", endpoint: "POST /bindings/verify" };
    if (segs[1] === "rebind") return { kind: "rebind_binding", endpoint: "POST /bindings/rebind" };
    return null;
  }
  return null;
}

/**
 * 远程对端（非回环）能不能靠【一次性 token】通过鉴权。
 *
 * ── 返回值只有三种，而且【不返回「放行整条请求」】 ──────────────────────
 * 这一发只回答「这次鉴权过没过」，它**不做决策、不写库**。
 * 为什么：计划给 Task 4.1 的 Test 里那条硬约束是
 *   「移动端的批准请求与桌面端走【同一套鉴权与审计路径】（不得有第二条更弱的通道）」
 * 如果这一发顺手把决策也做了（自己 UPDATE 一下 approvals 再 return 200），
 * approvals 的写路径就从两条变三条，而每条都是靠【条件 UPDATE + 同事务审计】维持幂等的 ——
 * 多一条就多一处「改了那条忘了这条」，而那类漂移的症状是回放里同一张卡批过两次。
 * 所以这里通过后，请求仍然走下面那个 switch 里的 decide()，与桌面端【同一个函数】。
 *
 * 三种返回：
 *  · null            —— 「这条请求不该由 token 管」：回环对端，或远程但没带 token 头。
 *                       调用方接着走 HMAC（远程没带 token 时它会 401，那是正确答案）。
 *  · {proceed:true}  —— token 有效，跳过 HMAC，继续正常路由。
 *  · {response:...}  —— 拒。已经把状态码定好了。
 *
 * ── 状态码为什么分成 401 与 403 两档 ──────────────────────────────────
 * 本文件的鉴权口径是「不区分失败原因，一律一句 unauthorized」，理由是别给攻击者
 * 一台「你差哪一步」的预言机。这条口径对【凭据错】完全成立，对【凭据对而事情不许做】
 * 不成立：irreversible_denied 不是一条关于凭据的信息，它是【产品决定】，
 * 而那个决定的正确报错是「这张卡请在桌面端点」（403 + 一句人话）。
 * 把两者混进 401 的后果是：CEO 在手机上点了半天「链接失效」，而真相是
 * 「这张卡按设计就不能在这儿批」—— 一个把人支去检查自己凭据的报错。
 * 所以：凭据那一族（unknown / expired / used / mismatch / not_pending）一律 401 不带原因；
 * 只有【策略拒绝】那一族带原因。
 *
 * ── 一张票只值 URL 上那一张卡 ─────────────────────────────────────────
 * expectedApprovalId 传的是路由解出来的那个 id。不传的话，
 * 「拿 A 的票去批 B」是可行的，而票的全部意义就是「一次、一张、一个决定」。
 */
const TOKEN_PASS = "token-pass" as const;

async function remoteTokenAuth(
  deps: HubDeps,
  method: string,
  path: string,
  req: HubRequest,
): Promise<HubResponse | typeof TOKEN_PASS | null> {
  // 只有 POST /approvals/:id 允许靠 token 通过。别的端点【没有远程授权】：
  // 【规格】§20.3 授权走出本机的只有「审批」这一件事，读看板/读回放不在其中，
  // 那些数据要从远程看是另一回事（§20 网络边界那一节没有给它们凭据模型）。
  //
  // 判据【复用 matchRoute】而不是在这里再写一遍路径拆分 —— 这一条不是洁癖：
  // 自己拆一遍就会出现「路由认为匹配而鉴权认为不匹配」的双份判据，
  // 那种分歧的方向永远是【鉴权漏放】或【鉴权误杀】之一，两者都是静默的。
  const hit = matchRoute(method, path);
  if (hit === null || hit.kind !== "decide") {
    const raw = headerValue(req.headers, HEADER_APPROVAL_TOKEN);
    if (raw === null) return null; // 没带票 ⇒ 交给 HMAC（远程必然 401，正确）
    // 带了票却打在别的端点上 ⇒ 拒。这一发【不能返回 null】——
    // 返回 null 的意思是「交给 HMAC」，而带票的远程请求必然签不出名，
    // 结论同样是 401，可那是一次【靠另一条路失败】的正确：
    // 哪天 HMAC 的判据放宽一格（比如加个「开发环境跳过签名」），
    // 这一支就会从「挡住」变成「放行」，而改 HMAC 的人不会想到这里有依赖。
    // ⚠ 「同样都是 401，所以怎么写都行」这句话是【错的】，而错的方式值得写下来：
    //   带【真签名】+ 票的远程请求，在「返回 null」的实现下会【200 放行】读到看板数据。
    //   现实里远程签不出名，所以那条歧路今天不可达 —— 但它是「今天不可达」，
    //   不是「结构上写不出来」，而本仓对这两者的区分是明确的（bind.ts 文件头同一条）。
    //   这一发被 tokens-route.test.ts 里那发「带真签名的票头打在 GET /tasks」钉住，
    //   那一发同时配了反向对照（去掉票头 ⇒ 200），所以它不是一条只会绿的装饰。
    return json(HTTP_UNAUTHORIZED, { error: "unauthorized" });
  }
  const token = headerValue(req.headers, HEADER_APPROVAL_TOKEN);
  if (token === null) return null; // 同上：没带票就走 HMAC
  if (deps.redeemApprovalToken === undefined) {
    // 装配方没接 token 存储 ⇒ 【拒绝】而不是退回 HMAC。
    // 退回 HMAC 是本函数最容易被「顺手加一下」的写法，而它等于宣布
    // 「远程请求可以用本机凭据」—— 那一发一旦存在，一次性 token 这一整套
    // 就只是多的一条可选路径，而不是【远程唯一的】路径。
    return json(HTTP_UNAUTHORIZED, { error: "unauthorized" });
  }
  const r = await deps.redeemApprovalToken({ token, approvalId: hit.id });
  if (r.ok === true) return TOKEN_PASS;
  return json(tokenHttpStatus(r.reason), tokenRejectBody(r.reason));
}

/**
 * `POST /approvals/:id/token` —— 给一张待批卡片签一张远程票。
 *
 * ── 这一发为什么【只认回环】，以及那道门为什么在【这里】而不在上面的 route() ──
 * 一个远程请求可以靠一张有效的兑换票通过 route() 的 token 门（TOKEN_PASS），
 * 然后走进 dispatch() 的 switch —— 那时它打到的【可以】是这一条路由。
 * 如果这里不再看一次 peer，结论就是【远程持票人能给自己再签一张票】。
 * 而那正是「一次性」这三个字的全部内容：一张票能换来一张票，
 * 就能换来无限张，TTL 也失去意义（每次快过期时自己续一张）。
 *
 * ⚠ 为什么这道门【不能】只写在 remoteTokenAuth 里（那里已经有一条
 *   「只有 kind === 'decide' 允许靠 token 通过」）：那一条今天【确实】挡住了这条路
 *   —— 一个远程请求带着票打到 mint_token 会拿到 401。所以我可以在这里只写注释。
 *   但那正是本仓反复在防的形状：一条安全判据的生效【依赖另一处代码今天长什么样】，
 *   而改那一处的人不会知道这里有依赖。具体说，哪天有人把 remoteTokenAuth 那条
 *   白名单从「只有 decide」放宽到「审批类路由」（读收件箱要做的时候这动作很自然），
 *   这一条路由就【静默地】对远程开放了签票，而改动者的测试大概还是绿的。
 *   两道门各自独立成立，才是「不依赖对方今天长什么样」。
 *
 * 501（没接签发实现）而【不是】404：404 说「这张卡不存在」，
 * 而这张卡在，只是服务端没接。这条口径与文件里那句 501 的口径同源，
 * 也确实是那句「此刻没有活的分母」被打破的第一例。
 *
 * ⚠ 【export 的唯一理由是测试，而这个理由值得写下来】：
 * 上面那段论证的是「这道门必须【独立于】remoteTokenAuth 那道门成立」。
 * 而只要走 handleRequest，一个远程持票请求就在【第一道】门被弹掉，
 * 于是「第二道门挡住了」这个结论【在端到端层面不可证】——
 * 端到端那一发会绿，而它测的是第一道门（tokens-route.test.ts 里那发没有假装测第二道）。
 * 要证明第二道门自己有肌肉，只能直接调这一发。导出一个内部 handler
 * 不是把边界打开（它不 import 任何写路径，也不改变任何鉴权判据），
 * 换来的是那条安全判据从「注释 + grep」升级成「一条真请求」。
 *
 * ⚠ 反过来那一维也量过了，结论与直觉相反：把上面那条白名单【放宽】成
 *   「decide 或 mint_token」，全仓【一条测试都不红】（实测记在 tokens-route.test.ts 文件头）。
 *   那不是测试没写够 —— 门二单独就够，行为完全正确；而「改门一必须有红」
 *   等于把两道门焊回一条判据，恰恰是本段论证反对的事。
 *   所以如果你正是那个放宽白名单的人：这里不会拦你，而【这一发会替你挡着后果】。
 */
export async function mintToken(
  deps: HubDeps,
  approvalId: string,
  req: HubRequest,
): Promise<HubResponse> {
  if (!isLoopbackAddress(req.peer)) {
    return json(HTTP_UNAUTHORIZED, { error: "unauthorized" });
  }
  if (deps.issueApprovalToken === undefined) {
    return json(HTTP_NOT_IMPLEMENTED, {
      error:
        "本装配未接一次性审批 token 的签发实现（http/tokens.ts 的 issueToken）。" +
        "501 而不是 404：卡片在，缺的是服务端。",
    });
  }
  const r = await deps.issueApprovalToken({ approvalId, nowMs: deps.now() });
  if (r.ok !== true) return json(tokenIssueStatus(r.reason), tokenIssueBody(r.reason));
  return json(201, { token: r.token, expires_at: r.expiresAt });
}

/**
 * 签票的拒绝理由 → 状态码。与 tokenHttpStatus【两张表】而不是一张，
 * 理由逐字写在 tokens.ts 的 TokenIssueReject 上面（分歧点是「报错给谁看」：
 * 这一侧的调用方是本机一个已鉴权的人，他【有】approvalId，也有那张卡）。
 * 同样是 switch + never 的正向穷尽守卫：加一格就必须来这里登记一次。
 */
export function tokenIssueStatus(reason: TokenIssueReject): number {
  switch (reason) {
    case "approval_missing":
      // 404：这里【可以】用 404，而 redeem 那一侧刻意不用 ——
      // 这里的调用方手上有真实的 id，「id 写错了」是他能执行的修法。
      return HTTP_NOT_FOUND;
    case "approval_not_pending":
      // 409：见 contracts 那个常量的注释。「你点晚了」不是「你参数错了」。
      return HTTP_CONFLICT;
    case "irreversible_denied":
      // 403：与 redeem 那一侧同一个理由，也【同样带一句人话】——
      // 这一条不是关于凭据的信息，§11.4 是公开的产品规则。
      return HTTP_FORBIDDEN;
    default: {
      const impossible: never = reason;
      throw new Error(
        "tokenIssueStatus 收到一个没有登记状态码的 reason：" +
          JSON.stringify(impossible) +
          "。加 TokenIssueReject 的成员时必须来这里登记一格。",
      );
    }
  }
}

function tokenIssueBody(reason: TokenIssueReject): Record<string, unknown> {
  if (reason === "irreversible_denied") {
    return {
      error:
        "这张卡片是不可逆操作，按【规格】§11.4 不允许签发远程票；请在桌面端批准。",
      reason,
    };
  }
  if (reason === "approval_not_pending") {
    return {
      error: "这张卡片已经不是待批状态（已被批准或已超时），签票没有对象。",
      reason,
    };
  }
  return { error: "approval not found", reason };
}

/**
 * 一次性 token 的拒绝理由 → HTTP 状态码。
 *
 * ── 为什么是一张 switch 而不是一句 `reason === "irreversible_denied" ? 403 : 401` ──
 * 三元短得多，而它挡不住【新加一条 reason 的人】：那种人读到的是 tokens.ts 里
 * 一个多出来的联合成员，编译器不响，于是新那一格默认落进 401。
 * 401 对新加的【凭据类】理由是碰巧对的，对新加的【策略类】理由（rate_limited、
 * 某个新加的门控）是【错得最有说服力的那种】—— 它让用户去检查自己的凭据。
 * 下面那个 `const impossible: never` 让漏登记变成编译错误，
 * 手法与本文件 Route 那个 switch 完全相同（那里的教训记在 default 分支上：
 * 守卫必须写成【正向】的，写成 `x.kind` 读法会得到一个只在漏分支时不报错的反向守卫）。
 *
 * ── 为什么这个函数在 app.ts 而不在 tokens.ts ────────────────────────
 * 判据（一次/一张/过期/不可逆）在 tokens.ts，而【状态码是 HTTP 层的事】：
 * 挪过去会让 tokens.ts 依赖 contracts 的那几个状态码常量，
 * 而它今天只依赖 APPROVAL_STATUS_PENDING 一条；更要紧的是 app.ts 会因此
 * 在【运行期】import tokens.ts（带 node:crypto 与写队列），
 * 而 contract 层那些手搓 deps 的测试就拖不动了。所以这里只 import 一个 type。
 *
 * ── 401 与 403 的分界，与本文件那口径的关系 ─────────────────────────
 * 本文件的鉴权口径是「不区分失败原因，一律一句 unauthorized」，
 * 理由是别给攻击者一台「你差哪一步」的预言机。那条口径对【凭据错】成立，
 * 对【凭据对而这件事不许做】不成立：irreversible_denied 不是关于凭据的信息，
 * 它是【产品决定】，而那个决定的正确报错是「这张卡请在桌面端点」。
 * 所以凭据那一族（unknown / expired / used / mismatch / not_pending）
 * 一律 401 且【不带 reason】；只有策略那一族带。
 * 分错方向的代价不对称，说清楚：把策略报成 401 是【把人使错方向】，
 * 而把凭据报成 403 + 原文是【多告诉攻击者一格信息】。
 * 下面每一支都逐条写明方向，不给「默认」。
 */
export function tokenHttpStatus(reason: TokenRejectReason): number {
  switch (reason) {
    case "irreversible_denied":
      // 403：凭据没问题，是【规格】§11.4 不许在这条通道上做这件事。
      return HTTP_FORBIDDEN;
    case "unknown_token":
    case "expired":
    case "already_used":
    case "approval_mismatch":
    case "approval_not_pending":
      // 401：五者都是【凭据这一侧】的状态。
      // approval_not_pending 值得单独说一句：它讲的是【卡片】而不是票，
      // 看上去像 404 或者 409。留在这里的理由是【报错给谁看】：
      // 远程端此刻只知道「我手上这张票没换成一次批准」，
      // 而 404「卡片不存在」会把人支去检查卡片 id（他没有那个信息，也没有那张卡），
      // 409 要求他理解「pending」这个服务端状态。401 + 一句「链接失效」是唯一
      // 每条通道都能正确执行的修法：重签一张，或者回桌面端。
      return HTTP_UNAUTHORIZED;
    default: {
      // 正向穷尽守卫（见上面那段：反向写法只在漏分支时不报错）。
      const impossible: never = reason;
      throw new Error(
        "tokenHttpStatus 收到一个没有登记状态码的 reason：" +
          JSON.stringify(impossible) +
          "。加 TokenRejectReason 的成员时必须来这里登记一格，" +
          "并写明它属于【凭据】(401) 还是【策略】(403) —— 默认落 401 会把策略类拒绝" +
          "伪装成凭据问题，让 CEO 去重签一张本来有效的票。",
      );
    }
  }
}

/**
 * 拒绝时回什么。**逐条决定说不说人话**，而不是一律一句 unauthorized。
 *
 * 分界是【这句话会不会多告诉攻击者一格信息】：
 *  - 凭据族：一句 "unauthorized"，连 reason 都不带。知道「过期」与「用过」的差别
 *    对攻击者有用（他能据此判断自己猜中的票被哪一挡弹掉）。
 *  - 策略族：带一句人话 + reason。这条信息【本来就不是秘密】—— §11.4 是产品规则，
 *    写在卡片类型里，攻击者不需要这张报错也能知道哪些卡不许远程批。
 *    而它对一个真用户的价值极大：省掉一次「在手机上反复点一张设计上不能点的卡」。
 */
function tokenRejectBody(reason: TokenRejectReason): Record<string, unknown> {
  if (reason === "irreversible_denied") {
    return {
      error:
        "这张卡片标记为不可逆操作，按【规格】§11.4 不能在远程批准，请在桌面端处理。",
      reason,
    };
  }
  return { error: "unauthorized" };
}

/**
 * 取一个头。与 auth.ts 里那个同名的小函数【刻意各有一份】而不是抽公共：
 * auth.ts 那份的签名吃的是 VerifyInput（它还带着 token/method/target 那些材料），
 * 这里只要一个 Record。为了省五行 while 把鉴权材料的类型拖进这一层，
 * 会得到一个「谁都能构造」的公共参数对象 —— 那才是这条路上真正的漂移点。
 */
function headerValue(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string | null {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== lower) continue;
    if (v === undefined || v.trim() === "") return null;
    return v;
  }
  return null;
}

/**
 * 一次性审批 token 的请求头名。
 *
 * 走【头】而不是 query 是刻意的，理由与 auth.ts 的 target 那一格同族但更强：
 * URL 会进访问日志、进代理日志、进浏览器历史，而这张票的价值是
 * 「它能批准一次花钱的动作」。头不进任何标准日志。
 */
export const HEADER_APPROVAL_TOKEN = "x-opc-approval-token";

async function createTask(
  deps: HubDeps,
  req: HubRequest,
): Promise<HubResponse> {
  const parsed = createTaskRequestSchema.safeParse(parseJson(req.body));
  if (!parsed.success) {
    return json(HTTP_UNPROCESSABLE, {
      error: "idea 非法",
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  const id = randomUUID();
  const o = parsed.data;
  await deps.createTask({
    id,
    title: titleOf(o.idea),
    ...(o.parent_id === undefined ? {} : { parentId: o.parent_id }),
    nowMs: deps.now(),
  });
  return json(201, { id, title: titleOf(o.idea) });
}

/** 列出的行数为【什么】不设上限：单用户本机，任务总量在几百量级。 */
function listTasks(deps: HubDeps): HubResponse {
  return json(200, { tasks: readTasks(deps, "ORDER BY created_at DESC", []) });
}

/**
 * `GET /approvals` —— 收件箱那个计数的**唯一对账源**。
 *
 * 读侧整条走 approvals/query.ts（那里写了为什么单独成模块、为什么默认只列 pending、
 * 为什么排序不能让 NULL 靠方言运气）。这里只做三件 HTTP 的事：
 * query 解析、把 `pendingTotal` 带出去、以及【不吞解析失败】的边界。
 *
 * ⚠ 这个端点**不返回**卡片参数全文，也不返回证据链接。收件箱是「扫一眼、按一次键」
 * 的地方，而 §9.2 那三行里第一行（summary）与「还有多久过期」够它做决定；
 * 要看参数与证据得进单张卡片的视图 —— 那个视图今天还没有，
 * 而**它不该被塞进列表接口当作副产品**（一旦列表里有全文，
 * 就永远有人直接渲染它，§19.4 那条「卡片三行、不画框线」的排版口径从此守不住）。
 */
function listApprovals(deps: HubDeps, req: HubRequest): HubResponse {
  const status = req.query["status"];
  const limitRaw = req.query["limit"];
  if (limitRaw !== undefined && !/^-?\d+$/u.test(limitRaw)) {
    return json(HTTP_UNPROCESSABLE, {
      error: "limit 必须是整数，实到 " + limitRaw,
    });
  }
  const result = listApprovalsFrom(deps.db, {
    ...(status === undefined ? {} : { status }),
    ...(limitRaw === undefined ? {} : { limit: Number(limitRaw) }),
  });
  // asOfMs 带着：调用方要算「这张卡等了多久」「离过期还有多久」，
  // 而拿客户端时钟算这两件事 = 一台时钟不准的机器会让卡片显示「已过期 3 小时」
  // 而服务端根本还没到那个点。时刻一律以服务端为准（同一个理由见 SSE 快照里的 asOfMs）。
  return json(200, { ...result, asOfMs: deps.now() });
}

function getTask(deps: HubDeps, id: string): HubResponse {
  const first = readTasks(deps, "WHERE id = ?", [id])[0];
  if (first === undefined) {
    return json(HTTP_NOT_FOUND, { error: "task not found", id });
  }
  return json(200, first);
}

/**
 * 对外可见的列。具名列而不是 SELECT *：表里【本来就躺着】state_snapshot 与
 * graph_checkpoint_id 这类内部字段，用 * 的话以后加一列就【自动】把它变成对外契约，
 * 而那时没人 review 过它。具名列 + taskViewSchema 的 .strict() 等于
 * 「加列必须同时改这两处」—— 一次会被 review 的改动，而不是一次静默的泄漏。
 *
 * （这一版最初写成 sql.replace("SELECT *", "SELECT …")，那是更糟的做法：
 * 它把「用的是 *」这件事从代码里擦掉，读的人以为写的是具名列，而调用点还写着 *。
 * 意图正确、手法是自我安慰，记在这里免得再来一次。）
 */
const TASK_COLUMNS =
  "id, title, status, assigned_role, current_node, parent_id, " +
  "budget_cents, consumed_cents, created_at, updated_at";

function readTasks(
  deps: HubDeps,
  whereOrOrder: string,
  params: readonly unknown[],
): TaskView[] {
  const rows = deps.db
    .prepare("SELECT " + TASK_COLUMNS + " FROM tasks " + whereOrOrder)
    .all(...(params as never[])) as Record<string, unknown>[];
  const out: TaskView[] = [];
  for (const r of rows) {
    out.push(
      toTaskView({
        id: String(r["id"]),
        title: String(r["title"]),
        status: String(r["status"]),
        assigned_role: String(r["assigned_role"]),
        current_node: String(r["current_node"]),
        parent_id: (r["parent_id"] as string | null) ?? null,
        budget_cents: (r["budget_cents"] as number | null) ?? null,
        consumed_cents: Number(r["consumed_cents"] ?? 0),
        created_at: Number(r["created_at"]),
        updated_at: Number(r["updated_at"]),
      }),
    );
  }
  return out;
}

async function decide(
  deps: HubDeps,
  approvalId: string,
  body: string,
): Promise<HubResponse> {
  const parsed = approvalDecisionRequestSchema.safeParse(parseJson(body));
  if (!parsed.success) {
    return json(HTTP_UNPROCESSABLE, {
      error: "决策体非法",
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  const request = parsed.data as ApprovalDecisionRequest;
  const row = deps.db
    .prepare("SELECT task_id, status FROM approvals WHERE id = ?")
    .get(approvalId) as { task_id: string | null; status: string } | undefined;

  const outcome = approvalOutcome({
    exists: row !== undefined,
    alreadyDecided: row !== undefined && row.status !== "pending",
    taskId: row?.task_id ?? "",
    approvalId,
    request,
  });

  if (outcome.status !== 200) {
    return json(outcome.status, { error: outcome.reason });
  }

  // 写路径只有 deps.recordDecision 这一条，而它在【两个分支】里都不会被调用：
  //  ① 404（上面已 return）；② 已决策过（下面 if 里 return）。
  // 这两支在【类型上】都没有 audit 字段（approvalOutcome 的判别式），所以下面那次
  // 取 outcome.audit 能过 tsc，恰恰证明「这条路径是首次决策」——
  // 「404 / 重放不产生审计事件」不是靠我记得不调用，而是那两条路径上
  // 根本没有可用的审计输入。这是结构约束，不是口头纪律。
  // （这一版最初写成无条件调用 recordDecision，注释却写着幂等 ——
  // 每次重放多一条 append-only 的决策事件，回放里同一张卡片批过两次。
  // 记在这里，因为「注释承诺了实现没有的性质」是本仓反复出现的失效形状。）
  // 重放走 200 而不是 4xx：调用方要的答案是「我的点击生效了吗」，答案是生效了。
  if (outcome.replayed) {
    return json(200, { ok: true, replayed: true });
  }
  const applied = await deps.recordDecision({
    approvalId,
    taskId: outcome.audit.taskId,
    resume: request.resume,
    ...(request.note === undefined ? {} : { note: request.note }),
  });
  if (applied) {
    // 只有【本次真的写成了】才去恢复图。并发那一次（applied === false）不恢复：
    // 抢到的那一次已经在恢复了，这一次再调一次就是同一条图跑两遍，
    // 而节点里的模型调用不按次数计费的话，重复一次 = 白烧一份预算。
    //
    // 这一句在写 real-deps.ts 之前【不存在】，而它上面那段注释（「生产用真 recorder」）
    // 早就在了 —— 也就是说计划 Task 2.6 第一条 Test「批准后 Hub 图恢复执行」
    // 在整个 Phase 2 里没有任何代码承载它，也没有任何测试红过。
    // 这里刻意【不 catch】：恢复失败要让这次请求变成 500 + 原文，
    // 而不是 200 + 任务一步不动（见 HubDeps.resumeGraph 的注释）。
    await deps.resumeGraph(outcome.audit.taskId);
  }
  return json(200, {
    ok: true,
    // 走到这里 outcome.replayed 必为 false（我那次 SELECT 说它是 pending）。
    // recordDecision 再答一次「写没写成」，用它的答案而不是我的推断：
    // 两次读之间可以有一次并发写入（同一张卡片在两个窗口各点一次），
    // 那时【事实】是「没写成」，而我手上那个推断是【过时】的。
    replayed: !applied,
  });
}

async function events(deps: HubDeps, req: HubRequest): Promise<HubResponse> {
  const cursorRaw = req.query["cursor"];
  if (cursorRaw !== undefined && !/^\d+$/u.test(cursorRaw)) {
    return json(HTTP_UNPROCESSABLE, {
      error: "cursor 必须是非负整数（= events.id），实到 " + cursorRaw,
    });
  }
  // 快照源：tasks 的当前全量。§5.8 的「事件是投影不是事实源」就落在这一次读取上。
  const snapshot: SnapshotSource<{ tasks: TaskView[]; asOfMs: number }> = {
    name: "tasks",
    read: async () => ({
      tasks: readTasks(deps, "ORDER BY created_at DESC", []),
      asOfMs: deps.now(),
    }),
  };
  // 两条路【刻意分开】，而不是一个带默认参数的函数（见 sse.ts 里 resume 的注释）：
  //  ① 没带游标（首次连接）⇒ begin：先取游标再读快照，客户端无权提供游标。
  //  ② 带了游标（断线重连 / Last-Event-ID）⇒ resume(fromSeq)：必须从它续，
  //     这里若图省事复用 begin，会改成从 latestSeq 续订 —— 客户端明说「我缺
  //     58..90」，我们回它 91 之后的。计划 Task 2.1 的 Test 项
  //     「断线重连后按游标续订不丢事件」测的就是这一条，而它的失效形态是
  //     「连接正常、也在推流、就是少了几条」—— 最难查的那类。
  const stream =
    cursorRaw === undefined
      ? await ResumeStream.begin(deps.bus, snapshot)
      : await ResumeStream.resume(deps.bus, snapshot, Number(cursorRaw));
  return {
    status: 200,
    body: null,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      // 反向代理（将来 Task 4.1 会碰到）默认会缓冲响应，SSE 被缓冲就等于死了：
      // 连接在、事件不来、也不报错。这一行是给它看的。
      "x-accel-buffering": "no",
      // 告诉客户端「从这里续」。它下一次重连就该带这个值，而不是自己记一个
      // 从别处（比如某帧的 body 里）读来的数字。
      "last-event-id": String(stream.cursor),
    },
    stream: stream.frames(),
    onClose: () => stream.close(),
  };
}

/**
 * 501 的报错文案。单独抽出来【不是为了复用】，是为了让它能被测：
 * 此刻 UNIMPLEMENTED_ENDPOINTS 为空 ⇒ 上面那个 501 分支没有活的分母，
 * 于是「未实现端点回 501 而不是 404」这条口径在 route() 里【无法】被用例触发。
 * 抽出来之后判据本身仍然可测（contract.test.ts 直接喂一个未实现端点），
 * 而不是变成一条「代码写着、而没有任何输入能走到」的死逻辑。
 */
export function notImplementedMessage(endpoint: ApiEndpoint): string {
  return (
    endpoint +
    " 尚未实现。501 而不是 404：404 会让调用方去检查自己的参数，" +
    "而真相是服务端还没做。"
  );
}

/**
 * GET /replay/:taskId —— 回放时间线（计划 Task 3.4，规格 §22.2）。
 *
 * 三条口径：
 *  ① 读走 deps.db，而那是 queue.readConnection()（real-deps.ts:457）。
 *     于是【搜索与回放不排队】：一次超过 busy_timeout（5000ms，见 pragmas.ts:19）
 *     的模型调用期间，CEO 打开回放页照旧能看。若哪天有人把它改成写连接，
 *     0010 §7 那个「图在跑时批准必失败」的症状会复制到回放上，
 *     而那属等 CEO 拍板的锁问题，本不该外溢到只读路径。
 *  ② 任务不存在 ⇒ 404。与 GET /tasks/:id 同一个口径。
 *  ③ 坏行不 500。这是 app.ts 里 toTaskView 那段注释【点名给 Task 3.4】的方案
 *     （『真要做容错，正确形态是给那一行加 degraded 标记 + 照常返回原始值』），
 *     所以这里不套 toTaskView 那种「契约与库不一致就抛」的处理 ——
 *     回放的用途是【理解发生了什么】，一段少了两条的时间线仍有用，
 *     而一个 500 让 CEO 对那个任务完全失明。少的那部分由 degraded + complete=false 说出去。
 */
/** 回放关键词上限。URL 整体受 MAX_BODY 之外的服务器行长限制，这里再收一道：
 * 关键词会进 LIKE 的全表扫（兜底那一档），一条十万字的关键词是一次没人会等的扫描。 */
export const MAX_REPLAY_KEYWORD_CHARS = 200;

function replay(
  deps: HubDeps,
  taskId: string,
  query: HubRequest["query"],
): HubResponse {
  for (const key of ["limit", "offset"]) {
    const raw = query[key];
    if (raw !== undefined && !/^\d+$/u.test(raw)) {
      return json(HTTP_UNPROCESSABLE, {
        error: key + " 必须是非负整数，实到 " + raw,
      });
    }
  }
  /*
   * ?keyword= 空串 ⇒ 【不过滤】，而不是「搜空串」。
   * 这两个语义在界面上必须分开：地址栏里 `?keyword=` 是「我清掉了搜索框」，
   * 用户期待看到完整时间线；如果这时候回一条空时间线，读起来是
   * 「这个任务什么都没发生过」。searchEvents 内部也是同一口径（空关键词返回空集），
   * 所以这一层必须【根本不下发】keyword，否则两者会叠成「空时间线」。
   */
  const rawKeyword = query["keyword"];
  if (rawKeyword !== undefined && [...rawKeyword].length > MAX_REPLAY_KEYWORD_CHARS) {
    return json(HTTP_UNPROCESSABLE, {
      error:
        "keyword 最长 " +
        MAX_REPLAY_KEYWORD_CHARS +
        " 个字符，实到 " +
        [...rawKeyword].length +
        " 个。关键词建议 ≥3 个汉字（trigram 的分词窗口，规格附录 C.3）。",
    });
  }
  const view = buildReplayView(deps.db, {
    taskId,
    ...(rawKeyword === undefined || rawKeyword === ""
      ? {}
      : { keyword: rawKeyword }),
    ...(query["limit"] === undefined ? {} : { limit: Number(query["limit"]) }),
    ...(query["offset"] === undefined
      ? {}
      : { offset: Number(query["offset"]) }),
  });
  if (view === null) {
    return json(HTTP_NOT_FOUND, { error: "task not found", id: taskId });
  }
  return json(200, view);
}

function json(status: number, body: unknown): HubResponse {
  return { status, body };
}

function parseJson(text: string): unknown {
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // 返回一个必定过不了 strict 校验的形状，让上层统一报 422 并列出 issues。
    // 在这里直接抛会让「JSON 写错」和「服务内部错误」混成 500，
    // 而前者是调用方能自己修的。
    return { __unparseable__: createHash("sha256").update(text).digest("hex").slice(0, 8) };
  }
}

/** 校验对外视图；不过则【抛】而不是丢行。 */
function toTaskView(v: TaskView): TaskView {
  // 库里读出来的行过不了对外 schema，说明【库与契约不一致】（比如有人手工写了一行
  // status 为空串的任务，或某次迁移漏了一列）。两种处理都考虑过：
  //  - 静默跳过：列表少一条而总数不变，CEO 以为任务被删了；
  //  - 抛：整条 GET 变 500，一个坏行让【整个看板】不可用。
  // 选【抛】。理由是这条路径几乎只可能来自代码或迁移的缺陷，它需要被立刻看见；
  // 「看板少了任务 #37、刷新又好了」正是本仓最难查的那类失效，而 500 的报错里
  // 会直接带上是哪一行、哪个字段（handleRequest 把 message 原样带出）。
  // 真要做容错，正确形态是给那一行加 degraded 标记 + 照常返回原始值，
  // 那是 Task 3.4 回放视图的事，不是现在顺手塞在这里。
  const r = taskViewSchema.safeParse(v);
  if (!r.success) {
    throw new Error(
      "库里读出的任务行不符合对外契约（id=" +
        v.id +
        "）：" +
        r.error.issues.map((x) => x.path.join(".") + " " + x.message).join("; ") +
        "。契约与库不一致时必须当场响，静默丢行会让「任务不见了」变成一次无从排查的报障。",
    );
  }
  // schema 只管到 status 是【非空字符串】—— 这是刻意的：contracts 不能 import hub
  // （§5.6.1 的边界，test/arch 有守卫），所以它手上没有那 15 个状态名。
  // 于是【状态名的对账只能发生在这里】，也就是唯一同时看得见两边的那一层。
  // 少了这一行的话，一行 status = "IN_PROGRES"（少一个 S）的脏数据会被
  // 【原样发到前端】，前端按状态名分支渲染，认不出来就整块不画 ——
  // 症状是「看板上这个任务不见了」，而 API 返回 200、日志干净。
  assertKnownStatus(v.status);
  return v;
}

/**
 * 状态名的对外闸门（Task 3.1 三层校验里第一层的对外形态）。
 *
 * 【不自己维护状态清单】—— 这一版最初在这里手抄了 15 个状态名，抄完就多了两处
 * 会漂移的地方：union 改了这里没改，后果是「对外接受一个状态名，写库时被
 * assertTaskTransition 拒」，一次跨越 API 层与状态机层的报错，最难查。
 * 现在唯一判据是 legalTransitionsFrom：它对未知状态抛错（用 Object.hasOwn，
 * 所以 "constructor" 这类原型键也过不了），对已知状态一定返回数组。
 */
export function assertKnownStatus(s: string): TaskState {
  try {
    legalTransitionsFrom(s as TaskState);
  } catch (e) {
    throw new Error(
      "非法的任务状态名 [" +
        s +
        "]，未被状态机接受。" +
        (e instanceof Error ? e.message : String(e)),
    );
  }
  return s as TaskState;
}
