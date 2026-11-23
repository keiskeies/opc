/**
 * ⚠⚠ 今天【零生产入口】：groups/service.ts 的读写只被 test/groups/service.test.ts 调，
 * HTTP（T10）与桌面 IPC（T11）都还没接线 ⚠⚠
 * 接线那天 checkBaseline 方向 B 会红并点名基线里这一行 ⇒ 连横幅一起自删，不等谁记得改文档。
 *
 * 群服务（T5）：groups / group_members 的唯一写路径，兼管群会话行的诞生。
 *
 * ── 这个文件为什么存在 ──────────────────────────────────────────────
 * 群 = 一个任务（D2），群里有且仅有一个特助（D6）。建群是跨四张表的原子动作：
 * 特助成员（可能新建）→ groups 行 → 群会话行 → 全部席位行。判据若散在 HTTP 与
 * IPC 两个入口，就是「同一张图，两个入口，两种答案」那族老病（roles/service.ts
 * 文件头立过同样的案）。入口都调这里。
 *
 * ── 「建群必带特助」为什么只能在事务里守 ──────────────────────────
 * 0014 文件头把这条不变量交给本文件：DDL 的 cos_member_id NOT NULL 留了可空
 * （迁移要对既有库运行），部分唯一索引只能表达「≤1 个特助席」表达不了「=1」。
 * 执行处就是 createGroup：ensureCosMember 与 groups INSERT、特助席位、成员席位
 * 在【同一个 w.node】里 —— 任何一步抛，整单回滚，库里不会留下无特助的群，
 * 也不会留下没群的孤儿特助。
 *
 * ── 特助是复用不是克隆 ────────────────────────────────────────────
 * 全库一个 active CoS（members/service.ts 的 ensureCosMember 是 CoS 唯一生产者）。
 * 每群克隆一个「特助」的替代方案被否：通讯录会被 N 个同名特助塞满，@特助
 * 出现歧义（@ 的是哪个？），而 D16 升级链要的是【同一个】规则的化身。
 * 归档的旧 CoS 不复活：ensureCosMember 只复用 active 行，归档即人事意义上的
 * 离任，新群会孵化新的 active CoS（历史消息归属仍指向老行，join 时间线不断）。
 *
 * ── 群会话随行创建 ────────────────────────────────────────────────
 * 「每个群恰好一条 kind='group' 会话」由 0015 的部分唯一索引兜底，但索引只能
 * 保证不多，不能保证不少。缺了会话行的群在客户端三栏里点不开——所以会话行
 * 在 createGroup 事务里一并插入。会话【内容】（消息写入）归 T7 会话层，
 * 本文件只管容器的诞生，不往 messages 里写一个字。
 *
 * ── 「不进新」规则（产品判断，登记）──────────────────────────────
 * 已归档的成员/群可以被历史引用，但不能承接【新增】：
 *  · 落座进归档群 ⇒ 拒（members/service.ts 的 hireMember 已立此案）；
 *  · 把归档成员拉进群 ⇒ 拒（member_archived）——归档 = 不在职，把他拉进
 *    新群等于给群里塞一个不会回话的头像；恢复在职后再拉。
 * 归档成员的【既有】席位不动（归档语义见 members 文件头），新拉才拦。
 * 方向只有一个：历史不篡改，入口要在职。
 *
 * ── 归档群可恢复 ──────────────────────────────────────────────────
 * status 只是状态位，归档不删行：会话、消息、席位全留着，随时可恢复。
 * 前端据此把归档群从主列表挪进「已归档」分区，而不是销毁数据。
 *
 * ── 读侧守门 ──────────────────────────────────────────────────────
 * 群行虽无 JSON 列，视图仍过 groupViewSchema.safeParse 再出口（与 roles 的
 * assertCharterShape、members 的 assembleMember 同一立场）：status 枚举有 DDL
 * CHECK 先兜底，守门真正拦的是 DDL 管不住的坏形状（如 INTEGER 列被手改成字符串），
 * 不把坏行伪装成合法视图递给渲染层。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type AddGroupMemberRequest,
  CEO_ROLE_ID,
  type CreateGroupRequest,
  type GroupMemberView,
  type GroupStatus,
  type GroupView,
  groupMemberViewSchema,
  groupViewSchema,
  type RejectCode,
  type UpdateGroupRequest,
} from "@opc/contracts";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import {
  assertParamCount,
  assertSingleStatement,
  type Writer,
} from "../db/write-queue.js";
import { appendAudit } from "../events/recorder.js";
import { ensureCosMember } from "../members/service.js";

/** 审计署名：与 roles/members 同一个「人」（§4.2.3 权集中于老板）。 */
const GROUP_ACTOR = { actorType: "human", actorId: CEO_ROLE_ID } as const;

