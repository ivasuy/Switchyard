import { describe, expect, it } from "vitest";
import { hashApiKey } from "@switchyard/core";
import { MemoryRunQueue } from "@switchyard/queue";
import { createServerApp } from "../src/app.js";
import { loadServerConfig } from "../src/config.js";

const NOW = "2026-06-01T00:00:00.000Z";
const API_KEY_PEPPER = "pepper_for_hosted_tools_tests_123456";
const ADMIN_RAW_KEY = "sk_sw_tools_admin";
const READ_ONLY_RAW_KEY = "sk_sw_tools_read";
const WRITE_ONLY_RAW_KEY = "sk_sw_tools_write";
const ADMIN_T2_RAW_KEY = "sk_sw_tools_admin_t2";

function createBootstrapJson(includeSecondTenant = false): string {
  const accounts: Array<Record<string, unknown>> = [
    { id: "account_1", name: "Acme", status: "active", billingPlanId: "billing_plan_1", createdAt: NOW }
  ];
  const tenants: Array<Record<string, unknown>> = [
    { id: "tenant_1", accountId: "account_1", slug: "acme", displayName: "Acme", status: "active", createdAt: NOW }
  ];
  const projects: Array<Record<string, unknown>> = [
    { id: "project_1", accountId: "account_1", tenantId: "tenant_1", slug: "proj", displayName: "Project", status: "active", createdAt: NOW }
  ];
  const users: Array<Record<string, unknown>> = [
    { id: "user_1", accountId: "account_1", tenantId: "tenant_1", displayName: "Owner", email: "owner@example.com", status: "active", createdAt: NOW }
  ];
  const apiKeys: Array<Record<string, unknown>> = [
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
  ];

  if (includeSecondTenant) {
    accounts.push({ id: "account_2", name: "Globex", status: "active", billingPlanId: "billing_plan_1", createdAt: NOW });
    tenants.push({ id: "tenant_2", accountId: "account_2", slug: "globex", displayName: "Globex", status: "active", createdAt: NOW });
    projects.push({ id: "project_2", accountId: "account_2", tenantId: "tenant_2", slug: "proj2", displayName: "Project 2", status: "active", createdAt: NOW });
    users.push({ id: "user_2", accountId: "account_2", tenantId: "tenant_2", displayName: "Owner2", email: "owner2@example.com", status: "active", createdAt: NOW });
    apiKeys.push({
      id: "api_key_admin_t2",
      accountId: "account_2",
      tenantId: "tenant_2",
      projectId: "project_2",
      userId: "user_2",
      name: "admin-t2",
      keyPrefix: "sk_sw",
      secretHash: hashApiKey(ADMIN_T2_RAW_KEY, API_KEY_PEPPER),
      scopes: ["runs:write", "runs:read", "tools:write", "tools:read", "registry:read", "artifacts:read", "nodes:write", "metrics:read", "admin:read"],
      status: "active",
      createdAt: NOW
    });
  }

  return JSON.stringify({
    accounts,
    tenants,
    projects,
    users,
    apiKeys,
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

function createHostedPolicyJson(): string {
  return JSON.stringify({
    global: {
      enabled: true,
      allowedPlacements: ["hosted"],
      approvalDefault: "required",
      approvalExpiresMs: 300000
    },
    hosted: {
      enabled: true,
      allowedToolTypes: ["fetch"]
    },
    fetch: {
      enabled: true,
      allowedHosts: ["example.com"],
      allowedMethods: ["GET", "HEAD"],
      allowWithoutApproval: false
    }
  });
}

function createEnv(overrides: Record<string, string> = {}, includeSecondTenant = false): Record<string, string> {
  return {
    SWITCHYARD_DEPLOYMENT_MODE: "test",
    SWITCHYARD_OBJECT_STORE_BACKEND: "memory",
    SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic",
    SWITCHYARD_SERVER_AUTH_MODE: "api_key",
    SWITCHYARD_API_KEY_PEPPER: API_KEY_PEPPER,
    SWITCHYARD_CONTROL_PLANE_STORE: "memory",
    SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_JSON: createBootstrapJson(includeSecondTenant),
    ...overrides
  };
}

async function createHostedRun(app: Awaited<ReturnType<typeof createServerApp>>, apiKey: string, task: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/runs",
    headers: { authorization: `Bearer ${apiKey}` },
    payload: {
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task,
      placement: "hosted"
    }
  });
  expect([201, 202]).toContain(response.statusCode);
  return response.json().run.id as string;
}

async function createFetchInvocation(
  app: Awaited<ReturnType<typeof createServerApp>>,
  apiKey: string,
  runId: string,
  url: string
): Promise<{ invocationId: string; approvalId: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/tools/invocations",
    headers: { authorization: `Bearer ${apiKey}` },
    payload: {
      runId,
      type: "fetch",
      target: { placement: "hosted" },
      input: { url, method: "GET" }
    }
  });
  expect(response.statusCode).toBe(202);
  const body = response.json() as {
    invocation: { id: string };
    approval?: { id: string };
  };
  expect(body.approval?.id).toBeTruthy();
  return { invocationId: body.invocation.id, approvalId: body.approval!.id };
}

