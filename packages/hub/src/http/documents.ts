/**
 * Document-center HTTP entry points. Reads use the readonly connection; every
 * mutation uses the single domain writer. HTTP callers act as boss, so viewer
 * identity is never accepted from a request body.
 */
import {
  CEO_ROLE_ID,
  DOC_EXPORT_FORMATS,
  type DocExportFormat,
  type DocumentView,
  HTTP_NOT_FOUND,
  HTTP_NOT_IMPLEMENTED,
  HTTP_UNPROCESSABLE,
  importDocumentRequestSchema,
} from "@opc/contracts";
import { getAsset } from "../assets/service.js";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import {
  detectDocumentFormat,
  exportDocument,
  FormatError,
  importDocumentBytes,
} from "../documents/formats.js";
import {
  createDocument,
  createDocumentTemplate,
  type DocumentMutationResult,
  type DocumentServiceError,
  deleteDocument,
  deleteDocumentPermission,
  documentServiceStatus,
  getDocument,
  listDocumentPermissions,
  listDocuments,
  listDocumentVersions,
  listTemplates,
  restoreDocument,
  saveDocument,
  setDocumentPermission,
  updateDocumentMeta,
} from "../documents/service.js";
import type { DomainEvent } from "../events/bus.js";
import { appendAudit } from "../events/recorder.js";
import type { HubDeps, HubRequest, HubResponse } from "./app.js";
import type { EndpointRouter, RouteParams } from "./router.js";

const BOSS = { kind: "boss" } as const;

type ParsedJson =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly response: HubResponse };

function res(status: number, body: unknown): HubResponse {
  return { status, body };
}

