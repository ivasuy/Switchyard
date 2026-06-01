import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

export const POSTGRES_SCHEMA_VERSION = 20;

const SCHEMA_METADATA_KEY = "schema_version";

const SCHEMA_METADATA_UPSERT_SQL = `
INSERT INTO schema_metadata (key, value, updated_at)
VALUES ($1, $2, $3)
ON CONFLICT (key)
DO UPDATE SET
  value = EXCLUDED.value,
  updated_at = EXCLUDED.updated_at
`;

const destructiveSqlMatchers: RegExp[] = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bTRUNCATE\b/i,
  /\bALTER\s+TABLE\b[\s\S]*\bALTER\s+COLUMN\b[\s\S]*\bSET\s+NOT\s+NULL\b/i,
  /\bCREATE\s+TABLE\b[\s\S]*\bAS\s+SELECT\b/i,
  /\bINSERT\s+INTO\b[\s\S]*\bSELECT\b/i
];

export type PostgresSchemaCompatibility =
  | { ok: true; code: "postgres_schema_ready"; version: number }
  | {
      ok: false;
      code:
        | "postgres_schema_migration_required"
        | "postgres_schema_version_unsupported"
        | "postgres_schema_malformed"
        | "postgres_unavailable";
      version?: number;
      diagnostics?: Record<string, unknown>;
    };

