import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Artifact, Approval, Run, SwitchyardEvent, ToolInvocation } from "@switchyard/contracts";
import { ApprovalService } from "../src/services/approval-service.js";
import { EventBus } from "../src/services/event-bus.js";
import {
  LocalPolicyGate,
  createDisabledRealToolPolicyConfig,
  type ResolvedRealToolPolicyConfig
} from "../src/services/local-policy-gate.js";
import { ToolRouter, hashExecutionPlan } from "../src/services/tool-router.js";
import type { ApprovalStore, ListApprovalsFilter, ListApprovalsResult } from "../src/ports/approval-store.js";
import type { ArtifactStore } from "../src/ports/artifact-store.js";
import type { EventStore } from "../src/ports/event-store.js";
import type { ListRunsFilter, ListRunsResult, RunStore } from "../src/ports/run-store.js";
import type { ToolAdapter } from "../src/ports/tool-adapter.js";
import type {
  ListToolInvocationsFilter,
  ListToolInvocationsResult,
  ToolInvocationStore
} from "../src/ports/tool-invocation-store.js";

function makeRun(id: string, approvalPolicy = "default"): Run {
  return {
    id,
    runtime: "fake",
    provider: "test",
    model: "test-model",
    adapterType: "process",
    cwd: "/repo",
    task: "task",
    status: "queued",
    placement: "local",
    approvalPolicy,
    timeoutSeconds: 60,
    metadata: {},
    createdAt: "2026-05-30T00:00:00.000Z"
  };
}

class InMemoryRunStore implements RunStore {
  readonly items = new Map<string, Run>();

  async create(run: Run): Promise<Run> {
    this.items.set(run.id, run);
    return run;
  }

  async get(id: string): Promise<Run | undefined> {
    return this.items.get(id);
  }

  async update(run: Run): Promise<Run> {
    this.items.set(run.id, run);
    return run;
  }

  async list(_filter: ListRunsFilter): Promise<ListRunsResult> {
    return { runs: [...this.items.values()], nextCursor: null };
  }
}

class InMemoryEventStore implements EventStore {
  readonly items: SwitchyardEvent[] = [];

  async append(event: SwitchyardEvent): Promise<SwitchyardEvent> {
    this.items.push(event);
    return event;
  }

  async listByRun(runId: string): Promise<SwitchyardEvent[]> {
    return this.items.filter((event) => event.runId === runId);
  }

  async listByDebate(debateId: string): Promise<SwitchyardEvent[]> {
    return this.items.filter((event) => event.debateId === debateId);
  }
}

class InMemoryApprovalStore implements ApprovalStore {
  readonly items = new Map<string, Approval>();

  async create(value: Approval): Promise<Approval> {
    this.items.set(value.id, value);
    return value;
  }

  async get(id: string): Promise<Approval | undefined> {
    return this.items.get(id);
  }

  async update(value: Approval): Promise<Approval> {
    this.items.set(value.id, value);
    return value;
  }

  async list(_filter: ListApprovalsFilter): Promise<ListApprovalsResult> {
    return { approvals: [...this.items.values()], nextCursor: null };
  }

  async updateIfStatus(id: string, expectedStatus: Approval["status"], value: Approval): Promise<Approval | null> {
    const existing = this.items.get(id);
    if (!existing || existing.status !== expectedStatus) {
      return null;
    }
    this.items.set(id, value);
    return value;
  }
}

class InMemoryToolInvocationStore implements ToolInvocationStore {
  readonly items = new Map<string, ToolInvocation>();

  async create(value: ToolInvocation): Promise<ToolInvocation> {
    this.items.set(value.id, value);
    return value;
  }

  async get(id: string): Promise<ToolInvocation | undefined> {
    return this.items.get(id);
  }

  async update(value: ToolInvocation): Promise<ToolInvocation> {
    this.items.set(value.id, value);
    return value;
  }

