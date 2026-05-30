import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  ArtifactStore,
  EventBus,
  EventStore,
  RegistryService,
  RegistryStore,
  ContextBuilder,
  HostedRunService,
  RunLauncherService,
  RunService,
  RunStore
} from "@switchyard/core";
import { AdapterProtocolError, isRealHostedRuntimeMode } from "@switchyard/core";
import {
  adapterTypeSchema,
  decodeCursor,
  encodeCursor,
  LIST_LIMIT_DEFAULT,
  listRunsQuerySchema,
  type ListRunsQuery,
  type SwitchyardEvent
} from "@switchyard/contracts";
import {
  collectReplayAndLiveEvents,
  formatSseEvent,
  streamRunEvents
} from "@switchyard/protocol-sse";
import { ZodError } from "zod";
import { HttpProblem, sendHttpError, zodIssuesToDetails } from "./http-errors.js";
import { resolveProviderIds } from "./registry-helpers.js";

export interface RunRouteDependencies {
  runService: RunService;
  hostedRuns?: HostedRunService;
  runs: RunStore;
  events: EventStore;
  contextBuilder?: ContextBuilder;
  artifacts?: ArtifactStore;
  eventBus?: EventBus;
  launcher?: RunLauncherService;
  registry?: RegistryStore;
  registryService?: RegistryService;
}

