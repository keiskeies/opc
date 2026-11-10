/**
 * 一次性审批 token（计划 Task 4.1 的第二半，【规格】§20.3 + §11.4）。
 *
 * ── 它解决的是哪一件事 ──────────────────────────────────────────────
 * 桌面端连 Hub 用的是 auth.ts 那个 HMAC 密钥，而那个密钥**只在本机进程内存里**
 * （它的整个作用就是不落盘 —— auth.ts 文件头）。所以它天然出不了这台机器：
 * 手机 / 另一台笔记本【拿不到】它，也就【签不出】任何请求。
 * 这不是缺陷，是那道边界正在起作用。但 Phase 4 要的就是「手机上看一眼、点个批准」，
 * 于是需要一个**能交给远程、而泄露之后代价有限**的凭据。这就是这个模块。
 *
 * ── 与桌面端那条路的关系：不是第二条更弱的通道，是同一条路上的另一种票 ──
 * 计划给 Task 4.1 的 Test 里有一条硬要求：
 *   「移动端的批准请求与桌面端走【同一套鉴权与审计路径】（不得有第二条更弱的通道）」
 * 这条要求很容易被「达成」成表面样子 —— 比如新写一条 `POST /approvals/:id/by-token`，
 * 里面自己 UPDATE 一下 approvals。那正是第二条更弱的通道：多一条写路径，
 * 就多一处「改了这条忘了那条」的地方，而 approvals 的写路径今天只有两条
 * （real-deps.ts 的 CLAIM_APPROVAL_SQL、policy/auto-approve.ts 的自动批那条），
 * 每一条都是靠条件 UPDATE 维持幂等的。
 * 所以这里的形状是：**redeem 只负责「这张票是不是真的、还没用过、没过期的」，
 * 决定本身仍然交给调用方去走 deps.recordDecision**（= applyDecision = 同一条
 * 条件 UPDATE + 同一条 appendAudit + 同一次广播）。本模块**一行 approvals 都不写**。
 * 这条立场不是注释，有一条测试钉着：扫本模块源码，不许出现 UPDATE approvals。
 *
 * ── 为什么库裡存的是 token 的哈希而不是 token 本身 ────────────────────
 * 这是本篇最重要的一格，值得把它被推翻的路径也写下来。
 *
 * 「存原文」的第一反应是对的：主键查起来直接，调试时也看得见。它的问题在**备份**：
 * 规格 §6.5 与本仓 scripts/ 那条每天 `VACUUM INTO` 的备份会把整库复制成一个文件，
 * 而备份的存在理由恰恰是「它会躺在别的地方」（另一块盘、同步盘、某台 NAS）。
 * 库里存原文的那一刻，**每个备份文件都变成一叠待使用的审批凭据** ——
 * 拿到备份的人不需要破任何密码，直接 POST 上来就能批。
 * 而这类泄露的失效方式与本仓反复抓的那族同形：**不报错**。卡片照样批得掉，
 * 只是任何一份备份在有效期内（以及过期之后，因为过期不删行）都是一把钥匙。
 *
 * 存哈希之后，备份里只有验证子。代价两条，都记清楚：
 *  ① **签发之后无法找回原文**。这是**特性**（它正是那个属性），但它让「忘了那张票」
 *    变成「重新签发一张」，所以 issue 是**可重复调用**的，不是一次性仪式。
 *  ② 排查时看不到库里哪张票对应哪次请求。缓解：verdict 里带 approvalId 与分类原因，
 *    而「哪张票」这件事本来就不该从库里读 —— 它是客户端手上的东西。
 *
 * 哈希算法选 sha256 而**不是** bcrypt/scrypt/argon，理由要说准，因为这是个常见误用点：
 * 慢哈希防的是【低熵秘密被暴力枚举】（口令）。这里的 token 是 32 字节 CSPRNG 产物，
 * 2^256 的搜索空间，sha256 的每次一发已经不构成任何可行攻击面。
 * 用慢哈希不会更安全的，只会让**合法**的每次 redeem 慢几十毫秒 ——
 * 那是把成本从攻击者身上（本来就没有成本）转移到用户身上。
 *
 * ── 不可逆操作的审批【禁止】在远程完成（【规格】§11.4 原文） ────────────
 * 「IM 只处理可逆的、有超时默认行为的审批；不可逆操作强制在桌面端或移动端（有二次确认）完成。」
 * 这条判据在这里的实现是「**判不出算不可逆**」（0008 给门控定的同一条：判不出 ⇒ 多挡）。
 * 具体三种形状：approval_type 是 irreversible_action、parameters.irreversible 为 true、
 * 以及 **parameters 解析不出来**。最后那种是本模块存在的理由之一：
 * 如果按「解析失败 ⇒ 当成可逆」写，一条脏 JSON 就**恰好**是最该挡住的那一张卡
 * 拿到了远程批准的通道 —— 而它一句报错都不会有（解析失败这件事发生在我们的判据里，
 * 不在任何人的请求路径上）。
 *
 * ── 一次 redeem 与一次决策【不在同一个事务】，这是选择而不是遗漏 ────────
 * 顺序是：先烧票，后决策。中间崩了 ⇒ 票烧掉了而卡片还是 pending。
 * 反过来（先决策后烧票）会留下「卡片已批而票还在」⇒ **那张票还能再放一次**，
 * 而它下一次放到的是【同一张已经批过的卡】，条件 UPDATE 会挡掉写入，
 * 但挡不住「有人拿着一个仍然有效的凭据」这件事本身。
 * 两个失败方向摆在一起：
 *   烧票没决策 ⇒ CEO 手机上那句「链接失效了，请在桌面端重新点一次」，代价是一次重签；
 *   决策没烧票  ⇒ 一个可重放的审批凭据。
 * 前者是**吵**，后者是**吞**，本仓的一贯取向是宁可吵（同 0026 §5「合并比重复贵」）。
 * ⚠ 这条选择能被做成「同一个事务」的（把 redeem 塞进 applyDecision 那个 node() 回调里，
 *   insertTask 取 graph_version 就是这个形状），我没那么做，因为那需要给 applyDecision
 *   开一个通用 hook，而一个通用 hook 能做的事比它换来的那次原子性多得多。
 *   这是一个**已知可以更严**的地方，写在代码旁边而不是只写在这里。
 */

