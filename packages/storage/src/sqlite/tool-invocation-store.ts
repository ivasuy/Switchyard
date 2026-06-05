import type { ToolInvocation } from "@switchyard/contracts";
import type { ListToolInvocationsFilter, ListToolInvocationsResult, ToolInvocationStore } from "@switchyard/core";
import type { SwitchyardSqliteDatabase } from "./database.js";
import { toolInvocations } from "./schema.js";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";

type InvocationRow = typeof toolInvocations.$inferSelect;
type InvocationInsertRow = Omit<typeof toolInvocations.$inferInsert, "runId" | "approvalId" | "outputJson" | "errorJson" | "completedAt"> & {
  runId: string | null;
  approvalId: string | null;
  outputJson: string | null;
  errorJson: string | null;
  completedAt: string | null;
};

type InvocationUpdateRow = Omit<InvocationInsertRow, "id">;

function toInsertRow(invocation: ToolInvocation): InvocationInsertRow {
  return {
    id: invocation.id,
    runId: invocation.runId ?? null,
    type: invocation.type,
    status: invocation.status,
    approvalId: invocation.approvalId ?? null,
    inputJson: JSON.stringify(invocation.input),
    outputJson: invocation.output ? JSON.stringify(invocation.output) : null,
    errorJson: invocation.error ? JSON.stringify(invocation.error) : null,
    createdAt: invocation.createdAt,
    completedAt: invocation.completedAt ?? null
  };
}

function toUpdateRow(invocation: ToolInvocation): InvocationUpdateRow {
  return {
    runId: invocation.runId ?? null,
    type: invocation.type,
    status: invocation.status,
    approvalId: invocation.approvalId ?? null,
    inputJson: JSON.stringify(invocation.input),
    outputJson: invocation.output ? JSON.stringify(invocation.output) : null,
    errorJson: invocation.error ? JSON.stringify(invocation.error) : null,
    createdAt: invocation.createdAt,
    completedAt: invocation.completedAt ?? null
  };
}

function fromRow(row: InvocationRow): ToolInvocation {
  const invocation: ToolInvocation = {
    id: row.id,
    type: row.type as ToolInvocation["type"],
    status: row.status as ToolInvocation["status"],
    input: JSON.parse(row.inputJson),
    createdAt: row.createdAt
  };
  if (row.runId !== null) invocation.runId = row.runId;
  if (row.approvalId !== null) invocation.approvalId = row.approvalId;
  if (row.outputJson !== null) invocation.output = JSON.parse(row.outputJson);
  if (row.errorJson !== null) invocation.error = JSON.parse(row.errorJson);
  if (row.completedAt !== null) invocation.completedAt = row.completedAt;
  return invocation;
}

export class SqliteToolInvocationStore implements ToolInvocationStore {
  constructor(private readonly db: SwitchyardSqliteDatabase) {}

  async create(value: ToolInvocation): Promise<ToolInvocation> {
    await this.db.insert(toolInvocations).values(toInsertRow(value));
    return value;
  }

  async get(id: string): Promise<ToolInvocation | undefined> {
    const rows = await this.db.select().from(toolInvocations).where(eq(toolInvocations.id, id)).limit(1);
    const row = rows[0];
    return row ? fromRow(row) : undefined;
  }

  async update(value: ToolInvocation): Promise<ToolInvocation> {
    await this.db.update(toolInvocations).set(toUpdateRow(value)).where(eq(toolInvocations.id, value.id));
    return value;
  }

  async updateIfStatus(
    id: string,
    expectedStatus: ToolInvocation["status"],
    value: ToolInvocation
  ): Promise<ToolInvocation | null> {
    const rows = await this.db
      .update(toolInvocations)
      .set(toUpdateRow(value))
      .where(and(eq(toolInvocations.id, id), eq(toolInvocations.status, expectedStatus)))
      .returning();
    const row = rows[0];
    return row ? fromRow(row) : null;
  }

  async list(filter: ListToolInvocationsFilter): Promise<ListToolInvocationsResult> {
    const conditions: Array<ReturnType<typeof eq> | ReturnType<typeof or>> = [];
    if (filter.runId) conditions.push(eq(toolInvocations.runId, filter.runId));
    if (filter.type) conditions.push(eq(toolInvocations.type, filter.type));
    if (filter.status) conditions.push(eq(toolInvocations.status, filter.status));
    if (filter.approvalId) conditions.push(eq(toolInvocations.approvalId, filter.approvalId));
    if (filter.before) {
      const cursor = or(
        lt(toolInvocations.createdAt, filter.before.createdAt),
        and(eq(toolInvocations.createdAt, filter.before.createdAt), lt(toolInvocations.id, filter.before.id))
      );
      if (cursor) conditions.push(cursor);
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const overFetch = filter.limit + 1;
    const baseQuery = this.db
      .select()
      .from(toolInvocations)
      .orderBy(desc(toolInvocations.createdAt), desc(sql`${toolInvocations.id}`))
      .limit(overFetch);
    const query = whereClause ? baseQuery.where(whereClause) : baseQuery;
    const rows = await query;
    const page = rows.slice(0, filter.limit).map(fromRow);
    const hasMore = rows.length > filter.limit;
    const last = page.at(-1);
    return {
      invocations: page,
      nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null
    };
  }

  async listByApproval(approvalId: string): Promise<ToolInvocation[]> {
    const rows = await this.db
      .select()
      .from(toolInvocations)
      .where(eq(toolInvocations.approvalId, approvalId))
      .orderBy(desc(toolInvocations.createdAt), desc(sql`${toolInvocations.id}`));
    return rows.map(fromRow);
  }
}
