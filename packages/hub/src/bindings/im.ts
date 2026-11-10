/**
 * IM 身份绑定的**生产者与读侧**（`im_bindings` 从 0001 建好以来的第一份读写）。
 *
 * ── 这一篇补的是哪一格 ──────────────────────────────────────────────
 * 0028 §2 量的事实是：表在 `0001_init.sql:249`，而**全仓读写方 0 处**，
 * 结论是「缺的是生产者与那次校验，不是判据，更不是那张表」。本文件就是那个生产者，
 * 校验落在那五条 DDL 判据上（migration `0005_im_binding_identity`，逐条理由在它文件头）。
 *
 * ── 这张表上「最小的一行」比「没有这行」危险，这是本文件全部判据的根 ──
 * 0001 给这张表的定义是：
 *     ceo_role TEXT NOT NULL DEFAULT 'ceo',   verified INTEGER DEFAULT 0
 * 也就是说**任何一次不带 ceo_role 的 INSERT 都造出一个 CEO**。
 * 0028 §2 原话：「任何一个在这个平台上发过消息、且有人替他插过一行绑定的账号，
 * **默认就是 CEO**，而那行绑定有没有被验证过完全不看」，
 * 并且「今天全部测试都会绿」（fake 的假定正是「这个人就是 CEO」）。
 *
 * 所以这里最反直觉、也最要紧的一条口径是：
 * **`requestBinding` 不接受 `verified`，也不接受「顺手置 1」** ——
 * 一次申请只能写下「有人在申请」，把冒充挡在判据而不是挡在自觉上。
 *
 * ── 四条判据，每条都对应一种会静默的坏法 ────────────────────────────
 * 1. **平台白名单在写侧也判一次**（`feishu` / `wecom` / `qq`，DDL 那条是兜底）。
 *    归一化（trim + 转小写）在**校验之前**，因为顺序反了会变成
 *    「用户手滑打个大写 ⇒ 一句数据库报错」。白名单里没有 `fake`：
 *    那是测试通道（`ChannelPlatform` 第四位），它不该进这张**真表** ——
 *    一个 fake channel 配上 `verified=1` 的绑定就能走完整条读侧，
 *    那正是 0028 §2 那条冒充通道，只是换了入口。
 * 2. **申请与校验是两次写**（`requestBinding` / `markVerified`）。
 *    「一个 IM 账号能批审批」在库里必须是两次分开的动作，
 *    中间那次 `verified=0` 是库里**可查询的**「正在申请」状态（`listBindings` 读得到）。
 *    ⚠ 这里原本写的是「**可见的**……能被界面读出来」，而**本模块一个界面都没有**
 *    （无路由、无 CLI、无 IPC，见 0030 §0）—— 那是把设计意图写成了已兑现的性质。
 *    ⚠ 0031 之后**这半句又被兑现了一半**：`GET /bindings` 那条路由 + 桌面一条只读通道
 *    现在真能把这个列表读出来（0031 §3），所以「读不到」不再成立。
 *    **但那条更正不改变本条判据，而且理由值得留着**：当时错在「把意图写成事实」这个动作，
 *    而不是错在内容 —— 事实后来是自己追上来的。今天这条列表在桌面上**只有读**，
 *    三条写路由**刻意**没有通道（0031 §3 那三条理由），
 *    所以「库里那个可查询状态」与「界面上有个按钮」之间**仍然隔着一次显式的判断**。
 *    当初那句错话牵连的那次修法选择见 0030 §3 末尾。
 * 3. **校验必须有署名与时刻**（`verified_by` / `verified_at`）。
 *    【规格】§11.4 那条「签名验证」验的是**消息**，
 *    「这个账号到底是谁」从第一天起就没人负责过；这一格把那次负责落到一次有署名的写上。
 * 4. **改绑必须先落回未验证**（`rebindRole` 一条语句里同时把 verified 落 0）。
 *    这条不是设计出来的，是**探针撞出来的**（0030 §5，本文件全部三发探针在 §5 到 §7）：
 *    前四条写完我以为判据闭合了，
 *    于是写了一发探针去试我没想到的形状，结果是
 *    `UPDATE im_bindings SET ceo_role='ceo'` **放行** ——
 *    一行「已校验：这是 dev」被就地改成「已校验：这是 CEO」，
 *    verified 一字未动、时刻没变、`verified_by='ceo'` 那句署名还在。
 *    署名说的是【另一次校验】，而它从没校验过「这个账号是 CEO」。
 *    那是 0028 §2 那个陷阱换了个入口，而**审计上一切看起来都是干净的**。
 *
 * ── 读侧只认 verified = 1，且默认拒绝 ──────────────────────────────
 * 0028 §2 给这一层定的口径是「`actorFor` 返回 null ⇒ 未授权 ⇒ 拒，**默认就是 null**」。
 * 所以「查不到」「有行但没验过」「平台归一化后不合法」三种输入**都返回 null**，
 * 而**分别带上不同的 reason** —— 都拒，但界面能说出「没绑过」与「绑了还等校验」的区别。
 * 把后两种合成一个是能跑的，代价是那句「你的申请已经提交了，等人校验」永远说不出来，
 * 于是人只会反复申请（同 0026 给 `card_missing` 与 `card_decided` 分开写的同一条理由）。
 *
 * ── 角色集合【由调用方给】，本模块不猜「哪个角色存在」 ────────────────
 * 直觉上这里该去查一下 `ceo_role` 指的角色存不存在。它有两个候选源，实测**都不能用**：
 *   · `delegation_graphs` 是权威图（0012），但 0012 §1 第 1 条量的事实是
 *     **1 号版本一行都不存在**（`tasks.graph_version` 那列从建库起没人写过，
 *     全库躺在 `DEFAULT 1` 上）⇒ 拿它判角色存在，答案是**所有角色都不存在**，
 *     于是每一条绑定都会被拒。方向是安全的，但它不是一次校验，是一次恒假。
 *   · `role_charters` 有 `role_id`，而 0020 记了它的形状：那一列**没有任何形状约束**，
 *     `Dev` 与 `dev` 都合法而委派边只指得到其中一个 ⇒ 拿它判会把一次拼写错误
 *     变成一次「绑上了而批不动」。
 * 所以 `knownRoles` 是**注入**的，判据是「给的集合里没有 ⇒ 拒」，
 * 而**这个集合该由谁产生**是计划信息（跟 Task 3.1 那个组织图端点绑在一起），
 * 机器给不了 ⇒ 0030 §8 登记成缺口而不是替它拍一个。
 * 不给（省略）= 不判存在性，本模块只保证「verified 那一半是真的」。
 *
 * ⚠ 本模块**不 import** src/channels/，也不 import node:http。
 *   两个方向的理由：通道层（0028）刻意零 DB 依赖，反向依赖会把那条边界从两侧各拆一半；
 *   而 HTTP 层是这张表的一个入口而不是它的主人（同 approvals/query.ts 文件头那条分法：
 *   **判定的形状住在模块里，HTTP 只是它的一个入口**）。
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { assertParamCount, assertSingleStatement, type Writer } from "../db/write-queue.js";
import { requireScopeDb } from "../checkpoint/tx-scope.js";

/**
 * 允许绑定的平台。**这张表白名单严格小于 `ChannelPlatform`（4 个值）是刻意的**：
 * 少掉的那一个是 `fake`（测试通道）。有一条测试专门钉住这个不相等，
 * 防止有人「为了让两边一致」把它加进来 —— 那一刻测试夹具就能通过真表拿到真角色。
 */
