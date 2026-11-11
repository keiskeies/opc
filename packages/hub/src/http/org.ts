/**
 * 组织变更的 HTTP 入口（0040，Task 3.3 的「保存按钮」生产入口）。
 *
 * ── 这一篇补的是 0012 §7 记的那格「零生产调用方」────────────────────────
 * `commitOrgGraph` 从 0011/0012 之日起一直【没有生产调用方】—— 判据、三个函数、
 * 版本化提交全部写完，而没有任何运行时路径能走到它们。0012 §7 原话：
 * 「需要 contracts endpoint + ApiEndpoint union 值 + app.ts route 分支」。
 * 本文件就是那个入口（endpoint 已在 contracts 登记，路由分支已接进 app.ts）。
 *
 * ── 为什么这一条【只开回环】，同 bindings 那四条──────────────────────────
 * 组织变更是【self-escalating 的 CEO 权限写】：[spec] §4.2.3 把组织权集中给
 * CEO —— 改汇报关系、加委派边 = 改规 §8.2 哪些门控绑在边上 = 改谁能批、批什么。
 * 一次「把 A 汇报到 B」可以被包装成许多墨黑的效果。远程可提交组织变更，
 * 比 bindings 里那句「远程能自校验 = 任何人自封 CEO」还重一档：
 * 那只是【一个账号自称谁】；这是【直接改组织本身】。
 * 所以它只认回环对端（isLoopbackAddress）+ HMAC —— 本机桌面端/CLI 拿得到密钥。
 * ⚠ 它【不】参与远程一次性 token 通道：remoteTokenAuth 的白名单只有
 * 「POST /approvals/:id」（decide），org 打不进那条路，而它也不该有第二条更弱的
 * 远程通道（§20.3 只授权「审批」出本机）。这条由 handleRequest 第一道门挡着，
 * 本文件的回环门再独立挡一次（同一判据写两遍不是冗余，是两个互不依赖的方向，
 * 同 mintToken 那两道的论证）—— 端到端永远打不到，所以给直接调 handler 的
 * 测试留了出口，见 org-route.test.ts。
 *
 * ── 备份在提交【之前】，且失败就【不提交】────────────────────────────────
 * [spec] §6.5 的两件事：每日备份 + 每次改组织都留一份能回到起点的快照。
 * 生产装配（real-deps）把 `backupBeforeCommit` 这条连进提交：
 * 变更前先跑一次 §6.5 的 VACUUM INTO 快照，备份【成功】才落 commitOrgGraph
 * 的事务 —— 半提交的样子是「图 v7 已写、而改图之前没有那份能回 v6 的快照」，
 * 让一次手滑的改图永久地无路可退。所以：
 *   · 装配没接备份（无 --backup-dir） ⇒ 501 —— 不是「没做」而是「这台 Hub
 *     没有为改组织准备好恢复」。
 *   · 备份失败 ⇒ 拒绝提交（ok:false 且不给新版本号），理由原文透传到响应里。
 *
 * ── actor【不从请求体来】─────────────────────────────────────────────────
 * schema（contracts 的 commitOrgChangeRequestSchema）里【没有】actor 键，
 * 而 commitOrgGraph 又是必收 actor 的 —— 于是这里必须从装配取。来源是
 * real-deps 的 ORG_ACTOR（{human, ceo}），从不在 HTTP 层读。这与
 * bindingVerifyRequestSchema 刻意没有 verified_by 是同一个形状：
 * 让 actor 进请求体 = 任何人 POST 一个 {actor:{type:"human",id:"ceo"}}
 * 就是一次 CEO 动作。schema 的 .strict() 让多传一个 actor 键变成看得见的 422。
 */
import {
  HTTP_NOT_IMPLEMENTED,
  HTTP_UNAUTHORIZED,
  HTTP_UNPROCESSABLE,
  commitOrgChangeRequestSchema,
  type CommitOrgChangeRequest,
} from "@opc/contracts";
import type { CommitResult } from "../org/commit.js";
import { isLoopbackAddress } from "./bind.js";
import type { HubDeps, HubRequest, HubResponse } from "./app.js";

function res(status: number, body: unknown): HubResponse {
  return { status, body };
}

/** 与 bindings.ts 同一行为（那边也解释了为什么每文件一份）。 */
function parseJson(text: string): unknown {
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { __unparseable__: true };
  }
}

function issueBody(
  error: string,
  issues: { path: string; message: string }[],
): HubResponse {
  return res(HTTP_UNPROCESSABLE, { error, issues });
}

