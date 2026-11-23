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
import { charterSchema } from "./charter.js";
import { orgChangeSchema, orgGraphSchema } from "./org/graph.js";

/**
 * 端点清单。写成常量而不是散落在路由注册里，理由与 gates.ts 里 APPROVAL_BUTTONS
 * 同一条：让「多一个端点」成为一次可 review 的显式改动，而不是某个人在 app.ts
 * 里顺手 app.get(...) 加的一行。preload 的 IPC 白名单（Task 2.2）与这份清单
 * 必须能对上，对不上就是「渲染进程能调到一个前端契约里没有的端点」。
 *
 * ⚠ 下面四条 `/bindings*` 是 0031 加的。加进这张表**只**意味着「app.ts 有对应分支」
 * （就是上一段那句话），而它们另外还各有这张表**装不下**的性质，别在这里读丢：
 *  · 四条全部【只开回环】—— 比 HMAC 更严（判据与理由在 http/bindings.ts 的
 *    assertLoopbackBindingRoute，那里也写了为什么【读】那一条也只开回环）；
 *  · `POST /bindings/verify` 除回环之外还要一个【署名来源】（启动参数 `--ceo`），
 *    没配 ⇒ 那条路由 501。校验一个身份而不交出「谁验的」，
 *    正是 0030 §4 那条 DDL 判据拦了一整轮的东西，不能在 HTTP 层放回来。
 * 这两条都不在端点清单这一层表达，所以清单本身**读不出**这一族的安全形状 ——
 * 那句话写在这里，是因为读端点清单的人不会去读 handler。
 */
export const API_ENDPOINTS = [
  "POST /tasks",
  "GET /tasks",
  "GET /tasks/:id",
  "GET /today",
  "GET /approvals",
  "GET /approvals/:interruptId",
  "POST /approvals/:interruptId",
  "POST /approvals/batch",
  "POST /approvals/:interruptId/token",
  "GET /events",
  "GET /replay/:taskId",
  "GET /bindings",
  "POST /bindings",
  "POST /bindings/verify",
  "POST /bindings/rebind",
  "POST /org",
  "GET /org",
  "GET /charter/:roleId",
  "POST /charter/:roleId",
  "GET /budget",
  "POST /budget",
] as const;
export type ApiEndpoint = (typeof API_ENDPOINTS)[number];

/**
 * 已经落地的端点。刻意与 API_ENDPOINTS 分开：
 * 契约【先行】是本仓一贯的做法（岗位书、证据包都是先定形状再长实现），
 * 但没有一条测试允许把「契约里有」读成「能用」。所以两个集合都在，
 * 未落地的那份被 hasEndpoint 判 false，app.ts 对它的处理是 501 而不是 404 ——
 * 404 会让前端以为「这个任务不存在」，而真相是「服务端还没实现」。
 * 这两种「没有」对调用方的修法完全不同：一个是改参数，一个是等服务端。
 *
 * ⚠ 「在这里登记」的含义是【app.ts 里有对应的 handler 分支】，仅此而已。
 * 它【不】意味着「渲染进程能调到它」—— 那是 desktop/ipc-surface.ts 的 EXPOSED_ENDPOINTS
 * 那一格管的事，两份清单的分工见那边。今天这一条上有一个实例：
 * POST /approvals/:interruptId/token 落在地而【没有】IPC 通道，
 * 因为它是【回环专用】的（远程端是它的对立面，不是它的调用方）。
 */
export const IMPLEMENTED_ENDPOINTS: readonly ApiEndpoint[] = [
  "POST /tasks",
  "GET /tasks",
  "GET /tasks/:id",
  "GET /today",
  "GET /approvals",
  "GET /approvals/:interruptId",
  "POST /approvals/:interruptId",
  "POST /approvals/batch",
  "POST /approvals/:interruptId/token",
  "GET /events",
  "GET /replay/:taskId",
  "GET /bindings",
  "POST /bindings",
  "POST /bindings/verify",
  "POST /bindings/rebind",
  "POST /org",
  "GET /org",
  "GET /charter/:roleId",
  "POST /charter/:roleId",
  "GET /budget",
  "POST /budget",
];

/**
 * 还没有实现的端点。本期为空。
 *
 * 这一格【保留而不是删掉】：`isImplemented` 靠它把「契约里有」与「能用」分开，
 * 而 app.ts 对未实现端点回 501 而不是 404（404 会让调用方去检查自己的参数，
 * 真相却是服务端还没做 —— 两种「没有」的修法完全不同）。
 * 哪天再加契约先行的端点，位置就是这里。
 */
