/**
 * ⚠⚠ 今天【零生产入口】：members/service.ts 的读写只被 test/members/service.test.ts 调，
 * HTTP（T10）与桌面 IPC（T11）都还没接线 ⚠⚠
 * 接线那天 checkBaseline 方向 B 会红并点名基线里这一行 ⇒ 连横幅一起自删，不等谁记得改文档。
 *
 * 成员服务（T5）：members / member_skills / member_executors / hire_events 的唯一写路径。
 *
 * ── 这个文件为什么存在 ──────────────────────────────────────────────
 * 成员 = persona + skills + executors + model_tier 四件套（D4/设计 §512），外加
 * 真人感三件（avatar/voice/tone，D13）。四件套 = 四张表，一次招聘 = 跨四张表的
 * 多行写。判据若散在 HTTP 与 IPC 两个入口，就是「同一张图，两个入口，两种答案」
 * 那族老病（roles/service.ts 文件头立过同样的案）。入口都调这里。
 *
 * ── 招聘为什么是一条不可分的事务流水线 ────────────────────────────
 * 建成员 → 挂技能 → 挂执行器 → 记 hire_events → 落座。拆成多段 node() 会出现
 * 「有档案没执行器的人」——执行器是成员能干活的前提（D4），半聘的人比没聘更糟：
 * 列表里看得见、@他没人动、会议点名没人说话。「招完即上岗」（契约
 * seat_group_ids 注释）因此也在同一事务里：某个群不存在 ⇒ 整单回滚，
 * 而不是「聘成功了但少坐两个群」这种需要用户自己发现的半成功。
 * 回滚代价为零：member_id 是新 UUID，还没有任何外部引用指向它。
 *
 * ── hire_events 台账与 events 审计的分工 ──────────────────────────
 * 两者都写，但记的东西不同：审计（events）记【每一次写】，含改名/改档位这类
 * 不构成人事动作的修改；台账（hire_events）只记 DDL CHECK 焊死的七种人事动作
 * （hired / role_changed / skills_changed / executors_changed / persona_changed /
 * archived / restored）。名字/档位/语气/声音的变更【没有】台账枚举位 —— 这不是漏，
 * 是 0013 的 CHECK 在说「这些不是人事动作」。台账触发器 append-only（两枚 ABORT），
 * 本文件只 INSERT；改错了补一条纠正事件，不改历史。
 * 同值写不记台账：把同一份执行器列表再存一遍不是变更，台账里塞噪声会让
 * 「这个人的配置被谁动过」变成考古。审计仍每次落（有写就要有账）。
 *
 * ── 归档不释放席位（产品判断，登记）──────────────────────────────
 * DELETE /members/:id 的语义是归档（status='archived'），group_members 席位保留：
 * ① 历史消息的归属要说清「发言时他在不在群里」，席位行是唯一的时间点证据；
 * ② roles/service.ts 删除门 ③ 已把归档成员算作角色的引用者（成员是复用资产，
 *    0013 文件头），席位同理 —— 归档是可逆的（restored 台账位在枚举里就说明
 *    设计预期他会回来），释放再重占会把 joined_at 的时间线打断。
 *
 * ── 头像只收 purpose='avatar' 的资产 ──────────────────────────────
 * assets.purpose 的 CHECK 枚举里有 attachment —— 拿附件字节当头像会让渲染层
 * 把一张 xlsx 画进 32px 圆圈。asset_id 存在性检查带 purpose 条件，不存在与
 * 用途不对给同一个 code（asset_not_found）：两者对用户的修复动作都是「换一张图」。
 *
 * ── 读侧守门 ──────────────────────────────────────────────────────
 * JSON 列（persona/voice/config）落库前由 zod 把过，读回时再过一次
 * memberViewSchema —— 与 roles/service.ts 的 assertCharterShape 同一立场：
 * 行在而形状坏 ⇒ 抛，不静默给 null/半份视图。那会把「库里数据坏了」翻译成
 * 「这个人没配人格」，把数据异常伪装成业务事实。手改库正是守门要防的入口。
 *
 * ── newId 可注入 ──────────────────────────────────────────────────
 * 招聘的 member_id 默认 randomUUID；注入点形状沿用 bindings/im.ts:355 的
 * `o.newId ?? randomUUID` 先例 —— 测试要断言落库行，就得先知道 id；
 * 将来回放（replay）要逐字节复现，随机源必须是可换的。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CEO_ROLE_ID,
  type ExecutorConfig,
  type HireMemberRequest,
  type MemberExecutor,
  type MemberSkill,
  type MemberView,
  type ModelTier,
  memberViewSchema,
  type Persona,
  type RejectCode,
  type Tone,
  type UpdateMemberRequest,
  type Voice,
} from "@opc/contracts";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import {
  assertParamCount,
  assertSingleStatement,
  type Writer,
} from "../db/write-queue.js";
import { appendAudit } from "../events/recorder.js";

/** 审计署名：与 roles/service.ts 的 ROLE_ACTOR 同一个「人」（§4.2.3 权集中于老板）。 */
const MEMBER_ACTOR = { actorType: "human", actorId: CEO_ROLE_ID } as const;

