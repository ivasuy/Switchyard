export type DebateExecutionStage = string;
export type DebateExecutionPhase = string;

export type DebateExecutionJobState = "queued" | "claimed" | "completed" | "failed" | "exhausted";

export interface DebateExecutionJob {
  id: string;
  debateId: string;
  stage: DebateExecutionStage;
  debateRound: number;
  debatePhase: DebateExecutionPhase;
  participantIndex?: number;
  pendingRunId?: string;
  pendingJudgeRunId?: string;
  pendingChildRunKey?: string;
  state: DebateExecutionJobState;
  attempts: number;
  maxAttempts: number;
  claimedAt?: string;
  leaseUntil?: string;
  nextAttemptAt: string;
  reasonCode?: string;
  accountId?: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  apiKeyId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueDebateExecutionJobInput {
  id?: string;
  debateId: string;
  stage: DebateExecutionStage;
  debateRound?: number;
  debatePhase?: DebateExecutionPhase;
  participantIndex?: number;
  maxAttempts?: number;
  nextAttemptAt?: string;
  pendingRunId?: string;
  pendingJudgeRunId?: string;
  pendingChildRunKey?: string;
  accountId?: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  apiKeyId?: string;
  now?: string;
}

export interface ClaimDebateExecutionJobInput {
  now?: string;
  leaseMs?: number;
}

export interface ReleaseDebateExecutionJobInput {
  nextAttemptAt?: string;
  reasonCode?: string;
  now?: string;
}

export interface FailDebateExecutionJobInput {
  reasonCode: string;
  retryable?: boolean;
  nextAttemptAt?: string;
  now?: string;
}

export interface RecoverStaleDebateExecutionClaimsInput {
  now?: string;
}

export interface LinkPendingRunResultOk {
  ok: true;
  job: DebateExecutionJob;
}

export interface LinkPendingRunResultConflict {
  ok: false;
  reason: "not_found" | "link_conflict";
  job?: DebateExecutionJob;
}

export type LinkPendingRunResult = LinkPendingRunResultOk | LinkPendingRunResultConflict;

export interface PendingRunLink {
  jobId: string;
  debateId: string;
  runId: string;
  stage: DebateExecutionStage;
  debateRound: number;
  debatePhase: DebateExecutionPhase;
  participantIndex?: number;
}

export interface DebateExecutionStore {
  enqueue(input: EnqueueDebateExecutionJobInput): Promise<DebateExecutionJob>;
  claim(options?: ClaimDebateExecutionJobInput): Promise<DebateExecutionJob | undefined>;
  release(jobId: string, update: ReleaseDebateExecutionJobInput): Promise<void>;
  complete(jobId: string, now?: string): Promise<void>;
  fail(jobId: string, failure: FailDebateExecutionJobInput): Promise<void>;
  recoverStaleClaims(options?: RecoverStaleDebateExecutionClaimsInput): Promise<{ recovered: number; exhausted: number; invalid: number }>;
  get(id: string): Promise<DebateExecutionJob | undefined>;
  stats(): Promise<{ queued: number; claimed: number; failed: number; exhausted: number }>;
  linkPendingRun(jobId: string, key: string, runId: string, expectedStage: DebateExecutionStage): Promise<LinkPendingRunResult>;
  findPendingRunByKey(key: string): Promise<PendingRunLink | undefined>;
}
