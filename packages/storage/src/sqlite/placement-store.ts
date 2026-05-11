import type { PlacementDecisionRecord } from "@switchyard/core";
import type { PlacementStore } from "@switchyard/core";
import type { SwitchyardSqliteDatabase } from "./database.js";
import { placementDecisions } from "./schema.js";
import { asc, eq } from "drizzle-orm";

type PlacementRow = typeof placementDecisions.$inferSelect;
type PlacementInsertRow = Omit<
  typeof placementDecisions.$inferInsert,
  "runId" | "targetNode" | "approvalRequired"
> & {
  runId: string | null;
  targetNode: string | null;
  approvalRequired: number;
};
type PlacementUpdateRow = Omit<
  typeof placementDecisions.$inferInsert,
  "runId" | "targetNode" | "approvalRequired"
> & {
  runId: string | null;
  targetNode: string | null;
  approvalRequired: number;
};

function toRow(record: PlacementDecisionRecord): PlacementInsertRow {
  return {
    id: record.id,
    runId: record.runId ?? null,
    decision: record.decision,
    reason: record.reason,
    mode: record.mode,
    targetNode: record.targetNode ?? null,
    requiredCapabilitiesJson: JSON.stringify(record.requiredCapabilities),
    deniedCapabilitiesJson: JSON.stringify(record.deniedCapabilities),
    approvalRequired: record.approvalRequired ? 1 : 0,
    policyTraceJson: JSON.stringify(record.policyTrace),
    createdAt: record.createdAt
  };
}

function toUpdateRow(record: PlacementDecisionRecord): PlacementUpdateRow {
  return {
    id: record.id,
    runId: record.runId ?? null,
    decision: record.decision,
    reason: record.reason,
    mode: record.mode,
    targetNode: record.targetNode ?? null,
    requiredCapabilitiesJson: JSON.stringify(record.requiredCapabilities),
    deniedCapabilitiesJson: JSON.stringify(record.deniedCapabilities),
    approvalRequired: record.approvalRequired ? 1 : 0,
    policyTraceJson: JSON.stringify(record.policyTrace),
    createdAt: record.createdAt
  };
}

function fromRow(row: PlacementRow): PlacementDecisionRecord {
  const record: PlacementDecisionRecord = {
    id: row.id,
    decision: row.decision as PlacementDecisionRecord["decision"],
    reason: row.reason,
    mode: row.mode as PlacementDecisionRecord["mode"],
    requiredCapabilities: JSON.parse(row.requiredCapabilitiesJson),
    deniedCapabilities: JSON.parse(row.deniedCapabilitiesJson),
    approvalRequired: row.approvalRequired === 1,
    policyTrace: JSON.parse(row.policyTraceJson),
    createdAt: row.createdAt
  };

  if (row.runId !== null) {
    record.runId = row.runId;
  }
  if (row.targetNode !== null) {
    record.targetNode = row.targetNode;
  }

  return record;
}

export class SqlitePlacementStore implements PlacementStore {
  constructor(private readonly db: SwitchyardSqliteDatabase) {}

  async create(record: PlacementDecisionRecord): Promise<PlacementDecisionRecord> {
    await this.db.insert(placementDecisions).values(toRow(record));
    return record;
  }

  async get(id: string): Promise<PlacementDecisionRecord | undefined> {
    const rows = await this.db
      .select()
      .from(placementDecisions)
      .where(eq(placementDecisions.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return fromRow(row);
  }

  async update(record: PlacementDecisionRecord): Promise<PlacementDecisionRecord> {
    await this.db.update(placementDecisions).set(toUpdateRow(record)).where(eq(placementDecisions.id, record.id));
    return record;
  }

  async listByRun(runId: string): Promise<PlacementDecisionRecord[]> {
    const rows = await this.db
      .select()
      .from(placementDecisions)
      .where(eq(placementDecisions.runId, runId))
      .orderBy(asc(placementDecisions.createdAt));
    return rows.map(fromRow);
  }
}
