import type { FastifyInstance, FastifyReply } from "fastify";
import type { HttpErrorCode as ContractHttpErrorCode } from "@switchyard/contracts";
import { ZodError } from "zod";

export type HttpErrorCode = ContractHttpErrorCode;

export interface HttpErrorDetail {
  path: string;
  issue: string;
}

export interface HttpErrorEnvelope {
  error: {
    code: HttpErrorCode;
    message: string;
    details?: HttpErrorDetail[];
    requestId?: string;
  };
}

const STATUS_BY_CODE: Partial<Record<HttpErrorCode, number>> = {
  run_not_found: 404,
  debate_not_found: 404,
  debate_evidence_not_found_or_denied: 404,
  artifact_not_found: 404,
  missing_artifact_content: 404,
  provider_not_found: 404,
  runtime_not_found: 404,
  runtime_mode_not_found: 404,
  model_not_found: 404,
  message_not_found: 404,
  memory_not_found: 404,
  evidence_not_found: 404,
  approval_not_found: 404,
  tool_invocation_not_found: 404,
  debate_real_participant_opt_in_required: 400,
  debate_runtime_unsupported: 409,
  debate_wait_real_runtime_unsupported: 409,
  debate_participant_count_invalid: 400,
  debate_participant_placement_required: 400,
  debate_participant_run_missing: 409,
  debate_participant_run_failed: 409,
  debate_participant_run_timeout: 409,
  debate_participant_output_missing: 409,
  debate_participant_output_empty: 409,
  debate_participant_output_too_large: 409,
  debate_runtime_approval_expired: 409,
  debate_child_run_link_failed: 503,
  debate_judge_config_invalid: 400,
  debate_judge_runtime_unsupported: 409,
  debate_judge_live_spend_unconfirmed: 400,
  debate_judge_run_failed: 409,
  debate_judge_timeout: 409,
  debate_judge_output_missing: 409,
  debate_judge_output_empty: 409,
  debate_judge_output_invalid: 409,
  debate_judge_output_too_large: 409,
  hosted_debate_store_unavailable: 503,
  hosted_debate_queue_unavailable: 503,
  hosted_debate_worker_unavailable: 503,
  hosted_debate_ownership_attach_failed: 503,
  hosted_debate_quota_exceeded: 429,
  hosted_debate_audit_unavailable: 503,
  hosted_debate_artifact_write_failed: 503,
  hosted_debate_event_persist_failed: 503,
  debate_live_canary_spend_unconfirmed: 400,
  debate_fake_canary_failed: 503,
  approval_not_pending: 409,
  tool_run_required: 400,
  tool_target_invalid: 400,
  tool_target_mismatch: 409,
  tool_hosted_auth_required: 401,
  tool_store_unavailable: 503,
  tool_dispatch_unavailable: 503,
  tool_dispatch_failed: 503,
  tool_dispatch_retry_exhausted: 503,
  tool_policy_denied: 403,
  tool_policy_config_invalid: 403,
  tool_policy_failed: 409,
  tool_real_tools_disabled: 403,
  tool_hosted_tools_disabled: 403,
  tool_connected_node_tools_disabled: 403,
  tool_approval_required: 409,
  tool_approval_rejected: 409,
  tool_approval_expired: 409,
  tool_adapter_unavailable: 500,
  tool_input_limit_exceeded: 400,
  tool_concurrency_limit_exceeded: 409,
  tool_output_limit_exceeded: 409,
  tool_artifact_write_failed: 500,
  tool_redaction_failed: 500,
  tool_worker_restarted: 503,
  tool_node_unavailable: 409,
  tool_node_execution_failed: 500,
  tool_assignment_expired: 409,
  tool_assignment_mismatch: 409,
  hosted_runtime_approval_bridge_unshipped: 409,
  hosted_runtime_bridge_store_unavailable: 503,
  hosted_runtime_bridge_queue_unavailable: 503,
  hosted_runtime_bridge_worker_unavailable: 503,
  hosted_runtime_bridge_operation_unsupported: 409,
  hosted_runtime_bridge_session_missing: 409,
  hosted_runtime_bridge_session_not_owned: 409,
  hosted_runtime_session_missing: 409,
  hosted_runtime_session_lost: 409,
  hosted_runtime_session_state_incomplete: 409,
  hosted_runtime_bridge_payload_mismatch: 409,
  hosted_runtime_bridge_command_expired: 409,
  hosted_runtime_bridge_non_idempotent_retry_blocked: 409,
  hosted_runtime_bridge_quota_exceeded: 429,
  hosted_codex_interactive_unshipped: 409,
  codex_exec_json_input_unsupported: 409,
  codex_exec_json_approval_bridge_unsupported: 409,
  acp_permission_request_invalid: 409,
  acp_permission_response_failed: 409,
  acp_permission_request_expired: 409,
  acp_prompt_in_flight: 409,
  acp_session_not_ready_for_input: 409,
  agentfield_bridge_unshipped: 409,
  generic_http_bridge_unshipped: 409,
  approval_scope_denied: 403,
  repo_hosted_unshipped: 409,
  browser_tool_unshipped: 409,
  fetch_url_invalid: 400,
  fetch_host_not_allowlisted: 403,
  fetch_private_network_denied: 403,
  fetch_redirect_denied: 403,
  fetch_method_denied: 403,
  fetch_content_type_denied: 403,
  web_search_provider_unconfigured: 503,
  web_search_query_invalid: 400,
  github_token_missing: 503,
  github_repo_not_allowlisted: 403,
  github_operation_denied: 403,
  github_not_found: 404,
  github_rate_limited: 429,
  repo_cwd_denied: 403,
  repo_operation_denied: 403,
  repo_pathspec_invalid: 400,
  shell_command_denied: 403,
  shell_command_not_configured: 403,
  tool_process_spawn_failed: 500,
  tool_process_nonzero_exit: 409,
  tool_process_timeout: 409,
  tool_process_cancelled: 409,
  approval_required: 409,
  unsupported_tool: 409,
  invalid_input: 400,
  invalid_query: 400,
  adapter_protocol_failed: 409,
  placement_denied: 409,
  node_auth_required: 401,
  node_auth_failed: 401,
  node_not_found: 404,
  assignment_not_found: 404,
  assignment_claim_conflict: 409,
  node_policy_denied: 403,
  queue_unavailable: 503,
  event_sync_gap: 409,
  event_sync_conflict: 409,
  object_store_unavailable: 503,
  object_store_timeout: 503,
  object_store_auth_failed: 503,
  object_store_bucket_not_found: 503,
  object_store_read_failed: 503,
  artifact_digest_mismatch: 409,
  artifact_content_empty: 409,
  artifact_sync_failed: 500,
  hosted_runtime_not_allowed: 409,
  payload_too_large: 413,
  auth_required: 401,
  auth_failed: 401,
  auth_conflict: 401,
  auth_store_unavailable: 503,
  tenant_access_denied: 403,
  project_access_denied: 403,
  entitlement_denied: 403,
  quota_exceeded: 429,
  audit_log_unavailable: 503,
  internal_error: 500
};

