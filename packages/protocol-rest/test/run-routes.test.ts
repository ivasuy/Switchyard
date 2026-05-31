import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  AdapterProtocolError,
  ControlPlaneError,
  type ArtifactStore,
  EventBus,
  RegistryService,
  RunLauncherService,
  RunService,
  RuntimeRunnerService
} from "@switchyard/core";
import type { Artifact } from "@switchyard/contracts";
import { FakeRuntimeAdapter, InMemoryEventStore, InMemoryRegistryStore, InMemoryRunStore, InMemorySessionStore } from "@switchyard/testkit";
import { registerHostedAuthHooks, registerRunRoutes } from "../src/index.js";

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
    expect(inputResponse.json()).toMatchObject({
      error: {
        code: "adapter_protocol_failed",
        message: "Codex exec-json does not support input after start",
        details: [{ path: "reasonCode", issue: "codex_input_unsupported" }],
        requestId: expect.any(String)
      }
    });
  });

  it("rejects queued hosted real input without dispatching runService.sendInput", async () => {
    const harness = createRouteHarness();
    await harness.runs.create({
      id: "run_hosted_real_input_queued",
      runtime: "codex",
      provider: "openai",
      model: "gpt-5",
      adapterType: "process",
      cwd: "/repo",
      task: "queued hosted real",
      status: "queued",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "codex.exec_json",
      createdAt: "2026-05-30T00:00:00.000Z"
    });
    const sendSpy = vi.spyOn(harness.runService, "sendInput");

    const response = await harness.app.inject({
      method: "POST",
      url: "/runs/run_hosted_real_input_queued/input",
      payload: { text: "continue" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("adapter_protocol_failed");
    expect(response.json().error.details).toEqual([{ path: "reasonCode", issue: "hosted_input_unsupported" }]);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("rejects active hosted real cancel without provider cancel claim", async () => {
    const harness = createRouteHarness();
    await harness.runs.create({
      id: "run_hosted_real_cancel_active",
      runtime: "codex",
      provider: "openai",
      model: "gpt-5",
      adapterType: "process",
      cwd: "/repo",
      task: "active hosted real",
      status: "running",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "codex.exec_json",
      createdAt: "2026-05-30T00:00:00.000Z"
    });
    const cancelSpy = vi.spyOn(harness.runService, "cancelRun");

    const response = await harness.app.inject({
      method: "POST",
      url: "/runs/run_hosted_real_cancel_active/cancel"
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("adapter_protocol_failed");
    expect(response.json().error.details).toEqual([{ path: "reasonCode", issue: "hosted_cancel_unsupported" }]);
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it("returns terminal hosted real run on cancel without invoking cancel bridge", async () => {
    const harness = createRouteHarness();
    await harness.runs.create({
      id: "run_hosted_real_cancel_terminal",
      runtime: "codex",
      provider: "openai",
      model: "gpt-5",
      adapterType: "process",
      cwd: "/repo",
      task: "terminal hosted real",
      status: "completed",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "codex.exec_json",
      createdAt: "2026-05-30T00:00:00.000Z",
      endedAt: "2026-05-30T00:00:02.000Z"
    });
    const cancelSpy = vi.spyOn(harness.runService, "cancelRun");

    const response = await harness.app.inject({
      method: "POST",
      url: "/runs/run_hosted_real_cancel_terminal/cancel"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().run.status).toBe("completed");
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it("rejects invalid run input payload shapes and size before adapter dispatch", async () => {
    const harness = createRouteHarness();
    const created = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=1",
      payload: fakeRunPayload("Input validation run")
    });
    const runId = created.json().run.id as string;
    const sendSpy = vi.spyOn(harness.runService, "sendInput");

    const invalidBodies = [
      "not-an-object",
      [],
      {},
      { text: 123 },
      { text: "   " },
      { text: "x".repeat(65537) }
    ];
    for (const body of invalidBodies) {
      const response = await harness.app.inject({
        method: "POST",
        url: `/runs/${runId}/input`,
        headers: { "content-type": "application/json" },
        payload: body
      });
      expect(response.statusCode).toBe(400);
    }

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("infers claude_code runtime mode when omitted", async () => {
    const harness = createRouteHarness();

    const response = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=0",
      payload: {
        runtime: "claude_code",
        provider: "anthropic",
        model: "claude-code-default",
        adapterType: "native",
        cwd: "/repo",
        task: "infer claude mode"
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().run.runtimeMode).toBe("claude_code.sdk");
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

  it("rejects wait=1 for explicit codex.interactive before create side effects", async () => {
    const harness = createRouteHarness({ withLauncher: false });
    const createSpy = vi.spyOn(harness.runService, "createRun");

    const response = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=1",
      payload: {
        runtime: "codex",
        provider: "openai",
        model: "gpt-5.5",
        adapterType: "process",
        runtimeMode: "codex.interactive",
        cwd: "/repo",
        task: "interactive wait"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.details).toEqual([{ path: "wait", issue: "interactive_wait_unsupported" }]);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("maps in-flight input conflicts to 409 adapter_protocol_failed", async () => {
    const harness = createRouteHarness();
    const created = await harness.app.inject({
      method: "POST",
      url: "/runs?wait=1",
      payload: fakeRunPayload("Input race run")
    });
    const runId = created.json().run.id as string;
    vi.spyOn(harness.runService, "sendInput").mockRejectedValueOnce(new AdapterProtocolError("input race", {
      reasonCode: "runtime_input_in_flight"
    }));

    const response = await harness.app.inject({
      method: "POST",
      url: `/runs/${runId}/input`,
      payload: { text: "continue" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.details).toEqual([{ path: "reasonCode", issue: "runtime_input_in_flight" }]);
  });

  it("rejects hosted create for codex.interactive local-only mode", async () => {
    const harness = createRouteHarness({ withLauncher: false });
    const createSpy = vi.spyOn(harness.runService, "createRun");

    const response = await harness.app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        runtime: "codex",
        provider: "openai",
        model: "gpt-5.5",
        adapterType: "process",
        runtimeMode: "codex.interactive",
        placement: "hosted",
        cwd: "/repo",
        task: "hosted interactive"
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("placement_denied");
    expect(response.json().error.details).toEqual([{ path: "placement", issue: "hosted_runtime_not_allowed" }]);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("cancels local codex.interactive runs across active and waiting states", async () => {
    const harness = createRouteHarness();
    const cancelSpy = vi.spyOn(harness.runService, "cancelRun");
    const statuses = ["running", "waiting_for_input", "waiting_for_approval"] as const;

    for (const status of statuses) {
      const runId = `run_codex_interactive_cancel_${status}`;
      await harness.runs.create({
        id: runId,
        runtime: "fake",
        provider: "test",
        model: "test-model",
        adapterType: "process",
        cwd: "/repo",
        task: `cancel ${status}`,
        status,
        placement: "local",
        approvalPolicy: "default",
        timeoutSeconds: 60,
        metadata: {},
        runtimeMode: "codex.interactive",
        createdAt: "2026-05-30T00:00:00.000Z"
      });
      await harness.sessions.create({
        id: `session_codex_interactive_cancel_${status}`,
        runId,
        runtime: "fake",
        provider: "test",
        model: "test-model",
        protocol: "process",
        status: "active",
        runtimeMode: "codex.interactive",
        state: {},
        createdAt: "2026-05-30T00:00:00.000Z"
      });

      const response = await harness.app.inject({
        method: "POST",
        url: `/runs/${runId}/cancel`
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().run.status).toBe("cancelled");
    }

    expect(cancelSpy).toHaveBeenCalledTimes(statuses.length);
  });

  it("returns terminal local codex.interactive run unchanged on cancel", async () => {
    const harness = createRouteHarness();
    const runId = "run_codex_interactive_terminal_cancel";
    await harness.runs.create({
      id: runId,
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "terminal cancel",
      status: "completed",
      placement: "local",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "codex.interactive",
      createdAt: "2026-05-30T00:00:00.000Z",
      endedAt: "2026-05-30T00:01:00.000Z"
    });

    const response = await harness.app.inject({
      method: "POST",
      url: `/runs/${runId}/cancel`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().run.status).toBe("completed");
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
  controlPlane?: unknown;
  hostedRuns?: unknown;
  placements?: unknown;
  listAssignmentsByRun?: (runId: string) => Promise<readonly { id: string }[]>;
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
  seedRuntimeMode(registry, {
    id: "runtime_mode_codex_interactive",
    slug: "codex.interactive",
    name: "Codex interactive",
    providerId: "provider_openai",
    runtimeId: "runtime_codex",
    adapterId: "codex",
    adapterType: "process",
    kind: "interactive_process",
    status: "partial",
    capabilities: ["run.start", "run.input", "run.cancel", "session.state", "session.resume", "event.streaming", "artifact.transcript", "auth.local"],
    limitations: [{ code: "local_only", message: "codex.interactive is local-only in R16." }],
    placement: {
      local: { support: "conditional", reason: "Local Codex command shape required." },
      hosted: { support: "unsupported", reason: "No hosted interactive bridge." },
      connectedLocalNode: { support: "future", reason: "Future." }
    },
    availability: {
      state: "partial",
      canRun: true,
      installed: true,
      auth: "configured",
      version: "codex 0.134.0",
      checkedAt: "2026-05-30T00:00:00.000Z",
      reasonCode: "codex_approval_bridge_unsupported",
      message: "approval bridge unsupported"
    },
    createdAt: "2026-05-30T00:00:00.000Z",
    updatedAt: "2026-05-30T00:00:00.000Z"
  });
  const registryService = new RegistryService({ registry });
  registerRunRoutes(app, {
    runService,
    runs,
    events,
    ...(artifacts ? { artifacts } : {}),
    ...(eventBus ? { eventBus } : {}),
    ...(launcher ? { launcher } : {}),
    ...(options.controlPlane ? { controlPlane: options.controlPlane as never } : {}),
    ...(options.hostedRuns ? { hostedRuns: options.hostedRuns as never } : {}),
    ...(options.placements ? { placements: options.placements as never } : {}),
    ...(options.listAssignmentsByRun ? { listAssignmentsByRun: options.listAssignmentsByRun } : {}),
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

  async listByDebate(debateId: string): Promise<Artifact[]> {
    return this.items.filter((artifact) => artifact.debateId === debateId);
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

describe("run routes hosted auth", () => {
  it("denies large unauthenticated create before parser and run service side effects", async () => {
    const harness = createRouteHarness();
    const runCreateSpy = vi.spyOn(harness.runService, "createRun");
    const preParsingSpy = vi.fn();
    harness.app.addHook("preParsing", async () => {
      preParsingSpy();
    });

    const controlPlane = {
      authenticateRequest: vi.fn(async () => {
        throw new ControlPlaneError("auth_required", "auth_required");
      }),
      requireScope: vi.fn()
    };

    registerHostedAuthHooks(harness.app, { controlPlane: controlPlane as never });

    const response = await harness.app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        ...fakeRunPayload("x".repeat(1024 * 1024 * 5))
      }
    });

    expect(response.statusCode).toBe(401);
    expect(runCreateSpy).not.toHaveBeenCalled();
    expect(preParsingSpy).not.toHaveBeenCalled();
  });

  it("attaches assignment ownership for connected_local_node hosted create before success", async () => {
    const assignmentIdsByRun = new Map<string, readonly { id: string }[]>();
    const ensureOwnedOrAttachFromRun = vi.fn(async () => ({ ok: true, created: true }));
    const releaseQuotaReservation = vi.fn(async () => ({
      id: "quota_reservation_1",
      accountId: "account_1",
      tenantId: "tenant_1",
      projectId: "project_1",
      quotaKind: "runs_per_hour",
      amount: 1,
      state: "consumed",
      reasonCode: "run_create",
      createdAt: "2026-05-31T00:00:00.000Z",
      expiresAt: "2026-05-31T00:05:00.000Z",
      finalizedAt: "2026-05-31T00:00:00.000Z"
    }));
    const controlPlane = {
      authenticateRequest: vi.fn(async () => hostedAuthContext()),
      requireScope: vi.fn(),
      preflightRunCreate: vi.fn(async () => ({
        id: "quota_reservation_1",
        accountId: "account_1",
        tenantId: "tenant_1",
        projectId: "project_1",
        quotaKind: "runs_per_hour",
        amount: 1,
        state: "reserved",
        reasonCode: "run_create",
        createdAt: "2026-05-31T00:00:00.000Z",
        expiresAt: "2026-05-31T00:05:00.000Z"
      })),
      ensureOwnedOrAttachFromRun,
      releaseQuotaReservation,
      recordAudit: vi.fn(async () => ({ ok: true })),
      authorizeResource: vi.fn(async () => ({ ok: false, decision: "not_found", code: "run_not_found", reasonCode: "resource_not_owned" }))
    };

    let harness: RouteHarness;
    const hostedRuns = {
      createRun: vi.fn(async (input: Parameters<RunService["createRun"]>[0]) => {
        const run = await harness.runService.createRun({ ...input, placement: "connected_local_node" });
        assignmentIdsByRun.set(run.id, [{ id: "assignment_connected_1" }]);
        return { run };
      })
    };
    harness = createRouteHarness({
      withLauncher: false,
      controlPlane: controlPlane as never,
      hostedRuns: hostedRuns as never,
      listAssignmentsByRun: async (runId) => assignmentIdsByRun.get(runId) ?? []
    });
    registerHostedAuthHooks(harness.app, { controlPlane: controlPlane as never });

    const response = await harness.app.inject({
      method: "POST",
      url: "/runs",
      headers: { authorization: "Bearer sk_sw_test_1" },
      payload: {
        ...fakeRunPayload("connected run"),
        placement: "connected_local_node"
      }
    });

    expect(response.statusCode).toBe(202);
    expect(ensureOwnedOrAttachFromRun).toHaveBeenCalledWith(expect.objectContaining({
      resourceType: "assignment",
      resourceId: "assignment_connected_1"
    }));
    expect(releaseQuotaReservation).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "consumed"
    }));
  });

  it("fails create when assignment ownership attach fails and leaves no queued unowned run visible", async () => {
    const assignmentIdsByRun = new Map<string, readonly { id: string }[]>();
    const releaseQuotaReservation = vi.fn(async () => ({
      id: "quota_reservation_1",
      accountId: "account_1",
      tenantId: "tenant_1",
      projectId: "project_1",
      quotaKind: "runs_per_hour",
      amount: 1,
      state: "failed",
      reasonCode: "ownership_attach_failed",
      createdAt: "2026-05-31T00:00:00.000Z",
      expiresAt: "2026-05-31T00:05:00.000Z",
      finalizedAt: "2026-05-31T00:00:00.000Z"
    }));
    const recordAudit = vi.fn(async () => ({ ok: true }));
    const ensureOwnedOrAttachFromRun = vi.fn(async ({ resourceType }: { resourceType: string }) => {
      if (resourceType === "assignment") {
        return { ok: false as const, code: "ownership_attach_failed" as const, reasonCode: "ownership_attach_failed" as const };
      }
      return { ok: true as const, created: true };
    });
    const controlPlane = {
      authenticateRequest: vi.fn(async () => hostedAuthContext()),
      requireScope: vi.fn(),
      preflightRunCreate: vi.fn(async () => ({
        id: "quota_reservation_1",
        accountId: "account_1",
        tenantId: "tenant_1",
        projectId: "project_1",
        quotaKind: "runs_per_hour",
        amount: 1,
        state: "reserved",
        reasonCode: "run_create",
        createdAt: "2026-05-31T00:00:00.000Z",
        expiresAt: "2026-05-31T00:05:00.000Z"
      })),
      ensureOwnedOrAttachFromRun,
      releaseQuotaReservation,
      recordAudit,
      authorizeResource: vi.fn(async () => ({ ok: false, decision: "not_found", code: "run_not_found", reasonCode: "resource_not_owned" }))
    };

    let harness: RouteHarness;
    const hostedRuns = {
      createRun: vi.fn(async (input: Parameters<RunService["createRun"]>[0]) => {
        const run = await harness.runService.createRun({ ...input, placement: "connected_local_node" });
        assignmentIdsByRun.set(run.id, [{ id: "assignment_connected_2" }]);
        return { run };
      })
    };
    harness = createRouteHarness({
      withLauncher: false,
      controlPlane: controlPlane as never,
      hostedRuns: hostedRuns as never,
      listAssignmentsByRun: async (runId) => assignmentIdsByRun.get(runId) ?? []
    });
    registerHostedAuthHooks(harness.app, { controlPlane: controlPlane as never });

    const response = await harness.app.inject({
      method: "POST",
      url: "/runs",
      headers: { authorization: "Bearer sk_sw_test_1" },
      payload: {
        ...fakeRunPayload("assignment ownership attach failure run"),
        placement: "connected_local_node"
      }
    });

    expect(response.statusCode).toBe(500);
    expect(releaseQuotaReservation).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failed",
      reasonCode: "ownership_attach_failed"
    }));
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "run.create_denied",
      decision: "error",
      reasonCode: "ownership_attach_failed",
      resourceType: "assignment",
      resourceId: "assignment_connected_2"
    }));

    const listed = await harness.runs.list({ limit: 20, status: ["queued"] });
    expect(listed.runs.find((run) => run.task === "assignment ownership attach failure run")).toBeUndefined();
  });

  it("terminalizes recoverable queued run and fails reservation on placement failure", async () => {
    const releaseQuotaReservation = vi.fn(async () => ({
      id: "quota_reservation_1",
      accountId: "account_1",
      tenantId: "tenant_1",
      projectId: "project_1",
      quotaKind: "runs_per_hour",
      amount: 1,
      state: "failed",
      reasonCode: "placement_store_failed",
      createdAt: "2026-05-31T00:00:00.000Z",
      expiresAt: "2026-05-31T00:05:00.000Z",
      finalizedAt: "2026-05-31T00:00:00.000Z"
    }));
    const controlPlane = {
      authenticateRequest: vi.fn(async () => hostedAuthContext()),
      requireScope: vi.fn(),
      preflightRunCreate: vi.fn(async () => ({
        id: "quota_reservation_1",
        accountId: "account_1",
        tenantId: "tenant_1",
        projectId: "project_1",
        quotaKind: "runs_per_hour",
        amount: 1,
        state: "reserved",
        reasonCode: "run_create",
        createdAt: "2026-05-31T00:00:00.000Z",
        expiresAt: "2026-05-31T00:05:00.000Z"
      })),
      ensureOwnedOrAttachFromRun: vi.fn(async () => ({ ok: true, created: true })),
      releaseQuotaReservation,
      recordAudit: vi.fn(async () => ({ ok: true })),
      authorizeResource: vi.fn(async ({ resourceId }: { resourceId: string }) => {
        if (resourceId.startsWith("run_")) {
          return { ok: false, decision: "not_found", code: "run_not_found", reasonCode: "resource_not_owned" };
        }
        return { ok: true };
      })
    };

    let harness: RouteHarness;
    const hostedRuns = {
      createRun: vi.fn(async (input: Parameters<RunService["createRun"]>[0]) => {
        await harness.runService.createRun(input);
        const error = new Error("placement_store_failed");
        (error as { code?: string }).code = "placement_denied";
        throw error;
      })
    };

    harness = createRouteHarness({
      withLauncher: false,
      controlPlane: controlPlane as never,
      hostedRuns: hostedRuns as never
    });
    registerHostedAuthHooks(harness.app, { controlPlane: controlPlane as never });

    const response = await harness.app.inject({
      method: "POST",
      url: "/runs",
      headers: { authorization: "Bearer sk_sw_test_1" },
      payload: {
        ...fakeRunPayload("placement failure run"),
        placement: "connected_local_node"
      }
    });

    expect(response.statusCode).toBe(409);
    expect(releaseQuotaReservation).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failed",
      reasonCode: "placement_store_failed"
    }));
    const listed = await harness.runs.list({ limit: 20, status: ["queued"] });
    expect(listed.runs.find((run) => run.task === "placement failure run")).toBeUndefined();
  });

  it("terminalizes recoverable queued run and fails reservation on queue failure", async () => {
    const releaseQuotaReservation = vi.fn(async () => ({
      id: "quota_reservation_1",
      accountId: "account_1",
      tenantId: "tenant_1",
      projectId: "project_1",
      quotaKind: "runs_per_hour",
      amount: 1,
      state: "failed",
      reasonCode: "queue_enqueue_failed",
      createdAt: "2026-05-31T00:00:00.000Z",
      expiresAt: "2026-05-31T00:05:00.000Z",
      finalizedAt: "2026-05-31T00:00:00.000Z"
    }));
    const controlPlane = {
      authenticateRequest: vi.fn(async () => hostedAuthContext()),
      requireScope: vi.fn(),
      preflightRunCreate: vi.fn(async () => ({
        id: "quota_reservation_1",
        accountId: "account_1",
        tenantId: "tenant_1",
        projectId: "project_1",
        quotaKind: "runs_per_hour",
        amount: 1,
        state: "reserved",
        reasonCode: "run_create",
        createdAt: "2026-05-31T00:00:00.000Z",
        expiresAt: "2026-05-31T00:05:00.000Z"
      })),
      ensureOwnedOrAttachFromRun: vi.fn(async () => ({ ok: true, created: true })),
      releaseQuotaReservation,
      recordAudit: vi.fn(async () => ({ ok: true })),
      authorizeResource: vi.fn(async () => ({ ok: false, decision: "not_found", code: "run_not_found", reasonCode: "resource_not_owned" }))
    };

    let harness: RouteHarness;
    const hostedRuns = {
      createRun: vi.fn(async (input: Parameters<RunService["createRun"]>[0]) => {
        await harness.runService.createRun(input);
        const error = new Error("queue_enqueue_failed");
        (error as { code?: string }).code = "queue_unavailable";
        throw error;
      })
    };

    harness = createRouteHarness({
      withLauncher: false,
      controlPlane: controlPlane as never,
      hostedRuns: hostedRuns as never
    });
    registerHostedAuthHooks(harness.app, { controlPlane: controlPlane as never });

    const response = await harness.app.inject({
      method: "POST",
      url: "/runs",
      headers: { authorization: "Bearer sk_sw_test_1" },
      payload: {
        ...fakeRunPayload("queue failure run"),
        placement: "connected_local_node"
      }
    });

    expect(response.statusCode).toBe(503);
    expect(releaseQuotaReservation).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failed",
      reasonCode: "queue_enqueue_failed"
    }));
    const listed = await harness.runs.list({ limit: 20, status: ["queued"] });
    expect(listed.runs.find((run) => run.task === "queue failure run")).toBeUndefined();
  });
});

function hostedAuthContext() {
  return {
    account: {
      id: "account_1",
      name: "Acme",
      status: "active",
      billingPlanId: "billing_plan_1",
      createdAt: "2026-05-31T00:00:00.000Z"
    },
    tenant: {
      id: "tenant_1",
      accountId: "account_1",
      slug: "acme",
      displayName: "Acme",
      status: "active",
      createdAt: "2026-05-31T00:00:00.000Z"
    },
    project: {
      id: "project_1",
      accountId: "account_1",
      tenantId: "tenant_1",
      slug: "prod",
      displayName: "Prod",
      status: "active",
      createdAt: "2026-05-31T00:00:00.000Z"
    },
    user: {
      id: "user_1",
      accountId: "account_1",
      tenantId: "tenant_1",
      displayName: "Tester",
      email: "t@example.com",
      status: "active",
      createdAt: "2026-05-31T00:00:00.000Z"
    },
    apiKey: {
      id: "api_key_1",
      accountId: "account_1",
      tenantId: "tenant_1",
      projectId: "project_1",
      userId: "user_1",
      name: "primary",
      keyPrefix: "sk_sw",
      scopes: ["runs:write", "runs:read"],
      status: "active",
      createdAt: "2026-05-31T00:00:00.000Z"
    },
    entitlement: {
      accountId: "account_1",
      tenantId: "tenant_1",
      projectId: "project_1",
      planId: "billing_plan_1",
      planSlug: "enterprise",
      planDisplayName: "Enterprise",
      entitlements: {
        allowedPlacements: ["local", "hosted", "connected_local_node"],
        allowedRuntimeModes: ["fake.deterministic"],
        allowHostedRealRuntime: false,
        allowConnectedNodes: true,
        allowArtifactContentRead: true,
        allowMetricsRead: true,
        allowAuditRead: true
      },
      quotas: {
        maxRunsPerHour: 10,
        maxActiveRuns: 5,
        maxRunTimeoutSeconds: 600,
        maxConnectedNodes: 3,
        maxArtifactContentReadBytesPerHour: 1024 * 1024
      },
      scopes: ["runs:write", "runs:read"],
      capturedAt: "2026-05-31T00:00:00.000Z"
    }
  };
}