/**
 * 审计 payload.kind 的五个取值（action 恒为 state_change，与角色/成员侧审计
 * kinds 同族）。建群/改名/拉人/移出/立项各记一类。
 */
export const GROUP_AUDIT_KINDS = [
  "group_created",
  "group_updated",
  "group_member_added",
  "group_member_removed",
  "group_task_linked",
] as const;
export type GroupAuditKind = (typeof GROUP_AUDIT_KINDS)[number];

/**
 * 服务层自己造的错误码。同一 code 在不同服务里状态码可以不同：
 * code 说的是【资源事实】，状态码取决于它是路径参数（404）还是请求体引用（422）。
 * 本文件里 group_not_found 恒为路径语义（404）；member_not_found / role_not_found
 * 恒为请求体引用（422）；members/service.ts 里 group_not_found 是请求体引用 ⇒ 422，
 * 各服务的 status 函数各管各的映射，互不借用。
 *  · group_not_found —— 路径里的群不存在（含从未存在与已删；归档群算存在）；
 *  · seat_not_found —— 群在但这个人不在席（DELETE 的幂等性靠它报 404）；
 *  · member_archived —— 把不在职成员往新群里拉（见文件头「不进新」）；
 *  · already_seated —— 重复拉人：重复审计会让「谁把他拉进来的」失去唯一答案，
 *    且兼任换岗应走显式改岗而非再插一行（PK 也会撞）；
 *  · cos_required —— 移走群里唯一的特助：D6 的「每群必有特助」在删除侧的挡板；
 *  · task_not_found / task_already_linked —— 立项回填（T8）的两类拒绝：
 *    任务不存在，或 0014「一个任务最多一个群」的查重。
 * 未列出的 code 全是 RejectCode ⇒ 422，默认分支就是它们的映射。
 */
export type GroupServiceCode =
  | "group_not_found"
  | "seat_not_found"
  | "member_not_found"
  | "member_archived"
  | "role_not_found"
  | "already_seated"
  | "cos_required"
  | "task_not_found"
  | "task_already_linked"
  | "not_writable"
  | RejectCode;

export type GroupServiceError = {
  readonly ok: false;
  readonly reason: string;
  readonly code: GroupServiceCode;
};

/** code → HTTP 状态码原料（与 roleServiceStatus / memberServiceStatus 同一用法）。 */
export function groupServiceStatus(code: GroupServiceCode): number {
  switch (code) {
    case "group_not_found":
    case "seat_not_found":
      return 404;
    case "not_writable":
      return 500;
    default:
      return 422;
  }
}

export type CreateGroupResult =
  | {
      readonly ok: true;
      readonly group: GroupView;
      readonly conversation_id: string;
      readonly auditSeq: number;
    }
  | GroupServiceError;

export type GroupMutationResult =
  | { readonly ok: true; readonly group: GroupView; readonly auditSeq: number }
  | GroupServiceError;

export type AddMemberResult =
  | {
      readonly ok: true;
      readonly member: GroupMemberView;
      readonly auditSeq: number;
    }
  | GroupServiceError;

type DbLike = Pick<DatabaseSync, "prepare">;

/** 群行全列（与 0014 的 groups 逐字对应；视图层再补 member_count）。 */
const GROUP_COLS =
  "group_id, title, goal, task_id, cos_member_id, status, created_at, updated_at";

/** member_count 用标量子查询现算：一列冗余计数器迟早与席位表不一致，红点数错比没红点更糟。 */
const GROUP_VIEW_COLS =
  GROUP_COLS +
  ", (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = groups.group_id) AS member_count";

