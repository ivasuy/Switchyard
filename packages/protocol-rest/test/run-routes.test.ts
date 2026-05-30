import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  AdapterProtocolError,
  type ArtifactStore,
  EventBus,
  RegistryService,
  RunLauncherService,
  RunService,
  RuntimeRunnerService
} from "@switchyard/core";
import type { Artifact } from "@switchyard/contracts";
import { FakeRuntimeAdapter, InMemoryEventStore, InMemoryRegistryStore, InMemoryRunStore, InMemorySessionStore } from "@switchyard/testkit";
import { registerRunRoutes } from "../src/index.js";

describe("run routes", () => {
  it("falls back to direct async start when launcher is omitted", async () => {
    const harness = createRouteHarness({ withLauncher: false });
    const startRunSpy = vi.spyOn(harness.runService, "startRun");

    const createResponse = await harness.app.inject({
      method: "POST",
      url: "/runs",
      payload: fakeRunPayload("No launcher run")
    });

    expect(createResponse.statusCode).toBe(202);
    const runId = createResponse.json().run.id;
    const seenRun = await harness.runs.get(runId);
    expect(seenRun?.id).toBe(runId);

    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const completed = await harness.runs.get(runId);
    expect(completed?.status).toBe("completed");
    expect(startRunSpy).toHaveBeenCalledTimes(1);
  });

  it("parses wait=1 for repeated query values and keeps non-1 async", async () => {
    const harness = createRouteHarness();
    const repeatedResponse = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=1&wait=0",
      payload: fakeRunPayload("Repeat wait run")
    });
    const waitZeroResponse = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=0",
      payload: fakeRunPayload("Async wait run")
    });

    expect(repeatedResponse.statusCode).toBe(201);
    expect(waitZeroResponse.statusCode).toBe(202);
  });

  it("returns empty artifacts for existing run when artifact store is not configured", async () => {
    const harness = createRouteHarness();
    const created = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=1",
      payload: fakeRunPayload("Artifacts missing store run")
    });
    const runId = created.json().run.id;

    const response = await harness.app.inject({ method: "GET", url: `/runs/${runId}/artifacts` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ artifacts: [] });
  });

  it("returns artifacts for a completed fake run", async () => {
    const harness = createRouteHarness({ withArtifacts: true });
    const created = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=1",
      payload: fakeRunPayload("Artifact test run")
    });
    const runId = created.json().run.id;

    const response = await harness.app.inject({ method: "GET", url: `/runs/${runId}/artifacts` });

    expect(response.statusCode).toBe(200);
    expect(response.json().artifacts[0]).toMatchObject({ runId, type: "transcript" });
  });

  it("creates, starts, and returns a fake runtime run", async () => {
    const harness = createRouteHarness();

    const createResponse = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=1",
      payload: {
        ...fakeRunPayload("Test task")
      }
    });

    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json();
    expect(created.run.status).toBe("completed");
    expect(created.run.id).toMatch(/^run_/);
    expect(created.response).toEqual({
      text: "fake runtime output",
      outputs: [{ sequence: 3, text: "fake runtime output" }]
    });

    const getResponse = await harness.app.inject({
      method: "GET",
      url: `/runs/${created.run.id}`
    });

    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json().run.status).toBe("completed");
  });

  it("preserves provider metadata on created and stored run", async () => {
    const harness = createRouteHarness();
    const metadata = {
      reasoningEffort: "high",
      reasoningSummary: "verbose",
      verbosity: "low"
    };

    const createResponse = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=1",
      payload: {
        ...fakeRunPayload("Metadata preservation run"),
        metadata
      }
    });

    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.json().run.metadata).toEqual(metadata);

    const runId = createResponse.json().run.id;
    const storedRun = await harness.runs.get(runId);
    expect(storedRun?.metadata).toEqual(metadata);
  });

  it("keeps existing run task and metadata behavior when context is absent", async () => {
    const harness = createRouteHarness();
    const payload = {
      ...fakeRunPayload("No context task"),
      metadata: { custom: "value" }
    };

    const createResponse = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=1",
      payload
    });

    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.json().run.task).toBe("No context task");
    expect(createResponse.json().run.metadata).toEqual({ custom: "value" });
    expect(createResponse.json().run.metadata.originalTask).toBeUndefined();
    expect(createResponse.json().run.metadata.contextPacket).toBeUndefined();
  });

  it("rejects reserved metadata keys when context is supplied", async () => {
    const harness = createRouteHarness();
    const createResponse = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=1",
      payload: {
        ...fakeRunPayload("With context"),
        metadata: { originalTask: "spoofed" },
        context: {
          memoryIds: []
        }
      }
    });

    expect(createResponse.statusCode).toBe(400);
    expect(createResponse.json().error.code).toBe("invalid_input");
  });

  it("returns run events as an SSE-compatible stream", async () => {
    const harness = createRouteHarness();

    const createResponse = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=1",
      payload: fakeRunPayload("Stream test run")
    });
    const runId = createResponse.json().run.id;

    const streamResponse = await harness.app.inject({
      method: "GET",
      url: `/runs/${runId}/events`
    });

    expect(streamResponse.statusCode).toBe(200);
    expect(streamResponse.headers["content-type"]).toContain("text/event-stream");
    expect(streamResponse.body).toContain("event: run.queued");
    expect(streamResponse.body).toContain("event: run.completed");
    expect(streamResponse.body).toContain("event: runtime.output");
    expect(streamResponse.body).toContain("fake runtime output");
  });

  it("supports live SSE events with replay plus stopAfter", async () => {
    const harness = createRouteHarness({ withEventBus: true });
    const createResponse = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=0",
      payload: fakeRunPayload("Streaming live run test")
    });
    const runId = createResponse.json().run.id;
    const startReplay = await harness.events.listByRun(runId);
    const stopAfter = startReplay.length + 1;

    const streamResponsePromise = harness.app.inject({
      method: "GET",
      url: `/runs/${runId}/events?live=1&stopAfter=${stopAfter}`
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await harness.eventBus?.publish({
      id: "event_test_live_completed",
      type: "run.completed",
      runId,
      sequence: startReplay.length,
      payload: { status: "completed" },
      createdAt: "2026-05-11T00:00:01.000Z"
    });
    const streamResponse = await streamResponsePromise;

    expect(streamResponse.statusCode).toBe(200);
    expect(streamResponse.body).toContain("event: run.queued");
    expect(streamResponse.body).toContain("event: run.completed");
  });

  it("truncates replay body when stopAfter is less than replay length", async () => {
    const harness = createRouteHarness({ withEventBus: true });

    const createResponse = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=1",
      payload: fakeRunPayload("Replay truncation run")
    });
    const runId = createResponse.json().run.id;
    const allEvents = await harness.events.listByRun(runId);
    const stopAfter = Math.max(1, allEvents.length - 1);

    const streamResponse = await harness.app.inject({
      method: "GET",
      url: `/runs/${runId}/events?stopAfter=${stopAfter}`
    });

    expect(streamResponse.statusCode).toBe(200);
    expect(streamResponse.body.match(/^event: .*$/gm)?.length).toBe(stopAfter);
  });

  it("normalizes fractional stopAfter to one for non-live replay", async () => {
    const harness = createRouteHarness({ withEventBus: true });

    const createResponse = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=1",
      payload: fakeRunPayload("Fractional non-live stopAfter run")
    });
    const runId = createResponse.json().run.id;

    const streamResponse = await harness.app.inject({
      method: "GET",
      url: `/runs/${runId}/events?stopAfter=0.5`
    });

    expect(streamResponse.statusCode).toBe(200);
    expect(streamResponse.body.match(/^event: .*$/gm)?.length).toBe(1);
  });

  it("normalizes fractional stopAfter to one for live replay", async () => {
    const harness = createRouteHarness({ withEventBus: true });

    const createResponse = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=1",
      payload: fakeRunPayload("Fractional live stopAfter run")
    });
    const runId = createResponse.json().run.id;

    const streamResponse = await harness.app.inject({
      method: "GET",
      url: `/runs/${runId}/events?live=1&stopAfter=0.5`
    });

    expect(streamResponse.statusCode).toBe(200);
    expect(streamResponse.body.match(/^event: .*$/gm)?.length).toBe(1);
  });

  it("keeps live request bounded when eventBus is absent", async () => {
    const harness = createRouteHarness();

    const createResponse = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=1",
      payload: fakeRunPayload("Live request without bus run")
    });
    const runId = createResponse.json().run.id;
    const allEvents = await harness.events.listByRun(runId);

    const streamResponse = await harness.app.inject({
      method: "GET",
      url: `/runs/${runId}/events?live=1&stopAfter=-1`
    });

    expect(streamResponse.statusCode).toBe(200);
    expect(streamResponse.body.match(/^event: .*$/gm)?.length).toBe(allEvents.length);
  });

  it("treats invalid stopAfter as full replay for non-live requests", async () => {
    const harness = createRouteHarness({ withEventBus: true });

    const createResponse = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=1",
      payload: fakeRunPayload("Invalid stopAfter run")
    });
    const runId = createResponse.json().run.id;

    const streamResponse = await harness.app.inject({
      method: "GET",
      url: `/runs/${runId}/events?stopAfter=not-a-number`
    });

    expect(streamResponse.statusCode).toBe(200);
    expect(streamResponse.body).toContain("event: run.queued");
  });

  it("sends input and cancels a run", async () => {
    const harness = createRouteHarness();
    const createResponse = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=1",
      payload: fakeRunPayload("Lifecycle test run")
    });
    const runId = createResponse.json().run.id;

    const inputResponse = await harness.app.inject({
      method: "POST",
      url: `/runs/${runId}/input`,
      payload: { text: "continue" }
    });
    const cancelResponse = await harness.app.inject({
      method: "POST",
      url: `/runs/${runId}/cancel`
    });

    expect(inputResponse.statusCode).toBe(409);
    expect(cancelResponse.statusCode).toBe(200);
    expect(cancelResponse.json().run.status).toBe("completed");
  });

  it("returns 409 when runtime input is unsupported after start", async () => {
    const harness = createRouteHarness();
    const createResponse = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=1",
      payload: fakeRunPayload("Unsupported input run")
    });
    const runId = createResponse.json().run.id;
    const unsupportedError = new AdapterProtocolError("Codex exec-json does not support input after start", {
      reasonCode: "codex_input_unsupported"
    });
    vi.spyOn(harness.runService, "sendInput").mockRejectedValueOnce(unsupportedError);

    const inputResponse = await harness.app.inject({
      method: "POST",
      url: `/runs/${runId}/input`,
      payload: { text: "continue" }
    });

    expect(inputResponse.statusCode).toBe(409);
    expect(inputResponse.json()).toEqual({
      error: {
        code: "adapter_protocol_failed",
        message: "Codex exec-json does not support input after start",
        details: [{ path: "reasonCode", issue: "codex_input_unsupported" }]
      }
    });
  });

  it("infers runtimeMode for fake runs when omitted", async () => {
    const harness = createRouteHarness();
    const response = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=1",
      payload: fakeRunPayload("Infer mode run")
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().run.runtimeMode).toBe("fake.deterministic");
  });

  it("infers generic http/agentfield runtime modes and validates explicit generic runtime mode", async () => {
    const harness = createRouteHarness();
    const inferred = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=0",
      payload: {
        runtime: "generic_http",
        provider: "generic_http",
        model: "generic-http-default",
        adapterType: "http",
        cwd: "/repo",
        task: "infer generic mode"
      }
    });
    const explicit = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=0",
      payload: {
        runtime: "generic_http",
        provider: "generic_http",
        model: "generic-http-default",
        adapterType: "http",
        runtimeMode: "generic_http.async_rest",
        cwd: "/repo",
        task: "explicit generic mode"
      }
    });
    const rejectedId = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=0",
      payload: {
        runtime: "generic_http",
        provider: "generic_http",
        model: "generic-http-default",
        adapterType: "http",
        runtimeMode: "runtime_mode_generic_http_async_rest",
        cwd: "/repo",
        task: "generic id"
      }
    });
    const rejectedMismatch = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=0",
      payload: {
        runtime: "fake",
        provider: "test",
        model: "test-model",
        adapterType: "process",
        runtimeMode: "generic_http.async_rest",
        cwd: "/repo",
        task: "generic mismatch"
      }
    });

    expect(inferred.statusCode).toBe(202);
    expect(inferred.json().run.runtimeMode).toBe("generic_http.async_rest");
    expect(explicit.statusCode).toBe(202);
    expect(explicit.json().run.runtimeMode).toBe("generic_http.async_rest");
    expect(rejectedId.statusCode).toBe(400);
    expect(rejectedMismatch.statusCode).toBe(400);

    const agentfieldInferred = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=0",
      payload: {
        runtime: "agentfield",
        provider: "agentfield",
        model: "agentfield-default",
        adapterType: "http",
        cwd: "/repo",
        task: "infer agentfield mode"
      }
    });
    const agentfieldRejectedId = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=0",
      payload: {
        runtime: "agentfield",
        provider: "agentfield",
        model: "agentfield-default",
        adapterType: "http",
        runtimeMode: "runtime_mode_agentfield_async_rest",
        cwd: "/repo",
        task: "agentfield id"
      }
    });
    const agentfieldRejectedMismatch = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=0",
      payload: {
        runtime: "fake",
        provider: "test",
        model: "test-model",
        adapterType: "process",
        runtimeMode: "agentfield.async_rest",
        cwd: "/repo",
        task: "agentfield mismatch"
      }
    });
    expect(agentfieldInferred.statusCode).toBe(202);
    expect(agentfieldInferred.json().run.runtimeMode).toBe("agentfield.async_rest");
    expect(agentfieldRejectedId.statusCode).toBe(400);
    expect(agentfieldRejectedMismatch.statusCode).toBe(400);
  });

  it("accepts runtimeMode slug and rejects runtimeMode ids or mismatches", async () => {
    const harness = createRouteHarness();
    const accepted = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=1",
      payload: {
        ...fakeRunPayload("Explicit runtimeMode slug"),
        runtimeMode: "fake.deterministic"
      }
    });
    const rejectedId = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=1",
      payload: {
        ...fakeRunPayload("Explicit runtimeMode id"),
        runtimeMode: "runtime_mode_fake_deterministic"
      }
    });
    const rejectedMismatch = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=1",
      payload: {
        ...fakeRunPayload("Explicit mismatch"),
        runtimeMode: "codex.exec_json"
      }
    });

    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().run.runtimeMode).toBe("fake.deterministic");
    expect(rejectedId.statusCode).toBe(400);
    expect(rejectedId.json().error.code).toBe("invalid_input");
    expect(rejectedId.json().error.details?.[0]?.path).toBe("runtimeMode");
    expect(rejectedMismatch.statusCode).toBe(400);
    expect(rejectedMismatch.json().error.code).toBe("invalid_input");
    expect(rejectedMismatch.json().error.details?.[0]?.path).toBe("runtimeMode");
  });
});

