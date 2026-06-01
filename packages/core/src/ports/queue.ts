export interface RunQueueJobPayload {
  jobId: string;
  runId: string;
  placement: "local" | "hosted" | "connected_local_node";
  runtimeMode?: string;
  createdAt: string;
}

export interface ToolJobPayload {
  jobId: string;
  approvalId: string;
  toolInvocationId: string;
  runId: string;
  placement: "hosted";
  toolType: "web_search" | "fetch" | "browser" | "repo" | "shell" | "github" | "fake_echo";
  executionPlanHash: string;
  idempotencyKey: string;
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

export interface ToolQueueClaimedJob {
  id: string;
  payload: ToolJobPayload;
  attempts: number;
  maxAttempts: number;
  claimedAt: string;
  leaseUntil: string;
}

export type ToolQueueJobState = "queued" | "claimed" | "failed" | "exhausted";

export interface ToolQueueJobSnapshot {
  id: string;
  payload: ToolJobPayload;
  attempts: number;
  maxAttempts: number;
  state: ToolQueueJobState;
  claimedAt?: string;
  leaseUntil?: string;
  failure?: QueueFailure;
}

export interface RunQueueRecoveryResult {
  recovered: number;
  exhausted: number;
  invalid: number;
  exhaustedClaims: Array<{ jobId: string; runId: string }>;
}

export interface RunQueueStats {
  queued: number;
  claimed: number;
  failed: number;
  exhausted: number;
}

export interface ToolQueueRecoveryResult {
  recovered: number;
  exhausted: number;
  invalid: number;
  exhaustedClaims: Array<{ jobId: string; runId: string; toolInvocationId: string }>;
}

export interface ToolQueueStats {
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

export interface ToolQueuePort {
  enqueueTool(
    payload: Omit<ToolJobPayload, "jobId" | "createdAt">,
    options?: { maxAttempts?: number }
  ): Promise<ToolJobPayload>;
  claimTool(options?: { leaseMs?: number }): Promise<ToolQueueClaimedJob | undefined>;
  ackTool(jobId: string): Promise<void>;
  failTool(jobId: string, error: QueueFailure): Promise<void>;
  retryTool(jobId: string): Promise<void>;
  discardTool(jobId: string): Promise<void>;
  getToolJob(jobId: string): Promise<ToolQueueJobSnapshot | undefined>;
  hasLiveToolClaim(toolInvocationId: string, options?: { now?: string }): Promise<boolean>;
  recoverStaleToolClaims(options?: { now?: string }): Promise<ToolQueueRecoveryResult>;
  toolStats(): Promise<ToolQueueStats>;
}