import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { APPROVAL_STATUS_PENDING } from "@opc/contracts";
import type { DomainEvent } from "../events/bus.js";
import { appendAudit } from "../events/recorder.js";
import { assertParamCount, assertSingleStatement } from "../db/write-queue.js";

/**
 * token 的原文长度。32 字节 = sha256 的原生输出宽度，也是 HMAC 的推荐键长；
 * base64url 之后 43 个字符。给 URL 用安全（无 + / =），但它**不进 URL**（见 issue 的注释）。
 */
export const TOKEN_BYTES = 32;

/**
 * 一张票的默认寿命：10 分钟。
 *
 * 这个数怎么来的值得说，因为它很容易被读成「拍了个整数」：
 * 它的上界不是「CEO 什么时候有空看手机」，而是**这条凭据的泄露窗口**。
 * 桌面端那个 HMAC 密钥的泄露窗口是「进程存活期间」，它靠不落盘把窗口压到重启为止；
 * 一张远程票的泄露窗口只能靠 TTL 压，而它能批准的东西是**花钱的动作**。
 * 10 分钟够一个人从口袋掏出手机、点开、看一眼摘要、按下去，
 * 不够「睡前扫一眼明天再批」。
 * ⚠ 它同时是**另一件事的上界**：票的有效期与 §9.3 那个 8 小时超时**无关**，
 *   别把它们读成同一个钟。票过期不代表卡片过期，卡片还在收件箱里。
 */
export const DEFAULT_TOKEN_TTL_MS = 10 * 60_000;

/** 表里 `used` 的两个取值。写成常量是因为 SQL 里只能用字面量，而判据要有出处。 */
export const TOKEN_UNUSED = 0;
export const TOKEN_USED = 1;

