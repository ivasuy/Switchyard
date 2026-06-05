import { z } from "zod";
import {
  accountIdSchema,
  apiKeyIdSchema,
  auditLogEventIdSchema,
  billingPlanIdSchema,
  isoDateSchema,
  metadataSchema,
  projectIdSchema,
  quotaReservationIdSchema,
  runtimeModeSlugSchema,
  tenantIdSchema,
  userIdSchema
} from "./ids.js";
import { executionPlacementSchema } from "./run.js";
import { userSchema } from "./user.js";
import { toolTypeSchema } from "./tool.js";

const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?$/, "must be a lowercase slug");

export const accountStatusSchema = z.enum(["active", "suspended", "deleted"]);
export const tenantStatusSchema = z.enum(["active", "suspended", "deleted"]);
export const projectStatusSchema = z.enum(["active", "archived", "deleted"]);
export const apiKeyStatusSchema = z.enum(["active", "revoked", "expired"]);
export const billingPlanStatusSchema = z.enum(["active", "archived"]);

export const authScopeSchema = z.enum([
  "runs:write",
  "runs:read",
  "tools:write",
  "tools:read",
  "artifacts:read",
  "registry:read",
  "nodes:write",
  "metrics:read",
  "audit:read",
  "entitlements:read",
  "admin:read"
]);

export const accountSchema = z
  .object({
    id: accountIdSchema,
    name: z.string().min(1),
    status: accountStatusSchema,
    billingPlanId: billingPlanIdSchema,
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema.optional()
  })
  .strict();

export const tenantSchema = z
  .object({
    id: tenantIdSchema,
    accountId: accountIdSchema,
    slug: slugSchema,
    displayName: z.string().min(1),
    status: tenantStatusSchema,
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema.optional()
  })
  .strict();

export const projectSchema = z
  .object({
    id: projectIdSchema,
    accountId: accountIdSchema,
    tenantId: tenantIdSchema,
    slug: slugSchema,
    displayName: z.string().min(1),
    status: projectStatusSchema,
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema.optional()
  })
  .strict();

const apiKeyBaseSchema = z.object({
  id: apiKeyIdSchema,
  accountId: accountIdSchema,
  tenantId: tenantIdSchema,
  projectId: projectIdSchema,
  userId: userIdSchema,
  name: z.string().min(1),
  keyPrefix: z.string().min(1),
  scopes: z.array(authScopeSchema),
  status: apiKeyStatusSchema,
  expiresAt: isoDateSchema.optional(),
  lastUsedAt: isoDateSchema.optional(),
  createdAt: isoDateSchema,
  revokedAt: isoDateSchema.optional()
});

export const apiKeyPublicSchema = apiKeyBaseSchema.strict();

export const apiKeyStoredSchema = apiKeyBaseSchema
  .extend({
    secretHash: z.string().min(1)
  })
  .strict();

export const billingPlanEntitlementsSchema = z
  .object({
    allowedPlacements: z.array(executionPlacementSchema),
    allowedRuntimeModes: z.array(runtimeModeSlugSchema),
    allowHostedRealRuntime: z.boolean(),
    allowConnectedNodes: z.boolean(),
    allowHostedTools: z.boolean().default(false),
    allowConnectedNodeTools: z.boolean().default(false),
    allowedToolTypes: z.array(toolTypeSchema).default([]),
    allowArtifactContentRead: z.boolean(),
    allowToolArtifactContentRead: z.boolean().default(false),
    allowMetricsRead: z.boolean(),
    allowAuditRead: z.boolean()
  })
  .strict();

export const billingPlanQuotasSchema = z
  .object({
    maxRunsPerHour: z.number().int().nonnegative(),
    maxActiveRuns: z.number().int().nonnegative(),
    maxRunTimeoutSeconds: z.number().int().positive(),
    maxConnectedNodes: z.number().int().nonnegative(),
    maxArtifactContentReadBytesPerHour: z.number().int().nonnegative(),
    maxToolInvocationsPerHour: z.number().int().nonnegative().default(0),
    maxActiveToolInvocations: z.number().int().nonnegative().default(0),
    maxToolArtifactBytesPerHour: z.number().int().nonnegative().default(0),
    maxRuntimeBridgeCommandsPerHour: z.number().int().nonnegative().default(0),
    maxActiveRuntimeBridgeCommands: z.number().int().nonnegative().default(0)
  })
  .strict();

export const billingPlanSchema = z
  .object({
    id: billingPlanIdSchema,
    slug: slugSchema,
    displayName: z.string().min(1),
    status: billingPlanStatusSchema,
    entitlements: billingPlanEntitlementsSchema,
    quotas: billingPlanQuotasSchema,
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema.optional()
  })
  .strict();

export const quotaKindSchema = z.enum([
  "runs_per_hour",
  "active_runs",
  "debates_per_hour",
  "active_debates",
  "artifact_read_bytes_per_hour",
  "connected_nodes",
  "tool_invocations_per_hour",
  "active_tool_invocations",
  "tool_artifact_bytes_per_hour",
  "runtime_bridge_commands_per_hour",
  "active_runtime_bridge_commands"
]);

export const entitlementSnapshotSchema = z
  .object({
    accountId: accountIdSchema,
    tenantId: tenantIdSchema,
    projectId: projectIdSchema,
    planId: billingPlanIdSchema,
    planSlug: slugSchema,
    planDisplayName: z.string().min(1),
    planStatus: billingPlanStatusSchema.optional(),
    entitlements: billingPlanEntitlementsSchema,
    quotas: billingPlanQuotasSchema,
    scopes: z.array(authScopeSchema),
    capturedAt: isoDateSchema
  })
  .strict();

