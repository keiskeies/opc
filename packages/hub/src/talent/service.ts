/**
 * 生产入口：HTTP people 路由（http/people.ts）统一调用本服务导入、导出与挂牌人才蓝图。
 *
 * 人才市场服务（T5）：talent_market 的唯一写路径（读侧导出 = 读一条过守门的视图）。
 *
 * ── 这个文件为什么存在 ──────────────────────────────────────────────
 * 市场条目 = 一份自包含的成员蓝图（0020 文件头）。三入口（builtin/imported/
 * published）共用同一形状，导入导出必须互逆：导出的字节重新导入还原出等价档案
 * （round-trip 测试钉在 test/talent/service.test.ts）。判据散进 HTTP 与 IPC 两个
 * 入口就会漂（roles/service.ts 文件头立过同样的案），入口都调这里。
 *
 * ── 导入只挂牌，不直接成成员 ──────────────────────────────────────
 * importTalent 把蓝图挂进本店货架，入职仍走 hireMember：市场条目与招聘之间
 * 不设「导入专用快速通道」。绕开招聘校验的入职会把蓝图里合法的形状之外的
 * 一切问题（落座、审计、台账）留成洞。挂牌后 hire-from-talent = 视图 →
 * hireMemberRequest 的一次映射，两条路径共享同一套门槛。
 *
 * ── 蓝图里的 role_id 必须在新公司存在（整单拒）───────────────────
 * D11：role_id 是稳定语义键。新公司没有「设计负责人」还硬挂到默认岗，成员会
 * 在错误的汇报线里干活——错误要到第一次分发任务才暴露，且没人知道根因是导入。
 * 整单 422 + 明确指名的 reason（缺哪个 role）比静默错挂便宜一个数量级。
 *
 * ── published 条目的 item_id 由 member_id 派生 ────────────────────
 * 挂牌 = upsert（键 'pub:'+member_id）：随机 item_id 会让「重复挂牌」在货架上
 * 堆出同一个人的 N 个过期版本，前端无法分辨哪个最新；派生键让重复挂牌自然
 * 变成刷新（UPDATE payload/name/published_at），货架恒一。下架（DELETE）后
 * 重挂会得到同一把键——幂等，且与 builtin 的固定 id（talent_pm…）同一思路。
 *
 * ── 读侧守门（种子也逃不掉）──────────────────────────────────────
 * payload_json 读回逐条过 talentPayloadSchema（0020 文件头的 ⚠ 说的就是这事）：
 * 少写 config.kind 的种子会让人才页在第一条 builtin 上抛 —— 所以种子字节必须
 * 过契约，测试逐条钉住（test/talent/service.test.ts）。手改库同理：行在而
 * 形状坏 ⇒ 抛，不静默 null（把数据异常伪装成「市场是空的」是最坏的降级）。
 *
 * ── builtin 禁删的双保险 ──────────────────────────────────────────
 * 应用层先查 source，触发器 talent_builtin_no_delete 兜底；已判非 builtin 仍被
 * 触发器拦 ⇒ 数据异常，翻成 not_writable 给人话（roles/service.ts 的
 * isBuiltinTrigger 同族）。下架不碰已按它入职的成员（入职即独立，0020 文件头）。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CEO_ROLE_ID,
  type ImportTalentRequest,
  type MemberView,
  type PublishTalentRequest,
  type RejectCode,
  type TalentItemView,
  type TalentPayload,
  talentItemViewSchema,
  talentPayloadSchema,
} from "@opc/contracts";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import {
  assertParamCount,
  assertSingleStatement,
  type Writer,
} from "../db/write-queue.js";
import { appendAudit } from "../events/recorder.js";
import { getMember } from "../members/service.js";

/** 审计署名：与 roles/members/groups 同一个「人」（§4.2.3 权集中于老板）。 */
const TALENT_ACTOR = { actorType: "human", actorId: CEO_ROLE_ID } as const;

