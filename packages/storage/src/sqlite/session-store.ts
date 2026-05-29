import type { RuntimeSession } from "@switchyard/contracts";
import type { SessionStore } from "@switchyard/core";
import type { SwitchyardSqliteDatabase } from "./database.js";
import { runtimeSessions } from "./schema.js";
import { asc, eq } from "drizzle-orm";

type SessionRow = typeof runtimeSessions.$inferSelect;
type SessionInsertRow = Omit<typeof runtimeSessions.$inferInsert, "externalSessionKey" | "processId" | "updatedAt" | "runtimeMode"> & {
  externalSessionKey?: string;
  processId?: number;
  runtimeMode?: string | null;
  updatedAt?: string;
};
type SessionUpdateRow = Omit<
  typeof runtimeSessions.$inferInsert,
  "externalSessionKey" | "processId" | "updatedAt" | "runtimeMode"
> & {
  externalSessionKey: string | null;
  processId: number | null;
  runtimeMode: string | null;
  updatedAt: string | null;
};

function toRow(session: RuntimeSession): SessionInsertRow {
  const row: SessionInsertRow = {
    id: session.id,
    runId: session.runId,
    runtime: session.runtime,
    provider: session.provider,
    model: session.model,
    protocol: session.protocol,
    status: session.status,
    runtimeMode: session.runtimeMode ?? null,
    stateJson: JSON.stringify(session.state),
    createdAt: session.createdAt
  };
  if (session.externalSessionKey !== undefined) {
    row.externalSessionKey = session.externalSessionKey;
  }
  if (session.processId !== undefined) {
    row.processId = session.processId;
  }
  if (session.updatedAt !== undefined) {
    row.updatedAt = session.updatedAt;
  }
  return row;
}

function toUpdateRow(session: RuntimeSession): SessionUpdateRow {
  return {
    id: session.id,
    runId: session.runId,
    runtime: session.runtime,
    provider: session.provider,
    model: session.model,
    protocol: session.protocol,
    status: session.status,
    runtimeMode: session.runtimeMode ?? null,
    stateJson: JSON.stringify(session.state),
    createdAt: session.createdAt,
    externalSessionKey: session.externalSessionKey ?? null,
    processId: session.processId ?? null,
    updatedAt: session.updatedAt ?? null
  };
}

function fromRow(row: SessionRow): RuntimeSession {
  const session: RuntimeSession = {
    id: row.id,
    runId: row.runId,
    runtime: row.runtime,
    provider: row.provider,
    model: row.model,
    protocol: row.protocol as RuntimeSession["protocol"],
    status: row.status as RuntimeSession["status"],
    runtimeMode: row.runtimeMode,
    state: JSON.parse(row.stateJson),
    createdAt: row.createdAt
  };
  if (row.externalSessionKey !== null) {
    session.externalSessionKey = row.externalSessionKey;
  }
  if (row.processId !== null) {
    session.processId = row.processId;
  }
  if (row.updatedAt !== null) {
    session.updatedAt = row.updatedAt;
  }
  return session;
}

export class SqliteSessionStore implements SessionStore {
  constructor(private readonly db: SwitchyardSqliteDatabase) {}

  async create(session: RuntimeSession): Promise<RuntimeSession> {
    await this.db.insert(runtimeSessions).values(toRow(session));
    return session;
  }

  async get(id: string): Promise<RuntimeSession | undefined> {
    const rows = await this.db.select().from(runtimeSessions).where(eq(runtimeSessions.id, id)).limit(1);
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return fromRow(row);
  }

  async update(session: RuntimeSession): Promise<RuntimeSession> {
    await this.db.update(runtimeSessions).set(toUpdateRow(session)).where(eq(runtimeSessions.id, session.id));
    return session;
  }

  async getByRunId(runId: string): Promise<RuntimeSession | undefined> {
    const rows = await this.db
      .select()
      .from(runtimeSessions)
      .where(eq(runtimeSessions.runId, runId))
      .orderBy(asc(runtimeSessions.createdAt))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return fromRow(row);
  }
}