const INSERT_GROUP_SQL =
  "INSERT INTO groups (group_id, title, goal, task_id, cos_member_id, status, created_at, updated_at)" +
  " VALUES (?, ?, ?, ?, ?, 'active', ?, ?)";

/** 群会话行：kind='group' 时 member_a/b 必须 NULL、group_id 必须非空（0015 CHECK）；唯一索引兜「恰好一条」。 */
const INSERT_GROUP_CONV_SQL =
  "INSERT INTO conversations (conversation_id, kind, group_id, member_a, member_b, title, created_at)" +
  " VALUES (?, 'group', ?, NULL, NULL, ?, ?)";

const INSERT_SEAT_SQL =
  "INSERT INTO group_members (group_id, member_id, role_id, seat, joined_at)" +
  " VALUES (?, ?, ?, ?, ?)";

const DELETE_SEAT_SQL =
  "DELETE FROM group_members WHERE group_id = ? AND member_id = ?";

/** PATCH 的「没传 = 不动」：COALESCE(?, col)；goal 清空传空串（空串 ≠ NULL，不会被吞）。 */
const UPDATE_GROUP_SQL =
  "UPDATE groups SET title = COALESCE(?, title), goal = COALESCE(?, goal)," +
  " status = COALESCE(?, status), updated_at = ? WHERE group_id = ?";

const LINK_TASK_SQL =
  "UPDATE groups SET task_id = ?, updated_at = ? WHERE group_id = ?";

const GROUP_VIEW_SQL = `SELECT ${GROUP_VIEW_COLS} FROM groups WHERE group_id = ?`;

const GROUP_STATUS_SQL = "SELECT status FROM groups WHERE group_id = ?";

const LIST_GROUPS_SQL =
  `SELECT ${GROUP_VIEW_COLS} FROM groups` +
  " WHERE (? IS NULL OR status = ?) ORDER BY created_at, group_id";

/** 成员的岗位与在职状态：拉人落座一次查齐，省两次往返。 */
const MEMBER_ROLE_STATUS_SQL =
  "SELECT role_id, status FROM members WHERE member_id = ?";

const ROLE_EXISTS_SQL = "SELECT 1 AS ok FROM roles WHERE role_id = ?";

const TASK_EXISTS_SQL = "SELECT 1 AS ok FROM tasks WHERE id = ?";

const SEAT_EXISTS_SQL =
  "SELECT role_id, seat FROM group_members WHERE group_id = ? AND member_id = ?";

const LIST_SEATS_SQL =
  "SELECT group_id, member_id, role_id, seat, joined_at FROM group_members" +
  " WHERE group_id = ? ORDER BY seat, joined_at, member_id";

const GROUP_CONV_SQL =
  "SELECT conversation_id FROM conversations WHERE kind = 'group' AND group_id = ?";

function err(code: GroupServiceCode, reason: string): GroupServiceError {
  return { ok: false, reason, code };
}

function exists(db: DbLike, sql: string, params: unknown[]): boolean {
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  return db.prepare(sql).get(...(params as never[])) !== undefined;
}

function getGroupRow(db: DbLike, groupId: string): GroupView | undefined {
  assertSingleStatement(GROUP_VIEW_SQL);
  const params: unknown[] = [groupId];
  assertParamCount(GROUP_VIEW_SQL, params);
  const row = db.prepare(GROUP_VIEW_SQL).get(...(params as never[])) as
    | Record<string, unknown>
    | undefined;
  if (row === undefined) return undefined;
  const parsed = groupViewSchema.safeParse(row);
  if (!parsed.success) {
    throw new Error(
      "groups/service：群 [" +
        groupId +
        "] 行存在但形状坏（groupViewSchema 不过）——库里数据异常，拒当合法视图： " +
        parsed.error.issues[0]?.message,
    );
  }
  return parsed.data;
}

/** 事务内不变量：行必须刚被本事务写过，读不到/形状坏 ⇒ 抛（回滚整单），不返回 undefined。 */
function mustGroup(db: DbLike, groupId: string): GroupView {
  const view = getGroupRow(db, groupId);
  if (view === undefined) {
    throw new Error(
      "groups/service：刚写完群 [" +
        groupId +
        "] 却读不回来 —— 事务内不变量被破坏，整单回滚。",
    );
  }
  return view;
}