interface RouteHarness {
  app: FastifyInstance;
  runService: RunService;
  runs: InMemoryRunStore;
  events: InMemoryEventStore;
  sessions: InMemorySessionStore;
  registry: InMemoryRegistryStore;
  eventBus?: EventBus;
  artifacts?: InMemoryArtifactStore;
}

interface RouteHarnessOptions {
  withArtifacts?: boolean;
  withLauncher?: boolean;
  withEventBus?: boolean;
}

function createRouteHarness(options: RouteHarnessOptions = {}): RouteHarness {
  const runs = new InMemoryRunStore();
  const events = new InMemoryEventStore();
  const sessions = new InMemorySessionStore();
  const registry = new InMemoryRegistryStore();
  const eventBus = options.withEventBus ? new EventBus() : undefined;
  const artifacts = options.withArtifacts ? new InMemoryArtifactStore() : undefined;
  const adapters = new Map([["fake", new FakeRuntimeAdapter()]]);
  const runner = new RuntimeRunnerService({
    runs,
    events,
    sessions,
    adapters,
    ...(eventBus ? { eventBus } : {}),
    ...(artifacts ? { artifacts } : {})
  });
  const runService = new RunService({ runs, events, runner });
  const withLauncher = options.withLauncher !== false;
  const launcher = withLauncher ? new RunLauncherService(runService) : undefined;
  const app = Fastify();
  seedRuntimeMode(registry, {
    id: "runtime_mode_fake_deterministic",
    slug: "fake.deterministic",
    name: "Fake deterministic runtime",
    providerId: "provider_test",
    runtimeId: "runtime_fake",
    adapterId: "fake",
    adapterType: "process",
    kind: "deterministic_fake",
    status: "available",
    capabilities: ["run.start", "run.cancel", "event.normalized", "artifact.transcript", "tool.fake_echo", "auth.none"],
    limitations: [{ code: "deterministic_only", message: "Outputs are fixed for local smoke and contract tests." }],
    placement: {
      local: { support: "supported", reason: "In-process deterministic test adapter." },
      hosted: { support: "unsupported", reason: "Hosted worker execution is not shipped in R3." },
      connectedLocalNode: { support: "future", reason: "Hybrid node execution is planned for R10." }
    },
    availability: {
      state: "available",
      canRun: true,
      installed: true,
      auth: "not_required",
      version: null,
      checkedAt: "2026-05-29T00:00:00.000Z",
      reasonCode: null,
      message: null
    },
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z"
  });
  seedRuntimeMode(registry, {
    id: "runtime_mode_generic_http_async_rest",
    slug: "generic_http.async_rest",
    name: "Generic HTTP async REST",
    providerId: "provider_generic_http",
    runtimeId: "runtime_generic_http",
    adapterId: "generic_http",
    adapterType: "http",
    kind: "async_rest",
    status: "unknown",
    capabilities: ["run.start", "run.cancel", "run.timeout", "event.normalized", "event.streaming", "artifact.transcript", "auth.none", "auth.api_key"],
    limitations: [{ code: "no_post_start_input", message: "generic_http.async_rest does not support post-start input in R4." }],
    placement: {
      local: { support: "conditional", reason: "Configured endpoint required." },
      hosted: { support: "future", reason: "Not hosted." },
      connectedLocalNode: { support: "future", reason: "Future." }
    },
    availability: {
      state: "unknown",
      canRun: false,
      installed: false,
      auth: "unknown",
      version: null,
      checkedAt: "2026-05-29T00:00:00.000Z",
      reasonCode: "generic_http_config_missing",
      message: "missing"
    },
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z"
  });
  seedRuntimeMode(registry, {
    id: "runtime_mode_agentfield_async_rest",
    slug: "agentfield.async_rest",
    name: "AgentField async REST",
    providerId: "provider_agentfield",
    runtimeId: "runtime_agentfield",
    adapterId: "agentfield",
    adapterType: "http",
    kind: "async_rest",
    status: "unknown",
    capabilities: ["run.start", "run.timeout", "event.normalized", "event.streaming", "artifact.transcript", "auth.api_key"],
    limitations: [{ code: "cancel_unsupported", message: "AgentField upstream cancellation is not claimed in R6." }],
    placement: {
      local: { support: "conditional", reason: "Configured endpoint required." },
      hosted: { support: "future", reason: "Not hosted." },
      connectedLocalNode: { support: "future", reason: "Future." }
    },
    availability: {
      state: "unknown",
      canRun: false,
      installed: false,
      auth: "missing",
      version: null,
      checkedAt: "2026-05-30T00:00:00.000Z",
      reasonCode: "agentfield_config_missing",
      message: "missing"
    },
    createdAt: "2026-05-30T00:00:00.000Z",
    updatedAt: "2026-05-30T00:00:00.000Z"
  });
  seedRuntimeMode(registry, {
    id: "runtime_mode_codex_exec_json",
    slug: "codex.exec_json",
    name: "Codex exec JSON",
    providerId: "provider_openai",
    runtimeId: "runtime_codex",
    adapterId: "codex",
    adapterType: "process",
    kind: "one_shot_process",
    status: "available",
    capabilities: ["run.start", "run.cancel", "model.catalog", "auth.local"],
    limitations: [{ code: "one_shot_no_input", message: "codex.exec_json does not support post-start input." }],
    placement: {
      local: { support: "supported", reason: "Local only." },
      hosted: { support: "unsupported", reason: "Not hosted." },
      connectedLocalNode: { support: "future", reason: "Future." }
    },
    availability: {
      state: "available",
      canRun: true,
      installed: true,
      auth: "configured",
      version: "codex 0.130.0",
      checkedAt: "2026-05-29T00:00:00.000Z",
      reasonCode: null,
      message: null
    },
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z"
  });
  const registryService = new RegistryService({ registry });
  registerRunRoutes(app, {
    runService,
    runs,
    events,
    ...(artifacts ? { artifacts } : {}),
    ...(eventBus ? { eventBus } : {}),
    ...(launcher ? { launcher } : {}),
    registry,
    registryService
  });

  return {
    app,
    runService,
    runs,
    events,
    sessions,
    registry,
    ...(eventBus ? { eventBus } : {}),
    ...(artifacts ? { artifacts } : {})
  };
}

