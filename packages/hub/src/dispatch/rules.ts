/**
 * 生产入口：HTTP 分发规则路由（http/dispatch-rules.ts）维护 CoS 的分发规则表。
 *
 * cos_dispatch_rules（0025）的读写面。读侧的运行时那一半在 co.ts（listDispatchRules
 * 只喂规划器，只看 enabled=1）；本文件是【配置面】：列出老板能看到的全部规则（含已停用的，
 * 否则停用的规则在界面上等于消失，而「我停用了它吗」正是配置页要回答的问题），
 * 以及新建 / 改动这两条写路径。
 *
 * ── 为什么这张表此前是「零写入方」──────────────────────────────────
 * 0025 建表时只写了 6 条种子，T8 接的是【消费侧】（规划器读规则派活），配置侧没排进来。
 * 结果文件头那句「规则本身可停用」在实现上是一句做不到的话：enabled 这一列没有任何
 * 生产写入路径，改它只能手改库。本文件补的就是这一格。
 *
 * ── 为什么【没有】删除 ─────────────────────────────────────────────
 * 0025 给的语义是停用（enabled=0），不是删除：规划侧两条 SQL 都带 enabled = 1，
 * 停用后这条规则对派发生效为「不存在」，而它与它的审计记录都留在表里。
 * 真删会抽掉 events 里 `cos_dispatch` 那几条审计指向的 rule_id（回放时查不到是谁命中的）。
 * 「不想再用了」与「这条规则从没存在过」是两件事，0025 选了前者，这里照做。
 *
 * ── 关键字冲突判据与消费侧同源（本文件最容易写错的一格）──────────────
 * co.ts 命中规则用的是 JS：`text.toLowerCase().includes(keyword.toLowerCase())`。
 * 于是两个只在大小写上不同的关键字是【行为上的重复】（`BUG` 与 `bug` 永远同时命中，
 * 谁赢只看 priority/rule_id），必须判成冲突。而 sqlite 的 lower() 只做 ASCII 折叠 ——
 * 用它当判据就是同一件事放两处、两套口径（西里尔字母与最终 sigma 那类字符会漏判）。
 * 所以冲突判定在 JS 里做，且用与 co.ts 同一个 toLowerCase()。
 * 判据范围 = 同一作用域（group_id 用 `IS ?` 做 null 安全相等），因为全局规则与本群规则
 * 本来就可以同关键字共存 —— 那正是「同优先级本群优先」这条设计要用的形状。
 *
 * ── 改动的写法：一条覆盖式 UPDATE，而不是四条窄 UPDATE ───────────────
 * plugins/service.ts 把 UPDATE 拆成三条窄语句，因为它的 SET 子句要看 kind 分支。
 * 这里的四个可改字段先由请求算出【下一份完整值】，再一次写回：SQL 仍是字面量
 * （assertParamCount 数得出问号），四种以上组合不用枚举，也不会出现「改了 keyword 但
 * updated_at 没动」这种漏一条分支的失效方向。updated_at 恒随写而变。
 *
 * ── 审计署名 ────────────────────────────────────────────────────────
 * 沿用 ROLE_ACTOR / PLUGIN_ACTOR 那一份人签（CEO_ROLE_ID）：分发规则是老板的配置项，
 * 与角色、插件同族 —— 三处配置写进审计的是同一个名字，回放里才数得出是一个人改的。
 *
 * ── 已登记缺口：规则的目标岗位在【本群】有没有人坐着，创建时不判 ──────
 * 派发的实际链条是「规则命中 target_role_id → co.ts 从本群席位里挑该岗位成员 → 挑不到
 * 就不派」。所以一条指向「本群没有该岗位」的规则不会报错，只会保持沉默（与「没命中规则」
 * 同一个观察结果）。要不要在创建时就拦（「这个群里没有 QA，这条规则在这个群永远不会生效」），
 * 是一条产品判断，登记为缺口而不是自己拍：全局规则本来就不可能预知每个群的编制。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CEO_ROLE_ID,
  type CreateDispatchRuleRequest,
  type DispatchRuleView,
  dispatchRuleViewSchema,
  type UpdateDispatchRuleRequest,
} from "@opc/contracts";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import {
  assertParamCount,
  assertSingleStatement,
  type Writer,
} from "../db/write-queue.js";
import { appendAudit } from "../events/recorder.js";

/** 审计署名：分发规则是老板的配置项（同 ROLE_ACTOR / PLUGIN_ACTOR 的立场）。 */
const DISPATCH_ACTOR = { actorType: "human", actorId: CEO_ROLE_ID } as const;

/** 审计 payload.kind 的两个取值（action 恒为 state_change，靠 kind 区分）。 */
export const DISPATCH_RULE_AUDIT_KINDS = [
  "dispatch_rule_created",
  "dispatch_rule_updated",
] as const;
export type DispatchRuleAuditKind = (typeof DISPATCH_RULE_AUDIT_KINDS)[number];

