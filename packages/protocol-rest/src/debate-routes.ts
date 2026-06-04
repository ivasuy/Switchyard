import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ControlPlaneError, type ControlPlaneService, type DebateExecutionStore } from "@switchyard/core";
import type { DebateService, DebateStore, EventBus, EventStore } from "@switchyard/core";
import type { AuthContext, SwitchyardEvent } from "@switchyard/contracts";
import { collectReplayAndLiveEvents, formatSseEvent, streamEntityEvents } from "@switchyard/protocol-sse";
import { getHostedAuthContext } from "./hosted-auth.js";
import { HttpProblem, sendHttpError, type HttpErrorCode, type HttpErrorDetail } from "./http-errors.js";

export interface DebateRouteDependencies {
  debateService?: DebateService;
  service?: DebateService;
  debates: DebateStore;
  events: EventStore;
  eventBus?: EventBus;
  controlPlane?: ControlPlaneService;
  debateJobs?: DebateExecutionStore;
  requireHostedAuth?: boolean;
  routeMode?: "local" | "hosted";
  getAuthContext?: (request: FastifyRequest) => AuthContext | undefined;
  authorizeDebateRead?: (input: { debateId: string; auth: AuthContext; requestId?: string }) => Promise<void | { ok: boolean }>;
  enqueueDebateJob?: (input: { debateId: string; auth: AuthContext; requestId?: string }) => Promise<void>;
  mapServiceError?: (error: unknown) => { code: HttpErrorCode; message: string; details?: HttpErrorDetail[] } | undefined;
}

