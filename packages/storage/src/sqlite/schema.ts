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

export const schema = {
  runs,
  runEvents,
  runtimeSessions,
  artifacts
};
