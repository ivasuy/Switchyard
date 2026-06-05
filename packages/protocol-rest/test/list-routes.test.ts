import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import {
  EventBus,
  RunLauncherService,
  RunService,
  RuntimeRunnerService
} from "@switchyard/core";
import {
  FakeRuntimeAdapter,
  InMemoryArtifactStore,
  InMemoryEventStore,
  InMemoryRegistryStore,
  InMemoryRunStore,
  InMemorySessionStore
} from "@switchyard/testkit";
import {
  registerErrorEnvelope,
  registerRegistryRoutes,
  registerRunRoutes
} from "../src/index.js";

async function createHarness(): Promise<{
  app: FastifyInstance;
  registry: InMemoryRegistryStore;
  runs: InMemoryRunStore;
  createFakeRun(label: string): Promise<string>;
}> {
  const runs = new InMemoryRunStore();
  const events = new InMemoryEventStore();
  const sessions = new InMemorySessionStore();
  const registry = new InMemoryRegistryStore();
  const artifacts = new InMemoryArtifactStore();
  const eventBus = new EventBus();
  const adapters = new Map([["fake", new FakeRuntimeAdapter()]]);
  const runner = new RuntimeRunnerService({
    runs,
    events,
    sessions,
    adapters,
    eventBus,
    artifacts
  });
  const runService = new RunService({ runs, events, runner });
  const launcher = new RunLauncherService(runService);
  const app = Fastify();
  registerErrorEnvelope(app);
  registerRunRoutes(app, { runService, runs, events, artifacts, eventBus, launcher, registry });
  registerRegistryRoutes(app, { registry });

  return {
    app,
    registry,
    runs,
    async createFakeRun(label: string): Promise<string> {
      const response = await app.inject({
        method: "POST",
        url: "/runs?wait=1",
        payload: {
          runtime: "fake",
          provider: "test",
          model: "test-model",
          adapterType: "process",
          cwd: "/repo",
          task: label
        }
      });
      if (response.statusCode !== 201) {
        throw new Error(`createFakeRun failed: ${response.statusCode} ${response.body}`);
      }
      return response.json().run.id as string;
    }
  };
}

describe("GET /runs", () => {
  it("returns runs newest first with pagination cursor", async () => {
    const harness = await createHarness();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(await harness.createFakeRun(`run-${i}`));
    }
    const response = await harness.app.inject({ method: "GET", url: "/runs?limit=2" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.runs.length).toBe(2);
    expect(typeof body.nextCursor).toBe("string");
    const second = await harness.app.inject({
      method: "GET",
      url: `/runs?limit=2&before=${encodeURIComponent(body.nextCursor)}`
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().runs.length).toBeGreaterThan(0);
    expect(second.json().nextCursor).toBeNull();
  });

  it("filters by status, runtime, and time bounds", async () => {
    const harness = await createHarness();
    await harness.createFakeRun("filtered run");
    const matching = await harness.app.inject({
      method: "GET",
      url: "/runs?status=completed&runtime=fake"
    });
    expect(matching.statusCode).toBe(200);
    expect(matching.json().runs.length).toBeGreaterThan(0);
    expect(matching.json().runs[0].runtime).toBe("fake");

    const empty = await harness.app.inject({
      method: "GET",
      url: "/runs?status=running"
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ runs: [], nextCursor: null });
  });

  it("returns 400 invalid_query for unknown status", async () => {
    const harness = await createHarness();
    const response = await harness.app.inject({ method: "GET", url: "/runs?status=banana" });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe("invalid_query");
    expect(body.error.details?.[0]?.path).toBe("status");
  });

  it("returns 400 invalid_query when since is greater than until", async () => {
    const harness = await createHarness();
    const response = await harness.app.inject({
      method: "GET",
      url: "/runs?since=2026-12-01T00:00:00.000Z&until=2026-01-01T00:00:00.000Z"
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_query");
  });

  it("returns 400 invalid_query for limit greater than the max", async () => {
    const harness = await createHarness();
    const response = await harness.app.inject({ method: "GET", url: "/runs?limit=1000" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_query");
  });

  it("returns 400 invalid_query for malformed cursor", async () => {
    const harness = await createHarness();
    const response = await harness.app.inject({ method: "GET", url: "/runs?before=not-a-cursor" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_query");
  });
});

describe("registry list routes", () => {
  async function seedRegistry() {
    const harness = await createHarness();
    await harness.registry.createProvider({
      id: "provider_openai",
      name: "OpenAI",
      authMode: "local",
      status: "available"
    });
    await harness.registry.createProvider({
      id: "provider_test",
      name: "Test",
      authMode: "none",
      status: "available"
    });
    await harness.registry.createRuntime({
      id: "runtime_codex",
      name: "Codex",
      adapterType: "process",
      status: "available",
      providerId: "provider_openai"
    });
    await harness.registry.createRuntime({
      id: "runtime_fake",
      name: "Fake",
      adapterType: "process",
      status: "available"
    });
    await harness.registry.createModel({
      id: "model_gpt_5_5",
      providerId: "provider_openai",
      modelName: "gpt-5.5",
      supportsTools: true,
      supportsStreaming: true,
      supportsBrowser: false,
      status: "available"
    });
    await harness.registry.createModel({
      id: "model_test",
      providerId: "provider_test",
      modelName: "test-model",
      supportsTools: false,
      supportsStreaming: true,
      supportsBrowser: false,
      status: "available"
    });
    return harness;
  }

  it("lists providers", async () => {
    const harness = await seedRegistry();
    const response = await harness.app.inject({ method: "GET", url: "/providers" });
    expect(response.statusCode).toBe(200);
    expect(response.json().providers.length).toBe(2);
    expect(response.json().nextCursor).toBeNull();
  });

  it("filters runtimes by provider slug", async () => {
    const harness = await seedRegistry();
    const response = await harness.app.inject({ method: "GET", url: "/runtimes?provider=openai" });
    expect(response.statusCode).toBe(200);
    const runtimes = response.json().runtimes as Array<{ id: string }>;
    expect(runtimes.map((runtime) => runtime.id)).toEqual(["runtime_codex"]);
  });

  it("returns empty list for unknown provider slug", async () => {
    const harness = await seedRegistry();
    const response = await harness.app.inject({ method: "GET", url: "/models?provider=nonexistent" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ models: [], nextCursor: null });
  });

  it("respects limit + cursor round-trip", async () => {
    const harness = await seedRegistry();
    const first = await harness.app.inject({ method: "GET", url: "/models?limit=1" });
    expect(first.statusCode).toBe(200);
    expect(first.json().models.length).toBe(1);
    const cursor = first.json().nextCursor as string;
    expect(typeof cursor).toBe("string");
    const second = await harness.app.inject({
      method: "GET",
      url: `/models?limit=1&before=${encodeURIComponent(cursor)}`
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().models.length).toBe(1);
    expect(second.json().models[0].id).not.toBe(first.json().models[0].id);
  });

  it("returns 400 invalid_query for malformed cursor on providers", async () => {
    const harness = await seedRegistry();
    const response = await harness.app.inject({ method: "GET", url: "/providers?before=garbage" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_query");
  });
});