/** 审计 payload.kind 的三个取值（action 恒为 state_change，与其余 *_AUDIT_KINDS 同族）。 */
export const TALENT_AUDIT_KINDS = [
  "talent_imported",
  "talent_published",
  "talent_unlisted",
] as const;
export type TalentAuditKind = (typeof TALENT_AUDIT_KINDS)[number];

/** published 条目键前缀：派生自 member_id（文件头「货架恒一」那条）。测试从这里取同一把键。 */
export const PUBLISHED_ITEM_PREFIX = "pub:";

/**
 * 服务层自己造的错误码：
 *  · talent_not_found —— 条目不存在（404）；
 *  · member_not_found —— 挂牌引用的成员不存在（422：请求体引用）；
 *  · role_not_found —— 蓝图岗位在本店不存在（422，文件头「整单拒」）；
 *  · builtin_undeletable —— 下架内置模板（同 roles 的口径走默认 422）；
 *  · not_writable —— 触发器兜底命中 = 数据异常。
 * 未列出的 code 全是 RejectCode ⇒ 422，默认分支就是它们的映射。
 */
export type TalentServiceCode =
  | "talent_not_found"
  | "member_not_found"
  | "role_not_found"
  | "builtin_undeletable"
  | "not_writable"
  | RejectCode;

export type TalentServiceError = {
  readonly ok: false;
  readonly reason: string;
  readonly code: TalentServiceCode;
};

/** code → HTTP 状态码原料（同 roleServiceStatus / memberServiceStatus 的用法）。 */
export function talentServiceStatus(code: TalentServiceCode): number {
  switch (code) {
    case "talent_not_found":
      return 404;
    case "not_writable":
      return 500;
    default:
      return 422;
  }
}

export type TalentMutationResult =
  | {
      readonly ok: true;
      readonly item: TalentItemView;
      readonly auditSeq: number;
    }
  | TalentServiceError;

type DbLike = Pick<DatabaseSync, "prepare">;

const TALENT_COLS = "item_id, source, name, payload_json, published_at";

const LIST_TALENT_SQL = `SELECT ${TALENT_COLS} FROM talent_market ORDER BY published_at, item_id`;

const TALENT_ROW_SQL = `SELECT ${TALENT_COLS} FROM talent_market WHERE item_id = ?`;

const INSERT_TALENT_SQL =
  "INSERT INTO talent_market (item_id, source, name, payload_json, published_at)" +
  " VALUES (?, ?, ?, ?, ?)";

const UPDATE_PUBLISHED_SQL =
  "UPDATE talent_market SET name = ?, payload_json = ?, published_at = ? WHERE item_id = ?";

const DELETE_TALENT_SQL = "DELETE FROM talent_market WHERE item_id = ?";

const ROLE_EXISTS_SQL = "SELECT 1 AS ok FROM roles WHERE role_id = ?";

/** 触发器兜底识别：talent_builtin_no_delete 的 ABORT 文案以「内置人才模板不可」开头（0020 原文）。 */
function isBuiltinTrigger(e: unknown): boolean {
  return e instanceof Error && e.message.includes("内置人才模板不可");
}

function err(code: TalentServiceCode, reason: string): TalentServiceError {
  return { ok: false, reason, code };
}

/** 行 → 视图：payload 过契约才出口。坏形状 ⇒ 抛（文件头「读侧守门」）。 */
function assembleItem(row: {
  item_id: string;
  source: string;
  name: string;
  payload_json: string;
  published_at: number;
}): TalentItemView {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    throw new Error(
      "talent/service：条目 [" +
        row.item_id +
        "] 的 payload_json 不是合法 JSON —— 库里数据异常，拒当合法视图。",
    );
  }
  const parsed = talentItemViewSchema.safeParse({
    item_id: row.item_id,
    source: row.source,
    name: row.name,
    published_at: row.published_at,
    payload,
  });
  if (!parsed.success) {
    throw new Error(
      "talent/service：条目 [" +
        row.item_id +
        "] 形状坏（talentItemViewSchema 不过）——库里数据异常，拒当合法视图： " +
        parsed.error.issues[0]?.message,
    );
  }
  return parsed.data;
}