export interface CheckPostgresSchemaCompatibilityOptions {
  skipProbe?: boolean;
}

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
  const migrationSql = `
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
  kind text,
  tool_invocation_id text,
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
CREATE INDEX IF NOT EXISTS assignments_kind_idx ON assignments(kind, created_at, id);
CREATE INDEX IF NOT EXISTS assignments_tool_invocation_idx ON assignments(tool_invocation_id);
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS kind text;
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS tool_invocation_id text;

CREATE TABLE IF NOT EXISTS approvals (
  id text PRIMARY KEY,
  run_id text,
  approval_type text NOT NULL,
  status text NOT NULL,
  payload jsonb NOT NULL,
  created_at text NOT NULL,
  resolved_at text
);
CREATE INDEX IF NOT EXISTS approvals_run_idx ON approvals(run_id);
CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals(status);
CREATE INDEX IF NOT EXISTS approvals_type_idx ON approvals(approval_type);
CREATE INDEX IF NOT EXISTS approvals_created_idx ON approvals(created_at, id);

CREATE TABLE IF NOT EXISTS tool_invocations (
  id text PRIMARY KEY,
  run_id text,
  type text NOT NULL,
  status text NOT NULL,
  approval_id text,
  input jsonb NOT NULL,
  output jsonb,
  error jsonb,
  created_at text NOT NULL,
  completed_at text
);
CREATE INDEX IF NOT EXISTS tool_invocations_run_idx ON tool_invocations(run_id);
CREATE INDEX IF NOT EXISTS tool_invocations_status_idx ON tool_invocations(status);
CREATE INDEX IF NOT EXISTS tool_invocations_approval_idx ON tool_invocations(approval_id);
CREATE INDEX IF NOT EXISTS tool_invocations_created_idx ON tool_invocations(created_at, id);

CREATE TABLE IF NOT EXISTS tool_dispatch_outbox (
  id text PRIMARY KEY,
  approval_id text NOT NULL,
  tool_invocation_id text NOT NULL,
  run_id text NOT NULL,
  target_placement text NOT NULL,
  execution_plan_hash text NOT NULL,
  dispatch_status text NOT NULL,
  attempt_count integer NOT NULL,
  last_error_code text,
  dispatch_id text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS tool_dispatch_outbox_approval_invocation_idx
  ON tool_dispatch_outbox(approval_id, tool_invocation_id);
CREATE INDEX IF NOT EXISTS tool_dispatch_outbox_retry_idx
  ON tool_dispatch_outbox(dispatch_status, updated_at, id);

CREATE TABLE IF NOT EXISTS billing_plans (
  id text PRIMARY KEY,
  slug text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL,
  entitlements jsonb NOT NULL,
  quotas jsonb NOT NULL,
  created_at text NOT NULL,
  updated_at text
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_plans_slug_idx ON billing_plans(slug);

CREATE TABLE IF NOT EXISTS accounts (
  id text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL,
  billing_plan_id text NOT NULL,
  created_at text NOT NULL,
  updated_at text
);
CREATE INDEX IF NOT EXISTS accounts_plan_idx ON accounts(billing_plan_id);

CREATE TABLE IF NOT EXISTS tenants (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  slug text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL,
  created_at text NOT NULL,
  updated_at text
);
CREATE UNIQUE INDEX IF NOT EXISTS tenants_account_slug_idx ON tenants(account_id, slug);
CREATE INDEX IF NOT EXISTS tenants_account_status_idx ON tenants(account_id, status);

CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  tenant_id text NOT NULL,
  slug text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL,
  created_at text NOT NULL,
  updated_at text
);
CREATE UNIQUE INDEX IF NOT EXISTS projects_tenant_slug_idx ON projects(tenant_id, slug);
CREATE INDEX IF NOT EXISTS projects_scope_status_idx ON projects(account_id, tenant_id, status);

CREATE TABLE IF NOT EXISTS enterprise_users (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  tenant_id text NOT NULL,
  display_name text NOT NULL,
  email text,
  status text NOT NULL,
  created_at text NOT NULL,
  updated_at text
);
CREATE INDEX IF NOT EXISTS enterprise_users_scope_status_idx ON enterprise_users(account_id, tenant_id, status);

CREATE TABLE IF NOT EXISTS api_keys (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  user_id text NOT NULL,
  name text NOT NULL,
  key_prefix text NOT NULL,
  secret_hash text NOT NULL,
  scopes jsonb NOT NULL,
  status text NOT NULL,
  expires_at text,
  last_used_at text,
  created_at text NOT NULL,
  revoked_at text
);
CREATE INDEX IF NOT EXISTS api_keys_prefix_idx ON api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS api_keys_hash_idx ON api_keys(secret_hash);
CREATE INDEX IF NOT EXISTS api_keys_scope_status_idx ON api_keys(account_id, tenant_id, project_id, status);

CREATE TABLE IF NOT EXISTS quota_reservations (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  quota_kind text NOT NULL,
  amount integer NOT NULL,
  state text NOT NULL,
  reason_code text NOT NULL,
  created_at text NOT NULL,
  updated_at text,
  expires_at text NOT NULL,
  finalized_at text
);
CREATE INDEX IF NOT EXISTS quota_reservations_scope_state_idx
  ON quota_reservations(account_id, tenant_id, project_id, quota_kind, state, expires_at);

CREATE TABLE IF NOT EXISTS quota_usage (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  quota_kind text NOT NULL,
  window_start text NOT NULL,
  window_end text NOT NULL,
  used integer NOT NULL,
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS quota_usage_scope_kind_idx
  ON quota_usage(account_id, tenant_id, project_id, quota_kind);

CREATE TABLE IF NOT EXISTS audit_log_events (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  tenant_id text NOT NULL,
  project_id text,
  actor_type text NOT NULL,
  actor_user_id text,
  api_key_id text,
  event_type text NOT NULL,
  resource_type text,
  resource_id text,
  decision text NOT NULL,
  reason_code text,
  ip_hash text,
  user_agent text,
  request_id text,
  payload jsonb NOT NULL,
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_events_scope_idx
  ON audit_log_events(account_id, tenant_id, project_id, created_at, id);

CREATE TABLE IF NOT EXISTS resource_ownership (
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  account_id text NOT NULL,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  user_id text NOT NULL,
  api_key_id text NOT NULL,
  created_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS resource_ownership_resource_idx
  ON resource_ownership(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS resource_ownership_scope_idx
  ON resource_ownership(resource_type, account_id, tenant_id, project_id, resource_id);

CREATE TABLE IF NOT EXISTS schema_metadata (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at text NOT NULL
);
`;
  assertPostgresMigrationSqlAdditive(migrationSql);
  await handle.pool.query(migrationSql);
}

