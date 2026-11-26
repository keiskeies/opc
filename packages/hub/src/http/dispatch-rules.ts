/**
 * CoS 分发规则 HTTP 入口：读走只读连接，两条写走单写者领域队列。
 *
 * 形状与 catalog.ts 的 roles/plugins 一致（writerMissing → parseJson → schema →
 * service → code 映射状态码），独立成文件是因为规则面的判据在 dispatch/rules.ts，
 * 而 catalog 那一份注册表里塞进第四个不相关的面只会让两边都更难读。
 */
import {
  createDispatchRuleRequestSchema,
  HTTP_NOT_IMPLEMENTED,
  HTTP_UNPROCESSABLE,
  updateDispatchRuleRequestSchema,
} from "@opc/contracts";
import {
  createDispatchRule,
  type DispatchRuleServiceError,
  dispatchRuleServiceStatus,
  listDispatchRuleViews,
  updateDispatchRule,
} from "../dispatch/rules.js";
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

type ParsedJson =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };

/** 空体算「一个字段都不传」：PATCH 的语义本就是未传字段保持原值。 */
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

function ruleError(error: DispatchRuleServiceError): HubResponse {
  return res(dispatchRuleServiceStatus(error.code), {
    error: error.reason,
    code: error.code,
  });
}

export function registerDispatchRuleRoutes(router: EndpointRouter): void {
  router.add("GET /api/v1/dispatch/rules", ({ deps }) =>
    res(200, { rules: listDispatchRuleViews(deps.db) }),
  );

  router.add("POST /api/v1/dispatch/rules", async ({ deps, req }) => {
    const writer = deps.domainWriter;
    if (writer === undefined) return writerMissing();
    const body = parseJson(req.body);
    if (!body.ok) return malformedJson();
    const parsed = createDispatchRuleRequestSchema.safeParse(body.value);
    if (!parsed.success)
      return invalidBody("分发规则创建请求非法。", parsed.error.issues);
    const result = await createDispatchRule(writer, {
      req: parsed.data,
      nowMs: deps.now(),
    });
    return result.ok ? res(201, result) : ruleError(result);
  });

  router.add(
    "PATCH /api/v1/dispatch/rules/:id",
    async ({ deps, req, params }) => {
      const writer = deps.domainWriter;
      if (writer === undefined) return writerMissing();
      const body = parseJson(req.body);
      if (!body.ok) return malformedJson();
      const parsed = updateDispatchRuleRequestSchema.safeParse(body.value);
      if (!parsed.success)
        return invalidBody("分发规则更新请求非法。", parsed.error.issues);
      const result = await updateDispatchRule(writer, {
        ruleId: params.id ?? "",
        req: parsed.data,
        nowMs: deps.now(),
      });
      return result.ok ? res(200, result) : ruleError(result);
    },
  );
}