// ── 读面 ─────────────────────────────────────────────────────────

/** 货架全量（三来源混排，按挂牌时间升序；前端自己按 source 分栏）。 */
export function listTalentItems(db: DbLike): TalentItemView[] {
  assertSingleStatement(LIST_TALENT_SQL);
  const rows = db.prepare(LIST_TALENT_SQL).all() as unknown as {
    item_id: string;
    source: string;
    name: string;
    payload_json: string;
    published_at: number;
  }[];
  return rows.map(assembleItem);
}

/** 单条目；不存在 ⇒ null（调用方决定 404）。 */
export function getTalentItem(
  db: DbLike,
  itemId: string,
): TalentItemView | null {
  assertSingleStatement(TALENT_ROW_SQL);
  const params: unknown[] = [itemId];
  assertParamCount(TALENT_ROW_SQL, params);
  const row = db.prepare(TALENT_ROW_SQL).get(...(params as never[])) as
    | {
        item_id: string;
        source: string;
        name: string;
        payload_json: string;
        published_at: number;
      }
    | undefined;
  return row === undefined ? null : assembleItem(row);
}

/**
 * 导出（GET /talent/:id/export 的内核）：读一条过守门的视图，取 payload。
 * 「导出 = 读」所以没有写事务与审计——蓝图是自足文档，读它不改变任何事。
 * 导出的字节可直接喂 importTalent（round-trip 测试钉互逆）。
 */
export function exportTalentPayload(
  db: DbLike,
  itemId: string,
): TalentPayload | null {
  return getTalentItem(db, itemId)?.payload ?? null;
}

/** 成员视图 → 蓝图（published 挂牌与 hire-from-talent 共用的映射）。 */
export function talentPayloadFromMember(view: MemberView): TalentPayload {
  return {
    name: view.name,
    role_id: view.role_id,
    model_tier: view.model_tier,
    // 头像资产字节不可移植（0020 文件头），种子是仅剩的可移植身份：
    // 没有种子就拿 member_id 当种子，接收方至少能确定性重现同一张 identicon。
    avatar_seed: view.avatar_seed !== "" ? view.avatar_seed : view.member_id,
    tone: view.tone,
    persona: view.persona,
    ...(view.voice === null ? {} : { voice: view.voice }),
    skills: view.skills,
    executors: view.executors,
  };
}

/**
 * 蓝图 → 招聘请求（hire-from-talent 的映射，T10 的组合点）。
 * seat_group_ids 归调用方（市场条目不知道你要把人拉进哪些群——0020 文件头
 * 「在这里怎么落位是本地决定」）。返回值的形状由 hireMemberRequestSchema 保证，
 * 蓝图既已过 talentPayloadSchema，这里只是字段搬运。
 */
export function hireRequestFromTalent(
  payload: TalentPayload,
  seatGroupIds: readonly string[],
) {
  return {
    name: payload.name,
    role_id: payload.role_id,
    model_tier: payload.model_tier,
    persona: payload.persona,
    tone: payload.tone,
    ...(payload.voice === undefined ? {} : { voice: payload.voice }),
    ...(payload.avatar_seed === "" ? {} : { avatar_seed: payload.avatar_seed }),
    skills: payload.skills,
    executors: payload.executors,
    seat_group_ids: seatGroupIds,
  };
}

// ── 写面 ─────────────────────────────────────────────────────────

/**
 * 导入（挂进本店货架，不入职 —— 文件头「只挂牌」）。
 * item_id 随机 id：导入的蓝图没有「本店派生键」的概念，重复导入同一份文件
 * 得到两条条目（货架上摆两份同一蓝图）是允许的 —— 删一份不伤另一份，
 * 用户心智与「下载文件夹里有两份同一 PDF」一致。
 */
