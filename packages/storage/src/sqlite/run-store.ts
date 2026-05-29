import type { Run } from "@switchyard/contracts";
import type { ListRunsFilter, ListRunsResult, RunStore } from "@switchyard/core";
import type { SwitchyardSqliteDatabase } from "./database.js";
import { runs } from "./schema.js";
import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";

type RunRow = typeof runs.$inferSelect;
type RunInsertRow = Omit<typeof runs.$inferInsert, "startedAt" | "endedAt"> & {
  startedAt?: string;
  endedAt?: string;
};
type RunUpdateRow = Omit<typeof runs.$inferInsert, "id" | "startedAt" | "endedAt"> & {
  startedAt: string | null;
  endedAt: string | null;
};

function toCreateRow(run: Run): RunInsertRow {
  const row: RunInsertRow = {
    id: run.id,
    runtime: run.runtime,
    provider: run.provider,
    model: run.model,
    adapterType: run.adapterType,
    cwd: run.cwd,
    task: run.task,
    status: run.status,
    placement: run.placement,
    approvalPolicy: run.approvalPolicy,
    timeoutSeconds: run.timeoutSeconds,
    metadataJson: JSON.stringify(run.metadata),
    createdAt: run.createdAt
  };
  if (run.startedAt !== undefined) {
    row.startedAt = run.startedAt;
  }
  if (run.endedAt !== undefined) {
    row.endedAt = run.endedAt;
  }
  return row;
}

function toUpdateRow(run: Run): RunUpdateRow {
  return {
    runtime: run.runtime,
    provider: run.provider,
    model: run.model,
    adapterType: run.adapterType,
    cwd: run.cwd,
    task: run.task,
    status: run.status,
    placement: run.placement,
    approvalPolicy: run.approvalPolicy,
    timeoutSeconds: run.timeoutSeconds,
    metadataJson: JSON.stringify(run.metadata),
    createdAt: run.createdAt,
    startedAt: run.startedAt ?? null,
    endedAt: run.endedAt ?? null
  };
}

function fromRow(row: RunRow): Run {
  const run: Run = {
    id: row.id,
    runtime: row.runtime,
    provider: row.provider,
    model: row.model,
    adapterType: row.adapterType as Run["adapterType"],
    cwd: row.cwd,
    task: row.task,
    status: row.status as Run["status"],
    placement: row.placement as Run["placement"],
    approvalPolicy: row.approvalPolicy,
    timeoutSeconds: row.timeoutSeconds,
    metadata: JSON.parse(row.metadataJson),
    createdAt: row.createdAt
  };

  if (row.startedAt !== null) {
    run.startedAt = row.startedAt;
  }
  if (row.endedAt !== null) {
    run.endedAt = row.endedAt;
  }
  return run;
}

export class SqliteRunStore implements RunStore {
  constructor(private readonly db: SwitchyardSqliteDatabase) {}

  async create(run: Run): Promise<Run> {
    await this.db.insert(runs).values(toCreateRow(run));
    return run;
  }

  async get(id: string): Promise<Run | undefined> {
    const rows = await this.db.select().from(runs).where(eq(runs.id, id)).limit(1);
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return fromRow(row);
  }

  async update(run: Run): Promise<Run> {
    await this.db.update(runs).set(toUpdateRow(run)).where(eq(runs.id, run.id));
    return run;
  }

  async list(filter: ListRunsFilter): Promise<ListRunsResult> {
    const conditions: ReturnType<typeof eq>[] = [];

    if (filter.status && filter.status.length > 0) {
      conditions.push(inArray(runs.status, [...filter.status]));
    }
    if (filter.runtime && filter.runtime.length > 0) {
      conditions.push(inArray(runs.runtime, [...filter.runtime]));
    }
    if (filter.provider && filter.provider.length > 0) {
      conditions.push(inArray(runs.provider, [...filter.provider]));
    }
    if (filter.model && filter.model.length > 0) {
      conditions.push(inArray(runs.model, [...filter.model]));
    }
    if (filter.placement && filter.placement.length > 0) {
      conditions.push(inArray(runs.placement, [...filter.placement]));
    }
    if (filter.adapterType && filter.adapterType.length > 0) {
      conditions.push(inArray(runs.adapterType, [...filter.adapterType]));
    }
    if (filter.since !== undefined) {
      conditions.push(gte(runs.createdAt, filter.since));
    }
    if (filter.until !== undefined) {
      conditions.push(lt(runs.createdAt, filter.until));
    }
    if (filter.before) {
      const cursorCreated = filter.before.createdAt;
      const cursorId = filter.before.id;
      const tupleCondition = or(
        lt(runs.createdAt, cursorCreated),
        and(eq(runs.createdAt, cursorCreated), lt(runs.id, cursorId))
      );
      if (tupleCondition) {
        conditions.push(tupleCondition);
      }
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const overFetch = filter.limit + 1;
    const baseQuery = this.db
      .select()
      .from(runs)
      .orderBy(desc(runs.createdAt), desc(sql`${runs.id}`))
      .limit(overFetch);
    const query = whereClause ? baseQuery.where(whereClause) : baseQuery;
    const rows = await query;
    const records = rows.slice(0, filter.limit).map(fromRow);
    const hasMore = rows.length > filter.limit;
    const last = records.at(-1);
    const nextCursor = hasMore && last ? { createdAt: last.createdAt, id: last.id } : null;
    return { runs: records, nextCursor };
  }
}
