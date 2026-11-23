/**
 * 生产入口：HTTP social 路由（http/social.ts）统一调用本服务读写会话与消息。
 *
 * 会话服务（T7）：conversations / messages / message_reads 的读写收口，
 * 消息一族【写库即广播】的实现处。
 *
 * ── 这个文件为什么存在 ──────────────────────────────────────────────
 * 0015 把表建好了，但表不会自己守住三条只有服务层守得住的判据：
 *  ① 私聊归一化（(b,a) 进来要变成 (a,b)，DDL 的 CHECK 只会炸不会掰）；
 *  ② mentions 是【解析后的结构】而不是正文的子串（契约文件头：前端不再二次解析，
 *     解析点就必须只有一个，这里）；
 *  ③ 「写了 events 那一行就必须广播」（bus.ts 文件头）——消息是 SSE 时间线的
 *     主料，写库不广播 = 前端增量流上凭空一个洞 → stale 标记 → 整页回捞全量，
 *     0010 §4 立过案的那个失效形状，在会话面上天天重演的代价最高。
 * 判据若散在 HTTP 与 IPC 两个入口，就是「同一张图，两个入口，两种答案」那族
 * 老病（roles/groups 文件头各立过一次案）。入口都调这里。
 *
 * ── bus 为什么是参数而不是构造函数 ────────────────────────────────
 * 本仓库没有 class service，全部是「纯函数 + 显式注入」（recordStalls(writer, bus, …)
 * 是官方先例，patrol.ts）。bus 走参数注入还有第二条硬理由：进程里若出现两个
 * InMemoryEventBus，就是「写进 A 库、SSE 订在 B 总线」——消息永远落库、事件永远
 * 不到，前端看到的是安静的错（serve/assemble.ts 里那段单例警告逐字说的是这件事）。
 * 参数注入让「哪条总线」在调用点上一目可见，装配收口在 assemble.ts 一处。
 *
 * ── 写面的节点边界 ────────────────────────────────────────────────
 * sendMessage / openPrivate / ensureGroupConversation / markRead 各自开
 * 【一个】w.node：校验、写行、审计在同一事务里，任何一步抛整单回滚。
 * 广播一律留在 node 之外（recordStalls 的形状）：COMMIT 之后才 publish，
 * 广播失败不能也不该回滚已提交的消息——消息存在性是事实，广播失败是投递问题，
 * 两件事在返回值上分开（broadcastError 带回来，不吞）。
 * insertCardMessage 反过来：它【不开节点】，必须被调用方在自己的
 * w.node 里调（requireScopeDb 拿调用方事务的连接）——理由写在那个函数头上。
 *
 * ── @ 提及：别名只活在解析点 ──────────────────────────────────────
 * 正文里 @老板 与 @boss 是同一个提及的两种拼写（「老板」是中文称呼习惯，
 * D16 契约给的规范值是 MENTION_BOSS="@boss"）。resolveMentions 认两种拼写，
 * 但【落库与事件里只有规范值】：升级链的触发判据是 mentions 数组里有没有
 * MENTION_BOSS（bus.ts msgKind 注释），若库里一半 "@老板" 一半 "@boss"，
 * 那个判据就要写 `m === "@boss" || m === "@老板"`——漏掉任何一侧拼写，
 * 老板被 @ 了而升级链不启动，是「事故发生了但规则没看见」里最难查的一种。
 * 别名只有一个形状：别名进解析器，规范值进一切下游。
 *
 * ── 未读的产品判断（DDL 不回答，服务层定死）──────────────────────
 *  · 系统消息与卡片消息【计入】未读：红点回答的是「有几行你没看见」，
 *    会议卡片也是时间线上的一行，「你没看过但系统替你读过了」没有产品依据；
 *    未读由 message_reads 游标推导（0015 文件头：不设计数器列），
 *    所有 kind 的消息行在游标之后一律 +1，SQL 里没有 kind 分支。
 *  · markRead 的游标【只进不退】（DO UPDATE 里 MAX 兜底）：IM 惯例，
 *    旧窗口重开不该把已读的消息重新点亮。
 *  · markRead 不写 events 行：读游标是观看者状态，不是业务事实，
 *    每翻一页都进广播日志会把真消息淹出环形缓冲（bus 默认容量 512）。
 *    没有 events 行 ⇒ 也就没有「必须广播」的问题。
 *  · markRead 省略游标 = 读到当前最新；显式游标越界 ⇒ 拒（seq_out_of_range）：
 *    「读到第 37 条」而会话只有 12 条，是客户端错位，钳位会把 bug 咽下去。
 *
 * ── 读侧守门 ──────────────────────────────────────────────────────
 * 每一条读出的行都过 conversationViewSchema / messageViewSchema safeParse
 * 再出口（groups 的 getGroupRow 同一立场）：库里数据异常，拒当合法视图。
 * messageView 的 mentions_json JSON.parse 失败同样抛；会话列表只经 json_valid
 * 兜底的 JSON1 计数，不解析正文 mentions，坏值不会拖垮整份列表。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CEO_ROLE_ID,
  type ConversationView,
  conversationViewSchema,
  listMessagesQuerySchema,
  MENTION_BOSS,
  type MessageView,
  markReadRequestSchema,
  messageViewSchema,
  sendMessageRequestSchema,
} from "@opc/contracts";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import {
  assertParamCount,
  assertSingleStatement,
  type Writer,
} from "../db/write-queue.js";
import type { DomainEvent, EventBus } from "../events/bus.js";
import { appendAudit } from "../events/recorder.js";

/**
 * 老板的读者标识：0015 message_reads.reader 注释定死「老板恒为 'boss'」。
 * 导出它是因为 listConversations / markRead 的调用方（T10 的 HTTP）传读者时
 * 要拿同一个字面量——两处各写各的 "boss"，将来谁改成 "ceo" 就裂成两个读者。
 */
export const BOSS_READER = "boss";

/** 审计署名：与 roles/groups/members 同一个「人」（§4.2.3 权集中于老板）。 */
const CONV_ACTOR = { actorType: "human", actorId: CEO_ROLE_ID } as const;

