import type { HostedRuntimeBridgeCommand } from "@switchyard/contracts";

export interface CreateHostedRuntimeBridgeCommandInput {
  runId: string;
  approvalId?: string;
  runtimeSessionId?: string;
  runtimeMode: string;
  operation: HostedRuntimeBridgeCommand["operation"];
  idempotencyKey: string;
  payloadHash: string;
  payloadBytes: number;
  redactedPayload: HostedRuntimeBridgeCommand["redactedPayload"];
  accountId: string;
  tenantId: string;
  projectId: string;
  userId: string;
  apiKeyId: string;
  maxAttempts: number;
  expiresAt: string;
  status?: HostedRuntimeBridgeCommand["status"];
  attempts?: number;
  reasonCode?: string;
  now?: string;
}

export interface ClaimHostedRuntimeBridgeCommandInput {
  workerId: string;
  leaseMs: number;
  now?: string;
}

export interface CompleteHostedRuntimeBridgeCommandInput {
  commandId: string;
  workerId: string;
  result?: Record<string, unknown>;
  now?: string;
}

export interface FailHostedRuntimeBridgeCommandInput {
  commandId: string;
  workerId?: string;
  reasonCode: string;
  retryable: boolean;
  now?: string;
}

export interface ExpireHostedRuntimeBridgeCommandsInput {
  now?: string;
}

export interface RecoverStaleHostedRuntimeBridgeClaimsInput {
  now?: string;
  nonIdempotentPolicy: "fail" | "retry_if_adapter_ack";
}

export interface HostedRuntimeBridgeCommandStore {
  create(
    input: CreateHostedRuntimeBridgeCommandInput
  ): Promise<{ command: HostedRuntimeBridgeCommand; duplicate: boolean }>;
  get(id: string): Promise<HostedRuntimeBridgeCommand | undefined>;
  getByIdempotencyKey(idempotencyKey: string): Promise<HostedRuntimeBridgeCommand | undefined>;
  claimNext(input: ClaimHostedRuntimeBridgeCommandInput): Promise<HostedRuntimeBridgeCommand | undefined>;
  complete(input: CompleteHostedRuntimeBridgeCommandInput): Promise<HostedRuntimeBridgeCommand | null>;
  fail(input: FailHostedRuntimeBridgeCommandInput): Promise<HostedRuntimeBridgeCommand | null>;
  expireStale(input?: ExpireHostedRuntimeBridgeCommandsInput): Promise<{ expired: number }>;
  recoverStaleClaims(input: RecoverStaleHostedRuntimeBridgeClaimsInput): Promise<{ recovered: number; failed: number }>;
}
