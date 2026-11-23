/**
 * People HTTP entry points: groups, members, and the talent market.
 * Reads use the readonly connection; mutations use the single domain writer.
 * Actor identity is fixed by the services (human CEO), never accepted from JSON.
 */
import {
  addGroupMemberRequestSchema,
  CEO_ROLE_ID,
  createGroupRequestSchema,
  GROUP_STATUSES,
  type GroupView,
  HTTP_NOT_FOUND,
  HTTP_NOT_IMPLEMENTED,
  HTTP_UNPROCESSABLE,
  hireMemberRequestSchema,
  importTalentRequestSchema,
  type MemberView,
  memberExecutorSchema,
  memberSkillSchema,
  publishTalentRequestSchema,
  updateGroupRequestSchema,
  updateMemberRequestSchema,
} from "@opc/contracts";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import {
  ensureGroupConversation,
  sendMessage,
} from "../conversations/service.js";
import {
  assertParamCount,
  assertSingleStatement,
  type HubWriter,
} from "../db/write-queue.js";
import { depositAutoDocument } from "../documents/deposit.js";
import {
  type DocumentServiceError,
  getDocument,
  listDocuments,
  saveDocument,
} from "../documents/service.js";
import type { DomainEvent } from "../events/bus.js";
import { appendAudit } from "../events/recorder.js";
import {
  addGroupMember,
  createGroup,
  type GroupServiceError,
  getGroup,
  groupServiceStatus,
  listGroupMembers,
  listGroups,
  removeGroupMember,
  updateGroup,
} from "../groups/service.js";
import {
  getMember,
  hireMember,
  listMembers,
  type MemberServiceError,
  type MemberWriteResult,
  memberServiceStatus,
  setMemberExecutors,
  setMemberSkills,
  updateMember,
} from "../members/service.js";
import { getRole } from "../roles/service.js";
import {
  exportTalentPayload,
  getTalentItem,
  importTalent,
  listTalentItems,
  publishTalent,
  type TalentServiceError,
  talentServiceStatus,
  unlistTalent,
} from "../talent/service.js";
import type { HubDeps, HubResponse } from "./app.js";
import type { EndpointRouter } from "./router.js";

function res(status: number, body: unknown): HubResponse {
  return { status, body };
}

interface PersistedWrite {
  readonly ok: true;
  readonly auditSeq: number;
}

/**
 * 领域服务返回时事务已经提交；广播只更新投影，不能改写写入事实。
 * 因此发布异常只作为 HTTP 响应里的 broadcast_error 带回，绝不冒泡成失败响应。
 */
function broadcastPersisted<T extends PersistedWrite>(
  deps: HubDeps,
  result: T,
  event: DomainEvent,
): T & { readonly broadcast_error?: string } {
  try {
    deps.bus.publishPersisted(event, result.auditSeq);
    return result;
  } catch (error) {
    return {
      ...result,
      broadcast_error: error instanceof Error ? error.message : String(error),
    };
  }
}

function writerMissing(): HubResponse {
  return res(HTTP_NOT_IMPLEMENTED, {
    error:
      "本装配未接领域写入（HubDeps.domainWriter）。501 而不是 404：路由已注册，" +
      "但写队列尚未接入。",
  });
}

type JsonBody =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };

