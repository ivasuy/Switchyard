import type { RunQueueClaimedJob, RunQueueJobPayload, RunQueuePort } from "@switchyard/core";

interface InternalJob {
  id: string;
  payload: RunQueueJobPayload;
  attempts: number;
  maxAttempts: number;
  state: "queued" | "claimed" | "failed";
}

export class MemoryRunQueue implements RunQueuePort {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly order: string[] = [];

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

  async claim(): Promise<RunQueueClaimedJob | undefined> {
    for (const id of this.order) {
      const job = this.jobs.get(id);
      if (!job || job.state !== "queued") continue;
      job.state = "claimed";
      job.attempts += 1;
      return {
        id: job.id,
        payload: job.payload,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts
      };
    }
    return undefined;
  }

  async ack(jobId: string): Promise<void> {
    this.jobs.delete(jobId);
    this.removeFromOrder(jobId);
  }

  async fail(jobId: string, _error: { reasonCode: string; message: string }): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.state = "failed";
  }

  async retry(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.state = "queued";
  }

  async discard(jobId: string): Promise<void> {
    this.jobs.delete(jobId);
    this.removeFromOrder(jobId);
  }

  async getJob(jobId: string): Promise<RunQueueClaimedJob | undefined> {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    return {
      id: job.id,
      payload: job.payload,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts
    };
  }

  private removeFromOrder(jobId: string): void {
    const idx = this.order.indexOf(jobId);
    if (idx >= 0) this.order.splice(idx, 1);
  }
}
