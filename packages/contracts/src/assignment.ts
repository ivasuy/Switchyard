import { z } from "zod";
import { artifactIdSchema, isoDateSchema, nodeIdSchema, runIdSchema } from "./ids.js";
import { eventSchema } from "./event.js";
import { artifactTypeSchema } from "./artifact.js";
import { runSchema } from "./run.js";

export const assignmentStatusSchema = z.enum([
  "pending",
  "claimed",
  "running",
  "completed",
  "failed",
  "cancelled",
  "expired"
]);

export const assignmentSchema = z.object({
  id: z.string().regex(/^assignment_[A-Za-z0-9_-]+$/),
  runId: runIdSchema,
  nodeId: nodeIdSchema,
  status: assignmentStatusSchema,
  claimedAt: isoDateSchema.optional(),
  startedAt: isoDateSchema.optional(),
  completedAt: isoDateSchema.optional(),
  failedAt: isoDateSchema.optional(),
  retryCount: z.number().int().nonnegative().default(0),
  lastEventSequence: z.number().int().nonnegative().default(0),
  lastArtifactSyncAt: isoDateSchema.optional(),
  error: z.string().min(1).optional(),
  createdAt: isoDateSchema
});

export const nodeRegisterRequestSchema = z.object({
  id: nodeIdSchema.optional(),
  mode: z.enum(["local", "hosted", "hybrid"]).default("hybrid"),
  capabilities: z.array(z.string()),
  policy: z
    .object({
      allowRuntimeModes: z.array(z.string()).default([]),
      denyAdapterTypes: z.array(z.string()).default([]),
      allowCwdPrefixes: z.array(z.string()).default([]),
      allowEventTypes: z.array(z.string()).default([]),
      artifactSync: z.enum(["none", "metadata_only", "full"]).default("full"),
      maxArtifactBytes: z.number().int().positive().optional()
    })
    .optional(),
  version: z.string().min(1).optional()
});

export const nodeHeartbeatRequestSchema = z.object({
  capabilities: z.array(z.string()).optional(),
  policy: nodeRegisterRequestSchema.shape.policy.optional()
});

export const assignmentClaimRequestSchema = z.object({
  assignmentId: assignmentSchema.shape.id.optional(),
  now: isoDateSchema.optional()
});

export const assignmentRejectRequestSchema = z.object({
  reason: z.string().min(1)
});

export const assignmentClaimResponseSchema = z.object({
  assignment: assignmentSchema.nullable(),
  run: runSchema.nullable()
});

export const assignmentEventSyncRequestSchema = z.object({
  cursor: z.number().int().nonnegative().optional(),
  events: z.array(eventSchema).default([])
});

export const assignmentEventSyncResponseSchema = z.object({
  accepted: z.boolean(),
  appended: z.number().int().nonnegative(),
  nextCursor: z.number().int().nonnegative()
});

export const artifactManifestEntrySchema = z.object({
  id: artifactIdSchema,
  type: artifactTypeSchema,
  path: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  syncContent: z.boolean()
});

export const assignmentArtifactManifestRequestSchema = z.object({
  artifacts: z.array(artifactManifestEntrySchema).default([])
});

export const assignmentArtifactManifestResponseSchema = z.object({
  accepted: z.boolean(),
  artifacts: z.array(
    z.object({
      id: artifactIdSchema,
      accepted: z.boolean(),
      contentStored: z.boolean().optional(),
      reason: z.string().optional()
    })
  )
});

export const assignmentArtifactContentMetadataSchema = z.object({
  contentType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i)
});

export const assignmentCompleteRequestSchema = z.object({
  status: z.enum(["completed", "failed", "cancelled"]),
  error: z.string().min(1).optional()
});

export type Assignment = z.infer<typeof assignmentSchema>;
export type AssignmentStatus = z.infer<typeof assignmentStatusSchema>;
export type NodeRegisterRequest = z.infer<typeof nodeRegisterRequestSchema>;
export type NodeHeartbeatRequest = z.infer<typeof nodeHeartbeatRequestSchema>;
export type AssignmentClaimRequest = z.infer<typeof assignmentClaimRequestSchema>;
export type AssignmentClaimResponse = z.infer<typeof assignmentClaimResponseSchema>;
export type AssignmentEventSyncRequest = z.infer<typeof assignmentEventSyncRequestSchema>;
export type AssignmentEventSyncResponse = z.infer<typeof assignmentEventSyncResponseSchema>;
export type AssignmentArtifactManifestRequest = z.infer<typeof assignmentArtifactManifestRequestSchema>;
export type AssignmentArtifactManifestResponse = z.infer<typeof assignmentArtifactManifestResponseSchema>;
export type AssignmentCompleteRequest = z.infer<typeof assignmentCompleteRequestSchema>;