export const UNIMPLEMENTED_ENDPOINTS: readonly ApiEndpoint[] = [];

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
export type ApprovalDecisionRequest = z.infer<
  typeof approvalDecisionRequestSchema
>;

/**
 * POST /approvals/batch —— 【规格】§9.4 的批量批准 / 批量打回。
 *
 * ── 「同方向」这一半由【形状本身】保证，没有判据 ──────────────────
 * 一次请求只带一个 resume，所以「这一批里有人批准有人打回」在 JSON 里写不出来。
 * 这不是省事：判据可以是「漏写一次」的，形状不能（0026 §0 为 kindOf() 立的那条规矩
 * 同源）。§9.4 那半句因此不需要一条测试去守 —— 它由这个类型守住。
 *
 * ── 为什么枚举比单条审批【窄】────
 * §9.4 的原文只有「批量批准 / 批量打回」。第三个按钮 defer_deep_review
 * （升级到更深审阅）不在其中，而它不进批量是有实质理由的：升级的对象是
 * 「这一件事要更多人看」，一次升 20 张卡读起来像批量处理，实际是把
 * 更深审阅流程当成垃圾桶（§10 那三种会议的入口）。要排除就别让它可表达。
 *
 * ── 上限 50 不是拍的 ────────
 * 每张卡走【一个独立事务 + 一次图恢复】（见 app.ts 那个批量 handler 的理由段：
 * 审计形状与单条逐字同源是 CEO 定的口径，不为了批量而新造一种事件形状）。
 * WriteQueue 是全局串行的，所以一批的上限就是「别的写被排住多久」的上限。
 * 50 张卡对应 CEO 在收件箱里一次勾得过来的量；再多就该是分几次点，
 * 而不是让一次点击独占写队列。
 */
export const BATCH_RESUME_VALUES = ["approve", "reject_with_comment"] as const;
export type BatchResumeValue = (typeof BATCH_RESUME_VALUES)[number];

export const BATCH_MAX_CARDS = 50;

export const approvalBatchRequestSchema = z
  .object({
    approval_ids: z
      .array(z.string().min(1).max(200))
      .min(1)
      .max(BATCH_MAX_CARDS),
    resume: z.enum(BATCH_RESUME_VALUES),
    note: z.string().trim().min(1).max(4000).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    // 与单条那条 superRefine 同一条判据（reject 必带理由），这里只是把它带进批量。
    if (
      data.resume === "reject_with_comment" &&
      (data.note === undefined || data.note.length === 0)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "resume=reject_with_comment 必须带非空 note。空理由的打回到了产出方那里不可执行" +
          "（§8.3；批量不改变这一条，一张卡的不可执行不因 batching 变成可执行）。",
      });
    }
    // 【重复 id 当场拒，不在服务端悄悄去重】。去重会让计数说谎：
    // { ids: [a, a] } 若变成「去重后批一张」，applied 该报 1 还是 2？报 1 就得解释
    // 为什么我交了两个 id 只批了一张；报 2 就是假事实。而真正会交出重复 id 的
    // 只有两种人：脚本写错了，或前端多选状态脏了 —— 两者都该当场听见，
    // 而不是拿到一个「看起来成功」的 200。
    const seen = new Set<string>();
    for (const id of data.approval_ids) {
      if (seen.has(id)) {
        ctx.addIssue({
          code: "custom",
          message:
            "approval_ids 里有重复的 id。同一条批量里点两次同一张卡不是幂等（那靠" +
            "库里 status 判），而是调用方自己不知道交了什么。去重后重试。",
        });
        return;
      }
      seen.add(id);
    }
  });
export type ApprovalBatchRequest = z.infer<typeof approvalBatchRequestSchema>;

/**
 * 批量那一判的结论（【规格】§9.4「仅限同类型」+ 「不存在的卡整批不写」）。
 *
 * 判别式形状与 approvalOutcome 完全同源，理由也同源：两条失败分支
 * 【类型上没有 plan】⇒ 想循环写就得先证明这批判过了。
 * 「半批成功」因此写不出来：要么整批通过判据、要么一张都不动。
 * （CEO 在 0052 §4 第 3 条定的口径就是这个方向：服务端一处判、前端只做选择集。）
 */