/**
 * 签发一张票的原文。**只在这一处产生**，调用方拿去发给远程端。
 *
 * ⚠ **一处名字与内容不符，是已知取舍**：0001 里那一列叫 `token TEXT PRIMARY KEY`，
 * 而我们【存的是哈希】。改列名要 `ALTER TABLE ... RENAME COLUMN`，而本仓的迁移纪律是
 * 「不 DROP / RENAME」（0002 / 0003 / 0004 文件头同一条：审计库里删掉一个查询路径的
 * 操作会让历史回放指向不存在的东西）。所以这里【不改 DDL，只把这件事写在代码旁边】：
 * 读 `im_tokens` 的人必须知道那一列装的是 sha256 十六进制，不是可用的凭据。
 * 第二个选项（新建一张列名诚实的表）更贵也更糟：那会让 im_tokens 变成一张
 * 【有 schema 无写入方】的孤儿表，而 0013 §10 那张表里已经躺着四张这种表了。
 *
 * 为什么这里用 randomBytes 而不是 randomUUID：UUIDv4 只有 **122** 位随机量
 * （其余是版本与变体位），而且它的格式鼓励人把它当「一个标识符」而不是「一个秘密」
 * 来对待 —— 具体后果是有人会把 token 打进日志（UUID 打日志是常态做法）。
 * 32 字节 base64url 长得不像标识符，这个「看着就不该打日志」的形状本身就是防护。
 *
 * ⚠ 原文【不进 URL、不进 query】。URL 会进访问日志、进代理日志、进浏览器历史，
 *   而这一层将来接飞书卡片时最容易犯的省事做法就是把票拼进按钮链接。
 *   走请求头（x-opc-approval-token）：头不进任何标准日志。
 */
export function newApprovalToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * 落库/查库用的验证子。见文件头那格「为什么库里存哈希」。
 *
 * 用 sha256 而不是 HMAC：HMAC 需要一个密钥，而这个系统里能当密钥的东西
 * 只有那个**刻意不落盘**的桌面 token（auth.ts），拿它当 pepper 会把两个本来独立的
 * 东西焊在一起 —— 于是「重启换一个桌面 token」会**让所有已签发的远程票同时失效**，
 * 而那不是任何人想要的行为。纯哈希在这里够，因为输入是高熵的（见文件头算法那格）。
 */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * 拒绝理由。**测试钉这一维，不钉文案。**
 *
 * ⚠ 【加一个成员 = 必须去 app.ts 的 tokenHttpStatus 登记一个状态码】，
 * 而那一格是【编译期】催的：它对本联合做 switch + `const impossible: never` 赋值，
 * 漏一支就编译不过（同一个手法见 app.ts 里 Route 那个 switch）。
 * 为什么值得让编译器管：唯一的分歧是 401 与 403 那一条，而它是【产品】判断 ——
 * 401 的修法是「把凭据弄对」，403 的修法是「换个地方点」。
 * 【规格】§11.4 那句「不可逆不许在远程批」若被翻成 401，
 * 症状是 CEO 在手机上反复重签 token 而永远批不掉。
 * 一张「靠人记得去改」的表挡不住这种漏；switch 挡得住。
 */
export type TokenRejectReason =
  /** 库里没有这个验证子：没签过、或者已经被删过、或者来自另一个库的备份。 */
  | "unknown_token"
  /** 有记录但 expires_at 已过。与 used 分开是因为修法不同：过期该重签，用过该看结果。 */
  | "expired"
  /** 用过。这一条与 unknown 分开是有意的：「有人拿着别人用过的票」是一个要能查到的事件。 */
  | "already_used"
  /** 【规格】§11.4：不可逆操作不许在远程完成。 */
  | "irreversible_denied"
  /** 票指向的卡片不存在，或者已经不是 pending（被别人点了 / 被超时器处理了）。 */
  | "approval_not_pending"
  /** 传进来的 approvalId 与票上绑定的那张不一致（防止拿 A 的票去批 B）。 */
  | "approval_mismatch";

export type RedeemResult =
  | {
      readonly ok: true;
      /** 这张票绑的那张卡。调用方拿它去走**同一条**决策路径。 */
      readonly approvalId: string;
      readonly taskId: string;
      /** 烧票那一刻的审计游标。调用方必须把它 publish 出去，理由见 burn 的注释。 */
      readonly seq: number;
      /**
       * 与 seq 那行 events 的 payload **同一个对象**。调用方 publish 的就是它。
       *
       * 为什么把事件交回调用方而不是只给一个 seq：seq 是 events.id，
       * 而 events.id 就是 SSE 的游标（bus.ts 文件头）。给了 seq 而不给事件，
       * 调用方只能自己现造一条 —— 那时【库里那一行的 payload】与【推给前端的那一条】
       * 是两个分别构造的对象，它们会漂移，而漂移的方向是「前端显示的那件事库里查不到」。
       * 交回同一个对象，两件事在类型上就只有一个来源。
       */
      readonly event: ApprovalTokenRedeemedEvent;
    }
  | { readonly ok: false; readonly reason: TokenRejectReason };

