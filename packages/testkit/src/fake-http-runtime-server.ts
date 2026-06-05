import Fastify, { type FastifyInstance } from "fastify";

export type FakeHttpRuntimeScenario =
  | "happy"
  | "empty_events"
  | "upstream_failed"
  | "start_http_500"
  | "invalid_start_json"
  | "invalid_events_json"
  | "invalid_status_json"
  | "invalid_artifacts_json"
  | "cancellation"
  | "cancel_failure"
  | "cancel_false"
  | "cancel_404_nonterminal"
  | "cancel_accepted_but_status_running"
  | "timeout_no_terminal"
  | "unsafe_artifact_name"
  | "terminal_flag_without_terminal_event"
  | "events_without_ids"
  | "health_http_500"
  | "invalid_health_json"
  | "oversized_health_response"
  | "oversized_start_response"
  | "oversized_status_response"
  | "oversized_events_response"
  | "oversized_cancel_response"
  | "oversized_artifacts_response"
  | "bridge_happy"
  | "bridge_capability_missing"
  | "bridge_input_http_500"
  | "bridge_input_malformed_response"
  | "bridge_input_invalid_json"
  | "bridge_input_oversized_response"
  | "bridge_input_timeout"
  | "bridge_approval_http_500"
  | "bridge_approval_malformed_response"
  | "bridge_approval_invalid_json"
  | "bridge_approval_oversized_response"
  | "bridge_approval_timeout"
  | "approval_request"
  | "malformed_approval_request"
  | "duplicate_approval_events"
  | "waiting_for_input_event"
  | "resumed_event"
  | "unknown_wrapper_event";

export interface FakeHttpRuntimeServerOptions {
  host?: string;
  port?: number;
  scenario?: FakeHttpRuntimeScenario;
  expectedAuthToken?: string;
  terminalStatus?: "running" | "completed" | "failed" | "cancelled";
}

interface FakeServerRunState {
  externalRunId: string;
  cancelCount: number;
  cancelled: boolean;
}

export interface FakeHttpRuntimeServerStats {
  healthRequests: number;
  startRequests: number;
  inputRequests: number;
  approvalResolutionRequests: number;
  lastInputBody?: Record<string, unknown>;
  lastApprovalResolutionBody?: Record<string, unknown>;
  lastApprovalResolutionToken?: string;
}

export interface FakeHttpRuntimeServerHandle {
  baseUrl: string;
  close(): Promise<void>;
  url(path: string): string;
  stats(): FakeHttpRuntimeServerStats;
}

