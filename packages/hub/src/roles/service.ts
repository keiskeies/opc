/**
 * 生产入口：HTTP catalog 路由（http/catalog.ts）统一调用本服务维护角色与公司树。
 *
 * 角色表服务（T4）：roles 公司树的唯一写路径。
 *
 * ── 这个文件为什么存在 ──────────────────────────────────────────────
 * roles（0011）把 COMPANY_NODES 七个写死节点换成了可配置的表（D9）。
 * 「这行能不能删、这次改挂合不合法、这份内嵌岗位书收不收」—— 判据若散在
 * HTTP（T10）与桌面 IPC 两个入口，就是两个真相，而本仓治过的那一族缺陷
 * 全叫「同一张图，两个入口，两种答案」。入口都调这里。
 *
 * ── 结构判据用什么、不用什么 ────────────────────────────────────────
 * 复用 contracts 的 L1 纯函数（validateNewNode / validateReparenting），
 * 把 roles 行桥接成 OrgGraph 再判。桥接三处口径，登记在这里是因为它们
 * 【不在】validator 的契约里：
 *  · can_manage 在 roles 表没有列，取 model_tier === "management"。
 *    设计里两者是同一件事（D9：管理档派活、执行档干活），所以不存在
 *    「执行档却能收汇报」的第三种行形状 —— 与其造一个能互相矛盾的列，
 *    不如让矛盾在类型上就写不出来。
 *  · model_family 同样没有列：org 的 L1 两条判据不读它（读它的是 L2 与
 *    commitOrgGraph，那边判的是 delegation_graphs 的图）。这里【不造假值】——
 *    伪造的家族就是伪凭据，将来接 L2 时那一格该是一次真的缺列决策。
 *  · CEO_ROLE_ID（"ceo"）【不是】这棵树的根 —— 根是 boss（0011 注释里的
 *    D1 人类锚点）。两条 L1 判据只读「child 本身是不是 ceo」，从不读
 *    「parent 是不是 ceo」，所以桥接不需要合成节点；而 boss 在服务侧
 *    焊死为唯一根（updateRole 拒改它的 reports_to）。理由不是抄契约常量：
 *    validateNewNode 的 multiple_roots 判据只在「图已有一根」时拦，
 *    若 boss 可改挂，加角色那条路就再也问不出「谁是 CEO」——
 *    运行时的 resolveCeoRoleId 对森林是拒绝起跑的（一轮就是钱）。
 *  · 审计署名沿用 CEO_ROLE_ID：org/commit.ts 与 charter/store.ts 改配置
 *    用的是同一个「人」的署名（§4.2.3 那一份权集中给的是人），
 *    三个文件一个名字，回放里才数得出是一个人改的。
 *
 * ── 删除语义（D9「自定义可删」的全量），三道人审的门 ────────────────
 *  ① builtin 直接拒；触发器 roles_builtin_no_delete 是兜底（isBuiltinTrigger
 *     把它的 ABORT 文案转回同一个 code，而不是让 500 冒领 422 的活）。
 *  ② 有任职席位（group_members.role_id 命中）⇒ 拒，并把群 id 列出来 ——
 *     「该先去哪个群卸任」是用户唯一能行动的信息，光一句「在用」没法行动。
 *  ③ 还是 N 个成员的本职（members.role_id 命中）⇒ 拒。这一条超出设计
 *     「无人任职可删」的字面，加它的理由是 FK：members.role_id 是
 *     NOT NULL REFERENCES roles —— 不判它，DELETE 会被 SQLite 拦成一条
 *     FOREIGN KEY constraint failed，一个指向与真相无关方向的 500。
 *     而且归档成员【也算】引用：成员是可复用资产（0013 文件头），
 *     档案里的成员不该被一次角色删除抽掉岗位。
 *  ④ 有下级 ⇒ 【不拦，改挂】到被删者的上级（树上平移一层，深度只减不增，
 *     永远不会因此撞上 ORG_MAX_DEPTH）。设计那句只判了任职，没判下级；
 *     而 SQLite 外键 NOT NULL（SQLite 默认即 ON）让「留着 children 指向
 *     已删行」物理上不可行 —— 于是二选一：拒删有下级的角色，或改挂。
 *     拒删会把删除功能压缩到只能删叶子，CEO 建一支三层小团队之后
 *     就永远删不掉中间那层。按改挂实现，是产品判断，登记进台账。
 *
 * ── 写前归一：charter_json 只有一个归一点 ──────────────────────────
 * 请求收 snake_case 输入形状，validateCharterDraft（charter/store.ts）是
 * 唯一的归一 + 身份 + schema 闸门；落库的是 camelCase transform 输出 ——
 * 与 saveCharterVersion 同一条口径（那边是版本台账 role_charters，这里是
 * roles 行上的一次性快照；两份存储、一条判据：谁写都必须过那一格）。
 *
 * ── 已登记缺口：model_tier 列与岗位书里的档位不互校 ──────────────────
 * setRoleCharter 只归一不核对：roles.model_tier 与 charter.model_tier 可以
 * 各说各话（validateCharterDraft 是纯函数闸门，不看库里的列，也不该看）。
 * 消费侧已选边：图谱装配（roles/registry.ts）以【生效岗位书】的档位为准，
 * 与 preset 时代引擎吃 Charter.modelTier 同源。今天两侧恒等（seed 档位与
 * 模板档位一致），分叉只可能来自 CEO 手写；真修法留给「档位可改」那次需求：
 * 要么写时互校，要么删列只留一份真相。
 */