/**
 * 烧票那条审计的事件形状。从 DomainEvent 里 Extract 而不是自己写一份：
 * 自己写的那份在 bus.ts 加字段时会【静默不匹配】（本模块照样编译过，而事件少一个键）。
 * 同一个手法见 cards.ts 的 ApprovalRequiredEvent。
 */
export type ApprovalTokenRedeemedEvent = Extract<
  DomainEvent,
  { readonly kind: "ApprovalTokenRedeemed" }
>;

/**
 * 插入一张待使用的票。**在调用方的事务里**执行（收 db 而不是 Writer），
 * 因为签发要能与「建卡」同事务 —— 一张配不上任何卡片的孤儿票、
 * 或一张配不上票的卡片，两者都不是能靠重试修好的形状。
 *
 * `approvalId` 必须已存在：approvals.id 上没有指向 im_tokens 的外键，
 * 而 im_tokens.approval_id 也没声明 FK（0001 那张表是 `NOT NULL` 但没有 REFERENCES，
 * 实测过：见 tokens 的测试）。所以「票指向一张不存在的卡」这句话**数据库不挡**，
 * 只能靠这里的预检。这一发预检**不是**多余的：
 * 它挡的是「先签票、卡片后来没建成」，那种票 redeem 时会走
 * approval_not_pending，症状是「点了没反应」，而根因在很久之前那次签发。
 */
export const INSERT_TOKEN_SQL =
  "INSERT INTO im_tokens (token, approval_id, expires_at, used) VALUES (?, ?, ?, ?)";

export function issueToken(
  db: DatabaseSync,
  o: {
    readonly rawToken: string;
    readonly approvalId: string;
    readonly nowMs: number;
    readonly ttlMs?: number;
  },
): { readonly expiresAt: number } {
  const approval = db
    .prepare("SELECT id FROM approvals WHERE id = ?")
    .get(o.approvalId) as { id: string } | undefined;
  if (approval === undefined) {
    // 抛而不是返回一个 {ok:false}：签发方此刻正在一个事务里建卡，
    // 一个「悄悄没签成」的返回值会被当成成功，然后远程端拿到一张指向不存在的卡的票。
    throw new Error(
      "签发审批 token 失败：卡片 " + o.approvalId + " 不存在。" +
        "im_tokens.approval_id 上没有外键（0001 那张表没写 REFERENCES），" +
        "所以这件事数据库挡不住，只能在这里挡。",
    );
  }
  const ttl = o.ttlMs ?? DEFAULT_TOKEN_TTL_MS;
  // 与 cards.ts 的 timeoutAtMs 同一条判据：NaN / 负数都要响。
  // 「TTL 算错了」与「没有设 TTL」在库里长得一样（都是一个数或 NULL），而前者
  // 会让一张票的有效期变成【任意】—— 一个静默放宽安全边界的形状。
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new Error("token 的 ttlMs 必须是正有限数，实到 " + String(ttl));
  }
  const expiresAt = o.nowMs + ttl;
  const params = [hashToken(o.rawToken), o.approvalId, expiresAt, TOKEN_UNUSED];
  assertSingleStatement(INSERT_TOKEN_SQL);
  assertParamCount(INSERT_TOKEN_SQL, params);
  db.prepare(INSERT_TOKEN_SQL).run(...(params as never[]));
  return { expiresAt };
}

/**
 * 条件烧票。**这个 UPDATE 是幂等承重的地方**，形状与 CLAIM_APPROVAL_SQL 同一条：
 * 判据压进 WHERE，而不是先 SELECT 再 UPDATE。
 *
 * 为什么不先查再改：两次并发 redeem 里，两边都可能查到 used=0，
 * 于是两张票都被「用掉」。而这里的后果不是重复写入（真正的写入在调用方那边，
 * 它有自己那条条件 UPDATE 挡着），是**两次 redeem 都返回 ok:true** ——
 * 调用方会以为「这张票被用了两次而两次都成功」，那正是审计里最难解释的一种形状。
 * 压进 WHERE 之后 changes===0 这一支在**返回 ok 之前**就把第二次挡掉。
 *
 * 顺序（为什么先判票、后判卡）：先烧票，卡片那一侧的判定失败时票已经烧了。
 * 这是**故意的**，见文件头那格「先烧票，后决策」。
 */
