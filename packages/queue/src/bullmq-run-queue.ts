import { Redis } from "ioredis";
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

interface BullMqOptions {
  redisUrl: string;
  queueName?: string;
  leaseMs?: number;
}

interface StoredJob {
  id: string;
  payload: RunQueueJobPayload;
  attempts: number;
  maxAttempts: number;
  state: "queued" | "claimed" | "failed" | "exhausted";
  claimedAt?: string;
  leaseUntil?: string;
  failure?: QueueFailure;
}

interface StoredToolJob {
  id: string;
  payload: ToolJobPayload;
  attempts: number;
  maxAttempts: number;
  state: "queued" | "claimed" | "failed" | "exhausted";
  claimedAt?: string;
  leaseUntil?: string;
  failure?: QueueFailure;
}

export class BullMqRunQueue implements RunQueuePort, ToolQueuePort {
  private readonly connection: Redis;
  private readonly queueKey: string;
  private readonly jobsKey: string;
  private readonly claimedKey: string;
  private readonly toolQueueKey: string;
  private readonly toolJobsKey: string;
  private readonly toolClaimedKey: string;
  private readonly toolIdempotencyKey: string;

  constructor(private readonly options: BullMqOptions) {
    this.connection = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
    const queueName = options.queueName ?? "switchyard-hosted-runs";
    this.queueKey = `${queueName}:switchyard:queue`;
    this.jobsKey = `${queueName}:switchyard:jobs`;
    this.claimedKey = `${queueName}:switchyard:claimed`;
    this.toolQueueKey = `${queueName}:switchyard:tool:queue`;
    this.toolJobsKey = `${queueName}:switchyard:tool:jobs`;
    this.toolClaimedKey = `${queueName}:switchyard:tool:claimed`;
    this.toolIdempotencyKey = `${queueName}:switchyard:tool:idempotency`;
  }

  async enqueue(payload: Omit<RunQueueJobPayload, "jobId" | "createdAt">, options?: { maxAttempts?: number }): Promise<RunQueueJobPayload> {
    const jobId = `job_${crypto.randomUUID()}`;
    const jobPayload: RunQueueJobPayload = {
      jobId,
      runId: payload.runId,
      placement: payload.placement,
      createdAt: new Date().toISOString()
    };
    if (payload.runtimeMode !== undefined) jobPayload.runtimeMode = payload.runtimeMode;
    const job: StoredJob = {
      id: jobId,
      payload: jobPayload,
      attempts: 0,
      maxAttempts: options?.maxAttempts ?? 3,
      state: "queued"
    };
    await this.connection
      .multi()
      .hset(this.jobsKey, jobId, JSON.stringify(job))
      .rpush(this.queueKey, jobId)
      .exec();
    return jobPayload;
  }

  async claim(options?: { leaseMs?: number }): Promise<RunQueueClaimedJob | undefined> {
    const claimedAt = new Date().toISOString();
    const leaseUntil = new Date(Date.now() + (options?.leaseMs ?? this.options.leaseMs ?? 30_000)).toISOString();
    const raw = await this.connection.eval(
      `
      local jobId = redis.call("LPOP", KEYS[1])
      if not jobId then return nil end
      local rawJob = redis.call("HGET", KEYS[2], jobId)
      if not rawJob then return cjson.encode({invalid=true, id=jobId}) end
      local ok, job = pcall(cjson.decode, rawJob)
      if not ok then
        redis.call("HDEL", KEYS[2], jobId)
        return cjson.encode({invalid=true, id=jobId, reason="queue_payload_invalid"})
      end
      job.state = "claimed"
      job.attempts = (job.attempts or 0) + 1
      job.claimedAt = ARGV[1]
      job.leaseUntil = ARGV[2]
      redis.call("HSET", KEYS[2], jobId, cjson.encode(job))
      redis.call("HSET", KEYS[3], jobId, cjson.encode(job))
      return cjson.encode({id=jobId, job=job})
      `,
      3,
      this.queueKey,
      this.jobsKey,
      this.claimedKey,
      claimedAt,
      leaseUntil
    );
    if (raw === null || raw === undefined) {
      return undefined;
    }

    const decoded = JSON.parse(String(raw)) as { invalid?: boolean; id?: string; job?: StoredJob };
    if (decoded.invalid || !decoded.job || !decoded.id) {
      if (decoded.id) {
        await this.connection.hset(
          this.jobsKey,
          decoded.id,
          JSON.stringify({
            id: decoded.id,
            payload: { jobId: decoded.id, runId: "unknown", placement: "hosted", createdAt: claimedAt },
            attempts: 0,
            maxAttempts: 0,
            state: "failed",
            failure: { reasonCode: "queue_payload_invalid", message: decoded.id }
          } satisfies StoredJob)
        );
      }
      return undefined;
    }
    return toClaimedJob(decoded.id, decoded.job);
  }

