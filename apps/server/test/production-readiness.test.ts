import { describe, expect, it } from "vitest";
import { hashApiKey } from "@switchyard/core";
import { resolveHostedSandboxConfig } from "@switchyard/core";
import { resolveObjectStoreConfig } from "@switchyard/storage";
import { createServerApp } from "../src/app.js";
import { loadServerConfig } from "../src/config.js";
import { probeServerReadiness } from "../src/readiness.js";

const NOW = "2026-05-31T00:00:00.000Z";
const API_KEY_PEPPER = "prod_pepper_value_that_is_long_enough_123";
const ADMIN_RAW_KEY = "sk_sw_test_admin";
const METRICS_ONLY_RAW_KEY = "sk_sw_test_metrics";
const NODE_SHARED_TOKEN = "prod_node_token_that_is_long_enough_123";

function createBootstrapJson() {
  return JSON.stringify({
    accounts: [{ id: "account_1", name: "Acme", status: "active", billingPlanId: "billing_plan_1", createdAt: NOW }],
    tenants: [{ id: "tenant_1", accountId: "account_1", slug: "acme", displayName: "Acme", status: "active", createdAt: NOW }],
    projects: [{ id: "project_1", accountId: "account_1", tenantId: "tenant_1", slug: "project", displayName: "Project", status: "active", createdAt: NOW }],
    users: [{ id: "user_1", accountId: "account_1", tenantId: "tenant_1", displayName: "Owner", email: "owner@example.com", status: "active", createdAt: NOW }],
    apiKeys: [
      {
        id: "api_key_admin",
        accountId: "account_1",
        tenantId: "tenant_1",
        projectId: "project_1",
        userId: "user_1",
        name: "admin-key",
        keyPrefix: "sk_sw",
        secretHash: hashApiKey(ADMIN_RAW_KEY, API_KEY_PEPPER),
        scopes: ["runs:write", "runs:read", "metrics:read", "admin:read", "nodes:write", "registry:read", "artifacts:read"],
        status: "active",
        createdAt: NOW
      },
      {
        id: "api_key_metrics",
        accountId: "account_1",
        tenantId: "tenant_1",
        projectId: "project_1",
        userId: "user_1",
        name: "metrics-only-key",
        keyPrefix: "sk_sw",
        secretHash: hashApiKey(METRICS_ONLY_RAW_KEY, API_KEY_PEPPER),
        scopes: ["metrics:read"],
        status: "active",
        createdAt: NOW
      }
    ],
    billingPlans: [
      {
        id: "billing_plan_1",
        slug: "enterprise",
        displayName: "Enterprise",
        status: "active",
        entitlements: {
          allowedPlacements: ["hosted", "local", "connected_local_node"],
          allowedRuntimeModes: ["fake.deterministic"],
          allowHostedRealRuntime: false,
          allowConnectedNodes: true,
          allowArtifactContentRead: true,
          allowMetricsRead: true,
          allowAuditRead: true
        },
        quotas: {
          maxRunsPerHour: 100,
          maxActiveRuns: 50,
          maxRunTimeoutSeconds: 600,
          maxConnectedNodes: 5,
          maxArtifactContentReadBytesPerHour: 1024 * 1024
        },
        createdAt: NOW
      }
    ],
    nodeTokenBindings: [{ token: NODE_SHARED_TOKEN, apiKeyId: "api_key_admin" }]
  });
}

function createAuthEnabledTestEnv(overrides?: Record<string, string>) {
  return {
    SWITCHYARD_DEPLOYMENT_MODE: "test",
    SWITCHYARD_OBJECT_STORE_BACKEND: "local",
    SWITCHYARD_OBJECT_STORE_DIR: "/tmp/switchyard-store",
    SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic",
    SWITCHYARD_SERVER_AUTH_MODE: "api_key",
    SWITCHYARD_API_KEY_PEPPER: API_KEY_PEPPER,
    SWITCHYARD_CONTROL_PLANE_STORE: "memory",
    SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_JSON: createBootstrapJson(),
    SWITCHYARD_NODE_SHARED_TOKEN: NODE_SHARED_TOKEN,
    ...overrides
  };
}

