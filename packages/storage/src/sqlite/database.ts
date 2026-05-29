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

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY NOT NULL,
  from_run_id TEXT,
  to_run_id TEXT,
  channel TEXT,
  content TEXT NOT NULL,
  attachments_json TEXT NOT NULL,
  delivery_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT,
  approval_type TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  auth_mode TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtimes (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  adapter_type TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_id TEXT
);

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY NOT NULL,
  provider_id TEXT NOT NULL,
  model_name TEXT NOT NULL,
  supports_tools INTEGER NOT NULL,
  supports_streaming INTEGER NOT NULL,
  supports_browser INTEGER NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS placement_decisions (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  mode TEXT NOT NULL,
  target_node TEXT,
  required_capabilities_json TEXT NOT NULL,
  denied_capabilities_json TEXT NOT NULL,
  approval_required INTEGER NOT NULL,
  policy_trace_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS run_events_run_sequence_idx
  ON run_events (run_id, sequence);

CREATE UNIQUE INDEX IF NOT EXISTS runtime_sessions_run_id_idx
  ON runtime_sessions (run_id);

CREATE INDEX IF NOT EXISTS artifacts_run_id_idx
  ON artifacts (run_id);

CREATE INDEX IF NOT EXISTS placement_decisions_run_id_idx
  ON placement_decisions (run_id);

CREATE INDEX IF NOT EXISTS runs_created_at_idx
  ON runs (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS runtimes_provider_id_idx
  ON runtimes (provider_id);

CREATE INDEX IF NOT EXISTS models_provider_id_idx
  ON models (provider_id);
`;

const additiveMigrations: Array<{ column: string; statement: string }> = [
  {
    column: "provider_id",
    statement: "ALTER TABLE runtimes ADD COLUMN provider_id TEXT"
  }
];

function applyAdditiveMigrations(sqlite: Database.Database): void {
  const columnInfo = sqlite.prepare("PRAGMA table_info(runtimes)").all() as Array<{ name: string }>;
  const existing = new Set(columnInfo.map((row) => row.name));
  for (const migration of additiveMigrations) {
    if (existing.has(migration.column)) {
      continue;
    }
    sqlite.exec(migration.statement);
  }
}

function migrate(sqlite: Database.Database): void {
  sqlite.exec(migrationSql);
  applyAdditiveMigrations(sqlite);
}

export function openSqliteStorage(path: string): OpenSqliteStorageResult {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  migrate(sqlite);
  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}