export async function importTalent(
  w: Writer,
  o: {
    readonly req: ImportTalentRequest;
    readonly nowMs: number;
    readonly newId?: () => string;
  },
): Promise<TalentMutationResult> {
  return w.node(() => {
    const db = requireScopeDb("importTalent");
    const payload = o.req.payload;
    // 契约 strict 已把过形状，这里补的是【本店事实】：岗位存不存在 schema 无从知道。
    assertSingleStatement(ROLE_EXISTS_SQL);
    assertParamCount(ROLE_EXISTS_SQL, [payload.role_id]);
    if (
      db.prepare(ROLE_EXISTS_SQL).get(...([payload.role_id] as never[])) ===
      undefined
    ) {
      return err(
        "role_not_found",
        "蓝图岗位 [" +
          payload.role_id +
          "] 在本店不存在：先建这个角色（或改蓝图岗位）再导入。整单已拒。",
      );
    }
    const itemId = o.newId?.() ?? randomUUID();
    const params: unknown[] = [
      itemId,
      "imported",
      payload.name,
      JSON.stringify(payload),
      o.nowMs,
    ];
    assertSingleStatement(INSERT_TALENT_SQL);
    assertParamCount(INSERT_TALENT_SQL, params);
    db.prepare(INSERT_TALENT_SQL).run(...(params as never[]));

    const item = getTalentItem(db, itemId);
    if (item === null) {
      throw new Error(
        "talent/service：刚插完条目 [" +
          itemId +
          "] 却读不回来 —— 事务内不变量被破坏，整单回滚。",
      );
    }
    const auditSeq = appendAudit(
      db,
      {
        taskId: null,
        actorType: TALENT_ACTOR.actorType,
        actorId: TALENT_ACTOR.actorId,
        action: "state_change",
        target: itemId,
        payload: {
          kind: "talent_imported" satisfies TalentAuditKind,
          item_id: itemId,
          name: payload.name,
          role_id: payload.role_id,
        },
        stateSnapshot: { before: null, after: item },
        createdAt: o.nowMs,
      },
      () => o.nowMs,
    );
    return { ok: true, item, auditSeq };
  });
}

/**
 * 挂牌（published）：从在职成员现状生成蓝图，upsert 到派生键 'pub:'+member_id。
 * upsert 的理由见文件头「货架恒一」。每次挂牌都取【当下】现状 —— 挂牌是快照
 * 不是活引用：之后成员改了岗，条目不会自己变（否则「按模板A雇的人」在导出方
 * 改档案后指向完全不同的东西，导入方无从核对）。要刷新就再挂一次。
 * 归档成员可挂（归档者的档案正是值得沉淀的东西），归档与否由调用方在 UI 上标注。
 */
