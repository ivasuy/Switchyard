import type { FastifyInstance, FastifyReply } from "fastify";
import {
  createToolInvocationRequestSchema,
  decodeCursor,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  memoryScopeSchema,
  evidenceReliabilitySchema,
  evidenceSourceTypeSchema,
  deliveryStatusSchema,
  approvalStatusSchema,
  approvalTypeSchema,
  toolInvocationStatusSchema,
  toolTypeSchema
} from "@switchyard/contracts";
import type {
  AdapterProtocolError,
  ApprovalService,
  ContextBuilder,
  EvidenceService,
  MemoryService,
  MessageRouter,
  ToolRouter
} from "@switchyard/core";
import { HttpProblem, sendHttpError } from "./http-errors.js";

interface MiddlewareRouteDependencies {
  messageRouter: MessageRouter;
  memoryService: MemoryService;
  evidenceService: EvidenceService;
  contextBuilder: ContextBuilder;
  approvalService: ApprovalService;
  toolRouter: ToolRouter;
}

export function registerMiddlewareRoutes(app: FastifyInstance, deps: MiddlewareRouteDependencies): void {
  app.post("/messages", async (request, reply) => {
    const body = ensureRecord(request.body, "Request body must be an object");
    const content = requiredString(body, "content").trim();
    const fromRunId = optionalString(body, "fromRunId");
    const toRunId = optionalString(body, "toRunId");
    const channel = optionalString(body, "channel");
    const attachmentsRaw = body["attachments"];
    const attachments = Array.isArray(attachmentsRaw)
      ? attachmentsRaw.filter((entry) => entry && typeof entry === "object").map((entry) => entry as Record<string, unknown>)
      : [];

    try {
      const message = await deps.messageRouter.create({ fromRunId, toRunId, channel, content, attachments });
      return reply.code(201).send({ message });
    } catch (error) {
      return sendFromServiceError(reply, error);
    }
  });

  app.get("/messages", async (request, reply) => {
    const query = ensureRecord(request.query, "Invalid query parameters");
    const filter = {
      runId: optionalString(query, "runId"),
      channel: optionalString(query, "channel"),
      deliveryStatus: parseOptionalQueryEnum(query["deliveryStatus"], deliveryStatusSchema, "deliveryStatus"),
      limit: parseLimit(query["limit"]),
      before: parseCursor(query["before"])
    };

    const result = await deps.messageRouter.list(filter);
    return reply.send({
      messages: result.messages,
      nextCursor: result.nextCursor ? encodeListCursor(result.nextCursor) : null
    });
  });

  app.get("/messages/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const message = await deps.messageRouter.get(id);
    if (!message) {
      return sendHttpError(reply, "message_not_found", `Message not found: ${id}`);
    }
    return reply.send({ message });
  });

  app.post("/memory", async (request, reply) => {
    const body = ensureRecord(request.body, "Request body must be an object");
    if ("embedding" in body) {
      return sendHttpError(reply, "invalid_input", "embedding is not supported in R7", [
        { path: "embedding", issue: "vector memory is not shipped in R7" }
      ]);
    }

    try {
      const memory = await deps.memoryService.create({
        scope: parseRequiredEnum(body["scope"], memoryScopeSchema, "scope"),
        projectId: optionalString(body, "projectId"),
        runId: optionalString(body, "runId"),
        debateId: optionalString(body, "debateId"),
        provider: optionalString(body, "provider"),
        model: optionalString(body, "model"),
        content: requiredString(body, "content"),
        metadata: ensureOptionalRecord(body["metadata"], "metadata")
      });
      return reply.code(201).send({ memory });
    } catch (error) {
      return sendFromServiceError(reply, error);
    }
  });

  app.get("/memory/search", async (request, reply) => {
    const query = ensureRecord(request.query, "Invalid query parameters");
    try {
      const result = await deps.memoryService.search({
        q: requiredString(query, "q"),
        scope: parseOptionalQueryEnum(query["scope"], memoryScopeSchema, "scope"),
        projectId: optionalString(query, "projectId"),
        runId: optionalString(query, "runId"),
        debateId: optionalString(query, "debateId"),
        provider: optionalString(query, "provider"),
        model: optionalString(query, "model"),
        limit: parseLimit(query["limit"]),
        before: parseCursor(query["before"])
      });
      return reply.send({
        memory: result.memory,
        nextCursor: result.nextCursor ? encodeListCursor(result.nextCursor) : null
      });
    } catch (error) {
      return sendFromServiceError(reply, error);
    }
  });

  app.get("/memory", async (request, reply) => {
    const query = ensureRecord(request.query, "Invalid query parameters");
    const result = await deps.memoryService.list({
      scope: parseOptionalQueryEnum(query["scope"], memoryScopeSchema, "scope"),
      projectId: optionalString(query, "projectId"),
      runId: optionalString(query, "runId"),
      debateId: optionalString(query, "debateId"),
      provider: optionalString(query, "provider"),
      model: optionalString(query, "model"),
      limit: parseLimit(query["limit"]),
      before: parseCursor(query["before"])
    });
    return reply.send({
      memory: result.memory,
      nextCursor: result.nextCursor ? encodeListCursor(result.nextCursor) : null
    });
  });

  app.get("/memory/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const memory = await deps.memoryService.get(id);
    if (!memory) {
      return sendHttpError(reply, "memory_not_found", `Memory not found: ${id}`);
    }
    return reply.send({ memory });
  });

  app.post("/evidence", async (request, reply) => {
    const body = ensureRecord(request.body, "Request body must be an object");
    try {
      const evidence = await deps.evidenceService.create({
        debateId: optionalString(body, "debateId"),
        sourceType: parseRequiredEnum(body["sourceType"], evidenceSourceTypeSchema, "sourceType"),
        url: optionalString(body, "url"),
        title: requiredString(body, "title"),
        snippet: optionalString(body, "snippet"),
        fetchedContentPath: optionalString(body, "fetchedContentPath"),
        reliability: parseRequiredEnum(body["reliability"], evidenceReliabilitySchema, "reliability")
      });
      return reply.code(201).send({ evidence });
    } catch (error) {
      return sendFromServiceError(reply, error);
    }
  });

  app.get("/evidence", async (request, reply) => {
    const query = ensureRecord(request.query, "Invalid query parameters");
    const result = await deps.evidenceService.list({
      debateId: optionalString(query, "debateId"),
      sourceType: parseOptionalQueryEnum(query["sourceType"], evidenceSourceTypeSchema, "sourceType"),
      reliability: parseOptionalQueryEnum(query["reliability"], evidenceReliabilitySchema, "reliability"),
      q: optionalString(query, "q"),
      limit: parseLimit(query["limit"]),
      before: parseCursor(query["before"])
    });
    return reply.send({
      evidence: result.evidence,
      nextCursor: result.nextCursor ? encodeListCursor(result.nextCursor) : null
    });
  });

  app.get("/evidence/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const evidence = await deps.evidenceService.get(id);
    if (!evidence) {
      return sendHttpError(reply, "evidence_not_found", `Evidence not found: ${id}`);
    }
    return reply.send({ evidence });
  });

  app.post("/context", async (request, reply) => {
    const body = ensureRecord(request.body, "Request body must be an object");
    const target = requiredString(body, "target");
    if (!["run", "debate", "participant", "tool"].includes(target)) {
      return sendHttpError(reply, "invalid_input", "target is invalid", [{ path: "target", issue: "invalid target" }]);
    }
    const sections = parseSections(body["sections"]);
    const memoryIds = parseStringArray(body["memoryIds"]);
    const evidenceIds = parseStringArray(body["evidenceIds"]);
    const messageIds = parseStringArray(body["messageIds"]);

    try {
      const result = await deps.contextBuilder.build({
        target: target as "run" | "debate" | "participant" | "tool",
        sections,
        memoryIds,
        evidenceIds,
        messageIds
      });
      return reply.send(result);
    } catch (error) {
      return sendFromServiceError(reply, error);
    }
  });

  app.post("/approvals", async (request, reply) => {
    const body = ensureRecord(request.body, "Request body must be an object");
    const payload = ensureOptionalRecord(body["payload"], "payload") ?? {};
    try {
      const approval = await deps.approvalService.create({
        runId: optionalString(body, "runId"),
        approvalType: parseRequiredEnum(body["approvalType"], approvalTypeSchema, "approvalType"),
        payload
      });
      return reply.code(201).send({ approval });
    } catch (error) {
      return sendFromServiceError(reply, error);
    }
  });

  app.get("/approvals", async (request, reply) => {
    const query = ensureRecord(request.query, "Invalid query parameters");
    const result = await deps.approvalService.list({
      runId: optionalString(query, "runId"),
      status: parseOptionalQueryEnum(query["status"], approvalStatusSchema, "status"),
      approvalType: parseOptionalQueryEnum(query["approvalType"], approvalTypeSchema, "approvalType"),
      limit: parseLimit(query["limit"]),
      before: parseCursor(query["before"])
    });
    return reply.send({
      approvals: result.approvals,
      nextCursor: result.nextCursor ? encodeListCursor(result.nextCursor) : null
    });
  });

  app.get("/approvals/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const approval = await deps.approvalService.get(id);
    if (!approval) {
      return sendHttpError(reply, "approval_not_found", `Approval not found: ${id}`);
    }
    return reply.send({ approval });
  });

  app.post("/approvals/:id/approve", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const body = ensureRecord(request.body, "Request body must be an object");
    try {
      const result = await deps.approvalService.approve(id, {
        actor: optionalString(body, "actor"),
        reason: optionalString(body, "reason"),
        answers: parseOptionalAnswers(body["answers"])
      });
      return reply.send(result);
    } catch (error) {
      return sendFromServiceError(reply, error);
    }
  });

  app.post("/approvals/:id/reject", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const body = ensureRecord(request.body, "Request body must be an object");
    try {
      const result = await deps.approvalService.reject(id, {
        actor: optionalString(body, "actor"),
        reason: optionalString(body, "reason"),
        answers: parseOptionalAnswers(body["answers"])
      });
      return reply.send(result);
    } catch (error) {
      return sendFromServiceError(reply, error);
    }
  });

  app.post("/tools/invocations", async (request, reply) => {
    const body = ensureRecord(request.body, "Request body must be an object");
    let parsed: ReturnType<typeof createToolInvocationRequestSchema.parse>;
    try {
      parsed = createToolInvocationRequestSchema.parse(body);
    } catch {
      return sendHttpError(reply, "invalid_input", "tool invocation input is invalid", [{ path: "input", issue: "invalid tool input" }]);
    }
    try {
      const result = await deps.toolRouter.invoke({
        runId: parsed.runId,
        type: parsed.type,
        input: parsed.input,
        approvalPolicy: parsed.approvalPolicy
      });
      if (result.statusCode === 202) {
        return reply.code(202).send({
          invocation: result.invocation,
          approval: result.approval
        });
      }
      return reply.code(201).send({ invocation: result.invocation });
    } catch (error) {
      return sendFromServiceError(reply, error);
    }
  });

  app.get("/tools/invocations", async (request, reply) => {
    const query = ensureRecord(request.query, "Invalid query parameters");
    const result = await deps.toolRouter.list({
      runId: optionalString(query, "runId"),
      type: parseOptionalQueryEnum(query["type"], toolTypeSchema, "type"),
      status: parseOptionalQueryEnum(query["status"], toolInvocationStatusSchema, "status"),
      approvalId: optionalString(query, "approvalId"),
      limit: parseLimit(query["limit"]),
      before: parseCursor(query["before"])
    });
    return reply.send({
      invocations: result.invocations,
      nextCursor: result.nextCursor ? encodeListCursor(result.nextCursor) : null
    });
  });

  app.get("/tools/invocations/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const invocation = await deps.toolRouter.get(id);
    if (!invocation) {
      return sendHttpError(reply, "tool_invocation_not_found", `Tool invocation not found: ${id}`);
    }
    return reply.send({ invocation });
  });
}

function ensureRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpProblem("invalid_input", message);
  }
  return value as Record<string, unknown>;
}

function ensureOptionalRecord(value: unknown, path: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpProblem("invalid_input", `${path} must be an object`, [{ path, issue: "must be an object" }]);
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpProblem("invalid_input", `${key} is required`, [{ path: key, issue: "must be a non-empty string" }]);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new HttpProblem("invalid_input", `${key} must be a string`, [{ path: key, issue: "must be a string" }]);
  }
  return value;
}

function parseRequiredEnum<T>(value: unknown, schema: { parse: (value: unknown) => T }, path: string): T {
  try {
    return schema.parse(value);
  } catch {
    throw new HttpProblem("invalid_input", `${path} is invalid`, [{ path, issue: "invalid value" }]);
  }
}

function parseOptionalEnum<T>(value: unknown, schema: { parse: (value: unknown) => T }, path: string): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  return parseRequiredEnum(value, schema, path);
}

function parseOptionalQueryEnum<T>(value: unknown, schema: { parse: (value: unknown) => T }, path: string): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return schema.parse(value);
  } catch {
    throw new HttpProblem("invalid_query", `${path} is invalid`, [{ path, issue: "invalid value" }]);
  }
}

function parseLimit(value: unknown): number {
  if (value === undefined) {
    return LIST_LIMIT_DEFAULT;
  }
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0 || parsed > LIST_LIMIT_MAX) {
    throw new HttpProblem("invalid_query", "limit must be between 1 and 200", [{ path: "limit", issue: "must be an integer between 1 and 200" }]);
  }
  return parsed;
}

