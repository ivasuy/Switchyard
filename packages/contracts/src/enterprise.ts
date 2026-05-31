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
  tenantIdSchema,
  userIdSchema
} from "./ids.js";
import { userSchema } from "./user.js";

const statusSchema = z.string().min(1);
const scopeSchema = z.string().min(1);

export const accountSchema = z
  .object({
    id: accountIdSchema,
    name: z.string().min(1),
    status: statusSchema,
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema.optional()
  })
  .strict();

export const tenantSchema = z
  .object({
    id: tenantIdSchema,
    accountId: accountIdSchema,
    name: z.string().min(1),
    status: statusSchema,
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema.optional()
  })
  .strict();

export const projectSchema = z
  .object({
    id: projectIdSchema,
    accountId: accountIdSchema,
    tenantId: tenantIdSchema,
    name: z.string().min(1),
    status: statusSchema,
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
  scopes: z.array(scopeSchema),
  status: statusSchema,
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema.optional(),
  expiresAt: isoDateSchema.optional(),
  revokedAt: isoDateSchema.optional()
});

export const apiKeyPublicSchema = apiKeyBaseSchema.strict();

export const apiKeyStoredSchema = apiKeyBaseSchema
  .extend({
    secretHash: z.string().min(1)
  })
  .strict();

export const billingPlanSchema = z
  .object({
    id: billingPlanIdSchema,
    accountId: accountIdSchema,
    tenantId: tenantIdSchema,
    name: z.string().min(1),
    status: statusSchema,
    allowedPlacements: z.array(z.string().min(1)),
    allowedRuntimeModes: z.array(z.string().min(1)),
    allowHostedRealRuntime: z.boolean(),
    maxTimeoutSeconds: z.number().int().positive(),
    maxRunsPerHour: z.number().int().nonnegative(),
    maxActiveRuns: z.number().int().nonnegative(),
    maxConnectedNodes: z.number().int().nonnegative(),
    maxArtifactContentReadBytesPerHour: z.number().int().nonnegative(),
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema.optional()
  })
  .strict();

export const quotaKindSchema = z.enum([
  "runs_per_hour",
  "active_runs",
  "artifact_read_bytes_per_hour",
  "connected_nodes"
]);

export const entitlementSnapshotSchema = z
  .object({
    accountId: accountIdSchema,
    tenantId: tenantIdSchema,
    projectId: projectIdSchema,
    planId: billingPlanIdSchema,
    planName: z.string().min(1),
    allowedPlacements: z.array(z.string().min(1)),
    allowedRuntimeModes: z.array(z.string().min(1)),
    allowHostedRealRuntime: z.boolean(),
    maxTimeoutSeconds: z.number().int().positive(),
    maxRunsPerHour: z.number().int().nonnegative(),
    maxActiveRuns: z.number().int().nonnegative(),
    maxConnectedNodes: z.number().int().nonnegative(),
    maxArtifactContentReadBytesPerHour: z.number().int().nonnegative(),
    scopes: z.array(scopeSchema),
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

export const resourceOwnershipSchema = z
  .object({
    resourceType: z.string().min(1),
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

export const auditLogOutcomeSchema = z.enum(["allowed", "denied", "failed"]);

export const auditLogEventSchema = z
  .object({
    id: auditLogEventIdSchema,
    accountId: accountIdSchema,
    tenantId: tenantIdSchema,
    projectId: projectIdSchema,
    actorUserId: userIdSchema.optional(),
    actorApiKeyId: apiKeyIdSchema.optional(),
    action: z.string().min(1),
    resourceType: z.string().min(1),
    resourceId: z.string().min(1).optional(),
    outcome: auditLogOutcomeSchema,
    reasonCode: z.string().min(1).optional(),
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
