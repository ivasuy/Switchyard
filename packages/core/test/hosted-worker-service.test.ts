import { describe, expect, it } from "vitest";
import { HostedWorkerService } from "../src/services/hosted-worker-service.js";

class InMemoryRunStore {
  items = new Map<string, any>();
  async create(run: any) { this.items.set(run.id, run); return run; }
  async get(id: string) { return this.items.get(id); }
  async update(run: any) { this.items.set(run.id, run); return run; }
  async list() { return { runs: [...this.items.values()], nextCursor: null }; }
}

class InMemoryEventStore {
  items: any[] = [];
  async append(event: any) { this.items.push(event); return event; }
  async listByRun(runId: string) { return this.items.filter((event) => event.runId === runId); }
  async listByDebate() { return []; }
}

class MemoryQueue {
  jobs: any[] = [];
  async enqueue(payload: any) { const job = { id: `job_${this.jobs.length + 1}`, payload: { ...payload, jobId: `job_${this.jobs.length + 1}`, createdAt: "2026-05-30T00:00:00.000Z" }, attempts: 1, maxAttempts: 3 }; this.jobs.push(job); return job.payload; }
  async claim() { return this.jobs[0]; }
  async ack() { this.jobs.shift(); }
  async fail() {}
  async retry() {}
  async discard() { this.jobs.shift(); }
  async getJob(id: string) { return this.jobs.find((j) => j.id === id); }
}

describe("HostedWorkerService", () => {
  it("runs hosted fake job", async () => {
    const queue = new MemoryQueue();
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const run = await runs.create({
      id: "run_1",
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "task",
      status: "queued",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "fake.deterministic",
      createdAt: "2026-05-30T00:00:00.000Z"
    });
    await queue.enqueue({ runId: run.id, placement: "hosted", runtimeMode: "fake.deterministic" });

    const svc = new HostedWorkerService({
      queue: queue as any,
      runs,
      events,
      hostedRuntimeAllowlist: ["fake.deterministic"],
      startRun: async () => {
        await runs.update({ ...run, status: "completed", endedAt: "2026-05-30T00:00:01.000Z" });
        return { ...run, status: "completed", endedAt: "2026-05-30T00:00:01.000Z" } as any;
      },
      now: () => "2026-05-30T00:00:00.000Z"
    });

    const processed = await svc.processNext();
    expect(processed).toBe(true);
    expect((await runs.get("run_1"))?.status).toBe("completed");
  });

  it("rejects non-fake runtime from durable row", async () => {
    const queue = new MemoryQueue();
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    await runs.create({
      id: "run_2",
      runtime: "codex",
      provider: "openai",
      model: "gpt",
      adapterType: "process",
      cwd: "/repo",
      task: "task",
      status: "queued",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "codex.exec_json",
      createdAt: "2026-05-30T00:00:00.000Z"
    });
    await queue.enqueue({ runId: "run_2", placement: "hosted", runtimeMode: "codex.exec_json" });

    const svc = new HostedWorkerService({
      queue: queue as any,
      runs,
      events,
      hostedRuntimeAllowlist: ["fake.deterministic"],
      startRun: async () => {
        throw new Error("must not start");
      },
      now: () => "2026-05-30T00:00:00.000Z"
    });

    await svc.processNext();
    expect((await runs.get("run_2"))?.status).toBe("failed");
  });
});