export type BatchApprovalOutcome =
  | {
      status: typeof HTTP_UNPROCESSABLE;
      reason: string;
      /** 混类型时给出到底混了哪几种，前端不必自己再算一遍。 */
      types: readonly string[];
      plan?: undefined;
    }
  | {
      status: typeof HTTP_NOT_FOUND;
      reason: string;
      /** 缺失的 id（按请求里的顺序），整批因此不写。 */
      missing: readonly string[];
      plan?: undefined;
    }
  | {
      status: 200;
      /** 判过了：这一批同类型，且每个 id 都在库里。逐条交给调用方写。 */
      plan: {
        readonly approvalId: string;
        readonly taskId: string;
        /** 库里已非 pending ⇒ 幂等重放那一张，调用方不该再写。 */
        readonly alreadyDecided: boolean;
      }[];
      /** 整批的类型（判据保证只有一个值），给响应体回显用。 */
      approvalType: string;
    };

/**
 * 「同类型」那一半的判据，以及「不许半批」的那一半。本函数【不查库】，
 * 与 approvalOutcome 同一条立场：调用方查完把行交给它，于是判据是纯的、可测的，
 * 而「用哪条连接查」不会被塞进契约层。
 */
export function batchApprovalOutcome(o: {
  readonly requestedIds: readonly string[];
  readonly found: readonly {
    readonly approvalId: string;
    readonly taskId: string;
    readonly status: string;
    readonly approvalType: string;
  }[];
}): BatchApprovalOutcome {
  const byId = new Map(o.found.map((c) => [c.approvalId, c]));
  const missing = o.requestedIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return {
      status: HTTP_NOT_FOUND,
      reason:
        `批量里有 ${missing.length} 个 id 在库里不存在，整批一张都没写：` +
        missing.join(", ") +
        "。整批不写是刻意的 —— 半批成功在审计里读起来像「CEO 批了这批」，" +
        "而事实是「这批里有一部分根本不存在」，两种话不能共用一条事件形状。",
      missing,
    };
  }
  const types = [...new Set(o.found.map((c) => c.approvalType))].sort();
  if (types.length > 1) {
    return {
      status: HTTP_UNPROCESSABLE,
      reason:
        "批量必须同类型，这批混了 " +
        types.length +
        " 种：" +
        types.join(", ") +
        "。（§9.4：仅同类型同方向。混类型的批量会让一次点击的审计跨了职责范围，" +
        "而不同类型的门控判据本来就不同。）",
      types,
    };
  }
  return {
    status: 200,
    approvalType: types[0] ?? "",
    plan: o.requestedIds.map((id) => {
      const card = byId.get(id) as {
        approvalId: string;
        taskId: string;
        status: string;
        approvalType: string;
      };
      return {
        approvalId: card.approvalId,
        taskId: card.taskId,
        alreadyDecided: card.status !== APPROVAL_STATUS_PENDING,
      };
    }),
  };
}

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

/**
 * `GET /approvals` 的条目视图。
 *
 * ── 这个端点存在的唯一理由：它是那个数字【唯一能与库对账的地方】 ──────
 * `events/bus.ts` 里 `ApprovalDecided` 那段注释记着同一件事：收件箱的待批数由
 * 消费者按事件累计（`ApprovalRequired` +1、`ApprovalDecided` −1），而
 * 「事件算出来的数」与「库里实际有几张 pending」此前**没有任何一处可比**，
 * 所以那个计数是【无从校验】的 —— 一个只能靠自己不丢不重来维持正确性的数字。
 * 本端点就是那条 REST 源（【规格】§5.8：事件只做增量，全量状态由 REST 补齐）。
 *
 * ── 字段表为什么长这样 ──────────────────────────────────────────────
 * 与 taskViewSchema 同一条口径：**不是 approvals 那行的整行直译**。
 *  ① 不带 `parameters` 的全文。它是 JSON 文本，里面常有 diff 摘要、缺陷清单，
 *     收件箱是「扫一屏、按一次键」的地方，把参数全文发到列表接口上
 *     等于让渲染进程自己裁字段 —— 裁错了就是界面上少一行信息而接口没错。
 *     要参数的人走 `GET /approvals/:id` 那一条（等它有人要的时候再加，
 *     而不是先给一个「列表里塞全部」的形状）。
 *  ② `timeout_at` / `timeout_behavior` 【带】。这一对是【规格】§9.2 第二行明写的
 *     「超时行为」那一栏，卡片上必须显示「还有几小时过期」。
 *     ⚠ 但**带到期时刻不等于会执行它**：今天全仓没有任何超时执行者
 *     （口径见 0026 §2 与 hub/src/approvals/cards.ts 的 DEFAULT_TIMEOUT_HOURS 上方）。
 *     界面因此**不该**画一个倒数到零就变的动画 —— 它到了零什么都不会发生，
 *     而一个会走到零然后停住的倒计时，读起来像系统坏了。
 *  ③ `escalation_reason` 是从 `parameters.escalation.reason` 里**提出来**的一格，
 *     而不是把整个 parameters 发出去：收件箱要按原因分组统计
 *     （「今天有几件是因为不可逆动作上来的」，【规格】§8.3 那条北极星），
 *     而让每个消费者各解一遍那段 JSON 就是五处会漂移的解析。
 */
