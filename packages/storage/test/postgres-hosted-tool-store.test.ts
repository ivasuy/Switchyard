import { describe, expect, it } from "vitest";
import type { Approval, Assignment, ToolInvocation } from "@switchyard/contracts";
import type { PostgresDatabaseHandle } from "../src/postgres/database.js";
import {
  PostgresApprovalStore,
  PostgresAssignmentStore,
  PostgresControlPlaneStore,
  PostgresToolDispatchOutboxStore,
  PostgresToolInvocationStore
} from "../src/index.js";

function makeInvocation(input: {
  id: string;
  runId?: string;
  status: ToolInvocation["status"];
  approvalId?: string;
  createdAt: string;
}): ToolInvocation {
  return {
    id: input.id,
    runId: input.runId,
    type: "fetch",
    status: input.status,
    approvalId: input.approvalId,
    input: { request: { url: "https://example.com" } },
    createdAt: input.createdAt
  };
}

function makeApproval(input: {
  id: string;
  runId?: string;
  status: Approval["status"];
  createdAt: string;
  toolInvocationId?: string;
}): Approval {
  return {
    id: input.id,
    runId: input.runId,
    approvalType: "before_external_web_action",
    status: input.status,
    payload: input.toolInvocationId ? { toolInvocationId: input.toolInvocationId } : { reason: "manual" },
    createdAt: input.createdAt
  };
}

