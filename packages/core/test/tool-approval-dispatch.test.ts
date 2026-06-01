import { describe, expect, it } from "vitest";
import type { Approval, Assignment, ConnectedNode, NodePolicy, Run, SwitchyardEvent, ToolInvocation } from "@switchyard/contracts";
import { LocalPolicyGate, createDisabledRealToolPolicyConfig } from "../src/services/local-policy-gate.js";
import { HostedToolService } from "../src/services/hosted-tool-service.js";
import { NodeCoordinatorService } from "../src/services/node-coordinator-service.js";
import type { ApprovalStore } from "../src/ports/approval-store.js";
import type { EventStore } from "../src/ports/event-store.js";
import type { NodeAssignmentStore } from "../src/ports/node-assignment-store.js";
import type { NodeStore } from "../src/ports/node-store.js";
import type { RunStore } from "../src/ports/run-store.js";
import type { ToolInvocationStore } from "../src/ports/tool-invocation-store.js";
import type { ToolDispatchOutboxRecord, ToolDispatchOutboxStore } from "../src/ports/tool-dispatch-outbox-store.js";

class MemoryRunStore implements RunStore {
  readonly items = new Map<string, Run>();
  async create(value: Run): Promise<Run> { this.items.set(value.id, value); return value; }
  async get(id: string): Promise<Run | undefined> { return this.items.get(id); }
  async update(value: Run): Promise<Run> { this.items.set(value.id, value); return value; }
  async list() { return { runs: [...this.items.values()], nextCursor: null }; }
}

class MemoryApprovalStore implements ApprovalStore {
  readonly items = new Map<string, Approval>();
  async create(value: Approval): Promise<Approval> { this.items.set(value.id, value); return value; }
  async get(id: string): Promise<Approval | undefined> { return this.items.get(id); }
  async update(value: Approval): Promise<Approval> { this.items.set(value.id, value); return value; }
  async list() { return { approvals: [...this.items.values()], nextCursor: null }; }
  async updateIfStatus(id: string, expected: Approval["status"], value: Approval): Promise<Approval | null> {
    const current = this.items.get(id);
    if (!current || current.status !== expected) return null;
    this.items.set(id, value);
    return value;
  }
}

class MemoryInvocationStore implements ToolInvocationStore {
  readonly items = new Map<string, ToolInvocation>();
  async create(value: ToolInvocation): Promise<ToolInvocation> { this.items.set(value.id, value); return value; }
  async get(id: string): Promise<ToolInvocation | undefined> { return this.items.get(id); }
  async update(value: ToolInvocation): Promise<ToolInvocation> { this.items.set(value.id, value); return value; }
  async list() { return { invocations: [...this.items.values()], nextCursor: null }; }
  async listByApproval(approvalId: string): Promise<ToolInvocation[]> {
    return [...this.items.values()].filter((entry) => entry.approvalId === approvalId);
  }
  async updateIfStatus(id: string, expected: ToolInvocation["status"], value: ToolInvocation): Promise<ToolInvocation | null> {
    const current = this.items.get(id);
    if (!current || current.status !== expected) return null;
    this.items.set(id, value);
    return value;
  }
}

class MemoryEventStore implements EventStore {
  readonly items: SwitchyardEvent[] = [];
  async append(event: SwitchyardEvent): Promise<SwitchyardEvent> { this.items.push(event); return event; }
  async listByRun(runId: string): Promise<SwitchyardEvent[]> { return this.items.filter((event) => event.runId === runId); }
  async listByDebate(): Promise<SwitchyardEvent[]> { return []; }
}

class MemoryOutboxStore implements ToolDispatchOutboxStore {
  readonly items = new Map<string, ToolDispatchOutboxRecord>();
  failMarkDispatchedOnce = false;

