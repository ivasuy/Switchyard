import type { RunQueueClaimedJob, RunQueueJobPayload, RunQueuePort } from "@switchyard/core";
import { MemoryRunQueue } from "./memory-run-queue.js";

interface BullMqOptions {
  redisUrl: string;
  queueName?: string;
}

// R10 keeps the BullMQ adapter surface but uses deterministic in-process behavior
// unless real Redis wiring is explicitly exercised in a dedicated integration layer.
export class BullMqRunQueue implements RunQueuePort {
  private readonly memory = new MemoryRunQueue();

  constructor(private readonly options: BullMqOptions) {
    void this.options;
  }

  async enqueue(payload: Omit<RunQueueJobPayload, "jobId" | "createdAt">, options?: { maxAttempts?: number }): Promise<RunQueueJobPayload> {
    return this.memory.enqueue(payload, options);
  }

  async claim(): Promise<RunQueueClaimedJob | undefined> {
    return this.memory.claim();
  }

  async ack(jobId: string): Promise<void> {
    await this.memory.ack(jobId);
  }

  async fail(jobId: string, error: { reasonCode: string; message: string }): Promise<void> {
    void error;
    await this.memory.fail(jobId, error);
  }

  async retry(jobId: string): Promise<void> {
    await this.memory.retry(jobId);
  }

  async discard(jobId: string): Promise<void> {
    await this.memory.discard(jobId);
  }

  async getJob(jobId: string): Promise<RunQueueClaimedJob | undefined> {
    return this.memory.getJob(jobId);
  }
}
