import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { RunQueueClaimedJob, RunQueueJobPayload, RunQueuePort } from "@switchyard/core";

interface BullMqOptions {
  redisUrl: string;
  queueName?: string;
}

interface BullMqJobData {
  payload: RunQueueJobPayload;
  attempts: number;
  maxAttempts: number;
}

export class BullMqRunQueue implements RunQueuePort {
  private readonly connection: Redis;
  private readonly queue: Queue;
  private readonly claimedKey: string;
  private readonly failedKey: string;

  constructor(private readonly options: BullMqOptions) {
    this.connection = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
    const queueName = options.queueName ?? "switchyard-hosted-runs";
    this.queue = new Queue(queueName, { connection: redisConnectionOptions(options.redisUrl) });
    this.claimedKey = `${queueName}:switchyard:claimed`;
    this.failedKey = `${queueName}:switchyard:failed`;
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
    await this.queue.add("run", {
      payload: jobPayload,
      attempts: 0,
      maxAttempts: options?.maxAttempts ?? 3
    }, { jobId, removeOnComplete: true, removeOnFail: false });
    return jobPayload;
  }

  async claim(): Promise<RunQueueClaimedJob | undefined> {
    const waiting = await this.queue.getWaiting(0, 10);
    for (const job of waiting) {
      const data = job.data as BullMqJobData;
      await job.remove();
      const claimed: BullMqJobData = {
        ...data,
        attempts: data.attempts + 1
      };
      await this.connection.hset(this.claimedKey, job.id!, JSON.stringify(claimed));
      return {
        id: job.id!,
        payload: claimed.payload,
        attempts: claimed.attempts,
        maxAttempts: claimed.maxAttempts
      };
    }
    return undefined;
  }

  async ack(jobId: string): Promise<void> {
    await this.connection.hdel(this.claimedKey, jobId);
    await this.connection.hdel(this.failedKey, jobId);
    await this.removeQueued(jobId);
  }

  async fail(jobId: string, error: { reasonCode: string; message: string }): Promise<void> {
    const data = await this.readClaimed(jobId);
    if (data) {
      await this.connection.hdel(this.claimedKey, jobId);
      await this.connection.hset(this.failedKey, jobId, JSON.stringify({ ...data, error }));
    }
  }

  async retry(jobId: string): Promise<void> {
    const data = await this.readClaimed(jobId);
    if (!data) return;
    await this.connection.hdel(this.claimedKey, jobId);
    await this.queue.add("run", data, { jobId, removeOnComplete: true, removeOnFail: false });
  }

  async discard(jobId: string): Promise<void> {
    await this.connection.hdel(this.claimedKey, jobId);
    await this.connection.hdel(this.failedKey, jobId);
    await this.removeQueued(jobId);
  }

  async getJob(jobId: string): Promise<RunQueueClaimedJob | undefined> {
    const claimed = await this.readClaimed(jobId);
    if (claimed) return toClaimedJob(jobId, claimed);
    const failed = await this.connection.hget(this.failedKey, jobId);
    if (failed) return toClaimedJob(jobId, JSON.parse(failed) as BullMqJobData);
    const queued = await this.queue.getJob(jobId);
    return queued ? toClaimedJob(jobId, queued.data as BullMqJobData) : undefined;
  }

  async close(): Promise<void> {
    await this.queue.close();
    this.connection.disconnect();
  }

  private async readClaimed(jobId: string): Promise<BullMqJobData | undefined> {
    const raw = await this.connection.hget(this.claimedKey, jobId);
    return raw ? JSON.parse(raw) as BullMqJobData : undefined;
  }

  private async removeQueued(jobId: string): Promise<void> {
    const job = await this.queue.getJob(jobId);
    await job?.remove();
  }
}

function redisConnectionOptions(redisUrl: string): Record<string, unknown> {
  const parsed = new URL(redisUrl);
  const options: Record<string, unknown> = {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379
  };
  if (parsed.username) options["username"] = decodeURIComponent(parsed.username);
  if (parsed.password) options["password"] = decodeURIComponent(parsed.password);
  const db = parsed.pathname.replace("/", "");
  if (db) options["db"] = Number(db);
  if (parsed.protocol === "rediss:") options["tls"] = {};
  return options;
}

function toClaimedJob(id: string, data: BullMqJobData): RunQueueClaimedJob {
  return {
    id,
    payload: data.payload,
    attempts: data.attempts,
    maxAttempts: data.maxAttempts
  };
}
