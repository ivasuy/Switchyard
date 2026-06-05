import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { AuthContext, ResourceOwnership } from "@switchyard/contracts";
import { ControlPlaneError } from "@switchyard/core";
import { registerErrorEnvelope } from "@switchyard/protocol-rest";
import {
  NodeClient,
  NodeClientDecodeError,
  NodeClientHttpError,
  NodeClientNetworkError,
  registerNodeRoutes,
  type NodeRouteDependencies
} from "../src/index.js";

const NOW = "2026-05-31T00:00:00.000Z";

function createAuthContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    account: {
      id: "account_1",
      name: "Acme",
      status: "active",
      billingPlanId: "billing_plan_1",
      createdAt: NOW
    },
    tenant: {
      id: "tenant_1",
      accountId: "account_1",
      slug: "acme",
      displayName: "Acme",
      status: "active",
      createdAt: NOW
    },
    project: {
      id: "project_1",
      accountId: "account_1",
      tenantId: "tenant_1",
      slug: "prod",
      displayName: "Prod",
      status: "active",
      createdAt: NOW
    },
    user: {
      id: "user_1",
      accountId: "account_1",
      tenantId: "tenant_1",
      displayName: "Node Actor",
      status: "active",
      createdAt: NOW
    },
    apiKey: {
      id: "api_key_1",
      accountId: "account_1",
      tenantId: "tenant_1",
      projectId: "project_1",
      userId: "user_1",
      name: "node-key",
      keyPrefix: "sk_sw",
      scopes: ["nodes:write"],
      status: "active",
      createdAt: NOW
    },
    entitlement: {
      accountId: "account_1",
      tenantId: "tenant_1",
      projectId: "project_1",
      planId: "billing_plan_1",
      planSlug: "enterprise",
      planDisplayName: "Enterprise",
      entitlements: {
        allowedPlacements: ["local", "hosted", "connected_local_node"],
        allowedRuntimeModes: ["fake.deterministic"],
        allowHostedRealRuntime: false,
        allowConnectedNodes: true,
        allowArtifactContentRead: true,
        allowMetricsRead: true,
        allowAuditRead: true
      },
      quotas: {
        maxRunsPerHour: 10,
        maxActiveRuns: 3,
        maxRunTimeoutSeconds: 600,
        maxConnectedNodes: 2,
        maxArtifactContentReadBytesPerHour: 5_000_000
      },
      scopes: ["nodes:write"],
      capturedAt: NOW
    },
    ...overrides
  };
}

function createOwnership(overrides: Partial<ResourceOwnership> = {}): ResourceOwnership {
  return {
    resourceType: "node",
    resourceId: "node_1",
    accountId: "account_1",
    tenantId: "tenant_1",
    projectId: "project_1",
    userId: "user_1",
    apiKeyId: "api_key_1",
    createdAt: NOW,
    ...overrides
  };
}

function createCoordinatorStub() {
  return {
    register: vi.fn(async () => ({ id: "node_1", mode: "hybrid", status: "online", capabilities: [], createdAt: NOW })),
    heartbeat: vi.fn(async () => ({ id: "node_1", mode: "hybrid", status: "online", capabilities: [], createdAt: NOW })),
    list: vi.fn(async () => []),
    get: vi.fn(async () => undefined),
    claim: vi.fn(async () => null),
    reject: vi.fn(async () => ({
      id: "assignment_1",
      runId: "run_1",
      nodeId: "node_1",
      status: "failed",
      retryCount: 0,
      lastEventSequence: 0,
      createdAt: NOW
    })),
    complete: vi.fn(async () => ({
      id: "assignment_1",
      runId: "run_1",
      nodeId: "node_1",
      status: "completed",
      retryCount: 0,
      lastEventSequence: 0,
      createdAt: NOW
    })),
    markOffline: vi.fn(async () => ({})),
    expireStale: vi.fn(async () => {})
  };
}

function createEventSyncStub() {
  return {
    appendBatch: vi.fn(async () => ({ accepted: true, appended: 0, nextCursor: 0 }))
  };
}

function createArtifactSyncStub() {
  return {
    acceptManifest: vi.fn(async () => ({ accepted: true, artifacts: [] })),
    acceptContent: vi.fn(async () => ({ accepted: true, artifactId: "artifact_1" }))
  };
}

