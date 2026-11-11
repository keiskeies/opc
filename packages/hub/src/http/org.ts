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