export const approvalViewSchema = z
  .object({
    id: z.string().min(1),
    task_id: z.string().nullable(),
    approval_type: z.string().min(1),
    summary: z.string().min(1),
    recommendation: z.string().nullable(),
    recommendation_source: z.string().nullable(),
    timeout_behavior: z.string().nullable(),
    timeout_at: z.number().int().nullable(),
    status: z.string().min(1),
    created_at: z.number().int().nullable(),
    /** 【规格】§8.3 的升级原因；非升级卡为 null。**不是**枚举类型：
     *  这一格存的是【当时写下的那个字符串】，库里出现一个契约不知道的取值时，
     *  视图应当把它**原样带出去**让人看见，而不是在解析层整体 500。 */
    escalation_reason: z.string().nullable(),
    /**
     * 卡片背面的证据引用（O5 动作 4，0008）。
     *
     * **可空**，且 null 与 [] 含义不同：
     *  - null  —— 建卡时没给证据引用（含 0008 之前的存量行，今天 0 张）；
     *  - []    —— 给了空引用（契约 .strict() 本不允许，读侧照原样带出）；
     *  - 数组  —— 每项是一个证据引用（文件路径 / sha256 / 外部链接）。
     * 这一格让「这张卡有没有证据包」成为【可核对的状态】：UI 对 null/[] 明说
     * 「无证据包」，而不是把缺证据的卡伪装成有证据的卡。
     */
    evidence_refs: z.array(z.string()).nullable(),
    /**
     * 策略引擎对这张卡的**影子判定**（O9 动作 1 阶段一：只报不批）。
     *
     * 形状与 hub 侧 `AutoApproveOutcome` 的判定字段同构（TS 联合，值域不放开成 string）。
     * 这一格存在的唯一理由是【测量】：规则今天零生产调用方，接上之前「规则会怎么判」
     * 永远只有代码没有读数；而阶段一【不改任何决定】——写路径一次 `autoApprove`
     * 都不调，卡片状态、审计、`decided_by` 全与这一格无关。
     * 界面对它的正确读法是「规则判 / 人判」并排，而不是任何自动动作。
     */
    policy_shadow: z
      .union([
        z.object({
          decision: z.literal("auto_approved"),
          rule: z.string().min(1),
          tier: z.string().min(1),
        }),
        z.object({
          decision: z.literal("require_approval"),
          tier: z.string().min(1),
          blocked_by: z.string().min(1),
          missing: z.array(z.string()),
          note: z.string(),
        }),
      ])
      .nullable(),
  })
  .strict();
export type ApprovalView = z.infer<typeof approvalViewSchema>;

/**
 * `GET /approvals/:interruptId` 的视图 = 列表那一格 + **参数快照全文** + 那一次决定的三个字段。
 *
 * ── 为什么要另开一个形状，而不是给 approvalViewSchema 加三个可选键 ────
 * 加了「可选」就等于宣布【两个端点都可以发它】。而上面那份注释里写的是另一回事：
 * 列表**不许**带 `parameters` 全文，理由是「一旦列表里有全文，就永远有人直接渲染它」，
 * §19.4 那条「卡片三行、不画框线」的排版口径从此守不住。可选键挡不住那个人 ——
 * 他读的是列表响应里那一格，而契约说它合法。另开一个类型让这条边界长在类型上：
 * 拿 `ApprovalView` 去渲染参数快照，编译期就过不去。
 *
 * ── parameters 为什么可以是 null，明明 DDL 写着 NOT NULL ─────────────
 * `parameters TEXT NOT NULL` 约束的是【有没有这一列的值】，不是【那是不是 JSON】。
 * 一段被旁路写进去的脏文本（不是合法 JSON）不该让整个详情视图 500：读侧一律
 * 「坏的照实说」。null 在这一格的意思是**「读不出一个 JSON 对象」**，而它同时盖住
 * 三种库里的样子 —— 列值为 NULL（显式写 NULL 的旁路插入，见上面 status 那一段同一族）、
 * 存的是标量或数组而不是对象、整串不是 JSON。三种都不该被伪装成「这张卡没带参数」。
 * 界面因此对 null 明写「参数快照读不出来」，而不是画一个空区块假装摊开过了。
 *
 * ── 那三个决策字段【只有详情有】的理由 ──────────────────────────────
 * 收件箱默认只列 pending，而 pending 卡上三格全为 null —— 于是「把它做成可选键」
 * 还会额外造出一个读不出的形状：列表里出现 decided_at 时，人无法知道自己看的是
 * 「这一档过滤器放行的一张已决卡」还是「字段根本没发」。详情是「就是这一张卡」的
 * 唯一地方，那三格在那里才有主语。
 */