export function registerRunRoutes(app: FastifyInstance, deps: RunRouteDependencies): void {
  app.post("/runs", async (request, reply) => {
    try {
      const wait = shouldWaitForCompletion(request.query);
      const body = parseCreateRunBody(request.body);
      const renderedContext = body.context
        ? await buildRunContext(body, deps.contextBuilder)
        : undefined;
      const runtimeMode = await inferRuntimeMode(body, deps.registryService);
      const metadata = body.metadata ?? {};
      const createInput: Parameters<RunService["createRun"]>[0] = {
        runtime: body.runtime,
        provider: body.provider,
        model: body.model,
        adapterType: body.adapterType,
        cwd: body.cwd,
        task: renderedContext ? renderRunTask(body.task, renderedContext.rendered) : body.task,
        placement: body.placement ?? "local",
        approvalPolicy: body.approvalPolicy ?? "default",
        timeoutSeconds: body.timeoutSeconds ?? 600,
        metadata: renderedContext
          ? {
            ...metadata,
            originalTask: body.task,
            contextPacket: renderedContext.context
          }
          : metadata
      };
      if (runtimeMode !== undefined) {
        createInput.runtimeMode = runtimeMode;
      }
      let placementFacts;
      if (runtimeMode && deps.registry) {
        const mode = await deps.registry.getRuntimeMode(runtimeMode);
        placementFacts = mode?.placement;
      }

      const runResult = deps.hostedRuns && placementFacts
        ? await deps.hostedRuns.createRun({
          ...createInput,
          placementFacts
        }, { wait })
        : { run: await deps.runService.createRun(createInput) };

      const run = runResult.run;
      if (wait) {
        if (runResult.response) {
          return reply.code(201).send({ run: runResult.run, response: runResult.response });
        }
        const completed = await deps.runService.startRun(run.id);
        const events = await deps.events.listByRun(run.id);
        return reply.code(201).send({ run: completed, response: collectRunResponse(events) });
      }
      if (!deps.hostedRuns && deps.launcher) {
        deps.launcher.launch(run);
      } else if (!deps.hostedRuns) {
        queueMicrotask(() => {
          void deps.runService.startRun(run.id).catch(() => {});
        });
      }
      return reply.code(202).send({ run });
    } catch (error) {
      if (isHostedRunServiceError(error)) {
        if (error.code === "queue_unavailable") {
          return sendHttpError(reply, "queue_unavailable", error.message);
        }
        return sendHttpError(reply, "placement_denied", error.message, placementDeniedDetails(error.message));
      }
      if (error instanceof HttpProblem) {
        return sendHttpError(reply, error.code, error.message, error.details);
      }
      throw error;
    }
  });

  app.get("/runs", async (request, reply) => {
    const query = parseListRunsQuery(request.query);
    let providerSlugFilter: readonly string[] | undefined;
    let runtimeSlugFilter: readonly string[] | undefined;
    let modelSlugFilter: readonly string[] | undefined;
    // Slugs in the run table are stored as-is (the request payload uses slugs,
    // not registry ids), so we pass them through directly.
    providerSlugFilter = query.provider;
    runtimeSlugFilter = query.runtime;
    modelSlugFilter = query.model;

    const limit = query.limit ?? LIST_LIMIT_DEFAULT;
    const filter: Parameters<RunStore["list"]>[0] = {
      limit
    };
    if (query.status) filter.status = query.status;
    if (runtimeSlugFilter) filter.runtime = runtimeSlugFilter;
    if (providerSlugFilter) filter.provider = providerSlugFilter;
    if (modelSlugFilter) filter.model = modelSlugFilter;
    if (query.placement) filter.placement = query.placement;
    if (query.adapterType) filter.adapterType = query.adapterType;
    if (query.since) filter.since = query.since;
    if (query.until) filter.until = query.until;
    if (query.before) {
      filter.before = decodeRunCursor(query.before);
    }

    const result = await deps.runs.list(filter);
    return reply.send({
      runs: result.runs,
      nextCursor: result.nextCursor ? encodeRunCursor(result.nextCursor) : null
    });
  });

  app.get("/runs/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const run = await deps.runs.get(id);
    if (!run) {
      return sendHttpError(reply, "run_not_found", `Run not found: ${id}`);
    }

    const events = await deps.events.listByRun(id);
    return { run, events };
  });

  app.get("/runs/:id/events", async (request, reply) => {
    await handleRunEventsRequest(request, reply, deps);
  });

  app.get("/runs/:id/artifacts", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const run = await deps.runs.get(id);
    if (!run) {
      return sendHttpError(reply, "run_not_found", `Run not found: ${id}`);
    }
    if (!deps.artifacts) {
      return { artifacts: [] };
    }
    return { artifacts: await deps.artifacts.listByRun(id) };
  });

  app.post("/runs/:id/input", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const run = await deps.runs.get(id);
    if (!run) {
      return sendHttpError(reply, "run_not_found", `Run not found: ${id}`);
    }

    if (isHostedRealRun(run)) {
      if (isTerminalStatus(run.status)) {
        return sendHttpError(reply, "adapter_protocol_failed", "Run is not active", [
          { path: "reasonCode", issue: "runtime_input_not_active" }
        ]);
      }
      return sendHttpError(reply, "adapter_protocol_failed", "Hosted input bridge is not supported", [
        { path: "reasonCode", issue: "hosted_input_unsupported" }
      ]);
    }

    try {
      await deps.runService.sendInput(id, parseInputBody(request.body));
    } catch (error) {
      if (error instanceof AdapterProtocolError) {
        return sendHttpError(
          reply,
          "adapter_protocol_failed",
          error.message,
          adapterProtocolDetails(error)
        );
      }
      throw error;
    }
    return reply.code(202).send({ accepted: true });
  });

  app.post("/runs/:id/cancel", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const run = await deps.runs.get(id);
    if (!run) {
      return sendHttpError(reply, "run_not_found", `Run not found: ${id}`);
    }

    if (isHostedRealRun(run)) {
      if (run.status === "queued") {
        const cancelled = await deps.runService.cancelRun(id);
        return reply.send({ run: cancelled });
      }
      if (!isTerminalStatus(run.status)) {
        return sendHttpError(reply, "adapter_protocol_failed", "Hosted cancellation bridge is not supported", [
          { path: "reasonCode", issue: "hosted_cancel_unsupported" }
        ]);
      }
      return reply.send({ run });
    }

    try {
      const cancelled = await deps.runService.cancelRun(id);
      return reply.send({ run: cancelled });
    } catch (error) {
      if (error instanceof AdapterProtocolError) {
        return sendHttpError(reply, "adapter_protocol_failed", error.message, adapterProtocolDetails(error));
      }
      throw error;
    }
  });
}

