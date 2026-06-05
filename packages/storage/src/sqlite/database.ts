import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { existsSync, statSync } from "node:fs";
import * as schema from "./schema.js";

export type SwitchyardSqliteDatabase = BetterSQLite3Database<typeof schema>;

export interface OpenSqliteStorageResult {
  sqlite: Database.Database;
  db: SwitchyardSqliteDatabase;
}

export const SQLITE_SCHEMA_VERSION = 11;

const FORBIDDEN_MIGRATION_TOKENS = ["DROP TABLE", "DROP COLUMN", "ALTER TABLE", "RENAME TO"] as const;

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
  runtime_mode TEXT,
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

CREATE TABLE IF NOT EXISTS debates (
  id TEXT PRIMARY KEY NOT NULL,
  topic TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  participants_json TEXT NOT NULL,
  limits_json TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  message_ids_json TEXT NOT NULL,
  event_ids_json TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  judge_json TEXT,
  final_report_artifact_id TEXT,
  final_report_path TEXT,
  stop_reason TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  completed_at TEXT
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
  runtime_mode TEXT,
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

CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY NOT NULL,
  scope TEXT NOT NULL,
  project_id TEXT,
  run_id TEXT,
  debate_id TEXT,
  provider TEXT,
  model TEXT,
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  embedding_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_items (
  id TEXT PRIMARY KEY NOT NULL,
  debate_id TEXT,
  source_type TEXT NOT NULL,
  url TEXT,
  title TEXT NOT NULL,
  snippet TEXT,
  fetched_content_path TEXT,
  reliability TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_invocations (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  approval_id TEXT,
  input_json TEXT NOT NULL,
  output_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
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

CREATE TABLE IF NOT EXISTS runtime_modes (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  adapter_type TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  limitations_json TEXT NOT NULL,
  placement_json TEXT NOT NULL,
  availability_json TEXT NOT NULL,
  docs_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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

CREATE INDEX IF NOT EXISTS run_events_debate_sequence_idx
  ON run_events (debate_id, sequence);

CREATE INDEX IF NOT EXISTS debates_created_at_idx
  ON debates (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS debates_status_idx
  ON debates (status);

CREATE UNIQUE INDEX IF NOT EXISTS runtime_sessions_run_id_idx
  ON runtime_sessions (run_id);

CREATE INDEX IF NOT EXISTS artifacts_run_id_idx
  ON artifacts (run_id);

CREATE INDEX IF NOT EXISTS artifacts_debate_id_idx
  ON artifacts (debate_id);

CREATE INDEX IF NOT EXISTS messages_from_run_id_idx
  ON messages (from_run_id);

CREATE INDEX IF NOT EXISTS messages_to_run_id_idx
  ON messages (to_run_id);

CREATE INDEX IF NOT EXISTS messages_channel_idx
  ON messages (channel);

CREATE INDEX IF NOT EXISTS messages_created_at_idx
  ON messages (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS approvals_run_id_idx
  ON approvals (run_id);

CREATE INDEX IF NOT EXISTS approvals_status_idx
  ON approvals (status);

CREATE INDEX IF NOT EXISTS approvals_type_idx
  ON approvals (approval_type);

CREATE INDEX IF NOT EXISTS approvals_created_at_idx
  ON approvals (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS memory_items_scope_idx
  ON memory_items (scope);

CREATE INDEX IF NOT EXISTS memory_items_project_id_idx
  ON memory_items (project_id);

CREATE INDEX IF NOT EXISTS memory_items_run_id_idx
  ON memory_items (run_id);

CREATE INDEX IF NOT EXISTS memory_items_debate_id_idx
  ON memory_items (debate_id);

CREATE INDEX IF NOT EXISTS memory_items_provider_idx
  ON memory_items (provider);

CREATE INDEX IF NOT EXISTS memory_items_model_idx
  ON memory_items (model);

CREATE INDEX IF NOT EXISTS memory_items_created_at_idx
  ON memory_items (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS evidence_items_debate_id_idx
  ON evidence_items (debate_id);

CREATE INDEX IF NOT EXISTS evidence_items_source_type_idx
  ON evidence_items (source_type);

CREATE INDEX IF NOT EXISTS evidence_items_reliability_idx
  ON evidence_items (reliability);

CREATE INDEX IF NOT EXISTS evidence_items_created_at_idx
  ON evidence_items (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS tool_invocations_run_id_idx
  ON tool_invocations (run_id);

CREATE INDEX IF NOT EXISTS tool_invocations_type_idx
  ON tool_invocations (type);

CREATE INDEX IF NOT EXISTS tool_invocations_status_idx
  ON tool_invocations (status);

CREATE INDEX IF NOT EXISTS tool_invocations_approval_id_idx
  ON tool_invocations (approval_id);

CREATE INDEX IF NOT EXISTS tool_invocations_created_at_idx
  ON tool_invocations (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS placement_decisions_run_id_idx
  ON placement_decisions (run_id);

CREATE INDEX IF NOT EXISTS runs_created_at_idx
  ON runs (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS models_provider_id_idx
  ON models (provider_id);

CREATE INDEX IF NOT EXISTS runtime_modes_provider_id_idx
  ON runtime_modes (provider_id);

CREATE INDEX IF NOT EXISTS runtime_modes_runtime_id_idx
  ON runtime_modes (runtime_id);

CREATE INDEX IF NOT EXISTS runtime_modes_status_idx
  ON runtime_modes (status);

CREATE TABLE IF NOT EXISTS schema_metadata (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const additiveMigrations: Array<{ table: string; column: string; statement: string }> = [
  {
    table: "run_events",
    column: "debate_id",
    statement: "ALTER TABLE run_events ADD COLUMN debate_id TEXT"
  },
  {
    table: "run_events",
    column: "participant_id",
    statement: "ALTER TABLE run_events ADD COLUMN participant_id TEXT"
  },
  {
    table: "run_events",
    column: "provider",
    statement: "ALTER TABLE run_events ADD COLUMN provider TEXT"
  },
  {
    table: "run_events",
    column: "model",
    statement: "ALTER TABLE run_events ADD COLUMN model TEXT"
  },
  {
    table: "artifacts",
    column: "debate_id",
    statement: "ALTER TABLE artifacts ADD COLUMN debate_id TEXT"
  },
  {
    table: "runtimes",
    column: "provider_id",
    statement: "ALTER TABLE runtimes ADD COLUMN provider_id TEXT"
  },
  {
    table: "runs",
    column: "runtime_mode",
    statement: "ALTER TABLE runs ADD COLUMN runtime_mode TEXT"
  },
  {
    table: "runtime_sessions",
    column: "runtime_mode",
    statement: "ALTER TABLE runtime_sessions ADD COLUMN runtime_mode TEXT"
  }
];

function applyAdditiveMigrations(sqlite: Database.Database): void {
  for (const migration of additiveMigrations) {
    assertAdditiveMigrationStatement(migration.statement);
    const tableExists = sqlite
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(migration.table) as { present?: number } | undefined;
    if (!tableExists?.present) {
      continue;
    }
    const columnInfo = sqlite.prepare(`PRAGMA table_info(${migration.table})`).all() as Array<{ name: string }>;
    const existing = new Set(columnInfo.map((row) => row.name));
    if (existing.has(migration.column)) {
      continue;
    }
    sqlite.exec(migration.statement);
  }
}

function migrate(sqlite: Database.Database): void {
  // Additive column migrations must run before index creation so very old
  // snapshots can gain required columns first.
  applyAdditiveMigrations(sqlite);
  sqlite.exec(migrationSql);
  applyAdditiveMigrations(sqlite);
  sqlite.exec(`
CREATE INDEX IF NOT EXISTS runtimes_provider_id_idx
  ON runtimes (provider_id);
`);
  sqlite
    .prepare("INSERT OR REPLACE INTO schema_metadata (key, value, updated_at) VALUES ('schema_version', ?, ?)")
    .run(String(SQLITE_SCHEMA_VERSION), new Date().toISOString());
}

function assertAdditiveMigrationStatement(statement: string): void {
  const normalized = statement.toUpperCase();
  if (!normalized.startsWith("ALTER TABLE")) {
    return;
  }
  if (!normalized.includes(" ADD COLUMN ")) {
    throw new Error(`Destructive migration blocked by policy: ${statement}`);
  }
}

function assertExistingFileReadable(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  const stats = statSync(path);
  if (stats.size === 0) {
    throw new Error(`SQLite database is zero-byte and unreadable: ${path}`);
  }
}

function assertDatabaseIntegrity(sqlite: Database.Database, path: string): void {
  const row = sqlite.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
  const status = row?.quick_check;
  if (status !== "ok") {
    throw new Error(`SQLite integrity check failed for ${path}: ${status ?? "unknown failure"}`);
  }
}

export function openSqliteStorage(path: string): OpenSqliteStorageResult {
  assertExistingFileReadable(path);
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  assertDatabaseIntegrity(sqlite, path);
  migrate(sqlite);
  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}

export function getSqliteMigrationPolicy(): {
  destructiveStatementsForbidden: true;
  forbiddenTokens: readonly string[];
} {
  return {
    destructiveStatementsForbidden: true,
    forbiddenTokens: FORBIDDEN_MIGRATION_TOKENS
  };
}

export function assertSqliteMigrationStatementSafe(statement: string): void {
  const normalized = statement.toUpperCase();
  for (const token of FORBIDDEN_MIGRATION_TOKENS) {
    if (normalized.includes(token) && !normalized.includes(" ADD COLUMN ")) {
      throw new Error(`Migration statement violates additive policy: ${statement}`);
    }
  }
}
