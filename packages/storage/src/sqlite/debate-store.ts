import type { Debate } from "@switchyard/contracts";
import type { DebateStore } from "@switchyard/core";
import type { SwitchyardSqliteDatabase } from "./database.js";
import { debates } from "./schema.js";
import { eq } from "drizzle-orm";

type DebateRow = typeof debates.$inferSelect;
type DebateInsertRow = Omit<
  typeof debates.$inferInsert,
  "judgeJson" | "finalReportArtifactId" | "finalReportPath" | "stopReason" | "errorJson" | "updatedAt" | "completedAt"
> & {
  judgeJson?: string | null;
  finalReportArtifactId?: string | null;
  finalReportPath?: string | null;
  stopReason?: string | null;
  errorJson?: string | null;
  updatedAt?: string | null;
  completedAt?: string | null;
};

function toRow(value: Debate): DebateInsertRow {
  const row: DebateInsertRow = {
    id: value.id,
    topic: value.topic,
    mode: value.mode,
    status: value.status,
    participantsJson: JSON.stringify(value.participants),
    limitsJson: JSON.stringify(value.limits),
    evidenceIdsJson: JSON.stringify(value.evidenceIds),
    messageIdsJson: JSON.stringify(value.messageIds),
    eventIdsJson: JSON.stringify(value.eventIds),
    budgetJson: JSON.stringify(value.budget),
    createdAt: value.createdAt
  };
  row.judgeJson = value.judge ? JSON.stringify(value.judge) : null;
  row.finalReportArtifactId = value.finalReportArtifactId ?? null;
  row.finalReportPath = value.finalReportPath ?? null;
  row.stopReason = value.stopReason ?? null;
  row.errorJson = value.error ? JSON.stringify(value.error) : null;
  row.updatedAt = value.updatedAt ?? null;
  row.completedAt = value.completedAt ?? null;
  return row;
}

function fromRow(row: DebateRow): Debate {
  const value: Debate = {
    id: row.id,
    topic: row.topic,
    mode: row.mode as Debate["mode"],
    status: row.status as Debate["status"],
    participants: JSON.parse(row.participantsJson),
    limits: JSON.parse(row.limitsJson),
    evidenceIds: JSON.parse(row.evidenceIdsJson),
    messageIds: JSON.parse(row.messageIdsJson),
    eventIds: JSON.parse(row.eventIdsJson),
    budget: JSON.parse(row.budgetJson),
    createdAt: row.createdAt
  };
  if (row.judgeJson !== null) {
    value.judge = JSON.parse(row.judgeJson);
  }
  if (row.finalReportArtifactId !== null) {
    value.finalReportArtifactId = row.finalReportArtifactId;
  }
  if (row.finalReportPath !== null) {
    value.finalReportPath = row.finalReportPath;
  }
  if (row.stopReason !== null) {
    value.stopReason = row.stopReason as Debate["stopReason"];
  }
  if (row.errorJson !== null) {
    value.error = JSON.parse(row.errorJson);
  }
  if (row.updatedAt !== null) {
    value.updatedAt = row.updatedAt;
  }
  if (row.completedAt !== null) {
    value.completedAt = row.completedAt;
  }
  return value;
}

export class SqliteDebateStore implements DebateStore {
  constructor(private readonly db: SwitchyardSqliteDatabase) {}

  async create(value: Debate): Promise<Debate> {
    await this.db.insert(debates).values(toRow(value));
    return value;
  }

  async get(id: string): Promise<Debate | undefined> {
    const rows = await this.db.select().from(debates).where(eq(debates.id, id)).limit(1);
    const row = rows[0];
    return row ? fromRow(row) : undefined;
  }

  async update(value: Debate): Promise<Debate> {
    await this.db.update(debates).set(toRow(value)).where(eq(debates.id, value.id));
    return value;
  }
}
