/**
 * `im_bindings` 的 HTTP 入口（0031）。
 *
 * ── 这一篇补的是 0030 §0 那格 ────────────────────────────────────────
 * 0030 写完时，`src/bindings/im.ts` 的生产调用点是 **0 处** —— 判据、写侧、读侧
 * 全绿，而【没有任何运行时路径能走到它们】。那篇把它登记成「等 CEO 决定要不要开入口」。
 * 本文件就是把那个入口开上：四条路由，全部通过既有的 HMAC 鉴权，全部【只认回环】。
 *
 * ── 为什么这个文件里【不出现】im_bindings 这四个字 ────────────────────
 * `test/bindings/im.test.ts` 有一条扫 src 的守卫：`im_bindings` 只许出现在
 * `bindings/im.ts` 一个文件里。这条入口从写下第一天就在守它的反面 ——
 * 判据住在那一列触发器 + 那一个模块里，HTTP 只是它的一个入口
 * （im.ts 文件头最后一段的同一条分法）。这里若图省事自己 `INSERT INTO im_bindings`，
 * 绕过的不是「一行 SQL」，是那一整列被测试穷尽过的预检。
 *
 * ── 为什么四条路由【全部】只开回环，而不只是 verify 那一条 ─────────────
 * 0030 §9 原话给的判据是「远程能自校验绑定 = 任何人可以自己给自己发一个 CEO 身份，
 * 那比『远程能签票』还严重一档」。那条说的是 verify。另外三条按同一把尺子量：
 *  · `POST /bindings`（申请）：远程可申请的后果不是权限洞（新行只能 verified=0），
 *    是【垃圾能进一张真表】—— 而那张表上「有申请」这件事将来是 CEO 要去清的队列。
 *    一个只能由本机发起的申请队列，才是队列。
 *  · `POST /bindings/rebind`（改绑）：它把已校验的绑定【落回未校验】，
 *    远程可发 = 任何人能把任何一个已校验身份打回「正在申请」，
 *    那是一次【拒绝服务】形状的写，比申请重。
 *  · `GET /bindings`：读的是「谁绑成了什么角色、谁在等校验」——
 *    【规格】§20.3 授权走出本机的只有【审批】这一件事，这张表不在其中。
 * 四条共用一条判据（`assertLoopbackBindingRoute`），共用一条理由。
 *
 * ⚠ 这一道门与 remoteTokenAuth 那道门【独立成立】，同 mintToken 的论证：
 * 走 handleRequest 时，非回环请求在鉴权层就 401（它签不出名），
 * 所以端到端【永远打不到】这里 —— 这是「今天不可达」而不是「写不出来」，
 * 而两者的区分是 im.ts / bind.ts 反复写过的那一条。
 * 本文件的那一发由 bindings-route.test.ts 直接调 handler 钉住。
 *
 * ── 校验的署名【不从请求体里来】──────────────────────────────────────
 * `POST /bindings/verify` 的 schema 里【没有】verified_by 这个键（contracts 那边
 * 写了为什么）。署名只从 `deps.bindingVerifier` 取 —— 那是装配方在启动时给的
 * 一个显式值（`pnpm hub:serve --ceo <名字>`），没给 ⇒ 这一条路由 501。
 * 501 而不是 401/403：401 说「你没凭据」（他有，凭据是对的），403 说「有但不许」
 * （策略上确实许，是这台 Hub 还没被告诉「谁算校验人」）。
 * 「还没装配」才是事实，而它的修法（重启时带上那个参数）只有 501 讲得出来。
 */
import {
  HTTP_CONFLICT,
  HTTP_NOT_FOUND,
  HTTP_NOT_IMPLEMENTED,
  HTTP_UNAUTHORIZED,
  HTTP_UNPROCESSABLE,
  bindingRequestSchema,
  bindingVerifyRequestSchema,
  imBindingViewSchema,
  type BindingRequest,
  type BindingVerifyRequest,
  type ImBindingView,
} from "@opc/contracts";
import {
  listBindings,
  markVerified,
  rebindRole,
  requestBinding,
  type ImBinding,
} from "../bindings/im.js";
import { isLoopbackAddress } from "./bind.js";
import type { HubDeps, HubRequest, HubResponse } from "./app.js";

function res(status: number, body: unknown): HubResponse {
  return { status, body };
}

/** 与 app.ts 的 parseJson 同一行为，但那份是私有的；两份的分歧由测试对齐（见 bindings-route.test.ts）。 */
function parseJson(text: string): unknown {
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { __unparseable__: true };
  }
}