export class HttpProblem extends Error {
  readonly code: HttpErrorCode;
  readonly status: number;
  readonly details?: HttpErrorDetail[];

  constructor(code: HttpErrorCode, message: string, details?: HttpErrorDetail[]) {
    super(message);
    this.code = code;
    this.status = STATUS_BY_CODE[code] ?? 500;
    if (details) {
      this.details = details;
    }
  }
}

export function buildErrorEnvelope(
  code: HttpErrorCode,
  message: string,
  details?: HttpErrorDetail[],
  requestId?: string
): HttpErrorEnvelope {
  const envelope: HttpErrorEnvelope = {
    error: {
      code,
      message
    }
  };
  if (details && details.length > 0) {
    envelope.error.details = details;
  }
  if (requestId && requestId.length > 0) {
    envelope.error.requestId = requestId;
  }
  return envelope;
}

export function sendHttpError(
  reply: FastifyReply,
  code: HttpErrorCode,
  message: string,
  details?: HttpErrorDetail[]
): FastifyReply {
  const requestId = reply.request.id;
  if (requestId) {
    reply.header("x-request-id", requestId);
  }
  return reply.code(STATUS_BY_CODE[code] ?? 500).send(buildErrorEnvelope(code, message, details, requestId));
}

export function zodIssuesToDetails(error: ZodError): HttpErrorDetail[] {
  return error.issues.map((issue) => ({
    path: collapseIssuePath(issue.path),
    issue: issue.message
  }));
}

function collapseIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "(root)";
  const segments: string[] = [];
  for (const segment of path) {
    if (typeof segment !== "string") break;
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join(".") : String(path[0]);
}

export function registerErrorEnvelope(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof HttpProblem) {
      return sendHttpError(reply, error.code, error.message, error.details);
    }
    if (error instanceof ZodError) {
      const details = zodIssuesToDetails(error);
      const code: HttpErrorCode = request.method === "GET" ? "invalid_query" : "invalid_input";
      return sendHttpError(reply, code, "Validation failed", details);
    }
    const message = error instanceof Error ? error.message : String(error);
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === "number") {
      if (status === 400) {
        return sendHttpError(
          reply,
          request.method === "GET" ? "invalid_query" : "invalid_input",
          message || "Bad request"
        );
      }
      if (status === 404) {
        return reply
          .code(404)
          .send(buildErrorEnvelope("internal_error", message || "Not found"));
      }
    }
    request.log?.error?.({ err: error }, "unhandled_error");
    return sendHttpError(reply, "internal_error", "Internal server error");
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.id) {
      reply.header("x-request-id", request.id);
    }
    return reply
      .code(404)
      .send(
        buildErrorEnvelope(
          "internal_error",
          `Route ${request.method} ${request.url} not found`,
          undefined,
          request.id
        )
      );
  });
}
