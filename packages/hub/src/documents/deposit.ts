/** T9 自动落档：通用文档沉淀与会议纪要回填；会议链接与文档同一事务。 */
import type { DocKind, MeetingView } from "@opc/contracts";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import type { Writer } from "../db/write-queue.js";
import type { EventBus } from "../events/bus.js";
import { getMeeting } from "../meetings/service.js";
import {
  createDocument,
  type DocumentMutationResult,
  type DocumentServiceError,
  type DocumentViewer,
} from "./service.js";

export type AutoDocumentRequest = {
  readonly kind: DocKind;
  readonly title: string;
  readonly body_text: string;
  readonly group_id?: string;
  readonly task_id?: string;
};

export type DepositAutoDocumentOptions = {
  readonly viewer: DocumentViewer;
  readonly req: AutoDocumentRequest;
  readonly nowMs: number;
  readonly newId?: () => string;
  /** 仅受信任的会议纪要调用方使用；createDocument 同事务回填并写第二条审计。 */
  readonly meetingSummaryId?: string;
};

type DocumentCreated = Extract<DocumentMutationResult, { ok: true }>;
export type DepositAutoDocumentResult =
  | (DocumentCreated & { readonly docId: string })
  | DocumentServiceError;

export type DepositMeetingSummaryOptions = {
  readonly meetingId: string;
  readonly nowMs: number;
  readonly newId?: () => string;
};

export type MeetingDepositError =
  | DocumentServiceError
  | {
      readonly ok: false;
      readonly code: "meeting_not_found" | "meeting_not_concluded";
      readonly reason: string;
    };

export type DepositMeetingSummaryResult =
  | { readonly ok: true; readonly docId: string; readonly created: false }
  | {
      readonly ok: true;
      readonly docId: string;
      readonly created: true;
      readonly document: DocumentCreated["document"];
      readonly auditSeq: number;
      readonly broadcastError?: string;
    }
  | MeetingDepositError;

const AUTO_VIEWER = { kind: "boss" } as const;

function depositError(
  code: "meeting_not_found" | "meeting_not_concluded",
  meetingId: string,
): MeetingDepositError {
  return {
    ok: false,
    code,
    reason:
      code === "meeting_not_found"
        ? `会议 [${meetingId}] 不存在，未沉淀纪要。`
        : `会议 [${meetingId}] 尚未 concluded，未沉淀纪要。`,
  };
}

export async function depositAutoDocument(
  w: Writer,
  bus: EventBus,
  o: DepositAutoDocumentOptions,
): Promise<DepositAutoDocumentResult> {
  const result = await createDocument(w, bus, {
    viewer: o.viewer,
    req: o.req,
    origin: "auto",
    nowMs: o.nowMs,
    ...(o.newId === undefined ? {} : { newId: o.newId }),
    ...(o.meetingSummaryId === undefined
      ? {}
      : { meetingSummaryId: o.meetingSummaryId }),
  });
  if (!result.ok) return result;
  return { ...result, docId: result.document.doc_id };
}

function deadlineText(deadline: number | null): string {
  if (deadline === null) return "未记录";
  const date = new Date(deadline);
  return Number.isFinite(date.getTime())
    ? date.toISOString()
    : String(deadline);
}

/** Markdown 是文档中心的权威正文；会议事实一项不缺，空值也明确写“未记录”。 */
function meetingSummaryMarkdown(meeting: MeetingView): string {
  const turns = meeting.turns
    .map(
      (turn) =>
        `### ${turn.turn_seq}. ${turn.speaker_member_id}\n\n${turn.content}`,
    )
    .join("\n\n");
  return [
    `# 会议纪要：${meeting.topic}`,
    "",
    `- 会议 ID：${meeting.meeting_id}`,
    `- 会议类型：${meeting.meeting_type}`,
    `- 主持人：${meeting.moderator_member_id ?? "未记录"}`,
    `- 发言顺序：${meeting.speaking_order.join(" → ")}`,
    `- 群：${meeting.group_id ?? "未记录"}`,
    `- 任务：${meeting.task_id ?? "未记录"}`,
    "",
    "## 发言记录",
    "",
    turns === "" ? "（无发言记录）" : turns,
    "",
    "## 结论",
    "",
    `- 决定：${meeting.decision ?? "未记录"}`,
    `- 负责人：${meeting.owner_member_id ?? "未记录"}`,
    `- 截止时间：${deadlineText(meeting.deadline_at)}`,
    "",
  ].join("\n");
}

export async function depositMeetingSummary(
  w: Writer,
  bus: EventBus,
  o: DepositMeetingSummaryOptions,
): Promise<DepositMeetingSummaryResult> {
  const before = await w.node(() =>
    getMeeting(requireScopeDb("depositMeetingSummary.read"), o.meetingId),
  );
  if (before === undefined)
    return depositError("meeting_not_found", o.meetingId);
  if (before.status !== "concluded") {
    return depositError("meeting_not_concluded", o.meetingId);
  }
  if (before.summary_doc_id !== null) {
    return { ok: true, docId: before.summary_doc_id, created: false };
  }

  const deposited = await depositAutoDocument(w, bus, {
    viewer: AUTO_VIEWER,
    req: {
      kind: "markdown",
      title: `会议纪要：${before.topic}`,
      body_text: meetingSummaryMarkdown(before),
      ...(before.group_id === null ? {} : { group_id: before.group_id }),
      ...(before.task_id === null ? {} : { task_id: before.task_id }),
    },
    nowMs: o.nowMs,
    ...(o.newId === undefined ? {} : { newId: o.newId }),
    meetingSummaryId: o.meetingId,
  });
  if (!deposited.ok) return deposited;
  if (deposited.meetingAuditSeq === undefined) {
    throw new Error(
      "documents/deposit：纪要文档已提交却没有会议审计，内部不变量被破坏。",
    );
  }
  return {
    ok: true,
    docId: deposited.docId,
    created: true,
    document: deposited.document,
    auditSeq: deposited.meetingAuditSeq,
    ...(deposited.broadcastError === undefined
      ? {}
      : { broadcastError: deposited.broadcastError }),
  };
}