export const BURN_TOKEN_SQL =
  "UPDATE im_tokens SET used = ? WHERE token = ? AND used = ? AND expires_at > ?";

export function redeemToken(
  db: DatabaseSync,
  o: {
    readonly rawToken: string;
    readonly nowMs: number;
    /**
     * 期望批的那张卡。**传了就必须与票上绑的一致**，不传则用票上那张。
     * 为什么两档都要：远程端「点批准」时通常知道自己点的是哪张卡（卡片 id 在它手上），
     * 那种时候不比对就等于允许**拿 A 的票去批 B** —— 一个票只值一张卡的基本原则。
     * 而有些通道（回调里只回传一个 opaque 串）确实不知道 id，那种就退回票上那一张。
     */
    readonly expectedApprovalId?: string;
  },
): RedeemResult {
  const hash = hashToken(o.rawToken);
  const row = db
    .prepare(
      "SELECT t.approval_id AS approval_id, t.expires_at AS expires_at, " +
        "t.used AS used, a.task_id AS task_id, a.status AS status, " +
        "a.approval_type AS approval_type, a.parameters AS parameters " +
        "FROM im_tokens t LEFT JOIN approvals a ON a.id = t.approval_id " +
        "WHERE t.token = ?",
    )
    .get(hash) as
    | {
        approval_id: string;
        expires_at: number;
        used: number;
        task_id: string | null;
        status: string | null;
        approval_type: string | null;
        parameters: string | null;
      }
    | undefined;

  if (row === undefined) return { ok: false, reason: "unknown_token" };
  // 过期判在「用过」之前还是之后？过期在前。理由：一张【既过期又用过】的票，
  // 报 expired 的修法（重签）是对的，报 already_used 的修法（去看结果）是错的 ——
  // 它过期了，那张卡可能早就被别的路径处理完或者超时了，「去看结果」把人支去查一件无关的事。
  if (Number(row.expires_at) <= o.nowMs) return { ok: false, reason: "expired" };
  if (Number(row.used) !== TOKEN_UNUSED) return { ok: false, reason: "already_used" };

  if (o.expectedApprovalId !== undefined && o.expectedApprovalId !== row.approval_id) {
    // 这一发【不烧票】：一张用错了地方的票不该被消耗掉，
    // 否则「在手机上点错了卡片」会连带把那张卡的正经批准机会一起烧掉。
    return { ok: false, reason: "approval_mismatch" };
  }
  if (row.task_id === null || row.status !== APPROVAL_STATUS_PENDING) {
    return { ok: false, reason: "approval_not_pending" };
  }
  // 【规格】§11.4 那条硬约束。判不出算不可逆（见文件头）。
  if (isIrreversibleApproval(row.approval_type, row.parameters)) {
    return { ok: false, reason: "irreversible_denied" };
  }

  const params: unknown[] = [
    TOKEN_USED,
    hash,
    TOKEN_UNUSED,
    o.nowMs, // 这一发同时兜住「读到 expires_at 之后、写之前又过了一刻」的窗口
  ];
  assertSingleStatement(BURN_TOKEN_SQL);
  assertParamCount(BURN_TOKEN_SQL, params);
  const info = db.prepare(BURN_TOKEN_SQL).run(...(params as never[])) as {
    changes: number | bigint;
  };
  if (Number(info.changes) === 0) {
    // 查到没用过、写下时已被别人用掉。判成 already_used 而不是新造一个 reason：
    // 对调用方来说这两种的修法完全一样（「这张票已经不能用了」）。
    return { ok: false, reason: "already_used" };
  }

  // 烧票要留痕。它不是一次读，它是一次**状态变更**：
  // 「这张票在什么时候被用掉了」是日后回答「那次批准是谁发起的」的唯一线索，
  // 而 im_tokens 那张表只有 used=0/1 一个 bit，**没有时间戳**（0001 那列就没有）。
  // 所以时刻只能落在审计里。
  const event: ApprovalTokenRedeemedEvent = {
    kind: "ApprovalTokenRedeemed",
    taskId: row.task_id,
    interruptId: row.approval_id,
  };
  const seq = appendAudit(
    db,
    {
      taskId: row.task_id,
      actorType: "system",
      // actorId 用 "approval-token" 而不是 CEO：这一发记录的是【凭据被消费】这件事，
      // 不是【谁做了决定】—— 后者由紧随其后的那条 approval 审计承担
      // （那条的 actor 是 human/ceo）。把两件事写成同一个 actor，
      // 回放时分不出「有人点了批准」与「有人验了一张票」。
      actorId: TOKEN_AUDIT_ACTOR,
      action: "approval",
      target: row.approval_id,
      // payload 就是上面那个 event —— 不是「另造一个形状差不多的对象」。
      // 这一行与推给前端的那一条必须是同一个对象，否则两边漂移时
      // 前端显示的那件事在库里查不到（见 RedeemResult.event 的注释）。
      payload: event,
      createdAt: o.nowMs,
    },
    () => o.nowMs,
  );

  return { ok: true, approvalId: row.approval_id, taskId: row.task_id, seq, event };
}

