import { randomUUID } from "node:crypto";
import type { HostedRuntimeBridgeCommand } from "@switchyard/contracts";
import { hostedRuntimeBridgeCommandSchema } from "@switchyard/contracts";
import type { PostgresDatabaseHandle } from "./database.js";

type QueryRow = Record<string, unknown>;

const NON_IDEMPOTENT_RETRY_BLOCKED_REASON = "hosted_runtime_bridge_non_idempotent_retry_blocked";
const COMMAND_EXPIRED_REASON = "hosted_runtime_bridge_command_expired";

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

export class HostedRuntimeBridgeCommandStoreError extends Error {
  constructor(
    readonly code: "hosted_runtime_bridge_payload_mismatch",
    readonly commandId: string
  ) {
    super(code);
  }
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

export class PostgresHostedRuntimeBridgeCommandStore {
  private readonly items = new Map<string, HostedRuntimeBridgeCommand>();
  private readonly byIdempotencyKey = new Map<string, string>();

  constructor(private readonly handle?: PostgresDatabaseHandle) {}

  async create(
    input: CreateHostedRuntimeBridgeCommandInput
  ): Promise<{ command: HostedRuntimeBridgeCommand; duplicate: boolean }> {
    const now = input.now ?? new Date().toISOString();
    const command = hostedRuntimeBridgeCommandSchema.parse({
      id: `hosted_runtime_bridge_command_${safeId()}`,
      runId: input.runId,
      approvalId: input.approvalId,
      runtimeSessionId: input.runtimeSessionId,
      runtimeMode: input.runtimeMode,
      operation: input.operation,
      status: input.status ?? "queued",
      idempotencyKey: input.idempotencyKey,
      payloadHash: input.payloadHash,
      redactedPayload: input.redactedPayload,
      payloadBytes: input.payloadBytes,
      accountId: input.accountId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      userId: input.userId,
      apiKeyId: input.apiKeyId,
      attempts: input.attempts ?? 0,
      maxAttempts: input.maxAttempts,
      reasonCode: input.reasonCode,
      expiresAt: input.expiresAt,
      createdAt: now,
      updatedAt: now
    });

    if (this.handle) {
      const inserted = await this.handle.pool.query(
        `INSERT INTO hosted_runtime_bridge_commands (
           id, run_id, approval_id, runtime_session_id, runtime_mode, operation, status,
           idempotency_key, payload_hash, payload_bytes, redacted_payload,
           account_id, tenant_id, project_id, user_id, api_key_id,
           worker_id, lease_until, attempts, max_attempts, reason_code,
           adapter_acknowledged_at, expires_at, created_at, updated_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,
           $8,$9,$10,$11,
           $12,$13,$14,$15,$16,
           $17,$18,$19,$20,$21,
           $22,$23,$24,$25
         )
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [
          command.id,
          command.runId,
          command.approvalId ?? null,
          command.runtimeSessionId ?? null,
          command.runtimeMode,
          command.operation,
          command.status,
          command.idempotencyKey,
          command.payloadHash,
          command.payloadBytes,
          command.redactedPayload,
          command.accountId,
          command.tenantId,
          command.projectId,
          command.userId,
          command.apiKeyId,
          command.workerId ?? null,
          command.leaseUntil ?? null,
          command.attempts,
          command.maxAttempts,
          command.reasonCode ?? null,
          null,
          command.expiresAt,
          command.createdAt,
          command.updatedAt
        ]
      );

      if (inserted.rows[0]) {
        return {
          command: rowToCommand(inserted.rows[0] as QueryRow),
          duplicate: false
        };
      }

      const existing = await this.getByIdempotencyKey(input.idempotencyKey);
      if (!existing) {
        throw new Error("hosted_runtime_bridge_store_inconsistent");
      }
      if (existing.payloadHash !== input.payloadHash) {
        throw new HostedRuntimeBridgeCommandStoreError(
          "hosted_runtime_bridge_payload_mismatch",
          existing.id
        );
      }
      return { command: existing, duplicate: true };
    }

    const existingId = this.byIdempotencyKey.get(command.idempotencyKey);
    if (existingId) {
      const existing = this.items.get(existingId);
      if (!existing) {
        throw new Error("hosted_runtime_bridge_store_inconsistent");
      }
      if (existing.payloadHash !== command.payloadHash) {
        throw new HostedRuntimeBridgeCommandStoreError(
          "hosted_runtime_bridge_payload_mismatch",
          existing.id
        );
      }
      return { command: existing, duplicate: true };
    }

    this.items.set(command.id, command);
    this.byIdempotencyKey.set(command.idempotencyKey, command.id);
    return { command, duplicate: false };
  }

  async get(id: string): Promise<HostedRuntimeBridgeCommand | undefined> {
    if (this.handle) {
      const result = await this.handle.pool.query(
        `SELECT *
         FROM hosted_runtime_bridge_commands
         WHERE id = $1
         LIMIT 1`,
        [id]
      );
      return result.rows[0] ? rowToCommand(result.rows[0] as QueryRow) : undefined;
    }

    return this.items.get(id);
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<HostedRuntimeBridgeCommand | undefined> {
    if (this.handle) {
      const result = await this.handle.pool.query(
        `SELECT *
         FROM hosted_runtime_bridge_commands
         WHERE idempotency_key = $1
         LIMIT 1`,
        [idempotencyKey]
      );
      return result.rows[0] ? rowToCommand(result.rows[0] as QueryRow) : undefined;
    }

    const id = this.byIdempotencyKey.get(idempotencyKey);
    return id ? this.items.get(id) : undefined;
  }

  async claimNext(input: ClaimHostedRuntimeBridgeCommandInput): Promise<HostedRuntimeBridgeCommand | undefined> {
    const now = input.now ?? new Date().toISOString();
    const leaseUntil = new Date(new Date(now).getTime() + input.leaseMs).toISOString();

    if (this.handle) {
      const result = await this.handle.pool.query(
        `WITH next_candidate AS (
           SELECT id
           FROM hosted_runtime_bridge_commands
           WHERE status = 'queued'
             AND expires_at > $1
           ORDER BY created_at ASC, id ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE hosted_runtime_bridge_commands AS command
         SET status = 'claimed',
             worker_id = $2,
             lease_until = $3,
             attempts = command.attempts + 1,
             updated_at = $1
         FROM next_candidate
         WHERE command.id = next_candidate.id
         RETURNING command.*`,
        [now, input.workerId, leaseUntil]
      );
      return result.rows[0] ? rowToCommand(result.rows[0] as QueryRow) : undefined;
    }

    const candidate = [...this.items.values()]
      .filter((entry) => entry.status === "queued" && entry.expiresAt > now)
      .sort((left, right) => {
        if (left.createdAt === right.createdAt) {
          return left.id.localeCompare(right.id);
        }
        return left.createdAt.localeCompare(right.createdAt);
      })[0];

    if (!candidate) {
      return undefined;
    }

    const claimed = hostedRuntimeBridgeCommandSchema.parse({
      ...candidate,
      status: "claimed",
      workerId: input.workerId,
      leaseUntil,
      attempts: candidate.attempts + 1,
      updatedAt: now
    });
    this.items.set(claimed.id, claimed);
    return claimed;
  }

  async complete(input: CompleteHostedRuntimeBridgeCommandInput): Promise<HostedRuntimeBridgeCommand | null> {
    const now = input.now ?? new Date().toISOString();

    if (this.handle) {
      const result = await this.handle.pool.query(
        `UPDATE hosted_runtime_bridge_commands
         SET status = 'completed',
             reason_code = NULL,
             lease_until = NULL,
             updated_at = $3
         WHERE id = $1
           AND status = 'claimed'
           AND worker_id = $2
         RETURNING *`,
        [input.commandId, input.workerId, now]
      );
      return result.rows[0] ? rowToCommand(result.rows[0] as QueryRow) : null;
    }

    const current = this.items.get(input.commandId);
    if (!current || current.status !== "claimed" || current.workerId !== input.workerId) {
      return null;
    }

    const completed = hostedRuntimeBridgeCommandSchema.parse({
      ...current,
      status: "completed",
      reasonCode: undefined,
      leaseUntil: undefined,
      updatedAt: now
    });
    this.items.set(completed.id, completed);
    return completed;
  }

  async fail(input: FailHostedRuntimeBridgeCommandInput): Promise<HostedRuntimeBridgeCommand | null> {
    const now = input.now ?? new Date().toISOString();
    const nextStatus: HostedRuntimeBridgeCommand["status"] = input.retryable ? "queued" : "failed";

    if (this.handle) {
      const params = [input.commandId, nextStatus, input.reasonCode, now, input.workerId ?? null];

      const result = await this.handle.pool.query(
        `UPDATE hosted_runtime_bridge_commands
         SET status = $2,
             reason_code = $3,
             worker_id = CASE WHEN $2 = 'queued' THEN NULL ELSE worker_id END,
             lease_until = NULL,
             updated_at = $4
         WHERE id = $1
           AND status = 'claimed'
           AND ($5::text IS NULL OR worker_id = $5)
         RETURNING *`,
        params
      );
      return result.rows[0] ? rowToCommand(result.rows[0] as QueryRow) : null;
    }

    const current = this.items.get(input.commandId);
    if (!current || current.status !== "claimed") {
      return null;
    }
    if (input.workerId && current.workerId !== input.workerId) {
      return null;
    }

    const failed = hostedRuntimeBridgeCommandSchema.parse({
      ...current,
      status: nextStatus,
      reasonCode: input.reasonCode,
      workerId: input.retryable ? undefined : current.workerId,
      leaseUntil: undefined,
      updatedAt: now
    });
    this.items.set(failed.id, failed);
    return failed;
  }

  async expireStale(input: ExpireHostedRuntimeBridgeCommandsInput = {}): Promise<{ expired: number }> {
    const now = input.now ?? new Date().toISOString();

    if (this.handle) {
      const result = await this.handle.pool.query(
        `UPDATE hosted_runtime_bridge_commands
         SET status = 'expired',
             reason_code = $2,
             updated_at = $1
         WHERE status = 'queued'
           AND expires_at <= $1`,
        [now, COMMAND_EXPIRED_REASON]
      );
      return { expired: result.rowCount ?? 0 };
    }

    let expired = 0;
    for (const command of this.items.values()) {
      if (command.status !== "queued" || command.expiresAt > now) {
        continue;
      }
      const next = hostedRuntimeBridgeCommandSchema.parse({
        ...command,
        status: "expired",
        reasonCode: COMMAND_EXPIRED_REASON,
        updatedAt: now
      });
      this.items.set(next.id, next);
      expired += 1;
    }

    return { expired };
  }

  async recoverStaleClaims(
    input: RecoverStaleHostedRuntimeBridgeClaimsInput
  ): Promise<{ recovered: number; failed: number }> {
    const now = input.now ?? new Date().toISOString();

    if (this.handle) {
      let recovered = 0;
      if (input.nonIdempotentPolicy === "retry_if_adapter_ack") {
        const retried = await this.handle.pool.query(
          `UPDATE hosted_runtime_bridge_commands
           SET status = 'queued',
               worker_id = NULL,
               lease_until = NULL,
               reason_code = NULL,
               updated_at = $1
           WHERE status = 'claimed'
             AND lease_until IS NOT NULL
             AND lease_until <= $1
             AND adapter_acknowledged_at IS NOT NULL`,
          [now]
        );
        recovered = retried.rowCount ?? 0;
      }

      const failed = await this.handle.pool.query(
        `UPDATE hosted_runtime_bridge_commands
         SET status = 'failed',
             reason_code = $2,
             worker_id = NULL,
             lease_until = NULL,
             updated_at = $1
         WHERE status = 'claimed'
           AND lease_until IS NOT NULL
           AND lease_until <= $1`,
        [now, NON_IDEMPOTENT_RETRY_BLOCKED_REASON]
      );

      return { recovered, failed: failed.rowCount ?? 0 };
    }

    let recovered = 0;
    let failed = 0;

    for (const command of this.items.values()) {
      if (command.status !== "claimed") {
        continue;
      }
      if (!command.leaseUntil || command.leaseUntil > now) {
        continue;
      }

      const canRetry = false;
      if (input.nonIdempotentPolicy === "retry_if_adapter_ack" && canRetry) {
        const retried = hostedRuntimeBridgeCommandSchema.parse({
          ...command,
          status: "queued",
          workerId: undefined,
          leaseUntil: undefined,
          reasonCode: undefined,
          updatedAt: now
        });
        this.items.set(retried.id, retried);
        recovered += 1;
        continue;
      }

      const blocked = hostedRuntimeBridgeCommandSchema.parse({
        ...command,
        status: "failed",
        reasonCode: NON_IDEMPOTENT_RETRY_BLOCKED_REASON,
        workerId: undefined,
        leaseUntil: undefined,
        updatedAt: now
      });
      this.items.set(blocked.id, blocked);
      failed += 1;
    }

    return { recovered, failed };
  }

  async listByRun(runId: string): Promise<HostedRuntimeBridgeCommand[]> {
    if (this.handle) {
      const result = await this.handle.pool.query(
        `SELECT *
         FROM hosted_runtime_bridge_commands
         WHERE run_id = $1
         ORDER BY created_at ASC, id ASC`,
        [runId]
      );
      return result.rows.map((row) => rowToCommand(row as QueryRow));
    }

    return [...this.items.values()]
      .filter((entry) => entry.runId === runId)
      .sort((left, right) => {
        if (left.createdAt === right.createdAt) {
          return left.id.localeCompare(right.id);
        }
        return left.createdAt.localeCompare(right.createdAt);
      });
  }
}

function rowToCommand(row: QueryRow): HostedRuntimeBridgeCommand {
  const redactedPayload =
    row["redacted_payload"] && typeof row["redacted_payload"] === "object" && !Array.isArray(row["redacted_payload"])
      ? (row["redacted_payload"] as Record<string, unknown>)
      : {};

  return hostedRuntimeBridgeCommandSchema.parse({
    id: String(row["id"]),
    runId: String(row["run_id"]),
    approvalId: stringOrUndefined(row["approval_id"]),
    runtimeSessionId: stringOrUndefined(row["runtime_session_id"]),
    runtimeMode: String(row["runtime_mode"]),
    operation: row["operation"],
    status: row["status"],
    idempotencyKey: String(row["idempotency_key"]),
    payloadHash: String(row["payload_hash"]),
    redactedPayload,
    payloadBytes: Number(row["payload_bytes"]),
    accountId: String(row["account_id"]),
    tenantId: String(row["tenant_id"]),
    projectId: String(row["project_id"]),
    userId: String(row["user_id"]),
    apiKeyId: String(row["api_key_id"]),
    workerId: stringOrUndefined(row["worker_id"]),
    leaseUntil: stringOrUndefined(row["lease_until"]),
    attempts: Number(row["attempts"]),
    maxAttempts: Number(row["max_attempts"]),
    reasonCode: stringOrUndefined(row["reason_code"]),
    expiresAt: String(row["expires_at"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"])
  });
}

function stringOrUndefined(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return String(value);
}

function safeId(): string {
  return randomUUID().replaceAll("-", "_");
}