function issueBody(error: string, issues: { path: string; message: string }[]): HubResponse {
  return res(HTTP_UNPROCESSABLE, { error, issues });
}

/**
 * 四条路由共用的回环门。返回 null = 放行，返回 HubResponse = 原样发出。
 *
 * 写成【一个函数】而不是在四个 handler 里各写一句 `if (!isLoopbackAddress(...))`，
 * 理由与 remoteTokenAuth 复用 matchRoute 同一条：同一判据写四遍，
 * 改的人只会改到他正在看的那一遍。
 */
export function assertLoopbackBindingRoute(req: HubRequest): HubResponse | null {
  if (isLoopbackAddress(req.peer)) return null;
  // 与未授权那一条【同一个形状】（只有 "unauthorized"，不带 reason）：
  // 让「远程扫这条路径」得到的答复与「凭据不对」逐字相同，
  // 否则响应体本身就成了「这里有一道回环门」的探测器。
  return res(HTTP_UNAUTHORIZED, { error: "unauthorized" });
}

/** 内部视图 → 对外视图。解析不过 ⇒ 抛（契约与库不一致必须当场响，同 toTaskView）。 */
function toBindingView(b: ImBinding): ImBindingView {
  const candidate = {
    id: b.id,
    platform: b.platform,
    external_user_id: b.externalUserId,
    role: b.role,
    verified: b.verified,
    created_at: b.createdAtMs,
    verified_at: b.verifiedAtMs,
    verified_by: b.verifiedBy,
  };
  const r = imBindingViewSchema.safeParse(candidate);
  if (!r.success) {
    throw new Error(
      "绑定行不符合对外契约（id=" +
        b.id +
        "）：" +
        r.error.issues.map((x) => x.path.join(".") + " " + x.message).join("; ") +
        "。im.ts 的行解析与 contracts 的视图 schema 出现分歧时必须当场响，" +
        "静默丢行会让「列表里少了一个绑定的账号」变成无从排查的报障。",
    );
  }
  return r.data;
}

/**
 * `GET /bindings` —— 「谁绑成了什么、谁在等校验」。
 *
 * `pendingTotal` 与 GET /approvals 的同一格同理：列表消费者要的是【那个数】，
 * 而不是把全量拉回去自己 filter —— 现在行数是个位数，但口径先立住
 * （0026 给收件箱计数写过的同一条：让前端数 = 让每个前端各数一遍）。
 *
 * ⚠ 脏行【被跳过】而不是 500。这个决定发生在 im.ts 的 listBindings
 * （平台归一化解不出 ⇒ null ⇒ 跳过），不在这里补。方向要说清：
 * 那种行今天物理上不可能存在（DDL 白名单在写侧拦着），它出现只可能是有人直接改库；
 * 那时「列表照旧、那一行不在」与「整条列表 500」都拒掉了它当身份用，
 * 区别只在报错落在谁头上。列表接口的读者是扫一眼的人，不是排查的人。
 */
export function listBindingsRoute(deps: HubDeps, req: HubRequest): HubResponse {
  const gate = assertLoopbackBindingRoute(req);
  if (gate !== null) return gate;
  const rows = listBindings(deps.db).map(toBindingView);
  return res(200, {
    bindings: rows,
    pendingTotal: rows.filter((b) => !b.verified).length,
    asOfMs: deps.now(),
  });
}

/**
 * `POST /bindings` —— 登记一条【申请】。
 *
 * 注意语义：走的是 `requestBinding`，落库只能是 `verified=0`（0030 §3 的两次写）。
 * 「申请并顺手批了」在这条路由上【不存在】，而这不是漏做：
 * im.ts 的 requestBinding 根本没有 verified 参数，HTTP 这层也拿不到。
 *
 * 已有一行 ⇒ 409。不覆盖、不报 201 —— 那一行可能已经带着【别人给的】署名，
 * 把「重复申请」做成幂等 201 等于让调用方以为自己的 role 生效了，
 * 而库里那个 role 是他没提交过的那个（0021 §2 那一族：响应没错，含义错了）。
 */
