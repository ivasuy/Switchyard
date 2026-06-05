import { randomUUID } from "node:crypto";
import type { PostgresDatabaseHandle } from "./database.js";

type QueryRow = Record<string, unknown>;

type ToolDispatchTargetPlacement = "hosted" | "connected_local_node";
type ToolDispatchOutboxStatus = "pending" | "dispatching" | "dispatched" | "failed_retryable";

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

export class PostgresToolDispatchOutboxStore implements ToolDispatchOutboxStore {
  private readonly items = new Map<string, ToolDispatchOutboxRecord>();

  constructor(private readonly handle?: PostgresDatabaseHandle) {}

  async upsertByApprovalAndInvocation(input: UpsertToolDispatchOutboxInput): Promise<ToolDispatchOutboxRecord> {
    if (this.handle) {
      const now = input.now ?? new Date().toISOString();
      const id = `tool_dispatch_${safeId()}`;
      const result = await this.handle.pool.query(
        `INSERT INTO tool_dispatch_outbox (
           id, approval_id, tool_invocation_id, run_id, target_placement, execution_plan_hash,
           dispatch_status, attempt_count, last_error_code, dispatch_id, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (approval_id, tool_invocation_id)
         DO UPDATE SET updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [
          id,
          input.approvalId,
          input.toolInvocationId,
          input.runId,
          input.targetPlacement,
          input.executionPlanHash,
          "pending",
          0,
          null,
          null,
          now,
          now
        ]
      );
      return rowToOutbox(result.rows[0] as QueryRow);
    }

    const now = input.now ?? new Date().toISOString();
    const existing = [...this.items.values()].find(
      (entry) => entry.approvalId === input.approvalId && entry.toolInvocationId === input.toolInvocationId
    );
    if (existing) {
      const updated: ToolDispatchOutboxRecord = { ...existing, updatedAt: now };
      this.items.set(updated.id, updated);
      return updated;
    }

    const record: ToolDispatchOutboxRecord = {
      id: `tool_dispatch_${safeId()}`,
      approvalId: input.approvalId,
      toolInvocationId: input.toolInvocationId,
      runId: input.runId,
      targetPlacement: input.targetPlacement,
      executionPlanHash: input.executionPlanHash,
      dispatchStatus: "pending",
      attemptCount: 0,
      createdAt: now,
      updatedAt: now
    };
    this.items.set(record.id, record);
    return record;
  }

  async getByApprovalAndInvocation(
    approvalId: string,
    toolInvocationId: string
  ): Promise<ToolDispatchOutboxRecord | undefined> {
    if (this.handle) {
      const result = await this.handle.pool.query(
        `SELECT *
         FROM tool_dispatch_outbox
         WHERE approval_id = $1 AND tool_invocation_id = $2
         LIMIT 1`,
        [approvalId, toolInvocationId]
      );
      return result.rows[0] ? rowToOutbox(result.rows[0] as QueryRow) : undefined;
    }

    return [...this.items.values()].find(
      (entry) => entry.approvalId === approvalId && entry.toolInvocationId === toolInvocationId
    );
  }

  async markDispatching(id: string, now?: string): Promise<ToolDispatchOutboxRecord | undefined> {
    return this.patch(id, (current) => ({
      ...current,
      dispatchStatus: "dispatching",
      attemptCount: current.attemptCount + 1,
      updatedAt: now ?? new Date().toISOString()
    }));
  }

  async markDispatched(id: string, dispatchId: string, now?: string): Promise<ToolDispatchOutboxRecord | undefined> {
    return this.patch(id, (current) => {
      const next: ToolDispatchOutboxRecord = {
        ...current,
        dispatchStatus: "dispatched",
        dispatchId,
        updatedAt: now ?? new Date().toISOString()
      };
      delete next.lastErrorCode;
      return next;
    });
  }

  async markFailedRetryable(
    id: string,
    reasonCode: string,
    now?: string
  ): Promise<ToolDispatchOutboxRecord | undefined> {
    return this.patch(id, (current) => ({
      ...current,
      dispatchStatus: "failed_retryable",
      lastErrorCode: reasonCode,
      updatedAt: now ?? new Date().toISOString()
    }));
  }

  async listRetryable(limit: number): Promise<ToolDispatchOutboxRecord[]> {
    if (this.handle) {
      const result = await this.handle.pool.query(
        `SELECT *
         FROM tool_dispatch_outbox
         WHERE dispatch_status IN ('pending', 'failed_retryable')
         ORDER BY updated_at ASC, id ASC
         LIMIT $1`,
        [limit]
      );
      return result.rows.map((row) => rowToOutbox(row as QueryRow));
    }

    return [...this.items.values()]
      .filter((entry) => entry.dispatchStatus === "pending" || entry.dispatchStatus === "failed_retryable")
      .sort((left, right) => (left.updatedAt === right.updatedAt ? left.id.localeCompare(right.id) : left.updatedAt.localeCompare(right.updatedAt)))
      .slice(0, limit);
  }

  private async patch(
    id: string,
    next: (current: ToolDispatchOutboxRecord) => ToolDispatchOutboxRecord
  ): Promise<ToolDispatchOutboxRecord | undefined> {
    if (this.handle) {
      const current = await this.handle.pool.query("SELECT * FROM tool_dispatch_outbox WHERE id = $1 LIMIT 1", [id]);
      if (!current.rows[0]) {
        return undefined;
      }
      const updated = next(rowToOutbox(current.rows[0] as QueryRow));
      const result = await this.handle.pool.query(
        `UPDATE tool_dispatch_outbox
         SET dispatch_status = $2,
             attempt_count = $3,
             last_error_code = $4,
             dispatch_id = $5,
             updated_at = $6
         WHERE id = $1
         RETURNING *`,
        [
          updated.id,
          updated.dispatchStatus,
          updated.attemptCount,
          updated.lastErrorCode ?? null,
          updated.dispatchId ?? null,
          updated.updatedAt
        ]
      );
      return result.rows[0] ? rowToOutbox(result.rows[0] as QueryRow) : undefined;
    }

    const current = this.items.get(id);
    if (!current) {
      return undefined;
    }
    const updated = next(current);
    this.items.set(id, updated);
    return updated;
  }
}

function rowToOutbox(row: QueryRow): ToolDispatchOutboxRecord {
  const value: ToolDispatchOutboxRecord = {
    id: String(row["id"]),
    approvalId: String(row["approval_id"]),
    toolInvocationId: String(row["tool_invocation_id"]),
    runId: String(row["run_id"]),
    targetPlacement: row["target_placement"] as ToolDispatchOutboxRecord["targetPlacement"],
    executionPlanHash: String(row["execution_plan_hash"]),
    dispatchStatus: row["dispatch_status"] as ToolDispatchOutboxRecord["dispatchStatus"],
    attemptCount: Number(row["attempt_count"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"])
  };
  if (row["last_error_code"] !== null && row["last_error_code"] !== undefined) {
    value.lastErrorCode = String(row["last_error_code"]);
  }
  if (row["dispatch_id"] !== null && row["dispatch_id"] !== undefined) {
    value.dispatchId = String(row["dispatch_id"]);
  }
  return value;
}

function safeId(): string {
  return randomUUID().replaceAll("-", "_");
}
