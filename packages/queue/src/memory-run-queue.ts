import type {
  QueueFailure,
  RunQueueClaimedJob,
  RunQueueJobPayload,
  RunQueueJobSnapshot,
  RunQueuePort,
  RunQueueRecoveryResult,
  RunQueueStats,
  ToolJobPayload,
  ToolQueueClaimedJob,
  ToolQueueJobSnapshot,
  ToolQueuePort,
  ToolQueueRecoveryResult,
  ToolQueueStats
} from "@switchyard/core";

interface InternalJob {
  id: string;
  payload: RunQueueJobPayload;
  attempts: number;
  maxAttempts: number;
  state: "queued" | "claimed" | "failed" | "exhausted";
  claimedAt?: string;
  leaseUntil?: string;
  failure?: QueueFailure;
}

interface InternalToolJob {
  id: string;
  payload: ToolJobPayload;
  attempts: number;
  maxAttempts: number;
  state: "queued" | "claimed" | "failed" | "exhausted";
  claimedAt?: string;
  leaseUntil?: string;
  failure?: QueueFailure;
}

export class MemoryRunQueue implements RunQueuePort, ToolQueuePort {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly order: string[] = [];
  private readonly toolJobs = new Map<string, InternalToolJob>();
  private readonly toolOrder: string[] = [];
  private readonly toolIdempotencyIndex = new Map<string, string>();
  private readonly now: () => string;
  private readonly defaultLeaseMs: number;

  constructor(options?: { now?: () => string; leaseMs?: number }) {
    this.now = options?.now ?? (() => new Date().toISOString());
    this.defaultLeaseMs = options?.leaseMs ?? 30_000;
  }

  async enqueue(payload: Omit<RunQueueJobPayload, "jobId" | "createdAt">, options?: { maxAttempts?: number }): Promise<RunQueueJobPayload> {
    const jobId = `job_${crypto.randomUUID()}`;
    const jobPayload: RunQueueJobPayload = {
      jobId,
      runId: payload.runId,
      placement: payload.placement,
      createdAt: new Date().toISOString()
    };
    if (payload.runtimeMode !== undefined) {
      jobPayload.runtimeMode = payload.runtimeMode;
    }
    this.jobs.set(jobId, {
      id: jobId,
      payload: jobPayload,
      attempts: 0,
      maxAttempts: options?.maxAttempts ?? 3,
      state: "queued"
    });
    this.order.push(jobId);
    return jobPayload;
  }

  async claim(options?: { leaseMs?: number }): Promise<RunQueueClaimedJob | undefined> {
    for (const id of this.order) {
      const job = this.jobs.get(id);
      if (!job || job.state !== "queued") continue;
      const claimedAt = this.now();
      job.state = "claimed";
      job.attempts += 1;
      job.claimedAt = claimedAt;
      job.leaseUntil = new Date(Date.parse(claimedAt) + (options?.leaseMs ?? this.defaultLeaseMs)).toISOString();
      delete job.failure;
      return {
        id: job.id,
        payload: job.payload,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        claimedAt: job.claimedAt,
        leaseUntil: job.leaseUntil
      };
    }
    return undefined;
  }

  async ack(jobId: string): Promise<void> {
    this.jobs.delete(jobId);
    this.removeFromOrder(jobId);
  }