/**
 * 服务层自己的错误码。
 *  · dispatch_rule_not_found —— 路径里的规则不存在（404）；
 *  · role_not_found / group_not_found —— 请求指向的岗位或群不存在（404：引用没落地，
 *    不是请求体语法坏了。写成 422 会让调用方去改 JSON 而不是去补那个岗位）；
 *  · keyword_conflict —— 同作用域已有同关键字（409：先改那条，或给它换个作用域）；
 *  · not_writable —— 兜底：判据过了而库仍拒（数据异常，见 catch 处注释）。
 */
export type DispatchRuleServiceCode =
  | "dispatch_rule_not_found"
  | "role_not_found"
  | "group_not_found"
  | "keyword_conflict"
  | "not_writable";

export type DispatchRuleServiceError = {
  ok: false;
  reason: string;
  code: DispatchRuleServiceCode;
};

/** audit_seq=0 是「没有新审计行」的哨兵（同 plugins/service.ts 的 updatePlugin）。 */
export type DispatchRuleWriteResult =
  | { ok: true; rule: DispatchRuleView; auditSeq: number }
  | DispatchRuleServiceError;

/** code → HTTP 状态码：放在服务侧的理由同 roleServiceStatus（桌面 IPC 也按 code 分支）。 */
export function dispatchRuleServiceStatus(
  code: DispatchRuleServiceCode,
): number {
  switch (code) {
    case "dispatch_rule_not_found":
    case "role_not_found":
    case "group_not_found":
      return 404;
    case "keyword_conflict":
      return 409;
    case "not_writable":
      return 500;
  }
}

type DbLike = Pick<DatabaseSync, "prepare">;

interface RuleRow {
  rule_id: string;
  group_id: string | null;
  keyword: string;
  target_role_id: string;
  priority: number | bigint;
  enabled: number | bigint;
  created_at: number | bigint;
  updated_at: number | bigint;
}

const RULE_COLS =
  "rule_id, group_id, keyword, target_role_id, priority, enabled, created_at, updated_at";

/** 排序与 GROUP_RULES_SQL 同形：配置页看到的顺序就是派发时的判定顺序（谁先赢一眼可见）。 */
const SELECT_ALL_RULES_SQL =
  "SELECT " +
  RULE_COLS +
  " FROM cos_dispatch_rules" +
  " ORDER BY priority DESC, (group_id IS NULL) ASC, rule_id ASC";

const SELECT_RULE_SQL =
  "SELECT " + RULE_COLS + " FROM cos_dispatch_rules WHERE rule_id = ?";

/** 同作用域的全部规则（group_id 用 IS 做 null 安全相等，全局那侧传 null）。 */
const SELECT_SCOPE_RULES_SQL =
  "SELECT " +
  RULE_COLS +
  " FROM cos_dispatch_rules WHERE group_id IS ?" +
  " ORDER BY rule_id ASC";

/** 岗位名一次取全（列表页两次查询拼好，避免 N+1；同 plugins 侧手法）。 */
const SELECT_ROLE_NAMES_SQL = "SELECT role_id, name FROM roles";

const SELECT_GROUP_SQL = "SELECT group_id FROM groups WHERE group_id = ?";

const INSERT_RULE_SQL =
  "INSERT INTO cos_dispatch_rules (rule_id, group_id, keyword, target_role_id," +
  " priority, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";

const UPDATE_RULE_SQL =
  "UPDATE cos_dispatch_rules SET keyword = ?, target_role_id = ?, priority = ?," +
  " enabled = ?, updated_at = ? WHERE rule_id = ?";

function err(
  code: DispatchRuleServiceCode,
  reason: string,
): DispatchRuleServiceError {
  return { ok: false, reason, code };
}

function getOne(db: DbLike, sql: string, params: unknown[]): unknown {
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  return db.prepare(sql).get(...(params as never[]));
}

function getRows(db: DbLike, sql: string, params: unknown[]): unknown[] {
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  return db.prepare(sql).all(...(params as never[]));
}

function runSql(db: DbLike, sql: string, params: unknown[]): void {
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  db.prepare(sql).run(...(params as never[]));
}

/**
 * 行 → 视图。整数走 Number()：node:sqlite 把 INTEGER 回成 number，手写库可能是 bigint，
 * 而契约要的是 int 数字（视图层不该把两种整数形态漏给前端）。
 * 目标岗位名从预取的映射里拿：查不到 ⇒ 抛，不把「库坏了一行」翻译成「这条规则没有岗位」。
 * 最后过一遍契约：视图与契约漂移时在这里炸，而不是让前端拿到 undefined 字段。
 */