async function handleRunEventsRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: RunRouteDependencies
): Promise<void> {
  const id = (request.params as { id: string }).id;
  const run = await deps.runs.get(id);
  if (!run) {
    sendHttpError(reply, "run_not_found", `Run not found: ${id}`);
    return;
  }

  const events = await deps.events.listByRun(id);
  const query = request.query as Record<string, unknown>;
  const live = query["live"] === "1";
  const rawStopAfter = typeof query["stopAfter"] === "string"
    ? Number(query["stopAfter"])
    : undefined;
  const stopAfter = normalizeStopAfterParam(rawStopAfter);
  const lastEventId = readLastEventId(request);

  reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  reply.raw.setHeader("Cache-Control", "no-cache");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("X-Accel-Buffering", "no");

  // Detached SSE response: take over the raw response from Fastify so we can
  // keep the connection open and stream events as they arrive.
  reply.hijack();

  if (!live) {
    // Replay-only mode: emit replay then end.
    const replay = trimByLastEventId(events, lastEventId);
    const limit = stopAfter ?? replay.length;
    const slice = replay.slice(0, Math.min(replay.length, limit));
    for (const event of slice) {
      reply.raw.write(formatSseEvent(event));
    }
    reply.raw.end();
    return;
  }

  // Live mode (with optional stopAfter for tests).
  // Use the bounded collector when stopAfter is supplied AND no event bus is
  // available, so tests that don't provide a bus still terminate. Otherwise we
  // rely on the open-ended streamer.
  if (!deps.eventBus && stopAfter !== undefined) {
    const body = await collectReplayAndLiveEvents({
      runId: id,
      replay: trimByLastEventId(events, lastEventId),
      eventBus: noopEventBus(),
      stopAfter
    });
    reply.raw.write(body);
    reply.raw.end();
    return;
  }

  if (!deps.eventBus) {
    // Live requested without a bus: degrade to replay-only.
    const replay = trimByLastEventId(events, lastEventId);
    for (const event of replay) {
      reply.raw.write(formatSseEvent(event));
    }
    reply.raw.end();
    return;
  }

  const streamInput: Parameters<typeof streamRunEvents>[0] = {
    runId: id,
    replay: events,
    destination: reply.raw,
    live: true,
    eventBus: deps.eventBus
  };
  if (stopAfter !== undefined) streamInput.stopAfter = stopAfter;
  if (lastEventId !== undefined) streamInput.lastEventId = lastEventId;
  const handle = streamRunEvents(streamInput);
  await handle.finished;
}

function noopEventBus(): EventBus {
  return {
    subscribe: () => () => {},
    publish: async () => {}
  } as unknown as EventBus;
}

function trimByLastEventId(
  events: SwitchyardEvent[],
  lastEventId: string | undefined
): SwitchyardEvent[] {
  if (!lastEventId) return events;
  const idx = events.findIndex((event) => event.id === lastEventId);
  if (idx < 0) return events;
  return events.slice(idx + 1);
}

function readLastEventId(request: FastifyRequest): string | undefined {
  const fromHeader = request.headers["last-event-id"];
  if (typeof fromHeader === "string" && fromHeader.length > 0) {
    return fromHeader;
  }
  if (Array.isArray(fromHeader) && fromHeader.length > 0 && fromHeader[0]) {
    return fromHeader[0];
  }
  const query = request.query as Record<string, unknown> | undefined;
  const fromQuery = query?.["lastEventId"];
  if (typeof fromQuery === "string" && fromQuery.length > 0) {
    return fromQuery;
  }
  return undefined;
}

function encodeRunCursor(cursor: { createdAt: string; id: string }): string {
  return encodeCursor({ createdAt: cursor.createdAt, id: cursor.id });
}

function decodeRunCursor(cursor: string): { createdAt: string; id: string } {
  try {
    return decodeCursor(cursor, ["createdAt", "id"] as const);
  } catch {
    throw new HttpProblem("invalid_query", "Malformed cursor", [
      { path: "before", issue: "must be an opaque cursor from a previous response" }
    ]);
  }
}

function parseListRunsQuery(query: unknown): ListRunsQuery {
  let parsed: ListRunsQuery;
  try {
    parsed = listRunsQuerySchema.parse(query ?? {});
  } catch (error) {
    if (error instanceof ZodError) {
      throw new HttpProblem("invalid_query", "Invalid query parameters", zodIssuesToDetails(error));
    }
    throw error;
  }
  if (parsed.since && parsed.until && parsed.since > parsed.until) {
    throw new HttpProblem("invalid_query", "since must be <= until", [
      { path: "since", issue: "must be <= until" }
    ]);
  }
  return parsed;
}

function normalizeStopAfterParam(stopAfter: number | undefined): number | undefined {
  if (stopAfter === undefined || !Number.isFinite(stopAfter) || stopAfter <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(stopAfter));
}

interface RunOutput {
  sequence: number;
  text: string;
}

interface RunResponseSummary {
  text: string | null;
  outputs: RunOutput[];
}

function collectRunResponse(events: SwitchyardEvent[]): RunResponseSummary {
  const outputs = events.flatMap((event): RunOutput[] => {
    if (event.type !== "runtime.output") {
      return [];
    }
    const text = event.payload["text"];
    return typeof text === "string" && text.length > 0
      ? [{ sequence: event.sequence, text }]
      : [];
  });
  return {
    text: outputs.at(-1)?.text ?? null,
    outputs
  };
}