export const IM_BINDING_PLATFORMS = ["feishu", "wecom", "qq"] as const;
export type ImBindingPlatform = (typeof IM_BINDING_PLATFORMS)[number];

/** 归一化的结果。三种拒绝各有 reason，因为界面的三句话不一样。 */
export type PlatformVerdict =
  | { readonly ok: true; readonly platform: ImBindingPlatform }
  | {
      readonly ok: false;
      readonly reason: "empty" | "unknown_platform" | "test_channel";
    };

/**
 * trim + 转小写 + 白名单。
 *
 * ⚠ 为什么 `fake` 单独给一个 reason 而不并进 `unknown_platform`：
 * 这两个输入的**修法**不同。`unknown_platform` 多半是拼错（那该提示「只支持这三个」），
 * 而 `fake` 出现在生产写侧**只有一种可能**：有人把测试通道接到了真绑定上。
 * 合成一个 reason 之后，第二种情况读起来像第一种（拼写错误），
 * 于是那条最该被看见的信号被并进噪音里 —— 同 0019 那句「所有告警都响等于没有告警」。
 */
export function normalizePlatform(raw: string): PlatformVerdict {
  const v = raw.trim().toLowerCase();
  if (v === "") return { ok: false, reason: "empty" };
  // 先单独认 fake，再走白名单：顺序反了它就只能得到「未知平台」。
  if (v === "fake") return { ok: false, reason: "test_channel" };
  for (const p of IM_BINDING_PLATFORMS) {
    if (p === v) return { ok: true, platform: p };
  }
  return { ok: false, reason: "unknown_platform" };
}

