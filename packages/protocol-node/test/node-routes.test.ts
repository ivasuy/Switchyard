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