function createControlPlaneStub(auth = createAuthContext()) {
  return {
    authenticateRequest: vi.fn(async () => auth),
    requireScope: vi.fn(),
    preflightNodeRegister: vi.fn(async () => ({
      id: "quota_reservation_1",
      accountId: auth.account.id,
      tenantId: auth.tenant.id,
      projectId: auth.project.id,
      quotaKind: "connected_nodes",
      amount: 1,
      state: "reserved",
      reasonCode: "node_register",
      createdAt: NOW,
      expiresAt: "2026-05-31T00:05:00.000Z"
    })),
    releaseQuotaReservation: vi.fn(async () => ({
      id: "quota_reservation_1",
      accountId: auth.account.id,
      tenantId: auth.tenant.id,
      projectId: auth.project.id,
      quotaKind: "connected_nodes",
      amount: 1,
      state: "consumed",
      reasonCode: "node_register",
      createdAt: NOW,
      expiresAt: "2026-05-31T00:05:00.000Z",
      finalizedAt: NOW
    })),
    authorizeResource: vi.fn(async () => ({ ok: true, ownership: createOwnership() })),
    ensureOwnedOrAttachFromRun: vi.fn(async () => ({ ok: true, ownership: createOwnership(), created: true })),
    recordAudit: vi.fn(async () => ({ ok: true }))
  };
}

async function buildNodeApp(overrides: Partial<NodeRouteDependencies> = {}) {
  const app = Fastify();
  registerErrorEnvelope(app);

  let preParsingCalls = 0;
  app.addHook("preParsing", async (request, _reply, payload) => {
    if (request.url.startsWith("/nodes")) {
      preParsingCalls += 1;
    }
    return payload;
  });

  const coordinator = createCoordinatorStub();
  const eventSync = createEventSyncStub();
  const artifactSync = createArtifactSyncStub();
  const deps: NodeRouteDependencies = {
    coordinator: coordinator as never,
    eventSync: eventSync as never,
    artifactSync: artifactSync as never,
    requireAuth: true,
    jsonBodyLimitBytes: 64,
    artifactBodyLimitBytes: 8,
    ...overrides
  };

  registerNodeRoutes(app, deps);
  return { app, coordinator, eventSync, artifactSync, getPreParsingCalls: () => preParsingCalls };
}

