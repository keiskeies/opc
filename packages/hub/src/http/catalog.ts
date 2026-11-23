/** Catalog, plugin, global-search and asset HTTP routes. */
import {
  createRoleRequestSchema,
  HTTP_NOT_FOUND,
  HTTP_NOT_IMPLEMENTED,
  HTTP_UNPROCESSABLE,
  installPluginRequestSchema,
  updatePluginRequestSchema,
  updateRoleRequestSchema,
  uploadAssetRequestSchema,
} from "@opc/contracts";
import { getAsset, putAsset } from "../assets/service.js";
import {
  deletePlugin,
  installPlugin,
  listPlugins,
  type PluginServiceError,
  pluginServiceStatus,
  probePlugin,
  updatePlugin,
} from "../plugins/service.js";
import {
  createRole,
  deleteRole,
  listRoles,
  type RoleServiceError,
  roleServiceStatus,
  updateRole,
} from "../roles/service.js";
import { searchAll } from "../search/service.js";
import type { HubDeps, HubRequest, HubResponse } from "./app.js";
import type { EndpointRouter } from "./router.js";

function res(
  status: number,
  body: unknown,
  headers?: Readonly<Record<string, string>>,
): HubResponse {
  return { status, body, ...(headers === undefined ? {} : { headers }) };
}

function writerMissing(): HubResponse {
  return res(HTTP_NOT_IMPLEMENTED, {
    error:
      "本装配未接领域写入（HubDeps.domainWriter）。501 而不是 404：路由已注册，" +
      "但写队列尚未接入。",
  });
}

type ParsedJson =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };

function parseJson(text: string): ParsedJson {
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

function invalidBody(
  error: string,
  issues: readonly { path: PropertyKey[]; message: string }[] = [],
): HubResponse {
  return res(HTTP_UNPROCESSABLE, {
    error,
    code: "bad_body",
    issues: issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
}

function roleError(error: RoleServiceError): HubResponse {
  return res(roleServiceStatus(error.code), {
    error: error.reason,
    code: error.code,
  });
}

function pluginError(error: PluginServiceError): HubResponse {
  return res(pluginServiceStatus(error.code), {
    error: error.reason,
    code: error.code,
  });
}

function searchRoute(deps: HubDeps, req: HubRequest): HubResponse {
  const rawFaces = req.query["faces"];
  const faces =
    rawFaces === undefined
      ? undefined
      : rawFaces.split(",").map((face) => face.trim());
  const result = searchAll(deps.db, {
    q: req.query["q"],
    ...(faces === undefined ? {} : { faces }),
    ...(req.query["limit"] === undefined ? {} : { limit: req.query["limit"] }),
  });
  return result.ok
    ? res(200, { hits: result.hits })
    : res(HTTP_UNPROCESSABLE, { error: result.reason, code: result.code });
}

export function registerCatalogRoutes(router: EndpointRouter): void {
  router.add("GET /api/v1/roles", ({ deps }) =>
    res(200, { roles: listRoles(deps.db) }),
  );

  router.add("POST /api/v1/roles", async ({ deps, req }) => {
    const writer = deps.domainWriter;
    if (writer === undefined) return writerMissing();
    const body = parseJson(req.body);
    if (!body.ok) return malformedJson();
    const parsed = createRoleRequestSchema.safeParse(body.value);
    if (!parsed.success)
      return invalidBody("角色创建请求非法。", parsed.error.issues);
    const result = await createRole(writer, {
      req: parsed.data,
      nowMs: deps.now(),
    });
    return result.ok ? res(201, result) : roleError(result);
  });

  router.add("PATCH /api/v1/roles/:id", async ({ deps, req, params }) => {
    const writer = deps.domainWriter;
    if (writer === undefined) return writerMissing();
    const body = parseJson(req.body);
    if (!body.ok) return malformedJson();
    const parsed = updateRoleRequestSchema.safeParse(body.value);
    if (!parsed.success)
      return invalidBody("角色更新请求非法。", parsed.error.issues);
    const result = await updateRole(writer, {
      roleId: params.id ?? "",
      req: parsed.data,
      nowMs: deps.now(),
    });
    return result.ok ? res(200, result) : roleError(result);
  });

  router.add("DELETE /api/v1/roles/:id", async ({ deps, params }) => {
    const writer = deps.domainWriter;
    if (writer === undefined) return writerMissing();
    const result = await deleteRole(writer, {
      roleId: params.id ?? "",
      nowMs: deps.now(),
    });
    return result.ok ? res(200, result) : roleError(result);
  });

  router.add("GET /api/v1/plugins", ({ deps }) =>
    res(200, { plugins: listPlugins(deps.db) }),
  );

  router.add("POST /api/v1/plugins", async ({ deps, req }) => {
    const writer = deps.domainWriter;
    if (writer === undefined) return writerMissing();
    const body = parseJson(req.body);
    if (!body.ok) return malformedJson();
    const parsed = installPluginRequestSchema.safeParse(body.value);
    if (!parsed.success)
      return invalidBody("插件安装请求非法。", parsed.error.issues);
    const result = await installPlugin(writer, {
      req: parsed.data,
      nowMs: deps.now(),
    });
    return result.ok ? res(201, result) : pluginError(result);
  });

  router.add("PATCH /api/v1/plugins/:id", async ({ deps, req, params }) => {
    const writer = deps.domainWriter;
    if (writer === undefined) return writerMissing();
    const body = parseJson(req.body);
    if (!body.ok) return malformedJson();
    const parsed = updatePluginRequestSchema.safeParse(body.value);
    if (!parsed.success)
      return invalidBody("插件更新请求非法。", parsed.error.issues);
    const result = await updatePlugin(writer, {
      pluginId: params.id ?? "",
      req: parsed.data,
      nowMs: deps.now(),
    });
    return result.ok ? res(200, result) : pluginError(result);
  });

  router.add("DELETE /api/v1/plugins/:id", async ({ deps, params }) => {
    const writer = deps.domainWriter;
    if (writer === undefined) return writerMissing();
    const result = await deletePlugin(writer, {
      pluginId: params.id ?? "",
      nowMs: deps.now(),
    });
    return result.ok ? res(200, result) : pluginError(result);
  });

  router.add("POST /api/v1/plugins/:id/probe", async ({ deps, params }) => {
    const writer = deps.domainWriter;
    if (writer === undefined) return writerMissing();
    const result = await probePlugin(writer, {
      pluginId: params.id ?? "",
      nowMs: deps.now(),
    });
    return result.ok ? res(200, result) : pluginError(result);
  });

  router.add("GET /api/v1/search", ({ deps, req }) => searchRoute(deps, req));

  router.add("POST /api/v1/assets", async ({ deps, req }) => {
    const writer = deps.domainWriter;
    if (writer === undefined) return writerMissing();
    const body = parseJson(req.body);
    if (!body.ok) return malformedJson();
    const parsed = uploadAssetRequestSchema.safeParse(body.value);
    if (!parsed.success)
      return invalidBody("资产上传请求非法。", parsed.error.issues);
    const encoded = parsed.data.data_base64;
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
        encoded,
      )
    ) {
      return invalidBody("data_base64 不是合法 base64。");
    }
    const data = Buffer.from(encoded, "base64");
    if (data.toString("base64") !== encoded)
      return invalidBody("data_base64 不是规范 base64。");
    const result = await putAsset(writer, {
      purpose: parsed.data.purpose,
      mime: parsed.data.mime,
      data,
      nowMs: deps.now(),
    });
    return result.ok
      ? res(201, result)
      : res(HTTP_UNPROCESSABLE, { error: result.reason, code: result.code });
  });

  router.add("GET /api/v1/assets/:id", ({ deps, params }) => {
    const asset = getAsset(deps.db, params.id ?? "");
    return asset === undefined
      ? res(HTTP_NOT_FOUND, { error: "资产不存在。", code: "asset_not_found" })
      : res(200, asset.data, {
          "content-type": asset.mime,
          "cache-control": "private, max-age=31536000, immutable",
        });
  });
}
