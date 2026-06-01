import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
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

function makeRuntimeApproval(id: string): Approval {
  return {
    id,
    runId: "run_1",
    approvalType: "before_external_web_action",
    status: "pending",
    payload: { runtimeApprovalToken: "pause_1" },
    createdAt: "2026-06-01T00:00:00.000Z"
  };
}

function attachHostedAuth(app: ReturnType<typeof Fastify>) {
  app.addHook("onRequest", async (request) => {
    request.hostedAuth = {
      requirement: { routeId: "tools.test", scopes: ["tools:read"], public: false },
      auth: {
        account: { id: "account_1", name: "Acme", status: "active", billingPlanId: "plan_1", createdAt: "2026-06-01T00:00:00.000Z" },
        tenant: { id: "tenant_1", accountId: "account_1", slug: "acme", displayName: "Acme", status: "active", createdAt: "2026-06-01T00:00:00.000Z" },
        project: { id: "project_1", accountId: "account_1", tenantId: "tenant_1", slug: "proj", displayName: "Project", status: "active", createdAt: "2026-06-01T00:00:00.000Z" },
        user: { id: "user_1", accountId: "account_1", tenantId: "tenant_1", displayName: "Owner", status: "active", createdAt: "2026-06-01T00:00:00.000Z" },
        apiKey: {
          id: "key_1",
          accountId: "account_1",
          tenantId: "tenant_1",
          projectId: "project_1",
          userId: "user_1",
          name: "test",
          keyPrefix: "sk_sw",
          scopes: ["tools:read", "tools:write"],
          status: "active",
          createdAt: "2026-06-01T00:00:00.000Z"
        },
        entitlement: {
          accountId: "account_1",
          tenantId: "tenant_1",
          projectId: "project_1",
          planId: "plan_1",
          planSlug: "enterprise",
          planDisplayName: "Enterprise",
          planStatus: "active",
          entitlements: {
            allowedPlacements: ["hosted", "local", "connected_local_node"],
            allowedRuntimeModes: ["fake.deterministic"],
            allowHostedRealRuntime: false,
            allowConnectedNodes: true,
            allowHostedTools: true,
            allowConnectedNodeTools: true,
            allowedToolTypes: ["fetch"],
            allowArtifactContentRead: true,
            allowToolArtifactContentRead: true,
            allowMetricsRead: true,
            allowAuditRead: true
          },
          quotas: {
            maxRunsPerHour: 100,
            maxActiveRuns: 50,
            maxRunTimeoutSeconds: 600,
            maxConnectedNodes: 5,
            maxArtifactContentReadBytesPerHour: 1048576,
            maxToolInvocationsPerHour: 100,
            maxActiveToolInvocations: 50,
            maxToolArtifactBytesPerHour: 1048576
          },
          scopes: ["tools:read", "tools:write"],
          capturedAt: "2026-06-01T00:00:00.000Z"
        }
      }
    };
  });
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

describe("hosted tool route ownership and approval filtering", () => {
  it("filters list to owned tool approvals with cursor pagination", async () => {
    const app = Fastify();
    registerErrorEnvelope(app);
    attachHostedAuth(app);

    const approvals = new Map<string, Approval>([
      ["approval_new", { ...makeApproval("approval_new"), createdAt: "2026-06-01T02:00:00.000Z" }],
      ["approval_runtime", { ...makeRuntimeApproval("approval_runtime"), createdAt: "2026-06-01T01:00:00.000Z" }],
      ["approval_old", { ...makeApproval("approval_old"), createdAt: "2026-06-01T00:00:00.000Z" }],
      ["approval_unowned", { ...makeApproval("approval_unowned"), createdAt: "2026-06-01T03:00:00.000Z" }]
    ]);

    registerHostedToolRoutes(app, {
      hostedTools: {
        invoke: async () => ({ statusCode: 202, invocation: makeInvocation("tool_1") }),
        resolveApproval: async () => ({ approval: makeApproval("approval_old"), invocation: makeInvocation("tool_1") })
      },
      runs: { get: async () => ({ id: "run_1" } as any) },
      invocations: {
        get: async () => makeInvocation("tool_1"),
        list: async () => ({ invocations: [makeInvocation("tool_1")], nextCursor: null })
      },
      approvals: {
        get: async (id: string) => approvals.get(id),
        list: async () => ({ approvals: [...approvals.values()], nextCursor: null })
      },
      controlPlane: {
        authorizeResource: async () => ({ ok: true })
      } as any,
      controlPlaneStore: {
        listOwnedResourceIds: async () => ["approval_new", "approval_runtime", "approval_old"]
      } as any
    });

    try {
      const firstPage = await app.inject({ method: "GET", url: "/approvals?limit=1" });
      expect(firstPage.statusCode).toBe(200);
      expect(firstPage.json().approvals).toHaveLength(1);
      expect(firstPage.json().approvals[0].id).toBe("approval_new");
      expect(typeof firstPage.json().nextCursor).toBe("string");

      const secondPage = await app.inject({
        method: "GET",
        url: `/approvals?limit=1&before=${encodeURIComponent(firstPage.json().nextCursor)}`
      });
      expect(secondPage.statusCode).toBe(200);
      expect(secondPage.json().approvals).toHaveLength(1);
      expect(secondPage.json().approvals[0].id).toBe("approval_old");
      expect(secondPage.json().nextCursor).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("enforces ownership-first no-leak and denies runtime approval get/resolve", async () => {
    const app = Fastify();
    registerErrorEnvelope(app);
    attachHostedAuth(app);

    const getApproval = vi.fn(async (id: string) => (id === "approval_runtime"
      ? makeRuntimeApproval("approval_runtime")
      : makeApproval(id)));
    const resolveApproval = vi.fn(async () => ({ approval: makeApproval("approval_runtime"), invocation: makeInvocation("tool_1") }));
    const authorizeResource = vi.fn(async ({ resourceId }: { resourceId: string }) => {
      if (resourceId === "approval_hidden") {
        return { ok: false, code: "approval_not_found", reasonCode: "approval_not_found" };
      }
      return { ok: true };
    });

    registerHostedToolRoutes(app, {
      hostedTools: {
        invoke: async () => ({ statusCode: 202, invocation: makeInvocation("tool_1") }),
        resolveApproval
      },
      runs: { get: async () => ({ id: "run_1" } as any) },
      invocations: {
        get: async () => makeInvocation("tool_1"),
        list: async () => ({ invocations: [makeInvocation("tool_1")], nextCursor: null })
      },
      approvals: {
        get: getApproval,
        list: async () => ({ approvals: [makeApproval("approval_1")], nextCursor: null })
      },
      controlPlane: {
        authorizeResource
      } as any,
      controlPlaneStore: {
        listOwnedResourceIds: async () => ["approval_1", "approval_runtime"]
      } as any
    });

    try {
      const hidden = await app.inject({ method: "GET", url: "/approvals/approval_hidden" });
      expect(hidden.statusCode).toBe(404);
      expect(hidden.json().error.code).toBe("approval_not_found");
      expect(getApproval).not.toHaveBeenCalledWith("approval_hidden");

      const runtimeGet = await app.inject({ method: "GET", url: "/approvals/approval_runtime" });
      expect(runtimeGet.statusCode).toBe(409);
      expect(runtimeGet.json().error.code).toBe("hosted_runtime_approval_bridge_unshipped");

      const runtimeApprove = await app.inject({
        method: "POST",
        url: "/approvals/approval_runtime/approve",
        payload: {}
      });
      expect(runtimeApprove.statusCode).toBe(409);
      expect(runtimeApprove.json().error.code).toBe("hosted_runtime_approval_bridge_unshipped");
      expect(resolveApproval).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