export async function startFakeHttpRuntimeServer(
  options: FakeHttpRuntimeServerOptions = {}
): Promise<FakeHttpRuntimeServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const scenario = options.scenario ?? "happy";
  const app = Fastify({ logger: false });
  const runs = new Map<string, FakeServerRunState>();
  const stats: FakeHttpRuntimeServerStats = {
    healthRequests: 0,
    startRequests: 0,
    inputRequests: 0,
    approvalResolutionRequests: 0
  };
  let idCounter = 0;

  app.addHook("onRequest", async (request, reply) => {
    if (!options.expectedAuthToken) {
      return;
    }
    const authorization = request.headers["authorization"];
    const expected = `Bearer ${options.expectedAuthToken}`;
    if (authorization !== expected) {
      reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/health", async (_request, reply) => {
    stats.healthRequests += 1;
    if (scenario === "health_http_500") {
      return reply.code(500).send({ ok: false });
    }
    if (scenario === "invalid_health_json") {
      reply.type("application/json");
      return reply.send("not-json");
    }
    if (scenario === "oversized_health_response") {
      return reply.send({ ok: true, payload: oversizedPayload() });
    }
    return reply.send({
      ok: true,
      capabilities: scenario === "bridge_happy"
        || scenario === "bridge_input_http_500"
        || scenario === "bridge_input_malformed_response"
        || scenario === "bridge_input_invalid_json"
        || scenario === "bridge_input_oversized_response"
        || scenario === "bridge_input_timeout"
        || scenario === "bridge_approval_http_500"
        || scenario === "bridge_approval_malformed_response"
        || scenario === "bridge_approval_invalid_json"
        || scenario === "bridge_approval_oversized_response"
        || scenario === "bridge_approval_timeout"
        || scenario === "approval_request"
        || scenario === "malformed_approval_request"
        || scenario === "duplicate_approval_events"
        || scenario === "waiting_for_input_event"
        || scenario === "resumed_event"
        || scenario === "unknown_wrapper_event"
          ? ["start", "status", "events", "artifacts", "input", "approval_request", "approval_resolution"]
          : ["start", "status", "events", "cancel", "artifacts"]
    });
  });

  app.post("/v1/runs", async (_request, reply) => {
    stats.startRequests += 1;
    if (scenario === "start_http_500") {
      return reply.code(500).send({ error: "start_failed" });
    }
    if (scenario === "invalid_start_json") {
      return reply.send({ status: "running" });
    }
    if (scenario === "oversized_start_response") {
      return reply.send({ externalRunId: "ext_oversized", payload: oversizedPayload() });
    }

    const externalRunId = `ext_run_${++idCounter}`;
    runs.set(externalRunId, {
      externalRunId,
      cancelCount: 0,
      cancelled: false
    });
    return reply.send({
      externalRunId,
      status: "running"
    });
  });

  app.post("/v1/runs/:externalRunId/input", async (request, reply) => {
    const externalRunId = (request.params as { externalRunId: string }).externalRunId;
    if (!runs.has(externalRunId)) {
      return reply.code(404).send({ error: "not_found" });
    }
    stats.inputRequests += 1;
    stats.lastInputBody = isRecord(request.body) ? request.body : {};
    if (scenario === "bridge_input_timeout") {
      await sleep(250);
    }
    if (scenario === "bridge_input_http_500") {
      return reply.code(500).send({ accepted: false });
    }
    if (scenario === "bridge_input_malformed_response") {
      return reply.send({ accepted: false });
    }
    if (scenario === "bridge_input_invalid_json") {
      reply.type("application/json");
      return reply.send("not-json");
    }
    if (scenario === "bridge_input_oversized_response") {
      return reply.send({ accepted: true, externalInputId: "input_oversized", payload: oversizedPayload() });
    }
    return reply.send({ accepted: true, externalInputId: `input_${stats.inputRequests}` });
  });

  app.post("/v1/runs/:externalRunId/approvals/:runtimeApprovalToken/resolve", async (request, reply) => {
    const externalRunId = (request.params as { externalRunId: string; runtimeApprovalToken: string }).externalRunId;
    const runtimeApprovalToken = (request.params as { externalRunId: string; runtimeApprovalToken: string }).runtimeApprovalToken;
    if (!runs.has(externalRunId)) {
      return reply.code(404).send({ error: "not_found" });
    }
    stats.approvalResolutionRequests += 1;
    stats.lastApprovalResolutionToken = runtimeApprovalToken;
    stats.lastApprovalResolutionBody = isRecord(request.body) ? request.body : {};
    if (scenario === "bridge_approval_timeout") {
      await sleep(250);
    }
    if (scenario === "bridge_approval_http_500") {
      return reply.code(500).send({ accepted: false });
    }
    if (scenario === "bridge_approval_malformed_response") {
      return reply.send({ accepted: false });
    }
    if (scenario === "bridge_approval_invalid_json") {
      reply.type("application/json");
      return reply.send("not-json");
    }
    if (scenario === "bridge_approval_oversized_response") {
      return reply.send({ accepted: true, externalResolutionId: "resolution_oversized", payload: oversizedPayload() });
    }
    return reply.send({ accepted: true, externalResolutionId: `resolution_${stats.approvalResolutionRequests}` });
  });

  app.get("/v1/runs/:externalRunId", async (request, reply) => {
    const externalRunId = (request.params as { externalRunId: string }).externalRunId;
    if (!runs.has(externalRunId)) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (scenario === "invalid_status_json") {
      return reply.send({ bad: true });
    }
    if (scenario === "oversized_status_response") {
      return reply.send({ status: "running", payload: oversizedPayload() });
    }
    const state = runs.get(externalRunId)!;
    return reply.send({
      externalRunId,
      status: statusForScenario(scenario, state, options.terminalStatus)
    });
  });

  app.get("/v1/runs/:externalRunId/events", async (request, reply) => {
    const externalRunId = (request.params as { externalRunId: string }).externalRunId;
    if (!runs.has(externalRunId)) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (scenario === "invalid_events_json") {
      return reply.send({ events: "bad" });
    }
    if (scenario === "oversized_events_response") {
      return reply.send({ events: [], payload: oversizedPayload() });
    }

    const cursor = typeof (request.query as Record<string, unknown>)["cursor"] === "string"
      ? String((request.query as Record<string, unknown>)["cursor"])
      : undefined;

    const baseEvents = eventsForScenario(scenario);
    const events = sliceEventsByCursor(baseEvents, cursor);
    const lastId = events.length > 0 ? events[events.length - 1]?.id : undefined;
    const includeIds = scenario !== "events_without_ids";

    return reply.send({
      events: includeIds
        ? events
        : events.map((event) => {
          const copy = { ...event };
          delete copy.id;
          return copy;
        }),
      nextCursor: includeIds ? (lastId ?? null) : undefined,
      terminal: scenario === "terminal_flag_without_terminal_event" ? true : isTerminalEvents(events)
    });
  });

  app.post("/v1/runs/:externalRunId/cancel", async (request, reply) => {
    const externalRunId = (request.params as { externalRunId: string }).externalRunId;
    const state = runs.get(externalRunId);
    if (!state) {
      return reply.code(404).send({ error: "not_found" });
    }
    state.cancelCount += 1;

    if (scenario === "cancel_failure") {
      return reply.code(500).send({ cancelled: false });
    }
    if (scenario === "cancel_false") {
      return reply.send({ cancelled: false });
    }
    if (scenario === "cancel_404_nonterminal") {
      return reply.code(404).send({ error: "not_found" });
    }
    if (scenario === "cancel_accepted_but_status_running") {
      return reply.code(202).send({});
    }
    if (scenario === "oversized_cancel_response") {
      return reply.send({ cancelled: true, payload: oversizedPayload() });
    }

    state.cancelled = true;
    if (scenario === "cancellation") {
      return reply.send({ cancelled: true });
    }
    return reply.send({ cancelled: true });
  });

  app.get("/v1/runs/:externalRunId/artifacts", async (request, reply) => {
    const externalRunId = (request.params as { externalRunId: string }).externalRunId;
    if (!runs.has(externalRunId)) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (scenario === "invalid_artifacts_json") {
      return reply.send({ artifacts: "bad" });
    }
    if (scenario === "oversized_artifacts_response") {
      return reply.send({ artifacts: [{ id: "artifact_1", payload: oversizedPayload() }] });
    }
    return reply.send({
      artifacts: [
        {
          id: "artifact_wrapper_transcript",
          name: scenario === "unsafe_artifact_name" ? "../../escape.log" : "transcript.jsonl",
          type: "transcript",
          content: "{\"type\":\"runtime.output\",\"text\":\"generic-http transcript line\"}\n"
        }
      ]
    });
  });

  await app.listen({ host, port });
  const addr = app.server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  const baseUrl = `http://${host}:${actualPort}`;

  return {
    baseUrl,
    close: async () => {
      await closeApp(app);
    },
    url: (path: string) => `${baseUrl}${path}`,
    stats: () => {
      const snapshot: FakeHttpRuntimeServerStats = {
        healthRequests: stats.healthRequests,
        startRequests: stats.startRequests,
        inputRequests: stats.inputRequests,
        approvalResolutionRequests: stats.approvalResolutionRequests
      };
      if (stats.lastInputBody) {
        snapshot.lastInputBody = { ...stats.lastInputBody };
      }
      if (stats.lastApprovalResolutionBody) {
        snapshot.lastApprovalResolutionBody = { ...stats.lastApprovalResolutionBody };
      }
      if (stats.lastApprovalResolutionToken) {
        snapshot.lastApprovalResolutionToken = stats.lastApprovalResolutionToken;
      }
      return snapshot;
    }
  };
}