  async list(_filter: ListToolInvocationsFilter): Promise<ListToolInvocationsResult> {
    return { invocations: [...this.items.values()], nextCursor: null };
  }

  async listByApproval(approvalId: string): Promise<ToolInvocation[]> {
    return [...this.items.values()].filter((item) => item.approvalId === approvalId);
  }

  async updateIfStatus(
    id: string,
    expectedStatus: ToolInvocation["status"],
    value: ToolInvocation
  ): Promise<ToolInvocation | null> {
    const existing = this.items.get(id);
    if (!existing || existing.status !== expectedStatus) {
      return null;
    }
    this.items.set(id, value);
    return value;
  }
}

class InMemoryArtifactStore implements ArtifactStore {
  readonly items = new Map<string, Artifact>();

  async create(value: Artifact): Promise<Artifact> {
    this.items.set(value.id, value);
    return value;
  }

  async get(id: string): Promise<Artifact | undefined> {
    return this.items.get(id);
  }

  async update(value: Artifact): Promise<Artifact> {
    this.items.set(value.id, value);
    return value;
  }

  async listByRun(runId: string): Promise<Artifact[]> {
    return [...this.items.values()].filter((artifact) => artifact.runId === runId);
  }

  async listByDebate(debateId: string): Promise<Artifact[]> {
    return [...this.items.values()].filter((artifact) => artifact.debateId === debateId);
  }
}

class FakeEchoToolAdapter implements ToolAdapter {
  readonly id = "fake_echo";

  async check() {
    return { ok: true };
  }

  async invoke(input: Record<string, unknown>) {
    const text = typeof input["text"] === "string" ? input["text"] : "";
    return { echo: text };
  }

  async cancel() {
    return;
  }

  async artifacts(): Promise<Artifact[]> {
    return [];
  }
}

function enabledConfig(): ResolvedRealToolPolicyConfig {
  const base = createDisabledRealToolPolicyConfig();
  return {
    ...base,
    global: {
      ...base.global,
      enabled: true
    },
    fetch: {
      ...base.fetch,
      enabled: true,
      allowedHosts: ["example.com"],
      allowedContentTypes: ["text/plain"]
    },
    shell: {
      ...base.shell,
      enabled: true,
      allowedCwdPrefixes: ["/repo"],
      catalog: {
        "local.date.utc": {
          commandId: "local.date.utc",
          executablePath: "/bin/date",
          argv: ["-u"],
          allowedCwdPrefixes: ["/repo"],
          env: { TZ: "UTC" },
          maxArgs: 4
        }
      }
    }
  };
}

class CountingAdapter implements ToolAdapter {
  invocationCount = 0;
  readonly id: string;

  constructor(id: string, private readonly payload: Record<string, unknown> = { ok: true }) {
    this.id = id;
  }

  async check() {
    return { ok: true };
  }

  async invoke(input: Record<string, unknown>) {
    this.invocationCount += 1;
    return {
      summary: { adapter: this.id },
      inlineOutput: input,
      artifactCandidates: [{
        logicalPath: `${this.id}.log`,
        type: "raw_log",
        content: "log",
        contentType: "text/plain",
        metadata: {}
      }],
      ...this.payload
    };
  }

  async cancel() {
    return;
  }

  async artifacts(): Promise<Artifact[]> {
    return [];
  }
}

class MemoryArtifactContent {
  readonly writes: Array<{ path: string; text: string; contentType: string }> = [];

  async writeText(path: string, text: string, options?: { contentType?: string }) {
    const contentType = options?.contentType ?? "text/plain";
    this.writes.push({ path, text, contentType });
    return {
      path,
      storageBackend: "memory" as const,
      sizeBytes: Buffer.byteLength(text, "utf8"),
      sha256: createHash("sha256").update(text).digest("hex"),
      contentType
    };
  }