  async ack(jobId: string): Promise<void> {
    await this.connection.multi().hdel(this.claimedKey, jobId).hdel(this.jobsKey, jobId).lrem(this.queueKey, 0, jobId).exec();
  }

  async fail(jobId: string, error: QueueFailure): Promise<void> {
    const job = await this.readJob(jobId);
    if (!job) return;
    const updated: StoredJob = {
      ...job,
      state: error.reasonCode === "worker_retry_exhausted" ? "exhausted" : "failed",
      failure: error
    };
    await this.connection.multi().hset(this.jobsKey, jobId, JSON.stringify(updated)).hdel(this.claimedKey, jobId).exec();
  }

  async retry(jobId: string): Promise<void> {
    const job = await this.readJob(jobId);
    if (!job) return;
    const updated: StoredJob = {
      ...job,
      state: "queued",
    };
    delete updated.claimedAt;
    delete updated.leaseUntil;
    await this.connection
      .multi()
      .hset(this.jobsKey, jobId, JSON.stringify(updated))
      .hdel(this.claimedKey, jobId)
      .rpush(this.queueKey, jobId)
      .exec();
  }

  async discard(jobId: string): Promise<void> {
    await this.connection.multi().hdel(this.claimedKey, jobId).hdel(this.jobsKey, jobId).lrem(this.queueKey, 0, jobId).exec();
  }

  async getJob(jobId: string): Promise<RunQueueJobSnapshot | undefined> {
    const job = await this.readJob(jobId);
    return job ? toSnapshot(job) : undefined;
  }

  async recoverStaleClaims(options?: { now?: string }): Promise<RunQueueRecoveryResult> {
    const nowMs = Date.parse(options?.now ?? new Date().toISOString());
    const entries = await this.connection.hgetall(this.claimedKey);
    let recovered = 0;
    let exhausted = 0;
    let invalid = 0;
    const exhaustedClaims: RunQueueRecoveryResult["exhaustedClaims"] = [];
    for (const [jobId, raw] of Object.entries(entries)) {
      let claimed: StoredJob;
      try {
        claimed = JSON.parse(raw) as StoredJob;
      } catch {
        invalid += 1;
        await this.connection.multi().hdel(this.claimedKey, jobId).hset(this.jobsKey, jobId, JSON.stringify({
          id: jobId,
          payload: { jobId, runId: "unknown", placement: "hosted", createdAt: new Date().toISOString() },
          attempts: 0,
          maxAttempts: 0,
          state: "failed",
          failure: { reasonCode: "queue_payload_invalid", message: "invalid_json" }
        } satisfies StoredJob)).exec();
        continue;
      }
      if (!claimed.leaseUntil || Date.parse(claimed.leaseUntil) > nowMs) continue;
      if (claimed.attempts >= claimed.maxAttempts) {
        claimed.state = "exhausted";
        claimed.failure = { reasonCode: "worker_retry_exhausted", message: "lease_expired" };
        exhausted += 1;
        exhaustedClaims.push({ jobId, runId: claimed.payload.runId });
        await this.connection.multi().hdel(this.claimedKey, jobId).hset(this.jobsKey, jobId, JSON.stringify(claimed)).exec();
      } else {
        claimed.state = "queued";
        delete claimed.claimedAt;
        delete claimed.leaseUntil;
        recovered += 1;
        await this.connection
          .multi()
          .hdel(this.claimedKey, jobId)
          .hset(this.jobsKey, jobId, JSON.stringify(claimed))
          .rpush(this.queueKey, jobId)
          .exec();
      }
    }
    return { recovered, exhausted, invalid, exhaustedClaims };
  }

  async stats(): Promise<RunQueueStats> {
    const queued = await this.connection.llen(this.queueKey);
    const claimed = await this.connection.hlen(this.claimedKey);
    const jobs = await this.connection.hvals(this.jobsKey);
    let failed = 0;
    let exhausted = 0;
    for (const raw of jobs) {
      try {
        const job = JSON.parse(raw) as StoredJob;
        if (job.state === "failed") failed += 1;
        if (job.state === "exhausted") exhausted += 1;
      } catch {
        failed += 1;
      }
    }
    return { queued, claimed, failed, exhausted };
  }

  async close(): Promise<void> {
    this.connection.disconnect();
  }