/** 群存在性 + 状态（写路径的门卫共用；undefined ⇒ 调用方给 group_not_found）。 */
function groupStatus(
  db: DbLike,
  groupId: string,
): "active" | "archived" | undefined {
  const params: unknown[] = [groupId];
  assertSingleStatement(GROUP_STATUS_SQL);
  assertParamCount(GROUP_STATUS_SQL, params);
  const row = db.prepare(GROUP_STATUS_SQL).get(...(params as never[])) as
    | { status: string }
    | undefined;
  if (row === undefined) return undefined;
  return row.status === "active" ? "active" : "archived";
}

// ── 读面 ─────────────────────────────────────────────────────────

/** 单群视图（含 member_count）。不存在 ⇒ null，调用方决定 404 还是别用。 */
export function getGroup(db: DbLike, groupId: string): GroupView | null {
  return getGroupRow(db, groupId) ?? null;
}

/** 群列表：status 传 null = 全量（前端「已归档」分区自己切）。按创建时间稳定排序。 */
export function listGroups(
  db: DbLike,
  status: GroupStatus | null,
): GroupView[] {
  assertSingleStatement(LIST_GROUPS_SQL);
  const params: unknown[] = [status, status];
  assertParamCount(LIST_GROUPS_SQL, params);
  const rows = db
    .prepare(LIST_GROUPS_SQL)
    .all(...(params as never[])) as unknown as Record<string, unknown>[];
  return rows.map((row) => {
    const parsed = groupViewSchema.safeParse(row);
    if (!parsed.success) {
      throw new Error(
        "groups/service：群行形状坏（id=" +
          String(row["group_id"]) +
          "）——拒当合法视图： " +
          parsed.error.issues[0]?.message,
      );
    }
    return parsed.data;
  });
}

/** 席位列表（特助席排最前）：seat 无 JSON 列，行即视图；仍逐行过契约再出口。 */
export function listGroupMembers(
  db: DbLike,
  groupId: string,
): GroupMemberView[] {
  assertSingleStatement(LIST_SEATS_SQL);
  const params: unknown[] = [groupId];
  assertParamCount(LIST_SEATS_SQL, params);
  const rows = db
    .prepare(LIST_SEATS_SQL)
    .all(...(params as never[])) as unknown as Record<string, unknown>[];
  return rows.map((row) => {
    const parsed = groupMemberViewSchema.safeParse(row);
    if (!parsed.success) {
      throw new Error(
        "groups/service：席位行形状坏（group=" +
          String(row["group_id"]) +
          "）——拒当合法视图： " +
          parsed.error.issues[0]?.message,
      );
    }
    return parsed.data;
  });
}

/** 群会话指针（T7 与 HTTP 的读面都要）：建群事务保证存在，读不到 = 库坏 ⇒ 抛。 */
export function groupConversationId(db: DbLike, groupId: string): string {
  assertSingleStatement(GROUP_CONV_SQL);
  const params: unknown[] = [groupId];
  assertParamCount(GROUP_CONV_SQL, params);
  const row = db.prepare(GROUP_CONV_SQL).get(...(params as never[])) as
    | { conversation_id: string }
    | undefined;
  if (row === undefined) {
    throw new Error(
      "groups/service：群 [" +
        groupId +
        "] 没有群会话行 —— 0015「每群恰好一条」被旁路写入破坏了，拒降级为 null。",
    );
  }
  return row.conversation_id;
}

// ── 写面 ─────────────────────────────────────────────────────────

/**
 * 建群（D2/D6）。一个事务里的完整形状：
 * 成员校验（存在 + 在职）→ 特助就位（ensureCosMember，可能是复用）→
 * groups 行 → 群会话行 → 特助席 + 成员席 → 审计。
 * 任何一步失败整单回滚：库里要么有「带特助、带会话、带全员席位」的完整群，
 * 要么什么都没有。特助自动追加且从调用方给的名单里剔除（幂等：传了
 * 特助的 member_id 也不会坐双席）——契约注释「调用方不需要（也不应该）自己塞」。
 * 新群 task_id 恒 NULL：立项是后到的动作（0014 文件头），回填走 linkGroupTask（T8）。
 */