export const approvalDetailViewSchema = approvalViewSchema.extend({
  /** §9.2 第二行「关键参数快照」的原文形状（落库那段 JSON 的对象面）。见上。 */
  parameters: z.record(z.string(), z.unknown()).nullable(),
  /** 谁做的决定（`approvals.decided_by`）。pending 为 null。 */
  decided_by: z.string().nullable(),
  decided_at: z.number().int().nullable(),
  /** 打回时那句理由（`approvals.decision_note`，append-only：写了就改不掉）。 */
  decision_note: z.string().nullable(),
});
export type ApprovalDetailView = z.infer<typeof approvalDetailViewSchema>;

/**
 * `GET /approvals/:interruptId` 的响应。
 *
 * ── 为什么【不】在这一格顺手把金额格式化成 `$12.50` ────────────────
 * 写这份契约时我先加了一条 `amount_text`，理由是「三端各写一份 `(c/100).toFixed(2)`
 * 就是三份抄件」。那句话对，而它的前提是错的：**本仓今天已经有**一份
 * `packages/web/public/app.js` 的 `money()`，正在给任务预算做同一件事。
 * 再加一条服务端格式化 = 当场造出两份，而我刚用它论证过为什么不该有第二份。
 * 唯一的活消费方只有一个的时候，服务端格式化是【 speculative 的抽象】——
 * 计划 Task 4.5 对 channel 抽象立的就是这条规矩（「由一实现验证，不做二实现」）。
 * 所以金额走原路：详情给 `parameters.amount_cents`（整数美分），渲染由那唯一一份
 * `money()` 负责。将来真出现第二个消费方（移动端 / 飞书卡片），那时把 money()
 * 上提到 contracts 才是有分母的一提。
 */
export const approvalDetailResponseSchema = z
  .object({
    approval: approvalDetailViewSchema,
    /** 读数时刻，与 GET /approvals 的 asOfMs 同一条理由（客户端时钟不许用来算等待时长）。 */
    asOfMs: z.number().int(),
  })
  .strict();
export type ApprovalDetailResponse = z.infer<
  typeof approvalDetailResponseSchema
>;

/**
 * `GET /approvals` 的查询参数（白名单，未登记的键忽略而不是拒 —— 与 SSE 的
 * query 同一口径：query 是**读**侧的过滤条件，不是命令，多给一个不构成风险）。
 */
export const APPROVAL_STATUS_VALUES = [
  "pending",
  "approved",
  "rejected",
  "deferred",
] as const;
export type ApprovalStatusValue = (typeof APPROVAL_STATUS_VALUES)[number];

/**
 * 「待批」这个取值本身，以及【默认过滤集】。
 *
 * 三个地方需要同一个字面量：建卡时的初值（hub/approvals/cards.ts）、
 * 列表的默认过滤（query.ts 的 countPending）、认领时的 `WHERE status = ?`
 * （real-deps.ts）。前两个只能共享一个来源，第三个只能是 SQL 里的字面量
 * （SQL 文本里没法引用 TS 常量），由 query.test.ts 一发断言钉住它等于这里。
 *
 * ⚠ 上面那两句【已经被推翻，原文留着】：第三条也能绑参 ——
 * 「SQL 文本里没法引用 TS 常量」只对【把常量拼进字符串】成立，
 * `AND status = ?` + 把常量放进 params 是另一条路。0026 §9 留的那个问题今天答了：
 * 绑参，并把那一条靠扫源码维持的断言删掉（它失去了分母）。
 * 现在这三处【编译期同源】。绑参换来的新失效方式记在 real-deps.ts 的
 * CLAIM_APPROVAL_SQL 注释里（两个占位符可以填反，而个数是对的 ⇒ 挡不住 assertParamCount，
 * 症状是「这张卡永远批不掉」，挡住它的是那条【第一次决策返回 true】的正向用例）。
 */
export const APPROVAL_STATUS_PENDING: ApprovalStatusValue = "pending";