/**
 * 烧票那行审计的署名。**不是任何人的 id**。
 *
 * 为什么不能用 "hub"：那是建卡方（cards.ts 的 createCard）用的署名，
 * 而 role-memory 取回候选行的条件是「署名 **或** 任务归属」那个 OR
 * （0026 §5 量过的那次翻案就是从这个 OR 长出来的）。用 "hub" 会让这一行
 * 在【每一次】按署名查的统计里与建卡行混在一起。
 * 换一个没人用的 id，代价只是多一个常量，换来的是「这条审计是谁写的」在库里可读。
 */
export const TOKEN_AUDIT_ACTOR = "approval-token";

/**
 * 这张卡是不是【不可逆】，即能不能在远程批准（【规格】§11.4）。
 *
 * 三条判据，最后一条是 fail-closed 的那条，也是这一发存在的全部理由：
 *  ① approval_type === "irreversible_action" —— 显式标记。
 *  ② parameters.irreversible === true —— 卡片自己声明。
 *     为什么两条都要：①是「这张卡的【主题】是不可逆动作」，②是「这次动作**恰好**
 *     不可逆」。一张 budget_override 的卡可以带 irreversible:true，
 *     只判①会放过它（0026 §2 那个「一个通用值 + 自由 reason 维度」的决定直接导致
 *     类型这一维不够用，那是那次决定该付的代价，在这里付）。
 *  ③ parameters 不是合法 JSON、或者不是一个对象 ⇒ **算不可逆**。
 *     方向必须是这样，因为「解析不出来」的卡片在库里长得和「没带标记」不一样，
 *     而我们没有任何别的办法知道它到底可不可逆。判成可逆 = 一条脏 JSON
 *     恰好给最危险的那张卡开出远程通道，且**零报错**。
 *
 * ⚠ 这一发**不看** approvals.timeout_behavior。有一版想拿「有没有超时默认」当可逆的
 *   代理指标（§11.4 原文确实写着「IM 只处理可逆的、**有超时默认行为的**审批」），
 *   那是错的：timeout_behavior 是【超时之后怎么办】，与【这个动作能不能撤销】
 *   两件事毫无关系 —— 一张 auto_reject 的不可逆动作卡照样是 auto_reject。
 *   把那一句读成判据会得到「标了超时行为的卡一律放行」。
 *   规格那句话说的是两个必要条件，不是把后者当前者的定义。
 */
export function isIrreversibleApproval(
  approvalType: string | null,
  parametersJson: string | null,
): boolean {
  if (approvalType === "irreversible_action") return true;
  if (parametersJson === null || parametersJson.trim() === "") return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(parametersJson);
  } catch {
    return true;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return true;
  const flag = (parsed as Record<string, unknown>)["irreversible"];
  // 【只认真 true】。这里刻意宽松一档（"true" 字符串、1 都不算）是**不安全方向**的
  // 选择，必须说明为什么：这一维上「误判成可逆」的代价是开出一条不该开的通道，
  // 而「误判成不可逆」的代价是让用户在桌面端多点一次。所以上面三条判据一律偏严，
  // 而到了【取值解释】这一层再偏宽只会抵消那份严 ——
  // 判据的真值表由建卡方（cards.ts 的契约要求 recommendation_is_not_decision 那种
  // 严格布尔）决定，不是由这里的猜测决定。建卡方写不出非布尔的 irreversible，
  // 因为它过的是 zod 的 .strict()；这里的 true 判的是【真值】而不是【存在性】。
  return flag === true;
}