/**
 * hire_events.action 的七种取值 —— 逐字对齐 0013 的 CHECK 枚举。
 * 台账是 append-only 的人事动作流水；测试拿这份常量与 DDL 的 CHECK 词表对账
 * （test/members/service.test.ts），漂了就在断言里现形而不是在 INSERT 时炸。
 */
export const HIRE_EVENT_ACTIONS = [
  "hired",
  "role_changed",
  "skills_changed",
  "executors_changed",
  "persona_changed",
  "archived",
  "restored",
] as const;
export type HireEventAction = (typeof HIRE_EVENT_ACTIONS)[number];

/** 审计 payload.kind 的四个取值（action 恒为 state_change，与角色侧审计 kinds 同族）。 */
export const MEMBER_AUDIT_KINDS = [
  "member_hired",
  "member_updated",
  "member_skills_set",
  "member_executors_set",
] as const;
export type MemberAuditKind = (typeof MEMBER_AUDIT_KINDS)[number];

/**
 * 服务层自己造的错误码。RejectCode 之外的那些：
 *  · member_not_found —— 路径里的成员不存在（404 的原料）；
 *  · role_not_found —— role_id 指到不存在的岗位（422：请求引用了不存在的既有资源。
 *    不先查会被 FK 拦成一条 FOREIGN KEY constraint failed 的 500，方向指错）；
 *  · asset_not_found —— 头像资产不存在或用途不对（见文件头）；
 *  · group_not_found —— 落座的群不存在（422，同 role_not_found 的方向）；
 *  · duplicate_skill_id / duplicate_executor_seq —— 数组里自带重复键：
 *    HTTP 体的 superRefine 已拦（契约只管 seq），本层两个都查是因为 setSkills /
 *    setExecutors 的请求形状在 T10 才定形，而 (member_id, skill_id) 撞 PK 会炸 500；
 *  · empty_executor_chain —— 执行器链清空：零执行器的成员「在列表里但什么都干不了」，
 *    语义请求坏了（422），不是服务器坏了。
 *  未列出的 code 全是 RejectCode ⇒ 422，默认分支就是它们的映射（同 roleServiceStatus）。
 */
export type MemberServiceCode =
  | "member_not_found"
  | "role_not_found"
  | "asset_not_found"
  | "group_not_found"
  | "duplicate_skill_id"
  | "duplicate_executor_seq"
  | "empty_executor_chain"
  | "not_writable"
  | RejectCode;

export type MemberServiceError = {
  ok: false;
  reason: string;
  code: MemberServiceCode;
};

/** 招聘成功：成员视图 + 审计游标 + 实际落座的群（回滚语义下要么全坐要么没这单）。 */
export type HireResult =
  | {
      ok: true;
      member: MemberView;
      auditSeq: number;
      seated_group_ids: string[];
    }
  | MemberServiceError;

/** 改成员/改挂载成功：成员视图 + 审计游标。 */
export type MemberWriteResult =
  | { ok: true; member: MemberView; auditSeq: number }
  | MemberServiceError;

export function memberServiceStatus(code: MemberServiceCode): number {
  switch (code) {
    case "member_not_found":
      return 404;
    case "not_writable":
      return 500;
    default:
      return 422;
  }
}

/** 只读侧的最小连接形状（同 roles/service.ts 的 DbLike 手法）。 */
type DbLike = Pick<DatabaseSync, "prepare">;

/** members 行形状（persona_json/voice_json 是 JSON 文本列，读侧守门再 parse）。 */
interface MemberRow {
  member_id: string;
  name: string;
  role_id: string;
  persona_json: string;
  model_tier: string;
  avatar_asset_id: string | null;
  avatar_seed: string;
  voice_json: string | null;
  tone: string;
  status: string;
  hired_at: number | bigint;
  updated_at: number | bigint;
}

interface SkillRow {
  skill_id: string;
  name: string;
  note: string | null;
}

interface ExecutorRow {
  seq: number | bigint;
  kind: string;
  config_json: string;
  enabled: number | bigint;
}

/** hire_events 台账行（读侧形状；from/to 是 JSON 文本，装配时 parse）。 */
export interface HireEventRow {
  id: number;
  member_id: string;
  action: HireEventAction;
  from: MemberView | null;
  to: MemberView;
  at: number;
}

const MEMBER_COLS =
  "member_id, name, role_id, persona_json, model_tier, avatar_asset_id, " +
  "avatar_seed, voice_json, tone, status, hired_at, updated_at";

const SELECT_MEMBER_SQL =
  "SELECT " + MEMBER_COLS + " FROM members WHERE member_id = ?";

/** 列表：status 传 null = 全量（通讯录要能看到归档的人）。 */
export const LIST_MEMBERS_SQL =
  "SELECT " +
  MEMBER_COLS +
  " FROM members WHERE (? IS NULL OR status = ?) ORDER BY hired_at, member_id";

/** 技能按 skill_id、执行器按 seq 定序：视图进审计快照，非确定序会破逐字节重放。 */
const SKILLS_SQL =
  "SELECT skill_id, name, note FROM member_skills WHERE member_id = ? ORDER BY skill_id";

