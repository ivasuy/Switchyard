import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

export interface PostgresDatabaseHandle {
  pool: Pool;
  db: NodePgDatabase<typeof schema>;
  real: true;
  close: () => Promise<void>;
}

export function openPostgresDatabase(connectionString: string): PostgresDatabaseHandle {
  const pool = new Pool({ connectionString });
  const db = drizzle({ client: pool, schema });
  return {
    pool,
    db,
    real: true,
    close: async () => {
      await pool.end();
    }
  };
}

export async function ensurePostgresSchema(handle: PostgresDatabaseHandle): Promise<void> {
  await handle.pool.query(`
CREATE TABLE IF NOT EXISTS runs (
  id text PRIMARY KEY,
  runtime text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  adapter_type text NOT NULL,
  cwd text NOT NULL,
  task text NOT NULL,
  status text NOT NULL,
  placement text NOT NULL,
  approval_policy text NOT NULL,
  timeout_seconds integer NOT NULL,
  metadata jsonb NOT NULL,
  runtime_mode text,
  created_at text NOT NULL,
  started_at text,
  ended_at text
);
CREATE INDEX IF NOT EXISTS runs_created_idx ON runs(created_at, id);

CREATE TABLE IF NOT EXISTS run_events (
  id text PRIMARY KEY,
  type text NOT NULL,
  run_id text,
  debate_id text,
  participant_id text,
  provider text,
  model text,
  sequence integer NOT NULL,
  payload jsonb NOT NULL,
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS run_events_run_seq_idx ON run_events(run_id, sequence);
CREATE INDEX IF NOT EXISTS run_events_debate_seq_idx ON run_events(debate_id, sequence);

CREATE TABLE IF NOT EXISTS runtime_sessions (
  id text PRIMARY KEY,
  run_id text NOT NULL,
  runtime text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  protocol text NOT NULL,
  status text NOT NULL,
  external_session_key text,
  process_id integer,
  runtime_mode text,
  state jsonb NOT NULL,
  created_at text NOT NULL,
  updated_at text
);

CREATE TABLE IF NOT EXISTS artifacts (
  id text PRIMARY KEY,
  run_id text,
  debate_id text,
  provider text,
  model text,
  type text NOT NULL,
  path text NOT NULL,
  metadata jsonb NOT NULL,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
  id text PRIMARY KEY,
  name text NOT NULL,
  auth_mode text NOT NULL,
  status text NOT NULL
);

CREATE TABLE IF NOT EXISTS runtimes (
  id text PRIMARY KEY,
  name text NOT NULL,
  adapter_type text NOT NULL,
  status text NOT NULL,
  provider_id text
);

CREATE TABLE IF NOT EXISTS models (
  id text PRIMARY KEY,
  provider_id text NOT NULL,
  model_name text NOT NULL,
  supports_tools boolean NOT NULL,
  supports_streaming boolean NOT NULL,
  supports_browser boolean NOT NULL,
  status text NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_modes (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  provider_id text NOT NULL,
  runtime_id text NOT NULL,
  adapter_id text NOT NULL,
  adapter_type text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  capabilities jsonb NOT NULL,
  limitations jsonb NOT NULL,
  placement jsonb NOT NULL,
  availability jsonb NOT NULL,
  docs_path text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS placement_decisions (
  id text PRIMARY KEY,
  run_id text,
  decision text NOT NULL,
  reason text NOT NULL,
  mode text NOT NULL,
  target_node text,
  required_capabilities jsonb NOT NULL,
  denied_capabilities jsonb NOT NULL,
  approval_required boolean NOT NULL,
  policy_trace jsonb NOT NULL,
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS placement_run_idx ON placement_decisions(run_id);

CREATE TABLE IF NOT EXISTS nodes (
  id text PRIMARY KEY,
  mode text NOT NULL,
  status text NOT NULL,
  capabilities jsonb NOT NULL,
  policy jsonb,
  version text,
  created_at text NOT NULL,
  last_seen_at text,
  heartbeat_expires_at text,
  updated_at text
);
CREATE INDEX IF NOT EXISTS nodes_status_idx ON nodes(status);

CREATE TABLE IF NOT EXISTS assignments (
  id text PRIMARY KEY,
  run_id text NOT NULL,
  node_id text NOT NULL,
  status text NOT NULL,
  claimed_at text,
  started_at text,
  completed_at text,
  failed_at text,
  retry_count integer NOT NULL,
  last_event_sequence integer NOT NULL,
  last_artifact_sync_at text,
  error text,
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS assignments_claim_idx ON assignments(node_id, status);
`);
}

export async function probePostgresDatabase(handle: PostgresDatabaseHandle): Promise<{ ok: true }> {
  await handle.pool.query("select 1");
  return { ok: true };
}