export async function createGroup(
  w: Writer,
  o: {
    readonly req: CreateGroupRequest;
    readonly nowMs: number;
    readonly newId?: () => string;
  },
): Promise<CreateGroupResult> {
  return w.node(() => {
    const db = requireScopeDb("createGroup");
    const memberIds = [...new Set(o.req.member_ids)].sort();
    for (const mid of memberIds) {
      const params: unknown[] = [mid];
      assertSingleStatement(MEMBER_ROLE_STATUS_SQL);
      assertParamCount(MEMBER_ROLE_STATUS_SQL, params);
      const m = db
        .prepare(MEMBER_ROLE_STATUS_SQL)
        .get(...(params as never[])) as
        | { role_id: string; status: string }
        | undefined;
      if (m === undefined) {
        return err(
          "member_not_found",
          "成员 [" +
            mid +
            "] 不存在：整单建群已回滚（不允许「群建好但名单里查无此人」的半成功）。",
        );
      }
      if (m.status !== "active") {
        return err(
          "member_archived",
          "成员 [" +
            mid +
            "] 已归档（不在职），不进新群：先恢复在职再拉。整单已回滚。",
        );
      }
    }
    const cosId = ensureCosMember(db, {
      nowMs: o.nowMs,
      ...(o.newId === undefined ? {} : { newId: o.newId }),
    });
    // 特助由服务端自动追加：调用方名单里若恰好有他，剔除即可（幂等），
    // 而不是报错——「我把特助也填进去了」不该让整个建群请求重敲一遍。
    const plainIds = memberIds.filter((mid) => mid !== cosId);

    const groupId = o.newId?.() ?? randomUUID();
    const conversationId = o.newId?.() ?? randomUUID();

    const insertParams: unknown[] = [
      groupId,
      o.req.title,
      o.req.goal,
      null,
      cosId,
      o.nowMs,
      o.nowMs,
    ];
    assertSingleStatement(INSERT_GROUP_SQL);
    assertParamCount(INSERT_GROUP_SQL, insertParams);
    db.prepare(INSERT_GROUP_SQL).run(...(insertParams as never[]));

    const convParams: unknown[] = [
      conversationId,
      groupId,
      o.req.title,
      o.nowMs,
    ];
    assertSingleStatement(INSERT_GROUP_CONV_SQL);
    assertParamCount(INSERT_GROUP_CONV_SQL, convParams);
    db.prepare(INSERT_GROUP_CONV_SQL).run(...(convParams as never[]));

    const cosSeatParams: unknown[] = [groupId, cosId, "cos", "cos", o.nowMs];
    assertSingleStatement(INSERT_SEAT_SQL);
    assertParamCount(INSERT_SEAT_SQL, cosSeatParams);
    db.prepare(INSERT_SEAT_SQL).run(...(cosSeatParams as never[]));
    for (const mid of plainIds) {
      const params: unknown[] = [mid];
      assertSingleStatement(MEMBER_ROLE_STATUS_SQL);
      assertParamCount(MEMBER_ROLE_STATUS_SQL, params);
      const m = db
        .prepare(MEMBER_ROLE_STATUS_SQL)
        .get(...(params as never[])) as {
        role_id: string;
      };
      const seatParams: unknown[] = [
        groupId,
        mid,
        m.role_id,
        "member",
        o.nowMs,
      ];
      assertSingleStatement(INSERT_SEAT_SQL);
      assertParamCount(INSERT_SEAT_SQL, seatParams);
      db.prepare(INSERT_SEAT_SQL).run(...(seatParams as never[]));
    }

    const view = mustGroup(db, groupId);
    const auditSeq = appendAudit(
      db,
      {
        taskId: null,
        actorType: GROUP_ACTOR.actorType,
        actorId: GROUP_ACTOR.actorId,
        action: "state_change",
        target: groupId,
        payload: {
          kind: "group_created" satisfies GroupAuditKind,
          group_id: groupId,
          cos_member_id: cosId,
          member_ids: plainIds,
          conversation_id: conversationId,
        },
        stateSnapshot: { before: null, after: view },
        createdAt: o.nowMs,
      },
      () => o.nowMs,
    );
    return { ok: true, group: view, conversation_id: conversationId, auditSeq };
  });
}