/**
 * 从库里读出来的一行，原样交给他（列名与 0001 + 0005 一致）。
 *
 * ⚠ 这里**刻意不描一份 `interface BindingRow`**。描了就是声称
 * 「`verified` 一定是 `number | null`、`created_at` 一定是 `number`」，
 * 而 node:sqlite 对 INTEGER 列**可能交回 bigint**（patrol.ts 的 `asNumber` 就是在处理这件事）。
 * 一份乐观的行类型不会报错，它只会让下游那个 `row.created_at + ttl` 在某天
 * 变成字符串拼接 —— 本仓抓过这一族（0021 §1 那条「`?? 0` 把类型错误兑换成合法假数字」）。
 * 所以行一律按 `Record<string, unknown>` 收，取值走下面那几个 `asXxx`。
 */
export type BindingRow = Readonly<Record<string, unknown>>;

/** 一次绑定（读侧交出的形状）。 */
export interface ImBinding {
  readonly id: string;
  readonly platform: ImBindingPlatform;
  readonly externalUserId: string;
  readonly role: string;
  readonly verified: boolean;
  readonly createdAtMs: number;
  readonly verifiedAtMs: number | null;
  readonly verifiedBy: string | null;
}

/**
 * 具名列，理由与 approvals/query.ts 的 `APPROVAL_COLUMNS` 同一条：`SELECT *` 会让
 * 以后加的任何一个内部列【自动】变成对外形状。这里尤其不能 `*`：
 * 那张表将来可能带平台侧的原始 payload（头像、显示名），那两个都不属于判定输入。
 */
export const BINDING_COLUMNS =
  "id, platform, external_user_id, ceo_role, verified, created_at, " +
  "verified_at, verified_by";

/**
 * 申请一条绑定。**没有 verified 这一列** —— 判据的形状就是那句「申请不是校验」。
 *
 * ⚠ `ceo_role` 是必填参数，而且这里刻意**不写 DEFAULT**：
 * 库里那一列带着 `DEFAULT 'ceo'`（0028 §2 那个陷阱的全部来源）。
 * 只要本模块的 SQL 里出现「不传就交给默认值」，那一个字符的疏漏就会造出一个 CEO，
 * 而它**不会报错**（默认值的作用就是让缺失看起来合法）。
 * 所以宁可用类型逼调用方每次写出那个角色。
 */
export const REQUEST_BINDING_SQL =
  "INSERT INTO im_bindings (id, platform, external_user_id, ceo_role, verified, created_at) " +
  "VALUES (?, ?, ?, ?, 0, ?)";

/**
 * 改绑：换角色，并**在同一条语句里**把 verified 落回 0、署名清空。
 *
 * ⚠ 这一发**只有这一种写法能走通**，而理由不是我先想的那条（先写错、后实测纠正）：
 * 我原先写的是「拆成两条会留一个并发窗口，那一格里别人读到一行假 CEO」。
 * **那句是错的** —— `w.node()` 给的两条语句在同一条事务里（txScope 开 BEGIN），
 * 并发读侧在 COMMIT 之前**看不到**中间状态。所以「拆两条会漏给并发」这一条不成立。
 * 实测的真实情况更简单也更强：**拆两条根本走不到第二步** ——
 *   ① `UPDATE … SET ceo_role='ceo'`（不动 verified）
 *      ⇒ 触发器 `im_bindings_rebind_resets_verified` 当场拦下（verified 还是 1 而身份变了）
 *   ② `UPDATE … SET verified=0, verified_at=NULL, verified_by=NULL`
 *      ⇒ 走不到这里，① 已经抛了
 * 也就是说「同一条语句」不是我这边的风格偏好，是**数据库只给了这一条合法路径**。
 * 记在这儿是因为它的形状：我把「判据生效」的原因写成了一条**想当然的并发论证**，
 * 而那条论证在自家的事务模型下压根不成立（0029 §4 那条「我读错自己写的判据」同族，
 * 只是这次读错的是我自己写下的成因）。
 */
export const REBIND_ROLE_SQL =
  "UPDATE im_bindings SET ceo_role = ?, verified = 0, verified_at = NULL, " +
  "verified_by = NULL WHERE platform = ? AND external_user_id = ?";

/**
 * 校验：把一次人工确认落成一个有署名的写。
 *
 * `WHERE … AND verified = 0` 这一截是**幂等的判据**，不是装饰：
 * 重复点两次「已校验」在库里必须是**一次状态跃迁 + 一次 no-op**，
 * 而不是把 verified_at 刷成第二次的时间。理由与 0026 那张卡的条件 UPDATE 同一条 ——
 * 「什么时候验的」一旦被后续动作覆盖，那次署名的时刻就不是当初那次校验的时刻了。
 */
export const MARK_VERIFIED_SQL =
  "UPDATE im_bindings SET verified = 1, verified_at = ?, verified_by = ? " +
  "WHERE platform = ? AND external_user_id = ? AND verified = 0";

