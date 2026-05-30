import type { Assignment } from "@switchyard/contracts";
import type { NodeAssignmentStore } from "@switchyard/core";
import type { PostgresDatabaseHandle } from "./database.js";

export class PostgresAssignmentStore implements NodeAssignmentStore {
  private readonly items = new Map<string, Assignment>();

  constructor(private readonly handle?: PostgresDatabaseHandle) {}

  async create(record: Assignment): Promise<Assignment> {
    if (this.handle) {
      await this.upsert(record);
      return record;
    }
    this.items.set(record.id, record);
    return record;
  }

  async get(id: string): Promise<Assignment | undefined> {
    if (this.handle) {
      const result = await this.handle.pool.query("SELECT * FROM assignments WHERE id = $1", [id]);
      return result.rows[0] ? rowToAssignment(result.rows[0]) : undefined;
    }
    return this.items.get(id);
  }

  async update(record: Assignment): Promise<Assignment> {
    if (this.handle) {
      await this.upsert(record);
      return record;
    }
    this.items.set(record.id, record);
    return record;
  }

  async listClaimable(nodeId: string, _now: string): Promise<Assignment[]> {
    if (this.handle) {
      const result = await this.handle.pool.query(
        "SELECT * FROM assignments WHERE node_id = $1 AND status = 'pending' ORDER BY created_at ASC",
        [nodeId]
      );
      return result.rows.map(rowToAssignment);
    }
    return [...this.items.values()].filter((assignment) => assignment.nodeId === nodeId && assignment.status === "pending");
  }

  async claim(input: { assignmentId: string; nodeId: string; now: string }): Promise<Assignment | undefined> {
    if (this.handle) {
      const result = await this.handle.pool.query(
        "UPDATE assignments SET status = 'claimed', claimed_at = $3 WHERE id = $1 AND node_id = $2 AND status = 'pending' RETURNING *",
        [input.assignmentId, input.nodeId, input.now]
      );
      return result.rows[0] ? rowToAssignment(result.rows[0]) : undefined;
    }
    const assignment = this.items.get(input.assignmentId);
    if (!assignment || assignment.nodeId !== input.nodeId || assignment.status !== "pending") {
      return undefined;
    }
    const claimed: Assignment = { ...assignment, status: "claimed", claimedAt: input.now };
    this.items.set(claimed.id, claimed);
    return claimed;
  }

  async complete(id: string, now: string): Promise<Assignment | undefined> {
    if (this.handle) {
      const result = await this.handle.pool.query(
        "UPDATE assignments SET status = 'completed', completed_at = $2 WHERE id = $1 RETURNING *",
        [id, now]
      );
      return result.rows[0] ? rowToAssignment(result.rows[0]) : undefined;
    }
    const assignment = this.items.get(id);
    if (!assignment) return undefined;
    const completed: Assignment = { ...assignment, status: "completed", completedAt: now };
    this.items.set(id, completed);
    return completed;
  }

  async fail(id: string, now: string, error: string): Promise<Assignment | undefined> {
    if (this.handle) {
      const result = await this.handle.pool.query(
        "UPDATE assignments SET status = 'failed', failed_at = $2, error = $3 WHERE id = $1 RETURNING *",
        [id, now, error]
      );
      return result.rows[0] ? rowToAssignment(result.rows[0]) : undefined;
    }
    const assignment = this.items.get(id);
    if (!assignment) return undefined;
    const failed: Assignment = { ...assignment, status: "failed", failedAt: now, error };
    this.items.set(id, failed);
    return failed;
  }

  async cancel(id: string, now: string): Promise<Assignment | undefined> {
    if (this.handle) {
      const result = await this.handle.pool.query(
        "UPDATE assignments SET status = 'cancelled', completed_at = $2 WHERE id = $1 RETURNING *",
        [id, now]
      );
      return result.rows[0] ? rowToAssignment(result.rows[0]) : undefined;
    }
    const assignment = this.items.get(id);
    if (!assignment) return undefined;
    const cancelled: Assignment = { ...assignment, status: "cancelled", completedAt: now };
    this.items.set(id, cancelled);
    return cancelled;
  }

  async expireStale(now: string): Promise<Assignment[]> {
    if (this.handle) {
      const result = await this.handle.pool.query(
        "UPDATE assignments SET status = 'expired', failed_at = $1 WHERE status = 'pending' RETURNING *",
        [now]
      );
      return result.rows.map(rowToAssignment);
    }
    const expired: Assignment[] = [];
    for (const assignment of this.items.values()) {
      if (assignment.status === "pending") {
        const next: Assignment = { ...assignment, status: "expired", failedAt: now };
        this.items.set(next.id, next);
        expired.push(next);
      }
    }
    return expired;
  }

  private async upsert(record: Assignment): Promise<void> {
    await this.handle?.pool.query(
      `INSERT INTO assignments (
        id, run_id, node_id, status, claimed_at, started_at, completed_at,
        failed_at, retry_count, last_event_sequence, last_artifact_sync_at, error, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (id) DO UPDATE SET
        run_id = EXCLUDED.run_id,
        node_id = EXCLUDED.node_id,
        status = EXCLUDED.status,
        claimed_at = EXCLUDED.claimed_at,
        started_at = EXCLUDED.started_at,
        completed_at = EXCLUDED.completed_at,
        failed_at = EXCLUDED.failed_at,
        retry_count = EXCLUDED.retry_count,
        last_event_sequence = EXCLUDED.last_event_sequence,
        last_artifact_sync_at = EXCLUDED.last_artifact_sync_at,
        error = EXCLUDED.error,
        created_at = EXCLUDED.created_at`,
      [
        record.id,
        record.runId,
        record.nodeId,
        record.status,
        record.claimedAt ?? null,
        record.startedAt ?? null,
        record.completedAt ?? null,
        record.failedAt ?? null,
        record.retryCount,
        record.lastEventSequence,
        record.lastArtifactSyncAt ?? null,
        record.error ?? null,
        record.createdAt
      ]
    );
  }
}

function rowToAssignment(row: Record<string, unknown>): Assignment {
  const assignment: Assignment = {
    id: row["id"] as string,
    runId: row["run_id"] as string,
    nodeId: row["node_id"] as string,
    status: row["status"] as Assignment["status"],
    retryCount: row["retry_count"] as number,
    lastEventSequence: row["last_event_sequence"] as number,
    createdAt: row["created_at"] as string
  };
  if (row["claimed_at"]) assignment.claimedAt = row["claimed_at"] as string;
  if (row["started_at"]) assignment.startedAt = row["started_at"] as string;
  if (row["completed_at"]) assignment.completedAt = row["completed_at"] as string;
  if (row["failed_at"]) assignment.failedAt = row["failed_at"] as string;
  if (row["last_artifact_sync_at"]) assignment.lastArtifactSyncAt = row["last_artifact_sync_at"] as string;
  if (row["error"]) assignment.error = row["error"] as string;
  return assignment;
}
