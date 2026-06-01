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

function createProviderPolicyJson(): string {
  return JSON.stringify({
    version: 1,
    modes: {
      "opencode.acp": {
        enabled: true,
        executablePath: "/bin/echo",
        cwdPrefixes: ["/tmp"],
        envAllowlist: ["PATH"],
        requiredEnv: [],
        allowUserArgs: false,
        fixedArgs: ["acp"],
        onePromptPerRun: true,
        spendControls: {
          maxActiveRuns: 2,
          maxRunsPerHour: 20,
          maxRunTimeoutSeconds: 300,
          maxPromptBytes: 60000
        }
      }
    }
  });
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
      providerRuntimeActivation: {
        valid: true,
        enabledRealModes: [],
        reasons: [],
        redactedSummary: {
          deploymentMode: "test",
          hostedRealRuntimeExecution: "disabled",
          realModeCount: 0,
          enabledRealModeCount: 0,
          source: { kind: "none" },
          modeStatuses: [],
          reasonCodes: []
        }
      },
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
    expect(report.checks.schema?.diagnostics).toMatchObject({ expectedVersion: 20, version: 19 });
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

  it("exposes redacted sandbox diagnostics in readiness without command policy details", async () => {
    const report = await probeServerReadiness({
      config: loadServerConfig(createAuthEnabledTestEnv()),
      postgres: undefined,
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
      }
    });

    expect(report.checks.sandbox).toMatchObject({
      ok: true,
      diagnostics: {
        enabled: true,
        mode: "disabled",
        policyCount: 0,
        ptyDriverConfigured: false
      }
    });
    const serialized = JSON.stringify(report.checks.sandbox.diagnostics ?? {});
    expect(serialized).not.toContain("executablePath");
    expect(serialized).not.toContain("cwd");
    expect(serialized).not.toContain("argv");
    expect(serialized).not.toContain("commandPolicy");
    expect(serialized).not.toContain("env");
  });

  it("includes tools readiness diagnostics with disabled defaults", async () => {
    const report = await probeServerReadiness({
      config: loadServerConfig(createAuthEnabledTestEnv()),
      postgres: undefined,
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
      }
    });

    expect(report.checks.tools).toBeDefined();
    expect(report.checks.tools?.ok).toBe(true);
    expect(report.checks.tools?.diagnostics).toMatchObject({
      hostedRealTools: "disabled",
      connectedNodeRealTools: "disabled"
    });
  });

  it("includes redacted provider runtime activation diagnostics", async () => {
    const report = await probeServerReadiness({
      config: loadServerConfig(
        createAuthEnabledTestEnv({
          SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic,opencode.acp",
          SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION: "enabled",
          SWITCHYARD_PROVIDER_RUNTIME_POLICY_JSON: createProviderPolicyJson()
        })
      ),
      postgres: undefined,
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
      }
    });

    expect(report.checks.providerRuntimeActivation).toMatchObject({
      ok: true,
      diagnostics: {
        source: "json",
        enabledRealModeCount: 1
      }
    });

    const serialized = JSON.stringify(report.checks.providerRuntimeActivation?.diagnostics ?? {});
    expect(serialized).not.toContain("/bin/echo");
    expect(serialized).not.toContain("cwdPrefixes");
    expect(serialized).not.toContain("OPENAI_API_KEY");
    expect(serialized).not.toContain("\"modes\"");
  });

  it("fails production readiness when provider activation is invalid", async () => {
    const config = loadServerConfig(createAuthEnabledTestEnv());
    const report = await probeServerReadiness({
      config: {
        ...config,
        deploymentMode: "production",
        hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
        hostedRealRuntimeExecution: "enabled",
        providerRuntimeActivation: {
          valid: false,
          enabledRealModes: [],
          reasons: [{ code: "provider_credentials_missing", runtimeMode: "codex.exec_json", detail: "env_missing" }],
          redactedSummary: {
            deploymentMode: "production",
            hostedRealRuntimeExecution: "enabled",
            realModeCount: 1,
            enabledRealModeCount: 0,
            source: { kind: "json" },
            policyVersion: 1,
            modeStatuses: [{ runtimeMode: "codex.exec_json", ready: false, reasons: ["provider_credentials_missing"] }],
            reasonCodes: ["provider_credentials_missing"]
          }
        }
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

    expect(report.ok).toBe(false);
    expect(report.checks.providerRuntimeActivation).toMatchObject({
      ok: false,
      code: "provider_credentials_missing"
    });
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