  async enqueueTool(payload: Omit<ToolJobPayload, "jobId" | "createdAt">, options?: { maxAttempts?: number }): Promise<ToolJobPayload> {
    const idempotencyKey = payload.idempotencyKey.trim();
    if (idempotencyKey.length === 0) {
      throw new Error("tool_idempotency_key_required");
    }
    const createdAt = new Date().toISOString();
    const jobId = `tool_job_${crypto.randomUUID()}`;
    const jobPayload: ToolJobPayload = {
      jobId,
      approvalId: payload.approvalId,
      toolInvocationId: payload.toolInvocationId,
      runId: payload.runId,
      placement: payload.placement,
      toolType: payload.toolType,
      executionPlanHash: payload.executionPlanHash,
      idempotencyKey,
      createdAt
    };
    const job: StoredToolJob = {
      id: jobId,
      payload: jobPayload,
      attempts: 0,
      maxAttempts: options?.maxAttempts ?? 3,
      state: "queued"
    };
    const raw = await this.connection.eval(
      `
      local idem = redis.call("HGET", KEYS[4], ARGV[1])
      if idem then
        local rawExisting = redis.call("HGET", KEYS[2], idem)
        if rawExisting then
          return cjson.encode({existing=true, job=cjson.decode(rawExisting)})
        end
        redis.call("HDEL", KEYS[4], ARGV[1])
      end
      redis.call("HSET", KEYS[2], ARGV[2], ARGV[3])
      redis.call("RPUSH", KEYS[1], ARGV[2])
      redis.call("HSET", KEYS[4], ARGV[1], ARGV[2])
      return cjson.encode({existing=false, job=cjson.decode(ARGV[3])})
      `,
      4,
      this.toolQueueKey,
      this.toolJobsKey,
      this.toolClaimedKey,
      this.toolIdempotencyKey,
      idempotencyKey,
      jobId,
      JSON.stringify(job)
    );

    const decoded = JSON.parse(String(raw)) as { existing: boolean; job: StoredToolJob };
    return decoded.job.payload;
  }

  async claimTool(options?: { leaseMs?: number }): Promise<ToolQueueClaimedJob | undefined> {
    const claimedAt = new Date().toISOString();
    const leaseUntil = new Date(Date.now() + (options?.leaseMs ?? this.options.leaseMs ?? 30_000)).toISOString();
    const raw = await this.connection.eval(
      `
      local jobId = redis.call("LPOP", KEYS[1])
      if not jobId then return nil end
      local rawJob = redis.call("HGET", KEYS[2], jobId)
      if not rawJob then return cjson.encode({invalid=true, id=jobId}) end
      local ok, job = pcall(cjson.decode, rawJob)
      if not ok then
        redis.call("HDEL", KEYS[2], jobId)
        return cjson.encode({invalid=true, id=jobId, reason="queue_payload_invalid"})
      end
      job.state = "claimed"
      job.attempts = (job.attempts or 0) + 1
      job.claimedAt = ARGV[1]
      job.leaseUntil = ARGV[2]
      redis.call("HSET", KEYS[2], jobId, cjson.encode(job))
      redis.call("HSET", KEYS[3], jobId, cjson.encode(job))
      return cjson.encode({id=jobId, job=job})
      `,
      3,
      this.toolQueueKey,
      this.toolJobsKey,
      this.toolClaimedKey,
      claimedAt,
      leaseUntil
    );
    if (raw === null || raw === undefined) {
      return undefined;
    }
    const decoded = JSON.parse(String(raw)) as { invalid?: boolean; id?: string; job?: StoredToolJob };
    if (decoded.invalid || !decoded.job || !decoded.id) {
      return undefined;
    }
    return {
      id: decoded.id,
      payload: decoded.job.payload,
      attempts: decoded.job.attempts,
      maxAttempts: decoded.job.maxAttempts,
      claimedAt: decoded.job.claimedAt ?? claimedAt,
      leaseUntil: decoded.job.leaseUntil ?? leaseUntil
    };
  }

  async ackTool(jobId: string): Promise<void> {
    const job = await this.readToolJob(jobId);
    const multi = this.connection.multi().hdel(this.toolClaimedKey, jobId).hdel(this.toolJobsKey, jobId).lrem(this.toolQueueKey, 0, jobId);
    if (job) {
      multi.hdel(this.toolIdempotencyKey, job.payload.idempotencyKey);
    }
    await multi.exec();
  }

  async failTool(jobId: string, error: QueueFailure): Promise<void> {
    const job = await this.readToolJob(jobId);
    if (!job) return;
    const updated: StoredToolJob = {
      ...job,
      state: error.reasonCode === "worker_retry_exhausted" ? "exhausted" : "failed",
      failure: error
    };
    await this.connection.multi().hset(this.toolJobsKey, jobId, JSON.stringify(updated)).hdel(this.toolClaimedKey, jobId).exec();
  }

  async retryTool(jobId: string): Promise<void> {
    const job = await this.readToolJob(jobId);
    if (!job) return;
    const updated: StoredToolJob = { ...job, state: "queued" };
    delete updated.claimedAt;
    delete updated.leaseUntil;
    await this.connection
      .multi()
      .hset(this.toolJobsKey, jobId, JSON.stringify(updated))
      .hdel(this.toolClaimedKey, jobId)
      .rpush(this.toolQueueKey, jobId)
      .exec();
  }

