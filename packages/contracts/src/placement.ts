import { z } from "zod";

export const placementDecisionKindSchema = z.enum(["local", "hosted", "connected_local_node", "reject", "wait_for_approval"]);

export const placementDecisionSchema = z.object({
  decision: placementDecisionKindSchema,
  reason: z.string().min(1),
  mode: z.enum(["local", "hosted", "hybrid"]),
  targetNode: z.string().optional(),
  requiredCapabilities: z.array(z.string()),
  deniedCapabilities: z.array(z.string()),
  approvalRequired: z.boolean(),
  policyTrace: z.array(z.string())
});

export const placementRequestSchema = z.object({
  requestedPlacement: z.enum(["local", "hosted", "connected_local_node"]).optional(),
  runtimeMode: z.string().min(1),
  adapterType: z.string().min(1),
  now: z.string().datetime({ offset: true }).optional()
});

export const placementTraceSchema = z.object({
  code: z.string().min(1),
  detail: z.string().min(1)
});

export type PlacementDecision = z.infer<typeof placementDecisionSchema>;
export type PlacementRequest = z.infer<typeof placementRequestSchema>;
export type PlacementTrace = z.infer<typeof placementTraceSchema>;
