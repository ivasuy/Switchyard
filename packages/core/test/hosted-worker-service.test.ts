import { describe, expect, it } from "vitest";
import { HostedWorkerService } from "../src/services/hosted-worker-service.js";

class InMemoryRunStore {
  items = new Map<string, any>();
  async create(run: any) { this.items.set(run.id, run); return run; }
  async get(id: string) { return this.items.get(id); }
  async update(run: any) { this.items.set(run.id, run); return run; }
  async updatePreparedMetadataIfMatch(input: any) {
    const current = this.items.get(input.expected.id);
    if (!current) {
      return { ok: false, reason: "not_found" };
    }
    const sameIdentity =
      current.status === input.expected.status &&
      current.placement === input.expected.placement &&
      current.runtime === input.expected.runtime &&
      current.runtimeMode === input.expected.runtimeMode &&
      current.provider === input.expected.provider &&
      current.adapterType === input.expected.adapterType;
    if (!sameIdentity) {
      return { ok: false, reason: "identity_mismatch" };
    }
    const next = { ...current, metadata: input.metadata ?? {} };
    this.items.set(next.id, next);
    return { ok: true, run: next };
  }
  async list() { return { runs: [...this.items.values()], nextCursor: null }; }
}

class MutatingRunStore extends InMemoryRunStore {
  mutateBeforeNextGuardedUpdate?: (input: any) => Promise<void> | void;

  override async updatePreparedMetadataIfMatch(input: any) {
    if (this.mutateBeforeNextGuardedUpdate) {
      const mutate = this.mutateBeforeNextGuardedUpdate;
      this.mutateBeforeNextGuardedUpdate = undefined;
      await mutate(input);
    }
    return super.updatePreparedMetadataIfMatch(input);
  }
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
      deploymentMode: "test",
      hostedRealRuntimeExecution: "disabled",
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
      deploymentMode: "test",
      hostedRealRuntimeExecution: "disabled",
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
      deploymentMode: "test",
      hostedRealRuntimeExecution: "disabled",
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
      deploymentMode: "test",
      hostedRealRuntimeExecution: "disabled",
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

