import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { Approval, ToolInvocation } from "@switchyard/contracts";
import { getHostedRouteAuthRequirement, registerErrorEnvelope, registerHostedToolRoutes } from "../src/index.js";

function makeInvocation(id: string): ToolInvocation {
  return {
    id,
    runId: "run_1",
    type: "fetch",
    status: "queued",
    approvalId: "approval_1",
    input: { request: { url: "https://example.com", method: "GET" } },
    createdAt: "2026-06-01T00:00:00.000Z"
  };
}

function makeApproval(id: string, toolInvocationId = "tool_1"): Approval {
  return {
    id,
    runId: "run_1",
    approvalType: "before_external_web_action",
    status: "pending",
    payload: { toolInvocationId },
    createdAt: "2026-06-01T00:00:00.000Z"
  };
}

describe("hosted tool route auth rules", () => {
  it("maps tool route scopes and keeps hosted POST /approvals unregistered", () => {
    expect(getHostedRouteAuthRequirement("POST", "/tools/invocations")).toMatchObject({
      routeId: "tools.invocations.create",
      scopes: ["tools:write"]
    });
    expect(getHostedRouteAuthRequirement("GET", "/tools/invocations")).toMatchObject({
      routeId: "tools.invocations.list",
      scopes: ["tools:read"]
    });
    expect(getHostedRouteAuthRequirement("GET", "/tools/invocations/tool_1")).toMatchObject({
      routeId: "tools.invocations.get",
      scopes: ["tools:read"]
    });
    expect(getHostedRouteAuthRequirement("GET", "/approvals")).toMatchObject({
      routeId: "tools.approvals.list",
      scopes: ["tools:read"]
    });
    expect(getHostedRouteAuthRequirement("GET", "/approvals/approval_1")).toMatchObject({
      routeId: "tools.approvals.get",
      scopes: ["tools:read"]
    });
    expect(getHostedRouteAuthRequirement("POST", "/approvals/approval_1/approve")).toMatchObject({
      routeId: "tools.approvals.approve",
      scopes: ["tools:write"]
    });
    expect(getHostedRouteAuthRequirement("POST", "/approvals/approval_1/reject")).toMatchObject({
      routeId: "tools.approvals.reject",
      scopes: ["tools:write"]
    });
    expect(getHostedRouteAuthRequirement("POST", "/approvals")).toBeNull();
  });
});

describe("hosted tool route registration", () => {
  it("registers hosted tool subset routes and leaves POST /approvals absent", async () => {
    const app = Fastify();
    registerErrorEnvelope(app);
    registerHostedToolRoutes(app, {
      hostedTools: {
        invoke: async () => ({
          statusCode: 202,
          invocation: makeInvocation("tool_1"),
          approval: makeApproval("approval_1")
        }),
        resolveApproval: async () => ({
          approval: { ...makeApproval("approval_1"), status: "approved", resolvedAt: "2026-06-01T00:00:02.000Z" },
          invocation: { ...makeInvocation("tool_1"), status: "completed", completedAt: "2026-06-01T00:00:02.000Z" }
        })
      },
      invocations: {
        get: async (id: string) => (id === "tool_1" ? makeInvocation("tool_1") : undefined),
        list: async () => ({ invocations: [makeInvocation("tool_1")], nextCursor: null })
      },
      approvals: {
        get: async (id: string) => (id === "approval_1" ? makeApproval("approval_1") : undefined),
        list: async () => ({ approvals: [makeApproval("approval_1")], nextCursor: null })
      }
    });

    try {
      const create = await app.inject({
        method: "POST",
        url: "/tools/invocations",
        payload: { runId: "run_1", type: "fetch", input: { url: "https://example.com", method: "GET" } }
      });
      expect(create.statusCode).toBe(401);

      const listInvocations = await app.inject({ method: "GET", url: "/tools/invocations" });
      expect(listInvocations.statusCode).toBe(401);

      const getInvocation = await app.inject({ method: "GET", url: "/tools/invocations/tool_1" });
      expect(getInvocation.statusCode).toBe(401);

      const listApprovals = await app.inject({ method: "GET", url: "/approvals" });
      expect(listApprovals.statusCode).toBe(401);

      const getApproval = await app.inject({ method: "GET", url: "/approvals/approval_1" });
      expect(getApproval.statusCode).toBe(401);

      const approve = await app.inject({ method: "POST", url: "/approvals/approval_1/approve", payload: {} });
      expect(approve.statusCode).toBe(401);

      const reject = await app.inject({ method: "POST", url: "/approvals/approval_1/reject", payload: {} });
      expect(reject.statusCode).toBe(401);

      const missing = await app.inject({ method: "POST", url: "/approvals", payload: {} });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