  async upsertByApprovalAndInvocation(input: {
    approvalId: string;
    toolInvocationId: string;
    runId: string;
    targetPlacement: "hosted" | "connected_local_node";
    executionPlanHash: string;
    now?: string;
  }): Promise<ToolDispatchOutboxRecord> {
    const existing = [...this.items.values()].find((entry) =>
      entry.approvalId === input.approvalId && entry.toolInvocationId === input.toolInvocationId
    );
    if (existing) return existing;
    const now = input.now ?? "2026-06-01T00:00:00.000Z";
    const created: ToolDispatchOutboxRecord = {
      id: `dispatch_${this.items.size + 1}`,
      approvalId: input.approvalId,
      toolInvocationId: input.toolInvocationId,
      runId: input.runId,
      targetPlacement: input.targetPlacement,
      executionPlanHash: input.executionPlanHash,
      dispatchStatus: "pending",
      attemptCount: 0,
      createdAt: now,
      updatedAt: now
    };
    this.items.set(created.id, created);
    return created;
  }

  async getByApprovalAndInvocation(approvalId: string, toolInvocationId: string): Promise<ToolDispatchOutboxRecord | undefined> {
    return [...this.items.values()].find((entry) =>
      entry.approvalId === approvalId && entry.toolInvocationId === toolInvocationId
    );
  }

  async markDispatching(id: string): Promise<ToolDispatchOutboxRecord | undefined> {
    const current = this.items.get(id);
    if (!current) return undefined;
    const next: ToolDispatchOutboxRecord = { ...current, dispatchStatus: "dispatching", attemptCount: current.attemptCount + 1 };
    this.items.set(id, next);
    return next;
  }

  async markDispatched(id: string, dispatchId: string): Promise<ToolDispatchOutboxRecord | undefined> {
    if (this.failMarkDispatchedOnce) {
      this.failMarkDispatchedOnce = false;
      throw new Error("mark_dispatched_timeout");
    }
    const current = this.items.get(id);
    if (!current) return undefined;
    const next: ToolDispatchOutboxRecord = { ...current, dispatchStatus: "dispatched", dispatchId };
    this.items.set(id, next);
    return next;
  }

  async markFailedRetryable(id: string, reasonCode: string): Promise<ToolDispatchOutboxRecord | undefined> {
    const current = this.items.get(id);
    if (!current) return undefined;
    const next: ToolDispatchOutboxRecord = { ...current, dispatchStatus: "failed_retryable", lastErrorCode: reasonCode };
    this.items.set(id, next);
    return next;
  }

  async listRetryable(): Promise<ToolDispatchOutboxRecord[]> {
    return [...this.items.values()].filter((entry) => entry.dispatchStatus === "pending" || entry.dispatchStatus === "failed_retryable");
  }
}

function makeRun(id: string, placement: Run["placement"]): Run {
  return {
    id,
    runtime: "fake",
    provider: "test",
    model: "test",
    adapterType: "process",
    cwd: "/repo",
    task: "task",
    status: "queued",
    placement,
    approvalPolicy: "default",
    timeoutSeconds: 60,
    metadata: {},
    createdAt: "2026-06-01T00:00:00.000Z"
  };
}

function enabledHostedPolicy(): LocalPolicyGate {
  const config = createDisabledRealToolPolicyConfig();
  return new LocalPolicyGate({
    ...config,
    global: { ...config.global, enabled: true },
    hosted: { enabled: true, allowedToolTypes: ["fetch", "web_search", "github", "shell", "fake_echo"] },
    connectedLocalNode: { enabled: true, allowedToolTypes: ["fetch", "web_search", "github", "repo", "shell", "fake_echo"] },
    fetch: { ...config.fetch, enabled: true, allowedHosts: ["example.com"] }
  });
}

function enabledHostedAllowPolicy(): LocalPolicyGate {
  const config = createDisabledRealToolPolicyConfig();
  return new LocalPolicyGate({
    ...config,
    global: { ...config.global, enabled: true, approvalDefault: "allow" },
    hosted: { enabled: true, allowedToolTypes: ["fetch", "web_search", "github", "shell", "fake_echo"] },
    connectedLocalNode: { enabled: true, allowedToolTypes: ["fetch", "web_search", "github", "repo", "shell", "fake_echo"] },
    fetch: { ...config.fetch, enabled: true, allowedHosts: ["example.com"], allowWithoutApproval: true }
  });
}