/**
 * 改群（PATCH：没传 = 不动）。COALESCE(?, col) 三个字段都成立：goal 的「清空」
 * 是传空串（契约 trim 后合法），空串 ≠ NULL，不会被 COALESCE 吞掉。
 * changed 用落库前后的视图差异算（不拿请求猜）：同值 PATCH 会落一条 changed=[]
 * 的审计——写了但没改变，审计里看得见，比「静默无审计」诚实。
 * 归档/恢复都走这里（status 翻转），不单独设 archive 端点：PATCH 一个字段
 * 就是一次 PATCH，多一个入口就多一处判据漂移的地方。
 */
export async function updateGroup(
  w: Writer,
  o: {
    readonly groupId: string;
    readonly req: UpdateGroupRequest;
    readonly nowMs: number;
  },
): Promise<GroupMutationResult> {
  return w.node(() => {
    const db = requireScopeDb("updateGroup");
    const before = getGroupRow(db, o.groupId);
    if (before === undefined) {
      return err("group_not_found", "群 [" + o.groupId + "] 不存在。");
    }
    const params: unknown[] = [
      // COALESCE 语义：undefined → SQL NULL → 保原值。
      o.req.title ?? null,
      o.req.goal ?? null,
      o.req.status ?? null,
      o.nowMs,
      o.groupId,
    ];
    assertSingleStatement(UPDATE_GROUP_SQL);
    assertParamCount(UPDATE_GROUP_SQL, params);
    db.prepare(UPDATE_GROUP_SQL).run(...(params as never[]));

    const after = mustGroup(db, o.groupId);
    const changed: string[] = [];
    if (after.title !== before.title) changed.push("title");
    if (after.goal !== before.goal) changed.push("goal");
    if (after.status !== before.status) changed.push("status");
    const auditSeq = appendAudit(
      db,
      {
        taskId: null,
        actorType: GROUP_ACTOR.actorType,
        actorId: GROUP_ACTOR.actorId,
        action: "state_change",
        target: o.groupId,
        payload: {
          kind: "group_updated" satisfies GroupAuditKind,
          group_id: o.groupId,
          changed,
        },
        stateSnapshot: { before, after },
        createdAt: o.nowMs,
      },
      () => o.nowMs,
    );
    return { ok: true, group: after, auditSeq };
  });
}

/**
 * 拉人进群。任职岗位 = 显式传的 role_id（兼任：同一成员在不同群不同岗），
 * 缺省取成员当前默认岗位。校验顺序按「谁的问题谁先知道」：群（路径）→
 * 人（请求体引用）→ 在职 → 已在席。归档群不进新人（与 hireMember 落座同判）。
 */