function parseCursor(value: unknown): { createdAt: string; id: string } | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpProblem("invalid_query", "Malformed cursor", [{ path: "before", issue: "must be an opaque cursor from a previous response" }]);
  }
  try {
    return decodeCursor(value, ["createdAt", "id"] as const);
  } catch {
    throw new HttpProblem("invalid_query", "Malformed cursor", [{ path: "before", issue: "must be an opaque cursor from a previous response" }]);
  }
}

function encodeListCursor(cursor: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(cursor), "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function parseStringArray(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new HttpProblem("invalid_input", "expected string array", [{ path: "array", issue: "must be an array of strings" }]);
  }
  return value;
}

function parseSections(value: unknown): Array<{ name: string; content: string }> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new HttpProblem("invalid_input", "sections must be an array", [{ path: "sections", issue: "must be an array" }]);
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new HttpProblem("invalid_input", "sections must be objects", [{ path: `sections.${index}`, issue: "must be an object" }]);
    }
    const record = entry as Record<string, unknown>;
    const name = record["name"];
    const content = record["content"];
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new HttpProblem("invalid_input", "section name is required", [{ path: `sections.${index}.name`, issue: "must be a non-empty string" }]);
    }
    if (typeof content !== "string") {
      throw new HttpProblem("invalid_input", "section content is required", [{ path: `sections.${index}.content`, issue: "must be a string" }]);
    }
    return { name, content };
  });
}