/** 读侧主查询：**只认 verified = 1**。 */
export const SELECT_VERIFIED_BINDING_SQL =
  "SELECT " +
  BINDING_COLUMNS +
  " FROM im_bindings WHERE platform = ? AND external_user_id = ? AND verified = 1";

/** 判定用：把「有行但没验过」与「压根没这行」分开（两种情形界面上说两句话）。 */
export const SELECT_BINDING_BY_IDENTITY_SQL =
  "SELECT " + BINDING_COLUMNS + " FROM im_bindings WHERE platform = ? AND external_user_id = ?";

/** 列表（给界面看「谁申请了什么、谁验过」）。已验证的排前面，其余按申请时间。 */
export const SELECT_BINDINGS_SQL =
  "SELECT " +
  BINDING_COLUMNS +
  " FROM im_bindings ORDER BY CASE WHEN verified = 1 THEN 0 ELSE 1 END, created_at ASC";

/* ================================================================== *
 * 判决形状
 * ================================================================== */

/**
 * 写侧的判决。**每一个失败支都是一个返回值而不是异常**，除了一种：
 * 数据库层的判据被绕到（触发器 RAISE）—— 那一种**必须**抛，
 * 因为它意味着「TS 侧的预检漏了一维，而库替我们兜住了」。
 * 把兜底成功写成 ok:true 是本仓抓过的那族（0021 §1「拦住了」这句话什么时候是假的）：
 * 写侧返回 ok 而库里有别的形状，下一次读侧拿到的就是一个没人预期到的角色。
 */
export type RequestBindingResult =
  | { readonly kind: "requested"; readonly id: string; readonly role: string }
  /** 已经有一行了（可能待校验，也可能已校验）。不覆盖它 —— 见下面那段。 */
  | { readonly kind: "already_bound" }
  | { readonly kind: "rejected_platform"; readonly reason: "empty" | "unknown_platform" | "test_channel" }
  /** 角色不在注入的那份集合里（不注入 = 不判，见文件头）。 */
  | { readonly kind: "unknown_role"; readonly role: string }
  | { readonly kind: "invalid_input"; readonly field: "role" | "external_user_id" };

export type MarkVerifiedResult =
  | { readonly kind: "verified"; readonly verifiedAtMs: number }
  /** 那一行不存在 ⇒ 与下面那种分开：「没人申请过」与「已经验过了」是两句话。 */
  | { readonly kind: "not_found" }
  | { readonly kind: "already_verified" }
  | {
      readonly kind: "invalid_input";
      readonly field: "verified_by" | "external_user_id";
    }
  | { readonly kind: "rejected_platform"; readonly reason: "empty" | "unknown_platform" | "test_channel" };

export type RebindResult =
  | { readonly kind: "rebound"; readonly role: string }
  | { readonly kind: "not_found" }
  | { readonly kind: "unknown_role"; readonly role: string }
  | { readonly kind: "invalid_input"; readonly field: "role" | "external_user_id" }
  | { readonly kind: "rejected_platform"; readonly reason: "empty" | "unknown_platform" | "test_channel" };

/** 读侧判决：null 之外还要交出**为什么**，因为界面上那是三句不同的话。 */
export type ResolveResult =
  | { readonly kind: "resolved"; readonly binding: ImBinding }
  | { readonly kind: "unbound" }
  /** 有人申请过但还没人校验。**这句必须能说出来**：否则人只会反复申请。 */
  | { readonly kind: "pending_verification"; readonly role: string }
  | { readonly kind: "rejected_platform"; readonly reason: "empty" | "unknown_platform" | "test_channel" }
  /** 角色不在注入的那份集合里（注入过才可能走到这一支）。 */
  | { readonly kind: "unknown_role"; readonly role: string };

/* ================================================================== *
 * 输入校验
 * ================================================================== */

/**
 * 角色 id 的形状检查。**只做「不是一串空白」这一件事，不做存在性**。
 *
 * 为什么不做存在性判据（见文件头那格）：两个候选源都不能用 ——
 * `delegation_graphs` 生产里 0 行（0012 §1 第 1 条），拿它判会**恒拒**；
 * `role_charters.role_id` 无形状约束（0020：`Dev` 与 `dev` 都合法）。
 * 所以这里判「非空非空白」，存在性交给注入的 `knownRoles`。
 *
 * 为什么连这一点点都要判：那一列是 `TEXT NOT NULL`，空白串完全写得进去。
 * 于是 `role: " "` 会造出一行「已校验而指向一个不存在的角色」的绑定，
 * 而它**只有在使用时才炸** —— 那是本仓认定最坏的一类（失效不报错，只在远处变形）。
 */
function invalidText(raw: string): boolean {
  return raw.trim() === "";
}

function knownRole(role: string, knownRoles: ReadonlySet<string> | undefined): boolean {
  return knownRoles === undefined || knownRoles.has(role);
}

