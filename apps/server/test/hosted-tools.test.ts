import { describe, expect, it } from "vitest";
import { hashApiKey } from "@switchyard/core";
import { createServerApp } from "../src/app.js";
import { loadServerConfig } from "../src/config.js";

const NOW = "2026-06-01T00:00:00.000Z";
const API_KEY_PEPPER = "pepper_for_hosted_tools_tests_123456";
const ADMIN_RAW_KEY = "sk_sw_tools_admin";
const READ_ONLY_RAW_KEY = "sk_sw_tools_read";
const WRITE_ONLY_RAW_KEY = "sk_sw_tools_write";

function createBootstrapJson() {
  return JSON.stringify({
    accounts: [{ id: "account_1", name: "Acme", status: "active", billingPlanId: "billing_plan_1", createdAt: NOW }],
    tenants: [{ id: "tenant_1", accountId: "account_1", slug: "acme", displayName: "Acme", status: "active", createdAt: NOW }],
    projects: [{ id: "project_1", accountId: "account_1", tenantId: "tenant_1", slug: "proj", displayName: "Project", status: "active", createdAt: NOW }],
    users: [{ id: "user_1", accountId: "account_1", tenantId: "tenant_1", displayName: "Owner", email: "owner@example.com", status: "active", createdAt: NOW }],
    apiKeys: [
      {
        id: "api_key_admin",
        accountId: "account_1",
        tenantId: "tenant_1",
        projectId: "project_1",
        userId: "user_1",
        name: "admin",
        keyPrefix: "sk_sw",
        secretHash: hashApiKey(ADMIN_RAW_KEY, API_KEY_PEPPER),
        scopes: ["runs:write", "runs:read", "tools:write", "tools:read", "registry:read", "artifacts:read", "nodes:write", "metrics:read", "admin:read"],
        status: "active",
        createdAt: NOW
      },
      {
        id: "api_key_read",
        accountId: "account_1",
        tenantId: "tenant_1",
        projectId: "project_1",
        userId: "user_1",
        name: "read",
        keyPrefix: "sk_sw",
        secretHash: hashApiKey(READ_ONLY_RAW_KEY, API_KEY_PEPPER),
        scopes: ["tools:read"],
        status: "active",
        createdAt: NOW
      },
      {
        id: "api_key_write",
        accountId: "account_1",
        tenantId: "tenant_1",
        projectId: "project_1",
        userId: "user_1",
        name: "write",
        keyPrefix: "sk_sw",
        secretHash: hashApiKey(WRITE_ONLY_RAW_KEY, API_KEY_PEPPER),
        scopes: ["tools:write"],
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
          allowHostedTools: true,
          allowConnectedNodeTools: true,
          allowedToolTypes: ["fetch", "web_search", "github", "repo", "shell", "fake_echo"],
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
        createdAt: NOW
      }
    ],
    nodeTokenBindings: []
  });
}

function createEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    SWITCHYARD_DEPLOYMENT_MODE: "test",
    SWITCHYARD_OBJECT_STORE_BACKEND: "memory",
    SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic",
    SWITCHYARD_SERVER_AUTH_MODE: "api_key",
    SWITCHYARD_API_KEY_PEPPER: API_KEY_PEPPER,
    SWITCHYARD_CONTROL_PLANE_STORE: "memory",
    SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_JSON: createBootstrapJson(),
    ...overrides
  };
}

describe("hosted tools", () => {
  it("registers hosted tool routes, enforces tools scopes, and does not expose hosted POST /approvals", async () => {
    const app = await createServerApp(loadServerConfig(createEnv()));
    try {
      const run = await app.inject({
        method: "POST",
        url: "/runs",
        headers: { authorization: `Bearer ${ADMIN_RAW_KEY}` },
        payload: {
          runtime: "fake",
          provider: "test",
          model: "test-model",
          adapterType: "process",
          cwd: "/repo",
          task: "tool route test",
          placement: "hosted"
        }
      });
      expect([201, 202]).toContain(run.statusCode);
      const runId = run.json().run.id as string;

      const invoke = await app.inject({
        method: "POST",
        url: "/tools/invocations",
        headers: { authorization: `Bearer ${ADMIN_RAW_KEY}` },
        payload: {
          runId,
          type: "fetch",
          target: { placement: "hosted" },
          input: { url: "https://example.com", method: "GET" }
        }
      });
      expect(invoke.statusCode).not.toBe(404);

      const readRequiresScope = await app.inject({
        method: "GET",
        url: "/approvals",
        headers: { authorization: `Bearer ${WRITE_ONLY_RAW_KEY}` }
      });
      expect(readRequiresScope.statusCode).toBe(403);
      expect(readRequiresScope.json().error.details?.some((detail: { issue?: string }) => detail.issue === "missing_scope")).toBe(true);

      const writeRequiresScope = await app.inject({
        method: "POST",
        url: "/tools/invocations",
        headers: { authorization: `Bearer ${READ_ONLY_RAW_KEY}` },
        payload: {
          runId,
          type: "fetch",
          target: { placement: "hosted" },
          input: { url: "https://example.com", method: "GET" }
        }
      });
      expect(writeRequiresScope.statusCode).toBe(403);
      expect(writeRequiresScope.json().error.details?.some((detail: { issue?: string }) => detail.issue === "missing_scope")).toBe(true);

      const postApprovalsMissing = await app.inject({
        method: "POST",
        url: "/approvals",
        headers: { authorization: `Bearer ${ADMIN_RAW_KEY}` },
        payload: {}
      });
      expect(postApprovalsMissing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("reports readiness checks.tools with disabled-ready and enabled-fail-closed states", async () => {
    const disabledApp = await createServerApp(loadServerConfig(createEnv()));
    try {
      const ready = await disabledApp.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json().checks.tools).toBeDefined();
      expect(ready.json().checks.tools.ok).toBe(true);
    } finally {
      await disabledApp.close();
    }

    const enabledMissingPolicyApp = await createServerApp(loadServerConfig(createEnv({
      SWITCHYARD_HOSTED_REAL_TOOLS: "enabled"
    })));
    try {
      const ready = await enabledMissingPolicyApp.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(503);
      expect(ready.json().checks.tools.ok).toBe(false);
    } finally {
      await enabledMissingPolicyApp.close();
    }
  });
});