export async function publishTalent(
  w: Writer,
  o: {
    readonly req: PublishTalentRequest;
    readonly nowMs: number;
  },
): Promise<TalentMutationResult> {
  return w.node(() => {
    const db = requireScopeDb("publishTalent");
    const view = getMember(db, o.req.member_id);
    if (view === undefined) {
      return err(
        "member_not_found",
        "成员 [" + o.req.member_id + "] 不存在：挂牌的对象得是先招进来的人。",
      );
    }
    const payload = talentPayloadFromMember(view);
    // 成员表是 hireMember 写出来的，蓝图必然过契约；不过 = 数据异常 ⇒ 抛回滚。
    const checked = talentPayloadSchema.safeParse(payload);
    if (!checked.success) {
      throw new Error(
        "talent/service：成员 [" +
          o.req.member_id +
          "] 的现状生成不出合法蓝图（talentPayloadSchema 不过）——库里数据异常： " +
          checked.error.issues[0]?.message,
      );
    }
    const itemId = PUBLISHED_ITEM_PREFIX + o.req.member_id;
    const json = JSON.stringify(payload);
    const existing = getTalentItem(db, itemId);
    let before: TalentItemView | null = null;
    if (existing !== null) {
      if (existing.source === "builtin") {
        // 派生键与 builtin 的固定 id（talent_pm…）不同域，撞键 = 手改库。
        return err(
          "not_writable",
          "条目 [" +
            itemId +
            "] 已存在且是内置条目：派生键不该撞到 builtin，数据异常。",
        );
      }
      const up: unknown[] = [payload.name, json, o.nowMs, itemId];
      assertSingleStatement(UPDATE_PUBLISHED_SQL);
      assertParamCount(UPDATE_PUBLISHED_SQL, up);
      db.prepare(UPDATE_PUBLISHED_SQL).run(...(up as never[]));
      before = existing;
    } else {
      const ins: unknown[] = [itemId, "published", payload.name, json, o.nowMs];
      assertSingleStatement(INSERT_TALENT_SQL);
      assertParamCount(INSERT_TALENT_SQL, ins);
      db.prepare(INSERT_TALENT_SQL).run(...(ins as never[]));
    }

    const item = getTalentItem(db, itemId);
    if (item === null) {
      throw new Error(
        "talent/service：刚挂牌 [" +
          itemId +
          "] 却读不回来 —— 事务内不变量被破坏，整单回滚。",
      );
    }
    const auditSeq = appendAudit(
      db,
      {
        taskId: null,
        actorType: TALENT_ACTOR.actorType,
        actorId: TALENT_ACTOR.actorId,
        action: "state_change",
        target: itemId,
        payload: {
          kind: "talent_published" satisfies TalentAuditKind,
          item_id: itemId,
          member_id: o.req.member_id,
          republish: before !== null,
        },
        stateSnapshot: { before, after: item },
        createdAt: o.nowMs,
      },
      () => o.nowMs,
    );
    return { ok: true, item, auditSeq };
  });
}

/**
 * 下架（DELETE）。builtin 拒删：应用层先查（给人话 reason），触发器兜底
 * （isBuiltinTrigger）。下架不碰已按条目入职的成员 —— 蓝图与入职者本就无引用
 * 关系（0020「为什么不用外键」），这里没有级联可做，也不该有。
 */
export async function unlistTalent(
  w: Writer,
  o: { readonly itemId: string; readonly nowMs: number },
): Promise<
  { readonly ok: true; readonly auditSeq: number } | TalentServiceError
> {
  return w.node(() => {
    const db = requireScopeDb("unlistTalent");
    const before = getTalentItem(db, o.itemId);
    if (before === null) {
      return err("talent_not_found", "条目 [" + o.itemId + "] 不存在。");
    }
    if (before.source === "builtin") {
      return err(
        "builtin_undeletable",
        "内置人才模板不可下架（D3）：builtin 条目随迁移而来，删了就少一批标准件。",
      );
    }
    try {
      const params: unknown[] = [o.itemId];
      assertSingleStatement(DELETE_TALENT_SQL);
      assertParamCount(DELETE_TALENT_SQL, params);
      db.prepare(DELETE_TALENT_SQL).run(...(params as never[]));
    } catch (e) {
      if (isBuiltinTrigger(e)) {
        return err(
          "not_writable",
          "内置保护触发器拦下了这次下架（0020）。source 已判过非 builtin 仍被当 builtin 拦，说明数据异常。",
        );
      }
      throw e;
    }

    const auditSeq = appendAudit(
      db,
      {
        taskId: null,
        actorType: TALENT_ACTOR.actorType,
        actorId: TALENT_ACTOR.actorId,
        action: "state_change",
        target: o.itemId,
        payload: {
          kind: "talent_unlisted" satisfies TalentAuditKind,
          item_id: o.itemId,
          source: before.source,
          name: before.name,
        },
        stateSnapshot: { before, after: null },
        createdAt: o.nowMs,
      },
      () => o.nowMs,
    );
    return { ok: true, auditSeq };
  });
}