function toView(
  row: RuleRow,
  roleNames: ReadonlyMap<string, string>,
): DispatchRuleView {
  const roleName = roleNames.get(row.target_role_id);
  if (roleName === undefined) {
    throw new Error(
      "dispatch/rules：规则 [" +
        row.rule_id +
        "] 指向的岗位 [" +
        row.target_role_id +
        "] 不在 roles 里 —— 外键被绕过过（PRAGMA foreign_keys 应为 ON），请先修数据。",
    );
  }
  return dispatchRuleViewSchema.parse({
    rule_id: row.rule_id,
    group_id: row.group_id,
    keyword: row.keyword,
    target_role_id: row.target_role_id,
    target_role_name: roleName,
    priority: Number(row.priority),
    enabled: Number(row.enabled) !== 0,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  });
}

function roleNames(db: DbLike): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of getRows(db, SELECT_ROLE_NAMES_SQL, [])) {
    const row = raw as { role_id: string; name: string };
    out.set(row.role_id, row.name);
  }
  return out;
}

function ruleRow(db: DbLike, ruleId: string): RuleRow | undefined {
  return getOne(db, SELECT_RULE_SQL, [ruleId]) as RuleRow | undefined;
}

/**
 * 同作用域内的大小写等价关键字。这里【不需要】「排除自己」那一格：调用方只在
 * 归一化后与自身现值不同时才会走到这里（create 侧本来就不是自己，update 侧见调用处），
 * 于是自身那一行按判据永远不可能命中。留着 excludeRuleId 就是一条到不了的分支。
 */
function keywordClash(
  db: DbLike,
  o: { readonly groupId: string | null; readonly keyword: string },
): string | null {
  const want = o.keyword.toLowerCase();
  for (const raw of getRows(db, SELECT_SCOPE_RULES_SQL, [o.groupId])) {
    const row = raw as RuleRow;
    if (row.keyword.toLowerCase() === want) return row.rule_id;
  }
  return null;
}

/** 主键由服务端生成：调用方传入会造出「同一条规则被谁覆盖」这种无法回放的状态。 */
function newRuleId(): string {
  return "cos_rule_" + randomUUID();
}

/** 配置面读侧：全部规则，含已停用。 */
export function listDispatchRuleViews(db: DbLike): DispatchRuleView[] {
  const names = roleNames(db);
  return (getRows(db, SELECT_ALL_RULES_SQL, []) as RuleRow[]).map((row) =>
    toView(row, names),
  );
}

/**
 * 新建规则。校验顺序即口径：先认引用（岗位/群存在），再认关键字不撞。
 * 引用先于冲突：指向不存在岗位的一条规则，无论关键字合不合法都得先拒 ——
 * 报「关键字重复」会让人去改一个本来没问题的关键字。
 */
export async function createDispatchRule(
  w: Writer,
  o: {
    readonly req: CreateDispatchRuleRequest;
    readonly nowMs: number;
    readonly newId?: () => string;
  },
): Promise<DispatchRuleWriteResult> {
  return w.node(() => {
    const db = requireScopeDb("createDispatchRule");
    const names = roleNames(db);
    const roleName = names.get(o.req.target_role_id);
    if (roleName === undefined) {
      return err(
        "role_not_found",
        "岗位 [" +
          o.req.target_role_id +
          "] 不存在，规则没有可派给的岗位，什么都没写。",
      );
    }
    if (o.req.group_id !== null) {
      if (getOne(db, SELECT_GROUP_SQL, [o.req.group_id]) === undefined) {
        return err(
          "group_not_found",
          "群 [" +
            o.req.group_id +
            "] 不存在。要做全局规则就传 group_id=null，不要写一个不存在的群 id。",
        );
      }
    }
    const clash = keywordClash(db, {
      groupId: o.req.group_id,
      keyword: o.req.keyword,
    });
    if (clash !== null) {
      return err(
        "keyword_conflict",
        "关键字 [" +
          o.req.keyword +
          "] 在该作用域已被规则 [" +
          clash +
          "] 占用（大小写等价）。派发按「命中即派」走，两条同关键字的规则只会互相抢，" +
          "请先改那一条的关键字或优先级。",
      );
    }
    const ruleId = (o.newId ?? newRuleId)();
    runSql(db, INSERT_RULE_SQL, [
      ruleId,
      o.req.group_id,
      o.req.keyword,
      o.req.target_role_id,
      o.req.priority,
      o.req.enabled ? 1 : 0,
      o.nowMs,
      o.nowMs,
    ]);
    const created = ruleRow(db, ruleId);
    if (created === undefined) {
      // INSERT 后读不回 = 事务里出了非预期状况。抛 ⇒ 整个事务回滚（同 createRole 立场：
      // 宁可让调用方拿到 500 并回滚，也不要返回一个库里没有的视图）。
      throw new Error(
        "dispatch/rules：INSERT 之后读不回规则 [" + ruleId + "]，事务已放弃。",
      );
    }
    const auditSeq = appendAudit(
      db,
      {
        taskId: null,
        actorType: DISPATCH_ACTOR.actorType,
        actorId: DISPATCH_ACTOR.actorId,
        action: "state_change",
        target: ruleId,
        payload: {
          kind: "dispatch_rule_created" satisfies DispatchRuleAuditKind,
          rule_id: ruleId,
          keyword: o.req.keyword,
          target_role_id: o.req.target_role_id,
          target_role_name: roleName,
        },
        stateSnapshot: { before: null, after: toView(created, names) },
        createdAt: o.nowMs,
      },
      () => o.nowMs,
    );
    return { ok: true, rule: toView(created, names), auditSeq };
  });
}