export function registerDebateRoutes(app: FastifyInstance, deps: DebateRouteDependencies): void {
  app.post("/debates", async (request, reply) => {
    try {
      const wait = shouldWaitForCompletion(request.query);
      const hosted = isHostedMode(deps);
      const auth = getRouteAuthContext(request, deps);
      if (hosted) {
        const authError = ensureHostedAuth(reply, auth);
        if (authError !== undefined || reply.sent) {
          return authError;
        }
        const scopeError = ensureScope(reply, deps, auth, "runs:write");
        if (scopeError !== undefined || reply.sent) {
          return scopeError;
        }
      }
      const ownershipOverrideIssue = findOwnershipOverrideIssue(request.body);
      if (ownershipOverrideIssue) {
        return sendHttpError(reply, "invalid_input", "ownership overrides are not allowed", [ownershipOverrideIssue]);
      }
      if (wait && hasRealRuntimeWaitConflict(request.body)) {
        return sendHttpError(reply, "debate_wait_real_runtime_unsupported", "wait=true is only supported for no-spend fake deterministic debates");
      }

      const createOptions = {
        wait,
        ...(hosted && auth ? { auth, requestId: request.id } : {})
      };
      const created = await debateService(deps).create(request.body, createOptions);
      if (wait) {
        return reply.code(201).send(created);
      }
      if (hosted) {
        if (deps.enqueueDebateJob && auth) {
          await deps.enqueueDebateJob({ debateId: created.debate.id, auth, requestId: request.id });
        }
      } else {
        queueMicrotask(() => {
          void debateService(deps).execute(created.debate.id).catch(() => {});
        });
      }
      return reply.code(202).send({ debate: created.debate });
    } catch (error) {
      return sendFromServiceError(reply, deps, error);
    }
  });

  app.get("/debates/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    try {
      const hosted = isHostedMode(deps);
      const auth = getRouteAuthContext(request, deps);
      if (hosted) {
        const authError = ensureHostedAuth(reply, auth);
        if (authError !== undefined || reply.sent) {
          return authError;
        }
        const scopeError = ensureScope(reply, deps, auth, "runs:read");
        if (scopeError !== undefined || reply.sent) {
          return scopeError;
        }
        const authzError = await authorizeDebateRead(reply, deps, id, auth, request.id);
        if (authzError !== undefined || reply.sent) {
          return authzError;
        }
      }
      return await debateService(deps).inspect(id);
    } catch (error) {
      return sendFromServiceError(reply, deps, error);
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
  const hosted = isHostedMode(deps);
  const auth = getRouteAuthContext(request, deps);
  if (hosted) {
    const authError = ensureHostedAuth(reply, auth);
    if (authError !== undefined || reply.sent) {
      return;
    }
    const scopeError = ensureScope(reply, deps, auth, "runs:read");
    if (scopeError !== undefined || reply.sent) {
      return;
    }
    const authzError = await authorizeDebateRead(reply, deps, debateId, auth, request.id);
    if (authzError !== undefined || reply.sent) {
      return;
    }
  }

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
    replay: events.filter((event) => event.debateId === debateId),
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

function debateService(deps: DebateRouteDependencies): DebateService {
  const service = deps.debateService ?? deps.service;
  if (!service) {
    throw new HttpProblem("internal_error", "debate service is not configured");
  }
  return service;
}

function isHostedMode(deps: DebateRouteDependencies): boolean {
  return deps.routeMode === "hosted" ||
    deps.requireHostedAuth === true ||
    !!deps.controlPlane ||
    !!deps.debateJobs ||
    !!deps.enqueueDebateJob;
}

function getRouteAuthContext(request: FastifyRequest, deps: DebateRouteDependencies): AuthContext | undefined {
  return deps.getAuthContext ? deps.getAuthContext(request) : getHostedAuthContext(request);
}

function ensureHostedAuth(
  reply: FastifyReply,
  auth: AuthContext | undefined
): FastifyReply | undefined {
  if (auth) {
    return undefined;
  }
  return sendHttpError(reply, "auth_required", "auth_required", [{ path: "reasonCode", issue: "auth_required" }]);
}

function ensureScope(
  reply: FastifyReply,
  deps: DebateRouteDependencies,
  auth: AuthContext | undefined,
  scope: "runs:read" | "runs:write"
): FastifyReply | undefined {
  if (!deps.controlPlane || !auth) {
    return undefined;
  }
  try {
    deps.controlPlane.requireScope(auth, scope);
    return undefined;
  } catch (error) {
    if (error instanceof ControlPlaneError) {
      return sendHttpError(reply, error.code, error.reasonCode, controlPlaneDetails(error));
    }
    throw error;
  }
}

async function authorizeDebateRead(
  reply: FastifyReply,
  deps: DebateRouteDependencies,
  debateId: string,
  auth: AuthContext | undefined,
  requestId: string | undefined
): Promise<FastifyReply | undefined> {
  if (!auth) {
    return sendHttpError(reply, "auth_required", "auth_required", [{ path: "reasonCode", issue: "auth_required" }]);
  }
  if (deps.authorizeDebateRead) {
    try {
      const allowed = await deps.authorizeDebateRead({ debateId, auth, ...(requestId ? { requestId } : {}) });
      if (allowed && allowed.ok === false) {
        return sendHttpError(reply, "debate_not_found", `Debate not found: ${debateId}`);
      }
      return undefined;
    } catch (error) {
      if (error instanceof ControlPlaneError) {
        return sendHttpError(reply, "debate_not_found", `Debate not found: ${debateId}`);
      }
      throw error;
    }
  }
  if (!deps.controlPlane) {
    return undefined;
  }
  const owned = await deps.controlPlane.authorizeResource({
    auth,
    resourceType: "debate",
    resourceId: debateId,
    notFoundCode: "debate_not_found"
  });
  if (!owned.ok) {
    return sendHttpError(reply, "debate_not_found", `Debate not found: ${debateId}`);
  }
  return undefined;
}

function findOwnershipOverrideIssue(payload: unknown): HttpErrorDetail | null {
  if (!isRecord(payload)) {
    return null;
  }
  const ownerKeys = ["accountId", "tenantId", "projectId", "userId", "apiKeyId"];
  const topLevel = ownerKeys.find((key) => key in payload);
  if (topLevel) {
    return { path: topLevel, issue: "owner override is not allowed" };
  }
  const participants = payload["participants"];
  if (!Array.isArray(participants)) {
    return null;
  }
  for (const [index, participant] of participants.entries()) {
    if (!isRecord(participant)) {
      continue;
    }
    const metadata = participant["metadata"];
    if (!isRecord(metadata)) {
      continue;
    }
    const metadataOverride = ownerKeys.find((key) => key in metadata);
    if (metadataOverride) {
      return { path: `participants.${index}.metadata.${metadataOverride}`, issue: "owner override is not allowed" };
    }
  }
  return null;
}

function hasRealRuntimeWaitConflict(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false;
  }
  const participants = payload["participants"];
  if (Array.isArray(participants) && participants.some((participant) => isRealParticipantInput(participant))) {
    return true;
  }
  const judgeConfig = payload["judgeConfig"];
  return isRecord(judgeConfig) && (judgeConfig["mode"] === "model" || judgeConfig["realRuntimeOptIn"] === true);
}

function isRealParticipantInput(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value["realRuntimeOptIn"] === true || value["placement"] === "hosted") {
    return true;
  }
  return (typeof value["runtime"] === "string" && value["runtime"] !== "fake") ||
    (typeof value["provider"] === "string" && value["provider"] !== "test") ||
    (typeof value["model"] === "string" && value["model"] !== "test-model") ||
    (typeof value["adapterType"] === "string" && value["adapterType"] !== "process") ||
    (typeof value["runtimeMode"] === "string" && value["runtimeMode"] !== "fake.deterministic");
}

