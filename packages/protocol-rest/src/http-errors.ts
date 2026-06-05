import type { FastifyInstance, FastifyReply } from "fastify";
import { ZodError } from "zod";
import type { HttpErrorCode, HttpErrorDetail, HttpErrorEnvelope } from "@switchyard/contracts";

const STATUS_BY_CODE: Record<HttpErrorCode, number> = {
  run_not_found: 404,
  artifact_not_found: 404,
  missing_artifact_content: 404,
  provider_not_found: 404,
  runtime_not_found: 404,
  model_not_found: 404,
  invalid_input: 400,
  invalid_query: 400,
  adapter_protocol_failed: 409,
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
  details?: HttpErrorDetail[]
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
  return envelope;
}

export function sendHttpError(
  reply: FastifyReply,
  code: HttpErrorCode,
  message: string,
  details?: HttpErrorDetail[]
): FastifyReply {
  return reply.code(STATUS_BY_CODE[code]).send(buildErrorEnvelope(code, message, details));
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
    return reply
      .code(404)
      .send(buildErrorEnvelope("internal_error", `Route ${request.method} ${request.url} not found`));
  });
}