/** Empty bodies retain the existing HTTP convention of an empty object. */
function parseJson(text: string): JsonBody {
  if (text.trim() === "") return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function malformedJson(): HubResponse {
  return res(HTTP_UNPROCESSABLE, {
    error: "请求体不是合法 JSON。",
    code: "bad_body",
  });
}

function invalidBody(error = "请求体不合法。"): HubResponse {
  return res(HTTP_UNPROCESSABLE, { error, code: "bad_body" });
}

function invalidQuery(error: string): HubResponse {
  return res(HTTP_UNPROCESSABLE, { error, code: "bad_query" });
}

function groupError(error: GroupServiceError): HubResponse {
  return res(groupServiceStatus(error.code), {
    error: error.reason,
    code: error.code,
  });
}

function memberError(error: MemberServiceError): HubResponse {
  return res(memberServiceStatus(error.code), {
    error: error.reason,
    code: error.code,
  });
}

function talentError(error: TalentServiceError): HubResponse {
  return res(talentServiceStatus(error.code), {
    error: error.reason,
    code: error.code,
  });
}

function memberNotFound(memberId: string): HubResponse {
  return memberError({
    ok: false,
    reason: `成员 [${memberId}] 不存在。`,
    code: "member_not_found",
  });
}

type SeatGreeting =
  | {
      readonly group_id: string;
      readonly conversation_id: string;
      readonly message_id: string;
      readonly broadcast_error?: string;
    }
  | {
      readonly group_id: string;
      readonly conversation_id?: string;
      readonly error: string;
    };

const GREETING_TONE: Record<MemberView["tone"], string> = {
  neutral: "平和",
  steady: "沉稳",
  direct: "直接",
  warm: "热情",
  precise: "严谨",
};

/**
 * 入职已经提交，报到只是后续副作用：逐群隔离会话补建/发送异常，
 * 第一处失败不阻断其余群，也不能把成功的招聘改写成失败响应。
 */
async function greetSeatedMember(
  deps: HubDeps,
  writer: HubWriter,
  member: MemberView,
  seatedGroupIds: readonly string[],
): Promise<SeatGreeting[]> {
  const greetings: SeatGreeting[] = [];
  for (const groupId of new Set(seatedGroupIds)) {
    let conversationId: string | undefined;
    try {
      const ensured = await ensureGroupConversation(writer, {
        groupId,
        nowMs: deps.now(),
      });
      if (!ensured.ok) {
        greetings.push({ group_id: groupId, error: ensured.reason });
        continue;
      }
      conversationId = ensured.conversation.conversation_id;
      const roleName = getRole(deps.db, member.role_id)?.name ?? member.role_id;
      const sent = await sendMessage(writer, deps.bus, {
        conversationId,
        author: { kind: "member", memberId: member.member_id },
        req: {
          body:
            `大家好，我是${member.name}，已加入${ensured.conversation.title}，` +
            `岗位是${roleName}。我会以${GREETING_TONE[member.tone]}的方式沟通，请多关照。`,
        },
        nowMs: deps.now(),
      });
      if (!sent.ok) {
        greetings.push({
          group_id: groupId,
          conversation_id: conversationId,
          error: sent.reason,
        });
        continue;
      }
      greetings.push({
        group_id: groupId,
        conversation_id: conversationId,
        message_id: sent.message.message_id,
        ...(sent.broadcastError === undefined
          ? {}
          : { broadcast_error: sent.broadcastError }),
      });
    } catch (error) {
      greetings.push({
        group_id: groupId,
        ...(conversationId === undefined
          ? {}
          : { conversation_id: conversationId }),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return greetings;
}

function groupNotFound(groupId: string): HubResponse {
  return groupError({
    ok: false,
    reason: `群 [${groupId}] 不存在。`,
    code: "group_not_found",
  });
}

function talentNotFound(itemId: string): HubResponse {
  return talentError({
    ok: false,
    reason: `人才条目 [${itemId}] 不存在。`,
    code: "talent_not_found",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const BOSS = { kind: "boss" } as const;
const CHARTER_TITLE_PREFIX = "立项：";

type CharterDocumentResult =
  | {
      readonly ok: true;
      readonly doc_id: string;
      readonly changed: boolean;
      readonly audit_seq?: number;
      readonly broadcast_error?: string;
    }
  | DocumentServiceError
  | {
      readonly ok: false;
      readonly code: "charter_document_missing";
      readonly reason: string;
    };

/** 章程正文只有群事实与成员事实；创建时间取落库值，避免补档时漂移。 */
function charterMarkdown(deps: HubDeps, group: GroupView): string {
  const members = listGroupMembers(deps.db, group.group_id).map((seat) => {
    const member = getMember(deps.db, seat.member_id);
    if (member === undefined) {
      throw new Error(
        `http/people：群 [${group.group_id}] 的席位成员 [${seat.member_id}] 不存在，无法生成章程。`,
      );
    }
    return { seat, name: member.name };
  });
  const memberLines =
    members.length === 0
      ? ["（暂无成员）"]
      : members.map(
          ({ seat, name }) =>
            `- member_id：${seat.member_id}；name：${name}；role_id：${seat.role_id}；seat：${seat.seat}`,
        );
  return [
    `# ${CHARTER_TITLE_PREFIX}${group.title}`,
    "",
    `- 群 ID：${group.group_id}`,
    `- 目标：${group.goal}`,
    `- 状态：${group.status}`,
    `- 创建时间：${new Date(group.created_at).toISOString()}`,
    "",
    "## 成员清单",
    "",
    ...memberLines,
    "",
    "## 边界说明",
    "",
    "- 本章程在立项建群时自动创建，后续群目标、状态或席位变更追加版本。",
    "- 成员清单只描述本群席位与任职，不代表修改成员档案或跨群授权。",
    "- 归档仅停止推进，不删除群、历史会话或既有文档版本。",
    "",
  ].join("\n");
}

/**
 * 主领域操作提交后同步章程。只认本群 auto 的“立项：”Markdown，不依赖旧群名；
 * 同文同标题不写空版本。缺失/保存失败只作为 document 降级信息返回，主操作仍成功。
 */
async function syncCharterDocument(
  deps: HubDeps,
  groupId: string,
): Promise<CharterDocumentResult> {
  const group = getGroup(deps.db, groupId);
  if (group === null) {
    return {
      ok: false,
      code: "charter_document_missing",
      reason: `群 [${groupId}] 不存在，无法同步立项章程。`,
    };
  }
  const listed = listDocuments(
    deps.db,
    { group_id: groupId, kind: "markdown", limit: 100 },
    BOSS,
  );
  if (!listed.ok) return listed;
  const charter = listed.documents.find(
    (document) =>
      document.origin === "auto" &&
      document.title.startsWith(CHARTER_TITLE_PREFIX),
  );
  if (charter === undefined) {
    return {
      ok: false,
      code: "charter_document_missing",
      reason: `群 [${groupId}] 缺少 origin=auto 的立项章程 Markdown，主操作已提交但章程未同步。`,
    };
  }
  const current = getDocument(deps.db, charter.doc_id, BOSS);
  if (!current.ok) return current;
  const bodyText = charterMarkdown(deps, group);
  const title = `${CHARTER_TITLE_PREFIX}${group.title}`;
  if (
    current.document.body_text === bodyText &&
    current.document.title === title
  ) {
    return { ok: true, doc_id: charter.doc_id, changed: false };
  }
  const writer = deps.domainWriter;
  if (writer === undefined) {
    return {
      ok: false,
      code: "not_writable",
      reason: "本装配未接领域写入，无法同步立项章程。",
    };
  }
  const saved = await saveDocument(writer, deps.bus, {
    viewer: BOSS,
    docId: charter.doc_id,
    req: { title, body_text: bodyText },
    nowMs: deps.now(),
  });
  if (!saved.ok) return saved;
  return {
    ok: true,
    doc_id: charter.doc_id,
    changed: true,
    audit_seq: saved.auditSeq,
    ...(saved.broadcastError === undefined
      ? {}
      : { broadcast_error: saved.broadcastError }),
  };
}

function parseStatus<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
): { readonly ok: true; readonly status: T | null } | { readonly ok: false } {
  if (raw === undefined) return { ok: true, status: null };
  return allowed.includes(raw as T)
    ? { ok: true, status: raw as T }
    : { ok: false };
}

interface ParseSchema<T> {
  safeParse(
    value: unknown,
  ): { readonly success: true; readonly data: T } | { readonly success: false };
}

/** The set endpoints have no contracts wrapper; validate their sole array key strictly. */
function parseArrayBody<T>(
  value: unknown,
  key: string,
  schema: ParseSchema<T>,
): { readonly ok: true; readonly items: T[] } | { readonly ok: false } {
  if (!isRecord(value) || Object.keys(value).length !== 1) return { ok: false };
  const raw = value[key];
  if (!Object.hasOwn(value, key) || !Array.isArray(raw)) return { ok: false };
  const items: T[] = [];
  for (const item of raw) {
    const parsed = schema.safeParse(item);
    if (!parsed.success) return { ok: false };
    items.push(parsed.data);
  }
  return { ok: true, items };
}

const AVATAR_ASSET_SQL =
  "SELECT 1 AS ok FROM assets WHERE asset_id = ? AND purpose = 'avatar'";
const UPDATE_AVATAR_SQL =
  "UPDATE members SET avatar_asset_id = ?, avatar_seed = ?, updated_at = ?" +
  " WHERE member_id = ?";

/**
 * Avatar mutation is the one member write primitive absent from members/service.
 * Keep it in the same queued transaction/audit shape rather than writing through
 * deps.db or accepting an actor supplied by the caller.
 */
async function setAvatar(
  deps: HubDeps,
  memberId: string,
  text: string,
): Promise<HubResponse> {
  const writer = deps.domainWriter;
  if (writer === undefined) return writerMissing();
  const body = parseJson(text);
  if (!body.ok) return malformedJson();
  if (!isRecord(body.value) || Object.keys(body.value).length !== 1) {
    return invalidBody("头像请求必须且只能带 avatar_asset_id 或 avatar_seed。");
  }
  const rawAsset = body.value["avatar_asset_id"];
  const rawSeed = body.value["avatar_seed"];
  let assetId: string | null = null;
  let seed = "";
  if (Object.hasOwn(body.value, "avatar_asset_id")) {
    if (
      typeof rawAsset !== "string" ||
      rawAsset.length < 1 ||
      rawAsset.length > 200
    ) {
      return invalidBody("avatar_asset_id 必须是 1–200 个字符。");
    }
    assetId = rawAsset;
  } else if (Object.hasOwn(body.value, "avatar_seed")) {
    if (typeof rawSeed !== "string" || rawSeed.trim().length > 200) {
      return invalidBody("avatar_seed 必须是最多 200 个字符的字符串。");
    }
    seed = rawSeed.trim();
  } else {
    return invalidBody("头像请求必须且只能带 avatar_asset_id 或 avatar_seed。");
  }

  const nowMs = deps.now();
  const result = await writer.node((): MemberWriteResult => {
    const db = requireScopeDb("http/people.setAvatar");
    const before = getMember(db, memberId);
    if (before === undefined) {
      return {
        ok: false,
        reason: `成员 [${memberId}] 不存在，没有任何东西被改。`,
        code: "member_not_found",
      };
    }
    if (assetId !== null) {
      assertSingleStatement(AVATAR_ASSET_SQL);
      assertParamCount(AVATAR_ASSET_SQL, [assetId]);
      if (db.prepare(AVATAR_ASSET_SQL).get(assetId) === undefined) {
        return {
          ok: false,
          reason: `头像资产 [${assetId}] 不存在或不是图片资产（purpose 必须是 avatar）。`,
          code: "asset_not_found",
        };
      }
    }
    const params: unknown[] = [assetId, seed, nowMs, memberId];
    assertSingleStatement(UPDATE_AVATAR_SQL);
    assertParamCount(UPDATE_AVATAR_SQL, params);
    db.prepare(UPDATE_AVATAR_SQL).run(...(params as never[]));
    const after = getMember(db, memberId);
    if (after === undefined) {
      throw new Error(
        `http/people.setAvatar：刚写完成员 [${memberId}] 却读不回来，整单回滚。`,
      );
    }
    const auditSeq = appendAudit(
      db,
      {
        taskId: null,
        actorType: "human",
        actorId: CEO_ROLE_ID,
        action: "state_change",
        target: memberId,
        payload: {
          kind: "member_updated",
          member_id: memberId,
          changed: [assetId === null ? "avatar_seed" : "avatar_asset_id"],
        },
        stateSnapshot: { before, after },
        createdAt: nowMs,
      },
      () => nowMs,
    );
    return { ok: true, member: after, auditSeq };
  });
  return result.ok
    ? res(
        200,
        broadcastPersisted(deps, result, {
          kind: "MemberUpdated",
          memberId: result.member.member_id,
          op: "profile",
        }),
      )
    : memberError(result);
}

export function registerPeopleRoutes(router: EndpointRouter): void {
  router.add("GET /api/v1/groups", ({ deps, req }) => {
    const parsed = parseStatus(req.query["status"], GROUP_STATUSES);
    if (!parsed.ok) return invalidQuery("status 必须是 active 或 archived。");
    return res(200, { groups: listGroups(deps.db, parsed.status) });
  });

  router.add("POST /api/v1/groups", async ({ deps, req }) => {
    const writer = deps.domainWriter;
    if (writer === undefined) return writerMissing();
    const body = parseJson(req.body);
    if (!body.ok) return malformedJson();
    const parsed = createGroupRequestSchema.safeParse(body.value);
    if (!parsed.success) return invalidBody("建群请求不合法。");
    const result = await createGroup(writer, {
      req: parsed.data,
      nowMs: deps.now(),
    });
    if (!result.ok) return groupError(result);
    const published = broadcastPersisted(deps, result, {
      kind: "GroupUpdated",
      groupId: result.group.group_id,
      op: "created",
    });
    const deposited = await depositAutoDocument(writer, deps.bus, {
      viewer: { kind: "boss" },
      req: {
        kind: "markdown",
        title: `${CHARTER_TITLE_PREFIX}${result.group.title}`,
        body_text: charterMarkdown(deps, result.group),
        group_id: result.group.group_id,
      },
      nowMs: deps.now(),
    });
    return res(201, {
      ...published,
      document: deposited.ok
        ? {
            ok: true,
            doc_id: deposited.docId,
            ...(deposited.broadcastError === undefined
              ? {}
              : { broadcast_error: deposited.broadcastError }),
          }
        : deposited,
    });
  });

  router.add("GET /api/v1/groups/:id", ({ deps, params }) => {
    const group = getGroup(deps.db, params.id ?? "");
    return group === null
      ? groupNotFound(params.id ?? "")
      : res(200, {
          group,
          members: listGroupMembers(deps.db, params.id ?? ""),
        });
  });

  router.add("PATCH /api/v1/groups/:id", async ({ deps, req, params }) => {
    const writer = deps.domainWriter;
    if (writer === undefined) return writerMissing();
    const body = parseJson(req.body);
    if (!body.ok) return malformedJson();
    const parsed = updateGroupRequestSchema.safeParse(body.value);
    if (!parsed.success) return invalidBody("群更新请求不合法。");
    const groupId = params.id ?? "";
    const result = await updateGroup(writer, {
      groupId,
      req: parsed.data,
      nowMs: deps.now(),
    });
    return result.ok
      ? res(200, {
          ...broadcastPersisted(deps, result, {
            kind: "GroupUpdated",
            groupId: result.group.group_id,
            op: parsed.data.status === "archived" ? "dissolved" : "updated",
          }),
          document: await syncCharterDocument(deps, result.group.group_id),
        })
      : groupError(result);
  });

  router.add(
    "POST /api/v1/groups/:id/members",
    async ({ deps, req, params }) => {
      const writer = deps.domainWriter;
      if (writer === undefined) return writerMissing();
      const body = parseJson(req.body);
      if (!body.ok) return malformedJson();
      const parsed = addGroupMemberRequestSchema.safeParse(body.value);
      if (!parsed.success) return invalidBody("拉人进群请求不合法。");
      const result = await addGroupMember(writer, {
        groupId: params.id ?? "",
        req: parsed.data,
        nowMs: deps.now(),
      });
      return result.ok
        ? res(200, {
            ...broadcastPersisted(deps, result, {
              kind: "GroupUpdated",
              groupId: result.member.group_id,
              op: "updated",
            }),
            document: await syncCharterDocument(deps, result.member.group_id),
          })
        : groupError(result);
    },
  );

  router.add(
    "DELETE /api/v1/groups/:id/members/:memberId",
    async ({ deps, params }) => {
      const writer = deps.domainWriter;
      if (writer === undefined) return writerMissing();
      const result = await removeGroupMember(writer, {
        groupId: params.id ?? "",
        memberId: params.memberId ?? "",
        nowMs: deps.now(),
      });
      return result.ok
        ? res(200, {
            ...broadcastPersisted(deps, result, {
              kind: "GroupUpdated",
              groupId: result.group.group_id,
              op: "updated",
            }),
            document: await syncCharterDocument(deps, result.group.group_id),
          })
        : groupError(result);
    },
  );

  router.add("GET /api/v1/members", ({ deps, req }) => {
    const parsed = parseStatus(req.query["status"], [
      "active",
      "archived",
    ] as const);
    if (!parsed.ok) return invalidQuery("status 必须是 active 或 archived。");
    return res(200, { members: listMembers(deps.db, parsed.status) });
  });

  router.add("POST /api/v1/members", async ({ deps, req }) => {
    const writer = deps.domainWriter;
    if (writer === undefined) return writerMissing();
    const body = parseJson(req.body);
    if (!body.ok) return malformedJson();
    const parsed = hireMemberRequestSchema.safeParse(body.value);
    if (!parsed.success) return invalidBody("招聘请求不合法。");
    const result = await hireMember(writer, {
      req: parsed.data,
      nowMs: deps.now(),
    });
    if (!result.ok) return memberError(result);
    const seatedGroupIds = [...new Set(result.seated_group_ids)];
    const published = broadcastPersisted(deps, result, {
      kind: "MemberHired",
      memberId: result.member.member_id,
      groupId: seatedGroupIds[0] ?? null,
      roleId: result.member.role_id,
    });
    const greetings = await greetSeatedMember(
      deps,
      writer,
      result.member,
      seatedGroupIds,
    );
    return res(201, { ...published, greetings });
  });

  router.add("GET /api/v1/members/:id", ({ deps, params }) => {
    const member = getMember(deps.db, params.id ?? "");
    return member === undefined
      ? memberNotFound(params.id ?? "")
      : res(200, { member });
  });

  router.add("PATCH /api/v1/members/:id", async ({ deps, req, params }) => {
    const writer = deps.domainWriter;
    if (writer === undefined) return writerMissing();
    const body = parseJson(req.body);
    if (!body.ok) return malformedJson();
    const parsed = updateMemberRequestSchema.safeParse(body.value);
    if (!parsed.success) return invalidBody("成员更新请求不合法。");
    const result = await updateMember(writer, {
      memberId: params.id ?? "",
      req: parsed.data,
      nowMs: deps.now(),
    });
    return result.ok
      ? res(
          200,
          broadcastPersisted(deps, result, {
            kind: "MemberUpdated",
            memberId: result.member.member_id,
            op: parsed.data.status === undefined ? "profile" : "status",
          }),
        )
      : memberError(result);
  });

  router.add("DELETE /api/v1/members/:id", async ({ deps, params }) => {
    const writer = deps.domainWriter;
    if (writer === undefined) return writerMissing();
    const result = await updateMember(writer, {
      memberId: params.id ?? "",
      req: { status: "archived" },
      nowMs: deps.now(),
    });
    return result.ok
      ? res(
          200,
          broadcastPersisted(deps, result, {
            kind: "MemberUpdated",
            memberId: result.member.member_id,
            op: "status",
          }),
        )
      : memberError(result);
  });

  router.add(
    "POST /api/v1/members/:id/skills",
    async ({ deps, req, params }) => {
      const writer = deps.domainWriter;
      if (writer === undefined) return writerMissing();
      const body = parseJson(req.body);
      if (!body.ok) return malformedJson();
      const parsed = parseArrayBody(body.value, "skills", memberSkillSchema);
      if (!parsed.ok) return invalidBody("技能列表请求不合法。");
      const result = await setMemberSkills(writer, {
        memberId: params.id ?? "",
        skills: parsed.items,
        nowMs: deps.now(),
      });
      return result.ok
        ? res(
            200,
            broadcastPersisted(deps, result, {
              kind: "MemberUpdated",
              memberId: result.member.member_id,
              op: "skills",
            }),
          )
        : memberError(result);
    },
  );

  router.add(
    "DELETE /api/v1/members/:id/skills/:skillId",
    async ({ deps, params }) => {
      const writer = deps.domainWriter;
      if (writer === undefined) return writerMissing();
      const memberId = params.id ?? "";
      const skillId = params.skillId ?? "";
      const member = getMember(deps.db, memberId);
      if (member === undefined) return memberNotFound(memberId);
      const skills = member.skills.filter(
        (skill) => skill.skill_id !== skillId,
      );
      if (skills.length === member.skills.length) {
        return res(HTTP_NOT_FOUND, {
          error: `成员 [${memberId}] 没有技能 [${skillId}]。`,
          code: "skill_not_found",
        });
      }
      const result = await setMemberSkills(writer, {
        memberId,
        skills,
        nowMs: deps.now(),
      });
      return result.ok
        ? res(
            200,
            broadcastPersisted(deps, result, {
              kind: "MemberUpdated",
              memberId: result.member.member_id,
              op: "skills",
            }),
          )
        : memberError(result);
    },
  );

  router.add("GET /api/v1/members/:id/executors", ({ deps, params }) => {
    const member = getMember(deps.db, params.id ?? "");
    return member === undefined
      ? memberNotFound(params.id ?? "")
      : res(200, { executors: member.executors });
  });

  router.add(
    "POST /api/v1/members/:id/executors",
    async ({ deps, req, params }) => {
      const writer = deps.domainWriter;
      if (writer === undefined) return writerMissing();
      const body = parseJson(req.body);
      if (!body.ok) return malformedJson();
      const parsed = parseArrayBody(
        body.value,
        "executors",
        memberExecutorSchema,
      );
      if (!parsed.ok) return invalidBody("执行器列表请求不合法。");
      const result = await setMemberExecutors(writer, {
        memberId: params.id ?? "",
        executors: parsed.items,
        nowMs: deps.now(),
      });
      return result.ok
        ? res(
            200,
            broadcastPersisted(deps, result, {
              kind: "MemberUpdated",
              memberId: result.member.member_id,
              op: "executors",
            }),
          )
        : memberError(result);
    },
  );

  router.add(
    "DELETE /api/v1/members/:id/executors/:seq",
    async ({ deps, params }) => {
      const writer = deps.domainWriter;
      if (writer === undefined) return writerMissing();
      const rawSeq = params.seq ?? "";
      const seq = Number(rawSeq);
      if (
        !/^[1-9]\d*$/u.test(rawSeq) ||
        !Number.isSafeInteger(seq) ||
        seq > 99
      ) {
        return res(HTTP_UNPROCESSABLE, {
          error: "seq 必须是 1–99 的整数。",
          code: "bad_seq",
        });
      }
      const memberId = params.id ?? "";
      const member = getMember(deps.db, memberId);
      if (member === undefined) return memberNotFound(memberId);
      const executors = member.executors.filter(
        (executor) => executor.seq !== seq,
      );
      if (executors.length === member.executors.length) {
        return res(HTTP_NOT_FOUND, {
          error: `成员 [${memberId}] 没有执行器 seq=${seq}。`,
          code: "executor_not_found",
        });
      }
      const result = await setMemberExecutors(writer, {
        memberId,
        executors,
        nowMs: deps.now(),
      });
      return result.ok
        ? res(
            200,
            broadcastPersisted(deps, result, {
              kind: "MemberUpdated",
              memberId: result.member.member_id,
              op: "executors",
            }),
          )
        : memberError(result);
    },
  );

  router.add("POST /api/v1/members/:id/avatar", ({ deps, req, params }) =>
    setAvatar(deps, params.id ?? "", req.body),
  );

  router.add("GET /api/v1/members/:id/training", ({ deps, params }) => {
    const member = getMember(deps.db, params.id ?? "");
    return member === undefined
      ? memberNotFound(params.id ?? "")
      : res(200, {
          member_id: member.member_id,
          skills: member.skills,
          executors: member.executors,
        });
  });

  router.add("GET /api/v1/talent", ({ deps }) =>
    res(200, { items: listTalentItems(deps.db) }),
  );

  router.add("GET /api/v1/talent/:id", ({ deps, params }) => {
    const item = getTalentItem(deps.db, params.id ?? "");
    return item === null ? talentNotFound(params.id ?? "") : res(200, { item });
  });

  router.add("GET /api/v1/talent/:id/export", ({ deps, params }) => {
    const payload = exportTalentPayload(deps.db, params.id ?? "");
    return payload === null
      ? talentNotFound(params.id ?? "")
      : res(200, { payload });
  });

  router.add("POST /api/v1/talent/:id/publish", async ({ deps, params }) => {
    const writer = deps.domainWriter;
    if (writer === undefined) return writerMissing();
    const parsed = publishTalentRequestSchema.safeParse({
      member_id: params.id ?? "",
    });
    if (!parsed.success) return invalidBody("人才挂牌请求不合法。");
    const result = await publishTalent(writer, {
      req: parsed.data,
      nowMs: deps.now(),
    });
    return result.ok ? res(200, result) : talentError(result);
  });

  router.add("POST /api/v1/talent/:id/unlist", async ({ deps, params }) => {
    const writer = deps.domainWriter;
    if (writer === undefined) return writerMissing();
    const result = await unlistTalent(writer, {
      itemId: params.id ?? "",
      nowMs: deps.now(),
    });
    return result.ok ? res(200, result) : talentError(result);
  });

  router.add("POST /api/v1/talent/import", async ({ deps, req }) => {
    const writer = deps.domainWriter;
    if (writer === undefined) return writerMissing();
    const body = parseJson(req.body);
    if (!body.ok) return malformedJson();
    const parsed = importTalentRequestSchema.safeParse(body.value);
    if (!parsed.success) return invalidBody("人才导入请求不合法。");
    const result = await importTalent(writer, {
      req: parsed.data,
      nowMs: deps.now(),
    });
    return result.ok ? res(201, result) : talentError(result);
  });
}
