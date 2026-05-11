import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const runs = sqliteTable("runs", {
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
  metadataJson: text("metadata_json").notNull(),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at"),
  endedAt: text("ended_at")
});

export const runEvents = sqliteTable("run_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  runId: text("run_id"),
  debateId: text("debate_id"),
  participantId: text("participant_id"),
  provider: text("provider"),
  model: text("model"),
  sequence: integer("sequence").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull()
});

export const runtimeSessions = sqliteTable("runtime_sessions", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  runtime: text("runtime").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  protocol: text("protocol").notNull(),
  status: text("status").notNull(),
  externalSessionKey: text("external_session_key"),
  processId: integer("process_id"),
  stateJson: text("state_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at")
});

export const artifacts = sqliteTable("artifacts", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  debateId: text("debate_id"),
  provider: text("provider"),
  model: text("model"),
  type: text("type").notNull(),
  path: text("path").notNull(),
  metadataJson: text("metadata_json").notNull(),
  createdAt: text("created_at").notNull()
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  fromRunId: text("from_run_id"),
  toRunId: text("to_run_id"),
  channel: text("channel"),
  content: text("content").notNull(),
  attachmentsJson: text("attachments_json").notNull(),
  deliveryStatus: text("delivery_status").notNull(),
  createdAt: text("created_at").notNull(),
  deliveredAt: text("delivered_at")
});

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  approvalType: text("approval_type").notNull(),
  status: text("status").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at")
});

export const providers = sqliteTable("providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  authMode: text("auth_mode").notNull(),
  status: text("status").notNull()
});

export const runtimes = sqliteTable("runtimes", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  adapterType: text("adapter_type").notNull(),
  status: text("status").notNull()
});

export const models = sqliteTable("models", {
  id: text("id").primaryKey(),
  providerId: text("provider_id").notNull(),
  modelName: text("model_name").notNull(),
  supportsTools: integer("supports_tools").notNull(),
  supportsStreaming: integer("supports_streaming").notNull(),
  supportsBrowser: integer("supports_browser").notNull(),
  status: text("status").notNull()
});

export const placementDecisions = sqliteTable("placement_decisions", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  decision: text("decision").notNull(),
  reason: text("reason").notNull(),
  mode: text("mode").notNull(),
  targetNode: text("target_node"),
  requiredCapabilitiesJson: text("required_capabilities_json").notNull(),
  deniedCapabilitiesJson: text("denied_capabilities_json").notNull(),
  approvalRequired: integer("approval_required").notNull(),
  policyTraceJson: text("policy_trace_json").notNull(),
  createdAt: text("created_at").notNull()
});

export const schema = {
  runs,
  runEvents,
  runtimeSessions,
  artifacts,
  messages,
  approvals,
  providers,
  runtimes,
  models,
  placementDecisions
};
