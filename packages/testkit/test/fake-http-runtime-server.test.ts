import { describe, expect, it } from "vitest";
import { startFakeHttpRuntimeServer } from "../src/index.js";

describe("fake http runtime server", () => {
  it("starts on loopback and serves happy lifecycle endpoints", async () => {
    const server = await startFakeHttpRuntimeServer({ scenario: "happy" });
    try {
      const health = await fetch(server.url("/health"));
      expect(health.status).toBe(200);

      const start = await fetch(server.url("/v1/runs"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "test" })
      });
      expect(start.status).toBe(200);
      const started = await start.json() as { externalRunId: string };
      expect(started.externalRunId.length).toBeGreaterThan(0);

      const events = await fetch(server.url(`/v1/runs/${started.externalRunId}/events`));
      const eventJson = await events.json() as { events: Array<{ type: string }> };
      expect(eventJson.events.some((event) => event.type === "run.completed")).toBe(true);

      const artifacts = await fetch(server.url(`/v1/runs/${started.externalRunId}/artifacts`));
      const artifactJson = await artifacts.json() as { artifacts: Array<{ content: string }> };
      expect(artifactJson.artifacts[0]?.content).toContain("generic-http transcript line");
    } finally {
      await server.close();
    }
  });

  it("enforces expected bearer auth token", async () => {
    const server = await startFakeHttpRuntimeServer({
      scenario: "happy",
      expectedAuthToken: "token-1"
    });
    try {
      const unauthorized = await fetch(server.url("/health"));
      expect(unauthorized.status).toBe(401);

      const authorized = await fetch(server.url("/health"), {
        headers: {
          authorization: "Bearer token-1"
        }
      });
      expect(authorized.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("supports deterministic oversized endpoint scenarios", async () => {
    const healthServer = await startFakeHttpRuntimeServer({ scenario: "oversized_health_response" });
    const startServer = await startFakeHttpRuntimeServer({ scenario: "oversized_start_response" });
    const statusServer = await startFakeHttpRuntimeServer({ scenario: "oversized_status_response" });
    const eventsServer = await startFakeHttpRuntimeServer({ scenario: "oversized_events_response" });
    const cancelServer = await startFakeHttpRuntimeServer({ scenario: "oversized_cancel_response" });
    const artifactsServer = await startFakeHttpRuntimeServer({ scenario: "oversized_artifacts_response" });
    try {
      const health = await (await fetch(healthServer.url("/health"))).json() as { payload: string };
      expect(health.payload.length).toBeGreaterThan(2000);

      const start = await fetch(startServer.url("/v1/runs"), { method: "POST" });
      const startJson = await start.json() as { payload: string };
      expect(startJson.payload.length).toBeGreaterThan(2000);

      const started = await (await fetch(statusServer.url("/v1/runs"), { method: "POST" })).json() as { externalRunId: string };
      const status = await (await fetch(statusServer.url(`/v1/runs/${started.externalRunId}`))).json() as { payload: string };
      expect(status.payload.length).toBeGreaterThan(2000);

      const startedEvents = await (await fetch(eventsServer.url("/v1/runs"), { method: "POST" })).json() as { externalRunId: string };
      const events = await (await fetch(eventsServer.url(`/v1/runs/${startedEvents.externalRunId}/events`))).json() as { payload: string };
      expect(events.payload.length).toBeGreaterThan(2000);

      const startedCancel = await (await fetch(cancelServer.url("/v1/runs"), { method: "POST" })).json() as { externalRunId: string };
      const cancel = await (await fetch(cancelServer.url(`/v1/runs/${startedCancel.externalRunId}/cancel`), { method: "POST" })).json() as { payload: string };
      expect(cancel.payload.length).toBeGreaterThan(2000);

      const startedArtifacts = await (await fetch(artifactsServer.url("/v1/runs"), { method: "POST" })).json() as { externalRunId: string };
      const artifacts = await (await fetch(artifactsServer.url(`/v1/runs/${startedArtifacts.externalRunId}/artifacts`))).json() as {
        artifacts: Array<{ payload: string }>;
      };
      expect(artifacts.artifacts[0]?.payload.length).toBeGreaterThan(2000);
    } finally {
      await healthServer.close();
      await startServer.close();
      await statusServer.close();
      await eventsServer.close();
      await cancelServer.close();
      await artifactsServer.close();
    }
  });
});