const EXECUTORS_SQL =
  "SELECT seq, kind, config_json, enabled FROM member_executors " +
  "WHERE member_id = ? ORDER BY seq";

const HIRE_EVENTS_SQL =
  "SELECT id, member_id, action, from_json, to_json, at FROM hire_events " +
  "WHERE member_id = ? ORDER BY id";

const INSERT_MEMBER_SQL =
  "INSERT INTO members (member_id, name, role_id, persona_json, model_tier, " +
  "avatar_asset_id, avatar_seed, voice_json, tone, status, hired_at, updated_at) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

const INSERT_SKILL_SQL =
  "INSERT INTO member_skills (member_id, skill_id, name, note) VALUES (?, ?, ?, ?)";

const INSERT_EXECUTOR_SQL =
  "INSERT INTO member_executors (member_id, seq, kind, config_json, enabled) " +
  "VALUES (?, ?, ?, ?, ?)";

const INSERT_HIRE_EVENT_SQL =
  "INSERT INTO hire_events (member_id, action, from_json, to_json, at) " +
  "VALUES (?, ?, ?, ?, ?)";

/**
 * COALESCE(?, voice_json)：PATCH 语义「没传 = 不动」。voice 是唯一可空列，
 * 也是唯一「清空」表达不出来的字段（契约没有 voice: null 的形状）—— 能配默认音
 * 不能退回到没配，是有意的：TTS 音色一旦定了就恒有值，回落逻辑留给浏览器能力集（voiceSchema 注释）。
 */
const UPDATE_MEMBER_SQL =
  "UPDATE members SET name = ?, role_id = ?, model_tier = ?, persona_json = ?, " +
  "tone = ?, voice_json = COALESCE(?, voice_json), status = ?, updated_at = ? " +
  "WHERE member_id = ?";

/** 挂载替换（set 语义）：整删整插，差集计算留给调用方 —— 台账只认「最终形状变了没」。 */
const DELETE_SKILLS_SQL = "DELETE FROM member_skills WHERE member_id = ?";

const DELETE_EXECUTORS_SQL = "DELETE FROM member_executors WHERE member_id = ?";

const ROLE_EXISTS_SQL = "SELECT 1 AS ok FROM roles WHERE role_id = ?";

/** 头像必须 purpose='avatar'（文件头：附件字节画进 32px 圆圈是渲染事故）。 */
const AVATAR_EXISTS_SQL =
  "SELECT 1 AS ok FROM assets WHERE asset_id = ? AND purpose = 'avatar'";

/** 落座的群必须存在。active/archived 都放行？不 —— archived 群拒（见 seatGroups）。 */
const GROUP_ROW_SQL = "SELECT status FROM groups WHERE group_id = ?";

const INSERT_SEAT_SQL =
  "INSERT INTO group_members (group_id, member_id, role_id, seat, joined_at) " +
  "VALUES (?, ?, ?, 'member', ?)";

function err(code: MemberServiceCode, reason: string): MemberServiceError {
  return { ok: false, reason, code };
}

function exists(db: DbLike, sql: string, params: unknown[]): boolean {
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  return db.prepare(sql).get(...(params as never[])) !== undefined;
}

// ── 读侧装配 ────────────────────────────────────────────────────────

/**
 * 行 + 挂载 → MemberView（读侧唯一守门）。
 * memberViewSchema.parse 一次判完 persona/voice/config 三份 JSON 与所有枚举：
 * 手改库改坏任何一列都在这里抛，而不是让半份视图流进列表页。
 * 抛错带 member_id —— 守门红时要能直接定位是哪一行。
 */
function assembleMember(
  db: DbLike,
  row: MemberRow,
): { ok: true; view: MemberView } | { ok: false; reason: string } {
  const skillSql = SKILLS_SQL;
  const skillParams = [row.member_id];
  assertSingleStatement(skillSql);
  assertParamCount(skillSql, skillParams);
  const skillRows = db
    .prepare(skillSql)
    .all(...(skillParams as never[])) as unknown as SkillRow[];
  const exSql = EXECUTORS_SQL;
  assertSingleStatement(exSql);
  assertParamCount(exSql, skillParams);
  const exRows = db
    .prepare(exSql)
    .all(...(skillParams as never[])) as unknown as ExecutorRow[];
  let persona: Persona;
  let voice: Voice | null;
  let executors: MemberExecutor[];
  let skills: MemberSkill[];
  try {
    persona = JSON.parse(row.persona_json) as Persona;
    voice =
      row.voice_json === null ? null : (JSON.parse(row.voice_json) as Voice);
    executors = exRows.map((e) => ({
      seq: Number(e.seq),
      kind: e.kind as MemberExecutor["kind"],
      config: JSON.parse(e.config_json) as ExecutorConfig,
      enabled: Number(e.enabled) === 1,
    }));
    skills = skillRows.map((s) => ({
      skill_id: s.skill_id,
      name: s.name,
      ...(s.note === null ? {} : { note: s.note }),
    }));
  } catch (e) {
    // JSON.parse 炸 = 列里不是合法 JSON（手改库/半截写入）。抛，不翻译成 null。
    return {
      ok: false,
      reason:
        "成员 [" +
        row.member_id +
        "] 的 JSON 列坏了（" +
        (e instanceof Error ? e.message : String(e)) +
        "），读侧拒绝装配。",
    };
  }
  const candidate = {
    member_id: row.member_id,
    name: row.name,
    role_id: row.role_id,
    model_tier: row.model_tier as ModelTier,
    persona,
    tone: row.tone as Tone,
    voice,
    avatar_asset_id: row.avatar_asset_id,
    avatar_seed: row.avatar_seed,
    skills,
    executors,
    status: row.status as "active" | "archived",
    hired_at: Number(row.hired_at),
    updated_at: Number(row.updated_at),
  };
  const parsed = memberViewSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      reason:
        "成员 [" +
        row.member_id +
        "] 的行形状与契约不一致：" +
        parsed.error.issues
          .map((i) => i.path.join(".") + " " + i.message)
          .join("；"),
    };
  }
  return { ok: true, view: parsed.data };
}