/**
 * 审计 payload.kind 的两个取值（消息族 action 恒为 "meeting"——
 * KIND_TO_ACTION.MessageReceived 的映射，十值枚举 append-only，不开第 11 值）。
 *
 * ⚠ 会话容器（conversations 行）【不写 events 行】，这是按 §0.2「写了那一行就必须
 * 广播」与实施计划 §5 那张 kind→action 表【合取】推出来的，不是漏了：
 * §5 表（recorder.ts KIND_TO_ACTION 的规范源）没有给会话容器配任何 kind，
 * 于是容器留痕只剩两条路——写 events 行（必配广播，可没有 kind 可广播，
 * 硬塞 GroupUpdated 对私聊是伪造：私聊没有 group），或不写行。
 * 选了不写。审计要答的「这条会话哪来的」在别处有答案：群会话的出生记在
 * groups/service createGroup 的 group_created 审计 payload（里面有 conversation_id），
 * 出生时刻在 conversations.created_at 列；私聊的开线是阅读视图的展开而不是业务动作，
 * 它的「存在」由紧随的第一条 MessageReceived 钉进时间线。
 * 真哪天要审计「谁开的私聊」，先回 §5 表补 kind（MeetingOpened/MeetingCancelled
 * 的补票先例在 bus.ts），再回来在这里加行——顺序不能反。
 */
export const CONVERSATION_AUDIT_KINDS = [
  "message_posted",
  "card_posted",
] as const;
export type ConversationAuditKind = (typeof CONVERSATION_AUDIT_KINDS)[number];

/**
 * 服务层自己造的错误码（code 说资源事实，状态码取决于它是路径参数还是
 * 请求体引用——GroupServiceCode 立的规矩）：
 *  · conversation_not_found —— 路径里的会话不存在（404）；
 *  · group_not_found —— 建会话时路径里的群不存在（路径参数 ⇒ 404）；
 *  · bad_body / bad_query / reply_not_found / seq_out_of_range / self_chat /
 *    member_not_found / member_archived / not_participant / bad_ref ——
 *    请求体与查询串的语义拒绝（422）。bad_body 存在是因为服务不信任调用方
 *    已验（HTTP 之外还有 IPC/MCP 入口）：空文与超长文必须在【写之前】拦下，
 *    契约 safeParse 不过 ⇒ 库里一条消息、一行 events 都不许多写；
 *  · self_chat —— openPrivateRequestSchema 的 superRefine 同样拒它，但那是
 *    HTTP 入口的闸；服务层不依赖调用方先过 zod——非 HTTP 调用方拿到的必须是
 *    服务错误对象，不是裸 ZodError（那是把校验库的形状漏进业务契约）；
 *  · member_archived —— 「不进新」：归档 = 离任，离任的人不能发【新】消息，
 *    历史消息仍归他；
 *  · not_writable —— 兜底（500）。
 */
export type ConversationServiceCode =
  | "conversation_not_found"
  | "group_not_found"
  | "bad_body"
  | "bad_query"
  | "reply_not_found"
  | "seq_out_of_range"
  | "self_chat"
  | "member_not_found"
  | "member_archived"
  | "not_participant"
  | "bad_ref"
  | "not_writable";

export type ConversationServiceError = {
  readonly ok: false;
  readonly reason: string;
  readonly code: ConversationServiceCode;
};

/** code → HTTP 状态码原料（与 roleServiceStatus / groupServiceStatus 同一用法）。 */
export function conversationServiceStatus(
  code: ConversationServiceCode,
): number {
  switch (code) {
    case "conversation_not_found":
    case "group_not_found":
      return 404;
    case "not_writable":
      return 500;
    default:
      return 422;
  }
}

function err(
  code: ConversationServiceCode,
  reason: string,
): ConversationServiceError {
  return { ok: false, reason, code };
}

type DbLike = Pick<DatabaseSync, "prepare">;

// ── SQL 常量（导出给守卫与 T10 复用；口径只许有一份）────────────────

/** 私聊键的读取方永远拿归一化后的对：查 (b,a) 查不到是【应当】的，归一在写入侧。 */
const CONV_PAIR_SQL =
  "SELECT conversation_id FROM conversations" +
  " WHERE kind = 'private' AND member_a = ? AND member_b = ?";

const CONV_GROUP_SQL =
  "SELECT conversation_id FROM conversations WHERE kind = 'group' AND group_id = ?";

const INSERT_CONV_SQL =
  "INSERT INTO conversations (conversation_id, kind, group_id, member_a, member_b, title, created_at)" +
  " VALUES (?, ?, ?, ?, ?, ?, ?)";

const GROUP_TITLE_SQL = "SELECT title FROM groups WHERE group_id = ?";

const MEMBER_NAME_STATUS_SQL =
  "SELECT name, status FROM members WHERE member_id = ?";

const CONV_KIND_SQL =
  "SELECT kind, group_id, member_a, member_b FROM conversations WHERE conversation_id = ?";

/**
 * 会话视图列（unread / boss_attention / preview 都是相关子查询现算）。
 *  · unread 走 message_reads 游标：0015 文件头立的「不设计数器列」在这里兑现——
 *    游标缺行按 0（COALESCE），即「没读过 = 全没读」；
 *  · boss_attention 与 unread 共用同一游标表达式，只数 mentions_json 数组含
 *    MENTION_BOSS 的消息；EXISTS 保证同一消息出现多个 @boss 也只计 1；
 *  · json_valid 与数组形状检查在 json_each 之前用 CASE 兜底：脏 mentions_json
 *    仍计入 unread，但不让整份会话列表因 JSON1 解析坏值而抛错；
 *  · preview 截 60 个字符：三栏列表里 preview 只有一行宽。substr 在 SQLite
 *    里按【字符】数（不是字节），中文 preview 不会被腰斩成乱码；
 *  · last_message_at 用第二个子查询而不是复用 preview 的行：SQLite 的标量子查询
 *    不能一行返回两列，两个 LIMIT 1 子查询都吃 idx_messages_conv_seq，读面够用。
 */
const CONV_READ_CURSOR_SQL =
  "COALESCE((SELECT r.last_seq_in_conv FROM message_reads r" +
  " WHERE r.conversation_id = c.conversation_id AND r.reader = ?), 0)";

