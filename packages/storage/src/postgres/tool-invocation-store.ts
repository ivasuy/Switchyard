import type { ToolInvocation } from "@switchyard/contracts";
import type { ListToolInvocationsFilter, ListToolInvocationsResult, ToolInvocationStore } from "@switchyard/core";
import type { PostgresDatabaseHandle } from "./database.js";

type QueryRow = Record<string, unknown>;

export class PostgresToolInvocationStore implements ToolInvocationStore {
  private readonly items = new Map<string, ToolInvocation>();

  constructor(private readonly handle?: PostgresDatabaseHandle) {}

  async create(value: ToolInvocation): Promise<ToolInvocation> {
    if (this.handle) {
      await this.upsert(value);
      return value;
    }
    this.items.set(value.id, value);
    return value;
  }

  async get(id: string): Promise<ToolInvocation | undefined> {
    if (this.handle) {
      const result = await this.handle.pool.query("SELECT * FROM tool_invocations WHERE id = $1", [id]);
      return result.rows[0] ? rowToInvocation(result.rows[0] as QueryRow) : undefined;
    }
    return this.items.get(id);
  }

  async update(value: ToolInvocation): Promise<ToolInvocation> {
    if (this.handle) {
      await this.upsert(value);
      return value;
    }
    this.items.set(value.id, value);
    return value;
  }

  async updateIfStatus(
    id: string,
    expectedStatus: ToolInvocation["status"],
    value: ToolInvocation
  ): Promise<ToolInvocation | null> {
    if (this.handle) {
      const result = await this.handle.pool.query(
        `UPDATE tool_invocations
         SET run_id = $2,
             type = $3,
             status = $4,
             approval_id = $5,
             input = $6,
             output = $7,
             error = $8,
             created_at = $9,
             completed_at = $10
         WHERE id = $1 AND status = $11
         RETURNING *`,
        [
          value.id,
          value.runId ?? null,
          value.type,
          value.status,
          value.approvalId ?? null,
          value.input,
          value.output ?? null,
          value.error ?? null,
          value.createdAt,
          value.completedAt ?? null,
          expectedStatus
        ]
      );
      return result.rows[0] ? rowToInvocation(result.rows[0] as QueryRow) : null;
    }

    const existing = this.items.get(id);
    if (!existing || existing.status !== expectedStatus) {
      return null;
    }
    this.items.set(id, value);
    return value;
  }

  async list(filter: ListToolInvocationsFilter): Promise<ListToolInvocationsResult> {
    if (this.handle) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (filter.runId) {
        params.push(filter.runId);
        where.push(`run_id = $${params.length}`);
      }
      if (filter.type) {
        params.push(filter.type);
        where.push(`type = $${params.length}`);
      }
      if (filter.status) {
        params.push(filter.status);
        where.push(`status = $${params.length}`);
      }
      if (filter.approvalId) {
        params.push(filter.approvalId);
        where.push(`approval_id = $${params.length}`);
      }
      if (filter.before) {
        params.push(filter.before.createdAt, filter.before.id);
        where.push(`(created_at < $${params.length - 1} OR (created_at = $${params.length - 1} AND id < $${params.length}))`);
      }

      params.push(filter.limit + 1);
      const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      const result = await this.handle.pool.query(
        `SELECT *
         FROM tool_invocations
         ${whereSql}
         ORDER BY created_at DESC, id DESC
         LIMIT $${params.length}`,
        params
      );

      const page = result.rows.slice(0, filter.limit).map((row) => rowToInvocation(row as QueryRow));
      const hasMore = result.rows.length > filter.limit;
      const last = page.at(-1);
      return {
        invocations: page,
        nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null
      };
    }

    let items = [...this.items.values()]
      .filter((item) => {
        if (filter.runId && item.runId !== filter.runId) return false;
        if (filter.type && item.type !== filter.type) return false;
        if (filter.status && item.status !== filter.status) return false;
        if (filter.approvalId && item.approvalId !== filter.approvalId) return false;
        if (filter.before) {
          if (item.createdAt > filter.before.createdAt) return false;
          if (item.createdAt === filter.before.createdAt && item.id >= filter.before.id) return false;
        }
        return true;
      })
      .sort((left, right) => (left.createdAt === right.createdAt ? right.id.localeCompare(left.id) : left.createdAt > right.createdAt ? -1 : 1));

    const page = items.slice(0, filter.limit);
    const hasMore = items.length > filter.limit;
    const last = page.at(-1);
    return {
      invocations: page,
      nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null
    };
  }

  async listByApproval(approvalId: string): Promise<ToolInvocation[]> {
    if (this.handle) {
      const result = await this.handle.pool.query(
        "SELECT * FROM tool_invocations WHERE approval_id = $1 ORDER BY created_at DESC, id DESC",
        [approvalId]
      );
      return result.rows.map((row) => rowToInvocation(row as QueryRow));
    }

    return [...this.items.values()]
      .filter((entry) => entry.approvalId === approvalId)
      .sort((left, right) => (left.createdAt === right.createdAt ? right.id.localeCompare(left.id) : left.createdAt > right.createdAt ? -1 : 1));
  }

  private async upsert(value: ToolInvocation): Promise<void> {
    await this.handle?.pool.query(
      `INSERT INTO tool_invocations (
         id, run_id, type, status, approval_id, input, output, error, created_at, completed_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         run_id = EXCLUDED.run_id,
         type = EXCLUDED.type,
         status = EXCLUDED.status,
         approval_id = EXCLUDED.approval_id,
         input = EXCLUDED.input,
         output = EXCLUDED.output,
         error = EXCLUDED.error,
         created_at = EXCLUDED.created_at,
         completed_at = EXCLUDED.completed_at`,
      [
        value.id,
        value.runId ?? null,
        value.type,
        value.status,
        value.approvalId ?? null,
        value.input,
        value.output ?? null,
        value.error ?? null,
        value.createdAt,
        value.completedAt ?? null
      ]
    );
  }
}

function rowToInvocation(row: QueryRow): ToolInvocation {
  const value: ToolInvocation = {
    id: String(row["id"]),
    type: row["type"] as ToolInvocation["type"],
    status: row["status"] as ToolInvocation["status"],
    input: (row["input"] ?? {}) as Record<string, unknown>,
    createdAt: String(row["created_at"])
  };
  if (row["run_id"] !== null && row["run_id"] !== undefined) value.runId = String(row["run_id"]);
  if (row["approval_id"] !== null && row["approval_id"] !== undefined) value.approvalId = String(row["approval_id"]);
  if (row["output"] !== null && row["output"] !== undefined) value.output = row["output"] as Record<string, unknown>;
  if (row["error"] !== null && row["error"] !== undefined) value.error = row["error"] as { code: string; message: string };
  if (row["completed_at"] !== null && row["completed_at"] !== undefined) value.completedAt = String(row["completed_at"]);
  return value;
}