describe("production readiness", () => {
  it("keeps /health cheap liveness while /ready can fail", async () => {
    const app = await createServerApp({
      host: "127.0.0.1",
      port: 0,
      deploymentMode: "test",
      hostedRuntimeAllowlist: [],
      hostedRealRuntimeExecution: "disabled",
      objectStore: resolveObjectStoreConfig({ deploymentMode: "test", env: {} }),
      sandbox: resolveHostedSandboxConfig({ deploymentMode: "test", env: {} }),
      redactedSummary: {}
    });

    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ ok: true });

      const ready = await app.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });

  it("adds schema check when production postgres compatibility is ready", async () => {
    const config = loadServerConfig(createAuthEnabledTestEnv());
    const report = await probeServerReadiness({
      config: {
        ...config,
        deploymentMode: "production"
      },
      postgres: {
        pool: { query: async () => ({ rows: [] }) },
        db: {} as never,
        real: true,
        close: async () => {}
      },
      queue: {
        enqueue: async () => "job",
        claim: async () => null,
        ack: async () => {},
        fail: async () => {},
        retry: async () => {},
        discard: async () => {},
        getJob: async () => null,
        recoverStaleClaims: async () => 0,
        stats: async () => ({ queued: 0, claimed: 0 })
      },
      artifactContent: {
        writeText: async () => ({ location: "x" }),
        writeBytes: async () => ({ location: "x" }),
        read: async () => ({ body: Buffer.from("ok"), contentType: "application/octet-stream" }),
        probe: async () => {}
      },
      checkSchemaCompatibility: async () => ({ ok: true, code: "postgres_schema_ready", version: 19 })
    });

    expect(report.checks.schema).toBeDefined();
    expect(report.checks.schema).toMatchObject({ ok: true, code: "postgres_schema_ready" });
    expect(report.checks.schema?.diagnostics).toMatchObject({ expectedVersion: 19, version: 19 });
  });

  it("reports migration-required schema readiness code", async () => {
    const config = loadServerConfig(createAuthEnabledTestEnv());
    const report = await probeServerReadiness({
      config: {
        ...config,
        deploymentMode: "staging"
      },
      postgres: {
        pool: { query: async () => ({ rows: [] }) },
        db: {} as never,
        real: true,
        close: async () => {}
      },
      queue: {
        enqueue: async () => "job",
        claim: async () => null,
        ack: async () => {},
        fail: async () => {},
        retry: async () => {},
        discard: async () => {},
        getJob: async () => null,
        recoverStaleClaims: async () => 0,
        stats: async () => ({ queued: 0, claimed: 0 })
      },
      artifactContent: {
        writeText: async () => ({ location: "x" }),
        writeBytes: async () => ({ location: "x" }),
        read: async () => ({ body: Buffer.from("ok"), contentType: "application/octet-stream" }),
        probe: async () => {}
      },
      checkSchemaCompatibility: async () => ({ ok: false, code: "postgres_schema_migration_required" })
    });

    expect(report.ok).toBe(false);
    expect(report.checks.schema).toMatchObject({ ok: false, code: "postgres_schema_migration_required" });
  });

  it("keeps metrics protected behind metrics:read plus admin:read", async () => {
    const config = loadServerConfig(createAuthEnabledTestEnv());
    const app = await createServerApp(config);
    try {
      const noAuth = await app.inject({ method: "GET", url: "/metrics" });
      expect([401, 403]).toContain(noAuth.statusCode);

      const metricsOnly = await app.inject({
        method: "GET",
        url: "/metrics",
        headers: {
          authorization: `Bearer ${METRICS_ONLY_RAW_KEY}`
        }
      });
      expect(metricsOnly.statusCode).toBe(403);

      const admin = await app.inject({
        method: "GET",
        url: "/metrics",
        headers: {
          authorization: `Bearer ${ADMIN_RAW_KEY}`
        }
      });
      expect(admin.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
