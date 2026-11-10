/**
 * Hub 对外的 HTTP / SSE 契约（计划 Task 2.1，规格 §5.8 / §20.3）。
 *
 * 为什么契约放 contracts 而不是 hub：这些形状同时被渲染进程、Web、移动端读。
 * 放 hub 侧的话，前端要么自己手抄一份（两份必然漂移，0006 §7 第 55、56 条记的就是
 * 这个形状），要么 import hub —— 而 hub 带 SQLite 与 node:sqlite，
 * 渲染进程 import 它就是 §5.6.1 那条边界被破（Task 0.2 已有守卫拦着）。
 *
 * 本模块【只有形状与纯判定】：不 import http、不读库、不读时钟。
 * 「一条请求该怎么回应」这件事在这里是可穷尽测试的纯函数（approvalOutcome），
 * 传输层只是把它的返回值翻成状态码 —— 那样薄的一层才允许自己不写测试。
 *
 * 【一处计划引用需要更正】计划把鉴权口径写成「规格 §20.3」，实测 §20.3 的标题是
 * 「IM 层」，正文讲的是飞书卡片回调的签名验证与一次性 token，
 * 没有一个字提到「token 由 Hub 启动时打印一次、渲染进程经 IPC 获取」。
 * 那两句是【计划自己新增的实现约定】，不是规格的引用。本篇按计划的约定实现，
 * 但把出处的事实写清楚，免得下一个人去 §20.3 找那句话找不到，
 * 或者更糟 —— 以为 §20.3 授权了他把 token 落库（§20.3 讲的是 IM 侧的 im_tokens 表，
 * 与本机的桌面 token 是两码事，见 http/auth.ts）。
 */
import { z } from "zod";

/**
 * 端点清单。写成常量而不是散落在路由注册里，理由与 gates.ts 里 APPROVAL_BUTTONS
 * 同一条：让「多一个端点」成为一次可 review 的显式改动，而不是某个人在 app.ts
 * 里顺手 app.get(...) 加的一行。preload 的 IPC 白名单（Task 2.2）与这份清单
 * 必须能对上，对不上就是「渲染进程能调到一个前端契约里没有的端点」。
 */
export const API_ENDPOINTS = [
  "POST /tasks",
  "GET /tasks",
  "GET /tasks/:id",
  "POST /approvals/:interruptId",
  "GET /events",
  "GET /replay/:taskId",
] as const;
export type ApiEndpoint = (typeof API_ENDPOINTS)[number];

/**
 * 已经落地的端点。刻意与 API_ENDPOINTS 分开：
 * 契约【先行】是本仓一贯的做法（岗位书、证据包都是先定形状再长实现），
 * 但没有一条测试允许把「契约里有」读成「能用」。所以两个集合都在，
 * 未落地的那份被 hasEndpoint 判 false，app.ts 对它的处理是 501 而不是 404 ——
 * 404 会让前端以为「这个任务不存在」，而真相是「服务端还没实现」。
 * 这两种「没有」对调用方的修法完全不同：一个是改参数，一个是等服务端。
 */
export const IMPLEMENTED_ENDPOINTS: readonly ApiEndpoint[] = [
  "POST /tasks",
  "GET /tasks",
  "GET /tasks/:id",
  "POST /approvals/:interruptId",
  "GET /events",
];

/** Phase 3（Task 3.4 回放时间线）填充，本期返回 501。 */
export const UNIMPLEMENTED_ENDPOINTS: readonly ApiEndpoint[] = [
  "GET /replay/:taskId",
];

export function isImplemented(e: ApiEndpoint): boolean {
  return IMPLEMENTED_ENDPOINTS.includes(e);
}

/* ────────────────────────── 请求体 ────────────────────────── */

/**
 * POST /tasks —— 「扔一个想法」。
 *
 * idea 的上限不是随手拍的：这个字符串会进 tasks.title（截断后）与审计 payload，
 * 而审计是 append-only。收一条 10MB 的想法等于让 CEO 的一次手滑永久撑大库，
 * 并且每一次回放都要把它整条读出来。上限取 4000 字符，量级上够写一段完整需求，
 * 又远小于任何会成为问题的体积。trim 后判空 —— 全空白的想法应当被拒，
 * 而不是建出一条标题为空的条目（那种条目在收件箱里没法辨认）。
 */
