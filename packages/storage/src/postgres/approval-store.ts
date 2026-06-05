import type { Approval } from "@switchyard/contracts";
import type { ApprovalStore, ListApprovalsFilter, ListApprovalsResult } from "@switchyard/core";
import type { PostgresDatabaseHandle } from "./database.js";

type QueryRow = Record<string, unknown>;

export class PostgresApprovalStore implements ApprovalStore {
  private readonly items = new Map<string, Approval>();

  constructor(private readonly handle?: PostgresDatabaseHandle) {}

  async create(value: Approval): Promise<Approval> {
    if (this.handle) {
      await this.upsert(value);
      return value;
    }
    this.items.set(value.id, value);
    return value;
  }

  async get(id: string): Promise<Approval | undefined> {
    if (this.handle) {
      const result = await this.handle.pool.query("SELECT * FROM approvals WHERE id = $1", [id]);
      return result.rows[0] ? rowToApproval(result.rows[0] as QueryRow) : undefined;
    }
    return this.items.get(id);
  }

  async update(value: Approval): Promise<Approval> {
    if (this.handle) {
      await this.upsert(value);
      return value;
    }
    this.items.set(value.id, value);
    return value;
  }

  async updateIfStatus(id: string, expectedStatus: Approval["status"], value: Approval): Promise<Approval | null> {
    if (this.handle) {
      const result = await this.handle.pool.query(
        `UPDATE approvals
         SET run_id = $2,
             approval_type = $3,
             status = $4,
             payload = $5,
             created_at = $6,
             resolved_at = $7
         WHERE id = $1 AND status = $8
         RETURNING *`,
        [
          value.id,
          value.runId ?? null,
          value.approvalType,
          value.status,
          value.payload,
          value.createdAt,
          value.resolvedAt ?? null,
          expectedStatus
        ]
      );
      return result.rows[0] ? rowToApproval(result.rows[0] as QueryRow) : null;
    }

    const existing = this.items.get(id);
    if (!existing || existing.status !== expectedStatus) {
      return null;
    }
    this.items.set(id, value);
    return value;
  }

  async list(filter: ListApprovalsFilter): Promise<ListApprovalsResult> {
    const toolInvocationId = (filter as { toolInvocationId?: string }).toolInvocationId;
    if (this.handle) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (filter.runId) {
        params.push(filter.runId);
        where.push(`run_id = $${params.length}`);
      }
      if (filter.status) {
        params.push(filter.status);
        where.push(`status = $${params.length}`);
      }
      if (filter.approvalType) {
        params.push(filter.approvalType);
        where.push(`approval_type = $${params.length}`);
      }
      if (toolInvocationId) {
        params.push(toolInvocationId);
        where.push(`payload->>'toolInvocationId' = $${params.length}`);
      }
      if (filter.before) {
        params.push(filter.before.createdAt, filter.before.id);
        where.push(`(created_at < $${params.length - 1} OR (created_at = $${params.length - 1} AND id < $${params.length}))`);
      }

      params.push(filter.limit + 1);
      const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      const result = await this.handle.pool.query(
        `SELECT *
         FROM approvals
         ${whereSql}
         ORDER BY created_at DESC, id DESC
         LIMIT $${params.length}`,
        params
      );

      const page = result.rows.slice(0, filter.limit).map((row) => rowToApproval(row as QueryRow));
      const hasMore = result.rows.length > filter.limit;
      const last = page.at(-1);
      return {
        approvals: page,
        nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null
      };
    }

    const pageRows = [...this.items.values()]
      .filter((entry) => {
        if (filter.runId && entry.runId !== filter.runId) return false;
        if (filter.status && entry.status !== filter.status) return false;
        if (filter.approvalType && entry.approvalType !== filter.approvalType) return false;
        if (toolInvocationId && entry.payload["toolInvocationId"] !== toolInvocationId) return false;
        if (filter.before) {
          if (entry.createdAt > filter.before.createdAt) return false;
          if (entry.createdAt === filter.before.createdAt && entry.id >= filter.before.id) return false;
        }
        return true;
      })
      .sort((left, right) => (left.createdAt === right.createdAt ? right.id.localeCompare(left.id) : left.createdAt > right.createdAt ? -1 : 1));

    const page = pageRows.slice(0, filter.limit);
    const hasMore = pageRows.length > filter.limit;
    const last = page.at(-1);
    return {
      approvals: page,
      nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null
    };
  }

  private async upsert(value: Approval): Promise<void> {
    await this.handle?.pool.query(
      `INSERT INTO approvals (
         id, run_id, approval_type, status, payload, created_at, resolved_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         run_id = EXCLUDED.run_id,
         approval_type = EXCLUDED.approval_type,
         status = EXCLUDED.status,
         payload = EXCLUDED.payload,
         created_at = EXCLUDED.created_at,
         resolved_at = EXCLUDED.resolved_at`,
      [
        value.id,
        value.runId ?? null,
        value.approvalType,
        value.status,
        value.payload,
        value.createdAt,
        value.resolvedAt ?? null
      ]
    );
  }
}

function rowToApproval(row: QueryRow): Approval {
  const value: Approval = {
    id: String(row["id"]),
    approvalType: row["approval_type"] as Approval["approvalType"],
    status: row["status"] as Approval["status"],
    payload: (row["payload"] ?? {}) as Record<string, unknown>,
    createdAt: String(row["created_at"])
  };
  if (row["run_id"] !== null && row["run_id"] !== undefined) value.runId = String(row["run_id"]);
  if (row["resolved_at"] !== null && row["resolved_at"] !== undefined) value.resolvedAt = String(row["resolved_at"]);
  return value;
}