  async fail(jobId: string, error: QueueFailure): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.state = error.reasonCode === "worker_retry_exhausted" ? "exhausted" : "failed";
    job.failure = error;
  }

  async retry(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.state = "queued";
    delete job.claimedAt;
    delete job.leaseUntil;
  }

  async discard(jobId: string): Promise<void> {
    this.jobs.delete(jobId);
    this.removeFromOrder(jobId);
  }

  async getJob(jobId: string): Promise<RunQueueJobSnapshot | undefined> {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    const snapshot: RunQueueJobSnapshot = {
      id: job.id,
      payload: job.payload,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      state: job.state
    };
    if (job.claimedAt) snapshot.claimedAt = job.claimedAt;
    if (job.leaseUntil) snapshot.leaseUntil = job.leaseUntil;
    if (job.failure) snapshot.failure = job.failure;
    return snapshot;
  }

  async recoverStaleClaims(options?: { now?: string }): Promise<RunQueueRecoveryResult> {
    const nowIso = options?.now ?? this.now();
    const now = Date.parse(nowIso);
    let recovered = 0;
    let exhausted = 0;
    let invalid = 0;
    const exhaustedClaims: RunQueueRecoveryResult["exhaustedClaims"] = [];
    for (const job of this.jobs.values()) {
      if (job.state !== "claimed") continue;
      if (!job.leaseUntil) {
        invalid += 1;
        job.state = "failed";
        job.failure = { reasonCode: "queue_payload_invalid", message: "missing_lease_until" };
        continue;
      }
      if (Date.parse(job.leaseUntil) > now) continue;
      if (job.attempts >= job.maxAttempts) {
        job.state = "exhausted";
        job.failure = { reasonCode: "worker_retry_exhausted", message: "lease_expired" };
        exhausted += 1;
        exhaustedClaims.push({ jobId: job.id, runId: job.payload.runId });
      } else {
        job.state = "queued";
        delete job.claimedAt;
        delete job.leaseUntil;
        recovered += 1;
      }
    }
    return { recovered, exhausted, invalid, exhaustedClaims };
  }

  async stats(): Promise<RunQueueStats> {
    let queued = 0;
    let claimed = 0;
    let failed = 0;
    let exhausted = 0;
    for (const job of this.jobs.values()) {
      if (job.state === "queued") queued += 1;
      if (job.state === "claimed") claimed += 1;
      if (job.state === "failed") failed += 1;
      if (job.state === "exhausted") exhausted += 1;
    }
    return { queued, claimed, failed, exhausted };
  }

  async enqueueTool(payload: Omit<ToolJobPayload, "jobId" | "createdAt">, options?: { maxAttempts?: number }): Promise<ToolJobPayload> {
    const key = payload.idempotencyKey.trim();
    if (key.length === 0) {
      throw new Error("tool_idempotency_key_required");
    }

    const existingId = this.toolIdempotencyIndex.get(key);
    if (existingId) {
      const existing = this.toolJobs.get(existingId);
      if (existing) {
        return existing.payload;
      }
      this.toolIdempotencyIndex.delete(key);
    }

    const jobId = `tool_job_${crypto.randomUUID()}`;
    const jobPayload: ToolJobPayload = {
      jobId,
      approvalId: payload.approvalId,
      toolInvocationId: payload.toolInvocationId,
      runId: payload.runId,
      placement: payload.placement,
      toolType: payload.toolType,
      executionPlanHash: payload.executionPlanHash,
      idempotencyKey: key,
      createdAt: new Date().toISOString()
    };
    this.toolJobs.set(jobId, {
      id: jobId,
      payload: jobPayload,
      attempts: 0,
      maxAttempts: options?.maxAttempts ?? 3,
      state: "queued"
    });
    this.toolOrder.push(jobId);
    this.toolIdempotencyIndex.set(key, jobId);
    return jobPayload;
  }

  async claimTool(options?: { leaseMs?: number }): Promise<ToolQueueClaimedJob | undefined> {
    for (const id of this.toolOrder) {
      const job = this.toolJobs.get(id);
      if (!job || job.state !== "queued") continue;
      const claimedAt = this.now();
      job.state = "claimed";
      job.attempts += 1;
      job.claimedAt = claimedAt;
      job.leaseUntil = new Date(Date.parse(claimedAt) + (options?.leaseMs ?? this.defaultLeaseMs)).toISOString();
      delete job.failure;
      return {
        id: job.id,
        payload: job.payload,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        claimedAt: job.claimedAt,
        leaseUntil: job.leaseUntil
      };
    }
    return undefined;
  }

  async ackTool(jobId: string): Promise<void> {
    const job = this.toolJobs.get(jobId);
    if (job) {
      this.toolIdempotencyIndex.delete(job.payload.idempotencyKey);
    }
    this.toolJobs.delete(jobId);
    this.removeFromToolOrder(jobId);
  }

  async failTool(jobId: string, error: QueueFailure): Promise<void> {
    const job = this.toolJobs.get(jobId);
    if (!job) return;
    job.state = error.reasonCode === "worker_retry_exhausted" ? "exhausted" : "failed";
    job.failure = error;
  }

  async retryTool(jobId: string): Promise<void> {
    const job = this.toolJobs.get(jobId);
    if (!job) return;
    job.state = "queued";
    delete job.claimedAt;
    delete job.leaseUntil;
  }

  async discardTool(jobId: string): Promise<void> {
    const job = this.toolJobs.get(jobId);
    if (job) {
      this.toolIdempotencyIndex.delete(job.payload.idempotencyKey);
    }
    this.toolJobs.delete(jobId);
    this.removeFromToolOrder(jobId);
  }

  async getToolJob(jobId: string): Promise<ToolQueueJobSnapshot | undefined> {
    const job = this.toolJobs.get(jobId);
    if (!job) return undefined;
    const snapshot: ToolQueueJobSnapshot = {
      id: job.id,
      payload: job.payload,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      state: job.state
    };
    if (job.claimedAt) snapshot.claimedAt = job.claimedAt;
    if (job.leaseUntil) snapshot.leaseUntil = job.leaseUntil;
    if (job.failure) snapshot.failure = job.failure;
    return snapshot;
  }

  async recoverStaleToolClaims(options?: { now?: string }): Promise<ToolQueueRecoveryResult> {
    const nowIso = options?.now ?? this.now();
    const now = Date.parse(nowIso);
    let recovered = 0;
    let exhausted = 0;
    let invalid = 0;
    const exhaustedClaims: ToolQueueRecoveryResult["exhaustedClaims"] = [];
    for (const job of this.toolJobs.values()) {
      if (job.state !== "claimed") continue;
      if (!job.leaseUntil) {
        invalid += 1;
        job.state = "failed";
        job.failure = { reasonCode: "queue_payload_invalid", message: "missing_lease_until" };
        continue;
      }
      if (Date.parse(job.leaseUntil) > now) continue;
      if (job.attempts >= job.maxAttempts) {
        job.state = "exhausted";
        job.failure = { reasonCode: "worker_retry_exhausted", message: "lease_expired" };
        exhausted += 1;
        exhaustedClaims.push({ jobId: job.id, runId: job.payload.runId, toolInvocationId: job.payload.toolInvocationId });
      } else {
        job.state = "queued";
        delete job.claimedAt;
        delete job.leaseUntil;
        recovered += 1;
      }
    }
    return { recovered, exhausted, invalid, exhaustedClaims };
  }

  async toolStats(): Promise<ToolQueueStats> {
    let queued = 0;
    let claimed = 0;
    let failed = 0;
    let exhausted = 0;
    for (const job of this.toolJobs.values()) {
      if (job.state === "queued") queued += 1;
      if (job.state === "claimed") claimed += 1;
      if (job.state === "failed") failed += 1;
      if (job.state === "exhausted") exhausted += 1;
    }
    return { queued, claimed, failed, exhausted };
  }

  private removeFromOrder(jobId: string): void {
    const idx = this.order.indexOf(jobId);
    if (idx >= 0) this.order.splice(idx, 1);
  }

  private removeFromToolOrder(jobId: string): void {
    const idx = this.toolOrder.indexOf(jobId);
    if (idx >= 0) this.toolOrder.splice(idx, 1);
  }
}
