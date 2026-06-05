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

  it("advertises Generic HTTP bridge capabilities only for bridge-ready scenarios", async () => {
    const readyServer = await startFakeHttpRuntimeServer({ scenario: "bridge_happy" });
    const missingServer = await startFakeHttpRuntimeServer({ scenario: "bridge_capability_missing" });
    try {
      const ready = await (await fetch(readyServer.url("/health"))).json() as { capabilities: string[] };
      expect(ready.capabilities).toEqual(expect.arrayContaining(["input", "approval_request", "approval_resolution"]));

      const missing = await (await fetch(missingServer.url("/health"))).json() as { capabilities: string[] };
      expect(missing.capabilities).not.toContain("input");
      expect(missing.capabilities).not.toContain("approval_request");
      expect(missing.capabilities).not.toContain("approval_resolution");
      expect(readyServer.stats().healthRequests).toBe(1);
      expect(missingServer.stats().healthRequests).toBe(1);
    } finally {
      await readyServer.close();
      await missingServer.close();
    }
  });

  it("records bridge input and approval resolution dispatch stats", async () => {
    const server = await startFakeHttpRuntimeServer({ scenario: "bridge_happy" });
    try {
      const started = await (await fetch(server.url("/v1/runs"), { method: "POST" })).json() as { externalRunId: string };

      const input = await fetch(server.url(`/v1/runs/${started.externalRunId}/input`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          switchyardRunId: "run_bridge",
          bridgeCommandId: "cmd_input",
          idempotencyKey: "idem_input",
          type: "input",
          text: "continue"
        })
      });
      expect(input.status).toBe(200);

      const approval = await fetch(server.url(`/v1/runs/${started.externalRunId}/approvals/token_1/resolve`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          switchyardRunId: "run_bridge",
          bridgeCommandId: "cmd_approval",
          idempotencyKey: "idem_approval",
          decision: "approved",
          message: "ok",
          answers: { selectedOption: "allow" }
        })
      });
      expect(approval.status).toBe(200);

      expect(server.stats()).toMatchObject({
        startRequests: 1,
        inputRequests: 1,
        approvalResolutionRequests: 1,
        lastInputBody: {
          bridgeCommandId: "cmd_input",
          type: "input",
          text: "continue"
        },
        lastApprovalResolutionToken: "token_1",
        lastApprovalResolutionBody: {
          bridgeCommandId: "cmd_approval",
          decision: "approved",
          answers: { selectedOption: "allow" }
        }
      });
    } finally {
      await server.close();
    }
  });

  it("serves bridge approval and waiting event scenarios", async () => {
    const approvalServer = await startFakeHttpRuntimeServer({ scenario: "approval_request" });
    const duplicateServer = await startFakeHttpRuntimeServer({ scenario: "duplicate_approval_events" });
    const waitingServer = await startFakeHttpRuntimeServer({ scenario: "waiting_for_input_event" });
    try {
      const approvalRun = await (await fetch(approvalServer.url("/v1/runs"), { method: "POST" })).json() as { externalRunId: string };
      const approvalEvents = await (await fetch(approvalServer.url(`/v1/runs/${approvalRun.externalRunId}/events`))).json() as {
        events: Array<Record<string, unknown>>;
      };
      expect(approvalEvents.events[0]).toMatchObject({
        type: "approval.requested",
        runtimeApprovalToken: "approval_token_1"
      });

      const duplicateRun = await (await fetch(duplicateServer.url("/v1/runs"), { method: "POST" })).json() as { externalRunId: string };
      const duplicateEvents = await (await fetch(duplicateServer.url(`/v1/runs/${duplicateRun.externalRunId}/events`))).json() as {
        events: Array<Record<string, unknown>>;
      };
      expect(duplicateEvents.events.filter((event) => event.id === "evt_approval_dup")).toHaveLength(2);

      const waitingRun = await (await fetch(waitingServer.url("/v1/runs"), { method: "POST" })).json() as { externalRunId: string };
      const waitingEvents = await (await fetch(waitingServer.url(`/v1/runs/${waitingRun.externalRunId}/events`))).json() as {
        events: Array<Record<string, unknown>>;
      };
      expect(waitingEvents.events[0]).toMatchObject({
        type: "runtime.status",
        status: "waiting_for_input"
      });
    } finally {
      await approvalServer.close();
      await duplicateServer.close();
      await waitingServer.close();
    }
  });
});
