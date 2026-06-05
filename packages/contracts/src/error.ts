import { z } from "zod";

export const errorCodeSchema = z.enum([
  "validation_failed",
  "runtime_unavailable",
  "model_unavailable",
  "placement_denied",
  "approval_required",
  "approval_not_pending",
  "tool_policy_denied",
  "unsupported_tool",
  "adapter_launch_failed",
  "adapter_protocol_failed",
  "runtime_timeout",
  "user_cancelled",
  "debate_budget_exhausted",
  "artifact_persistence_failed"
]);

export const errorSchema = z.object({
  code: errorCodeSchema,
  message: z.string().min(1),
  requestId: z.string().optional(),
  runId: z.string().optional(),
  debateId: z.string().optional(),
  cause: z.unknown().optional()
});

export type SwitchyardError = z.infer<typeof errorSchema>;