/**
 * 改规则：keyword / target_role_id / priority / enabled 四个字段，任一未传即保持原值。
 * 全等值 PATCH ⇒ 返回现视图且 auditSeq=0（没有新审计行 —— 配置没变就不该在审计里多一行）。
 */
export async function updateDispatchRule(
  w: Writer,
  o: {
    readonly ruleId: string;
    readonly req: UpdateDispatchRuleRequest;
    readonly nowMs: number;
  },
): Promise<DispatchRuleWriteResult> {
  return w.node(() => {
    const db = requireScopeDb("updateDispatchRule");
    const row = ruleRow(db, o.ruleId);
    if (row === undefined) {
      return err(
        "dispatch_rule_not_found",
        "规则 [" + o.ruleId + "] 不存在，没有任何东西被改。",
      );
    }
    const before = toView(row, roleNames(db));
    const nextKeyword = o.req.keyword ?? before.keyword;
    const nextRoleId = o.req.target_role_id ?? before.target_role_id;
    const nextPriority = o.req.priority ?? before.priority;
    const nextEnabled = o.req.enabled ?? before.enabled;
    if (nextRoleId !== before.target_role_id) {
      if (!roleNames(db).has(nextRoleId)) {
        return err(
          "role_not_found",
          "岗位 [" +
            nextRoleId +
            "] 不存在，规则改过去就没有可派给的岗位，什么都没改。",
        );
      }
    }
    if (nextKeyword.toLowerCase() !== before.keyword.toLowerCase()) {
      const clash = keywordClash(db, {
        groupId: before.group_id,
        keyword: nextKeyword,
      });
      if (clash !== null) {
        return err(
          "keyword_conflict",
          "关键字 [" +
            nextKeyword +
            "] 在该作用域已被规则 [" +
            clash +
            "] 占用（大小写等价），什么都没改。",
        );
      }
    }
    const changed: string[] = [];
    if (nextKeyword !== before.keyword) changed.push("keyword");
    if (nextRoleId !== before.target_role_id) changed.push("target_role_id");
    if (nextPriority !== before.priority) changed.push("priority");
    if (nextEnabled !== before.enabled) changed.push("enabled");
    if (changed.length === 0) {
      return { ok: true, rule: before, auditSeq: 0 };
    }
    try {
      runSql(db, UPDATE_RULE_SQL, [
        nextKeyword,
        nextRoleId,
        nextPriority,
        nextEnabled ? 1 : 0,
        o.nowMs,
        o.ruleId,
      ]);
    } catch (e) {
      // 判据（岗位/关键字/作用域）都在同一事务里查过了仍被拒 ⇒ 只剩数据异常一条路
      // （手写库把 enabled 写成 2 之类撞 CHECK）。报可修的错，不冒领 500 的堆栈。
      return err(
        "not_writable",
        "规则 [" +
          o.ruleId +
          "] 被数据库拒了：判据已过而写仍失败，通常是这一行有 CHECK 之外的手工改动。原文：" +
          (e instanceof Error ? e.message : String(e)),
      );
    }
    const names = roleNames(db);
    const afterRow = ruleRow(db, o.ruleId);
    if (afterRow === undefined) {
      throw new Error(
        "dispatch/rules：UPDATE 之后读不回规则 [" +
          o.ruleId +
          "]，事务已放弃。",
      );
    }
    const after = toView(afterRow, names);
    const auditSeq = appendAudit(
      db,
      {
        taskId: null,
        actorType: DISPATCH_ACTOR.actorType,
        actorId: DISPATCH_ACTOR.actorId,
        action: "state_change",
        target: o.ruleId,
        payload: {
          kind: "dispatch_rule_updated" satisfies DispatchRuleAuditKind,
          rule_id: o.ruleId,
          changed,
        },
        stateSnapshot: { before, after },
        createdAt: o.nowMs,
      },
      () => o.nowMs,
    );
    return { ok: true, rule: after, auditSeq };
  });
}
