/**
 * Social HTTP entry points. Reads use the readonly connection; every mutation
 * goes through the single domain writer. HTTP callers currently act as boss,
 * so actor identity never comes from the request body.
 */
import type { DatabaseSync } from "node:sqlite";
import {
  HTTP_NOT_FOUND,
  HTTP_NOT_IMPLEMENTED,
  HTTP_UNPROCESSABLE,
  openPrivateRequestSchema,
} from "@opc/contracts";
import {
  BOSS_READER,
  type ConversationServiceError,
  conversationServiceStatus,
  listConversations,
  listMessages,
  markRead,
  openPrivate,
  sendMessage,
} from "../conversations/service.js";
import { assertParamCount, assertSingleStatement } from "../db/write-queue.js";
import {
  routeGroupMessage,
  routePrivateInstruction,
} from "../dispatch/service.js";
import { depositMeetingSummary } from "../documents/deposit.js";
import { planMeetingConclusion } from "../governance/service.js";
import {
  cancelMeeting,
  concludeMeeting,
  createMeeting,
  getMeeting,
  listMeetings,
  type MeetingServiceError,
  meetingServiceStatus,
  postTurn,
} from "../meetings/service.js";
import type { HubResponse } from "./app.js";
import type { EndpointRouter } from "./router.js";