export async function requestBindingRoute(
  deps: HubDeps,
  req: HubRequest,
): Promise<HubResponse> {
  const gate = assertLoopbackBindingRoute(req);
  if (gate !== null) return gate;
  if (deps.bindingWriter === undefined) return bindingNotWired();
  const parsed = bindingRequestSchema.safeParse(parseJson(req.body));
  if (!parsed.success) {
    return issueBody("绑定请求非法", issuesOf(parsed.error));
  }
  const o = parsed.data as BindingRequest;
  const r = await requestBinding(deps.bindingWriter, {
    platform: o.platform,
    externalUserId: o.external_user_id,
    role: o.role,
    nowMs: deps.now(),
  });
  switch (r.kind) {
    case "requested":
      return res(201, { ok: true, id: r.id, role: r.role, verified: false });
    case "already_bound":
      return res(HTTP_CONFLICT, {
        error:
          "该平台账号已有绑定（可能待校验，也可能已校验）。不覆盖它 —— " +
          "改角色走 POST /bindings/rebind，重新校验走 POST /bindings/verify。",
      });
    case "rejected_platform":
      return res(HTTP_UNPROCESSABLE, {
        error: "平台不接受（只认 feishu / wecom / qq；fake 是测试通道，不得绑定真角色）",
        reason: r.reason,
      });
    case "unknown_role":
      // 0030 §8：角色存在性的判据【需要装配方注入 knownRoles】，本模块不猜。
      // 本路由没有注入（见 requestBindingRoute 的调用参数），所以这一支今天
      // 结构上不可达；分支写着是因为 im.ts 的判决形状里有它 ——
      // 漏一个 kind 时这里的 default 分支会抛，而不是静默把它当成功。
      return res(HTTP_UNPROCESSABLE, { error: "角色不在已登记的集合里", role: r.role });
    case "invalid_input":
      return res(HTTP_UNPROCESSABLE, { error: "字段形状非法", field: r.field });
    default: {
      const impossible: never = r;
      throw new Error(
        "requestBinding 返回了一个本 handler 没有分支的判决：" +
          JSON.stringify(impossible) +
          "。漏分支会被上面的 never 赋值在编译期拦住；走到运行期这一发说明" +
          "判决类型绕过了类型系统，宁可 500 也不要把它当成功。",
      );
    }
  }
}

/**
 * `POST /bindings/verify` —— 那一次人工校验。
 *
 * 三条不显然的形状，每条都在挡一个具体的洞：
 *  ① 署名只从 `deps.bindingVerifier` 来（文件头写了为什么不从请求体来）；
 *  ② 装配方没给 ⇒ 501，而不是退回「用请求里那个」或「用 ceo」——
 *    默认一个校验人，就是把 0030 §4 那条「置 1 必须交出署名」的判据
 *    在 HTTP 层换成一个永远填得上值的格子；
 *  ③ 已校验 ⇒ 409 而不是 200 幂等。markVerified 的 SQL 带 `AND verified = 0`，
 *    重复调用【不会】改写 verified_at / verified_by —— 那是刻意的
 *    （第一次那次校验的时刻与署名是事实，第二次调用不该把它刷新成「刚刚验的」）。
 *    既然库里什么都没变，回 200 就是在说「你的校验生效了」而它没生效。
 */
export async function verifyBindingRoute(
  deps: HubDeps,
  req: HubRequest,
): Promise<HubResponse> {
  const gate = assertLoopbackBindingRoute(req);
  if (gate !== null) return gate;
  if (deps.bindingWriter === undefined) return bindingNotWired();
  if (deps.bindingVerifier === undefined) {
    return res(HTTP_NOT_IMPLEMENTED, {
      error:
        "本装配未指定校验人（bindingVerifier）。校验一个身份必须交出【谁验的】，" +
        "而这个值只能由装配方在启动时显式给出（pnpm hub:serve --ceo <名字>）。" +
        "501 而不是 401/403：你的凭据没问题，策略也允许，是这台 Hub 还不知道该把" +
        "署名写成谁 —— 退回一个默认署名（比如 'ceo'）会让 verified_by 变成一句" +
        "永远填得上值而与事实无关的话。",
    });
  }
  const parsed = bindingVerifyRequestSchema.safeParse(parseJson(req.body));
  if (!parsed.success) {
    return issueBody("校验请求非法", issuesOf(parsed.error));
  }
  const o = parsed.data as BindingVerifyRequest;
  const r = await markVerified(deps.bindingWriter, {
    platform: o.platform,
    externalUserId: o.external_user_id,
    verifiedBy: deps.bindingVerifier,
    nowMs: deps.now(),
  });
  switch (r.kind) {
    case "verified":
      return res(200, { ok: true, verified: true, verified_at: r.verifiedAtMs });
    case "not_found":
      return res(HTTP_NOT_FOUND, {
        error: "该平台账号没有任何绑定记录（先 POST /bindings 登记申请）",
      });
    case "already_verified":
      return res(HTTP_CONFLICT, {
        error: "这一行已经是已校验状态，本次调用没有改动任何东西（包括校验时刻与署名）",
      });
    case "rejected_platform":
      return res(HTTP_UNPROCESSABLE, { error: "平台不接受", reason: r.reason });
    case "invalid_input":
      return res(HTTP_UNPROCESSABLE, { error: "字段形状非法", field: r.field });
    default: {
      const impossible: never = r;
      throw new Error(
        "markVerified 返回了一个本 handler 没有分支的判决：" + JSON.stringify(impossible),
      );
    }
  }
}

