import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DebateService, DebateStore, EventBus, EventStore } from "@switchyard/core";
import type { SwitchyardEvent } from "@switchyard/contracts";
import { collectReplayAndLiveEvents, formatSseEvent, streamEntityEvents } from "@switchyard/protocol-sse";
import { HttpProblem, sendHttpError } from "./http-errors.js";

export interface DebateRouteDependencies {
  debateService: DebateService;
  debates: DebateStore;
  events: EventStore;
  eventBus?: EventBus;
}

export function registerDebateRoutes(app: FastifyInstance, deps: DebateRouteDependencies): void {
  app.post("/debates", async (request, reply) => {
    try {
      const wait = shouldWaitForCompletion(request.query);
      const created = await deps.debateService.create(request.body, { wait });
      if (wait) {
        return reply.code(201).send(created);
      }
      queueMicrotask(() => {
        void deps.debateService.execute(created.debate.id).catch(() => {});
      });
      return reply.code(202).send({ debate: created.debate });
    } catch (error) {
      return sendFromServiceError(reply, error);
    }
  });

  app.get("/debates/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    try {
      return await deps.debateService.inspect(id);
    } catch (error) {
      return sendFromServiceError(reply, error);
    }
  });

  app.get("/debates/:id/events", async (request, reply) => {
    await handleDebateEventsRequest(request, reply, deps);
  });
}

async function handleDebateEventsRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: DebateRouteDependencies
): Promise<void> {
  const debateId = (request.params as { id: string }).id;
  const debate = await deps.debates.get(debateId);
  if (!debate) {
    sendHttpError(reply, "debate_not_found", `Debate not found: ${debateId}`);
    return;
  }

  const events = await deps.events.listByDebate(debateId);
  const query = request.query as Record<string, unknown>;
  const live = query["live"] === "1";
  const rawStopAfter = typeof query["stopAfter"] === "string" ? Number(query["stopAfter"]) : undefined;
  const stopAfter = normalizeStopAfterParam(rawStopAfter);
  const lastEventId = readLastEventId(request);

  reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  reply.raw.setHeader("Cache-Control", "no-cache");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("X-Accel-Buffering", "no");
  reply.hijack();

  if (!live) {
    const replay = trimByLastEventId(events, lastEventId);
    const limit = stopAfter ?? replay.length;
    for (const event of replay.slice(0, Math.min(limit, replay.length))) {
      reply.raw.write(formatSseEvent(event));
    }
    reply.raw.end();
    return;
  }

  if (!deps.eventBus && stopAfter !== undefined) {
    const body = await collectReplayAndLiveEvents({
      runId: debateId,
      replay: trimByLastEventId(events, lastEventId),
      eventBus: noopEventBus(),
      stopAfter,
      match: (event) => event.debateId === debateId
    });
    reply.raw.write(body);
    reply.raw.end();
    return;
  }

  if (!deps.eventBus) {
    for (const event of trimByLastEventId(events, lastEventId)) {
      reply.raw.write(formatSseEvent(event));
    }
    reply.raw.end();
    return;
  }

  const handle = streamEntityEvents({
    replay: events,
    destination: reply.raw,
    live: true,
    eventBus: deps.eventBus,
    matches: (event) => event.debateId === debateId,
    ...(stopAfter !== undefined ? { stopAfter } : {}),
    ...(lastEventId !== undefined ? { lastEventId } : {})
  });
  await handle.finished;
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

function trimByLastEventId(events: SwitchyardEvent[], lastEventId: string | undefined): SwitchyardEvent[] {
  if (!lastEventId) {
    return events;
  }
  const index = events.findIndex((event) => event.id === lastEventId);
  if (index < 0) {
    return events;
  }
  return events.slice(index + 1);
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

function normalizeStopAfterParam(stopAfter: number | undefined): number | undefined {
  if (stopAfter === undefined || !Number.isFinite(stopAfter) || stopAfter <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(stopAfter));
}

function noopEventBus(): EventBus {
  return {
    subscribe: () => () => {},
    publish: async () => {}
  } as unknown as EventBus;
}

function sendFromServiceError(reply: FastifyReply, error: unknown) {
  if (error instanceof HttpProblem) {
    return sendHttpError(reply, error.code, error.message, error.details);
  }
  if (!error || typeof error !== "object") {
    throw error;
  }
  const serviceError = error as { code?: string; message?: string; details?: Array<{ path: string; issue: string }> };
  if (typeof serviceError.code === "string" && typeof serviceError.message === "string") {
    if (
      serviceError.code === "invalid_input" ||
      serviceError.code === "invalid_query" ||
      serviceError.code === "debate_not_found" ||
      serviceError.code === "evidence_not_found" ||
      serviceError.code === "run_not_found"
    ) {
      return sendHttpError(reply, serviceError.code, serviceError.message, serviceError.details);
    }
  }
  throw error;
}
