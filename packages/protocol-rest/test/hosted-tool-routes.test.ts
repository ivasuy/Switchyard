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

function makeRuntimeApproval(id: string, runtimeMode = "claude_code.sdk"): Approval {
  return {
    id,
    runId: "run_1",
    approvalType: "before_external_web_action",
    status: "pending",
    payload: { runtimeApprovalToken: "pause_1", runtimeMode },
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
  it("filters list to owned tool/runtime approvals with cursor pagination", async () => {
    const app = Fastify();
    registerErrorEnvelope(app);
    attachHostedAuth(app);

    const approvals = new Map<string, Approval>([
      ["approval_new", { ...makeApproval("approval_new"), createdAt: "2026-06-01T02:00:00.000Z" }],
      ["approval_runtime", { ...makeRuntimeApproval("approval_runtime"), createdAt: "2026-06-01T01:00:00.000Z" }],
      ["approval_old", { ...makeApproval("approval_old"), createdAt: "2026-06-01T00:00:00.000Z" }],
      ["approval_unowned", { ...makeApproval("approval_unowned"), createdAt: "2026-06-01T03:00:00.000Z" }]
    ]);

    const resolveRuntimeApproval = vi.fn(async () => ({
      approval: { ...makeRuntimeApproval("approval_runtime"), status: "approved", resolvedAt: "2026-06-01T00:00:03.000Z" },
      commandId: "bridge_cmd_runtime_1",
      duplicate: false
    }));

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
      } as any,
      hostedRuntimeBridge: {
        resolveRuntimeApproval
      }
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
      expect(secondPage.json().approvals[0].id).toBe("approval_runtime");
      expect(typeof secondPage.json().nextCursor).toBe("string");

      const thirdPage = await app.inject({
        method: "GET",
        url: `/approvals?limit=1&before=${encodeURIComponent(secondPage.json().nextCursor)}`
      });
      expect(thirdPage.statusCode).toBe(200);
      expect(thirdPage.json().approvals).toHaveLength(1);
      expect(thirdPage.json().approvals[0].id).toBe("approval_old");
      expect(thirdPage.json().nextCursor).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("enforces ownership-first no-leak and routes runtime approval resolve through bridge service", async () => {
    const app = Fastify();
    registerErrorEnvelope(app);
    attachHostedAuth(app);

    const getApproval = vi.fn(async (id: string) => (id === "approval_runtime"
      ? makeRuntimeApproval("approval_runtime")
      : makeApproval(id)));
    const resolveApproval = vi.fn(async () => ({ approval: makeApproval("approval_runtime"), invocation: makeInvocation("tool_1") }));
    const resolveRuntimeApproval = vi.fn(async () => ({
      approval: { ...makeRuntimeApproval("approval_runtime"), status: "approved", resolvedAt: "2026-06-01T00:00:01.000Z" },
      commandId: "bridge_cmd_runtime_2",
      duplicate: false
    }));
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
      } as any,
      hostedRuntimeBridge: { resolveRuntimeApproval }
    });

    try {
      const hidden = await app.inject({ method: "GET", url: "/approvals/approval_hidden" });
      expect(hidden.statusCode).toBe(404);
      expect(hidden.json().error.code).toBe("approval_not_found");
      expect(getApproval).not.toHaveBeenCalledWith("approval_hidden");

      const runtimeGet = await app.inject({ method: "GET", url: "/approvals/approval_runtime" });
      expect(runtimeGet.statusCode).toBe(200);
      expect(runtimeGet.json().approval.id).toBe("approval_runtime");

      const runtimeApprove = await app.inject({
        method: "POST",
        url: "/approvals/approval_runtime/approve",
        headers: {
          "idempotency-key": "approval-runtime-key-1"
        },
        payload: {}
      });
      expect(runtimeApprove.statusCode).toBe(200);
      expect(runtimeApprove.json().approval.id).toBe("approval_runtime");
      expect(runtimeApprove.json().bridgeCommandId).toBe("bridge_cmd_runtime_2");
      expect(resolveApproval).not.toHaveBeenCalled();
      expect(resolveRuntimeApproval).toHaveBeenCalledTimes(1);
      expect(resolveRuntimeApproval).toHaveBeenCalledWith(expect.objectContaining({
        approvalId: "approval_runtime",
        decision: "approved",
        idempotencyKey: "approval-runtime-key-1"
      }));
    } finally {
      await app.close();
    }
  });

  it("supports same-idempotency same-decision replay for runtime approval resolution", async () => {
    const app = Fastify();
    registerErrorEnvelope(app);
    attachHostedAuth(app);

    const commandByIdempotency = new Map<string, string>();
    const signatureByIdempotency = new Map<string, string>();
    const resolveRuntimeApproval = vi.fn(async (input: {
      approvalId: string;
      decision: "approved" | "rejected";
      body?: Record<string, unknown>;
      idempotencyKey?: string;
    }) => {
      const key = input.idempotencyKey ?? "";
      const signature = JSON.stringify({ decision: input.decision, body: input.body ?? {} });
      const existingSignature = signatureByIdempotency.get(key);
      const existingCommand = commandByIdempotency.get(key);
      if (existingSignature && existingCommand) {
        if (existingSignature !== signature) {
          throw {
            code: "adapter_protocol_failed",
            message: "Runtime bridge payload mismatch for idempotency key",
            details: [{ path: "reasonCode", issue: "hosted_runtime_bridge_payload_mismatch" }]
          };
        }
        return {
          approval: { ...makeRuntimeApproval(input.approvalId), status: input.decision, resolvedAt: "2026-06-01T00:00:01.000Z" },
          commandId: existingCommand,
          duplicate: true
        };
      }
      const commandId = `bridge_cmd_${key}`;
      signatureByIdempotency.set(key, signature);
      commandByIdempotency.set(key, commandId);
      return {
        approval: { ...makeRuntimeApproval(input.approvalId), status: input.decision, resolvedAt: "2026-06-01T00:00:01.000Z" },
        commandId,
        duplicate: false
      };
    });

    registerHostedToolRoutes(app, {
      hostedTools: {
        invoke: async () => ({ statusCode: 202, invocation: makeInvocation("tool_1") }),
        resolveApproval: async () => ({ approval: makeApproval("approval_runtime"), invocation: makeInvocation("tool_1") })
      },
      runs: { get: async () => ({ id: "run_1" } as any) },
      invocations: {
        get: async () => makeInvocation("tool_1"),
        list: async () => ({ invocations: [makeInvocation("tool_1")], nextCursor: null })
      },
      approvals: {
        get: async () => makeRuntimeApproval("approval_runtime"),
        list: async () => ({ approvals: [makeRuntimeApproval("approval_runtime")], nextCursor: null })
      },
      controlPlane: {
        authorizeResource: async () => ({ ok: true })
      } as any,
      controlPlaneStore: {
        listOwnedResourceIds: async () => ["approval_runtime"]
      } as any,
      hostedRuntimeBridge: { resolveRuntimeApproval }
    });

    try {
      const first = await app.inject({
        method: "POST",
        url: "/approvals/approval_runtime/approve",
        headers: {
          "idempotency-key": "runtime-replay-key"
        },
        payload: {
          message: "same decision",
          answers: { step: 1 }
        }
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: "POST",
        url: "/approvals/approval_runtime/approve",
        headers: {
          "idempotency-key": "runtime-replay-key"
        },
        payload: {
          message: "same decision",
          answers: { step: 1 }
        }
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().bridgeCommandId).toBe(first.json().bridgeCommandId);
      expect(resolveRuntimeApproval).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("rejects same-idempotency runtime approval resolution with different payload", async () => {
    const app = Fastify();
    registerErrorEnvelope(app);
    attachHostedAuth(app);

    const signatureByIdempotency = new Map<string, string>();
    const resolveRuntimeApproval = vi.fn(async (input: {
      approvalId: string;
      decision: "approved" | "rejected";
      body?: Record<string, unknown>;
      idempotencyKey?: string;
    }) => {
      const key = input.idempotencyKey ?? "";
      const signature = JSON.stringify({ decision: input.decision, body: input.body ?? {} });
      const existingSignature = signatureByIdempotency.get(key);
      if (existingSignature && existingSignature !== signature) {
        throw {
          code: "adapter_protocol_failed",
          message: "Runtime bridge payload mismatch for idempotency key",
          details: [{ path: "reasonCode", issue: "hosted_runtime_bridge_payload_mismatch" }]
        };
      }
      signatureByIdempotency.set(key, signature);
      return {
        approval: { ...makeRuntimeApproval(input.approvalId), status: input.decision, resolvedAt: "2026-06-01T00:00:01.000Z" },
        commandId: `bridge_cmd_${key}`,
        duplicate: Boolean(existingSignature)
      };
    });

    registerHostedToolRoutes(app, {
      hostedTools: {
        invoke: async () => ({ statusCode: 202, invocation: makeInvocation("tool_1") }),
        resolveApproval: async () => ({ approval: makeApproval("approval_runtime"), invocation: makeInvocation("tool_1") })
      },
      runs: { get: async () => ({ id: "run_1" } as any) },
      invocations: {
        get: async () => makeInvocation("tool_1"),
        list: async () => ({ invocations: [makeInvocation("tool_1")], nextCursor: null })
      },
      approvals: {
        get: async () => makeRuntimeApproval("approval_runtime"),
        list: async () => ({ approvals: [makeRuntimeApproval("approval_runtime")], nextCursor: null })
      },
      controlPlane: {
        authorizeResource: async () => ({ ok: true })
      } as any,
      controlPlaneStore: {
        listOwnedResourceIds: async () => ["approval_runtime"]
      } as any,
      hostedRuntimeBridge: { resolveRuntimeApproval }
    });

    try {
      const first = await app.inject({
        method: "POST",
        url: "/approvals/approval_runtime/reject",
        headers: {
          "idempotency-key": "runtime-mismatch-key"
        },
        payload: {
          message: "first payload",
          answers: { ticket: "A" }
        }
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: "POST",
        url: "/approvals/approval_runtime/reject",
        headers: {
          "idempotency-key": "runtime-mismatch-key"
        },
        payload: {
          message: "different payload",
          answers: { ticket: "B" }
        }
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe("adapter_protocol_failed");
      expect(second.json().error.details).toContainEqual({
        path: "reasonCode",
        issue: "hosted_runtime_bridge_payload_mismatch"
      });
    } finally {
      await app.close();
    }
  });

  it.each([
    ["agentfield.async_rest", "bridge_cmd_agentfield"],
    ["generic_http.async_rest", "bridge_cmd_generic_http"]
  ])("exposes and resolves %s runtime approvals through existing approval routes", async (runtimeMode, commandId) => {
    const app = Fastify();
    registerErrorEnvelope(app);
    attachHostedAuth(app);

    const approval = makeRuntimeApproval("approval_wrapper_runtime", runtimeMode);
    const getRun = vi.fn(async () => ({ id: "run_1", runtimeMode } as any));
    const resolveRuntimeApproval = vi.fn(async () => ({
      approval: { ...approval, status: "approved", resolvedAt: "2026-06-04T00:00:01.000Z" },
      commandId,
      duplicate: false
    }));

    registerHostedToolRoutes(app, {
      hostedTools: {
        invoke: async () => ({ statusCode: 202, invocation: makeInvocation("tool_1") }),
        resolveApproval: async () => ({ approval: makeApproval("approval_wrapper_runtime"), invocation: makeInvocation("tool_1") })
      },
      runs: { get: getRun },
      invocations: {
        get: async () => makeInvocation("tool_1"),
        list: async () => ({ invocations: [makeInvocation("tool_1")], nextCursor: null })
      },
      approvals: {
        get: async () => approval,
        list: async () => ({ approvals: [approval], nextCursor: null })
      },
      controlPlane: {
        authorizeResource: async () => ({ ok: true })
      } as any,
      controlPlaneStore: {
        listOwnedResourceIds: async () => ["approval_wrapper_runtime"]
      } as any,
      hostedRuntimeBridge: { resolveRuntimeApproval }
    });

    try {
      const list = await app.inject({ method: "GET", url: "/approvals" });
      expect(list.statusCode).toBe(200);
      expect(list.json().approvals.map((entry: Approval) => entry.id)).toEqual(["approval_wrapper_runtime"]);

      const get = await app.inject({ method: "GET", url: "/approvals/approval_wrapper_runtime" });
      expect(get.statusCode).toBe(200);
      expect(get.json().approval.payload.runtimeMode).toBe(runtimeMode);
      expect(getRun).not.toHaveBeenCalled();

      const approve = await app.inject({
        method: "POST",
        url: "/approvals/approval_wrapper_runtime/approve",
        headers: { "idempotency-key": `${runtimeMode}-approval-key` },
        payload: { message: "approved" }
      });
      expect(approve.statusCode).toBe(200);
      expect(approve.json().bridgeCommandId).toBe(commandId);
      expect(resolveRuntimeApproval).toHaveBeenCalledWith(expect.objectContaining({
        approvalId: "approval_wrapper_runtime",
        decision: "approved",
        idempotencyKey: `${runtimeMode}-approval-key`
      }));
    } finally {
      await app.close();
    }
  });

  it("denies runtime approval ownership before approval, run, or bridge probing", async () => {
    const app = Fastify();
    registerErrorEnvelope(app);
    attachHostedAuth(app);

    const getApproval = vi.fn(async () => makeRuntimeApproval("approval_hidden", "generic_http.async_rest"));
    const getRun = vi.fn(async () => ({ id: "run_1", runtimeMode: "generic_http.async_rest" } as any));
    const resolveRuntimeApproval = vi.fn(async () => ({
      approval: makeRuntimeApproval("approval_hidden", "generic_http.async_rest"),
      commandId: "bridge_cmd_hidden",
      duplicate: false
    }));
    const authorizeResource = vi.fn(async () => ({
      ok: false,
      code: "approval_not_found",
      reasonCode: "resource_not_owned"
    }));

    registerHostedToolRoutes(app, {
      hostedTools: {
        invoke: async () => ({ statusCode: 202, invocation: makeInvocation("tool_1") }),
        resolveApproval: async () => ({ approval: makeApproval("approval_hidden"), invocation: makeInvocation("tool_1") })
      },
      runs: { get: getRun },
      invocations: {
        get: async () => makeInvocation("tool_1"),
        list: async () => ({ invocations: [makeInvocation("tool_1")], nextCursor: null })
      },
      approvals: {
        get: getApproval,
        list: async () => ({ approvals: [], nextCursor: null })
      },
      controlPlane: { authorizeResource } as any,
      controlPlaneStore: {
        listOwnedResourceIds: async () => []
      } as any,
      hostedRuntimeBridge: { resolveRuntimeApproval }
    });

    try {
      const get = await app.inject({ method: "GET", url: "/approvals/approval_hidden" });
      expect(get.statusCode).toBe(404);
      expect(getApproval).not.toHaveBeenCalled();
      expect(getRun).not.toHaveBeenCalled();

      const approve = await app.inject({
        method: "POST",
        url: "/approvals/approval_hidden/approve",
        payload: { message: "do not leak" }
      });
      expect(approve.statusCode).toBe(404);
      expect(getApproval).not.toHaveBeenCalled();
      expect(getRun).not.toHaveBeenCalled();
      expect(resolveRuntimeApproval).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
