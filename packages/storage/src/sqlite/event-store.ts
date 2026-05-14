import type { SwitchyardEvent } from "@switchyard/contracts";
import type { EventStore } from "@switchyard/core";
import type { SwitchyardSqliteDatabase } from "./database.js";
import { runEvents } from "./schema.js";
import { asc, eq } from "drizzle-orm";

type RunEventRow = typeof runEvents.$inferSelect;
type RunEventInsertRow = Omit<typeof runEvents.$inferInsert, "debateId" | "participantId" | "provider" | "model"> & {
  runId: string | null;
  debateId?: string;
  participantId?: string;
  provider?: string;
  model?: string;
};

function toRow(event: SwitchyardEvent): RunEventInsertRow {
  const row: RunEventInsertRow = {
    id: event.id,
    type: event.type,
    runId: event.runId ?? null,
    sequence: event.sequence,
    payloadJson: JSON.stringify(event.payload),
    createdAt: event.createdAt
  };
  if (event.debateId !== undefined) {
    row.debateId = event.debateId;
  }
  if (event.participantId !== undefined) {
    row.participantId = event.participantId;
  }
  if (event.provider !== undefined) {
    row.provider = event.provider;
  }
  if (event.model !== undefined) {
    row.model = event.model;
  }
  return row;
}

function fromRow(row: RunEventRow): SwitchyardEvent {
  const event: SwitchyardEvent = {
    id: row.id,
    type: row.type as SwitchyardEvent["type"],
    sequence: row.sequence,
    payload: JSON.parse(row.payloadJson),
    createdAt: row.createdAt
  };
  if (row.runId !== null) {
    event.runId = row.runId;
  }
  if (row.debateId !== null) {
    event.debateId = row.debateId;
  }
  if (row.participantId !== null) {
    event.participantId = row.participantId;
  }
  if (row.provider !== null) {
    event.provider = row.provider;
  }
  if (row.model !== null) {
    event.model = row.model;
  }
  return event;
}

export class SqliteEventStore implements EventStore {
  constructor(private readonly db: SwitchyardSqliteDatabase) {}

  async append(event: SwitchyardEvent): Promise<SwitchyardEvent> {
    await this.db.insert(runEvents).values(toRow(event));
    return event;
  }

  async listByRun(runId: string): Promise<SwitchyardEvent[]> {
    const rows = await this.db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(asc(runEvents.sequence));
    return rows.map(fromRow);
  }
}