export const quotaUsageSchema = z
  .object({
    accountId: accountIdSchema,
    tenantId: tenantIdSchema,
    projectId: projectIdSchema,
    quotaKind: quotaKindSchema,
    used: z.number().int().nonnegative(),
    windowStartedAt: isoDateSchema,
    windowEndsAt: isoDateSchema,
    updatedAt: isoDateSchema
  })
  .strict();

export const quotaReservationStateSchema = z.enum(["reserved", "consumed", "released", "failed", "expired"]);

export const quotaReservationSchema = z
  .object({
    id: quotaReservationIdSchema,
    accountId: accountIdSchema,
    tenantId: tenantIdSchema,
    projectId: projectIdSchema,
    quotaKind: quotaKindSchema,
    amount: z.number().int().positive(),
    state: quotaReservationStateSchema,
    reasonCode: z.string().min(1),
    createdAt: isoDateSchema,
    expiresAt: isoDateSchema,
    finalizedAt: isoDateSchema.optional()
  })
  .strict();

export const resourceOwnershipTypeSchema = z.enum([
  "run",
  "debate",
  "run_event",
  "artifact",
  "tool_invocation",
  "approval",
  "runtime_bridge_command",
  "placement_decision",
  "node",
  "assignment",
  "audit_log_event",
  "quota",
  "auth"
]);

export const resourceOwnershipSchema = z
  .object({
    resourceType: resourceOwnershipTypeSchema,
    resourceId: z.string().min(1),
    accountId: accountIdSchema,
    tenantId: tenantIdSchema,
    projectId: projectIdSchema,
    userId: userIdSchema,
    apiKeyId: apiKeyIdSchema,
    createdAt: isoDateSchema
  })
  .strict();

export const authContextSchema = z
  .object({
    account: accountSchema,
    tenant: tenantSchema,
    project: projectSchema,
    user: userSchema,
    apiKey: apiKeyPublicSchema,
    entitlement: entitlementSnapshotSchema
  })
  .strict();

export const auditActorTypeSchema = z.enum(["api_key", "node_token", "system"]);
export const auditDecisionSchema = z.enum(["allow", "deny", "error"]);
export const auditEventTypeSchema = z.enum([
  "api_key.auth_failed",
  "api_key.auth_succeeded",
  "tenant.access_denied",
  "run.create_allowed",
  "run.create_denied",
  "quota.denied",
  "entitlement.denied",
  "artifact.read_allowed",
  "artifact.read_denied",
  "node.auth_failed",
  "node.register_allowed",
  "node.register_denied",
  "config.fail_closed",
  "api_key.revoked",
  "tool.invoke_allowed",
  "tool.invoke_denied",
  "tool.approval_requested",
  "tool.approval_resolved",
  "tool.execution_dispatched",
  "tool.execution_started",
  "tool.execution_completed",
  "tool.execution_failed",
  "tool.execution_cancelled"
]);

export const auditResourceTypeSchema = z.enum([
  "auth",
  "run",
  "artifact",
  "tool_invocation",
  "approval",
  "node",
  "assignment",
  "quota",
  "entitlement",
  "config",
  "tenant",
  "project",
  "account",
  "metrics",
  "audit_log_event",
  "placement_decision"
]);

export const auditLogEventSchema = z
  .object({
    id: auditLogEventIdSchema,
    accountId: accountIdSchema,
    tenantId: tenantIdSchema,
    projectId: projectIdSchema.optional(),
    actorType: auditActorTypeSchema,
    actorUserId: userIdSchema.optional(),
    apiKeyId: apiKeyIdSchema.optional(),
    eventType: auditEventTypeSchema,
    resourceType: auditResourceTypeSchema.optional(),
    resourceId: z.string().min(1).optional(),
    decision: auditDecisionSchema,
    reasonCode: z.string().min(1).optional(),
    ipHash: z.string().min(1).optional(),
    userAgent: z.string().min(1).optional(),
    requestId: z.string().min(1).optional(),
    payload: metadataSchema,
    createdAt: isoDateSchema
  })
  .strict();

export const whoamiResponseSchema = z
  .object({
    auth: authContextSchema
  })
  .strict();

export const entitlementsResponseSchema = z
  .object({
    entitlement: entitlementSnapshotSchema
  })
  .strict();

export const auditEventsResponseSchema = z
  .object({
    events: z.array(auditLogEventSchema),
    nextCursor: z.string().min(1).optional()
  })
  .strict();

export type Account = z.infer<typeof accountSchema>;
export type Tenant = z.infer<typeof tenantSchema>;
export type Project = z.infer<typeof projectSchema>;
export type ApiKeyPublic = z.infer<typeof apiKeyPublicSchema>;
export type ApiKeyStored = z.infer<typeof apiKeyStoredSchema>;
export type BillingPlan = z.infer<typeof billingPlanSchema>;
export type EntitlementSnapshot = z.infer<typeof entitlementSnapshotSchema>;
export type QuotaUsage = z.infer<typeof quotaUsageSchema>;
export type QuotaReservation = z.infer<typeof quotaReservationSchema>;
export type ResourceOwnership = z.infer<typeof resourceOwnershipSchema>;
export type AuthContext = z.infer<typeof authContextSchema>;
export type AuditLogEvent = z.infer<typeof auditLogEventSchema>;
export type WhoamiResponse = z.infer<typeof whoamiResponseSchema>;
export type EntitlementsResponse = z.infer<typeof entitlementsResponseSchema>;
export type AuditEventsResponse = z.infer<typeof auditEventsResponseSchema>;