export async function addGroupMember(
  w: Writer,
  o: {
    readonly groupId: string;
    readonly req: AddGroupMemberRequest;
    readonly nowMs: number;
  },
): Promise<AddMemberResult> {
  return w.node(() => {
    const db = requireScopeDb("addGroupMember");
    const g = groupStatus(db, o.groupId);
    if (g === undefined) {
      return err("group_not_found", "群 [" + o.groupId + "] 不存在。");
    }
    if (g !== "active") {
      return err(
        "group_not_found",
        "群 [" + o.groupId + "] 已归档，不再进新成员：要人先把群恢复。",
      );
    }
    const mParams: unknown[] = [o.req.member_id];
    assertSingleStatement(MEMBER_ROLE_STATUS_SQL);
    assertParamCount(MEMBER_ROLE_STATUS_SQL, mParams);
    const m = db.prepare(MEMBER_ROLE_STATUS_SQL).get(...(mParams as never[])) as
      | { role_id: string; status: string }
      | undefined;
    if (m === undefined) {
      return err(
        "member_not_found",
        "成员 [" + o.req.member_id + "] 不存在：选一个已有成员再拉。",
      );
    }
    if (m.status !== "active") {
      return err(
        "member_archived",
        "成员 [" +
          o.req.member_id +
          "] 已归档（不在职），不进新群：先恢复在职再拉。",
      );
    }
    const seatParams0: unknown[] = [o.groupId, o.req.member_id];
    assertSingleStatement(SEAT_EXISTS_SQL);
    assertParamCount(SEAT_EXISTS_SQL, seatParams0);
    if (
      db.prepare(SEAT_EXISTS_SQL).get(...(seatParams0 as never[])) !== undefined
    ) {
      return err(
        "already_seated",
        "成员 [" +
          o.req.member_id +
          "] 已在群里：换岗请显式改任职岗位，别重复拉（重复拉人会让审计里「谁拉的他」出现两条）。",
      );
    }
    const seatRoleId = o.req.role_id ?? m.role_id;
    if (
      o.req.role_id !== undefined &&
      !exists(db, ROLE_EXISTS_SQL, [seatRoleId])
    ) {
      return err(
        "role_not_found",
        "任职岗位 [" +
          seatRoleId +
          "] 不存在：兼任也要挂真实岗位，别挂一个不存在的头衔。",
      );
    }
    const seatParams: unknown[] = [
      o.groupId,
      o.req.member_id,
      seatRoleId,
      "member",
      o.nowMs,
    ];
    assertSingleStatement(INSERT_SEAT_SQL);
    assertParamCount(INSERT_SEAT_SQL, seatParams);
    db.prepare(INSERT_SEAT_SQL).run(...(seatParams as never[]));

    const seatGet = listGroupMembers(db, o.groupId).find(
      (r) => r.member_id === o.req.member_id,
    );
    if (seatGet === undefined) {
      throw new Error(
        "groups/service：刚插完席位 [" +
          o.groupId +
          "/" +
          o.req.member_id +
          "] 却读不回来 —— 事务内不变量被破坏，整单回滚。",
      );
    }
    const auditSeq = appendAudit(
      db,
      {
        taskId: null,
        actorType: GROUP_ACTOR.actorType,
        actorId: GROUP_ACTOR.actorId,
        action: "state_change",
        target: o.groupId,
        payload: {
          kind: "group_member_added" satisfies GroupAuditKind,
          group_id: o.groupId,
          member_id: o.req.member_id,
          role_id: seatRoleId,
        },
        stateSnapshot: { before: null, after: seatGet },
        createdAt: o.nowMs,
      },
      () => o.nowMs,
    );
    return { ok: true, member: seatGet, auditSeq };
  });
}

/**
 * 移出成员（释放席位，成员本身还在职——离职是归档成员，不是移出群）。
 * 特助席不可移：D6 每群必有特助，删特助席 = 造出一个分发链断裂的群。
 * 归档成员的席位本可保留（归档语义），但显式移出是老板的主动动作，照删。
 */
export async function removeGroupMember(
  w: Writer,
  o: {
    readonly groupId: string;
    readonly memberId: string;
    readonly nowMs: number;
  },
): Promise<GroupMutationResult> {
  return w.node(() => {
    const db = requireScopeDb("removeGroupMember");
    const before = getGroupRow(db, o.groupId);
    if (before === undefined) {
      return err("group_not_found", "群 [" + o.groupId + "] 不存在。");
    }
    if (before.cos_member_id === o.memberId) {
      return err(
        "cos_required",
        "特助不能被移出群：每群必须有特助（D6），分发与升级链从他走。",
      );
    }
    const seatParams: unknown[] = [o.groupId, o.memberId];
    assertSingleStatement(SEAT_EXISTS_SQL);
    assertParamCount(SEAT_EXISTS_SQL, seatParams);
    const seat = db.prepare(SEAT_EXISTS_SQL).get(...(seatParams as never[])) as
      | { role_id: string; seat: string }
      | undefined;
    if (seat === undefined) {
      return err(
        "seat_not_found",
        "成员 [" + o.memberId + "] 不在群 [" + o.groupId + "] 的席位表里。",
      );
    }
    const delParams: unknown[] = [o.groupId, o.memberId];
    assertSingleStatement(DELETE_SEAT_SQL);
    assertParamCount(DELETE_SEAT_SQL, delParams);
    db.prepare(DELETE_SEAT_SQL).run(...(delParams as never[]));

    const after = mustGroup(db, o.groupId);
    const auditSeq = appendAudit(
      db,
      {
        taskId: null,
        actorType: GROUP_ACTOR.actorType,
        actorId: GROUP_ACTOR.actorId,
        action: "state_change",
        target: o.groupId,
        payload: {
          kind: "group_member_removed" satisfies GroupAuditKind,
          group_id: o.groupId,
          member_id: o.memberId,
          seat: seat.seat,
        },
        stateSnapshot: { before: seat, after: null },
        createdAt: o.nowMs,
      },
      () => o.nowMs,
    );
    return { ok: true, group: after, auditSeq };
  });
}

