import { describe, expect, it } from "vitest";
import type { Approval, Artifact, Run, SwitchyardEvent, ToolInvocation } from "@switchyard/contracts";
import { LocalPolicyGate } from "../src/services/local-policy-gate.js";
import { ToolRouter } from "../src/services/tool-router.js";
import type { ApprovalStore } from "../src/ports/approval-store.js";
import type { ArtifactStore } from "../src/ports/artifact-store.js";
import type { EventStore } from "../src/ports/event-store.js";
import type { RunStore } from "../src/ports/run-store.js";
import type { ToolAdapter } from "../src/ports/tool-adapter.js";
import type { ToolInvocationStore } from "../src/ports/tool-invocation-store.js";

class MemoryRunStore implements RunStore {
  readonly items = new Map<string, Run>();
  async create(value: Run): Promise<Run> { this.items.set(value.id, value); return value; }
  async get(id: string): Promise<Run | undefined> { return this.items.get(id); }
  async update(value: Run): Promise<Run> { this.items.set(value.id, value); return value; }
  async list() { return { runs: [...this.items.values()], nextCursor: null }; }
}

class MemoryEventStore implements EventStore {
  readonly items: SwitchyardEvent[] = [];
  async append(value: SwitchyardEvent): Promise<SwitchyardEvent> { this.items.push(value); return value; }
  async listByRun(runId: string): Promise<SwitchyardEvent[]> { return this.items.filter((event) => event.runId === runId); }
  async listByDebate(): Promise<SwitchyardEvent[]> { return []; }
}

class MemoryApprovalStore implements ApprovalStore {
  async create(value: Approval): Promise<Approval> { return value; }
  async get(): Promise<Approval | undefined> { return undefined; }
  async update(value: Approval): Promise<Approval> { return value; }
  async list() { return { approvals: [], nextCursor: null }; }
  async updateIfStatus() { return null; }
}

class MemoryInvocationStore implements ToolInvocationStore {
  readonly items = new Map<string, ToolInvocation>();
  async create(value: ToolInvocation): Promise<ToolInvocation> { this.items.set(value.id, value); return value; }
  async get(id: string): Promise<ToolInvocation | undefined> { return this.items.get(id); }
  async update(value: ToolInvocation): Promise<ToolInvocation> { this.items.set(value.id, value); return value; }
  async list() { return { invocations: [...this.items.values()], nextCursor: null }; }
  async listByApproval() { return []; }
  async updateIfStatus() { return null; }
}

class MemoryArtifactStore implements ArtifactStore {
  async create(value: Artifact): Promise<Artifact> { return value; }
  async get(): Promise<Artifact | undefined> { return undefined; }
  async update(value: Artifact): Promise<Artifact> { return value; }
  async listByRun(): Promise<Artifact[]> { return []; }
  async listByDebate(): Promise<Artifact[]> { return []; }
}

class FakeEchoAdapter implements ToolAdapter {
  readonly id = "fake_echo";
  async check() { return { ok: true }; }
  async invoke(input: Record<string, unknown>) { return { echo: input["text"] }; }
  async cancel() { return; }
  async artifacts() { return []; }
}

function makeRun(id: string): Run {
  return {
    id,
    runtime: "fake",
    provider: "test",
    model: "test",
    adapterType: "process",
    cwd: "/repo",
    task: "task",
    status: "queued",
    placement: "local",
    approvalPolicy: "default",
    timeoutSeconds: 60,
    metadata: {},
    createdAt: "2026-06-01T00:00:00.000Z"
  };
}

describe("tool router local compatibility", () => {
  it("preserves local fake_echo synchronous behavior", async () => {
    const runs = new MemoryRunStore();
    await runs.create(makeRun("run_local_1"));

    const router = new ToolRouter({
      runs,
      events: new MemoryEventStore(),
      approvals: new MemoryApprovalStore(),
      invocations: new MemoryInvocationStore(),
      artifacts: new MemoryArtifactStore(),
      adapters: new Map<string, ToolAdapter>([["fake_echo", new FakeEchoAdapter()]]),
      policy: new LocalPolicyGate()
    });

    const result = await router.invoke({
      runId: "run_local_1",
      type: "fake_echo",
      input: { text: "hello" }
    });

    expect(result.statusCode).toBe(201);
    expect(result.invocation.status).toBe("completed");
    expect(result.invocation.output?.echo).toBe("hello");
  });
});