import type { DatabaseSync } from "node:sqlite";
import {
  CEO_ROLE_ID,
  type Charter,
  type CharterInput,
  type CreateRoleRequest,
  type OrgGraph,
  type RejectCode,
  type RoleCategory,
  type RoleView,
  type UpdateRoleRequest,
  validateNewNode,
  validateReparenting,
} from "@opc/contracts";
import { assertCharterShape, validateCharterDraft } from "../charter/store.js";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import {
  assertParamCount,
  assertSingleStatement,
  type Writer,
} from "../db/write-queue.js";
import { appendAudit } from "../events/recorder.js";

/** 公司树唯一根（0011 的 D1 人类锚点）。与契约里的 CEO_ROLE_ID 不是一回事，见文件头。 */
export const HUMAN_ANCHOR_ROLE_ID = "boss";

/** 审计身份：与 org/commit.ts 的 ORG_ACTOR、charter/store.ts 的 CHARTER_ACTOR 同一个署名。 */
const ROLE_ACTOR = { actorType: "human", actorId: CEO_ROLE_ID } as const;

/** 审计 payload.kind 的四个取值（action 恒为 state_change，区分靠 kind，同 org_graph_changed 那一族）。 */
export const ROLE_AUDIT_KINDS = [
  "role_created",
  "role_updated",
  "role_deleted",
  "role_charter_set",
] as const;
export type RoleAuditKind = (typeof ROLE_AUDIT_KINDS)[number];

/**
 * 服务层自己造的错误码。RejectCode（contracts）之外的那些：
 *  · role_not_found —— 路径里的角色不存在（读侧 404 的原料）；
 *  · builtin_undeletable —— D9 的第一道门；
 *  · role_in_use —— 任职/本职引用（409：先卸任/迁走再删）；
 *  · invalid_charter —— validateCharterDraft 的人话原因原样透传（400：是请求体坏了，不是冲突）；
 *  · not_writable —— 兜底路径：触发器/不变量在【应用层判过之后】仍拦下写。
 *    走到这里必是数据异常（比如 custom 行被手改成 builtin），见各调用点注释。
 */
export type RoleServiceCode =
  | "role_not_found"
  | "builtin_undeletable"
  | "role_in_use"
  | "invalid_charter"
  | "not_writable"
  | RejectCode;

/** 写失败。三个写函数共用这一个形状（T10 按 code 映射状态码，入口不自己猜）。 */
export type RoleServiceError = {
  ok: false;
  reason: string;
  code: RoleServiceCode;
};
export type RoleWriteResult =
  | { ok: true; role: RoleView; auditSeq: number }
  | RoleServiceError;