function eventsForScenario(scenario: FakeHttpRuntimeScenario): Array<Record<string, unknown>> {
  if (scenario === "empty_events" || scenario === "timeout_no_terminal" || scenario.startsWith("cancel_") || scenario === "cancel_failure" || scenario === "cancel_false") {
    return [];
  }
  if (scenario === "upstream_failed") {
    return [
      { id: "evt_1", type: "runtime.status", status: "running" },
      { id: "evt_2", type: "run.failed", status: "failed", error: "upstream_failed" }
    ];
  }
  if (scenario === "terminal_flag_without_terminal_event") {
    return [{ id: "evt_1", type: "runtime.output", text: "output without terminal event" }];
  }
  if (scenario === "events_without_ids") {
    return [
      { id: "evt_a", type: "runtime.output", text: "output without ids" },
      { id: "evt_b", type: "run.completed", status: "completed" }
    ];
  }
  if (scenario === "approval_request") {
    return [
      { id: "evt_approval_1", type: "approval.requested", runtimeApprovalToken: "approval_token_1", approvalType: "before_external_message", message: "Wrapper requests permission.", expiresAt: "2026-06-04T20:00:00.000Z", answers: { selectedOption: "allow" } },
      { id: "evt_approval_done", type: "run.completed", status: "completed" }
    ];
  }
  if (scenario === "malformed_approval_request") {
    return [
      { id: "evt_approval_bad", type: "approval.requested", approvalType: "before_external_message", message: "Missing token.", expiresAt: "2026-06-04T20:00:00.000Z" }
    ];
  }
  if (scenario === "duplicate_approval_events") {
    return [
      { id: "evt_approval_dup", type: "approval.requested", runtimeApprovalToken: "approval_token_dup", approvalType: "before_external_message", message: "Duplicate permission.", expiresAt: "2026-06-04T20:00:00.000Z" },
      { id: "evt_approval_dup", type: "approval.requested", runtimeApprovalToken: "approval_token_dup", approvalType: "before_external_message", message: "Duplicate permission.", expiresAt: "2026-06-04T20:00:00.000Z" },
      { id: "evt_approval_terminal", type: "run.completed", status: "completed" }
    ];
  }
  if (scenario === "waiting_for_input_event") {
    return [
      { id: "evt_waiting_input", type: "runtime.status", status: "waiting_for_input" },
      { id: "evt_waiting_done", type: "run.completed", status: "completed" }
    ];
  }
  if (scenario === "resumed_event") {
    return [
      { id: "evt_resumed", type: "runtime.status", status: "resumed" },
      { id: "evt_resumed_done", type: "run.completed", status: "completed" }
    ];
  }
  if (scenario === "unknown_wrapper_event") {
    return [
      { id: "evt_unknown", type: "wrapper.custom", status: "mystery" },
      { id: "evt_unknown_done", type: "run.completed", status: "completed" }
    ];
  }
  return [
    { id: "evt_1", type: "runtime.status", status: "running" },
    { id: "evt_2", type: "runtime.output", text: "generic-http output" },
    { id: "evt_3", type: "run.completed", status: "completed" }
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sliceEventsByCursor(events: Array<Record<string, unknown>>, cursor?: string): Array<Record<string, unknown>> {
  if (!cursor) {
    return events;
  }
  const index = events.findIndex((event) => event.id === cursor);
  if (index < 0) {
    return events;
  }
  return events.slice(index + 1);
}

function isTerminalEvents(events: Array<Record<string, unknown>>): boolean {
  return events.some((event) => event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled");
}

function statusForScenario(
  scenario: FakeHttpRuntimeScenario,
  state: FakeServerRunState,
  terminalStatus: "running" | "completed" | "failed" | "cancelled" | undefined
): "running" | "completed" | "failed" | "cancelled" {
  if (scenario === "upstream_failed") {
    return "failed";
  }
  if (scenario === "timeout_no_terminal") {
    return "running";
  }
  if (scenario === "cancellation") {
    return state.cancelled ? "cancelled" : "running";
  }
  if (scenario === "cancel_accepted_but_status_running" || scenario === "cancel_false" || scenario === "cancel_404_nonterminal" || scenario === "cancel_failure") {
    return "running";
  }
  if (scenario === "terminal_flag_without_terminal_event") {
    return terminalStatus ?? "completed";
  }
  if (scenario === "start_http_500" || scenario === "invalid_start_json") {
    return "running";
  }
  return "completed";
}

function oversizedPayload(): string {
  return "x".repeat(8192);
}

async function closeApp(app: FastifyInstance): Promise<void> {
  try {
    await app.close();
  } catch {
    // best effort for tests and CLI
  }
}
