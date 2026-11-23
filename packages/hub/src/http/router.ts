/** 契约端点分派器：路径匹配只认 contracts 的纯函数，注册表只存 endpoint → handler。 */
import { type ApiEndpoint, matchContractEndpoint } from "@opc/contracts";
import type { HubDeps, HubRequest, HubResponse } from "./app.js";

export type RouteParams = Readonly<Record<string, string>>;
export type RouteHandler = (o: {
  readonly deps: HubDeps;
  readonly req: HubRequest;
  readonly params: RouteParams;
}) => Promise<HubResponse> | HubResponse;

export class EndpointRouter {
  readonly #routes = new Map<ApiEndpoint, RouteHandler>();

  add(endpoint: ApiEndpoint, handler: RouteHandler): void {
    if (this.#routes.has(endpoint)) {
      throw new Error(`http/router：端点重复注册：${endpoint}`);
    }
    this.#routes.set(endpoint, handler);
  }

  has(endpoint: ApiEndpoint): boolean {
    return this.#routes.has(endpoint);
  }

  registeredEndpoints(): readonly ApiEndpoint[] {
    return [...this.#routes.keys()];
  }

  async handle(deps: HubDeps, req: HubRequest): Promise<HubResponse | null> {
    const hit = matchContractEndpoint(req.method, req.path);
    if (hit === null) return null;
    const handler = this.#routes.get(hit.endpoint);
    if (handler === undefined) {
      return { status: 501, body: { error: `${hit.endpoint} 尚未实现。` } };
    }
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(hit.params)) {
      try {
        params[key] = decodeURIComponent(value);
      } catch {
        return {
          status: 400,
          body: {
            error: `路径参数 [${key}] 的百分号编码不合法。`,
            code: "bad_path",
          },
        };
      }
    }
    return handler({ deps, req, params });
  }
}