/**
 * 把 node:sqlite 的冲突异常翻成判决；不是**那一条**冲突就原样抛。
 *
 * ⚠ 判据必须指到 (platform, external_user_id) **这一对列**，不能只看「有 UNIQUE 冲突」。
 * 这张表上还有第二个唯一约束：`id TEXT PRIMARY KEY`，而本模块的 `newId` 是**可注入**的
 * （测试要可复算）。于是注入方给重一个 id 会撞在**主键**上，
 * 若按「任何 UNIQUE 都算已存在」判，那次会被报成 `already_bound` ——
 * 「这个平台账号已经绑过了」是一句**假话**，真相是「你给的行号重复了」，
 * 而两句话指向相反的下一步（前者该去看那个账号，后者该去查 newId）。
 * 更糟的是它在界面上完全可信：那一行 im_bindings 里**可能真的**有那个账号。
 *
 * 不给触发器 RAISE 写负向分支：那几条 RAISE 的文案是本模块自己写的固定串，
 * 永远不含 `UNIQUE constraint failed`，为它们写 `!msg.includes(...)` 是一行
 * **永不生效而看起来在防事**的代码（0019 §5 那条「给了一个走不到的分支还替它编成因」同族）。
 */
const IDENTITY_CONFLICT =
  "UNIQUE constraint failed: im_bindings.platform, im_bindings.external_user_id";

function asAlreadyBound(e: unknown): { readonly kind: "already_bound" } | null {
  const msg = String((e as Error).message ?? e);
  if (msg.includes(IDENTITY_CONFLICT)) return { kind: "already_bound" };
  throw e;
}

/* ================================================================== *
 * 写侧
 * ================================================================== */

/**
 * 申请一条绑定：**只能写下 verified=0**，这是这一发的全部产出。
 *
 * ⚠ 已存在时**不覆盖**（返回 already_bound 而不是 UPSERT）。
 *  最省事的写法是 `INSERT … ON CONFLICT DO UPDATE SET ceo_role=…, verified=…` ——
 *  一行搞定「有则改、无则加」。**这里不采用它，而它被采用会不会出事是实测过的**
 *  （探针三发，逐条在 0030 §5 到 §7，各自对应拦下它的那条触发器）：
 *  · `UPSERT … VALUES(…, verified=1)` 插新行 ⇒ **被 DDL 拦下**（第 3 条那条 RAISE
 *    在 UPSERT 的 INSERT 分支上照样触发，这条不用担心）；
 *  · `UPSERT … DO UPDATE SET ceo_role=…, verified=0` 换一条已校验行的身份、
 *    但**不顺手清署名** ⇒ **被 DDL 拦下**（第 7 条：verified 落 0 而不清
 *    verified_at / verified_by 会造出一句挂在未校验身份上的署名）。
 *  ⇒ 所以那五条 DDL 判据**不依赖本模块的自觉**，这是它们存在的意义。
 *    本模块仍然不用 UPSERT，理由是另一条而不是安全：
 *    「申请」与「改绑」在界面上是两个人的两个动作（一个是「我要接入」，
 *    一个是「这个账号换成带另一个角色」），压成一条语句之后那两个动作**在库里无法区分**，
 *    而 0030 §5 讲的那个**可见的**中间状态（正在重新申请）也没了。
 */
export async function requestBinding(
  w: Writer,
  o: {
    readonly platform: string;
    readonly externalUserId: string;
    readonly role: string;
    readonly nowMs: number;
    readonly knownRoles?: ReadonlySet<string>;
    /** 注入的行 id 生成器；默认 randomUUID。测试要可复算时才换。 */
    readonly newId?: () => string;
  },
): Promise<RequestBindingResult> {
  const p = normalizePlatform(o.platform);
  if (!p.ok) return { kind: "rejected_platform", reason: p.reason };
  if (invalidText(o.externalUserId)) return { kind: "invalid_input", field: "external_user_id" };
  if (invalidText(o.role)) return { kind: "invalid_input", field: "role" };
  const role = o.role.trim();
  if (!knownRole(role, o.knownRoles)) return { kind: "unknown_role", role };
  if (!Number.isFinite(o.nowMs)) {
    throw new Error("requestBinding: nowMs 必须是有限数，实到 " + String(o.nowMs));
  }
  const id = (o.newId ?? randomUUID)();
  const params = [id, p.platform, o.externalUserId, role, o.nowMs];
  return await w.node(() => {
    const db = requireScopeDb("requestBinding");
    assertSingleStatement(REQUEST_BINDING_SQL);
    assertParamCount(REQUEST_BINDING_SQL, params);
    try {
      db.prepare(REQUEST_BINDING_SQL).run(...(params as never[]));
    } catch (e) {
      const dup = asAlreadyBound(e);
      if (dup !== null) return dup;
      throw e;
    }
    return { kind: "requested", id, role };
  });
}