function parseOptionalAnswers(value: unknown): Record<string, unknown> | undefined {
  return ensureOptionalRecord(value, "answers");
}

function sendFromServiceError(reply: FastifyReply, error: unknown) {
  if (isAdapterProtocolError(error)) {
    return sendHttpError(
      reply,
      "adapter_protocol_failed",
      error.message,
      error.reasonCode ? [{ path: "reasonCode", issue: error.reasonCode }] : undefined
    );
  }
  if (error instanceof HttpProblem) {
    return sendHttpError(reply, error.code, error.message, error.details);
  }
  if (!error || typeof error !== "object") {
    throw error;
  }
  const serviceError = error as { code?: string; message?: string; details?: Array<{ path: string; issue: string }> };
  if (typeof serviceError.code === "string" && typeof serviceError.message === "string") {
    const code = serviceError.code;
    if (
      code === "invalid_input" ||
      code === "invalid_query" ||
      code === "run_not_found" ||
      code === "message_not_found" ||
      code === "memory_not_found" ||
      code === "evidence_not_found" ||
      code === "approval_not_found" ||
      code === "approval_not_pending" ||
      code === "tool_policy_denied" ||
      code === "tool_invocation_not_found" ||
      code === "tool_policy_config_invalid" ||
      code === "tool_policy_failed" ||
      code === "tool_adapter_unavailable"
    ) {
      return sendHttpError(reply, code, serviceError.message, serviceError.details);
    }
  }
  throw error;
}

function isAdapterProtocolError(error: unknown): error is AdapterProtocolError {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { code?: unknown; message?: unknown; reasonCode?: unknown };
  return record.code === "adapter_protocol_failed" && typeof record.message === "string";
}