export async function probePostgresDatabase(handle: PostgresDatabaseHandle): Promise<{ ok: true }> {
  await handle.pool.query("select 1");
  return { ok: true };
}

export function assertPostgresMigrationSqlAdditive(sql: string): void {
  for (const matcher of destructiveSqlMatchers) {
    if (matcher.test(sql)) {
      throw new Error(`destructive_migration_blocked: ${matcher.source}`);
    }
  }
}

export async function migratePostgresSchema(handle: PostgresDatabaseHandle): Promise<{ ok: true; version: number }> {
  const migrationBlocks = [SCHEMA_METADATA_UPSERT_SQL];
  await ensurePostgresSchema(handle);
  for (const block of migrationBlocks) {
    assertPostgresMigrationSqlAdditive(block);
  }
  await handle.pool.query(SCHEMA_METADATA_UPSERT_SQL, [
    SCHEMA_METADATA_KEY,
    String(POSTGRES_SCHEMA_VERSION),
    new Date().toISOString()
  ]);
  return { ok: true, version: POSTGRES_SCHEMA_VERSION };
}

export async function checkPostgresSchemaCompatibility(
  handle: PostgresDatabaseHandle,
  options: CheckPostgresSchemaCompatibilityOptions = {}
): Promise<PostgresSchemaCompatibility> {
  if (!options.skipProbe) {
    try {
      await probePostgresDatabase(handle);
    } catch {
      return {
        ok: false,
        code: "postgres_unavailable",
        diagnostics: { expectedVersion: POSTGRES_SCHEMA_VERSION }
      };
    }
  }

  let row: { value?: unknown } | undefined;
  try {
    const result = await handle.pool.query(
      "SELECT value FROM schema_metadata WHERE key = $1 LIMIT 1",
      [SCHEMA_METADATA_KEY]
    );
    row = result.rows[0] as { value?: unknown } | undefined;
  } catch (error) {
    if (isMissingRelationError(error)) {
      return {
        ok: false,
        code: "postgres_schema_migration_required",
        diagnostics: { expectedVersion: POSTGRES_SCHEMA_VERSION, metadataPresent: false }
      };
    }
    return {
      ok: false,
      code: "postgres_unavailable",
      diagnostics: { expectedVersion: POSTGRES_SCHEMA_VERSION }
    };
  }

  const raw = typeof row?.value === "string" ? row.value.trim() : "";
  if (!raw) {
    return {
      ok: false,
      code: "postgres_schema_migration_required",
      diagnostics: { expectedVersion: POSTGRES_SCHEMA_VERSION, metadataPresent: false }
    };
  }

  if (!/^\d+$/.test(raw)) {
    return {
      ok: false,
      code: "postgres_schema_malformed",
      diagnostics: { expectedVersion: POSTGRES_SCHEMA_VERSION, metadataPresent: true }
    };
  }

  const actualVersion = Number(raw);
  if (actualVersion > POSTGRES_SCHEMA_VERSION) {
    return {
      ok: false,
      code: "postgres_schema_version_unsupported",
      version: actualVersion,
      diagnostics: {
        expectedVersion: POSTGRES_SCHEMA_VERSION,
        actualVersion,
        metadataPresent: true
      }
    };
  }

  if (actualVersion < POSTGRES_SCHEMA_VERSION) {
    return {
      ok: false,
      code: "postgres_schema_migration_required",
      version: actualVersion,
      diagnostics: {
        expectedVersion: POSTGRES_SCHEMA_VERSION,
        actualVersion,
        metadataPresent: true
      }
    };
  }

  return { ok: true, code: "postgres_schema_ready", version: actualVersion };
}

function isMissingRelationError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  if ("code" in error && error.code === "42P01") {
    return true;
  }
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  return /relation .* does not exist/i.test(message);
}
