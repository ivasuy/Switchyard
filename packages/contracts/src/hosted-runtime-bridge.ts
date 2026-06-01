import { z } from "zod";
import {
  accountIdSchema,
  apiKeyIdSchema,
  approvalIdSchema,
  isoDateSchema,
  projectIdSchema,
  runIdSchema,
  runtimeModeSlugSchema,
  sessionIdSchema,
  tenantIdSchema,
  userIdSchema
} from "./ids.js";

export const HOSTED_RUNTIME_BRIDGE_REASON_CODES = [
  "hosted_runtime_bridge_store_unavailable",
  "hosted_runtime_bridge_queue_unavailable",
  "hosted_runtime_bridge_worker_unavailable",
  "hosted_runtime_bridge_operation_unsupported",
  "hosted_runtime_bridge_session_missing",
  "hosted_runtime_bridge_session_not_owned",
  "hosted_runtime_session_missing",
  "hosted_runtime_session_lost",
  "hosted_runtime_session_state_incomplete",
  "hosted_runtime_bridge_payload_mismatch",
  "hosted_runtime_bridge_command_expired",
  "hosted_runtime_bridge_non_idempotent_retry_blocked",
  "hosted_runtime_bridge_quota_exceeded",
  "hosted_codex_interactive_unshipped",
  "codex_exec_json_input_unsupported",
  "codex_exec_json_approval_bridge_unsupported",
  "agentfield_bridge_unshipped",
  "generic_http_bridge_unshipped"
] as const;

export const ACP_RUNTIME_BRIDGE_REASON_CODES = [
  "acp_permission_request_invalid",
  "acp_permission_response_failed",
  "acp_permission_request_expired",
  "acp_prompt_in_flight",
  "acp_session_not_ready_for_input"
] as const;

export const hostedRuntimeBridgeReasonCodeSchema = z.enum(HOSTED_RUNTIME_BRIDGE_REASON_CODES);
export const acpRuntimeBridgeReasonCodeSchema = z.enum(ACP_RUNTIME_BRIDGE_REASON_CODES);

export const hostedRuntimeBridgeOperationSchema = z.enum(["input", "approval_resolution"]);
export const hostedRuntimeBridgeStatusSchema = z.enum([
  "queued",
  "claimed",
  "completed",
  "failed",
  "expired",
  "cancelled"
]);
export const hostedRuntimeBridgeSupportedModeSchema = z.enum(["claude_code.sdk", "opencode.acp"]);

const HOSTED_RUNTIME_BRIDGE_ALLOWED_MODES = new Set<string>(hostedRuntimeBridgeSupportedModeSchema.options);

const SECRET_LIKE_KEYS =
  /^(?:text|prompt|raw|raw_prompt|rawprompt|secret|token|password|authorization|api[_-]?key|credential|env|command|args)$/i;

const MAX_REDACTED_PAYLOAD_BYTES = 16 * 1024;
const MAX_PAYLOAD_BYTES = 64 * 1024;

function containsSecretLikeKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => containsSecretLikeKey(entry));
  }
  if (!value || typeof value !== "object") {
    return false;
  }

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_LIKE_KEYS.test(key)) {
      return true;
    }
    if (containsSecretLikeKey(entry)) {
      return true;
    }
  }
  return false;
}

const redactedPayloadSchema = z
  .record(z.string(), z.unknown())
  .superRefine((payload, ctx) => {
    if (containsSecretLikeKey(payload)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "redacted payload must not include raw secret-like fields"
      });
    }

    const serialized = JSON.stringify(payload);
    if (serialized.length > MAX_REDACTED_PAYLOAD_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `redacted payload exceeds ${MAX_REDACTED_PAYLOAD_BYTES} bytes`
      });
    }
  });

export const hostedRuntimeBridgeCommandSchema = z
  .object({
    id: z.string().min(1),
    runId: runIdSchema,
    approvalId: approvalIdSchema.optional(),
    runtimeSessionId: sessionIdSchema.optional(),
    runtimeMode: runtimeModeSlugSchema,
    operation: hostedRuntimeBridgeOperationSchema,
    status: hostedRuntimeBridgeStatusSchema,
    idempotencyKey: z.string().min(1),
    payloadHash: z.string().min(1),
    redactedPayload: redactedPayloadSchema,
    payloadBytes: z.number().int().nonnegative().max(MAX_PAYLOAD_BYTES),
    accountId: accountIdSchema,
    tenantId: tenantIdSchema,
    projectId: projectIdSchema,
    userId: userIdSchema,
    apiKeyId: apiKeyIdSchema,
    workerId: z.string().min(1).optional(),
    leaseUntil: isoDateSchema.optional(),
    attempts: z.number().int().nonnegative(),
    maxAttempts: z.number().int().positive(),
    reasonCode: z.string().min(1).optional(),
    expiresAt: isoDateSchema,
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema
  })
  .strict();

export const hostedRuntimeBridgeReadinessCheckNameSchema = z.enum([
  "command_store",
  "command_outbox",
  "approval_ownership",
  "quota",
  "audit",
  "route_auth",
  "worker_claim",
  "adapter_capability",
  "session_reconciliation",
  "approval_sender"
]);

export const hostedRuntimeBridgeReadinessCheckSchema = z
  .object({
    name: hostedRuntimeBridgeReadinessCheckNameSchema,
    ok: z.boolean(),
    reasonCode: z.string().min(1).optional()
  })
  .strict();

export const hostedRuntimeBridgeReadinessReportSchema = z
  .object({
    status: z.enum(["ready", "not_ready"]),
    checks: z.array(hostedRuntimeBridgeReadinessCheckSchema)
  })
  .strict();

export const acceptedResponseSchema = z
  .object({
    accepted: z.boolean(),
    bridgeCommandId: z.string().min(1).optional()
  })
  .strict();

export function isHostedRuntimeBridgeSupportedMode(
  runtimeMode: string,
  operation?: z.infer<typeof hostedRuntimeBridgeOperationSchema>
): boolean {
  if (!HOSTED_RUNTIME_BRIDGE_ALLOWED_MODES.has(runtimeMode)) {
    return false;
  }
  if (operation === "approval_resolution") {
    return runtimeMode === "claude_code.sdk" || runtimeMode === "opencode.acp";
  }
  return true;
}

export type HostedRuntimeBridgeReasonCode = z.infer<typeof hostedRuntimeBridgeReasonCodeSchema>;
export type AcpRuntimeBridgeReasonCode = z.infer<typeof acpRuntimeBridgeReasonCodeSchema>;
export type HostedRuntimeBridgeOperation = z.infer<typeof hostedRuntimeBridgeOperationSchema>;
export type HostedRuntimeBridgeStatus = z.infer<typeof hostedRuntimeBridgeStatusSchema>;
export type HostedRuntimeBridgeSupportedMode = z.infer<typeof hostedRuntimeBridgeSupportedModeSchema>;
export type HostedRuntimeBridgeCommand = z.infer<typeof hostedRuntimeBridgeCommandSchema>;
export type HostedRuntimeBridgeReadinessCheckName = z.infer<typeof hostedRuntimeBridgeReadinessCheckNameSchema>;
export type HostedRuntimeBridgeReadinessCheck = z.infer<typeof hostedRuntimeBridgeReadinessCheckSchema>;
export type HostedRuntimeBridgeReadinessReport = z.infer<typeof hostedRuntimeBridgeReadinessReportSchema>;
export type AcceptedResponse = z.infer<typeof acceptedResponseSchema>;

