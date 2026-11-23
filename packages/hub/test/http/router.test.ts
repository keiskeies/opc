import { describe, expect, it } from "vitest";
import type { HubDeps, HubRequest } from "../../src/http/app.js";
import { EndpointRouter } from "../../src/http/router.js";

const deps = {} as HubDeps;

function req(method: string, path: string): HubRequest {
  return {
    method,
    path,
    target: path + "?raw=1",
    query: { raw: "1" },
    headers: { "x-test": "yes" },
    body: '{"ok":true}',
    peer: "127.0.0.1",
  };
}

describe("EndpointRouter", () => {
  it("passes the original authenticated request and captured params to the handler", async () => {
    const router = new EndpointRouter();
    const request = req("GET", "/api/v1/groups/g-1");
    let seen: unknown;
    router.add("GET /api/v1/groups/:id", (o) => {
      seen = o;
      return { status: 200, body: { id: o.params.id } };
    });
    expect(await router.handle(deps, request)).toEqual({
      status: 200,
      body: { id: "g-1" },
    });
    expect(seen).toEqual({ deps, req: request, params: { id: "g-1" } });
  });

  it("decodes percent-encoded path parameters once and rejects malformed encoding", async () => {
    const router = new EndpointRouter();
    router.add("GET /api/v1/talent/:id", (o) => ({
      status: 200,
      body: { id: o.params.id },
    }));
    expect(
      await router.handle(deps, req("GET", "/api/v1/talent/pub%3Amember-1")),
    ).toEqual({ status: 200, body: { id: "pub:member-1" } });
    expect(
      await router.handle(deps, req("GET", "/api/v1/talent/%E0%A4%A")),
    ).toMatchObject({ status: 400, body: { code: "bad_path" } });
  });

  it("returns null for unknown paths/wrong methods and 501 for declared but unregistered endpoints", async () => {
    const router = new EndpointRouter();
    expect(
      await router.handle(deps, req("GET", "/api/v1/not-declared")),
    ).toBeNull();
    expect(
      await router.handle(deps, req("DELETE", "/api/v1/groups")),
    ).toBeNull();
    expect(await router.handle(deps, req("GET", "/api/v1/groups"))).toEqual({
      status: 501,
      body: { error: "GET /api/v1/groups 尚未实现。" },
    });
  });

  it("rejects duplicate endpoint registration instead of silently shadowing a handler", () => {
    const router = new EndpointRouter();
    router.add("GET /api/v1/groups", () => ({ status: 200, body: null }));
    expect(() =>
      router.add("GET /api/v1/groups", () => ({ status: 201, body: null })),
    ).toThrow(/重复注册/u);
  });
});
