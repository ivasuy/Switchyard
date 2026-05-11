import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type SwitchyardSqliteDatabase = BetterSQLite3Database<typeof schema>;

export interface OpenSqliteStorageResult {
  sqlite: Database.Database;
  db: SwitchyardSqliteDatabase;
}

const migrationSql = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY NOT NULL,
  runtime TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  adapter_type TEXT NOT NULL,
  cwd TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL,
  placement TEXT NOT NULL,
  approval_policy TEXT NOT NULL,
  timeout_seconds INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS run_events (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  run_id TEXT,
  debate_id TEXT,
  participant_id TEXT,
  provider TEXT,
  model TEXT,
  sequence INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  runtime TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  protocol TEXT NOT NULL,
  status TEXT NOT NULL,
  external_session_key TEXT,
  process_id INTEGER,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT,
  debate_id TEXT,
  provider TEXT,
  model TEXT,
  type TEXT NOT NULL,
  path TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS run_events_run_sequence_idx
  ON run_events (run_id, sequence);

CREATE UNIQUE INDEX IF NOT EXISTS runtime_sessions_run_id_idx
  ON runtime_sessions (run_id);

CREATE INDEX IF NOT EXISTS artifacts_run_id_idx
  ON artifacts (run_id);
`;

function migrate(sqlite: Database.Database): void {
  sqlite.exec(migrationSql);
}

export function openSqliteStorage(path: string): OpenSqliteStorageResult {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  migrate(sqlite);
  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}
