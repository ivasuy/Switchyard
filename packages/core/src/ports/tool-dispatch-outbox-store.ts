export type ToolDispatchTargetPlacement = "hosted" | "connected_local_node";

export type ToolDispatchOutboxStatus = "pending" | "dispatching" | "dispatched" | "failed_retryable";

export interface ToolDispatchOutboxRecord {
  id: string;
  approvalId: string;
  toolInvocationId: string;
  runId: string;
  targetPlacement: ToolDispatchTargetPlacement;
  executionPlanHash: string;
  dispatchStatus: ToolDispatchOutboxStatus;
  attemptCount: number;
  lastErrorCode?: string;
  dispatchId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertToolDispatchOutboxInput {
  approvalId: string;
  toolInvocationId: string;
  runId: string;
  targetPlacement: ToolDispatchTargetPlacement;
  executionPlanHash: string;
  now?: string;
}

export interface ToolDispatchOutboxStore {
  upsertByApprovalAndInvocation(input: UpsertToolDispatchOutboxInput): Promise<ToolDispatchOutboxRecord>;
  getByApprovalAndInvocation(approvalId: string, toolInvocationId: string): Promise<ToolDispatchOutboxRecord | undefined>;
  markDispatching(id: string, now?: string): Promise<ToolDispatchOutboxRecord | undefined>;
  markDispatched(id: string, dispatchId: string, now?: string): Promise<ToolDispatchOutboxRecord | undefined>;
  markFailedRetryable(id: string, reasonCode: string, now?: string): Promise<ToolDispatchOutboxRecord | undefined>;
  listRetryable(limit: number): Promise<ToolDispatchOutboxRecord[]>;
}
