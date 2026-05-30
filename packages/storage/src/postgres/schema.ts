import { boolean, index, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";

export const runs = pgTable("runs", {
  id: text("id").primaryKey(),
  runtime: text("runtime").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  adapterType: text("adapter_type").notNull(),
  cwd: text("cwd").notNull(),
  task: text("task").notNull(),
  status: text("status").notNull(),
  placement: text("placement").notNull(),
  approvalPolicy: text("approval_policy").notNull(),
  timeoutSeconds: integer("timeout_seconds").notNull(),
  metadata: jsonb("metadata").notNull(),
  runtimeMode: text("runtime_mode"),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at"),
  endedAt: text("ended_at")
}, (table) => [index("runs_created_idx").on(table.createdAt, table.id)]);

export const runEvents = pgTable("run_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  runId: text("run_id"),
  debateId: text("debate_id"),
  participantId: text("participant_id"),
  provider: text("provider"),
  model: text("model"),
  sequence: integer("sequence").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [index("run_events_run_seq_idx").on(table.runId, table.sequence)]);

export const runtimeSessions = pgTable("runtime_sessions", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  runtime: text("runtime").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  protocol: text("protocol").notNull(),
  status: text("status").notNull(),
  externalSessionKey: text("external_session_key"),
  processId: integer("process_id"),
  runtimeMode: text("runtime_mode"),
  state: jsonb("state").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at")
});

export const artifacts = pgTable("artifacts", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  debateId: text("debate_id"),
  provider: text("provider"),
  model: text("model"),
  type: text("type").notNull(),
  path: text("path").notNull(),
  metadata: jsonb("metadata").notNull(),
  createdAt: text("created_at").notNull()
});

export const providers = pgTable("providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  authMode: text("auth_mode").notNull(),
  status: text("status").notNull()
});

export const runtimes = pgTable("runtimes", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  adapterType: text("adapter_type").notNull(),
  status: text("status").notNull(),
  providerId: text("provider_id")
});

export const models = pgTable("models", {
  id: text("id").primaryKey(),
  providerId: text("provider_id").notNull(),
  modelName: text("model_name").notNull(),
  supportsTools: boolean("supports_tools").notNull(),
  supportsStreaming: boolean("supports_streaming").notNull(),
  supportsBrowser: boolean("supports_browser").notNull(),
  status: text("status").notNull()
});

export const runtimeModes = pgTable("runtime_modes", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  providerId: text("provider_id").notNull(),
  runtimeId: text("runtime_id").notNull(),
  adapterId: text("adapter_id").notNull(),
  adapterType: text("adapter_type").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  capabilities: jsonb("capabilities").notNull(),
  limitations: jsonb("limitations").notNull(),
  placement: jsonb("placement").notNull(),
  availability: jsonb("availability").notNull(),
  docsPath: text("docs_path"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const placementDecisions = pgTable("placement_decisions", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  decision: text("decision").notNull(),
  reason: text("reason").notNull(),
  mode: text("mode").notNull(),
  targetNode: text("target_node"),
  requiredCapabilities: jsonb("required_capabilities").notNull(),
  deniedCapabilities: jsonb("denied_capabilities").notNull(),
  approvalRequired: boolean("approval_required").notNull(),
  policyTrace: jsonb("policy_trace").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [index("placement_run_idx").on(table.runId)]);

export const nodes = pgTable("nodes", {
  id: text("id").primaryKey(),
  mode: text("mode").notNull(),
  status: text("status").notNull(),
  capabilities: jsonb("capabilities").notNull(),
  policy: jsonb("policy"),
  version: text("version"),
  createdAt: text("created_at").notNull(),
  lastSeenAt: text("last_seen_at"),
  heartbeatExpiresAt: text("heartbeat_expires_at"),
  updatedAt: text("updated_at")
}, (table) => [index("nodes_status_idx").on(table.status)]);

export const assignments = pgTable("assignments", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  nodeId: text("node_id").notNull(),
  status: text("status").notNull(),
  claimedAt: text("claimed_at"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  failedAt: text("failed_at"),
  retryCount: integer("retry_count").notNull(),
  lastEventSequence: integer("last_event_sequence").notNull(),
  lastArtifactSyncAt: text("last_artifact_sync_at"),
  error: text("error"),
  createdAt: text("created_at").notNull()
}, (table) => [index("assignments_claim_idx").on(table.nodeId, table.status)]);