function issuesOf(e: {
  readonly issues: readonly {
    readonly path: readonly PropertyKey[];
    readonly message: string;
  }[];
}): { path: string; message: string }[] {
  return e.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

/** 回环门。返回 null = 放行，返回 HubResponse = 原样发出。同 bindings 那一条。 */
export function assertLoopbackOrgRoute(req: HubRequest): HubResponse | null {
  if (isLoopbackAddress(req.peer)) return null;
  return res(HTTP_UNAUTHORIZED, { error: "unauthorized" });
}

/**
 * `POST /org` —— 提交一次组织变更。
 *
 * 流程（顺序就是判据）：
 *  ① 回环门（只认本机，见文件头）；
 *  ② 装配没接 commitOrgChange ⇒ 501；
 *  ③ 请求体过 schema ⇒ 422；
 *  ④ 装配的 commitOrgChange（内含「备份在前、失败即拒」）⇒ 结果原样透传。
 *
 * 没有把「备份失败」单独翻一个 501/500：应给什么码由上游决定 —— 备份不可用是
 * 501（没装配），备份失败是 ok:false+reason（提交被本可避免的状态挡下）。
 * 这里只负责把 CommitResult 翻成 HTTP 响应：ok ⇒ 200，otherwise ⇒ 422 带着 reason。
 */
export async function commitOrgRoute(
  deps: HubDeps,
  req: HubRequest,
): Promise<HubResponse> {
  const gate = assertLoopbackOrgRoute(req);
  if (gate !== null) return gate;
  if (deps.commitOrgChange === undefined) {
    return res(HTTP_NOT_IMPLEMENTED, {
      error:
        "本装配未接组织提交（HubDeps.commitOrgChange）。501 而不是 404：路由在，" +
        "契约里有，是这个装配没把『变更前备份 + 提交』连起来（要在启动时配 --backup-dir）。" +
        "组织变更会改写组织本身，离开备份不可逆 —— 缺装配时宁可说不，不给一条" +
        "没有恢复点的手滑路径。",
    });
  }
  const parsed = commitOrgChangeRequestSchema.safeParse(parseJson(req.body));
  if (!parsed.success) {
    return issueBody("组织变更请求非法", issuesOf(parsed.error));
  }
  const o = parsed.data as CommitOrgChangeRequest;
  const r: CommitResult = await deps.commitOrgChange({
    graph: o.graph,
    change: o.change,
    changeSummary: o.change_summary,
  });
  if (r.ok) {
    return res(200, {
      ok: true,
      graph_version: r.graphVersion,
      graph_id: r.graphId,
      charter_bumped: r.charterBumpedRoles,
      audit_seq: r.auditSeq,
      ...(r.needsConfirmation === undefined
        ? {}
        : { needs_confirmation: r.needsConfirmation }),
    });
  }
  return res(HTTP_UNPROCESSABLE, { error: r.reason, code: r.code });
}

/**
 * `GET /org` —— 取当前生效的组织图（◤0012 §9 那条「检出之后拿不回组织图」
 * 的读侧；0012 §7 记过「先立约再补实现」的顺序，POST /org（0040）立了写约，
 * 本函数补上配套的读）。
 *
 * ⚠ 为什么这条【不是】回环专用（对比 commitOrgRoute 那道环只开回环）：
 * 读不回写、不是 self-escalating 的 CEO 权限写。POST /org 那道环防的是
 * 「远程可提交 = 直接改组织本身」；读取组织图不改变任何东西，
 * 所以它走和 GET /tasks / GET /approvals / GET /bindings 一样的那道鉴权
 * （回环 HMAC；远程 401 —— §20.3 只授权「审批」出本机，读组织图没有那条授权）。
 * 分岔由 route() 那道门统一处理，这里不再判一道回环。
 *
 * 返回值就是 commitOrgGraph 写进 graph_json 的那张 OrgGraph + 版本元数据，
 * 于是「客户端检出 stale → 重拉快照」这条链在组织图这一格上终于【能拿到内容】：
 * 一次组织变更之后，活客户端判定「我落后了」时，拉到的快照里终于有图可显示，
 * 不再是一句「对与错都不会显示」（0012 §9 的原文）。
 *
 * 要不要支持 ?version=：组织图是【版本序列不是单资源】（0055 通用语），
 * 读当前生效的那份（MAX(version)）覆盖「看板展示」这一格；
 * 指定历史版本属回放那一族的消费方，且 readGraphByVersion 在版本缺失时是
 * 【抛错】（§18.4 那行注释：不能退回最新版），那条 500 语义做进 query 要再想。
 * 本篇只做「当前生效」这份 —— 它是把「保存按钮的成果显示出来」最少的一格。
 */
export function orgGraphRoute(
  deps: HubDeps,
  req: HubRequest,
): HubResponse {
  if (deps.readOrgGraph === undefined) {
    // 与 POST /org 同一形状：路由在、契约里有，是这个装配没接读侧。
    // 501 说得清修法（接上 buildHubDeps），不是 404「路由不存在」。
    return res(HTTP_NOT_IMPLEMENTED, {
      error:
        "本装配未接组织图读取（HubDeps.readOrgGraph）。501 而不是 404：路由在，" +
        "契约里有，是这个装配没把『读最新图』连起来。",
    });
  }
  const r = deps.readOrgGraph();
  if (r.versions === 0) {
    // 从没提交过组织图。这不是 404（不是「这个资源不存在」而是「还没有这个资源」），
    // 也不是 500（不是错）。空存：返回空图 + 版本 0，客户端据此显示「尚未建立组织」。
    // 这一格与 tasks 的空列表同族：GET /tasks 在没有任务时回 [] 而不是 404。
    return res(200, {
      graph: {
        nodes: {},
        edges: [],
      },
      graph_version: 0,
      effective_from: null,
      as_of_ms: deps.now(),
    });
  }
  return res(200, {
    graph: r.graph,
    graph_version: r.version,
    graph_id: r.graphId ?? null,
    effective_from: r.effectiveFromMs ?? null,
    change_summary: r.changeSummary ?? null,
    as_of_ms: deps.now(),
  });
}

