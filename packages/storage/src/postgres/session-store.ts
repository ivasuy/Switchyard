import type { RuntimeSession } from "@switchyard/contracts";
import type { SessionStore } from "@switchyard/core";
import type { PostgresDatabaseHandle } from "./database.js";

export class PostgresSessionStore implements SessionStore {
  private readonly items = new Map<string, RuntimeSession>();

  constructor(private readonly handle?: PostgresDatabaseHandle) {}

  async create(session: RuntimeSession): Promise<RuntimeSession> {
    if (this.handle) {
      await this.upsert(session);
      return session;
    }
    this.items.set(session.id, session);
    return session;
  }

  async get(id: string): Promise<RuntimeSession | undefined> {
    if (this.handle) {
      const result = await this.handle.pool.query("SELECT * FROM runtime_sessions WHERE id = $1", [id]);
      return result.rows[0] ? rowToSession(result.rows[0]) : undefined;
    }
    return this.items.get(id);
  }

  async getByRunId(runId: string): Promise<RuntimeSession | undefined> {
    if (this.handle) {
      const result = await this.handle.pool.query("SELECT * FROM runtime_sessions WHERE run_id = $1 ORDER BY created_at DESC LIMIT 1", [runId]);
      return result.rows[0] ? rowToSession(result.rows[0]) : undefined;
    }
    return [...this.items.values()].find((session) => session.runId === runId);
  }

  async update(session: RuntimeSession): Promise<RuntimeSession> {
    if (this.handle) {
      await this.upsert(session);
      return session;
    }
    this.items.set(session.id, session);
    return session;
  }

  private async upsert(session: RuntimeSession): Promise<void> {
    await this.handle?.pool.query(
      `INSERT INTO runtime_sessions (
        id, run_id, runtime, provider, model, protocol, status, external_session_key,
        process_id, runtime_mode, state, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (id) DO UPDATE SET
        run_id = EXCLUDED.run_id,
        runtime = EXCLUDED.runtime,
        provider = EXCLUDED.provider,
        model = EXCLUDED.model,
        protocol = EXCLUDED.protocol,
        status = EXCLUDED.status,
        external_session_key = EXCLUDED.external_session_key,
        process_id = EXCLUDED.process_id,
        runtime_mode = EXCLUDED.runtime_mode,
        state = EXCLUDED.state,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at`,
      [
        session.id,
        session.runId,
        session.runtime,
        session.provider,
        session.model,
        session.protocol,
        session.status,
        session.externalSessionKey ?? null,
        session.processId ?? null,
        session.runtimeMode ?? null,
        session.state,
        session.createdAt,
        session.updatedAt ?? null
      ]
    );
  }
}

function rowToSession(row: Record<string, unknown>): RuntimeSession {
  const session: RuntimeSession = {
    id: row["id"] as string,
    runId: row["run_id"] as string,
    runtime: row["runtime"] as string,
    provider: row["provider"] as string,
    model: row["model"] as string,
    protocol: row["protocol"] as RuntimeSession["protocol"],
    status: row["status"] as RuntimeSession["status"],
    state: row["state"] as Record<string, unknown>,
    createdAt: row["created_at"] as string
  };
  if (row["external_session_key"]) session.externalSessionKey = row["external_session_key"] as string;
  if (row["process_id"]) session.processId = row["process_id"] as number;
  if (row["runtime_mode"]) session.runtimeMode = row["runtime_mode"] as string;
  if (row["updated_at"]) session.updatedAt = row["updated_at"] as string;
  return session;
}
