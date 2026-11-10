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
  HTTP_NOT_FOUND,
  HTTP_NOT_IMPLEMENTED,
  HTTP_UNAUTHORIZED,
  HTTP_UNPROCESSABLE,
  isImplemented,
  type ApprovalDecisionRequest,
  type ResumeValue,
  type TaskView,
  taskViewSchema,
} from "@opc/contracts";
import type { DatabaseSync } from "node:sqlite";
import type { EventBus } from "../events/bus.js";
import { legalTransitionsFrom, type TaskState } from "../graph/status.js";
import { ResumeStream, type SnapshotSource } from "./sse.js";
import { verifyRequest, type VerifyInput } from "./auth.js";

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

  const routeHit = matchRoute(method, req.path);
  if (routeHit === null) return json(HTTP_NOT_FOUND, { error: "no such route" });
  if (!isImplemented(routeHit.endpoint)) {
    return json(HTTP_NOT_IMPLEMENTED, {
      error:
        routeHit.endpoint +
        " 尚未实现（计划 Task 3.4 回放时间线）。501 而不是 404：" +
        "404 会让调用方去检查自己的参数，而真相是服务端还没做。",
    });
  }

  switch (routeHit.kind) {
    case "create_task":
      return createTask(deps, req);
    case "list_tasks":
      return listTasks(deps);
    case "get_task":
      return getTask(deps, routeHit.id);
    case "decide":
      return decide(deps, routeHit.id, req.body);
    case "events":
      return events(deps, req);
    default: {
      // 走到这里意味着【有人把某个端点加进了 IMPLEMENTED_ENDPOINTS，却没在这里加分支】
      // （目前只有 replay 会到这里，而它上面已被 isImplemented 拦掉）。
      // 三选一里选了【抛】：
      //  - 回 501：读起来像「还没实现」，而实现【就在同一个文件里、就在下一个 case】——
      //    前端会一直等效地等一个已经存在的东西，这条线索会指向错误的方向；
      //  - return undefined：类型上不允许（返回类型不含 undefined），
      //    而 TS 现在能报这一条恰恰是因为我把分支写全了；
      //  - 抛：一次编译期无警告、运行期一次带原文的 500，指向唯一的成因。
      // 这一行的真正作用是【让上面的 switch 保持穷尽】：写了 default，
      // 就等于给「加端点忘了加分支」留了一个会响的地方。
      const where: string = routeHit.kind;
      throw new Error(
        "端点 [" +
          routeHit.endpoint +
          "] 已登记为已实现（IMPLEMENTED_ENDPOINTS），但 handleRequest 里" +
          "没有 kind=" +
          where +
          " 的分支。补分支，而不是把它从清单里删掉 —— 后者会把「已经做好的东西」" +
          "伪装成「还没做」。",
      );
    }
  }
}

export type Route =
  | { kind: "create_task"; endpoint: "POST /tasks"; id?: undefined }
  | { kind: "list_tasks"; endpoint: "GET /tasks"; id?: undefined }
  | { kind: "get_task"; endpoint: "GET /tasks/:id"; id: string }
  | { kind: "decide"; endpoint: "POST /approvals/:interruptId"; id: string }
  | { kind: "events"; endpoint: "GET /events"; id?: undefined }
  | { kind: "replay"; endpoint: "GET /replay/:taskId"; id: string };

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
  if (method === "POST" && segs.length === 2 && segs[0] === "approvals") {
    const a = id(segs[1]);
    if (a === null) return null;
    return { kind: "decide", endpoint: "POST /approvals/:interruptId", id: a };
  }
  if (method === "GET" && segs.length === 1 && segs[0] === "events") {
    return { kind: "events", endpoint: "GET /events" };
  }
  if (method === "GET" && segs.length === 2 && segs[0] === "replay") {
    const r = id(segs[1]);
    if (r === null) return null;
    return { kind: "replay", endpoint: "GET /replay/:taskId", id: r };
  }
  return null;
}

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