/** Unlike the older empty-body convention, document writes require real JSON. */
function parseJson(text: string): ParsedJson {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return {
      ok: false,
      response: res(HTTP_UNPROCESSABLE, {
        error: "请求体不是合法 JSON。",
        code: "bad_body",
      }),
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

function documentError(error: DocumentServiceError): HubResponse {
  return res(documentServiceStatus(error.code), {
    error: error.reason,
    code: error.code,
  });
}

function documentWriteResponse(
  status: number,
  result: DocumentMutationResult,
): HubResponse {
  if (!result.ok) return documentError(result);
  return res(status, {
    ok: true,
    document: result.document,
    audit_seq: result.auditSeq,
    ...(result.broadcastError === undefined
      ? {}
      : { broadcast_error: result.broadcastError }),
  });
}

/**
 * 打开与导出是读取，但「谁看了哪份文档」仍须留痕。审计走同一个单写节点并先提交，
 * 广播随后再做；只读装配没有 writer 时跳过审计，不能拿读连接伪造一次写入。
 */
async function auditDocumentAccess(
  deps: HubDeps,
  document: DocumentView,
  op: Extract<DomainEvent, { kind: "DocumentAccessed" }>["op"],
): Promise<{ readonly auditSeq?: number; readonly broadcastError?: string }> {
  const writer = deps.domainWriter;
  if (writer === undefined) return {};
  const nowMs = deps.now();
  const auditSeq = await writer.node(() =>
    appendAudit(
      requireScopeDb("documents/http"),
      {
        taskId: null,
        actorType: "human",
        actorId: CEO_ROLE_ID,
        action: "state_change",
        target: document.doc_id,
        payload: {
          kind: "document_accessed",
          op,
          doc_id: document.doc_id,
          group_id: document.group_id,
        },
        createdAt: nowMs,
      },
      () => nowMs,
    ),
  );
  try {
    deps.bus.publishPersisted(
      { kind: "DocumentAccessed", docId: document.doc_id, op },
      auditSeq,
    );
    return { auditSeq };
  } catch (error) {
    return {
      auditSeq,
      broadcastError: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatError(error: FormatError): HubResponse {
  return res(error.code === "too_large" ? 413 : HTTP_UNPROCESSABLE, {
    error: error.message,
    code: error.code,
  });
}

function exportFormat(raw: string | undefined): DocExportFormat | null {
  if (raw === undefined) return "md";
  return DOC_EXPORT_FORMATS.includes(raw as DocExportFormat)
    ? (raw as DocExportFormat)
    : null;
}

function attachment(filename: string): string {
  const fallback = filename
    .replace(/[^\x20-\x7e]/gu, "_")
    .replace(/["\\]/gu, "_");
  if (fallback === filename) return `attachment; filename="${filename}"`;
  const encoded = encodeURIComponent(filename).replace(
    /['()]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function listDocumentsRoute(deps: HubDeps, req: HubRequest): HubResponse {
  const result = listDocuments(deps.db, req.query, BOSS);
  return result.ok ? res(200, result) : documentError(result);
}

async function createDocumentRoute(
  deps: HubDeps,
  req: HubRequest,
): Promise<HubResponse> {
  const writer = deps.domainWriter;
  if (writer === undefined) return writerMissing();
  const body = parseJson(req.body);
  if (!body.ok) return body.response;
  const result = await createDocument(writer, deps.bus, {
    viewer: BOSS,
    req: body.value,
    nowMs: deps.now(),
  });
  return documentWriteResponse(201, result);
}

async function getDocumentRoute(
  deps: HubDeps,
  params: RouteParams,
): Promise<HubResponse> {
  const result = getDocument(deps.db, params.id ?? "", BOSS);
  if (!result.ok) return documentError(result);
  const access = await auditDocumentAccess(deps, result.document, "opened");
  return res(200, {
    ...result,
    ...(access.auditSeq === undefined ? {} : { audit_seq: access.auditSeq }),
    ...(access.broadcastError === undefined
      ? {}
      : { broadcast_error: access.broadcastError }),
  });
}

async function patchDocumentRoute(
  deps: HubDeps,
  req: HubRequest,
  params: RouteParams,
): Promise<HubResponse> {
  const writer = deps.domainWriter;
  if (writer === undefined) return writerMissing();
  const body = parseJson(req.body);
  if (!body.ok) return body.response;
  const docId = params.id ?? "";
  const options = { viewer: BOSS, nowMs: deps.now() };
  // body_text is the content-save discriminator. Metadata-only PATCH keeps its
  // separate service so owner-only group moves cannot ride a content edit.
  const result =
    typeof body.value === "object" &&
    body.value !== null &&
    !Array.isArray(body.value) &&
    Object.hasOwn(body.value, "body_text")
      ? await saveDocument(writer, deps.bus, {
          ...options,
          docId,
          req: body.value,
        })
      : await updateDocumentMeta(writer, deps.bus, {
          ...options,
          docId,
          req: body.value,
        });
  return documentWriteResponse(200, result);
}

async function deleteDocumentRoute(
  deps: HubDeps,
  params: RouteParams,
): Promise<HubResponse> {
  const writer = deps.domainWriter;
  if (writer === undefined) return writerMissing();
  const result = await deleteDocument(writer, deps.bus, {
    docId: params.id ?? "",
    viewer: BOSS,
    nowMs: deps.now(),
  });
  return documentWriteResponse(200, result);
}

function listVersionsRoute(deps: HubDeps, params: RouteParams): HubResponse {
  const result = listDocumentVersions(deps.db, params.id ?? "", BOSS);
  return result.ok ? res(200, result) : documentError(result);
}

async function restoreDocumentRoute(
  deps: HubDeps,
  params: RouteParams,
): Promise<HubResponse> {
  const writer = deps.domainWriter;
  if (writer === undefined) return writerMissing();
  const rawSeq = params.seq ?? "";
  const seq = Number(rawSeq);
  if (!/^[1-9]\d*$/u.test(rawSeq) || !Number.isSafeInteger(seq)) {
    return res(HTTP_UNPROCESSABLE, {
      error: "版本号必须是正整数。",
      code: "bad_body",
    });
  }
  const result = await restoreDocument(writer, deps.bus, {
    docId: params.id ?? "",
    seq,
    viewer: BOSS,
    nowMs: deps.now(),
  });
  return documentWriteResponse(200, result);
}

function listPermissionsRoute(deps: HubDeps, params: RouteParams): HubResponse {
  const result = listDocumentPermissions(deps.db, params.id ?? "", BOSS);
  return result.ok ? res(200, result) : documentError(result);
}

async function setPermissionRoute(
  deps: HubDeps,
  req: HubRequest,
  params: RouteParams,
): Promise<HubResponse> {
  const writer = deps.domainWriter;
  if (writer === undefined) return writerMissing();
  const body = parseJson(req.body);
  if (!body.ok) return body.response;
  const result = await setDocumentPermission(writer, deps.bus, {
    docId: params.id ?? "",
    viewer: BOSS,
    req: body.value,
    nowMs: deps.now(),
  });
  return documentWriteResponse(200, result);
}

async function deletePermissionRoute(
  deps: HubDeps,
  params: RouteParams,
): Promise<HubResponse> {
  const writer = deps.domainWriter;
  if (writer === undefined) return writerMissing();
  const result = await deleteDocumentPermission(writer, deps.bus, {
    docId: params.id ?? "",
    grantee: params.grantee ?? "",
    viewer: BOSS,
    nowMs: deps.now(),
  });
  return documentWriteResponse(200, result);
}

async function importDocumentRoute(
  deps: HubDeps,
  req: HubRequest,
): Promise<HubResponse> {
  const writer = deps.domainWriter;
  if (writer === undefined) return writerMissing();
  const body = parseJson(req.body);
  if (!body.ok) return body.response;
  const parsed = importDocumentRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    return res(HTTP_UNPROCESSABLE, {
      error: "文档导入请求不合法。",
      code: "bad_body",
    });
  }
  const request = parsed.data;
  const asset = getAsset(deps.db, request.asset_id);
  if (asset === undefined) {
    return res(HTTP_NOT_FOUND, {
      error: `资产 [${request.asset_id}] 不存在。`,
      code: "asset_not_found",
    });
  }
  if (asset.purpose !== "import-source") {
    return res(HTTP_UNPROCESSABLE, {
      error: "文档导入只能引用 purpose=import-source 的资产。",
      code: "invalid_asset",
    });
  }

  const buffer = Buffer.from(asset.data);
  try {
    const format = detectDocumentFormat({ buffer, mime: asset.mime });
    const imported = await importDocumentBytes({ buffer, format });
    if (request.kind !== undefined && request.kind !== imported.kind) {
      return res(HTTP_UNPROCESSABLE, {
        error: `请求 kind=${request.kind} 与导入格式 ${format} 不匹配。`,
        code: "kind_mismatch",
      });
    }
    const result = await createDocument(writer, deps.bus, {
      viewer: BOSS,
      origin: "imported",
      req: {
        kind: imported.kind,
        body_text: imported.bodyText,
        title: request.title ?? `Imported ${format.toUpperCase()}`,
        ...(request.group_id === undefined
          ? {}
          : { group_id: request.group_id }),
      },
      nowMs: deps.now(),
    });
    return documentWriteResponse(201, result);
  } catch (error) {
    if (error instanceof FormatError) return formatError(error);
    throw error;
  }
}

async function exportDocumentRoute(
  deps: HubDeps,
  req: HubRequest,
  params: RouteParams,
): Promise<HubResponse> {
  const format = exportFormat(req.query["format"]);
  if (format === null) {
    return res(HTTP_UNPROCESSABLE, {
      error: "format 必须是 md、docx、xlsx 或 pdf。",
      code: "bad_query",
    });
  }
  const result = getDocument(deps.db, params.id ?? "", BOSS);
  if (!result.ok) return documentError(result);
  const document = result.document;
  if (document.body_text === undefined) {
    throw new Error(
      `documents/http：文档 [${document.doc_id}] 详情缺少正文，拒绝导出空文件。`,
    );
  }
  try {
    const exported = await exportDocument({
      kind: document.kind,
      title: document.title,
      bodyText: document.body_text,
      format,
    });
    // 广播失败只丢投影提示，不能把已经生成并准备交付的字节改成错误响应。
    await auditDocumentAccess(deps, document, "exported");
    return {
      status: 200,
      body: exported.buffer,
      headers: {
        "content-type": exported.mime,
        "content-disposition": attachment(exported.filename),
      },
    };
  } catch (error) {
    if (error instanceof FormatError) return formatError(error);
    throw error;
  }
}

function listTemplatesRoute(deps: HubDeps): HubResponse {
  return res(200, { templates: listTemplates(deps.db) });
}

async function createTemplateRoute(
  deps: HubDeps,
  req: HubRequest,
): Promise<HubResponse> {
  if (deps.domainWriter === undefined) return writerMissing();
  const parsed = parseJson(req.body);
  if (!parsed.ok) return parsed.response;
  const result = await createDocumentTemplate(deps.domainWriter, {
    req: parsed.value,
    nowMs: deps.now(),
  });
  if (!result.ok) return documentError(result);
  return res(201, { ok: true, template: result.template });
}

/** Register exactly the fourteen document/template endpoints in the contract. */
export function registerDocumentRoutes(router: EndpointRouter): void {
  router.add("GET /api/v1/documents", ({ deps, req }) =>
    listDocumentsRoute(deps, req),
  );
  router.add("POST /api/v1/documents", ({ deps, req }) =>
    createDocumentRoute(deps, req),
  );
  router.add("GET /api/v1/documents/:id", ({ deps, params }) =>
    getDocumentRoute(deps, params),
  );
  router.add("PATCH /api/v1/documents/:id", ({ deps, req, params }) =>
    patchDocumentRoute(deps, req, params),
  );
  router.add("DELETE /api/v1/documents/:id", ({ deps, params }) =>
    deleteDocumentRoute(deps, params),
  );
  router.add("GET /api/v1/documents/:id/versions", ({ deps, params }) =>
    listVersionsRoute(deps, params),
  );
  router.add(
    "POST /api/v1/documents/:id/versions/:seq/restore",
    ({ deps, params }) => restoreDocumentRoute(deps, params),
  );
  router.add("GET /api/v1/documents/:id/permissions", ({ deps, params }) =>
    listPermissionsRoute(deps, params),
  );
  router.add(
    "POST /api/v1/documents/:id/permissions",
    ({ deps, req, params }) => setPermissionRoute(deps, req, params),
  );
  router.add(
    "DELETE /api/v1/documents/:id/permissions/:grantee",
    ({ deps, params }) => deletePermissionRoute(deps, params),
  );
  router.add("POST /api/v1/documents/import", ({ deps, req }) =>
    importDocumentRoute(deps, req),
  );
  router.add("GET /api/v1/documents/:id/export", ({ deps, req, params }) =>
    exportDocumentRoute(deps, req, params),
  );
  router.add("GET /api/v1/templates", ({ deps }) => listTemplatesRoute(deps));
  router.add("POST /api/v1/templates", ({ deps, req }) =>
    createTemplateRoute(deps, req),
  );
}
