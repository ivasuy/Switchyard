import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { ControlPlaneError } from "@switchyard/core";
import type { AuthContext } from "@switchyard/contracts";
import { getHostedRouteAuthRequirement, registerHostedAuthHooks } from "../src/index.js";

describe("hosted auth debate route rules", () => {
  it("maps only the existing debate route family to runs scopes", () => {
    expect(getHostedRouteAuthRequirement("POST", "/debates")).toMatchObject({
      routeId: "debates.create",
      scopes: ["runs:write"]
    });
    expect(getHostedRouteAuthRequirement("GET", "/debates/debate_1")).toMatchObject({
      routeId: "debates.get",
      scopes: ["runs:read"]
    });
    expect(getHostedRouteAuthRequirement("GET", "/debates/debate_1/events")).toMatchObject({
      routeId: "debates.events",
      scopes: ["runs:read"]
    });

    expect(getHostedRouteAuthRequirement("POST", "/debates/participants/real")).toBeNull();
    expect(getHostedRouteAuthRequirement("POST", "/debates/debate_1/judge")).toBeNull();
    expect(getHostedRouteAuthRequirement("POST", "/model-judge")).toBeNull();
    expect(getHostedRouteAuthRequirement("POST", "/judging")).toBeNull();
  });

  it("requires runs:write for POST /debates and runs:read for inspect/events", async () => {
    const app = Fastify();
    const controlPlane = {
      authenticateRequest: vi.fn(async () => authContext(["runs:read"])),
      requireScope: vi.fn((auth: AuthContext, scope: string) => {
        if (!auth.apiKey.scopes.includes(scope as never)) {
          throw new ControlPlaneError("tenant_access_denied", "missing_scope", "missing_scope", { scope });
        }
      })
    };
    registerHostedAuthHooks(app, { controlPlane: controlPlane as never });
    app.post("/debates", async () => ({ ok: true }));
    app.get("/debates/:id", async () => ({ ok: true }));
    app.get("/debates/:id/events", async () => ({ ok: true }));

    const create = await app.inject({ method: "POST", url: "/debates", headers: { authorization: "Bearer sk" }, payload: {} });
    const inspect = await app.inject({ method: "GET", url: "/debates/debate_1", headers: { authorization: "Bearer sk" } });
    const events = await app.inject({ method: "GET", url: "/debates/debate_1/events", headers: { authorization: "Bearer sk" } });

    expect(create.statusCode).toBe(403);
    expect(create.json().error.details[0]).toMatchObject({ path: "reasonCode", issue: "missing_scope" });
    expect(inspect.statusCode).toBe(200);
    expect(events.statusCode).toBe(200);
    expect(controlPlane.requireScope).toHaveBeenCalledWith(expect.any(Object), "runs:write");
    expect(controlPlane.requireScope).toHaveBeenCalledWith(expect.any(Object), "runs:read");
    await app.close();
  });
});

function authContext(scopes: AuthContext["apiKey"]["scopes"]): AuthContext {
  return {
    apiKey: { scopes }
  } as AuthContext;
}