/**
 * `GET /bindings` 的一行（0031）。**不是 `im_bindings` 那行的整行直译** ——
 * 口径与 taskViewSchema / approvalViewSchema 同一条：对外形状由这里定义，
 * 库加一列不会自动变成契约（具名列在 hub/src/bindings/im.ts 的 BINDING_COLUMNS）。
 *
 * 三个决定值得写在契约这一层而不是 handler 那一层：
 *  ① `platform` 是**闭合枚举**而不是 string。这一列在库里由两个触发器拦着
 *    （白名单，0030 §2），所以读侧出现第四个取值只可能是【有人直接改库】。
 *    让它在解析层就响，而不是原样发给前端去 switch ——
 *    前端认不出一个平台名时的默认行为是【那一行不画】，
 *    于是「库里多了一个平台的绑定」会表现成「列表少了一行」，
 *    而那恰好是本仓反复抓的形状（记录在、看起来正常、信息没了）。
 *  ② `verified` 是 boolean 而不是 0/1。DDL 那一层它是 INTEGER（0001 的列型，
 *    本仓不 ALTER 已有列），但对外只有「验过了 / 没验过」两种真话，
 *    把 INTEGER 发出去等于让每个消费者自己决定 `2` 算不算数 ——
 *    而 0030 §6 专门加了一条触发器就是为了不让那一格有解释空间。
 *    转换只发生在 hub 侧一处（`=== 1`），口径在那边。
 *  ③ `verifiedBy` 可空。未校验的行【必须】是 null 而不是 ""：
 *    「没署名」与「署了一个空名字」在一张 append-only 的表里是两件事，
 *    而 DDL 第 7 条（0030 §7）拦的正是「未验证的行挂着署名」这个形状 ——
 *    空串是那个形状的漏网之鱼（它 IS NOT NULL），这里判 null 而不是 ""
 *    就是不在契约层把那个缝留回来。
 */
export const IM_BINDING_PLATFORM_VALUES = ["feishu", "wecom", "qq"] as const;
export type ImBindingPlatformValue =
  (typeof IM_BINDING_PLATFORM_VALUES)[number];

export const imBindingViewSchema = z
  .object({
    id: z.string().min(1),
    platform: z.enum(IM_BINDING_PLATFORM_VALUES),
    external_user_id: z.string().min(1),
    role: z.string().min(1),
    verified: z.boolean(),
    created_at: z.number().int(),
    verified_at: z.number().int().nullable(),
    verified_by: z.string().nullable(),
  })
  .strict();
export type ImBindingView = z.infer<typeof imBindingViewSchema>;

/**
 * `POST /bindings` 与 `POST /bindings/rebind` 的请求体。
 *
 * `role` 是【必填】的，而且这条必填在契约层就成立 —— 理由不是整洁：
 * 库里那一列带着 `DEFAULT 'ceo'`（0028 §2 那个陷阱的全部来源），
 * 而 HTTP 是一张真表最外面的那个入口。少一个字段就默认把人绑成 CEO，
 * 这件事在 TypeScript 里由「类型逼你写」挡着（im.ts 的 requestBinding），
 * 在 JSON 那一侧只能由 schema 的 `.min(1)` 挡着。两道各管一侧，缺一侧就漏一侧。
 *
 * ⚠ 这里【没有】`verified` 这个键，而且是 `.strict()` 挡着而不是「不看它」：
 * 「申请」与「校验」是两次写（0030 §3），把它们做成一个带可选 flag 的端点
 * 就是把两条判据焊回一条，而焊点两侧长得一模一样。校验走 verify 那一条。
 */
export const bindingRequestSchema = z
  .object({
    platform: z.string().min(1),
    external_user_id: z.string().min(1),
    role: z.string().min(1),
  })
  .strict();
export type BindingRequest = z.infer<typeof bindingRequestSchema>;

/**
 * `POST /bindings/verify` 的请求体。**只有身份，没有 `verified_by`**。
 *
 * 那是这一族里最容易被顺手做错的一格：把署名做成请求字段看起来完全合理
 * （「调用方告诉我是谁验的」），而它的结果是【任何人 POST 一个
 * {verified_by: "ceo"} 就得到一行「ceo 校验过」】——
 * 0030 §4 那条 DDL 判据（置 1 必须交出署名与时刻）当场形同虚设，
 * 因为它验的是「这一格有没有值」，验不了「这句话是不是真的」。
 * 所以署名只从服务端自己的装配来源取（HubDeps.bindingVerifier，见那边），
 * 而请求体里连这个键都不该出现 —— `.strict()` 让「客户端多传一个 verified_by」
 * 变成一个看得见的 422，而不是一次静默的采纳。
 */