export const MAX_IDEA_CHARS = 4000;
export const createTaskRequestSchema = z
  .object({
    idea: z.string().trim().min(1).max(MAX_IDEA_CHARS),
    /** 可选的父任务；缺省即顶层任务。 */
    parent_id: z.string().min(1).optional(),
  })
  .strict();
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;

/**
 * POST /approvals/:interruptId —— CEO 对一张审批卡片做决定。
 *
 * resume 的取值刻意【不含】"approve_all" 或任何批量语义：§8.2 第 4 条讲门控
 * 「不可绕过」，而「一键全批」正是最自然的绕过方式。计划里 §9.2 的三按钮由
 * gates.ts 的 APPROVAL_BUTTONS 钉住数量，这里与之同向而不是各写一份。
 *
 * 字段名用 resume 而不是 decision：计划写的是「body 含 resume 值」，
 * 而 LangGraph 侧的概念也叫 resume（Command({resume})）。两侧同名，
 * 少一层改名翻译 —— 每加一层改名就少一处能 grep 的落点。
 */
export const RESUME_VALUES = [
  "approve",
  "reject_with_comment",
  "defer_deep_review",
] as const;
export type ResumeValue = (typeof RESUME_VALUES)[number];

export const approvalDecisionRequestSchema = z
  .object({
    resume: z.enum(RESUME_VALUES),
    /**
     * reject_with_comment 时【必填】。这不是格式洁癖：一条没有理由的打回
     * 到了产出方那里就是「被拒了，为什么不知道」，而 §8.3 要的正是
     * 「CEO 看到的每件都是真正需要 CEO 的事」的反面 —— 产出方看到的每件
     * 也得是可执行的。判据放在 schema 的 refine 里而不是让调用方各判一遍。
     */
    note: z.string().trim().min(1).max(4000).optional(),
    /** 幂等凭据：同一次点击重发两次不该产生两条决策（见 approvalOutcome）。 */
    idempotency_key: z.string().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (
      data.resume === "reject_with_comment" &&
      (data.note === undefined || data.note.length === 0)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "resume=reject_with_comment 必须带非空 note。空理由的打回到了产出方那里不可执行" +
          "（§8.3：升级与打回都要给出可决策的理由）。",
      });
    }
  });
export type ApprovalDecisionRequest = z.infer<typeof approvalDecisionRequestSchema>;

/* ────────────────────────── 响应形状 ────────────────────────── */

/**
 * 任务条目的对外视图。刻意【不是】tasks 表的整行直译，两处不同是有意的：
 *  ① 不带 state_snapshot / graph_checkpoint_id。前者是内部图状态（含节点中间量），
 *     后者是 checkpoint 的坐标。把它们发到渲染进程等于把内部实现细节变成
 *     对外契约的一部分 —— 以后想换 Saver 就是破坏性变更。
 *  ② 金额一律美分整数（§6.1）。对外给浮点美元就是把浮点误差发到 UI 上，
 *     而「还剩多少预算」正是会被拿来做颜色判断的字段。
 * 字段名保持 snake_case：证据包一侧已定下「不做改名层，库里那行 JSON 与读回来的
 * 逐字一致」的口径（evidence.ts），对外视图沿用同一口径而不是两套并存。
 */
export const taskViewSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    status: z.string().min(1),
    assigned_role: z.string().min(1),
    current_node: z.string().min(1),
    parent_id: z.string().nullable(),
    budget_cents: z.number().int().nullable(),
    consumed_cents: z.number().int().nonnegative(),
    created_at: z.number().int(),
    updated_at: z.number().int(),
  })
  .strict();
export type TaskView = z.infer<typeof taskViewSchema>;

/** GET /events 的一帧。seq 就是 events.id，也是断线重连的游标（§5.8）。 */
export const feedItemSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    kind: z.string().min(1),
    taskId: z.string().min(1),
    degraded: z.literal(true).optional(),
  })
  .passthrough();
export type FeedItemView = z.infer<typeof feedItemSchema>;

/* ────────────────────────── 状态码口径 ────────────────────────── */

/**
 * 「没有」分三种，必须可区分 —— 三者的修法完全不同：
 *  401 没带凭据（改调用方）  404 资源不存在（改参数）  501 服务端没实现（等实现）
 * 把它们混成一个 404 是本类契约最容易犯也最难查的错：前端看到 404 会去检查自己的
 * 参数，而真相可能是路由没注册。
 */