  async writeBytes(path: string, bytes: Buffer, options?: { contentType?: string }) {
    const contentType = options?.contentType ?? "application/octet-stream";
    this.writes.push({ path, text: bytes.toString("utf8"), contentType });
    return {
      path,
      storageBackend: "memory" as const,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      contentType
    };
  }

  async read(): Promise<{ body: Buffer; contentType: string }> {
    return { body: Buffer.from("", "utf8"), contentType: "text/plain" };
  }
}

describe("real tool router", () => {
  it("persists denied real tool invocation by default", async () => {
    const runs = new InMemoryRunStore();
    const run = makeRun("run_denied");
    await runs.create(run);
    const router = new ToolRouter({
      runs,
      events: new InMemoryEventStore(),
      approvals: new InMemoryApprovalStore(),
      invocations: new InMemoryToolInvocationStore(),
      adapters: new Map([["fake_echo", new FakeEchoToolAdapter()]]),
      policy: new LocalPolicyGate()
    });

    await expect(router.invoke({
      runId: run.id,
      type: "fetch",
      input: { url: "https://example.com", method: "GET" }
    })).rejects.toMatchObject({ code: "tool_policy_denied" });

    const listed = await router.list({ runId: run.id, limit: 20 });
    expect(listed.invocations[0]?.status).toBe("denied");
    expect(listed.invocations[0]?.error?.code).toBe("tool_real_tools_disabled");
  });

  it("queues approval-required real tool and executes once on approve", async () => {
    const runs = new InMemoryRunStore();
    const run = makeRun("run_approval_real");
    await runs.create(run);
    const events = new InMemoryEventStore();
    const approvals = new InMemoryApprovalStore();
    const invocations = new InMemoryToolInvocationStore();
    const artifacts = new InMemoryArtifactStore();
    const artifactContent = new MemoryArtifactContent();
    const fetchAdapter = new CountingAdapter("fetch");

    const router = new ToolRouter({
      runs,
      events,
      approvals,
      invocations,
      artifacts,
      artifactContent,
      adapters: new Map([
        ["fake_echo", new FakeEchoToolAdapter()],
        ["fetch", fetchAdapter]
      ]),
      policy: new LocalPolicyGate(enabledConfig()),
      eventBus: new EventBus()
    });
    const approvalService = new ApprovalService({ approvals, runs, events, toolRouter: router });

    const queued = await router.invoke({
      runId: run.id,
      type: "fetch",
      input: { url: "https://example.com/path", method: "GET", captureContent: true }
    });
    expect(queued.statusCode).toBe(202);
    expect(queued.approval?.approvalType).toBe("before_external_web_action");
    expect(hashExecutionPlan((queued.invocation.input as Record<string, unknown>).executionPlan as any)).toBe(
      (queued.invocation.input as Record<string, unknown>).executionPlanHash
    );

    const approvalId = queued.approval?.id;
    if (!approvalId) {
      throw new Error("missing approval id");
    }
    const approved = await approvalService.approve(approvalId, { actor: "local-user" });
    expect(approved.invocation?.status).toBe("completed");
    expect(fetchAdapter.invocationCount).toBe(1);

    await expect(approvalService.approve(approvalId, { actor: "local-user" })).rejects.toMatchObject({
      code: "approval_not_pending"
    });

    const terminal = await router.get(queued.invocation.id);
    expect(terminal?.output?.artifactIds).toBeDefined();
    expect(artifactContent.writes.length).toBeGreaterThan(0);
  });

  it("marks queued invocations denied on reject and expired", async () => {
    const runs = new InMemoryRunStore();
    const run = makeRun("run_reject_real");
    await runs.create(run);
    const events = new InMemoryEventStore();
    const approvals = new InMemoryApprovalStore();
    const invocations = new InMemoryToolInvocationStore();
    const shellAdapter = new CountingAdapter("shell");
    const router = new ToolRouter({
      runs,
      events,
      approvals,
      invocations,
      adapters: new Map([
        ["fake_echo", new FakeEchoToolAdapter()],
        ["shell", shellAdapter]
      ]),
      policy: new LocalPolicyGate(enabledConfig())
    });
    const approvalService = new ApprovalService({ approvals, runs, events, toolRouter: router });

    const queued = await router.invoke({
      runId: run.id,
      type: "shell",
      input: { commandId: "local.date.utc", cwd: "/repo" }
    });
    expect(queued.statusCode).toBe(202);

    const approvalId = queued.approval?.id;
    if (!approvalId) {
      throw new Error("missing approval id");
    }

    const rejected = await approvalService.reject(approvalId, { actor: "local-user" });
    expect(rejected.invocation?.status).toBe("denied");
    expect(rejected.invocation?.error?.code).toBe("tool_approval_rejected");
    expect(shellAdapter.invocationCount).toBe(0);

    const now = new Date("2026-05-31T00:10:00.000Z");
    const expRuns = new InMemoryRunStore();
    const expRun = makeRun("run_expire_real");
    await expRuns.create(expRun);
    const expEvents = new InMemoryEventStore();
    const expApprovals = new InMemoryApprovalStore();
    const expInvocations = new InMemoryToolInvocationStore();
    const expShell = new CountingAdapter("shell");
    const expRouter = new ToolRouter({
      runs: expRuns,
      events: expEvents,
      approvals: expApprovals,
      invocations: expInvocations,
      adapters: new Map([
        ["fake_echo", new FakeEchoToolAdapter()],
        ["shell", expShell]
      ]),
      policy: new LocalPolicyGate(enabledConfig()),
      clock: () => now
    });
    const expApprovalService = new ApprovalService({
      approvals: expApprovals,
      runs: expRuns,
      events: expEvents,
      toolRouter: expRouter,
      clock: () => now,
      scheduler: {
        setTimeout: () => setTimeout(() => {}, 1),
        clearTimeout: () => {}
      }
    });
    const expQueued = await expRouter.invoke({
      runId: expRun.id,
      type: "shell",
      input: { commandId: "local.date.utc", cwd: "/repo" }
    });
    const expApprovalId = expQueued.approval?.id;
    if (!expApprovalId) {
      throw new Error("missing approval id");
    }
    await expApprovals.updateIfStatus(expApprovalId, "pending", {
      ...(await expApprovals.get(expApprovalId))!,
      payload: {
        ...(await expApprovals.get(expApprovalId))!.payload,
        expiresAt: "2026-05-31T00:00:00.000Z"
      }
    });

    const expired = await expApprovalService.expirePendingRuntimeApprovals(now);
    expect(expired.expired).toBe(1);
    const expFinal = await expRouter.get(expQueued.invocation.id);
    expect(expFinal?.status).toBe("denied");
    expect(expFinal?.error?.code).toBe("tool_approval_expired");
    expect(expShell.invocationCount).toBe(0);
  });

  it("reconciles interrupted running real invocations", async () => {
    const runs = new InMemoryRunStore();
    const run = makeRun("run_reconcile_real");
    await runs.create(run);
    const invocations = new InMemoryToolInvocationStore();
    await invocations.create({
      id: "tool_running_real",
      runId: run.id,
      type: "shell",
      status: "running",
      input: {},
      createdAt: "2026-05-30T00:00:00.000Z"
    } as ToolInvocation);

    const router = new ToolRouter({
      runs,
      events: new InMemoryEventStore(),
      approvals: new InMemoryApprovalStore(),
      invocations,
      adapters: new Map([["fake_echo", new FakeEchoToolAdapter()]]),
      policy: new LocalPolicyGate(enabledConfig())
    });

    const result = await router.reconcileInterruptedInvocations();
    expect(result.failed).toBe(1);
    const updated = await router.get("tool_running_real");
    expect(updated?.status).toBe("failed");
    expect(updated?.error?.code).toBe("daemon_restarted");
  });
});