const CONV_VIEW_COLS =
  "c.conversation_id, c.kind, c.group_id, c.member_a, c.member_b, c.title, c.created_at," +
  " (SELECT COUNT(*) FROM messages m" +
  "   WHERE m.conversation_id = c.conversation_id AND m.seq_in_conv >" +
  "   " +
  CONV_READ_CURSOR_SQL +
  ") AS unread_count," +
  " (SELECT COUNT(*) FROM messages m4" +
  "   WHERE m4.conversation_id = c.conversation_id AND m4.seq_in_conv >" +
  "   " +
  CONV_READ_CURSOR_SQL +
  "   AND EXISTS (SELECT 1 FROM json_each(" +
  "     CASE WHEN json_valid(m4.mentions_json)" +
  "       THEN CASE WHEN json_type(m4.mentions_json) = 'array'" +
  "         THEN m4.mentions_json ELSE '[]' END" +
  "       ELSE '[]' END) mention" +
  "     WHERE mention.value = ?)) AS boss_attention_count," +
  " (SELECT substr(m2.body, 1, 60) FROM messages m2" +
  "   WHERE m2.conversation_id = c.conversation_id" +
  "   ORDER BY m2.seq_in_conv DESC LIMIT 1) AS last_message_preview," +
  " (SELECT m3.created_at FROM messages m3" +
  "   WHERE m3.conversation_id = c.conversation_id" +
  "   ORDER BY m3.seq_in_conv DESC LIMIT 1) AS last_message_at";

/** 全量列表：老板看全部，成员看「自己的私聊 + 落了席的群会话」。 */
const LIST_CONVS_SQL =
  `SELECT ${CONV_VIEW_COLS} FROM conversations c` +
  " WHERE (? = 'boss' OR c.member_a = ? OR c.member_b = ?" +
  "   OR EXISTS (SELECT 1 FROM group_members gm" +
  "    WHERE gm.group_id = c.group_id AND gm.member_id = ?))" +
  " ORDER BY COALESCE(last_message_at, c.created_at) DESC, c.conversation_id";

/** 单会话视图：reader 由调用方给（私聊用 member_a，群会话用 BOSS_READER）。 */
const CONV_VIEW_SQL = `SELECT ${CONV_VIEW_COLS} FROM conversations c WHERE c.conversation_id = ?`;

const MSG_VIEW_COLS =
  "message_id, conversation_id, sender_member_id, author_kind, body," +
  " mentions_json, reply_to, kind, seq_in_conv, created_at";

const MSG_ROW_SQL = `SELECT ${MSG_VIEW_COLS} FROM messages WHERE message_id = ?`;

/** before_seq 游标往旧翻；limit 由契约把界（1..200）。 */
const LIST_MSGS_SQL =
  `SELECT ${MSG_VIEW_COLS} FROM messages` +
  " WHERE conversation_id = ? AND (? IS NULL OR seq_in_conv < ?)" +
  " ORDER BY seq_in_conv DESC LIMIT ?";

const REPLY_CONV_SQL =
  "SELECT conversation_id FROM messages WHERE message_id = ?";

/** 会话内取号：MAX+1。撞号不是没可能而是必撞（并发取号），所以有 unique 索引兜底。 */
const NEXT_SEQ_SQL =
  "SELECT COALESCE(MAX(seq_in_conv), 0) + 1 AS next FROM messages WHERE conversation_id = ?";

const MAX_SEQ_SQL =
  "SELECT COALESCE(MAX(seq_in_conv), 0) AS max FROM messages WHERE conversation_id = ?";

const INSERT_MESSAGE_SQL =
  "INSERT INTO messages (message_id, conversation_id, sender_member_id, author_kind," +
  " body, mentions_json, reply_to, kind, seq_in_conv, created_at)" +
  " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

/** 卡片专用：带 ref_id（0023）。文本消息的 INSERT 不列 ref_id ⇒ 恒 NULL，两条 SQL 各守一形。 */
const INSERT_CARD_SQL =
  "INSERT INTO messages (message_id, conversation_id, sender_member_id, author_kind," +
  " body, mentions_json, reply_to, kind, seq_in_conv, created_at, ref_id)" +
  " VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)";

/**
 * 卡片 ref 的三张父表。REFERENCES 写不出来（一列三个爹，见 0023 文件头），
 * 存在性判据就在这里：kind → 表名 + 主键列，缺任何一个 ⇒ 插卡被拒。
 */
const CARD_REF_TABLES: Record<
  "meeting_card" | "backlog_card" | "doc_card",
  { readonly table: string; readonly pk: string }
> = {
  meeting_card: { table: "meetings", pk: "id" },
  backlog_card: { table: "backlog_items", pk: "id" },
  doc_card: { table: "documents", pk: "doc_id" },
};

const SEAT_MEMBERS_SQL =
  "SELECT gm.member_id AS member_id, m.name AS name FROM group_members gm" +
  " JOIN members m ON m.member_id = gm.member_id" +
  " WHERE gm.group_id = ? ORDER BY gm.member_id";

const PAIR_MEMBER_SQL = "SELECT name, status FROM members WHERE member_id = ?";

/** 游标只进不退：MAX(旧, 新) 兜底，旧窗口重开不会把已读重新点亮。 */
const UPSERT_READ_SQL =
  "INSERT INTO message_reads (conversation_id, reader, last_seq_in_conv, read_at)" +
  " VALUES (?, ?, ?, ?)" +
  " ON CONFLICT(conversation_id, reader) DO UPDATE SET" +
  " last_seq_in_conv = MAX(message_reads.last_seq_in_conv, excluded.last_seq_in_conv)," +
  " read_at = excluded.read_at";

const READ_CURSOR_SQL =
  "SELECT last_seq_in_conv FROM message_reads WHERE conversation_id = ? AND reader = ?";

// ── 视图重建（读侧守门）──────────────────────────────────────────

/** mentions_json → string[]：坏 JSON 与坏形状同罪，抛，不静默给 []。 */
function parseMentions(messageId: string, raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      "conversations/service：消息 [" +
        messageId +
        "] 的 mentions_json 不是合法 JSON —— 库里数据异常，拒当合法视图： " +
        (e as Error).message,
    );
  }
  if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== "string")) {
    throw new Error(
      "conversations/service：消息 [" +
        messageId +
        "] 的 mentions_json 不是字符串数组 —— 库里数据异常，拒当合法视图。",
    );
  }
  return parsed as string[];
}

function rowToMessageView(row: Record<string, unknown>): MessageView {
  const messageId = String(row["message_id"]);
  const { mentions_json: mentionsJson, ...rest } = row;
  const candidate = {
    ...rest,
    mentions: parseMentions(
      messageId,
      typeof mentionsJson === "string" ? mentionsJson : "null",
    ),
  };
  const parsed = messageViewSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      "conversations/service：消息 [" +
        messageId +
        "] 行存在但形状坏（messageViewSchema 不过）——库里数据异常，拒当合法视图： " +
        parsed.error.issues[0]?.message,
    );
  }
  return parsed.data;
}