/**
 * code → HTTP 状态码。放在服务侧而不是 http/*.ts 的理由：桌面 IPC（T11）也要按
 * code 分支，而「role_in_use 算 409」这件事两处各写一遍会漂。
 * 未列出的 code 全是 RejectCode ⇒ 422（语义请求坏了），默认分支就是它们的映射。
 */
export function roleServiceStatus(code: RoleServiceCode): number {
  switch (code) {
    case "role_not_found":
      return 404;
    case "role_in_use":
      return 409;
    case "invalid_charter":
      return 400;
    case "not_writable":
      return 500;
    default:
      return 422;
  }
}

/** 只读侧的最小连接形状（与 org/commit.ts 的 DbLike 同一手法：类型面上就没给写口子）。 */
type DbLike = Pick<DatabaseSync, "prepare">;

/** roles 行（charter_json 不进视图：整份岗位书可能几十 KB，列表页不背这个包）。 */
interface RoleRow {
  role_id: string;
  name: string;
  kind: string;
  category: string;
  reports_to: string | null;
  model_tier: string;
  charter_json: string | null;
  avatar_seed: string;
  created_at: number | bigint;
  updated_at: number | bigint;
}

const SELECT_ROW_SQL =
  "SELECT role_id, name, kind, category, reports_to, model_tier, charter_json, " +
  "avatar_seed, created_at, updated_at FROM roles WHERE role_id = ?";

/** 列表查询。occupant_count = group_members 里坐在这个岗位上的席位数（0014：任职岗位可兼任）。 */
export const LIST_ROLES_SQL =
  "SELECT r.role_id, r.name, r.kind, r.category, r.reports_to, r.model_tier, r.charter_json, " +
  "r.avatar_seed, r.created_at, r.updated_at, " +
  "(SELECT COUNT(*) FROM group_members gm WHERE gm.role_id = r.role_id) AS occupant_count " +
  "FROM roles r ORDER BY r.created_at, r.role_id";

const INSERT_ROLE_SQL =
  "INSERT INTO roles (role_id, name, kind, category, reports_to, model_tier, charter_json, " +
  "avatar_seed, created_at, updated_at) VALUES (?, ?, 'custom', ?, ?, ?, NULL, ?, ?, ?)";

/**
 * COALESCE(?, updated_at) 的四格：PATCH 语义「没传 = 不动」。直接写 ? 的写法
 * 要求调用方先读旧行再回填 —— 那多一次读，而读与写之间别的写者插进来就是
 * 丢更新（WriteQueue 排事务顺序，读在事务外就是旧值）。
 * charter_json 在这条里出现但【本文件的 updateRole 不传】—— PATCH 带岗位书
 * 是将来 IPC 面的直连需求，HTTP 面收 updateRoleRequestSchema 的 strict 会先拒；
 * 判据仍只有 validateCharterDraft 一处，见 setRoleCharter 的注释。
 */
const UPDATE_ROLE_SQL =
  "UPDATE roles SET name = ?, category = ?, model_tier = ?, avatar_seed = ?, " +
  "reports_to = ?, charter_json = COALESCE(?, charter_json), updated_at = ? " +
  "WHERE role_id = ?";

const UPDATE_CHARTER_SQL =
  "UPDATE roles SET charter_json = ?, updated_at = ? WHERE role_id = ?";

/** 删除前取【直接下级】（改挂的对象；深层子孙经 FK 自动留在原位，不用碰）。 */
export const CHILDREN_SQL =
  "SELECT role_id FROM roles WHERE reports_to = ? ORDER BY role_id";

/** 本职引用（0013）：members.role_id NOT NULL REFERENCES roles —— 删角色前先问它（文件头门 ③）。 */
export const HOME_MEMBERS_COUNT_SQL =
  "SELECT COUNT(*) AS n FROM members WHERE role_id = ?";

const DELETE_ROLE_SQL = "DELETE FROM roles WHERE role_id = ?";