function fakeRunPayload(task: string): {
  runtime: string;
  provider: string;
  model: string;
  adapterType: "process";
  cwd: string;
  task: string;
} {
  return {
    runtime: "fake",
    provider: "test",
    model: "test-model",
    adapterType: "process",
    cwd: "/repo",
    task
  };
}

class InMemoryArtifactStore implements ArtifactStore {
  readonly items: Artifact[] = [];

  async create(artifact: Artifact): Promise<Artifact> {
    this.items.push(artifact);
    return artifact;
  }

  async get(id: string): Promise<Artifact | undefined> {
    return this.items.find((artifact) => artifact.id === id);
  }

  async update(artifact: Artifact): Promise<Artifact> {
    const index = this.items.findIndex((entry) => entry.id === artifact.id);
    if (index < 0) {
      this.items.push(artifact);
      return artifact;
    }
    this.items[index] = artifact;
    return artifact;
  }

  async listByRun(runId: string): Promise<Artifact[]> {
    return this.items.filter((artifact) => artifact.runId === runId);
  }
}

function seedRuntimeMode(registry: InMemoryRegistryStore, mode: {
  id: string;
  slug: string;
  name: string;
  providerId: string;
  runtimeId: string;
  adapterId: string;
  adapterType: "process" | "http";
  kind: "deterministic_fake" | "one_shot_process" | "async_rest";
  status: "available" | "unknown";
  capabilities: string[];
  limitations: Array<{ code: string; message: string }>;
  placement: {
    local: { support: "supported" | "conditional"; reason: string };
    hosted: { support: "unsupported" | "future"; reason: string };
    connectedLocalNode: { support: "future"; reason: string };
  };
  availability: {
    state: "available" | "unknown";
    canRun: boolean;
    installed: boolean;
    auth: "not_required" | "configured" | "missing" | "unknown";
    version: string | null;
    checkedAt: string;
    reasonCode: string | null;
    message: string | null;
  };
  createdAt: string;
  updatedAt: string;
}): void {
  registry.runtimeModes.set(mode.id, mode as never);
  registry.runtimeModesBySlug.set(mode.slug, mode.id);
}
