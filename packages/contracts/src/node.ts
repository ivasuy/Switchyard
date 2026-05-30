import { z } from "zod";
import { isoDateSchema, nodeIdSchema } from "./ids.js";

export const nodeStatusSchema = z.enum(["online", "offline", "degraded", "unknown"]);

export const nodePolicySchema = z.object({
  allowRuntimeModes: z.array(z.string()).default([]),
  denyAdapterTypes: z.array(z.string()).default([]),
  allowCwdPrefixes: z.array(z.string()).default([]),
  allowEventTypes: z.array(z.string()).default([]),
  artifactSync: z.enum(["none", "metadata_only", "full"]).default("full"),
  maxArtifactBytes: z.number().int().positive().optional()
});

export const nodeSchema = z.object({
  id: nodeIdSchema,
  mode: z.enum(["local", "hosted", "hybrid"]),
  status: nodeStatusSchema,
  capabilities: z.array(z.string()),
  policy: nodePolicySchema.optional(),
  version: z.string().min(1).optional(),
  createdAt: isoDateSchema,
  lastSeenAt: isoDateSchema.optional(),
  heartbeatExpiresAt: isoDateSchema.optional(),
  updatedAt: isoDateSchema.optional()
});

export type ConnectedNode = z.infer<typeof nodeSchema>;
export type NodePolicy = z.infer<typeof nodePolicySchema>;