describe("node routes", () => {
  it("preserves legacy shared-token behavior without controlPlane", async () => {
    const { app, coordinator } = await buildNodeApp({
      sharedToken: "token",
      requireAuth: true,
      controlPlane: undefined,
      deploymentMode: "local"
    });

    const denied = await app.inject({
      method: "POST",
      url: "/nodes/register",
      payload: { capabilities: [] }
    });
    expect(denied.statusCode).toBe(401);
    expect(denied.json().error.code).toBe("node_auth_failed");

    const accepted = await app.inject({
      method: "POST",
      url: "/nodes/register",
      headers: { "x-switchyard-node-token": "token" },
      payload: { capabilities: [] }
    });

    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().node.id).toBe("node_1");
    expect(coordinator.register).toHaveBeenCalledTimes(1);
  });

  it("denies missing hosted auth before parsing and coordinator side effects", async () => {
    const controlPlane = createControlPlaneStub();
    const { app, coordinator, getPreParsingCalls } = await buildNodeApp({
      controlPlane: controlPlane as never,
      deploymentMode: "staging"
    });

    const response = await app.inject({
      method: "POST",
      url: "/nodes/register",
      payload: { capabilities: ["x".repeat(10_000)] }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("auth_required");
    expect(getPreParsingCalls()).toBe(0);
    expect(coordinator.register).not.toHaveBeenCalled();
  });

  it("denies malformed bearer auth before parsing", async () => {
    const controlPlane = createControlPlaneStub();
    controlPlane.authenticateRequest.mockRejectedValue(
      new ControlPlaneError("auth_failed", "malformed_authorization")
    );
    const { app, coordinator, getPreParsingCalls } = await buildNodeApp({
      controlPlane: controlPlane as never,
      deploymentMode: "staging"
    });

    const response = await app.inject({
      method: "POST",
      url: "/nodes/register",
      headers: { authorization: "Bearer Bearer sk_sw_test_alpha" },
      payload: { capabilities: [] }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("auth_failed");
    expect(getPreParsingCalls()).toBe(0);
    expect(coordinator.register).not.toHaveBeenCalled();
  });

  it("denies query credentials and redacts token from response and audit", async () => {
    const controlPlane = createControlPlaneStub();
    const { app } = await buildNodeApp({
      controlPlane: controlPlane as never,
      deploymentMode: "staging",
      nodeTokenBindings: [
        {
          token: "bound-token",
          auth: createAuthContext()
        }
      ]
    });

    const response = await app.inject({
      method: "POST",
      url: "/nodes/register?token=secret-node-token",
      payload: { capabilities: [] }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("auth_failed");
    expect(JSON.stringify(response.json())).not.toContain("secret-node-token");
    expect(JSON.stringify(controlPlane.recordAudit.mock.calls)).not.toContain("secret-node-token");
  });

  it("rejects secret-like node policy values at registration", async () => {
    const controlPlane = createControlPlaneStub();
    const { app, coordinator } = await buildNodeApp({
      controlPlane: controlPlane as never,
      deploymentMode: "staging",
      jsonBodyLimitBytes: 4096
    });

    const response = await app.inject({
      method: "POST",
      url: "/nodes/register",
      headers: { authorization: "Bearer sk_sw_test_alpha" },
      payload: {
        capabilities: ["tool.github"],
        policy: {
          allowRuntimeModes: ["fake.deterministic"],
          denyAdapterTypes: [],
          allowCwdPrefixes: ["/repo"],
          allowEventTypes: [],
          artifactSync: "full",
          allowToolTypes: ["github"],
          allowToolCwdPrefixes: ["/repo?token=abc123"],
          toolArtifactSync: "full",
          toolApprovalRequired: true
        }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_input");
    expect(coordinator.register).not.toHaveBeenCalled();
  });

  it("maps auth store failures to 503 before coordinator calls", async () => {
    const controlPlane = createControlPlaneStub();
    controlPlane.authenticateRequest.mockRejectedValue(
      new ControlPlaneError("auth_store_unavailable", "auth_store_unavailable")
    );
    const { app, coordinator } = await buildNodeApp({
      controlPlane: controlPlane as never,
      deploymentMode: "staging"
    });

    const response = await app.inject({
      method: "POST",
      url: "/nodes/register",
      headers: { authorization: "Bearer sk_sw_test_alpha" },
      payload: { capabilities: [] }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("auth_store_unavailable");
    expect(coordinator.register).not.toHaveBeenCalled();
  });

  it("denies unbound shared token in hosted control-plane mode", async () => {
    const controlPlane = createControlPlaneStub();
    const { app, coordinator } = await buildNodeApp({
      controlPlane: controlPlane as never,
      deploymentMode: "staging",
      sharedToken: "token",
      nodeTokenBindings: []
    });

    const response = await app.inject({
      method: "POST",
      url: "/nodes/register",
      headers: { "x-switchyard-node-token": "token" },
      payload: { capabilities: [] }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("node_auth_failed");
    expect(coordinator.register).not.toHaveBeenCalled();
  });

  it("allows hosted node registration with bound node token", async () => {
    const controlPlane = createControlPlaneStub();
    const boundAuth = createAuthContext();
    const { app, coordinator } = await buildNodeApp({
      controlPlane: controlPlane as never,
      deploymentMode: "staging",
      nodeTokenBindings: [{ token: "bound-token", auth: boundAuth }]
    });

    const response = await app.inject({
      method: "POST",
      url: "/nodes/register",
      headers: { "x-switchyard-node-token": "bound-token" },
      payload: { capabilities: [] }
    });

    expect(response.statusCode).toBe(201);
    expect(coordinator.register).toHaveBeenCalledTimes(1);
    expect(controlPlane.authenticateRequest).not.toHaveBeenCalled();
    expect(controlPlane.preflightNodeRegister).toHaveBeenCalledWith(expect.objectContaining({
      auth: boundAuth
    }));
  });

  it("denies hosted auth when nodes:write scope is missing", async () => {
    const controlPlane = createControlPlaneStub();
    controlPlane.requireScope.mockImplementation(() => {
      throw new ControlPlaneError("tenant_access_denied", "missing_scope");
    });
    const { app, coordinator } = await buildNodeApp({
      controlPlane: controlPlane as never,
      deploymentMode: "staging"
    });

    const response = await app.inject({
      method: "POST",
      url: "/nodes/register",
      headers: { authorization: "Bearer sk_sw_test_alpha" },
      payload: { capabilities: [] }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("tenant_access_denied");
    expect(coordinator.register).not.toHaveBeenCalled();
    expect(controlPlane.recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "tenant.access_denied",
      reasonCode: "missing_scope"
    }));
  });

  it("denies hosted auth for inactive tenant context", async () => {
    const controlPlane = createControlPlaneStub();
    controlPlane.authenticateRequest.mockRejectedValue(new ControlPlaneError("auth_failed", "tenant_inactive"));
    const { app, coordinator } = await buildNodeApp({
      controlPlane: controlPlane as never,
      deploymentMode: "staging"
    });

    const response = await app.inject({
      method: "POST",
      url: "/nodes/register",
      headers: { authorization: "Bearer sk_sw_test_alpha" },
      payload: { capabilities: [] }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("auth_failed");
    expect(coordinator.register).not.toHaveBeenCalled();
    expect(controlPlane.recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "node.auth_failed",
      reasonCode: "tenant_inactive"
    }));
  });

  it("allows api key registration and consumes connected-node reservation", async () => {
    const controlPlane = createControlPlaneStub();
    const { app, coordinator } = await buildNodeApp({
      controlPlane: controlPlane as never,
      deploymentMode: "staging"
    });

    const response = await app.inject({
      method: "POST",
      url: "/nodes/register",
      headers: { authorization: "Bearer sk_sw_test_alpha" },
      payload: { capabilities: [] }
    });

    expect(response.statusCode).toBe(201);
    expect(coordinator.register).toHaveBeenCalledTimes(1);
    expect(controlPlane.preflightNodeRegister).toHaveBeenCalledTimes(1);
    expect(controlPlane.ensureOwnedOrAttachFromRun).toHaveBeenCalledWith(expect.objectContaining({
      resourceType: "node",
      resourceId: "node_1"
    }));
    expect(controlPlane.releaseQuotaReservation).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "consumed"
    }));
    expect(controlPlane.recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "node.register_allowed",
      decision: "allow"
    }));
  });

  it("denies connected-node quota before registration side effects", async () => {
    const controlPlane = createControlPlaneStub();
    controlPlane.preflightNodeRegister.mockRejectedValue(
      new ControlPlaneError("quota_exceeded", "connected_nodes_exceeded")
    );
    const { app, coordinator } = await buildNodeApp({
      controlPlane: controlPlane as never,
      deploymentMode: "staging"
    });

    const response = await app.inject({
      method: "POST",
      url: "/nodes/register",
      headers: { authorization: "Bearer sk_sw_test_alpha" },
      payload: { capabilities: [] }
    });

    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe("quota_exceeded");
    expect(coordinator.register).not.toHaveBeenCalled();
    expect(controlPlane.recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "node.register_denied",
      decision: "deny",
      reasonCode: "connected_nodes_exceeded"
    }));
  });

  it("rolls back registration on ownership attach failure and marks node offline", async () => {
    const controlPlane = createControlPlaneStub();
    controlPlane.ensureOwnedOrAttachFromRun.mockResolvedValue({
      ok: false,
      reasonCode: "ownership_attach_failed",
      code: "ownership_attach_failed"
    });
    const { app, coordinator } = await buildNodeApp({
      controlPlane: controlPlane as never,
      deploymentMode: "staging"
    });

    const response = await app.inject({
      method: "POST",
      url: "/nodes/register",
      headers: { authorization: "Bearer sk_sw_test_alpha" },
      payload: { capabilities: [] }
    });

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("internal_error");
    expect(coordinator.markOffline).toHaveBeenCalledWith("node_1");
    expect(controlPlane.releaseQuotaReservation).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failed",
      reasonCode: "ownership_attach_failed"
    }));
  });

  it("scopes node list by durable ownership", async () => {
    const controlPlane = createControlPlaneStub();
    const { app, coordinator } = await buildNodeApp({
      controlPlane: controlPlane as never,
      deploymentMode: "staging"
    });

    coordinator.list.mockResolvedValueOnce([
      { id: "node_1", mode: "hybrid", status: "online", capabilities: [], createdAt: NOW },
      { id: "node_2", mode: "hybrid", status: "online", capabilities: [], createdAt: NOW }
    ]);
    controlPlane.authorizeResource.mockImplementation(async (input: { resourceId: string }) => {
      if (input.resourceId === "node_1") {
        return { ok: true, ownership: createOwnership({ resourceId: "node_1" }) };
      }
      return {
        ok: false,
        decision: "denied",
        code: "tenant_access_denied",
        reasonCode: "tenant_mismatch"
      };
    });

    const response = await app.inject({
      method: "GET",
      url: "/nodes",
      headers: { authorization: "Bearer sk_sw_test_alpha" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().nodes.map((node: { id: string }) => node.id)).toEqual(["node_1"]);
  });

  it("denies cross-tenant assignment claim before coordinator side effects", async () => {
    const controlPlane = createControlPlaneStub();
    const { app, coordinator } = await buildNodeApp({
      controlPlane: controlPlane as never,
      deploymentMode: "staging"
    });

    controlPlane.authorizeResource.mockImplementation(async (input: { resourceType: string }) => {
      if (input.resourceType === "node") {
        return { ok: true, ownership: createOwnership({ resourceType: "node", resourceId: "node_1" }) };
      }
      return {
        ok: false,
        decision: "denied",
        code: "tenant_access_denied",
        reasonCode: "tenant_mismatch"
      };
    });

    const response = await app.inject({
      method: "POST",
      url: "/nodes/node_1/assignments/claim",
      headers: { authorization: "Bearer sk_sw_test_alpha" },
      payload: { assignmentId: "assignment_2" }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("tenant_access_denied");
    expect(coordinator.claim).not.toHaveBeenCalled();
  });

  it("denies auto-claim exposure for out-of-scope claimed assignment and rolls back claim", async () => {
    const controlPlane = createControlPlaneStub();
    const { app, coordinator } = await buildNodeApp({
      controlPlane: controlPlane as never,
      deploymentMode: "staging"
    });
    coordinator.claim.mockResolvedValueOnce({
      assignment: {
        id: "assignment_3",
        runId: "run_3",
        nodeId: "node_1",
        status: "claimed",
        retryCount: 0,
        lastEventSequence: 0,
        createdAt: NOW
      },
      run: {
        id: "run_3",
        runtime: "fake",
        provider: "test",
        model: "test-model",
        adapterType: "process",
        cwd: "/repo",
        task: "x",
        status: "running",
        placement: "connected_local_node",
        approvalPolicy: "default",
        timeoutSeconds: 60,
        metadata: {},
        runtimeMode: "fake.deterministic",
        createdAt: NOW
      }
    });
    controlPlane.authorizeResource.mockImplementation(async (input: { resourceType: string; resourceId: string }) => {
      if (input.resourceType === "node") {
        return { ok: true, ownership: createOwnership({ resourceType: "node", resourceId: "node_1" }) };
      }
      if (input.resourceType === "assignment" && input.resourceId === "assignment_3") {
        return {
          ok: false,
          decision: "denied",
          code: "tenant_access_denied",
          reasonCode: "tenant_mismatch"
        };
      }
      return { ok: true, ownership: createOwnership({ resourceType: "run", resourceId: "run_3" }) };
    });

    const response = await app.inject({
      method: "POST",
      url: "/nodes/node_1/assignments/claim",
      headers: { authorization: "Bearer sk_sw_test_alpha" },
      payload: {}
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("tenant_access_denied");
    expect(coordinator.reject).toHaveBeenCalledWith("node_1", "assignment_3", "tenant_access_denied");
  });

  it("returns tool invocation payload for claimed tool assignment", async () => {
    const controlPlane = createControlPlaneStub();
    const resolveToolInvocation = vi.fn(async () => ({
      id: "tool_1",
      runId: "run_3",
      type: "repo",
      status: "queued",
      input: {
        request: { operation: "status", cwd: "/repo" },
        executionPlanHash: "hash_1",
        executionPlan: {
          type: "repo",
          gitBinary: "/tmp/attacker-git",
          argv: ["push", "origin", "main"],
          cwd: "/tmp/attacker-cwd",
          env: { GITHUB_TOKEN: "secret" }
        }
      },
      createdAt: NOW
    }));
    const { app, coordinator } = await buildNodeApp({
      controlPlane: controlPlane as never,
      deploymentMode: "staging",
      resolveToolInvocation: resolveToolInvocation as never
    });
    coordinator.claim.mockResolvedValueOnce({
      assignment: {
        id: "assignment_tool_1",
        runId: "run_3",
        nodeId: "node_1",
        kind: "tool",
        toolInvocationId: "tool_1",
        status: "claimed",
        retryCount: 0,
        lastEventSequence: 0,
        createdAt: NOW
      },
      run: {
        id: "run_3",
        runtime: "fake",
        provider: "test",
        model: "test-model",
        adapterType: "process",
        cwd: "/repo",
        task: "x",
        status: "running",
        placement: "connected_local_node",
        approvalPolicy: "default",
        timeoutSeconds: 60,
        metadata: {},
        runtimeMode: "fake.deterministic",
        createdAt: NOW
      }
    });
    controlPlane.authorizeResource.mockImplementation(async (input: { resourceType: string; resourceId: string }) => {
      if (input.resourceType === "node") {
        return { ok: true, ownership: createOwnership({ resourceType: "node", resourceId: "node_1" }) };
      }
      if (input.resourceType === "assignment") {
        return { ok: true, ownership: createOwnership({ resourceType: "assignment", resourceId: input.resourceId }) };
      }
      if (input.resourceType === "run") {
        return { ok: true, ownership: createOwnership({ resourceType: "run", resourceId: input.resourceId }) };
      }
      if (input.resourceType === "tool_invocation") {
        return { ok: true, ownership: createOwnership({ resourceType: "tool_invocation", resourceId: input.resourceId }) };
      }
      return { ok: true, ownership: createOwnership({ resourceType: "node", resourceId: input.resourceId }) };
    });

    const response = await app.inject({
      method: "POST",
      url: "/nodes/node_1/assignments/claim",
      headers: { authorization: "Bearer sk_sw_test_alpha" },
      payload: {}
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().assignment.kind).toBe("tool");
    expect(response.json().toolInvocation?.id).toBe("tool_1");
    expect(response.json().toolInvocation?.input?.executionPlanHash).toBe("hash_1");
    expect(response.json().toolInvocation?.input?.executionPlan).toBeUndefined();
    expect(resolveToolInvocation).toHaveBeenCalledWith({
      nodeId: "node_1",
      assignmentId: "assignment_tool_1",
      runId: "run_3",
      toolInvocationId: "tool_1"
    });
  });

  it("denies heartbeat when node ownership is out-of-scope", async () => {
    const controlPlane = createControlPlaneStub();
    const { app, coordinator } = await buildNodeApp({
      controlPlane: controlPlane as never,
      deploymentMode: "staging"
    });
    controlPlane.authorizeResource.mockResolvedValue({
      ok: false,
      decision: "denied",
      code: "tenant_access_denied",
      reasonCode: "tenant_mismatch"
    });

    const response = await app.inject({
      method: "POST",
      url: "/nodes/node_1/heartbeat",
      headers: { authorization: "Bearer sk_sw_test_alpha" },
      payload: { capabilities: [] }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("tenant_access_denied");
    expect(coordinator.heartbeat).not.toHaveBeenCalled();
  });

  it("denies GET /nodes/:id when node ownership is out-of-scope", async () => {
    const controlPlane = createControlPlaneStub();
    const { app, coordinator } = await buildNodeApp({
      controlPlane: controlPlane as never,
      deploymentMode: "staging"
    });
    controlPlane.authorizeResource.mockResolvedValue({
      ok: false,
      decision: "denied",
      code: "tenant_access_denied",
      reasonCode: "tenant_mismatch"
    });

    const response = await app.inject({
      method: "GET",
      url: "/nodes/node_1",
      headers: { authorization: "Bearer sk_sw_test_alpha" }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("tenant_access_denied");
    expect(coordinator.get).not.toHaveBeenCalled();
  });

  it("denies cross-tenant reject before coordinator side effects", async () => {
    const controlPlane = createControlPlaneStub();
    const { app, coordinator } = await buildNodeApp({
      controlPlane: controlPlane as never,
      deploymentMode: "staging"
    });
    controlPlane.authorizeResource.mockImplementation(async (input: { resourceType: string }) => {
      if (input.resourceType === "node") return { ok: true, ownership: createOwnership() };
      return {
        ok: false,
        decision: "denied",
        code: "tenant_access_denied",
        reasonCode: "tenant_mismatch"
      };
    });

    const response = await app.inject({
      method: "POST",
      url: "/nodes/node_1/assignments/assignment_1/reject",
      headers: { authorization: "Bearer sk_sw_test_alpha" },
      payload: { reason: "nope" }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("tenant_access_denied");
    expect(coordinator.reject).not.toHaveBeenCalled();
  });

  it("denies cross-tenant event sync before service side effects", async () => {
    const controlPlane = createControlPlaneStub();
    const { app, eventSync } = await buildNodeApp({
      controlPlane: controlPlane as never,
      deploymentMode: "staging"
    });
    controlPlane.authorizeResource.mockImplementation(async (input: { resourceType: string }) => {
      if (input.resourceType === "node") return { ok: true, ownership: createOwnership() };
      return {
        ok: false,
        decision: "denied",
        code: "tenant_access_denied",
        reasonCode: "tenant_mismatch"
      };
    });

    const response = await app.inject({
      method: "POST",
      url: "/nodes/node_1/assignments/assignment_1/events",
      headers: { authorization: "Bearer sk_sw_test_alpha" },
      payload: { events: [] }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("tenant_access_denied");
    expect(eventSync.appendBatch).not.toHaveBeenCalled();
  });

  it("denies cross-tenant artifact manifest sync before service side effects", async () => {
    const controlPlane = createControlPlaneStub();
    const { app, artifactSync } = await buildNodeApp({
      controlPlane: controlPlane as never,
      deploymentMode: "staging"
    });
    controlPlane.authorizeResource.mockImplementation(async (input: { resourceType: string }) => {
      if (input.resourceType === "node") return { ok: true, ownership: createOwnership() };
      return {
        ok: false,
        decision: "denied",
        code: "tenant_access_denied",
        reasonCode: "tenant_mismatch"
      };
    });

    const response = await app.inject({
      method: "POST",
      url: "/nodes/node_1/assignments/assignment_1/artifacts/manifest",
      headers: { authorization: "Bearer sk_sw_test_alpha" },
      payload: { artifacts: [] }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("tenant_access_denied");
    expect(artifactSync.acceptManifest).not.toHaveBeenCalled();
  });

  it("denies cross-tenant artifact content sync before service side effects", async () => {
    const controlPlane = createControlPlaneStub();
    const { app, artifactSync } = await buildNodeApp({
      controlPlane: controlPlane as never,
      deploymentMode: "staging"
    });
    controlPlane.authorizeResource.mockImplementation(async (input: { resourceType: string }) => {
      if (input.resourceType === "node") return { ok: true, ownership: createOwnership() };
      return {
        ok: false,
        decision: "denied",
        code: "tenant_access_denied",
        reasonCode: "tenant_mismatch"
      };
    });

    const response = await app.inject({
      method: "PUT",
      url: "/nodes/node_1/assignments/assignment_1/artifacts/artifact_1/content",
      headers: { authorization: "Bearer sk_sw_test_alpha" },
      payload: {}
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("tenant_access_denied");
    expect(artifactSync.acceptContent).not.toHaveBeenCalled();
  });

  it("denies cross-tenant complete before coordinator side effects", async () => {
    const controlPlane = createControlPlaneStub();
    const { app, coordinator } = await buildNodeApp({
      controlPlane: controlPlane as never,
      deploymentMode: "staging"
    });
    controlPlane.authorizeResource.mockImplementation(async (input: { resourceType: string }) => {
      if (input.resourceType === "node") return { ok: true, ownership: createOwnership() };
      return {
        ok: false,
        decision: "denied",
        code: "tenant_access_denied",
        reasonCode: "tenant_mismatch"
      };
    });

    const response = await app.inject({
      method: "POST",
      url: "/nodes/node_1/assignments/assignment_1/complete",
      headers: { authorization: "Bearer sk_sw_test_alpha" },
      payload: { status: "completed" }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("tenant_access_denied");
    expect(coordinator.complete).not.toHaveBeenCalled();
  });

  it("rejects mismatched tool completion patch before assignment complete", async () => {
    const controlPlane = createControlPlaneStub();
    const completeToolAssignment = vi.fn(async () => {
      throw { code: "tool_assignment_mismatch" };
    });
    const { app, coordinator } = await buildNodeApp({
      controlPlane: controlPlane as never,
      deploymentMode: "staging",
      completeToolAssignment: completeToolAssignment as never,
      jsonBodyLimitBytes: 4096
    });
    controlPlane.authorizeResource.mockResolvedValue({ ok: true, ownership: createOwnership() });

    const response = await app.inject({
      method: "POST",
      url: "/nodes/node_1/assignments/assignment_1/complete",
      headers: { authorization: "Bearer sk_sw_test_alpha" },
      payload: {
        status: "failed",
        toolInvocation: {
          id: "tool_2",
          status: "failed",
          error: { code: "tool_execution_failed", message: "bad" }
        }
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("tool_assignment_mismatch");
    expect(completeToolAssignment).toHaveBeenCalledTimes(1);
    expect(coordinator.complete).not.toHaveBeenCalled();
  });

  it("rejects large unauthenticated artifact content before parsing and sync side effects", async () => {
    const controlPlane = createControlPlaneStub();
    const { app, artifactSync, getPreParsingCalls } = await buildNodeApp({
      controlPlane: controlPlane as never,
      deploymentMode: "staging",
      artifactBodyLimitBytes: 8
    });

    const body = Buffer.from("x".repeat(128));
    const response = await app.inject({
      method: "PUT",
      url: "/nodes/node_1/assignments/assignment_1/artifacts/artifact_1/content",
      headers: { "content-length": String(body.byteLength) },
      payload: body
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("auth_required");
    expect(getPreParsingCalls()).toBe(0);
    expect(artifactSync.acceptContent).not.toHaveBeenCalled();
  });

  it("audits invalid API key failures even without resolved tenant binding", async () => {
    const controlPlane = createControlPlaneStub();
    controlPlane.authenticateRequest.mockRejectedValue(new ControlPlaneError("auth_failed", "invalid_api_key"));
    const { app } = await buildNodeApp({
      controlPlane: controlPlane as never,
      deploymentMode: "staging"
    });

    const response = await app.inject({
      method: "POST",
      url: "/nodes/register",
      headers: { authorization: "Bearer sk_sw_raw_secret_key" },
      payload: { capabilities: [] }
    });

    expect(response.statusCode).toBe(401);
    expect(controlPlane.recordAudit).toHaveBeenCalled();
    expect(JSON.stringify(controlPlane.recordAudit.mock.calls)).not.toContain("sk_sw_raw_secret_key");
  });

  it("audits blank and unbound node tokens in multi-binding setup", async () => {
    const controlPlane = createControlPlaneStub();
    const bindings = [
      { token: "token-1", auth: createAuthContext() },
      { token: "token-2", auth: createAuthContext({ project: { ...createAuthContext().project, id: "project_2" } }) }
    ];
    const { app } = await buildNodeApp({
      controlPlane: controlPlane as never,
      deploymentMode: "staging",
      nodeTokenBindings: bindings
    });

    const blank = await app.inject({
      method: "POST",
      url: "/nodes/register",
      headers: { "x-switchyard-node-token": "   " },
      payload: { capabilities: [] }
    });
    expect(blank.statusCode).toBe(401);

    const unbound = await app.inject({
      method: "POST",
      url: "/nodes/register",
      headers: { "x-switchyard-node-token": "secret-node-token" },
      payload: { capabilities: [] }
    });
    expect(unbound.statusCode).toBe(401);
    expect(controlPlane.recordAudit).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(controlPlane.recordAudit.mock.calls)).not.toContain("secret-node-token");
  });

  it("audits query-credential denials in hosted mode and tolerates audit append failures", async () => {
    const controlPlane = createControlPlaneStub();
    controlPlane.recordAudit.mockRejectedValue(new Error("audit_down"));
    const { app } = await buildNodeApp({
      controlPlane: controlPlane as never,
      deploymentMode: "staging",
      nodeTokenBindings: [
        { token: "token-1", auth: createAuthContext() },
        { token: "token-2", auth: createAuthContext({ tenant: { ...createAuthContext().tenant, id: "tenant_2" } }) }
      ]
    });

    const response = await app.inject({
      method: "POST",
      url: "/nodes/register?token=leaky-token",
      payload: { capabilities: [] }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("auth_failed");
    expect(JSON.stringify(response.json())).not.toContain("leaky-token");
  });
});

describe("node client errors", () => {
  it("throws typed http errors", async () => {
    const client = new NodeClient({
      baseUrl: "http://example.test",
      fetchImpl: async () => new Response(JSON.stringify({
        error: { code: "node_auth_failed", message: "bad token", requestId: "req_1" }
      }), { status: 401 })
    });
    await expect(client.register({ capabilities: [] })).rejects.toBeInstanceOf(NodeClientHttpError);
  });

  it("throws decode errors for malformed JSON", async () => {
    const client = new NodeClient({
      baseUrl: "http://example.test",
      fetchImpl: async () => new Response("not-json", { status: 200 })
    });
    await expect(client.register({ capabilities: [] })).rejects.toBeInstanceOf(NodeClientDecodeError);
  });

  it("throws network errors", async () => {
    const client = new NodeClient({
      baseUrl: "http://example.test",
      fetchImpl: async () => {
        throw new Error("dial failure");
      }
    });
    await expect(client.register({ capabilities: [] })).rejects.toBeInstanceOf(NodeClientNetworkError);
  });
});