function getRow(db: DbLike, memberId: string): MemberRow | undefined {
  const sql = SELECT_MEMBER_SQL;
  const params = [memberId];
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  return db.prepare(sql).get(...(params as never[])) as MemberRow | undefined;
}

/**
 * 读一个成员的视图；undefined = 库里没有。
 * ⚠ 装配失败（JSON 坏）抛错 —— 调用方拿到 undefined 或视图，不会拿到半份真相。
 */
export function getMember(
  db: DbLike,
  memberId: string,
): MemberView | undefined {
  const row = getRow(db, memberId);
  if (row === undefined) return undefined;
  const a = assembleMember(db, row);
  if (!a.ok) throw new Error("getMember：" + a.reason);
  return a.view;
}

/** 成员列表。status 缺省 = 全量（通讯录含归档）。 */
export function listMembers(
  db: DbLike,
  status: "active" | "archived" | null = null,
): MemberView[] {
  const sql = LIST_MEMBERS_SQL;
  const params = [status, status];
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  const rows = db
    .prepare(sql)
    .all(...(params as never[])) as unknown as MemberRow[];
  return rows.map((row) => {
    const a = assembleMember(db, row);
    if (!a.ok) throw new Error("listMembers：" + a.reason);
    return a.view;
  });
}

/** 成员名（群服务拼错误消息/报到消息用；不存在给 null，读侧不抛不炸调用方）。 */
export function memberName(db: DbLike, memberId: string): string | null {
  const sql = "SELECT name FROM members WHERE member_id = ?";
  const params = [memberId];
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  const row = db.prepare(sql).get(...(params as never[])) as
    | { name: string }
    | undefined;
  return row === undefined ? null : row.name;
}

/**
 * 招聘/变更台账（GET /members/:id/events 的原料，验收 §7-2「入职事件落库」判的就是它）。
 * from/to 快照 parse 失败 ⇒ 抛：台账是历史证据，坏证据与没证据必须可区分。
 */
export function listHireEvents(db: DbLike, memberId: string): HireEventRow[] {
  const sql = HIRE_EVENTS_SQL;
  const params = [memberId];
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  const rows = db.prepare(sql).all(...(params as never[])) as unknown as {
    id: number | bigint;
    member_id: string;
    action: string;
    from_json: string | null;
    to_json: string;
    at: number | bigint;
  }[];
  return rows.map((r) => ({
    id: Number(r.id),
    member_id: r.member_id,
    action: r.action as HireEventAction,
    from: r.from_json === null ? null : (JSON.parse(r.from_json) as MemberView),
    to: JSON.parse(r.to_json) as MemberView,
    at: Number(r.at),
  }));
}

// ── 内部写原语 ──────────────────────────────────────────────────────

function writeSkills(
  db: DbLike,
  memberId: string,
  skills: readonly MemberSkill[],
): void {
  for (const s of skills) {
    const params: unknown[] = [memberId, s.skill_id, s.name, s.note ?? null];
    assertSingleStatement(INSERT_SKILL_SQL);
    assertParamCount(INSERT_SKILL_SQL, params);
    db.prepare(INSERT_SKILL_SQL).run(...(params as never[]));
  }
}

function writeExecutors(
  db: DbLike,
  memberId: string,
  executors: readonly MemberExecutor[],
): void {
  for (const e of executors) {
    const params: unknown[] = [
      memberId,
      e.seq,
      e.kind,
      JSON.stringify(e.config),
      e.enabled ? 1 : 0,
    ];
    assertSingleStatement(INSERT_EXECUTOR_SQL);
    assertParamCount(INSERT_EXECUTOR_SQL, params);
    db.prepare(INSERT_EXECUTOR_SQL).run(...(params as never[]));
  }
}

function appendHireEvent(
  db: DbLike,
  memberId: string,
  action: HireEventAction,
  from: MemberView | null,
  to: MemberView,
  at: number,
): void {
  const params: unknown[] = [
    memberId,
    action,
    from === null ? null : JSON.stringify(from),
    JSON.stringify(to),
    at,
  ];
  assertSingleStatement(INSERT_HIRE_EVENT_SQL);
  assertParamCount(INSERT_HIRE_EVENT_SQL, params);
  db.prepare(INSERT_HIRE_EVENT_SQL).run(...(params as never[]));
}