describe("postgres hosted tool stores", () => {
  it("supports invocation list/get/cas/listByApproval with stable pagination", async () => {
    const store = new PostgresToolInvocationStore();
    const first = await store.create(
      makeInvocation({
        id: "tool_invocation_b",
        runId: "run_1",
        status: "queued",
        approvalId: "approval_1",
        createdAt: "2026-06-01T10:00:00.000Z"
      })
    );
    const second = await store.create(
      makeInvocation({
        id: "tool_invocation_a",
        runId: "run_1",
        status: "queued",
        approvalId: "approval_1",
        createdAt: "2026-06-01T10:00:00.000Z"
      })
    );

    const page1 = await store.list({ runId: "run_1", status: "queued", limit: 1 });
    expect(page1.invocations.map((entry) => entry.id)).toEqual(["tool_invocation_b"]);
    expect(page1.nextCursor).toEqual({ createdAt: first.createdAt, id: first.id });

    const page2 = await store.list({ runId: "run_1", status: "queued", limit: 1, before: page1.nextCursor! });
    expect(page2.invocations.map((entry) => entry.id)).toEqual(["tool_invocation_a"]);

    const casMiss = await store.updateIfStatus(first.id, "running", { ...first, status: "completed" });
    expect(casMiss).toBeNull();

    const casHit = await store.updateIfStatus(first.id, "queued", { ...first, status: "running" });
    expect(casHit?.status).toBe("running");
    expect((await store.get(first.id))?.status).toBe("running");

    const byApproval = await store.listByApproval("approval_1");
    expect(byApproval.map((entry) => entry.id)).toEqual(["tool_invocation_b", "tool_invocation_a"]);
    expect(second.id).toBe("tool_invocation_a");
  });

  it("supports approval list/get/cas with tool invocation payload filtering and pagination", async () => {
    const store = new PostgresApprovalStore();
    const first = await store.create(
      makeApproval({
        id: "approval_b",
        runId: "run_1",
        status: "pending",
        createdAt: "2026-06-01T10:00:00.000Z",
        toolInvocationId: "tool_invocation_b"
      })
    );
    await store.create(
      makeApproval({
        id: "approval_a",
        runId: "run_1",
        status: "pending",
        createdAt: "2026-06-01T10:00:00.000Z",
        toolInvocationId: "tool_invocation_a"
      })
    );

    const page1 = await store.list({ runId: "run_1", status: "pending", toolInvocationId: "tool_invocation_b", limit: 1 });
    expect(page1.approvals.map((entry) => entry.id)).toEqual(["approval_b"]);
    expect(page1.nextCursor).toBeNull();

    const casMiss = await store.updateIfStatus(first.id, "approved", { ...first, status: "rejected" });
    expect(casMiss).toBeNull();

    const casHit = await store.updateIfStatus(first.id, "pending", { ...first, status: "approved" });
    expect(casHit?.status).toBe("approved");
  });

  it("keeps outbox idempotent by approvalId + toolInvocationId and supports retry", async () => {
    const outbox = new PostgresToolDispatchOutboxStore();
    const first = await outbox.upsertByApprovalAndInvocation({
      approvalId: "approval_1",
      toolInvocationId: "tool_invocation_1",
      runId: "run_1",
      targetPlacement: "hosted",
      executionPlanHash: "hash_1"
    });
    await outbox.markDispatching(first.id);
    await outbox.markFailedRetryable(first.id, "dispatch_timeout");

    const second = await outbox.upsertByApprovalAndInvocation({
      approvalId: "approval_1",
      toolInvocationId: "tool_invocation_1",
      runId: "run_1",
      targetPlacement: "hosted",
      executionPlanHash: "hash_1"
    });

    expect(second.id).toBe(first.id);
    expect(second.attemptCount).toBeGreaterThan(0);
    const retryable = await outbox.listRetryable(10);
    expect(retryable).toHaveLength(1);
    expect(retryable[0]?.approvalId).toBe("approval_1");
  });

  it("defaults pre-R22 assignment rows to run kind", async () => {
    const handle = {
      pool: {
        query: async () => ({
          rows: [
            {
              id: "assignment_1",
              run_id: "run_1",
              node_id: "node_1",
              status: "pending",
              retry_count: 0,
              last_event_sequence: 0,
              created_at: "2026-06-01T10:00:00.000Z"
            }
          ]
        })
      },
      db: {} as PostgresDatabaseHandle["db"],
      real: true as const,
      close: async () => {}
    } satisfies PostgresDatabaseHandle;

    const store = new PostgresAssignmentStore(handle);
    const assignment = await store.get("assignment_1");
    expect(assignment?.kind ?? "run").toBe("run");
    expect(assignment?.toolInvocationId).toBeUndefined();
  });

  it("reports unowned tool invocation and approval counts", async () => {
    const counts = new Map<string, number>([
      ["run", 0],
      ["run_event", 0],
      ["artifact", 0],
      ["placement_decision", 0],
      ["node", 0],
      ["assignment", 0],
      ["tool_invocation", 2],
      ["approval", 3],
      ["audit_log_event", 0],
      ["quota", 0]
    ]);

    const handle = {
      pool: {
        query: async (_sql: string, params?: ReadonlyArray<unknown>) => {
          const resourceType = String(params?.[0] ?? "");
          return { rows: [{ count: counts.get(resourceType) ?? 0 }] };
        }
      },
      db: {} as PostgresDatabaseHandle["db"],
      real: true as const,
      close: async () => {}
    } satisfies PostgresDatabaseHandle;

    const store = new PostgresControlPlaneStore(handle);
    const summary = await store.countUnownedResources();
    expect(summary.toolInvocations).toBe(2);
    expect(summary.approvals).toBe(3);
  });

  it("fails closed for legacy tool entitlements/quotas in production bootstrap", async () => {
    const priorMode = process.env["SWITCHYARD_DEPLOYMENT_MODE"];
    process.env["SWITCHYARD_DEPLOYMENT_MODE"] = "production";

    const store = new PostgresControlPlaneStore();
    const bootstrap = {
      accounts: [
        { id: "account_1", name: "Acme", status: "active", billingPlanId: "billing_plan_1", createdAt: "2026-06-01T10:00:00.000Z" }
      ],
      tenants: [
        { id: "tenant_1", accountId: "account_1", slug: "acme", displayName: "Acme", status: "active", createdAt: "2026-06-01T10:00:00.000Z" }
      ],
      projects: [
        {
          id: "project_1",
          accountId: "account_1",
          tenantId: "tenant_1",
          slug: "production",
          displayName: "Production",
          status: "active",
          createdAt: "2026-06-01T10:00:00.000Z"
        }
      ],
      users: [
        {
          id: "user_1",
          accountId: "account_1",
          tenantId: "tenant_1",
          displayName: "Owner",
          email: "owner@example.com",
          status: "active",
          createdAt: "2026-06-01T10:00:00.000Z"
        }
      ],
      apiKeys: [
        {
          id: "api_key_1",
          accountId: "account_1",
          tenantId: "tenant_1",
          projectId: "project_1",
          userId: "user_1",
          name: "primary",
          keyPrefix: "sk_sw",
          secretHash: "c".repeat(64),
          scopes: ["runs:read", "runs:write", "tools:read", "tools:write"],
          status: "active",
          createdAt: "2026-06-01T10:00:00.000Z"
        }
      ],
      billingPlans: [
        {
          id: "billing_plan_1",
          slug: "legacy_enterprise",
          displayName: "Legacy",
          status: "active",
          entitlements: {
            allowedPlacements: ["hosted"],
            allowedRuntimeModes: ["fake.deterministic"],
            allowHostedRealRuntime: false,
            allowConnectedNodes: true,
            allowArtifactContentRead: true,
            allowMetricsRead: false,
            allowAuditRead: true
          },
          quotas: {
            maxRunsPerHour: 5,
            maxActiveRuns: 1,
            maxRunTimeoutSeconds: 300,
            maxConnectedNodes: 1,
            maxArtifactContentReadBytesPerHour: 1024
          },
          createdAt: "2026-06-01T10:00:00.000Z"
        }
      ]
    };

    await expect(store.bootstrap(bootstrap)).rejects.toMatchObject({ code: "control_plane_bootstrap_malformed" });

    if (priorMode === undefined) {
      delete process.env["SWITCHYARD_DEPLOYMENT_MODE"];
    } else {
      process.env["SWITCHYARD_DEPLOYMENT_MODE"] = priorMode;
    }
  });
});