function controlPlaneDetails(error: ControlPlaneError): HttpErrorDetail[] {
  const details: HttpErrorDetail[] = [{ path: "reasonCode", issue: error.reasonCode }];
  if (error.safeDetails) {
    for (const [key, value] of Object.entries(error.safeDetails)) {
      details.push({ path: key, issue: String(value) });
    }
  }
  return details;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sendFromServiceError(reply: FastifyReply, deps: DebateRouteDependencies, error: unknown) {
  const mapped = deps.mapServiceError?.(error);
  if (mapped) {
    return sendHttpError(reply, mapped.code, mapped.message, mapped.details);
  }
  if (error instanceof HttpProblem) {
    return sendHttpError(reply, error.code, error.message, error.details);
  }
  if (error instanceof ControlPlaneError) {
    return sendHttpError(reply, error.code, error.reasonCode, controlPlaneDetails(error));
  }
  if (!error || typeof error !== "object") {
    throw error;
  }
  const serviceError = error as { code?: string; message?: string; details?: Array<{ path: string; issue: string }> };
  if (typeof serviceError.code === "string" && typeof serviceError.message === "string") {
    const code = serviceError.code;
    if (isKnownDebateHttpErrorCode(code)) {
      return sendHttpError(reply, code, serviceError.message, serviceError.details);
    }
  }
  throw error;
}

function isKnownDebateHttpErrorCode(code: string): code is HttpErrorCode {
  return code === "invalid_input" ||
    code === "invalid_query" ||
    code === "debate_not_found" ||
    code === "evidence_not_found" ||
    code === "run_not_found" ||
    code === "debate_evidence_not_found_or_denied" ||
    code === "debate_real_participant_opt_in_required" ||
    code === "debate_runtime_unsupported" ||
    code === "debate_wait_real_runtime_unsupported" ||
    code === "debate_participant_count_invalid" ||
    code === "debate_participant_placement_required" ||
    code === "debate_participant_run_missing" ||
    code === "debate_participant_run_failed" ||
    code === "debate_participant_run_timeout" ||
    code === "debate_participant_output_missing" ||
    code === "debate_participant_output_empty" ||
    code === "debate_participant_output_too_large" ||
    code === "debate_runtime_approval_expired" ||
    code === "debate_child_run_link_failed" ||
    code === "debate_judge_config_invalid" ||
    code === "debate_judge_runtime_unsupported" ||
    code === "debate_judge_live_spend_unconfirmed" ||
    code === "debate_judge_run_failed" ||
    code === "debate_judge_timeout" ||
    code === "debate_judge_output_missing" ||
    code === "debate_judge_output_empty" ||
    code === "debate_judge_output_invalid" ||
    code === "debate_judge_output_too_large" ||
    code === "hosted_debate_store_unavailable" ||
    code === "hosted_debate_queue_unavailable" ||
    code === "hosted_debate_worker_unavailable" ||
    code === "hosted_debate_ownership_attach_failed" ||
    code === "hosted_debate_quota_exceeded" ||
    code === "hosted_debate_audit_unavailable" ||
    code === "hosted_debate_artifact_write_failed" ||
    code === "hosted_debate_event_persist_failed" ||
    code === "debate_live_canary_spend_unconfirmed" ||
    code === "debate_fake_canary_failed" ||
    code === "auth_required" ||
    code === "auth_failed" ||
    code === "auth_conflict" ||
    code === "auth_store_unavailable" ||
    code === "tenant_access_denied" ||
    code === "project_access_denied" ||
    code === "entitlement_denied" ||
    code === "quota_exceeded";
}