  it("prepares codex hosted run metadata and starts exactly once", async () => {
    const queue = new MemoryQueue();
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const run = await runs.create({
      id: "run_codex_prepare_1",
      runtime: "codex",
      provider: "openai",
      model: "gpt-5",
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
    await queue.enqueue({ runId: run.id, placement: "hosted", runtimeMode: "codex.exec_json" });

    let starts = 0;
    const svc = new HostedWorkerService({
      queue: queue as any,
      runs,
      events,
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      deploymentMode: "staging",
      hostedRealRuntimeExecution: "enabled",
      startRun: async (runId) => {
        starts += 1;
        const current = await runs.get(runId);
        await runs.update({
          ...current,
          status: "completed",
          endedAt: "2026-05-30T00:00:01.000Z"
        });
        return (await runs.get(runId)) as any;
      },
      now: () => "2026-05-30T00:00:00.000Z"
    });

    const processed = await svc.processNext();
    expect(processed).toBe(true);
    expect(starts).toBe(1);
    expect((await runs.get(run.id))?.metadata).toMatchObject({ sandbox: "read-only" });
  });

  it("fails hosted run when durable row changes before prepared metadata persist", async () => {
    const queue = new MemoryQueue();
    const runs = new MutatingRunStore();
    const events = new InMemoryEventStore();
    const run = await runs.create({
      id: "run_codex_guard_1",
      runtime: "codex",
      provider: "openai",
      model: "gpt-5",
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
    await queue.enqueue({ runId: run.id, placement: "hosted", runtimeMode: "codex.exec_json" });

    runs.mutateBeforeNextGuardedUpdate = async () => {
      const current = await runs.get(run.id);
      await runs.update({
        ...current,
        status: "cancelled",
        endedAt: "2026-05-30T00:00:05.000Z"
      });
    };

    let started = 0;
    const svc = new HostedWorkerService({
      queue: queue as any,
      runs,
      events,
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      deploymentMode: "staging",
      hostedRealRuntimeExecution: "enabled",
      startRun: async () => {
        started += 1;
        return (await runs.get(run.id)) as any;
      },
      now: () => "2026-05-30T00:00:10.000Z"
    });

    await svc.processNext();
    expect(started).toBe(0);
    expect((await runs.get(run.id))?.status).toBe("failed");
    expect(events.items.at(-1)?.payload?.reasonCode).toBe("hosted_run_state_invalid");
    expect((await queue.getJob("job_1"))?.failure?.reasonCode).toBe("hosted_run_state_invalid");
  });

  it("rejects tampered queue runtime mode before adapter start", async () => {
    const queue = new MemoryQueue();
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const run = await runs.create({
      id: "run_codex_tampered_1",
      runtime: "codex",
      provider: "openai",
      model: "gpt-5",
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
    await queue.enqueue({ runId: run.id, placement: "hosted", runtimeMode: "opencode.acp" });

    const svc = new HostedWorkerService({
      queue: queue as any,
      runs,
      events,
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json", "opencode.acp"],
      deploymentMode: "staging",
      hostedRealRuntimeExecution: "enabled",
      startRun: async () => {
        throw new Error("must_not_start");
      },
      now: () => "2026-05-30T00:00:00.000Z"
    });

    await svc.processNext();
    expect((await runs.get(run.id))?.status).toBe("failed");
    expect(events.items.at(-1)?.payload?.reasonCode).toBe("hosted_run_state_invalid");
  });

  it("revalidates production provider activation before adapter start", async () => {
    const queue = new MemoryQueue();
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const run = await runs.create({
      id: "run_provider_revalidate_1",
      runtime: "codex",
      provider: "openai",
      model: "gpt-5",
      adapterType: "process",
      cwd: "/srv/switchyard/work/repo",
      task: "task",
      status: "queued",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: { sandbox: "read-only" },
      runtimeMode: "codex.exec_json",
      createdAt: "2026-05-30T00:00:00.000Z"
    });
    await queue.enqueue({ runId: run.id, placement: "hosted", runtimeMode: "codex.exec_json" });

    let started = 0;
    const svc = new HostedWorkerService({
      queue: queue as any,
      runs,
      events,
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      deploymentMode: "production",
      hostedRealRuntimeExecution: "enabled",
      providerActivation: {
        valid: false,
        enabledRealModes: [],
        reasons: [{ code: "provider_runtime_policy_disabled", runtimeMode: "codex.exec_json" }],
        redactedSummary: {
          deploymentMode: "production",
          hostedRealRuntimeExecution: "enabled",
          realModeCount: 1,
          enabledRealModeCount: 0,
          source: { kind: "json" },
          modeStatuses: [
            { runtimeMode: "codex.exec_json", ready: false, reasons: ["provider_runtime_policy_disabled"] }
          ],
          reasonCodes: ["provider_runtime_policy_disabled"]
        }
      },
      startRun: async () => {
        started += 1;
        throw new Error("must_not_start");
      },
      now: () => "2026-05-30T00:00:10.000Z"
    });

    await svc.processNext();
    expect(started).toBe(0);
    expect((await runs.get(run.id))?.status).toBe("failed");
    expect((await queue.getJob("job_1"))?.failure?.reasonCode).toBe("provider_runtime_policy_disabled");
  });

  it("rejects oversized provider prompts before adapter start", async () => {
    const queue = new MemoryQueue();
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const run = await runs.create({
      id: "run_provider_prompt_limit_1",
      runtime: "codex",
      provider: "openai",
      model: "gpt-5",
      adapterType: "process",
      cwd: "/srv/switchyard/work/repo",
      task: "x".repeat(33),
      status: "queued",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: { sandbox: "read-only" },
      runtimeMode: "codex.exec_json",
      createdAt: "2026-05-30T00:00:00.000Z"
    });
    await queue.enqueue({ runId: run.id, placement: "hosted", runtimeMode: "codex.exec_json" });

    let started = 0;
    const svc = new HostedWorkerService({
      queue: queue as any,
      runs,
      events,
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      deploymentMode: "production",
      hostedRealRuntimeExecution: "enabled",
      providerActivation: validCodexActivation({
        spendControls: {
          maxActiveRuns: 5,
          maxRunsPerHour: 10,
          maxRunTimeoutSeconds: 120,
          maxPromptBytes: 32
        }
      }),
      providerEnvironment: { OPENAI_API_KEY: "present", PATH: "/usr/bin" },
      adapterRuntimeModes: new Set(["codex.exec_json"]),
      startRun: async () => {
        started += 1;
        throw new Error("must_not_start");
      },
      now: () => "2026-05-30T00:00:10.000Z"
    });

    await svc.processNext();
    expect(started).toBe(0);
    expect((await runs.get(run.id))?.status).toBe("failed");
    expect((await queue.getJob("job_1"))?.failure?.reasonCode).toBe("provider_prompt_too_large");
  });

  it("rejects provider run when max active runs spend control is exceeded before adapter start", async () => {
    const queue = new MemoryQueue();
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const metrics: string[] = [];
    const run = await runs.create({
      id: "run_provider_active_limit_1",
      runtime: "codex",
      provider: "openai",
      model: "gpt-5",
      adapterType: "process",
      cwd: "/srv/switchyard/work/repo",
      task: "task",
      status: "queued",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: { sandbox: "read-only" },
      runtimeMode: "codex.exec_json",
      createdAt: "2026-05-30T00:00:00.000Z"
    });
    await runs.create({
      id: "run_provider_active_existing_1",
      runtime: "codex",
      provider: "openai",
      model: "gpt-5",
      adapterType: "process",
      cwd: "/srv/switchyard/work/repo",
      task: "running",
      status: "running",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: { sandbox: "read-only" },
      runtimeMode: "codex.exec_json",
      createdAt: "2026-05-30T00:00:00.000Z",
      startedAt: "2026-05-30T00:00:10.000Z"
    });
    await queue.enqueue({ runId: run.id, placement: "hosted", runtimeMode: "codex.exec_json" });

    let started = 0;
    const svc = new HostedWorkerService({
      queue: queue as any,
      runs,
      events,
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      deploymentMode: "production",
      hostedRealRuntimeExecution: "enabled",
      providerActivation: validCodexActivation({
        spendControls: {
          maxActiveRuns: 1,
          maxRunsPerHour: 10,
          maxRunTimeoutSeconds: 120,
          maxPromptBytes: 1024
        }
      }),
      providerEnvironment: { OPENAI_API_KEY: "present", PATH: "/usr/bin" },
      adapterRuntimeModes: new Set(["codex.exec_json"]),
      metrics: { inc: (path) => metrics.push(path) },
      startRun: async () => {
        started += 1;
        throw new Error("must_not_start");
      },
      now: () => "2026-05-30T00:30:00.000Z"
    });

    await svc.processNext();
    expect(started).toBe(0);
    expect((await runs.get(run.id))?.status).toBe("failed");
    const snapshot = await queue.getJob("job_1");
    expect(snapshot?.state).toBe("failed");
    expect(snapshot?.failure?.reasonCode).toBe("provider_spend_limit_exceeded");
    expect(metrics.join("\n")).toContain("outcome.spend_control_denied");
    expect(metrics.join("\n")).toContain("reason.provider_spend_limit_exceeded");
  });

  it("rejects provider run when hourly spend control is exceeded before adapter start", async () => {
    const queue = new MemoryQueue();
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const metrics: string[] = [];
    const run = await runs.create({
      id: "run_provider_hourly_limit_1",
      runtime: "codex",
      provider: "openai",
      model: "gpt-5",
      adapterType: "process",
      cwd: "/srv/switchyard/work/repo",
      task: "task",
      status: "queued",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: { sandbox: "read-only" },
      runtimeMode: "codex.exec_json",
      createdAt: "2026-05-30T00:30:00.000Z"
    });
    await runs.create({
      id: "run_provider_hourly_existing_1",
      runtime: "codex",
      provider: "openai",
      model: "gpt-5",
      adapterType: "process",
      cwd: "/srv/switchyard/work/repo",
      task: "recent",
      status: "completed",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: { sandbox: "read-only" },
      runtimeMode: "codex.exec_json",
      createdAt: "2026-05-30T00:10:00.000Z",
      endedAt: "2026-05-30T00:11:00.000Z"
    });
    await queue.enqueue({ runId: run.id, placement: "hosted", runtimeMode: "codex.exec_json" });

    let started = 0;
    const svc = new HostedWorkerService({
      queue: queue as any,
      runs,
      events,
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      deploymentMode: "production",
      hostedRealRuntimeExecution: "enabled",
      providerActivation: validCodexActivation({
        spendControls: {
          maxActiveRuns: 10,
          maxRunsPerHour: 1,
          maxRunTimeoutSeconds: 120,
          maxPromptBytes: 1024
        }
      }),
      providerEnvironment: { OPENAI_API_KEY: "present", PATH: "/usr/bin" },
      adapterRuntimeModes: new Set(["codex.exec_json"]),
      metrics: { inc: (path) => metrics.push(path) },
      startRun: async () => {
        started += 1;
        throw new Error("must_not_start");
      },
      now: () => "2026-05-30T00:30:00.000Z"
    });

    await svc.processNext();
    expect(started).toBe(0);
    expect((await runs.get(run.id))?.status).toBe("failed");
    const snapshot = await queue.getJob("job_1");
    expect(snapshot?.state).toBe("failed");
    expect(snapshot?.failure?.reasonCode).toBe("provider_spend_limit_exceeded");
    expect(metrics.join("\n")).toContain("outcome.spend_control_denied");
    expect(metrics.join("\n")).toContain("reason.provider_spend_limit_exceeded");
  });

  it("rejects provider run when timeout spend control is exceeded before adapter start", async () => {
    const queue = new MemoryQueue();
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const metrics: string[] = [];
    const run = await runs.create({
      id: "run_provider_timeout_limit_1",
      runtime: "codex",
      provider: "openai",
      model: "gpt-5",
      adapterType: "process",
      cwd: "/srv/switchyard/work/repo",
      task: "task",
      status: "queued",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 301,
      metadata: { sandbox: "read-only" },
      runtimeMode: "codex.exec_json",
      createdAt: "2026-05-30T00:00:00.000Z"
    });
    await queue.enqueue({ runId: run.id, placement: "hosted", runtimeMode: "codex.exec_json" });

    let started = 0;
    const svc = new HostedWorkerService({
      queue: queue as any,
      runs,
      events,
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      deploymentMode: "production",
      hostedRealRuntimeExecution: "enabled",
      providerActivation: validCodexActivation({
        spendControls: {
          maxActiveRuns: 10,
          maxRunsPerHour: 10,
          maxRunTimeoutSeconds: 300,
          maxPromptBytes: 1024
        }
      }),
      providerEnvironment: { OPENAI_API_KEY: "present", PATH: "/usr/bin" },
      adapterRuntimeModes: new Set(["codex.exec_json"]),
      metrics: { inc: (path) => metrics.push(path) },
      startRun: async () => {
        started += 1;
        throw new Error("must_not_start");
      },
      now: () => "2026-05-30T00:30:00.000Z"
    });

    await svc.processNext();
    expect(started).toBe(0);
    expect((await runs.get(run.id))?.status).toBe("failed");
    const snapshot = await queue.getJob("job_1");
    expect(snapshot?.state).toBe("failed");
    expect(snapshot?.failure?.reasonCode).toBe("provider_spend_limit_exceeded");
    expect(metrics.join("\n")).toContain("outcome.spend_control_denied");
    expect(metrics.join("\n")).toContain("reason.provider_spend_limit_exceeded");
  });

  it("does not retry non-retryable provider command denials", async () => {
    const queue = new MemoryQueue();
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const run = await runs.create({
      id: "run_provider_non_retryable_1",
      runtime: "codex",
      provider: "openai",
      model: "gpt-5",
      adapterType: "process",
      cwd: "/srv/switchyard/work/repo",
      task: "task",
      status: "queued",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: { sandbox: "read-only" },
      runtimeMode: "codex.exec_json",
      createdAt: "2026-05-30T00:00:00.000Z"
    });
    await queue.enqueue({ runId: run.id, placement: "hosted", runtimeMode: "codex.exec_json" });

    let starts = 0;
    const svc = new HostedWorkerService({
      queue: queue as any,
      runs,
      events,
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      deploymentMode: "production",
      hostedRealRuntimeExecution: "enabled",
      providerActivation: validCodexActivation(),
      providerEnvironment: { OPENAI_API_KEY: "present", PATH: "/usr/bin" },
      adapterRuntimeModes: new Set(["codex.exec_json"]),
      startRun: async () => {
        starts += 1;
        const error = new Error("provider_command_denied");
        (error as Error & { reasonCode?: string }).reasonCode = "provider_command_denied";
        throw error;
      },
      now: () => "2026-05-30T00:00:00.000Z"
    });

    await svc.processNext();
    expect(starts).toBe(1);
    expect((await queue.getJob("job_1"))?.state).toBe("failed");
    expect((await queue.getJob("job_1"))?.failure?.reasonCode).toBe("provider_command_denied");
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
      deploymentMode: "test",
      hostedRealRuntimeExecution: "disabled",
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

  it("emits provider lifecycle metrics for accepted, denied, failed, timed_out, cancelled, and spend_control_denied", async () => {
    const metrics: string[] = [];
    const now = "2026-05-30T00:00:00.000Z";

    const runAccepted = {
      id: "run_metrics_accept",
      runtime: "codex",
      provider: "openai",
      model: "gpt-5",
      adapterType: "process",
      cwd: "/srv/switchyard/work/repo",
      task: "ok",
      status: "queued",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: { sandbox: "read-only" },
      runtimeMode: "codex.exec_json",
      createdAt: now
    };

    const runSpendDenied = { ...runAccepted, id: "run_metrics_spend", task: "x".repeat(200) };
    const runFailed = { ...runAccepted, id: "run_metrics_failed" };
    const runTimedOut = { ...runAccepted, id: "run_metrics_timeout" };
    const runCancelled = { ...runAccepted, id: "run_metrics_cancelled" };
    const runDenied = { ...runAccepted, id: "run_metrics_denied" };

    const queue = new MemoryQueue();
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    await runs.create(runAccepted);
    await runs.create(runSpendDenied);
    await runs.create(runFailed);
    await runs.create(runTimedOut);
    await runs.create(runCancelled);
    await runs.create(runDenied);
    await queue.enqueue({ runId: runAccepted.id, placement: "hosted", runtimeMode: "codex.exec_json" });
    await queue.enqueue({ runId: runSpendDenied.id, placement: "hosted", runtimeMode: "codex.exec_json" });
    await queue.enqueue({ runId: runFailed.id, placement: "hosted", runtimeMode: "codex.exec_json" });
    await queue.enqueue({ runId: runTimedOut.id, placement: "hosted", runtimeMode: "codex.exec_json" });
    await queue.enqueue({ runId: runCancelled.id, placement: "hosted", runtimeMode: "codex.exec_json" });
    await queue.enqueue({ runId: runDenied.id, placement: "hosted", runtimeMode: "codex.exec_json" });

    let invocation = 0;
    const svc = new HostedWorkerService({
      queue: queue as any,
      runs,
      events,
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      deploymentMode: "production",
      hostedRealRuntimeExecution: "enabled",
      providerActivation: validCodexActivation({
        spendControls: {
          maxActiveRuns: 10,
          maxRunsPerHour: 50,
          maxRunTimeoutSeconds: 120,
          maxPromptBytes: 64
        }
      }),
      providerEnvironment: { OPENAI_API_KEY: "present", PATH: "/usr/bin" },
      adapterRuntimeModes: new Set(["codex.exec_json"]),
      metrics: { inc: (path) => metrics.push(path) },
      startRun: async (runId) => {
        invocation += 1;
        if (runId === "run_metrics_failed") {
          const failed = { ...(await runs.get(runId)), status: "failed", endedAt: "2026-05-30T00:00:01.000Z" };
          await runs.update(failed);
          return failed;
        }
        if (runId === "run_metrics_timeout") {
          const timeout = { ...(await runs.get(runId)), status: "timeout", endedAt: "2026-05-30T00:00:01.000Z" };
          await runs.update(timeout);
          return timeout;
        }
        if (runId === "run_metrics_cancelled") {
          const cancelled = { ...(await runs.get(runId)), status: "cancelled", endedAt: "2026-05-30T00:00:01.000Z" };
          await runs.update(cancelled);
          return cancelled;
        }
        if (runId === "run_metrics_denied") {
          throw Object.assign(new Error("provider_command_denied"), { reasonCode: "provider_command_denied" });
        }
        const completed = { ...(await runs.get(runId)), status: "completed", endedAt: "2026-05-30T00:00:01.000Z" };
        await runs.update(completed);
        return completed;
      },
      now: () => now
    });

    await svc.processNext();
    await svc.processNext();
    await svc.processNext();
    await svc.processNext();
    await svc.processNext();
    await svc.processNext();

    expect(invocation).toBe(5);

    const deniedQueue = new MemoryQueue();
    const deniedRuns = new InMemoryRunStore();
    const deniedEvents = new InMemoryEventStore();
    await deniedRuns.create({
      ...runAccepted,
      id: "run_metrics_policy_denied"
    });
    await deniedQueue.enqueue({
      runId: "run_metrics_policy_denied",
      placement: "hosted",
      runtimeMode: "codex.exec_json"
    });
    const deniedSvc = new HostedWorkerService({
      queue: deniedQueue as any,
      runs: deniedRuns,
      events: deniedEvents,
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      deploymentMode: "production",
      hostedRealRuntimeExecution: "enabled",
      providerActivation: {
        valid: false,
        enabledRealModes: [],
        reasons: [{ code: "provider_runtime_policy_disabled", runtimeMode: "codex.exec_json" }],
        redactedSummary: {
          deploymentMode: "production",
          hostedRealRuntimeExecution: "enabled",
          realModeCount: 1,
          enabledRealModeCount: 0,
          source: { kind: "json" },
          modeStatuses: [{ runtimeMode: "codex.exec_json", ready: false, reasons: ["provider_runtime_policy_disabled"] }],
          reasonCodes: ["provider_runtime_policy_disabled"]
        }
      },
      providerEnvironment: { OPENAI_API_KEY: "present", PATH: "/usr/bin" },
      adapterRuntimeModes: new Set(["codex.exec_json"]),
      metrics: { inc: (path) => metrics.push(path) },
      startRun: async () => {
        throw new Error("must_not_start");
      },
      now: () => now
    });
    await deniedSvc.processNext();

    const joined = metrics.join("\n");
    expect(joined).toContain("outcome.accepted");
    expect(joined).toContain("outcome.denied");
    expect(joined).toContain("outcome.failed");
    expect(joined).toContain("outcome.timed_out");
    expect(joined).toContain("outcome.cancelled");
    expect(joined).toContain("outcome.spend_control_denied");
  });
});

function validCodexActivation(overrides: {
  spendControls?: {
    maxActiveRuns: number;
    maxRunsPerHour: number;
    maxRunTimeoutSeconds: number;
    maxPromptBytes: number;
  };
} = {}) {
  return {
    valid: true as const,
    enabledRealModes: ["codex.exec_json"],
    reasons: [],
    redactedSummary: {
      deploymentMode: "production" as const,
      hostedRealRuntimeExecution: "enabled" as const,
      realModeCount: 1,
      enabledRealModeCount: 1,
      source: { kind: "json" as const },
      modeStatuses: [{ runtimeMode: "codex.exec_json" as const, ready: true, reasons: [] }],
      reasonCodes: []
    },
    policy: {
      version: 1 as const,
      modes: {
        "codex.exec_json": {
          enabled: true,
          executablePath: "/opt/switchyard/bin/codex",
          cwdPrefixes: ["/srv/switchyard/work"],
          envAllowlist: ["OPENAI_API_KEY", "PATH"],
          requiredEnv: ["OPENAI_API_KEY"],
          fixedArgs: ["exec", "--json"],
          allowUserArgs: false as const,
          sandbox: "read_only" as const,
          spendControls: overrides.spendControls ?? {
            maxActiveRuns: 5,
            maxRunsPerHour: 10,
            maxRunTimeoutSeconds: 120,
            maxPromptBytes: 1024
          }
        }
      }
    }
  };
}
