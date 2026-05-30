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
  claimedAt: string;
  leaseUntil: string;
}

export interface QueueFailure {
  reasonCode: string;
  message: string;
}

export type RunQueueJobState = "queued" | "claimed" | "failed" | "exhausted";

export interface RunQueueJobSnapshot {
  id: string;
  payload: RunQueueJobPayload;
  attempts: number;
  maxAttempts: number;
  state: RunQueueJobState;
  claimedAt?: string;
  leaseUntil?: string;
  failure?: QueueFailure;
}

export interface RunQueueRecoveryResult {
  recovered: number;
  exhausted: number;
  invalid: number;
}

export interface RunQueueStats {
  queued: number;
  claimed: number;
  failed: number;
  exhausted: number;
}

export interface RunQueuePort {
  enqueue(payload: Omit<RunQueueJobPayload, "jobId" | "createdAt">, options?: { maxAttempts?: number }): Promise<RunQueueJobPayload>;
  claim(options?: { leaseMs?: number }): Promise<RunQueueClaimedJob | undefined>;
  ack(jobId: string): Promise<void>;
  fail(jobId: string, error: QueueFailure): Promise<void>;
  retry(jobId: string): Promise<void>;
  discard(jobId: string): Promise<void>;
  getJob(jobId: string): Promise<RunQueueJobSnapshot | undefined>;
  recoverStaleClaims(options?: { now?: string }): Promise<RunQueueRecoveryResult>;
  stats(): Promise<RunQueueStats>;
}
