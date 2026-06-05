import { describe, expect, it } from "vitest";
import { NodeCoordinatorService, NodeCoordinatorError } from "../src/services/node-coordinator-service.js";

class InMemoryRunStore {
  items = new Map<string, any>();
  async create(run: any) { this.items.set(run.id, run); return run; }
  async get(id: string) { return this.items.get(id); }
  async update(run: any) { this.items.set(run.id, run); return run; }
  async list() { return { runs: [...this.items.values()], nextCursor: null }; }
}

class MemoryNodeStore {
  items = new Map<string, any>();
  async upsert(node: any) { this.items.set(node.id, node); return node; }
  async get(id: string) { return this.items.get(id); }
  async list(filter?: any) { return [...this.items.values()].filter((n) => !filter?.status || n.status === filter.status); }
  async markOffline(id: string, at: string) { const n = this.items.get(id); if (!n) return undefined; const u = { ...n, status: "offline", updatedAt: at }; this.items.set(id, u); return u; }
  async listEligible() { return [...this.items.values()]; }
}

class MemoryAssignments {
  items = new Map<string, any>();
  async create(record: any) { this.items.set(record.id, record); return record; }
  async get(id: string) { return this.items.get(id); }
  async update(record: any) { this.items.set(record.id, record); return record; }
  async listClaimable(nodeId: string) { return [...this.items.values()].filter((r) => r.nodeId === nodeId && r.status === "pending"); }
  async claim(input: any) {
    const row = this.items.get(input.assignmentId);
    if (!row || row.status !== "pending" || row.nodeId !== input.nodeId) return undefined;
    const claimed = { ...row, status: "claimed", claimedAt: input.now };
    this.items.set(claimed.id, claimed);
    return claimed;
  }
  async complete(id: string, now: string) { const row = this.items.get(id); if (!row) return undefined; const done = { ...row, status: "completed", completedAt: now }; this.items.set(id, done); return done; }
  async fail(id: string, now: string, error: string) { const row = this.items.get(id); if (!row) return undefined; const done = { ...row, status: "failed", failedAt: now, error }; this.items.set(id, done); return done; }
  async cancel(id: string, now: string) { const row = this.items.get(id); if (!row) return undefined; const done = { ...row, status: "cancelled", completedAt: now }; this.items.set(id, done); return done; }
  async expireStale() { return []; }
}

describe("NodeCoordinatorService", () => {
  it("registers node and claims assignment", async () => {
    const svc = new NodeCoordinatorService({
      nodes: new MemoryNodeStore() as any,
      assignments: new MemoryAssignments() as any,
      runs: new InMemoryRunStore(),
      now: () => "2026-05-30T00:00:00.000Z"
    });

    const node = await svc.register({ mode: "hybrid", capabilities: ["runtime.fake.deterministic"] });
    expect(node.status).toBe("online");

    const run = {
      id: "run_1",
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "task",
      status: "queued",
      placement: "connected_local_node",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "fake.deterministic",
      createdAt: "2026-05-30T00:00:00.000Z"
    } as any;

    const assignment = await svc.createAssignment(run, node.id);
    await (svc as any).deps.runs.create(run);
    const claimed = await svc.claim(node.id, assignment.id);
    expect(claimed?.assignment.status).toBe("claimed");
    expect(claimed?.run.id).toBe("run_1");
  });

  it("throws claim conflict", async () => {
    const svc = new NodeCoordinatorService({
      nodes: new MemoryNodeStore() as any,
      assignments: new MemoryAssignments() as any,
      runs: new InMemoryRunStore(),
      now: () => "2026-05-30T00:00:00.000Z"
    });

    const node = await svc.register({ id: "node_1", mode: "hybrid", capabilities: [] });
    const assignments = (svc as any).deps.assignments as MemoryAssignments;
    await assignments.create({ id: "assignment_1", runId: "run_1", nodeId: node.id, status: "claimed", retryCount: 0, lastEventSequence: 0, createdAt: "2026-05-30T00:00:00.000Z" });

    await expect(svc.claim(node.id, "assignment_1")).rejects.toBeInstanceOf(NodeCoordinatorError);
  });
});
