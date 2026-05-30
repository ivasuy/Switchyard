import { Redis } from "ioredis";
import type {
  QueueFailure,
  RunQueueClaimedJob,
  RunQueueJobPayload,
  RunQueueJobSnapshot,
  RunQueuePort,
  RunQueueRecoveryResult,
  RunQueueStats
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

export class BullMqRunQueue implements RunQueuePort {
  private readonly connection: Redis;
  private readonly queueKey: string;
  private readonly jobsKey: string;
  private readonly claimedKey: string;

  constructor(private readonly options: BullMqOptions) {
    this.connection = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
    const queueName = options.queueName ?? "switchyard-hosted-runs";
    this.queueKey = `${queueName}:switchyard:queue`;
    this.jobsKey = `${queueName}:switchyard:jobs`;
    this.claimedKey = `${queueName}:switchyard:claimed`;
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

  private async readJob(jobId: string): Promise<StoredJob | undefined> {
    const raw = await this.connection.hget(this.jobsKey, jobId);
    if (!raw) return undefined;
    return JSON.parse(raw) as StoredJob;
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
