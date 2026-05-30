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
  runtimeMode: text("runtime_mode"),
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

export const debates = sqliteTable("debates", {
  id: text("id").primaryKey(),
  topic: text("topic").notNull(),
  mode: text("mode").notNull(),
  status: text("status").notNull(),
  participantsJson: text("participants_json").notNull(),
  limitsJson: text("limits_json").notNull(),
  evidenceIdsJson: text("evidence_ids_json").notNull(),
  messageIdsJson: text("message_ids_json").notNull(),
  eventIdsJson: text("event_ids_json").notNull(),
  budgetJson: text("budget_json").notNull(),
  judgeJson: text("judge_json"),
  finalReportArtifactId: text("final_report_artifact_id"),
  finalReportPath: text("final_report_path"),
  stopReason: text("stop_reason"),
  errorJson: text("error_json"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at"),
  completedAt: text("completed_at")
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
  runtimeMode: text("runtime_mode"),
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

export const memoryItems = sqliteTable("memory_items", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(),
  projectId: text("project_id"),
  runId: text("run_id"),
  debateId: text("debate_id"),
  provider: text("provider"),
  model: text("model"),
  content: text("content").notNull(),
  metadataJson: text("metadata_json").notNull(),
  embeddingJson: text("embedding_json"),
  createdAt: text("created_at").notNull()
});

export const evidenceItems = sqliteTable("evidence_items", {
  id: text("id").primaryKey(),
  debateId: text("debate_id"),
  sourceType: text("source_type").notNull(),
  url: text("url"),
  title: text("title").notNull(),
  snippet: text("snippet"),
  fetchedContentPath: text("fetched_content_path"),
  reliability: text("reliability").notNull(),
  createdAt: text("created_at").notNull()
});

export const toolInvocations = sqliteTable("tool_invocations", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  type: text("type").notNull(),
  status: text("status").notNull(),
  approvalId: text("approval_id"),
  inputJson: text("input_json").notNull(),
  outputJson: text("output_json"),
  errorJson: text("error_json"),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at")
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
  status: text("status").notNull(),
  providerId: text("provider_id")
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

export const runtimeModes = sqliteTable("runtime_modes", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  providerId: text("provider_id").notNull(),
  runtimeId: text("runtime_id").notNull(),
  adapterId: text("adapter_id").notNull(),
  adapterType: text("adapter_type").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  capabilitiesJson: text("capabilities_json").notNull(),
  limitationsJson: text("limitations_json").notNull(),
  placementJson: text("placement_json").notNull(),
  availabilityJson: text("availability_json").notNull(),
  docsPath: text("docs_path"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
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
  debates,
  runtimeSessions,
  artifacts,
  messages,
  approvals,
  memoryItems,
  evidenceItems,
  toolInvocations,
  providers,
  runtimes,
  models,
  runtimeModes,
  placementDecisions
};
