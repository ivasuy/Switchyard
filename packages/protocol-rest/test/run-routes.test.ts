import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import {
  type ArtifactStore,
  RunLauncherService,
  RunService,
  RuntimeRunnerService
} from "@switchyard/core";
import type { Artifact } from "@switchyard/contracts";
import { FakeRuntimeAdapter, InMemoryEventStore, InMemoryRunStore, InMemorySessionStore } from "@switchyard/testkit";
import { registerRunRoutes } from "../src/index.js";

describe("run routes", () => {
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
  runs: InMemoryRunStore;
  events: InMemoryEventStore;
  sessions: InMemorySessionStore;
  artifacts?: InMemoryArtifactStore;
}

interface RouteHarnessOptions {
  withArtifacts?: boolean;
}

function createRouteHarness(options: RouteHarnessOptions = {}): RouteHarness {
  const runs = new InMemoryRunStore();
  const events = new InMemoryEventStore();
  const sessions = new InMemorySessionStore();
  const artifacts = options.withArtifacts ? new InMemoryArtifactStore() : undefined;
  const adapters = new Map([["fake", new FakeRuntimeAdapter()]]);
  const runner = new RuntimeRunnerService({
    runs,
    events,
    sessions,
    adapters,
    ...(artifacts ? { artifacts } : {})
  });
  const runService = new RunService({ runs, events, runner });
  const launcher = new RunLauncherService(runService);
  const app = Fastify();
  registerRunRoutes(app, {
    runService,
    runs,
    events,
    ...(artifacts ? { artifacts } : {}),
    launcher
  });

  return { app, runs, events, sessions, ...(artifacts ? { artifacts } : {}) };
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
