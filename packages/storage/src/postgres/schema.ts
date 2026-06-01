import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

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
  kind: text("kind"),
  toolInvocationId: text("tool_invocation_id"),
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
}, (table) => [
  index("assignments_claim_idx").on(table.nodeId, table.status),
  index("assignments_kind_idx").on(table.kind, table.createdAt, table.id),
  index("assignments_tool_invocation_idx").on(table.toolInvocationId)
]);

export const approvals = pgTable("approvals", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  approvalType: text("approval_type").notNull(),
  status: text("status").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at")
}, (table) => [
  index("approvals_run_idx").on(table.runId),
  index("approvals_status_idx").on(table.status),
  index("approvals_type_idx").on(table.approvalType),
  index("approvals_created_idx").on(table.createdAt, table.id)
]);

export const toolInvocations = pgTable("tool_invocations", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  type: text("type").notNull(),
  status: text("status").notNull(),
  approvalId: text("approval_id"),
  input: jsonb("input").notNull(),
  output: jsonb("output"),
  error: jsonb("error"),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at")
}, (table) => [
  index("tool_invocations_run_idx").on(table.runId),
  index("tool_invocations_status_idx").on(table.status),
  index("tool_invocations_approval_idx").on(table.approvalId),
  index("tool_invocations_created_idx").on(table.createdAt, table.id)
]);

export const toolDispatchOutbox = pgTable("tool_dispatch_outbox", {
  id: text("id").primaryKey(),
  approvalId: text("approval_id").notNull(),
  toolInvocationId: text("tool_invocation_id").notNull(),
  runId: text("run_id").notNull(),
  targetPlacement: text("target_placement").notNull(),
  executionPlanHash: text("execution_plan_hash").notNull(),
  dispatchStatus: text("dispatch_status").notNull(),
  attemptCount: integer("attempt_count").notNull(),
  lastErrorCode: text("last_error_code"),
  dispatchId: text("dispatch_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [
  uniqueIndex("tool_dispatch_outbox_approval_invocation_idx").on(table.approvalId, table.toolInvocationId),
  index("tool_dispatch_outbox_retry_idx").on(table.dispatchStatus, table.updatedAt, table.id)
]);

export const billingPlans = pgTable("billing_plans", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull(),
  displayName: text("display_name").notNull(),
  status: text("status").notNull(),
  entitlements: jsonb("entitlements").notNull(),
  quotas: jsonb("quotas").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at")
}, (table) => [uniqueIndex("billing_plans_slug_idx").on(table.slug)]);

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  billingPlanId: text("billing_plan_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at")
}, (table) => [index("accounts_plan_idx").on(table.billingPlanId)]);

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  slug: text("slug").notNull(),
  displayName: text("display_name").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at")
}, (table) => [
  uniqueIndex("tenants_account_slug_idx").on(table.accountId, table.slug),
  index("tenants_account_status_idx").on(table.accountId, table.status)
]);

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  slug: text("slug").notNull(),
  displayName: text("display_name").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at")
}, (table) => [
  uniqueIndex("projects_tenant_slug_idx").on(table.tenantId, table.slug),
  index("projects_scope_status_idx").on(table.accountId, table.tenantId, table.status)
]);

export const enterpriseUsers = pgTable("enterprise_users", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  displayName: text("display_name").notNull(),
  email: text("email"),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at")
}, (table) => [index("enterprise_users_scope_status_idx").on(table.accountId, table.tenantId, table.status)]);

export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  projectId: text("project_id").notNull(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  secretHash: text("secret_hash").notNull(),
  scopes: jsonb("scopes").notNull(),
  status: text("status").notNull(),
  expiresAt: text("expires_at"),
  lastUsedAt: text("last_used_at"),
  createdAt: text("created_at").notNull(),
  revokedAt: text("revoked_at")
}, (table) => [
  index("api_keys_prefix_idx").on(table.keyPrefix),
  index("api_keys_hash_idx").on(table.secretHash),
  index("api_keys_scope_status_idx").on(table.accountId, table.tenantId, table.projectId, table.status)
]);

export const quotaReservations = pgTable("quota_reservations", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  projectId: text("project_id").notNull(),
  quotaKind: text("quota_kind").notNull(),
  amount: integer("amount").notNull(),
  state: text("state").notNull(),
  reasonCode: text("reason_code").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at"),
  expiresAt: text("expires_at").notNull(),
  finalizedAt: text("finalized_at")
}, (table) => [
  index("quota_reservations_scope_state_idx").on(
    table.accountId,
    table.tenantId,
    table.projectId,
    table.quotaKind,
    table.state,
    table.expiresAt
  )
]);

export const quotaUsage = pgTable("quota_usage", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  projectId: text("project_id").notNull(),
  quotaKind: text("quota_kind").notNull(),
  windowStart: text("window_start").notNull(),
  windowEnd: text("window_end").notNull(),
  used: integer("used").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [
  uniqueIndex("quota_usage_scope_kind_idx").on(table.accountId, table.tenantId, table.projectId, table.quotaKind)
]);

export const auditLogEvents = pgTable("audit_log_events", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  projectId: text("project_id"),
  actorType: text("actor_type").notNull(),
  actorUserId: text("actor_user_id"),
  apiKeyId: text("api_key_id"),
  eventType: text("event_type").notNull(),
  resourceType: text("resource_type"),
  resourceId: text("resource_id"),
  decision: text("decision").notNull(),
  reasonCode: text("reason_code"),
  ipHash: text("ip_hash"),
  userAgent: text("user_agent"),
  requestId: text("request_id"),
  payload: jsonb("payload").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [
  index("audit_log_events_scope_idx").on(table.accountId, table.tenantId, table.projectId, table.createdAt, table.id)
]);

export const resourceOwnership = pgTable("resource_ownership", {
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  accountId: text("account_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  projectId: text("project_id").notNull(),
  userId: text("user_id").notNull(),
  apiKeyId: text("api_key_id").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [
  uniqueIndex("resource_ownership_resource_idx").on(table.resourceType, table.resourceId),
  index("resource_ownership_scope_idx").on(table.resourceType, table.accountId, table.tenantId, table.projectId, table.resourceId)
]);

export const schemaMetadata = pgTable("schema_metadata", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull()
});
