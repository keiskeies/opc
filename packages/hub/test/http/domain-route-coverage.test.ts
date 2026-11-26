import { API_ENDPOINTS } from "@opc/contracts";
import { describe, expect, it } from "vitest";
import { buildDomainRouter } from "../../src/http/registrars.js";

describe("domain route registration", () => {
  it("registers all 74 planned /api/v1 endpoints exactly once", () => {
    const router = buildDomainRouter();
    const planned = API_ENDPOINTS.filter((endpoint) =>
      endpoint.includes("/api/v1/"),
    );
    expect(planned).toHaveLength(74);
    expect(router.registeredEndpoints()).toHaveLength(74);
    expect(new Set(router.registeredEndpoints()).size).toBe(74);
    for (const endpoint of planned) {
      expect(router.has(endpoint), endpoint).toBe(true);
    }
  });
});
