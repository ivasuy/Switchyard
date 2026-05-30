export interface RunQueueJobPayload {
  jobId: string;
  runId: string;
  placement: "local" | "hosted" | "connected_local_node";
  runtimeMode?: string;
  createdAt: string;
}

export interface RunQueueClaimedJob {
  id: string;
  payload: RunQueueJobPayload;
  attempts: number;
  maxAttempts: number;
}

export interface RunQueuePort {
  enqueue(payload: Omit<RunQueueJobPayload, "jobId" | "createdAt">, options?: { maxAttempts?: number }): Promise<RunQueueJobPayload>;
  claim(): Promise<RunQueueClaimedJob | undefined>;
  ack(jobId: string): Promise<void>;
  fail(jobId: string, error: { reasonCode: string; message: string }): Promise<void>;
  retry(jobId: string): Promise<void>;
  discard(jobId: string): Promise<void>;
  getJob(jobId: string): Promise<RunQueueClaimedJob | undefined>;
}
