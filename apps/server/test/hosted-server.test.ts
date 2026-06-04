import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { ControlPlaneService, hashApiKey } from "@switchyard/core";
import { resolveHostedSandboxConfig } from "@switchyard/core";
import { PostgresControlPlaneStore, resolveObjectStoreConfig } from "@switchyard/storage";
import { createServerApp } from "../src/app.js";
import { loadServerConfig } from "../src/config.js";
import { probeServerReadiness } from "../src/readiness.js";

const defaultSandbox = () => resolveHostedSandboxConfig({ deploymentMode: "test", env: {} });
const NOW = "2026-05-31T00:00:00.000Z";
const API_KEY_PEPPER = "pepper_super_secret";
const ADMIN_RAW_KEY = "sk_sw_test_admin";
const METRICS_ONLY_RAW_KEY = "sk_sw_test_metrics";
const OTHER_RAW_KEY = "sk_sw_test_other";
const NODE_SHARED_TOKEN = "bound-node-token";

function createBootstrapJson(options?: {
  includeBindings?: boolean;
  includeRawKey?: boolean;
  deactivatePlan?: boolean;
  deactivateRecords?: boolean;
  duplicateApiKeyId?: boolean;
}) {
  const includeBindings = options?.includeBindings ?? true;
  const includeRawKey = options?.includeRawKey ?? false;
  const deactivatePlan = options?.deactivatePlan ?? false;
  const deactivateRecords = options?.deactivateRecords ?? false;
  const duplicateApiKeyId = options?.duplicateApiKeyId ?? false;

  const adminKey: Record<string, unknown> = {
    id: "api_key_admin",
    accountId: "account_1",
    tenantId: "tenant_1",
    projectId: "project_1",
    userId: "user_1",
    name: "admin-key",
    keyPrefix: "sk_sw",
    secretHash: hashApiKey(ADMIN_RAW_KEY, API_KEY_PEPPER),
    scopes: ["runs:write", "runs:read", "metrics:read", "admin:read", "nodes:write", "registry:read", "artifacts:read"],
    status: deactivateRecords ? "revoked" : "active",
    createdAt: NOW
  };
  if (includeRawKey) {
    adminKey["rawKey"] = ADMIN_RAW_KEY;
    delete adminKey["secretHash"];
  }

  const metricsOnlyKey: Record<string, unknown> = {
    id: duplicateApiKeyId ? "api_key_admin" : "api_key_metrics",
    accountId: "account_1",
    tenantId: "tenant_1",
    projectId: "project_1",
    userId: "user_1",
    name: "metrics-only-key",
    keyPrefix: "sk_sw",
    secretHash: hashApiKey(METRICS_ONLY_RAW_KEY, API_KEY_PEPPER),
    scopes: ["metrics:read"],
    status: deactivateRecords ? "revoked" : "active",
    createdAt: NOW
  };

  return JSON.stringify({
    accounts: [
      {
        id: "account_1",
        name: "Acme",
        status: deactivateRecords ? "suspended" : "active",
        billingPlanId: "billing_plan_1",
        createdAt: NOW
      }
    ],
    tenants: [
      {
        id: "tenant_1",
        accountId: "account_1",
        slug: "acme",
        displayName: "Acme",
        status: deactivateRecords ? "suspended" : "active",
        createdAt: NOW
      }
    ],
    projects: [
      {
        id: "project_1",
        accountId: "account_1",
        tenantId: "tenant_1",
        slug: "project",
        displayName: "Project",
        status: deactivateRecords ? "archived" : "active",
        createdAt: NOW
      }
    ],
    users: [
      {
        id: "user_1",
        accountId: "account_1",
        tenantId: "tenant_1",
        displayName: "Owner",
        email: "owner@example.com",
        status: deactivateRecords ? "suspended" : "active",
        createdAt: NOW
      }
    ],
    apiKeys: [adminKey, metricsOnlyKey],
    billingPlans: [
      {
        id: "billing_plan_1",
        slug: "enterprise",
        displayName: "Enterprise",
        status: deactivatePlan ? "archived" : "active",
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
    nodeTokenBindings: includeBindings
      ? [{ token: NODE_SHARED_TOKEN, apiKeyId: "api_key_admin" }]
      : []
  });
}

function createMultiTenantBootstrapJson() {
  const base = JSON.parse(createBootstrapJson()) as {
    accounts: Array<Record<string, unknown>>;
    tenants: Array<Record<string, unknown>>;
    projects: Array<Record<string, unknown>>;
    users: Array<Record<string, unknown>>;
    apiKeys: Array<Record<string, unknown>>;
    billingPlans: Array<Record<string, unknown>>;
    nodeTokenBindings: Array<Record<string, unknown>>;
  };
  base.accounts.push({
    id: "account_2",
    name: "Other",
    status: "active",
    billingPlanId: "billing_plan_1",
    createdAt: NOW
  });
  base.tenants.push({
    id: "tenant_2",
    accountId: "account_2",
    slug: "other",
    displayName: "Other",
    status: "active",
    createdAt: NOW
  });
  base.projects.push({
    id: "project_2",
    accountId: "account_2",
    tenantId: "tenant_2",
    slug: "project",
    displayName: "Other Project",
    status: "active",
    createdAt: NOW
  });
  base.users.push({
    id: "user_2",
    accountId: "account_2",
    tenantId: "tenant_2",
    displayName: "Other Owner",
    email: "other@example.com",
    status: "active",
    createdAt: NOW
  });
  base.apiKeys.push({
    id: "api_key_other",
    accountId: "account_2",
    tenantId: "tenant_2",
    projectId: "project_2",
    userId: "user_2",
    name: "other-key",
    keyPrefix: "sk_sw",
    secretHash: hashApiKey(OTHER_RAW_KEY, API_KEY_PEPPER),
    scopes: ["runs:write", "runs:read", "metrics:read", "admin:read", "nodes:write", "registry:read", "artifacts:read"],
    status: "active",
    createdAt: NOW
  });
  return JSON.stringify(base);
}

function createStagingEnv(overrides?: Record<string, string>) {
  return {
    SWITCHYARD_DEPLOYMENT_MODE: "staging",
    SWITCHYARD_POSTGRES_URL: "postgres://localhost/switchyard",
    SWITCHYARD_REDIS_URL: "redis://localhost:6379/0",
    SWITCHYARD_OBJECT_STORE_BACKEND: "local",
    SWITCHYARD_OBJECT_STORE_DIR: "/tmp/switchyard-store",
    SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic",
    SWITCHYARD_NODE_SHARED_TOKEN: NODE_SHARED_TOKEN,
    SWITCHYARD_SERVER_AUTH_MODE: "api_key",
    SWITCHYARD_API_KEY_PEPPER: API_KEY_PEPPER,
    SWITCHYARD_CONTROL_PLANE_STORE: "memory",
    SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_JSON: createBootstrapJson(),
    ...overrides
  };
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

function createProviderRuntimePolicyJson(maxPromptBytes = 60000): string {
  return JSON.stringify({
    version: 1,
    modes: {
      "codex.exec_json": {
        enabled: true,
        executablePath: "/bin/sh",
        cwdPrefixes: ["/repo"],
        envAllowlist: ["PATH"],
        requiredEnv: [],
        allowUserArgs: false,
        fixedArgs: ["exec", "--json"],
        sandbox: "read_only",
        spendControls: {
          maxActiveRuns: 10,
          maxRunsPerHour: 50,
          maxRunTimeoutSeconds: 600,
          maxPromptBytes
        }
      }
    }
  });
}

function fakeDebatePayload(topic = "Should hosted fake debates ship first?") {
  return {
    topic,
    participants: [{ role: "affirmative" }, { role: "skeptic" }]
  };
}

describe("hosted server", () => {
  it("does not expose middleware tool invocation routes on hosted server", async () => {
    const app = await createServerApp({
      host: "127.0.0.1",
      port: 0,
      deploymentMode: "test",
      hostedRuntimeAllowlist: ["fake.deterministic"],
      hostedRealRuntimeExecution: "disabled",
      objectStore: resolveObjectStoreConfig({ deploymentMode: "test", env: {} }),
      sandbox: defaultSandbox(),
      redactedSummary: {}
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/invocations",
        payload: {
          type: "fetch",
          input: { url: "https://example.com", method: "GET" }
        }
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("registers only the hosted debate route family behind API key auth", async () => {
    const config = loadServerConfig(createAuthEnabledTestEnv());
    const app = await createServerApp(config);
    try {
      const noAuth = await app.inject({
        method: "POST",
        url: "/debates",
        payload: fakeDebatePayload()
      });
      expect(noAuth.statusCode).toBe(401);
      expect(noAuth.json().error.code).toBe("auth_required");

      const forbiddenJudge = await app.inject({
        method: "POST",
        url: "/debates/judge",
        headers: { authorization: `Bearer ${ADMIN_RAW_KEY}` },
        payload: {}
      });
      expect(forbiddenJudge.statusCode).toBe(404);

      const forbiddenParticipants = await app.inject({
        method: "POST",
        url: "/debates/participants/real",
        headers: { authorization: `Bearer ${ADMIN_RAW_KEY}` },
        payload: {}
      });
      expect(forbiddenParticipants.statusCode).toBe(404);

      const forbiddenModelJudge = await app.inject({
        method: "POST",
        url: "/model-judge",
        headers: { authorization: `Bearer ${ADMIN_RAW_KEY}` },
        payload: {}
      });
      expect(forbiddenModelJudge.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("persists hosted fake async debate and allows owned inspect and events", async () => {
    const config = loadServerConfig(createAuthEnabledTestEnv());
    const app = await createServerApp(config);
    try {
      const created = await app.inject({
        method: "POST",
        url: "/debates",
        headers: { authorization: `Bearer ${ADMIN_RAW_KEY}` },
        payload: fakeDebatePayload("Should async hosted fake debates use durable jobs?")
      });
      expect(created.statusCode).toBe(202);
      const debateId = created.json().debate.id;
      expect(debateId).toMatch(/^debate_/);
      expect(created.json().debate.status).toBe("created");

      const inspected = await app.inject({
        method: "GET",
        url: `/debates/${debateId}`,
        headers: { authorization: `Bearer ${ADMIN_RAW_KEY}` }
      });
      expect(inspected.statusCode).toBe(200);
      expect(inspected.json().debate.id).toBe(debateId);

      const events = await app.inject({
        method: "GET",
        url: `/debates/${debateId}/events`,
        headers: { authorization: `Bearer ${ADMIN_RAW_KEY}` }
      });
      expect(events.statusCode).toBe(200);

      const ready = await app.inject({
        method: "GET",
        url: "/ready",
        headers: { authorization: `Bearer ${ADMIN_RAW_KEY}` }
      });
      expect(ready.statusCode).toBe(200);
      expect(ready.json().checks.unownedResources.ok).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("completes hosted fake debate with wait without live provider adapters", async () => {
    const config = loadServerConfig(createAuthEnabledTestEnv());
    const app = await createServerApp(config);
    try {
      const created = await app.inject({
        method: "POST",
        url: "/debates?wait=1",
        headers: { authorization: `Bearer ${ADMIN_RAW_KEY}` },
        payload: fakeDebatePayload("Should wait mode stay no spend?")
      });
      expect(created.statusCode).toBe(201);
      const body = created.json();
      expect(["no_consensus", "consensus_found", "completed"]).toContain(body.debate.status);
      expect(body.events.length).toBeGreaterThan(0);
      expect(body.finalReportArtifact.id).toMatch(/^artifact_/);
      expect(body.finalReportArtifact.debateId).toBe(body.debate.id);
      expect(body.debate.finalReportArtifactId).toBe(body.finalReportArtifact.id);
    } finally {
      await app.close();
    }
  });

  it("does not leak debate existence on tenant mismatch for inspect or events", async () => {
    const config = loadServerConfig(createAuthEnabledTestEnv({
      SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_JSON: createMultiTenantBootstrapJson()
    }));
    const app = await createServerApp(config);
    try {
      const created = await app.inject({
        method: "POST",
        url: "/debates",
        headers: { authorization: `Bearer ${ADMIN_RAW_KEY}` },
        payload: fakeDebatePayload("Should tenant mismatch hide debates?")
      });
      expect(created.statusCode).toBe(202);
      const debateId = created.json().debate.id;

      const inspected = await app.inject({
        method: "GET",
        url: `/debates/${debateId}`,
        headers: { authorization: `Bearer ${OTHER_RAW_KEY}` }
      });
      expect(inspected.statusCode).toBe(404);
      expect(inspected.json().error.code).toBe("debate_not_found");

      const events = await app.inject({
        method: "GET",
        url: `/debates/${debateId}/events`,
        headers: { authorization: `Bearer ${OTHER_RAW_KEY}` }
      });
      expect(events.statusCode).toBe(404);
      expect(events.json().error.code).toBe("debate_not_found");
    } finally {
      await app.close();
    }
  });

  it("fails closed before disclosing debate or job ids when hosted debate ownership hooks fail", async () => {
    const originalAttach = PostgresControlPlaneStore.prototype.attachOwnership;
    const attachSpy = vi.spyOn(PostgresControlPlaneStore.prototype, "attachOwnership");
    attachSpy.mockImplementation(async function mockedAttach(input) {
      if (input.resourceType === "debate") {
        throw new Error("forced_debate_attach_failure");
      }
      return originalAttach.call(this, input);
    });
    const config = loadServerConfig(createAuthEnabledTestEnv());
    const app = await createServerApp(config);
    try {
      const created = await app.inject({
        method: "POST",
        url: "/debates",
        headers: { authorization: `Bearer ${ADMIN_RAW_KEY}` },
        payload: fakeDebatePayload("Should debate ownership fail closed?")
      });
      expect(created.statusCode).toBe(503);
      expect(created.json().error.code).toBe("hosted_debate_ownership_attach_failed");
      expect(created.json().debate).toBeUndefined();
      expect(created.body).not.toMatch(/debate_[0-9a-f-]{8}/);
      expect(created.body).not.toMatch(/debate_job_[0-9a-f_]{8}/);
    } finally {
      attachSpy.mockRestore();
      await app.close();
    }
  });

  it("fails closed before durable job enqueue success is disclosed when parent ownership check fails", async () => {
    const originalAuthorize = ControlPlaneService.prototype.authorizeResource;
    const authorizeSpy = vi.spyOn(ControlPlaneService.prototype, "authorizeResource");
    authorizeSpy.mockImplementation(async function mockedAuthorize(input) {
      if (input.resourceType === "debate" && input.notFoundCode === "hosted_debate_ownership_attach_failed") {
        return {
          ok: false,
          decision: "denied",
          code: "hosted_debate_ownership_attach_failed",
          reasonCode: "forced_job_parent_denied"
        };
      }
      return originalAuthorize.call(this, input);
    });
    const config = loadServerConfig(createAuthEnabledTestEnv());
    const app = await createServerApp(config);
    try {
      const created = await app.inject({
        method: "POST",
        url: "/debates",
        headers: { authorization: `Bearer ${ADMIN_RAW_KEY}` },
        payload: fakeDebatePayload("Should debate job ownership fail closed?")
      });
      expect(created.statusCode).toBe(503);
      expect(created.json().error.code).toBe("hosted_debate_ownership_attach_failed");
      expect(created.json().debate).toBeUndefined();
      expect(created.body).not.toMatch(/debate_job_[0-9a-f_]{8}/);
    } finally {
      authorizeSpy.mockRestore();
      await app.close();
    }
  });

  it("fails closed before child run, event, or artifact ids are disclosed when attachment fails", async () => {
    const originalAttach = PostgresControlPlaneStore.prototype.attachOwnership;
    for (const resourceType of ["run", "run_event", "artifact"] as const) {
      const attachSpy = vi.spyOn(PostgresControlPlaneStore.prototype, "attachOwnership");
      attachSpy.mockImplementation(async function mockedAttach(input) {
        if (input.resourceType === resourceType) {
          throw new Error(`forced_${resourceType}_attach_failure`);
        }
        return originalAttach.call(this, input);
      });
      const config = loadServerConfig(createAuthEnabledTestEnv());
      const app = await createServerApp(config);
      try {
        const created = await app.inject({
          method: "POST",
          url: "/debates?wait=1",
          headers: { authorization: `Bearer ${ADMIN_RAW_KEY}` },
          payload: fakeDebatePayload(`Should ${resourceType} ownership fail closed?`)
        });
        expect(created.statusCode).toBe(503);
        expect(created.json().error.code).toBe("hosted_debate_ownership_attach_failed");
        if (resourceType === "run") {
          expect(created.body).not.toMatch(/run_[0-9a-f-]{8}/);
        }
        if (resourceType === "run_event") {
          expect(created.body).not.toMatch(/event_[0-9a-f-]{8}/);
        }
        if (resourceType === "artifact") {
          expect(created.body).not.toMatch(/artifact_[0-9a-f-]{8}/);
        }
      } finally {
        attachSpy.mockRestore();
        await app.close();
      }
    }
  });

  it("does not import provider adapters for server debate execution", async () => {
    const source = await readFile(new URL("../src/app.ts", import.meta.url), "utf8");
    expect(source).not.toContain("@switchyard/adapters");
    const fakeAdapterConstructors = source.match(/new FakeRuntimeAdapter\(/g) ?? [];
    expect(fakeAdapterConstructors).toHaveLength(1);
  });

  it("completes hosted fake run with wait", async () => {
    const app = await createServerApp({
      host: "127.0.0.1",
      port: 0,
      deploymentMode: "test",
      hostedRuntimeAllowlist: ["fake.deterministic"],
      hostedRealRuntimeExecution: "disabled",
      objectStore: resolveObjectStoreConfig({ deploymentMode: "test", env: {} }),
      sandbox: defaultSandbox(),
      redactedSummary: {}
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/runs?wait=1",
        payload: {
          runtime: "fake",
          provider: "test",
          model: "test-model",
          adapterType: "process",
          cwd: "/repo",
          task: "hosted test",
          placement: "hosted"
        }
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().run.status).toBe("completed");
    } finally {
      await app.close();
    }
  });

  it("rejects hosted unsafe runtime", async () => {
    const app = await createServerApp({
      host: "127.0.0.1",
      port: 0,
      deploymentMode: "test",
      hostedRuntimeAllowlist: [],
      hostedRealRuntimeExecution: "disabled",
      objectStore: resolveObjectStoreConfig({ deploymentMode: "test", env: {} }),
      sandbox: defaultSandbox(),
      redactedSummary: {}
    });
    try {
      const ready = await app.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(503);
      expect(ready.json().checks.hostedAllowlist.code).toBe("hosted_runtime_not_allowed");

      const response = await app.inject({
        method: "POST",
        url: "/runs",
        payload: {
          runtime: "fake",
          provider: "test",
          model: "test-model",
          adapterType: "process",
          cwd: "/repo",
          task: "bad mode",
          runtimeMode: "fake.deterministic",
          placement: "hosted"
        }
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("placement_denied");
    } finally {
      await app.close();
    }
  });

  it("reports hosted real runtime gate readiness failure when disabled", async () => {
    const app = await createServerApp({
      host: "127.0.0.1",
      port: 0,
      deploymentMode: "test",
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      hostedRealRuntimeExecution: "disabled",
      objectStore: resolveObjectStoreConfig({ deploymentMode: "test", env: {} }),
      sandbox: defaultSandbox(),
      redactedSummary: {}
    });
    try {
      const ready = await app.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(503);
      expect(ready.json().checks.hostedRuntimeGate.code).toBe("hosted_real_runtime_disabled");
    } finally {
      await app.close();
    }
  });

  it("parses opt-in hosted infrastructure config", () => {
    const config = loadServerConfig({
      SWITCHYARD_POSTGRES_URL: "postgres://user:pass@localhost:5432/switchyard",
      SWITCHYARD_REDIS_URL: "redis://localhost:6379/0",
      SWITCHYARD_QUEUE_NAME: "switchyard-hosted",
      SWITCHYARD_OBJECT_STORE_BACKEND: "local",
      SWITCHYARD_OBJECT_STORE_DIR: "/tmp/switchyard-objects",
      SWITCHYARD_NODE_SHARED_TOKEN: NODE_SHARED_TOKEN,
      SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic",
      SWITCHYARD_SERVER_AUTH_MODE: "api_key",
      SWITCHYARD_API_KEY_PEPPER: API_KEY_PEPPER,
      SWITCHYARD_CONTROL_PLANE_STORE: "postgres",
      SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_JSON: createBootstrapJson(),
      SWITCHYARD_DEPLOYMENT_MODE: "staging"
    });

    expect(config.postgresUrl).toContain("postgres://");
    expect(config.redisUrl).toBe("redis://localhost:6379/0");
    expect(config.queueName).toBe("switchyard-hosted");
    expect(config.objectStore.backend).toBe("local");
    expect(config.deploymentMode).toBe("staging");
    expect(config.hostedRealRuntimeExecution).toBe("disabled");
    expect(config.serverAuthMode).toBe("api_key");
  });

  it("rejects invalid hosted real runtime gate value", () => {
    expect(() =>
      loadServerConfig({
        SWITCHYARD_DEPLOYMENT_MODE: "local",
        SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION: "yes"
      })
    ).toThrow("config_invalid:SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION");
  });

  it("fails closed in production real-runtime activation when provider policy gates are missing", () => {
    expect(() =>
      loadServerConfig({
        SWITCHYARD_DEPLOYMENT_MODE: "production",
        SWITCHYARD_POSTGRES_URL: "postgres://localhost/db",
        SWITCHYARD_REDIS_URL: "redis://localhost:6379/0",
        SWITCHYARD_OBJECT_STORE_BACKEND: "local",
        SWITCHYARD_OBJECT_STORE_DIR: "/tmp/store",
        SWITCHYARD_NODE_SHARED_TOKEN: NODE_SHARED_TOKEN,
        SWITCHYARD_SERVER_AUTH_MODE: "api_key",
        SWITCHYARD_API_KEY_PEPPER: API_KEY_PEPPER,
        SWITCHYARD_CONTROL_PLANE_STORE: "postgres",
        SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_JSON: createBootstrapJson(),
        SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic,codex.exec_json",
        SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION: "enabled"
      })
    ).toThrow(/provider_runtime_policy_missing|provider_runtime_policy_malformed|provider_runtime_policy_empty/);
  });

  it("exposes readiness and hosted metrics", async () => {
    const app = await createServerApp({
      host: "127.0.0.1",
      port: 0,
      deploymentMode: "test",
      hostedRuntimeAllowlist: ["fake.deterministic"],
      hostedRealRuntimeExecution: "disabled",
      objectStore: resolveObjectStoreConfig({ deploymentMode: "test", env: {} }),
      sandbox: defaultSandbox(),
      redactedSummary: {}
    });
    try {
      const ready = await app.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json().ok).toBe(true);
      expect(ready.json().checks.objectStore.ok).toBe(true);

      const metrics = await app.inject({ method: "GET", url: "/metrics" });
      expect(metrics.statusCode).toBe(200);
      expect(metrics.json().queue).toBeDefined();
      expect(metrics.json().dependencies).toBeDefined();
      expect(metrics.json().hostedRuntime).toMatchObject({
        accepted: 0,
        denied: 0,
        started: 0,
        completed: 0,
        failed: 0,
        timeout: 0,
        unsupportedInteraction: 0,
        artifactPersisted: 0
      });
      expect(metrics.json().objectStore).toMatchObject({
        reads: 0,
        writes: 0,
        failures: 0,
        probeFailures: 0,
        authFailures: 0,
        unavailable: 0,
        digestMismatches: 0
      });
    } finally {
      await app.close();
    }
  });

  it("skips local object-store probe when probe mode is disabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "switchyard-server-probe-disabled-local-"));
    const fileRoot = join(dir, "object-root-file");
    await writeFile(fileRoot, "x");
    const app = await createServerApp({
      host: "127.0.0.1",
      port: 0,
      deploymentMode: "test",
      hostedRuntimeAllowlist: ["fake.deterministic"],
      hostedRealRuntimeExecution: "disabled",
      objectStore: resolveObjectStoreConfig({
        deploymentMode: "test",
        env: {
          SWITCHYARD_OBJECT_STORE_BACKEND: "local",
          SWITCHYARD_OBJECT_STORE_DIR: fileRoot,
          SWITCHYARD_OBJECT_STORE_PROBE: "disabled"
        }
      }),
      sandbox: defaultSandbox(),
      redactedSummary: {}
    });
    try {
      const ready = await app.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json().checks.objectStore.ok).toBe(true);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips s3-compatible object-store probe when probe mode is disabled", async () => {
    const app = await createServerApp({
      host: "127.0.0.1",
      port: 0,
      deploymentMode: "test",
      hostedRuntimeAllowlist: ["fake.deterministic"],
      hostedRealRuntimeExecution: "disabled",
      objectStore: resolveObjectStoreConfig({
        deploymentMode: "test",
        env: {
          SWITCHYARD_OBJECT_STORE_BACKEND: "s3-compatible",
          SWITCHYARD_OBJECT_STORE_ENDPOINT: "http://127.0.0.1:1",
          SWITCHYARD_OBJECT_STORE_REGION: "us-east-1",
          SWITCHYARD_OBJECT_STORE_BUCKET: "switchyard-artifacts",
          SWITCHYARD_OBJECT_STORE_ACCESS_KEY_ID: "key",
          SWITCHYARD_OBJECT_STORE_SECRET_ACCESS_KEY: "secret",
          SWITCHYARD_OBJECT_STORE_PROBE: "disabled"
        }
      }),
      sandbox: defaultSandbox(),
      redactedSummary: {}
    });
    try {
      const ready = await app.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json().checks.objectStore.ok).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("fails closed in staging for missing dependencies", () => {
    expect(() =>
      loadServerConfig({
        SWITCHYARD_DEPLOYMENT_MODE: "staging",
        SWITCHYARD_POSTGRES_URL: "postgres://localhost/db",
        SWITCHYARD_OBJECT_STORE_BACKEND: "local",
        SWITCHYARD_OBJECT_STORE_DIR: "/tmp/store",
        SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic",
        SWITCHYARD_NODE_SHARED_TOKEN: "token"
      })
    ).toThrow("config_required:SWITCHYARD_REDIS_URL");
  });

  it("rejects staging when auth mode is disabled", () => {
    expect(() =>
      loadServerConfig(
        createStagingEnv({
          SWITCHYARD_SERVER_AUTH_MODE: "disabled"
        })
      )
    ).toThrow(/config_forbidden:SWITCHYARD_SERVER_AUTH_MODE|config_required:SWITCHYARD_SERVER_AUTH_MODE/);
  });

  it("rejects staging when api key pepper is missing", () => {
    const env = createStagingEnv();
    delete env.SWITCHYARD_API_KEY_PEPPER;
    expect(() => loadServerConfig(env)).toThrow("config_required:SWITCHYARD_API_KEY_PEPPER");
  });

  it("rejects staging when control plane store is memory", () => {
    expect(() => loadServerConfig(createStagingEnv())).toThrow("config_forbidden:SWITCHYARD_CONTROL_PLANE_STORE");
  });

  it("rejects staging when bootstrap is missing", () => {
    const env = createStagingEnv();
    delete env.SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_JSON;
    expect(() => loadServerConfig(env)).toThrow("control_plane_bootstrap_missing");
  });

  it("rejects production public metrics", () => {
    expect(() =>
      loadServerConfig(
        createStagingEnv({
          SWITCHYARD_DEPLOYMENT_MODE: "production",
          SWITCHYARD_CONTROL_PLANE_STORE: "postgres",
          SWITCHYARD_PUBLIC_METRICS: "1"
        })
      )
    ).toThrow("config_forbidden:SWITCHYARD_PUBLIC_METRICS");
  });

  it("protects /metrics in staging and requires admin plus metrics scopes", async () => {
    const config = loadServerConfig(
      createAuthEnabledTestEnv()
    );
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
      expect(admin.json().auth).toBeDefined();
      expect(admin.json().controlPlane).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("increments control-plane metrics after authenticated hosted run", async () => {
    const config = loadServerConfig(createAuthEnabledTestEnv());
    const app = await createServerApp(config);
    try {
      const before = await app.inject({
        method: "GET",
        url: "/metrics",
        headers: {
          authorization: `Bearer ${ADMIN_RAW_KEY}`
        }
      });
      expect(before.statusCode).toBe(200);

      const created = await app.inject({
        method: "POST",
        url: "/runs?wait=1",
        headers: {
          authorization: `Bearer ${ADMIN_RAW_KEY}`
        },
        payload: {
          runtime: "fake",
          provider: "test",
          model: "test-model",
          adapterType: "process",
          cwd: "/repo",
          task: "hosted auth metrics",
          placement: "hosted",
          runtimeMode: "fake.deterministic"
        }
      });
      expect(created.statusCode).toBe(201);

      const after = await app.inject({
        method: "GET",
        url: "/metrics",
        headers: {
          authorization: `Bearer ${ADMIN_RAW_KEY}`
        }
      });
      expect(after.statusCode).toBe(200);

      const beforeMetrics = before.json();
      const afterMetrics = after.json();
      expect(afterMetrics.auth.succeeded).toBeGreaterThan(beforeMetrics.auth.succeeded);
      expect(afterMetrics.quota.reserved).toBeGreaterThan(beforeMetrics.quota.reserved);
      expect(afterMetrics.quota.released).toBeGreaterThan(beforeMetrics.quota.released);
      expect(afterMetrics.audit.appended).toBeGreaterThan(beforeMetrics.audit.appended);
    } finally {
      await app.close();
    }
  });

  it("redacts bootstrap raw key and pepper from summaries and errors", () => {
    const env = createStagingEnv({
      SWITCHYARD_DEPLOYMENT_MODE: "local",
      SWITCHYARD_CONTROL_PLANE_STORE: "memory",
      SWITCHYARD_SERVER_AUTH_MODE: "api_key",
      SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_JSON: createBootstrapJson({ includeRawKey: true, duplicateApiKeyId: true })
    });

    expect(() => loadServerConfig(env)).toThrow();
    try {
      loadServerConfig(env);
    } catch (error) {
      const payload = JSON.stringify((error as { redactedConfig?: unknown }).redactedConfig ?? {});
      expect(payload).not.toContain(ADMIN_RAW_KEY);
      expect(payload).not.toContain(API_KEY_PEPPER);
      expect(payload).not.toContain("rawKey");
    }
  });

  it("includes R18 readiness checks", async () => {
    const config = loadServerConfig(
      createAuthEnabledTestEnv()
    );
    const app = await createServerApp(config);
    try {
      const ready = await app.inject({ method: "GET", url: "/ready" });
      const checks = ready.json().checks;
      expect(checks.controlPlaneStore).toBeDefined();
      expect(checks.apiKeyAuth).toBeDefined();
      expect(checks.apiKeyPepper).toBeDefined();
      expect(checks.bootstrap).toBeDefined();
      expect(checks.billingPlan).toBeDefined();
      expect(checks.quotaStore).toBeDefined();
      expect(checks.auditStore).toBeDefined();
      expect(checks.unownedResources).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("marks readiness unowned_resources_present when unowned resources exist", async () => {
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
        read: async () => ({ body: Buffer.from(""), contentType: "application/octet-stream" }),
        probe: async () => {}
      },
      controlPlane: {
        mode: "enabled",
        hasApiKeyPepper: true,
        hasBootstrap: true,
        bootstrapActiveCounts: {
          accounts: 1,
          tenants: 1,
          projects: 1,
          users: 1,
          apiKeys: 1,
          billingPlans: 1
        },
        storeReady: true,
        unownedResources: {
          runs: 1,
          runEvents: 0,
          artifacts: 0,
          placements: 0,
          nodes: 0,
          assignments: 0,
          auditEvents: 0,
          quotaReservations: 0
        },
        hasQuotaStore: true,
        hasAuditStore: true,
        nodeTokenBound: true
      }
    });

    expect(report.ok).toBe(false);
    expect(report.checks.unownedResources.ok).toBe(false);
    expect(report.checks.unownedResources.code).toBe("unowned_resources_present");
  });

  it("marks readiness unowned_resources_present when unowned audit events exist", async () => {
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
        read: async () => ({ body: Buffer.from(""), contentType: "application/octet-stream" }),
        probe: async () => {}
      },
      controlPlane: {
        mode: "enabled",
        hasApiKeyPepper: true,
        hasBootstrap: true,
        bootstrapActiveCounts: {
          accounts: 1,
          tenants: 1,
          projects: 1,
          users: 1,
          apiKeys: 1,
          billingPlans: 1
        },
        storeReady: true,
        unownedResources: {
          runs: 0,
          runEvents: 0,
          artifacts: 0,
          placements: 0,
          nodes: 0,
          assignments: 0,
          auditEvents: 1,
          quotaReservations: 0
        },
        hasQuotaStore: true,
        hasAuditStore: true,
        nodeTokenBound: true
      }
    });

    expect(report.ok).toBe(false);
    expect(report.checks.unownedResources.ok).toBe(false);
    expect(report.checks.unownedResources.code).toBe("unowned_resources_present");
  });

  it("marks readiness unowned_resources_present when unowned quota reservations exist", async () => {
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
        read: async () => ({ body: Buffer.from(""), contentType: "application/octet-stream" }),
        probe: async () => {}
      },
      controlPlane: {
        mode: "enabled",
        hasApiKeyPepper: true,
        hasBootstrap: true,
        bootstrapActiveCounts: {
          accounts: 1,
          tenants: 1,
          projects: 1,
          users: 1,
          apiKeys: 1,
          billingPlans: 1
        },
        storeReady: true,
        unownedResources: {
          runs: 0,
          runEvents: 0,
          artifacts: 0,
          placements: 0,
          nodes: 0,
          assignments: 0,
          auditEvents: 0,
          quotaReservations: 1
        },
        hasQuotaStore: true,
        hasAuditStore: true,
        nodeTokenBound: true
      }
    });

    expect(report.ok).toBe(false);
    expect(report.checks.unownedResources.ok).toBe(false);
    expect(report.checks.unownedResources.code).toBe("unowned_resources_present");
  });

  it("fails closed in staging when hosted allowlist is missing", () => {
    expect(() =>
      loadServerConfig({
        SWITCHYARD_DEPLOYMENT_MODE: "staging",
        SWITCHYARD_POSTGRES_URL: "postgres://localhost/db",
        SWITCHYARD_REDIS_URL: "redis://localhost:6379/0",
        SWITCHYARD_OBJECT_STORE_BACKEND: "local",
        SWITCHYARD_OBJECT_STORE_DIR: "/tmp/store",
        SWITCHYARD_NODE_SHARED_TOKEN: NODE_SHARED_TOKEN,
        SWITCHYARD_SERVER_AUTH_MODE: "api_key",
        SWITCHYARD_API_KEY_PEPPER: API_KEY_PEPPER,
        SWITCHYARD_CONTROL_PLANE_STORE: "postgres",
        SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_JSON: createBootstrapJson()
      })
    ).toThrow("config_required:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST");
  });

  it("keeps local default hosted allowlist when env is absent", () => {
    const config = loadServerConfig({
      SWITCHYARD_DEPLOYMENT_MODE: "local"
    });
    expect(config.hostedRuntimeAllowlist).toEqual(["fake.deterministic"]);
    expect(config.objectStore.backend).toBe("memory");
  });

  it("exposes sandbox readiness states", async () => {
    const disabledApp = await createServerApp({
      host: "127.0.0.1",
      port: 0,
      deploymentMode: "test",
      hostedRuntimeAllowlist: ["fake.deterministic"],
      hostedRealRuntimeExecution: "disabled",
      objectStore: resolveObjectStoreConfig({ deploymentMode: "test", env: {} }),
      sandbox: resolveHostedSandboxConfig({
        deploymentMode: "test",
        env: { SWITCHYARD_SANDBOX_ENABLED: "false" }
      }),
      redactedSummary: {}
    });

    try {
      const ready = await disabledApp.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(503);
      expect(ready.json().checks.sandbox.code).toBe("sandbox_disabled");
    } finally {
      await disabledApp.close();
    }

    const invalidPolicyApp = await createServerApp({
      host: "127.0.0.1",
      port: 0,
      deploymentMode: "test",
      hostedRuntimeAllowlist: ["fake.deterministic"],
      hostedRealRuntimeExecution: "disabled",
      objectStore: resolveObjectStoreConfig({ deploymentMode: "test", env: {} }),
      sandbox: resolveHostedSandboxConfig({
        deploymentMode: "test",
        env: { SWITCHYARD_SANDBOX_FAKE_COMMAND_ALLOWLIST: "bash" }
      }),
      redactedSummary: {}
    });

    try {
      const ready = await invalidPolicyApp.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(503);
      expect(ready.json().checks.sandbox.code).toBe("sandbox_policy_invalid");
    } finally {
      await invalidPolicyApp.close();
    }
  });

  it("includes sandbox metrics and has no public sandbox routes", async () => {
    const app = await createServerApp({
      host: "127.0.0.1",
      port: 0,
      deploymentMode: "test",
      hostedRuntimeAllowlist: ["fake.deterministic"],
      hostedRealRuntimeExecution: "disabled",
      objectStore: resolveObjectStoreConfig({ deploymentMode: "test", env: {} }),
      sandbox: defaultSandbox(),
      redactedSummary: {}
    });
    try {
      const metrics = await app.inject({ method: "GET", url: "/metrics" });
      expect(metrics.statusCode).toBe(200);
      expect(metrics.json().sandbox).toMatchObject({
        jobs: 0,
        allowed: 0,
        denied: 0,
        completed: 0,
        failed: 0,
        timeout: 0,
        cancelled: 0,
        outputTruncated: 0,
        artifactTruncated: 0,
        redactions: 0
      });

      for (const route of ["/sandbox", "/exec", "/shell", "/process", "/command", "/pty", "/terminal"]) {
        const res = await app.inject({ method: "POST", url: route, payload: {} });
        expect(res.statusCode).toBe(404);
      }
    } finally {
      await app.close();
    }
  });

  it("does not expose hosted bridge, session, dashboard, or arbitrary execution routes", async () => {
    const app = await createServerApp({
      host: "127.0.0.1",
      port: 0,
      deploymentMode: "test",
      hostedRuntimeAllowlist: ["fake.deterministic", "claude_code.sdk", "opencode.acp"],
      hostedRealRuntimeExecution: "enabled",
      objectStore: resolveObjectStoreConfig({ deploymentMode: "test", env: {} }),
      sandbox: defaultSandbox(),
      redactedSummary: {}
    });

    try {
      const forbiddenRoutes = [
        "/runtime-bridge",
        "/runtime-bridge/commands",
        "/runtime-bridge/sessions",
        "/hosted/runtime-bridge/commands",
        "/hosted/runtime-bridge/sessions",
        "/sessions",
        "/sessions/reconcile",
        "/dashboard",
        "/tui",
        "/execute",
        "/arbitrary-execution"
      ];

      for (const route of forbiddenRoutes) {
        const getResponse = await app.inject({ method: "GET", url: route });
        expect(getResponse.statusCode).toBe(404);

        const postResponse = await app.inject({ method: "POST", url: route, payload: {} });
        expect(postResponse.statusCode).toBe(404);
      }
    } finally {
      await app.close();
    }
  });

  it("keeps server app free of real provider adapter imports and instantiation", async () => {
    const source = await readFile(new URL("../src/app.ts", import.meta.url), "utf8");
    const importLines = source.split("\n").filter((line) => line.startsWith("import "));
    const sourceLower = source.toLowerCase();

    expect(importLines.some((line) => line.includes("@switchyard/adapters"))).toBe(false);
    expect(importLines.some((line) => line.includes("@anthropic-ai"))).toBe(false);
    expect(importLines.some((line) => line.includes("openai"))).toBe(false);
    expect(importLines.some((line) => line.includes("opencode"))).toBe(false);
    expect(sourceLower).not.toContain("new claude");
    expect(sourceLower).not.toContain("new codex");
    expect(sourceLower).not.toContain("new opencode");
    expect(sourceLower).not.toContain("new agentfield");
    expect(sourceLower).not.toContain("new generichttp");
  });

  it("emits hosted admission lifecycle metrics with outcome/runtime_mode/reason labels", async () => {
    const acceptedAndWaitConfig = loadServerConfig({
      SWITCHYARD_DEPLOYMENT_MODE: "test",
      SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic,codex.exec_json",
      SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION: "enabled",
      SWITCHYARD_PROVIDER_RUNTIME_POLICY_JSON: createProviderRuntimePolicyJson(60000),
      SWITCHYARD_OBJECT_STORE_BACKEND: "memory"
    });
    const acceptedAndWaitApp = await createServerApp(acceptedAndWaitConfig);
    try {
      const accepted = await acceptedAndWaitApp.inject({
        method: "POST",
        url: "/runs",
        payload: {
          runtime: "codex",
          provider: "openai",
          model: "gpt-5",
          adapterType: "process",
          runtimeMode: "codex.exec_json",
          cwd: "/repo",
          task: "ok",
          placement: "hosted"
        }
      });
      expect(accepted.statusCode).toBe(202);

      const waitDenied = await acceptedAndWaitApp.inject({
        method: "POST",
        url: "/runs?wait=1",
        payload: {
          runtime: "codex",
          provider: "openai",
          model: "gpt-5",
          adapterType: "process",
          runtimeMode: "codex.exec_json",
          cwd: "/repo",
          task: "wait denied",
          placement: "hosted"
        }
      });
      expect(waitDenied.statusCode).toBe(409);

      const metrics = await acceptedAndWaitApp.inject({ method: "GET", url: "/metrics" });
      expect(metrics.statusCode).toBe(200);
      expect(metrics.json().hostedRuntimeAdmission.series).toEqual(expect.arrayContaining([
        {
          runtimeMode: "codex.exec_json",
          reason: "admitted",
          outcome: "accepted",
          count: 1
        },
        {
          runtimeMode: "codex.exec_json",
          reason: "hosted_wait_unsupported",
          outcome: "denied",
          count: 1
        }
      ]));
    } finally {
      await acceptedAndWaitApp.close();
    }

    const missingPolicyConfig = loadServerConfig({
      SWITCHYARD_DEPLOYMENT_MODE: "test",
      SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic,codex.exec_json",
      SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION: "enabled",
      SWITCHYARD_OBJECT_STORE_BACKEND: "memory"
    });
    const missingPolicyApp = await createServerApp(missingPolicyConfig);
    try {
      const denied = await missingPolicyApp.inject({
        method: "POST",
        url: "/runs",
        payload: {
          runtime: "codex",
          provider: "openai",
          model: "gpt-5",
          adapterType: "process",
          runtimeMode: "codex.exec_json",
          cwd: "/repo",
          task: "missing policy denied",
          placement: "hosted"
        }
      });
      expect(denied.statusCode).toBe(409);

      const metrics = await missingPolicyApp.inject({ method: "GET", url: "/metrics" });
      expect(metrics.statusCode).toBe(200);
      expect(metrics.json().hostedRuntimeAdmission.series).toEqual(expect.arrayContaining([
        {
          runtimeMode: "codex.exec_json",
          reason: "provider_runtime_policy_missing",
          outcome: "denied",
          count: 1
        }
      ]));
    } finally {
      await missingPolicyApp.close();
    }

    const spendDeniedConfig = loadServerConfig({
      SWITCHYARD_DEPLOYMENT_MODE: "test",
      SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic,codex.exec_json",
      SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION: "enabled",
      SWITCHYARD_PROVIDER_RUNTIME_POLICY_JSON: createProviderRuntimePolicyJson(4),
      SWITCHYARD_OBJECT_STORE_BACKEND: "memory"
    });
    const spendDeniedApp = await createServerApp(spendDeniedConfig);
    try {
      const denied = await spendDeniedApp.inject({
        method: "POST",
        url: "/runs",
        payload: {
          runtime: "codex",
          provider: "openai",
          model: "gpt-5",
          adapterType: "process",
          runtimeMode: "codex.exec_json",
          cwd: "/repo",
          task: "this prompt exceeds the limit",
          placement: "hosted"
        }
      });
      expect(denied.statusCode).toBe(409);

      const metrics = await spendDeniedApp.inject({ method: "GET", url: "/metrics" });
      expect(metrics.statusCode).toBe(200);
      expect(metrics.json().hostedRuntimeAdmission.series).toEqual(expect.arrayContaining([
        {
          runtimeMode: "codex.exec_json",
          reason: "provider_prompt_too_large",
          outcome: "spend_control_denied",
          count: 1
        }
      ]));
    } finally {
      await spendDeniedApp.close();
    }
  });

  it("rejects hosted real-runtime style requests before queue side effects", async () => {
    const app = await createServerApp({
      host: "127.0.0.1",
      port: 0,
      deploymentMode: "test",
      hostedRuntimeAllowlist: ["fake.deterministic"],
      hostedRealRuntimeExecution: "disabled",
      objectStore: resolveObjectStoreConfig({ deploymentMode: "test", env: {} }),
      sandbox: defaultSandbox(),
      redactedSummary: {}
    });
    try {
      const beforeRuns = await app.inject({ method: "GET", url: "/runs" });
      expect(beforeRuns.statusCode).toBe(200);
      expect(beforeRuns.json().runs).toHaveLength(0);

      const beforeMetrics = await app.inject({ method: "GET", url: "/metrics" });
      const beforeEnqueue = beforeMetrics.json().queue.enqueue;

      const cases = [
        { runtime: "codex", provider: "openai", model: "gpt-5", adapterType: "process", runtimeMode: "codex.exec_json" },
        { runtime: "claude_code", provider: "anthropic", model: "claude", adapterType: "native", runtimeMode: "claude_code.sdk" },
        { runtime: "opencode", provider: "opencode", model: "opencode", adapterType: "acpx", runtimeMode: "opencode.acp" },
        { runtime: "generic_http", provider: "test", model: "test", adapterType: "http", runtimeMode: "generic_http.async_rest" },
        { runtime: "agentfield", provider: "test", model: "test", adapterType: "http", runtimeMode: "agentfield.async_rest" },
        { runtime: "fake", provider: "test", model: "test-model", adapterType: "pty", runtimeMode: "fake.deterministic" },
        { runtime: "fake", provider: "test", model: "test-model", adapterType: "browser", runtimeMode: "fake.deterministic" }
      ] as const;

      for (const item of cases) {
        const response = await app.inject({
          method: "POST",
          url: "/runs",
          payload: {
            ...item,
            cwd: "/repo",
            task: "must reject",
            placement: "hosted"
          }
        });
        expect([400, 409]).toContain(response.statusCode);
        expect(response.json().error.code).toMatch(/invalid_input|placement_denied/);
      }

      const afterRuns = await app.inject({ method: "GET", url: "/runs" });
      expect(afterRuns.statusCode).toBe(200);
      expect(afterRuns.json().runs).toHaveLength(0);

      const afterMetrics = await app.inject({ method: "GET", url: "/metrics" });
      expect(afterMetrics.json().queue.enqueue).toBe(beforeEnqueue);
    } finally {
      await app.close();
    }
  });

  it("fails closed for invalid sandbox config values", () => {
    expect(() =>
      loadServerConfig({
        SWITCHYARD_DEPLOYMENT_MODE: "local",
        SWITCHYARD_SANDBOX_WALL_TIME_MS: "0"
      })
    ).toThrow("sandbox_config_invalid");
  });
});