function getMessageRow(
  db: DbLike,
  conversationId: string,
  messageId: string,
): MessageView | undefined {
  assertSingleStatement(MSG_ROW_SQL);
  const params: unknown[] = [messageId];
  assertParamCount(MSG_ROW_SQL, params);
  const row = db.prepare(MSG_ROW_SQL).get(...(params as never[])) as
    | Record<string, unknown>
    | undefined;
  if (row === undefined) return undefined;
  // 跨会话读取一律算「读不到」：message_id 是全局的，但视图的会话上下文不能串。
  if (row["conversation_id"] !== conversationId) return undefined;
  return rowToMessageView(row);
}

/** 事务内不变量：行必须刚被本事务写过，读不到/形状坏 ⇒ 抛（回滚整单），不给 undefined。 */
function mustMessage(
  db: DbLike,
  conversationId: string,
  messageId: string,
): MessageView {
  const view = getMessageRow(db, conversationId, messageId);
  if (view === undefined) {
    throw new Error(
      "conversations/service：刚写完消息 [" +
        messageId +
        "] 却读不回来 —— 事务内不变量被破坏，整单回滚。",
    );
  }
  return view;
}

function conversationViewFor(
  db: DbLike,
  conversationId: string,
  reader: string,
): ConversationView {
  assertSingleStatement(CONV_VIEW_SQL);
  const params: unknown[] = [reader, reader, MENTION_BOSS, conversationId];
  assertParamCount(CONV_VIEW_SQL, params);
  const row = db.prepare(CONV_VIEW_SQL).get(...(params as never[])) as
    | Record<string, unknown>
    | undefined;
  if (row === undefined) {
    throw new Error(
      "conversations/service：会话 [" +
        conversationId +
        "] 不存在却继续渲染 —— 前端会拿 undefined 的未读数。",
    );
  }
  const parsed = conversationViewSchema.safeParse(row);
  if (!parsed.success) {
    throw new Error(
      "conversations/service：会话 [" +
        conversationId +
        "] 行存在但形状坏（conversationViewSchema 不过）——库里数据异常，拒当合法视图： " +
        parsed.error.issues[0]?.message,
    );
  }
  return parsed.data;
}

// ── @ 提及解析（纯函数，导出给测试与守卫）────────────────────────

/** 可被 @ 的成员（解析点只需要这两个字段，不搬整行 member）。 */
export type MentionTarget = {
  readonly memberId: string;
  readonly name: string;
};

/**
 * 老板提及的全部拼写：规范值 @boss 去掉 @ 是 "boss"，中文别名 "老板"。
 * 【别名只活在解析点】——resolveMentions 的输出、mentions_json、事件载荷里
 * 只会出现 MENTION_BOSS。为什么必须这样：D16 升级链的入口判据是
 * 「mentions 数组含 MENTION_BOSS」（bus.ts msgKind 注释立的两值判别位），
 * 库里若同时存在 "@老板" 与 "@boss" 两种拼写，判据就变成要数清楚所有别名，
 * 漏一个拼写 = 老板被 @ 了而升级链沉默——规则没看见的事故比规则报错难查十倍。
 */
const BOSS_TOKENS = new Set(["boss", "老板"]);

/**
 * 正文里能被 @ 到的 token 形状：@ 后连续的文字/数字/下划线/连字符。
 * 按 token 切而不是按成员名「碰巧出现在正文里」找：`@张三丰` 不该命中成员
 * 「张三」——取 @ 后的整段 token 做全等比较，边界问题一次解决。
 */
const MENTION_TOKEN_RE = /@([\p{L}\p{N}_-]+)/gu;

/**
 * 解析正文中的全部 @ 提及，输出【规范值】数组（MENTION_BOSS 或 member_id）。
 *  · @老板 / @boss 都认，输出恒为 MENTION_BOSS（一次去重）；
 *  · 成员按【名字】或【member_id】全等命中；重名时按入参数组顺序取第一个
 *    （成员表没约束名字唯一，撞名是运营问题；解析器不猜，猜就是两个前端
 *      渲染出两个高亮）；
 *  · 按 token 在正文中的出现顺序输出，同一目标只出现一次；无 @ 返回空数组。
 * 纯函数：不读库、不写库，成员名单由调用方查好传入（会话成员集合是产品
 * 语义：群里 @ 的候选是坐席成员，不是全库成员）。
 */
