import { z } from "zod";

export const httpErrorCodeSchema = z.enum([
  "run_not_found",
  "debate_not_found",
  "artifact_not_found",
  "missing_artifact_content",
  "provider_not_found",
  "runtime_not_found",
  "runtime_mode_not_found",
  "model_not_found",
  "message_not_found",
  "memory_not_found",
  "evidence_not_found",
  "approval_not_found",
  "tool_invocation_not_found",
  "approval_not_pending",
  "tool_policy_denied",
  "approval_required",
  "unsupported_tool",
  "invalid_input",
  "invalid_query",
  "adapter_protocol_failed",
  "internal_error",
  "placement_denied",
  "node_auth_required",
  "node_auth_failed",
  "node_not_found",
  "assignment_not_found",
  "assignment_claim_conflict",
  "node_policy_denied",
  "queue_unavailable",
  "event_sync_gap",
  "event_sync_conflict",
  "object_store_unavailable",
  "object_store_timeout",
  "object_store_auth_failed",
  "object_store_bucket_not_found",
  "object_store_read_failed",
  "artifact_digest_mismatch",
  "artifact_content_empty",
  "artifact_sync_failed",
  "hosted_runtime_not_allowed",
  "payload_too_large"
]);

export const httpErrorDetailSchema = z.object({
  path: z.string().min(1),
  issue: z.string().min(1)
});

export const httpErrorEnvelopeSchema = z.object({
  error: z.object({
    code: httpErrorCodeSchema,
    message: z.string().min(1),
    details: z.array(httpErrorDetailSchema).optional(),
    requestId: z.string().min(1).optional()
  })
});

export type HttpErrorCode = z.infer<typeof httpErrorCodeSchema>;
export type HttpErrorDetail = z.infer<typeof httpErrorDetailSchema>;
export type HttpErrorEnvelope = z.infer<typeof httpErrorEnvelopeSchema>;