/**
 * 那一次人工校验。**署名不是鉴权**，这一句要说准：
 * 这一格记下的是「有一个人在这一刻断言这个账号就是这个角色」，
 * 而「凭什么是他说了算」这件事**今天还没有人回答**（0030 §9 登记）。
 *
 * ⚠ 我第一版在这里写过「由入口回答（这条路只开回环，见 http/bind.ts 那条门）」，
 * 那句是**错的**：本模块**一个入口都没有** —— 没有 HTTP 路由，没有 CLI，没有 IPC。
 * `http/bind.ts` 那条回环门管的是**签票**那条路（`POST /approvals/:id/token`），
 * 与校验绑定无关。我把「将来应当由它回答」写成了「由它回答」，
 * 而那两句话在代码 review 里完全同形，只有去数路由表才能分开。
 * ⚠ **0031 之后入口真的有了，而上面那段更正【不能删】** —— 现在确实有一条只开回环的
 * 校验路由（`http/bindings.ts` 的 verifyBindingRoute），那句错话的**结论**追上了事实，
 * 但它错的那个**动作**（把「将来应当」写成「现在就是」）与本函数下面那两句的关系一字未变：
 * 门管的是【哪条通道能到这里】，不是【凭什么是他说了算】。
 *
 * 现在的真实状况：`markVerified` 是一个**能被任何拿到 WriteQueue 的代码调用**的函数，
 * 而它不判调用者是谁。它提供的是**可追责性**（出事后库里能问到人），
 * 不是**认证**。这两件事混起来的后果与本仓抓过的那族同形：
 * 读代码的人看见 `verified_by='ceo'` 就以为验过身份了。
 *
 * 补的那一半归在 HTTP 那一发（0030 §9）：校验入口必须与桌面端走同一条鉴权
 * （`http/auth.ts` 那个 HMAC），并像签票那条一样**只开回环** ——
 * 远程能自校验绑定 = 任何人可以自己给自己发一个 CEO 身份，
 * 那比「远程能签票」还严重一档（票还得对上一张已存在的卡片）。
 * ⚠ 上面那句「归在」写的时候是**待办**，0031 已经把它做掉了：四条路由全开回环 + 同一条
 * HMAC，署名只从装配参数 `--ceo` 取（没配 ⇒ 501，而不是退回请求里那个）。
 * **而本函数一字未改** —— 那是刻意的：上面那段「现在的真实状况」今天**仍然逐字成立**。
 * 0031 关掉的是【哪条通道能到这里】，而「**凭什么是他说了算**」这件事
 * 依然没有答案（0030 §9 ① 与 ② 的产品那一半仍挂着）。
 */
export async function markVerified(
  w: Writer,
  o: {
    readonly platform: string;
    readonly externalUserId: string;
    readonly verifiedBy: string;
    readonly nowMs: number;
  },
): Promise<MarkVerifiedResult> {
  const p = normalizePlatform(o.platform);
  if (!p.ok) return { kind: "rejected_platform", reason: p.reason };
  if (invalidText(o.verifiedBy)) return { kind: "invalid_input", field: "verified_by" };
  if (invalidText(o.externalUserId)) return { kind: "invalid_input", field: "external_user_id" };
  if (!Number.isFinite(o.nowMs)) {
    throw new Error("markVerified: nowMs 必须是有限数，实到 " + String(o.nowMs));
  }
  const by = o.verifiedBy.trim();
  const params = [o.nowMs, by, p.platform, o.externalUserId];
  return await w.node(() => {
    const db = requireScopeDb("markVerified");
    assertSingleStatement(MARK_VERIFIED_SQL);
    assertParamCount(MARK_VERIFIED_SQL, params);
    const info = db.prepare(MARK_VERIFIED_SQL).run(...(params as never[]));
    if (Number(info.changes) === 1) return { kind: "verified", verifiedAtMs: o.nowMs };
    // changes === 0 有两种，分开报（0026 那条「两种『拿不到』必须分开」同族）。
    const row = db
      .prepare(SELECT_BINDING_BY_IDENTITY_SQL)
      .get(p.platform, o.externalUserId) as BindingRow | undefined;
    if (row === undefined) return { kind: "not_found" };
    return { kind: "already_verified" };
  });
}

/**
 * 改绑：换角色 + **同一条语句里**把 verified 落回 0。
 *
 * 这一发存在的理由是 0030 §5 那个探针结论：已验证的绑定不许就地换身份。
 * 所以它**不接受** verifiedBy —— 想重新校验必须再走一次 markVerified，
 * 而那是第二次显式动作。把它做成一个可选参数（「改绑时顺手验一下」）
 * 就等于把两条判据焊回一条，而焊点两侧长得完全一样。
 */