export const bindingVerifyRequestSchema = z
  .object({
    platform: z.string().min(1),
    external_user_id: z.string().min(1),
  })
  .strict();
export type BindingVerifyRequest = z.infer<typeof bindingVerifyRequestSchema>;

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

/**
 * `POST /org` 的请求体 —— 一次组织变更的提交（Task 3.3 的「保存按钮」那一格，
 * 0012 §7 登记的生产入口）。
 *
 * 三个键各守一条不变量：
 *  - `before_graph`：提交【之前】的那张组织图，是 `graph` 字段。名字不叫
 *    `org` 或 `graph`（那会读成「提交【之后】想长成的那张图」）：commitOrgGraph
 *    收的是 before，`applyChangeToGraph` 在里面算出 after，审计里的 before/after
 *    快照都用同一个值 —— 调用方【不要】自己算 after，否则审计说 A 而库里是 B。
 *  - `change`：一次 `reparent` / `add_edge` / `add_node`（round294 起三种）。
 *    判别式（orgChangeSchema）在契约层就保证「既没有 child 也没有 edge 也没有
 *    node」的变更写不出来 —— 每一类只带它自己那一个载荷，所以「加节点顺带画一条
 *    边」这种捎带形状在这一层就不存在，边必须单独过一次 L2。
 *  - `change_summary`：写进 `delegation_graphs.change_summary` 的那句人话。
 *    必填、非空：版本历史里每一版都该答得出「这一版改了什么」，欠这个答案的
 *    版本号在回放里读不出意图。
 *
 * ⚠【没有 actor 字段】，而且是 `.strict()` 挡着。这条与 bindingVerifyRequestSchema
 * 里【刻意没有 `verified_by`】同一个形状同一段理由：组织变更是 self-escalating 的
 * CEO 权限写（规格 §4.2.3 把组织权集中给 CEO），让 actor 进请求体 = 任何人 POST
 * `{actor: {type:"human", id:"ceo"}}` 就是一次 CEO 动作。actor 只由服务端装配
 * （real-deps 的 ORG_ACTOR）取，从不在 HTTP 这一层读。多传一个 actor 键会
 * 得到一个看得见的 422，而不是一次静默的采纳。
 */
export const commitOrgChangeRequestSchema = z
  .object({
    graph: orgGraphSchema,
    change: orgChangeSchema,
    change_summary: z.string().trim().min(1).max(2000),
  })
  .strict();
export type CommitOrgChangeRequest = z.infer<
  typeof commitOrgChangeRequestSchema
>;

/* ────────────────────────── 状态码口径 ────────────────────────── */

/**
 * 「没有」分三种，必须可区分 —— 三者的修法完全不同：
 *  401 没带凭据（改调用方）  404 资源不存在（改参数）  501 服务端没实现（等实现）
 * 把它们混成一个 404 是本类契约最容易犯也最难查的错：前端看到 404 会去检查自己的
 * 参数，而真相可能是路由没注册。
 *
 * ⚠ 下面那个 HTTP_FORBIDDEN 是 Task 4.1 加的，它【不是第四种「没有」】——
 * 它是【有，但不许】：卡片存在、凭据有效、服务端也实现了，而策略不允许在这条通道上做。
 * 之所以仍要在这一族里登记：它与 401 的区别【必须】保住。
 * 401 的修法是「把凭据弄对」，403 的修法是「换个地方点」。
 * 把【规格】§11.4 那条「不可逆不许在远程批」翻成 401，
 * 得到的症状是 CEO 在手机上反复重签 token 而永远批不掉 ——
 * 一个把人支去检查自己凭据的报错（同上面那句 404 的病，只是换了个码）。
 */
export const HTTP_UNAUTHORIZED = 401;
export const HTTP_FORBIDDEN = 403;
export const HTTP_NOT_FOUND = 404;
/**
 * 「这件事已经有人做完了」。
 *
 * 它【不属于】上面那三种「没有」，也不属于 403「有但不许」—— 它是第四种：
 * 【你的请求本身没毛病，但它的前提刚刚不成立了】。
 * 今天唯一的用法是给「对一张已经决策过的卡片签远程票」回话。
 * 为什么不用 404（那也讲得通：这张卡对你而言已经不存在了）：
 * 404 的修法是「检查你的参数」，而这里参数完全正确 ——
 * 卡片在，id 对，只是状态变了。把「你点晚了」报成 404，
 * 界面会显示「卡片不存在」，而 CEO 看到的是一件他从没见过的东西消失了；
 * 409 至少让界面有机会说对人话：「这张卡已经被批过了」。
 */