/**
 * 立项回填（T8 的执行原语）：特助规则命中「立项」后，把已建任务挂到群上。
 * 双向唯一在应用层查（0014 文件头的理由：SQLite 的 NULL 唯一性帮不上忙）：
 * 群已挂别的任务 ⇒ task_already_linked（重挂会静默甩掉旧任务，必须显式解绑再说）；
 * 该任务已被别的群挂走 ⇒ 同 code（一个任务最多一个群）。
 * 归档群不可立项（归档 = 停止推进），恢复后再挂。
 */
export async function linkGroupTask(
  w: Writer,
  o: {
    readonly groupId: string;
    readonly taskId: string;
    readonly nowMs: number;
  },
): Promise<GroupMutationResult> {
  return w.node(() => {
    const db = requireScopeDb("linkGroupTask");
    const before = getGroupRow(db, o.groupId);
    if (before === undefined) {
      return err("group_not_found", "群 [" + o.groupId + "] 不存在。");
    }
    if (before.status !== "active") {
      return err(
        "group_not_found",
        "群 [" + o.groupId + "] 已归档，不受理立项：先恢复群再挂任务。",
      );
    }
    if (before.task_id !== null && before.task_id !== o.taskId) {
      return err(
        "task_already_linked",
        "群 [" +
          o.groupId +
          "] 已挂任务 [" +
          before.task_id +
          "]，不能再挂 [" +
          o.taskId +
          "]：一群一任务（D2），换任务要先显式解绑。",
      );
    }
    if (before.task_id === o.taskId) {
      // 幂等：特助规则可能重复命中（重试/重启回放），同值重挂不报错也不重复审计。
      return { ok: true, group: before, auditSeq: -1 };
    }
    if (!exists(db, TASK_EXISTS_SQL, [o.taskId])) {
      return err(
        "task_not_found",
        "任务 [" + o.taskId + "] 不存在：先建任务再立项回填。",
      );
    }
    const dupParams: unknown[] = [o.taskId, o.groupId];
    const DUP_SQL =
      "SELECT group_id FROM groups WHERE task_id = ? AND group_id != ? LIMIT 1";
    assertSingleStatement(DUP_SQL);
    assertParamCount(DUP_SQL, dupParams);
    const dup = db.prepare(DUP_SQL).get(...(dupParams as never[])) as
      | { group_id: string }
      | undefined;
    if (dup !== undefined) {
      return err(
        "task_already_linked",
        "任务 [" +
          o.taskId +
          "] 已被群 [" +
          dup.group_id +
          "] 挂走：一任务一群，别再开平行群做同一件事。",
      );
    }
    const params: unknown[] = [o.taskId, o.nowMs, o.groupId];
    assertSingleStatement(LINK_TASK_SQL);
    assertParamCount(LINK_TASK_SQL, params);
    db.prepare(LINK_TASK_SQL).run(...(params as never[]));

    const after = mustGroup(db, o.groupId);
    const auditSeq = appendAudit(
      db,
      {
        taskId: o.taskId,
        actorType: GROUP_ACTOR.actorType,
        actorId: GROUP_ACTOR.actorId,
        action: "state_change",
        target: o.groupId,
        payload: {
          kind: "group_task_linked" satisfies GroupAuditKind,
          group_id: o.groupId,
          task_id: o.taskId,
        },
        stateSnapshot: { before, after },
        createdAt: o.nowMs,
      },
      () => o.nowMs,
    );
    return { ok: true, group: after, auditSeq };
  });
}
