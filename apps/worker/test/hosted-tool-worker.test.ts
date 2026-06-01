import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  hashExecutionPlan,
  LocalPolicyGate,
  resolveHostedSandboxConfig,
  type ResolvedRealToolPolicyConfig
} from "@switchyard/core";
import { MemoryRunQueue } from "@switchyard/queue";
import { resolveObjectStoreConfig } from "@switchyard/storage";
import {
  InMemoryApprovalStore,
  InMemoryEventStore,
  InMemoryRunStore,
  InMemoryToolInvocationStore
} from "@switchyard/testkit";
import type { WorkerConfig } from "../src/config.js";
import { createHostedWorker } from "../src/worker.js";

describe("hosted tool worker", () => {
  it("processes an approved hosted fetch tool job and emits one terminal result", async () => {
    const queue = new MemoryRunQueue({ now: () => "2026-06-01T00:00:00.000Z", leaseMs: 1000 });
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const approvals = new InMemoryApprovalStore();
    const invocations = new InMemoryToolInvocationStore();
    const policy = basePolicy();

    const runId = "run_tool_fetch_1";
    await runs.create({
      id: runId,
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "do",
      status: "queued",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "fake.deterministic",
      createdAt: "2026-06-01T00:00:00.000Z"
    });

    const gate = new LocalPolicyGate(policy);
    const request = { url: "https://example.com/health", method: "GET", captureContent: false };
    const decision = await gate.decideTool({ type: "fetch", input: request, runApprovalPolicy: "default", placement: "hosted" } as never);
    if (decision.decision === "deny") {
      throw new Error("expected allow/approval_required decision");
    }
    const executionPlanHash = hashExecutionPlan(decision.executionPlan);

    await invocations.create({
      id: "tool_fetch_1",
      runId,
      type: "fetch",
      status: "queued",
      approvalId: "approval_fetch_1",
      input: {
        request,
        executionPlan: decision.executionPlan,
        executionPlanHash,
        target: { placement: "hosted" }
      },
      createdAt: "2026-06-01T00:00:00.000Z"
    });

    await approvals.create({
      id: "approval_fetch_1",
      runId,
      approvalType: "before_external_web_action",
      status: "approved",
      payload: {
        toolInvocationId: "tool_fetch_1",
        executionPlanHash
      },
      createdAt: "2026-06-01T00:00:00.000Z"
    });

    await queue.enqueueTool({
      approvalId: "approval_fetch_1",
      toolInvocationId: "tool_fetch_1",
      runId,
      placement: "hosted",
      toolType: "fetch",
      executionPlanHash,
      idempotencyKey: "dispatch_tool_fetch_1"
    });

    const worker = createHostedWorker(baseConfig(policy), {
      queue,
      runs,
      events,
      approvals,
      invocations
    });

    try {
      const worked = await worker.tick();
      expect(worked).toBe(true);

      const invocation = await invocations.get("tool_fetch_1");
      expect(invocation?.status).toBe("completed");
      const runEvents = await events.listByRun(runId);
      expect(runEvents.filter((event) => event.type === "tool.call")).toHaveLength(1);
      expect(runEvents.filter((event) => event.type === "tool.result")).toHaveLength(1);
    } finally {
      await worker.stop();
    }
  });

  it("denies hosted repo jobs before adapter invocation", async () => {
    const queue = new MemoryRunQueue({ now: () => "2026-06-01T00:00:00.000Z", leaseMs: 1000 });
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const approvals = new InMemoryApprovalStore();
    const invocations = new InMemoryToolInvocationStore();
    const policy = basePolicy();

    const runId = "run_tool_repo_1";
    await runs.create({
      id: runId,
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "do",
      status: "queued",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "fake.deterministic",
      createdAt: "2026-06-01T00:00:00.000Z"
    });

    await invocations.create({
      id: "tool_repo_1",
      runId,
      type: "repo",
      status: "queued",
      approvalId: "approval_repo_1",
      input: {
        request: { operation: "status", cwd: "/repo" },
        executionPlanHash: "repo_hash",
        target: { placement: "hosted" }
      },
      createdAt: "2026-06-01T00:00:00.000Z"
    });
    await approvals.create({
      id: "approval_repo_1",
      runId,
      approvalType: "before_local_process_execution",
      status: "approved",
      payload: { toolInvocationId: "tool_repo_1", executionPlanHash: "repo_hash" },
      createdAt: "2026-06-01T00:00:00.000Z"
    });
    await queue.enqueueTool({
      approvalId: "approval_repo_1",
      toolInvocationId: "tool_repo_1",
      runId,
      placement: "hosted",
      toolType: "repo",
      executionPlanHash: "repo_hash",
      idempotencyKey: "dispatch_tool_repo_1"
    });

    const worker = createHostedWorker(baseConfig(policy), {
      queue,
      runs,
      events,
      approvals,
      invocations
    });
    try {
      const worked = await worker.tick();
      expect(worked).toBe(true);
      const invocation = await invocations.get("tool_repo_1");
      expect(invocation?.status).toBe("denied");
      expect(invocation?.error?.code).toBe("repo_hosted_unshipped");
    } finally {
      await worker.stop();
    }
  });

  it("terminalizes exhausted tool claims with tool_dispatch_retry_exhausted", async () => {
    let nowIso = "2026-06-01T00:00:00.000Z";
    const queue = new MemoryRunQueue({ now: () => nowIso, leaseMs: 1000 });
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const approvals = new InMemoryApprovalStore();
    const invocations = new InMemoryToolInvocationStore();
    const policy = basePolicy();
    const runId = "run_tool_retry_1";

    await runs.create({
      id: runId,
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "do",
      status: "queued",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "fake.deterministic",
      createdAt: "2026-06-01T00:00:00.000Z"
    });
    await invocations.create({
      id: "tool_retry_1",
      runId,
      type: "fetch",
      status: "queued",
      approvalId: "approval_retry_1",
      input: { request: { url: "https://example.com/health", method: "GET" }, executionPlanHash: "hash_retry", target: { placement: "hosted" } },
      createdAt: "2026-06-01T00:00:00.000Z"
    });
    await approvals.create({
      id: "approval_retry_1",
      runId,
      approvalType: "before_external_web_action",
      status: "approved",
      payload: { toolInvocationId: "tool_retry_1", executionPlanHash: "hash_retry" },
      createdAt: "2026-06-01T00:00:00.000Z"
    });

    const enqueued = await queue.enqueueTool({
      approvalId: "approval_retry_1",
      toolInvocationId: "tool_retry_1",
      runId,
      placement: "hosted",
      toolType: "fetch",
      executionPlanHash: "hash_retry",
      idempotencyKey: "dispatch_tool_retry_1"
    }, { maxAttempts: 1 });
    await queue.claimTool();
    nowIso = "2026-06-01T00:00:02.000Z";

    const worker = createHostedWorker(baseConfig(policy), {
      queue,
      runs,
      events,
      approvals,
      invocations
    });
    try {
      const worked = await worker.tick();
      expect(worked).toBe(false);
      const invocation = await invocations.get("tool_retry_1");
      expect(invocation?.status).toBe("failed");
      expect(invocation?.error?.code).toBe("tool_dispatch_retry_exhausted");
      const exhausted = await queue.getToolJob(enqueued.jobId);
      expect(exhausted?.state).toBe("exhausted");
    } finally {
      await worker.stop();
    }
  });

  it("keeps non-hosted running invocation active during restart reconciliation", async () => {
    const queue = new MemoryRunQueue({ now: () => "2026-06-01T00:00:00.000Z", leaseMs: 1000 });
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const approvals = new InMemoryApprovalStore();
    const invocations = new InMemoryToolInvocationStore();
    const runId = "run_non_hosted_running_1";

    await runs.create({
      id: runId,
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "do",
      status: "queued",
      placement: "connected_local_node",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "fake.deterministic",
      createdAt: "2026-06-01T00:00:00.000Z"
    });
    await invocations.create({
      id: "tool_non_hosted_running_1",
      runId,
      type: "fetch",
      status: "running",
      approvalId: "approval_non_hosted_running_1",
      input: {
        request: { url: "https://example.com/health", method: "GET" },
        target: { placement: "connected_local_node" }
      },
      createdAt: "2026-06-01T00:00:00.000Z"
    });

    const worker = createHostedWorker(baseConfig(basePolicy()), {
      queue,
      runs,
      events,
      approvals,
      invocations
    });
    try {
      await worker.tick();
      const invocation = await invocations.get("tool_non_hosted_running_1");
      expect(invocation?.status).toBe("running");
      expect(invocation?.error).toBeUndefined();
    } finally {
      await worker.stop();
    }
  });

  it("does not mark hosted running invocation as restarted when matching claimed job is live", async () => {
    const queue = new MemoryRunQueue({ now: () => "2026-06-01T00:00:00.000Z", leaseMs: 60_000 });
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const approvals = new InMemoryApprovalStore();
    const invocations = new InMemoryToolInvocationStore();
    const runId = "run_hosted_running_1";

    await runs.create({
      id: runId,
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "do",
      status: "queued",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "fake.deterministic",
      createdAt: "2026-06-01T00:00:00.000Z"
    });
    await invocations.create({
      id: "tool_hosted_running_1",
      runId,
      type: "fetch",
      status: "running",
      approvalId: "approval_hosted_running_1",
      input: {
        request: { url: "https://example.com/health", method: "GET" },
        target: { placement: "hosted" }
      },
      createdAt: "2026-06-01T00:00:00.000Z"
    });

    await queue.enqueueTool({
      approvalId: "approval_hosted_running_1",
      toolInvocationId: "tool_hosted_running_1",
      runId,
      placement: "hosted",
      toolType: "fetch",
      executionPlanHash: "hash_hosted_running_1",
      idempotencyKey: "dispatch_hosted_running_1"
    });
    await queue.claimTool();
    (queue as unknown as { hasLiveToolClaim?: (toolInvocationId: string) => Promise<boolean> }).hasLiveToolClaim = async (toolInvocationId) => {
      return toolInvocationId === "tool_hosted_running_1";
    };

    const worker = createHostedWorker(baseConfig(basePolicy()), {
      queue,
      runs,
      events,
      approvals,
      invocations
    });
    try {
      await worker.tick();
      const invocation = await invocations.get("tool_hosted_running_1");
      expect(invocation?.status).toBe("running");
      expect(invocation?.error).toBeUndefined();
    } finally {
      await worker.stop();
    }
  });

  it("stores artifact then attaches ownership then consumes quota", async () => {
    const queue = new MemoryRunQueue({ now: () => "2026-06-01T00:00:00.000Z", leaseMs: 1000 });
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const approvals = new InMemoryApprovalStore();
    const invocations = new InMemoryToolInvocationStore();
    const policy = basePolicy();
    const runId = "run_tool_artifact_success_1";
    const steps: string[] = [];
    const ownershipCalls: Array<Record<string, unknown>> = [];
    const quotaCalls: Array<Record<string, unknown>> = [];

    await runs.create({
      id: runId,
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "do",
      status: "queued",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "fake.deterministic",
      createdAt: "2026-06-01T00:00:00.000Z"
    });

    const gate = new LocalPolicyGate(policy);
    const request = { url: "https://example.com/health", method: "GET", captureContent: true };
    const decision = await gate.decideTool({ type: "fetch", input: request, runApprovalPolicy: "default", placement: "hosted" } as never);
    if (decision.decision === "deny") {
      throw new Error("expected allow/approval_required decision");
    }
    const executionPlanHash = hashExecutionPlan(decision.executionPlan);

    await invocations.create({
      id: "tool_artifact_success_1",
      runId,
      type: "fetch",
      status: "queued",
      approvalId: "approval_artifact_success_1",
      input: {
        request,
        executionPlan: decision.executionPlan,
        executionPlanHash,
        target: { placement: "hosted" }
      },
      createdAt: "2026-06-01T00:00:00.000Z"
    });
    await approvals.create({
      id: "approval_artifact_success_1",
      runId,
      approvalType: "before_external_web_action",
      status: "approved",
      payload: { toolInvocationId: "tool_artifact_success_1", executionPlanHash },
      createdAt: "2026-06-01T00:00:00.000Z"
    });
    await queue.enqueueTool({
      approvalId: "approval_artifact_success_1",
      toolInvocationId: "tool_artifact_success_1",
      runId,
      placement: "hosted",
      toolType: "fetch",
      executionPlanHash,
      idempotencyKey: "dispatch_tool_artifact_success_1"
    });

    const worker = createHostedWorker(baseConfig(policy), {
      queue,
      runs,
      events,
      approvals,
      invocations,
      artifactContent: {
        probe: async () => ({ ok: true }),
        writeText: async (path, text, options) => {
          steps.push("store");
          return {
            path,
            storageBackend: "memory",
            sizeBytes: Buffer.byteLength(text, "utf8"),
            sha256: createHash("sha256").update(text, "utf8").digest("hex"),
            contentType: options?.contentType ?? "text/plain"
          };
        },
        writeBytes: async () => {
          throw new Error("write_bytes_not_expected");
        },
        read: async () => ({ body: Buffer.from(""), contentType: "text/plain" })
      },
      attachArtifactOwnership: async (input) => {
        steps.push("own");
        ownershipCalls.push(input as unknown as Record<string, unknown>);
      },
      consumeToolArtifactBytesQuota: async (input) => {
        steps.push("quota");
        quotaCalls.push(input as unknown as Record<string, unknown>);
      }
    });

    try {
      const worked = await worker.tick();
      expect(worked).toBe(true);
      const invocation = await invocations.get("tool_artifact_success_1");
      expect(invocation?.status).toBe("completed");
      expect(Array.isArray(invocation?.output?.["artifactIds"])).toBe(true);
      expect(ownershipCalls).toHaveLength(1);
      expect(quotaCalls).toHaveLength(1);
      expect(steps).toEqual(["store", "own", "quota"]);
    } finally {
      await worker.stop();
    }
  });

  it("does not consume artifact-byte quota when ownership attach fails", async () => {
    const queue = new MemoryRunQueue({ now: () => "2026-06-01T00:00:00.000Z", leaseMs: 1000 });
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const approvals = new InMemoryApprovalStore();
    const invocations = new InMemoryToolInvocationStore();
    const policy = basePolicy();
    const runId = "run_tool_artifact_ownership_fail_1";
    const quotaCalls: Array<Record<string, unknown>> = [];

    await runs.create({
      id: runId,
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "do",
      status: "queued",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "fake.deterministic",
      createdAt: "2026-06-01T00:00:00.000Z"
    });

    const gate = new LocalPolicyGate(policy);
    const request = { url: "https://example.com/health", method: "GET", captureContent: true };
    const decision = await gate.decideTool({ type: "fetch", input: request, runApprovalPolicy: "default", placement: "hosted" } as never);
    if (decision.decision === "deny") {
      throw new Error("expected allow/approval_required decision");
    }
    const executionPlanHash = hashExecutionPlan(decision.executionPlan);

    await invocations.create({
      id: "tool_artifact_ownership_fail_1",
      runId,
      type: "fetch",
      status: "queued",
      approvalId: "approval_artifact_ownership_fail_1",
      input: {
        request,
        executionPlan: decision.executionPlan,
        executionPlanHash,
        target: { placement: "hosted" }
      },
      createdAt: "2026-06-01T00:00:00.000Z"
    });
    await approvals.create({
      id: "approval_artifact_ownership_fail_1",
      runId,
      approvalType: "before_external_web_action",
      status: "approved",
      payload: { toolInvocationId: "tool_artifact_ownership_fail_1", executionPlanHash },
      createdAt: "2026-06-01T00:00:00.000Z"
    });
    await queue.enqueueTool({
      approvalId: "approval_artifact_ownership_fail_1",
      toolInvocationId: "tool_artifact_ownership_fail_1",
      runId,
      placement: "hosted",
      toolType: "fetch",
      executionPlanHash,
      idempotencyKey: "dispatch_tool_artifact_ownership_fail_1"
    });

    const worker = createHostedWorker(baseConfig(policy), {
      queue,
      runs,
      events,
      approvals,
      invocations,
      artifactContent: {
        probe: async () => ({ ok: true }),
        writeText: async (path, text, options) => ({
          path,
          storageBackend: "memory",
          sizeBytes: Buffer.byteLength(text, "utf8"),
          sha256: createHash("sha256").update(text, "utf8").digest("hex"),
          contentType: options?.contentType ?? "text/plain"
        }),
        writeBytes: async () => {
          throw new Error("write_bytes_not_expected");
        },
        read: async () => ({ body: Buffer.from(""), contentType: "text/plain" })
      },
      attachArtifactOwnership: async () => {
        const error = new Error("ownership_attach_failed");
        (error as Error & { reasonCode: string }).reasonCode = "ownership_attach_failed";
        throw error;
      },
      consumeToolArtifactBytesQuota: async (input) => {
        quotaCalls.push(input as unknown as Record<string, unknown>);
      }
    });

    try {
      const worked = await worker.tick();
      expect(worked).toBe(true);
      const invocation = await invocations.get("tool_artifact_ownership_fail_1");
      expect(invocation?.status).toBe("failed");
      expect(invocation?.error?.code).toBe("ownership_attach_failed");
      expect(quotaCalls).toHaveLength(0);
    } finally {
      await worker.stop();
    }
  });

  it("wires ownership and quota via control-plane defaults when hooks are not injected", async () => {
    const queue = new MemoryRunQueue({ now: () => "2026-06-01T00:00:00.000Z", leaseMs: 1000 });
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const approvals = new InMemoryApprovalStore();
    const invocations = new InMemoryToolInvocationStore();
    const policy = basePolicy();
    const runId = "run_tool_control_plane_defaults_1";
    const ownershipCalls: Array<Record<string, unknown>> = [];
    const quotaCalls: Array<Record<string, unknown>> = [];

    await runs.create({
      id: runId,
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "do",
      status: "queued",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "fake.deterministic",
      createdAt: "2026-06-01T00:00:00.000Z"
    });

    const gate = new LocalPolicyGate(policy);
    const request = { url: "https://example.com/health", method: "GET", captureContent: true };
    const decision = await gate.decideTool({ type: "fetch", input: request, runApprovalPolicy: "default", placement: "hosted" } as never);
    if (decision.decision === "deny") {
      throw new Error("expected allow/approval_required decision");
    }
    const executionPlanHash = hashExecutionPlan(decision.executionPlan);

    await invocations.create({
      id: "tool_control_plane_defaults_1",
      runId,
      type: "fetch",
      status: "queued",
      approvalId: "approval_control_plane_defaults_1",
      input: {
        request,
        executionPlan: decision.executionPlan,
        executionPlanHash,
        target: { placement: "hosted" }
      },
      createdAt: "2026-06-01T00:00:00.000Z"
    });
    await approvals.create({
      id: "approval_control_plane_defaults_1",
      runId,
      approvalType: "before_external_web_action",
      status: "approved",
      payload: { toolInvocationId: "tool_control_plane_defaults_1", executionPlanHash },
      createdAt: "2026-06-01T00:00:00.000Z"
    });
    await queue.enqueueTool({
      approvalId: "approval_control_plane_defaults_1",
      toolInvocationId: "tool_control_plane_defaults_1",
      runId,
      placement: "hosted",
      toolType: "fetch",
      executionPlanHash,
      idempotencyKey: "dispatch_tool_control_plane_defaults_1"
    });

    const controlPlaneStore = {
      getOwnership: async (input: { resourceType: string; resourceId: string }) => {
        if (input.resourceType === "run" && input.resourceId === runId) {
          return {
            resourceType: "run",
            resourceId: runId,
            accountId: "account_1",
            tenantId: "tenant_1",
            projectId: "project_1",
            userId: "user_1",
            apiKeyId: "api_key_1",
            createdAt: "2026-06-01T00:00:00.000Z"
          };
        }
        return null;
      },
      attachOwnership: async (input: Record<string, unknown>) => {
        ownershipCalls.push(input);
        return {
          resourceType: String(input["resourceType"]),
          resourceId: String(input["resourceId"]),
          accountId: String(input["accountId"]),
          tenantId: String(input["tenantId"]),
          projectId: String(input["projectId"]),
          userId: String(input["userId"]),
          apiKeyId: String(input["apiKeyId"]),
          createdAt: "2026-06-01T00:00:00.000Z"
        };
      },
      reserveQuota: async (input: Record<string, unknown>) => {
        quotaCalls.push(input);
        return {
          id: "quota_reservation_1",
          accountId: String(input["accountId"]),
          tenantId: String(input["tenantId"]),
          projectId: String(input["projectId"]),
          quotaKind: "tool_artifact_bytes_per_hour",
          amount: Number(input["amount"]),
          state: "reserved",
          reasonCode: "tool_artifact_store",
          createdAt: "2026-06-01T00:00:00.000Z",
          expiresAt: "2026-06-01T00:01:00.000Z"
        };
      }
    } as unknown;

    const worker = createHostedWorker(baseConfig(policy), {
      queue,
      runs,
      events,
      approvals,
      invocations,
      artifactContent: {
        probe: async () => ({ ok: true }),
        writeText: async (path, text, options) => ({
          path,
          storageBackend: "memory",
          sizeBytes: Buffer.byteLength(text, "utf8"),
          sha256: createHash("sha256").update(text, "utf8").digest("hex"),
          contentType: options?.contentType ?? "text/plain"
        }),
        writeBytes: async () => {
          throw new Error("write_bytes_not_expected");
        },
        read: async () => ({ body: Buffer.from(""), contentType: "text/plain" })
      },
      controlPlaneStore: controlPlaneStore as never
    });

    try {
      const worked = await worker.tick();
      expect(worked).toBe(true);
      const invocation = await invocations.get("tool_control_plane_defaults_1");
      expect(invocation?.status).toBe("completed");
      expect(ownershipCalls).toHaveLength(1);
      expect(quotaCalls).toHaveLength(1);
    } finally {
      await worker.stop();
    }
  });

  it("emits low-cardinality logs and metrics for tool outcomes", async () => {
    const queue = new MemoryRunQueue({ now: () => "2026-06-01T00:00:00.000Z", leaseMs: 1000 });
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const approvals = new InMemoryApprovalStore();
    const invocations = new InMemoryToolInvocationStore();
    const policy = basePolicy();
    const logs: Array<{ level: string; event: string; details?: Record<string, unknown> }> = [];
    const metrics: Array<{ name: string; labels: Record<string, string> }> = [];
    const runId = "run_tool_metrics_1";

    await runs.create({
      id: runId,
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "do",
      status: "queued",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "fake.deterministic",
      createdAt: "2026-06-01T00:00:00.000Z"
    });

    const gate = new LocalPolicyGate(policy);
    const successRequest = { url: "https://example.com/health", method: "GET", captureContent: false };
    const successDecision = await gate.decideTool({ type: "fetch", input: successRequest, runApprovalPolicy: "default", placement: "hosted" } as never);
    if (successDecision.decision === "deny") {
      throw new Error("expected allow/approval_required decision");
    }
    const successHash = hashExecutionPlan(successDecision.executionPlan);
    await invocations.create({
      id: "tool_metrics_success_1",
      runId,
      type: "fetch",
      status: "queued",
      approvalId: "approval_metrics_success_1",
      input: {
        request: successRequest,
        executionPlan: successDecision.executionPlan,
        executionPlanHash: successHash,
        target: { placement: "hosted" }
      },
      createdAt: "2026-06-01T00:00:00.000Z"
    });
    await approvals.create({
      id: "approval_metrics_success_1",
      runId,
      approvalType: "before_external_web_action",
      status: "approved",
      payload: { toolInvocationId: "tool_metrics_success_1", executionPlanHash: successHash },
      createdAt: "2026-06-01T00:00:00.000Z"
    });
    await queue.enqueueTool({
      approvalId: "approval_metrics_success_1",
      toolInvocationId: "tool_metrics_success_1",
      runId,
      placement: "hosted",
      toolType: "fetch",
      executionPlanHash: successHash,
      idempotencyKey: "dispatch_tool_metrics_success_1"
    });

    await invocations.create({
      id: "tool_metrics_failure_1",
      runId,
      type: "fetch",
      status: "queued",
      approvalId: "approval_metrics_failure_1",
      input: {
        request: successRequest,
        executionPlan: successDecision.executionPlan,
        executionPlanHash: successHash,
        target: { placement: "hosted" }
      },
      createdAt: "2026-06-01T00:00:00.000Z"
    });
    await queue.enqueueTool({
      approvalId: "approval_metrics_failure_1",
      toolInvocationId: "tool_metrics_failure_1",
      runId,
      placement: "hosted",
      toolType: "fetch",
      executionPlanHash: successHash,
      idempotencyKey: "dispatch_tool_metrics_failure_1"
    });

    const worker = createHostedWorker(baseConfig(policy), {
      queue,
      runs,
      events,
      approvals,
      invocations,
      logger: {
        info: (event, details) => logs.push({ level: "info", event, details }),
        warn: (event, details) => logs.push({ level: "warn", event, details }),
        error: (event, details) => logs.push({ level: "error", event, details })
      },
      incrementToolMetric: (name, labels) => {
        metrics.push({ name, labels: { ...labels } });
      }
    });
    try {
      await worker.tick();
      await worker.tick();
      expect(logs.some((entry) => entry.event === "tool.job.claimed")).toBe(true);
      expect(logs.some((entry) => entry.event === "tool.job.revalidated")).toBe(true);
      expect(logs.some((entry) => entry.event === "tool.job.completed")).toBe(true);
      expect(logs.some((entry) => entry.event === "tool.job.failed")).toBe(true);
      expect(metrics.some((entry) => entry.name === "tool_job_claimed_total")).toBe(true);
      expect(metrics.some((entry) => entry.name === "tool_job_revalidated_total")).toBe(true);
      expect(metrics.some((entry) => entry.name === "tool_job_completed_total")).toBe(true);
      expect(metrics.some((entry) => entry.name === "tool_job_failed_total")).toBe(true);
    } finally {
      await worker.stop();
    }
  });
});