/**
 * 签票【之前】就该知道的拒绝理由。与 TokenRejectReason【分开两份】，不是偷懒：
 *
 * 表面上它们重叠（approval_not_pending、irreversible_denied 两边都有），
 * 合成一份更短，而合成之后【状态码就定不出来】—— 同一个 approval_not_pending：
 *  · 出在 redeem 上：对方是一个【远程的持票人】，他手上只有一张 opaque 的票，
 *    准确的说法（「那张卡已经被批过了」）他无从行动，而多说的每一格都是信息；
 *    正确修法只有一条「回桌面端」⇒ 401 一句不带原因。
 *  · 出在签发上：对方是一个【已通过 HMAC 鉴权的本机主体】，他在写代码或在点界面，
 *    报 401 会把「卡片已经批过了」伪装成「你的凭据有问题」——
 *    那正是本模块反复在防的那类把人使向错误方向的报错。这里该给 409。
 * 所以分歧的不是判据，是【报错给谁看】。两份 union 各配一张状态表，写在 app.ts 里。
 */
export type TokenIssueReject =
  /** 卡片根本不存在。签发方给了一个错的 id ⇒ 404（改参数）。 */
  | "approval_missing"
  /** 卡片存在但已经不是 pending ⇒ 409（这件事已经有人做完了）。 */
  | "approval_not_pending"
  /** 【规格】§11.4：不可逆 ⇒ 403（换地方点）。 */
  | "irreversible_denied";

/**
 * 签票前的预检：这张卡【能不能】换一张远程票。
 *
 * 为什么要有这一发而不是让调用方直接 issueToken 然后处理那次抛错：
 * issueToken 里那次「卡片不存在」的抛是【编程错误的守卫】（它面向的是
 * 「先签票、卡片没建成」这种代码 bug），而「界面上点了一张已经批掉的卡」是
 * 【正常业务】，两者不能共用一条失败通道 —— 共用的话 HTTP 层只能回一个 500，
 * 而 500 讲的是「服务端坏了」，真相是「你点晚了」。
 *
 * 不可逆那一判【复用 isIrreversibleApproval】而不是在这里再写一遍：
 * 两处判据之间的时间差会让「签票时被判定可逆、redeem 时被判定不可逆」得到两种解释，
 * 而那种分歧的症状是「手机上点批准，返回一句看不懂的 401」。
 * 复用之后，签发与兑换对同一行数据必然给同一个答案。
 *
 * ⚠ 预检与随后的 INSERT 必须在【同一个事务】里（调用方的 w.node 之内）。
 * 分开写会得到「预检说行、签完发现卡片刚被批掉」—— 那个窗口是秒级的，
 * 而它的产物是一张【指向一张已决策卡片】的票，redeem 时会走 approval_not_pending，
 * 症状是「票作废了」而不是「签票时就该拒」。
 */
export function precheckIssue(
  db: DatabaseSync,
  approvalId: string,
): { readonly ok: true; readonly taskId: string } | { readonly ok: false; readonly reason: TokenIssueReject } {
  const row = db
    .prepare("SELECT task_id, status, approval_type, parameters FROM approvals WHERE id = ?")
    .get(approvalId) as
    | { task_id: string; status: string; approval_type: string; parameters: string | null }
    | undefined;
  if (row === undefined) return { ok: false, reason: "approval_missing" };
  if (row.status !== APPROVAL_STATUS_PENDING) {
    return { ok: false, reason: "approval_not_pending" };
  }
  if (isIrreversibleApproval(row.approval_type, row.parameters)) {
    return { ok: false, reason: "irreversible_denied" };
  }
  return { ok: true, taskId: row.task_id };
}

/**
 * 一张票还剩多久。**过期不删行**，所以要能算出来。
 * 返回 null 表示库里没这张票（而不是「0，已过期」）—— 这两件事在界面上
 * 该长得不一样：「链接失效，请重签」与「这不是我们发的链接」。
 */
export function tokenRemainingMs(
  db: DatabaseSync,
  rawToken: string,
  nowMs: number,
): number | null {
  const row = db
    .prepare("SELECT expires_at FROM im_tokens WHERE token = ?")
    .get(hashToken(rawToken)) as { expires_at: number } | undefined;
  if (row === undefined) return null;
  return Number(row.expires_at) - nowMs;
}