/** 数组内重复键检查（文件头：撞 PK 会炸 500，这里翻成人话 422）。 */
function dupSkillId(skills: readonly MemberSkill[]): string | null {
  const seen = new Set<string>();
  for (const s of skills) {
    if (seen.has(s.skill_id)) return s.skill_id;
    seen.add(s.skill_id);
  }
  return null;
}

function dupExecutorSeq(executors: readonly MemberExecutor[]): number | null {
  const seen = new Set<number>();
  for (const e of executors) {
    if (seen.has(e.seq)) return e.seq;
    seen.add(e.seq);
  }
  return null;
}

/** 挂载形状比较（台账判「真变了没」）：序列化前按主键定序，数组输入序不算变更。 */
function skillsKey(skills: readonly MemberSkill[]): string {
  return JSON.stringify(
    [...skills]
      .sort((a, b) => (a.skill_id < b.skill_id ? -1 : 1))
      .map((s) => [s.skill_id, s.name, s.note ?? null]),
  );
}

function executorsKey(executors: readonly MemberExecutor[]): string {
  return JSON.stringify(
    [...executors]
      .sort((a, b) => a.seq - b.seq)
      .map((e) => [e.seq, e.kind, e.config, e.enabled]),
  );
}

/** 读视图（内部）：装配失败直接抛 —— 写函数进来时成员刚被自己写过，坏形状是不变量破坏。 */
function mustView(db: DbLike, memberId: string): MemberView {
  const row = getRow(db, memberId);
  if (row === undefined) {
    throw new Error(
      "members/service：读不回成员 [" +
        memberId +
        "]，事务内不变量破坏，回滚。",
    );
  }
  const a = assembleMember(db, row);
  if (!a.ok) throw new Error("members/service：" + a.reason);
  return a.view;
}

// ── 写侧 ────────────────────────────────────────────────────────────

/**
 * 招聘（D4/D7/设计 §2.3.1）：四件套 + 入职台账 + 可选落座，一个事务。
 * 落座的群去重后按 id 定序插入：member_ids 里同一个群写两遍不该炸 PK。
 * 群不存在或已归档 ⇒ 整单回滚（文件头「流水线不可分」）；archived 群拒的
 * 理由与 groups 侧同一条：归档容器不再进新人，要人先恢复群。
 */
export async function hireMember(
  w: Writer,
  o: {
    readonly req: HireMemberRequest;
    readonly nowMs: number;
    readonly newId?: () => string;
  },
): Promise<HireResult> {
  return w.node(() => {
    const db = requireScopeDb("hireMember");
    if (!exists(db, ROLE_EXISTS_SQL, [o.req.role_id])) {
      return err(
        "role_not_found",
        "岗位 [" +
          o.req.role_id +
          "] 不存在：先建角色（或选一个已有岗位）再招聘。",
      );
    }
    if (
      o.req.avatar_asset_id !== undefined &&
      !exists(db, AVATAR_EXISTS_SQL, [o.req.avatar_asset_id])
    ) {
      return err(
        "asset_not_found",
        "头像资产 [" +
          o.req.avatar_asset_id +
          "] 不存在或不是图片资产（purpose 必须是 avatar）。",
      );
    }
    const dupSkill = dupSkillId(o.req.skills);
    if (dupSkill !== null) {
      return err(
        "duplicate_skill_id",
        "技能 skill_id=[" +
          dupSkill +
          "] 重复：重复项在挂载表里会互相覆盖，等于没挂。",
      );
    }
    const dupSeq = dupExecutorSeq(o.req.executors);
    if (dupSeq !== null) {
      return err(
        "duplicate_executor_seq",
        "执行器 seq=" +
          dupSeq +
          " 重复：优先级并列时「换下一个执行器重试」无从定义。",
      );
    }
    const seatIds = [...new Set(o.req.seat_group_ids)].sort();
    for (const gid of seatIds) {
      assertSingleStatement(GROUP_ROW_SQL);
      assertParamCount(GROUP_ROW_SQL, [gid]);
      const g = db.prepare(GROUP_ROW_SQL).get(...([gid] as never[])) as
        | { status: string }
        | undefined;
      if (g === undefined) {
        return err(
          "group_not_found",
          "群 [" +
            gid +
            "] 不存在，整单招聘已回滚（不允许「聘成功但少坐群」的半成功）。",
        );
      }
      if (g.status !== "active") {
        return err(
          "group_not_found",
          "群 [" + gid + "] 已归档，不再进新成员：要人先把群恢复。整单已回滚。",
        );
      }
    }

    const memberId = o.newId?.() ?? randomUUID();
    const insertParams: unknown[] = [
      memberId,
      o.req.name,
      o.req.role_id,
      JSON.stringify(o.req.persona),
      o.req.model_tier,
      o.req.avatar_asset_id ?? null,
      o.req.avatar_seed ?? "",
      o.req.voice === undefined ? null : JSON.stringify(o.req.voice),
      o.req.tone,
      "active",
      o.nowMs,
      o.nowMs,
    ];
    assertSingleStatement(INSERT_MEMBER_SQL);
    assertParamCount(INSERT_MEMBER_SQL, insertParams);
    db.prepare(INSERT_MEMBER_SQL).run(...(insertParams as never[]));
    writeSkills(db, memberId, o.req.skills);
    writeExecutors(db, memberId, o.req.executors);

    const view = mustView(db, memberId);
    appendHireEvent(db, memberId, "hired", null, view, o.nowMs);

    for (const gid of seatIds) {
      const seatParams: unknown[] = [gid, memberId, o.req.role_id, o.nowMs];
      assertSingleStatement(INSERT_SEAT_SQL);
      assertParamCount(INSERT_SEAT_SQL, seatParams);
      db.prepare(INSERT_SEAT_SQL).run(...(seatParams as never[]));
    }

    const auditSeq = appendAudit(
      db,
      {
        taskId: null,
        actorType: MEMBER_ACTOR.actorType,
        actorId: MEMBER_ACTOR.actorId,
        action: "state_change",
        target: memberId,
        payload: {
          kind: "member_hired" satisfies MemberAuditKind,
          member_id: memberId,
          role_id: o.req.role_id,
          model_tier: o.req.model_tier,
          executor_kinds: o.req.executors.map((e) => e.kind),
          skill_count: o.req.skills.length,
          seat_group_ids: seatIds,
        },
        stateSnapshot: { before: null, after: view },
        createdAt: o.nowMs,
      },
      () => o.nowMs,
    );
    return { ok: true, member: view, auditSeq, seated_group_ids: seatIds };
  });
}

