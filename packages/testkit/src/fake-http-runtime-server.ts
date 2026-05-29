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
  | "oversized_artifacts_response";

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

export interface FakeHttpRuntimeServerHandle {
  baseUrl: string;
  close(): Promise<void>;
  url(path: string): string;
}

export async function startFakeHttpRuntimeServer(
  options: FakeHttpRuntimeServerOptions = {}
): Promise<FakeHttpRuntimeServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const scenario = options.scenario ?? "happy";
  const app = Fastify({ logger: false });
  const runs = new Map<string, FakeServerRunState>();
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
      capabilities: ["start", "status", "events", "cancel", "artifacts"]
    });
  });

  app.post("/v1/runs", async (_request, reply) => {
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
    url: (path: string) => `${baseUrl}${path}`
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
  return [
    { id: "evt_1", type: "runtime.status", status: "running" },
    { id: "evt_2", type: "runtime.output", text: "generic-http output" },
    { id: "evt_3", type: "run.completed", status: "completed" }
  ];
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