describe("tool approval dispatch", () => {
  it("dispatches hosted allow-without-approval tools immediately through outbox", async () => {
    const runs = new MemoryRunStore();
    await runs.create(makeRun("run_allow_1", "hosted"));
    const outbox = new MemoryOutboxStore();
    const dispatches: Array<{ approvalId: string; toolInvocationId: string; idempotencyKey: string }> = [];

    const service = new HostedToolService({
      runs,
      approvals: new MemoryApprovalStore(),
      invocations: new MemoryInvocationStore(),
      events: new MemoryEventStore(),
      policy: enabledHostedAllowPolicy(),
      dispatchOutbox: outbox,
      dispatch: async ({ approvalId, invocation, idempotencyKey }) => {
        dispatches.push({ approvalId, toolInvocationId: invocation.id, idempotencyKey });
        return { dispatchId: `job_${idempotencyKey}`, target: "hosted" };
      }
    });

    const created = await service.invoke({
      runId: "run_allow_1",
      type: "fetch",
      input: { url: "https://example.com/no-approval", method: "GET" },
      target: { placement: "hosted" }
    });

    expect(created.statusCode).toBe(202);
    expect(created.approval).toBeUndefined();
    expect(created.invocation.status).toBe("queued");
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.approvalId).toMatch(/^approval_auto_/);
    const record = await outbox.getByApprovalAndInvocation(dispatches[0]!.approvalId, created.invocation.id);
    expect(record?.dispatchStatus).toBe("dispatched");
  });

  it("dedupes repeated no-approval hosted invoke when idempotency key is reused", async () => {
    const runs = new MemoryRunStore();
    await runs.create(makeRun("run_allow_2", "hosted"));
    const outbox = new MemoryOutboxStore();
    const dispatchKeys = new Set<string>();

    const service = new HostedToolService({
      runs,
      approvals: new MemoryApprovalStore(),
      invocations: new MemoryInvocationStore(),
      events: new MemoryEventStore(),
      policy: enabledHostedAllowPolicy(),
      dispatchOutbox: outbox,
      dispatch: async ({ idempotencyKey }) => {
        dispatchKeys.add(idempotencyKey);
        return { dispatchId: `job_${idempotencyKey}`, target: "hosted" };
      }
    });

    const input = {
      runId: "run_allow_2",
      type: "fetch" as const,
      input: { url: "https://example.com/idempotent", method: "GET" },
      target: { placement: "hosted" as const },
      idempotencyKey: "invoke_same"
    };

    const first = await service.invoke(input);
    const second = await service.invoke(input);

    expect(first.invocation.id).toBe(second.invocation.id);
    expect(dispatchKeys.size).toBe(1);
  });

  it("approves exactly once and dispatches once", async () => {
    const runs = new MemoryRunStore();
    await runs.create(makeRun("run_1", "hosted"));
    const approvals = new MemoryApprovalStore();
    const invocations = new MemoryInvocationStore();
    const outbox = new MemoryOutboxStore();
    const sideEffects = new Set<string>();

    const service = new HostedToolService({
      runs,
      approvals,
      invocations,
      events: new MemoryEventStore(),
      policy: enabledHostedPolicy(),
      dispatchOutbox: outbox,
      dispatch: async ({ idempotencyKey }) => {
        sideEffects.add(idempotencyKey);
        return { dispatchId: `job_${idempotencyKey}`, target: "hosted" };
      }
    });

    const created = await service.invoke({
      runId: "run_1",
      type: "fetch",
      input: { url: "https://example.com/a", method: "GET" },
      target: { placement: "hosted" }
    });

    const first = service.resolveApproval(created.approval!.id, "approved");
    const second = service.resolveApproval(created.approval!.id, "approved");

    const [one, two] = await Promise.allSettled([first, second]);
    const okCount = [one, two].filter((entry) => entry.status === "fulfilled").length;
    const failCount = [one, two].filter((entry) => entry.status === "rejected").length;

    expect(okCount).toBe(1);
    expect(failCount).toBe(1);
    expect(sideEffects.size).toBe(1);
  });

  it("recovers dispatch on markDispatched timeout without duplicate side effects", async () => {
    const runs = new MemoryRunStore();
    await runs.create(makeRun("run_2", "hosted"));
    const outbox = new MemoryOutboxStore();
    outbox.failMarkDispatchedOnce = true;
    const sideEffects = new Set<string>();

    const service = new HostedToolService({
      runs,
      approvals: new MemoryApprovalStore(),
      invocations: new MemoryInvocationStore(),
      events: new MemoryEventStore(),
      policy: enabledHostedPolicy(),
      dispatchOutbox: outbox,
      dispatch: async ({ idempotencyKey }) => {
        sideEffects.add(idempotencyKey);
        return { dispatchId: `job_${idempotencyKey}`, target: "hosted" };
      }
    });

    const created = await service.invoke({
      runId: "run_2",
      type: "fetch",
      input: { url: "https://example.com/retry", method: "GET" },
      target: { placement: "hosted" }
    });

    await expect(service.resolveApproval(created.approval!.id, "approved")).rejects.toMatchObject({ code: "tool_dispatch_failed" });

    const retried = await service.resolveApproval(created.approval!.id, "approved");
    expect(retried.approval.status).toBe("approved");
    expect(sideEffects.size).toBe(1);
    const record = await outbox.getByApprovalAndInvocation(created.approval!.id, created.invocation.id);
    expect(record?.dispatchStatus).toBe("dispatched");
  });

  it("rejects runtime approvals in hosted tool mode", async () => {
    const approvals = new MemoryApprovalStore();
    await approvals.create({
      id: "approval_runtime",
      status: "pending",
      approvalType: "before_external_web_action",
      payload: { runtimeApprovalToken: "token_1" },
      createdAt: "2026-06-01T00:00:00.000Z"
    });

    const service = new HostedToolService({
      runs: new MemoryRunStore(),
      approvals,
      invocations: new MemoryInvocationStore(),
      events: new MemoryEventStore(),
      policy: enabledHostedPolicy(),
      dispatchOutbox: new MemoryOutboxStore(),
      dispatch: async () => ({ dispatchId: "d_1", target: "hosted" })
    });

    await expect(service.resolveApproval("approval_runtime", "approved")).rejects.toMatchObject({
      code: "hosted_runtime_approval_bridge_unshipped"
    });
  });

  it("creates idempotent tool assignments with kind and tool invocation id", async () => {
    class MemoryNodeStore implements NodeStore {
      readonly items = new Map<string, ConnectedNode>();
      async upsert(node: ConnectedNode): Promise<ConnectedNode> { this.items.set(node.id, node); return node; }
      async get(id: string): Promise<ConnectedNode | undefined> { return this.items.get(id); }
      async list() { return [...this.items.values()]; }
      async markOffline() { return undefined; }
      async listEligible() { return [...this.items.values()]; }
    }

    class MemoryAssignments implements NodeAssignmentStore {
      readonly items = new Map<string, Assignment>();
      async create(value: Assignment): Promise<Assignment> { this.items.set(value.id, value); return value; }
      async get(id: string): Promise<Assignment | undefined> { return this.items.get(id); }
      async update(value: Assignment): Promise<Assignment> { this.items.set(value.id, value); return value; }
      async listClaimable() { return []; }
      async claim() { return undefined; }
      async complete() { return undefined; }
      async fail() { return undefined; }
      async cancel() { return undefined; }
      async expireStale() { return []; }
    }

    const runs = new MemoryRunStore();
    await runs.create(makeRun("run_3", "connected_local_node"));

    const nodes = new MemoryNodeStore();
    const policy: NodePolicy = {
      allowRuntimeModes: [],
      denyAdapterTypes: [],
      allowCwdPrefixes: [],
      allowEventTypes: [],
      artifactSync: "full",
      allowToolTypes: ["fetch"],
      allowToolCwdPrefixes: [],
      toolArtifactSync: "full",
      toolApprovalRequired: true
    };
    await nodes.upsert({
      id: "node_1",
      mode: "hybrid",
      status: "online",
      capabilities: ["tool.fetch"],
      policy,
      createdAt: "2026-06-01T00:00:00.000Z"
    });

    const assignments = new MemoryAssignments();
    const coordinator = new NodeCoordinatorService({ nodes, assignments, runs, now: () => "2026-06-01T00:00:00.000Z" });

    const first = await coordinator.createToolAssignment({
      runId: "run_3",
      toolInvocationId: "tool_abc123",
      requiredCapability: "tool.fetch",
      idempotencyKey: "idem_1"
    });

    const second = await coordinator.createToolAssignment({
      runId: "run_3",
      toolInvocationId: "tool_abc123",
      requiredCapability: "tool.fetch",
      idempotencyKey: "idem_1"
    });

    expect(first.id).toBe(second.id);
    expect(first.kind).toBe("tool");
    expect(first.toolInvocationId).toBe("tool_abc123");
  });

  it("dedupes tool assignment idempotency across fresh service instances", async () => {
    class MemoryNodeStore implements NodeStore {
      readonly items = new Map<string, ConnectedNode>();
      async upsert(node: ConnectedNode): Promise<ConnectedNode> { this.items.set(node.id, node); return node; }
      async get(id: string): Promise<ConnectedNode | undefined> { return this.items.get(id); }
      async list() { return [...this.items.values()]; }
      async markOffline() { return undefined; }
      async listEligible() { return [...this.items.values()]; }
    }

    class MemoryAssignments implements NodeAssignmentStore {
      readonly items = new Map<string, Assignment>();
      async create(value: Assignment): Promise<Assignment> { this.items.set(value.id, value); return value; }
      async get(id: string): Promise<Assignment | undefined> { return this.items.get(id); }
      async update(value: Assignment): Promise<Assignment> { this.items.set(value.id, value); return value; }
      async listClaimable() { return []; }
      async claim() { return undefined; }
      async complete() { return undefined; }
      async fail() { return undefined; }
      async cancel() { return undefined; }
      async expireStale() { return []; }
    }

    const runs = new MemoryRunStore();
    await runs.create(makeRun("run_4", "connected_local_node"));
    const nodes = new MemoryNodeStore();
    await nodes.upsert({
      id: "node_2",
      mode: "hybrid",
      status: "online",
      capabilities: ["tool.fetch"],
      policy: {
        allowRuntimeModes: [],
        denyAdapterTypes: [],
        allowCwdPrefixes: [],
        allowEventTypes: [],
        artifactSync: "full",
        allowToolTypes: ["fetch"],
        allowToolCwdPrefixes: [],
        toolArtifactSync: "full",
        toolApprovalRequired: true
      },
      createdAt: "2026-06-01T00:00:00.000Z"
    });

    const assignments = new MemoryAssignments();
    const firstService = new NodeCoordinatorService({ nodes, assignments, runs, now: () => "2026-06-01T00:00:00.000Z" });
    const secondService = new NodeCoordinatorService({ nodes, assignments, runs, now: () => "2026-06-01T00:00:00.000Z" });

    const first = await firstService.createToolAssignment({
      runId: "run_4",
      toolInvocationId: "tool_retry_1",
      requiredCapability: "tool.fetch",
      idempotencyKey: "idem_shared"
    });
    const second = await secondService.createToolAssignment({
      runId: "run_4",
      toolInvocationId: "tool_retry_1",
      requiredCapability: "tool.fetch",
      idempotencyKey: "idem_shared"
    });

    expect(first.id).toBe(second.id);
    expect(assignments.items.size).toBe(1);
  });

  it("allows connected-node tool assignment for explicitly marked hosted offload runs", async () => {
    class MemoryNodeStore implements NodeStore {
      readonly items = new Map<string, ConnectedNode>();
      async upsert(node: ConnectedNode): Promise<ConnectedNode> { this.items.set(node.id, node); return node; }
      async get(id: string): Promise<ConnectedNode | undefined> { return this.items.get(id); }
      async list() { return [...this.items.values()]; }
      async markOffline() { return undefined; }
      async listEligible() { return [...this.items.values()]; }
    }

    class MemoryAssignments implements NodeAssignmentStore {
      readonly items = new Map<string, Assignment>();
      async create(value: Assignment): Promise<Assignment> { this.items.set(value.id, value); return value; }
      async get(id: string): Promise<Assignment | undefined> { return this.items.get(id); }
      async update(value: Assignment): Promise<Assignment> { this.items.set(value.id, value); return value; }
      async listClaimable() { return []; }
      async claim() { return undefined; }
      async complete() { return undefined; }
      async fail() { return undefined; }
      async cancel() { return undefined; }
      async expireStale() { return []; }
    }

    const runs = new MemoryRunStore();
    await runs.create({
      ...makeRun("run_offload_allowed", "hosted"),
      metadata: { allowToolPlacementOffload: true }
    });
    const nodes = new MemoryNodeStore();
    await nodes.upsert({
      id: "node_offload",
      mode: "hybrid",
      status: "online",
      capabilities: ["tool.fetch"],
      policy: {
        allowRuntimeModes: [],
        denyAdapterTypes: [],
        allowCwdPrefixes: [],
        allowEventTypes: [],
        artifactSync: "full",
        allowToolTypes: ["fetch"],
        allowToolCwdPrefixes: [],
        toolArtifactSync: "full",
        toolApprovalRequired: true
      },
      createdAt: "2026-06-01T00:00:00.000Z"
    });

    const coordinator = new NodeCoordinatorService({
      nodes,
      assignments: new MemoryAssignments(),
      runs,
      now: () => "2026-06-01T00:00:00.000Z"
    });

    const assignment = await coordinator.createToolAssignment({
      runId: "run_offload_allowed",
      toolInvocationId: "tool_offload_1",
      requiredCapability: "tool.fetch",
      idempotencyKey: "offload_allowed"
    });

    expect(assignment.kind).toBe("tool");
    expect(assignment.nodeId).toBe("node_offload");
  });

  it("rejects connected-node tool assignment for unmarked hosted runs", async () => {
    class MemoryNodeStore implements NodeStore {
      readonly items = new Map<string, ConnectedNode>();
      async upsert(node: ConnectedNode): Promise<ConnectedNode> { this.items.set(node.id, node); return node; }
      async get(id: string): Promise<ConnectedNode | undefined> { return this.items.get(id); }
      async list() { return [...this.items.values()]; }
      async markOffline() { return undefined; }
      async listEligible() { return [...this.items.values()]; }
    }

    class MemoryAssignments implements NodeAssignmentStore {
      readonly items = new Map<string, Assignment>();
      async create(value: Assignment): Promise<Assignment> { this.items.set(value.id, value); return value; }
      async get(id: string): Promise<Assignment | undefined> { return this.items.get(id); }
      async update(value: Assignment): Promise<Assignment> { this.items.set(value.id, value); return value; }
      async listClaimable() { return []; }
      async claim() { return undefined; }
      async complete() { return undefined; }
      async fail() { return undefined; }
      async cancel() { return undefined; }
      async expireStale() { return []; }
    }

    const runs = new MemoryRunStore();
    await runs.create(makeRun("run_offload_denied", "hosted"));
    const nodes = new MemoryNodeStore();
    await nodes.upsert({
      id: "node_denied",
      mode: "hybrid",
      status: "online",
      capabilities: ["tool.fetch"],
      createdAt: "2026-06-01T00:00:00.000Z"
    });
    const assignments = new MemoryAssignments();
    const coordinator = new NodeCoordinatorService({
      nodes,
      assignments,
      runs,
      now: () => "2026-06-01T00:00:00.000Z"
    });

    await expect(coordinator.createToolAssignment({
      runId: "run_offload_denied",
      toolInvocationId: "tool_offload_2",
      requiredCapability: "tool.fetch",
      idempotencyKey: "offload_denied"
    })).rejects.toMatchObject({ code: "node_policy_denied" });
    expect(assignments.items.size).toBe(0);
  });
});
