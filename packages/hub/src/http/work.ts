/**
 * 任务面板、节奏事件与每日调研的 HTTP 入口。
 *
 * 读侧固定走 deps.db 的只读连接；写侧只接受装配注入的 domainWriter，
 * 不在 handler 里另开连接写库。HTTP 的调用者固定是老板，actor 不从请求体读取。
 */
import { HTTP_NOT_IMPLEMENTED, HTTP_UNPROCESSABLE } from "@opc/contracts";
import {
  type BacklogMutationResult,
  type BacklogServiceError,
  backlogServiceStatus,
  cancelBacklog,
  createBacklog,
  listBacklog,
  mergeBacklog,
  moveBacklog,
  reprioritizeBacklog,
  rescheduleBacklog,
  type SplitBacklogResult,
  splitBacklog,
} from "../backlog/service.js";
import { depositAutoDocument } from "../documents/deposit.js";
import {
  createResearchCard,
  listResearch,
  listRhythm,
  type RhythmServiceError,
  recordRhythmEvent,
  rhythmServiceStatus,
} from "../rhythm/service.js";
import type { HubDeps, HubRequest, HubResponse } from "./app.js";
import type { EndpointRouter, RouteParams } from "./router.js";

const BOSS = { kind: "boss" } as const;

type ParsedJson =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly response: HubResponse };

function res(status: number, body: unknown): HubResponse {
  return { status, body };
}

