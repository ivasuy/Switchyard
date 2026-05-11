import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  type ArtifactStore,
  EventBus,
  RunLauncherService,
  RunService,
  RuntimeRunnerService
} from "@switchyard/core";
import type { Artifact } from "@switchyard/contracts";
import { FakeRuntimeAdapter, InMemoryEventStore, InMemoryRunStore, InMemorySessionStore } from "@switchyard/testkit";
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

    const getResponse = await harness.app.inject({
      method: "GET",
      url: `/runs/${created.run.id}`
    });

    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json().run.status).toBe("completed");
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

  it("treats invalid stopAfter as replay-length fallback", async () => {
    const harness = createRouteHarness({ withEventBus: true });

    const createResponse = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=1",
      payload: fakeRunPayload("Invalid stopAfter run")
    });
    const runId = createResponse.json().run.id;

    const streamResponse = await harness.app.inject({
      method: "GET",
      url: `/runs/${runId}/events?live=1&stopAfter=not-a-number`
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

    expect(inputResponse.statusCode).toBe(202);
    expect(cancelResponse.statusCode).toBe(200);
    expect(cancelResponse.json().run.status).toBe("cancelled");
  });
});

interface RouteHarness {
  app: FastifyInstance;
  runService: RunService;
  runs: InMemoryRunStore;
  events: InMemoryEventStore;
  sessions: InMemorySessionStore;
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
  registerRunRoutes(app, {
    runService,
    runs,
    events,
    ...(artifacts ? { artifacts } : {}),
    ...(eventBus ? { eventBus } : {}),
    ...(launcher ? { launcher } : {})
  });

  return {
    app,
    runService,
    runs,
    events,
    sessions,
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