/**
 * 任职席位所在群（错误消息用，排序固定便于断言）。LIMIT 由 SQLite 的默认无上限
 * 语义即可 —— 单人公司的群量级是几十，不需要分页。
 */
export const OCCUPANT_GROUPS_SQL =
  "SELECT DISTINCT gm.group_id AS group_id FROM group_members gm WHERE gm.role_id = ? " +
  "ORDER BY gm.group_id";

function err(code: RoleServiceCode, reason: string): RoleServiceError {
  return { ok: false, reason, code };
}

/**
 * 触发器兜底的识别：roles_builtin_no_delete / roles_builtin_no_rekind 的 ABORT
 * 文案都以「内置角色不可」开头（0011 原文）。命中 ⇒ 应用层没拦住而库拦住了 ——
 * 数据形状异常，翻成 not_writable 给人话，而不是让 SQL 文本冒领错误消息。
 * 不命中 ⇒ 原样抛（约束冲突类错误被吞掉，是本仓认定最贵那一类静默）。
 */
function isBuiltinTrigger(e: unknown): boolean {
  return e instanceof Error && e.message.includes("内置角色不可");
}

function rowToView(row: RoleRow, occupantCount: number): RoleView {
  return {
    role_id: row.role_id,
    name: row.name,
    kind: row.kind === "builtin" ? "builtin" : "custom",
    category: row.category as RoleCategory,
    reports_to: row.reports_to,
    model_tier: row.model_tier === "management" ? "management" : "execution",
    occupant_count: occupantCount,
    avatar_seed: row.avatar_seed,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function getRow(
  db: DbLike,
  roleId: string,
): (RoleRow & { occupant_count: number | bigint }) | undefined {
  const sql = SELECT_ROW_SQL;
  const params = [roleId];
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  const row = db.prepare(sql).get(...(params as never[])) as
    | RoleRow
    | undefined;
  if (row === undefined) return undefined;
  const countSql = "SELECT COUNT(*) AS n FROM group_members WHERE role_id = ?";
  assertSingleStatement(countSql);
  assertParamCount(countSql, params);
  const occ = db.prepare(countSql).get(...(params as never[])) as {
    n: number | bigint;
  };
  return { ...row, occupant_count: occ.n };
}

/**
 * roles 表 → OrgGraph 桥接（口径见文件头）。can_manage = 管理档；不造假家族。
 * 排序固定（role_id）：桥接结果进校验器也进审计快照的原料，非确定序会让
 * 「同库重放逐字节一致」这条 0011 立的规矩破在边角上。
 */
export function orgGraphFromRows(rows: readonly RoleRow[]): OrgGraph {
  const nodes: OrgGraph["nodes"] = {};
  for (const r of rows) {
    nodes[r.role_id] = {
      role_id: r.role_id,
      can_manage: r.model_tier === "management",
      reports_to: r.reports_to,
    };
  }
  return { nodes, edges: [] };
}

function readAllRoleRows(db: DbLike): RoleRow[] {
  const sql =
    "SELECT role_id, name, kind, category, reports_to, model_tier, charter_json, " +
    "avatar_seed, created_at, updated_at FROM roles ORDER BY role_id";
  assertSingleStatement(sql);
  // 双重断言：node:sqlite 的 all() 类型面是 Record<string, SQLOutputValue>[]，
  // 与任何具名行类型都「不够重叠」到允许单步 as —— 列形状由上面的 SELECT 逐列钉死。
  return db.prepare(sql).all() as unknown as RoleRow[];
}

// ── 读侧 ────────────────────────────────────────────────────────────

/** 全量角色视图（含 occupant_count）。GET /roles 的装配原料。 */
export function listRoles(db: DbLike): RoleView[] {
  const sql = LIST_ROLES_SQL;
  assertSingleStatement(sql);
  const rows = db.prepare(sql).all() as unknown as (RoleRow & {
    occupant_count: number | bigint;
  })[];
  return rows.map((r) => rowToView(r, Number(r.occupant_count)));
}

/** 单角色视图；undefined = 库里没有（404 的原料）。 */
export function getRole(db: DbLike, roleId: string): RoleView | undefined {
  const row = getRow(db, roleId);
  return row === undefined
    ? undefined
    : rowToView(row, Number(row.occupant_count));
}

/**
 * 单角色 + 内嵌岗位书（编辑表单的装配原料）。
 * charter：null = 该行没有内嵌岗位书（回退 preset 的是 registry，不是这里 ——
 * 读侧如实报「库里没有」，把 fallback 掺进读是第二个真相）。
 */
export function getRoleForEdit(
  db: DbLike,
  roleId: string,
): { role: RoleView; charter: Charter | null } | undefined {
  const row = getRow(db, roleId);
  if (row === undefined) return undefined;
  return {
    role: rowToView(row, Number(row.occupant_count)),
    // 读侧守门与 charter/store.ts 同函数：行存在但 JSON 坏了 ⇒ 抛，不静默报 null。
    // 「库里明明有、读出来是 null」会以「岗位书没配」出面，那是把数据异常翻译成假象。
    charter:
      row.charter_json === null
        ? null
        : assertCharterShape(roleId, JSON.parse(row.charter_json)),
  };
}

// ── 写侧 ────────────────────────────────────────────────────────────

/**
 * 加一个自定义角色（D9：改的是数据不是引擎）。
 * 校验/写/审计在同一个 node() 里：validateNewNode 吃的是【写的那一刻】的树 ——
 * 校验放事务外要先把图交给调用方去查，而 WriteQueue 排的是事务之间的顺序，
 * 读与写夹进两次 node() 就是两个事务，中间允许别的角色变更（同 org/commit.ts
 * 为 graph_version 写夹缝记过的那笔账）。纯函数校验在事务内跑没有任何代价。
 */
export async function createRole(
  w: Writer,
  o: { readonly req: CreateRoleRequest; readonly nowMs: number },
): Promise<RoleWriteResult> {
  return w.node(() => {
    const db = requireScopeDb("createRole");
    const graph = orgGraphFromRows(readAllRoleRows(db));
    const v = validateNewNode(
      {
        role_id: o.req.role_id,
        can_manage: o.req.model_tier === "management",
        reports_to: o.req.reports_to,
      },
      graph,
    );
    if (!v.ok) return err(v.code, v.reason);

    const params: unknown[] = [
      o.req.role_id,
      o.req.name,
      o.req.category,
      o.req.reports_to,
      o.req.model_tier,
      o.req.avatar_seed ?? o.req.role_id,
      o.nowMs,
      o.nowMs,
    ];
    assertSingleStatement(INSERT_ROLE_SQL);
    assertParamCount(INSERT_ROLE_SQL, params);
    db.prepare(INSERT_ROLE_SQL).run(...(params as never[]));

    const created = getRow(db, o.req.role_id);
    if (created === undefined) {
      // 刚 INSERT 完就读不到 ⇒ 事务内自相矛盾（触发器没删行、库没坏），
      // 这不是「不存在」而是不变量坏了：抛错回滚整事务，不能返回 ok 让上层信一个没落的 id。
      throw new Error(
        "createRole：INSERT 之后读不回 [" +
          o.req.role_id +
          "]。同一事务内这是不变量破坏，回滚。",
      );
    }
    const view = rowToView(created, Number(created.occupant_count));
    const auditSeq = appendAudit(
      db,
      {
        taskId: null,
        actorType: ROLE_ACTOR.actorType,
        actorId: ROLE_ACTOR.actorId,
        action: "state_change",
        target: o.req.role_id,
        payload: {
          kind: "role_created" satisfies RoleAuditKind,
          role_id: o.req.role_id,
          reports_to: o.req.reports_to,
          category: o.req.category,
          model_tier: o.req.model_tier,
        },
        stateSnapshot: { before: null, after: view },
        createdAt: o.nowMs,
      },
      () => o.nowMs,
    );
    return { ok: true, role: view, auditSeq };
  });
}

/**
 * 改一个角色（PATCH 语义：没传 = 不动；kind 与 charter_json 不在这一格，见契约注释）。
 * builtin 可改（D9 只焊死「不可删/不可降级」，name/category/档位/汇报线要能迭代），
 * 所以这里对 builtin 唯一的限制是【根不可改挂】—— 文件头第三条口径。
 */
export async function updateRole(
  w: Writer,
  o: {
    readonly roleId: string;
    readonly req: UpdateRoleRequest;
    readonly nowMs: number;
  },
): Promise<RoleWriteResult> {
  return w.node(() => {
    const db = requireScopeDb("updateRole");
    const before = getRow(db, o.roleId);
    if (before === undefined) {
      return err(
        "role_not_found",
        "角色 [" + o.roleId + "] 不存在，没有任何东西被改。",
      );
    }
    const nextName = o.req.name ?? before.name;
    const nextCategory = o.req.category ?? before.category;
    const nextTier = o.req.model_tier ?? before.model_tier;
    const nextSeed = o.req.avatar_seed ?? before.avatar_seed;
    const nextReports = o.req.reports_to ?? before.reports_to;

    if (
      o.roleId === HUMAN_ANCHOR_ROLE_ID &&
      nextReports !== before.reports_to
    ) {
      return err(
        "ceo_is_root",
        "老板 [" +
          HUMAN_ANCHOR_ROLE_ID +
          "] 是公司树的唯一根（D1：老板不执行、只拍板），" +
          "汇报线不可改。给它换上级 = 让「谁是 CEO」失去答案，运行时 resolveCeoRoleId 会拒绝起跑。",
      );
    }

    // 只有汇报线【真的变了】才跑结构校验：改个显示名不该被「上级不是管理角色」误伤。
    // validateReparenting 的 newParent 是非空 string（摘掉 null：契约里 reports_to 不可清空，
    // null 只可能来自库里既有的根行，而根行改挂已在上面焊死）。
    if (nextReports !== before.reports_to && nextReports !== null) {
      const graph = orgGraphFromRows(readAllRoleRows(db));
      const v = validateReparenting(o.roleId, nextReports, graph);
      if (!v.ok) return err(v.code, v.reason);
    }

    const changed = [
      nextName !== before.name ? "name" : null,
      nextCategory !== before.category ? "category" : null,
      nextTier !== before.model_tier ? "model_tier" : null,
      nextSeed !== before.avatar_seed ? "avatar_seed" : null,
      nextReports !== before.reports_to ? "reports_to" : null,
    ].filter((k): k is string => k !== null);

    const params: unknown[] = [
      nextName,
      nextCategory,
      nextTier,
      nextSeed,
      nextReports,
      null, // charter_json：这一格不在这条 PATCH 里（见 UPDATE_ROLE_SQL 注释）
      o.nowMs,
      o.roleId,
    ];
    assertSingleStatement(UPDATE_ROLE_SQL);
    assertParamCount(UPDATE_ROLE_SQL, params);
    try {
      db.prepare(UPDATE_ROLE_SQL).run(...(params as never[]));
    } catch (e) {
      // UPDATE 不碰 kind 列，roles_builtin_no_rekind 理论上摸不到；
      // 兜底留着的不是废话：若有人日后把这条 SQL 扩成 SET kind = ...，这里给出的是
      // 「内置保护」而不是裸 SQL 文本。
      if (isBuiltinTrigger(e)) {
        return err(
          "not_writable",
          "内置保护触发器拦下了这次更新（0011）。应用层没有改 kind 的路径，走到这里说明数据异常。",
        );
      }
      throw e;
    }

    const after = getRow(db, o.roleId);
    if (after === undefined) {
      throw new Error(
        "updateRole：UPDATE 之后读不回 [" +
          o.roleId +
          "]。事务内不变量破坏，回滚。",
      );
    }
    const view = rowToView(after, Number(after.occupant_count));
    const auditSeq = appendAudit(
      db,
      {
        taskId: null,
        actorType: ROLE_ACTOR.actorType,
        actorId: ROLE_ACTOR.actorId,
        action: "state_change",
        target: o.roleId,
        payload: {
          kind: "role_updated" satisfies RoleAuditKind,
          role_id: o.roleId,
          changed,
        },
        stateSnapshot: {
          before: rowToView(before, Number(before.occupant_count)),
          after: view,
        },
        createdAt: o.nowMs,
      },
      () => o.nowMs,
    );
    return { ok: true, role: view, auditSeq };
  });
}

/**
 * 删一个自定义角色（文件头「三道人审的门」逐条对应）。
 * 成功返回里带改挂结果：调用方（T10）要在响应里告诉 CEO「你的三个下级挂去了哪」，
 * 那不是错误，但绝不是「什么都不用说」的静默。
 */
export async function deleteRole(
  w: Writer,
  o: { readonly roleId: string; readonly nowMs: number },
): Promise<
  | {
      ok: true;
      auditSeq: number;
      reattachedTo: string;
      reattachedChildren: readonly string[];
    }
  | RoleServiceError
> {
  return w.node(() => {
    const db = requireScopeDb("deleteRole");
    const row = getRow(db, o.roleId);
    if (row === undefined) {
      return err(
        "role_not_found",
        "角色 [" + o.roleId + "] 不存在，没有任何东西被删。",
      );
    }
    if (row.kind === "builtin") {
      return err(
        "builtin_undeletable",
        "内置角色 [" +
          row.name +
          "] 不可删除（D9）：内置行随迁移而来，删掉等于把公司树凿穿。" +
          "要收掉一个内置岗位：把它改挂到不接活的线下、或在招聘侧不再让它上岗。",
      );
    }

    const countSql = OCCUPANT_GROUPS_SQL;
    const countParams = [o.roleId];
    assertSingleStatement(countSql);
    assertParamCount(countSql, countParams);
    const groups = (
      db.prepare(countSql).all(...(countParams as never[])) as {
        group_id: string;
      }[]
    ).map((g) => g.group_id);
    if (groups.length > 0) {
      return err(
        "role_in_use",
        "角色 [" +
          row.name +
          "] 还有任职席位，群：" +
          groups.join("、") +
          "。" +
          "先在这些群里把人卸任或改挂到别的岗位，再删（D9：任职中不可删）。",
      );
    }

    const homeSql = HOME_MEMBERS_COUNT_SQL;
    assertSingleStatement(homeSql);
    const home = db.prepare(homeSql).get(o.roleId) as { n: number | bigint };
    if (Number(home.n) > 0) {
      return err(
        "role_in_use",
        "角色 [" +
          row.name +
          "] 还是 " +
          Number(home.n) +
          " 个成员的本职岗位（含已归档的——成员是可复用资产）。" +
          "先把这些成员迁走或删掉，再删角色（members.role_id 是指向本表的外键）。",
      );
    }

    const kidsSql = CHILDREN_SQL;
    assertSingleStatement(kidsSql);
    const kids = (
      db.prepare(kidsSql).all(o.roleId) as { role_id: string }[]
    ).map((k) => k.role_id);
    const parent = row.reports_to;
    if (parent === null) {
      // custom 行挂着 null 上级只可能是手写库（validateNewNode 的 multiple_roots
      // 堵了服务侧这条路）。删它会把全树劈成森林 —— 拒绝，并报「去修数据」。
      return err(
        "not_writable",
        "角色 [" +
          o.roleId +
          "] 是 custom 行却带着 null 上级。公司树的根只允许内置 boss（D1），" +
          "这一行是数据异常：请先把它挂回真上级，删除不接受制造森林。",
      );
    }

    const updateChildSql =
      "UPDATE roles SET reports_to = ?, updated_at = ? WHERE role_id = ?";
    try {
      for (const kid of kids) {
        const p: unknown[] = [parent, o.nowMs, kid];
        assertSingleStatement(updateChildSql);
        assertParamCount(updateChildSql, p);
        db.prepare(updateChildSql).run(...(p as never[]));
      }
      const dp = [o.roleId];
      assertSingleStatement(DELETE_ROLE_SQL);
      assertParamCount(DELETE_ROLE_SQL, dp);
      db.prepare(DELETE_ROLE_SQL).run(...(dp as never[]));
    } catch (e) {
      if (isBuiltinTrigger(e)) {
        return err(
          "not_writable",
          "内置保护触发器拦下了这次删除（0011）。kind 已判过 custom 仍被触发器当 builtin 拦，说明数据异常。",
        );
      }
      throw e;
    }

    const auditSeq = appendAudit(
      db,
      {
        taskId: null,
        actorType: ROLE_ACTOR.actorType,
        actorId: ROLE_ACTOR.actorId,
        action: "state_change",
        target: o.roleId,
        payload: {
          kind: "role_deleted" satisfies RoleAuditKind,
          role_id: o.roleId,
          reattached_children: kids,
          reattached_to: parent,
        },
        stateSnapshot: {
          before: rowToView(row, Number(row.occupant_count)),
          after: null,
          children_moved_to: parent,
        },
        createdAt: o.nowMs,
      },
      () => o.nowMs,
    );
    return {
      ok: true,
      auditSeq,
      reattachedTo: parent,
      reattachedChildren: kids,
    };
  });
}

/**
 * 设置/清除角色的内嵌岗位书（0011 的 charter_json）。
 * null = 清除：该角色回到纯汇报节点，图谱装配侧（roles/registry.ts）这一格回退 preset。
 * 写前归一只认 validateCharterDraft 一处 —— 身份不一致（role_id 对不上）与
 * camelCase 误提交的人话原因，都由那边原样透传（含「先认形状再报不一致」那条顺序讲究）。
 */
export async function setRoleCharter(
  w: Writer,
  o: {
    readonly roleId: string;
    readonly charter: CharterInput | null;
    readonly nowMs: number;
  },
): Promise<RoleWriteResult> {
  return w.node(() => {
    const db = requireScopeDb("setRoleCharter");
    const before = getRow(db, o.roleId);
    if (before === undefined) {
      return err(
        "role_not_found",
        "角色 [" + o.roleId + "] 不存在，没有任何东西被写。",
      );
    }
    let json: string | null = null;
    if (o.charter !== null) {
      const draft = validateCharterDraft(o.roleId, o.charter);
      if (!draft.ok) return err("invalid_charter", draft.reason);
      json = JSON.stringify(draft.charter);
    }
    const params: unknown[] = [json, o.nowMs, o.roleId];
    assertSingleStatement(UPDATE_CHARTER_SQL);
    assertParamCount(UPDATE_CHARTER_SQL, params);
    try {
      db.prepare(UPDATE_CHARTER_SQL).run(...(params as never[]));
    } catch (e) {
      if (isBuiltinTrigger(e)) {
        return err(
          "not_writable",
          "内置保护触发器拦下了这次岗位书写入（0011 只焊死 kind/DELETE，走到这里说明数据异常）。",
        );
      }
      throw e;
    }
    const after = getRow(db, o.roleId);
    if (after === undefined) {
      throw new Error(
        "setRoleCharter：UPDATE 之后读不回 [" +
          o.roleId +
          "]。事务内不变量破坏，回滚。",
      );
    }
    const view = rowToView(after, Number(after.occupant_count));
    const auditSeq = appendAudit(
      db,
      {
        taskId: null,
        actorType: ROLE_ACTOR.actorType,
        actorId: ROLE_ACTOR.actorId,
        action: "state_change",
        target: o.roleId,
        payload: {
          kind: "role_charter_set" satisfies RoleAuditKind,
          role_id: o.roleId,
          cleared: o.charter === null,
        },
        // 快照放【解析后的对象】而不是原始 JSON 串：回放里 diff 两份字符串要再解析一次，
        // 而这里已经保证它是 validateCharterDraft 的输出（或 null），解析必成功。
        stateSnapshot: {
          before:
            before.charter_json === null
              ? null
              : JSON.parse(before.charter_json),
          after: json === null ? null : JSON.parse(json),
        },
        createdAt: o.nowMs,
      },
      () => o.nowMs,
    );
    return { ok: true, role: view, auditSeq };
  });
}