export const HTTP_UNAUTHORIZED = 401;
export const HTTP_NOT_FOUND = 404;
export const HTTP_NOT_IMPLEMENTED = 501;
export const HTTP_UNPROCESSABLE = 422;

/**
 * 审批决策的判定 —— 【纯函数】，这是本文件存在的主要理由。
 *
 * 要守的不变量是计划 Test 项最后那条：POST /approvals/:id 对不存在的 id 返回 404
 * 且【不产生审计事件】。为什么这条值得单独抽一个函数出来讲：
 * events 表是 append-only（§20.4，0001 上一对 RAISE ABORT 触发器），
 * 一条为不存在的审批写下的决策事件【永远删不掉】，回放视图会照着它重建出一个
 * 从未发生过的审批。而「先记审计、再去查 id 在不在」是极其顺手的写法 ——
 * 因为它在正常路径上完全正确，只在异常路径上留一条永久的脏行。
 *
 * 所以把判定做成纯函数：审计载荷【只出现在「首次决策」那一支的返回值里】。
 * 不存在与已决策这两支在类型上就拿不到事件，写审计这件事没有可用的输入。
 * 传输层无论怎么写都不可能在这两种情况下写出事件 —— 这才是结构约束，
 * 而不是「记得先查再写」的口头纪律。
 *
 * 判别式只有 404 与 200，【没有 401】：这个函数看不到请求头，
 * 鉴权发生在传输层（http/auth.ts）。上一版这里挂着一条 401 分支，
 * 而它【不可能被返回】—— 一条永不发生的分支会逼调用方为它写处理代码，
 * 那段代码又永远没有测试覆盖它。别加回来。
 */
export type ApprovalOutcome =
  | {
      status: typeof HTTP_NOT_FOUND;
      /** 刻意【没有】审计字段：这一支拿不出可写的东西，见上面那段。 */
      reason: string;
    }
  | {
      status: 200;
      /** 首次决策：这里有审计载荷，也【只有】这里有。 */
      replayed: false;
      audit: {
        readonly action: "review_decision" | "approval";
        readonly taskId: string;
        readonly approvalId: string;
        readonly resume: ResumeValue;
        readonly note?: string;
      };
    }
  | {
      status: 200;
      /**
       * 已决策过 ⇒ 幂等重放：不再写第二条事件，也不报错。
       *
       * 【replayed: true 这一支同样刻意没有 audit】。理由与 404 那支一字不差：
       * events 是 append-only，为同一张卡片写第二条决策事件删不掉，
       * 回放视图会重建出「这个审批批过两次」。
       * 上一版这里返回的是 { replayed: true, audit }，把「别写第二条」留给调用方自觉 ——
       * 而调用方（app.ts）第一版就真的忘了，注释里还写着「幂等」。
       * 现在按 replayed 做判别式收窄：想读 audit 就得先证明这不是重放，
       * TS 不允许跳过。这才是结构约束而不是口头纪律（§8.2 第 4 条同一条思路）。
       */
      replayed: true;
    };

export function approvalOutcome(o: {
  /** 该 interruptId 在 approvals 里是否存在。由调用方查库后告知，本函数不查库。 */
  readonly exists: boolean;
  /** 已经决策过（status != 'pending'）。exists 为 false 时无意义。 */
  readonly alreadyDecided?: boolean;
  readonly taskId: string;
  readonly approvalId: string;
  readonly request: ApprovalDecisionRequest;
}): ApprovalOutcome {
  if (!o.exists) {
    return {
      status: HTTP_NOT_FOUND,
      reason:
        "审批 [" +
        o.approvalId +
        "] 不存在。不写审计：events 是 append-only，" +
        "为不存在的审批记一条决策会留下一条永远无法修正的假历史，" +
        "回放照它重建出一个从未发生过的审批。",
    };
  }
  if (o.alreadyDecided === true) {
    // 幂等重放走 200 而不是 409：调用方是渲染进程，它要的是「我的点击生效了吗」，
    // 而答案是生效了（第一次就生效）。回 4xx 会让它显示一次失败，
    // 而用户看到的是一条其实已经批准的审批被标红 —— 那是比重复点击更坏的困惑。
    return { status: 200, replayed: true };
  }
  return { status: 200, replayed: false, audit: auditOf(o) };
}

