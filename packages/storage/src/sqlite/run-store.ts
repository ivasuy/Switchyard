import type { Run } from "@switchyard/contracts";
import type { RunStore } from "@switchyard/core";
import type { SwitchyardSqliteDatabase } from "./database.js";
import { runs } from "./schema.js";
import { eq } from "drizzle-orm";

type RunRow = typeof runs.$inferSelect;
type RunInsertRow = Omit<typeof runs.$inferInsert, "startedAt" | "endedAt"> & {
  startedAt?: string;
  endedAt?: string;
};

function toRow(run: Run): RunInsertRow {
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
    await this.db.insert(runs).values(toRow(run));
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
    await this.db.update(runs).set(toRow(run)).where(eq(runs.id, run.id));
    return run;
  }
}