export const HTTP_CONFLICT = 409;
export const HTTP_NOT_IMPLEMENTED = 501;
export const HTTP_UNPROCESSABLE = 422;

/* ────────────────────────── 预算与岗位书写入（POST /budget、POST /charter/:roleId） ────────────────────────── */

/**
 * 预算作用域的两档枚举字面量。契约层这一份与 hub 的 tracker.ts 各住一处
 * （contracts 不 import hub），由 budget.ts 的编译期对账钉住不漂。
 */
export const BUDGET_SCOPE_VALUES = ["company", "role", "task"] as const;
export const BUDGET_PERIOD_VALUES = ["daily", "monthly", "per_task"] as const;

/**
 * `POST /budget` 的请求体。
 *
 * ✋ 这一段是【round318 重建】：此前一版因一次工作区事故被 checkout 丢回 HEAD，
 * 形状按消费方（http/budget.ts 的 putBudgetRoute 解析用法 + budget-route.test.ts
 * 的 okBody 夹具）逐字段恢复，并经全套测试核对。
 */
export const putBudgetRequestSchema = z
  .object({
    scope_type: z.enum(BUDGET_SCOPE_VALUES),
    scope_id: z.string().min(1),
    period: z.enum(BUDGET_PERIOD_VALUES),
    limit_cents: z.number().int(),
    hard_stop: z.boolean(),
  })
  .strict();
export type PutBudgetRequest = z.infer<typeof putBudgetRequestSchema>;

/**
 * `POST /charter/:roleId` 的请求体。
 *
 * `config` 用 `charterSchema`（parse 蛇形、transform 出驼峰）：handler 里
 * `o.config.roleId` 是驼峰读法；而落库前原文（蛇形）从 body 透传给
 * saveCharterVersion（它内部再过一次 validateCharterDraft）。
 *
 * ⚠ 与 commitOrgChangeRequestSchema / bindingVerifyRequestSchema 同族：
 * 【没有 actor 键】，`.strict()` 挡着 —— 署名只从服务端装配取（CHARTER_ACTOR），
 * 从不在请求体里接受。
 */
export const saveCharterRequestSchema = z
  .object({
    config: charterSchema,
    change_summary: z.string().trim().min(1).max(2000),
  })
  .strict();
export type SaveCharterRequest = z.infer<typeof saveCharterRequestSchema>;

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

/* ────────────────────────── 断线重连策略 ────────────────────────── */

/**
 * 重连退避。住在 contracts 而不是 hub，因为【服务端永不重连】：
 * 这段代码的唯一消费者是客户端（桌面端与 Web）。放 hub 侧的话，
 * web 要么 import hub（§5.6.1 的边界立刻被破，且前端会欠下 node:sqlite），
 * 要么自己抄一份 —— 而两份退避策略的漂移表现是「桌面端 15 秒放弃、Web 无限重试」，
 * 同一个 Hub 挂掉时两个客户端给出两种说法。
 */
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 15_000;

/**
 * 第 attempt 次重连前应等待多久（attempt 从 0 起）。
 *
 * 纯函数、无状态：调用方自己记第几次。
 * 上限是这条函数存在的意义 —— 没有上限的指数退避会让 Hub 挂了一小时后
 * 重连间隔变成几十分钟，恢复后 CEO 点开看板却还要等那一坨；
 * 没有下限（每次都固定 1s）则 Hub 起不来时前端每 1s 撞一次，日志被刷满。
 */
export function reconnectDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new Error(
      "attempt 是非负整数（第 0 次重连传 0），实到 " + String(attempt),
    );
  }
  // 2**attempt 在 attempt 很大时会溢出成 Infinity，与上限取 min 之前先夹一次指数，
  // 免得「上限」这件事要靠 Infinity 参与运算才成立（能算对，但读不出意图）。
  const exp = Math.min(attempt, 16);
  return Math.min(RECONNECT_BASE_MS * 2 ** exp, RECONNECT_MAX_MS);
}

/**
 * 什么时候该放弃重连、把界面切成「去拉快照」。
 *
 * 为什么要有这一条而不是无限重连：§5.8 的纪律是「事件只做增量，全量状态由 REST 补齐」。
 * 无限重连的前端会在 Hub 崩溃期间一直显示【崩溃前】的状态，而且显示得像实时。
 * 那比一个明确的「连接断开」更坏 —— CEO 会基于一个过期看板做审批决定。
 */
export const GIVE_UP_AFTER_ATTEMPTS = 8;

export function shouldGiveUp(attempt: number): boolean {
  return attempt >= GIVE_UP_AFTER_ATTEMPTS;
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