/** 空体、坏 JSON 与合法 JSON 的标量都必须在写路径上变成看得见的 422。 */
function parseJson(text: string): ParsedJson {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return {
      ok: false,
      response: badBody("请求体不是合法 JSON。"),
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function badBody(error: string): HubResponse {
  return res(HTTP_UNPROCESSABLE, { error, code: "bad_body" });
}

function workNotWired(): HubResponse {
  return res(HTTP_NOT_IMPLEMENTED, {
    error:
      "本装配未接领域写入（HubDeps.domainWriter）。501 而不是 404：路由在，" +
      "契约里有，是这个装配没把单写者队列连起来。",
  });
}

function backlogError(error: BacklogServiceError): HubResponse {
  return res(backlogServiceStatus(error.code), {
    error: error.reason,
    code: error.code,
  });
}

function rhythmError(error: RhythmServiceError): HubResponse {
  return res(rhythmServiceStatus(error.code), {
    error: error.reason,
    code: error.code,
  });
}

function backlogWriteResponse(
  status: number,
  result: BacklogMutationResult | SplitBacklogResult,
): HubResponse {
  if (!result.ok) return backlogError(result);
  const common = {
    ok: true,
    audit_seq: result.auditSeq,
    ...(result.broadcastError === undefined
      ? {}
      : { broadcast_error: result.broadcastError }),
  };
  if ("item" in result) {
    return res(status, { ...common, item: result.item });
  }
  return res(status, {
    ...common,
    parent: result.parent,
    children: result.children,
  });
}

function backlogId(params: RouteParams): string | null {
  return params.id ?? null;
}

function listBacklogRoute(deps: HubDeps, req: HubRequest): HubResponse {
  const result = listBacklog(deps.db, req.query);
  if (!result.ok) return backlogError(result);
  return res(200, { items: result.items });
}

async function createBacklogRoute(
  deps: HubDeps,
  req: HubRequest,
): Promise<HubResponse> {
  const writer = deps.domainWriter;
  if (writer === undefined) return workNotWired();
  const parsed = parseJson(req.body);
  if (!parsed.ok) return parsed.response;
  const result = await createBacklog(writer, deps.bus, {
    actor: BOSS,
    req: parsed.value,
    nowMs: deps.now(),
  });
  return backlogWriteResponse(201, result);
}

async function patchBacklogRoute(
  deps: HubDeps,
  req: HubRequest,
  params: RouteParams,
): Promise<HubResponse> {
  const writer = deps.domainWriter;
  if (writer === undefined) return workNotWired();
  const id = backlogId(params);
  if (id === null) return badBody("路由缺少任务面板条目 id。");
  const parsed = parseJson(req.body);
  if (!parsed.ok) return parsed.response;
  if (!isRecord(parsed.value)) {
    return badBody("PATCH 请求体必须是 JSON 对象。");
  }

  // 三个字段各自代表一种有独立审计语义的操作，不能合成通用 update。
  // 只数显式键：值为 null 的移动/延期仍然是操作，不能被当成“没传”。
  const hasGroup = Object.hasOwn(parsed.value, "group_id");
  const hasDue = Object.hasOwn(parsed.value, "due_at");
  const hasPriority = Object.hasOwn(parsed.value, "priority");
  if (Number(hasGroup) + Number(hasDue) + Number(hasPriority) !== 1) {
    return badBody(
      "PATCH 必须且只能显式提供 group_id、due_at、priority 中的一个字段。",
    );
  }

  let result: BacklogMutationResult;
  if (hasGroup) {
    result = await moveBacklog(writer, deps.bus, {
      id,
      actor: BOSS,
      req: parsed.value,
      nowMs: deps.now(),
    });
  } else if (hasDue) {
    result = await rescheduleBacklog(writer, deps.bus, {
      id,
      actor: BOSS,
      req: parsed.value,
      nowMs: deps.now(),
    });
  } else {
    result = await reprioritizeBacklog(writer, deps.bus, {
      id,
      actor: BOSS,
      req: parsed.value,
      nowMs: deps.now(),
    });
  }
  return backlogWriteResponse(200, result);
}

async function deleteBacklogRoute(
  deps: HubDeps,
  params: RouteParams,
): Promise<HubResponse> {
  const writer = deps.domainWriter;
  if (writer === undefined) return workNotWired();
  const id = backlogId(params);
  if (id === null) return badBody("路由缺少任务面板条目 id。");
  // 取消没有请求体；即使客户端捎带 body，也不解释成另一种操作。
  const result = await cancelBacklog(writer, deps.bus, {
    id,
    actor: BOSS,
    nowMs: deps.now(),
  });
  return backlogWriteResponse(200, result);
}

async function splitBacklogRoute(
  deps: HubDeps,
  req: HubRequest,
  params: RouteParams,
): Promise<HubResponse> {
  const writer = deps.domainWriter;
  if (writer === undefined) return workNotWired();
  const id = backlogId(params);
  if (id === null) return badBody("路由缺少任务面板条目 id。");
  const parsed = parseJson(req.body);
  if (!parsed.ok) return parsed.response;
  const result = await splitBacklog(writer, deps.bus, {
    id,
    actor: BOSS,
    req: parsed.value,
    nowMs: deps.now(),
  });
  if (!result.ok) return backlogWriteResponse(200, result);
  const document = await depositAutoDocument(writer, deps.bus, {
    viewer: BOSS,
    req: {
      kind: "markdown",
      title: `拆分：${result.parent.title}`,
      body_text: [
        `# 拆分：${result.parent.title}`,
        "",
        `- 父项：${result.parent.id}`,
        ...result.children.map((child) => `- 子项 ${child.id}：${child.title}`),
      ].join("\n"),
      ...(result.parent.group_id === null
        ? {}
        : { group_id: result.parent.group_id }),
    },
    nowMs: deps.now(),
  });
  return res(200, {
    ...result,
    document: document.ok ? { ok: true, doc_id: document.docId } : document,
  });
}

async function mergeBacklogRoute(
  deps: HubDeps,
  req: HubRequest,
  params: RouteParams,
): Promise<HubResponse> {
  const writer = deps.domainWriter;
  if (writer === undefined) return workNotWired();
  const id = backlogId(params);
  if (id === null) return badBody("路由缺少任务面板条目 id。");
  const parsed = parseJson(req.body);
  if (!parsed.ok) return parsed.response;
  const result = await mergeBacklog(writer, deps.bus, {
    id,
    actor: BOSS,
    req: parsed.value,
    nowMs: deps.now(),
  });
  if (!result.ok) return backlogWriteResponse(200, result);
  const document = await depositAutoDocument(writer, deps.bus, {
    viewer: BOSS,
    req: {
      kind: "markdown",
      title: `合并：${result.item.title}`,
      body_text: [
        `# 合并：${result.item.title}`,
        "",
        `- 源项：${result.item.id}`,
        `- 合并到：${result.item.merged_into ?? "未记录"}`,
        `- 状态：${result.item.state}`,
      ].join("\n"),
      ...(result.item.group_id === null
        ? {}
        : { group_id: result.item.group_id }),
    },
    nowMs: deps.now(),
  });
  return res(200, {
    ...result,
    document: document.ok ? { ok: true, doc_id: document.docId } : document,
  });
}

function listRhythmRoute(deps: HubDeps, req: HubRequest): HubResponse {
  const result = listRhythm(deps.db, req.query);
  if (!result.ok) return rhythmError(result);
  return res(200, { items: result.items });
}

function listResearchRoute(deps: HubDeps, req: HubRequest): HubResponse {
  const result = listResearch(deps.db, req.query, deps.now());
  if (!result.ok) return rhythmError(result);
  return res(200, { items: result.items });
}

function rhythmWriteResponse(result: {
  readonly ok: boolean;
  readonly auditSeq?: number;
  readonly broadcastError?: string;
  readonly document?: { readonly doc_id: string };
  readonly backlogItemId?: string;
}): HubResponse {
  return res(201, {
    ...result,
    ...(result.broadcastError === undefined
      ? {}
      : { broadcast_error: result.broadcastError }),
  });
}

async function createRhythmRoute(
  deps: HubDeps,
  req: HubRequest,
): Promise<HubResponse> {
  const writer = deps.domainWriter;
  if (writer === undefined) return workNotWired();
  const parsed = parseJson(req.body);
  if (!parsed.ok) return parsed.response;
  const result = await recordRhythmEvent(writer, deps.bus, {
    actor: BOSS,
    req: parsed.value,
    nowMs: deps.now(),
  });
  return result.ok ? rhythmWriteResponse(result) : rhythmError(result);
}

async function createResearchRoute(
  deps: HubDeps,
  req: HubRequest,
): Promise<HubResponse> {
  const writer = deps.domainWriter;
  if (writer === undefined) return workNotWired();
  const parsed = parseJson(req.body);
  if (!parsed.ok) return parsed.response;
  const result = await createResearchCard(writer, deps.bus, {
    actor: BOSS,
    req: parsed.value,
    nowMs: deps.now(),
  });
  return result.ok ? rhythmWriteResponse(result) : rhythmError(result);
}

/** 只登记 T10 的面板与节奏读面；旧端点与其余新面由各自 registrar 负责。 */
export function registerWorkRoutes(router: EndpointRouter): void {
  router.add("GET /api/v1/backlog", ({ deps, req }) =>
    listBacklogRoute(deps, req),
  );
  router.add("POST /api/v1/backlog", ({ deps, req }) =>
    createBacklogRoute(deps, req),
  );
  router.add("PATCH /api/v1/backlog/:id", ({ deps, req, params }) =>
    patchBacklogRoute(deps, req, params),
  );
  router.add("DELETE /api/v1/backlog/:id", ({ deps, params }) =>
    deleteBacklogRoute(deps, params),
  );
  router.add("POST /api/v1/backlog/:id/split", ({ deps, req, params }) =>
    splitBacklogRoute(deps, req, params),
  );
  router.add("POST /api/v1/backlog/:id/merge", ({ deps, req, params }) =>
    mergeBacklogRoute(deps, req, params),
  );
  router.add("GET /api/v1/rhythm/events", ({ deps, req }) =>
    listRhythmRoute(deps, req),
  );
  router.add("POST /api/v1/rhythm/events", ({ deps, req }) =>
    createRhythmRoute(deps, req),
  );
  router.add("GET /api/v1/research/today", ({ deps, req }) =>
    listResearchRoute(deps, req),
  );
  router.add("POST /api/v1/research/today", ({ deps, req }) =>
    createResearchRoute(deps, req),
  );
}