/**
 * 改成员（PATCH：没传 = 不动）。台账按 CHECK 的口径拆事件：
 * role_id 变 ⇒ role_changed；persona 变 ⇒ persona_changed；status 翻转 ⇒
 * archived/restored。一次 PATCH 同时改岗位和人格 ⇒ 两条事件（台账是动作流水，
 * 不是 PATCH 镜像；合成一条会让「他只换了岗」这种历史问题失去答案）。
 * name/model_tier/tone/voice 没有台账位 —— 文件头「不是人事动作」那条。
 * archived 成员可改配置（改完仍是归档），但 status 翻转只能在这一个函数里做，
 * 归档态不拦 PATCH 本身：CEO 要在归档前把档案修好。
 */
export async function updateMember(
  w: Writer,
  o: {
    readonly memberId: string;
    readonly req: UpdateMemberRequest;
    readonly nowMs: number;
  },
): Promise<MemberWriteResult> {
  return w.node(() => {
    const db = requireScopeDb("updateMember");
    const row = getRow(db, o.memberId);
    if (row === undefined) {
      return err(
        "member_not_found",
        "成员 [" + o.memberId + "] 不存在，没有任何东西被改。",
      );
    }
    if (
      o.req.role_id !== undefined &&
      o.req.role_id !== row.role_id &&
      !exists(db, ROLE_EXISTS_SQL, [o.req.role_id])
    ) {
      return err(
        "role_not_found",
        "岗位 [" + o.req.role_id + "] 不存在：成员不能挂到不存在的岗位上。",
      );
    }
    const before = mustView(db, o.memberId);
    const nextRoleId = o.req.role_id ?? row.role_id;
    const nextName = o.req.name ?? row.name;
    const nextTier = o.req.model_tier ?? row.model_tier;
    const nextTone = o.req.tone ?? row.tone;
    const nextStatus = o.req.status ?? row.status;
    const nextPersonaJson =
      o.req.persona === undefined
        ? row.persona_json
        : JSON.stringify(o.req.persona);

    const changed: string[] = [];
    if (nextName !== row.name) changed.push("name");
    if (nextRoleId !== row.role_id) changed.push("role_id");
    if (nextTier !== row.model_tier) changed.push("model_tier");
    if (nextTone !== row.tone) changed.push("tone");
    if (o.req.voice !== undefined) changed.push("voice");
    if (nextPersonaJson !== row.persona_json) changed.push("persona");
    if (nextStatus !== row.status) changed.push("status");

    const params: unknown[] = [
      nextName,
      nextRoleId,
      nextTier,
      nextPersonaJson,
      nextTone,
      o.req.voice === undefined ? null : JSON.stringify(o.req.voice),
      nextStatus,
      o.nowMs,
      o.memberId,
    ];
    assertSingleStatement(UPDATE_MEMBER_SQL);
    assertParamCount(UPDATE_MEMBER_SQL, params);
    db.prepare(UPDATE_MEMBER_SQL).run(...(params as never[]));

    const after = mustView(db, o.memberId);
    if (nextRoleId !== row.role_id) {
      appendHireEvent(db, o.memberId, "role_changed", before, after, o.nowMs);
    }
    if (nextPersonaJson !== row.persona_json) {
      appendHireEvent(
        db,
        o.memberId,
        "persona_changed",
        before,
        after,
        o.nowMs,
      );
    }
    if (nextStatus !== row.status) {
      appendHireEvent(
        db,
        o.memberId,
        nextStatus === "archived" ? "archived" : "restored",
        before,
        after,
        o.nowMs,
      );
    }

    const auditSeq = appendAudit(
      db,
      {
        taskId: null,
        actorType: MEMBER_ACTOR.actorType,
        actorId: MEMBER_ACTOR.actorId,
        action: "state_change",
        target: o.memberId,
        payload: {
          kind: "member_updated" satisfies MemberAuditKind,
          member_id: o.memberId,
          changed,
        },
        stateSnapshot: { before, after },
        createdAt: o.nowMs,
      },
      () => o.nowMs,
    );
    return { ok: true, member: after, auditSeq };
  });
}