function res(status: number, body: unknown): HubResponse {
  return { status, body };
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

function conversationError(error: ConversationServiceError): HubResponse {
  return res(conversationServiceStatus(error.code), {
    error: error.reason,
    code: error.code,
  });
}

function meetingError(error: MeetingServiceError): HubResponse {
  return res(meetingServiceStatus(error.code), {
    error: error.reason,
    code: error.code,
  });
}

/** 只有老板与一名成员的 private 会话可自动派发；成员间私聊保持普通聊天。 */
function bossPrivateMember(
  db: DatabaseSync,
  conversationId: string,
): string | null {
  const sql =
    "SELECT kind, group_id, member_a, member_b FROM conversations" +
    " WHERE conversation_id = ?";
  const params: unknown[] = [conversationId];
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  const row = db.prepare(sql).get(...(params as never[])) as
    | {
        kind: string;
        group_id: string | null;
        member_a: string | null;
        member_b: string | null;
      }
    | undefined;
  if (
    row === undefined ||
    row.kind !== "private" ||
    row.group_id !== null ||
    row.member_a === row.member_b
  )
    return null;
  if (row.member_a === "boss" && row.member_b !== null) return row.member_b;
  if (row.member_b === "boss" && row.member_a !== null) return row.member_a;
  return null;
}

export function registerSocialRoutes(router: EndpointRouter): void {
  router.add("GET /api/v1/conversations", ({ deps }) =>
    res(200, { conversations: listConversations(deps.db, BOSS_READER) }),
  );

  router.add(
    "POST /api/v1/conversations/:id/open-private",
    async ({ deps, req }) => {
      const writer = deps.domainWriter;
      if (writer === undefined) return writerMissing();
      const body = parseJson(req.body);
      if (!body.ok) return malformedJson();
      const parsed = openPrivateRequestSchema.safeParse(body.value);
      if (!parsed.success) {
        return res(HTTP_UNPROCESSABLE, {
          error: "打开私聊的请求不合法。",
          code: "bad_body",
        });
      }
      const result = await openPrivate(writer, {
        memberA: parsed.data.member_a,
        memberB: parsed.data.member_b,
        nowMs: deps.now(),
      });
      return result.ok ? res(201, result) : conversationError(result);
    },
  );

  router.add(
    "GET /api/v1/conversations/:id/messages",
    ({ deps, req, params }) => {
      const result = listMessages(deps.db, params.id ?? "", req.query);
      return result.ok ? res(200, result) : conversationError(result);
    },
  );

  router.add(
    "POST /api/v1/conversations/:id/messages",
    async ({ deps, req, params }) => {
      const writer = deps.domainWriter;
      if (writer === undefined) return writerMissing();
      const body = parseJson(req.body);
      if (!body.ok) return malformedJson();
      const result = await sendMessage(writer, deps.bus, {
        conversationId: params.id ?? "",
        author: { kind: "boss" },
        req: body.value,
        nowMs: deps.now(),
      });
      if (!result.ok) return conversationError(result);
      if (result.group_id === null) {
        try {
          const memberId = bossPrivateMember(
            deps.db,
            result.message.conversation_id,
          );
          if (memberId === null || memberId === "boss") return res(200, result);
          const dispatch = await routePrivateInstruction(writer, deps.bus, {
            conversationId: result.message.conversation_id,
            memberId,
            text: result.message.body,
            sourceMessageId: result.message.message_id,
            nowMs: deps.now(),
            ...(deps.executorRunner === undefined
              ? {}
              : { execute: deps.executorRunner }),
            ...(deps.executorWorkspace === undefined
              ? {}
              : { workspace: deps.executorWorkspace }),
          });
          if (!dispatch.ok) {
            return res(200, {
              ...result,
              dispatch_error: "消息已发送，但私聊派发失败：" + dispatch.reason,
            });
          }
          return res(200, { ...result, dispatch });
        } catch (error) {
          return res(200, {
            ...result,
            dispatch_error:
              "消息已发送，但私聊派发失败：" +
              (error instanceof Error ? error.message : String(error)),
          });
        }
      }
      try {
        const dispatch = await routeGroupMessage(writer, deps.bus, {
          groupId: result.group_id,
          text: result.message.body,
          sourceMessageId: result.message.message_id,
          nowMs: deps.now(),
          ...(deps.executorRunner === undefined
            ? {}
            : { execute: deps.executorRunner }),
          ...(deps.executorWorkspace === undefined
            ? {}
            : { workspace: deps.executorWorkspace }),
        });
        return res(200, { ...result, dispatch });
      } catch (error) {
        return res(200, {
          ...result,
          dispatch: {
            ok: false,
            code: "message_failed",
            reason:
              "消息已发送，但 CoS 派发失败：" +
              (error instanceof Error ? error.message : String(error)),
          },
        });
      }
    },
  );

  router.add(
    "POST /api/v1/conversations/:id/read",
    async ({ deps, req, params }) => {
      const writer = deps.domainWriter;
      if (writer === undefined) return writerMissing();
      const body = parseJson(req.body);
      if (!body.ok) return malformedJson();
      const result = await markRead(writer, {
        conversationId: params.id ?? "",
        reader: BOSS_READER,
        req: body.value,
        nowMs: deps.now(),
      });
      return result.ok ? res(200, result) : conversationError(result);
    },
  );

  router.add("GET /api/v1/meetings", ({ deps, req }) =>
    res(200, {
      meetings: listMeetings(
        deps.db,
        req.query.group_id === undefined ? undefined : req.query.group_id,
      ),
    }),
  );

  router.add("POST /api/v1/meetings", async ({ deps, req }) => {
    const writer = deps.domainWriter;
    if (writer === undefined) return writerMissing();
    const body = parseJson(req.body);
    if (!body.ok) return malformedJson();
    const result = await createMeeting(writer, deps.bus, {
      req: body.value,
      nowMs: deps.now(),
    });
    return result.ok ? res(201, result) : meetingError(result);
  });

  router.add("GET /api/v1/meetings/:id", ({ deps, params }) => {
    const meeting = getMeeting(deps.db, params.id ?? "");
    return meeting === undefined
      ? res(HTTP_NOT_FOUND, {
          error: "会议不存在。",
          code: "meeting_not_found",
        })
      : res(200, { meeting });
  });

  router.add(
    "POST /api/v1/meetings/:id/turns",
    async ({ deps, req, params }) => {
      const writer = deps.domainWriter;
      if (writer === undefined) return writerMissing();
      const body = parseJson(req.body);
      if (!body.ok) return malformedJson();
      const result = await postTurn(writer, deps.bus, {
        meetingId: params.id ?? "",
        req: body.value,
        nowMs: deps.now(),
      });
      return result.ok ? res(200, result) : meetingError(result);
    },
  );

  router.add(
    "POST /api/v1/meetings/:id/conclude",
    async ({ deps, req, params }) => {
      const writer = deps.domainWriter;
      if (writer === undefined) return writerMissing();
      const body = parseJson(req.body);
      if (!body.ok) return malformedJson();
      const result = await concludeMeeting(writer, deps.bus, {
        meetingId: params.id ?? "",
        req: body.value,
        nowMs: deps.now(),
      });
      if (!result.ok) return meetingError(result);
      let summary: Awaited<ReturnType<typeof depositMeetingSummary>>;
      try {
        summary = await depositMeetingSummary(writer, deps.bus, {
          meetingId: params.id ?? "",
          nowMs: deps.now(),
        });
      } catch (error) {
        summary = {
          ok: false,
          code: "not_writable",
          reason:
            "会议已散会，但纪要自动沉淀失败：" +
            (error instanceof Error ? error.message : String(error)),
        };
      }
      return res(200, {
        ...result,
        governance: planMeetingConclusion(result.meeting),
        summary,
      });
    },
  );

  router.add(
    "POST /api/v1/meetings/:id/cancel",
    async ({ deps, req, params }) => {
      const writer = deps.domainWriter;
      if (writer === undefined) return writerMissing();
      const body = parseJson(req.body);
      if (!body.ok) return malformedJson();
      const result = await cancelMeeting(writer, deps.bus, {
        meetingId: params.id ?? "",
        req: body.value,
        nowMs: deps.now(),
      });
      return result.ok ? res(200, result) : meetingError(result);
    },
  );
}
