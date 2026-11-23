/**
 * Contract endpoint matcher invariants.
 *
 * The matcher is shared by the HTTP fallback and the future router, so a silent
 * mismatch here turns a declared feature into either a 404 or a parameter routed
 * to the wrong resource. Every declared endpoint must round-trip, including
 * multi-parameter paths; literal segments must beat parameters regardless of
 * declaration order.
 */
import {
  API_ENDPOINTS,
  type ApiEndpoint,
  IMPLEMENTED_ENDPOINTS,
  matchContractEndpoint,
  UNIMPLEMENTED_ENDPOINTS,
} from "@opc/contracts";
import { describe, expect, it } from "vitest";

function splitEndpoint(endpoint: ApiEndpoint): {
  method: string;
  path: string;
} {
  const space = endpoint.indexOf(" ");
  if (space <= 0) throw new Error(`Malformed endpoint: ${endpoint}`);
  return { method: endpoint.slice(0, space), path: endpoint.slice(space + 1) };
}

function sample(endpoint: ApiEndpoint): {
  method: string;
  path: string;
  params: Readonly<Record<string, string>>;
} {
  const { method, path } = splitEndpoint(endpoint);
  const params: Record<string, string> = {};
  let index = 0;
  const concrete = path
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment;
      index += 1;
      const value = `fixture-${index}`;
      params[segment.slice(1)] = value;
      return value;
    })
    .join("/");
  return { method, path: concrete, params };
}

describe("matchContractEndpoint", () => {
  it("round-trips every declared endpoint with exact parameter names and values", () => {
    expect(API_ENDPOINTS.length).toBeGreaterThan(0);
    for (const endpoint of API_ENDPOINTS) {
      const request = sample(endpoint);
      expect(
        matchContractEndpoint(request.method, request.path),
        endpoint,
      ).toEqual({
        endpoint,
        params: request.params,
      });
    }
  });

  it("registers every planned endpoint family without silent shrinkage", () => {
    const expected = {
      groups: 6,
      members: 12,
      talent: 6,
      conversations: 5,
      meetings: 6,
      backlog: 6,
      documents: 14,
      plugins: 5,
      roles: 4,
      search: 1,
      assets: 2,
      rhythm: 4,
    };
    for (const [family, count] of Object.entries(expected)) {
      expect(
        API_ENDPOINTS.filter((endpoint) =>
          family === "documents"
            ? endpoint.includes("/api/v1/documents") ||
              endpoint.includes("/api/v1/templates")
            : family === "rhythm"
              ? endpoint.includes("/api/v1/rhythm/") ||
                endpoint.includes("/api/v1/research/")
              : endpoint.includes(`/api/v1/${family}`),
        ),
        family,
      ).toHaveLength(count);
    }
  });

  it("preserves the full API surface as a disjoint implemented/unimplemented union", () => {
    expect(
      API_ENDPOINTS.filter((endpoint) => endpoint.includes("/api/v1/")),
    ).toHaveLength(71);
    const implemented = API_ENDPOINTS.filter((endpoint) =>
      IMPLEMENTED_ENDPOINTS.includes(endpoint),
    );
    const unimplemented = API_ENDPOINTS.filter((endpoint) =>
      UNIMPLEMENTED_ENDPOINTS.includes(endpoint),
    );
    expect([...implemented, ...unimplemented].sort()).toEqual(
      [...API_ENDPOINTS].sort(),
    );
    expect(
      implemented.filter((endpoint) => unimplemented.includes(endpoint)),
    ).toEqual([]);
    expect(new Set(API_ENDPOINTS).size).toBe(API_ENDPOINTS.length);
    expect(new Set(IMPLEMENTED_ENDPOINTS).size).toBe(
      IMPLEMENTED_ENDPOINTS.length,
    );
  });

  it("prefers a literal sibling over a parameter, independent of table order", () => {
    expect(matchContractEndpoint("POST", "/approvals/batch")?.endpoint).toBe(
      "POST /approvals/batch",
    );
    expect(
      matchContractEndpoint("POST", "/api/v1/documents/import")?.endpoint,
    ).toBe("POST /api/v1/documents/import");
    expect(matchContractEndpoint("POST", "/approvals/card-1")?.endpoint).toBe(
      "POST /approvals/:interruptId",
    );
  });

  it("captures multiple parameters without swapping them", () => {
    expect(
      matchContractEndpoint(
        "DELETE",
        "/api/v1/groups/group-1/members/member-1?dryRun=true",
      ),
    ).toEqual({
      endpoint: "DELETE /api/v1/groups/:id/members/:memberId",
      params: { id: "group-1", memberId: "member-1" },
    });
    expect(
      matchContractEndpoint(
        "POST",
        "/api/v1/documents/doc-1/versions/7/restore",
      ),
    ).toEqual({
      endpoint: "POST /api/v1/documents/:id/versions/:seq/restore",
      params: { id: "doc-1", seq: "7" },
    });
  });

  it("does not turn unknown paths or wrong methods into hints", () => {
    expect(matchContractEndpoint("GET", "/api/v1/not-declared")).toBeNull();
    expect(matchContractEndpoint("DELETE", "/api/v1/groups")).toBeNull();
    expect(
      matchContractEndpoint("GET", "/api/v1/groups/group-1/extra"),
    ).toBeNull();
    expect(matchContractEndpoint("GET", "/api/v1/groups//")).toBeNull();
  });

  it("normalizes method case but leaves parameter values untouched", () => {
    expect(
      matchContractEndpoint("get", "/api/v1/members/Member%20One")?.params,
    ).toEqual({
      id: "Member%20One",
    });
  });
});
