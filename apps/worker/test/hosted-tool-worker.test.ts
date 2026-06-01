import { describe, expect, it } from "vitest";
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