export function resolveMentions(
  body: string,
  members: readonly MentionTarget[],
): string[] {
  const byToken = new Map<string, string>();
  for (const m of members) {
    if (!byToken.has("@" + m.name)) byToken.set("@" + m.name, m.memberId);
    if (!byToken.has("@" + m.memberId))
      byToken.set("@" + m.memberId, m.memberId);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(MENTION_TOKEN_RE)) {
    const token = match[1];
    if (token === undefined) continue;
    const canonical = BOSS_TOKENS.has(token)
      ? MENTION_BOSS
      : byToken.get("@" + token);
    if (canonical === undefined) continue;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

// ── 返回形状 ─────────────────────────────────────────────────────

export type EnsureConversationResult =
  | {
      readonly ok: true;
      readonly conversation: ConversationView;
      /** false = 会话早已存在，本次什么都没写。容器不写 events（§5 kind 表无容器项，写行必配广播而无可广播的 kind，见 CONVERSATION_AUDIT_KINDS 注释）。 */
      readonly created: boolean;
    }
  | ConversationServiceError;

export type OpenPrivateResult = EnsureConversationResult;

export type SendMessageResult =
  | {
      readonly ok: true;
      readonly message: MessageView;
      /** 群消息的所属群；私聊为 null。CoS 派发与界面路由共用这个事实。 */
      readonly group_id: string | null;
      /** D16 入口判别位：mentions 含 MENTION_BOSS ⇒ "mention_boss"（bus.ts msgKind）。 */
      readonly msgKind: "message" | "mention_boss";
      readonly auditSeq: number;
      /**
       * 消息已提交，但事件投递失败。为什么不翻 ok：
       * 消息存在是事实，广播失败是投递问题（recordStalls 把失败带回来
       * 而不是吞掉、也不用失败改写「写成功」这个事实，同一立场）。
       * exactOptionalPropertyTypes ⇒ 只在真有错时带这个键。
       */
      readonly broadcastError?: string;
    }
  | ConversationServiceError;

export type MarkReadResult =
  | {
      readonly ok: true;
      readonly conversation_id: string;
      readonly reader: string;
      /** 游标只进不退：回读出的最终值（可能比请求传的更大）。 */
      readonly last_seq_in_conv: number;
      /** 读游标不写 events（文件头产品判断），恒 -1 让调用方无需分支。 */
      readonly auditSeq: -1;
    }
  | ConversationServiceError;

export type ListMessagesResult =
  | { readonly ok: true; readonly messages: MessageView[] }
  | ConversationServiceError;

/** 发言者身份：老板（人类）或成员。系统消息走 insertCardMessage，不走这里。 */
export type MessageAuthor =
  | { readonly kind: "boss" }
  | { readonly kind: "member"; readonly memberId: string };

/** 卡片消息的三种 kind（0023 ref_id 指向的就是这三张表）。 */
export type CardKind = "meeting_card" | "backlog_card" | "doc_card";

// ── 读面（只读连接上跑；db 由调用方给 queue.readConnection()）────

/**
 * 会话列表：unread_count / boss_attention_count / last_message_preview /
 * last_message_at 全部在 SQL 里算（JS 全表数未读是把游标语义搬到应用层重做一遍——
 * 两处算法一处漂移）。boss_attention_count 对普通成员同样返回，只是 UI 仅老板消费。
 * reader 传 BOSS_READER 看全部；传 member_id 只看自己的。
 */
export function listConversations(
  db: DbLike,
  reader: string,
): ConversationView[] {
  assertSingleStatement(LIST_CONVS_SQL);
  const params: unknown[] = [
    reader,
    reader,
    MENTION_BOSS,
    reader,
    reader,
    reader,
    reader,
  ];
  assertParamCount(LIST_CONVS_SQL, params);
  const rows = db
    .prepare(LIST_CONVS_SQL)
    .all(...(params as never[])) as unknown as Record<string, unknown>[];
  return rows.map((row) => {
    const parsed = conversationViewSchema.safeParse(row);
    if (!parsed.success) {
      throw new Error(
        "conversations/service：会话行形状坏（id=" +
          String(row["conversation_id"]) +
          "）——拒当合法视图： " +
          parsed.error.issues[0]?.message,
      );
    }
    return parsed.data;
  });
}

/**
 * 会话历史：before_seq 游标往旧翻，limit 由契约把界（1..200，201 在
 * safeParse 就被拒，轮不到 SQL）。页内按 DESC 取（游标语义是「最近的 N 条旧
 * 消息」）但按升序返回——前端上拉历史是 prepend，拿升序直接接在现有列表头，
 * 每个调用方自己 reverse 一遍就是四份翻页心智。
 */
export function listMessages(
  db: DbLike,
  conversationId: string,
  raw: unknown,
): ListMessagesResult {
  const parsed = listMessagesQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return err(
      "bad_query",
      "翻页参数不合契约（limit 1..200，before_seq 非负整数）——拒执行： " +
        parsed.error.issues[0]?.message,
    );
  }
  assertSingleStatement(LIST_MSGS_SQL);
  const params: unknown[] = [
    conversationId,
    parsed.data.before_seq ?? null,
    parsed.data.before_seq ?? null,
    parsed.data.limit,
  ];
  assertParamCount(LIST_MSGS_SQL, params);
  const rows = db
    .prepare(LIST_MSGS_SQL)
    .all(...(params as never[])) as unknown as Record<string, unknown>[];
  return { ok: true, messages: rows.map(rowToMessageView).reverse() };
}

// ── 会话容器：取/建 ──────────────────────────────────────────────

/** 节点内共用：按 kind 取既有会话 id，取不到返回 undefined（不抛——幂等入口靠它判存在）。 */
function findConversation(
  db: DbLike,
  sql: string,
  params: unknown[],
): string | undefined {
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  const row = db.prepare(sql).get(...(params as never[])) as
    | { conversation_id: string }
    | undefined;
  return row?.conversation_id;
}

/**
 * 群会话行的幂等获取/补建。
 * 正常路径下建群事务（groups/service createGroup）已顺手插好会话行，这里是
 * 防御性补网（0014 的 idx_conv_group 保证不多，保证不了不少——比如迁移前
 * 建的群）。存在 ⇒ 原样返回（created=false，什么都不写）；
 * 不存在 ⇒ 只插行、不写 events——§5 kind 表无会话容器项，写行必配广播而
 * 没有可广播的 kind（CONVERSATION_AUDIT_KINDS 那段注释量过这笔）。容器的
 * 出生去 groups 的 group_created 审计 payload（里面有 conversation_id）与
 * conversations.created_at 列查，不在 events。
 */
export async function ensureGroupConversation(
  w: Writer,
  o: {
    readonly groupId: string;
    readonly nowMs: number;
    readonly newId?: () => string;
  },
): Promise<EnsureConversationResult> {
  return w.node(() => {
    const db = requireScopeDb("ensureGroupConversation");
    const existing = findConversation(db, CONV_GROUP_SQL, [o.groupId]);
    if (existing !== undefined) {
      return {
        ok: true,
        conversation: conversationViewFor(db, existing, BOSS_READER),
        created: false,
      };
    }
    const titleParams: unknown[] = [o.groupId];
    assertSingleStatement(GROUP_TITLE_SQL);
    assertParamCount(GROUP_TITLE_SQL, titleParams);
    const g = db.prepare(GROUP_TITLE_SQL).get(...(titleParams as never[])) as
      | { title: string }
      | undefined;
    if (g === undefined) {
      return err(
        "group_not_found",
        "群 [" + o.groupId + "] 不存在，补建不了它的会话。整单未写。",
      );
    }
    const conversationId = o.newId?.() ?? randomUUID();
    const params: unknown[] = [
      conversationId,
      "group",
      o.groupId,
      null,
      null,
      g.title,
      o.nowMs,
    ];
    assertSingleStatement(INSERT_CONV_SQL);
    assertParamCount(INSERT_CONV_SQL, params);
    db.prepare(INSERT_CONV_SQL).run(...(params as never[]));
    return {
      ok: true,
      conversation: conversationViewFor(db, conversationId, BOSS_READER),
      created: true,
    };
  });
}

/**
 * 私聊幂等打开（D5：同两人恒同一条会话，跨群可读）。
 * 归一化在【这里】做而不是指望调用方传对：member_a 恒字典序小者是 DDL CHECK
 * 与 idx_conv_pair 部分唯一索引的共同前提。归一在写入侧 ⇒ 查询侧永远只用
 * 一种拼法；若归一散在各调用点，(b,a) 会查不到既有会话而尝试插 (b,a)，
 * 撞 CHECK 之前先制造的是「看起来开了两条私聊」的窗口。
 * 自己和自己：契约 superRefine 在 HTTP 入口挡，服务层再挡一次（self_chat）——
 * 非 HTTP 调用方不该拿到裸 ZodError。'boss' 是保留参与者，不查 members。
 * reader 默认老板；成员调用方显式传自己的 member_id，未读数才按本人游标计算。
 */
type PrivateParticipant =
  | { readonly ok: true; readonly name: string }
  | ConversationServiceError;

function resolvePrivateParticipant(
  db: DbLike,
  participantId: string,
): PrivateParticipant {
  if (participantId === BOSS_READER) {
    return { ok: true, name: "老板" };
  }
  const params: unknown[] = [participantId];
  assertSingleStatement(MEMBER_NAME_STATUS_SQL);
  assertParamCount(MEMBER_NAME_STATUS_SQL, params);
  const member = db
    .prepare(MEMBER_NAME_STATUS_SQL)
    .get(...(params as never[])) as
    | { name: string; status: string }
    | undefined;
  if (member === undefined) {
    return err(
      "member_not_found",
      "成员 [" + participantId + "] 不存在，开不了私聊。整单未写。",
    );
  }
  if (member.status !== "active") {
    return err(
      "member_archived",
      "成员 [" + participantId + "] 已归档（离任），不能开私聊。整单未写。",
    );
  }
  return { ok: true, name: member.name };
}

export async function openPrivate(
  w: Writer,
  o: {
    readonly memberA: string;
    readonly memberB: string;
    readonly nowMs: number;
    readonly newId?: () => string;
    /** 省略按老板视角渲染；成员调用方传自己的 member_id。 */
    readonly reader?: string;
  },
): Promise<OpenPrivateResult> {
  if (o.memberA === o.memberB) {
    return err(
      "self_chat",
      "不能和自己开私聊：私聊的定义是两个人（D5）。两个参数 [" +
        o.memberA +
        "] 相同。",
    );
  }
  const [a, b] =
    o.memberA < o.memberB ? [o.memberA, o.memberB] : [o.memberB, o.memberA];
  return w.node(() => {
    const db = requireScopeDb("openPrivate");
    // 先校验再查既有会话：归档成员不能借「会话已存在」重新开线。
    const participantA = resolvePrivateParticipant(db, a);
    if (!participantA.ok) return participantA;
    const participantB = resolvePrivateParticipant(db, b);
    if (!participantB.ok) return participantB;
    const reader = o.reader ?? BOSS_READER;
    const existing = findConversation(db, CONV_PAIR_SQL, [a, b]);
    if (existing !== undefined) {
      return {
        ok: true,
        conversation: conversationViewFor(db, existing, reader),
        created: false,
      };
    }
    const conversationId = o.newId?.() ?? randomUUID();
    // 标题取两人名字：老板固定显示「老板」，真实成员取 members.name。
    // 命名时刻定终身是刻意的——之后改名不回写这里（改名回写会引出「历史会话
    // 标题要不要跟着变」的产品争论，而 IM 的通行答案是标题定格在开线那一刻）。
    const params: unknown[] = [
      conversationId,
      "private",
      null,
      a,
      b,
      participantA.name + "、" + participantB.name,
      o.nowMs,
    ];
    assertSingleStatement(INSERT_CONV_SQL);
    assertParamCount(INSERT_CONV_SQL, params);
    db.prepare(INSERT_CONV_SQL).run(...(params as never[]));
    return {
      ok: true,
      conversation: conversationViewFor(db, conversationId, reader),
      created: true,
    };
  });
}

// ── 消息 ─────────────────────────────────────────────────────────

/** 节点内共用：会话存在性 + 作者身份校验，返回发消息需要的上下文。 */
type SendContext = {
  readonly groupId: string | null;
  readonly authorKind: "member" | "boss";
  readonly senderMemberId: string | null;
  readonly candidates: MentionTarget[];
};

function resolveSendContext(
  db: DbLike,
  conversationId: string,
  author: MessageAuthor,
): SendContext | ConversationServiceError {
  const convParams: unknown[] = [conversationId];
  assertSingleStatement(CONV_KIND_SQL);
  assertParamCount(CONV_KIND_SQL, convParams);
  const conv = db.prepare(CONV_KIND_SQL).get(...(convParams as never[])) as
    | {
        kind: string;
        group_id: string | null;
        member_a: string | null;
        member_b: string | null;
      }
    | undefined;
  if (conv === undefined) {
    return err(
      "conversation_not_found",
      "会话 [" + conversationId + "] 不存在。消息一条未写。",
    );
  }
  const groupId = conv.group_id;
  if (author.kind === "boss") {
    return {
      groupId,
      authorKind: "boss",
      senderMemberId: null,
      candidates: seatTargets(db, groupId, conv),
    };
  }
  const memberId = author.memberId;
  // 发言人必须在场：群 ⇒ 有席位；私聊 ⇒ 是两人之一。「旁观者发言」
  // 在任何 IM 里都不存在，放行等于把时间线的署名权交给任意 id。
  if (conv.kind === "group") {
    if (groupId === null) {
      return err(
        "not_participant",
        "会话 [" +
          conversationId +
          "] 是群会话却没了 group_id —— 库里数据异常，拒发。",
      );
    }
    const seatSql =
      "SELECT 1 AS hit FROM group_members WHERE group_id = ? AND member_id = ? LIMIT 1";
    const params: unknown[] = [groupId, memberId];
    assertSingleStatement(seatSql);
    assertParamCount(seatSql, params);
    const seat = db.prepare(seatSql).get(...(params as never[]));
    if (seat === undefined) {
      return err(
        "not_participant",
        "成员 [" +
          memberId +
          "] 不在会话 [" +
          conversationId +
          "] 的群里（没席位），拒发。",
      );
    }
  } else if (conv.member_a !== memberId && conv.member_b !== memberId) {
    return err(
      "not_participant",
      "成员 [" +
        memberId +
        "] 不是私聊 [" +
        conversationId +
        "] 的当事人，拒发。",
    );
  }
  const params: unknown[] = [memberId];
  assertSingleStatement(MEMBER_NAME_STATUS_SQL);
  assertParamCount(MEMBER_NAME_STATUS_SQL, params);
  const m = db.prepare(MEMBER_NAME_STATUS_SQL).get(...(params as never[])) as
    | { name: string; status: string }
    | undefined;
  if (m === undefined) {
    return err(
      "member_not_found",
      "成员 [" + memberId + "] 不存在（发言人查无此人），拒发。",
    );
  }
  if (m.status !== "active") {
    return err(
      "member_archived",
      "成员 [" + memberId + "] 已归档（离任），不能发新消息；历史消息仍归他。",
    );
  }
  return {
    groupId,
    authorKind: "member",
    senderMemberId: memberId,
    candidates: seatTargets(db, groupId, conv),
  };
}

/** @ 候选名单：群会话 = 全体坐席；私聊 = 两人。查不到成员行时名字退化成 id（解析器只认 name/id 两形）。 */
function seatTargets(
  db: DbLike,
  groupId: string | null,
  conv: { member_a: string | null; member_b: string | null },
): MentionTarget[] {
  if (groupId !== null) {
    const params: unknown[] = [groupId];
    assertSingleStatement(SEAT_MEMBERS_SQL);
    assertParamCount(SEAT_MEMBERS_SQL, params);
    const rows = db
      .prepare(SEAT_MEMBERS_SQL)
      .all(...(params as never[])) as unknown as {
      member_id: string;
      name: string;
    }[];
    return rows.map((r) => ({ memberId: r.member_id, name: r.name }));
  }
  const out: MentionTarget[] = [];
  for (const mid of [conv.member_a, conv.member_b]) {
    // 老板由 resolveMentions 的 BOSS_TOKENS 统一解析，不冒充 members 行。
    if (mid === null || mid === BOSS_READER) continue;
    const params: unknown[] = [mid];
    assertSingleStatement(PAIR_MEMBER_SQL);
    assertParamCount(PAIR_MEMBER_SQL, params);
    const m = db.prepare(PAIR_MEMBER_SQL).get(...(params as never[])) as
      | { name: string }
      | undefined;
    out.push({ memberId: mid, name: m?.name ?? mid });
  }
  return out;
}

/**
 * 发一条消息（老板或成员）。一个 w.node 里完成：
 * 契约校验 → 在场校验 → reply_to 校验 → @ 解析 → 取号 → 写消息 → 审计。
 * 任何一步不合规 ⇒ 整单未写（消息、events 行都不许多留——半成品痕迹比
 * 拒绝更糟：回放里会出现一条没有消息主体的「有人发过言」）。
 * 提交后 publishPersisted(MessageReceived)；广播失败翻不出 ok:false，
 * 理由在 SendMessageResult.broadcastError 的注释里。
 */
export async function sendMessage(
  w: Writer,
  bus: EventBus,
  o: {
    readonly conversationId: string;
    readonly author: MessageAuthor;
    readonly req: unknown;
    readonly nowMs: number;
    readonly newId?: () => string;
  },
): Promise<SendMessageResult> {
  const parsed = sendMessageRequestSchema.safeParse(o.req);
  if (!parsed.success) {
    return err(
      "bad_body",
      "消息请求不合契约（body trim 后 1..8000，reply_to 可选非空）——一条未写： " +
        parsed.error.issues[0]?.message,
    );
  }
  const body = parsed.data.body.trim();
  const replyTo = parsed.data.reply_to;
  const wrote = await w.node(
    ():
      | {
          readonly message: MessageView;
          readonly msgKind: "message" | "mention_boss";
          readonly groupId: string | null;
          readonly auditSeq: number;
        }
      | ConversationServiceError => {
      const db = requireScopeDb("sendMessage");
      const ctx = resolveSendContext(db, o.conversationId, o.author);
      if ("ok" in ctx) return ctx;
      if (replyTo !== undefined) {
        const params: unknown[] = [replyTo];
        assertSingleStatement(REPLY_CONV_SQL);
        assertParamCount(REPLY_CONV_SQL, params);
        const target = db.prepare(REPLY_CONV_SQL).get(...(params as never[])) as
          | { conversation_id: string }
          | undefined;
        // 「回复不存在」与「回复别的会话的消息」同罪：引用完整性在这里判，
        // 前端拿不到 FK 报错（messages.reply_to 没建 REFERENCES，见 0015）。
        if (
          target === undefined ||
          target.conversation_id !== o.conversationId
        ) {
          return err(
            "reply_not_found",
            "reply_to [" + replyTo + "] 不存在或不在本会话里，拒发。整单未写。",
          );
        }
      }
      const mentions = resolveMentions(body, ctx.candidates);
      const msgKind: "message" | "mention_boss" = mentions.includes(
        MENTION_BOSS,
      )
        ? "mention_boss"
        : "message";
      const seqParams: unknown[] = [o.conversationId];
      assertSingleStatement(NEXT_SEQ_SQL);
      assertParamCount(NEXT_SEQ_SQL, seqParams);
      const next = db.prepare(NEXT_SEQ_SQL).get(...(seqParams as never[])) as {
        next: number;
      };
      const messageId = o.newId?.() ?? randomUUID();
      const params: unknown[] = [
        messageId,
        o.conversationId,
        ctx.senderMemberId,
        ctx.authorKind,
        body,
        JSON.stringify(mentions),
        replyTo ?? null,
        "text",
        next.next,
        o.nowMs,
      ];
      assertSingleStatement(INSERT_MESSAGE_SQL);
      assertParamCount(INSERT_MESSAGE_SQL, params);
      db.prepare(INSERT_MESSAGE_SQL).run(...(params as never[]));
      const message = mustMessage(db, o.conversationId, messageId);
      const auditSeq = appendAudit(
        db,
        {
          taskId: null,
          actorType: ctx.authorKind === "boss" ? "human" : "agent",
          actorId: ctx.senderMemberId ?? CONV_ACTOR.actorId,
          action: "meeting",
          target: messageId,
          payload: {
            kind: "message_posted" satisfies ConversationAuditKind,
            message_id: messageId,
            conversation_id: o.conversationId,
            group_id: ctx.groupId,
            author_kind: ctx.authorKind,
            msg_kind: msgKind,
            mentions,
          },
          createdAt: o.nowMs,
        },
        () => o.nowMs,
      );
      return { message, msgKind, groupId: ctx.groupId, auditSeq };
    },
  );
  if ("ok" in wrote) return wrote;
  const event: DomainEvent = {
    kind: "MessageReceived",
    messageId: wrote.message.message_id,
    conversationId: o.conversationId,
    // groupId 从节点里的会话上下文带出来：群会话 = group_id，私聊 = null
    // （bus.ts：null 是事实而不是兜底，不许用占位串凑一个假的群标识）。
    groupId: wrote.groupId,
    msgKind: wrote.msgKind,
  };
  let broadcastError: string | undefined;
  try {
    bus.publishPersisted(event, wrote.auditSeq);
  } catch (e) {
    broadcastError = (e as Error).message;
  }
  return {
    ok: true,
    message: wrote.message,
    group_id: wrote.groupId,
    msgKind: wrote.msgKind,
    auditSeq: wrote.auditSeq,
    ...(broadcastError === undefined ? {} : { broadcastError }),
  };
}

/**
 * 插一条卡片消息（meeting_card / backlog_card / doc_card + ref_id）。
 *
 * 【不开 w.node】——必须被调用方在自己的节点里调（requireScopeDb 拿调用方
 * 事务的连接）。这是刻意的：卡片与它的实体是【同一件事的两半】（会议开起来
 * 了 + 群里出现会议卡片），分两个节点写就是两个提交点——实体写成功、卡片
 * 失败，群里永远缺这张卡；卡片写成功、实体失败，群里挂一张指向不存在会议的
 * 卡。调用方一个节点里写完，两半同生共死。审计也归调用方记（card_posted
 * 的 kind 在这里导出，署名的业务上下文在调用方）。
 * 返回写好的视图；ref 指向的实体不存在 ⇒ 抛（调用方事务整单回滚——调用方
 * 刚刚亲手写过实体，查不到它意味着调用方的逻辑坏了，不是用户的请求错了，
 * 所以这里抛错回滚而不是返回错误对象）。
 */
export function insertCardMessage(o: {
  readonly conversationId: string;
  readonly kind: CardKind;
  readonly refId: string;
  readonly body: string;
  readonly nowMs: number;
  readonly newId?: () => string;
}): MessageView {
  const db = requireScopeDb("insertCardMessage");
  const ref = CARD_REF_TABLES[o.kind];
  const refSql =
    "SELECT 1 AS hit FROM " + ref.table + " WHERE " + ref.pk + " = ? LIMIT 1";
  const refParams: unknown[] = [o.refId];
  assertSingleStatement(refSql);
  assertParamCount(refSql, refParams);
  const hit = db.prepare(refSql).get(...(refParams as never[]));
  if (hit === undefined) {
    throw new Error(
      "conversations/service：卡片 [" +
        o.kind +
        "] 指向的实体 [" +
        o.refId +
        "] 不在 [" +
        ref.table +
        "] 里 —— 调用方事务内不变量被破坏，整单回滚。",
    );
  }
  const seqParams: unknown[] = [o.conversationId];
  assertSingleStatement(NEXT_SEQ_SQL);
  assertParamCount(NEXT_SEQ_SQL, seqParams);
  const next = db.prepare(NEXT_SEQ_SQL).get(...(seqParams as never[])) as {
    next: number;
  };
  const messageId = o.newId?.() ?? randomUUID();
  const params: unknown[] = [
    messageId,
    o.conversationId,
    null,
    "system",
    o.body,
    "[]",
    o.kind,
    next.next,
    o.nowMs,
    o.refId,
  ];
  assertSingleStatement(INSERT_CARD_SQL);
  assertParamCount(INSERT_CARD_SQL, params);
  db.prepare(INSERT_CARD_SQL).run(...(params as never[]));
  return mustMessage(db, o.conversationId, messageId);
}

// ── 已读游标 ─────────────────────────────────────────────────────

/**
 * 标已读。不写 events 行（文件头产品判断：读游标是观看者状态不是业务事实），
 * 所以这里没有广播义务。游标只进不退（UPSERT 里 MAX），显式游标越界拒
 * （seq_out_of_range）：钳位会把客户端的 seq 错位咽下去，让它一直错到对账那天。
 * reader 不做「必须存在」校验：message_reads.reader 无 FK（0015），任何观看者
 * ——包括还没落席就进群看热闹的人——标已读都不该炸。
 */
export async function markRead(
  w: Writer,
  o: {
    readonly conversationId: string;
    readonly reader: string;
    readonly req: unknown;
    readonly nowMs: number;
  },
): Promise<MarkReadResult> {
  const parsed = markReadRequestSchema.safeParse(o.req ?? {});
  if (!parsed.success) {
    return err(
      "bad_body",
      "已读请求不合契约（last_seq_in_conv 可选非负整数）——游标未动： " +
        parsed.error.issues[0]?.message,
    );
  }
  const explicit = parsed.data.last_seq_in_conv;
  return w.node(() => {
    const db = requireScopeDb("markRead");
    const convParams: unknown[] = [o.conversationId];
    assertSingleStatement(CONV_KIND_SQL);
    assertParamCount(CONV_KIND_SQL, convParams);
    const conv = db.prepare(CONV_KIND_SQL).get(...(convParams as never[]));
    if (conv === undefined) {
      return err(
        "conversation_not_found",
        "会话 [" + o.conversationId + "] 不存在，游标未动。",
      );
    }
    const maxParams: unknown[] = [o.conversationId];
    assertSingleStatement(MAX_SEQ_SQL);
    assertParamCount(MAX_SEQ_SQL, maxParams);
    const max = db.prepare(MAX_SEQ_SQL).get(...(maxParams as never[])) as {
      max: number;
    };
    const want = explicit ?? max.max;
    if (want > max.max) {
      return err(
        "seq_out_of_range",
        "游标 [" +
          want +
          "] 超过会话 [" +
          o.conversationId +
          "] 的最新消息 [" +
          max.max +
          "] —— 客户端 seq 错位，拒绝钳位。游标未动。",
      );
    }
    const params: unknown[] = [o.conversationId, o.reader, want, o.nowMs];
    assertSingleStatement(UPSERT_READ_SQL);
    assertParamCount(UPSERT_READ_SQL, params);
    db.prepare(UPSERT_READ_SQL).run(...(params as never[]));
    const cursorParams: unknown[] = [o.conversationId, o.reader];
    assertSingleStatement(READ_CURSOR_SQL);
    assertParamCount(READ_CURSOR_SQL, cursorParams);
    const cur = db
      .prepare(READ_CURSOR_SQL)
      .get(...(cursorParams as never[])) as {
      last_seq_in_conv: number;
    };
    return {
      ok: true,
      conversation_id: o.conversationId,
      reader: o.reader,
      last_seq_in_conv: cur.last_seq_in_conv,
      auditSeq: -1 as const,
    };
  });
}