interface CreateRunBody {
  runtime: string;
  provider: string;
  model: string;
  adapterType: "native" | "acpx" | "http" | "webhook" | "process" | "pty" | "browser";
  cwd: string;
  task: string;
  placement?: "local" | "hosted" | "connected_local_node" | undefined;
  approvalPolicy?: string | undefined;
  timeoutSeconds?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
  runtimeMode?: string | undefined;
  context?: {
    sections?: Array<{ name: string; content: string }>;
    memoryIds?: string[];
    evidenceIds?: string[];
    messageIds?: string[];
  } | undefined;
}

function parseCreateRunBody(value: unknown): CreateRunBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpProblem("invalid_input", "Request body must be an object");
  }
  const body = value as Record<string, unknown>;
  const adapterTypeRaw = body["adapterType"];
  let adapterType: CreateRunBody["adapterType"];
  try {
    adapterType = adapterTypeSchema.parse(adapterTypeRaw);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new HttpProblem("invalid_input", "Invalid adapterType", [
        { path: "adapterType", issue: error.issues[0]?.message ?? "invalid value" }
      ]);
    }
    throw error;
  }
  return {
    runtime: requiredString(body, "runtime"),
    provider: requiredString(body, "provider"),
    model: requiredString(body, "model"),
    adapterType,
    cwd: requiredString(body, "cwd"),
    task: requiredString(body, "task"),
    placement: parsePlacement(body["placement"]),
    approvalPolicy: typeof body["approvalPolicy"] === "string" ? body["approvalPolicy"] : undefined,
    timeoutSeconds: typeof body["timeoutSeconds"] === "number" ? body["timeoutSeconds"] : undefined,
    metadata: isRecord(body["metadata"]) ? body["metadata"] : undefined,
    runtimeMode: typeof body["runtimeMode"] === "string" ? body["runtimeMode"] : undefined,
    context: parseRunContext(body["context"])
  };
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpProblem("invalid_input", `${key} is required`, [
      { path: key, issue: "must be a non-empty string" }
    ]);
  }
  return value;
}

function parsePlacement(value: unknown): CreateRunBody["placement"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpProblem("invalid_input", "placement must be a non-empty string", [
      { path: "placement", issue: "must be local, hosted, or connected_local_node" }
    ]);
  }
  return value as CreateRunBody["placement"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseInputBody(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new HttpProblem("invalid_input", "Input body must be an object", [
      { path: "body", issue: "must be an object" }
    ]);
  }
  const text = value["text"];
  if (typeof text !== "string") {
    throw new HttpProblem("invalid_input", "text is required", [
      { path: "text", issue: "must be a non-empty string" }
    ]);
  }
  if (text.trim().length === 0) {
    throw new HttpProblem("invalid_input", "text is required", [
      { path: "text", issue: "must be a non-empty string" }
    ]);
  }
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) {
    throw new HttpProblem("invalid_input", "text is too large", [
      { path: "text", issue: "must be <= 65536 bytes" }
    ]);
  }
  return { text };
}

function parseRunContext(value: unknown): CreateRunBody["context"] {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new HttpProblem("invalid_input", "context must be an object");
  }
  const sectionsRaw = value["sections"];
  const memoryIdsRaw = value["memoryIds"];
  const evidenceIdsRaw = value["evidenceIds"];
  const messageIdsRaw = value["messageIds"];

  const sections = parseContextSections(sectionsRaw);
  const memoryIds = parseContextIdList(memoryIdsRaw, "memoryIds");
  const evidenceIds = parseContextIdList(evidenceIdsRaw, "evidenceIds");
  const messageIds = parseContextIdList(messageIdsRaw, "messageIds");

  return {
    sections,
    memoryIds,
    evidenceIds,
    messageIds
  };
}

function parseContextSections(value: unknown): Array<{ name: string; content: string }> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new HttpProblem("invalid_input", "context.sections must be an array", [
      { path: "context.sections", issue: "must be an array" }
    ]);
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new HttpProblem("invalid_input", "context.sections entries must be objects", [
        { path: `context.sections.${index}`, issue: "must be an object" }
      ]);
    }
    const section = entry as Record<string, unknown>;
    const name = section["name"];
    const content = section["content"];
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new HttpProblem("invalid_input", "context section name must be a non-empty string", [
        { path: `context.sections.${index}.name`, issue: "must be a non-empty string" }
      ]);
    }
    if (typeof content !== "string") {
      throw new HttpProblem("invalid_input", "context section content must be a string", [
        { path: `context.sections.${index}.content`, issue: "must be a string" }
      ]);
    }
    return { name, content };
  });
}