function auditOf(o: {
  taskId: string;
  approvalId: string;
  request: ApprovalDecisionRequest;
}): Extract<ApprovalOutcome, { replayed: false }>["audit"] {
  const base = {
    action: "approval" as const,
    taskId: o.taskId,
    approvalId: o.approvalId,
    resume: o.request.resume,
  };
  // exactOptionalPropertyTypes：note 缺席时【不带这个键】，而不是带一个 undefined。
  // 一个值为 undefined 的键会进 JSON 与审计，读起来像「他写了空备注」而不是「没备注」。
  return o.request.note === undefined
    ? base
    : { ...base, note: o.request.note };
}

/* ────────────────────────── SSE 帧格式 ────────────────────────── */

/**
 * SSE 帧的编码（text/event-stream 的线格式）。放 contracts 而不是 hub：
 * 服务端按它写、前端按它解析，两份实现共用一份编码器就不会漂移。
 *
 * 三处容易写错、各自对应一种真实故障：
 *  ① 每帧必须以【空行】结尾（两个 \n）。少一个，客户端不会 dispatch，
 *     事件会静静堆在缓冲区里 —— 表现是「前端偶尔少一条，刷新就好」。
 *  ② id: 那一行是断线重连的游标。浏览器 EventSource 会自动带 Last-Event-ID 重连，
 *     但我们的重连是自管的（要插 snapshot，见 Task 2.3），所以仍然写 id：
 *     它是「这条事件的 events.id」唯一在线上的载体，丢了就没法续订。
 *  ③ data 里出现 \n 必须拆成多行 data:。整段 JSON 单行序列化是安全的（JSON.stringify
 *     不会输出裸换行），但【degraded 提示语】这类人写的文案会 —— 一旦 data 里混进
 *     裸换行，后半截会被当成一个新字段解析掉，事件静默截断。
 */
export interface SseFrame {
  readonly event: string;
  readonly id?: string;
  readonly data: string;
  readonly retryMs?: number;
}

export function encodeSseFrame(f: SseFrame): string {
  let out = "";
  if (f.retryMs !== undefined) {
    if (!Number.isInteger(f.retryMs) || f.retryMs < 0) {
      throw new Error(
        "retry 必须是非负整数毫秒（实到 " + String(f.retryMs) + "）。",
      );
    }
    out += "retry: " + f.retryMs + "\n";
  }
  out += "event: " + oneLine(f.event) + "\n";
  if (f.id !== undefined) out += "id: " + oneLine(f.id) + "\n";
  // 多行 data：按 \n 拆开，每段各带一个 data: 前缀。客户端会把它们用 \n 拼回去。
  const lines = f.data.split("\n");
  for (const l of lines) out += "data: " + l + "\n";
  return out + "\n";
}

/** 字段值里的换行与 \r 会破坏线格式（也允许 CR，见 SSE 规范对行终止的定义）。 */
function oneLine(s: string): string {
  const out = s.replace(/[\r\n]+/g, " ");
  if (out.trim() === "") {
    throw new Error("SSE 字段值不得为空或全空白（会让该行被服务器吃掉）。");
  }
  return out;
}

/**
 * 解析一帧。刻意写成与 encodeSseFrame 对偶的一份【共享】实现：
 * 前端自己写一个解析器的话，编码器一改就悄悄不兼容，
 * 而症状是「某些事件收不到」—— 最难查的那类。
 */
export function decodeSseFrame(raw: string): SseFrame {
  let event = "message";
  let id: string | undefined;
  let retryMs: number | undefined;
  const dataParts: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line === "" || line.startsWith(":")) continue; // 空行 = 帧结束；冒号 = 注释
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    // 规范：冒号后紧跟的一个空格属于值，要剥掉（"data: x" 的值是 "x" 不是 " x"）。
    let value = i < 0 ? "" : line.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "id") id = value;
    else if (field === "data") dataParts.push(value);
    else if (field === "retry") retryMs = Number(value);
    // 未知字段【静默忽略】，这是 SSE 规范要求的向前兼容；在这里报错会让
    // 服务端每加一个新字段就打断所有旧客户端。
  }
  const frame: SseFrame = {
    event,
    data: dataParts.join("\n"),
    ...(id === undefined ? {} : { id }),
    ...(retryMs === undefined ? {} : { retryMs }),
  };
  return frame;
}