/**
 * `POST /bindings/rebind` —— 换角色（并自动把校验落回 0）。
 *
 * 判决里【没有】「部分成功」：REBIND_ROLE_SQL 一条语句同时改 role、清 verified、
 * 清署名（0030 §5/§7 的唯一合法路径）。所以这里成功即三者齐变，
 * 响应也就如实把 verified: false 发出去，让调用方【当场】看见
 * 「改完绑定的那一刻它就不再是身份了」，而不是让他去猜改完之后还算不算。
 */
export async function rebindBindingRoute(
  deps: HubDeps,
  req: HubRequest,
): Promise<HubResponse> {
  const gate = assertLoopbackBindingRoute(req);
  if (gate !== null) return gate;
  if (deps.bindingWriter === undefined) return bindingNotWired();
  const parsed = bindingRequestSchema.safeParse(parseJson(req.body));
  if (!parsed.success) {
    return issueBody("改绑请求非法", issuesOf(parsed.error));
  }
  const o = parsed.data as BindingRequest;
  const r = await rebindRole(deps.bindingWriter, {
    platform: o.platform,
    externalUserId: o.external_user_id,
    role: o.role,
  });
  switch (r.kind) {
    case "rebound":
      return res(200, { ok: true, role: r.role, verified: false });
    case "not_found":
      return res(HTTP_NOT_FOUND, { error: "该平台账号没有任何绑定记录" });
    case "unknown_role":
      return res(HTTP_UNPROCESSABLE, { error: "角色不在已登记的集合里", role: r.role });
    case "invalid_input":
      return res(HTTP_UNPROCESSABLE, { error: "字段形状非法", field: r.field });
    case "rejected_platform":
      return res(HTTP_UNPROCESSABLE, { error: "平台不接受", reason: r.reason });
    default: {
      const impossible: never = r;
      throw new Error(
        "rebindRole 返回了一个本 handler 没有分支的判决：" + JSON.stringify(impossible),
      );
    }
  }
}

function bindingNotWired(): HubResponse {
  return res(HTTP_NOT_IMPLEMENTED, {
    error:
      "本装配未接绑定写入（HubDeps.bindingWriter）。读侧 GET /bindings 不受影响 —— " +
      "501 说的是【这一条写路径】没接，不是这张表不存在。",
  });
}

/**
 * 把 zod 的 issues 翻成对外形状（与 app.ts 里那两处同形）。
 *
 * 形参类型是【手写的结构类型】而不是 `ZodError`，一个字符的理由：
 * hub 这个包【不直接依赖 zod】（schema 全在 contracts，hub 只从那边拿
 * safeParse 的结果）。在这里 `import type { ZodError } from "zod"` 会为了一个类型
 * 给 hub 添一个直接依赖 —— 而 0009 §2 那份「哪个包能 import 什么」的
 * 依赖清单是本仓的边界本身，不该由一个格式化函数顺手改它。
 *
 * ⚠ path 的元素类型写的是 `PropertyKey` 而不是直觉上的 `string | number`，
 * 这一格是 tsc 撞出来的（第一版写后者，三处调用全报 TS2345）：
 * zod 4 那个 issue 的 path 声明是 `PropertyKey[]`，也就是【含 symbol】。
 * 我们的 schema 全是字符串键、路径今天不可能出现 symbol，但结构类型必须
 * 与实参【真的兼容】，否则它就是一个编译期在骗人的适配器。
 * 顺带说一句代价：`[Symbol()].join(".")` 在运行期会抛。app.ts 那两处
 * 拿的是真 ZodError、同样直接 join，所以这个理论形状是全仓一致的，
 * 而它的触发条件是「有人在 object schema 上用了 symbol 键」—— 那时应当抛。
 */
function issuesOf(e: {
  readonly issues: readonly {
    readonly path: readonly PropertyKey[];
    readonly message: string;
  }[];
}): { path: string; message: string }[] {
  return e.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}
