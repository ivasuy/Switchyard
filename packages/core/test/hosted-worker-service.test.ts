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
  jobs: Array<{ id: string; payload: any; attempts: number; maxAttempts: number; state: "queued" | "claimed" | "failed" | "exhausted"; failure?: any }> = [];
  async enqueue(payload: any) {
    const id = `job_${this.jobs.length + 1}`;
    const job = {
      id,
      payload: { ...payload, jobId: id, createdAt: "2026-05-30T00:00:00.000Z" },
      attempts: 0,
      maxAttempts: 3,
      state: "queued" as const
    };
    this.jobs.push(job);
    return job.payload;
  }
  async claim() {
    const job = this.jobs.find((item) => item.state === "queued");
    if (!job) return undefined;
    job.state = "claimed";
    job.attempts += 1;
    return {
      id: job.id,
      payload: job.payload,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      claimedAt: "2026-05-30T00:00:00.000Z",
      leaseUntil: "2026-05-30T00:00:30.000Z"
    };
  }
  async ack(jobId: string) { this.jobs = this.jobs.filter((job) => job.id !== jobId); }
  async fail(jobId: string, failure: any) {
    const job = this.jobs.find((item) => item.id === jobId);
    if (!job) return;
    job.state = failure?.reasonCode === "worker_retry_exhausted" ? "exhausted" : "failed";
    job.failure = failure;
  }
  async retry(jobId: string) {
    const job = this.jobs.find((item) => item.id === jobId);
    if (!job) return;
    job.state = "queued";
  }
  async discard(jobId: string) { this.jobs = this.jobs.filter((job) => job.id !== jobId); }
  async getJob(id: string) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return undefined;
    return { id: job.id, payload: job.payload, attempts: job.attempts, maxAttempts: job.maxAttempts, state: job.state, failure: job.failure };
  }
  async recoverStaleClaims() { return { recovered: 0, exhausted: 0, invalid: 0, exhaustedClaims: [] }; }
  async stats() {
    return {
      queued: this.jobs.filter((job) => job.state === "queued").length,
      claimed: this.jobs.filter((job) => job.state === "claimed").length,
      failed: this.jobs.filter((job) => job.state === "failed").length,
      exhausted: this.jobs.filter((job) => job.state === "exhausted").length
    };
  }
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
    const snapshot = await queue.getJob("job_1");
    expect(snapshot?.state).toBe("failed");
  });

  it("retries non-exhausted job and succeeds on next tick", async () => {
    const queue = new MemoryQueue();
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const run = await runs.create({
      id: "run_retry_1",
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
    const queued = await queue.enqueue({ runId: run.id, placement: "hosted", runtimeMode: "fake.deterministic" });
    let calls = 0;

    const svc = new HostedWorkerService({
      queue: queue as any,
      runs,
      events,
      hostedRuntimeAllowlist: ["fake.deterministic"],
      startRun: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("transient");
        }
        const completed = { ...run, status: "completed", endedAt: "2026-05-30T00:00:01.000Z" };
        await runs.update(completed);
        return completed as any;
      },
      now: () => "2026-05-30T00:00:00.000Z"
    });

    const first = await svc.processNext();
    expect(first).toBe(true);
    expect((await runs.get(run.id))?.status).toBe("queued");
    const retriedJob = await queue.getJob(queued.jobId);
    expect(retriedJob).toBeDefined();
    expect(retriedJob?.attempts).toBe(1);

    const second = await svc.processNext();
    expect(second).toBe(true);
    expect((await runs.get(run.id))?.status).toBe("completed");
    expect(await queue.getJob(queued.jobId)).toBeUndefined();
  });

  it("keeps exhausted jobs inspectable", async () => {
    const queue = new MemoryQueue();
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    await runs.create({
      id: "run_exhaust_1",
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
    const queued = await queue.enqueue({ runId: "run_exhaust_1", placement: "hosted", runtimeMode: "fake.deterministic" });

    const svc = new HostedWorkerService({
      queue: queue as any,
      runs,
      events,
      hostedRuntimeAllowlist: ["fake.deterministic"],
      startRun: async () => {
        throw new Error("permanent");
      },
      now: () => "2026-05-30T00:00:00.000Z"
    });

    await svc.processNext();
    await svc.processNext();
    await svc.processNext();
    expect((await queue.getJob(queued.jobId))?.state).toBe("exhausted");
  });

  it("fails durable run when stale claimed job is exhausted during recovery", async () => {
    const queue = new MemoryQueue();
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    await runs.create({
      id: "run_stale_exhausted_1",
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "task",
      status: "running",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "fake.deterministic",
      createdAt: "2026-05-30T00:00:00.000Z",
      startedAt: "2026-05-30T00:00:01.000Z"
    });
    await queue.enqueue({ runId: "run_stale_exhausted_1", placement: "hosted", runtimeMode: "fake.deterministic" });
    queue.recoverStaleClaims = async () => ({
      recovered: 0,
      exhausted: 1,
      invalid: 0,
      exhaustedClaims: [{ jobId: "job_1", runId: "run_stale_exhausted_1" }]
    });

    const svc = new HostedWorkerService({
      queue: queue as any,
      runs,
      events,
      hostedRuntimeAllowlist: ["fake.deterministic"],
      startRun: async () => {
        throw new Error("must_not_start");
      },
      now: () => "2026-05-30T00:00:10.000Z"
    });

    const processed = await svc.processNext();
    expect(processed).toBe(false);
    expect((await runs.get("run_stale_exhausted_1"))?.status).toBe("failed");
    expect(events.items.at(-1)?.payload?.reasonCode).toBe("worker_retry_exhausted");
  });
});