  async discardTool(jobId: string): Promise<void> {
    const job = await this.readToolJob(jobId);
    const multi = this.connection.multi().hdel(this.toolClaimedKey, jobId).hdel(this.toolJobsKey, jobId).lrem(this.toolQueueKey, 0, jobId);
    if (job) {
      multi.hdel(this.toolIdempotencyKey, job.payload.idempotencyKey);
    }
    await multi.exec();
  }

  async getToolJob(jobId: string): Promise<ToolQueueJobSnapshot | undefined> {
    const job = await this.readToolJob(jobId);
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

  async hasLiveToolClaim(toolInvocationId: string, options?: { now?: string }): Promise<boolean> {
    const nowMs = Date.parse(options?.now ?? new Date().toISOString());
    const entries = await this.connection.hvals(this.toolClaimedKey);
    for (const raw of entries) {
      let claimed: StoredToolJob;
      try {
        claimed = JSON.parse(raw) as StoredToolJob;
      } catch {
        continue;
      }
      if (claimed.payload.toolInvocationId !== toolInvocationId) {
        continue;
      }
      if (!claimed.leaseUntil) {
        continue;
      }
      if (Date.parse(claimed.leaseUntil) <= nowMs) {
        continue;
      }
      return true;
    }
    return false;
  }

  async recoverStaleToolClaims(options?: { now?: string }): Promise<ToolQueueRecoveryResult> {
    const nowMs = Date.parse(options?.now ?? new Date().toISOString());
    const entries = await this.connection.hgetall(this.toolClaimedKey);
    let recovered = 0;
    let exhausted = 0;
    let invalid = 0;
    const exhaustedClaims: ToolQueueRecoveryResult["exhaustedClaims"] = [];
    for (const [jobId, raw] of Object.entries(entries)) {
      let claimed: StoredToolJob;
      try {
        claimed = JSON.parse(raw) as StoredToolJob;
      } catch {
        invalid += 1;
        await this.connection.multi().hdel(this.toolClaimedKey, jobId).hdel(this.toolJobsKey, jobId).exec();
        continue;
      }
      if (!claimed.leaseUntil || Date.parse(claimed.leaseUntil) > nowMs) continue;
      if (claimed.attempts >= claimed.maxAttempts) {
        claimed.state = "exhausted";
        claimed.failure = { reasonCode: "worker_retry_exhausted", message: "lease_expired" };
        exhausted += 1;
        exhaustedClaims.push({ jobId, runId: claimed.payload.runId, toolInvocationId: claimed.payload.toolInvocationId });
        await this.connection.multi().hdel(this.toolClaimedKey, jobId).hset(this.toolJobsKey, jobId, JSON.stringify(claimed)).exec();
      } else {
        claimed.state = "queued";
        delete claimed.claimedAt;
        delete claimed.leaseUntil;
        recovered += 1;
        await this.connection
          .multi()
          .hdel(this.toolClaimedKey, jobId)
          .hset(this.toolJobsKey, jobId, JSON.stringify(claimed))
          .rpush(this.toolQueueKey, jobId)
          .exec();
      }
    }
    return { recovered, exhausted, invalid, exhaustedClaims };
  }

  async toolStats(): Promise<ToolQueueStats> {
    const queued = await this.connection.llen(this.toolQueueKey);
    const claimed = await this.connection.hlen(this.toolClaimedKey);
    const jobs = await this.connection.hvals(this.toolJobsKey);
    let failed = 0;
    let exhausted = 0;
    for (const raw of jobs) {
      try {
        const job = JSON.parse(raw) as StoredToolJob;
        if (job.state === "failed") failed += 1;
        if (job.state === "exhausted") exhausted += 1;
      } catch {
        failed += 1;
      }
    }
    return { queued, claimed, failed, exhausted };
  }

  private async readJob(jobId: string): Promise<StoredJob | undefined> {
    const raw = await this.connection.hget(this.jobsKey, jobId);
    if (!raw) return undefined;
    return JSON.parse(raw) as StoredJob;
  }

  private async readToolJob(jobId: string): Promise<StoredToolJob | undefined> {
    const raw = await this.connection.hget(this.toolJobsKey, jobId);
    if (!raw) return undefined;
    return JSON.parse(raw) as StoredToolJob;
  }
}

function toSnapshot(job: StoredJob): RunQueueJobSnapshot {
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

function toClaimedJob(id: string, job: StoredJob): RunQueueClaimedJob {
  return {
    id,
    payload: job.payload,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    claimedAt: job.claimedAt ?? new Date().toISOString(),
    leaseUntil: job.leaseUntil ?? new Date().toISOString()
  };
}