/**
 * 替换技能挂载（set 语义）。台账只在最终形状真的变了时记一条 skills_changed ——
 * 文件头「同值写不记台账」。挂载替换不影响 members 行的 updated_at？影响：
 * updated_at 语义是「这个成员的档案最后一次变」，挂载是档案的一部分。
 */
export async function setMemberSkills(
  w: Writer,
  o: {
    readonly memberId: string;
    readonly skills: readonly MemberSkill[];
    readonly nowMs: number;
  },
): Promise<MemberWriteResult> {
  return w.node(() => {
    const db = requireScopeDb("setMemberSkills");
    if (getRow(db, o.memberId) === undefined) {
      return err(
        "member_not_found",
        "成员 [" + o.memberId + "] 不存在，没有任何东西被挂。",
      );
    }
    const dup = dupSkillId(o.skills);
    if (dup !== null) {
      return err(
        "duplicate_skill_id",
        "技能 skill_id=[" +
          dup +
          "] 重复：重复项在挂载表里会互相覆盖，等于没挂。",
      );
    }
    const before = mustView(db, o.memberId);
    const delParams: unknown[] = [o.memberId];
    assertSingleStatement(DELETE_SKILLS_SQL);
    assertParamCount(DELETE_SKILLS_SQL, delParams);
    db.prepare(DELETE_SKILLS_SQL).run(...(delParams as never[]));
    writeSkills(db, o.memberId, o.skills);

    const after = mustView(db, o.memberId);
    if (skillsKey(before.skills) !== skillsKey(after.skills)) {
      appendHireEvent(db, o.memberId, "skills_changed", before, after, o.nowMs);
    }
    const auditSeq = appendAudit(
      db,
      {
        taskId: null,
        actorType: MEMBER_ACTOR.actorType,
        actorId: MEMBER_ACTOR.actorId,
        action: "state_change",
        target: o.memberId,
        payload: {
          kind: "member_skills_set" satisfies MemberAuditKind,
          member_id: o.memberId,
          skill_ids: o.skills.map((s) => s.skill_id),
        },
        stateSnapshot: { before, after },
        createdAt: o.nowMs,
      },
      () => o.nowMs,
    );
    return { ok: true, member: after, auditSeq };
  });
}

/**
 * 替换执行器链（set 语义）。与 skills 同构，多一条底线：executors 不能为空 ——
 * 契约在招聘请求里 min(1)，替换端点没有契约数组形状兜着，而「零执行器的成员」
 * 就是「在列表里但什么都干不了的人」。这里拦，不让它成为可达状态（D4）。
 */
export async function setMemberExecutors(
  w: Writer,
  o: {
    readonly memberId: string;
    readonly executors: readonly MemberExecutor[];
    readonly nowMs: number;
  },
): Promise<MemberWriteResult> {
  return w.node(() => {
    const db = requireScopeDb("setMemberExecutors");
    if (getRow(db, o.memberId) === undefined) {
      return err(
        "member_not_found",
        "成员 [" + o.memberId + "] 不存在，没有任何东西被挂。",
      );
    }
    if (o.executors.length === 0) {
      return err(
        "empty_executor_chain",
        "执行器链不能清空：零执行器的成员什么都干不了（D4）。要停用他请归档成员。",
      );
    }
    const dup = dupExecutorSeq(o.executors);
    if (dup !== null) {
      return err(
        "duplicate_executor_seq",
        "执行器 seq=" +
          dup +
          " 重复：优先级并列时「换下一个执行器重试」无从定义。",
      );
    }
    const before = mustView(db, o.memberId);
    const delParams: unknown[] = [o.memberId];
    assertSingleStatement(DELETE_EXECUTORS_SQL);
    assertParamCount(DELETE_EXECUTORS_SQL, delParams);
    db.prepare(DELETE_EXECUTORS_SQL).run(...(delParams as never[]));
    writeExecutors(db, o.memberId, o.executors);

    const after = mustView(db, o.memberId);
    if (executorsKey(before.executors) !== executorsKey(after.executors)) {
      appendHireEvent(
        db,
        o.memberId,
        "executors_changed",
        before,
        after,
        o.nowMs,
      );
    }
    const auditSeq = appendAudit(
      db,
      {
        taskId: null,
        actorType: MEMBER_ACTOR.actorType,
        actorId: MEMBER_ACTOR.actorId,
        action: "state_change",
        target: o.memberId,
        payload: {
          kind: "member_executors_set" satisfies MemberAuditKind,
          member_id: o.memberId,
          executor_kinds: o.executors.map((e) => e.kind),
        },
        stateSnapshot: { before, after },
        createdAt: o.nowMs,
      },
      () => o.nowMs,
    );
    return { ok: true, member: after, auditSeq };
  });
}