describe("hosted tools", () => {
  it("keeps checks.tools ready when tools are enabled and dispatches approvals into enqueueTool", async () => {
    const observedEnqueuePayloads: Array<{
      approvalId: string;
      toolInvocationId: string;
      runId: string;
      idempotencyKey: string;
      placement: string;
    }> = [];
    const originalEnqueueTool = MemoryRunQueue.prototype.enqueueTool;
    MemoryRunQueue.prototype.enqueueTool = async function patched(payload, options) {
      observedEnqueuePayloads.push({
        approvalId: payload.approvalId,
        toolInvocationId: payload.toolInvocationId,
        runId: payload.runId,
        idempotencyKey: payload.idempotencyKey,
        placement: payload.placement
      });
      return originalEnqueueTool.call(this, payload, options);
    };

    const app = await createServerApp(loadServerConfig(createEnv({
      SWITCHYARD_HOSTED_REAL_TOOLS: "enabled",
      SWITCHYARD_REAL_TOOL_POLICY_JSON: createHostedPolicyJson()
    })));
    try {
      const ready = await app.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json().checks.tools.ok).toBe(true);

      const runId = await createHostedRun(app, ADMIN_RAW_KEY, "enqueue dispatch");
      const { approvalId, invocationId } = await createFetchInvocation(app, ADMIN_RAW_KEY, runId, "https://example.com/resource-1");

      const approveFirst = await app.inject({
        method: "POST",
        url: `/approvals/${approvalId}/approve`,
        headers: { authorization: `Bearer ${ADMIN_RAW_KEY}` },
        payload: {}
      });
      if (approveFirst.statusCode !== 200) {
        throw new Error(`expected approve status 200, got ${approveFirst.statusCode}: ${approveFirst.body}`);
      }

      const approveSecond = await app.inject({
        method: "POST",
        url: `/approvals/${approvalId}/approve`,
        headers: { authorization: `Bearer ${ADMIN_RAW_KEY}` },
        payload: {}
      });
      expect(approveSecond.statusCode).toBe(409);
      expect(approveSecond.json().error.code).toBe("approval_not_pending");

      expect(observedEnqueuePayloads).toHaveLength(1);
      expect(observedEnqueuePayloads[0]).toMatchObject({
        approvalId,
        toolInvocationId: invocationId,
        runId,
        placement: "hosted"
      });
      expect(observedEnqueuePayloads[0]?.idempotencyKey.length).toBeGreaterThan(0);
    } finally {
      MemoryRunQueue.prototype.enqueueTool = originalEnqueueTool;
      await app.close();
    }
  });

  it("enforces tools scopes for approval read routes and does not expose hosted POST /approvals", async () => {
    const app = await createServerApp(loadServerConfig(createEnv({
      SWITCHYARD_HOSTED_REAL_TOOLS: "enabled",
      SWITCHYARD_REAL_TOOL_POLICY_JSON: createHostedPolicyJson()
    })));
    try {
      const runId = await createHostedRun(app, ADMIN_RAW_KEY, "scope enforcement");
      const { approvalId } = await createFetchInvocation(app, ADMIN_RAW_KEY, runId, "https://example.com/resource-scope");

      const listDenied = await app.inject({
        method: "GET",
        url: "/approvals",
        headers: { authorization: `Bearer ${WRITE_ONLY_RAW_KEY}` }
      });
      expect(listDenied.statusCode).toBe(403);
      expect(listDenied.json().error.details?.some((detail: { issue?: string }) => detail.issue === "missing_scope")).toBe(true);

      const getDenied = await app.inject({
        method: "GET",
        url: `/approvals/${approvalId}`,
        headers: { authorization: `Bearer ${WRITE_ONLY_RAW_KEY}` }
      });
      expect(getDenied.statusCode).toBe(403);
      expect(getDenied.json().error.details?.some((detail: { issue?: string }) => detail.issue === "missing_scope")).toBe(true);

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

  it("paginates owned approvals, prevents cross-tenant leaks, and terminalizes rejected invocations", async () => {
    const app = await createServerApp(loadServerConfig(createEnv({
      SWITCHYARD_HOSTED_REAL_TOOLS: "enabled",
      SWITCHYARD_REAL_TOOL_POLICY_JSON: createHostedPolicyJson()
    }, true)));
    try {
      const runA = await createHostedRun(app, ADMIN_RAW_KEY, "tenant-a-run");
      const a1 = await createFetchInvocation(app, ADMIN_RAW_KEY, runA, "https://example.com/a-1");
      const a2 = await createFetchInvocation(app, ADMIN_RAW_KEY, runA, "https://example.com/a-2");

      const runB = await createHostedRun(app, ADMIN_T2_RAW_KEY, "tenant-b-run");
      const b1 = await createFetchInvocation(app, ADMIN_T2_RAW_KEY, runB, "https://example.com/b-1");

      const firstPage = await app.inject({
        method: "GET",
        url: "/approvals?limit=1",
        headers: { authorization: `Bearer ${ADMIN_RAW_KEY}` }
      });
      expect(firstPage.statusCode).toBe(200);
      expect(firstPage.json().approvals).toHaveLength(1);
      expect(typeof firstPage.json().nextCursor).toBe("string");
      const firstApprovalId = firstPage.json().approvals[0].id as string;

      const secondPage = await app.inject({
        method: "GET",
        url: `/approvals?limit=1&before=${encodeURIComponent(firstPage.json().nextCursor)}`,
        headers: { authorization: `Bearer ${ADMIN_RAW_KEY}` }
      });
      expect(secondPage.statusCode).toBe(200);
      expect(secondPage.json().approvals).toHaveLength(1);
      const secondApprovalId = secondPage.json().approvals[0].id as string;

      const ownedIds = new Set([a1.approvalId, a2.approvalId]);
      expect(ownedIds.has(firstApprovalId)).toBe(true);
      expect(ownedIds.has(secondApprovalId)).toBe(true);
      expect(firstApprovalId).not.toBe(secondApprovalId);

      const hiddenApproval = await app.inject({
        method: "GET",
        url: `/approvals/${b1.approvalId}`,
        headers: { authorization: `Bearer ${ADMIN_RAW_KEY}` }
      });
      expect([403, 404]).toContain(hiddenApproval.statusCode);

      const hiddenInvocation = await app.inject({
        method: "GET",
        url: `/tools/invocations/${b1.invocationId}`,
        headers: { authorization: `Bearer ${ADMIN_RAW_KEY}` }
      });
      expect([403, 404]).toContain(hiddenInvocation.statusCode);

      const reject = await app.inject({
        method: "POST",
        url: `/approvals/${a1.approvalId}/reject`,
        headers: { authorization: `Bearer ${ADMIN_RAW_KEY}` },
        payload: {}
      });
      expect(reject.statusCode).toBe(200);
      expect(reject.json().approval.status).toBe("rejected");
      expect(reject.json().invocation.status).toBe("denied");

      const invocationAfterReject = await app.inject({
        method: "GET",
        url: `/tools/invocations/${a1.invocationId}`,
        headers: { authorization: `Bearer ${ADMIN_RAW_KEY}` }
      });
      expect(invocationAfterReject.statusCode).toBe(200);
      expect(invocationAfterReject.json().invocation.status).toBe("denied");
      expect(invocationAfterReject.json().invocation.error.code).toBe("tool_approval_rejected");
    } finally {
      await app.close();
    }
  });
});
