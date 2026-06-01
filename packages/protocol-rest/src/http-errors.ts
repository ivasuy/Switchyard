import type { FastifyInstance, FastifyReply } from "fastify";
import { ZodError } from "zod";

export type HttpErrorCode =
  | "run_not_found"
  | "debate_not_found"
  | "artifact_not_found"
  | "missing_artifact_content"
  | "provider_not_found"
  | "runtime_not_found"
  | "runtime_mode_not_found"
  | "model_not_found"
  | "message_not_found"
  | "memory_not_found"
  | "evidence_not_found"
  | "approval_not_found"
  | "tool_invocation_not_found"
  | "approval_not_pending"
  | "tool_run_required"
  | "tool_target_invalid"
  | "tool_target_mismatch"
  | "tool_hosted_auth_required"
  | "tool_store_unavailable"
  | "tool_dispatch_unavailable"
  | "tool_dispatch_failed"
  | "tool_dispatch_retry_exhausted"
  | "tool_policy_denied"
  | "tool_policy_config_invalid"
  | "tool_policy_failed"
  | "tool_real_tools_disabled"
  | "tool_hosted_tools_disabled"
  | "tool_connected_node_tools_disabled"
  | "tool_approval_required"
  | "tool_approval_rejected"
  | "tool_approval_expired"
  | "tool_adapter_unavailable"
  | "tool_input_limit_exceeded"
  | "tool_concurrency_limit_exceeded"
  | "tool_output_limit_exceeded"
  | "tool_artifact_write_failed"
  | "tool_redaction_failed"
  | "tool_worker_restarted"
  | "tool_node_unavailable"
  | "tool_node_execution_failed"
  | "tool_assignment_expired"
  | "tool_assignment_mismatch"
  | "hosted_runtime_approval_bridge_unshipped"
  | "approval_scope_denied"
  | "repo_hosted_unshipped"
  | "browser_tool_unshipped"
  | "fetch_url_invalid"
  | "fetch_host_not_allowlisted"
  | "fetch_private_network_denied"
  | "fetch_redirect_denied"
  | "fetch_method_denied"
  | "fetch_content_type_denied"
  | "web_search_provider_unconfigured"
  | "web_search_query_invalid"
  | "github_token_missing"
  | "github_repo_not_allowlisted"
  | "github_operation_denied"
  | "github_not_found"
  | "github_rate_limited"
  | "repo_cwd_denied"
  | "repo_operation_denied"
  | "repo_pathspec_invalid"
  | "shell_command_denied"
  | "shell_command_not_configured"
  | "tool_process_spawn_failed"
  | "tool_process_nonzero_exit"
  | "tool_process_timeout"
  | "tool_process_cancelled"
  | "approval_required"
  | "unsupported_tool"
  | "invalid_input"
  | "invalid_query"
  | "adapter_protocol_failed"
  | "placement_denied"
  | "node_auth_required"
  | "node_auth_failed"
  | "node_not_found"
  | "assignment_not_found"
  | "assignment_claim_conflict"
  | "node_policy_denied"
  | "queue_unavailable"
  | "event_sync_gap"
  | "event_sync_conflict"
  | "object_store_unavailable"
  | "object_store_timeout"
  | "object_store_auth_failed"
  | "object_store_bucket_not_found"
  | "object_store_read_failed"
  | "artifact_digest_mismatch"
  | "artifact_content_empty"
  | "artifact_sync_failed"
  | "hosted_runtime_not_allowed"
  | "payload_too_large"
  | "auth_required"
  | "auth_failed"
  | "auth_conflict"
  | "auth_store_unavailable"
  | "tenant_access_denied"
  | "project_access_denied"
  | "entitlement_denied"
  | "quota_exceeded"
  | "audit_log_unavailable"
  | "internal_error";

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

const STATUS_BY_CODE: Record<HttpErrorCode, number> = {
  run_not_found: 404,
  debate_not_found: 404,
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
    this.status = STATUS_BY_CODE[code];
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
  return reply.code(STATUS_BY_CODE[code]).send(buildErrorEnvelope(code, message, details, requestId));
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
