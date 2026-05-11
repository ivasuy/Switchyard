import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { RunService, RuntimeRunnerService } from "@switchyard/core";
import { FakeRuntimeAdapter, InMemoryEventStore, InMemoryRunStore, InMemorySessionStore } from "@switchyard/testkit";
import { registerRunRoutes } from "../src/index.js";

describe("run routes", () => {
  it("creates, starts, and returns a fake runtime run", async () => {
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const sessions = new InMemorySessionStore();
    const adapters = new Map([["fake", new FakeRuntimeAdapter()]]);
    const runner = new RuntimeRunnerService({ runs, events, sessions, adapters });
    const service = new RunService({
      runs,
      events,
      runner
    });
    const app = Fastify();
    registerRunRoutes(app, { runs, events, runService: service });

    const createResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        runtime: "fake",
        provider: "test",
        model: "test-model",
        adapterType: "process",
        cwd: "/repo",
        task: "Test task"
      }
    });

    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json();
    expect(created.run.status).toBe("completed");
    expect(created.run.id).toMatch(/^run_/);

    const getResponse = await app.inject({
      method: "GET",
      url: `/runs/${created.run.id}`
    });

    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json().run.status).toBe("completed");
  });

  it("returns run events as an SSE-compatible stream", async () => {
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const sessions = new InMemorySessionStore();
    const adapters = new Map([["fake", new FakeRuntimeAdapter()]]);
    const runner = new RuntimeRunnerService({ runs, events, sessions, adapters });
    const service = new RunService({
      runs,
      events,
      runner
    });
    const app = Fastify();
    registerRunRoutes(app, { runs, events, runService: service });

    const createResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        runtime: "fake",
        provider: "test",
        model: "test-model",
        adapterType: "process",
        cwd: "/repo",
        task: "Stream test run"
      }
    });
    const runId = createResponse.json().run.id;

    const streamResponse = await app.inject({
      method: "GET",
      url: `/runs/${runId}/events`
    });

    expect(streamResponse.statusCode).toBe(200);
    expect(streamResponse.headers["content-type"]).toContain("text/event-stream");
    expect(streamResponse.body).toContain("event: runtime.output");
    expect(streamResponse.body).toContain("fake runtime output");
  });

  it("sends input and cancels a run", async () => {
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const sessions = new InMemorySessionStore();
    const adapters = new Map([["fake", new FakeRuntimeAdapter()]]);
    const runner = new RuntimeRunnerService({ runs, events, sessions, adapters });
    const service = new RunService({
      runs,
      events,
      runner
    });
    const app = Fastify();
    registerRunRoutes(app, { runs, events, runService: service });
    const createResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        runtime: "fake",
        provider: "test",
        model: "test-model",
        adapterType: "process",
        cwd: "/repo",
        task: "Lifecycle test run"
      }
    });
    const runId = createResponse.json().run.id;

    const inputResponse = await app.inject({
      method: "POST",
      url: `/runs/${runId}/input`,
      payload: { text: "continue" }
    });
    const cancelResponse = await app.inject({
      method: "POST",
      url: `/runs/${runId}/cancel`
    });

    expect(inputResponse.statusCode).toBe(202);
    expect(cancelResponse.statusCode).toBe(200);
    expect(cancelResponse.json().run.status).toBe("cancelled");
  });
});
