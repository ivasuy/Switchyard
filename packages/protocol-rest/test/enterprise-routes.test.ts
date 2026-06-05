import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { AuthContext, AuditLogEvent } from "@switchyard/contracts";
import { registerEnterpriseRoutes, registerErrorEnvelope, registerHostedAuthHooks } from "../src/index.js";

const authContext: AuthContext = {
  account: {
    id: "account_1",
    name: "Acme",
    status: "active",
    billingPlanId: "billing_plan_1",
    createdAt: "2026-05-31T00:00:00.000Z"
  },
  tenant: {
    id: "tenant_1",
    accountId: "account_1",
    slug: "acme",
    displayName: "Acme",
    status: "active",
    createdAt: "2026-05-31T00:00:00.000Z"
  },
  project: {
    id: "project_1",
    accountId: "account_1",
    tenantId: "tenant_1",
    slug: "prod",
    displayName: "Prod",
    status: "active",
    createdAt: "2026-05-31T00:00:00.000Z"
  },
  user: {
    id: "user_1",
    accountId: "account_1",
    tenantId: "tenant_1",
    displayName: "Tester",
    email: "t@example.com",
    status: "active",
    createdAt: "2026-05-31T00:00:00.000Z"
  },
  apiKey: {
    id: "api_key_1",
    accountId: "account_1",
    tenantId: "tenant_1",
    projectId: "project_1",
    userId: "user_1",
    name: "primary",
    keyPrefix: "sk_sw",
    scopes: ["admin:read", "entitlements:read", "audit:read"],
    status: "active",
    createdAt: "2026-05-31T00:00:00.000Z"
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
      maxActiveRuns: 2,
      maxRunTimeoutSeconds: 600,
      maxConnectedNodes: 2,
      maxArtifactContentReadBytesPerHour: 1024
    },
    scopes: ["admin:read", "entitlements:read", "audit:read"],
    capturedAt: "2026-05-31T00:00:00.000Z"
  }
};

function createControlPlaneStub() {
  return {
    authenticateRequest: vi.fn(async () => authContext),
    requireScope: vi.fn(),
    whoami: vi.fn(() => ({ auth: authContext })),
    entitlementSnapshot: vi.fn(async () => ({ entitlement: authContext.entitlement })),
    listAuditEvents: vi.fn(async () => ({
      events: [
        {
          id: "audit_1",
          accountId: "account_1",
          tenantId: "tenant_1",
          projectId: "project_1",
          actorType: "api_key",
          actorUserId: "user_1",
          apiKeyId: "api_key_1",
          eventType: "run.create_allowed",
          decision: "allow",
          payload: { authorization: "[REDACTED]" },
          createdAt: "2026-05-31T00:00:00.000Z"
        }
      ] as AuditLogEvent[],
      nextCursor: "cursor_1"
    })),
    recordAudit: vi.fn(async () => ({ ok: true }))
  };
}

describe("enterprise routes", () => {
  it("serves whoami and hides secretHash", async () => {
    const controlPlane = createControlPlaneStub();
    const app = Fastify();
    registerErrorEnvelope(app);
    registerHostedAuthHooks(app, { controlPlane: controlPlane as never });
    registerEnterpriseRoutes(app, { controlPlane: controlPlane as never });

    const response = await app.inject({
      method: "GET",
      url: "/auth/whoami",
      headers: { authorization: "Bearer sk_sw_test_1" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().auth.apiKey.secretHash).toBeUndefined();
  });

  it("returns only tenant-scoped audit events", async () => {
    const controlPlane = createControlPlaneStub();
    const app = Fastify();
    registerErrorEnvelope(app);
    registerHostedAuthHooks(app, { controlPlane: controlPlane as never });
    registerEnterpriseRoutes(app, { controlPlane: controlPlane as never });

    const response = await app.inject({
      method: "GET",
      url: "/audit/events?limit=20",
      headers: { authorization: "Bearer sk_sw_test_1" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().events).toHaveLength(1);
    expect(response.json().events[0].tenantId).toBe("tenant_1");
  });

  it("appends audit-read allow events on successful audit list", async () => {
    const controlPlane = createControlPlaneStub();
    const app = Fastify();
    registerErrorEnvelope(app);
    registerHostedAuthHooks(app, { controlPlane: controlPlane as never });
    registerEnterpriseRoutes(app, { controlPlane: controlPlane as never });

    const response = await app.inject({
      method: "GET",
      url: "/audit/events?limit=5",
      headers: { authorization: "Bearer sk_sw_test_1" }
    });

    expect(response.statusCode).toBe(200);
    expect(controlPlane.recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "api_key.auth_succeeded",
      decision: "allow",
      reasonCode: "audit_read_allowed",
      resourceType: "audit_log_event"
    }));
    expect(JSON.stringify(controlPlane.recordAudit.mock.calls)).not.toContain("sk_sw_test_1");
  });

  it("appends audit-read deny events on malformed cursor", async () => {
    const controlPlane = createControlPlaneStub();
    const app = Fastify();
    registerErrorEnvelope(app);
    registerHostedAuthHooks(app, { controlPlane: controlPlane as never });
    registerEnterpriseRoutes(app, { controlPlane: controlPlane as never });

    const response = await app.inject({
      method: "GET",
      url: "/audit/events?cursor=   ",
      headers: { authorization: "Bearer sk_sw_test_1" }
    });

    expect(response.statusCode).toBe(400);
    expect(controlPlane.recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "api_key.auth_failed",
      decision: "deny",
      reasonCode: "audit_read_invalid_query",
      resourceType: "audit_log_event"
    }));
    expect(JSON.stringify(controlPlane.recordAudit.mock.calls)).not.toContain("sk_sw_test_1");
  });
});