function parseContextIdList(value: unknown, path: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new HttpProblem("invalid_input", `${path} must be a string array`, [
      { path: `context.${path}`, issue: "must be an array of strings" }
    ]);
  }
  return value;
}

function shouldWaitForCompletion(query: unknown): boolean {
  if (!query || typeof query !== "object") {
    return false;
  }
  const wait = (query as Record<string, unknown>)["wait"];
  if (typeof wait === "string") {
    return wait === "1";
  }
  if (Array.isArray(wait)) {
    return wait.some((value) => value === "1");
  }
  return false;
}

async function buildRunContext(
  body: CreateRunBody,
  contextBuilder: ContextBuilder | undefined
): Promise<{ context: Record<string, unknown>; rendered: string }> {
  if (!body.context) {
    throw new HttpProblem("internal_error", "context is required");
  }
  if (body.metadata && ("originalTask" in body.metadata || "contextPacket" in body.metadata)) {
    throw new HttpProblem("invalid_input", "metadata contains reserved keys", [
      { path: "metadata", issue: "originalTask/contextPacket are reserved when context is provided" }
    ]);
  }
  if (!contextBuilder) {
    throw new HttpProblem("internal_error", "context builder is not configured");
  }
  try {
    const built = await contextBuilder.build({
      target: "run",
      sections: body.context.sections ?? [],
      memoryIds: body.context.memoryIds ?? [],
      evidenceIds: body.context.evidenceIds ?? [],
      messageIds: body.context.messageIds ?? []
    });
    return built;
  } catch (error) {
    if (!error || typeof error !== "object") {
      throw error;
    }
    const err = error as { code?: string; message?: string; details?: Array<{ path: string; issue: string }> };
    if (typeof err.code === "string" && typeof err.message === "string") {
      if (err.code === "memory_not_found" || err.code === "evidence_not_found" || err.code === "message_not_found") {
        throw new HttpProblem(err.code, err.message, err.details);
      }
      if (err.code === "invalid_input" || err.code === "invalid_query") {
        throw new HttpProblem(err.code, err.message, err.details);
      }
    }
    throw error;
  }
}

function renderRunTask(task: string, renderedContext: string): string {
  if (renderedContext.length === 0) {
    return task;
  }
  return `${task}\n\n${renderedContext}`;
}

async function inferRuntimeMode(
  body: CreateRunBody,
  registryService: RegistryService | undefined
): Promise<string | undefined> {
  if (!registryService) {
    return undefined;
  }
  try {
    const input: Parameters<RegistryService["inferAndValidateRuntimeMode"]>[0] = {
      runtime: body.runtime,
      provider: body.provider,
      adapterType: body.adapterType
    };
    if (body.runtimeMode !== undefined) {
      input.runtimeMode = body.runtimeMode;
    }
    return await registryService.inferAndValidateRuntimeMode(input);
  } catch (error) {
    if (isValidationError(error)) {
      throw new HttpProblem("invalid_input", error.message, error.details);
    }
    throw error;
  }
}

function isValidationError(error: unknown): error is { code: string; message: string; details: Array<{ path: string; issue: string }> } {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as Record<string, unknown>;
  return record["code"] === "invalid_input" && Array.isArray(record["details"]) && typeof record["message"] === "string";
}

function adapterProtocolDetails(error: AdapterProtocolError): Array<{ path: string; issue: string }> | undefined {
  if (!error.reasonCode) {
    return undefined;
  }
  return [{ path: "reasonCode", issue: error.reasonCode }];
}

function isHostedRunServiceError(error: unknown): error is { code: "placement_denied" | "queue_unavailable" | "hosted_runtime_not_allowed"; message: string } {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "placement_denied" || code === "queue_unavailable" || code === "hosted_runtime_not_allowed";
}

function placementDeniedDetails(message: string): Array<{ path: string; issue: string }> | undefined {
  const known = new Set([
    "hosted_wait_unsupported",
    "hosted_explicit_placement_required",
    "hosted_real_runtime_disabled",
    "hosted_real_runtime_production_forbidden",
    "hosted_runtime_not_allowed"
  ]);
  if (!known.has(message)) {
    return undefined;
  }
  return [{ path: "placement", issue: message }];
}

function isHostedRealRun(run: { placement: string; runtimeMode?: string | undefined }): boolean {
  return run.placement === "hosted" && isRealHostedRuntimeMode(run.runtimeMode);
}

function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "timeout";
}