export async function rebindRole(
  w: Writer,
  o: {
    readonly platform: string;
    readonly externalUserId: string;
    readonly role: string;
    readonly knownRoles?: ReadonlySet<string>;
  },
): Promise<RebindResult> {
  const p = normalizePlatform(o.platform);
  if (!p.ok) return { kind: "rejected_platform", reason: p.reason };
  if (invalidText(o.externalUserId)) return { kind: "invalid_input", field: "external_user_id" };
  if (invalidText(o.role)) return { kind: "invalid_input", field: "role" };
  const role = o.role.trim();
  if (!knownRole(role, o.knownRoles)) return { kind: "unknown_role", role };
  const params = [role, p.platform, o.externalUserId];
  return await w.node(() => {
    const db = requireScopeDb("rebindRole");
    assertSingleStatement(REBIND_ROLE_SQL);
    assertParamCount(REBIND_ROLE_SQL, params);
    const info = db.prepare(REBIND_ROLE_SQL).run(...(params as never[]));
    if (Number(info.changes) === 0) return { kind: "not_found" };
    return { kind: "rebound", role };
  });
}

/* ================================================================== *
 * 读侧
 * ================================================================== */

/**
 * 行 → 视图。**收的是 `Record<string, unknown>` 而不是描一份行类型**，两个理由：
 * ① node:sqlite 的 `.all()` 交出的就是这个形状，硬要 `as BindingRow[]` 会得到
 *   TS2352（我撞到了）而正解是 `as unknown as` 双层断言 —— 0005 §5 那条
 *   「`as` 断言换不来的保证就别用 `as` 换」说的正是这种写法；
 * ② INTEGER 列在 node:sqlite 里可能是 `number` **也可能是 `bigint`**，
 *   描出来的行类型写 `number` 是一句**假话**（它当场过了编译，
 *   然后在某个 SQLite 把那一列读成 bigint 的时刻变成一个字符串拼接）。
 *   `Number()` 一层把这件事收敛掉，与 patrol.ts 的 `asNumber` 同一条口径。
 */
function asText(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

function asNum(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : Number(v ?? 0);
}

function asNumOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return typeof v === "bigint" ? Number(v) : Number(v);
}

function asTextOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

function toBinding(row: Record<string, unknown>): ImBinding | null {
  const p = normalizePlatform(asText(row["platform"]));
  // 库里的值不合法 ⇒ **null**（拒），而不是抛。
  // 方向要说清：这一支今天走不到（DDL 白名单在写侧拦住了），
  // 但「库里有一行不合白名单」的唯一现实成因是有人绕过写侧直接改库，
  // 那时**继续把它当一次有效绑定**才是事故；拒掉 + 让调用方看得见 reason 是对的。
  if (!p.ok) return null;
  return {
    id: asText(row["id"]),
    platform: p.platform,
    externalUserId: asText(row["external_user_id"]),
    role: asText(row["ceo_role"]),
    // `=== 1` 而不是「truthy」：那一列可空，而 `verified = 2` 这种脏值
    // 在 truthy 判据下会**被当成已校验**。只有 1 是已校验，别的都不是。
    verified: asNum(row["verified"]) === 1,
    createdAtMs: asNum(row["created_at"]),
    verifiedAtMs: asNumOrNull(row["verified_at"]),
    verifiedBy: asTextOrNull(row["verified_by"]),
  };
}

/**
 * 「这个平台上的这个账号，在这里是谁」。
 *
 * ⚠ 只认 `verified = 1`。这一条不是这条 WHERE 的全部价值所在 ——
 * 价值在于**这里没有第二种读法**：没有 `includeUnverified` 开关，
 * 没有「管理员视图先看未验证的」。0028 §2 说得很明白，
 * 「接这张表的那个人必须自己回答『verified = 0 的行算不算数』」，
 * 而那份回答的形状是**这个函数只有一个入口**。
 * 加一个开关的那一刻，下一个调用方就会在**判定路径上**用到它。
 * 未验证的那一行不是看不见（`pending_verification` 那一支就是给它留的），
 * 是**不能被当成身份**。
 */