// ── 特助（CoS）供给 ─────────────────────────────────────────────────

/** 内置特助岗位（0011 seed 的 role_id）。建群不变量「每群一个 CoS」的人侧半边。 */
export const COS_ROLE_ID = "cos";

/**
 * 系统 CoS 的人格：措辞即承诺 —— 他在聊天流里以「同事」身份出现（D13 的
 * honesty 立场对他同样成立），所以诚实边界写的是「我不拍板，我只分发与升级」。
 * 这是系统成员唯一的真相源：全库恰好一行 active CoS（见 ensureCosMember），
 * 将来 CEO 改名/换人设走 updateMember，不走这里。
 */
export const COS_PERSONA: Persona = {
  style:
    "接到任务先复述一遍目标，再按规则拆分和分发；不确定就说不确定，不装懂。",
  values: ["规则优先，先查再问老板", "不越权拍板"],
  honesty: "我只是协调与分发，不代表老板拍板；拿不准的会原样升级。",
};

/** CoS 的执行器链：pure-model 兜底（分发决策不依赖外部进程）+ human 真人席（D7 的升级终点）。 */
export const COS_EXECUTORS: MemberExecutor[] = [
  { seq: 1, kind: "pure-model", config: { kind: "pure-model" }, enabled: true },
  { seq: 2, kind: "human", config: { kind: "human" }, enabled: true },
];

const COS_MEMBER_SQL =
  "SELECT member_id FROM members WHERE role_id = ? AND status = 'active' " +
  "ORDER BY hired_at, member_id LIMIT 1";

/**
 * 确保库里有一个可用的 CoS 成员，返回其 member_id（groups/service.ts 的 createGroup
 * 在【同一个事务】里调它 —— 0014 文件头「特助成员先建、群后建，同一事务」的执行处）。
 *
 * 形状是「懒建 + 复用」而不是「每群建一个」：
 *  · 每群一个 CoS 行 ⇒ 通讯录里 N 个一模一样的特助（N = 群数），升级链 D16
 *    的 @老板 语义会变成「@了哪个特助」—— 系统席位不该有可数的分身；
 *  · 懒建（SELECT→有则复用）⇒ 全库恰好一行 active CoS，身份审计可归一；
 *    「恰好一个」靠这条路径唯一（本函数是 CoS 成员的唯一生产入口）+
 *    status 翻转走 updateMember（归档后可懒重建，旧 CoS 留档）。
 *  · roles.cos 行【被删除】是不可达状态（builtin 触发器焊死），到这一步只能抛：
 *    seed 被手抹不是「业务冲突」，是数据异常，翻成 ok:false 会让调用方以为重试有用。
 * 台账与审计照常写（hired + member_hired）：系统成员也是成员，入职历史不许断档。
 */
export function ensureCosMember(
  db: DatabaseSync,
  o: { readonly nowMs: number; readonly newId?: () => string },
): string {
  const findParams: unknown[] = [COS_ROLE_ID];
  assertSingleStatement(COS_MEMBER_SQL);
  assertParamCount(COS_MEMBER_SQL, findParams);
  const found = db.prepare(COS_MEMBER_SQL).get(...(findParams as never[])) as
    | { member_id: string }
    | undefined;
  if (found !== undefined) return found.member_id;

  if (!exists(db, ROLE_EXISTS_SQL, [COS_ROLE_ID])) {
    throw new Error(
      "ensureCosMember：内置岗位 [" +
        COS_ROLE_ID +
        "] 不存在（0011 seed 被抹？）。这是数据异常不是业务冲突，抛错回滚。",
    );
  }
  const memberId = o.newId?.() ?? randomUUID();
  const insertParams: unknown[] = [
    memberId,
    "特助",
    COS_ROLE_ID,
    JSON.stringify(COS_PERSONA),
    "management",
    null,
    COS_ROLE_ID,
    null,
    "steady",
    "active",
    o.nowMs,
    o.nowMs,
  ];
  assertSingleStatement(INSERT_MEMBER_SQL);
  assertParamCount(INSERT_MEMBER_SQL, insertParams);
  db.prepare(INSERT_MEMBER_SQL).run(...(insertParams as never[]));
  writeExecutors(db, memberId, COS_EXECUTORS);

  const view = mustView(db, memberId);
  appendHireEvent(db, memberId, "hired", null, view, o.nowMs);
  appendAudit(
    db,
    {
      taskId: null,
      actorType: MEMBER_ACTOR.actorType,
      actorId: MEMBER_ACTOR.actorId,
      action: "state_change",
      target: memberId,
      payload: {
        kind: "member_hired" satisfies MemberAuditKind,
        member_id: memberId,
        role_id: COS_ROLE_ID,
        system: true,
      },
      stateSnapshot: { before: null, after: view },
      createdAt: o.nowMs,
    },
    () => o.nowMs,
  );
  return memberId;
}