function basePolicy(): ResolvedRealToolPolicyConfig {
  return {
    global: {
      enabled: true,
      allowedPlacements: ["hosted"],
      approvalDefault: "allow",
      approvalExpiresMs: 300_000,
      maxConcurrentRealTools: 2,
      maxInputBytes: 65_536,
      maxInlineOutputBytes: 32_768,
      maxArtifactBytes: 1_048_576,
      defaultTimeoutMs: 30_000
    },
    hosted: {
      enabled: true,
      allowedToolTypes: ["fetch", "web_search", "github", "shell", "fake_echo"]
    },
    connectedLocalNode: {
      enabled: false,
      allowedToolTypes: []
    },
    fetch: {
      enabled: true,
      allowedHosts: ["example.com"],
      allowedMethods: ["GET", "HEAD"],
      allowedHeaders: [],
      allowedContentTypes: ["text/plain", "application/json"],
      maxRedirects: 2,
      timeoutMs: 2000,
      maxResponseBytes: 4096,
      allowWithoutApproval: true
    },
    webSearch: {
      enabled: true,
      providerId: "fake-search",
      baseUrl: "https://search.example/api",
      maxResults: 5,
      timeoutMs: 2000,
      maxResponseBytes: 4096,
      allowWithoutApproval: true
    },
    github: {
      enabled: true,
      token: "ghp_fake",
      allowedRepos: ["openai/codex"],
      timeoutMs: 2000,
      maxResponseBytes: 4096,
      allowWithoutApproval: true
    },
    repo: {
      enabled: false,
      gitBinary: "git",
      allowedCwdPrefixes: ["/repo"],
      maxPaths: 16,
      timeoutMs: 2000,
      maxOutputBytes: 4096
    },
    shell: {
      enabled: true,
      allowedCwdPrefixes: ["/repo"],
      timeoutMs: 2000,
      maxOutputBytes: 4096,
      catalog: {
        "safe.echo": {
          commandId: "safe.echo",
          executablePath: "/bin/echo",
          argv: [],
          allowedCwdPrefixes: ["/repo"],
          env: {},
          maxArgs: 4,
          allowWithoutApproval: true
        }
      }
    }
  };
}

function baseConfig(policy: ResolvedRealToolPolicyConfig): WorkerConfig {
  return {
    deploymentMode: "test",
    hostedRuntimeAllowlist: ["fake.deterministic"],
    hostedRealRuntimeExecution: "disabled",
    queueName: "switchyard-tool-worker-test",
    idleIntervalMs: 1,
    objectStore: resolveObjectStoreConfig({
      deploymentMode: "test",
      env: {
        SWITCHYARD_OBJECT_STORE_BACKEND: "memory"
      }
    }),
    sandbox: resolveHostedSandboxConfig({ deploymentMode: "test", env: {} }),
    claudeCode: {
      command: "claude",
      requestTimeoutMs: 5000,
      liveProbe: false,
      maxBudgetUsd: 0.05
    },
    opencode: {
      command: "opencode"
    },
    acp: {
      requestTimeoutMs: 5000,
      cancelTimeoutMs: 5000,
      maxMessageBytes: 1024 * 1024
    },
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
    tools: {
      hostedRealTools: "enabled",
      connectedNodeRealTools: "disabled",
      adapterMode: "fake",
      allowNoApprovalInTest: true,
      policySourceKind: "json",
      policy
    },
    redactedSummary: {}
  };
}