export function resolveBinding(
  db: Pick<DatabaseSync, "prepare">,
  o: {
    readonly platform: string;
    readonly externalUserId: string;
    readonly knownRoles?: ReadonlySet<string>;
  },
): ResolveResult {
  const p = normalizePlatform(o.platform);
  if (!p.ok) return { kind: "rejected_platform", reason: p.reason };
  if (invalidText(o.externalUserId)) return { kind: "unbound" };
  assertSingleStatement(SELECT_VERIFIED_BINDING_SQL);
  const hit = db
    .prepare(SELECT_VERIFIED_BINDING_SQL)
    .get(p.platform, o.externalUserId) as BindingRow | undefined;
  if (hit !== undefined) {
    const b = toBinding(hit);
    if (b === null) return { kind: "unbound" };
    if (!knownRole(b.role, o.knownRoles)) return { kind: "unknown_role", role: b.role };
    return { kind: "resolved", binding: b };
  }
  // 没查到已验证的 ⇒ 再问一次「有没有待校验的」。
  // 这一发第二次查询**不是**多余优化：合并成一条不带 verified 的查询也能做到，
  // 而那条路径上「已验证」与「未验证」的区分就落到调用方手里了（它得自己判），
  // 而这一整个模块的存在理由就是不把那一格交出去。
  assertSingleStatement(SELECT_BINDING_BY_IDENTITY_SQL);
  const pending = db
    .prepare(SELECT_BINDING_BY_IDENTITY_SQL)
    .get(p.platform, o.externalUserId) as BindingRow | undefined;
  if (pending === undefined) return { kind: "unbound" };
  return { kind: "pending_verification", role: asText(pending["ceo_role"]) };
}

/**
 * 给通道层用的 `actorFor`（0028 那个注入点）。
 *
 * ── 为什么是「一个 channelId → platform 的映射」而不是直接收 platform ──
 * 两边的身份**坐标系不一样**，而这个错位必须先说清再修：
 *   · `ChannelActor` 带的是 `{senderId, channelId}`，channelId 是**通道实例**的 id；
 *   · `im_bindings` 的坐标是 `(platform, external_user_id)`，platform 是**平台**。
 * 最省事的写法是工厂收一个 platform（「这个 resolver 就是给飞书用的」），
 * 而 `createChannelRuntime` 是**一个 runtime 注册多条通道**的形状 ——
 * 于是有人注册了第二条（企微）通道而沿用同一个 resolver 时，
 * 企微的 senderId 会去飞书那张表里查。那一发的症状是**认不出来**（返回 null，拒），
 * 方向安全，但另一侧同样可能：两个平台的外部 id 命名撞车（都是手机号、都是工号）时，
 * **A 平台的人会拿到 B 平台那个人的角色**，而这一发是全绿的。
 * ⇒ 所以映射按 channelId 现问，**问不到就是 null（拒）**，
 *   宁可「装配没配全 ⇒ 谁都批不了」也不猜平台。
 *
 * ⚠ 这一发的返回类型仍是 `ChannelActor`（原样交回那两个字段）——
 * 它**不携带角色**。角色由本模块的读侧在被需要时再查一次。
 * 理由：0028 那条测试钉的就是「actorFor 只拿到消息里那两个字段、运行时不自己造身份」，
 * 把 role 塞进 ChannelActor 会**扩那个类型**，而扩了之后通道层就必须在某处信任它 ——
 * 一次跨层的隐式信任，正是 0028 §6 想少加的东西。
 */
export function makeChannelActorResolver(
  db: Pick<DatabaseSync, "prepare">,
  o: {
    /** channelId → 平台。问不到（没登记）⇒ 拒。 */
    readonly platformOfChannel: (channelId: string) => string | null;
    readonly knownRoles?: ReadonlySet<string>;
    /** 观测点：每次判定的结果交给它（装配方拿去记日志/审计）。不是判据。 */
    readonly onResolve?: (senderId: string, r: ResolveResult) => void;
  },
): (actor: { readonly senderId: string; readonly channelId: string }) => {
  readonly senderId: string;
  readonly channelId: string;
} | null {
  return (actor) => {
    const platform = o.platformOfChannel(actor.channelId);
    if (platform === null) return null;
    const r = resolveBinding(db, { platform, externalUserId: actor.senderId, ...(o.knownRoles === undefined ? {} : { knownRoles: o.knownRoles }) });
    o.onResolve?.(actor.senderId, r);
    return r.kind === "resolved"
      ? { senderId: actor.senderId, channelId: actor.channelId }
      : null;
  };
}

/** 列表：谁申请了什么、谁验过。已验证在前，其余按申请先后。 */
export function listBindings(
  db: Pick<DatabaseSync, "prepare">,
): readonly ImBinding[] {
  assertSingleStatement(SELECT_BINDINGS_SQL);
  const rows = db.prepare(SELECT_BINDINGS_SQL).all() as BindingRow[];
  const out: ImBinding[] = [];
  for (const r of rows) {
    const b = toBinding(r);
    // 解不出来（平台值不合法）⇒ **跳过这一行而不是整个列表抛错**。
    // 列表面向的是「扫一眼有多少申请」，为一行脏数据让整个界面 500
    // 与 approvals/query.ts 那条「解析不出给 null 不抛」同一条口径。
    if (b !== null) out.push(b);
  }
  return out;
}

