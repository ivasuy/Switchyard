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
  | "tool_policy_denied"
  | "tool_policy_config_invalid"
  | "tool_policy_failed"
  | "tool_adapter_unavailable"
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
  tool_policy_denied: 403,
  tool_policy_config_invalid: 403,
  tool_policy_failed: 409,
  tool_adapter_unavailable: 500,
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
